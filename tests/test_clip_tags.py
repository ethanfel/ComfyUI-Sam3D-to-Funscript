import unittest
import tempfile
from pathlib import Path
from unittest.mock import patch

from sam3d_funscript.clip_tags import MODEL, MODEL_REVISION, edit_tags, tag_fields, normalize_tags, civitai_tags, sample_images
from sam3d_funscript.tag_jobs import TagJobs, RUNNING, needed_sources
import test_folder_store


class TagTests(unittest.TestCase):
    def test_frames_ignore_invalid_metadata_but_keep_the_original_video(self):
        import av
        import numpy as np
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'non-utf8-comment.mp4'
            with av.open(str(path),'w',metadata_encoding='latin-1') as out:
                out.metadata['comment']='x\xac'
                stream=out.add_stream('libx264',rate=10)
                stream.width=64;stream.height=48;stream.pix_fmt='yuv420p'
                for i in range(10):
                    frame=av.VideoFrame.from_ndarray(np.full((48,64,3),i*20,np.uint8),format='rgb24')
                    for packet in stream.encode(frame):out.mux(packet)
                for packet in stream.encode():out.mux(packet)
            before=path.read_bytes()
            with self.assertRaises(UnicodeDecodeError):
                with av.open(str(path)):pass
            for count in (1,3):
                frames=list(sample_images(path,count))
                self.assertEqual(len(frames),count)
                self.assertTrue(all(frame.size==(64,48) for frame in frames))
            self.assertEqual(path.read_bytes(),before)

    def test_normalize_and_manual_removal_survive_refresh(self):
        decision = {'tag_sources': {'local': ['long hair', 'solo'], 'civitai': ['woman']}}
        edit_tags(decision, ['DANCING', 'woman', 'long_hair', 'woman'])
        self.assertEqual(tag_fields(decision)['tags'], ['dancing','long hair','woman'])
        decision['tag_sources']['local'] = ['solo','long hair','standing']
        self.assertEqual(tag_fields(decision)['tags'], ['dancing','long hair','standing','woman'])
        edit_tags(decision, [])
        self.assertEqual(tag_fields(decision)['tags'], [])
        with self.assertRaises(ValueError): normalize_tags('woman')
        with self.assertRaises(ValueError): normalize_tags([None])

    def test_civitai_authenticated_tag_api_and_schema_validation(self):
        with patch('sam3d_funscript.civitai_library.fetch_json',return_value={'result':{'data':{'json':[{'name':'Long_Hair'},{'name':'woman'}]}}}) as fetch:
            self.assertEqual(civitai_tags('123','civitai.red','secret'), ['long hair','woman'])
            url, token=fetch.call_args.args
            self.assertIn('/api/trpc/tag.getVotableTags?',url); self.assertEqual(token,'secret')
        with patch('sam3d_funscript.civitai_library.fetch_json',return_value={'error':{}}):
            with self.assertRaisesRegex(ValueError,'tag data'):civitai_tags('123','civitai.red','')


