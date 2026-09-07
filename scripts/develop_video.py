"""Run the real native model, cache poses and export a review project locally."""

import argparse
import json
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--comfy", type=Path, default=Path("/media/p5/Comfyui"))
    parser.add_argument("--model-dir", type=Path, default=Path("/media/p5/ComfyUI-Model-CIFS-Cache/mnt/detection"))
    parser.add_argument("--model", default="sam_3d_body_dinov3_bf16.safetensors")
    parser.add_argument("--video", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=Path("development/output/sam3d_funscript"))
    parser.add_argument("--fps", type=float, default=16)
    parser.add_argument("--max-frames", type=int, default=2000)
    parser.add_argument("--duration", type=float, default=0)
    parser.add_argument("--rois", default="[[0,0,1,1]]")
    args = parser.parse_args()
    sys.path.insert(0, str(args.comfy))
    import folder_paths
    import torch
    import numpy as np
    from sam3d_funscript.video import extract_video
    from sam3d_funscript.core import build_project, export_project

    folder_paths.add_model_folder_path("detection", str(args.model_dir))
    torch.cuda.reset_peak_memory_stats()
    started = time.perf_counter()
    with torch.inference_mode():  # Standalone runner supplies ComfyUI's usual execution context.
        sequence = extract_video(args.video, args.model, args.output / "cache", sample_fps=args.fps,
                                 max_frames=args.max_frames, duration_seconds=args.duration, rois_json=args.rois)
    project = build_project(sequence)
    path = export_project(project, args.output, args.video.stem)
    report = {"project_path": str(path.resolve()), "cache_path": sequence.metadata["cache_path"],
              "gpu": torch.cuda.get_device_name(), "seconds": time.perf_counter() - started,
              "sample_count": len(sequence.times_ms), "first_time_ms": sequence.times_ms[0],
              "last_time_ms": sequence.times_ms[-1], "cache_hit": sequence.metadata["cache_hit"],
              "finite_pose_fraction": float(sequence.valid.mean()), "segments": int(np.max(sequence.segments)) + 1,
              "peak_allocated_bytes": torch.cuda.max_memory_allocated(),
              "peak_reserved_bytes": torch.cuda.max_memory_reserved(), "axis_metrics": project["metrics"],
              "scope": "End-to-end execution on user video; no ground-truth motion or identity accuracy claim"}
    (path.parent / "validation.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2), flush=True)


if __name__ == "__main__":
    main()
