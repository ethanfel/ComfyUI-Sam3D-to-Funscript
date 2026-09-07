// Keep the original path-based canvas examples usable after adding the VIDEO socket.
export function migrateVideoInputs(graph) {
    if (!Array.isArray(graph.nodes) || !Array.isArray(graph.links)) return;
    let nodeId = Math.max(graph.last_node_id || 0, ...graph.nodes.map(n => Number(n.id) || 0));
    let linkId = Math.max(graph.last_link_id || 0, ...graph.links.map(l => Number(l[0]) || 0));
    const left = Math.min(0, ...graph.nodes.map(n => n.pos?.[0] || 0)) - 430;
    let migrated = 0;
    for (const node of [...graph.nodes]) {
        const values = node.widgets_values;
        if (node.type !== "S3F_VideoPose" || !Array.isArray(values) || values.length !== 10 ||
            typeof values[0] !== "string" || typeof values[1] !== "string" ||
            node.inputs?.some(input => input.name === "video")) continue;
        const pathSlot = node.inputs?.findIndex(input => input.name === "video_path") ?? -1;
        const pathInput = pathSlot >= 0 ? node.inputs[pathSlot] : null;
        const file = values.shift();
        const loaderId = ++nodeId, videoLink = ++linkId;
        const loader = {
            id: loaderId, type: "LoadVideo", pos: [left, (node.pos?.[1] || 0) + migrated * 620], size: [340, 550],
            flags: {}, order: 0, mode: 0, inputs: [],
            outputs: [{name: "VIDEO", type: "VIDEO", links: [videoLink], slot_index: 0}],
            properties: {"Node name for S&R": "LoadVideo"}, widgets_values: [file], title: "Load video · core",
        };
        // Preserve converted path-widget links as the loader's file input.
        if (pathInput) {
            loader.inputs.push({...pathInput, name: "file", type: "COMBO", widget: {name: "file"}});
            node.inputs.splice(pathSlot, 1);
        }
        for (const link of graph.links) {
            if (link[3] !== node.id) continue;
            if (pathInput && link[4] === pathSlot) {
                link[3] = loaderId; link[4] = 0;
            } else {
                link[4] += 1 - (pathSlot >= 0 && link[4] > pathSlot ? 1 : 0);
            }
        }
        node.inputs = [{name: "video", type: "VIDEO", link: videoLink}, ...(node.inputs || [])];
        graph.nodes.push(loader);
        graph.links.push([videoLink, loaderId, 0, node.id, 0, "VIDEO"]);
        migrated++;
    }
    if (migrated) {
        graph.last_node_id = nodeId;
        graph.last_link_id = linkId;
    }
}
