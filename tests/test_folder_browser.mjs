// Real folder UI, workspace and ComfyUI bridge; neutral in-memory editor backend.
import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import http from 'node:http';import {spawn,spawnSync} from 'node:child_process';
const root=path.resolve('.'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'s3f-folder-browser-')),folder='f'.repeat(32);
const entries=['a.mp4','sub/b.mp4','existing.mp4'].map((name,i)=>({id:String(i+1).repeat(32),name,status:i===2?'existing':'pending',timeline:String(i+4).repeat(32),editor_session:String(i+7).repeat(32),draft:true,quality:0,audio_sync:false,intensity:0,existing:i===2?['existing.funscript']:[],note:''}));
const states=Object.fromEntries(entries.map(e=>[e.editor_session,{revision:1,project:{metadata:{source:{path:e.name}},scripts:{L0:{actions:[{at:0,pos:20}]}},timeline:{sources:[],tracks:[],main:{},selection:[0,0]}}}]));
let queued=false,failSave=false,batchPrompt=null,batchRunning=false,batchComplete=false,batch=null;const versions=Object.fromEntries(entries.map(e=>[e.id,[]]));let preset=null;const writes=[],requests=[];
let holdReview=false;const heldReviews=[];
let failBulkLabels=false;
let datasetState={repo:'tester/Example',use_folder_approval:false,video_metadata:true,available:true,authenticated:true,busy:false,job:{stage:'idle'},last_upload:null};
const datasetSnapshots=[];
let tagState={incremental:true,stage:'complete',completed:170,total:170,errors:[],source:'both',frames:3,threshold:.35,site:'civitai.red'};
let holdEditorSession=null,holdVideoSession=null;const heldEditorReads=[],heldVideoReads=[];
const clip=path.join(temp,'neutral.mp4');
const encode=spawnSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=0x35675c:size=480x270:rate=10','-t','2','-c:v','libx264','-pix_fmt','yuv420p','-movflags','+faststart',clip]);
assert.equal(encode.status,0,encode.stderr.toString());
let h3Book=null, h3Trial=null;
const listing=()=>({...(h3Book?{h3:h3Book}:{}),folder,root:'/neutral/videos',recursive:true,entries,batch,bulk_audio_sync:true,tagging:true,bulk_reprocess:true,dataset_upload:true,counts:Object.fromEntries(['pending','approved','existing','ignored'].map(s=>[s,entries.filter(e=>e.status===s).length]))});
let remotePages=0,tokenConfigured=false,remoteAccessDenied=false;const downloads=[],categories=['Dance'],ignored=[],thumbnailRequests=[],videoRequests=[];
let clipQueue={stage:'idle',items:[]};
let holdGallery=false;const heldGalleries=[];
let cvMetadata={known:0,total:3,job:{stage:'idle',completed:0,total:0,errors:[]}};
function stageClip(body){
 downloads.push(body.id);const id=Number(body.id).toString(16).padStart(32,'0'),e={id,name:'.s3f-civitai-review/'+body.id+'/Neutral_civitai_'+body.id+'_original.mp4',status:'pending',timeline:'d'+id.slice(1),editor_session:'e'+id.slice(1),draft:true,quality:0,audio_sync:false,intensity:0,existing:[],note:'',civitai_id:body.id,civitai_temporary:true,category_hint:body.category};entries.push(e);versions[e.id]=[];
 states[e.editor_session]={revision:1,project:{metadata:{source:{path:e.name}},scripts:{L0:{actions:[{at:0,pos:20}]}},timeline:{sources:[],tracks:[],main:{},selection:[0,0]}}};return {...e,category:body.category,processed:false};
}
let holdOpenClip=null,releaseOpen=null,failOpenClip=null;
const cvLibrary=()=>({folder,root:'/neutral/videos',recursive:true,categories,ignored,downloads:{},token_configured:tokenConfigured,queue:clipQueue,video_galleries:true,metadata:cvMetadata,
 items:Object.fromEntries(entries.map((e,i)=>[e.civitai_id||String(101+i),[{...e,category:e.category_hint||'Dance',processed:!!e.existing.length||e.batch_result==='ready'}]]))});
