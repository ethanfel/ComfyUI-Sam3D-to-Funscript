import {maskPoints,maskGeometry,drawPointMask} from './reference-mask.mjs';
import {referenceKeys,withReferenceKeys,validateReferenceKeys} from './reference-edit.mjs?v=reference-masks-1';

export function stabilizationSteps({$,context,attempt,updateReference,seekOriginal,process,configureAnchors,selectRegion,draw}) {
    const steps=new Map(),images=new Map();let brush=null,request=null,error='',lastRegion=null;
    const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
    const current=()=>{const c=context();return c.region?{...c,mask:c.region.reference.point_mask,step:steps.get(c.region.id)||(c.region.reference.points?.length?'track':'mask')}:null;};
    const ready=c=>!!c?.entry&&!!c.mask&&c.entry.region.start_ms===c.region.start_ms&&c.entry.region.end_ms===c.region.end_ms&&equal(c.entry.mask,maskGeometry(c.mask));
    const setStep=name=>{const c=current();if(!c)return;steps.set(c.region.id,name);brush=null;$('maskTool').value='review';if(name==='mask')seekOriginal(c.mask?.frame??Math.max(0,Math.min(c.frame,c.frameCount-1)));render();draw();};
    const emptyMask=c=>({frame:c.frame,spacing:12,limit:500,model:'sam2.1_base_plus',strokes:[]});
    const change=mask=>updateReference({...current().region.reference,point_mask:mask});
    const generate=()=>{
        const c=current();if(!c.mask?.strokes.length)throw new Error('Paint a reference mask first.');
        if(c.region.reference.points.length&&!$('replaceMaskPoints').checked)throw new Error('Enable Replace existing points and reference keyframes to generate a new point set. Undo can restore it.');
        const result=maskPoints(c.mask,c.region.reference.crop_xywh);
        updateReference(withReferenceKeys(c.region.reference,[{frame:c.mask.frame,points:result.points}]));
        $('replaceMaskPoints').checked=false;$('maskPointStatus').textContent=`${result.points.length} points generated${result.total>result.points.length?` from ${result.total} candidates`:''}`;
    };
    for(const name of ['mask','track','anchors'])$(name+'StepTab').onclick=()=>setStep(name);
    $('manualPoints').onclick=()=>setStep('track');
    $('maskSeed').onclick=()=>attempt(()=>{
        const c=current();if(c.frame<0||c.frame>=c.frameCount)throw new Error('Seek inside this region first.');
        if(c.mask?.strokes.length&&c.mask.frame!==c.frame)throw new Error('Clear the mask before painting a different seed frame. Your numbered points will stay.');
        change({...c.mask||emptyMask(c),frame:c.frame});seekOriginal(c.frame);$('maskTool').value='paint';draw();
    });
    $('maskGoSeed').onclick=()=>{const c=current();if(c?.mask)seekOriginal(c.mask.frame);};
    $('showReferenceMask').onchange=draw;
    $('maskTool').onchange=()=>{const c=current();if(c?.mask&&$('maskTool').value!=='review')seekOriginal(c.mask.frame);draw();};
    $('clearMask').onclick=()=>attempt(()=>{const ref={...current().region.reference};delete ref.point_mask;updateReference(ref);});
    $('undoMaskStroke').onclick=()=>attempt(()=>{const c=current();change({...c.mask,strokes:c.mask.strokes.slice(0,-1)});});
    for(const [id,field,convert] of [['maskSpacing','spacing',Number],['maskLimit','limit',Number],['maskModel','model',String],['maskMargin','margin',Number]])$(id).onchange=()=>attempt(()=>{
        const c=current(),value=convert($(id).value);
        if(field==='spacing'&&(!Number.isFinite(value)||value<1)||field==='limit'&&(!Number.isInteger(value)||value<3||value>5000))throw new Error('Spacing must be at least 1 pixel; choose 3–5000 points.');
        if(field==='margin'&&(!Number.isFinite(value)||value<0||value>100))throw new Error('Mask tolerance must be between 0 and 100 pixels.');
        change({...c.mask||emptyMask(c),[field]:value});
    });
    $('generateMaskPoints').onclick=()=>attempt(generate);
    $('propagateMask').onclick=()=>attempt(()=>{
        const c=current();if(!c.mask?.strokes.length)throw new Error('Paint a reference mask first.');
        if(!c.region.reference.points.length)generate();
        process('propagate_mask');
    });
    $('cancelMask').onclick=()=>$('cancel').click();
    $('addStabilizedAnchors').onclick=()=>attempt(configureAnchors);
    $('extractStabilizedAnchors').onclick=()=>process('extract_anchors');
    function problem(){
        const c=current();if(!c)return 'Select a stabilization region.';
        if(c.region.enabled===false)return 'Enable this region first.';
        try{validateReferenceKeys(c.region.reference,c.frameCount);}catch(e){return e.message;}
        if(c.mask?.strokes.length&&!ready(c))return 'Propagate the updated mask before tracking.';
        return '';
    }
    function render() {
        const c=current();if(!c)return;
        if(!steps.has(c.region.id))steps.set(c.region.id,c.step);
        if(lastRegion!==c.region.id){lastRegion=c.region.id;$('replaceMaskPoints').checked=false;error='';}
        const disabled=c.busy||c.region.locked,hasMask=!!c.mask?.strokes.length;
        const issue=problem();
        $('maskReadiness').textContent=hasMask?(ready(c)?'Ready':'Needs propagation'):'Optional';
        $('trackReadiness').textContent=issue?'Needs setup':c.tracked?'Ready · rendered':'Ready to track';
        $('anchorsReadiness').textContent=c.tracked?'Ready to extract':'Track first';
        $('trackRequirement').textContent=issue||(c.tracked?'Current preview ready.':'Reference ready · track this region.');
        for(const name of ['mask','track','anchors']){
            $(name+'Step').hidden=c.step!==name;$(name+'StepTab').disabled=false;
            $(name+'StepTab').setAttribute('aria-current',c.step===name?'step':'false');
        }
        for(const id of ['maskSeed','maskTool','maskRadius','maskSpacing','maskLimit','maskMargin','maskModel','generateMaskPoints','replaceMaskPoints','clearMask','undoMaskStroke','addStabilizedAnchors'])$(id).disabled=disabled;
        $('maskGoSeed').disabled=!c.mask;$('showReferenceMask').disabled=false;$('manualPoints').disabled=false;
        $('maskFrameLabel').textContent=c.mask?`F ${c.first+c.mask.frame}`:'Choose a frame to paint';
        for(const [id,value] of [['maskSpacing',c.mask?.spacing||12],['maskLimit',c.mask?.limit||500],['maskModel',c.mask?.model||'sam2.1_base_plus'],['maskMargin',c.mask?.margin??6]])if(document.activeElement!==$(id))$(id).value=value;
        $('undoMaskStroke').disabled=disabled||!hasMask;
        $('generateMaskPoints').disabled=disabled||!hasMask;
        $('replaceMaskPointsLabel').hidden=!c.region.reference.points.length;
        const running=c.operation==='propagate_mask';
        $('propagateMask').disabled=disabled||!hasMask||c.region.enabled===false;
        $('propagateMask').textContent=running?'Propagating…':'Propagate mask';
        $('cancelMask').hidden=!running;$('cancelMask').disabled=$('cancel').disabled;
        $('maskStatus').textContent=running?$('progressText').textContent:error||(!hasMask?'Optional · paint an area, or continue with manual points.':ready(c)?`${c.entry.frames} masks ready · propagated in both directions`:'Mask changed · propagate to update all frames');
        if(hasMask&&c.region.reference.points.length)$('maskStatus').textContent+=' · Existing points are kept. Use Generate points with Replace to sample the painted area again.';
        const overlaps=c.tracking.filter(r=>r.enabled!==false&&r.start_ms<c.region.end_ms&&r.end_ms>c.region.start_ms);
        $('stabilizedAnchorRegions').replaceChildren(...overlaps.map(r=>{
            const b=document.createElement('button');b.type='button';b.textContent=`${r.name} · ${r.anchor.replaceAll('_',' ')}${r.additional_anchors?.length?` + ${r.additional_anchors.length}`:''}`;b.disabled=c.busy;b.onclick=()=>selectRegion(r.id);return b;
        }));
        $('extractStabilizedAnchors').disabled=c.busy||!overlaps.length||!!issue||!c.tracked;
        $('extractStabilizedAnchors').title=!overlaps.length?'Create an anchor region first.':issue||(!c.tracked?'Track the current reference settings first.':'Extract anchors for the full stabilization region.');
    }
    function pointerDown(point){
        const c=current();if(c?.step!=='mask'||$('maskTool').value==='review')return false;
        if(!c.editable)return true;
        if(c.mask&&c.mask.frame!==c.frame){$('maskStatus').textContent='Go to the mask frame to paint. Clear the mask to choose a new seed frame.';return true;}
        const radius=Number($('maskRadius').value);
        if(!Number.isFinite(radius)||radius<1||radius>1000){$('maskStatus').textContent='Choose a brush radius from 1 to 1000 pixels.';return true;}
        brush={erase:$('maskTool').value==='erase',radius,points:[point]};draw();return true;
    }
    function pointerMove(point){if(!brush)return false;if(point&&Math.hypot(...point.map((v,i)=>v-brush.points.at(-1)[i]))>=Math.max(1,brush.radius/4))brush.points.push(point);draw();return true;}
    function pointerUp(){if(!brush)return false;const stroke=brush;brush=null;attempt(()=>{const c=current();change({...c.mask||emptyMask(c),strokes:[...(c.mask?.strokes||[]),stroke]});});return true;}
    function overlay(ctx,map,width,height){
        const c=current();if(!c||c.stabilized||!$('showReferenceMask').checked)return;
        if(c.mask?.frame===c.frame){drawPointMask(ctx,c.mask,map,width,height,brush);return;}
        if(brush){drawPointMask(ctx,null,map,width,height,brush);return;}
        if(!ready(c)||c.frame<0||c.frame>=c.entry.frames)return;
        const key=`${c.entry.id}/${c.frame}`,cached=images.get(key);
        if(cached){ctx.save();ctx.globalAlpha=.35;ctx.drawImage(cached,...map.crop,map.ox,map.oy,map.crop[2]*map.scale,map.crop[3]*map.scale);ctx.restore();return;}
        if(images.has(key)||request)return;
        request=key;
        fetch(`${c.api.pathname}/masks/${key}`,{signal:AbortSignal.timeout(10000),cache:'no-cache'}).then(r=>{if(!r.ok)throw new Error('Mask preview unavailable; propagate again.');return r.blob();}).then(createImageBitmap).then(bitmap=>{
            const layer=new OffscreenCanvas(bitmap.width,bitmap.height),p=layer.getContext('2d');p.drawImage(bitmap,0,0);bitmap.close();
            const pixels=p.getImageData(0,0,layer.width,layer.height);
            for(let i=0;i<pixels.data.length;i+=4){pixels.data[i+3]=pixels.data[i];pixels.data[i]=127;pixels.data[i+1]=218;pixels.data[i+2]=190;}
            p.putImageData(pixels,0,0);images.set(key,layer);while(images.size>4)images.delete(images.keys().next().value);error='';
        }).catch(e=>{images.set(key,null);error=e.message;}).finally(()=>{request=null;render();if(!error)draw();});
    }
    function validate(){const c=current();if(c?.mask?.strokes.length&&!ready(c))throw new Error('Propagate the updated reference mask before tracking.');}
    return {render,setStep,overlay,pointerDown,pointerMove,pointerUp,cancel:()=>{brush=null;},problem,validate,reset:()=>{images.clear();error='';}};
}
