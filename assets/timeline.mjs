import {AXES, evaluate, roundEven, validateReference} from "./curve.mjs";

const geometryFields = ["points", "pixels", "times_ms", "segments"];
const sourceFields = ["metadata", "config", "scripts", "metrics", "warnings", "valid", "raw", "processed", "orientation_hints", "anchor_indices", "references"];
const contexts = new WeakMap();
const copy = value => structuredClone(value);

export function initializeTimeline(project) {
    if (!project.timeline) {
        const data = Object.fromEntries(sourceFields.filter(key => key in project).map(key => [key, project[key]]));
        // Curves and calibration remain editable; the source snapshot stays unchanged.
        for (const key of ["config", "scripts", "metrics", "references"]) if (key in data) data[key] = copy(data[key]);
        const label = `project_0 · ${data.config.target_anchor.replaceAll("_", " ")} · person ${data.config.target_person}`;
        project.timeline = {version: 1, sources: [{id: "project_0", label, geometry: "base", data}],
            geometries: {}, tracks: [], main: Object.fromEntries(Object.keys(project.scripts).map(axis =>
                [axis, {assembled: false, source: "project_0", regions: []}])), active: "main", selection: [0, 0]};
        newTrack(project, "project_0", Object.hasOwn(data.scripts, "L0") ? "L0" : Object.keys(data.scripts)[0]);
    }
    const timeline = project.timeline;
    if (timeline.version !== 1 || !Array.isArray(timeline.sources) || !timeline.sources.length || !Array.isArray(timeline.tracks)) throw new Error("Unsupported track project");
    if (new Set(timeline.sources.map(s => s.id)).size !== timeline.sources.length || new Set(timeline.tracks.map(t => t.id)).size !== timeline.tracks.length) throw new Error("Duplicate project or track IDs");
    for (const source of timeline.sources) {
        if (!sourceProject(project, source.id).times_ms?.length) throw new Error("Missing track pose data");
    }
    for (const track of timeline.tracks) {
        if (!AXES.includes(track.axis) || !sourceProject(project, track.source).scripts[track.axis]) throw new Error("Unknown track axis");
        validateReference(track.script);
    }
    if (timeline.active !== "main" && !timeline.tracks.some(t => t.id === timeline.active)) timeline.active = "main";
    timeline.selection ??= [0, 0];
    project.metrics ??= {};
    return timeline;
}

function cached(project, key, create) {
    let cache = contexts.get(project);
    if (!cache) contexts.set(project, cache = new Map());
    if (!cache.has(key)) cache.set(key, create());
    return cache.get(key);
}

export function sourceProject(project, id) {
    return cached(project, `source:${id}`, () => {
        const source = project.timeline.sources.find(s => s.id === id);
        if (!source) throw new Error(`Missing source project: ${id}`);
        const geometry = source.geometry === "base" ? Object.fromEntries(geometryFields.map(key => [key, project[key]])) : project.timeline.geometries[source.geometry];
        if (!geometry) throw new Error(`Missing geometry for ${id}`);
        return {schema: project.schema, ...source.data, ...geometry};
    });
}

export function newTrack(project, source, axis) {
    const timeline = project.timeline, data = sourceProject(project, source);
    if (!data.scripts[axis]) axis = Object.keys(data.scripts)[0];
    let n = 0;
    while (timeline.tracks.some(t => t.id === `track_${n}`)) ++n;
    const track = {id: `track_${n}`, name: timeline.sources.find(s => s.id === source).label, source, axis,
        settings: copy(data.config.axis_settings[axis]), script: copy(data.scripts[axis])};
    timeline.tracks.push(track);
    return track;
}

export function assignTrack(project, track, source, axis) {
    const data = sourceProject(project, source);
    if (!data.scripts[axis]) axis = Object.keys(data.scripts)[0];
    track.source = source; track.axis = axis;
    track.settings = copy(data.config.axis_settings[axis]); track.script = copy(data.scripts[axis]);
    delete track.metrics;
    // A reassigned lane needs a fresh auto-direction cache; other lanes retain theirs.
    contexts.get(project)?.delete(track);
}

export function trackProject(project, track) {
    const source = sourceProject(project, track.source);
    const data = cached(project, track, () => ({...source, config: {...source.config, axis_settings: {...source.config.axis_settings}}, scripts: {...source.scripts}, metrics: {}}));
    data.config.axis_settings[track.axis] = track.settings;
    data.scripts[track.axis] = track.script;
    return data;
}

export function editProject(project, outputAxis, active = project.timeline.active) {
    const track = project.timeline.tracks.find(t => t.id === active);
    if (track) return {data: trackProject(project, track), axis: track.axis, track};
    const source = sourceProject(project, project.timeline.main[outputAxis].source);
    const data = cached(project, `main:${outputAxis}`, () => ({...source, config: {...source.config}}));
    data.config.axis_settings = project.config.axis_settings; data.scripts = project.scripts; data.metrics = project.metrics;
    return {data, axis: outputAxis, track: null};
}

