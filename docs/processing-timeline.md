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
5. Apply the plan, then use a processing button in the timeline to run all, selected
   or unfinished work. These buttons queue the timeline and its upstream inputs;
   they do not repeatedly run the downstream Motion Studio export nodes.
6. After processing completes, run the workflow normally to pass the latest
   completed motion project into Motion Studio. `prepare` can pass this existing
   result without starting another analysis job. Choose another **operation** in
   the node when you want the normal workflow run to process regions as well.

The plan is stored in the node's `plan_json` widget. Save the ComfyUI workflow after
editing it. The standalone Motion Studio and the embedded preview in this example
share one editing session through the `editor_session` connection.

The timeline's **Open Motion Studio** link uses that same saved editing session
when there is one directly connected standalone owner. With no sole owner, the
timeline keeps its own independent saved Motion Studio session. Generated mains
refresh on processing reruns; user-edited or locked assembled mains are preserved.

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

Adding or changing anchors with **Use cache** enabled reuses the already processed
pose coverage. Split and duplicate retain the section's anchor choices. Locked
sections retain every completed anchor track until you unlock them.

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

Enabled regions on the same lane must not overlap. Use **Split at playhead** to
divide the initial region, or create regions inside unassigned gaps. Tracking and
stabilization regions may overlap each other because their lanes have different
purposes. Stabilization boundaries divide processing even when one tracking region
crosses them.

Stabilization regions choose where the source should be corrected before pose
analysis. They use the existing CoTracker3 reference-stabilization backend. A
reference selection needs a crop and at least three points on the same visible
surface. Keep that crop large enough to cover the reference's movement. Draw the
crop and select the starting points in the timeline's source preview. Point
selection uses the stabilization region's first frame; changing its start clears
its points so they cannot silently refer to a different frame.

Stabilization is processed where it overlaps enabled tracking. To process a
stabilization interval in an otherwise empty gap, add a tracking region there.

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

## Navigate and select

- Click the timeline to seek. **Shift-drag** selects a time interval.
- Use the zoom slider or **Ctrl/Cmd-wheel** to zoom; use the horizontal scrollbar,
  overview or **Shift-wheel** to move along the video.
- **Fit selection**, **Show playhead** and **Follow** help navigate long clips.
- Turn on **Edit region positions** before dragging or resizing regions. With it
  off, navigation does not accidentally move a region boundary.
- The region inspector exposes its name, **In/Out** times, enabled state and lock.
  Duplicate a region into the selection, split it at the playhead, or delete it.

Region positions and time selections serve different purposes. Selecting an
interval limits a processing request; it does not trim or shift the original video.

## Process only the work you need

| Operation | Use |
| --- | --- |
| `prepare` | Open or refresh the planning interface and pass an existing completed project downstream. |
| `all` | Process the eligible tracking regions in the plan. |
| `selected` | Process the selected scope, clipping retained output to its time selection. |
| `unfinished` | Resume eligible work without repeating valid completed chunks. |

Completed chunk results are saved persistently after each successful chunk, so a
long video can be processed over several runs. **Cancel** stops the current job;
completed chunks remain available for the next run. The default chunk duration is
30 seconds and can be changed in the editor. Calibration is calculated over the
available region coverage rather than independently resetting at every chunk.

A changed region requires processing again; unchanged work can be reused.
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
stabilized analysis. Switching among multiple rendered region videos is not part
of this first timeline preview.

**sample_fps = 0** follows source frames. A lower nonzero rate samples fewer frames;
it does not change playback speed. **batch_size** changes how pose extraction is
batched, not the region's timestamps. Video decoding and tracking use bounded
buffers; retained coordinates, cached results and review metadata still grow with
the amount of processed footage.

Analysis includes context around chunk boundaries and keeps output inside the
requested coverage. Context does not cross stabilization boundaries. Mark scene
cuts with separate tracking regions so they remain explicit in the plan.

## Current scope

The first version focuses on manual regional planning, SAM3D anchor analysis,
optional CoTracker stabilization, persistent results and protected approved work.
Automatic scene detection, automatic identity recovery through cuts, and device
motion accuracy are not implied by a completed processing status. Review the
assembled curves and joins in Motion Studio before exporting.

Regenerate both distributed workflow formats with:

```bash
python scripts/create_processing_timeline_workflow.py
```

The node pack remains GPL-3.0-only. Optional model code and weights retain their
own licenses; CoTracker3 uses CC-BY-NC-4.0.
