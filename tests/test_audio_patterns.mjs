import assert from 'node:assert/strict';
import {analyzeBeatAudio} from '../assets/audio-analysis.mjs';
import {BEAT_SHAPES,beatGrid,generateBeatSection,insertBeatSection,beatSectionBlocks,sliceBeatSection,savedBeatSelection,editBeatSections} from '../assets/audio-patterns.mjs';
import {evaluate,validateReference} from '../assets/curve.mjs';

const rate=11025,samples=new Float32Array(rate*16);
for(let time=2;time<14;time+=.5)for(let i=0;i<rate*.1;i++)
    samples[Math.round(time*rate)+i]=Math.sin(i/rate*2*Math.PI*90)*Math.exp(-i/rate*45);
const analysis=await analyzeBeatAudio(samples,rate);
assert.ok(Math.abs(analysis.bpm-120)<4,`120 BPM click fixture: ${analysis.bpm}`);
assert.equal(analysis.onsets.length,24);
assert.ok(Math.abs(analysis.onsets[0].at-2000)<50);
assert.ok(analysis.waveform.length<=8000);
const peakTimes=[437,1149,1802,2517,3101],pulses=new Float32Array(rate*4);
for(const peak of peakTimes)for(let i=Math.floor((peak-45)*rate/1000);i<Math.ceil((peak+45)*rate/1000);i++){
    const t=i/rate-peak/1000;pulses[i]=Math.cos(t*2*Math.PI*1200)*Math.exp(-.5*(t/.009)**2);
}
const measured=await analyzeBeatAudio(pulses,rate);
assert.equal(measured.version,2);assert.equal(measured.onsets.length,peakTimes.length);
for(let i=0;i<peakTimes.length;i++)assert.ok(Math.abs(measured.onsets[i].peak_at-peakTimes[i])<=3,`Measured loudness peak at ${peakTimes[i]}`);
const silent=await analyzeBeatAudio(new Float32Array(rate),rate);
assert.equal(silent.bpm,0);assert.deepEqual(silent.beats,[]);assert.deepEqual(silent.onsets,[]);
await assert.rejects(analyzeBeatAudio(samples,rate,{cancelled:()=>true}),/cancelled/);

const audio={offset_ms:0,analysis:{duration_ms:20000,bpm:120,
    waveform:Array.from({length:200},()=>1),
    beats:Array.from({length:40},(_,i)=>({at:i*500,strength:1})),
    onsets:Array.from({length:40},(_,i)=>({at:i*500,strength:1}))}};
const options={mode:'manual',shape:'Triangle',beatsPerCycle:2,followEnergy:false};
const section=generateBeatSection(audio,1000,7000,options);
assert.equal(section.actions[0].at,1000);assert.equal(section.actions.at(-1).at,7000);
for(let t=1000;t<=7000;t+=500)assert.equal(evaluate(section.actions,t),t%1000?90:10);
for(const shape of BEAT_SHAPES){
    const result=generateBeatSection(audio,1000,7000,{...options,shape});
    validateReference({actions:result.actions});
    assert.ok(result.actions.every(p=>p.pos>=0&&p.pos<=100));
}
assert.deepEqual(generateBeatSection(audio,0,19000,{mode:'random',seed:7}),generateBeatSection(audio,0,19000,{mode:'random',seed:7}));
assert.notDeepEqual(generateBeatSection(audio,0,19000,{mode:'random',seed:7}).actions,generateBeatSection(audio,0,19000,{mode:'random',seed:8}).actions);
const shifted={...audio,offset_ms:1250};
assert.equal(beatGrid(shifted)[0].at,1250);
assert.equal(beatGrid(shifted,{timing:'tempo',bpm:60})[1].at,2250);
assert.throws(()=>beatGrid(audio,{timing:'tempo',bpm:0}),/tempo/);
assert.throws(()=>generateBeatSection(audio,500,500),/nonempty/);
assert.throws(()=>generateBeatSection({...audio,analysis:silent},0,1000),/No clear beat/);
const quiet=generateBeatSection({offset_ms:0,analysis},0,16000,options);
assert.ok(quiet.actions.filter(p=>p.at<1000||p.at>15000).every(p=>p.pos===50),'Silent intro/outro holds center');
// Drum decay must not distort the chosen rhythm between hits.
const pulsed={...audio,analysis:{...audio.analysis,waveform:audio.analysis.waveform.map((_,i)=>i%5===0?1:0)}};
assert.deepEqual(generateBeatSection(pulsed,2000,7000,options).actions,generateBeatSection(audio,2000,7000,options).actions);
const base=[{at:0,pos:20},{at:3000,pos:70},{at:9000,pos:30},{at:20000,pos:60}];
for(const blend of [0,150]){
    const result=insertBeatSection(base,section,blend);
    for(const t of [0,400,998,7002,12000,20000])assert.ok(Math.abs(evaluate(base,t)-evaluate(result,t))<=.5,`Outside range preserved: ${t}`);
    assert.equal(evaluate(result,3500),90);
    if(blend)assert.ok(Math.abs(evaluate(result,1000)-evaluate(base,1000))<=.5);
}
console.log('Audio analysis, beat alignment, rhythm shapes, energy, offsets, deterministic variation and bounded insertion passed.');

