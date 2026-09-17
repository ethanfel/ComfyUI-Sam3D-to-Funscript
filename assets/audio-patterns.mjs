import {evaluate,roundEven,reduceActions,validateReference} from "./curve.mjs";
import {RHYTHM_PATTERNS,rhythmValue} from "./patterns.mjs";

export const BEAT_SHAPES=['Triangle','Sine Wave',...Object.keys(RHYTHM_PATTERNS)];
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const random=(seed,index)=>{let x=(seed^Math.imul(index+1,0x9e3779b9))>>>0;x=Math.imul(x^x>>>16,0x21f0aaad);x=Math.imul(x^x>>>15,0x735a2d97);return ((x^x>>>15)>>>0)/4294967296;};
function indexAt(points,at){let lo=0,hi=points.length;while(lo<hi){const m=(lo+hi)>>1;if(points[m].at<=at)lo=m+1;else hi=m;}return lo-1;}
function peakPhase(shape){
    if(!RHYTHM_PATTERNS[shape])return .5;
    return RHYTHM_PATTERNS[shape].find(p=>p[1]===1)[0];
}
function mixWindow(mix,start,end){
    if(!mix?.analysis.features)return null;
    const {duration_ms,features}=mix.analysis,offset=mix.offset_ms||0;
    const a=Math.max(0,start-offset),b=Math.min(duration_ms,end-offset);
    if(b<=a||(b-a)<(end-start)*.8)return null;
    const count=features.energy.length,lo=Math.floor(a/duration_ms*count),hi=Math.min(count,Math.ceil(b/duration_ms*count));
    const average=(name,from=lo,to=hi)=>features[name].slice(from,to).reduce((s,v)=>s+v,0)/Math.max(1,to-from);
    const energy=average('energy'),peak=Math.max(...features.energy.slice(lo,hi)),middle=Math.floor((lo+hi)/2);
    const contrast=Math.sqrt(features.energy.slice(lo,hi).reduce((s,v)=>s+(v-energy)**2,0)/Math.max(1,hi-lo))/(energy||1);
    return {energy,brightness:average('brightness'),bass:average('bass'),attack:average('attack'),sustain:peak?energy/peak:0,
        trend:hi-lo>1?average('energy',middle,hi)-average('energy',lo,middle):0,contrast:clamp(contrast,0,1)};
}
function rankShapes(mix,drums,mixHits,tempo,offbeat){
    const strength=drums.reduce((sum,h)=>sum+h.strength,0)/(drums.length||1),busy=clamp((drums.length+mixHits)/32,0,1);
    const {energy,sustain,trend,bass,brightness,attack,contrast}=mix;
    return [
        ['Smooth Bounce',.45+(1-energy)*.45+sustain*.1,'Moderate full-mix energy favors a smooth bounce.'],
        ['Sine Wave',sustain*.8+(1-busy)*.5,'Sustained full-mix energy and fewer attacks favor a flowing stroke.'],
        ['Half Stroke',energy<.18?2:.3+Math.max(0,.35-energy)*3,'A quiet full mix favors smaller alternating accents.'],
        ['Staircase Up',Math.max(0,trend)*4+.2,'The full mix builds in energy through this phrase.'],
        ['Staircase Down',Math.max(0,-trend)*4+.2,'The full mix falls in energy through this phrase.'],
        ['Double Tap',busy*.9+(tempo<145?.35:0)+attack*.3,'Dense attacks in the stem and mix favor paired taps.'],
        ['Quick Rise',attack*2.5+strength*.5+.1,'Sharp full-mix attacks and strong drum hits favor a quick rise.'],
        ['Hold High',energy*.5+bass*.4+sustain*.25,'Strong, sustained low-frequency energy favors a high hold.'],
        ['Accent & Echo',brightness*.8+contrast*.7+.3,'A bright or contrasting full mix favors an accent and echo.'],
        ['Swing',.6+offbeat*.8+busy*.15,'Offbeat drum attacks favor an asymmetric stroke.'],
    ].sort((a,b)=>b[1]-a[1]);
}
export function beatGrid(audio,options={}){
    const {timing='beats',bpm=0}=options,offset=audio.offset_ms||0;
    if(!['beats','hits','tempo'].includes(timing))throw new Error('Choose detected beats, drum peaks or a tempo grid.');
    if(timing!=='tempo')return audio.analysis[timing==='hits'?'onsets':'beats'].map(p=>({...p,at:(p.peak_at??p.at)+offset}))
        .sort((a,b)=>a.at-b.at).filter((p,i,points)=>!i||p.at>points[i-1].at);
    if(!Number.isFinite(bpm)||bpm<30||bpm>300)throw new Error('Enter a tempo between 30 and 300 BPM.');
    const period=60000/bpm,first=audio.analysis.onsets[0]?.at||0;
    const origin=first-Math.floor(first/period)*period,grid=[];
    for(let at=origin;at<audio.analysis.duration_ms;at+=period)grid.push({at:Math.round(at+offset),strength:1});
    return grid;
}
export function generateBeatSection(audio,start,end,options={}){
    start=roundEven(start);end=roundEven(end);
    if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start)throw new Error('Mark a nonempty range on the audio row.');
    const settings={mode:'suggest',shape:'Smooth Bounce',timing:'hits',bpm:audio.analysis.bpm||120,beatsPerCycle:1,amplitude:40,center:50,followEnergy:true,seed:1,association:audio.mix?'dual':'beats',...options,
        beatLanding:options.beatLanding??(options.peakOnBeat===undefined?'down':options.peakOnBeat?'up':'shape')};
    const {mode,shape,beatsPerCycle,amplitude,center,seed}=settings;
    if(!['suggest','manual','random'].includes(mode)||!BEAT_SHAPES.includes(shape)||!['beats','dual'].includes(settings.association)||!['down','up','shape'].includes(settings.beatLanding))throw new Error('Choose a pattern mode, shape, beat landing and audio source.');
    if(![.5,1,2,4,8].includes(beatsPerCycle)||!Number.isFinite(amplitude)||amplitude<0||amplitude>50||!Number.isFinite(center)||center<0||center>100||!Number.isInteger(seed)||seed<0||seed>4294967295)throw new Error('Use 0–50 amplitude, 0–100 center and a valid cycle/seed.');
    const grid=beatGrid(audio,settings),offset=audio.offset_ms||0;
    if(grid.length<2)throw new Error('No clear beat grid. Try Drum peaks or enter a Tempo grid.');
    if(end<grid[0].at||start>grid.at(-1).at)throw new Error('This selection does not overlap the audio beats. Check the audio offset.');
    const mix=settings.association==='dual'?audio.mix:null;
    const step=20,choices=new Map(),times=new Set([start,end]);
    const knots=Object.entries(RHYTHM_PATTERNS).flatMap(([name,p])=>p.map(v=>settings.beatLanding==='up'?(v[0]-peakPhase(name)+1)%1:v[0]));
    const atBeat=b=>{const i=clamp(Math.floor(b),0,grid.length-2);return grid[i].at+(b-i)*(grid[i+1].at-grid[i].at);};
    const bStart=Math.max(0,indexAt(grid,start)),bEnd=Math.min(grid.length-1,indexAt(grid,end)+1);
    for(let cycle=Math.floor(bStart/beatsPerCycle);cycle<=Math.ceil(bEnd/beatsPerCycle);cycle++)
        for(const u of [0,.5,1,...knots]){const t=roundEven(atBeat((cycle+u)*beatsPerCycle));if(t>start&&t<end)times.add(t);}
    for(const point of grid){const t=roundEven(point.at);if(t>start&&t<end)times.add(t);}
    if((end-start)/step>100000)throw new Error('Choose a section shorter than 33 minutes.');
    for(let at=start+step;at<end;at+=step)times.add(at);
    function choice(phrase){
        if(choices.has(phrase))return choices.get(phrase);
        const a=atBeat(phrase*8),b=atBeat(phrase*8+8),hits=audio.analysis.onsets.map(p=>({...p,at:p.peak_at??p.at})).filter(p=>p.at+offset>=a&&p.at+offset<b);
        const strength=hits.reduce((s,p)=>s+p.strength,0)/(hits.length||1),tempo=480000/Math.max(1,b-a);
        const pool=tempo>145?['Smooth Bounce','Swing','Quick Rise','Hold High']:['Smooth Bounce','Double Tap','Half Stroke','Accent & Echo','Hold Low','Staircase Up'];
        let selected=mode==='manual'?shape:mode==='random'?pool[Math.floor(random(seed,phrase)*pool.length)]:
            strength<.3?'Smooth Bounce':hits.length>12&&tempo<145?'Double Tap':strength>.6?'Quick Rise':'Swing';
        let reason=mode==='manual'?'Your chosen shape.':mode==='random'?'Repeatable variation from the drum-tempo pattern pool.':'Drum tempo, attack density and strength.',source='beats';
        const profile=mixWindow(mix,a,b);
        if(profile&&mode!=='manual'){
            const mixHits=mix.analysis.onsets.filter(p=>p.at+(mix.offset_ms||0)>=a&&p.at+(mix.offset_ms||0)<b).length;
            const offbeat=hits.filter(h=>{const i=clamp(indexAt(grid,h.at+offset),0,grid.length-2),phase=(h.at+offset-grid[i].at)/(grid[i+1].at-grid[i].at);return phase>.2&&phase<.8;}).length/(hits.length||1);
            const ranked=rankShapes(profile,hits,mixHits,tempo,offbeat),candidates=ranked.slice(0,3).filter(p=>p[1]>=ranked[0][1]*.65);
            const chosen=mode==='random'?candidates[Math.floor(random(seed,phrase)*candidates.length)]:ranked[0];
            [selected,,reason]=chosen;source='dual';
        }else if(profile&&mode==='manual'){source='dual';reason='Your chosen shape; full-mix energy is available for amplitude.';}
        else if(mix&&!profile&&mode!=='manual')reason+=' Full mix does not cover this phrase; using the drum stem.';
        const result={start:Math.max(start,Math.round(a)),end:Math.min(end,Math.round(b)),shape:selected,reason,source};
        choices.set(phrase,result);return result;
    }
    // Use cycle energy, not the instantaneous drum waveform: a kick's decay
    // should change the stroke strength without distorting its shape.
    const gains=new Map(),waveform=audio.analysis.waveform;
    function cycleGain(cycle){
        if(gains.has(cycle))return gains.get(cycle);
        const origin=cycle-(settings.beatLanding==='shape'?0:.5),a=atBeat(origin*beatsPerCycle),b=atBeat((origin+1)*beatsPerCycle);
        const lo=Math.max(0,Math.floor((a-offset)/audio.analysis.duration_ms*waveform.length));
        const hi=Math.min(waveform.length,Math.ceil((b-offset)/audio.analysis.duration_ms*waveform.length));
        let peak=0;for(let i=lo;i<hi;i++)peak=Math.max(peak,waveform[i]);
        const profile=mixWindow(mix,a,b);
        const level=profile?.energy<.01?0:profile?peak*.3+profile.energy*.7:peak;
        const gain=peak<.01||level<.01?0:settings.followEnergy ? .35+.65*Math.sqrt(level) : 1;
        gains.set(cycle,gain);return gain;
    }
    const values=[...times].sort((a,b)=>a-b).map(at=>{
        const i=clamp(indexAt(grid,at),0,grid.length-2),beat=i+(at-grid[i].at)/(grid[i+1].at-grid[i].at),cycle=beat/beatsPerCycle;
        const chosen=choice(Math.max(0,Math.floor(beat/8))).shape,phase=((cycle+(settings.beatLanding==='up'?peakPhase(chosen):0))%1+1)%1;
        const value=chosen==='Triangle'?1-4*Math.abs(phase-.5):chosen==='Sine Wave'?-Math.cos(phase*Math.PI*2):rhythmValue(chosen,phase);
        const gainTime=cycle-(settings.beatLanding==='shape'?.5:0),a=Math.floor(gainTime),fraction=gainTime-a,weight=fraction*fraction*(3-2*fraction);
        const intensity=at<offset||at>offset+audio.analysis.duration_ms?0:cycleGain(a)*(1-weight)+cycleGain(a+1)*weight;
        return {at,pos:roundEven(clamp(center+amplitude*value*intensity,0,100))};
    });
    const actions=reduceActions(values,{protectedTimes:grid.map(p=>roundEven(p.at))}).actions;
    const decisions=[...choices.values()].filter(d=>d.end>d.start);
    const association=decisions.some(d=>d.source==='dual')?'drums + full mix':mix?'drums · full mix outside range':'drums';
    return {start,end,settings,actions,decisions,summary:`${mode==='suggest'?'Suggested':mode==='random'?'Random':'Manual'} · ${[...new Set(decisions.map(d=>d.shape))].join(', ')} · ${beatsPerCycle} beats/cycle · ${association} · ${actions.length} points`};
}
export function insertBeatSection(actions,section,blendMs=0){
    validateReference({actions});validateReference({actions:section.actions});
    const {start,end}=section;
    if(!Number.isFinite(blendMs)||blendMs<0)throw new Error('Use a nonnegative blend duration.');
    const width=Math.min(blendMs,(end-start)/2),times=new Set([start,end]);
    // A cut copies the saved curve exactly. Sampling it at the old curve's knots
    // and rounding those extra points would change it on each audio/SAM3D swap.
    for(const p of [...(width?actions:[]),...section.actions])if(p.at>=start&&p.at<=end)times.add(p.at);
    if(width){times.add(roundEven(start+width));times.add(roundEven(end-width));for(let t=start;t<end;t+=20)times.add(roundEven(t));}
    const inside=[...times].sort((a,b)=>a-b).map(at=>{
        const weight=width?clamp(Math.min(at-start,end-at)/width,0,1):1;
        return {at,pos:roundEven(evaluate(actions,at)*(1-weight)+evaluate(section.actions,at)*weight)};
    });
    const before=actions.filter(p=>p.at<start),after=actions.filter(p=>p.at>end);
    if(!width){if(before.length&&before.at(-1).at<start-1)before.push({at:start-1,pos:roundEven(evaluate(actions,start-1))});if(after.length&&after[0].at>end+1)after.unshift({at:end+1,pos:roundEven(evaluate(actions,end+1))});}
    return reduceActions([...before,...inside,...after],{start,end,protectedTimes:[start,end,start+width,end-width]}).actions;
}

