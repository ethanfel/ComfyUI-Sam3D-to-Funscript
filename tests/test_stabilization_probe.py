"""Reference identity, robust translation, and bounded frame-window invariants."""

import unittest
import contextlib
import io
import json
from fractions import Fraction
from pathlib import Path
import tempfile
import numpy as np

from scripts.probe_stabilization import frames, render, stream_windows, translations


class StabilizationTests(unittest.TestCase):
    def test_translation_rejects_outlier_and_visibility_does_not_shift_centroid(self):
        baseline = np.array([[0, 0], [100, 0], [0, 100], [100, 100], [50, 50]], float)
        expected = np.array([[0, 0], [10, 20], [20, 30]], float)
        points = baseline[None] + expected[:, None]
        points[1, 4] += 1000
        visible = np.ones((3, 5), bool)
        visible[2, [0, 4]] = False
        shift, good, _, _, _ = translations(points, visible, list(range(5)))
        np.testing.assert_allclose(shift, expected)
        self.assertTrue(good.all())

    def test_missing_consensus_holds_and_reacquisition_is_flagged(self):
        points = np.zeros((4, 4, 2))
        points[1] += [3, 4]
        points[2] += [9, 9]
        points[3] += [100, 100]
        visible = np.ones((4, 4), bool)
        visible[2] = False
        shift, good, _, _, reasons = translations(points, visible, list(range(4)))
        np.testing.assert_allclose(shift, [[0, 0], [3, 4], [3, 4], [3, 4]])
        np.testing.assert_array_equal(good, [True, True, False, False])
        self.assertEqual(reasons[-1], "large_jump_needs_review")

    def test_points_invisible_at_start_never_become_a_new_reference(self):
        points = np.zeros((2, 4, 2))
        visible = np.ones((2, 4), bool)
        visible[0, :2] = False
        _, good, _, _, _ = translations(points, visible, list(range(4)))
        self.assertFalse(good.any())

    def test_reacquisition_allows_displacement_accumulated_over_missing_frames(self):
        points = np.zeros((3, 4, 2))
        points[1] += [30, 0]
        points[2] += [60, 0]
        visible = np.ones((3, 4), bool)
        visible[1] = False
        shift, good, _, _, _ = translations(points, visible, list(range(4)))
        np.testing.assert_allclose(shift, [[0, 0], [0, 0], [60, 0]])
        np.testing.assert_array_equal(good, [True, False, True])

    def test_windows_cover_all_frames_and_only_decode_one_window_ahead(self):
        for length in range(2, 100):
            consumed = []
            def source():
                for i in range(length):
                    consumed.append(i)
                    yield i
            recovered = []
            for window, added in stream_windows(source(), 8):
                self.assertLessEqual(len(window), 16)
                recovered.extend(window[-added:])
                self.assertEqual(len(consumed), len(recovered))
            self.assertEqual(recovered, list(range(length)))

    def test_render_preserves_irregular_pts_and_pins_known_translation(self):
        import av
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pts = [0, 40, 110, 150]
            shifts = np.array([[0, 0], [4, 6], [-4, 2], [8, -4]])
            source = root / "source.mkv"
            with av.open(str(source), "w") as container:
                stream = container.add_stream("ffv1", rate=25)
                stream.width = stream.height = 64
                stream.pix_fmt = "bgr0"
                stream.time_base = stream.codec_context.time_base = Fraction(1, 1000)
                for timestamp, (x, y) in zip(pts, shifts):
                    pixels = np.zeros((64, 64, 3), np.uint8)
                    pixels[24+y:36+y, 24+x:36+x, 2] = 255
                    frame = av.VideoFrame.from_ndarray(pixels, format="bgr24")
                    frame.pts = timestamp; frame.time_base = Fraction(1, 1000)
                    for packet in stream.encode(frame):
                        container.mux(packet)
                for packet in stream.encode():
                    container.mux(packet)
            report = {"metadata": {"recipe": {"video": str(source)}, "source_time_base": "1/1000",
                       "rate": "25", "timestamps": [str(Fraction(p, 1000)) for p in pts]},
                      "padding_xy": [16, 16], "output_size_wh": [96, 96]}
            (root / "report.json").write_text(json.dumps(report))
            np.savez(root / "stabilization.npz", shift_xy=shifts)
            with contextlib.redirect_stdout(io.StringIO()):
                render(root)
            for (pixels, timestamp), expected in zip(frames(root / "stabilized.mp4"), pts):
                self.assertEqual(timestamp, Fraction(expected, 1000))
                yy, xx = np.where(pixels[..., 2] > 180)
                self.assertAlmostEqual(float(xx.mean()), 45.5, delta=.6)
                self.assertAlmostEqual(float(yy.mean()), 45.5, delta=.6)
                self.assertLess(pixels[:8, :8].max(), 8)


if __name__ == "__main__":
    unittest.main()
