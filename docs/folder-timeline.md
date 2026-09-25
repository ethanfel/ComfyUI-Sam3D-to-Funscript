# Folder Processing Timeline

Add **Folder Processing Timeline** (`S3F_FolderTimeline`) or load [the example workflow](../workflows/02_folder_library.json). Enter a folder path, leave **operation** on **prepare**, and queue once. **Open folder workspace** opens one clip at a time, with **Timeline** and **Motion Studio** tabs. Only the active editor and its video preview are visible; switching tabs pauses playback and keeps your edits, selection and scroll position. Opening a clip never starts playback. No output connections are needed.

**Folder tools** groups **Audio sync**, **Tags**, **Processing**, and **Presets** in one compact bar. Open one tool at a time; click it again to collapse it. Wide windows show controls and help side by side, and smaller windows stack them. Filters, review order, preload status and clip navigation stay together above the current clip.

When switching clips, the editor area keeps its height and shows a loading indicator over the paused previous view. The incoming editor replaces it after its project and first video frame are ready. Your selected editor tab and scroll position are retained. The previous view is read-only during this transition; it cannot receive edits or approvals intended for the next clip. If loading stalls, **Reload editor** retries just that panel.

**Preload next clip** is on by default. Once the current editors are ready, it prepares one saved clip ahead, including its Timeline, Motion Studio and paused video preview. It follows the filtered review order, including random order, and releases the unused preload when that selection changes. It does not open a review lease, process a video, or save the next draft; queued and processing clips are excluded. Next, Skip and Approve & next reuse the prepared editors after saving the current clip and checking for newer saved changes. Untick the option to save memory and background bandwidth. First-time clips without a saved workspace still load normally.

“Next clip preloaded” means its preview is ready; the current clip still has to finish saving before navigation. Folder requests time out and release their action lock if the server stops responding. After a timeout, refresh the folder to check whether a save or approval completed before retrying it. A clip whose processing is still running remains protected. If an older main ComfyUI page has a stuck action, reload that main page while leaving the Folder workspace open so it can reconnect with its edits.

Use **Previous / Next** or the video selector to browse. The arrows follow the current subfolder, script-status, quality and search filters. A selected clip stays open when filters change, so filtering does not discard edits. Subfolders are included by default; scanning does not decode every video. Each clip has its own plan and editor session. Returning restores its saved regions, locks and curves. A changed video file gets a new session. Navigation and review saves check the current clip without rescanning the whole library; Refresh still discovers new or moved files. If saving a rating removes the current clip from a filter such as Unrated, Next and Approve & next continue from its previous position.

Choose **Review order → Random · mix folders** to review a varied selection. It shuffles clips within each folder and takes turns between folders, so a large folder does not dominate the start of the pass. Use **Whole folder** or tick several subfolders to mix their clips, and **Show → Drafts ready for review** to focus on completed drafts. Previous/Next, the video selector, **Approve & next**, and **Skip & next** all follow the same order, without repeating a clip before wrapping around. The current clip stays open when the order changes.

Refreshing the listing or approving a clip keeps the remaining order; newly eligible clips join at the end. **Reshuffle** starts a new order from the open clip. Changing review filters creates a new mix for that selection. The browser remembers the mode and order for each library, including across reloads when the filters match. This setting controls review, not the bulk processing queue.

Replacing an approved export also removes axes you disabled in Main. All replaced or removed axis files are backed up, and a failed export restores the originals. Unrelated scripts are kept.

## Bulk processing

Open **Subfolders** and tick one or more folders, then expand **Bulk automatic processing** and click **Process selected folders**. **Whole folder** includes everything; **Clear** removes the selection. Selected folders include their nested folders, and overlapping selections process each clip only once. Show, Quality and Find filter the review list, not the batch. Processing keeps each clip’s own folder preset and uses the node's model, sampling, batch size and cut sensitivity. Automatic mode finds scenes, prepares all detected people and four anchors, and uses any stabilization masks already prepared separately for each video. A single shared mask input must be disconnected for bulk processing.

The batch runs sequentially through ComfyUI's queue. It skips matching base or multi-axis funscripts, skipped videos, and drafts already completed by a previous bulk pass. Eligibility is checked again before each clip, including scripts that appear while a batch is running. Failed clips are listed and do not stop later clips. **Check models** verifies the selected SAM3D model, person detector and any required stabilization tracker before inference; starting bulk performs this check too. The remaining-time estimate starts after the first clip and uses observed processing times, so clips of different lengths can change it considerably.

**Pause after clip** finishes the current video before stopping. **Resume remaining clips** retains completed drafts. **Retry failed clips** processes only previous failures in the selected folders. **Stop now** cancels that specific queued job; completed drafts remain available. After a ComfyUI restart, an interrupted batch is shown as interrupted; check ComfyUI's queue before resuming it.

