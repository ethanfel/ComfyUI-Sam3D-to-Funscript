# ComfyUI SAM3D to Funscript

A working first version of a local **video → SAM 3D Body → multi-axis motion → editable preview → funscript** pipeline.

The node uses ComfyUI's native SAM 3D Body implementation and your existing model. Pose inference is cached separately from motion authoring. The browser editor includes the source video, projected skeleton, an orbitable 3D skeleton, six editable curves and a generic six-axis platform preview.

**Status:** development version, tested on the provided `rcowgirl_6.mp4` and the local `13_env_py313` environment. This is an authoring tool. The platform is a kinematic illustration, without OSR/SR6 inverse kinematics, collision modelling or hardware control. Static person ROIs require visual review; they do not provide automatic identity tracking.

## Open it locally

The project is linked into:

```text
/media/p5/Comfyui/custom_nodes/ComfyUI-Sam3D-to-Funscript
```

Load [workflows/video_to_funscript.json](workflows/video_to_funscript.json) in ComfyUI. It is a canvas-editable workflow with three stages:

1. **SAM3D Video → Cached Poses:** select the video, model and person ROI(s).
2. **Poses → Multi-axis Motion:** choose anchors, reference frame, smoothing and enabled axes.
3. **Preview & Export Funscripts:** write scripts and a project, then open the embedded preview or **Open full motion editor**.

The development server uses port **8197** and stores results under this repository's `development/output/`. Your regular ComfyUI uses its own configured output directory. A regular ComfyUI process already running before installation needs to reload custom nodes, normally by restarting it when its queue is idle.

To start the isolated development server again:

```bash
mkdir -p /tmp/s3f-comfy-user /tmp/s3f-comfy-temp
PYTHONDONTWRITEBYTECODE=1 /media/p5/miniforge3/envs/13_env_py313/bin/python \
  /media/p5/Comfyui/main.py \
  --listen 127.0.0.1 --port 8197 --disable-auto-launch \
  --disable-all-custom-nodes --whitelist-custom-nodes ComfyUI-Sam3D-to-Funscript \
  --output-directory /media/p5/ComfyUI-Sam3D-to-Funscript/development/output \
  --user-directory /tmp/s3f-comfy-user --temp-directory /tmp/s3f-comfy-temp \
  --database-url sqlite:///:memory:
```

Only this custom node pack is enabled in that test process. Existing native model paths are read from ComfyUI's configuration. No model weights are bundled or downloaded.

### Core-node alternative

Load [workflows/core_video_to_funscript.json](workflows/core_video_to_funscript.json) for a separate workflow using ComfyUI's native input and inference nodes. The original combined node and all original workflows remain available.

```text
Load Video → Trim Video → Get Video Components → Run SAM3D Body Prediction
                                                   ↑
                                         Load SAM3D Body Model

SAM3D poses + the same trimmed VIDEO → Core SAM3D → Funscript Poses
                                    → Poses → Multi-axis Motion
                                    → Preview & Export Funscripts
```

The new **Core SAM3D → Funscript Poses** adapter has two connections and no model-loading controls. Connect `MHR_POSE_DATA` from native prediction and the same `VIDEO` supplied to **Get Video Components**. The adapter reads source frame timestamps, preserves the original timeline through trims, and writes a pose cache compatible with **Load SAM3D Pose Cache**. A frame-count mismatch stops conversion rather than silently shifting the script.

The example uses every frame, batch size 8, and hand refinement disabled to match the combined node's inference settings. Native SAM3D exposes hand refinement, field of view, batch size, tracking data and bounding-box inputs for further changes. Full-frame single-person prediction is used when no tracking/boxes are connected.

Core **Get Video Components** materializes the selected frames in RAM. Set a duration in **Trim Video** for long sources; the original combined node remains the streaming option with sampling and frame limits. The adapter currently supports file-backed **Load Video / Trim Video** inputs and matching uncropped image batches. It does not infer person identity or detect scene cuts. Model choice remains in the saved upstream workflow; native pose output does not carry checkpoint provenance.

After reloading ComfyUI's custom nodes, both entry points appear under `motion/SAM3D Funscript`. The API companion is [core_video_to_funscript.api.json](workflows/core_video_to_funscript.api.json).

## Nodes

