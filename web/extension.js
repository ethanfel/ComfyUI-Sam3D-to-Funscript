import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { migrateVideoInputs, migrateAnchorOverrides } from "./migrate.mjs";
import { migrateProjectInputs, syncProjectInputs } from "./projects.mjs";

let generalAnchors, detailedAnchors;
const editorWindows = new Set();
const randomSession = () => crypto.randomUUID?.() || Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, "0")).join("");
function sessionId(node) {
    if (!node.properties.s3f_session) node.properties.s3f_session = randomSession();
    return node.properties.s3f_session;
}
function editorURL(node) {
    return api.apiURL(`/sam3d_funscript/assets/viewer.html?project=${encodeURIComponent(node.properties.s3f_project)}&session=${sessionId(node)}`);
}

app.registerExtension({
    name: "sam3d.funscript.preview",
    setup() {
        const queue = app.queuePrompt;
        app.queuePrompt = async function (...args) {
            // Flush both open editor views before the workflow and its session ID
            // are serialized. Backend exports then see the acknowledged locks.
            const windows = [...editorWindows];
            const used = new Set();
            for (const node of app.graph._nodes || []) if (node.s3fFrame) {
                if (used.has(sessionId(node))) node.properties.s3f_session = randomSession();
                used.add(sessionId(node)); windows.push(node.s3fFrame.contentWindow);
            }
            for (const win of windows) if (win && !win.closed) await win.s3fFlush?.();
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
        if (nodeData.name !== "S3F_PreviewExport") return;
        const created = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            created?.apply(this, arguments);
            syncProjectInputs(this);
            const frame = document.createElement("iframe");
            frame.style.cssText = "width:100%;height:100%;border:0;border-radius:8px;background:#111820";
            frame.title = "SAM3D motion preview";
            frame.allow = "fullscreen";
            this.addDOMWidget("motion_preview", "iframe", frame, {serialize:false, hideOnZoom:false, getMinHeight:()=>560});
            this.addWidget("button", "Open full motion editor", null, () => {
                if (this.properties.s3f_project) {const win=window.open(editorURL(this), "_blank");if(win)editorWindows.add(win);}
            });
            this.s3fFrame = frame;
            this.setSize([820, 720]);
        };
        function update(node, id) {
            if (!id) return;
            node.properties.s3f_project = id;
            if (node.s3fFrame) {
                const win=node.s3fFrame.contentWindow;
                if(win?.s3fUpdate && new URL(node.s3fFrame.src).searchParams.get("session")===sessionId(node)) win.s3fUpdate(id).catch(console.error);
                else node.s3fFrame.src=editorURL(node);
            }
            for(const win of editorWindows) if(!win.closed&&new URL(win.location.href).searchParams.get("session")===sessionId(node))win.s3fUpdate?.(id).catch(console.error);
        }
        const executed = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (output) {executed?.apply(this,arguments);update(this,output?.s3f_project?.[0]);};
        const configured = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {configured?.apply(this,arguments);syncProjectInputs(this);update(this,this.properties.s3f_project);};
        const connections = nodeType.prototype.onConnectionsChange;
        nodeType.prototype.onConnectionsChange = function (type) {
            connections?.apply(this, arguments);
            if (type === 1) syncProjectInputs(this);
        };
    },
});
