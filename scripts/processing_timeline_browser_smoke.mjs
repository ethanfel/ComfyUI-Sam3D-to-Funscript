import {browserFrame} from "./browser-frame.mjs";
// Integration test against an isolated ComfyUI instance and the local reference clip.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {spawn} from "node:child_process";
import assert from "node:assert/strict";

const base=process.argv[2]||"http://127.0.0.1:8198",out=path.resolve("development/processing-timeline/browser");fs.mkdirSync(out,{recursive:true});
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
 preparation['1'].inputs.file='videos/general/2601102105_OC_00001.mp4';
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
 workflow.nodes.find(n=>n.id===1).widgets_values[0]='videos/general/2601102105_OC_00001.mp4';
 const node=workflow.nodes.find(n=>n.id===2);node.properties.s3f_timeline_session=session;node.properties.s3f_timeline_ready=true;
 await parent.evaluate(`window.testApp.loadGraphData(${JSON.stringify(workflow)})`);
 await until(()=>parent.evaluate("!!window.testApp.graph.getNodeById(2)?.s3fTimelineStatus"),"timeline widget");
 const clones=await parent.evaluate("(async()=>{const original=window.testApp.graph.getNodeById(2),clone=original.clone();window.testApp.graph.add(clone);await new Promise(resolve=>setTimeout(resolve,0));const ids=[original.properties.s3f_timeline_session,clone.properties.s3f_timeline_session];window.testApp.graph.remove(clone);return ids})()");
 assert.notEqual(clones[0],clones[1]);report.checks.push('Cloned timeline nodes receive separate processing sessions');
 await parent.evaluate("window.testApp.graph.getNodeById(2).widgets.find(w=>w.name==='sample_fps').value=8;window.testApp.graph.getNodeById(2).widgets.find(w=>w.name==='Open processing timeline').callback()");
 let popup;await until(async()=>{popup=(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t=>t.url.includes('/assets/workspace.html'));return popup},"dedicated timeline tab");
 const shell=await connect(popup),editor=browserFrame(shell,"processing-timeline.html");await editor.call("Emulation.setDeviceMetricsOverride",{width:1500,height:1150,deviceScaleFactor:1,mobile:false});
 await until(()=>shell.evaluate("[...document.querySelectorAll('iframe')].some(frame=>new URL(frame.src).pathname.endsWith('/processing-timeline.html')&&frame.contentDocument?.readyState==='complete')"),'editor iframe').catch(async error=>{report.workspace=await shell.evaluate("({html:document.documentElement.outerHTML.slice(0,5000),frames:[...document.querySelectorAll('iframe')].map(f=>({src:f.src,ready:f.contentDocument?.readyState,body:f.contentDocument?.body?.textContent?.slice(0,1000)}))})");throw error});
 await until(()=>editor.evaluate("document.querySelector('#source')?.readyState>=2&&!document.querySelector('#apply').disabled"),"source frame and editor");
 async function field(id,value){await editor.evaluate(`(()=>{const el=document.getElementById(${JSON.stringify(id)});el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('change'))})()`)}
 async function click(id){await editor.evaluate(`document.getElementById(${JSON.stringify(id)}).click()`)}
 await editor.evaluate("Object.defineProperty(crypto,'randomUUID',{value:undefined,configurable:true})");
 await field('goTime',5);await click('seekTime');await click('split');
 assert.equal(await editor.evaluate("document.querySelectorAll('#trackingLane .region-bar').length"),2);
 await field('anchor','mouth');await field('regionName','Second anchor');
 await editor.evaluate("for(const anchor of ['left_hand','right_hand'])document.querySelector('#additionalAnchors input[value='+anchor+']').click()");
 await click('regionLock');assert.equal(await editor.evaluate("document.querySelector('#anchor').disabled"),true);
 await editor.evaluate("window.s3fTimelineApply()");
 const read=async()=>await(await fetch(`${base}/sam3d_funscript/timelines/${session}`)).json();
 let state=await read();assert.equal(state.plan.tracking.length,2);assert.equal(state.plan.tracking[1].anchor,'mouth');assert.equal(state.plan.tracking[1].locked,true);assert.deepEqual(state.plan.tracking[1].additional_anchors,['left_hand','right_hand']);
 assert.match(await editor.evaluate("document.querySelector('#apply').textContent"),/Applied/);
 report.checks.push('Split, per-region anchor, lock, Apply acknowledgement and plain HTTP session IDs');
 await click('regionLock');await field('selectionIn',0);await field('selectionOut',2);await click('addStabilization');
 await field('crop','[191,928,512,511]');await field('referenceMode','points');
 await until(()=>editor.evaluate("!document.querySelector('#source').seeking"),'reference first frame');
 const map=await editor.evaluate("(()=>{const r=document.querySelector('#sourceCanvas').getBoundingClientRect(),s=Math.min(r.width/960,r.height/1440);return {x:r.x+(r.width-960*s)/2,y:r.y+(r.height-1440*s)/2,s}})()");
 for(const [x,y] of [[320,1370],[350,1370],[380,1370],[330,1400],[360,1400],[400,1400]])for(const type of ['mousePressed','mouseReleased'])await editor.call('Input.dispatchMouseEvent',{type,x:map.x+x*map.s,y:map.y+y*map.s,button:'left',clickCount:1});
 assert.match(await editor.evaluate("document.querySelector('#pointCount').textContent"),/^6 /);
 await editor.evaluate("window.s3fTimelineApply()");state=await read();assert.equal(state.plan.stabilization[0].reference.points.length,6);
 await click('fitSelection');assert.ok(Number(await editor.evaluate("document.querySelector('#pan').max"))>0);
 await field('selectionIn',0);await field('selectionOut',2);
 await click('processSelected');await until(()=>editor.evaluate("!document.querySelector('#cancel').hidden"),'processing starts');
 await until(()=>editor.evaluate("document.querySelector('#cancel').hidden&&!document.querySelector('#openStudio').hidden"),'selected GPU processing',2400);
 assert.equal(await editor.evaluate("document.querySelector('#error').textContent"),'');
 state=await read();assert.ok(state.project);assert.deepEqual(state.report.regions.filter(r=>r.state==='partial'||r.state==='complete').map(r=>r.id),['tracking_0']);
 const project=await(await fetch(`${base}/sam3d_funscript/projects/${state.project}`)).json();
 assert.deepEqual(Object.keys(project.scripts).sort(),['L0','L1','L2','R0','R1','R2']);assert.deepEqual(project.metadata.processing_timeline.coverage,[[0,2000]]);
 assert.ok(project.metadata.processing_timeline.stabilized_regions.length);assert.equal(project.metadata.source.path,state.info.source.path);
 const history=await(await fetch(base+'/history?max_items=1')).json(),job=Object.values(history)[0];assert.deepEqual(job.prompt[4],['2']);assert.ok(!job.outputs['3']);
 report.selected={project:state.project,regions:state.report.regions,jobs:state.report.jobs};report.checks.push('Selected region runs CoTracker and SAM3D through native partial queue, produces six axes on original clock');
 await click('openStudio');const studio=browserFrame(shell,'viewer.html');await until(()=>shell.evaluate("[...document.querySelectorAll('iframe')].some(frame=>frame.src.includes('viewer.html')&&frame.contentDocument?.readyState==='complete')"),'Motion Studio iframe');await until(()=>studio.evaluate("!!window.s3fFlush&&document.querySelector('#axis')?.options.length>0"),'Motion Studio ready');
 assert.equal((await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter(t=>t.url.includes('/assets/workspace.html')).length,1);
 report.checks.push('Timeline and Motion Studio share one top-level browser tab');
 await studio.evaluate("(async()=>{const input=document.querySelector('#referenceFile'),transfer=new DataTransfer();transfer.items.add(new File([JSON.stringify({actions:[{at:0,pos:20},{at:2000,pos:80}]})],'neutral-reference.funscript',{type:'application/json'}));input.files=transfer.files;input.dispatchEvent(new Event('change'));await new Promise(r=>setTimeout(r,300));await window.s3fFlush()})()");
 const beforeDraft=await(await fetch(`${base}/sam3d_funscript/editors/${state.editor_session}`)).json();assert.ok(beforeDraft.project.references.L0);assert.ok(!beforeDraft.project.timeline.main.L0.edited,'Reference comparison must not freeze a generated main');
 await click('processUnfinished');await until(()=>editor.evaluate("!document.querySelector('#cancel').hidden"),'unfinished starts');
 await until(()=>editor.evaluate("document.querySelector('#cancel').hidden"),'unfinished GPU processing',2400);
 assert.equal(await editor.evaluate("document.querySelector('#error').textContent"),'');state=await read();
 const complete=await(await fetch(`${base}/sam3d_funscript/projects/${state.project}`)).json();assert.deepEqual(complete.metadata.processing_timeline.coverage,[[0,5000],[5000,state.info.end_ms]]);
 assert.equal(complete.timeline.sources.length,4);report.checks.push('Process unfinished reuses completed region and assembles both anchors across the full video');
 assert.ok(state.editor_session,'Result must expose its persistent Motion Studio session');
 assert.equal(new URL(await editor.evaluate("document.querySelector('#openStudio').href")).searchParams.get('session'),state.editor_session);
 const ownerSession=await parent.evaluate("window.testApp.graph.getNodeById(3).properties.s3f_session");assert.equal(state.editor_session,ownerSession);
 const draft=await(await fetch(`${base}/sam3d_funscript/editors/${ownerSession}`)).json();assert.ok(draft.project);report.checks.push('Direct Motion Studio link shares the downstream editor session and its saved draft');
 assert.equal(draft.project.timeline.main.L0.regions.length,2);assert.ok(draft.project.references.L0);report.checks.push('Reference comparisons persist without preventing generated main curves from refreshing');
 await parent.evaluate("window.testApp.graph.getNodeById(2).widgets.find(w=>w.name==='sample_fps').value=0;window.testApp.graph.getNodeById(2).widgets.find(w=>w.name==='use_cache').value=false");
 await click('processAll');await until(()=>editor.evaluate("document.querySelector('#progressText').textContent.includes('poses')||document.querySelector('#progressText').textContent.includes('stabilization')"),'running job before cancel');
 await click('cancel');await until(()=>editor.evaluate("document.querySelector('#cancel').hidden"),'scoped cancellation',600);
 assert.match(await editor.evaluate("document.querySelector('#error').textContent"),/cancel/i);state=await read();assert.equal(state.progress.stage,'error');assert.equal(state.result_current,false);assert.ok(state.project);
 report.checks.push('Cancel uses the scoped native job endpoint, persists stopped state and retains completed results');
 await editor.activate();await click('fitAll');
 await editor.evaluate("document.querySelector('#sourceCanvas').style.visibility='hidden'");
 fs.writeFileSync(path.join(out,'editor.png'),Buffer.from((await editor.call('Page.captureScreenshot')).data,'base64'));
 await editor.call('Emulation.setDeviceMetricsOverride',{width:560,height:1000,deviceScaleFactor:1,mobile:false});await pause(250);assert.equal(await editor.evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
 const layout=await parent.evaluate("window.testApp.graph._nodes.map(n=>({id:n.id,type:n.type,pos:[...n.pos],size:[...n.size]}))");
 for(let i=0;i<layout.length;i++)for(let j=i+1;j<layout.length;j++){const a=layout[i],b=layout[j];assert.ok(a.pos[0]+a.size[0]<=b.pos[0]||b.pos[0]+b.size[0]<=a.pos[0]||a.pos[1]+a.size[1]<=b.pos[1]-30||b.pos[1]+b.size[1]<=a.pos[1]-30,`Overlapping nodes ${a.id}, ${b.id}`)}
 report.layout=layout;report.checks.push('Workflow renders without overlaps and editor fits narrow windows');
 // Adding a connected reference node extends the existing workspace.
 const refId=await parent.evaluate("(()=>{const ref=LiteGraph.createNode('S3F_ReferenceStabilize');window.testApp.graph.add(ref);window.testApp.graph.getNodeById(1).connect(0,ref,0);ref.connect(0,window.testApp.graph.getNodeById(2),0);return ref.id})()");
 await until(()=>shell.evaluate("document.querySelectorAll('[role=tab]').length===3"),'three connected tabs');
 await parent.evaluate(`window.testApp.graph.getNodeById(${JSON.stringify(refId)}).widgets.find(w=>w.name==='Open reference editor').callback()`);
 await until(()=>shell.evaluate("document.querySelector('[aria-selected=true]').textContent.includes('Reference')"),'reference tab focused');
 const preparationResult=await parent.evaluate(`(async()=>{const api=(await import('/scripts/api.js')).api;return api.queuePrompt(0,await window.testApp.graphToPrompt(),{partialExecutionTargets:[${JSON.stringify(String(refId))}]});})()`);
 assert.ok(preparationResult.prompt_id);
 await until(()=>shell.evaluate("[...document.querySelectorAll('iframe')].some(frame=>frame.src.includes('reference.html')&&frame.contentDocument?.readyState==='complete')"),'prepared reference tab');
 const reference=browserFrame(shell,'reference.html');
 await until(()=>reference.evaluate("document.querySelector('#source')?.readyState>=2"),'reference source ready');
 assert.equal((await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter(t=>t.url.includes('/assets/workspace.html')).length,1);
 await editor.activate();assert.equal(await editor.evaluate("document.querySelectorAll('#trackingLane .region-bar').length"),2);
 report.checks.push('Connecting Reference Stabilizer adds its editor tab in place, retaining Timeline and Motion Studio state');
 // A branch sharing only the source loader still gets a separate workspace.
 const separateId=await parent.evaluate("(()=>{const node=LiteGraph.createNode('S3F_ProcessingTimeline');window.testApp.graph.add(node);window.testApp.graph.getNodeById(1).connect(0,node,0);node.widgets.find(w=>w.name==='Open processing timeline').callback();return node.id})()");
 let separateTarget;await until(async()=>{separateTarget=(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t=>t.url.includes('/assets/workspace.html')&&t.id!==popup.id);return separateTarget},'separate workspace');
 const separateShell=await connect(separateTarget);await until(()=>separateShell.evaluate("document.querySelectorAll('[role=tab]').length===1"),'separate tool tab');
 assert.match(await separateShell.evaluate("document.querySelector('[role=tab]').textContent"),/Timeline/);
 report.checks.push('A separate branch sharing the video loader keeps a separate browser workspace');
 await parent.evaluate(`window.testApp.graph.getNodeById(${JSON.stringify(separateId)}).widgets.find(w=>w.name==='Open processing timeline').callback()`);
 assert.equal((await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter(t=>t.url.includes('/assets/workspace.html')).length,2);
 assert.equal(report.errors.length,0);fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}catch(error){fs.writeFileSync(path.join(out,'failure.json'),JSON.stringify({error:String(error),report,diagnostics},null,2));throw error}finally{
 connections.forEach(ws=>ws.close());chrome.kill('SIGTERM');await new Promise(r=>chrome.exitCode!==null?r():chrome.once('exit',r));fs.rmSync(profile,{recursive:true,force:true});
}
