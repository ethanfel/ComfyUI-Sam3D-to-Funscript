# H3 funscript workflow audit — 2026-09-25

Scope: the current `S3F_H3ProjectTimeline` node, project catalogue, person detection, Folder workspace integration, batch execution, approval and the current FunCiv manga reader. This is a follow-up audit after main-take/FLF support was added. The findings below describe the audited baseline. The four reproduced bugs and the recommended H3 workspace improvements have since been implemented; see [the updated workflow guide](h3-project.md) for current behavior.

The checks use disposable neutral project fixtures. The real project, videos, current processing jobs and external repositories were not changed. Drawing-pose accuracy and device behavior are not measured by these tests.

## Reproduced bugs, in priority order

### P1 — Preview confidence and Automatic disagree

`h3_project.probe` passes the saved project threshold to the person detector. `automatic.person_envelopes` then imposes an independent fixed mean confidence of 0.45. A stable box at 0.25 appears in the preview with the H3 default threshold of 0.15, but is rejected by Automatic even when present in all eight sampled frames. Automatic reports “No reliable person box.”

Owner: [person_envelopes](../sam3d_funscript/automatic.py), especially the track-filtering step, and [H3 probe](../sam3d_funscript/h3_project.py).

Recommended change: distinguish detector acceptance from temporal consistency, pass the chosen H3 confidence policy through both stages, and retain coverage/association checks. Show a low-confidence review flag when retaining borderline drawings. Preserve the ordinary-video default unless deliberately changed. Test stable low-confidence boxes, sporadic false positives and crowded scenes.

### P1 — A partial or corrupt script can prevent needed processing

`FolderStore._entry` reports `existing` when any axis sidecar exists. `batch_entries` then excludes it from ordinary processing. Reproductions:

- Only `video_clean.surge.funscript` exists; L0 is missing. The clip is excluded from bulk.
- `video_clean.funscript` contains invalid JSON. Opening reports an import warning, but the clip remains excluded from bulk.

Owner: [FolderStore status and eligibility](../sam3d_funscript/folder_store.py).

Recommended change: distinguish files present from usable Main motion. Introduce missing-primary/invalid-script states, expose the reason, and offer draft generation or repair without overwriting the existing sidecars. Preserve replacement approval and backups. Optional secondary axes may remain absent.

### P1 — Removing one waiting take stops the whole batch

The batch resolves each queued entry before entering its per-clip exception handler. If H3 deletes a waiting take or retires its layout, that lookup raises `PlanConflict` and stops the entire batch. In the reproduction, four takes were scheduled; removing the second after the first finished left the third and fourth unprocessed.

Owner: [FolderStore.process_batch](../sam3d_funscript/folder_store.py).

Recommended change: resolve and validate each take inside the per-item handler. Report a deleted/changed take as skipped or needing attention, and continue with independent clips. Stop on explicit cancellation or an unavailable project drive. Also make queue policy explicit when H3 changes its main selection: preserve a labeled snapshot or re-evaluate pending main takes.

### P2 — One damaged page hides every good page

Completed take metadata is isolated behind warnings, but page `current.json`, layout files and joined-sequence metadata are parsed without equivalent isolation. A malformed `current.json` for one page aborts the entire catalogue refresh, including the other intact page in the fixture.

Owner: [H3 catalogue](../sam3d_funscript/h3_project.py).

Recommended change: retain the page in the navigator with an actionable error; exclude its uncertain items from processing while keeping intact pages available. Never silently substitute a retired layout. A malformed project root should still prevent opening because its authoritative reading order is unknown.

## Improvements for using H3 every day

| Priority | Improvement | Proposed behavior |
| --- | --- | --- |
| High | Page/panel overview | A page rail with panel thumbnails; badges for no video, main take, unprocessed, draft, approved, excluded and needs attention. Show progress per page and across the book. |
| High | Select work before loading media | Multi-select pages/panels, page ranges and “missing Main scripts only”; show the exact queued takes, counts and reasons for exclusions before processing. Edit that list while reviewing another clip. |
| High | Useful drawing preflight | Test the selected take's actual reference/frame and a short motion range. Offer “Use this person box,” anchor selection and a 1–2 second pose/curve preview before full processing. The current person-box preview does not test pose stability. |
| High | Persistent panel decisions | Add “No trackable action on this panel” across all present and future takes. Keep it separate from excluding one candidate take or the entire page. |
| Medium | Loop and join checks | Compare positions and velocities across the loop seam on all enabled axes. Add warnings and a playback preview. Any seam adjustment should be optional and previewed. Current loop metadata is only displayed as a label. |
| Medium | Lightweight, cancellable checks | The three-frame probe currently decodes forward through roughly 90% of the video and creates a new detector for each call. Consider exact timestamp seeks or a bounded sample decoder, serialized detector reuse, visible progress and server-side cancellation. A browser timeout alone does not stop the worker. |
| Medium | Project/page/panel presets | Keep a project default with explicit overrides for confidence, anchor, smoothing and sampling. Allow a successful setup to be reused on related panels while keeping current-take source identity intact. |
| Medium | Portable editable work | Provide an optional project-local draft/review manifest keyed by panel and take identity. Currently only exclusions/confidence and approved sidecars travel with the project; editable sessions and ratings remain in ComfyUI's output store, whose session identities include absolute paths. |
| Low | Remove irrelevant controls and stale guidance | H3 inherits Civitai/HF tools even though its clips have no Civitai IDs. Keep useful local tags, hide unsupported publishing/source choices, and update the bundled workflow's “latest take / Show older takes” instructions to main-take behavior. |

A practical layout is a narrow page/panel navigator beside the shared video/editor area, with Processing and Review tabs and an independently editable queue drawer. Display the selected H3 main take and its script state together. This builds on the existing Timeline and Motion Studio instead of duplicating their editors.

## FunCiv status changed since the first audit

The current `FunCiv-player/packages/manga-core/sequence.mjs` now applies H3 joins, handles consumed cross-page endpoints, filters eligible takes and handles stale saved take overrides. Its sequence tests pass. The six-axis approval → actual importer → motion compiler test also passes against this updated checkout.

The first audit's “FunCiv ignores FLF” finding is therefore resolved in the current player checkout. It is not a reason to change the node's output naming. Approved same-stem sidecars remain the interchange contract; ComfyUI-only drafts are not visible to the reader.

## Suggested implementation order

1. Fix the confidence mismatch and script-readiness classification.
2. Make batch execution and project refresh tolerate independent damaged/deleted items.
3. Add the page/panel overview, selection queue and persistent panel exclusions.
4. Add quick drawing trials, seam review and portable draft support.

Regression coverage: `tests/test_h3_project.py`, `tests/test_automatic.py`, `tests/test_folder_store.py` and `tests/test_folder_browser.mjs`. Cross-project compatibility: `tests/test_h3_funciv.mjs`.
