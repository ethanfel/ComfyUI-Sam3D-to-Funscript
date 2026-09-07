import assert from 'node:assert/strict';
import {test} from 'node:test';
import {editorOwner,sessionId,prepareNodeSessions} from '../web/sessions.mjs';
import {syncProjectInputs} from '../web/projects.mjs';

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
