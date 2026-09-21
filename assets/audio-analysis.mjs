// Local onset analysis for isolated drum stems. Times stay on the audio clock.
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const median=xs=>{const a=[...xs].sort((x,y)=>x-y);return a.length?a[Math.floor(a.length/2)]:0;};
function hitPeak(samples,sampleRate,at,radius){
    // Refine the coarse spectral attack to the loudest 5 ms of this hit.
    const center=Math.round(at*sampleRate/1000),half=Math.max(1,Math.round(sampleRate*.0025));
    const start=Math.max(0,center-radius),end=Math.min(samples.length-1,center+radius);
    let power=0,best=-1,peak=center;
    for(let i=start-half;i<start+half;i++)power+=(samples[i]||0)**2;
    for(let i=start;i<=end;i++){
        if(power>best){best=power;peak=i;}
        power+=(samples[i+half]||0)**2-(samples[i-half]||0)**2;
    }
    return Math.round(peak/sampleRate*1000);
}
function hitDecay(samples,sampleRate,at,until){
    const half=Math.max(1,Math.round(sampleRate*.005)),powers=[];
    for(let time=at;time<=Math.max(at+20,until);time+=5){
        const center=Math.round(time*sampleRate/1000);let power=0;
        for(let i=center-half;i<center+half;i++)power+=(samples[i]||0)**2;
        powers.push(power/(half*2));
    }
    let peak=0;for(let i=1;i<Math.min(5,powers.length);i++)if(powers[i]>powers[peak])peak=i;
    let tail=peak+1;while(tail<powers.length-1&&(powers[tail]>powers[peak]*.137||powers[tail+1]>powers[peak]*.137))tail++;
    return clamp((tail-peak)*5,20,500);
}
function spectrum(real,imag){
    const n=real.length;
    for(let i=1,j=0;i<n;i++){let bit=n>>1;for(;j&bit;bit>>=1)j^=bit;j^=bit;if(i<j){[real[i],real[j]]=[real[j],real[i]];}}
    for(let len=2;len<=n;len*=2){
        const a=-2*Math.PI/len,cr=Math.cos(a),ci=Math.sin(a);
        for(let i=0;i<n;i+=len){let wr=1,wi=0;for(let j=0;j<len/2;j++){
            const k=i+j,l=k+len/2,tr=wr*real[l]-wi*imag[l],ti=wr*imag[l]+wi*real[l];
            real[l]=real[k]-tr;imag[l]=imag[k]-ti;real[k]+=tr;imag[k]+=ti;
            [wr,wi]=[wr*cr-wi*ci,wr*ci+wi*cr];
        }}
    }
}
export async function decodeBeatAudio(file){
    // Decoding directly at the analysis rate avoids retaining full-rate PCM.
    const context=new OfflineAudioContext(1,1,11025);
    let buffer;
    try{buffer=await context.decodeAudioData(await file.arrayBuffer());}
    catch{throw new Error('This browser could not decode the audio. Choose a WAV, FLAC or MP3 file.');}
    const mono=new Float32Array(buffer.length);
    for(let c=0;c<buffer.numberOfChannels;c++){
        const channel=buffer.getChannelData(c);for(let i=0;i<mono.length;i++)mono[i]+=channel[i]/buffer.numberOfChannels;
    }
    return {samples:mono,sampleRate:buffer.sampleRate};
}
export async function analyzeBeatAudio(samples,sampleRate,{progress=()=>{},cancelled=()=>false,character=false}={}){
    if(!samples.length||!Number.isFinite(sampleRate)||sampleRate<=0)throw new Error('The audio is empty.');
    const n=1024,hop=256,step=hop/sampleRate*1000,frames=Math.ceil(samples.length/hop);
    const flux=new Float32Array(frames),energy=new Float32Array(frames),previous=new Float32Array(n/2);
    const bandFlux=Array.from({length:3},()=>new Float32Array(frames));
    const bandPower=Array.from({length:3},()=>new Float32Array(frames));
    const brightness=character?new Float32Array(frames):null,bass=character?new Float32Array(frames):null;
    const timbreFrames=character?null:{centroid:new Float32Array(frames),flatness:new Float32Array(frames),pitch:new Float32Array(frames),tonality:new Float32Array(frames)};
    const real=new Float32Array(n),imag=new Float32Array(n),window=Float32Array.from({length:n},(_,i)=>.5-.5*Math.cos(2*Math.PI*i/(n-1)));
    const radius=Math.max(2,Math.round(180/step));
    let maxEnergy=0,maxFlux=0;
    for(let f=0;f<frames;f++){
        let power=0;imag.fill(0);
        for(let i=0;i<n;i++){const x=samples[f*hop+i-n/2]||0;real[i]=x*window[i];power+=x*x;}
        energy[f]=Math.sqrt(power/n);maxEnergy=Math.max(maxEnergy,energy[f]);spectrum(real,imag);
        let value=0,total=0,weighted=0,low=0,logPower=0,peakPower=0,peakBin=0;
        for(let i=1;i<n/2;i++){
            const magnitude=Math.hypot(real[i],imag[i]),v=Math.log1p(magnitude),attack=Math.max(0,v-previous[i]);value+=attack;previous[i]=v;
            const band=i*sampleRate/n<250?0:i*sampleRate/n<2000?1:2;
            bandFlux[band][f]+=attack;bandPower[band][f]+=magnitude*magnitude;
            const spectralPower=magnitude*magnitude;total+=spectralPower;weighted+=spectralPower*i/(n/2);if(i*sampleRate/n<250)low+=spectralPower;
            if(timbreFrames){logPower+=Math.log(spectralPower+1e-12);if(i*sampleRate/n>=30&&i*sampleRate/n<=4000&&spectralPower>peakPower){peakPower=spectralPower;peakBin=i;}}
        }
        if(character){brightness[f]=total?weighted/total:0;bass[f]=total?low/total:0;}
        if(timbreFrames){
            timbreFrames.centroid[f]=total?weighted/total*sampleRate/2:0;
            timbreFrames.flatness[f]=total?Math.exp(logPower/(n/2-1))/(total/(n/2-1)):0;
            if(peakBin){
                const power=i=>real[i]**2+imag[i]**2,a=power(peakBin-1),b=peakPower,c=power(peakBin+1);
                const shift=clamp(.5*(a-c)/(a-2*b+c||1),-.5,.5);
                timbreFrames.pitch[f]=(peakBin+shift)*sampleRate/n;
                timbreFrames.tonality[f]=total?clamp((a+b+c)/total,0,1):0;
            }
        }
        flux[f]=value;maxFlux=Math.max(maxFlux,value);
        if(f%128===0){if(cancelled())throw new Error('Audio analysis cancelled.');progress(f/frames*.75);await new Promise(r=>setTimeout(r,0));}
    }
    // Independent attack detection keeps a busy high band from hiding low hits.
    // These are frequency groups, not learned kick/snare instrument labels.
    const attacks=[],filtered=new Float32Array(samples.length);
    for(let band=0;band<3;band++){
        if(cancelled())throw new Error('Audio analysis cancelled.');
        const values=bandFlux[band];let maximum=0;for(const value of values)maximum=Math.max(maximum,value);
        if(!maximum)continue;
        // A band-limited signal refines each attack to its own loudness peak.
        const lowAlpha=1-Math.exp(-2*Math.PI*250/sampleRate),wideAlpha=1-Math.exp(-2*Math.PI*2000/sampleRate);
        let low=0,wide=0;
        for(let i=0;i<samples.length;i++){low+=lowAlpha*(samples[i]-low);wide+=wideAlpha*(samples[i]-wide);filtered[i]=band===0?low:band===1?wide-low:samples[i]-wide;}
        const hits=[];
        for(let i=1;i<frames-1;i++){
            const threshold=median(values.subarray(Math.max(0,i-radius),Math.min(frames,i+radius+1)))*1.5+maximum*.04;
            if(values[i]<=threshold||values[i]<values[i-1]||values[i]<=values[i+1]||energy[i]<maxEnergy*.01)continue;
            const power=bandPower.reduce((s,p)=>s+p[i],0),share=power?bandPower[band][i]/power:0;
            if(share<.015)continue;
            const strength=Math.round(clamp(values[i]/maximum*Math.sqrt(share),0,1)*1000)/1000;
            const hit={at:Math.round(i*step),peak_at:hitPeak(filtered,sampleRate,i*step,n/2),strength,bands:[0,0,0]};hit.bands[band]=strength;
            if(hits.length&&hit.peak_at-hits.at(-1).peak_at<65){if(strength>hits.at(-1).strength)hits[hits.length-1]=hit;}
            else hits.push(hit);
        }
        attacks.push(...hits);await new Promise(r=>setTimeout(r,0));
    }
    attacks.sort((a,b)=>a.peak_at-b.peak_at);
    const grouped=[];
    for(const hit of attacks){
        const previous=grouped.at(-1);
        if(previous&&hit.peak_at-previous.peak_at<=30){
            previous.bands=previous.bands.map((v,i)=>Math.max(v,hit.bands[i]));
            if(hit.strength>previous.strength){previous.at=hit.at;previous.peak_at=hit.peak_at;previous.strength=hit.strength;}
        }else grouped.push({...hit});
    }
    let timbres;
    if(timbreFrames){
        timbres=grouped.map((hit,index)=>{
            const frame=clamp(Math.round(hit.peak_at/step),0,frames-1),next=grouped[index+1]?.peak_at??samples.length/sampleRate*1000;
            let peakFrame=frame;
            for(let f=Math.max(0,frame-1);f<=Math.min(frames-1,frame+1);f++)if(energy[f]>energy[peakFrame])peakFrame=f;
            const power=bandPower.reduce((sum,band)=>sum+band[peakFrame],0),rounded=x=>Math.round(x*1000)/1000;
            return {at:hit.peak_at,bands:bandPower.map(b=>rounded(power?b[peakFrame]/power:0)),
                centroid_hz:Math.round(timbreFrames.centroid[peakFrame]),flatness:rounded(timbreFrames.flatness[peakFrame]),
                pitch_hz:Math.round(timbreFrames.pitch[peakFrame]),tonality:rounded(timbreFrames.tonality[peakFrame]),
                decay_ms:hitDecay(samples,sampleRate,hit.peak_at,Math.min(next-15,hit.peak_at+500))};
        });
    }
    const duration_ms=samples.length/sampleRate*1000;
    // Display peaks are bounded independently of clip duration.
    const count=Math.min(8000,frames),waveform=[];
    for(let i=0;i<count;i++){let peak=0;for(let j=Math.floor(i*frames/count);j<Math.floor((i+1)*frames/count);j++)peak=Math.max(peak,energy[j]);waveform.push(maxEnergy?Math.round(peak/maxEnergy*1000)/1000:0);}
    const onsets=[];
    for(let i=1;i<frames-1;i++){
        const threshold=median(flux.subarray(Math.max(0,i-radius),Math.min(frames,i+radius+1)))*1.5+maxFlux*.025;
        if(flux[i]<=threshold||flux[i]<flux[i-1]||flux[i]<=flux[i+1]||energy[i]<maxEnergy*.01)continue;
        const hit={at:Math.max(0,Math.round(i*step)),strength:Math.round(clamp(flux[i]/maxFlux,0,1)*1000)/1000};
        hit.peak_at=hitPeak(samples,sampleRate,hit.at,n/2);
        if(onsets.length&&hit.peak_at-onsets.at(-1).peak_at<90){if(hit.strength>onsets.at(-1).strength)onsets[onsets.length-1]=hit;}
        else onsets.push(hit);
    }
    progress(.8);if(cancelled())throw new Error('Audio analysis cancelled.');
    let period=0,best=0;
    // Correlation over 60–180 BPM, weighted toward common dance tempos.
    for(let lag=Math.ceil(60000/180/step);lag<=Math.floor(60000/60/step);lag++){
        let xy=0,xx=0,yy=0;
        for(let i=lag;i<frames;i++){xy+=flux[i]*flux[i-lag];xx+=flux[i]**2;yy+=flux[i-lag]**2;}
        const bpm=60000/(lag*step),score=xy/Math.sqrt(xx*yy||1)*Math.exp(-.5*(Math.log2(bpm/120)/.8)**2);
        if(score>best){best=score;period=lag*step;}
    }
    const beats=[];
    if(onsets.length>=3&&best>.07){
        // Choose the phase with the strongest repeated hits, then follow nearby
        // hits locally. Missing beats through quiet passages remain quiet.
        const first=onsets[0].at;
        let origin=first,phaseScore=-Infinity;
        for(const candidate of onsets.filter(h=>h.at<first+period*4)){
            let score=0;for(const h of onsets){const d=Math.abs((h.at-candidate.at)/period-Math.round((h.at-candidate.at)/period));score+=h.strength*Math.exp(-d*d/.0128);}
            if(score>phaseScore){phaseScore=score;origin=candidate.at;}
        }
        origin-=Math.floor(origin/period)*period;
        let cursor=0,expected=origin,local=period;
        while(expected<duration_ms){
            while(cursor<onsets.length&&onsets[cursor].at<expected-local*.22)cursor++;
            let hit=null,score=-Infinity;
            for(let j=cursor;j<onsets.length&&onsets[j].at<=expected+local*.22;j++){
                const s=onsets[j].strength-.5*Math.abs(onsets[j].at-expected)/local;
                if(s>score){score=s;hit=onsets[j];}
            }
            const at=hit?.at??Math.round(expected),strength=hit?.strength??0;
            if(!beats.length||at>beats.at(-1).at)beats.push({at,strength,...(hit?{peak_at:hit.peak_at}:{})});
            if(hit){
                if(beats.length>1&&beats.at(-2).strength)local=clamp(.9*local+.1*(at-beats.at(-2).at),period*.8,period*1.2);
                expected=at+local;
            }else expected+=local;
        }
    }
    const intervals=beats.slice(1).map((b,i)=>b.at-beats[i].at).sort((a,b)=>a-b),trim=Math.floor(intervals.length*.1);
    const central=intervals.slice(trim,intervals.length-trim),typical=central.reduce((sum,x)=>sum+x,0)/(central.length||1);
    let features;
    if(character){
        // Compact 100 ms averages describe musical texture without retaining PCM.
        const bins=Math.min(8000,Math.ceil(duration_ms/100));
        features={energy:[],brightness:[],bass:[],attack:[]};
        for(let i=0;i<bins;i++){
            const lo=Math.floor(i*frames/bins),hi=Math.max(lo+1,Math.floor((i+1)*frames/bins));
            let e=0,b=0,l=0,a=0;
            for(let j=lo;j<hi;j++){e+=energy[j]||0;b+=brightness[j]||0;l+=bass[j]||0;a+=flux[j]||0;}
            const size=hi-lo,rounded=x=>Math.round(x*1000)/1000;
            features.energy.push(rounded(maxEnergy?e/size/maxEnergy:0));features.brightness.push(rounded(b/size));
            features.bass.push(rounded(l/size));features.attack.push(rounded(maxFlux?a/size/maxFlux:0));
        }
    }
    progress(1);
    return {version:4,duration_ms:Math.round(duration_ms),waveform,bpm:typical?Math.round(600000/typical)/10:0,
        confidence:Math.round(clamp(best,0,1)*100)/100,beats,onsets,attacks:grouped,...(timbres?{timbres}:{}),...(features?{features}:{})};
}
