import copy
import json
from pathlib import Path
import tempfile
import unittest

from test_core import fixture
from sam3d_funscript.core import build_project, default_config, export_project
from sam3d_funscript.timeline import combine_projects
from sam3d_funscript.editor import initialize, merge_projects, EditorStore, Conflict


class EditorTests(unittest.TestCase):
    def setUp(self):
        sequence = fixture(72)
        self.mouth = build_project(sequence, {'target_anchor': 'mouth'})
        self.hand = build_project(sequence, {'target_anchor': 'right_hand'})
        self.initial = initialize(copy.deepcopy(self.mouth))

    def test_linked_view_reads_the_latest_export_without_creating_another_revision(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = EditorStore(root)
            session = 'a' * 32
            with self.assertRaisesRegex(ValueError, 'upstream'):
                store.export_path(session)
            path, _ = store.export(session, self.mouth, lambda data: export_project(data, root))
            before = store.read(session)
            self.assertEqual(store.export_path(session), path)
            self.assertEqual(store.read(session), before)
            newer, _ = store.export(session, self.mouth, lambda data: export_project(data, root))
            self.assertNotEqual(newer, path)
            self.assertEqual(store.export_path(session), newer)

    def test_auto_default_and_explicit_manual_calibration(self):
        self.assertEqual(default_config()['axis_settings']['L0']['component'], 'auto')
        self.assertTrue(self.mouth['config']['axis_settings']['L0']['auto_fit'])
        for i, axis in enumerate(('L1', 'L2', 'R0', 'R1', 'R2'), 1):
            self.assertEqual(self.mouth['config']['axis_settings'][axis], default_config()['axis_settings'][axis])
            self.assertEqual(default_config()['axis_settings'][axis]['component'], i % 3)
        for override in ({'range': .3}, {'component': 1}, {'center': 60}):
            config = build_project(fixture(), {'axis_settings': {'L0': override}})['config']['axis_settings']['L0']
            self.assertFalse(config['auto_fit'])
            for key, value in override.items(): self.assertEqual(config[key], value)

    def test_locked_main_and_source_survive_changed_geometry_and_new_input(self):
        previous = self.initial
        track = previous['timeline']['tracks'][0]
        track.update(locked=True, window=[200, 1800])
        track['script']['actions'] = [{'at': 220, 'pos': 17}, {'at': 1780, 'pos': 89}]
        track['settings'].update(invert=True, center=37, range=.053)
        previous['timeline']['main']['L0'].update(locked=True, assembled=True, regions=[
            dict(source='project_0', axis='L0', start=200, end=1800, window=[200, 1800], settings=copy.deepcopy(track['settings']))])
        previous['scripts']['L0']['actions'] = [{'at': 0, 'pos': 28}, {'at': 2000, 'pos': 66}]
        before = json.dumps(previous)
        changed = copy.deepcopy(self.mouth)
        changed['points'][0][0][0][0] += 42
        changed['scripts']['L0']['actions'][0]['pos'] = 1
        incoming = combine_projects({'project_0': changed, 'project_1': self.hand})
        merged = merge_projects(previous, incoming)
        self.assertEqual(json.dumps(previous), before, 'Do not mutate the saved draft while preparing a rerun')
        self.assertEqual(merged['timeline']['tracks'][0], track)
        self.assertEqual(merged['timeline']['main']['L0'], previous['timeline']['main']['L0'])
        self.assertEqual(merged['scripts']['L0'], previous['scripts']['L0'])
        self.assertEqual(merged['config']['axis_settings']['L0'], previous['config']['axis_settings']['L0'])
        self.assertEqual(merged['points'], previous['points'])
        self.assertEqual(len(merged['timeline']['tracks']), 2)
        self.assertEqual(merged['timeline']['tracks'][1]['source'], 'project_1')
        self.assertEqual(len(merged['timeline']['sources']), 3)
        self.assertEqual(merge_projects(merged, incoming), merged, 'Identical reruns must not add tracks or source revisions')
        disconnected = merge_projects(merged, self.hand)
        self.assertEqual(disconnected['timeline']['tracks'][0], track)
        self.assertEqual(disconnected['scripts']['L0'], previous['scripts']['L0'])

    def test_changed_inputs_refresh_unlocked_edited_lanes_but_do_not_recreate_deleted_rows(self):
        incoming = copy.deepcopy(self.mouth)
        incoming['scripts']['L0']['actions'][0]['pos'] = 3
        merged = merge_projects(self.initial, incoming)
        self.assertEqual(merged['scripts']['L0'], incoming['scripts']['L0'])
        self.assertEqual(merged['timeline']['tracks'][0]['script'], incoming['scripts']['L0'])
        self.initial['timeline']['tracks'][0]['edited'] = True
        self.initial['timeline']['main']['L0']['edited'] = True
        merged = merge_projects(self.initial, incoming)
        self.assertEqual(merged['timeline']['tracks'][0]['script'], incoming['scripts']['L0'])
        self.assertEqual(merged['scripts']['L0'], incoming['scripts']['L0'])
        self.assertFalse(merged['timeline']['tracks'][0].get('edited'))
        self.assertEqual(len(merged['timeline']['sources']), 1)
        self.initial['timeline']['tracks'] = []
        self.assertEqual(merge_projects(self.initial, incoming)['timeline']['tracks'], [])

    def test_processing_generated_main_refreshes_but_user_edits_and_locks_survive(self):
        previous = copy.deepcopy(self.initial)
        for main in previous['timeline']['main'].values():
            main.update(assembled=True, processing_generated=True)
        incoming = copy.deepcopy(previous)
        for axis in incoming['scripts']:
            incoming['scripts'][axis]['actions'] = [{'at': 0, 'pos': 12}, {'at': 2000, 'pos': 84}]
        # Join settings can change the generated main while all source poses and
        # calibrated source scripts remain identical.
        refreshed = merge_projects(previous, incoming)
        self.assertEqual(refreshed['scripts'], incoming['scripts'])
        for protection in ('edited', 'locked'):
            protected = copy.deepcopy(previous)
            protected['timeline']['main']['L0'][protection] = True
            protected['scripts']['L0']['actions'] = [{'at': 0, 'pos': 19}, {'at': 2000, 'pos': 67}]
            merged = merge_projects(protected, incoming)
            self.assertEqual(merged['scripts']['L0'], protected['scripts']['L0'])
            self.assertEqual(merged['scripts']['L1'], incoming['scripts']['L1'])

    def test_shortened_processing_trim_shrinks_only_unprotected_generated_extent(self):
        previous = copy.deepcopy(self.initial)
        previous['metadata']['processing_timeline'] = {'version': 1}
        for main in previous['timeline']['main'].values():
            main.update(assembled=True, processing_generated=True)
        incoming = copy.deepcopy(previous)
        incoming['metadata']['duration_ms'] = 1000
        for script in incoming['scripts'].values():
            script['actions'] = [{'at': 0, 'pos': 20}, {'at': 1000, 'pos': 80}]
        merged = merge_projects(previous, incoming)
        self.assertEqual(merged['metadata']['duration_ms'], 1000)
        for protection in ('edited', 'locked'):
            protected = copy.deepcopy(previous)
            protected['timeline']['main']['L0'][protection] = True
            self.assertEqual(merge_projects(protected, incoming)['metadata']['duration_ms'], previous['metadata']['duration_ms'])
        for protection, value in (('edited', True), ('locked', True), ('window', [1200,2000])):
            protected = copy.deepcopy(previous)
            protected['timeline']['tracks'][0][protection] = value
            self.assertEqual(merge_projects(protected, incoming)['metadata']['duration_ms'], previous['metadata']['duration_ms'])
        # Existing ordinary Motion Studio inputs still retain the longest ruler.
        normal = copy.deepcopy(previous)
        normal['metadata'].pop('processing_timeline')
        shorter = copy.deepcopy(incoming); shorter['metadata'].pop('processing_timeline')
        self.assertEqual(merge_projects(normal, shorter)['metadata']['duration_ms'], previous['metadata']['duration_ms'])

    def test_unchanged_input_and_appended_anchor_preserve_unlocked_edits(self):
        previous = self.initial
        track = previous['timeline']['tracks'][0]
        track['edited'] = True
        track['script']['actions'][0]['pos'] = 13
        previous['timeline']['main']['L0']['edited'] = True
        previous['scripts']['L0']['actions'][0]['pos'] = 17
        merged = merge_projects(previous, combine_projects({'project_0': self.mouth, 'project_1': self.hand}))
        self.assertEqual(merged['timeline']['tracks'][0], track)
        self.assertEqual(merged['scripts']['L0'], previous['scripts']['L0'])
        self.assertEqual(len(merged['timeline']['tracks']), 2)
        self.assertEqual(merged['timeline']['latest'], {'project_0': 'project_0', 'project_1': 'project_1'})

    def test_cache_hit_and_browser_zero_roundtrip_do_not_replace_edits(self):
        self.initial['timeline']['sources'][0]['data']['raw'][0][0] = -0.0
        self.initial['timeline']['sources'][0]['data']['metadata'].update(cache_hit=False, cache_path='/old.npz', inference_seconds=15)
        self.initial['timeline']['tracks'][0]['script']['actions'][0]['pos'] = 14
        self.initial['timeline']['tracks'][0]['edited'] = True
        incoming = copy.deepcopy(self.mouth)
        incoming['raw'][0][0] = 0
        incoming['metadata'].update(cache_hit=True, cache_path='/new.npz', inference_seconds=0, performance={'time': 9})
        merged = merge_projects(self.initial, incoming)
        self.assertEqual(merged['timeline']['tracks'], self.initial['timeline']['tracks'])
        self.assertEqual(len(merged['timeline']['sources']), 1)

    def test_latest_identity_survives_reverting_input_and_restart_with_saved_versions(self):
        previous = self.initial
        previous['timeline']['tracks'][0]['locked'] = True
        changed = copy.deepcopy(self.mouth)
        changed['scripts']['L0']['actions'][0]['pos'] = 4
        merged = merge_projects(previous, changed)
        second = merged['timeline']['latest']['project_0']
        self.assertNotEqual(second, 'project_0')
        # Preserve the newer source on a second locked lane, then revert the input.
        track = copy.deepcopy(merged['timeline']['tracks'][0])
        track.update(id='track_1', source=second)
        merged['timeline']['tracks'].append(track)
        reverted = merge_projects(merged, self.mouth)
        restarted = initialize(json.loads(json.dumps(reverted)))
        self.assertEqual(restarted['timeline']['latest']['project_0'], 'project_0')
        self.assertEqual(len(restarted['timeline']['sources']), 2)
        self.assertEqual(merge_projects(restarted, self.mouth), restarted)

    def test_updated_anchor_names_preserve_custom_titles_and_composed_sections(self):
        for custom in (False, True):
            previous = copy.deepcopy(self.initial)
            track = previous['timeline']['tracks'][0]
            track.update(edited=True, custom_name=custom)
            main = previous['timeline']['main']['L0']
            main.update(assembled=True, regions=[dict(source='project_0', start=0, end=2000, axis='L0')])
            merged = merge_projects(previous, self.hand)
            self.assertEqual(merged['timeline']['main']['L0'], main)
            self.assertEqual(merged['scripts']['L0'], previous['scripts']['L0'])
            self.assertEqual(merged['timeline']['tracks'][0]['name'], track['name'] if custom else 'project_0 · right hand · person 0')

    def test_other_video_cannot_replace_any_locked_lane(self):
        incoming = copy.deepcopy(self.mouth)
        incoming['metadata']['source']['path'] = 'different.mp4'
        for target in (self.initial['timeline']['tracks'][0], self.initial['timeline']['main']['R2']):
            target['locked'] = True
            with self.assertRaisesRegex(ValueError, 'locked tracks from another video'):
                merge_projects(self.initial, incoming)
            target['locked'] = False
        self.assertEqual(merge_projects(self.initial, incoming)['metadata'], incoming['metadata'])

    def test_browser_roundtrip_does_not_change_video_or_create_source_versions(self):
        self.initial['metadata']['source']['mtime_ns'] = 1780595540152825100
        self.initial['timeline']['sources'][0]['data']['metadata']['source']['mtime_ns'] = 1780595540152825100
        self.initial['timeline']['tracks'][0]['locked'] = True
        browser = copy.deepcopy(self.initial)
        browser['metadata']['source']['mtime_ns'] = int(float(1780595540152825100))
        data = browser['timeline']['sources'][0]['data']
        data['metadata']['source']['mtime_ns'] = int(float(1780595540152825100))
        data['config']['smoothing_ms'] = int(data['config']['smoothing_ms'])
        merged = merge_projects(browser, self.initial)
        self.assertEqual(len(merged['timeline']['sources']), 1)
        self.assertEqual(merged['timeline']['tracks'], browser['timeline']['tracks'])

    def test_store_restart_conflicts_and_actual_export(self):
        session = 'a' * 32
        with tempfile.TemporaryDirectory() as root:
            store = EditorStore(root)
            self.initial['timeline']['main']['L0']['locked'] = True
            self.initial['scripts']['L0']['actions'] = [{'at': 0, 'pos': 12}, {'at': 1900, 'pos': 88}]
            store.save(session, self.initial, 0)
            with self.assertRaises(Conflict): store.save(session, self.mouth, 0)
            restarted = EditorStore(root)
            path, revision = restarted.export(session, self.hand, lambda p: export_project(p, root, 'locked'))
            self.assertEqual(revision, 2)
            self.assertEqual(json.loads((path.parent / 'locked.funscript').read_text()), self.initial['scripts']['L0'])
            self.assertTrue(json.loads(path.read_text())['timeline']['main']['L0']['locked'])
            self.assertIn('id="lockMain"', (path.parent / 'viewer.html').read_text())
            with self.assertRaises(ValueError): store.read('../elsewhere')
            with self.assertRaises(Conflict): store.save(session, self.initial, 1)
