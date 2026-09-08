import assert from "node:assert/strict";
import {connectedTools} from "../web/workspace-graph.mjs";
const node=(id,type)=>({id,type});
const loader=node(1,"LoadVideo"),reference=node(2,"S3F_ReferenceStabilize"),timeline=node(3,"S3F_ProcessingTimeline"),motion=node(4,"S3F_StandaloneExport"),preview=node(5,"S3F_PreviewExport"),separate=node(6,"S3F_ProcessingTimeline"),pose=node(7,"S3F_VideoPose"),anchor=node(8,"S3F_BuildMotion");
const graph={_nodes:[loader,reference,timeline,motion,preview,separate,pose,anchor],links:new Map(),getNodeById(id){return this._nodes.find(n=>n.id===id)}};
let id=0;const connect=(a,b,type)=>graph.links.set(++id,{origin_id:a.id,target_id:b.id,type});
connect(loader,reference,"VIDEO");connect(reference,timeline,"VIDEO");connect(timeline,motion,"S3F_MOTION_PROJECT");connect(motion,preview,"S3F_EDITOR_SESSION");connect(loader,separate,"VIDEO");
assert.deepEqual(connectedTools(graph,timeline).map(n=>n.id),[2,3,4,5]);
assert.deepEqual(connectedTools(graph,separate).map(n=>n.id),[6]);
graph.links.clear();connect(reference,pose,"VIDEO");connect(pose,anchor,"S3F_POSE_SEQUENCE");connect(anchor,motion,"S3F_MOTION_PROJECT");
assert.deepEqual(connectedTools(graph,motion).map(n=>n.id),[2,4]);
connect(anchor,pose,"S3F_POSE_SEQUENCE"); // Malformed cycles must not hang grouping.
assert.deepEqual(connectedTools(graph,reference).map(n=>n.id),[2,4]);
graph.links.clear();connect(reference,pose,"VIDEO");connect(pose,anchor,"IMAGE");connect(anchor,motion,"MHR_POSE_DATA");
assert.deepEqual(connectedTools(graph,motion).map(n=>n.id),[2,4]);
console.log("Workspace grouping: connected chains, shared editor views, loader-only separation and cycles passed");
