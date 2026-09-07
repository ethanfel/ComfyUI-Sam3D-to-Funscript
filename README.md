# ComfyUI SAM3D to Funscript

A working first version of a local **video → SAM 3D Body → multi-axis motion → editable preview → funscript** pipeline.

The node uses ComfyUI's native SAM 3D Body implementation and your existing model. Pose inference is cached separately from motion authoring. The browser editor includes the source video, projected skeleton, an orbitable 3D skeleton, a main timeline with additional anchor tracks, six output axes and selectable Handy 2 / SR6 wireframe previews.

**Status:** development version, tested on the provided `rcowgirl_6.mp4` and the local `13_env_py313` environment. This is an authoring tool. Device models are schematic; the SR6 renderer solves illustrative linkage geometry, without device calibration, collision modelling or hardware control. Static person ROIs require visual review; they do not provide automatic identity tracking.

## Open it locally

The project is installed in:

```text
/media/p5/Comfyui/custom_nodes/ComfyUI-Sam3D-to-Funscript
```

Load [workflows/video_to_funscript.json](workflows/video_to_funscript.json) in ComfyUI. It is a canvas-editable workflow using core video input and streaming inference:

1. **Load Video** (core): select or upload a video and connect its `VIDEO` output.
2. **SAM3D Video → Cached Poses:** select the model, sampling and person ROI(s).
3. **Poses → Multi-axis Motion:** choose anchors, reference frame, smoothing and enabled axes.
4. **Preview & Export Funscripts:** write scripts and a project, then open the embedded preview or **Open full motion editor**.

Core **Load Video → SAM3D Video → Cached Poses** preserves the original node's lower-RAM streaming behavior. **Load Video** supplies a lazy file reference; the inference node decodes selected frames in small batches. No **Get Video Components** node is needed. Optional core **Trim Video** can sit between them.

The streaming extractor feeds uint8 frames directly into native SAM3D crop processing, bounds full-resolution working buffers separately from the GPU batch, and skips unused mesh-preview calculations. On the tested RTX 5090, repeated 128-frame runs were about **2× faster**, with batch-64 peak process RAM reduced from **10.4 GiB to 4.2 GiB**. Start with batch **32**, then try **64** if memory permits. Batch 128 provided little additional throughput on that clip. See [performance measurements and reproduction commands](docs/performance.md).

Saved path-based canvas workflows migrate on opening: the extension adds **Load Video**, transfers the saved filename and keeps the existing inference settings and downstream connections. If the old filename was an absolute path outside ComfyUI's input directory, select/upload it through **Load Video**. API clients should use the updated [API example](workflows/video_to_funscript.api.json).

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

The **Core SAM3D → Funscript Poses** adapter requires two connections: `MHR_POSE_DATA` from native prediction and the same `VIDEO` supplied to **Get Video Components**. Its optional `sam3d_body_model` input accepts the same loaded model to recover mouth corners from body-only predictions; the example includes this connection. It performs no additional model inference. The adapter reads source frame timestamps, preserves the original timeline through trims, and writes a pose cache compatible with **Load SAM3D Pose Cache**. A frame-count mismatch stops conversion rather than silently shifting the script.

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
| Detailed Anchor Override | Select any of the 70 native landmarks and override the target or reference anchor through an optional connection. |
| Load Funscript Project | Reopen `project.json`, including manual browser edits. |
| Preview & Export Funscripts | Combine numbered anchor projects into source tracks, save a new run directory and expose the synchronized main timeline. |
| Compare Reference Funscript | Attach a paired authored script, measure curve agreement and display it in the editor. |

Video selection now belongs to core **Load Video**, which reads ComfyUI's input directory. The supplied example uses `videos/nsfw/rcowgirl_6.mp4`. Cache, project and reference-script paths may still be absolute or relative to the input directory. Select `sam_3d_body_dinov3_bf16.safetensors`; the tested installation resolves it through the existing detection model path.

In the original combined node, `sample_fps=16` selects actual frames on a 16 Hz sampling grid. Set `0` for all frames. `max_frames` bounds memory and inference work; `duration_seconds=0` processes until the upstream trim ends, EOF or that limit. Inference holds at most one batch of source frames and retains compact landmarks, rather than all meshes and images. Model memory requirements are unchanged. This streaming input supports file-backed **Load Video / Trim Video**; generated in-memory videos and spatial crops need saving/loading first. Use the node's person ROIs for inference crops, and bake any video rotation metadata into the pixels.

