// Preview/save share the same immutable request, including source and cut revision.
export function cutImporter({$, context, endpoint, imported}) {
    const dialog=$('cutImportDialog');
    let generation=0, preview=null, sourceId=null, saving=false, automaticStart=true;
    const invalidate=()=>{
        generation++;preview=null;$('confirmCutImport').disabled=true;
        $('cutImportSummary').textContent='';$('cutImportWarnings').textContent='';$('cutImportEdits').replaceChildren();
        $('cutImportError').textContent='';
    };
    async function request(body){
        const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},
            body:JSON.stringify(body),signal:AbortSignal.timeout(120000)});
        if(!response.ok){
            const text=await response.text();
            throw new Error(response.status===404?'Restart ComfyUI to enable EDL import, then reopen the timeline.':text.slice(0,500)||`Import failed (${response.status}).`);
        }
        return response.json();
    }
    $('importCuts').onclick=()=>{
        if(context().busy)return;
        invalidate();sourceId=context().info.source_id;
        $('cutImportFile').value='';$('cutImportRate').value=context().info.rate;
        $('cutImportStart').value='';automaticStart=true;
        $('cutImportExisting').textContent=context().cuts?'Import replaces the current cut markers. Existing regions and motion edits are kept.':'Imported cuts will be used by automatic mode.';
        dialog.showModal();
    };
    async function readPreview(){
        invalidate();const own=generation;
        try{
            const file=$('cutImportFile').files[0];
            if(!file)throw new Error('Choose a timeline EDL first.');
            if(file.size>2*1024*1024)throw new Error('The EDL is too large (maximum 2 MB).');
            const body={source_id:sourceId,text:await file.text(),filename:file.name,
                fps:$('cutImportRate').value,start_timecode:$('cutImportStart').value};
            if(own!==generation)return;
            $('cutImportSummary').textContent='Reading edits…';
            const result=await request({...body,preview:true});
            if(own!==generation||!dialog.open)return;
            preview={body,expected:result.expected_cuts};
            const cuts=result.cuts;
            $('cutImportStart').value=cuts.settings.start_timecode;
            $('cutImportSummary').textContent=`${cuts.times_ms.length} cut markers · ${cuts.segments.length} video edits in range · ${cuts.settings.drop_frame?'Drop-frame':'Non-drop-frame'}`;
            $('cutImportWarnings').textContent=(cuts.warnings||[]).join(' ');
            for(const edit of cuts.segments.slice(0,100)){
                const row=document.createElement('li');
                row.textContent=`${(edit.start_ms/1000).toFixed(3)}–${(edit.end_ms/1000).toFixed(3)} s · ${edit.name||`Edit ${edit.event}`}`;
                $('cutImportEdits').append(row);
            }
            if(cuts.segments.length>100){const row=document.createElement('li');row.textContent=`…and ${cuts.segments.length-100} more edits`;$('cutImportEdits').append(row);}
            $('confirmCutImport').disabled=false;
        }catch(error){if(own===generation){$('cutImportSummary').textContent='';$('cutImportError').textContent=error.message;}}
    }
    $('previewCutImport').onclick=readPreview;
    $('cutImportFile').onchange=()=>{if(automaticStart)$('cutImportStart').value='';return readPreview();};
    $('cutImportRate').oninput=invalidate;
    $('cutImportStart').oninput=()=>{automaticStart=!$('cutImportStart').value.trim();invalidate();};
    $('confirmCutImport').onclick=async()=>{
        if(!preview||saving)return;
        saving=true;const sent=preview;
        for(const id of ['confirmCutImport','previewCutImport','cutImportFile','cutImportRate','cutImportStart','cancelCutImport'])$(id).disabled=true;
        try{
            if(context().busy)throw new Error('Wait for processing to finish before importing cuts.');
            const next=await request({...sent.body,preview:false,expected_cuts:sent.expected});
            await imported(next);dialog.close();
        }catch(error){invalidate();$('cutImportError').textContent=error.message;}
        finally{
            saving=false;
            for(const id of ['previewCutImport','cutImportFile','cutImportRate','cutImportStart','cancelCutImport'])$(id).disabled=false;
        }
    };
    $('cancelCutImport').onclick=()=>dialog.close();
    dialog.addEventListener('cancel',event=>{if(saving)event.preventDefault();});
    dialog.addEventListener('close',invalidate);
}
