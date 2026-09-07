# Selected-point pilot — 7 September 2026

The next implementation milestone is explicit point selection with identity checks and correction. A local CoTracker3 pilot improves short-interval curve agreement, but reveals lost points and identity drift. It does not establish reliable automatic scripting.

## What ran

Eva video, 350.00–379.96 seconds, 750 frames at the native 25 fps. Three points were selected on the same moving hand and one reference point on the torso, using the first frame. The primary point and a fixed vertical image direction were chosen before looking at the comparison results. The other two points were tracked for diagnosis and did not change the output curve.

The signal is the selected point's vertical displacement relative to the torso point. Gain and center use only the first 12 seconds of reference positions. After a one-second gap, evaluation covers 363.00–379.96 seconds. No smoothing, time-offset search, direction search, or evaluation-driven point selection was used.

The comparison uses the existing SAM3D right-wrist camera-X trajectory, with gain and center refitted on the same first 12 seconds. Its pose cache is 8 fps; both outputs are evaluated at the video's 40 ms timestamps. This compares two pipeline configurations with different sampling rates, not tracker models under identical conditions. The reference is an authored curve, not measured physical motion.

| Evaluation section | MAE / 100 | RMSE / 100 | Correlation | Reference reversals matched |
|---|---:|---:|---:|---:|
| Selected point, hold when marked lost | 15.85 | 18.79 | 0.551 | 5 / 9 |
| SAM3D wrist, locally fitted | 21.49 | 25.27 | -0.507 | 0 / 9 |
| Constant fitting-section median | 19.28 | 22.39 | Undefined | 0 / 9 |

Reversals require 10-position prominence and a match within 200 ms. Five matches are encouraging but too few to establish general reliability. These numbers are not comparable to the earlier full-video test scores as if they used the same evaluation footage.

Metrics use the mapped trajectories before integer rounding and action simplification. The exported review script rounds to integer positions and simplifies with a 0.75-position tolerance.

## Observed failure

The primary point/reference pair was marked visible in only 61.3% of frames. Missing intervals included a continuous gap of about six seconds. Holding during these gaps removes intended motion and can create jumps when the point returns.

Review of eight annotated frames also shows points initially grouped on the same hand separating across different hands later in the clip, particularly around 365 and 370 seconds. This is qualitative evidence of identity drift. It explains why simply choosing another point with a higher visibility fraction would be an inadequate reliability criterion. Model visibility is not independent evidence of correct identity.

The fixed torso reference remained marked visible throughout. The experiment therefore points to moving-point identity, occlusion handling and authoring intent as the next issues to resolve. Higher sampling alone did not remove them.

## Concrete next milestone

1. Add a first-frame selector for a target region, several supporting points, a reference point and a direction arrow.
2. Track the points with their visibility flags and inspect their relative motion for inconsistent tracks. Group agreement must be validated against manual checks; it is not automatically an accuracy score.
3. Show review intervals and allow reselection at a chosen frame, preserving original video timestamps. A hand change or occlusion needs an explicit authoring decision.
4. Repeat the reference comparison and add sparse manual point-identity annotations. Keep a separate, previously unused evaluation segment before making a whole-video reliability claim.
5. Integrate the corrected 2D motion stage into the normal node workflow. Revisit SAM3D depth/orientation and the device simulator after the primary motion signal passes these checks.

## Local artifacts and reproduction

- [Synchronized point/curve preview](../../development/point-tracking/eva-350/preview.html). Open it in a browser and choose the Eva source video; playback seeks to the analysed section. It does not need a running ComfyUI server.
- [Numeric report](../../development/point-tracking/eva-350/report.json), [plot](../../development/point-tracking/eva-350/comparison.png), [PDF](../../development/point-tracking/eva-350/comparison.pdf), [review-only script](../../development/point-tracking/eva-350/point-tracking-preview.funscript).
- [Initial selection recipe](../../development/point-tracking/eva-350-recipe.json), [source provenance](../../development/point-tracking/source.json), [checkpoint provenance](../../development/point-tracking/checkpoint.json).
- [Standalone probe](../../scripts/probe_point_tracking.py) and [preview template](../../scripts/point_tracking_preview.html). The current ComfyUI nodes and defaults are unchanged; interactive selection is not implemented yet.

```bash
PYTHONDONTWRITEBYTECODE=1 MPLCONFIGDIR=/tmp/s3f-matplotlib \
  /media/p5/miniforge3/envs/13_env_py313/bin/python scripts/probe_point_tracking.py \
  --recipe development/point-tracking/eva-350-recipe.json \
  --source development/point-tracking/vendor/co-tracker-82e02e8029753ad4ef13cf06be7f4fc5facdda4d \
  --checkpoint development/point-tracking/models/scaled_online.pth \
  --reference '/media/unraid/Downloads/Eva Myst - Slow motion of morning handjob with oil and red nails (CFNM).funscript' \
  --sam-cache development/output/sam3d_funscript/cache/a6430c513916729aea6d7c0e.npz \
  --output development/point-tracking/eva-350
```

Add `--reuse-tracks` to regenerate reports/preview without GPU inference. Source/checkpoint must already exist; the probe does not download code or install packages. The measured tracking stage took approximately 15 seconds after decoding/model loading, with 2.37 GiB peak Torch allocation on the RTX 5090. This is execution performance, not motion accuracy.

Source: [Meta CoTracker](https://github.com/facebookresearch/co-tracker/tree/82e02e8029753ad4ef13cf06be7f4fc5facdda4d), pinned commit `82e02e8…`, and [official CoTracker3 checkpoint](https://huggingface.co/facebook/cotracker3/tree/bf55ea50d4390e1820a267f131cd6587240fb2c5), pinned revision `bf55ea5…`. Checkpoint SHA-256: `205d34789f19699d64b22cf93f9b697f15f28d4025240e31532e504109837218`. The source and checkpoint are retained as optional development dependencies under their CC BY-NC 4.0 terms; they are not relicensed as part of this pack.

Validation: 17 Python tests pass, including online-window coverage, relative camera-motion cancellation, missing-interval holds and exclusion of evaluation labels from fitting. The review page has a separate [browser smoke report](../../development/point-tracking/eva-350/browser-report.json).
