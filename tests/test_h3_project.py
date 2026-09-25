import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

from sam3d_funscript.h3_project import catalogue, image_path, decisions, set_confidence, CATALOGUES
from sam3d_funscript.folder_store import FolderStore, ACTIVE
from sam3d_funscript.processing_store import PlanConflict
import test_folder_store


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value))


def project_fixture(root, video):
    from PIL import Image
    pages, panels = [], []
    for number, order in ((1, 1), (2, 0), (3, 2)):
        pid = f'page_{number:04d}'
        page = root / 'pages' / pid; page.mkdir(parents=True)
        Image.new('RGB', (64, 48), 'gray').save(page / 'source.png')
        pages.append(dict(page_id=pid, order=order, image=f'pages/{pid}/source.png', source_name=f'{number}.png'))
        folder = f'pages/{pid}/layouts/current/panels/{pid}_panel_001'
        if number == 3: continue
        (root / folder).mkdir(parents=True)
        Image.new('RGB', (64, 48), 'gray').save(root / folder / 'clean_reference.png')
        panels.append(dict(panel_id=pid+'_panel_001', page_id=pid, folder=folder, panel_order=0))
        write(page / 'current.json', {'layout':f'pages/{pid}/layouts/current/layout.json'})
        write(page / 'layouts/current/layout.json', {'panels':[{'panel_id':pid+'_panel_001', 'folder':folder}]})
        for take in (1, 2):
            take_path = root / folder / 'takes' / f'take_{take:04d}'; take_path.mkdir(parents=True)
            for name in ('video.mp4', 'video_clean.mp4'): shutil.copy2(video, take_path / name)
            write(take_path / 'render.json', {'panel_id':pid+'_panel_001', 'video':f'takes/take_{take:04d}/video.mp4',
                'variants':{key:f'takes/take_{take:04d}/{name}' for key,name in [('bubbles_on','video.mp4'),('bubbles_off','video_clean.mp4')]}})
    write(root / 'project.json', {'schema_version':1,'pages':pages})
    write(root / 'index.json', {'schema_version':1,'panels':panels})