class FolderTagTests(unittest.TestCase):
    def setUp(self):
        test_folder_store.FolderStoreTests.setUp(self)
        self.addCleanup(lambda: RUNNING.discard((str(self.store.root), self.folder)))
    video = test_folder_store.FolderStoreTests.video
    edited = test_folder_store.FolderStoreTests.edited
    def test_unreadable_clip_does_not_stop_the_tagging_batch(self):
        entries=self.listing['entries'][:2];jobs=TagJobs(self.store.root)
        with patch('sam3d_funscript.tag_jobs.threading.Thread'):
            job=jobs.start(self.folder,[entry['id'] for entry in entries],'local')
        with patch('sam3d_funscript.tag_jobs.ImageTagger'),patch('sam3d_funscript.tag_jobs.local_tags',side_effect=[ValueError('Cannot decode video'),['solo']]):
            jobs.run(self.folder,entries,job)
        result=jobs.read(self.folder)
        self.assertEqual((result['stage'],result['completed']),('complete',2))
        self.assertEqual(result['errors'],[{'name':entries[0]['name'],'error':'Cannot decode video','source':'local'}])
        self.assertEqual(self.store.entry(self.folder,entries[1]['id'])[0]['tags'],['solo'])
        self.assertFalse(RUNNING)

    def test_tag_job_and_edits_keep_reviews_scripts_and_export(self):
        entry=self.listing['entries'][0]
        self.edited(entry); self.store.review(self.folder,entry['id'],4,'keep note',True,3,tags=['manual'])
        before=self.store.editors.path(entry['editor_session']).read_bytes()
        jobs=TagJobs(self.store.root)
        with patch('sam3d_funscript.tag_jobs.threading.Thread'):
            job=jobs.start(self.folder,[entry['id']],'local',3,.35)
        with patch('sam3d_funscript.tag_jobs.ImageTagger'),patch('sam3d_funscript.tag_jobs.local_tags',return_value=['solo','woman']):
            jobs.run(self.folder,[entry],job)
        latest=self.store.entry(self.folder,entry['id'])[0]
        self.assertEqual(latest['tags'],['manual','solo','woman'])
        self.assertEqual((latest['quality'],latest['note'],latest['audio_sync'],latest['intensity']),(4,'keep note',True,3))
        self.assertEqual(self.store.editors.path(entry['editor_session']).read_bytes(),before)
        self.store.review(self.folder,entry['id'],4,'keep note',tags=['manual','woman'])
        with patch('sam3d_funscript.tag_jobs.threading.Thread'):
            job=jobs.start(self.folder,[entry['id']],'local')
        with patch('sam3d_funscript.tag_jobs.ImageTagger'),patch('sam3d_funscript.tag_jobs.local_tags',return_value=['solo','woman']):
            jobs.run(self.folder,[entry],job)
        self.assertEqual(self.store.entry(self.folder,entry['id'])[0]['tags'],['manual','woman'])
        self.assertEqual(jobs.read(self.folder)['stage'],'complete')
        self.assertFalse(RUNNING)

    def test_job_stop_interrupt_validation_and_frames(self):
        entry=self.listing['entries'][0];jobs=TagJobs(self.store.root)
        self.assertEqual(len(list(sample_images(self.videos/'a.mp4',3))),3)
        self.assertEqual(len(list(sample_images(self.videos/'a.mp4',1))),1)
        with self.assertRaises(ValueError):jobs.start(self.folder,[])
        with self.assertRaises(ValueError):jobs.start(self.folder,[entry['id']],threshold=float('nan'))
        with self.assertRaises(ValueError):jobs.start(self.folder,[entry['id']],force='false')
        with patch('sam3d_funscript.tag_jobs.threading.Thread'):
            job=jobs.start(self.folder,[entry['id']],'civitai')
        self.assertEqual(jobs.stop(self.folder)['stage'],'stopping')
        jobs.run(self.folder,[entry],job)
        self.assertEqual(jobs.read(self.folder)['completed'],0)
        self.assertEqual(jobs.read(self.folder)['stage'],'stopped')
        state=self.store.read(self.folder);state['tag_job']['stage']='running';self.store.write(state)
        self.assertEqual(jobs.read(self.folder)['stage'],'interrupted')

    def start_job(self, entries, **kwargs):
        jobs = TagJobs(self.store.root)
        with patch('sam3d_funscript.tag_jobs.threading.Thread') as thread:
            job = jobs.start(self.folder, [entry['id'] for entry in entries], **kwargs)
        return jobs, job, thread.call_args.kwargs['args'] if thread.called else None

    def test_second_run_skips_completed_empty_results_without_loading_model(self):
        entries = self.listing['entries']
        jobs, job, args = self.start_job(entries, source='local')
        with patch('sam3d_funscript.tag_jobs.ImageTagger'), patch('sam3d_funscript.tag_jobs.local_tags', return_value=[]):
            jobs.run(*args)
        with patch('sam3d_funscript.tag_jobs.ImageTagger') as model, patch('sam3d_funscript.tag_jobs.civitai_tags') as remote:
            jobs, job, args = self.start_job(entries, source='local')
            self.assertIsNone(args)
            self.assertEqual((job['stage'], job['total'], job['skipped'], job['selected']), ('complete', 0, 2, 2))
            model.assert_not_called(); remote.assert_not_called()

    def test_legacy_completed_tags_are_reused_and_force_is_explicit(self):
        entry = self.listing['entries'][0]
        state = self.store.read(self.folder)
        state['decisions'][entry['id']] = dict(tag_sources={'local': ['solo', 'woman']},
            tags_manual=['dancing'], tag_excluded=['solo'],
            tag_analysis=dict(model=MODEL, frames=3, threshold=.35, updated='2026-09-24T11:00:00Z'))
        self.store.write(state)
        jobs, job, args = self.start_job([entry], source='local', frames=3)
        self.assertIsNone(args)
        self.assertEqual(job['skipped'], 1)
        with patch('sam3d_funscript.tag_jobs.MODEL_REVISION', 'new-model'):
            self.assertIn('local', needed_sources(state['decisions'][entry['id']], entry, job))
        jobs, job, args = self.start_job([entry], source='local', frames=3, force=True)
        self.assertEqual((job['total'], job['skipped']), (1, 0))
        with patch('sam3d_funscript.tag_jobs.ImageTagger'), patch('sam3d_funscript.tag_jobs.local_tags', return_value=['solo', 'woman']) as local:
            jobs.run(*args)
        local.assert_called_once()
        self.assertEqual(self.store.entry(self.folder, entry['id'])[0]['tags'], ['dancing', 'woman'])

    def test_failed_remote_source_retries_without_rerunning_local(self):
        self.video('civitai_123_original.mp4')
        entry = next(e for e in self.store.scan(self.folder)['entries'] if e['name'].startswith('civitai_'))
        jobs, _, args = self.start_job([entry], source='both')
        with patch('sam3d_funscript.tag_jobs.ImageTagger'), patch('sam3d_funscript.tag_jobs.local_tags', return_value=['woman']), patch('sam3d_funscript.tag_jobs.civitai_tags', side_effect=ValueError('Remote offline')):
            jobs.run(*args)
        jobs, _, args = self.start_job([entry], source='both')
        with patch('sam3d_funscript.tag_jobs.ImageTagger') as model, patch('sam3d_funscript.tag_jobs.local_tags') as local, patch('sam3d_funscript.tag_jobs.civitai_tags', return_value=[]) as remote:
            jobs.run(*args)
        model.assert_not_called(); local.assert_not_called(); remote.assert_called_once()
        _, job, args = self.start_job([entry], source='both')
        self.assertIsNone(args)
        self.assertEqual(job['skipped'], 1)

    def test_failed_local_source_keeps_remote_results_and_retries_only_local(self):
        self.video('civitai_123_original.mp4')
        entry = next(e for e in self.store.scan(self.folder)['entries'] if e['name'].startswith('civitai_'))
        jobs, _, args = self.start_job([entry], source='both')
        with patch('sam3d_funscript.tag_jobs.ImageTagger'), patch('sam3d_funscript.tag_jobs.local_tags', side_effect=ValueError('Decode failed')), patch('sam3d_funscript.tag_jobs.civitai_tags', return_value=['dancing']):
            jobs.run(*args)
        self.assertEqual(self.store.entry(self.folder, entry['id'])[0]['tags'], ['dancing'])
        jobs, _, args = self.start_job([entry], source='both')
        with patch('sam3d_funscript.tag_jobs.ImageTagger'), patch('sam3d_funscript.tag_jobs.local_tags', return_value=['woman']), patch('sam3d_funscript.tag_jobs.civitai_tags') as remote:
            jobs.run(*args)
        remote.assert_not_called()
        self.assertEqual(self.store.entry(self.folder, entry['id'])[0]['tags'], ['dancing', 'woman'])

    def test_changed_local_settings_reuse_remote_results(self):
        self.video('civitai_123_original.mp4')
        entry = next(e for e in self.store.scan(self.folder)['entries'] if e['name'].startswith('civitai_'))
        for frames, threshold in [(1, .35), (3, .35), (3, .5)]:
            jobs, job, args = self.start_job([entry], source='both', frames=frames, threshold=threshold)
            with patch('sam3d_funscript.tag_jobs.ImageTagger'), patch('sam3d_funscript.tag_jobs.local_tags', return_value=['woman']) as local, patch('sam3d_funscript.tag_jobs.civitai_tags', return_value=['dancing']) as remote:
                jobs.run(*args)
            local.assert_called_once()
            self.assertEqual(local.call_args.args[-2:], (frames, threshold))
            self.assertEqual(remote.call_count, 1 if frames == 1 else 0)
        state = self.store.read(self.folder)
        state['decisions'][entry['id']]['tag_analysis']['sources']['local']['revision'] = 'old-model'
        self.store.write(state)
        jobs, job, args = self.start_job([entry], source='both', frames=3, threshold=.5)
        self.assertEqual(job['total'], 1)
        with patch('sam3d_funscript.tag_jobs.ImageTagger'), patch('sam3d_funscript.tag_jobs.local_tags', return_value=[]), patch('sam3d_funscript.tag_jobs.civitai_tags') as remote:
            jobs.run(*args)
        remote.assert_not_called()
        self.assertEqual(self.store.read(self.folder)['decisions'][entry['id']]['tag_analysis']['sources']['local']['revision'], MODEL_REVISION)

    def test_new_clip_is_tagged_while_existing_results_are_skipped(self):
        original = self.listing['entries'][0]
        jobs, _, args = self.start_job([original], source='local')
        with patch('sam3d_funscript.tag_jobs.ImageTagger'), patch('sam3d_funscript.tag_jobs.local_tags', return_value=[]):
            jobs.run(*args)
        entries = self.listing['entries']
        jobs, job, args = self.start_job(entries, source='local')
        self.assertEqual((job['total'], job['skipped'], job['selected']), (1, 1, 2))
        with patch('sam3d_funscript.tag_jobs.ImageTagger'), patch('sam3d_funscript.tag_jobs.local_tags', return_value=[]) as local:
            jobs.run(*args)
        local.assert_called_once()
        self.assertEqual(local.call_args.args[1].name, 'b.mp4')
