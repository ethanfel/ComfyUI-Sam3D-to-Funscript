// Real browser paging against neutral local fixtures; no Civitai requests.
import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import http from 'node:http';
import {spawn,spawnSync} from 'node:child_process';
const root=path.resolve('.'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'s3f-civitai-paging-')),folder='f'.repeat(32),requests=[];
const media=path.join(temp,'neutral.mp4');
assert.equal(spawnSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=0x35675c:size=160x90:rate=10','-t','5','-c:v','libx264','-pix_fmt','yuv420p',media]).status,0);
const entry=id=>({id:String(id).padStart(32,'0'),name:`Neutral_civitai_${id}_original.mp4`,existing:[],status:'pending',category:'Example',processed:false});
const locals=Object.fromEntries(Array.from({length:54},(_,i)=>[String(1000+i),[entry(1000+i)]]));
const library=()=>({folder,root:'/neutral',items:locals,categories:['Example'],ignored:[],downloads:{},token_configured:true,video_galleries:true,queue:{stage:'idle',items:[]}});
let failMore=false,holdMore=false,repeatCursor=false;const held=[];
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');const send=(body,type='application/json')=>{res.setHeader('Content-Type',type);res.end(typeof body==='string'||Buffer.isBuffer(body)?body:JSON.stringify(body));};
 if(url.pathname.endsWith('/paging.html'))return send(`<link rel="stylesheet" href="/assets/civitai-browser.css"><style>body{margin:20px;background:#192730;color:#dce7ef;font:14px sans-serif}.controls{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:12px 0}button,select,input{padding:8px}label{display:inline-flex;gap:6px;align-items:center}.hint{font-size:12px}[hidden]{display:none!important}</style><main id="root"></main><script type="module">import {civitaiBrowser} from '/assets/civitai-browser.mjs';window.browser=civitaiBrowser(document.querySelector('main'),{folder:'${folder}',reviewMode(){},reviewState(){return {}},refreshFolder(){}});await browser.activate();window.ready=true;</script>`,'text/html');
 if(url.pathname.startsWith('/assets/'))return send(fs.readFileSync(path.join(root,'assets',path.basename(url.pathname))),url.pathname.endsWith('.css')?'text/css':'text/javascript');
 if(req.method==='GET'&&url.pathname.endsWith('/'+folder))return send(library());
 if(url.pathname.endsWith('/browse')||url.pathname.endsWith('/gallery')){
  let text='';for await(const part of req)text+=part;const body=JSON.parse(text);requests.push(body);
  if(body.cursor&&holdMore)await new Promise(resolve=>held.push(resolve));
  if(body.cursor&&failMore){res.statusCode=503;return send('Temporary fixture error','text/plain');}
  const page=body.cursor==='p2'?2:body.cursor==='p1'?1:0;
  const ids=page===0?Array.from({length:24},(_,i)=>i+1):page===1?[24,...Array.from({length:24},(_,i)=>i+25)]:[49,50,51,52,53,54];
  return send({items:ids.map(id=>({id:String(id),username:'Neutral creator',post_id:'77',url:base+'/neutral.mp4',page:base+'/neutral.mp4'})),next_cursor:page===2?null:page===1&&repeatCursor?'p1':page===0?'p1':'p2',library:library(),gallery:{kind:body.kind,id:body.id,post_id:'77',username:'Neutral creator'}});
 }
 if(url.pathname.endsWith('.mp4')||url.pathname.includes('/local/'))return send(fs.readFileSync(media),'video/mp4');
 if(url.pathname.includes('/thumbnail/'))return send('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="#35675c"/></svg>','image/svg+xml');
 res.statusCode=404;send('Missing fixture','text/plain');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
const profile=path.join(temp,'chrome'),chrome=spawn('/opt/google/chrome/chrome',['--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-first-run','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore'});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label){for(let n=0;n<160;n++){if(await fn())return;await pause(50);}throw Error('Timeout: '+label);}
let ws,port;const errors=[];
try{
 await until(()=>{try{port=fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0];return port;}catch{return false;}},'Chrome');
 const target=(await(await fetch(`http://127.0.0.1:${port}/json`)).json()).find(value=>value.type==='page');
 ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise(resolve=>ws.addEventListener('open',resolve,{once:true}));let sequence=0;const pending=new Map();
 ws.addEventListener('message',event=>{const message=JSON.parse(event.data);if(message.id){pending.get(message.id)(message);pending.delete(message.id);}else if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails);});
 const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,message=>message.error?reject(Error(JSON.stringify(message.error))):resolve(message.result));ws.send(JSON.stringify({id,method,params}));});
 const inspect=async expression=>{const result=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));return result.result.value;};
 await call('Runtime.enable');await call('Page.enable');await call('Emulation.setDeviceMetricsOverride',{width:1200,height:800,deviceScaleFactor:1,mobile:false});
 await call('Page.navigate',{url:base+'/sam3d_funscript/assets/paging.html'});await until(()=>inspect('window.ready'),'browser');
 const click=id=>inspect(`document.getElementById('${id}').click()`);
 const select=(id,value)=>inspect(`document.getElementById('${id}').value='${value}';document.getElementById('${id}').dispatchEvent(new Event('change'))`);
 const ids=()=>inspect(`[...document.querySelectorAll('.civitai-card')].map(card=>card.dataset.id)`);
 const bottom=()=>inspect(`document.querySelector('#cv-more').scrollIntoView({block:'end'})`);
 const idle=()=>until(()=>inspect(`!document.querySelector('#cv-navigation').disabled`),'request finished');
 assert.equal(await inspect(`document.querySelector('#cv-navigation').value`),'infinite');
 await select('cv-navigation','pages');await select('cv-view','remote');await click('cv-browse');await idle();
 assert.equal((await ids()).length,24);await bottom();await pause(200);assert.equal(requests.length,1,'Page mode never auto-fetches');
 await inspect(`document.querySelector('[data-id="2"] .cv-check').click()`);
 await inspect(`document.querySelector('#cv-creator').value='Unsubmitted search'`);
 await click('cv-next-page');await idle();assert.equal((await ids())[0],'25');assert.equal((await ids()).length,24,'Overlapping API items are deduplicated');
 assert.equal(requests.at(-1).username,'','A page cursor stays paired with the original query');await inspect(`document.querySelector('#cv-creator').value=''`);
 const cachedRequests=requests.length;await click('cv-prev-page');
 assert.equal((await ids())[0],'1');assert.equal(requests.length,cachedRequests,'Previous pages use cached results');
 assert.equal(await inspect(`document.querySelector('[data-id="2"] .cv-check').checked`),true,'Selections survive page navigation');
 await click('cv-next-page');assert.equal(requests.length,cachedRequests);await click('cv-next-page');await idle();
 assert.equal((await ids()).length,6);assert.equal(await inspect(`document.querySelector('#cv-next-page').disabled`),true);
 assert.equal(await inspect(`document.querySelector('#cv-page-number').textContent`),'Page 3 / 3');
 if(process.env.S3F_TEST_SCREENSHOTS){fs.mkdirSync(process.env.S3F_TEST_SCREENSHOTS,{recursive:true});fs.writeFileSync(path.join(process.env.S3F_TEST_SCREENSHOTS,'pages.png'),Buffer.from((await call('Page.captureScreenshot')).data,'base64'));}
 await click('cv-prev-page');await inspect(`document.querySelector('[data-id="25"] [data-gallery="post"]').click()`);await idle();
 assert.equal(await inspect(`document.querySelector('#cv-page-number').textContent`),'Page 1');
 await click('cv-next-page');await idle();assert.equal((await ids())[0],'25');
 await inspect(`document.querySelector('[data-id="25"] [data-gallery="creator"]').click()`);await idle();
 assert.equal((await ids())[0],'1');await click('cv-gallery-back');assert.equal((await ids())[0],'25');
 assert.equal(await inspect(`document.querySelector('#cv-page-number').textContent`),'Page 2');
 await click('cv-gallery-back');assert.equal((await ids())[0],'25');
 assert.equal(await inspect(`document.querySelector('#cv-page-number').textContent`),'Page 2 / 3','Gallery Back restores the selected feed page');
 await inspect(`scrollTo(0,0)`);await select('cv-navigation','infinite');await click('cv-browse');await idle();
 await inspect(`(async()=>{window.firstVideo=document.querySelector('.civitai-card video');firstVideo.loop=true;await firstVideo.play()})()`);
 const start=requests.length;holdMore=true;await bottom();await until(()=>held.length===1,'automatic next page');
 await bottom();await pause(150);assert.equal(requests.length,start+1,'Only one automatic request is in flight');
 holdMore=false;held.splice(0).forEach(resolve=>resolve());await idle();
 assert.equal((await ids()).length,48);assert.equal(await inspect(`firstVideo===document.querySelector('.civitai-card video')&&!firstVideo.paused`),true,'Appending leaves existing previews playing');
 assert.equal(await inspect(`document.querySelector('[data-id="2"] .cv-check').checked`),true);
 failMore=true;await bottom();await until(()=>inspect(`document.querySelector('#cv-status').textContent.includes('Temporary fixture error')`),'pagination failure');
 const failedRequests=requests.length;await pause(600);assert.equal(requests.length,failedRequests,'Failures do not cause retry loops');
 failMore=false;await click('cv-more');await idle();assert.equal((await ids()).length,54);
 assert.equal(await inspect(`document.querySelector('#cv-more').hidden`),true,'End of feed stops loading');
 // An old cursor response must not populate a newly filtered feed.
 await inspect(`scrollTo(0,0)`);await click('cv-browse');await idle();holdMore=true;await bottom();await until(()=>held.length===1,'held page');
 await select('cv-ratings','16');holdMore=false;held.splice(0).forEach(resolve=>resolve());await pause(200);
 assert.equal((await ids()).length,0);assert.equal(await inspect(`document.querySelector('#cv-more').hidden`),true);
 // Hidden completed pages are traversed until matching cards appear.
 for(let id=1;id<=24;id++)locals[id]=[{...entry(id),processed:true}];
 await inspect(`scrollTo(0,0)`);await click('cv-hide-done');await click('cv-browse');await idle();await bottom();
 await until(async()=> (await ids()).length===24,'skip completed page');assert.equal((await ids())[0],'25');
 // A server repeating a cursor must not cause an endless load loop.
 await click('cv-hide-done');await inspect(`scrollTo(0,0)`);repeatCursor=true;await click('cv-browse');await idle();await bottom();
 await until(async()=> (await ids()).length===48,'repeated cursor page');assert.equal(await inspect(`document.querySelector('#cv-more').hidden`),true);repeatCursor=false;
 // Local pages reveal cached entries without requesting Civitai.
 for(let id=1;id<=24;id++)delete locals[id];await click('cv-refresh');await select('cv-view','local');await inspect(`scrollTo(0,0)`);
 assert.equal((await ids()).length,48);const localRequests=requests.length;await bottom();await until(async()=> (await ids()).length===54,'local infinite page');assert.equal(requests.length,localRequests);
 await select('cv-navigation','pages');await click('cv-prev-page');assert.equal((await ids()).length,48);await click('cv-next-page');assert.equal((await ids()).length,6);
 assert.equal(await inspect(`JSON.parse(localStorage.getItem('s3f-civitai:${folder}'))['cv-navigation']`),'pages');
 await select('cv-view','remote');await inspect(`scrollTo(0,0)`);await click('cv-browse');await idle();await select('cv-navigation','infinite');
 await inspect('browser.deactivate()');const inactiveRequests=requests.length;await bottom();await pause(250);assert.equal(requests.length,inactiveRequests,'Inactive browsers do not load more');
 assert.deepEqual(errors,[]);console.log('PASS: infinite scroll, cached pages, selection, preview preservation, cursor overlap/loops, filter cancellation, retry, hidden completed pages, local paging and inactive views.');
}finally{held.splice(0).forEach(resolve=>resolve());ws?.close();const exit=new Promise(resolve=>chrome.once('exit',resolve));chrome.kill('SIGTERM');await exit;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(temp,{recursive:true,force:true});}
