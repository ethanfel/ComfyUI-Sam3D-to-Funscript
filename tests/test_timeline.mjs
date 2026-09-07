import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";
import {evaluate} from "../assets/curve.mjs";
import {initializeTimeline, sourceChoices, sourceProject, newTrack, assignTrack, trackProject, editProject, mainPoseProject, timelineState, restoreTimeline, spliceActions, applyTrack, copyTrackToMain, trackCopyAxes, selectionTrack, selectionProblem, trackCoverage} from "../assets/timeline.mjs";
import {syncProjectInputs, migrateProjectInputs} from "../web/projects.mjs";

const main=[{at:0,pos:10},{at:127,pos:91},{at:522,pos:7},{at:1000,pos:62},{at:2000,pos:23}];
const source=[{at:0,pos:85},{at:285,pos:0},{at:731,pos:100},{at:970,pos:3},{at:2000,pos:85}];
test("Blended joins preserve outside motion and approximate the continuous crossfade",()=>{
    const before=JSON.stringify([main,source]),a=174,b=1358,width=219;
    const result=spliceActions(main,source,a,b,"blend",width);
    for(let t=0;t<=2000;t+=.5){
        const w=Math.max(0,Math.min(1,(t-a)/width,(b-t)/width));
        const expected=t<a||t>b?evaluate(main,t):evaluate(main,t)*(1-w)+evaluate(source,t)*w;
        assert.ok(Math.abs(evaluate(result,t)-expected)<=.76,`at ${t}`);
    }
    assert.ok(result.every((p,i)=>Number.isInteger(p.at)&&Number.isInteger(p.pos)&&p.pos>=0&&p.pos<=100&&(!i||p.at>result[i-1].at)));
    assert.equal(JSON.stringify([main,source]),before);
    for(const p of main.filter(p=>p.at<a||p.at>b))assert.deepEqual(result.find(v=>v.at===p.at),p);
});
test("Cut guards, short blends, video-edge replacement, gaps and invalid ranges",()=>{
    for(const method of ["blend","cut"]){
        const result=spliceActions(main,source,0,2000,method,100000);
        assert.ok(result.every(p=>p.pos>=0&&p.pos<=100));
        const short=spliceActions(main,source,700,701,method,200);
        assert.ok(short.every((p,i)=>!i||p.at>short[i-1].at));
    }
    const cut=spliceActions(main,source,300,900,"cut");
    for(let t=301;t<900;t++)assert.ok(Math.abs(evaluate(cut,t)-evaluate(source,t))<=.5);
    for(const t of [0,127,298,299,901,1000,2000])assert.ok(Math.abs(evaluate(cut,t)-evaluate(main,t))<=.5);
    const gap=[{at:0,pos:30},{at:599,pos:30},{at:600,pos:85},{at:1000,pos:85}];
    const blend=spliceActions(main,gap,100,1000,"blend",50);
    assert.equal(evaluate(blend,599),30);assert.equal(evaluate(blend,600),85);
    for(const [a,b,w] of [[5,5,200],[-1,5,200],[0,5,-2],[0,NaN,200]])assert.throws(()=>spliceActions(main,source,a,b,"blend",w));
});

