import {AXES, SUFFIX, evaluate, rebuildAxis, roundEven, makeZip, validateReference, referenceAgreement, motionForAxis, autoFitAxis, bodyFrame, invertAxis, axisValue} from "./curve.mjs";
import {initializeTimeline, sourceChoices, sourceProject, newTrack, assignTrack, trackProject, editProject, mainPoseProject, timelineState, restoreTimeline, trackCoverage, fitSelectionTrack, applyTrack, selectionTrack, selectionProblem} from "./timeline.mjs";
import {timelineView, zoomView, panView, followView, sliderSpan, spanSlider, formatTime, rulerTicks, visibleRange, displayIndices} from "./viewport.mjs";
import {editorSession, sameVideoSource} from "./editor-session.mjs";
import {DEVICE_INFO, drawDeviceWireframe} from "./device-previews/device-wireframes.mjs";

const $ = id => document.getElementById(id), video = $("video");
const COLORS = ["#75e2ba", "#dcadfa", "#78baf7", "#ffc07d"];
const EDGES = [[5,6],[5,7],[7,62],[6,8],[8,41],[5,9],[6,10],[9,10],[9,11],[11,13],[10,12],[12,14],[0,5],[0,6]];
const ANCHORS = {pelvis:[9,10],chest:[5,6],nose:[0],left_wrist:[62],right_wrist:[41]};
let project, history = [], currentMs = 0, dragging = null, bounds = [0, 1], videoURL;
let comparisonRevision=0, comparisonCache=null;
let view = timelineView(1), scrollPosition = 0;
const curveLayers = new WeakMap();
const viewKey = (()=>{const params=new URLSearchParams(location.search);return 's3f-timeline-view:'+(params.get('session')||params.get('project')||location.pathname);})();
function previewState() {return {...project.preview,device:$("device").value,timeline_view:{...view}};}
function saveView() {try{localStorage.setItem(viewKey+':'+project.metadata.source.path,JSON.stringify(view));}catch{/* Storage is optional in offline/private browsers. */}}
function restoreView(data, keep) {
    let saved=data.preview?.timeline_view;
    if(!document.getElementById('s3f-project')){try{saved=JSON.parse(localStorage.getItem(viewKey+':'+data.metadata.source.path))||saved;}catch{/* Use the default view. */}}
    view=timelineView(data.metadata.duration_ms,keep?view:saved||{start_ms:data.times_ms[0]});
}
function navigationControls() {
    const duration=project.metadata.duration_ms,span=view.span_ms;
    bounds=[view.start_ms,view.start_ms+span];
    $("zoomLevel").value=spanSlider(duration,span);
    const preset=[...$("zoom").options].find(o=>o.value!=="custom"&&Math.abs((Number(o.value)||duration)-span)<.01);
    $("zoom").value=preset?.value||"custom";
    $("zoomOut").disabled=span>=duration;$("zoomIn").disabled=span<=Math.min(250,duration);
    $("zoomSelection").disabled=project.timeline.selection[1]<=project.timeline.selection[0];
    $("followPlayhead").checked=view.follow;
    $("viewRange").textContent=`${formatTime(bounds[0],span<10000?3:0,duration>=3600000)} – ${formatTime(bounds[1],span<10000?3:0,duration>=3600000)}`;
    $("viewRange").dataset.start=String(bounds[0]);$("viewRange").dataset.end=String(bounds[1]);
    const scroll=$("timelineScroll"),width=scroll.clientWidth;
    // A virtual spacer keeps a native scrollbar without allocating a giant canvas.
    $("timelineScrollSpace").style.width=Math.min(4000000,Math.max(width,width*duration/span))+'px';
    const travel=scroll.scrollWidth-width;
    const target=duration>span?view.start_ms/(duration-span)*travel:0;
    if(Math.abs(scroll.scrollLeft-target)>.5)scroll.scrollLeft=target;
    scrollPosition=scroll.scrollLeft;
}
function changeView(next) {if(!project)return;view=timelineView(project.metadata.duration_ms,next);saveView();render();}
function zoomTimeline(span, anchor) {
    if(!project||dragging)return;
    const pointed=anchor!==undefined;
    anchor??=(currentMs>=bounds[0]&&currentMs<=bounds[1]?currentMs:(bounds[0]+bounds[1])/2);
    changeView(zoomView(project.metadata.duration_ms,{...view,follow:pointed?false:view.follow},span,anchor));
}
function scrollTimeline(start) {if(project&&!dragging)changeView(panView(project.metadata.duration_ms,view,start));}
function timelineWheel(event, canvas) {
    if(!project||dragging)return;
    const rect=canvas.getBoundingClientRect(),scale=event.deltaMode===1?16:event.deltaMode===2?rect.width:1;
    if(event.ctrlKey||event.metaKey){
        event.preventDefault();const fraction=Math.max(0,Math.min(1,(event.clientX-rect.left-42)/(rect.width-54)));
        zoomTimeline(view.span_ms*Math.exp(Math.max(-1,Math.min(1,event.deltaY*scale*.003))),view.start_ms+fraction*view.span_ms);
    }else if(event.shiftKey||Math.abs(event.deltaX)>Math.abs(event.deltaY)){
        event.preventDefault();scrollTimeline(view.start_ms+(event.deltaX||event.deltaY)*scale/Math.max(1,rect.width-54)*view.span_ms);
    }
}
let orbit = {yaw: .2, pitch: -.1, zoom: 1};
const deviceOrbit = {yaw: .62, pitch: .27, zoom: 1};
// Capture the untouched offline document before project installation updates its UI.
let standaloneTemplate = document.getElementById("s3f-project") ? document.documentElement.outerHTML : null;
const status = message => { $("status").textContent = message; };
function record() { history.push(JSON.stringify({scripts:project.scripts, config:project.config,references:project.references,metrics:project.metrics,timeline:timelineState(project)})); if(history.length>40)history.shift(); $("undo").disabled=false; }
const session = editorSession({install, snapshot:()=>({...project,preview:previewState()}), status});
function dirty(authored=true) { if(authored&&!locked()){const {track}=selected();(track||project.timeline.main[$("axis").value]).edited=true;} project.manual_edits = true; session?.changed(); ++comparisonRevision; delete project.reference_comparison; status("Unsaved edits · download the project to keep them"); }
function install(data, keepPlayback=false, output=null) {
    const oldAxis=$("axis").value, previousMs=currentMs, hadVideo=!!video.getAttribute("src");
    if (data.schema !== "sam3d-funscript/1" || !data.scripts || !data.times_ms?.length) throw new Error("Unsupported project file");
    keepPlayback=!!(keepPlayback&&sameVideoSource(project?.metadata?.source,data.metadata.source));
    dragging=null;
    if(!keepPlayback){video.pause(); video.removeAttribute("src"); video.load();
    if(videoURL){URL.revokeObjectURL(videoURL);videoURL=null;}}
    initializeTimeline(data);restoreView(data,keepPlayback); project = data; history=[]; ++comparisonRevision; $("undo").disabled=true;
    $("device").value = Object.hasOwn(DEVICE_INFO, data.preview?.device) ? data.preview.device : "sr6";
    $("axis").replaceChildren(...Object.keys(data.scripts).map(axis => new Option(axis + " · " + ({L0:"stroke",L1:"surge",L2:"sway",R0:"twist",R1:"roll",R2:"pitch"}[axis]), axis)));
    $("name").textContent = data.metadata.source.path.split("/").at(-1);
    $("warnings").replaceChildren(...(data.warnings||[]).map(text=>{const li=document.createElement("li");li.textContent=text;return li;}));
    $("provenance").textContent = JSON.stringify({source:data.metadata.source,model:data.metadata.model,samples:data.times_ms.length,basis:data.metadata.basis,config:data.config},null,2);
    if(keepPlayback&&data.scripts[oldAxis])$("axis").value=oldAxis;
    if(output&&(!keepPlayback||!hadVideo))video.src=`../video/${encodeURIComponent(output)}`;
    currentMs=keepPlayback?previousMs:data.times_ms[0]; buildTracks(); selectionControls(); controls(); render(); status("Project loaded · choose the matching source video");
}
function selected() { return editProject(project,$("axis").value); }
function commitSelected(data,axis,track) {
    if(track){track.settings=data.config.axis_settings[axis];track.script=data.scripts[axis];track.metrics=data.metrics?.[axis];}
}
function locked(id=project.timeline.active) {return !!(id==="main"?project.timeline.main[$("axis").value]:project.timeline.tracks.find(t=>t.id===id))?.locked;}
function assembled() {return project.timeline.active==="main"&&project.timeline.main[$("axis").value].assembled;}
function controls() {
    const {data,axis,track}=selected(), s=data.config.axis_settings[axis];
    if(track)project.timeline.selection_track=track.id;
    $("component").value=s.component; $("range").value=s.range; $("center").value=s.center; $("invert").checked=s.invert;
    $("unit").textContent=axis.startsWith("R")?"degrees":"metres";
    $("calibration").value=s.calibration??"clip";
    for(const id of ["component","calibration","range","center","rebuild","autoFit"])$(id).disabled=assembled()||locked();
    calibrationControls();
    $("invert").disabled=locked();
    $("editing").textContent=track?`Editing ${track.name} · ${axis}. Source edits are independent; apply a selection to update main.`:
        assembled()?"Editing main · assembled sections. Drag points to adjust joins, or calibrate a source track and apply it again.":`Editing main · ${axis}`;
    $("fitSelection").disabled=!track;
    if(track?.window)$("editing").textContent=`Editing ${track.name} · ${axis} · local origin within ${track.window.map(t=>(t/1000).toFixed(3)).join("–")} s. Apply a selection to update main.`;
    if(locked())$("editing").textContent="Locked · curve, calibration and source are protected across reruns. Unlock this track to edit it.";
    $("lockMain").textContent=locked("main")?"Unlock":"Lock";$("lockMain").setAttribute("aria-pressed",String(locked("main")));
    const ref=project.references?.[$("axis").value];$("referenceOffset").disabled=!ref;$("referenceOffset").value=ref?.offset_ms||0;
    document.querySelectorAll(".track").forEach(row=>row.classList.toggle("selected",row.dataset.track===project.timeline.active));
    $("selectMain").textContent=`Main · ${$("axis").value} · export`;
    const main=project.timeline.main[$("axis").value];
    $("mainDescription").textContent=main.assembled?`${main.regions.length} source sections · device preview and exports follow main`:"Device preview and exported scripts follow this track";
    selectionControls();
}
function calibrationControls() {
    const {data,axis}=selected();
    const adaptive=$("component").value==="auto"&&$("calibration").value==="adaptive"&&data.config.axis_settings[axis].auto_fit;
    $("rangeLabel").textContent=adaptive?"Local full-scale range":"Full-scale range";
    for(const id of ["range","center"])$(id).disabled=assembled()||locked()||adaptive;
}
function selectLane(id) {
    if(!project)return;
    project.timeline.active=id;controls();render();
}
function selectionControls() {
    [$("selectionStart").value,$("selectionEnd").value]=project.timeline.selection.map(t=>(t/1000).toFixed(3));
    const track=selectionTrack(project),axis=$("axis").value,problem=selectionProblem(project,track,axis);
    $("applySection").disabled=!!problem;$("applySection").title=problem||`Copy only ${track.axis} from ${track.name} into main ${axis}`;
    $("promoteTrack").disabled=!!selectionProblem(project,track,axis,true);
    $("promoteTrack").title=selectionProblem(project,track,axis,true)||`Replace only main ${axis} with this source's ${track.axis}`;
    $("selectTrack").disabled=!track;
    $("selectionStatus").textContent=problem||(track?`Copy source: ${track.name} · ${track.axis} → Main ${axis} · one axis only`:"");
    const tracks=new Map(project.timeline.tracks.map(t=>[t.id,t]));
    for(const row of $("tracks").children){
        row.classList.toggle("copy-source",row.dataset.track===track?.id);
        const source=tracks.get(row.dataset.track),button=row.querySelector(".copy-selection");
        const reason=selectionProblem(project,source,axis);button.disabled=!!reason;button.title=reason||`Copy this row's ${source.axis} into main ${axis}`;
        const label=`Copy selection → ${axis}`;if(button.textContent!==label)button.textContent=label;
    }
}
function setSelection(start,end) {
    const duration=roundEven(project.metadata.duration_ms);
    project.timeline.selection=[start,end].map(t=>Math.max(0,Math.min(duration,roundEven(t)))).sort((a,b)=>a-b);
    selectionControls();render();
}
function buildTracks() {
    $("tracks").replaceChildren();
    for(const track of project.timeline.tracks){
        const row=document.createElement("div");row.className="track";row.dataset.track=track.id;
        const head=document.createElement("div");head.className="track-head";
        const select=document.createElement("button");select.className="track-select";select.textContent="Edit";select.onclick=()=>selectLane(track.id);
        const name=document.createElement("input");name.type="text";name.className="track-name";name.value=track.name;name.setAttribute("aria-label","Track name");
        name.onchange=()=>{if(track.locked)return;record();track.custom_name=true;track.name=name.value.trim()||"Source track";dirty(false);controls();render();};
        const source=document.createElement("select");source.className="track-source";source.setAttribute("aria-label","Anchor project");
        const choices=sourceChoices(project);
        for(const current of [true,false]){
            const entries=choices.filter(s=>s.current===current);if(!entries.length)continue;
            const group=document.createElement("optgroup");group.label=current?"Latest inputs":"Saved versions used in this timeline";
            group.append(...entries.map(s=>new Option(s.label,s.id)));source.append(group);
        }
        source.value=track.source;
        const axis=document.createElement("select");axis.className="track-axis";axis.setAttribute("aria-label","Source axis");
        const axes=()=>{axis.replaceChildren(...Object.keys(sourceProject(project,source.value).scripts).map(a=>new Option(a,a)));axis.value=track.axis;};axes();
        source.onchange=()=>{if(track.locked)return;record();assignTrack(project,track,source.value,axis.value);project.timeline.active=track.id;buildTracks();dirty();controls();render();};
        axis.onchange=()=>{if(track.locked)return;record();assignTrack(project,track,source.value,axis.value);project.timeline.active=track.id;buildTracks();dirty();controls();render();};
        const remove=document.createElement("button");remove.className="remove-track";remove.textContent="Remove";
        remove.onclick=()=>{if(track.locked)return;record();project.timeline.tracks=project.timeline.tracks.filter(t=>t!==track);if(project.timeline.active===track.id)project.timeline.active="main";buildTracks();dirty();controls();render();};
        const sourceLabel=document.createElement("label");sourceLabel.append("Project ",source);
        const axisLabel=document.createElement("label");axisLabel.append("Axis ",axis);
        const lock=document.createElement("button");lock.className="track-lock";lock.title="Protect this curve and calibration across edits and reruns. Unlock explicitly to edit.";lock.textContent=track.locked?"Unlock":"Lock";lock.setAttribute("aria-pressed",String(!!track.locked));lock.onclick=()=>toggleLock(track);
        const copy=document.createElement("button");copy.className="copy-selection";copy.onclick=()=>{selectLane(track.id);applySelection(false);};
        const badge=document.createElement("span");badge.className="copy-source-badge";badge.textContent="Copy source";
        for(const input of [name,source,axis,remove])input.disabled=!!track.locked;
        head.append(select,lock,name,sourceLabel,axisLabel,copy,badge,remove);
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
        const motion=project.config.axis_settings[axis].component==="auto"?motionForAxis(project,axis):null;
        const report=motion?.spans.find(s=>index>=s.start&&index<s.end);
        if(report){
            const d=motion.directions?.[index]??report.direction,relative=project.config.frame==="reference_body";
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
    const [ctx,w,h]=resize(canvas),composed=isMain&&project.timeline.main[axis].assembled;
    const x=t=>42+(t-bounds[0])/(bounds[1]-bounds[0])*(w-54),y=p=>h-25-p/100*(h-40);
    const actions=data.scripts[axis].actions,s=data.config.axis_settings[axis],color=isMain?"#75e2ba":"#78baf7";
    const key=JSON.stringify([w,h,devicePixelRatio,bounds,axis,comparisonRevision,composed,s,window]);
    let layer=curveLayers.get(canvas);
    if(!layer||layer.key!==key||layer.data!==data||layer.actions!==actions){
        const surface=layer?.surface||document.createElement("canvas");surface.width=canvas.width;surface.height=canvas.height;
        const paint=surface.getContext("2d");paint.setTransform(devicePixelRatio||1,0,0,devicePixelRatio||1,0,0);
        const source=composed?{raw:[],processed:[],spans:[]}:motionForAxis(data,axis);
        paint.font="11px system-ui";paint.fillStyle="#8197ab";
        for(const p of [0,25,50,75,100]){line(paint,[42,y(p)],[w-12,y(p)],"#2a3c4c",1);paint.fillText(p,9,y(p)+4);}
        for(const tick of rulerTicks(...bounds,w-54,project.metadata.duration_ms)){
            line(paint,[x(tick.time),10],[x(tick.time),h-25],"#263744",1);
            paint.fillText(tick.label,Math.max(42,Math.min(w-12-paint.measureText(tick.label).width,x(tick.time)-paint.measureText(tick.label).width/2)),h-6);
        }
        paint.save();paint.beginPath();paint.rect(42,10,w-54,h-30);paint.clip();
        function stroke(length,timeAt,valueAt,strokeColor,width=1,breakAt=()=>false){
            const indices=displayIndices(length,timeAt,valueAt,...bounds,w-54,breakAt);
            paint.strokeStyle=strokeColor;paint.lineWidth=width;paint.beginPath();let pen=false;
            for(const i of indices){
                if(i===null||!Number.isFinite(valueAt(i))){pen=false;continue;}
                const px=x(timeAt(i)),py=y(Math.max(0,Math.min(100,valueAt(i))));
                if(breakAt(i))pen=false;
                if(pen)paint.lineTo(px,py);else paint.moveTo(px,py);pen=true;
            }paint.stroke();
        }
        paint.save();
        if(window){
            paint.fillStyle="#0c121977";paint.fillRect(42,10,x(window[0])-42,h-30);paint.fillRect(x(window[1]),10,w-12-x(window[1]),h-30);
            paint.beginPath();paint.rect(x(window[0]),10,x(window[1])-x(window[0]),h-30);paint.clip();
        }
        const timeAt=i=>data.times_ms[i],breakAt=i=>i>0&&data.segments[i]!==data.segments[i-1];
        const [first,stop]=visibleRange(data.times_ms.length,timeAt,...bounds);
        for(let i=first;!composed&&i<stop;i++)if(!data.valid[i]||breakAt(i)){
            paint.fillStyle="#8c593b66";paint.fillRect(x(timeAt(i)),15,Math.max(2,x(data.times_ms[i+1]??timeAt(i)+10)-x(timeAt(i))),h-40);
        }
        for(const [field,strokeColor] of [["raw","#607689"],["processed","#bb9457"]]){
            stroke(source[field].length,timeAt,i=>data.valid[i]?axisValue(source,s,i,field):null,strokeColor,1,breakAt);
        }
        stroke(actions.length,i=>actions[i].at,i=>actions[i].pos,color,2);
        const [a,b]=visibleRange(actions.length,i=>actions[i].at,...bounds);
        // Individual handles are meaningful only when points can be distinguished.
        if(b-a<=(w-54)/4){paint.fillStyle=color;for(let i=a;i<b;i++){const action=actions[i];paint.beginPath();paint.arc(x(action.at),y(action.pos),3,0,Math.PI*2);paint.fill();}}
        paint.restore();
        const ref=isMain?project.references?.[axis]:null;
        let referenceLabel="No reference loaded for this axis";
        if(ref){
            const shift=ref.offset_ms||0;
            stroke(ref.actions.length,i=>ref.actions[i].at+shift,i=>ref.actions[i].pos,"#dcadfa",2);
            if(!comparisonCache||comparisonCache.axis!==axis||comparisonCache.revision!==comparisonRevision){comparisonCache={axis,revision:comparisonRevision,value:referenceAgreement(actions,ref,composed?0:data.times_ms[0],composed?project.metadata.duration_ms:data.times_ms.at(-1))};}
            const m=comparisonCache.value;
            referenceLabel=m?`Reference agreement · MAE ${m.mae.toFixed(1)} / 100 · RMSE ${m.rmse.toFixed(1)} · correlation ${m.correlation===null?"undefined":m.correlation.toFixed(3)} · full overlap`:'Reference does not overlap this analysis';
        }
        if(isMain)for(const region of project.timeline.main[axis].regions){
            if(region.end<bounds[0]||region.start>bounds[1])continue;
            paint.fillStyle="#eabf7177";paint.fillRect(x(region.start),10,x(region.end)-x(region.start),4);
            const left=Math.max(44,x(region.start)+4),right=Math.min(w-12,x(region.end));
            if(right-left>35){paint.save();paint.beginPath();paint.rect(left,15,right-left,14);paint.clip();paint.fillStyle="#eabf71";paint.fillText(region.name,left,24);paint.restore();}
        }
        paint.restore();
        let count=0,clipped=0;
        for(let i=0;i<source.processed.length;i++)if(data.valid[i]&&Number.isFinite(source.processed[i])){
            const value=axisValue(source,s,i);++count;if(value<0||value>100)++clipped;
        }
        layer={key,data,actions,surface,source,clipped:count?clipped/count*100:0,referenceLabel};curveLayers.set(canvas,layer);
    }
    ctx.drawImage(layer.surface,0,0,layer.surface.width,layer.surface.height,0,0,w,h);
    ctx.save();ctx.beginPath();ctx.rect(42,10,w-54,h-30);ctx.clip();
    const [start,end]=project.timeline.selection;
    if(end>start){
        const source=selectionTrack(project),chosen=!!source&&canvas.dataset.track===source.id;
        if(chosen){ctx.fillStyle="#78baf733";ctx.fillRect(x(start),10,x(end)-x(start),h-35);}else ctx.setLineDash([4,4]);
        for(const t of [start,end])line(ctx,[x(t),10],[x(t),h-25],chosen?"#78baf7":isMain&&source?"#eabf71":"#607689",1);
        ctx.setLineDash([]);
    }
    line(ctx,[x(currentMs),10],[x(currentMs),h-25],"#f0f5fa",1);ctx.restore();
    if(isMain)$("referenceMetrics").textContent=layer.referenceLabel;
    if(!active)return;
    $("metrics").textContent=`${actions.length} actions · ${evaluate(actions,currentMs).toFixed(1)} / 100 · ${composed?"assembled main":`${layer.clipped.toFixed(1)}% source clipping`}`;
    $("directionInfo").hidden=composed||s.component!=="auto";
    const index=sampleIndex(data),direction=layer.source.spans.find(span=>index>=span.start&&index<span.end);
    const vector=layer.source.directions?.[index]??direction?.direction;
    if(layer.source.ranges&&$("range").disabled&&$("calibration").value==="adaptive")$("range").value=Number.isFinite(layer.source.ranges[index])?layer.source.ranges[index].toFixed(6):"";
    if(s.component==="auto")$("directionInfo").textContent=direction?`Auto ${axis} · ${layer.source.ranges?`Adaptive ${data.config.target_anchor.replaceAll("_"," ")} · `:"Whole clip · "}${["Up","Forward","Left"].map((name,i)=>`${name} ${vector[i]>=0?"+":""}${vector[i].toFixed(2)}`).join(" / ")} · ${(direction.share*100).toFixed(0)}% directional share${direction.mode==="still"?" · very little motion":direction.mode==="body_fallback"?` · mixed movement; ${direction.orientation} direction used`:""} · blue arrow in 3D view`:"Auto · no analysed direction at this time";
}
function render() {
    if(!project)return;
    $("time").textContent=project.metadata.duration_ms>=60000?formatTime(currentMs,3,project.metadata.duration_ms>=3600000):(currentMs/1000).toFixed(3)+" s";
    $("time").dataset.ms=String(currentMs);
    const selectedContext=selected(), outputAxis=$("axis").value;
    const pose=selectedContext.track?selectedContext:project.timeline.main[outputAxis].assembled?mainPoseProject(project,outputAxis,currentMs):selectedContext;
    const data=pose.data,i=sampleIndex(data),available=data.valid[i]&&currentMs>=data.times_ms[0]&&currentMs<=data.metadata.duration_ms&&Math.abs(currentMs-data.times_ms[i])<=data.config.max_gap_ms;
    if(available){drawOverlay(i,data);drawSkeleton(i,data,pose.axis);}
    else for(const name of ["overlay","skeleton"]){const[ctx,w,h]=resize($(name));ctx.fillStyle="#eabf71";ctx.font="13px system-ui";ctx.fillText("No analysed pose at this time",12,h/2);}
    if(!video.paused&&view.follow&&!dragging)view=followView(project.metadata.duration_ms,view,currentMs);
    navigationControls();
    drawRobot();
    const mainContext=editProject(project,outputAxis,"main");
    drawCurve($("curve"),mainContext.data,outputAxis,true,project.timeline.active==="main");
    const listRect=$("tracks").getBoundingClientRect();
    for(const track of project.timeline.tracks){
        const canvas=[...$("tracks").children].find(row=>row.dataset.track===track.id).querySelector("canvas"),rect=canvas.getBoundingClientRect();
        if(track.id===project.timeline.active||rect.bottom>=Math.max(0,listRect.top)&&rect.top<=Math.min(innerHeight,listRect.bottom))drawCurve(canvas,trackProject(project,track),track.axis,false,track.id===project.timeline.active,track.window);else curveLayers.delete(canvas);
    }
}
function frameCallback(_,metadata){currentMs=metadata.mediaTime*1000;render();video.requestVideoFrameCallback(frameCallback);}
if(video.requestVideoFrameCallback)video.requestVideoFrameCallback(frameCallback);
video.addEventListener("timeupdate",()=>{if(!video.requestVideoFrameCallback||video.paused){currentMs=video.currentTime*1000;render();}});
video.addEventListener("seeked",()=>{currentMs=video.currentTime*1000;if(project&&view.follow&&!dragging)view=followView(project.metadata.duration_ms,view,currentMs);render();});
video.addEventListener("error",()=>status("Choose the source video locally if this browser cannot load the server copy"));
$("axis").addEventListener("change",()=>{controls();render();});
$("zoom").addEventListener("change",()=>{if(project)zoomTimeline(Number($("zoom").value)||project.metadata.duration_ms);});
$("zoomLevel").addEventListener("input",()=>{if(project)zoomTimeline(sliderSpan(project.metadata.duration_ms,Number($("zoomLevel").value)));});
$("zoomIn").onclick=()=>zoomTimeline(view.span_ms/2);$("zoomOut").onclick=()=>zoomTimeline(view.span_ms*2);
$("showPlayhead").onclick=()=>{if(project)changeView(followView(project.metadata.duration_ms,view,currentMs,true));};
$("followPlayhead").onchange=()=>{if(project)changeView({...view,follow:$("followPlayhead").checked});};
$("zoomSelection").onclick=()=>{if(!project)return;const [start,end]=project.timeline.selection;if(end>start)changeView({...view,start_ms:start,span_ms:end-start,follow:false});};
$("timelineScroll").addEventListener("scroll",()=>{
    const scroll=$("timelineScroll");if(!project||Math.abs(scroll.scrollLeft-scrollPosition)<.5)return;
    const travel=scroll.scrollWidth-scroll.clientWidth;
    scrollTimeline(travel>0?scroll.scrollLeft/travel*(project.metadata.duration_ms-view.span_ms):0);
});
$("timelineScroll").addEventListener("wheel",event=>timelineWheel(event,$("curve")),{passive:false});
$("timelineScroll").addEventListener("keydown",event=>{
    if(!project||!["ArrowLeft","ArrowRight","Home","End"].includes(event.key))return;
    event.preventDefault();scrollTimeline(event.key==="Home"?0:event.key==="End"?project.metadata.duration_ms:view.start_ms+view.span_ms*(event.key==="ArrowLeft"?-.1:.1));
});
$("invert").addEventListener("change",()=>{
    if(!project||locked())return;
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
    const mapped=source.processed.map((v,i)=>axisValue(source,s,i)).filter(Number.isFinite);
    const raw=source.raw.filter(Number.isFinite);
    data.metrics??={};data.metrics[axis]={actions:data.scripts[axis].actions.length,
        clipped_fraction:mapped.filter(v=>v<0||v>100).length/mapped.length,
        raw_span:raw.reduce((m,v)=>Math.max(m,v),-Infinity)-raw.reduce((m,v)=>Math.min(m,v),Infinity),units:axis.startsWith("R")?"deg":"m"};
    if(s.component==="auto")data.metrics[axis].auto_direction=source.spans;
    if(source.ranges){const ranges=source.ranges.filter(Number.isFinite);data.metrics[axis].auto_calibration={mode:"adaptive",anchor:data.config.target_anchor,window_ms:3000,step_ms:500,range_min:ranges.reduce((m,v)=>Math.min(m,v),Infinity),range_max:ranges.reduce((m,v)=>Math.max(m,v),-Infinity)};}
    commitSelected(data,axis,track);
}
$("rebuild").addEventListener("click",()=>{
    if(!project||assembled()||locked())return;
    const {data:current,axis:currentAxis}=selected();
    if($("component").value==="auto"&&$("calibration").value==="adaptive"&&current.config.axis_settings[currentAxis].auto_fit){fitAutomatic();return;}
    const range=Number($("range").value),center=Number($("center").value);
    if(!Number.isFinite(range)||range<=0||!Number.isFinite(center)||center<0||center>100){status("Range must be positive; center must be between 0 and 100");return;}
    record();const {data,axis,track}=selected();data.config.axis_settings[axis]={range,center,invert:$("invert").checked,component:$("component").value==="auto"?"auto":Number($("component").value),auto_fit:false,calibration:$("calibration").value};
    regenerate(data,axis,track);dirty();controls();render();
});
function fitAutomatic(calibration=$("calibration").value) {
    if(!project||assembled()||locked())return;
    try{const {data,axis,track}=selected(),settings=autoFitAxis(data,axis,!!track?.window&&calibration==="clip",calibration);record();data.config.axis_settings[axis]=settings;regenerate(data,axis,track);dirty();controls();render();}
    catch(error){status(error.message);}
}
$("autoFit").addEventListener("click",()=>{if(project){const {data,axis}=selected();fitAutomatic(data.config.axis_settings[axis].calibration??"adaptive");}});
$("calibration").addEventListener("change",()=>fitAutomatic());
$("component").addEventListener("change",calibrationControls);
$("fitSelection").addEventListener("click",()=>{
    if(!project)return;const track=selected().track;if(!track)return;
    try{
        const fitted=fitSelectionTrack(project,track,project.timeline.selection);
        record();project.timeline.tracks.push(fitted);project.timeline.active=fitted.id;project.timeline.selection=trackCoverage(project,fitted);
        buildTracks();selectionControls();controls();dirty();render();$("tracks").lastElementChild?.scrollIntoView({block:"nearest"});
        status("Selection fitted as a new track · review its motion, then use selection in main");
    }catch(error){status(error.message);}
});
$("undo").addEventListener("click",()=>{if(!history.length)return;const old=JSON.parse(history.pop());project.scripts=old.scripts;project.config=old.config;project.references=old.references;project.metrics=old.metrics;restoreTimeline(project,old.timeline);$("undo").disabled=!history.length;buildTracks();selectionControls();controls();dirty(false);render();});
function pointer(event,canvas){const rect=canvas.getBoundingClientRect();return {at:roundEven(Math.max(0,Math.min(project.metadata.duration_ms,bounds[0]+(event.clientX-rect.left-42)/(rect.width-54)*(bounds[1]-bounds[0])))),pos:roundEven(Math.max(0,Math.min(100,(rect.height-25-(event.clientY-rect.top))/(rect.height-40)*100)))};}
function nearest(event,canvas,actions){
    const a=pointer(event,canvas),rect=canvas.getBoundingClientRect(),[first,stop]=visibleRange(actions.length,i=>actions[i].at,...bounds);
    if(stop-first>(rect.width-54)/4)return -1;
    for(let i=first;i<stop;i++){const p=actions[i];if(Math.hypot((p.at-a.at)/(bounds[1]-bounds[0])*(rect.width-54),(p.pos-a.pos)/100*(rect.height-40))<9)return i;}return -1;
}
function seek(time){currentMs=time;if(video.readyState)video.currentTime=time/1000;render();}
function bindCurve(canvas,id){
    canvas.addEventListener("wheel",event=>timelineWheel(event,canvas),{passive:false});
    const actions=()=>id==="main"?project.scripts[$("axis").value].actions:project.timeline.tracks.find(t=>t.id===id).script.actions;
    canvas.addEventListener("pointerdown",event=>{
        if(!project||event.button!==0)return;selectLane(id);canvas.focus({preventScroll:true});
        const p=pointer(event,canvas);
        if(event.shiftKey){dragging={canvas,start:p.at,selection:true};setSelection(p.at,p.at);canvas.setPointerCapture(event.pointerId);return;}
        const index=nearest(event,canvas,actions());
        if(index>=0&&!locked(id)){record();dragging={canvas,index};canvas.setPointerCapture(event.pointerId);}else seek(p.at);
    });
    canvas.addEventListener("pointermove",event=>{
        if(dragging?.canvas!==canvas)return;
        const p=pointer(event,canvas);
        if(dragging.selection){setSelection(dragging.start,p.at);return;}
        if(locked(id))return;
        const list=actions(),i=dragging.index,min=i?list[i-1].at+1:0,max=i+1<list.length?list[i+1].at-1:roundEven(project.metadata.duration_ms);
        list[i]={at:Math.max(min,Math.min(max,p.at)),pos:p.pos};dirty();render();
    });
    const release=()=>{if(dragging?.canvas===canvas){dragging=null;render();}};
    for(const name of ["pointerup","pointercancel","lostpointercapture"])canvas.addEventListener(name,release);
    canvas.addEventListener("dblclick",event=>{if(!project||event.shiftKey||locked(id))return;selectLane(id);const list=actions(),p=pointer(event,canvas);if(list.some(a=>a.at===p.at))return;record();list.push(p);list.sort((a,b)=>a.at-b.at);dirty();render();});
    canvas.addEventListener("contextmenu",event=>{event.preventDefault();if(!project||locked(id))return;selectLane(id);const list=actions(),i=nearest(event,canvas,list);if(i>=0&&list.length>1){record();list.splice(i,1);dirty();render();}});
}
async function toggleLock(target) {
    target.locked=!target.locked;
    // Unlock is explicit: Undo cannot reach behind a lock and replace its curve.
    history=[];$("undo").disabled=true;dragging=null;buildTracks();controls();dirty(false);render();
    if(session){try{await session.flush();}catch(error){status(error.message);}}
}
$("lockMain").onclick=()=>{if(project)toggleLock(project.timeline.main[$("axis").value]);};
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
$("selectTrack").onclick=()=>{const track=project&&selectionTrack(project);if(track)setSelection(...trackCoverage(project,track));};
$("join").onchange=()=>$("blendMs").disabled=$("join").value!=="blend";
function applySelection(whole){
    if(!project)return;const track=selectionTrack(project),problem=selectionProblem(project,track,$("axis").value,whole);
    if(problem){$("selectionStatus").textContent=problem;return;}
    try{
        const [start,end]=project.timeline.selection,blendMs=$("blendMs").valueAsNumber;
        // Validate on a small copy before recording history or changing the main.
        const preview={...project,scripts:{...project.scripts},metrics:{...project.metrics},timeline:{...project.timeline,main:structuredClone(project.timeline.main)}};
        applyTrack(preview,track,$("axis").value,{start,end,method:$("join").value,blendMs,whole});
        record();project.scripts=preview.scripts;project.metrics=preview.metrics;project.timeline.main=preview.timeline.main;
        project.timeline.main[$("axis").value].edited=true;dirty(false);controls();render();
        const message=`${whole?"Whole track":"Selection"} copied: ${track.name} · ${track.axis} → Main ${$("axis").value}. Other axes unchanged. Undo restores the previous main.`;
        status(message);$("selectionStatus").textContent=message;
    }catch(error){status(error.message);$("selectionStatus").textContent=error.message;}
}
$("applySection").onclick=()=>applySelection(false);$("promoteTrack").onclick=()=>applySelection(true);
document.addEventListener("keydown",event=>{
    if(!project||event.ctrlKey||event.metaKey||event.altKey||event.target.closest("input,select,textarea,button"))return;
    if(["+","=","-"].includes(event.key)&&event.target.closest(".curves")){event.preventDefault();zoomTimeline(view.span_ms*(event.key==="-"?2:.5));}
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
$("projectFile").addEventListener("change",async e=>{try{install(JSON.parse(await e.target.files[0].text()));dirty(false);}catch(error){status(error.message);}});
$("videoFile").addEventListener("change",e=>{if(videoURL)URL.revokeObjectURL(videoURL);videoURL=URL.createObjectURL(e.target.files[0]);video.src=videoURL;status("Local source loaded");});
$("referenceFile").addEventListener("change",async e=>{if(!project){status("Open a project first");return;}try{const file=e.target.files[0],data=JSON.parse(await file.text()),actions=validateReference(data);record();project.references={...project.references,[$("axis").value]:{actions,offset_ms:0,source:{path:file.name},header_inverted:!!data.inverted,interpretation:"Positions compared as written; legacy headers not applied"}};dirty();controls();render();}catch(error){status(error.message);}});
$("referenceOffset").addEventListener("change",()=>{const ref=project?.references?.[$("axis").value],offset=Number($("referenceOffset").value);if(!ref||!Number.isFinite(offset))return;record();ref.offset_ms=offset;dirty();render();});
$("save").addEventListener("click",async()=>{
    if(!project)return;
    $("save").disabled=true;
    // Capture edits and the preview choice together before fetching the offline template.
    const snapshot=structuredClone({...project,preview:previewState()});
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
else if(id){try{
    const fetchProject=async()=>{const response=await fetch(`../projects/${encodeURIComponent(id)}`);if(!response.ok)throw new Error(`Project load failed (${response.status})`);return response.json();};
    if(session)await session.load(fetchProject);else install(await fetchProject(),false,id);
}catch(error){status(error.message);}}
