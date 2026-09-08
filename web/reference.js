import {openWorkspace,registerWorkspaceTool,refreshWorkspaces} from "./workspace.mjs";
import {app} from "../../scripts/app.js";
import {api} from "../../scripts/api.js";
import {errorMessage,queueReferenceTracking} from "./reference-queue.mjs";

const windows=new Map();
const tracking=new Set();
function sameOrigin(win){try{return !win.closed&&win.location.origin===location.origin}catch{return false}}
function url(node){return api.apiURL(`/sam3d_funscript/assets/reference.html?${new URLSearchParams({reference:node.properties.s3f_reference,node:String(node.id)})}`)}
function open(node){openWorkspace(node);}
registerWorkspaceTool("reference",{
    describe:node=>({key:`reference:${node.id}`,label:"Reference editor",url:node.properties.s3f_reference?url(node):null}),
    attach:(node,win)=>windows.set(node,win),
    detach:(node,win)=>{if(windows.get(node)===win)windows.delete(node)},
});
app.registerExtension({
    name:"sam3d.funscript.reference",
    setup(){
        window.addEventListener("message",async event=>{
            if(event.origin!==location.origin||!["s3f-reference-apply","s3f-reference-track"].includes(event.data?.type))return;
            const entry=[...windows].find(([n,w])=>w===event.source&&String(n.id)===String(event.data.node));if(!entry)return;
            const [node]=entry,message=event.data,isTrack=message.type==="s3f-reference-track";
            const reply=data=>{if(sameOrigin(event.source))event.source.postMessage({type:isTrack?"s3f-reference-tracking":"s3f-reference-applied",request:message.request,...data},location.origin)};
            const assertCurrent=()=>{if(app.graph.getNodeById(node.id)!==node||node.properties.s3f_reference!==message.reference)throw new Error("This node changed or a newer run replaced this reference. Load the new run before applying.")};
            try{
                assertCurrent();
                if(!isTrack){
                    const widget=node.widgets.find(w=>w.name==="reference_json");widget.value=JSON.stringify(message.config);widget.callback?.(widget.value);app.graph.change();node.setDirtyCanvas(true,true);reply({});return;
                }
                if(tracking.has(node))throw new Error("Reference tracking is already running for this node.");
                tracking.add(node);
                try{
                    reply({state:"preparing",text:"Preparing tracking job…"});
                    const prompt=await app.graphToPrompt();assertCurrent();
                    const output=await queueReferenceTracking(api,prompt,node.id,reply);
                    if(app.graph.getNodeById(node.id)!==node)throw new Error("Tracking finished, but the connected workflow changed. Reopen the reference node in its original workflow.");
                    node.properties.s3f_reference=output.s3f_reference[0];
                    node.s3fReferenceStatus.textContent=output.s3f_reference_status?.[0]||"Tracking complete";
                    reply({state:"complete",reference:node.properties.s3f_reference,text:node.s3fReferenceStatus.textContent});
                }finally{tracking.delete(node)}
            }catch(error){reply({state:"error",error:errorMessage(error)})}
        });
        const queue=app.queuePrompt;
        app.queuePrompt=async function(...args){
            for(const [node,win] of windows){
                if(win.closed||app.graph.getNodeById(node.id)!==node){windows.delete(node);continue}
                // Reference edits join normal graph serialization before queueing.
                if(sameOrigin(win))try{await win.s3fReferenceApply?.()}catch(error){throw new Error(errorMessage(error))}
            }
            return queue.apply(this,args);
        };
    },
    beforeRegisterNodeDef(type,data){
        if(data.name!=="S3F_ReferenceStabilize")return;
        const created=type.prototype.onNodeCreated;
        type.prototype.onNodeCreated=function(){
            created?.apply(this,arguments);this.properties||={};
            const status=document.createElement("div");status.style.cssText="font:12px system-ui;color:#a9d9c5;padding:8px;white-space:normal";status.textContent="Queue once to prepare the source, then open the reference editor.";
            this.s3fReferenceStatus=status;this.addDOMWidget("reference_status","text",status,{serialize:false,getMinHeight:()=>44});
            this.addWidget("button","Open reference editor",null,()=>open(this));this.setSize([390,340]);
        };
        const executed=type.prototype.onExecuted;
        type.prototype.onExecuted=function(output){executed?.apply(this,arguments);const id=output?.s3f_reference?.[0];if(!id)return;this.properties.s3f_reference=id;this.s3fReferenceStatus.textContent=output.s3f_reference_status?.[0]||"Reference ready";const win=windows.get(this);if(!tracking.has(this)&&win&&sameOrigin(win))win.s3fReferenceLoad?.(id).catch(console.error);refreshWorkspaces()};
    },
});
