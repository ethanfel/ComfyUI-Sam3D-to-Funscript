import {evaluate, roundEven, validateReference, reduceActions} from "./curve.mjs";

// Shape names/formulas from the user-supplied Pattern_Generation/main.lua
// (Pattern Generator by Nerfarious837). Editor integration is independent of OFS.
export const PATTERNS = ["Heartbeat", "Jigsaw", "Jigsaw Squiggle", "Pulse", "Ramp Down", "Ramp Up", "Random", "River Bed Center", "River Bed High", "River Bed Low", "Sine Squiggle", "Sine Wave", "Square", "Triangle"];
const TAU = 2 * Math.PI, clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ease = u => u * u * (3 - 2 * u);
const wrap = p => ((p + Math.PI) % TAU + TAU) % TAU - Math.PI;
function range(actions, start, end) {
    validateReference({actions});
    if (![start, end].every(Number.isFinite) || start < 0 || end <= start) throw new Error("Select a nonempty time range.");
    start = roundEven(start); end = roundEven(end);
    if (end <= start) throw new Error("Select at least one millisecond.");
    return [start, end];
}
function number(value, name, min, max) {
    if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${name} must be between ${min} and ${max}.`);
    return value;
}
function slope(actions, at, side) {
    let lo = 0, hi = actions.length;
    while (lo < hi) {const m = (lo + hi) >> 1; if (actions[m].at < at || (side > 0 && actions[m].at === at)) lo = m + 1; else hi = m;}
    if (!lo || lo === actions.length) return 0;
    const a = actions[lo - 1], b = actions[lo];
    return (b.pos - a.pos) / (b.at - a.at);
}
function hermite(a, b, ma, mb, u) {
    return (2*u**3-3*u*u+1)*a + (u**3-2*u*u+u)*ma + (-2*u**3+3*u*u)*b + (u**3-u*u)*mb;
}
// Limit joining tangents to keep each join between its endpoints. The rest of
// the generated oscillation is untouched. No samples inside the bad gap are used.
function join(a, b, ma, mb, u) {
    const delta = b - a;
    if (!delta) return a;
    ma = clamp(ma / delta, 0, 3) * delta; mb = clamp(mb / delta, 0, 3) * delta;
    const norm = Math.hypot(ma / delta, mb / delta);
    if (norm > 3) {ma *= 3 / norm; mb *= 3 / norm;}
    return hermite(a, b, ma, mb, u);
}
function replace(actions, start, end, value, joinMs, stepMs, protectedTimes=[]) {
    number(joinMs, "Join duration (ms)", 0, 60000); number(stepMs, "Point spacing (ms)", 1, 1000);
    const width = Math.min(joinMs, (end - start) / 2);
    const count = Math.ceil((end - start) / stepMs);
    if (count > 100000) throw new Error("This preview would exceed 100,000 points. Use a shorter interval, a slower cycle or larger point spacing.");
    const boundary = [evaluate(actions, start), evaluate(actions, end)];
    const derivative = t => {const a=Math.max(start,t-.5),b=Math.min(end,t+.5);return (value(b)-value(a))/(b-a);};
    const at = t => {
        if (width && t === start) return boundary[0];
        if (width && t === end) return boundary[1];
        if (width && t < start + width) return join(boundary[0], value(start + width), slope(actions,start,-1)*width, derivative(start+width)*width, (t-start)/width);
        if (width && t > end - width) return join(value(end-width), boundary[1], derivative(end-width)*width, slope(actions,end,1)*width, (t-end+width)/width);
        return value(t);
    };
    const times = new Set([start, end, roundEven(start + width), roundEven(end - width)]);
    for (let i = 1; i < count; i++) times.add(roundEven(start + i * (end-start) / count));
    const inside = [...times].sort((a,b)=>a-b).map(t => ({at:t, pos:roundEven(clamp(at(t),0,100))}));
    const before=actions.filter(p=>p.at<start),after=actions.filter(p=>p.at>end);
    // With blending disabled, the pattern owns both boundary values. Put the
    // return to surrounding motion immediately outside, instead of letting a
    // long interpolation change unselected motion. Funscripts use integer ms.
    if(!width){
        if(before.length&&before.at(-1).at<start-1)before.push({at:start-1,pos:roundEven(evaluate(actions,start-1))});
        if(after.length&&after[0].at>end+1)after.unshift({at:end+1,pos:roundEven(evaluate(actions,end+1))});
    }
    const cleaned=reduceActions([...before,...inside,...after],{start,end,protectedTimes:[...protectedTimes,start+width,end-width]}).actions;
    return {actions:cleaned,inside:cleaned.filter(p=>p.at>=start&&p.at<=end)};
}
function random(seed, index) {
    let x = (seed ^ Math.imul(index + 1, 0x9e3779b9)) >>> 0;
    x = Math.imul(x ^ x >>> 16, 0x21f0aaad); x = Math.imul(x ^ x >>> 15, 0x735a2d97);
    return ((x ^ x >>> 15) >>> 0) / 4294967296;
}
export function generatePattern(actions, start, end, options = {}) {
    [start,end] = range(actions,start,end);
    const {shape="Sine Wave", cycleMs=2000, amplitude=40, center=50, fadeInMs=0, fadeOutMs=0, reverse=false, seed=1, stepMs=20, joinMs=0} = options;
    if (!PATTERNS.includes(shape)) throw new Error("Choose a known pattern.");
    number(cycleMs,"Cycle length (ms)",200,60000); number(amplitude,"Amplitude",0,50); number(center,"Center",0,100);
    number(fadeInMs,"Fade in (ms)",0,60000); number(fadeOutMs,"Fade out (ms)",0,60000); number(seed,"Random seed",0,4294967295);
    number(stepMs,"Point spacing (ms)",1,1000);
    const spacing=Math.min(stepMs,cycleMs/96), duration=end-start;
    let clipped=0, samples=0;
    const value = at => {
        const t=at-start, c=t/cycleMs, phase=c-Math.floor(c);
        let v;
        switch (shape) {
        case "Heartbeat": case "Sine Wave": v=Math.sin(c*TAU); break;
        case "Jigsaw": v=phase*2-1; break;
        case "Jigsaw Squiggle": v=phase*2-1+Math.sin(c*16)*.35; break;
        case "Pulse": v=Math.sin(c*24)>0?1:-1; break;
        case "Ramp Down": v=.9-t/duration*1.8; break;
        case "Ramp Up": v=t/duration*1.8-.9; break;
        case "Random": v=(random(seed,Math.floor(t/stepMs))-.5)*1.6; break;
        case "River Bed Center": v=Math.sin(c*1.8)*.7+Math.sin(c*44)*.28; break;
        case "River Bed High": v=Math.sin(c*1.4)*.55+.65+Math.sin(c*36)*.25; break;
        case "River Bed Low": v=Math.sin(c*1.4)*.55-.65+Math.sin(c*36)*.25; break;
        case "Sine Squiggle": v=Math.sin(c*TAU)+Math.sin(c*14)*.4; break;
        case "Square": v=Math.sin(c*12)>0?1:-1; break;
        case "Triangle": v=(1-Math.abs(phase*2-1))*2-1; break;
        }
        const fade=Math.min(1,fadeInMs?t/fadeInMs:1,fadeOutMs?(duration-t)/fadeOutMs:1);
        const pos=center+(reverse?-1:1)*amplitude*v*clamp(fade,0,1);
        samples++; if(pos<0||pos>100)clipped++;
        return clamp(pos,0,100);
    };
    const result=replace(actions,start,end,value,joinMs,spacing,options.protectedTimes);
    const edges=joinMs?`${Math.min(joinMs,duration/2)} ms blends inside selection edges`:"full selection · no edge blend";
    return {...result, summary:`${shape} · ${(cycleMs/1000).toFixed(3)} s cycle control · ${edges} · ${result.inside.length} points${clipped?` · ${(clipped/samples*100).toFixed(1)}% of samples clipped; reduce amplitude or move center`:""}`};
}

// Save only the replaced interval, including the possible one-ms cut guards.
// Keeping original points (rather than evaluated endpoints) makes removal exact
// even when the old curve had no points at either selection edge.
export function rememberPattern(patterns, actions, start, end, name) {
    [start,end]=range(actions,start,end);
    let n=0;while(patterns.some(p=>p.id===`pattern_${n}`))++n;
    return [...patterns,{id:`pattern_${n}`,name,start,end,
        before:actions.filter(p=>p.at>=start-1&&p.at<=end+1).map(p=>({...p}))}];
}
export function patternRemovalProblem(patterns, id) {
    const index=patterns.findIndex(p=>p.id===id);
    if(index<0)return "Choose an applied pattern on this curve.";
    const selected=patterns[index];
    if(patterns.slice(index+1).some(p=>p.start-1<=selected.end+1&&p.end+1>=selected.start-1))
        return "Remove the newer overlapping pattern first to preserve its original section.";
    return "";
}
export function removePattern(actions, patterns, id) {
    const problem=patternRemovalProblem(patterns,id);if(problem)throw new Error(problem);
    const selected=patterns.find(p=>p.id===id);
    const restored=[...actions.filter(p=>p.at<selected.start-1||p.at>selected.end+1),...selected.before]
        .map(p=>({...p})).sort((a,b)=>a.at-b.at);
    validateReference({actions:restored});
    return {actions:restored,patterns:patterns.filter(p=>p.id!==id),name:selected.name};
}

function solve(matrix, vector) {
    const a=matrix.map((row,i)=>[...row,vector[i]]), n=vector.length;
    for(let k=0;k<n;k++){
        let pivot=k;for(let i=k+1;i<n;i++)if(Math.abs(a[i][k])>Math.abs(a[pivot][k]))pivot=i;
        [a[k],a[pivot]]=[a[pivot],a[k]];if(Math.abs(a[k][k])<1e-8)return null;
        const d=a[k][k];for(let j=k;j<=n;j++)a[k][j]/=d;
        for(let i=0;i<n;i++)if(i!==k){const f=a[i][k];for(let j=k;j<=n;j++)a[i][j]-=f*a[k][j];}
    }
    return a.map(row=>row[n]);
}
function rhythm(actions, boundary, side, contextMs, cycleMs) {
    const start=Math.max(actions[0].at,side<0?boundary-contextMs:boundary), end=Math.min(actions.at(-1).at,side<0?boundary:boundary+contextMs);
    const duration=end-start;
    if(duration<(cycleMs?200:320))return null;
    const n=Math.min(2048,Math.floor(duration/10)), step=duration/n;
    const values=Array.from({length:n+1},(_,i)=>evaluate(actions,start+i*step));
    const mean=values.reduce((s,v)=>s+v,0)/values.length;
    let trend=0,denom=0;for(let i=0;i<=n;i++){trend+=(i-n/2)*(values[i]-mean);denom+=(i-n/2)**2;}trend/=denom;
    const detrended=values.map((v,i)=>v-mean-trend*(i-n/2));
    const energy=detrended.reduce((s,v)=>s+v*v,0)/values.length;
    if(energy<4)return null;
    let period=cycleMs, agreement=1;
    if(!period){
        const scores=[];
        for(let lag=Math.max(2,Math.ceil(160/step));lag<=Math.floor(n/2);lag++){
            let sx=0,sy=0,xx=0,yy=0,xy=0;
            for(let i=lag;i<=n;i++){
                const x=detrended[i],y=detrended[i-lag];sx+=x;sy+=y;xx+=x*x;yy+=y*y;xy+=x*y;
            }
            // Removing a trend offsets the two overlapping windows. Compare
            // their centered shapes so even two clean cycles can agree.
            const count=n+1-lag,power=Math.sqrt(Math.max(0,xx-sx*sx/count)*Math.max(0,yy-sy*sy/count));
            scores[lag]=power>1e-9?(xy-sx*sy/count)/power:0;
        }
        const peaks=[];
        for(let lag=1;lag<scores.length;lag++)if(scores[lag]>.65&&scores[lag]>=(scores[lag-1]??-1)&&scores[lag]>=(scores[lag+1]??-1))peaks.push(lag);
        if(!peaks.length)return null;
        const best=Math.max(...peaks.map(i=>scores[i]));
        const lag=peaks.find(i=>scores[i]>=best-.04);
        const a=scores[lag-1]??scores[lag], b=scores[lag], c=scores[lag+1]??scores[lag];
        const shift=Number.isFinite(scores[lag-1])&&Number.isFinite(scores[lag+1])
            ?clamp((a-c)/(2*(a-2*b+c)||1),-.5,.5):0;
        period=(lag+shift)*step;agreement=b;
    }
    if(duration<period*(cycleMs?1:1.5))return null;
    const omega=TAU/period;
    const row = t => [1,(t-boundary)/contextMs,...[1,2,3].flatMap(k=>[Math.sin(k*omega*(t-boundary)),Math.cos(k*omega*(t-boundary))])];
    const matrix=Array.from({length:8},()=>Array(8).fill(0)), rhs=Array(8).fill(0);
    for(let i=0;i<=n;i++){const r=row(start+i*step);for(let a=0;a<8;a++){rhs[a]+=r[a]*values[i];for(let b=0;b<8;b++)matrix[a][b]+=r[a]*r[b];}}
    const coefficients=solve(matrix,rhs);if(!coefficients)return null;
    const errors=values.reduce((s,v,i)=>s+(v-row(start+i*step).reduce((sum,x,k)=>sum+x*coefficients[k],0))**2,0)/values.length;
    const quality=clamp(Math.min(agreement,1-errors/energy),0,1);
    const amplitude=[0,1,2].map(k=>Math.hypot(coefficients[2+2*k],coefficients[3+2*k]));
    const phase=[0,1,2].map(k=>Math.atan2(coefficients[3+2*k],coefficients[2+2*k]));
    if(quality<.55||amplitude[0]<2)return null;
    return {period,omega,quality,center:coefficients[0],amplitude,phase};
}

function surroundingRhythm(actions, boundary, side, contextMs, cycleMs, bounds) {
    const start=Math.max(actions[0].at,bounds[0],side<0?boundary-contextMs:boundary);
    const end=Math.min(actions.at(-1).at,bounds[1],side<0?boundary:boundary+contextMs);
    const duration=Math.max(0,end-start),edge=side<0?end:start;
    if(duration<(cycleMs?200:320))return {duration,reason:'not enough context'};
    const full=rhythm(actions,edge,side,duration,cycleMs);
    let best=full?{...full,start,end,offset:Math.abs(edge-boundary),score:full.quality}:null;
    // A quiet tail or a change of pace can hide a useful rhythm elsewhere in
    // the requested window. Search only outside the selection, and require a
    // stronger fit for these shorter windows to avoid accepting incidental noise.
    if(!full||full.quality<.85){
        for(const fraction of [.75,.5,.375,.25]){
            const length=duration*fraction;
            if(length<640||cycleMs&&length<cycleMs)continue;
            for(const position of [0,.25,.5,.75,1]){
                const offset=(duration-length)*position,localEdge=edge+side*offset;
                const found=rhythm(actions,localEdge,side,length,cycleMs);
                if(!found||found.quality<.8)continue;
                const score=found.quality-.12*offset/duration-.04*(1-fraction);
                if(!best||score>best.score)best={...found,score,offset:Math.abs(localEdge-boundary),
                    start:side<0?localEdge-length:localEdge,end:side<0?localEdge:localEdge+length};
            }
        }
    }
    if(!best){
        const values=Array.from({length:65},(_,i)=>evaluate(actions,start+duration*i/64));
        return {duration,reason:Math.max(...values)-Math.min(...values)<4?'flat motion':'no consistent cycle'};
    }
    const fittedBoundary=side<0?best.end:best.start;
    best.phase=best.phase.map((phase,k)=>phase+(k+1)*best.omega*(boundary-fittedBoundary));
    return {duration,rhythm:best};
}
export function continuePattern(actions, start, end, options = {}) {
    [start,end]=range(actions,start,end);
    const {contextMs=4000, cycleMs=0, side="both", joinMs=150, stepMs=20}=options;
    number(contextMs,"Surrounding context (ms)",500,30000);number(cycleMs,"Cycle override (ms; 0 = auto)",0,60000);
    number(stepMs,"Point spacing (ms)",1,1000);
    if(cycleMs&&cycleMs<200)throw new Error("Cycle override must be zero (auto) or at least 200 ms.");
    if(!["both","before","after"].includes(side))throw new Error("Choose before, after or both sides.");
    const bounds=options.contextBounds??[actions[0].at,actions.at(-1).at];
    if(!Array.isArray(bounds)||bounds.length!==2||!bounds.every(Number.isFinite)||bounds[1]<bounds[0])throw new Error('Invalid surrounding motion bounds.');
    // Only the two surrounding windows participate in rhythm estimation.
    const contexts={};
    if(side!=="after")contexts.before=surroundingRhythm(actions,start,-1,contextMs,cycleMs,bounds);
    if(side!=="before")contexts.after=surroundingRhythm(actions,end,1,contextMs,cycleMs,bounds);
    let left=contexts.before?.rhythm,right=contexts.after?.rhythm;
    const found=Object.entries(contexts).filter(([,context])=>context.rhythm).map(([side,{rhythm:r}])=>
        `${side} ${(r.period/1000).toFixed(3)} s (${Math.round(r.quality*100)}% rhythm fit; context ${(r.start/1000).toFixed(3)}–${(r.end/1000).toFixed(3)} s)`);
    if(!left&&!right){
        const details=Object.entries(contexts).map(([side,c])=>`${side}: ${(c.duration/1000).toFixed(2)} s, ${c.reason}`).join('; ');
        const advice=Object.values(contexts).every(c=>c.duration<(cycleMs?200:320))
            ?'Select a smaller gap with motion outside it, or use Generate pattern for the whole selection.'
            :'Choose context containing a full repeated movement, set a known cycle length, or use Generate pattern.';
        throw new Error(`No repeating motion found outside this range (${details}). ${advice}`);
    }
    const duration=end-start;
    if(!left)left={...right,phase:right.phase.map((p,k)=>p-(k+1)*right.omega*duration)};
    if(!right)right={...left,phase:left.phase.map((p,k)=>p+(k+1)*left.omega*duration)};
    const a=left.phase[0], expected=a+duration*(left.omega+right.omega)/2;
    let b=right.phase[0]+TAU*Math.round((expected-right.phase[0])/TAU);
    while(b<=a)b+=TAU;
    // Interpolate phase (not opposite wave values), preserving oscillation
    // amplitude while joining rhythms with different rates/phase at either end.
    const value=t=>{
        const u=(t-start)/duration, weight=ease(u);
        const phase=join(a,b,left.omega*duration,right.omega*duration,u);
        let v=left.center+(right.center-left.center)*weight;
        for(let k=0;k<3;k++){
            const amplitude=left.amplitude[k]+(right.amplitude[k]-left.amplitude[k])*weight;
            const p=wrap(left.phase[k]-(k+1)*left.phase[0]), q=wrap(right.phase[k]-(k+1)*right.phase[0]);
            v+=amplitude*Math.sin((k+1)*phase+p+wrap(q-p)*weight);
        }
        return clamp(v,0,100);
    };
    const result=replace(actions,start,end,value,joinMs,Math.min(stepMs,left.period/64,right.period/64),options.protectedTimes);
    return {...result, summary:`Continued ${found.join(" · ")}. Synthesized motion; review the join.`, periods:found,
        context:contexts,quality:Math.min(left.quality,right.quality)};
}