Bulk processing saves **drafts in ComfyUI's output directory**. It does not approve results or write funscripts beside videos. Select **Show → Drafts ready for review**, then use the arrows to review them. Each clip can still be reprocessed manually with Timeline's usual controls.

To share completed Main scripts through Hugging Face, use the [public dataset exporter](public-dataset.md). It supports Civitai ID lookup and runs independently while the batch continues.

## Refine and approve

All existing Timeline features remain available: scene detection or imported EDL cuts, automatic mode, person crops, tracking anchors, masks and stabilization. Motion Studio retains Main/source editing, joins, audio patterns and export controls.

Existing funscripts are display filters, not permanent exclusions from editing. Opening a scripted clip for the first time imports its matching axes into Main. Later visits restore the saved draft rather than importing over your edits. Reprocessing supplies new source detections while the imported Main curves stay available; copy the improved source sections into Main to build the final result. Files changed outside the workspace are checked again at approval.

**Approve & save next to video** saves the current Main scripts as `video.funscript`, `video.surge.funscript`, `video.sway.funscript`, `video.twist.funscript`, `video.roll.funscript` and `video.pitch.funscript`, for the axes present in the project. These are ordinary Main scripts, as in the project ZIP; a separate device-output profile is not substituted.

Temporary Civitai downloads can also be approved from **Local clips**. Choose or type a folder in **Save into category**; a new category is created when you approve. **Approve & save in category** moves the video and approved Main scripts there. **Approve & next** does the same and opens the next clip in the current review order. The category starts with that clip's download destination, when provided. Until approval, its script stays a draft.

When scripts already exist, the button reads **Approve & replace scripts**. It checks that those files still match the versions seen when the clip was opened and stores originals in `.s3f-backups/<timestamp-id>/` beside the video before replacing them. A handled write failure restores the originals and removes only new files created by that attempt. Reopen the clip if outside changes prevent approval.

Approval and switching first save the open editors. Approval checks the Motion Studio revision and video identity. During bulk processing, only the clip being processed is read-only: other completed clips can be edited and approved. Opening a waiting clip for review defers it from this pass, avoiding a collision with your edits. Completed results appear in the open viewer as each clip finishes. An ordinary queued single-clip job still blocks switching until it finishes.

**Approve & next** and **Skip & next** advance through the filtered list. Shortcuts work in the folder page and its embedded editors: **Alt + Left/Right** browses, **Alt + Enter** approves and advances, **Alt + Backspace** skips and advances, and **Alt + 1–5** sets the rating. They do not intercept typing in a form field. **Play when selecting an issue** is off by default. Enable it to play a flagged range when you explicitly select that issue.

## Review flags and script versions

Review checks identify missing tracking samples, uncertain person detections, clipped motion, abrupt jumps and long flat ranges. Click a flag or **Next issue** to open that range in the Motion Studio tab. Playback starts only if **Play when selecting an issue** is enabled. Orange marks also identify the ranges on Main. These are inspection hints: a still scene can correctly produce a flat curve, and flags never change your star rating.

**Script versions · compare and restore** saves named Main-curve snapshots with independent ratings and notes. Imported existing scripts, completed automatic drafts and approvals receive snapshots automatically. **Compare with Main** overlays a saved version in pink against the green current Main using the same time scale and video. **Show current Main** removes the overlay. Comparing never changes exported motion.

**Restore selected version** saves a recovery snapshot first, then replaces unlocked Main curves and their axis settings. Source detections and tracking plans stay available. Restoring does not write scripts beside the video: approve the restored result to export it. Locked Main axes must be explicitly unlocked before restoration.

## Subfolder presets

Select exactly one subfolder, open **Folder tools → Presets**, adjust its preferred anchor, smoothing, adaptive/fixed movement range, sample FPS, batch size and cut sensitivity, then save. Nested folders inherit the nearest saved parent preset. Without a saved preset, the node settings are used. Models always come from the node.

Presets apply to automatic processing, including a manual rerun of Automatic. All detected people and all four anchors remain available; the preferred anchor changes which candidate is suggested first. Manual and locked regions are retained. Presets cannot be changed during a batch, keeping its settings consistent.

## Ratings and skipped videos

To label a category at once, choose one or more **Subfolders**, open **Folder tools → Audio sync**, and click **Mark all as Audio sync**. The panel shows the number of clips and existing Audio sync labels before you apply it. It includes nested folders and all drafts, approved scripts and skipped clips within that scope; Show, Quality and Find only filter the review list. Overlapping folder choices update each clip once. **Clear Audio sync** removes the label from that same scope. Ratings, notes, intensity, approval status and curves are preserved. This updates the clips currently listed; it is not a preset for future downloads. Labels are included on the next dataset export. Bulk labels save directly through the Folder API, so an older main-tab handler cannot reject the action; a ComfyUI main-tab reload is not required for this update.