| Node | Purpose |
|---|---|
| SAM3D Video → Cached Poses | Decode a bounded number of frames, preserve presentation timestamps, invoke native body inference in batches, save compact poses to NPZ. |
| Load SAM3D Pose Cache | Resume authoring from an NPZ without loading model weights. |
| Core SAM3D → Funscript Poses | Adapt native `MHR_POSE_DATA` and its source `VIDEO`, preserving timestamps and writing an editor-compatible pose cache. |
| Poses → Multi-axis Motion | Build body/camera-relative curves and map them to normalized axes. |
| Load Funscript Project | Reopen `project.json`, including manual browser edits. |
| Preview & Export Funscripts | Save a new run directory and expose its synchronized editor. |
| Compare Reference Funscript | Attach a paired authored script, measure curve agreement and display it in the editor. |

Paths may be absolute, or relative to the ComfyUI input directory. The supplied example uses `videos/nsfw/rcowgirl_6.mp4`. Select `sam_3d_body_dinov3_bf16.safetensors`; the tested installation resolves it through the existing detection model path.

In the original combined node, `sample_fps=16` selects actual frames on a 16 Hz sampling grid. Set `0` for all frames. `max_frames` bounds memory and inference work; `duration_seconds=0` processes until EOF or that limit. Inference holds at most one batch of source frames and retains compact landmarks, rather than all meshes and images.

`start_seconds` and `duration_seconds` select an analysis interval. **Export timestamps remain aligned to the original source video**, including when the interval starts after zero. The first position is held before the analysed interval; the last is held through its final sampled frame. An unanalysed tail is not extrapolated.

### Person ROIs

`rois_json` is an ordered list of normalized `[x, y, width, height]` rectangles:

```json
[[0, 0, 1, 1]]
```

This runs one full-frame person estimate. With two separately selected crops, slot `0` can be the target and slot `1` the reference. Crop slots have a fixed order; overlapping crops can estimate the same person, and occluded people can be hallucinated by the model. Finite output is recorded as validity, **not as visibility or confidence**. The preview draws each crop and estimated skeleton so those failures are reviewable.

Automatic SAM 3 mask tracking and interactive ROI drawing remain follow-up work for the combined node. The core-node alternative accepts native prediction output through the new `MHR_POSE_DATA` adapter and exposes the native predictor's optional tracking/bounding-box inputs.

### Coordinates and anchors

Native keypoints are converted to camera coordinates as:

```text
camera_point = pred_keypoints_3d + pred_cam_t
```

Units are estimated metres; camera X is right, Y down, Z forward. A torso basis is reconstructed from the two hips and shoulders, avoiding the separate native rig-rotation basis convention.

Available anchors are pelvis midpoint, shoulder midpoint (`chest`), nose and either wrist. They are anatomical pose landmarks; no contact point or pressure is inferred.

- `reference_person=-1`, `frame=camera`: follows target motion in camera coordinates.
- A second reference person with `frame=camera`: subtracts the reference anchor in camera coordinates.
- A second reference person with `frame=reference_body`: also expresses the displacement and orientation in the reference person's torso frame.

The body-relative calculation cancels a shared rigid camera transform mathematically. Independently estimated body scale, depth and occluded poses can still be inconsistent. Monocular 3D reconstruction does not establish metric ground truth.

### Axis calibration

The default channel components are:

| Axis | File | Default motion component |
|---|---|---|
| L0 | `name.funscript` | Up displacement |
| L1 | `name.surge.funscript` | Forward displacement |
| L2 | `name.sway.funscript` | Left displacement |
| R0 | `name.twist.funscript` | Rotation about up |
| R1 | `name.roll.funscript` | Rotation about forward |
| R2 | `name.pitch.funscript` | Rotation about left |

These are editable signal mappings. Axis labels do not establish a device's physical orientation. Rotation channels are projections of a relative rotation vector; the illustration applies them as ordered rotations. They are useful authoring signals, not exact platform IK or independently measured contact rotations. Continuous multi-revolution rotation is not supported.

`enabled_axes` controls which files are emitted. For stroke-only authoring, use `L0`.

