import assert from 'node:assert/strict';
import {trackingResultCurrent,processingScope,planForScope} from '../assets/processing-state.mjs';
import {restoreCandidate} from '../assets/timeline-restore.mjs';
import {frameClock} from '../assets/frame-clock.mjs';
const r={id:'t',name:'Track',start_ms:0,end_ms:2000,enabled:true,locked:false,anchor:'pelvis',person:0,rois:[[0,0,1,1]],smoothing_ms:30,settings:{},additional_anchors:[]};
const plan={version:1,source_id:'fixture',tracking:[r],stabilization:[],selection:[500,1000],selected_ids:['t'],chunk_seconds:30,join_ms:200,gap_policy:'hold'};
const before=structuredClone(plan),range=processingScope(plan,'range'),regions=processingScope(plan,'regions');
assert.deepEqual(planForScope(plan,regions).selection,[500,500]);
assert.deepEqual(planForScope(plan,range).selected_ids,[]);
assert.deepEqual(plan,before);
plan.selection[0]=750;assert.equal(range.range[0],500,'scope captures the requested range');plan.selection[0]=500;
const entry={region:structuredClone(r),stabilization_regions:[]};
assert.ok(trackingResultCurrent(r,entry,[]));
assert.ok(trackingResultCurrent({...r,name:'Rename',locked:true},entry,[]));
assert.equal(trackingResultCurrent(r,{region:r},[]),null,'legacy output may have used a stabilization region since removed');
assert.equal(trackingResultCurrent(r,null,[]),null);
assert.equal(trackingResultCurrent({...r,anchor:'mouth'},{region:r},[]),false,'known changes still invalidate legacy output');
for(const patch of [{anchor:'mouth'},{person:1},{smoothing_ms:80},{additional_anchors:['nose']},{rois:[[0,0,.5,1]]},{settings:{axis_settings:{L0:{invert:true}}}},{mask_anchor:{frame:1,strokes:[]}}])assert.equal(trackingResultCurrent({...r,...patch},entry,[]),false);
const stable={id:'s',start_ms:0,end_ms:2000,enabled:true,reference:{crop_xywh:[0,0,100,100],points:[[20,20],[30,30],[40,40]],sections:[]}};
assert.equal(trackingResultCurrent(r,entry,[stable]),false,'new stabilization invalidates old curves');
const stabilizedEntry={...entry,stabilization_regions:[stable]};assert.ok(trackingResultCurrent(r,stabilizedEntry,[stable]));
assert.equal(trackingResultCurrent(r,stabilizedEntry,[{...stable,reference:{...stable.reference,points:[[21,20],[30,30],[40,40]]}}]),false);
const info={source_id:'fixture',start:'0',end_ms:2000,width:100,height:100},clock=frameClock({first_frame:0,end_frame:4,times_ms:[0,500,1000,1500],end_ms:2000});
assert.deepEqual(restoreCandidate(plan,info,clock),plan);
assert.throws(()=>restoreCandidate({...plan,source_id:'other'},info,clock),/source/);
assert.throws(()=>restoreCandidate({...plan,tracking:[{...r,rois:'bad'}]},info,clock),/person/);
assert.throws(()=>restoreCandidate({...plan,tracking:[r,r]},info,clock),/distinct/);
assert.throws(()=>restoreCandidate({...plan,tracking:[{...r,mask_anchor:{frame:4,strokes:[]}}]},info,clock),/outside/);
const referencePlan={...plan,stabilization:[{...stable,name:'Reference',locked:false}]};
assert.equal(restoreCandidate(referencePlan,info,clock).stabilization.length,1);
for(const reference of [
 {...stable.reference,keyframes:[]},
 {...stable.reference,keyframes:[{frame:4,points:[]}]},
 {...stable.reference,keyframes:[{frame:0,points:[]},{frame:0,points:[]}]},
 {...stable.reference,keyframes:[{frame:0,points:[],unconfirmed:'bad'}]},
 {...stable.reference,sections:[{keys:'bad'}]},
 {...stable.reference,crop_xywh:[0,0,200,100]},
])assert.throws(()=>restoreCandidate({...referencePlan,stabilization:[{...referencePlan.stabilization[0],reference}]},info,clock));
assert.equal(restoreCandidate({...referencePlan,stabilization:[{...referencePlan.stabilization[0],reference:{...stable.reference,points:[]}}]},info,clock).stabilization[0].reference.points.length,0,'unfinished references can be restored as drafts');
console.log('Processing scope, output freshness, source-bound restore and malformed plan rejection passed');
