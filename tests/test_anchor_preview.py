from copy import deepcopy
import importlib
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

import numpy as np

from sam3d_funscript.anchor_preview import preview_anchor
from sam3d_funscript.processing_timeline import normalize_plan
from sam3d_funscript.processing_store import ProcessingStore
from sam3d_funscript.video import predict_frame
from sam3d_funscript.reference import source_info
from test_mesh_anchor import mesh_person, FACES, PAINT
from test_masks import write_video
from test_processing_session import load_node_module
from test_processing_timeline import info, region


class PreviewTests(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup);self.root=Path(temp.name)
        self.info={**info(), 'width':100, 'height':100}
        self.plan=normalize_plan({'tracking':[region('t',0,1000,anchor='left_hand',additional_anchors=['pelvis'])]}, self.info)
        self.person=mesh_person();self.person['pred_keypoints_3d'][:,2]=2
        self.person['pred_keypoints_3d'][:,0]=np.arange(70)/100
        self.geometry={'faces':FACES,'mouth_regressor':None}
        self.index={'first_frame':10,'times_ms':[0,40,100,150,1000]}
        self.predict=patch('sam3d_funscript.anchor_preview.predict_frame',return_value=(self.geometry,[self.person])).start()
        patch('sam3d_funscript.anchor_preview.frame_index',return_value=self.index).start()
        self.addCleanup(patch.stopall)

    def preview(self, at=100, **kwargs):
        return preview_anchor(self.info,self.plan,{'region_id':'t','at_ms':at},'model',self.root,**kwargs)

    def test_current_frame_uses_actual_centroid_and_detailed_additional_anchors(self):
        original=deepcopy(self.plan)
        result=self.preview()
        self.assertEqual(result['frame'],12)
        self.assertEqual(result['at_ms'],100)
        hand=result['anchors'][0]
        self.assertEqual(hand['indices'],list(range(42,63)))
        np.testing.assert_allclose(hand['position'],[.52,0,2])
        np.testing.assert_allclose(hand['pixel'],[76,50])
        self.assertEqual([a['name'] for a in result['anchors']],['left_hand','pelvis'])
        self.assertEqual(self.predict.call_count,1)
        self.assertEqual(self.predict.call_args.args[1],100)
        self.assertFalse(self.predict.call_args.kwargs['include_mesh'])
        self.assertEqual(self.plan,original)
        self.assertEqual(list(self.root.iterdir()),[],'preview does not publish motion results')

    def test_painted_seed_highlights_only_visible_fixed_vertices(self):
        self.plan['tracking'][0].update(anchor='mask_anchor',mask_anchor=deepcopy(PAINT),locked=True)
        with patch('sam3d_funscript.anchor_preview.prepare_patch',side_effect=AssertionError('No second inference on seed')):
            result=self.preview(0,use_cache=False)
        self.assertEqual(result['surface_points'],4)
        self.assertEqual(result['surface'],[[30,30],[70,30],[70,70],[30,70]])
        self.assertEqual(result['anchors'][0]['pixel'],[50,50])
        self.assertEqual(self.predict.call_count,1)
        self.assertTrue(self.predict.call_args.kwargs['include_mesh'])

    def test_other_frame_reuses_reference_patch_instead_of_rebinding(self):
        self.plan['tracking'][0].update(anchor='mask_anchor',mask_anchor=deepcopy(PAINT))
        self.person['pred_vertices'][:4]+=[.2,0,0]
        bound={'vertices':[0,1,2,3],'vertex_count':8}
        with patch('sam3d_funscript.anchor_preview.prepare_patch',return_value=bound) as prepare, \
             patch('sam3d_funscript.anchor_preview.bind_patch',side_effect=AssertionError('No rebinding on target frame')):
            result=self.preview(100)
        prepare.assert_called_once()
        self.assertEqual(result['reference_at_ms'],0)
        self.assertEqual(result['anchors'][0]['pixel'],[60,50])

    def test_invalid_frame_region_empty_paint_and_wrong_mask_person_do_not_infer(self):
        for request in [None,{}, {'region_id':'missing','at_ms':100},{'region_id':'t','at_ms':101},
                        {'region_id':'t','at_ms':1000},{'region_id':'t','at_ms':True},{'region_id':'t','at_ms':float('nan')}]:
            with self.assertRaises(ValueError):preview_anchor(self.info,self.plan,request,'model',self.root)
        self.plan['tracking'][0].update(anchor='mask_anchor',mask_anchor={'frame':0,'strokes':[]})
        with self.assertRaisesRegex(ValueError,'paint an area'):self.preview()
        self.plan['tracking'][0].update(anchor='pelvis',person=1)
        with self.assertRaisesRegex(ValueError,'person 0'):self.preview(mask_video_range=('mask',0,0))
        self.predict.assert_not_called()


