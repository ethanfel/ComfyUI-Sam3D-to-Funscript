// Server-backed drafts: one revision stream shared by the embedded and full editor.
// A stale editor cannot overwrite a newer draft or a completed rerun.
export function sameVideoSource(previous, incoming) {
    if (typeof previous?.path !== 'string' || previous.path !== incoming?.path) return false;
    return ['size', 'mtime_ns'].every(key => !(key in previous && key in incoming) || Number(previous[key]) === Number(incoming[key]));
}

const viewFields = ['active', 'selection', 'selection_track', 'selection_lane'];
const displayMetadata = ['scene_cuts', 'reference_stabilization'];
function authoredMetadata(metadata) {
    if (!metadata) return metadata;
    const copy = {...metadata};
    for (const key of displayMetadata) delete copy[key];
    if (copy.processing_timeline) {
        const {session, ...processing} = copy.processing_timeline;
        if (Object.keys(processing).length) copy.processing_timeline = processing;
        else delete copy.processing_timeline;
    }
    return copy;
}

// Object order can change across Python exports; it is not an authored edit.
function equalJSON(a, b) {
    if (a === b) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equalJSON(a[key], b[key]));
}
const sameContent = (a, b) => a === b || (a !== undefined && b !== undefined && equalJSON(JSON.parse(a), JSON.parse(b)));

// Compare all project content except presentation and derived display metrics.
// Keep source snapshots, geometry, locks, scripts and calibration in the check:
// a newer inference result must never be replaced by a stale curve save.
export function editorContent(project) {
    if (!project) return JSON.stringify(project);
    const {preview, metrics, reference_comparison, ...content} = project;
    content.metadata = authoredMetadata(content.metadata);
    if (content.timeline) {
        content.timeline = {...content.timeline};
        for (const key of viewFields) delete content.timeline[key];
        content.timeline.tracks = content.timeline.tracks.map(({collapsed, metrics, ...track}) => track);
        // Match the backend's stable region/anchor identity migration.
        const names = new Map();
        content.timeline.sources = content.timeline.sources.map(source => {
            const region = source.data?.metadata?.processing_region;
            if (!region?.id) return source;
            const input = `region:${region.id}:${source.data.config.target_anchor}`;
            names.set(source.id, input);return {...source, input};
        });
        content.timeline.latest = Object.fromEntries(Object.entries(content.timeline.latest ||
            Object.fromEntries(content.timeline.sources.map(source => [source.input ?? source.id.split('@')[0], source.id])))
            .map(([key, id]) => [names.get(id) || key, id]));
    }
    return JSON.stringify(content);
}

export function withEditorView(project, local) {
    if (!sameVideoSource(local?.metadata?.source, project?.metadata?.source)) return project;
    const timeline = {...project.timeline}, tracks = new Map(local.timeline.tracks.map(track => [track.id, track]));
    for (const key of viewFields) if (key in local.timeline) timeline[key] = local.timeline[key];
    timeline.tracks = timeline.tracks.map(track => tracks.has(track.id) ? {...track, collapsed: !!tracks.get(track.id).collapsed} : track);
    return {...project, preview: local.preview, timeline};
}

