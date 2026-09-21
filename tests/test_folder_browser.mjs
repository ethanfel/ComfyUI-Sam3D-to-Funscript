// Real folder UI, workspace and ComfyUI bridge; neutral in-memory editor backend.
import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import http from 'node:http';import {spawn} from 'node:child_process';
const root=path.resolve('.'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'s3f-folder-browser-')),folder='f'.repeat(32);
const entries=['a.mp4','sub/b.mp4','existing.mp4'].map((name,i)=>({id:String(i+1).repeat(32),name,status:i===2?'existing':'pending',timeline:String(i+4).repeat(32),editor_session:String(i+7).repeat(32),draft:true,quality:0,existing:i===2?['existing.funscript']:[],note:''}));
const states=Object.fromEntries(entries.map(e=>[e.editor_session,{revision:1,project:{metadata:{source:{path:e.name}},scripts:{L0:{actions:[{at:0,pos:20}]}},timeline:{sources:[],tracks:[],main:{},selection:[0,0]}}}]));
let queued=false,failSave=false,batchPrompt=null,batchRunning=false,batchComplete=false,batch=null;const versions=Object.fromEntries(entries.map(e=>[e.id,[]]));let preset=null;const writes=[],requests=[];
let holdReview=false;const heldReviews=[];
const listing=()=>({folder,root:'/neutral/videos',recursive:true,entries,batch,counts:Object.fromEntries(['pending','approved','existing','ignored'].map(s=>[s,entries.filter(e=>e.status===s).length]))});
let remotePages=0,tokenConfigured=false,remoteAccessDenied=false;const downloads=[],categories=['Dance'],ignored=[],thumbnailRequests=[],videoRequests=[];
let clipQueue={stage:'idle',items:[]};
function stageClip(body){
 downloads.push(body.id);const id=Number(body.id).toString(16).padStart(32,'0'),e={id,name:'.s3f-civitai-review/'+body.id+'/Neutral_civitai_'+body.id+'_original.mp4',status:'pending',timeline:'d'+id.slice(1),editor_session:'e'+id.slice(1),draft:true,quality:0,existing:[],note:'',civitai_id:body.id,civitai_temporary:true,category_hint:body.category};entries.push(e);versions[e.id]=[];
 states[e.editor_session]={revision:1,project:{metadata:{source:{path:e.name}},scripts:{L0:{actions:[{at:0,pos:20}]}},timeline:{sources:[],tracks:[],main:{},selection:[0,0]}}};return {...e,category:body.category,processed:false};
}
const cvLibrary=()=>({folder,root:'/neutral/videos',recursive:true,categories,ignored,downloads:{},token_configured:tokenConfigured,queue:clipQueue,
 items:Object.fromEntries(entries.map((e,i)=>[e.civitai_id||String(101+i),[{...e,category:e.category_hint||'Dance',processed:!!e.existing.length||e.batch_result==='ready'}]]))});
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');res.setHeader('Cache-Control','no-store');const send=(s,t='text/javascript')=>{res.setHeader('Content-Type',t);res.end(s);};const json=x=>send(JSON.stringify(x),'application/json');
 if(url.pathname==='/host')return send(`<button id="open">Open</button><script type="module">import {app} from '/scripts/app.js';import {api} from '/scripts/api.js';window.api=api;import {openWorkspace} from '/extensions/s3f/workspace.mjs';import '/extensions/s3f/processing-timeline.js';for(const e of app.extensions)e.setup?.();document.querySelector('#open').onclick=()=>openWorkspace(app.graph._nodes[0]);window.app=app;window.ready=true;</script>`,'text/html');
 if(url.pathname==='/scripts/app.js')return send(`const node={id:9,type:'S3F_FolderTimeline',properties:{s3f_folder:'${folder}',s3f_folder_entry:${JSON.stringify(entries[0])},s3f_timeline_session:'${entries[0].timeline}',s3f_timeline_ready:true},widgets:[{name:'folder_path',value:'/neutral/videos'},{name:'video_name',value:'a.mp4'},{name:'plan_json',value:'{}'}],s3fTimelineStatus:{},setDirtyCanvas(){}};export const app={extensions:[],registerExtension(e){this.extensions.push(e)},queuePrompt:async()=>{},async graphToPrompt(){return {output:{9:{class_type:node.type,inputs:{folder_path:'/neutral/videos',video_name:node.widgets.find(w=>w.name==='video_name').value}},99:{class_type:'Unrelated',inputs:{}}},workflow:{nodes:[JSON.parse(JSON.stringify(node))]}}},graph:{_nodes:[node],links:{},getNodeById(id){return Number(id)===9?node:null},change(){}}};`);
 if(url.pathname==='/scripts/api.js')return send(`export const api=new EventTarget();api.apiURL=p=>p;api.fetchApi=(p,o)=>fetch(p,o);api.queuePrompt=async(n,p)=>{const r=await fetch('/prompt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(p)});return r.json()};`);
 if(url.pathname==='/sam3d_funscript/reference-capabilities')return json({});
 if(url.pathname==='/prompt'){
  let body='';for await(const chunk of req)body+=chunk;batchPrompt=JSON.parse(body);batchRunning=true;batchComplete=false;
  const plan=JSON.parse(batchPrompt.output['9'].inputs.plan_json);let ids=plan.folder_batch?.clip_ids;
  if(plan.folder_queue){assert.equal(plan.folder_queue.ticket,clipQueue.ticket);clipQueue.stage='running';ids=clipQueue.items.filter(i=>i.state==='waiting').map(item=>{const e=stageClip(item);item.clip=e.id;item.name=e.name;item.state='processing';return e.id;});}
  const candidate=ids?entries.find(e=>e.id===ids[0]):entries[1];candidate.processing=true;batch={stage:'running',total:ids?.length||1,completed:[],failed:[],skipped:[],deferred:[],current:candidate.name,current_id:candidate.id};return json({prompt_id:'bulk-job'});
 }
 if(url.pathname==='/history/bulk-job'){
  if(!batchComplete)return json({});
  return json({'bulk-job':{outputs:{9:{s3f_folder:[folder],s3f_folder_batch:[batch]}},status:{messages:[]}}});
 }
 if(url.pathname==='/queue')return json({queue_running:queued?[[0,'job',{'9':{class_type:'S3F_FolderTimeline',inputs:{folder_path:'/neutral/videos'}}}]]:batchRunning?[[0,'bulk-job',batchPrompt.output]]:[],queue_pending:[]});
 if(url.pathname===`/sam3d_funscript/folders/${folder}`){requests.push({action:'scan'});return json(listing());}
 if(url.pathname===`/sam3d_funscript/civitai/${folder}`)return json(cvLibrary());
 if(url.pathname.startsWith(`/sam3d_funscript/civitai/${folder}/thumbnail/`)){
  thumbnailRequests.push(url.pathname.split('/').at(-1));
  return send('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#326f7d"/><circle cx="160" cy="85" r="45" fill="#a1c7b8"/><text x="160" y="158" text-anchor="middle" fill="white">Neutral video preview</text></svg>','image/svg+xml');
 }
 if(url.pathname.startsWith(`/sam3d_funscript/civitai/${folder}/local/`))videoRequests.push(url.pathname);
 if(url.pathname.startsWith(`/sam3d_funscript/civitai/${folder}/`)){
  let data='';for await(const chunk of req)data+=chunk;const body=data?JSON.parse(data):{},action=url.pathname.split('/').at(-1);
  if(action==='key'){tokenConfigured=!!body.token;return json({configured:tokenConfigured});}
  if(action==='queue'){
   if(body.action==='add')for(const item of body.items){if(!clipQueue.items.some(i=>i.id===item.id))clipQueue.items.push({...item,key:'key-'+item.id,state:'waiting'});}
   if(body.action==='remove')clipQueue.items=clipQueue.items.filter(i=>i.key!==body.key);
   if(body.action==='first'){const item=clipQueue.items.find(i=>i.key===body.key);clipQueue.items=clipQueue.items.filter(i=>i!==item);clipQueue.items.unshift(item);}
   if(body.action==='pause')clipQueue.pause=true;
   if(body.action==='retry')clipQueue.items.find(i=>i.key===body.key).state='waiting';
   if(body.action==='clear_finished')clipQueue.items=clipQueue.items.filter(i=>!['ready','skipped'].includes(i.state));
   return json(clipQueue);
  }
  if(action==='browse'&&remoteAccessDenied){res.statusCode=400;return send('Civitai returned HTTP 401. Check access on the selected site or set your Civitai API key.','text/plain');}
  if(action==='browse'){remotePages++;requests.push({action:'browse',...body});return json({items:(body.cursor?[406]:[404,405]).map(id=>({id:String(id),username:'Neutral creator',url:base+'/neutral.mp4',page:'https://civitai.com/images/'+id})),next_cursor:body.cursor?null:'page2',library:cvLibrary()});}
  if(action==='download')return json({entry:stageClip(body),reused:false});
  if(action==='category'){categories.push(body.name);return json(cvLibrary());}
 }
 if(url.pathname.startsWith(`/sam3d_funscript/folders/${folder}/`)){
  let data='';for await(const chunk of req)data+=chunk;const body=JSON.parse(data),action=url.pathname.split('/').at(-1),e=entries.find(e=>e.id===body.clip);requests.push({action,...body});
  if(action==='open')return json(e);
  if(action==='queue_start'){clipQueue.stage='queued';clipQueue.ticket='a'.repeat(32);return json(clipQueue);}
  if(action==='queue_failed'){clipQueue.stage='interrupted';return json(clipQueue);}
  if(action==='lease')return json({});
  if(holdReview&&['issues','versions'].includes(action))await new Promise(resolve=>heldReviews.push(resolve));
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
  if(action==='civitai_approve'){
   assert.equal(body.revision,states[e.editor_session].revision);writes.push(structuredClone(states[e.editor_session].project));e.name=body.category+'/'+e.name.split('/').at(-1);e.status='approved';e.existing=['approved.funscript'];e.civitai_temporary=false;states[e.editor_session].project.metadata.source.path=e.name;states[e.editor_session].revision++;
   const item=clipQueue.items.find(i=>i.clip===e.id);if(item)Object.assign(item,{state:'approved',name:e.name,note:'Approved video and funscripts saved.'});
   return json({files:['approved.funscript'],listing:listing(),relocated:true,script_versions:{'approved.funscript':'hash'}});
  }
  if(action==='civitai_reject'){entries.splice(entries.indexOf(e),1);ignored.push(e.civitai_id);const item=clipQueue.items.find(i=>i.clip===e.id);if(item)Object.assign(item,{state:'skipped',note:'Rejected or ignored during review.'});return json({deleted:true,listing:listing()});}
  if(action==='approve'){if(body.revision!==states[e.editor_session].revision){res.statusCode=409;return send('Review latest curves','text/plain');}writes.push(structuredClone(states[e.editor_session].project));e.status='approved';e.existing=['a.funscript'];return json({files:['a.funscript'],listing:listing()});}
 }
 if(url.pathname.startsWith('/sam3d_funscript/editors/')){
  const state=states[url.pathname.split('/').at(-1)];if(req.method==='POST'){
   let data='';for await(const chunk of req)data+=chunk;const body=JSON.parse(data);
   if(failSave){res.statusCode=503;return send('Temporary save failure','text/plain');}
   if(body.revision!==state.revision){res.statusCode=409;return send('Conflict','text/plain');}state.project=body.project;state.revision++;return json({revision:state.revision});
  }return json(state);
 }
 if(url.pathname==='/sam3d_funscript/assets/processing-timeline.html')return send(`<p>Timeline preview</p><video muted controls width="480" height="270"></video><script type="module">import {workflowHost} from './workflow-host.mjs';const p=new URLSearchParams(location.search);let waiting;window.s3fTimelineApply=()=>new Promise((resolve,reject)=>{const request=[...crypto.getRandomValues(new Uint8Array(16))].map(v=>v.toString(16).padStart(2,'0')).join('');waiting={request,resolve,reject};workflowHost().postMessage({type:'s3f-timeline-apply',session:p.get('session'),node:p.get('node'),request,plan:{tracking:[],stabilization:[],selection:[0,0]},revision:1},location.origin)});window.addEventListener('message',e=>{if(e.data.request===waiting?.request&&e.data.type==='s3f-timeline-applied'){e.data.error?waiting.reject(Error(e.data.error)):waiting.resolve();waiting=null;}});window.s3fTimelineLoad=async()=>{window.loaded=(window.loaded||0)+1};window.ready=true;</script>`,'text/html');
 if(url.pathname==='/sam3d_funscript/assets/viewer.html')return send(`<p id="value"></p><video muted controls width="480" height="270"></video><script type="module">import {editorSession} from './editor-session.mjs';let project;const session=editorSession({install:p=>{project=p;document.querySelector('#value').textContent=p.metadata.source.path},snapshot:()=>project,status:()=>{}});window.edit=v=>{project.scripts.L0.actions[0].pos=v;session.changed()};await session.load();const update=window.s3fUpdate;window.s3fUpdate=async()=>{window.updated=(window.updated||0)+1;await update()};window.s3fFolderCompare=v=>window.comparison=v;window.s3fFolderSelectRange=(a,b,options)=>{window.range=[a,b];window.rangeOptions=options};window.s3fFolderIssues=v=>window.issues=v;window.s3fFolderPlaySelection=()=>{window.autoplayCalls=(window.autoplayCalls||0)+1;return true};window.ready=true;</script>`,'text/html');
 const name=path.basename(url.pathname),file=url.pathname.startsWith('/sam3d_funscript/assets/')?path.join(root,'assets',name):url.pathname.startsWith('/extensions/s3f/')?path.join(root,'web',name):null;
 if(!file||!fs.existsSync(file)){res.writeHead(404);return res.end();}return send(fs.readFileSync(file),({'.html':'text/html','.css':'text/css'})[path.extname(file)]||'text/javascript');
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://${process.env.S3F_TEST_BROWSER_HOST||'127.0.0.1'}:${server.address().port}`;
const profile=path.join(temp,'chrome'),chrome=spawn('/opt/google/chrome/chrome',['--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-first-run','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore'});
const pause=ms=>new Promise(r=>setTimeout(r,ms));async function until(fn,label){for(let i=0;i<200;i++){if(await fn())return;await pause(50);}throw Error('Timeout: '+label);}
const sockets=[],errors=[];let port;let failureState=async()=>null;
async function connect(target){const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));sockets.push(ws);let id=0;const pending=new Map();ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id){pending.get(m.id)?.(m);pending.delete(m.id);}else if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails);});
 const call=(method,params={})=>new Promise((resolve,reject)=>{const number=++id,timer=setTimeout(()=>reject(Error('CDP timed out')),15000);pending.set(number,m=>{clearTimeout(timer);m.error?reject(Error(JSON.stringify(m.error))):resolve(m.result);});ws.send(JSON.stringify({id:number,method,params}));});
 const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};await call('Runtime.enable');await call('Page.enable');return {call,evaluate};}
