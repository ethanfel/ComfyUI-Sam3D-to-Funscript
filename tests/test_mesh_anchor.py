"""Fixed mesh identity, camera projection, persisted poses and chunk integration."""
from copy import deepcopy
import json
from pathlib import Path
import tempfile
import types
import sys
import unittest
from unittest.mock import patch

import numpy as np

from sam3d_funscript.mesh_anchor import bind_patch, patch_position, prepare_patch, seed_time
from sam3d_funscript.core import PoseSequence, build_project
from sam3d_funscript.processing_timeline import normalize_plan, run_timeline
from sam3d_funscript.reference import source_info
from sam3d_funscript.video import extract_video
from test_core import fixture
from test_processing_timeline import fake_extract, info, region
from test_masks import write_video


def mesh_person():
    front = np.array([[-.4,-.4,2],[.4,-.4,2],[.4,.4,2],[-.4,.4,2]])
    return {"pred_vertices": np.concatenate([front, front*1.5]), "pred_cam_t": np.array([0.,0.,0.]),
            "focal_length": 100., "pred_keypoints_3d": np.zeros((70,3)), "pred_keypoints_2d": np.ones((70,2))*50}


FACES = np.array([[0,1,2],[0,2,3],[4,5,6],[4,6,7]])
PAINT = {"frame": 0, "strokes": [{"erase": False, "radius": 40, "points": [[50,50]]}]}


class GeometryTests(unittest.TestCase):
    def test_visible_surface_only_and_fixed_identity_after_motion(self):
        person=mesh_person()
        bound=bind_patch(person,FACES,PAINT,(100,100))
        self.assertEqual(bound["vertices"],[0,1,2,3], "back surface must not contribute")
        person["pred_vertices"][:4] += [.3,.1,.2]
        person["pred_vertices"][4:] += [10,20,30]
        person["pred_cam_t"] = np.array([.5,.2,1])
        position,pixels=patch_position(person,bound,(100,100))
        np.testing.assert_allclose(position,[.8,.3,3.2])
        np.testing.assert_allclose(pixels,[75,59.375])
        person["pred_vertices"]=person["pred_vertices"][:-1]
        with self.assertRaisesRegex(ValueError,"topology changed"):
            patch_position(person,bound,(100,100))

    def test_erase_background_and_empty_paint_fail_without_fallback(self):
        paint=deepcopy(PAINT)
        paint["strokes"].append({"erase":True,"radius":4,"points":[[30,30]]})
        self.assertEqual(bind_patch(mesh_person(),FACES,paint,(100,100))["vertices"],[1,2,3])
        paint["strokes"].append({"erase":True,"radius":4,"points":[[70,30]]})
        with self.assertRaisesRegex(ValueError,"fewer than three"):
            bind_patch(mesh_person(),FACES,paint,(100,100))
        with self.assertRaisesRegex(ValueError,"Paint a body area"):
            bind_patch(mesh_person(),FACES,{"frame":0,"strokes":[]},(100,100))

    def test_seed_uses_original_variable_frame_clock_and_exclusive_bounds(self):
        index={"first_frame":20,"times_ms":[1000,1041.666666,1100,1120,1200]}
        self.assertEqual(seed_time(region(start=1041.666666,end=1200,mask_anchor={"frame":2}),index),1120)
        with self.assertRaisesRegex(ValueError,"outside"):
            seed_time(region(start=1041.666666,end=1200,mask_anchor={"frame":3}),index)

    def test_custom_anchor_roundtrip_and_clear_missing_cache_error(self):
        sequence=fixture(73)
        sequence.points[:,0,72,0]=np.sin(sequence.times_ms/100)*.1
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'poses.npz';sequence.save(path)
            project=build_project(PoseSequence.load(path),{"target_anchor":"mask_anchor"})
        self.assertEqual(project["anchor_indices"]["target"],[72])
        self.assertEqual(set(project["scripts"]),{"L0","L1","L2","R0","R1","R2"})
        with self.assertRaisesRegex(ValueError,"no painted mask anchor"):
            build_project(fixture(72),{"target_anchor":"mask_anchor"})
        sequence.points[:,1,72]=np.nan
        with self.assertRaisesRegex(ValueError,"no painted mask anchor"):
            build_project(sequence,{"target_anchor":"mask_anchor","target_person":1})


