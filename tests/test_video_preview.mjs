import assert from "node:assert/strict";
import {originalPixel,previewShift,previewMediaTime,previewTimelineTime} from "../assets/video-preview.mjs";
const mapping={times_ms:[0,40,110,150],shift_xy:[[0,0],[15,-8],[-5,10],[0,0]],padding_xy:[24,18],source_offset_ms:1250};
for(const [i,time] of mapping.times_ms.entries()){
    const original=[100+i,75-i],shift=mapping.shift_xy[i];
    const stabilized=original.map((v,j)=>v+mapping.padding_xy[j]-shift[j]);
    assert.deepEqual(originalPixel(mapping,stabilized,time),original);
    assert.equal(previewTimelineTime(previewMediaTime(time,"original",mapping),"original",mapping),time);
    assert.equal(previewMediaTime(time,"stabilized",mapping),time/1000);
}
// Variable frame timing uses the displayed frame's transform, not an interpolation.
assert.deepEqual(previewShift(mapping,109),[15,-8]);
assert.deepEqual(previewShift(mapping,110),[-5,10]);
assert.deepEqual(previewShift(mapping,999),[0,0]);
assert.equal(previewMediaTime(240,"original",null),.24);
// Source files may start at a nonzero presentation timestamp. Actions stay relative.
assert.equal(previewMediaTime(240,"stabilized",null,2000),2.24);
assert.equal(previewTimelineTime(2.24,"stabilized",null,2000),240);
assert.equal(previewMediaTime(240,"stabilized",mapping,2000),.24);
assert.equal(previewMediaTime(240,"original",mapping,2000),1.49);
console.log("Video preview: original pixel recovery, frame timing and trimmed timeline round trips passed");

const {timelineOutputURL,timelineRenderCatalog,timelineRenderCurrent,timelineRenderAt}=await import('../assets/video-preview.mjs');
const session='a'.repeat(32),base='http://localhost/prefix/sam3d_funscript/assets/processing-timeline.html';
const region={id:'r',start_ms:1250,end_ms:3000,reference:{points:[[1,2]],crop_xywh:[0,0,100,100],sections:[]},agreement_pixels:12,max_step_pixels:48};
const result={source_id:'source',stabilization:{r:{region,video_path:`/output/sam3d_funscript/processing/${session}/reference/${'b'.repeat(24)}/stabilized.mp4`}}};
const [render]=timelineRenderCatalog(result,session,'source',base);
assert.equal(new URL(render.url).pathname,'/prefix/view');
assert.equal(new URL(render.url).searchParams.get('filename'),'stabilized.mp4');
assert.equal(timelineRenderAt([render],{stabilization:[region]},1250),render);
assert.equal(timelineRenderAt([render],{stabilization:[region]},3000),null,'exclusive end does not hold previous render');
assert.equal(timelineRenderAt([render],{stabilization:[{...region,enabled:false}]},2000),null);
assert.equal(timelineRenderCurrent(render,{...region,name:'Renamed',locked:true}),true);
assert.equal(timelineRenderCurrent(render,{...region,reference:{...region.reference,points:[[3,4]]}}),false);
assert.deepEqual(timelineRenderCatalog(result,session,'other-source',base),[]);
assert.deepEqual(timelineRenderCatalog(result,'c'.repeat(32),'source',base),[],'another session cannot supply the render');
assert.throws(()=>timelineOutputURL(session,'../secret.json',base));
console.log('Timeline renders: original-clock coverage, stale settings and source/session isolation passed');

const {timelineTrackingHealth,trackingFrame,trackingSummary,trackingReason}=await import('../assets/video-preview.mjs');
const source={path:'source.mp4',size:100,mtime_ns:123};
const manifest={id:render.referenceId,state:'ready',info:{source},data:{source_times_ms:[1250,1280,1350,1400,1600],quality:['tracked','held','held','manual','held'],shift_xy:[[0,0],[0,0],[0,0],[10,0],[10,0]]}};
const health=timelineTrackingHealth(manifest,render,source);
assert.deepEqual(health.gaps,[1280,1600]);assert.equal(health.counts.held,3);
assert.equal(trackingFrame(health,1349),1,'VFR selects preceding frame');assert.equal(trackingFrame(health,1350),2);
assert.equal(trackingFrame(health,3000),null);assert.equal(trackingFrame(health,1200),null);
assert.match(trackingSummary(health),/3 held \/ 5 frames \(60.0% held\)/);
assert.match(trackingReason('points_disagree'),/disagree/);
assert.throws(()=>timelineTrackingHealth(manifest,render,{...source,path:'another.mp4'}),/do not match/);
assert.throws(()=>timelineTrackingHealth({...manifest,id:'wrong'},render,source),/do not match/);
console.log('Tracking feedback: held coverage, VFR frame lookup, reasons and source identity passed');
