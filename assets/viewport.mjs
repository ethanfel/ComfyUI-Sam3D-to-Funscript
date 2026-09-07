// Timeline navigation operates in original video milliseconds; it never retimes actions.
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
export function timelineView(duration, view = {}) {
    duration = Math.max(1, Number(duration) || 1);
    const span = clamp(Number.isFinite(view.span_ms) ? view.span_ms : 30000, Math.min(250, duration), duration);
    return {start_ms: clamp(Number(view.start_ms) || 0, 0, duration - span), span_ms: span, follow: view.follow !== false};
}
export function zoomView(duration, view, span, anchor = view.start_ms + view.span_ms / 2) {
    const fraction = clamp((anchor - view.start_ms) / view.span_ms, 0, 1);
    const next = timelineView(duration, {...view, span_ms: span});
    return timelineView(duration, {...next, start_ms: anchor - fraction * next.span_ms});
}
export function panView(duration, view, start) {
    return timelineView(duration, {...view, start_ms: start, follow: false});
}
export function followView(duration, view, time, center = false) {
    if (!center && time >= view.start_ms && time < view.start_ms + view.span_ms) return view;
    return timelineView(duration, {...view, start_ms: time - view.span_ms * (center ? .5 : .1)});
}
export function sliderSpan(duration, value) {
    const minimum = Math.min(250, duration);
    return duration * (minimum / duration) ** (clamp(value, 0, 1000) / 1000);
}
export function spanSlider(duration, span) {
    const minimum = Math.min(250, duration);
    return duration <= minimum ? 0 : clamp(Math.log(span / duration) / Math.log(minimum / duration) * 1000, 0, 1000);
}
export function formatTime(ms, decimals = 0, hours = false) {
    const scale = 10 ** decimals, units = Math.max(0, Math.round(ms / 1000 * scale));
    const seconds = Math.floor(units / scale), h = Math.floor(seconds / 3600), m = Math.floor(seconds / 60) % 60;
    const tail = String(seconds % 60).padStart(2, '0') + (decimals ? '.' + String(units % scale).padStart(decimals, '0') : '');
    return (hours || h ? `${h}:${String(m).padStart(2, '0')}` : String(m)) + ':' + tail;
}
export function rulerTicks(start, end, width, duration = end) {
    const desired = (end - start) / Math.max(1, Math.floor(width / (duration >= 3600000 ? 105 : 82)));
    const steps = [1,2,5,10,20,50,100,200,500,1000,2000,5000,10000,15000,30000,60000,120000,300000,600000,900000,1800000,3600000];
    const step = steps.find(v => v >= desired) || Math.ceil(desired / 3600000) * 3600000;
    const ticks = [], decimals = step < 1000 ? (step < 10 ? 3 : step < 100 ? 2 : 1) : 0;
    for (let t = Math.ceil(start / step) * step; t <= end; t += step) ticks.push({time: t, label: formatTime(t, decimals, duration >= 3600000)});
    return ticks;
}
export function lowerTime(length, timeAt, time) {
    let low = 0, high = length;
    while (low < high) {const mid = Math.floor((low + high) / 2); if (timeAt(mid) < time) low = mid + 1; else high = mid;}
    return low;
}
export function visibleRange(length, timeAt, start, end) {
    return [Math.max(0, lowerTime(length, timeAt, start) - 1), Math.min(length, lowerTime(length, timeAt, end) + 1)];
}
// Display-only envelope: retain first/last and extrema in each horizontal pixel.
// Null samples and segment boundaries break paths even at overview scale.
export function displayIndices(length, timeAt, valueAt, start, end, width, breakAt = () => false) {
    const [first, stop] = visibleRange(length, timeAt, start, end), indices = [];
    if (stop - first <= width * 2) return Array.from({length: stop - first}, (_, i) => first + i);
    let bucket = null, group = [];
    function flush() {
        if (!group.length) return;
        let low = group[0], high = group[0];
        for (const i of group) {if (valueAt(i) < valueAt(low)) low = i; if (valueAt(i) > valueAt(high)) high = i;}
        indices.push(...[...new Set([group[0], low, high, group.at(-1)])].sort((a, b) => a - b)); group = [];
    }
    for (let i = first; i < stop; ++i) {
        const pixel = Math.floor((timeAt(i) - start) / Math.max(1, end - start) * width);
        if (pixel !== bucket || breakAt(i) || !Number.isFinite(valueAt(i))) {flush(); bucket = pixel;}
        if (!Number.isFinite(valueAt(i))) {if (indices.at(-1) !== null) indices.push(null);}
        else group.push(i);
    }
    flush(); return indices;
}
