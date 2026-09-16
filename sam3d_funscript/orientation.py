"""Head-area roll tracking and rotation-only source rendering, without pose inference."""
from bisect import bisect_left
from contextlib import closing
import json
import math
from pathlib import Path

import cv2
import numpy as np

from .reference import atomic_json, decode, digest, render
from .stabilization import transform_points

VERSION = 1


def normalize_orientation(value, width, height):
    if not isinstance(value, dict):
        raise ValueError('Orientation settings must be an object')
    method = value.get('method', 'features')
    target = value.get('target_degrees', 0)
    keys = value.get('keys', [])
    if method not in ('features', 'manual'):
        raise ValueError('Orientation tracking must be features or manual')
    if type(target) not in (int, float) or not math.isfinite(target) or not -180 <= target <= 180:
        raise ValueError('Target head angle must be between -180 and 180 degrees')
    if not isinstance(keys, list) or len(keys) > 128:
        raise ValueError('Use at most 128 head orientation frames per region')
    normalized = []
    for key in keys:
        if not isinstance(key, dict) or type(key.get('frame')) is not int or key['frame'] < 0:
            raise ValueError('Head orientation needs a valid source frame')
        angle, box = key.get('angle_degrees'), key.get('head_xywh')
        if type(angle) not in (int, float) or not math.isfinite(angle) or not -180 <= angle <= 180:
            raise ValueError('Head tilt must be between -180 and 180 degrees')
        if not isinstance(box, list) or len(box) != 4 or any(type(v) not in (int, float) or not math.isfinite(v) for v in box):
            raise ValueError('Draw a head rectangle inside the source frame')
        x, y, w, h = box
        if min(x, y) < 0 or min(w, h) < 16 or x+w > width or y+h > height:
            raise ValueError('Head rectangle must be inside the source image and at least 16 pixels wide and high')
        normalized.append({'frame': key['frame'], 'angle_degrees': float(angle), 'head_xywh': list(map(float, box))})
    if len({k['frame'] for k in normalized}) != len(normalized):
        raise ValueError('Head orientation frames must be distinct')
    return {'method': method, 'target_degrees': float(target), 'keys': sorted(normalized, key=lambda k:k['frame'])}


def rotation_matrix(angle_degrees, center):
    """Positive head tilt is clockwise; OpenCV's positive correction is anticlockwise."""
    return cv2.getRotationMatrix2D(tuple(map(float, center)), float(angle_degrees), 1.)


def _features(image, detector, box=None):
    factor = min(1., 960/max(image.shape[:2]))
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    if factor < 1:
        gray = cv2.resize(gray, None, fx=factor, fy=factor, interpolation=cv2.INTER_AREA)
    mask = None
    if box is not None:
        mask = np.zeros(gray.shape, np.uint8)
        x, y, w, h = np.asarray(box)*factor
        mask[round(y):round(y+h), round(x):round(x+w)] = 255
    points, descriptors = detector.detectAndCompute(gray, mask)
    return np.asarray([p.pt for p in points], np.float32).reshape(-1, 2)/factor, descriptors


def _match(template, current, box):
    origin, descriptors = template
    points, observed = current
    if descriptors is None or observed is None or len(origin) < 8 or len(points) < 8:
        return None, 0, 'orientation_few_features'
    pairs = cv2.BFMatcher(cv2.NORM_L2).knnMatch(descriptors, observed, k=2)
    candidates = sorted((pair[0] for pair in pairs if len(pair) == 2 and pair[0].distance < .7*pair[1].distance), key=lambda m:m.distance)
    matches, used_origin, used_current = [], set(), set()
    for match in candidates:
        # SIFT can give one physical feature several orientations. Count that
        # location once so duplicated descriptors cannot inflate confidence.
        a = tuple(np.round(origin[match.queryIdx], 1))
        b = tuple(np.round(points[match.trainIdx], 1))
        if a not in used_origin and b not in used_current:
            matches.append(match)
            used_origin.add(a); used_current.add(b)
    if len(matches) < 8:
        return None, len(matches), 'orientation_few_matches'
    a = np.asarray([origin[m.queryIdx] for m in matches])
    b = np.asarray([points[m.trainIdx] for m in matches])
    tolerance = max(2., min(box[2:])*.025)
    matrix, inliers = cv2.estimateAffinePartial2D(a, b, method=cv2.RANSAC,
        ransacReprojThreshold=tolerance, maxIters=2000, confidence=.995, refineIters=10)
    if matrix is None or not np.isfinite(matrix).all():
        return None, 0, 'orientation_no_consensus'
    use = inliers.ravel().astype(bool); count = int(use.sum())
    if count < max(8, math.ceil(len(a)*.6)):
        return None, count, 'orientation_no_consensus'
    spread = np.ptp(a[use], axis=0)
    if min(spread) < min(box[2:])*.15:
        return None, count, 'orientation_few_features'
    scale = np.hypot(matrix[0,0], matrix[1,0])
    if not .3 <= scale <= 3.:
        return None, count, 'orientation_scale_change'
    return matrix, count, 'orientation_matched'