const legacyFolderAPI=process.env.S3F_TEST_LEGACY_FOLDER==='1';
const clipListing=e=>({folder,partial:true,entries:[e]});
const mutationListing=(body,e)=>body.compact&&!legacyFolderAPI?clipListing(e):listing();
const intensityResult=e=>({clip:e.id,revision:states[e.editor_session].revision,level:Math.max(1,Math.ceil(states[e.editor_session].project.scripts.L0.actions[0].pos/20)),typical_range:80,cycles_per_second:1,axis:'L0'});
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');res.setHeader('Cache-Control','no-store');const send=(s,t='text/javascript')=>{res.setHeader('Content-Type',t);res.end(s);};const json=x=>send(JSON.stringify(x),'application/json');
 if(url.pathname==='/host')return send(`<button id="open">Open</button><script type="module">import {app} from '/scripts/app.js';import {api} from '/scripts/api.js';window.api=api;import {openWorkspace} from '/extensions/s3f/workspace.mjs';import '/extensions/s3f/processing-timeline.js';for(const e of app.extensions)e.setup?.();document.querySelector('#open').onclick=()=>openWorkspace(app.graph._nodes[0]);window.app=app;window.ready=true;</script>`,'text/html');
 if(url.pathname==='/scripts/app.js')return send(`const node={id:9,type:'S3F_FolderTimeline',properties:{s3f_folder:'${folder}',s3f_folder_entry:${JSON.stringify(entries[0])},s3f_timeline_session:'${entries[0].timeline}',s3f_timeline_ready:true},widgets:[{name:'folder_path',value:'/neutral/videos'},{name:'video_name',value:'a.mp4'},{name:'plan_json',value:'{}'}],s3fTimelineStatus:{},setDirtyCanvas(){}};export const app={extensions:[],registerExtension(e){this.extensions.push(e)},queuePrompt:async()=>{},async graphToPrompt(){return {output:{9:{class_type:node.type,inputs:{folder_path:'/neutral/videos',video_name:node.widgets.find(w=>w.name==='video_name').value}},99:{class_type:'Unrelated',inputs:{}}},workflow:{nodes:[JSON.parse(JSON.stringify(node))]}}},graph:{_nodes:[node],links:{},getNodeById(id){return Number(id)===9?node:null},change(){}}};`);
 if(url.pathname==='/scripts/api.js')return send(`export const api=new EventTarget();api.apiURL=p=>p;api.fetchApi=(p,o)=>fetch(p,o);api.queuePrompt=async(n,p)=>{const r=await fetch('/prompt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(p)});return r.json()};`);
 if(url.pathname==='/neutral.mp4'){
  if(url.searchParams.get('session')===holdVideoSession)await new Promise(resolve=>heldVideoReads.push(resolve));
  return send(fs.readFileSync(clip),'video/mp4');
 }
 if(url.pathname==='/sam3d_funscript/reference-capabilities')return json({});
 if(url.pathname==='/prompt'){
  let body='';for await(const chunk of req)body+=chunk;batchPrompt=JSON.parse(body);batchRunning=true;batchComplete=false;
  const plan=JSON.parse(batchPrompt.output['9'].inputs.plan_json);
  if(plan.h3_trial){h3Trial=plan.h3_trial;batchRunning=false;return json({prompt_id:'h3-trial-job'});}
  let ids=plan.folder_batch?.clip_ids;
  if(plan.folder_queue){assert.equal(plan.folder_queue.ticket,clipQueue.ticket);clipQueue.stage='running';ids=clipQueue.items.filter(i=>i.state==='waiting').map(item=>{const e=stageClip(item);item.clip=e.id;item.name=e.name;item.state='processing';return e.id;});}
  const candidate=ids?entries.find(e=>e.id===ids[0]):entries[1];candidate.processing=true;batch={stage:'running',total:ids?.length||1,completed:[],failed:[],skipped:[],deferred:[],current:candidate.name,current_id:candidate.id};return json({prompt_id:'bulk-job'});
 }
 if(url.pathname==='/history/h3-trial-job')return json({'h3-trial-job':{outputs:{9:{s3f_h3_trial:[{clip:h3Trial.clip,start_ms:0,end_ms:2000,anchor:h3Trial.anchor,scripts:{L0:{actions:[{at:0,pos:20},{at:1000,pos:80},{at:2000,pos:20}]}},warnings:[],images:[],pixels:[],times_ms:[]}]}},status:{messages:[]}}});
 if(url.pathname==='/history/bulk-job'){
  if(!batchComplete)return json({});
  return json({'bulk-job':{outputs:{9:{s3f_folder:[folder],s3f_folder_batch:[batch]}},status:{messages:[]}}});
 }
 if(url.pathname==='/queue')return json({queue_running:queued?[[0,'job',{'9':{class_type:'S3F_FolderTimeline',inputs:{folder_path:'/neutral/videos'}}}]]:batchRunning?[[0,'bulk-job',batchPrompt.output]]:[],queue_pending:[]});
 if(url.pathname===`/sam3d_funscript/folders/${folder}`){const clip=url.searchParams.get('clip');requests.push({action:clip&&!legacyFolderAPI?'clip-status':'scan',clip,refresh:url.searchParams.get('refresh')});return json(clip&&!legacyFolderAPI?clipListing(entries.find(e=>e.id===clip)):listing());}
 if(url.pathname===`/sam3d_funscript/civitai/${folder}`)return json(cvLibrary());
 if(url.pathname===`/sam3d_funscript/h3/${folder}/image`)return send('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="160"><rect width="120" height="160" fill="#486a75"/></svg>','image/svg+xml');
 if(url.pathname===`/sam3d_funscript/h3/${folder}/probe`){
  let data='';for await(const chunk of req)data+=chunk;const probeBody=JSON.parse(data);requests.push({action:'h3-probe',...probeBody});
  return json({confidence:h3Book.confidence,message:'Person boxes only.',samples:[{at_ms:probeBody.clip?100:null,people:[{box:[.1,.1,.8,.9],confidence:.7}],image:'data:image/svg+xml;base64,'+Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="160"><rect width="120" height="160" fill="#486a75"/></svg>').toString('base64')}]});
 }
 if(url.pathname.startsWith(`/sam3d_funscript/civitai/${folder}/thumbnail/`)){
  thumbnailRequests.push(url.pathname.split('/').at(-1));
  return send('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#326f7d"/><circle cx="160" cy="85" r="45" fill="#a1c7b8"/><text x="160" y="158" text-anchor="middle" fill="white">Neutral video preview</text></svg>','image/svg+xml');
 }
 if(url.pathname.startsWith(`/sam3d_funscript/civitai/${folder}/local/`))videoRequests.push(url.pathname);
 if(url.pathname.startsWith(`/sam3d_funscript/civitai/${folder}/`)){
  let data='';for await(const chunk of req)data+=chunk;const body=data?JSON.parse(data):{},action=url.pathname.split('/').at(-1);
  if(action==='key'){tokenConfigured=!!body.token;return json({configured:tokenConfigured});}
  if(action==='metadata_start'){requests.push({action,...body});cvMetadata.job={stage:'running',completed:0,total:3,skipped:0,errors:[]};return json(cvMetadata.job);}
  if(action==='metadata_stop'){requests.push({action,...body});cvMetadata.job.stage='stopped';return json(cvMetadata.job);}
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
  if(action==='gallery'){
   requests.push({action,...body});if(holdGallery)await new Promise(resolve=>heldGalleries.push(resolve));
   const ids=body.kind==='creator'?[407,409,101]:body.cursor?[408]:[404,407,101];
   return json({items:ids.map(id=>({id:String(id),username:'Neutral creator',post_id:id===409?'9002':'9001',url:base+'/neutral.mp4',page:'https://civitai.com/images/'+id})),next_cursor:body.kind==='post'&&!body.cursor?'post2':null,library:cvLibrary(),gallery:{kind:body.kind,id:body.id,post_id:body.kind==='post'?'9001':null,username:'Neutral creator'}});
  }
  if(action==='download')return json({entry:stageClip(body),reused:false});
  if(action==='category'){categories.push(body.name);return json(cvLibrary());}
 }
 if(url.pathname.startsWith(`/sam3d_funscript/folders/${folder}/`)){
  let data='';for await(const chunk of req)data+=chunk;const body=JSON.parse(data),action=url.pathname.split('/').at(-1),e=entries.find(e=>e.id===body.clip);requests.push({action,...body});
  if(action==='open'){
   if(body.clip===holdOpenClip)await new Promise(resolve=>{releaseOpen=resolve;});
   if(body.clip===failOpenClip){res.statusCode=503;return send('Temporary clip open failure','text/plain');}
   return json(e);
  }
  if(action==='h3_preset')return json({scope:body.panel?'panel:'+body.panel:body.page?'page:'+body.page:'project',overridden:!!body.settings,settings:body.settings||{confidence:.25,preferred_anchor:'pelvis',smoothing_ms:40,sample_fps:6,range_mode:'adaptive',movement_range:.2,batch_size:8,cut_sensitivity:'normal'}});
  if(action==='h3_save_draft'||action==='h3_restore_draft'){assert.equal(body.revision,states[e.editor_session].revision);return json({listing:listing()});}
  if(action==='h3_confidence'){h3Book.confidence=body.confidence;return json(listing());}
  if(action==='h3_exclude_page'){
   h3Book.excluded_pages=body.excluded?[...h3Book.excluded_pages,body.page]:h3Book.excluded_pages.filter(p=>p!==body.page);
   for(const entry of entries.filter(e=>e.h3?.page_id===body.page)){entry.h3.page_excluded=body.excluded;entry.status=body.excluded?'ignored':'pending';}
   return json(listing());
  }
  if(action==='queue_start'){clipQueue.stage='queued';clipQueue.ticket='a'.repeat(32);return json(clipQueue);}
  if(action==='queue_failed'){clipQueue.stage='interrupted';return json(clipQueue);}
  if(action==='lease')return json({});
  if(action==='intensity')return json(intensityResult(e));
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
  if(action==='tags_status')return json(tagState);
  if(action==='dataset_status')return json(datasetState);
  if(action==='dataset_upload'){
   datasetSnapshots.push(structuredClone({states,entries}));
   datasetState={...datasetState,...body,busy:true,job:{stage:'building',repo:body.repo}};return json(datasetState);
  }
  if(action==='tags_start'){
   const total=body.force?body.clip_ids.length:0;
   tagState={...tagState,...body,started_at:new Date().toISOString(),stage:'complete',completed:total,total,skipped:body.clip_ids.length-total,errors:[]};return json(tagState);
  }
  if(action==='review'){if(body.tags)e.tags=body.tags.map(t=>t.trim()).filter(Boolean).sort();e.quality=body.quality;e.note=body.note;if(body.audio_sync!==undefined)e.audio_sync=body.audio_sync;if(body.intensity!==undefined)e.intensity=body.intensity;if(body.intensity_mode){e.intensity_mode=body.intensity_mode;if(body.intensity_mode==='auto')e.intensity=intensityResult(e).level;}return json(mutationListing(body,e));}
  if(action==='review_audio_sync'){
   if(failBulkLabels){res.statusCode=503;return send('Label save unavailable','text/plain');}
   const chosen=entries.filter(e=>body.clip_ids.includes(e.id)),updated=chosen.filter(e=>e.audio_sync!==body.audio_sync).length;
   for(const entry of chosen)entry.audio_sync=body.audio_sync;
   return json({listing:listing(),matched:chosen.length,updated});
  }
  if(action==='ignore'){e.status=body.ignored?'ignored':'pending';e.note=body.note;return json(mutationListing(body,e));}
  if(action==='civitai_approve'){
   assert.ok(body.category?.trim(),'Temporary approval requires a destination');
   assert.equal(body.revision,states[e.editor_session].revision);writes.push(structuredClone(states[e.editor_session].project));e.name=body.category+'/'+e.name.split('/').at(-1);e.status='approved';e.existing=['approved.funscript'];e.civitai_temporary=false;states[e.editor_session].project.metadata.source.path=e.name;states[e.editor_session].revision++;
   const item=clipQueue.items.find(i=>i.clip===e.id);if(item)Object.assign(item,{state:'approved',name:e.name,note:'Approved video and funscripts saved.'});
   return json({files:['approved.funscript'],listing:listing(),relocated:true,script_versions:{'approved.funscript':'hash'}});
  }
  if(action==='civitai_reject'){entries.splice(entries.indexOf(e),1);ignored.push(e.civitai_id);const item=clipQueue.items.find(i=>i.clip===e.id);if(item)Object.assign(item,{state:'skipped',note:'Rejected or ignored during review.'});return json({deleted:true,listing:listing()});}
  if(action==='approve'){if(body.revision!==states[e.editor_session].revision){res.statusCode=409;return send('Review latest curves','text/plain');}writes.push(structuredClone(states[e.editor_session].project));e.status='approved';e.existing=['a.funscript'];return json({files:['a.funscript'],listing:mutationListing(body,e)});}
 }
 if(url.pathname.startsWith('/sam3d_funscript/editors/')){
  const state=states[url.pathname.split('/').at(-1)];if(req.method==='POST'){
   let data='';for await(const chunk of req)data+=chunk;const body=JSON.parse(data);
   if(failSave){res.statusCode=503;return send('Temporary save failure','text/plain');}
   if(body.revision!==state.revision){res.statusCode=409;return send('Conflict','text/plain');}state.project=body.project;state.revision++;return json({revision:state.revision});
  }if(url.pathname.endsWith('/'+holdEditorSession))await new Promise(resolve=>heldEditorReads.push(resolve));return json(state);
 }
 if(url.pathname==='/sam3d_funscript/assets/processing-timeline.html')return send(`<p>Timeline preview</p><video muted controls width="480" height="270"></video><script type="module">import {workflowHost} from './workflow-host.mjs';const p=new URLSearchParams(location.search);let waiting;window.s3fTimelineApply=()=>new Promise((resolve,reject)=>{const request=[...crypto.getRandomValues(new Uint8Array(16))].map(v=>v.toString(16).padStart(2,'0')).join('');waiting={request,resolve,reject};workflowHost().postMessage({type:'s3f-timeline-apply',session:p.get('session'),node:p.get('node'),request,plan:{tracking:[],stabilization:[],selection:[0,0]},revision:1},location.origin)});window.addEventListener('message',e=>{if(e.data.request===waiting?.request&&e.data.type==='s3f-timeline-applied'){e.data.error?waiting.reject(Error(e.data.error)):waiting.resolve();waiting=null;}});window.s3fTimelineLoad=async()=>{window.loaded=(window.loaded||0)+1};window.ready=true;window.s3fEditorReady=true;window.parent.s3fFolderEditorReady?.(window);</script>`,'text/html');
 if(url.pathname==='/sam3d_funscript/assets/viewer.html')return send(`<style>body{min-height:2500px}</style><p id="value"></p><video muted controls width="480" height="270"></video><script type="module">import {editorSession} from './editor-session.mjs';let project;const session=editorSession({install:p=>{project=p;document.querySelector('#value').textContent=p.metadata.source.path},snapshot:()=>project,status:()=>{}});window.edit=v=>{project.scripts.L0.actions[0].pos=v;session.changed()};await session.load();document.querySelector('video').src='/neutral.mp4?session='+new URLSearchParams(location.search).get('session');const update=window.s3fUpdate;window.s3fUpdate=async()=>{window.updated=(window.updated||0)+1;await update()};window.s3fFolderCompare=v=>window.comparison=v;window.s3fFolderSelectRange=(a,b,options)=>{window.range=[a,b];window.rangeOptions=options};window.s3fFolderIssues=v=>window.issues=v;window.s3fFolderPlaySelection=()=>{window.autoplayCalls=(window.autoplayCalls||0)+1;return true};window.ready=true;window.s3fEditorReady=true;window.parent.s3fFolderEditorReady?.(window);</script>`,'text/html');
 const name=path.basename(url.pathname),file=url.pathname.startsWith('/sam3d_funscript/assets/')?path.join(root,'assets',name):url.pathname.startsWith('/extensions/s3f/')?path.join(root,'web',name):null;
 // Reproduce an older main tab that rejects this newer metadata action.
 if(file&&name==='folder.mjs')return send(fs.readFileSync(file,'utf8').replace("'review','review_audio_sync','lease'","'review','lease'"));
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
 await until(()=>inspect(`${F}.document.querySelectorAll('[aria-busy=true]').length===0`),'initial editor reveal');
 assert.deepEqual(await inspect("[...document.querySelectorAll('#tabs button')].map(b=>b.textContent)"),['Folder']);
 if(process.env.S3F_TEST_BROWSER_HOST==='0.0.0.0'){
  assert.equal(await inspect(`${F}.isSecureContext`),false);
  assert.equal(await inspect(`typeof ${F}.crypto.randomUUID`),'undefined');
 }
 const click=id=>inspect(`${F}.document.getElementById('${id}').click()`);
 assert.equal(await inspect(`${F}.document.querySelector('#prefetch').checked`),true,'Next clip preloading is on by default');
 await click('prefetch'); // Test cold transitions first, then preloading below.
 const selectValue=(id,value)=>inspect(`${F}.document.getElementById(${JSON.stringify(id)}).value=${JSON.stringify(value)};${F}.document.getElementById(${JSON.stringify(id)}).dispatchEvent(new Event('change'))`);
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
 assert.equal(await inspect(`new Set([...${F}.document.querySelectorAll('[id]')].map(e=>e.id)).size===${F}.document.querySelectorAll('[id]').length`),true,'Folder control IDs are unique');
 assert.equal(await inspect(`[...${F}.document.querySelectorAll('#folder-tool-panels>details')].every(e=>e.hidden)`),true,'Folder tools do not stack above review by default');
 await click('tool-bulk-review-panel');
 assert.equal(await inspect(`${F}.document.querySelector('#tool-bulk-review-panel').getAttribute('aria-expanded')`),'true');
 await click('tool-tags-panel');
 assert.deepEqual(await inspect(`[...${F}.document.querySelectorAll('#folder-tool-panels>details')].filter(e=>!e.hidden).map(e=>e.id)`),['tags-panel'],'Only the chosen folder tool is shown');
 await click('tool-tags-panel');
 assert.equal(await inspect(`[...${F}.document.querySelectorAll('#folder-tool-panels>details')].every(e=>e.hidden)`),true,'Click again collapses the tool');
 await screenshot('folder-compact','header');
 await click('tool-bulk-review-panel');
 await w.call('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
 assert.equal(await inspect(`(()=>{const p=${F}.document.querySelector('#bulk-review-panel'),a=p.querySelector('.tool-controls').getBoundingClientRect(),b=p.querySelector('.tool-help').getBoundingClientRect();return b.left>=a.right&&Math.abs(a.top-b.top)<2})()`),true,'Wide tools place help beside controls');
 await screenshot('folder-audio-tool','header');
 await w.call('Emulation.setDeviceMetricsOverride',{width:720,height:1000,deviceScaleFactor:1,mobile:false});
 assert.equal(await inspect(`(()=>{const p=${F}.document.querySelector('#bulk-review-panel'),a=p.querySelector('.tool-controls').getBoundingClientRect(),b=p.querySelector('.tool-help').getBoundingClientRect();return b.top>=a.bottom})()`),true,'Narrow tools stack without squeezing controls');
 assert.equal(await inspect(`${F}.document.documentElement.scrollWidth<=${F}.innerWidth+1`),true,'Compact window has no horizontal overflow');
 await w.call('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
 await click('tool-bulk-review-panel');
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
 await inspect(`window.savedTimeline.s3fPausePreview=()=>{window.savedTimeline.previewPaused=true;}`);
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
 assert.equal(await inspect(`${F}.document.querySelector('#audio-sync').checked`),false);
 await click('audio-sync');
 assert.equal(await inspect(`${F}.document.querySelector('#intensity').value`),'0');
 await selectValue('intensity','4');
 assert.equal(await inspect(`${F}.document.querySelector('#intensity-meter').value`),4);
 assert.equal(await inspect(`${F}.s3fHasUnsavedEdits()`),true);
 await screenshot('audio-sync','#current');
 await inspect(`window.savedMotion.scrollTo(0,180)`);
 const editorHeight=await inspect(`${F}.document.querySelector('#motion-frame').getBoundingClientRect().height`);
 holdReview=true;holdEditorSession=holdVideoSession=entries[1].editor_session;const beforeNext=requests.length;
 await click('next');
 await until(()=>heldEditorReads.length===1,'next editor is loading');
 assert.equal(await selectedTab(),'motion-tab');
 assert.equal(await inspect(`${F}.document.querySelector('#motion-frame').getAttribute('aria-busy')`),'true');
 assert.equal(await inspect(`window.savedMotion.frameElement.isConnected&&window.savedMotion.frameElement.inert`),true,'Previous view remains visible and read-only until the next clip is ready');
 assert.equal(await inspect(`${F}.document.querySelector('#motion-frame').getBoundingClientRect().height`),editorHeight,'Loading does not collapse the editor area');
 assert.equal(await inspect(`${F}.document.querySelector('#approve').disabled`),true,'Cannot approve an unseen incoming clip');
 assert.equal(await inspect(`${M(entries[1])}.frameElement.classList.contains('editor-pending')`),true);
 assert.equal(await inspect(`window.s3fWorkspaceFrames().some(p=>p.key==='motion:${entries[0].editor_session}')`),false,'Previous view is not exposed as the current editor session');
 await screenshot('loading-next');
 holdEditorSession=null;for(const resolve of heldEditorReads.splice(0))resolve();
 await until(()=>heldVideoReads.length===1,'first video frame loading');
 assert.equal(await inspect(`window.savedMotion.frameElement.isConnected`),true,'Previous view remains until the incoming video has decoded');
 assert.equal(await inspect(`${F}.document.querySelector('#motion-frame .editor-loading').textContent.includes('Preparing')`),true);
 holdVideoSession=null;for(const resolve of heldVideoReads.splice(0))resolve();
 await until(()=>inspect(`window.s3fWorkspaceFrames().some(p=>p.key==='motion:${entries[1].editor_session}')&&${M(entries[1])}.ready&&!${F}.document.querySelector('#motion-frame').hasAttribute('aria-busy')`),'switch video');
 assert.equal(await inspect(`window.savedMotion.frameElement?.isConnected||false`),false,'Replaced editor is removed after readiness');
 assert.equal(await inspect(`${F}.document.querySelectorAll('#motion-frame iframe').length`),1);
 assert.equal(await inspect(`${M(entries[1])}.scrollY`),180,'Next clip retains editor scroll');
 await screenshot('next-ready');
 assert.equal(states[entries[0].editor_session].project.scripts.L0.actions[0].pos,67,'Switch flushes draft first');
 assert.equal(entries[0].audio_sync,true,'Switch flushes Audio sync through the ComfyUI bridge');
 assert.equal(entries[0].intensity,4,'Switch flushes intensity through the ComfyUI bridge');
 assert.equal(await inspect(`${F}.document.querySelector('#intensity').value`),'0','Other clips keep their own intensity');
 assert.equal(entries[0].quality,0,'Audio sync does not assign a star rating');
 assert.equal(entries[0].status,'pending','Audio sync does not approve a draft');
 assert.equal(await inspect(`${F}.document.querySelector('#audio-sync').checked`),false,'Other clips keep their own label');
 assert.equal(await selectedTab(),'motion-tab','Clip switching retains the chosen editor');
 assert.equal(await inspect(`${M(entries[1])}.autoplayCalls||0`),0,'Next clip does not auto-play');
 assert.equal(await inspect(`window.s3fWorkspaceFrames().some(p=>p.key==='motion:${entries[0].editor_session}')`),false,'Old Motion Studio is removed');
 assert.equal(await host.evaluate("app.graph._nodes[0].widgets.find(w=>w.name==='video_name').value"),'sub/b.mp4');
 await until(()=>inspect(`!${F}.document.querySelector('#next').disabled`),'next available while review details are slow');
 await until(()=>heldReviews.length===2,'one pending request for issues and versions');
 const opened=requests.slice(beforeNext),openIndex=opened.findIndex(r=>r.action==='open');
 assert.equal(opened.slice(openIndex).filter(r=>r.action==='scan').length,0,'Opening does not scan again after the open response');
 if(!legacyFolderAPI){assert.equal(opened.filter(r=>r.action==='scan').length,0,'Saving metadata and opening a clip never scans the full library');assert.equal(opened.filter(r=>r.action==='clip-status').length,1,'Only navigation checks editor status; metadata does not flush editors');}
 for(const action of ['issues','versions'])assert.equal(opened.filter(r=>r.action===action&&r.clip===entries[1].id).length,1,'Each review detail is requested once');
 holdReview=false;for(const resolve of heldReviews.splice(0))resolve();
 await until(()=>inspect(`${F}.document.querySelector('#issue-count').textContent.includes('ranges to inspect')`),'review details arrive in background');
 // Navigating again during a slow load keeps the last usable view, and retires
 // both the abandoned incoming panel and its callbacks without leaking frames.
 await inspect(`window.lastVisibleMotion=${M(entries[1])};true`);
 holdEditorSession=entries[2].editor_session;
 await click('next');await until(()=>heldEditorReads.length===1,'third clip waits for project');
 await inspect(`window.abandonedMotion=${M(entries[2])};true`);
 await until(()=>inspect(`!${F}.document.querySelector('#previous').disabled`),'can leave pending clip');
 await click('previous');
 await until(()=>inspect(`window.s3fWorkspaceFrames().some(p=>p.key==='motion:${entries[1].editor_session}')&&${M(entries[1])}.ready&&!${F}.document.querySelector('#motion-frame').hasAttribute('aria-busy')`),'return during pending load');
 holdEditorSession=null;for(const resolve of heldEditorReads.splice(0))resolve();
 assert.equal(await inspect(`window.abandonedMotion.frameElement?.isConnected||false`),false,'Abandoned loading editor is removed');
 assert.equal(await inspect(`window.lastVisibleMotion.frameElement?.isConnected||false`),false,'Last visible view is removed after replacement');
 assert.equal(await inspect(`${F}.document.querySelectorAll('#motion-frame iframe').length`),1,'Rapid switching leaves one Motion Studio');
 assert.equal(await inspect(`${M(entries[1])}.scrollY`),180,'Rapid switching retains the last visible scroll');

 // Skip for now saves the current draft and advances, without requiring Restore.
 // A failed save must leave both the review status and the open clip untouched.
 await inspect(`${M(entries[1])}.edit(73);${F}.document.querySelector('#note').value='Poor tracking';${F}.document.querySelector('#note').dispatchEvent(new Event('input'))`);
 failSave=true;await click('ignore');
 await until(()=>inspect(`${F}.document.querySelector('#status').classList.contains('error')&&!${F}.document.querySelector('#ignore').disabled`),'skip save failure');
 assert.equal(entries[1].status,'pending','Failed flush cannot skip');
 assert.equal(await host.evaluate('app.graph._nodes[0].properties.s3f_folder_entry.id'),entries[1].id,'Failed flush cannot advance');
 failSave=false;await click('ignore');
 await until(()=>inspect(`window.s3fWorkspaceFrames().some(p=>p.key==='motion:${entries[2].editor_session}')&&${M(entries[2])}.ready&&!${F}.document.querySelector('#motion-frame').hasAttribute('aria-busy')&&!${F}.document.querySelector('#ignore').disabled`),'Skip for now opens next clip');
 assert.equal(entries[1].status,'ignored');assert.equal(entries[1].note,'Poor tracking');assert.equal(writes.length,0);
 assert.equal(states[entries[1].editor_session].project.scripts.L0.actions[0].pos,73,'Skip preserves edited Main');
 assert.equal(await host.evaluate('app.graph._nodes[0].properties.s3f_folder_entry.id'),entries[2].id,'Skip advances without Restore');
 assert.equal(await inspect(`[...${F}.document.querySelectorAll('#clips option')].some(option=>option.value==='${entries[1].id}')`),false,'Skipped clip leaves active review list');
 // Skipped clips remain accessible for later work, and the last eligible clip
 // reports completion without waiting on a redundant issues/versions request.
 await selectValue('filter','all');await selectValue('clips',entries[1].id);
 await until(()=>inspect(`window.s3fWorkspaceFrames().some(p=>p.key==='motion:${entries[1].editor_session}')&&${M(entries[1])}.ready&&!${F}.document.querySelector('#motion-frame').hasAttribute('aria-busy')&&!${F}.document.querySelector('#restore').disabled`),'reopen skipped draft');
 assert.equal(await inspect(`${M(entries[1])}.s3fEditorRevision()`),states[entries[1].editor_session].revision,'Reopened skipped draft loads the saved revision');
 await until(()=>inspect(`!${F}.document.querySelector('#restore').disabled`),'restore enabled');await click('restore');await until(()=>entries[1].status==='pending','restore');
 await until(()=>inspect(`!${F}.document.querySelector('#ignore').disabled`),'restored clip ready');
 await inspect(`${F}.document.querySelector('#search').value='sub/b.mp4';${F}.document.querySelector('#search').dispatchEvent(new Event('input'))`);
 const lastSkipRequests=requests.length;await click('ignore');
 await until(()=>inspect(`${F}.document.querySelector('#status').textContent.includes('No more clips to review')&&!${F}.document.querySelector('#restore').disabled`),'last clip completes skip');
 assert.equal(requests.slice(lastSkipRequests).some(r=>['open','issues','versions'].includes(r.action)),false,'Last clip neither reopens itself nor blocks on unchanged review details');
 assert.equal(await inspect(`${F}.document.querySelector('#filter').disabled`),false,'Review filters remain usable');
 await screenshot('last-clip-skipped','#current');
 await click('restore');await until(()=>inspect(`!${F}.document.querySelector('#ignore').disabled`),'restore last clip');
 await inspect(`${F}.document.querySelector('#search').value='';${F}.document.querySelector('#search').dispatchEvent(new Event('input'))`);await selectValue('filter','active');
 await until(()=>inspect(`!${F}.document.querySelector('#next').disabled`),'next enabled');await click('previous');
 await until(()=>inspect(`window.s3fWorkspaceFrames().some(p=>p.key==='motion:${entries[0].editor_session}')&&${M(entries[0])}.ready&&!${F}.document.querySelector('#motion-frame').hasAttribute('aria-busy')`),'return video');
 assert.equal(await inspect(`${F}.document.querySelector('#audio-sync').checked`),true,'Reopening restores Audio sync');
 assert.equal(await inspect(`${F}.document.querySelector('#intensity').value`),'4','Reopening restores intensity');
 await inspect(`${M(entries[0])}.edit(82)`);failSave=true;await click('approve');
 await until(()=>inspect(`${F}.document.querySelector('#status').classList.contains('error')`),'save failure');assert.equal(writes.length,0,'Failed flush cannot approve');
 failSave=false;await click('approve');await until(()=>writes.length===1,'approve');assert.equal(writes[0].scripts.L0.actions[0].pos,82);
 await until(()=>inspect(`!${F}.document.querySelector('#next').disabled`),'approval complete');
 assert.equal(entries[0].audio_sync,true,'Approval retains the label');
 assert.equal(entries[0].intensity,4,'Approval retains intensity');
 await selectValue('intensity','0');await click('review');await until(()=>entries[0].intensity===0,'Intensity can be cleared');
 await until(()=>inspect(`!${F}.document.querySelector('#review').disabled`),'intensity saved');
 await click('audio-sync');await click('review');await until(()=>!entries[0].audio_sync,'Audio sync can be cleared');
 await until(()=>inspect(`!${F}.document.querySelector('#next').disabled`),'review complete');queued=true;await click('next');
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
 assert.equal(states[entries[1].editor_session].project.scripts.L0.actions[0].pos,73);
 // Folder checkboxes combine disjoint and nested folders without duplicate jobs.
 const extraEntries=[['other/c.mp4','pending'],['sub/nested/d.mp4','pending'],['submarine/excluded.mp4','pending'],['other/existing.mp4','existing'],['other/ready.mp4','pending'],['other/ignored.mp4','ignored']].map(([name,status],i)=>({...entries[1],id:(10+i).toString(16).repeat(32),name,status,existing:status==='existing'?['existing.funscript']:[],batch_result:name.includes('ready')?'ready':undefined}));
 entries.push(...extraEntries);
 await inspect(`${F}.s3fReconnect()`);
 await chooseFolders([]);
 assert.equal(await inspect(`${F}.document.querySelector('#bulk').disabled`),true,'Clearing folders cannot start a whole-library batch');
 assert.equal(await inspect(`${F}.document.querySelector('#bulk-count').textContent`),'0 clips to process');
 assert.equal(await inspect(`${F}.document.querySelector('#bulk-audio-mark').disabled`),true,'No folder selection cannot mark the library');
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
 const labelScope=entries.filter(e=>e.name.startsWith('sub/')||e.name.startsWith('other/'));
 const untouched=entries.filter(e=>!labelScope.includes(e)).map(e=>[e.id,e.audio_sync]);
 const reviewsBefore=labelScope.map(({id,audio_sync,...entry})=>({id,...entry}));
 await click('tool-bulk-review-panel');
 failBulkLabels=true;await click('bulk-audio-mark');
 await until(()=>inspect(`${F}.document.querySelector('#status').textContent.includes('Label save unavailable')&&!${F}.document.querySelector('#bulk-audio-mark').disabled`),'failed metadata save unlocks controls');
 assert.deepEqual(labelScope.map(({id,audio_sync,...entry})=>({id,...entry})),reviewsBefore);
 failBulkLabels=false;
 await click('bulk-audio-mark');
 await until(()=>labelScope.every(e=>e.audio_sync),'bulk audio labels saved');
 assert.deepEqual(requests.filter(r=>r.action==='review_audio_sync').at(-1).clip_ids,labelScope.map(e=>e.id),'Nested overlaps are deduplicated and hidden clips included');
 assert.equal(labelScope.length,6,'Approved/existing, ready and skipped clips share the folder label');
 assert.deepEqual(entries.filter(e=>!labelScope.includes(e)).map(e=>[e.id,e.audio_sync]),untouched,'Other folders are unchanged');
 assert.deepEqual(labelScope.map(({id,audio_sync,...entry})=>({id,...entry})),reviewsBefore,'Labels preserve ratings, notes and other clip metadata');
 await until(()=>inspect(`!${F}.document.querySelector('#bulk-audio-clear').disabled`),'bulk label action finished');
 assert.equal(await inspect(`${F}.document.querySelector('#audio-sync').checked`),true,'Current review checkbox reflects bulk change');
 await screenshot('bulk-audio-sync','#bulk-review-panel');
 await click('bulk-audio-clear');await until(()=>labelScope.every(e=>!e.audio_sync),'bulk labels cleared');
 await until(()=>inspect(`!${F}.document.querySelector('#bulk-audio-mark').disabled`),'bulk clear finished');
 await inspect(`${F}.document.querySelector('#search').value='';${F}.document.querySelector('#search').dispatchEvent(new Event('input'))`);
 await click('tool-tags-panel');
 await until(()=>inspect(`!${F}.document.querySelector('#tags-start').disabled`),'incremental tagging capability');
 assert.equal(await inspect(`${F}.document.querySelector('#tags-frames').value`),'3','Last three-frame settings survive reopening');
 assert.equal(await inspect(`${F}.document.querySelector('#tags-mode').value`),'needed','Retagging is explicit');
 tagState.incremental=false;
 await until(()=>inspect(`${F}.document.querySelector('#tags-start').disabled&&!${F}.document.querySelector('#tags-support').hidden`),'old backend cannot silently retag everything');
 tagState.incremental=true;
 await until(()=>inspect(`!${F}.document.querySelector('#tags-start').disabled`),'updated backend supports skipping completed tags');
 await click('tags-start');await until(()=>requests.some(r=>r.action==='tags_start'),'tagging request submitted');
 assert.deepEqual(requests.filter(r=>r.action==='tags_start').at(-1).clip_ids,labelScope.filter(e=>e.status!=='ignored').map(e=>e.id),'Tags cover selected folders and skip skipped clips');
 assert.equal(requests.filter(r=>r.action==='tags_start').at(-1).source,'both');
 assert.equal(requests.filter(r=>r.action==='tags_start').at(-1).force,false);
 assert.equal(requests.filter(r=>r.action==='tags_start').at(-1).frames,3);
 await until(()=>inspect(`${F}.document.querySelector('#status').textContent.includes('No tagging was needed')`),'already tagged scope performs no work');
 await screenshot('tags-up-to-date','#tags-panel');
 await selectValue('tags-mode','all');
 assert.equal(await inspect(`${F}.document.querySelector('#tags-start').textContent`),'Retag selected folders');
 await click('tags-start');await until(()=>requests.filter(r=>r.action==='tags_start').at(-1).force===true,'explicit retag request');
 await until(()=>inspect(`!${F}.document.querySelector('#tags-start').disabled`),'retag action finished');
 await selectValue('tags-mode','needed');
 await inspect(`${F}.document.querySelector('#clip-tags').value='woman, dancing';${F}.document.querySelector('#clip-tags').dispatchEvent(new Event('input'))`);
 await click('review');await until(()=>requests.some(r=>r.action==='review'&&r.tags?.includes('woman')),'manual tags sent through bridge');
 await until(()=>inspect(`!${F}.document.querySelector('#review').disabled`),'tag save complete');
 await screenshot('clip-tags','#current');
 // Upload works directly through the Folder API with the older main-tab handler,
 // and waits for current edits before taking a snapshot. No external publication.
 await click('tool-dataset-panel');
 await until(()=>inspect(`!${F}.document.querySelector('#dataset-upload').disabled`),'upload login and saved repository');
 assert.equal(await inspect(`${F}.document.querySelector('#dataset-repo').value`),'tester/Example');
 assert.equal(await inspect(`${F}.document.querySelector('#dataset-policy')===null`),true,'No upload review override');
 datasetState.video_metadata=false;await click('dataset-refresh');
 await until(()=>inspect(`${F}.document.querySelector('#dataset-upload').disabled&&!${F}.document.querySelector('#dataset-support').hidden`),'older backend cannot silently omit video metadata');
 datasetState.video_metadata=true;await click('dataset-refresh');
 await until(()=>inspect(`!${F}.document.querySelector('#dataset-upload').disabled`),'updated backend enables metadata uploads');
 await inspect(`${M(entries[1])}.edit(73)`);failSave=true;
 await click('dataset-upload');
 await until(()=>inspect(`${F}.document.querySelector('#dataset-progress').classList.contains('error')&&!${F}.document.querySelector('#dataset-upload').disabled`),'failed save cancels upload and allows retry');
 assert.equal(datasetSnapshots.length,0,'No upload after a failed editor save');
 failSave=false;
 await inspect(`${F}.document.querySelector('#clip-tags').value='woman, dancing, solo';${F}.document.querySelector('#clip-tags').dispatchEvent(new Event('input'))`);
 await click('dataset-upload');await until(()=>datasetSnapshots.length===1,'dataset upload started');
 assert.equal(datasetSnapshots[0].states[entries[1].editor_session].project.scripts.L0.actions[0].pos,73,'Upload waits for saved Main');
 assert.deepEqual(datasetSnapshots[0].entries.find(e=>e.id===entries[1].id).tags,['dancing','solo','woman'],'Upload waits for saved tags');
 assert.deepEqual(requests.filter(r=>r.action==='dataset_upload').at(-1),{action:'dataset_upload',repo:'tester/Example',use_folder_approval:true},'Upload uses the whole workspace, without review filters');
 await until(()=>inspect(`${F}.document.querySelector('#dataset-upload').disabled&&!${F}.document.querySelector('#next').disabled`),'background upload keeps clip review available');
 await screenshot('dataset-upload','#folder-tools');
 const completed={stage:'complete',repo:'tester/Example',finished_at:new Date().toISOString(),result:{videos:4,videos_with_scripts:3,metadata_only_videos:1,variants:3,scripts:3}};
 datasetState={...datasetState,busy:false,job:completed,last_upload:completed};await click('dataset-refresh');
 await until(()=>inspect(`!${F}.document.querySelector('#dataset-result').hidden&&!${F}.document.querySelector('#dataset-upload').disabled`),'completed dataset link and next upload');
 assert.equal(await inspect(`${F}.document.querySelector('#dataset-result').href`),'https://huggingface.co/datasets/tester/Example');
 assert.equal(await inspect(`${F}.document.querySelector('#dataset-progress').textContent.includes('3 with scripts · 1 metadata only')`),true,'Upload distinguishes video metadata from scripts');
 assert.equal(await inspect(`${F}.document.querySelector('#status').classList.contains('error')`),false,'Successful retry clears the earlier save error');
 await screenshot('dataset-complete','#folder-tools');
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
 await chooseFolders(['sub','other']);
 const reprocessIds=entries.filter(e=>(e.name.startsWith('sub/')||e.name.startsWith('other/'))&&e.status!=='ignored').map(e=>e.id);
 await click('reprocess');await until(()=>JSON.parse(batchPrompt.output['9'].inputs.plan_json).folder_batch?.reprocess===true,'reprocess batch queued');
 assert.deepEqual(JSON.parse(batchPrompt.output['9'].inputs.plan_json).folder_batch.clip_ids,reprocessIds,'Reprocess includes ready and scripted clips once');
 assert.equal(requests.filter(r=>r.action==='preflight').at(-1).reprocess,true);
 for(const entry of entries)entry.processing=false;
 batchRunning=false;batchComplete=true;batch.stage='complete';batch.current=batch.current_id=null;
 await until(()=>inspect(`!${F}.document.querySelector('#reprocess').disabled`),'reprocess finished');
 await chooseFolders(['']);

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
 await selectValue('cv-navigation','pages');
 const greenIds=await inspect(`[...${F}.document.querySelectorAll('.cv-state.processed')].map(p=>p.closest('.civitai-card').dataset.id)`);
 assert.ok(greenIds.length,'The fixture has completed green cards');
 await click('cv-hide-done');
 assert.equal(await inspect(`${F}.document.querySelectorAll('.cv-state.processed').length`),0,'Hide completed excludes every green card');
 assert.equal(await inspect(`JSON.parse(${F}.localStorage.getItem('s3f-civitai:${folder}'))['cv-hide-done']`),true,'Hide completed is remembered');
 await selectValue('cv-filter','processed');
 assert.equal(await inspect(`${F}.document.querySelector('#cv-hide-done').checked`),false,'Explicit processed view reveals completed clips');
 await selectValue('cv-filter','all');
 assert.equal(await inspect(`${F}.document.querySelector('#cv-connection').open`),true,'Key entry is visible when no key is configured');
 assert.equal(await inspect(`${F}.document.querySelector('#cv-key-status').textContent`),'No key configured');
 assert.equal(await inspect(`${F}.document.querySelector('#cv-ratings').value`),'31','New folders request all non-blocked ratings');
 await inspect(`${F}.document.querySelector('#cv-key').value='fixture-key'`);await click('cv-save-key');
 await until(()=>inspect(`${F}.document.querySelector('#cv-key-status').textContent==='Key configured'`),'API key saved');
 assert.equal(await inspect(`${F}.document.querySelector('#cv-connection').open`),false,'Configured credentials stay collapsed');
 assert.equal(await inspect(`${F}.document.querySelector('#cv-key').value`),'','Saved key is cleared from the input');
 assert.equal(remotePages,0);assert.equal(downloads.length,0,'Saving a key does not download anything');
 await click('cv-metadata-toggle');
 assert.equal(await inspect(`${F}.document.querySelector('#cv-metadata-panel').hidden`),false);
 await click('cv-metadata-fill');
 await until(()=>inspect(`${F}.document.querySelector('#cv-metadata-status').textContent.includes('running: 0 / 3')`),'metadata job begins');
 assert.equal(requests.filter(r=>r.action==='metadata_start').at(-1).force,false,'Default recovery fills missing metadata only');
 assert.equal(await inspect(`${F}.document.querySelector('#cv-metadata-refresh').disabled`),true,'Cannot overlap metadata jobs');
 await click('cv-metadata-stop');
 await until(()=>inspect(`!${F}.document.querySelector('#cv-metadata-refresh').disabled`),'metadata stop');
 await click('cv-metadata-refresh');
 await until(()=>requests.filter(r=>r.action==='metadata_start').length===2,'explicit metadata refresh');
 assert.equal(requests.filter(r=>r.action==='metadata_start').at(-1).force,true);
 cvMetadata.known=3;cvMetadata.job={stage:'complete',completed:3,total:3,errors:[]};
 await until(()=>inspect(`${F}.document.querySelector('#cv-metadata-status').textContent.includes('3 / 3 local')`),'metadata progress polling');
 await screenshot('civitai-metadata','#cv-metadata-panel');
 const supportedMetadata=cvMetadata;cvMetadata=undefined;await click('cv-refresh');
 await until(()=>inspect(`${F}.document.querySelector('#cv-metadata-status').textContent.includes('Restart ComfyUI')`),'older backend explanation');
 assert.equal(await inspect(`${F}.document.querySelector('#cv-metadata-fill').disabled`),true);
 cvMetadata=supportedMetadata;await click('cv-refresh');
 await until(()=>inspect(`!${F}.document.querySelector('#cv-metadata-fill').disabled`),'metadata capability restored');
 await click('cv-metadata-toggle');
 assert.equal(downloads.length,0,'Metadata recovery does not download videos');
 await inspect(`${F}.document.querySelector('#cv-view').value='remote';${F}.document.querySelector('#cv-view').dispatchEvent(new Event('change'))`);
 assert.equal(await inspect(`${F}.document.querySelector('#cv-search').open||${F}.document.querySelector('#cv-category-editor').open`),false,'Occasional controls start collapsed');
 await w.call('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
 await screenshot('civitai-desktop','#cv-discovery');
 assert.equal(await inspect(`(()=>{const a=${F}.document.querySelector('.cv-browse-controls').getBoundingClientRect(),b=${F}.document.querySelector('.cv-destination-controls').getBoundingClientRect();return b.left>=a.right&&Math.abs(a.top-b.top)<2})()`),true,'Destination sits beside browsing controls on wide screens');
 await inspect(`${F}.document.querySelector('#cv-category-editor').open=true;${F}.document.querySelector('#cv-new-category').value='Reviewed/Studio'`);
 await click('cv-add-category');
 await until(()=>inspect(`${F}.document.querySelector('#cv-category').value==='Reviewed/Studio'`),'create category in discovery');
 assert.equal(await inspect(`${F}.document.querySelector('#cv-category-editor').open`),false,'Successful creation closes the category form');
 assert.match(await inspect(`${F}.document.querySelector('#cv-status').textContent`),/Category saved: Reviewed\/Studio/);
 await inspect(`${F}.document.querySelector('#cv-category-editor').open=true;${F}.document.querySelector('#cv-search').open=true`);
 await screenshot('civitai-expanded','#cv-discovery');
 for(const width of [720,390]){
  await w.call('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});
  assert.equal(await inspect(`(()=>{const a=${F}.document.querySelector('.cv-browse-controls').getBoundingClientRect(),b=${F}.document.querySelector('.cv-destination-controls').getBoundingClientRect();return b.top>=a.bottom})()`),true,'Compact views stack the two control groups');
  assert.equal(await inspect(`${F}.document.documentElement.scrollWidth<=${F}.innerWidth+1`),true,`No horizontal overflow at ${width}px`);
 }
 if(process.env.S3F_TEST_SCREENSHOTS){
  await inspect(`${F}.document.querySelector('#cv-discovery').scrollIntoView({block:'start'})`);await pause(100);
  fs.writeFileSync(path.join(process.env.S3F_TEST_SCREENSHOTS,'civitai-mobile.png'),Buffer.from((await w.call('Page.captureScreenshot')).data,'base64'));
 }
 await w.call('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
 await inspect(`${F}.document.querySelector('#cv-category-editor').open=false;${F}.document.querySelector('#cv-search').open=false;${F}.document.querySelector('#cv-connection').open=true`);
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
 await click('cv-more');await until(()=>inspect(`${F}.document.querySelectorAll('.civitai-card').length===1&&!!${F}.document.querySelector('[data-id="406"]')`),'cursor page navigation');
 assert.deepEqual(requests.filter(r=>r.action==='browse').slice(-2).map(r=>[r.browsingLevel,r.cursor||null]),[[16,null],[16,'page2']]);
 await selectValue('cv-navigation','infinite');
 assert.deepEqual(await inspect(`[...${F}.document.querySelectorAll('.civitai-card')].map(c=>c.dataset.id)`),['404','405','406']);
 await inspect(`${F}.document.querySelector('[data-id="405"] .cv-check').click()`);
 await inspect(`${F}.document.querySelector('[data-id="404"] [data-gallery="post"]').click()`);
 await until(()=>inspect(`${F}.document.querySelector('#cv-gallery-title').textContent.includes('9001')`),'same post loaded');
 assert.equal(requests.filter(r=>r.action==='gallery').at(-1).kind,'post');
 await click('cv-hide-done');
 assert.equal(await inspect(`${F}.document.querySelector('[data-id="101"]')===null`),true,'Completed videos are also hidden in post galleries');
 await click('cv-more');await until(()=>inspect(`!!${F}.document.querySelector('[data-id="408"]')`),'post gallery pagination');
 assert.equal(requests.filter(r=>r.action==='gallery').at(-1).postId,'9001');
 assert.equal(requests.filter(r=>r.action==='gallery').at(-1).cursor,'post2');
 await inspect(`${F}.document.querySelector('[data-id="407"] [data-gallery="creator"]').click()`);
 await until(()=>inspect(`${F}.document.querySelector('#cv-gallery-title').textContent==='Videos by Neutral creator'&&!${F}.document.querySelector('#cv-navigation').disabled`),'follow trail to creator');
 assert.deepEqual(await inspect(`[...${F}.document.querySelectorAll('.civitai-card')].map(c=>c.dataset.id)`),['407','409']);
 assert.match(await inspect(`${F}.document.querySelector('#cv-gallery-link').href`),/\/user\/Neutral%20creator\/images$/);
 await screenshot('civitai-creator-gallery','#cv-gallery-trail');
 await click('cv-gallery-back');
 assert.deepEqual(await inspect(`[...${F}.document.querySelectorAll('.civitai-card')].map(c=>c.dataset.id)`),['404','407','408'],'Back restores loaded post pages');
 await click('cv-gallery-back');
 assert.deepEqual(await inspect(`[...${F}.document.querySelectorAll('.civitai-card')].map(c=>c.dataset.id)`),['404','405','406'],'Back restores original ranking and pages');
 assert.equal(await inspect(`${F}.document.querySelector('[data-id="405"] .cv-check').checked`),true,'Selection survives the browsing trail');
 assert.equal(await inspect(`${F}.document.querySelector('#cv-ratings').value`),'16');
 assert.equal(await inspect(`${F}.document.querySelector('#cv-period').value`),'Month');
 holdGallery=true;await inspect(`${F}.document.querySelector('[data-id="404"] [data-gallery="post"]').click()`);
 await until(()=>heldGalleries.length>0,'gallery request held');await click('cv-gallery-back');holdGallery=false;for(const release of heldGalleries.splice(0))release();await pause(100);
 assert.equal(await inspect(`${F}.document.querySelector('#cv-gallery-trail').hidden`),true,'Back cancels an in-flight gallery navigation');
 assert.deepEqual(await inspect(`[...${F}.document.querySelectorAll('.civitai-card')].map(c=>c.dataset.id)`),['404','405','406']);
 await click('cv-hide-done');await inspect(`${F}.document.querySelector('[data-id="405"] .cv-check').click()`);
 assert.equal(downloads.length,0,'Exploring post and creator galleries does not download videos');
 await inspect(`${F}.document.querySelector('#cv-category').value='Dance';${F}.document.querySelector('#cv-category').dispatchEvent(new Event('change'));for(const id of ['404','405'])${F}.document.querySelector('[data-id="'+id+'"] .cv-check').click()`);
 assert.equal(await inspect(`${F}.document.querySelectorAll('.civitai-card.selected').length`),2,'Selected cards are highlighted');
 assert.equal(await inspect(`${F}.document.querySelectorAll('#cv-selection button').length`),2,'Selection lists the exact clips');
 await click('cv-process');await until(()=>clipQueue.items.length===2,'selection saved in queue');
 assert.equal(downloads.length,0,'Adding to queue does not start downloads');assert.equal(batchRunning,false);
 // An older backend can retain a queued report after its persistent queue
 // completed and returned to idle. Actual executor guards still own start.
 batch={stage:'queued',queue:true,total:3,current:null,current_id:null,completed:[],failed:[],skipped:[],deferred:[]};
 await inspect(`${F}.s3fReconnect()`);
 assert.equal(await inspect(`${F}.document.querySelector('#bulk').disabled`),true,'Fixture reproduces the stale batch lock');
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
 // A slow open must leave browsing/list editing available and ignore late results.
 holdOpenClip=staged[0].id;await inspect(`${F}.document.querySelector('[data-review]').click()`);
 await until(()=>releaseOpen,'held slow review open');
 assert.equal(await inspect(`${F}.document.querySelector('#cv-back').disabled`),false);
 await click('cv-edit-review');assert.equal(await inspect(`${F}.document.querySelectorAll('#cv-list-rows li').length`),2);
 await click('cv-next');await click('cv-back');
 assert.equal(await inspect(`${F}.document.querySelector('#cv-review-panel').hidden`),true,'Back remains available during loading');
 const beforeDismiss=requests.filter(r=>r.action==='open').length;
 holdOpenClip=null;releaseOpen();releaseOpen=null;await pause(300);
 assert.equal(await inspect(`${F}.document.querySelector('#cv-review-panel').hidden&&${F}.document.querySelector('#clip-workbench').hidden`),true,'Late opening never reveals an abandoned clip');
 assert.equal(requests.filter(r=>r.action==='open').length,beforeDismiss,'Dismissed pending navigation must not open another clip');
 await click('cv-list-close');
 // Queue review must not present the old video as the requested result while opening.
 holdOpenClip=staged[0].id;failOpenClip=staged[0].id;
 await inspect(`${F}.document.querySelector('.cv-queue-list li button').click()`);
 await until(()=>releaseOpen,'queue clip opening');
 assert.equal(await inspect(`${F}.document.querySelector('#clip-workbench').hidden`),true,'Previous clip is hidden until the requested queue clip opens');
 holdOpenClip=null;releaseOpen();releaseOpen=null;
 await until(()=>inspect(`${F}.document.querySelector('#cv-review-status').textContent.includes('Temporary clip open failure')`),'queue open error');
 assert.equal(await inspect(`${F}.document.querySelector('#clip-workbench').hidden`),true,'Failed opening cannot show a different clip');
 assert.equal(await inspect(`${F}.document.querySelector('#cv-approve').disabled&&${F}.document.querySelector('#cv-process-one').disabled`),true);
 failOpenClip=null;await click('cv-back');
 await inspect(`${F}.document.querySelector('[data-review]').click()`);
 await until(()=>inspect(`!${F}.document.querySelector('#cv-review-panel').hidden&&window.s3fWorkspaceFrames().some(p=>p.key==='motion:${staged[0].editor_session}')&&${M(staged[0])}.ready&&!${F}.document.querySelector('#cv-approve').disabled`),'first staged review');
 assert.equal(await inspect(`${F}.document.querySelector('#local-panel').hidden`),true);assert.equal(await inspect(`${F}.document.querySelector('#clip-workbench').hidden`),false);
 assert.equal(await selectedTab(),'motion-tab','Finished queue clips open their generated motion for review');
 assert.equal(await inspect(`${F}.document.querySelector('#detail').textContent`),'Draft ready for review','An unapproved generated script is identified as a draft');
 // A completed draft can arrive without this window witnessing processing.
 const newerDraft=states[staged[0].editor_session];newerDraft.project.scripts.L0.actions=[{at:0,pos:79},{at:500,pos:21}];newerDraft.revision++;
 await click('cv-back');
 await until(()=>inspect(`${M(staged[0])}.s3fEditorRevision()===${newerDraft.revision}`),'reopen refreshes retained editor draft');
 await inspect(`${F}.document.querySelector('[data-review]').click()`);
 await until(()=>inspect(`!${F}.document.querySelector('#cv-approve').disabled`),'ready after draft refresh');
 assert.equal(downloads.length,2,'Review does not redownload generated clips');
 assert.equal(batchRunning,false,'Review does not enqueue already generated drafts');
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
 await click('cv-refresh');
 await until(()=>inspect(`${F}.document.querySelector('[data-id="406"] .cv-state').textContent.includes('Draft ready')`),'completed clip refreshed in gallery');
 await click('cv-resume');await until(()=>inspect(`${M(undecided)}.ready&&!${F}.document.querySelector('#cv-approve').disabled`),'resume undecided');
 assert.equal(downloads.length,3);assert.equal(states[undecided.editor_session].project.scripts.L0.actions[0].pos,64);
 await inspect(`${F}.document.querySelector('#cv-review-new-category').value='Reviewed/Dance'`);await click('cv-review-add-category');
 await until(()=>inspect(`${F}.document.querySelector('#cv-review-category').value==='Reviewed/Dance'`),'category from review');
 const captures=path.join(root,'development/civitai-browser');fs.mkdirSync(captures,{recursive:true});await w.call('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
 await inspect(`${F}.scrollTo(0,0)`);fs.writeFileSync(path.join(captures,'review.png'),Buffer.from((await w.call('Page.captureScreenshot')).data,'base64'));
 await click('cv-back');await until(()=>inspect(`${F}.document.querySelector('#cv-review-panel').hidden`),'return gallery');
 // Refresh processing status before choosing Auto-process for a cached gallery card.
 undecided.batch_result=null;await click('cv-refresh');
 await until(()=>inspect(`!${F}.document.querySelector('[data-id="406"] .cv-state').textContent.includes('Draft ready')`),'old gallery snapshot');
 undecided.batch_result='ready';await inspect(`${F}.document.querySelector('[data-id="406"] button').click()`);
 await until(()=>inspect(`!${F}.document.querySelector('#cv-approve').disabled`),'fresh draft recognized');
 assert.equal(batchRunning,false,'A refreshed generated draft must not be automatically processed again');
 await click('cv-back');
 await until(()=>inspect(`${F}.document.querySelector('#cv-review-panel').hidden`),'leave review before testing a missing copy');
 // A missing selected copy must not fall back to a different video with the same Civitai ID.
 const missingCopy={key:'missing-copy',id:'406',clip:'0'.repeat(32),name:'Previous copy.mp4',state:'ready'};
 clipQueue.items.push(missingCopy);await click('cv-refresh');
 await until(()=>inspect(`${F}.document.querySelector('.cv-queue-list li:last-child strong').textContent==='Previous copy.mp4'`),'stale queue copy');
 const opensBeforeMissing=requests.filter(r=>r.action==='open').length;
 await inspect(`${F}.document.querySelector('.cv-queue-list li:last-child button').click()`);
 await until(()=>inspect(`${F}.document.querySelector('#cv-review-status').textContent.includes('moved or changed')`),'missing copy explained');
 assert.equal(requests.filter(r=>r.action==='open').length,opensBeforeMissing,'No substitute video is silently opened');
 assert.equal(await inspect(`${F}.document.querySelector('#clip-workbench').hidden`),true);
 clipQueue.items.pop();await click('cv-back');
 await inspect(`${F}.scrollTo(0,0)`);fs.writeFileSync(path.join(captures,'gallery.png'),Buffer.from((await w.call('Page.captureScreenshot')).data,'base64'));
 await click('local-tab');assert.equal(await inspect(`${F}.document.querySelector('#local-panel').hidden`),false);
 // Temporary drafts must be approvable here, with a per-clip destination.
 const localDrafts=['707','708'].map((id,i)=>{stageClip({id,category:i?'Dance':''});const e=entries.at(-1);e.batch_result='ready';return e;});
 await inspect(`${F}.s3fReconnect()`);await chooseFolders(['']);await selectValue('filter','all');await selectValue('quality-filter','all');
 await inspect(`${F}.document.querySelector('#search').value='Neutral_civitai_70';${F}.document.querySelector('#search').dispatchEvent(new Event('input'))`);
 await selectValue('clips',localDrafts[0].id);
 await until(()=>inspect(`window.s3fWorkspaceFrames().some(p=>p.key==='motion:${localDrafts[0].editor_session}')&&${M(localDrafts[0])}.ready&&!${F}.document.querySelector('#motion-frame').hasAttribute('aria-busy')&&!${F}.document.querySelector('#approval-destination').hidden&&!${F}.document.querySelector('#review').disabled`),'local temporary review');
 assert.equal(await inspect(`${F}.document.querySelector('#approve').disabled&&${F}.document.querySelector('#approve-next').disabled`),true,'Destination is required');
 assert.match(await inspect(`${F}.document.querySelector('#approval-hint').textContent`),/temporary download.*destination category/i);
 assert.equal(await inspect(`[...${F}.document.querySelectorAll('#approval-categories option')].some(o=>o.value==='Reviewed/Dance')`),true,'Saved empty categories are suggested after browsing');
 await inspect(`${F}.document.querySelector('#approval-category').value='Reviewed/Local';${F}.document.querySelector('#approval-category').dispatchEvent(new Event('input'));${M(localDrafts[0])}.edit(77)`);
 assert.equal(await inspect(`${F}.document.querySelector('#approve').disabled`),false);
 const localWrites=writes.length;failSave=true;await click('approve');
 await until(()=>inspect(`${F}.document.querySelector('#status').textContent.includes('Temporary save failure')&&!${F}.document.querySelector('#approve').disabled`),'temporary approval blocks failed edit save');
 assert.equal(writes.length,localWrites);assert.equal(localDrafts[0].civitai_temporary,true);
 failSave=false;
 const approvalCaptures=path.join(root,'development/temporary-approval');fs.mkdirSync(approvalCaptures,{recursive:true});
 await inspect(`${F}.document.querySelector('#current').scrollIntoView({block:'start'})`);
 fs.writeFileSync(path.join(approvalCaptures,'local-approval.png'),Buffer.from((await w.call('Page.captureScreenshot')).data,'base64'));
 await click('approve');
 await until(()=>inspect(`${F}.document.querySelector('#approval-destination').hidden&&!${F}.document.querySelector('#approve').disabled`),'temporary approved in local view');
 assert.equal(localDrafts[0].civitai_temporary,false);assert.equal(localDrafts[0].name,'Reviewed/Local/Neutral_civitai_707_original.mp4');
 assert.equal(writes.length,localWrites+1);assert.equal(writes.at(-1).scripts.L0.actions[0].pos,77,'Local temporary approval saves current Main edits');
 assert.equal(await inspect(`${F}.s3fFolderIdentity().entry.id`),localDrafts[0].id,'Approve stays on this clip');
 assert.equal(await inspect(`${M(localDrafts[0])}.s3fEditorRevision()`),states[localDrafts[0].editor_session].revision,'Relocated editor refreshes its revision');
 await selectValue('clips',localDrafts[1].id);
 await until(()=>inspect(`window.s3fWorkspaceFrames().some(p=>p.key==='motion:${localDrafts[1].editor_session}')&&${M(localDrafts[1])}.ready&&!${F}.document.querySelector('#approve-next').disabled`),'next temporary review');
 assert.equal(await inspect(`${F}.document.querySelector('#approval-category').value`),'Dance','The next clip uses its own category, not the prior destination');
 await click('approve-next');
 await until(()=>inspect(`${F}.s3fFolderIdentity().entry.id==='${localDrafts[0].id}'&&!${F}.document.querySelector('#approve').disabled`),'temporary approve and next uses local review order');
 assert.equal(localDrafts[1].name,'Dance/Neutral_civitai_708_original.mp4');assert.equal(writes.length,localWrites+2);
 assert.equal(await inspect(`${F}.document.querySelector('#local-panel').hidden`),false,'Approval does not redirect to a second reviewer');
 await inspect(`${F}.document.querySelector('#search').value='';${F}.document.querySelector('#search').dispatchEvent(new Event('input'))`);
 // Random review mixes folders, keeps its order through saves/polls, and resumes.
 const addReviewClip=(name,number)=>{
  const id=number.toString(16).repeat(16),entry={id,name,status:'pending',timeline:'8'+id.slice(1),editor_session:'9'+id.slice(1),draft:true,batch_result:'ready',quality:0,existing:[],note:''};
  entries.push(entry);versions[id]=[];states[entry.editor_session]={revision:1,project:{metadata:{source:{path:name}},scripts:{L0:{actions:[{at:0,pos:20}]}},timeline:{sources:[],tracks:[],main:{},selection:[0,0]}}};return entry;
 };
 const reviewClips=['alpha/a','alpha/b','alpha/c','alpha/d','beta/a','beta/b','gamma/a','gamma/b'].map((name,i)=>addReviewClip('shuffle/'+name+'.mp4',40+i));
 await inspect(`${F}.s3fReconnect()`);await chooseFolders(['']);
 const reviewIds=()=>inspect(`[...${F}.document.querySelectorAll('#clips option')].map(option=>option.value)`);
 const currentId=()=>host.evaluate('app.graph._nodes[0].properties.s3f_folder_entry.id');
 const readyClip=async entry=>until(()=>inspect(`${F}.s3fFolderIdentity?.().entry?.id==='${entry.id}'&&${M(entry)}?.ready&&!${F}.document.querySelector('#motion-frame').hasAttribute('aria-busy')&&!${F}.document.querySelector('#next').disabled`),'review clip '+entry.name);
 // A saved rating removes the selected clip from Unrated. Keep the old
 // neighbours for next, previous, approval and skip; don't jump to the start.
 for(const [index,action,targetIndex] of [[0,'next',2],[1,'previous',0],[2,'approve-next',2],[3,'ignore',2]]){
  const group=['a','b','c'].map((name,i)=>addReviewClip(`navigation/${index}/${name}.mp4`,100+index*3+i));
  await inspect(`${F}.s3fReconnect()`);
  await selectValue('quality-filter','0');await selectValue('filter','ready');
  await inspect(`${F}.document.querySelector('#search').value='navigation/${index}/';${F}.document.querySelector('#search').dispatchEvent(new Event('input'))`);
  await selectValue('clips',group[1].id);await readyClip(group[1]);
  await selectValue('quality','4');
  const start=requests.length;
  await click(action);await readyClip(group[targetIndex]);
  assert.equal(await currentId(),group[targetIndex].id,`${action} preserves the rated clip's previous position`);
  assert.equal(group[1].quality,4);
  assert.equal((await reviewIds()).includes(group[1].id),false,'Rated clip leaves Unrated');
  if(!legacyFolderAPI)assert.equal(requests.slice(start).some(r=>r.action==='scan'),false,'Review/navigation mutations use only clip status and compact responses');
 }
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
 await click('ignore');await readyClip(entries.find(e=>e.id===order[2]));
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
 // One saved clip ahead is prepared without taking ownership or saving it.
 const warmClips=['prefetch/a.mp4','prefetch/b.mp4','prefetch/c.mp4'].map((name,i)=>addReviewClip(name,60+i));
 await inspect(`${F}.s3fReconnect()`);
 await inspect(`${F}.document.querySelector('#search').value='prefetch/';${F}.document.querySelector('#search').dispatchEvent(new Event('input'))`);
 await selectValue('clips',warmClips[0].id);await readyClip(warmClips[0]);
 const warmFrames=`[...${F}.document.querySelectorAll('iframe.editor-prefetch')]`;
 const prefetched=async()=>until(()=>inspect(`${F}.document.querySelector('#prefetch-status').textContent==='Next clip preloaded'`),'next clip preloaded');
 warmClips[1].processing=true;await inspect(`${F}.s3fReconnect()`);await click('prefetch');await pause(1000);
 assert.equal(await inspect(`${warmFrames}.length`),0,'Processing clips are not prefetched');
 warmClips[1].processing=false;warmClips[1].queue_state='waiting';await inspect(`${F}.s3fReconnect()`);await pause(1000);
 assert.equal(await inspect(`${warmFrames}.length`),0,'Waiting jobs are not prefetched');
 warmClips[1].queue_state=null;const prefetchRequests=requests.length,originalRevision=states[warmClips[1].editor_session].revision;
 await inspect(`${F}.s3fReconnect()`);await prefetched();
 assert.equal(await inspect(`${warmFrames}.length`),2,'Only the next clip has two prepared editors');
 assert.equal(await currentId(),warmClips[0].id,'Preloading does not navigate');
 assert.equal(await inspect('window.s3fWorkspaceFrames().length'),3,'Preloaded editors are not registered as active');
 assert.equal(states[warmClips[1].editor_session].revision,originalRevision,'Preloading never saves the next draft');
 assert.equal(requests.slice(prefetchRequests).some(r=>r.clip===warmClips[1].id&&['open','lease','review'].includes(r.action)),false,'Prefetch does not open or claim the next clip');
 await inspect(`window.warmMotion=${warmFrames}.find(frame=>frame.dataset.kind==='motion');window.warmTimeline=${warmFrames}.find(frame=>frame.dataset.kind==='timeline');true`);
 assert.equal(await startMedia('window.warmMotion.contentWindow'),false,'Preloaded media cannot play');
 // Filters retire the unused editors and cancel obsolete work.
 await inspect(`${F}.document.querySelector('#search').value='prefetch/c';${F}.document.querySelector('#search').dispatchEvent(new Event('input'))`);
 await prefetched();
 assert.equal(await inspect('window.warmMotion.isConnected||window.warmTimeline.isConnected'),false,'Changing filters releases preloaded frames');
 assert.equal(await inspect(`${warmFrames}.every(frame=>new URL(frame.src).searchParams.get('session')===({'motion':'${warmClips[2].editor_session}','timeline':'${warmClips[2].timeline}'})[frame.dataset.kind])`),true,'Prefetch follows the filtered next clip');
 await inspect(`${F}.document.querySelector('#search').value='prefetch/';${F}.document.querySelector('#search').dispatchEvent(new Event('input'))`);await prefetched();
 await inspect(`window.warmMotion=${warmFrames}.find(frame=>frame.dataset.kind==='motion');window.warmTimeline=${warmFrames}.find(frame=>frame.dataset.kind==='timeline');true`);
 const changed=states[warmClips[1].editor_session];changed.revision++;changed.project.scripts.L0.actions[0].pos=46;
 await inspect(`${M(warmClips[0])}.edit(63)`);failSave=true;await click('next');
 await until(()=>inspect(`${F}.document.querySelector('#status').classList.contains('error')&&!${F}.document.querySelector('#next').disabled`),'save failure keeps prefetch');
 assert.equal(await currentId(),warmClips[0].id);assert.equal(await inspect('window.warmMotion.isConnected'),true);
 failSave=false;await click('next');await readyClip(warmClips[1]);
 assert.equal(await inspect(`window.warmMotion.contentWindow===${M(warmClips[1])}&&window.warmTimeline.contentWindow===${T(warmClips[1])}`),true,'Next reuses both preloaded windows without reloading');
 assert.equal(await inspect(`${M(warmClips[1])}.s3fEditorRevision()`),changed.revision,'Promotion checks for newer saved edits');
 assert.equal(states[warmClips[0].editor_session].project.scripts.L0.actions[0].pos,63,'Next still flushes current edits');
 assert.equal(await mediaPlaying(M(warmClips[1])),false,'Promoted video stays paused');
 await prefetched();await screenshot('next-preloaded','#prefetch-status');
 await inspect(`window.warmMotion=${warmFrames}.find(frame=>frame.dataset.kind==='motion');true`);
 await click('ignore');await readyClip(warmClips[2]);
 assert.equal(await inspect(`window.warmMotion.contentWindow===${M(warmClips[2])}`),true,'Skip also reuses the preloaded clip');
 await selectValue('review-order','random');await prefetched();
 const preloadOrder=await reviewIds(),preloadCurrent=await currentId(),preloadNext=entries.find(e=>e.id===preloadOrder[(preloadOrder.indexOf(preloadCurrent)+1)%preloadOrder.length]);
 assert.equal(await inspect(`${warmFrames}.find(frame=>frame.dataset.kind==='motion').src.includes('${preloadNext.editor_session}')`),true,'Prefetch follows random review order');
 await click('prefetch');assert.equal(await inspect(`${warmFrames}.length`),0,'Turning prefetch off releases the prepared clip');
 if(!legacyFolderAPI){
  const automatic=addReviewClip('auto-intensity/a.mp4',120),manual=addReviewClip('auto-intensity/b.mp4',121);
  Object.assign(automatic,{intensity:0,intensity_mode:'auto'});Object.assign(manual,{intensity:4,intensity_mode:'manual'});
  await inspect(`${F}.s3fReconnect()`);await chooseFolders(['']);
  await selectValue('review-order','alphabetical');await selectValue('filter','ready');await selectValue('quality-filter','all');
  await inspect(`${F}.document.querySelector('#search').value='auto-intensity/';${F}.document.querySelector('#search').dispatchEvent(new Event('input'))`);
  await selectValue('clips',automatic.id);await readyClip(automatic);
  const autoValue=level=>until(()=>inspect(`${F}.document.querySelector('#intensity').value==='${level}'&&${F}.document.querySelector('#intensity-auto').checked`),'auto intensity '+level);
  await autoValue(1);await click('review');
  await until(()=>automatic.intensity===1,'initial estimate saved');
  const beforeEdit=requests.length;
  await inspect(`${M(automatic)}.edit(95)`);await autoValue(5);
  assert.equal(requests.slice(beforeEdit).filter(r=>r.action==='intensity').length,1,'One estimate per saved revision');
  await click('review');await until(()=>automatic.intensity===5,'updated estimate saved');
  await until(()=>inspect(`!${F}.document.querySelector('#intensity').disabled`),'review controls ready');
  await selectValue('intensity','2');assert.equal(await inspect(`${F}.document.querySelector('#intensity-auto').checked`),false,'Manual rating disables Auto');
  await inspect(`${M(automatic)}.edit(20)`);
  await until(()=>inspect(`${F}.document.querySelector('#intensity-estimate').textContent.includes('Manual · estimate 1')`),'manual comparison refresh');
  assert.equal(await inspect(`${F}.document.querySelector('#intensity').value`),'2','New curve cannot overwrite manual value');
  await click('review');await until(()=>automatic.intensity_mode==='manual'&&automatic.intensity===2,'manual mode saved');
  await click('next');await readyClip(manual);
  assert.equal(await inspect(`${F}.document.querySelector('#intensity').value`),'4','Other clips retain their rating');
  assert.equal(await inspect(`${F}.document.querySelector('#intensity-auto').checked`),false);
  await click('previous');await readyClip(automatic);
  assert.equal(await inspect(`${F}.document.querySelector('#intensity').value`),'2','Manual choice survives reopening');
  await click('intensity-auto');await autoValue(1);await click('review');
  await until(()=>automatic.intensity_mode==='auto'&&automatic.intensity===1,'Auto can be restored');
  await screenshot('auto-intensity','#current');
 }
 // H3 mode follows reading order, including pages without rendered clips.
 await host.evaluate("app.graph._nodes[0].type='S3F_H3ProjectTimeline'");
 const h3Clips=['page2/latest.mp4','page2/older.mp4'].map((name,i)=>addReviewClip(name,150+i));
 for(const [i,e]of h3Clips.entries())e.h3={page_id:'page_0002',panel_id:'page_0002_panel_001',latest:i===1,main:i===0,label:`Page 2 · Panel 1 · take_${i===0?'0002':'0001'}`,page_excluded:false};
 h3Book={workspace_version:2,title:'Neutral H3 project',confidence:.15,excluded_pages:[],excluded_videos:[],pages:[{id:'page_0001',order:0,name:'1.png',videos:0,panels:0,image:'neutral.png'},{id:'page_0002',order:1,name:'2.png',videos:2,panels:1,image:'neutral.png'}],panels:[{id:'page_0002_panel_001',page_id:'page_0002',order:0,image:'neutral.png'}]};
 await inspect(`${F}.document.querySelector('#search').value='';${F}.document.querySelector('#filter').value='active';${F}.document.querySelector('#quality-filter').value='all';${F}.s3fReconnect()`);
 await until(()=>inspect(`${F}.document.querySelector('#h3-project')?.hidden===false`),'H3 workspace');
 const readyH3=async e=>until(()=>inspect(`${F}.s3fFolderIdentity?.().entry?.id==='${e.id}'&&${M(e)}?.ready&&!${F}.document.querySelector('#motion-frame').hasAttribute('aria-busy')&&!${F}.document.querySelector('#open').disabled`),'H3 clip ready');
 await selectValue('clips',h3Clips[0].id);await readyH3(h3Clips[0]);
 entries.splice(0,entries.length,...h3Clips);await inspect(`${F}.s3fReconnect()`);
 assert.equal(await inspect(`${F}.document.querySelector('#review-order-controls').hidden&&${F}.document.querySelector('.library-tabs').hidden`),true,'Project has no random or remote browser controls');
 assert.deepEqual(await reviewIds(),[h3Clips[0].id],'Chosen H3 main appears by default even when an alternate is newer');
 await selectValue('h3-page','page_0001');assert.equal(await inspect(`${F}.document.querySelector('#clip-workbench').hidden`),true,'Empty page cannot show the previous page’s video');
 await inspect(`${F}.document.querySelector('#h3-checks').open=true`);await click('h3-check-page');
 await until(()=>inspect(`${F}.document.querySelectorAll('.h3-person-box').length===1`),'still detector box');
 assert.ok(requests.some(r=>r.action==='h3-probe'&&r.page==='page_0001'));
 await click('h3-exclude');await until(()=>h3Book.excluded_pages.includes('page_0001'),'exclude unrendered page');
 await until(()=>inspect(`!${F}.document.querySelector('#h3-exclude').disabled`),'page action finished');
 await click('h3-exclude');await until(()=>!h3Book.excluded_pages.length,'restore unrendered page');
 await until(()=>inspect(`!${F}.document.querySelector('#h3-page').disabled`),'page restored');
 await selectValue('h3-page','page_0002');await readyH3(h3Clips[0]);
 assert.equal(await inspect(`${F}.document.querySelector('#clip-workbench').hidden`),false);
 await click('h3-older');assert.deepEqual(await reviewIds(),h3Clips.map(e=>e.id),'Older takes are explicitly available');
 await selectValue('clips',h3Clips[1].id);await readyH3(h3Clips[1]);
 await inspect(`${M(h3Clips[1])}.edit(48);${F}.document.querySelector('#h3-confidence').value='0.25'`);await click('h3-save-confidence');
 await until(()=>h3Book.confidence===.25,'project confidence saved');
 assert.equal(states[h3Clips[1].editor_session].project.scripts.L0.actions[0].pos,48,'Project actions flush unsaved edits');
 await until(()=>inspect(`!${F}.document.querySelector('#h3-exclude').disabled`),'confidence action finished');
 // Background renders and failed saves must preserve a typed project setting.
 await inspect(`${F}.document.querySelector('#h3-confidence').value='0.35';${F}.document.querySelector('#h3-confidence').dispatchEvent(new Event('input'));${F}.document.querySelector('#h3-confidence').blur()`);
 await click('refresh');await until(()=>requests.some(r=>r.action==='scan'&&r.refresh==='1'),'explicit H3 catalogue refresh');
 await readyH3(h3Clips[1]);
 assert.equal(await inspect(`${F}.document.querySelector('#h3-confidence').value`),'0.35','Refresh retains unsaved confidence after blur');
 failSave=true;await inspect(`${M(h3Clips[1])}.edit(49)`);await click('h3-save-confidence');
 await until(()=>inspect(`${F}.document.querySelector('#status').textContent.includes('Temporary save failure')`),'confidence save blocked by unsaved curve');
 assert.equal(h3Book.confidence,.25);
 assert.equal(await inspect(`${F}.document.querySelector('#h3-confidence').value`),'0.35','Failed save retains typed confidence');
 failSave=false;await click('h3-save-confidence');await until(()=>h3Book.confidence===.35,'confidence retry');await readyH3(h3Clips[1]);
 // Drawing trial uses only this node and leaves the saved Main unchanged.
 await click('h3-check-video');await until(()=>inspect(`${F}.document.querySelector('#h3-probe-results button')!==null`),'select a detected person');
 await inspect(`${F}.document.querySelector('#h3-probe-results button').click()`);
 const mainBeforeTrial=structuredClone(states[h3Clips[1].editor_session].project.scripts);
 await click('h3-trial');await until(()=>inspect(`${F}.document.querySelector('#h3-trial-curve').hidden===false`),'short trial result');
 assert.equal(h3Trial.clip,h3Clips[1].id);assert.equal(h3Trial.anchor,'pelvis');
 assert.deepEqual(Object.keys(batchPrompt.output),['9']);assert.deepEqual(states[h3Clips[1].editor_session].project.scripts,mainBeforeTrial);
 await until(()=>inspect(`!${F}.document.querySelector('#h3-trial').disabled`),'trial unlock');
 await click('h3-load-preset');await until(()=>inspect(`${F}.document.querySelector('#h3-preset-smoothing').value==='40'`),'inherited preset');
 await selectValue('h3-preset-scope','panel');await click('h3-save-preset');
 await until(()=>requests.some(r=>r.action==='h3_preset'&&r.panel==='page_0002_panel_001'&&r.settings?.smoothing_ms===40),'copy preset to panel');
 await click('h3-save-draft');await until(()=>requests.some(r=>r.action==='h3_save_draft'&&r.clip===h3Clips[1].id),'portable save flushes current clip');await readyH3(h3Clips[1]);
 // Browsing pages and selecting a queue must not load or discard current edits.
 const otherPage=addReviewClip('page1/latest.mp4',152);
 delete otherPage.batch_result;otherPage.h3={page_id:'page_0001',panel_id:'page_0001_panel_001',latest:true,main:true,take:'take_0001',label:'Page 1 · Panel 1 · take_0001',page_excluded:false};
 h3Book.panels.push({id:'page_0001_panel_001',page_id:'page_0001',order:0});
 h3Book.pages[0].videos=1;await click('refresh');await readyH3(h3Clips[1]);
 failSave=true;await inspect(`${M(h3Clips[1])}.edit(51)`);const opensBefore=requests.filter(r=>r.action==='open').length;
 await selectValue('h3-page','page_0001');
 assert.equal(await inspect(`${F}.document.querySelector('#h3-page').value`),'page_0001');
 assert.equal(await inspect(`${F}.document.querySelector('#clip-workbench').hidden`),true,'Browse does not display an unrelated editor');
 assert.equal(requests.filter(r=>r.action==='open').length,opensBefore,'Browsing pages does not load media');
 await click('h3-select-page');
 assert.equal(await inspect(`${F}.document.querySelectorAll('#h3-queue-items .h3-queue-row').length`),1,'Select panels before opening a take');
 assert.equal(requests.filter(r=>r.action==='open').length,opensBefore);
 await inspect(`${F}.document.querySelector('[data-panel="page_0001_panel_001"] button').click()`);await click('h3-open-panel');
 await until(()=>inspect(`${F}.document.querySelector('#status').textContent.includes('Temporary save failure')`),'new panel open protects unsaved curve');
 assert.equal(await inspect(`${F}.s3fFolderIdentity().entry.id`),h3Clips[1].id);
 failSave=false;await click('h3-open-panel');await readyH3(otherPage);
 assert.equal(states[h3Clips[1].editor_session].project.scripts.L0.actions[0].pos,51,'Retry saves original page edits');
 await selectValue('h3-page','page_0002');await selectValue('clips',h3Clips[0].id);await readyH3(h3Clips[0]);
 // Replacing a layout can change its panels without changing the page count.
 h3Book.panels[0]={id:'page_0002_panel_002',page_id:'page_0002',order:0,image:'neutral.png'};
 h3Book.pages[1].image_version='updated';h3Book.warnings=['Skipped one malformed take; other videos remain available.'];
 await click('refresh');await readyH3(h3Clips[0]);
 assert.equal(await inspect(`${F}.document.querySelector('#h3-panel').value`),'page_0002_panel_002');
 assert.ok((await inspect(`${F}.document.querySelector('#h3-page-image').src`)).includes('v=updated'));
 assert.ok((await inspect(`${F}.document.querySelector('#h3-project').textContent`)).includes('Skipped one malformed take'));
 await click('h3-check-panel');await until(()=>inspect(`${F}.document.querySelectorAll('.h3-person-box').length===1`),'updated panel detector box');
 await inspect(`${F}.document.querySelector('#h3-confidence').value='0.25'`);await click('h3-save-confidence');
 await until(()=>h3Book.confidence===.25,'new confidence saved');await readyH3(h3Clips[0]);
 assert.equal(await inspect(`${F}.document.querySelectorAll('.h3-person-box').length`),0,'Threshold change clears old probe results');
 await click('h3-exclude');await until(()=>h3Clips.every(e=>e.status==='ignored'),'whole page excludes all takes');
 await until(()=>inspect(`${F}.document.querySelector('#bulk').disabled`),'excluded page has no bulk candidates');
 assert.equal(await inspect(`${F}.document.querySelector('#restore').disabled`),true,'Page exclusion cannot be cleared by restoring one video');
 await screenshot('h3-project','#h3-shell');
 await inspect(`${F}.scrollTo(0,0)`);
 const output=path.join(root,'development/folder-browser');fs.mkdirSync(output,{recursive:true});await w.call('Emulation.setDeviceMetricsOverride',{width:1400,height:900,deviceScaleFactor:1,mobile:false});fs.writeFileSync(path.join(output,'folder.png'),Buffer.from((await w.call('Page.captureScreenshot')).data,'base64'));
 assert.deepEqual(errors,[]);console.log('PASS: folder/workspace bridge, delayed editor/video transitions, rapid switching, paused playback and retained scroll, edit flush, approval, failed-save protection, concurrent review, versions, shortcuts; Civitai tab, existing downloads, API sorting/pagination, selected-only bulk, temporary review, manual edits, approve/category/next and reject temporary.');
}catch(error){console.error(JSON.stringify({errors,state:await failureState(),requests:requests.slice(-5)},null,2));throw error;}finally{for(const ws of sockets)ws.close();const exited=new Promise(r=>chrome.once('exit',r));chrome.kill('SIGTERM');await exited;server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(temp,{recursive:true,force:true});}
