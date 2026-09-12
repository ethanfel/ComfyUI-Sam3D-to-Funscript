// Retain real Timeline and editor-session documents across a backend restart
// and opener reload. All state and windows belong to a disposable test server.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {spawn,spawnSync} from 'node:child_process';
const root=path.resolve('.'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'s3f-reconnect-'));
const clip=path.join(temp,'neutral.mp4');
const encoded=spawnSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=160x120:rate=2','-t','2','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p',clip]);
assert.equal(encoded.status,0,encoded.stderr.toString());
const session='a'.repeat(32),editor='b'.repeat(32),api=`/sam3d_funscript/timelines/${session}`;
const source={path:'neutral.mp4',size:100,mtime_ns:1000};
let state={session,revision:1,editor_session:editor,info:{source_id:'neutral',source,start:'0',duration:'2',source_origin:'0',rate:'2',width:160,height:120,end_ms:2000},plan:{version:1,source_id:'neutral',tracking:[],stabilization:[],selection:[0,0],selected_ids:[],join_ms:200,gap_policy:'hold',chunk_seconds:30},report:null,project:null};
let saved={revision:1,output:'fixture',project:{metadata:{source},scripts:{L0:{actions:[{at:0,pos:20}]}},timeline:{sources:[],tracks:[],main:{},selection:[0,0]}}},queued=0,failPlanOnce=false;
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');res.setHeader('Cache-Control','no-store');
 const send=(data,type='text/javascript')=>{res.setHeader('Content-Type',type);res.end(data);};
 const json=data=>send(JSON.stringify(data),'application/json');
 if(url.pathname==='/host')return send(`<button id="open">Open workspace</button><script type="module">
 import {app} from '/scripts/app.js';import {api} from '/scripts/api.js';
 import {openWorkspace,registerWorkspaceTool} from '/extensions/s3f/workspace.mjs';
 import '/extensions/s3f/processing-timeline.js';
 registerWorkspaceTool('motion',{describe:n=>({key:'motion:'+n.properties.s3f_session,label:'Motion Studio',url:'/sam3d_funscript/assets/viewer.html?session='+n.properties.s3f_session})});
 for(const extension of app.extensions)extension.setup?.();
 document.querySelector('#open').onclick=()=>openWorkspace(app.graph._nodes[0]);window.openTool=index=>openWorkspace(app.graph._nodes[index]);window.hostApp=app;window.hostReady=true;
 </script>`,'text/html');
 if(url.pathname==='/scripts/app.js')return send(`const foreign=location.search.includes('foreign');
 const timeline={id:9,type:'S3F_ProcessingTimeline',properties:{s3f_timeline_session:foreign?'c'.repeat(32):'${session}',s3f_timeline_ready:true},widgets:[{name:'plan_json',value:''}],setDirtyCanvas(){}};
 const motion={id:10,type:'S3F_StandaloneExport',properties:{s3f_session:foreign?'d'.repeat(32):'${editor}'}};
 export const app={extensions:[],registerExtension(e){this.extensions.push(e)},async queuePrompt(){},graph:{_nodes:[timeline,motion],links:{1:{origin_id:9,target_id:10,type:'S3F_MOTION_PROJECT'}},getNodeById(id){return this._nodes.find(n=>n.id===Number(id))},change(){}}};`);
 if(url.pathname==='/scripts/api.js')return send(`export const api=new EventTarget();api.apiURL=p=>p;api.fetchApi=(p,o)=>fetch(p,o);`);
 if(url.pathname==='/sam3d_funscript/assets/viewer.html')return send(`<p id="status"></p><p id="value"></p><script type="module">
 import {editorSession} from './editor-session.mjs';let project;
 window.testSession=editorSession({install:p=>{project=p;document.querySelector('#value').textContent=p.scripts.L0.actions[0].pos},snapshot:()=>project,status:s=>document.querySelector('#status').textContent=s});
 window.trackNames=()=>project.timeline.tracks.map(t=>t.name);window.edit=value=>{project.scripts.L0.actions[0].pos=value;document.querySelector('#value').textContent=value;window.testSession.changed()};
 await window.testSession.load();window.ready=true;
 </script>`,'text/html');
 if(url.pathname===`/sam3d_funscript/editors/${editor}`){
  if(req.method==='POST'){let body='';for await(const chunk of req)body+=chunk;const data=JSON.parse(body);
   if(data.revision!==saved.revision){res.writeHead(409);res.end('Another editor or rerun updated this session.');return;}
   saved={...saved,revision:saved.revision+1,project:data.project};return json({revision:saved.revision});
  }return json(saved);
 }
 if(url.pathname==='/sam3d_funscript/reference-capabilities')return json({});
 if(url.pathname===api){
  if(req.method==='POST'){let body='';for await(const chunk of req)body+=chunk;const data=JSON.parse(body);
   if(failPlanOnce){failPlanOnce=false;state.revision++;}
   if(data.revision!==state.revision){res.writeHead(409);res.end('Plan changed');return;}
   state={...state,revision:state.revision+1,plan:data.plan};
  }return json(state);
 }
 if(url.pathname===api+'/frames')return json({source_id:'neutral',first_frame:0,end_frame:4,times_ms:[0,500,1000,1500],end_ms:2000});
 if(url.pathname==='/prompt'){queued++;res.writeHead(500);res.end('Do not queue');return;}
 const name=path.basename(url.pathname),file=url.pathname===api+'/video'?clip:url.pathname.startsWith('/sam3d_funscript/assets/')?path.join(root,'assets',name):url.pathname.startsWith('/extensions/s3f/')?path.join(root,'web',name):null;
 if(!file||!fs.existsSync(file)){res.writeHead(404);res.end();return;}
 send(fs.readFileSync(file),({'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.mp4':'video/mp4'})[path.extname(file)]||'application/octet-stream');
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const serverPort=server.address().port,base=`http://127.0.0.1:${serverPort}`;
const profile=path.join(temp,'chrome'),chrome=spawn('/opt/google/chrome/chrome',['--headless','--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--disable-popup-blocking','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore'});
const pause=ms=>new Promise(r=>setTimeout(r,ms));let ws;
async function until(fn,label){for(let i=0;i<150;i++){try{if(await fn())return;}catch(error){if(error.code!==-32000||!/context|navigated|closed/i.test(error.message))throw error;}await pause(50);}throw new Error('Timed out: '+label);}
const errors=[];
try{
 let port;await until(()=>{try{port=fs.readFileSync(profile+'/DevToolsActivePort','utf8').split('\n')[0];return port;}catch{return false;}},'browser');
 const target=(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t=>t.type==='page');ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));let id=0;const pending=new Map();
 ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);if(p)m.error?p.reject(m.error):p.resolve(m.result);}else if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails);else if(m.method==='Page.javascriptDialogOpening')call('Page.handleJavaScriptDialog',{accept:true});});
 const call=(method,params={})=>new Promise((resolve,reject)=>{const key=++id,timer=setTimeout(()=>reject(new Error('CDP timed out: '+method)),10000);pending.set(key,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});ws.send(JSON.stringify({id:key,method,params}));});
 const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
 await call('Runtime.enable');await call('Page.enable');await call('Page.navigate',{url:base+'/host'});
 await until(()=>evaluate('window.hostReady'),'host startup');await evaluate('document.querySelector("#open").click()');
 let workspaceTarget;await until(async()=>{workspaceTarget=(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t=>t.url.includes('/workspace.html'));return workspaceTarget;},'workspace');
 // Attach a second CDP connection to inspect the retained window while its opener reloads.
 const workspaceSocket=new WebSocket(workspaceTarget.webSocketDebuggerUrl);await new Promise(r=>workspaceSocket.addEventListener('open',r,{once:true}));
 let wid=0;const waiting=new Map();workspaceSocket.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id){const finish=waiting.get(m.id);waiting.delete(m.id);finish?.(m);}});
 const inspect=async expression=>{const result=await new Promise((resolve,reject)=>{const id=++wid,timer=setTimeout(()=>reject(Error('Workspace evaluation timeout')),15000);waiting.set(id,m=>{clearTimeout(timer);resolve(m)});workspaceSocket.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}}));});if(result.error||result.result.exceptionDetails)throw Error(JSON.stringify(result));return result.result.result.value;};
 const timelineWindow=`window.s3fWorkspaceFrames().find(p=>p.key==='timeline:${session}').window`;
 const motionWindow=`window.s3fWorkspaceFrames().find(p=>p.key==='motion:${editor}').window`;
 await until(()=>inspect(`!!window.s3fWorkspaceFrames?.().length&&${timelineWindow}.document.querySelector('main')?.inert===false&&${motionWindow}.ready`),'tool startup');
 // An already-open ComfyUI page can still send the legacy ready response,
 // including its original Timeline selection on every heartbeat.
 await inspect(`window.configureBeforeUpgrade=window.s3fConfigureWorkspace;window.s3fConfigureWorkspace=configuration=>window.configureBeforeUpgrade({...configuration,active:'timeline:${session}'})`);
 await inspect(`document.querySelectorAll('#tabs button')[1].click()`);
 await inspect(`${motionWindow}.focus();${motionWindow}.edit(25)`);
 await until(()=>saved.project.scripts.L0.actions[0].pos===25,'Motion Studio autosave');
 await new Promise(r=>setTimeout(r,3500));
 assert.equal(await inspect(`document.querySelector('#tabs [aria-selected="true"]').textContent`),'Motion Studio','legacy heartbeat responses cannot switch tabs while editing');
 await inspect('window.s3fConfigureWorkspace=window.configureBeforeUpgrade');
 console.log('PASS: legacy heartbeat responses keep Motion Studio selected during editing and autosave');
 // Simulate a completed crop run whose broadcast did not reach the hidden iframe.
 await inspect(`document.querySelectorAll('#tabs button')[0].click();window.retainedMotion=${motionWindow};true`);
 saved.project.timeline.tracks.push({id:'crop31',name:'Tracking 31 crop'});saved.revision++;
 assert.deepEqual(await inspect('retainedMotion.trackNames()'),[]);
 await inspect(`document.querySelectorAll('#tabs button')[1].click()`);
 await until(()=>inspect(`retainedMotion.trackNames().includes('Tracking 31 crop')`),'new crop result on tab activation');
 assert.equal(await inspect(`retainedMotion===${motionWindow}`),true,'tab activation keeps the same editor document');
 assert.equal(await inspect(`document.querySelector('#tabs [aria-selected="true"]').textContent`),'Motion Studio');
 console.log('PASS: selecting Motion Studio fetches newly processed tracks after a missed broadcast without reloading or changing tabs');

 await inspect(`document.querySelectorAll('#tabs button')[0].click()`);
 await inspect(`window.originalTimeline=${timelineWindow};window.originalMotion=${motionWindow};originalTimeline.keptDraft='retained';originalTimeline.document.querySelector('#selectionIn').value='1';originalTimeline.document.querySelector('#selectionOut').value='3';originalTimeline.document.querySelector('#selectionOut').dispatchEvent(new Event('change'))`);
 assert.equal(await inspect('originalTimeline.s3fHasUnsavedEdits()'),true);
 await call('Page.reload');await until(()=>evaluate('window.hostReady'),'new opener');
 await until(()=>inspect(`document.querySelector('#connection').textContent==='Connected to ComfyUI'&&!document.querySelector('#notice').textContent&&window.opener.hostReady`),'workspace re-adoption');
 // Wait for the heartbeat to attach frames before the real Apply handshake.
 await new Promise(r=>setTimeout(r,3500));
 failPlanOnce=true;await inspect('originalTimeline.s3fTimelineApply()');
 assert.deepEqual(state.plan.selection,[500,1500]);
 assert.deepEqual(await evaluate('JSON.parse(window.hostApp.graph._nodes[0].widgets[0].value).plan.selection'),[500,1500]);
 assert.equal(await inspect(`originalTimeline===${timelineWindow}&&originalTimeline.keptDraft==='retained'`),true);
 console.log('PASS: opener reload reattaches the same Timeline document and Apply handles a harmless revision change');
 await evaluate('window.openTool(1);true');
 await until(()=>inspect(`document.querySelector('#tabs [aria-selected="true"]').textContent==='Motion Studio'`),'explicit Open Motion Studio');
 await new Promise(r=>setTimeout(r,3500));
 assert.equal(await inspect(`document.querySelector('#tabs [aria-selected="true"]').textContent`),'Motion Studio');
 await evaluate('window.openTool(0);true');
 await until(()=>inspect(`document.querySelector('#tabs [aria-selected="true"]').textContent==='Timeline'`),'explicit Open Timeline');
 await inspect(`window.s3fOpenWorkspacePage('/sam3d_funscript/assets/viewer.html?session=${editor}','motion')`);
 await new Promise(r=>setTimeout(r,3500));
 assert.equal(await inspect(`document.querySelector('#tabs [aria-selected="true"]').textContent`),'Motion Studio','Timeline link stays on Motion Studio');
 console.log('PASS: explicit node buttons and Timeline links still select the requested tool');

 server.closeAllConnections();await new Promise(r=>server.close(r));
 await until(()=>inspect(`document.querySelector('#connection').textContent.includes('unavailable')`),'server outage');
 await inspect('originalMotion.edit(35)');
 await until(()=>inspect(`originalMotion.document.querySelector('#status').textContent.includes('retrying')`),'pending save retry');
 assert.equal(saved.project.scripts.L0.actions[0].pos,25,'server copy remains unchanged during outage');
 // A restarted server can export identical curves at a newer revision.
 saved.revision++;saved.project.metadata.scene_cuts={times_ms:[500]};
 await new Promise(r=>server.listen(serverPort,'127.0.0.1',r));
 await until(()=>saved.project.scripts.L0.actions[0].pos===35,'unsaved curve recovery');
 await until(()=>inspect(`document.querySelector('#connection').textContent==='Connected to ComfyUI'&&!originalMotion.s3fHasUnsavedEdits()`),'reconnected session');
 assert.equal(await inspect(`originalMotion===${motionWindow}`),true);
 assert.deepEqual(saved.project.metadata.scene_cuts.times_ms,[500]);
 console.log('PASS: server restart preserves an unsaved curve and automatically resumes saving in the same Motion Studio document');

 await call('Page.navigate',{url:base+'/host?foreign'});await until(()=>evaluate('window.hostReady'),'foreign workflow');
 await until(()=>inspect(`document.querySelector('#notice').textContent.includes('matching workflow')`),'foreign workflow rejected');
 await inspect('originalTimeline.document.querySelector("#selectionOut").value="2";originalTimeline.document.querySelector("#selectionOut").dispatchEvent(new Event("change"))');
 assert.equal(await evaluate('window.hostApp.graph._nodes[0].widgets[0].value'),'');
 await call('Page.navigate',{url:base+'/host'});await until(()=>evaluate('window.hostReady'),'matching workflow restored');
 await until(()=>inspect(`!document.querySelector('#notice').textContent`),'matching session reattached');
 await inspect('originalTimeline.s3fTimelineApply()');assert.deepEqual(state.plan.selection,[500,1000]);
 assert.equal(queued,0,'reconnection never queues GPU work');
 assert.equal(errors.length,0,JSON.stringify(errors));
 console.log('PASS: unrelated workflow cannot adopt the old session; returning to the matching workflow recovers its draft without queueing');
 workspaceSocket.close();
}finally{
 ws?.close();const exited=new Promise(r=>chrome.once('exit',r));chrome.kill('SIGTERM');await exited;
 server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(temp,{recursive:true,force:true});
}