const full={...generateBeatSection(audio,0,19000,options),id:'beat_0'},snapshot=structuredClone(full);
const sources=[{id:'track_0',start:4000,end:8000,label:'Tracking 1'},{id:'track_1',start:8000,end:12000,label:'Tracking 2'}];
const blocks=beatSectionBlocks([full],sources,[6000.25,8000,16000]);
assert.deepEqual(blocks.map(s=>[s.start,s.end]),[[0,4000],[4000,6000],[6000,8000],[8000,12000],[12000,16000],[16000,19000]]);
assert.equal(blocks[1].label,'Tracking 1');assert.equal(blocks[3].label,'Tracking 2');
assert.deepEqual(full,snapshot,'Displaying section boundaries does not edit saved audio');
assert.deepEqual(beatSectionBlocks([full],[]).map(s=>[s.start,s.end]),[[0,19000]],'Audio-only projects retain their saved block');
const sliced=savedBeatSelection([full],4321,7999);
assert.equal(sliced.start,4321);assert.equal(sliced.end,7999);
for(let t=4321;t<7999;t+=29)assert.ok(Math.abs(evaluate(sliced.actions,t)-evaluate(full.actions,t))<=.5,'Cutting an existing block preserves the curve within rounding tolerance');
const replacement={...generateBeatSection(audio,4000,8000,{...options,shape:'Double Tap'}),audio_name:'drums.wav'};
const edited=editBeatSections([full],'beat_0',4000,8000,replacement);
assert.deepEqual(edited.sections.map(s=>[s.start,s.end]),[[0,4000],[4000,8000],[8000,19000]]);
assert.equal(new Set(edited.sections.map(s=>s.id)).size,3);assert.equal(edited.selected,'beat_0');
assert.deepEqual(edited.sections[1].actions,replacement.actions);
for(const s of [edited.sections[0],edited.sections[2]])for(let t=s.start;t<=s.end;t+=23)assert.ok(Math.abs(evaluate(s.actions,t)-evaluate(full.actions,t))<=.5,'Partial replacement retains both neighboring ranges');
assert.deepEqual(full,snapshot);
assert.ok(savedBeatSelection(edited.sections,2000,14000),'Adjacent audio pieces may be copied as one selection');
const step=savedBeatSelection([{id:'a',start:0,end:4000,actions:[{at:0,pos:10},{at:4000,pos:10}]},
    {id:'b',start:4000,end:8000,actions:[{at:4000,pos:90},{at:8000,pos:90}]}],1000,7000);
