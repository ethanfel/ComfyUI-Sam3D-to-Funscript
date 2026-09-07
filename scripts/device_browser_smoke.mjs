// Exercise the served viewer, standalone downloads and the supplied asset demo.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {spawn} from "node:child_process";
import {evaluate as curveValue} from "../assets/curve.mjs";

const base=process.argv[2]||"http://127.0.0.1:8198";
const id=process.argv[3]||"detailed_anchor_24718326b157";
const output=path.resolve(process.argv[4]||"development/device-browser");
fs.mkdirSync(output,{recursive:true});
const downloads=fs.mkdtempSync(path.join(output,"downloads-"));
const profile=fs.mkdtempSync(path.join(os.tmpdir(),"s3f-device-chrome-"));
const chrome=spawn("/opt/google/chrome/chrome",["--headless","--no-sandbox","--disable-dev-shm-usage","--disable-gpu","--no-first-run","--no-default-browser-check","--remote-debugging-port=0",`--user-data-dir=${profile}`,"about:blank"],{stdio:"ignore"});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(test,label){for(let i=0;i<300;i++){if(await test())return;await pause(100);}throw new Error("Timed out: "+label);}
// makeZip writes uncompressed entries; inspect the actual browser download.
function unzip(file){
    const buffer=fs.readFileSync(file),files={};let offset=0;
    while(buffer.readUInt32LE(offset)===0x04034b50){
        assert.equal(buffer.readUInt16LE(offset+8),0);
        const size=buffer.readUInt32LE(offset+18),nameSize=buffer.readUInt16LE(offset+26),extra=buffer.readUInt16LE(offset+28);
        const name=buffer.toString("utf8",offset+30,offset+30+nameSize),start=offset+30+nameSize+extra;
        files[name]=buffer.toString("utf8",start,start+size);offset=start+size;
    }
    return files;
}
const report={checks:[],errors:[]};let ws;
try{
    let port;
    await until(()=>{try{port=fs.readFileSync(profile+"/DevToolsActivePort","utf8").split("\n")[0];return port;}catch{return false;}},"Chrome start");
    const target=await(await fetch(`http://127.0.0.1:${port}/json/new?about:blank`,{method:"PUT"})).json();
    ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener("open",r,{once:true}));
    let next=0;const pending=new Map();
    ws.addEventListener("message",event=>{const m=JSON.parse(event.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(m.error):p.resolve(m.result);}else if(m.method==="Runtime.exceptionThrown")report.errors.push(m.params.exceptionDetails);});
    const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
    const evaluate=async expression=>{const r=await call("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
    const setDevice=async name=>evaluate(`document.querySelector('#device').value=${JSON.stringify(name)};document.querySelector('#device').dispatchEvent(new Event('change'))`);
    const bitmap=()=>evaluate("document.querySelector('#robot').toDataURL()");
    const readouts=()=>evaluate("Array.from(document.querySelectorAll('#readouts span'),e=>({axis:e.dataset.axis,value:parseFloat(e.textContent.slice(3)),text:e.textContent}))");
    async function selectFile(selector,file){const doc=await call("DOM.getDocument"),input=await call("DOM.querySelector",{nodeId:doc.root.nodeId,selector});await call("DOM.setFileInputFiles",{nodeId:input.nodeId,files:[path.resolve(file)]});}
    async function seek(seconds){await evaluate(`document.querySelector('#video').currentTime=${seconds}`);await until(()=>evaluate(`Math.abs(parseFloat(document.querySelector('#time').textContent)-${seconds})<.01`),"seeked device frame");}
    async function playback(){
        const before=await bitmap(),start=await evaluate("document.querySelector('#video').currentTime");
        await evaluate("document.querySelector('#video').muted=true;document.querySelector('#video').play()");
        await until(()=>evaluate(`document.querySelector('#video').currentTime>${start+.6}`),"video playback advances");
        await evaluate("document.querySelector('#video').pause()");
        assert.notEqual(await bitmap(),before);
    }
    async function download(){
        const folder=fs.mkdtempSync(path.join(downloads,"export-"));
        await call("Browser.setDownloadBehavior",{behavior:"allow",downloadPath:folder});
        await evaluate("document.querySelector('#save').click()");
        let file;await until(()=>{file=fs.readdirSync(folder).find(f=>f.endsWith(".zip"));return file;},"viewer ZIP download");
        return unzip(path.join(folder,file));
    }
    await call("Runtime.enable");await call("Page.enable");await call("Network.enable");
    await call("Browser.setDownloadBehavior",{behavior:"allow",downloadPath:downloads});
    await call("Emulation.setDeviceMetricsOverride",{width:1450,height:1060,deviceScaleFactor:1,mobile:false});
    const module=await fetch(base+"/sam3d_funscript/assets/device-previews/device-wireframes.mjs");
    assert.equal(module.status,200);assert.match(module.headers.get("content-type"),/javascript/);
    for(const name of ["README.md","preview.template.html","..%2F..%2Fnodes.py"])assert.equal((await fetch(base+"/sam3d_funscript/assets/device-previews/"+name)).status,404);
    report.checks.push("Renderer served with JavaScript MIME; unlisted and traversal paths rejected");
    const data=await(await fetch(`${base}/sam3d_funscript/projects/${id}`)).json();
    await call("Page.navigate",{url:`${base}/sam3d_funscript/assets/viewer.html?project=${id}`});
    await until(()=>evaluate("document.querySelector('#video')?.readyState>=2"),"source video");
    for(const device of ["handy2","sr6"]){
        await setDevice(device);await seek(.5);await playback();await seek(1.5);
        const values=await readouts();assert.deepEqual(values.map(v=>v.axis),device==="handy2"?["L0"]:["L0","L1","L2","R0","R1","R2"]);
        for(const v of values)assert.equal(v.value,Number(curveValue(data.scripts[v.axis]?.actions,1500).toFixed(1)));
    }
    report.checks.push("Both devices animate with video playback and show the evaluated script values after seeking");
    let before=await bitmap();
    await evaluate("document.querySelector('#robot').focus()");
    await call("Input.dispatchKeyEvent",{type:"keyDown",key:"ArrowLeft"});
    await call("Input.dispatchKeyEvent",{type:"keyUp",key:"ArrowLeft"});assert.notEqual(await bitmap(),before);
    before=await bitmap();await evaluate("document.querySelector('#deviceSleeve').click()");assert.notEqual(await bitmap(),before);
    report.checks.push("Keyboard orbit and sleeve toggle change the rendered device");
    await evaluate("document.querySelector('#video').style.visibility='hidden'");
    fs.writeFileSync(output+"/sr6-viewer.png",Buffer.from((await call("Page.captureScreenshot")).data,"base64"));
    await setDevice("handy2");
    fs.writeFileSync(output+"/handy2-viewer.png",Buffer.from((await call("Page.captureScreenshot")).data,"base64"));
    await call("Emulation.setDeviceMetricsOverride",{width:560,height:1050,deviceScaleFactor:1,mobile:false});
    await pause(200);assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth"),true);
    await call("Emulation.setDeviceMetricsOverride",{width:1450,height:1060,deviceScaleFactor:1,mobile:false});

    // Seek the editor without video to isolate the channel mapping at exact times.
    const fixture=structuredClone(data),fixturePath=output+"/axis-isolation.json";
    for(const axis of Object.keys(fixture.scripts))fixture.scripts[axis].actions=[{at:0,pos:axis==="L0"?50:0},{at:Math.round(data.metadata.duration_ms),pos:axis==="L0"?50:100}];
    fs.writeFileSync(fixturePath,JSON.stringify(fixture));await selectFile("#projectFile",fixturePath);
    await until(()=>evaluate("document.querySelector('#video').getAttribute('src')===null"),"fixture import");
    const timeline=async fraction=>evaluate(`(()=>{const c=document.querySelector('#curve'),r=c.getBoundingClientRect();c.dispatchEvent(new PointerEvent('pointerdown',{clientX:r.x+42+(r.width-54)*${fraction},clientY:r.y+20,button:0}));})()`);
    await setDevice("handy2");await timeline(.2);before=await bitmap();await timeline(.8);assert.equal(await bitmap(),before);
    await setDevice("sr6");await timeline(.2);before=await bitmap();await timeline(.8);assert.notEqual(await bitmap(),before);
    delete fixture.scripts.L0;fs.writeFileSync(output+"/no-stroke.json",JSON.stringify(fixture));await selectFile("#projectFile",output+"/no-stroke.json");
    await until(()=>evaluate("document.querySelector('#axis').options.length===5"),"missing stroke fixture");
    await setDevice("handy2");assert.deepEqual(await readouts(),[{axis:"L0",value:50,text:"L0 50.0 (off)"}]);
    report.checks.push("Handy ignores changing unsupported axes and holds neutral when L0 is absent; SR6 responds to the other axes");

    fs.writeFileSync(output+"/original.json",JSON.stringify(data));await selectFile("#projectFile",output+"/original.json");
    await until(()=>evaluate("document.querySelector('#axis').options.length===6"),"restore original project");
    await setDevice("handy2");const files=await download(),saved=JSON.parse(files["project.json"]);
    assert.deepEqual(saved.scripts,data.scripts);assert.equal(saved.preview.device,"handy2");
    assert.equal(Object.keys(files).filter(f=>f.endsWith(".funscript")).length,6);
    const offline=output+"/viewer.html";fs.writeFileSync(offline,files["viewer.html"]);
    await call("Network.emulateNetworkConditions",{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0});
    await call("Page.navigate",{url:pathToFileURL(offline).href});
    await until(()=>evaluate("document.querySelector('#axis')?.options.length===6"),"offline embedded project");
    assert.equal(await evaluate("document.querySelector('#device').value"),"handy2");
    await selectFile("#videoFile",data.metadata.source.path);
    await until(()=>evaluate("document.querySelector('#video').readyState>=2"),"offline local video");
    await seek(.5);await playback();
    await setDevice("sr6");await seek(.5);await playback();
    const again=await download();assert.deepEqual(JSON.parse(again["project.json"]).scripts,data.scripts);
    assert.equal(JSON.parse(again["project.json"]).preview.device,"sr6");
    fs.writeFileSync(output+"/viewer-reexport.html",again["viewer.html"]);
    await call("Page.navigate",{url:pathToFileURL(output+"/viewer-reexport.html").href});
    await until(()=>evaluate("document.querySelector('#axis')?.options.length===6"),"offline re-export reopen");
    assert.equal(await evaluate("document.querySelector('#device').value"),"sr6");
    report.checks.push("ZIP keeps all authored axes and the selected device; both models play local video offline and re-export a working viewer");

    await call("Page.navigate",{url:pathToFileURL(path.resolve("assets/device-previews/preview.html")).href});
    await until(()=>evaluate("document.querySelector('#handy-readouts')?.children.length===1"),"standalone asset demo");
    const demoBitmap=device=>evaluate(`document.querySelector('#${device}').toDataURL()`);
    const handy=await demoBitmap("handy2"),sr6=await demoBitmap("sr6");
    await evaluate("document.querySelector('#axis-L1').value=90;document.querySelector('#axis-L1').dispatchEvent(new Event('input'))");
    await until(()=>evaluate("document.querySelector('#value-L1').textContent==='90.0'"),"demo slider");
    assert.equal(await demoBitmap("handy2"),handy);assert.notEqual(await demoBitmap("sr6"),sr6);
    await evaluate("document.querySelector('#play').click()");
    await until(()=>evaluate("document.querySelector('#value-L0').textContent!=='50.0'"),"demo playback");
    await pause(500);await evaluate("document.querySelector('#play').click()");
    assert.notEqual(await demoBitmap("handy2"),handy);
    fs.writeFileSync(output+"/asset-demo.png",Buffer.from((await call("Page.captureScreenshot")).data,"base64"));
    report.checks.push("Supplied preview.html animates offline; its L1 slider affects only SR6");
    assert.deepEqual(report.errors,[]);
    fs.writeFileSync(output+"/report.json",JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{ws?.close();chrome.kill("SIGTERM");}
