"""Bidirectional reference tracking; reverse decoding uses a temporary disk spool."""
from contextlib import closing
import json
from pathlib import Path
import tempfile
import time
import uuid

import numpy as np

from .reference_keyframes import reference_keys, validate_keys
from .stabilization import stream_windows
from .video import fingerprint


def resolve_checkpoint(selected, mode):
    """Respect extra_model_paths and locate the companion model for each region."""
    selected = Path(selected) if selected else None
    opposite = "online" if mode == "offline" else "offline"
    if selected and selected.is_file() and opposite not in selected.name.lower():
        return selected
    names = [f"cotracker3_scaled_{mode}.pth", f"scaled_{mode}.pth"]
    if selected:
        for name in [selected.name.replace(opposite, mode), *names]:
            candidate = selected.with_name(name)
            if candidate.is_file() and opposite not in candidate.name.lower():
                return candidate
    try:
        import folder_paths
        for name in names:
            path = folder_paths.get_full_path("cotracker", name)
            if path and Path(path).is_file():
                return Path(path)
    except ImportError:
        pass
    return None


def online_pass(model, images, query, indices, device, progress=None, interrupt=None):
    """One directional, bounded-window pass with a fresh predictor state."""
    import torch
    indices = list(indices)
    if len(indices) == 1:
        return query[None].copy(), np.ones((1, len(query)), bool)
    queries = torch.as_tensor(np.column_stack((np.zeros(len(query)), query)), dtype=torch.float32, device=device)[None]
    completed = 0
    for window, added in stream_windows(iter(indices), model.step):
        if interrupt:
            interrupt()
        batch = np.array(images[window], copy=True)
        tensor = torch.from_numpy(batch).permute(0, 3, 1, 2)[None].to(device=device, dtype=torch.float32)
        if not completed:
            model(tensor[:, :1], is_first_step=True, queries=queries, add_support_grid=True)
        tracks, visible = model(tensor, add_support_grid=True)
        completed += added
        if progress:
            progress(added)
        del batch, tensor
    result = tracks[0, :len(indices)].float().cpu().numpy()
    valid = visible[0, :len(indices)].cpu().numpy()
    result[0], valid[0] = query, True
    return result, valid