`start_seconds` is an additional offset inside the connected video's trim; `duration_seconds` selects how much to analyse from there, capped at the upstream trim's end. **Export timestamps remain aligned to the original source video**, including when the interval starts after zero. The first position is held before the analysed interval; the last is held through its final sampled frame, capped at the selected end time. An unanalysed tail is not extrapolated.

### Person ROIs

`rois_json` is an ordered list of normalized `[x, y, width, height]` rectangles:

```json
[[0, 0, 1, 1]]
```

This runs one full-frame person estimate. With two separately selected crops, slot `0` can be the target and slot `1` the reference. Crop slots have a fixed order; overlapping crops can estimate the same person, and occluded people can be hallucinated by the model. Finite output is recorded as validity, **not as visibility or confidence**. The preview draws each crop and estimated skeleton so those failures are reviewable.

Mask videos can now supply the person selection as described below. Generating those masks and interactive ROI drawing remain follow-up work for the combined node. The core-node alternative accepts native prediction output through the `MHR_POSE_DATA` adapter and exposes the native predictor's optional tracking/bounding-box inputs.

### Mask videos for separate people

The streaming node accepts an optional **`mask_video` VIDEO input** from another core **Load Video** node. Supply one person's white-on-black mask video. Values of 128–255 select the person; 0–127 select background. The node passes the mask to native SAM3D for mask-conditioned inference; it does not just crop the source or black out its background.

Connect the original clip to `video` and the person's mask clip to `mask_video`. In this mode the mask supplies the moving crop, `rois_json` is ignored, and the selected person is always **`target_person=0`**. The preview shows the mask's moving bounding rectangle and the selected anatomical anchor.

Use [mask_videos_to_funscripts.json](workflows/mask_videos_to_funscripts.json) for two independent script branches sharing one source video. Select a source and one mask file for each person. Both branches use person slot 0 because each analyses its own mask. Duplicate a branch for more people. These are separate scripts; this workflow does not combine the branches into a body-relative two-person pose sequence.

- Masks must cover the full source canvas. A lower resolution with the same aspect ratio is supported; cropped mask images are not aligned.
- Preserve the original frame timestamps. Encoding rounding up to 1 ms is accepted. Mismatched timestamps or a mask ending before a required frame stop extraction rather than silently shifting the selected person.
- Masks use the original source timeline. If trimming with core **Trim Video**, keep source and mask on that same timeline; a separately exported trim that restarts at zero must be aligned before use. The node's `start_seconds` and sampling controls apply to both streams.
- A completely black mask frame is a missing pose. It never falls back to full-frame person detection. Existing gap handling holds the previous script position and resets motion processing when the person returns.
- The mask must keep identifying the same person. A mask containing multiple people is treated as one prompt; the node does not split it or repair identity switches from an upstream tracker.

The node keeps a small source-frame batch, one decoded mask frame and packed masks for that batch. It never materializes the complete mask video as `MASK`/`IMAGE` tensors. Model and per-batch mask processing still need RAM/VRAM. Each person's mask file and trim settings are included in the pose-cache key; replacing a mask invalidates that branch's cache without affecting other branches.

### Coordinates and anchors

Native keypoints are converted to camera coordinates as:

```text
camera_point = pred_keypoints_3d + pred_cam_t
```

Units are estimated metres; camera X is right, Y down, Z forward. A torso basis is reconstructed from the two hips and shoulders, avoiding the separate native rig-rotation basis convention.

Both `target_anchor` and `reference_anchor` offer **nine general choices**: `pelvis`, `chest`, `nose`, `left_wrist`, `right_wrist`, `left_hand`, `right_hand`, `neck`, and `mouth`. Pelvis averages the hips; chest averages the shoulders; mouth averages the two outer mouth corners. Each hand anchor averages **all 21 hand landmarks: wrist and 20 finger points**. This centroid moves with finger articulation; it is not a fixed palm or contact point. Left/right refer to the person's anatomical sides.

For a specific point, add **Detailed Anchor Override** and connect it to `target_anchor_override` or `reference_anchor_override`. A connected override takes precedence over that dropdown. Use two selector nodes for different target/reference landmarks, or share one selector to use the same landmark on both people. The reference anchor is ignored when `reference_person=-1`.

