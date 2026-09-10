// View preferences only: these never change region times, source crops or jobs.
export const LAYOUT_DEFAULTS = {wide:true, split:null, stage:500, thumbnails:90, tracking:90, stabilization:90, overview:43};
const LIMITS = {stage:[280,1100], thumbnails:[40,240], tracking:[90,600], stabilization:[90,600], overview:[35,180]};
const clamp=(v,min,max)=>Math.max(min,Math.min(max,v));
export function layoutSettings(value={}) {
    const result={...LAYOUT_DEFAULTS};
    if(!value||typeof value!=="object")return result;
    if(typeof value.wide==="boolean")result.wide=value.wide;
    if(Number.isFinite(value.split))result.split=clamp(value.split,.05,.8);
    for(const [key,[min,max]]of Object.entries(LIMITS))if(Number.isFinite(value[key]))result[key]=clamp(value[key],min,max);
    return result;
}
export function previewWidth(width,height,aspect,split=null) {
    const available=Math.max(1,width-12), low=Math.min(240,available*.45), high=Math.max(low,available-330);
    const ratio=Number.isFinite(aspect)&&aspect>0?aspect:1;
    return clamp(split===null?(height-110)*ratio+28:available*split,low,high);
}
export function thumbnailCount(width,height,aspect) {
    const ratio=Number.isFinite(aspect)&&aspect>0?aspect:1;
    return clamp(Math.round(width/Math.max(24,height*ratio)),2,40);
}
export function createTimelineLayout({aspect,changed}) {
    const $=id=>document.getElementById(id),storageKey="s3f-processing-layout:1",workspace=$("previewWorkspace");
    let saved;try{saved=JSON.parse(localStorage.getItem(storageKey));}catch{/* Local storage is optional. */}
    let settings=layoutSettings(saved),drag=null,queued=false;
    const save=()=>{try{localStorage.setItem(storageKey,JSON.stringify(settings));}catch{/* View still works in private browsers. */}};
    function apply(persist=false) {
        document.body.classList.toggle("wide-layout",settings.wide);$("wideLayout").checked=settings.wide;
        const style=document.documentElement.style;
        for(const key of ["stage","thumbnails","overview"])style.setProperty(`--${key}-height`,`${settings[key]}px`);
        const width=workspace.getBoundingClientRect().width,left=previewWidth(width,settings.stage,aspect(),settings.split);
        workspace.style.setProperty("--preview-width",`${left}px`);
        $("splitPreview").setAttribute("aria-valuenow",String(Math.round(left/Math.max(1,width)*100)));
        for(const key of Object.keys(LIMITS))document.querySelector(`[data-resize="${key}"]`)?.setAttribute("aria-valuenow",String(Math.round(settings[key])));
        if(persist)save();
        if(!queued){queued=true;requestAnimationFrame(()=>{queued=false;changed();});}
    }
    function set(key,value) {settings=layoutSettings({...settings,[key]:value});apply(true);}
    const finish=()=>{if(!drag)return;drag=null;document.body.classList.remove("resizing-columns","resizing-rows");save();};
    // Keep the gesture when a browser releases element capture during layout.
    // Only a drag started on one of our dividers can use these listeners.
    document.addEventListener("pointermove",event=>{
        if(!drag||event.pointerId!==drag.pointer)return;
        if(!(event.buttons&1)){finish();return;}
        event.preventDefault();event.stopPropagation();
        const delta=drag.key==="split"?(event.clientX-drag.x)/Math.max(1,drag.width-12):event.clientY-drag.y;
        set(drag.key,drag.value+delta);
    },true);
    for(const type of ["pointerup","pointercancel"])document.addEventListener(type,event=>{
        if(!drag||event.pointerId!==drag.pointer)return;event.stopPropagation();finish();
    },true);
    window.addEventListener("blur",finish);
    for(const handle of document.querySelectorAll("[data-resize]")) {
        const key=handle.dataset.resize,horizontal=key==="split";
        handle.setAttribute("role","separator");handle.tabIndex=0;handle.setAttribute("aria-orientation",horizontal?"vertical":"horizontal");
        handle.setAttribute("aria-valuemin",String(horizontal?1:LIMITS[key][0]));handle.setAttribute("aria-valuemax",String(horizontal?99:LIMITS[key][1]));
        handle.onpointerdown=event=>{
            if(event.button!==0)return;event.preventDefault();event.stopPropagation();handle.focus();
            const width=workspace.getBoundingClientRect().width;
            const value=horizontal?$("sourcePreview").getBoundingClientRect().width/Math.max(1,width-12):
                key==="tracking"||key==="stabilization"?$(key+"Lane").getBoundingClientRect().height:settings[key];
            drag={handle,key,x:event.clientX,y:event.clientY,value,width,pointer:event.pointerId};handle.setPointerCapture(event.pointerId);document.body.classList.add(horizontal?"resizing-columns":"resizing-rows");
        };
        handle.ondblclick=()=>set(key,LAYOUT_DEFAULTS[key]);
        handle.onkeydown=event=>{
            const decrease=horizontal?"ArrowLeft":"ArrowUp",increase=horizontal?"ArrowRight":"ArrowDown";
            if(![decrease,increase,"Home"].includes(event.key))return;event.preventDefault();event.stopPropagation();
            if(event.key==="Home"){set(key,LAYOUT_DEFAULTS[key]);return;}
            const current=horizontal?$("sourcePreview").getBoundingClientRect().width/Math.max(1,workspace.clientWidth-12):Number(handle.getAttribute("aria-valuenow"));
            set(key,current+(event.key===decrease?-1:1)*(horizontal?.02:event.shiftKey?50:10));
        };
    }
    $("wideLayout").onchange=()=>set("wide",$("wideLayout").checked);
    $("fitVideoLayout").onclick=()=>set("split",null);
    $("resetLayout").onclick=()=>{settings={...LAYOUT_DEFAULTS};apply(true);};
    let fullscreenDocument=document;
    try{if(window.parent!==window&&window.parent.location.origin===location.origin&&window.parent.location.pathname.endsWith("/workspace.html"))fullscreenDocument=window.parent.document;}catch{/* Standalone/cross-origin frame uses its own document. */}
    const fullscreenButton=$("fullscreenLayout"),fullscreenLabel=()=>{const full=!!fullscreenDocument.fullscreenElement;fullscreenButton.textContent=full?"Exit full screen":"Full screen";fullscreenButton.setAttribute("aria-pressed",String(full));apply();};
    fullscreenButton.disabled=!fullscreenDocument.documentElement.requestFullscreen;
    fullscreenButton.onclick=async()=>{
        try{if(fullscreenDocument.fullscreenElement)await fullscreenDocument.exitFullscreen();else await fullscreenDocument.documentElement.requestFullscreen();}
        catch{$("layoutStatus").textContent="The browser declined full screen. Wide layout is still available.";}
    };
    fullscreenDocument.addEventListener("fullscreenchange",fullscreenLabel);
    new ResizeObserver(()=>apply()).observe(workspace);
    window.addEventListener("resize",()=>apply());
    apply();
    return {get settings(){return settings;},refresh:()=>apply()};
}
