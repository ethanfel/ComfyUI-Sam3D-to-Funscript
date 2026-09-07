// SPDX-License-Identifier: GPL-3.0-only
// Original schematic geometry. See README.md for references and fidelity limits.
export const AXES = Object.freeze(["L0", "L1", "L2", "R0", "R1", "R2"]);
export const PALETTE = Object.freeze({
    fixed: "#486076", detail: "#597184", linkage: "#8aa8b5",
    moving: "#75e2ba", marker: "#eabf71", unreachable: "#ee997d",
});
export const DEVICE_INFO = Object.freeze({
    handy2: Object.freeze({name: "Handy 2", axes: Object.freeze(["L0"]), center: [0, 0, 25], span: 310}),
    sr6: Object.freeze({name: "SR6 + twist receiver", axes: AXES, center: [0, 5, -60], span: 385}),
});

const TAU = 2 * Math.PI;
const add = (a, b) => a.map((v, i) => v + b[i]);
const sub = (a, b) => a.map((v, i) => v - b[i]);
const mul = (a, s) => a.map(v => v * s);
const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const radians = degrees => degrees * Math.PI / 180;
const angleDistance = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

/** Funscript positions, 0–100. Absent/non-finite inputs use neutral (50). */
export function normalizeAxes(values = {}) {
    return Object.fromEntries(AXES.map(axis => [axis,
        Number.isFinite(values?.[axis]) ? clamp(values[axis], 0, 100) : 50,
    ]));
}

function geometry() {
    const lines = [];
    const line = (a, b, role = "fixed", width = 1.4, dashed = false) => {
        lines.push({a, b, role, width, dashed});
    };
    const path = (points, role, width, closed = false) => {
        for (let i = 1; i < points.length; i++) line(points[i - 1], points[i], role, width);
        if (closed) line(points.at(-1), points[0], role, width);
    };
    const box = (center, size, role = "fixed", transform = p => p) => {
        const points = Array.from({length: 8}, (_, i) => transform(center.map((v, k) => v + ((i >> k & 1) - .5) * size[k])));
        for (let i = 0; i < 8; i++) for (let k = 0; k < 3; k++) if (!(i >> k & 1)) line(points[i], points[i | 1 << k], role);
    };
    const ring = (center, radius, role = "moving", transform = p => p, segments = 32) => {
        const points = Array.from({length: segments}, (_, i) => transform(add(center, [radius * Math.cos(i * TAU / segments), 0, radius * Math.sin(i * TAU / segments)])));
        path(points, role, 1.7, true);
    };
    const cylinder = (center, radius, height, role, transform = p => p) => {
        for (const dy of [-height / 2, height / 2]) ring(add(center, [0, dy, 0]), radius, role, transform);
        for (let i = 0; i < 4; i++) {
            const offset = [radius * Math.cos(i * TAU / 4), 0, radius * Math.sin(i * TAU / 4)];
            line(transform(add(add(center, offset), [0, -height / 2, 0])), transform(add(add(center, offset), [0, height / 2, 0])), role);
        }
    };
    return {lines, line, path, box, ring, cylinder};
}

function handy2(values, sleeve) {
    const g = geometry();
    // Faceted rounded housing: 73.2 × 215 × 60 mm overall envelope.
    const section = (y, x, z) => [[-.70*x,y,-z],[.70*x,y,-z],[x,y,-.65*z],[x,y,.65*z],
        [.70*x,y,z],[-.70*x,y,z],[-x,y,.65*z],[-x,y,-.65*z]];
    const shells = [section(-107.5, 26, 19), section(-96, 36.6, 30),
        section(91, 36.6, 30), section(107.5, 28, 22)];
    shells.forEach(points => g.path(points, "fixed", 1.5, true));
    for (let s = 1; s < shells.length; s++) for (let i = 0; i < 8; i++) g.line(shells[s - 1][i], shells[s][i]);
    // Front rail, end stops, and subtle housing seam.
    g.path([[-9,-78,30.6],[9,-78,30.6],[9,78,30.6],[-9,78,30.6]], "detail", 1.2, true);
    for (const x of [-4, 4]) g.line([x,-72,31],[x,72,31], "detail", 1);
    g.path(section(-69,36.6,30), "detail", .8, true);
    // Schematic control pad on the visible side; not a CAD button layout.
    g.path([[37,51,-8],[37,51,8],[37,67,8],[37,67,-8]], "detail", 1.1, true);
    g.line([37,55,0],[37,63,0], "detail", 1);
    g.line([37,59,-4],[37,59,4], "detail", 1);
    g.line([37,-83,-10],[37,-83,10], "marker", 2);

    const carriageY = (values.L0 - 50) * 1.25; // Published 125 mm full travel.
    const move = p => add(p, [0, carriageY, 0]);
    g.box([0,0,35], [23,21,8], "moving", move);
    g.box([0,0,44], [19,14,10], "moving", move);
    // ClickOn-style band holder. The accessory dimensions are illustrative.
    g.cylinder([0,0,73], 27, 19, "moving", move);
    if (sleeve) g.cylinder([0,5,73], 23, 87, "detail", move);
    g.line(move([0,-9.5,100]), move([0,9.5,100]), "marker", 3);
    return {...g, carriageY, reachable: true, linkages: []};
}

