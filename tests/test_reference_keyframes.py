import json
from pathlib import Path
import tempfile
import unittest

import numpy as np

from sam3d_funscript.reference_keyframes import reference_keys, validate_keys, merge_tracks
from sam3d_funscript.reference import config_for_source, tracking_key, analyze
from sam3d_funscript.reference_tracker import resolve_checkpoint


class ReferenceKeyframesTests(unittest.TestCase):
    def setUp(self):
        self.base = np.array([[30, 30], [60, 30], [45, 60]], float)
        self.times = np.array([0, 20, 70, 100, 160, 200], float)
        self.shifts = np.array([[0, 0], [3, 2], [9, 5], [6, 8], [12, 5], [20, 10]])
        self.true = self.base[None]+self.shifts[:, None]
        self.keys = [{"frame": 0, "points": self.true[0].tolist()}, {"frame": 5, "points": self.true[5].tolist()}]

    def test_marked_endpoints_correct_drift_using_actual_timestamps(self):
        alpha = self.times[:, None, None]/200
        passes = np.stack([self.true+alpha*np.array([8, -6]), self.true+(1-alpha)*np.array([-5, 9])])
        points, visible, conflicts = merge_tracks(passes, np.ones((2, 6, 3), bool), self.keys, self.times, 2)
        np.testing.assert_allclose(points, self.true)
        self.assertTrue(visible.all());self.assertFalse(conflicts.any())

    def test_disagreement_is_rejected_and_hidden_points_are_not_used_as_endpoints(self):
        passes = np.stack([self.true.copy(), self.true.copy()])
        passes[0, 2] += [35, 0]
        visible = np.ones((2, 6, 3), bool)
        visible[0, 5] = False
        passes[0, 5] += 1000  # Must not contaminate the rest of this pass.
        visible[0, 3] = False
        visible[:, 4] = False
        points, good, conflicts = merge_tracks(passes, visible, self.keys, self.times, 3)
        self.assertTrue(conflicts[2].all());self.assertFalse(good[2].any())
        np.testing.assert_allclose(points[1], self.true[1])
        np.testing.assert_allclose(points[3], self.true[3]);self.assertTrue(good[3].all())
        self.assertFalse(good[4].any());self.assertTrue(good[5].all())

    def test_middle_reference_tracks_before_and_after_without_needing_visible_first_frame(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)/"tracks.npz"
            key = {"frame": 3, "points": self.true[3].tolist()}
            config = {"crop_xywh": [0, 0, 128, 128], "keyframes": [key], "points": key["points"], "sections": []}
            visible = np.ones((1, 6, 3), bool);visible[:, 0] = False
            np.savez_compressed(path, passes=self.true[None], pass_visible=visible, source_times_ms=self.times+1400,
                                metadata=json.dumps({"source_pts": [str((t+1400)/1000) for t in self.times]}))
            result = analyze(path, {}, config)
            np.testing.assert_allclose(result["shift_xy"][1:], (self.shifts-self.shifts[3])[1:])
            self.assertEqual(result["quality"], ["held", "tracked", "tracked", "manual", "tracked", "tracked"])
            self.assertEqual(result["reasons"][3], "reference_keyframe")
            self.assertEqual(result["source_times_ms"], (self.times+1400).tolist())

    def test_validation_and_legacy_migration(self):
        self.assertEqual(reference_keys({"points": self.base.tolist()})[0]["frame"], 0)
        for keys in [[self.keys[0]]*2, [{"frame": -1, "points": self.base.tolist()}],
                     [self.keys[0], {"frame": 2, "points": self.base[:2].tolist()}]]:
            with self.assertRaises(ValueError):validate_keys(keys)
        with self.assertRaisesRegex(ValueError, "outside"):validate_keys(self.keys, 5)
        validate_keys([{"frame": 2, "points": []}], complete=False)  # Unfinished editor draft.
        config, _ = config_for_source({"keyframes": list(reversed(self.keys)), "tracking_mode": "offline"}, {"source_id": "s", "width": 128, "height": 128})
        self.assertEqual(config["keyframes"], self.keys)
        changed, switch = config_for_source(config, {"source_id": "different", "width": 128, "height": 128})
        self.assertTrue(switch);self.assertEqual(changed["points"], []);self.assertNotIn("keyframes", changed)

    def test_cache_tracks_keys_and_mode_but_not_manual_sections(self):
        with tempfile.TemporaryDirectory() as temporary:
            model = Path(temporary)/"model.pth";model.write_bytes(b"test")
            config = {"points": self.base.tolist(), "keyframes": self.keys, "crop_xywh": [0, 0, 128, 128]}
            info = {"source_id": "s"}
            key = tracking_key(info, config, model)
            self.assertEqual(key, tracking_key(info, {**config, "sections": [{"keys": []}]}, model))
            self.assertNotEqual(key, tracking_key(info, {**config, "tracking_mode": "offline"}, model))
            self.assertNotEqual(key, tracking_key(info, {**config, "keyframes": [self.keys[0]]}, model))

    def test_checkpoint_mode_selects_companion_and_never_uses_wrong_weights(self):
        with tempfile.TemporaryDirectory() as temporary:
            online = Path(temporary)/"cotracker3_scaled_online.pth";online.write_bytes(b"online")
            offline = Path(temporary)/"cotracker3_scaled_offline.pth";offline.write_bytes(b"offline")
            self.assertEqual(resolve_checkpoint(online, "offline"), offline)
            self.assertEqual(resolve_checkpoint(offline, "online"), online)
            self.assertEqual(resolve_checkpoint(online, "online"), online)


if __name__ == "__main__":
    unittest.main()
