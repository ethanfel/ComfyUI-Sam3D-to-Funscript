// Use ComfyUI's executor, model ownership and queue for editor-triggered tracking.
export function errorMessage(error) {
    const data = error?.response || error;
    const details = Object.entries(data?.node_errors || {}).flatMap(([id, node]) =>
        (node.errors || []).map(e => `Node ${id}: ${[e.message, e.details].filter(Boolean).join(" · ")}`));
    return details.join("\n") || data?.exception_message || data?.error?.message ||
        data?.message || (typeof data === "string" ? data : "Tracking failed. Check the ComfyUI log.");
}

export async function queueReferenceTracking(api, prompt, nodeId, update, {pollMs = 2000, nodeType = "S3F_ReferenceStabilize", resultKey = "s3f_reference"} = {}) {
    nodeId = String(nodeId);
    if (prompt.output?.[nodeId]?.class_type !== nodeType) {
        throw new Error("The reference node is missing or disabled. Enable it in the connected workflow.");
    }
    let promptId, result, timer, settled = false, misses = 0, reconnecting = false, retryDelay = pollMs;
    const early = [], listeners = [];
    let resolve, reject;
    const completion = new Promise((a, b) => { resolve = a; reject = b; });
    const finish = (error, output) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        for (const [type, fn] of listeners) api.removeEventListener(type, fn);
        error ? reject(new Error(errorMessage(error))) : resolve(output);
    };
    const accept = (type, data) => {
        if (settled) return;
        if (!promptId) { early.push([type, data]); return; }
        if (data.prompt_id !== promptId) return;
        if (type === "execution_error") finish(data);
        else if (type === "execution_interrupted") finish("Tracking was cancelled in ComfyUI. Your settings are kept.");
        else if (type === "execution_start") update({state: "running", text: "Preparing reference tracking…"});
        else if (type === "progress" && String(data.node) === nodeId) {
            update({state: "running", text: `Tracking frames · ${data.value} / ${data.max}`, value: data.value, max: data.max});
        } else if (type === "executed" && String(data.node) === nodeId) {
            result = data.output;
            update({state: "running", text: "Loading tracking result…"});
        } else if (type === "execution_success" && result?.[resultKey]?.[0]) finish(null, result);
    };
    for (const type of ["execution_start", "progress", "executed", "execution_success", "execution_error", "execution_interrupted"]) {
        const fn = event => accept(type, event.detail);
        api.addEventListener(type, fn);
        listeners.push([type, fn]);
    }
    const read = async path => {
        const response = await api.fetchApi(path, {cache: "no-store", signal: AbortSignal.timeout(15000)});
        if (!response.ok) throw Object.assign(new Error(`Could not read tracking status (${response.status}). Check the ComfyUI connection.`), {status: response.status});
        return response.json();
    };
    // History also handles cached outputs, a missed websocket event and reconnection.
    const poll = async () => {
        try {
            const history = (await read(`/history/${encodeURIComponent(promptId)}`))[promptId];
            if (settled) return;
            if (history) {
                const failure = history.status?.messages?.find(([type]) => ["execution_error", "execution_interrupted"].includes(type));
                const output = history.outputs?.[nodeId];
                if (failure) finish(failure[0] === "execution_interrupted" ? "Tracking was cancelled in ComfyUI. Your settings are kept." : failure[1]);
                else if (output?.[resultKey]?.[0]) finish(null, output);
                else finish("Tracking finished without a reference result. Check the source input and selected points.");
                return;
            }
            const queue = await read("/queue");
            if (settled) return;
            const running = queue.queue_running.some(item => item[1] === promptId);
            const present = running || queue.queue_pending.some(item => item[1] === promptId);
            if (reconnecting && present) update({state: running ? "running" : "queued", text: running ? "ComfyUI is connected · existing job is still running" : "ComfyUI is connected · existing job is still queued"});
            reconnecting = false; retryDelay = pollMs;
            misses = present ? 0 : misses + 1;
            if (misses >= 2) { finish("The tracking job left the queue without a result. It may have been cancelled; your settings are kept."); return; }
            timer = setTimeout(poll, pollMs);
        } catch (error) {
            if (settled) return;
            if (error.status >= 500 || ['TypeError', 'TimeoutError', 'AbortError'].includes(error.name)) {
                misses = 0;
                if (!reconnecting) update({state: "reconnecting", text: "Connection delayed · waiting for ComfyUI to report this job’s status"});
                reconnecting = true;
                timer = setTimeout(poll, retryDelay);
                retryDelay = Math.min(15000, retryDelay * 2);
            } else finish(new Error(`${errorMessage(error)} Tracking may still be running; check ComfyUI before retrying.`));
        }
    };
    try {
        const queued = await api.queuePrompt(0, prompt, {partialExecutionTargets: [nodeId]});
        promptId = queued.prompt_id;
        if (!promptId) throw new Error("ComfyUI did not return a tracking job ID.");
        update({state: "queued", text: "Tracking queued in ComfyUI…", prompt_id: promptId});
        for (const [type, data] of early) accept(type, data);
        early.length = 0;
        if (!settled) timer = setTimeout(poll, pollMs);
    } catch (error) { finish(error); }
    return completion;
}
