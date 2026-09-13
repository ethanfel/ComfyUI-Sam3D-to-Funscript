"""File-backed reference stabilization, separate tracking and correction caches."""

from contextlib import closing
from fractions import Fraction
import hashlib
import json
from pathlib import Path
import time
import uuid

import av
import numpy as np

from .video import fingerprint
from .stabilization import (stream_windows, translations, correct_sections, similarities,
                            source_transforms, transform_points, inverse_transforms)
from .reference_keyframes import reference_keys, validate_keys, merge_tracks

VERSION = 1


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, allow_nan=False).encode()).hexdigest()[:24]


def atomic_json(path, value):
    path = Path(path)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        temporary.write_text(json.dumps(value, allow_nan=False, separators=(",", ":")))
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def source_info(path, start=0, duration=0):
    with av.open(str(path)) as container:
        stream = container.streams.video[0]
        first = next(container.decode(stream))
        origin = first.pts * first.time_base
        end = float(stream.duration * stream.time_base) if stream.duration else float(container.duration or 0) / av.time_base
        info = {"source": fingerprint(path), "width": first.width, "height": first.height,
                "start": str(start), "duration": str(duration), "source_origin": str(origin),
                "rate": str(stream.average_rate or stream.guessed_rate or 30), "time_base": str(stream.time_base),
                "end_ms": float((start+duration) * 1000) if duration else end*1000}
    info["source_id"] = digest([info["source"], str(start), str(duration)])
    return info


def decode(info, crop=None):
    """One BGR frame, absolute PTS, source-relative time, and duration at a time."""
    start, duration, origin = map(Fraction, (info["start"], info["duration"], info["source_origin"]))
    end = start + duration if duration else None
    with av.open(info["source"]["path"]) as container:
        stream = container.streams.video[0]
        stream.thread_type = "AUTO"
        stream.codec_context.thread_count = 4
        if start:
            container.seek(int((origin+start)/stream.time_base), stream=stream, backward=True)
        previous = None
        for frame in container.decode(stream):
            if frame.pts is None:
                raise ValueError("Reference video needs presentation timestamps")
            pts = frame.pts * frame.time_base
            relative = pts-origin
            if relative < start:
                continue
            if end is not None and relative >= end:
                break
            if previous is not None and pts <= previous:
                raise ValueError("Reference video timestamps must increase")
            previous = pts
            pixels = frame.to_ndarray(format="bgr24")
            if crop is not None:
                x, y, w, h = crop
                pixels = pixels[y:y+h, x:x+w].copy()
            yield pixels, pts, relative, (frame.duration or 0) * frame.time_base


