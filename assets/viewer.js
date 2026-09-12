import {AXES, SUFFIX, evaluate, rebuildAxis, roundEven, makeZip, validateReference, referenceAgreement, motionForAxis, autoFitAxis, fitComponentAxis, bodyFrame, invertAxis, axisValue, reduceActions} from "./curve.mjs";
import {initializeTimeline, trackLabel, processingTrackState, recreatedTrackChoices, sourceChoices, sourceProject, newTrack, assignTrack, trackProject, editProject, mainPoseProject, timelineState, restoreTimeline, trackCoverage, boundedSelection, sceneCutTimes, fitSelectionTrack, copyTrackToMain, trackCopyAxes, selectionTrack, selectionProblem, reductionBoundaries, motionSections, sectionAt} from "./timeline.mjs";
import {timelineView, zoomView, panView, followView, sliderSpan, spanSlider, formatTime, rulerTicks, visibleRange, displayIndices} from "./viewport.mjs";
import {cutIndex, neighboringCut, cutSideRange} from "./cut-markers.mjs";
import {smoothActions} from "./curve-edit.mjs";
import {PATTERNS, generatePattern, continuePattern, rememberPattern, patternRemovalProblem, removePattern} from "./patterns.mjs";
import {editorSession, sameVideoSource} from "./editor-session.mjs";
import {DEVICE_INFO, drawDeviceWireframe} from "./device-previews/device-wireframes.mjs";
import {DEVICE_PROFILES, deviceSettings, buildDeviceOutput, deviceOutputFiles} from "./device-output.mjs";
import {originalPixel, previewMediaTime, previewTimelineTime} from "./video-preview.mjs";

const $ = id => document.getElementById(id), video = $("video");
const trackName = track => trackLabel(project,track);
const trackDescription = track => [trackName(track),processingTrackState(project,track)].filter(Boolean).join(" · ");
const COLORS = ["#75e2ba", "#dcadfa", "#78baf7", "#ffc07d"];
const EDGES = [[5,6],[5,7],[7,62],[6,8],[8,41],[5,9],[6,10],[9,10],[9,11],[11,13],[10,12],[12,14],[0,5],[0,6]];
const ANCHORS = {pelvis:[9,10],chest:[5,6],nose:[0],left_wrist:[62],right_wrist:[41]};
let project, history = [], currentMs = 0, dragging = null, bounds = [0, 1], videoURL;
let videoVariant="stabilized",videoMapping=null,videoOutput=null,mediaLoading=false,mediaRevision=0;
const localVideos={stabilized:null,original:null};
let comparisonRevision=0, comparisonCache=null;
let deviceOutputCache=null;
let patternDraft=null, patternTimer=null;
let reductionDraft=null;
let sceneCuts=[],cutLoading=false,selectedCut=null;
let view = timelineView(1), scrollPosition = 0;
const curveLayers = new WeakMap();
let sectionPreferences=[],sectionBlocks=[],sectionRanges=[];
const sectionSurfaces=new Map();
const viewKey = (()=>{const params=new URLSearchParams(location.search);return 's3f-timeline-view:'+(params.get('session')||params.get('project')||location.pathname);})();
function previewState() {return {...project.preview,source_layout:$("sourceLayout").value,section_choices:sectionPreferences,sections_collapsed:$("sectionLane").classList.contains("collapsed"),device:$("device").value,timeline_view:{...view},show_cuts:$("showSceneCuts").checked,main_collapsed:$("mainLane").classList.contains("collapsed"),wide_layout:$("wideLayout").checked,loop_selection:$("loopSelection").checked};}
$("outputProfile").replaceChildren(new Option("Off · authored only","none"),...DEVICE_PROFILES.map(p=>new Option(p.label,p.id)));
function deviceOutputControls() {
    const settings=project.device_output??deviceSettings();
    $("outputProfile").value=settings.profile;
    $("zoneMin").value=settings.zone_min_mm??"";$("zoneMax").value=settings.zone_max_mm??"";
    $("outputSpeed").value=settings.speed_mm_s??"";$("outputSetup").value=settings.setup??"";
    $("outputOverlay").checked=settings.show_curve!==false;
    $("deviceMotion").value=settings.preview==="adjusted"?"adjusted":"authored";
    const profile=DEVICE_PROFILES.find(p=>p.id===settings.profile);
    for(const id of ["zoneMin","zoneMax","outputSpeed","outputSetup","outputOverlay"])$(id).disabled=!profile;
    $("publishedSpeed").disabled=!profile?.speed.value;
    $("publishedSpeed").textContent=profile?.speed.value?`Use published ${profile.speed.value} mm/s`:"No published speed";
    $("outputEvidence").replaceChildren();
    if(profile){
        $("outputEvidence").append(`Travel: ${profile.travel.value??"unknown"}${profile.travel.value?" mm (published)":""}. User-entered limits and zones are unverified. `);
        if(profile.speed.source){const link=document.createElement("a");link.href=profile.speed.source;link.textContent="Profile source";link.target="_blank";link.rel="noopener noreferrer";$("outputEvidence").append(link,` · checked ${profile.speed.checked}.`);}
    }
}
function deviceOutputResult() {
    const settings=JSON.stringify(project.device_output);
    if(deviceOutputCache?.revision===comparisonRevision&&deviceOutputCache.settings===settings&&deviceOutputCache.script===project.scripts.L0)return deviceOutputCache.result;
    let result=null,error="";
    try{result=buildDeviceOutput(project);}catch(reason){error=reason.message;}
    deviceOutputCache={revision:comparisonRevision,settings,script:project.scripts.L0,result};
    $("downloadDevice").disabled=!result?.script;
    $("deviceMotion").querySelector('[value="adjusted"]').disabled=!result?.script;
    if(!result?.script)$("deviceMotion").value="authored";
    const peak=result?.before.peak_speed_mm_s.toFixed(1);
    $("outputStatus").textContent=error||(!result?"Choose a profile to compare stroke demands in physical units.":
        !result.script?`Main L0 peak demand: ${peak} mm/s. Enter a speed limit or explicitly use the published speed to generate a comparison.`:
        `L0 peak demand: ${peak} → ${result.after.peak_speed_mm_s.toFixed(1)} mm/s · limit ${result.limit.value} mm/s (${result.limit.status}) · over-limit segments ${result.before.over_limit_segments} → ${result.after.over_limit_segments} · ${result.changed_points} changed points · largest change ${result.max_change_mm.toFixed(2)} mm. Timestamps and holds retained; positions may change.`);
    return result;
}
function changeDeviceOutput(update) {
    if(!project)return;record();project.device_output=update({...deviceSettings(),...project.device_output});
    deviceOutputControls();dirty(false);render();
}
$("outputProfile").onchange=()=>changeDeviceOutput(()=>deviceSettings($("outputProfile").value));
for(const [id,key] of [["zoneMin","zone_min_mm"],["zoneMax","zone_max_mm"],["outputSpeed","speed_mm_s"]])$(id).onchange=()=>{
    const value=$(id).valueAsNumber;
    changeDeviceOutput(s=>({...s,[key]:Number.isFinite(value)?value:null,...(key==="speed_mm_s"?{speed_evidence:"assumed"}:{})}));
};
$("publishedSpeed").onclick=()=>changeDeviceOutput(s=>({...s,speed_mm_s:DEVICE_PROFILES.find(p=>p.id===s.profile)?.speed.value??null,speed_evidence:"published"}));
$("outputSetup").onchange=()=>changeDeviceOutput(s=>({...s,setup:$("outputSetup").value}));
$("outputOverlay").onchange=()=>changeDeviceOutput(s=>({...s,show_curve:$("outputOverlay").checked}));
$("deviceMotion").onchange=()=>changeDeviceOutput(s=>({...s,preview:$("deviceMotion").value}));
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
function record() { history.push(JSON.stringify({scripts:project.scripts, config:project.config,references:project.references,metrics:project.metrics,timeline:timelineState(project),device_output:project.device_output})); if(history.length>40)history.shift(); $("undo").disabled=false; }
const session = editorSession({install, snapshot:()=>project?({...project,preview:previewState()}):null, status,
    recovery:message=>{$('saveRecovery').hidden=!message;$('saveRecoveryMessage').textContent=message||'';},
    downloadDraft:json=>{
        const url=URL.createObjectURL(new Blob([json],{type:'application/json'})),a=document.createElement('a');
        a.href=url;a.download=`motion-draft-${new Date().toISOString().replaceAll(':','-')}.json`;a.click();
        setTimeout(()=>URL.revokeObjectURL(url),30000);
    },
});
for(const [id,action] of [['retrySave',()=>session?.flush()],['recoverSave',()=>session?.recover()]])$(id).onclick=async()=>{
    $('retrySave').disabled=$('recoverSave').disabled=true;
    try{await action();}catch(error){status(error.message);}
    finally{$('retrySave').disabled=$('recoverSave').disabled=false;}
};
const layoutKey="s3f-motion-wide-layout:1";
function restoreWideLayout(data) {
    let wide=data?.preview?.wide_layout;
    // Online layout follows this browser's preference; offline exports retain
    // the layout saved in that project without needing browser storage.
    if(!document.getElementById("s3f-project")||typeof wide!=="boolean"){
        try{const saved=JSON.parse(localStorage.getItem(layoutKey));if(typeof saved==="boolean")wide=saved;}catch{/* Storage is optional. */}
    }
    applyWideLayout(wide!==false);
}
function applyWideLayout(wide) {
    document.body.classList.toggle("wide-layout",wide);$("wideLayout").checked=wide;render();
}
$("wideLayout").onchange=()=>{
    const wide=$("wideLayout").checked;applyWideLayout(wide);
    try{localStorage.setItem(layoutKey,JSON.stringify(wide));}catch{/* Keep the working layout without storage. */}
    if(project)session?.changed();
};
restoreWideLayout();
let fullscreenDocument=document;
try{if(window.parent!==window&&window.parent.location.origin===location.origin&&window.parent.location.pathname.endsWith("/workspace.html"))fullscreenDocument=window.parent.document;}catch{/* Other frames use their own document. */}
const fullscreenLabel=()=>{const active=!!fullscreenDocument.fullscreenElement;$("fullscreenLayout").textContent=active?"Exit full screen":"Full screen";$("fullscreenLayout").setAttribute("aria-pressed",String(active));render();};
$("fullscreenLayout").disabled=!fullscreenDocument.fullscreenEnabled;
$("fullscreenLayout").onclick=async()=>{
    try{if(fullscreenDocument.fullscreenElement)await fullscreenDocument.exitFullscreen();else await fullscreenDocument.documentElement.requestFullscreen();}
    catch{status("The browser declined full screen. Wide layout is still available.");}
};
fullscreenDocument.addEventListener("fullscreenchange",fullscreenLabel);

