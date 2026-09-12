"""Scene proposals and reviewable anchor suggestions; no identity guarantees."""
from contextlib import closing
from copy import deepcopy
from fractions import Fraction
from pathlib import Path
import json
import math
import tempfile

import numpy as np

from .reference import atomic_json, digest
from .video import fingerprint, video_frames

VERSION = 1
AUTO_ANCHORS = ('mouth', 'pelvis', 'left_hand', 'right_hand')


def detector_path():
    import folder_paths
    roots = [Path(folder_paths.models_dir) / 'ultralytics']
    for key in ('ultralytics', 'ultralytics_bbox', 'ultralytics_segm'):
        if key in folder_paths.folder_names_and_paths:
            roots.extend(Path(p) for p in folder_paths.get_folder_paths(key))
    for name in ('YOLO11/yolo11m.pt', 'YOLO11/yolo11s.pt', 'yolo11m.pt', 'yolo11s.pt', 'person_yolov8m-seg.pt'):
        for root in roots:
            for prefix in ('', 'bbox/', 'segm/'):
                path = root / (prefix + name)
                if path.is_file():
                    return path
    raise ValueError('Automatic mode needs a local person detector: install yolo11m.pt under models/ultralytics/bbox/YOLO11, then retry.')


class PersonDetector:
    def __init__(self, path):
        try:
            from ultralytics import YOLO
        except ImportError as error:
            raise ValueError('Automatic mode needs ultralytics in the ComfyUI Python environment.') from error
        self.model = YOLO(str(path))
        self.workspace = tempfile.TemporaryDirectory(prefix='s3f-person-detection-')
        self.classes = [i for i, name in self.model.names.items() if name.lower() == 'person']
        if not self.classes:
            raise ValueError('The automatic detector has no person class.')

    def __call__(self, rgb):
        # CPU execution leaves ComfyUI's managed GPU models and memory intact.
        result = self.model.predict(rgb[..., ::-1].copy(), classes=self.classes, conf=.4,
                                    imgsz=640, device='cpu', verbose=False, save=False,
                                    save_txt=False, project=self.workspace.name, name='people', exist_ok=True)[0]
        height, width = rgb.shape[:2]
        return [{'box': (box / [width, height, width, height]).tolist(), 'confidence': float(conf)}
                for box, conf in zip(result.boxes.xyxy.cpu().numpy(), result.boxes.conf.cpu().numpy())]


def iou(a, b):
    overlap = np.maximum(0, np.minimum(a[2:], b[2:]) - np.maximum(a[:2], b[:2])).prod()
    area = np.maximum(0, np.asarray(a)[2:] - a[:2]).prod() + np.maximum(0, np.asarray(b)[2:] - b[:2]).prod() - overlap
    return float(overlap / area) if area > 0 else 0.


def association(a, b):
    a, b = np.asarray(a), np.asarray(b)
    areas = [np.prod(a[2:]-a[:2]), np.prod(b[2:]-b[:2])]
    if max(areas)/max(min(areas), 1e-6) > 2.75:
        return 0.
    overlap = iou(a, b)
    if overlap < .15: return 0.
    distance = np.linalg.norm((a[:2]+a[2:]-b[:2]-b[2:])/2)
    return overlap - .3*distance/max(np.linalg.norm(a[2:]-a[:2]), .05)