def config_for_source(raw, info):
    config = json.loads(raw) if isinstance(raw, str) else raw
    if not isinstance(config, dict):
        raise ValueError("Reference settings must be an object")
    # Points and corrections are source-specific, including the trim. Never reuse
    # them silently when the upstream video changes.
    changed = bool(config.get("source_id") and config["source_id"] != info["source_id"])
    if changed:
        config = {}
    crop = config.get("crop_xywh", [0, 0, info["width"], info["height"]])
    if len(crop) != 4 or not all(isinstance(v, (int, float)) and np.isfinite(v) for v in crop):
        raise ValueError("Crop needs four pixel coordinates [x,y,width,height]")
    crop = [int(round(v)) for v in crop]
    x, y, w, h = crop
    if min(x, y) < 0 or min(w, h) < 2 or x+w > info["width"] or y+h > info["height"]:
        raise ValueError("Reference crop must lie inside the source image")
    points = config.get("points", [])
    if points:
        q = np.asarray(points, float)
        if q.ndim != 2 or q.shape[1] != 2 or not np.isfinite(q).all() or np.any(q < [x, y]) or np.any(q > [x+w-1, y+h-1]):
            raise ValueError("Reference points must lie inside the selected crop")
        points = q.tolist()
    mode = config.get("tracking_mode", "online")
    if mode not in ("online", "offline"):
        raise ValueError("Reference tracking mode must be online or offline")
    keys = config.get("keyframes")
    if keys is not None:
        validate_keys(keys, complete=False)
        keys = sorted(({"frame": k["frame"], "points": k.get("points", []), **({"unconfirmed": k["unconfirmed"]} if k.get("unconfirmed") else {})} for k in keys), key=lambda k: k["frame"])
        for key in keys:
            q = np.asarray(key["points"], float)
            if q.size and (np.any(q < [x, y]) or np.any(q > [x+w-1, y+h-1])):
                raise ValueError("Reference keyframe points must lie inside the selected crop")
        points = keys[0]["points"]
    sections = config.get("sections", [])
    if not isinstance(sections, list) or any(not isinstance(s, dict) or not isinstance(s.get("keys", []), list) for s in sections):
        raise ValueError("Manual sections need lists of correction keys")
    sections = [{"id": str(s.get("id", f"section_{i}")), "name": str(s.get("name", f"Section {i+1}")),
                 "keys": s.get("keys", [])} for i, s in enumerate(sections)]
    if len({s["id"] for s in sections}) != len(sections):
        raise ValueError("Manual section IDs must be distinct")
    result = {"version": VERSION, "source_id": info["source_id"], "crop_xywh": crop,
              "points": points, "sections": sections}
    if keys is not None:
        result["keyframes"] = keys
    if "tracking_mode" in config:
        result["tracking_mode"] = mode
    if "transform_mode" in config:
        if config['transform_mode'] not in ('translation', 'similarity'):
            raise ValueError('Stabilization correction must be translation or similarity')
        result['transform_mode'] = config['transform_mode']
    if config.get("point_mask") is not None:
        from .reference_mask import normalize_mask
        result["point_mask"] = normalize_mask(config["point_mask"], info["width"], info["height"])
    if 'auto_points' in config:
        stamp = config['auto_points']
        if not isinstance(stamp, dict) or set(stamp) != {'mask', 'keys'} or any(not isinstance(v, str) for v in stamp.values()):
            raise ValueError('Invalid generated reference point metadata')
        result['auto_points'] = dict(stamp)
    return result, changed


def tracking_key(info, config, checkpoint):
    # Manual correction changes deliberately do not invalidate GPU inference.
    value = {"version": VERSION, "source_id": info["source_id"], "crop": config["crop_xywh"],
             "points": config["points"], "checkpoint": fingerprint(checkpoint)}
    if config.get("keyframes") is not None or config.get("tracking_mode") == "offline":
        value.update(keyframes=reference_keys(config), tracking_mode=config.get("tracking_mode", "online"), keyframe_version=1)
    return digest(value)


