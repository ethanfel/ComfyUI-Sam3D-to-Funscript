import {EDITOR_NODES} from "./projects.mjs";

const randomSession = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, "0")).join("");
export function editorOwner(node) {
    const seen = new Set();
    while (node && !seen.has(node)) {
        seen.add(node);
        const input = node.inputs?.find(i => i.name === "editor_session"), graph = node.graph;
        const link = graph?.links?.get?.(input?.link) ?? graph?.links?.[input?.link];
        const upstream = link && graph.getNodeById(link.origin_id);
        if (!upstream || !EDITOR_NODES.includes(upstream.type)) return node;
        node = upstream;
    }
    throw new Error("Motion Studio session connections cannot form a loop.");
}

export function sessionId(node) {
    const owner = editorOwner(node);
    return owner.properties.s3f_session ||= randomSession();
}

export function prepareNodeSessions(nodes) {
    const owners = new Set(nodes.filter(n => n.s3fEditorNode).map(editorOwner)), used = new Set();
    for (const owner of owners) {
        if (used.has(sessionId(owner))) owner.properties.s3f_session = randomSession();
        used.add(sessionId(owner));
    }
    return used;
}
