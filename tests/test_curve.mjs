import assert from "node:assert/strict";
import {evaluate, roundEven, makeZip, rebuildAxis, validateReference, referenceAgreement} from "../assets/curve.mjs";
import {writeFileSync, readFileSync} from "node:fs";

assert.equal(evaluate([{at:0,pos:0},{at:100,pos:100}],25),25);
assert.equal(evaluate([{at:0,pos:0},{at:100,pos:100}],200),100);
assert.equal(evaluate(undefined,50),50);
assert.equal(roundEven(12.5),12);assert.equal(roundEven(13.5),14);assert.equal(roundEven(-1.5),-2);
const reference={actions:[{at:100,pos:0},{at:1100,pos:100}],offset_ms:-100};
assert.equal(referenceAgreement([{at:0,pos:0},{at:1000,pos:100}],reference,0,1000).rmse,0);
assert.throws(()=>validateReference({actions:[{at:0,pos:5},{at:0,pos:6}]}));
assert.equal(validateReference(reference).length,2);
if(process.argv[2]){
    const project=JSON.parse(readFileSync(process.argv[2],"utf8"));
    for(const axis of Object.keys(project.scripts))assert.deepEqual(rebuildAxis(project,axis),project.scripts[axis],axis+" browser/Python export parity");
    for(const [axis,ref] of Object.entries(project.references||{})){
        const actual=referenceAgreement(project.scripts[axis].actions,ref,project.times_ms[0],project.times_ms.at(-1));
        const expected=project.reference_comparison?.[axis];
        if(expected){assert.ok(Math.abs(actual.rmse-expected.rmse)<1e-8);assert.ok(Math.abs(actual.correlation-expected.correlation)<1e-8);}
    }
}
const archive=makeZip({"example.funscript":JSON.stringify({actions:[{at:0,pos:50}]}),"project.json":"{}"});
writeFileSync("/tmp/s3f-test.zip",new Uint8Array(await archive.arrayBuffer()));
console.log("Curve evaluation, rounding, ZIP and optional Python export parity passed");