function rotateX([x, y, z], a) { return [x, y*Math.cos(a)-z*Math.sin(a), y*Math.sin(a)+z*Math.cos(a)]; }
function rotateY([x, y, z], a) { return [x*Math.cos(a)+z*Math.sin(a), y, -x*Math.sin(a)+z*Math.cos(a)]; }
function rotateZ([x, y, z], a) { return [x*Math.cos(a)-y*Math.sin(a), x*Math.sin(a)+y*Math.cos(a), z]; }

// A rotary horn moving in the YZ plane, attached to one rigid connecting rod.
// Solve d·(u cos θ + v sin θ) = (|d|² + horn² - rod²)/(2 horn).
// This is original analytic geometry, not a port of device firmware.
function solveLink(pivot, target, horn, rod, restAngle) {
    const d = sub(target, pivot);
    const radius = Math.hypot(d[2], d[1]);
    const c = (dot(d, d) + horn*horn - rod*rod) / (2*horn);
    const q = radius > 1e-9 ? c / radius : Infinity;
    const reachable = radius > 1e-9 && Math.abs(q) <= 1 + 1e-9;
    const phase = Math.atan2(d[1], d[2]);
    const alpha = Math.acos(clamp(q, -1, 1));
    const candidates = [phase + alpha, phase - alpha];
    const angle = candidates.sort((a,b) => angleDistance(a,restAngle)-angleDistance(b,restAngle))[0];
    const elbow = add(pivot, [0, horn*Math.sin(angle), horn*Math.cos(angle)]);
    return {pivot, elbow, target, horn, rod, reachable, angle,
        residual: Math.abs(Math.hypot(...sub(target, elbow)) - rod)};
}

function sr6(values, sleeve) {
    const g = geometry(), n = axis => (values[axis] - 50) / 50;
    // Preview ranges deliberately chosen for clear motion, not hardware limits.
    const translation = [-n("L2") * 22, n("L0") * 45, n("L1") * 22];
    const pitch = -radians(n("R2") * 20), roll = radians(n("R1") * 20);
    const twist = radians(n("R0") * 90);
    const platform = p => add(rotateZ(rotateX(p, pitch), roll), translation);
    // R0 rotates the optional inner receiver, leaving the six rod attachments fixed.
    const receiver = p => platform(rotateY(p, twist));

    // Rear enclosure and two banks of servos; receiver sits forward of them.
    g.box([0,0,-180], [179,137,22]);
    g.box([0,-74,-175], [197,12,54]);
    for (const x of [-50,50]) for (const y of [-50,50]) {
        g.path([[x-3,y-3,-192],[x+3,y-3,-192],[x+3,y+3,-192],[x-3,y+3,-192]], "detail", 1, true);
    }

    const specs = [];
    for (const side of [-1,1]) {
        for (const level of [-1,1]) {
            const pivot = [side*66,level*24,-148];
            const anchor = [side*61,level*9,0];
            g.box([side*66,level*24,-165], [33,28,37], "detail");
            specs.push({pivot, anchor, horn:50, rod:Math.hypot(148,65,5), rest:level*Math.PI/2});
        }
        const pivot = [side*96,54,-148], anchor = [side*27,47,12];
        g.box([side*96,54,-166], [28,31,38], "detail");
        specs.push({pivot, anchor, horn:65, rod:Math.hypot(160,58,69), rest:-Math.PI/2});
    }

    const linkages = specs.map(({pivot, anchor, horn, rod, rest}) => {
        const link = solveLink(pivot, platform(anchor), horn, rod, rest);
        const role = link.reachable ? "linkage" : "unreachable";
        // Two sides of each servo arm give it the flat-link appearance.
        for (const offset of [-3,3]) g.line(add(link.pivot,[offset,0,0]),add(link.elbow,[offset,0,0]), role, 1.6);
        g.line(add(link.elbow,[-3,0,0]),add(link.elbow,[3,0,0]),role,1.6);
        g.line(link.elbow,link.target,role,2, !link.reachable);
        return link;
    });
    // Outer ring and mounting ears. These follow L0/L1/L2/R1/R2 together.
    g.cylinder([0,0,0], 51, 18, "moving", platform);
    for (const side of [-1,1]) {
        g.box([side*56,0,0],[17,22,16],"moving",platform);
        g.path([[side*48,9,0],[side*27,47,12],[side*27,47,-13],[side*48,9,-22]],"moving",1.5);
    }
    // Optional twist receiver and its small motor pod.
    g.cylinder([0,12,0], 42, 10, "moving", receiver);
    g.box([0,4,-62],[30,26,23],"detail",platform);
    if (sleeve) g.cylinder([0,57,0], 34, 80, "detail", receiver);
    // An asymmetric index makes twist visible even when the sleeve is hidden.
    g.line(receiver([0,18,35]),receiver([0,18,49]),"marker",3);
    g.line(receiver([0,18,35]),receiver([0,sleeve?97:38,35]),"marker",2.3);
    return {...g, linkages, translation, rotation:{pitch,roll,twist},
        reachable: linkages.every(link => link.reachable)};
}

