// Cross-repository contract check using a neutral H3 project and real exports.
// node tests/test_h3_funciv.mjs /path/to/FunCiv-player /path/to/python
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';

assert.ok(process.argv[2], 'Supply the FunCiv-player repository path.');
const player=path.resolve(process.argv[2]),python=process.argv[3]||'python';
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'s3f-h3-funciv-'));
try {
    const fixture=spawnSync(python,['-c',`
import json,sys
from pathlib import Path
sys.path.insert(0,'tests')
from test_h3_project import H3ProjectTests, write
from sam3d_funscript.core import SUFFIXES
from sam3d_funscript.h3_project import CATALOGUES
test=H3ProjectTests(); test.setUp()
try:
    import shutil
    root=Path(sys.argv[1]); project=root/'book'
    shutil.copytree(test.project,project)
    data=json.loads((project/'project.json').read_text())
    data['pages'].sort(key=lambda p:p['order'])
    for page in data['pages']: page.update(width=64,height=48)
    write(project/'project.json',data)
    for layout_file in project.glob('pages/*/layouts/*/layout.json'):
        for panel in json.loads(layout_file.read_text())['panels']:
            write(project/panel['folder']/'panel.json',dict(panel_id=panel['panel_id'],bbox=[0,0,1,1],reference='clean_reference.png'))
    listing=test.store.prepare(str(project),kind='h3'); folder=listing['folder']
    newest=listing['entries'][0]
    write((project/newest['name']).parents[2]/'main_take.json',{'take_id':'take_0001'})
    test.store.scan(folder,refresh=True);entry=test.store.choose(folder)
    assert entry['h3']['take']=='take_0001'
    test.store.open(folder,entry['id']);state=test.store.editors.read(entry['editor_session'])
    for i,axis in enumerate(SUFFIXES):
        actions=([{'at':500,'pos':37}] if axis=='L1' else
                 [{'at':0,'pos':10+i},{'at':250,'pos':80-i},{'at':750,'pos':20+i},{'at':1000,'pos':10+i}])
        state['project']['scripts'][axis]['actions']=actions
        state['project']['timeline']['main'][axis]['edited']=True
    saved=test.store.editors.save(entry['editor_session'],state['project'],state['revision'])
    approved=test.store.approve(folder,entry['id'],saved['revision'])
    expected={axis:json.loads((project/entry['name']).with_name('video_clean'+suffix+'.funscript').read_text()) for axis,suffix in SUFFIXES.items()}
    write(root/'expected.json',{'scripts':expected,'files':approved['files']})
finally:
    test.doCleanups();CATALOGUES.clear()
`,temp],{encoding:'utf8'});
    assert.equal(fixture.status,0,fixture.stderr);
    const {MangaService}=await import(pathToFileURL(path.join(player,'electron/manga-service.cjs')));
    const {validateScript}=await import(pathToFileURL(path.join(player,'packages/manga-core/motion.mjs')));
    const expected=JSON.parse(await fs.readFile(path.join(temp,'expected.json'),'utf8'));
    const service=await new MangaService(path.join(temp,'player-profile')).init();
    const book=await service.open(path.join(temp,'book'));
    assert.deepEqual(book.issues,[]);
    const panel=book.pages[0].panels[0],take=panel.takes.find(t=>t.id===panel.selected);
    assert.equal(take.id,'take_0001','FunCiv and the node select the same main take');
    assert.equal(take.durationMs,1000);
    assert.deepEqual(Object.keys(take.scripts).sort(),Object.keys(expected.scripts).sort());
    for(const [axis,id] of Object.entries(take.scripts)) {
        const script=JSON.parse(await fs.readFile(await service.file(id),'utf8'));
        assert.deepEqual(validateScript(script,take.durationMs),expected.scripts[axis]);
    }
    const run=await service.prepare(book.id,0,{mode:'none'});
    assert.deepEqual(run.warnings,[]);
    assert.equal(run.duration_ms,1000);
    assert.equal(run.segments[0].motion,true);
    for(const axis of Object.keys(expected.scripts))assert.deepEqual(run.scripts[axis].actions,expected.scripts[axis].actions);
    console.log('H3 approval → six sidecars → FunCiv import and motion playback: passed.');
} finally {
    await fs.rm(temp,{recursive:true,force:true});
}
