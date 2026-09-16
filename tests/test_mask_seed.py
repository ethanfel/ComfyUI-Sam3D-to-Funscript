from copy import deepcopy
from pathlib import Path
import tempfile
import sys
import types
import unittest
from unittest.mock import patch, Mock

import cv2
import av
import numpy as np

from sam3d_funscript.mask_seed import checkpoint_path, detect_mask, polygon_strokes, prompt_settings, seed_mask
from sam3d_funscript.reference_mask import normalize_mask, raster_mask, seed_points
from sam3d_funscript.processing_timeline import normalize_plan
from sam3d_funscript.reference import config_for_source, source_info
from sam3d_funscript.frame_index import frame_index
from test_processing_timeline import info, region


class MaskSeedTests(unittest.TestCase):
    def test_mlx_checkpoint_explains_the_required_format_before_loading_weights(self):
        from safetensors.numpy import save_file
        with tempfile.TemporaryDirectory() as directory:
            checkpoint=Path(directory)/'sam3.1.safetensors'
            save_file({'detector_model.detr_decoder.query_embed.weight':np.zeros((2,4),np.float32)},
                      str(checkpoint),metadata={'format':'mlx'})
            with patch.dict(sys.modules,{'comfy.model_management':None}):
                with self.assertRaisesRegex(ValueError,'MLX checkpoint.*sam3.1_multiplex_fp16'):
                    detect_mask(np.zeros((24,32,3),np.uint8),prompt_settings({'backend':'core'}),checkpoint)

    def test_core_sam3_and_sam31_resolve_only_installed_registered_models(self):
        from sam3d_funscript.mask_seed import core_models
        folders=types.ModuleType('folder_paths')
        folders.folder_names_and_paths={'checkpoints':[],'sam3':[]}
        names={'checkpoints':['sam3.safetensors','sam_3d_body.safetensors'],
               'sam3':['sam3.1_multiplex.pt','SAM2Matting-SAM3.pt','sam3.txt']}
        folders.get_filename_list=lambda folder:names[folder]
        folders.get_full_path_or_raise=Mock(side_effect=lambda group,name:'/configured/'+group+'/'+name)
        with patch.dict(sys.modules,{'folder_paths':folders}), patch('sam3d_funscript.mask_seed.matting_backend') as matting:
            self.assertEqual(len(core_models()),2)
            for value in ('checkpoints:sam3.safetensors','sam3:sam3.1_multiplex.pt'):
                settings=prompt_settings({'backend':'core','checkpoint':value})
                self.assertEqual(checkpoint_path(settings),Path('/configured/'+value.replace(':','/')))
                restored,_=config_for_source({'mask_prompt':settings},info())
                self.assertEqual(restored['mask_prompt'],settings)
            for missing in ('/other-install/sam3.pt','sam3:../sam3.pt','sam3:SAM2Matting-SAM3.pt','sam3:removed.pt'):
                with self.assertRaisesRegex(ValueError,'installed full'):checkpoint_path(prompt_settings({'backend':'core','checkpoint':missing}))
            names['sam3']=[]
            with self.assertRaisesRegex(ValueError,'refresh'):checkpoint_path(prompt_settings({'backend':'core','checkpoint':'sam3:sam3.1_multiplex.pt'}))
            matting.assert_not_called()

    def test_missing_matting_checkpoint_downloads_to_configured_paths_and_is_reused(self):
        from sam3d_funscript.reference_mask import MODEL_FILES, mask_checkpoint
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);first=root/'configured';second=root/'shared';filename=MODEL_FILES['sam3']
            first.mkdir();second.mkdir()
            folders=types.ModuleType('folder_paths');folders.models_dir=str(root/'models')
            folders.folder_names_and_paths={'sam2matting':([str(first),str(second)],{'.pt'})}
            folders.get_folder_paths=Mock(return_value=[str(first),str(second)])
            folders.get_full_path=Mock(side_effect=lambda category,name:next((str(p/name) for p in [first,second] if (p/name).is_file()),None))
            backend=Mock();events=[]
            def download(variant,destination,report):
                self.assertEqual(variant,'sam3');self.assertEqual(destination,first/filename)
                report(1,100);report(1,100);report(100,100)
                destination.write_bytes(b'complete checkpoint')
            backend.download_checkpoint.side_effect=download
            with patch.dict(sys.modules,{'folder_paths':folders}), \
                 patch('sam3d_funscript.reference_mask.matting_backend',return_value=backend):
                # A copy in any registered directory wins before choosing a download destination.
                existing=second/filename;existing.write_bytes(b'existing checkpoint')
                self.assertEqual(checkpoint_path(prompt_settings()),existing)
                backend.download_checkpoint.assert_not_called()
                existing.unlink()
                with self.assertRaisesRegex(ValueError,'Missing'):mask_checkpoint('sam3')
                backend.download_checkpoint.assert_not_called()
                self.assertEqual(checkpoint_path(prompt_settings(),progress=events.append),first/filename)
                self.assertEqual(checkpoint_path(prompt_settings()),first/filename)
                self.assertEqual(backend.download_checkpoint.call_count,1)
                self.assertEqual([e['downloaded_bytes'] for e in events],[0,1,100])
                self.assertTrue(all(e['stage']=='mask_model_download' for e in events))
                folders.get_folder_paths.assert_called_with('sam2matting')

    def test_download_falls_back_to_model_root_and_honors_cancellation(self):
        from sam3d_funscript.reference_mask import MODEL_FILES
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);filename=MODEL_FILES['sam3']
            folders=types.ModuleType('folder_paths');folders.models_dir=str(root)
            folders.folder_names_and_paths={}
            folders.get_full_path=Mock(side_effect=AssertionError('No unregistered path lookup'))
            folders.get_folder_paths=Mock(side_effect=AssertionError('No other model folders'))
            backend=Mock();interrupt=Mock(side_effect=[None,RuntimeError('cancelled')])
            def download(variant,destination,report):
                self.assertEqual(destination,root/'sam2matting'/filename)
                report(1,100)
                destination.parent.mkdir(parents=True,exist_ok=True);destination.write_bytes(b'complete')
            backend.download_checkpoint.side_effect=download
            with patch.dict(sys.modules,{'folder_paths':folders}), \
                 patch('sam3d_funscript.reference_mask.matting_backend',return_value=backend):
                with self.assertRaisesRegex(RuntimeError,'cancelled'):checkpoint_path(prompt_settings(),interrupt=interrupt)
                self.assertFalse((root/'sam2matting'/filename).exists())
                result=checkpoint_path(prompt_settings())
                self.assertEqual(result.read_bytes(),b'complete')
                self.assertEqual(checkpoint_path(prompt_settings()),result)
                self.assertEqual(backend.download_checkpoint.call_count,2)
                folders.get_full_path.assert_not_called();folders.get_folder_paths.assert_not_called()

    def test_native_and_matting_adapters_use_requested_text_threshold_and_one_frame(self):
        import torch
        management=types.ModuleType('comfy.model_management')
        management.get_torch_device=lambda:'cpu';management.free_memory=Mock()
        core_sd=types.ModuleType('comfy.sd');core_nodes=types.ModuleType('comfy_extras.nodes_sam3')
        clip=Mock();clip.tokenize.return_value='tokens';clip.encode_from_tokens_scheduled.return_value='conditioning'
        core_sd.load_checkpoint_guess_config=Mock(return_value=(object(),clip,None,None))
        mask=torch.ones((1,24,32))
        core_nodes.SAM3_Detect=Mock();core_nodes.SAM3_Detect.execute.return_value=types.SimpleNamespace(result=(mask,[[{'score':.21}]]))
        modules={'comfy':types.ModuleType('comfy'),'comfy.model_management':management,'comfy.sd':core_sd,
                 'comfy_extras':types.ModuleType('comfy_extras'),'comfy_extras.nodes_sam3':core_nodes}
        rgb=np.zeros((24,32,3),np.uint8)
        with patch.dict(sys.modules,modules):
            image,score=detect_mask(rgb,prompt_settings({'backend':'core'}),'sam3.pt')
            self.assertEqual(score,.21);self.assertTrue(image.all())
            clip.tokenize.assert_called_once_with('man')
            args=core_nodes.SAM3_Detect.execute.call_args
            self.assertEqual(args.args[1].shape,(1,24,32,3))
            self.assertEqual(args.kwargs['threshold'],.15)
            self.assertEqual(args.kwargs['refine_iterations'],0)
            matting=Mock();matting.text_seed_mask.return_value=(mask,.24)
            backend=Mock();backend.SAM2MattingVideoModel.return_value=matting
            with patch('sam3d_funscript.mask_seed.matting_backend',return_value=backend):
                image,score=detect_mask(rgb,prompt_settings(),'matting.pt')
                self.assertEqual(score,.24)
                args=matting.text_seed_mask.call_args
                self.assertEqual(args.args[0].shape,(1,24,32,3));self.assertEqual(args.args[1],'man')
                self.assertEqual(args.kwargs['frame_index'],0);self.assertEqual(args.kwargs['confidence_threshold'],.15)
                matting.predictor.to.assert_called_with('cpu')
                matting.text_seed_mask.side_effect=RuntimeError('No detection')
                with self.assertRaisesRegex(RuntimeError,'No detection'):detect_mask(rgb,prompt_settings(),'matting.pt')
                self.assertEqual(matting.predictor.to.call_count,2)

    def test_outlines_preserve_holes_islands_and_manual_edits(self):
        image=np.zeros((240,320),np.uint8)
        image[20:120,20:120]=255;image[40:80,40:80]=0;image[50:60,50:60]=255
        image[150:170,150:200]=255
        strokes=polygon_strokes(image)
        mask=normalize_mask({'frame':3,'strokes':strokes,'spacing':8,'limit':100},320,240)
        np.testing.assert_array_equal(raster_mask(mask,320,240),image)
        mask['strokes'].append({'erase':True,'radius':8,'points':[[30,30]]})
        mask['strokes'].append({'erase':False,'radius':8,'points':[[250,200]]})
        edited=raster_mask(mask,320,240)
        self.assertEqual(edited[30,30],0);self.assertEqual(edited[200,250],255)
        saved,_=config_for_source({'point_mask':mask,'mask_prompt':prompt_settings()},info())
        self.assertEqual(saved['point_mask'],mask)
        self.assertEqual(saved['mask_prompt']['confidence'],.15)
        points=seed_points(mask,[0,0,320,240],320,240)
        self.assertTrue(all(edited[round(y),round(x)] for x,y in points))

    def test_defaults_and_invalid_settings(self):
        self.assertEqual(prompt_settings(),{'text':'man','confidence':.15,'backend':'sam3matting','checkpoint':''})
        for value in [{'text':' '},{'confidence':float('nan')},{'confidence':1.1},{'confidence':True},{'backend':'unknown'}]:
            with self.assertRaises(ValueError):prompt_settings(value)
        self.assertEqual(prompt_settings({'text':' man '})['text'],'man')

    def test_real_decoder_preserves_fractional_frame_and_stops_before_inference_on_other_frames(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);video=root/'source.mp4';checkpoint=root/'sam3.pt';checkpoint.write_bytes(b'test')
            with av.open(str(video),'w') as out:
                stream=out.add_stream('libx264',rate=30)
                stream.width,stream.height,stream.pix_fmt=64,48,'yuv420p'
                for i in range(6):
                    rgb=np.zeros((48,64,3),np.uint8);rgb[:,:,i%3]=240
                    for packet in stream.encode(av.VideoFrame.from_ndarray(rgb,format='rgb24')):out.mux(packet)
                for packet in stream.encode():out.mux(packet)
            current=source_info(video)
            plan=normalize_plan({'tracking':[],'stabilization':[{'id':'s','start_ms':0,'end_ms':current['end_ms']}]},current)
            times=frame_index(current,root/'frame-index')['times_ms']
            with patch('sam3d_funscript.mask_seed.checkpoint_path',return_value=checkpoint), \
                 patch('sam3d_funscript.mask_seed.detect_mask',return_value=(np.ones((48,64),np.uint8)*255,.23)) as detector:
                for i,at in enumerate(times):
                    result=seed_mask(current,plan,{'region_id':'s','at_ms':at},root)
                    self.assertEqual(result['frame'],i)
                    self.assertEqual(int(detector.call_args.args[0].mean(axis=(0,1)).argmax()),i%3)
                    self.assertEqual(detector.call_count,i+1)

    def test_exact_one_frame_cached_without_overwriting_reference_or_motion(self):
        original=info(start=1)
        plan=normalize_plan({'tracking':[], 'stabilization':[region('s',1500,3000,reference={
            'crop_xywh':[0,0,320,240],'points':[[20,20],[30,30],[40,40]]})]},original)
        before=deepcopy(plan)
        request={'region_id':'s','at_ms':2000,'settings':prompt_settings()}
        index={'times_ms':[1000,1500,2000,2500,3000,3500],'first_frame':2,'end_frame':8}
        rgb=np.zeros((240,320,3),np.uint8);mask=np.zeros((240,320),np.uint8);mask[20:90,30:120]=255
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);checkpoint=root/'sam3.pt';checkpoint.write_bytes(b'test')
            with patch('sam3d_funscript.mask_seed.frame_index',return_value=index), \
                 patch('sam3d_funscript.mask_seed.checkpoint_path',return_value=checkpoint), \
                 patch('sam3d_funscript.mask_seed.video_frames',side_effect=lambda *args,**kw:iter_frames(rgb)) as decode, \
                 patch('sam3d_funscript.mask_seed.detect_mask',return_value=(mask,.23)) as detect:
                result=seed_mask(original,plan,request,root)
                self.assertEqual(result['frame'],1,'seed frame is relative to region, not clip trim')
                self.assertEqual(result['at_ms'],2000)
                self.assertEqual(result['settings']['text'],'man')
                self.assertEqual(decode.call_args.kwargs['max_frames'],2)
                self.assertAlmostEqual(decode.call_args.kwargs['start_seconds'],2)
                self.assertEqual(detect.call_args.args[1]['confidence'],.15)
                self.assertEqual(seed_mask(original,plan,request,root),result)
                self.assertEqual(detect.call_count,1)
                seed_mask(original,plan,{**request,'settings':{**request['settings'],'confidence':.2}},root)
                self.assertEqual(detect.call_count,2)
                self.assertEqual(plan,before)
                for at in [1499,2100,3000]:
                    with self.assertRaisesRegex(ValueError,'inside'):seed_mask(original,plan,{**request,'at_ms':at},root)
                plan['stabilization'][0]['locked']=True
                with self.assertRaisesRegex(ValueError,'unlocked'):seed_mask(original,plan,request,root)
                self.assertEqual(detect.call_count,2)


def iter_frames(rgb):
    yield rgb,{'time_ms':2000}
