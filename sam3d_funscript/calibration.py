"""Agreement with an authored reference. These metrics are not physical ground truth."""

import json
from pathlib import Path

import numpy as np
from scipy.optimize import linear_sum_assignment
from scipy.signal import find_peaks

from .core import ANCHORS, anchor, body_basis, build_project, smooth_span, spans, validate_actions
from .video import fingerprint


def load_reference(path):
    data = json.loads(Path(path).read_text())
    actions = validate_actions(data.get("actions"))
    return {"actions": actions, "source": fingerprint(path), "offset_ms": 0.0,
            "header_inverted": bool(data.get("inverted", False)),
            "interpretation": "Compare positions as written; legacy inverted/range headers are not applied."}


def evaluate_actions(actions, times):
    return np.interp(times, [a["at"] for a in actions], [a["pos"] for a in actions])


def agreement(predicted, reference):
    predicted, reference = np.asarray(predicted, float), np.asarray(reference, float)
    valid = np.isfinite(predicted) & np.isfinite(reference)
    x, y = predicted[valid], reference[valid]
    if not len(x):
        return {"samples": 0, "mae": None, "rmse": None, "correlation": None, "std_ratio": None}
    correlation = float(np.corrcoef(x, y)[0, 1]) if min(np.std(x), np.std(y)) > 1e-8 else None
    return {"samples": len(x), "mae": float(np.mean(np.abs(x - y))),
            "rmse": float(np.sqrt(np.mean((x - y) ** 2))), "correlation": correlation,
            "std_ratio": float(np.std(x) / np.std(y)) if np.std(y) > 1e-8 else None}


def reversal_metrics(times, predicted, reference, tolerance_ms=200, prominence=10):
    """Same-direction extrema, maximum-cardinality matching inside a timing tolerance."""
    if len(times) < 3 or not np.isfinite(predicted).all() or not np.isfinite(reference).all():
        return None
    matched, count_pred, count_ref, errors = 0, 0, 0, []
    for sign in (1, -1):
        p = times[find_peaks(sign * predicted, prominence=prominence)[0]]
        r = times[find_peaks(sign * reference, prominence=prominence)[0]]
        count_pred += len(p); count_ref += len(r)
        if not len(p) or not len(r):
            continue
        distances = np.abs(p[:, None] - r[None, :])
        penalty = (min(len(p), len(r)) + 1) * (tolerance_ms + 1)
        rows, columns = linear_sum_assignment(np.where(distances <= tolerance_ms, distances, penalty))
        accepted = distances[rows, columns]
        accepted = accepted[accepted <= tolerance_ms]
        matched += len(accepted); errors.extend(accepted.tolist())
    return {"predicted_reversals": count_pred, "reference_reversals": count_ref, "matched": matched,
            "precision": matched / count_pred if count_pred else 0.0,
            "recall": matched / count_ref if count_ref else 0.0,
            "median_error_ms_of_matches": float(np.median(errors)) if errors else None,
            "tolerance_ms": tolerance_ms, "prominence_position_units": prominence}


def compare_project(project, reference, axis="L0", offset_ms=0.0):
    if axis not in project["scripts"]:
        raise ValueError(f"Project has no {axis} script")
    if not np.isfinite(offset_ms):
        raise ValueError("Reference offset must be finite")
    original = reference["actions"]
    first = max(project["times_ms"][0], original[0]["at"] + offset_ms)
    last = min(project["times_ms"][-1], original[-1]["at"] + offset_ms)
    if last - first < 100:
        raise ValueError("Video analysis and reference script overlap by less than 100 ms")
    times = np.arange(first, last, 20.0)
    predicted = evaluate_actions(project["scripts"][axis]["actions"], times)
    target = evaluate_actions(original, times - offset_ms)
    result = agreement(predicted, target)
    result.update({"first_ms": float(first), "last_ms": float(last), "evaluation_step_ms": 20,
                   "reversals": reversal_metrics(times, predicted, target),
                   "scope": "Agreement with authored reference positions; not 3D or contact accuracy. Includes exported holds."})
    output = dict(project)
    output["references"] = {**project.get("references", {}), axis: {**reference, "offset_ms": float(offset_ms)}}
    output["reference_comparison"] = {**project.get("reference_comparison", {}), axis: result}
    return output, result


def bounded_linear_fit(x, y, max_gain=20000.0):
    """Exact two-variable bounded least squares; center 0–100, finite gain."""
    valid = np.isfinite(x) & np.isfinite(y)
    x, y = np.asarray(x)[valid], np.asarray(y)[valid]
    if len(x) < 10:
        raise ValueError("Fewer than ten usable fitting samples")
    xm, ym = x.mean(), y.mean()
    variance = np.mean((x - xm) ** 2)
    if variance < 1e-14:
        return 0.0, float(np.clip(ym, 0, 100))
    gain = np.mean((x - xm) * (y - ym)) / variance
    center = ym - gain * xm
    candidates = []
    if -max_gain <= gain <= max_gain and 0 <= center <= 100:
        candidates.append((gain, center))
    for center in (0, 100):
        gain = np.clip(np.dot(x, y - center) / max(np.dot(x, x), 1e-14), -max_gain, max_gain)
        candidates.append((gain, center))
    for gain in (-max_gain, max_gain):
        candidates.append((gain, np.clip(ym - gain * xm, 0, 100)))
    gain, center = min(candidates, key=lambda p: np.mean((p[0] * x + p[1] - y) ** 2))
    return float(gain), float(center)