assert.equal(evaluate(step.actions,3999),10);assert.equal(evaluate(step.actions,4000),90,'Joining audio blocks preserves a hard boundary');
const unrelated=Array.from({length:251},(_,i)=>({at:i*80,pos:i%2?75:25}));
const copied=insertBeatSection(unrelated,sliced);
assert.deepEqual(copied.filter(p=>p.at>=sliced.start&&p.at<=sliced.end),insertBeatSection(base,sliced).filter(p=>p.at>=sliced.start&&p.at<=sliced.end),'Cut copying cannot depend on old Main knots');
const removed=editBeatSections([full],'beat_0',4000,8000);
assert.deepEqual(removed.sections.map(s=>[s.start,s.end]),[[0,4000],[8000,19000]]);
assert.equal(savedBeatSelection(removed.sections,2000,14000),null,'Copying cannot bridge a missing audio range');
assert.equal(savedBeatSelection([full],19000,19000),null);
const editedSnapshot=structuredClone(edited.sections);
const spanning=generateBeatSection(audio,7000,10000,options);
const overwritten=editBeatSections(edited.sections,'beat_0',7000,10000,spanning);
assert.deepEqual(overwritten.sections.map(s=>[s.start,s.end]),[[0,4000],[4000,7000],[7000,10000],[10000,19000]]);
assert.deepEqual(overwritten.sections[0],edited.sections[0],'An untouched block keeps its ID and settings');
assert.deepEqual(overwritten.sections[2].actions,spanning.actions);
for(const s of [overwritten.sections[1],overwritten.sections[3]])for(let t=s.start;t<=s.end;t+=37)
    assert.ok(Math.abs(evaluate(s.actions,t)-evaluate(savedBeatSelection(edited.sections,s.start,s.end).actions,t))<=.5,'Spanning replacement preserves the surviving ends');
assert.equal(new Set(overwritten.sections.map(s=>s.id)).size,overwritten.sections.length);
assert.deepEqual(edited.sections,editedSnapshot,'Replacement never mutates the input');
const whole=editBeatSections(edited.sections,'',0,19000,full);
assert.equal(whole.sections.length,1,'A whole-song preview replaces all existing blocks without selecting one first');
assert.deepEqual(whole.sections[0].actions,full.actions);
const elsewhere=editBeatSections(edited.sections,'beat_0',0,4000,sliceBeatSection(full,0,4000));
assert.deepEqual(elsewhere.sections.slice(1),edited.sections.slice(1),'An unrelated selected block and a touching neighbor stay unchanged');
assert.notEqual(elsewhere.selected,'beat_0');
const filled=editBeatSections(removed.sections,'',0,19000,full);
assert.equal(filled.sections.length,1,'Replacing a range may cover both saved audio and gaps');
assert.throws(()=>sliceBeatSection(full,-1,8000),/inside/);
console.log('Aligned audio sections, exact selections, partial replacement/removal, adjacent coverage and gap protection passed.');

// Full-mix features distinguish sustained bass from brighter audio and track a build.
const tone=freq=>Float32Array.from({length:rate*8},(_,i)=>Math.sin(i/rate*2*Math.PI*freq)*(.1+.8*i/(rate*8)));
const bassProfile=await analyzeBeatAudio(tone(90),rate,{character:true});
const brightProfile=await analyzeBeatAudio(tone(2200),rate,{character:true});
assert.ok(bassProfile.features.bass[20]>.9);assert.ok(brightProfile.features.bass[20]<.05);
assert.ok(brightProfile.features.brightness[20]>bassProfile.features.brightness[20]+.3);
assert.ok(bassProfile.features.energy[60]>bassProfile.features.energy[10]+.4);
assert.equal(analysis.features,undefined,'Beat-only import needs no full-mix features');
const mix={offset_ms:0,analysis:{duration_ms:20000,onsets:[],waveform:Array(200).fill(.5),
    features:{energy:Array(200).fill(.5),brightness:Array(200).fill(.1),bass:Array(200).fill(.1),attack:Array(200).fill(.01)}}};
