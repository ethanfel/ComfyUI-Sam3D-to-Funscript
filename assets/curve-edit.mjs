import {evaluate, roundEven, validateReference, reduceActions} from "./curve.mjs";

// Integrate the piecewise-linear script in time, so smoothing does not depend
// on how densely its author happened to place points. Outside values are held.
export function smoothActions(actions, start, end, windowMs, protectedTimes=[]) {
    validateReference({actions});
    if (![start, end, windowMs].every(Number.isFinite) || start < 0 || end <= start || windowMs <= 0) throw new Error("Select a nonempty range and a positive smoothing duration in ms.");
    start = roundEven(start); end = roundEven(end);
    if (end <= start) throw new Error("Select at least one millisecond to smooth.");
    const integral = [0], first = actions[0], last = actions.at(-1);
    for (let i = 1; i < actions.length; ++i) integral.push(integral[i - 1] + (actions[i].at - actions[i - 1].at) * (actions[i].pos + actions[i - 1].pos) / 2);
    const area = t => {
        if (t <= first.at) return (t - first.at) * first.pos;
        if (t >= last.at) return integral.at(-1) + (t - last.at) * last.pos;
        let lo = 0, hi = actions.length - 1;
        while (hi - lo > 1) {const mid = (lo + hi) >> 1; if (actions[mid].at <= t) lo = mid; else hi = mid;}
        return integral[lo] + (t - actions[lo].at) * (actions[lo].pos + evaluate(actions, t)) / 2;
    };
    const half = windowMs / 2, fade = Math.min(half, (end - start) / 2);
    const value = t => {
        const blend = Math.max(0, Math.min(1, (t - start) / fade, (end - t) / fade));
        const weight = blend * blend * (3 - 2 * blend), original = evaluate(actions, t);
        return original * (1 - weight) + (area(t + half) - area(t - half)) / windowMs * weight;
    };
    const knots = new Set([start, end]);
    const add = t => {for (const n of [Math.floor(t), Math.ceil(t)]) if (n > start && n < end) knots.add(n);};
    add(start + fade); add(end - fade);
    for (const point of actions) {add(point.at); add(point.at - half); add(point.at + half);}
    const times = [...knots].sort((a,b)=>a-b), inside = [];
    function segment(a, b) {
        const va = value(a), vb = value(b), mid = Math.floor((a+b)/2);
        const curved = [.25,.5,.75].some(f => Math.abs(value(a+(b-a)*f) - (va+(vb-va)*f)) > .25);
        if (mid > a && mid < b && curved) {segment(a,mid); segment(mid,b);}
        else inside.push({at:a,pos:roundEven(Math.max(0,Math.min(100,va)))});
    }
    for (let i=1;i<times.length;++i) segment(times[i-1],times[i]);
    inside.push({at:end,pos:roundEven(evaluate(actions,end))});
    return reduceActions([...actions.filter(p=>p.at<start),...inside,...actions.filter(p=>p.at>end)],
        {start,end,protectedTimes:[...protectedTimes,start+fade,end-fade]}).actions;
}