try{
 await until(()=>{try{port=fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0];return port;}catch{return false;}},'Chrome');
 const host=await connect((await(await fetch(`http://127.0.0.1:${port}/json`)).json()).find(p=>p.type==='page'));
 await host.call('Page.navigate',{url:base+'/host'});await until(()=>host.evaluate('window.ready'),'host');await host.evaluate("document.querySelector('#open').click()");
 let target;await until(async()=>{target=(await(await fetch(`http://127.0.0.1:${port}/json`)).json()).find(p=>p.url.includes('workspace.html'));return target;},'workspace');
 const w=await connect(target),inspect=w.evaluate,F=`window.s3fWorkspaceFrames().find(p=>p.key==='folder:${folder}').window`;
 failureState=()=>inspect(`({status:${F}.document.querySelector('#status')?.textContent,review:${F}.document.querySelector('#cv-review-status')?.textContent,position:${F}.document.querySelector('#cv-position')?.textContent,category:${F}.document.querySelector('#cv-review-category')?.value,frames:window.s3fWorkspaceFrames().map(p=>p.key)})`);
 const T=e=>`window.s3fWorkspaceFrames().find(p=>p.key==='timeline:${e.timeline}').window`,M=e=>`window.s3fWorkspaceFrames().find(p=>p.key==='motion:${e.editor_session}').window`;
 await until(()=>inspect(`window.s3fWorkspaceFrames?.().length===3&&${F}.document.querySelectorAll('#clips option').length===3&&${M(entries[0])}.ready&&${T(entries[0])}.ready`),'folder tools');
 assert.deepEqual(await inspect("[...document.querySelectorAll('#tabs button')].map(b=>b.textContent)"),['Folder']);
 if(process.env.S3F_TEST_BROWSER_HOST==='0.0.0.0'){
  assert.equal(await inspect(`${F}.isSecureContext`),false);
  assert.equal(await inspect(`typeof ${F}.crypto.randomUUID`),'undefined');
 }
 const click=id=>inspect(`${F}.document.getElementById('${id}').click()`);
 const chooseFolders=async paths=>{
  await click(paths.includes('')?'subfolder-whole':'subfolder-clear');
  for(const name of paths.filter(Boolean))await inspect(`[...${F}.document.querySelectorAll('#subfolder-options input')].find(input=>input.value===${JSON.stringify(name)}).click()`);
 };
 const checkedFolders=()=>inspect(`[...${F}.document.querySelectorAll('#subfolder-options input:checked')].map(input=>input.value)`);
 const screenshot=async(name,selector='#editors')=>{
  if(!process.env.S3F_TEST_SCREENSHOTS)return;
  await w.call('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await inspect(`${F}.document.querySelector('${selector}').scrollIntoView({block:'start'})`);await pause(200);
  fs.mkdirSync(process.env.S3F_TEST_SCREENSHOTS,{recursive:true});
  fs.writeFileSync(path.join(process.env.S3F_TEST_SCREENSHOTS,name+'.png'),Buffer.from((await w.call('Page.captureScreenshot')).data,'base64'));
 };
 // Editors stay loaded in separate tabs. Opening/refreshing never auto-plays;
 // hiding an editor pauses real media, including late playback from that frame.
 const selectedTab=()=>inspect(`${F}.document.querySelector('#editor-tabs [aria-selected=true]').id`);
 const mediaPlaying=win=>inspect(`!${win}.document.querySelector('video').paused`);
 const startMedia=win=>inspect(`(async()=>{const win=${win},video=win.document.querySelector('video');
   if(!video.srcObject){const canvas=win.document.createElement('canvas');canvas.width=480;canvas.height=270;video.srcObject=canvas.captureStream(10);const ctx=canvas.getContext('2d');ctx.fillStyle='#35675c';ctx.fillRect(0,0,480,270);}
   try{await video.play();}catch(error){if(error.name!=='AbortError')throw error;}return !video.paused;})()`);
 assert.equal(await selectedTab(),'timeline-tab');
 assert.equal(await inspect(`${F}.document.querySelector('#result').hidden`),true);
 assert.equal(await inspect(`${F}.document.querySelector('#autoplay').checked`),false);
 await inspect(`window.savedTimeline=${T(entries[0])};window.savedMotion=${M(entries[0])};${F}.s3fFolderViewerReady(window.savedMotion)`);
 assert.equal(await inspect(`${M(entries[0])}.autoplayCalls||0`),0,'Loading Motion Studio does not start playback');
 await inspect(`${T(entries[0])}.s3fPausePreview=()=>{${T(entries[0])}.previewPaused=true;}`);
 assert.equal(await startMedia(T(entries[0])),true);
 await screenshot('timeline');
 await click('motion-tab');
 assert.equal(await selectedTab(),'motion-tab');
 assert.equal(await inspect(`${F}.document.querySelector('#processing').hidden&&!${F}.document.querySelector('#result').hidden`),true);
 assert.equal(await mediaPlaying(T(entries[0])),false,'Switching tabs pauses Timeline');
 assert.equal(await inspect(`${T(entries[0])}.previewPaused`),true,'Pause cancels pending Timeline preview resumption');
 assert.equal(await mediaPlaying(M(entries[0])),false,'Switching tabs leaves Motion Studio paused');
 assert.equal(await startMedia(M(entries[0])),true);
 await inspect(`${M(entries[0])}.edit(67)`);
 await click('timeline-tab');
 assert.equal(await mediaPlaying(M(entries[0])),false,'Switching back pauses Motion Studio');
 assert.equal(await startMedia(M(entries[0])),false,'Hidden Motion Studio cannot start delayed playback');
 await click('motion-tab');
 assert.equal(await startMedia(T(entries[0])),false,'Hidden Timeline cannot start delayed playback');
 assert.equal(await inspect(`window.savedTimeline===${T(entries[0])}&&window.savedMotion===${M(entries[0])}`),true,'Tab changes retain both editor windows');
 await inspect(`${F}.document.querySelector('#motion-tab').dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}))`);
 assert.equal(await selectedTab(),'timeline-tab');
 await inspect(`${F}.s3fOpenWorkspacePage('/sam3d_funscript/assets/viewer.html?session=${entries[0].editor_session}','motion')`);
 assert.equal(await selectedTab(),'motion-tab','Open Motion Studio reveals the existing tab');
 await screenshot('motion-studio');
 holdReview=true;const beforeNext=requests.length;
 await click('next');
 await until(()=>inspect(`window.s3fWorkspaceFrames().some(p=>p.key==='motion:${entries[1].editor_session}')&&${M(entries[1])}.ready`),'switch video');
 assert.equal(states[entries[0].editor_session].project.scripts.L0.actions[0].pos,67,'Switch flushes draft first');
 assert.equal(await selectedTab(),'motion-tab','Clip switching retains the chosen editor');
 assert.equal(await inspect(`${M(entries[1])}.autoplayCalls||0`),0,'Next clip does not auto-play');
 assert.equal(await inspect(`window.s3fWorkspaceFrames().some(p=>p.key==='motion:${entries[0].editor_session}')`),false,'Old Motion Studio is removed');
 assert.equal(await host.evaluate("app.graph._nodes[0].widgets.find(w=>w.name==='video_name').value"),'sub/b.mp4');
 await until(()=>inspect(`!${F}.document.querySelector('#next').disabled`),'next available while review details are slow');
 await until(()=>heldReviews.length===2,'one pending request for issues and versions');
 const opened=requests.slice(beforeNext),openIndex=opened.findIndex(r=>r.action==='open');
 assert.equal(opened.slice(openIndex).filter(r=>r.action==='scan').length,0,'Opening does not scan again after the open response');
 for(const action of ['issues','versions'])assert.equal(opened.filter(r=>r.action===action&&r.clip===entries[1].id).length,1,'Each review detail is requested once');
 holdReview=false;for(const resolve of heldReviews.splice(0))resolve();
 await until(()=>inspect(`${F}.document.querySelector('#issue-count').textContent.includes('ranges to inspect')`),'review details arrive in background');
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
 await chooseFolders(['sub']);
 assert.equal(await inspect(`${F}.document.querySelector('#bulk-count').textContent`),'1 clips to process');
 // Presets, issue navigation and saved versions are available without exporting.
 await until(()=>inspect(`!${F}.document.querySelector('#save-preset').disabled`),'preset ready');
 await inspect(`${F}.document.querySelector('#preset-anchor').value='mouth'`);await click('save-preset');
 try{await until(()=>preset?.preferred_anchor==='mouth','preset saved')}catch(error){console.error(JSON.stringify({preset,status:await inspect(`${F}.document.querySelector('#status').textContent`),recent:requests.slice(-8)},null,2));throw error}
 await until(()=>inspect(`!${F}.document.querySelector('#next-issue').disabled`),'issues loaded');await click('timeline-tab');await click('next-issue');
 await until(()=>inspect(`JSON.stringify(${M(entries[1])}.range)==='[100,500]'`),'issue selects range');
 assert.equal(await selectedTab(),'motion-tab','Review flags reveal Motion Studio');
 assert.equal(await inspect(`${M(entries[1])}.rangeOptions.play`),false,'Review flags stay paused by default');
 await inspect(`${F}.document.querySelector('#autoplay').checked=true`);await click('next-issue');
 await until(()=>inspect(`${M(entries[1])}.rangeOptions.play===true`),'explicit review playback preference');
 await inspect(`${F}.document.querySelector('#autoplay').checked=false`);
 await until(()=>inspect(`!${F}.document.querySelector('#save-version').disabled`),'version ready');
 await inspect(`${F}.document.querySelector('#version-name').value='Dance draft';${F}.document.querySelector('#version-quality').value='5'`);await click('save-version');
 await until(()=>inspect(`${F}.document.querySelectorAll('#versions option').length===2&&!${F}.document.querySelector('#save-version').disabled`),'version saved');
 await inspect(`${F}.document.querySelector('#versions').value='v0';${F}.document.querySelector('#versions').dispatchEvent(new Event('change'))`);
 await click('compare');await until(()=>inspect(`${M(entries[1])}.comparison?.name==='Dance draft'`),'version comparison');
 await until(()=>inspect(`!${F}.document.querySelector('#restore-version').disabled`),'version restore ready');
 await inspect(`${M(entries[1])}.edit(53)`);await click('restore-version');
 await until(()=>inspect(`${F}.document.querySelector('#status').textContent.includes('Version restored')`),'version restored');
 assert.equal(states[entries[1].editor_session].project.scripts.L0.actions[0].pos,20);
 // Folder checkboxes combine disjoint and nested folders without duplicate jobs.
 const extraEntries=[['other/c.mp4','pending'],['sub/nested/d.mp4','pending'],['submarine/excluded.mp4','pending'],['other/existing.mp4','existing'],['other/ready.mp4','pending'],['other/ignored.mp4','ignored']].map(([name,status],i)=>({...entries[1],id:(10+i).toString(16).repeat(32),name,status,existing:status==='existing'?['existing.funscript']:[],batch_result:name.includes('ready')?'ready':undefined}));
 entries.push(...extraEntries);
 await inspect(`${F}.s3fReconnect()`);
 await chooseFolders([]);
 assert.equal(await inspect(`${F}.document.querySelector('#bulk').disabled`),true,'Clearing folders cannot start a whole-library batch');
 assert.equal(await inspect(`${F}.document.querySelector('#bulk-count').textContent`),'0 clips to process');
 await chooseFolders(['sub','sub/nested','other']);
 assert.equal(await inspect(`${F}.document.querySelector('#bulk-count').textContent`),'3 clips to process');
 assert.equal(await inspect(`${F}.document.querySelector('#bulk').textContent`),'Process selected folders');
 assert.equal(await inspect(`${F}.document.querySelector('#save-preset').disabled`),true,'Multi-folder processing keeps each folder preset');
 assert.equal(await inspect(`${F}.document.querySelector('#preset-origin').textContent.includes('Select one folder')`),true);
 await click('subfolder');
 await inspect(`${F}.document.querySelector('#subfolder-search').value='other';${F}.document.querySelector('#subfolder-search').dispatchEvent(new Event('input'))`);
 assert.deepEqual(await inspect(`[...${F}.document.querySelectorAll('#subfolder-options label')].filter(label=>!label.hidden).map(label=>label.textContent)`),['other']);
 await inspect(`${F}.s3fReconnect()`);
 assert.deepEqual(await checkedFolders(),['other','sub','sub/nested'],'Polling keeps all folder selections');
 assert.equal(await inspect(`${F}.document.activeElement.id`),'subfolder-search','Polling does not steal picker focus');
 await inspect(`${F}.document.querySelector('#subfolder-search').value='';${F}.document.querySelector('#subfolder-search').dispatchEvent(new Event('input'))`);
 await screenshot('folder-multi-select','#subfolder-picker');
 await inspect(`${F}.document.querySelector('#subfolder-search').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
 assert.equal(await inspect(`${F}.document.querySelector('#subfolder-menu').hidden`),true);
 assert.equal(await inspect(`${F}.document.activeElement.id`),'subfolder');
 await inspect(`${F}.document.querySelector('#search').value='no-match';${F}.document.querySelector('#search').dispatchEvent(new Event('input'))`);
 assert.equal(await inspect(`${F}.document.querySelector('#bulk-count').textContent`),'3 clips to process','Review filters do not alter processing scope');
 await inspect(`${F}.document.querySelector('#search').value='';${F}.document.querySelector('#search').dispatchEvent(new Event('input'))`);
 const expectedIds=[entries[1].id,extraEntries[0].id,extraEntries[1].id];
 await click('preflight');
 await until(()=>inspect(`!${F}.document.querySelector('#preflight').disabled`),'multi-folder preflight');
 assert.deepEqual(requests.filter(r=>r.action==='preflight').at(-1).clip_ids,expectedIds,'Model check uses the same combined selection');
 await until(()=>inspect(`!${F}.document.querySelector('#bulk').disabled`),'batch ready');
 await click('bulk');await until(()=>batchPrompt,'batch queued');
 const progress=()=>host.evaluate(`api.dispatchEvent(new CustomEvent('s3f_folder_progress',{detail:${JSON.stringify({folder,...batch})}}))`);
 await progress();await until(()=>inspect(`${F}.document.querySelector('#approve').disabled`),'active clip read-only');
 // Review and approve another completed clip while the batch remains active.
 await until(()=>inspect(`!${F}.document.querySelector('#subfolder').disabled`),'batch start returned');
 await chooseFolders(['']);
 await inspect(`${F}.document.querySelector('#clips').value='${entries[0].id}';${F}.document.querySelector('#clips').dispatchEvent(new Event('change'))`);
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
 assert.deepEqual(JSON.parse(batchPrompt.output['9'].inputs.plan_json).folder_batch.clip_ids,expectedIds,'Queued selection remains fixed when review folder filters change');
 await until(()=>inspect(`${F}.document.querySelector('#status').textContent.includes('Batch finished')`),'batch completed');
 assert.equal(writes.length,2,'Bulk does not export; only explicit approvals do');
 entries.splice(3,extraEntries.length);await inspect(`${F}.s3fReconnect()`);
 assert.equal(await inspect(`${F}.document.querySelector('#bulk-count').textContent`),'0 clips to process');
 // Existing-script clips can be opened inside the same workspace.
 await chooseFolders(['']);
 await inspect(`${F}.document.querySelector('#clips').value='${entries[2].id}';${F}.document.querySelector('#clips').dispatchEvent(new Event('change'))`);
 await until(()=>inspect(`window.s3fWorkspaceFrames().some(p=>p.key==='motion:${entries[2].editor_session}')&&${M(entries[2])}.ready`),'existing script open');
 await until(()=>inspect(`!${F}.document.querySelector('#approve').disabled`),'replace ready');
 assert.equal(await inspect(`${F}.document.querySelector('#approve').textContent`),'Approve & replace scripts');
 // Reloading ComfyUI must retain the currently reviewed clip, even if the saved graph points to the first clip.
 await inspect(`${M(entries[2])}.edit(61)`);
 await host.call('Page.reload');await until(()=>host.evaluate('window.ready'),'host reloaded');
 await w.evaluate(`window.dispatchEvent(new Event('focus'))`);
 await until(()=>host.evaluate(`app.graph._nodes[0].properties.s3f_folder_entry.id==='${entries[2].id}'`),'adopt retained folder clip');
 assert.equal(await inspect(`${M(entries[2])}.document.querySelector('#value').textContent`),'existing.mp4');
 assert.equal(await selectedTab(),'motion-tab','ComfyUI reconnect does not change the editor tab');
 assert.equal(await inspect(`${M(entries[2])}.autoplayCalls||0`),0,'Reconnect does not auto-play');
 await inspect(`${T(entries[2])}.s3fTimelineApply()`);
 // Invalid sender cannot approve a different video through the host bridge.
 const before=requests.filter(r=>r.action==='approve').length;await host.evaluate(`window.postMessage({type:'s3f-folder-action',folder:'${folder}',node:9,request:'forged',action:'approve',clip:'${entries[1].id}'},location.origin)`);await pause(100);assert.equal(requests.filter(r=>r.action==='approve').length,before);
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
 // Remote browser lives inside Folder and joins existing clips before any network browsing.
 await click('civitai-tab');await until(()=>inspect(`${F}.document.querySelectorAll('.civitai-card').length===2`),'existing downloads');
 await inspect(`${F}.document.querySelector('#cv-grid').scrollIntoView()`);
 await until(()=>thumbnailRequests.includes(entries[0].id)&&thumbnailRequests.includes(entries[1].id),'local thumbnails loaded');
 assert.equal(videoRequests.length,0,'Thumbnails do not preload or play local videos');
 assert.equal(await inspect(`[...${F}.document.querySelectorAll('.civitai-card video')].every(v=>v.paused&&v.poster.includes('/thumbnail/'))`),true);
 assert.equal(remotePages,0);assert.equal(downloads.length,0);
 assert.equal(await inspect(`${F}.document.querySelector('#cv-connection').open`),true,'Key entry is visible by default');
 assert.equal(await inspect(`${F}.document.querySelector('#cv-key-status').textContent`),'No key configured');
 assert.equal(await inspect(`${F}.document.querySelector('#cv-ratings').value`),'31','New folders request all non-blocked ratings');
 await inspect(`${F}.document.querySelector('#cv-key').value='fixture-key'`);await click('cv-save-key');
 await until(()=>inspect(`${F}.document.querySelector('#cv-key-status').textContent==='Key configured'`),'API key saved');
 assert.equal(await inspect(`${F}.document.querySelector('#cv-key').value`),'','Saved key is cleared from the input');
 assert.equal(remotePages,0);assert.equal(downloads.length,0,'Saving a key does not download anything');
 await click('cv-remove-key');await until(()=>inspect(`${F}.document.querySelector('#cv-key-status').textContent==='No key configured'`),'API key removed');
 await inspect(`${F}.document.querySelector('#cv-view').value='remote';${F}.document.querySelector('#cv-view').dispatchEvent(new Event('change'));${F}.document.querySelector('#cv-sort').value='Newest'`);
 remoteAccessDenied=true;await inspect(`${F}.document.querySelector('#cv-connection').open=false`);await click('cv-browse');
 await until(()=>inspect(`${F}.document.querySelector('#cv-status').textContent.includes('HTTP 401')`),'account access error shown');
 assert.equal(await inspect(`${F}.document.querySelector('#cv-connection').open`),true,'Access errors reveal the key controls');remoteAccessDenied=false;
 await click('cv-browse');await until(()=>inspect(`${F}.document.querySelectorAll('.civitai-card').length===2&&!${F}.document.querySelector('#cv-more').hidden`),'remote page');
 assert.equal(requests.find(r=>r.action==='browse').sort,'Newest');assert.equal(requests.find(r=>r.action==='browse').browsingLevel,31);
 await inspect(`${F}.document.querySelector('#cv-ratings').value='16';${F}.document.querySelector('#cv-ratings').dispatchEvent(new Event('change'))`);
 assert.equal(await inspect(`${F}.document.querySelectorAll('.civitai-card').length`),0,'Rating change clears stale results');
 assert.equal(await inspect(`${F}.document.querySelector('#cv-more').hidden`),true,'Rating change resets pagination');
 assert.equal(await inspect(`JSON.parse(${F}.localStorage.getItem('s3f-civitai:${folder}'))['cv-ratings']`),'16');
 await click('cv-browse');await until(()=>inspect(`${F}.document.querySelectorAll('.civitai-card').length===2&&!${F}.document.querySelector('#cv-more').hidden`),'selected ratings');
 await click('cv-more');await until(()=>inspect(`${F}.document.querySelectorAll('.civitai-card').length===3`),'cursor pagination');
 assert.deepEqual(requests.filter(r=>r.action==='browse').slice(-2).map(r=>[r.browsingLevel,r.cursor||null]),[[16,null],[16,'page2']]);
 assert.deepEqual(await inspect(`[...${F}.document.querySelectorAll('.civitai-card')].map(c=>c.dataset.id)`),['404','405','406']);
 await inspect(`${F}.document.querySelector('#cv-category').value='Dance';${F}.document.querySelector('#cv-category').dispatchEvent(new Event('change'));for(const id of ['404','405'])${F}.document.querySelector('[data-id="'+id+'"] .cv-check').click()`);
 assert.equal(await inspect(`${F}.document.querySelectorAll('.civitai-card.selected').length`),2,'Selected cards are highlighted');
 assert.equal(await inspect(`${F}.document.querySelectorAll('#cv-selection button').length`),2,'Selection lists the exact clips');
 await click('cv-process');await until(()=>clipQueue.items.length===2,'selection saved in queue');
 assert.equal(downloads.length,0,'Adding to queue does not start downloads');assert.equal(batchRunning,false);
 await click('cv-refresh');await until(()=>inspect(`${F}.document.querySelectorAll('.cv-queue-list li').length===2`),'queue restored from server');
 await inspect(`${F}.document.querySelector('[data-start]').click()`);await until(()=>batchRunning&&downloads.length===2,'server queue submitted');
 const staged=entries.filter(e=>e.civitai_temporary);assert.equal(staged.length,2);
 assert.equal(JSON.parse(batchPrompt.output['9'].inputs.plan_json).folder_queue.ticket,clipQueue.ticket);
 assert.equal(writes.length,3,'Download and bulk must not approve');assert.equal(downloads.includes('406'),false);
 await inspect(`${F}.document.querySelector('[data-id="406"] .cv-check').click()`);await click('cv-process');
 await until(()=>inspect(`${F}.document.querySelectorAll('.cv-queue-list li').length===3&&${F}.document.querySelector('.cv-queue-list li:last-child strong').textContent.includes('406')`),'add to running queue');
 await inspect(`${F}.document.querySelector('.cv-queue-list li:last-child button:last-child').click()`);
 await until(()=>clipQueue.items.length===2,'remove waiting clip');assert.deepEqual(clipQueue.items.map(i=>i.id),['404','405']);assert.equal(downloads.includes('406'),false);
 for(const e of staged){e.processing=false;e.batch_result='ready';}batch.stage='complete';batch.completed=staged.map(e=>e.name);batch.current=batch.current_id=null;batchRunning=false;batchComplete=true;
 clipQueue.stage='complete';for(const item of clipQueue.items)item.state='ready';
 await until(()=>inspect(`${F}.document.querySelector('#status').textContent.includes('Batch finished')`),'selected batch complete');
 await click('cv-refresh');
 await inspect(`${F}.document.querySelector('#cv-grid').scrollIntoView()`);
 await until(()=>staged.every(e=>thumbnailRequests.includes(e.id)),'temporary downloads get local thumbnails');
 assert.equal(videoRequests.length,0,'Temporary thumbnail loading leaves videos paused');
 await inspect(`${F}.document.querySelector('[data-review]').click()`);
 await until(()=>inspect(`!${F}.document.querySelector('#cv-review-panel').hidden&&window.s3fWorkspaceFrames().some(p=>p.key==='motion:${staged[0].editor_session}')&&${M(staged[0])}.ready&&!${F}.document.querySelector('#cv-approve').disabled`),'first staged review');
 assert.equal(await inspect(`${F}.document.querySelector('#local-panel').hidden`),true);assert.equal(await inspect(`${F}.document.querySelector('#clip-workbench').hidden`),false);
 await inspect(`${M(staged[0])}.edit(88)`);await click('cv-approve');
 await until(()=>inspect(`window.s3fWorkspaceFrames().some(p=>p.key==='motion:${staged[1].editor_session}')&&${M(staged[1])}.ready&&!${F}.document.querySelector('#cv-reject').disabled`),'approve and next');
 assert.equal(writes.length,4);assert.equal(writes[3].scripts.L0.actions[0].pos,88,'Approval flushes manual edits');assert.ok(staged[0].name.startsWith('Dance/'));assert.equal(staged[0].civitai_temporary,false);
 await click('cv-reject');await until(()=>!entries.includes(staged[1]),'reject temporary');
 await until(()=>inspect(`${F}.document.querySelector('#cv-review-panel').hidden`),'review ends');
 assert.equal(entries.includes(staged[0]),true);assert.equal(entries.includes(entries[0]),true);assert.equal(downloads.length,2,'Review reuses downloaded videos');
 await inspect(`${F}.document.querySelector('[data-id="406"] button').click()`);
 await until(()=>batchRunning&&downloads.includes('406'),'single review auto-processing');
 const undecided=entries.find(e=>e.civitai_id==='406');assert.deepEqual(JSON.parse(batchPrompt.output['9'].inputs.plan_json).folder_batch.clip_ids,[undecided.id]);
 undecided.processing=false;undecided.batch_result='ready';batch.stage='complete';batch.current=batch.current_id=null;batch.completed=[undecided.name];batchRunning=false;batchComplete=true;
 await until(()=>inspect(`${F}.document.querySelector('#status').textContent.includes('Batch finished')&&!${F}.document.querySelector('#cv-later').disabled&&${M(undecided)}.ready`),'single clip complete');
 await inspect(`${M(undecided)}.edit(64)`);await click('cv-later');
 await until(()=>inspect(`${F}.document.querySelector('#cv-review-panel').hidden`),'leave unsorted');
 assert.equal(states[undecided.editor_session].project.scripts.L0.actions[0].pos,64);assert.equal(undecided.civitai_temporary,true);assert.equal(writes.length,4);
 assert.equal(await inspect(`${F}.document.querySelector('#cv-resume').textContent`),'Review temporary clips (1)');
 await click('cv-resume');await until(()=>inspect(`${M(undecided)}.ready&&!${F}.document.querySelector('#cv-approve').disabled`),'resume undecided');
 assert.equal(downloads.length,3);assert.equal(states[undecided.editor_session].project.scripts.L0.actions[0].pos,64);
 await inspect(`${F}.document.querySelector('#cv-review-new-category').value='Reviewed/Dance'`);await click('cv-review-add-category');
 await until(()=>inspect(`${F}.document.querySelector('#cv-review-category').value==='Reviewed/Dance'`),'category from review');
 const captures=path.join(root,'development/civitai-browser');fs.mkdirSync(captures,{recursive:true});await w.call('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
 await inspect(`${F}.scrollTo(0,0)`);fs.writeFileSync(path.join(captures,'review.png'),Buffer.from((await w.call('Page.captureScreenshot')).data,'base64'));
 await click('cv-back');await until(()=>inspect(`${F}.document.querySelector('#cv-review-panel').hidden`),'return gallery');
 await inspect(`${F}.scrollTo(0,0)`);fs.writeFileSync(path.join(captures,'gallery.png'),Buffer.from((await w.call('Page.captureScreenshot')).data,'base64'));
 await click('local-tab');assert.equal(await inspect(`${F}.document.querySelector('#local-panel').hidden`),false);
 // Random review mixes folders, keeps its order through saves/polls, and resumes.
 const addReviewClip=(name,number)=>{
  const id=number.toString(16).repeat(16),entry={id,name,status:'pending',timeline:'8'+id.slice(1),editor_session:'9'+id.slice(1),draft:true,batch_result:'ready',quality:0,existing:[],note:''};
  entries.push(entry);versions[id]=[];states[entry.editor_session]={revision:1,project:{metadata:{source:{path:name}},scripts:{L0:{actions:[{at:0,pos:20}]}},timeline:{sources:[],tracks:[],main:{},selection:[0,0]}}};return entry;
 };
 const reviewClips=['alpha/a','alpha/b','alpha/c','alpha/d','beta/a','beta/b','gamma/a','gamma/b'].map((name,i)=>addReviewClip('shuffle/'+name+'.mp4',40+i));
 await inspect(`${F}.s3fReconnect()`);await chooseFolders(['']);
 const selectValue=(id,value)=>inspect(`${F}.document.getElementById(${JSON.stringify(id)}).value=${JSON.stringify(value)};${F}.document.getElementById(${JSON.stringify(id)}).dispatchEvent(new Event('change'))`);
 const reviewIds=()=>inspect(`[...${F}.document.querySelectorAll('#clips option')].map(option=>option.value)`);
 const currentId=()=>host.evaluate('app.graph._nodes[0].properties.s3f_folder_entry.id');
 const readyClip=async entry=>until(()=>inspect(`${F}.s3fFolderIdentity?.().entry?.id==='${entry.id}'&&${M(entry)}?.ready&&!${F}.document.querySelector('#next').disabled`),'review clip '+entry.name);
 await selectValue('quality-filter','all');await selectValue('filter','ready');
 await inspect(`${F}.document.querySelector('#search').value='shuffle/';${F}.document.querySelector('#search').dispatchEvent(new Event('input'))`);
 await selectValue('clips',reviewClips[0].id);await readyClip(reviewClips[0]);
 await selectValue('review-order','random');
 let order=await reviewIds();assert.equal(order[0],reviewClips[0].id,'Random order starts from the open clip');
 const parent=id=>entries.find(e=>e.id===id).name.split('/').slice(0,-1).join('/');
 assert.equal(new Set(order.slice(0,3).map(parent)).size,3,'First pass visits every folder before repeating a folder');
 assert.equal(new Set(order).size,reviewClips.length,'Each clip occurs once in the random order');
 await inspect(`${F}.s3fReconnect()`);assert.deepEqual(await reviewIds(),order,'Refreshing does not reshuffle');
 const added=addReviewClip('shuffle/gamma/new.mp4',48);reviewClips.push(added);
 await inspect(`${F}.s3fReconnect()`);assert.deepEqual(await reviewIds(),[...order,added.id],'New drafts join at the end without moving existing clips');order.push(added.id);
 await click('approve-next');await readyClip(entries.find(e=>e.id===order[1]));
 assert.equal(reviewClips[0].status,'approved');assert.deepEqual(await reviewIds(),order.slice(1),'Approval advances in the existing random order');
 await click('ignore-next');await readyClip(entries.find(e=>e.id===order[2]));
 assert.equal(entries.find(e=>e.id===order[1]).status,'ignored');assert.deepEqual(await reviewIds(),order.slice(2),'Ignore advances in the same order');
 const remaining=order.slice(2),visited=[await currentId()];
 for(const id of remaining.slice(1)){await click('next');await readyClip(entries.find(e=>e.id===id));visited.push(await currentId());}
 assert.deepEqual(visited,remaining,'Next visits each remaining clip once before wrapping');
 await click('next');await readyClip(entries.find(e=>e.id===remaining[0]));
 await click('previous');await readyClip(entries.find(e=>e.id===remaining.at(-1)));
 await chooseFolders(['shuffle/beta','shuffle/gamma']);
 const filtered=reviewClips.filter(e=>e.status==='pending'&&(e.name.startsWith('shuffle/beta/')||e.name.startsWith('shuffle/gamma/'))).map(e=>e.id);
 assert.deepEqual(new Set(await reviewIds()),new Set(filtered),'Random order respects selected folders and draft status');
 await click('reshuffle');const remixed=await reviewIds();assert.equal(remixed[0],await currentId(),'Reshuffle keeps the current clip open');
 assert.notEqual(parent(remixed[0]),parent(remixed[1]),'Reshuffle follows with another available folder');
 await screenshot('random-review','#review-order-controls');
 // Restore the default filters before reloading so the saved scope matches.
 await chooseFolders(['']);await selectValue('filter','active');
 await inspect(`${F}.document.querySelector('#search').value='';${F}.document.querySelector('#search').dispatchEvent(new Event('input'))`);
 const retainedOrder=await reviewIds(),retainedClip=await currentId();
 await inspect(`${F}.shuffleBeforeReload=true;${F}.location.reload()`);
 await until(()=>inspect(`${F}.shuffleBeforeReload===undefined&&${F}.document.querySelector('#review-order')?.value==='random'&&${F}.document.querySelectorAll('#clips option').length===${retainedOrder.length}`),'random mode restored after reload');
 assert.deepEqual(await reviewIds(),retainedOrder,'Browser reload restores the stable order for this library');
 await readyClip(entries.find(e=>e.id===retainedClip));
 await selectValue('review-order','alphabetical');assert.equal(await inspect(`${F}.document.querySelector('#reshuffle').disabled`),true);
 assert.deepEqual(await reviewIds(),entries.filter(e=>e.status!=='ignored').map(e=>e.id),'Alphabetical mode restores the server listing order');
 await inspect(`${F}.scrollTo(0,0)`);
 const output=path.join(root,'development/folder-browser');fs.mkdirSync(output,{recursive:true});await w.call('Emulation.setDeviceMetricsOverride',{width:1400,height:900,deviceScaleFactor:1,mobile:false});fs.writeFileSync(path.join(output,'folder.png'),Buffer.from((await w.call('Page.captureScreenshot')).data,'base64'));
 assert.deepEqual(errors,[]);console.log('PASS: folder/workspace bridge, edit flush, approval, failed-save protection, concurrent review, versions, shortcuts; Civitai tab, existing downloads, API sorting/pagination, selected-only bulk, temporary review, manual edits, approve/category/next and reject temporary.');
}catch(error){console.error(JSON.stringify({errors,state:await failureState(),requests:requests.slice(-5)},null,2));throw error;}finally{for(const ws of sockets)ws.close();const exited=new Promise(r=>chrome.once('exit',r));chrome.kill('SIGTERM');await exited;server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(temp,{recursive:true,force:true});}
