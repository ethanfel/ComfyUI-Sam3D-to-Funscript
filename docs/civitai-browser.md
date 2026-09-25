# Civitai browser and review

Open **Folder Processing Timeline**, set the library folder and enable **include_subfolders**, then run **prepare** once. Open its workspace and choose the **Civitai browser** tab. Use the top-level library folder if you want all of its profiles and categories included.

## Existing downloads

The initial **Already downloaded** view works without contacting Civitai. It recognizes filenames containing `_civitai_<video ID>_`, including the userscript's `original`, `fullsize`, legacy `playback` and browser duplicate suffixes. Existing folders become category choices. Matching base or multi-axis funscripts mark clips as scripted. Multiple local copies of the same ID are grouped, with a local-copy selector.

Existing files are reused when the same Civitai ID is selected again. Selecting a different destination category does not move an existing local copy. Open it for review to import its scripts and refine it using the ordinary timeline. Approving an existing clip saves beside its current video, with the usual backup and revision checks when replacing scripts.

## Discover and select

Choose **Browse Civitai**, a site, ratings, sort and period, then **Browse videos**. **Ratings** defaults to **All ratings**; select PG, PG-13, R, X or XXX to narrow the feed. The choice is remembered for this folder. Changing it clears the loaded pages; click **Browse videos** to start again. Results retain the API's order. Creator is an exact username; Video ID can open an exact item. Local filters show new, downloaded, scripted/processed, ignored, or **Temporary · awaiting review** clips.

**Navigation → Infinite scroll** loads the next results as you approach the bottom, keeping existing cards and their playing previews. **Navigation → Pages** shows one page at a time: use **Next page** to skip top results and **Previous page** to return. Visited pages are cached, and selections survive page changes. The mode is remembered for the workspace and works in the feed, post/creator galleries and local downloads. Civitai pages contain up to 24 results before local filtering; local pages contain 48 matching videos. Filtering can leave a remote page empty: page mode keeps its boundary, while infinite scroll continues looking for matching results. On a loading error, automatic requests pause until **Retry loading**. **Browse videos** starts a fresh set of pages for the chosen filters.

The browser uses Civitai's video metadata API with its normal access controls. Browse requests send an explicit rating filter with your saved API key; without that filter the API defaults to PG even when authenticated. Exact-ID download lookups include all non-blocked ratings so they can find an already selected clip. Civitai still decides which results your account and region can access. Available sorts are Most Reactions, Most Comments, Most Collected, Newest and Oldest. API results can differ from a signed-in website feed. The integration does not copy website login cookies or bypass access checks. If the selected site rejects access or redirects its API, choose another offered site address or configure your Civitai API key.

Browsing filters are grouped under **Find clips**. Expand **Find by creator or video ID** for an exact search. **Destination category** sits beside the filters on wide screens and below them in compact windows; expand **+ New category** to add a destination, including nested paths such as `September/Dance`. The **Show** filter and selection actions sit above the results.

