import {drawPointMask} from './reference-mask.mjs';

// Painting selects a surface once. Later frames keep its mesh vertex identities.
export function meshAnchorEditor({$,context,attempt,update,seekOriginal,draw}) {
    let stroke=null,owner=null;
    const active=c=>c.region?.anchor==='mask_anchor';
    const inRegion=c=>c.frame>=0&&c.frame<c.frameCount;
    const ready=c=>active(c)&&!c.busy&&!c.region.locked&&c.editable&&inRegion(c);
    const onSeed=c=>c.region?.mask_anchor?.frame===c.frame;
    const reusable=c=>(c.stabilization||[]).find(r=>{
        const mask=r.reference?.point_mask;if(!mask?.strokes?.length)return false;
        const frame=c.clock.ceil(r.start_ms)+mask.frame;
        return frame<c.clock.ceil(r.end_ms)&&frame>=c.first&&frame<c.first+c.frameCount;
    });
    function render(){
        const c=context(),show=active(c);$('meshAnchorSettings').hidden=!show;
        if(!show){stroke=null;return;}
        const mask=c.region.mask_anchor,disabled=c.busy||c.region.locked;
        $('meshAnchorMark').disabled=!ready(c);
        $('meshAnchorMark').textContent=mask&&!onSeed(c)?'Replace reference frame':'Mark reference frame';
        $('meshAnchorMark').title=c.stabilized?'Switch the preview to Original before painting.':mask&&!onSeed(c)?'Start a new painting on this frame. Undo restores the previous reference.':'Pause on a clear frame inside this tracking region.';
        $('meshAnchorGo').disabled=c.busy||!mask;
        $('meshAnchorReuse').disabled=disabled||!reusable(c);
        for(const id of ['meshAnchorTool','meshAnchorRadius'])$(id).disabled=disabled||!mask;
        $('meshAnchorUndo').disabled=disabled||!mask?.strokes?.length;
        $('meshAnchorClear').disabled=disabled||!mask?.strokes?.length;
        $('meshAnchorStatus').textContent=!mask?'Choose a clear frame, mark it, then paint the body patch.':
            `F ${c.first+mask.frame} · ${mask.strokes.length?'painted patch':'paint an area'}${onSeed(c)?' · reference frame':' · go to reference to paint'}`;
        if(c.stabilized)$('meshAnchorStatus').textContent+=' · switch preview to Original to paint';
        if(stroke&&(owner.id!==c.region.id||owner.frame!==c.frame||!ready(c)))stroke=null;
    }
    $('meshAnchorMark').onclick=()=>attempt(()=>{
        const c=context();if(!ready(c))return;
        if(!onSeed(c))update({frame:c.frame,strokes:[]});
        $('meshAnchorTool').value='paint';render();draw();
    });
    $('meshAnchorGo').onclick=()=>{const c=context();if(c.region?.mask_anchor)seekOriginal(c.region.mask_anchor.frame);};
    $('meshAnchorReuse').onclick=()=>attempt(()=>{
        const c=context(),r=reusable(c);if(!r||c.busy||c.region.locked)return;
        const mask=r.reference.point_mask,frame=c.clock.ceil(r.start_ms)+mask.frame-c.first;
        update({frame,strokes:structuredClone(mask.strokes)});$('meshAnchorTool').value='review';seekOriginal(frame);
    });
    $('meshAnchorUndo').onclick=()=>attempt(()=>{const c=context();if(c.region?.mask_anchor)update({...c.region.mask_anchor,strokes:c.region.mask_anchor.strokes.slice(0,-1)});});
    $('meshAnchorClear').onclick=()=>attempt(()=>{const c=context();if(c.region?.mask_anchor)update({...c.region.mask_anchor,strokes:[]});});
    $('meshAnchorTool').onchange=()=>{stroke=null;draw();};
    return {render,cancel(){stroke=null;},
        overlay(ctx,map,w,h){render();const c=context();if(active(c)&&!c.stabilized&&onSeed(c))drawPointMask(ctx,c.region.mask_anchor,map,w,h,stroke);},
        pointerDown(p){
            const c=context(),tool=$('meshAnchorTool').value;
            if(!p||!ready(c)||!onSeed(c)||tool==='review')return false;
            const radius=Number($('meshAnchorRadius').value);
            if(!Number.isFinite(radius)||radius<1)return false;
            stroke={erase:tool==='erase',radius,points:[p]};owner={id:c.region.id,frame:c.frame};draw();return true;
        },
        pointerMove(p){if(!stroke)return false;if(p)stroke.points.push(p);draw();return true;},
        pointerUp(){
            if(!stroke)return false;
            const c=context(),next=stroke;stroke=null;
            if(ready(c)&&onSeed(c)&&owner.id===c.region.id&&owner.frame===c.frame)attempt(()=>update({...c.region.mask_anchor,strokes:[...c.region.mask_anchor.strokes,next]}));
            draw();return true;
        },
    };
}
