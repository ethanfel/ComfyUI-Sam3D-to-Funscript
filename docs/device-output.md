# Device output profiles

Motion Studio can derive a **separate L0 script** for a selected stroke zone and speed limit. The main timeline, source tracks, locks and pose smoothing remain intact. The orange comparison and adjusted device preview evaluate the same integer actions that are downloaded.

This implements the initial single-axis foundation from [the device research document](../research/DEVICE_PROFILES.md). It checks requested speed under linear interpolation. It does **not** predict measured hardware motion or bound acceleration, jerk, latency, deadband or combined-axis geometry.

## Use it

1. Assemble your main L0 track as usual, including sections from different anchors. Lock finished tracks if desired.
2. Open **Device output · stroke profiles**, directly below main.
3. Select **Handy · original**, **Handy 2 · Standard**, **Handy 2 Pro · normal mode**, or **Custom · single axis**.
4. Enter the physical **Zone start / Zone end** in millimetres. Factory profiles prefill published full travel; this is not a measurement of your unit or chosen operating zone.
5. Enter a speed limit in **mm/s**, or explicitly click **Use published … mm/s**. An empty limit performs analysis only. Record the unit, firmware/player, supply and sleeve/load in **Setup notes**.
6. Compare the orange curve on main L0. In **Device preview → Motion**, switch between **Authored main** and **Adjusted L0**. Adjusted mode uses L0 only; other schematic channels hold neutral. The device drawing remains schematic, including when used with a different single-axis profile.
7. Choose **Download adjusted L0** for a ZIP containing one `.funscript`, `device-output.json` and range instructions. **Download project + scripts** also includes valid adjusted output in its `device-output/` folder, alongside the usual authored main files at the root.

Configure the **same zone in your player/device exactly once**. Exported positions remain 0–100% of that zone. The optimizer uses millimetres for analysis, but it does not bake an additional endpoint transform into those percentages. The readout reports commanded position in the selected zone; it is not carriage telemetry.

Settings survive project downloads, the offline viewer, local editor saves and same-video reruns. They have Undo support. Adjusted output is recalculated from current main when edits or inputs change; stale generated actions are not stored in the project. Invalid settings disable adjusted playback/download and still allow the authored project to be downloaded with an explanation that adjusted output was omitted.

The ComfyUI node's automatic output files remain the authored main. Generate the separate adjusted files using the editor's download controls. After installing this version, restart ComfyUI once for the new module route, then refresh the editor. Pose extraction does not need to run again.

## What the limit means

```text
zone_mm = zone_end_mm - zone_start_mm
speed_mm_s = abs(next_pos - pos) × zone_mm × 10 / elapsed_ms
```

For the same authored 20→80 move in 100 ms:

| Zone | Limit | Authored demand | Adjusted positions |
|---|---|---|---|
| 100 mm | 400 mm/s | 600 mm/s | 30→70 |
| 100 mm | 800 mm/s | 600 mm/s | 20→80, unchanged |
| 50 mm | 400 mm/s | 300 mm/s | 20→80, unchanged |

These are mathematical examples, not hardware performance measurements. Factory templates retain sources, checked dates and **published** evidence. Manually entered numbers are labelled **assumed**; blank limits are **unknown**. A manual value is not upgraded to measured evidence. The report records the selected profile version, settings, physical mapping, before/after peak speed, over-limit interval counts, changed point count and maximum position change in mm.

The original Handy's template references [110 mm product travel](https://www.thehandy.com/store/the-handy-eu/) and the [older developer guide's speed specification](https://ohdoki.notion.site/Handy-functionality-2a5b14198a6c4204b270c47521fb5da9). Handy 2 templates distinguish Standard from Pro normal mode using [manufacturer specifications](https://www.thehandy.com/store/the-handy-2-eu/). Factory profiles reject settings above their published travel or normal-mode speed. Use Custom to evaluate a different setup and record it in the notes. No preset enables Pro overclock. A published maximum is not a validated loaded operating limit.

## Conditioning method and limits

The optimizer operates **after main-track assembly and joins**. It keeps all original timestamps and outputs integer positions. For each interval it computes the allowed integer position change at the chosen physical speed. Forward and backward passes construct feasible curves below and above the authored curve; their rounded midpoint becomes the adjusted script. Feasible curves are unchanged. There is no causal playback delay, resampling or clipping of peaks to 0/100.

An authored hold has zero allowed change, so it stays still. Its level, the endpoints and neighbouring excursions may move to reconcile an impossible jump. A one-millisecond cut between long holds can flatten those holds to a common level; use authored blend transitions when you want travel between them. Very dense integer commands can require conservative amplitude reduction because sub-position moves cannot be represented at every retained timestamp. Original timestamps are retained, but that does not guarantee that all extrema or intended event meanings survive a severe limit.

The **final exported integer curve** is checked again. No additional simplification or range transform follows that check. SHA-256 hashes in `device-output.json` identify the exact UTF-8 JSON source L0 and output script; the hash implementation also works in offline and non-HTTPS LAN browsers. The algorithm uses linear time and memory in the number of actions and never reads video frames.

Speed alone cannot determine how much smoothing a device needs. Current pose denoising removes estimator noise before anchor calibration. To examine finer source detail, adjust the authoring node's `smoothing_ms` and rebuild from cached poses. Choosing a faster output profile only relaxes the speed constraint; it cannot recover motion already filtered out or correct inaccurate tracking.

SR6/OSR2+, SSR1 and other commercial adapters remain subsequent work. SR6 needs the actual linkage geometry, installed axes and joint limits. Acceleration/jerk limits need an explicit response model and measured motion. No hardware was driven or bench-calibrated for this implementation.

## Validation

`node tests/test_device_output.mjs` checks physical units, speed limits after quantization, unchanged feasible motion, preserved holds/timestamps, invalid inputs, evidence handling, export hashes, source/lock preservation and an hour-long numerical fixture. The served/offline Chrome check also covers playback, output overlays, narrower ranges, Undo, a real ComfyUI rerun, session reload, current-source export and narrow layouts:

```bash
node scripts/device_output_browser_smoke.mjs http://127.0.0.1:8198 TEST_PROJECT_ID development/device-output/browser
```

Use a disposable project with all six main axes, a fast L0 interval near the start and a valid local source video. The browser check creates its own editor session and saves video-hidden screenshots. It does not modify the supplied project or control a device.
