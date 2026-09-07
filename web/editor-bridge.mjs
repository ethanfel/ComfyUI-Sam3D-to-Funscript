// The workflow page can be reloaded while its editor tab stays open. Broadcast
// updates and a save handshake keep those tabs connected without an iframe or
// a surviving window.opener reference. No project/pose payload crosses the bus.
export function notifyEditorRun(session, project) {
    if(typeof BroadcastChannel!=="function")return;
    const channel=new BroadcastChannel(`s3f-editor-${session}`);
    channel.postMessage({type:"run",project});channel.close();
}

export function prepareEditorSessions(sessions) {
    if(typeof BroadcastChannel!=="function")return Promise.resolve();
    return Promise.all([...new Set(sessions)].map(session=>new Promise((resolve,reject)=>{
        const channel=new BroadcastChannel(`s3f-editor-${session}`),pending=new Set();
        const request=Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,"0")).join("");
        let discovering=true;
        const finish=error=>{clearTimeout(discovery);clearTimeout(timeout);channel.close();error?reject(error):resolve();};
        const check=()=>{if(!discovering&&!pending.size)finish();};
        // Editors acknowledge receipt immediately, then acknowledge the completed
        // save. The discovery interval also permits a session with no open views.
        const discovery=setTimeout(()=>{discovering=false;check();},250);
        const timeout=setTimeout(()=>finish(new Error("Motion Studio did not finish saving. Check its tab before running again.")),15000);
        channel.onmessage=({data})=>{
            if(data?.request!==request)return;
            if(data.type==="preparing")pending.add(data.editor);
            if(data.type==="prepared"){
                if(data.error){finish(new Error(`Motion Studio save failed: ${data.error}`));return;}
                pending.delete(data.editor);check();
            }
        };
        channel.postMessage({type:"prepare-run",request});
    })));
}
