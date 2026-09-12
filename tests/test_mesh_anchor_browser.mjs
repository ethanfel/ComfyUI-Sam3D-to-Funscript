// UI contract/gesture test: neutral video, isolated HTTP server and disposable browser.
// The GPU/backend integration is tested separately against ComfyUI.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {spawn,spawnSync} from 'node:child_process';
const root=path.resolve('.'),temporary=fs.mkdtempSync(path.join(os.tmpdir(),'s3f-timeline-browser-'));
const clip=path.join(temporary,'neutral.mp4');
const ffmpeg=spawnSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=160x120:rate=2','-t','60','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-movflags','+faststart',clip]);
assert.equal(ffmpeg.status,0,ffmpeg.stderr.toString());
const portraitClip=path.join(temporary,'portrait.mp4'),portraitThumb=path.join(temporary,'portrait.jpg');
for(const args of [
 ['-v','error','-f','lavfi','-i','testsrc2=size=180x320:rate=2','-t','10','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-movflags','+faststart',portraitClip],
 ['-v','error','-i',portraitClip,'-frames:v','1',portraitThumb]
]){const result=spawnSync('ffmpeg',args);assert.equal(result.status,0,result.stderr.toString());}

const stabilizedClip=path.join(temporary,'stabilized.mp4');
const stableEncode=spawnSync('ffmpeg',['-v','error','-i',portraitClip,'-t','2.5','-vf','pad=220:360:20:20:color=black','-an','-c:v','libx264','-preset','ultrafast','-movflags','+faststart',stabilizedClip]);assert.equal(stableEncode.status,0,stableEncode.stderr.toString());
const session='1234567890abcdef1234567890abcdef';
let state={session,revision:1,info:{source_id:'neutral',source:{path:'neutral-test.mp4'},start:'0',duration:'3600',source_origin:'0',rate:'30',width:160,height:120,end_ms:3600000},plan:{version:1,source_id:'neutral',tracking:[{id:'t0',name:'Full video',start_ms:0,end_ms:3600000,enabled:true,locked:false,anchor:'pelvis',person:0,rois:[[0,0,1,1]],smoothing_ms:80,settings:{}}],stabilization:[],selection:[0,0],selected_ids:[],join_ms:200,gap_policy:'hold',chunk_seconds:30},report:null,project:null,editor_session:'shared-motion-session'};
let seenProcess=null,apiRequests=0,renderedState=null,referenceSaved=null,referenceCapabilities=true,trackCapabilities=true,maskCapabilities=true,meshCapabilities=true,previewCapabilities=true,cropCapabilities=true;
const referenceState={id:'neutral-reference',info:{source_id:'neutral-reference-source',width:160,height:120,source_origin:'0',rate:'2'},config:{crop_xywh:[0,0,160,120],points:[],sections:[]},frame_index:{times_ms:Array.from({length:120},(_,i)=>i*500)}};
const parentHtml=`<!doctype html><button id="open" onclick="window.editor=window.open('/sam3d_funscript/assets/processing-timeline.html?session=${session}&node=1')">Open editor</button><script>
window.events=[];window.addEventListener('message',async e=>{const d=e.data;window.events.push(d);if(d.type==='s3f-reference-apply'){await fetch('/test/reference-save',{method:'POST',body:JSON.stringify(d.config)});e.source.postMessage({type:'s3f-reference-applied',request:d.request},location.origin);return;}if(d.type==='s3f-timeline-apply'){setTimeout(()=>e.source.postMessage({type:'s3f-timeline-applied',request:d.request},location.origin),150)}if(d.type==='s3f-timeline-process'){if(window.rejectCuts&&d.operation==='detect_cuts'||window.rejectScopes&&d.operation==='scoped_selected'){e.source.postMessage({type:'s3f-timeline-progress',request:d.request,state:'error',error:'Unknown timeline operation'},location.origin);return;}window.lastProcess=d;const result=await(await fetch('/test/process',{method:'POST',body:JSON.stringify(d)})).json();e.source.postMessage({type:'s3f-timeline-progress',request:d.request,state:'queued',text:'Queued neutral test'},location.origin);setTimeout(()=>e.source.postMessage({type:'s3f-timeline-progress',request:d.request,state:'complete',text:'Complete',anchor_preview:result.anchor_preview},location.origin),500)}if(d.type==='s3f-timeline-cancel')e.source.postMessage({type:'s3f-timeline-progress',request:d.request,state:'error',error:'Cancelled'},location.origin)});
</script>`;
const mime={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.mp4':'video/mp4'};
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname==='/'){res.setHeader('Content-Type','text/html');res.end(parentHtml);return;}
 if(url.pathname==='/sam3d_funscript/reference-capabilities'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({subject_crop:cropCapabilities?1:0,timeline_scope:1,keyframes:referenceCapabilities?1:0,timeline_stabilize:trackCapabilities?1:0,reference_masks:maskCapabilities?1:0,mask_anchors:meshCapabilities?1:0,anchor_preview:previewCapabilities?1:0}));return;}
 if(url.pathname==='/test/reference-save'){let body='';for await(const part of req)body+=part;referenceSaved=JSON.parse(body);res.end('{}');return;}
 if(url.pathname==='/sam3d_funscript/reference/neutral-reference'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(referenceState));return;}
 if(url.pathname==='/test/process'){let body='';for await(const part of req)body+=part;seenProcess=JSON.parse(body);if(seenProcess.operation==='preview_anchor'){
  const request=seenProcess.anchor_preview,r=seenProcess.plan.tracking.find(r=>r.id===request.region_id);
  const anchors=[r.anchor,...(r.additional_anchors||[])].map((name,i)=>({name,primary:i===0,available:true,pixel:[90+i*20,150],indices:[],position:[0,0,2]}));
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({anchor_preview:{...request,source_id:state.info.source_id,frame:request.at_ms/500,person:r.person,width:180,height:320,anchors,surface:r.anchor==='mask_anchor'?[[82,142],[98,142],[90,158]]:[],surface_points:r.anchor==='mask_anchor'?3:0,landmarks:[],reference_at_ms:r.mask_anchor?.frame*500}}));return;
 }if(seenProcess.operation==='propagate_mask'){const region=state.plan.stabilization.find(r=>r.id===seenProcess.stabilization_id),mask=region.reference.point_mask;renderedState={...renderedState,source_id:state.info.source_id,masks:{[region.id]:{id:'b'.repeat(24),region:structuredClone(region),mask:{frame:mask.frame,strokes:mask.strokes,model:mask.model},frames:5}}};res.end('{}');return;}if(seenProcess.operation==='stabilize'){const region=state.plan.stabilization.find(r=>r.id===seenProcess.stabilization_id);renderedState={...renderedState,source_id:state.info.source_id,stabilization:{[region.id]:{region:structuredClone(region),video_path:`/output/sam3d_funscript/processing/${session}/reference/${'a'.repeat(24)}/stabilized.mp4`}}};res.end('{}');return;}if(seenProcess.operation==='detect_cuts'){state.scene_cuts={source_id:state.info.source_id,times_ms:[5000.125,17000,40000],settings:{sensitivity:seenProcess.cut_sensitivity}};res.end('{}');return;}state.report={regions:state.plan.tracking.map(r=>({...r,state:'complete',region:structuredClone(r),stabilization_regions:state.plan.stabilization.filter(s=>s.enabled!==false&&s.start_ms<r.end_ms&&s.end_ms>r.start_ms)})),warnings:[],completed_jobs:1,total_jobs:1};state.project='neutral_test';res.end('{}');return;}
 if(url.pathname===`/sam3d_funscript/timelines/${session}`){apiRequests++;res.setHeader('Content-Type','application/json');if(req.method==='POST'){let body='';for await(const part of req)body+=part;const sent=JSON.parse(body);if(sent.revision!==state.revision){res.statusCode=409;res.setHeader('Content-Type','text/plain');res.end('stale revision');return;}state={...state,revision:state.revision+1,plan:sent.plan};}res.end(JSON.stringify(state));return;}
 if(url.pathname==='/view'&&url.searchParams.get('filename')==='state.json'){res.setHeader('Content-Type','application/json');if(!renderedState){res.statusCode=404;res.end('{}');}else res.end(JSON.stringify(renderedState));return;}
 if(url.pathname==='/view'&&url.searchParams.get('filename')==='reference.json'){
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:'a'.repeat(24),state:'ready',info:{source:state.info.source},video:{padding_xy:[20,20]},data:{source_times_ms:[2000,2500,3000,3500,4000],quality:['tracked','tracked','held','held','tracked'],shift_xy:[[0,0],[10,0],[10,0],[10,0],[40,0]],points:Array.from({length:5},(_,i)=>[[40+i*10,60],[70+i*10,70],[100+i*10,60]]),visible:[[true,true,true],[true,true,true],[true,true,false],[true,true,false],[true,true,true]],reasons:['consensus','consensus','insufficient_visible_points','insufficient_visible_points','consensus']}}));return;
 }
 if(url.pathname.endsWith('/frames')){const rate=state.info.source_id==='portrait'?2:30,first=Math.ceil(Number(state.info.start)*rate),end=Math.ceil(state.info.end_ms/1000*rate);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({source_id:state.info.source_id,first_frame:first,end_frame:end,times_ms:Array.from({length:end-first},(_,i)=>(i+first)*1000/rate),end_ms:state.info.end_ms}));return;}
 if(url.pathname.includes('/masks/')){res.setHeader('Content-Type','image/jpeg');res.end(fs.readFileSync(portraitThumb));return;}
 if(url.pathname.endsWith('/thumbnail')){if(state.info.source_id==='portrait'){res.setHeader('Content-Type','image/jpeg');res.end(fs.readFileSync(portraitThumb));}else{res.statusCode=404;res.end();}return;}
 let file;if(url.pathname.endsWith('/video/source'))file=clip;else if(url.pathname==='/view'&&url.searchParams.get('filename')==='stabilized.mp4')file=stabilizedClip;else if(url.pathname.endsWith('/video'))file=state.info.source_id==='portrait'?portraitClip:clip;else if(url.pathname.startsWith('/sam3d_funscript/assets/'))file=path.join(root,'assets',path.basename(url.pathname));
 if(!file||!fs.existsSync(file)){res.statusCode=404;res.end();return;}
 const buffer=fs.readFileSync(file);res.setHeader('Content-Type',mime[path.extname(file)]||'application/octet-stream');
 const range=req.headers.range?.match(/bytes=(\d+)-(\d*)/);if(range){const start=Number(range[1]),end=range[2]?Math.min(Number(range[2]),buffer.length-1):buffer.length-1;res.writeHead(206,{'Content-Range':`bytes ${start}-${end}/${buffer.length}`,'Accept-Ranges':'bytes','Content-Length':end-start+1});res.end(buffer.subarray(start,end+1));}else res.end(buffer);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
