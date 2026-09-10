from copy import deepcopy
from fractions import Fraction
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import av
import numpy as np

from sam3d_funscript.reference import source_info
from sam3d_funscript.scene_cuts import detect_cuts
from sam3d_funscript.processing_store import ProcessingStore, PlanConflict


def write_video(path, images, times=None):
    with av.open(str(path), "w") as container:
        stream = container.add_stream("ffv1", rate=25)
        stream.width, stream.height = images[0].shape[1], images[0].shape[0]
        stream.pix_fmt = "bgr0"
        stream.time_base = Fraction(1, 1000)
        stream.codec_context.time_base = Fraction(1, 1000)
        for i, image in enumerate(images):
            frame = av.VideoFrame.from_ndarray(image, format="bgr24")
            frame.pts = times[i] if times is not None else i * 40
            frame.time_base = Fraction(1, 1000)
            for packet in stream.encode(frame):
                container.mux(packet)
        for packet in stream.encode():
            container.mux(packet)


class CutDetectionTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.a = np.full((64, 96, 3), [255, 0, 0], np.uint8)
        self.b = np.full((64, 96, 3), [0, 0, 255], np.uint8)
        self.c = np.full((64, 96, 3), [0, 255, 0], np.uint8)

    def scan(self, images, **kwargs):
        path = self.root / "source.mkv"
        write_video(path, images)
        return detect_cuts(source_info(path), self.root / "cache", **kwargs)

    def test_cuts_use_first_new_frame_and_cached_scan_skips_decoding(self):
        result = self.scan([self.a] * 20 + [self.b] * 20 + [self.c] * 20)
        self.assertEqual(result["times_ms"], [800, 1600])
        self.assertEqual(result["frames"], 60)
        with patch("sam3d_funscript.scene_cuts.small_frames", side_effect=AssertionError("decoded again")):
            cached = detect_cuts(source_info(self.root / "source.mkv"), self.root / "cache")
        self.assertTrue(cached["cache_hit"])
        self.assertEqual(cached["times_ms"], result["times_ms"])

    def test_vfr_trim_and_nonzero_origin_keep_original_timestamps(self):
        images = [self.a] * 8 + [self.b] * 7 + [self.c] * 8
        ticks = [2000]
        for i in range(len(images) - 1):
            ticks.append(ticks[-1] + [30, 70, 20][i % 3])
        path = self.root / "vfr.mkv"
        write_video(path, images, ticks)
        info = source_info(path, Fraction(1, 10), Fraction(7, 10))
        self.assertEqual(Fraction(info["source_origin"]), 2)
        result = detect_cuts(info, self.root / "cache")
        self.assertEqual(result["times_ms"], [ticks[8] - 2000, ticks[15] - 2000])
        self.assertTrue(all(100 <= t < 800 for t in result["times_ms"]))

    def test_edges_are_evaluated_without_artificial_start_or_end_cuts(self):
        result = self.scan([self.a] + [self.b] * 8 + [self.c])
        self.assertEqual(result["times_ms"], [40, 360])

    def test_gradual_fades_and_isolated_flash_do_not_create_cuts(self):
        gray = [np.full_like(self.a, v) for v in range(0, 255, 5)]
        self.assertEqual(self.scan(gray)["times_ms"], [])
        self.assertEqual(self.scan([self.a] * 10 + [np.full_like(self.a, 255)] + [self.a] * 10)["times_ms"], [])

    def test_continuous_camera_motion_is_not_a_series_of_shots(self):
        texture = np.random.default_rng(19).integers(0, 256, self.a.shape, dtype=np.uint8)
        self.assertEqual(self.scan([np.roll(texture, i * 3, axis=1) for i in range(50)])["times_ms"], [])

    def test_interrupt_leaves_no_partial_cache(self):
        path = self.root / "source.mkv"
        write_video(path, [self.a] * 10 + [self.b] * 10)
        count = 0

        def interrupt():
            nonlocal count
            count += 1
            if count == 8:
                raise InterruptedError("test cancellation")

        with self.assertRaises(InterruptedError):
            detect_cuts(source_info(path), self.root / "cache", interrupt=interrupt)
        self.assertEqual(list((self.root / "cache").glob("*.json")), [])

    def test_changed_source_or_invalid_sensitivity_is_rejected(self):
        path = self.root / "source.mkv"
        write_video(path, [self.a] * 5)
        info = source_info(path)
        with self.assertRaisesRegex(ValueError, "sensitivity"):
            detect_cuts(info, self.root, "unknown")
        write_video(path, [self.b] * 10)
        with self.assertRaisesRegex(ValueError, "source video changed"):
            detect_cuts(info, self.root)

    def test_markers_preserve_motion_results_locks_and_revisions(self):
        result = self.scan([self.a] * 10 + [self.b] * 10)
        store = ProcessingStore(self.root / "plans")
        state = store.prepare("a" * 32, source_info(self.root / "source.mkv"))
        plan = deepcopy(state["plan"])
        plan["tracking"][0]["locked"] = True
        state = store.save(state["session"], state["revision"], plan)
        state = store.finish(state["session"], state["revision"], {"regions": []}, self.root / "old" / "project.json")
        updated = store.update_cuts(state["session"], state["info"]["source_id"], result)
        for key in ("revision", "plan", "report", "project", "result_current"):
            self.assertEqual(updated[key], state[key])
        stopped = store.update_cuts(state["session"], state["info"]["source_id"], progress={"stage": "error"})
        self.assertEqual(stopped["scene_cuts"], result)
        with self.assertRaises(PlanConflict):
            store.update_cuts(state["session"], "other-source", result)


if __name__ == "__main__":
    unittest.main()
