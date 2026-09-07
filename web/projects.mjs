// Preserve socket names and connected slot indices; only trim unused tail sockets.
export function syncProjectInputs(node) {
    if (node.s3fSyncingProjects) return;
    node.s3fSyncingProjects = true;
    try {
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
    for (const node of graph.nodes || []) if (node.type === "S3F_PreviewExport") {
        for (const input of node.inputs || []) if (input.name === "project") input.name = "project_0";
    }
    for (const subgraph of graph.definitions?.subgraphs || []) migrateProjectInputs(subgraph);
}
