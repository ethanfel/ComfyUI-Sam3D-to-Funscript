"""Single-frame anchor inspection using the same landmarks and mesh binding as extraction."""
from bisect import bisect_left
import math

import numpy as np

from .core import anchor_indices, nullable
from .frame_index import frame_index
from .mesh_anchor import MASK_ANCHOR, bind_patch, camera_vertices, patch_position, prepare_patch, project, seed_time
from .mouth import mouth_corners
from .video import predict_frame


def preview_anchor(info, plan, request, model_file, root, *, use_cache=True, mask_video_range=None, interrupt=None, progress=None):
    if not isinstance(request, dict):
        raise ValueError('Choose a tracking region and frame to preview')
    region = next((r for r in plan['tracking'] if r['id'] == request.get('region_id') and r['enabled']), None)
    at = request.get('at_ms')
    if region is None or isinstance(at, bool) or not isinstance(at, (int, float)) or not math.isfinite(at):
        raise ValueError('Choose an enabled tracking region and a valid frame to preview')
    index = frame_index(info, root / 'frame-index')
    frame = bisect_left(index['times_ms'], at-.000002)
    if frame == len(index['times_ms']) or abs(index['times_ms'][frame]-at) > .002 or not region['start_ms']-.000002 <= at < region['end_ms']-.000002:
        raise ValueError('The preview frame must be inside the selected tracking region')
    at = index['times_ms'][frame]
    painted = region['anchor'] == MASK_ANCHOR
    if painted and not region.get('mask_anchor', {}).get('strokes'):
        raise ValueError('Mark a reference frame and paint an area before previewing this anchor')
    if mask_video_range is not None and region['person'] != 0:
        raise ValueError('A person mask video supplies person 0 only')
    reference_at = seed_time(region, index) if painted else None
    patch = None
    if painted and abs(reference_at-at) > .002:
        if progress:
            progress({'stage': 'mask_anchor', 'region_id': region['id']})
        patch = prepare_patch(info, region, model_file, root, use_cache, mask_video_range, interrupt)
    if progress:
        progress({'stage': 'anchor_preview', 'region_id': region['id'], 'frames': 0, 'total_frames': 1})
    geometry, people = predict_frame(info, at, model_file, region['rois'], use_cache=use_cache,
                                 mask_video_range=mask_video_range, include_mesh=painted, interrupt=interrupt,
                                 **({'isolate_subject': True} if region.get('isolate_subject') else {}))
    person = people[region['person']]
    size = info['height'], info['width']
    points = np.full((73, 3), np.nan)
    pixels = np.full((73, 2), np.nan)
    points[:70] = np.asarray(person['pred_keypoints_3d']) + np.asarray(person['pred_cam_t'])
    pixels[:70] = person['pred_keypoints_2d']
    points[70:72], pixels[70:72] = mouth_corners(person, size, geometry['mouth_regressor'])
    surface = []
    if painted:
        if patch is None:
            # The frame prediction above is cached, so binding the reference
            # reuses it; unchanged paint also reuses the saved vertex selection.
            patch = prepare_patch(info, region, model_file, root, True, mask_video_range, interrupt) if use_cache else \
                bind_patch(person, geometry['faces'], region['mask_anchor'], size, interrupt)
        points[72], pixels[72] = patch_position(person, patch, size)
        surface = nullable(project(camera_vertices(person)[patch['vertices']], person, size))
    anchors = []
    for name in [region['anchor'], *region['additional_anchors']]:
        indices = list(anchor_indices(name))
        position = points[indices].mean(axis=0)
        # Project the 3D centroid itself; averaging 2D vertices shifts it with depth.
        xy = project(position, person, size)
        available = bool(np.isfinite(position).all() and np.isfinite(xy).all() and position[2] > .001)
        anchors.append({'name': name, 'primary': name == region['anchor'], 'available': available,
                        'position': position.tolist() if available else None, 'pixel': xy.tolist() if available else None,
                        'indices': indices})
    if not anchors[0]['available']:
        raise ValueError('SAM3D could not locate this anchor on the selected frame. Try another frame or adjust the person ROI.')
    return {'source_id': info['source_id'], 'region_id': region['id'], 'at_ms': at,
            'frame': index['first_frame']+frame, 'person': region['person'], 'width': info['width'], 'height': info['height'],
            'anchors': anchors, 'landmarks': nullable(pixels[:72]), 'surface': surface,
            'reference_at_ms': reference_at, 'surface_points': len(surface)}
