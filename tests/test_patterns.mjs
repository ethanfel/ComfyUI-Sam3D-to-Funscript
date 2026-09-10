import assert from "node:assert/strict";
import {test} from "node:test";
import {PATTERNS,generatePattern,continuePattern,rememberPattern,patternRemovalProblem,removePattern} from "../assets/patterns.mjs";
import {evaluate,validateReference} from "../assets/curve.mjs";

const wave=(period=900)=>Array.from({length:1401},(_,i)=>({at:i*10,pos:Math.round(50+35*Math.sin(i*10/period*2*Math.PI))}));
const gap=(actions,start,end)=>actions.map(p=>({...p,pos:p.at>start&&p.at<end?50:p.pos}));
function preserved(before,after,start,end,blended=true){
    validateReference({actions:after});
    const outside=before.filter(p=>p.at<start||p.at>end);
    for(const point of outside)assert.deepEqual(after.find(p=>p.at===point.at),point);
    if(blended)for(const at of [start,end])assert.equal(evaluate(after,at),evaluate(before,at));
    for(let at=before[0].at;at<=before.at(-1).at;at++)if(at<start||at>end)
        assert.ok(Math.abs(evaluate(after,at)-evaluate(before,at))<=.5,`Unselected motion changed at ${at}`);
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
        const result=generatePattern(actions,4000,7000,{shape});preserved(actions,result.actions,4000,7000,false);
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
    const a=generatePattern(base,2000,3000,{joinMs:150}),b=generatePattern(bad,2000,3000,{joinMs:150});
    assert.deepEqual(a.inside,b.inside);assert.ok(Math.abs(evaluate(a.actions,2001)-30)<1);
    assert.ok(Math.abs(evaluate(a.actions,2999)-30)<1);
    assert.match(generatePattern(base,2000,3000,{center:90,amplitude:50}).summary,/clipped/);
});
test("Generated patterns reach both selection edges without the old endpoint hooks",()=>{
    const actions=[{at:0,pos:65},{at:5000,pos:65}];
    for(const joinMs of [undefined,0]){
        const result=generatePattern(actions,1500,3000,{shape:"Heartbeat",amplitude:10,joinMs});
        assert.equal(evaluate(result.actions,1500),50);
        assert.equal(evaluate(result.actions,3000),40,'The last value belongs to the pattern, not the old curve at 65');
        for(const p of result.inside)assert.ok(Math.abs(p.pos-(50+10*Math.sin((p.at-1500)/2000*2*Math.PI)))<=.5);
        preserved(actions,result.actions,1500,3000,false);
        assert.equal(evaluate(result.actions,1499),65);assert.equal(evaluate(result.actions,3001),65);
        assert.match(result.summary,/no edge blend/);
    }
    const blended=generatePattern(actions,1500,3000,{shape:"Heartbeat",amplitude:10,joinMs:150});
    preserved(actions,blended.actions,1500,3000);
    assert.equal(evaluate(blended.actions,3000),65);assert.match(blended.summary,/150 ms blends/);
});
test("No-blend replacement handles clip edges, sparse outside motion and millisecond selections",()=>{
    const actions=[{at:0,pos:20},{at:5000,pos:80}];
    for(const [start,end]of [[0,5000],[0,1200],[3400,5000],[1500,1501],[1500,3000]]){
        const result=generatePattern(actions,start,end,{amplitude:0,center:70});
        assert.ok(result.inside.every(p=>p.pos===70));
        preserved(actions,result.actions,start,end,false);
        assert.ok(result.actions.every(p=>p.at>=0&&p.at<=5000));
    }
    const adjacent=[{at:0,pos:20},{at:1499,pos:30},{at:3001,pos:50},{at:5000,pos:80}];
    preserved(adjacent,generatePattern(adjacent,1500,3000).actions,1500,3000,false);
});
test("Removing saved pattern records restores sparse curves exactly, including original boundary points",()=>{
    for(const actions of [[{at:0,pos:20},{at:5000,pos:80}],wave()]){
        const result=generatePattern(actions,1500,3000);
        const patterns=rememberPattern([],actions,1500,3000,"Heartbeat"),before=JSON.stringify([actions,patterns,result]);
        const restored=removePattern(result.actions,JSON.parse(JSON.stringify(patterns)),patterns[0].id);
        assert.deepEqual(restored.actions,actions);assert.deepEqual(restored.patterns,[]);
        assert.equal(JSON.stringify([actions,patterns,result]),before);
        assert.ok(patterns[0].before.every(p=>p.at>=1499&&p.at<=3001));
    }
});
test("Removal preserves disjoint later patterns and outside edits; overlapping patterns unwind newest first",()=>{
    const original=wave();let actions=original,patterns=[];
    function insert(start,end){patterns=rememberPattern(patterns,actions,start,end,"Sine Wave");actions=generatePattern(actions,start,end).actions;return patterns.at(-1).id;}
    const a=insert(1500,3000),b=insert(5000,6000);
    actions[0]={...actions[0],pos:25};
    const removed=removePattern(actions,patterns,a);
    assert.deepEqual(removed.actions,generatePattern(original.map((p,i)=>i?p:{...p,pos:25}),5000,6000).actions);
    assert.deepEqual(removed.patterns.map(p=>p.id),[b]);
    const oldActions=structuredClone(actions),oldPatterns=structuredClone(patterns),c=insert(2900,4000);
    assert.match(patternRemovalProblem(patterns,a),/newer overlapping/);
    assert.throws(()=>removePattern(actions,patterns,a),/newer overlapping/);
    const latestRemoved=removePattern(actions,patterns,c);
    assert.deepEqual(latestRemoved.actions,oldActions);assert.deepEqual(latestRemoved.patterns,oldPatterns);
    assert.equal(patternRemovalProblem(latestRemoved.patterns,a),"");
});
test("Short selections, empty scripts, invalid controls and excessive previews fail cleanly",()=>{
    assert.throws(()=>generatePattern([],0,1000));
    const a=wave();for(const opts of [{cycleMs:0},{amplitude:NaN},{stepMs:0},{joinMs:-1},{center:101},{shape:"unknown"},{fadeOutMs:-1},{seed:Infinity}])assert.throws(()=>generatePattern(a,4000,6000,opts));
    for(const[start,end]of [[5,5],[-1,2],[NaN,6000]])assert.throws(()=>generatePattern(a,start,end));
    validateReference({actions:generatePattern(a,5000,5001).actions});
    assert.throws(()=>generatePattern(a,0,3600000,{stepMs:1}),/100,000/);
});
