"""Adapt core SAM3D poses and their source VIDEO to the existing motion editor."""

import hashlib
import json
from pathlib import Path

import av
import numpy as np

from .core import PoseSequence
from .video import fingerprint


def core_video_timing(video, frame_count, image_size):
    """Read timestamps for the same frames selected by core Get Video Components.

    Native MHR_POSE_DATA contains no timestamps. Read packet/frame timing without
    allocating another RGB batch; use the core VIDEO's active trim window.
    """
    source = video.get_stream_source()
    if not isinstance(source, (str, Path)):
        raise ValueError("Connect a file-backed VIDEO from core Load Video or Trim Video to the pose adapter.")
    source = fingerprint(source)
    start, duration = video.get_active_trim_window()
    times, timestamps = [], []
    with av.open(source["path"]) as container:
        stream = container.streams.video[0]
        first = next(container.decode(stream), None)
        if first is None or first.pts is None:
            raise ValueError("Source video has no timestamped frames")
        origin = first.pts * first.time_base
        width, height = first.width, first.height
        if first.rotation and int(round(first.rotation / 90)) % 2:
            width, height = height, width
        if tuple(image_size) != (height, width):
            raise ValueError("Pose image size differs from the source video. Connect matching, uncropped video frames to SAM3D.")
        # Match ComfyUI VideoFromFile.get_components_internal's boundary rounding.
        start_pts = int(start / stream.time_base)
        end_pts = int((start + duration) / stream.time_base)
        container.seek(start_pts, stream=stream, backward=True)
        for frame in container.decode(stream):
            if frame.pts is None:
                raise ValueError("Source video lacks frame timestamps")
            if frame.pts < start_pts:
                continue
            if duration and frame.pts >= end_pts:
                break
            value = float((frame.pts * frame.time_base - origin) * 1000)
            if times and value <= times[-1]:
                raise ValueError("Source video timestamps are not strictly increasing")
            times.append(value)
            timestamps.append({"time_ms": value, "pts": frame.pts,
                "time_base": [frame.time_base.numerator, frame.time_base.denominator],
                "origin": [origin.numerator, origin.denominator],
                "frame_duration_ms": float((frame.duration or 0) * frame.time_base * 1000)})
            if len(times) > frame_count:
                break
    if len(times) != frame_count:
        raise ValueError(f"SAM3D returned {frame_count} pose frames but the VIDEO selects {len(times)}"
                         + (" or more" if len(times) > frame_count else "")
                         + ". Connect the same VIDEO branch to Get Video Components and this adapter; do not subsample the image batch.")
    if not times:
        raise ValueError("The selected video contains no frames")
    last_duration = timestamps[-1]["frame_duration_ms"]
    if last_duration <= 0:
        last_duration = 1000 / float(video.get_frame_rate())
    end_ms = times[-1] + last_duration
    if duration:
        end_ms = min(end_ms, float((end_pts * stream.time_base - origin) * 1000))
    return np.asarray(times), {
        "source": source, "timestamps": timestamps, "duration_ms": end_ms,
        "analysed_start_ms": times[0], "analysed_end_ms": times[-1],
        "source_trim": {"start_seconds": start, "duration_seconds": duration},
        "timing": "Source frame PTS matched to core VIDEO trim; original video timeline.",
    }


def adapt_native_poses(mhr_pose_data, video, cache_dir):
    frames = mhr_pose_data["frames"]
    image_size = list(mhr_pose_data["image_size"])
    if len(frames) < 2:
        raise ValueError("At least two SAM3D pose frames are needed for motion authoring")
    times, metadata = core_video_timing(video, len(frames), image_size)
    counts = np.asarray([len(frame) for frame in frames])
    people = int(counts.max())
    if not people:
        raise ValueError("SAM3D detected no people in the selected frames")
    points = np.full((len(frames), people, 70, 3), np.nan, np.float32)
    pixels = np.full((len(frames), people, 70, 2), np.nan, np.float32)
    valid = np.zeros((len(frames), people), bool)
    for index, frame in enumerate(frames):
        for slot, person in enumerate(frame):
            points[index, slot] = np.asarray(person["pred_keypoints_3d"]) + np.asarray(person["pred_cam_t"])
            pixels[index, slot] = person["pred_keypoints_2d"]
            valid[index, slot] = np.isfinite(points[index, slot]).all() and np.isfinite(pixels[index, slot]).all()
    # Changing the number of detections resets authoring spans; it does not infer identity.
    segments = np.r_[0, np.cumsum(counts[1:] != counts[:-1])]
    metadata.update({"adapter": "core-mhr/1", "image_size": image_size,
        "sample_count": len(frames), "units": "metres", "basis": "camera: X right, Y down, Z forward",
        "model": {"provider": "ComfyUI core MHR_POSE_DATA", "selection": "See upstream SAM3D model loader in the workflow."},
        "warnings": ["Person slots follow native pose output order; they do not guarantee identity across detections.",
                     "Validity means finite model output, not visibility or calibrated confidence.",
                     "This adapter does not detect scene cuts. Use core Trim Video to analyse one shot at a time."]})
    digest = hashlib.sha256(json.dumps(metadata, sort_keys=True).encode())
    for array in (times, points, pixels, valid, segments):
        digest.update(array.tobytes())
    cache = Path(cache_dir).resolve() / f"core_{digest.hexdigest()[:24]}.npz"
    metadata.update(cache_path=str(cache), cache_hit=cache.exists())
    sequence = PoseSequence(times, points, pixels, valid, segments, metadata).validate()
    if not cache.exists():
        sequence.save(cache)
    return sequence
