# Stroker characteristics and future optimization profiles

Research checked **7 September 2026**. This is a design reference for Motion Studio; it does not implement profiles or report hardware tests.

**Device profiles are feasible.** Start with a calibrated single-axis profile for Handy, then add build-specific OSR2+/SR6 profiles. Keep the authored timeline intact and generate a separate device-optimized output that users can compare before exporting.

The selection covers major script-oriented commercial families and the open-source/DIY stroker ecosystem. It is a practical compatibility shortlist, **not a market-share ranking**. Published maxima below are specifications or design claims, not measured performance under load.

## Device comparison

### Commercial linear strokers

All devices in this table move a sleeve or carriage along one physical stroke axis. Additional suction or vibration accessories do not make them six-axis robots.

| Device | Published stroke travel | Published speed | What matters for a profile |
| --- | --- | --- | --- |
| **Handy, original** | 110 mm | 32–400 mm/s in the older developer guide; product page also advertises 10–600 strokes/min | Separate from Handy 2. Mains powered. Verify the actual usable zone: older absolute-position API documentation goes to 115 mm, which is not the same as the 110 mm product specification. [Product](https://www.thehandy.com/store/the-handy-eu/), [developer guide](https://ohdoki.notion.site/Handy-functionality-2a5b14198a6c4204b270c47521fb5da9). |
| **Handy 2 Standard** | 125 mm | 32–400 mm/s | Single-axis reference candidate. Record power mode, sleeve/load and selected stroke zone. [Manufacturer specifications](https://www.thehandy.com/store/the-handy-2-eu/). |
| **Handy 2 Pro** | 125 mm | 32–450 mm/s normally; **1–800 mm/s in overclock mode** | Separate normal and overclock variants; never make the overclock claim the default operating limit. Standard and Pro share the advertised travel, not identical performance. [Manufacturer specifications](https://www.thehandy.com/store/the-handy-2-eu/). |
| **Kiiroo Keon, original** | **Conflicting official figures: 70 or 75 mm** | Up to 230 strokes/min; manufacturer comparison gives 259 mm/s | Confirm hardware revision and measured travel. Do not translate the strokes/min figure into a full-travel speed limit. [Product and comparison table](https://www.kiiroo.com/products/keon). |
| **Kiiroo Keon 2** | 95 mm | 28.5–684 mm/s; maximum explicitly belongs to **Finisher Mode** | Treat as a provisional future profile. At this check, the manufacturer listed pre-orders, with batch 2 expected December 2026/January 2027. Bluetooth/Wi-Fi and battery/wall operation are advertised; programmable access to the peak mode needs verification. [Manufacturer specifications and availability](https://www.kiiroo.com/products/keon-2). |
| **Lovense Solace** | 70 mm | Up to 280 strokes/min | Mainly a speed/depth-control candidate; preserve rhythm through an explicit approximation mode when timed positions are unavailable. [Manufacturer FAQ](https://www.lovense.com/faq/Hardware/Solace), [control API](https://developer.lovense.com/docs/standard-solutions/standard-api). |
| **Lovense Solace Pro** | **Conflicting official figures: 79 mm on the product page, 65 mm on a bundle page** | Up to 300 strokes/min; 0.65 mm adjustment increments advertised | Position scripting is documented, but actual usable travel and dynamic response need measurement. Adjustment resolution is not tracking accuracy. [Product](https://www.lovense.com/solace-pro-ai-automatic-blowjob-machine-men), [65 mm claim](https://www.lovense.com/ldr-sex-toys-for-couples-solace-pro-and-mission-2), [API](https://developer.lovense.com/docs/standard-solutions/standard-api). |
| **Autoblow AI Ultra** | No reliable numerical travel specification established in the primary pages reviewed | API exposes speed as 0–100%; no verified mm/s conversion | Good script-upload candidate, with a measured position/speed mapping still needed. The motor moves the whole stroker; keep this profile distinct from other Autoblow mechanisms. [Product](https://autoblow.com/product/autoblow-ai-ultra/), [developer API](https://developers.autoblow.com/reference/http-api-v1-autoblow/). |

**Do not compare strokes/min as though it were mm/s.** A quoted “stroke” may mean a traverse or a complete cycle, and maximum cadence may require short travel. For a complete out-and-back cycle of travel `d` mm at `f` cycles/s, average absolute speed is `2 × d × f`; this does not establish peak speed, acceleration or loaded performance.

### Open-source / DIY robots

These are build families. Servos, controller, supply, printed geometry and attachments can change the result substantially. A model name alone is insufficient to establish motion limits.

| Family | Motion channels | Published geometry / travel | Profile requirements |
| --- | --- | --- | --- |
| **OSR2** | Base: `L0` stroke + `R1` roll | No universal calibrated travel established here | Identify the actual assembly and servo setup. The “2” does not mean two independent translations. [OSR Wiki overview revision](https://osr.wiki/books/osr2/page/overview/revisions/248/changes). |
| **OSR2+** | Adds `R2` pitch; optional T-wist adds `R0` twist | Build-dependent | Up to four motion channels with twist. It cannot independently reproduce SR6 surge and sway. [OSR Wiki](https://osr.wiki/books/osr2/page/overview/revisions/248/changes), [emulator channel definitions](https://github.com/ayvasoftware/osr-emu). |
| **SR6** | `L0`, `L1`, `L2`, `R1`, `R2`; `R0` with twist receiver | Wiki gives **theoretical** total travel of 120 mm stroke, 60 mm surge, 60 mm sway; about ±30° roll/pitch and up to ±135° twist | Six servo-driven linkages form a modified Stewart mechanism. These figures are not an independently usable box of simultaneous extremes. Needs geometry, joint limits and combined-axis validation. [SR6 overview](https://osr.wiki/books/sr6/page/overview). |
| **SSR1 / Silent Stroker Robot** | `L0` only | Early creator announcement specified 120 mm; current builds must be identified separately | Brushless motor architecture. Encoder-equipped controller variants make it a useful single-axis calibration candidate; do not inherit servo-robot limits. [Early design](https://www.patreon.com/tempestvr/posts/january-23-76845146), [creator's architecture description](https://www.patreon.com/posts/october-24-115012910), [SSR1PCB hardware](https://github.com/millibyte-products/ssr1pcb). |

An SR6 build with no twist accessory must not advertise working `R0` simply because its firmware accepts that channel. Optional valve, vibration and lubricant outputs also require their own capability records. The reference firmware registers channels independently of the physical accessories installed. [Reference firmware](https://github.com/ayvasoftware/osr-esp32/blob/main/osr-esp32.ino).

Firmware matters as much as the device name. For example, **TCodeESP32** adds network control, on-device range limits and temperature features; its BLDC builds target SSR1, while other builds configure OSR2/SR6. **SSR1PCB** includes a rotary encoder and motor controller, with board-specific power and firmware configuration. Internal encoder feedback does not automatically mean host-accessible carriage telemetry. [TCodeESP32](https://github.com/jcfain/TCodeESP32), [SSR1PCB](https://github.com/millibyte-products/ssr1pcb).

For this document, “open-source/DIY” names the ecosystem. Record the exact design, firmware and component licenses separately when reusing material; a public protocol does not determine the license of every CAD file or firmware fork.

## How scripts reach the device

The profile should identify **device + firmware + connection path**. A device can expose different controls through its native API and through a bridge.

| Route | Documented control | Optimization consequence |
| --- | --- | --- |
| **Handy API v3 / firmware 4** | HSP buffers motion points and permits adding points during playback; HSSP compatibility uses HSP internally. HDSP is the direct-motion mode. | Prefer buffered, synchronized playback for known timelines. Keep live scrubbing and script playback as different adapter modes. Use v3 for new integrations; older examples remain online. [Firmware 4](https://www.thehandy.com/blog/firmware-4-is-here/), [v3 entry point](https://ohdoki.notion.site/Handy-Rest-API-v3-ea6c47749f854fbcabcc40c729ea6df4), [time-sync guide](https://ohdoki.notion.site/Time-Syncing-49cda199db034c0493ec029b70194422). |
| **TCode on OSR2/SR6/SSR1** | Normalized axis targets, `I` duration in milliseconds or `S` rate. Multiple channels can execute together at the newline. USB serial is the base transport; alternatives depend on firmware. | Schedule all axes against one clock. Translate normalized positions through the specific build's calibration; a TCode rate is not directly mm/s. [TCode specification](https://buttplug.io/stpihkal/protocols/tcode/), [network-capable firmware](https://github.com/jcfain/TCodeESP32). |
| **Intiface / Buttplug** | A bridge with per-device capabilities. Current specification includes `Position` and `HwPositionWithDuration`; hardware usually performs the timed ramp. Older clients use earlier message schemas. | Discover features and negotiate the protocol version. An accepted timed command is not proof of achieved motion, and the bridge is not a calibrated physics model. Keon is among the documented timed-position examples; independently verify Keon 2. [Output specification](https://buttplug.io/docs/spec/output/), [engine's original Keon support](https://github.com/intiface/intiface-engine/blob/master/CHANGELOG.md). |
| **Lovense Standard API** | Solace Pro: `Position` 0–100 and timestamped `PatternV2` setup/play/stop/sync. Thrusting and depth controls are separate. | Prefer `PatternV2` for prepared scripts. The position documentation describes continued movement for 300 ms and roughly 1–2 seconds to reach desired speed from rest. Measure starts and reversals; do not assume one constant latency fixes everything. [Official API](https://developer.lovense.com/docs/standard-solutions/standard-api). |
| **Autoblow Ultra API / SDK** | Script upload, loading, synchronized play/pause; direct `goto` takes position and speed percentages. State includes script time, motor temperature and error modes. | Prefer device script playback to individual cloud requests for each point. `goto` acknowledgement means accepted/sent, not physically completed. [HTTP API](https://developers.autoblow.com/reference/http-api-v1-autoblow/), [SDK](https://developers.autoblow.com/guides/autoblow-js-sdk/). |

Two details to preserve in adapter design:

- **TCode range preferences are not always enforced.** The v0.3 specification describes `D0`/`D1` identity/version queries and `D2` axes/preferences; saved preferences are advisory in that specification. Firmware forks may enforce additional limits. Avoid applying a range transform twice. [TCode](https://buttplug.io/stpihkal/protocols/tcode/), [TCodeESP32](https://github.com/jcfain/TCodeESP32).
- **Limits belong to a specific API operation.** Lovense's thrusting `Stroke` range requires at least 20 points between its endpoints; that does not establish the same restriction for `Position`. `PatternV2` documents increasing timestamps up to 7,200,000 ms. Store these constraints separately from mechanical travel. [Lovense API](https://developer.lovense.com/docs/standard-solutions/standard-api).

## What belongs in an optimization profile

The following is a **proposed design**, inferred from the differences above. It is not an existing configuration format.

| Group | Fields to retain | Why |
| --- | --- | --- |
| Identity | Manufacturer/family, revision, firmware, adapter and version, installed accessories | Prevents treating different builds or transports as interchangeable. |
| Evidence | Value, unit, source URL, checked date, status: `published`, `measured`, `assumed` or `unknown` | A marketing maximum must not silently become a validated operating limit. |
| Geometry | Axis availability, sign, neutral, usable endpoints, mm/degree mapping, rotation order, pivot offsets | Converts a normalized script into physical motion. OSR profiles also need linkage and joint geometry. |
| Dynamics | Direction-dependent speed, acceleration and jerk constraints; deadband, minimum reproducible excursion, tracking model | Describes what motion can actually be followed. Unknown values remain unknown. |
| Timing | Clock model, measured latency/jitter, command interval, buffer horizon, interpolation, seek/resume behavior | Separates transport timing from mechanical lag. |
| Operating setup | Supply/power mode, sleeve/receiver mass, mount orientation, thermal conditions, active device-side range | Measurements apply to a setup, not every unit carrying the same name. |
| User settings | Selected travel zone, intensity/amplitude preference, polarity, per-axis enablement | Keeps personal range choices separate from hardware capability. |

Use a **family template plus a per-unit calibration record**. A factory template can prefill supported axes and published specifications. It should leave unverified dynamic limits unset and label its preview accordingly.

### What the optimizer should do

1. **Preserve the source.** Store optimized curves separately, with source hash, profile version and settings. Track locks continue to protect authored edits.
2. **Map the selected axes and range once.** For a single-axis device, use the chosen main stroke track. Do not fold pitch, roll or sway into stroke without an explicit mapping.
3. **Find motion the device cannot follow.** Measure physical travel per interval, reversals, small noisy movements, and combined-axis reachability.
4. **Preserve timing while reducing impossible excursions.** Offer smooth amplitude reduction around an affected passage, with bounded changes to the center. Avoid repeated hard clipping, which turns peaks into plateaus. Show exactly what changed.
5. **Check the final exported curve.** Simplification and interpolation can change its velocity demands. Recheck after resampling, point reduction, section joins and final range mapping.
6. **Use one physical prediction for the timeline and simulator.** Overlay authored, optimized and predicted motion. Display unavailable axes and uncalibrated predictions clearly.

For linear, calibrated stroke mapping:

```text
x_mm = zone_min_mm + (position_0_to_100 / 100) × zone_travel_mm
segment_speed_mm_s = abs(next_x_mm - x_mm) / elapsed_seconds
```

Example: a 20→80 move over 100 ms in a 100 mm usable zone requests **600 mm/s**. The same points in a 50 mm zone request **300 mm/s**. This is why normalized curve slope alone cannot determine hardware feasibility.

Acceleration and jerk need an explicit interpolation/response model. A piecewise-linear funscript has abrupt slope changes at its corners; adding points does not by itself guarantee smooth physical acceleration. Likewise, an advertised minimum continuous speed is not a requirement to keep a device moving during a scripted hold.

For **SR6 and OSR2+**, also evaluate the trajectory in joint space: servo angles, angular speed, reachability and proximity to singular configurations. Independent axis clamps cannot establish that a combined movement is possible. For SR6, a sensible proposed policy is to preserve stroke timing first and reduce secondary motion when the assembly cannot achieve the requested combination.

## Measurements still needed

No device was driven or bench-tested for this research. Published specifications did not establish a complete loaded acceleration, jerk, latency and tracking-error model for any family above.

Use a repeatable **bench fixture without body contact**, with the intended sleeve/receiver load and a recorded power setup. Measure carriage motion optically against a scale or through verified position telemetry; API responses and commanded servo angles are not motion measurements.

| Check | Record | What it enables |
| --- | --- | --- |
| Slow sweep and holds | Physical endpoints, direction, neutral, command-to-position map, drift | Correct range mapping and inversion. |
| Small steps and reversals | Deadband, backlash, settling, repeatability | Remove unreproducible jitter without discarding meaningful small strokes. |
| Several amplitudes and cadences | Tracking error, amplitude loss, phase lag; both directions | Fit sustainable speed and response constraints across the operating range. |
| Start, pause, seek and resume | First-motion delay, stale-command behavior, settling time | Preserve synchronization at timeline transitions. |
| Longer repeat run | Temperature, supply behavior, drift and performance changes | Identify operating-condition dependence. |
| Combined-axis poses and paths | Joint limits, clearance, failed poses and joint speed | Validate a specific OSR2+/SR6 geometry and attachment set. |

Retain commanded and observed samples on aligned clocks. Report error in **mm/degrees**, timing error in **ms**, and peak/95th-percentile error, not just a correlation coefficient. Compare the original and optimized scripts on the same fixture. A useful profile reduces tracking error while preserving important event timing and avoiding artificial plateaus.

Keep **pose-estimation accuracy**, **authored curve quality**, **predicted device response**, and **measured device response** separate. A device profile cannot recover hand motion that the pose estimator did not capture.

## Suggested implementation order

| Stage | Deliverable |
| --- | --- |
| **1 · Shared foundation** | Profile metadata, capability selection, user range, evidence status and a separate optimized output. No automatic overwrite of main/source tracks. |
| **2 · Handy 1 / Handy 2** | Separate travel/power variants, calibrated single-axis dynamics and before/after timeline comparison. Pro overclock remains opt-in. |
| **3 · OSR2+ / SR6** | Per-build geometry, installed axes, joint-space checks and six-axis optimization. Include configurations without twist. |
| **4 · SSR1** | Reuse single-axis analysis with its own BLDC/encoder/power calibration. |
| **5 · Solace Pro / Keon / Autoblow Ultra** | Validate each adapter's actual positional behavior, transport timing and hardware response. Keon 2 stays provisional until verified on shipping hardware. |
| **6 · Approximate-control devices** | Dedicated rhythm/speed/depth conversion where positional replay is unavailable; visibly label the conversion. |

The existing [Handy 2 and SR6 wireframes](../assets/device-previews/README.md) can display profile-driven motion later. Their SR6 dimensions and ranges are currently **schematic**; the linkage check does not validate real servo limits, collisions or dynamics. Keep the renderer reusable and place calibrated constraints in a separate profile/evaluation layer.

Other mechanisms should get separate research before support: legacy Fleshlight Launch, distributed-contact Kiiroo Onyx designs, rotary devices, and pneumatic systems. For example, the Autoblow SDK describes VacuGlide through speed and valve commands, so it should not inherit an Ultra position profile. [SDK](https://developers.autoblow.com/guides/autoblow-js-sdk/).
