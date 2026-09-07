// Copy a selected source interval after inspecting main, using a saved multi-track project.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {spawn} from "node:child_process";
import {initializeTimeline,applyTrack} from "../assets/timeline.mjs";
import {roundEven,evaluate as curveValue} from "../assets/curve.mjs";

const input=path.resolve(process.argv[2]),output=path.resolve(process.argv[3]||"development/selection-copy/browser");
assert.ok(input,"Pass an offline viewer path");fs.mkdirSync(output,{recursive:true});
const downloads=fs.mkdtempSync(path.join(output,"downloads-")),profile=fs.mkdtempSync(path.join(os.tmpdir(),"s3f-selection-chrome-"));
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
    async function download(){const folder=fs.mkdtempSync(path.join(downloads,"export-"));await call("Browser.setDownloadBehavior",{behavior:"allow",downloadPath:folder});await click("#save");let name;await until(()=>{name=fs.readdirSync(folder).find(f=>f.endsWith(".zip"));return name;},"ZIP download");return unzip(path.join(folder,name));}
    await call('Runtime.enable');await call('Page.enable');
    await call('Emulation.setDeviceMetricsOverride',{width:1500,height:1260,deviceScaleFactor:1,mobile:false});
    await call('Page.navigate',{url:pathToFileURL(input).href});
    await until(()=>evaluate("document.querySelectorAll('#tracks .track').length>=2"),'saved project');
    let original=JSON.parse((await download())['project.json']);initializeTimeline(original);
    const hand=original.timeline.tracks.findIndex(t=>t.name.includes('hand')||t.name.includes('wrist')),lane=n=>`#tracks .track:nth-child(${n+1})`;
    assert.ok(hand>=0);const track=original.timeline.tracks[hand];
    await click(`${lane(hand)} .track-select`);
    // Reproduce selecting a source interval and then inspecting its destination.
    await select('#selectionStart','9.5');await select('#selectionEnd','14.7');
    await click('#selectMain');
    assert.equal(await evaluate("document.querySelector('#applySection').disabled"),false);
    assert.match(await evaluate("document.querySelector('#selectionStatus').textContent"),/L0 → Main L0 · one axis only/);
    assert.equal(await evaluate("document.querySelectorAll('.track.copy-source').length"),1);
    assert.equal(await evaluate(`document.querySelector('${lane(hand)}').classList.contains('copy-source')`),true);
    await click('#applySection');let saved=JSON.parse((await download())['project.json']);
    const expected=structuredClone(original);applyTrack(expected,track,'L0',{start:9500,end:14700,blendMs:200});
    assert.deepEqual(saved.scripts,expected.scripts);
    for(const axis of ['L1','L2','R0','R1','R2'])assert.deepEqual(saved.scripts[axis],original.scripts[axis]);
    assert.equal(saved.timeline.selection_track,track.id);assert.equal(saved.timeline.active,'main');
    assert.match(await evaluate("document.querySelector('#selectionStatus').textContent"),/Selection copied/);
    await click('#undo');assert.deepEqual(JSON.parse((await download())['project.json']).scripts,original.scripts);
    // The copy action is also available directly on the source row.
    await click(`${lane(hand)} .copy-selection`);saved=JSON.parse((await download())['project.json']);
    assert.deepEqual(saved.scripts,expected.scripts);await click('#undo');
    // Main lock reports the reason beside the action; it does not silently fail.
    await click('#lockMain');
    assert.equal(await evaluate("document.querySelector('#applySection').disabled"),true);
    assert.match(await evaluate("document.querySelector('#selectionStatus').textContent"),/Main L0 is locked/);
    assert.equal(await evaluate(`document.querySelector('${lane(hand)} .copy-selection').disabled`),true);
    await click('#lockMain');
    // The last pose marks the START of the last frame; its script holds through
    // the clip duration. Selecting that held tail must not disable copying.
    const end=roundEven(original.metadata.duration_ms);
    await select('#selectionEnd','18');
    assert.equal(await evaluate("document.querySelector('#applySection').disabled"),false);
    assert.equal(await evaluate("Number(document.querySelector('#selectionEnd').value)*1000"),end);
    await select('#zoom','0');
    await evaluate(`document.querySelector('${lane(hand)} canvas').scrollIntoView({block:'center'})`);
    const drag=await evaluate(`(()=>{const r=document.querySelector('${lane(hand)} canvas').getBoundingClientRect();return {start:r.left+42+9500/${original.metadata.duration_ms}*(r.width-54),end:r.right-9,y:r.top+r.height/2};})()`);
    await call('Input.dispatchMouseEvent',{type:'mousePressed',x:drag.start,y:drag.y,button:'left',buttons:1,clickCount:1,modifiers:8});
    await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:drag.end,y:drag.y,button:'left',buttons:1,modifiers:8});
    await call('Input.dispatchMouseEvent',{type:'mouseReleased',x:drag.end,y:drag.y,button:'left',buttons:0,clickCount:1,modifiers:8});
    assert.equal(await evaluate("Number(document.querySelector('#selectionEnd').value)*1000"),end);
    assert.equal(await evaluate(`document.querySelector('${lane(hand)} .copy-selection').disabled`),false);
    const tailExpected=structuredClone(original);applyTrack(tailExpected,track,'L0',{start:9500,end,blendMs:200});
    await click(`${lane(hand)} .copy-selection`);saved=JSON.parse((await download())['project.json']);
    assert.deepEqual(saved.scripts,tailExpected.scripts);await click('#undo');
    await click('#selectMain');await click('#applySection');saved=JSON.parse((await download())['project.json']);
    assert.deepEqual(saved.scripts,tailExpected.scripts);await click('#undo');
    await select('#join','cut');await click('#applySection');saved=JSON.parse((await download())['project.json']);
    assert.equal(saved.scripts.L0.actions.at(-1).at,end);
    assert.equal(saved.scripts.L0.actions.at(-1).pos,roundEven(curveValue(track.script.actions,end)));
    for(const axis of ['L1','L2','R0','R1','R2'])assert.deepEqual(saved.scripts[axis],original.scripts[axis]);
    await click('#undo');await select('#join','blend');
    await click('#selectTrack');assert.equal(await evaluate("Number(document.querySelector('#selectionEnd').value)*1000"),end);
    await select('#selectionStart','9.5');
    await select('#selectionEnd','9.5');assert.match(await evaluate("document.querySelector('#selectionStatus').textContent"),/time range/);
    await select('#selectionEnd',String(end/1000));await click('#selectMain');
    await evaluate("document.querySelector('#video').style.visibility='hidden';document.querySelector('.curves').scrollIntoView({block:'start'})");
    fs.writeFileSync(output+'/selection-source.png',Buffer.from((await call('Page.captureScreenshot')).data,'base64'));
    const files=await download(),offline=output+'/roundtrip.html';fs.writeFileSync(offline,files['viewer.html']);
    await call('Page.navigate',{url:pathToFileURL(offline).href});
    await until(()=>evaluate("document.querySelectorAll('#tracks .track').length>=2"),'selection roundtrip');
    assert.equal(await evaluate("document.querySelector('#applySection').disabled"),false);
    await click('#applySection');saved=JSON.parse((await download())['project.json']);assert.deepEqual(saved.scripts,tailExpected.scripts);
    await call('Emulation.setDeviceMetricsOverride',{width:560,height:1100,deviceScaleFactor:1,mobile:false});await pause(100);
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
    report.checks.push('Selection retains its source when main is active; toolbar and row copies match expected blend on L0 only; lock, empty-range feedback, Undo, offline roundtrip and narrow layout');
    report.checks.push('Shift-drag to the right edge, typed clip-end selection and Select track range include the final held frame; toolbar and row buttons copy to L0, cut retains the exact final source value, other axes stay unchanged and the end selection survives offline re-export');
    assert.deepEqual(report.errors,[]);fs.writeFileSync(output+'/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{ws?.close();chrome.kill('SIGTERM');}
