![SAM3D to Funscript — ComfyUI Motion Studio](assets/branding/banner.svg)

**Turn video into editable motion tracks inside ComfyUI.** Choose an anchor, combine sections, preview the motion and export your funscripts.

[Quick start](#quick-start) · [Workflows](#workflows) · [Full guide](docs/guide.md)

- **Track motion** using body, hand or mouth anchors. Add mask videos to select individual people.
- **Plan long videos:** use frame-accurate navigation and keyboard In/Out marks, detect hard cuts, and select anchor and stabilization regions in the [processing timeline](docs/processing-timeline.md), then process all, selected or unfinished intervals.
- **Build your timeline** with multiple tracks, zoom, section blending and locks that protect edits across reruns.
- **Fill motion gaps or add patterns:** preview a continuation of the surrounding rhythm or choose from 40 generated shapes, then join it into the selected curve. See [gap filling and patterns](docs/patterns.md).
- **Review a folder of videos:** Folder Processing Timeline shows one clip at a time with processing and Motion Studio together. Review finished clips during bulk processing, use subfolder presets, inspect flagged ranges, compare saved script versions, and approve with one click to advance. Batches skip existing scripts, support pause/resume and retrying failures, and write beside videos only on approval. Rate quality and keep notes for later filtering. See [folder review](docs/folder-timeline.md).
- **Browse Civitai from the folder workspace:** recognize existing downloader filenames, browse in Civitai's API sort order, and select clips for individual or bulk processing. New downloads stay temporary for review. Approve a clip into its category with the edited funscripts, reject temporary clips, or keep undecided drafts for later. See [Civitai browser and review](docs/civitai-browser.md).
- **Publish a funscript dataset:** export completed Main scripts with Civitai ID hashes, category names and relative folder hierarchy, multi-axis variants, review status and quality ratings, then publish a GPL-3.0 Hugging Face dataset for other apps to query. The exporter runs alongside active processing without a ComfyUI restart. See [public dataset export](docs/public-dataset.md).
- **Build motion from music:** use a drum stem for timing and the loaded video's soundtrack (or another full-mix file) to guide shape and energy. Follow accents, simplify busy percussion or reconstruct a steady pulse, then preview suggested, chosen or random patterns. Browse 28 motion shapes or automatically match the sound envelope to a pattern. Audition/export the selected rhythm with 14 percussion sounds or automatically approximate the drum stem’s timbre, save section blocks, and copy them into Main. See [audio beat patterns](docs/audio-patterns.md).
- **Edit in a dedicated tab:** connected Processing Timeline, Reference Editor and Motion Studio tools share one tabbed workspace. **Motion Studio · Standalone** keeps the workflow node compact.
- **Preview devices** with Handy 2 for stroke or SR6 for all six axes.
- **Compare device output:** use [stroke profiles](docs/device-output.md) to derive a separate L0 script for a physical range and speed limit.
- **Export and keep editing** with `.funscript` files, your project and a standalone offline editor.

## Install

Use a ComfyUI build with native **SAM3D Body** nodes. Run these commands in the Python environment that runs ComfyUI:

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/ethanfel/ComfyUI-Sam3D-to-Funscript.git
python -m pip install -r ComfyUI-Sam3D-to-Funscript/requirements.txt
```

Download [`sam_3d_body_dinov3_bf16.safetensors`](https://huggingface.co/Comfy-Org/sam-3d-body/tree/main/detection) into `ComfyUI/models/detection/`, then restart ComfyUI.

## Quick start

1. Open [Single video](workflows/01_single_video.json).
2. Choose a video in **Load Video**. Leave `operation` on **prepare**, then click **Run**.
3. Click **Open processing timeline**. Use **Automatic mode**, or define tracking and stabilization sections yourself.
4. Open **Motion Studio** from the timeline to combine sections, edit curves and preview the result.
5. Choose **Download project + scripts** and save your ComfyUI workflow to return to its session.

For audio patterns or manual authoring, open Motion Studio immediately after preparing the video; tracking is optional. See the [processing timeline guide](docs/processing-timeline.md).

For a collection of clips or Civitai browsing, start with [Folder library](workflows/02_folder_library.json), set `folder_path`, run **prepare**, then click **Open folder workspace**.

| Setting | What to know |
|---|---|
| `sample_fps` | Set to **0** to analyse every source frame. |
| `batch_size` | Start with **8**; larger batches need more memory. [Benchmarks →](docs/performance.md) |
| **Auto fit** | Adapts direction and range over time, independently for each anchor. |

## Edit the motion

- **Combine anchors:** choose additional anchors in a timeline section, or let Automatic mode prepare candidates for each detected person. Switch between them in the source section's anchor selector.
- **Use a section:** select a source row, Shift-drag a time range, then click **Use selection in main**. All available axes copy to their matching main axes, preserving locks. Choose **Blend** for smooth joins.
- **Fit motion automatically:** L0 defaults to **Adaptive · per anchor**, so large movements elsewhere in the clip do not set one range for the entire track. Use **Whole clip** for manual range control, or **Fit selection as track** for a separate section.
- **Seek and refine:** dragging moves the playhead by default. Enable **Edit points** for manual changes, or select a range and apply smoothing in milliseconds.
- **Protect finished work:** click **Lock**. The device preview and exported scripts follow the **main** tracks.

Your download includes `project.json` and `viewer.html`. Open the viewer and choose the matching source video to keep editing offline. The video itself stays separate.

## Workflows

| Start from… | Open this workflow |
|---|---|
| One video, including audio patterns | [01 · Single video](workflows/01_single_video.json) |
| Local folders, bulk review or Civitai | [02 · Folder library](workflows/02_folder_library.json) |

These are the two canvas starters. Specialized node recipes are in [advanced examples](extras/advanced/README.md); automation prompts are in [API examples](extras/api/README.md). Regenerate the starters with `python scripts/create_workflows.py`.

## Before you export

This is a development-stage authoring tool. Review tracking around occlusions, camera changes and hand motion. Device previews are schematic and do not control hardware or validate its physical limits.

[Full guide](docs/guide.md) · [Performance](docs/performance.md) · [Device wireframes](assets/device-previews/README.md) · [Research](research/SAM3D_FUNSCRIPT_BLUEPRINT.md)

## License

[GPL-3.0-only](LICENSE). Model weights and third-party dependencies retain their own licenses.
