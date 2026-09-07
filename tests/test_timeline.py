import json
import tempfile
import unittest

from test_core import fixture
from sam3d_funscript.core import build_project, export_project, load_project
from sam3d_funscript.timeline import combine_projects, ProjectInputs


class TimelineTests(unittest.TestCase):
    def test_editor_session_port_keeps_numbered_project_types(self):
        inputs = ProjectInputs(editor=True)
        self.assertEqual(inputs['editor_session'][0], 'S3F_EDITOR_SESSION')
        self.assertEqual(inputs['project_72'][0], 'S3F_MOTION_PROJECT')
        self.assertNotIn('filename', inputs)
        self.assertNotIn('editor_session', ProjectInputs())

    def setUp(self):
        sequence = fixture(72)
        self.mouth = build_project(sequence, {"target_anchor": "mouth", "enabled_axes": ["L0"]})
        self.hand = build_project(fixture(72), {"target_anchor": "left_hand"})

    def test_shared_geometry_and_independent_calibration(self):
        before = json.dumps([self.mouth, self.hand])
        result = combine_projects({"project_10": self.hand, "project_0": self.mouth})
        timeline = result["timeline"]
        self.assertEqual([s["id"] for s in timeline["sources"]], ["project_0", "project_10"])
        self.assertEqual([s["geometry"] for s in timeline["sources"]], ["base", "base"])
        self.assertFalse(timeline["geometries"])
        self.assertTrue(all("points" not in s["data"] for s in timeline["sources"]))
        self.assertEqual(len(result["scripts"]), 6)
        self.assertEqual(timeline["main"]["L1"]["source"], "project_10")
        result["config"]["axis_settings"]["L0"]["range"] = 1
        result["scripts"]["L0"]["actions"][0]["pos"] = 5
        timeline["tracks"][1]["script"]["actions"][0]["pos"] = 7
        self.assertEqual(before, json.dumps([self.mouth, self.hand]))

    def test_separate_poses_and_sampling_keep_original_timing(self):
        self.hand["points"][0][0][0][0] += .1
        self.hand["times_ms"][0] = 20
        result = combine_projects({"project_0": self.mouth, "project_2": self.hand})
        self.assertEqual(result["timeline"]["sources"][1]["geometry"], "project_2")
        self.assertEqual(result["timeline"]["geometries"]["project_2"]["times_ms"][0], 20)
        self.assertEqual(result["times_ms"][0], 0)

    def test_reject_mismatched_video_or_bad_inputs(self):
        for inputs in ({}, {"wrong": self.mouth}, {"project_0": "wrong"},
                       {"project": self.mouth, "project_0": self.mouth}):
            with self.assertRaises(ValueError): combine_projects(inputs)
        self.hand["metadata"]["source"]["path"] = "another.mp4"
        with self.assertRaisesRegex(ValueError, "different source video"):
            combine_projects({"project_0": self.mouth, "project_1": self.hand})

    def test_legacy_and_saved_composition_roundtrip(self):
        self.assertIs(combine_projects({"project": self.mouth}), self.mouth)
        result = combine_projects({"project_0": self.mouth, "project_1": self.hand})
        result["scripts"]["L0"]["actions"][0]["pos"] = 37
        result["timeline"]["main"]["L0"]["assembled"] = True
        with tempfile.TemporaryDirectory() as folder:
            path = export_project(result, folder, "tracks")
            loaded = load_project(path)
            self.assertEqual(combine_projects({"project_0": loaded}), result)
            script = json.loads((path.parent / "tracks.funscript").read_text())
            self.assertEqual(script, result["scripts"]["L0"])
            html = (path.parent / "viewer.html").read_text()
            self.assertNotIn('from "./', html)
            self.assertIn("function spliceActions", html)
        with self.assertRaisesRegex(ValueError, "on its own"):
            combine_projects({"project_0": result, "project_1": self.hand})

    def test_typed_dynamic_inputs_have_no_numeric_cap(self):
        inputs = ProjectInputs()
        self.assertEqual(list(inputs), ["project_0"])
        for name in ("project", "project_0", "project_1000000"):
            self.assertIn(name, inputs)
            self.assertEqual(inputs[name][0], "S3F_MOTION_PROJECT")
        for name in ("filename", "project_", "project_-1", "project_1_extra"):
            self.assertNotIn(name, inputs)
            with self.assertRaises(KeyError): inputs[name]
