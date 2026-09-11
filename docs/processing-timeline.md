# Processing timeline

**Processing Timeline** plans which parts of a video to analyze before opening the
result in Motion Studio. It accepts a core `VIDEO`, keeps the source video's clock,
and provides separate **Tracking** and **Stabilization** lanes. A region can use a
different set of anchors without requiring a separate copy of the entire video workflow.

Open [processing_timeline.json](../workflows/processing_timeline.json) in ComfyUI.
The example connects:

```text
Load Video → Processing Timeline → Motion Studio · Standalone
                                           └─ editor_session → Linked preview
```

The input video stays file-backed. The new timeline does not replace core video
loading or Motion Studio's curve editor.

## First run

1. Choose a file in core **Load Video**. The distributed example deliberately has
   no source file selected.
2. Keep the timeline node's **operation** on `prepare` and run the workflow once.
   This prepares the timeline without extracting poses for the whole video. Until
   a completed motion project exists, the dependent Motion Studio nodes wait.
3. Click **Open processing timeline**. Use the timeline's zoom and horizontal
   navigation to select the part of the source you want to work on.
4. Edit the initial full-video **Tracking** region or split it into smaller regions.
   To change just one interval, mark its time range inside a region and choose
   **Isolate selected range**. This creates adjacent before/selected/after pieces;
   choose the selected piece's **Main anchor** and analysis settings. Tick any
   **Additional anchors in this section** to generate alternative tracks alongside it.
   Add a **Stabilization** region separately wherever a reference needs to stay
   still. Stabilization is optional.
5. Use **Process marked range**, **Process selected regions**, **Process all**, or
   **Process unfinished**. Each action applies the plan and queues the timeline and its upstream inputs;
   they do not repeatedly run the downstream Motion Studio export nodes.
6. After processing completes, run the workflow normally to pass the latest
   completed motion project into Motion Studio. `prepare` can pass this existing
   result without starting another analysis job. Choose another **operation** in
   the node when you want the normal workflow run to process regions as well.

The plan is stored in the node's `plan_json` widget. Save the ComfyUI workflow after
editing it. The standalone Motion Studio and the embedded preview in this example
share one editing session through the `editor_session` connection.

**Download plan** saves a JSON backup. **Restore plan** checks that the backup
belongs to this source and previews its region counts before you restore it as a
draft. Review the restored plan, then **Apply to node** and save the workflow.
Locked regions must be unlocked before a restore can replace their settings.
Opening a backup alone does not change the plan.

The timeline's **Open Motion Studio** link uses that same saved editing session
when there is one directly connected standalone owner. With no sole owner, the
timeline keeps its own independent saved Motion Studio session. Generated mains
refresh on processing reruns; user-edited or locked assembled mains are preserved.

## Stabilization in three stages

Select a gold Stabilization region to open **1 · Mask**, **2 · Stabilize**, and
**3 · Anchors**. Manual numbered points remain fully supported: choose **Use
manual points →** to skip the optional mask stage. Existing point regions open
on Stabilize.

1. **Mask (optional).** Seek to a clear frame within the region, choose **Use this
   frame**, and paint one reference surface. Erase removes paint; **Undo brush
   stroke** removes the latest stroke. **Propagate mask** uses the installed
   ComfyUI-SAM2Matting package to propagate before and after that frame, throughout
   this gold region. Scrub the original preview to inspect the green overlay.
   Propagation does not run CoTracker or SAM3D.
2. **Stabilize.** Place numbered points manually or generate them from the painted
   mask using **Spacing** and **Maximum points**. With no points yet, Propagate
   mask generates a set automatically. Replacing an existing set requires checking
   **Replace existing points and reference keyframes**; global Undo restores it.
   **Track region** runs CoTracker and renders the stabilized preview without
   SAM3D. A propagated mask filters point trajectories; it does not replace them.
   The default **Mask tracking tolerance** is 6 source pixels to allow small matte
   holes and uncertain edges. Set 0 for strict filtering. Review held frames and
   the agreeing-point count. Additional marked reference frames can prefill from
   compatible tracking results; orange/unconfirmed points must be repositioned
   before tracking. Manual point placement, deletion and online/offline modes stay
   available.
