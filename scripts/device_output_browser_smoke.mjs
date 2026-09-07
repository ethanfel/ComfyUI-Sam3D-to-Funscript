// Served and offline device conditioning with a disposable editor session.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {spawn} from "node:child_process";
import {buildDeviceOutput,deviceOutputFiles} from "../assets/device-output.mjs";
import {evaluate as valueAt} from "../assets/curve.mjs";

const base=process.argv[2],id=process.argv[3],output=path.resolve(process.argv[4]||"development/device-output/browser");
assert.ok(base&&id,"Pass a test server URL and fixture project ID");fs.mkdirSync(output,{recursive:true});
const downloads=fs.mkdtempSync(path.join(output,"downloads-")),profile=fs.mkdtempSync(path.join(os.tmpdir(),"s3f-output-chrome-"));
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
    const evaluate=async expression=>{const r=await call("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
    const click=selector=>evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const select=(selector,value)=>evaluate(`document.querySelector(${JSON.stringify(selector)}).value=${JSON.stringify(value)};document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new Event('change'))`);
    const disabled=selector=>evaluate(`document.querySelector(${JSON.stringify(selector)}).disabled`);
    const bitmap=()=>evaluate("document.querySelector('#curve').toDataURL()");
    async function file(selector,file){const doc=await call("DOM.getDocument"),input=await call("DOM.querySelector",{nodeId:doc.root.nodeId,selector});await call("DOM.setFileInputFiles",{nodeId:input.nodeId,files:[path.resolve(file)]});}
    async function download(selector='#save'){
        const folder=fs.mkdtempSync(path.join(downloads,"export-"));await call("Browser.setDownloadBehavior",{behavior:"allow",downloadPath:folder});
        await click(selector);let name;await until(()=>{name=fs.readdirSync(folder).find(f=>f.endsWith(".zip"));return name;},"ZIP download");
        return unzip(path.join(folder,name));
    }
    const asset=await fetch(base+'/sam3d_funscript/assets/device-output.mjs');assert.equal(asset.status,200);assert.match(asset.headers.get('content-type'),/javascript/);
    assert.equal((await fetch(base+'/sam3d_funscript/assets/DEVICE_PROFILES.md')).status,404);
    const original=await(await fetch(`${base}/sam3d_funscript/projects/${id}`)).json(),stem=path.parse(original.metadata.source.path).name;
    const session=crypto.randomUUID(),endpoint=`${base}/sam3d_funscript/editors/${session}`;
    const create=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:0,project:original})});assert.equal(create.status,200);
    await call('Runtime.enable');await call('Page.enable');await call('Network.enable');
    await call('Emulation.setDeviceMetricsOverride',{width:1500,height:1200,deviceScaleFactor:1,mobile:false});
    await call('Page.navigate',{url:`${base}/sam3d_funscript/assets/viewer.html?project=${id}&session=${session}`});
    await until(()=>evaluate("document.querySelector('#axis')?.options.length===6"),'served editor');
    await until(()=>evaluate("document.querySelector('#video').readyState>=2"),'source video');
    assert.equal(await disabled('#downloadDevice'),true);
    const baseline=JSON.parse((await download())['project.json']);
    await evaluate("document.querySelector('#deviceOutputPanel').open=true");
    await select('#outputProfile','handy2');assert.equal(await disabled('#downloadDevice'),true);
    assert.equal(await evaluate("document.querySelector('#outputSpeed').value"),'');
    await click('#publishedSpeed');assert.equal(await disabled('#downloadDevice'),false);
    assert.match(await evaluate("document.querySelector('#outputStatus').textContent"),/limit 400 mm\/s \(published\)/);
    let files=await download(),saved=JSON.parse(files['project.json']),expected=buildDeviceOutput(saved);
    assert.ok(expected.changed_points>0);assert.deepEqual(saved.scripts,baseline.scripts);assert.deepEqual(saved.timeline.tracks,baseline.timeline.tracks);
    assert.equal(saved.timeline.main.L0.locked,true);
    assert.deepEqual(JSON.parse(files[`device-output/${stem}.funscript`]),expected.script);
    assert.deepEqual(await download('#downloadDevice'),deviceOutputFiles(saved,stem));
    for(const [axis,script] of Object.entries(baseline.scripts))assert.deepEqual(saved.scripts[axis],script);
    assert.equal(Object.keys(files).filter(n=>n.endsWith('.funscript')&&!n.includes('/')).length,6);
    let before=await bitmap();await click('#outputOverlay');assert.notEqual(await bitmap(),before);await click('#outputOverlay');
    await select('#device','sr6');await select('#deviceMotion','adjusted');
    await evaluate("document.querySelector('#video').currentTime=.125");
    await until(()=>evaluate("Math.abs(Number(document.querySelector('#time').dataset.ms)-125)<.1"),'seek');
    let readouts=await evaluate("Array.from(document.querySelectorAll('#readouts span'),e=>({axis:e.dataset.axis,text:e.textContent}))");
    assert.equal(readouts[0].text,`L0 ${valueAt(expected.script.actions,125).toFixed(1)}`);
    for(const row of readouts.slice(1))assert.equal(row.text,`${row.axis} 50.0 (off)`);
    await select('#device','handy2');
    await evaluate("document.querySelector('#video').muted=true;document.querySelector('#video').play()");
    await until(()=>evaluate("document.querySelector('#video').currentTime>.65"),'playback');await evaluate("document.querySelector('#video').pause()");
    const playback=await evaluate("({time:Number(document.querySelector('#time').dataset.ms),value:parseFloat(document.querySelector('#readouts span').textContent.slice(3))})");
    assert.equal(playback.value,Number(valueAt(expected.script.actions,playback.time).toFixed(1)));
    report.checks.push('Published speed requires an explicit choice; physical analysis and orange overlay agree with the exported L0; adjusted playback uses that exact curve and neutralizes unsupported axes');

    await select('#outputSpeed','800');assert.equal(await disabled('#downloadDevice'),true);
    assert.match(await evaluate("document.querySelector('#outputStatus').textContent"),/normal mode/);
    await click('#undo');assert.equal(await evaluate("Number(document.querySelector('#outputSpeed').value)"),400);
    await select('#outputProfile','custom');await select('#zoneMax','125');await select('#outputSpeed','800');
    const fast=JSON.parse((await download('#downloadDevice'))[stem+'.funscript']);
    assert.deepEqual(fast.actions,original.scripts.L0.actions,'A faster user limit keeps these authored strokes');
    await select('#outputProfile','handy2');await click('#publishedSpeed');
    await select('#zoneMax','50');files=await download('#downloadDevice');
    assert.deepEqual(JSON.parse(files[stem+'.funscript']).actions,original.scripts.L0.actions,'Narrowing the physical zone avoids unnecessary reduction');
    await select('#zoneMax','0');assert.equal(await disabled('#downloadDevice'),true);
    assert.equal(await evaluate("document.querySelector('#deviceMotion').value"),'authored');
    files=await download();assert.ok(!Object.keys(files).some(n=>n.startsWith('device-output/')));
    assert.deepEqual(JSON.parse(files['project.json']).scripts,baseline.scripts);
    await select('#zoneMax','125');await select('#outputSetup','Test fixture · </script><b>notes</b>');
    await select('#deviceMotion','adjusted');
    await evaluate('window.s3fFlush()');
    const state=await(await fetch(endpoint)).json();assert.equal(state.project.device_output.profile,'handy2');
    assert.deepEqual(state.project.scripts,baseline.scripts);assert.deepEqual(state.project.timeline.tracks,baseline.timeline.tracks);
    report.checks.push('Higher speed and narrower zones preserve feasible motion; invalid inputs suppress adjusted output without losing authored exports; locks and Undo survive settings changes');

    // Requeue on a disposable node session to verify settings survive a real run.
    const incoming=output+'/incoming.json';fs.writeFileSync(incoming,JSON.stringify(original));
    const prompt={1:{class_type:'S3F_LoadProject',inputs:{project_path:incoming}},9:{class_type:'S3F_PreviewExport',inputs:{project_0:['1',0],filename:'device_profile_rerun'}}};
    const response=await fetch(`${base}/prompt`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt,extra_data:{extra_pnginfo:{workflow:{nodes:[{id:9,properties:{s3f_session:session}}]}}}})});
    assert.ok(response.ok,await response.clone().text());const queued=await response.json();let item;
    await until(async()=>{item=(await(await fetch(`${base}/history/${queued.prompt_id}`)).json())[queued.prompt_id];return item;},'Comfy rerun');
    assert.equal(item.status.status_str,'success',JSON.stringify(item.status));
    await evaluate('window.s3fUpdate()');
    const updated=(await(await fetch(endpoint)).json()).project;
    assert.deepEqual(updated.device_output,state.project.device_output);assert.deepEqual(updated.scripts,baseline.scripts);
    await evaluate('window.reloadMarker=true');await call('Page.reload',{ignoreCache:true});
    await until(()=>evaluate("!window.reloadMarker&&document.querySelector('#outputSpeed')?.value==='400'"),'profile reload');
    assert.equal(await evaluate("document.querySelector('#deviceMotion').value"),'adjusted');
    files=await download();saved=JSON.parse(files['project.json']);
    const offline=output+'/viewer.html';fs.writeFileSync(offline,files['viewer.html']);
    await call('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0});
    await call('Page.navigate',{url:pathToFileURL(offline).href});
    await until(()=>evaluate("document.querySelector('#outputProfile')?.value==='handy2'"),'offline profile');
    assert.equal(await evaluate("document.querySelector('#outputSetup').value"),saved.device_output.setup);
    const again=await download('#downloadDevice');assert.deepEqual(again,deviceOutputFiles(saved,stem));
    await file('#videoFile',original.metadata.source.path);await until(()=>evaluate("document.querySelector('#video').readyState>=2"),'offline video');
    await evaluate("document.querySelector('#video').currentTime=.125");await until(()=>evaluate("Math.abs(Number(document.querySelector('#time').dataset.ms)-125)<.1"),'offline seek');
    expected=buildDeviceOutput(saved);
    assert.equal(await evaluate("parseFloat(document.querySelector('#readouts span').textContent.slice(3))"),Number(valueAt(expected.script.actions,125).toFixed(1)));
    // An authored edit invalidates the derived output rather than exporting stale points.
    await click('#selectMain');await click('#lockMain');await click('#invert');
    const edited=JSON.parse((await download())['project.json']);
    assert.notDeepEqual(edited.scripts.L0,saved.scripts.L0);
    const editedFiles=await download('#downloadDevice');assert.deepEqual(editedFiles,deviceOutputFiles(edited,stem));
    await click('#undo');await click('#lockMain');
    await select('#axis','L0');await select('#zoom','4000');
    await evaluate("document.querySelector('#video').style.visibility='hidden';document.querySelector('#deviceOutputPanel').open=true;document.querySelector('.curves').scrollIntoView({block:'start'})");
    fs.writeFileSync(output+'/comparison.png',Buffer.from((await call('Page.captureScreenshot')).data,'base64'));
    await call('Emulation.setDeviceMetricsOverride',{width:560,height:1100,deviceScaleFactor:1,mobile:false});await pause(100);
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
    const reexport=await download(),reopened=output+'/viewer-reexport.html';fs.writeFileSync(reopened,reexport['viewer.html']);
    await call('Page.navigate',{url:pathToFileURL(reopened).href});
    await until(()=>evaluate("document.querySelector('#outputProfile')?.value==='handy2'"),'offline re-export');
    assert.equal(await evaluate("document.querySelector('#outputProfile').options.length"),5);
    assert.deepEqual(await download('#downloadDevice'),deviceOutputFiles(JSON.parse(reexport['project.json']),stem));
    report.checks.push('Profile settings survive local session save, Comfy rerun and reload; standalone playback and repeated exports match; authored edits refresh adjusted output; narrow layout fits');
    assert.deepEqual(report.errors,[]);fs.writeFileSync(output+'/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{ws?.close();chrome.kill('SIGTERM');}
