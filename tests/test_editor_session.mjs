import assert from 'node:assert/strict';
import {test} from 'node:test';
import {sameVideoSource} from '../assets/editor-session.mjs';

test('Playback is preserved only for the same source file and known fingerprint',()=>{
    const source={path:'/videos/one.mp4',size:90000,mtime_ns:1780595540152825100};
    assert.equal(sameVideoSource(source,{...source}),true);
    assert.equal(sameVideoSource(source,{path:source.path}),true);
    assert.equal(sameVideoSource(source,{...source,path:'/videos/two.mp4'}),false);
    assert.equal(sameVideoSource(source,{...source,size:90001}),false);
    assert.equal(sameVideoSource(source,{...source,mtime_ns:source.mtime_ns+1000000}),false);
    assert.equal(sameVideoSource(null,source),false);
    assert.equal(sameVideoSource(source,null),false);
    assert.equal(sameVideoSource({},{}),false);
});
