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
let seenProcess=null,apiRequests=0,renderedState=null,referenceSaved=null,referenceCapabilities=true,trackCapabilities=true,maskCapabilities=true,meshCapabilities=true;
const referenceState={id:'neutral-reference',info:{source_id:'neutral-reference-source',width:160,height:120,source_origin:'0',rate:'2'},config:{crop_xywh:[0,0,160,120],points:[],sections:[]},frame_index:{times_ms:Array.from({length:120},(_,i)=>i*500)}};
const parentHtml=`<!doctype html><button id="open" onclick="window.editor=window.open('/sam3d_funscript/assets/processing-timeline.html?session=${session}&node=1')">Open editor</button><script>
window.events=[];window.addEventListener('message',async e=>{const d=e.data;window.events.push(d);if(d.type==='s3f-reference-apply'){await fetch('/test/reference-save',{method:'POST',body:JSON.stringify(d.config)});e.source.postMessage({type:'s3f-reference-applied',request:d.request},location.origin);return;}if(d.type==='s3f-timeline-apply'){setTimeout(()=>e.source.postMessage({type:'s3f-timeline-applied',request:d.request},location.origin),150)}if(d.type==='s3f-timeline-process'){if(window.rejectCuts&&d.operation==='detect_cuts'){e.source.postMessage({type:'s3f-timeline-progress',request:d.request,state:'error',error:'Unknown timeline operation'},location.origin);return;}window.lastProcess=d;await fetch('/test/process',{method:'POST',body:JSON.stringify(d)});e.source.postMessage({type:'s3f-timeline-progress',request:d.request,state:'queued',text:'Queued neutral test'},location.origin);setTimeout(()=>e.source.postMessage({type:'s3f-timeline-progress',request:d.request,state:'complete',text:'Complete'},location.origin),500)}if(d.type==='s3f-timeline-cancel')e.source.postMessage({type:'s3f-timeline-progress',request:d.request,state:'error',error:'Cancelled'},location.origin)});
</script>`;
const mime={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.mp4':'video/mp4'};
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname==='/'){res.setHeader('Content-Type','text/html');res.end(parentHtml);return;}
 if(url.pathname==='/sam3d_funscript/reference-capabilities'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({keyframes:referenceCapabilities?1:0,timeline_stabilize:trackCapabilities?1:0,reference_masks:maskCapabilities?1:0,mask_anchors:meshCapabilities?1:0}));return;}
 if(url.pathname==='/test/reference-save'){let body='';for await(const part of req)body+=part;referenceSaved=JSON.parse(body);res.end('{}');return;}
 if(url.pathname==='/sam3d_funscript/reference/neutral-reference'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(referenceState));return;}
 if(url.pathname==='/test/process'){let body='';for await(const part of req)body+=part;seenProcess=JSON.parse(body);if(seenProcess.operation==='propagate_mask'){const region=state.plan.stabilization.find(r=>r.id===seenProcess.stabilization_id),mask=region.reference.point_mask;renderedState={...renderedState,source_id:state.info.source_id,masks:{[region.id]:{id:'b'.repeat(24),region:structuredClone(region),mask:{frame:mask.frame,strokes:mask.strokes,model:mask.model},frames:5}}};res.end('{}');return;}if(seenProcess.operation==='stabilize'){const region=state.plan.stabilization.find(r=>r.id===seenProcess.stabilization_id);renderedState={...renderedState,source_id:state.info.source_id,stabilization:{[region.id]:{region:structuredClone(region),video_path:`/output/sam3d_funscript/processing/${session}/reference/${'a'.repeat(24)}/stabilized.mp4`}}};res.end('{}');return;}if(seenProcess.operation==='detect_cuts'){state.scene_cuts={source_id:state.info.source_id,times_ms:[5000.125,17000,40000],settings:{sensitivity:seenProcess.cut_sensitivity}};res.end('{}');return;}state.report={regions:state.plan.tracking.map(r=>({...r,state:'complete'})),warnings:[],completed_jobs:1,total_jobs:1};state.project='neutral_test';res.end('{}');return;}
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
try{
 await until(()=>{try{browserPort=fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0];return browserPort;}catch(_){return false;}},'Chrome start');
 const targets=()=>fetch(`http://127.0.0.1:${browserPort}/json/list`).then(r=>r.json());
 const parent=await connect((await targets()).find(t=>t.type==='page'));await parent.call('Page.navigate',{url:base});await until(()=>parent.evaluate('!!document.querySelector("#open")'),'parent ready').catch(async error=>{console.error(await parent.evaluate('({href:location.href,html:document.documentElement.outerHTML.slice(0,1800)})'));throw error;});await parent.evaluate('document.querySelector("#open").click()');
 let target;await until(async()=>{target=(await targets()).find(t=>t.url.includes('processing-timeline.html'));return target;},'editor popup');
 const page=await connect(target);await page.call('Emulation.setDeviceMetricsOverride',{width:1450,height:1180,deviceScaleFactor:1,mobile:false});
 await until(()=>page.evaluate('document.querySelector("#source")?.readyState>=2&&!document.querySelector("#apply").disabled'),'editor loaded');
 await page.evaluate('Object.defineProperty(crypto,"randomUUID",{value:undefined,configurable:true})');
 assert.equal(await page.evaluate('document.querySelectorAll("#trackingLane .region-bar").length'),1);
 assert.equal(await page.evaluate('document.querySelector("#timelineUnit").value'),'frames');
 assert.match(await page.evaluate('document.querySelector("#viewLabel").textContent'),/108000 frames/);
 await page.evaluate('document.querySelector("#timelineUnit").value="time";document.querySelector("#timelineUnit").dispatchEvent(new Event("change"))');
 assert.match(await page.evaluate('document.querySelector("#viewLabel").textContent'),/1:00:00/);
 await page.evaluate('document.querySelector("#regionOut").value=30;document.querySelector("#regionOut").dispatchEvent(new Event("change"));document.querySelector("#anchor").value="mouth";document.querySelector("#anchor").dispatchEvent(new Event("change"))');
 await page.evaluate('document.querySelector("#apply").click()');
 assert.match(await page.evaluate('document.querySelector("#apply").textContent'),/Applying/);
 await until(()=>page.evaluate('document.querySelector("#apply").textContent.includes("Applied")'),'apply ack');
 assert.equal(state.plan.tracking[0].end_ms,30000);assert.equal(state.plan.tracking[0].anchor,'mouth');
 await page.evaluate('document.querySelector("#regionLock").click()');assert.equal(await page.evaluate('document.querySelector("#regionOut").disabled'),true);
 await page.evaluate('document.querySelector("#regionLock").click();document.querySelector("#selectionIn").value=30;document.querySelector("#selectionOut").value=60;document.querySelector("#selectionOut").dispatchEvent(new Event("change"));document.querySelector("#addTracking").click()');
 assert.equal(await page.evaluate('document.querySelectorAll("#trackingLane .region-bar").length'),2);
 await page.evaluate('document.querySelector("#regionIn").value=20;document.querySelector("#regionIn").dispatchEvent(new Event("change"))');assert.match(await page.evaluate('document.querySelector("#error").textContent'),/overlap/);
 await page.evaluate('document.querySelector("#selectionIn").value=0;document.querySelector("#selectionOut").value=15;document.querySelector("#selectionOut").dispatchEvent(new Event("change"));document.querySelector("#addStabilization").click();document.querySelector("#fitSelection").click();document.querySelector("#referenceMode").value="points";document.querySelector("#referenceMode").dispatchEvent(new Event("change"))');
 await until(()=>page.evaluate('!document.querySelector("#source").seeking'),'point frame');
 const map=await page.evaluate('(()=>{const r=document.querySelector("#sourceCanvas").getBoundingClientRect(),s=Math.min(r.width/160,r.height/120);return{x:r.x+(r.width-160*s)/2,y:r.y+(r.height-120*s)/2,s}})()');
 async function click(x,y){for(const type of ['mousePressed','mouseReleased'])await page.call('Input.dispatchMouseEvent',{type,x,y,button:'left',clickCount:1});}
 for(const[x,y]of[[40,40],[60,40],[80,40]])await click(map.x+x*map.s,map.y+y*map.s);
 assert.match(await page.evaluate('document.querySelector("#pointCount").textContent'),/3 points/);
 referenceCapabilities=false;
 await page.evaluate('document.querySelector("#apply").click()');
 await until(()=>page.evaluate('document.querySelector("#error").textContent.includes("Restart ComfyUI")'),'older backend rejects keyframe save');
 assert.equal(await page.evaluate(`localStorage.getItem('s3f-processing-timeline:${session}').includes('keyframes')`),true,'draft survives unsupported backend');
 referenceCapabilities=true;
 await page.evaluate('document.querySelector("#apply").click()');await until(()=>page.evaluate('document.querySelector("#apply").textContent.includes("Applied")'),'point apply');assert.equal(state.plan.stabilization[0].reference.points.length,3);
 // Multiple reference frames preserve point identities and a per-region mode.
 await page.evaluate('document.querySelector("#goTime").value=10;document.querySelector("#seekTime").click()');
 await until(()=>page.evaluate('!document.querySelector("#source").seeking'),'later reference frame');
 await page.evaluate('document.querySelector("#markReference").click()');
 await until(()=>page.evaluate('!document.querySelector("#source").seeking'),'marked reference frame');
 for(const[x,y]of[[44,40],[64,40],[84,40]])await click(map.x+x*map.s,map.y+y*map.s);
 assert.match(await page.evaluate('document.querySelector("#pointCount").textContent'),/3 points.*2 marked frames/);
 await page.evaluate('document.querySelector("#trackingMode").value="offline";document.querySelector("#trackingMode").dispatchEvent(new Event("change"));document.querySelector("#apply").click()');
 await until(()=>page.evaluate('document.querySelector("#apply").textContent.includes("Applied")'),'reference keyframes saved');
 assert.deepEqual(state.plan.stabilization[0].reference.keyframes.map(k=>k.frame),[0,300]);
 assert.equal(state.plan.stabilization[0].reference.tracking_mode,'offline');
 assert.equal(state.plan.stabilization[0].reference.keyframes[0].points.length,3);
 await page.evaluate('document.querySelector("#referenceKeyframes").value="0";document.querySelector("#referenceKeyframes").dispatchEvent(new Event("change"))');
 await until(()=>page.evaluate('!document.querySelector("#source").seeking'),'first marked frame');
 await page.evaluate('document.querySelector("#regionIn").value=1;document.querySelector("#regionIn").dispatchEvent(new Event("change"))');assert.match(await page.evaluate('document.querySelector("#pointCount").textContent'),/0 points/);
 await page.evaluate('document.querySelector("#undo").click()');assert.match(await page.evaluate('document.querySelector("#pointCount").textContent'),/3 points/);
 // Seek mode never moves a region; editable resize requires the explicit toggle.
 const lane=await page.evaluate('(()=>{document.querySelector("#trackingLane").scrollIntoView({block:"center"});const r=document.querySelector("#trackingLane").getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height}})()');
 await page.call('Input.dispatchMouseEvent',{type:'mousePressed',x:lane.x+lane.w*.3,y:lane.y+40,button:'left',clickCount:1});await page.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:lane.x+lane.w*.5,y:lane.y+40,buttons:1});await page.call('Input.dispatchMouseEvent',{type:'mouseReleased',x:lane.x+lane.w*.5,y:lane.y+40,button:'left',clickCount:1});
 assert.equal(Number(await page.evaluate('document.querySelector("#regionIn").value')),0,'seek must not move tracking region');
 // Explicit edit mode permits resize; splitting retains neighboring coverage.
 await page.evaluate('document.querySelector("#selectionIn").value=0;document.querySelector("#selectionOut").value=60;document.querySelector("#selectionOut").dispatchEvent(new Event("change"));document.querySelector("#fitSelection").click();document.querySelector("#editRegions").click()');
 const resize=await page.evaluate('(()=>{const bar=document.querySelector("#trackingLane [data-id=t0]"),r=bar.getBoundingClientRect(),lane=document.querySelector("#trackingLane").getBoundingClientRect();return{x:r.right-2,y:r.top+25,target:r.left+r.width*2/3,lane:{x:lane.x,y:lane.y,w:lane.width,h:lane.height}}})()');
 await page.call('Input.dispatchMouseEvent',{type:'mousePressed',x:resize.x,y:resize.y,button:'left',clickCount:1});await page.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:resize.target,y:resize.y,buttons:1});await page.call('Input.dispatchMouseEvent',{type:'mouseReleased',x:resize.target,y:resize.y,button:'left',clickCount:1});
 assert.ok(Number(await page.evaluate('document.querySelector("#regionOut").value'))<21,'edit mode resizes end');
 await page.evaluate('document.querySelector("#goTime").value=5;document.querySelector("#seekTime").click();document.querySelector("#split").click();document.querySelector("#editRegions").click()');
 assert.equal(await page.evaluate('document.querySelectorAll("#trackingLane .region-bar").length'),3);
 await page.evaluate('document.querySelector("#selectionIn").value=8;document.querySelector("#selectionOut").value=12;document.querySelector("#selectionOut").dispatchEvent(new Event("change"));document.querySelector("#isolateSelection").click()');
 assert.equal(await page.evaluate('document.querySelectorAll("#trackingLane .region-bar").length'),5);
 assert.equal(Number(await page.evaluate('document.querySelector("#regionIn").value')),8);assert.equal(Number(await page.evaluate('document.querySelector("#regionOut").value')),12);
 Object.assign(lane,resize.lane);
 // Real shift-drag establishes range with the same clock in both lanes.
 await page.call('Input.dispatchMouseEvent',{type:'mousePressed',x:lane.x+lane.w*.25,y:lane.y+70,button:'left',modifiers:8,clickCount:1});await page.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:lane.x+lane.w*.6,y:lane.y+70,buttons:1,modifiers:8});await page.call('Input.dispatchMouseEvent',{type:'mouseReleased',x:lane.x+lane.w*.6,y:lane.y+70,button:'left',modifiers:8,clickCount:1});
 const range=await page.evaluate('[Number(document.querySelector("#selectionIn").value),Number(document.querySelector("#selectionOut").value)]');assert.ok(range[1]>range[0]);
 await page.evaluate('document.querySelector("#processSelected").click()');await until(()=>page.evaluate('document.querySelector("#progressText").textContent==="Processing complete"'),'process complete');assert.equal(seenProcess.operation,'selected');assert.ok(seenProcess.plan.selection[1]>seenProcess.plan.selection[0]);assert.match(await page.evaluate('document.querySelector("#openStudio").href'),/neutral_test/);assert.match(await page.evaluate('document.querySelector("#openStudio").href'),/session=shared-motion-session/);assert.equal(seenProcess.editor_session,'shared-motion-session');
 // Scene guides annotate the original clock without changing motion regions/results.
 const beforeCuts=JSON.stringify({plan:state.plan,report:state.report,project:state.project,revision:state.revision});
 await parent.evaluate('window.rejectCuts=true');await page.evaluate('document.querySelector("#detectCuts").click()');
 await until(()=>page.evaluate('document.querySelector("#error").textContent.includes("main ComfyUI tab")'),'old bridge recovery message');
 await parent.evaluate('window.rejectCuts=false');

 await page.evaluate('document.querySelector("#detectCuts").click()');
 await until(()=>page.evaluate('document.querySelector("#progressText").textContent.includes("Cut scan complete")'),'hard-cut scan');
 assert.equal(seenProcess.operation,'detect_cuts');assert.equal(seenProcess.cut_sensitivity,'normal');
 assert.equal(JSON.stringify({plan:state.plan,report:state.report,project:state.project,revision:state.revision}),beforeCuts);
 assert.match(await page.evaluate('document.querySelector("#cutStatus").textContent'),/3 cut markers/);
 await page.evaluate('document.querySelector("#goTime").value=0;document.querySelector("#seekTime").click();document.querySelector("#nextCut").click()');
 assert.equal(await page.evaluate('document.querySelector("#goTime").value'),'5.000');
 await page.evaluate('document.querySelector("#selectShot").click()');
 assert.deepEqual(await page.evaluate('[document.querySelector("#selectionIn").value,document.querySelector("#selectionOut").value]'),['5.000','17.000']);
 await page.evaluate('document.querySelector("#nextCut").click();document.querySelector("#previousCut").click();document.querySelector("#fitSelection").click()');
 const mark=await page.evaluate('(()=>{document.querySelector("#ruler").scrollIntoView({block:"center"});const r=document.querySelector("#ruler").getBoundingClientRect();return{x:r.x+r.width*(840/(12000+1680)),y:r.y+r.height-7}})()');
 await click(mark.x+2,mark.y);
 assert.equal(await page.evaluate('document.querySelector("#goTime").value'),'5.000','click near a guide snaps to its cut');
 const guideInk=await page.evaluate('(()=>{const c=document.querySelector("#trackingLane .cut-guides"),p=c.getContext("2d").getImageData(0,0,c.width,c.height).data;return p.some((v,i)=>i%4===3&&v>0)})()');assert.ok(guideInk);
 await page.evaluate('document.querySelector("#showCuts").click()');
 assert.equal(await page.evaluate('(()=>{const c=document.querySelector("#trackingLane .cut-guides"),p=c.getContext("2d").getImageData(0,0,c.width,c.height).data;return p.some((v,i)=>i%4===3&&v>0)})()'),false);
 await page.evaluate('document.querySelector("#showCuts").click()');
 // A stale revision cannot silently overwrite another editor.
 state.revision++;
 await page.evaluate('document.querySelector("#regionName").value="Unsaved local edit";document.querySelector("#regionName").dispatchEvent(new Event("change"));document.querySelector("#apply").click()');
 await until(()=>page.evaluate('document.querySelector("#error").textContent.includes("another tab")'),'revision conflict');assert.equal(await page.evaluate('document.querySelector("#regionName").value'),'Unsaved local edit');
 // Reload recovers even an older draft without permitting a stale overwrite.
 await page.call('Page.reload',{ignoreCache:true});
 await until(()=>page.evaluate('document.querySelector("#error")?.textContent.includes("earlier revision")'),'conflicting draft recovery');
 assert.equal(await page.evaluate('document.querySelector("#regionName").value'),'Unsaved local edit');
 await page.evaluate('document.querySelector("#reload").click()');await until(()=>page.evaluate('document.querySelector("#reload").hidden'),'load saved revision');
 await page.evaluate('document.querySelector("#timelineUnit").value="time";document.querySelector("#timelineUnit").dispatchEvent(new Event("change"))');
 // Upstream trims display original timestamps without an unprocessable leading range.
 state={...state,revision:state.revision+1,info:{...state.info,source_id:'trimmed',start:'30',end_ms:3630000},plan:{...state.plan,source_id:'trimmed',tracking:[{...state.plan.tracking[0],id:'trimmed0',start_ms:30000,end_ms:3630000}],stabilization:[],selection:[30000,30000],selected_ids:[]}};
 await page.evaluate('window.s3fTimelineLoad()');
 assert.equal(await page.evaluate('document.querySelector("#nextCut").disabled'),true,'old source markers must not appear on a new source');assert.match(await page.evaluate('document.querySelector("#viewLabel").textContent'),/^0:30/);assert.equal(Number(await page.evaluate('document.querySelector("#pan").min')),30000);
 await page.evaluate('document.querySelector("#zoomIn").click();document.querySelector("#pan").value=0;document.querySelector("#pan").dispatchEvent(new Event("input"));document.querySelector("#fitAll").click()');
 assert.match(await page.evaluate('document.querySelector("#viewLabel").textContent'),/^0:30/);

 // Layout edits never alter analysis regions; portrait media and full frames fit.
 state={...state,revision:state.revision+1,info:{...state.info,source_id:'portrait',start:'0',end_ms:10000,width:180,height:320},plan:{...state.plan,source_id:'portrait',tracking:[{...state.plan.tracking[0],id:'portrait0',start_ms:0,end_ms:10000}],stabilization:[],selection:[0,0],selected_ids:[]}};
 await page.evaluate('window.s3fTimelineLoad()');
 await page.call('Emulation.setDeviceMetricsOverride',{width:2300,height:1300,deviceScaleFactor:1,mobile:false});
 await until(()=>page.evaluate('document.querySelector("#source").videoHeight===320'),'portrait video');
 const originalPlan=JSON.stringify(state.plan),originalRevision=state.revision;
 assert.ok(await page.evaluate('document.querySelector("main").getBoundingClientRect().width>2200'),'wide mode uses the available window');
 await page.evaluate('document.querySelector("#wideLayout").click()');await wait(80);
 assert.ok(await page.evaluate('document.querySelector("main").getBoundingClientRect().width<=1900'),'centered mode remains available');
 await page.evaluate('document.querySelector("#wideLayout").click()');await wait(80);
 assert.ok(await page.evaluate('document.querySelector("#sourcePreview").getBoundingClientRect().width<300'),'portrait preview avoids a wide fixed box');
 await until(()=>page.evaluate('document.querySelector("#thumbnails img")?.naturalHeight===320'),'uncropped portrait thumbnails');
 assert.equal(await page.evaluate('getComputedStyle(document.querySelector("#thumbnails img")).objectFit'),'contain');
 const rect=selector=>page.evaluate(`(()=>{document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'});const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height}})()`);
 async function resizePanel(key,dx,dy){const r=await rect(`[data-resize="${key}"]`);await page.call('Input.dispatchMouseEvent',{type:'mousePressed',x:r.x+r.w/2,y:r.y+r.h/2,button:'left',clickCount:1});await page.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:r.x+r.w/2+dx,y:r.y+r.h/2+dy,buttons:1});await page.call('Input.dispatchMouseEvent',{type:'mouseReleased',x:r.x+r.w/2+dx,y:r.y+r.h/2+dy,button:'left',clickCount:1});await wait(80);}
 const left=await rect('#sourcePreview');await resizePanel('split',220,0);assert.ok((await rect('#sourcePreview')).w>left.w+180);
 const stage=await rect('#previewWorkspace'),canvas=await rect('#sourceCanvas');await resizePanel('stage',0,120);assert.ok((await rect('#previewWorkspace')).h>stage.h+100);assert.ok((await rect('#sourceCanvas')).h>canvas.h+100);
 const thumbs=await rect('#thumbnails');await resizePanel('thumbnails',0,70);assert.ok((await rect('#thumbnails')).h>thumbs.h+60);
 await resizePanel('tracking',0,90);assert.ok((await rect('#trackingLane')).h>=178);
 await resizePanel('overview',0,40);assert.ok((await rect('#overview')).h>=80);
 await page.evaluate('document.querySelector("[data-resize=stabilization]").dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true}))');await wait(80);
 assert.ok((await rect('#stabilizationLane')).h>=100);
 assert.equal(JSON.stringify(state.plan),originalPlan);assert.equal(state.revision,originalRevision);
 const preferences=await page.evaluate('localStorage.getItem("s3f-processing-layout:1")');
 const oldPage=await page.evaluate('performance.timeOrigin');await page.call('Page.reload',{ignoreCache:true});await until(()=>page.evaluate(`performance.timeOrigin!==${oldPage}&&document.querySelector('#source')?.readyState>=2&&!!document.querySelector('#trackingLane').style.height`),'restored layout');
 assert.equal(await page.evaluate('localStorage.getItem("s3f-processing-layout:1")'),preferences);
 assert.ok((await rect('#trackingLane')).h>=178);assert.ok((await rect('#thumbnails')).h>=158);
 await page.evaluate('document.querySelector("#fullscreenLayout").click()');await until(()=>page.evaluate('!!document.fullscreenElement'),'full-screen entry');
 await page.evaluate('document.querySelector("#fullscreenLayout").click()');await until(()=>page.evaluate('!document.fullscreenElement'),'full-screen exit');
 await page.evaluate('document.querySelector("#fitVideoLayout").click()');await wait(80);assert.ok((await rect('#sourcePreview')).w<350);
 await until(()=>page.evaluate('!!document.querySelector("#thumbnails .thumbnail")'),'resized filmstrip');
 const thumbnailTime=await page.evaluate('(()=>{const b=document.querySelector("#thumbnails .thumbnail");b.click();return b.getAttribute("aria-label")})()');assert.match(thumbnailTime,/Seek to/);
 await page.evaluate('document.querySelector("#resetLayout").click()');await wait(80);assert.equal((await rect('#trackingLane')).h,90);
 fs.mkdirSync('development/timeline-layout-browser',{recursive:true});await page.evaluate('window.scrollTo(0,0)');await wait(100);
 fs.writeFileSync('development/timeline-layout-browser/portrait.png',Buffer.from((await page.call('Page.captureScreenshot')).data,'base64'));
 await page.call('Emulation.setDeviceMetricsOverride',{width:720,height:1120,deviceScaleFactor:1,mobile:false});await wait(100);
 assert.ok(await page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'),'narrow layout horizontal overflow');
 // Frame workflow on a real 2 fps clip: keyboard marks include the displayed frame.
 await page.evaluate('document.querySelector("#timelineUnit").value="frames";document.querySelector("#timelineUnit").dispatchEvent(new Event("change"));document.querySelector("#goTime").value=3;document.querySelector("#goTime").focus()');
 async function key(key,code=key,modifiers=0){await page.call('Input.dispatchKeyEvent',{type:'keyDown',key,code,modifiers});await page.call('Input.dispatchKeyEvent',{type:'keyUp',key,code,modifiers});}
 await key('Enter');await until(()=>page.evaluate('!document.querySelector("#source").seeking'),'frame 3 seek');
 assert.equal(await page.evaluate('document.querySelector("#goTime").value'),'3');
 assert.ok(Math.abs((await page.evaluate('document.querySelector("#source").currentTime'))-1.5)<.001);
 await key('i','KeyI');await key('ArrowRight');await key('ArrowRight');await key('o','KeyO');
 assert.deepEqual(await page.evaluate('[document.querySelector("#selectionIn").value,document.querySelector("#selectionOut").value]'),['3','6']);
 assert.match(await page.evaluate('document.querySelector("#selectionLabel").textContent'),/3 frames/);
 await page.evaluate('document.querySelector("#apply").click()');await until(()=>page.evaluate('document.querySelector("#apply").textContent.includes("Applied")'),'frame selection apply');
 assert.deepEqual(state.plan.selection,[1500,3000],'save original timestamps, not frame indices');
 await key('End');await key('i','KeyI');await key('o','KeyO');
 assert.deepEqual(await page.evaluate('[document.querySelector("#selectionIn").value,document.querySelector("#selectionOut").value]'),['19','20']);
 assert.equal(await page.evaluate('document.querySelector("#next").disabled'),true);
 await key('Home');assert.equal(await page.evaluate('document.querySelector("#previous").disabled'),true);
 await key('ArrowRight','ArrowRight',8);assert.equal(await page.evaluate('document.querySelector("#goTime").value'),'10');
 // Editable text fields keep their normal typing/arrow behavior.
 await page.evaluate('document.querySelector("#regionSettingsTab").click();document.querySelector("#regionName").focus()');await key('ArrowRight');
 assert.equal(await page.evaluate('document.querySelector("#goTime").value'),'10');
 await page.evaluate('document.querySelector("#frameDetail").click();document.querySelector("#selectFrame").click()');
 assert.match(await page.evaluate('document.querySelector("#selectionLabel").textContent'),/1 frame/);
 assert.match(await page.evaluate('document.querySelector("#ruler").getAttribute("aria-label")'),/current frame 10/);
 // Every live ruler drag lands on a source frame rather than fractional seconds.
 await page.evaluate('document.querySelector("#ruler").scrollIntoView({block:"center"})');
 const rulerRect=await rect('#ruler');await page.call('Input.dispatchMouseEvent',{type:'mousePressed',x:rulerRect.x+rulerRect.w*.2,y:rulerRect.y+25,button:'left',clickCount:1});
 await page.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:rulerRect.x+rulerRect.w*.7,y:rulerRect.y+25,buttons:1});
 const dragged=await page.evaluate('Number(document.querySelector("#goTime").value)');assert.ok(Number.isInteger(dragged));assert.notEqual(dragged,10);
 await page.call('Input.dispatchMouseEvent',{type:'mouseReleased',x:rulerRect.x+rulerRect.w*.7,y:rulerRect.y+25,button:'left',clickCount:1});
 assert.equal(await page.evaluate('document.querySelector("#goTime").value'),String(dragged));
 // Select actual cut markers and turn their exact boundaries into zones.
 await page.call('Emulation.setDeviceMetricsOverride',{width:1450,height:1180,deviceScaleFactor:1,mobile:false});
 await page.evaluate('document.querySelector("#fitAll").click();document.querySelector("#apply").click()');
 await until(()=>page.evaluate('document.querySelector("#apply").textContent.includes("Applied")'),'save before cut gestures');
 state.scene_cuts={source_id:'portrait',times_ms:[2000,4500,7500],settings:{sensitivity:'normal'}};
 await page.evaluate('window.s3fTimelineLoad()');
 assert.equal(await page.evaluate('document.querySelectorAll("#cutMarkers button").length'),3);
 async function marker(at,modifiers=0,count=1){const r=await rect(`#cutMarkers [data-at="${at}"]`);for(const type of ['mousePressed','mouseReleased'])await page.call('Input.dispatchMouseEvent',{type,x:r.x+r.w/2,y:r.y+r.h/2,button:'left',modifiers,clickCount:count});}
 await marker(2000);assert.equal(await page.evaluate('document.querySelector("#cutActions").hidden'),false);
 assert.match(await page.evaluate('document.querySelector("#selectedCutLabel").textContent'),/Cut 1.*Frame 4/);
 await key('i','KeyI');await marker(4500);await key('o','KeyO');
 assert.deepEqual(await page.evaluate('[document.querySelector("#selectionIn").value,document.querySelector("#selectionOut").value]'),['4','9'],'cut Out excludes the first incoming-shot frame');
 assert.match(await page.evaluate('document.querySelector("#selectionHint").textContent'),/before this frame/);
 await key('ArrowRight');await key('o','KeyO');
 assert.equal(await page.evaluate('document.querySelector("#selectionOut").value'),'11','after frame stepping, normal Out includes the displayed frame');
 assert.equal(await page.evaluate('document.querySelector("#cutActions").hidden'),true);
 await marker(2000);await marker(7500,8);
 assert.deepEqual(await page.evaluate('[document.querySelector("#selectionIn").value,document.querySelector("#selectionOut").value]'),['4','15']);
 await marker(2000,8);assert.deepEqual(await page.evaluate('[document.querySelector("#selectionIn").value,document.querySelector("#selectionOut").value]'),['4','15'],'reverse cut selection is ordered');
 await page.evaluate('document.querySelector("#cutBefore").click()');
 assert.deepEqual(await page.evaluate('[document.querySelector("#selectionIn").value,document.querySelector("#selectionOut").value]'),['0','4']);
 await marker(7500);await page.evaluate('document.querySelector("#cutAfter").click()');
 assert.deepEqual(await page.evaluate('[document.querySelector("#selectionIn").value,document.querySelector("#selectionOut").value]'),['15','20']);
 await marker(2000);await marker(2000,0,2);
 assert.deepEqual(await page.evaluate('[document.querySelector("#selectionIn").value,document.querySelector("#selectionOut").value]'),['4','9']);
 // The popup sits above the ruler without shifting the clicked marker.
 assert.ok(await page.evaluate('(()=>{const p=document.querySelector("#cutActions").getBoundingClientRect();return p.left>=0&&p.right<=innerWidth&&p.top>=0})()'));
 await page.evaluate('document.querySelector("#cutRegion").click();document.querySelector("#apply").click()');
 await until(()=>page.evaluate('document.querySelector("#apply").textContent.includes("Applied")'),'cut zone apply');
 assert.deepEqual(state.plan.tracking.map(r=>[r.start_ms,r.end_ms]),[[0,2000],[2000,4500],[4500,10000]]);
 assert.ok(state.plan.tracking.every(r=>r.anchor==='mouth'),'split zone keeps anchor settings');
 await page.evaluate('document.querySelector("#undo").click();document.querySelector("#regionLock").click()');
 await marker(2000);await page.evaluate('document.querySelector("#cutAfter").click();document.querySelector("#cutRegion").click()');
 assert.match(await page.evaluate('document.querySelector("#error").textContent'),/Unlock/);
 assert.equal(await page.evaluate('document.querySelectorAll("#trackingLane .region-bar").length'),1);
 await page.evaluate('document.querySelector("#regionLock").click()');await marker(2000);
 await page.evaluate('document.querySelector("#cutAfter").click();document.querySelector("#cutRegionLane").value="stabilization";document.querySelector("#cutRegion").click()');
 assert.equal(await page.evaluate('document.querySelectorAll("#stabilizationLane .region-bar").length'),1);
 assert.equal(await page.evaluate('document.querySelectorAll("#trackingLane .region-bar").length'),1);
 assert.equal(await page.evaluate('document.querySelector("#regionIn").value'),'4');assert.equal(await page.evaluate('document.querySelector("#regionOut").value'),'9');
 assert.match(await page.evaluate('document.querySelector("#pointCount").textContent'),/0 points/);
 // Show cuts and Escape dismiss the boundary mode without changing the range.
 await marker(4500);await key('Escape');assert.equal(await page.evaluate('document.querySelector("#cutActions").hidden'),true);
 await marker(4500);await page.evaluate('document.querySelector("#showCuts").click()');
 assert.equal(await page.evaluate('document.querySelectorAll("#cutMarkers button").length'),0);assert.equal(await page.evaluate('document.querySelector("#cutActions").hidden'),true);
 await page.evaluate('document.querySelector("#showCuts").click()');
 await page.call('Emulation.setDeviceMetricsOverride',{width:720,height:1180,deviceScaleFactor:1,mobile:false});await marker(4500);
 assert.ok(await page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'));
 assert.ok(await page.evaluate('(()=>{const r=document.querySelector("#cutActions").getBoundingClientRect();return r.left>=0&&r.right<=innerWidth})()'));
 fs.mkdirSync('development/cut-selection-browser',{recursive:true});
 fs.writeFileSync('development/cut-selection-browser/selected-cut.png',Buffer.from((await page.call('Page.captureScreenshot')).data,'base64'));
 // A refreshed scan cannot leave a removed boundary selected.
 state.scene_cuts.times_ms=[2000,7500];await page.evaluate('window.s3fTimelineLoad()');
 assert.equal(await page.evaluate('document.querySelector("#cutActions").hidden'),true);
 // Tools are beside the preview, never between the preview and the filmstrip.
 await page.call('Emulation.setDeviceMetricsOverride',{width:1600,height:1180,deviceScaleFactor:1,mobile:false});
 await page.evaluate('document.querySelector("#showTimelineTools").click();window.scrollTo(0,0)');await wait(100);
 const geometry=()=>page.evaluate('(()=>{const r=s=>{const b=document.querySelector(s).getBoundingClientRect();return {top:b.top,bottom:b.bottom,left:b.left,right:b.right,height:b.height}};return {preview:r("#previewWorkspace"),video:r("#sourceCanvas"),thumbs:r("#thumbnails"),tools:r("#timelineToolsPane"),inspector:r(".inspector"),timeline:r(".timeline-panel")}})()');
 const toolsBefore=await geometry();assert.ok(toolsBefore.thumbs.top-toolsBefore.preview.bottom<90,'no rows of controls between video and filmstrip');
 assert.ok(toolsBefore.tools.left>=toolsBefore.video.right,'tools sit beside video');
 await page.evaluate('document.querySelector("#sceneTools").open=true');await wait(80);
 assert.equal((await geometry()).thumbs.top,toolsBefore.thumbs.top,'opening cuts does not push down the timeline');
 assert.equal((await geometry()).thumbs.height,toolsBefore.thumbs.height,'thumbnail sizing is unchanged');
 // Selecting a region reveals settings; detailed choices do not crowd the short list.
 await page.evaluate('document.querySelector("#trackingLane .region-bar").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}))');
 assert.equal(await page.evaluate('document.querySelector("#regionSettingsPane").hidden'),false);
 await page.evaluate('document.querySelector("#browseAnchors").click();document.querySelector("#anchorSearch").value="left index";document.querySelector("#anchorSearch").dispatchEvent(new Event("input"))');
 assert.equal(await page.evaluate('document.querySelectorAll(".detailed-anchor-row:not([hidden])").length'),4);
 await page.evaluate('document.querySelector("[data-anchor=left_index_tip] button").click();document.querySelector("#anchorSearch").value="right thumb";document.querySelector("#anchorSearch").dispatchEvent(new Event("input"));document.querySelector("[data-anchor=right_thumb_tip] input").click();document.querySelector("#additionalAnchors input[value=left_hand]").click()');
 assert.equal(await page.evaluate('document.querySelector("#anchor").value'),'left_index_tip');
 assert.equal(await page.evaluate('document.querySelectorAll("#anchor option").length'),11,'only current detailed choice joins the general list');
 assert.equal(await page.evaluate('document.querySelector("[data-anchor=right_thumb_tip] input").checked'),true,'general toggles retain detailed extra tracks');
 await page.evaluate('document.querySelector("#regionLock").click()');
 assert.ok(await page.evaluate('[...document.querySelectorAll("#detailedAnchorResults input,#detailedAnchorResults button,#detailedAnchorTracks button")].every(e=>e.disabled)'));
 await page.evaluate('document.querySelector("#regionLock").click();document.querySelector("#apply").click()');
 await until(()=>page.evaluate('document.querySelector("#apply").textContent.includes("Applied")'),'detailed anchors saved');
 assert.equal(state.plan.tracking[0].anchor,'left_index_tip');
 assert.ok(state.plan.tracking[0].additional_anchors.includes('right_thumb_tip'));
 assert.ok(state.plan.tracking[0].additional_anchors.includes('left_hand'));
 const savedAt=await page.evaluate('performance.timeOrigin');await page.call('Page.reload');
 await until(()=>page.evaluate(`performance.timeOrigin!==${savedAt}&&document.querySelector('#source')?.readyState>=2&&!document.querySelector('main').inert`),'detailed anchors reopened');
 await page.evaluate('document.querySelector("#regionSettingsTab").click()');
 assert.equal(await page.evaluate('document.querySelector("#anchor").value'),'left_index_tip');
 assert.match(await page.evaluate('document.querySelector("#detailedAnchorTracks").textContent'),/right thumb tip/);
 fs.mkdirSync('development/timeline-tools-browser',{recursive:true});
 await page.evaluate('document.querySelector("#browseAnchors").click();document.querySelector("#anchorSearch").value="left index";document.querySelector("#anchorSearch").dispatchEvent(new Event("input"));window.scrollTo(0,0)');await wait(100);
 fs.writeFileSync('development/timeline-tools-browser/detailed-anchors.png',Buffer.from((await page.call('Page.captureScreenshot')).data,'base64'));
 // Frame stepping retains the last painted image while seeking, then paints
 // exactly the latest decoded frame even when several steps arrive together.
 await page.evaluate('document.querySelector("#timelineUnit").value="frames";document.querySelector("#timelineUnit").dispatchEvent(new Event("change"));document.querySelector("#goTime").value=3;document.querySelector("#seekTime").click()');
 await until(()=>page.evaluate('!document.querySelector("#source").seeking'),'frame preview baseline');
 await page.evaluate('(()=>{const c=document.querySelector("#sourceCanvas"),ctx=c.getContext("2d"),v=document.querySelector("#source"),clear=ctx.clearRect.bind(ctx);window.earlyClears=0;ctx.clearRect=(...args)=>{if(v.seeking||v.readyState<2)window.earlyClears++;return clear(...args)};window.beforeStep=c.toDataURL();document.querySelector("#next").click();window.heldDuringStep=c.toDataURL()===window.beforeStep;document.querySelector("#previous").click();document.querySelector("#next").click()})()');
 assert.equal(await page.evaluate('window.heldDuringStep'),true,'preview is retained synchronously when stepping');
 await until(()=>page.evaluate('!document.querySelector("#source").seeking'),'rapid step completion');
 assert.equal(await page.evaluate('window.earlyClears'),0,'no blank or stale intermediate redraw while seeking');
 assert.equal(await page.evaluate('document.querySelector("#goTime").value'),'4');
 assert.ok(await page.evaluate('(()=>{const c=document.querySelector("#sourceCanvas"),r=c.getBoundingClientRect(),v=document.querySelector("#source"),expected=document.createElement("canvas");expected.width=c.width;expected.height=c.height;const ctx=expected.getContext("2d"),s=Math.min(r.width/v.videoWidth,r.height/v.videoHeight);ctx.setTransform(devicePixelRatio,0,0,devicePixelRatio,0,0);ctx.drawImage(v,0,0,v.videoWidth,v.videoHeight,(r.width-v.videoWidth*s)/2,(r.height-v.videoHeight*s)/2,v.videoWidth*s,v.videoHeight*s);return expected.toDataURL()===c.toDataURL()})()'),'preview matches latest decoded video frame');
 await page.evaluate('document.querySelector("#showTimelineTools").click();document.querySelector("#sceneTools").open=true;window.scrollTo(0,0)');await wait(100);
 fs.mkdirSync('development/timeline-tools-browser',{recursive:true});
 await until(()=>page.evaluate('document.querySelector("#thumbnails img")?.naturalHeight===320'),'filmstrip ready for wide screenshot');
 fs.writeFileSync('development/timeline-tools-browser/wide.png',Buffer.from((await page.call('Page.captureScreenshot')).data,'base64'));
 await page.call('Emulation.setDeviceMetricsOverride',{width:720,height:1180,deviceScaleFactor:1,mobile:false});await wait(100);
 const mobile=await geometry();assert.ok(mobile.inspector.top>=mobile.timeline.bottom,'small screens put tools after the timeline');
 assert.ok(await page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'));
 await until(()=>page.evaluate('document.querySelector("#thumbnails img")?.naturalHeight===320'),'filmstrip ready for narrow screenshot');
 fs.writeFileSync('development/timeline-tools-browser/narrow.png',Buffer.from((await page.call('Page.captureScreenshot')).data,'base64'));
 assert.equal(errors.length,0,JSON.stringify(errors));
 // Rendered regions can be reviewed after reload without processing again.
 const stable={id:'preview-stable',name:'Rendered section',start_ms:2000,end_ms:4500,enabled:true,locked:false,reference:{crop_xywh:[0,0,180,320],points:[[20,20],[30,30],[40,40]],sections:[]},agreement_pixels:12,max_step_pixels:48};
 state.plan.stabilization=[stable];state.plan.selection=[2000,4500];state.plan.selected_ids=[stable.id];state.revision++;
 renderedState={source_id:state.info.source_id,stabilization:{[stable.id]:{region:structuredClone(stable),video_path:`/output/sam3d_funscript/processing/${session}/reference/${'a'.repeat(24)}/stabilized.mp4`}}};
 await page.evaluate('localStorage.removeItem("s3f-processing-timeline:'+session+'");');
 await page.call('Page.reload');
 await until(()=>page.evaluate('document.querySelector("#previewStabilized")&&!document.querySelector("#previewStabilized").disabled'),'saved stabilized clip discovered');
 await page.evaluate('document.querySelector("#regionSettingsTab").click();document.querySelector("#previewStabilized").click()');
 await until(()=>page.evaluate('document.querySelector("#source").readyState>=2&&!document.querySelector("#source").seeking&&document.querySelector("#previewTitle").textContent==="Stabilized source"'),'stabilized preview loaded');
 assert.equal(await page.evaluate('document.querySelector("#goTime").value'),'4','source frame clock stays at 2 seconds');
 assert.ok(await page.evaluate('document.querySelector("#source").currentTime<.01'),'render starts at zero');
 await until(()=>page.evaluate('document.querySelector("#trackingHealth").textContent.includes("2 held / 5")'),'tracking quality loaded');
 assert.match(await page.evaluate('document.querySelector("#stabilizationLane .region-state").textContent'),/40% held/);
 await page.evaluate('document.querySelector("#nextHeld").click()');
 await until(()=>page.evaluate('document.querySelector("#previewStatus").textContent.includes("HELD: fewer than 3")'),'gap shows actual failure reason');
 assert.equal(await page.evaluate('document.querySelector("#goTime").value'),'6','gap navigation uses source frames');
 assert.equal(await page.evaluate('document.querySelector("#previewStatus").dataset.held'),'true');
 const pointsVisible=await page.evaluate('document.querySelector("#sourceCanvas").toDataURL()');
 await page.evaluate('document.querySelector("#showTrackedPoints").click()');
 assert.notEqual(await page.evaluate('document.querySelector("#sourceCanvas").toDataURL()'),pointsVisible,'tracked point overlay toggles independently of held warning');
 assert.equal(await page.evaluate('document.querySelector("#previewStatus").dataset.held'),'true');
 await page.evaluate('document.querySelector("#showTrackedPoints").click();document.querySelector("#goTime").value=4;document.querySelector("#seekTime").click()');
 await until(()=>page.evaluate('!document.querySelector("#source").seeking'),'return to first preview frame');

 await page.evaluate('document.querySelector("#next").click()');await until(()=>page.evaluate('!document.querySelector("#source").seeking'),'stabilized next frame');
 assert.equal(await page.evaluate('document.querySelector("#goTime").value'),'5');assert.ok(await page.evaluate('Math.abs(document.querySelector("#source").currentTime-.5)<.01'));
 await page.evaluate('document.querySelector("#previewVariant").value="original";document.querySelector("#previewVariant").dispatchEvent(new Event("change"))');
 await until(()=>page.evaluate('document.querySelector("#source").readyState>=2&&!document.querySelector("#source").seeking&&Math.abs(document.querySelector("#source").currentTime-2.5)<.01'),'same original frame');
 await page.evaluate('document.querySelector("#previewVariant").value="stabilized";document.querySelector("#previewVariant").dispatchEvent(new Event("change"))');
 await until(()=>page.evaluate('document.querySelector("#source").readyState>=2&&!document.querySelector("#source").seeking&&Math.abs(document.querySelector("#source").currentTime-.5)<.01'),'same stabilized frame');
 // Editing points always returns to the original coordinate system.
 await page.evaluate('document.querySelector("#referenceMode").value="points";document.querySelector("#referenceMode").dispatchEvent(new Event("change"))');
 assert.equal(await page.evaluate('document.querySelector("#previewVariant").value'),'original');
 await until(()=>page.evaluate('document.querySelector("#source").readyState>=2&&!document.querySelector("#source").seeking'),'reference first frame');
 await page.evaluate('document.querySelector("#crop").value="[0,0,170,300]";document.querySelector("#crop").dispatchEvent(new Event("change"));document.querySelector("#previewStabilized").click()');
 await until(()=>page.evaluate('document.querySelector("#previewStatus").textContent.includes("previous render")'),'stale render clearly labeled');
 // Crossing the output boundary returns to the original clip without changing clocks.
 await page.evaluate('document.querySelector("#goTime").value=8;document.querySelector("#seekTime").click()');
 await until(()=>page.evaluate('!document.querySelector("#source").seeking'),'last stabilized frame');
 await page.evaluate('document.querySelector("#play").click()');
 await until(()=>page.evaluate('document.querySelector("#previewTitle").textContent==="Original source"&&!document.querySelector("#source").paused'),'playback crosses stabilization end');
 await page.evaluate('document.querySelector("#play").click()');
 assert.match(await page.evaluate('document.querySelector("#previewStatus").textContent'),/no rendered stabilization/);
 fs.mkdirSync('development/stabilized-preview-browser',{recursive:true});
 await page.evaluate('document.querySelector("#previewStabilized").click();window.scrollTo(0,0)');
 await until(()=>page.evaluate('!document.querySelector("#source").seeking&&document.querySelector("#source").readyState>=2'),'review screenshot');
 fs.writeFileSync('development/stabilized-preview-browser/preview.png',Buffer.from((await page.call('Page.captureScreenshot')).data,'base64'));
 // Quick reference iterations need no SAM3D region and preserve existing motion.
 state.plan.tracking=[];state.plan.selection=[7000,8000];state.revision++;
 await page.evaluate('document.querySelector("#apply").click()');
 await until(()=>page.evaluate('!document.querySelector("#reload").hidden'),'conflicting old browser plan');
 await page.evaluate('document.querySelector("#reload").click()');
 await until(()=>page.evaluate('document.querySelectorAll("#trackingLane .region-bar").length===0'),'no pose regions');
 const motionBefore=structuredClone({project:state.project,report:state.report,editor_session:state.editor_session});
 trackCapabilities=false;
 await page.evaluate('document.querySelector("#trackStabilization").click()');
 await until(()=>page.evaluate('document.querySelector("#error").textContent.includes("Restart ComfyUI")'),'old tracking backend rejected');
 trackCapabilities=true;
 await page.evaluate('document.querySelector("#trackStabilization").click()');
 await until(()=>page.evaluate('document.querySelector("#trackStabilization").textContent==="Tracking…"'),'track button feedback');
 assert.equal(await page.evaluate('document.querySelector("#cancelStabilization").hidden'),false);
 assert.equal(await page.evaluate('document.querySelector("#stabilizationProgress").hidden'),false);
 await until(()=>page.evaluate('document.querySelector("#progressText").textContent.includes("Tracking complete")'),'tracking-only complete');
 await until(()=>page.evaluate('document.querySelector("#previewTitle").textContent==="Stabilized source"&&!document.querySelector("#source").seeking'),'automatic stabilized preview');
 assert.equal(seenProcess.operation,'stabilize');assert.equal(seenProcess.stabilization_id,stable.id);
 assert.deepEqual(seenProcess.plan.selection,[7000,8000],'unrelated marked range stays unchanged');
 assert.deepEqual({project:state.project,report:state.report,editor_session:state.editor_session},motionBefore);
 assert.equal(await page.evaluate('document.querySelector("#referenceAdvanced").open'),false);
 assert.equal(await page.evaluate('document.querySelector("#referenceHelp").open'),false);
 await page.evaluate('document.querySelector("#regionLock").click()');
 assert.equal(await page.evaluate('document.querySelector("#trackStabilization").disabled'),true);
 await page.evaluate('document.querySelector("#regionLock").click();document.querySelector("#trackStabilization").click()');
 await until(()=>page.evaluate('!document.querySelector("#cancelStabilization").hidden'),'cancel available');
 await page.evaluate('document.querySelector("#cancelStabilization").click()');
 await until(()=>page.evaluate('!document.querySelector("#trackStabilization").disabled'),'cancel restores controls');
 assert.deepEqual({project:state.project,report:state.report,editor_session:state.editor_session},motionBefore);
 // Inspect the compact panel at desktop and narrow sizes with neutral imagery.
 await page.call('Emulation.setDeviceMetricsOverride',{width:1450,height:1180,deviceScaleFactor:1,mobile:false});
 await page.evaluate('document.querySelector("#regionSettingsTab").click();document.querySelector(".inspector").scrollTop=0;window.scrollTo(0,0)');await wait(120);
 fs.mkdirSync('development/track-only-browser',{recursive:true});
 fs.writeFileSync('development/track-only-browser/desktop.png',Buffer.from((await page.call('Page.captureScreenshot')).data,'base64'));
 assert.equal(await page.evaluate('document.querySelector("#stabilizationSettings").scrollWidth>document.querySelector("#stabilizationSettings").clientWidth'),false,'setup fits inspector');
 await page.call('Emulation.setDeviceMetricsOverride',{width:680,height:1180,deviceScaleFactor:1,mobile:false});
 await page.evaluate('document.querySelector("#stabilizationSettings").scrollIntoView({block:"start"})');await wait(120);
 fs.writeFileSync('development/track-only-browser/narrow.png',Buffer.from((await page.call('Page.captureScreenshot')).data,'base64'));
 assert.equal(await page.evaluate('document.querySelector("#stabilizationSettings").scrollWidth>document.querySelector("#stabilizationSettings").clientWidth'),false,'narrow setup fits');
 // Optional masks leave the manual point workflow intact and keep each stage independent.
 await page.call('Emulation.setDeviceMetricsOverride',{width:1450,height:1180,deviceScaleFactor:1,mobile:false});
 await page.evaluate('document.querySelector("#maskStepTab").click();document.querySelector("#goTime").value=5;document.querySelector("#seekTime").click();window.scrollTo(0,0)');
 await until(()=>page.evaluate('!document.querySelector("#source").seeking&&document.querySelector("#source").readyState>=2'),'mask seed frame');
 await page.evaluate('document.querySelector("#maskSeed").click()');
 const paintMap=await page.evaluate('(()=>{const r=document.querySelector("#sourceCanvas").getBoundingClientRect(),s=Math.min(r.width/180,r.height/320);return{x:r.x+(r.width-180*s)/2,y:r.y+(r.height-320*s)/2,s}})()');
 await click(paintMap.x+80*paintMap.s,paintMap.y+150*paintMap.s);
 await page.evaluate('document.querySelector("#maskTool").value="erase";document.querySelector("#maskRadius").value=3');
 await click(paintMap.x+80*paintMap.s,paintMap.y+150*paintMap.s);
 await page.evaluate('document.querySelector("#undoMaskStroke").click();document.querySelector("#maskSpacing").value=6;document.querySelector("#maskSpacing").dispatchEvent(new Event("change"));document.querySelector("#maskLimit").value=24;document.querySelector("#maskLimit").dispatchEvent(new Event("change"));document.querySelector("#generateMaskPoints").click()');
 assert.match(await page.evaluate('document.querySelector("#error").textContent'),/Replace existing points/);
 await page.evaluate('document.querySelector("#replaceMaskPoints").checked=true;document.querySelector("#generateMaskPoints").click()');
 assert.match(await page.evaluate('document.querySelector("#maskPointStatus").textContent'),/24 points/);
 maskCapabilities=false;
 await page.evaluate('document.querySelector("#apply").click()');
 await until(()=>page.evaluate('document.querySelector("#error").textContent.includes("enable reference masks")'),'mask capability protects unsaved mask');
 maskCapabilities=true,meshCapabilities=true;
 await page.evaluate('document.querySelector("#apply").click()');
 await until(()=>page.evaluate('document.querySelector("#apply").textContent.includes("Applied")'),'mask saved');
 const painted=state.plan.stabilization.find(r=>r.id===stable.id);
 assert.equal(painted.reference.point_mask.strokes.length,1);assert.equal(painted.reference.point_mask.frame,1);assert.equal(painted.reference.points.length,24);assert.deepEqual(painted.reference.keyframes.map(k=>k.frame),[1]);
 await page.evaluate('document.querySelector("#trackStepTab").click();document.querySelector("#trackStabilization").click()');
 await until(()=>page.evaluate('document.querySelector("#error").textContent.includes("Propagate the updated")'),'stale mask blocks tracking');
 await page.evaluate('document.querySelector("#maskStepTab").click();document.querySelector("#propagateMask").click()');
 await until(()=>page.evaluate('!document.querySelector("#cancelMask").hidden'),'mask progress feedback');
 await until(()=>page.evaluate('document.querySelector("#progressText").textContent.includes("Mask propagation complete")'),'mask complete');
 assert.equal(seenProcess.operation,'propagate_mask');assert.equal(seenProcess.stabilization_id,stable.id);assert.deepEqual(seenProcess.plan.selection,[7000,8000]);
 assert.equal(await page.evaluate('document.querySelector("#trackStep").hidden'),false);
 assert.deepEqual({project:state.project,report:state.report,editor_session:state.editor_session},motionBefore);
 await page.evaluate('document.querySelector("#maskStepTab").click();document.querySelector("#maskSpacing").value=8;document.querySelector("#maskSpacing").dispatchEvent(new Event("change"))');
 assert.match(await page.evaluate('document.querySelector("#maskStatus").textContent'),/5 masks ready/,'density does not invalidate mask propagation');
 fs.mkdirSync('development/mask-browser',{recursive:true});
 await page.evaluate('document.querySelector(".inspector").scrollTop=0;window.scrollTo(0,0)');await wait(120);
 fs.writeFileSync('development/mask-browser/desktop.png',Buffer.from((await page.call('Page.captureScreenshot')).data,'base64'));
 assert.equal(await page.evaluate('document.querySelector("#stabilizationSettings").scrollWidth>document.querySelector("#stabilizationSettings").clientWidth'),false);
 await page.call('Emulation.setDeviceMetricsOverride',{width:680,height:1180,deviceScaleFactor:1,mobile:false});
 await page.evaluate('document.querySelector("#maskStep").scrollIntoView({block:"start"})');await wait(120);
 fs.writeFileSync('development/mask-browser/narrow.png',Buffer.from((await page.call('Page.captureScreenshot')).data,'base64'));
 assert.equal(await page.evaluate('document.querySelector("#stabilizationSettings").scrollWidth>document.querySelector("#stabilizationSettings").clientWidth'),false);
 await page.evaluate('document.querySelector("#anchorsStepTab").click();document.querySelector("#addStabilizedAnchors").click();document.querySelector("#apply").click()');
 await until(()=>page.evaluate('document.querySelector("#apply").textContent.includes("Applied")'),'section anchors configured');
 assert.equal(state.plan.tracking.length,1);assert.equal(state.plan.tracking[0].start_ms,stable.start_ms);assert.equal(state.plan.tracking[0].end_ms,stable.end_ms);assert.deepEqual(state.plan.selection,[7000,8000]);
 await page.evaluate(`document.querySelector('#stabilizationLane [data-id="${stable.id}"]').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,clientX:200,pointerId:1}));document.querySelector('#anchorsStepTab').click();document.querySelector('#extractStabilizedAnchors').click()`);
 await until(()=>seenProcess.operation==='extract_anchors','anchor operation targeted');
 await until(()=>page.evaluate('!document.querySelector("#apply").disabled'),'anchor processing finished');
 assert.equal(seenProcess.stabilization_id,stable.id);assert.deepEqual(seenProcess.plan.selection,[7000,8000]);
 await page.evaluate('document.querySelector("#maskStepTab").click();document.querySelector("#clearMask").click();document.querySelector("#manualPoints").click();document.querySelector("#apply").click()');
 await until(()=>page.evaluate('document.querySelector("#apply").textContent.includes("Applied")'),'manual points kept after clearing mask');
 assert.equal(state.plan.stabilization[0].reference.point_mask,undefined);assert.equal(state.plan.stabilization[0].reference.points.length,24);
 // The separate reference editor can choose its first seed in the middle,
 // add an earlier seed, reposition numbered points, save, and undo removal.
 await parent.evaluate("window.referenceEditor=window.open('/sam3d_funscript/assets/reference.html?reference=neutral-reference&node=2');void 0");
 let refTarget;await until(async()=>{refTarget=(await targets()).find(t=>t.url.includes('/reference.html'));return refTarget;},'reference popup');
 const ref=await connect(refTarget);await ref.call('Emulation.setDeviceMetricsOverride',{width:1450,height:1180,deviceScaleFactor:1,mobile:false});
 await until(()=>ref.evaluate('document.querySelector("#source")?.readyState>=2&&!document.querySelector("#source").seeking'),'reference source');
 assert.equal(await ref.evaluate('document.querySelector("#seek").max'),'119','navigation is available before tracking');
 async function markRef(frame,coords){
  await ref.evaluate(`document.querySelector('#seek').value=${frame};document.querySelector('#seek').dispatchEvent(new Event('input'))`);
  await until(()=>ref.evaluate('!document.querySelector("#source").seeking'),'reference frame decoded');
  await ref.evaluate('document.querySelector("#markReference").click()');
  const m=await ref.evaluate('(()=>{const r=document.querySelector("#sourceCanvas").getBoundingClientRect(),s=Math.min(r.width/160,r.height/120);return{x:r.x+(r.width-160*s)/2,y:r.y+(r.height-120*s)/2,s}})()');
  for(const [x,y]of coords)for(const type of ['mousePressed','mouseReleased'])await ref.call('Input.dispatchMouseEvent',{type,x:m.x+x*m.s,y:m.y+y*m.s,button:'left',clickCount:1});
 }
 await markRef(12,[[40,40],[60,40],[80,40]]);
 await markRef(4,[[36,40],[56,40],[76,40]]);
 assert.match(await ref.evaluate('document.querySelector("#pointCount").textContent'),/3 points.*2 marked frames/);
 await ref.evaluate('document.querySelector("#trackingMode").value="offline";document.querySelector("#trackingMode").dispatchEvent(new Event("change"));document.querySelector("#apply").click()');
 await until(()=>ref.evaluate('document.querySelector("#apply").textContent.includes("Applied")'),'reference apply');
 assert.deepEqual(referenceSaved.keyframes.map(k=>k.frame),[4,12]);assert.equal(referenceSaved.tracking_mode,'offline');
 assert.deepEqual(referenceSaved.points,referenceSaved.keyframes[0].points);
 await ref.evaluate('document.querySelector("#removeReferenceKey").click()');
 assert.match(await ref.evaluate('document.querySelector("#pointCount").textContent'),/1 marked frames/);
 await ref.evaluate('document.querySelector("#undo").click()');
 assert.match(await ref.evaluate('document.querySelector("#pointCount").textContent'),/2 marked frames/);
 await ref.evaluate('document.querySelector("#referenceKeyframes").value="12";document.querySelector("#referenceKeyframes").dispatchEvent(new Event("change"))');
 await until(()=>ref.evaluate('!document.querySelector("#source").seeking'),'reference keyframe navigation');
 assert.equal(await ref.evaluate('document.querySelector("#source").currentTime'),6);
 fs.mkdirSync('development/reference-keyframes-browser',{recursive:true});
 fs.writeFileSync('development/reference-keyframes-browser/reference.png',Buffer.from((await ref.call('Page.captureScreenshot')).data,'base64'));
 assert.deepEqual(errors,[]);
 // Split good/bad stabilization directly at a scene boundary without losing marks.
 const splitOriginal={id:'split-stable',name:'Reference to split',start_ms:0,end_ms:10000,enabled:true,locked:false,
  reference:{crop_xywh:[0,0,180,320],tracking_mode:'offline',points:[[20,20],[30,30],[40,40]],
   keyframes:[1,12,17].map(frame=>({frame,points:[[20,20],[30,30],[40,40]]})),sections:[],
   point_mask:{frame:1,spacing:12,limit:100,model:'sam2.1_base_plus',strokes:[{radius:10,erase:false,points:[[20,20],[40,40]]}]}},agreement_pixels:12,max_step_pixels:48};
 state.plan.tracking=[{...structuredClone(state.plan.tracking[0]),id:'split-tracking',start_ms:0,end_ms:10000,locked:false}];
 state.plan.stabilization=[structuredClone(splitOriginal)];state.plan.selection=[0,10000];state.plan.selected_ids=[splitOriginal.id];
 state.scene_cuts={source_id:state.info.source_id,times_ms:[2000,4500,7500]};state.report={regions:[{id:'split-tracking',start_ms:0,end_ms:10000,state:'complete'}]};state.revision++;renderedState=null;
 await page.evaluate('localStorage.removeItem("s3f-processing-timeline:'+session+'");');
 await page.call('Emulation.setDeviceMetricsOverride',{width:1450,height:1180,deviceScaleFactor:1,mobile:false});
 await page.call('Page.reload');
 await until(()=>page.evaluate('document.querySelector("#regionName")?.value==="Reference to split"&&document.querySelector("#source")?.readyState>=2&&!document.querySelector("#apply").disabled'),'split fixture reopened');
 await page.evaluate('document.querySelector("#fitAll").click();document.querySelector(".timeline-panel").scrollIntoView({block:"center"})');await wait(100);
 await marker(4500);
 assert.equal(await page.evaluate('document.querySelector("#cutSplit").disabled'),false);
 fs.mkdirSync('development/region-split-browser',{recursive:true});
 fs.writeFileSync('development/region-split-browser/menu.png',Buffer.from((await page.call('Page.captureScreenshot')).data,'base64'));
 await page.evaluate('document.querySelector("#cutSplit").click();document.querySelector("#apply").click()');
 await until(()=>page.evaluate('document.querySelector("#apply").textContent.includes("Applied")'),'both lane split saved');
 assert.deepEqual(state.plan.tracking.map(r=>[r.start_ms,r.end_ms]),[[0,4500],[4500,10000]]);
 assert.deepEqual(state.plan.stabilization.map(r=>[r.start_ms,r.end_ms]),[[0,4500],[4500,10000]]);
 assert.deepEqual(state.plan.stabilization.map(r=>r.reference.keyframes.map(k=>k.frame)),[[1],[3,8]]);
 assert.deepEqual(state.plan.stabilization[0].reference.point_mask,splitOriginal.reference.point_mask);
 assert.equal(state.plan.stabilization[1].reference.point_mask,undefined);
 assert.equal(state.plan.selected_ids.length,2);
 assert.equal(await page.evaluate('document.querySelector("#trackingLane [data-id=split-tracking] .region-state").textContent'),'needs processing');
 assert.match(await page.evaluate('document.querySelector("#regionName").value'),/part 2/);
 const goodSide=structuredClone(state.plan.stabilization[0]);
 await page.evaluate('document.querySelector("#crop").value="[5,0,175,320]";document.querySelector("#crop").dispatchEvent(new Event("change"));document.querySelector("#apply").click()');
 await until(()=>page.evaluate('document.querySelector("#apply").textContent.includes("Applied")'),'independent right crop saved');
 assert.deepEqual(state.plan.stabilization[0],goodSide,'right reference changes leave good side untouched');
 await page.evaluate('document.querySelector("#undo").click();document.querySelector("#undo").click();document.querySelector("#apply").click()');
 await until(()=>page.evaluate('document.querySelector("#apply").textContent.includes("Applied")'),'undo split saved');
 assert.equal(state.plan.tracking.length,1);assert.deepEqual(state.plan.stabilization,[splitOriginal]);
 await page.evaluate('document.querySelector("#regionLock").click()');await marker(4500);
 assert.equal(await page.evaluate('document.querySelector("#cutSplit").disabled'),true,'one locked lane blocks the whole two-lane split');
 assert.match(await page.evaluate('document.querySelector("#cutSplit").title'),/Unlock/);
 await page.evaluate('document.querySelector("#cutSplitLane").value="tracking";document.querySelector("#cutSplitLane").dispatchEvent(new Event("change"))');
 assert.equal(await page.evaluate('document.querySelector("#cutSplit").disabled'),false,'other lane can still be split alone');
 await page.evaluate('document.querySelector("#clearCut").click();document.querySelector("#regionLock").click();document.querySelector("#goTime").value=12;document.querySelector("#seekTime").click();document.querySelector("#ruler").focus()');
 await key('s','KeyS');await page.evaluate('document.querySelector("#apply").click()');
 await until(()=>page.evaluate('document.querySelector("#apply").textContent.includes("Applied")'),'keyboard split saved');
 assert.equal(state.plan.tracking.length,1);assert.deepEqual(state.plan.stabilization.map(r=>[r.start_ms,r.end_ms]),[[0,6000],[6000,10000]]);
 assert.deepEqual(state.plan.stabilization[1].reference.keyframes.map(k=>k.frame),[0,5]);
 const splitSaved=structuredClone(state.plan.stabilization);
 const beforeSplitReload=await page.evaluate('performance.timeOrigin');
 await page.call('Page.reload');await until(()=>page.evaluate(`performance.timeOrigin!==${beforeSplitReload}&&document.querySelectorAll("#stabilizationLane .region-bar").length===2&&!document.querySelector("#apply").disabled`),'split survives reload');
 assert.deepEqual(state.plan.stabilization,splitSaved);
 await page.evaluate('document.querySelector("#stabilizationLane").scrollIntoView({block:"center"})');await wait(100);
 fs.writeFileSync('development/region-split-browser/independent-regions.png',Buffer.from((await page.call('Page.captureScreenshot')).data,'base64'));
 assert.equal(errors.length,0,JSON.stringify(errors));
 console.log(JSON.stringify({checks:['cut-menu split of both lanes, reference and mask preservation, independent right-side edits, atomic Undo, lock protection, S shortcut and reload','tracking-only action without pose regions','progress and cancel beside Track region','automatic stabilized preview','reference-only processing preserves motion and selection','tracking action lock protection and backend capability check','compact desktop and narrow stabilization controls','multiple reference keyframes in both editors','offline mode saved per region','reference navigation before first tracking','numbered point identities and keyframe removal/undo','neutral source playback','hour timeline zoom','apply feedback and parent ack','tracking regions and anchors','locks','overlap rejection','first-frame point picking','start edits clear stale points','undo','seek without accidental move','explicit resize and split','isolate selection into independent region','shift-drag selection','selected processing and result link','stale edit rejection','older draft recovered after reload','trimmed original-clock navigation','narrow layout','hard-cut scan preserves regions','cut navigation and shot selection','snapped guide seeking','subtle guides can be hidden','portrait aspect and full-frame filmstrip','wide and centered layouts','draggable preview columns and heights','thumbnail/lane/overview sizing','keyboard divider resize','layout persistence without plan edits','full-screen entry and exit','fit video/reset layout','old workflow bridge recovery message','source frame ruler default','exact frame go-to and stepping','keyboard In/Out without dragging','last frame selection with exclusive Out','frame snapping during ruler scrubbing','frame selections saved as original timestamps','typing does not trigger transport','clickable cut markers and keyboard boundary marks','Shift-click cut range in both directions','before/after and double-click shot selection','make tracking zone preserves anchors','locked region rejects cut split','make independent stabilization zone','Escape, hidden guides and refreshed scan clear cut selection','cut action panel fits narrow views','tools beside preview without pushing filmstrip','narrow tools below timeline','detailed anchor search and short main list','detailed extra tracks survive general toggles','detailed anchors save reload and lock','frame steps hold image until latest decoded frame','saved stabilized clip discovery without rerun','original/stabilized frame-aligned switching and stepping','point edits use original frame','stale render labeling','playback leaves stabilization at its end','held-frame counts and warnings','gap navigation and tracked-point overlay'],apiRequests,errors},null,2));
}finally{for(const socket of sockets)socket.close();chrome.kill('SIGTERM');server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(temporary,{recursive:true,force:true});}
