// Source revisions: changed inputs follow unlocked rows across queue, reload and export.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {spawn} from "node:child_process";
import {evaluate as valueAt} from "../assets/curve.mjs";
import {initializeTimeline,sourceProject} from "../assets/timeline.mjs";

const base=process.argv[2],id=process.argv[3],output=path.resolve(process.argv[4]||"development/source-refresh");
assert.ok(base&&id,"Pass base URL and an existing project ID");fs.mkdirSync(output,{recursive:true});
const downloads=fs.mkdtempSync(path.join(output,"downloads-")),profile=fs.mkdtempSync(path.join(os.tmpdir(),"s3f-refresh-chrome-"));
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
    const input0=path.join(output,'input-0.json'),input1=path.join(output,'input-1.json');
    const initial=sourceProject(template,template.timeline.sources[0].id),anchorInput=sourceProject(template,template.timeline.sources[1].id);
    fs.writeFileSync(input0,JSON.stringify(initial));fs.writeFileSync(input1,JSON.stringify(anchorInput));
    const prompt={1:{class_type:'S3F_LoadProject',inputs:{project_path:input0}},2:{class_type:'S3F_LoadProject',inputs:{project_path:input1}},
        9:{class_type:'S3F_PreviewExport',inputs:{project_0:['1',0],filename:'source_refresh'}}};
    async function queue(){
        const response=await fetch(`${base}/prompt`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt,extra_data:{extra_pnginfo:{workflow:{nodes:[{id:9,properties:{s3f_session:session}}]}}}})});
        assert.ok(response.ok,await response.clone().text());const queued=await response.json();let item;
        await until(async()=>{item=(await(await fetch(`${base}/history/${queued.prompt_id}`)).json())[queued.prompt_id];return item;},'Comfy execution');
        assert.equal(item.status.status_str,'success',JSON.stringify(item.status));
        return JSON.parse(fs.readFileSync(item.outputs['9'].text[0],'utf8'));
    }
    await queue();const state=await(await fetch(endpoint)).json();
    await call('Runtime.enable');await call('Page.enable');
    await call('Emulation.setDeviceMetricsOverride',{width:1500,height:1260,deviceScaleFactor:1,mobile:false});
    await call('Page.navigate',{url:`${base}/sam3d_funscript/assets/viewer.html?project=${state.output}&session=${session}`});
    await until(()=>evaluate("document.querySelectorAll('#tracks .track').length===1"),'session load');
    const lane=n=>`#tracks .track:nth-child(${n+1})`;
    await click(`${lane(0)} .track-select`);await click('#invert');
    await click('#selectMain');await click('#invert');await evaluate('window.s3fFlush()');
    const authored=(await(await fetch(endpoint)).json()).project;
    prompt[9].inputs.project_1=['2',0];let result=await queue();
    assert.deepEqual(result.timeline.tracks[0],authored.timeline.tracks[0]);assert.deepEqual(result.scripts,authored.scripts,'Appending another input preserves unchanged-input edits');
    await evaluate('window.s3fUpdate()');await until(()=>evaluate("document.querySelectorAll('#tracks .track').length===2"),'appended anchor');
    // Lock one source; leave edited source and main unlocked.
    await click(`${lane(1)} .track-select`);await click(`${lane(1)} .track-lock`);await evaluate('window.s3fFlush()');
    const locked=(await(await fetch(endpoint)).json()).project.timeline.tracks[1];
    const changed=structuredClone(anchorInput);changed.scripts.L0.actions=changed.scripts.L0.actions.map(a=>({...a,pos:20}));
    const changedOther=structuredClone(anchorInput);changedOther.scripts.L0.actions=changedOther.scripts.L0.actions.map(a=>({...a,pos:80}));
    fs.writeFileSync(input0,JSON.stringify(changed));fs.writeFileSync(input1,JSON.stringify(changedOther));
    result=await queue();assert.deepEqual(result.timeline.tracks[0].script,changed.scripts.L0);assert.deepEqual(result.scripts.L0,changed.scripts.L0);
    assert.deepEqual(result.timeline.tracks[1],locked);assert.equal(result.timeline.sources.length,3,'Only a used locked version remains alongside latest inputs');
    assert.match(result.timeline.tracks[0].name,/left hand/);
    await evaluate('window.s3fUpdate()');await click(`${lane(0)} .track-select`);
    await until(()=>evaluate(`document.querySelector('${lane(0)} .track-source').selectedOptions[0].textContent.includes('left hand')`),'new source and name');
    let groups=await evaluate(`Array.from(document.querySelector('${lane(0)} .track-source').children,g=>({label:g.label,options:Array.from(g.children,o=>o.textContent)}))`);
    assert.equal(groups.length,2);assert.equal(groups[0].label,'Latest inputs');assert.equal(groups[0].options.length,2);
    assert.equal(groups[1].options.length,1);assert.match(groups[1].options[0],/saved/);
    const snapshot=structuredClone(result);result=await queue();assert.deepEqual(result,snapshot,'Identical rerun creates no duplicate revisions');
    await evaluate('window.beforeRefresh=true');await call('Page.reload');await until(()=>evaluate("!window.beforeRefresh&&document.querySelectorAll('#tracks .track').length===2"),'browser restart');
    await click(`${lane(0)} .track-select`);
    assert.equal(await evaluate(`document.querySelector('${lane(0)} .track-source').value`),snapshot.timeline.latest.project_0);
    await evaluate("document.querySelector('#video').style.visibility='hidden';document.querySelector('.curves').scrollIntoView({block:'start'})");
    fs.writeFileSync(output+'/source-refresh.png',Buffer.from((await call('Page.captureScreenshot')).data,'base64'));
    const files=await download(),offline=path.join(output,'viewer.html');fs.writeFileSync(offline,files['viewer.html']);
    await call('Page.navigate',{url:pathToFileURL(offline).href});await until(()=>evaluate("document.querySelectorAll('#tracks .track').length===2"),'offline source history');
    const saved=JSON.parse((await download())['project.json']);assert.deepEqual(saved.timeline.latest,snapshot.timeline.latest);
    assert.deepEqual(saved.timeline.tracks,snapshot.timeline.tracks);assert.deepEqual(saved.scripts,snapshot.scripts);
    groups=await evaluate(`Array.from(document.querySelector('${lane(0)} .track-source').children,g=>({label:g.label,options:Array.from(g.children,o=>o.textContent)}))`);
    assert.equal(groups[0].options.length,2);assert.equal(groups[1].options.length,1);
    report.checks.push('Appending an anchor preserves edits; changed inputs replace unlocked edited source/main and update names; locked rows retain exact versions; latest/history labels survive identical reruns, reload and offline export');
    assert.deepEqual(report.errors,[]);fs.writeFileSync(output+'/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{ws?.close();chrome.kill('SIGTERM');}
