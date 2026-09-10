// Offset source edges, shared cut guides and collapsible tracks: neutral data,
// a disposable server/browser, and real offline export/reopen.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn,spawnSync} from 'node:child_process';
import {copyTrackToMain} from '../assets/timeline.mjs';

const root=path.resolve('.'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'s3f-motion-tracks-'));
const output=path.resolve(process.argv[2]||'development/motion-tracks-browser');fs.mkdirSync(output,{recursive:true});
const python=process.env.S3F_TEST_PYTHON||'/media/p5/miniforge3/envs/13_env_py313/bin/python';
const generated=spawnSync(python,['-c',String.raw`
import json, sys
from copy import deepcopy
from pathlib import Path
sys.path.insert(0, 'tests')
from test_core import fixture
from sam3d_funscript.core import build_project
from sam3d_funscript.timeline import combine_projects
from sam3d_funscript.standalone import standalone_html
projects={}
for i,(start,end,anchor) in enumerate([(36145.833333,46125,'mouth'),(19041.666666,24729.166666,'left_wrist')]):
    sequence=fixture(72)
    sequence.times_ms=sequence.times_ms/2000*(end-start)+start
    sequence.metadata['duration_ms']=end+1000/48
    sequence.metadata['source']['path']='neutral-fixture.mp4'
    projects[f'project_{i}']=build_project(sequence,{'target_anchor':anchor})
project=combine_projects(projects)
project['metadata']['duration_ms']=60000
for script in project['scripts'].values(): script['actions'].append({'at':60000,'pos':50})
project['timeline'].update(active='track_0',selection_track='track_0',selection_lane='track_0',selection=[36411,46165])
target=Path(sys.argv[1]);(target/'project.json').write_text(json.dumps(project))
(target/'standalone.html').write_text(standalone_html())
`,temp],{cwd:root,encoding:'utf8'});assert.equal(generated.status,0,generated.stderr);
const editorId='a'.repeat(32),timelineId='b'.repeat(32);
let draft={revision:1,output:'fixture',project:JSON.parse(fs.readFileSync(temp+'/project.json'))};
let timeline={session:timelineId,editor_session:editorId,project:'fixture',info:{source_id:'neutral',source:draft.project.metadata.source},
    scene_cuts:{source_id:'neutral',times_ms:[5000,35000,40000.25,45000,50000]}};
let cutRequests=0;
const neutralVideo=temp+'/neutral.mp4';const encoded=spawnSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=160x120:rate=24','-t','60','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-movflags','+faststart',neutralVideo]);assert.equal(encoded.status,0,encoded.stderr.toString());
const mime={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css'};
const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://localhost');res.setHeader('Cache-Control','no-store');
    if(url.pathname===`/sam3d_funscript/editors/${editorId}`){
        if(req.method==='POST'){let body='';for await(const chunk of req)body+=chunk;const data=JSON.parse(body);assert.equal(data.revision,draft.revision);draft={...draft,revision:draft.revision+1,project:data.project};}
        res.setHeader('Content-Type','application/json');res.end(JSON.stringify(draft));return;
    }
    if(url.pathname===`/sam3d_funscript/timelines/${timelineId}`){cutRequests++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(timeline));return;}
    // A stale unversioned helper cannot supply the new exports. The import map
    // must select the matching version, including after an ordinary reload.
    if(url.pathname.endsWith('/timeline.mjs')&&!url.searchParams.has('v')){res.setHeader('Content-Type','text/javascript');res.end('export const obsoleteTimeline = true;');return;}
    if(url.pathname==='/neutral.mp4'){res.setHeader('Content-Type','video/mp4');res.end(fs.readFileSync(neutralVideo));return;}
    let file;
    if(url.pathname.endsWith('/viewer-standalone.html'))file=temp+'/standalone.html';
    else if(url.pathname==='/offline.html')file=temp+'/offline.html';
    else if(url.pathname.startsWith('/sam3d_funscript/assets/'))file=path.join(root,'assets',url.pathname.split('/assets/')[1]);
    if(!file||!fs.existsSync(file)){res.statusCode=404;res.end();return;}
    res.setHeader('Content-Type',mime[path.extname(file)]||'text/plain');res.end(fs.readFileSync(file));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
