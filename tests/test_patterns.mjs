import assert from "node:assert/strict";
import {test} from "node:test";
import {PATTERNS,generatePattern,continuePattern} from "../assets/patterns.mjs";
import {evaluate,validateReference} from "../assets/curve.mjs";

const wave=(period=900)=>Array.from({length:1401},(_,i)=>({at:i*10,pos:Math.round(50+35*Math.sin(i*10/period*2*Math.PI))}));
const gap=(actions,start,end)=>actions.map(p=>({...p,pos:p.at>start&&p.at<end?50:p.pos}));
function preserved(before,after,start,end){
    validateReference({actions:after});
    assert.deepEqual(after.filter(p=>p.at<start||p.at>end),before.filter(p=>p.at<start||p.at>end));
    for(const at of [start,end])assert.equal(evaluate(after,at),evaluate(before,at));
}
test("A rhythmic gap is reconstructed from both sides, including its phase and amplitude",()=>{
    const original=wave(),bad=gap(original,5000,6400),snapshot=JSON.stringify(bad);
    const result=continuePattern(bad,5000,6400);
    const mae=Array.from({length:141},(_,i)=>Math.abs(evaluate(result.actions,5000+i*10)-evaluate(original,5000+i*10))).reduce((s,v)=>s+v,0)/141;
    assert.ok(mae<2,`Mean error ${mae}`);assert.ok(result.quality>.95);
    preserved(bad,result.actions,5000,6400);assert.equal(JSON.stringify(bad),snapshot);
    const corrupted=bad.map(p=>({...p,pos:p.at>5000&&p.at<6400?(p.at%40?0:100):p.pos}));
    assert.deepEqual(continuePattern(corrupted,5000,6400).inside,result.inside,"The contents of the bad gap must not affect synthesis");
});
test("Both-side phase joining retains an oscillation when the following shot reverses phase",()=>{
    const original=wave(), shifted=original.map(p=>({...p,pos:p.at>=7000?100-p.pos:p.pos})),bad=gap(shifted,5000,7000);
    const result=continuePattern(bad,5000,7000);
    const mid=result.inside.filter(p=>p.at>5500&&p.at<6500).map(p=>p.pos);
    assert.ok(Math.max(...mid)-Math.min(...mid)>55,"Crossfading opposite waves would flatten this interval");
    preserved(bad,result.actions,5000,7000);
});
test("Different rhythms blend, one-sided context fills clip edges, manual cycle is honored",()=>{
    const actions=wave().map(p=>p.at<7000?p:{...p,pos:Math.round(55+25*Math.sin(p.at/1100*2*Math.PI))});
    for(const[start,end,options]of [[5000,7000,{}],[0,1200,{}],[12500,14000,{}],[5000,6500,{side:"before",cycleMs:900}],[5000,6500,{side:"after",contextMs:5000}]]){
        const bad=gap(actions,start,end),result=continuePattern(bad,start,end,options);
        preserved(bad,result.actions,start,end);assert.ok(result.inside.some(p=>p.pos<35)&&result.inside.some(p=>p.pos>65));
    }
});
test("Flat, linear and insufficient context do not invent a detected rhythm",()=>{
    for(const actions of [[{at:0,pos:50},{at:10000,pos:50}],[{at:0,pos:0},{at:10000,pos:100}],wave().filter(p=>p.at<=500)])assert.throws(()=>continuePattern(actions,200,300),/No repeating/);
    assert.throws(()=>continuePattern(wave(),5000,6000,{side:"unknown"}));
    assert.throws(()=>continuePattern(wave(),5000,6000,{contextMs:NaN}));
});
test("All supplied shapes generate valid bounded curves without changing outside actions",()=>{
    const actions=wave(),snapshot=JSON.stringify(actions);
    for(const shape of PATTERNS){
        const result=generatePattern(actions,4000,7000,{shape});preserved(actions,result.actions,4000,7000);
        assert.ok(result.inside.length>100);assert.match(result.summary,new RegExp(shape));
    }
    assert.equal(JSON.stringify(actions),snapshot);
    assert.deepEqual(generatePattern(actions,4000,7000,{shape:"Heartbeat"}).actions,generatePattern(actions,4000,7000,{shape:"Sine Wave"}).actions);
});
test("Cycle, amplitude, center, overlapping fades and waveform reversal control generated motion",()=>{
    const base=[{at:0,pos:50},{at:10000,pos:50}],options={shape:"Sine Wave",cycleMs:1000,amplitude:20,center:50,joinMs:0};
    const a=generatePattern(base,2000,6000,options),b=generatePattern(base,2000,6000,{...options,reverse:true});
    assert.equal(evaluate(a.actions,2250),70);assert.equal(evaluate(a.actions,2750),30);
    for(const p of a.inside)assert.ok(Math.abs(p.pos+evaluate(b.actions,p.at)-100)<=1);
    const faded=generatePattern(base,2000,6000,{...options,fadeInMs:4000,fadeOutMs:4000});
    assert.ok(Math.abs(evaluate(faded.actions,2250)-50)<=2);assert.ok(Math.abs(evaluate(faded.actions,5750)-50)<=2);
});
test("Random previews have a stable seed and match when applied; distinct seeds differ",()=>{
    const a=wave(),options={shape:"Random",seed:432};
    assert.deepEqual(generatePattern(a,4000,6000,options),generatePattern(a,4000,6000,options));
    assert.notDeepEqual(generatePattern(a,4000,6000,options).inside,generatePattern(a,4000,6000,{...options,seed:433}).inside);
});
test("Smooth joins do not follow corruption inside the range; clipping is visible",()=>{
    const base=[{at:0,pos:30},{at:2000,pos:30},{at:3000,pos:30},{at:5000,pos:30}];
    const bad=[...base.slice(0,2),{at:2010,pos:100},{at:2990,pos:0},...base.slice(2)];
    const a=generatePattern(base,2000,3000),b=generatePattern(bad,2000,3000);
    assert.deepEqual(a.inside,b.inside);assert.ok(Math.abs(evaluate(a.actions,2001)-30)<1);
    assert.ok(Math.abs(evaluate(a.actions,2999)-30)<1);
    assert.match(generatePattern(base,2000,3000,{center:90,amplitude:50}).summary,/clipped/);
});
test("Short selections, empty scripts, invalid controls and excessive previews fail cleanly",()=>{
    assert.throws(()=>generatePattern([],0,1000));
    const a=wave();for(const opts of [{cycleMs:0},{amplitude:NaN},{stepMs:0},{joinMs:-1},{center:101},{shape:"unknown"},{fadeOutMs:-1},{seed:Infinity}])assert.throws(()=>generatePattern(a,4000,6000,opts));
    for(const[start,end]of [[5,5],[-1,2],[NaN,6000]])assert.throws(()=>generatePattern(a,start,end));
    validateReference({actions:generatePattern(a,5000,5001).actions});
    assert.throws(()=>generatePattern(a,0,3600000,{stepMs:1}),/100,000/);
});
