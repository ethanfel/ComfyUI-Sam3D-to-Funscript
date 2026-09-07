// Real cached multi-anchor clip: adaptive fitting, locks and offline playback.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {spawn} from "node:child_process";
import {evaluate as valueAt, autoFitAxis, rebuildAxis, motionForAxis} from "../assets/curve.mjs";
import {initializeTimeline,trackProject} from "../assets/timeline.mjs";

const base=process.argv[2],id=process.argv[3],output=path.resolve(process.argv[4]||"development/adaptive-auto/browser");
assert.ok(base&&id,"Pass base URL and an existing project ID");fs.mkdirSync(output,{recursive:true});
const downloads=fs.mkdtempSync(path.join(output,"downloads-")),profile=fs.mkdtempSync(path.join(os.tmpdir(),"s3f-adaptive-chrome-"));
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
    const controls=()=>evaluate("({calibration:document.querySelector('#calibration').value,rangeDisabled:document.querySelector('#range').disabled,centerDisabled:document.querySelector('#center').disabled,component:document.querySelector('#component').value,range:Number(document.querySelector('#range').value),center:Number(document.querySelector('#center').value),metrics:document.querySelector('#metrics').textContent,direction:document.querySelector('#directionInfo').textContent})");
    async function file(selector,file){const doc=await call("DOM.getDocument"),input=await call("DOM.querySelector",{nodeId:doc.root.nodeId,selector});await call("DOM.setFileInputFiles",{nodeId:input.nodeId,files:[path.resolve(file)]});}
    async function download(){const folder=fs.mkdtempSync(path.join(downloads,"export-"));await call("Browser.setDownloadBehavior",{behavior:"allow",downloadPath:folder});await click("#save");let name;await until(()=>{name=fs.readdirSync(folder).find(f=>f.endsWith(".zip"));return name;},"ZIP download");return unzip(path.join(folder,name));}
    const original=await(await fetch(`${base}/sam3d_funscript/projects/${id}`)).json();initializeTimeline(original);
    const lane=n=>`#tracks .track:nth-child(${n+1})`;
    const hand=original.timeline.tracks.findIndex(t=>t.name.includes('left hand'));
    assert.ok(hand>=0,'Queue the multi-anchor fixture first');
    const data=trackProject(original,original.timeline.tracks[hand]),expected=data.scripts.L0;
    await call('Runtime.enable');await call('Page.enable');await call('Network.enable');
    await call('Emulation.setDeviceMetricsOverride',{width:1500,height:1260,deviceScaleFactor:1,mobile:false});
    await call('Page.navigate',{url:`${base}/sam3d_funscript/assets/viewer.html?project=${id}`});
    await until(()=>evaluate("document.querySelector('#video')?.readyState>=2"),'project/video load');
    await click(`${lane(hand)} .track-select`);
    let ui=await controls();assert.equal(ui.calibration,'adaptive');assert.equal(ui.rangeDisabled,true);assert.equal(ui.centerDisabled,true);
    assert.match(ui.direction,/Adaptive left hand/);
    await evaluate("document.querySelector('#video').currentTime=11");
    await until(()=>evaluate("Number(document.querySelector('#time').dataset.ms)>10990"),'seek local motion');
    const motion=motionForAxis(data,'L0'),index=data.times_ms.findIndex(t=>t>=11000);
    ui=await controls();assert.ok(Math.abs(ui.range-motion.ranges[index])<.001,'Range shows the local calibration at the playhead');
    await click('#rebuild');let saved=JSON.parse((await download())['project.json']);
    assert.deepEqual(saved.timeline.tracks[hand].script,expected,'Regeneration must match Python output');
    assert.deepEqual(saved.scripts,original.scripts,'Source edits do not overwrite main');
    assert.deepEqual(saved.timeline.tracks[0],original.timeline.tracks[0],'The mouth anchor keeps its own curve and calibration');
    assert.ok(saved.timeline.tracks[hand].metrics.clipped_fraction===0);
    assert.ok(Math.max(...expected.actions.filter(a=>a.at>=9500).map(a=>a.pos))-Math.min(...expected.actions.filter(a=>a.at>=9500).map(a=>a.pos))>=80);
    // Manual range and whole-clip direction remain available.
    await select('#calibration','clip');ui=await controls();assert.equal(ui.rangeDisabled,false);assert.equal(ui.centerDisabled,false);
    await select('#range','0.5');await click('#rebuild');saved=JSON.parse((await download())['project.json']);
    assert.equal(saved.timeline.tracks[hand].settings.range,.5);assert.equal(saved.timeline.tracks[hand].settings.auto_fit,false);
    await select('#calibration','adaptive');saved=JSON.parse((await download())['project.json']);
    assert.deepEqual(saved.timeline.tracks[hand].script,expected);
    await click('#invert');saved=JSON.parse((await download())['project.json']);
    assert.deepEqual(saved.timeline.tracks[hand].script.actions,expected.actions.map(a=>({...a,pos:100-a.pos})));
    await click('#rebuild');saved=JSON.parse((await download())['project.json']);
    assert.deepEqual(saved.timeline.tracks[hand].script.actions,expected.actions.map(a=>({...a,pos:100-a.pos})), 'Regeneration preserves exact inversion');
    await click('#invert');
    await click(`${lane(hand)} .track-lock`);
    assert.equal(await evaluate("document.querySelector('#calibration').disabled&&document.querySelector('#autoFit').disabled"),true);
    await click('#autoFit');await click('#rebuild');saved=JSON.parse((await download())['project.json']);
    assert.deepEqual(saved.timeline.tracks[hand].script,expected);assert.equal(saved.timeline.tracks[hand].locked,true);
    await click(`${lane(hand)} .track-lock`);
    await click('#promoteTrack');saved=JSON.parse((await download())['project.json']);
    assert.deepEqual(saved.scripts.L0,expected,'Main can use the entire adaptive hand track');
    await evaluate("document.querySelector('#video').currentTime=11;document.querySelector('#video').muted=true;document.querySelector('#video').play()");
    await until(()=>evaluate("document.querySelector('#video').currentTime>11.5"),'adaptive playback');
    await evaluate("document.querySelector('#video').pause();document.querySelector('#video').style.visibility='hidden'");
    const readout=await evaluate("({time:Number(document.querySelector('#time').dataset.ms),value:parseFloat(document.querySelector('#readouts [data-axis=L0]').textContent.slice(3))})");
    assert.ok(Math.abs(readout.value-valueAt(expected.actions,readout.time))<.2,'Device follows exported main');
    await click(`${lane(hand)} .track-select`);await select('#zoom','4000');
    await evaluate("document.querySelector('.curves').scrollIntoView({block:'start'})");await pause(100);
    fs.writeFileSync(output+'/adaptive-timeline.png',Buffer.from((await call('Page.captureScreenshot')).data,'base64'));
    report.checks.push('Default hand Auto, local range readout, Python/browser regeneration, independent mouth curve, manual calibration, inversion, locks and device playback');
    // Export/reimport retains adaptive settings and actions without a server.
    const exported=await download(),snapshot=JSON.parse(exported['project.json']),offline=output+'/viewer.html';
    fs.writeFileSync(offline,exported['viewer.html']);
    await call('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0});
    await call('Page.navigate',{url:pathToFileURL(offline).href});
    await until(()=>evaluate("document.querySelectorAll('#tracks .track').length===3"),'offline adaptive project');
    await click(`${lane(hand)} .track-select`);await click('#autoFit');saved=JSON.parse((await download())['project.json']);
    assert.deepEqual(saved.timeline.tracks[hand].script,expected);assert.deepEqual(saved.scripts,snapshot.scripts);
    await file('#videoFile',original.metadata.source.path);await until(()=>evaluate("document.querySelector('#video').readyState>=2"),'offline source');
    // Old projects remain unchanged until the user explicitly requests Auto.
    const legacyPath=path.resolve('development/adaptive-auto/legacy.project.json'),legacy=JSON.parse(fs.readFileSync(legacyPath));
    await file('#projectFile',legacyPath);await until(()=>evaluate("document.querySelectorAll('#tracks .track').length===1"),'legacy import');
    saved=JSON.parse((await download())['project.json']);assert.deepEqual(saved.scripts,legacy.scripts);
    assert.equal((await controls()).rangeDisabled,false);
    await click('#autoFit');saved=JSON.parse((await download())['project.json']);
    assert.equal(saved.config.axis_settings.L0.calibration,'adaptive');
    const upgraded=structuredClone(legacy);upgraded.config.axis_settings.L0=autoFitAxis(upgraded,'L0');
    assert.deepEqual(saved.scripts.L0,rebuildAxis(upgraded,'L0'));
    await click('#undo');saved=JSON.parse((await download())['project.json']);assert.deepEqual(saved.scripts,legacy.scripts);
    await call('Emulation.setDeviceMetricsOverride',{width:560,height:1100,deviceScaleFactor:1,mobile:false});await pause(100);
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
    report.checks.push('Offline adaptive regeneration, untouched legacy import, explicit upgrade, Undo and narrow layout');
    assert.deepEqual(report.errors,[]);fs.writeFileSync(output+'/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{ws?.close();chrome.kill('SIGTERM');}
