import {browserFrame} from "./browser-frame.mjs";
// Integration test against an isolated ComfyUI instance and the neutral hard-cut fixture.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {spawn} from "node:child_process";
import assert from "node:assert/strict";

const base=process.argv[2]||"http://127.0.0.1:8198",out=path.resolve("development/cut-browser");fs.mkdirSync(out,{recursive:true});
const session=crypto.randomUUID().replaceAll('-','');
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
 const preparation=JSON.parse(fs.readFileSync('workflows/processing_timeline.api.json','utf8'));
 preparation['1'].inputs.file='cut-test.mp4';
 const queued=await(await fetch(base+'/prompt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:preparation,partial_execution_targets:['2'],extra_data:{extra_pnginfo:{workflow:{nodes:[{id:2,properties:{s3f_timeline_session:session}}]}}}})})).json();assert.ok(queued.prompt_id,JSON.stringify(queued));
 await until(async()=>{const response=await fetch(`${base}/sam3d_funscript/timelines/${session}`);return response.ok},'prepared session');
 let port;await until(()=>{try{port=fs.readFileSync(profile+"/DevToolsActivePort","utf8").split("\n")[0];return port}catch{return false}},"Chrome start");
 const target=await(await fetch(`http://127.0.0.1:${port}/json/new?about:blank`,{method:"PUT"})).json(),parent=await connect(target);
 await parent.call("Emulation.setDeviceMetricsOverride",{width:1680,height:1050,deviceScaleFactor:1,mobile:false});
 await parent.call("Page.navigate",{url:base});
 await until(()=>parent.evaluate("!!document.querySelector('canvas')"),"Comfy canvas");
 await parent.evaluate("(async()=>{window.testApp=(await import('/scripts/app.js')).app})()");
 await until(()=>parent.evaluate("!!window.LiteGraph?.registered_node_types?.S3F_ProcessingTimeline&&!!window.testApp?.graph&&!!window.testApp.positionConversion"),"timeline registration");
 const workflow=JSON.parse(fs.readFileSync("workflows/processing_timeline.json","utf8"));
 workflow.nodes.find(n=>n.id===1).widgets_values[0]='cut-test.mp4';
 const node=workflow.nodes.find(n=>n.id===2);node.properties.s3f_timeline_session=session;node.properties.s3f_timeline_ready=true;
 await parent.evaluate(`window.testApp.loadGraphData(${JSON.stringify(workflow)})`);
 await until(()=>parent.evaluate("!!window.testApp.graph.getNodeById(2)?.s3fTimelineStatus"),"timeline widget");
 await parent.evaluate("window.testApp.graph.getNodeById(2).widgets.find(w=>w.name==='sample_fps').value=1;window.testApp.graph.getNodeById(2).widgets.find(w=>w.name==='Open processing timeline').callback()");
 let popup;await until(async()=>{popup=(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t=>t.url.includes('/assets/workspace.html'));return popup},'workspace');
 const shell=await connect(popup),editor=browserFrame(shell,'processing-timeline.html');
 await shell.call('Emulation.setDeviceMetricsOverride',{width:1450,height:1180,deviceScaleFactor:1,mobile:false});
 await until(()=>shell.evaluate("[...document.querySelectorAll('iframe')].some(frame=>frame.src.includes('processing-timeline.html')&&frame.contentDocument?.readyState==='complete')"),'timeline frame');
 await until(()=>editor.evaluate("document.querySelector('#source')?.readyState>=2&&!document.querySelector('#detectCuts').disabled"),'timeline ready');
 const read=async()=>await(await fetch(`${base}/sam3d_funscript/timelines/${session}`)).json();
 const before=await read();
 await editor.evaluate("document.querySelector('#detectCuts').click()");
 await until(()=>editor.evaluate("document.querySelector('#progressText').textContent.includes('Cut scan complete')"),'real cut scan');
 const scanned=await read();assert.deepEqual(scanned.scene_cuts.times_ms,[2000,4000]);assert.equal(scanned.scene_cuts.frames,180);
 assert.deepEqual(scanned.plan,before.plan);assert.equal(scanned.revision,before.revision);assert.equal(scanned.report,before.report);assert.equal(scanned.project,before.project);
 report.scan=scanned.scene_cuts;report.checks.push('Real ComfyUI partial queue detects both hard cuts at exact source frames without pose extraction or plan changes');
 const job=Object.values(await(await fetch(base+'/history?max_items=1')).json())[0];assert.deepEqual(job.prompt[4],['2']);assert.ok(!job.outputs['3']);
 await editor.evaluate("document.querySelector('#nextCut').click();document.querySelector('#selectShot').click()");
 assert.deepEqual(await editor.evaluate("[document.querySelector('#selectionIn').value,document.querySelector('#selectionOut').value]"),['2.000','4.000']);
 await editor.evaluate("document.querySelector('#isolateSelection').click();window.s3fTimelineApply()");
 assert.equal((await read()).plan.tracking.length,3);report.checks.push('Cut guides select a shot and isolate its tracking section');
 await editor.evaluate("document.querySelector('#detectCuts').click()");
 await until(()=>editor.evaluate("document.querySelector('#cancel').hidden&&document.querySelector('#cutStatus').textContent.includes('cached')"),'cached scan');
 assert.equal((await read()).scene_cuts.cache_hit,true);report.checks.push('Repeated detection reuses the scan cache and preserves the edited schedule');
 await editor.evaluate("document.querySelector('#timelineBody').scrollIntoView({block:'end'})");
 fs.writeFileSync(path.join(out,'timeline.png'),Buffer.from((await shell.call('Page.captureScreenshot')).data,'base64'));
 await shell.call('Emulation.setDeviceMetricsOverride',{width:560,height:1000,deviceScaleFactor:1,mobile:false});await pause(150);
 assert.equal(await editor.evaluate('document.documentElement.scrollWidth<=innerWidth'),true);report.checks.push('Cut controls and guides fit narrow windows');
 assert.equal(report.errors.length,0);fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}catch(error){fs.writeFileSync(path.join(out,'failure.json'),JSON.stringify({error:String(error),report,diagnostics},null,2));throw error}finally{
 connections.forEach(ws=>ws.close());chrome.kill('SIGTERM');await new Promise(r=>chrome.exitCode!==null?r():chrome.once('exit',r));fs.rmSync(profile,{recursive:true,force:true});
}
