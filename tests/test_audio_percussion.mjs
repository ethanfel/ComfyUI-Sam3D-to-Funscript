import assert from 'node:assert/strict';
import {analyzeBeatAudio} from '../assets/audio-analysis.mjs';
import {BEAT_SOUNDS,assignBeatSounds,renderBeatClicks,beatClicksWav,generateBeatSection,sliceBeatSection} from '../assets/audio-patterns.mjs';

// Independently constructed low tone, tom, broadband snare and high noise.
const rate=11025,pcm=new Float32Array(rate*5);let seed=12;
for(const [at,frequency,noise,decay]of [[.5,60,0,.1],[1.5,200,0,.12],[2.5,400,.8,.07],[3.5,3500,1,.03]]){
    let low=0;
    for(let i=0;i<rate*.65;i++){
        seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;
        const value=(seed>>>0)/2147483648-1;low+=.65*(value-low);
        const taper=Math.min(1,(rate*.65-i)/(rate*.05));
        pcm[Math.round(at*rate)+i]=taper*Math.exp(-i/rate/decay)*((1-noise)*Math.sin(2*Math.PI*frequency*i/rate)+noise*(frequency>2000?value-low:value));
    }
}
const analysis=await analyzeBeatAudio(pcm,rate);
assert.equal(analysis.version,4);
const descriptors=[500,1500,2500,3500].map(at=>analysis.timbres.find(t=>Math.abs(t.at-at)<35));
assert.ok(descriptors.every(Boolean),'Every isolated hit gets a timbre measurement');
assert.ok(Math.abs(descriptors[0].pitch_hz-60)<10);assert.ok(Math.abs(descriptors[1].pitch_hz-200)<10);
assert.ok(descriptors[0].tonality>.8&&descriptors[2].tonality<.2);
assert.ok(descriptors[0].flatness<.01&&descriptors[2].flatness>.25);
assert.ok(descriptors[3].bands[2]>.7&&descriptors[0].bands[0]>.9);
assert.ok(descriptors[0].decay_ms>descriptors[3].decay_ms*2,'Kick decay is longer than the short hat');
const events=descriptors.map(t=>({at:t.at+137,strength:.8,timbre:t})),before=structuredClone(events);
const assigned=assignBeatSounds(events);
assert.deepEqual(assigned.map(e=>e.percussion.voices[0].sound),['kick-deep','tom-low','clap','hat-closed']);
assert.ok(assigned.every(e=>e.percussion.match==='stem-timbre'));
assert.deepEqual(events,before,'Sound recipes never mutate saved timing or timbre');
assert.deepEqual(assigned.map(e=>e.at),events.map(e=>e.at));
assert.deepEqual(assignBeatSounds(JSON.parse(JSON.stringify(events))),assigned,'Offline recipes are deterministic');
assert.equal(assignBeatSounds([{at:100,bands:[.7,0,.3]}])[0].percussion.voices.length,2,'Mixed low/high hit layers two voices');
assert.equal(assignBeatSounds([{at:100,bands:[0,0,1]}])[0].percussion.match,'band-fallback');
assert.equal(assignBeatSounds([{at:100}])[0].percussion.match,'default');
assert.throws(()=>assignBeatSounds(events,'missing'),/percussion sound/);

function loudest(samples,rate){
    const half=Math.round(rate*.0025);let power=0,maximum=-1,at=0;
    for(let i=0;i<half;i++)power+=samples[i]**2;
    for(let i=0;i<samples.length;i++){
        if(power>maximum){maximum=power;at=i;}
        power+=(samples[i+half]||0)**2-(samples[i-half]||0)**2;
    }
    return at/rate*1000;
}
const signatures=new Set();
for(const {id:sound}of BEAT_SOUNDS){
    const options={sound},hit=[{...events[0],at:500}];
    const rendered=renderBeatClicks(hit,0,1500,options);
    assert.equal(rendered.samples.length,33075);
    assert.ok(rendered.samples.every(x=>Number.isFinite(x)&&Math.abs(x)<=1));
    assert.ok(Math.abs(loudest(rendered.samples,rendered.sampleRate)-500)<1,`${sound} loudness peak is on the event`);
    assert.deepEqual(rendered,renderBeatClicks(hit,0,1500,options));
    signatures.add(Buffer.from(rendered.samples.buffer).toString('base64'));
    const wav=new DataView(beatClicksWav(hit,0,1500,options));
    assert.equal(wav.getUint32(24,true),rendered.sampleRate);
    for(let i=0;i<rendered.samples.length;i++)assert.equal(wav.getInt16(44+i*2,true),Math.round(rendered.samples[i]*32767)||0);
    const outside=renderBeatClicks([{at:-1},{at:1500}],0,1500,options);
    assert.ok(outside.samples.every(x=>x===0),'Only events within the marked range sound');
}
assert.equal(signatures.size,BEAT_SOUNDS.length,'Every kit choice has a distinct waveform');
for(const sampleRate of [11025,44100]){
    const rendered=renderBeatClicks([{...events[2],at:500}],0,1500,{sampleRate,sound:'auto'});
    assert.ok(Math.abs(loudest(rendered.samples,sampleRate)-500)<1);
}
const crowded=renderBeatClicks(Array.from({length:100},(_,i)=>({at:100+i,strength:1})),0,1000,{sound:'hat-open'});
assert.ok(crowded.samples.every(x=>Math.abs(x)<=1),'Overlapping tails cannot clip the WAV');
const gap=renderBeatClicks([{at:490,strength:1},{at:810,strength:1}],0,1500,{sound:'hat-open',ranges:[[0,500],[800,1500]]});
assert.ok(gap.samples.slice(11025,17640).every(x=>x===0),'Long tails and pre-peak attacks cannot bleed into unselected blocks');
assert.deepEqual(renderBeatClicks(events,0,5000,{sound:'auto',ranges:[[0,1000],[1000,5000]]}),renderBeatClicks(events,0,5000,{sound:'auto'}),'Adjacent blocks keep continuous percussion tails');
const audio={analysis,offset_ms:137};
const section=generateBeatSection(audio,0,5000,{timing:'hits',mode:'manual',shape:'Triangle',followEnergy:false});
assert.ok(section.events.every(e=>e.timbre));
assert.ok(section.events.every(e=>Math.abs(e.at-e.timbre.source_at-137)<40),'Saved timbres keep source offset provenance');
const sliced=sliceBeatSection(section,1000,3000);
assert.deepEqual(sliced.events,section.events.filter(e=>e.at>=1000&&e.at<3000));
const legacy=generateBeatSection({analysis:{...analysis,timbres:undefined},offset_ms:137},0,5000,section.settings);
assert.deepEqual(section.actions,legacy.actions,'Adding timbre analysis never alters motion');
assert.deepEqual(section.events.map(e=>e.at),legacy.events.map(e=>e.at));
assert.deepEqual((await analyzeBeatAudio(new Float32Array(rate),rate)).timbres,[]);
console.log('Percussion timbre analysis, automatic/layered recipes, 15 kit choices, exact envelope peaks, deterministic WAV, clipping protection, saved/offline metadata and motion independence passed.');
