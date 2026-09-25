# Public funscript dataset

The standalone exporter collects video metadata and completed **saved Main** scripts from registered Folder workspaces. Run it alongside ComfyUI: it reads saved JSON and video file information, without decoding videos, loading models, modifying the library or restarting the server. Build a new snapshot later to collect clips that finish in the meantime.

## Upload from the Folder workspace

Open **Folder tools → Hugging Face**, enter `account/dataset`, and click **Upload to Hugging Face**. The server uses its existing Hugging Face login or `HF_TOKEN`; credentials are never stored in the workflow. The repository is remembered for this workspace. A backend restart and workspace reload are needed after installing or updating the exporter. Older running backends cannot upload the new video metadata, so the button stays disabled until restart.

The button saves the current clip's review metadata and Motion Studio edits, then builds and uploads in a background worker. Progress and the last successful dataset link survive closing the workspace. Other clips remain available for review. Only one upload can run per ComfyUI output store. Restarting the server interrupts an active upload; check the dataset before retrying.

The scope is this registered workspace and **all its subfolders**, regardless of the visible Subfolder, Show, Quality and Find filters. Video tags (including their sources), categories and Audio sync are included even without a funscript. Available scripts include intensity, quality and review status. Videos and private notes are excluded. Review status is automatic: approved scripts stay approved, and unreviewed scripts stay drafts. Editing an approved Main curve makes the changed result a draft until it is approved again. Older saved all-drafts settings are ignored. Changes saved after the snapshot starts need another upload. Processing and tagging do not publish automatically.

## Build locally

Use the Python environment containing this node's dependencies:

```bash
python scripts/funscript_dataset.py build \
  --store /path/to/ComfyUI/output/sam3d_funscript \
  --output /path/to/new-dataset-snapshot
```

All registered Folder workspaces are included by default. To restrict the export, add `--folder FOLDER_ID`; repeat it for several workspaces. The ID is the `folder` query parameter in the folder workspace URL. Optional filters: `--approved-only` and `--min-quality 3`.

The exporter keeps all available Main axes and **preserves each script's saved review status**. Scripts matching their approved exports are labeled `approved`; unreviewed scripts are labeled `draft`. Assigning a quality rating does not approve a script. The manifest records `review_policy: "folder-approval"` and review counts for script variants. Each script catalog row and index variant carries the corresponding label; video metadata by itself has no approval status.

Editing an approved saved Main afterward returns the changed result to draft until it is approved again. `--approved-only` filters the export to approved results. The older `--use-folder-approval` flag is still accepted but no longer needed. Initial blank projects and merely imported existing scripts do not contribute script rows; imported scripts explicitly approved in this workspace can be included. Historical source tracks and unsaved browser edits are excluded.

Clips being processed, failed or outdated results do not contribute a fresh script, but their video metadata is still exported. Clips without a Civitai ID are omitted. **Skip for now** (the former Ignore button) only affects local review and bulk processing; it does not exclude an otherwise eligible saved Main script. Civitai IDs come from managed download records or existing `*_civitai_ID_*.mp4` filenames. The summary separates total videos, videos with scripts, and videos with metadata only. Skip counts explain why fresh scripts were omitted; those clips can still have video metadata. A private `SNAPSHOT.local-report.json` beside the dataset directory lists skipped filenames; it is **outside** the public export and is not uploaded.

Each build requires a new output directory. A partial build without a complete manifest cannot be published. Check a completed snapshot with:

```bash
python scripts/funscript_dataset.py check /path/to/new-dataset-snapshot
```

## Publish to Hugging Face

The dataset card and included LICENSE specify **GPL-3.0**. Source videos are not included in that license or in the upload. The Hub's license identifier is documented in its [license list](https://huggingface.co/docs/hub/repositories-licenses).

The `publish` command uses the optional `huggingface_hub` package, your existing Hugging Face login or `HF_TOKEN`. It never writes a token into the export or workflow. If needed, install the package in your environment and use `hf auth login` locally.

Choose an `account/dataset-name`; the command creates a **public dataset** when it does not exist:

```bash
python scripts/funscript_dataset.py publish /path/to/new-dataset-snapshot \
  --repo YOUR_ACCOUNT/YOUR_DATASET
```

Only manifest-listed files are uploaded. The command checks their hashes first, refuses private or unrelated populated repositories, and commits against the repository revision it inspected. For an update, build another snapshot and publish to the same repository. Uploads retain the last published result for video IDs absent from the new snapshot, including clips awaiting reprocessing or missing from a filtered export. Fresh results replace the published variants for their matching video IDs; only those superseded script files are removed. All retained downloads are checksum-verified at the inspected HF revision, and the catalog, indexes and manifest include them. Skipping a clip locally does not unpublish it. Unrelated repository files are left alone. Retained variants keep their curves, hashes and review status. When a local video is present, its latest tags, categories and Audio sync update the retained records even if its new curve cannot be exported. Older all-drafts publications gain approved labels for matching local approvals when those clips are included in a new upload.

Uploads use Hugging Face's [official folder upload API](https://huggingface.co/docs/huggingface_hub/guides/upload). The Folder button runs this same exporter in the background after an explicit click. The processing queue does not publish automatically.

## Third-party lookup contract

Schema: `s3f-public-funscripts/1`.

```text
key = lowercase_hex(SHA256(UTF8("civitai:" + decimal_video_id)))
index path = index/{key[0:2]}/{key}.json
```