class PipelineTests(unittest.TestCase):
    def test_one_patch_shared_across_chunks_extras_resume_and_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);model=root/'model.bin';model.write_bytes(b'fixture')
            current=info();bound={"vertices":[0,1,2],"vertex_count":8,"person":0}
            calls=[]
            def extract(*args,**kwargs):
                calls.append(kwargs["mesh_anchor"])
                sequence=fake_extract(*args,**kwargs)
                sequence.points=np.concatenate([sequence.points,sequence.points[:,:,:1]],axis=2)
                sequence.pixels=np.concatenate([sequence.pixels,sequence.pixels[:,:,:1]],axis=2)
                return sequence
            plan={"chunk_seconds":1,"tracking":[region(anchor="mask_anchor",mask_anchor=PAINT,additional_anchors=["mouth"])]}
            with patch('sam3d_funscript.processing_timeline.extract_video',side_effect=extract),patch('sam3d_funscript.processing_timeline.prepare_patch',return_value=bound) as prepare:
                project,_=run_timeline(current,plan,root,str(model))
                self.assertEqual(prepare.call_count,1)
                self.assertEqual(len(calls),4)
                self.assertTrue(all(c is bound for c in calls))
                self.assertEqual([s['data']['config']['target_anchor'] for s in project['timeline']['sources']],["mask_anchor","mouth"])
                run_timeline(current,plan,root,str(model),operation='unfinished')
                self.assertEqual(len(calls),4)
                plan['tracking'][0]['locked']=True
                plan['tracking'][0]['mask_anchor']={"frame":1,"strokes":[]}
                retained,_=run_timeline(current,plan,root,str(model),use_cache=False)
                self.assertEqual(retained['scripts'],project['scripts'])
                self.assertEqual(prepare.call_count,1)
                plan['tracking'][0]['locked']=False
                run_timeline(current,plan,root,str(model))
                self.assertEqual(prepare.call_count,2)
                self.assertEqual(len(calls),8)

    def test_normalizer_preserves_paint_rejects_invalid_coordinates(self):
        plan=normalize_plan({"tracking":[region(anchor='mask_anchor',mask_anchor=PAINT)]},info())
        self.assertEqual(plan['tracking'][0]['mask_anchor'],PAINT)
        wrong=deepcopy(PAINT);wrong['strokes'][0]['points']=[[1000,20]]
        with self.assertRaisesRegex(ValueError,'inside the source'):
            normalize_plan({"tracking":[region(anchor='mask_anchor',mask_anchor=wrong)]},info())

    def test_seed_binding_and_streamed_extraction_cache_without_full_mesh_storage(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);source=root/'source.mp4';write_video(source)
            current=source_info(source);h,w=current['height'],current['width']
            paint={"frame":1,"strokes":[{"erase":False,"radius":100,"points":[[w/2,h/2]]}]}
            r=region(start=0,end=current['end_ms'],anchor='mask_anchor',person=0,rois=[[0,0,1,1]],mask_anchor=paint)
            class Loader:
                @classmethod
                def execute(cls,_):return types.SimpleNamespace(result=[types.SimpleNamespace(model=types.SimpleNamespace(head_pose=types.SimpleNamespace(faces_np=lambda:FACES)))])
            class Predictor:pass
            Predictor.__module__='comfy_extras.nodes_sam3d_body'
            modules={name:types.ModuleType(name) for name in ['folder_paths','comfy','comfy.model_management','comfy_extras','comfy_extras.nodes_sam3d_body']}
            modules['folder_paths'].get_full_path_or_raise=lambda *args:__file__
            modules['comfy'].model_management=modules['comfy.model_management']
            modules['comfy.model_management'].throw_exception_if_processing_interrupted=lambda:None
            native=modules['comfy_extras.nodes_sam3d_body'];native.__file__=__file__;native.SAM3DBody_Loader=Loader;native.SAM3DBody_Predict=Predictor
            def predict(model,images,boxes,**kwargs):
                self.assertTrue(kwargs['include_mesh'])
                people=[]
                for i in range(len(images)):
                    person=mesh_person();person['focal_length']=20.
                    people.append([person])
                return people
            with patch.dict(sys.modules,modules),patch('sam3d_funscript.video.predict_rgb',side_effect=predict) as streamed,patch('sam3d_funscript.video.mouth_regressor',return_value=None):
                bound=prepare_patch(current,r,'test',root)
                self.assertEqual(bound['vertices'],[0,1,2,3])
                cached=prepare_patch(current,r,'test',root)
                self.assertEqual(streamed.call_count,1)
                self.assertEqual(cached,bound)
                streamed.reset_mock()
                sequence=extract_video(source,'test',root/'poses',sample_fps=0,batch_size=2,mesh_anchor=bound)
                self.assertEqual(sequence.points.shape[2],73)
                np.testing.assert_allclose(sequence.points[:,0,72],np.tile([0,0,2],(len(sequence.times_ms),1)))
                self.assertNotIn('pred_vertices',json.dumps(sequence.metadata))
                calls=streamed.call_count
                extract_video(source,'test',root/'poses',sample_fps=0,batch_size=2,mesh_anchor=bound)
                self.assertEqual(streamed.call_count,calls)
                changed={**bound,'vertices':[1,2,3]}
                moved=extract_video(source,'test',root/'poses',sample_fps=0,batch_size=2,mesh_anchor=changed)
                self.assertGreater(streamed.call_count,calls)
                self.assertFalse(np.allclose(moved.points[:,0,72],sequence.points[:,0,72]))
                streamed.reset_mock()
                isolated = prepare_patch(current,{**r,'isolate_subject':True},'test',root)
                self.assertEqual(streamed.call_count,1,'crop setting invalidates the painted seed binding')
                self.assertTrue(streamed.call_args.kwargs['isolate_subject'])
                prepare_patch(current,{**r,'isolate_subject':True},'test',root)
                self.assertEqual(streamed.call_count,1)
                streamed.reset_mock()
                extract_video(source,'test',root/'poses',sample_fps=0,batch_size=2,mesh_anchor=isolated,isolate_subject=True)
                self.assertGreater(streamed.call_count,0)
                self.assertTrue(all(c.kwargs['isolate_subject'] for c in streamed.call_args_list))
                calls=streamed.call_count
                extract_video(source,'test',root/'poses',sample_fps=0,batch_size=2,mesh_anchor=isolated,isolate_subject=True)
                self.assertEqual(streamed.call_count,calls)
