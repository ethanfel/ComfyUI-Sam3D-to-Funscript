// Offset source edges, shared cut guides and collapsible tracks: neutral data,
// a disposable server/browser, and real offline export/reopen.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn,spawnSync} from 'node:child_process';
import {copyTrackToMain,trackProject} from '../assets/timeline.mjs';
import {evaluate as curveValue,fitComponentAxis,rebuildAxis} from '../assets/curve.mjs';

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
track=project['timeline']['tracks'][0]
track['script']['actions']=[{'at':0,'pos':10}]+[{'at':36146+i*100,'pos':10+i*2} for i in range(11)]+[{'at':t,'pos':p} for t,p in [(38146,40),(38244,50),(38348,60),(38446,70),(38544,80),(38646,90),(38746,90),(38846,90),(39046,70),(39900,60),(40000,50),(40001,40),(42000,20),(46146,10)]]
track['edited']=True
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
let beforeSave;
const neutralVideo=temp+'/neutral.mp4';const encoded=spawnSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=160x120:rate=24','-t','60','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-movflags','+faststart',neutralVideo]);assert.equal(encoded.status,0,encoded.stderr.toString());
const mime={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css'};
const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://localhost');res.setHeader('Cache-Control','no-store');
    if(url.pathname===`/sam3d_funscript/editors/${editorId}`){
        if(req.method==='POST'){
            let body='';for await(const chunk of req)body+=chunk;const data=JSON.parse(body);
            beforeSave?.(data);
            if(data.revision!==draft.revision){res.statusCode=409;res.end('Another editor or rerun updated this session.');return;}
            draft={...draft,revision:draft.revision+1,project:data.project};
        }
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
    assert.equal(await evaluate('document.querySelector("#sourceLayout").value'),'sections');
    await select('#zoom','0');
    await evaluate('document.querySelector("#sectionCurve").scrollIntoView({block:"center"})');
    await until(()=>evaluate('document.querySelector("#sceneCutCount").textContent==="5 cuts"'),'compact saved cuts');
    await evaluate(`(()=>{const c=document.querySelector('#sectionCurve'),r=c.getBoundingClientRect();c.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,clientX:r.left+42+40000.25/60000*(r.width-54),clientY:r.top+5}));})()`);
    assert.equal(await evaluate('document.querySelector("#sceneCutActions").hidden'),false);
    await click('#sceneCutAfter');assert.deepEqual(await range(),[40000,45000]);await click('#sceneCutClose');
    assert.equal(await evaluate('[...document.querySelectorAll("#tracks canvas")].filter(e=>e.getBoundingClientRect().height>0).length'),0);
    assert.equal(await evaluate('document.querySelectorAll(".section-block").length'),2);
    await until(()=>evaluate('document.querySelector("#sceneCutCount").textContent==="5 cuts"'),'section cut guides');await flush();
    const compactBefore=structuredClone(draft.project);
    await click('.section-block[data-track="track_1"]');assert.deepEqual(await range(),[19042,24750]);
    const fitBefore=structuredClone(draft.project);
    const fitTrack=fitBefore.timeline.tracks.find(t=>t.id==='track_1'),fitData=trackProject(fitBefore,fitTrack);
    fitData.config.axis_settings.L0=fitComponentAxis(fitData,'L0',2);
    const expectedFit=rebuildAxis(fitData,'L0');
    await select('#component','2');
    assert.equal(await evaluate('document.querySelector("#autoFit").textContent'),'Fit selected component');
    assert.equal(await evaluate('document.querySelector("#calibration").disabled'),true);
    await click('#autoFit');await flush();
    const fittedTrack=draft.project.timeline.tracks.find(t=>t.id==='track_1');
    assert.deepEqual(fittedTrack.settings,fitData.config.axis_settings.L0);
    assert.deepEqual(fittedTrack.script,expectedFit);
    assert.equal(await evaluate('document.querySelector("#component").value'),'2');
    assert.deepEqual(draft.project.scripts,fitBefore.scripts,'component fit leaves Main unchanged');
    assert.deepEqual(draft.project.timeline.tracks[0],fitBefore.timeline.tracks[0]);
    await click('#undo');await flush();
    assert.deepEqual(draft.project.timeline.tracks,fitBefore.timeline.tracks,'Undo restores the source curve and calibration');
    checks.push('Explicit component fitting preserves direction, updates only the chosen source, saves and undoes correctly');
    assert.equal(await evaluate('document.querySelector("#tracks .section-current").dataset.track'),'track_1');
    await click('#nextSection');assert.deepEqual(await range(),[36146,46146]);
    await click('#addTrack');await flush();
    const alternate=draft.project.timeline.active;
    await select('#tracks .section-current .track-axis','L1');await flush();
    assert.equal(await evaluate('document.querySelectorAll(".section-block").length'),2,'overlapping sources share a block');
    assert.equal(await evaluate('document.querySelector("#sectionAlternatives").hidden'),false);
    assert.equal(await evaluate('document.querySelectorAll("#sectionAnchor option").length'),2);
    await select('#sectionAnchor','track_0');await flush();
    assert.deepEqual(draft.project.timeline.tracks[0],compactBefore.timeline.tracks[0],'anchor switching is presentation only');
    assert.deepEqual(draft.project.scripts,compactBefore.scripts,'anchor switching cannot change the main output');
    await click('#tracks .section-current .copy-selection');await flush();
    const compactExpected=structuredClone(compactBefore);
    copyTrackToMain(compactExpected,compactExpected.timeline.tracks[0],{start:36146,end:46146,blendMs:200});
    assert.deepEqual(draft.project.scripts,compactExpected.scripts,'compact controls retain all-axis copying');
    await click('#undo');await flush();assert.deepEqual(draft.project.scripts,compactBefore.scripts);
    await click('#collapseSections');assert.equal(await evaluate('document.querySelector("#sectionCurve").getBoundingClientRect().height'),0);
    assert.ok(await evaluate('[...document.querySelectorAll(".section-block")].every(b=>b.getBoundingClientRect().width>1)'),'collapsed blocks remain selectable');
    await click('#collapseSections');
    await select('#sectionAnchor',alternate);await click('#tracks .section-current .remove-track');
    await select('#sectionTrack','track_0');await flush();
    assert.deepEqual(draft.project.timeline.tracks,compactBefore.timeline.tracks);
    const sectionEvent=(type,at,pos=50,extra={})=>evaluate(`(()=>{const c=document.querySelector('#sectionCurve'),r=c.getBoundingClientRect(),v=document.querySelector('#viewRange').dataset;const x=r.left+42+(${at}-Number(v.start))/(Number(v.end)-Number(v.start))*(r.width-54),y=r.top+r.height-25-${pos}/100*(r.height-40);c.dispatchEvent(new ${type==='dblclick'?'MouseEvent':'PointerEvent'}(${JSON.stringify(type)},{bubbles:true,clientX:x,clientY:y,button:0,...${JSON.stringify(extra)}}));})()`);
    await sectionEvent('pointerdown',20000);await sectionEvent('pointerup',20000);await flush();
    assert.equal(draft.project.timeline.active,'track_1','click resolves the block under the pointer');
    await sectionEvent('pointerdown',21000,50,{shiftKey:true});await sectionEvent('pointermove',33000,50,{shiftKey:true});await sectionEvent('pointerup',33000);
    assert.deepEqual(await range(),[21000,24750],'selection stops at the source boundary across a gap');
    await click('#editPoints');await click('#tracks .section-current .track-lock');await flush();
    const compactLocked=structuredClone(draft.project.timeline.tracks);
    await sectionEvent('dblclick',22555,67);await flush();assert.deepEqual(draft.project.timeline.tracks,compactLocked);
    await click('#tracks .section-current .track-lock');
    await sectionEvent('dblclick',38055,67);await flush();
    assert.equal(draft.project.timeline.active,'track_0');
    const newPoints=draft.project.timeline.tracks[0].script.actions.filter(p=>!compactBefore.timeline.tracks[0].script.actions.some(q=>q.at===p.at));
    assert.equal(newPoints.length,1);
    const pixelMs=await evaluate('60000/(document.querySelector("#sectionCurve").getBoundingClientRect().width-54)');
    assert.ok(Math.abs(newPoints[0].at-38055)<=pixelMs&&newPoints[0].pos===67,'mouse coordinates insert within one screen pixel of the requested time');
    assert.deepEqual(draft.project.timeline.tracks[1].script,compactBefore.timeline.tracks[1].script,'point edits affect only the clicked block');
    await click('#undo');await click('#editPoints');await flush();
    assert.deepEqual(draft.project.timeline.tracks[0],compactBefore.timeline.tracks[0]);
    await select('#sectionTrack','track_0');await select('#zoom','4000');await click('#previousSection');
    assert.ok(await evaluate('document.querySelector("#viewRange").dataset.start<=19042'),'offscreen selection pans into view');
    await select('#zoom','0');await select('#sectionTrack','track_0');
    assert.equal(await evaluate('document.querySelector("#curve").getBoundingClientRect().width===document.querySelector("#sectionCurve").getBoundingClientRect().width'),true,'main and source share the same horizontal scale');
    await flush();await call('Page.navigate',{url:pageURL});await until(()=>evaluate('document.querySelectorAll(".section-block").length===2'),'compact reopen');
    assert.equal(await evaluate('document.querySelector("#sourceLayout").value'),'sections');
    await evaluate('document.querySelector(".source-head").scrollIntoView({block:"start"})');
    fs.writeFileSync(output+'/section-blocks.png',Buffer.from((await call('Page.captureScreenshot')).data,'base64'));
    await call('Emulation.setDeviceMetricsOverride',{width:560,height:1100,deviceScaleFactor:1,mobile:false});await pause(100);
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true,'section controls fit narrow layouts');
    await evaluate('document.querySelector(".source-head").scrollIntoView({block:"start"})');
    fs.writeFileSync(output+'/section-blocks-narrow.png',Buffer.from((await call('Page.captureScreenshot')).data,'base64'));
    await call('Emulation.setDeviceMetricsOverride',{width:1500,height:1250,deviceScaleFactor:1,mobile:false});
    await select('#sourceLayout','rows');
    // Reset the initial out-of-source range used by the existing row regression.
    await click('#selectMain');await select('#selectionStart','36.411');await select('#selectionEnd','46.165');await click(lane+' .track-select');
    checks.push('Compact sections: one curve row, exact ranges, alternate anchors, six-axis copy, click/Shift-drag/point editing, locks and Undo, aligned rulers, offscreen navigation, collapse, reopen and narrow layout');
    assert.equal(await evaluate(`document.querySelector('${lane} .copy-selection').disabled`),true);
    await click(lane+' .select-track-range');assert.deepEqual(await range(),[36146,46146]);
    await select('#selectionStart','36.411');await select('#selectionEnd','46.165');
    assert.deepEqual(await range(),[36411,46146]);assert.equal(await evaluate(`document.querySelector('${lane} .copy-selection').disabled`),false);
    await until(()=>evaluate('document.querySelector("#sceneCutCount").textContent==="5 cuts"'),'linked cut scan');await flush();
    const dense=structuredClone(draft.project),denseActions=dense.timeline.tracks[0].script.actions;
    await evaluate('document.querySelector("#reductionPanel").open=true');await select('#reductionScope','whole');
    await click('#previewReduction');await flush();assert.deepEqual(draft.project,dense,'preview is non-destructive');
    assert.match(await evaluate('document.querySelector("#reductionStatus").textContent'),/exactly the same linear curve/);
    assert.equal(await evaluate('document.querySelector("#applyReduction").disabled'),false);
    await click('#cancelReduction');await flush();assert.deepEqual(draft.project,dense);
    await click('#previewReduction');await select('#reductionScope','selection');
    assert.equal(await evaluate('document.querySelector("#applyReduction").disabled'),true,'scope changes invalidate preview');
    await select('#reductionScope','whole');await click('#previewReduction');await click(lane+' .track-lock');
    assert.equal(await evaluate('document.querySelector("#applyReduction").disabled'),true,'lock blocks applying a preview');
    await click(lane+' .track-lock');await click('#previewReduction');await click('#applyReduction');await flush();
    const exact=draft.project.timeline.tracks[0].script.actions;
    assert.ok(exact.length<denseActions.length);
    for(const p of denseActions)assert.ok(Math.abs(curveValue(exact,p.at)-p.pos)<1e-9);
    assert.deepEqual(draft.project.scripts,dense.scripts,'source reduction does not change main axes');
    assert.deepEqual(draft.project.timeline.tracks[1],dense.timeline.tracks[1],'other sources are untouched');
    await click('#undo');await flush();assert.deepEqual(draft.project.timeline.tracks[0].script.actions,denseActions);
    await select('#reductionMode','tolerance');await select('#reductionTolerance','0.5');await click('#previewReduction');
    await evaluate('document.querySelector("#reductionPanel").scrollIntoView({block:"center"})');
    fs.writeFileSync(output+'/reduce-points-preview.png',Buffer.from((await call('Page.captureScreenshot')).data,'base64'));
    await click('#applyReduction');await flush();const approximate=draft.project.timeline.tracks[0].script.actions;
    const error=Math.max(...denseActions.map(p=>Math.abs(curveValue(approximate,p.at)-p.pos)));
    assert.ok(error>0&&error<=.5,`tolerance error ${error}`);assert.ok(approximate.length<exact.length);
    for(const at of [38646,38846,40000,40001])assert.ok(approximate.some(p=>p.at===at),'holds and cuts preserved');
    await click('#undo');await flush();assert.deepEqual(draft.project.timeline.tracks[0].script.actions,denseActions);
    await select('#reductionMode','exact');await select('#reductionScope','selection');await click('#previewReduction');await click('#applyReduction');await flush();
    assert.deepEqual(draft.project.timeline.tracks[0].script.actions.filter(p=>p.at<36411),denseActions.filter(p=>p.at<36411),'selection preserves outside commands');
    await click('#undo');await flush();assert.deepEqual(draft.project.timeline.tracks[0].script.actions,denseActions);
    await evaluate('document.querySelector("#reductionPanel").open=false');
    checks.push('Reduction: exact and 0.5 tolerance, preview/cancel, selection boundaries, locks, invalidation, counts and full Undo; other axes remain untouched');
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
    const cutMenu=()=>evaluate('!document.querySelector("#sceneCutActions").hidden');
    async function marker(selector,time,modifiers=0,count=1){
        await evaluate(`(async()=>{document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));})()`);
        const point=await evaluate(`(()=>{const c=document.querySelector(${JSON.stringify(selector)}),r=c.getBoundingClientRect();return {x:r.x+42+${time}/60000*(r.width-54),y:r.y+5}})()`);
        for(const [type,buttons]of [['mousePressed',1],['mouseReleased',0]])await call('Input.dispatchMouseEvent',{type,...point,button:'left',buttons,clickCount:count,modifiers});
    }
    assert.equal(await cutMenu(),true);
    assert.match(await evaluate('document.querySelector("#selectedSceneCutLabel").textContent'),/Cut 3/);
    await click('#sceneCutIn');await click('#sceneCutNext');await click('#sceneCutOut');assert.deepEqual(await range(),[40000,45000]);
    await click('#sceneCutAfter');assert.deepEqual(await range(),[45000,46146],'following shot clips at source end');
    await click('#sceneCutBefore');assert.deepEqual(await range(),[40000,45000]);
    await click('#lockMain');await marker(lane+' canvas',40000.25);await click('#sceneCutAfter');await flush();
    const lockedBefore=structuredClone(draft.project),menuExpected=structuredClone(lockedBefore);
    copyTrackToMain(menuExpected,menuExpected.timeline.tracks[0],{start:40000,end:45000,blendMs:200});
    await click('#sceneCutCopy');await flush();assert.deepEqual(draft.project.scripts,menuExpected.scripts);
    assert.deepEqual(draft.project.scripts.L0,lockedBefore.scripts.L0,'popup copy preserves locked main axis');
    await click('#undo');await click('#lockMain');
    await marker(lane+' canvas',45000);await marker(lane+' canvas',40000.25,8);assert.deepEqual(await range(),[40000,45000]);
    await click('#editPoints');await flush();const pointScripts=structuredClone(draft.project.scripts),sourceScripts=draft.project.timeline.tracks.map(t=>structuredClone(t.script));
    await marker(lane+' canvas',40000.25,0,2);assert.deepEqual(await range(),[40000,45000]);await flush();
    assert.deepEqual(draft.project.scripts,pointScripts);assert.deepEqual(draft.project.timeline.tracks.map(t=>t.script),sourceScripts,'double-click cut never adds a curve point');
    await click('#editPoints');
    await marker('#curve',40000.25);assert.match(await evaluate('document.querySelector("#sceneCutTrack").textContent'),/^Main/);await click('#sceneCutBefore');assert.deepEqual(await range(),[35000,40000]);
    assert.equal(await evaluate('document.querySelector("#sceneCutCopy").hidden'),true,'main menu does not copy a remembered source');
    await marker('#curve',45000);await marker('#curve',35000,8);assert.deepEqual(await range(),[35000,45000]);
    await evaluate('document.querySelector("#sceneCutActions").dispatchEvent(new KeyboardEvent("keydown",{key:"i",bubbles:true}))');assert.equal((await range())[0],35000);
    await select('#zoom','10000');
    await click('#sceneCutNext');await click('#sceneCutNext');assert.equal(await cutMenu(),true,'next cut remains reachable beyond previous zoom');
    assert.match(await evaluate('document.querySelector("#selectedSceneCutLabel").textContent'),/Cut 4/);
    await evaluate('document.querySelector("#sceneCutNext").dispatchEvent(new KeyboardEvent("keydown",{key:"o",bubbles:true}))');assert.equal((await range())[1],45000);
    await evaluate('document.querySelector("#sceneCutActions").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');assert.equal(await cutMenu(),false);
    assert.equal(await evaluate('document.activeElement.id'),'curve');
    await select('#zoom','0');await marker(lane+' canvas',35000);assert.equal(await evaluate('document.querySelector("#sceneCutIn").disabled'),true,'cut outside source cannot mark In');
    await click('#showSceneCuts');assert.equal(await cutMenu(),false);await click('#showSceneCuts');
    await marker(lane+' canvas',40000.25);
    const menuRect=await evaluate('(()=>{const r=document.querySelector("#sceneCutActions").getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}})()');
    assert.ok(menuRect.left>=0&&menuRect.right<=1500&&menuRect.top>=0&&menuRect.bottom<=1250);
    fs.writeFileSync(output+'/cut-menu.png',Buffer.from((await call('Page.captureScreenshot')).data,'base64'));
    await evaluate('document.body.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true}))');assert.equal(await cutMenu(),false);
    checks.push('Cut popup: In/Out, clipped shots, main/source ownership, Shift-click, keyboard navigation, locked-axis copying, zoom, dismissal and point-edit protection');


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
    await click(lane+' .track-lock');await click(lane+' .select-track-range');
    await evaluate('document.querySelector("#reductionPanel").open=true');await select('#reductionScope','whole');await click('#previewReduction');
    assert.equal(await evaluate('document.querySelector("#applyReduction").disabled'),false,'reduction works in bundled offline viewer');
    const reducedDownloads=temp+'/reduced-downloads';fs.mkdirSync(reducedDownloads);
    await call('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:reducedDownloads});
    await click('#applyReduction');await click('#save');
    await until(()=>fs.readdirSync(reducedDownloads).some(n=>n.endsWith('.zip')),'reduced offline ZIP');
    const reducedZip=fs.readdirSync(reducedDownloads).find(n=>n.endsWith('.zip')),reducedFiles=unzip(reducedDownloads+'/'+reducedZip);
    const reducedProject=JSON.parse(reducedFiles['project.json']),reducedActions=reducedProject.timeline.tracks[0].script.actions;
    assert.ok(reducedActions.length<exported.timeline.tracks[0].script.actions.length);
    for(const p of exported.timeline.tracks[0].script.actions)assert.ok(Math.abs(curveValue(reducedActions,p.at)-p.pos)<1e-9);
    assert.deepEqual(reducedProject.scripts,exported.scripts);
    await call('Emulation.setDeviceMetricsOverride',{width:560,height:1100,deviceScaleFactor:1,mobile:false});
    await evaluate('document.querySelector("#reductionPanel").scrollIntoView({block:"center"})');await pause(100);
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true,'reduction controls wrap on narrow screens');
    fs.writeFileSync(output+'/reduce-points-narrow.png',Buffer.from((await call('Page.captureScreenshot')).data,'base64'));
    await click('#undo');await click(lane+' .track-lock');await evaluate('document.querySelector("#reductionPanel").open=false');
    await call('Emulation.setDeviceMetricsOverride',{width:1500,height:1250,deviceScaleFactor:1,mobile:false});
    checks.push('Offline reduction preview, apply, export, restored main scripts, Undo and narrow layout');
    await evaluate('document.querySelector(".curves").scrollIntoView({block:"start"})');
    fs.writeFileSync(output+'/tracks.png',Buffer.from((await call('Page.captureScreenshot')).data,'base64'));
    await call('Emulation.setDeviceMetricsOverride',{width:560,height:1100,deviceScaleFactor:1,mobile:false});await pause(100);
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
    fs.writeFileSync(output+'/narrow.png',Buffer.from((await call('Page.captureScreenshot')).data,'base64'));
    checks.push('Offline ZIP reopens with saved guides and collapsed state; expand works and narrow layout fits');
    await select('#zoom','0');await marker(lane+' canvas',40000.25);assert.equal(await cutMenu(),true);
    const narrowMenu=await evaluate('(()=>{const r=document.querySelector("#sceneCutActions").getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}})()');
    assert.ok(narrowMenu.left>=0&&narrowMenu.right<=await evaluate('document.documentElement.clientWidth')&&narrowMenu.top>=0&&narrowMenu.bottom<=1100);
    await click('#sceneCutAfter');assert.deepEqual(await range(),[40000,45000]);
    fs.writeFileSync(output+'/cut-menu-narrow.png',Buffer.from((await call('Page.captureScreenshot')).data,'base64'));
    await evaluate('(()=>{const tracks=document.querySelector("#tracks");tracks.style.maxHeight="250px";tracks.scrollTop=tracks.scrollHeight;tracks.dispatchEvent(new Event("scroll"));})()');assert.equal(await cutMenu(),false,'popup closes when its source marker scrolls out of view');
    await evaluate('document.querySelector("#tracks").style.maxHeight=""');
    checks.push('Cut popup works in offline exports, stays inside narrow viewports and closes when the source marker scrolls away');

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
    await select('#sourceLayout','sections');await select('#zoom','0');await select('#sectionTrack','track_0');
    await click('#addTrack');await select('#tracks .section-current .track-axis','L1');
    const chosenAnchor=await evaluate('document.querySelector("#sectionAnchor").value');
    const compactDownloads=temp+'/compact-downloads';fs.mkdirSync(compactDownloads);
    await call('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:compactDownloads});await click('#save');
    await until(()=>fs.readdirSync(compactDownloads).some(n=>n.endsWith('.zip')),'compact offline ZIP');
    const compactFiles=unzip(compactDownloads+'/'+fs.readdirSync(compactDownloads).find(n=>n.endsWith('.zip')));
    const compactProject=JSON.parse(compactFiles['project.json']);
    assert.equal(compactProject.preview.source_layout,'sections');assert.equal(compactProject.preview.section_choices[0],chosenAnchor);
    assert.equal(compactProject.timeline.tracks.length,3);assert.deepEqual(compactProject.scripts,exported.scripts);
    fs.writeFileSync(temp+'/offline.html',compactFiles['viewer.html']);
    await call('Page.navigate',{url:base+'/offline.html'});await until(()=>evaluate('document.querySelectorAll(".section-block").length===2'),'compact offline reopen');
    assert.equal(await evaluate('document.querySelector("#sectionAnchor").value'),chosenAnchor);
    assert.equal(await evaluate('document.querySelector("#sourceLayout").value'),'sections');
    assert.ok(await evaluate('document.querySelector("#sectionCurve").getBoundingClientRect().height>0'));
    await select('#sectionAnchor','track_0');assert.equal(await evaluate('document.querySelector("#tracks .section-current").dataset.track'),'track_0');
    checks.push('Compact offline export/reopen retains every anchor, chosen display, original main scripts and working anchor selector');
    // Exercise the real viewer's conflict controls against a revision-checked
    // disposable server. No live user session or media is used.
    await call('Page.navigate',{url:base+`/sam3d_funscript/assets/viewer.html?session=${editorId}&project=fixture&timeline=${timelineId}`});
    await until(()=>evaluate('!!window.s3fFlush&&document.querySelectorAll("#tracks .track").length===2'),'online recovery fixture');await flush();
    beforeSave=()=>{beforeSave=null;draft.project.timeline.tracks[0].name='Newer saved track';draft.revision++;};
    await select('#sourceLayout','sections');await flush();
    assert.equal(await evaluate('document.querySelector("#saveRecovery").hidden'),true,'layout changes recover without blocking');
    assert.equal(await evaluate('document.querySelector("#tracks .track-head input").value'),'Newer saved track');
    await select('#sectionTrack','track_0');
    if(draft.project.timeline.tracks[0].locked){await click('#tracks .section-current .track-lock');await flush();}
    const rename=label=>evaluate(`(()=>{const input=document.querySelector('#tracks .section-current .track-head input');input.value=${JSON.stringify(label)};input.dispatchEvent(new Event('change'));})()`);
    beforeSave=()=>{beforeSave=null;draft.project.preview.wide_layout=!draft.project.preview.wide_layout;draft.revision++;};
    await rename('Local authored name');await flush();assert.equal(draft.project.timeline.tracks[0].name,'Local authored name');
    beforeSave=()=>{beforeSave=null;draft.project.timeline.tracks[0].name='Other editor name';draft.revision++;};
    await rename('Unsaved draft name');
    assert.match(await evaluate('window.s3fFlush().then(()=>"saved",e=>e.message)'),/Another editor/);
    assert.equal(await evaluate('document.querySelector("#saveRecovery").hidden'),false);
    assert.equal(draft.project.timeline.tracks[0].name,'Other editor name');
    assert.equal(await evaluate('document.querySelector("#tracks .section-current .track-head input").value'),'Unsaved draft name');
    const recoveryDownloads=temp+'/recovery-downloads';fs.mkdirSync(recoveryDownloads);
    await call('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:recoveryDownloads});
    await evaluate('window.scrollTo(0,0)');
    fs.writeFileSync(output+'/save-recovery.png',Buffer.from((await call('Page.captureScreenshot')).data,'base64'));
    await click('#recoverSave');await until(()=>evaluate('document.querySelector("#saveRecovery").hidden'),'conflict recovery');
    await until(()=>fs.readdirSync(recoveryDownloads).some(n=>n.endsWith('.json')),'draft download');
    const recovered=JSON.parse(fs.readFileSync(path.join(recoveryDownloads,fs.readdirSync(recoveryDownloads).find(n=>n.endsWith('.json')))));
    assert.equal(recovered.timeline.tracks[0].name,'Unsaved draft name');assert.equal(draft.project.timeline.tracks[0].name,'Other editor name');
    assert.equal(await evaluate('document.querySelector("#tracks .section-current .track-head input").value'),'Other editor name');
    await rename('Recovered and editable');await flush();assert.equal(draft.project.timeline.tracks[0].name,'Recovered and editable');
    checks.push('Revision conflicts recover layout-only changes; competing edits stay intact; draft download and latest-state recovery restore saving');
    // A processing rerun updates the source while legacy sessions retain the
    // old automatic row title. All displayed selectors must use the new name.
    const cropTrack=draft.project.timeline.tracks[0],cropSource=draft.project.timeline.sources.find(s=>s.id===cropTrack.source);
    cropTrack.custom_name=false;cropTrack.locked=false;delete cropTrack.window;cropTrack.name='Tracking 33 crop · mouth';
    cropSource.data.metadata.processing_region={id:'crop31',name:'Tracking 31 cropnn',isolate_subject:true};
    const actualAnchor=cropSource.data.config.target_anchor.replaceAll('_',' '),cropLabel=`Tracking 31 cropnn · ${actualAnchor}`;
    const mainBeforeRename=structuredClone(draft.project.scripts),rowBeforeRename=structuredClone(cropTrack.script);
    draft.revision++;await evaluate('window.s3fUpdate()');
    assert.equal(await evaluate('document.querySelector("#tracks .track-head input").value'),cropLabel);
    assert.ok((await evaluate('[...document.querySelector("#sectionTrack").options].map(o=>o.textContent)')).some(s=>s.includes(cropLabel)));
    assert.ok((await evaluate('[...document.querySelector("#sectionAnchor").options].map(o=>o.textContent)')).some(s=>s.includes(cropLabel)));
    assert.ok((await evaluate('[...document.querySelector("#tracks .track-source").options].map(o=>o.textContent)')).some(s=>s.includes('Tracking 31 cropnn')));
    await click('#tracks .section-current .track-lock');await flush();
    assert.equal(await evaluate('document.querySelector("#tracks .section-current .track-name").value'),cropLabel,'locking keeps the corrected name');
    await click('#tracks .section-current .track-lock');await flush();
    await rename('My finished crop');await flush();
    assert.equal(draft.project.timeline.tracks[0].name,'My finished crop');
    assert.deepEqual(draft.project.scripts,mainBeforeRename);assert.deepEqual(draft.project.timeline.tracks[0].script,rowBeforeRename);
    draft.project.timeline.sources.find(s=>s.id===cropTrack.source).data.metadata.processing_region.name='Another processing rename';draft.revision++;
    await evaluate('window.s3fUpdate()');assert.equal(await evaluate('document.querySelector("#tracks .track-head input").value'),'My finished crop');
    checks.push('Processed crop names follow the actual source across live updates and selectors; custom names, main curves and source curves are preserved');
    // Rebuilding the same interval creates a different region ID. Its identical
    // name must not leave the old curve selected in the one-row view.
    let oldTrack=draft.project.timeline.tracks[0],oldSource=draft.project.timeline.sources.find(s=>s.id===oldTrack.source);
    oldTrack.custom_name=false;oldTrack.name='Tracking 31 · mouth';
    oldSource.data.metadata.processing_region={id:'old-zone',name:'Tracking 31',start_ms:36145.833333,end_ms:46145.833333};
    draft.revision++;await evaluate('window.s3fUpdate()');
    await select('#sectionTrack',oldTrack.id);await flush();
    const originalCurves=structuredClone(draft.project.scripts),oldRow=structuredClone(draft.project.timeline.tracks[0]);
    const replacementSource=structuredClone(draft.project.timeline.sources.find(s=>s.id===oldRow.source));
    replacementSource.id='recreated-source';replacementSource.input='region:new-zone:mouth';replacementSource.data.metadata.processing_region.id='new-zone';
    const replacementTrack={...structuredClone(oldRow),id:'track_recreated',source:replacementSource.id};
    replacementTrack.script.actions[0].pos=(replacementTrack.script.actions[0].pos+1)%101;
    draft.project.timeline.sources.push(replacementSource);draft.project.timeline.tracks.push(replacementTrack);
    draft.project.timeline.latest=Object.fromEntries(Object.entries(draft.project.timeline.latest).filter(([,id])=>id!==oldRow.source));
    draft.project.timeline.latest[replacementSource.input]=replacementSource.id;draft.revision++;
    await evaluate('window.s3fUpdate()');
    assert.equal(await evaluate('document.querySelector("#sectionTrack").value'),replacementTrack.id);
    assert.equal(await evaluate('document.querySelector("#sectionAnchor").value'),replacementTrack.id);
    assert.equal(await evaluate('document.querySelector("#tracks .section-current .track-result").textContent'),'Current detection');
    assert.ok((await evaluate('[...document.querySelectorAll("#sectionLabels button")].map(b=>b.dataset.track)')).includes(replacementTrack.id));
    const options=await evaluate('[...document.querySelector("#sectionAnchor").options].map(o=>({value:o.value,text:o.textContent}))');
    assert.match(options.find(o=>o.value===oldRow.id).text,/Saved detection/);
    assert.match(options.find(o=>o.value===replacementTrack.id).text,/Current detection/);
    await select('#sectionAnchor',oldRow.id);await flush();draft.revision++;await evaluate('window.s3fUpdate()');
    assert.equal(await evaluate('document.querySelector("#sectionAnchor").value'),oldRow.id,'explicitly selected saved detection stays selected');
    assert.deepEqual(draft.project.scripts,originalCurves);assert.deepEqual(draft.project.timeline.tracks[0].script,oldRow.script);
    checks.push('Recreated same-name zones reveal their new detection; saved versions remain selectable and main/source curves are preserved');
    // Candidates from different people share the section, while the active
    // curve and authored Main remain independent of display selection.
    const autoSource=draft.project.timeline.sources.find(s=>s.id===replacementSource.id);
    autoSource.data.metadata.processing_region.candidate_people=[0,1];
    autoSource.data.metadata.automatic_candidate={suggested:true,review:['Large framing change; review crop']};
    autoSource.data.config.target_person=0;
    const otherPerson=structuredClone(autoSource);otherPerson.id='auto-person-1';otherPerson.input='region:new-zone:mouth:person1';
    otherPerson.data.config.target_person=1;otherPerson.data.metadata.automatic_candidate={suggested:false,review:[]};
    draft.project.timeline.sources.push(otherPerson);draft.project.timeline.latest[otherPerson.input]=otherPerson.id;
    draft.project.timeline.tracks.push({...structuredClone(replacementTrack),id:'auto-track-person-1',source:otherPerson.id});
    draft.revision++;await evaluate('window.s3fUpdate()');await select('#sectionTrack',replacementTrack.id);await flush();
    const autoOptions=await evaluate('[...document.querySelector("#sectionAnchor").options].map(o=>o.textContent)');
    assert.ok(autoOptions.some(t=>/person 0.*suggested/.test(t)));assert.ok(autoOptions.some(t=>/person 1/.test(t)));
    assert.equal(await evaluate('document.querySelector("#tracks .section-current .automatic-review").textContent'),'Needs review');
    await select('#sectionAnchor','auto-track-person-1');await flush();
    assert.equal(await evaluate('document.querySelector("#tracks .section-current .automatic-review").textContent'),'Auto candidate');
    assert.deepEqual(draft.project.scripts,originalCurves);
    checks.push('Automatic people share one scene selector; suggestion and review labels follow the candidate; choosing a candidate preserves Main');
    assert.deepEqual(errors,[]);fs.writeFileSync(output+'/report.json',JSON.stringify({checks,errors},null,2));console.log(JSON.stringify({checks,errors},null,2));
}finally{ws?.close();chrome.kill('SIGTERM');await new Promise(r=>server.close(r));}
