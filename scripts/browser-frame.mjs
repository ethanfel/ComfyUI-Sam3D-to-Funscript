// Drive an editor inside the workspace while keeping CDP pointer coordinates
// in the top-level page's coordinate space.
export function browserFrame(shell, filename) {
    const expression=`[...document.querySelectorAll('iframe')].find(frame=>new URL(frame.src).pathname.endsWith('/'+${JSON.stringify(filename)}))`;
    const activate=()=>shell.evaluate(`(()=>{const frame=${expression};if(!frame)return false;const panel=frame.closest('.page');document.querySelector('[aria-controls="'+panel.id+'"]')?.click();return true})()`);
    return {
        activate,
        evaluate:source=>shell.evaluate(`(()=>{const frame=${expression};if(!frame)throw new Error('Editor frame is not available');return frame.contentWindow.eval(${JSON.stringify(source)})})()`),
        async call(method,params={}){
            if(method==='Input.dispatchMouseEvent'){
                await activate();
                const offset=await shell.evaluate(`(()=>{const r=(${expression}).getBoundingClientRect();return {x:r.x,y:r.y}})()`);
                params={...params,x:params.x+offset.x,y:params.y+offset.y};
            }
            return shell.call(method,params);
        },
    };
}