def person_envelopes(samples, max_people=None):
    """Associate sampled boxes inside one scene and retain their movement envelope."""
    tracks = []
    for frame, sample in enumerate(samples):
        boxes = [d for d in sample['people'] if np.isfinite(d['box']).all()
                 and np.prod(np.asarray(d['box'])[2:] - d['box'][:2]) >= .003]
        pairs = sorted([(association(track['boxes'][-1], detection['box']), ti, di)
                        for ti, track in enumerate(tracks) if frame-track['last'] <= 2
                        for di, detection in enumerate(boxes)], reverse=True)
        used_tracks, used_boxes = set(), set()
        for score, ti, di in pairs:
            if score < .15 or ti in used_tracks or di in used_boxes:
                continue
            track = tracks[ti]
            if any(other != ti and abs(score - association(t['boxes'][-1], boxes[di]['box'])) < .08
                   for other, t in enumerate(tracks) if frame-t['last'] <= 2):
                track['ambiguous'] = True
            track['boxes'].append(boxes[di]['box']); track['confidence'].append(boxes[di]['confidence'])
            track['last'] = frame; used_tracks.add(ti); used_boxes.add(di)
        for di, detection in enumerate(boxes):
            if di not in used_boxes:
                tracks.append({'boxes': [detection['box']], 'confidence': [detection['confidence']],
                               'last': frame, 'first': frame, 'ambiguous': False})
    tracks = [t for t in tracks if len(t['boxes']) >= min(max(2, math.ceil(len(samples)*.35)), len(samples))
              and np.mean(t['confidence']) >= .45]
    tracks.sort(key=lambda t: (len(t['boxes']), np.mean(t['confidence']), np.median(
        np.prod(np.array(t['boxes'])[:, 2:]-np.array(t['boxes'])[:, :2], axis=1))), reverse=True)
    omitted = max(0, len(tracks)-max_people) if max_people is not None else 0
    tracks = tracks[:max_people]
    tracks.sort(key=lambda t: (t['first'], t['boxes'][0][0]))
    people = []
    for track in tracks:
        boxes = np.asarray(track['boxes']); low = boxes[:, :2].min(axis=0); high = boxes[:, 2:].max(axis=0)
        margin = np.maximum(.01, (high-low)*.06)
        low = np.maximum(0, low-margin); high = np.minimum(1, high+margin)
        areas = np.prod(boxes[:, 2:]-boxes[:, :2], axis=1)
        coverage = len(boxes)/max(1, len(samples)); review = []
        if coverage < .8: review.append('Person missing in sampled frames')
        if track['ambiguous']: review.append('Overlapping people may switch identity')
        if areas.max()/max(areas.min(), 1e-6) > 2: review.append('Large framing change; review crop')
        people.append({'roi': np.r_[low, high-low].round(7).tolist(), 'coverage': coverage,
                       'confidence': float(np.mean(track['confidence'])), 'review': review})
    for i, person in enumerate(people):
        a = person['roi']; a = [*a[:2], a[0]+a[2], a[1]+a[3]]
        if any(i != j and iou(a, [*p['roi'][:2], p['roi'][0]+p['roi'][2], p['roi'][1]+p['roi'][3]]) > .35 for j, p in enumerate(people)):
            person['review'].append('Person crops overlap; inspect subject assignment')
    return people, omitted


def available_scenes(info, cuts, plan, replace_default=False):
    start, end = float(Fraction(info['start'])*1000), float(info['end_ms'])
    boundaries = sorted({start, end, *(float(t) for t in cuts['times_ms'] if start < t < end)})
    existing = deepcopy(plan['tracking'])
    if replace_default and len(existing) == 1:
        from .processing_timeline import normalize_plan
        if existing == normalize_plan({}, info)['tracking']:
            existing = []
    ranges = []
    for shot, (a, b) in enumerate(zip(boundaries, boundaries[1:]), 1):
        parts = [(a, b)]
        # Disabled and locked manual regions also reserve their original interval.
        for r in existing:
            next_parts = []
            for left, right in parts:
                if r['end_ms'] <= left or r['start_ms'] >= right: next_parts.append((left, right)); continue
                if left < r['start_ms']: next_parts.append((left, r['start_ms']))
                if r['end_ms'] < right: next_parts.append((r['end_ms'], right))
            parts = next_parts
        ranges.extend((shot, left, right) for left, right in parts)
    return existing, ranges


