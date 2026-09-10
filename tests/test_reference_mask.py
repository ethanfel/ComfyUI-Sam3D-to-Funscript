from copy import deepcopy
from fractions import Fraction
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import cv2
import numpy as np
from sam3d_funscript.reference_mask import normalize_mask, raster_mask, mask_geometry, MaskReader
from sam3d_funscript.reference import atomic_json, analyze, config_for_source
from sam3d_funscript.reference_keyframes import validate_keys
from sam3d_funscript.processing_timeline import run_mask_propagation, current_reference_mask, normalize_plan
from test_processing_timeline import info, region


class ReferenceMaskTests(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup);self.root=Path(temp.name)
        self.info=info()
        self.mask=normalize_mask({'frame':2,'strokes':[{'erase':False,'radius':15,'points':[[20,20],[70,20]]}, {'erase':True,'radius':6,'points':[[40,20]]}]},320,240)

    def test_raster_and_config_roundtrip_preserve_mask_and_unconfirmed_points(self):
        pixels=raster_mask(self.mask,320,240)
        self.assertEqual(int(pixels[20,20]),255);self.assertEqual(int(pixels[20,40]),0)
        reference={'point_mask':self.mask,'keyframes':[{'frame':2,'points':[[20,20],[30,20],[50,20]],'unconfirmed':[1]}]}
        saved,_=config_for_source(reference,self.info)
        self.assertEqual(saved['point_mask'],self.mask);self.assertEqual(saved['keyframes'],reference['keyframes'])
        with self.assertRaisesRegex(ValueError,'unconfirmed'):validate_keys(saved['keyframes'])
        other={**self.mask,'spacing':99,'limit':80}
        self.assertEqual(mask_geometry(other),mask_geometry(self.mask))

    def test_mask_job_targets_full_region_and_preserves_existing_motion(self):
        reference={'point_mask':self.mask}
        plan={'tracking':[],'stabilization':[region('s',1000,2000,reference=reference)],'selection':[2200,2300]}
        resultdir=self.root/'results'/self.info['source_id'];resultdir.mkdir(parents=True)
        before={'regions':{'keep':'poses'},'stabilization':{'keep':'render'},'source_id':self.info['source_id']}
        atomic_json(resultdir/'state.json',before)
        def fake_propagate(clip,mask,root,*args):
            self.assertEqual(clip['start'],'1');self.assertEqual(clip['duration'],'1')
            p=root/('a'*24)/'mask.json'
            p.parent.mkdir(parents=True);atomic_json(p,{'id':'a'*24,'frames':[[0,1]]*30});return p
        with patch('sam3d_funscript.processing_timeline.source_info',side_effect=lambda path,start,duration:{**self.info,'start':str(start),'duration':str(duration)}), \
             patch('sam3d_funscript.reference_mask.propagate_mask',side_effect=fake_propagate) as propagate, \
             patch('sam3d_funscript.processing_timeline.run_reference',side_effect=AssertionError('No CoTracker')), \
             patch('sam3d_funscript.processing_timeline.extract_video',side_effect=AssertionError('No SAM3D')):
            report=run_mask_propagation(self.info,plan,self.root,region_ids=['s'])
            saved=json.loads((resultdir/'state.json').read_text());self.assertEqual(report['completed_jobs'],1)
            for k in before:self.assertEqual(saved[k],before[k])
            normalized=normalize_plan(plan,self.info)['stabilization'][0]
            self.assertEqual(current_reference_mask(normalized,saved)['id'],'a'*24)
            normalized['reference']['point_mask']['spacing']=20
            self.assertIsNotNone(current_reference_mask(normalized,saved))
            normalized['reference']['point_mask']['strokes'][0]['radius']=22
            with self.assertRaisesRegex(ValueError,'Propagate'):current_reference_mask(normalized,saved)
            # Errors never replace a previous successful mask or motion results.
            original=(resultdir/'state.json').read_bytes();propagate.side_effect=RuntimeError('cancelled')
            with self.assertRaisesRegex(RuntimeError,'cancelled'):run_mask_propagation(self.info,plan,self.root,region_ids=['s'])
            self.assertEqual((resultdir/'state.json').read_bytes(),original)
            plan['stabilization'][0]['locked']=True
            run_mask_propagation(self.info,plan,self.root,region_ids=['s'],use_cache=False)
            self.assertEqual((resultdir/'state.json').read_bytes(),original)

    def test_visibility_is_filtered_using_matching_source_frames(self):
        points=np.array([[[20,20],[25,20],[30,20]],[[21,20],[26,20],[31,20]]],float)
        cache=self.root/'tracks.npz';metadata={'source_pts':['0','1/30']}
        np.savez(cache,points=points,visible=np.ones((2,3),bool),source_times_ms=[0,1000/30],metadata=json.dumps(metadata))
        p=self.root/'mask.json';offsets=[]
        with (self.root/'packed.bin').open('wb') as out:
            for full in (True,False):
                pixels=np.full((240,320),255 if full else 0,np.uint8);ok,png=cv2.imencode('.png',pixels)
                offsets.append([out.tell(),len(png)]);out.write(png.tobytes())
        manifest={'info':self.info,'frames':offsets,'data_file':'packed.bin','source_pts':metadata['source_pts']}
        atomic_json(p,manifest)
        config={'crop_xywh':[0,0,320,240],'points':points[0].tolist(),'sections':[]}
        unmasked=analyze(cache,self.info,config)
        self.assertEqual(unmasked['quality'],['tracked','tracked'])
        masked=analyze(cache,self.info,config,reference_masks={'manifest_path':str(p)})
        self.assertEqual(masked['quality'],['tracked','held']);self.assertEqual(masked['reasons'][1],'outside_reference_mask')
        self.assertEqual(masked['visible'][1],[False]*3)
        manifest['source_pts']=['0','1/25'];atomic_json(p,manifest)
        with self.assertRaisesRegex(ValueError,'timing'):analyze(cache,self.info,config,reference_masks={'manifest_path':str(p)})

if __name__=='__main__':unittest.main()
