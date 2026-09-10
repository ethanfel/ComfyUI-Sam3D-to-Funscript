"""Explicit point identities and agreement between independently seeded tracks."""
import numpy as np


def reference_keys(config):
    return config.get("keyframes") or [{"frame": 0, "points": config.get("points", [])}]


def validate_keys(keys, frame_count=None, complete=True):
    if not isinstance(keys, list) or not keys or any(not isinstance(k, dict) for k in keys):
        raise ValueError("Reference keyframes must be a nonempty list")
    frames = [k.get("frame") for k in keys]
    if any(type(f) is not int or f < 0 for f in frames) or len(set(frames)) != len(frames):
        raise ValueError("Reference keyframes need distinct nonnegative frame numbers")
    if frame_count is not None and max(frames) >= frame_count:
        raise ValueError("A reference keyframe lies outside this section; remove it or extend the section")
    for key in keys:
        points = np.asarray(key.get("points", []), float)
        if points.size and (points.ndim != 2 or points.shape[1] != 2 or not np.isfinite(points).all()):
            raise ValueError("Reference keyframes need finite [x,y] point coordinates")
    for key in keys:
        pending = key.get("unconfirmed", [])
        if not isinstance(pending, list) or any(type(i) is not int or not 0 <= i < len(key.get("points", [])) for i in pending):
            raise ValueError("Unconfirmed points must identify slots on their keyframe")
        if complete and pending:
            raise ValueError("Review and reposition unconfirmed points on reference keyframes before tracking")
    if complete and (min(len(k.get("points", [])) for k in keys) < 3 or len({len(k["points"]) for k in keys}) != 1):
        raise ValueError("Mark the same numbered points on every reference keyframe (at least three per frame)")


def merge_tracks(tracks, visible, keys, times, tolerance):
    """Join adjacent seeds, correcting endpoint drift in source-time coordinates.

    Each pass keeps the same numbered point identities. A verified endpoint
    permits a gradually applied drift correction. Where both passes are visible
    but disagree after correction, that point is rejected, never silently averaged.
    No hidden model prediction is promoted to a visible observation.
    """
    tracks, visible = np.asarray(tracks, float), np.asarray(visible, bool)
    times = np.asarray(times, float)
    validate_keys(keys, len(times))
    count, frames, points, _ = tracks.shape
    if count != len(keys) or frames != len(times) or visible.shape != tracks.shape[:-1]:
        raise ValueError("Tracking passes do not match reference keyframes")
    output = np.zeros((frames, points, 2))
    accepted = np.zeros((frames, points), bool)
    conflicts = np.zeros((frames, points), bool)
    marks = [k["frame"] for k in keys]
    visible = visible & np.isfinite(tracks).all(-1)
    output[:marks[0]+1] = np.nan_to_num(tracks[0, :marks[0]+1])
    accepted[:marks[0]+1] = visible[0, :marks[0]+1]
    output[marks[-1]:] = np.nan_to_num(tracks[-1, marks[-1]:])
    accepted[marks[-1]:] = visible[-1, marks[-1]:]
    for k, (a, b) in enumerate(zip(marks, marks[1:])):
        weight = ((times[a:b+1]-times[a]) / (times[b]-times[a]))[:, None, None]
        left, right = tracks[k, a:b+1].copy(), tracks[k+1, a:b+1].copy()
        lv, rv = visible[k, a:b+1], visible[k+1, a:b+1]
        # Never use a low-confidence endpoint to correct an otherwise good pass.
        ldelta = np.where(visible[k, b, :, None], np.asarray(keys[k+1]["points"])-tracks[k, b], 0)
        rdelta = np.where(visible[k+1, a, :, None], np.asarray(keys[k]["points"])-tracks[k+1, a], 0)
        left += weight * ldelta
        right += (1-weight) * rdelta
        disagree = lv & rv & (np.linalg.norm(left-right, axis=-1) > tolerance)
        both = lv & rv & ~disagree
        output[a:b+1] = np.nan_to_num(np.where(both[..., None], left*(1-weight)+right*weight,
                                             np.where(lv[..., None], left, right)))
        accepted[a:b+1] = (lv | rv) & ~disagree
        conflicts[a:b+1] = disagree
    # Marked observations are authoritative, including the exact seed frames.
    for key in keys:
        output[key["frame"]] = key["points"]
        accepted[key["frame"]] = True
        conflicts[key["frame"]] = False
    return output, accepted, conflicts
