export const AXES = ["L0", "L1", "L2", "R0", "R1", "R2"];
export const SUFFIX = {L0: "", L1: ".surge", L2: ".sway", R0: ".twist", R1: ".roll", R2: ".pitch"};

// Python/NumPy-compatible rounding keeps preview regeneration equal to export.
export function roundEven(x) {
    const floor = Math.floor(x), fraction = x - floor;
    return fraction === 0.5 ? floor + (floor % 2 !== 0 ? 1 : 0) : Math.round(x);
}

export function evaluate(actions, time) {
    if (!actions?.length) return 50;
    if (time <= actions[0].at) return actions[0].pos;
    let low = 0, high = actions.length - 1;
    while (high - low > 1) {
        const mid = (low + high) >> 1;
        if (actions[mid].at <= time) low = mid; else high = mid;
    }
    const a = actions[low], b = actions[high];
    if (time >= b.at) return b.pos;
    return a.pos + (b.pos - a.pos) * (time - a.at) / (b.at - a.at);
}

export function validateReference(data) {
    if (!Array.isArray(data?.actions) || !data.actions.length) throw new Error("Reference needs an actions array");
    let previous=-1;
    for (const a of data.actions) {
        if (!Number.isInteger(a.at) || a.at<=previous || !Number.isInteger(a.pos) || a.pos<0 || a.pos>100) throw new Error("Reference actions require increasing integer milliseconds and positions 0–100");
        previous=a.at;
    }
    return data.actions.map(a=>({at:a.at,pos:a.pos}));
}

export function referenceAgreement(actions, reference, first, last) {
    const shift=reference.offset_ms||0, other=reference.actions;
    first=Math.max(first,other[0].at+shift); last=Math.min(last,other.at(-1).at+shift);
    if(last-first<100)return null;
    let count=0,absolute=0,squared=0,sx=0,sy=0,sxx=0,syy=0,sxy=0;
    for(let time=first;time<last;time+=20){
        const x=evaluate(actions,time),y=evaluate(other,time-shift),d=x-y;
        ++count;absolute+=Math.abs(d);squared+=d*d;sx+=x;sy+=y;sxx+=x*x;syy+=y*y;sxy+=x*y;
    }
    const vx=Math.max(0,sxx/count-(sx/count)**2),vy=Math.max(0,syy/count-(sy/count)**2);
    return {mae:absolute/count,rmse:Math.sqrt(squared/count),correlation:vx>1e-12&&vy>1e-12?(sxy/count-sx*sy/count**2)/Math.sqrt(vx*vy):null,samples:count};
}

export function simplify(times, values, tolerance) {
    const kept = new Set([0, times.length - 1]), stack = [[0, times.length - 1]];
    while (stack.length) {
        const [left, right] = stack.pop();
        let error = tolerance, split = -1;
        for (let i = left + 1; i < right; ++i) {
            const expected = values[left] + (values[right] - values[left]) * (times[i] - times[left]) / (times[right] - times[left]);
            const nextError = Math.abs(values[i] - expected);
            if (nextError > error) { error = nextError; split = i; }
        }
        if (split !== -1) { kept.add(split); stack.push([left, split], [split, right]); }
    }
    return [...kept].sort((a, b) => a - b);
}

export function rebuildAxis(project, axis) {
    const s = project.config.axis_settings[axis];
    const component = s.component + (axis.startsWith("R") ? 3 : 0);
    const times = project.times_ms.map(roundEven), runs = [];
    let start = null;
    for (let i = 0; i <= times.length; ++i) {
        const good = i < times.length && project.valid[i] && Number.isFinite(project.processed[i][component]);
        const boundary = i > 0 && i < times.length && (project.segments[i] !== project.segments[i - 1] || project.times_ms[i] - project.times_ms[i - 1] > project.config.max_gap_ms);
        if (start !== null && (!good || boundary)) { runs.push([start, i]); start = null; }
        if (good && start === null) start = i;
    }
    const actions = [];
    for (const [a, b] of runs) {
        const t = times.slice(a, b);
        const values = project.processed.slice(a, b).map(row => roundEven(Math.max(0, Math.min(100,
            s.center + row[component] / s.range * 100 * (s.invert ? -1 : 1)))));
        if (actions.length && t[0] > actions.at(-1).at + 1) actions.push({at: t[0] - 1, pos: actions.at(-1).pos});
        for (const i of simplify(t, values, project.config.tolerance)) actions.push({at: t[i], pos: values[i]});
    }
    if (!actions.length) throw new Error("No usable samples for this axis");
    if (actions[0].at > 0) actions.unshift({at: 0, pos: actions[0].pos});
    const end = roundEven(project.metadata.duration_ms);
    if (end > actions.at(-1).at) actions.push({at: end, pos: actions.at(-1).pos});
    return {version: "1.0", inverted: false, range: 100, actions};
}

// Small dependency-free ZIP writer (stored entries, UTF-8 filenames).
export function makeZip(files) {
    const encoder = new TextEncoder(), parts = [], directory = [];
    let offset = 0;
    const crc32 = bytes => {
        let crc = -1;
        for (const byte of bytes) {
            crc ^= byte;
            for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
        }
        return (crc ^ -1) >>> 0;
    };
    for (const [filename, content] of Object.entries(files)) {
        const name = encoder.encode(filename), data = encoder.encode(content), crc = crc32(data);
        const local = new Uint8Array(30 + name.length), view = new DataView(local.buffer);
        view.setUint32(0, 0x04034b50, true); view.setUint16(4, 20, true); view.setUint16(6, 0x800, true);
        view.setUint32(14, crc, true); view.setUint32(18, data.length, true); view.setUint32(22, data.length, true);
        view.setUint16(26, name.length, true); local.set(name, 30);
        const central = new Uint8Array(46 + name.length), cv = new DataView(central.buffer);
        cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x800, true);
        cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true);
        cv.setUint16(28, name.length, true); cv.setUint32(42, offset, true); central.set(name, 46);
        parts.push(local, data); directory.push(central); offset += local.length + data.length;
    }
    const end = new Uint8Array(22), view = new DataView(end.buffer);
    view.setUint32(0, 0x06054b50, true); view.setUint16(8, directory.length, true); view.setUint16(10, directory.length, true);
    view.setUint32(12, directory.reduce((n, a) => n + a.length, 0), true); view.setUint32(16, offset, true);
    return new Blob([...parts, ...directory, end], {type: "application/zip"});
}
