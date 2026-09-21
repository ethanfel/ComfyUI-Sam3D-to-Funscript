"""Folder node dispatch with real video/store setup and inference replaced by a stub."""
import json
import importlib
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch
import test_folder_store
from test_processing_session import load_node_module
from sam3d_funscript.folder_store import FolderStore


class FolderNodeTests(unittest.TestCase):
    video = test_folder_store.FolderStoreTests.video

    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.base=Path(self.temp.name);self.videos=self.base/'videos';self.videos.mkdir()
        self.video('a.mp4');self.video('sub/b.mp4')
        self.node=load_node_module();self.calls=[];self.events=[]
        review=importlib.import_module(self.node.__package__+'.sam3d_funscript.folder_review')
        self.preflight=patch.object(review,'preflight',return_value={'ok':True,'checks':[],'errors':[]}).start()
        self.store=FolderStore(self.base/'output'/'sam3d_funscript')
        self.listing=self.store.prepare(str(self.videos));self.folder=self.listing['folder']
        self.addCleanup(patch.stopall)
        patch.object(self.node.folder_paths,'get_output_directory',return_value=str(self.base/'output'),create=True).start()
        graph=types.ModuleType('comfy_execution.graph');graph.ExecutionBlocker=lambda reason:None
        video=types.ModuleType('comfy_api.latest._input_impl.video_types');video.VideoFromFile=lambda path:path
        management=types.ModuleType('comfy.model_management')
        class Interrupted(Exception):pass
        management.InterruptProcessingException=Interrupted;management.throw_exception_if_processing_interrupted=lambda:None
        server=types.ModuleType('server');server.PromptServer=types.SimpleNamespace(instance=types.SimpleNamespace(send_sync=lambda name,event:self.events.append((name,event))))
        patch.dict('sys.modules',{'comfy_execution.graph':graph,'comfy_api.latest._input_impl.video_types':video,'comfy.model_management':management,'server':server}).start()

    def run_node(self, **kwargs):
        return self.node.S3F_FolderTimeline().run(str(self.videos),'test-model',unique_id='9',**kwargs)

    def parent(self, video, model, **kwargs):
        self.calls.append((video,model,kwargs))
        session=next(n for n in kwargs['extra_pnginfo']['workflow']['nodes'] if str(n['id'])=='9')['properties']['s3f_timeline_session']
        state=self.store.plans.read(session)
        if kwargs['operation']=='automatic':
            state.update(editor_only=False,report={'jobs':[{'state':'complete'}]})
            self.store.plans.write(state)
        return {'ui':{'s3f_timeline':[session]},'result':({},state['project_path'])}

    def test_prepare_imports_and_returns_existing_main_without_inference(self):
        (self.videos/'a.funscript').write_text('{"actions":[{"at":0,"pos":17}]}')
        with patch.object(self.node.S3F_ProcessingTimeline,'run',side_effect=self.parent):
            result=self.run_node(video_name='a.mp4')
        self.assertEqual(result['result'][0]['scripts']['L0']['actions'][0]['pos'],17)
        self.assertEqual(self.calls[0][2]['operation'],'prepare')
        self.assertTrue(result['ui']['s3f_folder_entry'][0]['script_versions'])

    def test_selected_browser_batch_passes_only_requested_clip_to_inference(self):
        chosen=self.listing['entries'][1]
        with patch.object(self.node.S3F_ProcessingTimeline,'run',side_effect=self.parent):
            result=self.run_node(operation='automatic',plan_json=json.dumps({'folder_batch':{'clip_ids':[chosen['id']]}}))
        self.assertEqual([Path(call[0]).name for call in self.calls],['b.mp4'])
        self.assertEqual(result['ui']['s3f_folder_batch'][0]['completed'],['sub/b.mp4'])

    def test_persistent_queue_generates_a_draft_for_only_the_selected_clip(self):
        queue_module=importlib.import_module(self.node.__package__+'.sam3d_funscript.folder_queue')
        (self.videos/'a.mp4').rename(self.videos/'Neutral_civitai_123_original.mp4')
        queue=queue_module.FolderQueue(self.store.root)
        queue.change(self.folder,'add',{'items':[{'id':'123'}]})
        ticket=queue.start(self.folder)['ticket']
        with patch.object(self.node.S3F_ProcessingTimeline,'run',side_effect=self.parent):
            result=self.run_node(operation='automatic',plan_json=json.dumps({'folder_queue':{'ticket':ticket}}))
        self.assertEqual(len(self.calls),1)
        self.assertEqual(queue.read(self.folder)['items'][0]['state'],'ready')
        self.assertNotIn('s3f_folder_entry',result['ui'])
        self.assertEqual(list(self.videos.rglob('*.funscript')),[])

    def test_explicit_reprocessing_allowed_for_scripted_clip_but_stale_selection_rejected(self):
        entry=self.listing['entries'][0]
        (self.videos/'a.funscript').write_text('{"actions":[{"at":0,"pos":17}]}')
        extra={'workflow':{'nodes':[{'id':9,'type':'S3F_FolderTimeline','properties':{'s3f_timeline_session':entry['timeline']}}]}}
        with patch.object(self.node.S3F_ProcessingTimeline,'run',side_effect=self.parent):
            self.run_node(video_name='a.mp4',operation='automatic',extra_pnginfo=extra)
            with self.assertRaises(self.node.PlanConflict):self.run_node(video_name='sub/b.mp4',operation='automatic',extra_pnginfo=extra)
        self.assertEqual(len(self.calls),1)
        self.assertEqual((self.videos/'a.funscript').read_text(),'{"actions":[{"at":0,"pos":17}]}')

    def test_bulk_runs_one_node_per_video_without_navigating_review(self):
        self.video('sub/c.mp4')
        (self.videos/'a.funscript').write_text('{"actions":[{"at":0,"pos":17}]}')
        def worker(video,model,**kwargs):
            if video.endswith('c.mp4') and kwargs['operation']=='automatic':raise ValueError('No person')
            return self.parent(video,model,**kwargs)
        with patch.object(self.node.S3F_ProcessingTimeline,'run',side_effect=worker):
            result=self.run_node(video_name='a.mp4',operation='automatic',plan_json=json.dumps({'folder_batch':{'subfolder':'sub'}}),batch_size=64)
        batch=result['ui']['s3f_folder_batch'][0]
        self.assertEqual(batch['completed'],['sub/b.mp4']);self.assertEqual(batch['failed'][0]['name'],'sub/c.mp4')
        self.assertNotIn('s3f_folder_entry',result['ui'],'Background completion must not navigate the review workspace')
        self.assertEqual(self.calls[0][2]['batch_size'],64)
        self.assertEqual(self.calls[0][2]['plan_json'],'{}')
        self.assertEqual(len(list(self.videos.rglob('*.funscript'))),1)
        self.assertTrue(self.events)

    def test_missing_model_preflight_prevents_any_inference(self):
        self.preflight.return_value={'ok':False,'checks':[],'errors':['SAM3D model missing']}
        with patch.object(self.node.S3F_ProcessingTimeline,'run',side_effect=self.parent),self.assertRaisesRegex(ValueError,'preflight'):
            self.run_node(operation='automatic',plan_json='{"folder_batch":{}}')
        self.assertEqual(self.calls,[])
        self.assertIsNone(self.store.scan(self.folder)['batch'])

    def test_subfolder_preset_reaches_automatic_plan_and_sampling(self):
        entry=self.listing['entries'][1]
        self.store.preset(self.folder,'sub',{'preferred_anchor':'mouth','smoothing_ms':60,'sample_fps':12,'batch_size':32})
        extra={'workflow':{'nodes':[{'id':9,'properties':{'s3f_timeline_session':entry['timeline']}}]}}
        with patch.object(self.node.S3F_ProcessingTimeline,'run',side_effect=self.parent):
            self.run_node(video_name=entry['name'],operation='automatic',extra_pnginfo=extra)
        options=self.calls[0][2]
        self.assertEqual((options['sample_fps'],options['batch_size']),(12,32))
        self.assertEqual(json.loads(options['plan_json'])['automatic_options']['folder_preset']['preferred_anchor'],'mouth')

if __name__=='__main__':unittest.main()
