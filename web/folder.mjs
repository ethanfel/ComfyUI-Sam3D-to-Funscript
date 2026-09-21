import {app} from '../../scripts/app.js';
import {queueReferenceTracking} from './reference-queue.mjs';
import {api} from '../../scripts/api.js';
import {flushWorkspaceNode,workspaceEditor,releaseWorkspaceNode,refreshWorkspaces} from './workspace.mjs';
const windows=new Map();
export const isFolder=node=>node?.type==='S3F_FolderTimeline';
export function folderDescriptor(node){
    return {key:`folder:${node.properties.s3f_folder||node.properties.s3f_timeline_session}`,kind:'folder',label:'Folder',
        url:node.properties.s3f_folder?api.apiURL(`/sam3d_funscript/assets/folder.html?${new URLSearchParams({folder:node.properties.s3f_folder,node:String(node.id)})}`):null,
        message:'Enter the folder path and run Prepare once to browse its videos.'};
}
export function folderPages(node){
    const entry=node.properties.s3f_folder_entry;if(!entry)return [];
    return [{key:`timeline:${entry.timeline}`,kind:'timeline',embedded:true,label:'Timeline',url:api.apiURL(`/sam3d_funscript/assets/processing-timeline.html?${new URLSearchParams({session:entry.timeline,node:String(node.id)})}`)},
        {key:`motion:${entry.editor_session}`,kind:'motion',embedded:true,label:'Motion Studio',url:api.apiURL(`/sam3d_funscript/assets/viewer.html?${new URLSearchParams({session:entry.editor_session,timeline:entry.timeline})}`)}];
}
export function attachFolder(node,win){windows.set(node,win);win.s3fFolderCurrent?.(node.properties.s3f_folder_entry||null,folderPages(node));}
export function adoptFolder(node,win){
    const retained=win.s3fFolderIdentity?.();
    if(retained?.folder===node.properties.s3f_folder&&retained.entry)
        updateFolderNode(node,retained.folder,retained.entry);
}
export function detachFolder(node,win){if(windows.get(node)===win)windows.delete(node);}
export function updateFolderNode(node,folder,entry){
    if(node.properties.s3f_folder_entry?.id!==entry?.id)releaseWorkspaceNode(node);
    node.properties.s3f_folder=folder;node.properties.s3f_folder_entry=entry;
    node.properties.s3f_timeline_ready=!!entry;
    if(entry)node.properties.s3f_timeline_session=entry.timeline;
    const widget=node.widgets.find(w=>w.name==='video_name');if(widget)widget.value=entry?.name||'';
    const plan=node.widgets.find(w=>w.name==='plan_json');if(plan)plan.value='{}';
    app.graph.change();node.setDirtyCanvas(true,true);
}
async function responseJSON(response){if(!response.ok)throw new Error(await response.text());return response.json();}
const bulkJobs=new Map(),actions=new Set();
const isBatch=definition=>{try{const plan=JSON.parse(definition.inputs?.plan_json||'{}');return !!(plan.folder_batch||plan.folder_queue)}catch{return false}};
export function setupFolder(jobs){
    api.addEventListener('s3f_folder_progress',event=>{
        for(const [node,win]of windows)if(node.properties.s3f_folder===event.detail.folder)
            win.postMessage({type:'s3f-folder-progress',batch:event.detail},location.origin);
    });
    window.addEventListener('message',async event=>{
        const data=event.data;if(event.origin!==location.origin||data?.type!=='s3f-folder-action')return;
        const found=[...windows].find(([node,win])=>event.source===win&&String(node.id)===String(data.node));if(!found)return;
        const [node,win]=found,reply=result=>win.postMessage({type:'s3f-folder-result',request:data.request,...result},location.origin);
        const post=(action,body)=>api.fetchApi(`/sam3d_funscript/folders/${data.folder}/${action}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(responseJSON);
        let owned=false;
        try{
            if(app.graph?.getNodeById(node.id)!==node||node.properties.s3f_folder!==data.folder)throw new Error('Reopen this folder from its current workflow node.');
            if(data.action==='cancel'){
                const job=bulkJobs.get(node);
                if(!job?.prompt_id)throw new Error('Use ComfyUI’s queue controls to stop a batch started before the main tab reloaded.');
                const response=await api.fetchApi(`/jobs/${encodeURIComponent(job.prompt_id)}/cancel`,{method:'POST'});
                if(!response.ok)throw new Error('Could not cancel the job. Use ComfyUI’s queue controls.');
                reply({result:{cancelled:true}});return;
            }
            const readOnly=['lease','issues','versions','version','preflight','pause'].includes(data.action)||(data.action==='preset'&&!data.settings);
            if(!readOnly){
                if(actions.has(node)||jobs.has(node))throw new Error('Wait for the current clip action to finish.');
                actions.add(node);owned=true;
                const queue=await responseJSON(await api.fetchApi('/queue',{cache:'no-store'}));
                const folderPath=node.widgets.find(w=>w.name==='folder_path')?.value;
                const queued=[...queue.queue_running,...queue.queue_pending].flatMap(item=>Object.values(item[2]||{})).filter(n=>n.class_type==='S3F_FolderTimeline'&&n.inputs?.folder_path===folderPath);
                if(queued.some(n=>!isBatch(n))||(['bulk','queue_start'].includes(data.action)&&(queued.length||bulkJobs.has(node))))
                    throw new Error('This folder has a queued or running job for this action.');
                const listing=await responseJSON(await api.fetchApi(`/sam3d_funscript/folders/${data.folder}`,{cache:'no-store'}));
                const active=listing.entries.find(e=>e.id===node.properties.s3f_folder_entry?.id)?.processing;
                if(active&&data.action!=='open'&&data.action!=='preset')throw new Error('This clip is processing. Open another completed clip to review it.');
                if(!active)await flushWorkspaceNode(node);
            }
            if(data.action==='bulk'||data.action==='queue_start'){
                const persistent=data.action==='queue_start';
                const prompt=await app.graphToPrompt(),definition=prompt.output[String(node.id)];
                if(!definition)throw new Error('Enable the folder node before processing.');
                if(definition.inputs.mask_video)throw new Error('Disconnect the shared mask input before bulk processing. Prepare masks per clip.');
                const checks=await post('preflight',{settings:definition.inputs,subfolder:data.subfolder||'',retry_failed:data.retry_failed===true,clip_ids:data.clip_ids,queue:persistent});
                if(!checks.ok)throw new Error(checks.errors.join(' · '));
                await post('lease',{clip:null,client:data.client});
                prompt.output={[String(node.id)]:definition};definition.inputs.operation='automatic';
                const saved=persistent?await post('queue_start',{}):null;
                definition.inputs.plan_json=JSON.stringify(persistent?{folder_queue:{ticket:saved.ticket}}:{folder_batch:{subfolder:data.subfolder||'',retry_failed:data.retry_failed===true,clip_ids:data.clip_ids}});
                const job={};bulkJobs.set(node,job);
                let acceptSubmission,rejectSubmission;
                const submitted=persistent?new Promise((resolve,reject)=>{acceptSubmission=resolve;rejectSubmission=reject;}):null;
                const completion=queueReferenceTracking(api,prompt,node.id,event=>{
                    if(event.prompt_id){job.prompt_id=event.prompt_id;acceptSubmission?.();}
                    win.postMessage({type:'s3f-folder-progress',text:event.text},location.origin);
                },{nodeType:node.type,resultKey:'s3f_folder'});
                completion.then(output=>win.postMessage({type:'s3f-folder-finished',batch:output.s3f_folder_batch?.[0]},location.origin),
                    async error=>{rejectSubmission?.(error);if(saved)await post('queue_failed',{ticket:saved.ticket,error:error.message}).catch(()=>{});win.postMessage({type:'s3f-folder-finished',error:error.message},location.origin);}).finally(()=>bulkJobs.delete(node));
                if(submitted)await submitted;
                reply({result:{started:true,queue:saved}});return;
            }
            if(!['open','approve','civitai_approve','civitai_reject','ignore','review','lease','issues','preset','preflight','pause','versions','version','save_version','restore_version','rate_version'].includes(data.action))throw new Error('Unknown folder action');
            const body={clip:data.clip,client:data.client};
            if(['approve','civitai_approve','civitai_reject','save_version','restore_version'].includes(data.action)){
                const current=node.properties.s3f_folder_entry;
                if(current?.id!==data.clip)throw new Error('Open and review this video in Motion Studio first.');
                const editor=workspaceEditor(node,current.editor_session);
                if(!editor?.s3fEditorRevision)throw new Error('Wait for Motion Studio to load.');
                body.revision=editor.s3fEditorRevision();body.replace=data.replace===true;body.expected=current.script_versions;
            }
            for(const key of ['ignored','quality','note','version','name','subfolder','settings','category'])if(data[key]!==undefined)body[key]=data[key];
            if(data.action==='preflight'){body.settings=Object.fromEntries(node.widgets.map(w=>[w.name,w.value]));body.clip_ids=data.clip_ids;}
            const result=await post(data.action,body);
            if(data.action==='open'){
                updateFolderNode(node,data.folder,result);node.s3fTimelineStatus.textContent=`Folder video · ${result.name}`;await refreshWorkspaces();
            }
            if(data.action==='approve'||data.action==='civitai_approve'){
                const entry=result.listing.entries.find(e=>e.id===data.clip);
                updateFolderNode(node,data.folder,{...entry,script_versions:result.script_versions});await refreshWorkspaces();
                if(result.relocated){await workspaceEditor(node,entry.editor_session)?.s3fUpdate?.();for(const frame of win.s3fFolderFrames?.()||[])if(frame.key===`timeline:${entry.timeline}`)await frame.window.s3fTimelineLoad?.();}
            }
            if(data.action==='civitai_reject'&&result.deleted){updateFolderNode(node,data.folder,null);await refreshWorkspaces();}
            if(data.action==='restore_version')await workspaceEditor(node,node.properties.s3f_folder_entry.editor_session)?.s3fUpdate?.();
            reply({result});
        }catch(error){reply({error:error.message});}
        finally{if(owned)actions.delete(node);}
    });
}