3. **Anchors.** Open an overlapping tracking region to edit its main and additional
   anchors. **Create / isolate this section’s anchor region** creates a tracking region in an
   empty gap, or isolates this range within one existing unlocked region.
   **Extract anchors** processes this gold region’s full time range, reusing its
   completed stabilization and running SAM3D for the anchor tracks. It preserves
   any unrelated marked selection on the timeline.

Each stage shows its readiness. Missing or unconfirmed points and masks needing
propagation are explained beside **Track region** before it can run. **Extract
anchors** becomes available when the current stabilization has been rendered and
an enabled tracking region overlaps it. After configuring anchors, **Back to
stabilization** returns to the originating section.

The preview shows the active editing tool. **Review** permits inspection without
painting or placing points. Opening Timeline tools, selecting another region, or
switching stabilization stages returns the hidden tools to Review. To paint again,
choose Paint explicitly; **Use this frame** also enters Paint.

Each processing action applies the current plan and uses the normal ComfyUI queue
with progress and cancellation. Masks, points and keyframes save with the workflow;
completed masks/renders also survive reloads in the session’s output directory.
**Clear mask · keep points** returns to point-only tracking without deleting points.
Locked regions remain protected. Changing a mask or region bounds requires updated
propagation; changing point density only affects the next point generation, while
changing mask tolerance repeats stabilization using cached point trajectories.

Install ComfyUI-SAM2Matting and its video model separately. Base+ is the default
(`sam2matting/SAM2Matting-SAM2.1Base+.pt`); Tiny and SAM3Matting need their matching
checkpoints. This integration resolves the existing package and ComfyUI model
paths without downloading weights. Frames are decoded into a temporary disk spool
and read lazily, with bounded propagation state. Packed PNG masks remain on disk
and are read one frame at a time; scratch disk usage grows with section length.
The reference mask is not passed to SAM3D as a person mask.

## Workspace size and video shape

**Timeline tools** beside the video contains Selection, Zoom and Scene cuts.
**Region settings** shares that panel; selecting or adding a region opens its
settings. The timeline's **Timeline tools ↗** button returns to the controls.
The filmstrip sits directly below the preview, without control rows between them.
On narrow screens the tools panel follows the timeline instead.

Open **Layout** for sizing options. **Wide layout** uses the full browser width by
default; turn it off for a centered workspace.
**Full screen** expands the workspace, including its tool tabs when present. Press
Escape or click **Exit full screen** to return.

The default layout bounds the settings column and gives the remaining width to
the preview. Its height adapts to the window, leaving room for the filmstrip and
both region lanes. **Fit video shape** explicitly sizes the preview column to the
source aspect ratio. **Reset layout** returns to the balanced defaults. Frames
remain proportional inside the available area; the dividers do not crop the source.
The marked range and selected-region count remain visible above the timeline;
processing controls and progress stay at the bottom of the desktop workspace.

Drag the visible dividers to resize:

- the width between **Original source** and **Region settings**;
- the height below the preview/settings panels;
- the filmstrip, each tracking/stabilization lane and the overview using their
  bottom dividers.

Double-click a divider to reset that size, or use **Reset layout** for all sizes.
Focused dividers accept arrow keys (Shift for larger vertical steps); Home resets
them. On narrow screens the preview, timeline and settings stack vertically. Lanes keep
enough space for overlapping regions even when their requested height is smaller.

The thumbnail strip shows complete source frames, including portrait footage,
and its density adapts to frame shape and strip height. Click a thumbnail to seek
to that sampled source frame. Thumbnail requests stay bounded to the visible range.

Layout choices are stored locally in this browser, independently of plans, locks,
processing caches and edits. They survive reopening the workspace and do not need
**Apply to node**.

## Multiple anchors in one section

Select a Tracking region, choose its **Main anchor**, then tick the desired
**Additional anchors in this section**. For example, one section can produce mouth,
left-hand and right-hand tracks together. Pose extraction runs once for that section;
all selected anchors use those same poses. Automatic direction and adaptive range
are calculated for each anchor.

The main anchor supplies that section of the assembled main curve on all enabled
axes. Additional anchors appear as separate Motion Studio source tracks named
`Section · anchor`. Select one there to adjust its calibration or copy a time range
into the main. Additional anchors do not automatically replace the main.

