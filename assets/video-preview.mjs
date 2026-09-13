function previewIndex(mapping, timeMs) {
    const ts=mapping.times_ms;
    let lo=0,hi=ts.length-1;
    while(lo<hi){const mid=Math.ceil((lo+hi)/2);if(ts[mid]<=timeMs+.001)lo=mid;else hi=mid-1;}
    return lo;
}
export function previewShift(mapping,timeMs){return mapping.shift_xy[previewIndex(mapping,timeMs)];}
export function transformPixel(point,matrix){
    return matrix.map(row=>row[0]*point[0]+row[1]*point[1]+row[2]);
}
export function correctedTransforms(data,shifts){
    return shifts.map((shift,i)=>{
        const matrix=structuredClone(data.auto_transform_xy?.[i]||[[1,0,0],[0,1,0]]);
        const center=data.anchor_xy.map((v,j)=>v+shift[j]),mapped=transformPixel(center,matrix);
        matrix.forEach((row,j)=>row[2]+=data.anchor_xy[j]-mapped[j]);
        return matrix;
    });
}
export function transformBounds(width,height,matrices){
    const corners=[[0,0],[width,0],[0,height],[width,height]],extent=[0,0];
    for(const matrix of matrices)for(const p of corners){
        const q=transformPixel(p,matrix);
        q.forEach((v,j)=>extent[j]=Math.max(extent[j],-v,v-[width,height][j]));
    }
    const padding=extent.map(v=>Math.ceil((v+8)/2)*2);
    return {padding,size:[width+2*padding[0],height+2*padding[1]]};
}
export function stabilizedPixel(mapping,point,timeMs){
    const i=previewIndex(mapping,timeMs),matrix=mapping.transform_xy?.[i];
    return (matrix?transformPixel(point,matrix):point.map((v,j)=>v-mapping.shift_xy[i][j])).map((v,j)=>v+mapping.padding_xy[j]);
}
export function originalPixel(mapping, point, timeMs) {
    const matrix=mapping.transform_xy?.[previewIndex(mapping,timeMs)];
    if(matrix){
        const [[a,b,tx],[c,d,ty]]=matrix,det=a*d-b*c;
        const x=point[0]-mapping.padding_xy[0]-tx,y=point[1]-mapping.padding_xy[1]-ty;
        return [(d*x-b*y)/det,(-c*x+a*y)/det];
    }
    const shift=previewShift(mapping,timeMs);
    return point.map((v,i)=>v-mapping.padding_xy[i]+shift[i]);
}
export function previewMediaTime(timeMs, variant, mapping, sourceOriginMs = 0) {
    const offset=mapping?(variant==="original"?mapping.source_offset_ms:0):sourceOriginMs;
    return (timeMs+offset)/1000;
}
export function previewTimelineTime(seconds, variant, mapping, sourceOriginMs = 0) {
    const offset=mapping?(variant==="original"?mapping.source_offset_ms:0):sourceOriginMs;
    return seconds*1000-offset;
}

