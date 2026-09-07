"""Compare pose-only extraction with native Predict using the installed core/model.

No video or mesh exports. Checks the actual model input tensors, native repeat
variation, mouth landmarks, multiple ROI slots, FoV and mask conditioning.
"""

import argparse
import json
from pathlib import Path
import sys

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--comfy", type=Path, required=True)
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--model", default="sam_3d_body_dinov3_bf16.safetensors")
    parser.add_argument("--video", type=Path, required=True)
    parser.add_argument("--frames", type=int, default=8)
    parser.add_argument("--start", type=float, default=0)
    parser.add_argument("--output", type=Path, default=Path("development/performance/parity.json"))
    args = parser.parse_args()
    sys.path.insert(0, str(args.comfy))
    import torch
    import folder_paths
    from comfy_extras.nodes_sam3d_body import SAM3DBody_Loader, SAM3DBody_Predict
    from sam3d_funscript.inference import predict_rgb
    from sam3d_funscript.masks import pack_mask
    from sam3d_funscript.mouth import mouth_corners, mouth_regressor
    from sam3d_funscript.video import video_frames

    folder_paths.add_model_folder_path("detection", str(args.model_dir))
    images = [rgb for rgb, _ in video_frames(args.video, sample_fps=0, max_frames=args.frames, start_seconds=args.start)]
    height, width = images[0].shape[:2]
    full = [{"x": 0, "y": 0, "width": width, "height": height}]
    halves = [{"x": x * width, "y": 0, "width": width / 2, "height": height} for x in (0, .5)]
    # Lower-resolution masks exercise resize/erosion and frame correspondence.
    masks = []
    for i in range(len(images)):
        gray = np.zeros((height // 2, width // 2), np.uint8)
        gray[:, i:width // 3 + i] = 255
        masks.append(pack_mask(gray)[0])
    report = []
    with torch.inference_mode():
        model = SAM3DBody_Loader.execute(args.model).result[0]
        mapping = mouth_regressor(model)
        run = model.model.run_inference
        inputs = []

        def record(img, batch, **kwargs):
            inputs.append({key: value.detach().cpu().clone() for key, value in batch.items()})
            return run(img, batch, **kwargs)

        model.model.run_inference = record
        try:
            for name, boxes, packed, fov in [("full", full, None, 0), ("two_rois_fov", halves, None, 68), ("mask", [], masks, 0)]:
                inputs.clear()
                batch_size = len(images) * (len(boxes) if packed is None else 1)
                image_batch = torch.from_numpy(np.stack(images).astype(np.float32) / 255)
                track = None if packed is None else {"packed_masks": torch.from_numpy(np.stack(packed)[:, None])}
                native = SAM3DBody_Predict.execute(model, image_batch, bboxes=boxes, track_data=track,
                    run_hand_refinement=False, fov=fov, batch_size=batch_size).result[0]["frames"]
                repeated = SAM3DBody_Predict.execute(model, image_batch, bboxes=boxes, track_data=track,
                    run_hand_refinement=False, fov=fov, batch_size=batch_size).result[0]["frames"]
                optimized = predict_rgb(model, images, boxes, packed_masks=packed, batch_size=batch_size, fov=fov)
                assert len(inputs) == 3
                assert inputs[0].keys() == inputs[2].keys()
                for key in inputs[0]:
                    assert torch.equal(inputs[0][key], inputs[2][key]), (name, key, "Model input changed")

                def coordinates(frames):
                    xyz, xy = [], []
                    for frame in frames:
                        for person in frame:
                            mouth, mouth_xy = mouth_corners(person, (height, width), mapping)
                            xyz.append(np.concatenate([person["pred_keypoints_3d"] + person["pred_cam_t"], mouth]))
                            xy.append(np.concatenate([person["pred_keypoints_2d"], mouth_xy]))
                    return np.stack(xyz), np.stack(xy)

                reference, repeat, result = map(coordinates, (native, repeated, optimized))
                metrics = {"case": name, "model_inputs_exact": True}
                for index, unit in enumerate(("metres", "pixels")):
                    delta = float(np.nanmax(np.abs(result[index] - reference[index])))
                    repeat_delta = float(np.nanmax(np.abs(repeat[index] - reference[index])))
                    metrics[f"optimized_max_delta_{unit}"] = delta
                    metrics[f"native_repeat_max_delta_{unit}"] = repeat_delta
                    np.testing.assert_array_equal(np.isfinite(result[index]), np.isfinite(reference[index]))
                    # SAM3D's CUDA rig accumulation is not bitwise deterministic.
                    assert delta <= max(.002 if index == 0 else 8., 8 * repeat_delta), metrics
                report.append(metrics)
                print(json.dumps(metrics), flush=True)
        finally:
            model.model.run_inference = run
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
