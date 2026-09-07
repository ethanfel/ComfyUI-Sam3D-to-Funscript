import assert from 'node:assert/strict';
import {test} from 'node:test';
import {motionForAxis, autoFitAxis, axisValue} from '../assets/curve.mjs';

test('An hour of coordinates fits with bounded windows and isolated anchor caches',()=>{
    const times=Array.from({length:108000},(_,i)=>i*1000/30),raw=times.map(t=>[.06*Math.sin(t/300),0,0,0,0,0]);
    const project={times_ms:times,valid:times.map(()=>true),segments:times.map(()=>0),raw,processed:raw,
        config:{target_anchor:'left_hand',max_gap_ms:250,axis_settings:{L0:{component:'auto',auto_fit:true,calibration:'adaptive',invert:false,center:50}}}};
    const motion=motionForAxis(project,'L0');
    assert.ok(motion.spans.length<=Math.ceil(times.at(-1)/500)+2);
    assert.ok(motion.spans.every(s=>s.window_ms[1]-s.window_ms[0]<=3000.001));
    assert.equal(motion.processed.length,108000);
    assert.equal(motionForAxis(project,'L0'),motion,'Repeated drawing reuses the fitted anchor data');
    const other={...project,raw:raw.map(()=>[0,0,0,0,0,0]),config:{...project.config,target_anchor:'right_hand'}};other.processed=other.raw;
    const still=motionForAxis(other,'L0');assert.notEqual(still,motion);
    assert.ok(still.processed.every(v=>Math.abs(v)<1e-12));
    const settings=autoFitAxis(project,'L0');
    for(let i=0;i<times.length;i+=97){const v=axisValue(motion,settings,i);assert.ok(v>=4&&v<=96);assert.equal(axisValue(motion,{...settings,invert:true},i),Math.round((100-v)*1e9)/1e9);}
});
