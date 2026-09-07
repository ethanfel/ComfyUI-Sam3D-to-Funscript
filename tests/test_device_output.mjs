import assert from "node:assert/strict";
import {test} from "node:test";
import {createHash} from "node:crypto";
import {DEVICE_PROFILES,deviceSettings,buildDeviceOutput,deviceOutputFiles,scriptHash} from "../assets/device-output.mjs";

function fixture(actions=[{at:0,pos:20},{at:100,pos:80}], settings={}) {
    return {scripts:{L0:{version:"1.0",inverted:false,range:100,actions},R1:{actions:[{at:0,pos:30},{at:100,pos:70}]}},
        timeline:{main:{L0:{locked:true}},tracks:[{locked:true,script:{actions:structuredClone(actions)}}]},
        device_output:{...deviceSettings("custom"),zone_max_mm:100,speed_mm_s:400,...settings}};
}

test("Physical zone controls speed demands; faster limits keep more authored motion",()=>{
    const project=fixture(),before=JSON.stringify(project),output=buildDeviceOutput(project);
    assert.equal(output.before.peak_speed_mm_s,600);assert.equal(output.before.over_limit_segments,1);
    assert.equal(output.after.peak_speed_mm_s,400);assert.equal(output.after.over_limit_segments,0);
    assert.deepEqual(output.script.actions,[{at:0,pos:30},{at:100,pos:70}]);
    assert.equal(JSON.stringify(project),before,"Locked main and source scripts are never mutated");
    const fast=buildDeviceOutput(fixture(undefined,{speed_mm_s:800}));
    assert.deepEqual(fast.script,project.scripts.L0);assert.equal(fast.changed_points,0);
    const narrow=buildDeviceOutput(fixture(undefined,{zone_min_mm:25,zone_max_mm:75}));
    assert.equal(narrow.before.peak_speed_mm_s,300);assert.deepEqual(narrow.script,project.scripts.L0);
    assert.equal(narrow.mapping.applied_by,"player/device");assert.equal(narrow.mapping.zone_min_mm,25);
});

test("No implicit maximum speed and no fabricated hardware calibration",()=>{
    for(const template of DEVICE_PROFILES){
        const settings=deviceSettings(template.id);assert.equal(settings.speed_mm_s,null);
        const project=fixture(undefined,{...settings,zone_max_mm:settings.zone_max_mm??100});
        const output=buildDeviceOutput(project);assert.equal(output.script,null);assert.equal(output.limit.status,"unknown");
        assert.throws(()=>deviceOutputFiles(project,"test"),/speed limit/);
        if(template.speed.value){
            project.device_output.speed_mm_s=template.speed.value;
            assert.equal(buildDeviceOutput(project).limit.status,"assumed");
            project.device_output.speed_evidence="published";
            assert.equal(buildDeviceOutput(project).limit.status,"published");
            project.device_output.speed_mm_s--;
            assert.equal(buildDeviceOutput(project).limit.status,"assumed");
        }
    }
    const project=fixture();delete project.device_output;assert.equal(buildDeviceOutput(project),null);
});

test("Integer output obeys speed and position bounds, keeps times and does not animate holds",()=>{
    let seed=2391;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
    for(let trial=0;trial<180;trial++){
        let time=0,pos=50;
        const actions=Array.from({length:100},()=>{
            time+=1+Math.floor(random()*200);
            if(random()>.25)pos=Math.floor(random()*101);
            return {at:time,pos};
        });
        const speed=.05+random()*1000,zone=1+random()*125;
        const output=buildDeviceOutput(fixture(actions,{zone_max_mm:zone,speed_mm_s:speed}));
        assert.deepEqual(output.script.actions.map(a=>a.at),actions.map(a=>a.at));
        for(let i=0;i<actions.length;i++){
            const value=output.script.actions[i].pos;
            assert.ok(Number.isInteger(value)&&value>=0&&value<=100);
            if(i){
                const delta=Math.abs(value-output.script.actions[i-1].pos);
                assert.ok(delta*zone*10/(actions[i].at-actions[i-1].at)<=speed+1e-7);
                if(actions[i].pos===actions[i-1].pos)assert.equal(delta,0);
            }
        }
    }
});

