import {workflowHost,openWorkspacePage} from "./workflow-host.mjs";
import {timelineView as baseTimelineView, zoomView as baseZoomView, panView as basePanView, followView as baseFollowView, sliderSpan as baseSliderSpan, spanSlider as baseSpanSlider, formatTime, rulerTicks} from "./viewport.mjs";
// These exports were added together. Bypass helper URLs cached by older servers;
// updated servers revalidate all editor assets on subsequent loads.
import {LANES, ANCHORS, DETAILED_ANCHOR_GROUPS, clone, clamp, fraction, bounds, regionById, selectionRange, createRegion, changeRegion, splitRegion, splitAtTime, validateInterval, validateReference, regionRows, isolateSelection,regionFromSelection} from "./processing-timeline-edit.mjs?v=timeline-audit-1";
import {cutIndex,neighboringCut,snapCut,shotRange,cutSideRange,visibleCuts} from "./cut-markers.mjs?v=cut-selection-2";
import {createTimelineLayout,thumbnailCount} from "./timeline-layout.mjs?v=timeline-audit-1";
import {frameClock} from "./frame-clock.mjs";
import {referenceKeys,withReferenceKeys,addReferenceKey,putReferencePoint,removeReferencePoint,requireReferenceBackend} from "./reference-edit.mjs?v=reference-masks-1";
import {timelineOutputURL,timelineRenderCatalog,timelineRenderCurrent,timelineRenderAt,timelineTrackingHealth,trackingFrame,trackingSummary,trackingReason} from "./video-preview.mjs?v=reference-masks-1";

import {trackingResultCurrent,processingScope,planForScope} from "./processing-state.mjs?v=automatic-scenes-1";
import {timelineRestore,restoreCandidate} from "./timeline-restore.mjs?v=subject-crop-1";
import {subjectEditor} from "./timeline-subject.mjs?v=subject-crop-1";
import {meshAnchorEditor} from './mesh-anchor.mjs?v=1';
import {stabilizationSteps} from './stabilization-steps.mjs?v=timeline-audit-1';
import {prefillReferenceKey,agreementText} from './reference-mask.mjs';
const $ = id => document.getElementById(id), params = new URLSearchParams(location.search);
const session = params.get("session"), node = params.get("node"), api = new URL(`../timelines/${encodeURIComponent(session || "")}`, location.href), video = $("source");
const uuid = () => crypto.randomUUID?.() || [...crypto.getRandomValues(new Uint8Array(16))].map(value => value.toString(16).padStart(2,"0")).join("");
const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b);
let state, plan, savedPlan, revision, dirty = false, history = [], view, playhead = 0, busy = false;
let savePromise = null, applyTask = null, applyPending = null, processPending = null, startingOperation = null, pendingState = null, activeId = null;
let timelineDrag = null, sourceDrag = null, sourceMap = null, renderQueued = false, lastFrame = 0;
let appliedPlan = null, pollTimer = null, loading = false, thumbTimer = null, thumbnailView = "", conflictingDraft = false;
let frames = null, presentedTime = null, frameCuts = [];
let requestedSeek = null, decodingSeek = null;
let selectedCut = null, cutRangeReady = false;
let propagatedMasks = {};
let renderedClips = [], previewClip = null, previewURL = '', previewLoading = false, resumePlayback = false;
let anchorPreview=null,processedRegions={},anchorOrigin=null;
let renderRequest = 0, previewFailures = new Set(), catalogError = '';
const trackingDetails = new Map();
const resultStates = new Map();
const draftKey = `s3f-processing-timeline:${session}`;
const laneElement = lane => $(`${lane}Lane`);
const selected = () => regionById(plan || {}, activeId);
const sourceBounds = () => {const [a,b]=bounds(state.info);return frames?[Math.max(a,frames.at(frames.first)),Math.min(b,frames.at(frames.end))]:[a,b];};
const duration = () => sourceBounds()[1];
const clipDuration = () => sourceBounds()[1]-sourceBounds()[0];
const cuts = () => frameCuts;
// requestVideoFrameCallback reports a frame PTS (possibly rounded by the browser),
// while currentTime is a continuously advancing clock inside a frame.
const activeFrame = () => !video.paused&&!video.seeking?(presentedTime!==null?frames.nearest(presentedTime):frames.containing(sourceTime(video.currentTime))):frames.containing(playhead);
const snapTime = (time,width) => frames.snap($("showCuts").checked&&$("snapCuts").checked ? snapCut(cuts(),time,Math.min(250,view.span_ms/Math.max(1,width)*7)) : time,true);
const useFrames = () => $("timelineUnit").value === "frames";
const positionValue = time => useFrames() ? String(frames.ceil(time)) : (time/1000).toFixed(3);
const positionTime = value => useFrames() ? frames.at(Number(value)) : frames.snap(Number(value)*1000,true);
const positionLabel = time => useFrames() ? `F ${frames.ceil(time)}` : formatTime(time,3);
const localView = value => ({...value,start_ms:(value?.start_ms??sourceBounds()[0])-sourceBounds()[0]});
const originalView = value => ({...value,start_ms:value.start_ms+sourceBounds()[0]});
const timelineView = (_,value) => originalView(baseTimelineView(clipDuration(),localView(value)));
const zoomView = (_,value,span,anchor=value.start_ms+value.span_ms/2) => originalView(baseZoomView(clipDuration(),localView(value),span,anchor-sourceBounds()[0]));
const panView = (_,value,start) => originalView(basePanView(clipDuration(),localView(value),start-sourceBounds()[0]));
const followView = (_,value,time,center=false) => originalView(baseFollowView(clipDuration(),localView(value),time-sourceBounds()[0],center));
const sliderSpan = (_,value) => baseSliderSpan(clipDuration(),value);
const spanSlider = (_,span) => baseSpanSlider(clipDuration(),span);
const layout=createTimelineLayout({aspect:()=>state?state.info.width/state.info.height:1,
    changed:()=>{if(state&&plan){drawSource();renderTimelines();scheduleThumbs();}}});

const maskSteps=stabilizationSteps({$,context:()=>{
    const r=selected()?.lane==='stabilization'?selected().region:null;
    return {region:r,entry:propagatedMasks[r?.id],first:r?frames.ceil(r.start_ms):0,frame:r?activeFrame()-frames.ceil(r.start_ms):0,
        frameCount:r?frames.ceil(r.end_ms)-frames.ceil(r.start_ms):0,busy:busy||!!startingOperation,operation:processPending?.operation,
        tracked:!!r&&renderedClips.some(e=>e.id===r.id&&timelineRenderCurrent(e,r)),stabilized:!!previewClip,editable:referenceEditable(),tracking:plan?.tracking||[],api};
},attempt,updateReference:reference=>updateRegion({reference}),seekOriginal:frame=>{
    $('referenceMode').value='review';$('previewVariant').value='original';pause();seek(frames.at(frames.ceil(selected().region.start_ms)+frame));
},process,selectRegion,draw:drawSource,configureAnchors:()=>{
    const r=selected().region;
    const next=regionFromSelection({...plan,selection:[r.start_ms,r.end_ms]},'tracking',uuid,state.info,frames);
    const id=next.selected_ids[0];anchorOrigin=r.id;edit({...next,selection:plan.selection});selectRegion(id);
}});
const meshEditor=meshAnchorEditor({$,context:()=>{
    const r=selected()?.lane==='tracking'?selected().region:null;
    return {region:r,clock:frames,first:r?frames.ceil(r.start_ms):0,frame:r?activeFrame()-frames.ceil(r.start_ms):0,
        frameCount:r?frames.ceil(r.end_ms)-frames.ceil(r.start_ms):0,busy:busy||!!startingOperation,
        stabilized:!!previewClip,editable:!$('regionSettingsPane').hidden&&!previewClip&&!previewLoading&&requestedSeek===null&&!video.seeking&&video.readyState>=2&&video.paused,
        stabilization:plan?.stabilization||[]};
},attempt,update:mask_anchor=>updateRegion({mask_anchor}),seekOriginal:frame=>{
    $('previewVariant').value='original';pause();seek(frames.at(frames.ceil(selected().region.start_ms)+frame));
},draw:drawSource});
const subject=subjectEditor({$,context:()=>({region:selected()?.lane==='tracking'?selected().region:null,visible:!$('regionSettingsPane').hidden,
    busy:busy||!!startingOperation,stabilized:!!previewClip,editable:!previewClip&&!previewLoading&&requestedSeek===null&&!video.seeking&&video.readyState>=2&&video.paused,
    size:state?[state.info.width,state.info.height]:[1,1]}),update:updateRegion,attempt,draw:drawSource,prepareOriginal:()=>{
        const r=selected().region;$('previewVariant').value='original';$('meshAnchorTool').value='review';pause();
        seek(playhead>=r.start_ms&&playhead<r.end_ms?playhead:r.start_ms);
    }});