For individual landmarks, open **Detailed anchors…** beside **Main anchor**.
Search the grouped list (for example, `left index` or `shoulder`), then choose
**Use as main** or tick **Extra track**. This exposes the full supported landmark
catalog while leaving the everyday dropdown short. Only the active detailed main
anchor is added to that dropdown. Detailed extra tracks appear as removable chips
below the general extra-anchor choices; changing a general checkbox retains them.
These choices save with the section, respect its lock and use the same extracted
poses as the general anchors. Left/right refer to the person's anatomical sides.

Adding or changing anatomical anchors with **Use cache** enabled reuses the already processed
pose coverage. Split and duplicate retain the section's anchor choices. Locked
sections retain every completed anchor track until you unlock them.

## Painted mask as a 3D anchor

**Preview anchor on this frame**, below **Main anchor**, inspects the current
source frame without processing the tracking region. It pauses playback and
switches to **Original**, showing the main anchor in gold and additional anchors
in blue. A painted anchor also highlights the selected mesh vertices. Use
**Show anchor** to hide or show the overlay; it appears only on the frame and
settings it was calculated for. Previewing is available on locked regions and
does not replace their completed motion.

The preview runs through ComfyUI's queue and has progress and **Cancel preview**
controls. Painted references on a different frame may require that reference
frame plus the current frame. With **Use cache** enabled, repainting or changing
anchors on the same frame can reuse its CPU prediction. Only the most recent
frame is retained; full-region tracking and mask propagation are not run.

In a **Tracking** region, choose **Main anchor → Painted mask · 3D**. Set the
correct **Subject** / ROI, pause on a clear frame inside the region, and use the
**Original** preview. Click **Mark reference frame**, then paint the visible body
patch. Paint/Erase, brush radius, **Undo stroke**, and **Clear paint** edit that
reference. **Go to reference** returns to its exact source frame.

**Use stabilization mask** copies the first matching stabilization region's painted
reference when its seed frame falls inside this tracking region. It copies the
painting and rebases its frame number; editing the anchor does not alter the
stabilization mask or its tracking points. Painting an anchor does not require
SAM2 or CoTracker weights.

Process the region with **Process selected regions** or **Process all**. Use
**Process marked range** when you only want the marked interval.
SAM3D first reconstructs the reference frame. The painted area selects the visible
surface of that person's mesh; the same vertex IDs are then averaged in 3D on
every processed frame and across every chunk. Mask propagation is not required:
the surface identities stay fixed instead of following a changing mask centroid.
A painting that misses the mesh produces an actionable error, with no fallback to
a different anatomical anchor.

Motion Studio receives this patch's position as the main anchor on all enabled
axes, with the usual additional anatomical source tracks. Linear axes use the
patch's position; rotational axes continue to use the torso orientation. This is
an estimated body surface: painting cannot add geometry absent from the SAM3D
mesh, and occluded positions remain model estimates. Check the projected anchor
and curves before using the result.

Only one extra 3D point and its projection are stored per frame; full meshes are
not retained in the pose cache. Paint and the exact reference frame survive saves,
workflow reloads and restarts. Changing the paint rebinds the patch and invalidates
that region's pose results. Locks preserve completed output. Splitting keeps the
paint only on the side containing its reference frame, rebasing it on the right;
the other side needs a new reference. Moving or resizing retains the painting if
its original source frame remains inside the region, rebasing its local frame
number. Excluding that frame removes the painting; the editor reports this and
Undo restores it. Duplicating into other footage requires a new painting.

After installing this feature, restart ComfyUI and reopen the timeline so the
Python backend and editor assets are updated together.

## Connected tools in one browser tab

The **Open processing timeline**, **Open reference editor** and **Open Motion
Studio in new tab** node buttons open a shared **Motion workspace** for connected
tools. A Timeline connected to Motion Studio shows two tabs; adding a Reference
Stabilize node in that chain adds a Reference editor tab. Intermediate pose and
anchor nodes are supported. The embedded Motion Studio preview still works.

