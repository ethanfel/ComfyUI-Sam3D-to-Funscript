const $=id=>document.getElementById(id), pages=new Map();
let active=null,nextId=0;
const safeURL=value=>{const url=new URL(value,location.href);if(url.origin!==location.origin||!/^\/((api\/)?sam3d_funscript\/assets\/)(processing-timeline|reference|viewer)\.html$/.test(url.pathname))throw new Error("Invalid workspace page");return url.href;};
window.s3fWorkflowHost=()=>{try{return window.opener&&!window.opener.closed&&window.opener.location.origin===location.origin?window.opener:null}catch{return null}};
function select(key){
    if(!pages.has(key))key=pages.keys().next().value;
    if(!key)return;
    active=key;
    for(const [id,page]of pages){
        page.panel.hidden=id!==key;page.tab.setAttribute("aria-selected",String(id===key));page.tab.tabIndex=id===key?0:-1;
        if(id!==key&&page.frame){try{page.frame.contentDocument?.querySelectorAll("video,audio").forEach(media=>media.pause());page.frame.contentWindow.s3fPausePreview?.();}catch{}}
    }
}
function add(descriptor){
    let page=pages.get(descriptor.key);
    if(!page){
        const tab=document.createElement("button"),panel=document.createElement("section");
        const id=nextId++;
        tab.type="button";tab.role="tab";tab.id=`tab-${id}`;panel.role="tabpanel";panel.className="page";panel.id=`panel-${id}`;
        panel.setAttribute("aria-labelledby",tab.id);tab.setAttribute("aria-controls",panel.id);tab.onclick=()=>select(descriptor.key);
        $("tabs").append(tab);$("pages").append(panel);page={tab,panel,frame:null};pages.set(descriptor.key,page);
    }
    page.descriptor=descriptor;page.tab.textContent=descriptor.label;
    if(descriptor.url&&!page.frame){
        const frame=document.createElement("iframe");frame.title=descriptor.label;frame.allow="fullscreen";frame.src=safeURL(descriptor.url);
        frame.onload=()=>window.s3fWorkflowHost()?.postMessage({type:"s3f-workspace-frames",workspace:new URLSearchParams(location.search).get("workspace")},location.origin);
        page.panel.replaceChildren(frame);page.frame=frame;
    }else if(!page.frame){
        const box=document.createElement("div"),title=document.createElement("h1"),text=document.createElement("p");box.className="waiting";title.textContent=descriptor.label;
        text.textContent=descriptor.message||"Run the connected workflow once to prepare this tool. This tab will become available automatically.";box.append(title,text);page.panel.replaceChildren(box);
    }
    return page;
}
window.s3fConfigureWorkspace=configuration=>{
    const wanted=new Set(configuration.pages.map(page=>page.key));
    for(const [key,page]of pages)if(!wanted.has(key)&&!page.descriptor.virtual){page.panel.remove();page.tab.remove();pages.delete(key)}
    for(const descriptor of configuration.pages)add(descriptor);
    $("connection").textContent=configuration.connected===false?"Workflow disconnected · current edits remain available":"Connected to ComfyUI";
    select(configuration.active||active||pages.keys().next().value);
};
window.s3fWorkspaceFrames=()=>[...pages].filter(([,page])=>page.frame).map(([key,page])=>({key,window:page.frame.contentWindow}));
window.s3fWorkspaceNotice=text=>{$("notice").textContent=text;$("notice").hidden=!text;};
window.s3fOpenWorkspacePage=(value,kind)=>{
    const url=new URL(safeURL(value)),session=url.searchParams.get("session");
    if(kind!=="motion")throw new Error("This link is not a Motion Studio page");
    const key=`motion:${session||url.searchParams.get("project")}`;
    add({key,kind,label:"Motion Studio",url:url.href,virtual:true});select(key);
    window.s3fWorkflowHost()?.postMessage({type:"s3f-workspace-frames",workspace:new URLSearchParams(location.search).get("workspace")},location.origin);
};
$("tabs").onkeydown=event=>{
    if(!["ArrowLeft","ArrowRight","Home","End"].includes(event.key))return;
    const keys=[...pages.keys()];let index=keys.indexOf(active);
    index=event.key==="Home"?0:event.key==="End"?keys.length-1:(index+(event.key==="ArrowRight"?1:-1)+keys.length)%keys.length;
    event.preventDefault();select(keys[index]);pages.get(keys[index])?.tab.focus();
};
window.addEventListener("beforeunload",event=>{
    for(const {frame}of pages.values())if(frame){try{if(frame.contentWindow.s3fHasUnsavedEdits?.()){event.preventDefault();event.returnValue="";break}}catch{}}
});
window.s3fWorkflowHost()?.postMessage({type:"s3f-workspace-ready",workspace:new URLSearchParams(location.search).get("workspace")},location.origin);
