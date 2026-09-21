// Real folder UI, workspace and ComfyUI bridge; neutral in-memory editor backend.
import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import http from 'node:http';import {spawn} from 'node:child_process';
const root=path.resolve('.'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'s3f-folder-browser-')),folder='f'.repeat(32);
const entries=['a.mp4','sub/b.mp4','existing.mp4'].map((name,i)=>({id:String(i+1).repeat(32),name,status:i===2?'existing':'pending',timeline:String(i+4).repeat(32),editor_session:String(i+7).repeat(32),draft:true,quality:0,existing:i===2?['existing.funscript']:[],note:''}));
const states=Object.fromEntries(entries.map(e=>[e.editor_session,{revision:1,project:{metadata:{source:{path:e.name}},scripts:{L0:{actions:[{at:0,pos:20}]}},timeline:{sources:[],tracks:[],main:{},selection:[0,0]}}}]));
let queued=false,failSave=false,batchPrompt=null,batchRunning=false,batchComplete=false,batch=null;const versions=Object.fromEntries(entries.map(e=>[e.id,[]]));let preset=null;const writes=[],requests=[];
const listing=()=>({folder,root:'/neutral/videos',recursive:true,entries,batch,counts:Object.fromEntries(['pending','approved','existing','ignored'].map(s=>[s,entries.filter(e=>e.status===s).length]))});
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');res.setHeader('Cache-Control','no-store');const send=(s,t='text/javascript')=>{res.setHeader('Content-Type',t);res.end(s);};const json=x=>send(JSON.stringify(x),'application/json');
 if(url.pathname==='/host')return send(`<button id="open">Open</button><script type="module">import {app} from '/scripts/app.js';import {api} from '/scripts/api.js';window.api=api;import {openWorkspace} from '/extensions/s3f/workspace.mjs';import '/extensions/s3f/processing-timeline.js';for(const e of app.extensions)e.setup?.();document.querySelector('#open').onclick=()=>openWorkspace(app.graph._nodes[0]);window.app=app;window.ready=true;</script>`,'text/html');
 if(url.pathname==='/scripts/app.js')return send(`const node={id:9,type:'S3F_FolderTimeline',properties:{s3f_folder:'${folder}',s3f_folder_entry:${JSON.stringify(entries[0])},s3f_timeline_session:'${entries[0].timeline}',s3f_timeline_ready:true},widgets:[{name:'folder_path',value:'/neutral/videos'},{name:'video_name',value:'a.mp4'},{name:'plan_json',value:'{}'}],s3fTimelineStatus:{},setDirtyCanvas(){}};export const app={extensions:[],registerExtension(e){this.extensions.push(e)},queuePrompt:async()=>{},async graphToPrompt(){return {output:{9:{class_type:node.type,inputs:{folder_path:'/neutral/videos',video_name:node.widgets.find(w=>w.name==='video_name').value}},99:{class_type:'Unrelated',inputs:{}}},workflow:{nodes:[JSON.parse(JSON.stringify(node))]}}},graph:{_nodes:[node],links:{},getNodeById(id){return Number(id)===9?node:null},change(){}}};`);
 if(url.pathname==='/scripts/api.js')return send(`export const api=new EventTarget();api.apiURL=p=>p;api.fetchApi=(p,o)=>fetch(p,o);api.queuePrompt=async(n,p)=>{const r=await fetch('/prompt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(p)});return r.json()};`);
 if(url.pathname==='/sam3d_funscript/reference-capabilities')return json({});
 if(url.pathname==='/prompt'){let body='';for await(const chunk of req)body+=chunk;batchPrompt=JSON.parse(body);batchRunning=true;entries[1].processing=true;batch={stage:'running',total:1,completed:[],failed:[],skipped:[],deferred:[],current:entries[1].name,current_id:entries[1].id};return json({prompt_id:'bulk-job'});}
 if(url.pathname==='/history/bulk-job'){
  if(!batchComplete)return json({});
  return json({'bulk-job':{outputs:{9:{s3f_folder:[folder],s3f_folder_batch:[batch]}},status:{messages:[]}}});
 }
 if(url.pathname==='/queue')return json({queue_running:queued?[[0,'job',{'9':{class_type:'S3F_FolderTimeline',inputs:{folder_path:'/neutral/videos'}}}]]:batchRunning?[[0,'bulk-job',batchPrompt.output]]:[],queue_pending:[]});
 if(url.pathname===`/sam3d_funscript/folders/${folder}`)return json(listing());
 if(url.pathname.startsWith(`/sam3d_funscript/folders/${folder}/`)){
  let data='';for await(const chunk of req)data+=chunk;const body=JSON.parse(data),action=url.pathname.split('/').at(-1),e=entries.find(e=>e.id===body.clip);requests.push({action,...body});
  if(action==='open')return json(e);
  if(action==='lease')return json({});
  if(action==='issues')return json([{start_ms:100,end_ms:500,reason:'Person overlap',track:null}]);
  if(action==='versions')return json(versions[e.id]);
  if(action==='version')return json(versions[e.id].find(v=>v.id===body.version));
  if(action==='save_version'){const v={id:'v'+versions[e.id].length,name:body.name,quality:body.quality,note:body.note,scripts:structuredClone(states[e.editor_session].project.scripts)};versions[e.id].push(v);return json(v);}
  if(action==='restore_version'){const state=states[e.editor_session];assert.equal(body.revision,state.revision);state.project.scripts=structuredClone(versions[e.id].find(v=>v.id===body.version).scripts);state.revision++;return json({revision:state.revision});}
  if(action==='rate_version'){Object.assign(versions[e.id].find(v=>v.id===body.version),{name:body.name,quality:body.quality,note:body.note});return json(versions[e.id]);}
  if(action==='preflight')return json({ok:true,checks:['Fixture models present'],errors:[]});
  if(action==='preset'){if(body.settings)preset=body.settings;return json({settings:preset,subfolder:preset?'sub':null});}
  if(action==='pause')return json({pause_requested:true});
  if(action==='review'){e.quality=body.quality;e.note=body.note;return json(listing());}
  if(action==='ignore'){e.status=body.ignored?'ignored':'pending';e.note=body.note;return json(listing());}
  if(action==='approve'){if(body.revision!==states[e.editor_session].revision){res.statusCode=409;return send('Review latest curves','text/plain');}writes.push(structuredClone(states[e.editor_session].project));e.status='approved';e.existing=['a.funscript'];return json({files:['a.funscript'],listing:listing()});}
 }
 if(url.pathname.startsWith('/sam3d_funscript/editors/')){
  const state=states[url.pathname.split('/').at(-1)];if(req.method==='POST'){
   let data='';for await(const chunk of req)data+=chunk;const body=JSON.parse(data);
   if(failSave){res.statusCode=503;return send('Temporary save failure','text/plain');}
   if(body.revision!==state.revision){res.statusCode=409;return send('Conflict','text/plain');}state.project=body.project;state.revision++;return json({revision:state.revision});
  }return json(state);
 }
 if(url.pathname==='/sam3d_funscript/assets/processing-timeline.html')return send(`<p>Real bridge test</p><script type="module">import {workflowHost} from './workflow-host.mjs';const p=new URLSearchParams(location.search);let waiting;window.s3fTimelineApply=()=>new Promise((resolve,reject)=>{const request=crypto.randomUUID();waiting={request,resolve,reject};workflowHost().postMessage({type:'s3f-timeline-apply',session:p.get('session'),node:p.get('node'),request,plan:{tracking:[],stabilization:[],selection:[0,0]},revision:1},location.origin)});window.addEventListener('message',e=>{if(e.data.request===waiting?.request&&e.data.type==='s3f-timeline-applied'){e.data.error?waiting.reject(Error(e.data.error)):waiting.resolve();waiting=null;}});window.s3fTimelineLoad=async()=>{window.loaded=(window.loaded||0)+1};window.ready=true;</script>`,'text/html');
 if(url.pathname==='/sam3d_funscript/assets/viewer.html')return send(`<p id="value"></p><script type="module">import {editorSession} from './editor-session.mjs';let project;const session=editorSession({install:p=>{project=p;document.querySelector('#value').textContent=p.metadata.source.path},snapshot:()=>project,status:()=>{}});window.edit=v=>{project.scripts.L0.actions[0].pos=v;session.changed()};await session.load();const update=window.s3fUpdate;window.s3fUpdate=async()=>{window.updated=(window.updated||0)+1;await update()};window.s3fFolderCompare=v=>window.comparison=v;window.s3fFolderSelectRange=(a,b)=>window.range=[a,b];window.s3fFolderIssues=v=>window.issues=v;window.s3fFolderPlaySelection=()=>true;window.ready=true;</script>`,'text/html');
 const name=path.basename(url.pathname),file=url.pathname.startsWith('/sam3d_funscript/assets/')?path.join(root,'assets',name):url.pathname.startsWith('/extensions/s3f/')?path.join(root,'web',name):null;
 if(!file||!fs.existsSync(file)){res.writeHead(404);return res.end();}return send(fs.readFileSync(file),({'.html':'text/html','.css':'text/css'})[path.extname(file)]||'text/javascript');
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
const profile=path.join(temp,'chrome'),chrome=spawn('/opt/google/chrome/chrome',['--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-first-run','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore'});
const pause=ms=>new Promise(r=>setTimeout(r,ms));async function until(fn,label){for(let i=0;i<200;i++){if(await fn())return;await pause(50);}throw Error('Timeout: '+label);}
const sockets=[],errors=[];let port;
async function connect(target){const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));sockets.push(ws);let id=0;const pending=new Map();ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id){pending.get(m.id)?.(m);pending.delete(m.id);}else if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails);});
 const call=(method,params={})=>new Promise((resolve,reject)=>{const number=++id,timer=setTimeout(()=>reject(Error('CDP timed out')),15000);pending.set(number,m=>{clearTimeout(timer);m.error?reject(Error(JSON.stringify(m.error))):resolve(m.result);});ws.send(JSON.stringify({id:number,method,params}));});
 const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};await call('Runtime.enable');await call('Page.enable');return {call,evaluate};}
