import {workflowHost,openWorkspacePage} from "./workflow-host.mjs";
import {timelineView as baseTimelineView, zoomView as baseZoomView, panView as basePanView, followView as baseFollowView, sliderSpan as baseSliderSpan, spanSlider as baseSpanSlider, formatTime, rulerTicks} from "./viewport.mjs";
import {LANES, ANCHORS, clone, clamp, fraction, bounds, regionById, selectionRange, createRegion, changeRegion, splitRegion, validateInterval, validateReference, regionRows, isolateSelection} from "./processing-timeline-edit.mjs";
import {neighboringCut,snapCut,shotRange,visibleCuts} from "./cut-markers.mjs";
import {createTimelineLayout,thumbnailCount} from "./timeline-layout.mjs";
import {frameClock} from "./frame-clock.mjs";

const $ = id => document.getElementById(id), params = new URLSearchParams(location.search);
const session = params.get("session"), node = params.get("node"), api = new URL(`../timelines/${encodeURIComponent(session || "")}`, location.href), video = $("source");
const uuid = () => crypto.randomUUID?.() || [...crypto.getRandomValues(new Uint8Array(16))].map(value => value.toString(16).padStart(2,"0")).join("");
const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b);
let state, plan, savedPlan, revision, dirty = false, history = [], view, playhead = 0, busy = false;
let savePromise = null, applyTask = null, applyPending = null, processPending = null, pendingState = null, activeId = null;
let timelineDrag = null, sourceDrag = null, sourceMap = null, renderQueued = false, lastFrame = 0;
let appliedPlan = null, pollTimer = null, loading = false, thumbTimer = null, thumbnailView = "", conflictingDraft = false;
let frames = null, presentedTime = null, frameCuts = [];
const draftKey = `s3f-processing-timeline:${session}`;
const laneElement = lane => $(`${lane}Lane`);
const selected = () => regionById(plan || {}, activeId);
const sourceBounds = () => {const [a,b]=bounds(state.info);return frames?[Math.max(a,frames.at(frames.first)),Math.min(b,frames.at(frames.end))]:[a,b];};
const duration = () => sourceBounds()[1];
const clipDuration = () => sourceBounds()[1]-sourceBounds()[0];
const cuts = () => frameCuts;
// requestVideoFrameCallback reports a frame PTS (possibly rounded by the browser),
// while currentTime is a continuously advancing clock inside a frame.
const activeFrame = () => !video.paused&&!video.seeking?(presentedTime!==null?frames.nearest(presentedTime):frames.containing((video.currentTime-fraction(state.info.source_origin))*1000)):frames.containing(playhead);
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

