from fractions import Fraction
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import av
import cv2
import numpy as np

from sam3d_funscript.stabilization import similarities, transform_points, inverse_transforms
from sam3d_funscript.reference import run_reference, decode, config_for_source, tracking_key
from sam3d_funscript.reference_preview import reference_preview
from sam3d_funscript.processing_timeline import _stabilized_rois, _original_sequence
from test_processing_timeline import info, fake_extract


POINTS = np.array([[30,30],[60,25],[90,30],[30,70],[60,70],[90,70]], float)


def motion(angle=0, scale=1, dx=0, dy=0):
    value = cv2.getRotationMatrix2D((60,50), angle, scale)
    value[:,2] += [dx,dy]
    return value


class SimilarityTests(unittest.TestCase):
    def test_rotation_scale_outlier_and_visibility_keep_the_same_reference(self):
        expected = np.array([motion(),motion(8,1.1,3,2),motion(16,1.2,6,4)])
        points = transform_points(POINTS,expected)
        visible = np.ones(points.shape[:2],bool)
        points[1,-1] += [70,-50]
        visible[2,0] = False
        result,valid,counts,_,reasons = similarities(points,visible,tolerance=1)
        self.assertTrue(valid.all())
        self.assertEqual(counts.tolist(),[6,5,5])
        self.assertEqual(reasons,['consensus']*3)
        np.testing.assert_allclose(result,inverse_transforms(expected),atol=1e-5)

    def test_gaps_hold_rotation_and_scale_and_reacquisition_uses_elapsed_time(self):
        expected = np.array([motion(),motion(5,1.05,4),motion(10,1.1,8),motion(15,1.15,12)])
        points = transform_points(POINTS,expected)
        visible = np.ones(points.shape[:2],bool);visible[1:3] = False
        result,valid,_,_,reasons = similarities(points,visible,tolerance=1,max_step=12)
        self.assertEqual(valid.tolist(),[True,False,False,True])
        np.testing.assert_array_equal(result[1:3],np.tile(result[0],(2,1,1)))
        np.testing.assert_allclose(result[-1],inverse_transforms(expected[-1]),atol=1e-5)
        self.assertEqual(reasons[1],'insufficient_visible_points')
        jumped = transform_points(POINTS,np.array([motion(),motion(80,2,100)]))
        held,valid,_,_,reasons = similarities(jumped,np.ones((2,6),bool),max_step=10)
        self.assertFalse(valid[1]);self.assertEqual(reasons[1],'large_jump_needs_review')
        np.testing.assert_array_equal(held[0],held[1])

    def test_extreme_scale_and_degenerate_points_are_reviewable(self):
        points = transform_points(POINTS,np.array([motion(),motion(scale=5)]))
        _,valid,_,_,reasons = similarities(points,np.ones((2,6),bool),max_step=10000)
        self.assertFalse(valid[1]);self.assertEqual(reasons[1],'scale_needs_review')
        close = np.tile(np.array([[10,10],[10.1,10],[10,10.1]]),(2,1,1))
        _,valid,_,_,reasons = similarities(close,np.ones((2,3),bool))
        self.assertFalse(valid.any());self.assertEqual(reasons,['reference_points_too_close']*2)

    def test_reference_can_be_a_middle_frame(self):
        matrices = np.array([motion(-15,.9),motion(),motion(15,1.1)])
        points = transform_points(POINTS,matrices)
        result,valid,*_ = similarities(points,np.ones((3,6),bool),reference=POINTS,marked_frames=[1],tolerance=1)
        self.assertTrue(valid.all())
        np.testing.assert_allclose(transform_points(points,result),np.broadcast_to(POINTS,points.shape),atol=1e-5)

    def test_crops_and_pose_overlays_map_back_through_rotation_and_scale(self):
        current = info()
        sequence = fake_extract('source','model','cache',start_seconds=0,duration_seconds=.12,rois_json=[[0,0,1,1]])
        originals = sequence.pixels.copy()
        transforms = np.array([motion(),motion(20,1.2,10,20),motion(-10,.8,-5,4)])
        pad = [120,120]
        sequence.pixels = (transform_points(originals.reshape(3,-1,2),transforms)+pad).reshape(originals.shape)
        manifest = {'data':{'times_ms':[0,40,80],'source_times_ms':[1000,1040,1080],
                            'source_pts':['1','26/25','27/25'],'transform_xy':transforms.tolist()},
                    'video':{'padding_xy':pad,'size_wh':[560,480]}}
        result = _original_sequence(sequence,current,manifest)
        np.testing.assert_allclose(result.pixels,originals)
        self.assertEqual(result.times_ms.tolist(),[1000,1040,1080])
        roi = [.2,.2,.2,.2]
        cropped = _stabilized_rois([roi],current,manifest,1000,1080)[0]
        corners = np.array([[.2,.2],[.4,.2],[.2,.4],[.4,.4]])*[320,240]
        mapped = transform_points(corners,transforms)+pad
        lo = np.array(cropped[:2])*[560,480]
        hi = (np.array(cropped[:2])+cropped[2:])*[560,480]
        self.assertTrue((mapped>=lo-1e-7).all());self.assertTrue((mapped<=hi+1e-7).all())

    def test_real_render_locks_landmarks_preserves_pts_and_reuses_tracks_on_mode_change(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);source=root/'source.mkv';checkpoint=root/'tracker.pth';checkpoint.write_bytes(b'test')
            matrices=np.array([motion(),motion(8,1.08,2,1),motion(16,1.16,4,2)])
            base=np.zeros((128,128,3),np.uint8)
            for p in POINTS:cv2.circle(base,tuple(p.astype(int)),4,(255,255,255),-1)
            with av.open(str(source),'w') as container:
                stream=container.add_stream('ffv1',rate=25);stream.width=stream.height=128;stream.pix_fmt='bgr0'
                stream.time_base=stream.codec_context.time_base=Fraction(1,1000)
                for pts,matrix in zip([0,40,100],matrices):
                    rgb=cv2.warpAffine(base,matrix,(128,128))
                    frame=av.VideoFrame.from_ndarray(rgb,format='bgr24');frame.pts=pts;frame.time_base=Fraction(1,1000)
                    for packet in stream.encode(frame):container.mux(packet)
                for packet in stream.encode():container.mux(packet)
            def track(current,config,checkpoint,destination,*args):
                rows=list(decode(current))
                np.savez_compressed(destination,points=transform_points(POINTS,matrices),visible=np.ones((3,6),bool),
                    source_times_ms=[float(r[2]*1000) for r in rows],metadata=json.dumps({'source_pts':[str(r[1]) for r in rows]}))
            config={'points':POINTS.tolist()}
            with patch('sam3d_funscript.reference.track',side_effect=track) as tracker:
                first,_=run_reference(source,0,0,config,checkpoint,root/'runs',tolerance=1)
                config['transform_mode']='similarity'
                corrected,path=run_reference(source,0,0,config,checkpoint,root/'runs',tolerance=1)
                self.assertEqual(tracker.call_count,1)
                self.assertNotEqual(first['id'],corrected['id'])
                self.assertEqual(corrected['data']['quality'],['tracked']*3)
                preview=reference_preview({'path':str(path)})
                self.assertEqual(preview['transform_xy'],corrected['data']['transform_xy'])
                pad=np.array(corrected['video']['padding_xy'])
                with av.open(str(path)) as container:
                    frames=list(container.decode(video=0))
                self.assertEqual([f.pts*f.time_base for f in frames],[Fraction(0),Fraction(1,25),Fraction(1,10)])
                for frame in frames:
                    image=frame.to_ndarray(format='gray')
                    for x,y in (POINTS+pad).astype(int):self.assertGreater(int(image[y,x]),200)
                with patch('sam3d_funscript.reference.analyze',side_effect=AssertionError('Reuse current render')):
                    repeated,_=run_reference(source,0,0,config,checkpoint,root/'runs',tolerance=1)
                self.assertEqual(repeated['id'],corrected['id'])
                # Manual centers affect translation without discarding estimated scale/angle.
                config['sections']=[{'keys':[{'at_ms':40,'xy':[65,55]}]}]
                edited,_=run_reference(source,0,0,config,checkpoint,root/'runs',tolerance=1)
                np.testing.assert_allclose(np.array(edited['data']['transform_xy'])[:,:,:2],np.array(corrected['data']['transform_xy'])[:,:,:2])
                np.testing.assert_allclose(transform_points([[65,55]],edited['data']['transform_xy'][1])[0],edited['data']['anchor_xy'])

    def test_invalid_mode_is_rejected_and_mode_does_not_invalidate_tracking(self):
        with tempfile.TemporaryDirectory() as folder:
            checkpoint=Path(folder)/'tracker';checkpoint.write_bytes(b'test')
            current=info()
            a,_=config_for_source({'points':POINTS.tolist()},current)
            b,_=config_for_source({**a,'transform_mode':'similarity'},current)
            self.assertEqual(tracking_key(current,a,checkpoint),tracking_key(current,b,checkpoint))
            with self.assertRaisesRegex(ValueError,'correction'):
                config_for_source({**a,'transform_mode':'affine'},current)
