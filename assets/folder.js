import {workflowHost} from './workflow-host.mjs';
import {civitaiBrowser} from './civitai-browser.mjs?v=5';
const uuid=()=>[...crypto.getRandomValues(new Uint8Array(16))].map(value=>value.toString(16).padStart(2,'0')).join('');
const $=id=>document.getElementById(id),params=new URLSearchParams(location.search),folder=params.get('folder'),node=params.get('node'),client=uuid();
let listing=null,selected=null,current=null,busy=false,batching=false,batchStarting=false,queuedClip=null,reviewDirty=false,refreshing=false;
let issues=[],issueIndex=-1,versions=[],compared=false,presetLoading=false,presetRequest=0;
let listingRequest=null,listingGeneration=0,lastListingRefresh=0,reviewGeneration=0;
let civitaiReview=false,activeEditor='timeline';
const processingClips=new Set();
const selectedSubfolders=new Set(['']);
let subfolderPaths=[];
const reviewOrderKey=`s3f-folder-review:${folder}`;
let reviewOrder={mode:'alphabetical',scope:'',ids:[]};
try{
    const saved=JSON.parse(localStorage.getItem(reviewOrderKey));
    if(saved&&['alphabetical','random'].includes(saved.mode)&&typeof saved.scope==='string'&&Array.isArray(saved.ids))
        reviewOrder={mode:saved.mode,scope:saved.scope,ids:[...new Set(saved.ids.filter(id=>typeof id==='string'))]};
}catch{/* Review remains available when browser storage is disabled. */}
$('review-order').value=reviewOrder.mode;
const pending=new Map(),frames=new Map(),labels={pending:'Without scripts',ignored:'Ignored',approved:'Approved',existing:'Existing funscript'};
const presetFields={preferred_anchor:'anchor',smoothing_ms:'smoothing',range_mode:'range-mode',movement_range:'range',sample_fps:'fps',batch_size:'batch',cut_sensitivity:'cuts'};
const defaultPreset={preferred_anchor:'auto',smoothing_ms:30,range_mode:'adaptive',movement_range:.2,sample_fps:0,batch_size:8,cut_sensitivity:'normal'};
const gallery=civitaiBrowser($('civitai-panel'),{folder,
    openClip:async id=>{await act('open',id,{propagate:true});},
    processClips:async ids=>{await act('bulk',null,{clip_ids:ids,propagate:true});},startQueue:()=>act('queue_start',null,{propagate:true}),refreshFolder:refresh,
    reviewState:()=>({entry:listing?.entries.find(e=>e.id===current?.id),busy,batching,processing:batchStarting&&queuedClip===current?.id,ready:!!motion()?.s3fEditorRevision}),
    reviewMode:value=>{civitaiReview=value;workbench();},
    decide:async(action,id,category)=>act('civitai_'+action,id,{category,propagate:true})});
