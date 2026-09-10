// Exercise real browser module caching across an update, plus startup recovery.
// Uses an isolated server/profile, without opening or changing a user project.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {spawn,spawnSync} from 'node:child_process';

const root=path.resolve('.'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'s3f-startup-'));
const clip=path.join(temp,'neutral.mp4');
const encoded=spawnSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=160x120:rate=2','-t','2','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-movflags','+faststart',clip]);
assert.equal(encoded.status,0,encoded.stderr.toString());
const session='a'.repeat(32),draftKey=`s3f-processing-timeline:${session}`,api=`/sam3d_funscript/timelines/${session}`;
const state={session,revision:1,info:{source_id:'neutral',source:'neutral.mp4',start:'0',duration:'2',source_origin:'0',rate:'2',width:160,height:120,end_ms:2000},plan:{version:1,source_id:'neutral',tracking:[],stabilization:[],selection:[0,0],selected_ids:[],join_ms:200,gap_policy:'hold',chunk_seconds:30},report:null,project:null};
let warming=true,brokenModule=false,brokenApi=false,posts=0;
const helpers={'cut-markers.mjs':'cutSideRange','processing-timeline-edit.mjs':'regionFromSelection'},requests=[];
const server=http.createServer((req,res)=>{
 const url=new URL(req.url,'http://localhost'),name=path.basename(url.pathname);requests.push(req.url);
 if(req.method!=='GET'){posts++;res.writeHead(405);res.end();return;}
 if(url.pathname==='/prime'){
  res.setHeader('Content-Type','text/html');
  res.end(`<script type="module">await import('/sam3d_funscript/assets/cut-markers.mjs');await import('/sam3d_funscript/assets/processing-timeline-edit.mjs');window.primed=true;</script>`);return;
 }
 if(url.pathname===api){res.setHeader('Content-Type','application/json');res.writeHead(brokenApi?503:200);res.end(JSON.stringify(brokenApi?{error:'Server temporarily unavailable'}:state));return;}
 if(url.pathname===api+'/frames'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({source_id:'neutral',first_frame:0,end_frame:4,times_ms:[0,500,1000,1500],end_ms:2000}));return;}
 const file=url.pathname===api+'/video'?clip:url.pathname.startsWith('/sam3d_funscript/assets/')?path.join(root,'assets',name):null;
 if(!file||!fs.existsSync(file)||brokenModule&&name==='processing-timeline.js'){res.writeHead(404);res.end();return;}
 let data=fs.readFileSync(file);
 if(warming&&helpers[name])data=Buffer.from(data.toString().replace(`export function ${helpers[name]}`,`function ${helpers[name]}`));
 // Simulate the pre-fix server: unversioned helpers remain fresh after an update.
 res.setHeader('Cache-Control',helpers[name]&&!url.search?'max-age=3600':'no-store');
 res.setHeader('Content-Type',({'.html':'text/html','.mjs':'text/javascript','.js':'text/javascript','.css':'text/css','.mp4':'video/mp4'})[path.extname(file)]||'application/octet-stream');
 res.end(data);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`,url=`${base}/sam3d_funscript/assets/processing-timeline.html?session=${session}`;
const profile=path.join(temp,'chrome'),chrome=spawn('/opt/google/chrome/chrome',['--headless','--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore'});
const pause=ms=>new Promise(r=>setTimeout(r,ms));let ws;
async function until(fn,label){for(let i=0;i<150;i++){try{if(await fn())return;}catch(error){if(error.code!==-32000||!/context|navigated|closed/i.test(error.message))throw error;}await pause(50);}throw new Error('Timed out: '+label);}
const errors=[];
try{
 let port;await until(()=>{try{port=fs.readFileSync(profile+'/DevToolsActivePort','utf8').split('\n')[0];return port;}catch{return false;}},'browser');
 const target=(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t=>t.type==='page');ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));let id=0;const pending=new Map();
 ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);if(p)m.error?p.reject(m.error):p.resolve(m.result);}else if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails);else if(m.method==='Page.javascriptDialogOpening')call('Page.handleJavaScriptDialog',{accept:true});});
 const call=(method,params={})=>new Promise((resolve,reject)=>{const key=++id,timer=setTimeout(()=>reject(new Error('CDP timed out: '+method)),10000);pending.set(key,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});ws.send(JSON.stringify({id:key,method,params}));});
 const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
 await call('Runtime.enable');await call('Page.enable');await call('Page.navigate',{url:base+'/prime'});await until(()=>evaluate('window.primed'),'prime old modules');warming=false;
 const afterWarm=requests.length;
 await call('Page.navigate',{url});
 try{await until(()=>evaluate('document.querySelector("main")?.inert===false'),'updated Timeline after old modules were cached');}
 catch(error){console.error(JSON.stringify({status:await evaluate('document.querySelector("#status")?.textContent'),errors},null,2));throw error;}
 assert.equal(errors.length,0);
 for(const name of Object.keys(helpers))assert.ok(requests.slice(afterWarm).some(p=>p.includes(name+'?')),name+' must bypass the old cached module');
 console.log('PASS: upgrade loads despite old cached helper exports');

 // A lost module must surface an error before initialize() can run. Retry is
 // outside the inert editor, and retains the browser draft through recovery.
 await evaluate('document.querySelector("#selectionIn").value="1";document.querySelector("#selectionOut").value="3";document.querySelector("#selectionOut").dispatchEvent(new Event("change"))');
 const draft=await evaluate(`localStorage.getItem(${JSON.stringify(draftKey)})`);
 assert.deepEqual(JSON.parse(draft).plan.selection,[500,1500]);
 brokenModule=true;await call('Page.reload');
 await until(()=>evaluate('document.querySelector("#startupRecovery")?.hidden===false'),'module failure feedback');
 assert.equal(await evaluate('document.querySelector("#status").textContent'),'Timeline could not load');
 assert.ok(await evaluate('!document.querySelector("#retryStartup").closest("[inert]")'));
 assert.equal(await evaluate(`localStorage.getItem(${JSON.stringify(draftKey)})`),draft);
 brokenModule=false;await evaluate('setTimeout(()=>document.querySelector("#retryStartup").click(),0);true');
 await until(()=>evaluate('document.querySelector("main")?.inert===false&&document.querySelector("#status")?.textContent.includes("Recovered unsaved edits")'),'retry restores draft');
 assert.equal(await evaluate('document.querySelector("#selectionIn").value'),'1');
 assert.equal(await evaluate('document.querySelector("#selectionOut").value'),'3');
 console.log('PASS: missing module shows an actionable error; Retry preserves the draft');

 // Backend restart/unavailability is also recoverable without clearing data.
 brokenApi=true;await call('Page.reload');
 await until(()=>evaluate('document.querySelector("#startupRecovery")?.hidden===false'),'API failure feedback');
 assert.match(await evaluate('document.querySelector("#startupError").textContent'),/unavailable/);
 brokenApi=false;await evaluate('setTimeout(()=>document.querySelector("#retryStartup").click(),0);true');
 await until(()=>evaluate('document.querySelector("main")?.inert===false'),'API recovery');
 assert.equal(posts,0,'opening and retrying never write to the project');
 assert.equal(errors.length,0,'startup errors are caught and presented');
 console.log('PASS: backend unavailable/recovery; no project writes or uncaught errors');
}finally{
 ws?.close();const exited=new Promise(r=>chrome.once('exit',r));chrome.kill('SIGTERM');await exited;
 await new Promise(r=>server.close(r));fs.rmSync(temp,{recursive:true,force:true});
}