try{
 await until(()=>{try{port=fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0];return port;}catch{return false;}},'Chrome');
 const host=await connect((await(await fetch(`http://127.0.0.1:${port}/json`)).json()).find(p=>p.type==='page'));
 await host.call('Page.navigate',{url:base+'/host'});await until(()=>host.evaluate('window.ready'),'host');await host.evaluate("document.querySelector('#open').click()");
 let target;await until(async()=>{target=(await(await fetch(`http://127.0.0.1:${port}/json`)).json()).find(p=>p.url.includes('workspace.html'));return target;},'workspace');
 const w=await connect(target),inspect=w.evaluate,F=`window.s3fWorkspaceFrames().find(p=>p.key==='folder:${folder}').window`;
 const T=e=>`window.s3fWorkspaceFrames().find(p=>p.key==='timeline:${e.timeline}').window`,M=e=>`window.s3fWorkspaceFrames().find(p=>p.key==='motion:${e.editor_session}').window`;
 await until(()=>inspect(`window.s3fWorkspaceFrames?.().length===3&&${F}.document.querySelectorAll('#clips option').length===3&&${M(entries[0])}.ready&&${T(entries[0])}.ready`),'folder tools');
 assert.deepEqual(await inspect("[...document.querySelectorAll('#tabs button')].map(b=>b.textContent)"),['Folder']);
 const click=id=>inspect(`${F}.document.getElementById('${id}').click()`);
 await inspect(`${M(entries[0])}.edit(67)`);await click('next');
 await until(()=>inspect(`window.s3fWorkspaceFrames().some(p=>p.key==='motion:${entries[1].editor_session}')&&${M(entries[1])}.ready`),'switch video');
 assert.equal(states[entries[0].editor_session].project.scripts.L0.actions[0].pos,67,'Switch flushes draft first');
 assert.equal(await inspect(`window.s3fWorkspaceFrames().some(p=>p.key==='motion:${entries[0].editor_session}')`),false,'Old Motion Studio is removed');
 assert.equal(await host.evaluate("app.graph._nodes[0].widgets.find(w=>w.name==='video_name').value"),'sub/b.mp4');
 await inspect(`${F}.document.querySelector('#note').value='Poor tracking';${F}.document.querySelector('#note').dispatchEvent(new Event('input'))`);await click('ignore');
 await until(()=>entries[1].status==='ignored','ignore');assert.equal(entries[1].note,'Poor tracking');assert.equal(writes.length,0);
 await until(()=>inspect(`!${F}.document.querySelector('#restore').disabled`),'restore enabled');await click('restore');await until(()=>entries[1].status==='pending','restore');
 await until(()=>inspect(`!${F}.document.querySelector('#next').disabled`),'next enabled');await click('previous');
 await until(()=>inspect(`window.s3fWorkspaceFrames().some(p=>p.key==='motion:${entries[0].editor_session}')&&${M(entries[0])}.ready`),'return video');
 await inspect(`${M(entries[0])}.edit(82)`);failSave=true;await click('approve');
 await until(()=>inspect(`${F}.document.querySelector('#status').classList.contains('error')`),'save failure');assert.equal(writes.length,0,'Failed flush cannot approve');
 failSave=false;await click('approve');await until(()=>writes.length===1,'approve');assert.equal(writes[0].scripts.L0.actions[0].pos,82);
 await until(()=>inspect(`!${F}.document.querySelector('#next').disabled`),'approval complete');queued=true;await click('next');
 await until(()=>inspect(`${F}.document.querySelector('#status').textContent.includes('queued or running')`),'queue protection');
 assert.equal(await host.evaluate("app.graph._nodes[0].properties.s3f_folder_entry.name"),'a.mp4');queued=false;
 await click('next');await until(()=>inspect(`window.s3fWorkspaceFrames().some(p=>p.key==='motion:${entries[1].editor_session}')&&${M(entries[1])}.ready`),'next pending');
 // Rating and folder/quality filters leave the current clip available for review.
 await until(()=>inspect(`!${F}.document.querySelector('#quality').disabled`),'review ready');
 await inspect(`${F}.document.querySelector('#quality').value='4';${F}.document.querySelector('#quality').dispatchEvent(new Event('change'))`);await click('review');
 await until(()=>entries[1].quality===4,'rating saved');
 await until(()=>inspect(`!${F}.document.querySelector('#subfolder').disabled`),'filters ready');
 await inspect(`${F}.document.querySelector('#subfolder').value='sub';${F}.document.querySelector('#subfolder').dispatchEvent(new Event('change'))`);
 assert.equal(await inspect(`${F}.document.querySelector('#bulk-count').textContent`),'1 clips to process');
 // Presets, issue navigation and saved versions are available without exporting.
 await until(()=>inspect(`!${F}.document.querySelector('#save-preset').disabled`),'preset ready');
 await inspect(`${F}.document.querySelector('#preset-anchor').value='mouth'`);await click('save-preset');
 try{await until(()=>preset?.preferred_anchor==='mouth','preset saved')}catch(error){console.error(JSON.stringify({preset,status:await inspect(`${F}.document.querySelector('#status').textContent`),recent:requests.slice(-8)},null,2));throw error}
 await until(()=>inspect(`!${F}.document.querySelector('#next-issue').disabled`),'issues loaded');await click('next-issue');
 await until(()=>inspect(`JSON.stringify(${M(entries[1])}.range)==='[100,500]'`),'issue selects range');
 await until(()=>inspect(`!${F}.document.querySelector('#save-version').disabled`),'version ready');
 await inspect(`${F}.document.querySelector('#version-name').value='Dance draft';${F}.document.querySelector('#version-quality').value='5'`);await click('save-version');
 await until(()=>inspect(`${F}.document.querySelectorAll('#versions option').length===2&&!${F}.document.querySelector('#save-version').disabled`),'version saved');
 await inspect(`${F}.document.querySelector('#versions').value='v0';${F}.document.querySelector('#versions').dispatchEvent(new Event('change'))`);
 await click('compare');await until(()=>inspect(`${M(entries[1])}.comparison?.name==='Dance draft'`),'version comparison');
 await until(()=>inspect(`!${F}.document.querySelector('#restore-version').disabled`),'version restore ready');
 await inspect(`${M(entries[1])}.edit(53)`);await click('restore-version');
 await until(()=>inspect(`${F}.document.querySelector('#status').textContent.includes('Version restored')`),'version restored');
 assert.equal(states[entries[1].editor_session].project.scripts.L0.actions[0].pos,20);
 await until(()=>inspect(`!${F}.document.querySelector('#bulk').disabled`),'batch ready');
 await click('bulk');await until(()=>batchPrompt,'batch queued');
 const progress=()=>host.evaluate(`api.dispatchEvent(new CustomEvent('s3f_folder_progress',{detail:${JSON.stringify({folder,...batch})}}))`);
 await progress();await until(()=>inspect(`${F}.document.querySelector('#approve').disabled`),'active clip read-only');
 // Review and approve another completed clip while the batch remains active.
 await until(()=>inspect(`!${F}.document.querySelector('#subfolder').disabled`),'batch start returned');
 await inspect(`${F}.document.querySelector('#subfolder').value='';${F}.document.querySelector('#subfolder').dispatchEvent(new Event('change'));${F}.document.querySelector('#clips').value='${entries[0].id}';${F}.document.querySelector('#clips').dispatchEvent(new Event('change'))`);
 await until(()=>inspect(`window.s3fWorkspaceFrames().some(p=>p.key==='motion:${entries[0].editor_session}')&&${M(entries[0])}.ready&&!${F}.document.querySelector('#approve').disabled`),'other clip editable during bulk');
 await inspect(`${M(entries[0])}.edit(75)`);await click('approve');await until(()=>writes.length===2,'approve during batch');
 assert.equal(writes[1].scripts.L0.actions[0].pos,75);
 await until(()=>inspect(`!${F}.document.querySelector('#clips').disabled`),'approval complete during batch');
 await inspect(`${F}.document.querySelector('#clips').value='${entries[1].id}';${F}.document.querySelector('#clips').dispatchEvent(new Event('change'))`);
 await until(()=>inspect(`window.s3fWorkspaceFrames().some(p=>p.key==='motion:${entries[1].editor_session}')&&${M(entries[1])}.ready&&${F}.document.querySelector('#approve').disabled`),'return active clip');
 entries[1].processing=false;entries[1].batch_result='ready';batch.completed=['sub/b.mp4'];batch.current=batch.current_id=null;
 await progress();await until(()=>inspect(`${M(entries[1])}.updated>0&&!${F}.document.querySelector('#approve').disabled`),'completed clip refreshes while batch still running');
 assert.equal(batchRunning,true);
 await click('pause');await until(()=>requests.some(r=>r.action==='pause'),'pause after clip requested');
 batchRunning=false;batchComplete=true;batch.stage='paused';

 assert.deepEqual(Object.keys(batchPrompt.output),['9'],'Bulk queues only this folder node');
 assert.equal(JSON.parse(batchPrompt.output['9'].inputs.plan_json).folder_batch.subfolder,'sub');
 await until(()=>inspect(`${F}.document.querySelector('#status').textContent.includes('Batch finished')`),'batch completed');
 assert.equal(writes.length,2,'Bulk does not export; only explicit approvals do');
 assert.equal(await inspect(`${F}.document.querySelector('#bulk-count').textContent`),'0 clips to process');
 // Existing-script clips can be opened inside the same workspace.
 await inspect(`${F}.document.querySelector('#subfolder').value='';${F}.document.querySelector('#subfolder').dispatchEvent(new Event('change'));${F}.document.querySelector('#clips').value='${entries[2].id}';${F}.document.querySelector('#clips').dispatchEvent(new Event('change'))`);
 await until(()=>inspect(`window.s3fWorkspaceFrames().some(p=>p.key==='motion:${entries[2].editor_session}')&&${M(entries[2])}.ready`),'existing script open');
 await until(()=>inspect(`!${F}.document.querySelector('#approve').disabled`),'replace ready');
 assert.equal(await inspect(`${F}.document.querySelector('#approve').textContent`),'Approve & replace scripts');
 // Reloading ComfyUI must retain the currently reviewed clip, even if the saved graph points to the first clip.
 await inspect(`${M(entries[2])}.edit(61)`);
 await host.call('Page.reload');await until(()=>host.evaluate('window.ready'),'host reloaded');
 await w.evaluate(`window.dispatchEvent(new Event('focus'))`);
 await until(()=>host.evaluate(`app.graph._nodes[0].properties.s3f_folder_entry.id==='${entries[2].id}'`),'adopt retained folder clip');
 assert.equal(await inspect(`${M(entries[2])}.document.querySelector('#value').textContent`),'existing.mp4');
 await inspect(`${T(entries[2])}.s3fTimelineApply()`);
 // Invalid sender cannot approve a different video through the host bridge.
 const before=requests.length;await host.evaluate(`window.postMessage({type:'s3f-folder-action',folder:'${folder}',node:9,request:'forged',action:'approve',clip:'${entries[1].id}'},location.origin)`);await pause(100);assert.equal(requests.length,before);
 // Fast review shortcuts work from the embedded editor, including approve/ignore-and-next.
 await inspect(`${M(entries[2])}.document.body.dispatchEvent(new (${M(entries[2])}.KeyboardEvent)('keydown',{key:'ArrowLeft',altKey:true,bubbles:true}))`);
 await until(()=>inspect(`window.s3fWorkspaceFrames().some(p=>p.key==='motion:${entries[1].editor_session}')&&${M(entries[1])}.ready&&!${F}.document.querySelector('#quality').disabled`),'embedded previous shortcut');
 await inspect(`${M(entries[1])}.document.body.dispatchEvent(new (${M(entries[1])}.KeyboardEvent)('keydown',{key:'3',altKey:true,bubbles:true}))`);
 await until(()=>entries[1].quality===3,'embedded rating shortcut');
 await until(()=>inspect(`!${F}.document.querySelector('#approve-next').disabled`),'approve next ready');
 await click('approve-next');
 await until(()=>inspect(`window.s3fWorkspaceFrames().some(p=>p.key==='motion:${entries[2].editor_session}')&&${M(entries[2])}.ready&&!${F}.document.querySelector('#ignore-next').disabled`),'approve advances');
 assert.equal(writes.length,3);
 await click('ignore-next');
 await until(()=>inspect(`window.s3fWorkspaceFrames().some(p=>p.key==='motion:${entries[0].editor_session}')&&${M(entries[0])}.ready&&!${F}.document.querySelector('#next').disabled`),'ignore advances');
 assert.equal(entries[2].status,'ignored');assert.equal(writes.length,3);
 await inspect(`${F}.scrollTo(0,0)`);
 const output=path.join(root,'development/folder-browser');fs.mkdirSync(output,{recursive:true});await w.call('Emulation.setDeviceMetricsOverride',{width:1400,height:900,deviceScaleFactor:1,mobile:false});fs.writeFileSync(path.join(output,'folder.png'),Buffer.from((await w.call('Page.captureScreenshot')).data,'base64'));
 assert.deepEqual(errors,[]);console.log('PASS: real folder/workspace bridge, one tab with nested editors, edit flush, per-video switching, ignore/restore, approval, failed-save and queued-job protection, presets, versions, issue navigation, concurrent review, per-clip refresh, pause, embedded shortcuts, approve/ignore and next, sender validation.');
}finally{for(const ws of sockets)ws.close();const exited=new Promise(r=>chrome.once('exit',r));chrome.kill('SIGTERM');await exited;server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(temp,{recursive:true,force:true});}