// Timeline renders already live in ComfyUI's output directory. Use its bounded
// /view file service so saved runs can be reviewed without a backend restart.
export function timelineOutputURL(session, relative, base) {
    if(!/^[0-9a-f]{32}$/.test(session)||!relative.split('/').every(part=>/^[\w.-]+$/.test(part)&&part!=='.'&&part!=='..'))throw new Error('Invalid timeline output path');
    const url=new URL('../../view',base),parts=relative.split('/');
    url.searchParams.set('type','output');url.searchParams.set('filename',parts.pop());
    url.searchParams.set('subfolder',`sam3d_funscript/processing/${session}/${parts.join('/')}`);
    return url;
}
export function timelineRenderCatalog(result, session, sourceId, base) {
    if(result?.source_id!==sourceId)return [];
    const prefix=`/sam3d_funscript/processing/${session}/reference/`;
    return Object.entries(result.stabilization||{}).flatMap(([id,entry])=>{
        const region=entry.region,path=String(entry.video_path||''),suffix=path.split(prefix);
        if(suffix.length!==2||!/^([0-9a-f]{24})\/stabilized\.mp4$/.test(suffix[1])||region?.id!==id||
            !Number.isFinite(region.start_ms)||!Number.isFinite(region.end_ms)||region.end_ms<=region.start_ms)return [];
        return [{id,region,url:timelineOutputURL(session,'reference/'+suffix[1],base).href,
            referenceId:suffix[1].split('/')[0],manifestURL:timelineOutputURL(session,'reference/'+suffix[1].replace('stabilized.mp4','reference.json'),base).href}];
    });
}
export function timelineRenderCurrent(render, region) {
    const maskKey=reference=>{const m=reference?.point_mask;return m?.strokes?.length?JSON.stringify({frame:m.frame,strokes:m.strokes,model:m.model||'sam2.1_base_plus',margin:m.margin??6}):'';};
    // Names, locks and enabled toggles do not change a rendered image.
    return maskKey(render.region.reference)===maskKey(region.reference)&&['start_ms','end_ms','agreement_pixels','max_step_pixels'].every(key=>render.region[key]===region[key])&&
        ['crop_xywh','points','sections','keyframes'].every(key=>JSON.stringify(render.region.reference?.[key]||[])===JSON.stringify(region.reference?.[key]||[]))&&
        (render.region.reference?.tracking_mode||'online')===(region.reference?.tracking_mode||'online')&&
        (render.region.reference?.transform_mode||'translation')===(region.reference?.transform_mode||'translation');
}
export function timelineRenderAt(renders, plan, time) {
    return renders.find(render=>plan.stabilization.some(region=>region.id===render.id&&region.enabled!==false&&
        time>=region.start_ms-.000002&&time<region.end_ms-.000002)&&
        time>=render.region.start_ms-.000002&&time<render.region.end_ms-.000002)||null;
}

export function timelineTrackingHealth(manifest, render, source) {
    const data=manifest?.data,times=data?.source_times_ms,quality=data?.quality;
    if(manifest?.id!==render.referenceId||manifest.state!=='ready'||
        ['path','size','mtime_ns'].some(key=>manifest.info?.source?.[key]!==source?.[key])||
        !times?.length||quality?.length!==times.length||data.shift_xy?.length!==times.length||
        times.some((t,i)=>!Number.isFinite(t)||(i&&t<=times[i-1]))||
        quality.some(q=>!['tracked','manual','held'].includes(q)))throw new Error('Tracking details do not match this render');
    const counts={tracked:0,manual:0,held:0},gaps=[];
    quality.forEach((q,i)=>{counts[q]++;if(q==='held'&&(i===0||quality[i-1]!=='held'))gaps.push(times[i]);});
    return {times,quality,counts,gaps,total:times.length,points:data.points,visible:data.visible,inliers:data.inliers,config:manifest.config,
        shifts:data.shift_xy,transforms:data.transform_xy,padding:manifest.video?.padding_xy||[0,0],reasons:data.reasons||[],end:render.region.end_ms};
}
export function trackingFrame(health, time) {
    if(!health||time<health.times[0]-.001||time>=health.end-.001)return null;
    let a=0,b=health.times.length-1;
    while(a<b){const m=Math.ceil((a+b)/2);if(health.times[m]<=time+.001)a=m;else b=m-1;}
    return a;
}
export function trackingSummary(health) {
    const {tracked,manual,held}=health.counts;
    return `${tracked} tracked · ${manual?`${manual} corrected · `:''}${held} held / ${health.total} frames (${(held/health.total*100).toFixed(1)}% held)`;
}
export function trackingReason(reason) {
    return ({reference_points_too_close:'reference points are too close together',scale_needs_review:'extreme scale change needs review',outside_reference_mask:'fewer than 3 points inside the propagated mask',insufficient_visible_points:'fewer than 3 visible reference points',points_disagree:'reference points disagree',tracking_passes_disagree:'tracking from reference keyframes disagrees',large_jump_needs_review:'sudden tracking jump'})[reason]||'tracking unavailable';
}