def track(info, config, checkpoint, destination, progress=None, interrupt=None):
    keys = reference_keys(config)
    if len(keys) > 1 or keys[0]["frame"] != 0 or config.get("tracking_mode") == "offline":
        from .reference_tracker import track_keyframes
        return track_keyframes(info, config, checkpoint, destination, progress, interrupt)
    import torch
    try:
        from cotracker.predictor import CoTrackerOnlinePredictor
    except ImportError as error:
        raise RuntimeError("CoTracker3 is optional. Install it with this pack's scripts/install_reference_tracker.py using the ComfyUI Python environment.") from error
    import comfy.model_management as management

    device = management.get_torch_device()
    management.free_memory(3 * 1024**3, device)
    crop = config["crop_xywh"]
    query = np.asarray(config["points"], np.float32) - crop[:2]
    model = None
    started = time.perf_counter()
    times, pts, frame_durations = [], [], []
    try:
        model = CoTrackerOnlinePredictor(checkpoint=str(checkpoint), window_len=16).eval().to(device)
        queries = torch.as_tensor(np.column_stack((np.zeros(len(query)), query)), dtype=torch.float32, device=device)[None]
        # ComfyUI's executor owns inference mode. The optional upstream predictor
        # also supplies its own inference boundary; no global torch settings change.
        with closing(decode(info, crop)) as source:
            for window, added in stream_windows(source, model.step):
                if interrupt:
                    interrupt()
                pixels = np.stack([item[0][..., ::-1] for item in window])
                tensor = torch.from_numpy(pixels).permute(0, 3, 1, 2)[None].to(device=device, dtype=torch.float32)
                if not times:
                    model(tensor[:, :1], is_first_step=True, queries=queries, add_support_grid=True)
                tracks, visible = model(tensor, add_support_grid=True)
                pts.extend(str(item[1]) for item in window[-added:])
                times.extend(float(item[2]*1000) for item in window[-added:])
                frame_durations.extend(float(item[3]*1000) for item in window[-added:])
                if progress:
                    progress(len(times))
                del window, pixels, tensor
        if len(times) < 2:
            raise ValueError("Reference tracking needs at least two frames")
        points = tracks[0, :len(times)].cpu().numpy() + crop[:2]
        visible = visible[0, :len(times)].cpu().numpy()
        if points.shape != (len(times), len(query), 2):
            raise RuntimeError("CoTracker output does not match the source frame count")
        record = {"source_pts": pts, "frame_durations_ms": frame_durations,
                  "tracking_seconds": time.perf_counter()-started, "model_input_window_frames": model.step*2,
                  "backend": "CoTracker3 online", "checkpoint": fingerprint(checkpoint)}
        temporary = destination.with_name(destination.stem + "." + uuid.uuid4().hex + ".npz")
        try:
            np.savez_compressed(temporary, points=points, visible=visible, source_times_ms=times, metadata=json.dumps(record))
            temporary.replace(destination)
        finally:
            temporary.unlink(missing_ok=True)
    finally:
        if model is not None:
            model.to("cpu")
        del model


