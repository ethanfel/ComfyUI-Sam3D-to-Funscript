"""Optional target-locked translation comparison; models are supplied, never downloaded.

Decode buffers are bounded. Coordinate history is retained for review and a second
streaming pass writes a fixed, black-padded canvas at the original presentation times.
This measures track agreement, not physical accuracy or point identity.
"""

import argparse
from fractions import Fraction
import hashlib
import json
from pathlib import Path
import resource
import shutil
import sys
import time

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from sam3d_funscript.stabilization import stream_windows, translations


def file_hash(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def frames(path, crop=None):
    """Yield one BGR frame and exact timestamp at a time; no FPS resampling."""
    import av

    previous = None
    with av.open(str(path)) as container:
        for frame in container.decode(video=0):
            if frame.pts is None:
                raise ValueError("Source frame has no presentation timestamp")
            timestamp = frame.pts * frame.time_base
            if previous is not None and timestamp <= previous:
                raise ValueError("Presentation timestamps must increase")
            previous = timestamp
            pixels = frame.to_ndarray(format="bgr24")
            if crop is not None:
                x, y, w, h = crop
                if min(x, y) < 0 or min(w, h) <= 0 or x+w > frame.width or y+h > frame.height:
                    raise ValueError("Crop lies outside source image")
                pixels = pixels[y:y+h, x:x+w].copy()
            yield pixels, timestamp






def local_support(queries, width, height, count=64, radius=32):
    """Official TAPNext++ VOT local-grid recipe, expressed in crop pixels."""
    side = int(np.sqrt(count))
    if side * side != count:
        raise ValueError("Support count must be square")
    offsets = ((np.arange(side) + .5) / side * 2 - 1) * radius
    xx, yy = np.meshgrid(offsets * width / 512, offsets * height / 512)
    support = queries[:, None, :] + np.stack((xx, yy), -1).reshape(1, count, 2)
    return np.concatenate((queries, np.clip(support.reshape(-1, 2), 0, [width-1, height-1])))


def track(args, recipe, output):
    import av
    import torch

    sys.path.insert(0, str(args.model_source.resolve()))
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is required for this comparison")
    torch.set_num_threads(args.cpu_threads)
    x, y, w, h = recipe["crop_xywh"]
    query = np.asarray([p["xy"] for p in recipe["points"]], np.float32) - [x, y]
    if not np.isfinite(query).all() or np.any(query < 0) or np.any(query > [w-1, h-1]):
        raise ValueError("Initial queries must lie inside the fixed crop")
    query = query.astype(np.float32)
    with av.open(recipe["video"]) as container:
        source = container.streams.video[0]
        metadata = {"image_size_wh": [source.width, source.height],
                    "source_time_base": str(source.time_base), "rate": str(source.average_rate)}
    print(f"Loading {args.backend}; {len(query)} review queries; crop {w}×{h}", flush=True)
    started_load = time.perf_counter()
    if args.backend == "tapnextpp":
        from tapnet.tapnextpp.votsp2026.model import TAPNextPP
        model = TAPNextPP.from_checkpoint(args.checkpoint, device="cuda", input_resolution=512)
        all_queries = local_support(query, w, h)
        metadata.update({"input_resolution_wh": [512, 512], "support": "64 local points per query, official VOT grid",
                         "visibility_rule": "visibility logit > 0", "dtype": "float32 weights, float16 autocast",
                         "model_input_window_frames": 1})
    else:
        from cotracker.predictor import CoTrackerOnlinePredictor
        model = CoTrackerOnlinePredictor(checkpoint=str(args.checkpoint), window_len=16).eval().to("cuda")
        metadata.update({"input_resolution_hw": list(model.interp_shape), "support": "official 6×6 global support grid",
                         "visibility_rule": "visibility × confidence > 0.6", "dtype": "float32",
                         "model_input_window_frames": 2 * model.step})
    torch.cuda.synchronize()
    metadata["load_seconds"] = time.perf_counter() - started_load
    torch.cuda.reset_peak_memory_stats()
    started = time.perf_counter()
    timestamps, positions, visibility = [], [], []
    with torch.inference_mode():
        if args.backend == "tapnextpp":
            state = None
            for index, (pixels, timestamp) in enumerate(frames(recipe["video"], recipe["crop_xywh"])):
                position, visible, state = model.track_frame(pixels, query_points_xy=all_queries if state is None else None, state=state)
                positions.append(position[:len(query)])
                visibility.append(visible[:len(query)])
                timestamps.append(timestamp)
                if index % 32 == 0:
                    print(f"Frame {index}: {time.perf_counter()-started:.1f}s", flush=True)
            positions, visibility = np.stack(positions), np.stack(visibility)
        else:
            queries = torch.from_numpy(np.column_stack((np.zeros(len(query), np.float32), query)))[None].to("cuda")
            for window, added in stream_windows(frames(recipe["video"], recipe["crop_xywh"]), model.step):
                pixels = np.stack([item[0][..., ::-1] for item in window])
                tensor = torch.from_numpy(pixels).permute(0, 3, 1, 2)[None].float().to("cuda")
                if not timestamps:
                    model(tensor[:, :1], is_first_step=True, queries=queries, add_support_grid=True)
                tracks, visible = model(tensor, add_support_grid=True)
                timestamps.extend([item[1] for item in window[-added:]])
                if len(timestamps) % 32 == 0:
                    print(f"Frame {len(timestamps)}: {time.perf_counter()-started:.1f}s", flush=True)
                del window, pixels, tensor
            positions = tracks[0, :len(timestamps)].cpu().numpy()
            visibility = visible[0, :len(timestamps)].cpu().numpy()
        torch.cuda.synchronize()
    if positions.shape != (len(timestamps), len(query), 2):
        raise RuntimeError("Tracker output length does not match source timestamps/queries")
    positions += [x, y]
    metadata.update({"recipe": recipe, "elapsed_tracking_seconds": time.perf_counter()-started,
                     "peak_cuda_allocated_bytes": torch.cuda.max_memory_allocated(),
                     "peak_process_rss_bytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024,
                     "torch": torch.__version__, "gpu": torch.cuda.get_device_name(), "cpu_threads": args.cpu_threads,
                     "backend": args.backend, "model_source": str(args.model_source.resolve()),
                     "checkpoint": str(args.checkpoint.resolve()), "checkpoint_sha256": file_hash(args.checkpoint),
                     "recipe_sha256": file_hash(args.recipe), "video_sha256": file_hash(recipe["video"]),
                     "timestamps": [str(t) for t in timestamps]})
    np.savez_compressed(output / "tracks.npz", points=positions, visible=visibility,
                        times_ms=np.asarray([float(t * 1000) for t in timestamps]), metadata=json.dumps(metadata))
    print(f"Saved {output / 'tracks.npz'}", flush=True)


def analyze(output):
    with np.load(output / "tracks.npz", allow_pickle=False) as data:
        points, visible, times = data["points"], data["visible"], data["times_ms"]
        metadata = json.loads(str(data["metadata"]))
    recipe = metadata["recipe"]
    if "max_decoded_buffer_frames" in metadata:
        # Older probe records used an imprecise name for the model window. Decode,
        # preprocessing and Python generator working buffers are additional.
        metadata["model_input_window_frames"] = metadata.pop("max_decoded_buffer_frames")
    x, y, w, h = recipe["crop_xywh"]
    model_visible_fraction = visible.mean(axis=0).tolist()
    visible = visible & np.isfinite(points).all(axis=-1) & (points >= [x, y]).all(axis=-1) & (points <= [x+w-1, y+h-1]).all(axis=-1)
    indices = [i for i, p in enumerate(recipe["points"]) if p["role"] == "reference"]
    shift, good, counts, residual, reasons = translations(points, visible, indices, **recipe["consensus"])
    width, height = metadata["image_size_wh"]
    # Symmetric, constant canvas margin covers every measured inverse translation.
    padding = (np.ceil((np.max(np.abs(shift), axis=0) + 8) / 2) * 2).astype(int)
    gaps = []
    for index, valid in enumerate(good):
        if not valid:
            if index == 0 or good[index-1]:
                gaps.append({"first_ms": float(times[index]), "last_ms": float(times[index]), "frames": 0})
            gaps[-1]["last_ms"] = float(times[index]); gaps[-1]["frames"] += 1
    report = {"metadata": metadata, "analysis_version": 2, "frames": len(times), "consensus_fraction": float(good.mean()),
              "visible_fraction_by_point": visible.mean(axis=0).tolist(),
              "model_visible_fraction_by_point": model_visible_fraction,
              "translation_range_xy_pixels": np.ptp(shift, axis=0).tolist(),
              "inlier_residual_median_pixels": float(np.nanmedian(residual)) if np.isfinite(residual).any() else None,
              "padding_xy": padding.tolist(), "output_size_wh": [int(width+2*padding[0]), int(height+2*padding[1])],
              "gaps": gaps, "limitations": ["Agreement and visibility are not point-identity accuracy.",
                  "Both models use the same crop/queries with different official support and temporal settings.",
                  "Translation only; does not recover depth or correct rotation, scale, or deformation.",
                  "Failed consensus holds the last transform. Reacquisition jumps require review.",
                  "Only decoded-frame buffers are bounded; coordinate history grows with duration.",
                  "Runtime includes decode and inference, excludes load/render; single warm/cold mix run, not a speed benchmark."]}
    np.savez_compressed(output / "stabilization.npz", shift_xy=shift, good=good, inliers=counts,
                        residual=residual, times_ms=times)
    (output / "report.json").write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
    review = {"times_ms": times.tolist(), "points": np.where(np.isfinite(points), points, 0).tolist(),
              "visible": (visible & np.isfinite(points).all(axis=-1)).tolist(), "shift_xy": shift.tolist(),
              "good": good.tolist(), "reasons": reasons, "report": report}
    (output / "review.json").write_text(json.dumps(review, allow_nan=False))
    print(json.dumps({k: v for k, v in report.items() if k not in ("metadata", "limitations")}, indent=2), flush=True)


def render(output):
    import av
    import cv2

    report = json.loads((output / "report.json").read_text())
    metadata = report["metadata"]
    with np.load(output / "stabilization.npz", allow_pickle=False) as data:
        shifts = data["shift_xy"]
    pad = np.asarray(report["padding_xy"])
    expected = [Fraction(t) for t in metadata["timestamps"]]
    source_base = Fraction(metadata["source_time_base"])
    destination = output / "stabilized.mp4"
    with av.open(str(destination), mode="w") as container:
        stream = container.add_stream("libx264", rate=Fraction(metadata["rate"]))
        stream.width, stream.height = report["output_size_wh"]
        stream.pix_fmt = "yuv420p"
        stream.time_base = source_base
        stream.codec_context.time_base = source_base
        stream.options = {"crf": "16", "preset": "fast"}
        count = 0
        for index, (pixels, timestamp) in enumerate(frames(metadata["recipe"]["video"])):
            if index >= len(expected) or timestamp != expected[index]:
                raise ValueError("Source timeline differs from measured tracks")
            offset = pad-shifts[index]
            matrix = np.array([[1, 0, offset[0]], [0, 1, offset[1]]], dtype=np.float32)
            image = cv2.warpAffine(pixels, matrix, tuple(report["output_size_wh"]), flags=cv2.INTER_LINEAR,
                                   borderMode=cv2.BORDER_CONSTANT, borderValue=0)
            frame = av.VideoFrame.from_ndarray(image, format="bgr24")
            frame.pts = int(timestamp / source_base)
            frame.time_base = source_base
            for packet in stream.encode(frame):
                container.mux(packet)
            count += 1
        if count != len(expected):
            raise ValueError("Source frame count changed")
        for packet in stream.encode():
            container.mux(packet)
    # Verify the artifact itself, including variable-frame-rate timestamps.
    actual = [timestamp for _, timestamp in frames(destination)]
    if actual != expected:
        raise RuntimeError("Encoded presentation timestamps differ from source")
    report["render_validation"] = {"frames": len(actual), "exact_timestamps_match": True,
                                   "audio": "omitted from review previews", "scale": 1, "rotation_degrees": 0}
    (output / "report.json").write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
    print(f"Rendered and verified {destination}: {len(actual)} original timestamps", flush=True)


def build_review(root):
    runs = {}
    for backend in ("cotracker3", "tapnextpp"):
        path = root / backend / "review.json"
        if path.exists():
            runs[backend] = json.loads(path.read_text())
    if not runs:
        raise ValueError("No tracker results found")
    recipes = [data["report"]["metadata"]["recipe_sha256"] for data in runs.values()]
    if len(set(recipes)) != 1:
        raise ValueError("Comparison requires the same frozen recipe")
    first = next(iter(runs.values()))
    source = Path(first["report"]["metadata"]["recipe"]["video"])
    shutil.copyfile(source, root / "source.mp4")
    (root / "review-data.js").write_text("window.STABILIZATION_REVIEW = " + json.dumps(runs, allow_nan=False) + ";\n")
    shutil.copyfile(Path(__file__).with_name("stabilization_preview.html"), root / "index.html")
    print(f"Review: {root / 'index.html'}", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["track", "analyze", "render", "review"])
    parser.add_argument("--recipe", type=Path)
    parser.add_argument("--backend", choices=["cotracker3", "tapnextpp"])
    parser.add_argument("--model-source", type=Path)
    parser.add_argument("--checkpoint", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--cpu-threads", type=int, default=8)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    if args.action == "track":
        if not all((args.recipe, args.backend, args.model_source, args.checkpoint)):
            parser.error("track requires recipe, backend, model-source, and checkpoint")
        track(args, json.loads(args.recipe.read_text()), args.output)
        analyze(args.output)
    elif args.action == "analyze":
        analyze(args.output)
    elif args.action == "render":
        render(args.output)
    else:
        build_review(args.output)


if __name__ == "__main__":
    main()
