// Real cached hand clip: selection-local calibration, composition and offline roundtrip.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {spawn} from "node:child_process";
import {evaluate as valueAt} from "../assets/curve.mjs";
import {initializeTimeline,fitSelectionTrack,trackCoverage,applyTrack} from "../assets/timeline.mjs";

const base=process.argv[2],oldPath=process.argv[3],newPath=process.argv[4],output=path.resolve(process.argv[5]||"development/video-switch-browser");
assert.ok(base&&oldPath&&newPath,"Pass base URL, old project JSON and new project JSON");fs.mkdirSync(output,{recursive:true});
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
    const session=crypto.randomUUID(),endpoint=`${base}/sam3d_funscript/editors/${session}`;
    const oldProject=JSON.parse(fs.readFileSync(oldPath)),newProject=JSON.parse(fs.readFileSync(newPath));
    assert.notEqual(oldProject.metadata.source.path,newProject.metadata.source.path);
    async function queue(projectPath){
        const prompt={'1':{class_type:'S3F_LoadProject',inputs:{project_path:path.resolve(projectPath)}},'9':{class_type:'S3F_PreviewExport',inputs:{project_0:['1',0],filename:'video_switch'}}};
        const response=await fetch(`${base}/prompt`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt,extra_data:{extra_pnginfo:{workflow:{nodes:[{id:9,properties:{s3f_session:session}}]}}}})});
        assert.ok(response.ok,await response.clone().text());const queued=await response.json();let item;
        await until(async()=>{item=(await(await fetch(`${base}/history/${queued.prompt_id}`)).json())[queued.prompt_id];return item;},'Comfy execution');
        assert.equal(item.status.status_str,'success',JSON.stringify(item.status));return (await(await fetch(endpoint)).json());
    }
    let state=await queue(oldPath);
    await call('Runtime.enable');await call('Page.enable');
    const url=`${base}/sam3d_funscript/assets/viewer.html?project=${state.output}&session=${session}`;
    await call('Page.navigate',{url});await until(()=>evaluate("document.querySelector('#video')?.readyState>=2"),'old video load');
    await evaluate(`void(window.peer=window.open(${JSON.stringify(url)},'_blank'))`);
    await until(()=>evaluate("window.peer?.document.querySelector('#video')?.readyState>=2"),'full editor');
    const player=()=>evaluate("({src:document.querySelector('#video').src,time:document.querySelector('#video').currentTime,duration:document.querySelector('#video').duration,start:Number(document.querySelector('#viewRange').dataset.start),end:Number(document.querySelector('#viewRange').dataset.end),name:document.querySelector('#name').textContent})");
    async function refresh(){await evaluate('Promise.all([window.s3fUpdate(),window.peer.s3fUpdate()])');}
    await select('#zoom','1000');await evaluate("document.querySelector('#video').currentTime=4");await until(async()=>{const v=await player();return Math.abs(v.time-4)<.1&&v.start<=4000&&v.end>4000&&!await evaluate("document.querySelector('#video').seeking");},'old seek');
    const before=await player();state=await queue(oldPath);await refresh();await pause(200);
    assert.deepEqual(await player(),before,'Same-video reruns retain the loaded player, playhead and zoom');
    // A local video override must also be released when the source project changes.
    await call('Page.bringToFront');
    await file('#videoFile',oldProject.metadata.source.path);await until(async()=>(await player()).src.startsWith('blob:'),'local video');
    try{await until(()=>evaluate("document.querySelector('#video').readyState>=2"),'local decode');}catch(error){console.log(await evaluate("({visible:document.visibilityState,ready:document.querySelector('#video').readyState,error:document.querySelector('#video').error?.message,network:document.querySelector('#video').networkState})"));throw error;}await evaluate("document.querySelector('#video').currentTime=4");
    const local=await player();assert.ok(local.src.startsWith('blob:'));
    state=await queue(newPath);await refresh();
    await until(async()=>{const v=await player();return v.src.endsWith(state.output)&&Math.abs(v.duration-newProject.metadata.duration_ms/1000)<.25;},'new video decoded');
    const after=await player();assert.equal(after.name,path.basename(newProject.metadata.source.path));assert.ok(after.time<.1);
    assert.ok(Math.abs(after.end-after.start-newProject.metadata.duration_ms)<1);
    assert.ok(Math.abs(after.duration-before.duration)>1,'Different real clips expose a stale media element');
    const peerTarget=(await call('Target.getTargets')).targetInfos.find(t=>t.type==='page'&&t.targetId!==target.id&&t.url===url);
    if(peerTarget)await call('Target.activateTarget',{targetId:peerTarget.targetId});
    await until(()=>evaluate(`window.peer.document.querySelector('#video').src.endsWith(${JSON.stringify(state.output)})&&window.peer.document.querySelector('#video').readyState>=2`),'full editor new video');
    assert.ok(Math.abs(await evaluate("window.peer.document.querySelector('#video').duration")-after.duration)<.1);
    await call('Page.bringToFront');
    assert.equal(state.project.metadata.source.path,newProject.metadata.source.path);
    assert.deepEqual(state.project.points,newProject.points);
    assert.ok(state.project.timeline.sources.every(s=>s.data.metadata.source.path===newProject.metadata.source.path));
    await evaluate('window.reloadMarker=true');await call('Page.reload');await until(()=>evaluate("!window.reloadMarker&&document.querySelector('#video')?.readyState>=2"),'reload new video');assert.equal((await player()).src,after.src);
    // Replace a test-owned file at the same path; its changed fingerprint must reload playback.
    const replacement=path.join(output,'replacement.mp4');
    function rewritten(project,sourceFile,name){
        fs.copyFileSync(sourceFile,replacement);const stat=fs.statSync(replacement,{bigint:true});
        const source={path:replacement,size:Number(stat.size),mtime_ns:Number(stat.mtimeNs)},data=structuredClone(project);
        data.metadata.source=source;for(const s of data.timeline?.sources||[])s.data.metadata.source=source;
        const file=path.join(output,name+'.json');fs.writeFileSync(file,JSON.stringify(data));return file;
    }
    state=await queue(rewritten(oldProject,oldProject.metadata.source.path,'same-path-before'));await evaluate('window.s3fUpdate()');
    await until(async()=>Math.abs((await player()).duration-before.duration)<.1,'replacement old decode');
    await evaluate("document.querySelector('#video').currentTime=4");
    const oldReplacement=await player();
    state=await queue(rewritten(newProject,newProject.metadata.source.path,'same-path-after'));await evaluate('window.s3fUpdate()');
    await until(async()=>{const v=await player();return v.src.endsWith(state.output)&&Math.abs(v.duration-after.duration)<.1;},'replacement new decode');
    assert.ok((await player()).time<.1);assert.notEqual((await player()).src,oldReplacement.src);
    const exported=JSON.parse((await download())['project.json']);assert.deepEqual(exported.scripts,state.project.scripts);assert.deepEqual(exported.points,state.project.points);
    assert.deepEqual(report.errors,[]);report.checks.push('Real 13.6 s to 16.7 s clip switch reloads both player views, resets time/zoom and releases local video override; same-source rerun preserves playback; replaced file at the same path reloads; project poses and exports match the new video');
    fs.writeFileSync(output+'/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{ws?.close();chrome.kill('SIGTERM');}
