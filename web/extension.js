import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

app.registerExtension({
    name: "sam3d.funscript.preview",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "S3F_PreviewExport") return;
        const created = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            created?.apply(this, arguments);
            const frame = document.createElement("iframe");
            frame.style.cssText = "width:100%;height:100%;border:0;border-radius:8px;background:#111820";
            frame.title = "SAM3D motion preview";
            frame.allow = "fullscreen";
            this.addDOMWidget("motion_preview", "iframe", frame, {serialize:false, hideOnZoom:false, getMinHeight:()=>560});
            this.addWidget("button", "Open full motion editor", null, () => {
                if (this.properties.s3f_project) window.open(api.apiURL(`/sam3d_funscript/assets/viewer.html?project=${encodeURIComponent(this.properties.s3f_project)}`), "_blank", "noopener");
            });
            this.s3fFrame = frame;
            this.setSize([820, 720]);
        };
        function update(node, id) {
            if (!id) return;
            node.properties.s3f_project = id;
            if (node.s3fFrame) node.s3fFrame.src = api.apiURL(`/sam3d_funscript/assets/viewer.html?project=${encodeURIComponent(id)}`);
        }
        const executed = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (output) {executed?.apply(this,arguments);update(this,output?.s3f_project?.[0]);};
        const configured = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {configured?.apply(this,arguments);update(this,this.properties.s3f_project);};
    },
});
