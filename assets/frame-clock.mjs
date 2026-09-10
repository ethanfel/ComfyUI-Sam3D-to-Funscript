// Frames are presentation-order source indices, starting at zero. Out is exclusive.
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const epsilon=.000002;
export function frameClock(data) {
    const times=data.times_ms, first=data.first_frame, end=first+times.length;
    if(!times?.length||!Number.isInteger(first)||first<0||data.end_frame!==end||
        times.some((v,i)=>!Number.isFinite(v)||(i&&v<=times[i-1]))||!(data.end_ms>times.at(-1)))
        throw new Error("Invalid source frame index. Prepare the timeline again.");
    function lower(time) {let a=0,b=times.length;while(a<b){const m=Math.floor((a+b)/2);if(times[m]<time-epsilon)a=m+1;else b=m;}return a;}
    const at=index=>index>=end?data.end_ms:times[clamp(Math.round(index)-first,0,times.length-1)];
    const ceil=time=>first+lower(time);
    const containing=time=>{const i=lower(time);return first+clamp(i<times.length&&Math.abs(times[i]-time)<=epsilon?i:i-1,0,times.length-1);};
    function nearest(time,boundary=false){const i=lower(time),left=first+Math.max(0,i-1),right=first+Math.min(i,times.length-(boundary?0:1));return Math.abs(at(left)-time)<Math.abs(at(right)-time)?left:right;}
    return {first,end,at,ceil,containing,nearest,
        snap:(time,boundary=false)=>at(nearest(time,boundary)),
        step:(time,delta)=>at(clamp(containing(time)+delta,first,end-1)),
        seekTime:time=>{const i=containing(time);return at(i)+Math.min(.01,(at(i+1)-at(i))/4);},
        ticks(start,stop,width){
            const a=ceil(start),b=Math.min(end,ceil(stop)),count=b-a;
            const desired=count/Math.max(1,width/85),power=10**Math.floor(Math.log10(Math.max(1,desired)));
            const step=[1,2,5,10].map(n=>n*power).find(n=>n>=desired)||power*10;
            const ticks=[],stride=width/Math.max(1,count)>=9?1:step;
            for(let f=Math.ceil(a/stride)*stride;f<=b;f+=stride)if(at(f)<=stop+epsilon)ticks.push({time:at(f),frame:f,label:f%step===0?String(f):""});
            return ticks;
        }};
}
