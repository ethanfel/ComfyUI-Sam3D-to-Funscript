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
const chrome=spawn("/opt/google/chrome/chrome",["--headless","--no-sandbox","--disable-dev-shm-usage","--disable-gpu","--disable-popup-blocking","--no-first-run","--no-default-browser-check","--remote-debugging-port=0",`--user-data-dir=${profile}`,"about:blank"],{stdio:"ignore"});
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
    const evaluate=async expression=>{const r=await call("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true,userGesture:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
    const click=selector=>evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const select=(selector,value)=>evaluate(`document.querySelector(${JSON.stringify(selector)}).value=${JSON.stringify(value)};document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new Event('change'))`);
    const controls=()=>evaluate("({component:document.querySelector('#component').value,range:Number(document.querySelector('#range').value),center:Number(document.querySelector('#center').value),metrics:document.querySelector('#metrics').textContent,direction:document.querySelector('#directionInfo').textContent})");
    async function file(selector,file){const doc=await call("DOM.getDocument"),input=await call("DOM.querySelector",{nodeId:doc.root.nodeId,selector});await call("DOM.setFileInputFiles",{nodeId:input.nodeId,files:[path.resolve(file)]});}
    async function download(){const folder=fs.mkdtempSync(path.join(downloads,"export-"));await call("Browser.setDownloadBehavior",{behavior:"allow",downloadPath:folder});await click("#save");let name;await until(()=>{name=fs.readdirSync(folder).find(f=>f.endsWith(".zip"));return name;},"ZIP download");return unzip(path.join(folder,name));}
    const template=await(await fetch(`${base}/sam3d_funscript/projects/${id}`)).json();initializeTimeline(template);
    const session=crypto.randomUUID(),endpoint=`${base}/sam3d_funscript/editors/${session}`;
    const {sourceProject}=await import('../assets/timeline.mjs');
    const inputs=template.timeline.sources.slice(0,3).map((source,i)=>{
        const file=path.join(output,`input-${i}.json`);fs.writeFileSync(file,JSON.stringify(sourceProject(template,source.id)));return file;
    });
    const prompt=Object.fromEntries(inputs.map((file,i)=>[String(i+1),{class_type:'S3F_LoadProject',inputs:{project_path:file}}]));
    prompt['9']={class_type:'S3F_PreviewExport',inputs:{project_0:['1',0],project_1:['2',0],filename:'lock_test'}};
    async function queue(){
        const response=await fetch(`${base}/prompt`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt,extra_data:{extra_pnginfo:{workflow:{nodes:[{id:9,properties:{s3f_session:session}}]}}}})});
        assert.ok(response.ok,await response.clone().text());const queued=await response.json();let item;
        await until(async()=>{item=(await(await fetch(`${base}/history/${queued.prompt_id}`)).json())[queued.prompt_id];return item;},'Comfy execution');
        assert.equal(item.status.status_str,'success',JSON.stringify(item.status));
        const projectPath=item.outputs['9'].text[0];return JSON.parse(fs.readFileSync(projectPath,'utf8'));
    }
    await queue();
    let state=await(await fetch(endpoint)).json();assert.equal(state.revision,1);
    await call('Runtime.enable');await call('Page.enable');
    await call('Emulation.setDeviceMetricsOverride',{width:1500,height:1260,deviceScaleFactor:1,mobile:false});
    const url=`${base}/sam3d_funscript/assets/viewer.html?project=${state.output}&session=${session}`;
    await call('Page.navigate',{url});
    await until(()=>evaluate("document.querySelectorAll('#tracks .track').length===2"),'session load');
    const lane=n=>`#tracks .track:nth-child(${n+1})`;
    await click(`${lane(0)} .track-select`);await click('#invert');await click(`${lane(0)} .track-lock`);
    await evaluate('window.s3fFlush()');
    await click('#selectMain');await click('#invert');await click('#lockMain');await evaluate('window.s3fFlush()');
    state=await(await fetch(endpoint)).json();const protectedProject=structuredClone(state.project);
    assert.equal(state.project.timeline.tracks[0].locked,true);assert.equal(state.project.timeline.main.L0.locked,true);
    assert.equal(await evaluate("document.querySelector('#undo').disabled"),true,'Undo cannot reach behind the lock');
    for(const selector of ['#invert','#autoFit','#rebuild'])assert.equal(await evaluate(`document.querySelector('${selector}').disabled`),true);
    await click(`${lane(0)} .track-select`);
    for(const selector of ['.track-source','.track-axis','.track-name','.remove-track'])assert.equal(await evaluate(`document.querySelector('${lane(0)} ${selector}').disabled`),true);
    assert.equal(await evaluate("document.querySelector('#promoteTrack').disabled"),true,'Locked main rejects section replacement');
    // Editing events on a locked canvas may seek, but must never move/add/delete actions.
    await evaluate(`(()=>{const canvas=document.querySelector('${lane(0)} canvas'),r=canvas.getBoundingClientRect();for(const type of ['pointerdown','pointermove','dblclick','contextmenu','pointerup'])canvas.dispatchEvent(new MouseEvent(type,{button:0,clientX:r.left+110,clientY:r.top+40,bubbles:true}));})()`);
    await evaluate('window.s3fFlush()');state=await(await fetch(endpoint)).json();
    assert.deepEqual(state.project.timeline.tracks[0],protectedProject.timeline.tracks[0]);
    const changed=JSON.parse(fs.readFileSync(inputs[0]));changed.scripts.L0.actions=changed.scripts.L0.actions.map(a=>({...a,pos:1}));changed.points[0][0][0][0]+=.4;
    fs.writeFileSync(inputs[0],JSON.stringify(changed));prompt['9'].inputs.project_2=['3',0];
    let rerun=await queue();
    assert.deepEqual(rerun.scripts.L0,protectedProject.scripts.L0);
    assert.deepEqual(rerun.timeline.tracks[0],protectedProject.timeline.tracks[0]);
    assert.deepEqual(rerun.timeline.main.L0,protectedProject.timeline.main.L0);
    assert.deepEqual(rerun.points,protectedProject.points);assert.equal(rerun.timeline.tracks.length,3);
    await evaluate('window.s3fUpdate()');
    await until(()=>evaluate("document.querySelectorAll('#tracks .track').length===3"),'live new input');
    const firstRerun=structuredClone(rerun);rerun=await queue();assert.deepEqual(rerun,firstRerun,'Identical rerun preserves locks without duplicates');
    await call('Page.reload');await until(()=>evaluate("document.querySelector('#lockMain')?.textContent==='Unlock'"),'reload locked main');
    await until(()=>evaluate("document.querySelectorAll('#tracks .track').length===3"),'reload source tracks');
    await click(`${lane(0)} .track-select`);assert.equal(await evaluate("document.querySelector('#invert').disabled"),true);
    const exported=await download(),saved=JSON.parse(exported['project.json']);
    assert.deepEqual(saved.scripts.L0,protectedProject.scripts.L0);assert.deepEqual(saved.timeline.tracks[0],protectedProject.timeline.tracks[0]);
    // A stale full-editor save must fail, never replace the lock.
    const stale=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:state.revision,project:protectedProject})});assert.equal(stale.status,409);
    await click('#lockMain');await evaluate('window.s3fFlush()');
    assert.equal(await evaluate("document.querySelector('#promoteTrack').disabled"),false,'A locked source can be copied to an unlocked main');
    await click('#promoteTrack');await evaluate('window.s3fFlush()');
    assert.deepEqual((await(await fetch(endpoint)).json()).project.scripts.L0,protectedProject.timeline.tracks[0].script);
    await evaluate("document.querySelector('#video').style.visibility='hidden';document.querySelector('.curves').scrollIntoView({block:'start'})");
    fs.writeFileSync(output+'/locks.png',Buffer.from((await call('Page.captureScreenshot')).data,'base64'));
    const offline=output+'/viewer.html';fs.writeFileSync(offline,exported['viewer.html']);
    await call('Page.navigate',{url:pathToFileURL(offline).href});
    await until(()=>evaluate("document.querySelectorAll('#tracks .track').length===3"),'offline locks');
    assert.equal(await evaluate("document.querySelector('#lockMain').textContent"),'Unlock');
    await click(`${lane(0)} .track-select`);assert.equal(await evaluate("document.querySelector('#autoFit').disabled"),true);
    const again=JSON.parse((await download())['project.json']);assert.deepEqual(again.timeline,saved.timeline);assert.deepEqual(again.scripts,saved.scripts);
    // Exercise the real Comfy queue hook, embedded preview and full editor together.
    await call('Page.navigate',{url:base});
    await until(()=>evaluate("!!document.querySelector('canvas')"),'Comfy canvas');
    await evaluate("(async()=>{window.s3fTestApp=(await import('/scripts/app.js')).app})()");
    await until(()=>evaluate('!!window.s3fTestApp?.graph'),'Comfy app');
    const workflow=JSON.parse(fs.readFileSync('development/timeline-workflow.json','utf8'));
    const workflowSession=crypto.randomUUID();workflow.nodes.find(n=>n.id===5).properties.s3f_session=workflowSession;
    await evaluate(`window.s3fTestApp.loadGraphData(${JSON.stringify(workflow)})`);
    await until(()=>evaluate("document.querySelector('iframe[title=\"SAM3D motion preview\"]')?.contentDocument?.querySelectorAll('#tracks .track').length===3"),'embedded session');
    await evaluate("window.s3fFrame=window.s3fTestApp.graph.getNodeById(5).s3fFrame;window.s3fFrame.contentWindow.s3fFlush()");
    const workflowEndpoint=`${base}/sam3d_funscript/editors/${workflowSession}`;
    const beforeFull=(await(await fetch(workflowEndpoint)).json()).project;
    await evaluate("(()=>{const original=window.open;window.open=(...args)=>(window.s3fFull=original(...args));window.s3fTestApp.graph.getNodeById(5).widgets.find(w=>w.name==='Open full motion editor').callback();window.open=original;})()");
    try{await until(()=>evaluate("window.s3fFull?.document.querySelectorAll('#tracks .track').length===3"),'full editor');}catch(error){console.log(await evaluate("({exists:!!window.s3fFull,href:window.s3fFull?.location.href,status:window.s3fFull?.document.querySelector('#status')?.textContent})"));throw error;}
    await evaluate("window.s3fFull.document.querySelector('#selectMain').click();window.s3fFull.document.querySelector('#invert').click();window.s3fFull.document.querySelector('#lockMain').click()");
    // Add another connected project, then immediately queue without waiting for autosave.
    await evaluate("(()=>{const node=window.s3fTestApp.graph.getNodeById(5);window.s3fTestApp.graph.getNodeById(2).connect(0,node,node.inputs.findIndex(i=>i.name==='project_3'))})()");
    const oldOutput=await evaluate('window.s3fTestApp.graph.getNodeById(5).properties.s3f_project');
    await evaluate('window.s3fTestApp.queuePrompt(0,1)');
    await until(()=>evaluate(`window.s3fTestApp.graph.getNodeById(5).properties.s3f_project!==${JSON.stringify(oldOutput)}`),'real UI queue execution');
    await until(()=>evaluate("window.s3fFrame.contentDocument.querySelectorAll('#tracks .track').length===4&&window.s3fFull.document.querySelectorAll('#tracks .track').length===4"),'both editor views receive appended input');
    const afterFull=(await(await fetch(workflowEndpoint)).json()).project;
    assert.equal(afterFull.timeline.main.L0.locked,true);
    assert.deepEqual(afterFull.scripts.L0.actions,beforeFull.scripts.L0.actions.map(a=>({...a,pos:100-a.pos})));
    assert.equal(await evaluate("window.s3fFrame.contentDocument.querySelector('#lockMain').textContent"),'Unlock');
    assert.equal(await evaluate("window.s3fFull.document.querySelector('#lockMain').textContent"),'Unlock');
    const generatedId=await evaluate('window.s3fTestApp.graph.getNodeById(5).properties.s3f_project');
    const generated=await(await fetch(`${base}/sam3d_funscript/projects/${generatedId}`)).json();
    assert.deepEqual(generated.scripts.L0,afterFull.scripts.L0);
    await evaluate('window.s3fFull.close()');
    report.checks.push('Full-editor edits flush before the actual Comfy queue; both open views receive new tracks and preserve the locked main in the generated export');
    assert.deepEqual(report.errors,[]);
    report.checks.push('Locked main and source block UI edits, survive modified upstream poses, new input, identical rerun, page reload and offline export; stale saves are rejected; explicitly unlocked main accepts a locked source');
    fs.writeFileSync(output+'/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{ws?.close();chrome.kill('SIGTERM');}
