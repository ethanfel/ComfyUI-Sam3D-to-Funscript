// Run scripts/create_video_preview_fixture.py first, then test against an isolated ComfyUI instance.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {spawn} from "node:child_process";
import assert from "node:assert/strict";

const base=process.argv[2]||"http://127.0.0.1:8198",out=path.resolve("development/reference-node/preview-browser");fs.mkdirSync(out,{recursive:true});
const fixture=JSON.parse(fs.readFileSync("development/reference-node/preview-fixture/report.json","utf8"));
const profile=fs.mkdtempSync(path.join(os.tmpdir(),"s3f-reference-chrome-"));
const chrome=spawn("/opt/google/chrome/chrome",["--headless","--no-sandbox","--disable-dev-shm-usage","--disable-gpu","--disable-popup-blocking","--no-first-run","--no-default-browser-check","--remote-debugging-port=0",`--user-data-dir=${profile}`,"about:blank"],{stdio:["ignore","ignore","pipe"]});
let diagnostics="";chrome.stderr.on("data",c=>diagnostics+=c);const connections=[];
const pause=ms=>new Promise(r=>setTimeout(r,ms));async function until(fn,label,attempts=300){for(let i=0;i<attempts;i++){if(await fn())return;await pause(100)}throw new Error("Timed out: "+label)}
const report={checks:[],errors:[]};
async function connect(target){
 const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener("open",r,{once:true}));let id=0;const pending=new Map();
 ws.addEventListener("message",e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(m.error):p.resolve(m.result)}else if(m.method==="Runtime.exceptionThrown")report.errors.push(m.params.exceptionDetails)});
 const call=(method,params={})=>new Promise((resolve,reject)=>{const key=++id;pending.set(key,{resolve,reject});ws.send(JSON.stringify({id:key,method,params}))});
 const evaluate=async expression=>{const r=await call("Runtime.evaluate",{expression,awaitPromise:true,returnByValue:true,userGesture:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value};
 await call("Runtime.enable");await call("Page.enable");connections.push(ws);return {call,evaluate};
}
let debugPage;
try{
 let port;await until(()=>{try{port=fs.readFileSync(profile+"/DevToolsActivePort","utf8").split("\n")[0];return port}catch{return false}},"Chrome start");
 const target=await(await fetch(`http://127.0.0.1:${port}/json/new?about:blank`,{method:"PUT"})).json(),page=await connect(target);
 debugPage=page;
 await page.call("Emulation.setDeviceMetricsOverride",{width:1500,height:1100,deviceScaleFactor:1,mobile:false});
 const ready=()=>page.evaluate("document.querySelector('#video')?.readyState>=2&&!document.querySelector('#video').seeking");
 const state=()=>page.evaluate("({time:document.querySelector('#video').currentTime,ms:Number(document.querySelector('#time').dataset.ms),variant:document.querySelector('#videoVariant').value,paused:document.querySelector('#video').paused})");
 const variant=async name=>{await page.evaluate(`document.querySelector('#videoVariant').value=${JSON.stringify(name)};document.querySelector('#videoVariant').dispatchEvent(new Event('change'))`);await until(ready,'video switch');};
 const checkPixels=async original=>{
  const padding=fixture.mapping.padding_xy;
  const values=await page.evaluate(`(()=>{
   const v=document.querySelector('#video'),overlay=document.querySelector('#overlay'),i=Math.round(Number(document.querySelector('#time').dataset.ms)/40);
   const p=${original}?[112+i,86+Math.floor(i/2)]:[112+${padding[0]},86+${padding[1]}];
   const c=document.createElement('canvas');c.width=v.videoWidth;c.height=v.videoHeight;const ctx=c.getContext('2d');ctx.drawImage(v,0,0);
   const color=[...ctx.getImageData(...p,1,1).data];
   const r=overlay.getBoundingClientRect(),s=Math.min(r.width/v.videoWidth,r.height/v.videoHeight),x=(r.width-v.videoWidth*s)/2+p[0]*s,y=(r.height-v.videoHeight*s)/2+p[1]*s;
   const anchor=[...overlay.getContext('2d').getImageData(Math.round(x),Math.round(y),1,1).data];return {color,anchor,p,i};})()`);
  assert.ok(values.color[0]>180&&values.color[1]<65,JSON.stringify(values));
  assert.ok(values.anchor[0]>200&&values.anchor[1]>140&&values.anchor[1]<220&&values.anchor[2]<150,JSON.stringify(values));
 };
 await page.call("Page.navigate",{url:base+"/sam3d_funscript/assets/viewer.html?project="+fixture.project});await until(ready,'stabilized media');
 assert.equal(await page.evaluate("document.querySelector('#videoVariantLabel').hidden"),false);
 await page.evaluate("document.querySelector('#video').currentTime=1");await until(async()=>await ready()&&Math.abs((await state()).ms-1000)<1,'seek stabilized');await checkPixels(false);
 await variant('original');let current=await state();assert.ok(Math.abs(current.time-2.28)<.001,JSON.stringify(current));assert.ok(Math.abs(current.ms-1000)<1);await checkPixels(true);
 report.checks.push('Original/stabilized switch preserves trimmed time; projected anchor matches a known moving marker in both videos');
 await page.evaluate("document.querySelector('#video').play()");await pause(350);current=await state();assert.ok(current.ms>1200&&current.ms<1550,JSON.stringify(current));
 await variant('stabilized');assert.equal((await state()).paused,false);await pause(80);await page.evaluate("document.querySelector('#video').pause()");await checkPixels(false);
 // Rapid switching must not apply an old loadedmetadata handler to the new source.
 await page.evaluate("const sel=document.querySelector('#videoVariant');for(const value of ['original','stabilized','original']){sel.value=value;sel.dispatchEvent(new Event('change'))}");await until(ready,'rapid switch');current=await state();assert.ok(Math.abs(current.time-current.ms/1000-1.28)<.001);
 await page.evaluate("document.querySelector('#video').currentTime=3.9");await until(async()=>await ready()&&Math.abs((await state()).ms-2040)<2,'original trim boundary');
 report.checks.push('Playback resumes across switches, rapid switches stay aligned, and original playback stays within the analyzed interval');
 await page.call('Emulation.setDeviceMetricsOverride',{width:560,height:1000,deviceScaleFactor:1,mobile:false});await pause(150);assert.equal(await page.evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
 fs.writeFileSync(path.join(out,'preview.png'),Buffer.from((await page.call('Page.captureScreenshot')).data,'base64'));
 await page.call('Page.navigate',{url:base+'/sam3d_funscript/assets/viewer.html?project='+fixture.legacy});await until(ready,'legacy stabilized media');await until(()=>page.evaluate("!document.querySelector('#videoVariantLabel').hidden"),'legacy mapping recovery');await variant('original');await checkPixels(true);
 report.checks.push('Existing projects recover the comparison mapping without extracting poses again');
 const legacyMetadata=await(await fetch(base+'/sam3d_funscript/video/'+fixture.legacy+'/reference')).json();assert.equal(legacyMetadata.source_offset_ms,1280);
 assert.equal((await fetch(base+'/sam3d_funscript/video/'+fixture.project+'?variant=invalid')).status,400);
 assert.equal((await fetch(base+'/sam3d_funscript/video/'+fixture.plain+'?variant=original')).status,404);
 await page.call('Page.navigate',{url:base+'/sam3d_funscript/assets/viewer.html?project='+fixture.plain});await until(()=>page.evaluate("document.querySelector('#time')?.dataset.ms!==undefined"),'plain project');assert.equal(await page.evaluate("document.querySelector('#videoVariantLabel').hidden"),true);
 // The exported viewer contains all modules and remembers a separate local file per view.
 await page.call('Page.navigate',{url:'file://'+fixture.html});await until(()=>page.evaluate("document.querySelector('#time')?.dataset.ms!==undefined"),'offline viewer');
 await page.call('DOM.enable');
 async function choose(file){const {root}=await page.call('DOM.getDocument');const {nodeId}=await page.call('DOM.querySelector',{nodeId:root.nodeId,selector:'#videoFile'});await page.call('DOM.setFileInputFiles',{nodeId,files:[file]});await until(ready,'offline file');}
 await choose(fixture.stabilized);await page.evaluate("document.querySelector('#video').currentTime=1");await until(async()=>await ready()&&Math.abs((await state()).ms-1000)<1,'offline seek');
 await page.evaluate("document.querySelector('#videoVariant').value='original';document.querySelector('#videoVariant').dispatchEvent(new Event('change'))");
 await choose(fixture.original);current=await state();assert.ok(Math.abs(current.time-2.28)<.001,JSON.stringify(current));await checkPixels(true);
 await variant('stabilized');assert.ok(Math.abs((await state()).time-1)<.001);await checkPixels(false);
 report.checks.push('Offline export loads both local videos and switches without losing time or needing to reselect either file');
 assert.equal(report.errors.length,0);fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}catch(error){const state=await debugPage?.evaluate("({status:document.querySelector('#status')?.textContent,src:document.querySelector('#video')?.src,ready:document.querySelector('#video')?.readyState,error:document.querySelector('#video')?.error?.message})");fs.writeFileSync(path.join(out,'failure.json'),JSON.stringify({error:String(error),report,state,diagnostics},null,2));throw error}finally{
 connections.forEach(ws=>ws.close());chrome.kill('SIGTERM');await new Promise(r=>chrome.exitCode!==null?r():chrome.once('exit',r));fs.rmSync(profile,{recursive:true,force:true});
}