export function editorSession({install, snapshot, status, recovery = () => {}, downloadDraft}) {
    const params = new URLSearchParams(location.search), session = params.get('session');
    if (!session || document.getElementById('s3f-project')) return null;
    const endpoint = `../editors/${encodeURIComponent(session)}`;
    let revision = 0, baseContent, unconfirmed, pending = false, timer, retryTimer, retryDelay = 1000, saving, recovering, refreshing, failure, output = params.get('project');
    const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(`s3f-editor-${session}`) : null;
    const editor = Array.from(crypto.getRandomValues(new Uint8Array(16)), b=>b.toString(16).padStart(2,'0')).join('');
    async function read() {
        const response = await fetch(endpoint, {cache: 'no-store', signal: AbortSignal.timeout(30000)});
        if (!response.ok) throw Object.assign(new Error(await response.text()), {status: response.status});
        return response.json();
    }
    function saved() {clearTimeout(retryTimer);retryDelay = 1000;unconfirmed = null;failure = null;recovery(null);}
    function retryConnection(error) {
        if (error.status && error.status < 500 || !['TypeError', 'TimeoutError', 'AbortError'].includes(error.name) && !error.status) return;
        clearTimeout(retryTimer);
        status('ComfyUI is unavailable · edits kept in this tab · retrying the save automatically');
        retryTimer = setTimeout(() => flush().catch(() => {}), retryDelay);
        retryDelay = Math.min(10000, retryDelay * 2);
    }
    function accept(state, keepView = true, id = output) {
        const current = snapshot(), sameMedia = sameVideoSource(current?.metadata?.source, state.project.metadata.source);
        revision = state.revision; output = state.output || id;
        install(keepView ? withEditorView(state.project, current) : state.project, sameMedia, output);
        // Installation normalizes older project formats before editing begins.
        baseContent = editorContent(snapshot());
        saved();
        return sameMedia;
    }
    async function savePending() {
        let conflicts = 0;
        while (pending) {
            pending = false;
            const project = snapshot(), content = editorContent(project);
            const body = JSON.stringify({revision, project}), sentRevision = revision;
            let response;
            try {response = await fetch(endpoint, {method: 'POST', headers: {'Content-Type': 'application/json'}, body, signal: AbortSignal.timeout(30000)});}
            catch (error) {unconfirmed ??= {revision: sentRevision, content};throw error;}
            if (response.ok) {
                try {revision = (await response.json()).revision;}
                catch (error) {unconfirmed ??= {revision: sentRevision, content};throw error;}
                baseContent = content;
                saved();
                channel?.postMessage({revision});
                status('Edits saved locally · lock finished curves to keep them when inputs change');
                continue;
            }
            const message = await response.text();
            if (response.status === 409 && ++conflicts <= 3) {
                const state = await read(), current = snapshot();
                if (state) {
                    const localContent = editorContent(current), remoteContent = editorContent(state.project);
                    if (unconfirmed && state.revision === unconfirmed.revision + 1 && sameContent(remoteContent, unconfirmed.content)) {
                        // A POST committed before the restart, but its reply was
                        // lost. Newer local edits can build on that saved draft.
                        baseContent = remoteContent;unconfirmed = null;
                    }
                    if (sameContent(localContent, baseContent) || sameContent(localContent, remoteContent)) {
                        // Nothing authored here has been lost. Retain this tab's
                        // selection/layout while adopting the latest saved curves.
                        pending = false; const sameMedia = accept(state);
                        status(sameMedia ? 'Latest saved curves loaded · your selection and layout were kept' : 'Source video changed · new project loaded');
                        return;
                    }
                    if (sameVideoSource(current?.metadata?.source, state.project.metadata.source) && sameContent(remoteContent, baseContent)) {
                        // Only presentation or the export revision changed on the
                        // server. Retry our authored edits with its current revision.
                        revision = state.revision; output = state.output || output;
                        // These fields come from the server, not curve authoring.
                        // Keep its newest values when retrying our own edits.
                        for (const key of displayMetadata) {
                            if (key in state.project.metadata) current.metadata[key] = state.project.metadata[key];
                            else delete current.metadata[key];
                        }
                        if (state.project.metadata.processing_timeline) current.metadata.processing_timeline = {...state.project.metadata.processing_timeline};
                        else delete current.metadata.processing_timeline;
                        pending = true;
                        continue;
                    }
                }
            }
            if (response.status >= 500) unconfirmed ??= {revision: sentRevision, content};
            throw Object.assign(new Error(message), {status: response.status});
        }
    }
    async function flush() {
        clearTimeout(timer);
        clearTimeout(retryTimer);
        if (recovering) {await recovering; return flush();}
        if (saving) {await saving; return flush();}
        if (!pending) return;
        saving = savePending();
        try {await saving;}
        catch (error) {
            pending = true; failure = error;
            status(`Save paused: ${error.message}`);
            recovery(error.message);
            retryConnection(error);
            throw error;
        } finally {saving = null;}
    }
    async function refresh(id = output) {
        if (refreshing) return refreshing;
        refreshing = (async () => {
            await flush();
            const state = await read();
            // Do not install over an edit made while the network read was in flight.
            if (pending || saving || recovering || failure) return;
            if (state && state.revision > revision) {
                const sameMedia = accept(state, true, id);
                status(sameMedia ? 'Latest run loaded · locked curves and composed sections preserved' : 'Source video changed · new project loaded');
            }
        })();
        try {await refreshing;} finally {refreshing = null;}
    }
    async function recover() {
        if (recovering) return recovering;
        clearTimeout(timer);
        recovering = (async () => {
            if (saving) await saving.catch(() => {});
            const state = await read();
            if (!state) throw new Error('No saved project is available yet. Download your current project before closing this tab.');
            if (!downloadDraft) throw new Error('Download your current project before reloading this tab.');
            // Read first; capture last so edits made during that read also reach
            // the download. Never replace the draft if the download cannot start.
            downloadDraft(JSON.stringify(snapshot()));
            pending = false; accept(state, false);
            status('Draft download created · latest saved project loaded · ready to continue');
        })();
        try {await recovering;}
        finally {recovering = null;}
    }
    channel && (channel.onmessage = ({data}) => {
        if(data?.type==='prepare-run'){
            channel.postMessage({type:'preparing',request:data.request,editor});
            flush().then(()=>channel.postMessage({type:'prepared',request:data.request,editor}),
                error=>channel.postMessage({type:'prepared',request:data.request,editor,error:error.message}));
        }else if(data?.type==='run')refresh(data.project).catch(error=>status(error.message));
        else if(!data?.type&&!pending&&!saving&&!recovering&&!failure)refresh().catch(error=>status(error.message));
    });
    window.addEventListener('focus',()=>refresh().catch(error=>status(error.message)));
    window.addEventListener('online',()=>refresh().catch(error=>status(error.message)));
    window.addEventListener('beforeunload', event => {if (pending || saving || recovering || failure) {event.preventDefault();event.returnValue = '';}});
    window.s3fFlush = flush;
    window.s3fUpdate = refresh;
    window.s3fReconnect = refresh;
    window.s3fHasUnsavedEdits = () => pending || !!saving || !!recovering || !!failure;
    return {
        async load(fallback) {
            const state = await read();
            if (state) {accept(state, false); status('Saved editor restored · locks survive reruns');}
            else {
                const data=await fallback();
                if(!data){status('Waiting for workflow · connect projects and run the standalone node');return;}
                install(data, false, output); baseContent = editorContent(snapshot()); pending = true; await flush();
            }
        },
        changed() {pending = true; clearTimeout(timer); if (!failure) timer = setTimeout(() => flush().catch(() => {}), 300);},
        flush, recover,
    };
}
