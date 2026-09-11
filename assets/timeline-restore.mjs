import {createRegion,validateInterval,bounds} from './processing-timeline-edit.mjs?v=timeline-audit-1';

export function restoreCandidate(raw,info,clock) {
    const data=structuredClone(raw?.plan||raw),object=v=>v&&typeof v==='object'&&!Array.isArray(v);
    if(!object(data)||data.version!==1||data.source_id!==info.source_id)throw new Error('Choose a version 1 plan saved for this source video.');
    if(!Array.isArray(data.tracking)||!Array.isArray(data.stabilization))throw new Error('The plan needs tracking and stabilization lanes.');
    const ids=new Set();
    const pointValid=p=>Array.isArray(p)&&p.length===2&&p.every(Number.isFinite);
    const paintValid=p=>object(p)&&Number.isInteger(p.frame)&&p.frame>=0&&Array.isArray(p.strokes)&&p.strokes.every(s=>object(s)&&(s.erase===undefined||typeof s.erase==='boolean')&&Number.isFinite(s.radius)&&s.radius>0&&Array.isArray(s.points)&&s.points.every(pointValid));
    for(const lane of ['tracking','stabilization'])data[lane]=data[lane].map(r=>{
        if(!object(r)||typeof r.id!=='string'||!r.id||ids.has(r.id))throw new Error('Regions need distinct IDs.');
        ids.add(r.id);
        const region={...createRegion(lane,r.id,r.start_ms,r.end_ms,info),...r};
        validateInterval({...data,[lane]:[]},lane,r.id,r.start_ms,r.end_ms,info);
        for(const key of ['enabled','locked'])if(typeof region[key]!=='boolean')throw new Error('Region enabled/locked values must be true or false.');
        if(typeof region.name!=='string')throw new Error('Region names must be text.');
        if(lane==='tracking'){
            if(typeof region.anchor!=='string'||!Array.isArray(region.additional_anchors)||!region.additional_anchors.every(a=>typeof a==='string')||!object(region.settings))throw new Error('Invalid anchor settings.');
            if(!Number.isFinite(region.smoothing_ms)||region.smoothing_ms<0||!Array.isArray(region.rois)||!region.rois.length||region.rois.some(r=>!Array.isArray(r)||r.length!==4||!r.every(Number.isFinite)||r[0]<0||r[1]<0||r[2]<=0||r[3]<=0||r[0]+r[2]>1.000001||r[1]+r[3]>1.000001)||!Number.isInteger(region.person)||region.person<0||region.person>=region.rois.length)throw new Error('Invalid person regions or smoothing.');
            if(region.mask_anchor&&!paintValid(region.mask_anchor))throw new Error('Invalid painted anchor.');
        }else{
            const ref=region.reference;
            if(!object(ref)||!Array.isArray(ref.crop_xywh)||ref.crop_xywh.length!==4||!ref.crop_xywh.every(Number.isFinite)||!Array.isArray(ref.points)||!ref.points.every(pointValid)||!Array.isArray(ref.sections))throw new Error('Invalid stabilization reference.');
            const [x,y,w,h]=ref.crop_xywh;
            if(x<0||y<0||w<2||h<2||x+w>info.width||y+h>info.height)throw new Error('The tracking crop must be inside the source image.');
            const keys=ref.keyframes||[{frame:0,points:ref.points}];
            const count=clock.ceil(region.end_ms)-clock.ceil(region.start_ms);
            if(!Array.isArray(keys)||!keys.length||keys.some(k=>!object(k)||!Number.isInteger(k.frame)||k.frame<0||k.frame>=count||!Array.isArray(k.points)||!k.points.every(pointValid)||k.unconfirmed!==undefined&&(!Array.isArray(k.unconfirmed)||k.unconfirmed.some(i=>!Number.isInteger(i)||i<0||i>=k.points.length)))||new Set(keys.map(k=>k.frame)).size!==keys.length)throw new Error('Reference keyframes must be distinct frames inside their region with valid point coordinates.');
            if(ref.sections.some(s=>!object(s)||!Array.isArray(s.keys)||s.keys.some(k=>!object(k)||!Number.isFinite(k.at_ms)||!pointValid(k.xy))))throw new Error('Invalid manual correction keys.');
            if(ref.tracking_mode!==undefined&&!['online','offline'].includes(ref.tracking_mode))throw new Error('Invalid reference tracker mode.');
            if(ref.point_mask&&!paintValid(ref.point_mask))throw new Error('Invalid painted mask.');
        }
        for(const paint of [region.mask_anchor,region.reference?.point_mask])if(paint&&paint.frame>=clock.ceil(region.end_ms)-clock.ceil(region.start_ms))throw new Error('A painted reference is outside its region.');
        return region;
    });
    for(const lane of ['tracking','stabilization'])for(const r of data[lane])if(r.enabled)validateInterval(data,lane,r.id,r.start_ms,r.end_ms,info);
    if(!Array.isArray(data.selection)||data.selection.length!==2||!data.selection.every(Number.isFinite)||data.selection[0]>data.selection[1]||data.selection[0]<bounds(info)[0]||data.selection[1]>bounds(info)[1])throw new Error('Invalid marked range.');
    data.selected_ids=(Array.isArray(data.selected_ids)?data.selected_ids:[]).filter(id=>ids.has(id));
    if(!Number.isFinite(data.chunk_seconds)||data.chunk_seconds<1||data.chunk_seconds>600||!Number.isFinite(data.join_ms)||data.join_ms<0||!['hold','neutral'].includes(data.gap_policy))throw new Error('Invalid processing options.');
    return data;
}

export function timelineRestore({$,context,restore,fail}) {
    let pending=null;
    $('restorePlan').onclick=()=>{$('restoreFile').value='';$('restoreFile').click();};
    $('restoreFile').onchange=async()=>{
        try{
            const file=$('restoreFile').files[0];if(!file)return;
            if(file.size>16*1024*1024)throw new Error('This plan is too large (maximum 16 MB).');
            const c=context();pending=restoreCandidate(JSON.parse(await file.text()),c.info,c.clock);
            $('restoreError').textContent='';
            $('restoreSummary').textContent=`${file.name}: ${pending.tracking.length} tracking and ${pending.stabilization.length} stabilization regions. Current plan: ${c.plan.tracking.length} tracking and ${c.plan.stabilization.length} stabilization regions.`;
            $('restoreDialog').showModal();
        }catch(e){pending=null;fail(e);}
    };
    $('cancelRestore').onclick=()=>{$('restoreDialog').close();pending=null;};
    $('confirmRestore').onclick=async()=>{
        if(!pending||$('confirmRestore').disabled)return;
        $('confirmRestore').disabled=true;$('cancelRestore').disabled=true;
        try{const candidate=pending;await restore(candidate);pending=null;$('restoreDialog').close();}catch(e){$('restoreError').textContent=e.message;fail(e);}finally{$('confirmRestore').disabled=false;$('cancelRestore').disabled=false;}
    };
}