const dual={...audio,mix};
assert.deepEqual(beatGrid(dual),beatGrid(audio),'Full-mix analysis cannot shift the drum grid');
const suggested=generateBeatSection(dual,0,7000,{peakOnBeat:true,followEnergy:false});
assert.equal(suggested.decisions[0].shape,'Sine Wave');assert.equal(suggested.decisions[0].source,'dual');
assert.match(suggested.decisions[0].reason,/Sustained/);
for(let t=0;t<=7000;t+=1000)assert.equal(evaluate(suggested.actions,t),90,'Primary peak stays on the drum beat');
const building=structuredClone(dual);building.mix.analysis.features.energy=Array.from({length:200},(_,i)=>(i%40)/40);
const built=generateBeatSection(building,0,7000,{peakOnBeat:true,followEnergy:false});
assert.equal(built.decisions[0].shape,'Staircase Up');assert.notDeepEqual(built.actions,suggested.actions);
for(const shape of BEAT_SHAPES){
    const aligned=generateBeatSection(dual,0,7000,{...options,shape,peakOnBeat:true});
    for(let t=0;t<=7000;t+=1000)assert.equal(evaluate(aligned.actions,t),90,`${shape}: peak at ${t}`);
}
const drumOnly=generateBeatSection(dual,0,7000,{association:'beats'});
assert.deepEqual(drumOnly,generateBeatSection(audio,0,7000,{association:'beats'}));
const unmatched=structuredClone(dual);unmatched.mix.offset_ms=30000;
const fallback=generateBeatSection(unmatched,0,7000,{peakOnBeat:true,followEnergy:false});
assert.ok(fallback.decisions.every(d=>d.source==='beats'));assert.match(fallback.decisions[0].reason,/does not cover/);
assert.deepEqual(fallback.actions,generateBeatSection(audio,0,7000,{peakOnBeat:true,followEnergy:false}).actions);
assert.deepEqual(generateBeatSection(dual,0,19000,{mode:'random',seed:42}),generateBeatSection(dual,0,19000,{mode:'random',seed:42}));
console.log('Dual-source features, phrase association, aligned peaks, offsets and drum-only fallback passed.');

// Irregular percussion cannot be replaced by a constant BPM grid. Each actual
// peak is sampled explicitly, even when it falls between the 20 ms curve samples.
const irregular={offset_ms:137,analysis:{duration_ms:5000,bpm:120,waveform:Array(200).fill(1),
    onsets:peakTimes.map(at=>({at:at-30,peak_at:at,strength:1})),
    beats:Array.from({length:10},(_,i)=>({at:i*500,strength:0}))}};
assert.deepEqual(beatGrid(irregular,{timing:'hits'}).map(p=>p.at),peakTimes.map(t=>t+137));
for(const shape of BEAT_SHAPES){
    const down=generateBeatSection(irregular,0,4000,{mode:'manual',shape,followEnergy:false});
    assert.equal(down.settings.beatLanding,'down');assert.equal(down.settings.beatsPerCycle,1);
    for(const t of peakTimes.map(t=>t+137)){
        assert.equal(down.actions.find(p=>p.at===t)?.pos,10,`${shape}: low point exactly at drum peak ${t}`);
        assert.ok(evaluate(down.actions,t)<=evaluate(down.actions,t-10)&&evaluate(down.actions,t)<=evaluate(down.actions,t+10));
    }
    const up=generateBeatSection(irregular,0,4000,{mode:'manual',shape,beatLanding:'up',followEnergy:false});
    for(const t of peakTimes.map(t=>t+137))assert.equal(evaluate(up.actions,t),90);
}
const changing=structuredClone(irregular);changing.analysis.waveform=Array.from({length:200},(_,i)=>.02+.98*i/199);
const expressive=generateBeatSection(changing,0,4000,{mode:'manual',shape:'Sine Wave',followEnergy:true});
for(const t of peakTimes.map(t=>t+137))assert.ok(evaluate(expressive.actions,t)<=evaluate(expressive.actions,t-10)&&evaluate(expressive.actions,t)<=evaluate(expressive.actions,t+10),'Energy changes keep the downstroke on the hit');
const savedUp=generateBeatSection(audio,0,7000,{...options,peakOnBeat:true});
assert.deepEqual(savedUp.actions,generateBeatSection(audio,0,7000,{...options,beatLanding:'up'}).actions,'Saved peak-on-beat options retain their direction');
console.log('Precise drum peaks, irregular timing, down/up landing, energy envelopes and legacy options passed.');