class FrameCacheTests(unittest.TestCase):
    def test_repeated_frame_reuses_one_prediction_and_changed_frame_or_roi_invalidates_it(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);source=root/'source.mp4';write_video(source);current=source_info(source)
            native=types.ModuleType('comfy_extras.nodes_sam3d_body');native.__file__=__file__
            class Predictor:pass
            Predictor.__module__=native.__name__;native.SAM3DBody_Predict=Predictor
            model=types.SimpleNamespace(model=types.SimpleNamespace(head_pose=types.SimpleNamespace(faces_np=lambda:FACES)))
            native.SAM3DBody_Loader=types.SimpleNamespace(execute=lambda _:types.SimpleNamespace(result=[model]))
            folders=types.ModuleType('folder_paths');folders.get_full_path_or_raise=lambda *args:__file__
            calls=[]
            def predict(model,images,boxes,**kwargs):
                self.assertEqual(len(images),1);calls.append(boxes)
                return [[mesh_person()]]
            modules={'folder_paths':folders,'comfy_extras':types.ModuleType('comfy_extras'),native.__name__:native}
            with patch.dict(sys.modules,modules),patch('sam3d_funscript.video.predict_rgb',side_effect=predict),patch('sam3d_funscript.video._preview_frame',None),patch('sam3d_funscript.video.mouth_regressor',return_value=None):
                for _ in range(2):predict_frame(current,0,'model',[[0,0,1,1]],include_mesh=True)
                predict_frame(current,0,'model',[[0,0,1,1]],include_mesh=False)
                self.assertEqual(len(calls),1)
                predict_frame(current,240,'model',[[0,0,1,1]],include_mesh=True)
                self.assertEqual(len(calls),2)
                predict_frame(current,240,'model',[[0,0,.5,1]],include_mesh=True)
                self.assertEqual(len(calls),3)
                predict_frame(current,240,'model',[[0,0,.5,1]],include_mesh=True,use_cache=False)
                self.assertEqual(len(calls),4)
                with self.assertRaisesRegex(ValueError,'exact anchor preview frame'):
                    predict_frame(current,241,'model',[[0,0,.5,1]])
                self.assertEqual(len(calls),4)


class PreviewNodeTests(unittest.TestCase):
    def test_queue_preview_blocks_downstream_and_preserves_motion_state_even_on_failure(self):
        node=load_node_module()
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);current=info();session='c'*32
            store=ProcessingStore(root/'sam3d_funscript'/'processing')
            state=store.prepare(session,current,{'tracking':[region('t')]})
            state.update(project='authored',project_path='do-not-load.json',result_current=True,report={'authored':True},editor_session='d'*32)
            store.write(state)
            graph=types.ModuleType('comfy_execution.graph')
            class Blocker:
                def __init__(self,value):self.value=value
            graph.ExecutionBlocker=Blocker
            management=types.ModuleType('comfy.model_management');management.throw_exception_if_processing_interrupted=lambda:None
            management.InterruptProcessingException=type('Interrupted',(Exception,),{})
            server=types.ModuleType('server');server.PromptServer=types.SimpleNamespace(instance=types.SimpleNamespace(send_sync=lambda *args:None))
            node.folder_paths.get_output_directory=lambda:str(root)
            request={'region_id':'t','at_ms':100}
            kwargs=dict(video=object(),model_file='model',operation='preview_anchor',unique_id='1',
                plan_json={'revision':state['revision'],'plan':state['plan'],'anchor_preview':request},
                extra_pnginfo={'workflow':{'nodes':[{'id':1,'properties':{'s3f_timeline_session':session}}]}})
            module=importlib.import_module(node.__package__+'.sam3d_funscript.anchor_preview')
            with patch.dict(sys.modules,{'comfy_execution.graph':graph,'comfy.model_management':management,'server':server}), \
                 patch.object(node,'video_input_range',return_value=('source',0,0)),patch.object(node,'source_info',return_value=current), \
                 patch.object(node,'bind_motion_editor',side_effect=AssertionError('No motion session change')), \
                 patch.object(node,'publish_motion',side_effect=AssertionError('No motion export')), \
                 patch.object(module,'preview_anchor',return_value={'frame':3,'anchors':[{}]}) as worker:
                result=node.S3F_ProcessingTimeline().run(**kwargs)
                self.assertIsInstance(result['result'][0],Blocker)
                self.assertEqual(result['ui']['s3f_anchor_preview'][0]['frame'],3)
                self.assertEqual(worker.call_args.args[2],request)
                self.assertEqual(store.read(session),state)
                worker.side_effect=ValueError('Preview cancelled')
                with self.assertRaisesRegex(ValueError,'cancelled'):node.S3F_ProcessingTimeline().run(**kwargs)
                self.assertEqual(store.read(session),state)
