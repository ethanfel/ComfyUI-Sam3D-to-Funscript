"""Probe an existing ComfyUI SAM 3D installation without changing its files."""

import argparse
import importlib.metadata
import json
from pathlib import Path
import sys
import time

import numpy as np
from PIL import Image
import torch


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--comfy", type=Path, required=True)
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--model", default="sam_3d_body_dinov3_bf16.safetensors")
    parser.add_argument("--image", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    sys.path.insert(0, str(args.comfy))
    import folder_paths
    from comfy_extras.nodes_sam3d_body import SAM3DBody_Loader, SAM3DBody_Predict
    from comfy_extras.sam3d_body.utils import _bbox_from_mask, inputs_from_sam3_track

    folder_paths.add_model_folder_path("detection", str(args.model_dir))
    args.output.mkdir(parents=True, exist_ok=True)
    report = {
        "scope": "Native body-only inference smoke test; repeated still image, not a motion accuracy benchmark",
        "python": sys.version,
        "executable": sys.executable,
        "packages": {name: importlib.metadata.version(name) for name in (
            "torch", "numpy", "scipy", "av", "safetensors", "comfyui-frontend-package"
        )},
        "gpu": torch.cuda.get_device_name(0),
        "model_path": str(args.model_dir / args.model),
        "image_path": str(args.image),
        "empty_mask_bbox": _bbox_from_mask(torch.zeros(24, 32)).tolist(),
    }
    invalid_track = {"packed_masks": torch.zeros(2, 1, 24, 4, dtype=torch.uint8)}
    report["frame_mismatch_returns_no_tracking"] = inputs_from_sam3_track(invalid_track, 3, 24, 32) == (None, None)
    pixels = np.array(Image.open(args.image).convert("RGB"), dtype=np.float32) / 255.0
    image = torch.from_numpy(pixels).unsqueeze(0)
    height, width = pixels.shape[:2]

    # ComfyUI normally owns this context; this standalone probe supplies it.
    with torch.inference_mode():
        start = time.perf_counter()
        model = SAM3DBody_Loader.execute(args.model).result[0]
        report["load_seconds"] = time.perf_counter() - start
        torch.cuda.reset_peak_memory_stats()
        sequences = []
        report["runs"] = []
        for label, batch in (("cold_single", image), ("warm_repeated_pair", image.repeat(2, 1, 1, 1))):
            torch.cuda.synchronize()
            start = time.perf_counter()
            pose = SAM3DBody_Predict.execute(
                model, batch, run_hand_refinement=False, fov=0.0, batch_size=2
            ).result[0]
            torch.cuda.synchronize()
            elapsed = time.perf_counter() - start
            report["runs"].append({"name": label, "frames": len(pose["frames"]), "seconds": elapsed})
            sequences.append(pose)

    pose = sequences[-1]
    person = pose["frames"][0][0]
    report["pose_envelope_keys"] = sorted(pose)
    report["person_keys"] = sorted(person)
    report["shapes"] = {
        key: list(np.asarray(person[key]).shape) for key in (
            "pred_keypoints_3d", "pred_keypoints_2d", "pred_joint_coords",
            "pred_global_rots", "pred_vertices", "pred_cam_t", "global_rot"
        )
    }
    arrays = {key: np.asarray(value) for key, value in person.items() if isinstance(value, (np.ndarray, np.number))}
    report["all_numeric_arrays_finite"] = all(np.isfinite(value).all().item() for value in arrays.values())
    camera_points = np.asarray(person["pred_keypoints_3d"], dtype=np.float64) + np.asarray(person["pred_cam_t"], dtype=np.float64)
    projected = camera_points[:, :2] / camera_points[:, 2:] * float(person["focal_length"]) + [width / 2, height / 2]
    report["projection_roundtrip_rmse_px"] = float(np.sqrt(np.mean((projected - person["pred_keypoints_2d"]) ** 2)))
    rotations = np.asarray(person["pred_global_rots"], dtype=np.float64)
    report["rotation_orthogonality_max_abs"] = float(np.abs(rotations @ rotations.transpose(0, 2, 1) - np.eye(3)).max())
    report["rotation_determinant_min_max"] = [float(x) for x in (np.linalg.det(rotations).min(), np.linalg.det(rotations).max())]
    report["repeat_keypoint_max_abs_m"] = float(np.abs(person["pred_keypoints_3d"] - pose["frames"][1][0]["pred_keypoints_3d"]).max())
    report["peak_torch_allocated_bytes"] = torch.cuda.max_memory_allocated()
    report["peak_torch_reserved_bytes"] = torch.cuda.max_memory_reserved()
    np.savez_compressed(args.output / "single_person_pose.npz", **arrays)
    (args.output / "results.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2), flush=True)


if __name__ == "__main__":
    main()
