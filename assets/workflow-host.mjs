// Same-origin workspace frames talk directly to the verified ComfyUI host.
export function workflowHost() {
    try {
        if (window.parent !== window && window.parent.location.origin === location.origin && window.parent.s3fWorkflowHost) return window.parent.s3fWorkflowHost();
        if (window.opener && !window.opener.closed && window.opener.location.origin === location.origin) return window.opener;
        return window.parent !== window ? window.parent : null;
    } catch {return null;}
}
export function openWorkspacePage(url, kind = "motion") {
    try {
        if (window.parent !== window && window.parent.location.origin === location.origin && window.parent.s3fOpenWorkspacePage) {
            window.parent.s3fOpenWorkspacePage(String(url), kind); return true;
        }
    } catch { /* A regular standalone editor can still use its normal link. */ }
    return false;
}
