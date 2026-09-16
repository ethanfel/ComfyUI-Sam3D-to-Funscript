"""Text-prompted, single-frame reference masks; propagation remains a separate job."""
from bisect import bisect_left
from contextlib import closing
import json
import math
from pathlib import Path
import re

import numpy as np

from .frame_index import frame_index
from .reference import atomic_json, digest
from .reference_mask import mask_checkpoint, matting_backend
from .video import fingerprint, video_frames


def prompt_settings(value=None):
    value = {} if value is None else value
    if not isinstance(value, dict):
        raise ValueError('SAM3 mask settings must be an object')
    text = value.get('text', 'man')
    confidence = value.get('confidence', .15)
    backend = value.get('backend', 'sam3matting')
    checkpoint = value.get('checkpoint', '')
    if not isinstance(text, str) or not text.strip():
        raise ValueError('Enter a subject for the SAM3 mask')
    if isinstance(confidence, bool) or not isinstance(confidence, (int, float)) or not math.isfinite(confidence) or not 0 <= confidence <= 1:
        raise ValueError('SAM3 confidence must be between 0 and 1')
    if backend not in ('sam3matting', 'core') or not isinstance(checkpoint, str):
        raise ValueError('Choose SAM3Matting or a ComfyUI core SAM3 / SAM3.1 model')
    return {'text': text.strip(), 'confidence': confidence, 'backend': backend, 'checkpoint': checkpoint}


def core_models():
    import folder_paths
    models = []
    pattern = re.compile(r'(?<![a-z0-9])sam[_-]?3([._-]?1)?(?![a-z0-9])', re.I)
    for folder in ('checkpoints', 'diffusion_models', 'detection', 'sam3'):
        if folder not in folder_paths.folder_names_and_paths:
            continue
        for name in folder_paths.get_filename_list(folder):
            if Path(name).suffix.lower() not in ('.pt', '.pth', '.ckpt', '.safetensors', '.bin') or re.search(r'matting|sam[_-]?3d', name, re.I):
                continue
            version = pattern.search(Path(name).name) or pattern.search(name)
            if version is None:
                continue
            family = 'SAM3.1' if version[1] else 'SAM3'
            models.append({'value': f'{folder}:{name}', 'label': f'{family} · {name} ({folder})'})
    return models


def checkpoint_path(settings, *, progress=None, interrupt=None):
    if settings['backend'] == 'sam3matting':
        return mask_checkpoint('sam3', download=True, progress=progress, interrupt=interrupt)
    import folder_paths
    selected = settings['checkpoint']
    if selected not in {entry['value'] for entry in core_models()}:
        raise ValueError('Choose an installed full SAM3 / SAM3.1 checkpoint, including its text encoder, then refresh the model list')
    folder, name = selected.split(':', 1)
    return Path(folder_paths.get_full_path_or_raise(folder, name))


def detect_mask(rgb, settings, checkpoint, interrupt=None):
    if settings['backend'] == 'core' and Path(checkpoint).suffix.lower() == '.safetensors':
        from safetensors import safe_open
        with safe_open(str(checkpoint), framework='np') as weights:
            if (weights.metadata() or {}).get('format', '').lower() == 'mlx':
                raise ValueError('This is an MLX checkpoint; ComfyUI needs different weight names and tensor layouts. '
                    'For SAM3.1, select sam3.1_multiplex_fp16.safetensors from Comfy-Org/sam3.1. '
                    'Renaming the MLX file does not convert it.')
    import torch
    import comfy.model_management as management
    images = torch.from_numpy(np.ascontiguousarray(rgb)).float().unsqueeze(0) / 255
    if interrupt: interrupt()
    if settings['backend'] == 'core':
        from comfy.sd import load_checkpoint_guess_config
        from comfy_extras.nodes_sam3 import SAM3_Detect
        model, clip, _, _ = load_checkpoint_guess_config(str(checkpoint), output_vae=False, output_clip=True)
        if clip is None:
            raise ValueError('This checkpoint lacks its text encoder. Select a full SAM3 / SAM3.1 checkpoint.')
        conditioning = clip.encode_from_tokens_scheduled(clip.tokenize(settings['text']))
        if interrupt: interrupt()
        output = SAM3_Detect.execute(model, images, conditioning=conditioning,
            threshold=settings['confidence'], refine_iterations=0, individual_masks=True).result
        masks, boxes = output
        if not len(masks):
            raise ValueError('SAM3 found no matching mask. Try another frame, prompt or confidence, or paint manually.')
        mask, score = masks[0], boxes[0][0]['score']
    else:
        backend = matting_backend()
        device = management.get_torch_device()
        management.free_memory(12 * 1024**3, device)
        model = backend.SAM2MattingVideoModel('sam3', checkpoint, device)
        try:
            masks, score = model.text_seed_mask(images, settings['text'], frame_index=0,
                confidence_threshold=settings['confidence'], selection='highest_score', interrupt_callback=interrupt)
            mask = masks[0].cpu()
        finally:
            model.predictor.to('cpu')
    if interrupt: interrupt()
    image = (mask.detach().float().cpu().numpy() >= .5).astype(np.uint8) * 255
    if image.shape != rgb.shape[:2] or not image.any():
        raise ValueError('SAM3 returned no usable mask. Try another frame or paint manually.')
    return image, float(score)


