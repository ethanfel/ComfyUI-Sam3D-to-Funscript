// Validate bundled workflows in an isolated ComfyUI. Optional cache path runs the cached example.
// Arguments after OUTPUT select UI files relative to workflows/, including diagnostic examples.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';

const base=process.argv[2],cache=process.argv[3],output=path.resolve(process.argv[4]||'development/workflows-browser');
assert.ok(base,'Pass an isolated ComfyUI URL');fs.mkdirSync(output,{recursive:true});
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'s3f-workflows-'));
const chrome=spawn('/opt/google/chrome/chrome',['--headless','--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore'});
const pause=ms=>new Promise(r=>setTimeout(r,ms)),report={workflows:[],checks:[],errors:[]};let ws;
async function until(test,label){const end=Date.now()+45000;while(Date.now()<end){if(await test())return;await pause(100);}throw new Error('Timed out: '+label);}
try{
    let port;await until(()=>{try{port=fs.readFileSync(profile+'/DevToolsActivePort','utf8').split('\n')[0];return port;}catch{return false;}},'Chrome');
    const target=await(await fetch(`http://127.0.0.1:${port}/json/new?about:blank`,{method:'PUT'})).json();
    ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));
    let next=0;const pending=new Map();
    ws.addEventListener('message',event=>{const m=JSON.parse(event.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(m.error):p.resolve(m.result);}else if(m.method==='Runtime.exceptionThrown')report.errors.push(m.params.exceptionDetails);});
    const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
    const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
    await call('Runtime.enable');await call('Page.enable');
    await call('Emulation.setDeviceMetricsOverride',{width:1500,height:1000,deviceScaleFactor:1,mobile:false});
    await call('Page.navigate',{url:base});
    await until(()=>evaluate("!!document.querySelector('canvas')"),'Comfy canvas');
    await evaluate("(async()=>{window.s3fApp=(await import('/scripts/app.js')).app})()");
    await until(()=>evaluate('!!window.s3fApp?.graph'),'Comfy graph');
    await until(()=>evaluate('!!window.LiteGraph?.registered_node_types?.S3F_StandaloneExport'),'custom node registration');
    await until(()=>evaluate('!!window.s3fApp.positionConversion'),'extension setup');
    await until(()=>evaluate('window.s3fApp.graph._nodes.length>0'),'initial restoration');
    const read=name=>JSON.parse(fs.readFileSync('workflows/'+name,'utf8'));
    const files=process.argv.slice(5);
    for(const file of (files.length?files:fs.readdirSync('workflows').filter(n=>n.endsWith('.json')&&!n.endsWith('.api.json'))).sort()){
        const workflow=read(file),api=read(file.replace('.json','.api.json'));
        await evaluate(`window.s3fApp.loadGraphData(${JSON.stringify(workflow)})`);
        const prompt=(await evaluate('window.s3fApp.graphToPrompt()')).output;
        for(const [id,spec] of Object.entries(api)){
            assert.equal(prompt[id]?.class_type,spec.class_type,file+' node '+id);
            for(const [key,value] of Object.entries(spec.inputs))assert.deepEqual(prompt[id].inputs[key],value,`${file} node ${id} input ${key}`);
        }
        const nodes=await evaluate(`window.s3fApp.graph._nodes.map(n=>({id:n.id,type:n.type,pos:Array.from(n.pos),size:Array.from(n.size),inputs:(n.inputs||[]).map(i=>({name:i.name,link:i.link})),session:n.properties.s3f_session,frame:n.s3fFrame?.src||null}))`);
        const owners=nodes.filter(n=>n.type==='S3F_StandaloneExport'),views=nodes.filter(n=>n.type==='S3F_PreviewExport');
        assert.equal(owners.length,views.length);assert.ok(owners.length>0);
        assert.equal(new Set(owners.map(n=>n.session)).size,owners.length,'Person branches keep independent sessions');
        for(const n of [...owners,...views])assert.equal(n.inputs[0].name,'editor_session');
        for(const view of views){
            const owner=nodes.find(n=>n.id==prompt[view.id].inputs.editor_session[0]);
            assert.equal(owner.type,'S3F_StandaloneExport');assert.ok(view.inputs[0].link!=null);
            assert.equal(owner.inputs[0].link,null);assert.ok(owner.size[0]<=420&&owner.size[1]<350);
        }
        // Use actual frontend sizes and include title bars when checking overlap.
        for(let a=0;a<nodes.length;a++)for(let b=a+1;b<nodes.length;b++){
            const x=nodes[a],y=nodes[b];
            const overlap=x.pos[0]<y.pos[0]+y.size[0]&&y.pos[0]<x.pos[0]+x.size[0]&&x.pos[1]-30<y.pos[1]+y.size[1]&&y.pos[1]-30<x.pos[1]+x.size[1];
            assert.equal(overlap,false,`${file}: nodes ${x.id} and ${y.id} overlap`);
        }
        const saved=await evaluate('window.s3fApp.graph.serialize()');
        await evaluate(`window.s3fApp.loadGraphData(${JSON.stringify(saved)})`);
        const reloaded=(await evaluate('window.s3fApp.graphToPrompt()')).output;
        for(const [id,spec] of Object.entries(api))for(const key of Object.keys(spec.inputs))assert.deepEqual(reloaded[id].inputs[key],prompt[id].inputs[key],`${file} reload ${id}.${key}`);
        report.workflows.push({file,nodes: nodes.length,owners:owners.map(n=>({id:n.id,size:n.size,inputs:n.inputs.map(i=>i.name)}))});
        console.log('PASS',file);
    }
    report.checks.push('All UI workflows match API companions, preserve connections after save/reload, and have no node overlap');
    // Exercise an old socket order and then add/remove a live numbered project connection.
    const old=read('multitrack_anchors.json'),owner=old.nodes.find(n=>n.type==='S3F_StandaloneExport');
    owner.inputs.push(owner.inputs.shift());
    for(const link of old.links)if(link[3]===owner.id)link[4]=owner.inputs.findIndex(i=>i.link===link[0]);
    await evaluate(`window.s3fApp.loadGraphData(${JSON.stringify(old)})`);
    assert.deepEqual(await evaluate(`window.s3fApp.graph.getNodeById(${owner.id}).inputs.map(i=>i.name)`),['editor_session','project_0','project_1','project_2','project_3','filename']);
    await evaluate(`(()=>{const owner=window.s3fApp.graph.getNodeById(${owner.id});window.s3fApp.graph.getNodeById(2).connect(0,owner,owner.inputs.findIndex(i=>i.name==='project_3'));})()`);
    let live=(await evaluate('window.s3fApp.graphToPrompt()')).output;
    assert.deepEqual(live[owner.id].inputs.project_3,['2',0]);
    await evaluate(`(()=>{const owner=window.s3fApp.graph.getNodeById(${owner.id});owner.disconnectInput(owner.inputs.findIndex(i=>i.name==='project_1'));})()`);
    live=(await evaluate('window.s3fApp.graphToPrompt()')).output;
    assert.deepEqual(live[owner.id].inputs.project_2,['4',0]);assert.deepEqual(live[owner.id].inputs.project_3,['2',0]);
    assert.equal(live[owner.id].inputs.project_1,undefined);
    report.checks.push('Legacy socket ordering migrates and dynamic project connections keep their destinations');
    if(cache){
        const cached=read('cached_pose_to_funscript.json');cached.nodes.find(n=>n.type==='S3F_LoadPoseCache').widgets_values[0]=cache;
        await evaluate(`window.s3fApp.loadGraphData(${JSON.stringify(cached)})`);
        await evaluate('window.s3fApp.queuePrompt(0,1)');
        await until(()=>evaluate("!!window.s3fApp.graph.getNodeById(3).properties.s3f_project&&!!window.s3fApp.graph.getNodeById(4).properties.s3f_project"),'cached workflow execution');
        const state=await evaluate('window.s3fApp.graph._nodes.filter(n=>n.s3fEditorNode).map(n=>({id:n.id,...n.properties}))');
        assert.equal(state[0].s3f_project,state[1].s3f_project);
        await until(()=>evaluate("document.querySelector('iframe[title=\"SAM3D motion preview\"]')?.contentDocument?.querySelector('#axis')?.options.length===6"),'linked editor load');
        assert.equal(await evaluate("new URL(document.querySelector('iframe').src).searchParams.get('session')"),state.find(n=>String(n.id)==='3').s3f_session);
        // Cached workflow has no upstream source thumbnails; hide the editor video for QA capture.
        await evaluate("(()=>{const a=window.s3fApp;a.canvas.ds.scale=.85;a.canvas.ds.offset=[-950,80];document.querySelector('iframe').contentDocument.querySelector('#video').style.visibility='hidden';a.canvas.setDirty(true,true);})()");
        await pause(300);fs.writeFileSync(output+'/linked-workflow.png',Buffer.from((await call('Page.captureScreenshot')).data,'base64'));
        report.checks.push('Cached workflow executes both nodes, reuses one export and displays the owner session in the linked preview');
    }
    assert.deepEqual(report.errors,[]);fs.writeFileSync(output+'/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{ws?.close();chrome.kill('SIGTERM');}
