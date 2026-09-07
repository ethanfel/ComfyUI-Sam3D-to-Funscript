"""Optional, local CoTracker3 experiment. Does not change ComfyUI node defaults.

Uses a pinned checkout and checkpoint supplied by the caller; never downloads code.
The recipe fixes the initial points and image direction before reference comparison.
"""

import argparse
from fractions import Fraction
import hashlib
import json
from pathlib import Path
import sys
import time

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from sam3d_funscript.calibration import (agreement, bounded_linear_fit,
    evaluate_actions, load_reference, reversal_metrics)
from sam3d_funscript.core import ANCHORS, PoseSequence, simplify, validate_actions
from sam3d_funscript.video import fingerprint


def windows(length, step):
    """Online windows overlap by step; a final short window adds only new frames."""
    if length < 2 or step < 1:
        raise ValueError("Need at least two frames and a positive step")
    for start in range(0, max(1, length - step), step):
        yield start, min(start + step * 2, length)


def decode_clip(recipe, width=768):
    import av
    import cv2

    start = Fraction(str(recipe["start_seconds"]))
    end = start + Fraction(str(recipe["duration_seconds"]))
    if start < 0 or end <= start or end - start > 120:
        raise ValueError("Pilot duration must be greater than zero and at most 120 seconds")
    frames, times, pts = [], [], []
    with av.open(recipe["video"]) as container:
        stream = container.streams.video[0]
        first = next(container.decode(stream))
        if first.pts is None:
            raise ValueError("Video lacks presentation timestamps")
        origin = first.pts * first.time_base
        container.seek(int((origin + start) / stream.time_base), stream=stream, backward=True)
        for frame in container.decode(stream):
            if frame.pts is None:
                raise ValueError("Video lacks presentation timestamps")
            timestamp = frame.pts * frame.time_base - origin
            if timestamp < start:
                continue
            if timestamp >= end:
                break
            if times and float(timestamp * 1000) <= times[-1]:
                raise ValueError("Non-increasing presentation timestamps")
            h, w = frame.height, frame.width
            height = round(h * width / w)
            frames.append(cv2.resize(frame.to_ndarray(format="rgb24"), (width, height), interpolation=cv2.INTER_AREA))
            times.append(float(timestamp * 1000)); pts.append(frame.pts)
            if len(frames) > 7200:
                raise ValueError("Pilot exceeds 7200 frames")
    if len(frames) < 2:
        raise ValueError("Selected clip contains fewer than two frames")
    return np.stack(frames), np.asarray(times), {
        "image_size": [h, w], "decoded_size": [height, width], "pts": pts,
        "time_base": [stream.time_base.numerator, stream.time_base.denominator],
        "origin": [origin.numerator, origin.denominator],
    }


def relative_feature(points, visible, recipe, image_height):
    target, reference = recipe["target_index"], recipe["reference_index"]
    direction = np.asarray(recipe["direction_xy"], float)
    if direction.shape != (2,) or not np.isfinite(direction).all() or np.linalg.norm(direction) < 1e-8:
        raise ValueError("Direction must be a finite nonzero image vector")
    direction /= np.linalg.norm(direction)
    delta = points[:, target] - points[:, reference]
    valid = visible[:, target] & visible[:, reference] & np.isfinite(delta).all(axis=1)
    values = delta @ direction / image_height
    values[~valid] = np.nan
    return values, valid


def hold_missing(values, valid, initial=50.0):
    """Conservative preview fallback. Never invent motion through an invisible interval."""
    result = np.full(len(values), initial, dtype=float)
    last = initial
    for i, value in enumerate(values):
        if valid[i] and np.isfinite(value):
            last = value
        result[i] = last
    return result


def fit_scalar(feature, target, fit_mask):
    valid = fit_mask & np.isfinite(feature)
    if valid.sum() < 10:
        raise ValueError("Insufficient visible fitting samples")
    origin = float(np.median(feature[valid]))
    gain, center = bounded_linear_fit(feature[valid] - origin, target[valid])
    return np.clip(center + gain * (feature - origin), 0, 100), {
        "origin": origin, "gain": gain, "center": center,
        "note": "Only fitting-interval labels determine gain and center; fixed direction, no smoothing or time-offset search.",
    }


