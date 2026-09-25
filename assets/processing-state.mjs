// Shared meaning of processing scope and result freshness, independent of the DOM.
import {overlapsRange} from './processing-timeline-edit.mjs?v=anchor-boundary-1';
const canonical=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
export function trackingConfiguration(r) {
    return {id:r.id,start_ms:r.start_ms,end_ms:r.end_ms,method:r.method||'sam3d',anchor:r.anchor||'pelvis',
        additional_anchors:r.additional_anchors||[],person:r.person??0,rois:r.rois||[[0,0,1,1]],isolate_subject:!!r.isolate_subject,
        smoothing_ms:r.smoothing_ms??30,settings:r.settings||{},mask_anchor:r.mask_anchor||null,
        candidate_people:r.candidate_people||null,automatic:r.automatic||null};
}
export function referenceConfiguration(r) {
    const ref=structuredClone(r.reference||{});delete ref.source_id;delete ref.auto_points;
    ref.transform_mode??='translation';
    if(ref.point_mask){delete ref.point_mask.spacing;delete ref.point_mask.limit;}
    return {id:r.id,start_ms:r.start_ms,end_ms:r.end_ms,reference:ref,agreement_pixels:r.agreement_pixels??12,max_step_pixels:r.max_step_pixels??48};
}
export function trackingResultCurrent(region,entry,stabilization) {
    // null means an older result lacks enough metadata to establish freshness.
    if(!entry?.region)return null;
    if(canonical(trackingConfiguration(region))!==canonical(trackingConfiguration(entry.region)))return false;
    const current=stabilization.filter(r=>r.enabled!==false&&overlapsRange(r,region.start_ms,region.end_ms));
    if(!Array.isArray(entry.stabilization_regions))return null;
    const signature=rows=>canonical(rows.map(referenceConfiguration).sort((a,b)=>a.id.localeCompare(b.id)));
    return signature(current)===signature(entry.stabilization_regions);
}
export function trackingSplits(previous,incoming){
    const result=new Map();
    if(!previous||canonical(previous.stabilization)!==canonical(incoming.stabilization))return result;
    const ids=new Set(previous.tracking.map(r=>r.id));
    const settings=r=>canonical({...trackingConfiguration(r),id:'',start_ms:0,end_ms:0});
    for(const old of previous.tracking){
        if(old.enabled===false||old.locked)continue;
        const parts=incoming.tracking.filter(r=>r.enabled!==false&&(r.id===old.id||!ids.has(r.id))&&r.start_ms>=old.start_ms&&r.end_ms<=old.end_ms&&settings(r)===settings(old)).sort((a,b)=>a.start_ms-b.start_ms);
        if(parts.length>1&&parts[0].id===old.id&&parts[0].start_ms===old.start_ms&&parts.at(-1).end_ms===old.end_ms&&parts.every((r,i)=>!i||parts[i-1].end_ms===r.start_ms))
            for(const part of parts)result.set(part.id,old);
    }
    return result;
}

// Use the same save handshake as queued processing, also for a cached split.
// No curve payload is broadcast and a failed editor save cancels the split.
export function flushSplitEditor(session){
    if(!session||typeof BroadcastChannel!=='function')return Promise.resolve();
    return new Promise((resolve,reject)=>{
        const channel=new BroadcastChannel(`s3f-editor-${session}`),request=Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,"0")).join(""),pending=new Set();
        let discovering=true;
        const finish=error=>{clearTimeout(discovery);clearTimeout(timeout);channel.close();error?reject(error):resolve();};
        const check=()=>{if(!discovering&&!pending.size)finish();};
        const discovery=setTimeout(()=>{discovering=false;check();},250);
        const timeout=setTimeout(()=>finish(new Error('Motion Studio did not finish saving. Check its tab before splitting.')),15000);
        channel.onmessage=({data})=>{
            if(data?.request!==request)return;
            if(data.type==='preparing')pending.add(data.editor);
            if(data.type==='prepared'){if(data.error){finish(new Error(`Motion Studio save failed: ${data.error}`));return;}pending.delete(data.editor);check();}
        };
        channel.postMessage({type:'prepare-run',request});
    });
}
export function processingScope(plan,kind) {
    if(kind==='range'){
        const range=[...plan.selection];
        if(!(range[1]>range[0]))throw new Error('Mark a nonempty frame range first.');
        return {kind,range};
    }
    if(kind==='regions'){
        const enabled=[...plan.tracking,...plan.stabilization].filter(r=>r.enabled!==false);
        const ids=(plan.selected_ids||[]).filter(id=>enabled.some(r=>r.id===id));
        if(!ids.length)throw new Error('Select at least one enabled region first.');
        return {kind,ids};
    }
    throw new Error('Choose a marked range or selected regions.');
}
export function planForScope(plan,scope) {
    return scope.kind==='range'?{...plan,selection:[...scope.range],selected_ids:[]}:
        {...plan,selection:[plan.selection[0],plan.selection[0]],selected_ids:[...scope.ids]};
}
