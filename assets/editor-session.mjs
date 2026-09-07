// Server-backed drafts: one revision stream shared by the embedded and full editor.
// A stale editor cannot overwrite a newer draft or a completed rerun.
export function editorSession({install, snapshot, status}) {
    const params = new URLSearchParams(location.search), session = params.get('session');
    if (!session || document.getElementById('s3f-project')) return null;
    const endpoint = `../editors/${encodeURIComponent(session)}`;
    let revision = 0, pending = false, timer, saving, failure, output = params.get('project');
    const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(`s3f-editor-${session}`) : null;
    async function read() {
        const response = await fetch(endpoint, {cache: 'no-store'});
        if (!response.ok) throw new Error(await response.text());
        return response.json();
    }
    async function flush() {
        clearTimeout(timer);
        if (saving) {await saving; return flush();}
        if (failure) throw failure;
        if (!pending) return;
        pending = false;
        const body = JSON.stringify({revision, project: snapshot()});
        saving = (async () => {
            const response = await fetch(endpoint, {method: 'POST', headers: {'Content-Type': 'application/json'}, body});
            if (!response.ok) throw new Error(await response.text());
            revision = (await response.json()).revision;
            channel?.postMessage({revision});
            status('Edits and locks saved locally · reruns preserve locked and edited tracks');
        })();
        try {await saving;} catch (error) {pending = true; failure = error; status(`Save failed: ${error.message} Download your project to keep this draft.`); throw error;}
        finally {saving = null;}
        if (pending) return flush();
    }
    async function refresh(id = output) {
        await flush();
        const state = await read();
        // Do not install over an edit made while the network read was in flight.
        if (pending || saving || failure) return;
        if (state && state.revision > revision) {
            revision = state.revision; output = state.output || id;
            install(state.project, true, output);
            status('Saved editor restored · locked and edited tracks preserved');
        }
    }
    channel && (channel.onmessage = () => {if (!pending && !saving && !failure) refresh().catch(error => status(error.message));});
    window.addEventListener('beforeunload', event => {if (pending || saving || failure) {event.preventDefault();event.returnValue = '';}});
    window.s3fFlush = flush;
    window.s3fUpdate = refresh;
    return {
        async load(fallback) {
            const state = await read();
            if (state) {revision = state.revision; output = state.output || output; install(state.project, false, output); status('Saved editor restored · locks survive reruns');}
            else {install(await fallback(), false, output); pending = true; await flush();}
        },
        changed() {pending = true; clearTimeout(timer); timer = setTimeout(() => flush().catch(() => {}), 300);},
        flush,
    };
}
