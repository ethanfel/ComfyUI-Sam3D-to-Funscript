import assert from 'node:assert/strict';
import {test} from 'node:test';
import {smoothActions} from '../assets/curve-edit.mjs';
import {evaluate,validateReference} from '../assets/curve.mjs';

test('Time smoothing reduces a spike and preserves the selected boundaries and outside actions',()=>{
    const actions=[{at:0,pos:20},{at:400,pos:20},{at:500,pos:100},{at:600,pos:20},{at:1000,pos:20}],before=JSON.stringify(actions);
    const result=smoothActions(actions,300,700,200);
    assert.ok(evaluate(result,500)<65);
    for(const t of [0,200,300,700,800,1000])assert.equal(evaluate(result,t),evaluate(actions,t));
    assert.deepEqual(result.filter(p=>p.at<300||p.at>700),actions.filter(p=>p.at<300||p.at>700));
    assert.equal(JSON.stringify(actions),before);validateReference({actions:result});
});
test('Smoothing is based on elapsed time and is stable for sparse versus dense collinear points',()=>{
    const sparse=[{at:0,pos:0},{at:200,pos:100},{at:400,pos:0},{at:600,pos:100},{at:800,pos:0}];
    const dense=Array.from({length:81},(_,i)=>({at:i*10,pos:evaluate(sparse,i*10)}));
    const a=smoothActions(sparse,100,700,160),b=smoothActions(dense,100,700,160);
    for(let t=0;t<=800;t++)assert.ok(Math.abs(evaluate(a,t)-evaluate(b,t))<1.1);
});
test('A one-ms cut becomes a gradual transition; holds and ramps remain bounded',()=>{
    const result=smoothActions([{at:0,pos:0},{at:499,pos:0},{at:500,pos:100},{at:1000,pos:100}],200,800,200);
    assert.ok(evaluate(result,499)>40&&evaluate(result,500)<60);
    assert.ok(Math.abs(evaluate(result,500)-evaluate(result,499))<2);
    for(const window of [1,200,10000]){
        const held=smoothActions([{at:0,pos:67},{at:1000,pos:67}],0,1000,window);
        assert.ok(held.every(p=>p.pos===67));validateReference({actions:held});
    }
    const ramp=[{at:0,pos:0},{at:1000,pos:100}],smoothed=smoothActions(ramp,200,800,200);
    for(let t=0;t<=1000;t+=10)assert.ok(Math.abs(evaluate(smoothed,t)-evaluate(ramp,t))<=.5);
    for(const args of [[1,1,200],[0,100,0],[0,100,-1],[NaN,100,200]])assert.throws(()=>smoothActions(ramp,...args));
});
