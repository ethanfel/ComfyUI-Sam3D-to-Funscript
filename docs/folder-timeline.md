# Folder Processing Timeline

Add **Folder Processing Timeline** (`S3F_FolderTimeline`) or load [the example workflow](../workflows/folder_timeline.json). Enter a folder path, leave **operation** on **prepare**, and queue once. **Open folder workspace** opens one clip at a time, with the existing processing Timeline and resulting Motion Studio together on the same page. No output connections are needed.

Use **Previous / Next** or the video selector to browse. The arrows follow the current subfolder, script-status, quality and search filters. A selected clip stays open when filters change, so filtering does not discard edits. Subfolders are included by default; scanning does not decode every video. Each clip has its own plan and editor session. Returning restores its saved regions, locks and curves. A changed video file gets a new session.

## Bulk processing

Select a **Subfolder**, expand **Bulk automatic processing**, and click **Process unscripted clips in subfolder**. This includes its nested folders and uses the node's model, sampling, batch size and cut sensitivity. Automatic mode finds scenes, prepares all detected people and four anchors, and uses any stabilization masks already prepared separately for each video. A single shared mask input must be disconnected for bulk processing.

The batch runs sequentially through ComfyUI's queue. It skips matching base or multi-axis funscripts, ignored videos, and drafts already completed by a previous bulk pass. Eligibility is checked again before each clip, including scripts that appear while a batch is running. Failed clips are listed and do not stop later clips. **Check models** verifies the selected SAM3D model, person detector and any required stabilization tracker before inference; starting bulk performs this check too. The remaining-time estimate starts after the first clip and uses observed processing times, so clips of different lengths can change it considerably.

**Pause after clip** finishes the current video before stopping. **Resume remaining clips** retains completed drafts. **Retry failed clips** processes only previous failures in the selected subfolder. **Stop now** cancels that specific queued job; completed drafts remain available. After a ComfyUI restart, an interrupted batch is shown as interrupted; check ComfyUI's queue before resuming it.

Bulk processing saves **drafts in ComfyUI's output directory**. It does not approve results or write funscripts beside videos. Select **Show → Drafts ready for review**, then use the arrows to review them. Each clip can still be reprocessed manually with Timeline's usual controls.

## Refine and approve

All existing Timeline features remain available: scene detection or imported EDL cuts, automatic mode, person crops, tracking anchors, masks and stabilization. Motion Studio retains Main/source editing, joins, audio patterns and export controls.

Existing funscripts are display filters, not permanent exclusions from editing. Opening a scripted clip for the first time imports its matching axes into Main. Later visits restore the saved draft rather than importing over your edits. Reprocessing supplies new source detections while the imported Main curves stay available; copy the improved source sections into Main to build the final result. Files changed outside the workspace are checked again at approval.

**Approve & save next to video** saves the current Main scripts as `video.funscript`, `video.surge.funscript`, `video.sway.funscript`, `video.twist.funscript`, `video.roll.funscript` and `video.pitch.funscript`, for the axes present in the project. These are ordinary Main scripts, as in the project ZIP; a separate device-output profile is not substituted.

When scripts already exist, the button reads **Approve & replace scripts**. It checks that those files still match the versions seen when the clip was opened and stores originals in `.s3f-backups/<timestamp-id>/` beside the video before replacing them. A handled write failure restores the originals and removes only new files created by that attempt. Reopen the clip if outside changes prevent approval.

Approval and switching first save the open editors. Approval checks the Motion Studio revision and video identity. During bulk processing, only the clip being processed is read-only: other completed clips can be edited and approved. Opening a waiting clip for review defers it from this pass, avoiding a collision with your edits. Completed results appear in the open viewer as each clip finishes. An ordinary queued single-clip job still blocks switching until it finishes.

**Approve & next** and **Ignore & next** advance through the filtered list. Shortcuts work in the folder page and its embedded editors: **Alt + Left/Right** browses, **Alt + Enter** approves and advances, **Alt + Backspace** ignores and advances, and **Alt + 1–5** sets the rating. They do not intercept typing in a form field. **Play selected section** plays the selected range when opening a clip or clicking a review flag; browser autoplay restrictions may require a first playback click.

## Review flags and script versions

Review checks identify missing tracking samples, uncertain person detections, clipped motion, abrupt jumps and long flat ranges. Click a flag or **Next issue** to select and play that range in Motion Studio. Orange marks also identify the ranges on Main. These are inspection hints: a still scene can correctly produce a flat curve, and flags never change your star rating.

**Script versions · compare and restore** saves named Main-curve snapshots with independent ratings and notes. Imported existing scripts, completed automatic drafts and approvals receive snapshots automatically. **Compare with Main** overlays a saved version in pink against the green current Main using the same time scale and video. **Show current Main** removes the overlay. Comparing never changes exported motion.

**Restore selected version** saves a recovery snapshot first, then replaces unlocked Main curves and their axis settings. Source detections and tracking plans stay available. Restoring does not write scripts beside the video: approve the restored result to export it. Locked Main axes must be explicitly unlocked before restoration.

## Subfolder presets

Select a subfolder, expand **Subfolder preset**, adjust its preferred anchor, smoothing, adaptive/fixed movement range, sample FPS, batch size and cut sensitivity, then save. Nested folders inherit the nearest saved parent preset. Without a saved preset, the node settings are used. Models always come from the node.

Presets apply to automatic processing, including a manual rerun of Automatic. All detected people and all four anchors remain available; the preferred anchor changes which candidate is suggested first. Manual and locked regions are retained. Presets cannot be changed during a batch, keeping its settings consistent.

## Ratings and ignored videos

Set **Quality** from 1–5 stars, optionally add a **Note**, and click **Save rating & note**. Pending rating changes are also saved before switching clips or approving. Filters offer unrated, 1–2 stars, and individual higher ratings. Ratings are attached to the clip's script/draft and retained on approval or reprocessing; revise them after improving a result.

**Ignore video** excludes an unsuitable clip from the default view and bulk processing while keeping its draft, rating and note. Choose **Show → Ignored** or **All videos**, then **Restore video** to try it again. Ignoring exports nothing.

Drafts, review decisions, batch progress and versions live under ComfyUI's output directory in `sam3d_funscript/processing`, `editor_sessions`, `folders` and `folder_versions`. Keep these directories to retain ratings, ignored status, versions and editable drafts. Matching scripts remain detectable without those records. Source videos are unchanged. The ComfyUI server needs access to the selected folder and write permission beside videos when you approve.

After installation, restart ComfyUI and refresh its main browser tab to load the new node and routes. Existing single-video workflows remain available.