def prepare_automatic(info, plan, cuts, root, *, replace_default=False, people_mode='all', use_cache=True,
                      progress=None, interrupt=None, detector=None):
    from .processing_timeline import normalize_plan
    if people_mode not in ('all', 'prominent'):
        raise ValueError('Automatic people mode must be all or prominent')
    if cuts.get('source_id') != info['source_id']:
        raise ValueError('Automatic scene cuts belong to another video')
    existing, scenes = available_scenes(info, cuts, plan, replace_default)
    output = deepcopy(plan); output['tracking'] = existing
    if not scenes:
        return output, {'scenes_added': 0, 'review': [], 'message': 'Existing regions cover this video. Automatic mode only fills gaps.'}
    path = detector_path() if detector is None else None
    detector_key = fingerprint(path) if path else {'test_detector': True}
    detector_instance = detector
    reviews = []
    for index, (shot, start, end) in enumerate(scenes):
        if interrupt: interrupt()
        if progress: progress({'stage': 'auto_people', 'completed_jobs': index, 'total_jobs': len(scenes), 'scene': shot})
        key = digest([VERSION, info['source'], start, end, detector_key, {'fps':2, 'confidence':.4, 'size':640}])
        cache = Path(root) / 'people' / (key+'.json')
        cache.parent.mkdir(parents=True, exist_ok=True)
        if use_cache and cache.is_file():
            samples = json.loads(cache.read_text())
        else:
            if detector_instance is None: detector_instance = PersonDetector(path)
            samples = []
            with closing(video_frames(info['source']['path'], sample_fps=2, start_seconds=start/1000,
                                      duration_seconds=(end-start)/1000, max_frames=2**31-1)) as frames:
                for rgb, timing in frames:
                    if interrupt: interrupt()
                    samples.append({'at_ms': timing['time_ms'], 'people': detector_instance(rgb)})
            atomic_json(cache, samples)
        people, omitted = person_envelopes(samples)
        if people_mode == 'prominent' and people:
            people = [max(people, key=lambda p: p['coverage']*p['confidence']*math.sqrt(p['roi'][2]*p['roi'][3]))]
        review = list(dict.fromkeys(reason for p in people for reason in p['review']))
        if omitted: review.append(f'{omitted} additional person detections omitted')
        if not people: review.append('No reliable person box; draw a crop and enable this scene')
        if end-start < 100: review.append('Scene too short for motion extraction')
        enabled = bool(people) and end-start >= 100
        region = {'id': 'auto_'+digest([info['source_id'], start, end]), 'name': f'Scene {shot}',
                  'start_ms': start, 'end_ms': end, 'enabled': enabled, 'anchor': 'pelvis', 'person': 0,
                  'rois': [p['roi'] for p in people] or [[0, 0, 1, 1]], 'isolate_subject': True, 'smoothing_ms': 30,
                  'additional_anchors': ['mouth', 'left_hand', 'right_hand'],
                  'candidate_people': list(range(len(people))) or [0],
                  'automatic': {'version': VERSION, 'suggest': True, 'people': people, 'review': review, 'samples': len(samples)}}
        output['tracking'].append(region)
        if review: reviews.append({'id': region['id'], 'name': region['name'], 'reasons': review})
    return normalize_plan(output, info), {'scenes_added': len(scenes), 'review': reviews}


def candidate_review(sequence, region, person, anchor, project):
    from .core import anchor_indices
    pixels = sequence.pixels[:, person, anchor_indices(anchor)].mean(axis=1)
    height, width = sequence.metadata['image_size']
    x, y, w, h = region['rois'][person]
    valid = sequence.valid[:, person] & np.isfinite(pixels).all(axis=1)
    inside = valid & (pixels[:, 0] >= x*width) & (pixels[:, 0] <= (x+w)*width) & (pixels[:, 1] >= y*height) & (pixels[:, 1] <= (y+h)*height)
    coverage = float(inside.mean()); reasons = list(region['automatic']['review'])
    if coverage < .8: reasons.append('Anchor leaves the crop or has missing samples')
    source = np.asarray(project['processed'], dtype=float)[:, :3]
    steps = np.linalg.norm(np.diff(source, axis=0), axis=1); steps = steps[np.isfinite(steps)]
    jumps = float(np.mean(steps > max(.1, np.median(steps)*8))) if len(steps) else 1.
    if jumps > .03: reasons.append('Abrupt pose changes')
    actions = project['scripts']['L0']['actions']; movement = np.ptp([a['pos'] for a in actions])
    if movement < 8: reasons.append('Very little usable movement')
    detector = region['automatic']['people']
    confidence = detector[person]['coverage'] if person < len(detector) else 1.
    lag = min(max(1, round(200/max(1, np.median(np.diff(sequence.times_ms))))), max(1, len(source)-1))
    displacements = source[lag:]-source[:-lag]
    displacements = displacements[np.isfinite(displacements).all(axis=1)]
    variation = float(np.linalg.norm(np.std(displacements, axis=0))) if len(displacements) else 0.
    # This is an inspectability heuristic, not contact/visibility confidence.
    score = max(0., coverage*.55 + confidence*.2 + min(1., variation/.04)*.15 + min(1., movement/40)*.1 - jumps*2)
    return {'score': round(score, 4), 'review': list(dict.fromkeys(reasons)), 'inside_fraction': coverage,
            'person': person, 'anchor': anchor, 'suggested': False}
