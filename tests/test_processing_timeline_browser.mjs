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

const session='1234567890abcdef1234567890abcdef';
let state={session,revision:1,info:{source_id:'neutral',source:{path:'neutral-test.mp4'},start:'0',duration:'3600',source_origin:'0',rate:'30',width:160,height:120,end_ms:3600000},plan:{version:1,source_id:'neutral',tracking:[{id:'t0',name:'Full video',start_ms:0,end_ms:3600000,enabled:true,locked:false,anchor:'pelvis',person:0,rois:[[0,0,1,1]],smoothing_ms:80,settings:{}}],stabilization:[],selection:[0,0],selected_ids:[],join_ms:200,gap_policy:'hold',chunk_seconds:30},report:null,project:null,editor_session:'shared-motion-session'};
let seenProcess=null,apiRequests=0;
const parentHtml=`<!doctype html><button id="open" onclick="window.editor=window.open('/sam3d_funscript/assets/processing-timeline.html?session=${session}&node=1')">Open editor</button><script>
window.events=[];window.addEventListener('message',async e=>{const d=e.data;window.events.push(d);if(d.type==='s3f-timeline-apply'){setTimeout(()=>e.source.postMessage({type:'s3f-timeline-applied',request:d.request},location.origin),150)}if(d.type==='s3f-timeline-process'){if(window.rejectCuts&&d.operation==='detect_cuts'){e.source.postMessage({type:'s3f-timeline-progress',request:d.request,state:'error',error:'Unknown timeline operation'},location.origin);return;}window.lastProcess=d;await fetch('/test/process',{method:'POST',body:JSON.stringify(d)});e.source.postMessage({type:'s3f-timeline-progress',request:d.request,state:'queued',text:'Queued neutral test'},location.origin);setTimeout(()=>e.source.postMessage({type:'s3f-timeline-progress',request:d.request,state:'complete',text:'Complete'},location.origin),500)}if(d.type==='s3f-timeline-cancel')e.source.postMessage({type:'s3f-timeline-progress',request:d.request,state:'error',error:'Cancelled'},location.origin)});
</script>`;
const mime={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.mp4':'video/mp4'};
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname==='/'){res.setHeader('Content-Type','text/html');res.end(parentHtml);return;}
 if(url.pathname==='/test/process'){let body='';for await(const part of req)body+=part;seenProcess=JSON.parse(body);if(seenProcess.operation==='detect_cuts'){state.scene_cuts={source_id:state.info.source_id,times_ms:[5000.125,17000,40000],settings:{sensitivity:seenProcess.cut_sensitivity}};res.end('{}');return;}state.report={regions:state.plan.tracking.map(r=>({...r,state:'complete'})),warnings:[],completed_jobs:1,total_jobs:1};state.project='neutral_test';res.end('{}');return;}
 if(url.pathname===`/sam3d_funscript/timelines/${session}`){apiRequests++;res.setHeader('Content-Type','application/json');if(req.method==='POST'){let body='';for await(const part of req)body+=part;const sent=JSON.parse(body);if(sent.revision!==state.revision){res.statusCode=409;res.setHeader('Content-Type','text/plain');res.end('stale revision');return;}state={...state,revision:state.revision+1,plan:sent.plan};}res.end(JSON.stringify(state));return;}
 if(url.pathname.endsWith('/thumbnail')){if(state.info.source_id==='portrait'){res.setHeader('Content-Type','image/jpeg');res.end(fs.readFileSync(portraitThumb));}else{res.statusCode=404;res.end();}return;}
 let file;if(url.pathname.endsWith('/video'))file=state.info.source_id==='portrait'?portraitClip:clip;else if(url.pathname.startsWith('/sam3d_funscript/assets/'))file=path.join(root,'assets',path.basename(url.pathname));
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
 await page.evaluate('document.querySelector("#apply").click()');await until(()=>page.evaluate('document.querySelector("#apply").textContent.includes("Applied")'),'point apply');assert.equal(state.plan.stabilization[0].reference.points.length,3);
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
 assert.equal(errors.length,0,JSON.stringify(errors));
 console.log(JSON.stringify({checks:['neutral source playback','hour timeline zoom','apply feedback and parent ack','tracking regions and anchors','locks','overlap rejection','first-frame point picking','start edits clear stale points','undo','seek without accidental move','explicit resize and split','isolate selection into independent region','shift-drag selection','selected processing and result link','stale edit rejection','older draft recovered after reload','trimmed original-clock navigation','narrow layout','hard-cut scan preserves regions','cut navigation and shot selection','snapped guide seeking','subtle guides can be hidden','portrait aspect and full-frame filmstrip','wide and centered layouts','draggable preview columns and heights','thumbnail/lane/overview sizing','keyboard divider resize','layout persistence without plan edits','full-screen entry and exit','fit video/reset layout','old workflow bridge recovery message'],apiRequests,errors},null,2));
}finally{for(const socket of sockets)socket.close();chrome.kill('SIGTERM');server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(temporary,{recursive:true,force:true});}
