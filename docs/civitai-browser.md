# Civitai browser and review

Open **Folder Processing Timeline**, set the library folder and enable **include_subfolders**, then run **prepare** once. Open its workspace and choose the **Civitai browser** tab. Use the top-level library folder if you want all of its profiles and categories included.

## Existing downloads

The initial **Already downloaded** view works without contacting Civitai. It recognizes filenames containing `_civitai_<video ID>_`, including the userscript's `original`, `fullsize`, legacy `playback` and browser duplicate suffixes. Existing folders become category choices. Matching base or multi-axis funscripts mark clips as scripted. Multiple local copies of the same ID are grouped, with a local-copy selector.

Existing files are reused when the same Civitai ID is selected again. Selecting a different destination category does not move an existing local copy. Open it for review to import its scripts and refine it using the ordinary timeline. Approving an existing clip saves beside its current video, with the usual backup and revision checks when replacing scripts.

## Discover and select

Choose **Browse Civitai**, a site, ratings, sort and period, then **Browse videos**. **Ratings** defaults to **All ratings**; select PG, PG-13, R, X or XXX to narrow the feed. The choice is remembered for this folder. Changing it clears the loaded pages; click **Browse videos** to start again. Results retain the API's order across **Load more** pages. Creator is an exact username; Video ID can open an exact item. Local filters show new, downloaded, scripted/processed, ignored, or **Temporary · awaiting review** clips. Filters apply to loaded remote pages, so load more if a page contains no matching items.

The browser uses Civitai's video metadata API with its normal access controls. Browse requests send an explicit rating filter with your saved API key; without that filter the API defaults to PG even when authenticated. Exact-ID download lookups include all non-blocked ratings so they can find an already selected clip. Civitai still decides which results your account and region can access. Available sorts are Most Reactions, Most Comments, Most Collected, Newest and Oldest. API results can differ from a signed-in website feed. The integration does not copy website login cookies or bypass access checks. If the selected site rejects access or redirects its API, choose another offered site address or configure your Civitai API key.

The **Civitai API key** panel is open by default. Generate a key in [Civitai account settings](https://civitai.com/user/account), paste it into **API key**, then click **Save key**. The input clears after saving and the status changes to **Key configured**. Click **Browse videos** again, or retry the selected download. Saving a key does not start a download or confirm access to every video.

Keys are kept in the ComfyUI output directory, outside workflow JSON, with owner-only file permissions. `CIVITAI_API_TOKEN` is also supported. Removing a saved key leaves an environment key in effect if one exists. Keys are sent to the selected metadata API only, not to media downloads.

## Review one clip at a time

Click **Review clip** on a card, or select several cards and choose **Review selected one by one**. The page shows one clip with its processing Timeline and Motion Studio together.

- **Auto-process new clips** starts automatic processing when opening an unfinished clip, if another batch is not already running. Completed drafts and existing scripts remain available for review. Use the embedded Timeline controls for manual reprocessing, masks, stabilization, anchor changes and other adjustments.
- **Approve into** chooses the category for a temporary clip. **Approve & next** first saves open editors, then saves the current Main scripts and puts the approved video and scripts into that category. It advances to the next selected clip.
- **Reject · delete temporary clip & next** removes only a temporary video registered as downloaded by this browser, together with any matching staging scripts. For pre-existing or already approved local videos, the action is **Ignore local clip & next**: it keeps the video and scripts.
- **Keep for later** saves current edits and retains the temporary clip. Use **Review temporary clips** to resume unfinished decisions, or the **Already downloaded → Temporary · awaiting review** filter to browse them. Nothing expires automatically.

Ratings, notes, script versions, locks, and clip identity are retained when a temporary clip is approved into a category. Existing files in that destination are never overwritten by the move. An interrupted category save can be recovered on reopening the Civitai library. Moving a clip can cause source-dependent caches to be rebuilt on a later reprocess; the saved curves and plan remain available.

## Processing queue

Select cards, check the clip names in the selection strip, and click **Add selected to queue**. This saves the selection without starting work. **Start queue** submits a ComfyUI job that downloads missing videos and generates draft funscripts one clip at a time. Existing local copies are reused; existing scripts and completed drafts are kept.

The queue shows **Waiting**, **Downloading**, **Generating funscript**, **Ready for review**, and failures. Add more clips while it runs, use **Do next** to prioritize a waiting clip, or **Remove** to take an inactive clip out of the queue without deleting its files. **Pause after current clip** keeps completed work and the remaining list. **Retry** puts a failed, deferred, or interrupted clip back into the waiting list. A clip open in another editor is deferred to protect its edits.

After the ComfyUI job is accepted, the queue runs on the server even if the workspace closes. ComfyUI must stay running. The list and drafts survive restarts; interrupted work requires Retry/Resume. Download errors do not prevent later clips from running.

Choose **Review ready clips**, or **Review** on one queue row, to inspect and refine drafts. Approval remains separate: processing does not automatically approve clips or sort them into categories. **Clear finished** removes completed queue rows and keeps their files and scripts.

**Download only** still downloads the selected clips without inference; keep the workspace open for this separate download-only action. **Review clip** can also download and auto-process a single clip directly.

## Storage

Temporary videos live under `.s3f-civitai-review/<ID>/` inside the selected library, so the same Folder node can process them. Category hints, ownership records, review decisions, plans, editor drafts and versions are stored under `sam3d_funscript` in ComfyUI's output directory. Keep that output data to preserve drafts and recognition of owned temporary files. Without an ownership record, rejection keeps a local file rather than deleting it.

Approval transfers the video and scripts into the selected category, updates the retained editor/plan source location, and removes the staging copies after the transfer commits. Rejected IDs remain ignored in the browser. Approved and rejected review records may be retained even when the temporary video has been removed.

The downloader requests original or full-size video delivery and validates the returned container. It does not silently substitute the small gallery preview. A download is limited to 4 GB and 15 minutes. No videos are downloaded merely by opening the local library; remote thumbnails and previews contact Civitai when browsing its feed.

API behavior follows Civitai's [images endpoint](https://github.com/civitai/civitai/blob/main/src/pages/api/v1/images/index.ts) and [sort definitions](https://github.com/civitai/civitai/blob/main/src/server/common/enums.ts). Restart ComfyUI and refresh the main browser tab after installing the new routes and assets.