Set **Quality** from 1–5 stars, optionally add a **Note**, and click **Save review**. Check **Audio sync** to label a script synchronized to audio. This label is separate from stars and approval, survives reopening and reprocessing, and is included as `audio_sync` in public dataset variants and catalog rows. Set **Intensity** beside Note from **1 · Very gentle** to **5 · Very strong**, or leave it **Unrated**. The small meter displays your rating. It describes how intense the motion feels, separately from quality and Audio sync, and is included as `intensity` in dataset exports (0 means unrated). It stays attached when skipping, restoring, approving or reopening a clip. Pending review changes are also saved before switching clips or approving. Filters offer unrated, 1–2 stars, and individual higher ratings. Ratings are attached to the clip's script/draft and retained on approval or reprocessing; revise them after improving a result.

**Auto intensity** presets Intensity from Main’s L0 stroke curve and refreshes within about a second after curve edits finish saving. New unrated clips start in Auto; existing nonzero ratings stay Manual. Choose a value (including Unrated) to switch to Manual, or tick Auto again to resume estimation. Review saves, navigation and approval persist the setting.

The estimator uses sustained travel speed, stroke range and repetition across the whole clip, including pauses. It discounts tiny jitter, isolated spikes and connections across known scene cuts. It estimates relative intensity, not physical device speed or a quality score. Other axes are not included. The hint shows typical range and cycles per second; manual values keep the current suggestion available for comparison. Approval and automatic dataset exports recompute from the saved Main curve.

**Skip for now** saves your edits, pauses local review and bulk processing for that clip, and opens the next non-skipped clip in the current filtered review order. It keeps the draft, rating, note and existing scripts. **Skip & next** and its keyboard shortcut do the same. If no eligible clips remain, a message prompts you to change filters or restore the current video. A failed save prevents skipping and advancing. Choose **Show → Skipped for now** or **All videos**, then **Restore video** when ready to work on it. This is a local review choice: it does not withdraw the script from HF. Saved generated Main scripts remain eligible for publication, and uploads keep the last published result until a replacement is ready.

Drafts, review decisions, batch progress and versions live under ComfyUI's output directory in `sam3d_funscript/processing`, `editor_sessions`, `folders` and `folder_versions`. Keep these directories to retain ratings, skipped status, versions and editable drafts. Matching scripts remain detectable without those records. Source videos are unchanged. The ComfyUI server needs access to the selected folder and write permission beside videos when you approve.

After installation, restart ComfyUI and refresh its main browser tab to load the new node and routes. Existing single-video workflows remain available.

### Tags and reprocessing

**Automatic tags** can tag the current clip or all non-skipped clips in the selected
folders (including nested folders, once per clip). Review filters do not change
this scope. Choose Civitai, local image tagging, or both. Civitai reads video tags
with the existing saved API key. Existing downloads are matched by their Civitai
ID in the filename; clips without one can still use local tagging.

**Missing or changed only** is the default. Existing automatic results (including empty results) are reused when the source and settings still match. Local tagging is repeated when the frame count, threshold or model revision changes; Civitai results are cached independently. Failed sources are retried without rerunning successful ones. **Retag all** explicitly refreshes every requested source in the selected scope, including the current clip when using its tag button. Manual tags and exclusions survive either mode. The workspace restores the last tagging settings so reopening does not switch a three-frame run back to one frame. Progress distinguishes the current selection, the last run and clips already up to date. Existing completed tags from before this update are reused. Restart ComfyUI and reload the workspace after installing this update.

Local tagging uses [WD SwinV2 v3](https://huggingface.co/SmilingWolf/wd-swinv2-tagger-v3)
on CPU. Install optional `requirements-tagging.txt` in ComfyUI’s Python environment
if needed. Starting local tagging downloads the model and labels, when absent,
to `ComfyUI/models/taggers/wd-swinv2-tagger-v3/`. No images are uploaded. One first
frame is fast; three frames sample the start, middle and near the end. These are
image tags, so neither option guarantees an action or every subject in a video.
The model is trained on illustrations and suggestions may need correction on
other material. It retains its vocabulary (for example `1girl`, `1boy`); authors
can edit or add their own `woman`/`man` labels.

Edit comma-separated **Tags** beside the clip and use **Save review**. Automatic
sources are shown below. Removed suggestions stay excluded across automatic
refreshes, while added tags persist. Tagging has progress, per-clip errors and
Stop after clip, and survives closing the workspace. A server restart interrupts
the job; completed tags stay saved. Tags do not approve scripts or alter curves.

**Reprocess selected folders** explicitly includes completed drafts and clips
with existing scripts, skips skipped clips, and keeps the selected clip list fixed
when review filters change. It uses the regular ComfyUI background batch and its
pause/stop controls. Existing tracking regions, cuts, masks and locks are kept;
unlocked regions rerun without inference cache. Clips without a previous result
use Automatic mode. Main, authored/locked source curves and files beside the video
are kept, with a **Before bulk reprocess** recovery version. Review the latest
Source detections and copy the desired result into Main before approving again.