/** Pure geometry API: named line segments in millimetre-like model coordinates.
 * +X right, +Y up, +Z forward. SR6 dimensions are schematic.
 * A frame contains no timers, DOM objects, external assets, or hardware outputs.
 */
export function buildDeviceWireframe(device, positions = {}, options = {}) {
    if (!Object.hasOwn(DEVICE_INFO, device)) throw new RangeError(`Unknown device: ${device}`);
    const normalized = normalizeAxes(positions);
    // Expose only supported channels, so Handy frames never depend on R/L1/L2.
    const values = Object.fromEntries(DEVICE_INFO[device].axes.map(axis => [axis, normalized[axis]]));
    const frame = (device === "handy2" ? handy2 : sr6)(values, options.sleeve !== false);
    return {device, values, lines:frame.lines, reachable:frame.reachable, linkages:frame.linkages,
        ...(device === "handy2" ? {carriageY:frame.carriageY} : {translation:frame.translation, rotation:frame.rotation})};
}

/** Stable framing: model scale stays fixed throughout playback. Angles are radians. */
export function projectWireframe(frame, width, height, view = {}) {
    const {center, span} = DEVICE_INFO[frame.device];
    const yaw = Number.isFinite(view.yaw) ? view.yaw : .62;
    const pitch = Number.isFinite(view.pitch) ? view.pitch : .27;
    const zoom = Number.isFinite(view.zoom) ? clamp(view.zoom,.4,2.5) : 1;
    const scale = Math.min(width,height) / span * zoom;
    const project = point => {
        const [x,y,z] = rotateX(rotateY(sub(point,center),yaw),pitch);
        return [width/2+x*scale, height/2-y*scale, z];
    };
    return frame.lines.map(line => ({...line,a:project(line.a),b:project(line.b)}))
        .sort((a,b) => a.a[2]+a.b[2]-b.a[2]-b.b[2]);
}

/** Draw in CSS pixels; caller owns canvas sizing, DPR transform and clear. */
export function drawDeviceWireframe(ctx, width, height, device, positions = {}, options = {}) {
    const frame = buildDeviceWireframe(device,positions,options);
    ctx.save();
    ctx.lineCap="round"; ctx.lineJoin="round";
    for (const line of projectWireframe(frame,width,height,options)) {
        ctx.strokeStyle=PALETTE[line.role]; ctx.lineWidth=line.width;
        ctx.setLineDash(line.dashed ? [4,4] : []);
        ctx.beginPath();ctx.moveTo(line.a[0],line.a[1]);ctx.lineTo(line.b[0],line.b[1]);ctx.stroke();
    }
    ctx.restore();
    return frame;
}

/** Standalone transparent SVG using the exact same geometry as Canvas playback. */
export function deviceSVG(device, positions = {}, options = {}) {
    const width=options.width ?? 480, height=options.height ?? 380;
    if (![width,height].every(v => Number.isFinite(v) && v>0)) throw new RangeError("SVG dimensions must be positive numbers");
    const frame=buildDeviceWireframe(device,positions,options);
    const lines=projectWireframe(frame,width,height,options).map(l =>
        `<path d="M${l.a[0].toFixed(2)} ${l.a[1].toFixed(2)}L${l.b[0].toFixed(2)} ${l.b[1].toFixed(2)}" stroke="${PALETTE[l.role]}" stroke-width="${l.width}"${l.dashed?' stroke-dasharray="4 4"':''}/>`).join("\n");
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img"><title>${DEVICE_INFO[device].name} schematic wireframe</title><g fill="none" stroke-linecap="round" stroke-linejoin="round">${lines}</g></svg>`;
}
