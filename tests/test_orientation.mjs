import assert from 'node:assert/strict';
import {validateOrientation} from '../assets/reference-edit.mjs';
import {createRegion,splitRegion,changeRegion,validateReference} from '../assets/processing-timeline-edit.mjs';
import {restoreCandidate} from '../assets/timeline-restore.mjs';
import {timelineRenderCurrent} from '../assets/video-preview.mjs';
import {frameClock} from '../assets/frame-clock.mjs';

const info={source_id:'head',start:'0',end_ms:600,width:320,height:240};
const clock=frameClock({first_frame:0,end_frame:6,times_ms:[0,40,120,200,340,500],end_ms:600});
const region=createRegion('stabilization','s',0,600,info);
region.reference.transform_mode='orientation';
region.reference.orientation={method:'features',target_degrees:0,keys:[
    {frame:1,head_xywh:[100,50,80,100],angle_degrees:30},
    {frame:4,head_xywh:[110,60,80,100],angle_degrees:60}]};
const plan={version:1,source_id:'head',tracking:[],stabilization:[region],selection:[0,600],selected_ids:['s'],chunk_seconds:30,join_ms:200,gap_policy:'hold'};
validateReference(region); // Orientation requires no CoTracker points.
assert.deepEqual(restoreCandidate(plan,info,clock),plan);
const split=splitRegion(plan,'s',200,'second',info,clock);
assert.deepEqual(split.stabilization.map(r=>r.reference.orientation.keys.map(k=>k.frame)),[[1],[1]]);
assert.equal(split.stabilization[1].reference.orientation.keys[0].angle_degrees,60);
const trimmed=changeRegion(plan,'s',{start_ms:120,end_ms:500},info,clock).stabilization[0];
assert.deepEqual(trimmed.reference.orientation.keys.map(k=>k.frame),[2]);
const empty=changeRegion(plan,'s',{start_ms:120,end_ms:200},info,clock).stabilization[0];
assert.throws(()=>validateReference(empty),/Draw the head/);
const clone=structuredClone(region);assert.ok(timelineRenderCurrent({region:clone},region));
clone.reference.orientation.target_degrees=10;
assert.equal(timelineRenderCurrent({region:clone},region),false,'an angle change invalidates a rendered preview');
for(const patch of [{frame:6},{frame:-1},{angle_degrees:NaN},{head_xywh:[300,50,80,100]}]){
    const value=structuredClone(region.reference.orientation);Object.assign(value.keys[0],patch);
    assert.throws(()=>validateOrientation(value,6,[320,240]));
}
const broken=structuredClone(plan);broken.stabilization[0].reference.orientation.keys.push({...broken.stabilization[0].reference.orientation.keys[0]});
assert.throws(()=>restoreCandidate(broken,info,clock),/distinct/);
assert.equal(plan.stabilization[0].reference.orientation.keys.length,2);
console.log('Orientation: validation, restoration, frame-accurate split/trim and preview invalidation passed');
