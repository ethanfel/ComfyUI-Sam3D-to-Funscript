from copy import deepcopy
from fractions import Fraction
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from sam3d_funscript.editor import EditorStore, initialize, geometry, validate
from sam3d_funscript.processing_store import ProcessingStore
from sam3d_funscript.processing_timeline import run_timeline
from sam3d_funscript.processing_split import clip_script
from test_processing_timeline import fake_extract, info, region


class DetectionSplitTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(); self.addCleanup(temp.cleanup)
        self.root = Path(temp.name); self.model = self.root/'model.bin'; self.model.write_bytes(b'model')
        self.session = 'a'*32; self.editor_session = 'b'*32
        self.store = ProcessingStore(self.root/'processing'); self.editors = EditorStore(self.root)
        self.info = info()
        self.state = self.store.prepare(self.session, self.info, {'tracking': [region(additional_anchors=['mouth'])]})
        self.extract = patch('sam3d_funscript.processing_timeline.extract_video', side_effect=fake_extract).start()
        self.addCleanup(patch.stopall)
        project, report = self.run_plan(self.state['plan'])
        project = initialize(project)
        self.editors.write(self.editor_session, {'revision': 1, 'project': project})
        self.store.bind_editor(self.session, self.editor_session, report['result_path'])
        self.state = self.store.finish(self.session, 1, report, report['result_path'])
        self.extract.reset_mock()

    def run_plan(self, plan, **kwargs):
        return run_timeline(self.info, plan, self.store.directory(self.session), str(self.model), **kwargs)

    def split(self, at=2000, parent='r0', new_id='right'):
        state = self.store.read(self.session); plan = deepcopy(state['plan'])
        old = next(r for r in plan['tracking'] if r['id'] == parent)
        left, right = {**old, 'end_ms': at}, {**old, 'id': new_id, 'name': old['name']+' · part 2', 'start_ms': at}
        plan['tracking'] = [p for r in plan['tracking'] for p in ([left, right] if r['id'] == parent else [r])]
        return self.store.save(self.session, state['revision'], plan)

    def cache(self):
        return json.loads((self.store.directory(self.session)/'results'/self.info['source_id']/'state.json').read_text())

    def test_split_keeps_both_detections_and_clips_all_anchor_sources(self):
        before = deepcopy(self.editors.read(self.editor_session)['project']['scripts'])
        saved = self.split()
        self.assertTrue(saved['result_current'])
        self.assertEqual([(r['id'], r['coverage'], r['state']) for r in saved['report']['regions']],
                         [('r0', [[0,2000]], 'complete'), ('right', [[2000,4000]], 'complete')])
        cache = self.cache()
        for key, bounds in [('r0', [0,2000]), ('right', [2000,4000])]:
            entry = cache['regions'][key]
            for path in [entry['project_path'], *entry['additional_project_paths']]:
                project = json.loads(Path(path).read_text())
                self.assertEqual(project['metadata']['processing_coverage'], [bounds])
                self.assertGreaterEqual(project['times_ms'][0], bounds[0]); self.assertLess(project['times_ms'][-1], bounds[1])
                for script in project['scripts'].values():
                    self.assertEqual((script['actions'][0]['at'], script['actions'][-1]['at']), tuple(bounds))
        editor = self.editors.read(self.editor_session)
        self.assertEqual(editor['project']['scripts'], before, 'A boundary split cannot alter Main motion')
        latest = editor['project']['timeline']['latest']
        self.assertEqual(set(latest), {'region:r0:pelvis','region:r0:mouth','region:right:pelvis','region:right:mouth'})
        self.assertEqual(len(editor['project']['timeline']['tracks']), 4)
        validate(editor['project'])
        self.extract.assert_not_called()
        self.run_plan(saved['plan'])
        self.extract.assert_not_called()

    def test_split_preserves_manual_main_locked_source_and_calibration(self):
        editor = self.editors.read(self.editor_session)
        project = editor['project']; project['scripts']['L0']['actions'] = [{'at':0,'pos':14},{'at':1900,'pos':75},{'at':4000,'pos':31}]
        project['timeline']['main']['L0'].update(edited=True, locked=True)
        track = project['timeline']['tracks'][0]; track.update(edited=True, locked=True)
        track['script']['actions'] = [{'at':0,'pos':4},{'at':1500,'pos':82},{'at':4000,'pos':24}]
        project['audio_patterns'] = {'sections': [{'name':'keep audio','start':0,'end':4000}]}
        old_main, old_track, config = deepcopy(project['scripts']), deepcopy(track), deepcopy(project['config'])
        self.editors.save(self.editor_session, project, editor['revision'])
        self.split()
        result = self.editors.read(self.editor_session)['project']
        self.assertEqual(result['scripts'], old_main); self.assertEqual(result['config'], config)
        self.assertEqual(result['audio_patterns'], project['audio_patterns'])
        children = [t for t in result['timeline']['tracks'] if t.get('locked')]
        self.assertEqual(len(children), 2)
        for child, a, b in zip(children, (0,2000), (2000,4000)):
            self.assertEqual(child['script'], clip_script(old_track['script'], a, b))
            self.assertTrue(child['edited'])

    def test_nested_splits_keep_pose_cache_and_shortened_geometry(self):
        self.split(); saved = self.split(3000, 'right', 'third')
        self.run_plan(saved['plan']); self.extract.assert_not_called()
        editor = self.editors.read(self.editor_session)['project']
        for source in editor['timeline']['sources']:
            if source['id'] not in editor['timeline']['latest'].values(): continue
            r = source['data']['metadata']['processing_region']; times = geometry(editor, source)['times_ms']
            self.assertGreaterEqual(times[0], r['start_ms']); self.assertLess(times[-1], r['end_ms'])

    def test_changed_crop_reprocesses_only_the_changed_half(self):
        saved = self.split(); plan = deepcopy(saved['plan'])
        plan['tracking'][1]['rois'] = [[0,0,.5,1]]
        plan['selected_ids'] = ['right']; plan['selection'] = [2000,2000]
        saved = self.store.save(self.session, saved['revision'], plan)
        _, report = self.run_plan(saved['plan'], operation='selected')
        self.assertEqual(self.extract.call_count, 1)
        self.assertEqual([(j['start_ms'], j['end_ms']) for j in report['jobs'] if j['state']=='complete'], [(2000,4000)])

    def test_changed_model_does_not_reuse_split_pose_cache(self):
        saved = self.split(); self.model.write_bytes(b'different model')
        self.run_plan(saved['plan'])
        self.assertEqual(self.extract.call_count, 2)

    def test_all_people_and_four_anchors_survive_as_separate_half_length_tracks(self):
        plan = deepcopy(self.state['plan'])
        plan['tracking'][0].update(rois=[[0,0,.5,1],[.5,0,.5,1]], candidate_people=[0,1],
                                   additional_anchors=['mouth','left_hand','right_hand'])
        state = self.store.save(self.session, self.state['revision'], plan)
        project, report = self.run_plan(state['plan'])
        self.editors.write(self.editor_session, {'revision':2,'project':initialize(project)})
        self.store.finish(self.session, state['revision'], report, report['result_path'])
        self.extract.reset_mock(); saved = self.split()
        project = self.editors.read(self.editor_session)['project']
        self.assertEqual(len(project['timeline']['tracks']), 16)
        self.assertEqual(len(project['timeline']['latest']), 16)
        latest = set(project['timeline']['latest'].values())
        self.assertEqual(len({s['geometry'] for s in project['timeline']['sources'] if s['id'] in latest}), 2,
                         'People and anchor choices share each half\'s geometry instead of duplicating it')
        self.run_plan(saved['plan']); self.extract.assert_not_called()

    def test_anchor_change_uses_retained_poses_without_running_inference(self):
        saved = self.split(); plan = deepcopy(saved['plan'])
        plan['tracking'][1]['anchor'] = 'nose'
        saved = self.store.save(self.session, saved['revision'], plan)
        self.run_plan(saved['plan']); self.extract.assert_not_called()

    def test_split_keeps_partial_coverage_without_marking_missing_frames_complete(self):
        (self.store.directory(self.session)/'results'/self.info['source_id']/'state.json').unlink()
        plan = deepcopy(self.state['plan']); plan['selection'] = [0,1000]
        state = self.store.save(self.session, self.state['revision'], plan)
        project, report = self.run_plan(state['plan'], operation='selected')
        self.editors.write(self.editor_session, {'revision':2,'project':initialize(project)})
        self.store.finish(self.session, state['revision'], report, report['result_path'])
        self.extract.reset_mock(); saved = self.split()
        self.assertEqual([(r['state'],r['coverage']) for r in saved['report']['regions']], [('partial',[[0,1000]]),('pending',[])])
        self.extract.assert_not_called()
        _, report = self.run_plan(saved['plan'], operation='unfinished')
        self.assertEqual([(j['start_ms'],j['end_ms']) for j in report['jobs'] if j['state']=='complete'], [(1000,2000),(2000,4000)])

    def test_tracking_split_across_unchanged_stabilization_keeps_cached_poses(self):
        checkpoint = self.root/'checkpoint.pth'; checkpoint.write_bytes(b'fixture')
        stabilized = self.root/'stabilized.mp4'; stabilized.write_bytes(b'fixture')
        times = list(range(1000,3000,40))
        manifest = {'id':'stab', 'data':{'times_ms':[t-1000 for t in times], 'source_times_ms':times,
                    'source_pts':[str(Fraction(t,1000)) for t in times], 'shift_xy':[[5,8]]*len(times)},
                    'video':{'padding_xy':[20,30], 'size_wh':[360,300]}}
        plan = deepcopy(self.state['plan'])
        plan['stabilization'] = [region('s',1000,3000,reference={'points':[[10,10],[20,10],[15,20]]})]
        state = self.store.save(self.session, self.state['revision'], plan)
        with patch('sam3d_funscript.processing_timeline.run_reference', return_value=(manifest,stabilized)):
            project, report = self.run_plan(state['plan'], checkpoint=checkpoint)
        self.editors.write(self.editor_session, {'revision':2,'project':initialize(project)})
        self.store.finish(self.session, state['revision'], report, report['result_path'])
        self.extract.reset_mock(); self.split(); saved = self.split(3200,'right','third')
        with patch('sam3d_funscript.processing_timeline.run_reference', side_effect=AssertionError('must reuse stabilization')):
            self.run_plan(saved['plan'], checkpoint=checkpoint)
        self.extract.assert_not_called()

    def test_split_with_changed_settings_does_not_claim_the_old_detection(self):
        state = self.store.read(self.session); plan = deepcopy(state['plan']); old = plan['tracking'][0]
        plan['tracking'] = [{**old,'end_ms':2000},{**old,'id':'right','start_ms':2000,'rois':[[0,0,.5,1]]}]
        cache = self.cache(); saved = self.store.save(self.session, state['revision'], plan)
        self.assertFalse(saved['result_current']); self.assertNotIn('retained_splits', saved)
        self.assertEqual(self.cache(), cache)

    def test_failure_rolls_back_cache_editor_and_plan(self):
        from sam3d_funscript.processing_split import atomic_json
        before_plan = self.store.read(self.session); before_cache = self.cache(); before_editor = self.editors.read(self.editor_session)
        failed = False
        def fail(path, value):
            nonlocal failed
            if Path(path) == self.editors.path(self.editor_session) and not failed:
                failed = True; raise OSError('disk full')
            return atomic_json(path, value)
        with patch('sam3d_funscript.processing_split.atomic_json', side_effect=fail), self.assertRaisesRegex(OSError, 'disk full'):
            self.split()
        self.assertEqual(self.store.read(self.session), before_plan)
        self.assertEqual(self.cache(), before_cache)
        self.assertEqual(self.editors.read(self.editor_session), before_editor)


if __name__ == '__main__':
    unittest.main()
