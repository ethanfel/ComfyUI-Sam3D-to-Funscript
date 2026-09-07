// Device conditioning is derived from assembled main, never from mutable pose
// tracks. Published specifications are templates, not measured operating limits.
import {validateReference} from "./curve.mjs";

const checked = "2026-09-07";
const handy2Source = "https://www.thehandy.com/store/the-handy-2-eu/";
const published = (value, unit, source) => ({value, unit, status:"published", source, checked});
const unknown = unit => ({value:null, unit, status:"unknown"});
export const DEVICE_PROFILES = [
    {id:"handy1",version:1,label:"Handy · original",axes:["L0"],mode:"normal",
        travel:published(110,"mm","https://www.thehandy.com/store/the-handy-eu/"),
        speed:published(400,"mm/s","https://ohdoki.notion.site/Handy-functionality-2a5b14198a6c4204b270c47521fb5da9")},
    {id:"handy2",version:1,label:"Handy 2 · Standard",axes:["L0"],mode:"normal",
        travel:published(125,"mm",handy2Source),speed:published(400,"mm/s",handy2Source)},
    {id:"handy2-pro",version:1,label:"Handy 2 Pro · normal mode",axes:["L0"],mode:"normal",
        travel:published(125,"mm",handy2Source),speed:published(450,"mm/s",handy2Source)},
    {id:"custom",version:1,label:"Custom · single axis",axes:["L0"],mode:"user specified",
        travel:unknown("mm"),speed:unknown("mm/s")},
];

export function deviceSettings(id="none") {
    const profile=DEVICE_PROFILES.find(p=>p.id===id);
    if(id!=="none"&&!profile)throw new Error("Unknown device profile");
    return {version:1,profile:id,zone_min_mm:0,zone_max_mm:profile?.travel.value??null,
        speed_mm_s:null,speed_evidence:"unknown",setup:"",show_curve:true,preview:"authored"};
}

function configuration(settings) {
    if(!settings||settings.profile==="none")return null;
    if(settings.version!==1)throw new Error("Unsupported device output settings version");
    const profile=DEVICE_PROFILES.find(p=>p.id===settings.profile);
    if(!profile)throw new Error("Unknown device profile");
    const {zone_min_mm:min,zone_max_mm:max,speed_mm_s:speed}=settings;
    if(!Number.isFinite(min)||!Number.isFinite(max)||min<0||max<=min)throw new Error("Enter a stroke zone in mm: end must be greater than start, starting at zero or above.");
    if(profile.travel.value!==null&&max>profile.travel.value)throw new Error(`Zone exceeds this profile's published ${profile.travel.value} mm travel.`);
    if(speed!==null&&(!Number.isFinite(speed)||speed<=0))throw new Error("Enter a positive speed limit in mm/s, or leave it empty for analysis only.");
    if(speed!==null&&profile.speed.value!==null&&speed>profile.speed.value)throw new Error(`Limit exceeds this profile's published ${profile.speed.value} mm/s in normal mode. Use a custom profile for another setup.`);
    const limit=speed===null?unknown("mm/s"):settings.speed_evidence==="published"&&speed===profile.speed.value?
        {...profile.speed}:{value:speed,unit:"mm/s",status:"assumed",source:"user setting"};
    return {profile,limit,width:max-min,mapping:{zone_min_mm:min,zone_max_mm:max,
        status:min===0&&max===profile.travel.value?"published":"assumed",
        expression:"x_mm = zone_min_mm + pos / 100 * (zone_max_mm - zone_min_mm)",
        applied_by:"player/device",output_positions:"0–100 percent of the selected zone"}};
}

export function analyseStroke(actions, zoneMm, limit=null) {
    let peak=0,exceedances=0,reversals=0,direction=0;
    for(let i=1;i<actions.length;i++){
        const delta=actions[i].pos-actions[i-1].pos;
        const speed=Math.abs(delta)*zoneMm*10/(actions[i].at-actions[i-1].at);
        peak=Math.max(peak,speed);if(limit!==null&&speed>limit+1e-7)++exceedances;
        const sign=Math.sign(delta);if(sign&&direction&&sign!==direction)++reversals;if(sign)direction=sign;
    }
    return {peak_speed_mm_s:peak,over_limit_segments:limit===null?null:exceedances,reversals};
}

// Integer Lipschitz envelopes. Each neighbour distance is the allowed integer
// position change in that time. Forward/backward passes find feasible curves
// below and above the authored one; their midpoint reduces excursions around
// an impossible passage without causal lag or clipping peaks to 0/100.
// A held interval has zero allowed change so optimization cannot animate a hold.
// Rounding DOWN the midpoint with a fixed half-step (not ties-to-even) retains
// every integer distance bound. Keeping all timestamps can be conservative for
// very dense commands: sub-position travel cannot be encoded at those knots.
export function limitStroke(actions, zoneMm, speed) {
    const n=actions.length,lower=new Int16Array(n),upper=new Int16Array(n),budget=new Uint8Array(n);
    for(let i=0;i<n;i++){
        lower[i]=upper[i]=actions[i].pos;
        if(i&&actions[i].pos!==actions[i-1].pos)
            budget[i]=Math.min(100,Math.floor(speed*(actions[i].at-actions[i-1].at)/(zoneMm*10)+1e-10));
    }
    for(let i=1;i<n;i++){
        lower[i]=Math.min(lower[i],lower[i-1]+budget[i]);
        upper[i]=Math.max(upper[i],upper[i-1]-budget[i]);
    }
    for(let i=n-2;i>=0;i--){
        lower[i]=Math.min(lower[i],lower[i+1]+budget[i+1]);
        upper[i]=Math.max(upper[i],upper[i+1]-budget[i+1]);
    }
    return actions.map((a,i)=>({at:a.at,pos:Math.floor((lower[i]+upper[i]+1)/2)}));
}

