import assert from "node:assert/strict";
import {test} from "node:test";
import {LAYOUT_DEFAULTS,layoutSettings,previewWidth,thumbnailCount} from "../assets/timeline-layout.mjs";

test("Saved view sizes are bounded and tolerate invalid or older local storage",()=>{
    for(const value of [undefined,null,"broken",{},[]])assert.deepEqual(layoutSettings(value),LAYOUT_DEFAULTS);
    assert.deepEqual(layoutSettings({wide:false,stage:99999,thumbnails:-1,tracking:NaN,split:99,overview:Infinity}),{...LAYOUT_DEFAULTS,wide:false,stage:1100,thumbnails:40,split:.8});
    const saved={wide:false,stage:650,split:.37,thumbnails:140,tracking:180,stabilization:120,overview:80};
    assert.deepEqual(layoutSettings(JSON.parse(JSON.stringify(saved))),saved);
    assert.equal(layoutSettings({...saved,split:null}).split,null);
});
test("Automatic preview sizing follows video shape and preserves room for settings",()=>{
    const portrait=previewWidth(1800,500,9/16),landscape=previewWidth(1800,500,16/9);
    assert.ok(portrait<300&&landscape>700);
    assert.ok(previewWidth(1800,700,9/16)>portrait);
    for(const width of [320,560,760,1200,3840])for(const aspect of [.3,9/16,1,16/9,4,NaN]){
        const actual=previewWidth(width,500,aspect);assert.ok(actual>0&&actual<width);
        if(width>=760)assert.ok(width-actual>=330);
    }
    assert.equal(previewWidth(1800,500,9/16,.5),previewWidth(1800,500,16/9,.5));
});
test("Thumbnail density follows full-frame aspect and resized height, with bounded requests",()=>{
    assert.ok(thumbnailCount(1400,90,9/16)>thumbnailCount(1400,90,16/9));
    assert.ok(thumbnailCount(1400,160,9/16)<thumbnailCount(1400,90,9/16));
    assert.equal(thumbnailCount(100000,40,.1),40);assert.equal(thumbnailCount(1,100,1),2);
    assert.ok(Number.isFinite(thumbnailCount(500,90,NaN)));
});