Use a positive decimal Civitai ID without leading zeroes. Both Civitai site variants use the same namespace. These hashes encode names; the numeric Civitai ID remains in the catalog for discovery.

| File | Contents |
| --- | --- |
| `manifest.json` | Schema, license, snapshot date, counts and managed-file hashes |
| `data/videos.jsonl` | One row per video, including tags, tag sources, categories, Audio sync, and `has_script`; no script required |
| `data/catalog.jsonl` | One row per video/script variant, with ID, categories, rating, review status, duration and axis paths |
| `index/ab/HASH.json` | All variants for a single Civitai ID, its preferred variant and video metadata; `variants: []` and `preferred_variant: null` when no script exists |
| `scripts/ab/HASH/VARIANT.funscript` | L0 actions; other axes have `.surge`, `.sway`, `.twist`, `.roll` or `.pitch` suffixes |

The video catalog is also the Hub **videos** configuration. Join it to script records by `civitai_id` or `video_key`. Your app must read this catalog to include tags and Audio sync for videos without funscripts; reading only `data/catalog.jsonl` will still show only scripted videos. Metadata-only rows have no script approval status. `manifest.video_catalog` identifies the video catalog; older snapshots without it have only script metadata.

Variants are content-addressed using sanitized script hashes and source duration. Identical copies are deduplicated. Different results for the same Civitai ID stay separate, and axes from different results are never mixed. The preferred variant ranks approved results first, then quality, then variant hash for deterministic ties. Quality is the author's 0–5 rating, with 0 meaning unrated.

Each variant and catalog row also has `audio_sync: true` or `false`, set with **Audio sync** beside Quality in the Folder workspace. The video catalog and index also include this checkbox label, even when there is no script. It is independent of the star rating and draft/approved status. False (or an absent field in older exports) means unmarked, not a failed synchronization test. Identical script copies combine the label: any marked copy makes the shared variant true. Changing this label does not change script hashes. Publish a new export to send updated labels to other apps.

**Intensity** is exported as `intensity` in each variant and catalog row: integer 1–5 (very gentle, gentle, moderate, strong, very strong), with 0 for unrated. Older missing fields also mean unrated. `intensity_mode` identifies `manual` ratings and `auto` estimates. Auto values are recomputed from the exported Main L0 curve, so reruns or later edits do not publish stale estimates. Both modes are independent of quality, Audio sync and review status; an automatic estimate is not human validation. Older exports without a mode contain manual ratings. Duplicate script copies use the highest assigned intensity; unrated copies do not clear a rating. Metadata changes leave script hashes and variant IDs unchanged. Retained older publications gain `intensity: 0` when they had no rating.

Both category forms are included in every catalog row and variant:

```json
{"categories":["dance"],"category_paths":["September_2026/dance"]}
```

`categories` contains final folder names; `category_paths` preserves the hierarchy relative to the registered library. The video catalog and index also combine categories across all local copies of that ID. Duplicate copies in different folders contribute all labels without duplicating scripts or changing script hashes. Labels reflect the publisher's folders, not Civitai tags or approval status. Files directly in the library root have empty lists. Temporary downloads use their selected destination category; internal review directories are excluded. Older snapshots without category fields can be read as empty lists.

An app can:

1. Browse Civitai, compute the selected video's key, and request its dataset index.
2. Check `has_script`. If false, use the available video metadata; there is no script to download. Otherwise, choose an approved result or explicitly allow a draft.
3. Download the requested axis and verify its SHA-256.
4. Obtain the matching video through Civitai and check its duration before playback.

Pin the index and scripts to the same Hugging Face commit; see the executable Python lookup example in the generated dataset README. Action times are milliseconds from the local video's start. The ID identifies an individual Civitai media item, not exact video bytes: edited, trimmed or speed-adjusted copies may not synchronize. The separate `post_id` groups items uploaded in the same gallery. The per-axis start/end times describe action coverage, not review coverage.

Exports contain scripts, category names, relative category paths and the documented lookup fields. They exclude videos, audio, original filenames, absolute local paths, private notes, full project metadata and credentials.

Video rows, indexes and script variants include `creator_username` and `post_id` (null when unknown), plus a `civitai_metadata` object. Available details are `created_at`, `width`, `height`, `base_model`, `model_version_ids`, `content_rating`, `stats`, `site`, `fetched_at`, `video_url`, `post_url` and `creator_url`. Content ratings are the API's string labels or numeric codes encoded as strings; they are not inferred age labels. These are cached observations; counters and availability can change. Existing downloads can be enriched from **Civitai browser → Library metadata → Fill missing metadata** before uploading. No script is required. Fresh metadata updates retained published scripts without changing their variant hashes or review status. Omitted source fields preserve previously published values.

Clip tags are included in **`data/videos.jsonl` regardless of script availability**, each per-video index, and the script records in `data/catalog.jsonl`. Each
variant has `tags: ["dancing", "woman"]` and `tag_sources`, a mapping from
`civitai`, `local`, and/or `manual` to lists of labels. Tags use lowercase,
whitespace-normalized text; underscores become spaces. User-excluded tags are
removed. The video catalog and index combine metadata from all local copies with the same Civitai ID, including copies without usable scripts. Current video metadata updates older retained publications; records absent from the local snapshot keep their previous metadata.

Tags are suggestions and author labels, independent of `review_status`, quality,
Audio sync and intensity. Tagging never validates a draft. No frames, raw prompts,
private notes or model credentials are included. Tag changes appear on the next
explicit dataset export/upload; tagging does not upload by itself.
