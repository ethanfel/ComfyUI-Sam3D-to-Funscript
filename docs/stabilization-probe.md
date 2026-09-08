# Target-locked stabilization probe

This optional development tool compares reference-point trackers on the same clip,
crop, and manually selected points. It writes a black-padded stabilized video and
an interactive, synchronized comparison page. It does not change the ComfyUI nodes
or connect a device. No external model code or weights are downloaded by the tool.

## Method

1. Freeze a JSON recipe before inference: source video, fixed pixel crop, initial
   query points, fitting/audit roles, and consensus thresholds.
2. Run each tracker separately on the GPU, preserving every source presentation
   timestamp. TAPNext++ uses one frame and recurrent state; CoTracker3 online uses
   overlapping 16-frame windows. Neither adapter decodes the entire video into RAM.
   Coordinate history grows with clip duration; model loading has its own RAM cost.
3. Estimate translation from each visible fitting point's displacement from its
   own frame-zero position. Fit a robust common displacement, excluding outliers.
   Changing point visibility cannot change the reference centroid. Audit points
   are tracked but do not participate in the fit.
4. Flag insufficient visibility, disagreement, or implausible displacement.
   Hold the previous transform through rejected frames. Reacquisition is checked
   against the number of elapsed frames, rather than one frame's motion budget.
5. Decode the source again and apply inverse translation on a fixed canvas with
   symmetric black padding. Preserve scale, orientation, frame count, and exact
   presentation timestamps. Encode H.264 CRF 16; audio is omitted. Decode the output
   to verify that its timestamps match the source exactly.

The algorithm is target locking, not conventional camera-shake smoothing. It does
not estimate depth or correct rotation, perspective, or deformation. It cannot
recover a reference that leaves the source image. A coherent group can drift to the
wrong surface and still pass consensus. Visibility, inlier residual, and audit-point
agreement are therefore **not independent accuracy measurements**.

The speed guard is in pixels per source frame. Use a suitable value for the actual
source frame cadence; it is a diagnostic guard, not a calibrated physical limit.
There is no cut detection, manual correction UI, or automatic reseeding in this probe.

## Optional model sources