test("Feasible slopes and pauses are unchanged; short cuts are conditioned after joins",()=>{
    const actions=[{at:0,pos:10},{at:1000,pos:90},{at:2000,pos:90},{at:3000,pos:10}];
    assert.deepEqual(buildDeviceOutput(fixture(actions)).script.actions,actions);
    const cut=[{at:0,pos:10},{at:999,pos:10},{at:1000,pos:90},{at:2000,pos:90}];
    const output=buildDeviceOutput(fixture(cut));
    assert.equal(output.before.over_limit_segments,1);assert.equal(output.after.over_limit_segments,0);
    assert.ok(output.script.actions.every(a=>a.pos===50),"One-ms jump cannot move an integer step at this limit; holds stay still");
    const tiny=buildDeviceOutput(fixture(actions,{speed_mm_s:.00001}));
    assert.equal(tiny.after.peak_speed_mm_s,0);
});

test("Invalid profiles, physical units and source actions cannot produce device files",()=>{
    for(const settings of [{version:2},{profile:"sr6"},{zone_min_mm:-1},{zone_max_mm:0},{zone_max_mm:NaN},
        {speed_mm_s:0},{speed_mm_s:-1},{speed_mm_s:Infinity},{...deviceSettings("handy2"),zone_max_mm:126,speed_mm_s:400},
        {...deviceSettings("handy2"),speed_mm_s:401}]){
        const p=fixture(undefined,settings);assert.throws(()=>buildDeviceOutput(p));assert.throws(()=>deviceOutputFiles(p,"test"));
    }
    for(const actions of [[],[{at:0,pos:20},{at:0,pos:80}],[{at:0,pos:101}],[{at:-1,pos:50}],[{at:0,pos:1.5}]])
        assert.throws(()=>buildDeviceOutput(fixture(actions)));
    const project=fixture();delete project.scripts.L0;assert.throws(()=>buildDeviceOutput(project),/main L0/);
});

test("Separate device export matches preview, records evidence and hashes actual source/output bytes",()=>{
    const project=fixture(),before=JSON.stringify(project),files=deviceOutputFiles(project,"fixture");
    assert.deepEqual(Object.keys(files).sort(),["README.txt","device-output.json","fixture.funscript"]);
    const script=JSON.parse(files["fixture.funscript"]),manifest=JSON.parse(files["device-output.json"]);
    assert.deepEqual(script,buildDeviceOutput(project).script);
    assert.equal(manifest.source_sha256,createHash("sha256").update(JSON.stringify(project.scripts.L0)).digest("hex"));
    assert.equal(manifest.output_sha256,createHash("sha256").update(files["fixture.funscript"]).digest("hex"));
    assert.deepEqual(manifest.profile.axes,["L0"]);assert.equal(manifest.limit.status,"assumed");
    assert.equal(JSON.stringify(project),before);assert.match(files["README.txt"],/apply the zone only once/);
    project.scripts.L0.actions[0].pos=10;
    const next=JSON.parse(deviceOutputFiles(project,"fixture")["device-output.json"]);
    assert.notEqual(next.source_sha256,manifest.source_sha256);assert.notEqual(next.output_sha256,manifest.output_sha256);
    const reopened=JSON.parse(JSON.stringify(project));assert.deepEqual(deviceOutputFiles(reopened,"fixture"),deviceOutputFiles(project,"fixture"));
});

test("Offline SHA-256 agrees with native hashing across padding boundaries and Unicode",()=>{
    for(const size of [0,1,53,54,55,56,62,63,64,65,1000,100000]){
        const script={notes:"é⏱"+"x".repeat(size)};
        assert.equal(scriptHash(script),createHash("sha256").update(JSON.stringify(script)).digest("hex"));
    }
});

test("Hour-long sampled curve stays bounded without materializing video or changing timestamps",()=>{
    const actions=Array.from({length:108001},(_,i)=>({at:Math.round(i*1000/30),pos:Math.round(50+45*Math.sin(i*.5))}));
    const output=buildDeviceOutput(fixture(actions,{zone_max_mm:125,speed_mm_s:250}));
    assert.equal(output.script.actions.length,actions.length);assert.equal(output.script.actions.at(-1).at,3600000);
    assert.equal(output.after.over_limit_segments,0);
});
