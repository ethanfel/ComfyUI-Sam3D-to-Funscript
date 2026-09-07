// Exercise default seeking, explicit point editing and time-based smoothing in the offline viewer.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {spawn} from "node:child_process";
import {initializeTimeline} from "../assets/timeline.mjs";
import {smoothActions} from "../assets/curve-edit.mjs";

const input=path.resolve(process.argv[2]),output=path.resolve(process.argv[3]||"development/curve-edit/browser");
assert.ok(input,"Pass an offline viewer path");fs.mkdirSync(output,{recursive:true});
const downloads=fs.mkdtempSync(path.join(output,"downloads-")),profile=fs.mkdtempSync(path.join(os.tmpdir(),"s3f-curve-edit-chrome-"));
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
    const lane=n=>`#tracks .track:nth-child(${n+1})`;
    const point=original.scripts.L0.actions.find(a=>a.at>1000&&a.at<3000);
    const coords=async (at,pos)=>evaluate(`(()=>{const r=document.querySelector('#curve').getBoundingClientRect();return {x:r.left+42+${at}/${original.metadata.duration_ms}*(r.width-54),y:r.top+r.height-25-${pos}/100*(r.height-40)}})()`);
    await evaluate("document.querySelector('#curve').scrollIntoView({block:'center'})");
    const p=await coords(point.at,point.pos);
    const mouse=(type,x,y,button='left',buttons=1,clickCount=1)=>call('Input.dispatchMouseEvent',{type,x,y,button,buttons,clickCount});
    async function drag(x,y,dx,dy){await mouse('mousePressed',x,y);await mouse('mouseMoved',x+dx,y+dy);await mouse('mouseReleased',x+dx,y+dy,'left',0);}
    assert.equal(await evaluate("document.querySelector('#editPoints').checked"),false);
    await drag(p.x,p.y,70,25);
    assert.ok(await evaluate(`parseFloat(document.querySelector('#time').textContent)*1000>${point.at}`));
    await mouse('mousePressed',p.x,p.y,'left',1,2);await mouse('mouseReleased',p.x,p.y,'left',0,2);
    await mouse('mousePressed',p.x,p.y,'right',2);await mouse('mouseReleased',p.x,p.y,'right',0);
    let saved=JSON.parse((await download())['project.json']);assert.deepEqual(saved.scripts,original.scripts);
    assert.equal(await evaluate("document.querySelector('#undo').disabled"),true);
    await click('#editPoints');await evaluate("document.querySelector('#curve').scrollIntoView({block:'center'})");
    const edit=await coords(point.at,point.pos);await drag(edit.x,edit.y,0,25);
    saved=JSON.parse((await download())['project.json']);assert.notDeepEqual(saved.scripts.L0,original.scripts.L0);
    assert.equal(saved.scripts.L0.actions.length,original.scripts.L0.actions.length);
    await click('#undo');assert.deepEqual(JSON.parse((await download())['project.json']).scripts,original.scripts);
    // Point creation and deletion also require the explicit mode.
    const newAt=1234;assert.ok(!original.scripts.L0.actions.some(a=>a.at===newAt));
    const add=await coords(newAt,60);await mouse('mousePressed',add.x,add.y,'left',1,2);await mouse('mouseReleased',add.x,add.y,'left',0,2);
    saved=JSON.parse((await download())['project.json']);assert.equal(saved.scripts.L0.actions.length,original.scripts.L0.actions.length+1);
    await mouse('mousePressed',add.x,add.y,'right',2);await mouse('mouseReleased',add.x,add.y,'right',0);
    assert.deepEqual(JSON.parse((await download())['project.json']).scripts,original.scripts);
    await click('#undo');await click('#undo'); // Restore the pre-add edit flags as well.
    await click('#editPoints');
    await select('#selectionStart','1');await select('#selectionEnd','4');await select('#smoothMs','200');
    await click('#smoothSelection');saved=JSON.parse((await download())['project.json']);
    const expected=smoothActions(original.scripts.L0.actions,1000,4000,200);
    assert.deepEqual(saved.scripts.L0.actions,expected);
    for(const axis of ['L1','L2','R0','R1','R2'])assert.deepEqual(saved.scripts[axis],original.scripts[axis]);
    await click('#undo');const undone=JSON.parse((await download())['project.json']);
    assert.deepEqual(undone.scripts,original.scripts);assert.deepEqual(undone.timeline.main,original.timeline.main);
    await click('#lockMain');assert.equal(await evaluate("document.querySelector('#smoothSelection').disabled"),true);await click('#lockMain');
    await select('#smoothMs','0');await click('#smoothSelection');
    assert.match(await evaluate("document.querySelector('#status').textContent"),/positive/);
    assert.equal(await evaluate("document.querySelector('#undo').disabled"),true);
    assert.deepEqual(JSON.parse((await download())['project.json']).scripts,original.scripts);
    await select('#smoothMs','200');
    await click(`${lane(1)} .track-select`);await select('#selectionStart','9.5');await select('#selectionEnd','14.7');
    await click('#smoothSelection');saved=JSON.parse((await download())['project.json']);
    assert.deepEqual(saved.scripts,original.scripts,'Source smoothing does not change main');
    assert.deepEqual(saved.timeline.tracks[1].script.actions,smoothActions(original.timeline.tracks[1].script.actions,9500,14700,200));
    assert.deepEqual(saved.timeline.sources,original.timeline.sources);
    const files=await download(),offline=output+'/roundtrip.html';fs.writeFileSync(offline,files['viewer.html']);
    await call('Page.navigate',{url:pathToFileURL(offline).href});
    await until(()=>evaluate("document.querySelectorAll('#tracks .track').length>=2"),'smoothed offline project');
    assert.equal(await evaluate("document.querySelector('#editPoints').checked"),false,'New views start in seek mode');
    const again=JSON.parse((await download())['project.json']);assert.deepEqual(again.scripts,saved.scripts);assert.deepEqual(again.timeline.tracks,saved.timeline.tracks);
    await call('Emulation.setDeviceMetricsOverride',{width:560,height:1100,deviceScaleFactor:1,mobile:false});await pause(100);
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
    report.checks.push('Default point dragging scrubs the playhead; double-click and right-click cannot change actions. Edit points enables move/add/delete with Undo.');
    report.checks.push('200 ms smoothing affects only the selected interval and displayed main or source curve; locks, invalid durations, complete Undo, offline exports and narrow layout pass.');
    assert.deepEqual(report.errors,[]);fs.writeFileSync(output+'/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{ws?.close();chrome.kill('SIGTERM');}
