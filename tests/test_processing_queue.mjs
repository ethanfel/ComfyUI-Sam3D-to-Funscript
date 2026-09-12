// Exercise the real workflow bridge with a synthetic graph, without ComfyUI.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {errorMessage,queueReferenceTracking} from '../web/reference-queue.mjs';
const origin='http://localhost',session='a'.repeat(32),handlers=new Map(),replies=[];
const win={closed:false,location:{origin},postMessage:data=>replies.push(data)};
const node={id:1,type:'S3F_ProcessingTimeline',properties:{s3f_timeline_session:session},widgets:[{name:'plan_json',value:'{}'}],s3fTimelineStatus:{},setDirtyCanvas(){}};
const app={graph:{_nodes:[node],getNodeById:()=>node,change(){}},queuePrompt(){},registerExtension(extension){this.extension=extension},
 graphToPrompt:async()=>({output:{1:{class_type:'S3F_ProcessingTimeline',inputs:{operation:'prepare',plan_json:node.widgets[0].value}},2:{class_type:'S3F_StandaloneExport',inputs:{project_0:['1',0]}}},workflow:{nodes:[]}})};
let attached,prepared=0,notified=0,queued;
class API extends EventTarget{
 fetchApi=async()=>({ok:true,json:async()=>({editor_session:'b'.repeat(32),project:'authored'})});
 async queuePrompt(number,prompt,options){
  queued={prompt,options};const detail={prompt_id:'synthetic',node:'1',output:{s3f_timeline:[session],s3f_timeline_status:['Tracking complete'],s3f_anchor_preview:[{frame:3,anchors:[{name:'pelvis'}]}]}};
  this.dispatchEvent(new CustomEvent('executed',{detail}));this.dispatchEvent(new CustomEvent('execution_success',{detail}));
  return {prompt_id:'synthetic'};
 }
}
const api=new API();
const deps={app,api,queueReferenceTracking,errorMessage,prepareEditorSessions:async()=>prepared++,notifyEditorRun:()=>notified++,
 prepareNodeSessions:()=>new Set(),migrateCutSensitivity(){},openWorkspace(){},refreshWorkspaces(){},
 registerWorkspaceTool:(name,tool)=>attached=tool,
 window:{addEventListener:(name,fn)=>handlers.set(name,fn)},location:{origin}};