def track_keyframes(info, config, checkpoint, destination, progress=None, interrupt=None):
    import cv2
    import torch
    import comfy.model_management as management
    try:
        from cotracker.predictor import CoTrackerPredictor, CoTrackerOnlinePredictor
    except ImportError as error:
        raise RuntimeError("Install CoTracker3 with scripts/install_reference_tracker.py using the ComfyUI Python") from error
    from .reference import decode

    keys = reference_keys(config)
    validate_keys(keys)
    mode = config.get("tracking_mode", "online")
    device = management.get_torch_device()
    management.free_memory(3 * 1024**3, device)
    crop = config["crop_xywh"]
    started = time.perf_counter()
    model = images = None
    try:
        model = (CoTrackerPredictor(checkpoint=str(checkpoint), offline=True) if mode == "offline" else
                 CoTrackerOnlinePredictor(checkpoint=str(checkpoint), window_len=16)).eval().to(device)
        height, width = model.interp_shape
        available = management.get_free_memory(device) if mode == "offline" else None
        scale = np.array([(width-1)/(crop[2]-1), (height-1)/(crop[3]-1)])
        queries = [(np.asarray(k["points"], np.float32)-crop[:2])*scale for k in keys]
        times, pts, durations = [], [], []
        # No full-resolution video tensor is retained in CPU memory. Reverse
        # traversal reads resized RGB frames from disk, then deletes the spool.
        with tempfile.TemporaryDirectory(prefix="reference-frames-", dir=destination.parent) as temporary:
            spool = Path(temporary) / "frames.rgb"
            with spool.open("wb") as output, closing(decode(info, crop)) as source:
                for pixels, timestamp, relative, duration in source:
                    if interrupt:
                        interrupt()
                    resized = cv2.resize(pixels, (width, height), interpolation=cv2.INTER_LINEAR)[..., ::-1].copy()
                    output.write(resized.tobytes())
                    times.append(float(relative*1000)); pts.append(str(timestamp)); durations.append(float(duration*1000))
                    if available is not None:
                        # A conservative preflight, not a promise of exact peak
                        # memory: features and temporal attention both grow.
                        n = len(times)
                        estimate = n*height*width*4*16 + (len(keys)*len(queries[0])+36)*n*n*4*8
                        if estimate > available*.8:
                            raise ValueError("This section is too long for the estimated offline memory budget. Shorten the stabilization region or select Online mode; frames are never silently skipped.")
                    if progress:
                        progress(len(times))
            total, count = len(times), len(queries[0])
            if total < 2:
                raise ValueError("Reference tracking needs at least two frames")
            validate_keys(keys, total)
            images = np.memmap(spool, mode="r", dtype=np.uint8, shape=(total, height, width, 3))
            passes = np.full((len(keys), total, count, 2), np.nan, np.float32)
            visibility = np.zeros((len(keys), total, count), bool)
            completed = total
            def advanced(added):
                nonlocal completed
                completed += added
                if progress:
                    progress(completed)
            with torch.inference_mode():
                if mode == "offline":
                    if interrupt:
                        interrupt()
                    # The offline transformer attends across this whole section.
                    # Allocate at model resolution, never at source resolution.
                    tensor = torch.empty((1, total, 3, height, width), device=device, dtype=torch.float32)
                    for a in range(0, total, 32):
                        if interrupt:
                            interrupt()
                        block = torch.from_numpy(np.array(images[a:a+32], copy=True)).permute(0, 3, 1, 2)
                        tensor[0, a:a+len(block)].copy_(block)
                    query = np.concatenate([np.column_stack((np.full(count, k["frame"]), q)) for k, q in zip(keys, queries)])
                    query = torch.as_tensor(query, dtype=torch.float32, device=device)[None]
                    tracks, visible = model(tensor, queries=query, backward_tracking=True)
                    passes[:] = tracks[0].float().cpu().numpy().reshape(total, len(keys), count, 2).transpose(1, 0, 2, 3)
                    visibility[:] = visible[0].cpu().numpy().reshape(total, len(keys), count).transpose(1, 0, 2)
                    del tensor, tracks, visible, query
                    if interrupt:
                        interrupt()
                    advanced(total)
                else:
                    for k, key in enumerate(keys):
                        seed = key["frame"]
                        low = keys[k-1]["frame"] if k else 0
                        high = keys[k+1]["frame"] if k+1 < len(keys) else total-1
                        for indices in (range(seed, high+1), range(seed, low-1, -1)):
                            result, valid = online_pass(model, images, queries[k], indices, device, advanced, interrupt)
                            passes[k, list(indices)] = result
                            visibility[k, list(indices)] = valid
                passes = passes / scale + crop[:2]
            images._mmap.close(); images = None
        record = {"source_pts": pts, "frame_durations_ms": durations, "tracking_seconds": time.perf_counter()-started,
                  "model_input_window_frames": total if mode == "offline" else model.step*2,
                  "backend": f"CoTracker3 {mode} · reference keyframes", "checkpoint": fingerprint(checkpoint),
                  "reference_frames": [k["frame"] for k in keys], "bidirectional": True}
        temporary = destination.with_name(destination.stem + "." + uuid.uuid4().hex + ".npz")
        try:
            np.savez_compressed(temporary, passes=passes, pass_visible=visibility, source_times_ms=times, metadata=json.dumps(record))
            temporary.replace(destination)
        finally:
            temporary.unlink(missing_ok=True)
    except torch.OutOfMemoryError as error:
        raise RuntimeError(f"CoTracker3 {mode} ran out of memory. Shorten this stabilization region, reduce reference points/keyframes, or choose Online mode. No completed result was overwritten.") from error
    finally:
        if images is not None:
            images._mmap.close()
        if model is not None:
            model.to("cpu")
