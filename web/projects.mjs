// Group session/project sockets while preserving connection destinations.
export const EDITOR_NODES = ["S3F_PreviewExport", "S3F_StandaloneExport"];

function inputOrder(input) {
    return input.name === "editor_session" ? -1 : /^project_\d+$/.test(input.name) ? Number(input.name.slice(8)) : Infinity;
}

export function orderEditorInputs(node) {
    if (!EDITOR_NODES.includes(node.type)) return;
    const inputs = [...node.inputs].sort((a,b) => inputOrder(a)-inputOrder(b));
    if (inputs.every((input,i) => input === node.inputs[i])) return;
    node.inputs.splice(0,node.inputs.length,...inputs);
    for (const [slot,input] of node.inputs.entries()) {
        const link = node.graph?.links?.get?.(input.link) ?? node.graph?.links?.[input.link];
        if (link) link.target_slot = slot;
    }
    node.setDirtyCanvas?.(true,true);
}

export function syncProjectInputs(node) {
    if (node.s3fSyncingProjects) return;
    node.s3fSyncingProjects = true;
    try {
        if (EDITOR_NODES.includes(node.type)) {
            if (!node.inputs?.some(i => i.name === "editor_session")) node.addInput("editor_session", "S3F_EDITOR_SESSION");
            if (!node.outputs?.some(o => o.name === "editor_session")) node.addOutput("editor_session", "S3F_EDITOR_SESSION");
        }
        for (const input of node.inputs || []) if (input.name === "project") input.name = "project_0";
        const slots = () => (node.inputs || []).filter(input => /^project_\d+$/.test(input.name));
        if (!slots().length) node.addInput("project_0", "S3F_MOTION_PROJECT");
        let inputs = slots();
        while (inputs.length > 1 && inputs.at(-1).link == null && inputs.at(-2).link == null) {
            node.removeInput(node.inputs.indexOf(inputs.at(-1)));
            inputs = slots();
        }
        if (inputs.at(-1).link != null) {
            const next = Math.max(...inputs.map(input => Number(input.name.slice(8)))) + 1;
            node.addInput(`project_${next}`, "S3F_MOTION_PROJECT");
        }
        node.setDirtyCanvas?.(true, true);
    } finally { node.s3fSyncingProjects = false; }
}

export function migrateProjectInputs(graph) {
    for (const node of graph.nodes || []) if (EDITOR_NODES.includes(node.type)) {
        for (const input of node.inputs || []) if (input.name === "project") input.name = "project_0";
        node.inputs ??= [];
        if (!node.inputs.some(i=>i.name === "editor_session")) node.inputs.push({name:"editor_session",type:"S3F_EDITOR_SESSION",link:null});
        node.inputs.sort((a,b)=>inputOrder(a)-inputOrder(b));
        const links = new Map((graph.links || []).map(link=>[Array.isArray(link)?link[0]:link.id,link]));
        for(const [slot,input] of node.inputs.entries()) {
            const link=links.get(input.link);
            if(link){if(Array.isArray(link))link[4]=slot;else link.target_slot=slot;}
        }
    }
    for (const subgraph of graph.definitions?.subgraphs || []) migrateProjectInputs(subgraph);
}
