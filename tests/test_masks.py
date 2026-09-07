from fractions import Fraction
from contextlib import contextmanager
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

import av
import numpy as np

from sam3d_funscript.core import build_project
from sam3d_funscript.masks import MaskVideoReader, pack_mask
from sam3d_funscript.video import extract_video
from test_native import payload, write_video


def write_masks(path, times=(0, 40, 100, 180, 240, 400), missing=(), right=False, size=(64, 64)):
    width, height = size
    with av.open(str(path), "w") as container:
        stream = container.add_stream("ffv1", rate=25)
        stream.width, stream.height, stream.pix_fmt = width, height, "gray"
        stream.time_base = stream.codec_context.time_base = Fraction(1, 1000)
        for index, pts in enumerate(times):
            gray = np.zeros((height, width), np.uint8)
            x = width // 2 if right else 0
            if index not in missing:
                gray[height // 4:height * 3 // 4, x:x + width // 4] = 255
            frame = av.VideoFrame.from_ndarray(gray, format="gray")
            frame.pts, frame.time_base = pts, Fraction(1, 1000)
            for packet in stream.encode(frame):
                container.mux(packet)
        for packet in stream.encode():
            container.mux(packet)


class MaskTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source, self.mask = self.root / "source.mp4", self.root / "mask.mkv"
        write_video(self.source)
        write_masks(self.mask, missing=(2, 3), size=(32, 32))

    def fake_native(self):
        """Record the RGB predictor boundary; any unmasked fallback fails."""
        state = {"loads": 0, "batches": []}
        class Loader:
            @classmethod
            def execute(cls, name):
                state["loads"] += 1
                return types.SimpleNamespace(result=[object()])
        class Predictor:
            pass
        def predict(model, batch, bboxes, packed_masks=None, **kwargs):
            assert packed_masks is not None
            assert all(frame.dtype == np.uint8 for frame in batch)
            masks = np.unpackbits(np.stack(packed_masks)[:, None], axis=-1, bitorder="little")
            assert masks.shape[:2] == (len(batch), 1)
            assert masks.any(axis=(-1, -2)).all(), "Empty masks must not reach native full-frame fallback"
            state["batches"].append(len(batch))
            assert len(batch) <= kwargs["batch_size"]
            data = payload(len(batch))
            for i, people in enumerate(data["frames"]):
                people[0]["pred_cam_t"][0] = np.nonzero(masks[i, 0])[1].mean()
            return data["frames"]
        Predictor.__module__ = "comfy_extras.nodes_sam3d_body"
        modules = {name: types.ModuleType(name) for name in (
            "torch", "folder_paths", "comfy", "comfy.model_management", "comfy_extras", "comfy_extras.nodes_sam3d_body")}
        modules["torch"].from_numpy = lambda array: array
        modules["folder_paths"].get_full_path_or_raise = lambda *args: __file__
        modules["comfy"].model_management = modules["comfy.model_management"]
        modules["comfy.model_management"].throw_exception_if_processing_interrupted = lambda: None
        native = modules["comfy_extras.nodes_sam3d_body"]
        native.SAM3DBody_Loader, native.SAM3DBody_Predict, native.__file__ = Loader, Predictor, __file__
        @contextmanager
        def mocked():
            with patch.dict(sys.modules, modules), patch("sam3d_funscript.video.mouth_regressor", return_value=None), patch("sam3d_funscript.video.predict_rgb", side_effect=predict):
                yield
        return mocked(), state

    def extract(self, **kwargs):
        return extract_video(self.source, "model", self.root / "cache", sample_fps=0,
            batch_size=2, mask_video_range=(self.mask, 0, 0), **kwargs)

    def test_mask_packing_threshold_and_odd_width_preserve_normalized_geometry(self):
        mask = np.array([[0, 127, 128, 255, 255]], np.uint8)
        packed, bbox = pack_mask(mask)
        np.testing.assert_array_equal(np.unpackbits(packed, axis=-1, bitorder="little"), [[0, 0, 0, 0, 1, 1, 1, 1]])
        np.testing.assert_allclose(bbox, [.4, 0, .6, 1])
        self.assertEqual(pack_mask(np.zeros((3, 5), np.uint8)), (None, None))

    def test_reader_matches_original_vfr_timestamps_and_closes(self):
        reader = MaskVideoReader(self.mask, .1, .15)
        with reader:
            self.assertEqual(reader.at(Fraction(1, 10), (64, 64)), (None, None))
            packed, bbox = reader.at(Fraction(24, 100), (64, 64))
            self.assertEqual(packed.shape, (32, 4))
            np.testing.assert_allclose(bbox, [0, .25, .25, .5])
            with self.assertRaisesRegex(ValueError, "trim does not cover"):
                reader.at(Fraction(1, 4), (64, 64))
        self.assertIsNone(reader.container)
        self.assertIsNone(reader.frame)

    def test_mismatched_timestamps_short_video_and_cropped_canvas_fail(self):
        with MaskVideoReader(self.mask) as reader:
            with self.assertRaisesRegex(ValueError, "timestamps differ"):
                reader.at(Fraction(12, 100), (64, 64))
        with MaskVideoReader(self.mask) as reader:
            with self.assertRaisesRegex(ValueError, "ended before"):
                reader.at(Fraction(1), (64, 64))
        with MaskVideoReader(self.mask) as reader:
            with self.assertRaisesRegex(ValueError, "aspect ratio"):
                reader.at(Fraction(0), (64, 128))

    def test_empty_masks_keep_missing_slots_and_cache_tracks_mask_changes(self):
        mock, state = self.fake_native()
        with mock:
            sequence = self.extract()
            self.assertEqual(state, {"loads": 1, "batches": [2, 2]})
            self.assertEqual(sequence.valid[:, 0].tolist(), [True, True, False, False, True, True])
            self.assertTrue(np.isnan(sequence.points[2:4]).all())
            self.assertEqual(sequence.metadata["missing_mask_samples"], 2)
            self.assertEqual(sequence.metadata["rois"], [])
            project = build_project(sequence, {"max_gap_ms": 500})
            actions = project["scripts"]["L0"]["actions"]
            self.assertEqual(next(a["pos"] for a in actions if a["at"] == 239), actions[0]["pos"])
            self.assertTrue(self.extract().metadata["cache_hit"])
            self.assertEqual(state["loads"], 1)
            old_stat = self.mask.stat()
            write_masks(self.mask, right=True, size=(32, 32))
            os.utime(self.mask, ns=(old_stat.st_atime_ns, old_stat.st_mtime_ns + 1000000))
            changed = self.extract()
            self.assertFalse(changed.metadata["cache_hit"])
            self.assertNotEqual(changed.metadata["cache_path"], sequence.metadata["cache_path"])
            self.assertGreater(changed.points[0, 0, 0, 0], sequence.points[0, 0, 0, 0])
            json.dumps(changed.metadata, allow_nan=False)

    def test_completely_black_video_never_loads_or_runs_the_model(self):
        write_masks(self.mask, missing=range(6))
        mock, state = self.fake_native()
        with mock:
            sequence = self.extract()
        self.assertEqual(state, {"loads": 0, "batches": []})
        self.assertFalse(sequence.valid.any())
        with self.assertRaisesRegex(ValueError, "No usable"):
            build_project(sequence)


if __name__ == "__main__":
    unittest.main()