const source=fs.readFileSync(new URL('../web/processing-timeline.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
new Function(...Object.keys(deps),source)(...Object.values(deps));
app.extension.setup();attached.attach(node,win);
const plan={tracking:[],stabilization:[{id:'s1',enabled:true},{id:'s2',enabled:true}],selected_ids:['s2'],selection:[9000,10000]};
await handlers.get('message')({origin,source:win,data:{type:'s3f-timeline-process',node:1,session,request:'request',operation:'stabilize',stabilization_id:'s1',revision:4,plan}});
assert.equal(replies.at(-1).state,'complete',JSON.stringify(replies));
assert.deepEqual(queued.options.partialExecutionTargets,['1']);
assert.equal(queued.prompt.output[1].inputs.operation,'stabilize');
assert.deepEqual(JSON.parse(queued.prompt.output[1].inputs.plan_json),{revision:4,plan,stabilization_ids:['s1']});
assert.deepEqual(JSON.parse(node.widgets[0].value),{revision:4,plan},'workflow keeps original selection and no one-shot operation');
assert.equal(prepared,0,'reference tracking must not flush motion editor sessions');assert.equal(notified,0,'reference tracking must not reload motion editors');
queued=null;
await handlers.get('message')({origin,source:win,data:{type:'s3f-timeline-process',node:1,session,request:'bad',operation:'stabilize',stabilization_id:'missing',plan}});
assert.equal(queued,null);assert.match(replies.at(-1).error,/enabled stabilization/);
console.log('Timeline bridge: reference-only target, partial execution, preserved selection and motion editors passed');

for(const operation of ['propagate_mask','extract_anchors']){
 await handlers.get('message')({origin,source:win,data:{type:'s3f-timeline-process',node:1,session,request:operation,operation,stabilization_id:'s1',revision:4,plan}});
 assert.equal(replies.at(-1).state,'complete',JSON.stringify(replies));
 assert.equal(queued.prompt.output[1].inputs.operation,operation);
 assert.deepEqual(JSON.parse(queued.prompt.output[1].inputs.plan_json).stabilization_ids,['s1']);
 assert.deepEqual(JSON.parse(node.widgets[0].value),{revision:4,plan});
 if(operation==='propagate_mask'){assert.equal(prepared,0);assert.equal(notified,0);}
 else {assert.equal(prepared,1);assert.equal(notified,1);}
}
console.log('Mask propagation bypasses motion editors; anchor extraction targets the same region and updates motion');

const previewPlan={...plan,tracking:[{id:'t',start_ms:0,end_ms:2000,locked:true}]},request={region_id:'t',at_ms:100};
const preparedBefore=prepared,notifiedBefore=notified;
await handlers.get('message')({origin,source:win,data:{type:'s3f-timeline-process',node:1,session,request:'preview',operation:'preview_anchor',anchor_preview:request,revision:4,plan:previewPlan}});
assert.equal(replies.at(-1).state,'complete');assert.equal(replies.at(-1).anchor_preview.frame,3);
assert.deepEqual(queued.options.partialExecutionTargets,['1']);
assert.equal(queued.prompt.output[1].inputs.operation,'preview_anchor');
assert.deepEqual(JSON.parse(queued.prompt.output[1].inputs.plan_json),{revision:4,plan:previewPlan,anchor_preview:request});
assert.deepEqual(JSON.parse(node.widgets[0].value),{revision:4,plan:previewPlan},'frame request does not get saved as a workflow operation');
assert.equal(prepared,preparedBefore);assert.equal(notified,notifiedBefore);
for(const bad of [{region_id:'missing',at_ms:100},{region_id:'t',at_ms:2000},{region_id:'t',at_ms:NaN}]){
 queued=null;await handlers.get('message')({origin,source:win,data:{type:'s3f-timeline-process',node:1,session,request:'bad-preview',operation:'preview_anchor',anchor_preview:bad,plan:previewPlan}});
 assert.equal(queued,null);assert.match(replies.at(-1).error,/enabled tracking region/);
}
console.log('Anchor preview: locked-region inspection, exact one-shot frame, no motion editor refresh, and invalid-frame rejection passed');
for(const processing_scope of [{kind:'range',range:[1000,2000]},{kind:'regions',ids:['s1']}]){
 await handlers.get('message')({origin,source:win,data:{type:'s3f-timeline-process',node:1,session,request:'scope',operation:'scoped_selected',processing_scope,revision:4,plan}});
 assert.equal(replies.at(-1).state,'complete');
 assert.equal(queued.prompt.output[1].inputs.operation,'selected');
 assert.deepEqual(JSON.parse(queued.prompt.output[1].inputs.plan_json),{revision:4,plan,processing_scope});
 assert.deepEqual(JSON.parse(node.widgets[0].value),{revision:4,plan},'one-shot scope does not alter the saved marks');
}
console.log('Explicit range/region scopes reach execution without changing workflow selection');
queued=null;
await handlers.get('message')({origin,source:win,data:{type:'s3f-timeline-process',node:1,session,request:'missing-scope',operation:'scoped_selected',revision:4,plan}});
assert.equal(queued,null);assert.match(replies.at(-1).error,/marked range or selected regions/);

const beforeAutomatic={prepared,notified};
await handlers.get('message')({origin,source:win,data:{type:'s3f-timeline-process',node:1,session,request:'auto',operation:'automatic',revision:4,plan,automatic_options:{people:'all'},cut_sensitivity:'high'}});
assert.equal(replies.at(-1).state,'complete',JSON.stringify(replies.at(-1)));
assert.equal(queued.prompt.output[1].inputs.operation,'automatic');
assert.equal(queued.prompt.output[1].inputs.cut_sensitivity,'high');
assert.deepEqual(JSON.parse(queued.prompt.output[1].inputs.plan_json),{revision:4,plan,automatic_options:{people:'all'}});
assert.deepEqual(JSON.parse(node.widgets[0].value),{revision:4,plan});
assert.equal(prepared,beforeAutomatic.prepared+1);assert.equal(notified,beforeAutomatic.notified+1);
console.log('Automatic pass forwards people and cut settings, flushes edits, and preserves the saved selection');