const floatingPanel=$("videoPanel");
let floatingRect=null, floatingDrag=null;
function placeFloatingVideo() {
    if(!floatingRect)return;
    const clamp=(value,low,high)=>Math.max(low,Math.min(high,value));
    const r=floatingRect;
    r.width=clamp(r.width,Math.min(260,innerWidth-16),innerWidth-16);
    r.height=clamp(r.height,Math.min(200,innerHeight-16),innerHeight-16);
    r.left=clamp(r.left,8,Math.max(8,innerWidth-r.width-8));r.top=clamp(r.top,8,Math.max(8,innerHeight-r.height-8));
    Object.assign(floatingPanel.style,Object.fromEntries(Object.entries(r).map(([key,value])=>[key,`${value}px`])));render();
}
$("floatVideo").onclick=()=>{
    const floating=!floatingPanel.classList.contains('floating');
    document.body.classList.toggle('video-floating',floating);floatingPanel.classList.toggle('floating',floating);
    $("floatVideo").textContent=floating?'Dock video':'Float video';$("floatVideo").setAttribute('aria-pressed',String(floating));$("videoResize").hidden=!floating;
    if(floating){floatingRect||={left:18,top:innerHeight-360,width:420,height:330};placeFloatingVideo();}
    else{floatingPanel.removeAttribute('style');render();}
};
for(const [id,resizePanel] of [['videoGrip',false],['videoResize',true]]){
    const handle=$(id);
    handle.addEventListener('pointerdown',event=>{
        if(event.button!==0||!floatingPanel.classList.contains('floating')||(!resizePanel&&event.target.closest('button,input,select,label')))return;
        event.preventDefault();floatingDrag={x:event.clientX,y:event.clientY,rect:{...floatingRect}};handle.setPointerCapture(event.pointerId);
    });
    handle.addEventListener('pointermove',event=>{
        if(!floatingDrag)return;const {rect,x,y}=floatingDrag;
        floatingRect=resizePanel?{...rect,width:rect.width+event.clientX-x,height:rect.height+event.clientY-y}:{...rect,left:rect.left+event.clientX-x,top:rect.top+event.clientY-y};placeFloatingVideo();
    });
    for(const type of ['pointerup','pointercancel','lostpointercapture'])handle.addEventListener(type,()=>{floatingDrag=null;});
    handle.addEventListener('keydown',event=>{
        if(!floatingPanel.classList.contains('floating')||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)||(!resizePanel&&event.target.tagName!=='H2'))return;
        event.preventDefault();event.stopPropagation();
        const horizontal=event.key==='ArrowLeft'||event.key==='ArrowRight',key=resizePanel?(horizontal?'width':'height'):(horizontal?'left':'top');
        floatingRect[key]+=(event.key==='ArrowLeft'||event.key==='ArrowUp'?-1:1)*(event.shiftKey?40:10);placeFloatingVideo();
    });
}
window.addEventListener('resize',()=>{if(floatingPanel.classList.contains('floating'))placeFloatingVideo();});

