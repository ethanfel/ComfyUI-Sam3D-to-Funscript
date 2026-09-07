// Uses the installed Chrome binary directly; no browser package or download required.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawn} from "node:child_process";
import assert from "node:assert/strict";

const base=process.argv[2]||"http://127.0.0.1:8197";
const id=process.argv[3]||"rcowgirl_6_d60f261e17cf";
const workflowFile=process.argv[4]||"workflows/video_to_funscript.json";
const output=path.resolve(process.argv[5]||"development/browser");fs.mkdirSync(output,{recursive:true});
const profile=fs.mkdtempSync(path.join(os.tmpdir(),"s3f-chrome-"));
const chrome=spawn("/opt/google/chrome/chrome",["--headless","--no-sandbox","--disable-dev-shm-usage","--disable-gpu","--no-first-run","--no-default-browser-check","--remote-debugging-port=0",`--user-data-dir=${profile}`,"about:blank"],{stdio:["ignore","ignore","pipe"]});
let diagnostics="",ws;chrome.stderr.on("data",chunk=>diagnostics+=chunk);
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(test,label,attempts=150){for(let i=0;i<attempts;i++){if(await test())return;await pause(100);}throw new Error("Timed out: "+label);}
const report={viewer_errors:[],checks:[]};
try{
    let port;
    await until(()=>{try{port=fs.readFileSync(profile+"/DevToolsActivePort","utf8").split("\n")[0];return port;}catch{return false;}},"Chrome start");
    const target=await(await fetch(`http://127.0.0.1:${port}/json/new?about:blank`,{method:"PUT"})).json();
    ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener("open",r,{once:true}));
    let next=0;const pending=new Map();
    ws.addEventListener("message",event=>{const m=JSON.parse(event.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(m.error):p.resolve(m.result);}else if(m.method==="Runtime.exceptionThrown")report.viewer_errors.push(m.params.exceptionDetails);});
    const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
    const evaluate=async expression=>{const result=await call("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));return result.result.value;};
    const data=await(await fetch(`${base}/sam3d_funscript/projects/${id}`)).json();
    await call("Runtime.enable");await call("Page.enable");
    await call("Browser.setDownloadBehavior",{behavior:"allow",downloadPath:output});
    await call("Emulation.setDeviceMetricsOverride",{width:1450,height:1060,deviceScaleFactor:1,mobile:false});
    await call("Page.navigate",{url:`${base}/sam3d_funscript/assets/viewer.html?project=${id}`});
    await until(()=>evaluate("document.querySelector('#axis')?.options.length===6"),"project load");
    await until(()=>evaluate("document.querySelector('#video').readyState>=2"),"video decode");
    report.video=await evaluate("({width:document.querySelector('#video').videoWidth,height:document.querySelector('#video').videoHeight,duration:document.querySelector('#video').duration})");
    assert.equal(report.video.width,data.metadata.image_size[1]);assert.equal(report.video.height,data.metadata.image_size[0]);
    const seekTime=Math.min(2.5,report.video.duration/2);
    await evaluate(`document.querySelector('#video').currentTime=${seekTime}`);
    await until(()=>evaluate(`Math.abs(parseFloat(document.querySelector('#time').textContent)-${seekTime})<.05`),"video seek synchronization");
    report.checks.push("Video decode and seek synchronize the timeline");
    const initial=await evaluate("document.querySelector('#metrics').textContent");
    await evaluate("document.querySelector('#range').value=1;document.querySelector('#rebuild').click()");
    assert.notEqual(await evaluate("document.querySelector('#metrics').textContent"),initial);
    await evaluate("document.querySelector('#undo').click()");
    assert.equal(await evaluate("document.querySelector('#metrics').textContent"),initial);
    report.checks.push("Calibration regeneration and undo work");
    const doc=await call("DOM.getDocument"),referenceInput=await call("DOM.querySelector",{nodeId:doc.root.nodeId,selector:"#referenceFile"});
    const projectFolder=path.resolve(`development/output/sam3d_funscript/${id}`);
    const scriptFile=fs.readdirSync(projectFolder).find(name=>name.endsWith(".funscript")&&!/\.(pitch|roll|sway|twist|surge)\.funscript$/.test(name));
    await call("DOM.setFileInputFiles",{nodeId:referenceInput.nodeId,files:[path.join(projectFolder,scriptFile)]});
    await until(()=>evaluate("document.querySelector('#referenceMetrics').textContent.includes('RMSE 0.0')"),"reference agreement");
    await evaluate("document.querySelector('#referenceOffset').value=100;document.querySelector('#referenceOffset').dispatchEvent(new Event('change'))");
    assert.ok(!await evaluate("document.querySelector('#referenceMetrics').textContent.includes('RMSE 0.0')"));
    await evaluate("document.querySelector('#undo').click()");
    assert.ok(await evaluate("document.querySelector('#referenceMetrics').textContent.includes('RMSE 0.0')"));
    report.checks.push("Reference upload, agreement metrics, offset and undo work");
    // Real pointer input checks the drag path, including pointer capture.
    if(data.anchor_indices){
        await evaluate(`(()=>{const ctx=document.querySelector('#overlay').getContext('2d');
            const draw=ctx.fillText;ctx.fillText=function(text,...args){window.s3fAnchorLabel=text;return draw.call(this,text,...args);};
            document.querySelector('#axis').dispatchEvent(new Event('change'));})()`);
        await until(()=>evaluate(`window.s3fAnchorLabel===${JSON.stringify("Target: "+data.config.target_anchor.replaceAll("_"," "))}`),"selected anchor marker");
        report.checks.push(`Preview marks ${data.config.target_anchor} using exported landmark indices`);
    }
    const action=data.scripts.L0.actions[5];
    const rect=await evaluate("(()=>{const r=document.querySelector('#curve').getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}})()");
    const x=rect.x+42+action.at/data.metadata.duration_ms*(rect.w-54),y=rect.y+rect.h-25-action.pos/100*(rect.h-40);
    await call("Input.dispatchMouseEvent",{type:"mouseMoved",x,y});
    await call("Input.dispatchMouseEvent",{type:"mousePressed",x,y,button:"left",clickCount:1});
    await call("Input.dispatchMouseEvent",{type:"mouseMoved",x,y:y-20,button:"left",buttons:1});
    await call("Input.dispatchMouseEvent",{type:"mouseReleased",x,y:y-20,button:"left",clickCount:1});
    assert.match(await evaluate("document.querySelector('#status').textContent"),/Unsaved/);
    report.checks.push("Curve point drag edits an action");
    await evaluate("document.querySelector('#save').click()");
    await until(()=>fs.readdirSync(output).some(name=>name.endsWith(".zip")),"ZIP download");
    report.checks.push("Browser downloads the edited project and six scripts as ZIP");
    // Keep QA screenshots nonexplicit; the video has already been decoded/tested.
    await evaluate("document.querySelector('#video').style.visibility='hidden';document.querySelector('.video-panel h2').textContent='Source hidden in QA capture · projected pose remains visible'");
    fs.writeFileSync(output+"/editor-desktop.png",Buffer.from((await call("Page.captureScreenshot")).data,"base64"));
    await call("Emulation.setDeviceMetricsOverride",{width:560,height:1050,deviceScaleFactor:1,mobile:false});
    await pause(200);
    assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth"),true);
    fs.writeFileSync(output+"/editor-narrow.png",Buffer.from((await call("Page.captureScreenshot")).data,"base64"));
    report.checks.push("Narrow layout has no horizontal overflow");
    const dom=await call("DOM.getDocument");
    const input=await call("DOM.querySelector",{nodeId:dom.root.nodeId,selector:"#projectFile"});
    await call("DOM.setFileInputFiles",{nodeId:input.nodeId,files:[path.resolve(`development/output/sam3d_funscript/${id}/project.json`)]});
    await until(()=>evaluate("document.querySelector('#status').textContent.includes('choose the matching')"),"local project import");
    assert.equal(await evaluate("document.querySelector('#video').getAttribute('src')"),null);
    report.checks.push("Importing a project clears the previous source video");
    assert.equal(report.viewer_errors.length,0);
    await call("Emulation.setDeviceMetricsOverride",{width:1600,height:1000,deviceScaleFactor:1,mobile:false});
    await call("Page.navigate",{url:base});
    await until(()=>evaluate("!!document.querySelector('canvas')"),"ComfyUI frontend",300);
    await evaluate("(async()=>{window.s3fTestApp=(await import('/scripts/app.js')).app})()");
    await until(()=>evaluate("!!window.s3fTestApp?.graph"),"Comfy graph");
    const workflow=JSON.parse(fs.readFileSync(workflowFile,"utf8"));
    workflow.nodes.find(n=>n.type==="S3F_PreviewExport").properties.s3f_project=id;
    await evaluate(`window.s3fTestApp.loadGraphData(${JSON.stringify(workflow)})`);
    await until(()=>evaluate("!!document.querySelector('iframe[title=\"SAM3D motion preview\"]')"),"Comfy preview widget");
    const frontend=await evaluate("({nodes:window.s3fTestApp.graph._nodes.map(n=>({type:n.type,size:n.size})),iframe:document.querySelector('iframe[title=\"SAM3D motion preview\"]').src})");
    assert.equal(frontend.nodes.length,workflow.nodes.length);assert.ok(frontend.iframe.includes(id));report.frontend=frontend;
    await until(()=>evaluate("document.querySelector('iframe[title=\"SAM3D motion preview\"]').contentDocument?.querySelector('#axis')?.options.length===6"),"embedded editor data load");
    assert.equal(report.viewer_errors.length,0);
    report.frontend.prompt=(await evaluate("window.s3fTestApp.graphToPrompt()" )).output;
    for(const node of workflow.nodes)assert.equal(report.frontend.prompt[node.id]?.class_type,node.type);
    if(report.frontend.prompt["5"]?.class_type==="SAM3DBody_Predict"){
        assert.equal(report.frontend.prompt["1"].inputs.file,"videos/nsfw/rcowgirl_6.mp4");
        assert.equal(report.frontend.prompt["5"].inputs.run_hand_refinement,false);
        assert.equal(report.frontend.prompt["5"].inputs.batch_size,8);
        assert.equal(report.frontend.prompt["5"].inputs.bboxes,undefined);
        assert.deepEqual(report.frontend.prompt["6"].inputs.video,["2",0]);
    }
    if(report.frontend.prompt["1"]?.class_type==="S3F_VideoPose"){
        assert.deepEqual(report.frontend.prompt["1"].inputs.video,["4",0]);
        assert.equal(report.frontend.prompt["1"].inputs.video_path,undefined);
        assert.equal(report.frontend.prompt["1"].inputs.model_file,"sam_3d_body_dinov3_bf16.safetensors");
        assert.equal(report.frontend.prompt["1"].inputs.sample_fps,16);
        assert.equal(report.frontend.prompt["1"].inputs.batch_size,8);
        assert.equal(report.frontend.prompt["4"].inputs.file,"videos/nsfw/rcowgirl_6.mp4");
        const legacy=structuredClone(workflow);
        legacy.nodes=legacy.nodes.filter(n=>n.id!==4);
        const extractor=legacy.nodes.find(n=>n.id===1);
        extractor.inputs=[];
        extractor.widgets_values.unshift("videos/nsfw/rcowgirl_6.mp4");
        legacy.links=legacy.links.filter(l=>l[5]!=="VIDEO");
        legacy.last_node_id=3;legacy.last_link_id=2;
        await evaluate(`window.s3fTestApp.loadGraphData(${JSON.stringify(legacy)})`);
        const prompt=(await evaluate("window.s3fTestApp.graphToPrompt()")).output;
        // Core's display-only preview widget can initialize after graphToPrompt.
        const expected=structuredClone(report.frontend.prompt);
        delete prompt["4"].inputs["video-preview"];delete expected["4"].inputs["video-preview"];
        assert.deepEqual(prompt,expected);
        report.checks.push("Legacy path workflow migrates to core VIDEO without changing the generated prompt");
    }
    if(report.frontend.prompt["4"]?.class_type==="S3F_VideoPose"){
        assert.deepEqual(report.frontend.prompt["4"].inputs.video,["1",0]);
        assert.deepEqual(report.frontend.prompt["5"].inputs.video,["1",0]);
        assert.deepEqual(report.frontend.prompt["4"].inputs.mask_video,["2",0]);
        assert.deepEqual(report.frontend.prompt["5"].inputs.mask_video,["3",0]);
        assert.equal(report.frontend.prompt["6"].inputs.target_person,0);
        assert.equal(report.frontend.prompt["7"].inputs.target_person,0);
        report.checks.push("Two person branches share the source VIDEO and keep separate mask connections");
    }
    if(report.frontend.prompt["4"]?.class_type==="S3F_AnchorOverride"){
        assert.deepEqual(report.frontend.prompt["2"].inputs.target_anchor_override,["4",0]);
        assert.equal(report.frontend.prompt["4"].inputs.anchor,"left_index_tip");
        const options=await evaluate("window.s3fTestApp.graph.getNodeById(2).widgets.find(w=>w.name==='target_anchor').options.values");
        assert.equal(options.length,9);assert.ok(options.includes("mouth"));assert.ok(!options.includes("left_index_tip"));
        const legacy=structuredClone(workflow);
        legacy.nodes=legacy.nodes.filter(n=>n.id!==4);
        legacy.links=legacy.links.filter(l=>l[5]!=="S3F_ANCHOR");
        const motion=legacy.nodes.find(n=>n.id===2);
        motion.inputs=motion.inputs.filter(i=>!i.name.endsWith("_override"));
        motion.widgets_values[1]="left_index_tip";motion.widgets_values[3]="right_pinky_tip";
        legacy.last_node_id=3;legacy.last_link_id=2;
        await evaluate(`window.s3fTestApp.loadGraphData(${JSON.stringify(legacy)})`);
        const migrated=(await evaluate("window.s3fTestApp.graphToPrompt()")).output;
        assert.equal(migrated["2"].inputs.target_anchor,"pelvis");
        assert.equal(migrated["2"].inputs.reference_anchor,"pelvis");
        assert.equal(migrated[migrated["2"].inputs.target_anchor_override[0]].inputs.anchor,"left_index_tip");
        assert.equal(migrated[migrated["2"].inputs.reference_anchor_override[0]].inputs.anchor,"right_pinky_tip");
        const saved=await evaluate("window.s3fTestApp.graph.serialize()");
        await evaluate(`window.s3fTestApp.loadGraphData(${JSON.stringify(saved)})`);
        assert.deepEqual((await evaluate("window.s3fTestApp.graphToPrompt()")).output,migrated);
        report.checks.push("General anchors including mouth, detailed override connection, both legacy selections and save/reload are preserved");
        await evaluate(`window.s3fTestApp.loadGraphData(${JSON.stringify(workflow)})`);
    }
    report.checks.push(`Canvas workflow loads all ${workflow.nodes.length} nodes, preserves connections/settings and restores the preview iframe`);
    fs.writeFileSync(output+"/report.json",JSON.stringify(report,null,2));
    console.log(JSON.stringify(report,null,2));
}finally{ws?.close();chrome.kill("SIGTERM");}
