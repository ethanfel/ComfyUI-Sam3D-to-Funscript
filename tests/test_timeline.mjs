import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";
import {evaluate} from "../assets/curve.mjs";
import {initializeTimeline, sourceChoices, sourceProject, newTrack, assignTrack, trackProject, editProject, mainPoseProject, timelineState, restoreTimeline, spliceActions, applyTrack, selectionTrack, selectionProblem} from "../assets/timeline.mjs";
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
test("Time selection keeps its source while inspecting main and copies exactly one axis",()=>{
    const project=fixture();
    for(const axis of ['L1','L2','R0','R1','R2']){
        project.scripts[axis]=structuredClone(project.scripts.L0);
        project.config.axis_settings[axis]={...project.config.axis_settings.L0};
    }
    initializeTimeline(project);assert.match(selectionProblem(project,selectionTrack(project),'L0'),/Choose a source/);
    const track=project.timeline.tracks[0];track.script.actions=structuredClone(source);
    project.timeline.selection_track=track.id;project.timeline.selection=[300,900];
    project.timeline.active='main';
    assert.equal(selectionTrack(project),track);
    assert.equal(selectionProblem(project,track,'L0'),'');
    const saved=structuredClone(timelineState(project)),scripts=structuredClone(project.scripts);
    applyTrack(project,selectionTrack(project),'L0',{start:300,end:900,blendMs:100});
    assert.notDeepEqual(project.scripts.L0,scripts.L0);
    for(const axis of ['L1','L2','R0','R1','R2'])assert.deepEqual(project.scripts[axis],scripts[axis]);
    const loaded=JSON.parse(JSON.stringify(project));initializeTimeline(loaded);
    assert.equal(selectionTrack(loaded).id,track.id);assert.equal(loaded.timeline.active,'main');
    project.timeline.selection_track=null;restoreTimeline(project,saved);assert.equal(selectionTrack(project).id,track.id);
    project.timeline.main.L0.locked=true;assert.match(selectionProblem(project,track,'L0'),/Main L0 is locked/);
    project.timeline.main.L0.locked=false;track.locked=true;assert.equal(selectionProblem(project,track,'L0'),'','Copying a locked source is read-only');
    project.timeline.selection=[300,300];assert.match(selectionProblem(project,track,'L0'),/time range/);
    project.timeline.selection=[300,2001];assert.match(selectionProblem(project,track,'L0'),/within this source/);
    project.timeline.tracks=[];assert.equal(selectionTrack(project),null);
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
    const graph={nodes:[{type:"S3F_PreviewExport",inputs:[{name:"project",link:9}]}]};migrateProjectInputs(graph);
    assert.deepEqual(graph.nodes[0].inputs,[{name:"project_0",link:9}]);
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
