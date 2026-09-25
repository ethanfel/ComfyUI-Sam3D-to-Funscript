export function folderUpload({folder, saveEdits}) {
    const $=id=>document.getElementById(id);
    let state=null, busy=false, parentBusy=false, supported=false, polling=false, initialized=false, generation=0, errorText='';
    async function request(action,body={}) {
        const response=await fetch(new URL(`../folders/${folder}/${action}`,location.href),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
        if(!response.ok)throw new Error(await response.text());return response.json();
    }
    function render() {
        const locked=busy||state?.busy||['building','uploading'].includes(state?.job.stage);
        $('dataset-upload').disabled=!supported||!state?.video_metadata||parentBusy||locked||!state?.authenticated||!$('dataset-repo').value.trim();
        $('dataset-repo').disabled=!!locked;
        $('dataset-support').hidden=supported&&(!state||state.video_metadata===true);
        $('dataset-auth').textContent=!state?'Checking server login…':!state.available
            ?'Install huggingface_hub in the ComfyUI Python environment.'
            :state.authenticated?'Using the Hugging Face login saved on the server.'
            :'Sign in on the ComfyUI server with hf auth login, or set HF_TOKEN, then refresh status.';
    }
    function show(value) {
        if(state&&(state.job.stage!==value.job.stage||state.job.started_at!==value.job.started_at))errorText='';
        state=value;
        if(!initialized){$('dataset-repo').value=state.repo;initialized=true;}
        const job=state.job,summary=job.result||job.summary;
        const counts=!summary?'':Number.isInteger(summary.metadata_only_videos)
            ?`${summary.videos} videos · ${summary.videos_with_scripts} with scripts · ${summary.metadata_only_videos} metadata only · ${summary.scripts} script files`
            :`${summary.videos} videos · ${summary.variants} variants · ${summary.scripts} scripts`;
        const skipped=job.summary?.skip_counts||{},omitted=Object.entries(skipped).map(([why,n])=>`${n} ${why}`).join(' · ');
        $('dataset-progress').textContent=errorText|| (job.stage==='building'?'Preparing saved scripts and metadata…'
            :job.stage==='uploading'?`Uploading to ${job.repo}… ${counts}`
            :job.stage==='complete'?`Upload complete · ${counts}`
            :job.error|| (state.busy?'An upload is running in another Folder workspace.':'Ready to upload saved scripts and metadata.'));
        $('dataset-progress').classList.toggle('error',!!errorText||['error','interrupted','empty'].includes(job.stage));
        $('dataset-skipped').textContent=omitted?`Scripts not refreshed in this snapshot: ${omitted}`:'';
        const last=state.last_upload,link=$('dataset-result');
        link.hidden=!last;
        if(last){link.href=`https://huggingface.co/datasets/${encodeURIComponent(last.repo.split('/')[0])}/${encodeURIComponent(last.repo.split('/')[1])}`;link.textContent=`Open ${last.repo} · last uploaded ${new Date(last.finished_at).toLocaleString()}`;}
        render();
    }
    async function poll() {
        if(!supported||polling||busy)return;polling=true;const requestGeneration=generation;
        try{const value=await request('dataset_status');if(!busy&&requestGeneration===generation)show(value);}
        catch(error){$('dataset-progress').textContent=error.message;$('dataset-progress').classList.add('error');}
        finally{polling=false;}
    }
    $('dataset-repo').oninput=render;
    $('dataset-refresh').onclick=()=>{errorText='';void poll();};
    $('dataset-upload').onclick=async()=>{
        if(busy||state?.busy)return;
        busy=true;generation++;errorText='';render();
        try{
            await saveEdits();
            // Also preserve approvals on a server still running the previous uploader.
            show(await request('dataset_upload',{repo:$('dataset-repo').value.trim(),use_folder_approval:true}));
        }catch(error){errorText=error.message;$('dataset-progress').textContent=errorText;$('dataset-progress').classList.add('error');}
        finally{busy=false;render();}
    };
    setInterval(()=>void poll(),3000);
    return {render(value,blocked){parentBusy=blocked;const first=!supported&&value;supported=value;render();if(first)void poll();}};
}
