"""Painted reference masks and file-backed SAM2Matting propagation."""
from contextlib import closing
import uuid
import importlib.util
import json
from pathlib import Path
import sys
import tempfile

import numpy as np

MODEL_FILES = {'sam2.1_base_plus': 'SAM2Matting-SAM2.1Base+.pt', 'sam2.1_tiny': 'SAM2Matting-SAM2.1Tiny.pt', 'sam3': 'SAM2Matting-SAM3.pt'}


def normalize_mask(mask, width, height):
    if not isinstance(mask, dict) or type(mask.get('frame')) is not int or mask['frame'] < 0:
        raise ValueError('Reference mask needs a nonnegative seed frame')
    spacing, limit = mask.get('spacing', 12), mask.get('limit', 500)
    margin = mask.get('margin', 6)
    if not isinstance(margin, (int, float)) or not np.isfinite(margin) or not 0 <= margin <= 100:
        raise ValueError('Mask tolerance must be between 0 and 100 source pixels')
    if not isinstance(spacing, (float, int)) or not np.isfinite(spacing) or spacing < 1 or type(limit) is not int or limit < 3:
        raise ValueError('Mask spacing must be at least 1 pixel; point limit must be at least 3')
    model = mask.get('model', 'sam2.1_base_plus')
    if model not in MODEL_FILES:
        raise ValueError('Unsupported mask propagation model')
    strokes = mask.get('strokes', [])
    if not isinstance(strokes, list):
        raise ValueError('Mask strokes must be a list')
    result = []
    for s in strokes:
        if not isinstance(s, dict) or type(s.get('erase')) is not bool:
            raise ValueError('Mask strokes need paint/erase modes')
        radius = s.get('radius')
        points = np.asarray(s.get('points'), float)
        if not isinstance(radius, (float, int)) or not np.isfinite(radius) or radius <= 0:
            raise ValueError('Brush radius must be positive')
        if points.ndim != 2 or points.shape[1] != 2 or not len(points) or not np.isfinite(points).all() or np.any(points < 0) or np.any(points > [width-1, height-1]):
            raise ValueError('Mask strokes must lie inside the source frame')
        result.append({'erase': s['erase'], 'radius': radius, 'points': points.tolist()})
    return {'frame': mask['frame'], 'spacing': spacing, 'limit': limit, 'margin': margin, 'model': model, 'strokes': result}


def mask_geometry(mask):
    return {k: mask[k] for k in ('frame', 'strokes', 'model')}


def raster_mask(mask, width, height):
    import cv2
    image = np.zeros((height, width), np.uint8)
    for stroke in mask['strokes']:
        points = np.rint(stroke['points']).astype(np.int32)
        radius = max(1, round(stroke['radius']))
        color = 0 if stroke['erase'] else 255
        cv2.polylines(image, [points], False, color, radius*2, lineType=cv2.LINE_8)
        for p in (points[0], points[-1]):
            cv2.circle(image, tuple(p), radius, color, -1)
    return image


def matting_backend():
    import folder_paths
    # Prefer the installed node, also support sibling development checkouts.
    roots = [Path(p)/'ComfyUI-SAM2Matting' for p in folder_paths.get_folder_paths('custom_nodes')]
    roots.append(Path(__file__).resolve().parents[2]/'ComfyUI-SAM2Matting')
    path = next((root/'video_model.py' for root in roots if (root/'video_model.py').is_file()), None)
    if path is None:
        raise ValueError('Install ComfyUI-SAM2Matting to propagate reference masks')
    name = 's3f_optional_sam2matting'
    if name not in sys.modules:
        spec = importlib.util.spec_from_file_location(name, path)
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        try:
            spec.loader.exec_module(module)
        except Exception:
            sys.modules.pop(name, None)
            raise
    return sys.modules[name]


def mask_checkpoint(model):
    import folder_paths
    path = folder_paths.get_full_path('sam2matting', MODEL_FILES[model]) if 'sam2matting' in folder_paths.folder_names_and_paths else None
    if path is None:
        candidate = Path(folder_paths.models_dir)/'sam2matting'/MODEL_FILES[model]
        path = str(candidate) if candidate.is_file() else None
    if path is None:
        raise ValueError(f'Missing {MODEL_FILES[model]}; install it using Load SAM2Matting Video Model, then retry')
    return Path(path)


