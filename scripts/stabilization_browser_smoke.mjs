// Exercise the exported comparison in installed Chrome, without a server or npm dependencies.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {spawn} from "node:child_process";
import assert from "node:assert/strict";

const root=path.resolve(process.argv[2]||"development/stabilization");
const output=path.join(root,"browser");fs.mkdirSync(output,{recursive:true});
const profile=fs.mkdtempSync(path.join(os.tmpdir(),"s3f-stabilization-chrome-"));
const chrome=spawn("/opt/google/chrome/chrome",["--headless","--no-sandbox","--disable-dev-shm-usage","--disable-gpu","--no-first-run","--no-default-browser-check","--remote-debugging-port=0",`--user-data-dir=${profile}`,"about:blank"],{stdio:["ignore","ignore","pipe"]});
let diagnostics="",ws;chrome.stderr.on("data",chunk=>diagnostics+=chunk);
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(test,label){for(let i=0;i<150;i++){if(await test())return;await pause(100)}throw new Error("Timed out: "+label)}
const report={errors:[],checks:[]};
try{
 let port;
 await until(()=>{try{port=fs.readFileSync(profile+"/DevToolsActivePort","utf8").split("\n")[0];return port}catch{return false}},"Chrome start");
 const target=await(await fetch(`http://127.0.0.1:${port}/json/new?about:blank`,{method:"PUT"})).json();
 ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise(resolve=>ws.addEventListener("open",resolve,{once:true}));
 let next=0;const pending=new Map();
 ws.addEventListener("message",event=>{const m=JSON.parse(event.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(m.error):p.resolve(m.result)}else if(m.method==="Runtime.exceptionThrown")report.errors.push(m.params.exceptionDetails)});
 const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}))});
 const evaluate=async expression=>{const r=await call("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value};
 await call("Runtime.enable");await call("Page.enable");
 await call("Emulation.setDeviceMetricsOverride",{width:1520,height:1080,deviceScaleFactor:1,mobile:false});
 await call("Page.navigate",{url:pathToFileURL(path.join(root,"index.html")).href});
 await until(()=>evaluate("document.querySelectorAll('video').length===3&&[...document.querySelectorAll('video')].every(v=>v.readyState>=2)"),"three local videos decode");
 report.videos=await evaluate("[...document.querySelectorAll('video')].map(v=>({width:v.videoWidth,height:v.videoHeight,duration:v.duration}))");
 assert.equal(report.videos[0].width,960);
 for(const video of report.videos)assert.ok(Math.abs(video.duration-10.03125)<.002);
 report.checks.push("Original and both stabilized videos decode from a local HTML file");
 await evaluate("document.querySelector('#seek').value=128;document.querySelector('#seek').dispatchEvent(new Event('input'))");
 await until(()=>evaluate("[...document.querySelectorAll('video')].every(v=>!v.seeking&&Math.abs(v.currentTime-4)<.001)"),"synchronized seek");
 await evaluate("document.querySelector('#next').click()");
 await until(()=>evaluate("[...document.querySelectorAll('video')].every(v=>!v.seeking&&Math.abs(v.currentTime-4.03125)<.001)"),"next frame");
 await evaluate("document.querySelector('#previous').click()");
 await until(()=>evaluate("[...document.querySelectorAll('video')].every(v=>!v.seeking&&Math.abs(v.currentTime-4)<.001)"),"previous frame");
 report.checks.push("Scrubbing and both frame-step buttons synchronize all videos at the source timestamp");
 await evaluate("document.querySelector('#model').value='tapnextpp';document.querySelector('#model').dispatchEvent(new Event('change'));document.querySelector('#overlay').click()");
 assert.equal(await evaluate("document.querySelector('#overlay').checked"),false);
 await evaluate("document.querySelector('#overlay').click()");
 await evaluate("document.querySelector('#play').click()");
 await until(()=>evaluate("document.querySelector('#play').textContent==='Pause'"),"play starts");
 await pause(1200);
 await evaluate("document.querySelector('#play').click()");
 report.playback_times=await evaluate("[...document.querySelectorAll('video')].map(v=>v.currentTime)");
 assert.ok(report.playback_times[0]>4.5);
 assert.ok(Math.max(...report.playback_times)-Math.min(...report.playback_times)<.12);
 assert.equal(await evaluate("[...document.querySelectorAll('video')].every(v=>v.paused)"),true);
 report.checks.push("Playback advances and stays synchronized; pause, model selector, and overlays work");
 const rect=await evaluate("(()=>{const r=document.querySelector('#graph').getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}})()");
 const x=rect.x+20+(rect.w-40)*.7,y=rect.y+rect.h/2;
 await call("Input.dispatchMouseEvent",{type:"mousePressed",x,y,button:"left",clickCount:1});
 await call("Input.dispatchMouseEvent",{type:"mouseReleased",x,y,button:"left",clickCount:1});
 await until(()=>evaluate("[...document.querySelectorAll('video')].every(v=>!v.seeking&&Math.abs(v.currentTime-7)<.02)"),"graph seek");
 report.checks.push("Real pointer click on displacement graph seeks all videos");
 await evaluate("document.querySelector('#seek').value=320;document.querySelector('#seek').dispatchEvent(new Event('input'))");
 await until(()=>evaluate("[...document.querySelectorAll('video')].every(v=>!v.seeking&&Math.abs(v.currentTime-10)<.001)"),"last frame");
 report.checks.push("Last frame remains selectable");
 // Preserve a nonexplicit QA screenshot; actual video playback was checked above.
 await evaluate("document.querySelectorAll('video').forEach(v=>v.style.visibility='hidden')");
 fs.writeFileSync(path.join(output,"review-desktop.png"),Buffer.from((await call("Page.captureScreenshot")).data,"base64"));
 await call("Emulation.setDeviceMetricsOverride",{width:560,height:1000,deviceScaleFactor:1,mobile:false});
 await pause(200);
 assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth"),true);
 report.checks.push("Narrow layout has no horizontal overflow");
 assert.equal(await evaluate("document.querySelector('#error').textContent"),"");
 assert.equal(report.errors.length,0);
 fs.writeFileSync(path.join(output,"report.json"),JSON.stringify(report,null,2)+"\n");
 console.log(JSON.stringify(report,null,2));
}finally{
 if(ws)ws.close();chrome.kill("SIGTERM");
 await new Promise(resolve=>{if(chrome.exitCode!==null)resolve();else chrome.once("exit",resolve)});
 fs.rmSync(profile,{recursive:true,force:true});
}
