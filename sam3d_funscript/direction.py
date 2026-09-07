"""Offline automatic motion projection. No model inference or device calibration."""

import numpy as np


def covariance(values):
    centered = values - values.mean(axis=0)
    lengths = np.linalg.norm(centered, axis=1)
    cap = np.percentile(lengths, 90)
    centered *= np.minimum(1, cap / np.maximum(lengths, 1e-30))[:, None]
    return centered.T @ centered / len(centered)


def dominant_direction(times, values, body_axes):
    """Fit short-window displacements; constant drift does not choose the axis.

    Resampling avoids overweighting dense VFR intervals. The direction is fixed
    throughout a valid span. Near-isotropic motion falls back to a body axis,
    while anatomical orientation resolves the otherwise arbitrary PCA sign.
    """
    if len(times) > 1:
        step = max(1000 / 30, float(np.median(np.diff(times))))
        count = max(2, int(np.floor((times[-1] - times[0]) / step)) + 1)
        grid = np.linspace(times[0], times[-1], count)
        samples = np.stack([np.interp(grid, times, column) for column in values.T], axis=1)
        lag = min(count - 1, max(1, int(np.floor(200 / (grid[1] - grid[0]) + .5))))
    else:
        samples, lag = values, 1
    position_cov = covariance(samples)
    cov = covariance(samples[lag:] - samples[:-lag]) if len(samples) - lag >= 4 else position_cov
    if np.trace(cov) <= max(1e-24, np.trace(position_cov) * 1e-8):
        cov = position_cov
    total = float(np.trace(cov))
    if total <= 1e-24:
        return np.asarray(body_axes[0]), 0.0, "still"
    eigenvalues, vectors = np.linalg.eigh(cov)
    direction = vectors[:, -1]
    mode = "dominant"
    if eigenvalues[-1] / total < .55:
        # A circular/isotropic trajectory has no unique principal direction.
        direction = np.asarray(max(body_axes, key=lambda axis: np.asarray(axis) @ cov @ axis))
        mode = "body_fallback"
    else:
        alignments = np.asarray(body_axes) @ direction
        if alignments[np.argmax(np.abs(alignments))] < 0:
            direction = -direction
    share = float(np.clip(direction @ cov @ direction / total, 0, 1))
    return direction, share, mode


def auto_motion(times, raw, processed, runs, orientation_hints, rotational=False):
    raw_result = np.full(len(times), np.nan)
    result = raw_result.copy()
    reports = []
    offset = 3 if rotational else 0
    hints = {hint["start"]: hint["axes"] for hint in orientation_hints}
    for start, end in runs:
        axes = hints.get(start, np.eye(3))
        direction, share, mode = dominant_direction(times[start:end], processed[start:end, offset:offset + 3], axes)
        raw_result[start:end] = raw[start:end, offset:offset + 3] @ direction
        result[start:end] = processed[start:end, offset:offset + 3] @ direction
        reports.append({"start": start, "end": end, "direction": direction.tolist(),
                        "share": share, "mode": mode, "orientation": "body" if start in hints else "camera"})
    return raw_result, result, reports


def fit_range(values, rotational=False, invert=False):
    """Fit the central 90% into 10–90, with floors of 4 cm / 10 degrees.

    Range also expands when necessary to keep the existing center control valid.
    This is authoring gain, not an estimate of device travel or physical limits.
    """
    low, high = np.percentile(values[np.isfinite(values)], [5, 95])
    midpoint = float((low + high) / 2)
    extent = max(10.0 if rotational else .04, float(high - low) / .8, 2 * abs(midpoint))
    extent = np.ceil(extent * 1e6) / 1e6
    center = np.clip(50 - midpoint / extent * 100 * (-1 if invert else 1), 0, 100)
    return float(extent), float(np.floor(center * 1000 + .5) / 1000)


def adaptive_motion(times, raw, processed, runs, orientation_hints, rotational=False):
    """Fit this anchor's local direction, origin and gain on overlapping windows.

    Three-second windows contain several ordinary strokes; half-second knots
    blend their calibration without hard section joins. No other anchor's
    coordinates or clip-wide extrema enter a window. Minimum range limits gain.
    Calibration alone cannot move a stationary anchor, and adjustment per sample
    is bounded by the measured 3D displacement, including at activity changes.
    """
    offset = 3 if rotational else 0
    floor = 10.0 if rotational else .04
    normalized_raw, normalized = (np.full(len(times), np.nan) for _ in range(2))
    local_ranges = np.full(len(times), np.nan)
    directions = np.full((len(times), 3), np.nan)
    reports = []
    hints = {hint['start']: hint['axes'] for hint in orientation_hints}
    for start, end in runs:
        t = times[start:end]
        values = processed[start:end, offset:offset + 3]
        raw_values = raw[start:end, offset:offset + 3]
        axes = hints.get(start, np.eye(3))
        knots = np.unique(np.r_[np.arange(t[0], t[-1], 500.0), t[-1]])
        fits = []
        previous_direction = None
        for at in knots:
            left = max(t[0], min(at - 1500.0, t[-1] - 3000.0))
            a = np.searchsorted(t, left)
            b = max(a + 1, np.searchsorted(t, left + 3000.0, side='right'))
            direction, share, mode = dominant_direction(t[a:b], values[a:b], axes)
            if previous_direction is not None and np.dot(direction, previous_direction) < 0:
                direction = -direction
            previous_direction = direction
            projected = values[a:b] @ direction
            low, high = np.min(projected), np.max(projected)
            extent = np.ceil(max(floor, float(high - low) / .9) * 1e6) / 1e6
            midpoint = float((low + high) / 2)
            fits.append((direction, extent, midpoint))
            reports.append({'start': start + int(np.searchsorted(t, at)), 'end': end,
                            'at_ms': float(at), 'window_ms': [float(t[a]), float(t[b - 1])],
                            'direction': direction.tolist(), 'range': float(extent),
                            'origin': midpoint, 'share': share, 'mode': mode,
                            'orientation': 'body' if start in hints else 'camera'})
        # Limit report coverage to its knot interval; cuts/gaps remain separate.
        for i in range(len(reports) - len(fits), len(reports) - 1):
            reports[i]['end'] = reports[i + 1]['start']
        j = 0
        for i, at in enumerate(t):
            while j + 1 < len(knots) and knots[j + 1] <= at:
                j += 1
            k = min(j + 1, len(knots) - 1)
            weight = 0.0 if j == k else (at - knots[j]) / (knots[k] - knots[j])
            d0, r0, c0 = fits[j]
            d1, r1, c1 = fits[k]
            gain = (1 - weight) * d0 / r0 + weight * d1 / r1
            bias = (1 - weight) * c0 / r0 + weight * c1 / r1
            gain_norm = np.linalg.norm(gain)
            extent = 1 / max(gain_norm, 1e-30)
            target = float(values[i] @ gain - bias)
            if i:
                movement = np.linalg.norm(values[i] - values[i - 1])
                adjustment = 2 * movement / min(extent, local_ranges[start + i - 1])
                target = float(np.clip(target, normalized[start + i - 1] - adjustment,
                                       normalized[start + i - 1] + adjustment))
            # Raw-vs-filtered comparison uses the exact same local calibration.
            normalized[start + i] = target
            normalized_raw[start + i] = target + float((raw_values[i] - values[i]) @ gain)
            local_ranges[start + i] = extent
            directions[start + i] = gain / max(gain_norm, 1e-30)
    return normalized_raw * local_ranges, normalized * local_ranges, local_ranges, directions, reports