let playingSelection=false;
function playbackRange() {
    if(!project)return null;
    const [a,b]=project.timeline.selection||[],start=Math.max(0,a),end=Math.min(project.metadata.duration_ms,b);
    return Number.isFinite(start)&&Number.isFinite(end)&&end-start>=1?[start,end]:null;
}
function playbackControls() {
    const range=playbackRange();$("playSelection").disabled=!range||!video.getAttribute('src')||mediaLoading;
    $("loopSelection").disabled=!range;
    $("loopSelection").parentElement.title=range?`Repeat ${formatTime(range[0],3)} – ${formatTime(range[1],3)}`:'Mark In and Out to loop a selection';
}
function enforcePlaybackRange(seconds, ended=false) {
    const range=playbackRange();
    if(!range||mediaLoading||video.seeking||(!$("loopSelection").checked&&!playingSelection)||(!ended&&video.paused))return false;
    const t=previewTimelineTime(seconds,videoVariant,videoMapping,project.metadata.source_origin_ms||0),[a,b]=range;
    if(!ended&&t>=a-.5&&t<b-.5)return false;
    const repeat=$("loopSelection").checked||t<a;
    if(!repeat){video.pause();playingSelection=false;}
    currentMs=repeat?a:b;video.currentTime=previewMediaTime(currentMs,videoVariant,videoMapping,project.metadata.source_origin_ms||0);
    if(repeat&&ended)video.play().catch(error=>status(error.message));
    render();return true;
}
$("playSelection").onclick=()=>{
    const range=playbackRange();if(!range)return;
    playingSelection=true;seek(range[0]);video.play().catch(error=>{playingSelection=false;status(error.message);});
};
$("loopSelection").onchange=()=>{if(project)session?.changed();enforcePlaybackRange(video.currentTime);};
// Frame callbacks drive the curves; a lightweight animation clock also checks
// the exact selection edge between video frames and at reduced playback rates.
let loopFrame=null;
function watchPlayback(){loopFrame=null;if(video.paused)return;enforcePlaybackRange(video.currentTime);loopFrame=requestAnimationFrame(watchPlayback);}
video.addEventListener('play',()=>{if(loopFrame===null)loopFrame=requestAnimationFrame(watchPlayback);});
video.addEventListener('pause',()=>{if(loopFrame!==null)cancelAnimationFrame(loopFrame);loopFrame=null;if(!video.ended)playingSelection=false;});
video.addEventListener('ended',()=>enforcePlaybackRange(video.currentTime,true));
fullscreenLabel();
function dirty(authored=true) { if(authored&&!locked()){const {track}=selected();(track||project.timeline.main[$("axis").value]).edited=true;} project.manual_edits = true; session?.changed(); ++comparisonRevision; delete project.reference_comparison; status("Unsaved edits · download the project to keep them"); }
function videoChoices(){
    $("videoVariantLabel").hidden=!videoMapping;$("videoVariant").value=videoVariant;
    $("videoFile").parentElement.title=videoMapping?`Choose the ${videoVariant} video for this view`:"Choose the source video";
}
function loadPreviewVideo(resume=false){
    const url=localVideos[videoVariant]||(videoOutput?`../video/${encodeURIComponent(videoOutput)}?variant=${videoVariant}`:null);
    const revision=++mediaRevision;video.pause();mediaLoading=true;
    video.onloadedmetadata=()=>{
        if(revision!==mediaRevision)return;
        video.currentTime=previewMediaTime(currentMs,videoVariant,videoMapping,project.metadata.source_origin_ms||0);mediaLoading=false;
        if(resume)video.play().catch(error=>status(error.message));render();
    };
    if(url)video.src=url;
    else{video.removeAttribute("src");video.load();status(`Choose the ${videoVariant} video locally for this view`)}
}
async function loadVideoComparison(data,output){
    // Old cached projects can obtain their mapping without another pose extraction.
    if(videoMapping||!output||!data.metadata.source.path.endsWith("/stabilized.mp4"))return;
    try{
        const response=await fetch(`../video/${encodeURIComponent(output)}/reference`);
        if(!response.ok)return;
        const mapping=await response.json();if(project!==data||!mapping)return;
        videoMapping=mapping;data.metadata.reference_stabilization=mapping;videoChoices();render();
    }catch{/* Local file selection and stabilized playback remain available. */}
}
function install(data, keepPlayback=false, output=null) {
    const oldAxis=$("axis").value, previousMs=currentMs, hadVideo=!!video.getAttribute("src");
    if (data.schema !== "sam3d-funscript/1" || !data.scripts || !data.times_ms?.length) throw new Error("Unsupported project file");
    document.body.classList.remove("waiting-for-workflow");$("workflowWaiting").hidden=true;
    keepPlayback=!!(keepPlayback&&sameVideoSource(project?.metadata?.source,data.metadata.source));
    dragging=null;discardPattern();discardReduction();
    if(!keepPlayback){video.pause();video.onloadedmetadata=null;video.removeAttribute("src");video.load();++mediaRevision;mediaLoading=false;
    for(const key of Object.keys(localVideos)){if(localVideos[key])URL.revokeObjectURL(localVideos[key]);localVideos[key]=null;}
    videoURL=null;videoVariant="stabilized";videoMapping=null;}
    closeSceneCut();
    initializeTimeline(data);
    if(keepPlayback){
        const replacements=recreatedTrackChoices(data,project),follow=id=>replacements.get(id)||id;
        for(const key of ['active','selection_track','selection_lane'])if(data.timeline[key])data.timeline[key]=follow(data.timeline[key]);
        if(data.preview?.section_choices)data.preview={...data.preview,section_choices:[...new Set(data.preview.section_choices.map(follow))]};
    }
    restoreView(data,keepPlayback); project = data; history=[]; ++comparisonRevision; $("undo").disabled=true;
    sectionPreferences=Array.isArray(data.preview?.section_choices)?data.preview.section_choices:[];
    $("sourceLayout").value=data.preview?.source_layout==='rows'?'rows':'sections';
    $("sectionLane").classList.toggle('collapsed',!!data.preview?.sections_collapsed);
    $("device").value = Object.hasOwn(DEVICE_INFO, data.preview?.device) ? data.preview.device : "sr6";
    $("axis").replaceChildren(...Object.keys(data.scripts).map(axis => new Option(axis + " · " + ({L0:"stroke",L1:"surge",L2:"sway",R0:"twist",R1:"roll",R2:"pitch"}[axis]), axis)));
    $("name").textContent = data.metadata.source.path.split("/").at(-1);
    $("warnings").replaceChildren(...(data.warnings||[]).map(text=>{const li=document.createElement("li");li.textContent=text;return li;}));
    $("provenance").textContent = JSON.stringify({source:data.metadata.source,model:data.metadata.model,samples:data.times_ms.length,basis:data.metadata.basis,config:data.config},null,2);
    if(keepPlayback&&data.scripts[oldAxis])$("axis").value=oldAxis;
    videoOutput=output;videoMapping=data.metadata.reference_stabilization||videoMapping;
    if(videoMapping)data.metadata.reference_stabilization=videoMapping;videoChoices();
    sceneCuts=sceneCutTimes(data);$("showSceneCuts").checked=data.preview?.show_cuts!==false;
    $("loopSelection").checked=data.preview?.loop_selection===true;if(!keepPlayback)playingSelection=false;
    collapseLane($("mainLane"),!!data.preview?.main_collapsed);
    currentMs=keepPlayback?previousMs:data.times_ms[0]; buildTracks(); selectionControls(); controls(); deviceOutputControls(); render(); status("Project loaded · choose the matching source video");
    restoreWideLayout(data);
    if(output&&(!keepPlayback||!hadVideo))loadPreviewVideo();
    loadVideoComparison(data,output);
    refreshSceneCuts();
}
function cutTimelineSessions() {
    const candidates=[new URLSearchParams(location.search).get("timeline"),project?.metadata.processing_timeline?.session];
    // Existing workspace tabs predate the explicit timeline link. Read only
    // same-origin connected pages; verify the source and editor owner below.
    try {
        for(const page of window.parent.s3fWorkspaceFrames?.()||[])
            if(page.key.startsWith("timeline:"))candidates.push(new URL(page.window.location.href).searchParams.get("session"));
        if(window.opener?.location.pathname.endsWith("/processing-timeline.html"))
            candidates.push(new URL(window.opener.location.href).searchParams.get("session"));
    }catch{/* Separate or closed workflow windows have no timeline link. */}
    return [...new Set(candidates.filter(id=>typeof id==="string"&&/^[a-f0-9]{32}$/.test(id)))];
}
async function refreshSceneCuts() {
    if(!project||cutLoading||document.getElementById("s3f-project"))return;
    const data=project,owner=new URLSearchParams(location.search).get("session");cutLoading=true;
    try {
        for(const id of cutTimelineSessions()){
            const response=await fetch(`../timelines/${encodeURIComponent(id)}`,{cache:"no-store",signal:AbortSignal.timeout(8000)});
            if(!response.ok)continue;
            const state=await response.json();
            if(project!==data)return;
            if(!sameVideoSource(data.metadata.source,state.info?.source))continue;
            if(owner?state.editor_session!==owner:state.project!==videoOutput)continue;
            const scan=state.scene_cuts?.source_id===state.info.source_id?state.scene_cuts:null;
            const changed=JSON.stringify(data.metadata.scene_cuts??null)!==JSON.stringify(scan);
            data.metadata.processing_timeline={...data.metadata.processing_timeline,session:id};
            if(changed){
                if(scan)data.metadata.scene_cuts=scan;else delete data.metadata.scene_cuts;
                sceneCuts=sceneCutTimes(data);session?.changed();render();
            }
            break;
        }
    }catch{/* Keep the saved markers available while ComfyUI is disconnected. */}
    finally{cutLoading=false;}
}
setInterval(()=>{if(!document.hidden)refreshSceneCuts();},4000);
window.addEventListener("focus",refreshSceneCuts);
$("showSceneCuts").onchange=()=>{if(project){session?.changed();render();}};
$("collapseMain").onclick=()=>{if(project){collapseLane($("mainLane"),!$("mainLane").classList.contains("collapsed"));session?.changed();render();}};
function visibleSceneCuts(start,end,width) {
    const [first,stop]=visibleRange(sceneCuts.length,i=>sceneCuts[i],start,end),result=[];
    let lastPixel=-Infinity;
    for(let i=first;i<stop;i++){
        const at=sceneCuts[i];if(at<start||at>end)continue;
        const pixel=Math.round((at-start)/Math.max(1,end-start)*width);
        if(pixel!==lastPixel){result.push(at);lastPixel=pixel;}
    }
    return result;
}
// The popup lives outside the scrolling tracks so its actions stay visible.
function closeSceneCut(focus=false) {
    const canvas=selectedCut?.canvas;selectedCut=null;$('sceneCutActions').hidden=true;
    if(focus&&canvas?.isConnected)canvas.focus({preventScroll:true});
}
function sceneCutScope(){
    const track=project.timeline.tracks.find(t=>t.id===selectedCut?.id);
    return track?trackCoverage(project,track):[0,roundEven(project.metadata.duration_ms)];
}
function sceneCutRange(direction){
    if(!selectedCut)return null;
    const shot=cutSideRange(sceneCuts,selectedCut.at,direction,0,project.metadata.duration_ms),scope=sceneCutScope();
    if(!shot)return null;
    const range=[Math.max(scope[0],roundEven(shot[0])),Math.min(scope[1],roundEven(shot[1]))];
    return range[1]>range[0]?range:null;
}
function renderSceneCutActions(){
    const menu=$('sceneCutActions');if(!selectedCut){menu.hidden=true;return;}
    const {at,canvas,id}=selectedCut,rect=canvas.getBoundingClientRect();
    const width=document.documentElement.clientWidth,heightLimit=document.documentElement.clientHeight;
    const list=id==='main'||canvas===$('sectionCurve')?null:$('tracks').getBoundingClientRect();
    if(!$('showSceneCuts').checked||!sceneCuts.includes(at)||!canvas.isConnected||rect.height===0||id!==project.timeline.active||at<bounds[0]||at>bounds[1]||
        rect.top+5<Math.max(0,list?.top||0)||rect.top+5>Math.min(heightLimit,list?.bottom??heightLimit)){
        closeSceneCut();return;
    }
    menu.hidden=false;
    const track=project.timeline.tracks.find(t=>t.id===id),[a,b]=project.timeline.selection,[low,high]=sceneCutScope();
    $('selectedSceneCutLabel').textContent=`Cut ${cutIndex(sceneCuts,at)+1} · ${formatTime(at,3)}`;
    $('sceneCutTrack').textContent=trackName(track)||`Main · ${$('axis').value}`;
    const outside=roundEven(at)<low||roundEven(at)>high;
    for(const name of ['sceneCutIn','sceneCutOut']){$(name).disabled=outside;$(name).title=outside?'This cut is outside the source track range.':'Use this cut boundary for the selection.';}
    for(const [name,direction]of [['sceneCutBefore',-1],['sceneCutAfter',1]])$(name).disabled=!sceneCutRange(direction);
    $('sceneCutPrevious').disabled=neighboringCut(sceneCuts,at,-1)===null;
    $('sceneCutNext').disabled=neighboringCut(sceneCuts,at,1)===null;
    $('sceneCutSelection').textContent=b>a?`Selection: ${formatTime(a,3)} – ${formatTime(b,3)}`:'Set In / Out, select a shot, or Shift-click another cut.';
    $('sceneCutScope').textContent=track?`Selection stays within this source: ${formatTime(low,3)} – ${formatTime(high,3)}.`:'Select between scene boundaries on the main timeline.';
    $('sceneCutFit').disabled=b<=a;$('sceneCutCopy').hidden=!track;
    const problem=track?selectionProblem(project,track):'';
    $('sceneCutCopy').disabled=!!problem;$('sceneCutCopy').title=problem||'Copy this source selection into all unlocked matching main axes.';
    const x=rect.left+42+(at-bounds[0])/Math.max(1,bounds[1]-bounds[0])*(rect.width-54),height=menu.offsetHeight;
    menu.style.left=`${Math.max(8,Math.min(width-menu.offsetWidth-8,x-menu.offsetWidth/2))}px`;
    const top=rect.top-8-height;
    menu.style.top=`${Math.max(8,Math.min(heightLimit-height-8,top>=8?top:rect.top+16))}px`;
}
function selectSceneCut(at,canvas,id,extend=false){
    if(!sceneCuts.includes(at))return;
    const anchor=selectedCut?.at;
    dragging=null;selectLane(id);selectedCut={at,canvas,id};
    seek(at);
    if(extend&&anchor!==undefined)setSelection(anchor,at);
    render();$('sceneCutActions').focus({preventScroll:true});
}
function navigateSceneCut(direction){
    if(!selectedCut)return;
    const {at,canvas,id}=selectedCut,next=neighboringCut(sceneCuts,at,direction);
    if(next===null)return;
    view=followView(project.metadata.duration_ms,view,next,true);
    selectSceneCut(next,canvas,id);
}
for(const [id,direction]of [['sceneCutPrevious',-1],['sceneCutNext',1]])$(id).onclick=()=>navigateSceneCut(direction);
for(const [id,direction]of [['sceneCutBefore',-1],['sceneCutAfter',1]])$(id).onclick=()=>{const range=sceneCutRange(direction);if(range)setSelection(...range);};
$('sceneCutIn').onclick=()=>$('markIn').click();$('sceneCutOut').onclick=()=>$('markOut').click();
$('sceneCutClose').onclick=()=>{closeSceneCut(true);render();};
$('sceneCutFit').onclick=()=>$('zoomSelection').click();
$('sceneCutCopy').onclick=()=>{if(selectedCut?.id!=='main')applySelection(false);};
document.addEventListener('pointerdown',event=>{
    if(selectedCut&&!event.target.closest('#sceneCutActions,#markIn,#markOut')&&event.target!==selectedCut.canvas){closeSceneCut();render();}
});
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
    $("editing").textContent=track?`Editing ${trackName(track)} · ${axis}. Source edits are independent; apply a selection to update main.`:
        assembled()?"Editing main · assembled sections. Drag points to adjust joins, or calibrate a source track and apply it again.":`Editing main · ${axis}`;
    $("fitSelection").disabled=!track;
    if(track?.window)$("editing").textContent=`Editing ${trackName(track)} · ${axis} · local origin within ${track.window.map(t=>(t/1000).toFixed(3)).join("–")} s. Apply a selection to update main.`;
    if(locked())$("editing").textContent="Locked · curve, calibration and source are protected across reruns. Unlock this track to edit it.";
    $("lockMain").textContent=locked("main")?"Unlock":"Lock";$("lockMain").setAttribute("aria-pressed",String(locked("main")));
    const ref=project.references?.[$("axis").value];$("referenceOffset").disabled=!ref;$("referenceOffset").value=ref?.offset_ms||0;
    document.querySelectorAll(".track").forEach(row=>row.classList.toggle("selected",row.dataset.track===project.timeline.active));
    $("selectMain").textContent=`Main · ${$("axis").value} · export`;
    const main=project.timeline.main[$("axis").value];
    $("mainDescription").textContent=main.assembled?`${main.regions.length} source sections · device preview and exports follow main`:"Device preview and exported scripts follow this track";
    selectionControls();
    sectionControls();
}
function calibrationControls() {
    const {data,axis}=selected();
    const automatic=$("component").value==="auto";
    const adaptive=automatic&&$("calibration").value==="adaptive"&&data.config.axis_settings[axis].auto_fit;
    $("calibration").disabled=assembled()||locked()||!automatic;
    $("autoFit").textContent=automatic?"Auto fit selected axis":"Fit selected component";
    $("autoFit").title=automatic?"Fit direction, origin and range using the selected mode. Keeps Invert and other axes.":"Keep the chosen direction and fit its range and center across this source track. Uses cached motion; replaces edits on this curve. Keeps Invert and other axes.";
    $("rangeLabel").textContent=adaptive?"Local full-scale range":"Full-scale range";
    for(const id of ["range","center"])$(id).disabled=assembled()||locked()||adaptive;
}
function selectLane(id) {
    if(!project)return;
    if(id!==project.timeline.active)discardPattern("Track changed. Preview on this curve before applying.");
    if(selectedCut&&selectedCut.id!==id)closeSceneCut();
    if(id!=='main')sectionPreferences=[id,...sectionPreferences.filter(choice=>choice!==id)];
    project.timeline.active=id;controls();render();session?.changed();
}
function collapseLane(row, collapsed) {
    row.classList.toggle("collapsed",collapsed);
    const button=row.querySelector(".collapse-track");
    button.textContent=collapsed?"▸":"▾";button.setAttribute("aria-expanded",String(!collapsed));
    button.title=collapsed?"Expand track":"Collapse track";
    button.setAttribute("aria-label",button.title);
    if(project){
        const track=project.timeline.tracks.find(t=>t.id===row.dataset.track);
        if(track)track.collapsed=collapsed;
        else project.preview={...project.preview,main_collapsed:collapsed};
    }
}
function selectionControls() {
    [$("selectionStart").value,$("selectionEnd").value]=project.timeline.selection.map(t=>(t/1000).toFixed(3));
    const track=selectionTrack(project),problem=selectionProblem(project,track);
    const describe=source=>{
        const axes=trackCopyAxes(project,source);
        return `${axes.updated.join(", ")} → matching main axes${axes.locked.length?` · Locked: ${axes.locked.join(", ")} (kept)`:""}`;
    };
    $("applySection").disabled=!!problem;$("applySection").title=problem||describe(track);
    $("promoteTrack").disabled=!!selectionProblem(project,track,true);
    $("promoteTrack").title=selectionProblem(project,track,true)||describe(track);
    $("selectTrack").disabled=!track;
    $("selectionStatus").textContent=problem||(track?`Copy source: ${trackName(track)} · ${describe(track)}`:"");
    const selectedCurve=selected(),range=project.timeline.selection;
    const scope=selectedCurve.track?trackCoverage(project,selectedCurve.track):[0,roundEven(project.metadata.duration_ms)];
    $("smoothSelection").disabled=locked()||range[1]<=range[0]||range[0]<scope[0]||range[1]>scope[1];
    $("smoothTarget").textContent=`${trackName(selectedCurve.track)||"Main"} · ${selectedCurve.axis}${locked()?" · locked":" · selected range only"}`;
    patternControls();reductionControls();
    const tracks=new Map(project.timeline.tracks.map(t=>[t.id,t]));
    for(const row of $("tracks").children){
        row.classList.toggle("copy-source",row.dataset.track===track?.id);
        const source=tracks.get(row.dataset.track),button=row.querySelector(".copy-selection");
        const reason=selectionProblem(project,source);button.disabled=!!reason;button.title=reason||describe(source);
        const label="Copy selection · all axes";if(button.textContent!==label)button.textContent=label;
    }
}
function setSelection(start,end) {
    discardPattern("Range changed. Preview before applying.");
    project.timeline.selection_lane=project.timeline.active;
    project.timeline.selection=boundedSelection(project,start,end);
    selectionControls();render();
}
function buildTracks() {
    closeSceneCut();
    sectionSurfaces.clear();
    $("tracks").replaceChildren();
    for(const track of project.timeline.tracks){
        const row=document.createElement("div");row.className="track";row.dataset.track=track.id;
        const head=document.createElement("div");head.className="track-head";
        const collapse=document.createElement("button");collapse.className="collapse-track";
        collapse.onclick=()=>{collapseLane(row,!track.collapsed);session?.changed();render();};
        const select=document.createElement("button");select.className="track-select";select.textContent="Edit";select.onclick=()=>selectLane(track.id);
        const name=document.createElement("input");name.type="text";name.className="track-name";name.value=trackName(track);name.setAttribute("aria-label","Track name");
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
        remove.onclick=()=>{if(track.locked)return;record();project.timeline.tracks=project.timeline.tracks.filter(t=>t!==track);if(project.timeline.active===track.id)project.timeline.active="main";buildTracks();dirty(false);controls();render();};
        const sourceLabel=document.createElement("label");sourceLabel.append("Project ",source);
        const axisLabel=document.createElement("label");axisLabel.append("Axis ",axis);
        const lock=document.createElement("button");lock.className="track-lock";lock.title="Protect this curve and calibration across edits and reruns. Unlock explicitly to edit.";lock.textContent=track.locked?"Unlock":"Lock";lock.setAttribute("aria-pressed",String(!!track.locked));lock.onclick=()=>toggleLock(track);
        const copy=document.createElement("button");copy.className="copy-selection";copy.onclick=()=>{selectLane(track.id);applySelection(false);};
        const range=document.createElement("button");range.className="select-track-range";range.textContent="Select range";
        range.title="Select exactly this source's available range";
        range.onclick=()=>{selectLane(track.id);setSelection(...trackCoverage(project,track));};
        const badge=document.createElement("span");badge.className="copy-source-badge";badge.textContent="Copy source";
        for(const input of [name,source,axis,remove])input.disabled=!!track.locked;
        const result=document.createElement("span");result.className="track-result";result.textContent=processingTrackState(project,track);result.hidden=!result.textContent;
        result.title=result.textContent==='Saved detection'?'An older result kept for your edits. Select the current detection to review the rebuilt zone.':'The latest result from the current processing plan.';
        head.append(collapse,select,lock,name,result,sourceLabel,axisLabel,range,copy,badge,remove);
        const candidate=sourceProject(project,track.source).metadata.automatic_candidate;
        if(candidate){const review=document.createElement('span');review.className='automatic-review';review.textContent=candidate.review.length?'Needs review':'Auto candidate';review.title=candidate.review.join(' · ')||'Suggested from crop coverage and usable movement. Review the pose and curve before keeping it.';head.append(review);}
        if(track.window){const scope=document.createElement("span");scope.className="track-scope";scope.textContent=`${track.window.map(t=>(t/1000).toFixed(3)).join("–")} s · local fit`;head.append(scope);}
        const canvas=document.createElement("canvas");canvas.tabIndex=0;canvas.dataset.track=track.id;canvas.setAttribute("aria-label",`${trackName(track)} motion timeline`);
        row.append(head,canvas);$("tracks").append(row);collapseLane(row,!!track.collapsed);bindCurve(canvas,track.id);
    }
}
function sectionControls() {
    const compact=$('sourceLayout').value==='sections',tracks=project.timeline.tracks;
    const current=tracks.find(t=>t.id===project.timeline.active)||selectionTrack(project)||tracks[0];
    sectionRanges=tracks.map(t=>{const [start,end]=trackCoverage(project,t);return {id:t.id,start,end};}).sort((a,b)=>a.start-b.start||a.end-b.end);
    if(current)sectionPreferences=[current.id,...sectionPreferences.filter(id=>id!==current.id&&tracks.some(t=>t.id===id))];
    sectionBlocks=motionSections(sectionRanges,sectionPreferences);
    $('tracks').classList.toggle('sections-view',compact);
    document.body.classList.toggle('source-sections',compact);
    $('sectionControls').hidden=!compact;$('sectionLane').hidden=!compact||!tracks.length;
    for(const row of $('tracks').children)row.classList.toggle('section-current',row.dataset.track===current?.id);
    const byId=new Map(tracks.map(t=>[t.id,t]));
    $('sectionTrack').replaceChildren(...sectionRanges.map(r=>new Option(`${formatTime(r.start,2)}–${formatTime(r.end,2)} · ${trackDescription(byId.get(r.id))}`,r.id)));
    $('sectionTrack').value=current?.id||'';
    $('sectionTrack').disabled=!tracks.length;
    const range=sectionRanges.find(r=>r.id===current?.id);
    const alternatives=range?sectionRanges.filter(r=>r.start<range.end&&r.end>range.start):[];
    $('sectionAnchor').replaceChildren(...alternatives.map(r=>new Option(`${trackDescription(byId.get(r.id))} · ${byId.get(r.id).axis}`,r.id)));
    $('sectionAnchor').value=current?.id||'';$('sectionAlternatives').hidden=alternatives.length<2;
    $('previousSection').disabled=!range||!sectionRanges.some(r=>r.start<range.start);
    $('nextSection').disabled=!range||!sectionRanges.some(r=>r.start>range.start);
    const collapsed=$('sectionLane').classList.contains('collapsed');
    $('collapseSections').textContent=collapsed?'Expand sections':'Collapse sections';
    $('collapseSections').setAttribute('aria-expanded',String(!collapsed));
}
function chooseSection(id, whole=true) {
    const track=project?.timeline.tracks.find(t=>t.id===id);if(!track)return;
    selectLane(id);
    const [start,end]=trackCoverage(project,track);
    if(whole)setSelection(start,end);else setSelection(...project.timeline.selection);
    if(end<=bounds[0]||start>=bounds[1])changeView(panView(project.metadata.duration_ms,view,start));
    if(currentMs<start||currentMs>=end)seek(start);
    session?.changed();
}
$('sourceLayout').onchange=()=>{if(!project)return;closeSceneCut();dragging=null;sectionControls();session?.changed();render();};
$('sectionTrack').onchange=()=>chooseSection($('sectionTrack').value);
$('sectionAnchor').onchange=()=>chooseSection($('sectionAnchor').value,false);
for(const [name,direction] of [['previousSection',-1],['nextSection',1]])$(name).onclick=()=>{
    const current=sectionRanges.find(r=>r.id===$('sectionTrack').value);if(!current)return;
    const candidates=sectionBlocks.filter(r=>direction<0?r.start<current.start:r.start>current.start);
    const next=direction<0?candidates.at(-1):candidates[0];if(next)chooseSection(next.id);
};
$('collapseSections').onclick=()=>{if(!project)return;closeSceneCut();$('sectionLane').classList.toggle('collapsed');sectionControls();session?.changed();render();};
let sectionLabelKey='';
function drawSections() {
    if($('sectionLane').hidden)return;
    const canvas=$('sectionCurve'),collapsed=$('sectionLane').classList.contains('collapsed');
    const [ctx,w,h]=resize(canvas,collapsed?[$('sectionLabels').clientWidth,190]:undefined),dpr=devicePixelRatio||1;
    const x=t=>42+(t-bounds[0])/(bounds[1]-bounds[0])*(w-54),y=p=>h-25-p/100*(h-40);
    const visible=sectionBlocks.filter(b=>b.end>bounds[0]&&b.start<bounds[1]);
    const tracks=new Map(project.timeline.tracks.map(t=>[t.id,t]));
    const labelKey=JSON.stringify([bounds,w,visible,project.timeline.active,visible.map(b=>[trackDescription(tracks.get(b.id)),tracks.get(b.id).axis,tracks.get(b.id).locked])]);
    if(labelKey!==sectionLabelKey){
        sectionLabelKey=labelKey;$('sectionLabels').replaceChildren();
        for(const block of visible){
            const track=tracks.get(block.id),button=document.createElement('button');
            const left=Math.max(42,x(block.start)),right=Math.min(w-12,x(block.end));
            button.className='section-block';button.dataset.track=track.id;
            button.textContent=`${track.locked?'🔒 ':''}${trackDescription(track)} · ${track.axis}${block.choices.length>1?` · ${block.choices.length} choices`:''}`;
            button.title=`${button.textContent} · ${formatTime(block.start,3)}–${formatTime(block.end,3)} · Click to select this section`;
            button.style.left=`${left}px`;button.style.width=`${Math.max(1,right-left)}px`;
            button.setAttribute('aria-pressed',String(project.timeline.active===track.id));
            button.onclick=()=>chooseSection(track.id);$('sectionLabels').append(button);
        }
    }
    if(collapsed)return;
    ctx.fillStyle='#111e28';ctx.fillRect(42,10,w-54,h-35);
    const painted=new Set();
    for(const block of visible){
        const track=tracks.get(block.id);let surface=sectionSurfaces.get(track.id);
        if(!surface){surface=document.createElement('canvas');surface.dataset.track=track.id;sectionSurfaces.set(track.id,surface);}
        if(!painted.has(track.id)){
            drawCurve(surface,trackProject(project,track),track.axis,false,track.id===project.timeline.active,trackCoverage(project,track),[w,h]);
            painted.add(track.id);
        }
        const left=Math.max(42,x(block.start)),right=Math.min(w-12,x(block.end));
        ctx.fillStyle=track.id===project.timeline.active?'#203e4b':'#192d39';ctx.fillRect(left,10,right-left,h-35);
        ctx.drawImage(surface,left*dpr,10*dpr,(right-left)*dpr,(h-35)*dpr,left,10,right-left,h-35);
        ctx.strokeStyle=track.id===project.timeline.active?'#75e2ba':'#4b677d';ctx.lineWidth=1;
        ctx.strokeRect(left+.5,10.5,Math.max(0,right-left-1),h-36);
    }
    // One shared ruler and cut guide, including unprocessed gaps.
    ctx.font='11px system-ui';ctx.fillStyle='#8197ab';
    for(const p of [0,25,50,75,100])ctx.fillText(p,9,y(p)+4);
    for(const tick of rulerTicks(...bounds,w-54,project.metadata.duration_ms)){
        ctx.fillText(tick.label,Math.max(42,Math.min(w-12-ctx.measureText(tick.label).width,x(tick.time)-ctx.measureText(tick.label).width/2)),h-6);
    }
    ctx.save();ctx.beginPath();ctx.rect(42,0,w-54,h-25);ctx.clip();
    if($('showSceneCuts').checked)for(const t of visibleSceneCuts(...bounds,(w-54)/8)){
        const px=x(t);ctx.setLineDash([2,5]);line(ctx,[px,10],[px,h-25],'#d9c57e66',1);ctx.setLineDash([]);
        ctx.fillStyle=selectedCut?.at===t?'#ffe0a8':'#d9c57e';ctx.beginPath();ctx.moveTo(px,1);ctx.lineTo(px+4,5);ctx.lineTo(px,9);ctx.lineTo(px-4,5);ctx.closePath();ctx.fill();
    }
    line(ctx,[x(currentMs),10],[x(currentMs),h-25],'#f0f5fa',1);ctx.restore();
    for(const id of sectionSurfaces.keys())if(!painted.has(id))sectionSurfaces.delete(id);
}
function resize(canvas, size) {
    const rect=size?{width:size[0],height:size[1]}:canvas.getBoundingClientRect(), dpr=devicePixelRatio||1;
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
    const original=videoVariant==="original"&&videoMapping;
    const [ih,iw]=original?videoMapping.image_size:project.metadata.image_size;
    const [poseHeight,poseWidth]=project.metadata.image_size;
    const scale=Math.min(w/iw,h/ih),ox=(w-iw*scale)/2,oy=(h-ih*scale)/2;
    const pixel=(p,t=currentMs)=>{const q=original?originalPixel(videoMapping,p,t):p;return [q[0]*scale+ox,q[1]*scale+oy]};
    (project.pixels?.[index]||[]).forEach((person,slot)=>{
        for(const [a,b] of EDGES) if(finitePoint(person[a])&&finitePoint(person[b])) line(ctx,pixel(person[a]),pixel(person[b]),COLORS[slot%COLORS.length]);
        const roi=project.metadata.mask_boxes?.[index]?.[slot]||project.metadata.rois?.[slot];
        if(roi){const [x,y]=pixel([roi[0]*poseWidth,roi[1]*poseHeight]);ctx.strokeStyle=COLORS[slot%COLORS.length];ctx.strokeRect(x,y,roi[2]*poseWidth*scale,roi[3]*poseHeight*scale);ctx.fillStyle=ctx.strokeStyle;ctx.fillText(`${project.metadata.mask_video?"Mask person":"ROI"} ${slot}`,x+6,y+15);}
    });
    const slot=project.config.target_person,joints=project.anchor_indices?.target||ANCHORS[project.config.target_anchor];
    const pointAt=i=>{const points=joints.map(j=>project.pixels?.[i]?.[slot]?.[j]);if(!points.every(finitePoint))return null;return pixel([points.reduce((s,p)=>s+p[0],0)/points.length,points.reduce((s,p)=>s+p[1],0)/points.length],i===index?currentMs:project.times_ms[i]);};
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
    const output=deviceOutputResult(),adjusted=$("deviceMotion").value==="adjusted"&&output?.script;
    const scripts=adjusted?{L0:output.script}:project.scripts;
    const values=Object.fromEntries(AXES.map(a=>[a,evaluate(scripts[a]?.actions,currentMs)]));
    const device=$("device").value;
    const frame=drawDeviceWireframe(ctx,w,h,device,values,{...deviceOrbit,sleeve:$("deviceSleeve").checked});
    $("readouts").replaceChildren(...DEVICE_INFO[device].axes.map(a=>{const el=document.createElement("span");el.dataset.axis=a;el.textContent=`${a} ${values[a].toFixed(1)}${scripts[a]?"":" (off)"}`;return el;}));
    $("deviceMotionStatus").textContent=adjusted?`Adjusted L0 · ${(output.mapping.zone_min_mm+values.L0/100*(output.mapping.zone_max_mm-output.mapping.zone_min_mm)).toFixed(1)} mm in selected zone · other axes neutral. Commanded motion; physical response unknown.`:"Authored main · schematic playback";
    $("deviceReach").hidden=frame.reachable!==false;
    $("deviceReach").textContent=frame.reachable===false?"Outside schematic linkage reach · dashed coral rods":"";
}
function drawCurve(canvas, data, axis, isMain, active, window, size) {
    const [ctx,w,h]=resize(canvas,size),composed=isMain&&project.timeline.main[axis].assembled;
    const x=t=>42+(t-bounds[0])/(bounds[1]-bounds[0])*(w-54),y=p=>h-25-p/100*(h-40);
    const actions=data.scripts[axis].actions,s=data.config.axis_settings[axis],color=isMain?"#75e2ba":"#78baf7";
    const output=isMain&&axis==="L0"&&project.device_output?.show_curve!==false?deviceOutputResult()?.script:null;
    if(isMain)$("mainOutputBadge").hidden=!output;
    const key=JSON.stringify([w,h,devicePixelRatio,bounds,axis,comparisonRevision,composed,s,window,!!output]);
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
        if(output)stroke(output.actions.length,i=>output.actions[i].at,i=>output.actions[i].pos,"#ffc07d",2);
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
    if($("showSceneCuts").checked){
        ctx.save();ctx.beginPath();ctx.rect(42,0,w-54,h-25);ctx.clip();
        for(const t of visibleSceneCuts(...bounds,(w-54)/8)){
            const px=x(t);ctx.setLineDash([2,5]);line(ctx,[px,10],[px,h-25],"#d9c57e66",1);ctx.setLineDash([]);
            ctx.fillStyle=selectedCut?.at===t?"#ffe0a8":"#d9c57e";ctx.beginPath();ctx.moveTo(px,1);ctx.lineTo(px+4,5);ctx.lineTo(px,9);ctx.lineTo(px-4,5);ctx.closePath();ctx.fill();
        }
        ctx.restore();
    }
    ctx.save();ctx.beginPath();ctx.rect(42,10,w-54,h-30);ctx.clip();
    if(patternDraft && patternDraft.key===patternKey() && (canvas.dataset.track||"main")===project.timeline.active){
        const points=patternDraft.inside, indices=displayIndices(points.length,i=>points[i].at,i=>points[i].pos,...bounds,w-54);
        ctx.strokeStyle="#ff91bc";ctx.lineWidth=2.5;ctx.setLineDash([6,4]);ctx.beginPath();let pen=false;
        for(const i of indices){if(i===null){pen=false;continue;}const p=points[i];if(pen)ctx.lineTo(x(p.at),y(p.pos));else ctx.moveTo(x(p.at),y(p.pos));pen=true;}
        ctx.stroke();ctx.setLineDash([]);
    }
    if(reductionDraft && reductionDraft.key===reductionKey() && (canvas.dataset.track||"main")===project.timeline.active){
        const points=reductionDraft.inside;
        const indices=displayIndices(points.length,i=>points[i].at,i=>points[i].pos,...bounds,w-54);
        ctx.strokeStyle=ctx.fillStyle="#ffd08a";ctx.lineWidth=2.5;ctx.setLineDash([5,3]);ctx.beginPath();let pen=false;
        for(const i of indices){if(i===null){pen=false;continue;}const p=points[i];if(pen)ctx.lineTo(x(p.at),y(p.pos));else ctx.moveTo(x(p.at),y(p.pos));pen=true;}
        ctx.stroke();ctx.setLineDash([]);
        for(const i of indices){if(i===null)continue;const p=points[i];ctx.beginPath();ctx.arc(x(p.at),y(p.pos),4,0,Math.PI*2);ctx.fill();}
    }
    const [start,end]=project.timeline.selection;
    if(end>start){
        const source=selectionTrack(project),chosen=(canvas.dataset.track||"main")===(project.timeline.selection_lane||source?.id);
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
    playbackControls();
    patternControls();reductionControls();
    $("time").textContent=project.metadata.duration_ms>=60000?formatTime(currentMs,3,project.metadata.duration_ms>=3600000):(currentMs/1000).toFixed(3)+" s";
    $("time").dataset.ms=String(currentMs);
    const selectedContext=selected(), outputAxis=$("axis").value;
    const pose=selectedContext.track?selectedContext:project.timeline.main[outputAxis].assembled?mainPoseProject(project,outputAxis,currentMs):selectedContext;
    const data=pose.data,i=sampleIndex(data),available=data.valid[i]&&currentMs>=data.times_ms[0]&&currentMs<=data.metadata.duration_ms&&Math.abs(currentMs-data.times_ms[i])<=data.config.max_gap_ms;
    if(available){drawOverlay(i,data);drawSkeleton(i,data,pose.axis);}
    else for(const name of ["overlay","skeleton"]){const[ctx,w,h]=resize($(name));ctx.fillStyle="#eabf71";ctx.font="13px system-ui";ctx.fillText("No analysed pose at this time",12,h/2);}
    if(!video.paused&&view.follow&&!dragging)view=followView(project.metadata.duration_ms,view,currentMs);
    navigationControls();renderSceneCutActions();
    $("sceneCutCount").textContent=sceneCuts.length?`${sceneCuts.length} cuts`:"";
    $("showSceneCuts").parentElement.title=sceneCuts.length?"Detected scene cuts · click a diamond for In / Out and shot selection":"Detect cuts in the connected processing timeline to show them here";
    drawRobot();
    const mainContext=editProject(project,outputAxis,"main");
    if(!$("mainLane").classList.contains("collapsed"))drawCurve($("curve"),mainContext.data,outputAxis,true,project.timeline.active==="main");
    const listRect=$("tracks").getBoundingClientRect();
    if($('sourceLayout').value==='sections')drawSections();
    else for(const track of project.timeline.tracks){
        if(track.collapsed)continue;
        const canvas=[...$("tracks").children].find(row=>row.dataset.track===track.id).querySelector("canvas"),rect=canvas.getBoundingClientRect();
        if(track.id===project.timeline.active||rect.bottom>=Math.max(0,listRect.top)&&rect.top<=Math.min(innerHeight,listRect.bottom))drawCurve(canvas,trackProject(project,track),track.axis,false,track.id===project.timeline.active,track.window);else curveLayers.delete(canvas);
    }
}
function updateVideoTime(seconds){
    if(mediaLoading||!project||!video.getAttribute("src")||!video.readyState)return;
    if(enforcePlaybackRange(seconds))return;
    const time=previewTimelineTime(seconds,videoVariant,videoMapping,project.metadata.source_origin_ms||0),end=project.metadata.duration_ms;
    if(videoVariant==="original"&&(time<-.5||time>end+.5)){
        if(time>end)video.pause();
        currentMs=Math.max(0,Math.min(end,time));
        video.currentTime=previewMediaTime(currentMs,videoVariant,videoMapping,project.metadata.source_origin_ms||0);
    }else currentMs=time;
}
function frameCallback(_,metadata){updateVideoTime(metadata.mediaTime);render();video.requestVideoFrameCallback(frameCallback);}
if(video.requestVideoFrameCallback)video.requestVideoFrameCallback(frameCallback);
video.addEventListener("timeupdate",()=>{if(!video.requestVideoFrameCallback||video.paused){updateVideoTime(video.currentTime);render();}});
video.addEventListener("seeked",()=>{updateVideoTime(video.currentTime);if(project&&view.follow&&!dragging)view=followView(project.metadata.duration_ms,view,currentMs);render();});
video.addEventListener("error",()=>status("Choose the source video locally if this browser cannot load the server copy"));
$("axis").addEventListener("change",()=>{discardPattern("Axis changed. Preview before applying.");controls();render();});
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
    const target=track||project.timeline.main[axis];
    if(target.patterns)target.patterns=target.patterns.map(p=>({...p,before:p.before.map(a=>({...a,pos:100-a.pos}))}));
    if(!track)for(const region of project.timeline.main[axis].regions){region.settings={...region.settings,center:100-region.settings.center,invert:!region.settings.invert};}
    if(Number.isFinite(pendingCenter)&&pendingCenter>=0&&pendingCenter<=100)$("center").value=100-pendingCenter;
    dirty();render();
});
function regenerate(data,axis,track) {
    data.scripts[axis]=rebuildAxis(data,axis);
    delete (track||project.timeline.main[axis]).patterns;
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
    try{
        const {data,axis,track}=selected(),component=$("component").value;
        const settings=component==="auto"?autoFitAxis(data,axis,!!track?.window&&calibration==="clip",calibration):fitComponentAxis(data,axis,Number(component),!!track?.window);
        record();data.config.axis_settings[axis]=settings;regenerate(data,axis,track);dirty();controls();render();
    }
    catch(error){status(error.message);}
}
$("autoFit").addEventListener("click",()=>fitAutomatic());
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
$("undo").addEventListener("click",()=>{if(!history.length)return;const old=JSON.parse(history.pop());project.scripts=old.scripts;project.config=old.config;project.references=old.references;project.metrics=old.metrics;project.device_output=old.device_output;restoreTimeline(project,old.timeline);$("undo").disabled=!history.length;buildTracks();selectionControls();controls();deviceOutputControls();dirty(false);render();});
function pointer(event,canvas){const rect=canvas.getBoundingClientRect();return {at:roundEven(Math.max(0,Math.min(project.metadata.duration_ms,bounds[0]+(event.clientX-rect.left-42)/(rect.width-54)*(bounds[1]-bounds[0])))),pos:roundEven(Math.max(0,Math.min(100,(rect.height-25-(event.clientY-rect.top))/(rect.height-40)*100)))};}
function nearest(event,canvas,actions){
    const a=pointer(event,canvas),rect=canvas.getBoundingClientRect(),[first,stop]=visibleRange(actions.length,i=>actions[i].at,...bounds);
    if(stop-first>(rect.width-54)/4)return -1;
    for(let i=first;i<stop;i++){const p=actions[i];if(Math.hypot((p.at-a.at)/(bounds[1]-bounds[0])*(rect.width-54),(p.pos-a.pos)/100*(rect.height-40))<9)return i;}return -1;
}
function seek(time){currentMs=time;if(video.readyState&&!mediaLoading)video.currentTime=previewMediaTime(time,videoVariant,videoMapping,project.metadata.source_origin_ms||0);render();}
function sceneCutAtPointer(event,canvas){
    const rect=canvas.getBoundingClientRect(),y=event.clientY-rect.top;
    if(!$('showSceneCuts').checked||y<0||y>12)return null;
    const time=bounds[0]+(event.clientX-rect.left-42)/Math.max(1,rect.width-54)*(bounds[1]-bounds[0]);
    const tolerance=(bounds[1]-bounds[0])/Math.max(1,rect.width-54)*7;
    return visibleSceneCuts(...bounds,(rect.width-54)/8).filter(t=>Math.abs(t-time)<=tolerance).sort((a,b)=>Math.abs(a-time)-Math.abs(b-time))[0]??null;
}
function bindCurve(canvas,target){
    let id=typeof target==='function'?null:target;
    const resolve=event=>{if(typeof target==='function')id=target(pointer(event,canvas).at);return id;};
    canvas.addEventListener("wheel",event=>timelineWheel(event,canvas),{passive:false});
    const actions=()=>id==="main"?project.scripts[$("axis").value].actions:project.timeline.tracks.find(t=>t.id===id).script.actions;
    canvas.addEventListener("pointerdown",event=>{
        if(!project||event.button!==0)return;
        const near=sceneCutAtPointer(event,canvas);
        resolve(event);
        if(!id){if(near!==null)id='main';else{seek(pointer(event,canvas).at);return;}}
        if(near!==null){event.preventDefault();selectSceneCut(near,canvas,id,event.shiftKey);return;}
        closeSceneCut();selectLane(id);canvas.focus({preventScroll:true});
        const p=pointer(event,canvas);
        if(event.shiftKey){dragging={canvas,start:p.at,selection:true};setSelection(p.at,p.at);if(event.isTrusted)canvas.setPointerCapture(event.pointerId);return;}
        const index=$("editPoints").checked?nearest(event,canvas,actions()):-1;
        if(index>=0&&!locked(id)){dragging={canvas,index,startX:event.clientX,startY:event.clientY};}
        else {seek(p.at);dragging={canvas,seek:true};}
        if(event.isTrusted)canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener("pointermove",event=>{
        if(dragging?.canvas!==canvas)return;
        const p=pointer(event,canvas);
        if(dragging.selection){setSelection(dragging.start,p.at);return;}
        if(dragging.seek){seek(p.at);return;}
        if(!$("editPoints").checked)return;
        if(!dragging.recorded){
            if(Math.hypot(event.clientX-dragging.startX,event.clientY-dragging.startY)<3)return;
            record();dragging.recorded=true;
        }
        if(locked(id))return;
        const track=project.timeline.tracks.find(t=>t.id===id),scope=typeof target==='function'&&track?trackCoverage(project,track):[0,roundEven(project.metadata.duration_ms)];
        const list=actions(),i=dragging.index,min=Math.max(scope[0],i?list[i-1].at+1:0),max=Math.min(scope[1],i+1<list.length?list[i+1].at-1:roundEven(project.metadata.duration_ms));
        list[i]={at:Math.max(min,Math.min(max,p.at)),pos:p.pos};dirty();render();
    });
    const release=()=>{if(dragging?.canvas===canvas){dragging=null;render();}};
    for(const name of ["pointerup","pointercancel","lostpointercapture"])canvas.addEventListener(name,release);
    canvas.addEventListener("dblclick",event=>{
        if(!project)return;
        const cut=sceneCutAtPointer(event,canvas);
        resolve(event);if(!id){if(cut!==null)id='main';else return;}
        if(cut!==null){event.preventDefault();selectSceneCut(cut,canvas,id);const range=sceneCutRange(1);if(range)setSelection(...range);return;}
        if(!project||!$("editPoints").checked||event.shiftKey||locked(id))return;selectLane(id);const list=actions(),p=pointer(event,canvas);if(list.some(a=>a.at===p.at))return;record();list.push(p);list.sort((a,b)=>a.at-b.at);dirty();render();});
    canvas.addEventListener("contextmenu",event=>{event.preventDefault();if(!project||!resolve(event)||!$("editPoints").checked||locked(id))return;selectLane(id);const list=actions(),i=nearest(event,canvas,list);if(i>=0&&list.length>1){record();list.splice(i,1);dirty();render();}});
}
$("editPoints").onchange=()=>{dragging=null;document.body.classList.toggle("editing-points",$("editPoints").checked);};
$("smoothSelection").onclick=()=>{
    if(!project||locked()||$("smoothSelection").disabled)return;
    try{
        const {data,axis,track}=selected(),[start,end]=project.timeline.selection;
        const actions=smoothActions(data.scripts[axis].actions,start,end,$("smoothMs").valueAsNumber,reductionBoundaries(project,track,axis,sceneCuts));
        record();data.scripts[axis]={...data.scripts[axis],actions};delete data.metrics?.[axis];
        commitSelected(data,axis,track);dirty();controls();render();
        status(`Smoothed ${trackName(track)||"Main"} · ${axis} over ${(start/1000).toFixed(3)}–${(end/1000).toFixed(3)} s · ${$("smoothMs").value} ms. Undo restores this curve.`);
    }catch(error){status(error.message);}
};
function reductionOptions() {
    const {data,axis,track}=selected(),list=data.scripts[axis].actions;
    const [start,end]=$('reductionScope').value==='whole'?[list[0].at,list.at(-1).at]:project.timeline.selection;
    return {start,end,tolerance:$('reductionMode').value==='exact'?0:$('reductionTolerance').valueAsNumber};
}
function reductionKey() {
    return project?JSON.stringify([comparisonRevision,project.timeline.active,selected().axis,reductionOptions(),sceneCuts]):null;
}
function discardReduction(message='') {
    reductionDraft=null;$('applyReduction').disabled=true;$('cancelReduction').disabled=true;
    if(message)$('reductionStatus').textContent=message;
}
function reductionControls() {
    if(!project)return;
    const {data,axis,track}=selected(),options=reductionOptions(),scope=track?trackCoverage(project,track):[0,project.metadata.duration_ms];
    const valid=options.end>options.start&&($('reductionScope').value==='whole'||options.start>=scope[0]&&options.end<=scope[1]);
    if(reductionDraft&&reductionDraft.key!==reductionKey())discardReduction('Curve, range or settings changed. Preview again before applying.');
    $('reductionToleranceLabel').hidden=$('reductionMode').value==='exact';
    $('previewReduction').disabled=locked()||!valid||data.scripts[axis].actions.length<2;
    $('applyReduction').disabled=locked()||!reductionDraft?.removed;
    $('cancelReduction').disabled=!reductionDraft;
    $('reductionTarget').textContent=`${trackName(track)||'Main'} · ${axis}${locked()?' · locked':valid?' · '+($('reductionScope').value==='whole'?'whole curve':'selected range'):' · select a range within this track'}`;
}
$('previewReduction').onclick=()=>{
    if(!project)return;reductionControls();if($('previewReduction').disabled)return;
    discardPattern();discardReduction();
    try{
        const {data,axis,track}=selected(),options=reductionOptions();
        const result=reduceActions(data.scripts[axis].actions,{...options,protectedTimes:reductionBoundaries(project,track,axis,sceneCuts)});
        reductionDraft={...result,inside:result.actions.filter(p=>p.at>=result.start&&p.at<=result.end),key:reductionKey()};
        const error=result.tolerance?`maximum position change ${Number(result.maxError.toFixed(6))} / 100`:'exactly the same linear curve';
        $('reductionStatus').textContent=`Gold preview · ${result.before} → ${result.after} points · ${result.removed} removed · ${error}.${result.removed?' Apply changes this axis only; Undo restores it.':' No removable points under these settings.'}`;
        reductionControls();render();
    }catch(error){$('reductionStatus').textContent=error.message;render();}
};
$('cancelReduction').onclick=()=>{discardReduction('Preview discarded. The curve is unchanged.');render();};
$('applyReduction').onclick=()=>{
    if(!project)return;reductionControls();if($('applyReduction').disabled)return;
    const {data,axis,track}=selected(),draft=reductionDraft;
    record();data.scripts[axis]={...data.scripts[axis],actions:draft.actions};delete data.metrics?.[axis];
    commitSelected(data,axis,track);discardReduction();dirty();controls();render();
    const message=`Reduced ${trackName(track)||'Main'} · ${axis}: ${draft.before} → ${draft.after} points · maximum position change ${Number(draft.maxError.toFixed(6))} / 100. Undo restores the original points.`;
    $('reductionStatus').textContent=message;status(message);
};
for(const input of $('reductionPanel').querySelectorAll('input,select'))input.addEventListener('change',()=>{
    discardReduction('Settings changed. Preview the reduction before applying.');reductionControls();render();
});

$("patternShape").replaceChildren(...PATTERNS.map(name=>new Option(name,name)));
$("patternShape").value="Sine Wave";
const patternEdgeSettings={continue:{blend:true,ms:150},generate:{blend:false,ms:150}};
let patternMode=$("patternMode").value;
let patternListKey="";
function patternOptions() {
    const n=id=>$(id).valueAsNumber, ms=id=>n(id)*1000;
    return {mode:$("patternMode").value, side:$("patternSide").value, contextMs:ms("patternContext"),
        cycleMs:ms($("patternMode").value==="continue"?"patternCycleOverride":"patternCycle"),
        shape:$("patternShape").value, amplitude:n("patternAmplitude"), center:n("patternCenter"),
        fadeInMs:ms("patternFadeIn"),fadeOutMs:ms("patternFadeOut"),reverse:$("patternReverse").checked,seed:n("patternSeed"),
        joinMs:$("patternBlendEdges").checked?n("patternJoin"):0,stepMs:n("patternStep")};
}
function patternKey() {
    return project?JSON.stringify([comparisonRevision,project.timeline.active,selected().axis,project.timeline.selection,patternOptions()]):null;
}
function discardPattern(message="") {
    clearTimeout(patternTimer);patternTimer=null;patternDraft=null;
    $("applyPattern").disabled=true;$("cancelPattern").disabled=true;
    if(message)$("patternStatus").textContent=message;
}
function patternControls() {
    if(!project)return;
    const {axis,track}=selected(),[start,end]=project.timeline.selection;
    const scope=track?trackCoverage(project,track):[0,roundEven(project.metadata.duration_ms)];
    const name=`${trackName(track)||"Main"} · ${axis}`, valid=end>start&&start>=scope[0]&&end<=scope[1];
    if(patternDraft&&patternDraft.key!==patternKey())discardPattern("Curve, range or settings changed. Preview again before applying.");
    $("previewPattern").disabled=locked()||!valid;
    $("applyPattern").disabled=locked()||!valid||!patternDraft;
    $("applyPattern").textContent=`Apply to ${name}`;
    $("cancelPattern").disabled=!patternDraft;
    $("patternTarget").textContent=`${name}${locked()?" · locked":valid?` · ${(start/1000).toFixed(3)}–${(end/1000).toFixed(3)} s`:" · select a range within this track"}`;
    $("continueOptions").hidden=$("patternMode").value!=="continue";
    $("generateOptions").hidden=$("patternMode").value!=="generate";
    $("patternSeedLabel").hidden=$("patternShape").value!=="Random";
    $("patternJoin").disabled=!$("patternBlendEdges").checked;
    $("patternJoinHint").textContent=$("patternBlendEdges").checked
        ?"Blending replaces the first and last part of the pattern inside the selection to meet the surrounding curve."
        :"The pattern fills the selection through both edges. The surrounding curve resumes with a cut outside the selection.";
    const patterns=(track||project.timeline.main[axis]).patterns||[];
    const listKey=JSON.stringify([project.timeline.active,axis,patterns.map(p=>[p.id,p.name,p.start,p.end])]);
    if(listKey!==patternListKey){
        patternListKey=listKey;
        $("appliedPattern").replaceChildren(...(patterns.length?patterns.map(p=>new Option(`${p.name} · ${(p.start/1000).toFixed(3)}–${(p.end/1000).toFixed(3)} s`,p.id)):[new Option("No saved patterns on this curve","")]));
        if(patterns.length)$("appliedPattern").value=patterns.at(-1).id;
    }
    $("appliedPattern").disabled=!patterns.length;
    const problem=locked()?"Unlock this curve before removing a pattern.":patternRemovalProblem(patterns,$("appliedPattern").value);
    $("removePattern").disabled=!!problem;$("removePattern").title=problem||"Restore this section to its curve before the pattern was applied, including any later point edits within the section.";
}
function previewPattern() {
    if(!project)return;patternControls();if($("previewPattern").disabled)return;
    discardPattern();discardReduction();
    try{
        const {data,axis,track}=selected(),[start,end]=project.timeline.selection,options=patternOptions();
        options.protectedTimes=reductionBoundaries(project,track,axis,sceneCuts);
        options.contextBounds=track?trackCoverage(project,track):[0,roundEven(project.metadata.duration_ms)];
        const result=(options.mode==="continue"?continuePattern:generatePattern)(data.scripts[axis].actions,start,end,options);
        patternDraft={...result,key:patternKey()};
        $("patternStatus").textContent=`Pink preview · ${result.summary} Apply changes this axis only.`;
        patternControls();render();
    }catch(error){$("patternStatus").textContent=error.message;render();}
}
$("previewPattern").onclick=previewPattern;
$("cancelPattern").onclick=()=>{discardPattern("Preview discarded. The curve is unchanged.");render();};
$("applyPattern").onclick=()=>{
    if(!project)return;patternControls();if($("applyPattern").disabled)return;
    const {data,axis,track}=selected(),draft=patternDraft;
    record();const target=track||project.timeline.main[axis];
    target.patterns=rememberPattern(target.patterns||[],data.scripts[axis].actions,...project.timeline.selection,$("patternMode").value==="generate"?$("patternShape").value:"Continued motion");
    data.scripts[axis]={...data.scripts[axis],actions:draft.actions};delete data.metrics?.[axis];
    commitSelected(data,axis,track);discardPattern();dirty();controls();render();
    const message=`Applied to ${trackName(track)||"Main"} · ${axis}. ${draft.summary} Undo restores the previous curve.`;
    $("patternStatus").textContent=message;status(message);
};
$("appliedPattern").onchange=()=>{
    if(!project)return;const {axis,track}=selected(),patterns=(track||project.timeline.main[axis]).patterns||[];
    const entry=patterns.find(p=>p.id===$("appliedPattern").value);if(entry)setSelection(entry.start,entry.end);
};
$("removePattern").onclick=()=>{
    if(!project)return;patternControls();if($("removePattern").disabled)return;
    try{
        const {data,axis,track}=selected(),target=track||project.timeline.main[axis];
        const result=removePattern(data.scripts[axis].actions,target.patterns||[],$("appliedPattern").value);
        record();target.patterns=result.patterns;data.scripts[axis]={...data.scripts[axis],actions:result.actions};delete data.metrics?.[axis];
        commitSelected(data,axis,track);discardPattern();dirty();controls();render();
        const message=`Removed ${result.name} · restored the previous section on ${trackName(track)||"Main"} · ${axis}. Undo restores the pattern.`;
        $("patternStatus").textContent=message;status(message);
    }catch(error){$("patternStatus").textContent=error.message;}
};
$("patternRange").onclick=()=>{
    if(!project)return;const duration=$("patternDuration").valueAsNumber*1000;
    if(!Number.isFinite(duration)||duration<1||duration>3600000){$("patternStatus").textContent="Enter a duration between 0.001 and 3600 seconds.";return;}
    setSelection(currentMs,Math.min(project.metadata.duration_ms,currentMs+duration));
};
for(const input of $("patternPanel").querySelectorAll("input,select")){
    if(input.id==="appliedPattern")continue;
    const changed=()=>{
        const live=!!patternDraft||!!patternTimer;
        if(input.id==="patternMode"&&input.value!==patternMode){
            patternEdgeSettings[patternMode]={blend:$("patternBlendEdges").checked,ms:$("patternJoin").value};
            patternMode=input.value;const saved=patternEdgeSettings[patternMode];
            $("patternBlendEdges").checked=saved.blend;$("patternJoin").value=saved.ms;
        }
        discardPattern();patternControls();render();
        if(live&&input.id!=="patternDuration")patternTimer=setTimeout(previewPattern,180);
    };
    input.addEventListener("input",changed);input.addEventListener("change",changed);
}
async function toggleLock(target) {
    target.locked=!target.locked;
    // Unlock is explicit: Undo cannot reach behind a lock and replace its curve.
    history=[];$("undo").disabled=true;dragging=null;buildTracks();controls();dirty(false);render();
    if(session){try{await session.flush();}catch(error){status(error.message);}}
}
$("lockMain").onclick=()=>{if(project)toggleLock(project.timeline.main[$("axis").value]);};
bindCurve($("curve"),"main");
bindCurve($('sectionCurve'),time=>sectionAt(sectionBlocks,time)?.id??null);
$("selectMain").onclick=()=>selectLane("main");
$("tracks").addEventListener("scroll",render,{passive:true});
window.addEventListener("scroll",render,{passive:true});
$("addTrack").onclick=()=>{if(!project)return;const current=selected().track,source=current?.source||project.timeline.sources[0].id;record();const track=newTrack(project,source,current?.axis||$("axis").value);project.timeline.active=track.id;buildTracks();dirty();controls();render();$("tracks").lastElementChild?.scrollIntoView({block:"nearest"});};
$("markIn").onclick=()=>{if(project){const at=selectedCut?.at??currentMs;setSelection(at,Math.max(at,project.timeline.selection[1]));}};
$("markOut").onclick=()=>{if(project){const at=selectedCut?.at??currentMs;setSelection(Math.min(at,project.timeline.selection[0]),at);}};
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
    if(!project)return;const track=selectionTrack(project),problem=selectionProblem(project,track,whole);
    if(problem){$("selectionStatus").textContent=problem;return;}
    try{
        const [start,end]=project.timeline.selection,blendMs=$("blendMs").valueAsNumber;
        // Validate on a small copy before recording history or changing the main.
        const preview={...project,timeline:{...project.timeline}};
        const axes=copyTrackToMain(preview,track,{start,end,method:$("join").value,blendMs,whole});
        record();project.scripts=preview.scripts;project.metrics=preview.metrics;project.timeline.main=preview.timeline.main;
        dirty(false);controls();render();
        const message=`${whole?"Whole track":"Selection"} copied: ${trackName(track)} → Main ${axes.updated.join(", ")}.${axes.locked.length?` Locked axes kept: ${axes.locked.join(", ")}.`:""} Undo restores all copied axes.`;
        status(message);$("selectionStatus").textContent=message;
    }catch(error){status(error.message);$("selectionStatus").textContent=error.message;}
}
$("applySection").onclick=()=>applySelection(false);$("promoteTrack").onclick=()=>applySelection(true);
document.addEventListener("keydown",event=>{
    if(selectedCut&&!event.ctrlKey&&!event.metaKey&&!event.altKey){
        if(event.key==='Escape'){event.preventDefault();closeSceneCut(true);render();return;}
        if(event.target.closest('#sceneCutActions')||event.target===selectedCut.canvas){
            if(['ArrowLeft','ArrowRight'].includes(event.key)){event.preventDefault();navigateSceneCut(event.key==='ArrowLeft'?-1:1);return;}
            if(['i','o'].includes(event.key.toLowerCase())){event.preventDefault();$(event.key.toLowerCase()==='i'?'sceneCutIn':'sceneCutOut').click();return;}
        }
    }
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
$("videoFile").addEventListener("change",e=>{if(!e.target.files[0])return;const resume=!video.paused;if(localVideos[videoVariant])URL.revokeObjectURL(localVideos[videoVariant]);videoURL=URL.createObjectURL(e.target.files[0]);localVideos[videoVariant]=videoURL;loadPreviewVideo(resume);status(`Local ${videoMapping?videoVariant:"source"} video loaded`);e.target.value="";});
$("videoVariant").onchange=()=>{const resume=!video.paused;videoVariant=$("videoVariant").value;videoChoices();loadPreviewVideo(resume);render();};
$("referenceFile").addEventListener("change",async e=>{if(!project){status("Open a project first");return;}try{const file=e.target.files[0],data=JSON.parse(await file.text()),actions=validateReference(data);record();project.references={...project.references,[$("axis").value]:{actions,offset_ms:0,source:{path:file.name},header_inverted:!!data.inverted,interpretation:"Positions compared as written; legacy headers not applied"}};dirty(false);controls();render();}catch(error){status(error.message);}});
$("referenceOffset").addEventListener("change",()=>{const ref=project?.references?.[$("axis").value],offset=Number($("referenceOffset").value);if(!ref||!Number.isFinite(offset))return;record();ref.offset_ms=offset;dirty(false);render();});
function downloadArchive(files,name) {
    const url=URL.createObjectURL(makeZip(files)),a=document.createElement("a");a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
}
$("downloadDevice").onclick=()=>{
    if(!project)return;
    try{
        const stem=project.metadata.source.path.split("/").at(-1).replace(/\.[^.]+$/,"");
        downloadArchive(deviceOutputFiles(project,stem),`${stem}-${project.device_output.profile}-L0.zip`);
        status("Adjusted L0 downloaded with its profile report and stroke-zone instructions");
    }catch(error){status(error.message);}
};
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
        let outputNote="";
        if(snapshot.device_output?.profile&&snapshot.device_output.profile!=="none"){
            try{for(const [name,contents]of Object.entries(deviceOutputFiles(snapshot,stem)))files["device-output/"+name]=contents;outputNote=" · adjusted L0 included in device-output/";}
            catch(error){outputNote=` · authored scripts only; adjusted output omitted: ${error.message}`;}
        }
        downloadArchive(files,stem+"-motion.zip");
        status("Download created · extract and open viewer.html for offline playback"+outputNote);
    }catch(error){status(error.message);}finally{$("save").disabled=false;}
});
new ResizeObserver(render).observe(document.body);
new ResizeObserver(render).observe(floatingPanel);
const id=new URLSearchParams(location.search).get("project");
const embedded=document.getElementById("s3f-project");
if(embedded){try{const data=JSON.parse(embedded.textContent);if(data)install(data);}catch(error){status(error.message);}}
else if(id||session){try{
    if(!id){document.body.classList.add("waiting-for-workflow");$("workflowWaiting").hidden=false;}
    const fetchProject=async()=>{if(!id)return null;const response=await fetch(`../projects/${encodeURIComponent(id)}`);if(!response.ok)throw new Error(`Project load failed (${response.status})`);return response.json();};
    if(session)await session.load(fetchProject);else install(await fetchProject(),false,id);
}catch(error){status(error.message);}}