const profile=temp+'/chrome',chrome=spawn('/opt/google/chrome/chrome',['--headless','--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore'});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){for(let i=0;i<200;i++){if(await fn())return;await pause(50);}throw new Error('Timed out: '+label);}
function unzip(file){
    const buffer=fs.readFileSync(file),files={};let offset=0;
    while(buffer.readUInt32LE(offset)===0x04034b50){
        assert.equal(buffer.readUInt16LE(offset+8),0);const size=buffer.readUInt32LE(offset+18),n=buffer.readUInt16LE(offset+26),extra=buffer.readUInt16LE(offset+28);
        const name=buffer.toString('utf8',offset+30,offset+30+n),start=offset+30+n+extra;
        files[name]=buffer.toString('utf8',start,start+size);offset=start+size;
    }return files;
}
let ws;const errors=[],checks=[];
try{
    let port;await until(()=>{try{port=fs.readFileSync(profile+'/DevToolsActivePort','utf8').split('\n')[0];return port;}catch{return false;}},'Chrome startup');
    const target=(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t=>t.type==='page');
    ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));
    let next=0;const pending=new Map();
    ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(m.error):p.resolve(m.result);}else if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails);else if(m.method==='Page.javascriptDialogOpening')call('Page.handleJavaScriptDialog',{accept:true});});
    const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
    const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,userGesture:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
    const click=selector=>evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const select=(selector,value)=>evaluate(`document.querySelector(${JSON.stringify(selector)}).value=${JSON.stringify(value)};document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new Event('change'))`);
    const flush=()=>evaluate('window.s3fFlush()');
    const lane='#tracks .track:first-child';
    const range=()=>evaluate('[...document.querySelectorAll("#selectionStart,#selectionEnd")].map(el=>Number(el.value)*1000)');
    const pageURL=`${base}/sam3d_funscript/assets/viewer.html?session=${editorId}&timeline=${timelineId}`;
    await call('Runtime.enable');await call('Page.enable');await call('Emulation.setDeviceMetricsOverride',{width:1500,height:1250,deviceScaleFactor:1,mobile:false});
    await call('Page.navigate',{url:pageURL});
    await until(()=>evaluate('document.querySelectorAll("#tracks .track").length===2'),'project');
    assert.equal(await evaluate(`document.querySelector('${lane} .copy-selection').disabled`),true);
    await click(lane+' .select-track-range');assert.deepEqual(await range(),[36146,46146]);
    await select('#selectionStart','36.411');await select('#selectionEnd','46.165');
    assert.deepEqual(await range(),[36411,46146]);assert.equal(await evaluate(`document.querySelector('${lane} .copy-selection').disabled`),false);
    await until(()=>evaluate('document.querySelector("#sceneCutCount").textContent==="5 cuts"'),'linked cut scan');await flush();
    const before=structuredClone(draft.project),expected=structuredClone(before);
    copyTrackToMain(expected,expected.timeline.tracks[0],{start:36411,end:46146,blendMs:200});
    await click(lane+' .copy-selection');await flush();assert.deepEqual(draft.project.scripts,expected.scripts);
    await click('#undo');await flush();assert.deepEqual(draft.project.scripts,before.scripts);
    checks.push('19 ms overshoot clamps to the source edge; exact row range, six-axis copy, outside motion and Undo');

    await click('#selectMain');await select('#selectionStart','35');await select('#selectionEnd','50');
    assert.deepEqual(await range(),[35000,50000]);assert.equal(await evaluate(`document.querySelector('${lane} .copy-selection').disabled`),true);
    await select('#zoom','0');
    await evaluate(`document.querySelector('${lane} canvas').scrollIntoView({block:'center'})`);
    const rect=await evaluate(`(()=>{const r=document.querySelector('${lane} canvas').getBoundingClientRect();return {x:r.left,y:r.top,w:r.width,h:r.height};})()`);
    const x=t=>rect.x+42+t/60000*(rect.w-54),y=rect.y+rect.h/2;
    for(const event of [{type:'mousePressed',x:x(36411),buttons:1},{type:'mouseMoved',x:x(46165),buttons:1},{type:'mouseReleased',x:x(46165),buttons:0}])
        await call('Input.dispatchMouseEvent',{...event,y,button:'left',clickCount:1,modifiers:8});
    assert.ok(Math.abs((await range())[0]-36411)<2);assert.equal((await range())[1],46146);
    checks.push('Main selection remains independent and strict; actual Shift-drag stops at offset source end');

    // The same diamond is painted at the same time on main and every source.
    const markerPixels=()=>evaluate(`['#curve','#tracks .track:first-child canvas','#tracks .track:last-child canvas'].map(s=>{const c=document.querySelector(s),r=c.getBoundingClientRect(),x=42+40000.25/60000*(r.width-54);return [...c.getContext('2d').getImageData(Math.round(x),5,1,1).data]})`);
    assert.deepEqual(await markerPixels(),Array(3).fill([217,197,126,255]));
    await click('#showSceneCuts');assert.ok((await markerPixels()).every(p=>p[0]!==217));await click('#showSceneCuts');
    await call('Input.dispatchMouseEvent',{type:'mousePressed',x:x(40000.25),y:rect.y+5,button:'left',buttons:1,clickCount:1});
    await call('Input.dispatchMouseEvent',{type:'mouseReleased',x:x(40000.25),y:rect.y+5,button:'left',buttons:0,clickCount:1});
    assert.equal(await evaluate('Number(document.querySelector("#time").dataset.ms)'),40000.25);
    checks.push('Detected gold markers align on all curves, toggle visibility and seek at their exact timestamp');

    await click(lane+' .track-lock');await click(lane+' .collapse-track');await click('#collapseMain');await flush();
    assert.equal(draft.project.timeline.tracks[0].collapsed,true);assert.equal(draft.project.timeline.tracks[0].locked,true);
    assert.equal(draft.project.preview.main_collapsed,true);
    assert.equal(await evaluate(`document.querySelector('${lane} canvas').getBoundingClientRect().height`),0);
    assert.equal(await evaluate(`document.querySelector('${lane} .collapse-track').getAttribute('aria-expanded')`),'false');
    await call('Page.navigate',{url:pageURL});await until(()=>evaluate('document.querySelector("#tracks .track.collapsed")!==null'),'collapsed reopen');
    assert.equal(await evaluate('document.querySelector("#curve").getBoundingClientRect().height'),0);
    await click(lane+' .select-track-range');assert.equal(await evaluate(`document.querySelector('${lane} .copy-selection').disabled`),false);
    checks.push('Locked tracks can collapse and select ranges; collapsed source and main persist through server save/reopen');

    // Wrong owner/source scans must never replace this video's saved markers.
    await flush();const savedCuts=structuredClone(draft.project.metadata.scene_cuts),oldRequest=cutRequests;
    timeline.editor_session='c'.repeat(32);timeline.scene_cuts.times_ms=[7000];
    await evaluate('window.dispatchEvent(new Event("focus"))');await until(()=>cutRequests>oldRequest,'wrong owner read');await pause(100);await flush();
    assert.deepEqual(draft.project.metadata.scene_cuts,savedCuts);
    timeline.editor_session=editorId;timeline.info.source={path:'other.mp4'};
    await evaluate('window.dispatchEvent(new Event("focus"))');await pause(150);await flush();assert.deepEqual(draft.project.metadata.scene_cuts,savedCuts);
    timeline.info.source=before.metadata.source;timeline.scene_cuts.times_ms=[40000.25,45000];
    await evaluate('window.dispatchEvent(new Event("focus"))');await until(()=>evaluate('document.querySelector("#sceneCutCount").textContent==="2 cuts"'),'updated scan');await flush();
    checks.push('Fresh scans update without pose rerun; unrelated editor/video scans cannot replace saved guides');

    const downloads=temp+'/downloads';fs.mkdirSync(downloads);await call('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloads});
    await click('#save');let zip;await until(()=>{zip=fs.readdirSync(downloads).find(n=>n.endsWith('.zip'));return zip;},'offline ZIP');
    const files=unzip(downloads+'/'+zip);fs.writeFileSync(temp+'/offline.html',files['viewer.html']);
    const exported=JSON.parse(files['project.json']);assert.equal(exported.timeline.tracks[0].collapsed,true);
    assert.deepEqual(exported.metadata.scene_cuts.times_ms,[40000.25,45000]);
    await call('Page.navigate',{url:base+'/offline.html'});await until(()=>evaluate('document.querySelectorAll("#tracks .track").length===2'),'offline project');
    assert.equal(await evaluate('document.querySelector("#sceneCutCount").textContent'),'2 cuts');
    assert.equal(await evaluate(`document.querySelector('${lane} canvas').getBoundingClientRect().height`),0);
    await click(lane+' .collapse-track');await click('#collapseMain');
    assert.ok(await evaluate(`document.querySelector('${lane} canvas').getBoundingClientRect().height>0`));
    await evaluate('document.querySelector(".curves").scrollIntoView({block:"start"})');
    fs.writeFileSync(output+'/tracks.png',Buffer.from((await call('Page.captureScreenshot')).data,'base64'));
    await call('Emulation.setDeviceMetricsOverride',{width:560,height:1100,deviceScaleFactor:1,mobile:false});await pause(100);
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
    fs.writeFileSync(output+'/narrow.png',Buffer.from((await call('Page.captureScreenshot')).data,'base64'));
    checks.push('Offline ZIP reopens with saved guides and collapsed state; expand works and narrow layout fits');
    // Video stays in the same DOM node while floating, dragging and resizing.
    await call('Emulation.setDeviceMetricsOverride',{width:1500,height:1000,deviceScaleFactor:1,mobile:false});
    assert.deepEqual(await evaluate('[...document.querySelector(".stage").children].map(e=>e.querySelector("video,#robot,#skeleton")?.id)'),['video','robot','skeleton']);
    await evaluate(`(async()=>{const file=new File([await(await fetch('/neutral.mp4')).blob()],'neutral.mp4',{type:'video/mp4'}),dt=new DataTransfer();dt.items.add(file);document.querySelector('#videoFile').files=dt.files;document.querySelector('#videoFile').dispatchEvent(new Event('change'));})()`);
    await until(()=>evaluate('document.querySelector("#video").readyState>=2&&!document.querySelector("#video").seeking'),'neutral playback video');
    await evaluate('window.originalVideo=document.querySelector("#video");window.mediaReloads=0;originalVideo.addEventListener("loadstart",()=>window.mediaReloads++);window.scrollTo(0,0)');
    await click('#floatVideo');
    const floatingBounds=()=>evaluate('(()=>{const r=document.querySelector("#videoPanel").getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()');
    const startRect=await floatingBounds();
    await evaluate('window.scrollTo(0,700)');assert.deepEqual(await floatingBounds(),startRect,'floating panel stays next to visible tracks');
    const grip=await evaluate('(()=>{const r=document.querySelector("#videoGrip h2").getBoundingClientRect();return {x:r.left+10,y:r.top+5}})()');
    for(const [type,x,y,buttons]of [['mousePressed',grip.x,grip.y,1],['mouseMoved',grip.x+260,grip.y-120,1],['mouseReleased',grip.x+260,grip.y-120,0]])await call('Input.dispatchMouseEvent',{type,x,y,button:'left',buttons,clickCount:1});
    assert.ok((await floatingBounds()).x>startRect.x+200,'drag moves the preview');
    await evaluate('document.querySelector("#videoResize").dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowRight",shiftKey:true,bubbles:true}))');
    assert.equal((await floatingBounds()).width,startRect.width+40);
    assert.equal(await evaluate('document.querySelector("#video")===window.originalVideo&&window.mediaReloads===0'),true,'floating never reloads media');
    await call('Emulation.setDeviceMetricsOverride',{width:360,height:600,deviceScaleFactor:1,mobile:false});await pause(100);
    const small=await floatingBounds();assert.ok(small.x>=0&&small.x+small.width<=360&&small.y>=0&&small.y+small.height<=600,'floating window is kept reachable on small screens');
    await call('Emulation.setDeviceMetricsOverride',{width:1500,height:1000,deviceScaleFactor:1,mobile:false});
    // Looping uses the shared selection and the video clock; it never changes curves.
    await click('#selectMain');await select('#selectionStart','2');await select('#selectionEnd','2.6');
    await click('#loopSelection');await click('#playSelection');
    await until(()=>evaluate('!document.querySelector("#video").paused&&!document.querySelector("#video").seeking'),'selection playing');
    await pause(1450);
    const loop=await evaluate('({time:document.querySelector("#video").currentTime,paused:document.querySelector("#video").paused,curveTime:Number(document.querySelector("#time").dataset.ms)})');
    assert.ok(!loop.paused&&loop.time>=2&&loop.time<2.65,JSON.stringify(loop));assert.ok(loop.curveTime>=2000&&loop.curveTime<2650);
    await evaluate('document.querySelector("#video").pause()');await pause(100);assert.equal(await evaluate('document.querySelector("#video").paused'),true);
    await click('#loopSelection');await click('#playSelection');
    await until(()=>evaluate('document.querySelector("#video").paused&&document.querySelector("#video").currentTime>=2.59'),'play selection once stops at Out');
    await select('#selectionStart','59.5');await select('#selectionEnd','60');await click('#loopSelection');await click('#playSelection');await pause(1300);
    assert.ok(await evaluate('!document.querySelector("#video").paused&&document.querySelector("#video").currentTime>=59.5&&document.querySelector("#video").currentTime<=60'),'selection ending at EOF keeps looping');
    await evaluate('document.querySelector("#video").pause()');
    await select('#selectionStart','60');assert.equal(await evaluate('document.querySelector("#loopSelection").disabled'),true,'empty selection does not loop');
    await select('#selectionStart','36.5');await select('#selectionEnd','39');
    await evaluate('document.querySelector("#tracks").scrollIntoView({block:"start"})');
    fs.writeFileSync(output+'/floating-video.png',Buffer.from((await call('Page.captureScreenshot')).data,'base64'));
    await click('#floatVideo');assert.equal(await evaluate('document.querySelector("#videoPanel").classList.contains("floating")'),false);
    assert.equal(await evaluate('window.mediaReloads'),0,'docking preserves media as well');
    checks.push('Device before body; floating video drag/resize/dock preserves playback; selection loop and one-pass playback, including EOF and empty ranges');
    assert.deepEqual(errors,[]);fs.writeFileSync(output+'/report.json',JSON.stringify({checks,errors},null,2));console.log(JSON.stringify({checks,errors},null,2));
}finally{ws?.close();chrome.kill('SIGTERM');await new Promise(r=>server.close(r));}