export function mainPoseProject(project, axis, time) {
    const main = project.timeline.main[axis], region = main.regions.find(r => time >= r.start && time < r.end);
    if (!region) return editProject(project, axis, "main");
    const source = sourceProject(project, region.source);
    const data = cached(project, region, () => ({...source, config: {...source.config,
        axis_settings: {...source.config.axis_settings, [region.axis]: region.settings}}}));
    data.config.axis_settings[region.axis] = region.settings;
    return {data, axis: region.axis};
}

export function timelineState(project) {
    const {tracks, main, active, selection} = project.timeline;
    return {tracks, main, active, selection};
}

export function restoreTimeline(project, state) {
    Object.assign(project.timeline, state);
    contexts.delete(project);
}

export function trackCoverage(project, track) {
    const source = sourceProject(project, track.source);
    return [Math.ceil(source.times_ms[0]), Math.floor(source.times_ms.at(-1))];
}

// Blend inside the selection. Outside it, preserve the authored main exactly
// (up to integer position rounding at newly introduced boundary samples).
export function spliceActions(main, source, start, end, method = "blend", blendMs = 200) {
    if (![start, end, blendMs].every(Number.isFinite) || start < 0 || end <= start || blendMs < 0) throw new Error("Select a nonempty time range and a nonnegative join duration");
    if (!["blend", "cut"].includes(method)) throw new Error("Unknown join method");
    start = Math.round(start); end = Math.round(end);
    if (end <= start) throw new Error("Selection must span at least one millisecond");
    const width = method === "blend" ? Math.min(Math.round(blendMs), Math.floor((end - start) / 2)) : 0;
    const knots = new Set([start, end]);
    for (const action of [...main, ...source]) if (action.at > start && action.at < end) knots.add(action.at);
    if (width) {knots.add(start + width); knots.add(end - width);}
    const value = time => {
        const weight = width ? Math.max(0, Math.min(1, (time - start) / width, (end - time) / width)) : 1;
        return evaluate(main, time) * (1 - weight) + evaluate(source, time) * weight;
    };
    const times = [...knots].sort((a, b) => a - b), inside = [];
    function segment(a, b) {
        const mid = Math.floor((a + b) / 2), va = value(a), vb = value(b);
        if (mid > a && mid < b && Math.abs(value(mid) - (va + (vb - va) * (mid - a) / (b - a))) > .25) {
            segment(a, mid); segment(mid, b);
        } else inside.push({at: a, pos: roundEven(value(a))});
    }
    for (let i = 1; i < times.length; ++i) segment(times[i - 1], times[i]);
    inside.push({at: end, pos: roundEven(value(end))});
    const outside = main.filter(a => a.at < start || a.at > end).map(a => ({...a}));
    // One-ms cut guards also prevent an empty/short main from changing everywhere.
    if (!width) {
        if (start > 0) outside.push({at: start - 1, pos: roundEven(evaluate(main, start - 1))});
        outside.push({at: end + 1, pos: roundEven(evaluate(main, end + 1))});
    }
    return [...new Map([...outside, ...inside].map(a => [a.at, a])).values()].sort((a, b) => a.at - b.at);
}

export function applyTrack(project, track, outputAxis, {start, end, method = "blend", blendMs = 200, whole = false} = {}) {
    const main = project.timeline.main[outputAxis], duration = roundEven(project.metadata.duration_ms);
    const coverage = trackCoverage(project, track);
    if (!whole && (start < coverage[0] || end > coverage[1])) throw new Error(`Select within this track’s analysis: ${(coverage[0] / 1000).toFixed(3)}–${(coverage[1] / 1000).toFixed(3)} s`);
    const script = whole ? copy(track.script) : {...project.scripts[outputAxis], actions:
        spliceActions(project.scripts[outputAxis].actions, track.script.actions, start, end, method, blendMs).filter(a => a.at <= duration)};
    start = whole ? 0 : Math.round(start); end = whole ? duration : Math.round(end);
    const regions = whole ? [] : main.regions.flatMap(region => {
        if (region.end <= start || region.start >= end) return [region];
        const pieces = [];
        if (region.start < start) pieces.push({...region, end: start});
        if (region.end > end) pieces.push({...region, start: end});
        return pieces;
    });
    regions.push({start, end, source: track.source, axis: track.axis, settings: copy(track.settings),
        name: track.name, join: whole ? "whole" : method, blend_ms: whole || method === "cut" ? 0 : Math.min(blendMs, (end - start) / 2)});
    project.scripts[outputAxis] = script;
    main.regions = regions.sort((a, b) => a.start - b.start); main.assembled = true;
    delete project.metrics[outputAxis];
}