function fixture(){
    return {schema:"sam3d-funscript/1",metadata:{duration_ms:2000,source:{path:"fixture.mp4"}},times_ms:[0,1000,2000],
        points:[],pixels:[],segments:[0,0,0],raw:[],processed:[],valid:[true,true,true],metrics:{},
        config:{target_anchor:"mouth",target_person:0,axis_settings:{L0:{range:.2,center:50,invert:false,component:0}}},
        scripts:{L0:{version:"1.0",inverted:false,range:100,actions:structuredClone(main)}}};
}
test("Time selection keeps its source while inspecting main and copies all matching axes",()=>{
    const project=fixture();
    for(const axis of ['L1','L2','R0','R1','R2']){
        project.scripts[axis]=structuredClone(project.scripts.L0);
        project.config.axis_settings[axis]={...project.config.axis_settings.L0};
    }
    initializeTimeline(project);assert.match(selectionProblem(project,selectionTrack(project)),/Choose a source/);
    const track=project.timeline.tracks[0];track.script.actions=structuredClone(source);
    project.timeline.selection_track=track.id;project.timeline.selection=[300,900];
    project.timeline.active='main';
    assert.equal(selectionTrack(project),track);
    assert.equal(selectionProblem(project,track),'');
    const saved=structuredClone(timelineState(project)),scripts=structuredClone(project.scripts);
    const data=sourceProject(project,track.source);
    for(const [i,axis] of ['L1','L2','R0','R1','R2'].entries()) data.scripts[axis].actions=source.map(a=>({...a,pos:Math.round(a.pos*(i+1)/6)}));
    const sourceBefore=JSON.stringify(data);
    const result=copyTrackToMain(project,selectionTrack(project),{start:300,end:900,blendMs:100});
    assert.deepEqual(result,{updated:['L0','L1','L2','R0','R1','R2'],locked:[]});
    for(const axis of result.updated){
        assert.deepEqual(project.scripts[axis].actions,spliceActions(scripts[axis].actions,(axis==='L0'?track.script:data.scripts[axis]).actions,300,900,'blend',100));
        assert.equal(project.timeline.main[axis].regions[0].axis,axis);
        assert.equal(project.timeline.main[axis].edited,true);
    }
    assert.equal(JSON.stringify(data),sourceBefore);
    const loaded=JSON.parse(JSON.stringify(project));initializeTimeline(loaded);
    assert.equal(selectionTrack(loaded).id,track.id);assert.equal(loaded.timeline.active,'main');
    project.timeline.selection_track=null;restoreTimeline(project,saved);assert.equal(selectionTrack(project).id,track.id);
    project.timeline.main.L0.locked=true;assert.equal(selectionProblem(project,track),'');
    assert.deepEqual(trackCopyAxes(project,track).locked,['L0']);
    project.timeline.main.L0.locked=false;track.locked=true;assert.equal(selectionProblem(project,track),'','Copying a locked source is read-only');
    project.timeline.selection=[300,300];assert.match(selectionProblem(project,track),/time range/);
    project.timeline.selection=[300,2001];assert.match(selectionProblem(project,track),/within this source/);
    project.timeline.tracks=[];assert.equal(selectionTrack(project),null);
});

