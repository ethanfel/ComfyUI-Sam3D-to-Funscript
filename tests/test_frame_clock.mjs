import test from 'node:test';
import assert from 'node:assert/strict';
import {frameClock} from '../assets/frame-clock.mjs';
const vfr=()=>frameClock({first_frame:10,end_frame:15,times_ms:[2000,2030,2100,2120,2200],end_ms:2250});
test('VFR steps to adjacent frames, clamps endpoints and seeks inside the requested frame',()=>{
 const f=vfr();assert.equal(f.step(2030,1),2100);assert.equal(f.step(2100,-1),2030);assert.equal(f.step(2130,-1),2100);assert.equal(f.step(2000,-1),2000);assert.equal(f.step(2200,10),2200);
 assert.equal(f.containing(2199),13);assert.equal(f.containing(2200),14);assert.ok(f.seekTime(2100)>2100&&f.seekTime(2100)<2120);
});
test('zero based original indices, end-exclusive ranges and last-frame selections',()=>{
 const f=vfr();assert.equal(f.first,10);assert.equal(f.at(15),2250);assert.equal(f.ceil(2250),15);assert.equal(f.ceil(2010),11);assert.equal(f.snap(2240),2200);assert.equal(f.snap(2240,true),2250);
 const last=f.containing(2200);assert.equal(f.at(last+1)-f.at(last),50);assert.equal(f.ceil(f.at(last+1))-f.ceil(f.at(last)),1);
});
test('frame ruler has integer labels and one-frame ticks when zoomed in; hour scale bounded',()=>{
 const times=Array.from({length:108000},(_,i)=>i*1000/30),f=frameClock({first_frame:0,end_frame:times.length,times_ms:times,end_ms:3600000});
 assert.ok(f.ticks(0,3600000,1200).length<30);
 const ticks=f.ticks(1000,1300,1200);assert.deepEqual(ticks.map(t=>t.frame),[30,31,32,33,34,35,36,37,38,39]);assert.ok(ticks.every(t=>/^\d+$/.test(t.label)));
 for(let i=1;i<300;i++){assert.equal(f.ceil(f.at(i)),i);assert.equal(f.containing(f.at(i)),i);assert.equal(f.step(f.at(i),-1),f.at(i-1));}
});
test('invalid or empty timestamp indices fail explicitly',()=>{
 for(const times of [[],[10,10],[10,5],[NaN,20]])assert.throws(()=>frameClock({first_frame:0,end_frame:times.length,times_ms:times,end_ms:30}));
});
