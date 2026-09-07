import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { migrateVideoInputs, migrateAnchorOverrides } from "./migrate.mjs";
import { EDITOR_NODES, migrateProjectInputs, syncProjectInputs } from "./projects.mjs";
import { notifyEditorRun, prepareEditorSessions } from "./editor-bridge.mjs";
import { editorOwner, sessionId, prepareNodeSessions } from "./sessions.mjs";

let generalAnchors, detailedAnchors;
const editorWindows = new Map();
function editorURL(node) {
    const params=new URLSearchParams({session:sessionId(node)});
    const project=editorOwner(node).properties.s3f_project;
    if(project)params.set("project",project);
    return api.apiURL(`/sam3d_funscript/assets/viewer.html?${params}`);
}
function matchingEditor(win, session) {
    try{return win&&!win.closed&&win.location.origin===location.origin&&new URL(win.location.href).searchParams.get("session")===session;}
    catch{return false;} // A user may navigate a previously opened tab elsewhere.
}
function openEditor(node) {
    const session=sessionId(node);
    let win=editorWindows.get(session);
    if(!win||win.closed)win=window.open("",`s3f-motion-${session}`);
    if(!win)return;
    editorWindows.set(session,win);
    if(matchingEditor(win,session)&&win.s3fUpdate)win.s3fUpdate(editorOwner(node).properties.s3f_project).catch(console.error);
    else win.location.href=editorURL(node);
    win.focus();
}

app.registerExtension({
    name: "sam3d.funscript.preview",
    setup() {
        const queue = app.queuePrompt;
        app.queuePrompt = async function (...args) {
            // Flush both open editor views before the workflow and its session ID
            // are serialized. Backend exports then see the acknowledged locks.
            const windows = [];
            const used = prepareNodeSessions(app.graph._nodes || []);
            for (const node of app.graph._nodes || []) if (node.s3fEditorNode) {
                if(node.s3fFrame)windows.push(node.s3fFrame.contentWindow);
            }
            for(const [session,win] of editorWindows){
                if(!matchingEditor(win,session)){editorWindows.delete(session);continue;}
                if(used.has(session))windows.push(win);
            }
            await Promise.all([prepareEditorSessions(used),...windows.map(win=>win?.s3fFlush?.())]);
            return queue.apply(this, args);
        };
    },
    beforeConfigureGraph(graphData) {
        migrateVideoInputs(graphData);
        migrateAnchorOverrides(graphData, generalAnchors, detailedAnchors);
        migrateProjectInputs(graphData);
    },
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name === "S3F_BuildMotion") generalAnchors = nodeData.input.required.target_anchor[0];
        if (nodeData.name === "S3F_AnchorOverride") detailedAnchors = nodeData.input.required.anchor[0];
        if (!EDITOR_NODES.includes(nodeData.name)) return;
        const embedded=nodeData.name==="S3F_PreviewExport";
        const created = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            created?.apply(this, arguments);
            this.s3fEditorNode=true;
            sessionId(this);
            syncProjectInputs(this);
            if(embedded){
                const frame = document.createElement("iframe");
                frame.style.cssText = "width:100%;height:100%;border:0;border-radius:8px;background:#111820";
                frame.title = "SAM3D motion preview";
                frame.allow = "fullscreen";
                this.addDOMWidget("motion_preview", "iframe", frame, {serialize:false, hideOnZoom:false, getMinHeight:()=>560});
                this.s3fFrame = frame;
            }
            this.addWidget("button", embedded?"Open full motion editor":"Open Motion Studio in new tab", null, () => openEditor(this));
            this.setSize(embedded?[820,720]:[360,150]);
        };
        async function update(node, id) {
            if(id)node.properties.s3f_project=id;
            id=editorOwner(node).properties.s3f_project;
            if(!id)return;
            if (node.s3fFrame) {
                const win=node.s3fFrame.contentWindow;
                if(win?.s3fUpdate && new URL(node.s3fFrame.src).searchParams.get("session")===sessionId(node)) win.s3fUpdate(id).catch(console.error);
                else {await win?.s3fFlush?.();node.s3fFrame.src=editorURL(node);}
            }
            const win=editorWindows.get(sessionId(node));
            if(matchingEditor(win,sessionId(node)))win.s3fUpdate?.(id).catch(console.error);
            notifyEditorRun(sessionId(node),id);
        }
        const executed = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (output) {executed?.apply(this,arguments);update(this,output?.s3f_project?.[0]).catch(console.error);};
        const configured = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {configured?.apply(this,arguments);syncProjectInputs(this);queueMicrotask(()=>{prepareNodeSessions(app.graph?._nodes||[]);update(this,this.properties.s3f_project).catch(console.error);});};
        const connections = nodeType.prototype.onConnectionsChange;
        nodeType.prototype.onConnectionsChange = function (type) {
            connections?.apply(this, arguments);
            if (type === 1) syncProjectInputs(this);
            queueMicrotask(()=>{
                prepareNodeSessions(app.graph?._nodes||[]);
                for(const node of app.graph?._nodes||[])if(node.s3fEditorNode)update(node).catch(console.error);
            });
        };
    },
});
