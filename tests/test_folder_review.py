"""Review concurrency, recovery snapshots, folder presets and explainable flags."""
import copy
import threading
import types
import unittest
from unittest.mock import patch

import test_folder_store
from sam3d_funscript.folder_store import ACTIVE, BATCH_RUNNING, REVIEW_LEASES, editing_session
from sam3d_funscript.processing_store import PlanConflict
from sam3d_funscript.folder_review import apply_preset, preset_settings, preflight, review_issues


class FolderReviewTests(unittest.TestCase):
    setUp = test_folder_store.FolderStoreTests.setUp
    video = test_folder_store.FolderStoreTests.video
    edited = test_folder_store.FolderStoreTests.edited

    def test_versions_restore_main_with_recovery_and_keep_source_and_sidecars(self):
        a=self.listing['entries'][0]; first=self.edited(a)
        version=self.store.save_version(self.folder,a['id'],'Gentler',first['revision'],4,'Keep this one')
        saved=self.store.version(self.folder,a['id'],version['id'])
        self.assertEqual(saved['scripts'],first['project']['scripts'])
        project=copy.deepcopy(first['project']);project['scripts']['L0']['actions'][0]['pos']=31
        second=self.store.editors.save(a['editor_session'],project,first['revision'])
        with self.assertRaises(PlanConflict):self.store.restore_version(self.folder,a['id'],version['id'],first['revision'])
        self.assertEqual(len(self.store.versions(self.folder,a['id'])),1)
        result=self.store.restore_version(self.folder,a['id'],version['id'],second['revision'])
        restored=self.store.editors.read(a['editor_session'])
        self.assertEqual(restored['revision'],result['revision'])
        self.assertEqual(restored['project']['scripts'],first['project']['scripts'])
        self.assertEqual(restored['project']['timeline']['sources'],second['project']['timeline']['sources'])
        recovery=next(v for v in result['versions'] if v['name'].startswith('Before restoring'))
        self.assertEqual(self.store.version(self.folder,a['id'],recovery['id'])['scripts'],second['project']['scripts'])
        self.assertFalse(list(self.videos.rglob('*.funscript')))
        self.store.rate_version(self.folder,a['id'],version['id'],'Preferred',5,'Reviewed')
        updated=self.store.version(self.folder,a['id'],version['id'])
        self.assertEqual((updated['name'],updated['quality'],updated['note']),('Preferred',5,'Reviewed'))
        self.assertEqual(updated['scripts'],saved['scripts'])

    def test_version_restore_honors_main_lock_and_approval_snapshots_rating(self):
        a=self.listing['entries'][0];first=self.edited(a)
        version=self.store.save_version(self.folder,a['id'],'Original',first['revision'])
        first['project']['timeline']['main']['L0']['locked']=True
        locked=self.store.editors.save(a['editor_session'],first['project'],first['revision'])
        with self.assertRaisesRegex(PlanConflict,'Unlock'):self.store.restore_version(self.folder,a['id'],version['id'],locked['revision'])
        self.assertEqual(len(self.store.versions(self.folder,a['id'])),1)
        self.store.review(self.folder,a['id'],5,'Final')
        self.store.approve(self.folder,a['id'],locked['revision'])
        approved=next(v for v in self.store.versions(self.folder,a['id']) if v['name'].startswith('Approved'))
        self.assertEqual((approved['quality'],approved['note']),(5,'Final'))

    def test_presets_inherit_and_only_change_unlocked_automatic_regions(self):
        self.store.preset(self.folder,'',{'preferred_anchor':'mouth','smoothing_ms':50})
        self.store.preset(self.folder,'sub',{'preferred_anchor':'left_hand','range_mode':'fixed','movement_range':.12})
        a,b=self.listing['entries']
        self.assertEqual(self.store.clip_preset(self.folder,a)['preferred_anchor'],'mouth')
        self.assertEqual(self.store.preset(self.folder,'sub/nested')['settings']['preferred_anchor'],'left_hand')
        plan={'tracking':[dict(id=str(i),locked=i==1,automatic={} if i==2 else {'anchors':['mouth','pelvis','left_hand','right_hand']}) for i in range(3)]}
        result=apply_preset(plan,self.store.clip_preset(self.folder,b))
        self.assertEqual(result['tracking'][0]['settings']['axis_settings']['L0'],dict(range=.12,auto_fit=False,calibration='clip'))
        self.assertEqual(result['tracking'][0]['automatic']['anchors'],plan['tracking'][0]['automatic']['anchors'])
        self.assertEqual(result['tracking'][1:],plan['tracking'][1:])
        for bad in [{'batch_size':1.5},{'smoothing_ms':float('nan')},{'range_mode':'bad'},{'preferred_anchor':'foot'},{'unknown':1}]:
            with self.assertRaises(ValueError):preset_settings(bad)
        with self.assertRaises(ValueError):self.store.preset(self.folder,'../escape')

    def test_active_clip_locked_other_clip_editable_and_open_review_deferred(self):
        a,b=self.listing['entries'];self.edited(a);second=self.edited(b)
        entered=threading.Event();release=threading.Event();result=[];errors=[];calls=[]
        def process(entry):
            calls.append(entry['name']);entered.set()
            if not release.wait(10):raise TimeoutError('Test did not release worker')
        def batch():
            try:result.append(self.store.process_batch(self.folder,'',process))
            except BaseException as error:errors.append(error)
        worker=threading.Thread(target=batch);worker.start()
        try:
            self.assertTrue(entered.wait(10))
            with self.assertRaisesRegex(PlanConflict,'processing'):
                with editing_session(a['editor_session']):pass
            with self.assertRaises(PlanConflict):self.store.ignore(self.folder,a['id'])
            with editing_session(b['editor_session']):
                second['project']['scripts']['L0']['actions'][0]['pos']=42
                self.store.editors.save(b['editor_session'],second['project'],second['revision'])
            self.store.hold_review(self.folder,b['id'],'a'*32)
        finally:release.set();worker.join(10)
        self.assertFalse(worker.is_alive());self.assertEqual(errors,[])
        self.assertEqual(calls,['a.mp4']);self.assertEqual(result[0]['deferred'],['sub/b.mp4'])
        self.assertEqual(self.store.editors.read(b['editor_session'])['project']['scripts']['L0']['actions'][0]['pos'],42)
        self.assertNotIn(a['timeline'],ACTIVE);self.assertNotIn(self.folder,BATCH_RUNNING)
        self.store.hold_review(self.folder,None,'a'*32)

    def test_pause_after_clip_resume_and_retry_only_failures(self):
        calls=[];events=[]
        def pause_after(entry):calls.append(entry['name']);self.store.pause_batch(self.folder)
        report=self.store.process_batch(self.folder,'',pause_after,progress=events.append)
        self.assertEqual(report['stage'],'paused');self.assertEqual(calls,['a.mp4'])
        self.assertIsInstance(report['eta_seconds'],int)
        self.assertTrue(any(e['stage']=='running' and e['completed'] and e['current_id'] is None for e in events))
        def fail(entry):calls.append(entry['name']);raise ValueError('No person')
        report=self.store.process_batch(self.folder,'',fail)
        self.assertEqual([e['name'] for e in report['failed']],['sub/b.mp4'])
        self.video('sub/c.mp4')
        report=self.store.process_batch(self.folder,'',lambda entry:calls.append(entry['name']),retry_failed=True)
        self.assertEqual(report['completed'],['sub/b.mp4'])
        self.assertEqual(calls,['a.mp4','sub/b.mp4','sub/b.mp4'])
        self.assertEqual([e['name'] for e in self.store.batch_entries(self.folder)],['sub/c.mp4'])

    def test_stale_running_state_and_interruption_release_locks(self):
        class Interrupted(Exception):pass
        def interrupted(entry):raise Interrupted()
        with self.assertRaises(Interrupted):self.store.process_batch(self.folder,'',interrupted,interrupt_errors=(Interrupted,))
        self.assertFalse(any(e['processing'] for e in self.store.scan(self.folder)['entries']))
        self.assertNotIn(self.folder,BATCH_RUNNING)
        state=self.store.read(self.folder);state['batch']['stage']='running';self.store.write(state)
        self.assertEqual(self.store.scan(self.folder)['batch']['stage'],'interrupted')
        self.assertEqual(len(self.store.batch_entries(self.folder)),2)

    def test_preflight_checks_files_without_loading_models(self):
        model=self.base/'model.safetensors';model.write_bytes(b'fixture')
        detector=self.base/'person.pt';detector.write_bytes(b'fixture')
        folders=types.SimpleNamespace(get_full_path=lambda category,name:str(model) if name=='model' else None)
        with patch.dict('sys.modules',{'folder_paths':folders}),patch('sam3d_funscript.automatic.detector_path',return_value=detector),patch('sam3d_funscript.folder_review.importlib.util.find_spec',return_value=object()):
            self.assertTrue(preflight({'model_file':'model'})['ok'])
            failed=preflight({'model_file':'missing','tracker_model':'missing'},needs_tracker=True)
            self.assertFalse(failed['ok']);self.assertEqual(len(failed['errors']),2)


