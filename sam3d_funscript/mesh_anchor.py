"""Bind a painted source-frame area to a fixed, visible SAM3D mesh patch.

Only the patch's centroid is retained per frame. Visibility is tested when
binding, not used to reselect a different surface on subsequent frames.
"""
from bisect import bisect_left
import json
from pathlib import Path

import numpy as np

MASK_ANCHOR = "mask_anchor"
MASK_ANCHOR_INDEX = 72
VERSION = 1
NOTE = ("Painted mask anchor follows a fixed patch of the estimated SAM3D body mesh. "
        "Occluded surfaces are model estimates; rotations still follow the torso, not the local patch.")


def normalize_paint(value, width, height):
    from .reference_mask import normalize_mask
    mask = normalize_mask(value, width, height)
    return {"frame": mask["frame"], "strokes": mask["strokes"]}


def camera_vertices(person):
    vertices = np.asarray(person.get("pred_vertices"), dtype=np.float64)
    camera = np.asarray(person.get("pred_cam_t"), dtype=np.float64).reshape(-1)
    if vertices.ndim != 2 or vertices.shape[1] != 3 or camera.shape != (3,):
        raise ValueError("SAM3D did not return the body mesh required for a painted mask anchor")
    return vertices + camera


def project(points, person, image_size):
    height, width = image_size
    focal = float(np.asarray(person["focal_length"]).reshape(-1)[0])
    if not np.isfinite(focal) or focal <= 0:
        raise ValueError("SAM3D returned invalid camera intrinsics for the painted anchor")
    with np.errstate(divide="ignore", invalid="ignore"):
        return points[..., :2] * focal / points[..., 2:3] + [width / 2, height / 2]


def bind_patch(person, faces, mask, image_size, interrupt=None):
    """Select frontmost painted vertices using perspective-correct face depth."""
    from .reference_mask import raster_mask
    height, width = image_size
    paint = raster_mask(mask, width, height)
    if not paint.any():
        raise ValueError("Paint a body area on the mask anchor's reference frame before processing")
    vertices = camera_vertices(person)
    pixels = project(vertices, person, image_size)
    inside = np.isfinite(vertices).all(axis=1) & np.isfinite(pixels).all(axis=1) & (vertices[:, 2] > .001)
    inside &= (pixels >= 0).all(axis=1) & (pixels <= [width-1, height-1]).all(axis=1)
    candidates = np.flatnonzero(inside)
    xy = np.rint(pixels[candidates]).astype(int)
    candidates = candidates[paint[xy[:, 1], xy[:, 0]] > 0]
    # Bound the one-frame CPU visibility work even for a whole-body painting.
    if len(candidates) > 4096:
        candidates = candidates[np.linspace(0, len(candidates)-1, 4096, dtype=int)]
    faces = np.asarray(faces, dtype=np.int64)
    if faces.ndim != 2 or faces.shape[1] != 3 or not len(faces) or faces.min() < 0 or faces.max() >= len(vertices):
        raise ValueError("SAM3D returned an invalid body mesh topology")
    tri, z = pixels[faces], vertices[faces, 2]
    usable = np.isfinite(tri).all(axis=(1, 2)) & np.isfinite(z).all(axis=1) & (z > .001).all(axis=1)
    tri, z = tri[usable], z[usable]
    a, b, c = tri[:, 0], tri[:, 1], tri[:, 2]
    denominator = (b[:, 1]-c[:, 1])*(a[:, 0]-c[:, 0]) + (c[:, 0]-b[:, 0])*(a[:, 1]-c[:, 1])
    low, high = tri.min(axis=1)-1e-5, tri.max(axis=1)+1e-5
    accepted = []
    for count, index in enumerate(candidates):
        if interrupt and count % 64 == 0:
            interrupt()
        p = pixels[index]
        overlaps = (low <= p).all(axis=1) & (high >= p).all(axis=1) & (np.abs(denominator) > 1e-10)
        aa, bb, cc, d = a[overlaps], b[overlaps], c[overlaps], denominator[overlaps]
        u = ((bb[:, 1]-cc[:, 1])*(p[0]-cc[:, 0]) + (cc[:, 0]-bb[:, 0])*(p[1]-cc[:, 1])) / d
        v = ((cc[:, 1]-aa[:, 1])*(p[0]-cc[:, 0]) + (aa[:, 0]-cc[:, 0])*(p[1]-cc[:, 1])) / d
        bary = np.stack([u, v, 1-u-v], axis=1)
        covers = (bary >= -1e-5).all(axis=1)
        depth = 1 / np.sum(bary[covers] / z[overlaps][covers], axis=1)
        if len(depth) and vertices[index, 2] <= depth.min() + max(.001, vertices[index, 2]*.0001):
            accepted.append(int(index))
    if len(accepted) < 3:
        raise ValueError("The painted area covers fewer than three visible SAM3D mesh vertices. Check the person/ROI, paint a larger body patch, or choose a clearer reference frame.")
    if len(accepted) > 512:
        accepted = np.asarray(accepted)[np.linspace(0, len(accepted)-1, 512, dtype=int)].tolist()
    return {"version": VERSION, "vertex_count": len(vertices), "vertices": accepted}


