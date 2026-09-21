import {evaluate,roundEven,reduceActions,validateReference} from "./curve.mjs";
import {RHYTHM_PATTERNS,rhythmValue} from "./patterns.mjs";

export const BEAT_SHAPES=['Triangle','Sine Wave',...Object.keys(RHYTHM_PATTERNS)];
export const BEAT_CATALOG=[
    ['Triangle','Pulses','Even rise and fall.'],['Sine Wave','Flowing','A rounded continuous cycle.'],
    ['Smooth Bounce','Flowing','Smooth acceleration through a full bounce.'],['Quick Rise','Pulses','An early peak with a long return.'],
    ['Quick Fall','Pulses','A long rise with a quick return.'],['Double Tap','Accents','A strong tap followed by a smaller tap.'],
    ['Triple Tap','Accents','Three decreasing accents.'],['Hold High','Holds','Rise early and hold before returning.'],
    ['Hold Low','Holds','Pause low before a late lift.'],['Swing','Flowing','An asymmetric two-thirds rise.'],
    ['Staircase Up','Steps','Three rising levels.'],['Staircase Down','Steps','Three falling levels.'],
    ['Accent & Echo','Accents','A sharp accent followed by a quiet echo.'],['Half Stroke','Accents','A smaller bounce followed by a full bounce.'],
    ['Soft Pulse','Flowing','Rounded sides with a short high plateau.'],['Rounded Swing','Flowing','A smooth, late peak.'],
    ['Early Lift','Holds','A rounded early lift and long high hold.'],['Late Lift','Holds','A low pause and rounded late lift.'],
    ['Sharp Rebound','Pulses','Rebound sharply, hold high, then return.'],['Delayed Return','Holds','A smooth lift, high hold and late return.'],
    ['Double Bounce','Flowing','Two equal smooth bounces per cycle.'],['Triplet Bounce','Flowing','Three equal smooth bounces per cycle.'],
    ['Gallop','Accents','A full accent followed by a shorter rebound.'],['Reverse Echo','Accents','A small pickup before the main rise.'],
    ['Decaying Ripples','Accents','Several rebounds that decrease in size.'],['Step & Hold','Steps','Pause midway, then rise and hold.'],
    ['Four Step Rise','Steps','Four ascending levels before returning.'],['Four Step Fall','Steps','Four descending levels after the first rise.'],
].map(([name,family,description])=>({name,family,description}));
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const random=(seed,index)=>{let x=(seed^Math.imul(index+1,0x9e3779b9))>>>0;x=Math.imul(x^x>>>16,0x21f0aaad);x=Math.imul(x^x>>>15,0x735a2d97);return ((x^x>>>15)>>>0)/4294967296;};
function indexAt(points,at){let lo=0,hi=points.length;while(lo<hi){const m=(lo+hi)>>1;if(points[m].at<=at)lo=m+1;else hi=m;}return lo-1;}
function peakPhase(shape){
    if(!RHYTHM_PATTERNS[shape])return .5;
    return RHYTHM_PATTERNS[shape].find(p=>p[1]===1)[0];
}
export function beatShapeValue(shape,phase,landing='down'){
    phase=((phase+(landing==='up'?peakPhase(shape):0))%1+1)%1;
    return shape==='Triangle'?1-4*Math.abs(phase-.5):shape==='Sine Wave'?-Math.cos(phase*Math.PI*2):rhythmValue(shape,phase);
}
function catalogueShapes(family='all'){
    const names=BEAT_CATALOG.filter(p=>family==='all'||p.family===family).map(p=>p.name);
    if(!names.length)throw new Error('Choose a pattern family from the catalogue.');
    return names;
}
function envelopeAt(input,at){
    const {waveform,duration_ms}=input.analysis,t=at-(input.offset_ms||0);
    if(t<0||t>duration_ms||!waveform?.length)return 0;
    const x=clamp(t/duration_ms*waveform.length,0,waveform.length-1),i=Math.floor(x),fraction=x-i;
    return waveform[i]*(1-fraction)+(waveform[Math.min(i+1,waveform.length-1)]||0)*fraction;
}
function matchSoundShape(audio,mix,start,end,cycles,names,landing){
    const covered=input=>input?.analysis.waveform?.length&&Math.min(end,(input.offset_ms||0)+input.analysis.duration_ms)-Math.max(start,input.offset_ms||0)>=(end-start)*.8;
    const input=covered(mix)?mix:audio,source=input===mix?'dual':'beats',label=source==='dual'?'Full-mix':'Drum';
    const count=48,profiles=[];
    for(const [a,b]of cycles){
        if(b<=a||!input.analysis.waveform?.length||a<(input.offset_ms||0)||b>(input.offset_ms||0)+input.analysis.duration_ms)continue;
        const raw=Array.from({length:count},(_,i)=>envelopeAt(input,a+(b-a)*i/count));
        const sorted=[...raw].sort((a,b)=>a-b),low=sorted[Math.floor(count*.1)],high=sorted.at(-1),span=high-low;
        if(high<.01||span<Math.max(.015,high*.08))continue;
        profiles.push(raw.map(v=>clamp((v-low)/span,0,1)));
    }
    const fallback=names.includes('Sine Wave')?'Sine Wave':names.includes('Smooth Bounce')?'Smooth Bounce':names[0];
    if(!profiles.length)return {shape:fallback,source,reason:`${label} envelope has little usable variation; using ${fallback}.`+(mix&&source==='beats'?' Full mix does not cover this phrase; using drums.':''),match:null,alternatives:[]};
    // Loudness, not individual audio oscillations, is compared on the drum clock.
    // Fit each whole cycle and average errors, retaining repeated secondary accents.
    const ranked=names.map(shape=>{
        const candidate=Array.from({length:count},(_,i)=>{
            const value=beatShapeValue(shape,i/count,landing);return (1+(landing==='up'?value:-value))/2;
        });
        let error=0;
        for(const profile of profiles)for(let i=1;i<count;i++){
            const difference=candidate[i]-profile[i],slope=(candidate[i]-candidate[i-1])-(profile[i]-profile[i-1]);
            error+=difference*difference+.2*slope*slope;
        }
        return {shape,error:error/(profiles.length*(count-1))};
    }).sort((a,b)=>a.error-b.error||names.indexOf(a.shape)-names.indexOf(b.shape));
    const winner=ranked[0],similarity=error=>Math.round(clamp(1-Math.sqrt(error),0,1)*100);
    return {shape:winner.shape,source,match:similarity(winner.error),alternatives:ranked.slice(1,4).map(p=>({shape:p.shape,match:similarity(p.error)})),
        reason:`${label} envelope matched over ${profiles.length} cycles · ${similarity(winner.error)}% template similarity.`+(mix&&source==='beats'?' Full mix does not cover this phrase; using drums.':'')};
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
function timingGrid(audio,options={}){
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
export function beatGrid(audio,options={}){
    const {rhythm='original',density=1,lowFocus=.65,preserveSyncopation=true,maxHitsPerSecond=3}=options;
    if(rhythm==='original')return timingGrid(audio,options);
    if(!['accents','simplify','steady'].includes(rhythm)||![.5,1,2].includes(density)||!Number.isFinite(lowFocus)||lowFocus<0||lowFocus>1||!Number.isFinite(maxHitsPerSecond)||maxHitsPerSecond<.25||maxHitsPerSecond>8)
        throw new Error('Choose a rhythm, density, low-frequency emphasis and a hit limit between 0.25 and 8 per second.');
    const offset=audio.offset_ms||0;
    const hits=(audio.analysis.attacks??audio.analysis.onsets).map(p=>({...p,at:Math.round((p.peak_at??p.at)+offset),origin:'measured'})).sort((a,b)=>a.at-b.at);
    if(!hits.length)return [];
    const score=p=>p.bands?Math.max(p.bands[0]*(1+3*lowFocus),p.bands[1],p.bands[2]*(1-.8*lowFocus)):p.strength;
    const pulse=options.timing!=='tempo'&&audio.analysis.attacks?accentPulse(hits,score,offset,audio.analysis.duration_ms):
        timingGrid(audio,{...options,timing:options.timing==='tempo'?'tempo':'beats'});
    const median=values=>{const sorted=values.sort((a,b)=>a-b);return sorted.length?sorted[Math.floor(sorted.length/2)]:60000/(audio.analysis.bpm||120);};
    const localPeriod=at=>{
        const i=Math.max(0,indexAt(pulse,at)),neighbors=pulse.slice(Math.max(0,i-4),i+6);
        return clamp(median(neighbors.slice(1).map((p,j)=>p.at-neighbors[j].at)),200,2000);
    };
    if(rhythm==='steady'){
        if(pulse.length<2)throw new Error('No clear pulse. Choose Tempo grid and enter the BPM for Steady pulse.');
        const grid=[],minimum=Math.ceil(1000/maxHitsPerSecond);
        let at=pulse[0].at,period=localPeriod(at),last=-Infinity;
        while(at<=hits.at(-1).at+period/2){
            const lo=Math.max(0,indexAt(hits,at-period*.4)),near=hits.slice(lo,lo+12).filter(h=>Math.abs(h.at-at)<period*.4);
            if(at>=hits[0].at-period*.4&&Math.round(at)-last>=minimum&&near.length){
                const hit=near.reduce((a,b)=>score(a)>=score(b)?a:b);
                grid.push({at:Math.round(at),strength:hit.strength,bands:hit.bands,origin:'pulse'});last=Math.round(at);
            }
            period=.8*period+.2*localPeriod(at);at+=period/density;
        }
        return grid;
    }
    const candidates=hits.map((hit,i)=>{
        const period=localPeriod(hit.at),j=indexAt(pulse,hit.at);
        const distance=Math.min(...[pulse[j],pulse[j+1]].filter(Boolean).map(p=>Math.abs(p.at-hit.at)))/period;
        return {hit,i,period,onPulse:distance<=.18,score:score(hit)};
    });
    // Score relative to the local four-second phrase so quiet passages survive.
    let lo=0,hi=0;
    for(const c of candidates){
        while(lo<hits.length&&hits[lo].at<c.hit.at-2000)lo++;
        while(hi<hits.length&&hits[hi].at<=c.hit.at+2000)hi++;
        let peak=0;for(let j=lo;j<hi;j++)peak=Math.max(peak,score(hits[j]));
        c.relative=c.score/(peak||1);
    }
    const threshold=({'0.5':.5,'1':.3,'2':.14})[density];
    const eligible=candidates.filter(c=>c.relative>=threshold&&(preserveSyncopation||!pulse.length||c.onPulse));
    const blocked=new Set(),chosen=[];
    for(const c of eligible.sort((a,b)=>
        (b.relative*(rhythm==='simplify'&&b.onPulse?1.2:1))-(a.relative*(rhythm==='simplify'&&a.onPulse?1.2:1))||a.hit.at-b.hit.at)){
        if(blocked.has(c.i))continue;
        const gap=Math.max(Math.ceil(1000/maxHitsPerSecond),c.period*(rhythm==='simplify'?.75:.4)/density);
        chosen.push(c.hit);blocked.add(c.i);
        for(let j=c.i-1;j>=0&&c.hit.at-hits[j].at<gap;j--)blocked.add(j);
        for(let j=c.i+1;j<hits.length&&hits[j].at-c.hit.at<gap;j++)blocked.add(j);
    }
    return chosen.sort((a,b)=>a.at-b.at);
}

function accentPulse(hits,score,offset,duration){
    if(hits.length<3)return [];
    // Weighted autocorrelation of event times (60–180 BPM), then local tracking.
    // Low-emphasis changes the pulse evidence as well as accent selection.
    const bins=new Float64Array(201),weights=hits.map(score);
    for(let i=0;i<hits.length;i++)for(let j=i+1;j<hits.length&&hits[j].at-hits[i].at<=1030;j++){
        const delta=hits[j].at-hits[i].at;if(delta<300)continue;
        for(let bin=Math.max(67,Math.ceil((delta-30)/5));bin<=Math.min(200,Math.floor((delta+30)/5));bin++)
            bins[bin]+=weights[i]*weights[j]*Math.exp(-.5*((delta-bin*5)/15)**2);
    }
    let period=0,best=0;
    for(let bin=67;bin<=200;bin++){
        const value=bins[bin]*Math.exp(-.5*(Math.log2(500/(bin*5))/.8)**2);
        if(value>best){best=value;period=bin*5;}
    }
    if(!period)return [];
    const first=hits[0].at;let origin=hits[0];
    for(const hit of hits){if(hit.at>first+period*2)break;if(score(hit)>score(origin)*1.05)origin=hit;}
    let expected=origin.at-Math.floor((origin.at-offset)/period)*period,local=period,cursor=0,previous=null;
    const result=[];
    while(expected<offset+duration){
        while(cursor<hits.length&&hits[cursor].at<expected-local*.24)cursor++;
        let hit=null,best=-Infinity;
        for(let i=cursor;i<hits.length&&hits[i].at<=expected+local*.24;i++){
            const weight=weights[i]*Math.exp(-.5*((hits[i].at-expected)/(local*.16))**2);
            if(weight>best){best=weight;hit=hits[i];}
        }
        const at=hit?.at??Math.round(expected);
        result.push({at,strength:hit?.strength??0});
        if(hit&&previous)local=clamp(.8*local+.2*(hit.at-previous.at),period*.65,period*1.5);
        previous=hit;expected=at+local;
    }
    return result;
}

export const BEAT_SOUNDS=[
    ['auto','Auto · match drum stem','Automatic'],
    ['kick-deep','Deep kick','Kicks & toms'],['kick-punch','Punchy kick','Kicks & toms'],
    ['tom-low','Low tom','Kicks & toms'],['tom-high','High tom','Kicks & toms'],
    ['snare-dry','Dry snare','Snares & claps'],['snare-soft','Soft snare','Snares & claps'],['clap','Clap','Snares & claps'],
    ['hat-closed','Closed hat','High percussion'],['hat-open','Open hat','High percussion'],['shaker','Shaker','High percussion'],
    ['rim','Rim','Wood & clicks'],['wood','Woodblock','Wood & clicks'],['click','Click','Wood & clicks'],['low','Low percussion','Wood & clicks'],
].map(([id,label,group])=>({id,label,group}));
const percussionKit={
    'kick-deep':{pitch:55,decay:110,noise:.015,sweep:2.2,band:0},
    'kick-punch':{pitch:85,decay:65,noise:.08,sweep:2.8,band:0},
    'tom-low':{pitch:150,decay:130,noise:.035,sweep:.28,band:0},
    'tom-high':{pitch:290,decay:100,noise:.03,sweep:.22,band:1},
    'snare-dry':{pitch:185,decay:60,noise:.82,sweep:.12,band:1},
    'snare-soft':{pitch:170,decay:110,noise:.92,sweep:.05,band:1},
    clap:{pitch:900,decay:85,noise:1,sweep:0,band:1},
    'hat-closed':{pitch:3400,decay:25,noise:.96,sweep:0,band:2},
    'hat-open':{pitch:3000,decay:170,noise:.97,sweep:0,band:2},
    shaker:{pitch:2800,decay:60,noise:1,sweep:0,band:2},
    rim:{pitch:1700,decay:22,noise:.15,sweep:.08,band:1},
    wood:{pitch:780,decay:38,noise:.025,sweep:.06,band:1},
};
const finite=(value,fallback)=>Number.isFinite(value)?value:fallback;
function percussionVoice(id,timbre=null,gain=1){
    const preset=percussionKit[id];
    if(!preset)return {sound:id,gain};
    const pitched=preset.noise<.2&&timbre?.tonality>.3;
    return {sound:id,gain:Math.round(gain*1000)/1000,
        pitch_hz:Math.round(pitched?clamp(finite(timbre.pitch_hz,preset.pitch),preset.pitch*.7,preset.pitch*1.5):preset.pitch),
        decay_ms:Math.round(timbre?clamp(finite(timbre.decay_ms,preset.decay),preset.decay*.6,preset.decay*1.6):preset.decay)};
}
// These are approximate timbre recipes, not learned instrument identities.
// The event clock is independent of the selected percussion sound.
export function assignBeatSounds(events,sound='auto'){
    if(!BEAT_SOUNDS.some(p=>p.id===sound))throw new Error('Choose a percussion sound from the list.');
    return events.map(event=>{
        if(sound!=='auto')return {...event,percussion:{version:1,match:'manual',voices:[percussionVoice(sound)]}};
        const t=event.timbre,bands=t?.bands??event.bands??[1,0,0],sum=bands.reduce((s,v)=>s+Math.max(0,finite(v,0)),0)||1;
        const [low,mid,high]=bands.map(v=>Math.max(0,finite(v,0))/sum),pitch=finite(t?.pitch_hz,90),decay=finite(t?.decay_ms,60),tonal=finite(t?.tonality,0)>.3&&finite(t?.flatness,0)<.25;
        const bass=tonal&&pitch>=115?'tom-low':pitch<70?'kick-deep':'kick-punch';
        const treble=decay>100?'hat-open':decay>45?'shaker':'hat-closed';
        let voices;
        if(low>.3&&high>.22)voices=[percussionVoice(bass,t,Math.sqrt(low)),percussionVoice(treble,t,Math.sqrt(high)*.8)];
        else if(low>=mid&&low>=high)voices=[percussionVoice(bass,t)];
        else if(high>mid&&(high>.7||mid<.25))voices=[percussionVoice(tonal&&pitch<2600?'rim':treble,t)];
        else voices=[percussionVoice(tonal?(pitch<450?'tom-high':pitch<1200?'wood':'rim'):
            decay>110?'snare-soft':high>.18&&low<.1&&decay>55?'clap':'snare-dry',t)];
        return {...event,percussion:{version:1,match:t?'stem-timbre':event.bands?'band-fallback':'default',voices}};
    });
}
function percussionKernel(voices,sampleRate){
    const length=Math.ceil(sampleRate*.9),samples=new Float32Array(length);
    for(const voice of voices){
        const p=percussionKit[voice.sound],decay=voice.decay_ms/1000;
        const attack=voice.sound==='shaker'?.008:.0015,alpha=1-Math.exp(-2*Math.PI*(p.band===2?1800:700)/sampleRate);
        let filtered=0,phase=0,seed=2166136261;
        for(const char of voice.sound)seed=Math.imul(seed^char.charCodeAt(0),16777619)>>>0;
        for(let i=0;i<length;i++){
            const time=i/sampleRate;seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;
            const noise=(seed>>>0)/2147483648-1;filtered+=alpha*(noise-filtered);
            const colored=p.band===0?filtered:p.band===2?noise-filtered:noise*.65+filtered*.35;
            phase+=2*Math.PI*voice.pitch_hz*(1+p.sweep*Math.exp(-time*80))/sampleRate;
            const tone=Math.sin(phase)+.18*Math.sin(phase*1.53);
            let envelope=(1-Math.exp(-time/attack))*Math.exp(-time/decay);
            if(voice.sound==='clap')envelope*=time<.028?.25+.75*Math.max(0,Math.cos(time/ .009*Math.PI*2)):1;
            // Taper the truncated tail to zero, including the longest open hat.
            envelope*=clamp((length-i)/(sampleRate*.025),0,1);
            samples[i]+=voice.gain*envelope*(tone*(1-p.noise)+colored*p.noise);
        }
    }
    // Center the loudest 5 ms envelope on the event, as in the stem analyzer.
    const half=Math.max(1,Math.round(sampleRate*.0025));let power=0,best=-1,peak=0,maximum=0;
    for(let i=0;i<half;i++)power+=samples[i]**2;
    for(let i=0;i<length;i++){
        if(power>best){best=power;peak=i;}maximum=Math.max(maximum,Math.abs(samples[i]));
        power+=(samples[i+half]||0)**2-(samples[i-half]||0)**2;
    }
    if(maximum)for(let i=0;i<length;i++)samples[i]/=maximum;
    return {samples,peak};
}
// Listen and WAV use the same deterministic recipes. Legacy click/low kernels
// retain their sample-centered peaks; new sounds align their loudness envelopes.
export function renderBeatClicks(events,start,end,{sampleRate=22050,sound='click',ranges=[[start,end]]}={}){
    if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||end-start>1980000||![11025,22050,44100].includes(sampleRate))throw new Error('Choose a rhythm preview shorter than 33 minutes.');
    if(!Array.isArray(ranges)||ranges.some(r=>!Array.isArray(r)||r.length!==2||!r.every(Number.isFinite)||r[0]<start||r[1]>end||r[1]<=r[0]))throw new Error('Choose valid audio block ranges.');
    const windows=[];
    for(const [a,b]of [...ranges].sort((a,b)=>a[0]-b[0])){
        const previous=windows.at(-1);if(previous&&a<=previous[1])previous[1]=Math.max(previous[1],b);else windows.push([a,b]);
    }
    const assigned=assignBeatSounds(events,sound),cache=new Map();
    const samples=new Float32Array(Math.ceil((end-start)*sampleRate/1000));
    const half=Math.round(sampleRate*(sound==='low'?.025:.006)),frequency=sound==='low'?90:1200;
    for(const event of assigned){
        if(event.at<start||event.at>=end)continue;
        const window=windows.find(([a,b])=>event.at>=a&&event.at<b);if(!window)continue;
        const first=Math.ceil((window[0]-start)*sampleRate/1000),last=Math.ceil((window[1]-start)*sampleRate/1000);
        const center=Math.round((event.at-start)*sampleRate/1000),level=.15+.2*clamp(event.strength||0,0,1);
        if(sound==='click'||sound==='low'){
            for(let j=-half;j<=half;j++){
                const i=center+j;if(i<first||i>=last)continue;
                const envelope=(.5+.5*Math.cos(Math.PI*j/half))**2;
                samples[i]+=level*envelope*Math.cos(2*Math.PI*frequency*j/sampleRate);
            }
        }else{
            const voices=event.percussion.voices,key=JSON.stringify(voices);
            let kernel=cache.get(key);if(!kernel){kernel=percussionKernel(voices,sampleRate);if(cache.size>=128)cache.clear();cache.set(key,kernel);}
            for(let j=0;j<kernel.samples.length;j++){
                const i=center+j-kernel.peak;if(i>=first&&i<last)samples[i]+=level*kernel.samples[j];
            }
        }
    }
    let maximum=1;for(const sample of samples)maximum=Math.max(maximum,Math.abs(sample));
    if(maximum>1)for(let i=0;i<samples.length;i++)samples[i]/=maximum;
    return {samples,sampleRate};
}
export function beatClicksWav(events,start,end,options={}){
    const {samples,sampleRate}=renderBeatClicks(events,start,end,options),buffer=new ArrayBuffer(44+samples.length*2),view=new DataView(buffer);
    const text=(at,value)=>{for(let i=0;i<value.length;i++)view.setUint8(at+i,value.charCodeAt(i));};
    text(0,'RIFF');view.setUint32(4,buffer.byteLength-8,true);text(8,'WAVEfmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);
    view.setUint32(24,sampleRate,true);view.setUint32(28,sampleRate*2,true);view.setUint16(32,2,true);view.setUint16(34,16,true);text(36,'data');view.setUint32(40,samples.length*2,true);
    for(let i=0;i<samples.length;i++)view.setInt16(44+i*2,Math.round(clamp(samples[i],-1,1)*32767),true);
    return buffer;
}
export function generateBeatSection(audio,start,end,options={}){
    start=roundEven(start);end=roundEven(end);
    if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start)throw new Error('Mark a nonempty range on the audio row.');
    const settings={mode:'suggest',shape:'Smooth Bounce',timing:'hits',bpm:audio.analysis.bpm||120,beatsPerCycle:1,amplitude:40,center:50,followEnergy:true,seed:1,association:audio.mix?'dual':'beats',...options,
        beatLanding:options.beatLanding??(options.peakOnBeat===undefined?'down':options.peakOnBeat?'up':'shape')};
    const optimized=settings.rhythm&&settings.rhythm!=='original';
    if(optimized)settings.beatsPerCycle=1;
    const {mode,shape,beatsPerCycle,amplitude,center,seed}=settings;
    if(!['suggest','waveform','manual','random'].includes(mode)||!BEAT_SHAPES.includes(shape)||!['beats','dual'].includes(settings.association)||!['down','up','shape'].includes(settings.beatLanding))throw new Error('Choose a pattern mode, shape, beat landing and audio source.');
    if(![.5,1,2,4,8].includes(beatsPerCycle)||!Number.isFinite(amplitude)||amplitude<0||amplitude>50||!Number.isFinite(center)||center<0||center>100||!Number.isInteger(seed)||seed<0||seed>4294967295)throw new Error('Use 0–50 amplitude, 0–100 center and a valid cycle/seed.');
    const grid=beatGrid(audio,settings),offset=audio.offset_ms||0;
    if(grid.length<2)throw new Error('No clear beat grid. Try Drum peaks or enter a Tempo grid.');
    if(end<grid[0].at||start>grid.at(-1).at)throw new Error('This selection does not overlap the audio beats. Check the audio offset.');
    const mix=settings.association==='dual'?audio.mix:null;
    const catalogue=catalogueShapes(settings.patternFamily);
    const step=20,choices=new Map(),times=new Set([start,end]);
    const intervals=grid.slice(1).map((p,i)=>p.at-grid[i].at).sort((a,b)=>a-b);
    const reach=intervals[Math.floor(intervals.length/2)];
    if(optimized)for(const point of grid)for(const delta of [-.75,-.5,.5,.75]){
        const t=roundEven(point.at+delta*reach);if(t>start&&t<end)times.add(t);
    }
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
        if(mode==='waveform'){
            const cycles=[];for(let beat=phrase*8;beat<phrase*8+8;beat+=beatsPerCycle)cycles.push([atBeat(beat),atBeat(beat+beatsPerCycle)]);
            const result={start:Math.max(start,Math.round(a)),end:Math.min(end,Math.round(b)),...matchSoundShape(audio,mix,a,b,cycles,catalogue,settings.beatLanding)};
            choices.set(phrase,result);return result;
        }
        const strength=hits.reduce((s,p)=>s+p.strength,0)/(hits.length||1),tempo=480000/Math.max(1,b-a);
        const pool=settings.patternFamily!==undefined?catalogue:tempo>145?['Smooth Bounce','Swing','Quick Rise','Hold High']:['Smooth Bounce','Double Tap','Half Stroke','Accent & Echo','Hold Low','Staircase Up'];
        let selected=mode==='manual'?shape:mode==='random'?pool[Math.floor(random(seed,phrase)*pool.length)]:
            strength<.3?'Smooth Bounce':hits.length>12&&tempo<145?'Double Tap':strength>.6?'Quick Rise':'Swing';
        let reason=mode==='manual'?'Your chosen shape.':mode==='random'?(settings.patternFamily!==undefined?'Repeatable variation from the selected catalogue family.':'Repeatable variation from the drum-tempo pattern pool.'):'Drum tempo, attack density and strength.',source='beats';
        const profile=mixWindow(mix,a,b);
        if(profile&&mode!=='manual'&&!(mode==='random'&&settings.patternFamily!==undefined)){
            const mixHits=mix.analysis.onsets.filter(p=>p.at+(mix.offset_ms||0)>=a&&p.at+(mix.offset_ms||0)<b).length;
            const offbeat=hits.filter(h=>{const i=clamp(indexAt(grid,h.at+offset),0,grid.length-2),phase=(h.at+offset-grid[i].at)/(grid[i+1].at-grid[i].at);return phase>.2&&phase<.8;}).length/(hits.length||1);
            const ranked=rankShapes(profile,hits,mixHits,tempo,offbeat),candidates=ranked.slice(0,3).filter(p=>p[1]>=ranked[0][1]*.65);
            const chosen=mode==='random'?candidates[Math.floor(random(seed,phrase)*candidates.length)]:ranked[0];
            [selected,,reason]=chosen;source='dual';
        }else if(profile){source='dual';reason+=' Full-mix energy is available for amplitude.';}
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
        const chosen=choice(Math.max(0,Math.floor(beat/8))).shape,value=beatShapeValue(chosen,cycle,settings.beatLanding);
        const gainTime=cycle-(settings.beatLanding==='shape'?.5:0),a=Math.floor(gainTime),fraction=gainTime-a,weight=fraction*fraction*(3-2*fraction);
        let intensity=at<offset||at>offset+audio.analysis.duration_ms?0:cycleGain(a)*(1-weight)+cycleGain(a+1)*weight;
        if(optimized){
            const nearest=Math.min(Math.abs(at-grid[i].at),Math.abs(at-grid[i+1].at)),fade=clamp((nearest/reach-.5)/.25,0,1);
            intensity*=1-fade*fade*(3-2*fade);
        }
        return {at,pos:roundEven(clamp(center+amplitude*value*intensity,0,100))};
    });
    const actions=reduceActions(values,{protectedTimes:grid.map(p=>roundEven(p.at))}).actions;
    const decisions=[...choices.values()].filter(d=>d.end>d.start);
    const association=decisions.some(d=>d.source==='dual')?'drums + full mix':mix?'drums · full mix outside range':'drums';
    const events=[];
    for(let beat=0;beat<=grid.length-1;beat+=beatsPerCycle){
        const p=grid[Math.floor(beat)],at=roundEven(atBeat(beat));if(at<start||at>=end)continue;
        const descriptors=audio.analysis.timbres||[],sourceAt=at-(audio.offset_ms||0),index=indexAt(descriptors,sourceAt);
        const nearest=[descriptors[index],descriptors[index+1]].filter(Boolean).sort((a,b)=>Math.abs(a.at-sourceAt)-Math.abs(b.at-sourceAt))[0];
        // Reconstructed pulses may borrow a nearby hit's timbre, never its time.
        const timbre=nearest&&Math.abs(nearest.at-sourceAt)<=500?{...nearest,bands:[...nearest.bands],source_at:nearest.at,source_offset_ms:audio.offset_ms||0}:null;
        events.push({at,strength:p.strength,...(p.bands?{bands:p.bands}:{}),...(timbre?{timbre}:{}),origin:!Number.isInteger(beat)?'subdivision':p.origin??(settings.timing==='tempo'||!p.strength?'pulse':'measured')});
    }
    const rhythmLabel=({accents:'Follow accents',simplify:'Simplify groove',steady:'Steady pulse'})[settings.rhythm];
    return {start,end,settings,actions,decisions,events,summary:`${rhythmLabel?rhythmLabel+' · ':''}${mode==='waveform'?'Auto sound match':mode==='suggest'?'Suggested':mode==='random'?'Random':'Manual'} · ${[...new Set(decisions.map(d=>d.shape))].join(', ')} · ${beatsPerCycle} beats/cycle · ${events.length} timing hits · ${association} · ${actions.length} points`};
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
        ...(section.events?{events:section.events.filter(p=>p.at>=start&&p.at<end)}:{}),
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
        ...(parts.every(s=>s.events)?{events:parts.flatMap(s=>s.events)}:{events:undefined}),
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
