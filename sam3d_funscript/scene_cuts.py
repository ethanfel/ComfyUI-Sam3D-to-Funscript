"""Cached hard-cut annotations, streamed on the source video's presentation clock."""
from collections import OrderedDict
from fractions import Fraction
import json
from pathlib import Path
import time

import av
import numpy as np

from .reference import atomic_json, digest
from .video import fingerprint

VERSION = 1
PRESETS = {"low": (4.5, 22.0), "normal": (3.0, 15.0), "high": (2.3, 10.0)}


def small_frames(info, interrupt=None):
    """Keep only decoder buffers and one downscaled BGR image, including for VFR."""
    start, origin = Fraction(info["start"]), Fraction(info["source_origin"])
    end = Fraction(str(info["end_ms"])) / 1000
    with av.open(info["source"]["path"]) as container:
        stream = container.streams.video[0]
        stream.thread_type = "AUTO"
        stream.codec_context.thread_count = 2
        if start:
            container.seek(int((origin + start) / stream.time_base), stream=stream, backward=True)
        previous = None
        for frame in container.decode(stream):
            if interrupt:
                interrupt()
            if frame.pts is None or frame.time_base is None:
                raise ValueError("Cut detection needs video presentation timestamps")
            at = frame.pts * frame.time_base - origin
            if at < start:
                continue
            if at >= end:
                break
            if previous is not None and at <= previous:
                raise ValueError("Cut detection needs increasing video timestamps")
            previous = at
            scale = min(1, 320 / max(frame.width, frame.height))
            small = frame.reformat(width=max(2, round(frame.width * scale)),
                                   height=max(2, round(frame.height * scale)), format="bgr24")
            yield float(at * 1000), small.to_ndarray()


def _difference(a, b):
    return float(np.abs(a.astype(np.int16) - b.astype(np.int16)).mean())


def _flash_boundary(frames, index):
    """Reject the two edges of an isolated frame that returns to the same image."""
    for left, middle, right in ((index - 1, index, index + 1), (index - 2, index - 1, index)):
        if all(i in frames for i in (left, middle, right)):
            a, b, c = (frames[i][1] for i in (left, middle, right))
            if a.shape == b.shape == c.shape and _difference(a, c) < 5 and _difference(a, b) > 25:
                return True
    return False


def detect_cuts(info, root, sensitivity="normal", use_cache=True, progress=None, interrupt=None):
    if sensitivity not in PRESETS:
        raise ValueError("Cut sensitivity must be low, normal or high")
    try:
        import scenedetect
        from scenedetect import FrameTimecode
        from scenedetect.detectors import AdaptiveDetector
    except ImportError as error:
        raise ValueError("Cut detection needs PySceneDetect. Install the node pack's requirements in the ComfyUI environment.") from error
    settings = {"sensitivity": sensitivity, "adaptive_threshold": PRESETS[sensitivity][0],
                "min_content_val": PRESETS[sensitivity][1], "window_width": 2, "max_dimension": 320}
    key = digest([VERSION, info["source_id"], info["source"], info["start"], info["end_ms"], settings, scenedetect.__version__])
    path = Path(root) / f"{key}.json"
    if interrupt:
        interrupt()
    if fingerprint(info["source"]["path"]) != info["source"]:
        raise ValueError("The source video changed; prepare the timeline again before detecting cuts")
    if use_cache and path.is_file():
        result = json.loads(path.read_text())
        if result.get("source_id") == info["source_id"]:
            return {**result, "cache_hit": True}
    detector = AdaptiveDetector(adaptive_threshold=settings["adaptive_threshold"],
        min_content_val=settings["min_content_val"], window_width=2, min_scene_len=0)
    recent, times = OrderedDict(), []
    begin = time.monotonic()
    last_progress, count, last = begin - 1, 0, None

    def feed(index, at, pixels):
        recent[index] = (at, pixels)
        while len(recent) > 8:
            recent.popitem(last=False)
        # Frame numbers are only detector indices. Returned cuts are mapped to
        # decoded PTS, never inferred from the average frame rate.
        for cut in detector.process_frame(FrameTimecode(index, fps=30.0), pixels):
            target = cut.get_frames()
            when = recent.get(target, (None, None))[0]
            if when is not None and target > 2 and not _flash_boundary(recent, target):
                if not times or when > times[-1]:
                    times.append(when)

    for at, pixels in small_frames(info, interrupt):
        if not count:
            # Pad the rolling window so cuts near either trim edge are tested.
            feed(0, None, pixels)
            feed(1, None, pixels)
        feed(count + 2, at, pixels)
        count += 1
        last = pixels
        now = time.monotonic()
        if progress and now - last_progress >= .5:
            progress({"stage": "scene_cuts", "frames": count, "cuts": len(times),
                      "position_ms": at, "start_ms": float(Fraction(info["start"]) * 1000), "end_ms": info["end_ms"]})
            last_progress = now
    if last is not None:
        feed(count + 2, None, last)
        feed(count + 3, None, last)
    else:
        raise ValueError("No video frames in the selected source trim")
    if interrupt:
        interrupt()
    if fingerprint(info["source"]["path"]) != info["source"]:
        raise ValueError("The source video changed during cut detection; prepare the timeline again")
    result = {"version": VERSION, "source_id": info["source_id"], "detector": "PySceneDetect AdaptiveDetector",
              "detector_version": scenedetect.__version__, "settings": settings, "times_ms": times,
              "frames": count, "elapsed_seconds": round(time.monotonic() - begin, 3), "cache_hit": False}
    path.parent.mkdir(parents=True, exist_ok=True)
    atomic_json(path, result)
    return result
