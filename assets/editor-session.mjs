// Server-backed drafts: one revision stream shared by the embedded and full editor.
// A stale editor cannot overwrite a newer draft or a completed rerun.
export function sameVideoSource(previous, incoming) {
    if (typeof previous?.path !== 'string' || previous.path !== incoming?.path) return false;
    return ['size', 'mtime_ns'].every(key => !(key in previous && key in incoming) || Number(previous[key]) === Number(incoming[key]));
}

export function editorSession({install, snapshot, status}) {
    const params = new URLSearchParams(location.search), session = params.get('session');
    if (!session || document.getElementById('s3f-project')) return null;
    const endpoint = `../editors/${encodeURIComponent(session)}`;
    let revision = 0, pending = false, timer, saving, failure, output = params.get('project');
    const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(`s3f-editor-${session}`) : null;
    const editor = Array.from(crypto.getRandomValues(new Uint8Array(16)), b=>b.toString(16).padStart(2,'0')).join('');
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
            status('Edits saved locally · lock finished curves to keep them when inputs change');
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
            const sameMedia = sameVideoSource(snapshot()?.metadata?.source, state.project.metadata.source);
            revision = state.revision; output = state.output || id;
            install(state.project, sameMedia, output);
            status(sameMedia ? 'Latest run loaded · locked curves and composed sections preserved' : 'Source video changed · new project loaded');
        }
    }
    channel && (channel.onmessage = ({data}) => {
        if(data?.type==='prepare-run'){
            channel.postMessage({type:'preparing',request:data.request,editor});
            flush().then(()=>channel.postMessage({type:'prepared',request:data.request,editor}),
                error=>channel.postMessage({type:'prepared',request:data.request,editor,error:error.message}));
        }else if(data?.type==='run')refresh(data.project).catch(error=>status(error.message));
        else if(!data?.type&&!pending&&!saving&&!failure)refresh().catch(error=>status(error.message));
    });
    window.addEventListener('focus',()=>refresh().catch(error=>status(error.message)));
    window.addEventListener('beforeunload', event => {if (pending || saving || failure) {event.preventDefault();event.returnValue = '';}});
    window.s3fFlush = flush;
    window.s3fUpdate = refresh;
    window.s3fHasUnsavedEdits = () => pending || !!saving || !!failure;
    return {
        async load(fallback) {
            const state = await read();
            if (state) {revision = state.revision; output = state.output || output; install(state.project, false, output); status('Saved editor restored · locks survive reruns');}
            else {
                const data=await fallback();
                if(!data){status('Waiting for workflow · connect projects and run the standalone node');return;}
                install(data, false, output); pending = true; await flush();
            }
        },
        changed() {pending = true; clearTimeout(timer); timer = setTimeout(() => flush().catch(() => {}), 300);},
        flush,
    };
}
