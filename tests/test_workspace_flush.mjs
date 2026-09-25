// A ready editor can precede the asynchronous workspace-frames message.
import assert from 'node:assert/strict';
import fs from 'node:fs';

const origin='http://localhost',handlers=new Map(),extensions=[],bound=new Map(),saved=[];
const node={id:9},app={graph:{getNodeById:()=>node},registerExtension:extension=>extensions.push(extension)};
let frames=[],includeEditors=true,configures=0;
const workspace={closed:false,location:{origin},s3fWorkspaceFrames:()=>frames,s3fConfigureWorkspace(){configures++},s3fWorkspaceNotice(){}};
const deps={app,api:{apiURL:path=>path},connectedTools:()=>[node],toolKind:()=> 'folder',
    location:{origin},window:{open:()=>workspace,addEventListener:(name,handler)=>handlers.set(name,handler)}};
const source=fs.readFileSync(new URL('../web/workspace.mjs',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace(/^export /gm,'');
const {registerWorkspaceTool,openWorkspace,refreshWorkspaces,flushWorkspaceNode}=new Function(...Object.keys(deps),source+'\nreturn {registerWorkspaceTool,openWorkspace,refreshWorkspaces,flushWorkspaceNode};')(...Object.values(deps));
registerWorkspaceTool('folder',{
    describe:()=>({key:'folder:one'}),additional:()=>includeEditors?[{key:'timeline:one'},{key:'motion:one'}]:[],
    attach:(owner,win)=>{assert.equal(owner,node);bound.set(win.kind,win)},
});
for(const extension of extensions)extension.setup?.();
openWorkspace(node);await refreshWorkspaces();

function editor(kind,property){
    const win={kind,closed:false,location:{origin}};
    win[property]=async()=>{
        assert.equal(bound.get(kind),win,'Apply must have a connected recipient before being requested');
        saved.push(kind);
    };
    return {key:kind+':one',window:win};
}
// Editors became ready after configuration, but their attachment message has
// not arrived. Navigation must still save both before it leaves this clip.
frames=[editor('timeline','s3fTimelineApply'),editor('motion','s3fFlush')];
await flushWorkspaceNode(node);
assert.deepEqual(saved,['timeline','motion']);

// Replacing an iframe under the same session must not send Apply to its old window.
frames=[editor('timeline','s3fTimelineApply'),editor('motion','s3fFlush')];
await flushWorkspaceNode(node);
assert.deepEqual(saved,['timeline','motion','timeline','motion']);

// Attaching a frame does not weaken save failure protection.
frames[0].window.s3fTimelineApply=async()=>{throw Error('Save failed')};
await assert.rejects(flushWorkspaceNode(node),/Save failed/);
assert.equal(saved.length,4);
// A stalled editor save must time out without flushing the next editor later.
let finishLate;
const timeline=frames[0].window,motion=frames[1].window;
timeline.s3fTimelineApply=()=>new Promise(resolve=>{finishLate=resolve});
let lateMotion=0;motion.s3fFlush=async()=>{lateMotion++};
const keepAlive=setInterval(()=>{},1000);
try{
    await assert.rejects(flushWorkspaceNode(node,{signal:AbortSignal.timeout(25)}),error=>error.name==='TimeoutError');
    assert.equal(lateMotion,0);
    finishLate();await new Promise(resolve=>setTimeout(resolve,0));
    assert.equal(lateMotion,0,'The abandoned save must not resume into another editor');
    timeline.s3fTimelineApply=async()=>{};await flushWorkspaceNode(node);
    assert.equal(lateMotion,1,'Retry can save normally after the original request settles');
}finally{clearInterval(keepAlive)}
// Heartbeats coalesce instead of accumulating a queue behind one slow save.
let releaseConfigure;
timeline.s3fTimelineApply=()=>new Promise(resolve=>{releaseConfigure=resolve});
includeEditors=false;const configuredBefore=configures,firstRefresh=refreshWorkspaces();
await new Promise(resolve=>setTimeout(resolve,0));assert.ok(releaseConfigure);
const heartbeats=Array.from({length:6},()=>refreshWorkspaces());
releaseConfigure();await Promise.all([firstRefresh,...heartbeats]);
assert.equal(configures-configuredBefore,2,'One active configuration plus one follow-up handles all heartbeats');
console.log('Workspace flush: late and replaced editors are bound before Apply; failed saves block navigation and stalled saves have bounded recovery');
