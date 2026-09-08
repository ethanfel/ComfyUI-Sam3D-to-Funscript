import {browserFrame} from "./browser-frame.mjs";
// Integration test against an isolated ComfyUI instance and the local reference clip.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {spawn} from "node:child_process";
import assert from "node:assert/strict";

const base=process.argv[2]||"http://127.0.0.1:8198",out=path.resolve("development/reference-node/browser");fs.mkdirSync(out,{recursive:true});
const prepared=JSON.parse(fs.readFileSync("development/reference-node/prepare-history.json","utf8")).outputs["2"].s3f_reference[0];
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
try{
 let port;await until(()=>{try{port=fs.readFileSync(profile+"/DevToolsActivePort","utf8").split("\n")[0];return port}catch{return false}},"Chrome start");
 const target=await(await fetch(`http://127.0.0.1:${port}/json/new?about:blank`,{method:"PUT"})).json(),parent=await connect(target);
 await parent.call("Emulation.setDeviceMetricsOverride",{width:1680,height:1050,deviceScaleFactor:1,mobile:false});
 await parent.call("Page.navigate",{url:base});
 await until(()=>parent.evaluate("!!document.querySelector('canvas')"),"Comfy canvas");
 await parent.evaluate("(async()=>{window.testApp=(await import('/scripts/app.js')).app})()");
 await until(()=>parent.evaluate("!!window.LiteGraph?.registered_node_types?.S3F_ReferenceStabilize&&!!window.testApp?.graph&&!!window.testApp.positionConversion"),"reference node registration");
 const workflow=JSON.parse(fs.readFileSync("workflows/reference_stabilization.json","utf8"));
 const setup=structuredClone(workflow);setup.nodes[1].properties.s3f_reference=prepared;
 await parent.evaluate(`window.testApp.loadGraphData(${JSON.stringify(setup)})`);
 await until(()=>parent.evaluate("!!window.testApp.graph.getNodeById(2)?.s3fReferenceStatus"),"reference node widget");
 await parent.evaluate("window.testApp.graph.getNodeById(2).widgets.find(w=>w.name==='Open reference editor').callback()");
 let popup;await until(async()=>{popup=(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t=>t.url.includes('/assets/workspace.html'));return popup},"dedicated reference tab");
 const shell=await connect(popup),editor=browserFrame(shell,"reference.html");await editor.call("Emulation.setDeviceMetricsOverride",{width:1500,height:1200,deviceScaleFactor:1,mobile:false});
 await until(()=>shell.evaluate("[...document.querySelectorAll('iframe')].some(frame=>new URL(frame.src).pathname.endsWith('/reference.html')&&frame.contentDocument?.readyState==='complete')"),'editor iframe');
 await until(()=>editor.evaluate("document.querySelector('#source')?.readyState>=2&&!document.querySelector('#source').seeking&&document.querySelector('#pointCount').textContent.includes('0 starting')"),"first source frame");
 // HTTP LAN origins do not expose crypto.randomUUID.
 await editor.evaluate("Object.defineProperty(crypto,'randomUUID',{value:undefined,configurable:true})");
 await editor.evaluate("window.s3fReferenceTrack()");
 assert.match(await editor.evaluate("document.querySelector('#error').textContent"),/at least three/);
 const map=await editor.evaluate("(()=>{const r=document.querySelector('#sourceCanvas').getBoundingClientRect(),s=Math.min(r.width/960,r.height/1440);return {x:r.x+(r.width-960*s)/2,y:r.y+(r.height-1440*s)/2,s}})()");
 async function pointer(x,y,type="mousePressed",button="left"){await editor.call("Input.dispatchMouseEvent",{type,x:map.x+x*map.s,y:map.y+y*map.s,button,clickCount:1,buttons:type==="mouseMoved"?1:undefined})}
 await editor.evaluate("document.querySelector('#mode').value='crop';document.querySelector('#mode').dispatchEvent(new Event('change'))");
 await until(()=>editor.evaluate("!document.querySelector('#source').seeking"),"crop frame ready");
 await pointer(192,928);await pointer(704,1439,"mouseMoved");await pointer(704,1439,"mouseReleased");
 await editor.evaluate("document.querySelector('#mode').value='points';document.querySelector('#mode').dispatchEvent(new Event('change'))");
 await until(()=>editor.evaluate("!document.querySelector('#source').seeking"),"point frame ready");
 for(const [x,y] of [[320,1370],[350,1370],[380,1370],[330,1400],[360,1400],[400,1400]]){await pointer(x,y);await pointer(x,y,"mouseReleased")}
 assert.match(await editor.evaluate("document.querySelector('#pointCount').textContent"),/^6 starting/);
 await editor.evaluate("document.querySelector('#track').click()");
 await until(()=>editor.evaluate("document.querySelector('#track').disabled"),"Track locks during submission");
 await until(()=>parent.evaluate("JSON.parse(window.testApp.graph.getNodeById(2).widgets.find(w=>w.name==='reference_json').value).points?.length===6"),"Track applies settings");
 const config=await parent.evaluate("JSON.parse(window.testApp.graph.getNodeById(2).widgets.find(w=>w.name==='reference_json').value)");assert.equal(config.points.length,6);assert.ok(config.source_id);
 report.checks.push("Real crop/point gestures apply source-bound settings to the connected node");
 fs.writeFileSync(path.join(out,"selected-reference.json"),JSON.stringify(config,null,2));
 await until(()=>parent.evaluate(`window.testApp.graph.getNodeById(2).properties.s3f_reference!==${JSON.stringify(prepared)}`),"GPU tracking and render",6000);
 await until(()=>editor.evaluate("document.querySelector('#metrics').textContent.includes('held /')"),"tracking results in existing editor");
 const firstId=await parent.evaluate("window.testApp.graph.getNodeById(2).properties.s3f_reference");
 const first=await(await fetch(base+"/sam3d_funscript/reference/"+firstId)).json();assert.equal(first.data.times_ms.length,321);assert.equal(first.video.exact_frame_timing,true);
 report.initial={id:firstId,counts:first.data.counts,tracking_seconds:first.data.tracking.tracking_seconds};
 await until(()=>editor.evaluate("!document.querySelector('#track').disabled"),"Track completes");
 const history=await(await fetch(base+"/history?max_items=1")).json(),job=Object.values(history)[0];
 assert.deepEqual(job.prompt[4],["2"]);assert.ok(!job.outputs["5"]);
 report.checks.push("Track applies settings over plain HTTP, targets only the stabilizer, and refreshes in place");
 await parent.evaluate("window.testApp.graph.getNodeById(2).widgets.find(w=>w.name==='model_file').value='s3f-intentionally-missing.pth'");
 await editor.evaluate("window.s3fReferenceTrack()");
 assert.match(await editor.evaluate("document.querySelector('#error').textContent"),/missing.pth|Value not in list/);
 await parent.evaluate("window.testApp.graph.getNodeById(2).widgets.find(w=>w.name==='model_file').value='cotracker3_scaled_online.pth'");
 await editor.evaluate("window.s3fReferenceTrack()");
 assert.equal(await editor.evaluate("document.querySelector('#error').textContent"),"");
 assert.equal(await editor.evaluate("document.querySelector('#trackProgress').value"),1);
 report.checks.push("Tracking errors are visible in the editor; retry and unchanged cached runs complete");
 report.checks.push("ComfyUI tracks all 321 frames and streams a verified file-backed VIDEO");
 // Exercise a small synthetic manual section; this is UI validation, not an accuracy correction.
 await editor.evaluate("document.querySelector('#seek').value=16;document.querySelector('#seek').dispatchEvent(new Event('input'))");
 await until(()=>editor.evaluate("!document.querySelector('#source').seeking"),"section start");
 await editor.evaluate("document.querySelector('#newSection').click();document.querySelector('#estimate').click();document.querySelector('#seek').value=20;document.querySelector('#seek').dispatchEvent(new Event('input'))");
 await until(()=>editor.evaluate("!document.querySelector('#source').seeking"),"section end");
 await pointer(360,1395);await pointer(360,1395,"mouseReleased");
 assert.equal(await editor.evaluate("document.querySelectorAll('#keys .keys').length"),2);
 // Queueing from ComfyUI must flush the open reference editor even without Apply.
 await parent.evaluate("window.testApp.queuePrompt(0,1,{queueNodeIds:['2']})");
 await until(()=>parent.evaluate(`window.testApp.graph.getNodeById(2).properties.s3f_reference!==${JSON.stringify(firstId)}`),"correction render",2000);
 const correctedId=await parent.evaluate("window.testApp.graph.getNodeById(2).properties.s3f_reference");
 const corrected=await(await fetch(base+"/sam3d_funscript/reference/"+correctedId)).json();assert.equal(corrected.cache_hit,true);assert.equal(corrected.tracking_cache,first.tracking_cache);assert.equal(corrected.data.counts.manual,5);
 assert.deepEqual(corrected.data.auto_shift_xy,first.data.auto_shift_xy);
 report.corrected={id:correctedId,counts:corrected.data.counts,cache_hit:corrected.cache_hit};
 report.checks.push("Queue flush saves manual keys; corrected frames render from the unchanged tracking cache");
 await until(()=>editor.evaluate("document.querySelectorAll('#keys .keys').length===2&&!document.querySelector('#source').seeking"),"corrected editor refresh");
 await editor.evaluate("document.querySelector('#play').click()");await pause(1100);await editor.evaluate("document.querySelector('#play').click()");
 assert.ok(await editor.evaluate("Number(document.querySelector('#seek').value)>8"));
 await editor.evaluate("document.querySelector('#seek').value=320;document.querySelector('#seek').dispatchEvent(new Event('input'))");
 await until(()=>editor.evaluate("!document.querySelector('#source').seeking&&document.querySelector('#time').textContent.includes('321/321')"),"last-frame seek");
 report.checks.push("Playback, exact frame stepping, and last-frame seeking work");
 await editor.evaluate("document.querySelector('#view').value='10';document.querySelector('#view').dispatchEvent(new Event('change'));document.querySelector('#pan').value=0;document.querySelector('#pan').dispatchEvent(new Event('input'));document.querySelector('#goTime').value=0;document.querySelector('#go').click();document.querySelector('#nextGap').click()");
 await until(()=>editor.evaluate("!document.querySelector('#source').seeking"),"gap navigation");
 assert.match(await editor.evaluate("document.querySelector('#metrics').textContent"),/current: held/);
 report.checks.push("Zoom, horizontal position, direct time seeking, and next-gap navigation work");
 await editor.evaluate("document.querySelector('#sourceCanvas').style.visibility='hidden';document.querySelector('#previewCanvas').style.visibility='hidden'");
 fs.writeFileSync(path.join(out,"editor.png"),Buffer.from((await editor.call("Page.captureScreenshot")).data,"base64"));
 await editor.call("Emulation.setDeviceMetricsOverride",{width:560,height:1000,deviceScaleFactor:1,mobile:false});await pause(200);assert.equal(await editor.evaluate("document.documentElement.scrollWidth<=innerWidth"),true);
 assert.equal(await editor.evaluate("document.querySelector('#error').textContent"),"");
 // Validate the complete example against actual rendered node dimensions.
 await parent.evaluate(`window.testApp.loadGraphData(${JSON.stringify(workflow)})`);
 await until(()=>parent.evaluate("window.testApp.graph._nodes.length===7"),"full workflow load");
 const layout=await parent.evaluate("window.testApp.graph._nodes.map(n=>({id:n.id,type:n.type,pos:[...n.pos],size:[...n.size]}))");
 for(let i=0;i<layout.length;i++)for(let j=i+1;j<layout.length;j++){const a=layout[i],b=layout[j];assert.ok(a.pos[0]+a.size[0]<=b.pos[0]||b.pos[0]+b.size[0]<=a.pos[0]||a.pos[1]+a.size[1]<=b.pos[1]-30||b.pos[1]+b.size[1]<=a.pos[1]-30,`Overlapping nodes ${a.id}, ${b.id}`)}
 report.layout=layout;report.checks.push("Example workflow opens with no node overlap; compact and standalone editors remain separate");
 assert.equal(report.errors.length,0);fs.writeFileSync(path.join(out,"report.json"),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}catch(error){fs.writeFileSync(path.join(out,"failure.json"),JSON.stringify({error:String(error),report,diagnostics},null,2));throw error}finally{
 connections.forEach(ws=>ws.close());chrome.kill("SIGTERM");await new Promise(r=>chrome.exitCode!==null?r():chrome.once("exit",r));fs.rmSync(profile,{recursive:true,force:true});
}
