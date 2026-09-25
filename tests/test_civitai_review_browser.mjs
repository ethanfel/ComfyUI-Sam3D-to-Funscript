// Real browser review editing against neutral fixtures; no remote requests or inference.
import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import http from 'node:http';
import {spawn} from 'node:child_process';
const root=path.resolve('.'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'s3f-civitai-review-')),folder='f'.repeat(32);
const locals=Object.fromEntries([1,2,3].map(id=>[String(id),[{id:String(id).repeat(32),name:`Neutral_civitai_${id}_original.mp4`,existing:[],status:'pending',category:'Example',processed:true,civitai_temporary:true}]]));
let aside={},queue={stage:'complete',items:Object.entries(locals).map(([id,[entry]])=>({id,key:id,clip:entry.id,name:entry.name,category:'Example',state:'ready'}))},failAside=false;
const library=()=>({folder,root:'/neutral',items:locals,set_aside:aside,categories:['Example'],ignored:[],downloads:{},token_configured:true,video_galleries:true,queue});
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');const send=(body,type='application/json')=>{res.setHeader('Content-Type',type);res.end(typeof body==='string'||Buffer.isBuffer(body)?body:JSON.stringify(body));};
 if(url.pathname.endsWith('/review.html'))return send(`<link rel="stylesheet" href="/assets/civitai-browser.css"><style>body{margin:20px;background:#192730;color:#dce7ef;font:14px sans-serif}.controls{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:12px 0}button,select,input{padding:8px}label{display:inline-flex;gap:6px;align-items:center}.hint{font-size:12px}[hidden]{display:none!important}</style><main id="root"></main><script type="module">import {civitaiBrowser} from '/assets/civitai-browser.mjs';window.hold=true;window.opened=[];window.processed=[];window.reviewVisible=false;let current=null;window.browser=civitaiBrowser(document.querySelector('main'),{folder:'${folder}',reviewMode(value){window.reviewVisible=value;},reviewState(){return {entry:current,ready:true}},refreshFolder(){},async openClip(id,options){opened.push(id);if(window.hold&&id==='${'1'.repeat(32)}')await new Promise(resolve=>window.release=resolve);current={id};},processClips(ids){processed.push(...ids);}});await browser.activate();window.ready=true;</script>`,'text/html');
 if(url.pathname.startsWith('/assets/'))return send(fs.readFileSync(path.join(root,'assets',path.basename(url.pathname))),url.pathname.endsWith('.css')?'text/css':'text/javascript');
 if(req.method==='GET'&&url.pathname.endsWith('/'+folder))return send(library());
 if(url.pathname.endsWith('/queue')){
  let text='';for await(const part of req)text+=part;const body=JSON.parse(text);
  if(failAside){res.statusCode=500;return send('Temporary list save failure','text/plain');}
  for(const row of body.items){
   if(body.action==='set_aside'){aside[row.id]={...row,name:locals[row.id][0].name};queue.items=queue.items.filter(item=>item.id!==row.id);}
   else if(body.action==='restore_review')delete aside[row.id];
  }
  return send(queue);
 }
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
 await call('Page.navigate',{url:base+'/sam3d_funscript/assets/review.html'});await until(()=>inspect('window.ready'),'browser');
 const click=id=>inspect(`document.getElementById('${id}').click()`);
 const select=(id,value)=>inspect(`document.getElementById('${id}').value='${value}';document.getElementById('${id}').dispatchEvent(new Event('change'))`);
 const ids=()=>inspect(`[...document.querySelectorAll('.civitai-card')].map(card=>card.dataset.id)`);
 const bottom=()=>inspect(`document.querySelector('#cv-more').scrollIntoView({block:'end'})`);
 const idle=()=>until(()=>inspect(`!document.querySelector('#cv-navigation').disabled`),'request finished');
 // Queue management must work before opening even the first video.
 const originalQueue=structuredClone(queue);
 queue.items.push({id:'4',key:'4',name:'Already approved.mp4',state:'approved'},{id:'5',key:'5',name:'Waiting clip.mp4',state:'waiting'});
 await click('cv-refresh');await until(()=>inspect("document.querySelectorAll('.cv-queue-list li').length===5"),'queue states');
 await inspect("document.querySelector('[data-edit-review]').click()");
 assert.equal(await inspect("document.querySelectorAll('#cv-list-rows li').length"),4,'Approved clips are omitted; waiting and ready clips can be managed');
 assert.deepEqual(await inspect('opened'),[],'Editing the list never opens a clip');
 assert.equal(await inspect('window.reviewVisible'),false);
 assert.equal(await inspect("document.querySelector('#cv-review-list').parentElement.id"),'cv-discovery','Management opens next to the processing queue');
 await inspect("document.querySelector('#cv-list-rows [data-id=\"3\"] input').click()");await click('cv-list-apply');
 await until(()=>Object.keys(aside).length===1,'set aside without video load');
 await until(()=>inspect("document.querySelectorAll('#cv-list-rows li').length===3"),'edited queue updated');
 assert.deepEqual(await inspect('opened'),[]);assert.deepEqual(await inspect('processed'),[]);
 assert.equal(await inspect("document.querySelector('#cv-review-panel').hidden"),true);
 await click('cv-list-close');queue=originalQueue;aside={};await click('cv-refresh');
 await until(()=>inspect("document.querySelectorAll('.cv-queue-list li').length===3"),'fixture restored');
 await inspect("document.querySelector('[data-review]').click()");await until(()=>inspect('!!window.release'),'slow clip opening');
 assert.equal(await inspect("document.querySelector('.cv-queue-list li button:last-child').disabled"),false,'Loading review must not lock processing queue controls');
 assert.equal(await inspect("document.querySelector('#cv-back').disabled"),false);
 await click('cv-edit-review');assert.equal(await inspect("document.querySelectorAll('#cv-list-rows li').length"),3);
 await inspect("document.querySelector('#cv-list-rows [data-id=\"1\"] input').click();document.querySelector('#cv-list-rows [data-id=\"3\"] input').click()");
 failAside=true;await click('cv-list-apply');await until(()=>inspect("document.querySelector('#cv-review-status').textContent.includes('Temporary list save failure')"),'failed save');
 assert.deepEqual(aside,{});assert.equal(queue.items.length,3,'Failed saves keep queue entries');
 failAside=false;await click('cv-list-apply');await until(()=>Object.keys(aside).length===2,'bulk set aside');
 await until(()=>inspect("document.querySelector('#cv-position').textContent.startsWith('Clip 1 / 1')"),'remaining clip selected');
 assert.equal(await inspect('opened.length'),1,'Opening is serialized until old response finishes');
 await inspect('window.hold=false;window.release();delete window.release');
 await until(()=>inspect("opened.length===2&&!document.querySelector('#cv-approve').disabled"),'remaining review opened');
 assert.deepEqual(await inspect('opened'),['1'.repeat(32),'2'.repeat(32)]);
 assert.deepEqual(await inspect('processed'),[],'An abandoned load never auto-processes');
 assert.equal(Object.keys(locals).length,3,'All videos are retained');
 assert.equal(aside['1'].category,'Example');
 assert.equal(await inspect("document.querySelector('#cv-resume').textContent"),'Review temporary clips (1)');
 await click('cv-back');await until(()=>inspect("document.querySelector('#cv-review-panel').hidden"),'leave review');
 await click('cv-aside');assert.equal(await inspect("document.querySelectorAll('#cv-list-rows li').length"),2);
 // Persistence must survive a completely new browser instance.
 await call('Page.reload');await until(()=>inspect('window.ready'),'reloaded');await click('cv-aside');
 assert.equal(await inspect("document.querySelectorAll('#cv-list-rows li').length"),2);
 assert.equal(await inspect("document.querySelector('#cv-resume').textContent"),'Review temporary clips (1)');
 assert.equal(await inspect("document.querySelectorAll('.cv-queue-list li').length"),1);
 // A set-aside, unfinished clip can be inspected without returning it or auto-processing.
 locals['1'][0].processed=false;
 await inspect("document.querySelector('#cv-list-rows [data-id=\"1\"] button').click()");
 await until(()=>inspect('!!window.release'),'manual set-aside loading');await inspect('window.hold=false;window.release();delete window.release');
 await until(()=>inspect("!document.querySelector('#cv-reject').disabled"),'manual set-aside review');
 assert.deepEqual(await inspect('processed'),[]);assert.equal(Object.keys(aside).length,2);
 assert.match(await inspect("document.querySelector('#cv-position').textContent"),/Set aside/);
 await click('cv-back');await until(()=>inspect("document.querySelector('#cv-review-panel').hidden"),'leave manual review');
 locals['1'][0].processed=true;await click('cv-aside');await inspect('window.hold=true;window.opened=[]');
 await click('cv-list-all');await click('cv-list-apply');await until(()=>Object.keys(aside).length===0,'restore saved list');
 await until(()=>inspect("document.querySelector('#cv-selected').textContent==='2 selected'"),'restored choices available');
 assert.deepEqual(await inspect('processed'),[],'Restoring does not launch processing');
 assert.equal(queue.items.length,1,'Restoring does not enqueue');
 await click('cv-list-close');await click('cv-review');await until(()=>inspect('!!window.release'),'restored clip loading');
 // Navigation and Back both stay responsive during slow loading; old results are ignored.
 await click('cv-next');await click('cv-back');assert.equal(await inspect('window.reviewVisible'),false);
 await inspect('window.hold=false;window.release();delete window.release');await pause(200);
 assert.equal(await inspect('window.reviewVisible'),false,'Late response cannot reopen review');
 assert.equal(await inspect('opened.length'),1,'Dismissed successor must not open');
 assert.deepEqual(await inspect('processed'),[]);
 await click('cv-resume');await until(()=>inspect("!document.querySelector('#cv-approve').disabled"),'review works after dismissed load');
 await click('cv-set-aside');await until(()=>Object.keys(aside).length===1,'set aside current');
 await until(()=>inspect("document.querySelector('#cv-position').textContent.startsWith('Clip 1 / 2')&&!document.querySelector('#cv-approve').disabled"),'advance without removed current');
 if(process.env.S3F_TEST_SCREENSHOTS){fs.mkdirSync(process.env.S3F_TEST_SCREENSHOTS,{recursive:true});await click('cv-edit-review');fs.writeFileSync(path.join(process.env.S3F_TEST_SCREENSHOTS,'review-list.png'),Buffer.from((await call('Page.captureScreenshot')).data,'base64'));}
 assert.deepEqual(errors,[]);console.log('PASS: editing the queue before any video load, bulk set aside, saved categories, failed-save retention, reload persistence, restore without processing, editable slow loads, serial navigation and ignored late results.');
}finally{ws?.close();const exit=new Promise(resolve=>chrome.once('exit',resolve));chrome.kill('SIGTERM');await exit;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(temp,{recursive:true,force:true});}
