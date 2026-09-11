// Region edits retain the original-video clock. This module is also used by tests.
import {validateReferenceKeys,referenceKeys,withReferenceKeys} from './reference-edit.mjs?v=reference-keys-1';
export const LANES = ["tracking", "stabilization"];
export const ANCHORS = ["pelvis", "chest", "nose", "left_wrist", "right_wrist", "left_hand", "right_hand", "neck", "mouth"];
// Named landmarks from anchors.py, grouped separately from the everyday choices.
export const DETAILED_ANCHOR_GROUPS = {
    "Head": ["left_eye", "right_eye", "left_ear", "right_ear"],
    "Upper body": ["left_shoulder", "right_shoulder", "left_elbow", "right_elbow", "left_olecranon", "right_olecranon", "left_cubital_fossa", "right_cubital_fossa", "left_acromion", "right_acromion"],
    "Lower body": ["left_hip", "right_hip", "left_knee", "right_knee", "left_ankle", "right_ankle"],
    "Feet": ["left_big_toe_tip", "left_small_toe_tip", "left_heel", "right_big_toe_tip", "right_small_toe_tip", "right_heel"],
    ...Object.fromEntries(["left", "right"].map(side => [`${side === "left" ? "Left" : "Right"} fingers`, ["thumb", "index", "middle", "ring", "pinky"].flatMap(finger => ["tip", "first_joint", "second_joint", "third_joint"].map(part => `${side}_${finger}_${part}`))])),
};
export const clone = value => structuredClone(value);
export const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
export function fraction(value) {
    const [a, b = "1"] = String(value ?? 0).split("/");
    const result = Number(a) / Number(b);
    return Number.isFinite(result) ? result : 0;
}
export function bounds(info) {
    const start = Math.max(0, fraction(info.start) * 1000);
    return [start, Math.max(start + 1, Number(info.end_ms) || start + fraction(info.duration) * 1000 || 1)];
}
export function regionById(plan, id) {
    for (const lane of LANES) {
        const region = (plan[lane] || []).find(item => item.id === id);
        if (region) return {lane, region};
    }
    return null;
}
export function selectionRange(plan, info) {
    const [low, high] = bounds(info), raw = plan.selection || [low, low];
    return [clamp(Math.min(...raw), low, high), clamp(Math.max(...raw), low, high)];
}
export function createRegion(lane, id, start, end, info, count = 0) {
    const [low, high] = bounds(info);
    start = clamp(start, low, high - 1); end = clamp(end, start + 1, high);
    const common = {id, name: `${lane === "tracking" ? "Tracking" : "Stabilization"} ${count + 1}`, start_ms: start, end_ms: end, enabled: true, locked: false};
    return lane === "tracking" ? {...common, anchor: "pelvis", additional_anchors: [], person: 0, rois: [[0, 0, 1, 1]], smoothing_ms: 30, settings: {}} : {...common, reference: {crop_xywh: [0, 0, info.width, info.height], points: [], sections: []}};
}
export function validateInterval(plan, lane, id, start, end, info) {
    const [low, high] = bounds(info);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < low - .01 || end > high + .01 || end - start < 1) throw new Error("Region must have a positive duration inside the source clip.");
    const overlap = (plan[lane] || []).find(item => item.id !== id && item.enabled !== false && start < item.end_ms - .01 && end > item.start_ms + .01);
    if (overlap) throw new Error(`This overlaps ${overlap.name || "another region"} in the same lane. Use adjacent regions or disable the other region first.`);
}
export function changeRegion(plan, id, patch, info) {
    const found = regionById(plan, id);
    if (!found) throw new Error("Select a region first.");
    const {lane, region} = found;
    if (region.locked && !(Object.keys(patch).length === 1 && patch.locked === false)) throw new Error("This region is locked. Unlock it before editing.");
    const updated = {...region, ...clone(patch)};
    if (lane === "tracking") updated.additional_anchors = [...new Set(updated.additional_anchors || [])].filter(anchor => anchor !== updated.anchor);
    if (updated.enabled !== false) validateInterval(plan, lane, id, updated.start_ms, updated.end_ms, info);
    if (lane === "stabilization" && (updated.start_ms !== region.start_ms || (updated.end_ms !== region.end_ms && (updated.reference.keyframes || updated.reference.point_mask)))) {
        // Reference identities were selected on a different first frame. Never silently reuse them.
        updated.reference = {...clone(updated.reference), points: [], sections: []};
        delete updated.reference.keyframes; delete updated.reference.point_mask;
    }
    if (lane === "tracking" && (updated.start_ms !== region.start_ms || updated.end_ms !== region.end_ms)) delete updated.mask_anchor;
    return {...plan, [lane]: plan[lane].map(item => item.id === id ? updated : item)};
}
function sliceReference(reference, region, start, end, clock) {
    const result=clone(reference);
    const timed=reference.keyframes||reference.point_mask||(reference.sections||[]).some(s=>s.keys?.length);
    if(timed&&!clock)throw new Error('Load the source frame index before splitting reference frames.');
    if(!clock){result.points=start===region.start_ms?clone(reference.points||[]):[];result.sections=[];return result;}
    const origin=clock.ceil(region.start_ms),first=clock.ceil(start),stop=clock.ceil(end),offset=first-origin;
    const keys=referenceKeys(reference).filter(k=>k.frame>=offset&&k.frame<stop-origin).map(k=>({...clone(k),frame:k.frame-offset}));
    Object.assign(result,withReferenceKeys(result,keys));
    const mask=result.point_mask;
    if(mask&&mask.frame>=offset&&mask.frame<stop-origin)mask.frame-=offset;
    else delete result.point_mask;
    // Correction keys use milliseconds from the original region's first frame.
    // Clip their interpolation at the last included frame, then rebase it.
    const low=clock.at(first)-clock.at(origin),high=clock.at(stop-1)-clock.at(origin);
    result.sections=(reference.sections||[]).flatMap(section=>{
        const source=[...(section.keys||[])].sort((a,b)=>a.at_ms-b.at_ms);
        if(!source.length||source.at(-1).at_ms<low||source[0].at_ms>high)return [];
        const a=Math.max(low,source[0].at_ms),b=Math.min(high,source.at(-1).at_ms);
        const times=[...new Set([a,...source.filter(k=>k.at_ms>a&&k.at_ms<b).map(k=>k.at_ms),b])];
        const keys=times.map(at=>{
            const right=source.findIndex(k=>k.at_ms>=at),to=source[right],from=source[Math.max(0,right-1)];
            const t=to.at_ms===from.at_ms?0:(at-from.at_ms)/(to.at_ms-from.at_ms);
            return {at_ms:at-low,xy:from.xy.map((v,i)=>v+(to.xy[i]-v)*t)};
        });
        return [{...clone(section),keys}];
    });
    return result;
}
export function splitRegion(plan, id, at, newId, info, clock=null) {
    const found = regionById(plan, id);
    if (!found) throw new Error("Select a region first.");
    const {lane, region} = found;
    if (region.locked) throw new Error("Unlock this region before splitting.");
    if(clock)at=clock.snap(at,true);
    if (!Number.isFinite(at)||at <= region.start_ms + 1 || at >= region.end_ms - 1||clock&&(clock.ceil(at)<=clock.ceil(region.start_ms)||clock.ceil(at)>=clock.ceil(region.end_ms))) throw new Error("Move the playhead inside the selected region to split it.");
    const first = {...clone(region), end_ms: at};
    const second = {...clone(region), id: newId, name: `${region.name} · part 2`, start_ms: at};
    if (lane === "stabilization") {
        first.reference=sliceReference(region.reference,region,region.start_ms,at,clock);
        second.reference=sliceReference(region.reference,region,at,region.end_ms,clock);
    }
    if (lane === "tracking" && region.mask_anchor) {
        if(!clock)throw new Error('Load the source frame index before splitting a mask anchor.');
        const offset=clock.ceil(at)-clock.ceil(region.start_ms),seed=region.mask_anchor.frame;
        if(seed<offset)delete second.mask_anchor;
        else {delete first.mask_anchor;second.mask_anchor.frame-=offset;}
    }
    return {...plan, [lane]: plan[lane].flatMap(item => item.id === id ? [first, second] : [item]), selected_ids: [second.id], selection: [second.start_ms, second.end_ms]};
}
export function splitAtTime(plan, lanes, at, newId, info, clock) {
    at=clock.snap(at,true);
    const targets=lanes.flatMap(lane=>plan[lane].filter(r=>r.enabled!==false&&r.start_ms<at&&r.end_ms>at));
    if(!targets.length)throw new Error('No region crosses this frame in the chosen lane.');
    if(targets.some(r=>r.locked))throw new Error('Unlock the regions at this frame before splitting.');
    let next=plan;const ids=[];
    for(const region of targets){next=splitRegion(next,region.id,at,newId(),info,clock);ids.push(next.selected_ids[0]);}
    return {...next,selected_ids:ids};
}
export function validateReference(region) {
    const reference = region.reference || {}, crop = reference.crop_xywh;
    if (!Array.isArray(crop) || crop.length !== 4 || crop.some(value => !Number.isFinite(value)) || crop[2] < 2 || crop[3] < 2) throw new Error("Draw a reference crop at least two pixels wide and high.");
    validateReferenceKeys(reference);
}
export function regionRows(regions) {
    const rows = [], positions = new Map();
    for (const region of [...regions].sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms)) {
        let row = rows.findIndex(end => end <= region.start_ms);
        if (row < 0) row = rows.length;
        rows[row] = region.end_ms; positions.set(region.id, row);
    }
    return {positions, count: Math.max(1, rows.length)};
}
export function isolateSelection(plan, id, newId, info, clock=null) {
    const found = regionById(plan, id);
    if (!found) throw new Error("Select the region containing this time range first.");
    if (found.region.locked) throw new Error("Unlock this region before splitting it.");
    const [a,b] = selectionRange(plan, info), region = found.region;
    if (b-a<1 || a<region.start_ms || b>region.end_ms) throw new Error("Select a nonempty range inside the active region.");
    let result=plan,middle=id;
    if(a>region.start_ms+1){result=splitRegion(result,middle,a,newId(),info,clock);middle=result.selected_ids[0];}
    if(b<region.end_ms-1)result=splitRegion(result,middle,b,newId(),info,clock);
    return {...result,selected_ids:[middle],selection:[a,b]};
}

export function regionFromSelection(plan,lane,newId,info,clock=null){
    const [a,b]=selectionRange(plan,info);
    if(!LANES.includes(lane)||b-a<1)throw new Error("Select a nonempty range before making a region.");
    const overlaps=plan[lane].filter(r=>r.enabled!==false&&a<r.end_ms&&b>r.start_ms);
    if(overlaps.length===1&&a>=overlaps[0].start_ms&&b<=overlaps[0].end_ms){
        const region=overlaps[0];
        if(a===region.start_ms&&b===region.end_ms)return {...plan,selected_ids:[region.id]};
        return isolateSelection(plan,region.id,newId,info,clock);
    }
    if(overlaps.length)throw new Error("This range crosses existing regions. Select a range inside one region or inside an empty gap.");
    const region=createRegion(lane,newId(),a,b,info,plan[lane].length);
    return {...plan,[lane]:[...plan[lane],region],selected_ids:[region.id]};
}
