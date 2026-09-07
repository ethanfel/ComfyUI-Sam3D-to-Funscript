import copy
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

import numpy as np
from scipy.spatial.transform import Rotation

from sam3d_funscript.core import build_project
from sam3d_funscript.direction import dominant_direction, fit_range
from test_core import fixture

ROOT = Path(__file__).resolve().parents[1]
AUTO = {"axis_settings": {"L0": {"component": "auto", "auto_fit": True}}}


class DirectionTests(unittest.TestCase):
    def test_stroke_is_invariant_to_upright_sideways_and_diagonal_scene_orientation(self):
        original = fixture()
        expected = build_project(original, AUTO)
        for angles in ([0, 0, 90], [31, 47, 68], [-54, 22, -103]):
            sequence = copy.deepcopy(original)
            matrix = Rotation.from_euler("xyz", angles, degrees=True).as_matrix()
            sequence.points = sequence.points @ matrix.T + [1, 2, 3]
            project = build_project(sequence, AUTO)
            self.assertEqual(project["scripts"]["L0"], expected["scripts"]["L0"])
            self.assertGreater(project["metrics"]["L0"]["auto_direction"][0]["share"], .999)
        self.assertGreater(max(a["pos"] for a in expected["scripts"]["L0"]["actions"]), 85)
        self.assertLess(min(a["pos"] for a in expected["scripts"]["L0"]["actions"]), 15)

    def test_slow_constant_drift_does_not_choose_the_stroke_direction(self):
        times = np.arange(0, 4001, 20)
        values = np.c_[times / 1000 * .2, .03 * np.sin(times / 1000 * 4 * np.pi), np.zeros(len(times))]
        direction, share, mode = dominant_direction(times, values, np.eye(3))
        np.testing.assert_allclose(direction, [0, 1, 0], atol=1e-10)
        self.assertGreater(share, .99)
        self.assertEqual(mode, "dominant")

    def test_reference_body_auto_cancels_a_moving_camera_transform(self):
        sequence = fixture()
        config = {**AUTO, "reference_person": 1, "frame": "reference_body"}
        expected = build_project(sequence, config)
        rotations = Rotation.from_euler("xyz", np.c_[sequence.times_ms / 5000, sequence.times_ms / 2000, sequence.times_ms / 3000]).as_matrix()
        sequence.points = np.einsum("nij,npkj->npki", rotations, sequence.points) + np.linspace([0, 0, 0], [1, 2, 3], len(rotations))[:, None, None]
        actual = build_project(sequence, config)
        self.assertEqual(actual["scripts"]["L0"], expected["scripts"]["L0"])

    def test_mixed_and_still_motion_are_reported_without_arbitrary_eigenvector_signs(self):
        times = np.arange(0, 4001, 20)
        values = np.c_[np.cos(times / 1000 * 4 * np.pi), np.sin(times / 1000 * 4 * np.pi), np.zeros(len(times))]
        direction, share, mode = dominant_direction(times, values, np.eye(3))
        self.assertEqual(mode, "body_fallback")
        self.assertLess(share, .55)
        self.assertTrue(any(np.array_equal(direction, axis) for axis in np.eye(3)))
        direction, share, mode = dominant_direction(times, np.zeros_like(values), np.eye(3))
        self.assertEqual((share, mode), (0, "still"))

    def test_automatic_fitting_respects_range_floors_and_inversion(self):
        for amplitude, rotational, floor in [(.0001, False, .04), (.01, True, 10)]:
            values = np.linspace(-amplitude, amplitude, 100)
            extent, center = fit_range(values, rotational)
            self.assertEqual(extent, floor)
            self.assertLess(np.ptp(center + values / extent * 100), 1)
        values = np.linspace(-.02, .07, 100)
        extent, center = fit_range(values)
        inverse_extent, inverse_center = fit_range(values, invert=True)
        self.assertEqual(extent, inverse_extent)
        self.assertAlmostEqual(center + inverse_center, 100, places=3)

    def test_direction_fits_do_not_cross_gaps_or_cuts(self):
        sequence = fixture()
        sequence.valid[15:20, 0] = False
        sequence.segments[30:] = 1
        expected = build_project(sequence, AUTO)
        altered = copy.deepcopy(sequence)
        matrix = Rotation.from_euler("xyz", [40, 15, 75], degrees=True).as_matrix()
        altered.points[30:] = altered.points[30:] @ matrix.T + [2, 3, 4]
        actual = build_project(altered, AUTO)
        self.assertEqual(expected["scripts"]["L0"], actual["scripts"]["L0"])
        reports = actual["metrics"]["L0"]["auto_direction"]
        self.assertEqual([(r["start"], r["end"]) for r in reports], [(0, 15), (20, 30), (30, 51)])
        actions = actual["scripts"]["L0"]["actions"]
        self.assertEqual(next(a["pos"] for a in actions if a["at"] == 799), [a["pos"] for a in actions if a["at"] < 600][-1])

    def test_rotation_auto_keeps_degree_units_and_other_axis_settings(self):
        sequence = fixture()
        centers = sequence.points[:, 0, [9, 10]].mean(axis=1)
        turns = Rotation.from_rotvec(np.sin(sequence.times_ms / 170)[:, None] * np.array([.2, .3, -.1])).as_matrix()
        sequence.points[:, 0] = np.einsum("nij,nkj->nki", turns, sequence.points[:, 0] - centers[:, None]) + centers[:, None]
        default = build_project(sequence)
        config = {"axis_settings": {"R0": {"component": "auto", "auto_fit": True}}}
        project = build_project(sequence, config)
        self.assertEqual(project["metrics"]["R0"]["units"], "deg")
        self.assertGreater(project["metrics"]["R0"]["auto_direction"][0]["share"], .999)
        for axis in ("L0", "L1", "L2", "R1", "R2"):
            self.assertEqual(project["scripts"][axis], default["scripts"][axis])

    def test_browser_and_python_auto_exports_match_for_vfr_gaps_and_rotations(self):
        sequence = fixture()
        sequence.times_ms += np.sin(np.arange(len(sequence.times_ms))) * 5
        turns = Rotation.from_rotvec(np.sin(sequence.times_ms / 240)[:, None] * np.array([.15, -.1, .08])).as_matrix()
        sequence.points = np.einsum("nij,npkj->npki", turns, sequence.points)
        sequence.valid[14:18, 0] = False
        sequence.segments[35:] = 1
        config = {"axis_settings": {axis: {"component": "auto", "auto_fit": True} for axis in ("L0", "R0")}}
        project = build_project(sequence, config)
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "project.json"
            path.write_text(json.dumps(project, allow_nan=False))
            subprocess.run(["node", "tests/test_auto.mjs", str(path)], cwd=ROOT, check=True, capture_output=True, text=True)


if __name__ == "__main__":
    unittest.main()
