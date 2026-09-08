export function correctedMotion(times, shifts, valid, anchor, sections) {
    const output=shifts.map(p=>p.slice()),quality=valid.map(v=>v?"tracked":"held"),used=new Set();
    for(const section of sections){
        const keys=[...(section.keys||[])].sort((a,b)=>a.at_ms-b.at_ms);
        if(!keys.length)continue;
        if(keys.some((k,i)=>!Number.isFinite(k.at_ms)||!Array.isArray(k.xy)||k.xy.length!==2||!k.xy.every(Number.isFinite)||(i&&k.at_ms<=keys[i-1].at_ms)))throw new Error("Correction keys need distinct times and finite positions");
        if(keys[0].at_ms<times[0]-.001||keys.at(-1).at_ms>times.at(-1)+.001)throw new Error("Correction lies outside the analyzed frames");
        const nearest=keys.length===1?times.reduce((best,t,i)=>Math.abs(t-keys[0].at_ms)<Math.abs(times[best]-keys[0].at_ms)?i:best,0):-1;
        let segment=0;
        times.forEach((t,i)=>{
            if(keys.length===1?i!==nearest:t<keys[0].at_ms-.001||t>keys.at(-1).at_ms+.001)return;
            if(used.has(i))throw new Error("Manual sections overlap; edit or split them before applying");
            used.add(i);
            while(segment+1<keys.length-1&&keys[segment+1].at_ms<t)segment++;
            const a=keys[segment],b=keys[Math.min(segment+1,keys.length-1)],f=b.at_ms===a.at_ms?0:Math.max(0,Math.min(1,(t-a.at_ms)/(b.at_ms-a.at_ms)));
            output[i]=a.xy.map((p,j)=>p+(b.xy[j]-p)*f-anchor[j]);quality[i]="manual";
        });
    }
    return {shifts:output,quality};
}

export function curveBuckets(times, shifts, quality, start, end, width) {
    const count=Math.max(1,Math.floor(width)),span=Math.max(1,end-start);
    const bins=Array.from({length:count},()=>({min:[Infinity,Infinity],max:[-Infinity,-Infinity],quality:0}));
    let lo=0,hi=times.length;while(lo<hi){const mid=(lo+hi)>>1;if(times[mid]<start)lo=mid+1;else hi=mid}
    for(let i=lo;i<times.length&&times[i]<=end;i++){
        const bucket=bins[Math.min(count-1,Math.floor((times[i]-start)/span*count))];
        for(let axis=0;axis<2;axis++){bucket.min[axis]=Math.min(bucket.min[axis],shifts[i][axis]);bucket.max[axis]=Math.max(bucket.max[axis],shifts[i][axis])}
        bucket.quality=Math.max(bucket.quality,quality[i]==="held"?2:quality[i]==="manual"?1:0);
    }
    return bins;
}