- [CoTracker3](https://github.com/facebookresearch/co-tracker), pinned for the local
  comparison to `82e02e8029753ad4ef13cf06be7f4fc5facdda4d`, `scaled_online.pth`.
  Uses the official 6×6 support grid and visibility × confidence threshold of 0.6.
  Its optional source/checkpoint license is CC-BY-NC-4.0; it is not bundled or
  relicensed as part of this GPL-3.0 project.
- [TAPNext++ official 512-pixel streaming implementation](https://github.com/google-deepmind/tapnet/tree/c2cbab81cc06092b5f05bfe2da7bfec54e2079c9/tapnet/tapnextpp/votsp2026),
  pinned to `c2cbab81cc06092b5f05bfe2da7bfec54e2079c9`, `tapnextpp_512.ckpt`.
  Uses its official frame wrapper and 64 local support points per query, float32
  weights and float16 CUDA autocast. Its 256-unit coordinate space is retained even
  though image inference uses 512 pixels. Optional code/weights use Apache-2.0.

Model input sizes, support grids, visibility rules, and temporal context differ.
This compares these configurations, not an equal-settings architecture benchmark.
Both adapters use dependencies already present in the tested Python 3.13 environment:
PyTorch/torchvision, NumPy, PyAV, OpenCV, and einops. Training packages are unnecessary.

## Run

Recipe coordinates are original video pixels; `crop_xywh` is a fixed pixel crop.
Use at least three reference points on a coherent, identifiable surface. Extra
`audit` points are optional. For example, adapt this to a non-private test clip:

```json
{
  "video": "/absolute/path/to/source.mp4",
  "crop_xywh": [0, 0, 512, 512],
  "points": [
    {"name": "a", "xy": [200, 200], "role": "reference"},
    {"name": "b", "xy": [230, 200], "role": "reference"},
    {"name": "c", "xy": [215, 225], "role": "reference"},
    {"name": "check", "xy": [220, 210], "role": "audit"}
  ],
  "consensus": {"tolerance": 12, "minimum": 3, "max_step": 48}
}
```

```bash
python scripts/probe_stabilization.py track --recipe recipe.json \
  --backend cotracker3 --model-source /path/to/co-tracker \
  --checkpoint /path/to/scaled_online.pth --output development/stabilization/cotracker3
python scripts/probe_stabilization.py track --recipe recipe.json \
  --backend tapnextpp --model-source /path/to/tapnet \
  --checkpoint /path/to/tapnextpp_512.ckpt --output development/stabilization/tapnextpp
python scripts/probe_stabilization.py render --output development/stabilization/cotracker3
python scripts/probe_stabilization.py render --output development/stabilization/tapnextpp
python scripts/probe_stabilization.py review --output development/stabilization
```

Open `development/stabilization/index.html` in a browser. Keep `review-data.js`,
`source.mp4`, and the two tracker directories beside it. No server or upload is
required. The page supports synchronized playback, frame stepping, graph seeking,
point overlays, and direct video downloads. Each run also contains:

- `tracks.npz`: original-pixel tracks, visibility, timestamps, source/recipe/model
  hashes, configuration, runtime, and memory measurements.
- `stabilization.npz`: translation, consensus flags, inlier counts and residuals.
- `report.json`: screening statistics, gaps, and verified export information.
- `stabilized.mp4`: clean preview for downstream experiments.

`analyze --output ...` recomputes translation from saved tracks without GPU inference.
Run `render` and `review` again afterward to update the exported artifacts.

## Local comparison, 8 September 2026

The selected 10.03125-second source has 321 frames at 32 fps, 960×1440 pixels.
Both trackers used the same fixed 512×512 crop, six fitting points, and two audit
points. The recipe was fixed before inference; weights and source are pinned.

| Configuration | Decode + tracking | Peak PyTorch GPU allocation | Frames passing screening |
| --- | ---: | ---: | ---: |
| CoTracker3 online | 14.28 s | 2.33 GiB | 215/321 (67.0%) |
| TAPNext++ 512 | 14.78 s | 2.19 GiB | 185/321 (57.6%) |

These are single local runs, excluding model loading and rendering. Peak process
RSS including loading was about 1.58 GiB and 4.02 GiB, respectively; this is not
decoded-video memory. GPU numbers are PyTorch allocations, not total device use.
The workstation's regular ComfyUI process remained running.

Visual spot checks at 0, 0.5, 1, 2, 4, 6, 8, and 10 seconds found both sets of
points around the intended region. The region substantially deforms and some
queries leave the source image near the bottom edge. TAPNext++'s points also
compress into a smaller cluster at several phases. Correct region membership
does not establish accurate tracking of each individual surface point.

The initial analysis incorrectly applied a one-frame jump budget after held gaps.
That was corrected for both models without rerunning or changing their tracks,
query points, or thresholds. The table reports the corrected analysis (version 2).

CoTracker3 is the more useful starting configuration in this particular test.
Neither output is an unattended reference across the entire clip: manual
correction/reseeding or a reference that remains visible is still needed. A masked
reference selector can simplify seeding, but its moving centroid is not a substitute
for stable point identities. No claim about metric 3D accuracy follows from this test.

Private footage, queries, models, overlays, and rendered previews stay under the
ignored `development/stabilization/` directory. They are not included in the repository.

## Checks

```bash
python -m unittest discover -s tests -p test_stabilization_probe.py -v
node scripts/stabilization_browser_smoke.mjs development/stabilization
```

The tests cover outliers, changing visibility, missing-reference holds, reacquisition,
bounded overlapping windows, and a synthetic video whose known translation is
cancelled while its irregular timestamps and black canvas margins are preserved.
The browser check uses the local 321-frame comparison and installed Chrome. It
verified all three videos decode, synchronized playback and seeking, frame stepping,
last-frame selection, graph clicks, overlays, and narrow layout, with no JavaScript
errors. QA screenshots hide the source imagery.
