import {AXES, SUFFIX, evaluate, rebuildAxis, roundEven, makeZip, validateReference, referenceAgreement, motionForAxis, autoFitAxis, bodyFrame, invertAxis} from "./curve.mjs";
import {initializeTimeline, sourceProject, newTrack, assignTrack, trackProject, editProject, mainPoseProject, timelineState, restoreTimeline, trackCoverage, fitSelectionTrack, applyTrack} from "./timeline.mjs";
import {DEVICE_INFO, drawDeviceWireframe} from "./device-previews/device-wireframes.mjs";

const $ = id => document.getElementById(id), video = $("video");
const COLORS = ["#75e2ba", "#dcadfa", "#78baf7", "#ffc07d"];
const EDGES = [[5,6],[5,7],[7,62],[6,8],[8,41],[5,9],[6,10],[9,10],[9,11],[11,13],[10,12],[12,14],[0,5],[0,6]];
const ANCHORS = {pelvis:[9,10],chest:[5,6],nose:[0],left_wrist:[62],right_wrist:[41]};
let project, history = [], currentMs = 0, dragging = null, bounds = [0, 1], videoURL;
let comparisonRevision=0, comparisonCache=null;
let orbit = {yaw: .2, pitch: -.1, zoom: 1};
const deviceOrbit = {yaw: .62, pitch: .27, zoom: 1};
// Capture the untouched offline document before project installation updates its UI.
let standaloneTemplate = document.getElementById("s3f-project") ? document.documentElement.outerHTML : null;
const status = message => { $("status").textContent = message; };
function record() { history.push(JSON.stringify({scripts:project.scripts, config:project.config,references:project.references,metrics:project.metrics,timeline:timelineState(project)})); if(history.length>40)history.shift(); $("undo").disabled=false; }
function dirty() { project.manual_edits = true; ++comparisonRevision; delete project.reference_comparison; status("Unsaved edits · download the project to keep them"); }
function install(data) {
    if (data.schema !== "sam3d-funscript/1" || !data.scripts || !data.times_ms?.length) throw new Error("Unsupported project file");
    video.pause(); video.removeAttribute("src"); video.load();
    if(videoURL){URL.revokeObjectURL(videoURL);videoURL=null;}
    initializeTimeline(data); project = data; history=[]; ++comparisonRevision; $("undo").disabled=true;
    $("device").value = Object.hasOwn(DEVICE_INFO, data.preview?.device) ? data.preview.device : "sr6";
    $("axis").replaceChildren(...Object.keys(data.scripts).map(axis => new Option(axis + " · " + ({L0:"stroke",L1:"surge",L2:"sway",R0:"twist",R1:"roll",R2:"pitch"}[axis]), axis)));
    $("name").textContent = data.metadata.source.path.split("/").at(-1);
    $("warnings").replaceChildren(...(data.warnings||[]).map(text=>{const li=document.createElement("li");li.textContent=text;return li;}));
    $("provenance").textContent = JSON.stringify({source:data.metadata.source,model:data.metadata.model,samples:data.times_ms.length,basis:data.metadata.basis,config:data.config},null,2);
    currentMs=data.times_ms[0]; buildTracks(); selectionControls(); controls(); render(); status("Project loaded · choose the matching source video");
}
function selected() { return editProject(project,$("axis").value); }
function commitSelected(data,axis,track) {
    if(track){track.settings=data.config.axis_settings[axis];track.script=data.scripts[axis];track.metrics=data.metrics?.[axis];}
}
function assembled() {return project.timeline.active==="main"&&project.timeline.main[$("axis").value].assembled;}
function controls() {
    const {data,axis,track}=selected(), s=data.config.axis_settings[axis];
    $("component").value=s.component; $("range").value=s.range; $("center").value=s.center; $("invert").checked=s.invert;
    $("unit").textContent=axis.startsWith("R")?"degrees":"metres";
    for(const id of ["component","range","center","rebuild","autoFit"])$(id).disabled=assembled();
    $("editing").textContent=track?`Editing ${track.name} · ${axis}. Source edits are independent; apply a selection to update main.`:
        assembled()?"Editing main · assembled sections. Drag points to adjust joins, or calibrate a source track and apply it again.":`Editing main · ${axis}`;
    for(const id of ["applySection","promoteTrack","selectTrack","fitSelection"])$(id).disabled=!track;
    if(track?.window)$("editing").textContent=`Editing ${track.name} · ${axis} · local origin within ${track.window.map(t=>(t/1000).toFixed(3)).join("–")} s. Apply a selection to update main.`;
    const ref=project.references?.[$("axis").value];$("referenceOffset").disabled=!ref;$("referenceOffset").value=ref?.offset_ms||0;
    document.querySelectorAll(".track").forEach(row=>row.classList.toggle("selected",row.dataset.track===project.timeline.active));
    $("selectMain").textContent=`Main · ${$("axis").value} · export`;
    const main=project.timeline.main[$("axis").value];
    $("mainDescription").textContent=main.assembled?`${main.regions.length} source sections · device preview and exports follow main`:"Device preview and exported scripts follow this track";
}
function selectLane(id) {
    if(!project)return;
    project.timeline.active=id;controls();render();
}
function selectionControls() {
    [$("selectionStart").value,$("selectionEnd").value]=project.timeline.selection.map(t=>(t/1000).toFixed(3));
}
function setSelection(start,end) {
    const duration=Math.floor(project.metadata.duration_ms);
    project.timeline.selection=[start,end].map(t=>Math.max(0,Math.min(duration,Math.round(t)))).sort((a,b)=>a-b);
    selectionControls();render();
}
function buildTracks() {
    $("tracks").replaceChildren();
    for(const track of project.timeline.tracks){
        const row=document.createElement("div");row.className="track";row.dataset.track=track.id;
        const head=document.createElement("div");head.className="track-head";
        const select=document.createElement("button");select.className="track-select";select.textContent="Edit";select.onclick=()=>selectLane(track.id);
        const name=document.createElement("input");name.type="text";name.className="track-name";name.value=track.name;name.setAttribute("aria-label","Track name");
        name.onchange=()=>{record();track.name=name.value.trim()||"Source track";dirty();controls();render();};
        const source=document.createElement("select");source.className="track-source";source.setAttribute("aria-label","Anchor project");
        source.replaceChildren(...project.timeline.sources.map(s=>new Option(s.label,s.id)));source.value=track.source;
        const axis=document.createElement("select");axis.className="track-axis";axis.setAttribute("aria-label","Source axis");
        const axes=()=>{axis.replaceChildren(...Object.keys(sourceProject(project,source.value).scripts).map(a=>new Option(a,a)));axis.value=track.axis;};axes();
        source.onchange=()=>{record();assignTrack(project,track,source.value,axis.value);project.timeline.active=track.id;buildTracks();dirty();controls();render();};
        axis.onchange=()=>{record();assignTrack(project,track,source.value,axis.value);project.timeline.active=track.id;buildTracks();dirty();controls();render();};
        const remove=document.createElement("button");remove.className="remove-track";remove.textContent="Remove";
        remove.onclick=()=>{record();project.timeline.tracks=project.timeline.tracks.filter(t=>t!==track);if(project.timeline.active===track.id)project.timeline.active="main";buildTracks();dirty();controls();render();};
        const sourceLabel=document.createElement("label");sourceLabel.append("Project ",source);
        const axisLabel=document.createElement("label");axisLabel.append("Axis ",axis);
        head.append(select,name,sourceLabel,axisLabel,remove);
        if(track.window){const scope=document.createElement("span");scope.className="track-scope";scope.textContent=`${track.window.map(t=>(t/1000).toFixed(3)).join("–")} s · local fit`;head.append(scope);}
        const canvas=document.createElement("canvas");canvas.tabIndex=0;canvas.dataset.track=track.id;canvas.setAttribute("aria-label",`${track.name} motion timeline`);
        row.append(head,canvas);$("tracks").append(row);bindCurve(canvas,track.id);
    }
}
function resize(canvas) {
    const rect=canvas.getBoundingClientRect(), dpr=devicePixelRatio||1;
    const w=Math.max(1,Math.round(rect.width*dpr)),h=Math.max(1,Math.round(rect.height*dpr));
    if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}
    const ctx=canvas.getContext("2d");ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,rect.width,rect.height);
    return [ctx,rect.width,rect.height];
}
function sampleIndex(data=project) {
    let low=0,high=data.times_ms.length-1;
    while(high-low>1){const mid=(low+high)>>1;if(data.times_ms[mid]<=currentMs)low=mid;else high=mid;}
    return Math.abs(data.times_ms[low]-currentMs)<Math.abs(data.times_ms[high]-currentMs)?low:high;
}
const finitePoint = point => point && point.every(Number.isFinite);
function line(ctx,a,b,color,width=2) {ctx.strokeStyle=color;ctx.lineWidth=width;ctx.beginPath();ctx.moveTo(...a);ctx.lineTo(...b);ctx.stroke();}
function drawOverlay(index, project) {
    const [ctx,w,h]=resize($("overlay"));
    const [ih,iw]=project.metadata.image_size;
    const scale=Math.min(w/iw,h/ih),ox=(w-iw*scale)/2,oy=(h-ih*scale)/2;
    (project.pixels?.[index]||[]).forEach((person,slot)=>{
        for(const [a,b] of EDGES) if(finitePoint(person[a])&&finitePoint(person[b])) line(ctx,[person[a][0]*scale+ox,person[a][1]*scale+oy],[person[b][0]*scale+ox,person[b][1]*scale+oy],COLORS[slot%COLORS.length]);
        const roi=project.metadata.mask_boxes?.[index]?.[slot]||project.metadata.rois?.[slot];
        if(roi){ctx.strokeStyle=COLORS[slot%COLORS.length];ctx.strokeRect(ox+roi[0]*iw*scale,oy+roi[1]*ih*scale,roi[2]*iw*scale,roi[3]*ih*scale);ctx.fillStyle=ctx.strokeStyle;ctx.fillText(`${project.metadata.mask_video?"Mask person":"ROI"} ${slot}`,ox+roi[0]*iw*scale+6,oy+roi[1]*ih*scale+15);}
    });
    const slot=project.config.target_person,joints=project.anchor_indices?.target||ANCHORS[project.config.target_anchor];
    const pointAt=i=>{const points=joints.map(j=>project.pixels?.[i]?.[slot]?.[j]);if(!points.every(finitePoint))return null;return [points.reduce((s,p)=>s+p[0],0)/points.length*scale+ox,points.reduce((s,p)=>s+p[1],0)/points.length*scale+oy];};
    let previous=null;
    for(let i=Math.max(0,index-40);i<=index;i++){
        if(project.times_ms[i]<currentMs-1000||!project.valid[i]){previous=null;continue;}
        if(i&&project.segments[i]!==project.segments[i-1])previous=null;
        const p=pointAt(i);if(p&&previous)line(ctx,previous,p,"#eabf71",2);previous=p;
    }
    const selected=pointAt(index);
    if(selected){
        ctx.strokeStyle="#fff";ctx.fillStyle="#eabf71";ctx.lineWidth=2;ctx.beginPath();ctx.arc(...selected,7,0,Math.PI*2);ctx.fill();ctx.stroke();
        ctx.font="bold 12px system-ui";
        const label=`Target: ${project.config.target_anchor.replaceAll("_"," ")}`;
        ctx.fillText(label,Math.max(4,Math.min(w-ctx.measureText(label).width-4,selected[0]+12)),Math.max(18,Math.min(h-12,selected[1]-12)));
    }
}
function project3(point,w,h,scale=1) {
    let [x,y,z]=point;
    const a=orbit.yaw,b=orbit.pitch;
    [x,z]=[x*Math.cos(a)+z*Math.sin(a),-x*Math.sin(a)+z*Math.cos(a)];
    [y,z]=[y*Math.cos(b)-z*Math.sin(b),y*Math.sin(b)+z*Math.cos(b)];
    return [w/2+x*scale,h/2-y*scale];
}
function drawSkeleton(index, project, axis) {
    const [ctx,w,h]=resize($("skeleton"));
    const people=project.points?.[index]||[], target=people[project.config.target_person];
    if(!target||!finitePoint(target[9])||!finitePoint(target[10]))return;
    const center=target[9].map((v,i)=>(v+target[10][i])/2);
    const map=point=>project3([point[0]-center[0],-(point[1]-center[1]),-(point[2]-center[2])],w,h,Math.min(w,h)*.6*orbit.zoom);
    people.forEach((person,slot)=>{for(const [a,b]of EDGES)if(finitePoint(person[a])&&finitePoint(person[b]))line(ctx,map(person[a]),map(person[b]),COLORS[slot%COLORS.length],3);});
    const selected=(project.anchor_indices?.target||ANCHORS[project.config.target_anchor]).map(j=>target[j]);
    if(selected.every(finitePoint)){
        const p=selected[0].map((_,i)=>selected.reduce((n,v)=>n+v[i],0)/selected.length);ctx.fillStyle="#eabf71";ctx.beginPath();ctx.arc(...map(p),6,0,Math.PI*2);ctx.fill();
        const report=motionForAxis(project,axis).spans.find(s=>index>=s.start&&index<s.end);
        if(report){
            const d=report.direction,relative=project.config.frame==="reference_body";
            let vector=[-d[2],d[0]*(relative?1:-1),d[1]];
            if(relative){const frame=bodyFrame(people[project.config.reference_person]);if(frame)vector=[0,1,2].map(i=>frame.reduce((sum,v,j)=>sum+v[i]*vector[j],0));}
            if(project.config.axis_settings[axis].invert)vector=vector.map(v=>-v);
            const a=map(p.map((v,i)=>v-vector[i]*.12)),b=map(p.map((v,i)=>v+vector[i]*.18));
            line(ctx,a,b,"#78baf7",3);const angle=Math.atan2(b[1]-a[1],b[0]-a[0]);
            for(const turn of [-.5,.5])line(ctx,b,[b[0]-10*Math.cos(angle+turn),b[1]-10*Math.sin(angle+turn)],"#78baf7",3);
            ctx.fillStyle="#78baf7";ctx.font="12px system-ui";ctx.fillText(`Auto ${axis}${axis.startsWith("R")?" rotation axis":" direction"}`,Math.max(4,Math.min(w-145,b[0]+8)),Math.max(14,Math.min(h-8,b[1]-8)));
        }
    }
    const origin=map(center);[[[.25,0,0],"#e89393"],[[0,-.25,0],"#8fd399"],[[0,0,-.25],"#8eb7f7"]].forEach(([p,c])=>line(ctx,origin,map(center.map((v,i)=>v+p[i])),c));
}
function drawRobot() {
    const [ctx,w,h]=resize($("robot"));
    const values=Object.fromEntries(AXES.map(a=>[a,evaluate(project.scripts[a]?.actions,currentMs)]));
    const device=$("device").value;
    const frame=drawDeviceWireframe(ctx,w,h,device,values,{...deviceOrbit,sleeve:$("deviceSleeve").checked});
    $("readouts").replaceChildren(...DEVICE_INFO[device].axes.map(a=>{const el=document.createElement("span");el.dataset.axis=a;el.textContent=`${a} ${values[a].toFixed(1)}${project.scripts[a]?"":" (off)"}`;return el;}));
    $("deviceReach").hidden=frame.reachable!==false;
    $("deviceReach").textContent=frame.reachable===false?"Outside schematic linkage reach · dashed coral rods":"";
}
function drawCurve(canvas, data, axis, isMain, active, window) {
    const [ctx,w,h]=resize(canvas), composed=isMain&&project.timeline.main[axis].assembled;
    const color=isMain?"#75e2ba":"#78baf7";
    const x=t=>42+(t-bounds[0])/(bounds[1]-bounds[0])*(w-54),y=p=>h-25-p/100*(h-40);
    ctx.font="11px system-ui";ctx.fillStyle="#8197ab";
    for(const p of [0,25,50,75,100]){line(ctx,[42,y(p)],[w-12,y(p)],"#2a3c4c",1);ctx.fillText(p,9,y(p)+4);}
    for(let i=0;i<=5;i++){const t=bounds[0]+(bounds[1]-bounds[0])*i/5;ctx.fillText((t/1000).toFixed(1)+"s",x(t)-12,h-6);}
    ctx.save();ctx.beginPath();ctx.rect(42,10,w-54,h-30);ctx.clip();
    if(window){
        ctx.fillStyle="#0c121977";ctx.fillRect(42,10,x(window[0])-42,h-30);ctx.fillRect(x(window[1]),10,w-12-x(window[1]),h-30);
        ctx.beginPath();ctx.rect(x(window[0]),10,x(window[1])-x(window[0]),h-30);ctx.clip();
    }
    for(let i=0;!composed&&i<data.times_ms.length;i++)if(!data.valid[i]||(i&&data.segments[i]!==data.segments[i-1])){
        ctx.fillStyle="#8c593b66";ctx.fillRect(x(data.times_ms[i]),15,Math.max(2,x(data.times_ms[i+1]||data.times_ms[i]+10)-x(data.times_ms[i])),h-40);
    }
    const s=data.config.axis_settings[axis],source=composed?{raw:[],processed:[],spans:[]}:motionForAxis(data,axis);
    for(const [key,color]of [["raw","#607689"],["processed","#bb9457"]]){
        ctx.strokeStyle=color;ctx.lineWidth=1;ctx.beginPath();let pen=false;
        source[key].forEach((value,i)=>{if(!data.valid[i]||!Number.isFinite(value)){pen=false;return;}const px=x(data.times_ms[i]),py=y(Math.max(0,Math.min(100,s.center+value/s.range*100*(s.invert?-1:1))));if(i&&data.segments[i]!==data.segments[i-1])pen=false;if(pen)ctx.lineTo(px,py);else ctx.moveTo(px,py);pen=true;});ctx.stroke();
    }
    const actions=data.scripts[axis].actions;
    ctx.save();ctx.beginPath();ctx.rect(42,10,w-54,h-30);ctx.clip();ctx.strokeStyle=color;ctx.lineWidth=2;ctx.beginPath();actions.forEach((a,i)=>i?ctx.lineTo(x(a.at),y(a.pos)):ctx.moveTo(x(a.at),y(a.pos)));ctx.stroke();
    ctx.fillStyle=color;for(const a of actions){if(a.at<bounds[0]||a.at>bounds[1])continue;ctx.beginPath();ctx.arc(x(a.at),y(a.pos),3,0,Math.PI*2);ctx.fill();}line(ctx,[x(currentMs),10],[x(currentMs),h-25],"#f0f5fa",1);ctx.restore();
    const ref=isMain?project.references?.[axis]:null;
    if(ref){
        const shift=ref.offset_ms||0,lo=Math.max(bounds[0],ref.actions[0].at+shift),hi=Math.min(bounds[1],ref.actions.at(-1).at+shift);
        if(hi>=lo){ctx.strokeStyle="#dcadfa";ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(x(lo),y(evaluate(ref.actions,lo-shift)));for(const a of ref.actions)if(a.at+shift>lo&&a.at+shift<hi)ctx.lineTo(x(a.at+shift),y(a.pos));ctx.lineTo(x(hi),y(evaluate(ref.actions,hi-shift)));ctx.stroke();}
        if(!comparisonCache||comparisonCache.axis!==axis||comparisonCache.revision!==comparisonRevision){comparisonCache={axis,revision:comparisonRevision,value:referenceAgreement(actions,ref,composed?0:data.times_ms[0],composed?project.metadata.duration_ms:data.times_ms.at(-1))};}
        const m=comparisonCache.value;
        $("referenceMetrics").textContent=m?`Reference agreement · MAE ${m.mae.toFixed(1)} / 100 · RMSE ${m.rmse.toFixed(1)} · correlation ${m.correlation===null?"undefined":m.correlation.toFixed(3)} · full overlap`:'Reference does not overlap this analysis';
    }else if(isMain) $("referenceMetrics").textContent="No reference loaded for this axis";
    const [selectionStart,selectionEnd]=project.timeline.selection;
    ctx.save();ctx.beginPath();ctx.rect(42,10,w-54,h-30);ctx.clip();
    if(selectionEnd>selectionStart){ctx.fillStyle="#78baf722";ctx.fillRect(x(selectionStart),10,x(selectionEnd)-x(selectionStart),h-35);for(const t of [selectionStart,selectionEnd])line(ctx,[x(t),10],[x(t),h-25],"#78baf7",1);}
    if(isMain){for(const region of project.timeline.main[axis].regions){
        ctx.fillStyle="#eabf7177";ctx.fillRect(x(region.start),10,x(region.end)-x(region.start),4);
        const left=Math.max(44,x(region.start)+4),right=Math.min(w-12,x(region.end));
        if(right-left>35){ctx.save();ctx.beginPath();ctx.rect(left,15,right-left,14);ctx.clip();ctx.fillStyle="#eabf71";ctx.fillText(region.name,left,24);ctx.restore();}
    }}
    ctx.restore();
    ctx.restore();
    if(!active)return;
    const mapped=source.processed.filter((v,i)=>data.valid[i]&&Number.isFinite(v)).map(v=>s.center+v/s.range*100*(s.invert?-1:1));
    const clipped=mapped.length?mapped.filter(v=>v<0||v>100).length/mapped.length*100:0;
    $("metrics").textContent=`${actions.length} actions · ${evaluate(actions,currentMs).toFixed(1)} / 100 · ${composed?"assembled main":`${clipped.toFixed(1)}% source clipping`}`;
    $("directionInfo").hidden=composed||s.component!=="auto";
    const direction=source.spans.find(span=>sampleIndex(data)>=span.start&&sampleIndex(data)<span.end);
    if(s.component==="auto")$("directionInfo").textContent=direction?`Auto ${axis} · ${["Up","Forward","Left"].map((name,i)=>`${name} ${direction.direction[i]>=0?"+":""}${direction.direction[i].toFixed(2)}`).join(" / ")} · ${(direction.share*100).toFixed(0)}% directional share${direction.mode==="still"?" · very little motion":direction.mode==="body_fallback"?` · mixed movement; ${direction.orientation} direction used`:""} · blue arrow in 3D view`:"Auto · no analysed direction at this time";
}
function render() {
    if(!project)return;
    $("time").textContent=(currentMs/1000).toFixed(3)+" s";
    const selectedContext=selected(), outputAxis=$("axis").value;
    const pose=selectedContext.track?selectedContext:project.timeline.main[outputAxis].assembled?mainPoseProject(project,outputAxis,currentMs):selectedContext;
    const data=pose.data,i=sampleIndex(data),available=data.valid[i]&&currentMs>=data.times_ms[0]&&currentMs<=data.metadata.duration_ms&&Math.abs(currentMs-data.times_ms[i])<=data.config.max_gap_ms;
    if(available){drawOverlay(i,data);drawSkeleton(i,data,pose.axis);}
    else for(const name of ["overlay","skeleton"]){const[ctx,w,h]=resize($(name));ctx.fillStyle="#eabf71";ctx.font="13px system-ui";ctx.fillText("No analysed pose at this time",12,h/2);}
    const duration=project.metadata.duration_ms,zoom=Number($("zoom").value);
    if(dragging===null){const span=Math.max(1,zoom?Math.min(zoom,duration):duration),left=Math.max(0,Math.min(duration-span,currentMs-span/2));bounds=[left,left+span];}
    drawRobot();
    const mainContext=editProject(project,outputAxis,"main");
    drawCurve($("curve"),mainContext.data,outputAxis,true,project.timeline.active==="main");
    const listRect=$("tracks").getBoundingClientRect();
    for(const track of project.timeline.tracks){
        const canvas=[...$("tracks").children].find(row=>row.dataset.track===track.id).querySelector("canvas"),rect=canvas.getBoundingClientRect();
        if(track.id===project.timeline.active||rect.bottom>=Math.max(0,listRect.top)&&rect.top<=Math.min(innerHeight,listRect.bottom))drawCurve(canvas,trackProject(project,track),track.axis,false,track.id===project.timeline.active,track.window);
    }
}
function frameCallback(_,metadata){currentMs=metadata.mediaTime*1000;render();video.requestVideoFrameCallback(frameCallback);}
if(video.requestVideoFrameCallback)video.requestVideoFrameCallback(frameCallback);
video.addEventListener("timeupdate",()=>{if(!video.requestVideoFrameCallback||video.paused){currentMs=video.currentTime*1000;render();}});
video.addEventListener("seeked",()=>{currentMs=video.currentTime*1000;render();});
video.addEventListener("error",()=>status("Choose the source video locally if this browser cannot load the server copy"));
$("axis").addEventListener("change",()=>{controls();render();});$("zoom").addEventListener("change",render);
$("invert").addEventListener("change",()=>{
    if(!project)return;
    const {data,axis,track}=selected();
    if($("invert").checked===data.config.axis_settings[axis].invert)return;
    const mirrored=invertAxis(data,axis),pendingCenter=$("center").valueAsNumber;
    record();data.config.axis_settings[axis]=mirrored.settings;data.scripts[axis]=mirrored.script;commitSelected(data,axis,track);
    if(!track)for(const region of project.timeline.main[axis].regions){region.settings={...region.settings,center:100-region.settings.center,invert:!region.settings.invert};}
    if(Number.isFinite(pendingCenter)&&pendingCenter>=0&&pendingCenter<=100)$("center").value=100-pendingCenter;
    dirty();render();
});
function regenerate(data,axis,track) {
    data.scripts[axis]=rebuildAxis(data,axis);
    const source=motionForAxis(data,axis),s=data.config.axis_settings[axis];
    const mapped=source.processed.filter(Number.isFinite).map(v=>s.center+v/s.range*100*(s.invert?-1:1));
    const raw=source.raw.filter(Number.isFinite);
    data.metrics??={};data.metrics[axis]={actions:data.scripts[axis].actions.length,
        clipped_fraction:mapped.filter(v=>v<0||v>100).length/mapped.length,
        raw_span:raw.reduce((m,v)=>Math.max(m,v),-Infinity)-raw.reduce((m,v)=>Math.min(m,v),Infinity),units:axis.startsWith("R")?"deg":"m"};
    if(s.component==="auto")data.metrics[axis].auto_direction=source.spans;
    commitSelected(data,axis,track);
}
$("rebuild").addEventListener("click",()=>{
    if(!project||assembled())return;const range=Number($("range").value),center=Number($("center").value);
    if(!Number.isFinite(range)||range<=0||!Number.isFinite(center)||center<0||center>100){status("Range must be positive; center must be between 0 and 100");return;}
    record();const {data,axis,track}=selected();data.config.axis_settings[axis]={range,center,invert:$("invert").checked,component:$("component").value==="auto"?"auto":Number($("component").value),auto_fit:false};
    regenerate(data,axis,track);dirty();render();
});
$("autoFit").addEventListener("click",()=>{
    if(!project||assembled())return;
    try{const {data,axis,track}=selected(),settings=autoFitAxis(data,axis,!!track?.window);record();data.config.axis_settings[axis]=settings;regenerate(data,axis,track);dirty();controls();render();}
    catch(error){status(error.message);}
});
$("fitSelection").addEventListener("click",()=>{
    if(!project)return;const track=selected().track;if(!track)return;
    try{
        const fitted=fitSelectionTrack(project,track,project.timeline.selection);
        record();project.timeline.tracks.push(fitted);project.timeline.active=fitted.id;project.timeline.selection=trackCoverage(project,fitted);
        buildTracks();selectionControls();controls();dirty();render();$("tracks").lastElementChild?.scrollIntoView({block:"nearest"});
        status("Selection fitted as a new track · review its motion, then use selection in main");
    }catch(error){status(error.message);}
});
$("undo").addEventListener("click",()=>{if(!history.length)return;const old=JSON.parse(history.pop());project.scripts=old.scripts;project.config=old.config;project.references=old.references;project.metrics=old.metrics;restoreTimeline(project,old.timeline);$("undo").disabled=!history.length;buildTracks();selectionControls();controls();dirty();render();});
function pointer(event,canvas){const rect=canvas.getBoundingClientRect();return {at:roundEven(Math.max(0,Math.min(project.metadata.duration_ms,bounds[0]+(event.clientX-rect.left-42)/(rect.width-54)*(bounds[1]-bounds[0])))),pos:roundEven(Math.max(0,Math.min(100,(rect.height-25-(event.clientY-rect.top))/(rect.height-40)*100)))};}
function nearest(event,canvas,actions){const a=pointer(event,canvas),rect=canvas.getBoundingClientRect();return actions.findIndex(p=>Math.hypot((p.at-a.at)/(bounds[1]-bounds[0])*(rect.width-54),(p.pos-a.pos)/100*(rect.height-40))<9);}
function seek(time){currentMs=time;if(video.readyState)video.currentTime=time/1000;render();}
function bindCurve(canvas,id){
    const actions=()=>id==="main"?project.scripts[$("axis").value].actions:project.timeline.tracks.find(t=>t.id===id).script.actions;
    canvas.addEventListener("pointerdown",event=>{
        if(!project||event.button!==0)return;selectLane(id);canvas.focus({preventScroll:true});
        const p=pointer(event,canvas);
        if(event.shiftKey){dragging={canvas,start:p.at,selection:true};setSelection(p.at,p.at);canvas.setPointerCapture(event.pointerId);return;}
        const index=nearest(event,canvas,actions());
        if(index>=0){record();dragging={canvas,index};canvas.setPointerCapture(event.pointerId);}else seek(p.at);
    });
    canvas.addEventListener("pointermove",event=>{
        if(dragging?.canvas!==canvas)return;
        const p=pointer(event,canvas);
        if(dragging.selection){setSelection(dragging.start,p.at);return;}
        const list=actions(),i=dragging.index,min=i?list[i-1].at+1:0,max=i+1<list.length?list[i+1].at-1:roundEven(project.metadata.duration_ms);
        list[i]={at:Math.max(min,Math.min(max,p.at)),pos:p.pos};dirty();render();
    });
    const release=()=>{if(dragging?.canvas===canvas){dragging=null;render();}};
    for(const name of ["pointerup","pointercancel","lostpointercapture"])canvas.addEventListener(name,release);
    canvas.addEventListener("dblclick",event=>{if(!project||event.shiftKey)return;selectLane(id);const list=actions(),p=pointer(event,canvas);if(list.some(a=>a.at===p.at))return;record();list.push(p);list.sort((a,b)=>a.at-b.at);dirty();render();});
    canvas.addEventListener("contextmenu",event=>{event.preventDefault();if(!project)return;selectLane(id);const list=actions(),i=nearest(event,canvas,list);if(i>=0&&list.length>1){record();list.splice(i,1);dirty();render();}});
}
bindCurve($("curve"),"main");
$("selectMain").onclick=()=>selectLane("main");
$("tracks").addEventListener("scroll",render,{passive:true});
window.addEventListener("scroll",render,{passive:true});
$("addTrack").onclick=()=>{if(!project)return;const current=selected().track,source=current?.source||project.timeline.sources[0].id;record();const track=newTrack(project,source,current?.axis||$("axis").value);project.timeline.active=track.id;buildTracks();dirty();controls();render();$("tracks").lastElementChild?.scrollIntoView({block:"nearest"});};
$("markIn").onclick=()=>{if(project)setSelection(currentMs,Math.max(currentMs,project.timeline.selection[1]));};
$("markOut").onclick=()=>{if(project)setSelection(Math.min(currentMs,project.timeline.selection[0]),currentMs);};
for(const id of ["selectionStart","selectionEnd"])$(id).onchange=()=>{
    if(!project)return;
    let start=$("selectionStart").valueAsNumber*1000,end=$("selectionEnd").valueAsNumber*1000;
    if(![start,end].every(Number.isFinite))return;
    if(start>end){if(id==="selectionStart")end=start;else start=end;}
    setSelection(start,end);
};
$("selectTrack").onclick=()=>{const track=project&&selected().track;if(track)setSelection(...trackCoverage(project,track));};
$("join").onchange=()=>$("blendMs").disabled=$("join").value!=="blend";
function applySelection(whole){
    if(!project)return;const track=selected().track;if(!track)return;
    try{
        const [start,end]=project.timeline.selection,blendMs=$("blendMs").valueAsNumber;
        // Validate on a small copy before recording history or changing the main.
        const preview={...project,scripts:{...project.scripts},metrics:{...project.metrics},timeline:{...project.timeline,main:structuredClone(project.timeline.main)}};
        applyTrack(preview,track,$("axis").value,{start,end,method:$("join").value,blendMs,whole});
        record();project.scripts=preview.scripts;project.metrics=preview.metrics;project.timeline.main=preview.timeline.main;
        dirty();controls();render();status(whole?"Main replaced with this track · Undo restores the previous main":"Selection copied into main · edit its points to refine the joins");
    }catch(error){status(error.message);}
}
$("applySection").onclick=()=>applySelection(false);$("promoteTrack").onclick=()=>applySelection(true);
document.addEventListener("keydown",event=>{
    if(!project||event.ctrlKey||event.metaKey||event.altKey||event.target.closest("input,select,textarea,button"))return;
    if(event.key.toLowerCase()==="i"){$("markIn").click();event.preventDefault();}
    if(event.key.toLowerCase()==="o"){$("markOut").click();event.preventDefault();}
});
let lastOrbit;
$("skeleton").addEventListener("pointerdown",e=>{lastOrbit=[e.clientX,e.clientY];$("skeleton").setPointerCapture(e.pointerId);});
$("skeleton").addEventListener("pointermove",e=>{if(!lastOrbit)return;orbit.yaw+=(e.clientX-lastOrbit[0])*.01;orbit.pitch+=(e.clientY-lastOrbit[1])*.01;lastOrbit=[e.clientX,e.clientY];render();});
$("skeleton").addEventListener("pointerup",()=>lastOrbit=null);$("skeleton").addEventListener("pointercancel",()=>lastOrbit=null);
$("skeleton").addEventListener("wheel",e=>{e.preventDefault();orbit.zoom=Math.max(.1,Math.min(5,orbit.zoom*Math.exp(-e.deltaY*.001)));render();},{passive:false});
$("device").addEventListener("change",render);
$("deviceSleeve").addEventListener("change",render);
let devicePointer;
$("robot").addEventListener("pointerdown",e=>{if(e.button!==0||devicePointer)return;devicePointer={id:e.pointerId,x:e.clientX,y:e.clientY};$("robot").setPointerCapture(e.pointerId);});
$("robot").addEventListener("pointermove",e=>{
    if(devicePointer?.id!==e.pointerId)return;
    deviceOrbit.yaw+=(e.clientX-devicePointer.x)*.009;
    deviceOrbit.pitch=Math.max(-1.25,Math.min(1.25,deviceOrbit.pitch+(e.clientY-devicePointer.y)*.009));
    devicePointer.x=e.clientX;devicePointer.y=e.clientY;render();
});
for(const event of ["pointerup","pointercancel","lostpointercapture"])$("robot").addEventListener(event,e=>{if(devicePointer?.id===e.pointerId)devicePointer=null;});
$("robot").addEventListener("wheel",e=>{e.preventDefault();deviceOrbit.zoom=Math.max(.5,Math.min(2,deviceOrbit.zoom*Math.exp(-e.deltaY*.001)));render();},{passive:false});
$("robot").addEventListener("keydown",e=>{
    if(!["ArrowLeft","ArrowRight","ArrowUp","ArrowDown","+","=","-"].includes(e.key))return;
    e.preventDefault();
    if(e.key==="ArrowLeft")deviceOrbit.yaw-=.1;if(e.key==="ArrowRight")deviceOrbit.yaw+=.1;
    if(e.key==="ArrowUp")deviceOrbit.pitch-=.1;if(e.key==="ArrowDown")deviceOrbit.pitch+=.1;
    if(e.key==="+"||e.key==="=")deviceOrbit.zoom*=1.1;if(e.key==="-")deviceOrbit.zoom/=1.1;
    deviceOrbit.pitch=Math.max(-1.25,Math.min(1.25,deviceOrbit.pitch));deviceOrbit.zoom=Math.max(.5,Math.min(2,deviceOrbit.zoom));render();
});
$("projectFile").addEventListener("change",async e=>{try{install(JSON.parse(await e.target.files[0].text()));}catch(error){status(error.message);}});
$("videoFile").addEventListener("change",e=>{if(videoURL)URL.revokeObjectURL(videoURL);videoURL=URL.createObjectURL(e.target.files[0]);video.src=videoURL;status("Local source loaded");});
$("referenceFile").addEventListener("change",async e=>{if(!project){status("Open a project first");return;}try{const file=e.target.files[0],data=JSON.parse(await file.text()),actions=validateReference(data);record();project.references={...project.references,[$("axis").value]:{actions,offset_ms:0,source:{path:file.name},header_inverted:!!data.inverted,interpretation:"Positions compared as written; legacy headers not applied"}};dirty();controls();render();}catch(error){status(error.message);}});
$("referenceOffset").addEventListener("change",()=>{const ref=project?.references?.[$("axis").value],offset=Number($("referenceOffset").value);if(!ref||!Number.isFinite(offset))return;record();ref.offset_ms=offset;dirty();render();});
$("save").addEventListener("click",async()=>{
    if(!project)return;
    $("save").disabled=true;
    // Capture edits and the preview choice together before fetching the offline template.
    const snapshot=structuredClone({...project,preview:{...project.preview,device:$("device").value}});
    const projectJSON=JSON.stringify(snapshot);
    try{
        if(!standaloneTemplate){
            const response=await fetch("viewer-standalone.html");
            if(!response.ok)throw new Error(`Offline viewer load failed (${response.status})`);
            standaloneTemplate=await response.text();
        }
        const html=standaloneTemplate.replace(/(<script id="s3f-project" type="application\/json">)[\s\S]*?(<\/script>)/,
            (_,open,close)=>open+projectJSON.replaceAll("<","\\u003c")+close);
        const stem=snapshot.metadata.source.path.split("/").at(-1).replace(/\.[^.]+$/,"");
        const files={"project.json":projectJSON,"viewer.html":"<!doctype html>\n"+html.replace(/^<!doctype html>\s*/i,"")};
        for(const [axis,script]of Object.entries(snapshot.scripts))files[stem+SUFFIX[axis]+".funscript"]=JSON.stringify(script);
        const url=URL.createObjectURL(makeZip(files)),a=document.createElement("a");a.href=url;a.download=stem+"-motion.zip";a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
        status("Download created · extract and open viewer.html for offline playback, or reimport project.json in ComfyUI");
    }catch(error){status(error.message);}finally{$("save").disabled=false;}
});
new ResizeObserver(render).observe(document.body);
const id=new URLSearchParams(location.search).get("project");
const embedded=document.getElementById("s3f-project");
if(embedded){try{const data=JSON.parse(embedded.textContent);if(data)install(data);}catch(error){status(error.message);}}
else if(id){try{const response=await fetch(`../projects/${encodeURIComponent(id)}`);if(!response.ok)throw new Error(`Project load failed (${response.status})`);install(await response.json());video.src=`../video/${encodeURIComponent(id)}`;}catch(error){status(error.message);}}