def patch_position(person, patch, image_size):
    vertices = camera_vertices(person)
    indices = np.asarray(patch["vertices"], dtype=int)
    if len(vertices) != patch["vertex_count"] or indices.ndim != 1 or len(indices) < 3 or indices.min() < 0 or indices.max() >= len(vertices):
        raise ValueError("The painted anchor's mesh topology changed. Reprocess its reference frame.")
    position = vertices[indices].mean(axis=0)
    if not np.isfinite(position).all() or position[2] <= .001:
        return np.full(3, np.nan), np.full(2, np.nan)
    return position, project(position, person, image_size)


def seed_time(region, index):
    times = index["times_ms"]
    first = bisect_left(times, region["start_ms"]-.000002)
    selected = first + region["mask_anchor"]["frame"]
    if selected >= len(times) or times[selected] >= region["end_ms"]-.000002:
        raise ValueError("The mask anchor reference frame is outside its tracking region. Mark a new reference frame.")
    return times[selected]


def prepare_patch(info, region, model_file, root, use_cache=True, mask_video_range=None, interrupt=None):
    from .frame_index import frame_index
    from .reference import atomic_json, digest
    from .video import fingerprint, predict_frame
    import folder_paths
    from comfy_extras.nodes_sam3d_body import SAM3DBody_Predict

    paint = region.get("mask_anchor")
    if not paint or not paint.get("strokes"):
        raise ValueError("This tracking region needs a painted mask anchor. Mark a reference frame and paint a body area.")
    if mask_video_range is not None and region["person"] != 0:
        raise ValueError("A person mask video supplies person 0 only")
    root = Path(root)
    at = seed_time(region, frame_index(info, root / "frame-index"))
    identity = {"version": VERSION, "source": info["source"], "at_ms": at, "paint": paint,
                "person": region["person"], "rois": region["rois"],
                "model": fingerprint(folder_paths.get_full_path_or_raise("detection", model_file)),
                "native_source": fingerprint(Path(__import__(SAM3DBody_Predict.__module__, fromlist=["__file__"]).__file__))}
    if mask_video_range is not None:
        identity["person_mask"] = [fingerprint(mask_video_range[0]), *map(str, mask_video_range[1:])]
    path = root / "mesh-anchors" / (digest(identity)+".json")
    if use_cache and path.is_file():
        return json.loads(path.read_text())
    if interrupt:
        interrupt()
    geometry, people = predict_frame(info, at, model_file, region['rois'], use_cache=use_cache,
                                 mask_video_range=mask_video_range, include_mesh=True, interrupt=interrupt)
    patch = bind_patch(people[region['person']], geometry['faces'], paint,
                       (info['height'], info['width']), interrupt)
    patch.update(id=path.stem, person=region["person"], seed_time_ms=at, identity=identity)
    path.parent.mkdir(parents=True, exist_ok=True)
    atomic_json(path, patch)
    return patch
