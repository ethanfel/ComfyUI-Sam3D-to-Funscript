import assert from "node:assert/strict";
import {originalPixel,previewShift,previewMediaTime,previewTimelineTime} from "../assets/video-preview.mjs";
const mapping={times_ms:[0,40,110,150],shift_xy:[[0,0],[15,-8],[-5,10],[0,0]],padding_xy:[24,18],source_offset_ms:1250};
for(const [i,time] of mapping.times_ms.entries()){
    const original=[100+i,75-i],shift=mapping.shift_xy[i];
    const stabilized=original.map((v,j)=>v+mapping.padding_xy[j]-shift[j]);
    assert.deepEqual(originalPixel(mapping,stabilized,time),original);
    assert.equal(previewTimelineTime(previewMediaTime(time,"original",mapping),"original",mapping),time);
    assert.equal(previewMediaTime(time,"stabilized",mapping),time/1000);
}
// Variable frame timing uses the displayed frame's transform, not an interpolation.
assert.deepEqual(previewShift(mapping,109),[15,-8]);
assert.deepEqual(previewShift(mapping,110),[-5,10]);
assert.deepEqual(previewShift(mapping,999),[0,0]);
assert.equal(previewMediaTime(240,"original",null),.24);
// Source files may start at a nonzero presentation timestamp. Actions stay relative.
assert.equal(previewMediaTime(240,"stabilized",null,2000),2.24);
assert.equal(previewTimelineTime(2.24,"stabilized",null,2000),240);
assert.equal(previewMediaTime(240,"stabilized",mapping,2000),.24);
assert.equal(previewMediaTime(240,"original",mapping,2000),1.49);
console.log("Video preview: original pixel recovery, frame timing and trimmed timeline round trips passed");
