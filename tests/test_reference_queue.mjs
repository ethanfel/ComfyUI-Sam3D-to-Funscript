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

// Status requests may fail while the executor is still running. Retry only the
// reads, retain websocket listeners, and never submit the prompt a second time.
for (const outcome of ['history', 'websocket', 'cancelled', 'removed']) {
    const mock = new API(), updates = [];
    let submissions = 0, reads = 0, queueReads = 0;
    mock.queuePrompt = async () => { submissions++; return {prompt_id: 'mine'}; };
    mock.fetchApi = async path => {
        reads++;
        if (reads <= 2) throw new TypeError('Failed to fetch');
        if (reads === 3) return {ok: false, status: 503};
        if (path === '/queue') {
            queueReads++;
            if (outcome === 'websocket' || outcome === 'cancelled') {
                queueMicrotask(() => {
                    if (outcome === 'cancelled') mock.emit('execution_interrupted', {prompt_id: 'mine'});
                    else {
                        mock.emit('executed', {prompt_id: 'mine', node: '2', output});
                        mock.emit('execution_success', {prompt_id: 'mine'});
                    }
                });
            }
            return {ok: true, json: async () => ({queue_running: outcome === 'removed' ? [] : [[0, 'mine']], queue_pending: []})};
        }
        return {ok: true, json: async () => outcome === 'history' && queueReads ? {mine: {outputs: {2: output}}} : {}};
    };
    const job = queueReferenceTracking(mock, prompt, 2, data => updates.push(data), {pollMs: 1});
    if (outcome === 'cancelled' || outcome === 'removed') await assert.rejects(job, /cancelled/);
    else assert.deepEqual(await job, output);
    assert.equal(submissions, 1);
    assert.equal(mock.events, 0);
    assert.equal(updates.filter(data => data.state === 'reconnecting').length, 1, 'show one connection notice per outage');
}
console.log('Reference queue: temporary outages retain jobs, recover via history or websocket, and still report cancellation/removal');

const interruptedReads = new API();
let checks = 0;
interruptedReads.queuePrompt = async () => ({prompt_id: 'mine'});
interruptedReads.fetchApi = async path => {
    if (path === '/queue') return {ok: true, json: async () => ({queue_running: [], queue_pending: []})};
    checks++;
    if (checks === 2) throw new DOMException('Timed out', 'TimeoutError');
    return {ok: true, json: async () => checks === 4 ? {mine: {outputs: {2: output}}} : {}};
};
assert.deepEqual(await queueReferenceTracking(interruptedReads, prompt, 2, () => {}, {pollMs: 1}), output,
    'failed reads break the consecutive checks required to declare a job missing');
assert.equal(interruptedReads.events, 0);

const denied = new API();
denied.queuePrompt = async () => ({prompt_id: 'mine'});
denied.fetchApi = async () => ({ok: false, status: 403});
await assert.rejects(queueReferenceTracking(denied, prompt, 2, () => {}, {pollMs: 1}), /403/);
assert.equal(denied.events, 0, 'permanent status failures do not retry indefinitely');

const inflight = new API(), lateUpdates = [];
let failRead, startedRead;
const readStarted = new Promise(resolve => { startedRead = resolve; });
inflight.queuePrompt = async () => ({prompt_id: 'mine'});
inflight.fetchApi = () => new Promise((resolve, reject) => { failRead = reject; startedRead(); });
const completed = queueReferenceTracking(inflight, prompt, 2, data => lateUpdates.push(data), {pollMs: 1});
await readStarted;
inflight.emit('executed', {prompt_id: 'mine', node: '2', output});
inflight.emit('execution_success', {prompt_id: 'mine'});
assert.deepEqual(await completed, output);
failRead(new TypeError('Failed to fetch'));
await new Promise(resolve => setTimeout(resolve, 10));
assert.equal(lateUpdates.some(data => data.state === 'reconnecting'), false, 'late failed polls cannot revive completed jobs');
assert.equal(inflight.events, 0);
console.log('Reference queue: interrupted missing-job checks, permanent errors and completion during a failed poll passed');
