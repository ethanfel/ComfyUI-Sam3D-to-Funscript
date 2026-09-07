import assert from "node:assert/strict";
import {migrateVideoInputs, migrateAnchorOverrides} from "../web/migrate.mjs";

const settings = ["model.safetensors", 16, 2, 4, 2000, "[[0,0,1,1]]", 8, 0, true];
const original = {
    last_node_id: 1, last_link_id: 0,
    nodes: [
        {id: 1, type: "S3F_VideoPose", pos: [80, 140], inputs: [], outputs: [{links: [4]}],
            widgets_values: ["videos/source.mp4", ...settings]},
        {id: 7, type: "S3F_BuildMotion", pos: [550, 140], inputs: [{link: 4}]},
    ],
    links: [[4, 1, 0, 7, 0, "S3F_POSE_SEQUENCE"]],
};
const graph = structuredClone(original);
migrateVideoInputs(graph);
assert.deepEqual(graph.nodes[0].widgets_values, settings);
assert.deepEqual(graph.nodes[0].outputs, original.nodes[0].outputs);
assert.deepEqual(graph.nodes[0].pos, original.nodes[0].pos);
assert.deepEqual(graph.nodes[1], original.nodes[1]);
assert.equal(graph.nodes[2].type, "LoadVideo");
assert.deepEqual(graph.nodes[2].widgets_values, ["videos/source.mp4"]);
assert.deepEqual(graph.links, [...original.links, [5, 8, 0, 1, 0, "VIDEO"]]);
const migrated = structuredClone(graph);
migrateVideoInputs(graph);
assert.deepEqual(graph, migrated);

const converted = structuredClone(original);
converted.nodes[0].inputs = [
    {name: "model_file", type: "COMBO", link: 8, widget: {name: "model_file"}},
    {name: "video_path", type: "STRING", link: 9, widget: {name: "video_path"}},
    {name: "sample_fps", type: "FLOAT", link: 10, widget: {name: "sample_fps"}},
];
converted.links.push([8, 20, 0, 1, 0, "COMBO"], [9, 21, 0, 1, 1, "STRING"], [10, 22, 0, 1, 2, "FLOAT"]);
converted.last_node_id = 22;
migrateVideoInputs(converted);
assert.deepEqual(converted.nodes[0].inputs.map(i => i.name), ["video", "model_file", "sample_fps"]);
assert.deepEqual(converted.links.slice(1), [
    [8, 20, 0, 1, 1, "COMBO"], [9, 21, 0, 23, 0, "STRING"], [10, 22, 0, 1, 2, "FLOAT"],
    [11, 23, 0, 1, 0, "VIDEO"],
]);
assert.deepEqual(converted.nodes[2].inputs[0].widget, {name: "file"});
console.log("Workflow migration preserves settings, connections and existing nodes; repeated loads are unchanged.");

const general = ["pelvis", "chest", "nose", "left_wrist", "right_wrist", "left_hand", "right_hand", "neck", "mouth"];
const detailed = ["left_index_tip", "right_pinky_tip", "nose", "neck"];
const anchors = {
    last_node_id: 2, last_link_id: 4,
    nodes: [{id: 7, type: "S3F_BuildMotion", pos: [500, 100],
        inputs: [{name: "poses", type: "S3F_POSE_SEQUENCE", link: 4}],
        outputs: [{links: [5]}], widgets_values: [0, "left_index_tip", 1, "right_pinky_tip", "reference_body", 80, "L0", "{}"]}],
    links: [[4, 1, 0, 7, 0, "S3F_POSE_SEQUENCE"], [5, 7, 0, 2, 0, "S3F_MOTION_PROJECT"]],
};
const previousLinks = structuredClone(anchors.links);
migrateAnchorOverrides(anchors, general, detailed);
assert.deepEqual(anchors.nodes[0].widgets_values, [0, "pelvis", 1, "pelvis", "reference_body", 80, "L0", "{}"]);
assert.deepEqual(anchors.nodes.slice(1).map(n => n.widgets_values), [["left_index_tip"], ["right_pinky_tip"]]);
assert.deepEqual(anchors.links, [...previousLinks, [6, 8, 0, 7, 1, "S3F_ANCHOR"], [7, 9, 0, 7, 2, "S3F_ANCHOR"]]);
assert.deepEqual(anchors.nodes[0].outputs, [{links: [5]}]);
assert.deepEqual(anchors.nodes[0].pos, [500, 100]);
const savedAnchors = structuredClone(anchors);
migrateAnchorOverrides(anchors, general, detailed);
assert.deepEqual(anchors, savedAnchors);

const alreadyConnected = structuredClone(savedAnchors);
alreadyConnected.nodes[0].widgets_values[1] = "right_pinky_tip";
migrateAnchorOverrides(alreadyConnected, general, detailed);
assert.deepEqual(alreadyConnected, savedAnchors);

const dynamic = structuredClone(savedAnchors);
dynamic.nodes[0].widgets_values[1] = "left_index_tip";
dynamic.nodes[0].inputs.push({name: "target_anchor", type: "COMBO", widget: {name: "target_anchor"}, link: 10});
dynamic.links.push([10, 20, 0, 7, 3, "COMBO"]);
const savedDynamic = structuredClone(dynamic);
migrateAnchorOverrides(dynamic, general, detailed);
assert.deepEqual(dynamic, savedDynamic);
console.log("Detailed anchor migration preserves both selections, existing overrides, dynamic links and repeated loads.");
