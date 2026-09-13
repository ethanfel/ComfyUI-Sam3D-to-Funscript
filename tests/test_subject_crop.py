import json
import sys
import types
import unittest
from unittest.mock import Mock, patch

import numpy as np
import torch

from sam3d_funscript.inference import isolate_rgb, predict_rgb
from sam3d_funscript.video import parse_rois


class RoiTests(unittest.TestCase):
    def test_nonempty_roi_lists_have_no_person_limit(self):
        boxes = [[i/20, 0, .04, 1] for i in range(20)]
        self.assertEqual(parse_rois(boxes), boxes)
        self.assertEqual(parse_rois(json.dumps(boxes)), boxes)

    def test_invalid_rectangles_still_fail_validation(self):
        for value in ([], None, {}, 'null', [None], [1], ['1234'], [[0,0,1]],
                      [[False,0,1,1]], [[0,0,float('nan'),1]], [[0,0,float('inf'),1]],
                      [[-.1,0,1,1]], [[0,0,0,1]], [[0,0,1,-1]], [[.5,0,.6,1]]):
            with self.subTest(value=value), self.assertRaises(ValueError):
                parse_rois(value)


class SubjectCropTests(unittest.TestCase):
    def test_crowded_frame_keeps_all_people_and_meshes_within_forward_budget(self):
        modules = {name: types.ModuleType(name) for name in (
            'comfy', 'comfy.model_management', 'comfy.utils', 'comfy.ldm',
            'comfy.ldm.sam3d_body', 'comfy.ldm.sam3d_body.utils',
            'comfy_extras', 'comfy_extras.sam3d_body', 'comfy_extras.sam3d_body.utils')}
        modules['comfy'].utils = modules['comfy.utils']
        management = modules['comfy.model_management']
        modules['comfy'].model_management = management
        modules['comfy.utils'].ProgressBar = lambda _: types.SimpleNamespace(update=lambda _: None)
        management.throw_exception_if_processing_interrupted = Mock()
        management.load_models_gpu = Mock()
        management.get_torch_device = lambda: torch.device('cpu')
        camera = torch.eye(3)
        camera_from_fov = Mock(return_value=camera)
        modules['comfy_extras.sam3d_body.utils'].cam_int_from_fov = camera_from_fov
        modules['comfy_extras.sam3d_body.utils'].inputs_from_sam3_track = Mock(side_effect=AssertionError('No masks requested'))
        image = np.full((4,40,3), 100, np.uint8)
        boxes = [{'x':i*2,'y':0,'width':2,'height':4} for i in range(17)]
        prepared_counts, forward_counts = [], []

        def prepare(inputs, crop_boxes, **kwargs):
            prepared_counts.append(len(inputs))
            self.assertIs(kwargs['cam_int'], camera)
            for rgb, (x1,y1,x2,y2) in zip(inputs, crop_boxes.int().tolist()):
                expected = np.zeros_like(image)
                expected[y1:y2,x1:x2] = 100
                np.testing.assert_array_equal(rgb.numpy(), expected)
            # Carry each crop's x coordinate through the model to verify order.
            return {'crop_ids':crop_boxes[None,:,0:1], 'cam_int':camera}

        def infer(rgb, batch, inference_type):
            ids = batch['crop_ids'][0]
            forward_counts.append(len(ids))
            self.assertEqual(inference_type, 'body')
            return {'mhr':{
                'pred_keypoints_3d':ids[:,:,None].repeat(1,70,3),
                'pred_keypoints_2d':ids[:,:,None].repeat(1,70,2),
                'pred_cam_t':ids.repeat(1,3), 'focal_length':ids[:,0],
                'pred_face_keypoints_3d':ids[:,:,None].repeat(1,68,3),
                'pred_vertices':ids[:,:,None].repeat(1,10,3)}}

        modules['comfy.ldm.sam3d_body.utils'].prepare_batch = prepare
        memory = Mock(side_effect=lambda count, _: count)
        model = types.SimpleNamespace(model=types.SimpleNamespace(
            image_size=512, memory_used_forward=memory, run_inference=infer))
        timings = {}
        with patch.dict(sys.modules, modules):
            result = predict_rgb(model,[image],boxes,batch_size=4,fov=55,timings=timings,
                                 include_mesh=True,isolate_subject=True)
        self.assertEqual(prepared_counts,[4,4,4,4,1])
        self.assertEqual(forward_counts,prepared_counts)
        self.assertEqual([call.args[0] for call in memory.call_args_list],forward_counts)
        self.assertEqual([call.kwargs['memory_required'] for call in management.load_models_gpu.call_args_list],forward_counts)
        self.assertEqual(len(result),1)
        self.assertEqual([p['pred_cam_t'][0] for p in result[0]],[b['x'] for b in boxes])
        self.assertEqual([p['pred_vertices'][0,0] for p in result[0]],[b['x'] for b in boxes])
        self.assertEqual(timings['batches'],5)
        self.assertEqual(timings['max_batch_crops'],4)
        self.assertEqual(camera_from_fov.call_count,5)
        for call in camera_from_fov.call_args_list: self.assertEqual(call.args,(4,40,55.0))
        np.testing.assert_array_equal(image,np.full((4,40,3),100,np.uint8))

    def test_crop_keeps_original_canvas_and_only_includes_pixels_inside_bounds(self):
        rgb = np.arange(6*8*3, dtype=np.uint8).reshape(6, 8, 3)
        original = rgb.copy()
        result = isolate_rgb(rgb, [-2.5, 1.5, 4.2, 20])
        expected = np.zeros_like(rgb)
        expected[2:6, :5] = original[2:6, :5]
        np.testing.assert_array_equal(result, expected)
        np.testing.assert_array_equal(rgb, original)
        self.assertEqual(result.shape, rgb.shape)
        self.assertEqual(result.dtype, rgb.dtype)
        self.assertFalse(np.shares_memory(result, rgb))

    def test_native_preparation_receives_independent_person_crops_in_frame_order(self):
        modules = {name: types.ModuleType(name) for name in (
            'comfy', 'comfy.model_management', 'comfy.utils', 'comfy.ldm',
            'comfy.ldm.sam3d_body', 'comfy.ldm.sam3d_body.utils',
            'comfy_extras', 'comfy_extras.sam3d_body', 'comfy_extras.sam3d_body.utils')}
        modules['comfy'].utils = modules['comfy.utils']
        modules['comfy'].model_management = modules['comfy.model_management']
        modules['comfy.utils'].ProgressBar = lambda _: None
        modules['comfy.model_management'].throw_exception_if_processing_interrupted = lambda: None
        camera = torch.eye(3)
        modules['comfy_extras.sam3d_body.utils'].cam_int_from_fov = lambda h,w,f: camera
        modules['comfy_extras.sam3d_body.utils'].inputs_from_sam3_track = lambda data,n,h,w: (
            [torch.tensor([[1, 0, 3, 4]]), torch.tensor([[5, 1, 8, 4]])],
            [torch.ones((1,h,w)) for _ in range(n)])
        images = [np.full((4,8,3), value, np.uint8) for value in (50, 100)]
        originals = [rgb.copy() for rgb in images]
        boxes = [{'x':0,'y':0,'width':3,'height':4}, {'x':5,'y':0,'width':3,'height':4}]
        captured = []

        class Prepared(Exception): pass

        def prepare(inputs, crop_boxes, **kwargs):
            captured.append(([v.numpy().copy() for v in inputs],crop_boxes.tolist(),kwargs))
            raise Prepared()  # Inspect the native boundary without loading a model/GPU.

        modules['comfy.ldm.sam3d_body.utils'].prepare_batch = prepare
        model = types.SimpleNamespace(model=types.SimpleNamespace(image_size=512))
        with patch.dict(sys.modules, modules):
            with self.assertRaises(Prepared):
                predict_rgb(model,images,boxes,batch_size=4,isolate_subject=True)
            with self.assertRaises(Prepared):
                predict_rgb(model,images,boxes,batch_size=4)
            with self.assertRaises(Prepared):
                predict_rgb(model,images,boxes,batch_size=4,isolate_subject=True,
                            packed_masks=[np.ones((4,8),np.uint8)]*2)
        inputs, rects, options = captured[0]
        self.assertEqual(rects, [[0,0,3,4],[5,0,8,4]]*2)
        self.assertIs(options['cam_int'], camera)
        for i, value in enumerate((50,50,100,100)):
            expected = np.zeros_like(images[0])
            start, end = (0,3) if i%2==0 else (5,8)
            expected[:,start:end] = value
            np.testing.assert_array_equal(inputs[i], expected)
        for i, value in enumerate(captured[1][0]):
            np.testing.assert_array_equal(value, originals[i//2])
        for i, value in enumerate(captured[2][0]):
            expected = np.zeros_like(images[0])
            x1,y1,x2,y2 = captured[2][1][i]
            expected[y1:y2,x1:x2] = originals[i][y1:y2,x1:x2]
            np.testing.assert_array_equal(value, expected)
        for value, original in zip(images, originals):
            np.testing.assert_array_equal(value, original)