def analyze(cache, info, config, tolerance=12, max_step=48, reference_masks=None, interrupt=None):
    with np.load(cache, allow_pickle=False) as data:
        source_times = data["source_times_ms"]
        metadata = json.loads(str(data["metadata"]))
        conflicts = None
        if "passes" in data:
            points, visible, conflicts = merge_tracks(data["passes"], data["pass_visible"], reference_keys(config), source_times, tolerance)
        else:
            points, visible = data["points"], data["visible"]
    times = source_times-source_times[0]
    x, y, w, h = config["crop_xywh"]
    visible &= np.isfinite(points).all(-1) & (points >= [x, y]).all(-1) & (points <= [x+w-1, y+h-1]).all(-1)
    mask_rejected = np.zeros(len(points), bool)
    if reference_masks:
        import cv2
        from .reference_mask import MaskReader
        margin = int(round(config.get("point_mask", {}).get("margin", 6)))
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2*margin+1, 2*margin+1)) if margin else None
        with closing(MaskReader(reference_masks["manifest_path"])) as masks:
            if masks.manifest["info"]["source_id"] != info["source_id"] or masks.manifest["source_pts"] != metadata["source_pts"]:
                raise ValueError("Reference mask timing changed; propagate the mask again")
            for i, positions in enumerate(points):
                if interrupt: interrupt()
                image = masks.image(i)
                # A small source-pixel margin keeps texture holes / uncertain edges
                # from rejecting otherwise consistent point trajectories.
                if kernel is not None: image = cv2.dilate(image, kernel)
                pixels = np.rint(np.nan_to_num(positions)).astype(np.int64)
                inside = (pixels >= 0).all(-1) & (pixels < [info["width"], info["height"]]).all(-1)
                accepted = np.zeros(len(positions), bool)
                accepted[inside] = image[pixels[inside, 1], pixels[inside, 0]] >= 128
                mask_rejected[i] = np.count_nonzero(visible[i]) >= 3 and np.count_nonzero(visible[i] & accepted) < 3
                visible[i] &= accepted
    keys = reference_keys(config) if conflicts is not None else []
    baseline = np.asarray(keys[0]["points"]) if keys else None
    marked = [k["frame"] for k in keys]
    anchor = (baseline if baseline is not None else points[0]).mean(axis=0)
    matrices = None
    if config.get('transform_mode') == 'similarity':
        matrices, valid, counts, residual, reasons = similarities(points, visible, tolerance=tolerance,
            max_step=max_step, reference=baseline, marked_frames=marked)
        shifts = transform_points(anchor[None], inverse_transforms(matrices))[:, 0]-anchor
    else:
        shifts, valid, counts, residual, reasons = translations(points, visible, list(range(points.shape[1])), tolerance=tolerance, max_step=max_step,
            reference=baseline, marked_frames=marked)
    if conflicts is not None:
        for i in range(len(reasons)):
            if not valid[i] and conflicts[i].any():
                reasons[i] = "tracking_passes_disagree"
    for i in np.flatnonzero(mask_rejected & ~valid):
        reasons[i] = "outside_reference_mask"
    corrected, quality = correct_sections(times, shifts, valid, anchor, config["sections"])
    transforms = {}
    if matrices is not None:
        automatic = matrices.copy()
        # Manual center keys move the center without inventing angle or scale.
        matrices[:, :, 2] += anchor-transform_points((anchor+corrected)[:, None], matrices)[:, 0]
        transforms = {'auto_transform_xy': automatic.tolist(), 'transform_xy': matrices.tolist()}
    for frame in marked:
        if valid[frame] and quality[frame] != "manual":
            quality[frame] = "manual"
            reasons[frame] = "reference_keyframe"
    return {**transforms, "times_ms": times.tolist(), "source_times_ms": source_times.tolist(), "source_pts": metadata["source_pts"],
            "points": np.where(np.isfinite(points), points, 0).tolist(), "visible": visible.tolist(),
            "auto_shift_xy": shifts.tolist(), "shift_xy": corrected.tolist(), "anchor_xy": anchor.tolist(),
            "quality": quality.tolist(), "reasons": reasons, "inliers": counts.tolist(),
            "tracking": metadata, "pass_conflicts": conflicts.sum(axis=1).tolist() if conflicts is not None else [],
            "counts": {key: int((quality == key).sum()) for key in ("tracked", "manual", "held")}}


def render(info, data, destination, interrupt=None, progress=None):
    import cv2

    matrices = source_transforms(data)
    corners = np.array([[0, 0], [info['width'], 0], [0, info['height']], [info['width'], info['height']]])
    mapped = transform_points(corners, matrices)
    extent = np.maximum(-mapped.min(axis=(0, 1)), mapped.max(axis=(0, 1))-[info['width'], info['height']])
    padding = (np.ceil((np.maximum(extent, 0)+8)/2)*2).astype(int)
    size = (np.ceil((np.array([info["width"], info["height"]])+2*padding)/2)*2).astype(int)
    pts = list(map(Fraction, data["source_pts"]))
    base = Fraction(info["time_base"])
    output_pts = [timestamp-pts[0] for timestamp in pts]
    temporary = destination.with_name("stabilized." + uuid.uuid4().hex + ".mp4")
    try:
        with av.open(str(temporary), "w", options={"movflags": "+faststart", "movie_timescale": str(base.denominator)}) as container:
            stream = container.add_stream("libx264", rate=Fraction(info["rate"]))
            stream.width, stream.height = map(int, size)
            stream.pix_fmt = "yuv420p"
            stream.time_base = stream.codec_context.time_base = base
            stream.options = {"crf": "16", "preset": "fast"}
            count = 0
            with closing(decode(info)) as source:
                for index, (pixels, timestamp, _, duration) in enumerate(source):
                    if interrupt:
                        interrupt()
                    if index >= len(pts) or timestamp != pts[index]:
                        raise ValueError("Source timeline changed after tracking")
                    matrix = matrices[index].copy()
                    matrix[:, 2] += padding
                    corrected = cv2.warpAffine(pixels, matrix, tuple(map(int, size)), borderMode=cv2.BORDER_CONSTANT)
                    frame = av.VideoFrame.from_ndarray(corrected, format="bgr24")
                    frame.pts, frame.time_base = int(output_pts[index]/base), base
                    frame.duration = int(duration/base) if duration else 0
                    for packet in stream.encode(frame):
                        container.mux(packet)
                    count += 1
                    if progress:
                        progress(count)
            if count != len(pts):
                raise ValueError("Source frame count changed after tracking")
            for packet in stream.encode():
                container.mux(packet)
        with av.open(str(temporary)) as container:
            # Verifying packet PTS avoids another RGB decode and also accepts B-frame reordering.
            actual = sorted(packet.pts*packet.time_base for packet in container.demux(video=0) if packet.pts is not None)
        if actual != output_pts:
            raise RuntimeError("Stabilized output did not preserve source frame timing")
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)
    return {"padding_xy": padding.tolist(), "size_wh": size.tolist(), "frames": len(pts),
            "exact_frame_timing": True, "source_offset_ms": float(pts[0]*1000), "audio": "omitted"}


