import sys
import types
import unittest
from unittest.mock import patch

import numpy as np
import torch

from sam3d_funscript.inference import isolate_rgb, predict_rgb


class SubjectCropTests(unittest.TestCase):
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