Editors remain loaded when switching tabs, so selections, unfinished edits and
progress remain available. Apply, Track and processing buttons still act on their
own connected node. Run the workflow once to prepare an unavailable tool; its tab
becomes available after the run. Clicking another connected node's Open button
focuses its tab in the existing browser window.

Grouping does not merge editing sessions. Linked Motion Studio views still share
`editor_session`, and independent chains keep separate workspaces. Sharing only a
Load Video node does not combine two separate analysis branches. Downloaded offline
Motion Studio exports remain self-contained editors.

## Tracking and stabilization are independent

Tracking regions choose the analysis interval, person/ROI slot, anchor, smoothing
and calibration settings. This first version uses SAM3D Body for pose extraction;
it does not offer interchangeable pose-estimation models under one generic
tracking menu. L0 starts with automatic direction and adaptive calibration. The
advanced settings accept the same motion configuration used by the anchor node.

**Subject** lists the configured person regions. Expand **Edit person rectangles** to
redraw the selected person's rectangle or add another directly on the paused
Original preview. The rectangles are normalized to source dimensions; their
numbers identify the SAM3D person slots. **Show regions** controls their overlay.
Output-axis checkboxes and **Invert L0** cover common output settings. Raw ROI and
axis JSON remain in **Advanced person coordinates** and **Advanced axis settings**
for less common configurations.

Enabled regions on the same lane must not overlap. Select a region, seek to the
change, and use **Split selected · S** above the timeline (or **Split at playhead**
in region settings). At a scene-cut diamond, **Split here** can split tracking,
stabilization, or both lanes at the same frame. Both pieces remain; the right side
is selected for editing. Locked regions block the split, and Undo restores both
lanes together. You can also create regions inside unassigned gaps. Tracking and
stabilization regions may overlap each other because their lanes have different
purposes. Stabilization boundaries divide processing even when one tracking region
crosses them.

Stabilization regions choose where the source should be corrected before pose
analysis. They use the existing CoTracker3 reference-stabilization backend. A
reference selection needs a crop and at least three points on the same visible
surface. Keep that crop large enough to cover the reference's movement. Draw the
crop in the timeline's source preview, seek to a clear frame and click **Mark
reference frame**. Place the numbered points, seek to another clear frame, mark it,
and place the **same physical points in the same order**. The **Place** selector
repositions a point; **Reference frames** jumps between keys. **Remove frame**
removes one frame; right-clicking a point removes its identity from all frames.

**Tracker** is selected per stabilization region: Online uses bounded windows;
Offline uses the whole region and the companion offline weights. Both support
references in the middle of a section and tracking in both directions. Independent
estimates correct endpoint drift and reject disagreements. A hidden point is never
silently accepted as a reliable reference. See [reference-stabilization.md](reference-stabilization.md)
for memory behavior and installation.

Keys and mode are saved in the plan, workflow, and recoverable local draft. Locked
regions protect them. Splitting and isolating a range keep reference keyframes and
the painted mask on the side containing their source frames, rebasing right-side
frame numbers. Manual correction sections are clipped to each piece. A side with
no reference frame needs new points or a new painted mask. Each piece can then
use its own crop, reference, and tracker mode without changing the other piece.
Re-propagate retained masks and track the new intervals before extracting anchors;
the old full-region result is not a newly processed split result. Directly moving
region bounds follows the same rule: references inside the new bounds remain on
their original source frames, and only excluded references are removed. The editor
reports what was retained or removed. Undo restores the original bounds and references.

Use **Track region** in the stabilization inspector to track the entire selected
gold region and render its preview, without running SAM3D. It saves and applies
the point settings automatically, shows progress and **Cancel** beside the button,
and opens the stabilized preview when finished. No overlapping tracking region is
required; the marked In/Out selection does not shorten this operation.

Existing motion curves and pose results remain intact. Locked regions cannot be
retracked from the editor. Completed reference results are cached for subsequent
**Process all / marked range / selected regions / unfinished** runs, which extract poses using stabilization
where the lanes overlap. Changed references invalidate affected pose caches on the
next Process run. Failed or cancelled tracking retains previously completed clips.

Crop coordinates and reset actions are under **Crop coordinates & reset**; point
placement instructions are under **Point placement & tracking help**. Preview
statistics are marked **Previous result** when reference settings have changed.

