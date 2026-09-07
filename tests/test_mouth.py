import copy
from pathlib import Path
import tempfile
import unittest

import numpy as np

from sam3d_funscript.core import PoseSequence, build_project
from sam3d_funscript.mouth import mouth_corners
from sam3d_funscript.native import adapt_native_poses
from test_core import fixture
from test_native import FileVideo, payload, write_video


class MouthTests(unittest.TestCase):
    def test_native_face_mapping_precedes_fallback_and_projects_in_camera_basis(self):
        face = np.full((238, 3), 99, np.float32)
        face[118], face[119] = [-.1, -.2, 0], [.1, -.2, 0]
        person = {"pred_face_keypoints_3d": face, "pred_cam_t": [1, 2, 4], "focal_length": 200}
        points, pixels = mouth_corners(person, (400, 600), np.zeros((2, 1)))
        np.testing.assert_allclose(points, [[.9, 1.8, 4], [1.1, 1.8, 4]])
        np.testing.assert_allclose(pixels, [[345, 290], [355, 290]])
        np.testing.assert_array_equal(face[0], [99, 99, 99])

    def test_mesh_and_joint_weights_preserve_native_basis_and_do_not_mutate_inputs(self):
        person = {"pred_vertices": np.array([[-.2, -.4, 0], [.2, -.4, 0]], np.float32),
                  "pred_joint_coords": np.array([[0, 0, 0]], np.float32),
                  "pred_cam_t": [0, 0, 2], "focal_length": 100}
        original = copy.deepcopy(person)
        mapping = np.array([[.5, 0, .5], [0, .5, .5]], np.float32)
        points, pixels = mouth_corners(person, (200, 200), mapping)
        np.testing.assert_allclose(points, [[-.1, -.2, 2], [.1, -.2, 2]])
        np.testing.assert_allclose(pixels, [[95, 90], [105, 90]])
        np.testing.assert_array_equal(person["pred_vertices"], original["pred_vertices"])
        with self.assertRaisesRegex(ValueError, "same SAM3D model"):
            mouth_corners(person, (200, 200), np.zeros((2, 4)))

    def test_missing_mouth_does_not_invalidate_body_and_never_falls_back_to_nose(self):
        sequence = fixture(72)
        sequence.points[10, 0, 70:] = np.nan
        sequence.pixels[10, 0, 70:] = np.nan
        body = build_project(sequence)
        mouth = build_project(sequence, {"target_anchor": "mouth"})
        self.assertTrue(body["valid"][10])
        self.assertFalse(mouth["valid"][10])
        self.assertEqual(mouth["anchor_indices"]["target"], [70, 71])
        self.assertTrue(any("neutral facial expression" in warning for warning in mouth["warnings"]))
        with self.assertRaisesRegex(ValueError, "Re-run SAM3D extraction"):
            build_project(fixture(), {"target_anchor": "mouth"})
        sequence.points[:, 0, 70:] = np.nan
        with self.assertRaisesRegex(ValueError, "connect the same SAM3D model"):
            build_project(sequence, {"target_anchor": "mouth"})

    def test_native_adapter_caches_face_points_and_face_changes_invalidate_cache(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "source.mp4"
            write_video(path)
            data = payload(6)
            for frame in data["frames"]:
                person = frame[0]
                person["focal_length"] = 64
                face = np.zeros((238, 3), np.float32)
                face[118], face[119] = [-.03, -.6, 0], [.03, -.6, 0]
                person["pred_face_keypoints_3d"] = face
            sequence = adapt_native_poses(data, FileVideo(path), folder)
            np.testing.assert_allclose(sequence.points[0, 0, 70:], [[.97, 1.4, 3], [1.03, 1.4, 3]])
            restored = PoseSequence.load(sequence.metadata["cache_path"])
            np.testing.assert_array_equal(restored.points, sequence.points)
            project = build_project(restored, {"target_anchor": "mouth"})
            self.assertEqual(project["anchor_indices"]["target"], [70, 71])
            data["frames"][0][0]["pred_face_keypoints_3d"][118, 0] += .1
            changed = adapt_native_poses(data, FileVideo(path), folder)
            self.assertNotEqual(changed.metadata["cache_path"], sequence.metadata["cache_path"])

    def test_missing_or_unprojectable_native_data_is_missing(self):
        for person in ({}, {"pred_face_keypoints_3d": np.zeros((238, 3)), "pred_cam_t": [0, 0, -1], "focal_length": 100}):
            points, pixels = mouth_corners(person, (100, 100))
            self.assertTrue(np.isnan(points).all())
            self.assertTrue(np.isnan(pixels).all())


if __name__ == "__main__":
    unittest.main()
