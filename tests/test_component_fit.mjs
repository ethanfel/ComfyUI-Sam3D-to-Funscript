import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fitComponentAxis, motionForAxis, axisValue} from '../assets/curve.mjs';

function fixture() {
    const processed=Array.from({length:101},(_,i)=>[0, i*20, .03*Math.sin(i*Math.PI/10),0,0,5*Math.sin(i*Math.PI/10)]);
    const settings={component:'auto',range:1,center:50,invert:false,auto_fit:true,calibration:'adaptive'};
    return {processed,raw:structuredClone(processed),valid:processed.map(()=>true),
        config:{axis_settings:{L0:{...settings},R0:{...settings}}}};
}

test('Explicit sideways fitting retains oscillation despite a much larger depth ramp',()=>{
    const project=fixture(),before=JSON.stringify(project);
    const fit=fitComponentAxis(project,'L0',2),motion=motionForAxis(project,'L0',2);
    assert.equal(fit.component,2);assert.equal(fit.calibration,'clip');assert.equal(fit.auto_fit,true);
    assert.ok(fit.range<.1);
    for(const i of [0,10,20])assert.ok(Math.abs(axisValue(motion,fit,i)-50)<.01);
    assert.ok(axisValue(motion,fit,5)>85);assert.ok(axisValue(motion,fit,15)<15);
    assert.equal(JSON.stringify(project),before,'fitting must not mutate any curve or cached sample');
});

test('Fitting excludes invalid samples and respects inversion and angular units',()=>{
    const project=fixture(),fit=fitComponentAxis(project,'L0',2);
    project.processed.push([0,0,100000,0,0,100000]);project.valid.push(false);
    assert.deepEqual(fitComponentAxis(project,'L0',2),fit);
    project.config.axis_settings.L0.invert=true;
    const inverse=fitComponentAxis(project,'L0',2);
    assert.equal(inverse.range,fit.range);assert.equal(inverse.invert,true);
    const m=motionForAxis(project,'L0',2);
    for(let i=0;i<101;i++)assert.ok(Math.abs(axisValue(m,fit,i)+axisValue(m,inverse,i)-100)<1e-7);
    const rotation=fitComponentAxis(project,'R0',2);
    assert.ok(rotation.range>=10&&rotation.range<15,'rotation uses the angular component and range floor');
});

test('Still and small motion retain range floors; missing motion and invalid components fail clearly',()=>{
    const project=fixture();
    assert.equal(fitComponentAxis(project,'L0',0).range,.04);
    assert.equal(fitComponentAxis(project,'R0',0).range,10);
    for(const component of [-1,3,'2','auto',NaN])assert.throws(()=>fitComponentAxis(project,'L0',component),/Choose/);
    project.valid.fill(false);assert.throws(()=>fitComponentAxis(project,'L0',2),/No usable samples/);
});