def analyze_orientation(info, config, progress=None, interrupt=None):
    keys = config['keys']
    if not keys:
        raise ValueError('Draw the head area and set its tilt on at least one frame')
    detector = cv2.SIFT_create(nfeatures=1800, contrastThreshold=.025) if config['method']=='features' else None
    templates = {}
    key_by_frame = {key['frame']:key for key in keys}
    times, pts = [], []
    with closing(decode(info)) as source:
        for frame, (pixels, timestamp, relative, _) in enumerate(source):
            if interrupt: interrupt()
            times.append(float(relative*1000)); pts.append(str(timestamp))
            if detector is not None and frame in key_by_frame:
                templates[frame] = _features(pixels, detector, key_by_frame[frame]['head_xywh'])
    if len(times) < 2 or keys[-1]['frame'] >= len(times):
        raise ValueError('Orientation frames must be inside a region containing at least two frames')
    key_frames = [key['frame'] for key in keys]
    key_times = [times[f] for f in key_frames]
    angles = np.unwrap(np.radians([key['angle_degrees'] for key in keys]))*180/np.pi
    centers = np.asarray([[k['head_xywh'][0]+k['head_xywh'][2]/2, k['head_xywh'][1]+k['head_xywh'][3]/2] for k in keys])
    matrices, head_angles, points, quality, reasons, counts = [], [], [], [], [], []
    last_good = None
    # Match to marked frames, not the previous prediction: a bad estimate must
    # not replace the head template and accumulate drift through the whole shot.
    with closing(decode(info)) as source:
        for frame, (pixels, timestamp, relative, _) in enumerate(source):
            if interrupt: interrupt()
            if frame >= len(pts) or str(timestamp) != pts[frame]:
                raise ValueError('Source video timing changed while tracking head orientation')
            right = min(bisect_left(key_frames, frame), len(keys)-1)
            index = right if right==0 or abs(key_frames[right]-frame)<abs(key_frames[right-1]-frame) else right-1
            key = keys[index]; center = centers[index].copy(); angle = float(angles[index])
            status, reason, count = 'manual', 'orientation_keyframe', 0
            if config['method']=='manual':
                angle = float(np.interp(times[frame], key_times, angles))
                center = np.array([np.interp(times[frame], key_times, centers[:,axis]) for axis in (0,1)])
                reason = 'orientation_manual'
            elif frame != key['frame']:
                forward, count, reason = _match(templates[key['frame']], _features(pixels, detector), key['head_xywh'])
                status = 'held'
                if forward is not None:
                    center = transform_points(centers[index][None], forward)[0]
                    angle += math.degrees(math.atan2(forward[1,0], forward[0,0]))
                    if head_angles: angle += 360*round((head_angles[-1]-angle)/360)
                    elapsed = max(1, frame-last_good) if last_good is not None else 1
                    jump = abs(angle-head_angles[-1]) if head_angles else 0
                    if not (0 <= center[0] < info['width'] and 0 <= center[1] < info['height']):
                        reason = 'orientation_outside_frame'
                    elif last_good is not None and jump > min(90, 20*elapsed):
                        reason = 'orientation_large_jump'
                    else:
                        status = 'tracked'
            matrix = rotation_matrix(angle-config['target_degrees'], center)
            arrow = np.array([math.sin(math.radians(angle)), -math.cos(math.radians(angle))])*min(key['head_xywh'][2:])*.35
            pair = [center.tolist(), (center+arrow).tolist()]
            if status=='held' and matrices:
                matrix, angle, pair = matrices[-1], head_angles[-1], points[-1]
            elif status!='held':
                last_good = frame
            matrices.append(np.asarray(matrix).tolist()); head_angles.append(angle); points.append(pair)
            quality.append(status); reasons.append(reason); counts.append(count)
            if progress: progress(frame+1)
    if len(matrices)!=len(times):
        raise ValueError('Source frame count changed while tracking head orientation')
    zero = [[0., 0.] for _ in times]
    return {'times_ms':[t-times[0] for t in times], 'source_times_ms':times, 'source_pts':pts,
        'transform_xy':matrices, 'auto_transform_xy':matrices, 'shift_xy':zero, 'auto_shift_xy':zero,
        'anchor_xy':centers[0].tolist(), 'orientation_degrees':head_angles,
        'points':points, 'visible':[[q!='held']*2 for q in quality], 'quality':quality, 'reasons':reasons, 'inliers':counts,
        'counts':{name:quality.count(name) for name in ('tracked','manual','held')},
        'tracking':{'backend':'Head orientation · SIFT' if detector is not None else 'Manual orientation', 'version':VERSION}}


def run_orientation(info, reference, root, use_cache=True, progress=None, interrupt=None):
    config = normalize_orientation(reference.get('orientation', {}), info['width'], info['height'])
    if not config['keys']:
        raise ValueError('Draw the head area and set its tilt before tracking orientation')
    identifier = digest({'source_id':info['source_id'], 'orientation':config, 'version':VERSION, 'opencv':cv2.__version__})
    directory = Path(root)/identifier
    directory.mkdir(parents=True, exist_ok=True)
    path, destination = directory/'reference.json', directory/'stabilized.mp4'
    if use_cache and path.is_file() and destination.is_file():
        manifest = json.loads(path.read_text()); manifest['cache_hit'] = True
        manifest['config'] = {**reference, 'orientation': config}
        return manifest, destination
    data = analyze_orientation(info, config, progress, interrupt)
    encoded = render(info, data, destination, interrupt, progress)
    manifest = {'id':identifier, 'info':info, 'config':{**reference, 'orientation':config}, 'state':'ready',
                'data':data, 'video':encoded, 'cache_hit':False, 'source_changed':False}
    atomic_json(path, manifest)
    return manifest, destination
