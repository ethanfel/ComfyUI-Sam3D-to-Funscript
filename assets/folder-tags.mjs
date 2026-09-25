export function folderTags({folder, scope, selected, saveReview, refresh, status}) {
    const $=id=>document.getElementById(id);
    let supported=false, incremental=false, busy=false, parentBusy=false, running=false, polling=false, previous='', initialized=false, settingsTouched=false, generation=0;
    async function request(action,body={}) {
        const response=await fetch(new URL(`../folders/${folder}/${action}`,location.href),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
        if(!response.ok)throw new Error(await response.text());return response.json();
    }
    function render() {
        const clips=scope();
        $('tags-scope').textContent=`${clips.length} clips in selected folders (nested included; skipped clips excluded). Show, Quality and Find do not limit this scope.`;
        $('tags-start').disabled=!supported||!incremental||busy||parentBusy||running||!clips.length;
        $('tags-current').disabled=!supported||!incremental||busy||parentBusy||running||!selected();
        const force=$('tags-mode').value==='all';
        $('tags-start').textContent=force?'Retag selected folders':'Tag missing or changed';
        $('tags-current').textContent=force?'Retag this clip':'Suggest tags for this clip';
        for(const id of ['tags-mode','tags-source','tags-frames','tags-threshold','tags-site'])$(id).disabled=busy||running;
        $('tags-stop').disabled=!running||busy;
        $('tags-support').hidden=supported&&incremental;
    }
    function show(job) {
        incremental=job.incremental===true;
        if(!initialized){
            if(!settingsTouched)for(const [key,id] of [['source','tags-source'],['frames','tags-frames'],['threshold','tags-threshold'],['site','tags-site']]){
                if(job[key]!==undefined)$(id).value=String(job[key]);
            }
            initialized=true;
        }
        running=['running','stopping'].includes(job.stage);
        $('tags-progress').textContent=`${running?'Current run':'Last run'}: ${job.stage} · ${job.completed} / ${job.total} clips checked${job.skipped?' · '+job.skipped+' already up to date':''}${job.current?' · '+job.current:''}${job.errors.length?'\n'+job.errors.map(e=>`${e.name}: ${e.error}`).join('\n'):''}`;
        render();
    }
    async function start(current=false) {
        const clip_ids=current?[selected()]:scope().map(e=>e.id);
        busy=true;generation++;render();
        try {
            await saveReview();
            const job=await request('tags_start',{clip_ids,source:$('tags-source').value,frames:Number($('tags-frames').value),threshold:Number($('tags-threshold').value),site:$('tags-site').value,force:$('tags-mode').value==='all'});
            show(job);
            status(job.total===0?'All selected clips are already up to date. No tagging was needed.':`Tagging ${job.total} clips in the background${job.skipped?' · '+job.skipped+' already up to date':''}. You can continue reviewing clips.`);
        } catch(error) {status(error.message,true);} finally {busy=false;render();}
    }
    $('tags-start').onclick=()=>start();$('tags-current').onclick=()=>start(true);
    for(const id of ['tags-mode','tags-source','tags-frames','tags-threshold','tags-site'])$(id).addEventListener('change',()=>{settingsTouched=true;render();});
    $('tags-stop').onclick=async()=>{try{show(await request('tags_stop'));}catch(error){status(error.message,true);}};
    async function poll() {
        if(!supported||polling||busy)return;polling=true;const requestGeneration=generation;
        try {
            const job=await request('tags_status'),marker=`${job.started_at||''}:${job.stage}:${job.completed}:${job.total}`;
            if(busy||requestGeneration!==generation)return;
            show(job);
            if(previous&&marker!==previous)await refresh();
            previous=marker;
        } catch(error) {$('tags-progress').textContent=error.message;} finally {polling=false;}
    }
    setInterval(()=>void poll(),3000);
    return {render(value,blocked){parentBusy=blocked;const first=!supported&&value;supported=value;render();if(first)void poll();}};
}