class H3ProjectTests(unittest.TestCase):
    video = test_folder_store.FolderStoreTests.video

    def setUp(self):
        import sam3d_funscript.h3_project as h3
        h3.PROBE_DETECTOR = None
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name); self.videos = self.base / 'media'; self.videos.mkdir()
        neutral = self.video('neutral.mp4')
        self.project = self.base / 'H3'; project_fixture(self.project, neutral)
        self.store = FolderStore(self.base / 'output')
        self.listing = self.store.prepare(str(self.project), kind='h3'); self.folder = self.listing['folder']
        self.addCleanup(CATALOGUES.clear)

    def test_damaged_page_does_not_hide_good_pages(self):
        (self.project / 'pages/page_0001/current.json').write_text('{broken')
        listing = self.store.scan(self.folder, refresh=True)
        self.assertEqual(len(listing['entries']), 2)
        self.assertTrue(next(p for p in listing['h3']['pages'] if p['id']=='page_0001')['error'])
        self.assertEqual(len(self.store.batch_entries(self.folder)), 1)

    def test_damaged_join_metadata_blocks_uncertain_main_selection(self):
        (self.project / 'flf_sequence.json').write_text('{broken')
        listing = self.store.scan(self.folder, refresh=True)
        self.assertEqual(len(listing['entries']), 4)
        self.assertTrue(all(e['h3']['selection_error'] for e in listing['entries']))
        self.assertEqual(self.store.batch_entries(self.folder, clip_ids=[e['id'] for e in listing['entries']]), [])

    def test_missing_or_invalid_main_sidecar_does_not_block_draft_generation(self):
        entry = self.listing['entries'][0]; video = self.project / entry['name']
        write(video.with_suffix('.surge.funscript'), {'actions':[{'at':0,'pos':40},{'at':1000,'pos':60}]})
        self.assertEqual(self.store.entry(self.folder,entry['id'])[0]['status'], 'pending')
        self.assertIn(entry['id'], [e['id'] for e in self.store.batch_entries(self.folder)])
        video.with_suffix('.funscript').write_text('{broken')
        self.assertIn('invalid', self.store.entry(self.folder,entry['id'])[0]['script_warning'])
        write(video.with_suffix('.funscript'), {'actions':[{'at':0,'pos':40},{'at':1000,'pos':60}]})
        self.assertEqual(self.store.entry(self.folder,entry['id'])[0]['status'], 'existing')

    def test_deleted_waiting_take_does_not_stop_batch(self):
        entries=self.listing['entries']; seen=[]
        def process(entry):
            seen.append(entry['id'])
            if len(seen)==1: (self.project / entries[1]['name']).unlink()
        report=self.store.process_batch(self.folder,'',process,clip_ids=[e['id'] for e in entries])
        self.assertEqual(report['stage'],'complete')
        self.assertEqual(len(report['completed']),3)
        self.assertEqual(report['skipped'],[entries[1]['name']])

    def test_waiting_take_can_be_removed_without_interrupting_active_take(self):
        entries=self.listing['entries']; seen=[]
        def process(entry):
            seen.append(entry['id'])
            if len(seen)==1: self.store.h3_skip_waiting(self.folder,entries[1]['id'])
        report=self.store.process_batch(self.folder,'',process,clip_ids=[e['id'] for e in entries])
        self.assertEqual(len(seen),3)
        self.assertEqual(report['skipped'],[entries[1]['name']])

    def test_panel_exclusion_survives_new_take_and_preset_inheritance(self):
        from sam3d_funscript.h3_project import preset
        entry=self.listing['entries'][0]; panel=entry['h3']['panel_id'];page=entry['h3']['page_id']
        self.store.exclude_h3_page(self.folder,None,True,panel=panel)
        take=(self.project / entry['name']).parent
        new=take.with_name('take_0003');shutil.copytree(take,new)
        marker=json.loads((new/'render.json').read_text())
        marker['variants']={k:v.replace(take.name,new.name) for k,v in marker['variants'].items()}
        write(new/'render.json',marker)
        listing=self.store.scan(self.folder,refresh=True)
        self.assertTrue(all(e['status']=='ignored' for e in listing['entries'] if e['h3']['panel_id']==panel))
        preset(self.project,settings={'confidence':.2,'smoothing_ms':50})
        preset(self.project,page=page,settings={'confidence':.3,'smoothing_ms':90})
        self.assertEqual(preset(self.project,panel=panel)['settings']['confidence'],.3)
        self.assertEqual(self.store.clip_preset(self.folder,entry)['smoothing_ms'],90)

    def test_loop_hints_compare_all_enabled_axes_without_mutating_curves(self):
        from sam3d_funscript.h3_project import loop_issues
        project={'scripts':{'L0':{'actions':[{'at':0,'pos':0},{'at':1000,'pos':100}]},'R0':{'actions':[{'at':0,'pos':20},{'at':1000,'pos':20}]}},'config':{}}
        before=json.dumps(project)
        hints=loop_issues(project,1000)
        self.assertEqual(len(hints),2)
        self.assertTrue(all('L0 loop seam' in h['reason'] for h in hints))
        self.assertEqual(json.dumps(project),before)

    def test_portable_main_draft_survives_project_move_and_preserves_recovery(self):
        entry=self.listing['entries'][0];self.store.open(self.folder,entry['id'])
        saved=self.store.editors.read(entry['editor_session']);project=saved['project']
        project['scripts']['L0']['actions']=[{'at':0,'pos':15},{'at':900,'pos':85}]
        project['timeline']['main']['L0']['edited']=True
        saved=self.store.editors.save(entry['editor_session'],project,saved['revision'])
        self.store.review(self.folder,entry['id'],4,'Useful drawing',False,2,tags=['drawing'])
        self.store.h3_portable_draft(self.folder,entry['id'],saved['revision'])
        moved=self.base/'Moved';shutil.copytree(self.project,moved)
        target=FolderStore(self.base/'new-output');listing=target.prepare(str(moved),kind='h3')
        other=next(e for e in listing['entries'] if e['name']==entry['name']);target.open(listing['folder'],other['id'])
        fresh=target.editors.read(other['editor_session'])
        target.h3_portable_draft(listing['folder'],other['id'],fresh['revision'],restore=True)
        restored=target.editors.read(other['editor_session'])
        self.assertEqual(restored['project']['scripts']['L0']['actions'],project['scripts']['L0']['actions'])
        self.assertEqual(target.entry(listing['folder'],other['id'])[0]['quality'],4)
        self.assertEqual(target.entry(listing['folder'],other['id'])[0]['status'],'pending')
        self.assertTrue(target.versions(listing['folder'],other['id']))
        self.assertFalse((moved/entry['name']).with_suffix('.funscript').exists())

    def test_drawing_trial_uses_short_isolated_range_without_publishing(self):
        from sam3d_funscript.h3_project import tracking_trial
        from sam3d_funscript.reference import source_info
        entry=self.listing['entries'][0];video=self.project/entry['name'];info=source_info(video)
        seen=[]
        def extract(info,plan,root,model,**options):
            self.assertLessEqual(plan['tracking'][0]['end_ms']-plan['tracking'][0]['start_ms'],2000)
            self.assertEqual(options['sample_fps'],6)
            seen.append(root)
            return {'scripts':{'L0':{'actions':[{'at':0,'pos':30},{'at':900,'pos':70}]}},'times_ms':[],'pixels':[]},{}
        with patch('sam3d_funscript.processing_timeline.run_timeline',side_effect=extract):
            trial=tracking_trial(info,{'at_ms':0,'roi':[.1,.1,.8,.8],'anchor':'pelvis'},'fixture.pt',self.base)
        self.assertTrue(trial['images']);self.assertFalse(seen[0].exists())
        self.assertFalse(self.store.editors.path(entry['editor_session']).exists())

    def test_bad_join_endpoint_does_not_crash_catalogue(self):
        write(self.project/'flf_sequence.json',{'pairs':[{'variant':'flf_0123456789abcdef','endpoints':[{'folder':[]},{'folder':{}}]}]})
        listing=self.store.scan(self.folder,refresh=True)
        self.assertTrue(listing['h3']['warnings'])
        self.assertEqual(len(listing['entries']),4)

    def test_invalid_preset_file_is_preserved_and_reported(self):
        path=self.project/'.s3f-h3.json';write(path,{'version':1,'presets':[]})
        original=path.read_bytes()
        with self.assertRaisesRegex(ValueError,'Presets must be an object'): decisions(self.project)
        self.assertEqual(path.read_bytes(),original)

    def test_active_reading_order_one_variant_and_all_completed_takes(self):
        entries = self.listing['entries']
        self.assertEqual([e['h3']['page_id'] for e in entries], ['page_0002']*2+['page_0001']*2)
        self.assertEqual([e['h3']['latest'] for e in entries], [True,False]*2)
        self.assertTrue(all(e['name'].endswith('video_clean.mp4') for e in entries))
        self.assertEqual(len(self.listing['h3']['pages']), 3)
        self.assertEqual(len(self.store.batch_entries(self.folder)), 2)
        self.assertEqual(len(self.store.batch_entries(self.folder, clip_ids=[e['id'] for e in entries])), 4)
        self.assertEqual(image_path(self.project, panel='page_0001_panel_001').name, 'clean_reference.png')

    def test_main_take_drives_default_review_and_batch_without_hiding_alternatives(self):
        newest = self.project / self.listing['entries'][0]['name']
        panel = newest.parent.parent.parent
        write(panel / 'main_take.json', {'take_id': 'take_0001'})
        listing = self.store.scan(self.folder, refresh=True)
        rows = [e for e in listing['entries'] if e['h3']['page_id'] == 'page_0002']
        self.assertEqual([e['h3']['main'] for e in rows], [False, True])
        self.assertEqual([e['h3']['latest'] for e in rows], [True, False])
        self.assertEqual(self.store.choose(self.folder)['id'], rows[1]['id'])
        self.assertEqual(self.store.batch_entries(self.folder)[0]['id'], rows[1]['id'])
        (panel / 'main_take.json').write_text('{broken')
        listing = self.store.scan(self.folder, refresh=True)
        self.assertTrue(listing['entries'][0]['h3']['main'])
        self.assertIn('main take selection', listing['h3']['warnings'][0])

    def test_joined_selection_replaces_endpoints_and_respects_both_page_exclusions(self):
        first, last = self.listing['entries'][0], self.listing['entries'][2]
        variant = 'flf_0123456789abcdef'
        endpoints = [dict(panel_id=e['h3']['panel_id'], folder=Path(e['name']).parents[2].as_posix()) for e in (first, last)]
        marker = (self.project / first['name']).with_name('render.json')
        write(marker, {**json.loads(marker.read_text()), 'settings': {'reference_position': variant}})
        write(self.project / 'flf_sequence.json', {'schema_version':1, 'pairs':[{'variant':variant, 'endpoints':endpoints}]})
        # A stale saved main that is not part of this pair must not win.
        write(self.project / endpoints[0]['folder'] / 'main_take.json', {'take_id':'take_0001'})
        listing = self.store.scan(self.folder, refresh=True)
        selected = [e for e in listing['entries'] if e['h3']['main']]
        self.assertEqual([e['id'] for e in selected], [first['id']])
        self.assertEqual(selected[0]['h3']['source_page_ids'], ['page_0002','page_0001'])
        self.assertEqual(selected[0]['h3']['render_mode'], 'flf')
        self.assertEqual(len(self.store.batch_entries(self.folder)), 1)
        ACTIVE[first['timeline']] = -1
        try:
            with self.assertRaises(PlanConflict): self.store.exclude_h3_page(self.folder, 'page_0001', True)
        finally: ACTIVE.pop(first['timeline'])
        self.store.exclude_h3_page(self.folder, 'page_0001', True)
        self.assertEqual(self.store.entry(self.folder, first['id'])[0]['status'], 'ignored')
        self.store.exclude_h3_page(self.folder, 'page_0001', False)
        write(self.project / 'flf_sequence.json', {'schema_version':1, 'pairs':[]})
        listing = self.store.scan(self.folder, refresh=True)
        self.assertEqual([e['h3']['take'] for e in listing['entries'] if e['h3']['main']], ['take_0001', 'take_0002'])

    def test_still_video_is_visible_but_skipped_by_bulk(self):
        first = self.listing['entries'][0]
        marker = (self.project / first['name']).with_name('render.json')
        write(marker, {**json.loads(marker.read_text()), 'settings': {'render_mode':'still','still_motion':{'zoom':1.2}}})
        listing = self.store.scan(self.folder, refresh=True)
        self.assertTrue(listing['entries'][0]['h3']['main'])
        self.assertIn('Still / camera motion', listing['entries'][0]['h3']['label'])
        self.assertNotIn(first['id'], [e['id'] for e in self.store.batch_entries(self.folder)])
        self.assertEqual(self.store.batch_entries(self.folder, clip_ids=[first['id']]), [])
        self.assertEqual(self.store.open(self.folder, first['id'])['id'], first['id'])

    def test_incomplete_switchable_take_falls_back_to_the_completed_main(self):
        first = self.project / self.listing['entries'][0]['name']
        marker = first.with_name('render.json')
        write(marker, {**json.loads(marker.read_text()), 'settings': {'bubble_mode':'switchable'}})
        first.unlink()
        listing = self.store.scan(self.folder, refresh=True)
        self.assertEqual(listing['entries'][0]['h3']['take'], 'take_0001')
        self.assertTrue(listing['entries'][0]['h3']['main'])
        self.assertIn('incomplete switchable take', listing['h3']['warnings'][0])

    def test_fun_civ_export_holds_single_actions_and_rejects_wrong_duration(self):
        from sam3d_funscript.h3_project import export_scripts
        held = {'L0': {'actions':[{'at':500,'pos':37}]}}
        self.assertEqual(export_scripts(held,1000)['L0']['actions'], [{'at':0,'pos':37},{'at':1000,'pos':37}])
        self.assertEqual(held['L0']['actions'], [{'at':500,'pos':37}])
        for scripts in ({'L1':held['L0']}, {'L0':{'actions':[{'at':0,'pos':0},{'at':1051,'pos':100}]}}):
            with self.assertRaises(ValueError): export_scripts(scripts,1000)

    def test_approval_checks_video_timing_before_writing_any_files(self):
        entry = self.listing['entries'][0]; self.store.open(self.folder, entry['id'])
        state = self.store.editors.read(entry['editor_session'])
        state['project']['scripts']['L0']['actions'] = [{'at':0,'pos':30},{'at':5000,'pos':70}]
        state['project']['timeline']['main']['L0']['edited'] = True
        saved = self.store.editors.save(entry['editor_session'], state['project'], state['revision'])
        with self.assertRaisesRegex(ValueError, 'does not fit this video'):
            self.store.approve(self.folder, entry['id'], saved['revision'])
        self.assertEqual(list((self.project / entry['name']).parent.glob('*.funscript')), [])

    def test_unfinished_failed_and_removed_layout_videos_are_not_imported(self):
        first = self.project / self.listing['entries'][0]['name']
        write(first.parent / 'error.json', {'error':'encode failed'})
        first.with_name('render.json').unlink()
        write(self.project / 'pages/page_0001/current.json', {'layout':'pages/page_0001/layouts/new/layout.json'})
        write(self.project / 'pages/page_0001/layouts/new/layout.json', {'panels':[]})
        CATALOGUES.clear()
        listing = self.store.scan(self.folder)
        self.assertEqual(len(listing['entries']), 1)
        self.assertEqual(listing['entries'][0]['h3']['take'], 'take_0001')
        with self.assertRaises(PlanConflict): self.store.entry(self.folder, self.listing['entries'][0]['id'])

    def test_exclusions_restore_independently_and_survive_new_output_store(self):
        original = {name:(self.project/name).read_bytes() for name in ('project.json','index.json')}
        clip = self.listing['entries'][0]
        self.store.ignore(self.folder, clip['id'])
        self.store.exclude_h3_page(self.folder, 'page_0002', True)
        self.assertEqual(len(self.store.batch_entries(self.folder)), 1)
        self.store.exclude_h3_page(self.folder, 'page_0002', False)
        self.assertEqual(self.store.entry(self.folder, clip['id'])[0]['status'], 'ignored')
        self.store.ignore(self.folder, clip['id'], False)
        self.assertEqual(self.store.entry(self.folder, clip['id'])[0]['status'], 'pending')
        self.store.exclude_h3_page(self.folder, 'page_0003', True)  # no videos yet
        set_confidence(self.project, .25)
        moved_store = FolderStore(self.base / 'new-output').prepare(str(self.project), kind='h3')
        self.assertEqual(moved_store['h3']['excluded_pages'], ['page_0003'])
        self.assertEqual(moved_store['h3']['confidence'], .25)
        self.assertEqual(original, {name:(self.project/name).read_bytes() for name in original})

    def test_approve_saves_exact_curve_beside_selected_video_and_exclusion_keeps_it(self):
        entry = self.listing['entries'][0]; self.store.open(self.folder, entry['id'])
        saved = self.store.editors.read(entry['editor_session'])
        actions = [{'at':0,'pos':5},{'at':500,'pos':92},{'at':1000,'pos':12}]
        saved['project']['scripts']['L0']['actions'] = actions
        saved['project']['timeline']['main']['L0']['edited'] = True
        revision = self.store.editors.save(entry['editor_session'],saved['project'],saved['revision'])['revision']
        result = self.store.approve(self.folder,entry['id'],revision)
        path = (self.project / entry['name']).with_suffix('.funscript')
        self.assertIn(str(path), result['files'])
        self.assertEqual(json.loads(path.read_text())['actions'], actions)
        self.store.exclude_h3_page(self.folder, entry['h3']['page_id'], True)
        self.assertEqual(json.loads(path.read_text())['actions'], actions)
        with self.assertRaises(PlanConflict): self.store.approve(self.folder,entry['id'],revision)
        self.store.exclude_h3_page(self.folder, entry['h3']['page_id'], False)
        self.assertEqual(self.store.entry(self.folder, entry['id'])[0]['status'], 'approved')

    def test_paths_and_settings_are_validated_and_processing_is_protected(self):
        for value in (None, True, 0, 1.1, float('nan')):
            with self.assertRaises(ValueError): set_confidence(self.project,value)
        with self.assertRaises(ValueError): image_path(self.project,page='../../other')
        e = self.listing['entries'][0]; ACTIVE[e['timeline']] = -1
        try:
            with self.assertRaises(PlanConflict): self.store.exclude_h3_page(self.folder,e['h3']['page_id'],True)
        finally: ACTIVE.pop(e['timeline'])
        root = self.base / 'wrong'; root.mkdir()
        with self.assertRaisesRegex(ValueError,'project.json'): self.store.prepare(str(root),kind='h3')

    def test_probe_still_uses_saved_threshold_without_saving_a_project(self):
        from sam3d_funscript.h3_project import probe
        with patch('sam3d_funscript.automatic.PersonDetector') as detector, patch('sam3d_funscript.automatic.detector_path',return_value='fixture.pt'):
            detector.return_value.return_value = [{'box':[.1,.2,.8,.9],'confidence':.3}]
            result = probe(image_path(self.project,page='page_0001'),.15)
        detector.assert_called_once_with('fixture.pt', confidence=.15)
        self.assertEqual(len(result['samples']),1)
        self.assertIsNone(result['samples'][0]['at_ms'])
        self.assertTrue(result['samples'][0]['image'].startswith('data:image/jpeg;base64,'))

    def test_probe_video_samples_three_distinct_timestamps(self):
        from sam3d_funscript.h3_project import probe
        with patch('sam3d_funscript.automatic.PersonDetector') as detector, patch('sam3d_funscript.automatic.detector_path',return_value='fixture.pt'):
            detector.return_value.return_value = []
            result = probe(self.project / self.listing['entries'][0]['name'])
        self.assertEqual(len(result['samples']),3)
        times = [s['at_ms'] for s in result['samples']]
        self.assertEqual(times,sorted(set(times)))

    def test_image_only_project_keeps_all_page_controls_without_a_clip(self):
        for p in self.project.rglob('render.json'): p.unlink()
        CATALOGUES.clear()
        listing = self.store.scan(self.folder)
        self.assertEqual(listing['entries'],[])
        self.assertEqual(len(listing['h3']['pages']),3)
        self.assertIsNone(self.store.choose(self.folder))
        self.store.exclude_h3_page(self.folder,'page_0001',True)
        self.assertEqual(decisions(self.project)['excluded_pages'],['page_0001'])

    def test_refresh_finds_completed_takes_without_an_index_update(self):
        original = {name:(self.project/name).read_bytes() for name in ('project.json','index.json')}
        first = self.project / self.listing['entries'][0]['name']
        for number in (9999, 10000):
            target = first.parent.parent / f'take_{number}'
            target.mkdir(); shutil.copy2(first, target / 'video.mp4')
            write(target / 'render.json', {'panel_id':'page_0002_panel_001','video':f'takes/take_{number}/video.mp4'})
        listing = self.store.scan(self.folder, refresh=True)
        self.assertEqual(len(listing['entries']), 6)
        self.assertEqual([e['h3']['take'] for e in listing['entries'] if e['h3']['latest']], ['take_10000','take_0002'])
        self.assertEqual(original, {name:(self.project/name).read_bytes() for name in original})

    def test_bad_take_does_not_hide_good_videos_and_active_layout_is_authoritative(self):
        first = self.project / self.listing['entries'][0]['name']
        first.with_name('render.json').write_text('{broken')
        # Simulate the interval between H3 committing a layout/render and exporting its index.
        write(self.project / 'index.json', {'schema_version':1,'panels':[]})
        listing = self.store.scan(self.folder, refresh=True)
        self.assertEqual(len(listing['entries']), 3)
        self.assertTrue(listing['entries'][0]['h3']['latest'])
        self.assertIn('render.json', listing['h3']['warnings'][0])
        first.with_name('render.json').write_text('[]')
        self.assertEqual(len(self.store.scan(self.folder, refresh=True)['entries']), 3)

    def test_linked_variant_does_not_alias_another_take(self):
        first = self.project / self.listing['entries'][0]['name']
        other = self.project / self.listing['entries'][1]['name']
        first.unlink(); first.symlink_to(other)
        listing = self.store.scan(self.folder, refresh=True)
        self.assertEqual(len(listing['entries']), 4)
        self.assertTrue(listing['entries'][0]['name'].endswith('take_0002/video.mp4'))
        self.assertTrue(listing['entries'][0]['h3']['latest'])
        self.assertFalse(listing['entries'][1]['h3']['latest'])

    def test_video_exclusion_survives_preferred_variant_changing(self):
        entry = self.listing['entries'][0]
        self.store.ignore(self.folder, entry['id'])
        (self.project / entry['name']).unlink()
        changed = self.store.scan(self.folder, refresh=True)['entries'][0]
        self.assertEqual(changed['status'], 'ignored')
        self.assertTrue(changed['name'].endswith('/video.mp4'))
        self.store.ignore(self.folder, changed['id'], False)
        self.assertEqual(decisions(self.project)['excluded_videos'], [])
        self.assertEqual(self.store.entry(self.folder, changed['id'])[0]['status'], 'pending')

    def test_invalid_review_state_is_rejected_without_overwriting_it(self):
        path = self.project / '.s3f-h3.json'
        for value in ([], {'excluded_pages':'page_0001'}, {'confidence':True}, {'excluded_videos':['../other.mp4']}):
            write(path, value); original = path.read_bytes()
            with self.assertRaisesRegex(ValueError, 'H3 funscript review'):
                set_confidence(self.project, .25)
            self.assertEqual(path.read_bytes(), original)

    def test_single_frame_video_probe_uses_the_available_frame(self):
        import numpy as np
        from sam3d_funscript.h3_project import probe
        frame = (np.zeros((48,64,3), dtype=np.uint8), {'time_ms':0})
        def frames(*args, **kwargs):
            yield from [] if kwargs.get('start_seconds', 0) > 0 else [frame]
        with patch('sam3d_funscript.automatic.PersonDetector') as detector, \
                patch('sam3d_funscript.automatic.detector_path',return_value='fixture.pt'), \
                patch('sam3d_funscript.reference.source_info',return_value={'end_ms':1000}), \
                patch('sam3d_funscript.video.video_frames',side_effect=frames):
            detector.return_value.return_value = []
            result = probe('single-frame.mp4')
        self.assertEqual([s['at_ms'] for s in result['samples']], [0])


if __name__ == '__main__': unittest.main()
