import {app} from "../../scripts/app.js";
import {api} from "../../scripts/api.js";
import {connectedTools,toolKind} from "./workspace-graph.mjs";

const providers=new Map(),workspaces=new Set();let timer;
const alive=win=>{try{return win&&!win.closed&&win.location.origin===location.origin}catch{return false}};
const current=node=>app.graph?.getNodeById(node.id)===node;
const uuid=()=>[...crypto.getRandomValues(new Uint8Array(16))].map(value=>value.toString(16).padStart(2,"0")).join("");
const hostId=uuid();
export function registerWorkspaceTool(kind,provider){providers.set(kind,provider);}
function describe(anchor){
    const members=connectedTools(app.graph,anchor),unique=new Map();
    for(const node of members){
        const kind=toolKind(node),provider=providers.get(kind);if(!provider)continue;
        const descriptor=provider.describe(node);if(descriptor&&!unique.has(descriptor.key))unique.set(descriptor.key,{...descriptor,kind,node,provider});
    }
    const order={timeline:0,reference:1,motion:2};
    const pages=[...unique.values()].sort((a,b)=>order[a.kind]-order[b.kind]);
    for(const page of pages)if(pages.filter(other=>other.kind===page.kind).length>1)page.label+=` · ${page.node.id}`;
    return {members,pages};
}
async function flushWindow(win){
    if(!alive(win))return;
    if(win.s3fTimelineApply)await win.s3fTimelineApply();
    else if(win.s3fReferenceApply)await win.s3fReferenceApply();
    else await win.s3fFlush?.();
}
function attach(record){
    for(const item of record.win.s3fWorkspaceFrames?.()||[]){
        const descriptor=record.pages.find(page=>page.key===item.key);
        if(descriptor){descriptor.provider.attach?.(descriptor.node,item.window);record.bindings.set(item.key,{...descriptor,window:item.window});}
    }
}
function adopt(win,id){
    // The opener's JS state is lost on a page reload. Rebind only the exact
    // session that opened this workspace, never a reused node number.
    try{
        if(!alive(win)||win.opener!==window||new URL(win.location.href).searchParams.get('workspace')!==id)return null;
        const key=win.s3fWorkspaceIdentity?.();if(!key)return null;
        const anchor=(app.graph?._nodes||[]).find(node=>providers.get(toolKind(node))?.describe(node)?.key===key);
        if(!anchor){win.s3fWorkspaceDisconnected?.('Open the matching workflow in ComfyUI to reconnect. Your edits are kept.');return null;}
        const record={id,win,anchor,pages:[],bindings:new Map()};workspaces.add(record);return record;
    }catch{return null;}
}
async function configure(record,active){
    if(!alive(record.win)){workspaces.delete(record);return;}
    if(!record.win.s3fConfigureWorkspace)return;
    if(!current(record.anchor)){record.win.s3fWorkspaceDisconnected?.("This workflow is no longer active. Return to its ComfyUI workflow before applying changes.");return;}
    const {members,pages}=describe(record.anchor),keys=new Set(pages.map(page=>page.key));
    for(const [key,binding]of record.bindings)if(!keys.has(key)){
        await flushWindow(binding.window);binding.provider.detach?.(binding.node,binding.window);record.bindings.delete(key);
    }
    record.members=members;record.pages=pages;
    record.win.s3fConfigureWorkspace({connected:true,host:hostId,anchor:providers.get(toolKind(record.anchor))?.describe(record.anchor)?.key,active,pages:pages.map(({node,provider,...page})=>page)});
    record.active=null; // The initial request must not reset tab choice on every heartbeat.
    attach(record);record.win.s3fWorkspaceNotice("");
}
function update(record,active){
    record.pending=(record.pending||Promise.resolve()).then(()=>configure(record,active)).catch(error=>{
        if(alive(record.win))record.win.s3fWorkspaceNotice?.(error.message||String(error));
    });
    return record.pending;
}
export function refreshWorkspaces(){for(const record of workspaces)update(record);}
export function openWorkspace(node){
    const {members,pages}=describe(node),requested=providers.get(toolKind(node))?.describe(node)?.key;
    let record=[...workspaces].find(item=>alive(item.win)&&current(item.anchor)&&connectedTools(app.graph,item.anchor).some(member=>members.includes(member)));
    if(!record){
        const id=uuid(),win=window.open(api.apiURL(`/sam3d_funscript/assets/workspace.html?workspace=${id}`),`s3f-workspace-${id}`);
        if(!win)return null;
        record={id,win,anchor:node,members,pages,bindings:new Map(),active:requested};workspaces.add(record);
    }else{
        record.active=requested;
        update(record,requested).then(()=>{
            if(alive(record.win)&&current(record.anchor))record.win.s3fSelectWorkspacePage?.(requested);
        });
        record.win.focus();
    }
    return record.win;
}
app.registerExtension({
    name:"sam3d.funscript.workspace",
    setup(){
        window.addEventListener("message",event=>{
            if(event.origin!==location.origin||!["s3f-workspace-ready","s3f-workspace-frames"].includes(event.data?.type))return;
            let record=[...workspaces].find(item=>item.win===event.source&&item.id===event.data.workspace);
            if(record&&!current(record.anchor)){workspaces.delete(record);record=null;}
            record??=adopt(event.source,event.data.workspace);if(!record)return;
            if(event.data.type==="s3f-workspace-ready")update(record,record.active);else attach(record);
        });
        const queue=app.queuePrompt;
        app.queuePrompt=async function(...args){
            // Includes Motion Studio pages opened from a standalone Timeline,
            // which have no separate export node registered with the old bridge.
            for(const record of workspaces)if(alive(record.win)&&current(record.anchor)){
                await record.pending;
                for(const item of record.win.s3fWorkspaceFrames?.()||[])if(item.key.startsWith("motion:"))await item.window.s3fFlush?.();
            }
            return queue.apply(this,args);
        };
    },
    beforeRegisterNodeDef(type){
        const changed=type.prototype.onConnectionsChange;
        type.prototype.onConnectionsChange=function(){changed?.apply(this,arguments);clearTimeout(timer);timer=setTimeout(refreshWorkspaces,100);};
    },
});
