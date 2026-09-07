// Real cached hand clip: selection-local calibration, composition and offline roundtrip.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {spawn} from "node:child_process";
import {evaluate as valueAt} from "../assets/curve.mjs";
import {initializeTimeline,fitSelectionTrack,trackCoverage,applyTrack} from "../assets/timeline.mjs";

const base=process.argv[2],id=process.argv[3],output=path.resolve(process.argv[4]||"development/local-fit-browser");
assert.ok(base&&id,"Pass base URL and an existing project ID");fs.mkdirSync(output,{recursive:true});
const downloads=fs.mkdtempSync(path.join(output,"downloads-")),profile=fs.mkdtempSync(path.join(os.tmpdir(),"s3f-local-fit-chrome-"));
const chrome=spawn("/opt/google/chrome/chrome",["--headless","--no-sandbox","--disable-dev-shm-usage","--disable-gpu","--no-first-run","--no-default-browser-check","--remote-debugging-port=0",`--user-data-dir=${profile}`,"about:blank"],{stdio:"ignore"});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(test,label){for(let i=0;i<300;i++){if(await test())return;await pause(100);}throw new Error("Timed out: "+label);}
function unzip(file){
    const buffer=fs.readFileSync(file),files={};let offset=0;
    while(buffer.readUInt32LE(offset)===0x04034b50){
        assert.equal(buffer.readUInt16LE(offset+8),0);
        const size=buffer.readUInt32LE(offset+18),nameSize=buffer.readUInt16LE(offset+26),extra=buffer.readUInt16LE(offset+28);
        const name=buffer.toString("utf8",offset+30,offset+30+nameSize),start=offset+30+nameSize+extra;
        files[name]=buffer.toString("utf8",start,start+size);offset=start+size;
    }return files;
}
const report={checks:[],errors:[]};let ws;
try{
    let port;await until(()=>{try{port=fs.readFileSync(profile+"/DevToolsActivePort","utf8").split("\n")[0];return port;}catch{return false;}},"Chrome start");
    const target=await(await fetch(`http://127.0.0.1:${port}/json/new?about:blank`,{method:"PUT"})).json();
    ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener("open",r,{once:true}));
    let next=0;const pending=new Map();
    ws.addEventListener("message",event=>{const m=JSON.parse(event.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(m.error):p.resolve(m.result);}else if(m.method==="Runtime.exceptionThrown")report.errors.push(m.params.exceptionDetails);});
    const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
    const evaluate=async expression=>{const r=await call("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
    const click=selector=>evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const select=(selector,value)=>evaluate(`document.querySelector(${JSON.stringify(selector)}).value=${JSON.stringify(value)};document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new Event('change'))`);
    const controls=()=>evaluate("({component:document.querySelector('#component').value,range:Number(document.querySelector('#range').value),center:Number(document.querySelector('#center').value),metrics:document.querySelector('#metrics').textContent,direction:document.querySelector('#directionInfo').textContent})");
    async function file(selector,file){const doc=await call("DOM.getDocument"),input=await call("DOM.querySelector",{nodeId:doc.root.nodeId,selector});await call("DOM.setFileInputFiles",{nodeId:input.nodeId,files:[path.resolve(file)]});}
    async function download(){const folder=fs.mkdtempSync(path.join(downloads,"export-"));await call("Browser.setDownloadBehavior",{behavior:"allow",downloadPath:folder});await click("#save");let name;await until(()=>{name=fs.readdirSync(folder).find(f=>f.endsWith(".zip"));return name;},"ZIP download");return unzip(path.join(folder,name));}
    await call('Runtime.enable');await call('Page.enable');await call('Network.enable');
    await call('Emulation.setDeviceMetricsOverride',{width:1500,height:1250,deviceScaleFactor:1,mobile:false});
    await call('Page.navigate',{url:`${base}/sam3d_funscript/assets/viewer.html?project=${id}`});
    await until(()=>evaluate("document.querySelectorAll('#tracks .track').length>0"),'initial editor');
    const real=await(await fetch(`${base}/sam3d_funscript/projects/${id}`)).json();initializeTimeline(real);
    const liveView=()=>evaluate("({start:Number(document.querySelector('#viewRange').dataset.start),end:Number(document.querySelector('#viewRange').dataset.end),time:Number(document.querySelector('#time').dataset.ms),follow:document.querySelector('#followPlayhead').checked})");
    await until(()=>evaluate("document.querySelector('#video').readyState>=2"),'real video');
    await select('#zoom','1000');await evaluate("document.querySelector('#video').currentTime=2");
    await until(async()=>{const v=await liveView();return v.time>=2000&&v.start<=2000&&v.end>2000;},'follow on video seek');
    await evaluate("document.querySelector('#timelineScroll').scrollLeft=0");
    await until(async()=>!(await liveView()).follow,'manual pan disables follow');
    await evaluate("document.querySelector('#video').muted=true;document.querySelector('#video').play()");
    await until(async()=>(await liveView()).time>2200,'real playback');assert.equal((await liveView()).start,0);
    await click('#showPlayhead');const revealed=await liveView();assert.ok(revealed.time>=revealed.start&&revealed.time<=revealed.end);
    await evaluate("document.querySelector('#video').pause()");
    const hour=structuredClone(real),duration=3600000;
    // Synthetic one-hour timeline with 216,001 actions. No inference or explicit video needed.
    hour.metadata={...hour.metadata,source:{path:'synthetic-hour.mp4'},duration_ms:duration};
    hour.times_ms=hour.times_ms.map((_,i)=>i/(hour.times_ms.length-1)*duration);
    hour.config.max_gap_ms=60000;hour.config.axis_settings.L0.component=0;
    delete hour.preview;delete hour.timeline;initializeTimeline(hour);
    const dense=Array.from({length:216001},(_,i)=>({at:Math.round(i*1000/60),pos:Math.round(50+45*Math.sin(i/8))}));
    hour.scripts.L0.actions=dense;hour.timeline.tracks[0].script.actions=structuredClone(dense);
    const {newTrack}=await import('../assets/timeline.mjs');
    const second=newTrack(hour,'project_0','L0');second.name='Second anchor';second.script.actions=dense.map(a=>({...a,pos:100-a.pos}));
    hour.timeline.main.L0.locked=true;hour.timeline.tracks[0].locked=true;
    const fixture=path.join(output,'hour.json');fs.writeFileSync(fixture,JSON.stringify(hour));
    await file('#projectFile',fixture);await until(()=>evaluate("document.querySelector('#name').textContent==='synthetic-hour.mp4'"),'hour fixture');
    const view=()=>evaluate("({start:Number(document.querySelector('#viewRange').dataset.start),end:Number(document.querySelector('#viewRange').dataset.end),time:Number(document.querySelector('#time').dataset.ms),follow:document.querySelector('#followPlayhead').checked})");
    assert.equal((await view()).end-(await view()).start,30000,'Long clip opens at 30 seconds');
    await evaluate("document.querySelector('#timelineScroll').scrollLeft=(document.querySelector('#timelineScroll').scrollWidth-document.querySelector('#timelineScroll').clientWidth)/2");
    try{await until(async()=>Math.abs((await view()).start-1785000)<25,'scroll to middle');}catch(error){console.log(await view(),await evaluate("({left:document.querySelector('#timelineScroll').scrollLeft,width:document.querySelector('#timelineScroll').clientWidth,total:document.querySelector('#timelineScroll').scrollWidth})"));throw error;}
    assert.equal((await view()).time,0);assert.equal((await view()).follow,false);
    const panned=await view();await pause(200);assert.deepEqual(await view(),panned,'Pan does not snap back to playhead');
    await click('#zoomIn');let current=await view();assert.equal(current.end-current.start,15000);
    assert.ok(Math.abs((current.start+current.end)/2-1800000)<25,'Zoom keeps inspected region centered');
    await select('#zoom','1000');current=await view();assert.equal(current.end-current.start,1000);
    assert.ok(Math.abs((current.start+current.end)/2-1800000)<25);
    const beforePointer=await view();
    await evaluate("(()=>{const c=document.querySelector('#curve'),r=c.getBoundingClientRect();c.dispatchEvent(new WheelEvent('wheel',{ctrlKey:true,deltaY:-100,clientX:r.left+42+(r.width-54)*.25,clientY:r.top+40,bubbles:true,cancelable:true}));})()");
    current=await view();assert.ok(current.end-current.start<1000);
    assert.ok(Math.abs(beforePointer.start+(beforePointer.end-beforePointer.start)*.25-(current.start+(current.end-current.start)*.25))<1);
    const beforePan=await view();
    await evaluate("document.querySelector('#tracks canvas').dispatchEvent(new WheelEvent('wheel',{shiftKey:true,deltaY:120,bubbles:true,cancelable:true}))");
    assert.ok((await view()).start>beforePan.start);assert.equal((await view()).time,0);
    await select('#selectionStart','1800.2');await select('#selectionEnd','1803.8');await click('#zoomSelection');
    current=await view();assert.equal(current.start,1800200);assert.equal(current.end,1803800);
    // Click the locked main and another row at the same x: both resolve to the same source time.
    async function seekLane(selector){await evaluate(`(()=>{const c=document.querySelector(${JSON.stringify(selector)}),r=c.getBoundingClientRect();c.dispatchEvent(new MouseEvent('pointerdown',{button:0,clientX:r.left+42+(r.width-54)*.4,clientY:r.top+10,bubbles:true}));c.dispatchEvent(new MouseEvent('pointerup',{button:0,bubbles:true}));})()`);}
    await seekLane('#curve');const mainTime=(await view()).time;await seekLane('#tracks .track:last-child canvas');assert.equal((await view()).time,mainTime);
    assert.ok(Math.abs(mainTime-1801640)<2);
    const navExport=JSON.parse((await download())['project.json']);assert.deepEqual(navExport.scripts,hour.scripts);assert.deepEqual(navExport.timeline.tracks.map(t=>t.script),hour.timeline.tracks.map(t=>t.script));
    await click('#showPlayhead');current=await view();assert.ok(Math.abs((current.start+current.end)/2-mainTime)<1);
    await select('#zoom','0');current=await view();assert.deepEqual([current.start,current.end],[0,duration]);
    const elapsed=await evaluate("(()=>{const start=performance.now();for(let i=0;i<60;i++)window.dispatchEvent(new Event('scroll'));return performance.now()-start;})()");
    assert.ok(elapsed<2500,`60 full-overview repaints took ${elapsed} ms`);
    await evaluate("document.querySelector('#video').style.visibility='hidden';document.querySelector('.curves').scrollIntoView({block:'start'})");
    fs.writeFileSync(output+'/hour-overview.png',Buffer.from((await call('Page.captureScreenshot')).data,'base64'));
    await select('#zoom','30000');await evaluate("document.querySelector('#timelineScroll').scrollLeft=document.querySelector('#timelineScroll').scrollWidth");
    await until(async()=>Math.abs((await view()).end-duration)<1,'last part of hour');
    assert.match(await evaluate("document.querySelector('#viewRange').textContent"),/1:00:00/);
    await evaluate("document.querySelector('#timelineScroll').dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true,cancelable:true}))");assert.equal((await view()).start,0);
    await select('#zoomLevel','700'); // range input uses input events for continuous zoom
    await evaluate("document.querySelector('#zoomLevel').dispatchEvent(new Event('input'))");assert.ok((await view()).end-(await view()).start<10000);
    const exported=await download(),snapshot=JSON.parse(exported['project.json']),offline=path.join(output,'viewer.html');fs.writeFileSync(offline,exported['viewer.html']);
    await call('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0});
    await call('Page.navigate',{url:pathToFileURL(offline).href});await until(()=>evaluate("document.querySelectorAll('#tracks .track').length===2"),'offline viewport');
    current=await view();assert.equal(current.start,snapshot.preview.timeline_view.start_ms);assert.ok(Math.abs(current.end-current.start-snapshot.preview.timeline_view.span_ms)<1e-6);
    await click('#zoomIn');assert.ok((await view()).end-(await view()).start<snapshot.preview.timeline_view.span_ms);
    assert.equal(await evaluate("document.querySelector('#lockMain').textContent"),'Unlock');
    const again=JSON.parse((await download())['project.json']);assert.deepEqual(again.scripts,snapshot.scripts);assert.deepEqual(again.timeline.tracks,snapshot.timeline.tracks);
    await call('Emulation.setDeviceMetricsOverride',{width:560,height:1100,deviceScaleFactor:1,mobile:false});await pause(100);
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
    await evaluate("document.querySelector('.curves').scrollIntoView({block:'start'})");fs.writeFileSync(output+'/narrow.png',Buffer.from((await call('Page.captureScreenshot')).data,'base64'));
    assert.deepEqual(report.errors,[]);report.checks.push('One-hour / 216,001-action timeline: zoom, cursor anchor, native horizontal scrolling, time labels, selection fitting, synchronized tracks, locked curves, cached repaint, offline state and narrow layout');report.repaint60_ms=elapsed;
    fs.writeFileSync(output+'/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{ws?.close();chrome.kill('SIGTERM');}
