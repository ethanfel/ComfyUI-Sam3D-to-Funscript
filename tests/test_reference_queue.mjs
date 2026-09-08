import assert from "node:assert/strict";
import {errorMessage, queueReferenceTracking} from "../web/reference-queue.mjs";

const prompt = {output: {2: {class_type: "S3F_ReferenceStabilize"}, 3: {class_type: "S3F_VideoPose"}}, workflow: {nodes: []}};
const output = {s3f_reference: ["a".repeat(24)]};
class API extends EventTarget {
    requests = []; events = 0;
    emit(type, data) { this.dispatchEvent(new CustomEvent(type, {detail: data})); }
    addEventListener(...args) { this.events++; super.addEventListener(...args); }
    removeEventListener(...args) { this.events--; super.removeEventListener(...args); }
    async queuePrompt(number, graph, options) {
        this.requests.push({number, graph, options});
        this.emit("progress", {prompt_id: "unrelated", node: "2", value: 999, max: 1000});
        // A cache hit may arrive before the POST response.
        this.emit("progress", {prompt_id: "mine", node: "2", value: 16, max: 32});
        this.emit("executed", {prompt_id: "mine", node: "2", output});
        this.emit("execution_success", {prompt_id: "mine"});
        return {prompt_id: "mine"};
    }
}
const api = new API(), updates = [];
assert.deepEqual(await queueReferenceTracking(api, prompt, "2", data => updates.push(data)), output);
assert.deepEqual(api.requests[0].options.partialExecutionTargets, ["2"]);
assert.ok(updates.some(v => v.value === 16));
assert.ok(!updates.some(v => v.value === 999));
assert.equal(api.events, 0);

const validation = new API();
validation.queuePrompt = async () => { throw {response: {node_errors: {2: {errors: [{message: "Value not in list", details: "model_file: missing.pth"}]}}}}; };
await assert.rejects(queueReferenceTracking(validation, prompt, 2, () => {}), /Node 2: Value not in list.*missing.pth/);
assert.equal(validation.events, 0);
await assert.rejects(queueReferenceTracking(new API(), prompt, 3, () => {}), /missing or disabled/);
assert.equal(errorMessage({message: "Error from a different window"}), "Error from a different window");

for (const scenario of ["cached", "failed", "cancelled", "removed"]) {
    const mock = new API();
    mock.queuePrompt = async () => ({prompt_id: "mine"});
    mock.fetchApi = async path => ({ok: true, json: async () => {
        if (path === "/queue") return {queue_running: [], queue_pending: []};
        if (scenario === "removed") return {};
        return {mine: scenario === "cached" ? {outputs: {2: output}} : {status: {messages: [[
            scenario === "failed" ? "execution_error" : "execution_interrupted", {exception_message: "Checkpoint load failed"}
        ]]}}};
    }});
    const job = queueReferenceTracking(mock, prompt, 2, () => {}, {pollMs: 1});
    if (scenario === "cached") assert.deepEqual(await job, output);
    else await assert.rejects(job, scenario === "failed" ? /Checkpoint load failed/ : /cancelled/);
    assert.equal(mock.events, 0);
}
console.log("Reference queue: targeted execution, early events, progress isolation, cache recovery, errors and cancellation passed");
