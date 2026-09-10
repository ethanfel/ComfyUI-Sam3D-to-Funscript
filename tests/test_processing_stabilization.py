"""Quick reference iterations preserve pose jobs, motion projects and selections."""
from copy import deepcopy
from fractions import Fraction
import importlib
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

from sam3d_funscript.processing_timeline import run_stabilization
from sam3d_funscript.processing_store import ProcessingStore
from sam3d_funscript.reference import atomic_json
from test_processing_timeline import info, region
from test_processing_session import load_node_module


class TrackingOnlyTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.info = info()
        self.reference = {"crop_xywh": [0, 0, 320, 240], "points": [[20, 20], [30, 20], [40, 20]],
                          "keyframes": [{"frame": 3, "points": [[20, 20], [30, 20], [40, 20]]}], "tracking_mode": "offline"}
        self.plan = {"tracking": [], "stabilization": [region("s1", 1000, 2000, reference=self.reference),
                      region("s2", 2000, 3000, reference=self.reference)], "selected_ids": ["s1"], "selection": [3500, 3600]}
        self.directory = self.root / 'results' / self.info['source_id']
        self.directory.mkdir(parents=True)
        self.state = {'version': 1, 'source_id': self.info['source_id'], 'regions': {'pose-region': {'jobs': ['unchanged'], 'project_path': 'keep.json'}},
                      'stabilization': {'other': {'region': {'id': 'other'}, 'video_path': 'keep.mp4'}}}
        atomic_json(self.directory / 'state.json', self.state)
        atomic_json(self.directory / 'report.json', {'motion': 'unchanged'})
        self.extract = patch('sam3d_funscript.processing_timeline.extract_video', side_effect=AssertionError('No SAM3D allowed')).start()
        self.model = patch('sam3d_funscript.processing_timeline._model_identity', side_effect=AssertionError('No pose model lookup allowed')).start()
        self.addCleanup(patch.stopall)

    def fake_track(self, path, start, duration, config, checkpoint, root, **kwargs):
        manifest = {'id': 'a'*24, 'state': 'ready', 'data': {'quality': ['tracked', 'manual']}}
        output = root / manifest['id'] / 'stabilized.mp4'
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(b'fixture')
        kwargs['progress'](2)
        return manifest, output

    def test_only_requested_region_tracks_with_full_bounds_and_preserves_motion_state(self):
        original = deepcopy(self.plan)
        progress = []
        with patch('sam3d_funscript.processing_timeline.run_reference', side_effect=self.fake_track) as tracker:
            report = run_stabilization(self.info, self.plan, self.root, 'tracker.pth', region_ids=['s2'], progress=progress.append)
        args = tracker.call_args.args
        self.assertEqual(args[1:3], (Fraction(2), Fraction(1)))
        self.assertEqual(args[3]['tracking_mode'], 'offline')
        self.assertEqual(args[3]['keyframes'], self.reference['keyframes'])
        self.assertEqual(self.plan, original)
        saved = json.loads((self.directory / 'state.json').read_text())
        self.assertEqual(saved['regions'], self.state['regions'])
        self.assertEqual(saved['stabilization']['other'], self.state['stabilization']['other'])
        self.assertNotIn('s1', saved['stabilization'])
        self.assertTrue(Path(saved['stabilization']['s2']['manifest_path']).is_file())
        self.assertEqual(json.loads((self.directory / 'report.json').read_text()), {'motion': 'unchanged'})
        self.assertEqual(report['completed_jobs'], 1)
        self.assertTrue(any(event['frames'] == 2 for event in progress))
        self.extract.assert_not_called(); self.model.assert_not_called()

    def test_locked_render_reused_even_when_cache_disabled_and_points_changed(self):
        with patch('sam3d_funscript.processing_timeline.run_reference', side_effect=self.fake_track) as tracker:
            run_stabilization(self.info, self.plan, self.root, 'tracker.pth')
            before = (self.directory / 'state.json').read_bytes()
            self.plan['stabilization'][0].update(locked=True, reference={})
            run_stabilization(self.info, self.plan, self.root, 'tracker.pth', use_cache=False)
            self.assertEqual(tracker.call_count, 1)
        self.assertEqual((self.directory / 'state.json').read_bytes(), before)

    def test_failed_or_cancelled_iteration_keeps_previous_render(self):
        with patch('sam3d_funscript.processing_timeline.run_reference', side_effect=self.fake_track):
            run_stabilization(self.info, self.plan, self.root, 'tracker.pth')
        before = (self.directory / 'state.json').read_bytes()
        for error in (RuntimeError('cancelled'), ValueError('tracking failed')):
            with patch('sam3d_funscript.processing_timeline.run_reference', side_effect=error):
                with self.assertRaises(type(error)):
                    run_stabilization(self.info, self.plan, self.root, 'tracker.pth')
            self.assertEqual((self.directory / 'state.json').read_bytes(), before)

    def test_invalid_target_never_falls_back_to_all_regions(self):
        with patch('sam3d_funscript.processing_timeline.run_reference') as tracker:
            for ids in ([], ['missing'], 's1'):
                with self.assertRaisesRegex(ValueError, 'Select'):
                    run_stabilization(self.info, self.plan, self.root, 'tracker.pth', region_ids=ids)
            self.plan['stabilization'][0]['enabled'] = False
            with self.assertRaisesRegex(ValueError, 'enabled'):
                run_stabilization(self.info, self.plan, self.root, 'tracker.pth')
            tracker.assert_not_called()

    def test_node_blocks_downstream_and_keeps_motion_result_on_success_and_error(self):
        node = load_node_module()
        output = self.root / 'sam3d_funscript'
        store = ProcessingStore(output / 'processing'); session = 'c'*32
        state = store.prepare(session, self.info, self.plan)
        state.update(project='authored', project_path='do-not-load.json', result_current=True, report={'authored': True},
                     progress={'stage': 'complete'}, editor_session='d'*32)
        store.write(state)
        package = node.__package__
        module = importlib.import_module(package + '.sam3d_funscript.processing_timeline')
        graph = types.ModuleType('comfy_execution.graph')
        class Blocker:
            def __init__(self, value): self.value = value
        graph.ExecutionBlocker = Blocker
        management = types.ModuleType('comfy.model_management')
        management.throw_exception_if_processing_interrupted = lambda: None
        management.InterruptProcessingException = type('Interrupted', (Exception,), {})
        server = types.ModuleType('server')
        server.PromptServer = types.SimpleNamespace(instance=types.SimpleNamespace(send_sync=lambda *args: None))
        node.folder_paths.get_output_directory = lambda: str(self.root)
        node.folder_paths.get_full_path = lambda folder, name: 'tracker.pth'
        kwargs = dict(video=object(), model_file='missing-pose-model', operation='stabilize', unique_id='1',
                      plan_json={'revision': 1, 'plan': self.plan, 'stabilization_ids': ['s2']},
                      extra_pnginfo={'workflow': {'nodes': [{'id': 1, 'properties': {'s3f_timeline_session': session}}]}})
        with patch.dict(sys.modules, {'comfy_execution.graph': graph, 'comfy.model_management': management, 'server': server}), \
             patch.object(node, 'video_input_range', return_value=('source.mp4', 0, 0)), \
             patch.object(node, 'source_info', return_value=self.info), \
             patch.object(node, 'bind_motion_editor', side_effect=AssertionError('Do not bind motion')), \
             patch.object(node, 'publish_motion', side_effect=AssertionError('Do not publish motion')), \
             patch.object(module, 'run_timeline', side_effect=AssertionError('Do not run poses')), \
             patch.object(module, 'run_stabilization', return_value={'regions': [{'id': 's2'}]}) as tracker:
            result = node.S3F_ProcessingTimeline().run(**kwargs)
            self.assertIsInstance(result['result'][0], Blocker)
            self.assertEqual(tracker.call_args.kwargs['region_ids'], ['s2'])
            after = store.read(session)
            for key in ('project', 'project_path', 'result_current', 'report', 'progress', 'editor_session', 'plan', 'revision'):
                self.assertEqual(after[key], state[key], key)
            with patch.object(module, 'run_mask_propagation', return_value={'regions': [{'id': 's2'}]}) as masks:
                mask_result = node.S3F_ProcessingTimeline().run(**{**kwargs, 'operation': 'propagate_mask'})
                self.assertIsInstance(mask_result['result'][0], Blocker)
                self.assertEqual(masks.call_args.kwargs['region_ids'], ['s2'])
                mask_after = store.read(session)
                for key in ('project', 'project_path', 'report', 'progress', 'editor_session', 'plan', 'revision'):
                    self.assertEqual(mask_after[key], state[key], key)
            tracker.side_effect = RuntimeError('cancelled')
            with self.assertRaisesRegex(RuntimeError, 'cancelled'):
                node.S3F_ProcessingTimeline().run(**kwargs)
            failed = store.read(session)
            self.assertEqual(failed['project_path'], state['project_path'])
            self.assertEqual(failed['report'], state['report'])
            self.assertEqual(failed['stabilization_progress']['stage'], 'error')


if __name__ == '__main__':
    unittest.main()
