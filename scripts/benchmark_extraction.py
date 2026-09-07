"""Benchmark uncached streaming extraction with a warm, shared native model.

Optionally compare with a video.py saved from an earlier commit. Run in an idle
ComfyUI environment. RSS is sampled process memory (including model/allocator);
CUDA peaks are PyTorch allocations/reservations, not whole-device VRAM usage.
"""

import argparse
import gc
import importlib.util
import json
from pathlib import Path
import sys
import threading
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--comfy", type=Path, required=True)
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--model", default="sam_3d_body_dinov3_bf16.safetensors")
    parser.add_argument("--video", type=Path, required=True)
    parser.add_argument("--frames", type=int, default=128)
    parser.add_argument("--batches", default="8,32,64,128")
    parser.add_argument("--repeat", type=int, default=2)
    parser.add_argument("--baseline-file", type=Path)
    parser.add_argument("--output", type=Path, default=Path("development/performance/benchmark"))
    args = parser.parse_args()
    sys.path.insert(0, str(args.comfy))
    import numpy as np
    import psutil
    import torch
    import folder_paths
    import comfy.model_management as management
    from comfy_extras.nodes_sam3d_body import SAM3DBody_Loader
    from sam3d_funscript.video import extract_video

    functions = {"optimized": extract_video}
    if args.baseline_file:
        spec = importlib.util.spec_from_file_location("sam3d_funscript.benchmark_baseline", args.baseline_file)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        functions = {"baseline": module.extract_video, **functions}
    folder_paths.add_model_folder_path("detection", str(args.model_dir))
    args.output.mkdir(parents=True, exist_ok=True)
    report = {"gpu": torch.cuda.get_device_name(), "torch": torch.__version__,
              "cpu_threads": torch.get_num_threads(), "frames_requested": args.frames,
              "scope": "Warm-model extraction, actual source frames, uncached; includes decode and cache writing.",
              "runs": []}
    process = psutil.Process()
    original_loader = SAM3DBody_Loader.__dict__["execute"]
    with torch.inference_mode():
        started = time.perf_counter()
        loaded = SAM3DBody_Loader.execute(args.model)
        report["model_load_seconds"] = time.perf_counter() - started
        # Benchmark-only: preserve the same model across calls, like the core
        # loader node. Production extraction still uses normal model management.
        SAM3DBody_Loader.execute = classmethod(lambda cls, *a, **kw: loaded)
        try:
            extract_video(args.video, args.model, args.output / "warmup", sample_fps=0,
                          max_frames=8, batch_size=8, use_cache=False)
            for size in map(int, args.batches.split(",")):
                first = {}
                for repeat in range(args.repeat):
                    # Alternate order to reduce systematic warm-cache bias.
                    order = list(functions) if repeat % 2 == 0 else list(reversed(functions))
                    for label in order:
                        gc.collect()
                        torch.cuda.empty_cache()
                        torch.cuda.reset_peak_memory_stats()
                        torch.cuda.synchronize()
                        peak_rss = [process.memory_info().rss]
                        stop = threading.Event()

                        def sample():
                            while not stop.wait(.02):
                                peak_rss[0] = max(peak_rss[0], process.memory_info().rss)

                        monitor = threading.Thread(target=sample, daemon=True)
                        monitor.start()
                        started = time.perf_counter()
                        try:
                            sequence = functions[label](args.video, args.model, args.output / label,
                                sample_fps=0, max_frames=args.frames, batch_size=size, use_cache=False)
                            torch.cuda.synchronize()
                            elapsed = time.perf_counter() - started
                        finally:
                            stop.set()
                            monitor.join()
                        row = {"backend": label, "batch_crops": size, "repeat": repeat,
                               "samples": len(sequence.times_ms), "seconds": elapsed,
                               "samples_per_second": len(sequence.times_ms) / elapsed,
                               "peak_rss_mib": peak_rss[0] / 2 ** 20,
                               "peak_allocated_mib": torch.cuda.max_memory_allocated() / 2 ** 20,
                               "peak_reserved_mib": torch.cuda.max_memory_reserved() / 2 ** 20,
                               "stages": sequence.metadata.get("performance")}
                        for reference_label, reference in first.items():
                            assert np.array_equal(reference.times_ms, sequence.times_ms)
                            assert np.array_equal(reference.segments, sequence.segments)
                            assert np.array_equal(reference.valid, sequence.valid)
                            row[f"max_delta_metres_vs_first_{reference_label}"] = float(np.nanmax(np.abs(sequence.points - reference.points)))
                            row[f"max_delta_pixels_vs_first_{reference_label}"] = float(np.nanmax(np.abs(sequence.pixels - reference.pixels)))
                        first.setdefault(label, sequence)
                        report["runs"].append(row)
                        (args.output / "report.json").write_text(json.dumps(report, indent=2))
                        print(json.dumps(row), flush=True)
        finally:
            SAM3DBody_Loader.execute = original_loader
            management.unload_all_models()


if __name__ == "__main__":
    main()