def run_tracking(recipe, source, checkpoint, destination):
    import torch

    sys.path.insert(0, str(source))
    from cotracker.predictor import CoTrackerOnlinePredictor

    frames, times, metadata = decode_clip(recipe)
    height, width = metadata["decoded_size"]
    original_h, original_w = metadata["image_size"]
    selected = np.asarray([p["xy"] for p in recipe["points"]], np.float32)
    if selected.ndim != 2 or selected.shape[1] != 2 or not np.isfinite(selected).all():
        raise ValueError("Points must be finite [x, y] pixel coordinates")
    if np.any(selected < 0) or np.any(selected > [original_w - 1, original_h - 1]):
        raise ValueError("Initial point lies outside the original image")
    selected *= np.asarray([(width - 1) / (original_w - 1), (height - 1) / (original_h - 1)])
    query = np.column_stack((np.zeros(len(selected), np.float32), selected))
    print(f"Decoded {len(times)} frames with original PTS, {times[0]/1000:.2f}–{times[-1]/1000:.2f}s", flush=True)
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA unavailable for this local benchmark")
    model = CoTrackerOnlinePredictor(checkpoint=str(checkpoint), window_len=16).eval().to("cuda")
    torch.cuda.reset_peak_memory_stats()
    started = time.perf_counter()
    with torch.inference_mode():
        first_chunk = torch.from_numpy(frames[:1]).permute(0, 3, 1, 2)[None].float().to("cuda")
        model(first_chunk, is_first_step=True, queries=torch.from_numpy(query)[None].to("cuda"), add_support_grid=True)
        for index, (lo, hi) in enumerate(windows(len(times), model.step)):
            chunk = torch.from_numpy(frames[lo:hi]).permute(0, 3, 1, 2)[None].float().to("cuda")
            tracks, visible = model(chunk, add_support_grid=True)
            if index % 10 == 0:
                print(f"Tracked through frame {hi}/{len(times)} in {time.perf_counter()-started:.1f}s", flush=True)
        torch.cuda.synchronize()
        points = tracks[0, :len(times)].cpu().numpy()
        visible = visible[0, :len(times)].cpu().numpy()
        # Preserve raw model scores for diagnosis. These are not calibrated accuracy probabilities.
        scores = (model.model.online_vis_predicted.sigmoid() * model.model.online_conf_predicted.sigmoid())[0, :len(times), :len(selected)].cpu().numpy()
    if points.shape != (len(times), len(selected), 2) or visible.shape != points.shape[:2]:
        raise RuntimeError("Online result length does not match decoded timestamps")
    points *= np.asarray([(original_w - 1) / (width - 1), (original_h - 1) / (height - 1)])
    metadata.update({"recipe": recipe, "video": fingerprint(recipe["video"]),
        "source_directory": str(source.resolve()), "checkpoint": fingerprint(checkpoint),
        "checkpoint_sha256": hashlib.sha256(checkpoint.read_bytes()).hexdigest(),
        "elapsed_inference_seconds": time.perf_counter() - started,
        "peak_cuda_allocated_bytes": torch.cuda.max_memory_allocated(),
        "visibility_rule": "Official predictor: visibility × confidence > 0.6. Not a calibrated probability of correctness.",
        "support_grid_size": 6, "dtype": "float32", "torch": torch.__version__})
    np.savez_compressed(destination / "tracks.npz", times_ms=times, points=points,
        visible=visible, scores=scores, metadata=json.dumps(metadata))
    print(f"Saved {destination / 'tracks.npz'}", flush=True)