export function buildDeviceOutput(project) {
    const config=configuration(project.device_output);
    if(!config)return null;
    if(!project.scripts.L0)throw new Error("This profile needs a main L0 stroke track. Select or assemble L0 first.");
    const source=validateReference(project.scripts.L0),{profile,limit,width,mapping}=config;
    const before=analyseStroke(source,width,limit.value);
    if(limit.value===null)return {profile,mapping,limit,before,script:null};
    const actions=limitStroke(source,width,limit.value);
    // This is the exact final integer script used in both preview and export.
    // No resampling, simplification or additional range mapping follows the check.
    const after=analyseStroke(actions,width,limit.value);
    if(after.over_limit_segments)throw new Error("Device output failed its final speed check; no adjusted script was generated.");
    let changed=0,maxChange=0;
    for(let i=0;i<actions.length;i++){
        const difference=Math.abs(actions[i].pos-source[i].pos);
        if(difference)++changed;maxChange=Math.max(maxChange,difference*width/100);
    }
    return {profile,mapping,limit,before,after,changed_points:changed,max_change_mm:maxChange,
        script:{...structuredClone(project.scripts.L0),actions},
        limitations:["Speed check only; acceleration, jerk, deadband, latency and loaded response are unknown.",
            "Original timestamps and holds are retained. Positions, including endpoints and held levels, may change.",
            "Dense integer commands can require extra amplitude reduction. There is no command-rate or transport model.",
            "Configure the same stroke zone in your player/device exactly once. No physical response is predicted."]};
}

// Pure SHA-256 also works in offline and non-HTTPS LAN viewers where Web Crypto
// may be unavailable. This records provenance; it is not used for authentication.
export function scriptHash(script) {
    const input=new TextEncoder().encode(JSON.stringify(script));
    const bytes=new Uint8Array(Math.ceil((input.length+9)/64)*64);bytes.set(input);bytes[input.length]=128;
    const view=new DataView(bytes.buffer);view.setUint32(bytes.length-8,Math.floor(input.length/0x20000000));view.setUint32(bytes.length-4,input.length*8);
    const h=new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
    const k=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
        0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
        0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
        0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
        0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
        0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
        0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
        0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
    const w=new Uint32Array(64),ror=(v,n)=>(v>>>n)|(v<<(32-n));
    for(let offset=0;offset<bytes.length;offset+=64){
        for(let i=0;i<16;i++)w[i]=view.getUint32(offset+i*4);
        for(let i=16;i<64;i++){
            const a=w[i-15],b=w[i-2];
            w[i]=w[i-16]+(ror(a,7)^ror(a,18)^(a>>>3))+w[i-7]+(ror(b,17)^ror(b,19)^(b>>>10));
        }
        let [a,b,c,d,e,f,g,j]=h;
        for(let i=0;i<64;i++){
            const t1=(j+(ror(e,6)^ror(e,11)^ror(e,25))+((e&f)^(~e&g))+k[i]+w[i])>>>0;
            const t2=((ror(a,2)^ror(a,13)^ror(a,22))+((a&b)^(a&c)^(b&c)))>>>0;
            j=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;
        }
        [a,b,c,d,e,f,g,j].forEach((v,i)=>h[i]+=v);
    }
    return Array.from(h,v=>v.toString(16).padStart(8,"0")).join("");
}

export function deviceOutputFiles(project, stem) {
    const output=buildDeviceOutput(project);
    if(!output?.script)throw new Error("Choose a device profile, stroke zone and speed limit to export adjusted L0.");
    const {script,...report}=output;
    const manifest={schema:"sam3d-device-output/1",optimizer:"integer-speed-envelope/1",axis:"L0",
        source_sha256:scriptHash(project.scripts.L0),output_sha256:scriptHash(script),
        settings:structuredClone(project.device_output),...report};
    return {[stem+".funscript"]:JSON.stringify(script),"device-output.json":JSON.stringify(manifest,null,2),
        "README.txt":`${output.profile.label}\nAdjusted main L0 only.\n\nSet your player/device stroke zone to ${output.mapping.zone_min_mm}–${output.mapping.zone_max_mm} mm.\nScript positions remain 0–100% of that zone; apply the zone only once.\nSpeed limit: ${output.limit.value} mm/s (${output.limit.status}).\n\n${output.limitations.join("\n")}\n`};
}