timelineRestore({$,context:()=>({info:state.info,clock:frames,plan}),fail,restore:async candidate=>{
    if(busy||startingOperation)throw new Error('Finish or cancel processing before restoring a plan.');
    const latest=await jsonResponse(await fetch(api,{cache:'no-store',signal:AbortSignal.timeout(15000)}));
    if(latest.info.source_id!==state.info.source_id)throw new Error('The video changed. Reload the timeline before restoring.');
    candidate=restoreCandidate(candidate,latest.info,frames);
    for(const r of [...latest.plan.tracking,...latest.plan.stabilization])if(r.locked&&!equal(r,regionById(candidate,r.id)?.region))throw new Error(`Unlock ${r.name} before replacing its settings.`);
    await loadState(latest,true);edit(candidate,'Plan restored as a draft · review it, then Apply to node');
}});
const bridge = workflowHost;
function status(text) { $("status").textContent = text; }
function fail(error) { $("error").textContent = error.message || String(error); $("error").hidden = false; }
function clearError() { $("error").hidden = true; $("error").textContent = ""; }
function reviewTools(){
    meshEditor.cancel();maskSteps.cancel();subject.cancel();sourceDrag=null;
    $('meshAnchorTool').value='review';$('maskTool').value='review';$('referenceMode').value='review';
}
function showInspectorTab(kind) {
    if(kind==='timeline')reviewTools();
    for(const [tab,pane,name] of [["timelineToolsTab","timelineToolsPane","timeline"],["regionSettingsTab","regionSettingsPane","region"]]){
        const active=kind===name;$(tab).setAttribute("aria-selected",String(active));$(tab).tabIndex=active?0:-1;$(pane).hidden=!active;
    }
    if(frames)drawSource();
}
for(const [id,kind] of [["timelineToolsTab","timeline"],["regionSettingsTab","region"]]){
    $(id).onclick=()=>showInspectorTab(kind);
    $(id).onkeydown=event=>{
        if(!["ArrowLeft","ArrowRight","Home","End"].includes(event.key))return;
        event.preventDefault();event.stopPropagation();
        const target=event.key==="Home"?"timelineToolsTab":event.key==="End"?"regionSettingsTab":kind==="timeline"?"regionSettingsTab":"timelineToolsTab";
        $(target).click();$(target).focus();
    };
}
$("showTimelineTools").onclick=()=>{showInspectorTab("timeline");$("timelineToolsTab").focus({preventScroll:true});$("timelineToolsTab").scrollIntoView({block:"nearest"});};
function feedback(kind, text) {
    $("apply").dataset.state = kind;
    $("apply").textContent = ({applying:"Applying…", applied:"✓ Applied", error:"Apply failed · Retry"})[kind] || "Apply to node";
    $("apply").setAttribute("aria-busy", String(kind === "applying"));
    $("applyStatus").textContent = text || "";
}
function draft() {
    try { if (dirty) localStorage.setItem(draftKey, JSON.stringify({revision, plan, base: savedPlan})); else localStorage.removeItem(draftKey); } catch (_) { /* Storage can be disabled; Download plan still works. */ }
}
function edit(next, message = "Plan changed · Apply to node to keep it") {
    if (busy||startingOperation) throw new Error("Wait for processing to finish, or cancel it before editing the plan.");
    if (equal(plan, next)) return;
    history.push(clone(plan)); if (history.length > 80) history.shift();
    plan = next; dirty = !equal(plan, savedPlan); draft();
    feedback("pending", dirty ? "Unapplied edits" : "Plan matches saved settings");
    clearError(); status(message); render();
}
function attempt(fn) {
    const control = document.activeElement;
    try { fn(); if (control?.setCustomValidity) control.setCustomValidity(""); }
    catch (error) {
        if (control?.matches("input,textarea,select") && control.closest("#regionForm")) control.setCustomValidity(error.message || String(error));
        fail(error); renderInspector();
    }
}
function updateRegion(patch) {
    const before = selected();
    if (!before) return;
    const changedBounds=['start_ms','end_ms'].some(k=>patch[k]!==undefined&&patch[k]!==before.region[k]);
    if(before.region.automatic&&('anchor' in patch||'person' in patch))patch={...patch,automatic:{...before.region.automatic,suggest:false}};
    if(before.region.automatic&&patch.anchor&&patch.anchor!==before.region.anchor&&patch.additional_anchors===undefined)patch.additional_anchors=[...new Set([before.region.anchor,...(before.region.additional_anchors||[])])].filter(a=>a!==patch.anchor&&a!=='mask_anchor');
    if(before.region.automatic&&patch.rois)patch={...patch,candidate_people:patch.rois.map((_,i)=>i),automatic:{...(patch.automatic||before.region.automatic),review:[],people:[]}};
    const next=changeRegion(plan,before.region.id,patch,state.info,frames);
    const after=regionById(next,before.region.id).region;
    const marks=r=>r.reference?referenceKeys(r.reference).filter(k=>k.points.length).length+(r.reference.point_mask?1:0):(r.mask_anchor?1:0);
    const removed=marks(before.region)-marks(after);
    edit(next,changedBounds?`Bounds changed · reference marks kept on their source frames${removed>0?` · ${removed} outside the new range removed (Undo to restore)`:''} · output needs processing`:undefined);
}
function selectRegion(id, additive = false, seekAt = null) {
    if(startingOperation)return;
    reviewTools();
    activeId = id;
    showInspectorTab("region");
    for(const control of $("regionForm").querySelectorAll("input,textarea,select"))control.setCustomValidity("");
    const ids = additive ? new Set(plan.selected_ids || []) : new Set();
    if (additive && ids.has(id)) ids.delete(id); else ids.add(id);
    // Selection is useful in the saved plan but does not invalidate cached processing.
    plan.selected_ids = [...ids]; selectionChanged();
    $("referenceMode").value = "review";
    if (seekAt !== null) seek(seekAt);
    render();
}
function selectionChanged(){
    dirty=!equal(plan,savedPlan);draft();
    feedback('pending',dirty?'Unapplied selection or settings':equal(plan,appliedPlan)?'ComfyUI confirmed these settings':'Plan matches saved settings');
}
function setSelection(a, b, persist = true) {
    if(startingOperation)return;
    const [low, high] = sourceBounds();
    plan.selection = [frames.snap(clamp(Math.min(a,b), low, high),true), frames.snap(clamp(Math.max(a,b), low, high),true)];
    if (persist) selectionChanged();
    renderNavigation(); renderTimelines();
}
function pause() { resumePlayback=false;video.pause(); $("play").textContent = "Play"; }
function mediaTime(ms) { return previewClip ? (ms-frames.at(frames.ceil(previewClip.region.start_ms)))/1000 : fraction(state.info.source_origin) + ms / 1000; }
function sourceTime(seconds) { return previewClip ? seconds*1000+frames.at(frames.ceil(previewClip.region.start_ms)) : (seconds-fraction(state.info.source_origin))*1000; }
function previewForTime(time) {
    return $("previewVariant").value==='stabilized'?timelineRenderAt(renderedClips.filter(r=>!previewFailures.has(r.url)),plan,time):null;
}
function choosePreviewMedia() {
    const next=previewForTime(playhead),url=next?.url||new URL(`${api.pathname}/video?source_id=${encodeURIComponent(state.info.source_id)}`,location.origin).href;
    previewClip=next;
    if(url===previewURL)return false;
    resumePlayback=resumePlayback||!video.paused;video.pause();presentedTime=null;sourceMap=null;sourceDrag=null;
    previewURL=url;previewLoading=true;requestedSeek=null;decodingSeek=null;
    video.src=url;video.load();return true;
}
function requestTrackingDetails(entry) {
    if(!entry||trackingDetails.has(entry.url))return;
    const pending={health:null,error:null},source=state.info.source;trackingDetails.set(entry.url,pending);
    fetch(entry.manifestURL,{cache:'no-store',signal:AbortSignal.timeout(10000)}).then(jsonResponse).then(manifest=>{
        if(trackingDetails.get(entry.url)!==pending)return;
        pending.health=timelineTrackingHealth(manifest,entry,source);
    }).catch(error=>{pending.error=error.message;}).finally(()=>{
        if(trackingDetails.get(entry.url)===pending){renderPreviewControls();renderTimelines();draw();}
    });
}
function selectedRender() {
    const found=selected();return found?.lane==='stabilization'?renderedClips.find(r=>r.id===found.region.id):null;
}
function heldTarget(direction) {
    const health=trackingDetails.get(selectedRender()?.url)?.health;
    return direction>0?health?.gaps.find(t=>t>playhead+.001):health?.gaps.findLast(t=>t<playhead-.001);
}
for(const [id,direction] of [['previousHeld',-1],['nextHeld',1]])$(id).onclick=()=>{
    const time=heldTarget(direction);if(time===undefined)return;
    $("previewVariant").value='stabilized';$("referenceMode").value='review';seek(time);
};
$("showTrackedPoints").onchange=drawSource;
function renderPreviewControls() {
    renderAnchorPreviewControls();
    if(!plan||!frames)return;
    const region=selected()?.lane==='stabilization'?selected().region:null;
    const entry=region&&renderedClips.find(r=>r.id===region.id);
    const available=entry&&region.enabled!==false&&Math.max(entry.region.start_ms,region.start_ms)<Math.min(entry.region.end_ms,region.end_ms);
    $("previewStabilized").disabled=!available;
    $("openStabilized").hidden=!entry;if(entry)$("openStabilized").href=entry.url;
    $("stabilizedStatus").textContent=catalogError||(!entry?'No preview yet · use Track region.':!timelineRenderCurrent(entry,region)?'Previous render · settings changed. Track region to update.':'Preview ready');
    $("previewTitle").textContent=previewClip?'Stabilized source':'Original source';
    requestTrackingDetails(entry);requestTrackingDetails(previewClip);
    const details=trackingDetails.get(entry?.url),health=details?.health;
    $("trackingHealth").hidden=!entry;
    $("trackingHealth").textContent=!entry?'No tracking result yet.':details.error?'Tracking details unavailable · '+details.error:!health?'Loading tracking details…':(!timelineRenderCurrent(entry,region)?'Previous result · ':'')+trackingSummary(health);
    $("trackingHealth").title='Held frames reuse the last accepted correction. Review gaps and correct reference frames, then track again.';
    $("trackingHealth").dataset.held=String(!!health?.counts.held);
    $("showTrackedPoints").disabled=false;
    $("previousHeld").disabled=heldTarget(-1)===undefined;$("nextHeld").disabled=heldTarget(1)===undefined;
    maskSteps.render();
    const trackOnly=processPending?.operation==='stabilize';
    $("trackStabilization").disabled=busy||!!startingOperation||!region||region.locked||region.enabled===false||!!maskSteps.problem();
    $("trackStabilization").textContent=trackOnly?'Tracking…':startingOperation==='stabilize'?'Preparing…':'Track region';
    $("trackStabilization").setAttribute('aria-busy',String(!!trackOnly||startingOperation==='stabilize'));
    $("cancelStabilization").hidden=!trackOnly;$("cancelStabilization").disabled=$("cancel").disabled;
    $("stabilizationProgress").hidden=!trackOnly;
    if(trackOnly){
        $("stabilizationProgressText").textContent=$("progressText").textContent;
        $("stabilizationBar").max=$("progress").max;
        if($("progress").hasAttribute('value'))$("stabilizationBar").value=$("progress").value;
        else $("stabilizationBar").removeAttribute('value');
    }
}
async function refreshRenderedClips() {
    if(!state)return;
    const generation=++renderRequest,sourceId=state.info.source_id;
    try {
        const response=await fetch(timelineOutputURL(session,`results/${sourceId}/state.json`,location.href),{cache:'no-store',signal:AbortSignal.timeout(10000)});
        const data=response.status===404?null:await jsonResponse(response);
        if(generation!==renderRequest||sourceId!==state.info.source_id)return;
        processedRegions=data?.source_id===sourceId?data.regions||{}:{};
        renderedClips=timelineRenderCatalog(data,session,sourceId,location.href);propagatedMasks=data?.source_id===sourceId?data.masks||{}:{};maskSteps.reset();catalogError='';
        const kept=new Set(renderedClips.map(r=>r.url));for(const key of trackingDetails.keys())if(!kept.has(key))trackingDetails.delete(key);
        if(choosePreviewMedia())requestSourceSeek(mediaTime(frames.seekTime(playhead)));
    }catch(error){if(generation!==renderRequest)return;catalogError='Could not refresh rendered clips · '+error.message;}
    renderPreviewControls();renderTimelines();renderReport();draw();
}
$("previewVariant").onchange=()=>{
    if(!state)return;previewFailures.clear();
    if($("previewVariant").value==='stabilized')$("referenceMode").value='review';
    seek(playhead,false);renderPreviewControls();
};
$("previewStabilized").onclick=()=>{
    const region=selected()?.region,entry=renderedClips.find(r=>r.id===region?.id);if(!entry)return;
    trackingDetails.delete(entry.url);
    $("previewVariant").value='stabilized';$("referenceMode").value='review';previewFailures.clear();
    const a=Math.max(region.start_ms,entry.region.start_ms),b=Math.min(region.end_ms,entry.region.end_ms);
    seek(playhead>=a&&playhead<b?playhead:frames.at(frames.ceil(a)));renderPreviewControls();
};
function requestSourceSeek(value) {
    if(!Number.isFinite(value))return;
    requestedSeek=value;
    // Keep at most one decoder seek in flight; repeated step keys replace the
    // desired destination instead of repeatedly interrupting the same decode.
    if(!previewLoading&&!video.seeking&&video.readyState>=1){decodingSeek=value;video.currentTime=value;}
}
function finishSourceSeek() {
    if(previewLoading||video.seeking||video.readyState<2)return;
    if(requestedSeek!==null&&requestedSeek!==decodingSeek){decodingSeek=requestedSeek;video.currentTime=decodingSeek;return;}
    requestedSeek=null;decodingSeek=null;draw();
    if(resumePlayback){resumePlayback=false;video.play().then(()=>{$("play").textContent='Pause';}).catch(fail);}
}
function seek(ms, stop = true) {
    if (!state) return;
    if (stop) pause();
    selectedCut=null;cutRangeReady=false;
    const [low, high] = sourceBounds();
    playhead = frames.snap(clamp(ms, low, high));
    presentedTime = null;
    choosePreviewMedia();renderPreviewControls();if(selected()?.lane==="stabilization")renderReferenceKeys(selected().region);
    const value = mediaTime(frames.seekTime(playhead));
    requestSourceSeek(value);
    if ($("follow").checked) view = followView(duration(), view, playhead);
    draw(); renderNavigation(); renderTimelines();
}
async function togglePlay() {
    if (!video.paused||resumePlayback) { pause(); return; }
    clearCut();
    if (frames.containing(playhead) === frames.end-1) seek(sourceBounds()[0]);
    $("referenceMode").value = "review";
    if(previewLoading||requestedSeek!==null){resumePlayback=true;$("play").textContent='Pause';return;}
    try { await video.play(); $("play").textContent = "Pause"; } catch (error) { fail(error); }
}
function fitRange(a, b) {
    const width = Math.max(250, b - a), padding = width * .07;
    view = timelineView(duration(), {...view, start_ms: a - padding, span_ms: width + padding * 2});
    renderNavigation(); renderTimelines(); scheduleThumbs();
}
function prepare(canvas) {
    const r = canvas.getBoundingClientRect(), dpr = devicePixelRatio || 1;
    const width = Math.max(1, Math.round(r.width * dpr)), height = Math.max(1, Math.round(r.height * dpr));
    if (canvas.width !== width || canvas.height !== height) {canvas.width = width; canvas.height = height;}
    const ctx = canvas.getContext("2d"); ctx.setTransform(dpr,0,0,dpr,0,0); ctx.clearRect(0,0,r.width,r.height);
    return [ctx, r.width, r.height];
}
function drawSource() {
    if (!state || !frames) return;
    const editVisible=!$('regionSettingsPane').hidden;
    const tool=editVisible?$('referenceMode').value:'review';
    $('previewTool').textContent=editVisible&&selected()?.lane==='tracking'&&$('subjectTool').value!=='review'?'Draw person region':editVisible&&selected()?.lane==='tracking'&&$('meshAnchorTool').value!=='review'&&selected().region.anchor==='mask_anchor'?`${$('meshAnchorTool').value} anchor patch`:
        editVisible&&selected()?.lane==='stabilization'&&!$('maskStep').hidden&&$('maskTool').value!=='review'?`${$('maskTool').value} stabilization mask`:
        tool==='points'?'Place numbered points':tool==='crop'?'Draw reference crop':'Review';
    renderAnchorPreviewControls();
    if(previewLoading){$("previewStatus").textContent=previewClip?'Loading stabilized clip…':'Loading original source…';return;}
    // Keep the last complete image while a seek decodes. Clearing the canvas
    // first exposes a blank frame (or redraws an older decoded frame) between steps.
    if(requestedSeek!==null||video.seeking||video.readyState<2)return;
    const [ctx,w,h] = prepare($("sourceCanvas"));
    const found = selected(), reference = !previewClip&&found?.lane === "stabilization" ? found.region.reference : null;
    const zoom = reference && $("cropZoom").checked && $("referenceMode").value !== "crop";
    const personCrop=subject.previewCrop();
    const crop = zoom ? reference.crop_xywh : personCrop || [0,0,previewClip?video.videoWidth:state.info.width,previewClip?video.videoHeight:state.info.height];
    const scale = Math.min(w / crop[2], h / crop[3]), ox = (w - crop[2] * scale) / 2, oy = (h - crop[3] * scale) / 2;
    sourceMap = {crop,scale,ox,oy};
    if (video.readyState >= 2) ctx.drawImage(video,...crop,ox,oy,crop[2]*scale,crop[3]*scale);
    maskSteps.overlay(ctx,sourceMap,w,h);
    meshEditor.overlay(ctx,sourceMap,w,h);subject.overlay(ctx,sourceMap);
    const point = p => [ox+(p[0]-crop[0])*scale, oy+(p[1]-crop[1])*scale];
    if (reference) {
        const key = referenceKeys(reference).find(k=>k.frame===frames.containing(playhead)-frames.ceil(found.region.start_ms));
        const [x,y] = point(reference.crop_xywh); ctx.strokeStyle = "#e2b672"; ctx.lineWidth = 1.5;
        ctx.strokeRect(x,y,reference.crop_xywh[2]*scale,reference.crop_xywh[3]*scale);
        if (key) for (const [i,p] of key.points.entries()) {
            const [px,py]=point(p);ctx.beginPath();ctx.arc(px,py,5,0,Math.PI*2);ctx.strokeStyle=key.unconfirmed?.includes(i)?"#ffb870":"#92efd0";ctx.stroke();ctx.fillStyle=ctx.strokeStyle;ctx.font="12px system-ui";ctx.fillText(String(i+1),px+8,py-7);
        }
        $("previewStatus").textContent = key ? `${key.points.length} reference points · marked frame` : "Choose a clear frame and click Mark reference frame";
    } else $("previewStatus").textContent = personCrop?`Person ${found.region.person} · zoomed preview`:'One source clock for every region';
    if(previewClip){const region=plan.stabilization.find(r=>r.id===previewClip.id);$("previewStatus").textContent=`${region.name} · ${timelineRenderCurrent(previewClip,region)?'rendered stabilization':'previous render · settings changed'} · no audio`;}
    else if($("previewVariant").value==='stabilized')$("previewStatus").textContent=previewFailures.size?'Original · stabilized clip unavailable':catalogError||'Original · no rendered stabilization at this frame';
    const reviewed=previewClip||selectedRender(),health=trackingDetails.get(reviewed?.url)?.health,index=trackingFrame(health,playhead);
    const showReview=index!==null&&($("referenceMode").value==='review')&&(previewClip||timelineRenderCurrent(reviewed,found.region));
    const held=showReview&&health.quality[index]==='held';$("previewStatus").dataset.held=String(held);
    if(showReview){
        if(previewClip)$("previewStatus").textContent+=health.quality[index]==='held'?` · HELD: ${trackingReason(health.reasons[index])}`:health.quality[index]==='manual'?' · manual correction':' · tracking';
        if($("showTrackedPoints").checked){
            ctx.lineWidth=2;ctx.font='12px system-ui';ctx.strokeStyle=ctx.fillStyle=held?'#ffc18b':'#85e8dd';
            for(const [i,p] of (health.points?.[index]||[]).entries()){
                if(!health.visible?.[index]?.[i]||!p.every(Number.isFinite))continue;
                const mapped=previewClip?p.map((v,axis)=>v+health.padding[axis]-health.shifts[index][axis]):p,[px,py]=point(mapped);
                ctx.beginPath();ctx.arc(px,py,5,0,Math.PI*2);ctx.stroke();ctx.fillText(String(i+1),px+8,py-7);
            }
        }
        if(held){ctx.font='bold 12px system-ui';ctx.fillStyle='#3b261dec';ctx.fillRect(8,8,Math.min(w-16,252),29);ctx.fillStyle='#ffd0a0';ctx.fillText('HELD · previous correction',16,27,Math.max(1,w-32));}
    }
    const agreement=showReview?agreementText(health,index):'';
    if(agreement)$('previewStatus').textContent+=' · '+agreement;
    drawAnchorPreview(ctx,point,w,h);
    if (sourceDrag) {const a=point(sourceDrag.start),b=point(sourceDrag.end);ctx.strokeStyle="#9fcaff";ctx.strokeRect(a[0],a[1],b[0]-a[0],b[1]-a[1]);}
}
function anchorPreviewKey() {
    const r=selected()?.lane==='tracking'?selected().region:null;
    return r?JSON.stringify([state.info.source_id,r.id,r.start_ms,r.end_ms,r.anchor,r.additional_anchors||[],r.person,r.rois,!!r.isolate_subject,r.mask_anchor||null]):null;
}
function renderAnchorPreviewControls() {
    if(!state||!frames)return;
    const r=selected()?.lane==='tracking'?selected().region:null,running=processPending?.operation==='preview_anchor';
    const at=frames.at(activeFrame()),inside=r&&at>=r.start_ms&&at<r.end_ms;
    $('previewAnchor').disabled=busy||!!startingOperation||!inside||r.enabled===false||previewLoading||requestedSeek!==null||video.seeking||video.readyState<2;
    $('previewAnchor').textContent=running?'Inspecting anchor…':startingOperation==='preview_anchor'?'Preparing preview…':'Preview anchor on this frame';
    $('previewAnchor').setAttribute('aria-busy',String(running||startingOperation==='preview_anchor'));
    $('cancelAnchorPreview').hidden=!running;$('cancelAnchorPreview').disabled=$('cancel').disabled;
    $('showAnchorPreview').disabled=false;
    if(running){$('anchorPreviewStatus').textContent=$('progressText').textContent;return;}
    const valid=anchorPreview&&anchorPreview.key===anchorPreviewKey(),data=valid?anchorPreview.data:null;
    $('anchorPreviewStatus').textContent=!inside?'Choose a frame inside this tracking region.':!data?'Preview shows the main anchor in gold and additional anchors in blue.':
        Math.abs(data.at_ms-at)>.002?`Preview is for F ${data.frame}. Preview this frame to update it.`:
        `F ${data.frame} · ${data.anchors[0].name==='mask_anchor'?'painted 3D patch':data.anchors[0].name.replaceAll('_',' ')}${data.surface_points?` · ${data.surface_points} mesh vertices`:''} · original frame${data.anchors.some(a=>!a.available)?' · some additional anchors could not be located':''}`;
}
function drawAnchorPreview(ctx,point,w,h) {
    const data=anchorPreview?.data;
    if(!data||!$('showAnchorPreview').checked||previewClip||previewLoading||anchorPreview.key!==anchorPreviewKey()||Math.abs(data.at_ms-frames.at(activeFrame()))>.002)return;
    ctx.save();ctx.beginPath();ctx.rect(0,0,w,h);ctx.clip();
    const dot=(p,color,radius)=>{if(!p?.every(Number.isFinite))return;const [x,y]=point(p);ctx.fillStyle=color;ctx.beginPath();ctx.arc(x,y,radius,0,Math.PI*2);ctx.fill();};
    for(const p of data.surface)dot(p,'#ffd47a99',2);
    for(const anchor of data.anchors){
        if(!anchor.available)continue;
        for(const i of anchor.indices)dot(data.landmarks[i],anchor.primary?'#ffe2a388':'#8bc9ff88',2.5);
        const [x,y]=point(anchor.pixel),color=anchor.primary?'#ffd47a':'#8bc9ff';
        ctx.strokeStyle='#16202a';ctx.lineWidth=5;ctx.beginPath();ctx.arc(x,y,7,0,Math.PI*2);ctx.stroke();
        ctx.strokeStyle=color;ctx.lineWidth=2;ctx.stroke();ctx.beginPath();ctx.moveTo(x-11,y);ctx.lineTo(x+11,y);ctx.moveTo(x,y-11);ctx.lineTo(x,y+11);ctx.stroke();
        const text=(anchor.primary?'Main: ':'')+(anchor.name==='mask_anchor'?'painted patch':anchor.name.replaceAll('_',' '));
        ctx.font='bold 12px system-ui';const tx=Math.max(4,Math.min(w-ctx.measureText(text).width-4,x+13)),ty=Math.max(16,Math.min(h-5,y-12));
        ctx.strokeStyle='#16202a';ctx.lineWidth=4;ctx.strokeText(text,tx,ty);ctx.fillStyle=color;ctx.fillText(text,tx,ty);
    }
    ctx.restore();$('previewStatus').textContent=`Anchor preview · F ${data.frame} · gold: main · blue: additional`;
}
function draw() {
    if (!state || !frames) return;
    drawSource(); $("time").textContent = `F ${frames.containing(playhead)} · ${formatTime(playhead,3,duration() >= 3600000)}`;
    if (document.activeElement !== $("goTime")) $("goTime").value = useFrames()?frames.containing(playhead):(playhead/1000).toFixed(3);
    $("previous").disabled=frames.containing(playhead)<=frames.first;
    $("next").disabled=frames.containing(playhead)>=frames.end-1;
    $("previousHeld").disabled=heldTarget(-1)===undefined;$("nextHeld").disabled=heldTarget(1)===undefined;
}
function renderNavigation() {
    if (!state || !frames) return;
    view = timelineView(duration(), view);
    if(selectedCut!==null&&(!$("showCuts").checked||selectedCut<view.start_ms||selectedCut>view.start_ms+view.span_ms)){selectedCut=null;cutRangeReady=false;}
    $("zoom").value = spanSlider(duration(), view.span_ms);
    $("pan").min=useFrames()?frames.first:sourceBounds()[0];$("pan").max = useFrames()?frames.containing(Math.max(sourceBounds()[0],duration()-view.span_ms)):Math.max(sourceBounds()[0],duration()-view.span_ms); $("pan").value = useFrames()?frames.containing(view.start_ms):view.start_ms;
    $("follow").checked = view.follow !== false;
    const thumbKey=`${view.start_ms}:${view.span_ms}`;if(thumbKey!==thumbnailView){thumbnailView=thumbKey;scheduleThumbs();}
    $("viewLabel").textContent = useFrames()?`Frames ${frames.ceil(view.start_ms)} – ${frames.ceil(view.start_ms+view.span_ms)} · ${frames.end-frames.first} frames · ${formatTime(clipDuration(),1)}`:`${formatTime(view.start_ms,1)} – ${formatTime(view.start_ms+view.span_ms,1)} / ${formatTime(duration(),1)}`;
    const [a,b] = selectionRange(plan,state.info);
    for (const [id,t] of [["selectionIn",a],["selectionOut",b]]) if (document.activeElement !== $(id)) $(id).value = positionValue(t);
    const selectedFrames=frames.ceil(b)-frames.ceil(a);
    $("selectionLabel").textContent = b-a>1 ? `${selectedFrames} frame${selectedFrames===1?"":"s"} · ${((b-a)/1000).toFixed(3)} s selected` : "No frames selected · I to mark In, O to mark Out";
    $("fitSelection").disabled = b-a<1;
    const enabledSelected=[...plan.tracking,...plan.stabilization].filter(r=>r.enabled!==false&&(plan.selected_ids||[]).includes(r.id));
    $('processSelected').disabled=busy||!!startingOperation||!(b>a);
    $('processRegions').disabled=busy||!!startingOperation||!enabledSelected.length;
    $('rangeSummary').textContent=b>a?`Marked: ${positionLabel(a)} – ${positionLabel(b)} (exclusive)`:'No marked range';
    $('selectedRegionsSummary').textContent=`${enabledSelected.length} selected region${enabledSelected.length===1?'':'s'}`;
    $('selectedRegionsSummary').title=enabledSelected.map(r=>r.name).join(', ');
    $('processSelected').title=b>a?`Process only ${positionLabel(a)} – ${positionLabel(b)} (exclusive)`:'Mark In and Out first';
    $('processRegions').title=enabledSelected.length?`Process full regions: ${enabledSelected.map(r=>r.name).join(', ')}`:'Select enabled regions first';
    $("processAutomatic").disabled=busy;$("automaticPeople").disabled=busy;
    $("detectCuts").disabled=busy;$("cutSensitivity").disabled=busy;
    $("previousCut").disabled=neighboringCut(cuts(),playhead,-1)===null;
    $("nextCut").disabled=neighboringCut(cuts(),playhead,1)===null;
    const hasScan=state.scene_cuts?.source_id===state.info.source_id;
    $("selectShot").disabled=!hasScan||busy;
    $("cutStatus").textContent=busy&&processPending?.operation==="detect_cuts"?"Scanning…":hasScan?`${cuts().length} cut markers${state.scene_cuts.cache_hit?" · cached":""}`:"No cut scan yet";
    $("markOut").title=selectedCut!==null?"End the selection exactly at this cut, before its first frame (O)":"End the selection after the displayed frame, including it (O)";
    $("selectionHint").textContent=selectedCut!==null?"Cut selected: In / Out use the boundary before this frame.":"Mark Out includes the displayed frame. Out is the boundary after the selection.";
    $("cutActions").hidden=selectedCut===null;
    const active=selected()?.region;
    for(const id of ['timelineSplit','split'])$(id).disabled=busy||!active||active.locked||playhead<=active.start_ms+1||playhead>=active.end_ms-1;
    $("timelineSplit").title=active?`Split ${active.name} at ${positionLabel(playhead)} (S)`:'Select a region, then seek to the frame where it changes';
    if(selectedCut!==null){
        $("selectedCutLabel").textContent=`Cut ${cutIndex(cuts(),selectedCut)+1} · Frame ${frames.ceil(selectedCut)}`;
        for(const [id,direction]of [["cutBefore",-1],["cutAfter",1]]){const range=cutSideRange(cuts(),selectedCut,direction,...sourceBounds());$(id).disabled=!range||range[1]-range[0]<1;}
        $("cutRegion").disabled=busy||!cutRangeReady||b-a<1;
        $("cutRegionRange").textContent=cutRangeReady&&b>a?`${positionLabel(a)} – ${positionLabel(b)} (exclusive)`:"Select a shot, set In / Out, or Shift-click another cut";
        $("cutPrevious").disabled=neighboringCut(cuts(),selectedCut,-1)===null;$("cutNext").disabled=neighboringCut(cuts(),selectedCut,1)===null;
        const lane=$("cutSplitLane").value,targets=(lane==='both'?LANES:[lane]).flatMap(name=>plan[name].filter(r=>r.enabled!==false&&r.start_ms<selectedCut&&r.end_ms>selectedCut));
        $("cutSplit").disabled=busy||!targets.length||targets.some(r=>r.locked);
        $("cutSplit").title=targets.some(r=>r.locked)?'Unlock the regions at this frame before splitting.':targets.length?`Split ${targets.map(r=>r.name).join(' and ')} into independent left and right regions.`:'No region crosses this cut in the chosen lane.';
    }
}
function resultState(region,result){
    if(!result)return '';
    if(!['complete','partial','locked'].includes(result.state))return result.state||'';
    const entry=result.region?result:processedRegions[region.id];
    const cached=resultStates.get(region.id);
    if(cached?.region===region&&cached.result===result&&cached.entry===entry&&cached.stabilization===plan.stabilization)return cached.value;
    const current=trackingResultCurrent(region,entry,plan.stabilization);
    const value=current===true?result.state:current===false?'needs processing':'previous result';
    resultStates.set(region.id,{region,result,entry,stabilization:plan.stabilization,value});
    return value;
}
function reportMap() { return new Map((state?.report?.regions || []).map(item => [item.id,item])); }
function renderTimelines() {
    if (!state || !plan || !frames) return;
    const [ruler,w,rh] = prepare($("ruler")), ticks = useFrames()?frames.ticks(view.start_ms,view.start_ms+view.span_ms,w):rulerTicks(view.start_ms,view.start_ms+view.span_ms,w,duration());
    const x = t => (t-view.start_ms)/view.span_ms*w;
    ruler.font="10px ui-monospace,monospace";ruler.fillStyle="#a9bece";ruler.strokeStyle="#3c5362";
    for (const tick of ticks) {const xx=x(tick.time);if(tick.label)ruler.fillText(tick.label,xx+3,14);ruler.beginPath();ruler.moveTo(xx,tick.label?20:rh-5);ruler.lineTo(xx,rh);ruler.stroke();}
    $("ruler").setAttribute("aria-label",`${useFrames()?"Source frame":"Original video time"} ruler · current frame ${frames.containing(playhead)} · Arrow keys step frames; I and O mark selection`);
    const guides=$("showCuts").checked?visibleCuts(cuts(),view.start_ms,view.span_ms,w):[];
    ruler.fillStyle="#d1cfa4";
    for(const at of guides){const xx=x(at);ruler.beginPath();ruler.moveTo(xx-3,18);ruler.lineTo(xx+3,18);ruler.lineTo(xx,23);ruler.fill();}
    renderCutButtons(w);
    if (playhead>=view.start_ms && playhead<=view.start_ms+view.span_ms) {ruler.fillStyle="#eef6fa";ruler.beginPath();ruler.moveTo(x(playhead)-5,rh-10);ruler.lineTo(x(playhead)+5,rh-10);ruler.lineTo(x(playhead),rh-3);ruler.fill();}
    const [a,b]=selectionRange(plan,state.info), states=reportMap();
    for (const lane of LANES) {
        const element=laneElement(lane), rows=regionRows(plan[lane]), height=Math.max(layout.settings[lane],rows.count*44+16),pitch=(height-16)/rows.count;
        element.style.height=`${height}px`;
        const [ctx,cw,ch]=prepare(element.querySelector("canvas"));ctx.strokeStyle="#2b3e4b";
        for(const tick of ticks){const xx=(tick.time-view.start_ms)/view.span_ms*cw;ctx.beginPath();ctx.moveTo(xx,0);ctx.lineTo(xx,ch);ctx.stroke();}
        const bars=element.querySelector(".region-bars"), existing=new Map([...bars.children].map(child=>[child.dataset.id,child]));
        for(const region of plan[lane]) {
            const visible=region.end_ms>view.start_ms&&region.start_ms<view.start_ms+view.span_ms;
            let bar=existing.get(region.id);existing.delete(region.id);
            if(!visible){bar?.remove();continue;}
            if(!bar){bar=document.createElement("button");bar.className="region-bar";bar.type="button";bar.dataset.id=region.id;
                for(const edge of ["start","end"]){const handle=document.createElement("span");handle.className=`handle ${edge}`;handle.dataset.edge=edge;bar.append(handle);}
                const title=document.createElement("span");title.className="region-title";const mark=document.createElement("span");mark.className="region-state";bar.append(title,mark);bars.append(bar);
                bar.onkeydown=event=>{if(event.key==="Enter"){event.preventDefault();selectRegion(region.id,event.ctrlKey||event.metaKey);}};
            }
            const left=(region.start_ms-view.start_ms)/view.span_ms*100,right=(region.end_ms-view.start_ms)/view.span_ms*100;
            bar.style.left=`${Math.max(0,left)}%`;bar.style.width=`${Math.max(.05,Math.min(100,right)-Math.max(0,left))}%`;bar.style.top=`${8+rows.positions.get(region.id)*pitch}px`;bar.style.height=`${Math.min(160,pitch-9)}px`;
            bar.classList.toggle("selected",(plan.selected_ids||[]).includes(region.id));bar.classList.toggle("locked",!!region.locked);bar.classList.toggle("disabled-region",region.enabled===false);
            bar.querySelector(".region-title").textContent=`${region.locked?"🔒 ":""}${region.name}${lane==="tracking"?" · "+region.anchor.replaceAll("_"," ")+(region.additional_anchors?.length?` +${region.additional_anchors.length}`:""):""}`;
            const result=states.get(region.id),changedBounds=result&&['start_ms','end_ms'].some(key=>result[key]!==undefined&&result[key]!==region[key]);
            bar.querySelector(".region-state").textContent=changedBounds?'needs processing':lane==='tracking'?resultState(region,result):result?.state||"";
            bar.title=`${region.name} · ${positionLabel(region.start_ms)} – ${positionLabel(region.end_ms)} (exclusive)${region.locked?" · Locked":""}`;
            const rendered=lane==='stabilization'?renderedClips.find(r=>r.id===region.id):null,health=trackingDetails.get(rendered?.url)?.health;
            bar.querySelector('.region-state').dataset.held=String(!!health?.counts.held);
            if(health){bar.querySelector('.region-state').textContent=health.counts.held?`${(health.counts.held/health.total*100).toFixed(0)}% held`:'tracked';bar.title+=' · '+trackingSummary(health);}
            if(rendered&&!timelineRenderCurrent(rendered,region)){bar.querySelector('.region-state').textContent='previous result';bar.title+=' · Settings changed; track this interval again';}
            bar.setAttribute("aria-label",bar.title);bar.setAttribute("aria-pressed",String((plan.selected_ids||[]).includes(region.id)));
            bar.querySelectorAll('.reference-keyframe').forEach(mark=>mark.remove());
            const markedKeys=lane==='stabilization'?referenceKeys(region.reference):region.anchor==='mask_anchor'&&region.mask_anchor?.strokes.length?[{frame:region.mask_anchor.frame,points:[1]}]:[];
            for(const [i,key]of markedKeys.entries()){
                const frame=frames.ceil(region.start_ms)+key.frame,at=frames.at(frame);
                if(!key.points.length||at<view.start_ms||at>=Math.min(region.end_ms,view.start_ms+view.span_ms))continue;
                const mark=document.createElement('span');mark.className='reference-keyframe';mark.textContent='◆';
                mark.dataset.referenceFrame=frame;mark.title=`${lane==='tracking'?'Mask anchor':'Reference '+(i+1)} · F ${frame} · click to seek`;
                mark.style.left=`${100*(at-Math.max(region.start_ms,view.start_ms))/(Math.min(region.end_ms,view.start_ms+view.span_ms)-Math.max(region.start_ms,view.start_ms))}%`;
                bar.append(mark);
            }
        }
        for(const child of existing.values())child.remove();
        const range=element.querySelector(".range-highlight"), left=clamp((a-view.start_ms)/view.span_ms,0,1)*100,right=clamp((b-view.start_ms)/view.span_ms,0,1)*100;
        range.style.display=b>a&&right>left?"block":"none";range.style.left=`${left}%`;range.style.width=`${right-left}%`;
        const [overlay,ow,oh]=prepare(element.querySelector(".cut-guides"));overlay.strokeStyle="#d9d4a34d";overlay.lineWidth=1;overlay.setLineDash([3,4]);
        for(const at of guides){const xx=(at-view.start_ms)/view.span_ms*ow;overlay.beginPath();overlay.moveTo(xx,0);overlay.lineTo(xx,oh);overlay.stroke();}
        if(selectedCut!==null){const xx=(selectedCut-view.start_ms)/view.span_ms*ow;overlay.setLineDash([]);overlay.strokeStyle="#ffe0a8";overlay.beginPath();overlay.moveTo(xx,0);overlay.lineTo(xx,oh);overlay.stroke();}
        const head=element.querySelector(".playhead");head.hidden=playhead<view.start_ms||playhead>view.start_ms+view.span_ms;head.style.left=`${(playhead-view.start_ms)/view.span_ms*100}%`;
    }
    drawOverview();
}
function renderCutButtons(width){
    const target=$("cutMarkers"),existing=new Map([...target.children].map(b=>[Number(b.dataset.at),b]));
    // Bound the number of interactive targets at overview zoom. Finer cuts remain
    // accessible through Next/Previous or zooming in; faint guides still show all.
    const visible=$("showCuts").checked?visibleCuts(cuts(),view.start_ms,view.span_ms,width/18):[];
    if(selectedCut!==null&&!visible.includes(selectedCut))visible.push(selectedCut);
    for(const at of visible){
        let button=existing.get(at);existing.delete(at);
        if(!button){button=document.createElement("button");button.type="button";button.className="cut-marker";button.dataset.at=at;target.append(button);
            button.onclick=event=>{event.preventDefault();event.stopPropagation();selectCut(at,event.shiftKey);};
            button.ondblclick=event=>{event.preventDefault();selectCut(at);selectCutSide(1);};
        }
        button.style.left=`${(at-view.start_ms)/view.span_ms*100}%`;
        button.setAttribute("aria-pressed",String(at===selectedCut));
        button.setAttribute("aria-label",`Cut ${cutIndex(cuts(),at)+1}, frame ${frames.ceil(at)}`);
        button.title=`${button.getAttribute("aria-label")} · click for In / Out · Shift-click another cut to select between · double-click for the following shot`;
    }
    for(const button of existing.values())button.remove();
    if(selectedCut!==null){const panel=$("cutActions"),x=(selectedCut-view.start_ms)/view.span_ms*width;panel.style.left=`${clamp(x-panel.offsetWidth/2,0,Math.max(0,width-panel.offsetWidth))}px`;}
}
function clearCut(){selectedCut=null;cutRangeReady=false;if(frames&&state){renderNavigation();renderTimelines();}}
function selectCut(at,extend=false){
    if(!cuts().includes(at))return;
    const anchor=selectedCut;
    seek(at);selectedCut=at;
    view=followView(duration(),view,at);
    if(extend&&anchor!==null){cutRangeReady=true;setSelection(anchor,at);}
    renderNavigation();renderTimelines();
}
function selectCutSide(direction){
    const range=cutSideRange(cuts(),selectedCut,direction,...sourceBounds());
    if(!range||range[1]-range[0]<1)return;
    cutRangeReady=true;setSelection(...range);
}
function drawOverview() {
    const [ctx,w,h]=prepare($("overview")),d=clipDuration(),low=sourceBounds()[0];
    for(const [i,lane] of LANES.entries())for(const region of plan[lane]){ctx.fillStyle=region.enabled===false?"#40505b":i?"#ad925d":"#4d987e";ctx.fillRect((region.start_ms-low)/d*w,5+i*12,Math.max(1,(region.end_ms-region.start_ms)/d*w),9);}
    if($("showCuts").checked){ctx.fillStyle="#d9d4a373";for(const at of visibleCuts(cuts(),low,d,w))ctx.fillRect((at-low)/d*w,0,1,h);}
    const left=(view.start_ms-low)/d*w,ww=view.span_ms/d*w;ctx.fillStyle="#a4ccff14";ctx.fillRect(left,0,ww,h);ctx.strokeStyle="#9dc5f1";ctx.strokeRect(left+.5,.5,Math.max(1,ww-1),h-1);
    ctx.strokeStyle="#fff";ctx.beginPath();ctx.moveTo((playhead-low)/d*w,0);ctx.lineTo((playhead-low)/d*w,h);ctx.stroke();
}
function renderInspector() {
    const found=selected();$("regionForm").hidden=!found;$("noRegion").hidden=!!found;$("regionKind").textContent=found?found.lane==="tracking"?"SAM3D tracking":"CoTracker3 stabilization":"";
    meshEditor.render();
    if(!found)return;
    const {region,lane}=found, disabled=busy||!!startingOperation||!!region.locked;
    $("backToStabilization").hidden=lane!=="tracking"||!regionById(plan,anchorOrigin);
    if(lane==="tracking"){
        $("anchor").querySelector("[data-detailed]")?.remove();
        if(region.anchor!=="mask_anchor"&&!ANCHORS.includes(region.anchor)){
            const option=new Option(`${region.anchor.replaceAll("_"," ")} · detailed`,region.anchor);option.dataset.detailed="true";$("anchor").append(option);
        }
    }
    const values={regionName:region.name,regionIn:positionValue(region.start_ms),regionOut:positionValue(region.end_ms)};
    $('automaticRegionReview').hidden=!region.automatic;$('automaticSuggestionLabel').hidden=!region.automatic;
    if(region.automatic){$('automaticRegionReview').textContent=autoReviews().find(row=>row.region.id===region.id)?.reasons.join(' · ')||'Automatic scene · review the suggested anchor in Motion Studio.';$('automaticSuggestion').checked=region.automatic.suggest;}
    if(lane==="tracking")Object.assign(values,{anchor:region.anchor,person:region.person,smoothing:region.smoothing_ms,rois:JSON.stringify(region.rois),axisSettings:JSON.stringify(region.settings||{},null,2)});
    else Object.assign(values,{crop:JSON.stringify(region.reference.crop_xywh),trackingMode:region.reference.tracking_mode||'online'});
    for(const [id,value] of Object.entries(values))if(document.activeElement!==$(id))$(id).value=value;
    $("regionEnabled").checked=region.enabled!==false;$("regionLock").textContent=region.locked?"Unlock":"Lock";$("lockNotice").hidden=!region.locked;
    $("trackingSettings").hidden=lane!=="tracking";$("stabilizationSettings").hidden=lane!=="stabilization";
    for(const control of $("regionForm").querySelectorAll("input,textarea,select,button"))control.disabled=disabled;
    for(const id of ["regionLock","regionRange","referenceFirst","cropZoom","referenceKeyframes"])$(id).disabled=busy;
    $("split").disabled=disabled||playhead<=region.start_ms+1||playhead>=region.end_ms-1;
    $("referenceMode").disabled=disabled;
    if(disabled)$("referenceMode").value="review";
    if(lane==='stabilization'){renderReferenceKeys(region);maskSteps.render();}
    if(lane==="tracking"){
        $("additionalAnchors").replaceChildren(...ANCHORS.filter(anchor=>anchor!==region.anchor).map(anchor=>{
            const label=document.createElement("label"),input=document.createElement("input");
            input.type="checkbox";input.value=anchor;input.checked=(region.additional_anchors||[]).includes(anchor);input.disabled=disabled;
            input.onchange=()=>attempt(()=>updateRegion({additional_anchors:[...(region.additional_anchors||[]).filter(anchor=>!ANCHORS.includes(anchor)),...[...$("additionalAnchors").querySelectorAll("input:checked")].map(el=>el.value)]}));
            label.append(input,anchor.replaceAll("_"," "));return label;
        }));
        $("detailedAnchorTracks").replaceChildren(...(region.additional_anchors||[]).filter(anchor=>!ANCHORS.includes(anchor)).map(anchor=>{
            const button=document.createElement("button");button.type="button";button.textContent=`${anchor.replaceAll("_"," ")} ×`;button.title=`Remove extra ${anchor.replaceAll("_"," ")} track`;button.disabled=disabled;
            button.onclick=()=>attempt(()=>updateRegion({additional_anchors:region.additional_anchors.filter(a=>a!==anchor)}));return button;
        }));
        for(const row of $("detailedAnchorResults").querySelectorAll("[data-anchor]")){
            const main=row.dataset.anchor===region.anchor,button=row.querySelector("button"),extra=row.querySelector("input");
            button.textContent=main?"Main anchor":"Use as main";button.disabled=disabled||main;button.setAttribute("aria-pressed",String(main));
            extra.checked=(region.additional_anchors||[]).includes(row.dataset.anchor);extra.disabled=disabled||main;
        }
        filterDetailedAnchors();
        meshEditor.render();subject.render();
    }
}
function filterDetailedAnchors(){
    const terms=$("anchorSearch").value.toLowerCase().replaceAll("_"," ").trim().split(/\s+/).filter(Boolean);let count=0;
    for(const group of $("detailedAnchorResults").children){
        let visible=0;
        for(const row of group.querySelectorAll("[data-anchor]")){
            row.hidden=!terms.every(term=>row.dataset.anchor.replaceAll("_"," ").includes(term));if(!row.hidden)visible++;
        }
        group.hidden=!visible;count+=visible;
    }
    $("noAnchorResults").hidden=count>0;$("detailedAnchorCount").textContent=`· ${count} landmarks`;
}
for(const [name,anchors] of Object.entries(DETAILED_ANCHOR_GROUPS)){
    const group=document.createElement("section"),heading=document.createElement("h3");heading.textContent=name;group.append(heading);
    for(const anchor of anchors){
        const row=document.createElement("div"),label=document.createElement("span"),button=document.createElement("button"),extraLabel=document.createElement("label"),extra=document.createElement("input");
        row.dataset.anchor=anchor;row.className="detailed-anchor-row";label.textContent=anchor.replaceAll("_"," ");button.type="button";button.textContent="Use as main";button.setAttribute("aria-label",`Use ${label.textContent} as main anchor`);
        button.onclick=()=>attempt(()=>updateRegion({anchor}));extra.type="checkbox";extra.setAttribute("aria-label",`Extra ${label.textContent} track`);
        extra.onchange=()=>attempt(()=>{const region=selected()?.region;if(!region)return;const values=new Set(region.additional_anchors||[]);if(extra.checked)values.add(anchor);else values.delete(anchor);updateRegion({additional_anchors:[...values]});});
        extraLabel.append(extra,"Extra track");row.append(label,button,extraLabel);group.append(row);
    }
    $("detailedAnchorResults").append(group);
}
$("anchorSearch").oninput=filterDetailedAnchors;
$("browseAnchors").onclick=()=>{
    const panel=$("regionSettingsPane"),picker=$("detailedAnchors");picker.open=true;
    panel.scrollTop+=picker.getBoundingClientRect().top-panel.getBoundingClientRect().top;
    $("anchorSearch").focus({preventScroll:true});
};
function renderReport() {
    const reviewRows=autoReviews();$('nextAutoReview').disabled=busy||!reviewRows.length;
    const autoCount=plan.tracking.filter(r=>r.automatic).length;
    $('automaticSummary').textContent=autoCount?`${autoCount} automatic scenes · ${reviewRows.length} need review`:'';
    const report=state.report||{},target=$('report');target.replaceChildren();
    for(const item of report.regions||[]) {
        const region=regionById(plan,item.id)?.region,row=document.createElement("div");row.className=`report-row ${item.state||"pending"}`;
        const name=document.createElement("span");name.className="name";name.textContent=region?.name||item.id;
        const range=document.createElement("span");range.className="muted";range.textContent=`${formatTime(item.start_ms||0,1)} – ${formatTime(item.end_ms||0,1)}`;
        const label=document.createElement("span");label.className="report-state";label.textContent=item.error||(region&&regionById(plan,item.id)?.lane==='tracking'?resultState(region,item):item.state)||"pending";
        const button=document.createElement("button");button.textContent="Show";button.onclick=()=>{if(region){selectRegion(region.id);fitRange(region.start_ms,region.end_ms);seek(region.start_ms);}};
        if(item.review?.length){label.textContent+=' · Needs review';label.title=item.review.join(' · ');}
        row.append(name,range,label,button);target.append(row);
    }
    for(const warning of report.warnings||[]){const p=document.createElement("div");p.className="report-warning";p.textContent=typeof warning==="string"?warning:JSON.stringify(warning);target.append(p);}
    const count=plan.tracking.filter(r=>r.enabled!==false).length,stable=plan.stabilization.filter(r=>r.enabled!==false).length;
    $("regionSummary").textContent=`${count} tracking · ${stable} stabilization regions`;
    const project=state.project||report.project;
    $("openStudio").hidden=!project;if(project){const url=new URL("viewer.html",location.href);url.searchParams.set("timeline",state.session);url.searchParams.set("project",typeof project==="string"?project:project.name||project.project);if(state.editor_session)url.searchParams.set("session",state.editor_session);$("openStudio").href=url;}
}
function render() {
    if(!plan)return;
    if(choosePreviewMedia())requestSourceSeek(mediaTime(frames.seekTime(playhead)));
    renderInspector();renderPreviewControls();renderNavigation();renderTimelines();renderReport();draw();
    $("undo").disabled=busy||!history.length;$("download").disabled=false;$("restorePlan").disabled=busy||!!startingOperation;$("apply").disabled=busy||!!applyPending;
    $("processAll").disabled=busy||!plan.tracking.some(r=>r.enabled!==false);$("processUnfinished").disabled=$("processAll").disabled;
    for(const id of ["addTracking","addStabilization","chunkSeconds","joinMs","gapPolicy"])$(id).disabled=busy;
    $("cancel").hidden=!busy;$("cancel").disabled=false;
    for(const [id,value] of [["chunkSeconds",plan.chunk_seconds||30],["joinMs",plan.join_ms??200],["gapPolicy",plan.gap_policy||"hold"]])if(document.activeElement!==$(id))$(id).value=value;
}
function addRegion(lane) {
    const [a,b]=selectionRange(plan,state.info),[low,high]=sourceBounds();
    let start=a,end=b;
    if(end-start<1) {start=clamp(playhead,low,high-1);end=Math.min(high,start+Math.min(10000,view.span_ms));}
    start=frames.snap(start);end=Math.max(frames.at(frames.containing(start)+1),frames.snap(end,true));
    const next=regionFromSelection({...plan,selection:[start,end]},lane,uuid,state.info,frames);
    activeId=next.selected_ids[0];edit(next,'Region ready · existing coverage was isolated where necessary');
    showInspectorTab("region");
    if(lane==="stabilization")seek(start);
}
function sourcePosition(event) {
    if(!sourceMap)return null;const r=$("sourceCanvas").getBoundingClientRect(),{crop,scale,ox,oy}=sourceMap;
    const x=(event.clientX-r.left-ox)/scale+crop[0],y=(event.clientY-r.top-oy)/scale+crop[1];
    if(x<crop[0]||y<crop[1]||x>crop[0]+crop[2]||y>crop[1]+crop[3])return null;
    return [clamp(x,0,state.info.width-1),clamp(y,0,state.info.height-1)];
}
function renderReferenceKeys(region) {
    const keys=referenceKeys(region.reference),first=frames.ceil(region.start_ms),frame=activeFrame()-first;
    const key=keys.find(k=>k.frame===frame),expected=Math.max(...keys.map(k=>k.points.length));
    $("referenceKeyframes").replaceChildren(new Option('Reference frames…',''),...keys.map(k=>new Option(`F ${first+k.frame} · ${k.points.length} points${k.unconfirmed?.length?` · ${k.unconfirmed.length} to review`:""}`,String(k.frame))));
    $("referenceKeyframes").value=key?String(frame):'';
    $("referencePoint").replaceChildren(...Array.from({length:key?Math.max(key.points.length+(keys.length===1?1:0),expected):expected},(_,i)=>new Option(`Point ${i+1}${i>=(key?.points.length||0)?' · place':''}`,String(i))));
    $("referencePoint").value=String(key?.unconfirmed?.[0]??(key?Math.min(key.points.length,keys.length===1?key.points.length:Math.max(0,expected-1)):0));
    const marked=keys.filter(k=>k.points.length).length;
    $("pointCount").textContent=`${key?.points.length||0} points on this frame · ${marked} marked ${marked===1?'frame':'frames'}`;
    const disabled=busy||region.locked;
    $("markReference").disabled=disabled||playhead<region.start_ms||playhead>=region.end_ms;
    $("removeReferenceKey").disabled=disabled||!key;
}
$("trackingMode").onchange=()=>attempt(()=>updateRegion({reference:{...selected().region.reference,tracking_mode:$("trackingMode").value}}));
$("markReference").onclick=()=>attempt(()=>{
    maskSteps.setStep("track");
    const region=selected().region,frame=activeFrame()-frames.ceil(region.start_ms);
    if(frame<0||activeFrame()>=frames.ceil(region.end_ms))throw new Error('Seek inside this stabilization region first.');
    $("previewVariant").value='original';pause();
    const health=trackingDetails.get(selectedRender()?.url)?.health;
    const predicted=prefillReferenceKey(region.reference,health?.config,health,frame);
    updateRegion({reference:predicted&&!referenceKeys(region.reference).some(k=>k.frame===frame)
        ?withReferenceKeys(region.reference,[...referenceKeys(region.reference).filter(k=>k.points.length),predicted]):addReferenceKey(region.reference,frame)});
    $("referenceMode").value='points';seek(frames.at(frames.ceil(region.start_ms)+frame));
});
$("referenceKeyframes").onchange=()=>{
    if($("referenceKeyframes").value==='')return;
    $("previewVariant").value='original';seek(frames.at(frames.ceil(selected().region.start_ms)+Number($("referenceKeyframes").value)));
};
$("removeReferenceKey").onclick=()=>attempt(()=>{
    const region=selected().region,frame=activeFrame()-frames.ceil(region.start_ms);
    updateRegion({reference:withReferenceKeys(region.reference,referenceKeys(region.reference).filter(k=>k.frame!==frame))});
});
function referenceEditable() {
    const found=selected();
    if(!found||found.lane!=="stabilization"||busy||startingOperation||$('regionSettingsPane').hidden||!video.paused||found.region.locked||previewClip||previewLoading||requestedSeek!==null)return false;
    if(video.seeking||playhead<found.region.start_ms||playhead>=found.region.end_ms)return false;
    if($("referenceMode").value==='points'&&!referenceKeys(found.region.reference).some(k=>k.frame===activeFrame()-frames.ceil(found.region.start_ms))){status("Click Mark reference frame before placing points here.");return false;}
    return true;
}
$("sourceCanvas").onpointerdown=event=>{
    if(event.button!==0)return;
    if(subject.down(sourcePosition(event))){$("sourceCanvas").setPointerCapture(event.pointerId);event.preventDefault();return;}
    if(meshEditor.pointerDown(sourcePosition(event))){$("sourceCanvas").setPointerCapture(event.pointerId);event.preventDefault();return;}
    if(!referenceEditable())return;
    const p=sourcePosition(event);if(!p)return;
    if(maskSteps.pointerDown(p)){$("sourceCanvas").setPointerCapture(event.pointerId);event.preventDefault();return;}
    if($("referenceMode").value==="crop"){sourceDrag={start:p,end:p};$("sourceCanvas").setPointerCapture(event.pointerId);}
    else if($("referenceMode").value==="points")attempt(()=>{
        const region=selected().region,frame=activeFrame()-frames.ceil(region.start_ms),slot=Number($("referencePoint").value);
        updateRegion({reference:putReferencePoint(region.reference,frame,slot,p)});
    });
};
$("sourceCanvas").onpointermove=event=>{if(subject.move(sourcePosition(event))||meshEditor.pointerMove(sourcePosition(event))||maskSteps.pointerMove(sourcePosition(event)))return;if(sourceDrag){const p=sourcePosition(event);if(p)sourceDrag.end=p;drawSource();}};
$("sourceCanvas").onpointerup=()=>{
    if(subject.up()||meshEditor.pointerUp()||maskSteps.pointerUp())return;
    if(!sourceDrag)return;const {start:a,end:b}=sourceDrag;sourceDrag=null;
    const crop=[Math.floor(Math.min(a[0],b[0])),Math.floor(Math.min(a[1],b[1])),Math.round(Math.abs(a[0]-b[0])),Math.round(Math.abs(a[1]-b[1]))];
    if(crop[2]>=2&&crop[3]>=2)attempt(()=>{const reference=clone(selected().region.reference);reference.crop_xywh=crop;updateRegion({reference});});else drawSource();
};
$("sourceCanvas").onpointercancel=()=>{meshEditor.cancel();maskSteps.cancel();subject.cancel();sourceDrag=null;drawSource();};
$("sourceCanvas").oncontextmenu=event=>{
    if($("referenceMode").value!=="points"||!referenceEditable())return;event.preventDefault();const p=sourcePosition(event);if(!p)return;
    const region=selected().region,reference=region.reference,key=referenceKeys(reference).find(k=>k.frame===activeFrame()-frames.ceil(region.start_ms));let best=-1,distance=12/sourceMap.scale;
    key.points.forEach((point,i)=>{const d=Math.hypot(point[0]-p[0],point[1]-p[1]);if(d<distance){best=i;distance=d;}});
    if(best>=0)attempt(()=>updateRegion({reference:removeReferencePoint(reference,best)}));
};
function timelineTime(event,element,snap=true) {const r=element.getBoundingClientRect(),time=clamp(view.start_ms+(event.clientX-r.left)/r.width*view.span_ms,...sourceBounds());return snap?snapTime(time,r.width):time;}
for(const lane of LANES) {
    const element=laneElement(lane);
    element.onpointerdown=event=>{
        if(event.button!==0||!plan)return;event.preventDefault();const t=timelineTime(event,element),bar=event.target.closest(".region-bar"),found=bar?regionById(plan,bar.dataset.id):null;
        const marked=event.target.closest('.reference-keyframe');
        if(marked&&found){$("previewVariant").value='original';selectRegion(found.region.id,false,frames.at(Number(marked.dataset.referenceFrame)));return;}
        if(event.shiftKey){timelineDrag={kind:"selection",lane,anchor:t,startX:event.clientX};setSelection(t,t,false);}
        else if(found){selectRegion(found.region.id,event.ctrlKey||event.metaKey);timelineDrag={kind:$("editRegions").checked&&!found.region.locked&&!busy?(event.target.dataset.edge||"move"):"seek",lane,id:found.region.id,original:clone(found.region),time:t,startX:event.clientX,changed:false};}
        else {timelineDrag={kind:"seek",lane,time:t,startX:event.clientX};seek(t);}
        element.setPointerCapture(event.pointerId);
    };
    element.onpointermove=event=>{
        if(!timelineDrag||timelineDrag.lane!==lane)return;const drag=timelineDrag,t=timelineTime(event,element,false),width=element.getBoundingClientRect().width;
        if(drag.kind==="selection"){setSelection(drag.anchor,snapTime(t,width),false);return;}
        if(drag.kind==="seek"){seek(t);return;}
        if(Math.abs(event.clientX-drag.startX)<4&&!drag.changed)return;
        drag.changed=true;const region=drag.original,delta=t-drag.time,[low,high]=sourceBounds();
        let start=region.start_ms,end=region.end_ms;
        if(drag.kind==="move"){start=clamp(start+delta,low,high-(end-start));end=start+(region.end_ms-region.start_ms);
            const left=snapTime(start,width),right=snapTime(end,width);let shift=left!==start?left-start:right-end;
            shift=clamp(shift,low-start,high-end);start+=shift;end+=shift;
        }
        else if(drag.kind==="start")start=clamp(snapTime(start+delta,width),low,end);
        else end=clamp(snapTime(end+delta,width),start,high);
        if(drag.kind==="move"){
            const count=frames.ceil(region.end_ms)-frames.ceil(region.start_ms),first=clamp(frames.nearest(start),frames.first,frames.end-count);
            start=frames.at(first);end=frames.at(first+count);
        }else if(drag.kind==="start")start=frames.at(Math.min(frames.nearest(start,true),frames.ceil(end)-1));
        else end=frames.at(Math.max(frames.nearest(end,true),frames.ceil(start)+1));
        drag.preview={start_ms:start,end_ms:end};
        const bar=element.querySelector(`[data-id="${CSS.escape(drag.id)}"]`);if(bar){bar.style.left=`${(start-view.start_ms)/view.span_ms*100}%`;bar.style.width=`${(end-start)/view.span_ms*100}%`;}
        status(`${region.name}: ${positionLabel(start)} – ${positionLabel(end)} (exclusive)`);
    };
    element.onpointerup=event=>{
        const drag=timelineDrag;if(!drag||drag.lane!==lane)return;timelineDrag=null;
        if(drag.kind==="selection"){setSelection(drag.anchor,timelineTime(event,element));status("Frame range selected · add a region or process this interval");}
        else if(drag.changed&&drag.preview)attempt(()=>{activeId=drag.id;updateRegion(drag.preview);});
        else seek(timelineTime(event,element));
        renderTimelines();
    };
    element.onpointercancel=()=>{timelineDrag=null;renderTimelines();};
}
let rulerDrag=null;
function cutAtPointer(event){
    if(!$("showCuts").checked)return null;
    const time=timelineTime(event,$("ruler"),false),near=snapCut(cuts(),time,view.span_ms/Math.max(1,$("ruler").clientWidth)*8);
    return cuts()[cutIndex(cuts(),near)]===near?near:null;
}
$("ruler").onpointerdown=event=>{if(event.button!==0)return;event.preventDefault();$("ruler").focus();rulerDrag={cut:cutAtPointer(event),x:event.clientX,moved:false,extend:event.shiftKey};$("ruler").setPointerCapture(event.pointerId);if(rulerDrag.cut===null)seek(timelineTime(event,$("ruler")));};
$("ruler").onpointermove=event=>{if(!frames)return;if(rulerDrag&&Math.abs(event.clientX-rulerDrag.x)>3){rulerDrag.moved=true;seek(timelineTime(event,$("ruler")));}const near=cutAtPointer(event);$("ruler").title=near!==null?`Cut ${cutIndex(cuts(),near)+1} · click for In / Out · Shift-click another cut to select between`:"Drag to seek · ← / → step · I / O mark selection";};
$("ruler").onpointerup=()=>{const drag=rulerDrag;rulerDrag=null;if(drag?.cut!==null&&drag&&!drag.moved)selectCut(drag.cut,drag.extend);};
$("ruler").onpointercancel=()=>{rulerDrag=null;};
$("showCuts").onchange=()=>{$("showCuts").checked?renderTimelines():clearCut();};
for(const [id,direction]of [["previousCut",-1],["nextCut",1],["cutPrevious",-1],["cutNext",1]])$(id).onclick=()=>{const at=neighboringCut(cuts(),selectedCut??playhead,direction);if(at!==null){selectCut(at);view=followView(duration(),view,at,true);renderNavigation();renderTimelines();}};
$("selectShot").onclick=()=>{const [a,b]=shotRange(cuts(),playhead,...sourceBounds());setSelection(a,b);status("Shot selected · add a region or isolate this range in the active region");};
$("clearCut").onclick=()=>{clearCut();$("ruler").focus();};
$("cutIn").onclick=()=>$("markIn").click();$("cutOut").onclick=()=>$("markOut").click();
$("cutBefore").onclick=()=>selectCutSide(-1);$("cutAfter").onclick=()=>selectCutSide(1);
$("cutRegion").onclick=()=>attempt(()=>{
    if(!cutRangeReady)return;
    const lane=$("cutRegionLane").value,next=regionFromSelection(plan,lane,uuid,state.info,frames);
    activeId=next.selected_ids[0];edit(next,"Region ready · choose its anchor or stabilization reference points");
    showInspectorTab("region");
    if(lane==="stabilization")seek(regionById(plan,activeId).region.start_ms);
    clearCut();
});
$("cutSplitLane").onchange=renderNavigation;
$("cutSplit").onclick=()=>attempt(()=>{
    if(selectedCut===null)return;
    const lane=$("cutSplitLane").value;
    finishSplit(splitAtTime(plan,lane==='both'?LANES:[lane],selectedCut,uuid,state.info,frames));
});
document.addEventListener("pointerdown",event=>{if(selectedCut!==null&&!event.target.closest(".ruler-track,#markIn,#markOut"))clearCut();});
let overviewDrag=null;
$("overview").onpointerdown=event=>{if(event.button!==0)return;const r=$("overview").getBoundingClientRect(),time=sourceBounds()[0]+(event.clientX-r.left)/r.width*clipDuration();overviewDrag={x:event.clientX,start:view.start_ms,width:r.width};if(time<view.start_ms||time>view.start_ms+view.span_ms){view=panView(duration(),view,time-view.span_ms/2);overviewDrag.start=view.start_ms;}$("overview").setPointerCapture(event.pointerId);renderNavigation();renderTimelines();};
$("overview").onpointermove=event=>{if(!overviewDrag)return;view=panView(duration(),view,overviewDrag.start+(event.clientX-overviewDrag.x)/overviewDrag.width*clipDuration());renderNavigation();renderTimelines();};
$("overview").onpointerup=()=>{overviewDrag=null;scheduleThumbs();};$("overview").onpointercancel=()=>{overviewDrag=null;};
$("timelineBody").addEventListener("wheel",event=>{
    if(!view)return;const r=$("ruler").getBoundingClientRect();
    if(event.ctrlKey||event.metaKey){event.preventDefault();const anchor=view.start_ms+clamp((event.clientX-r.left)/r.width,0,1)*view.span_ms;view=zoomView(duration(),view,view.span_ms*Math.exp(clamp(event.deltaY,-200,200)*.005),anchor);}
    else if(event.shiftKey||Math.abs(event.deltaX)>Math.abs(event.deltaY)){event.preventDefault();view=panView(duration(),view,view.start_ms+(event.deltaX||event.deltaY)/Math.max(1,r.width)*view.span_ms);}
    else return;renderNavigation();renderTimelines();scheduleThumbs();
},{passive:false});
$("backToStabilization").onclick=()=>{if(regionById(plan,anchorOrigin)){selectRegion(anchorOrigin);maskSteps.setStep("anchors");}};
$("regionForm").onsubmit=event=>event.preventDefault();
for(const [id,field,convert] of [["regionName","name",String],["anchor","anchor",String],["person","person",Number],["smoothing","smoothing_ms",Number]])$(id).onchange=()=>attempt(()=>updateRegion({[field]:convert($(id).value)}));
for(const [id,field] of [["regionIn","start_ms"],["regionOut","end_ms"]])$(id).onchange=()=>attempt(()=>updateRegion({[field]:positionTime($(id).value)}));
$("regionEnabled").onchange=()=>attempt(()=>updateRegion({enabled:$("regionEnabled").checked}));
$("regionLock").onclick=()=>attempt(()=>updateRegion({locked:!selected().region.locked}));
$("regionRange").onclick=()=>{const r=selected()?.region;if(r)setSelection(r.start_ms,r.end_ms);};
$("rois").onchange=()=>attempt(()=>{
    const rois=JSON.parse($("rois").value);
    if(!Array.isArray(rois)||!rois.length||rois.some(r=>!Array.isArray(r)||r.length!==4||r.some(v=>!Number.isFinite(v)||v<0||v>1)||r[2]<=0||r[3]<=0||r[0]+r[2]>1.000001||r[1]+r[3]>1.000001))throw new Error("Person regions must be normalized [x,y,width,height] rectangles inside 0–1.");
    updateRegion({rois});
});
$("axisSettings").onchange=()=>attempt(()=>{const settings=JSON.parse($("axisSettings").value);if(!settings||Array.isArray(settings)||typeof settings!=="object")throw new Error("Axis settings must be a JSON object.");updateRegion({settings});});
$("crop").onchange=()=>attempt(()=>{const crop=JSON.parse($("crop").value);if(!Array.isArray(crop)||crop.length!==4||crop.some(v=>!Number.isFinite(v))||crop[0]<0||crop[1]<0||crop[2]<2||crop[3]<2||crop[0]+crop[2]>state.info.width||crop[1]+crop[3]>state.info.height)throw new Error("Crop must be [x,y,width,height] inside the source image.");const reference=clone(selected().region.reference);reference.crop_xywh=crop;updateRegion({reference});});
$("referenceFirst").onclick=()=>{$("previewVariant").value="original";seek(frames.at(frames.ceil(selected().region.start_ms)));};
$("referenceMode").onchange=()=>{
    maskSteps.setStep("track");
    if($("referenceMode").value!=="review"){
        $("previewVariant").value="original";
        const r=selected().region,frame=activeFrame()-frames.ceil(r.start_ms);
        const key=referenceKeys(r.reference).find(k=>k.frame===frame)||referenceKeys(r.reference)[0];
        seek(frames.at(frames.ceil(r.start_ms)+key.frame));
    }drawSource();
};
$("cropZoom").onchange=drawSource;
$("clearPoints").onclick=()=>attempt(()=>{const r=selected().region;updateRegion({reference:withReferenceKeys(r.reference,[{frame:Math.max(0,activeFrame()-frames.ceil(r.start_ms)),points:[]}])});});
$("addTracking").onclick=()=>attempt(()=>addRegion("tracking"));$("addStabilization").onclick=()=>attempt(()=>addRegion("stabilization"));
$("remove").onclick=()=>attempt(()=>{const found=selected();if(!found)return;if(found.region.locked)throw new Error("Unlock this region before deleting it.");const next={...plan,[found.lane]:plan[found.lane].filter(r=>r.id!==found.region.id),selected_ids:[]};activeId=null;edit(next);});
$("duplicate").onclick=()=>attempt(()=>{
    const found=selected();if(!found)return;if(found.region.locked)throw new Error("Unlock this region before duplicating it.");
    const [a,b]=selectionRange(plan,state.info);if(b-a<1)throw new Error("Select the destination time range before duplicating.");
    const region={...clone(found.region),id:uuid(),name:`${found.region.name} · copy`,start_ms:a,end_ms:b,locked:false};
    if(found.lane==="stabilization"){region.reference.points=[];region.reference.sections=[];delete region.reference.keyframes;delete region.reference.point_mask;}
    delete region.mask_anchor;
    validateInterval(plan,found.lane,region.id,a,b,state.info);activeId=region.id;edit({...plan,[found.lane]:[...plan[found.lane],region],selected_ids:[region.id]});
});
function finishSplit(next){
    const lane=selected()?.lane;
    activeId=next.selected_ids.find(id=>regionById(next,id).lane===lane)||next.selected_ids[0];
    const hasReference=next.selected_ids.some(id=>regionById(next,id).lane==='stabilization');
    edit(next,'Split into independent regions · right side selected.'+(hasReference?' Reference marks stay on their own side; propagate masks and track the new intervals.':''));
    clearCut();showInspectorTab('region');$("referenceMode").value='review';
}
$("split").onclick=()=>attempt(()=>finishSplit(splitRegion(plan,activeId,frames.at(activeFrame()),uuid(),state.info,frames)));
$("timelineSplit").onclick=()=>$("split").click();
$("isolateSelection").onclick=()=>attempt(()=>{const next=isolateSelection(plan,activeId,uuid,state.info,frames);activeId=next.selected_ids[0];edit(next,"Selected range is now its own region · choose its anchor and settings");});
$("undo").onclick=()=>attempt(()=>{
    if(!history.length||busy)return;const previous=history.at(-1);
    for(const lane of LANES)for(const region of plan[lane])if(region.locked){const old=regionById(previous,region.id)?.region;if(!old||!equal({...old,locked:true},region))throw new Error("Undo would change a locked region. Unlock it first.");}
    history.pop();plan=previous;dirty=!equal(plan,savedPlan);draft();if(!regionById(plan,activeId))activeId=plan.selected_ids?.[0]||plan.tracking[0]?.id||plan.stabilization[0]?.id||null;feedback("pending","Unapplied edits");status("Undo restored the previous plan");render();
});
$("editRegions").onchange=()=>document.body.classList.toggle("editing-regions",$("editRegions").checked);
$("fitAll").onclick=()=>{view=timelineView(duration(),{...view,start_ms:sourceBounds()[0],span_ms:clipDuration()});renderNavigation();renderTimelines();scheduleThumbs();};
$("frameDetail").onclick=()=>{view=zoomView(duration(),view,Math.max(250,frames.at(Math.min(frames.end,frames.containing(playhead)+10))-playhead),playhead);view=followView(duration(),view,playhead,true);renderNavigation();renderTimelines();scheduleThumbs();};
function renderUnits(){
    for(const element of document.querySelectorAll("[data-timeline-unit]"))element.textContent=useFrames()?"frame":"s";
    for(const id of ["goTime","regionIn","regionOut","selectionIn","selectionOut"]){$(id).step=useFrames()?1:.001;$(id).min=useFrames()?frames.first:sourceBounds()[0]/1000;$(id).max=useFrames()?frames.end-(id==="goTime"?1:0):duration()/1000;}
    $("goTime").setAttribute("aria-label",useFrames()?"Go to source frame":"Go to source time in seconds");
    $("rulerLabel").textContent=useFrames()?"Source frame · from 0":"Original video time";
}
$("timelineUnit").onchange=()=>{renderUnits();render();scheduleThumbs();};
$("zoom").oninput=()=>{view=zoomView(duration(),view,sliderSpan(duration(),Number($("zoom").value)));renderNavigation();renderTimelines();scheduleThumbs();};
for(const [id,factor] of [["zoomIn",.65],["zoomOut",1/.65]])$(id).onclick=()=>{view=zoomView(duration(),view,view.span_ms*factor);renderNavigation();renderTimelines();scheduleThumbs();};
$("fitSelection").onclick=()=>fitRange(...selectionRange(plan,state.info));
$("showPlayhead").onclick=()=>{view=followView(duration(),view,playhead,true);renderNavigation();renderTimelines();scheduleThumbs();};
$("follow").onchange=()=>{view.follow=$("follow").checked;};
$("pan").oninput=()=>{view=panView(duration(),view,useFrames()?frames.at(Number($("pan").value)):Number($("pan").value));renderNavigation();renderTimelines();scheduleThumbs();};
$("markIn").onclick=()=>{const at=selectedCut??frames.at(activeFrame()),[,b]=selectionRange(plan,state.info);cutRangeReady=selectedCut!==null;setSelection(at,Math.max(at,b));};
$("markOut").onclick=()=>{const f=activeFrame(),[a]=selectionRange(plan,state.info);cutRangeReady=selectedCut!==null;setSelection(Math.min(a,selectedCut??frames.at(f)),selectedCut??frames.at(f+1));};
$("selectFrame").onclick=()=>{const f=activeFrame();clearCut();setSelection(frames.at(f),frames.at(f+1));};
for(const id of ['selectionIn','selectionOut'])$(id).onchange=()=>{
    const at=positionTime($(id).value),a=positionTime($('selectionIn').value),b=positionTime($('selectionOut').value);
    if(id==='selectionIn')setSelection(at,Math.max(at,b));else setSelection(Math.min(a,at),at);
};
$('rangeSummary').onclick=()=>{$('showTimelineTools').click();$('selectionIn').focus();};
$("clearSelection").onclick=()=>{setSelection(playhead,playhead);};
$("play").onclick=togglePlay;$("previous").onclick=()=>seek(frames.step(frames.at(activeFrame()),-1));$("next").onclick=()=>seek(frames.step(frames.at(activeFrame()),1));
$("seekTime").onclick=()=>seek(positionTime($("goTime").value));$("goTime").onkeydown=event=>{if(event.key==="Enter"){$("seekTime").click();$("ruler").focus();}};$("mute").onchange=()=>{video.muted=$("mute").checked;};
for(const [id,field] of [["chunkSeconds","chunk_seconds"],["joinMs","join_ms"],["gapPolicy","gap_policy"]])$(id).onchange=()=>attempt(()=>edit({...plan,[field]:id==="gapPolicy"?$(id).value:Number($(id).value)}));
window.addEventListener("keydown",event=>{
    if(event.key==="Escape"&&selectedCut!==null){event.preventDefault();clearCut();$("ruler").focus();return;}
    if(!state||!frames||document.querySelector("main").inert||event.ctrlKey||event.metaKey||event.altKey||event.target.closest("input,textarea,select,[role=separator],[contenteditable=true]"))return;
    if(event.code==="Space"&&!event.target.closest("button")){event.preventDefault();togglePlay();}
    if(event.key==="ArrowLeft"||event.key==="ArrowRight"){event.preventDefault();seek(frames.step(frames.at(activeFrame()),(event.key==="ArrowLeft"?-1:1)*(event.shiftKey?10:1)));}
    if(event.key==="Home"||event.key==="End"){event.preventDefault();seek(frames.at(event.key==="Home"?frames.first:frames.end-1));}
    if(event.key.toLowerCase()==="s"&&!event.repeat){event.preventDefault();$("timelineSplit").click();}
    if(event.key.toLowerCase()==="i"){event.preventDefault();$("markIn").click();}if(event.key.toLowerCase()==="o"){event.preventDefault();$("markOut").click();}
});
video.onloadeddata=()=>{finishSourceSeek();draw();};video.onseeked=finishSourceSeek;
video.onended=()=>{
    if(previewClip&&previewClip.region.end_ms<sourceBounds()[1]-.001){const end=previewClip.region.end_ms;resumePlayback=true;seek(frames.at(frames.ceil(end)),false);}
    else {pause();draw();}
};
video.onerror=()=>{
    previewLoading=false;resumePlayback=false;
    if(previewClip){previewFailures.add(previewClip.url);seek(playhead);renderPreviewControls();return;}
    fail(new Error("The source video could not be opened. Requeue the timeline node to refresh its source."));
};
video.onloadedmetadata=()=>{if(!state||!frames)return;previewLoading=false;requestSourceSeek(mediaTime(frames.seekTime(playhead)));layout.refresh();draw();};
if(video.requestVideoFrameCallback){const presented=(_,metadata)=>{if(!previewLoading&&requestedSeek===null&&!video.seeking)presentedTime=sourceTime(metadata.mediaTime);video.requestVideoFrameCallback(presented);};video.requestVideoFrameCallback(presented);}
function tick(now) {
    if(state&&frames&&!video.paused&&!video.seeking&&now-lastFrame>30){
        lastFrame=now;playhead=frames.at(activeFrame());
        if(video.currentTime>=mediaTime(sourceBounds()[1]))pause();
        if(choosePreviewMedia()){requestSourceSeek(mediaTime(frames.seekTime(playhead)));renderPreviewControls();}
        if(view.follow)view=followView(duration(),view,playhead);
        draw();renderNavigation();renderTimelines();
    }
    requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
new ResizeObserver(()=>{if(renderQueued)return;renderQueued=true;requestAnimationFrame(()=>{renderQueued=false;if(state){draw();renderTimelines();scheduleThumbs();}});}).observe($("timelineBody"));
new ResizeObserver(()=>{if(state)drawSource();}).observe($("sourceCanvas"));
async function jsonResponse(response) {
    const text=await response.text();let data;try{data=JSON.parse(text);}catch(_){const error=new Error(`Server returned ${response.status}: ${text.slice(0,300)||response.statusText}`);error.status=response.status;throw error;}
    if(!response.ok){const error=new Error(data.error?.message||data.error||data.message||`Request failed (${response.status})`);error.status=response.status;throw error;}
    return data;
}
async function save() {
    if(conflictingDraft)throw new Error("This recovered draft is older than the saved plan. Download your edits before loading the latest plan.");
    if(savePromise){await savePromise;if(dirty)return save();return;}
    if(!dirty)return;
    const sent=clone(plan);let sentRevision=revision;
    savePromise=(async()=>{
        if(sent.tracking.some(r=>r.isolate_subject)){
            const capabilities=await jsonResponse(await fetch(new URL('../reference-capabilities',location.href),{cache:'no-store',signal:AbortSignal.timeout(10000)}));
            if(capabilities.subject_crop!==1)throw new Error('Restart ComfyUI to enable person crops, then Apply again. Your edits are kept.');
        }
        if(sent.tracking.some(r=>r.anchor==='mask_anchor'||r.mask_anchor)){
            const capabilities=await jsonResponse(await fetch(new URL('../reference-capabilities',location.href),{cache:'no-store',signal:AbortSignal.timeout(10000)}));
            if(capabilities.mask_anchors!==1)throw new Error('Restart ComfyUI to enable painted 3D anchors, then refresh its main tab and reopen this timeline. Your edits are kept.');
        }
        if(sent.stabilization.some(r=>r.reference.point_mask))await requireMaskBackend();
        if(sent.stabilization.some(r=>r.reference.keyframes||r.reference.tracking_mode==='offline'))await requireReferenceBackend(location.href);
        let next;
        for(let attempt=0;attempt<3;attempt++){
            try{
                next=await jsonResponse(await fetch(api,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({revision:sentRevision,plan:sent}),signal:AbortSignal.timeout(30000)}));
                break;
            }catch(error){
                if(error.status!==409||attempt===2)throw error;
                const latest=await jsonResponse(await fetch(api,{cache:'no-store',signal:AbortSignal.timeout(15000)}));
                if(latest.info.source_id!==sent.source_id)throw error;
                if(equal(latest.plan,sent)){next=latest;break;} // Save succeeded before the connection dropped.
                if(!equal(latest.plan,savedPlan))throw error;
                sentRevision=latest.revision; // A report/rerun changed only the revision.
            }
        }
        revision=next.revision;savedPlan=clone(next.plan||sent);state={...state,...next};
        if(equal(plan,sent))plan=clone(savedPlan);dirty=!equal(plan,savedPlan);draft();
    })();
    try{await savePromise;}catch(error){if(error.status===409){$("reload").hidden=false;throw new Error("This plan changed in another tab. Download your edits before loading the latest plan.");}throw error;}finally{savePromise=null;}
    if(dirty)return save();
}
function finishApply(error) {
    const pending=applyPending;if(!pending)return;clearTimeout(pending.timer);applyPending=null;
    if(error){feedback("error",error.message);pending.reject(error);}else{appliedPlan=clone(pending.sent);feedback("applied",equal(plan,pending.sent)?"ComfyUI confirmed these settings":"Earlier edits applied · newer edits still pending");status("Plan applied to node");pending.resolve();}
    render();
}
window.s3fTimelineApply=()=>{
    if(applyTask)return applyTask;
    applyTask=applyWorkflow().finally(()=>{applyTask=null;});
    return applyTask;
};
async function applyWorkflow(){
    clearError();feedback("applying","Saving the plan…");$("apply").disabled=true;
    try {
        // Commit focused fields before the parent serializes the workflow.
        if(document.activeElement?.matches("input,textarea,select"))document.activeElement.blur();
        if(!$("regionForm").reportValidity())throw new Error("Correct the highlighted region setting before applying the plan.");
        await save();const target=bridge();if(!target)throw new Error("Plan saved locally. Open this page from its ComfyUI node to apply it to the workflow.");
        const sent=clone(plan),request=uuid();let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});
        applyPending={request,sent,promise,resolve,reject,timer:setTimeout(()=>finishApply(new Error("ComfyUI did not acknowledge Apply. Keep this tab open and retry from the linked node.")),7000)};
        feedback("applying","Waiting for ComfyUI to confirm…");
        target.postMessage({type:"s3f-timeline-apply",session,node,request,plan:sent,revision},location.origin);
        return await promise;
    } catch(error){feedback("error",error.message);$("apply").disabled=busy;fail(error);throw error;}
}
$("apply").onclick=()=>window.s3fTimelineApply().catch(()=>{});
async function requireMaskBackend(){
    const data=await jsonResponse(await fetch(new URL('../reference-capabilities',location.href),{cache:'no-store',signal:AbortSignal.timeout(10000)}));
    if(data.reference_masks!==1)throw new Error('Restart ComfyUI to enable reference masks, then refresh its main tab and reopen this timeline. Your edits are kept.');
}
function validateProcessing(operation,scope=null) {
    const candidatePlan=scope?planForScope(plan,scope):plan;
    if(["detect_cuts","automatic"].includes(operation))return;
    if(operation==='preview_anchor'){
        const r=selected()?.lane==='tracking'?selected().region:null,at=frames.at(activeFrame());
        if(!r||r.enabled===false||at<r.start_ms||at>=r.end_ms)throw new Error('Choose a frame inside an enabled tracking region.');
        if(r.anchor==='mask_anchor'&&!r.mask_anchor?.strokes?.length)throw new Error('Mark a reference frame and paint an area before previewing this anchor.');
        return;
    }
    if(['stabilize','propagate_mask','extract_anchors'].includes(operation)){
        const found=selected();
        if(found?.lane!=='stabilization'||found.region.enabled===false)throw new Error('Select an enabled stabilization region to track.');
        if(found.region.locked&&operation!=='extract_anchors')throw new Error('Unlock this region before tracking again.');
        if(operation==='propagate_mask')return;
        validateReference(found.region);maskSteps.validate();return;
    }
    if(!candidatePlan.tracking.some(r=>r.enabled!==false))throw new Error("Add and enable at least one tracking region.");
    const [a,b]=selectionRange(candidatePlan,state.info),ids=new Set(candidatePlan.selected_ids||[]);
    for(const region of candidatePlan.stabilization)if(region.enabled!==false){
        let relevant=operation!=="selected"||b-a>1&&region.start_ms<b&&region.end_ms>a;
        if(operation==="selected"&&b-a<=1)relevant=candidatePlan.tracking.some(r=>ids.has(r.id)&&r.start_ms<region.end_ms&&r.end_ms>region.start_ms)||ids.has(region.id);
        if(relevant)validateReference(region);
    }
}
async function process(operation,scopeKind=null) {
    if(busy||startingOperation)return;
    if(document.activeElement?.matches('input,textarea,select'))document.activeElement.blur();
    startingOperation=operation;renderPreviewControls();
    if(operation==="detect_cuts")$("sceneTools").open=true;
    try {
        if(document.activeElement?.matches('input,textarea,select'))document.activeElement.blur();
        if(operation==='automatic'){
            const capabilities=await jsonResponse(await fetch(new URL('../reference-capabilities',location.href),{cache:'no-store'}));
            if(capabilities.automatic_scenes!==1)throw new Error('Restart ComfyUI and refresh its main tab to enable automatic scenes.');
        }
        const scope=operation==='selected'?processingScope(plan,scopeKind):null;
        validateProcessing(operation,scope);
        if(scope){
            const capabilities=await jsonResponse(await fetch(new URL('../reference-capabilities',location.href),{cache:'no-store',signal:AbortSignal.timeout(10000)}));
            if(capabilities.timeline_scope!==1)throw new Error('Restart ComfyUI to enable explicit processing scopes, then refresh the main tab and reopen this timeline.');
        }
        const previewRequest=operation==='preview_anchor'?{region_id:selected().region.id,at_ms:frames.at(activeFrame())}:null;
        const previewKey=previewRequest?anchorPreviewKey():null;
        if(previewRequest){
            const capabilities=await jsonResponse(await fetch(new URL('../reference-capabilities',location.href),{cache:'no-store',signal:AbortSignal.timeout(10000)}));
            if(capabilities.anchor_preview!==1)throw new Error('Restart ComfyUI to enable anchor previews, then refresh the main tab and reopen this timeline.');
            anchorPreview=null;$('previewVariant').value='original';pause();seek(previewRequest.at_ms);
        }
        const stabilizationId=['stabilize','propagate_mask','extract_anchors'].includes(operation)?selected().region.id:null;
        if(['propagate_mask','extract_anchors'].includes(operation))await requireMaskBackend();
        if(['stabilize','propagate_mask','extract_anchors'].includes(operation)){
            const capabilities=await jsonResponse(await fetch(new URL('../reference-capabilities',location.href),{cache:'no-store',signal:AbortSignal.timeout(10000)}));
            if(capabilities.timeline_stabilize!==1)throw new Error('Restart ComfyUI to enable Track region, then refresh the main ComfyUI tab and reopen the timeline. Your edits are kept.');
        }
        if(!['detect_cuts','preview_anchor'].includes(operation)&&plan.stabilization.some(r=>r.enabled!==false&&(r.reference.keyframes||r.reference.tracking_mode==='offline')))await requireReferenceBackend(location.href);
        await window.s3fTimelineApply();const target=bridge();if(!target)throw new Error("Open this timeline from its ComfyUI node to process it.");
        if(previewRequest&&previewKey!==anchorPreviewKey())throw new Error('Anchor settings changed while preparing the preview. Preview again.');
        busy=true;clearError();$("processingProgress").hidden=false;$("progress").removeAttribute("value");$("progressText").textContent=operation==='stabilize'?'Submitting reference tracking…':"Submitting timeline processing…";status("Queuing processing…");
        const request=uuid();processPending={request,operation,stabilizationId,previewKey,previewRequest,acknowledged:false,timer:setTimeout(()=>{if(processPending?.request===request&&!processPending.acknowledged)finishProcess(new Error("ComfyUI did not acknowledge Process. Apply your plan, reload ComfyUI, and reopen the timeline."));},15000)};
        // A distinct bridge operation makes older main tabs reject scopes instead
        // of silently running their legacy marked-range precedence.
        render();target.postMessage({type:"s3f-timeline-process",session,node,request,operation:scope?'scoped_selected':operation,...(scope?{processing_scope:scope}:{}),stabilization_id:stabilizationId,...(previewRequest?{anchor_preview:previewRequest}:{}),plan:clone(plan),revision,editor_session:state.editor_session,cut_sensitivity:$("cutSensitivity").value,automatic_options:{people:$("automaticPeople").value}},location.origin);
    }catch(error){fail(error);}finally{startingOperation=null;renderPreviewControls();}
}
function finishProcess(error) {
    trackingDetails.clear();
    const cutScan=processPending?.operation==="detect_cuts",trackOnly=processPending?.operation==='stabilize',maskOnly=processPending?.operation==='propagate_mask',previewOnly=processPending?.operation==='preview_anchor';
    if(processPending)clearTimeout(processPending.timer);processPending=null;busy=false;
    if(previewOnly){
        if(error)fail(error);
        $('progress').max=1;$('progress').value=error?0:1;
        $('progressText').textContent=error?error.message:'Anchor preview ready';
        status(error?'Anchor preview stopped':'Anchor preview ready · original frame');render();return;
    }
    if(error){fail(error);$("progressText").textContent=error.message;status(cutScan?"Cut scan stopped · previous markers kept":"Processing stopped · completed chunks remain cached");}
    else{$("progress").max=1;$("progress").value=1;$("progressText").textContent=cutScan?`Cut scan complete · ${cuts().length} markers`:trackOnly?'Tracking complete · stabilized preview ready':maskOnly?'Mask propagation complete · ready to track':"Processing complete";status(cutScan?"Cut guides ready · jump to a cut or select a shot to plan its tracking":trackOnly?'Tracking complete · review the stabilized preview':maskOnly?'Mask ready · review it and continue to Stabilize':"Processing complete · open Motion Studio to review the curves");}
    render();
}
$("processAll").onclick=()=>process("all");$("processSelected").onclick=()=>process("selected","range");$("processRegions").onclick=()=>process("selected","regions");$("processUnfinished").onclick=()=>process("unfinished");
$("detectCuts").onclick=()=>process("detect_cuts");
$('processAutomatic').onclick=()=>process('automatic');
$('automaticSuggestion').onchange=()=>attempt(()=>updateRegion({automatic:{...selected().region.automatic,suggest:$('automaticSuggestion').checked}}));
function autoReviews(){return plan.tracking.filter(r=>r.automatic).map(region=>{const row=state.report?.regions?.find(row=>row.id===region.id);return {region,reasons:[...new Set([...(region.automatic.review||[]),...(row?.review||[]),...(row?.error?[row.error]:[])])]};}).filter(row=>row.reasons.length);}
$('nextAutoReview').onclick=()=>{const rows=autoReviews();if(!rows.length)return;const index=rows.findIndex(row=>row.region.id===selected()?.region.id);const row=rows[(index+1)%rows.length];selectRegion(row.region.id);fitRange(row.region.start_ms,row.region.end_ms);seek(row.region.start_ms);};
$("trackStabilization").onclick=()=>process('stabilize');
$('previewAnchor').onclick=()=>process('preview_anchor');
$('showAnchorPreview').onchange=drawSource;
$('cancelAnchorPreview').onclick=()=>{$('cancel').click();renderAnchorPreviewControls();};
$("cancel").onclick=()=>{const target=bridge();if(!target){fail(new Error("The ComfyUI window is no longer connected. Cancel the running job in ComfyUI."));return;}target.postMessage({type:"s3f-timeline-cancel",session,node,request:processPending?.request||uuid()},location.origin);$("cancel").disabled=true;$("progressText").textContent="Cancellation requested…";};
$("cancelStabilization").onclick=()=>{$("cancel").click();renderPreviewControls();};
window.addEventListener("message",async event=>{
    if(event.origin!==location.origin||event.source!==bridge())return;const data=event.data;
    if(data?.type==="s3f-timeline-applied"&&data.request===applyPending?.request){finishApply(data.error?new Error(data.error):null);return;}
    if(data?.type!=="s3f-timeline-progress"||data.request!==processPending?.request)return;
    processPending.acknowledged=true;clearTimeout(processPending.timer);
    if(data.text)$("progressText").textContent=data.text;
    if(data.max>0){$("progress").max=data.max;$("progress").value=data.value||0;}
    renderPreviewControls();
    if(data.state==="error"||data.error){
        const error=data.error==="Unknown timeline operation"&&['detect_cuts','stabilize','propagate_mask','extract_anchors','preview_anchor','selected'].includes(processPending.operation)
            ?"This action needs the updated workflow bridge. Refresh the main ComfyUI tab (Ctrl+Shift+R), then reopen this timeline."
            :data.error||data.text||"Processing failed";
        const previewOnly=processPending.operation==='preview_anchor';
        finishProcess(new Error(error));
        if(!previewOnly)await window.s3fTimelineLoad().catch(fail);
    }
    else if(data.state==="complete") {try{
        if(processPending.operation==='preview_anchor'){
            const result=data.anchor_preview,request=processPending.previewRequest;
            if(!result?.anchors?.length||result.source_id!==state.info.source_id||result.region_id!==request.region_id||!Number.isFinite(result.at_ms)||Math.abs(result.at_ms-request.at_ms)>.002)throw new Error('The anchor preview did not match the requested source frame. Preview again.');
            anchorPreview={key:processPending.previewKey,data:result};finishProcess();return;
        }
        const stabilizationId=processPending.stabilizationId,operation=processPending.operation;
        await window.s3fTimelineLoad();await refreshRenderedClips();finishProcess();
        if(stabilizationId&&selected()?.region.id===stabilizationId){
            if(operation==='stabilize')$('previewStabilized').click();
            else if(operation==='propagate_mask')maskSteps.setStep('track');
        }
    }catch(error){finishProcess(error);}}
    else status(data.state==="queued"?"Processing queued in ComfyUI":processPending.operation==="detect_cuts"?"Scanning hard cuts…":"Processing regions…");
});
async function loadState(next, force = false) {
    const first=!state,changedSource=state&&state.info.source_id!==next.info.source_id;
    if(!first&&dirty&&!force&&(conflictingDraft||!equal(next.plan,savedPlan)||changedSource)){pendingState=next;$("reload").hidden=false;status("A newer plan is available · your current edits are kept");state={...state,report:next.report,project:next.project};renderReport();return;}
    if(first||changedSource||!frames){
        pause();document.querySelector("main").inert=true;status("Indexing source frames… · timestamps only; the first scan can take a moment");
        const response=await fetch(new URL(`${api.pathname}/frames?source_id=${encodeURIComponent(next.info.source_id)}`,location.origin),{signal:AbortSignal.timeout(120000)});
        if(response.status===404)throw new Error("Frame navigation needs the updated backend. Restart ComfyUI, then reopen this timeline.");
        const data=await jsonResponse(response);
        if(data.source_id!==next.info.source_id)throw new Error("The source changed while indexing frames. Reload the timeline.");
        frames=frameClock(data);presentedTime=null;
    }
    state=next;revision=next.revision;
    frameCuts=state.scene_cuts?.source_id===state.info.source_id?[...new Set(state.scene_cuts.times_ms.map(t=>frames.snap(t)))]:[];
    if(changedSource||!frameCuts.includes(selectedCut)){selectedCut=null;cutRangeReady=false;}
    if(first||changedSource)layout.refresh();
    if(first||changedSource||force)$("cutSensitivity").value=state.scene_cuts?.settings?.sensitivity||"normal";
    if(first||force||!dirty){plan=clone(next.plan);savedPlan=clone(next.plan);dirty=false;draft();}
    plan.tracking||=[];plan.stabilization||=[];plan.selected_ids||=[];plan.selection||=[bounds(next.info)[0],bounds(next.info)[0]];
    if(first||changedSource){renderRequest++;processedRegions={};resultStates.clear();trackingDetails.clear();renderedClips=[];previewFailures.clear();previewClip=null;previewURL="";previewLoading=false;$("previewVariant").value="original";view=timelineView(duration(),{start_ms:sourceBounds()[0],span_ms:clipDuration(),follow:true});playhead=frames.at(frames.first);prepare($("sourceCanvas"));sourceMap=null;requestedSeek=null;decodingSeek=null;choosePreviewMedia();activeId=plan.selected_ids[0]||plan.tracking[0]?.id||plan.stabilization[0]?.id||null;history=[];}
    if(!regionById(plan,activeId))activeId=plan.selected_ids[0]||plan.tracking[0]?.id||plan.stabilization[0]?.id||null;
    if(first||changedSource)showInspectorTab(plan.selected_ids.length?"region":"timeline");
    if(force){history=[];pendingState=null;conflictingDraft=false;$("reload").hidden=true;}
    const source=next.info.source;$("sourceName").textContent=typeof source==="string"?source.split("/").at(-1):String(source?.path||source?.name||"Source video").split("/").at(-1);
    if(!busy)status(dirty?"Unapplied edits":"Plan loaded · select regions to configure processing");
    renderUnits();render();scheduleThumbs();document.querySelector("main").inert=false;void refreshRenderedClips();
}
window.s3fTimelineLoad=async()=>{
    if(loading)return;loading=true;
    try{const next=await jsonResponse(await fetch(api,{cache:"no-store"}));await loadState(next);}finally{loading=false;}
};
window.s3fReconnect=async()=>{
    appliedPlan=null;
    if(applyPending)finishApply(new Error('ComfyUI reconnected before Apply was acknowledged. Your plan is kept; Apply again when ready.'));
    if(processPending)finishProcess(new Error('ComfyUI reconnected. Check its queue before processing again; completed regions and your settings are kept.'));
    await window.s3fTimelineLoad();
};
$("reload").onclick=async()=>{try{const next=pendingState||await jsonResponse(await fetch(api,{cache:"no-store"}));await loadState(next,true);feedback("pending","Latest saved plan loaded");clearError();}catch(error){fail(error);}};
$("download").onclick=()=>{const blob=new Blob([JSON.stringify(plan,null,2)],{type:"application/json"}),url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download="processing-timeline.json";a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
window.addEventListener("beforeunload",event=>{draft();if(dirty){event.preventDefault();event.returnValue="";}});
function scheduleThumbs() {clearTimeout(thumbTimer);thumbTimer=setTimeout(drawThumbnails,300);}
function drawThumbnails() {
    // Small cached images are fetched only for the visible range; decoding the source remains browser streaming.
    const target=$("thumbnails");if(!target||!state)return;
    const width=target.getBoundingClientRect().width,count=thumbnailCount(width,layout.settings.thumbnails,state.info.width/state.info.height),fragment=document.createDocumentFragment(),seen=new Set();
    for(let i=0;i<count;i++){
        const at=frames.snap(clamp(view.start_ms+view.span_ms*(i+.5)/count,...sourceBounds())),image=document.createElement("img"),button=document.createElement("button");
        if(seen.has(at))continue;seen.add(at);
        button.type="button";button.className="thumbnail";button.title=`Source frame ${frames.containing(at)} · ${formatTime(at,3)}`;button.setAttribute("aria-label",`Seek to frame ${frames.containing(at)}`);button.onclick=()=>seek(at);
        image.src=new URL(`${api.pathname}/thumbnail?source_id=${encodeURIComponent(state.info.source_id)}&at_ms=${at}`,location.origin);image.alt="";image.loading="lazy";image.decoding="async";image.draggable=false;image.onerror=()=>{image.style.visibility="hidden";};button.append(image);fragment.append(button);
    }
    target.replaceChildren(fragment);
}
$("anchor").append(new Option("Painted mask · 3D","mask_anchor"));
for(const anchor of ANCHORS){const option=document.createElement("option");option.value=anchor;option.textContent=anchor.replaceAll("_"," ");$("anchor").append(option);}
async function initialize() {
    if(!session)throw new Error("No timeline session was supplied. Open this editor from the Processing timeline node.");
    let local;try{local=JSON.parse(localStorage.getItem(draftKey)||"null");}catch(_){}
    await window.s3fTimelineLoad();
    if(local?.plan?.source_id===state.info.source_id&&!equal(local.plan,plan)){
        conflictingDraft=local.revision!==revision&&!(local.base&&equal(local.base,savedPlan));plan=local.plan;dirty=true;
        if(conflictingDraft){pendingState=state;revision=local.revision;$("reload").hidden=false;fail(new Error("Recovered unsaved edits from an earlier revision. Download this draft before loading the latest plan."));}
        if(!regionById(plan,activeId))activeId=plan.selected_ids?.[0]||plan.tracking[0]?.id||null;
        draft();status(conflictingDraft?"Recovered older draft · download it before loading the latest plan":"Recovered unsaved edits from this browser · Apply to node to keep them");feedback("pending","Recovered unapplied edits");render();
    }
    pollTimer=setInterval(async()=>{if(document.hidden||savePromise||applyPending||loading)return;try{const next=await jsonResponse(await fetch(api,{cache:"no-store"}));if(next.revision!==revision||!equal(next.report,state.report)||next.project!==state.project||!equal(next.scene_cuts,state.scene_cuts))await loadState(next);else await refreshRenderedClips();}catch(_){/* Explicit Apply/Process surfaces connection failures without interrupting edits. */}},4000);
}
initialize().catch(error=>{fail(error);status("Timeline could not load");window.s3fTimelineStartupFailed?.(error);});

$("openStudio").addEventListener("click",event=>{if(openWorkspacePage($("openStudio").href))event.preventDefault();});
window.s3fHasUnsavedEdits=()=>dirty||!!applyPending;
window.s3fPausePreview=pause;
