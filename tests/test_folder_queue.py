"""Persistent queue behavior using neutral videos and a stub inference callback."""
import json
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit
import shutil

import test_civitai_library as fixtures
from sam3d_funscript.folder_queue import FolderQueue
from sam3d_funscript.folder_store import ACTIVE, BATCH_RUNNING
from sam3d_funscript.processing_store import PlanConflict


class FolderQueueTests(unittest.TestCase):
    setUp=fixtures.CivitaiLibraryTests.setUp
    local=fixtures.CivitaiLibraryTests.local
    edit=fixtures.CivitaiLibraryTests.edit

    def queue(self, ids):
        queue=FolderQueue(self.library.root)
        queue.change(self.folder,'add',{'items':[{'id':str(i),'category':'Dance'} for i in ids]})
        return queue

    def network(self):
        def fetch(url,token):
            identifier=int(parse_qs(urlsplit(url).query)['imageId'][0])
            return {'items':[{'id':identifier,'type':'video','username':'Neutral','url':f'https://image.civitai.com/key/uuid/width=450/{identifier}.mp4'}]}
        mocks=[patch('sam3d_funscript.civitai_library.fetch_json',side_effect=fetch),
               patch('sam3d_funscript.civitai_library.transfer_video',side_effect=lambda url,path,progress:shutil.copy2(self.fixture,path))]
        result=[mock.start() for mock in mocks]
        for mock in mocks:self.addCleanup(mock.stop)
        return result

    def test_selection_is_persistent_deduplicated_and_does_not_download(self):
        with patch('sam3d_funscript.civitai_library.fetch_json') as fetch:
            queue=self.queue([1,2]);self.queue([2,3])
        fetch.assert_not_called()
        saved=FolderQueue(self.library.root).read(self.folder)
        self.assertEqual([i['id'] for i in saved['items']],['1','2','3'])
        self.assertTrue(all(i['state']=='waiting' for i in saved['items']))
        with self.assertRaises(ValueError):queue.change(self.folder,'add',{'items':[{'id':'4'},{'id':'invalid'}]})
        self.assertEqual(len(queue.read(self.folder)['items']),3)

    def test_background_worker_downloads_generates_and_keeps_temporary_drafts(self):
        fetch,transfer=self.network();queue=self.queue([1,2]);ticket=queue.start(self.folder)['ticket'];calls=[]
        result=queue.run(self.folder,ticket,lambda entry:calls.append(entry['id']))
        self.assertEqual(len(calls),2);self.assertEqual(transfer.call_count,2)
        self.assertEqual(result['stage'],'complete');self.assertEqual(len(result['completed']),2)
        rows=self.folders.scan(self.folder)['entries']
        self.assertTrue(all(e['civitai_temporary'] and e['status']=='pending' and e['batch_result']=='ready' for e in rows))
        self.assertEqual(list(self.videos.rglob('*.funscript')),[],'Draft generation never approves next to a video')
        self.assertFalse(ACTIVE);self.assertNotIn(self.folder,BATCH_RUNNING)

    def test_add_remove_and_prioritize_while_processing(self):
        self.network();queue=self.queue([1,2,3]);calls=[]
        def process(entry):
            identifier=entry['civitai_id'];calls.append(identifier)
            if identifier=='1':
                items=queue.read(self.folder)['items']
                with self.assertRaises(PlanConflict):queue.change(self.folder,'remove',{'key':items[0]['key']})
                queue.change(self.folder,'remove',{'key':items[1]['key']})
                queue.change(self.folder,'add',{'items':[{'id':'4'}]})
                last=queue.read(self.folder)['items'][-1]
                queue.change(self.folder,'first',{'key':last['key']})
        queue.run(self.folder,queue.start(self.folder)['ticket'],process)
        self.assertEqual(calls,['1','4','3'])

    def test_pause_resume_and_retry_keep_completed_work(self):
        _,transfer=self.network();queue=self.queue([1,2,3]);calls=[]
        def process(entry):
            calls.append(entry['civitai_id'])
            if len(calls)==1:queue.change(self.folder,'pause',{})
            if entry['civitai_id']=='2':raise ValueError('Fixture tracking failure')
        queue.run(self.folder,queue.start(self.folder)['ticket'],process)
        self.assertEqual(queue.read(self.folder)['stage'],'paused');self.assertEqual(calls,['1'])
        queue.run(self.folder,queue.start(self.folder)['ticket'],process)
        items=queue.read(self.folder)['items'];self.assertEqual([i['state'] for i in items],['ready','error','ready'])
        queue.change(self.folder,'retry',{'key':items[1]['key']})
        queue.run(self.folder,queue.start(self.folder)['ticket'],lambda entry:calls.append(entry['civitai_id']))
        self.assertEqual(calls,['1','2','3','2']);self.assertEqual(transfer.call_count,3,'Retry reuses downloaded video')
        queue.change(self.folder,'clear_finished',{})
        self.assertEqual(queue.read(self.folder)['items'],[])
        self.assertEqual(len(self.folders.scan(self.folder)['entries']),3,'Clearing the queue does not delete videos')

    def test_existing_scripts_are_ready_and_never_overwritten(self):
        video=self.local('Neutral_civitai_1_original.mp4');script=video.with_suffix('.funscript');script.write_text('{"actions":[]}')
        queue=self.queue([1,2]);self.network();calls=[]
        self.assertEqual(queue.read(self.folder)['items'][0]['state'],'ready')
        queue.run(self.folder,queue.start(self.folder)['ticket'],lambda entry:calls.append(entry['civitai_id']))
        self.assertEqual(calls,['2']);self.assertEqual(script.read_text(),'{"actions":[]}')

    def test_review_decisions_update_queue_and_rejected_clips_are_not_ready(self):
        self.network();queue=self.queue([1,2])
        queue.run(self.folder,queue.start(self.folder)['ticket'],lambda entry:None)
        entries=self.folders.scan(self.folder)['entries'];first,second=entries
        saved=self.edit(first)
        self.review.approve(self.folder,first['id'],'Approved',saved['revision'])
        self.review.reject(self.folder,second['id'])
        items=queue.read(self.folder)['items']
        self.assertEqual([i['state'] for i in items],['approved','skipped'])
        self.assertTrue(items[0]['name'].startswith('Approved/'))
        self.assertTrue((self.videos/items[0]['name']).with_suffix('.funscript').exists())

    def test_restart_recovers_waiting_items_and_reserves_only_one_run(self):
        queue=self.queue([1,2]);saved=queue.start(self.folder)
        with self.assertRaises(PlanConflict):queue.start(self.folder)
        state=self.folders.read(self.folder);state['processing_queue']['stage']='running';state['processing_queue']['items'][0]['state']='downloading';self.folders.write(state)
        with patch('sam3d_funscript.folder_queue.RUNTIME','new-process'):
            restored=FolderQueue(self.library.root).read(self.folder)
            self.assertEqual(restored['stage'],'interrupted')
            self.assertEqual([i['state'] for i in restored['items']],['interrupted','waiting'])
        self.assertEqual(len(queue.read(self.folder)['items']),2)

    def test_failed_submission_and_pause_before_execution_do_not_lose_items(self):
        queue=self.queue([1]);saved=queue.start(self.folder)
        queue.failed_start(self.folder,saved['ticket'],'Missing model')
        self.assertEqual(queue.read(self.folder)['stage'],'interrupted')
        saved=queue.start(self.folder);queue.change(self.folder,'pause',{})
        with patch('sam3d_funscript.civitai_library.fetch_json') as fetch:
            result=queue.run(self.folder,saved['ticket'],lambda entry:self.fail('Paused queue ran'))
        fetch.assert_not_called();self.assertEqual(result['stage'],'paused')
        self.assertEqual(queue.read(self.folder)['items'][0]['state'],'waiting')

    def test_interrupt_releases_clip_and_preserves_queue(self):
        self.network();queue=self.queue([1,2])
        class Interrupted(Exception):pass
        def process(entry):raise Interrupted()
        with self.assertRaises(Interrupted):queue.run(self.folder,queue.start(self.folder)['ticket'],process,interrupt_errors=(Interrupted,))
        self.assertEqual([i['state'] for i in queue.read(self.folder)['items']],['interrupted','waiting'])
        self.assertFalse(ACTIVE);self.assertNotIn(self.folder,BATCH_RUNNING)


if __name__=='__main__':unittest.main()