def polygon_strokes(image):
    """Compact editable outlines, including holes and disconnected body parts."""
    import cv2
    contours, hierarchy = cv2.findContours(image, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    strokes = []
    if hierarchy is None:
        return strokes
    for i, contour in enumerate(contours):
        if hierarchy[0][i][3] != -1:
            continue
        points = contour.reshape(-1, 2).tolist()
        if len(points) < 3:
            # Preserve thin detections as normal editable brush strokes.
            strokes.append({'erase': False, 'radius': .5, 'points': points})
            continue
        holes = []
        child = hierarchy[0][i][2]
        while child != -1:
            holes.append(contours[child].reshape(-1, 2).tolist())
            child = hierarchy[0][child][0]
        strokes.append({'erase': False, 'radius': 1, 'shape': 'polygon', 'points': points, 'holes': holes})
    return strokes


def seed_mask(info, plan, request, root, *, use_cache=True, interrupt=None, progress=None):
    if not isinstance(request, dict):
        raise ValueError('Choose a stabilization region and source frame for SAM3')
    region = next((r for r in plan['stabilization'] if r['id'] == request.get('region_id') and r['enabled'] and not r['locked']), None)
    at = request.get('at_ms')
    if region is None or isinstance(at, bool) or not isinstance(at, (int, float)) or not math.isfinite(at):
        raise ValueError('Choose an unlocked stabilization region and a valid source frame')
    settings = prompt_settings(request.get('settings'))
    index = frame_index(info, root / 'frame-index')
    frame = bisect_left(index['times_ms'], at - .000002)
    if frame == len(index['times_ms']) or abs(index['times_ms'][frame]-at) > .002 or not region['start_ms']-.000002 <= at < region['end_ms']-.000002:
        raise ValueError('The SAM3 seed frame must be inside the selected stabilization region')
    at = index['times_ms'][frame]
    local_frame = frame - bisect_left(index['times_ms'], region['start_ms']-.000002)
    checkpoint = checkpoint_path(settings, progress=progress, interrupt=interrupt)
    key = digest({'version': 1, 'source': info['source'], 'at_ms': at, 'settings': settings, 'checkpoint': fingerprint(checkpoint)})
    cached = root / 'mask-seeds' / (key + '.json')
    if interrupt: interrupt()
    if use_cache and cached.is_file():
        result = json.loads(cached.read_text())
    else:
        if progress: progress({'stage': 'mask_seed', 'region_id': region['id'], 'frames': 0, 'total_frames': 1})
        # The shared decoder requires a limit of at least two; consume only one.
        # Start just before the indexed timestamp to tolerate decimal rounding.
        with closing(video_frames(info['source']['path'], sample_fps=0, start_seconds=max(0, at-.000002)/1000, max_frames=2)) as frames:
            rgb, timing = next(frames)
        if abs(timing['time_ms']-at) > .002 or rgb.shape[:2] != (info['height'], info['width']):
            raise ValueError('Could not decode the exact SAM3 seed frame; prepare the source again')
        image, score = detect_mask(rgb, settings, checkpoint, interrupt)
        result = {'strokes': polygon_strokes(image), 'score': score}
        cached.parent.mkdir(parents=True, exist_ok=True)
        atomic_json(cached, result)
    return {**result, 'source_id': info['source_id'], 'region_id': region['id'], 'at_ms': at,
            'frame': local_frame, 'settings': settings}
