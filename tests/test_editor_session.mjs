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

const {editorSession, editorContent} = await import('../assets/editor-session.mjs');
const fixture=()=>({schema:'sam3d-funscript/1',metadata:{source:{path:'neutral.mp4',size:100,mtime_ns:1000}},times_ms:[0,1000],
    config:{axis_settings:{L0:{center:50}}},scripts:{L0:{actions:[{at:0,pos:20},{at:1000,pos:80}]}},preview:{wide_layout:true},
    timeline:{version:1,sources:[{id:'source',data:{scripts:{L0:{actions:[{at:0,pos:20},{at:1000,pos:80}]}}}}],geometries:{},
        tracks:[{id:'track_0',source:'source',axis:'L0',locked:false,script:{actions:[{at:0,pos:20},{at:1000,pos:80}]}}],
        main:{L0:{source:'source',locked:false,regions:[]}},active:'main',selection:[0,0]}});

function harness(t) {
    const original=new Map(['location','document','window','BroadcastChannel','fetch','setTimeout','clearTimeout'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
    const channels=[],state={revision:1,output:'fixture',project:fixture()};
    let beforeRead, beforePost, posts=0, downloads=[], nextTimer=0;const timers=new Map();
    globalThis.location={search:'?session='+ 'a'.repeat(32)};
    globalThis.document={getElementById:()=>null};
    globalThis.window={addEventListener:()=>{}};
    globalThis.setTimeout=(callback,ms)=>{const id=++nextTimer;timers.set(id,{callback,ms});return id;};
    globalThis.clearTimeout=id=>timers.delete(id);
    globalThis.BroadcastChannel=class {constructor(){channels.push(this)}postMessage(data){this.messages??=[];this.messages.push(data);}};
    globalThis.fetch=async (url,options)=>{
        if(options.method==='POST'){
            posts++;const body=JSON.parse(options.body);await beforePost?.(body);
            if(body.revision!==state.revision)return new Response('Another editor changed this project.',{status:409});
            state.revision++;state.project=body.project;return Response.json({revision:state.revision});
        }
        await beforeRead?.();return Response.json(structuredClone(state));
    };
    t.after(()=>{for(const [key,descriptor]of original)if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];});
    function editor(){
        let project=null;const messages=[],recoveries=[];
        const session=editorSession({install:data=>{project=data},snapshot:()=>project,status:message=>messages.push(message),recovery:value=>recoveries.push(value),
            downloadDraft:json=>{downloads.push(JSON.parse(json))}});
        return {session,channel:channels.at(-1),messages,recoveries,get project(){return project}};
    }
    return {state,editor,downloads,timers,async retry(){const [id,timer]=timers.entries().next().value;timers.delete(id);await timer.callback();},get posts(){return posts},set beforeRead(fn){beforeRead=fn},set beforePost(fn){beforePost=fn}};
}

const changeCurve=(editor,value)=>{editor.project.scripts.L0.actions[0].pos=value;editor.session.changed()};

test('View-only conflicts adopt newer curves and retain the local selection',async t=>{
    const h=harness(t),a=h.editor(),b=h.editor();await a.session.load();await b.session.load();
    changeCurve(a,42);await a.session.flush();
    b.project.timeline.active='track_0';b.project.timeline.selection=[100,800];b.project.preview.wide_layout=false;b.session.changed();
    await b.session.flush();
    assert.equal(b.project.scripts.L0.actions[0].pos,42);assert.equal(h.state.project.scripts.L0.actions[0].pos,42);
    assert.deepEqual(b.project.timeline.selection,[100,800]);assert.equal(b.project.preview.wide_layout,false);
    assert.equal(b.recoveries.at(-1),null);
});

test('An authored edit retries over a simultaneous layout-only save',async t=>{
    const h=harness(t),a=h.editor(),b=h.editor();await a.session.load();await b.session.load();
    a.project.timeline.tracks[0].collapsed=true;a.session.changed();changeCurve(b,37);
    await Promise.all([a.session.flush(),b.session.flush()]);
    assert.equal(h.state.project.scripts.L0.actions[0].pos,37);assert.equal(b.recoveries.at(-1),null);
});

test('Competing curve edits keep both versions intact until explicit recovery',async t=>{
    const h=harness(t),a=h.editor(),b=h.editor();await a.session.load();await b.session.load();
    changeCurve(a,42);changeCurve(b,37);await a.session.flush();
    await assert.rejects(b.session.flush(),/Another editor/);
    assert.equal(h.state.project.scripts.L0.actions[0].pos,42);assert.equal(b.project.scripts.L0.actions[0].pos,37);
    assert.ok(b.recoveries.at(-1));
    // The failed tab explicitly backs up its complete draft before loading.
    await b.session.recover();
    assert.equal(h.downloads[0].scripts.L0.actions[0].pos,37);assert.equal(b.project.scripts.L0.actions[0].pos,42);
    assert.equal(h.state.project.scripts.L0.actions[0].pos,42);assert.equal(b.recoveries.at(-1),null);
    changeCurve(b,60);await b.session.flush();assert.equal(h.state.project.scripts.L0.actions[0].pos,60);
});

test('A temporary connection failure can be retried without reloading or losing edits',async t=>{
    const h=harness(t),a=h.editor();await a.session.load();changeCurve(a,35);
    h.beforePost=()=>{throw Error('Connection interrupted')};await assert.rejects(a.session.flush(),/Connection/);
    h.beforePost=null;await a.session.flush();assert.equal(h.state.project.scripts.L0.actions[0].pos,35);assert.equal(a.recoveries.at(-1),null);
});

test('A lost acknowledgement recognizes the already-saved draft',async t=>{
    const h=harness(t),a=h.editor();await a.session.load();changeCurve(a,35);
    h.beforePost=body=>{h.state.project=body.project;h.state.revision++;h.beforePost=null;throw Error('Connection interrupted')};
    await assert.rejects(a.session.flush(),/Connection/);await a.session.flush();
    assert.equal(h.state.project.scripts.L0.actions[0].pos,35);assert.equal(a.recoveries.at(-1),null);
});

test('Edits made while conflict recovery reads the server are never discarded',async t=>{
    const h=harness(t),a=h.editor();await a.session.load();a.project.preview.wide_layout=false;a.session.changed();
    h.state.project.scripts.L0.actions[0].pos=42;h.state.revision++;
    h.beforeRead=()=>{changeCurve(a,37);h.beforeRead=null};
    await assert.rejects(a.session.flush(),/Another editor/);
    assert.equal(a.project.scripts.L0.actions[0].pos,37);assert.equal(h.state.project.scripts.L0.actions[0].pos,42);
});

test('Source switches load automatically only when the local draft has no authored edits',async t=>{
    const h=harness(t),a=h.editor(),b=h.editor();await a.session.load();await b.session.load();
    a.project.preview.wide_layout=false;a.session.changed();changeCurve(b,37);
    h.state.project.metadata.source.path='other.mp4';h.state.revision++;
    await a.session.flush();assert.equal(a.project.metadata.source.path,'other.mp4');
    await assert.rejects(b.session.flush(),/Another editor/);
    assert.equal(b.project.metadata.source.path,'neutral.mp4');assert.equal(h.state.project.scripts.L0.actions[0].pos,20);
});

test('Locks, source geometry, anchor calibration and changed inference remain protected',async t=>{
    const h=harness(t),a=h.editor();await a.session.load();changeCurve(a,37);
    h.state.project.timeline.main.L0.locked=true;h.state.revision++;
    await assert.rejects(a.session.flush(),/Another editor/);assert.equal(h.state.project.timeline.main.L0.locked,true);
    const base=fixture(),content=editorContent(base);
    for(const edit of [p=>p.times_ms.push(2000),p=>p.config.axis_settings.L0.center=30,p=>p.timeline.tracks[0].locked=true,p=>p.timeline.sources[0].data.scripts.L0.actions[0].pos=99]){
        const copy=structuredClone(base);edit(copy);assert.notEqual(editorContent(copy),content);
    }
});

test('Rerun preparation recovers a harmless stale view instead of blocking the workflow',async t=>{
    const h=harness(t),a=h.editor();await a.session.load();a.project.timeline.active='track_0';a.session.changed();
    h.state.project.scripts.L0.actions[0].pos=42;h.state.revision++;
    a.channel.onmessage({data:{type:'prepare-run',request:'run-1'}});
    for(let i=0;i<100&&!a.channel.messages.some(m=>m.type==='prepared');i++)await new Promise(resolve=>setImmediate(resolve));
    const prepared=a.channel.messages.find(m=>m.type==='prepared');assert.ok(prepared);assert.equal(prepared.error,undefined);
    assert.equal(a.project.scripts.L0.actions[0].pos,42);
});

test('Recovery includes edits made during the read and does not replace a draft on read failure',async t=>{
    const h=harness(t),a=h.editor();await a.session.load();changeCurve(a,35);
    h.beforeRead=()=>{throw Error('Disconnected')};await assert.rejects(a.session.recover(),/Disconnected/);
    assert.equal(a.project.scripts.L0.actions[0].pos,35);assert.equal(h.downloads.length,0);
    h.beforeRead=()=>{changeCurve(a,44);h.beforeRead=null};await a.session.recover();
    assert.equal(h.downloads[0].scripts.L0.actions[0].pos,44);assert.equal(a.project.scripts.L0.actions[0].pos,20);
});

test('A server restart retries pending edits automatically and clears recovery after reconnect',async t=>{
    const h=harness(t),a=h.editor();await a.session.load();changeCurve(a,35);
    h.beforePost=()=>{throw new TypeError('Failed to fetch')};
    await assert.rejects(a.session.flush(),/Failed to fetch/);
    assert.equal(h.timers.size,1);assert.match(a.messages.at(-1),/retrying/);
    // The restored server has a newer export revision but the same curves.
    h.beforePost=null;h.state.revision++;
    await h.retry();assert.equal(h.state.project.scripts.L0.actions[0].pos,35);
    assert.equal(a.recoveries.at(-1),null);assert.equal(h.timers.size,0);
});

test('Reconnection tolerates reordered JSON and automatic marker updates while preserving authored changes',async t=>{
    const h=harness(t),a=h.editor();await a.session.load();changeCurve(a,35);
    h.state.project=Object.fromEntries(Object.entries(h.state.project).reverse());
    h.state.project.metadata.scene_cuts={times_ms:[250,500]};h.state.revision++;
    await a.session.flush();
    assert.equal(h.state.project.scripts.L0.actions[0].pos,35);
    assert.deepEqual(h.state.project.metadata.scene_cuts.times_ms,[250,500]);
});

test('An older tab with only refreshed marker data loads the new saved curves',async t=>{
    const h=harness(t),a=h.editor();await a.session.load();
    a.project.metadata.scene_cuts={times_ms:[500]};
    a.project.timeline.tracks[0].metrics={actions:2};a.session.changed();
    h.state.project.scripts.L0.actions[0].pos=42;h.state.revision++;
    await a.session.flush();assert.equal(a.project.scripts.L0.actions[0].pos,42);
});

test('The backend region identity migration does not strand a retained tab',async t=>{
    const h=harness(t);
    Object.assign(h.state.project.timeline.sources[0].data,{metadata:{processing_region:{id:'region-1'}},config:{target_anchor:'pelvis'}});
    h.state.project.timeline.latest={project_0:'source'};
    const a=h.editor();await a.session.load();changeCurve(a,35);
    h.state.project.timeline.sources[0].input='region:region-1:pelvis';
    h.state.project.timeline.latest={'region:region-1:pelvis':'source'};h.state.revision++;
    await a.session.flush();assert.equal(h.state.project.scripts.L0.actions[0].pos,35);
});

test('Real curve conflicts never schedule an automatic overwrite',async t=>{
    const h=harness(t),a=h.editor();await a.session.load();changeCurve(a,35);
    h.state.project.scripts.L0.actions[0].pos=42;h.state.revision++;
    await assert.rejects(a.session.flush(),/Another editor/);assert.equal(h.timers.size,0);
});

test('Edits made after a lost save acknowledgement resume on top of that saved draft',async t=>{
    const h=harness(t),a=h.editor();await a.session.load();changeCurve(a,35);
    h.beforePost=body=>{h.state.project=body.project;h.state.revision++;h.beforePost=null;throw new TypeError('Failed to fetch')};
    await assert.rejects(a.session.flush(),/Failed to fetch/);
    changeCurve(a,36);await h.retry();
    assert.equal(h.state.project.scripts.L0.actions[0].pos,36);assert.equal(a.recoveries.at(-1),null);
});