def benchmark(destination, reference_path, sam_cache, video_url=""):
    with np.load(destination / "tracks.npz", allow_pickle=False) as data:
        times, points, visible = data["times_ms"], data["points"], data["visible"]
        metadata = json.loads(str(data["metadata"]))
    recipe = metadata["recipe"]
    reference = load_reference(reference_path)
    target = evaluate_actions(reference["actions"], times)
    fit_end = times[0] + recipe["fit_seconds"] * 1000
    eval_start = fit_end + 1000
    fit, evaluation = times < fit_end, times >= eval_start
    if evaluation.sum() < 10:
        raise ValueError("Not enough evaluation frames")
    if times[0] < reference["actions"][0]["at"] or times[-1] > reference["actions"][-1]["at"]:
        raise ValueError("Reference does not cover the full pilot")
    feature, good = relative_feature(points, visible, recipe, metadata["image_size"][0])
    predicted, mapping = fit_scalar(feature, target, fit)
    held = hold_missing(predicted, good)
    sequence = PoseSequence.load(sam_cache)
    # Freeze the landmark/component identified in the earlier experiment, refit only gain/center here.
    wrist_x = sequence.points[:, 0, ANCHORS["right_wrist"], 0].mean(axis=1)
    sam_feature = np.interp(times, sequence.times_ms, wrist_x)
    sam_prediction, sam_mapping = fit_scalar(sam_feature, target, fit)
    constant = np.full(len(times), np.median(target[fit]))
    curves = {"point_tracker_with_holds": held, "sam3d_right_wrist_x_local_fit": sam_prediction,
              "constant_fit_median": constant}
    scores = {}
    for split, mask in [("fit", fit), ("evaluation", evaluation)]:
        scores[split] = {}
        for name, values in curves.items():
            metrics = agreement(values[mask], target[mask])
            metrics["reversals"] = reversal_metrics(times[mask], values[mask], target[mask])
            scores[split][name] = metrics
    failures = []
    start = None
    for i in range(len(good) + 1):
        if i < len(good) and not good[i]:
            if start is None:
                start = i
        elif start is not None:
            failures.append({"first_ms": float(times[start]), "last_ms": float(times[i-1]), "frames": i-start})
            start = None
    report = {"scope": "Development pilot on one manually selected shot, single image axis. Authored-script agreement is not physical 3D accuracy or whole-video validation.",
        "metadata": metadata, "reference": {k: v for k, v in reference.items() if k != "actions"},
        "sam_cache": str(sam_cache.resolve()),
        "split": {"first_ms": float(times[0]), "fit_end_ms_exclusive": float(fit_end),
                  "evaluation_start_ms": float(eval_start), "last_ms": float(times[-1]), "gap_ms": 1000},
        "sampling_step_ms_median": float(np.median(np.diff(times))), "mapping": mapping, "sam_mapping": sam_mapping,
        "metric_signal": "Clipped mapped trajectories with missing-point holds, before integer rounding and action simplification; evaluated at decoded frame timestamps.",
        "scores": scores, "visible_pair_fraction": float(good.mean()),
        "visible_pair_evaluation_fraction": float(good[evaluation].mean()),
        "per_point_visible_fraction": visible.mean(axis=0).tolist(), "missing_intervals": failures,
        "comparison_note": "CoTracker uses native 25 fps; SAM3D uses the existing 8 fps pose cache interpolated to the same times. Both scalar gains/centers fit only the first 12 seconds. Point/direction chosen visually before evaluation. This compares these pipelines, not models at equal settings.",
        "limitations": ["Visibility does not prove point identity; visual review still needed.",
            "No automatic cut detection, reseeding, depth, rotation, or device motion validation in this pilot.",
            "Reference came from a previously examined video. The evaluation is a development split, not a new blind benchmark.",
            "Holding missing samples can produce jumps on reacquisition; exported curve is for review only."]}
    (destination / "report.json").write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
    # No fabricated zero-time preamble or unanalyzed tail; the script keeps the original video timeline.
    rounded_times, rounded_positions = np.rint(times).astype(int), np.rint(held).astype(int)
    keep = simplify(rounded_times, rounded_positions)
    actions = validate_actions([{"at": int(rounded_times[i]), "pos": int(rounded_positions[i])} for i in keep])
    (destination / "point-tracking-preview.funscript").write_text(json.dumps({"version": "1.0", "inverted": False,
        "range": 100, "actions": actions, "metadata": {"scope": report["scope"], "review_only": True}}) + "\n")
    np.savez_compressed(destination / "comparison.npz", times_ms=times, reference=target, visible=good, **curves)
    plot(destination, times, target, curves, good, fit_end, eval_start)
    lines = ["# Selected-point tracking pilot", "", report["scope"], "",
        f"Video: {times[0]/1000:.2f}–{times[-1]/1000:.2f}s. Fit before {fit_end/1000:.2f}s, evaluate from {eval_start/1000:.2f}s. Time offset fixed at zero.", "",
        "| Evaluation | MAE / 100 | RMSE / 100 | Correlation | Reversals matched / reference |",
        "|---|---:|---:|---:|---:|"]
    for name, score in scores["evaluation"].items():
        r = score["reversals"]
        corr = "undefined" if score["correlation"] is None else f"{score['correlation']:.3f}"
        lines.append(f"| {name} | {score['mae']:.2f} | {score['rmse']:.2f} | {corr} | {r['matched']} / {r['reference_reversals']} |")
    lines += ["", report["comparison_note"], "",
        f"Both selected points marked visible in {100*good.mean():.1f}% of frames; invisible intervals hold the previous position. This is tracker self-report, not measured accuracy.", "",
        "Reversal matching uses 10-position prominence and a 200 ms tolerance. Matched timing errors exclude missed reversals.", "",
        "![Curve comparison](comparison.png)", "", "## Limits", ""]
    lines += ["- " + value for value in report["limitations"]]
    (destination / "REPORT.md").write_text("\n".join(lines) + "\n")
    write_preview(destination, times, points, visible, target, curves, report, video_url)
    print(json.dumps({"scores": scores["evaluation"], "visible_pair_fraction": report["visible_pair_fraction"], "report": str(destination / "REPORT.md")}, indent=2), flush=True)


