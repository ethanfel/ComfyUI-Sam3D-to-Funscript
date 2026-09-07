"""Bounded video decoding, exact presentation timestamps and native SAM3D inference."""

from fractions import Fraction
from contextlib import closing, nullcontext
import hashlib
import json
import math
from pathlib import Path
import time

import av
import numpy as np

from .core import PoseSequence
from .masks import MaskVideoReader, timestamp_seconds
from .mouth import mouth_corners, mouth_regressor

CACHE_VERSION = 2


def fingerprint(path):
    path = Path(path).resolve(strict=True)
    stat = path.stat()
    return {"path": str(path), "size": stat.st_size, "mtime_ns": stat.st_mtime_ns}


def video_input_range(video, start_seconds=0.0, duration_seconds=0.0):
    """Resolve a lazy core VIDEO without materializing its image components."""
    source = video.get_stream_source()
    if not isinstance(source, (str, Path)):
        raise ValueError("Connect a file-backed VIDEO from core Load Video or Trim Video for streaming analysis.")
    if not np.isfinite(start_seconds) or start_seconds < 0 or not np.isfinite(duration_seconds) or duration_seconds < 0:
        raise ValueError("Video analysis start and duration must be finite and nonnegative")
    path = Path(source).resolve(strict=True)
    trim_start, trim_duration = video.get_active_trim_window()
    with av.open(str(path)) as container:
        stream = container.streams.video[0]
        first = next(container.decode(stream), None)
        if first is None or first.pts is None:
            raise ValueError("Source video has no timestamped frames")
        if first.rotation:
            raise ValueError("Streaming analysis needs video rotation baked into the pixels before loading.")
        origin = first.pts * first.time_base
        source_size = (first.width, first.height)
        # Core trims use source-stream PTS; our extraction uses time from the first frame.
        base = max(Fraction(0), int(trim_start / stream.time_base) * stream.time_base - origin)
        limit = int((trim_start + trim_duration) / stream.time_base) * stream.time_base - origin if trim_duration else None
    if video.get_dimensions() != source_size:
        raise ValueError("Connect an uncropped VIDEO; use this node's person ROIs to crop for SAM3D inference.")
    start = base + Fraction(str(start_seconds))
    end = start + Fraction(str(duration_seconds)) if duration_seconds else None
    if limit is not None:
        end = min(end, limit) if end is not None else limit
    if end is not None and end <= start:
        raise ValueError("Analysis start lies outside the upstream VIDEO trim")
    return path, start, end - start if end is not None else Fraction(0)


def parse_rois(value):
    """Ordered static normalized xywh rectangles; a slot is not a tracker ID."""
    boxes = json.loads(value) if isinstance(value, str) else value
    if not isinstance(boxes, list) or not 1 <= len(boxes) <= 8:
        raise ValueError("ROIs must be a list of 1–8 normalized [x,y,width,height] rectangles")
    for box in boxes:
        if len(box) != 4 or not all(isinstance(x, (float, int)) and np.isfinite(x) for x in box):
            raise ValueError("Each ROI needs four finite numbers")
        x, y, w, h = box
        if min(x, y) < 0 or min(w, h) <= 0 or x + w > 1.000001 or y + h > 1.000001:
            raise ValueError("ROIs must lie inside the image in normalized 0–1 coordinates")
    return [[float(value) for value in box] for box in boxes]


