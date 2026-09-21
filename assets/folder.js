import {workflowHost} from './workflow-host.mjs';
const $=id=>document.getElementById(id),params=new URLSearchParams(location.search),folder=params.get('folder'),node=params.get('node'),client=crypto.randomUUID();
let listing=null,selected=null,current=null,busy=false,batching=false,batchStarting=false,queuedClip=null,reviewDirty=false,refreshing=false;
let issues=[],issueIndex=-1,versions=[],compared=false,readyClip=null,presetLoading=false,presetRequest=0;
const processingClips=new Set();
const pending=new Map(),frames=new Map(),labels={pending:'Without scripts',ignored:'Ignored',approved:'Approved',existing:'Existing funscript'};
const presetFields={preferred_anchor:'anchor',smoothing_ms:'smoothing',range_mode:'range-mode',movement_range:'range',sample_fps:'fps',batch_size:'batch',cut_sensitivity:'cuts'};
const defaultPreset={preferred_anchor:'auto',smoothing_ms:30,range_mode:'adaptive',movement_range:.2,sample_fps:0,batch_size:8,cut_sensitivity:'normal'};
function status(text,error=false){$('status').textContent=text;$('status').classList.toggle('error',error);}
function motion(){return frames.get(`motion:${current?.editor_session}`)?.contentWindow;}
function inSubfolder(e){const sub=$('subfolder').value;return !sub||e.name.startsWith(sub+'/');}
function visibleEntries(){const filter=$('filter').value,quality=$('quality-filter').value,query=$('search').value.toLowerCase();return (listing?.entries||[]).filter(e=>inSubfolder(e)&&e.name.toLowerCase().includes(query)
    &&(filter==='all'||filter==='active'&&e.status!=='ignored'||filter==='ready'&&e.status==='pending'&&e.batch_result==='ready'||filter==='done'&&['existing','approved'].includes(e.status)||e.status===filter)
    &&(quality==='all'||quality==='low'&&e.quality>=1&&e.quality<=2||Number(quality)===(e.quality||0)));}
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
    $('selected').textContent=current?.name||'Select a video';$('detail').textContent=entry?`${labels[entry.status]}${locked?' · processing · this clip is read-only':entry.batch_result==='ready'?' · draft ready for review':entry.draft?' · saved draft':''}${entry.error?' · last batch: '+entry.error:''}`:'';
    $('approve').textContent=entry?.existing.length?'Approve & replace scripts':'Approve & save next to video';
    for(const id of ['review','note','quality','save-version','restore-version','rate-version'])$(id).disabled=busy||locked||!entry;
    $('approve').disabled=busy||locked||!entry||entry.id!==current?.id||entry.status==='ignored';$('approve-next').disabled=$('approve').disabled;
    $('ignore').disabled=busy||locked||!entry||entry.status==='ignored';$('ignore-next').disabled=$('ignore').disabled;
    $('restore').disabled=busy||locked||entry?.status!=='ignored';$('refresh').disabled=busy;$('open').disabled=busy||!entry;
    $('previous').disabled=$('next').disabled=busy||!visible.some(e=>e.id!==selected);
    for(const id of ['filter','subfolder','quality-filter','search','clips'])$(id).disabled=busy;
    const choices=visible.some(e=>e.id===selected)?visible:[...(entry?[entry]:[]),...visible];
    if(document.activeElement!==$('clips'))$('clips').replaceChildren(...choices.map(e=>new Option(`${e.name} · ${e.processing?'Processing':labels[e.status]}${e.quality?' · '+e.quality+'★':''}`,e.id,false,e.id===selected)));
    $('position').textContent=visible.length?`${visible.findIndex(e=>e.id===selected)+1 || '–'} / ${visible.length}`:'No matches';
    const candidates=entries.filter(e=>inSubfolder(e)&&e.status==='pending'&&e.batch_result!=='ready');
    $('bulk-count').textContent=`${candidates.length} clips to process`;$('bulk').disabled=busy||batching||!candidates.length;
    $('bulk').textContent=['paused','stopped','interrupted'].includes(listing?.batch?.stage)?'Resume remaining clips':'Process unscripted clips in subfolder';
    $('retry').disabled=busy||batching||!candidates.some(e=>e.batch_result==='error');$('cancel').disabled=$('pause').disabled=!batching;
    $('save-preset').disabled=busy||batching||presetLoading;$('preflight').disabled=busy;
    for(const id of Object.values(presetFields))$('preset-'+id).disabled=busy||batching||presetLoading;
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
async function refresh(){
    const response=await fetch(new URL(`../folders/${folder}`,location.href),{cache:'no-store'});if(!response.ok)throw new Error(await response.text());
    listing=await response.json();
    if(!batchStarting)batching=listing.batch?.stage==='running';
    const prior=$('subfolder').value,paths=new Set();for(const e of listing.entries){const parts=e.name.split('/');parts.pop();while(parts.length){paths.add(parts.join('/'));parts.pop();}}
    if(document.activeElement!==$('subfolder')){$('subfolder').replaceChildren(new Option('Whole folder',''),...[...paths].sort().map(p=>new Option(p,p)));$('subfolder').value=paths.has(prior)?prior:'';}
    if(!listing.entries.some(e=>e.id===selected))selected=current?.id||listing.entries.find(e=>e.status==='pending')?.id||listing.entries[0]?.id||null;
    batchStatus(listing.batch);render();
}
function request(action,clip,extra={}){
    const host=workflowHost();if(!host)throw new Error('Open this folder from its ComfyUI node.');
    return new Promise((resolve,reject)=>{const id=crypto.randomUUID(),timer=setTimeout(()=>{pending.delete(id);reject(new Error('ComfyUI did not reply. Refresh to check the action before retrying.'));},120000);
        pending.set(id,{resolve,reject,timer});host.postMessage({type:'s3f-folder-action',folder,node,client,request:id,action,clip,...extra},location.origin);});
}
async function loadPreset(){
    const generation=++presetRequest; presetLoading=true;render();
    try{
        const result=await request('preset',null,{subfolder:$('subfolder').value});if(generation!==presetRequest)return;
        for(const [key,id]of Object.entries(presetFields))$('preset-'+id).value=(result.settings||defaultPreset)[key];
        $('preset-origin').textContent=result.settings?`Using preset from ${result.subfolder||'the whole folder'}`:'No saved preset · processing uses the node settings until you save one.';
    }finally{if(generation===presetRequest){presetLoading=false;render();}}
}
async function loadReview(){
    if(!current)return;const clip=current.id;
    const [found,saved]=await Promise.all([request('issues',clip),request('versions',clip)]);if(current?.id!==clip)return;
    issues=found;issueIndex=-1;versions=saved;
    $('issue-count').textContent=issues.length?`${issues.length} ranges to inspect`:'No review flags found';
    $('issues').replaceChildren(...issues.map((issue,index)=>{const b=document.createElement('button');b.textContent=`${(issue.start_ms/1000).toFixed(1)}–${(issue.end_ms/1000).toFixed(1)}s · ${issue.reason}`;b.onclick=()=>showIssue(index);return b;}));
    motion()?.s3fFolderIssues?.(issues);
    const old=$('versions').value;$('versions').replaceChildren(new Option('Choose a saved version',''),...versions.map(v=>new Option(`${v.name}${v.quality?' · '+v.quality+'★':''}`,v.id)));if(versions.some(v=>v.id===old))$('versions').value=old;
    render();
}
function showIssue(index){issueIndex=index;const issue=issues[index];if(!issue)return;motion()?.s3fFolderSelectRange?.(issue.start_ms,issue.end_ms,{play:$('autoplay').checked,track:issue.track});$('result').scrollIntoView({behavior:'smooth'});}
function versionFields(){const v=versions.find(v=>v.id===$('versions').value);$('version-name').value=v?.name||'';$('version-quality').value=String(v?.quality||0);$('version-note').value=v?.note||'';render();}
function shortcuts(event){
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
    if(readyClip!==current?.id&&(!$('autoplay').checked||win.s3fFolderPlaySelection?.()))readyClip=current?.id;
};
window.s3fFolderCurrent=(entry,descriptors=[])=>{
    if(current?.id!==entry?.id){current=entry;selected=entry?.id||selected;reviewDirty=false;issues=[];versions=[];compared=false;void loadReview().catch(error=>status(error.message,true));}else current=entry;
    const wanted=new Set(descriptors.map(d=>d.key));for(const [key,frame]of frames)if(!wanted.has(key)){frame.remove();frames.delete(key);}
    for(const d of descriptors)if(!frames.has(d.key)){
        const url=new URL(d.url,location.href);if(url.origin!==location.origin)throw new Error('Invalid clip editor');
        const frame=document.createElement('iframe');frame.title=d.label;frame.allow='fullscreen';frame.src=url.href;
        frame.onload=()=>{window.parent.s3fWorkspaceFramesChanged?.();frame.contentDocument?.addEventListener('keydown',shortcuts,true);frame.contentDocument?.addEventListener('play',()=>{for(const other of frames.values())if(other!==frame)other.contentDocument?.querySelectorAll('video,audio').forEach(media=>media.pause());},true);
            if(d.kind==='motion')window.s3fFolderViewerReady(frame.contentWindow);};
        frames.set(d.key,frame);$(d.kind==='motion'?'motion-frame':'timeline-frame').replaceChildren(frame);
    }
    render();
};
window.s3fOpenWorkspacePage=(url,kind)=>{if(kind!=='motion')return;const session=new URL(url,location.href).searchParams.get('session');const frame=frames.get(`motion:${session}`);if(frame){void frame.contentWindow.s3fUpdate?.();$('result').scrollIntoView({behavior:'smooth'});}};
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
async function saveReview(){if(reviewDirty&&selected){listing=await request('review',selected,{quality:Number($('quality').value),note:$('note').value});reviewDirty=false;}}
async function openClip(id){const result=await request('open',id);current=result;selected=id;compared=false;await refresh();await loadReview();status(result.script_warning||'Clip ready. Process, refine and review the result below.');}
async function act(action,target=null){
    if(['cancel','pause'].includes(action)){try{await request(action);status(action==='pause'?'Pause requested · the current clip will finish first.':'Stop requested · completed drafts are kept.');}catch(error){status(error.message,true);}return;}
    if(busy)return;busy=true;render();
    try{
        await saveReview();
        if(action==='refresh'){await refresh();await loadReview();status('Folder refreshed.');return;}
        if(action==='review'){status('Rating and note saved.');return;}
        if(action==='preflight'){const result=await request('preflight',null,{subfolder:$('subfolder').value});status((result.ok?'Ready · ':'Missing requirements · ')+[...result.checks,...result.errors].join(' · '),!result.ok);return;}
        if(action==='save-preset'){const settings=Object.fromEntries(Object.entries(presetFields).map(([key,id])=>[key,typeof defaultPreset[key]==='number'?Number($('preset-'+id).value):$('preset-'+id).value]));await request('preset',null,{subfolder:$('subfolder').value,settings});await loadPreset();status('Subfolder preset saved.');return;}
        if(action==='bulk'||action==='retry'){
            queuedClip=listing.entries.find(e=>e.id===current?.id&&inSubfolder(e)&&e.status==='pending'&&e.batch_result!=='ready'&&(action!=='retry'||e.batch_result==='error'))?.id;
            batchStarting=batching=true;render();try{await request('bulk',null,{subfolder:$('subfolder').value,retry_failed:action==='retry'});}catch(error){batchStarting=batching=false;throw error;}
            status('Batch queued. You can review other completed clips while it processes.');return;
        }
        if(action==='refresh-issues'){await loadReview();return;}
        if(action==='next-issue'){showIssue((issueIndex+1)%issues.length);return;}
        if(action==='compare'){const v=await request('version',selected,{version:$('versions').value});if(!motion()?.s3fFolderCompare)throw new Error('Wait for Motion Studio to load.');motion().s3fFolderCompare(v);compared=true;$('result').scrollIntoView({behavior:'smooth'});status(`Comparing ${v.name} in pink with current Main in green.`);return;}
        if(action==='clear-compare'){motion()?.s3fFolderCompare?.(null);compared=false;return;}
        if(['save-version','rate-version','restore-version'].includes(action)){
            const requestAction=action.replaceAll('-','_');
            await request(requestAction,selected,{version:$('versions').value,name:$('version-name').value,quality:Number($('version-quality').value),note:$('version-note').value});
            if(action==='restore-version'){motion()?.s3fFolderCompare?.(null);compared=false;}
            await loadReview();status(action==='restore-version'?'Version restored into Main. The previous Main is saved as a recovery version. Approve to export.':'Version saved.');return;
        }
        const before=visibleEntries(),position=before.findIndex(e=>e.id===selected);
        if(action==='previous'||action==='next'){const direction=action==='next'?1:-1;target=before[(position+direction+before.length)%before.length]?.id;action='open';}
        const nextAfter=['approve-next','ignore-next'].includes(action);if(nextAfter)action=action.split('-')[0];
        const id=target||selected,entry=listing.entries.find(e=>e.id===id);if(!entry)return;
        if(action==='open'){await openClip(id);return;}
        const result=await request(action==='restore'?'ignore':action,id,{ignored:action!=='restore',note:$('note').value,replace:action==='approve'&&entry.existing.length>0});
        if(action==='approve'){listing=result.listing;status(`Approved · ${result.files.length} scripts saved beside ${entry.name}${result.backups?.length?' · previous scripts backed up':''}.`);}
        else{listing=result;status(action==='restore'?'Video restored.':'Video ignored. Its draft, rating and note are kept.');}
        await refresh();await loadReview();
        if(nextAfter){const candidates=[...before.slice(position+1),...before.slice(0,position)],visible=new Set(visibleEntries().map(e=>e.id));const next=candidates.find(e=>e.id!==id&&visible.has(e.id));if(next)await openClip(next.id);else status('No more clips in this filtered view.');}
    }catch(error){status(error.message,true);}finally{busy=false;render();}
}
for(const id of ['open','approve','approve-next','ignore','ignore-next','restore','previous','next','refresh','review','bulk','retry','preflight','pause','cancel','save-preset','compare','clear-compare','save-version','rate-version','restore-version','refresh-issues','next-issue'])$(id).onclick=()=>act(id);
$('clips').onchange=()=>act('open',$('clips').value);$('versions').onchange=versionFields;
for(const id of ['filter','quality-filter'])$(id).onchange=render;
$('subfolder').onchange=()=>{render();void loadPreset().catch(error=>status(error.message,true));};
$('search').oninput=render;$('note').oninput=$('quality').onchange=()=>{reviewDirty=true;};document.addEventListener('keydown',shortcuts,true);
setInterval(async()=>{if(refreshing||busy)return;refreshing=true;try{await refresh();if(current&&(!batchStarting||current.id!==queuedClip)&&!listing.entries.find(e=>e.id===current.id)?.processing)await request('lease',current.id);}catch{/* Reconnection keeps the current draft. */}finally{refreshing=false;}},4000);
refresh().then(()=>loadPreset()).then(()=>status('Browse clips with the arrows, or bulk process unscripted videos in a subfolder.')).catch(error=>status(error.message,true));
