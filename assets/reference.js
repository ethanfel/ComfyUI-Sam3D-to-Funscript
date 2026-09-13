import {correctedTransforms,transformBounds} from './video-preview.mjs?v=stabilization-auto-1';
import {workflowHost} from "./workflow-host.mjs";
import {correctedMotion,curveBuckets,referenceKeys,withReferenceKeys,validateReferenceKeys,addReferenceKey,putReferencePoint,removeReferencePoint,requireReferenceBackend} from "./reference-edit.mjs?v=reference-keys-1";

const $=id=>document.getElementById(id),video=$("source"),params=new URLSearchParams(location.search),node=params.get("node"),base=new URL("../reference/",location.href);
let project,config,index=0,dirty=false,history=[],motion=null,sourceMap=null,drag=null,playing=false,pendingProject=null,applyPending=null,extent=[0,0],timelineLOD=null;
let tracking=false,trackPending=null,indexedTimes=[];
const clone=x=>structuredClone(x),same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
// randomUUID is unavailable on plain HTTP LAN origins; getRandomValues still works.
const newId=()=>globalThis.crypto.randomUUID?.()||Array.from(crypto.getRandomValues(new Uint8Array(16)),v=>v.toString(16).padStart(2,"0")).join("");
function status(text){$("status").textContent=text}
function fail(error){$("error").textContent=error.message||String(error)}
function applyFeedback(state,text=""){
    const button=$("apply");button.dataset.state=state;button.disabled=state==="applying";
    button.setAttribute("aria-busy",String(state==="applying"));
    button.textContent=({applying:"Applying…",applied:"✓ Applied",unchanged:"No changes",error:"Apply failed · Retry"})[state]||"Apply to node";
    $("applyStatus").textContent=text;$("applyStatus").dataset.state=state;
}
function pendingFeedback(){if(!applyPending)applyFeedback("pending","Unapplied edits")}
function snapshot(){history.push(clone(config));if(history.length>100)history.shift();dirty=true;pendingFeedback();status("Unapplied edits · click Track to update the video")}
function times(){return project?.data?.times_ms||(indexedTimes.length?indexedTimes:[0])}
function sourceTime(i){
    if(project.data)return Number(project.data.source_pts[i].split("/").reduce((a,b)=>a/Number(b)));
    const origin=String(project.info.source_origin).split('/').reduce((a,b)=>Number(a)/Number(b));
    return project.frame_index?Number(origin)+project.frame_index.times_ms[i]/1000:project.first_source_ms/1000;
}
function nearest(values,t){let lo=0,hi=values.length-1;while(lo<hi){const mid=(lo+hi)>>1;if(values[mid]<t)lo=mid+1;else hi=mid}return lo>0&&Math.abs(values[lo-1]-t)<Math.abs(values[lo]-t)?lo-1:lo}
function pause(){playing=false;video.pause();$("play").textContent="Play"}
function seek(i){pause();index=Math.max(0,Math.min(times().length-1,i));video.currentTime=sourceTime(index);reveal();renderReferenceKeys();draw()}
function view(){const end=times().at(-1)||1,span=Math.min(end,(Number($("view").value)||end/1000)*1000);$("pan").max=(end-span)/1000;const start=Math.min(Number($("pan").value)*1000,end-span);return [start,start+span]}
function reveal(){const [a,b]=view(),t=times()[index];if(t<a||t>b)$("pan").value=Math.max(0,t-(b-a)/2)/1000}
function activeSection(){return config.sections.find(s=>s.id===$("section").value)}
function renderReferenceKeys(){
    if(!config)return;
    const keys=referenceKeys(config),key=keys.find(k=>k.frame===index),expected=Math.max(...keys.map(k=>k.points.length));
    $("referenceKeyframes").replaceChildren(new Option('Reference frames…',''),...keys.map(k=>new Option(`Frame ${k.frame} · ${k.points.length} points`,String(k.frame))));
    $("referenceKeyframes").value=key?String(index):'';
    $("referencePoint").replaceChildren(...Array.from({length:key?Math.max(expected,key.points.length+(keys.length===1?1:0)):expected},(_,i)=>new Option(`Point ${i+1}${i>=(key?.points.length||0)?' · place':''}`,String(i))));
    $("referencePoint").value=String(key?Math.min(key.points.length,keys.length===1?key.points.length:Math.max(0,expected-1)):0);
    $("pointCount").textContent=`${key?.points.length||0} points on this frame · ${keys.filter(k=>k.points.length).length} marked frames`;
    $("removeReferenceKey").disabled=!key||tracking;
}
$("markReference").onclick=()=>{pause();snapshot();config=addReferenceKey(config,index);$("mode").value='points';rebuild()};
$("removeReferenceKey").onclick=()=>{snapshot();config=withReferenceKeys(config,referenceKeys(config).filter(k=>k.frame!==index));rebuild()};
$("referenceKeyframes").onchange=()=>{if($("referenceKeyframes").value!=='')seek(Number($("referenceKeyframes").value))};
$("transformMode").onchange=()=>{snapshot();config.transform_mode=$("transformMode").value;rebuild()};
$("trackingMode").onchange=()=>{snapshot();config.tracking_mode=$("trackingMode").value;rebuild()};
function rebuild(){
    $("error").textContent="";motion=null;
    timelineLOD=null;
    if(project.data){
        try{motion=correctedMotion(times(),project.data.auto_shift_xy,project.data.reasons.map(r=>["consensus","reference_keyframe"].includes(r)),project.data.anchor_xy,config.sections)}catch(error){fail(error)}
    }
    extent=[0,0];for(const p of motion?.shifts||[])for(let j=0;j<2;j++)extent[j]=Math.max(extent[j],Math.abs(p[j]));
    if(motion){
        for(const key of referenceKeys(project.config))if(project.data.reasons[key.frame]==="reference_keyframe")motion.quality[key.frame]="manual";
        motion.transforms=correctedTransforms(project.data,motion.shifts);
        motion.bounds=transformBounds(project.info.width,project.info.height,motion.transforms);
        motion.counts={tracked:0,manual:0,held:0};motion.quality.forEach(q=>motion.counts[q]++);
    }
    const before=$("section").value;$("section").replaceChildren();
    for(const [i,s] of config.sections.entries()){const o=document.createElement("option");o.value=s.id;o.textContent=s.name||`Section ${i+1}`;$("section").append(o)}
    if(config.sections.some(s=>s.id===before))$("section").value=before;
    $("seek").max=times().length-1;renderReferenceKeys();$("trackingMode").value=config.tracking_mode||"online";$("transformMode").value=config.transform_mode||"translation";
    $("track").disabled=tracking;
    $("play").disabled=times().length<2;$("previous").disabled=times().length<2;$("next").disabled=times().length<2;
    for(const id of ["newSection","estimate","removeSection"])$(id).disabled=!project.data;
    $("undo").disabled=!history.length;$("downloadVideo").hidden=!project.video;
    if(project.video){$("downloadVideo").href=new URL(project.id+"/video/stabilized",base);$("downloadVideo").download="stabilized.mp4"}
    renderKeys();draw();
}
function renderKeys(){
    $("keys").replaceChildren();const section=activeSection();
    for(const key of [...(section?.keys||[])].sort((a,b)=>a.at_ms-b.at_ms)){
        const row=document.createElement("div");row.className="keys";
        const button=document.createElement("button");button.textContent=(key.at_ms/1000).toFixed(3)+" s";button.onclick=()=>seek(nearest(times(),key.at_ms));
        const label=document.createElement("span");label.textContent=`X ${key.xy[0].toFixed(1)} · Y ${key.xy[1].toFixed(1)}`;
        const remove=document.createElement("button");remove.textContent="Delete key";remove.onclick=()=>{snapshot();section.keys=section.keys.filter(k=>k!==key);rebuild()};row.append(button,label,remove);$("keys").append(row);
    }
}
function addSection(){snapshot();const section={id:newId(),name:`Section ${config.sections.length+1}`,keys:[]};config.sections.push(section);rebuild();$("section").value=section.id;renderKeys();return section}
function addKey(xy){
    if(!project.data)return;
    let section=activeSection();if(!section)section=addSection();
    snapshot();const at=times()[index];section.keys=section.keys.filter(k=>Math.abs(k.at_ms-at)>.001);section.keys.push({at_ms:at,xy});rebuild();
}
function prepare(canvas){const r=canvas.getBoundingClientRect(),d=devicePixelRatio||1;const w=Math.round(r.width*d),h=Math.round(r.height*d);if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h}const ctx=canvas.getContext("2d");ctx.setTransform(d,0,0,d,0,0);ctx.clearRect(0,0,r.width,r.height);return [ctx,r.width,r.height]}
function draw(){
    if(!project||!config)return;
    const t=times()[index]||0;$("seek").value=index;$("time").textContent=`${(t/1000).toFixed(3)} s · source ${sourceTime(index).toFixed(3)} s · frame ${index} · ${times().length} frames`;
    const [ctx,w,h]=prepare($("sourceCanvas"));
    const crop=$("zoom").checked&&$("mode").value!=="crop"?config.crop_xywh:[0,0,project.info.width,project.info.height];
    const scale=Math.min(w/crop[2],h/crop[3]),ox=(w-crop[2]*scale)/2,oy=(h-crop[3]*scale)/2;
    sourceMap={crop,scale,ox,oy};
    if(video.readyState>=2)ctx.drawImage(video,...crop,ox,oy,crop[2]*scale,crop[3]*scale);
    const point=(p)=>[ox+(p[0]-crop[0])*scale,oy+(p[1]-crop[1])*scale];
    const [cx,cy]=point(config.crop_xywh),[cw,ch]=config.crop_xywh.slice(2);ctx.strokeStyle="#75ddb4";ctx.lineWidth=1.5;ctx.strokeRect(cx,cy,cw*scale,ch*scale);
    const stale=project.data&&(!same(referenceKeys(config),referenceKeys(project.config))||!same(config.crop_xywh,project.config.crop_xywh)||config.tracking_mode!==project.config.tracking_mode||config.transform_mode!==project.config.transform_mode);
    const points=project.data&&!stale&&$("mode").value!=="points"?project.data.points[index]:(referenceKeys(config).find(k=>k.frame===index)?.points||[]);
    points.forEach((p,i)=>{const [x,y]=point(p);ctx.strokeStyle=project.data&&!stale&&$("mode").value!=="points"&&!project.data.visible[index][i]?"#ff986f":"#8becc6";ctx.beginPath();ctx.arc(x,y,5,0,Math.PI*2);ctx.stroke();ctx.fillStyle=ctx.strokeStyle;ctx.fillText(i+1,x+7,y-6)});
    if(motion){const p=project.data.anchor_xy.map((v,j)=>v+motion.shifts[index][j]),[x,y]=point(p);ctx.strokeStyle="#ffe296";ctx.beginPath();ctx.moveTo(x-10,y);ctx.lineTo(x+10,y);ctx.moveTo(x,y-10);ctx.lineTo(x,y+10);ctx.stroke()}
    if(drag){const a=point(drag.start),b=point(drag.end);ctx.strokeStyle="#b6ccff";ctx.strokeRect(a[0],a[1],b[0]-a[0],b[1]-a[1])}
    drawPreview();drawTimeline();
    if(motion){const counts=motion.counts;$("metrics").textContent=`${counts.tracked} tracked · ${counts.manual} corrected · ${counts.held} held / ${times().length} frames · current: ${motion.quality[index]}${motion.quality[index]==="held"?" ("+project.data.reasons[index].replaceAll("_"," ")+")":""}${stale?" · Reference settings changed: track to update correction":""}`}
    else $("metrics").textContent="Select at least three points on the same reference surface. Right-click a starting point to remove it.";
}
function drawPreview(){
    const [ctx,w,h]=prepare($("previewCanvas"));if(video.readyState<2)return;
    const {padding:pad,size}=motion?.bounds||transformBounds(project.info.width,project.info.height,[[[1,0,0],[0,1,0]]]);
    const s=Math.min(w/size[0],h/size[1]),x=(w-size[0]*s)/2,y=(h-size[1]*s)/2;
    const [[a,b,tx],[c,d,ty]]=motion?.transforms?.[index]||[[1,0,0],[0,1,0]];
    ctx.save();ctx.transform(a*s,c*s,b*s,d*s,x+(pad[0]+tx)*s,y+(pad[1]+ty)*s);
    ctx.drawImage(video,0,0,project.info.width,project.info.height);ctx.restore();
    if(project.data){const a=project.data.anchor_xy,px=x+(a[0]+pad[0])*s,py=y+(a[1]+pad[1])*s;ctx.strokeStyle="#ffe296";ctx.beginPath();ctx.moveTo(px-12,py);ctx.lineTo(px+12,py);ctx.moveTo(px,py-12);ctx.lineTo(px,py+12);ctx.stroke()}
}
function drawTimeline(){
    const [ctx,w,h]=prepare($("timeline"));if(!project)return;
    const ts=times(),[a,b]=view(),span=Math.max(1,b-a),x=t=>18+(w-36)*(t-a)/span,max=Math.max(1,extent[0],extent[1]),y=v=>h/2-v/max*(h/2-16),count=Math.max(1,Math.floor(w-36));
    if(motion&&(!timelineLOD||timelineLOD.width!==w||timelineLOD.a!==a||timelineLOD.b!==b)){
        const bins=curveBuckets(ts,motion.shifts,motion.quality,a,b,count);
        timelineLOD={width:w,a,b,bins};
    }
    const bins=timelineLOD?.bins||[];bins.forEach((bucket,i)=>{if(bucket.quality){ctx.fillStyle=bucket.quality===1?"#a08ad23b":"#d786363b";ctx.fillRect(18+i,0,1.1,h)}});
    ctx.lineWidth=1.4;for(let axis=0;axis<2;axis++){ctx.strokeStyle=axis?"#7ddbb3":"#93c6ff";ctx.beginPath();let started=false;bins.forEach((bucket,i)=>{if(!Number.isFinite(bucket.min[axis]))return;const xx=18+i;started?ctx.lineTo(xx,y(bucket.min[axis])):ctx.moveTo(xx,y(bucket.min[axis]));ctx.lineTo(xx,y(bucket.max[axis]));started=true});ctx.stroke()}
    ctx.strokeStyle="#ffffff";ctx.beginPath();ctx.moveTo(x(ts[index]),0);ctx.lineTo(x(ts[index]),h);ctx.stroke();ctx.fillStyle="#bacee0";ctx.fillText(`±${max.toFixed(0)} px · ${(a/1000).toFixed(2)}–${(b/1000).toFixed(2)} s`,20,14);
    for(const key of referenceKeys(config))if(key.points.length&&ts[key.frame]>=a&&ts[key.frame]<=b){
        const px=x(ts[key.frame]);ctx.fillStyle='#f5cf81';ctx.beginPath();ctx.moveTo(px,24);ctx.lineTo(px+5,30);ctx.lineTo(px,36);ctx.lineTo(px-5,30);ctx.fill();ctx.fillText(`F ${key.frame}`,px+8,34);
    }
}
function position(event){const r=$("sourceCanvas").getBoundingClientRect(),m=sourceMap,x=(event.clientX-r.left-m.ox)/m.scale+m.crop[0],y=(event.clientY-r.top-m.oy)/m.scale+m.crop[1];if(x<m.crop[0]||y<m.crop[1]||x>m.crop[0]+m.crop[2]||y>m.crop[1]+m.crop[3])return null;return [Math.max(0,Math.min(project.info.width-1,x)),Math.max(0,Math.min(project.info.height-1,y))]}
$("sourceCanvas").onpointerdown=e=>{if(e.button!==0||video.seeking||!video.paused)return;const p=position(e);if(!p)return;
    if($("mode").value==="crop"){drag={start:p,end:p};$("sourceCanvas").setPointerCapture(e.pointerId)}
    else if($("mode").value==="points"){try{const next=putReferencePoint(config,index,Number($("referencePoint").value),p);snapshot();config=next;rebuild()}catch(error){fail(error)}}
    else if($("mode").value==="correct")addKey(p);
};
$("sourceCanvas").onpointermove=e=>{if(drag){const p=position(e);if(p)drag.end=p;draw()}};
$("sourceCanvas").onpointerup=()=>{if(!drag)return;const a=drag.start,b=drag.end;drag=null;const crop=[Math.floor(Math.min(a[0],b[0])),Math.floor(Math.min(a[1],b[1])),Math.round(Math.abs(a[0]-b[0])),Math.round(Math.abs(a[1]-b[1]))];if(crop[2]>1&&crop[3]>1){snapshot();config.crop_xywh=crop;rebuild()}else draw()};
$("sourceCanvas").onpointercancel=()=>{drag=null;draw()};
$("sourceCanvas").oncontextmenu=e=>{
    e.preventDefault();if($("mode").value!=="points")return;
    const p=position(e),key=referenceKeys(config).find(k=>k.frame===index);if(!p||!key)return;
    let best=-1,distance=12/sourceMap.scale;
    key.points.forEach((v,i)=>{const d=Math.hypot(v[0]-p[0],v[1]-p[1]);if(d<distance){best=i;distance=d}});
    if(best>=0){snapshot();config=removeReferencePoint(config,best);rebuild()}
};
$("mode").onchange=()=>{if($("mode").value==="points"&&!referenceKeys(config).some(k=>k.frame===index))seek(referenceKeys(config)[0].frame);if($("mode").value==="correct"&&!project.data){$("mode").value="seek";status("Track reference points before correcting sections")}draw()};
$("zoom").onchange=draw;$("clearPoints").onclick=()=>{snapshot();config=withReferenceKeys(config,[{frame:index,points:[]}]);rebuild()};
$("newSection").onclick=()=>{addSection();$("mode").value="correct"};$("section").onchange=renderKeys;
$("removeSection").onclick=()=>{const s=activeSection();if(s){snapshot();config.sections=config.sections.filter(v=>v!==s);rebuild()}};
$("estimate").onclick=()=>{if(motion)addKey(project.data.anchor_xy.map((v,j)=>v+motion.shifts[index][j]))};
$("undo").onclick=()=>{if(history.length){config=history.pop();dirty=true;pendingFeedback();rebuild();status("Undo applied · Apply to node to keep it")}};
$("seek").oninput=()=>seek(Number($("seek").value));$("previous").onclick=()=>seek(index-1);$("next").onclick=()=>seek(index+1);
$("play").onclick=async()=>{if(playing){pause();return}if(index>=times().length-1)seek(0);try{await video.play();playing=true;$("play").textContent="Pause"}catch(e){fail(e)}};
$("timeline").onclick=e=>{if(times().length<2)return;const r=$("timeline").getBoundingClientRect(),f=Math.max(0,Math.min(1,(e.clientX-r.left-18)/(r.width-36))),[a,b]=view();seek(nearest(times(),a+f*(b-a)))};
$("view").onchange=()=>{reveal();draw()};$("pan").oninput=draw;$("go").onclick=()=>seek(nearest(times(),Number($("goTime").value)*1000));
function gap(direction){if(!motion)return;let i=index+direction;while(i>=0&&i<motion.quality.length){if(motion.quality[i]==="held"&&(i===0||motion.quality[i-1]!=="held")){seek(i);return}i+=direction}status(direction>0?"No later gap":"No earlier gap")}
$("nextGap").onclick=()=>gap(1);$("previousGap").onclick=()=>gap(-1);
video.onseeked=draw;video.onloadeddata=draw;video.onerror=()=>fail(new Error("Source video could not be loaded. Queue the node again to refresh its source."));
function tick(){if(playing&&times().length>1){const offset=sourceTime(0);index=nearest(times(),(video.currentTime-offset)*1000);if(video.currentTime>=sourceTime(times().length-1)){pause();index=times().length-1}reveal();draw()}requestAnimationFrame(tick)}requestAnimationFrame(tick);
function validate(){
    validateReferenceKeys(config,times().length);
    if(project.data)correctedMotion(times(),project.data.auto_shift_xy,project.data.reasons.map(r=>["consensus","reference_keyframe"].includes(r)),project.data.anchor_xy,config.sections);
}
function applyFailed(error){fail(error);applyFeedback("error",error.message||String(error));status("Settings were not applied")}
function finishApply(error){
    const p=applyPending;if(!p)return;clearTimeout(p.timeout);applyPending=null;
    if(error){applyFailed(error);p.reject(error);return}
    if(same(config,p.sent))dirty=false;
    $("error").textContent="";
    const text=dirty?"Earlier edits applied · new edits still pending":"Settings applied to node · click Track to update the video";
    applyFeedback(dirty?"pending":"applied",text);status(text);p.resolve();
}
window.s3fReferenceApply=()=>{
    if(applyPending)return applyPending.promise;
    if(!dirty){applyFeedback("unchanged","No new edits to apply");return Promise.resolve()}
    try{
        validate();
        if(!workflowHost()||workflowHost().closed)throw new Error("Open this editor from the node to apply settings, or download settings and paste them into reference_json.");
        const sent=clone(config),request=newId();let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});
        const timeout=setTimeout(()=>finishApply(new Error("ComfyUI did not acknowledge the settings. Keep this tab open and apply again.")),15000);
        applyPending={promise,request,sent,resolve,reject,timeout};
        $("error").textContent="";applyFeedback("applying","Waiting for ComfyUI to confirm…");
        const check=Promise.all([requireCorrectionBackend(sent),sent.keyframes||sent.tracking_mode==='offline'?requireReferenceBackend(location.href):Promise.resolve()]);
        check.then(()=>{if(applyPending?.request===request)workflowHost().postMessage({type:"s3f-reference-apply",node,reference:project.id,request,config:sent},location.origin)}).catch(finishApply);
        return promise;
    }catch(error){applyFailed(error);return Promise.reject(error)}
};
window.addEventListener("message",event=>{const p=applyPending;if(event.origin!==location.origin||event.source!==workflowHost()||!p||event.data?.type!=="s3f-reference-applied"||event.data.request!==p.request)return;finishApply(event.data.error?new Error(event.data.error):null)});
$("apply").onclick=()=>window.s3fReferenceApply().catch(fail);
window.s3fReferenceTrack=async()=>{
    if(tracking)return;
    tracking=true;$("track").disabled=true;$("track").textContent="Tracking…";$("error").textContent="";
    $("tracking").hidden=false;$("trackStatus").textContent="Applying reference settings…";$("trackProgress").removeAttribute("value");
    try{
        validate();
        await requireCorrectionBackend(config);
        if(config.keyframes||config.tracking_mode==='offline')await requireReferenceBackend(location.href);
        if(!workflowHost()||workflowHost().closed)throw new Error("Open the reference editor from its ComfyUI node to start tracking. Your settings can still be downloaded here.");
        await window.s3fReferenceApply();
        const request=newId();
        await new Promise((resolve,reject)=>{
            const timeout=setTimeout(()=>{trackPending=null;reject(new Error("ComfyUI did not acknowledge Track. Save the workflow, reload ComfyUI, and reopen this editor from its node."))},15000);
            trackPending={request,resolve,reject,timeout};
            workflowHost().postMessage({type:"s3f-reference-track",node,reference:project.id,request},location.origin);
        });
    }catch(error){fail(error);$("trackStatus").textContent="Tracking could not finish"}
    finally{if(trackPending)clearTimeout(trackPending.timeout);trackPending=null;tracking=false;$("track").disabled=false;$("track").textContent="Track"}
};
window.addEventListener("message",async event=>{
    const p=trackPending,data=event.data;
    if(event.origin!==location.origin||event.source!==workflowHost()||!p||data?.type!=="s3f-reference-tracking"||data.request!==p.request)return;
    clearTimeout(p.timeout);
    if(data.error){p.reject(new Error(data.error));return}
    if(data.text)$("trackStatus").textContent=data.text;
    if(data.max>0){$("trackProgress").max=data.max;$("trackProgress").value=data.value}
    if(data.state==="complete"){
        try{await window.s3fReferenceLoad(data.reference);$("trackProgress").max=1;$("trackProgress").value=1;p.resolve()}catch(error){p.reject(error)}
    }
});
$("track").onclick=()=>window.s3fReferenceTrack();
$("download").onclick=()=>{const blob=new Blob([JSON.stringify(config,null,2)],{type:"application/json"}),url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download="reference-settings.json";a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)};
window.s3fReferenceLoad=async(id,force=false)=>{
    const response=await fetch(new URL(id,base),{cache:"no-store"});if(!response.ok)throw new Error("Reference run is unavailable; queue the node again");
    const incoming=await response.json();
    if(!incoming.data&&!incoming.frame_index){
        const frames=await fetch(new URL(id+'/frames',base),{cache:'no-store'});
        if(frames.ok)incoming.frame_index=await frames.json();
    }
    if(dirty&&!force&&project?.info.source_id!==incoming.info.source_id){pendingProject=id;$("reload").hidden=false;status("Source changed. Download your current settings to keep them, or load the new source.");return}
    const retained=dirty&&!force?config:null;pause();project=incoming;config=retained||clone(project.config);if(!retained){history=[];dirty=false}index=0;pendingProject=null;$("reload").hidden=true;
    indexedTimes=(project.frame_index?.times_ms||[]).map(t=>t-project.frame_index.times_ms[0]);
    if(!applyPending)applyFeedback(dirty?"pending":"idle",dirty?"Unapplied edits":"");
    video.src=new URL(id+"/video/source",base);video.addEventListener("loadedmetadata",()=>{video.currentTime=sourceTime(0)},{once:true});
    const current=new URL(location.href);current.searchParams.set("reference",id);window.history.replaceState(null,"",current);
    $("help").textContent=project.data?"Review orange gaps. Correct each interval in a manual section, then click Track to update the video. Corrections reuse cached tracking. Run the workflow in ComfyUI when ready to extract poses.":"Draw a crop covering the reference movement. Choose a clear frame, click Mark reference frame, and place numbered points. Repeat on other frames, marking the same points in the same order, then Track.";
    status(retained?"New tracking loaded · unapplied edits preserved":project.source_changed?"Source changed · select points for this video":project.data?"Reference ready · "+(project.cache_hit?"tracking cache reused":"tracking complete"):"Select a crop and reference points");rebuild();
};
$("reload").onclick=()=>window.s3fReferenceLoad(pendingProject,true).catch(fail);
window.addEventListener("beforeunload",event=>{if(dirty){event.preventDefault();event.returnValue=""}});
new ResizeObserver(draw).observe($("sourceCanvas"));
if(params.get("reference"))window.s3fReferenceLoad(params.get("reference")).catch(fail);else status("Queue the Reference Stabilizer node once to load its source.");

window.s3fHasUnsavedEdits=()=>dirty||!!applyPending;
window.s3fPausePreview=pause;

async function requireCorrectionBackend(value){
    if(value.transform_mode!=='similarity')return;
    const response=await fetch(new URL('../reference-capabilities',location.href),{cache:'no-store',signal:AbortSignal.timeout(10000)});
    if(!response.ok||(await response.json()).similarity_stabilization!==1)throw new Error('Restart ComfyUI to enable position, rotation and scale correction.');
}
