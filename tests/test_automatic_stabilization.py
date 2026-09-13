from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import numpy as np

from sam3d_funscript.automatic import prepare_mask_references, run_prepared_stabilization
from sam3d_funscript.processing_timeline import normalize_plan, run_timeline
from sam3d_funscript.reference_mask import raster_mask
from test_processing_timeline import info, region, fake_extract


class AutomaticStabilizationTests(unittest.TestCase):
    def setUp(self):
        self.info=info()
        self.mask={'frame':3,'spacing':8,'limit':20,'strokes':[
            {'erase':False,'radius':20,'points':[[50,50],[90,50]]},
            {'erase':True,'radius':7,'points':[[70,50]]}]}
        self.plan=normalize_plan({'tracking':[
            region('a',0,2000,automatic={'version':1,'suggest':True,'people':[],'review':[]}),
            region('b',2000,4000,automatic={'version':1,'suggest':True,'people':[],'review':[]})],
            'stabilization':[region('s',0,2000,reference={'point_mask':self.mask,'transform_mode':'similarity'})],
            'selection':[2100,2200]},self.info)

    def test_painted_only_section_gets_points_on_its_seed_frame_and_preserves_plan(self):
        before=deepcopy(self.plan)
        prepared,report=prepare_mask_references(self.info,self.plan)
        reference=prepared['stabilization'][0]['reference']
        self.assertEqual(self.plan,before)
        self.assertEqual(report,{'regions':['s'],'errors':{}})
        self.assertEqual(reference['keyframes'],[{'frame':3,'points':reference['points']}])
        self.assertEqual(len(reference['points']),20)
        mask=raster_mask(self.mask,320,240)
        for x,y in reference['points']:self.assertEqual(mask[round(y),round(x)],255)
        self.assertEqual(prepared['selection'],before['selection'])
        self.assertEqual(normalize_plan(prepared,self.info),prepared)
        again,_=prepare_mask_references(self.info,prepared)
        self.assertEqual(again,prepared)
        # Repainting regenerates untouched generated points, preserving seed time.
        prepared['stabilization'][0]['reference']['point_mask']['strokes'][0]['points']=[[140,60],[180,60]]
        changed,_=prepare_mask_references(self.info,prepared)
        self.assertNotEqual(changed['stabilization'][0]['reference']['points'],reference['points'])

    def test_manual_points_keys_locks_and_disabled_sections_are_kept(self):
        prepared,_=prepare_mask_references(self.info,self.plan)
        reference=prepared['stabilization'][0]['reference']
        reference['keyframes'][0]['points'][0][0]+=1
        reference['points']=deepcopy(reference['keyframes'][0]['points'])
        reference['keyframes'].append({'frame':10,'points':deepcopy(reference['points'])})
        reference['point_mask']['spacing']=4
        again,_=prepare_mask_references(self.info,prepared)
        self.assertEqual(again,prepared,'manual edits detach the automatic point generator')
        for flag in ('locked','enabled'):
            plan=deepcopy(self.plan);plan['stabilization'][0][flag]=flag=='locked'
            result,_=prepare_mask_references(self.info,plan)
            self.assertEqual(result,plan)

    def test_erased_mask_is_flagged_without_generating_a_fake_reference(self):
        self.plan['stabilization'][0]['reference']['point_mask']['strokes'].append(
            {'erase':True,'radius':100,'points':[[70,50]]})
        prepared,report=prepare_mask_references(self.info,self.plan)
        self.assertIn('Paint a larger',report['errors']['s'])

    def test_paint_at_next_scene_boundary_does_not_prepare_for_previous_scene(self):
        self.plan['tracking']=self.plan['tracking'][:1]
        self.plan['stabilization'][0]['start_ms']=1999.9999997
        self.plan['stabilization'][0]['end_ms']=4000
        prepared,report=prepare_mask_references(self.info,self.plan)
        self.assertEqual(report,{'regions':[],'errors':{}})
        self.assertEqual(prepared,self.plan)
        self.assertFalse(prepared['stabilization'][0]['reference']['points'])

    def test_propagation_then_tracking_continue_after_section_failure_and_cancel_propagates(self):
        self.plan['stabilization'].append(region('next',2000,4000,enabled=True,locked=False,reference=deepcopy(self.plan['stabilization'][0]['reference'])))
        plan,prepared=prepare_mask_references(self.info,self.plan)
        order=[]
        def masks(*args,**kwargs):
            sid=kwargs['region_ids'][0];order.append(('mask',sid))
            if sid=='s':raise ValueError('Mask lost')
        def track(*args,**kwargs):
            sid=kwargs['region_ids'][0];order.append(('track',sid))
            return {'regions':[{'id':sid,'frames':10,'held_frames':2}]}
        with patch('sam3d_funscript.processing_timeline.run_mask_propagation',side_effect=masks), \
             patch('sam3d_funscript.processing_timeline.run_stabilization',side_effect=track):
            report=run_prepared_stabilization(self.info,plan,'unused','tracker',prepared)
            self.assertEqual(order,[('mask','s'),('mask','next'),('track','next')])
            self.assertEqual(report['errors'],{'s':'Mask lost'})
            self.assertIn('2 / 10',report['review']['next'])
        class Cancelled(BaseException):pass
        with patch('sam3d_funscript.processing_timeline.run_mask_propagation',side_effect=Cancelled), \
             patch('sam3d_funscript.processing_timeline.run_stabilization') as tracker:
            with self.assertRaises(Cancelled):run_prepared_stabilization(self.info,plan,'unused','tracker',prepared)
            tracker.assert_not_called()

    def test_all_held_reference_is_flagged_and_locked_reference_skips_propagation(self):
        plan,prepared=prepare_mask_references(self.info,self.plan)
        plan['stabilization'][0]['locked']=True
        with patch('sam3d_funscript.processing_timeline.run_mask_propagation') as masks, \
             patch('sam3d_funscript.processing_timeline.run_stabilization',return_value={'regions':[{'id':'s','frames':5,'held_frames':5}]}):
            report=run_prepared_stabilization(self.info,plan,'unused','tracker',prepared)
        masks.assert_not_called()
        self.assertIn('No reliable',report['errors']['s'])

    def test_failed_stabilization_skips_its_poses_while_other_scenes_complete(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);model=root/'model';model.write_bytes(b'fixture')
            with patch('sam3d_funscript.processing_timeline.extract_video',side_effect=fake_extract) as extract, \
                 patch('sam3d_funscript.processing_timeline._stabilize_region',side_effect=AssertionError('Failed reference must not run again')):
                project,report=run_timeline(self.info,self.plan,root,str(model),stabilization_errors={'s':'Mask lost'})
            self.assertEqual(extract.call_count,1)
            self.assertGreaterEqual(extract.call_args.kwargs['start_seconds'],2)
            self.assertEqual(report['regions'][0]['state'],'error')
            self.assertIn('Mask lost',report['regions'][0]['review'][0])
            self.assertEqual(report['regions'][1]['state'],'complete')
            self.assertEqual(len(project['timeline']['sources']),1)
