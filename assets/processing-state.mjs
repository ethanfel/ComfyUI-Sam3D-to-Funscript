// Shared meaning of processing scope and result freshness, independent of the DOM.
const canonical=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
export function trackingConfiguration(r) {
    return {id:r.id,start_ms:r.start_ms,end_ms:r.end_ms,method:r.method||'sam3d',anchor:r.anchor||'pelvis',
        additional_anchors:r.additional_anchors||[],person:r.person??0,rois:r.rois||[[0,0,1,1]],isolate_subject:!!r.isolate_subject,
        smoothing_ms:r.smoothing_ms??30,settings:r.settings||{},mask_anchor:r.mask_anchor||null,
        candidate_people:r.candidate_people||null,automatic:r.automatic||null};
}
export function referenceConfiguration(r) {
    const ref=structuredClone(r.reference||{});delete ref.source_id;
    if(ref.point_mask){delete ref.point_mask.spacing;delete ref.point_mask.limit;}
    return {id:r.id,start_ms:r.start_ms,end_ms:r.end_ms,reference:ref,agreement_pixels:r.agreement_pixels??12,max_step_pixels:r.max_step_pixels??48};
}
export function trackingResultCurrent(region,entry,stabilization) {
    // null means an older result lacks enough metadata to establish freshness.
    if(!entry?.region)return null;
    if(canonical(trackingConfiguration(region))!==canonical(trackingConfiguration(entry.region)))return false;
    const current=stabilization.filter(r=>r.enabled!==false&&r.start_ms<region.end_ms&&r.end_ms>region.start_ms);
    if(!Array.isArray(entry.stabilization_regions))return null;
    const signature=rows=>canonical(rows.map(referenceConfiguration).sort((a,b)=>a.id.localeCompare(b.id)));
    return signature(current)===signature(entry.stabilization_regions);
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
