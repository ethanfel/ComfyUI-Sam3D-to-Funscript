# Reference stabilization

**Reference Stabilizer · CoTracker3** accepts a core `VIDEO` and outputs a stabilized,
file-backed `VIDEO`. Connect it before **SAM3D Video → Cached Poses** when a visible
reference region is more useful than an inferred partial-body pose.

Open [the example workflow](../workflows/reference_stabilization.json). Its Motion
Studio standalone node and embedded preview share the same editing session.

## Optional masks in the Processing Timeline

The [Processing Timeline](processing-timeline.md#stabilization-in-three-stages)
adds a mask → stabilize → anchors workflow to each stabilization region.
ComfyUI-SAM2Matting propagates a painted mask in both directions from its seed
frame. Dense points can be generated inside that mask; CoTracker still follows
numbered point identities. The propagated mask filters trajectories with an
adjustable pixel tolerance, rather than deriving translation from a mask center.

The original point-only workflow remains available in both editors. The separate
Reference editor retains its existing point/keyframe controls; the new mask tools
are in the Timeline. Neither propagation nor a denser point set guarantees that
independently deforming surfaces will agree on one translation.

## Select the reference

1. Choose the source with core **Load Video**, optionally through core **Trim Video**.
2. Queue once, then click **Open reference editor** on the stabilizer. Until points
   are selected, this node prepares the editor and blocks dependent extraction.
3. Choose **Draw tracking crop**. Draw a crop covering the reference throughout its
   motion. This crop is fixed during tracking; a point leaving it cannot be followed.
4. Seek to a clear frame, click **Mark reference frame**, and place at least three
   numbered points on the same reference surface. The first reference can be in
   the middle of the clip. **Zoom to crop** makes small regions easier to select.
   Add other reference frames before or after it; mark the **same physical points
   in the same numbered order** on every frame. The point selector lets you
   reposition an existing point. Right-click removes that identity from all keys.
   **Remove keyframe** removes only the marked frame; Undo restores it.
5. Click **Track**. It applies your settings and queues the reference stabilizer and
   its upstream inputs in ComfyUI. Progress and execution errors appear in the editor;
   the preview refreshes when tracking and rendering finish. Reference keyframes, tracking mode, crop and corrections are stored in the node's
   `reference_json` widget and saved with the workflow.
6. Once the reference looks right, run the workflow in ComfyUI to extract poses and
   update Motion Studio. **Track** runs only up to the stabilizer, so reviewing the
   reference does not repeatedly run downstream SAM3D extraction.

Opening the editor from the node connects it to that node. Queueing from the same
ComfyUI tab also flushes pending reference edits before serializing the graph. A
separately opened page can download its settings for import into `reference_json`.
Changing the source file or upstream trim clears the active selection for the new
source; old coordinates are never silently reused.

## Correct a gap

The timeline distinguishes **tracked**, **manual**, and **held** frames. Held frames
use the previous accepted translation because too few points were visible, points
disagreed, or the displacement failed the jump check. The yellow cross marks the
reference center used for stabilization. Agreement is not proof of point identity.

1. Use **Next gap**, frame stepping, or the timeline to locate the interval.
2. Add a **New section** for that interval. At its start, add a **Keyframe from current
   estimate** if the automatic reference is still correct.
3. In **Place correction keyframe** mode, seek a frame and click the intended reference
   center on the source. Add further keys as needed. A key at the current frame
   replaces that section's previous key at that time.
4. At the end of the interval, add the current estimate again for a continuous join.
   The preview updates immediately. Positions interpolate linearly between keys
   within that section only. Separate gaps should use separate sections.
5. Click **Track**. The node reuses cached point tracking and renders the corrected
   video. Run the workflow in ComfyUI when ready to analyze it downstream.

A section with one key changes one sampled frame. Overlapping sections are rejected
so their ordering cannot silently overwrite an edit. Key deletion, section removal,
and undo are available. Use **Download settings** to retain an additional copy.

Finish reference corrections before locking Motion Studio tracks. Each rendered
revision is a distinct video source; an existing locked Motion Studio session keeps
its source and may require a new editor session for the revised video.

The timeline supports full-clip, 10-second, 30-second and two-minute views, horizontal
scrolling, direct time seeking, and gap navigation. Its drawing reduces long curves
to pixel-sized extrema buckets while retaining the full underlying coordinates.

## Timing and memory

Motion Studio shows an **Original / Stabilized** selector above its source video
for reference-stabilized projects. Switching preserves the playhead and playback,
including the original video's trim offset. The projected skeleton, anchor and
trail are mapped back onto the original image when viewing it; the motion curves
and exported scripts still come from the stabilized analysis. In an offline export,
select each view and use **Choose source video** to load its matching local file.
Both files remain available while the page is open.

- **Online** is the default. A single reference on frame zero keeps the original
  streaming path. References later in the section run forward and backward in
  overlapping 16-frame windows. For reverse reads, resized RGB frames are spooled
  to a temporary file on the output disk and deleted afterwards. GPU windows and
  decoded CPU buffers stay bounded; scratch disk and point history grow with length.
- **Offline** uses the `scaled_offline.pth` companion weights and supplies the whole
  selected section at model resolution. Memory grows with frames and queries;
  an estimated memory preflight and a clear OOM error ask for a shorter section
  or Online mode. It never silently lowers the frame rate. Inference can only be
  cancelled between model calls, not inside an active offline GPU call.
- Between adjacent reference keys, endpoint observations correct gradual drift.
  The two seeded estimates are blended only where they agree. Conflicting points
  are rejected and flagged; insufficient consensus still holds the last transform.
  Marked frames count as manual observations. Hidden predictions remain excluded.
  Translation assumes the chosen points move together; rotation or deformation
  may still require smaller sections or manual corrections.
- A separate streaming pass renders inverse translation with fixed black padding.
  Scale and orientation remain fixed. The output is H.264 CRF 16, without audio.
- Output clips start at zero. Original inter-frame presentation times are preserved
  exactly and verified in the encoded file. The manifest retains the original source
  timestamps and offset; the editor displays source and output times together.
- GPU tracking is cached by source/trim, crop, numbered reference keyframes, mode
  and the actual checkpoint. Manual correction sections and agreement settings
  do not invalidate it. **Use cache = false** reruns it.
- The second output points to `reference.json`, including all coordinates, flags,
  corrections, source-time mapping and the rendered video location. It resides under
  `output/sam3d_funscript/reference/`.

The crop only improves point-tracker input detail; it does not crop the rendered
source. A downstream person-mask video must match the **stabilized** canvas and
timeline. An original, unstabilized mask is not aligned with this output.

This is 2D reference locking. It does not infer depth, correct perspective or recover
an invisible reference. Inspect and correct held intervals before using their motion.
The node reports remaining held frames; downstream SAM3D still analyzes their images.

## Optional backend installation

Run with the Python environment that launches ComfyUI:

```bash
python scripts/install_reference_tracker.py --comfy-root /path/to/ComfyUI
```

The installer verifies pinned official source/checkpoint downloads and installs the
optional CoTracker package without upgrading runtime dependencies. Weights are placed
in `ComfyUI/models/cotracker/cotracker3_scaled_online.pth`. Restart ComfyUI and reload
its browser page after installing the node or backend.

CoTracker3's source and checkpoint use CC-BY-NC-4.0. They are optional external
dependencies and retain that license; this node pack remains GPL-3.0-only. See the
[comparison probe](stabilization-probe.md) for pinned sources and the initial results.

## Offline checkpoint

Install the companion weights once, using the ComfyUI Python:

```bash
python scripts/install_reference_tracker.py --comfy-root /path/to/ComfyUI --mode offline --weights-only
```

For a custom model location, add `--model-dir /your/models/cotracker` (the directory
containing your online weights). Both modes resolve through ComfyUI's registered
`cotracker` paths, including `extra_model_paths.yaml`. The installer verifies the
pinned SHA-256 and leaves existing runtime dependencies unchanged.

Restart ComfyUI after updating this feature, then refresh open editor tabs. Older
backends are detected before applying keyframe settings; unapplied drafts remain
available instead of being saved without their new fields. Existing frame-zero
point selections and manual correction sections remain supported.