The reference stabilizer uses translation with fixed black padding. It does not
recover an invisible reference or correct rotation, perspective or depth. It holds
the last accepted translation across unreliable frames. The timeline's first
version provides crop and point selection; its own manual correction-keyframe
editor is not included. The separate reference-stabilization workflow provides
that correction editor. See [reference-stabilization.md](reference-stabilization.md)
for its workflow and optional backend installation.

An optional **mask_video** must match the original source timeline and canvas.
The current timeline accepts it for unstabilized analysis only. Combining this
input with stabilization is rejected until an aligned mask-transformation path is
available; an original mask must not be applied to a translated video.
One mask identifies one person, exposed as person slot 0.

## Hard-cut guides

Motion Studio also shows the connected timeline's detected cuts: gold diamonds
and faint vertical guides align across main and every source curve. Click a
diamond at the top of a curve to seek and open its floating actions. Use
**Use as In / Out**, **Shot before / after**, or Shift-click another cut to select
between boundaries. Double-click selects the following shot. The popup follows
the clicked main or source curve; source selections stop at that track's coverage.
**Copy selection · all axes** uses the existing copy operation and preserves locked
main axes. **Fit selection** zooms to the marked range. Previous/next buttons or
arrow keys navigate cuts; I/O mark boundaries and Escape closes the popup. The
same controls work in downloaded offline viewers. Toggle **Scene cuts** beside the
zoom controls to hide the guides. New scans appear without rerunning pose extraction. The source video
and editing session must match; downloaded projects retain their cut markers.

Motion Studio's toolbar has **Wide layout** (on by default) to use the full tab
width; turn it off for the centered layout. The browser remembers this choice,
and offline project downloads retain it. **Full screen** fills the display;
inside the combined workspace it keeps the tool tabs available. Escape exits
full screen.

Use the **▾** button on a Motion Studio track to collapse its curve while keeping
the row controls available; **▸** expands it. This works on locked tracks too,
and saved projects retain the collapsed state. Each source row's **Select range**
button selects its exact analysed interval. Selections made on a source stop at
that source's boundaries; main selections span the video. There is one shared
selection: blue fill identifies the selected row, and dashed guides align that
same interval on the other rows. **Copy selection · all axes** copies the row's
available matching axes into unlocked main axes.

Open **Timeline tools**, expand **Scene cuts**, and click **Detect cuts** to scan the input video. This is a
separate, cached CPU scan; it does not run SAM3D or stabilization. It follows every
source frame regardless of the pose **sample_fps** setting, uses small images and
bounded decoder buffers, and puts each marker on the first frame of the new shot
using the original presentation timestamp. Upstream trims retain their source
clock. The scan uses the video actually wired into the Timeline node.

Cuts appear as faint dashed lines across both lanes, small ruler ticks, and marks
in the clip overview. **Previous cut** and **Next cut** move the playhead to a
boundary. **Select shot** selects the interval between the surrounding cuts; use
**Isolate selected range** on the active tracking region to make it its own
scheduled section. **Snap to cuts** aligns nearby pointer selections and region
edges with markers. **Show cuts** hides or displays the guides.

Click a **diamond cut marker** on the ruler to select its boundary and open its
actions. The selected edge is highlighted across both lanes. Marker selection
works even when **Snap to cuts** is off.

- **Use as In / Use as Out**, or **I / O**, put a selection boundary exactly at
  that cut. A cut is before the incoming shot's first frame: using it as Out
  excludes that frame, so adjacent zones meet without leaking a frame across cuts.
- **Shift-click a second cut** to select the interval between the two markers,
  in either direction.
- **Shot before / Shot after** select the adjacent shot, using the clip's first
  and last boundaries where necessary. Double-click a marker to select its
  following shot.
- Choose **Tracking** or **Stabilization**, then **Make region**. Inside an
  existing region, this isolates the chosen interval and preserves its settings.
  Inside an empty gap, it creates a new region. Locked regions cannot be split;
  a selection crossing several existing regions is rejected without modifying
  them. An exact match selects the existing region. New stabilization regions
  still need their reference crop and points.

