import assert from "node:assert/strict";
import {test} from "node:test";
import {autoFitAxis, motionForAxis, rebuildAxis, invertAxis, evaluate} from "../assets/curve.mjs";
import {initializeTimeline, fitSelectionTrack, trackProject, trackCoverage, applyTrack, mainPoseProject, assignTrack, restoreTimeline, timelineState} from "../assets/timeline.mjs";

function fixture(amplitude=.03) {
    const times=Array.from({length:251},(_,i)=>i*40);
    const raw=times.map(t=>t<6000?[.35*Math.sin(t/220),.05,0,0,0,0]:[.7,1+amplitude*Math.sin((t-6000)*Math.PI/250),.4,0,0,0]);
    const project={schema:"sam3d-funscript/1",metadata:{duration_ms:10040,image_size:[100,100],source:{path:"fixture.mp4"},
        mask_boxes:times.map(t=>[t]),timestamps:times.map(t=>({time_ms:t}))},times_ms:times,
        valid:times.map(()=>true),segments:times.map(()=>0),raw,processed:raw.map(r=>[...r]),points:times.map(t=>[t]),pixels:times.map(t=>[t]),
        config:{target_anchor:"right_hand",target_person:0,frame:"camera",max_gap_ms:250,tolerance:.75,
            axis_settings:{L0:{component:"auto",range:1,center:50,invert:false,auto_fit:false},R0:{component:0,range:60,center:50,invert:false,auto_fit:false}}},scripts:{},metrics:{}};
    project.config.axis_settings.L0=autoFitAxis(project,"L0");
    for(const axis of ["L0","R0"])project.scripts[axis]=rebuildAxis(project,axis);
    initializeTimeline(project);return project;
}

test("Local fit recovers a small late movement on another axis without global offset or range compression",()=>{
    const project=fixture(),before=JSON.stringify(project),track=project.timeline.tracks[0];
    const fitted=fitSelectionTrack(project,track,[6000,10000]),data=trackProject(project,fitted),report=motionForAxis(data,"L0").spans[0];
    assert.equal(JSON.stringify(project),before,"Preparing a local fit must not change main, tracks, or pose geometry");
    assert.ok(Math.abs(report.direction[1]-1)<1e-10,"Direction fits only movement inside the selection");
    assert.ok(fitted.settings.range>.06&&fitted.settings.range<.08);
    assert.ok(Math.abs(fitted.settings.center-50)<1e-8);
    assert.ok(Math.max(...fitted.script.actions.map(a=>a.pos))-Math.min(...fitted.script.actions.map(a=>a.pos))>=80);
    assert.ok(fitted.script.actions.every(a=>a.pos>=5&&a.pos<=95),"Local fitting leaves headroom for every filtered peak");
    assert.deepEqual(data.times_ms,project.times_ms.filter(t=>t>=6000));
    assert.equal(data.points[0],project.points[150]);assert.equal(data.pixels[0],project.pixels[150]);
    assert.deepEqual(data.metadata.mask_boxes[0],project.metadata.mask_boxes[150]);
    assert.equal(data.metadata.timestamps[0].time_ms,6000);
    assert.ok(data.processed.every(r=>Math.abs(r[1])<.031));
    assert.ok(project.processed[150][1]>.9);
    assert.deepEqual(trackCoverage(project,fitted),[6000,10000]);
});

test("Window fitting retains minimum gain limits, inversion, missing poses and cut boundaries",()=>{
    const still=fixture(.0001),small=fitSelectionTrack(still,still.timeline.tracks[0],[6000,10000]);
    assert.equal(small.settings.range,.04);
    assert.ok(Math.max(...small.script.actions.map(a=>a.pos))-Math.min(...small.script.actions.map(a=>a.pos))<=1);
    const project=fixture();
    // Start another independently centered span after a gap and large displacement.
    for(let i=195;i<200;i++){project.valid[i]=false;project.raw[i]=project.processed[i]=[null,null,null,null,null,null];}
    for(let i=200;i<project.times_ms.length;i++){project.segments[i]=1;project.raw[i][1]+=5;project.processed[i][1]+=5;}
    const track=project.timeline.tracks[0];
    const normal=fitSelectionTrack(project,track,[6000,10000]);track.settings.invert=true;
    const inverted=fitSelectionTrack(project,track,[6000,10000]);
    const data=trackProject(project,inverted);assert.equal(motionForAxis(data,"L0").spans.length,2);
    const mirror=invertAxis(data,"L0");
    assert.deepEqual(mirror.script.actions,inverted.script.actions.map(a=>({...a,pos:100-a.pos})));
    for(let t=6000;t<=10000;t+=10)assert.ok(Math.abs(evaluate(normal.script.actions,t)+evaluate(inverted.script.actions,t)-100)<=1.5);
    assert.ok(inverted.settings.range<.08,"A cut's absolute offset must not inflate local gain");
    assert.equal(evaluate(inverted.script.actions,7950),evaluate(inverted.script.actions,7800),"Missing poses remain held");
});

test("Window tracks survive composition, deletion, undo, project roundtrip and reset on reassignment",()=>{
    const project=fixture(),fitted=fitSelectionTrack(project,project.timeline.tracks[0],[6000,10000]);
    project.timeline.tracks.push(fitted);const state=structuredClone(timelineState(project));
    applyTrack(project,fitted,"L0",{start:6500,end:9500,blendMs:200});
    assert.deepEqual(project.timeline.main.L0.regions[0].window,[6000,10000]);
    project.timeline.tracks.pop();
    const pose=mainPoseProject(project,"L0",7500);assert.equal(pose.data.times_ms[0],6000);
    assert.deepEqual(motionForAxis(pose.data,"L0").spans,motionForAxis(trackProject(project,fitted),"L0").spans);
    const loaded=JSON.parse(JSON.stringify(project));initializeTimeline(loaded);
    assert.deepEqual(mainPoseProject(loaded,"L0",7500).data.processed,pose.data.processed);
    restoreTimeline(project,state);assert.deepEqual(trackProject(project,project.timeline.tracks[1]).processed,pose.data.processed);
    assignTrack(project,project.timeline.tracks[1],fitted.source,"R0");
    assert.equal(project.timeline.tracks[1].window,undefined);
    assert.equal(trackProject(project,project.timeline.tracks[1]).times_ms[0],0);
    const rotation=fitSelectionTrack(project,project.timeline.tracks[1],[6000,10000]);assert.equal(rotation.settings.range,10);
});

test("Invalid selections fail before adding a track or changing main",()=>{
    const project=fixture(),before=JSON.stringify(project),track=project.timeline.tracks[0];
    for(const window of [[0,0],[-1,1000],[5000,20000],[6000,6001],[NaN,10000],[10000,6000]])assert.throws(()=>fitSelectionTrack(project,track,window));
    assert.equal(JSON.stringify(project),before);
});
