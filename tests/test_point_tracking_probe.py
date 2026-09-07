"""Pipeline invariants independent of the optional tracker model or user footage."""

import unittest
import numpy as np

from scripts.probe_point_tracking import windows, relative_feature, hold_missing, fit_scalar


class PointTrackingProbeTests(unittest.TestCase):
    def test_overlapping_windows_add_every_frame_once(self):
        for length in range(2, 110):
            covered = 0
            for start, end in windows(length, 8):
                self.assertEqual(start, max(0, covered - 8))
                self.assertGreater(end, covered)
                self.assertLessEqual(end - start, 16)
                covered = end
            self.assertEqual(covered, length)

    def test_relative_motion_rejects_invisible_reference_and_removes_camera_motion(self):
        points = np.array([[[10, 20], [8, 10]], [[50, 70], [48, 60]], [[70, 90], [68, 60]]], float)
        visible = np.array([[1, 1], [1, 1], [1, 0]], bool)
        values, good = relative_feature(points, visible,
            {"target_index": 0, "reference_index": 1, "direction_xy": [0, -1]}, 100)
        np.testing.assert_allclose(values[:2], [-.1, -.1])
        self.assertTrue(np.isnan(values[2]))
        np.testing.assert_array_equal(good, [True, True, False])

    def test_missing_intervals_hold_previous_value_without_future_information(self):
        values = np.array([np.nan, 20, np.nan, np.nan, 80])
        np.testing.assert_array_equal(hold_missing(values, np.isfinite(values)), [50, 20, 20, 20, 80])

    def test_evaluation_labels_cannot_change_mapping_or_prediction(self):
        feature = np.linspace(-.2, .2, 100)
        target = 50 + 90 * feature
        fit = np.arange(100) < 40
        first, mapping = fit_scalar(feature, target, fit)
        target[~fit] = 100 - target[~fit]
        second, changed = fit_scalar(feature, target, fit)
        self.assertEqual(mapping, changed)
        np.testing.assert_array_equal(first, second)


if __name__ == "__main__":
    unittest.main()