Each valid span uses the initial 500 ms to establish a neutral position and orientation. Translation curves use a fixed gain, without per-frame min/max stretching. An offline symmetric Gaussian filter runs on a uniform grid inside each span and is sampled back at the actual timestamps. `smoothing_ms` is its standard deviation, not a moving-window width. Cuts and missing-data gaps reset the neutral and filter; exported curves hold across a gap and step when the next span begins. These boundaries need review and manual editing if a continuous transition is desired.

For advanced settings, put this in `settings_json`:

```json
{
  "neutral_window_ms": 500,
  "max_gap_ms": 250,
  "tolerance": 0.75,
  "axis_settings": {
    "L0": {"component": 0, "range": 0.4, "center": 50, "invert": false},
    "R0": {"component": 0, "range": 90, "center": 50, "invert": false}
  }
}
```

`range` is the physical signal extent mapped across 100 position units: metres for translation, degrees for rotation. A 0.4 m range at center 50 maps −0.2 m to 0 and +0.2 m to 100. Larger ranges reduce gain. Component indices `0,1,2` mean up, forward, left within the selected coordinate frame. Values are rounded to integer positions and clamped to 0–100. The preview reports the percentage of source samples clipped by that calibration.

Simplification limits vertical interpolation error to `tolerance` position units relative to the rounded, filtered sample curve. Position quantization adds up to 0.5 units relative to the unrounded curve; no accuracy claim is made between unsampled video frames. The editor and export both use linear interpolation and matching rounding.

## Edit and save

The source video is the playback clock. Seeking updates the overlay, 3D skeleton, platform and curves. The selected anchor is marked in yellow, with a one-second projection trail. This identifies the named landmark; it does not add click-to-select tracking. The pose display uses the nearest analysed frame; the platform evaluates the actual funscript actions at the video time. A 16 Hz pose sample is therefore less temporally precise than the original 32 fps video.

- Click the timeline to seek; double-click to add an action.
- Drag a point to edit its time and position; right-click to remove it.
- Choose a 4-second or 1-second view for detailed edits.
- Adjust range, center, component or inversion, then **Regenerate selected axis**. This replaces manual edits on that axis; Undo restores them.
- Change smoothing in the ComfyUI motion node and queue again. Cached poses avoid inference.
- **Download project + scripts** saves a ZIP containing all active axes and `project.json`.

Browser edits remain in memory until downloaded. They do not silently overwrite the node's original exports. Extract the ZIP and pass its `project.json` to **Load Funscript Project → Preview & Export Funscripts** to save those edits through ComfyUI. A local-file project opened directly in the editor requires selecting its matching source video.

Each node export writes a new directory under `output/sam3d_funscript/`, so earlier runs remain intact and disabled axes do not leave stale files alongside new ones. Pose caches live in the `cache/` subdirectory. The combined node's cache identity includes source/model paths, sizes and modification times, inference settings and the native predictor source's file metadata. It is not a content hash of large video/model files; use `use_cache=false` if files have been replaced while retaining their metadata. The core adapter hashes the received pose/timing arrays and source metadata; upstream inference caching remains under ComfyUI's control.

The project contains raw/processed motion, camera-space landmarks, projections, selected settings, original PTS/time bases and source/model provenance. Keep the source file in place for server playback. No source video is copied into exports.

## Compare a paired reference

Open [workflows/video_with_reference.json](workflows/video_with_reference.json), set the video and `.funscript` paths, and run. **Compare Reference Funscript** sits between motion conversion and export. Alternatively, use **Open reference script** in the editor to attach a reference to the currently selected axis.

The reference appears in purple. The editor displays mean absolute error (MAE), root mean squared error (RMSE), and correlation over the common analysed interval. Positions are compared as written; legacy `inverted`/`range` headers are recorded but not applied. A positive **reference offset** shifts reference actions later in the video. It never changes generated action timing.

Errors are in position units on the 0–100 scale. Correlation measures waveform agreement, not a percentage of accuracy. An authored funscript can include deliberate changes of range, timing, or rhythm, so it is not ground truth for 3D position or contact. A stationary output can have low position error; always inspect its motion amplitude and reversal matching too.

For reproducible calibration from an existing pose cache:

```bash
MPLCONFIGDIR=/tmp/s3f-matplotlib \
PYTHONDONTWRITEBYTECODE=1 /media/p5/miniforge3/envs/13_env_py313/bin/python \
  scripts/calibrate_reference.py \
  --cache /absolute/path/to/pose-cache.npz \
  --reference /absolute/path/to/reference.funscript \
  --output development/calibration/example --name example
```