function workbench(){
    $('clip-workbench').hidden=$('local-panel').hidden&&!civitaiReview;
    $('approve').parentElement.hidden=civitaiReview&&$('local-panel').hidden;
    $('folder-shortcuts').hidden=civitaiReview&&$('local-panel').hidden;
    if($('clip-workbench').hidden)pauseEditors();
}
function pauseMedia(frame){frame.contentDocument?.querySelectorAll('video,audio').forEach(media=>media.pause());frame.contentWindow.s3fPausePreview?.();}
function pauseEditors(except=null){for(const frame of frames.values())if(frame!==except)pauseMedia(frame);}
function showEditor(kind,scroll=false){
    activeEditor=kind;
    for(const [name,panel]of [['timeline','processing'],['motion','result']]){
        const selected=name===kind,tab=$(`${name}-tab`);
        tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected?0:-1;$(panel).hidden=!selected;
    }
    for(const frame of frames.values())if(frame.dataset.kind!==kind||$('clip-workbench').hidden)pauseMedia(frame);
    if(scroll)$('editors').scrollIntoView({behavior:'smooth',block:'start'});
}
for(const kind of ['timeline','motion'])$(`${kind}-tab`).onclick=()=>showEditor(kind);
$('editor-tabs').addEventListener('keydown',event=>{
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    event.preventDefault();const kind=event.key==='Home'?'timeline':event.key==='End'?'motion':activeEditor==='timeline'?'motion':'timeline';
    showEditor(kind);$(`${kind}-tab`).focus();
});
function showLibrary(remote){
    $('local-panel').hidden=remote;$('civitai-panel').hidden=!remote;
    $('local-tab').setAttribute('aria-pressed',String(!remote));$('civitai-tab').setAttribute('aria-pressed',String(remote));
    workbench();
    if(remote){pauseEditors();void gallery.activate().catch(error=>status(error.message,true));}
    else gallery.deactivate();
}
$('local-tab').onclick=()=>showLibrary(false);$('civitai-tab').onclick=()=>showLibrary(true);
function status(text,error=false){$('status').textContent=text;$('status').classList.toggle('error',error);}
function motion(){return frames.get(`motion:${current?.editor_session}`)?.contentWindow;}
function inSubfolder(e){return [...selectedSubfolders].some(sub=>!sub||e.name.startsWith(sub+'/'));}
function folderCandidates(){return (listing?.entries||[]).filter(e=>inSubfolder(e)&&e.status==='pending'&&e.batch_result!=='ready');}
function folderScope(){return selectedSubfolders.size===1?{subfolder:[...selectedSubfolders][0]}:{clip_ids:folderCandidates().map(e=>e.id)};}
function folderSelectionChanged(){
    render();void loadPreset().catch(error=>status(error.message,true));
}
function showFolderPicker(open){
    $('subfolder-menu').hidden=!open;$('subfolder').setAttribute('aria-expanded',String(open));
    if(open)$('subfolder-search').focus();
}
function updateFolderChoices(paths){
    if(JSON.stringify(paths)===JSON.stringify(subfolderPaths))return;
    subfolderPaths=paths;
    $('subfolder-options').replaceChildren(...paths.map(path=>{
        const label=document.createElement('label'),input=document.createElement('input');input.type='checkbox';input.value=path;
        label.append(input,document.createTextNode(path));input.onchange=()=>{
            selectedSubfolders.delete('');
            if(input.checked)selectedSubfolders.add(path);else selectedSubfolders.delete(path);
            folderSelectionChanged();
        };return label;
    }));
    let changed=false;for(const path of selectedSubfolders)if(path&&!paths.includes(path)){selectedSubfolders.delete(path);changed=true;}
    if(changed)folderSelectionChanged();
}
function renderFolderPicker(){
    const all=selectedSubfolders.has(''),paths=[...selectedSubfolders],query=$('subfolder-search').value.toLowerCase();
    $('subfolder').textContent=all?'Whole folder':paths.length===1?paths[0]:paths.length?`${paths.length} folders selected`:'Choose folders';
    $('subfolder').title=paths.join('\n');$('subfolder-whole').setAttribute('aria-pressed',String(all));
    for(const id of ['subfolder-whole','subfolder-clear','subfolder-search'])$(id).disabled=busy;
    let matches=0;
    for(const input of $('subfolder-options').querySelectorAll('input')){
        input.checked=selectedSubfolders.has(input.value);input.disabled=busy;
        input.parentElement.hidden=!input.value.toLowerCase().includes(query);if(!input.parentElement.hidden)matches++;
    }
    $('subfolder-empty').hidden=matches>0;
    $('subfolder-count').textContent=all?'Whole folder, including nested folders':`${paths.length} folders selected · nested folders included`;
}
function saveReviewOrder(){try{localStorage.setItem(reviewOrderKey,JSON.stringify(reviewOrder));}catch{/* Keep the order for this window. */}}
function shuffled(values){
    const result=[...values];
    for(let i=result.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[result[i],result[j]]=[result[j],result[i]];}
    return result;
}
function mixedFolderOrder(entries,firstId=null){
    const first=entries.find(e=>e.id===firstId),groups=new Map(),parent=e=>e.name.slice(0,e.name.lastIndexOf('/')+1);
    for(const entry of entries)if(entry!==first){const name=parent(entry);if(!groups.has(name))groups.set(name,[]);groups.get(name).push(entry.id);}
    const folders=shuffled([...groups.keys()]);
    // The open clip starts the pass. Prefer another folder immediately after it.
    if(first&&folders.includes(parent(first))){folders.splice(folders.indexOf(parent(first)),1);folders.push(parent(first));}
    const queues=folders.map(name=>shuffled(groups.get(name))),ids=first?[first.id]:[];
    while(queues.some(queue=>queue.length))for(const queue of queues)if(queue.length)ids.push(queue.pop());
    return ids;
}
function visibleEntries(){
    if(!listing)return [];
    const filter=$('filter').value,quality=$('quality-filter').value,query=$('search').value.toLowerCase();
    const entries=listing.entries.filter(e=>inSubfolder(e)&&e.name.toLowerCase().includes(query)
    &&(filter==='all'||filter==='active'&&e.status!=='ignored'||filter==='ready'&&e.status==='pending'&&e.batch_result==='ready'||filter==='done'&&['existing','approved'].includes(e.status)||e.status===filter)
    &&(quality==='all'||quality==='low'&&e.quality>=1&&e.quality<=2||Number(quality)===(e.quality||0)));
    if(reviewOrder.mode!=='random')return entries;
    const scope=JSON.stringify([[...selectedSubfolders].sort(),filter,quality,query]),byId=new Map(entries.map(e=>[e.id,e]));
    let ids;
    if(scope!==reviewOrder.scope)ids=mixedFolderOrder(entries,selected);
    else{
        ids=reviewOrder.ids.filter(id=>byId.has(id));const known=new Set(ids);
        ids.push(...mixedFolderOrder(entries.filter(e=>!known.has(e.id))));
    }
    if(scope!==reviewOrder.scope||JSON.stringify(ids)!==JSON.stringify(reviewOrder.ids)){
        reviewOrder={...reviewOrder,scope,ids};saveReviewOrder();
    }
    return ids.map(id=>byId.get(id));
}
function batchStatus(batch){
    if(!batch)return;
    const stages={complete:'Complete',paused:'Paused after clip',stopped:'Stopped · drafts kept',interrupted:'Interrupted · drafts kept',running:'Processing'};
    const eta=Number.isFinite(batch.eta_seconds)?` · about ${Math.max(1,Math.ceil(batch.eta_seconds/60))} min remaining`:'';
    $('batch-status').textContent=`${stages[batch.stage]||batch.stage} · ${batch.completed.length} / ${batch.total} drafts ready · ${batch.failed.length} failed${batch.current?' · '+batch.current:''}${eta}`
        +(batch.deferred?.length?`\n${batch.deferred.length} clips deferred while open for review.`:'')
        +(batch.failed.length?'\n'+batch.failed.map(e=>`${e.name}: ${e.error}`).join('\n'):'');
}
function render(){
    const entries=listing?.entries||[],entry=entries.find(e=>e.id===selected),visible=visibleEntries(),locked=!!entry?.processing||(batchStarting&&entry?.id===queuedClip);
    if(current?.id===entry?.id){
        if(entry.processing)processingClips.add(entry.id);
        else if(processingClips.delete(entry.id))void refreshResult(entry.id).catch(error=>status(error.message,true));
    }
    for(const frame of frames.values())frame.inert=busy||locked;
    $('root').textContent=listing?.root||'';$('counts').textContent=listing?Object.entries(listing.counts).map(([k,v])=>`${v} ${labels[k].toLowerCase()}`).join(' · '):'';
    $('selected').textContent=current?(current.civitai_temporary?current.name.split('/').at(-1)+' · Temporary review':current.name):'Select a video';$('detail').textContent=entry?`${labels[entry.status]}${locked?' · processing · this clip is read-only':entry.batch_result==='ready'?' · draft ready for review':entry.draft?' · saved draft':''}${entry.error?' · last batch: '+entry.error:''}`:'';
    $('approve').textContent=entry?.existing.length?'Approve & replace scripts':'Approve & save next to video';
    for(const id of ['review','note','quality','save-version','restore-version','rate-version'])$(id).disabled=busy||locked||!entry;
    $('approve').disabled=busy||locked||!entry||entry.id!==current?.id||entry.status==='ignored'||entry.civitai_temporary;$('approve-next').disabled=$('approve').disabled;
    $('ignore').disabled=busy||locked||!entry||entry.status==='ignored';$('ignore-next').disabled=$('ignore').disabled;
    $('restore').disabled=busy||locked||entry?.status!=='ignored';$('refresh').disabled=busy;$('open').disabled=busy||!entry;
    $('previous').disabled=$('next').disabled=busy||!visible.some(e=>e.id!==selected);
    for(const id of ['filter','subfolder','quality-filter','search','clips','review-order'])$(id).disabled=busy;
    $('reshuffle').disabled=busy||reviewOrder.mode!=='random'||visible.length<2;
    $('review-order-hint').textContent=reviewOrder.mode==='random'?'Takes turns between folders. Each clip appears once per pass; new clips join at the end.':'Review clips in filename order.';
    renderFolderPicker();
    const choices=visible.some(e=>e.id===selected)?visible:[...(entry?[entry]:[]),...visible];
    if(document.activeElement!==$('clips'))$('clips').replaceChildren(...choices.map(e=>new Option(`${e.name} · ${e.processing?'Processing':labels[e.status]}${e.quality?' · '+e.quality+'★':''}`,e.id,false,e.id===selected)));
    $('position').textContent=visible.length?`${visible.findIndex(e=>e.id===selected)+1 || '–'} / ${visible.length}`:'No matches';
    const candidates=folderCandidates();
    $('bulk-count').textContent=`${candidates.length} clips to process`;$('bulk').disabled=busy||batching||!candidates.length;
    $('bulk').textContent=['paused','stopped','interrupted'].includes(listing?.batch?.stage)?'Resume remaining clips':selectedSubfolders.has('')?'Process whole folder':selectedSubfolders.size===1?'Process selected folder':'Process selected folders';
    $('retry').disabled=busy||batching||!candidates.some(e=>e.batch_result==='error');$('cancel').disabled=$('pause').disabled=!batching;
    $('save-preset').disabled=busy||batching||presetLoading||selectedSubfolders.size!==1;$('preflight').disabled=busy||!candidates.length;
    for(const id of Object.values(presetFields))$('preset-'+id).disabled=$('save-preset').disabled;
    $('compare').disabled=busy||!$('versions').value;$('restore-version').disabled||=!$('versions').value;$('rate-version').disabled||=!$('versions').value;
    $('clear-compare').disabled=!compared;$('next-issue').disabled=!issues.length;$('refresh-issues').disabled=busy||!current;
    if(!reviewDirty){$('note').value=entry?.note||'';$('quality').value=String(entry?.quality||0);}
}
async function refreshResult(clip){
    if(current?.id!==clip)return;
    await motion()?.s3fUpdate?.();
    if(current?.id!==clip)return;
    await frames.get(`timeline:${current.timeline}`)?.contentWindow.s3fTimelineLoad?.();
    if(current?.id===clip)await loadReview();
}
function useListing(value,refreshed=true){
    listing=value;listingGeneration++;if(refreshed)lastListingRefresh=Date.now();
    if(!batchStarting)batching=['queued','running'].includes(listing.batch?.stage);
    const paths=new Set();for(const e of listing.entries){const parts=e.name.split('/');parts.pop();while(parts.length){paths.add(parts.join('/'));parts.pop();}}
    updateFolderChoices([...paths].sort());
    if(!listing.entries.some(e=>e.id===selected))selected=current?.id||listing.entries.find(e=>e.status==='pending')?.id||listing.entries[0]?.id||null;
    batchStatus(listing.batch);render();
}
function refresh(){
    if(listingRequest)return listingRequest;
    const generation=listingGeneration;
    listingRequest=(async()=>{
        const response=await fetch(new URL(`../folders/${folder}`,location.href),{cache:'no-store'});if(!response.ok)throw new Error(await response.text());
        const value=await response.json();if(generation===listingGeneration)useListing(value);
    })().finally(()=>{listingRequest=null;});
    return listingRequest;
}
function request(action,clip,extra={}){
    const host=workflowHost();if(!host)throw new Error('Open this folder from its ComfyUI node.');
    return new Promise((resolve,reject)=>{const id=uuid(),timer=setTimeout(()=>{pending.delete(id);reject(new Error('ComfyUI did not reply. Refresh to check the action before retrying.'));},120000);
        pending.set(id,{resolve,reject,timer});host.postMessage({type:'s3f-folder-action',folder,node,client,request:id,action,clip,...extra},location.origin);});
}
async function loadPreset(){
    const generation=++presetRequest;presetLoading=false;
    if(selectedSubfolders.size!==1){$('preset-origin').textContent='Select one folder to edit its preset. Each clip uses its own folder’s saved preset during processing.';render();return;}
    presetLoading=true;render();
    try{
        const result=await request('preset',null,{subfolder:[...selectedSubfolders][0]});if(generation!==presetRequest)return;
        for(const [key,id]of Object.entries(presetFields))$('preset-'+id).value=(result.settings||defaultPreset)[key];
        $('preset-origin').textContent=result.settings?`Using preset from ${result.subfolder||'the whole folder'}`:'No saved preset · processing uses the node settings until you save one.';
    }finally{if(generation===presetRequest){presetLoading=false;render();}}
}
async function loadReview(){
    if(!current)return;const clip=current.id,generation=++reviewGeneration;
    const [found,saved]=await Promise.all([request('issues',clip),request('versions',clip)]);if(current?.id!==clip||generation!==reviewGeneration)return;
    issues=found;issueIndex=-1;versions=saved;
    $('issue-count').textContent=issues.length?`${issues.length} ranges to inspect`:'No review flags found';
    $('issues').replaceChildren(...issues.map((issue,index)=>{const b=document.createElement('button');b.textContent=`${(issue.start_ms/1000).toFixed(1)}–${(issue.end_ms/1000).toFixed(1)}s · ${issue.reason}`;b.onclick=()=>showIssue(index);return b;}));
    motion()?.s3fFolderIssues?.(issues);
    const old=$('versions').value;$('versions').replaceChildren(new Option('Choose a saved version',''),...versions.map(v=>new Option(`${v.name}${v.quality?' · '+v.quality+'★':''}`,v.id)));if(versions.some(v=>v.id===old))$('versions').value=old;
    render();
}
function showIssue(index){issueIndex=index;const issue=issues[index];if(!issue)return;showEditor('motion',true);motion()?.s3fFolderSelectRange?.(issue.start_ms,issue.end_ms,{play:$('autoplay').checked,track:issue.track});}
function versionFields(){const v=versions.find(v=>v.id===$('versions').value);$('version-name').value=v?.name||'';$('version-quality').value=String(v?.quality||0);$('version-note').value=v?.note||'';render();}
function shortcuts(event){
    if($('local-panel').hidden)return;
    if(!event.altKey||event.ctrlKey||event.metaKey||event.repeat||event.target.closest?.('input,textarea,select,[contenteditable=true]'))return;
    const action={ArrowLeft:'previous',ArrowRight:'next',Enter:'approve-next',Backspace:'ignore-next'}[event.key];
    if(action){event.preventDefault();if(!$(action).disabled)void act(action);}
    else if(/^[1-5]$/.test(event.key)&&!$('quality').disabled){event.preventDefault();$('quality').value=event.key;reviewDirty=true;void act('review');}
}
window.s3fWorkflowHost=()=>workflowHost();
window.s3fFolderFrames=()=>[...frames].map(([key,frame])=>({key,window:frame.contentWindow}));
window.s3fFolderIdentity=()=>({folder,entry:current});window.s3fHasUnsavedEdits=()=>reviewDirty;
window.s3fFolderViewerReady=win=>{
    if(win!==motion())return;win.s3fFolderIssues?.(issues);
};
window.s3fFolderCurrent=(entry,descriptors=[])=>{
    if(current?.id!==entry?.id){
        current=entry;selected=entry?.id||selected;reviewDirty=false;issues=[];versions=[];compared=false;
        $('issues').replaceChildren();$('issue-count').textContent=entry?'Loading review details…':'';
        $('versions').replaceChildren(new Option('Choose a saved version',''));
        void loadReview().catch(error=>{if(current?.id===entry?.id)status(error.message,true);});
    }else current=entry;
    const wanted=new Set(descriptors.map(d=>d.key));for(const [key,frame]of frames)if(!wanted.has(key)){pauseMedia(frame);frame.remove();frames.delete(key);}
    for(const d of descriptors)if(!frames.has(d.key)){
        const url=new URL(d.url,location.href);if(url.origin!==location.origin)throw new Error('Invalid clip editor');
        const frame=document.createElement('iframe');frame.title=d.label;frame.dataset.kind=d.kind;frame.allow='fullscreen';frame.src=url.href;
        frame.onload=()=>{window.parent.s3fWorkspaceFramesChanged?.();frame.contentDocument?.addEventListener('keydown',shortcuts,true);
            frame.contentDocument?.addEventListener('play',()=>{
                if(d.kind!==activeEditor||$('clip-workbench').hidden)pauseMedia(frame);else pauseEditors(frame);
            },true);
            pauseMedia(frame);
            if(d.kind==='motion')window.s3fFolderViewerReady(frame.contentWindow);};
        frames.set(d.key,frame);$(d.kind==='motion'?'motion-frame':'timeline-frame').replaceChildren(frame);
    }
    render();
};
window.s3fOpenWorkspacePage=(url,kind)=>{if(kind!=='motion')return;const session=new URL(url,location.href).searchParams.get('session');const frame=frames.get(`motion:${session}`);if(frame){showEditor('motion',true);void frame.contentWindow.s3fUpdate?.();}};
window.s3fReconnect=async({hostChanged=false}={})=>{
    if(hostChanged){for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('ComfyUI’s main tab reloaded. Completed drafts and your edits are kept.'));}pending.clear();batchStarting=false;}
    await refresh();
};
window.addEventListener('message',event=>{
    if(event.origin!==location.origin||event.source!==workflowHost())return;
    if(event.data?.type==='s3f-folder-progress'){
        if(event.data.batch){batchStarting=false;batching=event.data.batch.stage==='running';if(listing){listing.batch=event.data.batch;for(const e of listing.entries)e.processing=batching&&e.id===event.data.batch.current_id;}batchStatus(event.data.batch);render();}
        else if(event.data.text)$('batch-status').textContent=event.data.text;return;
    }
    if(event.data?.type==='s3f-folder-finished'){
        batching=batchStarting=false;
        void (async()=>{await refresh();await loadReview();status(event.data.error||'Batch finished · review your drafts below.',!!event.data.error);})().catch(error=>status(error.message,true));return;
    }
    if(event.data?.type!=='s3f-folder-result')return;const p=pending.get(event.data.request);if(!p)return;pending.delete(event.data.request);clearTimeout(p.timer);event.data.error?p.reject(new Error(event.data.error)):p.resolve(event.data.result);
});
async function saveReview(){if(reviewDirty&&selected){useListing(await request('review',selected,{quality:Number($('quality').value),note:$('note').value}));reviewDirty=false;}}
async function openClip(id){
    status('Saving edits and opening the next clip…');
    const result=await request('open',id);current=result;selected=id;compared=false;
    // The open response has fresh state for this clip. Review details load once
    // when its editors attach; neither requires another full library scan here.
    const entries=listing.entries.some(e=>e.id===id)?listing.entries.map(e=>e.id===id?result:e):[...listing.entries,result];
    useListing({...listing,entries,counts:Object.fromEntries(Object.keys(labels).map(state=>[state,entries.filter(e=>e.status===state).length]))},false);
    status(result.script_warning||'Clip ready. Process, refine and review the result below.');
}
async function act(action,target=null,extra={}){
    if(['cancel','pause'].includes(action)){try{await request(action);status(action==='pause'?'Pause requested · the current clip will finish first.':'Stop requested · completed drafts are kept.');}catch(error){status(error.message,true);}return;}
    if(busy){if(extra.propagate)throw new Error('Wait for the current folder action to finish.');return;}busy=true;render();
    try{
        await saveReview();
        if(action==='refresh'){await refresh();await loadReview();status('Folder refreshed.');return;}
        if(action==='review'){status('Rating and note saved.');return;}
        if(action==='preflight'){const result=await request('preflight',null,folderScope());status((result.ok?'Ready · ':'Missing requirements · ')+[...result.checks,...result.errors].join(' · '),!result.ok);return;}
        if(action==='save-preset'){const settings=Object.fromEntries(Object.entries(presetFields).map(([key,id])=>[key,typeof defaultPreset[key]==='number'?Number($('preset-'+id).value):$('preset-'+id).value]));await request('preset',null,{subfolder:[...selectedSubfolders][0],settings});await loadPreset();status('Subfolder preset saved.');return;}
        if(action==='civitai_approve'||action==='civitai_reject'){
            const result=await request(action,target,{category:extra.category,replace:!!listing.entries.find(e=>e.id===target)?.existing.length});
            useListing(result.listing);if(current)await loadReview();return result;
        }
        if(action==='bulk'||action==='retry'||action==='queue_start'){
            if(batching)throw new Error('A folder batch is already running. Review it in Local clips before starting another.');
            queuedClip=listing.entries.find(e=>e.id===current?.id&&(extra.clip_ids?extra.clip_ids.includes(e.id):inSubfolder(e))&&e.status==='pending'&&e.batch_result!=='ready'&&(action!=='retry'||e.batch_result==='error'))?.id;
            const scope=action==='queue_start'?{}:extra.clip_ids?{clip_ids:extra.clip_ids}:folderScope();
            batchStarting=batching=true;render();let result;try{result=await request(action==='queue_start'?'queue_start':'bulk',null,{...scope,retry_failed:action==='retry'});}catch(error){batchStarting=batching=false;throw error;}
            status('Batch queued. You can review other completed clips while it processes.');return result;
        }
        if(action==='refresh-issues'){await loadReview();return;}
        if(action==='next-issue'){showIssue((issueIndex+1)%issues.length);return;}
        if(action==='compare'){const v=await request('version',selected,{version:$('versions').value});if(!motion()?.s3fFolderCompare)throw new Error('Wait for Motion Studio to load.');showEditor('motion',true);motion().s3fFolderCompare(v);compared=true;status(`Comparing ${v.name} in pink with current Main in green.`);return;}
        if(action==='clear-compare'){motion()?.s3fFolderCompare?.(null);compared=false;return;}
        if(['save-version','rate-version','restore-version'].includes(action)){
            const requestAction=action.replaceAll('-','_');
            await request(requestAction,selected,{version:$('versions').value,name:$('version-name').value,quality:Number($('version-quality').value),note:$('version-note').value});
            if(action==='restore-version'){motion()?.s3fFolderCompare?.(null);compared=false;}
            await loadReview();status(action==='restore-version'?'Version restored into Main. The previous Main is saved as a recovery version. Approve to export.':'Version saved.');return;
        }
        const before=visibleEntries(),position=before.findIndex(e=>e.id===selected);
        if(action==='previous'||action==='next'){const direction=action==='next'?1:-1;target=before[position<0?(direction===1?0:before.length-1):(position+direction+before.length)%before.length]?.id;action='open';}
        const nextAfter=['approve-next','ignore-next'].includes(action);if(nextAfter)action=action.split('-')[0];
        const id=target||selected,entry=listing.entries.find(e=>e.id===id);if(!entry)return;
        if(action==='open'){await openClip(id);return true;}
        const result=await request(action==='restore'?'ignore':action,id,{ignored:action!=='restore',note:$('note').value,replace:action==='approve'&&entry.existing.length>0});
        if(action==='approve'){useListing(result.listing);status(`Approved · ${result.files.length} scripts saved beside ${entry.name}${result.backups?.length?' · previous scripts backed up':''}.`);}
        else{useListing(result);status(action==='restore'?'Video restored.':'Video ignored. Its draft, rating and note are kept.');}
        if(nextAfter){const candidates=[...before.slice(position+1),...before.slice(0,position)],visible=new Set(visibleEntries().map(e=>e.id));const next=candidates.find(e=>e.id!==id&&visible.has(e.id));if(next){await openClip(next.id);return;}else status('No more clips in this filtered view.');}
        await loadReview();
    }catch(error){status(error.message,true);if(extra.propagate)throw error;}finally{busy=false;render();}
}
for(const id of ['open','approve','approve-next','ignore','ignore-next','restore','previous','next','refresh','review','bulk','retry','preflight','pause','cancel','save-preset','compare','clear-compare','save-version','rate-version','restore-version','refresh-issues','next-issue'])$(id).onclick=()=>act(id);
$('clips').onchange=()=>act('open',$('clips').value);$('versions').onchange=versionFields;
for(const id of ['filter','quality-filter'])$(id).onchange=render;
$('review-order').onchange=()=>{reviewOrder.mode=$('review-order').value;saveReviewOrder();render();};
$('reshuffle').onclick=()=>{reviewOrder.scope='';render();};
$('subfolder').onclick=()=>showFolderPicker($('subfolder-menu').hidden);
$('subfolder-whole').onclick=()=>{selectedSubfolders.clear();selectedSubfolders.add('');folderSelectionChanged();};
$('subfolder-clear').onclick=()=>{selectedSubfolders.clear();folderSelectionChanged();};
$('subfolder-done').onclick=()=>{showFolderPicker(false);$('subfolder').focus();};
$('subfolder-search').oninput=renderFolderPicker;
document.addEventListener('pointerdown',event=>{if(!$('subfolder-picker').contains(event.target))showFolderPicker(false);});
$('subfolder-picker').addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();showFolderPicker(false);$('subfolder').focus();}});
$('search').oninput=render;$('note').oninput=$('quality').onchange=()=>{reviewDirty=true;};document.addEventListener('keydown',shortcuts,true);
setInterval(async()=>{if(refreshing||busy)return;refreshing=true;try{
    const entry=listing?.entries.find(e=>e.id===current?.id);
    if(current&&(!batchStarting||current.id!==queuedClip)&&!entry?.processing&&!['waiting','downloading','processing'].includes(entry?.queue_state))await request('lease',current.id);
    if(!busy&&Date.now()-lastListingRefresh>=15000)await refresh();
}catch{/* Reconnection keeps the current draft. */}finally{refreshing=false;}},8000);
refresh().then(()=>loadPreset()).then(()=>status('Browse clips with the arrows, or choose folders to bulk process unscripted videos.')).catch(error=>status(error.message,true));