The selector offers all 70 named [MHR70 landmarks](https://github.com/facebookresearch/sam-3d-body/blob/main/sam_3d_body/metadata/mhr70.py):

- Body: shoulders, elbows, hips, knees, ankles and neck.
- Face: nose, eyes and ears.
- Hands: both wrists and each finger's tip plus three joints. MHR numbers these joints from the fingertip toward the hand; `third_joint` is the base.
- Feet: big-toe tips, small-toe tips and heels.
- Additional surface landmarks: olecranon (back of elbow), cubital fossa (inner elbow) and acromion (shoulder tip), on both sides.

The [detailed-anchor example](workflows/detailed_anchor_override.json) reopens a pose cache and overrides `left_hand` with `left_index_tip`. Disconnect the override to return to the hand average. Its [API companion](workflows/detailed_anchor_override.api.json) shows the same connection.

Saved canvas workflows that selected a detailed point migrate on opening: their selection moves into a connected override node. Existing detailed values in API prompts and saved projects remain supported.

The 70 native body/hand landmarks do not include lips. The pack appends the right and left outer mouth corners as cache points 70 and 71, using [Goliath landmarks 188 and 189](https://github.com/facebookresearch/sapiens/blob/main/pose/configs/_base_/datasets/goliath.py). It keeps native facial landmarks when available, or recovers the same two points from the existing mesh and joints with the loaded model's landmark mapping. Only these two extra points and their projections are retained; this adds about 40 bytes per frame/person without another inference pass. The streaming node handles recovery automatically. For body-only core predictions, connect the same upstream model to the adapter's optional `sam3d_body_model` input.

**Mouth follows the reconstructed mouth position.** The base body model uses a neutral facial expression, so this does not measure mouth opening, contact, or whether the mouth is visible. Its position still needs visual review during head turns and occlusion. New streaming runs automatically use the updated cache version. Existing 70-point caches remain usable for body/hand anchors, but selecting mouth requires re-extraction; a core cache without mouth points requires rerunning the adapter with the model connected.

Changing an anchor uses the landmarks already stored in the pose cache; no new inference is needed once the cache includes the requested landmarks. The yellow target marker and its trail follow the selected point in the video and 3D preview. Anchor choice changes translation; rotation channels still use the torso basis. Finger and occluded-point estimates require review, especially with hand refinement disabled. These are anatomical pose landmarks; no contact point or pressure is inferred.

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

These are editable signal mappings. Axis labels do not establish a device's physical orientation. Rotation channels are projections of a relative rotation vector; the SR6 illustration applies pitch then roll, with twist local to its inner receiver. They are useful authoring signals, not calibrated hardware commands or independently measured contact rotations. Continuous multi-revolution rotation is not supported.

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

Choose **Source component → Auto · 3D direction**, then **Regenerate selected axis**, to combine all three components into the dominant movement direction while keeping your range and center. This works for upright, horizontal and diagonal motion with any anchor. The blue arrow in the 3D pose view shows the selected direction and follows Invert. On a rotation channel, it shows the dominant rotation axis and uses degrees.

**Auto fit selected axis** also fits range and center, preserving Invert and every other channel. It maps the central 90% of the projected samples approximately into positions 10–90. A minimum range of **0.04 m for translation / 10° for rotation** prevents tiny motion from being stretched across the whole script. Range may expand further to keep Center within 0–100. This gain is fitted across the analysed clip; a later large movement can compress earlier small strokes. Direction-only Auto plus a manual range is useful in that case. Both controls replace edits on the selected axis and support Undo. They work on existing projects and offline exports, without rerunning SAM3D.

When one part of a clip has much smaller motion than the rest, select its time interval on a source row and click **Fit selection as track**. This creates a new row that fits direction and gain only within that interval. It subtracts a local neutral position from the cached motion in each uninterrupted span, so a large offset from the initial pose cannot force the range wider or clip the curve when the gain increases. The original source row and main stay intact. The new row shows its time window, shades the unused timeline, and snaps the selection inward to available pose timestamps. Review the result, then use **Use selection in main** with a blend or manual join.

The section track maps its full filtered range into positions 5–95 to retain peak shape, keeping the 4 cm / 10° minimum range and the source row's Invert setting. **Auto fit selected axis** and regeneration remain local on that row. Reassigning its project or source axis resets it to that project's full curve. Window calibration and pose provenance survive Undo, removing the source row after insertion, saving, and offline reopening. This changes motion mapping; it does not improve or independently verify the underlying pose estimates. For example, the provided hand clip's later interval occupied about 8 points with a 41.9 cm whole-clip range; local fitting used about 5.9 cm and gave approximately 63 points over the central 90% of its estimated samples, with no filtered samples clipped.

Automatic direction is a principal-component fit to short-window displacements of the filtered 3D signal, sampled uniformly at up to 30 Hz. Mean displacement removal keeps constant drift from selecting the direction; clipping large displacement-vector lengths reduces outlier influence. For short or constant-speed spans it falls back to position variation. Each uninterrupted valid span gets a fixed direction, so cuts and missing poses cannot influence the fit across a boundary. The target's neutral torso orientation resolves the sign; mixed motion without a dominant direction uses a torso axis. Older projects derive that orientation from their stored pose geometry. The displayed **directional share describes measured variation, not tracking confidence**. Camera movement, depth-estimation errors, changing motion direction within a span and nonrigid motion can still mislead the fit. Body orientation does not establish an interaction/contact axis.

**New motion projects default to Auto 3D direction and Auto fit for L0 stroke.** The other five channels keep their distinct component mappings. Existing saved projects keep their saved calibration. Applying Auto to several translation channels would select the same dominant translation; rotation channels likewise share one dominant rotation. The equivalent explicit configuration is:

```json
{"axis_settings": {"L0": {"component": "auto", "auto_fit": true}}}
```

Set `auto_fit` to `false` to keep a specified `range` and `center`. Providing an explicit `component`, `range`, or `center` also disables automatic fitting unless `auto_fit: true` is explicitly supplied. An empty configuration uses the new L0 defaults.

Simplification limits vertical interpolation error to `tolerance` position units relative to the rounded, filtered sample curve. Position quantization adds up to 0.5 units relative to the unrounded curve; no accuracy claim is made between unsampled video frames. The editor and export both use linear interpolation and matching rounding.

## Edit and save

### Main timeline and anchor tracks

Load [workflows/multitrack_anchors.json](workflows/multitrack_anchors.json) for a shared pose cache feeding **mouth**, **left hand** and **right hand** motion projects into one editor. Set the cache path, or connect the same `poses` output from your streaming/core workflow to the three **Poses → Multi-axis Motion** nodes. Each branch has independent anchor, reference and axis calibration. Changing these branches does not rerun pose inference.

**Preview & Export Funscripts** starts with `project_0`. Connecting it adds `project_1`, and each connected last socket adds another. There is no fixed project/track count limit. Disconnecting a middle project retains the other socket names and connections. Old canvas workflows migrate their `project` socket automatically; existing API prompts using `project` still work. The [multitrack API example](workflows/multitrack_anchors.api.json) shows numbered inputs.

1. Select the **Main axis** to assemble, such as **L0 · stroke**. The first numbered project supplies its initial main curve; other enabled axes are retained too.
2. Every connected project adds a source row. Click **Edit** or its curve to select it; the yellow marker and 3D view show that row's anchor. Its **Project** and **Axis** selectors can be reassigned freely. Reassignment resets that row to the chosen project's calibration and curve; Undo restores its previous edits. **Add track** creates another independently editable row, including alternate calibrations of the same project. Track names are editable.
3. Use the shared component, range, center, **Invert**, and **Auto fit** controls on the selected row. Tune each source before copying sections. The device always plays the **main** curves, so comparing or editing a source does not change the export.
4. **Shift-drag** on any curve to select a time range. Alternatively, seek and use **Mark in / Mark out** (keyboard **I / O**), type the In/Out times in seconds, or choose **Select track range**. All rows use the same ruler and playhead.
5. Select a source row and click **Use selection in main**. **Blend** crossfades from the existing main into the source and back inside the selected interval; the duration is per boundary, capped at half the selection. **Cut · manual join** inserts the source directly with one-millisecond boundary steps. Select main and drag/add/delete points to shape a join manually. Both methods preserve the original video timestamps and leave the rest of main in place; new boundary samples are rounded to integer positions. Blend sampling targets 0.25 position units of interpolation error before rounding, with a one-millisecond minimum step.
6. **Use whole track as main** replaces the selected output axis with that row's full authored curve. **Undo** restores section inserts, replacements, calibration, point edits and track changes. Other output axes remain independent.

Copied sections are snapshots: later source edits, reassignment or removal leave those sections intact until you apply another selection. Source names mark the assembled sections on main; selecting main makes the pose overlay follow their recorded anchors. Blend regions show the incoming source's anchor. Main remains editable and invertible after composition. Its raw regeneration/Auto fit controls are disabled because one anchor's raw motion cannot regenerate a curve assembled from several sources; calibrate a source row and apply it again instead.

Connected projects must reference the **same original video**. Different sampling rates, analysed trims and per-person masks can share that timeline; section copying is bounded by the selected source's first and last pose timestamps. Whole-track replacement holds its endpoint values outside the authored action range. There is no clip retiming or automatic detection of when to switch anchors. Shared pose arrays are stored once in the project, while each source keeps its own motion/calibration. Additional curves still consume memory; offscreen source rows skip drawing during playback.

`project.json` and the offline viewer preserve source projects, track assignments, calibrations, authored curves, selection and section provenance. Only the six **main** axes produce `.funscript` files. To resume an assembled project through ComfyUI, connect **Load Funscript Project** to one preview input by itself. To start another composition, connect the original anchor projects together. Requeuing upstream branches creates a new export using the saved editor state for that preview node.

### Locks and reruns

Each source row and each main axis has a **Lock / Unlock** button. A locked track keeps its curve, calibration, source assignment and pose provenance through reruns, changed upstream motion, added inputs, browser reloads and project exports. It cannot be dragged, regenerated, inverted, reassigned or removed. A locked main rejects section insertion and whole-track replacement. You can still seek, select time, inspect a locked source, derive a new fitted row from it, or copy it into an unlocked main. **Unlock** is explicit; changing a lock clears Undo history so Undo cannot reach behind it and replace protected work.

Same-video reruns keep the loaded video and playback position. Changing the source file reloads the player in both editor views, releases any previously selected local video, and opens the new video's timeline view. A changed size or modification time also triggers a reload when a file is replaced at the same path.

The ComfyUI editor automatically saves edits and locks under `output/sam3d_funscript/editor_sessions/`. Wait for **Edits and locks saved locally** after locking. The embedded and full editor share that state. The normal ComfyUI Run action flushes pending changes in both views before queuing, and the preview/export node runs again even when upstream poses are cached. Save the workflow to retain its preview session ID across restarts. Existing generated export folders remain unchanged; the next run writes a new export containing the saved main curves.

Reruns refresh untouched tracks, preserve edited or locked tracks, and append rows for newly connected inputs. Copied main sections and selection-fitted tracks retain their source snapshots. Updated source versions appear in the Project selector; explicitly reassign an unlocked row to use one. Historical geometry is retained only while a track or main section uses it. Removing a connection does not delete authored rows. A different source video cannot replace a session containing locked tracks: use a new preview node for that video, or explicitly unlock the old tracks.

If two editors write from different revisions, the older save is rejected with a visible message, preserving the saved state. Download that unsaved draft before reloading it. Offline viewers retain locks in the exported project but require **Download project + scripts** to persist further edits. API prompts without a workflow session remain independent exports; to use a session through the API, supply the preview node's saved `s3f_session` property in `extra_data.extra_pnginfo.workflow`.

### Playback and curve editing

Long clips open with a **30-second view**; shorter clips fit in full. Every motion track shares one zoom level, visible interval and playhead. Drag the **horizontal scrollbar** to browse the clip without seeking the video. **Shift-scroll** or a horizontal trackpad gesture also pans; **Ctrl/Cmd-scroll** zooms around the pointer. The slider and +/− buttons zoom around the visible playhead, or the center of the inspected section when the playhead is offscreen. Time rulers use minutes/hours with finer precision as you zoom in.

**Fit selection** shows the marked interval. **Show playhead** brings playback back into view. **Follow playhead** advances the view when playback leaves it; manual panning or zooming at the pointer disables following so the editor keeps the region you chose. Click a curve to seek using that track's original timestamps. At overview scales, dense action handles are hidden; zoom in to drag individual points. Navigation works on locked tracks and never changes their actions or calibration.

Curves draw the visible samples and their interpolation neighbors. Dense overviews retain extrema within each screen pixel; this only reduces drawing detail, never the exported actions. Static curve layers are cached during playback, and offscreen source rows release those layers. The viewport uses a virtual horizontal scrollbar instead of a clip-wide canvas. Zoom and scroll position are remembered locally for the video and included in downloaded projects and standalone viewers.

The source video is the playback clock. Seeking updates the overlay, 3D skeleton, selected device and curves. The selected anchor is marked in yellow, with a one-second projection trail. This identifies the named landmark; it does not add click-to-select tracking. The pose display uses the nearest analysed frame; the device evaluates the actual funscript actions at the video time. A 16 Hz pose sample is therefore less temporally precise than the original 32 fps video.

Choose **Handy 2 · stroke only** to preview L0 or **SR6 · six axes** for L0/L1/L2/R0/R1/R2. Readouts show only the selected device's supported channels; missing channels hold neutral at 50. Device selection controls the preview, while curve editing and exports retain every authored axis. Drag or use arrow keys to orbit the device, scroll or press +/− to zoom, and toggle the sleeve outline. SR6 uses a schematic six-linkage mechanism with an inner twist receiver. Dashed coral rods mark poses outside that model's linkage reach; this is not a calibrated hardware simulator. Geometry details and the interactive asset demo are in [assets/device-previews](assets/device-previews/README.md).

- Click the timeline to seek; double-click to add an action.
- Drag a point to edit its time and position; right-click to remove it.
- Use the zoom slider, +/− buttons or time presets to choose the visible interval, from the full clip down to 250 ms.
- Select main or a source row before changing its calibration; reference-script comparisons apply to main.
- **Invert** immediately mirrors the selected curve as `100 − position`, including manually edited points. It also mirrors Center as `100 − center`, keeping the range, timestamps and existing clipping unchanged. No regeneration is needed; Undo restores the previous curve.
- Adjust range, center or component, then **Regenerate selected axis**. This replaces manual edits on that axis; Undo restores them.
- Change smoothing in the ComfyUI motion node and queue again. Cached poses avoid inference. Untouched tracks refresh; edited or locked rows retain their curves. To adopt the new motion on an authored row, unlock it and select the updated source in its Project selector.
- **Download project + scripts** saves a ZIP containing all active axes, `project.json`, and a self-contained `viewer.html` with the selected device and current edits.

ComfyUI session edits are saved locally; standalone browser edits need downloading. Original export folders are preserved. Extract the ZIP and open **viewer.html** directly in a browser, then choose the matching source video. The editor, both device renderers and project are embedded: offline playback, editing and re-export work without ComfyUI or a web server. Node exports also include this HTML. Pass `project.json` to **Load Funscript Project → Preview & Export Funscripts** to save those edits through ComfyUI.

If an older Invert operation already flattened a curve, use Undo to recover the earlier curve, or **Auto fit selected axis** to rebuild it from the cached motion. Mirroring alone cannot recover samples already clipped in the saved actions.

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

This fits gain and center on the first 60% of the analysed overlap, selects among the available anchors, three translation directions and four smoothing values on the next 20%, then evaluates the selected configuration on the final 20%. The original published calibration reports used five anchors; expanding the selector does not update those historical results. One-second gaps separate the partitions. The time offset stays at zero. Tests verify that changing test labels cannot change the selected configuration.

Outputs include `report.json`, `REPORT.md`, `selected-config.json`, PNG/PDF comparisons, and separate baseline/calibrated review projects. The report compares against a constant training-median baseline and matches same-direction reversals within 200 ms, using 10-position-unit prominence. Matched-event timing errors must be read together with precision/recall, since unmatched events otherwise disappear from a timing average. Reference-comparison browser metrics cover the full overlap; held-out metrics are explicitly identified in the report.

Selected configurations are diagnostic candidates. The command does not update node defaults or establish a validated preset. These examples only reference L0; they cannot calibrate or validate the other five axes.

Results from the two supplied reference pairs are documented in [the calibration results](research/calibration/RESULTS.md). Neither produced a reliable final script with the current scalar body-anchor method; the reports retain that negative result and show the constant baseline alongside the fitted curves.

## Validation

The tested environment is Python 3.13.11, Torch 2.11.0+cu130, RTX 5090, and the local ComfyUI native SAM3D implementation. NumPy, SciPy and PyAV were already installed; no environment packages were changed.

```bash
PYTHONDONTWRITEBYTECODE=1 /media/p5/miniforge3/envs/13_env_py313/bin/python -m unittest discover -s tests -v
node tests/test_curve.mjs /absolute/path/to/project.json
node tests/test_migrate.mjs
```

Tests cover variable-rate timestamps, rigid-camera invariance in a body reference frame, gap holds, filter isolation across cuts, fixed-gain behavior, interpolation error, cache/project round trips, action validation and browser/Python export parity.

The multitrack suite covers geometry deduplication, different sampling, mismatched-video rejection, source isolation, section joins, overlapping section provenance, undo snapshots, and numbered socket growth with no fixed cap. Reproduce it with:

```bash
python -m unittest discover -s tests
node --test tests/test_curve.mjs tests/test_migrate.mjs tests/test_invert.mjs tests/test_timeline.mjs tests/test_local_fit.mjs
S3F_TEST_BASE=http://127.0.0.1:8198 python scripts/timeline_queue_smoke.py /absolute/path/to/72-point-poses.npz
node scripts/timeline_browser_smoke.mjs http://127.0.0.1:8198 PROJECT_ID development/timeline-browser development/timeline-workflow.json
```

The queue script writes the project ID and a local canvas fixture under `development/`. The browser fixture uses the supplied five-second side-view clip and verifies calibration, selection, blends/cuts, manual main edits, assignment, promotion, track removal, offline round trips and actual ComfyUI socket save/reload/queue behavior. Source video is hidden in saved QA screenshots.

`tests/test_local_fit.mjs` covers a small late movement on a different axis, large neutral offsets, gaps/cuts, minimum gain, inversion, unchanged pose geometry, and window provenance. `scripts/local_fit_browser_smoke.mjs BASE PROJECT_ID OUTPUT_DIRECTORY` exercises the provided 13.6-second hand clip with mouth/right-hand source rows, including locally fitted playback, blends, Undo and offline export/reimport.

The real-video runner is reproducible:

```bash
PYTHONDONTWRITEBYTECODE=1 /media/p5/miniforge3/envs/13_env_py313/bin/python \
  scripts/develop_video.py \
  --video /media/unraid/comfyui/input/videos/nsfw/rcowgirl_6.mp4
```

The first full test produced 270 poses over the 16.844-second clip in 44.99 seconds including model loading, with 3.09 GB peak Torch allocation and 3.66 GB reserved. All output poses were finite. Default L0/L1 calibration clipped about 14%/19% of samples, demonstrating why the calibration/preview stage matters. This measures execution, not correspondence to ground-truth motion.

A second test on the first four seconds of `cowgirl_7.mp4` produced 64 finite poses in 26.79 seconds including model loading. No samples clipped under the default calibration in that interval.

The streaming graph is tested through the actual ComfyUI queue. Browser tests cover video decoding/seeking, regeneration, undo, action dragging, ZIP download, responsive layout, canvas preview restoration and migration of the original path-based graph. Local diagnostic outputs are under `development/`; they are excluded from version control.

The additional eight-node core workflow passed a full 539-frame run and a 32-frame trim from 4–5 seconds, preserving original timestamps. Its canvas connections/native settings, editor controls and downloads passed browser checks. All 20 Python tests and JavaScript curve/export checks pass. Reproduce the core queue check with `scripts/core_queue_smoke.py --base http://127.0.0.1:8198` on the isolated test instance.

The updated streaming `VIDEO` input passed a fresh 270-sample run in 42.90 seconds, a six-frame interval bounded by an upstream trim plus a node offset, and a change to `left_index_tip` that reused the existing pose cache. Earlier CLI caches still load through the node. The expanded Python suite passes 24 tests, including all 72 anchor mappings and variable-rate trim timing. Run `S3F_TEST_BASE=http://127.0.0.1:8198 python scripts/stream_queue_smoke.py` against the isolated test instance to reproduce the new queue checks.

Mask-video validation uses a four-second, two-panel copy of the supplied clip with two half-resolution mask videos. Native GPU inference selected the correct panel in each 64-sample branch, preserved four deliberately blank mask frames per person, and reused independent pose caches. The nine-node canvas and masked editor passed browser checks; the unmasked ROI path also passed fresh inference. All 29 Python tests pass, covering mask packing, timestamp mismatches, missing-mask gaps and cache invalidation. This fixture validates mask integration, not an upstream tracker's identity accuracy. Reproduce it with `S3F_TEST_BASE=http://127.0.0.1:8198 python scripts/mask_queue_smoke.py`; the test uploads its generated videos under ComfyUI's `input/s3f_mask_test/` directory.

The anchor cleanup passes 30 Python tests plus JavaScript migration/export checks. The ComfyUI queue verifies all eight general anchors, both override inputs and legacy API selections against direct calculations. Browser checks cover the hand-average marker, short dropdowns, both migrated selections and save/reload. Reproduce the queue checks without inference using `S3F_TEST_BASE=http://127.0.0.1:8198 python scripts/anchor_queue_smoke.py --cache /absolute/path/to/poses.npz`.

Device integration passes 31 Python tests, the asset geometry checks (1,870 SR6 poses), the existing editor/ComfyUI browser checks and `scripts/device_browser_smoke.mjs`. Chrome verifies live playback and seeking for both devices, supported-channel readouts, Handy channel isolation and missing-L0 neutrality, the supplied demo, and offline video playback and re-export with networking disabled. A real ComfyUI export also preserves the scripts and writes `viewer.html`. These tests establish software integration and schematic geometry, not hardware fidelity.

Mouth support passes 36 Python tests and JavaScript curve/migration checks. On the GPU, recovered mouth corners matched native MHR's full landmark calculation exactly for the checked pose; this verifies the extraction math, not tracking accuracy against real lips. Four face crops were visually reviewed. Queue checks cover a 270-sample streaming clip, an eight-frame core body-only prediction, identical scripts after cache reload, body anchors without the optional model, and preserved missing-mask frames. Browser checks verify the mouth marker, seeking, editing, download and canvas reload. Reproduce the queue checks with `S3F_TEST_BASE=http://127.0.0.1:8198 python scripts/mouth_queue_smoke.py`; add `--mask-fixture` after generating the mask fixtures above. The anchor queue check now covers all nine general choices.

Auto direction adds eight tests (44 total): scene-rotation invariance, reference-body camera cancellation, drift, mixed/still motion, range floors, inversion, gaps/cuts, rotation units and browser/Python action parity with variable timestamps. ComfyUI queue checks reuse two real pose caches and verify exact browser/Python exports without changing other scripts. The side-view mouth example selects a diagonal direction with a 0.091548 m fitted range; its directional share is about 93%, which is not an accuracy score. Browser checks cover both Auto controls, the 3D arrow, manual overrides, Undo, rotation channels, video playback, selected-axis isolation, responsive layout and offline fitting/re-export of older projects. Reproduce with `S3F_TEST_BASE=http://127.0.0.1:8198 python scripts/auto_queue_smoke.py /absolute/path/to/project.json`, followed by `node scripts/auto_browser_smoke.mjs http://127.0.0.1:8198 BEFORE_PROJECT_ID` using the reported `before_project` directory name.

The inversion regression passes 45 Python tests, JavaScript checks on both saved clips, and the live/offline browser suite. It verifies exact reflection of authored actions and manual edits, mirrored calibration center, unchanged timing/range/clipping, regeneration, Undo and selected-axis isolation. Reproduce the focused check with `node tests/test_invert.mjs /absolute/path/to/project.json`; `scripts/auto_browser_smoke.mjs` also exercises immediate inversion and offline manual edits.

## Next stages

The [selected-point tracking pilot](research/calibration/POINT_TRACKING.md) now provides a reproducible CoTracker3 experiment and a synchronized point/curve preview. On one 30-second Eva section it matched 5 of 9 evaluation reversals, compared with none for a locally calibrated SAM3D wrist. It also lost the selected point for substantial intervals and showed identity drift. This is an experimental development result, not a validated full-video method or a new node default.

1. Interactive target points/reference/direction, group consistency checks, and reselection at occlusions or identity changes.
2. Mask tracking and explicit visibility, with identity evaluation through occlusion and cuts.
3. Device-specific OSR/SR6 geometry and IK, workspace/velocity diagnostics and deterministic seekable simulation.
4. Ground-truth or manually annotated evaluation across viewpoints, occlusion and longer clips.

The evidence and ecosystem comparison are in [the research blueprint](research/SAM3D_FUNSCRIPT_BLUEPRINT.md). The current implementation is intentionally distinguished from that longer roadmap.

## License

This project is licensed under the GNU General Public License version 3 only (`GPL-3.0-only`). See [LICENSE](LICENSE).

Third-party dependencies and model weights retain their respective licenses.

Lock regression checks: `tests/test_editor.py` covers default Auto/manual overrides, immutable locked source revisions, unchanged reruns, disconnections, incompatible video protection, restart persistence, stale-save rejection and exact exported actions. `scripts/lock_browser_smoke.mjs BASE MULTITRACK_PROJECT_ID OUTPUT_DIRECTORY` tests UI locks, actual Comfy execution, full/embedded editor synchronization, repeated reruns and offline locks. It uses the cached three-anchor fixture in `development/timeline-workflow.json` produced by the timeline queue smoke script.

Timeline navigation checks: `node --test tests/test_viewport.mjs` covers anchored zoom, boundaries, follow behavior, hour/subsecond rulers and peak-preserving display reduction. `node scripts/viewport_browser_smoke.mjs BASE MULTITRACK_PROJECT_ID OUTPUT_DIRECTORY` checks a synthetic one-hour timeline with 216,001 actions, real-video follow/pan behavior, synchronized seeking, locked curves, native scrolling, responsive layout and offline exports.

Video-switch regression: `node scripts/video_switch_browser_smoke.mjs BASE OLD_PROJECT_JSON NEW_PROJECT_JSON OUTPUT_DIRECTORY` exercises two real cached clips through the ComfyUI queue. It checks both editor windows, same-source playback preservation, new-source reload, local-video overrides and file replacement at the same path.
