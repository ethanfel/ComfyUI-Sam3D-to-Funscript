"""Keep staged clips until review, then publish the approved video and scripts."""
from pathlib import Path
import copy
import json
import os
import shutil

from .folder_store import LOCK, editing_session
from .processing_store import LOCK as PLAN_LOCK, PlanConflict
from .editor import LOCK as EDITOR_LOCK
from .reference import atomic_json, source_info
from .video import fingerprint

STAGING = '.s3f-civitai-review'


def replace_source(value, old, new, old_id, new_id):
    if isinstance(value,dict):
        return {k:replace_source(v,old,new,old_id,new_id) for k,v in value.items()}
    if isinstance(value,list):return [replace_source(v,old,new,old_id,new_id) for v in value]
    if isinstance(value,str):
        if value==old:return new
        if old_id and value==old_id:return new_id
    return value


class CivitaiReview:
    def __init__(self, library):
        self.library=library;self.folders=library.folders

    def journal_path(self,folder):
        self.folders.path(folder)
        return self.library.root/'civitai'/(folder+'-move.json')

    def recover(self,folder):
        """Finish a committed move, or roll back one interrupted before commit."""
        path=self.journal_path(folder)
        with LOCK,PLAN_LOCK,EDITOR_LOCK:
            if not path.is_file():return
            journal=json.loads(path.read_text())
            if journal['committed']:
                for name in journal['old_files']:Path(name).unlink(missing_ok=True)
            else:
                for name in journal['new_files']:Path(name).unlink(missing_ok=True)
                for name,value in journal['states'].items():atomic_json(Path(name),value)
            path.unlink()

    def approve(self,folder,clip,category,revision,replace=False,expected=None):
        from .civitai_library import category_name
        with LOCK,PLAN_LOCK,EDITOR_LOCK:
            self.recover(folder)
            entry,video=self.folders.entry(folder,clip)
            if not entry.get('civitai_temporary'):
                return self.folders.approve(folder,clip,revision,replace,expected)
            category=category_name(category)
            state=self.folders.read(folder);root=Path(state['root']).resolve();destination=root/category
            if not destination.resolve().is_relative_to(root):raise ValueError('The category points outside the library.')
            destination.mkdir(parents=True,exist_ok=True)
            target=destination/video.name
            # Check every destination before exporting the staging copy.
            from .core import SUFFIXES
            targets=[target,*[target.with_name(target.stem+s+'.funscript') for s in SUFFIXES.values()]]
            if any(p.exists() or p.is_symlink() for p in targets):raise PlanConflict('This category already has a matching video or script. Choose another category.')
            result=self.folders.approve(folder,clip,revision,replace,expected)
            state=self.folders.read(folder);record=state['civitai'][clip]
            editor=self.folders.editors.read(entry['editor_session']);plan=self.folders.plans.read(entry['timeline'])
            old_files=[video,*map(Path,result['files'])];new_files=[destination/p.name for p in old_files]
            state_paths={self.folders.path(folder):state,self.folders.editors.path(entry['editor_session']):editor}
            if plan:
                state_paths[self.folders.plans.directory(entry['timeline'])/'timeline.json']=plan
                if plan.get('project_path') and Path(plan['project_path']).is_file():
                    state_paths[Path(plan['project_path'])]=json.loads(Path(plan['project_path']).read_text())
            journal={'committed':False,'old_files':list(map(str,old_files)),'new_files':[],
                     'states':{str(p):v for p,v in state_paths.items()}}
            path=self.journal_path(folder);path.parent.mkdir(parents=True,exist_ok=True);atomic_json(path,journal)
            try:
                for source,dest in zip(old_files,new_files):
                    # Exclusive creation also works when an Unraid share spans disks.
                    with source.open('rb') as inp,dest.open('xb') as out:
                        journal['new_files'].append(str(dest));atomic_json(path,journal)
                        shutil.copyfileobj(inp,out,1024*1024);out.flush();os.fsync(out.fileno())
                    shutil.copystat(source,dest)
                info=source_info(target)
                old_id=(plan or {}).get('info',{}).get('source_id')
                for filename,value in state_paths.items():
                    if filename==self.folders.path(folder):continue
                    updated=replace_source(value,str(video),str(target),old_id,info['source_id'])
                    if filename==self.folders.editors.path(entry['editor_session']):updated['revision']+=1
                    if plan and filename==self.folders.plans.directory(entry['timeline'])/'timeline.json':
                        updated['info']=info;updated['revision']+=1
                    atomic_json(filename,updated)
                updated=copy.deepcopy(state);managed=updated['civitai'][clip]
                managed.update(name=target.relative_to(root).as_posix(),source=fingerprint(target),temporary=False,category=category,state='approved')
                self.folders.write(updated)
                journal['committed']=True;atomic_json(path,journal)
            except Exception:
                self.recover(folder)
                raise
            self.recover(folder)
            try:video.parent.rmdir()
            except OSError:pass
            result.update(files=list(map(str,new_files[1:])),listing=self.folders.scan(folder),
                          script_versions=self.folders.script_versions(target),relocated=True)
            return result

    def reject(self,folder,clip):
        """Only this browser's registered temporary downloads can be deleted."""
        with LOCK,PLAN_LOCK,EDITOR_LOCK:
            self.recover(folder)
            entry,video=self.folders.entry(folder,clip)
            with editing_session(entry['timeline']):pass
            if not entry.get('civitai_temporary'):
                self.folders.ignore(folder,clip,True,entry['note'])
                return {'deleted':False,'listing':self.folders.scan(folder)}
            state=self.folders.read(folder);record=state['civitai'][clip]
            expected=Path(state['root'])/STAGING/record['id']
            if video.parent!=expected or video.is_symlink() or fingerprint(video)!=record['source']:
                raise PlanConflict('The temporary video changed. Refresh before rejecting it.')
            scripts=self.folders.script_versions(video)
            # Persist rejection before deletion so a restart never adds it to bulk processing.
            self.folders.ignore(folder,clip,True,entry['note'])
            for name in scripts:(video.parent/name).unlink()
            video.unlink()
            state=self.folders.read(folder);state['civitai'][clip]['state']='rejected';self.folders.write(state)
            self.library.ignore(folder,record['id'],True)
            try:video.parent.rmdir()
            except OSError:pass
            return {'deleted':True,'listing':self.folders.scan(folder)}