// Show existing audio on the same source-clock sections without regenerating it.
export function beatSectionBlocks(sections, sources=[], cuts=[]) {
    const edges=[...new Set([...sources.flatMap(s=>[s.start,s.end]),...cuts].filter(Number.isFinite).map(roundEven))].sort((a,b)=>a-b);
    return sections.flatMap(s=>{
        const bounds=[s.start,...edges.filter(t=>t>s.start&&t<s.end),s.end];
        return bounds.slice(1).map((end,i)=>{
            const start=bounds[i],source=sources.find(r=>r.start<=start&&r.end>=end);
            return {id:s.id,start,end,label:source?.label||'',source:source?.id};
        });
    });
}
export function sliceBeatSection(section,start,end) {
    if(![start,end].every(Number.isInteger)||start<section.start||end>section.end||end<=start)throw new Error('Select a range inside the saved audio block.');
    return {...section,start,end,actions:[{at:start,pos:roundEven(evaluate(section.actions,start))},
        ...section.actions.filter(p=>p.at>start&&p.at<end),{at:end,pos:roundEven(evaluate(section.actions,end))}],
        decisions:(section.decisions||[]).filter(d=>d.start<end&&d.end>start).map(d=>({...d,start:Math.max(start,d.start),end:Math.min(end,d.end)}))};
}
// A shared selection may span several adjacent saved blocks, but never a gap.
export function savedBeatSelection(sections,start,end) {
    if(![start,end].every(Number.isInteger)||end<=start)return null;
    let cursor=start;const parts=[];
    for(const s of [...sections].sort((a,b)=>a.start-b.start)){
        if(s.end<=cursor||s.start>=end)continue;
        if(s.start>cursor)return null;
        const part=sliceBeatSection(s,cursor,Math.min(end,s.end));parts.push(part);cursor=part.end;
        if(cursor===end)break;
    }
    if(cursor!==end)return null;
    const points=new Map();
    for(let i=0;i<parts.length;i++){
        const part=parts[i],previous=parts[i-1];
        if(previous&&previous.actions.at(-1).pos!==part.actions[0].pos){
            const at=part.start-1;points.set(at,{at,pos:roundEven(evaluate(previous.actions,at))});
        }
        for(const p of part.actions)points.set(p.at,p);
    }
    return {...parts[0],start,end,actions:[...points.values()].sort((a,b)=>a.at-b.at),decisions:parts.flatMap(s=>s.decisions),
        summary:parts.length===1?parts[0].summary:`${parts.length} audio blocks`};
}
// A replacement owns its entire range, including existing blocks and gaps.
// Keep untouched blocks and the surviving ends of any intersected blocks.
export function editBeatSections(sections,selected,start,end,replacement=null) {
    if(![start,end].every(Number.isInteger)||end<=start||start<0)throw new Error('Select a nonempty audio range.');
    const original=sections.find(s=>s.id===selected);
    if(selected&&!original)throw new Error('Select a saved audio block first.');
    if(!replacement&&(!original||start<original.start||end>original.end))throw new Error('Select a range inside the saved audio block.');
    const affected=sections.filter(s=>s.start<end&&s.end>start&&(replacement||s.id===selected));
    const ids=new Set(sections.map(s=>s.id));
    const fresh=()=>{let n=0;while(ids.has(`beat_${n}`))n++;const id=`beat_${n}`;ids.add(id);return id;};
    const id=replacement?(affected.includes(original)?selected:fresh()):'';
    const output=sections.filter(s=>!affected.includes(s));
    for(const section of affected)for(const [a,b]of [[section.start,Math.min(start,section.end)],[Math.max(end,section.start),section.end]]){
        if(b>a)output.push({...sliceBeatSection(section,a,b),id:fresh()});
    }
    if(replacement)output.push({...replacement,id,start,end});
    return {sections:output.sort((a,b)=>a.start-b.start),selected:id};
}