const profile=path.join(temporary,'chrome'),chrome=spawn('/opt/google/chrome/chrome',['--headless','--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--disable-popup-blocking','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore'});
const wait=ms=>new Promise(r=>setTimeout(r,ms));async function until(fn,label){for(let i=0;i<200;i++){if(await fn())return;await wait(50);}throw new Error('Timed out: '+label);}
const sockets=[],errors=[];let browserPort;
async function connect(target){const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));sockets.push(ws);let id=0;const pending=new Map();ws.addEventListener('message',event=>{const m=JSON.parse(event.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);if(p)m.error?p.reject(m.error):p.resolve(m.result);}else if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails);else if(m.method==='Page.javascriptDialogOpening')call('Page.handleJavaScriptDialog',{accept:true});});const call=(method,params={})=>new Promise((resolve,reject)=>{const key=++id;const timer=setTimeout(()=>{pending.delete(key);reject(new Error('Browser command timed out: '+method+' '+JSON.stringify(params).slice(0,250)))},15000);pending.set(key,{resolve:value=>{clearTimeout(timer);resolve(value)},reject:error=>{clearTimeout(timer);reject(error)}});ws.send(JSON.stringify({id:key,method,params}));});const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,userGesture:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;};await call('Runtime.enable');await call('Page.enable');return{call,evaluate};}
state={...state,revision:1,info:{...state.info,source_id:'portrait',source:{path:'portrait.mp4'},width:180,height:320,start:'0',duration:'10',end_ms:10000,rate:'2'},plan:{...state.plan,source_id:'portrait',tracking:[{...state.plan.tracking[0],id:'split-tracking',end_ms:10000}],stabilization:[{id:'mask-source',name:'Stabilization',start_ms:0,end_ms:10000,enabled:true,locked:false,reference:{crop_xywh:[0,0,180,320],points:[],sections:[],point_mask:{frame:1,model:'sam2.1_base_plus',strokes:[{erase:false,radius:12,points:[[45,70],[50,80]]}]}}}],selection:[0,0],selected_ids:['split-tracking']}};
try{
 await until(()=>{try{browserPort=fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0];return browserPort;}catch(_){return false;}},'Chrome start');
 const targets=()=>fetch(`http://127.0.0.1:${browserPort}/json/list`).then(r=>r.json());
 const parent=await connect((await targets()).find(t=>t.type==='page'));await parent.call('Page.navigate',{url:base});await until(()=>parent.evaluate('!!document.querySelector("#open")'),'parent ready').catch(async error=>{console.error(await parent.evaluate('({href:location.href,html:document.documentElement.outerHTML.slice(0,1800)})'));throw error;});await parent.evaluate('document.querySelector("#open").click()');
 let target;await until(async()=>{target=(await targets()).find(t=>t.url.includes('processing-timeline.html'));return target;},'editor popup');
 const page=await connect(target);await page.call('Emulation.setDeviceMetricsOverride',{width:1450,height:1180,deviceScaleFactor:1,mobile:false});
 await until(()=>page.evaluate('document.querySelector("#source")?.readyState>=2&&!document.querySelector("#apply").disabled'),'editor loaded');
 async function click(x,y){for(const type of ['mousePressed','mouseReleased'])await page.call('Input.dispatchMouseEvent',{type,x,y,button:'left',clickCount:1});}
 // Painted custom anchor: canvas gestures, original frame, persistence and split ownership.
 await page.evaluate('document.querySelector("#trackingLane [data-id=split-tracking]").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}));document.querySelector("#anchor").value="mask_anchor";document.querySelector("#anchor").dispatchEvent(new Event("change"));document.querySelector("#previewVariant").value="original";document.querySelector("#previewVariant").dispatchEvent(new Event("change"));document.querySelector("#goTime").value=2;document.querySelector("#seekTime").click();window.scrollTo(0,0)');
 await until(()=>page.evaluate('!document.querySelector("#meshAnchorMark").disabled'),'mask anchor ready');
 assert.equal(await page.evaluate('document.querySelector("#meshAnchorSettings").hidden'),false);
 await page.evaluate('document.querySelector("#meshAnchorMark").click()');
 const meshMap=await page.evaluate('(()=>{const r=document.querySelector("#sourceCanvas").getBoundingClientRect(),s=Math.min(r.width/180,r.height/320);return{x:r.x+(r.width-180*s)/2,y:r.y+(r.height-320*s)/2,s}})()');
 await click(meshMap.x+90*meshMap.s,meshMap.y+150*meshMap.s);
 await page.evaluate('document.querySelector("#apply").click()');
 await until(()=>page.evaluate('document.querySelector("#apply").textContent.includes("Applied")'),'paint saved');
 assert.equal(state.plan.tracking[0].mask_anchor.frame,2);
 assert.equal(state.plan.tracking[0].mask_anchor.strokes.length,1);
 assert.ok(Math.abs(state.plan.tracking[0].mask_anchor.strokes[0].points[0][0]-90)<1);
 assert.ok(Math.abs(state.plan.tracking[0].mask_anchor.strokes[0].points[0][1]-150)<1);
 assert.equal(await page.evaluate('document.querySelectorAll("#trackingLane .reference-keyframe").length'),1);

 // Single-frame previews use one-shot queue requests and never replace motion.
 const savedMotion={project:state.project,report:structuredClone(state.report)},savedSelection=structuredClone(state.plan.selection);
 await page.evaluate('document.querySelector("#previewAnchor").click()');
 await until(()=>page.evaluate('document.querySelector("#previewAnchor").getAttribute("aria-busy")==="true"'),'anchor preview feedback');
 await until(()=>page.evaluate('document.querySelector("#previewStatus").textContent.startsWith("Anchor preview")'),'anchor overlay');
 assert.equal(seenProcess.operation,'preview_anchor');assert.deepEqual(seenProcess.anchor_preview,{region_id:'split-tracking',at_ms:1000});
 assert.deepEqual({project:state.project,report:state.report},savedMotion);assert.deepEqual(state.plan.selection,savedSelection);
 assert.match(await page.evaluate('document.querySelector("#anchorPreviewStatus").textContent'),/3 mesh vertices/);
 const anchorPixel=()=>page.evaluate('(()=>{const c=document.querySelector("#sourceCanvas"),s=Math.min(c.width/180,c.height/320),p=c.getContext("2d").getImageData(Math.round((c.width-180*s)/2+90*s)-4,Math.round((c.height-320*s)/2+150*s)-4,9,9).data;let count=0;for(let i=0;i<p.length;i+=4)if(p[i]===255&&p[i+1]===212&&p[i+2]===122)count++;return count})()');
 assert.ok(await anchorPixel()>0);
 await page.evaluate('document.querySelector("#showAnchorPreview").click()');assert.equal(await anchorPixel(),0);
 await page.evaluate('document.querySelector("#showAnchorPreview").click();document.querySelector("#next").click()');
 await until(()=>page.evaluate('!document.querySelector("#source").seeking&&!document.querySelector("#previewAnchor").disabled'),'next frame');
 assert.ok(!await page.evaluate('document.querySelector("#previewStatus").textContent.startsWith("Anchor preview")'),'preview does not follow the wrong frame');
 await page.evaluate('document.querySelector("#previous").click()');
 await until(()=>page.evaluate('document.querySelector("#previewStatus").textContent.startsWith("Anchor preview")'),'return to preview frame');
 fs.mkdirSync('development/anchor-preview-browser',{recursive:true});
 fs.writeFileSync('development/anchor-preview-browser/painted-preview.png',Buffer.from((await page.call('Page.captureScreenshot')).data,'base64'));
 await page.evaluate('document.querySelector("#regionLock").click()');
 assert.equal(await page.evaluate('document.querySelector("#previewAnchor").disabled'),false,'locked region permits inspection');
 await page.evaluate('document.querySelector("#previewAnchor").click()');
 await until(()=>page.evaluate('!document.querySelector("#cancelAnchorPreview").hidden'),'preview cancel available');
 await page.evaluate('document.querySelector("#cancelAnchorPreview").click()');
 await until(()=>page.evaluate('document.querySelector("#status").textContent==="Anchor preview stopped"'),'preview cancelled');
 assert.deepEqual({project:state.project,report:state.report},savedMotion);
 await page.evaluate('document.querySelector("#regionLock").click();document.querySelector("#anchor").value="left_hand";document.querySelector("#anchor").dispatchEvent(new Event("change"))');
 assert.ok(!await page.evaluate('document.querySelector("#previewStatus").textContent.startsWith("Anchor preview")'),'changed anchor clears overlay');
 await page.evaluate('document.querySelector("#additionalAnchors input[value=mouth]").click();document.querySelector("#previewAnchor").click()');
 await until(()=>page.evaluate('document.querySelector("#previewStatus").textContent.startsWith("Anchor preview")'),'anatomical anchor preview');
 assert.equal(seenProcess.plan.tracking[0].anchor,'left_hand');assert.ok(seenProcess.plan.tracking[0].additional_anchors.includes('mouth'));
 await page.evaluate('document.querySelector("#anchor").value="mask_anchor";document.querySelector("#anchor").dispatchEvent(new Event("change"))');
 previewCapabilities=false;seenProcess=null;
 await page.evaluate('document.querySelector("#previewAnchor").click()');
 await until(()=>page.evaluate('document.querySelector("#error").textContent.includes("Restart ComfyUI to enable anchor previews")'),'preview backend capability error');
 assert.equal(seenProcess,null);previewCapabilities=true,cropCapabilities=true;
 await page.evaluate('document.querySelector("#apply").click()');await until(()=>page.evaluate('document.querySelector("#apply").textContent.includes("Applied")'),'preview plan saved');
 console.log('Anchor preview browser: current frame, painted surface, additional anchors, show/hide, frame changes, locks, cancellation, output preservation and old backend feedback passed');
 const paintSaved=structuredClone(state.plan.tracking[0].mask_anchor),meshReload=await page.evaluate('performance.timeOrigin');
 await page.call('Page.reload');await until(()=>page.evaluate(`performance.timeOrigin!==${meshReload}&&!document.querySelector("main").inert&&document.querySelector("#source").readyState>=2&&document.querySelector("#meshAnchorStatus").textContent.includes("F ")&&!document.querySelector("#meshAnchorGo").disabled`),'paint reload');
 await page.evaluate('document.querySelector("#meshAnchorGo").click()');
 await until(()=>page.evaluate('!document.querySelector("#meshAnchorMark").disabled'),'reference seek');
 assert.deepEqual(state.plan.tracking[0].mask_anchor,paintSaved);
 await page.evaluate('document.querySelector("#meshAnchorTool").value="erase"');
 const meshMap2=await page.evaluate('(()=>{const r=document.querySelector("#sourceCanvas").getBoundingClientRect(),s=Math.min(r.width/180,r.height/320);return{x:r.x+(r.width-180*s)/2,y:r.y+(r.height-320*s)/2,s}})()');
 await click(meshMap2.x+90*meshMap2.s,meshMap2.y+150*meshMap2.s);
 await page.evaluate('document.querySelector("#meshAnchorUndo").click();document.querySelector("#apply").click()');
 await until(()=>page.evaluate('document.querySelector("#apply").textContent.includes("Applied")'),'erase undo');
 assert.deepEqual(state.plan.tracking[0].mask_anchor,paintSaved);
 await page.evaluate('document.querySelector("#regionLock").click()');
 assert.equal(await page.evaluate('document.querySelector("#meshAnchorMark").disabled&&document.querySelector("#meshAnchorTool").disabled'),true);
 assert.equal(await page.evaluate('document.querySelector("#meshAnchorGo").disabled'),false);
 await page.evaluate('document.querySelector("#regionLock").click();document.querySelector("#meshAnchorReuse").click();document.querySelector("#apply").click()');
 await until(()=>page.evaluate('document.querySelector("#apply").textContent.includes("Applied")'),'reused stabilization mask');
 assert.deepEqual(state.plan.tracking[0].mask_anchor.strokes,state.plan.stabilization[0].reference.point_mask.strokes);
 const independentMask=structuredClone(state.plan.stabilization[0].reference.point_mask);
 await page.evaluate('document.querySelector("#meshAnchorClear").click();document.querySelector("#apply").click()');
 await until(()=>page.evaluate('document.querySelector("#apply").textContent.includes("Applied")'),'cleared anchor paint');
 assert.deepEqual(state.plan.stabilization[0].reference.point_mask,independentMask,'anchor edits leave stabilization mask unchanged');
 await page.evaluate('document.querySelector("#undo").click();document.querySelector("#goTime").value=10;document.querySelector("#seekTime").click()');
 await until(()=>page.evaluate('!document.querySelector("#source").seeking'),'mask split seek');
 await page.evaluate('document.querySelector("#split").click();document.querySelector("#apply").click()');
 await until(()=>page.evaluate('document.querySelector("#apply").textContent.includes("Applied")'),'mask split saved');
 assert.ok(state.plan.tracking[0].mask_anchor);
 assert.equal(state.plan.tracking[1].mask_anchor,undefined);
 assert.match(await page.evaluate('document.querySelector("#meshAnchorStatus").textContent'),/Choose a clear frame/);
 meshCapabilities=false;
 await page.evaluate('document.querySelector("#regionName").value="backend capability check";document.querySelector("#regionName").dispatchEvent(new Event("change"));document.querySelector("#apply").click()');
 await until(()=>page.evaluate('document.querySelector("#error").textContent.includes("Restart ComfyUI to enable painted 3D anchors")'),'old backend keeps draft');
 meshCapabilities=true;
 fs.mkdirSync('development/mask-anchor-browser',{recursive:true});
 await page.evaluate('document.querySelector("#trackingLane .region-bar").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}));document.querySelector("#meshAnchorGo").click();window.scrollTo(0,0)');
 await until(()=>page.evaluate('!document.querySelector("#source").seeking'),'final mask preview');
 fs.writeFileSync('development/mask-anchor-browser/painted-anchor.png',Buffer.from((await page.call('Page.captureScreenshot')).data,'base64'));
 console.log('Painted anchor browser checks passed: paint, erase, Undo, reload, exact frame, locks, mask reuse, independent edits, splits, old backend recovery');
 await page.evaluate("window.s3fTimelineApply()");
 // Audit regressions use a fresh plan in the same isolated browser.
 const track={id:'audit-a',name:'First',start_ms:0,end_ms:5000,enabled:true,locked:false,anchor:'pelvis',additional_anchors:[],person:0,rois:[[0,0,1,1]],smoothing_ms:30,settings:{}};
 state={...state,revision:state.revision+1,report:{regions:[{...track,state:'complete',region:structuredClone(track),stabilization_regions:[]}]},plan:{version:1,source_id:'portrait',tracking:[track,{...structuredClone(track),id:'audit-b',name:'Second',start_ms:5000,end_ms:10000}],stabilization:[{id:'audit-s',name:'Reference',start_ms:0,end_ms:10000,enabled:false,locked:false,reference:{crop_xywh:[0,0,180,320],points:[],sections:[],point_mask:{frame:1,model:'sam2.1_base_plus',strokes:[{erase:false,radius:12,points:[[60,80]]}]}}}],selection:[0,0],selected_ids:['audit-a'],join_ms:200,gap_policy:'hold',chunk_seconds:30}};renderedState=null;
 await page.evaluate(`localStorage.removeItem('s3f-processing-timeline:${session}')`);await page.call('Page.reload');
 await until(()=>page.evaluate('document.querySelector("#source")?.readyState>=2&&!document.querySelector("main").inert&&document.querySelector("#regionName").value==="First"'),'audit fixture');
 const ui=page.evaluate,press=id=>ui(`document.getElementById(${JSON.stringify(id)}).click()`),set=(id,value)=>ui(`(()=>{const e=document.getElementById(${JSON.stringify(id)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change'));})()`),select=id=>ui(`document.querySelector('[data-id=${id}]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`);
 const saved=async()=>{await press('apply');await until(()=>ui('document.getElementById("apply").textContent.includes("Applied")'),'audit apply');};
 assert.equal(await ui('document.querySelector("#trackingLane [data-id=audit-a] .region-state").textContent'),'complete');
 await set('anchor','mouth');assert.equal(await ui('document.querySelector("#trackingLane [data-id=audit-a] .region-state").textContent'),'needs processing');await press('undo');
 await set('selectionIn',8);assert.equal(await ui('document.getElementById("selectionIn").value'),'8');assert.equal(await ui('document.getElementById("selectionOut").value'),'8');await set('selectionOut',9);await select('audit-a');
 assert.match(await ui('document.getElementById("rangeSummary").textContent'),/F 8.*F 9/);
 await parent.evaluate('window.rejectScopes=true');seenProcess=null;await press('processRegions');await until(()=>ui('document.getElementById("error").textContent.includes("Refresh the main ComfyUI tab")'),'old bridge scope rejected');assert.equal(seenProcess,null);await parent.evaluate('window.rejectScopes=false');
 await press('processRegions');await until(()=>seenProcess?.processing_scope?.kind==='regions','explicit region scope');assert.deepEqual(seenProcess.processing_scope.ids,['audit-a']);assert.deepEqual(seenProcess.plan.selection,[4000,4500]);
 await until(()=>ui('document.getElementById("progressText").textContent==="Processing complete"'),'region scope complete');
 await press('processSelected');await until(()=>seenProcess?.processing_scope?.kind==='range','explicit marked scope');assert.deepEqual(seenProcess.processing_scope.range,[4000,4500]);
 await until(()=>ui('document.getElementById("progressText").textContent==="Processing complete"'),'range complete');
 await select('audit-s');await press('regionEnabled');await press('maskStepTab');await press('maskGoSeed');await until(()=>ui('!document.getElementById("source").seeking'),'mask reference');await set('maskTool','paint');await press('timelineToolsTab');
 const center=await ui('(()=>{const r=document.getElementById("sourceCanvas").getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()');await click(center.x,center.y);await saved();
 assert.equal(state.plan.stabilization[0].reference.point_mask.strokes.length,1,'hidden mask tools cannot paint');assert.equal(await ui('document.getElementById("previewTool").textContent'),'Review');
 await select('audit-s');await set('regionOut',19);await saved();assert.equal(state.plan.stabilization[0].reference.point_mask.frame,1,'trimming Out keeps the mask on its original frame');await press('undo');
 assert.equal(await ui('document.getElementById("trackStabilization").disabled'),true,'missing points is shown before clicking Track');
 await select('audit-a');await set('anchor','mask_anchor');await press('meshAnchorMark');
 const pixel=await ui('(()=>{const r=document.querySelector("#sourceCanvas").getBoundingClientRect(),s=Math.min(r.width/180,r.height/320);return{x:r.x+r.width/2,y:r.y+r.height/2,s}})()');await click(pixel.x,pixel.y);await saved();
 const seed=structuredClone(state.plan.tracking[0].mask_anchor);await set('regionOut',9);await saved();assert.deepEqual(state.plan.tracking[0].mask_anchor,seed);await press('undo');await saved();
 // The visual person editor updates a real normalized ROI and its selector.
 await set('anchor','pelvis');await ui('document.getElementById("subjectDetails").open=true');await set('subjectTool','add');
 const at=await ui('(()=>{const r=document.querySelector("#sourceCanvas").getBoundingClientRect(),s=Math.min(r.width/180,r.height/320);return{x:r.x+(r.width-180*s)/2,y:r.y+(r.height-320*s)/2,s}})()');
 await page.call('Input.dispatchMouseEvent',{type:'mousePressed',x:at.x+20*at.s,y:at.y+20*at.s,button:'left',clickCount:1});await page.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:at.x+120*at.s,y:at.y+260*at.s,buttons:1});await page.call('Input.dispatchMouseEvent',{type:'mouseReleased',x:at.x+120*at.s,y:at.y+260*at.s,button:'left',clickCount:1});await saved();
 assert.equal(state.plan.tracking[0].rois.length,2);assert.equal(state.plan.tracking[0].person,1);
 // Strict crop and display zoom share source coordinates with painted anchors.
 const otherSection=structuredClone(state.plan.tracking[1]);
 await press('cropPerson');await until(()=>ui('!document.getElementById("source").seeking&&!document.getElementById("subjectTool").disabled'),'crop drawing ready');
 assert.equal(await ui('document.getElementById("subjectTool").value'),'replace');
 const drawCrop=async(a,b)=>{
  const m=await ui('(()=>{const r=document.querySelector("#sourceCanvas").getBoundingClientRect(),s=Math.min(r.width/180,r.height/320);return{x:r.x+(r.width-180*s)/2,y:r.y+(r.height-320*s)/2,s}})()');
  await page.call('Input.dispatchMouseEvent',{type:'mousePressed',x:m.x+a[0]*m.s,y:m.y+a[1]*m.s,button:'left',clickCount:1});
  await page.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:m.x+b[0]*m.s,y:m.y+b[1]*m.s,buttons:1});
  await page.call('Input.dispatchMouseEvent',{type:'mouseReleased',x:m.x+b[0]*m.s,y:m.y+b[1]*m.s,button:'left',clickCount:1});
 };
 await drawCrop([30,40],[140,280]);
 assert.equal(await ui('document.getElementById("personZoom").checked'),true);
 assert.equal(await ui('document.getElementById("isolateSubject").checked'),true);
 cropCapabilities=false;await press('apply');await until(()=>ui('document.getElementById("error").textContent.includes("Restart ComfyUI to enable person crops")'),'old backend retains crop draft');
 assert.equal(state.plan.tracking[0].isolate_subject,undefined);
 cropCapabilities=true;await saved();
 const cropped=state.plan.tracking[0];assert.equal(cropped.isolate_subject,true);assert.equal(cropped.person,1);
 assert.deepEqual(cropped.rois[0],[0,0,1,1]);
 [30/180,40/320,110/180,240/320].forEach((v,i)=>assert.ok(Math.abs(cropped.rois[1][i]-v)<.01));
 assert.deepEqual(state.plan.tracking[1],otherSection,'only the selected section changes');
 const cropRevision=state.revision,cropPlan=structuredClone(state.plan);
 await press('personZoom');await press('personZoom');await wait(100);
 assert.equal(state.revision,cropRevision);assert.deepEqual(state.plan,cropPlan);
 assert.ok(await ui('document.getElementById("apply").textContent.includes("Applied")'),'zoom does not dirty the plan');
 await set('anchor','mask_anchor');await press('meshAnchorMark');
 const zoomCenter=await ui('(()=>{const r=document.getElementById("sourceCanvas").getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()');
 await click(zoomCenter.x,zoomCenter.y);await saved();
 const marked=state.plan.tracking[0].mask_anchor.strokes.at(-1).points[0];
 assert.ok(Math.abs(marked[0]-85)<1&&Math.abs(marked[1]-160)<1,'zoomed paint stays in original source coordinates: '+JSON.stringify(marked));
 await set('anchor','pelvis');seenProcess=null;await press('previewAnchor');
 await until(()=>ui('document.getElementById("anchorPreviewStatus").textContent.includes("original frame")'),'cropped anchor preview');
 assert.equal(seenProcess.plan.tracking[0].isolate_subject,true);
 await press('isolateSubject');assert.match(await ui('document.getElementById("anchorPreviewStatus").textContent'),/Preview shows/,'crop changes invalidate the old anchor overlay');
 await press('isolateSubject');await saved();
 await press('cropPerson');await until(()=>ui('!document.getElementById("subjectTool").disabled'),'redraw from zoom');await drawCrop([20,30],[130,270]);await saved();
 [20/180,30/320,110/180,240/320].forEach((v,i)=>assert.ok(Math.abs(state.plan.tracking[0].rois[1][i]-v)<.01,'redraw uses the full original image'));
 await press('regionLock');assert.equal(await ui('document.getElementById("cropPerson").disabled'),true);
 assert.equal(await ui('document.getElementById("personZoom").disabled'),false);await press('regionLock');await saved();
 // The earlier audit intentionally enabled an unfinished stabilization region.
 await select('audit-s');await press('regionEnabled');await select('audit-a');await saved();
 seenProcess=null;await press('processRegions');await until(()=>seenProcess?.processing_scope?.kind==='regions','cropped section processing');
 assert.equal(seenProcess.plan.tracking[0].isolate_subject,true);
 await until(()=>ui('document.getElementById("progressText").textContent==="Processing complete"'),'cropped section complete');
 const cropPageOrigin=await ui('performance.timeOrigin');await page.call('Page.reload');
 await until(async()=>await ui('performance.timeOrigin')!==cropPageOrigin,'crop page navigation');
 await until(()=>ui('document.getElementById("source")?.readyState>=2&&!document.querySelector("main").inert&&document.getElementById("isolateSubject").checked&&!document.getElementById("source").seeking'),'saved crop reload');
 await press('resetLayout');await select('audit-a');await press('personZoom');
 await until(()=>ui('document.getElementById("previewStatus").textContent.includes("zoomed preview")'),'zoomed crop after reload');
 await ui('window.scrollTo(0,0);new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
 fs.mkdirSync('development/subject-crop-browser',{recursive:true});
 fs.writeFileSync('development/subject-crop-browser/zoomed-person.png',Buffer.from((await page.call('Page.captureScreenshot')).data,'base64'));
 console.log('Subject crop browser checks passed: ROI isolation, preview zoom, source-coordinate paint, redraw, locks, cache freshness, capability checks, processing and reload');
 const backup=structuredClone(state.plan);await set('regionName','Edited later');await saved();
 await ui(`(()=>{const d=new DataTransfer();d.items.add(new File([${JSON.stringify(JSON.stringify(backup))}],'backup.json',{type:'application/json'}));const e=document.getElementById('restoreFile');e.files=d.files;e.dispatchEvent(new Event('change'));})()`);
 await until(()=>ui('document.getElementById("restoreDialog").open'),'restore review');assert.equal(state.plan.tracking[0].name,'Edited later','choosing a backup does not apply it');await press('confirmRestore');await until(()=>ui('!document.getElementById("restoreDialog").open'),'restore draft');
 assert.equal(state.plan.tracking[0].name,'Edited later','restoring a draft does not save until Apply');await saved();assert.equal(state.plan.tracking[0].name,'First');
 fs.mkdirSync('development/timeline-ui-fixes',{recursive:true});
 for(const [width,height] of [[1366,768],[1920,1080]]){
  await page.call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});await press('resetLayout');await ui('window.scrollTo(0,0)');await wait(150);
  const measure=await ui('(()=>{const rect=id=>{const r=document.getElementById(id).getBoundingClientRect();return {top:r.top,bottom:r.bottom,width:r.width,height:r.height}};return {preview:rect("sourceCanvas"),tracking:rect("trackingLane"),stabilization:rect("stabilizationLane"),process:rect("processRegions"),footerTop:document.querySelector(".processing").getBoundingClientRect().top,inspector:document.querySelector(".inspector").getBoundingClientRect().width}})()');
  assert.ok(measure.inspector<=480);assert.ok(measure.preview.width>500);assert.ok(measure.stabilization.bottom<=Math.min(height,measure.footerTop),'both lanes remain visible above the processing controls: '+JSON.stringify(measure));
  fs.writeFileSync(`development/timeline-ui-fixes/layout-${width}.json`,JSON.stringify(measure,null,2));fs.writeFileSync(`development/timeline-ui-fixes/layout-${width}.png`,Buffer.from((await page.call('Page.captureScreenshot')).data,'base64'));
 }
 console.log('Audit browser regressions: hidden paint, preserved trims, explicit scopes, stale output, ROI drawing, staged restore and desktop layouts passed');

 assert.equal(errors.length,0,JSON.stringify(errors));
}finally{for(const socket of sockets)socket.close();chrome.kill('SIGTERM');server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(temporary,{recursive:true,force:true});}
