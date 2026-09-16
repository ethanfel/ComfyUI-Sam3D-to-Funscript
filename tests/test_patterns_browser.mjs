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
from sam3d_funscript.editor import blank_project
from sam3d_funscript.standalone import standalone_html
s=fixture();s.times_ms*=6;s.metadata['duration_ms']=12000
p=build_project(s);p['metadata']['source']={'path':'neutral.mp4'}
p['scripts']['L0']['actions']=[{'at':i*10,'pos':50 if 5000<i*10<6400 else round(50+35*math.sin(i*10/900*2*math.pi))} for i in range(1201)]
Path(sys.argv[1],'project.json').write_text(json.dumps(p))
Path(sys.argv[1],'blank.json').write_text(json.dumps(blank_project({**p['metadata'],'duration_ms':12000+2/3})))
Path(sys.argv[1],'standalone.html').write_text(standalone_html())
`,temporary],{cwd:root});assert.equal(fixture.status,0,fixture.stderr.toString());
const original=JSON.parse(fs.readFileSync(path.join(temporary,"project.json")));initializeTimeline(original);
const blank=JSON.parse(fs.readFileSync(path.join(temporary,'blank.json')));
const audioPath=path.join(temporary,'drums.wav'),audioRate=11025,pcm=Buffer.alloc(44+audioRate*12*2);
pcm.write('RIFF');pcm.writeUInt32LE(pcm.length-8,4);pcm.write('WAVEfmt ',8);pcm.writeUInt32LE(16,16);pcm.writeUInt16LE(1,20);pcm.writeUInt16LE(1,22);
pcm.writeUInt32LE(audioRate,24);pcm.writeUInt32LE(audioRate*2,28);pcm.writeUInt16LE(2,32);pcm.writeUInt16LE(16,34);pcm.write('data',36);pcm.writeUInt32LE(pcm.length-44,40);
for(let i=0;i<audioRate*12;i++){const t=(i/audioRate)%.5;pcm.writeInt16LE(Math.round(26000*Math.sin(t*2*Math.PI*90)*Math.exp(-t*45)),44+i*2);}
fs.writeFileSync(audioPath,pcm);
const mixPath=path.join(temporary,'full-mix.wav'),mixPCM=Buffer.from(pcm);
for(let i=0;i<audioRate*12;i++)mixPCM.writeInt16LE(Math.round(22000*Math.sin(i/audioRate*2*Math.PI*440)*(.25+.6*i/(audioRate*12))),44+i*2);
fs.writeFileSync(mixPath,mixPCM);
const clip=path.join(temporary,"neutral.mp4"), ffmpeg=spawnSync("ffmpeg",["-v","error","-f","lavfi","-i","color=c=slateblue:s=160x120:r=10:d=12","-i",mixPath,"-c:v","libx264","-c:a","aac","-pix_fmt","yuv420p","-movflags","+faststart",clip]);assert.equal(ffmpeg.status,0,ffmpeg.stderr.toString());
let state={revision:1,project:structuredClone(original),output:"neutral"};
let audioResponse='ok',heldAudio=null;const audioRequests=[];
let timelineState=null;
const session="1234567890abcdef1234567890abcdef",report={checks:[],errors:[]};
const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,"http://localhost");
    if(url.pathname==='/sam3d_funscript/timelines/'+'a'.repeat(32)){
        res.setHeader('Content-Type','application/json');res.end(JSON.stringify(timelineState));return;
    }
    if(url.pathname==='/sam3d_funscript/assets/processing-timeline.html'){
        res.setHeader('Content-Type','text/html');res.end('<p>New video Timeline</p>');return;
    }
    if(url.pathname==='/sam3d_funscript/video/neutral/audio'){
        audioRequests.push(url.searchParams.get('variant'));
        if(audioResponse==='hold'){heldAudio=res;return;}
        if(audioResponse==='silent'){res.writeHead(400);res.end('This video has no audio track. Choose a full-mix audio file instead.');return;}
        res.writeHead(200,{'Content-Type':'audio/wav','X-S3F-Audio-Start-Ms':'1600','X-S3F-Audio-Name':'neutral.mp4'});res.end(mixPCM);return;
    }
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
    else if(url.pathname==='/test-drums.wav')file=audioPath;
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
    async function loadAudio(file,selector='#beatFile'){
        const info=selector==='#beatFile'?'#beatAudioInfo':'#beatMixInfo';
        const doc=await a.call('DOM.getDocument'),node=await a.call('DOM.querySelector',{nodeId:doc.root.nodeId,selector});
        await a.call('DOM.setFileInputFiles',{nodeId:node.nodeId,files:[file]});
        await until(()=>a.evaluate(`document.querySelector(${JSON.stringify(info)}).textContent.includes(${JSON.stringify(path.basename(file))}) && document.querySelector('#beatCancelAnalysis').hidden`),'audio decoded and analyzed');
    }
    const disabled=id=>a.evaluate(`document.querySelector('#${id}').disabled`);
    const spaceKey={key:' ',code:'Space',windowsVirtualKeyCode:32,nativeVirtualKeyCode:32};
    async function pressSpace(page,modifiers=0){
        await page.call('Input.dispatchKeyEvent',{type:'keyDown',...spaceKey,modifiers,text:modifiers?'':' '});
        await page.call('Input.dispatchKeyEvent',{type:'keyUp',...spaceKey,modifiers});
    }
    await a.call('Page.bringToFront');
    await until(()=>a.evaluate("document.querySelector('#video').readyState>=2"),'video ready for keyboard playback');
    for(const selector of ['#curve','#sectionCurve','#tracks canvas','#beatCurve']){
        await a.set('#sourceLayout',selector==='#tracks canvas'?'rows':'sections');
        const point=await a.evaluate(`(()=>{const c=document.querySelector(${JSON.stringify(selector)});c.scrollIntoView({block:'center'});const r=c.getBoundingClientRect();return{x:r.left+r.width*.4,y:r.top+r.height*.6};})()`);
        await a.call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});
        await a.call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});
        assert.equal(await a.evaluate(`document.activeElement===document.querySelector(${JSON.stringify(selector)})`),true);
        await until(()=>a.evaluate("!document.querySelector('#video').seeking"),'timeline seek');
        const scroll=await a.evaluate('scrollY');
        await pressSpace(a);
        await until(()=>a.evaluate("!document.querySelector('#video').paused"),selector+' starts playback');
        await a.call('Input.dispatchKeyEvent',{type:'keyDown',...spaceKey,autoRepeat:true});
        assert.equal(await a.evaluate("document.querySelector('#video').paused"),false,'Holding Space must not toggle repeatedly');
        await a.call('Input.dispatchKeyEvent',{type:'keyUp',...spaceKey});
        await pressSpace(a);
        assert.equal(await a.evaluate("document.querySelector('#video').paused"),true,selector+' pauses playback');
        assert.equal(await a.evaluate('scrollY'),scroll,'Space must not scroll the page');
    }
    await a.set('#sourceLayout','sections');await a.click('#selectMain');
    await a.evaluate("document.querySelector('#selectionStart').focus()");await pressSpace(a);
    assert.equal(await a.evaluate("document.querySelector('#video').paused"),true,'Numeric inputs keep normal keys');
    await a.evaluate("const t=document.createElement('div');t.id='keyboardText';t.contentEditable='true';t.textContent='edit';document.body.append(t);t.focus()");
    await pressSpace(a);assert.equal(await a.evaluate("document.querySelector('#video').paused"),true,'Typing in editable text must not start playback');
    await a.evaluate("document.querySelector('#keyboardText').remove();document.querySelector('#curve').focus({preventScroll:true})");
    await pressSpace(a,2);assert.equal(await a.evaluate("document.querySelector('#video').paused"),true,'Ctrl+Space is not playback');
    const wasOpen=await a.evaluate("document.querySelector('#patternPanel').open");
    await a.evaluate("document.querySelector('#patternPanel summary').focus()");await pressSpace(a);
    assert.equal(await a.evaluate("document.querySelector('#patternPanel').open"),!wasOpen,'Space still opens a focused disclosure');
    assert.equal(await a.evaluate("document.querySelector('#video').paused"),true);
    await a.evaluate(`document.querySelector('#patternPanel').open=${wasOpen};document.querySelector('#video').focus()`);
    await pressSpace(a);await until(()=>a.evaluate("!document.querySelector('#video').paused"),'native video Space');
    await pressSpace(a);assert.equal(await a.evaluate("document.querySelector('#video').paused"),true,'Native video controls toggle exactly once');
    report.checks.push('Space plays and pauses from clicked Main, compact Source, row Source and Audio timelines; repeats do not toggle, the page stays still, and native controls/text retain their keys');
    await a.click("#patternPanel summary");await selection(5,6.4);
    const revision=state.revision;await a.click("#previewPattern");
    assert.equal(await disabled("applyPattern"),false);assert.match(await a.evaluate("document.querySelector('#patternStatus').textContent"),/Continued before.*after/);
    assert.equal(state.revision,revision);assert.deepEqual((await saved()).scripts,original.scripts);
    await a.call('Page.bringToFront');await a.evaluate("document.querySelector('#patternPanel').scrollIntoView({block:'start'})");await pause(100);
    fs.writeFileSync(path.join(output,"continuation-preview.png"),Buffer.from((await a.call("Page.captureScreenshot")).data,"base64"));
    await a.click("#applyPattern");let applied=await saved();
    assert.deepEqual(applied.scripts.L0.actions,continuePattern(original.scripts.L0.actions,5000,6400).actions);
    for(const axis of ["L1","L2","R0","R1","R2"])assert.deepEqual(applied.scripts[axis],original.scripts[axis]);
    await b.evaluate("window.s3fUpdate()");assert.match(await b.evaluate("document.querySelector('#status').textContent"),/Latest/);
    assert.deepEqual(JSON.parse((await download(b))["project.json"]).scripts,applied.scripts);
    report.checks.push("Continuation previews without mutation, applies only the selected axis and synchronizes to a second editor");
    await a.click("#undo");assert.deepEqual((await saved()).scripts,original.scripts);
    const quiet=Array.from({length:1201},(_,i)=>({at:i*10,pos:i*10<=3000?Math.round(50+35*Math.sin(i/100*2*Math.PI)):50}));
    state.project.scripts.L0.actions=quiet;state.revision++;await a.evaluate('window.s3fUpdate()');
    await a.click('#previewPattern');assert.equal(await disabled('applyPattern'),false);
    assert.match(await a.evaluate("document.querySelector('#patternStatus').textContent"),/context 1.000–3.000 s/);
    assert.deepEqual(state.project.scripts.L0.actions,quiet,'preview does not save changes');
    await a.click('#applyPattern');await saved();
    assert.deepEqual(state.project.scripts.L0.actions,continuePattern(quiet,5000,6400).actions);
    await a.click('#removePattern');assert.deepEqual((await saved()).scripts.L0.actions,quiet);
    state.project.timeline.tracks[0].window=[4000,8000];state.revision++;await a.evaluate('window.s3fUpdate()');
    await a.click('#tracks .track-select');await selection(4,8);await a.click('#previewPattern');
    assert.equal(await disabled('applyPattern'),true);
    assert.match(await a.evaluate("document.querySelector('#patternStatus').textContent"),/before: 0.00 s.*after: 0.00 s.*smaller gap/);
    await saved();state.project=structuredClone(original);state.revision++;await a.evaluate('window.s3fUpdate()');
    await a.click('#selectMain');await selection(5,6.4);await saved();
    report.checks.push('Short exterior rhythms survive flat tails; exact context is shown; apply/removal preserve curves; whole-source selections explain absent context');
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
    await a.set("#patternMode","generate");
    assert.equal(await a.evaluate("document.querySelector('#patternBlendEdges').checked"),false);
    assert.equal(await disabled("patternJoin"),true);
    await a.click("#patternBlendEdges");await a.set("#patternJoin","500");
    await a.set("#patternMode","continue");assert.equal(await a.evaluate("document.querySelector('#patternJoin').value"),"150");
    await a.set("#patternMode","generate");assert.equal(await a.evaluate("document.querySelector('#patternJoin').value"),"500");
    await a.click("#patternBlendEdges");
    await a.set("#patternShape","Triangle");await selection(3,7);await a.click("#previewPattern");
    await a.set("#patternAmplitude","25");await until(async()=>!await disabled("applyPattern"),"live preview refreshed");
    await a.click("#applyPattern");applied=await saved();
    const options={shape:"Triangle",amplitude:25,joinMs:0};
    assert.deepEqual(applied.scripts.L0.actions,generatePattern(original.scripts.L0.actions,3000,7000,options).actions);
    assert.equal(applied.scripts.L0.actions.find(p=>p.at===7000).pos,25,'Waveform reaches its own endpoint instead of returning to the old curve');
    assert.equal(applied.timeline.main.L0.patterns.length,1);assert.equal(await disabled("removePattern"),false);
    await a.click("#removePattern");assert.deepEqual((await saved()).scripts,original.scripts);
    await b.evaluate("window.s3fUpdate()");assert.equal(await b.evaluate("document.querySelector('#removePattern').disabled"),true);
    await a.click("#undo");assert.deepEqual((await saved()).scripts,applied.scripts);
    report.checks.push("Generate defaults to unblended edges; each tool remembers its blend settings; applied patterns restore their original sections and removal can be undone/shared");
    await a.click("#undo");await saved();await a.click("#tracks .track-select");await a.click("#previewPattern");await a.click("#applyPattern");
    applied=await saved();assert.deepEqual(applied.scripts,original.scripts);
    assert.deepEqual(applied.timeline.tracks[0].script.actions,generatePattern(original.timeline.tracks[0].script.actions,3000,7000,options).actions);
    assert.deepEqual(applied.timeline.sources,original.timeline.sources);
    await a.click("#tracks .track-lock");await saved();assert.equal(await disabled("removePattern"),true);
    await a.click("#tracks .track-lock");await saved();assert.equal(await disabled("removePattern"),false);
    await a.set("#patternCycle","0");await a.click("#previewPattern");assert.equal(await disabled("applyPattern"),true);assert.match(await a.evaluate("document.querySelector('#patternStatus').textContent"),/Cycle length/);
    assert.deepEqual((await saved()).scripts,original.scripts);
    report.checks.push("Pattern controls update a draft live; source-track application stays independent, and invalid settings cannot apply");
    await a.set("#patternCycle","2");await a.set("#patternDuration","1.2");
    await a.evaluate("document.querySelector('#video').currentTime=8");await until(()=>a.evaluate("Math.abs(Number(document.querySelector('#time').dataset.ms)-8000)<5"),"seek playhead");
    await a.click("#patternRange");assert.deepEqual(await a.evaluate("['selectionStart','selectionEnd'].map(id=>Number(document.getElementById(id).value))"),[8,9.2]);
    await a.click("#previewPattern");await a.click("#cancelPattern");assert.equal(await disabled("applyPattern"),true);
    const beforeAudio=await saved();await loadAudio(audioPath);
    let audioProject=await saved();assert.deepEqual(audioProject.scripts,beforeAudio.scripts);
    assert.deepEqual(await a.evaluate("['beatTiming','beatLanding','beatCycle'].map(id=>document.getElementById(id).value)"),['hits','down','1']);
    assert.equal(audioProject.audio_patterns.analysis.version,2);
    assert.ok(audioProject.audio_patterns.analysis.onsets.every(hit=>Number.isFinite(hit.peak_at)));
    assert.ok(Math.abs(audioProject.audio_patterns.analysis.bpm-120)<4);
    await a.click('#selectMain');await selection(3,7);await a.set('#beatMode','manual');await a.set('#beatShape','Double Tap');
    await a.click('#beatPreview');assert.equal(await disabled('beatSave'),false);
    assert.equal((await saved()).audio_patterns.sections.length,0,'Preview remains local');
    await a.click('#beatSave');audioProject=await saved();assert.equal(audioProject.audio_patterns.sections.length,1);
    assert.equal(audioProject.audio_patterns.sections[0].settings.beatLanding,'down');
    assert.deepEqual(audioProject.scripts,beforeAudio.scripts,'Saved audio blocks do not edit Main');
    const savedAudio=structuredClone(audioProject.audio_patterns);
    await a.click('#lockMain');assert.equal(await disabled('beatCopy'),true);await a.click('#lockMain');
    await a.click('#beatCopy');audioProject=await saved();assert.notDeepEqual(audioProject.scripts.L0,beforeAudio.scripts.L0);
    for(const axis of ['L1','L2','R0','R1','R2'])assert.deepEqual(audioProject.scripts[axis],beforeAudio.scripts[axis]);
    assert.deepEqual(audioProject.timeline.tracks,beforeAudio.timeline.tracks);
    await a.click('#undo');assert.deepEqual((await saved()).scripts,beforeAudio.scripts);
    await a.click('#beatCopy');await a.click('#removePattern');assert.deepEqual((await saved()).scripts,beforeAudio.scripts);
    await a.click('#beatRemove');assert.equal((await saved()).audio_patterns.sections.length,0);
    await a.click('#undo');assert.deepEqual((await saved()).audio_patterns,savedAudio);
    await a.set('#beatSection','beat_0');await a.set('#beatMode','random');await a.click('#beatShuffle');
    assert.equal(await disabled('beatSave'),false);assert.match(await a.evaluate("document.querySelector('#beatStatus').textContent"),/Random/);
    await a.click('#beatDiscard');await a.set('#beatSection','beat_0');
    state.project.metadata.source_origin_ms=1000;state.revision++;await a.evaluate('window.s3fUpdate()');
    await a.click('#beatFromVideo');await until(()=>a.evaluate("document.querySelector('#beatStatus').textContent.startsWith('Video soundtrack loaded')"),'video soundtrack loaded');
    let fromVideo=await saved();
    assert.equal(fromVideo.audio_patterns.mix.offset_ms,600,'Audio PTS minus video origin aligns on the project clock');
    assert.deepEqual(fromVideo.audio_patterns.analysis,savedAudio.analysis);
    assert.deepEqual(fromVideo.audio_patterns.sections,savedAudio.sections);
    assert.deepEqual(fromVideo.scripts,beforeAudio.scripts);
    assert.equal(audioRequests.at(-1),'stabilized');
    audioResponse='silent';await a.click('#beatFromVideo');
    await until(()=>a.evaluate("document.querySelector('#beatStatus').textContent.includes('no audio track')"),'silent video message');
    assert.deepEqual((await saved()).audio_patterns,fromVideo.audio_patterns,'A failed import preserves both inputs and saved blocks');
    audioResponse='hold';await a.click('#beatFromVideo');await until(()=>!!heldAudio,'pending soundtrack request');
    await a.click('#beatCancelAnalysis');await until(()=>a.evaluate("document.querySelector('#beatCancelAnalysis').hidden"),'cancelled request');
    heldAudio.end();heldAudio=null;audioResponse='ok';
    assert.deepEqual((await saved()).audio_patterns,fromVideo.audio_patterns,'Cancelled imports leave the previous analysis intact');
    state.project.metadata.reference_stabilization={source_offset_ms:4000,image_size:[120,160],times_ms:[0,12000],shift_xy:[[0,0],[0,0]],padding_xy:[0,0]};
    state.revision++;await a.evaluate('window.s3fUpdate()');await a.click('#beatFromVideo');
    await until(()=>a.evaluate("document.querySelector('#beatStatus').textContent.startsWith('Video soundtrack loaded')"),'original soundtrack loaded');
    assert.equal((await saved()).audio_patterns.mix.offset_ms,-2400);
    assert.equal(audioRequests.at(-1),'original','Silent stabilized renders use the original soundtrack');
    state.project=structuredClone(beforeAudio);state.project.audio_patterns=structuredClone(savedAudio);state.revision++;
    await a.call('Page.reload');await until(()=>a.evaluate("document.querySelectorAll('#tracks .track').length===1"),'reset video mapping');
    await a.set('#beatSection','beat_0');
    report.checks.push('Video soundtrack imports align to audio/video timestamps and stabilized-source offsets; silent videos and cancelled reads preserve drum analysis, saved patterns and Main');
    await loadAudio(mixPath,'#beatMixFile');audioProject=await saved();
    assert.deepEqual(audioProject.audio_patterns.analysis,savedAudio.analysis,'Full mix does not replace the drum analysis');
    assert.deepEqual(audioProject.audio_patterns.sections,savedAudio.sections,'Import preserves saved curves');
    assert.equal(await a.evaluate("document.querySelector('#beatUseMix').checked"),true);
    await a.set('#beatMixOffset','125');assert.equal((await saved()).audio_patterns.mix.offset_ms,125);
    assert.deepEqual(state.project.audio_patterns.analysis,savedAudio.analysis);
    await a.click('#undo');assert.equal((await saved()).audio_patterns.mix.offset_ms,0);
    await a.set('#beatMode','suggest');await a.click('#beatPreview');await a.click('#beatSave');audioProject=await saved();
    assert.equal(audioProject.audio_patterns.sections[0].settings.association,'dual');
    assert.ok(audioProject.audio_patterns.sections[0].decisions.some(d=>d.source==='dual'));
    assert.equal(await a.evaluate("document.querySelector('#beatExplanation').hidden"),false);
    assert.deepEqual(audioProject.scripts,beforeAudio.scripts);
    const dualAudio=structuredClone(audioProject.audio_patterns);
    await a.click('#beatRemoveMix');audioProject=await saved();assert.equal(audioProject.audio_patterns.mix,undefined);
    assert.deepEqual(audioProject.audio_patterns.sections,dualAudio.sections);
    await a.click('#undo');assert.deepEqual((await saved()).audio_patterns,dualAudio);
    assert.equal(await a.evaluate("document.querySelector('#beatUseMix').checked"),true,'Undo restores use of the full mix');
    await a.set('#beatSection','beat_0');
    await b.evaluate('window.s3fUpdate()');assert.equal(await b.evaluate("document.querySelector('#beatSection').options.length"),2);
    assert.match(await b.evaluate("document.querySelector('#beatMixInfo').textContent"),/full-mix.wav/);
    await a.evaluate("document.querySelector('#beatLane').scrollIntoView({block:'start'})");await pause(100);
    fs.writeFileSync(path.join(output,'audio-beat-lane.png'),Buffer.from((await a.call('Page.captureScreenshot')).data,'base64'));
    await a.click('#tracks .track-select');
    report.checks.push('Drum audio decodes locally; beat blocks save independently, obey Main locks, copy only the chosen axis, support Undo/removal/random preview and synchronize between editors');
    report.checks.push('Full mix has independent alignment, leaves drum timing and saved blocks intact, explains dual suggestions, and supports removal/Undo and linked views');
    await a.call("Emulation.setDeviceMetricsOverride",{width:560,height:1100,deviceScaleFactor:1,mobile:false});await pause(100);
    assert.equal(await a.evaluate("document.documentElement.scrollWidth<=innerWidth"),true);
    const files=await download(a),snapshot=JSON.parse(files["project.json"]);
    assert.deepEqual(JSON.parse(files["neutral.funscript"]),snapshot.scripts.L0);
    const offline=path.join(temporary,"offline.html");fs.writeFileSync(offline,files["viewer.html"]);
    assert.ok(!/^import .* from /m.test(files["viewer.html"]));
    await saved();
    await a.call("Page.navigate",{url:pathToFileURL(offline).href});await until(()=>a.evaluate("document.querySelectorAll('#tracks .track').length===1"),"offline roundtrip");
    assert.match(await a.evaluate("document.querySelector('#beatAudioInfo').textContent"),/drums.wav/);
    assert.match(await a.evaluate("document.querySelector('#beatMixInfo').textContent"),/full-mix.wav/);
    assert.equal(await a.evaluate("document.querySelector('#beatSection').options.length"),2);
    assert.equal(await disabled('beatFromVideo'),true,'An offline viewer needs its local video');
    const videoDoc=await a.call('DOM.getDocument'),videoInput=await a.call('DOM.querySelector',{nodeId:videoDoc.root.nodeId,selector:'#videoFile'});
    await a.call('DOM.setFileInputFiles',{nodeId:videoInput.nodeId,files:[clip]});
    await until(async()=>!await disabled('beatFromVideo'),'local video available');await a.click('#beatFromVideo');
    await until(()=>a.evaluate("document.querySelector('#beatStatus').textContent.startsWith('Video soundtrack loaded')"),'offline video soundtrack');
    const offlineAudio=JSON.parse((await download(a))['project.json']).audio_patterns;
    assert.equal(offlineAudio.mix.name,'neutral.mp4');assert.equal(offlineAudio.mix.offset_ms,0);
    assert.deepEqual(offlineAudio.analysis,snapshot.audio_patterns.analysis);assert.deepEqual(offlineAudio.sections,snapshot.audio_patterns.sections);
    report.checks.push('Offline viewer analyzes its local video audio without an upload or server connection');
    await a.set('#beatSection','beat_0');await a.click('#beatPreview');assert.equal(await disabled('beatSave'),false);
    await a.click('#beatDiscard');await a.click('#tracks .track-select');
    assert.equal(await disabled("removePattern"),false,'Saved pattern remains removable after reopening without Undo history');
    await a.click("#patternPanel summary");await a.set("#patternMode","generate");await selection(8,9);await a.click("#previewPattern");assert.equal(await disabled("applyPattern"),false);await a.click("#applyPattern");
    assert.match(await a.evaluate("document.querySelector('#patternStatus').textContent"),/Applied/);
    await a.click("#removePattern");let restored=JSON.parse((await download(a))["project.json"]);
    assert.deepEqual(restored.timeline.tracks[0].script,snapshot.timeline.tracks[0].script);
    await a.click("#removePattern");restored=JSON.parse((await download(a))["project.json"]);
    assert.deepEqual(restored.timeline.tracks[0].script,original.timeline.tracks[0].script);
    assert.deepEqual(restored.scripts,snapshot.scripts);
    report.checks.push("Source pattern deletion respects locks and survives offline reopening; disjoint insertions restore independently without changing main");
    report.checks.push("At-playhead insertion preserves timing, narrow layout fits, and exported scripts/standalone HTML retain edits and both tools");
    if(process.env.S3F_BEAT_AUDIO){await loadAudio(process.env.S3F_BEAT_AUDIO);report.audio=await a.evaluate("document.querySelector('#beatAudioInfo').textContent");}
    if(process.env.S3F_FULL_AUDIO){
        await loadAudio(process.env.S3F_FULL_AUDIO,'#beatMixFile');report.full_mix=await a.evaluate("document.querySelector('#beatMixInfo').textContent");
        await a.click('#beatNew');await a.click('#selectMain');await selection(1,11);await a.set('#beatMode','suggest');await a.click('#beatPreview');
        assert.equal(await disabled('beatSave'),false);report.dual_suggestion=await a.evaluate("document.querySelector('#beatDecisions').textContent");
    }
    // Reproduce the two-tab workspace: a new Timeline, but a reused export
    // session and stale project URL still containing the previous video's work.
    timelineState={session:'a'.repeat(32),editor_session:session,info:{source_id:'new-source',source:{path:'new-video.mp4'}},project:null};
    const oldEditor=structuredClone(state);
    await b.call('Page.navigate',{url:base+'/sam3d_funscript/assets/workspace.html'});
    await until(()=>b.evaluate('!!window.s3fConfigureWorkspace'),'workspace ready');
    const configuration={host:'test-host',connected:true,active:'motion:'+session,pages:[
        {key:'timeline:'+timelineState.session,label:'Timeline',url:'/sam3d_funscript/assets/processing-timeline.html?session='+timelineState.session},
        {key:'motion:'+session,label:'Motion Studio',url:'/sam3d_funscript/assets/viewer.html?session='+session+'&project=neutral'}]};
    await b.evaluate(`window.testConfiguration=${JSON.stringify(configuration)};window.s3fConfigureWorkspace(testConfiguration)`);
    const studio="window.s3fWorkspaceFrames().find(p=>p.key.startsWith('motion:')).window";
    await until(()=>b.evaluate(`${studio}.document.querySelector('#workflowWaiting')?.hidden===false`),'new video waits');
    assert.match(await b.evaluate(`${studio}.document.querySelector('#workflowWaiting').textContent`),/Prepare new-video.mp4.*Tracking is optional/);
    assert.equal(await b.evaluate(`getComputedStyle(${studio}.document.querySelector('.curves')).display`),'none');
    assert.deepEqual(state,oldEditor,'Opening the new workspace never saves or erases the previous session');
    timelineState.project='new-result';await b.evaluate(`${studio}.s3fUpdate()`);
    assert.match(await b.evaluate(`${studio}.document.querySelector('#workflowWaiting').textContent`),/Waiting for.*new-video.mp4/,'A result marker must not expose a mismatched editor source');
    state={revision:state.revision+1,output:'neutral',project:structuredClone(original)};
    state.project.metadata.source={path:'new-video.mp4'};state.project.metadata.processing_timeline={session:timelineState.session,plan:{source_id:'new-source'}};
    await b.evaluate('window.s3fConfigureWorkspace(testConfiguration)');
    await until(()=>b.evaluate(`${studio}.document.querySelector('#workflowWaiting').hidden&&${studio}.document.querySelector('#name').textContent==='new-video.mp4'`),'new motion result replaces waiting state');
    await b.evaluate(`${studio}.document.querySelector('#lockMain').click()`);
    timelineState.info={source_id:'third-source',source:{path:'third-video.mp4'}};timelineState.project=null;
    await b.evaluate(`${studio}.s3fUpdate()`);
    assert.equal(state.project.timeline.main.L0.locked,true,'The old video draft saves before switching away');
    assert.equal(state.project.metadata.source.path,'new-video.mp4','Waiting does not overwrite saved curves with a blank project');
    assert.match(await b.evaluate(`${studio}.document.querySelector('#workflowWaiting').textContent`),/third-video.mp4/);
    assert.equal(await b.evaluate(`${studio}.document.querySelector('#video').getAttribute('src')`),null);
    assert.equal(await b.evaluate(`${studio}.document.querySelector('#save').disabled`),true);
    report.checks.push('New and already-open workspaces hide the previous video, preserve its edits, reject mismatched results and load current motion automatically without changing tabs');
    // Prepare creates a real editable audio-only project, without any SAM3D results.
    state={revision:state.revision+1,output:'neutral',project:structuredClone(blank)};
    state.project.metadata.source=timelineState.info.source;
    state.project.metadata.processing_timeline={session:timelineState.session,plan:{source_id:'third-source'}};
    timelineState.project='neutral';timelineState.editor_only=true;
    await b.evaluate('window.s3fConfigureWorkspace(testConfiguration)');
    await until(()=>b.evaluate(`${studio}.document.body.classList.contains('manual-project')&&${studio}.document.querySelector('#workflowWaiting').hidden`),'audio-only workspace opens after Prepare');
    assert.equal(await b.evaluate(`${studio}.document.querySelectorAll('#tracks .track').length`),0);
    assert.equal(await b.evaluate(`getComputedStyle(${studio}.document.querySelector('#posePanel')).display`),'none');
    assert.equal(await b.evaluate(`getComputedStyle(${studio}.document.querySelector('#component').parentElement).display`),'none');
    assert.equal(await b.evaluate(`${studio}.document.querySelector('#save').disabled`),false);
    assert.equal(await b.evaluate(`${studio}.document.querySelector('#beatFromVideo').disabled`),true,'Load the beat track before adding the full mix');
    await b.evaluate(`(async()=>{const w=${studio},d=w.document;const dt=new w.DataTransfer();dt.items.add(new w.File([await(await fetch('/test-drums.wav')).arrayBuffer()],'drums.wav',{type:'audio/wav'}));d.querySelector('#beatFile').files=dt.files;d.querySelector('#beatFile').dispatchEvent(new w.Event('change'));})()`);
    await until(()=>b.evaluate(`${studio}.document.querySelector('#beatAudioInfo').textContent.includes('drums.wav')&&${studio}.document.querySelector('#beatCancelAnalysis').hidden`),'blank project drum analysis');
    assert.equal(await b.evaluate(`${studio}.document.querySelector('#beatFromVideo').disabled`),false);
    await b.evaluate(`${studio}.document.querySelector('#beatFromVideo').click()`);
    await until(()=>b.evaluate(`${studio}.document.querySelector('#beatStatus').textContent.startsWith('Video soundtrack loaded')`),'blank project video soundtrack');
    assert.match(await b.evaluate(`${studio}.document.querySelector('#beatRangeHint').textContent`),/Select whole video/);
    await b.evaluate(`(()=>{const w=${studio},d=w.document;for(const [id,value]of [['beatEnd','11'],['beatStart','1']]){d.getElementById(id).value=value;d.getElementById(id).dispatchEvent(new w.Event('change'));}})()`);
    assert.deepEqual(await b.evaluate(`['selectionStart','selectionEnd'].map(id=>Number(${studio}.document.getElementById(id).value))`),[1,11],'Local audio range updates the shared Main selection');
    await b.evaluate(`(()=>{const w=${studio},d=w.document;d.querySelector('#selectionEnd').value='12.001';d.querySelector('#selectionEnd').dispatchEvent(new w.Event('change'));})()`);
    assert.equal(await b.evaluate(`${studio}.document.querySelector('#beatEnd').value`),'12.001');
    assert.equal(await b.evaluate(`${studio}.document.querySelector('#beatPreview').disabled`),false,'An endpoint rounded up by a fraction of a millisecond remains valid');
    await b.evaluate(`${studio}.document.querySelector('#beatWhole').click()`);
    assert.deepEqual(await b.evaluate(`['beatStart','beatEnd'].map(id=>Number(${studio}.document.getElementById(id).value))`),[0,12.001]);
    assert.match(await b.evaluate(`${studio}.document.querySelector('#beatRangeHint').textContent`),/0.000–12.001.*Generate preview/);
    await b.evaluate(`${studio}.document.querySelector('#beatPreview').click()`);
    assert.equal(await b.evaluate(`${studio}.document.querySelector('#beatSave').disabled`),false);
    await b.evaluate(`${studio}.document.querySelector('#beatSave').click();${studio}.document.querySelector('#beatCopy').click();${studio}.s3fFlush()`);
    const authoredBlank=structuredClone(state.project);
    assert.equal(authoredBlank.audio_patterns.sections.length,1);
    assert.notDeepEqual(authoredBlank.scripts.L0,blank.scripts.L0);
    assert.equal(authoredBlank.timeline.tracks.length,0);
    assert.equal(authoredBlank.timeline.main.L0.edited,true);
    assert.equal(authoredBlank.audio_patterns.sections[0].end,12001);
    assert.equal(authoredBlank.scripts.L0.actions.at(-1).at,12001,'The full rounded clip also copies into Main');
    const blankArchive=await download({...b,click:selector=>b.evaluate(`${studio}.document.querySelector(${JSON.stringify(selector)}).click()`)});
    assert.deepEqual(JSON.parse(blankArchive['project.json']).scripts,authoredBlank.scripts);
    assert.ok(Object.keys(blankArchive).some(name=>name.endsWith('.funscript')));
    await b.call('Page.bringToFront');
    await b.evaluate(`${studio}.document.querySelector('#beatLane').scrollIntoView({block:'center'})`);
    fs.writeFileSync(path.join(output,'audio-only.png'),Buffer.from((await b.call('Page.captureScreenshot')).data,'base64'));
    await b.evaluate(`${studio}.testBeforeReload=true;${studio}.location.reload()`);
    await until(()=>b.evaluate(`!${studio}.testBeforeReload&&${studio}.document.querySelector('#beatSection option[value="beat_0"]')!==null`),'audio-only project restored');
    assert.deepEqual(state.project,authoredBlank);
    assert.equal(await b.evaluate(`Number(${studio}.document.querySelector('#beatBpm').value)`),authoredBlank.audio_patterns.analysis.bpm,'Reload shows the analyzed BPM rather than the default');
    await b.evaluate(`${studio}.document.querySelector('#beatCurve').focus({preventScroll:true})`);
    await until(()=>b.evaluate(`${studio}.document.querySelector('#video').readyState>=2`),'embedded audio-only video ready');
    await pressSpace(b);await until(()=>b.evaluate(`!${studio}.document.querySelector('#video').paused`),'Space starts playback inside workspace iframe');
    await pressSpace(b);assert.equal(await b.evaluate(`${studio}.document.querySelector('#video').paused`),true);
    report.checks.push('Prepare opens an audio-only workspace with no detections; drums and video mix generate a block that copies to Main, exports and survives reloading');
    report.checks.push('Audio In/Out stay synchronized with Main; Select whole video generates and exports through a fractional-millisecond clip end, with an actionable next-step hint');
    assert.deepEqual(report.errors,[]);fs.writeFileSync(path.join(output,"report.json"),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{
    for(const ws of sockets)ws.close();chrome.kill("SIGTERM");server.closeAllConnections();await new Promise(r=>server.close(r));
}
