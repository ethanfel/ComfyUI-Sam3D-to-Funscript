import {decodeBeatAudio,analyzeBeatAudio} from "./audio-analysis.mjs";
import {BEAT_SHAPES,beatGrid,generateBeatSection} from "./audio-patterns.mjs";

export function audioLane({$,context,change,copyToMain,selectRange,seek,render,wheel,readVideoAudio}){
    let selected='',draft=null,busy=false,cancel=false,drag=null,layer=null,loadedProject=null,loadedMix=null,job=0;
    let audioRequest=null;
    const canvas=$('beatCurve'),message=text=>{$('beatStatus').textContent=text;};
    $('beatShape').replaceChildren(...BEAT_SHAPES.map(name=>new Option(name,name)));$('beatShape').value='Smooth Bounce';
    const options=()=>({mode:$('beatMode').value,shape:$('beatShape').value,timing:$('beatTiming').value,bpm:$('beatBpm').valueAsNumber,
        beatsPerCycle:Number($('beatCycle').value),amplitude:$('beatAmplitude').valueAsNumber,center:$('beatCenter').valueAsNumber,
        followEnergy:$('beatEnergy').checked,seed:$('beatSeed').valueAsNumber,association:$('beatUseMix').checked?'dual':'beats',beatLanding:$('beatLanding').value});
    const key=()=>{const c=context();return JSON.stringify([c.revision,c.selection,options(),selected]);};
    function loadOptions(settings){for(const [id,k] of [['beatMode','mode'],['beatShape','shape'],['beatTiming','timing'],['beatBpm','bpm'],['beatCycle','beatsPerCycle'],['beatAmplitude','amplitude'],['beatCenter','center'],['beatSeed','seed']])if(settings[k]!==undefined)$(id).value=settings[k];$('beatEnergy').checked=settings.followEnergy!==false;$('beatUseMix').checked=settings.association==='dual'&&!!context().audio?.mix;$('beatLanding').value=settings.beatLanding??(settings.peakOnBeat?'up':'shape');}
    function discard(){draft=null;layer=null;}
    function pick(id){
        const c=context(),section=c.audio?.sections.find(s=>s.id===id);selected=section?.id||'';discard();
        if(section){loadOptions(section.settings);selectRange(section.start,section.end);message(section.summary+' · Edit settings and preview to replace this block.');}
        render();
    }
    $('beatSection').onchange=()=>pick($('beatSection').value);
    $('beatNew').onclick=()=>{selected='';discard();message('Mark a range, preview a pattern, then save a new block.');render();};
    $('beatWhole').onclick=()=>{const c=context();if(c.project)selectRange(0,c.duration);};
    for(const id of ['beatStart','beatEnd'])$(id).onchange=()=>{
        const start=$('beatStart').valueAsNumber*1000,end=$('beatEnd').valueAsNumber*1000;
        if(!context().project||!Number.isFinite(start)||!Number.isFinite(end))return;
        selectRange(start,end);
    };
    $('beatCancelAnalysis').onclick=()=>{cancel=true;audioRequest?.abort();message('Cancelling audio analysis…');};
    const loadAudio=async(fullMix,input,fromVideo=false)=>{
        const c=context();if(!c.project||busy||fullMix&&!c.audio)return;
        const owner=c.project,token=++job,videoKey=c.videoAudioKey;
        busy=true;cancel=false;audioRequest=new AbortController();discard();message(fromVideo?'Reading the video soundtrack…':'Decoding audio…');render();
        const cancelled=()=>cancel||token!==job||context().project!==owner||fromVideo&&context().videoAudioKey!==videoKey;
        try{
            const {file,offset_ms}=await input(audioRequest.signal);
            if(cancelled())throw new Error('Audio import cancelled because the video or project changed.');
            const {samples,sampleRate}=await decodeBeatAudio(file);
            const analysis=await analyzeBeatAudio(samples,sampleRate,{character:fullMix,cancelled,
                progress:p=>message(`Analyzing ${fullMix?'full-mix energy and texture':'beats'} · ${Math.round(p*100)}%`)});
            if(cancelled())return;
            const prior=context().audio;
            const data={name:file.name,size:file.size,last_modified:file.lastModified,analysis};
            if(fullMix){
                change({...prior,mix:{...data,offset_ms:offset_ms??prior.mix?.offset_ms??prior.offset_ms}});$('beatUseMix').checked=true;
                message((fromVideo?'Video soundtrack loaded and aligned. ':'Full mix ready. ')+'Drum timing is retained; preview a section to update its shape and energy. Saved blocks stay unchanged.');
            }else{
                change({...prior,version:1,...data,offset_ms:prior?.offset_ms??-(owner.metadata.source_origin_ms||0),sections:prior?.sections||[]});
                $('beatBpm').value=analysis.bpm||120;selected='';
                message(analysis.beats.length?`${analysis.beats.length} beat markers · ${analysis.onsets.length} drum hits · ${analysis.bpm} BPM estimate. Review alignment; half/double tempo may fit better.`:'No clear beat found. Try a drum stem, Drum peaks, or a Tempo grid.');
            }
        }catch(error){message(cancel?'Audio analysis cancelled.':error.message);}finally{busy=false;audioRequest=null;render();}
    };
    $('beatFile').onchange=$('beatMixFile').onchange=event=>{
        const file=event.target.files[0],fullMix=event.target.id==='beatMixFile';event.target.value='';if(file)loadAudio(fullMix,async()=>({file}));
    };
    $('beatFromVideo').onclick=()=>loadAudio(true,readVideoAudio,true);
    $('beatRemoveMix').onclick=()=>{
        const c=context();if(!c.audio?.mix||busy)return;const {mix,...audio}=c.audio;discard();$('beatUseMix').checked=false;change(audio);
        message('Full mix removed. Saved blocks stay unchanged; new suggestions use drum analysis.');
    };
    $('beatMixOffset').onchange=()=>{
        const c=context(),offset=$('beatMixOffset').valueAsNumber;if(!c.audio?.mix||!Number.isFinite(offset))return;
        discard();change({...c.audio,mix:{...c.audio.mix,offset_ms:offset}});message('Full-mix alignment changed. Drum timing and saved blocks stay unchanged.');
    };
    $('beatOffset').onchange=()=>{
        const c=context(),offset=$('beatOffset').valueAsNumber;
        if(!c.audio||!Number.isFinite(offset))return;discard();change({...c.audio,offset_ms:offset});
        message('Audio markers shifted. Saved pattern blocks keep their timing; preview a block to regenerate it.');
    };
    $('beatPreview').onclick=()=>{
        const c=context();if(!c.audio||busy)return;
        try{const result=generateBeatSection(c.audio,...c.selection,options());draft={...result,key:key()};layer=null;message(result.summary+' · Preview only.');render();}
        catch(error){discard();message(error.message);render();}
    };
    $('beatDiscard').onclick=()=>{discard();message('Preview discarded.');render();};
    $('beatShuffle').onclick=()=>{$('beatSeed').value=(Number($('beatSeed').value)+1)>>>0;discard();$('beatPreview').click();};
    $('beatSave').onclick=()=>{
        const c=context();if(!draft||draft.key!==key()||busy)return;
        const collision=c.audio.sections.find(s=>s.id!==selected&&s.start<draft.end&&s.end>draft.start);
        if(collision){message('This overlaps another audio block. Select that block to replace it, or choose a free range.');return;}
        let n=0;while(c.audio.sections.some(s=>s.id===`beat_${n}`))n++;
        const id=selected||`beat_${n}`,{key:_,...result}=draft;
        const section={...result,id,audio_name:c.audio.name,...(result.settings.association==='dual'&&c.audio.mix?{mix_name:c.audio.mix.name}:{})};
        selected=id;discard();change({...c.audio,sections:[...c.audio.sections.filter(s=>s.id!==id),section].sort((a,b)=>a.start-b.start)});
        message('Audio block saved. Use block in Main to include it in the device preview and export.');
    };
    $('beatRemove').onclick=()=>{
        const c=context();if(!selected||busy)return;const id=selected;selected='';discard();
        change({...c.audio,sections:c.audio.sections.filter(s=>s.id!==id)});
        message('Audio block removed. Copies already in Main stay editable; remove those through Applied patterns or Undo.');
    };
    $('beatCopy').onclick=()=>{
        const c=context(),section=c.audio?.sections.find(s=>s.id===selected);if(!section)return;
        try{copyToMain(section);message(`Audio block copied to Main ${c.axis}. Undo restores the previous curve.`);}catch(error){message(error.message);}render();
    };
    for(const id of ['beatMode','beatShape','beatTiming','beatBpm','beatCycle','beatAmplitude','beatCenter','beatSeed','beatEnergy','beatUseMix','beatLanding'])$(id).onchange=()=>{discard();render();};
    function controls(c){
        if(loadedProject!==c.project){loadedProject=c.project;discard();$('beatUseMix').checked=!!c.audio?.mix;}
        if(selected&&!c.audio?.sections.some(s=>s.id===selected))selected='';
        if(draft&&draft.key!==key())discard();
        const sections=c.audio?.sections||[],signature=JSON.stringify(sections.map(s=>[s.id,s.start,s.end,s.summary]));
        if($('beatSection').dataset.signature!==signature){$('beatSection').replaceChildren(new Option('New block',''),...sections.map(s=>new Option(`${(s.start/1000).toFixed(2)}–${(s.end/1000).toFixed(2)} s · ${s.settings.mode==='manual'?s.settings.shape:s.settings.mode}`,s.id)));$('beatSection').dataset.signature=signature;}
        $('beatSection').value=selected;
        $('beatAudioInfo').textContent=c.audio?`${c.audio.name} · ${(c.audio.analysis.duration_ms/1000).toFixed(2)} s · ${c.audio.analysis.bpm||'?'} BPM estimate`:'Choose an isolated drum stem or music file';
        const mix=c.audio?.mix;
        if(mix&&!loadedMix)$('beatUseMix').checked=true;loadedMix=mix;
        $('beatMixInfo').textContent=mix?`${mix.name} · ${(mix.analysis.duration_ms/1000).toFixed(2)} s${Math.abs(mix.analysis.duration_ms-c.audio.analysis.duration_ms)>1000?' · Different lengths: check offsets; uncovered phrases use drums only.':''}`:'Optional: full mix guides shape and energy; the drum stem keeps timing.';
        for(const id of ['beatRemoveMix','beatMixOffset','beatUseMix'])$(id).disabled=busy||!mix;
        $('beatMixFile').disabled=busy||!c.audio;
        $('beatFromVideo').disabled=busy||!c.audio||!c.videoAudioKey;
        $('beatFromVideo').title=!c.audio?'Choose a beat track first.':!c.videoAudioKey?'Open the source video in the preview first.':'Analyze the source soundtrack, using the original video for stabilized previews.';
        if(!mix)$('beatUseMix').checked=false;
        if(document.activeElement!==$('beatMixOffset'))$('beatMixOffset').value=mix?.offset_ms||0;
        if(document.activeElement!==$('beatOffset'))$('beatOffset').value=c.audio?.offset_ms||0;
        const decisions=(draft||sections.find(s=>s.id===selected))?.decisions||[],decisionKey=JSON.stringify(decisions);
        $('beatExplanation').hidden=!decisions.length;
        if($('beatDecisions').dataset.signature!==decisionKey){
            $('beatDecisions').replaceChildren(...decisions.map(d=>{const item=document.createElement('li');item.textContent=`${(d.start/1000).toFixed(2)}–${(d.end/1000).toFixed(2)} s · ${d.shape} · ${d.reason}`;return item;}));
            $('beatDecisions').dataset.signature=decisionKey;
        }
        const valid=c.audio&&c.selection[1]>c.selection[0]&&c.selection[0]>=0&&c.selection[1]<=c.duration;
        for(const [id,value]of [['beatStart',c.selection[0]],['beatEnd',c.selection[1]]]){
            $(id).disabled=busy||!c.project;$(id).max=(c.duration/1000).toFixed(3);
            if(document.activeElement!==$(id))$(id).value=(value/1000).toFixed(3);
        }
        $('beatWhole').disabled=busy||!c.project;
        $('beatRangeHint').textContent=busy?'Analyzing audio…':!c.audio?'Choose beat audio to begin.':
            !valid?'Select whole video, enter In / Out here, or Shift-drag the waveform.':
            draft?'Preview ready · save the block, then use it in Main to include it in the export.':
            selected?`Saved block · ${c.mainLocked?`unlock Main ${c.axis} to use it`:`use it in Main ${c.axis} to include it in the export`}.`:
            `${(c.selection[0]/1000).toFixed(3)}–${(c.selection[1]/1000).toFixed(3)} s selected · click Generate preview.`;
        if(c.audio&&c.audio.analysis.version<2&&!busy)$('beatRangeHint').textContent+=' Choose beat audio again once to refine the drum-peak timing.';
        $('beatPreview').disabled=busy||!valid;$('beatSave').disabled=busy||!draft;
        $('beatPreview').title=valid?'Generate a temporary motion curve for this range.':$('beatRangeHint').textContent;
        $('beatSave').textContent=selected?'Replace selected block':'Save new block';
        $('beatDiscard').disabled=!draft;$('beatRemove').disabled=busy||!selected;
        $('beatCopy').disabled=busy||!selected||!!draft||c.mainLocked;
        $('beatCopy').textContent=`Use block in Main ${c.axis}${c.mainLocked?' · locked':''}`;
        for(const id of ['beatFile','beatOffset','beatMode','beatTiming','beatCycle','beatAmplitude','beatCenter','beatEnergy','beatSection','beatNew','beatLanding'])$(id).disabled=busy||!c.project||(id!=='beatFile'&&!c.audio);
        $('beatShape').disabled=busy||$('beatMode').value!=='manual';$('beatBpm').disabled=busy||$('beatTiming').value!=='tempo';
        if(c.audio&&$('beatTiming').value!=='tempo')$('beatBpm').value=c.audio.analysis.bpm||120;
        $('beatSeed').disabled=$('beatShuffle').disabled=busy||$('beatMode').value!=='random';
        $('beatCancelAnalysis').hidden=!busy;
    }
    function draw(){
        const c=context();controls(c);const ratio=devicePixelRatio||1,w=canvas.clientWidth,h=210;
        if(!w)return;if(canvas.width!==Math.round(w*ratio)||canvas.height!==h*ratio){canvas.width=Math.round(w*ratio);canvas.height=h*ratio;layer=null;}
        const ctx=canvas.getContext('2d'),[start,end]=c.bounds,x=t=>42+(t-start)/(end-start)*(w-54),y=v=>174-v*1.1;
        const signature=JSON.stringify([w,ratio,start,end,selected,options().timing,options().bpm]);
        if(!layer||layer.audio!==c.audio||layer.draft!==draft||layer.signature!==signature){
            const surface=new OffscreenCanvas(canvas.width,canvas.height),p=surface.getContext('2d');p.scale(ratio,ratio);p.fillStyle='#172631';p.fillRect(0,0,w,h);p.font='11px system-ui';
            p.save();p.beginPath();p.rect(42,0,w-54,h);p.clip();
            if(c.audio){
                const a=c.audio.analysis,offset=c.audio.offset_ms||0;p.fillStyle='#486373';
                for(let pixel=0;pixel<w-54;pixel++){
                    const t=start+pixel/(w-54)*(end-start),next=start+(pixel+1)/(w-54)*(end-start);
                    const lo=Math.max(0,Math.floor((t-offset)/a.duration_ms*a.waveform.length)),hi=Math.min(a.waveform.length,Math.ceil((next-offset)/a.duration_ms*a.waveform.length));
                    let peak=0;for(let j=lo;j<hi;j++)peak=Math.max(peak,a.waveform[j]);p.fillRect(42+pixel,120-peak*40,1,peak*80);
                }
                if(c.audio.mix){
                    const {analysis:m,offset_ms:shift=0}=c.audio.mix;p.strokeStyle='#bd96dc';p.lineWidth=1;p.beginPath();
                    for(let pixel=0;pixel<w-54;pixel++){
                        const t=start+pixel/(w-54)*(end-start),next=start+(pixel+1)/(w-54)*(end-start);
                        const lo=Math.max(0,Math.floor((t-shift)/m.duration_ms*m.waveform.length)),hi=Math.min(m.waveform.length,Math.ceil((next-shift)/m.duration_ms*m.waveform.length));
                        let peak=0;for(let j=lo;j<hi;j++)peak=Math.max(peak,m.waveform[j]);p.lineTo(42+pixel,120-peak*55);
                    }p.stroke();
                }
                let grid=[];try{grid=beatGrid(c.audio,options());}catch{/* Keep the waveform while editing a tempo. */}
                let last=-Infinity;
                for(const beat of grid){const px=x(beat.at);if(px<42||px>w-12||px-last<3)continue;last=px;p.strokeStyle=beat.strength?'#eabf7188':'#60768955';p.beginPath();p.moveTo(px,35);p.lineTo(px,185);p.stroke();}
                for(const s of c.audio.sections){
                    p.fillStyle=s.id===selected?'#886b39':'#574d36';p.fillRect(x(s.start),3,x(s.end)-x(s.start),26);
                    p.save();p.beginPath();p.rect(x(s.start)+3,3,Math.max(0,x(s.end)-x(s.start)-6),26);p.clip();p.fillStyle='#fff0cd';p.fillText(s.settings.mode==='manual'?s.settings.shape:s.settings.mode==='random'?'Random patterns':'Suggested patterns',Math.max(45,x(s.start)+6),21);p.restore();
                    p.strokeStyle='#ffc875';p.lineWidth=2;p.beginPath();s.actions.forEach((v,i)=>{if(i)p.lineTo(x(v.at),y(v.pos));else p.moveTo(x(v.at),y(v.pos));});p.stroke();
                }
            }
            if(draft){p.strokeStyle='#ff91bc';p.lineWidth=2;p.setLineDash([5,3]);p.beginPath();draft.actions.forEach((v,i)=>{if(i)p.lineTo(x(v.at),y(v.pos));else p.moveTo(x(v.at),y(v.pos));});p.stroke();}
            p.restore();p.fillStyle='#93aabc';for(const v of [0,50,100])p.fillText(String(v),8,y(v));
            const tick=(end-start)/8;for(let i=0;i<=8;i++){const t=start+i*tick;p.fillText((t/1000).toFixed(end-start<10000?2:1)+'s',Math.min(w-40,x(t)),204);}
            layer={surface,audio:c.audio,draft,signature};
        }
        ctx.setTransform(1,0,0,1,0,0);ctx.drawImage(layer.surface,0,0);ctx.scale(ratio,ratio);
        ctx.save();ctx.beginPath();ctx.rect(42,0,w-54,h);ctx.clip();
        ctx.fillStyle='#78baf722';ctx.fillRect(x(c.selection[0]),30,x(c.selection[1])-x(c.selection[0]),155);
        ctx.strokeStyle='#f0f5fa';ctx.beginPath();ctx.moveTo(x(c.now),0);ctx.lineTo(x(c.now),185);ctx.stroke();ctx.restore();
    }
    const pointer=event=>{const c=context(),r=canvas.getBoundingClientRect();return Math.max(0,Math.min(c.duration,Math.round(c.bounds[0]+(event.clientX-r.left-42)/(r.width-54)*(c.bounds[1]-c.bounds[0]))));};
    canvas.addEventListener('wheel',event=>wheel(event,canvas),{passive:false});
    canvas.onpointerdown=event=>{
        if(event.button!==0||!context().project)return;const at=pointer(event),c=context();event.preventDefault();canvas.focus({preventScroll:true});
        if(event.shiftKey){drag=at;selectRange(at,at);if(event.isTrusted)canvas.setPointerCapture(event.pointerId);}
        else {const s=c.audio?.sections.find(s=>at>=s.start&&at<=s.end);if(s)pick(s.id);seek(at);}
    };
    canvas.onpointermove=event=>{if(drag!==null)selectRange(Math.min(drag,pointer(event)),Math.max(drag,pointer(event)));};
    for(const name of ['pointerup','pointercancel','lostpointercapture'])canvas.addEventListener(name,()=>{drag=null;});
    return {render:draw};
}
