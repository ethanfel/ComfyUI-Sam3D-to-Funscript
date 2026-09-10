// Neutral fixture: real editor assets, two linked browser views and offline ZIP.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import {spawn,spawnSync} from "node:child_process";
import {pathToFileURL} from "node:url";
import {continuePattern,generatePattern} from "../assets/patterns.mjs";
import {initializeTimeline} from "../assets/timeline.mjs";

const root=path.resolve(import.meta.dirname,".."),temporary=fs.mkdtempSync(path.join(os.tmpdir(),"s3f-pattern-browser-"));
const output=path.resolve(process.argv[2]||"development/pattern-browser");fs.mkdirSync(output,{recursive:true});
const fixture=spawnSync(process.env.S3F_PYTHON||"/media/p5/miniforge3/envs/13_env_py313/bin/python",["-c",`
import sys,json,math
from pathlib import Path
sys.path.insert(0,'tests')
from test_core import fixture
from sam3d_funscript.core import build_project
from sam3d_funscript.standalone import standalone_html
s=fixture();s.times_ms*=6;s.metadata['duration_ms']=12000
p=build_project(s);p['metadata']['source']={'path':'neutral.mp4'}
p['scripts']['L0']['actions']=[{'at':i*10,'pos':50 if 5000<i*10<6400 else round(50+35*math.sin(i*10/900*2*math.pi))} for i in range(1201)]
Path(sys.argv[1],'project.json').write_text(json.dumps(p))
Path(sys.argv[1],'standalone.html').write_text(standalone_html())
`,temporary],{cwd:root});assert.equal(fixture.status,0,fixture.stderr.toString());
const original=JSON.parse(fs.readFileSync(path.join(temporary,"project.json")));initializeTimeline(original);
const clip=path.join(temporary,"neutral.mp4"), ffmpeg=spawnSync("ffmpeg",["-v","error","-f","lavfi","-i","color=c=slateblue:s=160x120:r=10:d=12","-c:v","libx264","-pix_fmt","yuv420p","-movflags","+faststart",clip]);assert.equal(ffmpeg.status,0,ffmpeg.stderr.toString());
let state={revision:1,project:structuredClone(original),output:"neutral"};
const session="1234567890abcdef1234567890abcdef",report={checks:[],errors:[]};
const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,"http://localhost");
    if(url.pathname===`/sam3d_funscript/editors/${session}`){
        if(req.method==="POST"){
            let body="";for await(const part of req)body+=part;const sent=JSON.parse(body);
            if(sent.revision!==state.revision){res.writeHead(409);res.end("Stale revision");return;}
            state={...state,revision:state.revision+1,project:sent.project};
        }
        res.setHeader("Content-Type","application/json");res.end(JSON.stringify(state));return;
    }
    let file;
    if(url.pathname==="/sam3d_funscript/video/neutral")file=clip;
    else if(url.pathname.endsWith("viewer-standalone.html"))file=path.join(temporary,"standalone.html");
    else if(url.pathname.startsWith("/sam3d_funscript/assets/")){
        file=path.resolve(root,"assets",url.pathname.slice("/sam3d_funscript/assets/".length));
        if(!file.startsWith(root+"/assets/"))file=null;
    }
    if(!file||!fs.existsSync(file)){res.writeHead(404);res.end();return;}
    const data=fs.readFileSync(file),mime={".html":"text/html",".js":"text/javascript",".mjs":"text/javascript",".css":"text/css",".mp4":"video/mp4"};res.setHeader("Content-Type",mime[path.extname(file)]||"application/octet-stream");
    const range=req.headers.range?.match(/bytes=(\d+)-(\d*)/);
    if(range){const start=Number(range[1]),end=range[2]?Math.min(Number(range[2]),data.length-1):data.length-1;res.writeHead(206,{"Content-Range":`bytes ${start}-${end}/${data.length}`,"Accept-Ranges":"bytes","Content-Length":end-start+1});res.end(data.subarray(start,end+1));}else res.end(data);
});
await new Promise(r=>server.listen(0,"127.0.0.1",r));const base=`http://127.0.0.1:${server.address().port}`;
const profile=path.join(temporary,"chrome"),chrome=spawn("/opt/google/chrome/chrome",["--headless","--no-sandbox","--disable-dev-shm-usage","--disable-gpu","--no-first-run","--no-default-browser-check","--remote-debugging-port=0",`--user-data-dir=${profile}`,"about:blank"],{stdio:"ignore"});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){for(let i=0;i<240;i++){if(await fn())return;await pause(50);}throw new Error("Timed out: "+label);}
const sockets=[];let port;
async function page(){
    const target=await(await fetch(`http://127.0.0.1:${port}/json/new?about:blank`,{method:"PUT"})).json();
    const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener("open",r,{once:true}));sockets.push(ws);
    let next=0;const pending=new Map();
    ws.addEventListener("message",e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);if(p)m.error?p.reject(m.error):p.resolve(m.result);}else if(m.method==="Runtime.exceptionThrown")report.errors.push(m.params.exceptionDetails);});
    const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++next,timer=setTimeout(()=>{pending.delete(id);reject(new Error("CDP timeout: "+method));},15000);pending.set(id,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});ws.send(JSON.stringify({id,method,params}));});
    const evaluate=async expression=>{const r=await call("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true,userGesture:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
    const click=selector=>evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const set=(selector,value)=>evaluate(`document.querySelector(${JSON.stringify(selector)}).value=${JSON.stringify(value)};document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new Event('change'))`);
    await call("Runtime.enable");await call("Page.enable");await call("Emulation.setDeviceMetricsOverride",{width:1500,height:1180,deviceScaleFactor:1,mobile:false});
    await call("Page.navigate",{url:`${base}/sam3d_funscript/assets/viewer.html?session=${session}`});
    await until(()=>evaluate("document.querySelectorAll('#tracks .track').length===1"),"editor loaded");
    return{call,evaluate,click,set};
}
function unzip(file){
    const b=fs.readFileSync(file),files={};let p=0;
    while(b.readUInt32LE(p)===0x04034b50){assert.equal(b.readUInt16LE(p+8),0);const size=b.readUInt32LE(p+18),n=b.readUInt16LE(p+26),extra=b.readUInt16LE(p+28),name=b.toString("utf8",p+30,p+30+n),start=p+30+n+extra;files[name]=b.toString("utf8",start,start+size);p=start+size;}return files;
}
try{
    await until(()=>{try{port=fs.readFileSync(path.join(profile,"DevToolsActivePort"),"utf8").split("\n")[0];return port;}catch{return false;}},"Chrome start");
    const a=await page(),b=await page();
    async function download(page){
        const folder=fs.mkdtempSync(path.join(temporary,"download-"));await page.call("Browser.setDownloadBehavior",{behavior:"allow",downloadPath:folder});await page.click("#save");
        let archive;await until(()=>{archive=fs.readdirSync(folder).find(f=>f.endsWith(".zip"));return archive;},"offline ZIP");
        return unzip(path.join(folder,archive));
    }
    async function saved(){await a.evaluate("window.s3fFlush()");return structuredClone(state.project);}
    async function selection(start,end){await a.set("#selectionStart",String(start));await a.set("#selectionEnd",String(end));}
    const disabled=id=>a.evaluate(`document.querySelector('#${id}').disabled`);
    await a.click("#patternPanel summary");await selection(5,6.4);
    const revision=state.revision;await a.click("#previewPattern");
    assert.equal(await disabled("applyPattern"),false);assert.match(await a.evaluate("document.querySelector('#patternStatus').textContent"),/Continued before.*after/);
    assert.equal(state.revision,revision);assert.deepEqual((await saved()).scripts,original.scripts);
    await a.evaluate("document.querySelector('#patternPanel').scrollIntoView({block:'start'})");await pause(100);
    fs.writeFileSync(path.join(output,"continuation-preview.png"),Buffer.from((await a.call("Page.captureScreenshot")).data,"base64"));
    await a.click("#applyPattern");let applied=await saved();
    assert.deepEqual(applied.scripts.L0.actions,continuePattern(original.scripts.L0.actions,5000,6400).actions);
    for(const axis of ["L1","L2","R0","R1","R2"])assert.deepEqual(applied.scripts[axis],original.scripts[axis]);
    await b.evaluate("window.s3fUpdate()");assert.match(await b.evaluate("document.querySelector('#status').textContent"),/Latest/);
    assert.deepEqual(JSON.parse((await download(b))["project.json"]).scripts,applied.scripts);
    report.checks.push("Continuation previews without mutation, applies only the selected axis and synchronizes to a second editor");
    await a.click("#undo");assert.deepEqual((await saved()).scripts,original.scripts);
    await a.click("#previewPattern");await a.click("#lockMain");await saved();assert.equal(await disabled("previewPattern"),true);assert.equal(await disabled("applyPattern"),true);
    await a.click("#lockMain");await saved();
    await a.click("#previewPattern");await selection(5,6.3);assert.equal(await disabled("applyPattern"),true);
    await a.click("#previewPattern");await a.click("#tracks .track-select");assert.equal(await disabled("applyPattern"),true);
    await a.click("#selectMain");await a.click("#previewPattern");await a.set("#axis","L1");assert.equal(await disabled("applyPattern"),true);
    await a.set("#axis","L0");
    await a.click("#previewPattern");await b.evaluate("window.s3fUpdate()");await b.click("#lockMain");await b.evaluate("window.s3fFlush()");
    await a.evaluate("window.s3fUpdate()");assert.equal(await disabled("applyPattern"),true);assert.equal(await disabled("previewPattern"),true);
    await a.click("#lockMain");await saved();
    report.checks.push("Undo is exact; locks and changes of range, track or axis invalidate pending previews");
    await a.set("#patternMode","generate");await a.set("#patternShape","Triangle");await selection(3,7);await a.click("#previewPattern");
    await a.set("#patternAmplitude","25");await until(async()=>!await disabled("applyPattern"),"live preview refreshed");
    await a.click("#applyPattern");applied=await saved();
    const options={shape:"Triangle",amplitude:25,joinMs:150};
    assert.deepEqual(applied.scripts.L0.actions,generatePattern(original.scripts.L0.actions,3000,7000,options).actions);
    await a.click("#undo");await saved();await a.click("#tracks .track-select");await a.click("#previewPattern");await a.click("#applyPattern");
    applied=await saved();assert.deepEqual(applied.scripts,original.scripts);
    assert.deepEqual(applied.timeline.tracks[0].script.actions,generatePattern(original.timeline.tracks[0].script.actions,3000,7000,options).actions);
    assert.deepEqual(applied.timeline.sources,original.timeline.sources);
    await a.set("#patternCycle","0");await a.click("#previewPattern");assert.equal(await disabled("applyPattern"),true);assert.match(await a.evaluate("document.querySelector('#patternStatus').textContent"),/Cycle length/);
    assert.deepEqual((await saved()).scripts,original.scripts);
    report.checks.push("Pattern controls update a draft live; source-track application stays independent, and invalid settings cannot apply");
    await a.set("#patternCycle","2");await a.set("#patternDuration","1.2");
    await a.evaluate("document.querySelector('#video').currentTime=8");await until(()=>a.evaluate("Math.abs(Number(document.querySelector('#time').dataset.ms)-8000)<5"),"seek playhead");
    await a.click("#patternRange");assert.deepEqual(await a.evaluate("['selectionStart','selectionEnd'].map(id=>Number(document.getElementById(id).value))"),[8,9.2]);
    await a.click("#previewPattern");await a.click("#cancelPattern");assert.equal(await disabled("applyPattern"),true);
    await a.call("Emulation.setDeviceMetricsOverride",{width:560,height:1100,deviceScaleFactor:1,mobile:false});await pause(100);
    assert.equal(await a.evaluate("document.documentElement.scrollWidth<=innerWidth"),true);
    const files=await download(a),snapshot=JSON.parse(files["project.json"]);
    assert.deepEqual(JSON.parse(files["neutral.funscript"]),snapshot.scripts.L0);
    const offline=path.join(temporary,"offline.html");fs.writeFileSync(offline,files["viewer.html"]);
    assert.ok(!/^import .* from /m.test(files["viewer.html"]));
    await a.call("Page.navigate",{url:pathToFileURL(offline).href});await until(()=>a.evaluate("document.querySelectorAll('#tracks .track').length===1"),"offline roundtrip");
    await a.click("#patternPanel summary");await a.set("#patternMode","generate");await selection(8,9);await a.click("#previewPattern");assert.equal(await disabled("applyPattern"),false);await a.click("#applyPattern");
    assert.match(await a.evaluate("document.querySelector('#patternStatus').textContent"),/Applied/);
    report.checks.push("At-playhead insertion preserves timing, narrow layout fits, and exported scripts/standalone HTML retain edits and both tools");
    assert.deepEqual(report.errors,[]);fs.writeFileSync(path.join(output,"report.json"),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{
    for(const ws of sockets)ws.close();chrome.kill("SIGTERM");server.closeAllConnections();await new Promise(r=>server.close(r));
}