const bridge = workflowHost;
function status(text) { $("status").textContent = text; }
function fail(error) { $("error").textContent = error.message || String(error); $("error").hidden = false; }
function clearError() { $("error").hidden = true; $("error").textContent = ""; }
function feedback(kind, text) {
    $("apply").dataset.state = kind;
    $("apply").textContent = ({applying:"Applying…", applied:"✓ Applied", error:"Apply failed · Retry"})[kind] || "Apply to node";
    $("apply").setAttribute("aria-busy", String(kind === "applying"));
    $("applyStatus").textContent = text || "";
}
function draft() {
    try { if (dirty) localStorage.setItem(draftKey, JSON.stringify({revision, plan})); else localStorage.removeItem(draftKey); } catch (_) { /* Storage can be disabled; Download plan still works. */ }
}
function edit(next, message = "Plan changed · Apply to node to keep it") {
    if (busy) throw new Error("Wait for processing to finish, or cancel it before editing the plan.");
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
    const changedStart = patch.start_ms !== undefined && patch.start_ms !== before.region.start_ms && before.lane === "stabilization";
    edit(changeRegion(plan, before.region.id, patch, state.info), changedStart ? "Start changed · pick reference points on the new first frame" : undefined);
}
function selectRegion(id, additive = false, seekAt = null) {
    activeId = id;
    for(const control of $("regionForm").querySelectorAll("input,textarea,select"))control.setCustomValidity("");
    const ids = additive ? new Set(plan.selected_ids || []) : new Set();
    if (additive && ids.has(id)) ids.delete(id); else ids.add(id);
    // Selection is useful in the saved plan but does not invalidate cached processing.
    plan.selected_ids = [...ids]; dirty = !equal(plan, savedPlan); draft();
    $("referenceMode").value = "review";
    if (seekAt !== null) seek(seekAt);
    render();
}
function setSelection(a, b, persist = true) {
    const [low, high] = sourceBounds();
    plan.selection = [frames.snap(clamp(Math.min(a,b), low, high),true), frames.snap(clamp(Math.max(a,b), low, high),true)];
    if (persist) { dirty = !equal(plan, savedPlan); draft(); }
    renderNavigation(); renderTimelines();
}
function pause() { video.pause(); $("play").textContent = "Play"; }
function mediaTime(ms) { return fraction(state.info.source_origin) + ms / 1000; }
function seek(ms, stop = true) {
    if (!state) return;
    if (stop) pause();
    const [low, high] = sourceBounds();
    playhead = frames.snap(clamp(ms, low, high));
    presentedTime = null;
    const value = mediaTime(frames.seekTime(playhead));
    if (Number.isFinite(value)) video.currentTime = value;
    if ($("follow").checked) view = followView(duration(), view, playhead);
    draw(); renderNavigation(); renderTimelines();
}
async function togglePlay() {
    if (!video.paused) { pause(); return; }
    if (frames.containing(playhead) === frames.end-1) seek(sourceBounds()[0]);
    $("referenceMode").value = "review";
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
    const [ctx,w,h] = prepare($("sourceCanvas"));
    const found = selected(), reference = found?.lane === "stabilization" ? found.region.reference : null;
    const zoom = reference && $("cropZoom").checked && $("referenceMode").value !== "crop";
    const crop = zoom ? reference.crop_xywh : [0,0,state.info.width,state.info.height];
    const scale = Math.min(w / crop[2], h / crop[3]), ox = (w - crop[2] * scale) / 2, oy = (h - crop[3] * scale) / 2;
    sourceMap = {crop,scale,ox,oy};
    if (video.readyState >= 2) ctx.drawImage(video,...crop,ox,oy,crop[2]*scale,crop[3]*scale);
    const point = p => [ox+(p[0]-crop[0])*scale, oy+(p[1]-crop[1])*scale];
    if (reference) {
        const firstFrame = frames.containing(playhead) === frames.ceil(found.region.start_ms);
        const [x,y] = point(reference.crop_xywh); ctx.strokeStyle = "#e2b672"; ctx.lineWidth = 1.5;
        ctx.strokeRect(x,y,reference.crop_xywh[2]*scale,reference.crop_xywh[3]*scale);
        if (firstFrame) for (const [i,p] of reference.points.entries()) {
            const [px,py]=point(p);ctx.beginPath();ctx.arc(px,py,5,0,Math.PI*2);ctx.strokeStyle="#92efd0";ctx.stroke();ctx.fillStyle="#c8fae8";ctx.font="12px system-ui";ctx.fillText(String(i+1),px+8,py-7);
        }
        $("previewStatus").textContent = firstFrame ? `${reference.points.length} reference points · first frame` : "Starting points shown only on the region’s first frame";
    } else $("previewStatus").textContent = "One source clock for every region";
    if (sourceDrag) {const a=point(sourceDrag.start),b=point(sourceDrag.end);ctx.strokeStyle="#9fcaff";ctx.strokeRect(a[0],a[1],b[0]-a[0],b[1]-a[1]);}
}
function draw() {
    if (!state || !frames) return;
    drawSource(); $("time").textContent = `F ${frames.containing(playhead)} · ${formatTime(playhead,3,duration() >= 3600000)}`;
    if (document.activeElement !== $("goTime")) $("goTime").value = useFrames()?frames.containing(playhead):(playhead/1000).toFixed(3);
    $("previous").disabled=frames.containing(playhead)<=frames.first;
    $("next").disabled=frames.containing(playhead)>=frames.end-1;
}
function renderNavigation() {
    if (!state || !frames) return;
    view = timelineView(duration(), view);
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
    $("processSelected").disabled = busy || (!(b-a>1) && !(plan.selected_ids||[]).length);
    $("detectCuts").disabled=busy;$("cutSensitivity").disabled=busy;
    $("previousCut").disabled=neighboringCut(cuts(),playhead,-1)===null;
    $("nextCut").disabled=neighboringCut(cuts(),playhead,1)===null;
    const hasScan=state.scene_cuts?.source_id===state.info.source_id;
    $("selectShot").disabled=!hasScan||busy;
    $("cutStatus").textContent=busy&&processPending?.operation==="detect_cuts"?"Scanning…":hasScan?`${cuts().length} cut markers${state.scene_cuts.cache_hit?" · cached":""}`:"No cut scan yet";
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
    if (playhead>=view.start_ms && playhead<=view.start_ms+view.span_ms) {ruler.fillStyle="#eef6fa";ruler.beginPath();ruler.moveTo(x(playhead)-5,rh-10);ruler.lineTo(x(playhead)+5,rh-10);ruler.lineTo(x(playhead),rh-3);ruler.fill();}
    const [a,b]=selectionRange(plan,state.info), states=reportMap();
    for (const lane of LANES) {
        const element=laneElement(lane), rows=regionRows(plan[lane]), height=Math.max(layout.settings[lane],rows.count*59+24),pitch=(height-24)/rows.count;
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
            bar.style.left=`${Math.max(0,left)}%`;bar.style.width=`${Math.max(.05,Math.min(100,right)-Math.max(0,left))}%`;bar.style.top=`${12+rows.positions.get(region.id)*pitch}px`;bar.style.height=`${Math.min(160,pitch-9)}px`;
            bar.classList.toggle("selected",(plan.selected_ids||[]).includes(region.id));bar.classList.toggle("locked",!!region.locked);bar.classList.toggle("disabled-region",region.enabled===false);
            bar.querySelector(".region-title").textContent=`${region.locked?"🔒 ":""}${region.name}${lane==="tracking"?" · "+region.anchor.replaceAll("_"," ")+(region.additional_anchors?.length?` +${region.additional_anchors.length}`:""):""}`;
            bar.querySelector(".region-state").textContent=states.get(region.id)?.state||"";
            bar.title=`${region.name} · ${positionLabel(region.start_ms)} – ${positionLabel(region.end_ms)} (exclusive)${region.locked?" · Locked":""}`;
            bar.setAttribute("aria-label",bar.title);bar.setAttribute("aria-pressed",String((plan.selected_ids||[]).includes(region.id)));
        }
        for(const child of existing.values())child.remove();
        const range=element.querySelector(".range-highlight"), left=clamp((a-view.start_ms)/view.span_ms,0,1)*100,right=clamp((b-view.start_ms)/view.span_ms,0,1)*100;
        range.style.display=b>a&&right>left?"block":"none";range.style.left=`${left}%`;range.style.width=`${right-left}%`;
        const [overlay,ow,oh]=prepare(element.querySelector(".cut-guides"));overlay.strokeStyle="#d9d4a34d";overlay.lineWidth=1;overlay.setLineDash([3,4]);
        for(const at of guides){const xx=(at-view.start_ms)/view.span_ms*ow;overlay.beginPath();overlay.moveTo(xx,0);overlay.lineTo(xx,oh);overlay.stroke();}
        const head=element.querySelector(".playhead");head.hidden=playhead<view.start_ms||playhead>view.start_ms+view.span_ms;head.style.left=`${(playhead-view.start_ms)/view.span_ms*100}%`;
    }
    drawOverview();
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
    if(!found)return;
    const {region,lane}=found, disabled=busy||!!region.locked;
    const values={regionName:region.name,regionIn:positionValue(region.start_ms),regionOut:positionValue(region.end_ms)};
    if(lane==="tracking")Object.assign(values,{anchor:region.anchor,person:region.person,smoothing:region.smoothing_ms,rois:JSON.stringify(region.rois),axisSettings:JSON.stringify(region.settings||{},null,2)});
    else {Object.assign(values,{crop:JSON.stringify(region.reference.crop_xywh)});$("pointCount").textContent=`${region.reference.points.length} points`;}
    for(const [id,value] of Object.entries(values))if(document.activeElement!==$(id))$(id).value=value;
    $("regionEnabled").checked=region.enabled!==false;$("regionLock").textContent=region.locked?"Unlock":"Lock";$("lockNotice").hidden=!region.locked;
    $("trackingSettings").hidden=lane!=="tracking";$("stabilizationSettings").hidden=lane!=="stabilization";
    for(const control of $("regionForm").querySelectorAll("input,textarea,select,button"))control.disabled=disabled;
    for(const id of ["regionLock","regionRange","referenceFirst","cropZoom"])$(id).disabled=busy;
    $("referenceMode").disabled=disabled;
    if(disabled)$("referenceMode").value="review";
    if(lane==="tracking"){
        $("additionalAnchors").replaceChildren(...ANCHORS.filter(anchor=>anchor!==region.anchor).map(anchor=>{
            const label=document.createElement("label"),input=document.createElement("input");
            input.type="checkbox";input.value=anchor;input.checked=(region.additional_anchors||[]).includes(anchor);input.disabled=disabled;
            input.onchange=()=>attempt(()=>updateRegion({additional_anchors:[...$("additionalAnchors").querySelectorAll("input:checked")].map(el=>el.value)}));
            label.append(input,anchor.replaceAll("_"," "));return label;
        }));
    }
}
function renderReport() {
    const report=state.report||{},target=$("report");target.replaceChildren();
    for(const item of report.regions||[]) {
        const region=regionById(plan,item.id)?.region,row=document.createElement("div");row.className=`report-row ${item.state||"pending"}`;
        const name=document.createElement("span");name.className="name";name.textContent=region?.name||item.id;
        const range=document.createElement("span");range.className="muted";range.textContent=`${formatTime(item.start_ms||0,1)} – ${formatTime(item.end_ms||0,1)}`;
        const label=document.createElement("span");label.className="report-state";label.textContent=item.error||item.state||"pending";
        const button=document.createElement("button");button.textContent="Show";button.onclick=()=>{if(region){selectRegion(region.id);fitRange(region.start_ms,region.end_ms);seek(region.start_ms);}};
        row.append(name,range,label,button);target.append(row);
    }
    for(const warning of report.warnings||[]){const p=document.createElement("div");p.className="report-warning";p.textContent=typeof warning==="string"?warning:JSON.stringify(warning);target.append(p);}
    const count=plan.tracking.filter(r=>r.enabled!==false).length,stable=plan.stabilization.filter(r=>r.enabled!==false).length;
    $("regionSummary").textContent=`${count} tracking · ${stable} stabilization regions`;
    const project=state.project||report.project;
    $("openStudio").hidden=!project;if(project){const url=new URL("viewer.html",location.href);url.searchParams.set("project",typeof project==="string"?project:project.name||project.project);if(state.editor_session)url.searchParams.set("session",state.editor_session);$("openStudio").href=url;}
}
function render() {
    if(!plan)return;
    renderInspector();renderNavigation();renderTimelines();renderReport();draw();
    $("undo").disabled=busy||!history.length;$("download").disabled=false;$("apply").disabled=busy||!!applyPending;
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
    const region=createRegion(lane,uuid(),start,end,state.info,plan[lane].length);
    validateInterval(plan,lane,region.id,start,end,state.info);
    const next={...plan,[lane]:[...plan[lane],region],selected_ids:[region.id],selection:[start,end]};activeId=region.id;edit(next);
    if(lane==="stabilization")seek(start);
}
function sourcePosition(event) {
    if(!sourceMap)return null;const r=$("sourceCanvas").getBoundingClientRect(),{crop,scale,ox,oy}=sourceMap;
    const x=(event.clientX-r.left-ox)/scale+crop[0],y=(event.clientY-r.top-oy)/scale+crop[1];
    if(x<crop[0]||y<crop[1]||x>crop[0]+crop[2]||y>crop[1]+crop[3])return null;
    return [clamp(x,0,state.info.width-1),clamp(y,0,state.info.height-1)];
}
function referenceEditable() {
    const found=selected();
    if(!found||found.lane!=="stabilization"||busy||found.region.locked)return false;
    if(video.seeking||frames.containing(playhead)!==frames.ceil(found.region.start_ms)){status("Go to this region’s first frame before selecting reference points.");return false;}
    return true;
}
$("sourceCanvas").onpointerdown=event=>{
    if(event.button!==0||!referenceEditable())return;
    const p=sourcePosition(event);if(!p)return;
    if($("referenceMode").value==="crop"){sourceDrag={start:p,end:p};$("sourceCanvas").setPointerCapture(event.pointerId);}
    else if($("referenceMode").value==="points")attempt(()=>{const reference=clone(selected().region.reference);reference.points.push(p);updateRegion({reference});});
};
$("sourceCanvas").onpointermove=event=>{if(sourceDrag){const p=sourcePosition(event);if(p)sourceDrag.end=p;drawSource();}};
$("sourceCanvas").onpointerup=()=>{
    if(!sourceDrag)return;const {start:a,end:b}=sourceDrag;sourceDrag=null;
    const crop=[Math.floor(Math.min(a[0],b[0])),Math.floor(Math.min(a[1],b[1])),Math.round(Math.abs(a[0]-b[0])),Math.round(Math.abs(a[1]-b[1]))];
    if(crop[2]>=2&&crop[3]>=2)attempt(()=>{const reference=clone(selected().region.reference);reference.crop_xywh=crop;updateRegion({reference});});else drawSource();
};
$("sourceCanvas").onpointercancel=()=>{sourceDrag=null;drawSource();};
$("sourceCanvas").oncontextmenu=event=>{
    if($("referenceMode").value!=="points"||!referenceEditable())return;event.preventDefault();const p=sourcePosition(event);if(!p)return;
    const reference=clone(selected().region.reference);let best=-1,distance=12/sourceMap.scale;
    reference.points.forEach((point,i)=>{const d=Math.hypot(point[0]-p[0],point[1]-p[1]);if(d<distance){best=i;distance=d;}});
    if(best>=0)attempt(()=>{reference.points.splice(best,1);updateRegion({reference});});
};
function timelineTime(event,element,snap=true) {const r=element.getBoundingClientRect(),time=clamp(view.start_ms+(event.clientX-r.left)/r.width*view.span_ms,...sourceBounds());return snap?snapTime(time,r.width):time;}
for(const lane of LANES) {
    const element=laneElement(lane);
    element.onpointerdown=event=>{
        if(event.button!==0||!plan)return;event.preventDefault();const t=timelineTime(event,element),bar=event.target.closest(".region-bar"),found=bar?regionById(plan,bar.dataset.id):null;
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
let rulerDrag=false;
$("ruler").onpointerdown=event=>{if(event.button!==0)return;event.preventDefault();$("ruler").focus();rulerDrag=true;$("ruler").setPointerCapture(event.pointerId);seek(timelineTime(event,$("ruler")));};
$("ruler").onpointermove=event=>{if(!frames)return;if(rulerDrag)seek(timelineTime(event,$("ruler")));const at=timelineTime(event,$("ruler"),false),near=snapCut(cuts(),at,view.span_ms/Math.max(1,$("ruler").clientWidth)*7);$("ruler").title=`Frame ${frames.nearest(at)}${$("showCuts").checked&&cuts().includes(near)?" · Hard cut":""} · drag to seek · ← / → step · I / O mark selection`;};
$("ruler").onpointerup=$("ruler").onpointercancel=()=>{rulerDrag=false;};
$("showCuts").onchange=renderTimelines;
for(const [id,direction]of [["previousCut",-1],["nextCut",1]])$(id).onclick=()=>{const at=neighboringCut(cuts(),playhead,direction);if(at!==null){seek(at);view=followView(duration(),view,at,true);renderNavigation();renderTimelines();}};
$("selectShot").onclick=()=>{const [a,b]=shotRange(cuts(),playhead,...sourceBounds());setSelection(a,b);status("Shot selected · add a region or isolate this range in the active region");};
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
$("referenceFirst").onclick=()=>seek(frames.at(frames.ceil(selected().region.start_ms)));
$("referenceMode").onchange=()=>{if($("referenceMode").value!=="review")$("referenceFirst").click();drawSource();};
$("cropZoom").onchange=drawSource;
$("clearPoints").onclick=()=>attempt(()=>{const reference=clone(selected().region.reference);reference.points=[];updateRegion({reference});$("referenceFirst").click();});
$("addTracking").onclick=()=>attempt(()=>addRegion("tracking"));$("addStabilization").onclick=()=>attempt(()=>addRegion("stabilization"));
$("remove").onclick=()=>attempt(()=>{const found=selected();if(!found)return;if(found.region.locked)throw new Error("Unlock this region before deleting it.");const next={...plan,[found.lane]:plan[found.lane].filter(r=>r.id!==found.region.id),selected_ids:[]};activeId=null;edit(next);});
$("duplicate").onclick=()=>attempt(()=>{
    const found=selected();if(!found)return;if(found.region.locked)throw new Error("Unlock this region before duplicating it.");
    const [a,b]=selectionRange(plan,state.info);if(b-a<1)throw new Error("Select the destination time range before duplicating.");
    const region={...clone(found.region),id:uuid(),name:`${found.region.name} · copy`,start_ms:a,end_ms:b,locked:false};
    if(found.lane==="stabilization"){region.reference.points=[];region.reference.sections=[];}
    validateInterval(plan,found.lane,region.id,a,b,state.info);activeId=region.id;edit({...plan,[found.lane]:[...plan[found.lane],region],selected_ids:[region.id]});
});
$("split").onclick=()=>attempt(()=>{const next=splitRegion(plan,activeId,playhead,uuid(),state.info);activeId=next.selected_ids[0];edit(next);});
$("isolateSelection").onclick=()=>attempt(()=>{const next=isolateSelection(plan,activeId,uuid,state.info);activeId=next.selected_ids[0];edit(next,"Selected range is now its own region · choose its anchor and settings");});
$("undo").onclick=()=>attempt(()=>{
    if(!history.length||busy)return;const previous=history.at(-1);
    for(const lane of LANES)for(const region of plan[lane])if(region.locked){const old=regionById(previous,region.id)?.region;if(!old||!equal({...old,locked:true},region))throw new Error("Undo would change a locked region. Unlock it first.");}
    history.pop();plan=previous;dirty=!equal(plan,savedPlan);draft();if(!regionById(plan,activeId))activeId=plan.selected_ids?.[0]||null;feedback("pending","Unapplied edits");status("Undo restored the previous plan");render();
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
$("markIn").onclick=()=>{const at=frames.at(activeFrame()),[,b]=selectionRange(plan,state.info);setSelection(at,Math.max(at,b));};
$("markOut").onclick=()=>{const f=activeFrame(),[a]=selectionRange(plan,state.info);setSelection(Math.min(a,frames.at(f)),frames.at(f+1));};
$("selectFrame").onclick=()=>{const f=activeFrame();setSelection(frames.at(f),frames.at(f+1));};
for(const id of ["selectionIn","selectionOut"])$(id).onchange=()=>setSelection(positionTime($("selectionIn").value),positionTime($("selectionOut").value));
$("clearSelection").onclick=()=>{setSelection(playhead,playhead);};
$("play").onclick=togglePlay;$("previous").onclick=()=>seek(frames.step(frames.at(activeFrame()),-1));$("next").onclick=()=>seek(frames.step(frames.at(activeFrame()),1));
$("seekTime").onclick=()=>seek(positionTime($("goTime").value));$("goTime").onkeydown=event=>{if(event.key==="Enter"){$("seekTime").click();$("ruler").focus();}};$("mute").onchange=()=>{video.muted=$("mute").checked;};
for(const [id,field] of [["chunkSeconds","chunk_seconds"],["joinMs","join_ms"],["gapPolicy","gap_policy"]])$(id).onchange=()=>attempt(()=>edit({...plan,[field]:id==="gapPolicy"?$(id).value:Number($(id).value)}));
window.addEventListener("keydown",event=>{
    if(!state||!frames||document.querySelector("main").inert||event.ctrlKey||event.metaKey||event.altKey||event.target.closest("input,textarea,select,[role=separator],[contenteditable=true]"))return;
    if(event.code==="Space"&&!event.target.closest("button")){event.preventDefault();togglePlay();}
    if(event.key==="ArrowLeft"||event.key==="ArrowRight"){event.preventDefault();seek(frames.step(frames.at(activeFrame()),(event.key==="ArrowLeft"?-1:1)*(event.shiftKey?10:1)));}
    if(event.key==="Home"||event.key==="End"){event.preventDefault();seek(frames.at(event.key==="Home"?frames.first:frames.end-1));}
    if(event.key.toLowerCase()==="i"){event.preventDefault();$("markIn").click();}if(event.key.toLowerCase()==="o"){event.preventDefault();$("markOut").click();}
});
video.onloadeddata=()=>{draw();};video.onseeked=draw;video.onended=()=>{pause();draw();};
video.onerror=()=>fail(new Error("The source video could not be opened. Requeue the timeline node to refresh its source."));
video.onloadedmetadata=()=>{if(!state||!frames)return;video.currentTime=mediaTime(frames.seekTime(playhead));layout.refresh();draw();};
if(video.requestVideoFrameCallback){const presented=(_,metadata)=>{presentedTime=(metadata.mediaTime-fraction(state?.info?.source_origin))*1000;video.requestVideoFrameCallback(presented);};video.requestVideoFrameCallback(presented);}
function tick(now) {
    if(state&&frames&&!video.paused&&!video.seeking&&now-lastFrame>30){
        lastFrame=now;playhead=frames.at(activeFrame());
        if(video.currentTime>=mediaTime(sourceBounds()[1]))pause();
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
    const sent=clone(plan),sentRevision=revision;
    savePromise=(async()=>{
        const next=await jsonResponse(await fetch(api,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({revision:sentRevision,plan:sent})}));
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
function validateProcessing(operation) {
    if(operation==="detect_cuts")return;
    if(!plan.tracking.some(r=>r.enabled!==false))throw new Error("Add and enable at least one tracking region.");
    const [a,b]=selectionRange(plan,state.info),ids=new Set(plan.selected_ids||[]);
    for(const region of plan.stabilization)if(region.enabled!==false){
        let relevant=operation!=="selected"||b-a>1&&region.start_ms<b&&region.end_ms>a;
        if(operation==="selected"&&b-a<=1)relevant=plan.tracking.some(r=>ids.has(r.id)&&r.start_ms<region.end_ms&&r.end_ms>region.start_ms)||ids.has(region.id);
        if(relevant)validateReference(region);
    }
}
async function process(operation) {
    if(busy)return;
    if(operation==="detect_cuts")$("sceneTools").open=true;
    try {validateProcessing(operation);await window.s3fTimelineApply();const target=bridge();if(!target)throw new Error("Open this timeline from its ComfyUI node to process it.");
        busy=true;clearError();$("processingProgress").hidden=false;$("progress").removeAttribute("value");$("progressText").textContent="Submitting timeline processing…";status("Queuing processing…");render();
        const request=uuid();processPending={request,operation,acknowledged:false,timer:setTimeout(()=>{if(processPending?.request===request&&!processPending.acknowledged)finishProcess(new Error("ComfyUI did not acknowledge Process. Apply your plan, reload ComfyUI, and reopen the timeline."));},15000)};
        target.postMessage({type:"s3f-timeline-process",session,node,request,operation,plan:clone(plan),revision,editor_session:state.editor_session,cut_sensitivity:$("cutSensitivity").value},location.origin);
    }catch(error){fail(error);}
}
function finishProcess(error) {
    const cutScan=processPending?.operation==="detect_cuts";
    if(processPending)clearTimeout(processPending.timer);processPending=null;busy=false;
    if(error){fail(error);$("progressText").textContent=error.message;status(cutScan?"Cut scan stopped · previous markers kept":"Processing stopped · completed chunks remain cached");}
    else{$("progress").max=1;$("progress").value=1;$("progressText").textContent=cutScan?`Cut scan complete · ${cuts().length} markers`:"Processing complete";status(cutScan?"Cut guides ready · jump to a cut or select a shot to plan its tracking":"Processing complete · open Motion Studio to review the curves");}
    render();
}
$("processAll").onclick=()=>process("all");$("processSelected").onclick=()=>process("selected");$("processUnfinished").onclick=()=>process("unfinished");
$("detectCuts").onclick=()=>process("detect_cuts");
$("cancel").onclick=()=>{const target=bridge();if(!target){fail(new Error("The ComfyUI window is no longer connected. Cancel the running job in ComfyUI."));return;}target.postMessage({type:"s3f-timeline-cancel",session,node,request:processPending?.request||uuid()},location.origin);$("cancel").disabled=true;$("progressText").textContent="Cancellation requested…";};
window.addEventListener("message",async event=>{
    if(event.origin!==location.origin||event.source!==bridge())return;const data=event.data;
    if(data?.type==="s3f-timeline-applied"&&data.request===applyPending?.request){finishApply(data.error?new Error(data.error):null);return;}
    if(data?.type!=="s3f-timeline-progress"||data.request!==processPending?.request)return;
    processPending.acknowledged=true;clearTimeout(processPending.timer);
    if(data.text)$("progressText").textContent=data.text;
    if(data.max>0){$("progress").max=data.max;$("progress").value=data.value||0;}
    if(data.state==="error"||data.error){
        const error=data.error==="Unknown timeline operation"&&processPending.operation==="detect_cuts"
            ?"Cut detection needs the updated workflow bridge. Refresh the main ComfyUI tab (Ctrl+Shift+R), then reopen this timeline."
            :data.error||data.text||"Processing failed";
        finishProcess(new Error(error));await window.s3fTimelineLoad().catch(fail);
    }
    else if(data.state==="complete") {try{await window.s3fTimelineLoad();finishProcess();}catch(error){finishProcess(error);}}
    else status(data.state==="queued"?"Processing queued in ComfyUI":processPending.operation==="detect_cuts"?"Scanning hard cuts…":"Processing regions…");
});
async function loadState(next, force = false) {
    const first=!state,changedSource=state&&state.info.source_id!==next.info.source_id;
    if(!first&&dirty&&!force&&(conflictingDraft||!equal(next.plan,savedPlan)||changedSource)){pendingState=next;$("reload").hidden=false;status("A newer plan is available · your current edits are kept");state={...state,report:next.report,project:next.project};renderReport();return;}
    if(first||changedSource||!frames){
        pause();document.querySelector("main").inert=true;status("Indexing source frames… · timestamps only; the first scan can take a moment");
        const response=await fetch(new URL(`${api.pathname}/frames?source_id=${encodeURIComponent(next.info.source_id)}`,location.origin));
        if(response.status===404)throw new Error("Frame navigation needs the updated backend. Restart ComfyUI, then reopen this timeline.");
        const data=await jsonResponse(response);
        if(data.source_id!==next.info.source_id)throw new Error("The source changed while indexing frames. Reload the timeline.");
        frames=frameClock(data);presentedTime=null;
    }
    state=next;revision=next.revision;
    frameCuts=state.scene_cuts?.source_id===state.info.source_id?[...new Set(state.scene_cuts.times_ms.map(t=>frames.snap(t)))]:[];
    if(first||changedSource)layout.refresh();
    if(first||changedSource||force)$("cutSensitivity").value=state.scene_cuts?.settings?.sensitivity||"normal";
    if(first||force||!dirty){plan=clone(next.plan);savedPlan=clone(next.plan);dirty=false;draft();}
    plan.tracking||=[];plan.stabilization||=[];plan.selected_ids||=[];plan.selection||=[bounds(next.info)[0],bounds(next.info)[0]];
    if(first||changedSource){view=timelineView(duration(),{start_ms:sourceBounds()[0],span_ms:clipDuration(),follow:true});playhead=frames.at(frames.first);video.src=new URL(`${api.pathname}/video?source_id=${encodeURIComponent(state.info.source_id)}`,location.origin);video.load();activeId=plan.selected_ids[0]||plan.tracking[0]?.id||plan.stabilization[0]?.id||null;history=[];}
    if(!regionById(plan,activeId))activeId=plan.selected_ids[0]||plan.tracking[0]?.id||plan.stabilization[0]?.id||null;
    if(force){history=[];pendingState=null;conflictingDraft=false;$("reload").hidden=true;}
    const source=next.info.source;$("sourceName").textContent=typeof source==="string"?source.split("/").at(-1):String(source?.path||source?.name||"Source video").split("/").at(-1);
    if(!busy)status(dirty?"Unapplied edits":"Plan loaded · select regions to configure processing");
    renderUnits();render();scheduleThumbs();document.querySelector("main").inert=false;
}
window.s3fTimelineLoad=async()=>{
    if(loading)return;loading=true;
    try{const next=await jsonResponse(await fetch(api,{cache:"no-store"}));await loadState(next);}finally{loading=false;}
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
for(const anchor of ANCHORS){const option=document.createElement("option");option.value=anchor;option.textContent=anchor.replaceAll("_"," ");$("anchor").append(option);}
async function initialize() {
    if(!session)throw new Error("No timeline session was supplied. Open this editor from the Processing timeline node.");
    let local;try{local=JSON.parse(localStorage.getItem(draftKey)||"null");}catch(_){}
    await window.s3fTimelineLoad();
    if(local?.plan?.source_id===state.info.source_id&&!equal(local.plan,plan)){
        conflictingDraft=local.revision!==revision;plan=local.plan;dirty=true;
        if(conflictingDraft){pendingState=state;revision=local.revision;$("reload").hidden=false;fail(new Error("Recovered unsaved edits from an earlier revision. Download this draft before loading the latest plan."));}
        if(!regionById(plan,activeId))activeId=plan.selected_ids?.[0]||plan.tracking[0]?.id||null;
        draft();status(conflictingDraft?"Recovered older draft · download it before loading the latest plan":"Recovered unsaved edits from this browser · Apply to node to keep them");feedback("pending","Recovered unapplied edits");render();
    }
    pollTimer=setInterval(async()=>{if(document.hidden||savePromise||applyPending||loading)return;try{const next=await jsonResponse(await fetch(api,{cache:"no-store"}));if(next.revision!==revision||!equal(next.report,state.report)||next.project!==state.project||!equal(next.scene_cuts,state.scene_cuts))await loadState(next);}catch(_){/* Explicit Apply/Process surfaces connection failures without interrupting edits. */}},4000);
}
initialize().catch(error=>{fail(error);status("Timeline could not load");});

$("openStudio").addEventListener("click",event=>{if(openWorkspacePage($("openStudio").href))event.preventDefault();});
window.s3fHasUnsavedEdits=()=>dirty||!!applyPending;
window.s3fPausePreview=pause;
