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
        a,b=self.listing['entries']; (self.videos/'a.funscript').write_text('existing')
        state=self.store.ignore(self.folder,b['id'],True,'Poor tracking')
        self.assertEqual(state['counts'],dict(pending=0,approved=0,existing=1,ignored=1))
        reopened=FolderStore(self.store.root).prepare(str(self.videos))
        self.assertEqual(reopened,state)
        self.assertIsNone(self.store.choose(self.folder))
        restored=self.store.ignore(self.folder,b['id'],False)
        self.assertEqual(restored['counts']['pending'],1)
        self.assertEqual(self.store.choose(self.folder)['id'],b['id'])
        self.assertEqual((self.videos/'a.funscript').read_text(),'existing')
        shallow=self.store.prepare(str(self.videos),False)
        self.assertEqual([e['name'] for e in shallow['entries']],['a.mp4'])

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
        (self.videos/'sub/c.funscript').write_text('keep')
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
            calls.append(entry['name']);(self.videos/'sub/b.funscript').write_text('arrived during batch')
        report=self.store.process_batch(self.folder,'',process)
        self.assertEqual(calls,['a.mp4']);self.assertEqual(report['skipped'],['sub/b.mp4'])

if __name__=='__main__':unittest.main()
