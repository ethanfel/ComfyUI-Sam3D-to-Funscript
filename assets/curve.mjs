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

const dot = (a,b) => a.reduce((sum,x,i)=>sum+x*b[i],0);
const length = v => Math.sqrt(dot(v,v));
const identity = () => [[1,0,0],[0,1,0],[0,0,1]];
function percentile(values, q) {
    const sorted=[...values].sort((a,b)=>a-b), index=(sorted.length-1)*q, low=Math.floor(index);
    return sorted[low]+(sorted[Math.min(low+1,sorted.length-1)]-sorted[low])*(index-low);
}
export function bodyFrame(points) {
    if(!points||![5,6,9,10].every(i=>points[i]?.every(Number.isFinite)))return null;
    const right=points[10].map((v,i)=>v-points[9][i]);
    let up=points[5].map((v,i)=>(v+points[6][i]-points[9][i]-points[10][i])/2);
    const r=length(right);if(r<1e-5)return null;
    for(let i=0;i<3;i++)right[i]/=r;
    const along=dot(up,right);up=up.map((v,i)=>v-along*right[i]);
    const u=length(up);if(u<1e-5)return null;up=up.map(v=>v/u);
    const forward=[right[1]*up[2]-right[2]*up[1],right[2]*up[0]-right[0]*up[2],right[0]*up[1]-right[1]*up[0]];
    return [right,up,forward];
}
function orientationAt(project,start) {
    const hint=project.orientation_hints?.find(h=>h.start===start);
    if(hint)return {axes:hint.axes,orientation:"body"};
    // Older projects already retain the pose geometry; no extraction is needed.
    const frame=bodyFrame(project.points?.[start]?.[project.config.target_person]);
    if(!frame)return {axes:identity(),orientation:"camera"};
    let axes=[frame[1],frame[2],frame[0].map(v=>-v)];
    if(project.config.frame==="reference_body"){
        const reference=bodyFrame(project.points?.[start]?.[project.config.reference_person]);
        if(!reference)return {axes:identity(),orientation:"camera"};
        axes=axes.map(v=>reference.map(a=>dot(a,v)));
    }
    return {axes:axes.map(v=>[v[1]*(project.config.frame==="reference_body"?1:-1),v[2],-v[0]]),orientation:"body"};
}
function covariance(values) {
    const mean=[0,1,2].map(i=>values.reduce((s,v)=>s+v[i],0)/values.length);
    let centered=values.map(v=>v.map((x,i)=>x-mean[i]));
    const lengths=centered.map(length),cap=percentile(lengths,.9);
    centered=centered.map((v,i)=>v.map(x=>x*Math.min(1,cap/Math.max(lengths[i],1e-30))));
    return [0,1,2].map(i=>[0,1,2].map(j=>centered.reduce((s,v)=>s+v[i]*v[j],0)/values.length));
}
function principal(cov) {
    // Jacobi eigensolver for a real symmetric 3 × 3 covariance matrix.
    const a=cov.map(row=>[...row]),vectors=identity();
    for(let step=0;step<32;step++){
        let p=0,q=1;
        for(const [i,j]of [[0,2],[1,2]])if(Math.abs(a[i][j])>Math.abs(a[p][q]))[p,q]=[i,j];
        if(Math.abs(a[p][q])<=Math.max(1e-30,(a[0][0]+a[1][1]+a[2][2])*1e-14))break;
        const angle=.5*Math.atan2(2*a[p][q],a[q][q]-a[p][p]),c=Math.cos(angle),s=Math.sin(angle);
        const app=a[p][p],aqq=a[q][q],apq=a[p][q];
        a[p][p]=c*c*app-2*s*c*apq+s*s*aqq;a[q][q]=s*s*app+2*s*c*apq+c*c*aqq;a[p][q]=a[q][p]=0;
        for(let i=0;i<3;i++){
            if(i!==p&&i!==q){const aip=a[i][p],aiq=a[i][q];a[i][p]=a[p][i]=c*aip-s*aiq;a[i][q]=a[q][i]=s*aip+c*aiq;}
            const vip=vectors[i][p],viq=vectors[i][q];vectors[i][p]=c*vip-s*viq;vectors[i][q]=s*vip+c*viq;
        }
    }
    let index=0;for(let i=1;i<3;i++)if(a[i][i]>a[index][index])index=i;
    return {value:a[index][index],direction:vectors.map(row=>row[index])};
}
function dominantDirection(times, values, axes) {
    let samples=values,lag=1;
    if(times.length>1){
        const step=Math.max(1000/30,percentile(times.slice(1).map((t,i)=>t-times[i]),.5));
        const count=Math.max(2,Math.floor((times.at(-1)-times[0])/step)+1),interval=(times.at(-1)-times[0])/(count-1);
        samples=[];let left=0;
        for(let i=0;i<count;i++){
            const t=times[0]+i*interval;
            while(left<times.length-2&&times[left+1]<t)left++;
            const fraction=Math.max(0,Math.min(1,(t-times[left])/(times[left+1]-times[left])));
            samples.push(values[left].map((v,j)=>v+(values[left+1][j]-v)*fraction));
        }
        lag=Math.min(count-1,Math.max(1,Math.floor(200/interval+.5)));
    }
    const positions=covariance(samples),trace=c=>c[0][0]+c[1][1]+c[2][2];
    let cov=samples.length-lag>=4?covariance(samples.slice(lag).map((v,i)=>v.map((x,j)=>x-samples[i][j]))):positions;
    if(trace(cov)<=Math.max(1e-24,trace(positions)*1e-8))cov=positions;
    const total=trace(cov);
    if(total<=1e-24)return {direction:axes[0],share:0,mode:"still"};
    const eigen=principal(cov);let direction=eigen.direction,mode="dominant";
    const energy=v=>dot(v,cov.map(row=>dot(row,v)));
    if(eigen.value/total<.55){
        direction=axes[0];for(const axis of axes.slice(1))if(energy(axis)>energy(direction))direction=axis;
        mode="body_fallback";
    }else{
        const alignments=axes.map(axis=>dot(axis,direction));let index=0;
        for(let i=1;i<3;i++)if(Math.abs(alignments[i])>Math.abs(alignments[index]))index=i;
        if(alignments[index]<0)direction=direction.map(v=>-v);
    }
    return {direction,share:Math.max(0,Math.min(1,energy(direction)/total)),mode};
}
const automaticCache=new WeakMap();
export function motionForAxis(project, axis, component=project.config.axis_settings[axis].component) {
    const offset=axis.startsWith("R")?3:0;
    if(component!=="auto")return {raw:project.raw.map(row=>row[component+offset]),processed:project.processed.map(row=>row[component+offset]),spans:[]};
    let cache=automaticCache.get(project);
    if(!cache||cache.source!==project.processed||cache.gap!==project.config.max_gap_ms){cache={source:project.processed,gap:project.config.max_gap_ms};automaticCache.set(project,cache);}
    if(cache[offset])return cache[offset];
    const output={raw:Array(project.times_ms.length).fill(null),processed:Array(project.times_ms.length).fill(null),spans:[]};
    let start=null;
    for(let i=0;i<=project.times_ms.length;i++){
        const good=i<project.times_ms.length&&project.valid[i]&&project.processed[i].slice(offset,offset+3).every(Number.isFinite);
        const boundary=i>0&&i<project.times_ms.length&&(project.segments[i]!==project.segments[i-1]||project.times_ms[i]-project.times_ms[i-1]>project.config.max_gap_ms);
        if(start!==null&&(!good||boundary)){
            const orientation=orientationAt(project,start);
            const report={start,end:i,...dominantDirection(project.times_ms.slice(start,i),project.processed.slice(start,i).map(row=>row.slice(offset,offset+3)),orientation.axes),orientation:orientation.orientation};
            output.spans.push(report);
            for(let j=start;j<i;j++)for(const key of ["raw","processed"])output[key][j]=dot(project[key][j].slice(offset,offset+3),report.direction);
            start=null;
        }
        if(good&&start===null)start=i;
    }
    cache[offset]=output;return output;
}
export function autoFitAxis(project,axis) {
    const source=motionForAxis(project,axis,"auto").processed.filter(Number.isFinite);
    if(!source.length)throw new Error("No usable samples for automatic fitting");
    const low=percentile(source,.05),high=percentile(source,.95),midpoint=(low+high)/2;
    const range=Math.ceil(Math.max(axis.startsWith("R")?10:.04,(high-low)/.8,2*Math.abs(midpoint))*1e6)/1e6;
    const invert=project.config.axis_settings[axis].invert;
    const center=Math.floor(Math.max(0,Math.min(100,50-midpoint/range*100*(invert?-1:1)))*1000+.5)/1000;
    return {...project.config.axis_settings[axis],component:"auto",auto_fit:true,range,center};
}

export function rebuildAxis(project, axis) {
    const s = project.config.axis_settings[axis];
    const source = motionForAxis(project,axis).processed;
    const times = project.times_ms.map(roundEven), runs = [];
    let start = null;
    for (let i = 0; i <= times.length; ++i) {
        const good = i < times.length && project.valid[i] && Number.isFinite(source[i]);
        const boundary = i > 0 && i < times.length && (project.segments[i] !== project.segments[i - 1] || project.times_ms[i] - project.times_ms[i - 1] > project.config.max_gap_ms);
        if (start !== null && (!good || boundary)) { runs.push([start, i]); start = null; }
        if (good && start === null) start = i;
    }
    const actions = [];
    for (const [a, b] of runs) {
        const t = times.slice(a, b);
        const values = source.slice(a, b).map(value => roundEven(Math.max(0, Math.min(100,
            s.center + value / s.range * 100 * (s.invert ? -1 : 1)))));
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
