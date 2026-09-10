"""The direct Motion Studio link shares exactly one unambiguous export owner."""
from copy import deepcopy
import importlib.util
from pathlib import Path
import sys
import tempfile
import types
import unittest


def load_node_module():
    root = Path(__file__).resolve().parents[1]
    package = types.ModuleType("s3f_processing_node_test")
    package.__path__ = [str(root)]
    spec = importlib.util.spec_from_file_location("s3f_processing_node_test.processing_nodes", root / "processing_nodes.py")
    module = importlib.util.module_from_spec(spec)
    previous = sys.modules.get("folder_paths")
    sys.modules["folder_paths"] = types.ModuleType("folder_paths")
    sys.modules[package.__name__] = package
    try:
        spec.loader.exec_module(module)
    finally:
        if previous is None:
            sys.modules.pop("folder_paths", None)
        else:
            sys.modules["folder_paths"] = previous
    return module


class ProcessingSessionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.node = load_node_module()

    def workflow(self):
        return {"nodes": [{"id": 2, "type": "S3F_ProcessingTimeline"},
            {"id": 3, "type": "S3F_StandaloneExport", "mode": 0,
             "inputs": [{"name": "editor_session", "link": None}, {"name": "project_0", "link": 1},
                        {"name": "project_1", "link": None}], "properties": {"s3f_session": "a" * 32}}],
            "links": [[1, 2, 0, 3, 1, "S3F_MOTION_PROJECT"]]}

    def test_single_direct_standalone_shares_its_session(self):
        self.assertEqual(self.node.motion_editor_session(self.workflow(), "2", "b" * 32), "a" * 32)

    def test_missing_ambiguous_or_ignored_connections_use_independent_stable_session(self):
        expected = self.node.motion_editor_session({}, "2", "b" * 32)
        self.assertEqual(expected, self.node.motion_editor_session({}, "2", "b" * 32))
        self.assertNotEqual(expected, self.node.motion_editor_session({}, "2", "c" * 32))
        linked = self.workflow(); linked["nodes"][1]["inputs"][0]["link"] = 9
        self.assertEqual(self.node.motion_editor_session(linked, "2", "b" * 32), expected)
        combined = self.workflow(); combined["nodes"][1]["inputs"][2]["link"] = 8
        self.assertEqual(self.node.motion_editor_session(combined, "2", "b" * 32), expected)
        forked = self.workflow(); second = deepcopy(forked["nodes"][1]); second["id"] = 4
        second["inputs"][1]["link"] = 2; second["properties"]["s3f_session"] = "d" * 32
        forked["nodes"].append(second); forked["links"].append([2, 2, 0, 4, 1, "S3F_MOTION_PROJECT"])
        self.assertEqual(self.node.motion_editor_session(forked, "2", "b" * 32), expected)

    def test_publish_keeps_saved_locked_edits_and_other_sessions_independent(self):
        from test_core import fixture
        from sam3d_funscript.core import build_project
        from sam3d_funscript.editor import initialize
        initial = initialize(build_project(fixture()))
        for main in initial['timeline']['main'].values():
            main['assembled'] = True
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); session = 'a' * 32
            self.node.publish_motion(deepcopy(initial), session, root)
            store = self.node.EditorStore(root); state = store.read(session)
            edited = state['project']; edited['timeline']['main']['L0']['locked'] = True
            edited['scripts']['L0']['actions'] = [{'at': 0, 'pos': 17}, {'at': 2000, 'pos': 73}]
            store.save(session, edited, state['revision'])
            incoming = deepcopy(initial)
            for script in incoming['scripts'].values():
                script['actions'] = [{'at': 0, 'pos': 9}, {'at': 2000, 'pos': 91}]
            path = self.node.publish_motion(deepcopy(incoming), session, root)
            result = self.node.load_project(path)
            self.assertEqual(result['scripts']['L0'], edited['scripts']['L0'])
            self.assertEqual(result['scripts']['L1'], incoming['scripts']['L1'])
            separate = self.node.publish_motion(deepcopy(incoming), 'b' * 32, root)
            self.assertEqual(self.node.load_project(separate)['scripts'], incoming['scripts'])

    def test_published_guides_and_collapsed_tracks_survive_reruns_without_changing_locked_curves(self):
        from test_core import fixture
        from sam3d_funscript.core import build_project
        from sam3d_funscript.editor import initialize
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); session = 'a' * 32
            incoming = initialize(build_project(fixture()))
            timeline = {'session': 'c' * 32, 'info': {'source_id': 'source'},
                        'scene_cuts': {'source_id': 'source', 'times_ms': [500.125, 1500]}}
            self.node.publish_motion(deepcopy(incoming), session, root, timeline)
            store = self.node.EditorStore(root); saved = store.read(session)
            saved['project']['timeline']['tracks'][0].update(collapsed=True, locked=True)
            saved['project']['preview'] = {'main_collapsed': True, 'show_cuts': False}
            store.save(session, saved['project'], saved['revision'])
            timeline['scene_cuts']['times_ms'] = [750.25]
            path = self.node.publish_motion(deepcopy(incoming), session, root, timeline)
            output = self.node.load_project(path)
            self.assertEqual(output['metadata']['scene_cuts']['times_ms'], [750.25])
            self.assertEqual(output['metadata']['processing_timeline']['session'], 'c' * 32)
            self.assertTrue(output['timeline']['tracks'][0]['collapsed'])
            self.assertEqual(output['preview'], saved['project']['preview'])
            self.assertEqual(output['scripts'], saved['project']['scripts'])
            self.assertEqual(output['timeline']['tracks'][0]['script'], saved['project']['timeline']['tracks'][0]['script'])
            timeline['scene_cuts']['source_id'] = 'different-trim'
            path = self.node.publish_motion(deepcopy(incoming), session, root, timeline)
            self.assertNotIn('scene_cuts', self.node.load_project(path)['metadata'])

    def test_connecting_standalone_adopts_newer_saved_editor_edits(self):
        from test_core import fixture
        from sam3d_funscript.core import build_project
        from sam3d_funscript.editor import initialize
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); old_session = 'a' * 32; new_session = 'b' * 32
            initial = initialize(build_project(fixture()))
            export = self.node.publish_motion(initial, old_session, root)
            editors = self.node.EditorStore(root); draft = editors.read(old_session)
            draft['project']['timeline']['main']['L0']['edited'] = True
            draft['project']['scripts']['L0']['actions'] = [{'at': 0, 'pos': 12}, {'at': 2000, 'pos': 68}]
            editors.save(old_session, draft['project'], draft['revision'])
            plans = self.node.ProcessingStore(root/'processing'); timeline_session = 'c' * 32
            plans.prepare(timeline_session, {'source_id': 'source', 'start': '0', 'end_ms': 2000})
            state = plans.bind_editor(timeline_session, old_session, export)
            state = self.node.bind_motion_editor(plans, state, new_session, root)
            self.assertEqual(state['editor_session'], new_session)
            self.assertEqual(editors.read(new_session)['project']['scripts']['L0'], draft['project']['scripts']['L0'])
            self.assertEqual(self.node.load_project(state['project_path'])['scripts']['L0'], draft['project']['scripts']['L0'])


if __name__ == "__main__":
    unittest.main()
