import assert from 'node:assert/strict';
import {test} from 'node:test';
import {evaluate,reduceActions,validateReference} from '../assets/curve.mjs';
import {smoothActions} from '../assets/curve-edit.mjs';
import {generatePattern} from '../assets/patterns.mjs';
import {spliceActions} from '../assets/timeline.mjs';

const point=(at,pos)=>({at,pos});
function equivalent(before,after){
    for(let i=0;i<before.length;i++){
        for(const t of [before[i].at,(before[i].at+(before[i+1]?.at??before[i].at))/2])
            assert.ok(Math.abs(evaluate(before,t)-evaluate(after,t))<1e-10,`curve changed at ${t}`);
    }
}
test('Exact cleanup removes redundant ramp/hold points without moving reversals or dwell boundaries',()=>{
    const a=[point(0,10),point(100,20),point(200,30),point(300,40),point(400,40),point(500,40),point(600,30),point(700,20)];
    const before=structuredClone(a),r=reduceActions(a);
    assert.deepEqual(r.actions,[a[0],a[3],a[5],a[7]]);assert.equal(r.removed,4);assert.equal(r.maxError,0);
    assert.deepEqual(a,before);equivalent(a,r.actions);
    assert.deepEqual(reduceActions(Array.from({length:101},(_,i)=>point(i,i))).actions,[point(0,0),point(100,100)]);
    assert.deepEqual(reduceActions([point(0,50)]).actions,[point(0,50)]);
});
test('Exact mode uses integer equality even at very large timestamps and keeps subtle slope changes',()=>{
    const offset=7_000_000_000_000_000;
    const a=[point(offset,0),point(offset+10,1),point(offset+20,2),point(offset+31,3),point(offset+40,4)];
    const r=reduceActions(a);
    assert.equal(r.actions.length,4);assert.equal(r.actions[1].at,offset+20);equivalent(a,r.actions);
});
test('Selection and non-knot boundaries retain the bracketing points and leave outside actions intact',()=>{
    const a=Array.from({length:21},(_,i)=>point(i*10,i*4));
    const r=reduceActions(a,{start:25,end:175,protectedTimes:[85,130]});
    for(const at of [20,30,80,90,130,170,180])assert.ok(r.actions.some(p=>p.at===at));
    assert.deepEqual(r.actions.filter(p=>p.at<25||p.at>175),a.filter(p=>p.at<25||p.at>175));
    assert.equal(r.before,15);assert.equal(r.before-r.after,r.removed);equivalent(a,r.actions);
});
test('Tolerance checks the original curve, retaining extrema, hold endpoints, cuts and protected sections',()=>{
    const a=[point(0,0),point(98,10),point(202,20),point(300,30),point(398,40),point(500,50),
        point(600,50),point(700,50),point(800,40),point(900,30),point(901,80),point(1000,90)];
    const r=reduceActions(a,{tolerance:.5,protectedTimes:[300]});
    assert.ok(r.removed>=2);assert.ok(r.maxError>0&&r.maxError<=.5);
    for(const at of [0,300,500,700,900,901,1000])assert.ok(r.actions.some(p=>p.at===at),`lost ${at}`);
    let actual=0;for(let t=0;t<=1000;t+=.25)actual=Math.max(actual,Math.abs(evaluate(a,t)-evaluate(r.actions,t)));
    assert.ok(actual<=.5+1e-10);assert.ok(Math.abs(actual-r.maxError)<.002);
    const reversed=[point(0,0),point(100,40),point(200,30),point(300,80),point(400,0)];
    assert.deepEqual(reduceActions(reversed,{tolerance:100}).actions,reversed);
});
test('Long plateau and dense linear inputs stay bounded; no point dropping by sample count',()=>{
    const held=Array.from({length:100000},(_,i)=>point(i,40));
    assert.equal(reduceActions(held).after,2);
    const a=Array.from({length:10001},(_,i)=>point(i*5,Math.round(50+40*Math.sin(i/99))));
    const r=reduceActions(a,{tolerance:.5});validateReference({actions:r.actions});
    for(let i=0;i<a.length;i++)assert.ok(Math.abs(evaluate(r.actions,a[i].at)-a[i].pos)<=.5+1e-9);
});
test('Automatic cleanup applies after smoothing, pattern sampling and source joins',()=>{
    const a=[point(0,20),point(250,20),point(500,20),point(750,20),point(1000,20)];
    const smoothed=smoothActions(a,100,900,200);
    assert.ok(smoothed.length<9);equivalent(a,smoothed);
    const generated=generatePattern([point(0,50),point(10000,50)],1000,9000,{shape:'Square',cycleMs:2000,stepMs:5,joinMs:0});
    assert.ok(generated.inside.length<40,`square kept ${generated.inside.length} points`);
    assert.ok(generated.inside.some(p=>p.pos===10));assert.ok(generated.inside.some(p=>p.pos===90));
    const joined=spliceActions(a,a,0,1000,'cut',0);
    assert.deepEqual(joined,[point(0,20),point(1000,20),point(1001,20)]);
});
test('Invalid settings reject cleanly without mutating input',()=>{
    const a=[point(0,0),point(100,100)],before=structuredClone(a);
    for(const options of [{tolerance:NaN},{tolerance:-1},{tolerance:101},{start:100,end:0},{start:-1},{end:Infinity},{protectedTimes:[NaN]}])
        assert.throws(()=>reduceActions(a,options));
    assert.throws(()=>reduceActions([point(0,0),point(0,1)]));assert.deepEqual(a,before);
});
