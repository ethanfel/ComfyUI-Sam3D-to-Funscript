"""Folder review persistence, exact exports, session isolation and file protection."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from sam3d_funscript.folder_store import FolderStore
from sam3d_funscript.editor import blank_project
from sam3d_funscript.reference import source_info
from sam3d_funscript.processing_store import PlanConflict
import av
import numpy as np


class FolderStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name); self.videos = self.base/'videos'; self.videos.mkdir()
        self.store = FolderStore(self.base/'output')
        self.video('a.mp4'); self.video('sub/b.mp4')
        self.listing = self.store.prepare(str(self.videos)); self.folder = self.listing['folder']

    def video(self, name):
        path = self.videos/name; path.parent.mkdir(parents=True, exist_ok=True)
        with av.open(str(path), 'w') as container:
            stream = container.add_stream('libx264', rate=10); stream.width=64; stream.height=48; stream.pix_fmt='yuv420p'
            for i in range(10):
                for packet in stream.encode(av.VideoFrame.from_ndarray(np.full((48,64,3),i*20,np.uint8),format='rgb24')): container.mux(packet)
            for packet in stream.encode(): container.mux(packet)
        return path

    def edited(self, entry):
        self.store.open(self.folder, entry['id'])
        state=self.store.editors.read(entry['editor_session']); project=state['project']
        project['scripts']['L0']['actions']=[{'at':0,'pos':5},{'at':120,'pos':95},{'at':1000,'pos':20}]
        project['timeline']['main']['L0']['edited']=True
        return self.store.editors.save(entry['editor_session'],project,state['revision'])

    def test_scan_recurses_skips_existing_and_ignore_survives_new_store(self):
        a,b=self.listing['entries']; (self.videos/'a.funscript').write_text(json.dumps({'actions':[{'at':0,'pos':20},{'at':1000,'pos':80}]}))
        state=self.store.ignore(self.folder,b['id'],True,'Poor tracking')
        self.assertEqual(state['counts'],dict(pending=0,approved=0,existing=1,ignored=1))
        reopened=FolderStore(self.store.root).prepare(str(self.videos))
        self.assertEqual(reopened,state)
        self.assertIsNone(self.store.choose(self.folder))
        restored=self.store.ignore(self.folder,b['id'],False)
        self.assertEqual(restored['counts']['pending'],1)
        self.assertEqual(self.store.choose(self.folder)['id'],b['id'])
        self.assertEqual(json.loads((self.videos/'a.funscript').read_text())['actions'],[{'at':0,'pos':20},{'at':1000,'pos':80}])

    def test_bulk_reprocess_includes_ready_and_approved_but_preserves_files(self):
        a,b=self.listing['entries'];self.edited(a)
        self.store.approve(self.folder,a['id'],self.store.editors.read(a['editor_session'])['revision'])
        state=self.store.read(self.folder);state['decisions'].setdefault(b['id'],{})['batch_result']='ready';self.store.write(state)
        self.assertEqual(self.store.batch_entries(self.folder),[])
        ids=[a['id'],b['id']]
        self.assertEqual([e['id'] for e in self.store.batch_entries(self.folder,clip_ids=ids,reprocess=True)],ids)
        exported=(self.videos/'a.funscript').read_bytes();seen=[]
        report=self.store.process_batch(self.folder,'',lambda e:seen.append(e['id']),clip_ids=ids,reprocess=True)
        self.assertEqual(seen,ids);self.assertEqual(len(report['completed']),2)
        self.assertEqual((self.videos/'a.funscript').read_bytes(),exported)
        self.assertEqual(self.store.entry(self.folder,a['id'])[0]['status'],'approved')
        self.store.ignore(self.folder,b['id'])
        self.assertEqual(len(self.store.batch_entries(self.folder,clip_ids=ids,reprocess=True)),1)
        with self.assertRaises(ValueError): self.store.batch_entries(self.folder,reprocess=True)

    def test_bulk_audio_sync_preserves_reviews_curves_and_approval(self):
        from sam3d_funscript.folder_store import ACTIVE
        a,b = self.listing['entries']
        self.edited(a); saved = self.store.editors.path(a['editor_session']).read_bytes()
        self.store.review(self.folder,a['id'],4,'Keep this note',False,3,intensity_mode='manual')
        self.store.approve(self.folder,a['id'],self.store.editors.read(a['editor_session'])['revision'])
        script = (self.videos/'a.funscript').read_bytes()
        self.store.ignore(self.folder,b['id'])
        before = self.store.read(self.folder)['decisions']
        # Updating labels is safe while inference owns a clip; it does not save curves.
        ACTIVE[b['timeline']] = -1
        try: result = self.store.review_audio_sync(self.folder,[a['id'],b['id'],a['id']],True)
        finally: ACTIVE.pop(b['timeline'])
        self.assertEqual((result['matched'],result['updated']),(2,2))
        self.assertTrue(all(e['audio_sync'] for e in result['listing']['entries']))
        for clip, old in before.items():
            new = self.store.read(self.folder)['decisions'][clip]
            self.assertEqual({k:v for k,v in old.items() if k not in ('audio_sync','updated')},
                             {k:v for k,v in new.items() if k not in ('audio_sync','updated')})
        self.assertEqual(self.store.editors.path(a['editor_session']).read_bytes(),saved)
        self.assertEqual((self.videos/'a.funscript').read_bytes(),script)
        self.assertEqual(self.store.review_audio_sync(self.folder,[a['id']],True)['updated'],0)
        cleared = self.store.review_audio_sync(self.folder,[b['id']],False)['listing']
        self.assertEqual([e['audio_sync'] for e in cleared['entries']],[True,False])
        self.assertEqual([e['status'] for e in cleared['entries']],['approved','ignored'])

    def test_bulk_audio_sync_invalid_or_stale_selection_changes_nothing(self):
        a = self.listing['entries'][0]
        before = self.store.path(self.folder).read_bytes()
        for ids,flag in [(None,True),([],True),('all',True),([True],True),([a['id']],'true')]:
            with self.assertRaises(ValueError): self.store.review_audio_sync(self.folder,ids,flag)
        with self.assertRaises(PlanConflict):
            self.store.review_audio_sync(self.folder,[a['id'],'0'*32],True)
        self.assertEqual(self.store.path(self.folder).read_bytes(),before)
        shallow=self.store.prepare(str(self.videos),False)
        self.assertEqual([e['name'] for e in shallow['entries']],['a.mp4'])

    def test_auto_intensity_updates_from_main_and_manual_override_survives(self):
        from test_intensity import wave
        a = self.listing['entries'][0]; editor = self.edited(a)
        self.assertEqual(a['intensity_mode'], 'auto')
        def change(hz):
            state = self.store.editors.read(a['editor_session'])
            state['project']['scripts']['L0']['actions'] = wave(hz=hz, seconds=1)['scripts']['L0']['actions']
            return self.store.editors.save(a['editor_session'], state['project'], state['revision'])
        change(.5)
        result = self.store.review(self.folder, a['id'], intensity_mode='auto', compact=True)['entries'][0]
        self.assertEqual(result['intensity_mode'], 'auto')
        before = result['intensity']
        changed = change(3)
        estimate = self.store.intensity_estimate(self.folder, a['id'])
        self.assertEqual(estimate['revision'], changed['revision'])
        self.assertGreater(estimate['level'], before)
        # Approval computes against the latest saved curve, not a stale slider.
        approved = self.store.approve(self.folder, a['id'], changed['revision'])
        self.assertEqual(approved['listing']['entries'][0]['intensity'], estimate['level'])
        self.store.review(self.folder, a['id'], intensity=2, intensity_mode='manual')
        change(4)
        self.store.review(self.folder, a['id'], note='Keep manual')
        manual = self.store.entry(self.folder, a['id'])[0]
        self.assertEqual((manual['intensity'], manual['intensity_mode']), (2, 'manual'))
        # Explicitly choosing Unrated is also a manual override.
        self.store.review(self.folder, a['id'], intensity=0)
        self.assertEqual(self.store.entry(self.folder, a['id'])[0]['intensity_mode'], 'manual')
        self.store.review(self.folder, a['id'], intensity_mode='auto')
        self.assertEqual(self.store.entry(self.folder, a['id'])[0]['intensity_mode'], 'auto')
        for invalid in (True, '', 'bad', [], {}):
            with self.assertRaises(ValueError): self.store.review(self.folder, a['id'], intensity_mode=invalid)

    def test_intensity_survives_review_skip_approval_and_reload(self):
        a, b = self.listing['entries']
        self.assertEqual(a['intensity'], 0)
        edited = self.edited(a)
        self.store.review(self.folder, a['id'], 2, 'Energetic', audio_sync=True, intensity=5)
        self.store.review(self.folder, a['id'], 4, 'Updated note')
        self.store.ignore(self.folder, a['id'], True)
        self.store.ignore(self.folder, a['id'], False)
        self.store.approve(self.folder, a['id'], edited['revision'])
        reopened = FolderStore(self.store.root)
        entry = reopened.entry(self.folder, a['id'])[0]
        self.assertEqual((entry['intensity'], entry['quality'], entry['audio_sync'], entry['status']), (5, 4, True, 'approved'))
        self.assertEqual(reopened.entry(self.folder, b['id'])[0]['intensity'], 0)
        before = reopened.path(self.folder).read_bytes()
        for value in (-1, 6, True, 2.5, '4', [], {}):
            with self.subTest(value=value), self.assertRaises(ValueError):
                reopened.review(self.folder, a['id'], intensity=value)
            self.assertEqual(reopened.path(self.folder).read_bytes(), before)
        reopened.review(self.folder, a['id'], 4, intensity=0)
        self.assertEqual(FolderStore(self.store.root).entry(self.folder, a['id'])[0]['intensity'], 0)

    def test_audio_sync_is_independent_and_survives_review_approval_and_reload(self):
        a,b = self.listing['entries']
        self.assertIs(a['audio_sync'], False)
        edited = self.edited(a)
        self.store.review(self.folder, a['id'], 0, 'Music timing', audio_sync=True)
        self.assertEqual(self.store.entry(self.folder, a['id'])[0]['status'], 'pending')
        self.store.review(self.folder, a['id'], 4, 'Updated note')
        self.store.ignore(self.folder, a['id'], True)
        self.store.ignore(self.folder, a['id'], False)
        self.store.approve(self.folder, a['id'], edited['revision'])
        reopened = FolderStore(self.store.root)
        entry = reopened.entry(self.folder, a['id'])[0]
        self.assertEqual((entry['audio_sync'], entry['quality'], entry['status']), (True, 4, 'approved'))
        self.assertIs(reopened.entry(self.folder, b['id'])[0]['audio_sync'], False)
        reopened.review(self.folder, a['id'], 4, audio_sync=False)
        self.assertIs(FolderStore(self.store.root).entry(self.folder, a['id'])[0]['audio_sync'], False)
        before = reopened.read(self.folder)
        for bad in ('true', 'false', 1, 0, [], {}):
            with self.assertRaisesRegex(ValueError, 'Audio sync'):
                reopened.review(self.folder, a['id'], audio_sync=bad)
        self.assertEqual(reopened.read(self.folder), before)

    def test_each_clip_has_independent_plan_editor_and_ignore_keeps_drafts(self):
        a,b=self.listing['entries']; first=self.edited(a); self.edited(b)
        plan=self.store.plans.read(a['timeline']); plan['plan']['tracking'][0].update(anchor='mouth',locked=True)
        self.store.plans.save(a['timeline'],plan['revision'],plan['plan'])
        self.store.ignore(self.folder,a['id'],True,'later');self.store.ignore(self.folder,a['id'],False)
        self.store.open(self.folder,a['id'])
        self.assertEqual(self.store.editors.read(a['editor_session']),first)
        self.assertTrue(self.store.plans.read(a['timeline'])['plan']['tracking'][0]['locked'])
        self.assertNotEqual(a['editor_session'],b['editor_session'])
        self.assertEqual(self.store.scan(self.folder)['counts']['pending'],2)

    def test_review_known_clip_does_not_rescan_library_or_decode_video(self):
        a = self.listing['entries'][0]
        self.edited(a)
        reopened = FolderStore(self.store.root)
        with patch.object(reopened, 'scan', side_effect=AssertionError('Unnecessary library scan')), \
             patch('sam3d_funscript.folder_store.source_info', side_effect=AssertionError('Unnecessary video decode')):
            reopened.open(self.folder, a['id'], 'a'*32)
            reopened.hold_review(self.folder, a['id'], 'a'*32)
            reopened.issues(self.folder, a['id'])
            reopened.versions(self.folder, a['id'])

    def test_known_clip_lookup_keeps_scripts_decisions_and_processing_state_current(self):
        from sam3d_funscript.folder_store import ACTIVE
        a = self.listing['entries'][0]
        state = self.store.read(self.folder)
        state['decisions'][a['id']] = {'status':'ignored', 'quality':4, 'note':'Review later'}
        self.store.write(state)
        script = self.videos/'a.funscript'; script.write_text('{}')
        with patch.object(FolderStore, 'scan', side_effect=AssertionError('Unnecessary library scan')), \
             patch.dict(ACTIVE, {a['timeline']:123}):
            entry, _ = FolderStore(self.store.root).entry(self.folder, a['id'])
            self.assertEqual((entry['status'],entry['quality'],entry['note']), ('ignored',4,'Review later'))
            self.assertTrue(entry['processing'])
            self.assertEqual(entry['existing'], ['a.funscript'])
            script.unlink()
            self.assertEqual(self.store.entry(self.folder, a['id'])[0]['existing'], [])

    def test_cached_lookup_rejects_replaced_files_and_symlinked_parent(self):
        a,b = self.listing['entries']
        (self.videos/'a.mp4').write_bytes(b'changed')
        with self.assertRaises(PlanConflict): self.store.entry(self.folder, a['id'])
        outside = self.base/'moved'; (self.videos/'sub').rename(outside)
        (self.videos/'sub').symlink_to(outside, target_is_directory=True)
        with self.assertRaises(PlanConflict): self.store.entry(self.folder, b['id'])

    def test_cold_lookup_and_new_videos_still_scan(self):
        from sam3d_funscript.folder_store import ENTRY_NAMES, identity
        from sam3d_funscript.video import fingerprint
        a = self.listing['entries'][0]
        with patch.dict(ENTRY_NAMES, {}, clear=True), patch.object(self.store, 'scan', wraps=self.store.scan) as scan:
            self.assertEqual(self.store.entry(self.folder, a['id'])[0]['name'], 'a.mp4')
            scan.assert_called_once()
            new = self.video('new.mp4')
            self.assertEqual(self.store.entry(self.folder, identity(fingerprint(new)))[0]['name'], 'new.mp4')
            self.assertEqual(scan.call_count, 2)

    def test_approval_writes_exact_main_curves_next_to_video_and_is_not_automatic(self):
        a=self.listing['entries'][0]; state=self.edited(a)
        self.assertFalse(list(self.videos.glob('*.funscript')))
        result=self.store.approve(self.folder,a['id'],state['revision'])
        self.assertEqual(len(result['files']),6)
        self.assertEqual(json.loads((self.videos/'a.funscript').read_text()),state['project']['scripts']['L0'])
        self.assertEqual(json.loads((self.videos/'a.surge.funscript').read_text()),state['project']['scripts']['L1'])
        self.assertEqual(FolderStore(self.store.root).scan(self.folder)['entries'][0]['status'],'approved')
        self.assertEqual(self.store.choose(self.folder,'a.mp4',skip_done=True)['name'],'sub/b.mp4')
        with self.assertRaises(PlanConflict): self.store.approve(self.folder,a['id'],state['revision'])

    def test_stale_revision_ignored_clip_existing_file_and_changed_source_rejected(self):
        a=self.listing['entries'][0]; state=self.edited(a)
        with self.assertRaises(PlanConflict): self.store.approve(self.folder,a['id'],state['revision']-1)
        self.store.ignore(self.folder,a['id'])
        with self.assertRaises(PlanConflict): self.store.approve(self.folder,a['id'],state['revision'])
        self.store.ignore(self.folder,a['id'],False)
        (self.videos/'a.funscript').write_text('keep me')
        with self.assertRaises(PlanConflict): self.store.approve(self.folder,a['id'],state['revision'])
        self.assertEqual((self.videos/'a.funscript').read_text(),'keep me')
        (self.videos/'a.mp4').write_bytes(b'changed')
        with self.assertRaises(PlanConflict): self.store.open(self.folder,a['id'])

    def test_failed_export_rolls_back_only_new_files_and_keeps_pending(self):
        a=self.listing['entries'][0]; state=self.edited(a); original=Path.open
        def fail(path,*args,**kwargs):
            if path.name=='a.sway.funscript' and args and args[0]=='xb':raise OSError('disk full')
            return original(path,*args,**kwargs)
        with patch.object(Path,'open',fail),self.assertRaisesRegex(OSError,'disk full'):
            self.store.approve(self.folder,a['id'],state['revision'])
        self.assertFalse(list(self.videos.glob('*.funscript')))
        self.assertEqual(self.store.scan(self.folder)['entries'][0]['status'],'pending')

    def test_paths_are_derived_from_registered_folder_and_symlinks_not_followed(self):
        external=self.base/'external.mp4'; external.write_bytes(b'external')
        (self.videos/'escape.mp4').symlink_to(external)
        self.assertEqual(len(self.store.scan(self.folder)['entries']),2)
        with self.assertRaises(ValueError): self.store.read('../outside')
        with self.assertRaises(PlanConflict): self.store.open(self.folder,'../outside')
        with self.assertRaises(PlanConflict): self.store.ignore(self.folder,'../outside')
        with self.assertRaises(ValueError): self.store.prepare('')

    def test_import_existing_script_and_preserve_it_through_reprocessing(self):
        a=self.listing['entries'][0]
        script={'version':'1.0','actions':[{'at':0,'pos':12},{'at':600,'pos':87}]}
        (self.videos/'a.funscript').write_text(json.dumps(script))
        entry=self.store.open(self.folder,a['id'])
        editor=self.store.editors.read(a['editor_session'])
        self.assertEqual(editor['project']['scripts']['L0'],script)
        self.assertEqual(len(entry['script_versions']),1)
        from sam3d_funscript.editor import merge_projects
        incoming=blank_project(editor['project']['metadata'])
        incoming['scripts']['L0']['actions']=[{'at':0,'pos':99}]
        merged=merge_projects(editor['project'],incoming)
        self.assertEqual(merged['scripts']['L0'],script)
        edited=self.edited(a)
        self.store.open(self.folder,a['id'])
        self.assertEqual(self.store.editors.read(a['editor_session']),edited)

    def test_replace_requires_reviewed_versions_and_backs_up_original(self):
        a=self.listing['entries'][0]; original=b'{"actions":[{"at":0,"pos":17}]}'
        (self.videos/'a.funscript').write_bytes(original)
        opened=self.store.open(self.folder,a['id']); editor=self.edited(a)
        with self.assertRaises(PlanConflict): self.store.approve(self.folder,a['id'],editor['revision'],True,{})
        result=self.store.approve(self.folder,a['id'],editor['revision'],True,opened['script_versions'])
        self.assertEqual(Path(result['backups'][0]).read_bytes(),original)
        self.assertEqual(json.loads((self.videos/'a.funscript').read_text()),editor['project']['scripts']['L0'])
        with self.assertRaises(PlanConflict): self.store.approve(self.folder,a['id'],editor['revision'],True,opened['script_versions'])

    def test_failed_replacement_restores_originals(self):
        a=self.listing['entries'][0]; original=b'{"actions":[{"at":0,"pos":17}]}'
        (self.videos/'a.funscript').write_bytes(original)
        opened=self.store.open(self.folder,a['id']); editor=self.edited(a); path_open=Path.open
        def fail(path,*args,**kwargs):
            if path.name=='a.sway.funscript' and args and args[0]=='xb':raise OSError('disk full')
            return path_open(path,*args,**kwargs)
        with patch.object(Path,'open',fail),self.assertRaisesRegex(OSError,'disk full'):
            self.store.approve(self.folder,a['id'],editor['revision'],True,opened['script_versions'])
        self.assertEqual((self.videos/'a.funscript').read_bytes(),original)
        self.assertEqual(len(list(self.videos.glob('*.funscript'))),1)
        self.assertEqual(self.store.scan(self.folder)['entries'][0]['status'],'existing')

    def reduced_export(self):
        a = self.listing['entries'][0]
        editor = self.edited(a)
        self.store.approve(self.folder, a['id'], editor['revision'])
        originals = {path: path.read_bytes() for path in self.videos.glob('*.funscript')}
        expected = self.store.script_versions(self.videos/'a.mp4')
        project = editor['project']
        project['scripts'] = {'L0': project['scripts']['L0']}
        project['scripts']['L0']['actions'][0]['pos'] = 31
        project['config']['enabled_axes'] = ['L0']
        saved = self.store.editors.save(a['editor_session'], project, editor['revision'])
        return a, saved, expected, originals

    def test_reduced_export_removes_obsolete_axes_and_keeps_backups(self):
        a, saved, expected, originals = self.reduced_export()
        unrelated = self.videos/'other.funscript'; unrelated.write_bytes(b'keep')
        result = self.store.approve(self.folder, a['id'], saved['revision'], True, expected)
        self.assertEqual(set(self.videos.glob('*.funscript')), {self.videos/'a.funscript', unrelated})
        self.assertEqual(result['files'], [str(self.videos/'a.funscript')])
        self.assertEqual({Path(p).name: Path(p).read_bytes() for p in result['backups']},
                         {p.name: data for p, data in originals.items()})
        self.assertEqual(result['script_versions'], self.store.script_versions(self.videos/'a.mp4'))
        self.assertEqual(self.store.read(self.folder)['decisions'][a['id']]['files'], ['a.funscript'])

    def test_reduced_export_rolls_back_removed_axes_when_snapshot_fails(self):
        a, saved, expected, originals = self.reduced_export()
        decision = self.store.read(self.folder)['decisions'][a['id']]
        with patch.object(self.store, 'save_version', side_effect=OSError('snapshot failed')), self.assertRaisesRegex(OSError, 'snapshot failed'):
            self.store.approve(self.folder, a['id'], saved['revision'], True, expected)
        self.assertEqual({p: p.read_bytes() for p in self.videos.glob('*.funscript')}, originals)
        self.assertEqual(self.store.read(self.folder)['decisions'][a['id']], decision)

    def test_reduced_export_rolls_back_partial_removal(self):
        a, saved, expected, originals = self.reduced_export()
        unlink = Path.unlink
        def fail(path, *args, **kwargs):
            if path == self.videos/'a.sway.funscript': raise OSError('cannot remove')
            return unlink(path, *args, **kwargs)
        with patch.object(Path, 'unlink', fail), self.assertRaisesRegex(OSError, 'cannot remove'):
            self.store.approve(self.folder, a['id'], saved['revision'], True, expected)
        self.assertEqual({p: p.read_bytes() for p in self.videos.glob('*.funscript')}, originals)

    def test_reduced_export_preserves_externally_changed_obsolete_axis(self):
        a, saved, expected, originals = self.reduced_export()
        import os
        replace = os.replace
        changed = self.videos/'a.roll.funscript'
        def external_change(source, target):
            replace(source, target)
            if Path(target) == self.videos/'a.funscript': changed.write_bytes(b'external edit')
        with patch('sam3d_funscript.folder_store.os.replace', external_change), self.assertRaises(PlanConflict):
            self.store.approve(self.folder, a['id'], saved['revision'], True, expected)
        originals[changed] = b'external edit'
        self.assertEqual({p: p.read_bytes() for p in self.videos.glob('*.funscript')}, originals)

    def test_compact_review_actions_check_fresh_state_without_scans(self):
        a = self.listing['entries'][0]; saved = self.edited(a)
        with patch.object(self.store, 'scan', side_effect=AssertionError('Unnecessary library scan')):
            self.assertEqual(self.store.clip_listing(self.folder, a['id'])['entries'][0]['status'], 'pending')
            result = self.store.review(self.folder, a['id'], 4, 'note', audio_sync=True, intensity=3, compact=True)
            self.assertTrue(result['partial']); self.assertEqual(len(result['entries']), 1)
            self.assertEqual((result['entries'][0]['quality'], result['entries'][0]['intensity']), (4, 3))
            self.assertEqual(self.store.ignore(self.folder, a['id'], compact=True)['entries'][0]['status'], 'ignored')
            self.store.ignore(self.folder, a['id'], False, compact=True)
            result = self.store.approve(self.folder, a['id'], saved['revision'], compact=True)
            self.assertEqual(result['listing']['entries'][0]['status'], 'approved')
            from sam3d_funscript.folder_store import ACTIVE
            with patch.dict(ACTIVE, {a['timeline']: -1}):
                self.assertTrue(self.store.clip_listing(self.folder, a['id'])['entries'][0]['processing'])
                with self.assertRaises(PlanConflict): self.store.review(self.folder, a['id'], compact=True)

    def test_rating_note_survive_ignore_restore_approval_and_reload(self):
        a=self.listing['entries'][0]; editor=self.edited(a)
        self.store.review(self.folder,a['id'],4,'Good rhythm')
        self.store.ignore(self.folder,a['id'],True,'Good rhythm');self.store.ignore(self.folder,a['id'],False)
        self.store.approve(self.folder,a['id'],editor['revision'])
        self.store.ignore(self.folder,a['id'],True,'Good rhythm');self.store.ignore(self.folder,a['id'],False)
        entry=FolderStore(self.store.root).scan(self.folder)['entries'][0]
        self.assertEqual((entry['quality'],entry['note'],entry['status']),(4,'Good rhythm','approved'))
        for value in (True,1.1,6,-1,'3'):
            with self.assertRaises(ValueError):self.store.review(self.folder,a['id'],value)

    def test_bulk_subfolder_skips_scripts_ignored_and_completed_drafts(self):
        self.video('sub/c.mp4');self.video('sub/inner/d.mp4');self.video('sub/e.mp4')
        listing=self.store.scan(self.folder); rows={e['name']:e for e in listing['entries']}
        (self.videos/'sub/c.funscript').write_text(json.dumps({'actions':[{'at':0,'pos':20},{'at':1000,'pos':80}]}))
        self.store.ignore(self.folder,rows['sub/e.mp4']['id'])
        processed=[]
        report=self.store.process_batch(self.folder,'sub',lambda e:processed.append(e['name']))
        self.assertEqual(processed,['sub/b.mp4','sub/inner/d.mp4'])
        self.assertEqual(report['completed'],processed)
        self.assertEqual(self.store.process_batch(self.folder,'sub',lambda e:self.fail('Already processed'))['total'],0)
        self.assertEqual(list(self.videos.rglob('*.funscript')),[self.videos/'sub/c.funscript'])
        with self.assertRaises(ValueError):self.store.process_batch(self.folder,'../outside',lambda e:None)

    def test_bulk_failure_continues_and_stop_resumes_without_redoing_completed(self):
        self.video('c.mp4');calls=[]
        def process(entry):
            calls.append(entry['name'])
            if entry['name']=='c.mp4':raise ValueError('No person')
        report=self.store.process_batch(self.folder,'',process)
        self.assertEqual(len(report['completed']),2);self.assertEqual(len(report['failed']),1)
        calls.clear();self.store.process_batch(self.folder,'',lambda e:calls.append(e['name']))
        self.assertEqual(calls,['c.mp4'])
        self.video('d.mp4');self.video('e.mp4')
        class Stopped(Exception):pass
        calls.clear()
        def interrupted():
            if calls:raise Stopped()
        with self.assertRaises(Stopped):
            self.store.process_batch(self.folder,'',lambda e:calls.append(e['name']),interrupted,(Stopped,))
        self.assertEqual(self.store.scan(self.folder)['batch']['stage'],'stopped')
        calls.clear();self.store.process_batch(self.folder,'',lambda e:calls.append(e['name']))
        self.assertEqual(calls,['e.mp4'])

    def test_bulk_rechecks_existing_scripts_before_each_clip(self):
        calls=[]
        def process(entry):
            calls.append(entry['name']);(self.videos/'sub/b.funscript').write_text(json.dumps({'actions':[{'at':0,'pos':20},{'at':1000,'pos':80}]}))
        report=self.store.process_batch(self.folder,'',process)
        self.assertEqual(calls,['a.mp4']);self.assertEqual(report['skipped'],['sub/b.mp4'])

if __name__=='__main__':unittest.main()
