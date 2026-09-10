export function correctedMotion(times, shifts, valid, anchor, sections) {
    const output=shifts.map(p=>p.slice()),quality=valid.map(v=>v?"tracked":"held"),used=new Set();
    for(const section of sections){
        const keys=[...(section.keys||[])].sort((a,b)=>a.at_ms-b.at_ms);
        if(!keys.length)continue;
        if(keys.some((k,i)=>!Number.isFinite(k.at_ms)||!Array.isArray(k.xy)||k.xy.length!==2||!k.xy.every(Number.isFinite)||(i&&k.at_ms<=keys[i-1].at_ms)))throw new Error("Correction keys need distinct times and finite positions");
        if(keys[0].at_ms<times[0]-.001||keys.at(-1).at_ms>times.at(-1)+.001)throw new Error("Correction lies outside the analyzed frames");
        const nearest=keys.length===1?times.reduce((best,t,i)=>Math.abs(t-keys[0].at_ms)<Math.abs(times[best]-keys[0].at_ms)?i:best,0):-1;
        let segment=0;
        times.forEach((t,i)=>{
            if(keys.length===1?i!==nearest:t<keys[0].at_ms-.001||t>keys.at(-1).at_ms+.001)return;
            if(used.has(i))throw new Error("Manual sections overlap; edit or split them before applying");
            used.add(i);
            while(segment+1<keys.length-1&&keys[segment+1].at_ms<t)segment++;
            const a=keys[segment],b=keys[Math.min(segment+1,keys.length-1)],f=b.at_ms===a.at_ms?0:Math.max(0,Math.min(1,(t-a.at_ms)/(b.at_ms-a.at_ms)));
            output[i]=a.xy.map((p,j)=>p+(b.xy[j]-p)*f-anchor[j]);quality[i]="manual";
        });
    }
    return {shifts:output,quality};
}

export function curveBuckets(times, shifts, quality, start, end, width) {
    const count=Math.max(1,Math.floor(width)),span=Math.max(1,end-start);
    const bins=Array.from({length:count},()=>({min:[Infinity,Infinity],max:[-Infinity,-Infinity],quality:0}));
    let lo=0,hi=times.length;while(lo<hi){const mid=(lo+hi)>>1;if(times[mid]<start)lo=mid+1;else hi=mid}
    for(let i=lo;i<times.length&&times[i]<=end;i++){
        const bucket=bins[Math.min(count-1,Math.floor((times[i]-start)/span*count))];
        for(let axis=0;axis<2;axis++){bucket.min[axis]=Math.min(bucket.min[axis],shifts[i][axis]);bucket.max[axis]=Math.max(bucket.max[axis],shifts[i][axis])}
        bucket.quality=Math.max(bucket.quality,quality[i]==="held"?2:quality[i]==="manual"?1:0);
    }
    return bins;
}
// Numbered point identities are shared by all marked frames in one section.
export function referenceKeys(reference) {
    return reference.keyframes || [{frame:0,points:reference.points||[]}];
}
export async function requireReferenceBackend(base) {
    const response=await fetch(new URL('../reference-capabilities',base),{cache:'no-store',signal:AbortSignal.timeout(10000)});
    if(!response.ok||(await response.json()).keyframes!==1)throw new Error('Restart ComfyUI to enable reference keyframes and offline tracking, then retry Apply. Your unapplied edits are kept in this tab.');
}
export function withReferenceKeys(reference, keys) {
    keys=structuredClone(keys).sort((a,b)=>a.frame-b.frame);
    if(!keys.length)keys=[{frame:0,points:[]}];
    return {...reference,keyframes:keys,points:structuredClone(keys[0].points)};
}
export function validateReferenceKeys(reference, frameCount=Infinity) {
    const keys=referenceKeys(reference),frames=keys.map(k=>k.frame),count=Math.max(...keys.map(k=>k.points.length));
    if(frames.some(f=>!Number.isInteger(f)||f<0||f>=frameCount)||new Set(frames).size!==frames.length)throw new Error('Reference keyframes must be distinct frames inside this section.');
    if(keys.some(k=>k.unconfirmed?.length))throw new Error('Review and reposition unconfirmed points on reference keyframes before tracking.');
    if(count<3||keys.some(k=>k.points.length!==count))throw new Error('Mark the same numbered points on every reference keyframe (at least three per frame).');
    const [x,y,w,h]=reference.crop_xywh;
    if(keys.some(k=>k.points.some(p=>p.length!==2||p.some(v=>!Number.isFinite(v))||p[0]<x||p[1]<y||p[0]>x+w-1||p[1]>y+h-1)))throw new Error('All reference keyframe points must be inside the tracking crop.');
}
export function addReferenceKey(reference, frame) {
    const keys=referenceKeys(reference);
    if(keys.some(k=>k.frame===frame))return withReferenceKeys(reference,keys);
    // An empty initial placeholder is moved to the first frame the user marks.
    return withReferenceKeys(reference,[...keys.filter(k=>k.points.length),{frame,points:[]}]);
}
export function putReferencePoint(reference, frame, slot, point) {
    const keys=structuredClone(referenceKeys(reference)),key=keys.find(k=>k.frame===frame);
    if(!key)throw new Error('Mark this frame as a reference keyframe first.');
    const expected=Math.max(...keys.map(k=>k.points.length));
    if(slot<0||slot>key.points.length||(keys.length>1&&slot>=expected))throw new Error('Place the same numbered points in order on each keyframe.');
    key.points[slot]=point;
    key.unconfirmed=(key.unconfirmed||[]).filter(i=>i!==slot);
    return withReferenceKeys(reference,keys);
}
export function removeReferencePoint(reference, slot) {
    const keys=structuredClone(referenceKeys(reference));
    for(const key of keys){key.points.splice(slot,1);key.unconfirmed=(key.unconfirmed||[]).filter(i=>i!==slot).map(i=>i>slot?i-1:i);}
    return withReferenceKeys(reference,keys);
}
