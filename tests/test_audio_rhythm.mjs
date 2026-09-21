import assert from 'node:assert/strict';
import {analyzeBeatAudio} from '../assets/audio-analysis.mjs';
import {beatGrid,generateBeatSection,renderBeatClicks,beatClicksWav,sliceBeatSection,savedBeatSelection} from '../assets/audio-patterns.mjs';
import {evaluate,validateReference} from '../assets/curve.mjs';

const rate=11025,pcm=new Float32Array(rate*12);
function hit(time,frequency,amplitude=.8){
    for(let i=0;i<rate*.07;i++)pcm[Math.round(time*rate)+i]+=amplitude*Math.sin(i/rate*2*Math.PI*frequency)*Math.exp(-i/rate*75);
}
for(let t=1;t<11;t+=.125)hit(t,(t-1)%.5===0?90:3000,(t-1)%.5===0?.8:.3);
const analysis=await analyzeBeatAudio(pcm,rate),audio={offset_ms:137,analysis};
assert.equal(analysis.version,4);
assert.ok(analysis.attacks.filter(p=>p.bands[0]>.5).length>=19,'Low hits survive dense high percussion');
assert.ok(analysis.attacks.filter(p=>p.bands[2]>.5).length>=50,'High percussion is measured separately');
const base={rhythm:'simplify',density:1,lowFocus:.65,maxHitsPerSecond:3,timing:'hits'};
const clean=beatGrid(audio,base),original=beatGrid(audio,{timing:'hits'});
assert.ok(clean.length>=19&&clean.length<=21);assert.ok(clean.length<original.length/2);
assert.ok(clean.every(p=>p.bands[0]>.5),'Balanced groove retains low accents over busy high hits');
assert.ok(clean.every(p=>analysis.attacks.some(h=>h.peak_at+137===p.at)),'Groove never quantizes retained hit times');
assert.deepEqual(clean,beatGrid(audio,base),'Deterministic event selection');
assert.deepEqual(beatGrid({...audio,mix:{analysis:{features:{}}}},base),clean,'Full mix never moves rhythm events');
for(const rhythm of ['accents','simplify','steady']){
    let last=0;
    for(const density of [.5,1,2]){
        const events=beatGrid(audio,{...base,rhythm,density,maxHitsPerSecond:8});
        assert.ok(events.length>=last,`${rhythm}: density increases retained events`);last=events.length;
        assert.ok(events.slice(1).every((p,i)=>p.at-events[i].at>=125));
    }
    const events=beatGrid(audio,{...base,rhythm,density:2,maxHitsPerSecond:1.5});
    assert.ok(events.slice(1).every((p,i)=>p.at-events[i].at>=Math.ceil(1000/1.5)),`${rhythm}: event cap`);
}
const steady=beatGrid(audio,{...base,rhythm:'steady'});
assert.ok(steady.slice(1).every((p,i)=>Math.abs(p.at-steady[i].at-500)<=5),'Weighted pulse finds 120 BPM despite high-band subdivisions');
assert.ok(steady.every(p=>p.origin==='pulse'));
const lessLow=beatGrid(audio,{...base,rhythm:'accents',lowFocus:0,density:2,maxHitsPerSecond:8});
assert.ok(lessLow.length>clean.length,'Low-frequency emphasis can be disabled');

// Mid-band transients and distinct measured peaks, not just low/high fixtures.
pcm.fill(0);for(const t of [1,2,3,4])hit(t,800);
const mid=await analyzeBeatAudio(pcm,rate);
assert.equal(mid.attacks.filter(p=>p.bands[1]>.5).length,4);
const silence=await analyzeBeatAudio(new Float32Array(rate),rate);
assert.deepEqual(silence.attacks,[]);
assert.deepEqual(beatGrid({analysis:silence},base),[]);
await assert.rejects(analyzeBeatAudio(pcm,rate,{cancelled:()=>true}),/cancelled/);

const offbeat={analysis:{duration_ms:5000,bpm:120,waveform:Array(100).fill(1),
    beats:Array.from({length:10},(_,i)=>({at:i*500,strength:1})),
    onsets:[0,500,1000,1333,1500,2000,2500,2833,3000,3500,4000,4500].map(at=>({at,strength:1}))}};