This fits gain and center on the first 60% of the analysed overlap, selects among five anchors, three translation directions and four smoothing values on the next 20%, then evaluates the selected configuration on the final 20%. One-second gaps separate the partitions. The time offset stays at zero. Tests verify that changing test labels cannot change the selected configuration.

Outputs include `report.json`, `REPORT.md`, `selected-config.json`, PNG/PDF comparisons, and separate baseline/calibrated review projects. The report compares against a constant training-median baseline and matches same-direction reversals within 200 ms, using 10-position-unit prominence. Matched-event timing errors must be read together with precision/recall, since unmatched events otherwise disappear from a timing average. Reference-comparison browser metrics cover the full overlap; held-out metrics are explicitly identified in the report.

Selected configurations are diagnostic candidates. The command does not update node defaults or establish a validated preset. These examples only reference L0; they cannot calibrate or validate the other five axes.

Results from the two supplied reference pairs are documented in [the calibration results](research/calibration/RESULTS.md). Neither produced a reliable final script with the current scalar body-anchor method; the reports retain that negative result and show the constant baseline alongside the fitted curves.

## Validation

The tested environment is Python 3.13.11, Torch 2.11.0+cu130, RTX 5090, and the local ComfyUI native SAM3D implementation. NumPy, SciPy and PyAV were already installed; no environment packages were changed.

```bash
PYTHONDONTWRITEBYTECODE=1 /media/p5/miniforge3/envs/13_env_py313/bin/python -m unittest discover -s tests -v
node tests/test_curve.mjs /absolute/path/to/project.json
```

Tests cover variable-rate timestamps, rigid-camera invariance in a body reference frame, gap holds, filter isolation across cuts, fixed-gain behavior, interpolation error, cache/project round trips, action validation and browser/Python export parity.

The real-video runner is reproducible:

```bash
PYTHONDONTWRITEBYTECODE=1 /media/p5/miniforge3/envs/13_env_py313/bin/python \
  scripts/develop_video.py \
  --video /media/unraid/comfyui/input/videos/nsfw/rcowgirl_6.mp4
```

The first full test produced 270 poses over the 16.844-second clip in 44.99 seconds including model loading, with 3.09 GB peak Torch allocation and 3.66 GB reserved. All output poses were finite. Default L0/L1 calibration clipped about 14%/19% of samples, demonstrating why the calibration/preview stage matters. This measures execution, not correspondence to ground-truth motion.

A second test on the first four seconds of `cowgirl_7.mp4` produced 64 finite poses in 26.79 seconds including model loading. No samples clipped under the default calibration in that interval.

The complete three-node graph also passed the actual ComfyUI queue. Browser tests cover video decoding/seeking, regeneration, undo, action dragging, ZIP download, responsive layout and canvas preview restoration. Local diagnostic outputs are under `development/`; they are excluded from version control.

The additional eight-node core workflow passed a full 539-frame run and a 32-frame trim from 4–5 seconds, preserving original timestamps. Its canvas connections/native settings, editor controls and downloads passed browser checks. All 20 Python tests and JavaScript curve/export checks pass. Reproduce the core queue check with `scripts/core_queue_smoke.py --base http://127.0.0.1:8198` on the isolated test instance.

## Next stages

The [selected-point tracking pilot](research/calibration/POINT_TRACKING.md) now provides a reproducible CoTracker3 experiment and a synchronized point/curve preview. On one 30-second Eva section it matched 5 of 9 evaluation reversals, compared with none for a locally calibrated SAM3D wrist. It also lost the selected point for substantial intervals and showed identity drift. This is an experimental development result, not a validated full-video method or a new node default.

1. Interactive target points/reference/direction, group consistency checks, and reselection at occlusions or identity changes.
2. Mask tracking and explicit visibility, with identity evaluation through occlusion and cuts.
3. Device-specific OSR/SR6 geometry and IK, workspace/velocity diagnostics and deterministic seekable simulation.
4. Ground-truth or manually annotated evaluation across viewpoints, occlusion and longer clips.

The evidence and ecosystem comparison are in [the research blueprint](research/SAM3D_FUNSCRIPT_BLUEPRINT.md). The current implementation is intentionally distinguished from that longer roadmap.
