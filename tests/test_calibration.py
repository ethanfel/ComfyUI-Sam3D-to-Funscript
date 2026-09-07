import copy
import unittest
import numpy as np

from sam3d_funscript.calibration import agreement, bounded_linear_fit, compare_project, partition, reversal_metrics, calibrate_sequence
from sam3d_funscript.core import build_project
from test_core import fixture


class CalibrationTests(unittest.TestCase):
    def test_known_scale_and_direction_recovered(self):
        x = np.linspace(-.1, .1, 500)
        for gain in (-300, 250):
            found, center = bounded_linear_fit(x, gain * x + 45)
            self.assertAlmostEqual(found, gain)
            self.assertAlmostEqual(center, 45)

    def test_constant_predictions_have_no_correlation_claim(self):
        result = agreement(np.full(100, 50), np.linspace(0, 100, 100))
        self.assertIsNone(result["correlation"])
        self.assertEqual(result["std_ratio"], 0)

    def test_reference_offset_and_overlap(self):
        p = build_project(fixture(), {"enabled_axes": ["L0"]})
        ref = {"actions": [{"at": a["at"] + 100, "pos": a["pos"]} for a in p["scripts"]["L0"]["actions"]]}
        output, report = compare_project(p, ref, offset_ms=-100)
        self.assertAlmostEqual(report["rmse"], 0)
        self.assertEqual(output["references"]["L0"]["offset_ms"], -100)
        self.assertNotIn("references", p)
        with self.assertRaises(ValueError): compare_project(p, ref, offset_ms=10000)

    def test_reversal_matching_reports_recall_and_no_double_matches(self):
        t = np.arange(0, 10000, 20.)
        y = 50 + 40 * np.sin(t / 200)
        result = reversal_metrics(t, y, y)
        self.assertEqual(result["recall"], 1)
        self.assertEqual(result["precision"], 1)
        self.assertEqual(result["median_error_ms_of_matches"], 0)
        flat = reversal_metrics(t, np.full(len(t), 50), y)
        self.assertEqual(flat["recall"], 0)
        self.assertIsNone(flat["median_error_ms_of_matches"])

    def test_test_labels_do_not_change_selected_calibration(self):
        seq = fixture()
        seq.times_ms *= 15
        seq.metadata["duration_ms"] = 30000
        project = build_project(seq, {"enabled_axes": ["L0"]})
        reference = {"actions": copy.deepcopy(project["scripts"]["L0"]["actions"]), "source": {"path": "synthetic.funscript"}}
        first = calibrate_sequence(seq, reference, smoothing_options=(0, 80))[2]
        changed = copy.deepcopy(reference)
        # Start changing strictly after the fixed test boundary. No fit/selection labels change.
        boundary = first["split"]["test_start_ms"]
        for action in changed["actions"]:
            if action["at"] > boundary + 500:
                action["pos"] = 100 - action["pos"]
        second = calibrate_sequence(seq, changed, smoothing_options=(0, 80))[2]
        self.assertEqual(first["selected"], second["selected"])
        masks, _ = partition(np.arange(0, 30000, 20))
        self.assertFalse(np.any(masks["fit"] & masks["test"]))


if __name__ == "__main__":
    unittest.main()
