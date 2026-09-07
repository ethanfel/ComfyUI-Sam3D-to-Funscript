// End-to-end multi-track timeline, offline export and dynamic Comfy inputs.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {spawn} from "node:child_process";
import {SUFFIX, evaluate as valueAt} from "../assets/curve.mjs";
import {initializeTimeline,applyTrack} from "../assets/timeline.mjs";

const base=process.argv[2],id=process.argv[3],output=path.resolve(process.argv[4]||"development/timeline-browser");
assert.ok(base&&id,"Pass base URL and an existing project ID");fs.mkdirSync(output,{recursive:true});
const downloads=fs.mkdtempSync(path.join(output,"downloads-")),profile=fs.mkdtempSync(path.join(os.tmpdir(),"s3f-timeline-chrome-"));
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
    async function file(selector,file){const doc=await call("DOM.getDocument"),input=await call("DOM.querySelector",{nodeId:doc.root.nodeId,selector});await call("DOM.setFileInputFiles",{nodeId:input.nodeId,files:[path.resolve(file)]});}
    async function download(){const folder=fs.mkdtempSync(path.join(downloads,"export-"));await call("Browser.setDownloadBehavior",{behavior:"allow",downloadPath:folder});await click("#save");let name;await until(()=>{name=fs.readdirSync(folder).find(f=>f.endsWith(".zip"));return name;},"ZIP download");return unzip(path.join(folder,name));}
    const original=await(await fetch(`${base}/sam3d_funscript/projects/${id}`)).json();
    initializeTimeline(original);
    await call("Runtime.enable");await call("Page.enable");await call("Network.enable");
    await call("Emulation.setDeviceMetricsOverride",{width:1550,height:1280,deviceScaleFactor:1,mobile:false});
    await call("Page.navigate",{url:`${base}/sam3d_funscript/assets/viewer.html?project=${id}`});
    await until(()=>evaluate("document.querySelector('#video')?.readyState>=2"),"project/video load");
    assert.equal(await evaluate("document.querySelectorAll('#tracks .track').length"),3);
    const rulers=await evaluate("[document.querySelector('#curve'),...document.querySelectorAll('#tracks canvas')].map(c=>{const r=c.getBoundingClientRect();return {left:r.left,width:r.width}})");
    assert.ok(rulers.every(r=>Math.abs(r.left-rulers[0].left)<1&&Math.abs(r.width-rulers[0].width)<1),"Every track ruler must align with main");
    const lane=n=>`#tracks .track:nth-child(${n+1})`;
    await evaluate("(()=>{const ctx=document.querySelector('#overlay').getContext('2d'),draw=ctx.fillText;ctx.fillText=function(text,...args){if(text.startsWith('Target:'))window.trackTarget=text;return draw.call(this,text,...args);};})()");
    await click(`${lane(1)} .track-select`);assert.equal(await evaluate("window.trackTarget"),"Target: left hand");
    await click("#invert");
    let saved=JSON.parse((await download())["project.json"]);
    assert.deepEqual(saved.scripts,original.scripts,"Editing a source must not change main");
    assert.deepEqual(saved.timeline.tracks[1].script.actions,original.timeline.tracks[1].script.actions.map(a=>({...a,pos:100-a.pos})));
    assert.deepEqual(saved.timeline.sources,original.timeline.sources,"Source project snapshots remain unchanged");
    await select("#component","1");await select("#range","0.14");await click("#rebuild");
    await click("#autoFit");saved=JSON.parse((await download())["project.json"]);
    assert.equal(saved.timeline.tracks[1].settings.component,"auto");
    assert.equal(saved.timeline.tracks[1].settings.invert,true);
    assert.deepEqual(saved.scripts,original.scripts);
    report.checks.push("Three anchor rows load; selecting a track changes the pose overlay; Invert, manual calibration and Auto fit change only that source track");
    async function mouse(type,x,y,options={}){return call("Input.dispatchMouseEvent",{type,x,y,...options});}
    async function coordinates(selector,time,pos){
        await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`);
        return evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.left+42+${time}/${original.metadata.duration_ms}*(r.width-54),y:r.top+r.height-25-${pos}/100*(r.height-40)}})()`);
    }
    const canvas=`${lane(1)} canvas`,a=await coordinates(canvas,1100,50),b=await coordinates(canvas,2500,50);
    await mouse("mousePressed",a.x,a.y,{button:"left",buttons:1,clickCount:1,modifiers:8});
    await mouse("mouseMoved",b.x,b.y,{button:"left",buttons:1,modifiers:8});
    await mouse("mouseReleased",b.x,b.y,{button:"left",buttons:0,clickCount:1,modifiers:8});
    const selection=await evaluate("[Number(document.querySelector('#selectionStart').value)*1000,Number(document.querySelector('#selectionEnd').value)*1000]");
    assert.ok(Math.abs(selection[0]-1100)<=1&&Math.abs(selection[1]-2500)<=1);
    await click("#applySection");
    const expected=structuredClone(saved);applyTrack(expected,expected.timeline.tracks[1],"L0",{start:selection[0],end:selection[1],blendMs:200});
    saved=JSON.parse((await download())["project.json"]);assert.deepEqual(saved.scripts,expected.scripts);
    await click("#selectMain");assert.equal(await evaluate("document.querySelector('#autoFit').disabled"),true);
    assert.equal(await evaluate("document.querySelector('#rebuild').disabled"),true);
    await click("#invert");let mirror=JSON.parse((await download())["project.json"]);
    assert.deepEqual(mirror.scripts.L0.actions,saved.scripts.L0.actions.map(a=>({...a,pos:100-a.pos})));
    await click("#undo");assert.deepEqual(JSON.parse((await download())["project.json"]).scripts,saved.scripts);
    // Manual point adjustment remains available on the assembled main.
    const point=saved.scripts.L0.actions.find(a=>a.at>1300&&a.at<1600),p=await coordinates("#curve",point.at,point.pos);
    await mouse("mousePressed",p.x,p.y,{button:"left",buttons:1,clickCount:1});
    await mouse("mouseMoved",p.x,p.y+12,{button:"left",buttons:1});
    await mouse("mouseReleased",p.x,p.y+12,{button:"left",buttons:0,clickCount:1});
    assert.notDeepEqual(JSON.parse((await download())["project.json"]).scripts.L0,saved.scripts.L0);
    await click("#undo");assert.deepEqual(JSON.parse((await download())["project.json"]).scripts,saved.scripts);
    report.checks.push("Shift-drag selects synchronized time ranges; blended insertion matches the splice algorithm; assembled main supports exact inversion, manual point joins and Undo");
    await click(`${lane(2)} .track-select`);
    await select(`${lane(2)} .track-source`,"project_0");await select(`${lane(2)} .track-axis`,"L2");
    const reassigned=JSON.parse((await download())["project.json"]);
    assert.equal(reassigned.timeline.tracks[2].source,"project_0");assert.equal(reassigned.timeline.tracks[2].axis,"L2");
    assert.deepEqual(reassigned.scripts,saved.scripts);
    assert.deepEqual(reassigned.timeline.tracks[2].script,original.timeline.sources[0].data.scripts.L2);
    await select(`${lane(2)} .track-source`,"project_2");await select(`${lane(2)} .track-axis`,"L0");
    await select("#selectionStart","3.1");await select("#selectionEnd","4.2");await select("#join","cut");await click("#applySection");
    const withCut=JSON.parse((await download())["project.json"]);
    applyTrack(expected,expected.timeline.tracks[2],"L0",{start:3100,end:4200,method:"cut"});
    assert.deepEqual(withCut.scripts,expected.scripts);
    await click(`${lane(0)} .track-select`);await click("#promoteTrack");
    assert.deepEqual(JSON.parse((await download())["project.json"]).scripts.L0,original.timeline.tracks[0].script);
    await click("#undo");assert.deepEqual(JSON.parse((await download())["project.json"]).scripts,withCut.scripts);
    await click("#addTrack");assert.equal(await evaluate("document.querySelectorAll('#tracks .track').length"),4);
    await select(`${lane(3)} .track-name`,"Alternate calibration");
    await click(`${lane(1)} .remove-track`);assert.equal(await evaluate("document.querySelectorAll('#tracks .track').length"),3);
    await click("#undo");assert.equal(await evaluate("document.querySelectorAll('#tracks .track').length"),4);
    assert.equal(await evaluate(`document.querySelector('${lane(3)} .track-name').value`),"Alternate calibration");
    report.checks.push("Project and source axis can be reassigned per row; cuts, whole-track promotion, added tracks, names, removal and Undo retain the authored main");
    await click("#selectMain");
    await evaluate("document.querySelector('#video').currentTime=1.5;document.querySelector('#video').muted=true;document.querySelector('#video').play()");
    await until(()=>evaluate("document.querySelector('#video').currentTime>1.9"),"timeline playback");
    await evaluate("document.querySelector('#video').pause();document.querySelector('#video').style.visibility='hidden'");
    const readout=await evaluate("({time:parseFloat(document.querySelector('#time').textContent)*1000,value:parseFloat(document.querySelector('#readouts [data-axis=L0]').textContent.slice(3))})");
    assert.ok(Math.abs(readout.value-valueAt(withCut.scripts.L0.actions,readout.time))<.2,"Device readout follows the composed main at the video playhead");
    const exported=await download(),snapshot=JSON.parse(exported["project.json"]);
    assert.deepEqual(snapshot.scripts,withCut.scripts);
    for(const [axis,script]of Object.entries(snapshot.scripts))assert.deepEqual(JSON.parse(exported["blowjob-side_2"+SUFFIX[axis]+".funscript"]),script);
    await evaluate("window.scrollTo(0,450)");await pause(100);
    fs.writeFileSync(output+"/timeline.png",Buffer.from((await call("Page.captureScreenshot")).data,"base64"));
    await call("Emulation.setDeviceMetricsOverride",{width:560,height:1100,deviceScaleFactor:1,mobile:false});await pause(100);
    assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth"),true,"No horizontal page overflow");
    const offline=output+"/viewer.html";fs.writeFileSync(offline,exported["viewer.html"]);
    await call("Network.emulateNetworkConditions",{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0});
    await call("Page.navigate",{url:pathToFileURL(offline).href});
    await until(()=>evaluate("document.querySelectorAll('#tracks .track').length===4"),"offline tracks");
    await file("#videoFile",original.metadata.source.path);await until(()=>evaluate("document.querySelector('#video').readyState>=2"),"offline video");
    assert.deepEqual(JSON.parse((await download())["project.json"]).scripts,snapshot.scripts);
    const again=JSON.parse((await download())["project.json"]);assert.deepEqual(again.timeline,snapshot.timeline);
    await click(`${lane(1)} .track-select`);await click("#invert");
    assert.deepEqual(JSON.parse((await download())["project.json"]).scripts,snapshot.scripts);
    await click("#undo");await click("#selectMain");
    fs.writeFileSync(output+"/project.json",JSON.stringify(snapshot));await file("#projectFile",output+"/project.json");
    await until(()=>evaluate("document.querySelector('#undo').disabled"),"project import");
    const imported=JSON.parse((await download())["project.json"]);assert.deepEqual(imported.timeline,snapshot.timeline);assert.deepEqual(imported.scripts,snapshot.scripts);
    report.checks.push("Video playback follows main, all six exports match main exactly, responsive layout fits, and tracks/assignments/joins roundtrip offline without networking");
    assert.deepEqual(report.errors,[]);
    if(process.argv[5]){
        await call("Network.emulateNetworkConditions",{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});
        await call("Emulation.setDeviceMetricsOverride",{width:1550,height:1100,deviceScaleFactor:1,mobile:false});
        await call("Page.navigate",{url:base});
        await until(()=>evaluate("!!document.querySelector('canvas')"),"Comfy canvas");
        await evaluate("(async()=>{window.s3fTestApp=(await import('/scripts/app.js')).app})()");
        await until(()=>evaluate("!!window.s3fTestApp?.graph"),"Comfy app");
        const workflow=JSON.parse(fs.readFileSync(process.argv[5],"utf8"));
        await evaluate(`window.s3fTestApp.loadGraphData(${JSON.stringify(workflow)})`);
        await until(()=>evaluate("document.querySelector('iframe[title=\"SAM3D motion preview\"]')?.contentDocument?.querySelectorAll('#tracks .track').length===3"),"embedded tracks");
        const inputs=()=>evaluate("window.s3fTestApp.graph.getNodeById(5).inputs.filter(i=>/^project_/.test(i.name)).map(i=>({name:i.name,link:i.link}))");
        assert.deepEqual((await inputs()).map(i=>i.name),["project_0","project_1","project_2","project_3"]);
        const initialPrompt=(await evaluate("window.s3fTestApp.graphToPrompt()")).output;
        for(let n=0;n<3;n++)assert.deepEqual(initialPrompt["5"].inputs[`project_${n}`],[String(n+2),0]);
        await evaluate("(()=>{const node=window.s3fTestApp.graph.getNodeById(5);window.s3fTestApp.graph.getNodeById(2).connect(0,node,node.inputs.findIndex(i=>i.name==='project_3'))})()");
        assert.equal((await inputs()).at(-1).name,"project_4");
        await evaluate("(()=>{const node=window.s3fTestApp.graph.getNodeById(5);node.disconnectInput(node.inputs.findIndex(i=>i.name==='project_1'))})()");
        let prompt=(await evaluate("window.s3fTestApp.graphToPrompt()")).output;
        assert.deepEqual(prompt["5"].inputs.project_0,["2",0]);assert.deepEqual(prompt["5"].inputs.project_2,["4",0]);assert.deepEqual(prompt["5"].inputs.project_3,["2",0]);
        assert.equal(prompt["5"].inputs.project_1,undefined);assert.equal(prompt["5"].inputs.project_4,undefined);
        const graph=await evaluate("window.s3fTestApp.graph.serialize()");
        await evaluate(`window.s3fTestApp.loadGraphData(${JSON.stringify(graph)})`);
        assert.deepEqual((await evaluate("window.s3fTestApp.graphToPrompt()")).output,prompt);
        // Queue the actual serialized browser prompt, not just the Python fixture.
        const queued=await(await fetch(base+"/prompt",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({prompt,client_id:"s3f-timeline-browser"})})).json();
        assert.ok(queued.prompt_id,JSON.stringify(queued));
        let history;await until(async()=>{history=(await(await fetch(base+"/history/"+queued.prompt_id)).json())[queued.prompt_id];return history;},"browser prompt execution");
        assert.equal(history.status.status_str,"success",JSON.stringify(history.status));
        // Migrate a genuinely old one-input saved graph without shifting its link.
        const legacy=structuredClone(workflow),preview=legacy.nodes.find(n=>n.id===5);
        legacy.links=legacy.links.filter(l=>l[3]!==5||l[4]===0);preview.inputs=preview.inputs.slice(0,1);preview.inputs[0].name="project";
        for(const node of legacy.nodes.filter(n=>[3,4].includes(n.id)))node.outputs[0].links=[];
        await evaluate(`window.s3fTestApp.loadGraphData(${JSON.stringify(legacy)})`);
        assert.deepEqual((await evaluate("window.s3fTestApp.graphToPrompt()")).output["5"].inputs.project_0,["2",0]);
        assert.deepEqual((await inputs()).map(i=>i.name),["project_0","project_1"]);
        report.checks.push("Actual Comfy sockets grow on connection, retain sparse IDs on disconnection, reload unchanged, queue successfully, and migrate old project links");
    }
    fs.writeFileSync(output+"/report.json",JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{ws?.close();chrome.kill("SIGTERM");}
