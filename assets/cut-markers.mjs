// Sorted source-clock markers. Navigation is independent of visible zoom.
export function cutIndex(cuts,time){
    let lo=0,hi=cuts.length;
    while(lo<hi){const mid=(lo+hi)>>>1;if(cuts[mid]<time)lo=mid+1;else hi=mid;}
    return lo;
}
export function neighboringCut(cuts,time,direction){
    if(direction<0)return cuts[cutIndex(cuts,time-.01)-1]??null;
    return cuts[cutIndex(cuts,time+.01)]??null;
}
export function snapCut(cuts,time,tolerance){
    const i=cutIndex(cuts,time),near=[cuts[i-1],cuts[i]].filter(Number.isFinite);
    const best=near.sort((a,b)=>Math.abs(a-time)-Math.abs(b-time))[0];
    return best!==undefined&&Math.abs(best-time)<=tolerance?best:time;
}
export function shotRange(cuts,time,start,end){
    const i=cutIndex(cuts,time+.01);
    return [Math.max(start,cuts[i-1]??start),Math.min(end,cuts[i]??end)];
}
// A cut is the boundary BEFORE the first frame of the incoming shot.
export function cutSideRange(cuts,time,direction,start,end){
    const i=cutIndex(cuts,time);
    if(cuts[i]!==time)return null;
    return direction<0?[Math.max(start,cuts[i-1]??start),time]:[time,Math.min(end,cuts[i+1]??end)];
}
export function visibleCuts(cuts,start,span,width){
    const result=[];let pixel=-Infinity;
    for(let i=cutIndex(cuts,start);i<cuts.length&&cuts[i]<=start+span;i++){
        const x=Math.round((cuts[i]-start)/span*width);
        if(x!==pixel){result.push(cuts[i]);pixel=x;}
    }
    return result;
}
