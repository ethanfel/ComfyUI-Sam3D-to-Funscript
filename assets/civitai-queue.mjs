// Queue controls stay separate from gallery selection and manual approval.
export function civitaiQueue(root,{change,start,review,edit,setAside,thumbnail,error}){
    root.innerHTML=`<details class="cv-queue" open><summary>Processing queue · <span data-count>Empty</span></summary>
    <p class="hint">Download if needed → generate draft funscript → review and approve into a category.</p>
    <div class="controls"><button data-start class="primary">Start queue</button><button data-pause>Pause after current clip</button><button data-review>Review ready clips</button><button data-edit-review>Edit review list</button><button data-clear>Clear finished</button></div>
    <p data-status role="status"></p><ol class="cv-queue-list"></ol></details>`;
    const $=key=>root.querySelector(`[data-${key}]`),list=root.querySelector('ol');
    const labels={waiting:'Waiting',downloading:'Downloading',processing:'Generating funscript',ready:'Ready for review',approved:'Approved',error:'Failed',interrupted:'Interrupted',deferred:'Open for review',skipped:'Skipped'};
    let queue={stage:'idle',items:[]},busy=false,signature='';
    async function action(fn){if(busy)return;busy=true;buttons();try{await fn();}catch(e){error(e.message);}finally{busy=false;buttons();}}
    function buttons(){
        const running=['queued','running'].includes(queue.stage),waiting=queue.items.some(i=>i.state==='waiting');
        $('start').disabled=busy||running||!waiting;$('start').textContent=['paused','interrupted'].includes(queue.stage)?'Resume queue':'Start queue';
        $('pause').disabled=busy||!running||queue.pause;$('pause').textContent=queue.pause&&running?'Pausing after current clip…':'Pause after current clip';
        $('review').disabled=busy||!queue.items.some(i=>i.state==='ready'&&i.clip);
        $('edit-review').disabled=!edit||!queue.items.some(i=>!['approved','skipped'].includes(i.state));
        $('clear').disabled=busy||!queue.items.some(i=>['ready','approved','skipped'].includes(i.state));
        for(const button of list.querySelectorAll('button'))button.disabled=busy;
    }
    $('start').onclick=()=>action(start);$('pause').onclick=()=>action(()=>change('pause'));
    $('clear').onclick=()=>action(()=>change('clear_finished'));
    $('review').onclick=()=>action(()=>review(queue.items.filter(i=>i.state==='ready'&&i.clip)));
    $('edit-review').onclick=()=>edit();
    return {update(value){
        queue=value||{stage:'idle',items:[]};
        const next=JSON.stringify(queue);if(next===signature){buttons();return;}signature=next;
        const counts=Object.fromEntries(Object.keys(labels).map(state=>[state,queue.items.filter(i=>i.state===state).length]));
        $('count').textContent=`${counts.waiting} waiting · ${counts.downloading+counts.processing} active · ${counts.ready} ready · ${counts.error+counts.interrupted+counts.deferred} need attention`;
        $('status').textContent=queue.error||({idle:'Select clips, add them here, then start the queue.',queued:'Queued in ComfyUI. You can close the workspace once the job is accepted.',running:'Processing in the background. You can add more clips or review finished drafts.',paused:'Paused. Finished drafts and waiting clips are kept.',interrupted:'Interrupted. Retry interrupted clips, then resume the queue.',complete:'Queue finished. Review your drafts, or add more clips.'}[queue.stage]||'');
        list.replaceChildren(...queue.items.map((item,index)=>{
            const row=document.createElement('li');row.dataset.state=item.state;
            const number=document.createElement('span');number.textContent=String(index+1);row.append(number);
            if(item.clip){const image=document.createElement('img');image.src=thumbnail(item.clip);image.loading='lazy';image.alt='';row.append(image);}
            const description=document.createElement('div'),title=document.createElement('strong'),state=document.createElement('span'),note=document.createElement('small');
            title.textContent=item.name.split('/').at(-1);title.title=item.name;state.textContent=labels[item.state]||item.state;note.textContent=item.error||item.note||(item.category?'Approve into '+item.category:'Choose a category when approving');description.append(title,state,note);row.append(description);
            const controls=document.createElement('div');controls.className='controls';
            function button(label,fn){const b=document.createElement('button');b.textContent=label;b.onclick=()=>action(fn);controls.append(b);}
            if(['ready','approved'].includes(item.state)&&item.clip)button('Review',()=>review([item]));
            if(['error','interrupted','deferred'].includes(item.state))button('Retry',()=>change('retry',item.key));
            if(item.state==='waiting')button('Do next',()=>change('first',item.key));
            if(setAside&&queue.set_aside_available&&!['downloading','processing'].includes(item.state))button('Set aside',()=>setAside([item]));
            if(!['downloading','processing'].includes(item.state))button('Remove',()=>change('remove',item.key));
            row.append(controls);return row;
        }));buttons();
    }};
}
