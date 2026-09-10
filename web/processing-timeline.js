import {openWorkspace,registerWorkspaceTool,refreshWorkspaces} from "./workspace.mjs";
import {app} from "../../scripts/app.js";
import {api} from "../../scripts/api.js";
import {errorMessage,queueReferenceTracking} from "./reference-queue.mjs";
import {prepareEditorSessions,notifyEditorRun} from "./editor-bridge.mjs";
import {prepareNodeSessions} from "./sessions.mjs";
import {migrateCutSensitivity} from "./migrate.mjs";

const editors=new Map(),jobs=new Map();
const newSession=()=>Array.from(crypto.getRandomValues(new Uint8Array(16)),v=>v.toString(16).padStart(2,"0")).join("");
function alive(win){try{return win&&!win.closed&&win.location.origin===location.origin}catch{return false}}
function current(node){return app.graph.getNodeById(node.id)===node}
function prepareSessions(){
    const seen=new Set();
    for(const node of app.graph?._nodes||[]){
        if(node.type!=="S3F_ProcessingTimeline")continue;
        node.properties||={};
        if(!node.properties.s3f_timeline_session||seen.has(node.properties.s3f_timeline_session)){
            node.properties.s3f_timeline_session=newSession();
            node.properties.s3f_timeline_ready=false;
        }
        seen.add(node.properties.s3f_timeline_session);
    }
}
function open(node){prepareSessions();openWorkspace(node);}
registerWorkspaceTool("timeline",{
    describe:node=>({key:`timeline:${node.properties.s3f_timeline_session}`,label:"Timeline",url:node.properties.s3f_timeline_ready?api.apiURL(`/sam3d_funscript/assets/processing-timeline.html?${new URLSearchParams({session:node.properties.s3f_timeline_session,node:String(node.id)})}`):null}),
    attach:(node,win)=>editors.set(node,win),
    detach:(node,win)=>{if(editors.get(node)===win)editors.delete(node)},
});
app.registerExtension({
    name:"sam3d.funscript.processing-timeline",
    beforeConfigureGraph(graph){migrateCutSensitivity(graph);},
    setup(){
        window.addEventListener("message",async event=>{
            const message=event.data;
            if(event.origin!==location.origin||!["s3f-timeline-apply","s3f-timeline-process","s3f-timeline-cancel"].includes(message?.type))return;
            const entry=[...editors].find(([node,win])=>win===event.source&&String(node.id)===String(message.node));
            if(!entry)return;
            const [node,win]=entry,isApply=message.type==="s3f-timeline-apply";
            const reply=data=>{if(alive(win))win.postMessage({type:isApply?"s3f-timeline-applied":"s3f-timeline-progress",request:message.request,...data},location.origin)};
            const assertCurrent=()=>{if(!current(node)||node.properties.s3f_timeline_session!==message.session)throw new Error("This workflow or timeline session changed. Reopen the timeline from its node.")};
            const setPlan=()=>{
                const widget=node.widgets.find(w=>w.name==="plan_json");
                widget.value=JSON.stringify({revision:message.revision,plan:message.plan});
                widget.callback?.(widget.value);app.graph.change();node.setDirtyCanvas(true,true);
            };
            try{
                assertCurrent();
                if(isApply){setPlan();reply({});return}
                if(message.type==="s3f-timeline-cancel"){
                    const job=jobs.get(node);
                    if(!job?.prompt_id){reply({state:"error",error:"The job has not entered the queue yet."});return}
                    const response=await api.fetchApi(`/jobs/${encodeURIComponent(job.prompt_id)}/cancel`,{method:"POST"});
                    if(!response.ok)throw new Error(`Could not cancel this job (${response.status}). Use ComfyUI's queue controls.`);
                    job.reply({state:"running",text:"Cancellation requested · completed regions are kept"});return;
                }
                if(!["all","selected","unfinished","detect_cuts","stabilize","propagate_mask","extract_anchors"].includes(message.operation))throw new Error("Unknown timeline operation");
                const cutScan=message.operation==="detect_cuts";
                const trackOnly=["stabilize","propagate_mask"].includes(message.operation),targeted=trackOnly||message.operation==="extract_anchors",motionRun=!cutScan&&!trackOnly;
                if(targeted&&!message.plan.stabilization.some(r=>r.id===message.stabilization_id&&r.enabled!==false))throw new Error("Select an enabled stabilization region to track");
                if(cutScan&&!["normal","low","high"].includes(message.cut_sensitivity))throw new Error("Unknown cut sensitivity");
                if(jobs.has(node))throw new Error("This timeline is already processing.");
                const job={reply};jobs.set(node,job);
                try{
                    setPlan();reply({state:"queued",text:cutScan?"Preparing hard-cut scan…":trackOnly?"Preparing reference tracking…":"Preparing selected processing job…"});
                    const stateResponse=await api.fetchApi(`/sam3d_funscript/timelines/${message.session}`,{cache:"no-store"});
                    if(!stateResponse.ok)throw new Error("Could not read the saved timeline before processing.");
                    const state=await stateResponse.json();
                    const motionSessions=prepareNodeSessions(app.graph?._nodes||[]);
                    if(state.editor_session)motionSessions.add(state.editor_session);
                    if(motionRun)await prepareEditorSessions(motionSessions);
                    const prompt=await app.graphToPrompt();assertCurrent();
                    if(!prompt.output[String(node.id)])throw new Error("Enable the timeline node before processing.");
                    prompt.output[String(node.id)].inputs.operation=message.operation;
                    if(targeted)prompt.output[String(node.id)].inputs.plan_json=JSON.stringify({revision:message.revision,plan:message.plan,stabilization_ids:[message.stabilization_id]});
                    if(cutScan){
                        prompt.output[String(node.id)].inputs.cut_sensitivity=message.cut_sensitivity;
                        const widget=node.widgets.find(w=>w.name==="cut_sensitivity");if(widget)widget.value=message.cut_sensitivity;
                    }
                    const output=await queueReferenceTracking(api,prompt,node.id,data=>{
                        if(data.prompt_id)job.prompt_id=data.prompt_id;
                        if(data.value===undefined)reply(data);
                    },{nodeType:"S3F_ProcessingTimeline",resultKey:"s3f_timeline"});
                    assertCurrent();
                    node.s3fTimelineStatus.textContent=output.s3f_timeline_status?.[0]||"Timeline processing complete";
                    const latestResponse=await api.fetchApi(`/sam3d_funscript/timelines/${message.session}`,{cache:"no-store"});
                    if(latestResponse.ok&&motionRun){const latest=await latestResponse.json();if(latest.editor_session)notifyEditorRun(latest.editor_session,latest.project)}
                    reply({state:"complete",text:node.s3fTimelineStatus.textContent,project:output.s3f_timeline_project?.[0]});
                }finally{jobs.delete(node)}
            }catch(error){reply({state:"error",error:errorMessage(error)})}
        });
        api.addEventListener("s3f_timeline_progress",event=>{
            const data=event.detail;
            for(const [node,job] of jobs){
                if(node.properties.s3f_timeline_session!==data.session)continue;
                if(data.stage==="scene_cuts"){
                    job.reply({state:"running",text:`Scanning hard cuts · ${data.frames||0} frames · ${data.cuts||0} markers`,
                        value:Math.max(0,(data.position_ms||0)-(data.start_ms||0)),max:(data.end_ms||0)-(data.start_ms||0)});continue;
                }
                const done=data.completed_jobs??0,total=data.total_jobs??0;
                const text=[({stabilization:"Tracking reference",mask_decode:"Reading mask source",mask_propagation:"Propagating mask"})[data.stage]||data.stage||"Processing",data.region_name||data.region_id,total>1?`${done} / ${total} jobs`:null,data.frames?`${data.frames} frames`:null].filter(Boolean).join(" · ");
                job.reply({state:"running",text,value:data.total_frames?data.frames:done,max:data.total_frames||total});
            }
        });
        const queue=app.queuePrompt;
        app.queuePrompt=async function(...args){
            prepareSessions();
            for(const [node,win] of editors){
                if(!alive(win)||!current(node)){editors.delete(node);continue}
                try{await win.s3fTimelineApply?.()}catch(error){throw new Error(errorMessage(error))}
            }
            return queue.apply(this,args);
        };
    },
    beforeRegisterNodeDef(type,data){
        if(data.name!=="S3F_ProcessingTimeline")return;
        const created=type.prototype.onNodeCreated;
        type.prototype.onNodeCreated=function(){
            created?.apply(this,arguments);this.properties||={};this.properties.s3f_timeline_session||=newSession();
            const status=document.createElement("div");status.style.cssText="font:12px system-ui;color:#a9d9c5;padding:8px;white-space:normal";
            status.textContent="Run Prepare once, then open the processing timeline.";this.s3fTimelineStatus=status;
            this.addDOMWidget("timeline_status","text",status,{serialize:false,getMinHeight:()=>44});
            this.addWidget("button","Open processing timeline",null,()=>open(this));this.setSize([410,410]);
        };
        const executed=type.prototype.onExecuted;
        type.prototype.onExecuted=function(output){
            executed?.apply(this,arguments);const session=output?.s3f_timeline?.[0];if(!session)return;
            this.properties.s3f_timeline_session=session;this.properties.s3f_timeline_ready=true;
            this.s3fTimelineStatus.textContent=output.s3f_timeline_status?.[0]||"Timeline ready";
            const win=editors.get(this);if(alive(win)&&!jobs.has(this))win.s3fTimelineLoad?.().catch(console.error);refreshWorkspaces();
        };
        const configured=type.prototype.onConfigure;
        type.prototype.onConfigure=function(){configured?.apply(this,arguments);queueMicrotask(prepareSessions)};
        const added=type.prototype.onAdded;
        type.prototype.onAdded=function(){added?.apply(this,arguments);queueMicrotask(prepareSessions)};
    },
});