class MaskReader:
    def __init__(self, manifest_path):
        self.path = Path(manifest_path)
        self.manifest = json.loads(self.path.read_text())
        self.stream = self.path.with_name(self.manifest['data_file']).open('rb')

    def png(self, index):
        offset, size = self.manifest['frames'][index]
        self.stream.seek(offset)
        return self.stream.read(size)

    def image(self, index):
        import cv2
        return cv2.imdecode(np.frombuffer(self.png(index), np.uint8), cv2.IMREAD_GRAYSCALE)

    def close(self):
        self.stream.close()


def propagate_mask(info, mask, root, use_cache=True, progress=None, interrupt=None):
    import cv2
    import torch
    import comfy.model_management as management
    from .reference import atomic_json, decode, digest
    from .video import fingerprint
    mask = normalize_mask(mask, info['width'], info['height'])
    checkpoint = mask_checkpoint(mask['model'])
    identifier = digest({'version': 1, 'source_id': info['source_id'], 'mask': mask_geometry(mask), 'checkpoint': fingerprint(checkpoint)})
    directory = Path(root)/identifier
    manifest_path = directory/'mask.json'
    if use_cache and manifest_path.is_file():
        previous = json.loads(manifest_path.read_text())
        if (directory/previous['data_file']).is_file():
            return manifest_path
    seed = raster_mask(mask, info['width'], info['height'])
    if not seed.any():
        raise ValueError('Paint a reference area before propagating its mask')
    directory.mkdir(parents=True, exist_ok=True)
    backend = matting_backend()
    device = management.get_torch_device()
    management.free_memory(4*1024**3, device)
    model = None
    try:
        model = backend.SAM2MattingVideoModel(mask['model'], checkpoint, device)
        size = model.predictor.image_size
        mean, std = backend.frame_normalization(model.kind)
        mean = torch.tensor(mean).view(3, 1, 1)
        std = torch.tensor(std).view(3, 1, 1)
        with tempfile.TemporaryDirectory(prefix='mask-frames-', dir=directory) as scratch:
            scratch = Path(scratch)
            times = []; pts = []
            with (scratch/'frames.rgb').open('wb') as output, closing(decode(info)) as source:
                for pixels, timestamp, relative, _ in source:
                    if interrupt: interrupt()
                    resized = cv2.resize(pixels, (size, size), interpolation=cv2.INTER_LINEAR)[..., ::-1]
                    output.write(resized.tobytes())
                    times.append(float(relative*1000)); pts.append(str(timestamp))
                    if progress: progress({'stage': 'mask_decode', 'frames': len(times)})
            if not 0 <= mask['frame'] < len(times):
                raise ValueError('The painted mask frame is outside this section')
            class Frames:
                def __len__(self): return len(times)
                def __getitem__(self, index):
                    if not 0 <= index < len(times): raise IndexError(index)
                    with (scratch/'frames.rgb').open('rb') as stream:
                        stream.seek(index*size*size*3)
                        rgb = np.frombuffer(stream.read(size*size*3), np.uint8).reshape(size, size, 3).copy()
                    return (torch.from_numpy(rgb).permute(2, 0, 1).float()/255-mean)/std
            offsets = [None]*len(times); areas = [0]*len(times)
            with (scratch/'masks.bin').open('wb') as output:
                def receive(index, alpha):
                    image = seed if index == mask['frame'] else (alpha.numpy() >= .5).astype(np.uint8)*255
                    ok, encoded = cv2.imencode('.png', image)
                    if not ok: raise RuntimeError('Could not encode propagated reference mask')
                    offsets[index] = [output.tell(), len(encoded)]
                    areas[index] = int(np.count_nonzero(image))
                    output.write(encoded.tobytes())
                model.matte_frame_sequence(Frames(), info['height'], info['width'], torch.from_numpy(seed).float()/255,
                    mask_frame=mask['frame'], alpha_callback=receive, bounded_state=True,
                    progress_callback=lambda done, total: progress({'stage': 'mask_propagation', 'frames': done, 'total_frames': total}) if progress else None,
                    interrupt_callback=interrupt)
            if any(v is None for v in offsets): raise RuntimeError('Mask propagation missed source frames')
            data_file = 'masks-' + uuid.uuid4().hex + '.bin'
            (scratch/'masks.bin').replace(directory/data_file)
            old_data = json.loads(manifest_path.read_text()).get('data_file') if manifest_path.exists() else None
            atomic_json(manifest_path, {'id': identifier, 'info': info, 'mask': mask_geometry(mask), 'frames': offsets,
                'data_file': data_file, 'source_times_ms': times, 'source_pts': pts, 'areas': areas, 'checkpoint': fingerprint(checkpoint)})
            if old_data: (directory/old_data).unlink(missing_ok=True)
        return manifest_path
    finally:
        if model is not None: model.predictor.to('cpu')