const kept=beatGrid(offbeat,{...base,rhythm:'accents',density:2,maxHitsPerSecond:8});
assert.ok(kept.some(p=>p.at===1333));
const regular=beatGrid(offbeat,{...base,rhythm:'accents',density:2,maxHitsPerSecond:8,preserveSyncopation:false});
assert.ok(!regular.some(p=>p.at===1333));assert.ok(regular.some(p=>p.at===1500));
assert.deepEqual(beatGrid(offbeat),beatGrid(offbeat,{rhythm:'original'}),'Legacy timing is unchanged');
assert.throws(()=>beatGrid(offbeat,{...base,maxHitsPerSecond:0}),/hit limit/);
assert.throws(()=>beatGrid(offbeat,{...base,lowFocus:NaN}),/rhythm/);

for(const beatLanding of ['down','up']){
    const s=generateBeatSection({...audio,analysis:{...analysis,waveform:Array(200).fill(1)}},0,12000,{...base,mode:'manual',shape:'Triangle',beatLanding,followEnergy:false,amplitude:30});
    validateReference({actions:s.actions});
    assert.deepEqual(s.events.map(p=>p.at),clean.map(p=>p.at));
    for(const event of s.events)assert.equal(evaluate(s.actions,event.at),beatLanding==='down'?20:80,'Exact primary landing at each saved event');
    assert.equal(evaluate(s.actions,0),50,'Quiet lead-in is held at center');
    assert.equal(evaluate(s.actions,12000),50,'No extrapolated motion after the rhythm ends');
    for(const sound of ['click','low']){
        const rendered=renderBeatClicks(s.events,s.start,s.end,{sound});
        for(const event of s.events){
            const index=Math.round((event.at-s.start)*rendered.sampleRate/1000),level=Math.abs(rendered.samples[index]);
            assert.ok(level>.1);
            for(let j=-30;j<=30;j++)assert.ok(Math.abs(rendered.samples[index+j])<=level+1e-6,'Audible peak equals the curve event, within one audio sample');
        }
        const wav=new DataView(beatClicksWav(s.events,s.start,s.end,{sound}));
        assert.equal(wav.getUint32(24,true),rendered.sampleRate);assert.equal(wav.byteLength,44+rendered.samples.length*2);
        assert.equal(wav.getInt16(44+Math.round(s.events[0].at*rendered.sampleRate/1000)*2,true),Math.round(rendered.samples[Math.round(s.events[0].at*rendered.sampleRate/1000)]*32767));
    }
    const left=sliceBeatSection(s,0,6000),right=sliceBeatSection(s,6000,12000),joined=savedBeatSelection([left,right],0,12000);
    assert.deepEqual(joined.events,s.events,'Splitting and copying does not lose or duplicate shared boundary events');
}
const gaps=structuredClone(offbeat);gaps.analysis.onsets=gaps.analysis.onsets.filter(p=>p.at<1500||p.at>=4000);
const quiet=generateBeatSection(gaps,0,5000,{...base,rhythm:'accents',mode:'manual',shape:'Triangle',followEnergy:false});
assert.equal(evaluate(quiet.actions,2500),50,'Long missing-hit gaps hold center');
const legacy={start:0,end:1000,actions:[{at:0,pos:50},{at:1000,pos:50}],settings:{}};
assert.equal(savedBeatSelection([legacy],0,1000).events,undefined,'Old saved curves are not assigned invented events');
assert.throws(()=>renderBeatClicks([],0,2000000),/33 minutes/);
console.log('Multiband attacks, accent weighting, density, syncopation, pulse rebuilding, exact motion/audio peaks, rate limits, silence and saved timing passed.');
// Pulse tempo follows a change instead of imposing a whole-song BPM.
const changing=[];let at=500;
for(let i=0;i<40;i++){changing.push({at,strength:1,bands:[1,0,0]});at+=i<20?500:600;}
const tempo={analysis:{duration_ms:at,bpm:120,onsets:changing,attacks:changing,beats:[],waveform:Array(200).fill(1)}};
const followed=beatGrid(tempo,{...base,rhythm:'steady'});
assert.ok(followed.slice(1,10).every((p,i)=>Math.abs(p.at-followed[i].at-500)<5));
assert.ok(followed.slice(-5).every((p,i,points)=>!i||Math.abs(p.at-points[i-1].at-600)<10));
// Original half-beat patterns have two primary landings per beat interval.
const half=generateBeatSection(offbeat,0,2000,{rhythm:'original',timing:'beats',beatsPerCycle:.5,mode:'manual',shape:'Triangle',followEnergy:false});
assert.deepEqual(half.events.map(p=>p.at),[0,250,500,750,1000,1250,1500,1750]);
for(const event of half.events)assert.equal(evaluate(half.actions,event.at),10);
console.log('Local tempo changes and legacy half-beat audio/motion events passed.');
