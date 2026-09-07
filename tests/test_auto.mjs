import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {autoFitAxis, motionForAxis, rebuildAxis} from "../assets/curve.mjs";

for(const file of process.argv.slice(2)){
    const project=JSON.parse(readFileSync(file,"utf8")),original=JSON.stringify(project);
    for(const axis of Object.keys(project.scripts)){
        assert.deepEqual(rebuildAxis(project,axis),project.scripts[axis],axis+" Python/browser actions");
        if(project.config.axis_settings[axis].component!=="auto")continue;
        const actual=motionForAxis(project,axis),expected=project.metrics[axis].auto_direction;
        assert.equal(actual.spans.length,expected.length);
        for(let i=0;i<actual.spans.length;i++){
            assert.equal(actual.spans[i].mode,expected[i].mode);
            assert.ok(Math.abs(actual.spans[i].share-expected[i].share)<1e-8);
            actual.spans[i].direction.forEach((v,j)=>assert.ok(Math.abs(v-expected[i].direction[j])<1e-8));
        }
        project.valid.forEach((valid,i)=>{if(!valid)assert.equal(actual.processed[i],null);});
        if(project.config.axis_settings[axis].auto_fit){
            const fitted=autoFitAxis(project,axis);
            assert.equal(fitted.range,project.config.axis_settings[axis].range);
            assert.equal(fitted.center,project.config.axis_settings[axis].center);
        }
    }
    assert.equal(JSON.stringify(project),original,"fitting must not mutate cached motion or scripts");
    const old=structuredClone(project);delete old.orientation_hints;
    assert.ok(motionForAxis(old,"L0","auto").spans.every(span=>span.orientation==="body"));
}
console.log("Automatic direction, fitting, missing spans and Python/browser export parity passed");
