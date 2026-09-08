// Follow actual tool chains. Sharing only a loader does not merge editors.
export function toolKind(node) {
    if (node?.type === "S3F_ProcessingTimeline") return "timeline";
    if (node?.type === "S3F_ReferenceStabilize") return "reference";
    if (["S3F_StandaloneExport", "S3F_PreviewExport"].includes(node?.type)) return "motion";
    return null;
}
function links(graph) {return graph.links?.values ? [...graph.links.values()] : Object.values(graph.links || {});}
export function connectedTools(graph, start) {
    const nodes = graph._nodes || [], tools = nodes.filter(toolKind), adjacency = new Map(tools.map(node => [node, new Set()]));
    const downstream = new Map();
    for (const link of links(graph)) {
        if (!link || !["VIDEO", "S3F_POSE_SEQUENCE", "S3F_MOTION_PROJECT", "S3F_EDITOR_SESSION", "MHR_POSE_DATA", "IMAGE", "*"].includes(link.type)) continue;
        const from = graph.getNodeById(link.origin_id), to = graph.getNodeById(link.target_id);
        if (from && to) {if (!downstream.has(from)) downstream.set(from, []); downstream.get(from).push(to);}
    }
    for (const origin of tools) {
        const seen = new Set([origin]), queue = [...(downstream.get(origin) || [])];
        while (queue.length) {
            const node = queue.shift(); if (seen.has(node)) continue; seen.add(node);
            if (toolKind(node)) {adjacency.get(origin).add(node); adjacency.get(node).add(origin);}
            else queue.push(...(downstream.get(node) || []));
        }
    }
    const result = new Set(), queue = [start];
    while (queue.length) {const node = queue.shift(); if (result.has(node)) continue; result.add(node); queue.push(...(adjacency.get(node) || []));}
    return nodes.filter(node => result.has(node) && toolKind(node));
}
