import {AXES, SUFFIX, evaluate, rebuildAxis, roundEven, makeZip, validateReference, referenceAgreement} from "./curve.mjs";

const $ = id => document.getElementById(id), video = $("video");
const COLORS = ["#75e2ba", "#dcadfa", "#78baf7", "#ffc07d"];
const EDGES = [[5,6],[5,7],[7,62],[6,8],[8,41],[5,9],[6,10],[9,10],[9,11],[11,13],[10,12],[12,14],[0,5],[0,6]];
const ANCHORS = {pelvis:[9,10],chest:[5,6],nose:[0],left_wrist:[62],right_wrist:[41]};
let project, history = [], currentMs = 0, dragging = null, bounds = [0, 1], videoURL;
let comparisonRevision=0, comparisonCache=null;
let orbit = {yaw: .2, pitch: -.1, zoom: 1};
const status = message => { $("status").textContent = message; };
function record() { history.push(JSON.stringify({scripts:project.scripts, config:project.config,references:project.references})); if(history.length>40)history.shift(); $("undo").disabled=false; }
function dirty() { project.manual_edits = true; ++comparisonRevision; delete project.reference_comparison; status("Unsaved edits · download the project to keep them"); }
function install(data) {
    if (data.schema !== "sam3d-funscript/1" || !data.scripts || !data.times_ms?.length) throw new Error("Unsupported project file");
    video.pause(); video.removeAttribute("src"); video.load();
    if(videoURL){URL.revokeObjectURL(videoURL);videoURL=null;}
    project = data; history=[]; ++comparisonRevision; $("undo").disabled=true;
    $("axis").replaceChildren(...Object.keys(data.scripts).map(axis => new Option(axis + " · " + ({L0:"stroke",L1:"surge",L2:"sway",R0:"twist",R1:"roll",R2:"pitch"}[axis]), axis)));
    $("name").textContent = data.metadata.source.path.split("/").at(-1);
    $("warnings").replaceChildren(...(data.warnings||[]).map(text=>{const li=document.createElement("li");li.textContent=text;return li;}));
    $("provenance").textContent = JSON.stringify({source:data.metadata.source,model:data.metadata.model,samples:data.times_ms.length,basis:data.metadata.basis,config:data.config},null,2);
    currentMs=data.times_ms[0]; controls(); render(); status("Project loaded · choose the matching source video");
}
function controls() {
    const axis=$("axis").value, s=project.config.axis_settings[axis];
    $("component").value=s.component; $("range").value=s.range; $("center").value=s.center; $("invert").checked=s.invert;
    $("unit").textContent=axis.startsWith("R")?"degrees":"metres";
    const ref=project.references?.[axis];$("referenceOffset").disabled=!ref;$("referenceOffset").value=ref?.offset_ms||0;
}
function resize(canvas) {
    const rect=canvas.getBoundingClientRect(), dpr=devicePixelRatio||1;
    const w=Math.max(1,Math.round(rect.width*dpr)),h=Math.max(1,Math.round(rect.height*dpr));
    if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}
    const ctx=canvas.getContext("2d");ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,rect.width,rect.height);
    return [ctx,rect.width,rect.height];
}
function sampleIndex() {
    let low=0,high=project.times_ms.length-1;
    while(high-low>1){const mid=(low+high)>>1;if(project.times_ms[mid]<=currentMs)low=mid;else high=mid;}
    return Math.abs(project.times_ms[low]-currentMs)<Math.abs(project.times_ms[high]-currentMs)?low:high;
}
const finitePoint = point => point && point.every(Number.isFinite);
function line(ctx,a,b,color,width=2) {ctx.strokeStyle=color;ctx.lineWidth=width;ctx.beginPath();ctx.moveTo(...a);ctx.lineTo(...b);ctx.stroke();}
function drawOverlay(index) {
    const [ctx,w,h]=resize($("overlay"));
    const [ih,iw]=project.metadata.image_size;
    const scale=Math.min(w/iw,h/ih),ox=(w-iw*scale)/2,oy=(h-ih*scale)/2;
    (project.pixels?.[index]||[]).forEach((person,slot)=>{
        for(const [a,b] of EDGES) if(finitePoint(person[a])&&finitePoint(person[b])) line(ctx,[person[a][0]*scale+ox,person[a][1]*scale+oy],[person[b][0]*scale+ox,person[b][1]*scale+oy],COLORS[slot%COLORS.length]);
        const roi=project.metadata.rois?.[slot];
        if(roi){ctx.strokeStyle=COLORS[slot%COLORS.length];ctx.strokeRect(ox+roi[0]*iw*scale,oy+roi[1]*ih*scale,roi[2]*iw*scale,roi[3]*ih*scale);ctx.fillStyle=ctx.strokeStyle;ctx.fillText(`ROI ${slot}`,ox+roi[0]*iw*scale+6,oy+roi[1]*ih*scale+15);}
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
function drawSkeleton(index) {
    const [ctx,w,h]=resize($("skeleton"));
    const people=project.points?.[index]||[], target=people[project.config.target_person];
    if(!target||!finitePoint(target[9])||!finitePoint(target[10]))return;
    const center=target[9].map((v,i)=>(v+target[10][i])/2);
    const map=point=>project3([point[0]-center[0],-(point[1]-center[1]),-(point[2]-center[2])],w,h,Math.min(w,h)*.6*orbit.zoom);
    people.forEach((person,slot)=>{for(const [a,b]of EDGES)if(finitePoint(person[a])&&finitePoint(person[b]))line(ctx,map(person[a]),map(person[b]),COLORS[slot%COLORS.length],3);});
    const selected=(project.anchor_indices?.target||ANCHORS[project.config.target_anchor]).map(j=>target[j]);
    if(selected.every(finitePoint)){const p=selected[0].map((_,i)=>selected.reduce((n,v)=>n+v[i],0)/selected.length);ctx.fillStyle="#eabf71";ctx.beginPath();ctx.arc(...map(p),6,0,Math.PI*2);ctx.fill();}
    const origin=map(center);[[[.25,0,0],"#e89393"],[[0,-.25,0],"#8fd399"],[[0,0,-.25],"#8eb7f7"]].forEach(([p,c])=>line(ctx,origin,map(center.map((v,i)=>v+p[i])),c));
}
function drawRobot() {
    const [ctx,w,h]=resize($("robot"));
    const values=Object.fromEntries(AXES.map(a=>[a,evaluate(project.scripts[a]?.actions,currentMs)]));
    $("readouts").replaceChildren(...AXES.map(a=>{const el=document.createElement("span");el.textContent=`${a} ${values[a].toFixed(1)}${project.scripts[a]?"":" (off)"}`;return el;}));
    const n=a=>(values[a]-50)/50, translate=[-n("L2")*.35,n("L0")*.5+.6,n("L1")*.35];
    const transform=p=>{
        let [x,y,z]=p,rx=-n("R2")*.5,ry=n("R0")*.5,rz=n("R1")*.5;
        [y,z]=[y*Math.cos(rx)-z*Math.sin(rx),y*Math.sin(rx)+z*Math.cos(rx)];
        [x,z]=[x*Math.cos(ry)+z*Math.sin(ry),-x*Math.sin(ry)+z*Math.cos(ry)];
        [x,y]=[x*Math.cos(rz)-y*Math.sin(rz),x*Math.sin(rz)+y*Math.cos(rz)];
        return [x+translate[0],y+translate[1]-.3,z+translate[2]];
    };
    const map=p=>[w/2+(p[0]-.55*p[2])*w*.37,h*.64-(p[1]+.3*p[2])*h*.62];
    const base=[],top=[];
    for(let i=0;i<6;i++){const a=i*Math.PI/3;base.push([Math.cos(a)*.7,-.3,Math.sin(a)*.7]);top.push(transform([Math.cos(a)*.38,0,Math.sin(a)*.38]));}
    for(let i=0;i<6;i++){line(ctx,map(base[i]),map(base[(i+1)%6]),"#486076");line(ctx,map(base[i]),map(top[i]),"#72919d",3);line(ctx,map(top[i]),map(top[(i+1)%6]),"#75e2ba",3);}
    line(ctx,map(transform([0,0,0])),map(transform([0,.35,0])),"#eabf71",4);
}
function drawCurve() {
    const [ctx,w,h]=resize($("curve")), axis=$("axis").value;
    const duration=project.metadata.duration_ms, zoom=Number($("zoom").value);
    if(!dragging){const span=zoom?Math.min(zoom,duration):duration;const left=Math.max(0,Math.min(duration-span,currentMs-span/2));bounds=[left,left+span];}
    const x=t=>42+(t-bounds[0])/(bounds[1]-bounds[0])*(w-54),y=p=>h-25-p/100*(h-40);
    ctx.font="11px system-ui";ctx.fillStyle="#8197ab";
    for(const p of [0,25,50,75,100]){line(ctx,[42,y(p)],[w-12,y(p)],"#2a3c4c",1);ctx.fillText(p,9,y(p)+4);}
    for(let i=0;i<=5;i++){const t=bounds[0]+(bounds[1]-bounds[0])*i/5;ctx.fillText((t/1000).toFixed(1)+"s",x(t)-12,h-6);}
    for(let i=0;i<project.times_ms.length;i++)if(!project.valid[i]||(i&&project.segments[i]!==project.segments[i-1])){
        ctx.fillStyle="#8c593b66";ctx.fillRect(x(project.times_ms[i]),15,Math.max(2,x(project.times_ms[i+1]||project.times_ms[i]+10)-x(project.times_ms[i])),h-40);
    }
    const s=project.config.axis_settings[axis],c=s.component+(axis.startsWith("R")?3:0);
    for(const [key,color]of [["raw","#607689"],["processed","#bb9457"]]){
        ctx.strokeStyle=color;ctx.lineWidth=1;ctx.beginPath();let pen=false;
        project[key].forEach((row,i)=>{if(!project.valid[i]||!Number.isFinite(row[c])){pen=false;return;}const px=x(project.times_ms[i]),py=y(Math.max(0,Math.min(100,s.center+row[c]/s.range*100*(s.invert?-1:1))));if(i&&project.segments[i]!==project.segments[i-1])pen=false;if(pen)ctx.lineTo(px,py);else ctx.moveTo(px,py);pen=true;});ctx.stroke();
    }
    const actions=project.scripts[axis].actions;
    ctx.save();ctx.beginPath();ctx.rect(42,10,w-54,h-30);ctx.clip();ctx.strokeStyle="#75e2ba";ctx.lineWidth=2;ctx.beginPath();actions.forEach((a,i)=>i?ctx.lineTo(x(a.at),y(a.pos)):ctx.moveTo(x(a.at),y(a.pos)));ctx.stroke();
    ctx.fillStyle="#75e2ba";for(const a of actions){if(a.at<bounds[0]||a.at>bounds[1])continue;ctx.beginPath();ctx.arc(x(a.at),y(a.pos),3,0,Math.PI*2);ctx.fill();}line(ctx,[x(currentMs),10],[x(currentMs),h-25],"#f0f5fa",1);ctx.restore();
    const ref=project.references?.[axis];
    if(ref){
        const shift=ref.offset_ms||0,lo=Math.max(bounds[0],ref.actions[0].at+shift),hi=Math.min(bounds[1],ref.actions.at(-1).at+shift);
        if(hi>=lo){ctx.strokeStyle="#dcadfa";ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(x(lo),y(evaluate(ref.actions,lo-shift)));for(const a of ref.actions)if(a.at+shift>lo&&a.at+shift<hi)ctx.lineTo(x(a.at+shift),y(a.pos));ctx.lineTo(x(hi),y(evaluate(ref.actions,hi-shift)));ctx.stroke();}
        if(!comparisonCache||comparisonCache.axis!==axis||comparisonCache.revision!==comparisonRevision){comparisonCache={axis,revision:comparisonRevision,value:referenceAgreement(actions,ref,project.times_ms[0],project.times_ms.at(-1))};}
        const m=comparisonCache.value;
        $("referenceMetrics").textContent=m?`Reference agreement · MAE ${m.mae.toFixed(1)} / 100 · RMSE ${m.rmse.toFixed(1)} · correlation ${m.correlation===null?"undefined":m.correlation.toFixed(3)} · full overlap`:'Reference does not overlap this analysis';
    }else $("referenceMetrics").textContent="No reference loaded for this axis";
    const mapped=project.processed.filter((row,i)=>project.valid[i]&&Number.isFinite(row[c])).map(row=>s.center+row[c]/s.range*100*(s.invert?-1:1));
    const clipped=mapped.length?mapped.filter(v=>v<0||v>100).length/mapped.length*100:0;
    $("metrics").textContent=`${actions.length} actions · ${evaluate(actions,currentMs).toFixed(1)} / 100 · ${clipped.toFixed(1)}% source clipping`;
}
function render() {
    if(!project)return;
    $("time").textContent=(currentMs/1000).toFixed(3)+" s";
    const i=sampleIndex(),available=project.valid[i]&&currentMs>=project.times_ms[0]&&currentMs<=project.metadata.duration_ms&&Math.abs(currentMs-project.times_ms[i])<=project.config.max_gap_ms;
    if(available){drawOverlay(i);drawSkeleton(i);}
    else for(const name of ["overlay","skeleton"]){const[ctx,w,h]=resize($(name));ctx.fillStyle="#eabf71";ctx.font="13px system-ui";ctx.fillText("No analysed pose at this time",12,h/2);}
    drawRobot();drawCurve();
}
function frameCallback(_,metadata){currentMs=metadata.mediaTime*1000;render();video.requestVideoFrameCallback(frameCallback);}
if(video.requestVideoFrameCallback)video.requestVideoFrameCallback(frameCallback);
video.addEventListener("timeupdate",()=>{if(!video.requestVideoFrameCallback||video.paused){currentMs=video.currentTime*1000;render();}});
video.addEventListener("seeked",()=>{currentMs=video.currentTime*1000;render();});
video.addEventListener("error",()=>status("Choose the source video locally if this browser cannot load the server copy"));
$("axis").addEventListener("change",()=>{controls();render();});$("zoom").addEventListener("change",render);
$("rebuild").addEventListener("click",()=>{
    if(!project)return;const range=Number($("range").value),center=Number($("center").value);
    if(!Number.isFinite(range)||range<=0||!Number.isFinite(center)||center<0||center>100){status("Range must be positive; center must be between 0 and 100");return;}
    record();const axis=$("axis").value;project.config.axis_settings[axis]={range,center,invert:$("invert").checked,component:Number($("component").value)};
    project.scripts[axis]=rebuildAxis(project,axis);dirty();render();
});
$("undo").addEventListener("click",()=>{if(!history.length)return;const old=JSON.parse(history.pop());project.scripts=old.scripts;project.config=old.config;project.references=old.references;$("undo").disabled=!history.length;controls();dirty();render();});
function pointer(event){const rect=$("curve").getBoundingClientRect();return {at:roundEven(Math.max(0,Math.min(project.metadata.duration_ms,bounds[0]+(event.clientX-rect.left-42)/(rect.width-54)*(bounds[1]-bounds[0])))),pos:roundEven(Math.max(0,Math.min(100,(rect.height-25-(event.clientY-rect.top))/(rect.height-40)*100)))};}
function nearest(event){const a=pointer(event),rect=$("curve").getBoundingClientRect();return project.scripts[$("axis").value].actions.findIndex(p=>Math.hypot((p.at-a.at)/(bounds[1]-bounds[0])*(rect.width-54),(p.pos-a.pos)/100*(rect.height-40))<9);}
$("curve").addEventListener("pointerdown",event=>{if(!project||event.button!==0)return;const index=nearest(event);if(index>=0){record();dragging=index;$("curve").setPointerCapture(event.pointerId);}else{currentMs=pointer(event).at;video.currentTime=currentMs/1000;render();}});
$("curve").addEventListener("pointermove",event=>{if(dragging===null)return;const actions=project.scripts[$("axis").value].actions,p=pointer(event),i=dragging;const min=i?actions[i-1].at+1:0,max=i+1<actions.length?actions[i+1].at-1:roundEven(project.metadata.duration_ms);actions[i]={at:Math.max(min,Math.min(max,p.at)),pos:p.pos};dirty();render();});
const release=()=>{dragging=null;render();};$("curve").addEventListener("pointerup",release);$("curve").addEventListener("pointercancel",release);
$("curve").addEventListener("dblclick",event=>{if(!project)return;const actions=project.scripts[$("axis").value].actions,p=pointer(event);if(actions.some(a=>a.at===p.at))return;record();actions.push(p);actions.sort((a,b)=>a.at-b.at);dirty();render();});
$("curve").addEventListener("contextmenu",event=>{event.preventDefault();if(!project)return;const i=nearest(event),actions=project.scripts[$("axis").value].actions;if(i>=0&&actions.length>1){record();actions.splice(i,1);dirty();render();}});
let lastOrbit;
$("skeleton").addEventListener("pointerdown",e=>{lastOrbit=[e.clientX,e.clientY];$("skeleton").setPointerCapture(e.pointerId);});
$("skeleton").addEventListener("pointermove",e=>{if(!lastOrbit)return;orbit.yaw+=(e.clientX-lastOrbit[0])*.01;orbit.pitch+=(e.clientY-lastOrbit[1])*.01;lastOrbit=[e.clientX,e.clientY];render();});
$("skeleton").addEventListener("pointerup",()=>lastOrbit=null);$("skeleton").addEventListener("pointercancel",()=>lastOrbit=null);
$("skeleton").addEventListener("wheel",e=>{e.preventDefault();orbit.zoom=Math.max(.1,Math.min(5,orbit.zoom*Math.exp(-e.deltaY*.001)));render();},{passive:false});
$("projectFile").addEventListener("change",async e=>{try{install(JSON.parse(await e.target.files[0].text()));}catch(error){status(error.message);}});
$("videoFile").addEventListener("change",e=>{if(videoURL)URL.revokeObjectURL(videoURL);videoURL=URL.createObjectURL(e.target.files[0]);video.src=videoURL;status("Local source loaded");});
$("referenceFile").addEventListener("change",async e=>{if(!project){status("Open a project first");return;}try{const file=e.target.files[0],data=JSON.parse(await file.text()),actions=validateReference(data);record();project.references={...project.references,[$("axis").value]:{actions,offset_ms:0,source:{path:file.name},header_inverted:!!data.inverted,interpretation:"Positions compared as written; legacy headers not applied"}};dirty();controls();render();}catch(error){status(error.message);}});
$("referenceOffset").addEventListener("change",()=>{const ref=project?.references?.[$("axis").value],offset=Number($("referenceOffset").value);if(!ref||!Number.isFinite(offset))return;record();ref.offset_ms=offset;dirty();render();});
$("save").addEventListener("click",()=>{if(!project)return;const stem=project.metadata.source.path.split("/").at(-1).replace(/\.[^.]+$/,"");const files={"project.json":JSON.stringify(project)};for(const [axis,script]of Object.entries(project.scripts))files[stem+SUFFIX[axis]+".funscript"]=JSON.stringify(script);const url=URL.createObjectURL(makeZip(files)),a=document.createElement("a");a.href=url;a.download=stem+"-motion.zip";a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);status("Download created · import project.json with Load Funscript Project to re-export in ComfyUI");});
new ResizeObserver(render).observe(document.body);
const id=new URLSearchParams(location.search).get("project");
if(id){try{const response=await fetch(`../projects/${encodeURIComponent(id)}`);if(!response.ok)throw new Error(`Project load failed (${response.status})`);install(await response.json());video.src=`../video/${encodeURIComponent(id)}`;}catch(error){status(error.message);}}
