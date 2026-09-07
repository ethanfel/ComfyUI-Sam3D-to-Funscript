// SPDX-License-Identifier: GPL-3.0-only
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {Script} from "node:vm";
import {AXES,buildDeviceWireframe,normalizeAxes,deviceSVG} from "./device-wireframes.mjs";

// Unsupported axes must not move the Handy; the carriage has full 125 mm travel.
assert.deepEqual(buildDeviceWireframe("handy2",{L0:38}),buildDeviceWireframe("handy2",{L0:38,L1:0,L2:100,R0:0,R1:100,R2:0}));
const handyLow=buildDeviceWireframe("handy2",{L0:0});
const handyHigh=buildDeviceWireframe("handy2",{L0:100});
assert.equal(handyHigh.carriageY-handyLow.carriageY,125);
assert.deepEqual(handyLow.lines.filter(l=>l.role==="fixed"),handyHigh.lines.filter(l=>l.role==="fixed"));
assert.equal(normalizeAxes({L0:NaN,L1:Infinity,L2:-4,R0:103}).L0,50);
assert.equal(normalizeAxes({L1:Infinity}).L1,50);
assert.equal(normalizeAxes({L2:-4}).L2,0);
assert.equal(normalizeAxes({R0:103}).R0,100);

// Twist should rotate the receiver marker, not the platform's rod attachments.
const untwisted=buildDeviceWireframe("sr6",{R0:50});
const twisted=buildDeviceWireframe("sr6",{R0:100});
assert.deepEqual(untwisted.linkages,twisted.linkages);
assert.notDeepEqual(untwisted.lines.filter(l=>l.role==="marker"),twisted.lines.filter(l=>l.role==="marker"));

let frames=0,maxError=0;
function verifyFrame(frame){
    assert.ok(frame.reachable,"chosen preview ranges should remain reachable");
    assert.equal(frame.linkages.length,6);
    for(const line of frame.lines)for(const point of [line.a,line.b])assert.ok(point.every(Number.isFinite));
    for(const link of frame.linkages){
        const hornLength=Math.hypot(...link.pivot.map((v,i)=>v-link.elbow[i]));
        maxError=Math.max(maxError,Math.abs(hornLength-link.horn),link.residual);
        assert.ok(Math.abs(hornLength-link.horn)<1e-8);
        assert.ok(link.residual<1e-8,"rod length must not change during motion");
    }
    frames++;
}
// Sweep each axis, and combine endpoint positions to check reachable extremes.
for(const axis of AXES)for(let pos=0;pos<=100;pos++)verifyFrame(buildDeviceWireframe("sr6",{[axis]:pos}));
for(let bits=0;bits<64;bits++)verifyFrame(buildDeviceWireframe("sr6",Object.fromEntries(AXES.map((a,j)=>[a,bits>>j&1?100:0]))));

// Check that a representative full demo cycle keeps the same IK branch.
let previous;
for(let i=0;i<1200;i++){
    const t=i/60;
    const frame=buildDeviceWireframe("sr6",Object.fromEntries(AXES.map((a,j)=>[a,50+(a==="L0"?34:17)*Math.sin(t*[1.8,.7,.53,.41,.83,.61][j])])));
    verifyFrame(frame);
    if(previous)frame.linkages.forEach((link,j)=>assert.ok(Math.hypot(...link.elbow.map((v,k)=>v-previous.linkages[j].elbow[k]))<2,"servo arm should not jump between IK solutions"));
    previous=frame;
}

// Ensure checked-in previews reflect current source and contain parseable inline JS.
const local=name=>new URL(name,import.meta.url);
for(const device of ["handy2","sr6"])assert.equal(await readFile(local(`${device}.svg`),"utf8"),deviceSVG(device));
const source=await readFile(local("device-wireframes.mjs"),"utf8");
const template=await readFile(local("preview.template.html"),"utf8");
const html=await readFile(local("preview.html"),"utf8");
assert.equal(html,template.replace("/* DEVICE_MODULE */",()=>source.replace(/^export /gm,"")));
new Script(html.match(/<script type="module">([\s\S]*?)<\/script>/)[1]);
console.log(`Verified Handy channel isolation and 125 mm travel; ${frames} SR6 poses with fixed horn/rod lengths (max error ${maxError.toExponential(2)}); generated assets and demo JS syntax.`);
