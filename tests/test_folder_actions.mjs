// The real bridge must release its action lock after failed/aborted requests.
import assert from 'node:assert/strict';
import fs from 'node:fs';
const origin='http://localhost',folder='f'.repeat(32),replies=[],handlers=new Map(),jobs=new Map();
const node={id:9,type:'S3F_FolderTimeline',properties:{s3f_folder:folder,s3f_folder_entry:{id:'old'}},widgets:[{name:'folder_path',value:'/neutral'}],s3fTimelineStatus:{},setDirtyCanvas(){}};
const win={postMessage:value=>replies.push(value),s3fFolderCurrent(){}};
const app={graph:{getNodeById:()=>node,change(){}}};
let stalled=null,stallFlush=false,entered,posts=0,flushes=0;const calls=[];
const api={apiURL:path=>path,addEventListener(){},fetchApi:async(path,options)=>{
    calls.push({path,body:options.body&&JSON.parse(options.body)});
    assert.ok(options.signal,'Every bridge HTTP request needs a deadline');
    if(path.endsWith(stalled)){
        entered?.();
        await new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));
    }
    const value=path==='/queue'?{queue_running:[],queue_pending:[]}:
        path.includes('?clip=')?{entries:[{id:'old',processing:false}]}:{id:'new',name:'next.mp4'};
    if(options.method==='POST')posts++;
    return {ok:true,json:async()=>value};
}};
const deps={app,api,queueReferenceTracking(){},flushWorkspaceNode:async(owner,{signal})=>{flushes++;assert.ok(signal);if(stallFlush){entered?.();await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}},workspaceEditor(){},releaseWorkspaceNode(){},refreshWorkspaces:async()=>{},
    window:{addEventListener:(name,handler)=>handlers.set(name,handler)},location:{origin},AbortSignal:{timeout:()=>AbortSignal.timeout(50),any:signals=>AbortSignal.any(signals)}};
const source=fs.readFileSync(new URL('../web/folder.mjs',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace(/^export /gm,'');
const {attachFolder,setupFolder}=new Function(...Object.keys(deps),source+'\nreturn {attachFolder,setupFolder};')(...Object.values(deps));
setupFolder(jobs);attachFolder(node,win);
let sequence=0;
const send=(action,extra={})=>handlers.get('message')({origin,source:win,data:{type:'s3f-folder-action',folder,node:9,request:String(++sequence),action,clip:'new',...extra}});
// Native timeout timers are unref'd; keep this isolated test alive until abort.
const keepAlive=setInterval(()=>{},1000);
try{
    for(const path of ['/queue','?clip=old','/open']){
        node.properties.s3f_folder_entry={id:'old'};stalled=path;
        const ready=new Promise(resolve=>{entered=resolve}),pending=send('open');await ready;
        await send('open');assert.match(replies.at(-1).error,/Waiting for open/);
        const before=posts;await pending;assert.match(replies.at(-1).error,/timed out.*navigation is unlocked/);
        assert.equal(posts,before,'An uncertain request is never retried automatically');
        stalled=null;await send('open');assert.equal(replies.at(-1).result.id,'new','The next action can acquire the released lock');
    }
    jobs.set(node,{});const before=posts;await send('open');
    assert.match(replies.at(-1).error,/Timeline processing/);assert.equal(posts,before);
    jobs.delete(node);await send('open');assert.equal(replies.at(-1).result.id,'new');
    assert.ok(flushes>0,'Navigation still saves the current editors');
    jobs.set(node,{});const start=calls.length,saves=flushes,ids=['a'.repeat(32),'b'.repeat(32)];
    await send('review_audio_sync',{clip_ids:ids,audio_sync:true});
    assert.equal(replies.at(-1).error,undefined,'Metadata labels can change while processing');
    assert.equal(calls.length-start,1,'Bulk labels require one request');
    assert.equal(flushes,saves,'Metadata updates do not save or alter curves');
    assert.deepEqual(calls.at(-1).body.clip_ids,ids);assert.equal(calls.at(-1).body.audio_sync,true);
    jobs.delete(node);
    // Per-clip labels are independent of editor saves and cannot own the action lock.
    stallFlush=true;const metadataStart=calls.length,metadataFlushes=flushes;
    await send('review',{quality:4,note:'Review later',tags:['example'],intensity:3,intensity_mode:'manual'});
    assert.equal(replies.at(-1).error,undefined);assert.equal(flushes,metadataFlushes);
    assert.equal(calls.length-metadataStart,1);assert.equal(calls.at(-1).body.quality,4);
    assert.deepEqual(calls.at(-1).body.tags,['example']);assert.equal(calls.at(-1).body.note,'Review later');
    // Actual navigation still saves, but a stalled save has a deadline and unlocks.
    const flushReady=new Promise(resolve=>{entered=resolve}),waiting=send('open');await flushReady;
    const beforeTimeoutPosts=posts;await waiting;assert.match(replies.at(-1).error,/timed out/);
    assert.equal(posts,beforeTimeoutPosts,'A failed save must not open or approve a clip');
    stallFlush=false;await send('open');assert.equal(replies.at(-1).result.id,'new');
    // A slow metadata write cannot block a separately requested navigation.
    stalled='/review';const reviewReady=new Promise(resolve=>{entered=resolve}),reviewing=send('review',{quality:2});await reviewReady;
    await send('open');assert.equal(replies.at(-1).result.id,'new');
    await reviewing;assert.match(replies.at(-1).error,/timed out/);stalled=null;
}finally{clearInterval(keepAlive)}
console.log('Folder bridge: stalled queue/status/save requests unlock, concurrent actions and real processing stay guarded, retry saves edits, and review labels bypass editor/queue waits');
