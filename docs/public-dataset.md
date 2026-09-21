# Public funscript dataset

The standalone exporter collects completed **saved Main** scripts from registered Folder workspaces. Run it alongside ComfyUI: it reads saved JSON and video file information, without decoding videos, loading models, modifying the library or restarting the server. Build a new snapshot later to collect clips that finish in the meantime.

## Build locally

Use the Python environment containing this node's dependencies:

```bash
python scripts/funscript_dataset.py build \
  --store /path/to/ComfyUI/output/sam3d_funscript \
  --output /path/to/new-dataset-snapshot
```

All registered Folder workspaces are included by default. To restrict the export, add `--folder FOLDER_ID`; repeat it for several workspaces. The ID is the `folder` query parameter in the folder workspace URL. Optional filters: `--approved-only` and `--min-quality 3`.

The exporter keeps all available Main axes and **labels every variant `draft` by default**, including clips previously saved through “Approve & save”. Saving files and assigning a quality rating do not establish manual validation. The manifest records `review_policy: "all-drafts"` and review counts; each catalog row and video index carries its draft label.

Only if local folder approvals genuinely represent your own validation, add `--use-folder-approval` to label matching approved exports `approved`. Editing their saved Main afterward returns those results to draft. `--approved-only` filters by local approval; it does not enable approved labels by itself. Initial blank projects and merely imported existing scripts are excluded; imported scripts explicitly approved in this workspace can be included. Historical source tracks and unsaved browser edits are excluded.

Clips being processed, ignored clips, failed or outdated results, and clips without a Civitai ID are skipped. Civitai IDs come from managed download records or existing `*_civitai_ID_*.mp4` filenames. The summary lists skip counts. A private `SNAPSHOT.local-report.json` beside the dataset directory lists skipped filenames; it is **outside** the public export and is not uploaded.

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

Only manifest-listed files are uploaded. The command checks their hashes first, refuses private or unrelated populated repositories, and commits against the repository revision it inspected. For an update, build another snapshot and publish to the same repository. Files managed by the previous snapshot that are absent from the new one are removed in that commit; unrelated files are left alone. Consequently, use the same folder scope for successive full-library snapshots. A filtered snapshot replaces the published catalog with that filtered selection.

Uploads use Hugging Face's [official folder upload API](https://huggingface.co/docs/huggingface_hub/guides/upload). There is no background uploader or automatic publication from the processing queue.

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
| `data/catalog.jsonl` | One row per video/script variant, with ID, categories, rating, review status, duration and axis paths |
| `index/ab/HASH.json` | All variants for a single Civitai ID, its preferred variant and combined categories |
| `scripts/ab/HASH/VARIANT.funscript` | L0 actions; other axes have `.surge`, `.sway`, `.twist`, `.roll` or `.pitch` suffixes |

Variants are content-addressed using sanitized script hashes and source duration. Identical copies are deduplicated. Different results for the same Civitai ID stay separate, and axes from different results are never mixed. The preferred variant ranks approved results first, then quality, then variant hash for deterministic ties. Quality is the author's 0–5 rating, with 0 meaning unrated.

Both category forms are included in every catalog row and variant:

```json
{"categories":["dance"],"category_paths":["September_2026/dance"]}
```

`categories` contains final folder names; `category_paths` preserves the hierarchy relative to the registered library. The video's index also contains their union across variants. Duplicate copies in different folders contribute all labels without duplicating scripts or changing script hashes. Labels reflect the publisher's folders, not Civitai tags or approval status. Files directly in the library root have empty lists. Temporary downloads use their selected destination category; internal review directories are excluded. Older snapshots without category fields can be read as empty lists.

An app can:

1. Browse Civitai, compute the selected video's key, and request its dataset index.
2. Choose an approved result or explicitly allow a draft.
3. Download the requested axis and verify its SHA-256.
4. Obtain the matching video through Civitai and check its duration before playback.

Pin the index and scripts to the same Hugging Face commit; see the executable Python lookup example in the generated dataset README. Action times are milliseconds from the local video's start. The ID identifies a Civitai post, not an exact video file: edited, trimmed or speed-adjusted copies may not synchronize. The per-axis start/end times describe action coverage, not review coverage.

Exports contain scripts, category names, relative category paths and the documented lookup fields. They exclude videos, audio, original filenames, absolute local paths, private notes, full project metadata and credentials.