test("All-axis replacement respects each lock, missing axes, authored rows and atomic failures",()=>{
    const project=fixture();
    for(const axis of ['L1','R0']){
        project.scripts[axis]=structuredClone(project.scripts.L0);
        project.config.axis_settings[axis]={...project.config.axis_settings.L0};
    }
    initializeTimeline(project);
    const track=project.timeline.tracks[0],data=sourceProject(project,track.source);
    track.axis='R0';track.script.actions=structuredClone(source);track.settings.center=62;
    data.scripts.L0.actions=source.map(a=>({...a,pos:100-a.pos}));
    delete data.scripts.L1; // This anchor has no L1; existing main L1 is retained.
    project.timeline.main.L0.locked=true;
    const before=structuredClone(project);
    assert.deepEqual(copyTrackToMain(project,track,{whole:true}),{updated:['R0'],locked:['L0']});
    assert.deepEqual(project.scripts.R0,track.script);
    for(const axis of ['L0','L1']){
        assert.deepEqual(project.scripts[axis],before.scripts[axis]);
        assert.deepEqual(project.timeline.main[axis],before.timeline.main[axis]);
    }
    assert.equal(project.timeline.main.R0.regions[0].settings.center,62);
    project.timeline.main.R0.locked=true;
    assert.match(selectionProblem(project,track),/locked/);
    assert.throws(()=>copyTrackToMain(project,track,{whole:true}),/locked/);
    project.timeline.main.L0.locked=false;project.timeline.main.R0.locked=false;
    track.script.actions=[{at:0,pos:101}];
    const invalidBefore=JSON.stringify(project);
    assert.throws(()=>copyTrackToMain(project,track,{start:300,end:900}),/position|pos|0|100/i);
    assert.equal(JSON.stringify(project),invalidBefore,'A later invalid axis cannot partially update main');
});
test("Selection includes the final frame's held duration with the same rounding as exported actions",()=>{
    for(const [last,duration,end] of [[16625,16656.25,16656],[1968.75,2000.75,2001],[1968.5,2000.5,2000]]){
        const project=fixture();project.times_ms=[0,1000,last];project.metadata.duration_ms=duration;
        project.scripts.L0.actions=[{at:0,pos:10},{at:end,pos:20}];
        initializeTimeline(project);const track=project.timeline.tracks[0];
        track.script.actions=[{at:0,pos:80},{at:1000,pos:90},{at:end,pos:90}];
        project.timeline.selection=[1500,end];
        assert.deepEqual(trackCoverage(project,track),[0,end]);
        assert.equal(selectionProblem(project,track),'');
        applyTrack(project,track,'L0',{start:1500,end,method:'cut'});
        assert.equal(project.scripts.L0.actions.at(-1).at,end);
        assert.equal(evaluate(project.scripts.L0.actions,end),90);
        assert.equal(project.timeline.main.L0.regions.at(-1).end,end);
        assert.deepEqual(trackCoverage(JSON.parse(JSON.stringify(project)),track),[0,end]);
        project.timeline.selection=[1500,end+1];
        assert.match(selectionProblem(project,track),/within this source/);
        assert.throws(()=>applyTrack(project,track,'L0',{start:1500,end:end+1}),/analysis/);
    }
});
test("A trimmed source includes its final frame but cannot copy unrelated video time",()=>{
    const project=fixture();project.times_ms=[500.25,1000.25,1500.25];project.metadata.duration_ms=1540.25;
    initializeTimeline(project);project.metadata={...project.metadata,duration_ms:2000};
    const track=project.timeline.tracks[0];
    assert.deepEqual(trackCoverage(project,track),[500,1540]);
    project.timeline.selection=[500,1540];assert.equal(selectionProblem(project,track),'');
    for(const selection of [[0,1540],[500,1541],[500,2000]]){
        project.timeline.selection=selection;assert.match(selectionProblem(project,track),/within this source/);
    }
});
test("Latest and saved sources are distinguishable after reruns, reverts and legacy reloads",()=>{
    const project=fixture();initializeTimeline(project);
    const saved=structuredClone(project.timeline.sources[0]);saved.id='project_0@abcdef1234567890';saved.input='project_0';saved.label+=' · updated';
    saved.data.config.target_anchor='left_wrist';project.timeline.sources.push(saved);
    let options=sourceChoices(project);
    assert.deepEqual(options.map(s=>s.current),[true,false],'Explicit latest survives reverting to an earlier version');
    assert.match(options[0].label,/mouth.*latest/);assert.match(options[1].label,/left wrist.*saved abcdef12/);
    delete project.timeline.latest;initializeTimeline(project);options=sourceChoices(project);
    assert.deepEqual(options.map(s=>s.current),[false,true],'Old saves infer the most recently appended input');
    const track=project.timeline.tracks[0];assignTrack(project,track,saved.id,'L0');
    assert.equal(track.name,'project_0 · left wrist · person 0');
    track.name='My finished section';track.custom_name=true;assignTrack(project,track,'project_0','L0');
    assert.equal(track.name,'My finished section');
    const reloaded=JSON.parse(JSON.stringify(project));initializeTimeline(reloaded);
    assert.deepEqual(sourceChoices(reloaded),options);
});
test("Source snapshots, calibration isolation, composed regions, reassignment, undo and JSON roundtrip",()=>{
    const project=fixture();initializeTimeline(project);
    const base=JSON.stringify(project.timeline.sources),track=project.timeline.tracks[0];
    track.script.actions=structuredClone(source);track.settings.center=65;
    const another=newTrack(project,track.source,"L0");
    assert.notEqual(another.script.actions[0].pos,track.script.actions[0].pos);
    assert.equal(another.settings.center,50);assert.equal(JSON.stringify(project.timeline.sources),base);
    const snapshot=structuredClone(timelineState(project)),oldMain=structuredClone(project.scripts);
    applyTrack(project,track,"L0",{start:200,end:1200,blendMs:150});
    applyTrack(project,another,"L0",{start:600,end:1000,method:"cut"});
    assert.deepEqual(project.timeline.main.L0.regions.map(r=>[r.start,r.end]),[[200,600],[600,1000],[1000,1200]]);
    assert.equal(mainPoseProject(project,"L0",500).data.config.axis_settings.L0.center,65);
    track.settings.center=12;
    assert.equal(mainPoseProject(project,"L0",500).data.config.axis_settings.L0.center,65,"Copied regions keep their calibration snapshot");
    const composed=JSON.stringify(project.scripts);
    assignTrack(project,track,another.source,"L0");
    assert.equal(track.settings.center,50);assert.equal(JSON.stringify(project.scripts),composed);
    const loaded=JSON.parse(JSON.stringify(project));initializeTimeline(loaded);
    assert.deepEqual(loaded,project);assert.equal(sourceProject(loaded,track.source).points,loaded.points);
    project.timeline.active=track.id;assert.equal(editProject(project,"L0").data,trackProject(project,track));
    assert.equal(editProject(project,"L0","main").data.scripts,project.scripts);
    project.scripts=oldMain;restoreTimeline(project,snapshot);assert.deepEqual(timelineState(project),snapshot);
    applyTrack(project,project.timeline.tracks[0],"L0",{whole:true});assert.deepEqual(project.scripts.L0.actions,source);
    assert.throws(()=>applyTrack(project,track,"L0",{start:0,end:2100}),/analysis/);
});

