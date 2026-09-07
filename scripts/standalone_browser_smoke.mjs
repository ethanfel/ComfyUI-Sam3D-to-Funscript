// Compact-node lifecycle on an isolated ComfyUI, with real tabs and queue actions.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';

const base=process.argv[2],workflowFile=process.argv[3],output=path.resolve(process.argv[4]||'development/standalone-node/browser');
assert.ok(base&&workflowFile,'Pass an isolated server URL and three-anchor fixture workflow');fs.mkdirSync(output,{recursive:true});
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'s3f-standalone-chrome-'));
const chrome=spawn('/opt/google/chrome/chrome',['--headless','--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--disable-popup-blocking','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore'});
const pause=ms=>new Promise(r=>setTimeout(r,ms)),sockets=[],report={checks:[],errors:[]};
async function until(test,label){const end=Date.now()+45000;while(Date.now()<end){if(await test())return;await pause(100);}throw new Error('Timed out: '+label);}
async function attach(target){
    const ws=new WebSocket(target.webSocketDebuggerUrl);sockets.push(ws);await new Promise(r=>ws.addEventListener('open',r,{once:true}));
    let next=0;const pending=new Map();
    ws.addEventListener('message',event=>{const m=JSON.parse(event.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(m.error):p.resolve(m.result);}else if(m.method==='Runtime.exceptionThrown')report.errors.push(m.params.exceptionDetails);});
    const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
    const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
    await call('Runtime.enable');await call('Page.enable');return {call,evaluate};
}
try{
    let port;await until(()=>{try{port=fs.readFileSync(profile+'/DevToolsActivePort','utf8').split('\n')[0];return port;}catch{return false;}},'Chrome');
    const targets=()=>fetch(`http://127.0.0.1:${port}/json/list`).then(r=>r.json());
    const target=await(await fetch(`http://127.0.0.1:${port}/json/new?about:blank`,{method:'PUT'})).json();
    const main=await attach(target),workflow=JSON.parse(fs.readFileSync(workflowFile,'utf8'));
    const info=await(await fetch(base+'/object_info/S3F_StandaloneExport')).json();
    assert.deepEqual(info.S3F_StandaloneExport.output_name,['project_path','viewer_path']);
    assert.equal(info.S3F_StandaloneExport.output_node,true);
    await main.call('Emulation.setDeviceMetricsOverride',{width:1500,height:1080,deviceScaleFactor:1,mobile:false});
    async function app(){
        await until(()=>main.evaluate("!!document.querySelector('canvas')"),'Comfy canvas');
        await main.evaluate("(async()=>{window.s3fApp=(await import('/scripts/app.js')).app})()");
        await until(()=>main.evaluate('!!window.s3fApp?.graph'),'Comfy graph');
        await until(()=>main.evaluate("!!window.LiteGraph?.registered_node_types?.S3F_StandaloneExport"),'custom node registration');
        await until(()=>main.evaluate('!!window.s3fApp.positionConversion'),'Comfy extension setup');
        await until(()=>main.evaluate('window.s3fApp.graph._nodes.length>0'),'initial workflow restoration');
    }
    await main.call('Page.navigate',{url:base});await app();
    await main.evaluate(`window.s3fApp.loadGraphData(${JSON.stringify(workflow)})`);
    await until(()=>main.evaluate("window.s3fApp.graph.getNodeById(9)?.widgets?.some(w=>w.name==='Open Motion Studio in new tab')"),'compact node');
    assert.equal(await main.evaluate("document.querySelectorAll('iframe[title=\"SAM3D motion preview\"]').length"),0);
    const compact=await main.evaluate("(()=>{const n=window.s3fApp.graph.getNodeById(9);return {size:n.size,inputs:n.inputs.map(i=>i.name),frame:!!n.s3fFrame,session:n.properties.s3f_session}})()");
    assert.ok(compact.size[0]<=420&&compact.size[1]<300);assert.equal(compact.frame,false);
    assert.deepEqual(compact.inputs.filter(name=>/^project_\d+$/.test(name)),['project_0','project_1','project_2']);
    const endpoint=base+'/sam3d_funscript/editors/'+compact.session;
    async function open(){await main.evaluate("window.s3fApp.graph.getNodeById(9).widgets.find(w=>w.name==='Open Motion Studio in new tab').callback()");}
    await open();let tabTarget;
    await until(async()=>{tabTarget=(await targets()).find(t=>t.url.includes(compact.session));return tabTarget;},'dedicated tab');
    const tab=await attach(tabTarget);
    await until(()=>tab.evaluate("document.querySelector('#workflowWaiting')?.hidden===false&&document.querySelector('#status').textContent.includes('Waiting')"),'waiting for first run');
    let runs=0;
    async function queue(){
        console.log('Queue',++runs);
        fs.writeFileSync(output+`/queue-${runs}.json`,JSON.stringify(await main.evaluate('window.s3fApp.graphToPrompt()'),null,2));
        const old=await main.evaluate('window.s3fApp.graph.getNodeById(9).properties.s3f_project');
        await main.evaluate('window.s3fApp.queuePrompt(0,1)');
        console.log('Queue response',await main.evaluate('JSON.stringify(window.s3fApp.lastNodeErrors)'));
        await until(()=>main.evaluate(`!!window.s3fApp.graph.getNodeById(9).properties.s3f_project&&window.s3fApp.graph.getNodeById(9).properties.s3f_project!==${JSON.stringify(old??null)}`),'workflow output');
    }
    await queue();await until(()=>tab.evaluate("document.querySelectorAll('#tracks .track').length===2"),'first workflow in waiting tab');
    const first=(await(await fetch(endpoint)).json()).project;
    await tab.evaluate('window.standaloneMarker="same-tab"');await open();
    assert.equal(await tab.evaluate('window.standaloneMarker'),'same-tab');
    assert.equal((await targets()).filter(t=>t.url.includes(compact.session)).length,1);
    report.checks.push('Compact node has numbered inputs and path outputs, no iframe; its dedicated tab can wait for the first run and repeated Open focuses the same tab without reloading it');

    await tab.evaluate("document.querySelector('#selectMain').click();document.querySelector('#invert').click();document.querySelector('#lockMain').click()");
    await main.evaluate("(()=>{const n=window.s3fApp.graph.getNodeById(9);window.s3fApp.graph.getNodeById(3).connect(0,n,n.inputs.findIndex(i=>i.name==='project_2'))})()");
    await queue();await until(()=>tab.evaluate("document.querySelectorAll('#tracks .track').length===3"),'appended anchor');
    let state=await(await fetch(endpoint)).json();
    assert.equal(state.project.timeline.main.L0.locked,true);
    assert.deepEqual(state.project.scripts.L0.actions,first.scripts.L0.actions.map(a=>({...a,pos:100-a.pos})));
    const savedWorkflow=await main.evaluate('window.s3fApp.graph.serialize()');
    await main.evaluate('window.reloadMarker=true');await main.call('Page.reload',{ignoreCache:true});
    await until(()=>main.evaluate('!window.reloadMarker'),'new Comfy document');await app();
    await main.evaluate(`window.s3fApp.loadGraphData(${JSON.stringify(savedWorkflow)})`);
    assert.equal(await tab.evaluate('window.standaloneMarker'),'same-tab');
    // The reloaded workflow has no tab handle. Delay the editor save beyond the
    // peer-discovery interval: Run must await its acknowledgement before export.
    await tab.evaluate(`(()=>{const original=window.fetch;window.fetch=async function(url,options){if(options?.method==='POST'&&String(url).includes('/editors/'))await new Promise(r=>setTimeout(r,900));return original.apply(this,arguments);};document.querySelector('#lockMain').click();document.querySelector('#invert').click();document.querySelector('#lockMain').click();})()`);
    await queue();
    state=await(await fetch(endpoint)).json();assert.equal(state.project.timeline.main.L0.locked,true);
    assert.deepEqual(state.project.scripts.L0.actions,first.scripts.L0.actions);
    await until(()=>tab.evaluate("document.querySelector('#status').textContent.includes('Latest run loaded')"),'broadcast workflow refresh after Comfy reload');
    assert.equal(await tab.evaluate('window.standaloneMarker'),'same-tab');
    await open();assert.equal((await targets()).filter(t=>t.url.includes(compact.session)).length,1);
    assert.equal(await tab.evaluate('window.standaloneMarker'),'same-tab');
    report.checks.push('Immediate reruns flush edits and locks, append anchor projects and refresh the tab; after reloading ComfyUI, the message handshake waits for a delayed save and updates the existing tab without an opener handle');

    await main.evaluate("(()=>{const n=window.s3fApp.graph.getNodeById(9),clone=n.clone();window.s3fApp.graph.add(clone);window.s3fCloneId=clone.id;window.s3fApp.graph.getNodeById(1).connect(0,clone,clone.inputs.findIndex(i=>i.name==='project_0'));})()");
    await queue();const clone=await main.evaluate("(()=>{const n=window.s3fApp.graph.getNodeById(window.s3fCloneId);return {session:n.properties.s3f_session,id:n.properties.s3f_project}})()");
    assert.notEqual(clone.session,compact.session);
    await until(async()=>!!(await(await fetch(base+'/sam3d_funscript/editors/'+clone.session)).json()),'independent clone export');
    assert.equal((await(await fetch(endpoint)).json()).project.timeline.tracks.length,3);
    await main.evaluate('window.s3fApp.graph.remove(window.s3fApp.graph.getNodeById(window.s3fCloneId))');
    fs.writeFileSync(output+'/compact-node.png',Buffer.from((await main.call('Page.captureScreenshot')).data,'base64'));

    state=await(await fetch(endpoint)).json();
    const projectPath=path.resolve('development/output/sam3d_funscript',state.output,'project.json'),viewerPath=path.join(path.dirname(projectPath),'viewer.html');
    assert.equal(fs.existsSync(viewerPath),true);
    assert.deepEqual(JSON.parse(fs.readFileSync(projectPath,'utf8')).scripts,state.project.scripts);
    await tab.call('Page.navigate',{url:pathToFileURL(viewerPath).href});
    await until(()=>tab.evaluate("document.querySelectorAll('#tracks .track').length===3"),'generated standalone HTML');
    assert.equal(await tab.evaluate("document.querySelector('#lockMain').textContent"),'Unlock');
    assert.equal(await tab.evaluate('typeof window.s3fUpdate'),'undefined','Offline file does not pretend to receive workflow updates');
    report.checks.push('Copied nodes get independent sessions; output files contain saved scripts and a working self-contained viewer with locks');

    const embedded=structuredClone(savedWorkflow),node=embedded.nodes.find(n=>n.id===9);
    node.type='S3F_PreviewExport';node.properties={'Node name for S&R':'S3F_PreviewExport',s3f_project:state.output};node.size=[820,720];node.outputs=node.outputs.slice(0,1);
    await main.evaluate(`window.s3fApp.loadGraphData(${JSON.stringify(embedded)})`);
    await until(()=>main.evaluate("document.querySelector('iframe[title=\"SAM3D motion preview\"]')?.contentDocument?.querySelectorAll('#tracks .track').length===3"),'existing embedded preview');
    assert.equal(await main.evaluate("window.s3fApp.graph.getNodeById(9).widgets.some(w=>w.name==='Open full motion editor')"),true);
    report.checks.push('Existing preview node still embeds Motion Studio and retains its full-editor button');
    assert.deepEqual(report.errors,[]);fs.writeFileSync(output+'/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{sockets.forEach(ws=>ws.close());chrome.kill('SIGTERM');}
