"""Cached presentation timestamps for frame-accurate timeline navigation."""
from bisect import bisect_left
from fractions import Fraction
import json
from pathlib import Path

import av

from .reference import atomic_json, digest
from .video import fingerprint


def frame_index(info, root):
    """Decode with bounded buffers once; retain numbers only, never video pixels.

    Index the original file so upstream trims keep original, zero-based frame
    numbers. The cache is shared by trims and sessions of the same source file.
    """
    source = info["source"]
    if fingerprint(source["path"]) != source:
        raise ValueError("The source video changed; prepare the timeline again.")
    path = Path(root) / (digest([1, source]) + ".json")
    if path.is_file():
        data = json.loads(path.read_text())
    else:
        times, origin, previous, last_duration = [], None, None, Fraction(0)
        with av.open(source["path"]) as container:
            stream = container.streams.video[0]
            stream.thread_type = "AUTO"
            stream.codec_context.thread_count = 2
            for frame in container.decode(stream):
                if frame.pts is None or frame.time_base is None:
                    raise ValueError("Frame navigation needs video presentation timestamps.")
                pts = frame.pts * frame.time_base
                if previous is not None and pts <= previous:
                    raise ValueError("Frame navigation needs strictly increasing presentation timestamps.")
                if origin is None:
                    origin = pts
                # Round toward the preceding nanosecond. Decimal boundaries must
                # not fall just AFTER a rational PTS and exclude that source frame.
                times.append(int((pts - origin) * 1_000_000_000) / 1_000_000)
                previous = pts
                last_duration = (frame.duration or 0) * frame.time_base
            if not times:
                raise ValueError("The source video contains no timestamped frames.")
            tail = float(last_duration * 1000) if last_duration > 0 else (
                times[-1] - times[-2] if len(times) > 1 else 1000 / float(stream.average_rate or 30))
        if fingerprint(source["path"]) != source:
            raise ValueError("The source video changed while indexing frames; prepare the timeline again.")
        data = {"times_ms": times, "end_ms": times[-1] + tail}
        path.parent.mkdir(parents=True, exist_ok=True)
        atomic_json(path, data)
    low = float(Fraction(info["start"]) * 1000)
    high = min(float(info["end_ms"]), data["end_ms"])
    # Nanosecond rounding above is only a serialization tolerance, not a frame.
    first = bisect_left(data["times_ms"], low - .000002)
    stop = bisect_left(data["times_ms"], high - .000002)
    if first == stop:
        raise ValueError("The selected video trim contains no source frames.")
    times = data["times_ms"][first:stop]
    times[0] = max(low, times[0])
    return {"source_id": info["source_id"], "first_frame": first, "end_frame": stop,
            "times_ms": times, "end_ms": high}
