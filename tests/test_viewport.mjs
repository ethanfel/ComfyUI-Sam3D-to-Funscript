import assert from 'node:assert/strict';
import {test} from 'node:test';
import {timelineView, zoomView, panView, followView, sliderSpan, spanSlider, formatTime, rulerTicks, visibleRange, displayIndices} from '../assets/viewport.mjs';

test('An hour opens with a useful view; zoom anchors and pans preserve original time',()=>{
    const duration=3600000,initial=timelineView(duration);
    assert.equal(initial.span_ms,30000);
    let view=panView(duration,initial,1800000);assert.equal(view.follow,false);
    const zoom=zoomView(duration,view,1000,1812000);
    assert.equal(zoom.start_ms,1811600);assert.equal(zoom.span_ms,1000);
    assert.equal((1812000-view.start_ms)/view.span_ms,(1812000-zoom.start_ms)/zoom.span_ms);
    assert.equal(panView(duration,zoom,Infinity).start_ms,duration-1000);
    assert.equal(panView(duration,zoom,-500).start_ms,0);
    assert.equal(zoomView(duration,view,Infinity).span_ms,30000); // Nonfinite external state falls back safely.
    assert.equal(timelineView(100).span_ms,100);
    assert.equal(timelineView(duration,{span_ms:1,start_ms:duration}).start_ms,duration-250);
});

test('Logarithmic zoom spans full hour to subsecond; follow pages only outside the view',()=>{
    const duration=3600000;
    for(const slider of [0,1,200,500,750,1000])assert.ok(Math.abs(spanSlider(duration,sliderSpan(duration,slider))-slider)<1e-8);
    assert.equal(sliderSpan(duration,0),duration);assert.ok(Math.abs(sliderSpan(duration,1000)-250)<1e-8);
    const view=timelineView(duration,{start_ms:1800000,span_ms:30000});
    assert.equal(followView(duration,view,1810000),view);
    assert.equal(followView(duration,view,1840000).start_ms,1837000);
    assert.equal(followView(duration,view,1810000,true).start_ms,1795000);
    assert.equal(followView(duration,view,duration,true).start_ms,duration-view.span_ms);
});

test('Rulers use readable hours and subsecond precision without duplicate labels',()=>{
    assert.equal(formatTime(3599999,3,true),'0:59:59.999');
    assert.equal(formatTime(3600000,3),'1:00:00.000');
    assert.equal(formatTime(59999,0),'1:00');
    for(const [start,end] of [[0,3600000],[1799345,1829345],[3599750,3600000],[0,100]]){
        const ticks=rulerTicks(start,end,900,3600000);
        assert.ok(ticks.length>=1&&ticks.length<=12);
        assert.equal(new Set(ticks.map(t=>t.label)).size,ticks.length);
        assert.ok(ticks.every(t=>t.time>=start&&t.time<=end));
    }
});

test('Visible data includes both interpolation neighbors and preserves narrow extrema',()=>{
    const count=216001,timeAt=i=>i*1000/60,valueAt=i=>i===1001?100:i===1002?0:50;
    const range=visibleRange(count,timeAt,1800000,1830000);
    assert.ok(range[0]<=108000&&range[1]>=109800);
    assert.ok(range[1]-range[0]<1804);
    const full=displayIndices(count,timeAt,valueAt,0,3600000,1000);
    assert.ok(full.length<=4004);assert.ok(full.includes(1001));assert.ok(full.includes(1002));
    const gap=displayIndices(count,timeAt,i=>i===3001?null:valueAt(i),0,3600000,1000,i=>i===5001);
    assert.ok(gap.includes(null));assert.ok(gap.includes(5001));
    assert.ok(full.every((n,i)=>i===0||n>full[i-1]));
    assert.deepEqual(visibleRange(2,i=>[100,200][i],120,130),[0,2]);
    assert.deepEqual(displayIndices(0,()=>0,()=>0,0,1000,1000),[]);
});
