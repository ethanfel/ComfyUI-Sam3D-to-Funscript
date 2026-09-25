# API prompts

These JSON files are prompt dictionaries for ComfyUI's `/prompt` endpoint. To open a workflow on the canvas, use the [starters](../../workflows/README.md) instead.

| Prompt | Set before submitting |
|---|---|
| [Single video](01_single_video.api.json) | Node `1`: `file`, relative to ComfyUI's input directory. |
| [Folder library](02_folder_library.api.json) | Node `1`: `folder_path`, accessible to the ComfyUI backend. |
| [H3 Animator project](03_h3_project.api.json) | Node `1`: `folder_path`, pointing to an H3 project with `project.json` and `index.json`. |

Both use `operation: "prepare"` and `plan_json: "{}"`. Select installed model names as needed. Advanced recipes have their own [API companions](../advanced/api/).
