import {workflowHost} from './workflow-host.mjs';
import {civitaiBrowser} from './civitai-browser.mjs?v=15';
const uuid=()=>[...crypto.getRandomValues(new Uint8Array(16))].map(value=>value.toString(16).padStart(2,'0')).join('');
const $=id=>document.getElementById(id),params=new URLSearchParams(location.search),folder=params.get('folder'),node=params.get('node'),client=uuid();
let listing=null,selected=null,current=null,busy=false,batching=false,batchStarting=false,queuedClip=null,reviewDirty=false,refreshing=false;
let tagsDirty=false,tagger=null,taggerLoading=null;
let uploader=null,uploaderLoading=null;
let issues=[],issueIndex=-1,versions=[],compared=false,presetLoading=false,presetRequest=0;
let listingRequest=null,listingGeneration=0,lastListingRefresh=0,reviewGeneration=0;
let intensityEstimate=null,intensityRequest=null,intensityRetry=0;
let civitaiReview=false,civitaiReviewClip=null,activeEditor='timeline';
let approvalClip=null;
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
for(const button of document.querySelectorAll('[data-folder-tool]'))button.onclick=()=>{
    const show=button.getAttribute('aria-expanded')!=='true';
    for(const control of document.querySelectorAll('[data-folder-tool]')){
        const active=show&&control===button,panel=$(control.dataset.folderTool);
        control.setAttribute('aria-expanded',String(active));panel.hidden=!active;panel.open=true;
    }
};
const pending=new Map(),frames=new Map(),labels={pending:'Without scripts',ignored:'Skipped for now',approved:'Approved',existing:'Existing funscript'};
const clipStatus=entry=>entry.status==='pending'&&entry.batch_result==='ready'?'Draft ready for review':labels[entry.status];
let h3=null,h3Loading=null;
const editorLoads=new Map();
let prefetch=null,prefetchTimer=null;
try{$('prefetch').checked=localStorage.getItem('s3f-folder-prefetch')!=='off';}catch{}
const presetFields={preferred_anchor:'anchor',smoothing_ms:'smoothing',range_mode:'range-mode',movement_range:'range',sample_fps:'fps',batch_size:'batch',cut_sensitivity:'cuts'};
const defaultPreset={preferred_anchor:'auto',smoothing_ms:30,range_mode:'adaptive',movement_range:.2,sample_fps:0,batch_size:8,cut_sensitivity:'normal'};
const gallery=civitaiBrowser($('civitai-panel'),{folder,
    openClip:async(id,options)=>{await act('open',id,{propagate:true});if(options&&(!options.current||options.current()))showEditor(options.processed?'motion':'timeline',true);},
    processClips:async ids=>{await act('bulk',null,{clip_ids:ids,propagate:true});},startQueue:()=>act('queue_start',null,{propagate:true}),refreshFolder:refresh,
    reviewState:()=>({entry:listing?.entries.find(e=>e.id===current?.id),busy,batching,processing:batchStarting&&queuedClip===current?.id,ready:!editorLoads.has('motion')&&!!motion()?.s3fEditorRevision}),
    reviewMode:(value,clip)=>{civitaiReview=value;civitaiReviewClip=clip;workbench();},
    decide:async(action,id,category)=>act('civitai_'+action,id,{category,propagate:true})});
