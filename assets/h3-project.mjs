// Page/panel navigation shares the ordinary Timeline and Motion Studio editors.
export function h3Project({folder, change, run, open, host}){
    const style=document.createElement('link');style.rel='stylesheet';style.href=new URL('./h3-project.css?v=2',import.meta.url);document.head.append(style);
    const root=document.createElement('section');root.id='h3-project';root.hidden=true;
    document.querySelector('.filters').before(root);
    root.innerHTML=`<div class="controls"><label>Page <select id="h3-page"></select></label><button id="h3-exclude">Exclude page</button><label><input id="h3-older" type="checkbox"> All completed takes</label><span id="h3-summary" class="hint"></span></div>
    <p class="hint">Reading order · H3 main takes and joined panels · clean video preferred. Still / camera-motion takes are shown but skipped by bulk tracking. Excluded pages and videos stay in the project and can be restored. Approve saves scripts beside the selected video.</p>
    <details id="h3-checks"><summary>Check drawings · person detection</summary><div class="h3-check-layout"><img id="h3-page-image" alt="Selected page" loading="lazy"><div><div class="controls"><button id="h3-check-page">Check page image</button><label>Panel <select id="h3-panel"></select></label><button id="h3-check-panel">Check panel image</button><button id="h3-check-video">Check current video · 3 frames</button></div><div class="controls"><label>Person confidence <input id="h3-confidence" type="number" min="0.05" max="1" step="0.05" value="0.15"></label><button id="h3-save-confidence">Save confidence</button></div><p class="hint">Project default for checks and future Automatic runs; page/panel presets can override it. Lower values may find drawn bodies with more false positives. Select a video person box below to test its pose and curve.</p><p id="h3-probe-status" role="status"></p><div id="h3-probe-results"></div></div></div></details>`;
    const warnings=document.createElement('details'),warningTitle=document.createElement('summary'),warningItems=document.createElement('ul');
    warnings.append(warningTitle,warningItems);root.append(warnings);
    const $=id=>document.getElementById('h3-'+id);let listing=null,current=null,busy=false,checking=false,serial=0,bookKey='',pageChoice='',confidenceDirty=false,selectedPanel='',probeRequest=null,probeController=null;
    const queued=new Set();try{for(const id of JSON.parse(localStorage.getItem('s3f-h3-queue:'+folder)||'[]'))queued.add(id);}catch{}
    const endpoint=action=>new URL(`../h3/${folder}/${action}`,location.href);
    const accepts=e=>(!$('page').value||e.h3?.page_id===$('page').value)&&($('older').checked||(e.h3?.main??e.h3?.latest));
    function invalidate(){serial++;cancelProbe();chosenPerson=null;if($('trial-curve'))$('trial-curve').hidden=true;if($('trial-pose'))$('trial-pose').hidden=true;if($('trial-status')&&!trialRunning)$('trial-status').textContent='Check the current video, select a person, then test its pose and curve.';$('probe-results').replaceChildren();$('probe-status').textContent='';}
    function panels(){
        const old=$('panel').value,items=listing.h3.panels.filter(p=>!$('page').value||p.page_id===$('page').value);
        $('panel').replaceChildren(...items.map(p=>new Option(`Panel ${p.order+1}`,p.id)));
        if(items.some(p=>p.id===old))$('panel').value=old;
        const url=endpoint('image');url.searchParams.set('page',$('page').value);
        const version=listing.h3.pages.find(p=>p.id===$('page').value)?.image_version;
        if(version)url.searchParams.set('v',version);
        $('page-image').hidden=!$('page').value;
        if($('page').value&&$('page-image').src!==url.href)$('page-image').src=url.href;
    }
    function browsePage(id){
        $('page').value=id;pageChoice=id;selectedPanel='';invalidate();panels();change();
    }
    $('page').onchange=()=>browsePage($('page').value);
    $('older').onchange=change;$('panel').onchange=()=>{selectedPanel=$('panel').value;invalidate();change();};
    $('exclude').onclick=()=>run('h3_exclude_page',{page:$('page').value,excluded:!listing.h3.excluded_pages.includes($('page').value)});
    $('confidence').oninput=()=>{confidenceDirty=true;invalidate();$('probe-status').textContent='Save confidence to use this value for detector checks and Automatic.';};
    $('save-confidence').onclick=async()=>{
        const value=$('confidence').value;confidenceDirty=true;
        if(await run('h3_confidence',{confidence:Number(value)})===true){
            if($('confidence').value===value)confidenceDirty=false;
            invalidate();render(listing,current,busy);
        }
    };
    async function check(body){
        if(checking)return;checking=true;const generation=++serial;probeRequest=[...crypto.getRandomValues(new Uint8Array(16))].map(v=>v.toString(16).padStart(2,'0')).join('');probeController=new AbortController();body.request_id=probeRequest;
        $('probe-results').replaceChildren();$('probe-status').textContent='Checking person detection on CPU…';render(listing,current,busy);
        try{
            const response=await fetch(endpoint('probe'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.any([probeController.signal,AbortSignal.timeout(120000)])});
            if(!response.ok)throw Error(await response.text());const result=await response.json();if(generation!==serial)return;
            for(const sample of result.samples){
                const card=document.createElement('figure'),wrap=document.createElement('div'),image=document.createElement('img'),caption=document.createElement('figcaption');
                wrap.className='h3-sample';image.src=sample.image;image.alt='Detector test frame';wrap.append(image);
                for(const person of sample.people){
                    const box=document.createElement('span'),[x,y,r,b]=person.box;box.className='h3-person-box';
                    Object.assign(box.style,{left:`${x*100}%`,top:`${y*100}%`,width:`${(r-x)*100}%`,height:`${(b-y)*100}%`});box.textContent=`${Math.round(person.confidence*100)}%`;wrap.append(box);
                    if(body.clip){const use=document.createElement('button');use.textContent='Use this person · '+Math.round(person.confidence*100)+'%';use.onclick=()=>{chosenPerson={clip:body.clip,roi:[x,y,r-x,b-y],at_ms:sample.at_ms};$('trial-status').textContent='Person selected. Choose an anchor and run a 2-second trial.';render(listing,current,busy);};card.append(use);}
                }
                caption.textContent=`${sample.at_ms==null?'Still image':(sample.at_ms/1000).toFixed(2)+'s'} · ${sample.people.length} person boxes`;
                card.append(wrap,caption);$('probe-results').append(card);
            }
            $('probe-status').textContent=`Confidence ${result.confidence} · ${result.message}`;
        }catch(error){if(generation===serial)$('probe-status').textContent=error.name==='TimeoutError'?'Detector check timed out. You can still edit the timeline.':error.message;}
        finally{checking=false;probeRequest=null;probeController=null;render(listing,current,busy);}
    }
    $('check-page').onclick=()=>check({page:$('page').value});$('check-panel').onclick=()=>check({panel:$('panel').value});$('check-video').onclick=()=>check({clip:current.id});
    const shell=document.createElement('div');shell.id='h3-shell';
    const main=document.createElement('main');main.id='h3-main';
    const local=document.getElementById('local-panel'),workbench=document.getElementById('clip-workbench');
    local.before(shell);shell.append(root,main);main.append(local,workbench);document.body.classList.add('h3-workspace');
    const rail=document.createElement('div');rail.className='h3-navigator';
    rail.innerHTML='<nav id="h3-pages" aria-label="Project pages"></nav><section><div class="controls"><strong>Panels</strong><button id="h3-select-page">Select missing on page</button></div><div id="h3-panels"></div></section>';
    root.append(rail);
    const controls=document.createElement('section');controls.id='h3-panel-tools';controls.innerHTML=`
      <div class="controls"><strong id="h3-panel-title">Browse pages and panels</strong><button id="h3-open-panel">Open main take</button><button id="h3-exclude-panel">Exclude panel</button></div><p id="h3-panel-status" class="hint"></p>`;
    main.prepend(controls);
    main.insertBefore($('checks'),local);
    const queue=document.createElement('details');queue.id='h3-queue';queue.innerHTML=`<summary id="h3-queue-title">Processing queue</summary>
      <div class="controls"><label>Pages <input id="h3-page-range" placeholder="1–5, 8, 12" aria-label="Page numbers to select"></label><button id="h3-select-range">Select range</button><button id="h3-select-missing">Select all missing</button><button id="h3-clear-queue">Clear selection</button><label><input id="h3-reprocess" type="checkbox"> Include completed scripts / drafts</label></div>
      <p class="hint">Select panels without loading their videos. Start uses these exact takes. Existing scripts stay untouched until approval. You can remove waiting clips while another clip processes.</p>
      <div class="controls"><button id="h3-start-queue" class="primary">Start selected</button><button id="h3-pause-queue">Pause after clip</button><button id="h3-stop-queue">Stop now</button><span id="h3-queue-status" role="status"></span></div><div id="h3-queue-items"></div>`;
    main.insertBefore(queue,local);
    const trial=document.createElement('section');trial.innerHTML=`<div class="controls"><button id="h3-cancel-probe">Cancel detector check</button><label>Anchor <select id="h3-trial-anchor"><option value="pelvis">Pelvis</option><option value="mouth">Mouth</option><option value="left_hand">Left hand</option><option value="right_hand">Right hand</option></select></label><button id="h3-trial">Test 2 seconds</button></div><p id="h3-trial-status" class="hint">Check the current video, select a detected person, then test its pose and curve before processing the whole take.</p><canvas id="h3-trial-curve" width="650" height="150" hidden aria-label="Trial stroke curve"></canvas>`;
    $('checks').append(trial);let chosenPerson=null,trialRunning=false;
    $('checks').querySelector('summary').textContent='Drawing preflight · boxes, pose and motion';
    function cancelProbe(){if(probeRequest){fetch(endpoint('cancel_probe'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({request_id:probeRequest})}).catch(()=>{});probeController?.abort();}}
    $('cancel-probe').onclick=()=>{cancelProbe();$('probe-status').textContent='Cancelling detector check…';};
    function el(tag,text,cls){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;}
    function button(text,fn){const b=el('button',text);b.type='button';b.onclick=fn;return b;}
    function thumb(kind,id,version){const image=el('img');image.alt=kind==='page'?'Page thumbnail':'Panel thumbnail';image.loading='lazy';const url=endpoint('image');url.searchParams.set(kind,id);if(version)url.searchParams.set('v',version);image.src=url;image.onerror=()=>{image.hidden=true;};return image;}
    const mainFor=panel=>listing.entries.find(e=>e.h3?.panel_id===panel&&e.h3.main);
    function reason(e){return !e?'No video':!e.h3?'Unavailable take':e.h3?.selection_error?'Needs attention':e.status==='ignored'?'Excluded':e.h3?.render_mode==='still'?'Still / camera motion':e.processing?'Processing':e.script_warning?'Script needs repair':e.status==='approved'?'Approved':e.status==='existing'?'Saved script':e.batch_result==='ready'?'Draft ready':e.batch_result==='error'?'Needs attention':'Unprocessed';}
    function eligible(e){return !!e?.h3&&e.status!=='ignored'&&!e.h3?.selection_error&&e.h3?.render_mode!=='still'&&!e.processing&&($('reprocess').checked||e.status==='pending'&&e.batch_result!=='ready');}
    function rememberQueue(){try{localStorage.setItem('s3f-h3-queue:'+folder,JSON.stringify([...queued]));}catch{}renderQueue();renderNavigator();}
    function selectPages(pages){for(const e of listing.entries)if(e.h3?.main&&pages.includes(e.h3.page_id)&&eligible(e))queued.add(e.id);rememberQueue();$('queue').open=true;}
    $('select-page').onclick=()=>selectPages($('page').value?[$('page').value]:listing.h3.pages.map(p=>p.id));
    $('select-missing').onclick=()=>selectPages(listing.h3.pages.map(p=>p.id));
    $('select-range').onclick=()=>{const numbers=new Set();try{for(const part of $('page-range').value.split(',')){const m=part.trim().match(/^(\d+)(?:\s*[-–]\s*(\d+))?$/);if(!m)throw Error('Use page numbers such as 1–5, 8.');const a=+m[1],b=+(m[2]||m[1]);if(a<1||b<a||b>listing.h3.pages.length)throw Error('Choose a range inside this project.');for(let i=a;i<=b;i++)numbers.add(i);}selectPages(listing.h3.pages.filter(p=>numbers.has(p.order+1)).map(p=>p.id));}catch(e){$('queue-status').textContent=e.message;}};
    $('clear-queue').onclick=()=>{queued.clear();rememberQueue();};$('reprocess').onchange=()=>{renderQueue();renderNavigator();};
    $('start-queue').onclick=async()=>{const ids=[...queued].filter(id=>eligible(listing.entries.find(e=>e.id===id)));if(!ids.length)return;const result=await run($('reprocess').checked?'reprocess':'bulk',{clip_ids:ids});if(result){ids.forEach(id=>queued.delete(id));rememberQueue();}};
    $('pause-queue').onclick=()=>run('pause',{});$('stop-queue').onclick=()=>run('cancel',{});
    $('exclude-panel').onclick=()=>run('h3_exclude_panel',{panel:selectedPanel,excluded:!(listing.h3.excluded_panels||[]).includes(selectedPanel)});
    $('open-panel').onclick=async()=>{const e=mainFor(selectedPanel)||listing.entries.find(e=>e.h3?.panel_id===selectedPanel);if(e)await open(e.id);};
    function renderNavigator(){
        const pages=$('pages'),key=JSON.stringify([listing.h3.pages,listing.h3.panels,listing.entries.map(e=>[e.id,e.status,e.batch_result,e.processing,e.script_warning]),listing.h3.excluded_pages,$('page').value]);
        if(pages.dataset.key!==key){pages.dataset.key=key;pages.replaceChildren(button('All pages',()=>browsePage('')));
            for(const p of listing.h3.pages){const entries=listing.entries.filter(e=>e.h3?.page_id===p.id&&e.h3.main),done=entries.filter(e=>['approved','existing'].includes(e.status)).length;
                const b=button('',()=>browsePage(p.id));b.setAttribute('aria-current',String(p.id===$('page').value));b.title=p.name;
                if(p.image)b.append(thumb('page',p.id,p.image_version));b.append(el('strong',`Page ${p.order+1}`),el('small',p.error?'Needs attention':listing.h3.excluded_pages.includes(p.id)?'Excluded':`${done}/${entries.length} saved · ${p.panels||0} panels`));pages.append(b);}
        }
        const panelRows=listing.h3.panels.filter(p=>!$('page').value||p.page_id===$('page').value),panelKey=JSON.stringify([key,selectedPanel,[...queued],$('reprocess').checked,listing.h3.excluded_panels,busy]);
        if($('panels').dataset.key!==panelKey){$('panels').dataset.key=panelKey;$('panels').replaceChildren();
            for(const p of panelRows){const e=mainFor(p.id),row=el('article',undefined,'h3-panel-card');row.dataset.panel=p.id;row.classList.toggle('selected',p.id===selectedPanel);
                const check=el('input');check.type='checkbox';check.checked=!!e&&queued.has(e.id);check.disabled=!eligible(e);check.setAttribute('aria-label',`Queue page ${listing.h3.pages.find(page=>page.id===p.page_id)?.order+1}, panel ${p.order+1}`);check.onchange=()=>{if(check.checked)queued.add(e.id);else queued.delete(e.id);rememberQueue();};
                const b=button('',()=>{selectedPanel=p.id;$('panel').value=p.id;invalidate();change();});if(p.image)b.append(thumb('panel',p.id,p.image_version));b.append(el('strong',`Panel ${p.order+1}`),el('small',!$('page').value?`${p.page_id} · ${reason(e)}`:reason(e)));
                if((listing.h3.excluded_panels||[]).includes(p.id))b.append(el('small','Panel excluded'));
                if(p.joined_into)b.append(el('small','Joined to '+p.joined_into));
                if(e)b.append(el('small',e.h3.take+(e.h3.loop?' · Loop':'')));
                row.append(check,b);$('panels').append(row);
            }
            if(!panelRows.length)$('panels').append(el('p',listing.h3.pages.find(p=>p.id===$('page').value)?.error||'No panels on this page.','hint'));
        }
        for(const id of ['save-draft','restore-draft'])$(id).disabled=busy||!current||current.processing||!accepts(current)||!!selectedPanel&&current.h3?.panel_id!==selectedPanel;
        const supported=listing.h3.workspace_version>=2;
        for(const id of ['save-preset','load-preset','save-draft','restore-draft','exclude-panel','trial'])$(id).disabled||=!supported;
        $('save-preset').disabled=busy||!supported||listing.batch?.stage==='running';
        if(!supported)$('settings-status').textContent='Updated H3 controls become available after the next ComfyUI restart. Your current processing can finish first.';
        const panel=listing.h3.panels.find(p=>p.id===selectedPanel),entry=mainFor(selectedPanel);
        $('panel-title').textContent=panel?`Page ${(listing.h3.pages.find(p=>p.id===panel.page_id)?.order??0)+1} · Panel ${panel.order+1}`:'Choose a panel';
        $('panel-status').textContent=panel?`${reason(entry)}${entry?.script_warning?' · '+entry.script_warning:''}${entry?' · '+entry.h3.take:' · You can check its drawing before a video exists.'}`:'Browse and select panels here. Opening a take loads its shared Timeline and Motion Studio.';
        $('open-panel').disabled=busy||!listing.entries.some(e=>e.h3?.panel_id===selectedPanel);
        $('exclude-panel').disabled=busy||!panel||listing.entries.some(e=>e.processing&&e.h3.source_panel_ids?.includes(selectedPanel));
        $('exclude-panel').textContent=(listing.h3.excluded_panels||[]).includes(selectedPanel)?'Restore panel':'Exclude panel';
        $('cancel-probe').disabled=!checking;$('trial').disabled=busy||trialRunning||!chosenPerson||chosenPerson.clip!==current?.id||current?.processing||!supported;
        $('exclude-panel').disabled||=!supported;
    }
    function renderQueue(){
        const batch=listing.batch,active=batch?.stage==='running',rows=$('queue-items');rows.replaceChildren();
        const pending=[...queued].map(id=>listing.entries.find(e=>e.id===id)||{id,name:'Unavailable take'});
        const ready=pending.filter(eligible);$('queue-title').textContent=`Processing queue · ${ready.length} selected${active?' · running':''}`;
        $('start-queue').disabled=busy||active||!ready.length;$('pause-queue').disabled=$('stop-queue').disabled=!active;
        if(batch?.stage)$('queue-status').textContent=`${batch.stage} · ${batch.completed?.length||0}/${batch.total||0} ready · ${batch.failed?.length||0} failed`;
        function row(label,status,remove){const r=el('div',undefined,'h3-queue-row');r.append(el('span',label),el('small',status));if(remove)r.append(button('Remove',remove));rows.append(r);}
        for(const item of batch?.items||[]){const status=batch.current_id===item.id?'Processing':batch.completed.includes(item.name)?'Draft ready':batch.failed.some(e=>e.name===item.name)?'Failed':batch.skipped.includes(item.name)?'Skipped':batch.deferred?.includes(item.name)?'Deferred for review':batch.removed_ids?.includes(item.id)?'Removal requested':'Waiting';row(item.label,status,active&&status==='Waiting'?async()=>{const response=await fetch(new URL(`../folders/${folder}/h3_skip_waiting`,location.href),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({clip:item.id})});if(!response.ok){$('queue-status').textContent=await response.text();return;}await run('refresh',{});}:null);}
        for(const e of pending)row(e.h3?.label||e.name,eligible(e)?'Selected':reason(e),()=>{queued.delete(e.id);rememberQueue();});
    }

    const settings=document.createElement('details');settings.id='h3-settings';settings.innerHTML=`<summary>Processing presets &amp; portable drafts</summary>
    <div class="controls"><label>Save preset for <select id="h3-preset-scope"><option value="project">Project</option><option value="page">Selected page</option><option value="panel">Selected panel</option></select></label><button id="h3-load-preset">Load effective preset</button><button id="h3-save-preset">Save these settings</button></div>
    <div class="controls"><label>Confidence <input id="h3-preset-confidence" type="number" min="0.05" max="1" step="0.05" value="0.15"></label><label>Anchor <select id="h3-preset-anchor"><option value="auto">Best candidate</option><option value="pelvis">Pelvis</option><option value="mouth">Mouth</option><option value="left_hand">Left hand</option><option value="right_hand">Right hand</option></select></label><label>Smoothing (ms) <input id="h3-preset-smoothing" type="number" min="0" max="2000" value="30"></label><label>Sample FPS <input id="h3-preset-fps" type="number" min="0" max="120" value="0"></label></div>
    <p class="hint">Project → page → panel. Load a working setup, change the destination scope, then save to reuse it. Existing curves are kept. Zero FPS uses all video frames.</p><p id="h3-settings-status" class="hint" role="status"></p>
    <div class="controls"><button id="h3-save-draft">Save portable draft in project</button><button id="h3-restore-draft">Restore portable draft</button></div><p class="hint">Stores editable Main curves, axis settings and review notes beside this project. Restore checks the video content and keeps a recovery version. Detection caches stay in ComfyUI. Approved sidecars are written only by Approve.</p>`;
    main.insertBefore(settings,local);
    let loadedPreset={preferred_anchor:'auto',smoothing_ms:30,range_mode:'adaptive',movement_range:.2,sample_fps:0,batch_size:8,cut_sensitivity:'normal',confidence:.15};
    async function presetRequest(save){
        const scope=$('preset-scope').value,body={};
        if(scope==='page'){if(!$('page').value)throw Error('Select one page first.');body.page=$('page').value;}
        if(scope==='panel'){if(!selectedPanel)throw Error('Select a panel first.');body.panel=selectedPanel;}
        if(save)body.settings={...loadedPreset,confidence:Number($('preset-confidence').value),preferred_anchor:$('preset-anchor').value,smoothing_ms:Number($('preset-smoothing').value),sample_fps:Number($('preset-fps').value)};
        const response=await fetch(new URL(`../folders/${folder}/h3_preset`,location.href),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(60000)});
        if(!response.ok)throw Error(await response.text());const result=await response.json();loadedPreset=result.settings;
        for(const [field,key]of Object.entries({confidence:'confidence',anchor:'preferred_anchor',smoothing:'smoothing_ms',fps:'sample_fps'}))$('preset-'+field).value=result.settings[key];
        $('settings-status').textContent=`${save?'Saved':'Loaded'} ${result.scope}${result.overridden?' override':' · inherited defaults'}`;
    }
    $('load-preset').onclick=()=>presetRequest(false).catch(e=>$('settings-status').textContent=e.message);
    $('save-preset').onclick=()=>presetRequest(true).catch(e=>$('settings-status').textContent=e.message);
    $('save-draft').onclick=async()=>{if(await run('h3_save_draft',{}))$('settings-status').textContent='Portable Main draft and review saved in the project.';};
    $('restore-draft').onclick=async()=>{if(await run('h3_restore_draft',{}))$('settings-status').textContent='Portable Main restored. Previous curves are kept in Script versions.';};
    $('trial').onclick=async()=>{
        trialRunning=true;$('trial-status').textContent='Drawing trial queued in ComfyUI · 2 seconds at 6 FPS…';renderNavigator();
        const result=await run('h3_trial',{trial:{...chosenPerson,anchor:$('trial-anchor').value}});
        if(!result){trialRunning=false;$('trial-status').textContent='Trial could not start. See the workspace status.';renderNavigator();}
    };
    const pose=el('canvas');pose.id='h3-trial-pose';pose.hidden=true;pose.width=480;pose.height=300;
    const poseControls=el('div',undefined,'controls'),poseSlider=el('input');poseSlider.type='range';poseSlider.min=0;poseSlider.step=1;poseSlider.setAttribute('aria-label','Trial pose frame');poseSlider.hidden=true;
    poseControls.append(poseSlider);trial.append(pose,poseControls);
    window.addEventListener('message',event=>{
        const data=event.data;if(event.origin!==location.origin||event.source!==host||data?.type!=='s3f-h3-trial-result'||data.folder!==folder||!trialRunning)return;
        trialRunning=false;if(data.error){$('trial-status').textContent=data.error;renderNavigator();return;}
        const result=data.result;if(result.clip!==current?.id){$('trial-status').textContent='Trial finished for a different take. Reopen it to test again.';renderNavigator();return;}
        $('trial-status').textContent=`${((result.end_ms-result.start_ms)/1000).toFixed(1)} second ${result.anchor} trial · inspect the pose frames and curve. ${result.warnings?.join(' · ')||''}`;
        const c=$('trial-curve'),ctx=c.getContext('2d'),actions=result.scripts?.L0?.actions||[];c.hidden=false;ctx.clearRect(0,0,c.width,c.height);ctx.strokeStyle='#79d7bd';ctx.lineWidth=2;ctx.beginPath();
        actions.forEach((a,i)=>{const x=8+(a.at-result.start_ms)/Math.max(1,result.end_ms-result.start_ms)*(c.width-16),y=c.height-8-a.pos/100*(c.height-16);if(i)ctx.lineTo(x,y);else ctx.moveTo(x,y);});ctx.stroke();
        let paint=0;
        async function frame(index){const image=new Image(),n=++paint;image.src=result.images[index]?.image||'';try{await image.decode();}catch{return;}if(n!==paint||current?.id!==result.clip)return;
            const context=pose.getContext('2d'),scale=Math.min(pose.width/image.width,pose.height/image.height),w=image.width*scale,h=image.height*scale,x=(pose.width-w)/2,y=(pose.height-h)/2;context.clearRect(0,0,pose.width,pose.height);context.drawImage(image,x,y,w,h);
            let nearest=0;result.times_ms.forEach((at,i)=>{if(Math.abs(at-result.images[index].at_ms)<Math.abs(result.times_ms[nearest]-result.images[index].at_ms))nearest=i;});
            context.fillStyle='#7ff2c5';for(const person of result.pixels[nearest]||[])for(const point of person||[])if(point?.length>=2&&point.every(Number.isFinite)){context.beginPath();context.arc(x+point[0]/result.width*w,y+point[1]/result.height*h,2,0,2*Math.PI);context.fill();}
        }
        pose.hidden=poseSlider.hidden=!result.images?.length;poseSlider.max=Math.max(0,(result.images?.length||1)-1);poseSlider.value=0;poseSlider.oninput=()=>frame(Number(poseSlider.value));if(result.images?.length)void frame(0);renderNavigator();
    });

    function render(value,entry,locked){
        root.hidden=!value?.h3;if(!value?.h3)return;
        if(current?.id!==entry?.id){invalidate();chosenPerson=null;if(entry?.h3)selectedPanel=entry.h3.panel_id;}listing=value;current=entry;busy=locked;
        document.title='H3 Animator · Funscript workspace';document.querySelector('header h1').textContent=value.h3.title+' · Funscripts';
        for(const selector of ['.library-tabs','#subfolder-picker','#review-order-controls','#tool-dataset-panel','#dataset-panel','#tool-bulk-review-panel','#bulk-review-panel','#tool-bulk-panel','#bulk-panel','#tool-preset-panel','#preset-panel'])document.querySelector(selector).hidden=true;
        const source=document.getElementById('tags-source');source.value='local';source.closest('label').hidden=true;document.getElementById('tags-site').closest('label').hidden=true;
        document.getElementById('refresh').textContent='Refresh H3 project';document.getElementById('search').placeholder='Page, panel or video';
        document.getElementById('preset-panel').querySelector('summary').textContent='Project processing preset';
        const key=JSON.stringify([value.h3.pages,value.h3.panels,value.h3.excluded_pages,value.h3.warnings]);
        if(key!==bookKey){
            if(selectedPanel&&!value.h3.panels.some(p=>p.id===selectedPanel))selectedPanel='';
            const old=$('page').value;bookKey=key;
            $('page').replaceChildren(new Option('All pages',''),...value.h3.pages.map(p=>new Option(`Page ${p.order+1} · ${p.name} · ${p.videos} videos${value.h3.excluded_pages.includes(p.id)?' · Excluded':''}`,p.id)));
            if(value.h3.pages.some(p=>p.id===old))$('page').value=old;
            pageChoice=$('page').value;invalidate();panels();
            const messages=value.h3.warnings||[];warnings.hidden=!messages.length;
            warningTitle.textContent=`${messages.length} take metadata issue${messages.length===1?'':'s'} · other videos remain available`;
            warningItems.replaceChildren(...messages.map(message=>{const item=document.createElement('li');item.textContent=message;return item;}));
        }
        const excluded=value.h3.excluded_pages.includes($('page').value);
        $('exclude').textContent=excluded?'Restore page':'Exclude page';$('exclude').disabled=busy||!$('page').value||value.entries.some(e=>(e.h3?.source_page_ids||[e.h3?.page_id]).includes($('page').value)&&e.processing);
        for(const id of ['page','panel','older','confidence','save-confidence'])$(id).disabled=busy;
        $('check-page').disabled=busy||checking||!$('page').value;$('check-panel').disabled=busy||checking||!$('panel').value;
        $('check-video').disabled=busy||checking||!current||!accepts(current)||current.processing||!!selectedPanel&&current.h3?.panel_id!==selectedPanel;
        if(selectedPanel&&listing.h3.panels.some(p=>p.id===selectedPanel))$('panel').value=selectedPanel;
        if(!confidenceDirty&&document.activeElement!==$('confidence'))$('confidence').value=value.h3.confidence??.15;
        const count=value.entries.filter(accepts).length;const mains=value.entries.filter(e=>e.h3?.main),saved=mains.filter(e=>['approved','existing'].includes(e.status)).length;
        $('summary').textContent=`${saved}/${mains.length} main scripts saved · ${mains.filter(e=>e.batch_result==='ready'&&e.status==='pending').length} drafts · ${count} takes in view`;
        document.getElementById('ignore').textContent='Exclude video';document.getElementById('ignore-next').textContent='Exclude & next';
        document.getElementById('restore').textContent='Restore video';
        if(current?.h3?.page_excluded||current?.h3?.panel_excluded){document.getElementById('restore').disabled=true;document.getElementById('detail').textContent+=' · Restore its page to include this video';}
        renderNavigator();renderQueue();
        document.getElementById('bulk').textContent=$('page').value?'Process eligible videos on this page':'Process eligible project videos';
        document.querySelector('#bulk-panel p.hint').textContent='Creates drafts in reading order for the page and take scope above. Still / camera-motion takes, excluded pages/videos, existing scripts and completed automatic drafts are skipped. Show, Quality and Find only filter review. All people and four anchors are prepared; approve each result after review.';
    }
    return {render,accepts,matchesPage:entry=>!!entry&&listing.entries.some(e=>e.id===entry.id)&&(!$('page').value||entry.h3?.page_id===$('page').value)&&(!selectedPanel||entry.h3?.panel_id===selectedPanel)};
}
