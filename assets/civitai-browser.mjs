// Remote ranking stays in Civitai's order; local state is joined by the video ID.
import {civitaiQueue} from './civitai-queue.mjs?v=1';
export function civitaiBrowser(root,{folder,openClip,processClips,startQueue,refreshFolder,reviewMode,reviewState,decide}){
    root.innerHTML=`<div id="cv-discovery"><h2>Civitai videos</h2><p id="cv-library" class="hint"></p>
    <div class="controls"><label>View <select id="cv-view"><option value="local">Already downloaded</option><option value="remote">Browse Civitai</option></select></label><label>Site <select id="cv-site"><option>civitai.red</option><option>civitai.com</option><option>civitaired.com</option></select></label><label>Ratings <select id="cv-ratings"><option value="31">All ratings</option><option value="1">PG</option><option value="2">PG-13</option><option value="4">R</option><option value="8">X</option><option value="16">XXX</option></select></label><label>Sort <select id="cv-sort"><option>Most Reactions</option><option>Most Comments</option><option>Most Collected</option><option>Newest</option><option>Oldest</option></select></label><label>Period <select id="cv-period"><option value="Month">Month</option><option value="Week">Week</option><option value="Day">Day</option><option value="Year">Year</option><option value="AllTime">All time</option></select></label></div>
    <div class="controls"><label>Creator <input id="cv-creator" placeholder="Exact Civitai username"></label><label>Video ID <input id="cv-id" inputmode="numeric" placeholder="Optional exact ID"></label><button id="cv-browse">Refresh downloads</button><button id="cv-refresh">Refresh local status</button><button id="cv-resume">Review temporary clips</button></div>
    <div class="controls"><label>Show <select id="cv-filter"><option value="all">All except ignored</option><option value="new">Not downloaded</option><option value="downloaded">Downloaded</option><option value="pending">Downloaded · needs processing</option><option value="temporary">Temporary · awaiting review</option><option value="processed">Processed or scripted</option><option value="ignored">Ignored</option></select></label><label>Destination category <select id="cv-category"></select></label><input id="cv-new-category" placeholder="New category or subfolder/category" aria-label="New category"><button id="cv-add-category">Add category</button></div>
    <details id="cv-connection" open><summary>Civitai API key · <span id="cv-key-status">Checking saved key…</span></summary><div class="controls"><label>API key <input id="cv-key" type="password" autocomplete="off" placeholder="Paste your Civitai API key" aria-label="Civitai API key"></label><button id="cv-save-key">Save key</button><button id="cv-remove-key">Remove saved key</button><a href="https://civitai.com/user/account" target="_blank" rel="noopener noreferrer">Get a key in Civitai account settings</a></div><p class="hint">Saved keys are used for browsing and requesting video download links. The key stays on the ComfyUI server, outside your workflow. Website login cookies are separate.</p></details>
    <div class="cv-actions"><div class="controls"><label><input id="cv-select-page" type="checkbox"> Select visible clips</label><span id="cv-selected">0 selected</span><button id="cv-clear">Clear selection</button><button id="cv-process" class="primary">Add selected to queue</button><button id="cv-download">Download only</button><button id="cv-review">Review selected one by one</button><button id="cv-stop" hidden>Stop after this download</button></div><div id="cv-selection" aria-label="Selected clips"></div></div>
    <div id="cv-queue-panel"></div>
    <p id="cv-status" role="status">Existing videos are recognized by their Civitai IDs. Choose Browse Civitai to discover more.</p><p class="hint">New clips stay temporary until approved into a category. Existing downloads are reused. Undecided clips keep their files and edits between sessions.</p>
    <div id="cv-grid" class="civitai-grid"></div><button id="cv-more" hidden>Load more</button></div>
    <section id="cv-review-panel" hidden><div class="controls"><button id="cv-back">← Browser</button><button id="cv-previous">← Previous clip</button><button id="cv-next">Next clip →</button><strong id="cv-position"></strong><label><input type="checkbox" id="cv-auto" checked> Auto-process new clips</label></div>
    <div class="controls"><label>Approve into <select id="cv-review-category"></select></label><input id="cv-review-new-category" placeholder="New category" aria-label="New review category"><button id="cv-review-add-category">Add category</button><button id="cv-approve" class="primary">Approve & next</button><button id="cv-reject">Reject & next</button><button id="cv-later">Keep for later & next</button><button id="cv-process-one">Auto-process this clip</button></div><p id="cv-review-status" role="status"></p><p class="hint">Refine with the processing timeline and Motion Studio below. Approval saves the video and scripts into its category. Rejection deletes temporary downloads only; existing local videos are kept and ignored.</p></section>`;
    const $=id=>root.querySelector('#'+id),base=new URL(`../civitai/${folder}`,location.href),selected=new Map(),cards=new Map();
    const thumbnails=new IntersectionObserver(entries=>{
        for(const {target,isIntersecting} of entries)if(isIntersecting){
            target.poster=target.dataset.poster;thumbnails.unobserve(target);
        }
    },{rootMargin:'150px'});
    let library=null,items=[],cursor=null,busy=false,loading=false,stop=false,generation=0,active=false,polling=false,localLimit=48,reviewQueue=[],reviewIndex=-1,reviewClip=null,reviewBusy=false;
    const prefsKey='s3f-civitai:'+folder;
    const queueView=civitaiQueue($('cv-queue-panel'),{change:queueChange,start:beginQueue,review:rows=>startReview(rows.map(row=>({item:items.find(i=>i.id===row.id)||{id:row.id},clip:row.clip,category:row.category}))),thumbnail:clip=>new URL(base.pathname+'/thumbnail/'+clip,location.href).href,error:text=>message(text,true)});
    async function queueChange(action,key){library.queue=await api('queue',{action,key});controls();}
    async function beginQueue(){const result=await startQueue();library.queue=result.queue;controls();message('Queue submitted. ComfyUI downloads missing clips and generates draft funscripts in the background.');}
    async function addQueue(rows){
        const snapshot=rows.map(({item,category,clip})=>({id:item.id,name:(item.username?item.username+' · ':'')+item.id,clip:clip||copies(item)[0]?.id,category:category||$('cv-category').value,site:$('cv-site').value}));
        library.queue=await api('queue',{action:'add',items:snapshot});
        for(const row of snapshot)selected.delete(row.id);
        controls();$('cv-queue-panel').querySelector('details').open=true;
        if(!['running','queued'].includes(library.queue.stage))$('cv-queue-panel').scrollIntoView({block:'center',behavior:'smooth'});
        message(library.queue.stage==='running'?'Clips added. The running queue will pick them up.':'Selection saved in the queue. Click Start queue to download and generate draft funscripts.');
    }
    try{const prefs=JSON.parse(localStorage.getItem(prefsKey)||'{}');for(const id of ['cv-site','cv-sort','cv-period','cv-ratings','cv-view'])if([...$(id).options].some(o=>o.value===prefs[id]))$(id).value=prefs[id];}catch{}
    const preference=()=>{try{localStorage.setItem(prefsKey,JSON.stringify(Object.fromEntries(['cv-site','cv-sort','cv-period','cv-ratings','cv-category','cv-view'].map(id=>[id,$(id).value]))));}catch{}};
    function message(text,error=false){for(const id of ['cv-status','cv-review-status']){$(id).textContent=text;$(id).classList.toggle('error',error);}}
    async function api(action,body){
        const response=await fetch(new URL(action?base.pathname+'/'+action:base.href,location.href),action?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{cache:'no-store'});
        if(!response.ok){const message=await response.text();if(response.status===401||response.status===403||/Civitai returned HTTP (401|403)/.test(message))$('cv-connection').open=true;throw new Error(message);}
        return response.json();
    }
    function choices(select,value){select.replaceChildren(new Option('Choose a category',''),...(library?.categories||[]).map(c=>new Option(c,c)));select.value=(library?.categories||[]).includes(value)?value:'';}
    function acceptLibrary(value){
        library=value;let category=$('cv-category').value;
        if(!category)try{category=JSON.parse(localStorage.getItem(prefsKey)||'{}')['cv-category']}catch{}
        choices($('cv-category'),category);
        $('cv-library').textContent=`${Object.keys(library.items).length} known Civitai videos · ${library.root}`;
        $('cv-key-status').textContent=library.token_configured?'Key configured':'No key configured';
    }
    const copies=item=>library?.items?.[item.id]||[];
    const ignored=item=>library?.ignored?.includes(item.id)||copies(item).length>0&&copies(item).every(e=>e.status==='ignored');
    const processed=item=>copies(item).some(e=>e.processed);
    function visible(){return items.filter(item=>{
        const filter=$('cv-filter').value,local=copies(item);
        return filter==='ignored'?ignored(item):!ignored(item)&&(filter==='all'||filter==='new'&&!local.length||filter==='downloaded'&&local.length||filter==='pending'&&local.some(e=>!e.processed&&e.status!=='ignored')||filter==='processed'&&processed(item)||filter==='temporary'&&local.some(e=>e.civitai_temporary));
    });}
    function localItems(){
        const creator=$('cv-creator').value.trim().toLowerCase(),identifier=$('cv-id').value.trim();
        items=Object.entries(library?.items||{}).map(([id,entries])=>({id,local:true,username:entries[0].name.split('/').at(-1).split(/_?civitai_/i)[0],page:`https://${$('cv-site').value}/images/${id}`}))
            .filter(i=>(!identifier||i.id===identifier)&&(!creator||i.username.toLowerCase()===creator));
        // Local files have no remote popularity metrics; use their stable filename order.
        items.sort((a,b)=>copies(a)[0].name.localeCompare(copies(b)[0].name));
    }
    function label(item){
        const queued=library?.queue?.items.find(row=>row.id===item.id);
        if(queued&&['waiting','downloading','processing','error','interrupted','deferred'].includes(queued.state))return ({waiting:'Queued · waiting',downloading:'Downloading',processing:'Generating funscript',error:'Queue failed · retry available',interrupted:'Interrupted · retry available',deferred:'Waiting for review to close'})[queued.state];
        const local=copies(item),job=library?.downloads?.[item.id];
        if(job?.state==='downloading')return `Downloading · ${(job.bytes/1024**2).toFixed(1)} MB${job.total?' / '+(job.total/1024**2).toFixed(1)+' MB':''}`;
        if(local.some(e=>e.processing))return 'Downloaded · Processing';
        if(local.some(e=>e.status==='approved'))return 'Downloaded · Approved';
        if(local.some(e=>e.existing.length))return 'Downloaded · Funscript exists';
        if(processed(item))return local.some(e=>e.civitai_temporary)?'Temporary · Draft ready':'Downloaded · Draft ready';
        return local.some(e=>e.civitai_temporary)?'Temporary · awaiting review':local.length?'Downloaded':'Not downloaded';
    }
    function controls(){
        const pending=Object.values(library?.items||{}).filter(entries=>entries.some(e=>e.civitai_temporary&&e.status!=='ignored')).length;
        $('cv-resume').textContent=`Review temporary clips (${pending})`;$('cv-resume').disabled=busy||!pending;
        $('cv-selected').textContent=`${selected.size} selected`;
        for(const id of ['cv-download','cv-process'])$(id).disabled=busy||!selected.size;
        $('cv-clear').disabled=busy||!selected.size;$('cv-review').disabled=busy||!selected.size;$('cv-select-page').disabled=busy;
        $('cv-stop').hidden=!busy;$('cv-stop').disabled=stop;
        $('cv-browse').disabled=loading||busy;$('cv-more').disabled=loading||busy;
        $('cv-ratings').disabled=$('cv-sort').disabled=$('cv-period').disabled=$('cv-view').value==='local'||busy;
        for(const id of ['cv-view','cv-site','cv-creator','cv-id','cv-category','cv-new-category','cv-add-category','cv-save-key','cv-remove-key'])$(id).disabled=busy;
        $('cv-browse').textContent=$('cv-view').value==='local'?'Refresh downloads':'Browse videos';
        queueView.update(library?.queue);
        $('cv-selection').replaceChildren(...[...selected.values()].map(({item})=>{const chip=document.createElement('button');chip.textContent=(item.username?item.username+' · ':'')+item.id+' ×';chip.title='Remove from selection';chip.disabled=busy;chip.onclick=()=>{selected.delete(item.id);controls();};return chip;}));
        const rows=visible().slice(0,$('cv-view').value==='local'?localLimit:Infinity);$('cv-select-page').checked=!!rows.length&&rows.every(i=>selected.has(i.id));
        for(const [id,card]of cards){const row=items.find(i=>i.id===id);if(!row)continue;
            card.querySelector('.cv-state').textContent=label(row)+(ignored(row)?' · Ignored':'');
            card.querySelector('.cv-state').classList.toggle('processed',processed(row));
            card.querySelector('.cv-check').checked=selected.has(id);
            card.classList.toggle('selected',selected.has(id));
            for(const control of card.querySelectorAll('button,input,select'))control.disabled=busy;
            for(const control of card.querySelectorAll('[data-enqueue]')){const queued=library?.queue?.items.some(item=>item.id===id);control.disabled=busy||queued;control.textContent=queued?'In queue':'Add to queue';}
        }
        reviewControls();
    }
    function render(){
        thumbnails.disconnect();
        for(const video of $('cv-grid').querySelectorAll('video'))video.pause();
        cards.clear();const rows=visible(),displayed=$('cv-view').value==='local'?rows.slice(0,localLimit):rows;
        $('cv-grid').replaceChildren(...displayed.map(item=>{
            const local=copies(item),card=document.createElement('article');card.className='civitai-card';card.dataset.id=item.id;
            const player=document.createElement('video');player.controls=true;player.preload='none';player.muted=true;player.playsInline=true;
            const entry=local[0];
            function preview(copy){
                player.pause();player.removeAttribute('poster');
                player.src=copy?new URL(base.pathname+'/local/'+copy.id,location.href).href:item.url;
                const poster=copy?new URL(base.pathname+'/thumbnail/'+copy.id,location.href).href:item.poster;
                if(poster){player.dataset.poster=poster;thumbnails.observe(player);}
            }
            preview(entry);
            player.addEventListener('play',()=>{for(const other of $('cv-grid').querySelectorAll('video'))if(other!==player)other.pause();});
            const title=document.createElement('a');title.textContent=(item.username?item.username+' · ':'')+item.id;title.href=item.page;title.target='_blank';title.rel='noopener noreferrer';
            const state=document.createElement('p');state.className='cv-state';
            const paths=document.createElement('p');paths.className='hint cv-paths';paths.textContent=local.map(e=>e.civitai_temporary?'Temporary review / '+e.name.split('/').at(-1):e.name).join('\n');
            const selectLabel=document.createElement('label'),check=document.createElement('input');check.type='checkbox';check.className='cv-check';selectLabel.append(check,' Select');
            const category=document.createElement('select');category.setAttribute('aria-label','Category for '+item.id);
            choices(category,selected.get(item.id)?.category||entry?.category||$('cv-category').value);
            check.onchange=()=>{if(check.checked)selected.set(item.id,{item,category:category.value,clip:card.querySelector('select[aria-label="Local copy"]')?.value});else selected.delete(item.id);controls();};
            category.onchange=()=>{if(selected.has(item.id))selected.get(item.id).category=category.value;};
            const buttons=document.createElement('div');buttons.className='controls';
            function button(text,fn){const b=document.createElement('button');b.textContent=text;b.onclick=()=>Promise.resolve(fn()).catch(error=>message(error.message,true));buttons.append(b);return b;}
            if(local.length){
                const pick=document.createElement('select');pick.setAttribute('aria-label','Local copy');
                pick.replaceChildren(...local.map(e=>new Option(e.name,e.id)));if(local.length>1)card.append(pick);
                pick.onchange=()=>{preview(local.find(e=>e.id===pick.value));if(selected.has(item.id))selected.get(item.id).clip=pick.value;};
                button('Review / refine',()=>startReview([{item,clip:pick.value,category:category.value} ]));
                if(local.some(e=>!e.processed&&e.status!=='ignored'))button('Add to queue',()=>addQueue([{item,category:category.value,clip:pick.value}])).dataset.enqueue='';
            }else{button('Review clip',()=>startReview([{item,category:category.value}]));button('Download',()=>download([{item,category:category.value}]));button('Add to queue',()=>addQueue([{item,category:category.value}])).dataset.enqueue='';}
            button(ignored(item)?'Restore':'Ignore',async()=>{acceptLibrary(await api('ignore',{id:item.id,ignored:!ignored(item)}));selected.delete(item.id);render();});
            card.append(player,title,state,paths,selectLabel,category,buttons);cards.set(item.id,card);return card;
        }));
        if(!displayed.length){const p=document.createElement('p');p.className='hint';p.textContent='No clips in this view. Change the filter or load another page.';$('cv-grid').append(p);}
        $('cv-more').hidden=$('cv-view').value==='local'?localLimit>=rows.length:cursor===null;controls();
    }
    async function refresh(){acceptLibrary(await api());if($('cv-view').value==='local')localItems();render();}
    async function browse(more=false){
        if(loading)return;
        if($('cv-view').value==='local'){localLimit=more?localLimit+48:48;await refresh();return;}
        const token=++generation;loading=true;controls();message('Loading Civitai videos…');
        const options={site:$('cv-site').value,sort:$('cv-sort').value,period:$('cv-period').value,browsingLevel:Number($('cv-ratings').value),username:$('cv-creator').value.trim(),imageId:$('cv-id').value.trim()};
        if(more)options.cursor=cursor;
        try{
            const data=await api('browse',options);if(token!==generation)return;
            acceptLibrary(data.library);const old=more?items:[],seen=new Set(old.map(i=>i.id));items=[...old,...data.items.filter(i=>!seen.has(i.id))];
            cursor=data.next_cursor??null;render();preference();message(`${items.length} videos loaded in Civitai’s ${options.sort.toLowerCase()} order.`);
        }finally{if(token===generation){loading=false;controls();}}
    }
    async function download(rows){
        if(busy)return;const snapshot=rows.map(row=>({...row,category:row.category||$('cv-category').value})),site=$('cv-site').value;
        busy=true;stop=false;controls();const failures=[];let finished=0;
        try{
            for(const {item,category,clip}of snapshot){
                if(stop)break;
                message(`${copies(item).length?'Using downloaded':'Downloading'} video ${item.id} · ${finished+1} / ${snapshot.length}`);
                try{
                    if(ignored(item))throw new Error('Restore this ignored video first.');
                    const local=copies(item),entry=local.find(e=>e.id===clip)||local.find(e=>e.category===category)||local[0];
                    if(!entry)await api('download',{id:item.id,category,site});
                    finished++;
                }catch(error){failures.push(`${item.id}: ${error.message}`);}
            }
            await refresh();await refreshFolder();
            message(`${finished} clips downloaded for review.${stop?' Stopped; completed downloads are kept.':''}${failures.length?'\n'+failures.join('\n'):''}`,!!failures.length);
        }finally{busy=false;controls();}
    }
    function reviewControls(){
        if(reviewIndex<0)return;
        const state=reviewState(),entry=copies(reviewQueue[reviewIndex].item).find(e=>e.id===reviewClip),locked=reviewBusy||busy||state.busy||entry?.processing||state.entry?.id===reviewClip&&(state.entry.processing||state.processing);
        $('cv-position').textContent=`Clip ${reviewIndex+1} / ${reviewQueue.length}${entry?' · '+label(reviewQueue[reviewIndex].item):''}`;
        $('cv-previous').disabled=reviewBusy||reviewIndex===0;$('cv-next').disabled=reviewBusy||reviewIndex>=reviewQueue.length-1;
        $('cv-later').disabled=reviewBusy;$('cv-later').textContent=reviewIndex>=reviewQueue.length-1?'Keep for later':'Keep for later & next';
        $('cv-back').disabled=reviewBusy;
        $('cv-approve').disabled=locked||!entry||state.entry?.id!==reviewClip||!state.ready||entry.status==='ignored'||entry.civitai_temporary&&!$('cv-review-category').value;
        $('cv-reject').disabled=locked||!entry||state.entry?.id!==reviewClip||!state.ready;
        $('cv-process-one').disabled=locked||!entry||entry.processed||state.batching||entry.status==='ignored';
        $('cv-review-category').disabled=locked||!entry?.civitai_temporary;
        $('cv-review-add-category').disabled=$('cv-review-new-category').disabled=locked||!entry?.civitai_temporary;
        $('cv-reject').textContent=entry?.civitai_temporary?'Reject · delete temporary clip & next':'Ignore local clip & next';
    }
    function reviewPanels(show){
        $('cv-discovery').hidden=show;$('cv-review-panel').hidden=!show;reviewMode(show);
    }
    async function startReview(rows){
        if(reviewBusy||busy||!rows.length)return;
        reviewQueue=rows.map(r=>({...r}));reviewIndex=0;reviewClip=null;reviewPanels(true);await showReview();
    }
    async function showReview(){
        reviewBusy=true;reviewControls();
        try{
            const row=reviewQueue[reviewIndex],local=copies(row.item);
            let entry=local.find(e=>e.id===row.clip)||local[0];
            if(!entry){message('Downloading a temporary copy for review…');entry=(await api('download',{id:row.item.id,category:row.category||'',site:$('cv-site').value})).entry;await refreshFolder();}
            await refresh();reviewClip=entry.id;
            choices($('cv-review-category'),row.category||entry.category_hint||entry.category||$('cv-category').value);
            await openClip(entry.id);
            message(entry.civitai_temporary?'Temporary clip · process, refine, then approve into a category.':'Existing local clip · refine it below; rejection keeps the original file.');
            const state=reviewState();
            if($('cv-auto').checked&&!entry.processed&&!entry.processing&&entry.status!=='ignored'){
                if(state.batching)message('A batch is running. This clip is kept for review; use Auto-process when the batch finishes.');
                else{await processClips([entry.id]);message('Automatic processing queued. Refine the result below when it is ready.');}
            }
        }finally{reviewBusy=false;reviewControls();}
    }
    async function advance(delta=1){
        if(reviewBusy)return;
        const next=reviewIndex+delta;if(next<0||next>=reviewQueue.length)return;
        reviewIndex=next;await showReview();
    }
    async function leaveReview(){
        if(reviewBusy)return;
        reviewBusy=true;reviewControls();
        try{
            const state=reviewState();
            if(reviewClip&&state.entry?.id===reviewClip&&!state.entry.processing&&!state.processing)await openClip(reviewClip);
            reviewIndex=-1;reviewPanels(false);render();message('Undecided clips and saved edits are kept in Temporary · awaiting review.');
        }finally{reviewBusy=false;reviewControls();}
    }
    async function decision(action){
        if(reviewBusy||!reviewClip)return;
        reviewBusy=true;reviewControls();
        try{
            const row=reviewQueue[reviewIndex],result=await decide(action,reviewClip,$('cv-review-category').value);
            selected.delete(row.item.id);await refresh();
            message(action==='approve'?'Approved · video and scripts saved.':result.deleted?'Temporary clip deleted.':'Local video kept and ignored.');
        }finally{reviewBusy=false;reviewControls();}
        if(reviewIndex+1<reviewQueue.length){reviewIndex++;await showReview();}
        else{reviewIndex=-1;reviewClip=null;reviewPanels(false);render();}
    }
    const handle=fn=>()=>Promise.resolve().then(fn).catch(error=>message(error.message,true));
    $('cv-resume').onclick=handle(()=>startReview(Object.entries(library.items).flatMap(([id,entries])=>{
        const entry=entries.find(e=>e.civitai_temporary&&e.status!=='ignored');return entry?[{item:{id},clip:entry.id,category:entry.category}]:[];
    })));
    $('cv-review-add-category').onclick=handle(async()=>{
        const name=$('cv-review-new-category').value.trim();acceptLibrary(await api('category',{name}));
        choices($('cv-review-category'),name);reviewQueue[reviewIndex].category=name;$('cv-review-new-category').value='';reviewControls();
    });
    $('cv-back').onclick=handle(leaveReview);
    $('cv-previous').onclick=handle(()=>advance(-1));$('cv-next').onclick=handle(()=>advance());
    $('cv-later').onclick=handle(()=>reviewIndex+1<reviewQueue.length?advance():leaveReview());
    $('cv-approve').onclick=handle(()=>decision('approve'));$('cv-reject').onclick=handle(()=>decision('reject'));
    $('cv-process-one').onclick=handle(async()=>{await processClips([reviewClip]);message('Automatic processing queued.');reviewControls();});
    $('cv-review-category').onchange=()=>{reviewQueue[reviewIndex].category=$('cv-review-category').value;reviewControls();};
    $('cv-browse').onclick=handle(()=>browse());$('cv-more').onclick=handle(()=>browse(true));$('cv-refresh').onclick=handle(refresh);
    $('cv-view').onchange=()=>{++generation;loading=false;items=[];cursor=null;preference();if($('cv-view').value==='local')localItems();render();message($('cv-view').value==='local'?'Your existing downloads are ready.':'Choose sorting and click Browse videos.');};
    $('cv-filter').onchange=render;$('cv-category').onchange=()=>{for(const value of selected.values())value.category=$('cv-category').value;preference();render();};
    for(const id of ['cv-site','cv-sort','cv-period','cv-ratings'])$(id).onchange=()=>{cursor=null;++generation;loading=false;if($('cv-view').value==='remote')items=[];preference();render();};
    $('cv-select-page').onchange=()=>{for(const item of visible().slice(0,$('cv-view').value==='local'?localLimit:Infinity))if($('cv-select-page').checked)selected.set(item.id,{item,clip:cards.get(item.id)?.querySelector('select[aria-label="Local copy"]')?.value,category:cards.get(item.id)?.querySelector('select[aria-label^="Category"]')?.value||$('cv-category').value});else selected.delete(item.id);controls();};
    $('cv-clear').onclick=()=>{selected.clear();controls();};$('cv-stop').onclick=()=>{stop=true;$('cv-stop').disabled=true;message('Stopping after the current download.');};
    $('cv-download').onclick=handle(()=>download([...selected.values()]));$('cv-process').onclick=handle(()=>addQueue([...selected.values()]));$('cv-review').onclick=handle(()=>startReview([...selected.values()]));
    $('cv-add-category').onclick=handle(async()=>{const name=$('cv-new-category').value.trim();acceptLibrary(await api('category',{name}));$('cv-category').value=name;$('cv-new-category').value='';preference();render();});
    $('cv-save-key').onclick=handle(async()=>{const token=$('cv-key').value.trim();if(!token)throw new Error('Enter a key before saving.');await api('key',{token});$('cv-key').value='';await refresh();message('API key saved on the server.');});
    $('cv-remove-key').onclick=handle(async()=>{await api('key',{token:''});$('cv-key').value='';await refresh();message('Saved key removed. An environment key, if configured, still applies.');});
    setInterval(async()=>{if(!active||polling||loading)return;polling=true;try{const value=await api();if(busy){library=value;controls();}else{acceptLibrary(value);controls();}}catch{}finally{polling=false;}},3000);
    return {async activate(){active=true;reviewMode(reviewIndex>=0);try{await refresh();}catch(error){message(error.message,true);}},deactivate(){active=false;reviewMode(false);for(const video of root.querySelectorAll('video'))video.pause();}};
}
