"""Reference-point translation and bounded online frame windows."""

from collections import deque
import numpy as np


def correct_sections(times_ms, shifts, valid, anchor, sections):
    """Absolute reference keyframes override only their own inclusive intervals.

    Single keys correct one sampled frame. Sections cannot overlap: order must
    never silently decide which manual edit wins. Manual means user supplied,
    not a successful model measurement.
    """
    times = np.asarray(times_ms, float)
    output = np.asarray(shifts, float).copy()
    quality = np.where(valid, "tracked", "held")
    occupied = np.zeros(len(times), bool)
    for section in sections:
        keys = sorted(section.get("keys", []), key=lambda k: k["at_ms"])
        if not keys:
            continue
        kt = np.asarray([k["at_ms"] for k in keys], float)
        xy = np.asarray([k["xy"] for k in keys], float)
        if xy.shape != (len(keys), 2) or not np.isfinite(xy).all() or not np.isfinite(kt).all() or np.any(np.diff(kt) <= 0):
            raise ValueError("Correction keys need distinct times and finite [x,y] positions")
        if kt[0] < times[0]-.001 or kt[-1] > times[-1]+.001:
            raise ValueError("Correction lies outside the analyzed frames")
        selected = (times >= kt[0]-.001) & (times <= kt[-1]+.001)
        if len(keys) == 1:
            selected[:] = False
            selected[np.argmin(abs(times-kt[0]))] = True
        if np.any(occupied & selected):
            raise ValueError("Manual sections overlap; edit or split them before applying")
        occupied |= selected
        output[selected] = np.column_stack([np.interp(times[selected], kt, xy[:, axis]) for axis in (0, 1)]) - anchor
        quality[selected] = "manual"
    return output, quality


def stream_windows(iterator, step):
    """Bounded windows with half overlap, including only tails adding new frames."""
    if step < 1:
        raise ValueError("Step must be positive")
    buffer = deque()
    new = 0
    for item in iterator:
        buffer.append(item)
        new += 1
        if len(buffer) == 2 * step:
            yield list(buffer), new
            for _ in range(step):
                buffer.popleft()
            new = 0
    if new:
        yield list(buffer), new


def translations(points, visible, indices, tolerance=12.0, minimum=3, max_step=48.0, reference=None, marked_frames=()):
    """Robust absolute displacement of the same point identities from frame zero.

    Visibility changes never redefine the reference centroid. Outliers vote for a
    common translation; failed consensus holds the previous transform and is flagged.
    This deliberately cannot detect a coherent group drifting to the wrong object.
    """
    points = np.asarray(points, float)
    visible = np.asarray(visible, bool)
    indices = np.asarray(indices, int)
    if points.ndim != 3 or points.shape[-1] != 2 or visible.shape != points.shape[:2]:
        raise ValueError("Expected points [frames, queries, 2] and matching visibility")
    if len(points) < 2 or len(indices) < minimum or len(set(indices)) != len(indices):
        raise ValueError("Need two frames and enough distinct reference points")
    if np.any(indices < 0) or np.any(indices >= points.shape[1]) or tolerance <= 0 or minimum < 2 or max_step <= 0:
        raise ValueError("Invalid translation parameters")
    if reference is None:
        reference = points[0, indices]
        eligible = visible[0, indices] & np.isfinite(reference).all(axis=1)
    else:
        reference = np.asarray(reference, float)[indices]
        eligible = np.isfinite(reference).all(axis=1)
    shifts = np.zeros((len(points), 2))
    good = np.zeros(len(points), bool)
    counts = np.zeros(len(points), int)
    residual = np.full(len(points), np.nan)
    reason = []
    last_good = 0
    for frame in range(len(points)):
        if frame:
            shifts[frame] = shifts[frame-1]
        delta = points[frame, indices] - reference
        valid = eligible & visible[frame, indices] & np.isfinite(delta).all(axis=1)
        candidates = delta[valid]
        if len(candidates) < minimum:
            reason.append("insufficient_visible_points")
            continue
        distances = np.linalg.norm(candidates[:, None] - candidates[None, :], axis=-1)
        seed = np.argmax((distances <= tolerance).sum(axis=1))
        inliers = distances[seed] <= tolerance
        shift = np.median(candidates[inliers], axis=0)
        inliers = np.linalg.norm(candidates-shift, axis=1) <= tolerance
        counts[frame] = inliers.sum()
        if counts[frame] < minimum:
            reason.append("points_disagree")
            continue
        shift = np.median(candidates[inliers], axis=0)
        residual[frame] = np.median(np.linalg.norm(candidates[inliers]-shift, axis=1))
        # A held interval can accumulate real displacement. Do not compare the
        # entire reacquisition displacement to a one-frame speed allowance.
        elapsed_frames = max(1, frame-last_good)
        if frame and frame not in marked_frames and np.linalg.norm(shift-shifts[frame-1]) > max_step * elapsed_frames:
            reason.append("large_jump_needs_review")
            continue
        shifts[frame] = shift
        good[frame] = True
        last_good = frame
        reason.append("consensus")
    return shifts, good, counts, residual, reason
