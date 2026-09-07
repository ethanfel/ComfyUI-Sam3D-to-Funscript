import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {evaluate,invertAxis,motionForAxis,rebuildAxis} from "../assets/curve.mjs";

function check(project,axis){
    const before=JSON.stringify(project),s=project.config.axis_settings[axis];
    const mirror=invertAxis(project,axis),expected=project.scripts[axis].actions.map(a=>({...a,pos:100-a.pos}));
    assert.deepEqual(mirror.script.actions,expected,"Mirror every authored point without resampling or clamping");
    assert.equal(mirror.settings.range,s.range);assert.equal(mirror.settings.center,100-s.center);
    assert.equal(mirror.settings.invert,!s.invert);assert.equal(mirror.settings.auto_fit,s.auto_fit);
    assert.equal(JSON.stringify(project),before,"Inversion helper must not mutate its inputs");
    const reversed=structuredClone(project);
    reversed.config.axis_settings[axis]=mirror.settings;reversed.scripts[axis]=mirror.script;
    assert.deepEqual(invertAxis(reversed,axis).script,project.scripts[axis],"Two reversals preserve manual edits and timestamps exactly");
    for(let time=0;time<=project.metadata.duration_ms;time+=13){
        assert.ok(Math.abs(evaluate(project.scripts[axis].actions,time)+evaluate(mirror.script.actions,time)-100)<1e-10);
    }
    const values=motionForAxis(project,axis).processed.filter(Number.isFinite);
    const mapped=(settings,v)=>settings.center+v/settings.range*100*(settings.invert?-1:1);
    values.forEach(v=>assert.ok(Math.abs(mapped(s,v)+mapped(mirror.settings,v)-100)<1e-10,"Calibration must mirror before clipping too"));
    assert.equal(values.filter(v=>mapped(s,v)<0||mapped(s,v)>100).length,
        values.filter(v=>mapped(mirror.settings,v)<0||mapped(mirror.settings,v)>100).length,"No additional source clipping");
    const rebuilt=rebuildAxis(reversed,axis);
    const direct=rebuildAxis(project,axis);
    // RDP may choose different equivalent vertices at floating-point ties.
    project.times_ms.forEach(time=>assert.ok(Math.abs(evaluate(rebuilt.actions,time)+evaluate(direct.actions,time)-100)<=2*project.config.tolerance+1e-8));
}

const values=[-.052,-.023,.021,0,-.045,-.014,.028,.031];
const fixture={times_ms:[0,37,83,120,250,287,333,370],valid:[true,true,true,false,true,true,true,true],
    segments:[0,0,0,0,1,1,1,1],metadata:{duration_ms:400},
    raw:values.map(v=>[v,0,0,v*100,0,0]),processed:values.map(v=>[v,0,0,v*100,0,0]),
    config:{max_gap_ms:250,tolerance:.75,axis_settings:{
        L0:{component:0,range:.1,center:64.014,invert:false,auto_fit:false},
        R0:{component:0,range:10,center:73,invert:false,auto_fit:false}}},scripts:{}};
for(const axis of ["L0","R0"])fixture.scripts[axis]=rebuildAxis(fixture,axis);
check(fixture,"L0");check(fixture,"R0");
const edited=structuredClone(fixture);
edited.scripts.L0.actions.splice(1,0,{at:19,pos:100},{at:23,pos:0});
check(edited,"L0");
for(const file of process.argv.slice(2)){
    const project=JSON.parse(readFileSync(file,"utf8"));
    for(const axis of Object.keys(project.scripts))check(project,axis);
}
console.log("Inversion preserves curve shape, manual edits, timing, gaps and clipping with off-center calibration");
