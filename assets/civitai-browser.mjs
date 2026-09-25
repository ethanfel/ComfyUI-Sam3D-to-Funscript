// Remote ranking stays in Civitai's order; local state is joined by the video ID.
import {civitaiQueue} from './civitai-queue.mjs?v=3';
export function civitaiBrowser(root,{folder,openClip,processClips,startQueue,refreshFolder,reviewMode,reviewState,decide}){
    root.innerHTML=`<div id="cv-discovery"><div class="cv-browser-header"><div><h2>Civitai videos</h2><p id="cv-library" class="hint"></p></div><div class="controls"><button id="cv-metadata-toggle" aria-expanded="false" aria-controls="cv-metadata-panel">Library metadata</button><button id="cv-refresh">Refresh local status</button><button id="cv-resume">Review temporary clips</button><button id="cv-aside">Set-aside clips (0)</button></div></div>
    <details id="cv-metadata-panel" open hidden><summary>Saved Civitai metadata</summary><p class="hint">Recover creator names, post galleries and source details for existing downloads using their Civitai IDs. Shared copies use the same record. Videos and scripts stay as they are.</p><div class="controls"><button id="cv-metadata-fill" disabled>Fill missing metadata</button><button id="cv-metadata-refresh" disabled>Refresh all metadata</button><button id="cv-metadata-stop" disabled>Stop after batch</button></div><p id="cv-metadata-status" class="hint" role="status"></p></details><div class="cv-browser-tools"><section class="cv-browse-controls" aria-labelledby="cv-browse-heading"><h3 id="cv-browse-heading">Find clips</h3>
    <div class="cv-filter-grid"><label>View <select id="cv-view"><option value="local">Already downloaded</option><option value="remote">Browse Civitai</option></select></label><label>Site <select id="cv-site"><option>civitai.red</option><option>civitai.com</option><option>civitaired.com</option></select></label><label>Ratings <select id="cv-ratings"><option value="31">All ratings</option><option value="1">PG</option><option value="2">PG-13</option><option value="4">R</option><option value="8">X</option><option value="16">XXX</option></select></label><label>Sort <select id="cv-sort"><option>Most Reactions</option><option>Most Comments</option><option>Most Collected</option><option>Newest</option><option>Oldest</option></select></label><label>Period <select id="cv-period"><option value="Month">Month</option><option value="Week">Week</option><option value="Day">Day</option><option value="Year">Year</option><option value="AllTime">All time</option></select></label></div>
    <div class="cv-search-actions"><details id="cv-search"><summary>Find by creator or video ID</summary><div class="controls"><label>Creator <input id="cv-creator" placeholder="Exact Civitai username"></label><label>Video ID <input id="cv-id" inputmode="numeric" placeholder="Optional exact ID"></label></div></details><button id="cv-browse" class="primary">Refresh downloads</button></div></section>
    <section class="cv-destination-controls" aria-labelledby="cv-destination-heading"><h3 id="cv-destination-heading">Destination category</h3><select id="cv-category" aria-labelledby="cv-destination-heading"></select><details id="cv-category-editor"><summary>+ New category</summary><form id="cv-category-form" class="controls"><input id="cv-new-category" placeholder="Name or parent/category" aria-label="New category" maxlength="500" required><button id="cv-add-category" type="submit">Add category</button></form></details><p class="hint">Clips stay temporary until you approve them into a category.</p></section></div>
    <details id="cv-connection"><summary>Civitai API key · <span id="cv-key-status">Checking saved key…</span></summary><div class="controls"><label>API key <input id="cv-key" type="password" autocomplete="off" placeholder="Paste your Civitai API key" aria-label="Civitai API key"></label><button id="cv-save-key">Save key</button><button id="cv-remove-key">Remove saved key</button><a href="https://civitai.com/user/account" target="_blank" rel="noopener noreferrer">Get a key in Civitai account settings</a></div><p class="hint">Saved keys are used for browsing and requesting video download links. The key stays on the ComfyUI server, outside your workflow. Website login cookies are separate.</p></details>
    <div class="cv-actions"><div class="cv-selection-controls"><div class="controls"><label>Show <select id="cv-filter"><option value="all">All except ignored</option><option value="new">Not downloaded</option><option value="downloaded">Downloaded</option><option value="pending">Downloaded · needs processing</option><option value="temporary">Temporary · awaiting review</option><option value="processed">Processed or scripted</option><option value="ignored">Ignored</option></select></label><label title="Hide generated drafts and videos with funscripts. Queue review remains available."><input id="cv-hide-done" type="checkbox"> Hide completed</label><label><input id="cv-select-page" type="checkbox"> Select visible clips</label><span id="cv-selected">0 selected</span><button id="cv-clear">Clear</button></div><div class="controls"><button id="cv-process" class="primary">Add selected to queue</button><button id="cv-download">Download only</button><button id="cv-review">Review selected</button><button id="cv-stop" hidden>Stop after this download</button></div></div><div id="cv-selection" aria-label="Selected clips"></div></div>
    <div id="cv-queue-panel"></div>
    <p id="cv-status" role="status">Existing videos are recognized by their Civitai IDs. Choose Browse Civitai to discover more.</p><p class="hint">New clips stay temporary until approved into a category. Existing downloads are reused. Undecided clips keep their files and edits between sessions.</p>
    <div id="cv-gallery-trail" class="controls" hidden><button id="cv-gallery-back">← Back to results</button><strong id="cv-gallery-title"></strong><a id="cv-gallery-link" target="_blank" rel="noopener noreferrer">Open on Civitai ↗</a></div><p id="cv-hidden-done" class="hint" role="status" hidden></p><div id="cv-grid" class="civitai-grid"></div><button id="cv-more" hidden>Load more</button></div>
    <section id="cv-review-panel" hidden><div class="controls"><button id="cv-back">← Browser</button><button id="cv-previous">← Previous clip</button><button id="cv-next">Next clip →</button><strong id="cv-position"></strong><button id="cv-edit-review">Edit review list</button><label><input type="checkbox" id="cv-auto" checked> Auto-process new clips</label></div>
    <div class="controls"><label>Approve into <select id="cv-review-category"></select></label><input id="cv-review-new-category" placeholder="New category" aria-label="New review category"><button id="cv-review-add-category">Add category</button><button id="cv-approve" class="primary">Approve & next</button><button id="cv-reject">Reject & next</button><button id="cv-later" title="Keep this clip in normal temporary review for another pass.">Keep for later & next</button><button id="cv-set-aside">Set aside & next</button><button id="cv-process-one">Auto-process this clip</button><button id="cv-retry-open" hidden>Retry opening clip</button></div><p id="cv-review-status" role="status"></p><p class="hint">Refine with the processing timeline and Motion Studio below. Approval saves the video and scripts into its category. Rejection deletes temporary downloads only; existing local videos are kept and ignored.</p></section>`;
    const $=id=>root.querySelector('#'+id),base=new URL(`../civitai/${folder}`,location.href),selected=new Map(),cards=new Map();
    const thumbnails=new IntersectionObserver(entries=>{
        for(const {target,isIntersecting} of entries)if(isIntersecting){
            target.poster=target.dataset.poster;thumbnails.unobserve(target);
        }
    },{rootMargin:'150px'});
    let library=null,items=[],cursor=null,busy=false,loading=false,stop=false,generation=0,active=false,polling=false,localLimit=48,reviewQueue=[],reviewIndex=-1,reviewClip=null,reviewBusy=false;
    let reviewVersion=0,reviewOpening=null,reviewLoading=false,listMode='review',listBusy=false,listSignature='';
    const listSelected=new Set(),settingAside=new Set();
    let connectionConfigured=null,categorySaving=false,gallery=null,metadataBusy=false;
    let pages=[],pageIndex=0,feedOptions=null,autoPaused=false,moreVisible=false,moreFrame=0;
    const navigation=document.createElement('div');navigation.className='controls';
    navigation.innerHTML='<label>Navigation <select id="cv-navigation"><option value="infinite">Infinite scroll</option><option value="pages">Pages</option></select></label><span id="cv-page-controls" class="controls" hidden><button id="cv-prev-page">← Previous page</button><span id="cv-page-number" aria-live="polite"></span><button id="cv-next-page">Next page →</button></span>';
    $('cv-selection').before(navigation);
    const reviewList=document.createElement('section');reviewList.id='cv-review-list';reviewList.hidden=true;
    reviewList.innerHTML='<div class="controls"><strong id="cv-list-title">Review list</strong><button id="cv-list-close">Close list</button></div><p class="hint">Set aside clips to work on separately. Their videos, drafts and categories are kept. An active processing job finishes its current clip.</p><div class="controls"><label><input type="checkbox" id="cv-list-all"> Select all</label><span id="cv-list-count"></span><button id="cv-list-apply">Set aside selected</button></div><p id="cv-list-status" role="status"></p><ol id="cv-list-rows"></ol>';
    $('cv-review-panel').before(reviewList);
    const paged=()=>$('cv-navigation').value==='pages';
    const moreObserver=new IntersectionObserver(entries=>{moreVisible=entries.at(-1).isIntersecting;scheduleMore();},{rootMargin:'400px 0px'});
    moreObserver.observe($('cv-more'));
    function scheduleMore(){
        if(moreFrame)return;
        moreFrame=requestAnimationFrame(()=>{
            moreFrame=0;const button=$('cv-more'),bounds=button.getBoundingClientRect();
            if(!active||paged()||loading||busy||autoPaused||reviewIndex>=0||document.hidden||button.hidden||!moreVisible||!bounds.height||bounds.bottom<=0||bounds.top>innerHeight+400)return;
            void browse(true).catch(error=>message(error.message,true));
        });
    }
    const trail=[],filterIds=['cv-view','cv-site','cv-ratings','cv-sort','cv-period','cv-creator','cv-id'];
    const prefsKey='s3f-civitai:'+folder;
    const queueView=civitaiQueue($('cv-queue-panel'),{edit:()=>showReviewList('queue'),setAside:rows=>setAside(rows.map(row=>({item:{id:row.id},...row}))),change:queueChange,start:beginQueue,review:rows=>{void startReview(rows.map(row=>({item:items.find(i=>i.id===row.id)||{id:row.id},clip:row.clip,category:row.category,ready:true,name:row.name}))).catch(error=>message(error.message,true));},thumbnail:clip=>new URL(base.pathname+'/thumbnail/'+clip,location.href).href,error:text=>message(text,true)});
    async function queueChange(action,key){library.queue=await api('queue',{action,key});controls();}
    async function beginQueue(){
        acceptLibrary(await api());controls();
        if(['running','queued'].includes(library.queue.stage)){message('This queue is already active. Added clips will be picked up by the same run.');return;}
        const result=await startQueue();library.queue=result.queue;controls();message('Queue submitted. ComfyUI downloads missing clips and generates draft funscripts in the background.');
    }
    async function addQueue(rows){
        const snapshot=rows.map(({item,category,clip})=>({id:item.id,name:(item.username?item.username+' · ':'')+item.id,clip:clip||copies(item)[0]?.id,category:category||$('cv-category').value,site:$('cv-site').value}));
        library.queue=await api('queue',{action:'add',items:snapshot});
        for(const row of snapshot)selected.delete(row.id);
        controls();
        message(['running','queued'].includes(library.queue.stage)?'Clips added. The current queue will pick them up automatically.':'Selection saved in the queue. Click Start queue to download and generate draft funscripts.');
    }
    try{const prefs=JSON.parse(localStorage.getItem(prefsKey)||'{}');for(const id of ['cv-site','cv-sort','cv-period','cv-ratings','cv-view','cv-navigation'])if([...$(id).options].some(o=>o.value===prefs[id]))$(id).value=prefs[id];$('cv-hide-done').checked=prefs['cv-hide-done']===true;}catch{}
    const preference=()=>{try{localStorage.setItem(prefsKey,JSON.stringify({...Object.fromEntries(['cv-site','cv-sort','cv-period','cv-ratings','cv-category','cv-view','cv-navigation'].map(id=>[id,$(id).value])),'cv-hide-done':$('cv-hide-done').checked}));}catch{}};
    function message(text,error=false){for(const id of ['cv-status','cv-review-status']){$(id).textContent=text;$(id).classList.toggle('error',error);}}
    async function api(action,body){
        const response=await fetch(new URL(action?base.pathname+'/'+action:base.href,location.href),action?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:action==='download'?undefined:AbortSignal.timeout(60000)}:{cache:'no-store',signal:AbortSignal.timeout(60000)});
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
        metadataControls();
        if(connectionConfigured!==library.token_configured){connectionConfigured=library.token_configured;$('cv-connection').open=!connectionConfigured;}
    }
    const copies=item=>library?.items?.[item.id]||[];
    const aside=item=>!!library?.set_aside?.[item.id];
    const ignored=item=>library?.ignored?.includes(item.id)||copies(item).length>0&&copies(item).every(e=>e.status==='ignored');
    const processed=item=>copies(item).some(e=>e.processed);
    function visible(){return (paged()&&$('cv-view').value==='remote'?pages[pageIndex]?.items||[]:items).filter(item=>{
        const filter=$('cv-filter').value,local=copies(item);
        if(aside(item)||$('cv-hide-done').checked&&processed(item))return false;
        return filter==='ignored'?ignored(item):!ignored(item)&&(filter==='all'||filter==='new'&&!local.length||filter==='downloaded'&&local.length||filter==='pending'&&local.some(e=>!e.processed&&e.status!=='ignored')||filter==='processed'&&processed(item)||filter==='temporary'&&local.some(e=>e.civitai_temporary));
    });}
    function displayedRows(){
        const rows=visible();if($('cv-view').value!=='local')return rows;
        pageIndex=Math.min(pageIndex,Math.max(0,Math.ceil(rows.length/48)-1));
        return rows.slice(paged()?pageIndex*48:0,paged()?(pageIndex+1)*48:localLimit);
    }
    function hasNext(){return $('cv-view').value==='local'?(paged()?(pageIndex+1)*48:localLimit)<visible().length:paged()&&pageIndex<pages.length-1||cursor!==null;}
    function resetPages(){pages=[];pageIndex=0;localLimit=48;cursor=null;feedOptions=null;autoPaused=false;}
    function localItems(){
        const creator=$('cv-creator').value.trim().toLowerCase(),identifier=$('cv-id').value.trim();
        items=Object.entries(library?.items||{}).map(([id,entries])=>({id,local:true,username:entries[0].creator_username||entries[0].name.split('/').at(-1).split(/_?civitai_/i)[0],post_id:entries[0].post_id,creator_known:!!entries[0].creator_username,page:`https://${$('cv-site').value}/images/${id}`}))
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
        metadataControls();
        $('cv-navigation').disabled=busy||loading;
        $('cv-page-controls').hidden=!paged();
        $('cv-page-number').textContent=$('cv-view').value==='local'?`Page ${pageIndex+1} / ${Math.max(1,Math.ceil(visible().length/48))}`:pages.length?`Page ${pageIndex+1}${cursor===null?' / '+pages.length:''}`:'Page 1';
        $('cv-prev-page').disabled=busy||loading||pageIndex===0;
        $('cv-next-page').disabled=busy||loading||!hasNext();
        $('cv-more').hidden=!hasNext();
        $('cv-more').textContent=loading?'Loading…':autoPaused?'Retry loading':paged()?'Next page →':'Load more';
        const pending=Object.entries(library?.items||{}).filter(([id,entries])=>!aside({id})&&entries.some(e=>e.civitai_temporary&&e.status!=='ignored')).length;
        $('cv-aside').textContent=`Set-aside clips (${Object.keys(library?.set_aside||{}).length})`;
        $('cv-aside').disabled=busy;
        $('cv-resume').textContent=`Review temporary clips (${pending})`;$('cv-resume').disabled=busy||!pending;
        if($('cv-hide-done').checked)for(const [id,row] of selected)if(processed(row.item))selected.delete(id);
        $('cv-selected').textContent=`${selected.size} selected`;
        const hidden=$('cv-hide-done').checked?items.filter(processed).length:0;
        $('cv-hidden-done').hidden=!hidden;$('cv-hidden-done').textContent=`${hidden} completed clips hidden from loaded results.`;
        $('cv-gallery-trail').hidden=!gallery;
        $('cv-gallery-title').textContent=gallery?(gallery.kind==='post'?`Same post${gallery.post_id?' · '+gallery.post_id:''}`:`Videos by ${gallery.username||'this creator'}`):'';
        $('cv-gallery-back').textContent=trail.at(-1)?.gallery?'← Back to previous gallery':'← Back to results';
        $('cv-gallery-link').hidden=!gallery||!(gallery.kind==='post'?gallery.post_id:gallery.username);
        if(gallery)$('cv-gallery-link').href=gallery.kind==='post'?`https://${$('cv-site').value}/posts/${gallery.post_id}`:`https://${$('cv-site').value}/user/${encodeURIComponent(gallery.username)}/images`;
        for(const id of ['cv-download','cv-process'])$(id).disabled=busy||!selected.size;
        $('cv-clear').disabled=busy||!selected.size;$('cv-review').disabled=busy||!selected.size;$('cv-select-page').disabled=busy;
        $('cv-stop').hidden=!busy;$('cv-stop').disabled=stop;
        $('cv-browse').disabled=loading||busy;$('cv-more').disabled=loading||busy;
        $('cv-ratings').disabled=$('cv-sort').disabled=$('cv-period').disabled=$('cv-view').value==='local'||busy;
        for(const id of ['cv-view','cv-site','cv-creator','cv-id','cv-category','cv-new-category','cv-add-category','cv-save-key','cv-remove-key'])$(id).disabled=busy;
        $('cv-add-category').disabled=$('cv-new-category').disabled=busy||categorySaving;
        $('cv-browse').textContent=gallery?'Refresh gallery':$('cv-view').value==='local'?'Refresh downloads':'Browse videos';
        $('cv-period').disabled=busy||!!gallery||$('cv-view').value==='local';
        $('cv-creator').disabled=$('cv-id').disabled=busy||!!gallery;
        queueView.update(library?.queue&&{...library.queue,set_aside_available:library.set_aside!==undefined,items:library.queue.items.filter(row=>!aside(row)||['downloading','processing'].includes(row.state))});
        $('cv-selection').replaceChildren(...[...selected.values()].map(({item})=>{const chip=document.createElement('button');chip.textContent=(item.username?item.username+' · ':'')+item.id+' ×';chip.title='Remove from selection';chip.disabled=busy;chip.onclick=()=>{selected.delete(item.id);controls();};return chip;}));
        const rows=displayedRows(),byId=new Map(items.map(item=>[item.id,item]));$('cv-select-page').checked=!!rows.length&&rows.every(i=>selected.has(i.id));
        for(const [id,card]of cards){const row=byId.get(id);if(!row)continue;
            card.querySelector('.cv-state').textContent=label(row)+(ignored(row)?' · Ignored':'');
            card.querySelector('.cv-state').classList.toggle('processed',processed(row));
            card.querySelector('.cv-check').checked=selected.has(id);
            card.classList.toggle('selected',selected.has(id));
            for(const control of card.querySelectorAll('button,input,select'))control.disabled=busy;
            for(const control of card.querySelectorAll('[data-gallery]')){control.disabled=busy||loading||library?.video_galleries!==true;control.title=library?.video_galleries===true?'':'Restart ComfyUI to enable post and creator galleries.';}
            for(const control of card.querySelectorAll('[data-enqueue]')){const queued=library?.queue?.items.some(item=>item.id===id);control.disabled=busy||queued;control.textContent=queued?'In queue':'Add to queue';}
        }
        reviewControls();renderReviewList();
        scheduleMore();
    }
    function render(append=false){
        if(!append){
            thumbnails.disconnect();
            for(const video of $('cv-grid').querySelectorAll('video'))video.pause();
            cards.clear();$('cv-grid').replaceChildren();
        }else $('cv-grid').querySelector(':scope > .hint')?.remove();
        const rows=displayedRows(),displayed=rows.filter(item=>!cards.has(item.id));
        $('cv-grid').append(...displayed.map(item=>{
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
            const related=document.createElement('div');related.className='cv-card-galleries';
            for(const [kind,text] of [['post','Same post'],['creator','More from this creator']]){
                if(kind==='post'&&gallery?.kind==='post'&&gallery.post_id===item.post_id||kind==='creator'&&gallery?.kind==='creator'&&gallery.username===item.username)continue;
                const b=document.createElement('button');b.textContent=text;b.dataset.gallery=kind;b.onclick=()=>openGallery(item,kind).catch(error=>message(error.message,true));related.append(b);
            }
            button(ignored(item)?'Restore':'Ignore',async()=>{acceptLibrary(await api('ignore',{id:item.id,ignored:!ignored(item)}));selected.delete(item.id);render();});
            card.append(player,title,state,paths,selectLabel,category,buttons,related);cards.set(item.id,card);return card;
        }));
        if(!rows.length){const p=document.createElement('p');p.className='hint';p.textContent='No clips match in these results. Change the filter or continue to the next page.';$('cv-grid').append(p);}
        controls();
    }
    async function refresh(){const value=await api();acceptLibrary(value);if($('cv-view').value==='local')localItems();render();return value;}
    async function openGallery(item,kind){
        if(busy||loading)return;
        const snapshot={items,cursor,localLimit,pages,pageIndex,feedOptions,autoPaused,gallery,scroll:window.scrollY,filters:Object.fromEntries(filterIds.map(id=>[id,$(id).value]))};
        trail.push(snapshot);
        gallery={kind,id:item.id,post_id:item.post_id,username:item.local&&!item.creator_known?'':item.username||''};
        $('cv-view').value='remote';$('cv-period').value='AllTime';$('cv-creator').value=kind==='creator'?gallery.username:'';$('cv-id').value='';
        if(kind==='post')$('cv-sort').value='Oldest';
        items=[];resetPages();render();
        $('cv-gallery-trail').scrollIntoView({block:'start'});
        try{await browse();}catch(error){if(trail.at(-1)===snapshot){backGallery();throw error;}}
    }
    function backGallery(){
        const snapshot=trail.pop();if(!snapshot)return;
        ++generation;loading=false;
        ({items,cursor,localLimit,pages,pageIndex,feedOptions,autoPaused,gallery}=snapshot);
        for(const [id,value]of Object.entries(snapshot.filters))$(id).value=value;
        render();preference();window.scrollTo(0,snapshot.scroll);
        message(gallery?'Returned to the previous gallery.':'Returned to your browsing results.');
    }
    async function browse(more=false){
        if(loading||busy||more&&!hasNext())return;
        autoPaused=false;
        if($('cv-view').value==='local'){
            if(more){if(paged())pageIndex++;else localLimit+=48;render(!paged());}
            else{resetPages();await refresh();}return;
        }
        if(more&&paged()&&pageIndex<pages.length-1){pageIndex++;render();return;}
        const token=++generation;loading=true;controls();if(!more)message('Loading Civitai videos…');
        const options=more?{...feedOptions}:{site:$('cv-site').value,sort:$('cv-sort').value,period:$('cv-period').value,browsingLevel:Number($('cv-ratings').value),username:$('cv-creator').value.trim(),imageId:$('cv-id').value.trim()};
        if(more)options.cursor=cursor;
        try{
            const data=await api(gallery?'gallery':'browse',gallery?{...options,id:gallery.id,kind:gallery.kind,postId:gallery.post_id,username:gallery.kind==='creator'?gallery.username:''}:options);if(token!==generation)return;
            if(gallery){gallery={...gallery,...data.gallery};if(gallery.kind==='creator')$('cv-creator').value=gallery.username;}
            acceptLibrary(data.library);if(!more){items=[];pages=[];pageIndex=0;feedOptions=options;}
            const seen=new Set(items.map(i=>i.id)),added=data.items.filter(item=>{if(seen.has(item.id))return false;seen.add(item.id);return true;});
            items=[...items,...added];pages=[...pages,{items:added,requestCursor:options.cursor??null}];
            if(more&&paged())pageIndex=pages.length-1;
            const next=data.next_cursor??null;cursor=pages.some(page=>page.requestCursor===next)?null:next;
            render(more&&!paged());preference();message(gallery?`${items.length} videos loaded from ${gallery.kind==='post'?'this post':gallery.username+'’s gallery'}.`:`${items.length} videos loaded in Civitai’s ${options.sort.toLowerCase()} order.`);
        }catch(error){if(token!==generation)return;autoPaused=true;throw error;}
        finally{if(token===generation){loading=false;controls();}}
    }
    function pageTop(){ $('cv-grid').scrollIntoView({block:'start'});window.scrollBy(0,-root.querySelector('.cv-actions').getBoundingClientRect().height-12); }
    async function nextPage(){await browse(true);if(paged())pageTop();}
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
        $('cv-position').textContent=`Clip ${reviewIndex+1} / ${reviewQueue.length}${entry?' · '+label(reviewQueue[reviewIndex].item):''}${aside(reviewQueue[reviewIndex].item)?' · Set aside · manual review':''}`;
        $('cv-previous').disabled=listBusy||reviewBusy&&!reviewLoading||reviewIndex===0;$('cv-next').disabled=listBusy||reviewBusy&&!reviewLoading||reviewIndex>=reviewQueue.length-1;
        $('cv-later').disabled=reviewBusy;$('cv-later').textContent=reviewIndex>=reviewQueue.length-1?'Keep for later':'Keep for later & next';
        $('cv-back').disabled=listBusy||reviewBusy&&!reviewLoading;
        $('cv-back').textContent=reviewLoading?'← Browser · dismiss loading':'← Browser';
        $('cv-set-aside').disabled=listBusy||reviewBusy&&!reviewLoading||library?.set_aside===undefined;
        $('cv-set-aside').title=library?.set_aside===undefined?'Restart ComfyUI to enable saved set-aside lists.':'';
        $('cv-approve').disabled=locked||!entry||state.entry?.id!==reviewClip||!state.ready||entry.status==='ignored'||entry.civitai_temporary&&!$('cv-review-category').value;
        $('cv-reject').disabled=locked||!entry||state.entry?.id!==reviewClip||!state.ready;
        $('cv-process-one').disabled=locked||!entry||state.entry?.id!==reviewClip||!state.ready||entry.processed||state.batching||entry.status==='ignored'||aside(reviewQueue[reviewIndex].item);
        $('cv-retry-open').disabled=reviewBusy||busy||state.busy;
        $('cv-review-category').disabled=locked||!entry?.civitai_temporary;
        $('cv-review-add-category').disabled=$('cv-review-new-category').disabled=locked||!entry?.civitai_temporary;
        $('cv-reject').textContent=entry?.civitai_temporary?'Reject · delete temporary clip & next':'Ignore local clip & next';
    }
    function reviewPanels(show){
        $('cv-discovery').hidden=show;$('cv-review-panel').hidden=!show;reviewMode(show,reviewClip);
    }
    async function startReview(rows){
        if(listBusy||reviewBusy&&!reviewLoading||busy||!rows.length)return;
        rows=rows.filter(row=>row.manual||!aside(row.item));if(!rows.length){message('These clips are set aside. Return them to review from Set-aside clips.');return;}
        reviewQueue=rows.map(r=>({...r}));reviewIndex=0;reviewClip=null;reviewPanels(true);await showReview();
    }
    async function showReview(){
        const version=++reviewVersion,row=reviewQueue[reviewIndex],previous=reviewOpening;
        const current=()=>version===reviewVersion&&reviewIndex>=0;
        reviewBusy=reviewLoading=true;reviewClip=null;reviewMode(true,null);reviewControls();renderReviewList();$('cv-retry-open').hidden=true;
        message(previous?'Switching clips · waiting for the previous open request to finish…':'Loading selected clip and its saved draft…');
        const slow=setTimeout(()=>{if(current())message('This clip is taking longer to open. You can go back to the browser, choose another clip or edit the review list.');},15000);
        const opening=(async()=>{
            // Serialize host opens, but keep browsing and list editing available.
            // Late responses must never reveal or process a clip we left behind.
            await previous?.catch(()=>{});if(!current())return;
            const fresh=await refresh();if(!current())return;
            if(!row.manual&&aside(row.item)||settingAside.has(row.item.id))return;
            const local=fresh.items[row.item.id]||[];
            let entry=row.clip?local.find(e=>e.id===row.clip):local[0];
            if(row.clip&&!entry)throw new Error('The selected queue clip moved or changed. Refresh the browser and select its current copy; another video has not been opened.');
            if(!entry){
                message('Downloading a temporary copy for review…');
                entry=(await api('download',{id:row.item.id,category:row.category||'',site:row.site||$('cv-site').value})).entry;
                if(!current())return;
                await refreshFolder();if(!current())return;
                const downloaded=await refresh();if(!current())return;
                entry=downloaded.items[row.item.id]?.find(e=>e.id===entry.id)||entry;
            }
            if(!row.manual&&aside(row.item)||settingAside.has(row.item.id))return;
            row.clip=entry.id;reviewClip=entry.id;
            choices($('cv-review-category'),row.category||entry.category_hint||entry.category||$('cv-category').value);
            row.category=$('cv-review-category').value;
            await openClip(entry.id,{processed:entry.processed,current});if(!current())return;
            const state=reviewState();
            if(state.entry?.id!==entry.id)throw new Error('The requested clip did not open. Retry opening it before reviewing its draft.');
            reviewMode(true,reviewClip);
            message(entry.processed?`Saved draft / script loaded · ${entry.name.split('/').at(-1)} · review in Motion Studio.`:row.ready?'The queue reports a finished draft, but its saved result is unavailable. Refresh local status before processing again.':entry.civitai_temporary?'Temporary clip · process, refine, then approve into a category.':'Existing local clip · refine it below; rejection keeps the original file.');
            if(!row.manual&&!row.ready&&!aside(row.item)&&!settingAside.has(row.item.id)&&$('cv-auto').checked&&!entry.processed&&!entry.processing&&entry.status!=='ignored'){
                if(state.batching)message('A batch is running. This clip is kept for review; use Auto-process when the batch finishes.');
                else{await processClips([entry.id]);if(current())message('Automatic processing queued. Refine the result below when it is ready.');}
            }
        })();
        reviewOpening=opening;
        try{await opening;}
        catch(error){if(current()){reviewClip=null;reviewMode(true,null);$('cv-retry-open').hidden=false;throw error;}}
        finally{
            clearTimeout(slow);if(reviewOpening===opening)reviewOpening=null;
            if(current()){reviewBusy=reviewLoading=false;reviewControls();renderReviewList();}
        }
    }
    async function advance(delta=1){
        if(listBusy||reviewBusy&&!reviewLoading)return;
        const next=reviewIndex+delta;if(next<0||next>=reviewQueue.length)return;
        reviewIndex=next;await showReview();
    }
    async function leaveReview(){
        if(listBusy)return;
        if(reviewLoading){
            ++reviewVersion;reviewIndex=-1;reviewClip=null;reviewBusy=reviewLoading=false;
            reviewPanels(false);render();message('Loading dismissed. You can browse and edit your lists while the open request finishes.');return;
        }
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
    function listRows(){
        if(listMode==='queue')return (library?.queue?.items||[]).filter(row=>!aside(row)&&!['approved','skipped'].includes(row.state)).map(row=>({...row,item:{id:row.id}}));
        return listMode==='aside'?Object.values(library?.set_aside||{}).map(row=>({...row,item:{id:row.id}})):reviewQueue;
    }
    function showReviewList(mode){
        listMode=mode;listSelected.clear();listSignature='';$('cv-list-status').textContent='';
        (mode==='review'?$('cv-review-panel'):$('cv-queue-panel')).before(reviewList);
        reviewList.hidden=false;renderReviewList();reviewList.scrollIntoView({block:'nearest'});
    }
    function renderReviewList(){
        if(reviewList.hidden)return;
        const rows=listRows(),ids=new Set(rows.map(row=>row.item.id));
        for(const id of listSelected)if(!ids.has(id))listSelected.delete(id);
        $('cv-list-title').textContent=listMode==='aside'?'Set-aside clips':'Edit review list';
        $('cv-list-apply').textContent=listMode==='aside'?'Return selected to review':'Set aside selected';
        $('cv-list-apply').disabled=listBusy||!listSelected.size||library?.set_aside===undefined;
        $('cv-list-count').textContent=`${listSelected.size} selected · ${rows.length} clips`;
        $('cv-list-all').disabled=listBusy||!rows.length;
        $('cv-list-all').checked=!!rows.length&&rows.every(row=>listSelected.has(row.item.id));
        $('cv-list-all').indeterminate=!!listSelected.size&&!$('cv-list-all').checked;
        if(library?.set_aside===undefined)$('cv-list-status').textContent='Saved lists become available after the next ComfyUI restart.';
        const signature=JSON.stringify([listMode,rows.map(row=>[row.item.id,row.clip,row.name,row.category]),[...listSelected],reviewIndex,listBusy]);
        if(signature===listSignature)return;listSignature=signature;
        $('cv-list-rows').replaceChildren(...rows.map((row,index)=>{
            const li=document.createElement('li'),label=document.createElement('label'),check=document.createElement('input'),text=document.createElement('span');
            li.dataset.id=row.item.id;check.type='checkbox';check.checked=listSelected.has(row.item.id);check.disabled=listBusy;
            check.onchange=()=>{if(check.checked)listSelected.add(row.item.id);else listSelected.delete(row.item.id);renderReviewList();};
            const entry=copies(row.item).find(e=>e.id===row.clip)||copies(row.item)[0];
            text.textContent=entry?.name.split('/').at(-1)||row.name||[row.item.username,row.item.id].filter(Boolean).join(' · ');
            const detail=document.createElement('small');detail.textContent=[listMode==='review'&&index===reviewIndex?'Current clip':'',row.category||entry?.category||'',entry?.processed?'Draft / script ready':''].filter(Boolean).join(' · ');
            label.append(check,text);li.append(label,detail);
            if(listMode==='aside'){
                const open=document.createElement('button');open.textContent='Open manually';open.disabled=listBusy;
                open.onclick=()=>{reviewList.hidden=true;startReview([{...row,manual:true}]).catch(error=>message(error.message,true));};li.append(open);
            }
            return li;
        }));
    }
    async function setAside(rows){
        if(listBusy||!rows.length)return;
        listBusy=true;for(const row of rows)settingAside.add(row.item.id);renderReviewList();reviewControls();
        const ids=new Set(rows.map(row=>row.item.id)),currentRow=reviewQueue[reviewIndex];let openNext=false;
        try{
            // Save current edits before removing an open clip. A pending open
            // already saves the previous clip through the host's normal flow.
            if(currentRow&&ids.has(currentRow.item.id)&&!reviewLoading){
                const state=reviewState();
                if(reviewClip&&state.entry?.id===reviewClip&&!state.entry.processing&&!state.processing)await openClip(reviewClip);
            }
            library.queue=await api('queue',{action:'set_aside',items:rows.map(row=>({id:row.item.id,clip:row.clip,category:row.category||'',site:row.site||$('cv-site').value}))});
            // Update the visible list without waiting for another library scan.
            library.set_aside||={};for(const row of rows)library.set_aside[row.item.id]={id:row.item.id,clip:row.clip,name:row.name,category:row.category,site:row.site||$('cv-site').value};
            for(const id of ids){selected.delete(id);listSelected.delete(id);}
            const nextIndex=reviewQueue.slice(0,reviewIndex).filter(row=>!ids.has(row.item.id)).length;
            reviewQueue=reviewQueue.filter(row=>!ids.has(row.item.id));
            if(currentRow&&ids.has(currentRow.item.id)){
                ++reviewVersion;reviewBusy=reviewLoading=false;reviewClip=null;reviewIndex=Math.min(nextIndex,reviewQueue.length-1);
                reviewMode(reviewIndex>=0,null);
            }else if(currentRow)reviewIndex=reviewQueue.indexOf(currentRow);
            render();
            $('cv-list-status').textContent=`${rows.length} clips set aside. Videos, drafts and category choices are kept.`;
            if(currentRow&&ids.has(currentRow.item.id)){
                if(reviewIndex>=0)openNext=true;
                else{reviewPanels(false);render();message('Review list finished. Set-aside clips are available from the browser.');}
            }
        }finally{for(const id of ids)settingAside.delete(id);listBusy=false;renderReviewList();reviewControls();}
        if(openNext)void showReview().catch(error=>message(error.message,true));
    }
    $('cv-edit-review').onclick=()=>showReviewList('review');
    $('cv-aside').onclick=()=>showReviewList('aside');
    $('cv-list-close').onclick=()=>{reviewList.hidden=true;};
    $('cv-list-all').onchange=()=>{listSelected.clear();if($('cv-list-all').checked)for(const row of listRows())listSelected.add(row.item.id);renderReviewList();};
    function metadataControls(){
        const data=library?.metadata,job=data?.job,active=['running','stopping'].includes(job?.stage);
        $('cv-metadata-fill').disabled=$('cv-metadata-refresh').disabled=metadataBusy||active||!data||!data.total;
        $('cv-metadata-stop').disabled=metadataBusy||!active;
        $('cv-metadata-status').textContent=!data?'Restart ComfyUI to enable saved metadata and recovery.':`${data.known} / ${data.total} local video IDs have saved metadata${job?.stage&&job.stage!=='idle'?` · ${job.stage}: ${job.completed} / ${job.total} checked${job.skipped?' · '+job.skipped+' already saved':''}`:''}${job?.errors?.length?'\n'+job.errors.map(e=>`${e.id}: ${e.error}`).join('\n'):''}`;
    }
    $('cv-metadata-toggle').onclick=()=>{const show=$('cv-metadata-panel').hidden;$('cv-metadata-panel').hidden=!show;$('cv-metadata-toggle').setAttribute('aria-expanded',String(show));};
    for(const [id,action,force]of [['cv-metadata-fill','metadata_start',false],['cv-metadata-refresh','metadata_start',true],['cv-metadata-stop','metadata_stop',false]])$(id).onclick=async()=>{
        if(metadataBusy)return;metadataBusy=true;metadataControls();
        try{const job=await api(action,{site:$('cv-site').value,force});library.metadata.job=job;metadataControls();message(action==='metadata_stop'?'Metadata update will stop after this batch.':job.total?'Metadata recovery started. Progress is shown in Library metadata.':'All local video IDs already have saved metadata.');}
        catch(error){message(error.message,true);}finally{metadataBusy=false;metadataControls();}
    };
    const handle=fn=>()=>Promise.resolve().then(fn).catch(error=>message(error.message,true));
    $('cv-resume').onclick=handle(()=>startReview(Object.entries(library.items).flatMap(([id,entries])=>{
        const entry=entries.find(e=>e.civitai_temporary&&e.status!=='ignored');return entry&&!aside({id})?[{item:{id},clip:entry.id,category:entry.category}]:[];
    })));
    $('cv-review-add-category').onclick=handle(async()=>{
        const name=$('cv-review-new-category').value.trim();acceptLibrary(await api('category',{name}));
        choices($('cv-review-category'),name);reviewQueue[reviewIndex].category=name;$('cv-review-new-category').value='';reviewControls();
    });
    $('cv-back').onclick=handle(leaveReview);
    $('cv-set-aside').onclick=handle(()=>setAside([reviewQueue[reviewIndex]]));
    $('cv-list-apply').onclick=handle(async()=>{
        const rows=listRows().filter(row=>listSelected.has(row.item.id));
        if(listMode!=='aside')return setAside(rows);
        listBusy=true;renderReviewList();
        try{
            await api('queue',{action:'restore_review',items:rows.map(row=>({id:row.item.id}))});
            for(const row of rows){delete library.set_aside[row.item.id];selected.set(row.item.id,row);}
            listSelected.clear();await refresh();
            $('cv-list-status').textContent=`${rows.length} clips returned and selected in the browser. Choose Review selected or Add selected to queue.`;
        }finally{listBusy=false;renderReviewList();}
    });
    $('cv-retry-open').onclick=handle(showReview);
    $('cv-previous').onclick=handle(()=>advance(-1));$('cv-next').onclick=handle(()=>advance());
    $('cv-later').onclick=handle(()=>reviewIndex+1<reviewQueue.length?advance():leaveReview());
    $('cv-approve').onclick=handle(()=>decision('approve'));$('cv-reject').onclick=handle(()=>decision('reject'));
    $('cv-process-one').onclick=handle(async()=>{await processClips([reviewClip]);message('Automatic processing queued.');reviewControls();});
    $('cv-review-category').onchange=()=>{reviewQueue[reviewIndex].category=$('cv-review-category').value;reviewControls();};
    $('cv-browse').onclick=handle(()=>browse());$('cv-more').onclick=handle(nextPage);$('cv-refresh').onclick=handle(refresh);
    $('cv-next-page').onclick=handle(nextPage);
    $('cv-prev-page').onclick=()=>{if(loading||busy||pageIndex===0)return;pageIndex--;render();pageTop();};
    $('cv-navigation').onchange=()=>{
        const first=[...cards.values()].find(card=>card.getBoundingClientRect().bottom>150)?.dataset.id;
        if(paged())pageIndex=$('cv-view').value==='local'?Math.max(0,Math.floor(visible().findIndex(item=>item.id===first)/48)):Math.max(0,pages.findIndex(page=>page.items.some(item=>item.id===first)));
        else if($('cv-view').value==='local')localLimit=Math.max(localLimit,(pageIndex+1)*48);
        autoPaused=false;preference();render();
    };
    $('cv-gallery-back').onclick=backGallery;
    $('cv-view').onchange=()=>{gallery=null;trail.length=0;++generation;loading=false;items=[];resetPages();preference();if($('cv-view').value==='local')localItems();render();message($('cv-view').value==='local'?'Your existing downloads are ready.':'Choose sorting and click Browse videos.');};
    $('cv-filter').onchange=()=>{if($('cv-filter').value==='processed')$('cv-hide-done').checked=false;if($('cv-view').value==='local')pageIndex=0;preference();render();};
    $('cv-hide-done').onchange=()=>{if($('cv-hide-done').checked&&$('cv-filter').value==='processed')$('cv-filter').value='all';if($('cv-view').value==='local')pageIndex=0;preference();render();};
    $('cv-category').onchange=()=>{for(const value of selected.values())value.category=$('cv-category').value;preference();render();};
    for(const id of ['cv-site','cv-sort','cv-period','cv-ratings'])$(id).onchange=()=>{if(id==='cv-site'){gallery=null;trail.length=0;}resetPages();++generation;loading=false;if($('cv-view').value==='remote')items=[];preference();render();};
    $('cv-select-page').onchange=()=>{for(const item of displayedRows())if($('cv-select-page').checked)selected.set(item.id,{item,clip:cards.get(item.id)?.querySelector('select[aria-label="Local copy"]')?.value,category:cards.get(item.id)?.querySelector('select[aria-label^="Category"]')?.value||$('cv-category').value});else selected.delete(item.id);controls();};
    $('cv-clear').onclick=()=>{selected.clear();controls();};$('cv-stop').onclick=()=>{stop=true;$('cv-stop').disabled=true;message('Stopping after the current download.');};
    $('cv-download').onclick=handle(()=>download([...selected.values()]));$('cv-process').onclick=handle(()=>addQueue([...selected.values()]));$('cv-review').onclick=handle(()=>startReview([...selected.values()]));
    $('cv-category-form').onsubmit=event=>{
        event.preventDefault();if(categorySaving||busy)return;
        void handle(async()=>{
            const name=$('cv-new-category').value.trim();if(!name)throw new Error('Enter a category name first.');
            categorySaving=true;controls();message('Saving category…');
            try{acceptLibrary(await api('category',{name}));$('cv-category').value=name;for(const row of selected.values())row.category=name;$('cv-new-category').value='';$('cv-category-editor').open=false;preference();render();message(`Category saved: ${name}`);}
            finally{categorySaving=false;controls();}
        })();
    };
    $('cv-save-key').onclick=handle(async()=>{const token=$('cv-key').value.trim();if(!token)throw new Error('Enter a key before saving.');await api('key',{token});$('cv-key').value='';await refresh();message('API key saved on the server.');});
    $('cv-remove-key').onclick=handle(async()=>{await api('key',{token:''});$('cv-key').value='';await refresh();message('Saved key removed. An environment key, if configured, still applies.');});
    setInterval(async()=>{if(!active||polling||loading)return;polling=true;try{const value=await api();if(busy){library=value;controls();}else{acceptLibrary(value);const ids=displayedRows().map(row=>row.id);if($('cv-hide-done').checked&&JSON.stringify(ids)!==JSON.stringify([...cards.keys()]))render();else controls();}}catch{}finally{polling=false;}},3000);
    return {categoryNames:()=>library?.categories||[],async activate(){active=true;reviewMode(reviewIndex>=0,reviewClip);try{await refresh();}catch(error){message(error.message,true);}},deactivate(){active=false;reviewMode(false,null);for(const video of root.querySelectorAll('video'))video.pause();}};
}