def partition(times, gap_ms=1000.0):
    start, end = times[0], times[-1]
    split1, split2 = start + .6 * (end - start), start + .8 * (end - start)
    if end - start < 15000:
        raise ValueError("Calibration requires at least 15 seconds for separate fitting, selection and test intervals")
    masks = {"fit": times < split1 - gap_ms,
             "validation": (times >= split1 + gap_ms) & (times < split2 - gap_ms),
             "test": times >= split2 + gap_ms}
    return masks, {"fit_end_ms": float(split1 - gap_ms), "validation_start_ms": float(split1 + gap_ms),
                   "validation_end_ms": float(split2 - gap_ms), "test_start_ms": float(split2 + gap_ms),
                   "gap_each_side_ms": gap_ms, "method": "Chronological 60/20/20 with boundary gaps; test labels do not select settings."}


def calibrate_sequence(sequence, reference, smoothing_options=(0.0, 40.0, 80.0, 120.0)):
    """Fit scalar anchor mappings on 60%, select on 20%, then report the untouched final 20%."""
    sequence.validate()
    baseline = build_project(sequence, {"enabled_axes": ["L0"]})
    baseline, full_comparison = compare_project(baseline, reference)
    first = max(sequence.times_ms[0], reference["actions"][0]["at"])
    last = min(sequence.times_ms[-1], reference["actions"][-1]["at"])
    times = np.arange(first, last, 20.0)
    masks, split = partition(times)
    target = evaluate_actions(reference["actions"], times)
    baseline_values = evaluate_actions(baseline["scripts"]["L0"]["actions"], times)
    constant = np.full(len(times), np.median(target[masks["fit"]]))
    people = sequence.points.shape[1]
    candidates = []
    for person in range(people):
        _, body_good = body_basis(sequence.points[:, person])
        for name in ANCHORS:
            positions = anchor(sequence.points[:, person], name)
            valid = sequence.valid[:, person] & body_good & np.isfinite(positions).all(axis=1)
            raw = np.full((len(sequence.times_ms), 3), np.nan)
            runs = list(spans(valid, sequence.segments, sequence.times_ms, 250))
            for start, end in runs:
                t = sequence.times_ms[start:end]
                p = positions[start:end]
                raw[start:end] = (p - np.median(p[t <= t[0] + 500], axis=0))[:, [1, 2, 0]] * [-1, 1, -1]
            for smoothing in smoothing_options:
                filtered = np.full_like(raw, np.nan)
                for start, end in runs:
                    filtered[start:end] = smooth_span(sequence.times_ms[start:end], raw[start:end], smoothing)
                for component in range(3):
                    feature = np.interp(times, sequence.times_ms, filtered[:, component])
                    train = masks["fit"] & np.isfinite(feature)
                    validation = masks["validation"] & np.isfinite(feature)
                    if train.sum() < 10 or validation.sum() < 10:
                        continue
                    gain, center = bounded_linear_fit(feature[train], target[train])
                    prediction = np.clip(center + gain * feature, 0, 100)
                    candidates.append({"target_person": person, "target_anchor": name, "component": component,
                        "smoothing_ms": smoothing, "gain": gain, "center": center,
                        "range": 100 / max(abs(gain), 1e-10), "invert": gain < 0,
                        "fit": agreement(prediction[train], target[train]),
                        "validation": agreement(prediction[validation], target[validation])})
    if not candidates:
        raise ValueError("No anchor has sufficient finite samples in the fit and validation intervals")
    candidates.sort(key=lambda c: c["validation"]["rmse"])
    chosen = candidates[0]
    config = {"enabled_axes": ["L0"], "target_person": chosen["target_person"], "target_anchor": chosen["target_anchor"],
              "smoothing_ms": chosen["smoothing_ms"], "axis_settings": {"L0": {
                  key: chosen[key] for key in ("component", "range", "center", "invert")}}}
    calibrated = build_project(sequence, config)
    calibrated, calibrated_comparison = compare_project(calibrated, reference)
    prediction = evaluate_actions(calibrated["scripts"]["L0"]["actions"], times)
    scores = {}
    for label, mask in masks.items():
        scores[label] = {"baseline": agreement(baseline_values[mask], target[mask]),
                         "calibrated": agreement(prediction[mask], target[mask]),
                         "constant_train_median": agreement(constant[mask], target[mask])}
    test = masks["test"]
    scores["test"]["baseline_reversals"] = reversal_metrics(times[test], baseline_values[test], target[test])
    scores["test"]["calibrated_reversals"] = reversal_metrics(times[test], prediction[test], target[test])
    windows = []
    for start in np.arange(first, last, 20000):
        mask = (times >= start) & (times < start + 20000)
        windows.append({"start_ms": float(start), "end_ms": float(min(start + 20000, last)),
                        "baseline": agreement(baseline_values[mask], target[mask]),
                        "calibrated": agreement(prediction[mask], target[mask])})
    report = {"reference": {k: v for k, v in reference.items() if k != "actions"}, "reference_action_count": len(reference["actions"]),
              "video": sequence.metadata["source"], "sample_count": len(sequence.times_ms),
              "split": split, "selected": chosen, "config": config, "candidate_count": len(candidates),
              "candidates_ranked_by_validation": candidates, "scores": scores, "windows": windows,
              "full_baseline": full_comparison, "full_calibrated": calibrated_comparison,
              "scope": "Single-axis agreement with an authored script. One chronological test interval is held out; no 3D, contact or cross-video accuracy claim.",
              "selection_note": "Gain/center fitted on the first interval only; anchor, direction and smoothing selected by validation RMSE. Time offset fixed at zero."}
    calibrated["calibration"] = {"selected": chosen, "split": split, "scores": scores,
                                "scope": report["scope"], "source": reference["source"]}
    return baseline, calibrated, report