class ReviewIssueTests(unittest.TestCase):
    def test_flags_local_ranges_and_ignores_jumps_at_cuts(self):
        data=dict(metadata={'processing_region':{'start_ms':0,'end_ms':3000},'automatic_candidate':{'review':['Person overlap']}},
                  times_ms=[0,100,200,300,400,500],valid=[True,False,False,False,False,True],metrics={'L0':{'clipped_fraction':.1}})
        project=dict(metadata={'duration_ms':5000},timeline={'sources':[{'id':'source','data':data}],
            'tracks':[{'id':'track','source':'source','axis':'L0'}]},scripts={'L0':{'actions':[
                {'at':0,'pos':0},{'at':100,'pos':90},{'at':200,'pos':0},{'at':1000,'pos':50},{'at':4000,'pos':51}]}})
        issues=review_issues(project,{'scene_cuts':{'times_ms':[100]}})
        reasons=[i['reason'] for i in issues]
        self.assertIn('Person overlap',reasons);self.assertIn('Missing tracking samples',reasons)
        self.assertIn('More than 5% of movement is clipped',reasons)
        self.assertTrue(any(reason.startswith('Little movement') for reason in reasons))
        self.assertNotIn('Sudden movement jump',reasons)
        self.assertTrue(all(0<=i['start_ms']<i['end_ms']<=5000 for i in issues))
        self.assertTrue(any(i['track']=='track' and i['start_ms']==100 and i['end_ms']==500 for i in issues))
        self.assertNotIn('quality',project)
        self.assertIn('Sudden movement jump',[i['reason'] for i in review_issues(project)])


if __name__=='__main__':unittest.main()
