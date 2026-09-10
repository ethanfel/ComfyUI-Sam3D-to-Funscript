// Source-pixel brush strokes; the mask selects point seeds, never point identities.
export function maskContains(mask,x,y){
    let inside=false;
    for(const stroke of mask?.strokes||[]){
        const points=stroke.points,r2=stroke.radius**2;
        for(let i=0;i<points.length;i++){
            const a=points[Math.max(0,i-1)],b=points[i],dx=b[0]-a[0],dy=b[1]-a[1];
            const t=Math.max(0,Math.min(1,((x-a[0])*dx+(y-a[1])*dy)/(dx*dx+dy*dy||1)));
            if((x-a[0]-t*dx)**2+(y-a[1]-t*dy)**2<=r2){inside=!stroke.erase;break;}
        }
    }
    return inside;
}
export function maskPoints(mask,crop){
    const spacing=Number(mask?.spacing||12),limit=Number(mask?.limit||500);
    if(!Number.isFinite(spacing)||spacing<1||!Number.isInteger(limit)||limit<3)throw new Error('Use spacing of at least 1 pixel and a point limit of at least 3.');
    const [x,y,w,h]=crop;let left=x+w,top=y+h,right=x,bottom=y;
    for(const s of mask?.strokes||[])if(!s.erase)for(const p of s.points){left=Math.min(left,p[0]-s.radius);top=Math.min(top,p[1]-s.radius);right=Math.max(right,p[0]+s.radius);bottom=Math.max(bottom,p[1]+s.radius);}
    left=Math.max(x,left);top=Math.max(y,top);right=Math.min(x+w-1,right);bottom=Math.min(y+h-1,bottom);
    const points=[];
    for(let yy=Math.ceil((top-y-spacing/2)/spacing)*spacing+y+spacing/2;yy<=bottom;yy+=spacing)
        for(let xx=Math.ceil((left-x-spacing/2)/spacing)*spacing+x+spacing/2;xx<=right;xx+=spacing)
            if(xx>=x&&yy>=y&&maskContains(mask,xx,yy))points.push([xx,yy]);
    if(points.length<3)throw new Error('Paint a larger area or reduce point spacing to generate at least three points.');
    const selected=points.length<=limit?points:Array.from({length:limit},(_,i)=>points[Math.floor((i+.5)*points.length/limit)]);
    return {points:selected,total:points.length};
}
export function drawPointMask(ctx,mask,map,width,height,draft=null){
    if(!mask&&!draft)return;
    const layer=new OffscreenCanvas(Math.max(1,Math.round(width)),Math.max(1,Math.round(height))),paint=layer.getContext('2d');
    const strokes=[...(mask?.strokes||[]),...(draft?[draft]:[])];
    paint.lineCap=paint.lineJoin='round';paint.fillStyle=paint.strokeStyle='#7fdabe';
    for(const s of strokes){
        paint.globalCompositeOperation=s.erase?'destination-out':'source-over';paint.lineWidth=2*s.radius*map.scale;
        const xy=p=>[map.ox+(p[0]-map.crop[0])*map.scale,map.oy+(p[1]-map.crop[1])*map.scale];
        const start=xy(s.points[0]);paint.beginPath();paint.arc(...start,s.radius*map.scale,0,Math.PI*2);paint.fill();
        paint.beginPath();paint.moveTo(...start);for(const p of s.points.slice(1))paint.lineTo(...xy(p));paint.stroke();
    }
    ctx.save();ctx.globalAlpha=.35;ctx.drawImage(layer,0,0);ctx.restore();
}
export function maskGeometry(mask){return mask?{frame:mask.frame,strokes:mask.strokes,model:mask.model||'sam2.1_base_plus'}:null;}
export function prefillReferenceKey(reference,trackedConfig,data,frame){
    const keys=reference.keyframes||[{frame:0,points:reference.points||[]}],old=trackedConfig?.keyframes||[{frame:0,points:trackedConfig?.points||[]}];
    const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
    if(!same(maskGeometry(reference.point_mask),maskGeometry(trackedConfig?.point_mask))||!data?.points?.[frame]||!same(reference.crop_xywh,trackedConfig?.crop_xywh)||!old.every(k=>keys.some(n=>n.frame===k.frame&&same(n.points,k.points))))return null;
    const predicted=data.points[frame],visible=data.visible?.[frame],count=old[0].points.length;
    if(!count||predicted.length!==count)return null;
    const [x,y,w,h]=reference.crop_xywh,unconfirmed=[];
    const points=predicted.map((p,i)=>{
        const finite=p?.length===2&&p.every(Number.isFinite),inside=finite&&p[0]>=x&&p[0]<=x+w-1&&p[1]>=y&&p[1]<=y+h-1;
        if(!inside||!visible?.[i])unconfirmed.push(i);
        return inside?p.slice():old[0].points[i].slice();
    });
    return {frame,points,...(unconfirmed.length?{unconfirmed}:{})};
}
export function agreementText(data,index){
    const count=data?.inliers?.[index],visible=data?.visible?.[index];
    if(!Number.isFinite(count)||!visible)return '';
    return `${count} / ${visible.filter(Boolean).length} visible points agree · ${visible.length} total`;
}
