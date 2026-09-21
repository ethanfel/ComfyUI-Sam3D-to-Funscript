# Advanced node recipes

For everyday authoring, use the two [starter workflows](../../workflows/README.md). These recipes show individual node connections for custom graphs. Choose your own media, cache or reference paths before running.

| Recipe | Purpose |
|---|---|
| [Streaming extraction](video_to_funscript.json) | Decode video in batches, cache poses and convert an anchor to motion. |
| [Cached poses](cached_pose_to_funscript.json) | Edit anchors without running pose inference. |
| [Multiple anchors](multitrack_anchors.json) | Combine several motion projects in one editing session. |
| [Detailed anchor override](detailed_anchor_override.json) | Override a preset anchor with an individual landmark. |
| [Person masks](mask_videos_to_funscripts.json) | Extract separate scripts using a mask video per person. |
| [Native prediction nodes](core_video_to_funscript.json) | Connect ComfyUI's SAM3D Body nodes through the pose adapter. |
| [Reference stabilization](reference_stabilization.json) | Use the standalone reference stabilizer before pose extraction. |
| [Reference script comparison](video_with_reference.json) | Compare generated motion with an authored funscript. |

These recipes include a compact **Motion Studio · Standalone** node linked to an embedded preview. Both share one session. Remove the preview if you only need the dedicated tab.

Matching automation prompts live in [api/](api/); they are not canvas workflows. Regenerate recipes with `python scripts/create_workflows.py --advanced`.

The [partial-person diagnostic](../../tests/fixtures/workflows/README.md) is a test fixture, separate from these examples.
