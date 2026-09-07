# Reference calibration results — 7 September 2026

Both provided video/script pairs were processed in full. The current scalar body-anchor pipeline does not yet reproduce their authored stroke curves reliably.

| Reference | Video coverage | Pose samples | Default test correlation | Calibrated test correlation | Calibrated test MAE / 100 | Calibrated reversal recall |
|---|---:|---:|---:|---:|---:|---:|
| Silvervale | 212.49 s | 3401 | 0.099 | -0.069 | 27.00 | 3/39 (7.7%) |
| Eva | 1072.16 s | 8578 | -0.345 | 0.413 | 23.47 | 3/244 (1.2%) |

Correlation is not an accuracy percentage. MAE is a mean position difference on the script’s 0–100 scale. Reversal recall uses same-direction extrema with at least 10 units of prominence, matched one-to-one within 200 ms; it is sensitive to those explicit thresholds.

## Findings

- **Silvervale:** the selected calibration reduced motion standard deviation to about 14% of the reference and achieved negative held-out correlation. Its RMSE (31.79) was only slightly lower than the constant training-median baseline (32.47). This is mostly a collapse toward a stationary output, not successful motion matching.
- **Eva:** the selected wrist signal improved held-out correlation to 0.413 and RMSE to 28.84, compared with 32.09 for the default and 31.53 for the constant baseline. It retained about 43% of reference motion standard deviation but matched only 3 of 244 qualifying reference reversals. That is insufficient for a validated preset.
- Both searches selected the right-wrist camera-left component, with different gains/signs and smoothing. These selections are diagnostic results, not recommended settings for other clips.
- The two references contain only a stroke axis. They provide no validation for surge, sway, twist, roll or pitch.

## Method

The first 60% of each common video/script interval fitted gain and center; the next 20% selected among five anchors, three translation directions and smoothing of 0/40/80/120 ms. One-second gaps surround the split boundaries. The final 20% was excluded from parameter fitting and selection. Test labels changing without changing the selected configuration is covered by a regression test. Time offset was fixed at zero.

The default is camera-relative pelvis/up, 0.2 m full-scale range, center 50, 80 ms Gaussian smoothing. Calibration searches the current node’s scalar camera-coordinate mappings, not arbitrary local directions or object-relative tracking. Both outputs are evaluated as exported piecewise-linear funscripts on a 20 ms grid. A constant training-median output exposes misleading improvements from flattening the signal.

Silvervale was sampled at 16 Hz (3,401 poses); Eva at 8 Hz (8,578 poses). Eva’s faster sections are under-resolved relative to a higher-rate run, and smoothing can suppress reversals. That limitation does not establish that a higher rate alone would fix the tracking. Full-frame single-person ROI slots were used; explicit identity/mask tracking was not present. No independent physical 3D/contact labels are available.

## Review artifacts

- **Silvervale**: [detailed report](../../development/calibration/silvervale/REPORT.md), [numeric results](../../development/calibration/silvervale/report.json), [plot](../../development/calibration/silvervale/comparison.png), [PDF](../../development/calibration/silvervale/comparison.pdf), [live comparison](http://127.0.0.1:8197/sam3d_funscript/assets/viewer.html?project=silvervale_calibrated_109b6ee43603).
- **Eva**: [detailed report](../../development/calibration/eva/REPORT.md), [numeric results](../../development/calibration/eva/report.json), [plot](../../development/calibration/eva/comparison.png), [PDF](../../development/calibration/eva/comparison.pdf), [live comparison](http://127.0.0.1:8197/sam3d_funscript/assets/viewer.html?project=eva_calibrated_2ebb6c1cfb67).

The live comparison shows the selected diagnostic calibration, not a validated final script. The original reference is purple, generated actions green, and the selected anchor yellow. The plot and detailed report also show the default baseline.

## Changes made to the node pack

- Added `Compare Reference Funscript` and a canvas-editable reference workflow.
- Added browser reference loading, offset controls, live MAE/RMSE/correlation and a purple reference overlay.
- Added a yellow selected-anchor marker and a one-second projection trail.
- Added reproducible calibration/benchmark tooling and PNG/PDF reports.
- Added a small video-source manifest so video requests do not repeatedly parse the long pose project.

The original node defaults remain unchanged. Further work should target explicit hand/object identity and a reviewed motion direction, then benchmark those changes against these same pairs while preserving a separate final evaluation set.

A subsequent [selected-point CoTracker3 pilot](POINT_TRACKING.md) tests that direction on a short Eva section. Its results and evaluation interval are separate from the full-video benchmarks above.