def write_preview(destination, times, points, visible, target, curves, report, video_url):
    """Self-contained review page; source video stays on the user's machine."""
    payload = {"times": times.tolist(), "points": points.tolist(), "visible": visible.tolist(),
        "reference": target.tolist(), "curves": {k: v.tolist() for k, v in curves.items()},
        "size": report["metadata"]["image_size"], "labels": [p["label"] for p in report["metadata"]["recipe"]["points"]],
        "video_url": video_url, "recipe": report["metadata"]["recipe"]}
    template = Path(__file__).with_name("point_tracking_preview.html").read_text()
    serialized = json.dumps(payload, allow_nan=False).replace("<", "\\u003c")
    (destination / "preview.html").write_text(template.replace("/*__PILOT_DATA__*/", serialized))


def plot(destination, times, reference, curves, visible, fit_end, eval_start):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    fig, axes = plt.subplots(2, 1, figsize=(13, 6), layout="constrained")
    for ax, mask in [(axes[0], np.ones(len(times), bool)), (axes[1], times >= eval_start)]:
        ax.plot(times[mask] / 1000, reference[mask], color="#9346b9", label="Reference", linewidth=1.4)
        for name, label, color in [("point_tracker_with_holds", "Selected point / reference", "#008a71"),
                                   ("sam3d_right_wrist_x_local_fit", "SAM3D wrist / local fit", "#8e99ab")]:
            ax.plot(times[mask] / 1000, curves[name][mask], color=color, label=label, linewidth=1.0)
        ax.fill_between(times[mask] / 1000, 0, 100, where=~visible[mask], color="#e0a130", alpha=.2, label="Point pair not visible")
        ax.set(xlabel="Original video time (s)", ylabel="Position / 100", ylim=(-3, 103))
        ax.grid(alpha=.15)
    axes[0].axvspan(times[0]/1000, fit_end/1000, alpha=.08, color="blue", label="Fit interval")
    axes[0].axvline(eval_start/1000, color="black", linestyle=":", linewidth=1)
    axes[0].set_title("Selected-point pilot — authored-script agreement, single shot", loc="left")
    axes[0].legend(fontsize=8, ncol=3)
    axes[1].set_title("Evaluation after the fitting interval and a one-second gap", loc="left")
    for ext in ("png", "pdf"):
        fig.savefig(destination / f"comparison.{ext}", dpi=150, bbox_inches="tight")
    plt.close(fig)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--recipe", type=Path, required=True)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--sam-cache", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--reuse-tracks", action="store_true")
    parser.add_argument("--video-url", default="", help="Optional existing local video-serving URL for the review page")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    recipe = json.loads(args.recipe.read_text())
    if args.reuse_tracks:
        with np.load(args.output / "tracks.npz", allow_pickle=False) as data:
            saved = json.loads(str(data["metadata"]))
        if saved["recipe"] != recipe or saved["video"] != fingerprint(recipe["video"]):
            raise ValueError("Cached tracks do not match this recipe/video")
    else:
        run_tracking(recipe, args.source, args.checkpoint, args.output)
    benchmark(args.output, args.reference, args.sam_cache, args.video_url)


if __name__ == "__main__":
    main()
