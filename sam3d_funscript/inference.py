"""Pose-only use of ComfyUI's native SAM3D model and crop preprocessing.

Keep decoded RGB as uint8, bound full-resolution crop temporaries separately
from the model batch, and return only data needed for the 72 cached landmarks.
The core Predict node remains the route for full meshes and render attributes.
"""

import time


def isolate_rgb(image, box):
    """Exclude pixels outside xyxy without moving the source camera or pixels."""
    import math
    import numpy as np
    height, width = image.shape[:2]
    x1, y1, x2, y2 = [math.ceil(float(value)) for value in box]
    x1, x2 = max(0, min(width, x1)), max(0, min(width, x2))
    y1, y2 = max(0, min(height, y1)), max(0, min(height, y2))
    isolated = np.zeros_like(image)
    if x2 > x1 and y2 > y1:
        isolated[y1:y2, x1:x2] = image[y1:y2, x1:x2]
    return isolated


def predict_rgb(model, images, bboxes, packed_masks=None, batch_size=8, fov=0.0, timings=None, include_mesh=False, isolate_subject=False):
    import torch
    import comfy.model_management as management
    import comfy.utils
    from comfy.ldm.sam3d_body.utils import prepare_batch
    from comfy_extras.sam3d_body.utils import cam_int_from_fov, inputs_from_sam3_track

    if not images:
        return []
    batch_size = int(batch_size)
    people = 1 if packed_masks is not None else len(bboxes)
    if batch_size < 1 or people < 1 or len(images) > max(1, batch_size // people):
        raise ValueError("RGB batch exceeds the requested SAM3D person-crop budget")
    if packed_masks is not None and len(packed_masks) != len(images):
        raise ValueError("Each active RGB frame must have its own person mask")
    if people > batch_size:
        # One crowded frame can exceed the forward budget. Keep every ROI slot
        # in order while preparing and predicting only one group at a time.
        predictions = []
        for start in range(0, people, batch_size):
            predictions.extend(predict_rgb(model, images, bboxes[start:start + batch_size],
                batch_size=batch_size, fov=fov, timings=timings, include_mesh=include_mesh,
                isolate_subject=isolate_subject)[0])
        return [predictions]

    inner = model.model
    progress = comfy.utils.ProgressBar(len(images))
    height, width = images[0].shape[:2]

    # Core prepare_batch expands full-resolution crops to float32. Keep those
    # short-lived buffers small even when the GPU batch is large. At least one
    # group's people must fit; this is a working-buffer target, not an RSS limit.
    bytes_per_frame = height * width * 3 * 4 * people * 3
    prep_frames = max(1, min(4, (128 * 1024 ** 2) // bytes_per_frame))
    cam_int = cam_int_from_fov(height, width, float(fov))
    boxes = torch.tensor([[b["x"], b["y"], b["x"] + b["width"], b["y"] + b["height"]]
                          for b in bboxes], dtype=torch.float32)
    batches = []
    started = time.perf_counter()
    with torch.inference_mode():
        for start in range(0, len(images), prep_frames):
            management.throw_exception_if_processing_interrupted()
            frames = [torch.from_numpy(rgb) for rgb in images[start:start + prep_frames]]
            n = len(frames)
            if packed_masks is not None:
                packed = torch.stack([torch.from_numpy(mask) for mask in packed_masks[start:start + n]])[:, None]
                frame_boxes, frame_masks = inputs_from_sam3_track({"packed_masks": packed}, n, height, width)
                crop_boxes = torch.cat(frame_boxes)
                masks = torch.cat(frame_masks)
                scores = torch.ones(n, dtype=torch.float32)
            else:
                crop_boxes = boxes.repeat(n, 1)
                masks = scores = None
            inputs = [frame for frame in frames for _ in range(people)]
            if isolate_subject:
                # Native preprocessing expands each box for padding/aspect ratio.
                # Zero outside its own rectangle before that expansion, retaining
                # the original canvas, camera intrinsics and person slot order.
                inputs = [torch.from_numpy(isolate_rgb(frame.numpy(), box))
                          for frame, box in zip(inputs, crop_boxes.tolist())]
            batches.append(prepare_batch(
                inputs, crop_boxes,
                input_size=inner.image_size, masks=masks, masks_score=scores, cam_int=cam_int,
            ))

        # Every native crop has the same camera intrinsics. All other fields
        # concatenate along the person dimension, matching core's (1, N, ...).
        batch = {key: (batches[0][key] if key == "cam_int" or len(batches) == 1
                       else torch.cat([part[key] for part in batches], dim=1))
                 for key in batches[0]}
        del batches
        prepared = time.perf_counter()
        management.throw_exception_if_processing_interrupted()
        management.load_models_gpu([model], memory_required=inner.memory_used_forward(len(images) * people, False))
        device = management.get_torch_device()
        batch = {key: value.to(device) for key, value in batch.items()}
        output = inner.run_inference(torch.from_numpy(images[0]), batch, inference_type="body")["mhr"]

        # Rig parameters and rest-pose render masks aren't used by the editor.
        # Body output without face landmarks needs mesh/joints for the mouth.
        keys = ["pred_keypoints_3d", "pred_keypoints_2d", "pred_cam_t", "focal_length"]
        if output.get("pred_face_keypoints_3d") is not None:
            keys.append("pred_face_keypoints_3d")
        else:
            keys.extend(["pred_vertices", "pred_joint_coords"])
        if include_mesh and "pred_vertices" not in keys:
            keys.append("pred_vertices")
        compact = {key: output[key].float().cpu().numpy() for key in keys if output.get(key) is not None}
        finished = time.perf_counter()
        progress.update(len(images))
    if timings is not None:
        timings["prepare_seconds"] = timings.get("prepare_seconds", 0.0) + prepared - started
        timings["predict_seconds"] = timings.get("predict_seconds", 0.0) + finished - prepared
        timings["batches"] = timings.get("batches", 0) + 1
        timings["max_batch_crops"] = max(timings.get("max_batch_crops", 0), len(images) * people)
    return [[{key: values[f * people + p] for key, values in compact.items()}
             for p in range(people)] for f in range(len(images))]
