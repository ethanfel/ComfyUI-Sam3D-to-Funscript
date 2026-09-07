import copy
from fractions import Fraction
from pathlib import Path
import tempfile
import unittest

import av
import numpy as np

from sam3d_funscript.core import PoseSequence, build_project
from sam3d_funscript.native import adapt_native_poses


class FileVideo:
    """The public VIDEO methods used by the adapter; no ComfyUI/GPU dependency."""
    def __init__(self, path, start=0, duration=0):
        self.path, self.start, self.duration = str(path), start, duration

    def get_stream_source(self):
        return self.path

    def get_active_trim_window(self):
        return self.start, self.duration

    def get_frame_rate(self):
        return Fraction(30)


def write_video(path):
    with av.open(str(path), "w") as container:
        stream = container.add_stream("libx264", rate=30)
        stream.width = stream.height = 64
        stream.pix_fmt = "yuv420p"
        stream.time_base = stream.codec_context.time_base = Fraction(1, 1000)
        for pts in [0, 40, 100, 180, 240, 400]:
            frame = av.VideoFrame.from_ndarray(np.full((64, 64, 3), pts % 255, np.uint8), format="rgb24")
            frame.pts, frame.time_base = pts, Fraction(1, 1000)
            for packet in stream.encode(frame):
                container.mux(packet)
        for packet in stream.encode():
            container.mux(packet)


def payload(count):
    points = np.zeros((70, 3), np.float32)
    points[9], points[10] = [-.2, 0, 0], [.2, 0, 0]
    points[5], points[6] = [-.2, -.5, 0], [.2, -.5, 0]
    person = {"pred_keypoints_3d": points, "pred_cam_t": np.array([1, 2, 3], np.float32),
              "pred_keypoints_2d": np.zeros((70, 2), np.float32)}
    return {"frames": [[copy.deepcopy(person)] for _ in range(count)], "image_size": [64, 64]}


class NativeAdapterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "vfr.mp4"
        self.cache = Path(self.temp.name) / "cache"
        write_video(self.path)

    def test_vfr_trim_preserves_original_timing_and_editor_export(self):
        sequence = adapt_native_poses(payload(3), FileVideo(self.path, .1, .15), self.cache)
        np.testing.assert_allclose(sequence.times_ms, [100, 180, 240])
        self.assertAlmostEqual(sequence.metadata["duration_ms"], 250)
        project = build_project(sequence)
        self.assertEqual(project["times_ms"], [100, 180, 240])
        self.assertEqual(project["scripts"]["L0"]["actions"][-1]["at"], 250)
        np.testing.assert_array_equal(PoseSequence.load(sequence.metadata["cache_path"]).points, sequence.points)

    def test_native_translation_missing_people_and_cache_do_not_mutate_payload(self):
        data = payload(6)
        original = data["frames"][0][0]["pred_keypoints_3d"].copy()
        data["frames"][2] = []
        sequence = adapt_native_poses(data, FileVideo(self.path), self.cache)
        np.testing.assert_allclose(sequence.times_ms, [0, 40, 100, 180, 240, 400])
        np.testing.assert_allclose(sequence.points[0, 0], original + [1, 2, 3])
        np.testing.assert_array_equal(data["frames"][0][0]["pred_keypoints_3d"], original)
        self.assertFalse(sequence.valid[2, 0])
        self.assertTrue(np.isnan(sequence.points[2, 0]).all())
        self.assertFalse(sequence.metadata["cache_hit"])
        again = adapt_native_poses(data, FileVideo(self.path), self.cache)
        self.assertTrue(again.metadata["cache_hit"])
        self.assertEqual(sequence.metadata["cache_path"], again.metadata["cache_path"])

    def test_different_video_or_subsampled_images_cannot_silently_shift_timing(self):
        with self.assertRaisesRegex(ValueError, "same VIDEO branch"):
            adapt_native_poses(payload(3), FileVideo(self.path), self.cache)
        data = payload(6)
        data["image_size"] = [32, 64]
        with self.assertRaisesRegex(ValueError, "matching, uncropped"):
            adapt_native_poses(data, FileVideo(self.path), self.cache)


if __name__ == "__main__":
    unittest.main()