test("Dynamic sockets preserve connected IDs and converted widgets through disconnects and reloads",()=>{
    const node={inputs:[{name:"project",link:7},{name:"filename",link:8}],
        addInput(name,type){this.inputs.push({name,type,link:null});},removeInput(i){this.inputs.splice(i,1);}};
    syncProjectInputs(node);assert.deepEqual(node.inputs.map(i=>i.name),["project_0","filename","project_1"]);
    for(let n=1;n<150;n++){node.inputs.at(-1).link=n+10;syncProjectInputs(node);}
    assert.equal(node.inputs.at(-1).name,"project_150");assert.equal(node.inputs.at(-1).link,null);
    node.inputs[2].link=null;syncProjectInputs(node);
    assert.equal(node.inputs[3].name,"project_2");assert.equal(node.inputs[3].link,12);
    const old=JSON.stringify(node.inputs);syncProjectInputs(node);assert.equal(JSON.stringify(node.inputs),old);
    node.inputs.at(-2).link=null;syncProjectInputs(node);assert.equal(node.inputs.at(-1).name,"project_149");
    const graph={nodes:[{type:"S3F_PreviewExport",inputs:[{name:"project",link:9}]}],
        definitions:{subgraphs:[{nodes:[{type:"S3F_StandaloneExport",inputs:[{name:"project",link:12}]}]}]}};
    migrateProjectInputs(graph);
    assert.deepEqual(graph.nodes[0].inputs,[{name:"editor_session",type:"S3F_EDITOR_SESSION",link:null},{name:"project_0",link:9}]);
    assert.deepEqual(graph.definitions.subgraphs[0].nodes[0].inputs,[{name:"editor_session",type:"S3F_EDITOR_SESSION",link:null},{name:"project_0",link:12}]);
});

for(const file of process.argv.slice(2)){
    test(`Real track project ${file}`,()=>{
        const project=JSON.parse(readFileSync(file,"utf8"));initializeTimeline(project);
        const track=project.timeline.tracks.at(-1),source=sourceProject(project,track.source),end=source.times_ms.at(-1);
        applyTrack(project,track,"L0",{start:Math.ceil(source.times_ms[0])+250,end:Math.floor(end)-250,blendMs:200});
        validate(project.scripts.L0.actions);
        initializeTimeline(JSON.parse(JSON.stringify(project)));
    });
}
function validate(actions){assert.ok(actions.every((a,i)=>Number.isInteger(a.at)&&Number.isInteger(a.pos)&&a.pos>=0&&a.pos<=100&&(!i||a.at>actions[i-1].at)));}
