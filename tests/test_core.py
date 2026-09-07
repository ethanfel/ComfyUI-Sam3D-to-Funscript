import copy
import json
from pathlib import Path
import tempfile
import unittest

import numpy as np
from scipy.spatial.transform import Rotation

from sam3d_funscript.core import (PoseSequence, build_project, body_basis, export_project,
                                  load_project, simplify, validate_actions)
from sam3d_funscript.video import parse_rois, video_frames


def fixture():
    times = np.arange(0, 2001, 40, dtype=float)
    p = np.zeros((len(times), 2, 70, 3), dtype=float)
    for slot in range(2):
        p[:, slot, :, 2] = 3
        p[:, slot, 9] += [-.2, 0, 0]
        p[:, slot, 10] += [.2, 0, 0]
        p[:, slot, 5] += [-.2, -.5, 0]
        p[:, slot, 6] += [.2, -.5, 0]
    p[:, 0, :, 1] += (.06 * np.sin(times / 170))[:, None]
    pixels = np.zeros(p.shape[:-1] + (2,))
    return PoseSequence(times, p, pixels, np.ones((len(times), 2), bool), np.zeros(len(times), int),
                        {"duration_ms": 2040, "source": {"path": "fixture.mp4"}, "image_size": [200, 300]})


class CoreTests(unittest.TestCase):
    def test_camera_rigid_transform_cancels_in_reference_frame(self):
        sequence = fixture()
        config = {"reference_person": 1, "frame": "reference_body"}
        before = build_project(sequence, config)
        rotations = Rotation.from_euler("xyz", np.c_[np.linspace(0, .2, len(sequence.times_ms)), np.linspace(0, 1, len(sequence.times_ms)), np.zeros(len(sequence.times_ms))]).as_matrix()
        sequence.points = np.einsum("nij,npkj->npki", rotations, sequence.points) + np.linspace([0, 0, 0], [1, 2, 3], len(rotations))[:, None, None, :]
        after = build_project(sequence, config)
        np.testing.assert_allclose(before["processed"], after["processed"], atol=1e-11)
        self.assertEqual(before["scripts"], after["scripts"])

    def test_basis_is_right_handed(self):
        basis, valid = body_basis(fixture().points[:, 0])
        self.assertTrue(valid.all())
        np.testing.assert_allclose(np.linalg.det(basis), 1)

    def test_gap_holds_and_cut_resets_filter(self):
        sequence = fixture()
        sequence.valid[15:20, 0] = False
        sequence.segments[30:] = 1
        project = build_project(sequence)
        actions = project["scripts"]["L0"]["actions"]
        last_before = [a for a in actions if a["at"] < 600][-1]
        held = next(a for a in actions if a["at"] == 799)
        self.assertEqual(last_before["pos"], held["pos"])
        altered = copy.deepcopy(sequence)
        altered.points[30:, 0, :, 1] += 3
        other = build_project(altered)
        np.testing.assert_allclose(np.array(project["processed"][:15], float), np.array(other["processed"][:15], float))

    def test_export_and_cache_roundtrip(self):
        sequence = fixture()
        with tempfile.TemporaryDirectory() as folder:
            cache = Path(folder) / "poses.npz"
            sequence.save(cache)
            recovered = PoseSequence.load(cache)
            np.testing.assert_array_equal(sequence.points, recovered.points)
            project = build_project(recovered)
            path = export_project(project, folder, "example")
            self.assertEqual(load_project(path), project)
            self.assertEqual(sorted(p.name for p in path.parent.glob("*.funscript")),
                             ["example.funscript", "example.pitch.funscript", "example.roll.funscript", "example.surge.funscript", "example.sway.funscript", "example.twist.funscript"])
            self.assertNotEqual(path, export_project(project, folder, "example"))

    def test_simplification_obeys_error_budget(self):
        t = np.arange(0, 2000, 17)
        p = np.rint(50 + 40 * np.sin(t / 100))
        indices = simplify(t, p, .75)
        self.assertLessEqual(np.max(np.abs(np.interp(t, t[indices], p[indices]) - p)), .75)

    def test_bad_actions_and_config_rejected(self):
        for actions in ([{"at": -1, "pos": 10}], [{"at": 0, "pos": 101}], [{"at": 0, "pos": 10}, {"at": 0, "pos": 30}], [{"at": True, "pos": 10}]):
            with self.assertRaises(ValueError): validate_actions(actions)
        for config in ({"axis_settings": {"L0": {"range": 0}}}, {"target_person": -1}, {"frame": "reference_body"}, {"surprise": 2}):
            with self.assertRaises(ValueError): build_project(fixture(), config)
        with self.assertRaises(ValueError): parse_rois("[[0.8,0,0.8,1]]")

    def test_axis_mapping_and_no_tiny_motion_amplification(self):
        sequence = fixture()
        sequence.points[:, 0, :, 1] *= .001
        project = build_project(sequence, {"enabled_axes": ["L0"]})
        positions = [a["pos"] for a in project["scripts"]["L0"]["actions"]]
        self.assertLessEqual(max(positions) - min(positions), 1)
        self.assertEqual(set(project["scripts"]), {"L0"})

    def test_vfr_uses_pts_not_average_fps(self):
        import av
        from fractions import Fraction
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "vfr.mp4"
            with av.open(str(path), "w") as container:
                stream = container.add_stream("libx264", rate=30)
                stream.width = 64; stream.height = 64; stream.pix_fmt = "yuv420p"
                stream.time_base = Fraction(1, 1000)
                stream.codec_context.time_base = Fraction(1, 1000)
                for pts in [0, 40, 100, 180, 240, 400]:
                    frame = av.VideoFrame.from_ndarray(np.full((64, 64, 3), pts % 255, np.uint8), format="rgb24")
                    frame.pts = pts; frame.time_base = Fraction(1, 1000)
                    for packet in stream.encode(frame): container.mux(packet)
                for packet in stream.encode(): container.mux(packet)
            full = [meta["time_ms"] for _, meta in video_frames(path, sample_fps=0)]
            np.testing.assert_allclose(full, [0, 40, 100, 180, 240, 400])
            selected = [meta["time_ms"] for _, meta in video_frames(path, sample_fps=10, start_seconds=.1)]
            np.testing.assert_allclose(selected, [100, 240, 400])


if __name__ == "__main__":
    unittest.main()