def video_frames(path, sample_fps=16.0, start_seconds=0.0, duration_seconds=0.0, max_frames=2000):
    """Yield RGB frames on a sampling grid, retaining actual frame PTS, never invented FPS times."""
    if not math.isfinite(sample_fps) or sample_fps < 0 or not math.isfinite(start_seconds) or start_seconds < 0 or not math.isfinite(duration_seconds) or duration_seconds < 0 or max_frames < 2:
        raise ValueError("Invalid video range/sampling settings")
    start = Fraction(str(start_seconds))
    end = start + Fraction(str(duration_seconds)) if duration_seconds else None
    step = 1 / Fraction(str(sample_fps)) if sample_fps else None
    due = start
    origin, previous, count = None, None, 0
    with av.open(str(path)) as container:
        stream = container.streams.video[0]
        for frame in container.decode(stream):
            if frame.pts is None or frame.time_base is None:
                raise ValueError("Video lacks presentation timestamps; remux it before extraction")
            presentation = frame.pts * frame.time_base
            if origin is None:
                origin = presentation
            t = presentation - origin
            if previous is not None and t <= previous:
                raise ValueError("Video presentation timestamps are not strictly increasing")
            previous = t
            if end is not None and t >= end:
                break
            if t < due:
                continue
            if count >= max_frames:
                break
            if step:
                due = start + ((t - start) // step + 1) * step
            yield frame.to_ndarray(format="rgb24"), {
                "time_ms": float(t * 1000), "pts": frame.pts,
                "time_base": [frame.time_base.numerator, frame.time_base.denominator],
                "origin": [origin.numerator, origin.denominator],
                "frame_duration_ms": float((frame.duration or 0) * frame.time_base * 1000),
            }
            count += 1


def extract_video(video_path, model_file, cache_dir, sample_fps=16.0, start_seconds=0.0,
                  duration_seconds=0.0, max_frames=2000, rois_json="[[0,0,1,1]]",
                  batch_size=8, fov=0.0, use_cache=True, mask_video_range=None):
    # Imports stay here so the geometry/editor can run without ComfyUI or CUDA.
    import torch
    import folder_paths
    import comfy.model_management
    from comfy_extras.nodes_sam3d_body import SAM3DBody_Loader, SAM3DBody_Predict

    rois = [] if mask_video_range is not None else parse_rois(rois_json)
    people_count = 1 if mask_video_range is not None else len(rois)
    model_path = folder_paths.get_full_path_or_raise("detection", model_file)
    key = {"cache_version": CACHE_VERSION, "video": fingerprint(video_path), "model": fingerprint(model_path),
           "sample_fps": float(sample_fps), "start_seconds": float(start_seconds), "duration_seconds": float(duration_seconds),
           "max_frames": int(max_frames), "rois": rois, "fov": float(fov), "batch_size": int(batch_size),
           "native_source": fingerprint(Path(__import__(SAM3DBody_Predict.__module__, fromlist=["__file__"]).__file__))}
    if mask_video_range is not None:
        mask_path, mask_start, mask_duration = mask_video_range
        key["mask_video"] = {"version": 1, "source": fingerprint(mask_path),
            "start_seconds": float(mask_start), "duration_seconds": float(mask_duration), "threshold": 128}
    digest = hashlib.sha256(json.dumps(key, sort_keys=True).encode()).hexdigest()[:24]
    cache = Path(cache_dir).resolve() / f"{digest}.npz"
    if use_cache and cache.exists():
        sequence = PoseSequence.load(cache)
        sequence.metadata = {**sequence.metadata, "cache_hit": True, "cache_path": str(cache)}
        if duration_seconds:
            sequence.metadata["duration_ms"] = min(sequence.metadata["duration_ms"], float((start_seconds + duration_seconds) * 1000))
        return sequence
    started = time.perf_counter()
    model, regressor = None, None
    rows, timestamps, segments = [], [], []
    images, batch_times = [], []
    batch_masks, mask_boxes = [], []
    previous_thumbnail, segment = None, 0
    image_size = None
    def flush():
        nonlocal model, regressor
        if not images:
            return
        comfy.model_management.throw_exception_if_processing_interrupted()
        height, width = images[0].shape[:2]
        active = [i for i in range(len(images)) if mask_video_range is None or batch_masks[i] is not None]
        predictions = {}
        if active:
            if model is None:
                model = SAM3DBody_Loader.execute(model_file).result[0]
                regressor = mouth_regressor(model)
            bboxes = [{"x": x * width, "y": y * height, "width": w * width, "height": h * height} for x, y, w, h in rois]
            batch = torch.from_numpy(np.stack([images[i] for i in active]).astype(np.float32) / 255.0)
            track_data = None
            if mask_video_range is not None:
                track_data = {"packed_masks": torch.from_numpy(np.stack([batch_masks[i] for i in active])[:, None])}
            prediction = SAM3DBody_Predict.execute(model, batch, track_data=track_data, bboxes=bboxes,
                run_hand_refinement=False, fov=fov, batch_size=batch_size).result[0]
            if len(prediction["frames"]) != len(active):
                raise ValueError("SAM3D returned a different number of frames than the input batch")
            predictions = dict(zip(active, prediction["frames"]))
        for i in range(len(images)):
            points = np.full((people_count, 72, 3), np.nan, dtype=np.float32)
            pixels = np.full((people_count, 72, 2), np.nan, dtype=np.float32)
            valid = np.zeros(people_count, dtype=bool)
            people = predictions.get(i, [])
            if i in predictions and len(people) != people_count:
                raise ValueError("SAM3D returned a different number of people than ROI slots")
            for slot, person in enumerate(people):
                points[slot, :70] = np.asarray(person["pred_keypoints_3d"]) + np.asarray(person["pred_cam_t"])
                pixels[slot, :70] = person["pred_keypoints_2d"]
                valid[slot] = np.isfinite(points[slot, :70]).all() and np.isfinite(pixels[slot, :70]).all()
                points[slot, 70:], pixels[slot, 70:] = mouth_corners(person, (height, width), regressor)
            rows.append((points, pixels, valid))
        timestamps.extend(batch_times)
        print(f"SAM3D Funscript: extracted {len(rows)} samples", flush=True)
        images.clear()
        batch_times.clear()
        batch_masks.clear()
    mask_reader = MaskVideoReader(*mask_video_range) if mask_video_range is not None else nullcontext(None)
    with mask_reader as masks, closing(video_frames(video_path, sample_fps, start_seconds, duration_seconds, max_frames)) as frames:
        for rgb, timing in frames:
            comfy.model_management.throw_exception_if_processing_interrupted()
            if image_size is not None and rgb.shape[:2] != image_size:
                raise ValueError("Video changes resolution; split it into constant-resolution clips")
            image_size = rgb.shape[:2]
            if masks is not None:
                packed, box = masks.at(timestamp_seconds(timing), image_size)
                batch_masks.append(packed)
                mask_boxes.append([box])
            thumbnail = rgb[::max(1, rgb.shape[0] // 32), ::max(1, rgb.shape[1] // 32)].astype(np.float32) / 255
            if previous_thumbnail is not None and np.mean(np.abs(thumbnail - previous_thumbnail)) > 0.22:
                segment += 1
            previous_thumbnail = thumbnail
            segments.append(segment)
            images.append(rgb)
            batch_times.append(timing)
            if len(images) >= max(1, batch_size // people_count):
                flush()
    flush()
    if len(rows) < 2:
        raise ValueError("Selected video range contains fewer than two sampled frames")
    times = np.array([t["time_ms"] for t in timestamps])
    # Export ends at the analysed range, not at an unanalysed tail of the video.
    duration = times[-1] + timestamps[-1]["frame_duration_ms"]
    if duration_seconds:
        duration = min(duration, float((start_seconds + duration_seconds) * 1000))
    if mask_video_range is not None and mask_duration:
        duration = min(duration, float((mask_start + mask_duration) * 1000))
    metadata = {"source": key["video"], "model": key["model"], "image_size": list(image_size),
                "duration_ms": duration, "analysed_start_ms": times[0], "analysed_end_ms": times[-1],
                "timestamps": timestamps, "rois": rois, "cache_hit": False, "cache_path": str(cache),
                "inference_seconds": time.perf_counter() - started, "sample_count": len(rows),
                "settings": key, "units": "metres", "basis": "camera: X right, Y down, Z forward",
                "extra_landmarks": {"70": "right_outer_mouth_corner", "71": "left_outer_mouth_corner"},
                "warnings": ["Static ROI slots are not identity tracking. Inspect overlap, occlusion and subject changes.",
                             "Validity means finite model output, not visibility or calibrated confidence.",
                             "Cut detection is a thumbnail-change heuristic; review missed cuts and false positives."]}
    if mask_video_range is not None:
        metadata.update(mask_video=key["mask_video"], mask_boxes=mask_boxes,
                        missing_mask_samples=sum(boxes[0] is None for boxes in mask_boxes))
        metadata["warnings"][0] = "Person 0 follows the supplied mask video. Mask identity switches are not detected; review overlap and occlusion."
        metadata["warnings"].append("Black mask frames are missing samples; output holds across gaps. One mask video must identify one person.")
    if len(rows) >= max_frames:
        metadata["warnings"].append("Sample limit reached; the analysed interval may stop before the video ends.")
    sequence = PoseSequence(times, np.stack([r[0] for r in rows]), np.stack([r[1] for r in rows]),
                            np.stack([r[2] for r in rows]), np.array(segments), metadata).validate()
    sequence.save(cache)
    return sequence