Each card offers **Same post** for videos uploaded into the same Civitai gallery, and **More from this creator** for that author's videos. Follow either link from the results or another gallery; **Back** restores the previous results, loaded pages, filters and scroll position. Selections stay available for the queue. Gallery requests use the selected site, rating filter and saved API key, cover all time, and fetch videos only. Older local downloads resolve their post or author from the exact Civitai video ID on demand. Missing or inaccessible metadata produces an error rather than an unrelated gallery. Opening a gallery does not download clips. Post filtering and post IDs use Civitai's [images endpoint](https://github.com/civitai/civitai/blob/main/src/pages/api/v1/images/index.ts) and [response fields](https://github.com/civitai/civitai/blob/main/src/server/services/image-search.service.ts).

**Hide completed** removes green cards: videos with existing scripts or finished generated drafts. It is remembered for this folder and applies to the feed, post galleries and creator galleries. Finished clips remain accessible through queue review. Hidden completed clips are removed from the card selection; choosing **Show → Processed or scripted** reveals them again. Filtering affects the loaded results; infinite scrolling or **Next page** continues through Civitai's results. Restart ComfyUI after installing gallery support, then reload the workspace; navigation mode and hide-completed changes only require a workspace reload.

The **Civitai API key** panel opens when no key is configured or the server reports an access error; otherwise it stays compact. Generate a key in [Civitai account settings](https://civitai.com/user/account), paste it into **API key**, then click **Save key**. The input clears after saving and the status changes to **Key configured**. Click **Browse videos** again, or retry the selected download. Saving a key does not start a download or confirm access to every video.

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

Review opens the exact selected copy and switches completed results to the embedded **Motion Studio** tab. It refreshes saved draft status and an already-loaded editor before review, so a completed queue job does not require reprocessing. The previous video stays hidden while the requested clip opens. If opening fails, use **Retry opening clip**; if the copy moved or changed, refresh the browser and select its current copy. A generated, unapproved result is labelled **Draft ready for review**; approval writes the final `.funscript` files beside the video.

**Download only** still downloads the selected clips without inference; keep the workspace open for this separate download-only action. **Review clip** can also download and auto-process a single clip directly.

## Storage

**Library metadata** at the top of the browser can recover public Civitai details for existing downloads. Choose **Fill missing metadata** to look up uncached video IDs, or **Refresh all metadata** to update already saved records. It covers every recognized ID in this registered library, including skipped clips and clips without scripts; the visible card filters do not restrict it. Duplicate copies share one lookup. The selected Site and saved API key are used.

Recovery runs in the background in batches of 20. **Stop after batch** keeps completed work. Unavailable IDs are reported and can be retried; an API error stops further requests. Restarting ComfyUI interrupts the job; Fill missing metadata resumes with uncached IDs. It does not download videos, rerun tracking or change approval. Opening the browser alone does not start recovery.

Browsing, gallery lookups and new downloads also save creator username, post ID, posting date, dimensions, model references, content rating and public counters when supplied by the API. These are stored centrally in `sam3d_funscript/civitai/video-metadata.json`, shared across registered folders. Missing fields stay unknown; sparse responses retain previously known values. Saved metadata feeds creator/post navigation and the next explicit HF upload, including clips with no script. Raw prompts, workflow data, signed media URLs and credentials are excluded. Restart ComfyUI and reload the workspace after installing this backend feature.

Temporary videos live under `.s3f-civitai-review/<ID>/` inside the selected library, so the same Folder node can process them. Category hints, ownership records, review decisions, plans, editor drafts and versions are stored under `sam3d_funscript` in ComfyUI's output directory. Keep that output data to preserve drafts and recognition of owned temporary files. Without an ownership record, rejection keeps a local file rather than deleting it.

Approval transfers the video and scripts into the selected category, updates the retained editor/plan source location, and removes the staging copies after the transfer commits. Rejected IDs remain ignored in the browser. Approved and rejected review records may be retained even when the temporary video has been removed.

The downloader requests original or full-size video delivery and validates the returned container. It does not silently substitute the small gallery preview. A download is limited to 4 GB and 15 minutes. No videos are downloaded merely by opening the local library; remote thumbnails and previews contact Civitai when browsing its feed.

API behavior follows Civitai's [images endpoint](https://github.com/civitai/civitai/blob/main/src/pages/api/v1/images/index.ts) and [sort definitions](https://github.com/civitai/civitai/blob/main/src/server/common/enums.ts). Restart ComfyUI and refresh the main browser tab after installing the new routes and assets.

The processing queue offers **Edit review list** before opening any clip. It lists waiting, active and unreviewed entries without loading their videos or editors. Use it to select several clips and **Set aside selected**, or **Set aside & next** for the current clip. Set-aside clips are saved separately for this folder, excluded from normal browser results and temporary/ready review, and removed from waiting processing work. A clip already downloading or processing finishes safely. Files, drafts, ratings and categories are kept. The **Set-aside clips** list offers **Open manually** without automatic processing, or **Return selected to review**; restored clips become selected for review or queuing. These local choices do not change HF review labels. The saved list requires a ComfyUI restart after installation.

During a slow clip open, **Back to browser**, navigation and **Edit review list** stay available. Opening another clip waits for the current host request to finish; a late result cannot reveal or auto-process a clip you left. Leaving this loading screen does not cancel a running processing job.
