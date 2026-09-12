// Visual person rectangles share the original source coordinates used by SAM3D.
export function subjectEditor({$,context,update,attempt,draw,prepareOriginal}) {
    let drag=null,strictNext=false;
    const active=()=>{const c=context();return c.region&&c.visible&&$('subjectDetails').open&&!c.busy&&!c.region.locked&&c.editable?c:null;};
    function render(){
        const c=context(),r=c.region;if(!r)return;
        const disabled=c.busy||r.locked;
        $('person').replaceChildren(...r.rois.map((_,i)=>new Option(`Person ${i} · region ${i+1}`,String(i))));$('person').value=r.person;
        $('person').disabled=disabled;$('subjectTool').disabled=disabled||!c.editable;$('showPersonRegions').disabled=false;
        $('cropPerson').disabled=disabled;$('personZoom').disabled=c.stabilized;
        $('isolateSubject').checked=!!r.isolate_subject;$('isolateSubject').disabled=disabled;
        $('subjectHelp').textContent=c.editable?'Crop around the intended person, covering their movement in this section. Keep useful body context; split the section if the subject moves outside the crop.':'Pause on the original source to draw person regions.';
        const enabled=r.settings?.enabled_axes||['L0','L1','L2','R0','R1','R2'];
        for(const input of $('axisChoices').querySelectorAll('input')){input.checked=enabled.includes(input.value);input.disabled=disabled;}
        $('strokeInvert').checked=!!r.settings?.axis_settings?.L0?.invert;$('strokeInvert').disabled=disabled;
    }
    $('subjectDetails').ontoggle=()=>{if(!$('subjectDetails').open){drag=null;strictNext=false;$('subjectTool').value='review';draw();}};
    $('subjectTool').onchange=()=>{drag=null;strictNext=false;draw();};$('showPersonRegions').onchange=draw;
    $('personZoom').onchange=draw;
    $('isolateSubject').onchange=()=>attempt(()=>update({isolate_subject:$('isolateSubject').checked}));
    $('cropPerson').onclick=()=>{
        const c=context();if(!c.region||c.busy||c.region.locked)return;
        prepareOriginal();drag=null;strictNext=true;$('subjectDetails').open=true;
        $('subjectTool').value='replace';$('showPersonRegions').checked=true;draw();
    };
    $('axisChoices').onchange=()=>attempt(()=>{
        const r=context().region,enabled_axes=[...$('axisChoices').querySelectorAll('input:checked')].map(e=>e.value);
        if(!enabled_axes.length)throw new Error('Enable at least one output axis.');
        update({settings:{...r.settings,enabled_axes}});
    });
    $('strokeInvert').onchange=()=>attempt(()=>{const r=context().region;update({settings:{...r.settings,axis_settings:{...r.settings.axis_settings,L0:{...r.settings.axis_settings?.L0,invert:$('strokeInvert').checked}}}});});
    return {render,cancel(){drag=null;strictNext=false;$('subjectTool').value='review';},
        previewCrop(){
            const c=context(),r=c.region;
            if(!r||c.stabilized||!$('personZoom').checked||$('subjectTool').value!=='review')return null;
            const box=r.rois[r.person], [w,h]=c.size;
            return box?[box[0]*w,box[1]*h,box[2]*w,box[3]*h]:null;
        },
        down(p){const c=active(),tool=$('subjectTool').value;if(!c||!p||tool==='review')return false;drag={id:c.region.id,start:p,end:p,tool,strict:strictNext,person:c.region.person,rois:structuredClone(c.region.rois)};return true;},
        move(p){if(!drag)return false;if(p)drag.end=p;draw();return true;},
        up(){
            if(!drag)return false;const d=drag;drag=null;const c=active();
            if(!c||d.id!==c.region.id)return true;
            const [w,h]=c.size,a=d.start,b=d.end,rect=[Math.min(a[0],b[0])/w,Math.min(a[1],b[1])/h,Math.abs(a[0]-b[0])/w,Math.abs(a[1]-b[1])/h];
            if(rect[2]*w>=3&&rect[3]*h>=3)attempt(()=>{const rois=d.rois,person=d.tool==='add'?rois.length:d.person;rois[person]=rect;update({rois,person,...(d.strict?{isolate_subject:true}:{})});if(d.strict)$('personZoom').checked=true;});
            strictNext=false;$('subjectTool').value='review';draw();return true;
        },
        overlay(ctx,map){
            const c=context(),r=c.region;if(!r||c.stabilized||!$('showPersonRegions').checked)return;
            const [w,h]=c.size,pixel=p=>[map.ox+(p[0]-map.crop[0])*map.scale,map.oy+(p[1]-map.crop[1])*map.scale];
            ctx.save();ctx.beginPath();ctx.rect(map.ox,map.oy,map.crop[2]*map.scale,map.crop[3]*map.scale);ctx.clip();
            ctx.lineWidth=1.5;ctx.font='12px system-ui';
            r.rois.forEach((box,i)=>{const [x,y]=pixel([box[0]*w,box[1]*h]);ctx.strokeStyle=ctx.fillStyle=i===r.person?'#ffdb84':'#82bde6';ctx.strokeRect(x,y,box[2]*w*map.scale,box[3]*h*map.scale);ctx.fillText(`Person ${i}`,x+5,y+15);});
            if(drag){const a=pixel(drag.start),b=pixel(drag.end);ctx.strokeStyle='#9be8d1';ctx.strokeRect(a[0],a[1],b[0]-a[0],b[1]-a[1]);}
            ctx.restore();
        }
    };
}