The floating actions sit above the ruler and appear only while a cut is selected.
Escape, clicking elsewhere, frame stepping, or playing dismisses the boundary
mode. Ordinary **Mark Out** then returns to including the displayed frame. The
selection hint and button tooltip state which behavior is active. At overview
zoom, crowded marker targets are grouped to keep them clickable; zoom in or use
the cut actions' previous/next arrows to reach every detected boundary.

Detection only annotates the timeline. It does not automatically split regions,
change anchors, invalidate completed motion, or overwrite locks. Markers persist
with the timeline's source and survive restarts. Repeated scans reuse their cache;
a different source or trim gets its own markers. Cancelled scans retain the prior
completed markers. **Use cache = false** rescans the video.

**Sensitivity** defaults to Normal. High finds smaller changes and can add extra
markers; Low requires stronger changes. Detection uses
[PySceneDetect's adaptive content detector](https://www.scenedetect.com/docs/latest/api/detectors.html#adaptivedetector)
with a short rolling window and suppression of isolated single-frame flashes.
These are suggested hard-cut boundaries: similar-looking shots may be missed,
strong motion or longer flashes can still produce false markers, and one-frame
inserts can be suppressed. Fades and dissolves are outside this feature's scope.
Review a marker before using it as an analysis boundary.

PySceneDetect is included in `requirements.txt`; no model weights are required.
The node's `detect_cuts` operation performs the same scan from ComfyUI. It emits
annotations only, so downstream motion nodes wait until a normal prepare or
processing run supplies a project.

## Navigate and select

The **Timeline tools** panel groups **Scale / Zoom**, **Playhead**, and **Selection** separately.
Mark buttons sit next to their In/Out values; selection actions follow them.
The **Scene cuts** section expands when needed, keeping detection settings out of
the main editing row. Its header shows the latest scan status even when collapsed.
Entering In beyond Out moves Out up to meet it; entering Out before In moves In
down to meet it. The boundary you entered stays where you put it.

- The default **Frames** scale shows original source frame numbers, starting at
  **0**. **Go to** accepts a frame number; Enter seeks and focuses the ruler so
  keyboard navigation can continue immediately. **Time** is an optional seconds
  display. Both modes snap new selections and region boundaries to source frames.
- **Left/Right** step exactly one source frame; **Shift+Left/Right** step ten.
  **Home/End** go to the first/last frame of the available clip. These shortcuts
  do not take over typing in text fields or resizing a focused layout divider.
  During decoding, the preview holds its last complete frame. Rapid steps are
  combined into the latest requested destination rather than overlapping seeks.
- Use **I / Mark In**, step or play to the other end, then **O / Mark Out** to
  select an interval without dragging. Mark Out **includes the displayed frame**
  unless a cut marker is selected, when it uses that exact cut boundary instead.
  In/Out fields use an exclusive Out boundary: frames 3, 4 and 5 are **In 3,
  Out 6**. This also allows the very last frame to be selected. **Select frame**
  selects only the displayed frame.
- Click or drag the ruler to scrub; **Shift-drag** a lane to select an interval.
  **Frame detail** zooms around the playhead for individual frame ticks. At wider
  zoom levels labels are spaced out to remain readable.
- Use the zoom slider or **Ctrl/Cmd-wheel** to zoom; use the horizontal scrollbar,
  overview or **Shift-wheel** to move along the video.
- **Fit selection**, **Show playhead** and **Follow** help navigate long clips.
- Turn on **Edit region positions** before dragging or resizing regions. With it
  off, navigation does not accidentally move a region boundary. Moving a region
  preserves its frame count, including on variable-frame-rate video.
- The region inspector exposes its name, **In/Out** boundaries, enabled state and lock.
  Duplicate a region into the selection, split it at the playhead, or delete it.

Region positions and marked ranges serve different purposes. Selecting a region
does not clear an existing marked range. Use the separate processing buttons to
choose which scope to run; neither changes the source video. **Create / isolate**
uses a marked range consistently: an empty gap creates a region, a range inside
one region isolates it, and an exact match selects that region.

Frame navigation uses decoded presentation timestamps, not average FPS or the pose
sampling rate. On first open, the backend streams the source through bounded CPU
decoder buffers to build a timestamp index. It retains only numbers, never a full
video tensor; the first scan can take time on a long video. The completed index is
cached and shared across sessions and trims of that file. Trims retain original
source frame numbers. Variable-frame-rate frames retain their actual spacing on
the timeline. Plans and exported actions still store original-video milliseconds;
changing display scale does not rewrite existing regions or locked results.
If loading stalls, the recovery panel offers Retry after 15 seconds, including
during frame indexing. An indexing request times out after two minutes instead of
leaving the workspace disabled indefinitely.

## Process only the work you need

**Process marked range** runs enabled tracking coverage between In and Out.
**Process selected regions** runs the selected regions independently of those
marks. Selecting a stabilization region processes its overlapping tracking
coverage; **Track region** remains the CoTracker-only action. Both scope buttons
preserve the saved marks and region selection. The processing bar shows which
scope each button will use; advanced chunk, join, gap and report controls are
under **Options & report**.

After an update, restart ComfyUI, refresh its main browser tab, then reopen the
timeline. Scope requests check backend support and use a distinct bridge action
so an outdated main tab cannot silently fall back to the old selection behavior.

The node's operations remain available for normal workflow runs:

| Operation | Use |
| --- | --- |
| `detect_cuts` | Scan the source for hard-cut guides without pose extraction or motion output. |
| `prepare` | Open or refresh the planning interface and pass an existing completed project downstream. |
| `all` | Process the eligible tracking regions in the plan. |
| `selected` | In a normal node run, use the marked range if nonempty, otherwise selected regions. Editor buttons submit their explicit scope for that run only. |
| `unfinished` | Resume eligible work without repeating valid completed chunks. |

Completed chunk results are saved persistently after each successful chunk, so a
long video can be processed over several runs. **Cancel** stops the current job;
completed chunks remain available for the next run. The default chunk duration is
30 seconds and can be changed in the editor. Calibration is calculated over the
available region coverage rather than independently resetting at every chunk.

A changed region requires processing again; unchanged work can be reused.
Completed lane badges and report rows change to **needs processing** when their
anchor, person, ROI, smoothing, axis, painting, or overlapping stabilization
settings change. Existing results remain available for review. Older cached
results without enough configuration metadata are labeled **previous result**
rather than being asserted current.
**Use cache = false** requests fresh processing for eligible unlocked work. Keep
this enabled for normal iteration. Changing an anchor or calibration setting can
reuse the existing pose extraction when its inputs are unchanged.

Lock an approved region to protect its stored settings and completed result.
Processing again, including `all` with **Use cache = false**, must not replace a
locked result. A region locked before its first processing can still obtain its
initial result. Unlock it explicitly before changing it. Motion Studio's curve
locks remain separate: they protect edits in the final motion editor rather than
the analysis plan.

Unprocessed intervals are not evidence of tracked motion. **Gap policy** defaults
to `hold`: the assembled curve starts at neutral 50 until tracked output exists,
then holds the previous output across gaps. `neutral` uses 50 for uncovered
intervals instead. The project includes notes about missing coverage.

The default **Join** is 200 ms. At each incoming processed region, a smooth blend
reconciles its output with the preceding curve, limited to that region's available
coverage. The assembly updates all six axes together. Review these joins in Motion
Studio, where the curves remain editable.

## One source clock

Region boundaries and generated actions use the original source-file timeline.
Processing a later section does not move its actions back to zero. If the input
`VIDEO` represents an upstream trim, the plan retains its position on the source
clock. This keeps separate region runs aligned when the final project is assembled.

The assembled Motion Studio project uses the original source for its unified
video preview. Projected pose coordinates from stabilized regions are mapped back
onto that original image; the inferred 3D motion remains measured from the
stabilized analysis.

In the **Processing timeline**, choose **Stabilized** beside the video heading to
review rendered stabilization at the current source frame. Playback automatically
switches between rendered sections and the original video in uncovered intervals.
The heading identifies which view is actually displayed. Frame stepping, selection
marks and seeking always use original source frame numbers, including trimmed clips.

Select a gold region and use **Preview stabilized** to jump into its saved render,
or **Open clip** to play that file separately. These controls discover existing
completed renders; no processing rerun is needed. Changed crop, points, timing or
tracking thresholds label the saved clip **previous render** until you process it
again. Deleted/disabled regions do not take over timeline playback. Reference point
editing returns to the original marked reference frame so coordinates stay correct; crop editing also uses original coordinates.
The stabilization inspector also reports **tracked / held frames**. During a held
frame the preview shows an amber **HELD · previous correction** label and its reason
(missing points, disagreement or a tracking jump). Held means the stabilizer reused
its last accepted translation; it does not mean the reference stayed still.
**Show tracked points** overlays the visible tracker estimates on the render or
original preview. These points can drift to another surface even when visible;
inspect them against the image. **Previous gap / Next gap** jump to held intervals
on the original source clock. Loaded regions also show their held percentage in
the gold lane. These diagnostics review saved results without rerunning extraction.

Rendered stabilization clips have black padding and no audio; the original video
retains its own audio when playback returns to it.

Motion Studio places the device preview between the video and 3D body view.
**Float video** keeps the same video and projected pose overlay above the tracks
while you scroll. Drag its heading to move it, drag the lower-right handle to
resize it, and use **Dock video** to return it to the top. Focus the heading or
resize handle and use arrow keys for keyboard adjustment (Shift makes larger steps).
The floating preview stays within its editor tab.

Beside Motion Studio's selection controls, **Play selection** plays from In to Out
once. Enable **Loop selection** to repeat that range; the video, pose and device
preview follow the same playhead. Empty selections disable looping. The loop option
is saved with the project and works in the offline viewer; preview playback does
not change exported motion.

**sample_fps = 0** follows source frames. A lower nonzero rate samples fewer frames;
it does not change playback speed. **batch_size** changes how pose extraction is
batched, not the region's timestamps. Video decoding and tracking use bounded
buffers; retained coordinates, cached results and review metadata still grow with
the amount of processed footage.

Analysis includes context around chunk boundaries and keeps output inside the
requested coverage. Context does not cross stabilization boundaries. Mark scene
cuts with separate tracking regions so they remain explicit in the plan.

## Reducing curve points

Motion Studio's **Reduce points…** panel works on the active main axis or source
track. Choose **Selected range** or **Whole curve**, then **Preview reduction**.
The gold overlay shows the remaining points, with before/after counts and the
maximum position change. **Apply reduction** commits that axis; **Cancel preview**
leaves it unchanged and **Undo** restores the original points after applying.
Locked curves cannot be reduced. Changing the curve, range or settings requires
a fresh preview.

**Exact · no curve change** removes only points that lie exactly on the line
between their neighbours. It preserves linear playback, including between
timestamps, but may remove few points on a curved passage. **Small tolerance**
allows a specified position error (initially **0.5 out of 100**, not milliseconds).
It retains reversals, hold endpoints, cut steps and section boundaries. Points
outside a selected range remain untouched. Reduction never shifts timestamps or
smooths the source signal.

Exact cleanup also runs automatically on newly generated scripts and after
smoothing, source joins and pattern insertion. Existing projects can use the
panel without rerunning tracking. The controls and reduced curves are included
in offline project exports.

## Loading after an update or restart

Editor assets revalidate on load so a new page does not mix updated code with
older helper modules. If startup fails, an error and **Retry loading** appear
above the editor. Retry reloads the page and retains the saved plan and the
browser's unapplied draft; there is no need to clear browser storage. A delayed
startup also exposes Retry while it waits for code or the local server.

**Indexing source frames** is a separate step and may take time on a long clip's
first open. Subsequent opens reuse its timestamp index. If a backend update is
required, the error identifies it; restarting ComfyUI interrupts any active job.

## Current scope

The first version focuses on manual regional planning, SAM3D anchor analysis,
optional CoTracker stabilization, persistent results and protected approved work.
Hard-cut guides assist manual planning; automatic identity recovery through cuts
and device motion accuracy are not implied by a completed processing status. Review the
assembled curves and joins in Motion Studio before exporting.

Regenerate both distributed workflow formats with:

```bash
python scripts/create_processing_timeline_workflow.py
```

The node pack remains GPL-3.0-only. Optional model code and weights retain their
own licenses; CoTracker3 uses CC-BY-NC-4.0.
