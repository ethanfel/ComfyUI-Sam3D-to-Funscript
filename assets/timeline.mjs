import {AXES, evaluate, roundEven, validateReference, autoFitAxis, rebuildAxis} from "./curve.mjs";

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
    timeline.latest ??= Object.fromEntries(timeline.sources.map(s=>[s.input??s.id.split("@")[0],s.id]));
    for (const source of timeline.sources) {
        if (!sourceProject(project, source.id).times_ms?.length) throw new Error("Missing track pose data");
    }
    for (const track of timeline.tracks) {
        if (!AXES.includes(track.axis) || !sourceProject(project, track.source).scripts[track.axis]) throw new Error("Unknown track axis");
        if (track.window) windowProject(project, track.source, track.window);
        validateReference(track.script);
    }
    if (timeline.active !== "main" && !timeline.tracks.some(t => t.id === timeline.active)) timeline.active = "main";
    timeline.selection_track ??= timeline.active === "main" ? null : timeline.active;
    if (!timeline.tracks.some(t=>t.id===timeline.selection_track)) timeline.selection_track=null;
    timeline.selection ??= [0, 0];
    project.metrics ??= {};
    return timeline;
}

export function sourceChoices(project) {
    const latest=new Set(Object.values(project.timeline.latest));
    return project.timeline.sources.map(source=>{
        const input=source.input??source.id.split("@")[0],config=source.data.config;
        const label=`${input} · ${config.target_anchor.replaceAll("_"," ")} · person ${config.target_person}`;
        return {id:source.id,current:latest.has(source.id),label:latest.has(source.id)?`${label} · latest`:`${label} · saved ${source.id.split("@")[1]?.slice(0,8)??"original"}`};
    });
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

function nextTrackId(project) {
    let n = 0;
    while (project.timeline.tracks.some(t => t.id === `track_${n}`)) ++n;
    return `track_${n}`;
}

export function newTrack(project, source, axis) {
    const timeline = project.timeline, data = sourceProject(project, source);
    if (!data.scripts[axis]) axis = Object.keys(data.scripts)[0];
    const track = {id: nextTrackId(project), name: timeline.sources.find(s => s.id === source).label, source, axis,
        settings: copy(data.config.axis_settings[axis]), script: copy(data.scripts[axis])};
    timeline.tracks.push(track);
    return track;
}

export function assignTrack(project, track, source, axis) {
    if (track.locked) throw new Error("Unlock this track before changing its source or axis");
    const data = sourceProject(project, source);
    if (!data.scripts[axis]) axis = Object.keys(data.scripts)[0];
    if(!track.custom_name&&/^project_\d+ · .+ · person \d+(?: · updated)?$/.test(track.name)){
        const input=project.timeline.sources.find(s=>s.id===source).input??source.split("@")[0];
        track.name=`${input} · ${data.config.target_anchor.replaceAll("_"," ")} · person ${data.config.target_person}`;
    }
    track.source = source; track.axis = axis;
    track.settings = copy(data.config.axis_settings[axis]); track.script = copy(data.scripts[axis]);
    delete track.metrics;
    delete track.window;
    // A reassigned lane needs a fresh auto-direction cache; other lanes retain theirs.
    contexts.get(project)?.delete(track);
}

export function trackProject(project, track) {
    const source = windowProject(project, track.source, track.window);
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
    const source = windowProject(project, region.source, region.window);
    const data = cached(project, region, () => ({...source, config: {...source.config,
        axis_settings: {...source.config.axis_settings, [region.axis]: region.settings}}}));
    data.config.axis_settings[region.axis] = region.settings;
    return {data, axis: region.axis};
}

export function timelineState(project) {
    const {tracks, main, active, selection, selection_track} = project.timeline;
    return {tracks, main, active, selection, selection_track};
}

export function selectionTrack(project) {
    return project.timeline.tracks.find(t=>t.id===project.timeline.selection_track)??null;
}

export function selectionProblem(project, track, axis, whole=false) {
    if(!track)return "Choose a source row with Edit or Shift-drag its curve.";
    if(project.timeline.main[axis]?.locked)return `Main ${axis} is locked. Unlock it to copy a section.`;
    if(whole)return "";
    const [start,end]=project.timeline.selection,coverage=trackCoverage(project,track);
    if(![start,end].every(Number.isFinite)||end<=start)return "Shift-drag a time range or set In and Out.";
    if(start<coverage[0]||end>coverage[1])return `Select within this source: ${(coverage[0]/1000).toFixed(3)}–${(coverage[1]/1000).toFixed(3)} s.`;
    return "";
}

export function restoreTimeline(project, state) {
    Object.assign(project.timeline, state);
    contexts.delete(project);
}

export function trackCoverage(project, track) {
    const source = windowProject(project, track.source, track.window);
    return [Math.ceil(source.times_ms[0]), Math.floor(source.times_ms.at(-1))];
}

function windowProject(project, sourceId, window) {
    const source = sourceProject(project, sourceId);
    if (!window) return source;
    if (!Array.isArray(window) || window.length !== 2 || !window.every(Number.isFinite) || window[0] < 0 || window[1] <= window[0]) throw new Error("Select a nonempty time range for local fitting");
    return cached(project, `window:${sourceId}:${window[0]}:${window[1]}`, () => {
        const start = source.times_ms.findIndex(t => t >= window[0]);
        let end = source.times_ms.findIndex(t => t > window[1]);
        if (end < 0) end = source.times_ms.length;
        if (start < 0 || end - start < 2) throw new Error("Select at least two analysed frames for local fitting");
        const data = {...source, metadata: {...source.metadata, duration_ms: Math.min(window[1], source.metadata.duration_ms)}};
        for (const key of [...geometryFields, "valid", "raw", "processed"]) data[key] = source[key]?.slice(start, end);
        for (const key of ["mask_boxes", "timestamps"]) if (source.metadata[key]) data.metadata[key] = source.metadata[key].slice(start, end);
        data.metadata.analysed_start_ms = data.times_ms[0]; data.metadata.analysed_end_ms = data.times_ms.at(-1);
        data.orientation_hints = (source.orientation_hints || []).filter(h => h.end > start && h.start < end)
            .map(h => ({...h, start: Math.max(0, h.start - start), end: Math.min(end, h.end) - start}));
        // Subtract a local neutral from cached motion, never from the displayed
        // pose coordinates. Each valid span has its own origin across cuts/gaps.
        data.raw = data.raw.map(row => [...row]); data.processed = data.processed.map(row => [...row]);
        let first = null;
        for (let i = 0; i <= data.times_ms.length; ++i) {
            const good = i < data.times_ms.length && data.valid[i];
            const boundary = i > 0 && i < data.times_ms.length && (data.segments[i] !== data.segments[i - 1] || data.times_ms[i] - data.times_ms[i - 1] > source.config.max_gap_ms);
            if (first !== null && (!good || boundary)) {
                const origin = Array.from({length: 6}, (_, c) => {
                    const values = data.processed.slice(first, i).map(row => row[c]).filter(Number.isFinite).sort((a, b) => a - b);
                    return values.length ? (values[Math.floor((values.length - 1) / 2)] + values[Math.floor(values.length / 2)]) / 2 : 0;
                });
                for (const key of ["raw", "processed"]) for (let j = first; j < i; ++j) data[key][j] = data[key][j].map((v, c) => Number.isFinite(v) ? v - origin[c] : null);
                first = null;
            }
            if (good && first === null) first = i;
        }
        return data;
    });
}

export function fitSelectionTrack(project, track, window) {
    const coverage = trackCoverage(project, track);
    if (!Array.isArray(window) || window.length !== 2 || window[0] < coverage[0] || window[1] > coverage[1]) throw new Error(`Select within this track’s analysis: ${(coverage[0] / 1000).toFixed(3)}–${(coverage[1] / 1000).toFixed(3)} s`);
    const source = windowProject(project, track.source, window), axis = track.axis;
    const data = {...source, config: {...source.config, axis_settings: {...source.config.axis_settings, [axis]: copy(track.settings)}}};
    // A local section has already excluded the unrelated large movements.
    // Retain its complete filtered shape with 5–95 headroom, including peaks.
    data.config.axis_settings[axis] = autoFitAxis(data, axis, true);
    return {id: nextTrackId(project), name: `${track.name} · selection`, source: track.source, axis, window: [...window],
        settings: data.config.axis_settings[axis], script: rebuildAxis(data, axis)};
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
    if (main.locked) throw new Error("Unlock the main track before replacing its curve");
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
        ...(track.window ? {window: [...track.window]} : {}),
        name: track.name, join: whole ? "whole" : method, blend_ms: whole || method === "cut" ? 0 : Math.min(blendMs, (end - start) / 2)});
    project.scripts[outputAxis] = script;
    main.regions = regions.sort((a, b) => a.start - b.start); main.assembled = true;
    delete project.metrics[outputAxis];
}
