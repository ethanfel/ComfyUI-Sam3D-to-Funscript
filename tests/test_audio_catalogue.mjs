import assert from 'node:assert/strict';
import {BEAT_SHAPES,BEAT_CATALOG,beatShapeValue,generateBeatSection,savedBeatSelection} from '../assets/audio-patterns.mjs';
import {analyzeBeatAudio} from '../assets/audio-analysis.mjs';
import {evaluate,validateReference} from '../assets/curve.mjs';

assert.equal(BEAT_SHAPES.length,28);assert.equal(BEAT_CATALOG.length,28);
assert.deepEqual(new Set(BEAT_CATALOG.map(p=>p.name)),new Set(BEAT_SHAPES));
for(const entry of BEAT_CATALOG){
    assert.ok(entry.family&&entry.description);
    for(let i=0;i<=1000;i++){const value=beatShapeValue(entry.name,i/1000);assert.ok(Number.isFinite(value)&&value>=-1-1e-9&&value<=1+1e-9,entry.name);}
    assert.equal(beatShapeValue(entry.name,0),-1);assert.ok(Math.abs(beatShapeValue(entry.name,0,'up')-1)<1e-9);
}
const duration_ms=8000,beats=Array.from({length:17},(_,i)=>({at:i*500,strength:1}));
const analysis={duration_ms,bpm:120,beats,onsets:beats,waveform:Array(duration_ms).fill(1)};
const stem={offset_ms:0,analysis};
const smooth=p=>(1+Math.cos(2*Math.PI*p))/2;
const double=p=>(1+Math.cos(4*Math.PI*p))/2;
const sharp=p=>Math.exp(-16*p);
const held=p=>p<.55?1:p<.75?1-(p-.55)/.2:(p-.75)/.25;
const makeMix=fn=>({offset_ms:0,analysis:{...analysis,waveform:Array.from({length:duration_ms},(_,at)=>fn((at%500)/500,at))}});
const settings={mode:'waveform',association:'dual',followEnergy:false};
for(const [fn,expected]of [[smooth,'Sine Wave'],[double,'Double Bounce'],[sharp,'Sharp Rebound'],[held,'Hold Low']]){
    const audio={...stem,mix:makeMix(fn)},result=generateBeatSection(audio,0,duration_ms,settings);
    assert.ok(result.decisions.every(d=>d.shape===expected),expected);
    assert.ok(result.decisions.every(d=>d.source==='dual'&&d.match>=70&&d.match<=100));
    assert.ok(result.decisions.every(d=>d.alternatives.length===3&&d.alternatives.every(p=>p.shape!==d.shape&&p.match<=d.match)));
    assert.deepEqual(result.events.map(p=>p.at),beats.slice(0,-1).map(p=>p.at),'Sound matching leaves drum event timing untouched');
    for(const p of result.events)assert.equal(evaluate(result.actions,p.at),10,'Down landing is fixed to the drum clock');
    validateReference({actions:result.actions});
    assert.deepEqual(result,generateBeatSection(audio,0,duration_ms,settings),'Auto matching is deterministic');
    const reopened=JSON.parse(JSON.stringify(result));
    assert.deepEqual(savedBeatSelection([reopened],0,duration_ms).decisions,result.decisions,'Match explanations survive saving and selection');
    assert.deepEqual(generateBeatSection(audio,0,duration_ms,{...settings,association:'beats'}).actions,generateBeatSection(stem,0,duration_ms,{...settings,association:'beats'}).actions,'Disabling the mix restores stem-only matching');
}
const shifted={...stem,offset_ms:137,mix:{...makeMix(double),offset_ms:137}};
const shiftedResult=generateBeatSection(shifted,137,duration_ms+137,settings);
assert.ok(shiftedResult.decisions.every(d=>d.shape==='Double Bounce'));
assert.deepEqual(shiftedResult.events.map(p=>p.at),beats.slice(0,-1).map(p=>p.at+137));
const uncovered={...stem,mix:{...makeMix(double),offset_ms:20000}};
const fallback=generateBeatSection(uncovered,0,duration_ms,settings);
assert.ok(fallback.decisions.every(d=>d.source==='beats'&&d.reason.includes('does not cover')));
assert.deepEqual(fallback.actions,generateBeatSection(stem,0,duration_ms,settings).actions);
const partial={...stem,mix:{...makeMix(double),offset_ms:2000}};
const partly=generateBeatSection(partial,0,duration_ms,settings);
assert.equal(partly.decisions[0].source,'beats');assert.equal(partly.decisions[1].source,'dual');
const quiet={...stem,analysis:{...analysis,waveform:Array(8000).fill(0)}};
const silent=generateBeatSection(quiet,0,duration_ms,{...settings,followEnergy:true});
assert.ok(silent.decisions.every(d=>d.match===null&&/little usable variation/.test(d.reason)));
assert.ok(silent.actions.every(p=>p.pos===50));
const switching={...stem,mix:makeMix((phase,at)=>at<4000?smooth(phase):double(phase))};
const changed=generateBeatSection(switching,0,duration_ms,settings);
assert.deepEqual(changed.decisions.map(d=>[d.start,d.end,d.shape]),[[0,4000,'Sine Wave'],[4000,8000,'Double Bounce']]);
assert.equal(evaluate(changed.actions,4000),10,'Pattern changes meet at the primary landing');
assert.equal(changed.actions.filter(p=>p.at===4000).length,1);
for(const family of new Set(BEAT_CATALOG.map(p=>p.family))){
    const allowed=BEAT_CATALOG.filter(p=>p.family===family).map(p=>p.name);
    for(const mode of ['waveform','random']){
        const s=generateBeatSection(switching,0,8000,{...settings,mode,patternFamily:family,seed:42});
        assert.ok(s.decisions.every(d=>allowed.includes(d.shape)),`${mode}: ${family}`);
    }
}
assert.throws(()=>generateBeatSection(stem,0,8000,{...settings,patternFamily:'unknown'}),/family/);
// Real signal analysis: a slowly varying carrier envelope produces a flowing match.
const rate=11025,samples=Float32Array.from({length:rate*8},(_,i)=>(.2+.8*smooth((i/rate%1)))*Math.sin(2*Math.PI*440*i/rate));
const measured=await analyzeBeatAudio(samples,rate,{character:true});
const slowBeats=Array.from({length:9},(_,i)=>({at:i*1000,strength:1}));
const actual=generateBeatSection({analysis:{...analysis,beats:slowBeats,onsets:slowBeats},mix:{analysis:measured}},0,8000,settings);
assert.ok(actual.decisions.every(d=>['Sine Wave','Smooth Bounce'].includes(d.shape)));
assert.ok(actual.decisions[0].match>85);
console.log('28 catalogue shapes, envelope-driven association, alternative matches, phrase changes, fixed timing, silence, offsets, family filters and real-signal analysis passed.');
