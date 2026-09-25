"""Explainable 1–5 intensity estimate from Main L0, independent of device scale."""
from bisect import bisect_right
from collections import deque
import math

VERSION = 1


def _percentile(values, fraction):
    ordered = sorted(values)
    total = sum(weight for _, weight in ordered)
    accumulated = 0
    for value, weight in ordered:
        accumulated += weight
        if accumulated >= fraction * total:
            return value
    return 0


def estimate_intensity(project, cuts=None):
    """Use time-weighted motion, not action count or the single fastest stroke.

    Sample linear funscript interpolation at 40 Hz, then median-filter isolated
    spikes and ignore travel below a 3-point deadband. Four-second windows keep
    a brief burst from setting the rating for a whole clip. Speed includes both
    stroke distance and repetition; range moderates fast, shallow motion.
    """
    empty = dict(level=0, axis='L0', version=VERSION, score=0, speed=0,
                 typical_range=0, cycles_per_second=0, active_fraction=0)
    if not project:
        return empty
    actions = project.get('scripts', {}).get('L0', {}).get('actions', [])
    if len(actions) < 2:
        return empty
    points = {}
    for action in actions:
        at, pos = action.get('at'), action.get('pos')
        if (type(at) not in (int, float) or type(pos) not in (int, float)
                or not math.isfinite(at) or not math.isfinite(pos) or at < 0 or not 0 <= pos <= 100):
            return empty
        points[at] = pos
    points = sorted(points.items())
    if len(points) < 2:
        return empty
    metadata = project.get('metadata', {})
    duration = metadata.get('duration_ms', points[-1][0])
    if type(duration) not in (int, float) or not math.isfinite(duration) or duration <= 0:
        return empty
    if cuts is None:
        scene_cuts = metadata.get('scene_cuts') or {}
        cuts = scene_cuts.get('times_ms', []) if isinstance(scene_cuts, dict) else []
    cuts = sorted(set(c for c in cuts if type(c) in (int, float) and math.isfinite(c) and 0 < c < duration))
    # Bound work for unusually long projects; ordinary clips retain 25 ms steps.
    step = max(25, duration / 200000)
    count = math.ceil(duration / step)
    bins = [dict(travel=0, low=100, high=0, turns=0) for _ in range(math.ceil(duration / 4000))]
    recent = deque(maxlen=3)
    point = 0
    anchor = None
    direction = 0
    previous_scene = None
    for i in range(count + 1):
        at = min(duration, i * step)
        scene = bisect_right(cuts, at)
        if scene != previous_scene:
            recent.clear(); anchor = None; direction = 0; previous_scene = scene
        while point + 1 < len(points) and points[point + 1][0] <= at:
            point += 1
        t0, p0 = points[point]
        if point + 1 < len(points) and at >= t0:
            t1, p1 = points[point + 1]
            # A connection across a known cut is not a stroke. Do not invent
            # motion on either side while waiting for the next measured point.
            if bisect_right(cuts, t0) != bisect_right(cuts, t1):
                recent.clear(); anchor = None; direction = 0
                continue
            pos = p0 + (p1 - p0) * (at - t0) / (t1 - t0)
        else:
            pos = p0
        recent.append(pos)
        if len(recent) < 3:
            continue
        pos = sorted(recent)[1]
        window = bins[min(len(bins) - 1, int(max(0, at - step) // 4000))]
        window['low'] = min(window['low'], pos); window['high'] = max(window['high'], pos)
        if anchor is None:
            anchor = pos
        delta = pos - anchor
        if abs(delta) >= 3:
            sign = 1 if delta > 0 else -1
            window['travel'] += abs(delta)
            if direction and sign != direction:
                window['turns'] += 1
            direction = sign; anchor = pos
    speeds, ranges, cycles = [], [], []
    active = 0
    for i, window in enumerate(bins):
        seconds = min(4000, duration - i * 4000) / 1000
        span = max(0, window['high'] - window['low'])
        speed = window['travel'] / seconds
        # Speed already combines stroke depth and cadence; don't add cadence
        # again, which would overrate very shallow, rapid patterns.
        speeds.append((speed * (.7 + .3 * math.sqrt(min(1, span / 80))), seconds))
        ranges.append((span, seconds)); cycles.append((window['turns'] / (2 * seconds), seconds))
        if span >= 3 and speed >= 3:
            active += seconds
    seconds = duration / 1000
    score = .6 * sum(speed * weight for speed, weight in speeds) / seconds + .4 * _percentile(speeds, .75)
    level = 1 + sum(score >= threshold for threshold in (20, 60, 120, 200))
    return dict(level=level, axis='L0', version=VERSION, score=round(score, 2),
                speed=round(sum(w['travel'] for w in bins) / seconds, 1),
                typical_range=round(_percentile(ranges, .75), 1),
                cycles_per_second=round(_percentile(cycles, .75), 2),
                active_fraction=round(active / seconds, 3))