def run_reference(path, start, duration, raw_config, checkpoint, root, tolerance=12, max_step=48,
                  use_cache=True, progress=None, interrupt=None, reference_masks=None):
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    info = source_info(path, start, duration)
    config, changed = config_for_source(raw_config, info)
    from .reference_tracker import resolve_checkpoint
    checkpoint = resolve_checkpoint(checkpoint, config.get("tracking_mode", "online"))
    render_config = {**config}
    render_config.pop('auto_points', None)
    if config.get("point_mask"):
        render_config["point_mask"] = {k: v for k, v in config["point_mask"].items() if k not in ("spacing", "limit")}
    identifier = digest({"source_id": info["source_id"], "config": render_config, "tolerance": tolerance, "mask": reference_masks,
                         "max_step": max_step, "checkpoint": fingerprint(checkpoint) if checkpoint else None, "version": VERSION})
    directory = root / identifier
    directory.mkdir(exist_ok=True)
    manifest = {"id": identifier, "info": info, "config": config, "state": "select_points",
                "source_changed": changed, "tolerance": tolerance, "max_step": max_step}
    if not any(k["points"] for k in reference_keys(config)):
        # The output node can display its editor while blocking dependent nodes.
        with closing(decode(info)) as source:
            first = next(source)
        manifest["first_source_ms"] = float(first[1]*1000)
        from .frame_index import frame_index
        manifest["frame_index"] = frame_index(info, root / "frame-index")
        atomic_json(directory / "reference.json", manifest)
        return manifest, None
    if checkpoint is None:
        mode = config.get("tracking_mode", "online")
        raise ValueError(f"CoTracker3 {mode} checkpoint is missing; run scripts/install_reference_tracker.py --comfy-root /path/to/ComfyUI --mode {mode}")
    validate_keys(reference_keys(config))
    cache_root = root / "tracks"
    cache_root.mkdir(exist_ok=True)
    cache = cache_root / (tracking_key(info, config, checkpoint)+".npz")
    hit = use_cache and cache.exists()
    if not hit:
        track(info, config, checkpoint, cache, progress, interrupt)
    destination = directory / "stabilized.mp4"
    previous = directory / "reference.json"
    if hit and destination.exists() and previous.exists():
        manifest = json.loads(previous.read_text())
        manifest["cache_hit"] = True
        manifest["config"] = config
        atomic_json(previous, manifest)
        return manifest, destination
    data = analyze(cache, info, config, tolerance, max_step, reference_masks, interrupt)
    encoded = render(info, data, destination, interrupt, progress)
    manifest.update(state="ready", data=data, video=encoded, cache_hit=hit, tracking_cache=str(cache))
    atomic_json(previous, manifest)
    return manifest, destination
