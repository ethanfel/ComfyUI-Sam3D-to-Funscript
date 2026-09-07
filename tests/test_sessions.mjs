import assert from 'node:assert/strict';
import {test} from 'node:test';
import {editorOwner,sessionId,prepareNodeSessions} from '../web/sessions.mjs';
import {syncProjectInputs,orderEditorInputs,migrateProjectInputs} from '../web/projects.mjs';

test('Only explicit session links share an owner; disconnecting restores separate drafts and clones get independent sessions',()=>{
    const nodes=[1,2,3].map(id=>({id,type:id===1?'S3F_StandaloneExport':'S3F_PreviewExport',s3fEditorNode:true,properties:{s3f_session:'same-cloned-id'},inputs:[]}));
    const graph={links:{},getNodeById:id=>nodes.find(n=>n.id===id)};nodes.forEach(n=>n.graph=graph);
    prepareNodeSessions(nodes);assert.equal(new Set(nodes.map(sessionId)).size,3);
    const own=sessionId(nodes[1]);nodes[1].inputs=[{name:'editor_session',link:7}];graph.links[7]={origin_id:1};
    assert.equal(sessionId(nodes[1]),sessionId(nodes[0]));assert.equal(prepareNodeSessions(nodes).size,2);
    nodes[2].inputs=[{name:'editor_session',link:8}];graph.links[8]={origin_id:2};assert.equal(editorOwner(nodes[2]),nodes[0]);
    nodes[1].inputs[0].link=null;assert.equal(sessionId(nodes[1]),own);assert.equal(sessionId(nodes[2]),own);
    nodes[1].inputs[0].link=9;graph.links[9]={origin_id:3};assert.throws(()=>editorOwner(nodes[2]),/loop/);
});
test('Old node ports gain a session connection without shifting existing project or path ports',()=>{
    const node={type:'S3F_StandaloneExport',inputs:[{name:'project_0',link:1},{name:'project_1',link:null}],outputs:[{name:'project_path'},{name:'viewer_path'}],
        addInput(name,type){this.inputs.push({name,type,link:null});},addOutput(name,type){this.outputs.push({name,type});},removeInput(i){this.inputs.splice(i,1);}};
    syncProjectInputs(node);syncProjectInputs(node);
    assert.deepEqual(node.inputs.map(i=>i.name),['project_0','project_1','editor_session']);
    assert.deepEqual(node.outputs.map(o=>o.name),['project_path','viewer_path','editor_session']);
});

test('Session and numbered projects are grouped while converted widget and saved links follow their input',()=>{
    const node={id:9,type:'S3F_PreviewExport',inputs:[{name:'project_1',link:7},{name:'filename',link:8},{name:'editor_session',link:9},{name:'project_0',link:10}],
        graph:{links:{7:{target_slot:0},8:{target_slot:1},9:{target_slot:2},10:{target_slot:3}}}};
    orderEditorInputs(node);assert.deepEqual(node.inputs.map(i=>i.name),['editor_session','project_0','project_1','filename']);
    assert.deepEqual([9,10,7,8].map(id=>node.graph.links[id].target_slot),[0,1,2,3]);
    const saved={nodes:[{id:9,type:'S3F_PreviewExport',inputs:[{name:'project',link:3},{name:'editor_session',link:4},{name:'filename',link:5}]}],
        links:[[3,1,0,9,0,'S3F_MOTION_PROJECT'],[4,2,2,9,1,'S3F_EDITOR_SESSION'],[5,6,0,9,2,'STRING']]};
    migrateProjectInputs(saved);assert.deepEqual(saved.links.map(l=>l[4]),[1,0,2]);
    const again=JSON.stringify(saved);migrateProjectInputs(saved);assert.equal(JSON.stringify(saved),again);
});
