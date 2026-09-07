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
    const original=await(await fetch(`${base}/sam3d_funscript/projects/${id}`)).json();initializeTimeline(original);
    const source=original.timeline.tracks[1],fitted={...fitSelectionTrack(original,source,[9500,13596]),edited:true};
    await call("Runtime.enable");await call("Page.enable");await call("Network.enable");
    await call("Emulation.setDeviceMetricsOverride",{width:1500,height:1260,deviceScaleFactor:1,mobile:false});
    await call("Page.navigate",{url:`${base}/sam3d_funscript/assets/viewer.html?project=${id}`});
    await until(()=>evaluate("document.querySelector('#video')?.readyState>=2"),"project/video load");
    const lane=n=>`#tracks .track:nth-child(${n+1})`;
    await click(`${lane(1)} .track-select`);await click("#fitSelection");
    assert.equal(await evaluate("document.querySelectorAll('#tracks .track').length"),2,"Invalid empty selection cannot add a track");
    await select("#selectionStart","9.5");await select("#selectionEnd","13.596");await click("#fitSelection");
    assert.equal(await evaluate("document.querySelectorAll('#tracks .track').length"),3);
    assert.equal((await controls()).range,fitted.settings.range);assert.equal((await controls()).center,fitted.settings.center);
    assert.match(await evaluate("document.querySelector('#editing').textContent"),/local origin/);
    assert.match(await evaluate(`document.querySelector('${lane(2)} .track-scope').textContent`),/local fit/);
    let saved=JSON.parse((await download())["project.json"]);
    assert.deepEqual(saved.scripts,original.scripts);assert.deepEqual(saved.timeline.sources,original.timeline.sources);
    assert.deepEqual(saved.timeline.tracks.slice(0,2),original.timeline.tracks);
    assert.deepEqual(saved.timeline.tracks[2],fitted);
    assert.deepEqual(saved.timeline.selection,trackCoverage(original,fitted));
    assert.ok(fitted.settings.range<source.settings.range/6);
    assert.ok(fitted.script.actions.every(a=>a.pos>=5&&a.pos<=95),"No flattened filtered peaks");
    await click("#invert");const mirrored=JSON.parse((await download())["project.json"]);
    assert.deepEqual(mirrored.timeline.tracks[2].script.actions,fitted.script.actions.map(a=>({...a,pos:100-a.pos})));
    assert.deepEqual(mirrored.scripts,original.scripts);await click("#undo");
    await click("#autoFit");assert.equal((await controls()).range,fitted.settings.range,"Auto fit stays local on a section track");await click("#undo");
    report.checks.push("The real hand interval fits at about 5.9 cm instead of 41.9 cm, without clipping; local fitting, inversion and refitting preserve the original tracks and main");
    await click("#applySection");saved=JSON.parse((await download())["project.json"]);
    const expected=structuredClone(original);expected.timeline.tracks.push(fitted);
    const [start,end]=trackCoverage(original,fitted);applyTrack(expected,fitted,"L0",{start,end,blendMs:200});expected.timeline.main.L0.edited=true;
    assert.deepEqual(saved.scripts,expected.scripts);assert.deepEqual(saved.timeline.main,expected.timeline.main);
    await click("#selectMain");
    await evaluate("document.querySelector('#video').currentTime=10.285;document.querySelector('#video').muted=true;document.querySelector('#video').play()");
    await until(()=>evaluate("document.querySelector('#video').currentTime>10.7"),"section playback");
    await evaluate("document.querySelector('#video').pause();document.querySelector('#video').style.visibility='hidden'");
    const readout=await evaluate("({time:parseFloat(document.querySelector('#time').textContent)*1000,value:parseFloat(document.querySelector('#readouts [data-axis=L0]').textContent.slice(3))})");
    assert.ok(Math.abs(readout.value-valueAt(saved.scripts.L0.actions,readout.time))<.2);
    await click(`${lane(2)} .track-select`);await select("#zoom","4000");
    await evaluate("document.querySelector('#tracks').scrollTop=document.querySelector('#tracks').scrollHeight;document.querySelector('.curves').scrollIntoView({block:'start'})");await pause(100);
    fs.writeFileSync(output+"/local-fit.png",Buffer.from((await call("Page.captureScreenshot")).data,"base64"));
    await select("#zoom","0");
    const exported=await download(),snapshot=JSON.parse(exported["project.json"]),offline=output+"/viewer.html";
    fs.writeFileSync(offline,exported["viewer.html"]);
    await call("Network.emulateNetworkConditions",{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0});
    await call("Page.navigate",{url:pathToFileURL(offline).href});
    await until(()=>evaluate("document.querySelectorAll('#tracks .track').length===3"),"offline window track");
    assert.equal((await controls()).range,fitted.settings.range);
    await file("#videoFile",original.metadata.source.path);await until(()=>evaluate("document.querySelector('#video').readyState>=2"),"offline source");
    await click("#autoFit");let again=JSON.parse((await download())["project.json"]);
    assert.deepEqual(again.timeline.tracks[2].script,fitted.script);assert.deepEqual(again.scripts,snapshot.scripts);
    await click("#undo");
    await click(`${lane(2)} .remove-track`);again=JSON.parse((await download())["project.json"]);assert.deepEqual(again.scripts,snapshot.scripts);
    await evaluate("document.querySelector('#video').currentTime=11");await until(()=>evaluate("parseFloat(document.querySelector('#time').textContent)>10.9"),"main pose from saved section after track deletion");
    await click("#undo");await select(`${lane(2)} .track-source`,"project_0");
    assert.equal(await evaluate(`!!document.querySelector('${lane(2)} .track-scope')`),false);
    await click("#undo");assert.match(await evaluate(`document.querySelector('${lane(2)} .track-scope').textContent`),/local fit/);
    fs.writeFileSync(output+"/project.json",JSON.stringify(snapshot));await file("#projectFile",output+"/project.json");
    await until(()=>evaluate("document.querySelector('#undo').disabled"),"project reimport");
    again=JSON.parse((await download())["project.json"]);assert.deepEqual(again.timeline,snapshot.timeline);assert.deepEqual(again.scripts,snapshot.scripts);
    await call("Emulation.setDeviceMetricsOverride",{width:560,height:1100,deviceScaleFactor:1,mobile:false});await pause(100);
    assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth"),true);
    report.checks.push("Locally fitted curves blend into main and drive its device preview; window/pose provenance, reassignment, removal, Undo and export/reimport work offline and at narrow widths");
    assert.deepEqual(report.errors,[]);fs.writeFileSync(output+"/report.json",JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{ws?.close();chrome.kill("SIGTERM");}
