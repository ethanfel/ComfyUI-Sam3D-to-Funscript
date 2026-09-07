// Real browser checks for Auto controls, selected-axis isolation and offline use.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {spawn} from "node:child_process";
import {autoFitAxis,rebuildAxis} from "../assets/curve.mjs";

const base=process.argv[2],id=process.argv[3],output=path.resolve(process.argv[4]||"development/auto-browser");
assert.ok(base&&id,"Pass base URL and an existing project ID");fs.mkdirSync(output,{recursive:true});
const downloads=fs.mkdtempSync(path.join(output,"downloads-")),profile=fs.mkdtempSync(path.join(os.tmpdir(),"s3f-auto-chrome-"));
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
    const original=await(await fetch(`${base}/sam3d_funscript/projects/${id}`)).json(),expected=structuredClone(original);
    expected.config.axis_settings.L0=autoFitAxis(expected,"L0");expected.scripts.L0=rebuildAxis(expected,"L0");
    await call("Runtime.enable");await call("Page.enable");await call("Network.enable");
    await call("Emulation.setDeviceMetricsOverride",{width:1450,height:1060,deviceScaleFactor:1,mobile:false});
    await call("Page.navigate",{url:`${base}/sam3d_funscript/assets/viewer.html?project=${id}`});
    await until(()=>evaluate("document.querySelector('#video')?.readyState>=2"),"source video");
    const initial=await controls();
    await select("#component","auto");await click("#rebuild");
    assert.equal((await controls()).range,initial.range);assert.equal((await controls()).component,"auto");
    await click("#undo");assert.equal((await controls()).metrics,initial.metrics);
    report.checks.push("Auto direction can be selected without changing the authored range");
    await evaluate("(()=>{const ctx=document.querySelector('#skeleton').getContext('2d'),draw=ctx.fillText;ctx.fillText=function(text,...args){if(text.startsWith('Auto '))window.s3fAutoArrow=text;return draw.call(this,text,...args);};})()");
    await click("#autoFit");const fitted=await controls();
    assert.equal(fitted.component,"auto");assert.equal(fitted.range,expected.config.axis_settings.L0.range);assert.equal(fitted.center,expected.config.axis_settings.L0.center);
    assert.match(fitted.direction,/directional share/);assert.equal(await evaluate("window.s3fAutoArrow"),"Auto L0 direction");
    const bitmap=await evaluate("document.querySelector('#skeleton').toDataURL()");
    await click("#invert");await click("#rebuild");assert.notEqual(await evaluate("document.querySelector('#skeleton').toDataURL()"),bitmap);
    await click("#undo");assert.deepEqual(await controls(),fitted);
    await select("#component","2");await click("#rebuild");assert.equal(await evaluate("document.querySelector('#directionInfo').hidden"),true);
    await click("#undo");assert.deepEqual(await controls(),fitted);
    await select("#axis","R0");await click("#autoFit");assert.equal(await evaluate("document.querySelector('#unit').textContent"),"degrees");
    assert.equal(await evaluate("window.s3fAutoArrow"),"Auto R0 rotation axis");await click("#undo");await select("#axis","L0");
    report.checks.push("Auto fit updates direction, range, center and 3D arrow; Invert, manual components, rotation axes and Undo work");
    await evaluate("document.querySelector('#video').currentTime=.5;document.querySelector('#video').muted=true;document.querySelector('#video').play()");
    await until(()=>evaluate("document.querySelector('#video').currentTime>1"),"Auto playback");await evaluate("document.querySelector('#video').pause();document.querySelector('#video').style.visibility='hidden'");
    fs.writeFileSync(output+"/auto-viewer.png",Buffer.from((await call("Page.captureScreenshot")).data,"base64"));
    await call("Emulation.setDeviceMetricsOverride",{width:560,height:1060,deviceScaleFactor:1,mobile:false});await pause(200);
    assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth"),true);
    const files=await download(),saved=JSON.parse(files["project.json"]);
    assert.deepEqual(saved.scripts,expected.scripts);assert.equal(saved.config.axis_settings.L0.component,"auto");
    assert.ok(saved.metrics.L0.auto_direction.length);assert.equal(Object.keys(files).filter(name=>name.endsWith(".funscript")).length,6);
    for(const axis of Object.keys(saved.scripts))assert.deepEqual(rebuildAxis(saved,axis),saved.scripts[axis]);
    report.checks.push("Video playback and responsive layout work; export changes only L0 and preserves automatic projection metadata");
    const offline=output+"/viewer.html";fs.writeFileSync(offline,files["viewer.html"]);
    await call("Network.emulateNetworkConditions",{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0});
    await call("Page.navigate",{url:pathToFileURL(offline).href});await until(()=>evaluate("document.querySelector('#component')?.value==='auto'"),"offline Auto project");
    await file("#videoFile",original.metadata.source.path);await until(()=>evaluate("document.querySelector('#video').readyState>=2"),"offline source video");
    await click("#autoFit");const again=await download();assert.deepEqual(JSON.parse(again["project.json"]).scripts,expected.scripts);
    const oldFile=output+"/original.json";fs.writeFileSync(oldFile,JSON.stringify(original));await file("#projectFile",oldFile);
    await until(()=>evaluate(`document.querySelector('#component').value===${JSON.stringify(String(original.config.axis_settings.L0.component))}`),"old project import offline");
    await click("#autoFit");assert.equal((await controls()).range,expected.config.axis_settings.L0.range);
    report.checks.push("Older projects can be fitted offline; downloaded Auto viewers reopen and re-export identical scripts without networking");
    assert.deepEqual(report.errors,[]);fs.writeFileSync(output+"/report.json",JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{ws?.close();chrome.kill("SIGTERM");}
