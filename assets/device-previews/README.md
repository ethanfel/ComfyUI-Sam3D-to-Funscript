# Device wireframe assets

Reusable assets for Motion Studio's Handy 2 / SR6 device selector, also provided
as an independent interactive demo in this directory.

Open **[preview.html](preview.html)** directly in a browser. It works offline,
including animation, six axis sliders, mouse/keyboard orbit, zoom, sleeve
visibility and SVG export. Animation starts only when you press **Play demo**.

| File | Purpose |
| --- | --- |
| `device-wireframes.mjs` | Reusable pure geometry, Canvas drawing and SVG export |
| `handy2.svg`, `sr6.svg` | Transparent wireframes at neutral position |
| `preview.svg` | Dark comparison sheet showing both devices |
| `preview.html` | Self-contained interactive demo; generated, no imports or CDN |
| `preview.template.html` | Editable demo UI source |
| `build-preview.mjs` | Regenerates the HTML and SVGs using the geometry module |
| `verify.mjs` | Checks channel isolation, stroke travel and rigid linkage behaviour |

## Geometry and motion

**Handy 2:** faceted housing, front guide, carriage and band holder. Only `L0`
moves the carriage and sleeve. The shell envelope uses the published
73.2 × 215 × 60 mm dimensions and carriage travel is 125 mm. Housing contours,
controls and accessory dimensions are schematic. Source:
[manufacturer specifications](https://www.thehandy.com/store/the-handy-2-eu/).

**SR6:** rear enclosure, six servos, rotary arms, rigid connecting rods and a
circular receiver. `R0` turns the optional inner twist receiver and its marker;
the six linkage attachment points remain on the outer platform. The mechanism
is based on the [SR6 overview](https://osr.wiki/books/sr6/page/overview), with
the upper/lower and pitcher servo arrangement cross-checked against
[TempestMAx's Alpha4 firmware](https://github.com/ayvasoftware/osr-esp32/blob/main/osr-esp32.ino).
All geometry and the analytic linkage solver here are original code; no CAD,
product photographs, firmware code or emulator meshes are bundled.

Model coordinates use +X right, +Y up and +Z forward. The following mappings are
**preview conventions**, with 50 neutral, and match the existing viewer's axis
directions. They do not prescribe servo configuration or hardware limits.

| Channel | Handy 2 | SR6 visual mapping from 0 to 100 |
| --- | --- | --- |
| L0 · stroke | −62.5 to +62.5 mm on Y | −45 to +45 model units on Y |
| L1 · surge | Ignored | −22 to +22 on Z |
| L2 · sway | Ignored | +22 to −22 on X |
| R0 · twist | Ignored | −90° to +90°, inner receiver's local Y |
| R1 · roll | Ignored | −20° to +20° around Z |
| R2 · pitch | Ignored | +20° to −20° around X |

SR6 translation/rotation ranges and dimensions are illustrative, not a measured
SR6 build profile. Pitch is applied before roll; twist is local to the receiver.
The arm solver preserves horn and rod lengths for reachable poses. It returns
`reachable: false` and draws dashed coral rods if a target cannot be reached
with this geometry. This check covers linkage length only: it does **not** model
joint limits, collisions, actuator speed, acceleration, torque, electronics or
device response. Neither model sends hardware commands.

## Viewer integration

The module accepts the existing evaluated script values as numbers from 0–100.
Out-of-range numbers are clamped; absent and non-finite values become 50.
Handy frames expose only `L0`, so changes to unsupported axes cannot affect them.

```js
import {drawDeviceWireframe} from "./device-previews/device-wireframes.mjs";

// Use the viewer's existing resize() to clear the canvas and set its DPR transform.
const [ctx, width, height] = resize(document.getElementById("robot"));
const values = {L0: 60, L1: 57, L2: 42, R0: 67, R1: 57, R2: 44};
const frame = drawDeviceWireframe(ctx, width, height, "sr6", values, {
    yaw: .62, pitch: .27, zoom: 1, sleeve: true,
});
// Use "handy2" for the stroke-only device. Read frame.reachable if needed.
```

`buildDeviceWireframe(device, values, options)` returns deterministic 3D line
segments (`a`, `b`, `role`, `width`, `dashed`) without a canvas. This can feed a
different renderer later. `projectWireframe()` supplies a stable orthographic
camera, so movement does not change framing. `deviceSVG()` renders that same
geometry into a transparent standalone SVG.

Motion Studio's selector displays only the chosen device's supported axis
readouts. A multi-axis project can be previewed on Handy using L0; editing and
exports retain all authored axes. Missing channels hold neutral at 50.

The explicit ComfyUI route `/sam3d_funscript/assets/device-previews/{name}` serves
the module, `preview.html` and the three SVGs. Source templates and other files
are not served. Node exports and browser ZIP downloads embed this renderer in a
self-contained `viewer.html`, including the project. Open that file directly,
choose the source video, and use either device offline.

## Rebuild and validation

From the repository root, using Node.js:

```sh
node assets/device-previews/build-preview.mjs
node assets/device-previews/verify.mjs
```

The preview uses the same generated geometry as the reusable module. Its SVG
comparison was rasterized and visually inspected. The browser integration check
covers live video playback and seeking, channel isolation, missing L0, orbit and
sleeve controls, offline export/re-export, and this demo's sliders and animation:

```sh
node scripts/device_browser_smoke.mjs http://127.0.0.1:8198 PROJECT_ID
```

Original code and generated assets follow the repository's GPL-3.0-only license;
see [LICENSE](../../LICENSE). Product names identify the depicted devices and do
not imply manufacturer endorsement.
