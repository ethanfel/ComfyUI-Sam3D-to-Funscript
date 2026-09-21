import {decodeBeatAudio,analyzeBeatAudio} from "./audio-analysis.mjs";
import {BEAT_SHAPES,BEAT_CATALOG,BEAT_SOUNDS,assignBeatSounds,beatShapeValue,beatGrid,beatClicksWav,generateBeatSection,beatSectionBlocks,savedBeatSelection,editBeatSections} from "./audio-patterns.mjs";

export function audioLane({$,context,change,copyToMain,selectRange,seek,render,wheel,readVideoAudio,rulerTicks,formatTime,preferencesChanged=()=>{}}){
    let selected='',draft=null,busy=false,cancel=false,drag=null,layer=null,loadedProject=null,loadedMix=null,job=0;
    let audioRequest=null,selectionCache=null,blocksCache=null;
    let chosenBlocks=null,blockAnchor=null,blockSelectionScope=null,selectionPieces=null;
    let auditionURL=null,auditionKey=null,auditionKind=null,auditionGeneration=0;
    const canvas=$('beatCurve'),message=text=>{$('beatStatus').textContent=text;};
    const families=[...new Set(BEAT_CATALOG.map(p=>p.family))];
    $('beatSound').replaceChildren(...[...new Set(BEAT_SOUNDS.map(p=>p.group))].map(name=>{
        const group=document.createElement('optgroup');group.label=name;group.append(...BEAT_SOUNDS.filter(p=>p.group===name).map(p=>new Option(p.label,p.id)));return group;
    }));
    $('beatFamily').append(...families.map(name=>new Option(name,name)));
    $('beatShape').replaceChildren(...families.map(family=>{const group=document.createElement('optgroup');group.label=family;group.append(...BEAT_CATALOG.filter(p=>p.family===family).map(p=>new Option(p.name,p.name)));return group;}));$('beatShape').value='Smooth Bounce';
    const options=()=>({mode:$('beatMode').value,shape:$('beatShape').value,timing:$('beatTiming').value,bpm:$('beatBpm').valueAsNumber,
        beatsPerCycle:$('beatRhythm').value==='original'?Number($('beatCycle').value):1,amplitude:$('beatAmplitude').valueAsNumber/2,center:$('beatCenter').valueAsNumber,
        rhythm:$('beatRhythm').value,density:Number($('beatDensity').value),lowFocus:$('beatLowFocus').valueAsNumber/100,preserveSyncopation:$('beatSyncopation').checked,maxHitsPerSecond:$('beatMaxHits').valueAsNumber,
        patternFamily:$('beatFamily').value,followEnergy:$('beatEnergy').checked,seed:$('beatSeed').valueAsNumber,association:$('beatUseMix').checked?'dual':'beats',beatLanding:$('beatLanding').value});
    const key=()=>{const c=context();return JSON.stringify([c.revision,c.selection,options(),selected]);};
    function loadOptions(settings){
        for(const [id,k] of [['beatMode','mode'],['beatShape','shape'],['beatTiming','timing'],['beatBpm','bpm'],['beatCycle','beatsPerCycle'],['beatCenter','center'],['beatSeed','seed']])if(settings[k]!==undefined)$(id).value=settings[k];
        $('beatAmplitude').value=(settings.amplitude??40)*2;$('beatRhythm').value=settings.rhythm??'original';
        $('beatDensity').value=settings.density??1;$('beatLowFocus').value=(settings.lowFocus??.65)*100;
        $('beatSyncopation').checked=settings.preserveSyncopation!==false;$('beatMaxHits').value=settings.maxHitsPerSecond??3;
        $('beatFamily').value=settings.patternFamily??'all';
        $('beatEnergy').checked=settings.followEnergy!==false;$('beatUseMix').checked=settings.association==='dual'&&!!context().audio?.mix;$('beatLanding').value=settings.beatLanding??(settings.peakOnBeat?'up':'shape');
    }
    function stopAudition(){
        auditionGeneration++;auditionKind=null;
        const player=$('beatAudition');player.pause();player.removeAttribute('src');player.hidden=true;
        if(auditionURL){URL.revokeObjectURL(auditionURL);auditionURL=null;}auditionKey=null;
        $('beatPreviewSound').textContent='Preview sound';$('beatPreviewSound').setAttribute('aria-pressed','false');
    }
    async function playAudition(blob,label,kind='rhythm'){
        stopAudition();const generation=auditionGeneration,player=$('beatAudition');
        auditionURL=URL.createObjectURL(blob);auditionKey=key();auditionKind=kind;player.src=auditionURL;player.hidden=false;
        if(kind==='sample'){$('beatPreviewSound').textContent='Stop preview';$('beatPreviewSound').setAttribute('aria-pressed','true');}
        $('video').pause();message(label);
        try{await player.play();}
        catch(error){if(generation===auditionGeneration){stopAudition();message(error.message);}}
    }
    function discard(){draft=null;layer=null;stopAudition();}
    const blockKey=s=>JSON.stringify([s.id,s.start,s.end]);
    const selectionScope=c=>JSON.stringify([c.active,c.selectionLane,...c.selection]);
    function clearBlocks(){chosenBlocks=null;blockAnchor=null;blockSelectionScope=null;selectionPieces=null;}
    function savedRanges(c){
        const ranges=[];
        for(const [start,end]of chosenBlocks===null?[c.selection]:chosenBlocks.map(s=>[s.start,s.end])){
            if(ranges.length&&ranges.at(-1)[1]===start)ranges.at(-1)[1]=end;
            else ranges.push([start,end]);
        }
        const signature=JSON.stringify(ranges);
        if(selectionCache?.sections!==c.audio?.sections||selectionCache?.signature!==signature){
            const value=ranges.map(([start,end])=>savedBeatSelection(c.audio?.sections||[],start,end));
            selectionCache={sections:c.audio?.sections,signature,value:value.every(Boolean)?value:[]};
        }
        return selectionCache.value;
    }
    function blocks(c){
        if(blocksCache?.sections!==c.audio?.sections||blocksCache?.sources!==c.sources||blocksCache?.cuts!==c.cuts)
            blocksCache={sections:c.audio?.sections,sources:c.sources,cuts:c.cuts,value:beatSectionBlocks(c.audio?.sections||[],c.sources,c.cuts)};
        return blocksCache.value;
    }
    function pick(id,range=null){
        const c=context(),section=c.audio?.sections.find(s=>s.id===id);selected=section?.id||'';clearBlocks();discard();
        if(section){loadOptions(section.settings);selectRange(...(range||[section.start,section.end]));message(section.summary+' · Copy or replace the selected range.');}
        render();
    }
    function pickBlock(block,event){
        const c=context(),pieces=blocks(c),key=blockKey(block),toggle=event.ctrlKey||event.metaKey;
        const anchor=blockAnchor&&pieces.find(s=>blockKey(s)===blockAnchor);
        let next,origin=key;
        if(event.shiftKey&&anchor){
            const a=pieces.indexOf(anchor),b=pieces.indexOf(block),range=pieces.slice(Math.min(a,b),Math.max(a,b)+1);
            next=toggle?[...(chosenBlocks||[]),...range]:range;origin=blockAnchor;
        }else if(toggle){
            const before=chosenBlocks||[];
            next=before.some(s=>blockKey(s)===key)?before.filter(s=>blockKey(s)!==key):[...before,block];
        }else next=[block];
        next=[...new Map(next.map(s=>[blockKey(s),s])).values()].sort((a,b)=>a.start-b.start);
        selected=next.some(s=>blockKey(s)===key)?block.id:next.at(-1)?.id||'';
        const section=c.audio?.sections.find(s=>s.id===selected);if(section)loadOptions(section.settings);
        discard();selectRange(next[0]?.start??block.start,next.at(-1)?.end??block.start);
        chosenBlocks=next;blockAnchor=origin;blockSelectionScope=selectionScope(context());selectionPieces=blocks(context());
        message(next.length>1?`${next.length} audio blocks selected. Copy them to Main together; unselected intervals stay unchanged.`:
            next.length?'Audio block selected. Shift-click another label for a range; Ctrl/Cmd-click toggles individual blocks.':'No audio blocks selected.');
        render();
    }
    $('beatSection').onchange=()=>pick($('beatSection').value);
    $('beatNew').onclick=()=>{selected='';clearBlocks();discard();message('Mark a range, preview a pattern, then save a new block.');render();};
    $('beatWhole').onclick=()=>{const c=context();clearBlocks();if(c.project)selectRange(0,c.duration);};
    for(const id of ['beatStart','beatEnd'])$(id).onchange=()=>{
        const start=$('beatStart').valueAsNumber*1000,end=$('beatEnd').valueAsNumber*1000;
        if(!context().project||!Number.isFinite(start)||!Number.isFinite(end))return;
        clearBlocks();selectRange(start,end);
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
        const c=context();if(!c.audio||busy||chosenBlocks?.length>1)return;
        try{stopAudition();const result=generateBeatSection(c.audio,...c.selection,options());draft={...result,key:key()};layer=null;message(result.summary+' · Preview only.');render();}
        catch(error){discard();message(error.message);render();}
    };
    $('beatDiscard').onclick=()=>{discard();message('Preview discarded.');render();};
    $('beatAutoMatch').onclick=()=>{$('beatMode').value='waveform';discard();$('beatPreview').click();};
    $('beatShuffle').onclick=()=>{$('beatSeed').value=(Number($('beatSeed').value)+1)>>>0;discard();$('beatPreview').click();};
    $('beatSave').onclick=()=>{
        const c=context();if(!draft||draft.key!==key()||busy)return;
        try{
            const {key:_,...result}=draft;
            const section={...result,audio_name:c.audio.name,...(result.settings.association==='dual'&&c.audio.mix?{mix_name:c.audio.mix.name}:{})};
            const edited=editBeatSections(c.audio.sections,selected,result.start,result.end,section);
            selected=edited.selected;clearBlocks();discard();change({...c.audio,sections:edited.sections});
            message('Audio range saved. Use selection in Main to include it in the device preview and export.');
        }catch(error){message(error.message);}
    };
    $('beatRemove').onclick=()=>{
        const c=context();if(!selected||busy)return;
        try{
            const edited=editBeatSections(c.audio.sections,selected,...c.selection);selected='';clearBlocks();discard();change({...c.audio,sections:edited.sections});
            message('Selected audio range removed. Copies already in Main stay editable; remove those through Applied patterns or Undo.');
        }catch(error){message(error.message);}
    };
    $('beatCopy').onclick=()=>{
        const c=context(),sections=savedRanges(c);if(!sections.length||draft||busy)return;
        const label=chosenBlocks?.length>1?`${chosenBlocks.length} audio blocks`:'Selected audio range';
        try{copyToMain(sections);message(`${label} copied to Main ${c.axis}. Undo restores the whole transfer.`);}catch(error){message(error.message);}render();
    };
    function audition(c){
        const ranges=draft?[draft]:savedRanges(c);
        if(!ranges.length||ranges.some(s=>!s.events))return null;
        const events=ranges.flatMap(s=>s.events);if(!events.length)return null;
        return {start:ranges[0].start,end:ranges.at(-1).end,events,ranges:ranges.map(s=>[s.start,s.end])};
    }
    function download(blob,filename){
        const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=filename;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    }
    $('beatPreviewSound').onclick=async()=>{
        if(busy)return;
        if(auditionKind==='sample'){stopAudition();return;}
        const c=context(),sound=$('beatSound').value;
        try{
            let hit=null;
            if(sound==='auto'){
                const offset=c.audio?.offset_ms||0,analysis=c.audio?.analysis;
                const candidates=audition(c)?.events||analysis?.timbres?.map(t=>({at:t.at+offset,timbre:t}))||
                    (analysis?.attacks||analysis?.onsets||[]).map(p=>({...p,at:(p.peak_at??p.at)+offset}));
                for(const candidate of candidates)if(!hit||Math.abs(candidate.at-c.now)<Math.abs(hit.at-c.now))hit=candidate;
            }
            const events=[150,800,1450].map(at=>({...hit,at,strength:.8}));
            const voices=assignBeatSounds(events,sound)[0].percussion.voices;
            const names=voices.map(v=>BEAT_SOUNDS.find(p=>p.id===v.sound).label).join(' + ');
            const label=`Sound preview · ${names} · three sample hits.`+(sound==='auto'?
                hit?` Matching the nearest drum hit at ${(hit.at/1000).toFixed(2)} s.`:' Load beat audio for automatic matching; this is the default kick.':'');
            const blob=new Blob([beatClicksWav(events,0,2500,{sound})],{type:'audio/wav'});
            await playAudition(blob,label,'sample');
        }catch(error){stopAudition();message(error.message);}
    };
    $('beatAudition').addEventListener('ended',()=>{if(auditionKind==='sample')stopAudition();});
    for(const id of ['beatListen','beatDownloadWav','beatDownloadEvents'])$(id).onclick=async()=>{
        const result=audition(context());if(!result||busy)return;
        try{
            const name=`rhythm-${(result.start/1000).toFixed(3)}-${(result.end/1000).toFixed(3)}`;
            if(id==='beatDownloadEvents'){
                download(new Blob([JSON.stringify({version:2,time_unit:'ms',sound:$('beatSound').value,start_ms:result.start,end_ms:result.end,ranges_ms:result.ranges.map(r=>r.map(t=>t-result.start)),events:assignBeatSounds(result.events,$('beatSound').value).map(p=>({...p,video_at:p.at,at:p.at-result.start}))},null,2)],{type:'application/json'}),name+'.json');return;
            }
            const blob=new Blob([beatClicksWav(result.events,result.start,result.end,{sound:$('beatSound').value,ranges:result.ranges})],{type:'audio/wav'});
            if(id==='beatDownloadWav'){download(blob,name+'.wav');return;}
            await playAudition(blob,`Rhythm only · WAV starts at ${(result.start/1000).toFixed(3)} s in the video. Peaks use the saved timing events.`);
        }catch(error){stopAudition();message(error.message);}
    };
    $('beatSound').onchange=()=>{stopAudition();preferencesChanged();render();};
    $('video').addEventListener('play',stopAudition);
    window.addEventListener('pagehide',stopAudition);
    document.addEventListener('visibilitychange',()=>{if(document.hidden)stopAudition();});
    for(const id of ['beatMode','beatShape','beatTiming','beatBpm','beatCycle','beatAmplitude','beatCenter','beatSeed','beatEnergy','beatUseMix','beatLanding','beatRhythm','beatDensity','beatLowFocus','beatSyncopation','beatMaxHits','beatFamily'])$(id).onchange=()=>{discard();render();};
    function catalogue(c){
        const family=$('beatFamily').value,landing=$('beatLanding').value,mode=$('beatMode').value;
        const matched=mode==='waveform'?(draft||c.audio?.sections.find(s=>s.id===selected))?.decisions?.map(d=>d.shape)||[]:[];
        const signature=JSON.stringify([family,landing,mode,$('beatShape').value,matched,busy,!!c.audio]);
        if($('beatCatalogueGrid').dataset.signature===signature)return;
        $('beatCatalogueGrid').dataset.signature=signature;
        $('beatCatalogueGrid').replaceChildren(...BEAT_CATALOG.filter(p=>family==='all'||p.family===family).map(p=>{
            const button=document.createElement('button');button.type='button';button.className='beat-pattern-card';button.dataset.shape=p.name;
            const automatic=matched.includes(p.name);button.classList.toggle('matched',automatic);
            button.setAttribute('aria-label',`Choose ${p.name} pattern${automatic?' (current automatic match)':''}`);button.setAttribute('aria-pressed',String(mode==='manual'&&$('beatShape').value===p.name));button.disabled=busy||!c.audio;
            const label=document.createElement('strong');label.textContent=p.name+(automatic?' · matched':'');
            const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 128 44');svg.setAttribute('aria-hidden','true');
            const line=document.createElementNS(svg.namespaceURI,'polyline');line.setAttribute('points',Array.from({length:97},(_,i)=>`${4+i/96*120},${22-beatShapeValue(p.name,i/96,landing)*18}`).join(' '));svg.append(line);
            const description=document.createElement('small');description.textContent=p.description;button.append(label,svg,description);
            button.onclick=()=>{$('beatMode').value='manual';$('beatShape').value=p.name;discard();message(`${p.name} selected. Generate preview to use it in the marked range.`);render();};return button;
        }));
    }
    function controls(c){
        if(loadedProject!==c.project){
            loadedProject=c.project;selected='';clearBlocks();discard();$('beatUseMix').checked=!!c.audio?.mix;
            $('beatSound').value=BEAT_SOUNDS.some(p=>p.id===c.project?.preview?.beat_sound)?c.project.preview.beat_sound:'auto';
        }
        const steady=$('beatRhythm').value==='steady';
        $('beatTiming').querySelector('option[value="hits"]').disabled=steady;
        if(steady&&$('beatTiming').value==='hits')$('beatTiming').value='beats';
        if(chosenBlocks!==null&&blockSelectionScope!==selectionScope(c))clearBlocks();
        if(chosenBlocks!==null&&selectionPieces!==blocks(c)){
            selectionPieces=blocks(c);const available=new Set(selectionPieces.map(blockKey));
            if(chosenBlocks.some(s=>!available.has(blockKey(s))))clearBlocks();
        }
        if(selected&&!c.audio?.sections.some(s=>s.id===selected))selected='';
        if(draft&&draft.key!==key())discard();
        if(auditionKey&&auditionKey!==key())stopAudition();
        const sections=c.audio?.sections||[],signature=JSON.stringify(sections.map(s=>[s.id,s.start,s.end,s.summary]));
        if($('beatSection').dataset.signature!==signature){$('beatSection').replaceChildren(new Option('New block',''),...sections.map(s=>new Option(`${(s.start/1000).toFixed(2)}–${(s.end/1000).toFixed(2)} s · ${s.settings.mode==='manual'?s.settings.shape:s.settings.mode==='waveform'?'Auto sound match':s.settings.mode}`,s.id)));$('beatSection').dataset.signature=signature;}
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
            $('beatDecisions').replaceChildren(...decisions.map(d=>{const item=document.createElement('li');item.textContent=`${(d.start/1000).toFixed(2)}–${(d.end/1000).toFixed(2)} s · ${d.shape} · ${d.reason}`+(d.alternatives?.length?` Next matches: ${d.alternatives.map(p=>`${p.shape} (${p.match}%)`).join(', ')}.`:'');return item;}));
            $('beatDecisions').dataset.signature=decisionKey;
        }
        const valid=c.audio&&c.selection[1]>c.selection[0]&&c.selection[0]>=0&&c.selection[1]<=c.duration;
        const overlaps=sections.filter(s=>s.start<c.selection[1]&&s.end>c.selection[0]).length;
        const copy=savedRanges(c),block=sections.find(s=>s.id===selected),multiple=chosenBlocks?.length>1;
        const within=block&&c.selection[0]>=block.start&&c.selection[1]<=block.end&&c.selection[1]>c.selection[0];
        for(const [id,value]of [['beatStart',c.selection[0]],['beatEnd',c.selection[1]]]){
            $(id).disabled=busy||!c.project;$(id).max=(c.duration/1000).toFixed(3);
            if(document.activeElement!==$(id))$(id).value=(value/1000).toFixed(3);
        }
        $('beatWhole').disabled=busy||!c.project;
        $('beatRangeHint').textContent=busy?'Analyzing audio…':!c.audio?'Choose beat audio to begin.':
            !valid?'Select whole video, enter In / Out here, or Shift-drag the waveform.':
            multiple?`${chosenBlocks.length} audio blocks selected · ${c.mainLocked?`unlock Main ${c.axis} to use them`:`copy to Main ${c.axis}; unselected intervals are kept`}. Click one block or mark a range to generate.`:
            draft?(overlaps?`Preview ready · saving replaces audio in this range across ${overlaps} saved block${overlaps===1?'':'s'}. Undo restores them.`:'Preview ready · save the block, then use it in Main to include it in the export.'):
            copy.length?`Saved audio in this range · ${c.mainLocked?`unlock Main ${c.axis} to use it`:`use selection in Main ${c.axis} to replace only this interval`}.`:
            `${(c.selection[0]/1000).toFixed(3)}–${(c.selection[1]/1000).toFixed(3)} s selected · click Generate preview.`;
        if(c.audio&&c.audio.analysis.version<2&&!busy)$('beatRangeHint').textContent+=' Choose beat audio again once to refine the drum-peak timing.';
        const rhythm=$('beatRhythm').value,optimized=rhythm!=='original';
        $('beatRhythmHint').textContent=({original:'Original timing keeps the existing hit, beat or tempo grid.',accents:'Keeps strong measured accents. Density and the hit limit remove clutter; retained hits stay at their measured peaks.',simplify:'Filters busy percussion and favors the pulse. Keep syncopation retains offbeat accents without moving them.',steady:'Reconstructs a regular pulse, following local tempo changes. These markers may fall between measured hits.'})[rhythm]+(optimized?' One full pattern per retained hit. The hit limit controls event density, not device speed.':'')+(optimized&&c.audio&&!c.audio.analysis.attacks?' Choose beat audio again for low/mid/high analysis; currently using broadband accents.':'');
        for(const id of ['beatRhythm','beatDensity','beatLowFocus','beatSyncopation','beatMaxHits'])$(id).disabled=busy||!c.audio||(id!=='beatRhythm'&&!optimized)||(id==='beatSyncopation'&&rhythm==='steady');
        const audible=draft?draft.events?.length:copy.length&&copy.every(s=>s.events)&&copy.some(s=>s.events.length);
        const sound=$('beatSound').value;
        const soundKey=JSON.stringify([key(),sound,!!draft,chosenBlocks?.map(blockKey)]);
        if($('beatSoundHint').dataset.signature!==soundKey){
            $('beatSoundHint').dataset.signature=soundKey;
            const soundEvents=draft?.events||copy.flatMap(s=>s.events||[]);
            const assigned=assignBeatSounds(soundEvents,sound),counts=new Map();
            for(const event of assigned)for(const voice of event.percussion.voices)counts.set(voice.sound,(counts.get(voice.sound)||0)+1);
            const summary=[...counts].sort((a,b)=>b[1]-a[1]).map(([id,count])=>`${BEAT_SOUNDS.find(p=>p.id===id).label} (${count})`).join(', ');
            $('beatSoundHint').textContent=sound==='auto'?'Approximates each drum hit’s tone and decay; may layer two sounds. '+(summary?`This range: ${summary}. `:'')+
                (assigned.some(p=>p.percussion.match!=='stem-timbre')?'Some hits use a coarse fallback. Choose beat audio again, then generate a preview for fresh timbre matching. ':'')+
                'The drum stem supplies the sound match; the full mix guides motion shapes. ':`${BEAT_SOUNDS.find(p=>p.id===sound).label} on every primary timing event. `;
            $('beatSoundHint').textContent+='Preview sound plays three sample hits without a motion block. Listen rhythm plays your generated timing.';
        }
        $('beatSound').disabled=busy||!c.project;
        $('beatPreviewSound').disabled=busy||!c.project;
        for(const id of ['beatListen','beatDownloadWav','beatDownloadEvents']){$(id).disabled=busy||!audible;$(id).title='Listen to or export timing from the preview or saved selection. Generate a preview for older blocks without saved timing events.';}
        $('beatPreview').disabled=busy||!valid||multiple;$('beatSave').disabled=busy||!draft||multiple;
        $('beatAutoMatch').disabled=busy||!valid||multiple;$('beatFamily').disabled=busy||!c.audio;
        $('beatModeHint').textContent=$('beatMode').value==='waveform'?`Automatically compares the ${$('beatUseMix').checked&&mix?'full mix':'drum stem'} volume envelope with catalogue shapes every eight timing intervals. Drum timing stays fixed. Why these shapes shows the chosen pattern and alternatives.`:'';
        $('beatModeHint').hidden=!$('beatModeHint').textContent;
        $('beatPreview').title=valid&&!multiple?'Generate a temporary motion curve for this range.':$('beatRangeHint').textContent;
        $('beatSave').textContent=overlaps?'Replace audio in range':'Save new block';
        $('beatDiscard').disabled=!draft;$('beatRemove').disabled=busy||!within||multiple;
        $('beatRemove').textContent='Remove selected range';
        $('beatCopy').disabled=busy||!copy.length||!!draft||c.mainLocked;
        $('beatCopy').textContent=`Use ${multiple?`${chosenBlocks.length} blocks`:'selection'} in Main ${c.axis}${c.mainLocked?' · locked':''}`;
        $('beatCopy').title=multiple?'Copy only the selected audio blocks. Gaps and unselected blocks keep their current Main motion.':copy.length?'Replace only the shared In / Out range using saved audio.': 'Select a range covered by saved audio blocks. Generate and save any missing audio first.';
        for(const id of ['beatFile','beatOffset','beatMode','beatTiming','beatCycle','beatAmplitude','beatCenter','beatEnergy','beatSection','beatNew','beatLanding'])$(id).disabled=busy||!c.project||(id!=='beatFile'&&!c.audio);
        $('beatShape').disabled=busy||$('beatMode').value!=='manual';$('beatBpm').disabled=busy||$('beatTiming').value!=='tempo';
        $('beatShapeControl').hidden=$('beatMode').value!=='manual';
        $('beatCycle').disabled=busy||!c.audio||optimized;
        if(optimized)$('beatCycle').value='1';
        $('beatTiming').disabled=busy||!c.audio||(optimized&&rhythm!=='steady');
        if(c.audio&&$('beatTiming').value!=='tempo')$('beatBpm').value=c.audio.analysis.bpm||120;
        $('beatSeed').disabled=$('beatShuffle').disabled=busy||$('beatMode').value!=='random';
        $('beatCancelAnalysis').hidden=!busy;
        catalogue(c);
    }
    function draw(){
        const c=context();controls(c);const ratio=devicePixelRatio||1,w=canvas.clientWidth,h=210;
        if(!w)return;if(canvas.width!==Math.round(w*ratio)||canvas.height!==h*ratio){canvas.width=Math.round(w*ratio);canvas.height=h*ratio;layer=null;}
        const ctx=canvas.getContext('2d'),[start,end]=c.bounds,x=t=>42+(t-start)/(end-start)*(w-54),y=v=>174-v*1.1;
        const pieces=blocks(c),visible=pieces.filter(s=>s.start<end&&s.end>start);
        const labelKey=JSON.stringify([w,start,end,visible,c.selection,chosenBlocks]);
        if($('beatLabels').dataset.signature!==labelKey){
            $('beatLabels').dataset.signature=labelKey;
            $('beatLabels').replaceChildren(...visible.map(s=>{
                const button=document.createElement('button'),left=Math.max(42,x(s.start)),right=Math.min(w-12,x(s.end));
                button.className='audio-section-block';button.dataset.start=s.start;button.dataset.end=s.end;button.dataset.block=s.id;
                button.textContent=s.label||`Audio · ${formatTime(s.start,2)}–${formatTime(s.end,2)}`;
                button.title=`${button.textContent} · ${formatTime(s.start,3)}–${formatTime(s.end,3)} · Shift-click selects a range; Ctrl/Cmd-click toggles this block`;
                button.style.left=`${left}px`;button.style.width=`${Math.max(1,right-left)}px`;
                button.setAttribute('aria-pressed',String(chosenBlocks!==null?chosenBlocks.some(b=>blockKey(b)===blockKey(s)):c.selection[0]<=s.start&&c.selection[1]>=s.end));
                button.onclick=event=>{if(busy)return;pickBlock(s,event);seek(s.start);};return button;
            }));
        }
        const signature=JSON.stringify([w,ratio,start,end,selected,options(),c.showCuts,c.cuts,pieces]);
        if(!layer||layer.audio!==c.audio||layer.draft!==draft||layer.signature!==signature){
            const surface=new OffscreenCanvas(canvas.width,canvas.height),p=surface.getContext('2d');p.scale(ratio,ratio);p.fillStyle='#172631';p.fillRect(0,0,w,h);p.font='11px system-ui';
            p.save();p.beginPath();p.rect(42,0,w-54,h);p.clip();
            for(const tick of rulerTicks(start,end,w-54,c.duration)){
                p.strokeStyle='#263744';p.beginPath();p.moveTo(x(tick.time),10);p.lineTo(x(tick.time),185);p.stroke();
            }
            for(const s of visible){p.fillStyle='#574d3622';p.fillRect(x(s.start),10,x(s.end)-x(s.start),175);}
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
                    p.strokeStyle='#ffc875';p.lineWidth=2;p.beginPath();s.actions.forEach((v,i)=>{if(i)p.lineTo(x(v.at),y(v.pos));else p.moveTo(x(v.at),y(v.pos));});p.stroke();
                }
            }
            if(draft){p.strokeStyle='#ff91bc';p.lineWidth=2;p.setLineDash([5,3]);p.beginPath();draft.actions.forEach((v,i)=>{if(i)p.lineTo(x(v.at),y(v.pos));else p.moveTo(x(v.at),y(v.pos));});p.stroke();}
            p.setLineDash([]);p.lineWidth=1;p.strokeStyle='#9e825c';
            for(const s of visible)p.strokeRect(x(s.start)+.5,10.5,Math.max(0,x(s.end)-x(s.start)-1),174);
            if(c.showCuts){
                let last=-Infinity;
                for(const t of c.cuts||[]){const px=x(t);if(px<42||px>w-12||px-last<8)continue;last=px;
                    p.strokeStyle='#d9c57e66';p.setLineDash([2,5]);p.beginPath();p.moveTo(px,10);p.lineTo(px,185);p.stroke();p.setLineDash([]);
                    p.fillStyle='#d9c57e';p.beginPath();p.moveTo(px,1);p.lineTo(px+4,5);p.lineTo(px,9);p.lineTo(px-4,5);p.closePath();p.fill();
                }
            }
            p.restore();p.fillStyle='#93aabc';for(const v of [0,50,100])p.fillText(String(v),8,y(v));
            for(const tick of rulerTicks(start,end,w-54,c.duration))p.fillText(tick.label,Math.max(42,Math.min(w-12-p.measureText(tick.label).width,x(tick.time)-p.measureText(tick.label).width/2)),204);
            layer={surface,audio:c.audio,draft,signature};
        }
        ctx.setTransform(1,0,0,1,0,0);ctx.drawImage(layer.surface,0,0);ctx.scale(ratio,ratio);
        ctx.save();ctx.beginPath();ctx.rect(42,0,w-54,h);ctx.clip();
        ctx.fillStyle='#78baf722';
        for(const [a,b]of chosenBlocks===null?[c.selection]:chosenBlocks.map(s=>[s.start,s.end]))ctx.fillRect(x(a),30,x(b)-x(a),155);
        ctx.strokeStyle='#f0f5fa';ctx.beginPath();ctx.moveTo(x(c.now),0);ctx.lineTo(x(c.now),185);ctx.stroke();ctx.restore();
    }
    const pointer=event=>{const c=context(),r=canvas.getBoundingClientRect();return Math.max(0,Math.min(c.duration,Math.round(c.bounds[0]+(event.clientX-r.left-42)/(r.width-54)*(c.bounds[1]-c.bounds[0]))));};
    canvas.addEventListener('wheel',event=>wheel(event,canvas),{passive:false});
    canvas.onpointerdown=event=>{
        if(event.button!==0||!context().project)return;const at=pointer(event),c=context();event.preventDefault();canvas.focus({preventScroll:true});
        if(event.shiftKey){clearBlocks();drag=at;selectRange(at,at);if(event.isTrusted)canvas.setPointerCapture(event.pointerId);}
        else {const s=blocks(c).find(s=>at>=s.start&&at<s.end);if(s)pickBlock(s,event);seek(at);}
    };
    canvas.onpointermove=event=>{if(drag!==null)selectRange(Math.min(drag,pointer(event)),Math.max(drag,pointer(event)));};
    for(const name of ['pointerup','pointercancel','lostpointercapture'])canvas.addEventListener(name,()=>{drag=null;});
    return {render:draw};
}