function tagControls(locked){
    tagger?.render(listing?.tagging===true,busy||locked);
    if(listing?.tagging&&!tagger&&!taggerLoading){
        taggerLoading=import('./folder-tags.mjs?v=2').then(({folderTags})=>{
            tagger=folderTags({folder,scope:()=>audioSyncScope().filter(e=>e.status!=='ignored'),selected:()=>current?.id,saveReview:()=>act('review',null,{propagate:true}),refresh,status});render();
        }).catch(error=>status('Could not load tag controls: '+error.message,true));
    }
}
function uploadControls(){
    uploader?.render(listing?.dataset_upload===true,busy||editorLoads.has('motion'));
    if(listing?.dataset_upload&&!uploader&&!uploaderLoading){
        uploaderLoading=import('./folder-upload.mjs?v=3').then(({folderUpload})=>{
            uploader=folderUpload({folder,saveEdits:()=>act('prepare-upload',null,{propagate:true})});render();
        }).catch(error=>status('Could not load upload controls: '+error.message,true));
    }
}
function workbench(){
    const remote=$('local-panel').hidden;
    $('clip-workbench').hidden=(remote&&(!civitaiReview||!civitaiReviewClip||current?.id!==civitaiReviewClip))||(listing?.h3&&(!h3||!h3.matchesPage(current)));
    $('clip-workbench').classList.toggle('civitai-review',remote&&civitaiReview);
    $('approve').parentElement.hidden=civitaiReview&&$('local-panel').hidden;
    $('approval-destination').hidden=$('local-panel').hidden||!listing?.entries.find(e=>e.id===selected)?.civitai_temporary;
    $('folder-shortcuts').hidden=civitaiReview&&$('local-panel').hidden;
    if($('clip-workbench').hidden)pauseEditors();
}
function pauseMedia(frame){frame.contentDocument?.querySelectorAll('video,audio').forEach(media=>media.pause());frame.contentWindow.s3fPausePreview?.();}
function pauseEditors(except=null){for(const frame of frames.values())if(frame!==except)pauseMedia(frame);}
function restoreEditorScroll(frame){
    if(frame.s3fScrollY===undefined||!frame.getClientRects().length)return;
    frame.contentWindow.scrollTo(0,frame.s3fScrollY);delete frame.s3fScrollY;
}
function showEditor(kind,scroll=false){
    activeEditor=kind;
    for(const [name,panel]of [['timeline','processing'],['motion','result']]){
        const selected=name===kind,tab=$(`${name}-tab`);
        tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected?0:-1;$(panel).hidden=!selected;
    }
    for(const frame of frames.values()){
        if(frame.dataset.kind!==kind||$('clip-workbench').hidden)pauseMedia(frame);
        else if(!editorLoads.has(kind))restoreEditorScroll(frame);
    }
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
    schedulePrefetch();
}
$('local-tab').onclick=()=>showLibrary(false);$('civitai-tab').onclick=()=>showLibrary(true);
function status(text,error=false){$('status').textContent=text;$('status').classList.toggle('error',error);}
function motion(){return frames.get(`motion:${current?.editor_session}`)?.contentWindow;}
function intensityKey(){
    if(!current||current.id!==selected||editorLoads.has('motion'))return null;
    const revision=motion()?.s3fEditorRevision?.();
    return revision>0?`${current.id}:${revision}`:null;
}
function intensityControls(entry){
    const supported=['auto','manual'].includes(entry?.intensity_mode);
    $('intensity-auto').disabled=$('intensity').disabled||!supported;
    if(!reviewDirty)$('intensity-auto').checked=supported&&entry.intensity_mode==='auto';
    const automatic=$('intensity-auto').checked,estimate=intensityEstimate?.key===intensityKey()?intensityEstimate:null;
    if(automatic&&estimate&&Number($('intensity').value)!==estimate.level){
        $('intensity').value=String(estimate.level);reviewDirty=true;
    }
    $('intensity-estimate').textContent=!supported?'Restart ComfyUI to enable Auto':estimate
        ?estimate.level?`${automatic?'Auto':'Manual · estimate '+estimate.level} · Main L0 · ${estimate.typical_range}% range · ${estimate.cycles_per_second} cycles/s`:'Add a Main L0 curve to estimate intensity.'
        :automatic?'Estimating Main L0…':'Manual';
    $('intensity-estimate').title='Estimate from sustained curve speed and travel. Scene cuts and tiny jitter are discounted. This is relative intensity, not device speed.';
    $('intensity-meter').value=Number($('intensity').value);
    $('intensity-meter').title=$('intensity').selectedOptions[0]?.textContent||'Unrated';
}
async function refreshIntensity(){
    const entry=listing?.entries.find(e=>e.id===selected),key=intensityKey();
    if(busy||entry?.processing||!entry?.intensity_mode||!key||key===intensityEstimate?.key||key===intensityRequest?.key||Date.now()<intensityRetry)return;
    const pending={key};intensityRequest=pending;
    try{
        const result=await request('intensity',entry.id);
        if(key!==intensityKey()||result.clip!==current?.id||result.revision!==motion()?.s3fEditorRevision?.())return;
        intensityEstimate={...result,key};intensityRetry=0;render();
    }catch{
        if(key===intensityKey()){
            intensityRetry=Date.now()+5000;
            $('intensity-estimate').textContent='Estimate unavailable · retrying. Manual intensity is available.';
        }
    }finally{if(intensityRequest===pending)intensityRequest=null;}
}
function inSubfolder(e){return listing?.h3?(h3?h3.accepts(e):(e.h3?.main??e.h3?.latest)):[...selectedSubfolders].some(sub=>!sub||e.name.startsWith(sub+'/'));}
function audioSyncScope(){return (listing?.entries||[]).filter(inSubfolder);}
function audioSyncControls(){
    const entries=audioSyncScope(),marked=entries.filter(e=>e.audio_sync).length,supported=listing?.bulk_audio_sync===true;
    const scope=listing?.h3?'selected page and take scope':[...selectedSubfolders].map(path=>path||'Whole folder').join(' + ')||'No folders selected';
    $('bulk-audio-count').textContent=`${entries.length} clips · ${marked} marked Audio sync · ${scope}`;
    $('bulk-audio-mark').disabled=busy||!supported||marked===entries.length;
    $('bulk-audio-clear').disabled=busy||!supported||!marked;
    $('bulk-audio-hint').textContent=!supported?'Restart ComfyUI after processing finishes to enable bulk Audio sync.':`Labels all drafts, approved and skipped clips in the ${listing?.h3?'page and take scope':'selected folders and their nested folders'} for dataset exports. Show, Quality and Find only filter review. The curves are unchanged.`;
}
function folderCandidates(){return (listing?.entries||[]).filter(e=>inSubfolder(e)&&e.status==='pending'&&!e.civitai_set_aside&&e.batch_result!=='ready'&&e.h3?.render_mode!=='still');}
function folderScope(){return !listing?.h3&&selectedSubfolders.size===1?{subfolder:[...selectedSubfolders][0]}:{clip_ids:folderCandidates().map(e=>e.id)};}
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
    const entries=listing.entries.filter(e=>inSubfolder(e)&&(e.h3?.label||e.name).toLowerCase().includes(query)
    &&(filter==='all'||filter==='active'&&e.status!=='ignored'||filter==='ready'&&e.status==='pending'&&e.batch_result==='ready'||filter==='done'&&['existing','approved'].includes(e.status)||e.status===filter)
    &&(quality==='all'||quality==='low'&&e.quality>=1&&e.quality<=2||Number(quality)===(e.quality||0)));
    if(listing.h3||reviewOrder.mode!=='random')return entries;
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
    if(entry&&current?.id===entry.id){
        if(entry.processing)processingClips.add(entry.id);
        else if(processingClips.delete(entry.id))void refreshResult(entry.id).catch(error=>status(error.message,true));
    }
    for(const frame of frames.values())frame.inert=busy||locked||editorLoads.has(frame.dataset.kind);
    $('root').textContent=listing?.root||'';$('counts').textContent=listing?Object.entries(listing.counts).map(([k,v])=>`${v} ${labels[k].toLowerCase()}`).join(' · '):'';
    $('selected').textContent=current?(current.h3?.label||(current.civitai_temporary?current.name.split('/').at(-1)+' · Temporary review':current.name)):'Select a video';$('detail').textContent=entry?`${clipStatus(entry)}${locked?' · processing · this clip is read-only':entry.batch_result==='ready'?'':entry.draft?' · saved draft':''}${entry.script_warning?' · '+entry.script_warning:''}${entry.error?' · last batch: '+entry.error:''}`:'';
    const temporary=!!entry?.civitai_temporary,category=$('approval-category');
    if(approvalClip!==entry?.id){approvalClip=entry?.id;category.value=entry?.category_hint||'';}
    $('approval-destination').hidden=!temporary||$('local-panel').hidden;
    category.disabled=busy||locked||!entry;
    if(temporary){
        const categories=new Set(gallery.categoryNames());
        for(const e of entries){
            if(e.category_hint)categories.add(e.category_hint);
            if(!e.civitai_temporary&&e.name.includes('/'))categories.add(e.name.slice(0,e.name.lastIndexOf('/')));
        }
        $('approval-categories').replaceChildren(...[...categories].sort((a,b)=>a.localeCompare(b)).map(name=>new Option(name,name)));
    }
    $('approve').textContent=temporary?'Approve & save in category':entry?.existing.length?'Approve & replace scripts':'Approve & save next to video';
    $('approval-hint').textContent=temporary?'This is a temporary download. Choose or type a destination category above, then approve to save the video and Main funscripts there. Until approval, it remains a draft.':'Approval saves the Main curves from Motion Studio. After reprocessing, copy the source sections you want into Main before approving. Replacing approved scripts keeps a backup of the previous files.';
    for(const id of ['review','note','quality','save-version','restore-version','rate-version'])$(id).disabled=busy||locked||!entry;
    $('clip-tags').disabled=busy||locked||!listing?.tagging||!entry;
    $('clip-tags-origin').textContent=Object.entries(entry?.tag_sources||{}).map(([source,tags])=>`${source}: ${tags.length} tags`).join(' · ');
    $('audio-sync').disabled=busy||locked||typeof entry?.audio_sync!=='boolean';
    $('audio-sync').title=entry&&typeof entry.audio_sync!=='boolean'?'Restart ComfyUI after processing finishes to enable Audio sync.':'Marks this script as synchronized to audio in dataset exports. Independent of quality and approval.';
    $('intensity').disabled=busy||locked||!Number.isInteger(entry?.intensity);
    $('intensity').title=entry&&!Number.isInteger(entry.intensity)?'Restart ComfyUI after processing finishes to enable saved intensity ratings.':'How intense the motion feels: 1 very gentle to 5 very strong. Independent of quality.';
    $('approve').disabled=busy||locked||editorLoads.has('motion')||!entry||entry.id!==current?.id||entry.status==='ignored'||temporary&&!category.value.trim();$('approve-next').disabled=$('approve').disabled;
    $('approve').title=$('approve-next').title=temporary&&!category.value.trim()?'Choose or type a destination category first.':'';
    $('ignore').disabled=busy||locked||!entry||entry.status==='ignored';$('ignore-next').disabled=$('ignore').disabled;
    $('restore').disabled=busy||locked||entry?.status!=='ignored';$('refresh').disabled=busy;$('open').disabled=busy||!entry;
    $('previous').disabled=$('next').disabled=busy||!visible.some(e=>e.id!==selected);
    for(const id of ['filter','subfolder','quality-filter','search','clips','review-order'])$(id).disabled=busy;
    $('reshuffle').disabled=busy||reviewOrder.mode!=='random'||visible.length<2;
    $('review-order-hint').textContent=reviewOrder.mode==='random'?'Takes turns between folders. Each clip appears once per pass; new clips join at the end.':'Review clips in filename order.';
    $('review-order').title=$('review-order-hint').textContent;
    $('tools-activity').textContent=batching?'Processing in background · open Processing for progress':'';
    renderFolderPicker();
    const choices=visible.some(e=>e.id===selected)?visible:[...(entry?[entry]:[]),...visible];
    if(document.activeElement!==$('clips'))$('clips').replaceChildren(...choices.map(e=>new Option(`${e.h3?.label||e.name} · ${e.processing?'Processing':clipStatus(e)}${e.quality?' · '+e.quality+'★':''}${e.audio_sync?' · Audio sync':''}`,e.id,false,e.id===selected)));
    $('position').textContent=visible.length?`${visible.findIndex(e=>e.id===selected)+1 || '–'} / ${visible.length}`:'No matches';
    const candidates=folderCandidates();
    const reprocessEntries=audioSyncScope().filter(e=>e.status!=='ignored'&&e.h3?.render_mode!=='still');
    $('reprocess').disabled=busy||batching||!listing?.bulk_reprocess||!reprocessEntries.length;
    $('reprocess-count').textContent=listing?.bulk_reprocess?`${reprocessEntries.length} clips eligible for reprocessing`:'Restart ComfyUI and reload the main tab to enable reprocessing.';
    $('bulk-count').textContent=`${candidates.length} clips to process`;$('bulk').disabled=busy||batching||!candidates.length;
    $('bulk').textContent=['paused','stopped','interrupted'].includes(listing?.batch?.stage)?'Resume remaining clips':selectedSubfolders.has('')?'Process whole folder':selectedSubfolders.size===1?'Process selected folder':'Process selected folders';
    $('retry').disabled=busy||batching||!candidates.some(e=>e.batch_result==='error');$('cancel').disabled=$('pause').disabled=!batching;
    $('save-preset').disabled=busy||batching||presetLoading||selectedSubfolders.size!==1;$('preflight').disabled=busy||!candidates.length;
    for(const id of Object.values(presetFields))$('preset-'+id).disabled=$('save-preset').disabled;
    $('compare').disabled=busy||!$('versions').value;$('restore-version').disabled||=!$('versions').value;$('rate-version').disabled||=!$('versions').value;
    $('clear-compare').disabled=!compared;$('next-issue').disabled=!issues.length;$('refresh-issues').disabled=busy||!current;
    if(!reviewDirty){$('clip-tags').value=(entry?.tags||[]).join(', ');$('note').value=entry?.note||'';$('quality').value=String(entry?.quality||0);$('audio-sync').checked=entry?.audio_sync===true;$('intensity').value=String(entry?.intensity||0);}
    intensityControls(entry);
    h3?.render(listing,entry,busy);
    audioSyncControls();
    tagControls(locked);
    uploadControls();
    if(listing?.h3||civitaiReview)workbench();
    schedulePrefetch();
}
async function refreshResult(clip){
    if(current?.id!==clip)return;
    await motion()?.s3fUpdate?.();
    if(current?.id!==clip)return;
    await frames.get(`timeline:${current.timeline}`)?.contentWindow.s3fTimelineLoad?.();
    if(current?.id===clip)await loadReview();
}
function useListing(value,refreshed=true){
    if(value.partial){
        if(!listing||value.folder!==listing.folder)throw new Error('Refresh the folder before updating this clip.');
        const updates=new Map(value.entries.map(e=>[e.id,e]));
        const entries=listing.entries.map(e=>{const update=updates.get(e.id);updates.delete(e.id);return update||e;}).concat([...updates.values()]);
        value={...listing,entries,counts:Object.fromEntries(Object.keys(labels).map(state=>[state,entries.filter(e=>e.status===state).length]))};
        refreshed=false;
    }
    listing=value;listingGeneration++;if(refreshed)lastListingRefresh=Date.now();
    if(listing.h3&&!h3&&!h3Loading){
        h3Loading=import('./h3-project.mjs?v=4').then(({h3Project})=>{
            h3=h3Project({folder,host:workflowHost(),change:()=>render(),run:(action,extra)=>act(action,null,extra),open:id=>act('open',id)});render();
        }).catch(error=>{h3Loading=null;status('Could not load the H3 workspace: '+error.message,true);});
    }
    if(!batchStarting)batching=['queued','running'].includes(listing.batch?.stage);
    const paths=new Set();for(const e of listing.entries){const parts=e.name.split('/');parts.pop();while(parts.length){paths.add(parts.join('/'));parts.pop();}}
    updateFolderChoices([...paths].sort());
    if(!listing.entries.some(e=>e.id===selected))selected=current?.id||listing.entries.find(e=>e.status==='pending')?.id||listing.entries[0]?.id||null;
    batchStatus(listing.batch);render();
}
function refresh(force=false){
    if(listingRequest)return force?listingRequest.then(()=>refresh(true)):listingRequest;
    const generation=listingGeneration;
    listingRequest=(async()=>{
        const url=new URL(`../folders/${folder}`,location.href);if(force)url.searchParams.set('refresh','1');
        const response=await fetch(url,{cache:'no-store',signal:AbortSignal.timeout(120000)});if(!response.ok)throw new Error(await response.text());
        const value=await response.json();if(generation===listingGeneration)useListing(value);
    })().finally(()=>{listingRequest=null;});
    return listingRequest;
}
function request(action,clip,extra={}){
    const host=workflowHost();if(!host)throw new Error('Open this folder from its ComfyUI node.');
    return new Promise((resolve,reject)=>{const id=uuid(),timer=setTimeout(()=>{pending.delete(id);reject(new Error('ComfyUI did not reply. Refresh to check the action before retrying.'));},120000);
        pending.set(id,{resolve,reject,timer});host.postMessage({type:'s3f-folder-action',folder,node,client,request:id,action,clip,compact:true,...extra},location.origin);});
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
    void refreshIntensity();
};
function discardPrefetch(){
    clearTimeout(prefetchTimer);prefetchTimer=null;
    if(prefetch)for(const frame of prefetch.frames.values()){pauseMedia(frame);frame.remove();}
    prefetch=null;$('prefetch-status').textContent='';$('prefetch-status').title='';
}
function prefetchCandidate(){
    if(!$('prefetch').checked||$('local-panel').hidden||!current)return null;
    const entries=visibleEntries(),position=entries.findIndex(e=>e.id===current.id);
    const entry=entries[position<0?0:(position+1)%entries.length];
    return entry&&entry.id!==current.id&&entry.draft&&!entry.processing&&entry.status!=='ignored'
        &&!['waiting','downloading','processing'].includes(entry.queue_state)?entry:null;
}
function schedulePrefetch(){
    // Finish opening the selected clip before using bandwidth for one ahead.
    if(busy||editorLoads.size)return;
    const entry=prefetchCandidate();
    if(prefetch?.entry.id===entry?.id&&prefetch?.entry.timeline===entry?.timeline&&prefetch?.entry.editor_session===entry?.editor_session)return;
    discardPrefetch();if(!entry)return;
    const next=prefetch={entry,frames:new Map()};
    prefetchTimer=setTimeout(()=>{
        prefetchTimer=null;if(prefetch!==next||busy||editorLoads.size){if(prefetch===next)discardPrefetch();return;}
        $('prefetch-status').textContent='Preparing next clip…';$('prefetch-status').title=entry.name;
        for(const kind of ['timeline','motion']){
            const url=new URL(kind==='motion'?'viewer.html':'processing-timeline.html',location.href);
            url.searchParams.set('session',kind==='motion'?entry.editor_session:entry.timeline);
            url.searchParams.set(kind==='motion'?'timeline':'node',kind==='motion'?entry.timeline:node);
            const frame=document.createElement('iframe');frame.dataset.kind=kind;frame.dataset.prefetch='true';frame.className='editor-prefetch';
            frame.title=`Next clip · ${kind}`;frame.inert=true;frame.setAttribute('aria-hidden','true');frame.tabIndex=-1;
            next.frames.set(kind,frame);
            frame.onload=()=>{
                if(prefetch!==next)return;
                frame.contentDocument?.addEventListener('play',()=>{if(frame.dataset.prefetch)pauseMedia(frame);},true);
                pauseMedia(frame);window.s3fFolderEditorReady(frame.contentWindow);
            };
            frame.src=url.href;$(kind==='motion'?'motion-frame':'timeline-frame').append(frame);
        }
    },800);
}
function prefetchReady(win){
    const frame=[...(prefetch?.frames.values()||[])].find(frame=>frame.contentWindow===win);
    if(!frame)return false;
    pauseMedia(frame);
    const video=win.document.querySelector('video');
    if(!win.s3fEditorReady)return true;
    if(video?.getAttribute('src')&&video.readyState<2&&!video.error){
        if(!frame.s3fWaitingVideo){
            frame.s3fWaitingVideo=true;
            for(const event of ['loadeddata','error'])video.addEventListener(event,()=>prefetchReady(win),{once:true});
        }
        return true;
    }
    frame.dataset.prepared='true';
    if(prefetch.frames.size===2&&[...prefetch.frames.values()].every(frame=>frame.dataset.prepared))$('prefetch-status').textContent='Next clip preloaded';
    return true;
}
function clearEditorLoad(kind,removePrevious=true){
    const loading=editorLoads.get(kind);if(!loading)return;
    clearTimeout(loading.timer);loading.cleanup?.();loading.notice.remove();
    if(removePrevious)loading.previous?.remove();
    loading.slot.removeAttribute('aria-busy');editorLoads.delete(kind);
}
function revealEditor(kind){
    const loading=editorLoads.get(kind);if(!loading||loading.revealing)return;
    const {frame,version}=loading;loading.revealing=true;loading.cleanup?.();
    // Give the incoming editor a paint before replacing the paused previous clip.
    requestAnimationFrame(()=>requestAnimationFrame(()=>{
        if(editorLoads.get(kind)!==loading||loading.version!==version)return;
        pauseMedia(frame);frame.classList.remove('editor-pending');frame.classList.add('editor-reveal');
        frame.s3fScrollY=loading.scroll;restoreEditorScroll(frame);
        clearEditorLoad(kind);render();
    }));
}
window.s3fFolderEditorReady=win=>{
    if(prefetchReady(win))return;
    for(const [kind,loading]of editorLoads){
        if(loading.frame.contentWindow!==win)continue;
        if(!win.s3fEditorReady||loading.revealing)return;
        if(loading.revalidating)return;
        if(loading.prefetched){
            loading.prefetched=false;loading.revalidating=true;
            const version=loading.version;
            // Opening still saves the old clip and runs the backend's normal
            // checks. Re-read this draft before exposing any preloaded controls.
            const refresh=kind==='motion'?win.s3fUpdate:win.s3fTimelineLoad;
            Promise.resolve().then(()=>{if(!refresh)throw new Error('Editor is not ready');return refresh();}).then(()=>{
                if(editorLoads.get(kind)!==loading||loading.version!==version)return;
                loading.revalidating=false;delete loading.frame.dataset.prefetch;
                window.s3fFolderEditorReady(win);
            }).catch(()=>{if(editorLoads.get(kind)===loading&&loading.version===version)loading.start();});
            return;
        }
        const video=win.document.querySelector('video');
        loading.cleanup?.();
        if(!video||!video.getAttribute('src')||video.readyState>=2||video.error){revealEditor(kind);return;}
        const ready=()=>revealEditor(kind);
        video.addEventListener('loadeddata',ready,{once:true});video.addEventListener('error',ready,{once:true});
        loading.cleanup=()=>{video.removeEventListener('loadeddata',ready);video.removeEventListener('error',ready);};
        loading.label.textContent='Preparing the next video preview…';
        return;
    }
};
function createEditor(descriptor,previous){
    const {kind}=descriptor,url=new URL(descriptor.url,location.href);
    if(url.origin!==location.origin)throw new Error('Invalid clip editor');
    const slot=$(kind==='motion'?'motion-frame':'timeline-frame');
    const frame=prefetch?.entry.id===current?.id?prefetch.frames.get(kind)||document.createElement('iframe'):document.createElement('iframe');
    const prefetched=frame.dataset.prefetch==='true';if(prefetched)prefetch.frames.delete(kind);
    frame.title=descriptor.label;frame.dataset.kind=kind;frame.allow='fullscreen';frame.removeAttribute('aria-hidden');frame.removeAttribute('tabindex');
    frame.className='editor-pending';frame.inert=true;
    const notice=document.createElement('div'),label=document.createElement('span'),retry=document.createElement('button');
    notice.className='editor-loading';notice.setAttribute('role','status');label.textContent='Loading next clip…';
    retry.type='button';retry.textContent='Reload editor';retry.hidden=true;notice.append(label,retry);
    const scroll=previous?.contentWindow.scrollY||0;
    if(previous){pauseMedia(previous);previous.inert=true;previous.classList.add('editor-previous');previous.setAttribute('aria-hidden','true');}
    const loading={frame,previous,slot,notice,label,scroll,version:0,prefetched};editorLoads.set(kind,loading);frames.set(descriptor.key,frame);
    const watch=()=>{clearTimeout(loading.timer);loading.timer=setTimeout(()=>{if(editorLoads.get(kind)===loading){label.textContent='This editor is taking longer to load.';retry.hidden=false;}},15000);};
    const start=()=>{
        loading.cleanup?.();clearTimeout(loading.timer);loading.version++;loading.revealing=false;retry.hidden=true;label.textContent='Loading next clip…';
        loading.prefetched=loading.revalidating=false;delete frame.dataset.prefetch;watch();
        frame.src=url.href;
    };
    loading.start=start;
    retry.onclick=start;
    frame.onload=()=>{
        if(frames.get(descriptor.key)!==frame)return;
        window.parent.s3fWorkspaceFramesChanged?.();frame.contentDocument?.addEventListener('keydown',shortcuts,true);
        frame.contentDocument?.addEventListener('play',()=>{
            if(editorLoads.has(kind)||kind!==activeEditor||$('clip-workbench').hidden)pauseMedia(frame);else pauseEditors(frame);
        },true);
        pauseMedia(frame);if(kind==='motion')window.s3fFolderViewerReady(frame.contentWindow);
        window.s3fFolderEditorReady(frame.contentWindow);
    };
    slot.setAttribute('aria-busy','true');
    if(prefetched){watch();slot.append(notice);frame.onload();}
    else{start();slot.append(frame,notice);}
}
window.s3fFolderCurrent=(entry,descriptors=[])=>{
    if(current?.id!==entry?.id&&prefetch?.entry.id!==entry?.id)discardPrefetch();
    if(current?.id!==entry?.id){
        current=entry;selected=entry?.id||selected;tagsDirty=reviewDirty=false;issues=[];versions=[];compared=false;
        intensityEstimate=intensityRequest=null;intensityRetry=0;
        $('issues').replaceChildren();$('issue-count').textContent=entry?'Loading review details…':'';
        $('versions').replaceChildren(new Option('Choose a saved version',''));
        void loadReview().catch(error=>{if(current?.id===entry?.id)status(error.message,true);});
    }else current=entry;
    const wanted=new Set(descriptors.map(d=>d.key)),previous=new Map();
    for(const [key,frame]of frames)if(!wanted.has(key)){
        const kind=frame.dataset.kind,loading=editorLoads.get(kind),visible=loading?.previous||frame;
        clearEditorLoad(kind,false);if(frame!==visible)frame.remove();
        pauseMedia(visible);frames.delete(key);previous.set(kind,visible);
    }
    for(const d of descriptors)if(!frames.has(d.key)){createEditor(d,previous.get(d.kind));previous.delete(d.kind);}
    for(const frame of previous.values())frame.remove();
    if(prefetch?.entry.id===entry?.id)discardPrefetch();
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
async function saveReview(){
    if(!reviewDirty||!selected)return;
    const entry=listing.entries.find(e=>e.id===selected),supportsAudioSync=typeof entry?.audio_sync==='boolean',audioSync=$('audio-sync').checked;
    const supportsIntensity=Number.isInteger(entry?.intensity),intensity=Number($('intensity').value);
    const mode=entry?.intensity_mode?($('intensity-auto').checked?'auto':'manual'):null;
    const result=await request('review',selected,{quality:Number($('quality').value),note:$('note').value,...(tagsDirty?{tags:$('clip-tags').value.split(',')}:{}),...(supportsAudioSync?{audio_sync:audioSync}:{}),...(supportsIntensity?{intensity}:{}),...(mode?{intensity_mode:mode}:{})});
    if(supportsAudioSync&&result.entries.find(e=>e.id===selected)?.audio_sync!==audioSync)throw new Error('Audio sync was not saved. Reload the ComfyUI page to load the updated review controls, then try again.');
    if(supportsIntensity&&mode!=='auto'&&result.entries.find(e=>e.id===selected)?.intensity!==intensity)throw new Error('Intensity was not saved. Reload the ComfyUI page to load the updated review controls, then try again.');
    if(mode&&result.entries.find(e=>e.id===selected)?.intensity_mode!==mode)throw new Error('Intensity mode was not saved. Reload the ComfyUI page and try again.');
    if(tagsDirty){const expected=[...new Set($('clip-tags').value.split(',').map(t=>t.normalize('NFKC').toLowerCase().replaceAll('_',' ').trim().replace(/\s+/g,' ')).filter(Boolean))].sort();if(JSON.stringify(expected)!==JSON.stringify(result.entries.find(e=>e.id===selected)?.tags))throw new Error('Tags were not saved. Reload the main ComfyUI tab to load the updated review controls.');}
    tagsDirty=reviewDirty=false;useListing(result);
}
async function openClip(id){
    const retained=current?.id===id;
    status('Saving edits and opening the next clip…');
    const result=await request('open',id);
    if(result?.id!==id||!result.timeline||!result.editor_session)throw new Error('The server returned a different clip. Refresh the folder and retry.');
    // Bind to the acknowledged clip even if the opener has not delivered its
    // updated frame descriptors yet. A queue row must never reuse another video.
    const descriptors=['timeline','motion'].map(kind=>{
        const session=kind==='motion'?result.editor_session:result.timeline;
        const url=new URL(kind==='motion'?'viewer.html':'processing-timeline.html',location.href);
        url.searchParams.set('session',session);url.searchParams.set(kind==='motion'?'timeline':'node',kind==='motion'?result.timeline:node);
        return {key:`${kind}:${session}`,kind,label:kind==='motion'?'Motion Studio':'Timeline',url:url.href};
    });
    window.s3fFolderCurrent(result,descriptors);selected=id;compared=false;
    // The open response has fresh state for this clip. Review details load once
    // when its editors attach; neither requires another full library scan here.
    const entries=listing.entries.some(e=>e.id===id)?listing.entries.map(e=>e.id===id?result:e):[...listing.entries,result];
    useListing({...listing,entries,counts:Object.fromEntries(Object.keys(labels).map(state=>[state,entries.filter(e=>e.status===state).length]))},false);
    if(retained&&!result.processing)await refreshResult(id);
    status(result.script_warning||'Clip ready. Process, refine and review the result below.');
}
async function act(action,target=null,extra={}){
    if(['cancel','pause'].includes(action)){try{await request(action);status(action==='pause'?'Pause requested · the current clip will finish first.':'Stop requested · completed drafts are kept.');}catch(error){status(error.message,true);}return;}
    if(busy){if(extra.propagate)throw new Error('Wait for the current folder action to finish.');return;}busy=true;render();
    try{
        // Saving a rating can remove the current clip from the active filter.
        // Capture its neighbours first so navigation keeps its review order.
        const before=visibleEntries(),position=before.findIndex(e=>e.id===selected);
        await saveReview();
        if(action==='prepare-upload'){
            if(editorLoads.has('motion'))throw new Error('Wait for Motion Studio to finish loading, then upload.');
            await motion()?.s3fFlush?.();status('Current edits saved for the dataset upload.');return true;
        }
        if(['h3_save_draft','h3_restore_draft'].includes(action)){const result=await request(action,current?.id,extra);useListing(result.listing);if(action==='h3_restore_draft')await loadReview();return true;}
        if(action==='h3_trial')return await request(action,current?.id,extra);
        if(action==='bulk-audio-mark'||action==='bulk-audio-clear'){
            const audio_sync=action==='bulk-audio-mark',clip_ids=audioSyncScope().map(e=>e.id);
            // Folder metadata does not depend on the workflow graph or its
            // cached message handler. As with tags, save through the Folder API.
            const response=await fetch(new URL(`../folders/${folder}/review_audio_sync`,location.href),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({clip_ids,audio_sync}),signal:AbortSignal.timeout(60000)});
            if(!response.ok)throw new Error(await response.text());
            const result=await response.json();
            useListing(result.listing);
            status(`Audio sync ${audio_sync?'marked':'cleared'} for ${result.updated} clips · ${result.matched} clips in the selected scope.`);return;
        }
        if(['h3_exclude_page','h3_exclude_panel','h3_confidence'].includes(action)){
            useListing(await request(action,null,extra));status(action==='h3_confidence'?'Confidence saved for detector checks and future automatic processing.':'Page inclusion updated. Videos and scripts are kept.');return true;
        }
        if(action==='refresh'){await refresh(!!listing?.h3);await loadReview();status(listing?.h3?'H3 project refreshed.':'Folder refreshed.');return;}
        if(action==='review'){status('Review saved.');return;}
        if(action==='preflight'){const result=await request('preflight',null,folderScope());status((result.ok?'Ready · ':'Missing requirements · ')+[...result.checks,...result.errors].join(' · '),!result.ok);return;}
        if(action==='save-preset'){const settings=Object.fromEntries(Object.entries(presetFields).map(([key,id])=>[key,typeof defaultPreset[key]==='number'?Number($('preset-'+id).value):$('preset-'+id).value]));await request('preset',null,{subfolder:[...selectedSubfolders][0],settings});await loadPreset();status('Subfolder preset saved.');return;}
        if(action==='civitai_approve'||action==='civitai_reject'){
            const result=await request(action,target,{category:extra.category,replace:!!listing.entries.find(e=>e.id===target)?.existing.length});
            useListing(result.listing);if(current)await loadReview();return result;
        }
        if(action==='bulk'||action==='retry'||action==='reprocess'||action==='queue_start'){
            // The queue may have returned to idle after a previous run while
            // the folder still holds that run's queued report. The host and
            // server check actual queued/running jobs before starting it.
            if(batching&&action!=='queue_start')throw new Error('A folder batch is already running. Review it in Local clips before starting another.');
            if(action==='reprocess'&&!extra.clip_ids)extra.clip_ids=audioSyncScope().filter(e=>e.status!=='ignored'&&!e.civitai_set_aside&&e.h3?.render_mode!=='still').map(e=>e.id);
            queuedClip=listing.entries.find(e=>e.id===current?.id&&(extra.clip_ids?extra.clip_ids.includes(e.id):inSubfolder(e))&&(action==='reprocess'||e.status==='pending'&&e.batch_result!=='ready')&&(action!=='retry'||e.batch_result==='error'))?.id;
            const scope=action==='queue_start'?{}:extra.clip_ids?{clip_ids:extra.clip_ids}:folderScope();
            batchStarting=batching=true;render();let result;try{result=await request(action==='queue_start'?'queue_start':'bulk',null,{...scope,retry_failed:action==='retry',reprocess:action==='reprocess'});}catch(error){batchStarting=batching=false;throw error;}
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
        if(action==='previous'||action==='next'){
            const forward=action==='next',visible=new Set(visibleEntries().map(e=>e.id));
            const ordered=position<0?before:[...before.slice(position+1),...before.slice(0,position)];
            const candidates=forward?ordered:[...ordered].reverse();
            target=candidates.find(e=>e.id!==selected&&visible.has(e.id))?.id;
            if(!target){status('No more clips in this filtered view.');return;}
            action='open';
        }
        const nextAfter=['approve-next','ignore-next','ignore'].includes(action);if(nextAfter)action=action.split('-')[0];
        const id=target||selected,entry=listing.entries.find(e=>e.id===id);if(!entry)return;
        if(action==='open'){await openClip(id);return true;}
        const temporaryApproval=action==='approve'&&entry.civitai_temporary,category=temporaryApproval?$('approval-category').value.trim():undefined;
        if(temporaryApproval&&!category)throw new Error('Choose or type a destination category before approving this temporary clip.');
        const result=await request(temporaryApproval?'civitai_approve':action==='restore'?'ignore':action,id,{ignored:action!=='restore',note:$('note').value,replace:action==='approve'&&entry.existing.length>0,...(temporaryApproval?{category}:{})});
        if(action==='approve'){useListing(result.listing);const saved=listing.entries.find(e=>e.id===id);status(`Approved · ${result.files.length} scripts saved beside ${saved?.name||entry.name}${result.backups?.length?' · previous scripts backed up':''}.`);}
        else{useListing(result);status(action==='restore'?'Video restored.':'Video skipped for now. Its draft, rating, note and published scripts are kept.');}
        if(nextAfter){
            const candidates=position<0?before:[...before.slice(position+1),...before.slice(0,position)];
            const visible=new Set(visibleEntries().filter(e=>action!=='ignore'||e.status!=='ignored').map(e=>e.id));
            const next=candidates.find(e=>e.id!==id&&visible.has(e.id));
            if(next){await openClip(next.id);return;}
            status(action==='ignore'?'Clip skipped and edits saved. No more clips to review in this filtered view. Change the filters or restore this video.':'No more clips in this filtered view.');
        }
        // Skip/restore only changes review status; unchanged checks and versions
        // must not delay unlocking the controls when staying on the same clip.
        if(['ignore','restore'].includes(action))return;
        await loadReview();
    }catch(error){status(error.message,true);if(extra.propagate)throw error;}finally{busy=false;render();}
}
for(const id of ['open','approve','approve-next','ignore','ignore-next','restore','previous','next','refresh','review','bulk','retry','preflight','pause','cancel','save-preset','compare','clear-compare','save-version','rate-version','restore-version','refresh-issues','next-issue','bulk-audio-mark','bulk-audio-clear','reprocess'])$(id).onclick=()=>act(id);
$('clips').onchange=()=>act('open',$('clips').value);$('versions').onchange=versionFields;
$('approval-category').oninput=()=>render();
for(const id of ['filter','quality-filter'])$(id).onchange=render;
$('review-order').onchange=()=>{reviewOrder.mode=$('review-order').value;saveReviewOrder();render();};
$('prefetch').onchange=()=>{try{localStorage.setItem('s3f-folder-prefetch',$('prefetch').checked?'on':'off');}catch{}discardPrefetch();schedulePrefetch();};
$('reshuffle').onclick=()=>{reviewOrder.scope='';render();};
$('subfolder').onclick=()=>showFolderPicker($('subfolder-menu').hidden);
$('subfolder-whole').onclick=()=>{selectedSubfolders.clear();selectedSubfolders.add('');folderSelectionChanged();};
$('subfolder-clear').onclick=()=>{selectedSubfolders.clear();folderSelectionChanged();};
$('subfolder-done').onclick=()=>{showFolderPicker(false);$('subfolder').focus();};
$('subfolder-search').oninput=renderFolderPicker;
document.addEventListener('pointerdown',event=>{if(!$('subfolder-picker').contains(event.target))showFolderPicker(false);});
$('subfolder-picker').addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();showFolderPicker(false);$('subfolder').focus();}});
$('clip-tags').oninput=()=>{tagsDirty=reviewDirty=true;};
$('search').oninput=render;$('note').oninput=$('quality').onchange=$('audio-sync').onchange=()=>{reviewDirty=true;};document.addEventListener('keydown',shortcuts,true);
$('intensity').onchange=()=>{$('intensity-auto').checked=false;reviewDirty=true;render();};
$('intensity-auto').onchange=()=>{reviewDirty=true;render();void refreshIntensity();};
setInterval(()=>void refreshIntensity(),1000);
setInterval(async()=>{if(refreshing||busy)return;refreshing=true;try{
    const entry=listing?.entries.find(e=>e.id===current?.id);
    if(current&&(!batchStarting||current.id!==queuedClip)&&!entry?.processing&&!['waiting','downloading','processing'].includes(entry?.queue_state))await request('lease',current.id);
    if(!busy&&Date.now()-lastListingRefresh>=15000)await refresh();
}catch{/* Reconnection keeps the current draft. */}finally{refreshing=false;}},8000);
refresh().then(()=>loadPreset()).then(()=>status('Browse clips with the arrows, or choose folders to bulk process unscripted videos.')).catch(error=>status(error.message,true));
