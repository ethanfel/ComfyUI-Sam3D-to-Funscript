# Streaming extraction performance

The streaming node uses ComfyUI's SAM3D loader, model, crop preprocessing,
mask conditioning and model memory manager. `batch_size` counts **person crops
per forward**, so two ROIs with a batch of 32 normally produce 16 frames per
forward. Empty mask frames remain missing samples and consume no model crops.
When a frame has more person rectangles than the batch size, its rectangles run
in successive groups and retain their original person indices. Single-frame
anchor previews use groups of at most eight crops.

## Changes

- Keep decoded images as uint8. Remove the full-resolution RGB → float32/255 →
  uint8 conversion round trip through the general-purpose `IMAGE` node interface.
- Prepare crops in small groups before combining their model-sized tensors into
  the requested GPU batch. This prevents a large batch from multiplying all
  full-resolution float buffers at once.
- Skip canonical mesh colors, face-region sweeps and hand-region mesh masks
  that the general native prediction node calculates for mesh rendering.
- Copy the pose fields used by the extractor to CPU. When native body output
  lacks face landmarks, retain vertices/joints for the existing mouth regression.
- Decode with four bounded FFmpeg threads. Original pixels, presentation
  timestamps, sampling, trim semantics and the 512×512 model crop are preserved.
- Record model-load, crop-preparation and prediction/copy times, batch count,
  requested batch and largest actual forward in `metadata.performance`.
  A console summary reports these after extraction.

Source RGB is still buffered up to the requested frame batch; one hour of video
is never loaded as images. Larger batches still cost RAM and VRAM. The crop
working-buffer target is 128 MiB, allowing at least one group's ROI crops; it is
**not** a cap on total process memory. Prepared model crops, decoder buffers,
weights, saved coordinates and allocator caches consume additional memory.

## Local measurements — 2026-09-07

RTX 5090 (32 GB), `13_env_py313`, SAM3D DINOv3 BF16, one full-frame ROI,
128 frames from a 1536×2304 source, every original frame selected. Same loaded
model, warm-up before timing, cache reads disabled. Wall time includes decoding,
inference and writing the pose cache. Loading the model took another 15.9 seconds
in this test and is excluded from the table.

Two runs per configuration, alternating backend order; table times are their
means. RSS is the sampled process peak including the model and allocators.

| Person-crop batch | Previous time | Updated time | Updated throughput | Previous peak RSS | Updated peak RSS | Updated CUDA reserved peak |
|---|---:|---:|---:|---:|---:|---:|
| 32 | 10.09 s | 5.12 s | 25.0 frames/s | 6.6–6.8 GiB | 3.5–3.6 GiB | 4.8 GiB |
| 64 | 9.10 s | 4.51 s | 28.4 frames/s | 10.4 GiB | 4.2 GiB | 7.0 GiB |

A separate single run at batch 128 took 4.36 s (29.4 frames/s) with 11.5 GiB
reserved CUDA memory. It offered little throughput gain over 64. These are
measurements of this clip and environment, not a prediction for every codec,
resolution, number of people or GPU.

The original profile explains low GPU activity: at batch 64, a 64-frame run
spent only 1.14 seconds in native inference out of 11.37 seconds total. Much of
the time was spent making CPU image buffers. Larger batches alone could not
remove that overhead. CPU decoding/preprocessing and GPU launch overhead still
limit throughput; full-time 100% GPU utilization is not guaranteed.

## Correctness checks

- Actual prepared model tensors matched native Predict exactly for a full-frame
  person, two separate ROIs with a custom FoV, and moving lower-resolution masks.
- Source pixels matched serial decoding; timestamps, valid slots and cut segments
  matched between old/new extraction in the benchmark.
- Comparison includes all 70 body landmarks and both reconstructed mouth corners.
- Native CUDA rig accumulation is not bitwise deterministic. Repeated 128-frame
  runs differed by up to about 1.2 mm in estimated coordinates; old/new comparisons
  in these runs reached 2.2 mm (9 projected pixels). These are numerical comparisons,
  not measurements against ground-truth motion. No model, resolution or frame-rate
  reduction was used to gain speed.
- Existing pose caches remain compatible and reusable. A cache hit does no GPU
  inference, so turn `use_cache` off when measuring performance.

## Reproduce

Use the ComfyUI Python environment on an idle GPU. Both scripts write measurements
and compact poses, not source video or preview screenshots.

```bash
python scripts/benchmark_extraction.py \
  --comfy /path/to/ComfyUI \
  --model-dir /path/to/models/detection \
  --video /path/to/video.mp4 \
  --frames 128 --batches 8,32,64,128 --repeat 2

python scripts/inference_parity_smoke.py \
  --comfy /path/to/ComfyUI \
  --model-dir /path/to/models/detection \
  --video /path/to/video.mp4
```

To compare against the pre-optimization extractor, save its module and supply it
to the benchmark (the current core and weights are used for both versions):

```bash
mkdir -p development/performance
git show bbc0b0e:sam3d_funscript/video.py > development/performance/video_before.py
python scripts/benchmark_extraction.py \
  --comfy /path/to/ComfyUI \
  --model-dir /path/to/models/detection \
  --video /path/to/video.mp4 \
  --baseline-file development/performance/video_before.py \
  --batches 32,64 --repeat 2
```

Detailed JSON is saved under `development/performance/`. The benchmark shares
one loaded model to isolate extraction cost; normal production extraction also
incurs loading on a new uncached node execution. ComfyUI's separate native-loader
workflow remains available for full mesh output and optional hand refinement.
