import assert from 'node:assert/strict';
import {test} from 'node:test';
import {notifyEditorRun,prepareEditorSessions} from '../web/editor-bridge.mjs';

test('Workflow notifications reach a separately opened editor with no opener reference',async()=>{
    const session=crypto.randomUUID(),channel=new BroadcastChannel(`s3f-editor-${session}`);
    try{
        const received=new Promise(resolve=>{channel.onmessage=({data})=>resolve(data);});
        notifyEditorRun(session,'motion_abcdef012345');
        assert.deepEqual(await received,{type:'run',project:'motion_abcdef012345'});
    }finally{channel.close();}
});

test('Preparing a run waits for all responding views to finish saving',async()=>{
    const session=crypto.randomUUID(),channels=[0,1].map(()=>new BroadcastChannel(`s3f-editor-${session}`));
    const saved=[];
    try{
        channels.forEach((channel,editor)=>{channel.onmessage=({data})=>{
            if(data.type!=='prepare-run')return;
            channel.postMessage({type:'preparing',request:data.request,editor});
            setTimeout(()=>{saved.push(editor);channel.postMessage({type:'prepared',request:data.request,editor});},editor?350:20);
        };});
        await prepareEditorSessions([session,session]);assert.deepEqual(saved,[0,1]);
    }finally{channels.forEach(c=>c.close());}
});

test('Save failures reject the run preparation and closed editor sessions do not block it',async()=>{
    const session=crypto.randomUUID(),channel=new BroadcastChannel(`s3f-editor-${session}`);
    try{
        channel.onmessage=({data})=>{if(data.type==='prepare-run')channel.postMessage({type:'prepared',request:data.request,editor:'failed',error:'Draft revision conflict'});};
        await assert.rejects(prepareEditorSessions([session]),/Draft revision conflict/);
    }finally{channel.close();}
    await prepareEditorSessions([session]);
});
