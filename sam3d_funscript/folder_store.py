"""Persistent per-video folder review, using the ordinary timeline/editor stores."""
import hashlib
import json
import os
import copy
import uuid
import time
from contextlib import contextmanager
from pathlib import Path
import re
import threading
from datetime import datetime, timezone

from .core import SUFFIXES, validate_actions
from .editor import EditorStore, LOCK as EDITOR_LOCK, same_video, validate
from .processing_store import ProcessingStore, LOCK as PLAN_LOCK, PlanConflict
from .reference import atomic_json, source_info
from .clip_tags import tag_fields, edit_tags, normalize_tags
from .video import fingerprint
from .folder_review import preset_settings, subfolder_name, review_issues

LOCK = threading.RLock()
ACTIVE = {}
BATCH_RUNNING = set()
REVIEW_LEASES = {}
# Only filenames are cached. Identity, scripts, decisions and processing state
# are checked afresh whenever a clip is used, including before approval.
ENTRY_NAMES = {}
SCRIPT_READINESS = {}


def script_readiness(video, existing):
    """A secondary sidecar alone is not usable Main motion. Cache by file stat."""
    primary = video.with_suffix('.funscript')
    if not existing: return None
    if not primary.is_file(): return 'Main L0 script is missing; secondary axes are present.'
    if primary.is_symlink(): return 'Main L0 script is a link and cannot be imported safely.'
    stat = primary.stat(); key = (str(primary), stat.st_mtime_ns, stat.st_ctime_ns, stat.st_size)
    if key not in SCRIPT_READINESS:
        try:
            if stat.st_size > 64 * 1024 * 1024: raise ValueError('Script exceeds 64 MB')
            validate_actions(json.loads(primary.read_text(encoding='utf-8'))['actions'])
            warning = None
        except (ValueError, KeyError, TypeError, OSError) as error:
            warning = f'Main L0 script is invalid: {error}'
        if len(SCRIPT_READINESS) >= 4096: SCRIPT_READINESS.clear()
        SCRIPT_READINESS[key] = warning
    return SCRIPT_READINESS[key]


@contextmanager
def editing_session(session):
    """Serialize a browser save with the batch claiming this particular clip."""
    with LOCK:
        owner = ACTIVE.get(session)
        if owner is not None and owner != threading.get_ident():
            raise PlanConflict('This clip is processing. Other completed clips can still be edited.')
        yield
VIDEO_EXTENSIONS = {'.mp4', '.mkv', '.mov', '.webm', '.avi', '.m4v', '.mpg', '.mpeg', '.ts', '.mts'}


def identity(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()[:32]


def motion_session(timeline):
    return hashlib.sha256(f'{timeline}:motion'.encode()).hexdigest()[:32]


class FolderStore:
    def __init__(self, root):
        self.root = Path(root)
        self.plans = ProcessingStore(self.root / 'processing')
        self.editors = EditorStore(self.root)

    def path(self, folder):
        if not isinstance(folder, str) or not re.fullmatch(r'[a-f0-9]{32}', folder):
            raise ValueError('Invalid folder session')
        return self.root / 'folders' / f'{folder}.json'

    def read(self, folder):
        path = self.path(folder)
        if not path.is_file():
            raise ValueError('Run the Folder Timeline node once to register this folder.')
        return json.loads(path.read_text())

    def write(self, state):
        path = self.path(state['folder']); path.parent.mkdir(parents=True, exist_ok=True)
        atomic_json(path, state)

    def prepare(self, directory, recursive=True, *, kind=None):
        if not isinstance(directory, str) or not directory.strip():
            raise ValueError('Choose a folder containing videos.')
        root = Path(directory).expanduser().resolve(strict=True)
        if not root.is_dir():
            raise ValueError('The folder path must be a directory.')
        if kind == 'h3':
            from .h3_project import catalogue
            catalogue(root)
        folder = identity(['h3', str(root)]) if kind == 'h3' else identity(str(root))
        with LOCK:
            state = self.read(folder) if self.path(folder).exists() else {'folder': folder, 'root': str(root), 'decisions': {}}
            state['recursive'] = bool(recursive)
            if kind == 'h3': state['kind'] = kind
            self.write(state)
            return self.scan(folder)

    def _entry_key(self, state):
        return (str(self.path(state['folder']).absolute()), state['root'], state['recursive'])

    def _entry(self, state, path, managed=None, h3=None):
        root = Path(state['root']); folder = state['folder']
        if path.suffix.lower() not in VIDEO_EXTENSIONS or path.is_symlink() or not path.is_file():
            return None
        source = fingerprint(path)
        if not Path(source['path']).is_relative_to(root):
            return None
        name = path.relative_to(root).as_posix(); clip = identity(source); record = None
        if managed is None:
            managed = {r['name']:(key,r) for key,r in state.get('civitai',{}).items() if r.get('state')!='rejected'}
        if name in managed:
            stable, known = managed[name]
            if known.get('source') == source: clip, record = stable, known
        timeline = identity([folder, clip]); decision = state['decisions'].get(clip, {})
        existing = [path.with_name(path.stem + suffix + '.funscript').name for suffix in SUFFIXES.values()
                    if path.with_name(path.stem + suffix + '.funscript').exists()]
        script_warning = script_readiness(path, existing)
        approved = bool(existing) and not script_warning and decision.get('status') == 'approved' and all((path.parent / f).is_file() for f in decision.get('files', []))
        status = 'ignored' if decision.get('status') == 'ignored' else 'approved' if approved else 'existing' if existing and not script_warning else 'pending'
        set_aside = False
        if state.get('civitai_set_aside'):
            from .civitai_library import ID_PATTERN
            match = ID_PATTERN.search(path.name)
            set_aside = bool(match and match.group(1) in state['civitai_set_aside'])
        extra = {}
        if state.get('kind') == 'h3':
            from .h3_project import catalogue, decisions
            book, exclusions = h3 or (catalogue(root), decisions(root))
            metadata = book['clips'].get(name)
            if metadata is None: return None
            page_excluded = bool(set(metadata['source_page_ids']) & set(exclusions.get('excluded_pages', [])))
            panel_excluded = bool(set(metadata['source_panel_ids']) & set(exclusions.get('excluded_panels', [])))
            video_excluded = any(Path(value).parent == Path(name).parent for value in exclusions.get('excluded_videos', []))
            if page_excluded or panel_excluded or video_excluded: status = 'ignored'
            extra['h3'] = {**metadata, 'page_excluded': page_excluded, 'panel_excluded': panel_excluded, 'video_excluded': video_excluded}
        return dict(**extra, **tag_fields(decision), id=clip, name=name, status=status, note=decision.get('note', ''), quality=decision.get('quality', 0),
            audio_sync=decision.get('audio_sync') is True, intensity=decision.get('intensity', 0),
            intensity_mode=decision.get('intensity_mode', 'manual' if decision.get('intensity', 0) else 'auto'),
            queue_state=next((item['state'] for item in state.get('processing_queue',{}).get('items',[]) if item.get('clip')==clip),None),
            batch_result=decision.get('batch_result'), error=decision.get('error'), existing=existing, script_warning=script_warning, processing=timeline in ACTIVE,
            timeline=timeline, editor_session=motion_session(timeline), draft=(self.plans.directory(timeline) / 'timeline.json').is_file(),
            civitai_id=record.get('id') if record else None,civitai_temporary=bool(record and record.get('temporary')),civitai_set_aside=set_aside,
            category_hint=record.get('category','') if record else '')

    def scan(self, folder, *, refresh=False):
        with LOCK:
            state = self.read(folder); root = Path(state['root'])
            if not root.is_dir():
                raise ValueError('The video folder is unavailable. Reconnect its drive and refresh.')
            h3 = None
            if state.get('kind') == 'h3':
                from .h3_project import catalogue, decisions
                h3 = catalogue(root, refresh=refresh), decisions(root)
                files = [root / name for name in h3[0]['clips']]
            else:
                files = root.rglob('*') if state['recursive'] else root.iterdir()
            entries = []
            managed={record['name']:(clip,record) for clip,record in state.get('civitai',{}).items() if record.get('state')!='rejected'}
            for path in files:
                entry = self._entry(state, path, managed, h3)
                if entry is not None: entries.append(entry)
            if h3: entries.sort(key=lambda e: (e['h3']['page_order'], e['h3']['panel_order'], -int(e['h3']['take'][5:])))
            else: entries.sort(key=lambda row: row['name'].casefold())
            ENTRY_NAMES[self._entry_key(state)] = {entry['id']:entry['name'] for entry in entries}
            batch = copy.deepcopy(state.get('batch'))
            if batch and h3: batch['removed_ids'] = state.get('batch_control', {}).get('skip_ids', [])
            if state.get('processing_queue'):
                from .folder_queue import FolderQueue
                queued=FolderQueue(self.root).read(folder)
                if queued['stage'] in ('queued','running') or batch is None or batch.get('queue'):
                    batch=FolderQueue.report(queued)
            if batch and batch['stage'] == 'running' and folder not in BATCH_RUNNING: batch['stage'] = 'interrupted'
            return dict(**({'h3': {'workspace_version': 2, 'title': h3[0]['title'], 'pages': h3[0]['pages'], 'panels': h3[0]['panels'], 'warnings': h3[0]['warnings'], **h3[1]}} if h3 else {}),
                folder=folder, root=state['root'], recursive=state['recursive'], entries=entries, batch=batch, presets=state.get('presets', {}), bulk_audio_sync=True, tagging=True, bulk_reprocess=True, dataset_upload=not bool(h3),
                counts={status: sum(e['status'] == status for e in entries) for status in ('pending', 'approved', 'existing', 'ignored')})

    def entry(self, folder, clip):
        if not isinstance(clip, str) or not re.fullmatch(r'[a-f0-9]{32}', clip):
            raise PlanConflict('This video moved or changed. Refresh the folder before continuing.')
        with LOCK:
            state = self.read(folder)
            name = ENTRY_NAMES.get(self._entry_key(state), {}).get(clip)
            if name is not None:
                path = Path(state['root']) / name
                entry = self._entry(state, path)
                if entry and entry['id'] == clip: return entry, path
            listing = self.scan(folder)
            entry = next((e for e in listing['entries'] if e['id'] == clip), None)
            if entry is None:
                raise PlanConflict('This video moved or changed. Refresh the folder before continuing.')
            return entry, Path(listing['root']) / entry['name']

    def clip_listing(self, folder, clip):
        """Fresh status for one known clip, without walking the library."""
        return dict(folder=folder, partial=True, entries=[self.entry(folder, clip)[0]])

    def choose(self, folder, name='', *, skip_done=False):
        listing = self.scan(folder)
        entry = next((e for e in listing['entries'] if e['name'] == name), None) if name else None
        if entry is None or (skip_done and entry['status'] != 'pending'):
            entry = next((e for e in listing['entries'] if e['status'] == 'pending' and e.get('h3', {}).get('main', True)), None)
        return entry

    def open(self, folder, clip, client=None):
        with LOCK, PLAN_LOCK, EDITOR_LOCK:
            entry, path = self.entry(folder, clip)
            if client: self.hold_review(folder, clip, client)
            if entry['processing'] and ACTIVE.get(entry['timeline']) != threading.get_ident():
                return {**entry, 'script_versions': self.script_versions(path)}
            state = self.plans.read(entry['timeline'])
            if state is None or state['info']['source'] != fingerprint(path):
                state = self.plans.prepare(entry['timeline'], source_info(path))
            info = state['info']
            previous_exists = self.editors.path(entry['editor_session']).is_file()
            if state.get('editor_session') != entry['editor_session']:
                self.plans.bind_editor(entry['timeline'], entry['editor_session'])
            self.plans.prepare_editor(entry['timeline'], info['source_id'], entry['editor_session'])
            entry['script_versions'] = self.script_versions(path)
            if not previous_exists and entry['existing']:
                editor = self.editors.read(entry['editor_session'])
                project = copy.deepcopy(editor['project'])
                imported, warnings = [], []
                for axis, suffix in SUFFIXES.items():
                    script_path = path.with_name(path.stem + suffix + '.funscript')
                    if not script_path.exists(): continue
                    try:
                        if script_path.is_symlink(): raise ValueError('Linked funscripts cannot be imported or replaced.')
                        script = json.loads(script_path.read_text())
                        validate_actions(script['actions'])
                        project['scripts'][axis] = script
                        project['timeline']['main'][axis].update(edited=True, processing_generated=False)
                        imported.append(script_path.name)
                    except (ValueError, KeyError, TypeError, OSError) as error:
                        warnings.append(f'{axis}: {error}')
                if imported:
                    project['metadata']['imported_scripts'] = imported
                    self.editors.save(entry['editor_session'], project, editor['revision'])
                    self.save_version(folder, clip, 'Existing script', project=project)
                if warnings:
                    entry['script_warning'] = 'Existing script could not be loaded: ' + '; '.join(warnings) + '. Valid axes were kept; processing is still available.'
            return entry

    def hold_review(self, folder, clip, client):
        if not isinstance(client, str) or not re.fullmatch(r'[a-f0-9-]{16,64}', client): raise ValueError('Invalid review window')
        with LOCK:
            key=(folder,client)
            if clip is None: REVIEW_LEASES.pop(key,None)
            else:
                entry,_=self.entry(folder,clip)
                if not entry['processing']: REVIEW_LEASES[key]=(clip,time.monotonic()+20)
            return {'held':clip}

    def preset(self, folder, subfolder, settings=None):
        name=subfolder_name(subfolder)
        with LOCK:
            state=self.read(folder)
            if settings is not None:
                if folder in BATCH_RUNNING:raise PlanConflict('Pause the batch before changing its subfolder presets.')
                state.setdefault('presets',{})[name]=preset_settings(settings);self.write(state)
            available=state.get('presets',{})
            parents=[key for key in available if not key or name==key or name.startswith(key+'/')]
            key=max(parents,key=len) if parents else None
            return {'subfolder':key,'settings':copy.deepcopy(available[key]) if key is not None else None}

    def clip_preset(self, folder, entry):
        state = self.read(folder)
        if state.get('kind') == 'h3':
            from .h3_project import preset
            effective = preset(state['root'], panel=entry['h3']['panel_id'])
            if effective['inherited_from']:
                return {k:v for k,v in effective['settings'].items() if k != 'confidence'}
        parent=entry.get('category_hint') or Path(entry['name']).parent.as_posix()
        return self.preset(folder,'' if parent=='.' else parent)['settings']

    def version_directory(self, folder, clip):
        self.path(folder)
        if not isinstance(clip,str) or not re.fullmatch('[a-f0-9]{32}',clip):raise ValueError('Invalid video identity')
        return self.root/'folder_versions'/folder/clip

    def version(self, folder, clip, version):
        self.entry(folder,clip)
        if not isinstance(version,str) or not re.fullmatch('[a-f0-9]{32}',version):raise ValueError('Invalid script version')
        return json.loads((self.version_directory(folder,clip)/(version+'.json')).read_text())

    def versions(self, folder, clip):
        self.entry(folder,clip)
        return [{k:v for k,v in json.loads(path.read_text()).items() if k not in ('scripts','axis_settings')}
                for path in sorted(self.version_directory(folder,clip).glob('*.json'), key=lambda p:p.stat().st_mtime,reverse=True)]

    def save_version(self, folder, clip, name, revision=None, quality=0, note='', project=None):
        if not isinstance(name,str) or not name.strip() or len(name)>100:raise ValueError('Give the version a name of up to 100 characters.')
        if type(quality) is not int or not 0<=quality<=5 or not isinstance(note,str) or len(note)>2000:raise ValueError('Invalid version rating or note')
        with LOCK, EDITOR_LOCK:
            entry,_=self.entry(folder,clip)
            with editing_session(entry['editor_session']):
                editor=self.editors.read(entry['editor_session'])
                if project is None:
                    if not editor or editor['revision']!=revision:raise PlanConflict('Save and review the current curves before saving a version.')
                    project=editor['project']
                version=dict(id=uuid.uuid4().hex,name=name.strip(),quality=quality,note=note,created=datetime.now(timezone.utc).isoformat(),
                    scripts=copy.deepcopy(project['scripts']),axis_settings=copy.deepcopy(project['config']['axis_settings']))
                for script in version['scripts'].values():validate_actions(script['actions'])
                directory=self.version_directory(folder,clip);directory.mkdir(parents=True,exist_ok=True)
                atomic_json(directory/(version['id']+'.json'),version)
                return {k:v for k,v in version.items() if k not in ('scripts','axis_settings')}

    def restore_version(self, folder, clip, version, revision):
        with LOCK, EDITOR_LOCK:
            entry,_=self.entry(folder,clip)
            with editing_session(entry['editor_session']):
                editor=self.editors.read(entry['editor_session'])
                if not editor or editor['revision']!=revision:raise PlanConflict('Save and review the latest curves before restoring a version.')
                saved=self.version(folder,clip,version);project=copy.deepcopy(editor['project'])
                if any(main.get('locked') for axis,main in project['timeline']['main'].items() if axis in saved['scripts']):
                    raise PlanConflict('Unlock the Main axes before restoring a script version.')
                self.save_version(folder,clip,'Before restoring '+saved['name'][:75],revision=revision)
                for axis,script in saved['scripts'].items():
                    project['scripts'][axis]=script
                    project['config']['axis_settings'][axis]=saved['axis_settings'][axis]
                    project['timeline']['main'][axis].update(edited=True,assembled=True,processing_generated=False,regions=[])
                result=self.editors.save(entry['editor_session'],project,revision)
                return {'revision':result['revision'],'versions':self.versions(folder,clip)}

    def rate_version(self, folder, clip, version, name, quality, note):
        if not isinstance(name,str) or not name.strip() or len(name)>100 or type(quality) is not int or not 0<=quality<=5 or not isinstance(note,str) or len(note)>2000:
            raise ValueError('Use a version name, a 1–5 star rating or unrated, and a short note.')
        with LOCK:
            saved=self.version(folder,clip,version);saved.update(name=name.strip(),quality=quality,note=note)
            atomic_json(self.version_directory(folder,clip)/(version+'.json'),saved)
            return self.versions(folder,clip)

    def issues(self, folder, clip):
        entry,_=self.entry(folder,clip);editor=self.editors.read(entry['editor_session'])
        plan = self.plans.read(entry['timeline'])
        issues = review_issues(editor['project'] if editor else None, plan)
        if entry.get('h3', {}).get('loop') and editor and plan:
            from .h3_project import loop_issues
            issues += loop_issues(editor['project'], plan['info']['end_ms'])
        return issues

    def pause_batch(self, folder):
        with LOCK:
            if folder not in BATCH_RUNNING:raise PlanConflict('No batch is currently processing. Refresh the folder.')
            state=self.read(folder);state.setdefault('batch_control', {})['pause']=True;self.write(state)
            if state.get('processing_queue',{}).get('stage')=='running':
                state['processing_queue']['pause']=True;self.write(state)
            return {'pause_requested':True}

    @staticmethod
    def script_versions(video):
        versions = {}
        for suffix in SUFFIXES.values():
            path = video.with_name(video.stem + suffix + '.funscript')
            if path.is_symlink(): raise ValueError('Linked funscripts cannot be replaced.')
            if path.exists(): versions[path.name] = hashlib.sha256(path.read_bytes()).hexdigest()
        return versions

    def intensity_estimate(self, folder, clip):
        from .intensity import estimate_intensity
        entry, _ = self.entry(folder, clip)
        editor = self.editors.read(entry['editor_session'])
        plan = self.plans.read(entry['timeline']) or {}
        cuts = (plan.get('scene_cuts') or {}).get('times_ms')
        return dict(clip=clip, revision=editor['revision'] if editor else 0,
                    **estimate_intensity(editor['project'] if editor else None, cuts))

    def review(self, folder, clip, quality=0, note='', audio_sync=None, intensity=None, *, compact=False, intensity_mode=None, tags=None):
        if type(quality) is not int or not 0 <= quality <= 5 or not isinstance(note, str) or len(note) > 2000:
            raise ValueError('Choose 1–5 stars (or unrated) and a note of up to 2000 characters.')
        if audio_sync is not None and type(audio_sync) is not bool:
            raise ValueError('Audio sync must be checked or unchecked.')
        if intensity is not None and (type(intensity) is not int or not 0 <= intensity <= 5):
            raise ValueError('Choose intensity from 1–5, or 0 for unrated.')
        if intensity_mode is not None and intensity_mode not in ('auto', 'manual'):
            raise ValueError('Choose automatic or manual intensity.')
        if tags is not None: tags = normalize_tags(tags)
        with LOCK:
            entry,_=self.entry(folder, clip)
            with editing_session(entry['timeline']): pass
            state = self.read(folder)
            state['decisions'].setdefault(clip, {}).update(quality=quality, note=note, updated=datetime.now(timezone.utc).isoformat())
            if audio_sync is not None:
                state['decisions'][clip]['audio_sync'] = audio_sync
            decision = state['decisions'][clip]
            if tags is not None: edit_tags(decision, tags)
            mode = intensity_mode or ('manual' if intensity is not None else decision.get('intensity_mode'))
            if mode == 'auto':
                decision['intensity'] = self.intensity_estimate(folder, clip)['level']
            elif intensity is not None:
                decision['intensity'] = intensity
            if mode is not None:
                decision['intensity_mode'] = mode
            self.write(state)
            return self.clip_listing(folder, clip) if compact else self.scan(folder)

    def selected_entries(self, folder, clip_ids):
        if not isinstance(clip_ids, list) or not clip_ids or len(clip_ids) > 1000 or any(not isinstance(i, str) or not re.fullmatch(r'[a-f0-9]{32}', i) for i in clip_ids):
            raise ValueError('Select between 1 and 1000 clips.')
        entries = {e['id']: e for e in self.scan(folder)['entries']}
        if set(clip_ids) - entries.keys():
            raise PlanConflict('A selected video moved or changed. Refresh the library.')
        return [entries[i] for i in dict.fromkeys(clip_ids)]

    def review_audio_sync(self, folder, clip_ids, audio_sync):
        """Update only the review label for an explicit snapshot of selected clips."""
        if type(audio_sync) is not bool:
            raise ValueError('Audio sync must be checked or unchecked.')
        if not isinstance(clip_ids, list) or not clip_ids or any(not isinstance(clip, str) or not re.fullmatch(r'[a-f0-9]{32}', clip) for clip in clip_ids):
            raise ValueError('Select at least one valid clip for bulk Audio sync.')
        chosen = set(clip_ids)
        with LOCK:
            listing = self.scan(folder)
            entries = {entry['id']: entry for entry in listing['entries']}
            if not chosen <= entries.keys():
                raise PlanConflict('A selected video moved or changed. Refresh the folder and try again; no labels were changed.')
            state = self.read(folder)
            updated = 0
            for clip in chosen:
                if entries[clip]['audio_sync'] == audio_sync: continue
                state['decisions'].setdefault(clip, {}).update(audio_sync=audio_sync, updated=datetime.now(timezone.utc).isoformat())
                entries[clip]['audio_sync'] = audio_sync
                updated += 1
            if updated: self.write(state)
            return dict(listing=listing, matched=len(chosen), updated=updated)

    def ignore(self, folder, clip, ignored=True, note='', *, compact=False):
        if not isinstance(ignored, bool) or not isinstance(note, str) or len(note) > 2000:
            raise ValueError('Use a short text note for the ignored video.')
        with LOCK:
            entry,_=self.entry(folder, clip)
            with editing_session(entry['timeline']): pass
            state = self.read(folder)
            if state.get('kind') == 'h3':
                from .h3_project import exclude
                exclude(state['root'], video=entry['name'], excluded=ignored)
                return self.scan(folder)
            decision = state['decisions'].setdefault(clip, {})
            if ignored:
                if decision.get('status') != 'ignored': decision['before_ignore'] = decision.get('status')
                decision.update(status='ignored', note=note, updated=datetime.now(timezone.utc).isoformat())
            elif decision.get('status') == 'ignored':
                decision['status'] = decision.pop('before_ignore', None)
            self.write(state)
            return self.clip_listing(folder, clip) if compact else self.scan(folder)

    def h3_confidence(self, folder, confidence):
        from .h3_project import set_confidence
        with LOCK:
            state = self.read(folder)
            if state.get('kind') != 'h3': raise ValueError('Open an H3 Animator project first.')
            set_confidence(state['root'], confidence)
            return self.scan(folder)

    def h3_preset(self, folder, *, page=None, panel=None, settings=None):
        from .h3_project import preset
        with LOCK:
            state = self.read(folder)
            if state.get('kind') != 'h3': raise ValueError('Open an H3 Animator project first.')
            if settings is not None and folder in BATCH_RUNNING: raise PlanConflict('Pause the batch before changing processing presets.')
            return preset(state['root'], page=page, panel=panel, settings=settings)

    def h3_portable_draft(self, folder, clip, revision, *, restore=False):
        from .h3_project import draft_path, video_digest, export_scripts
        with LOCK, EDITOR_LOCK:
            entry, video = self.entry(folder, clip)
            with editing_session(entry['editor_session']):
                state = self.read(folder)
                if state.get('kind') != 'h3': raise ValueError('Open an H3 Animator project first.')
                editor = self.editors.read(entry['editor_session'])
                if not editor or editor['revision'] != revision: raise PlanConflict('Save the latest Main curves before managing a portable draft.')
                project = copy.deepcopy(editor['project'])
                path = draft_path(state['root'], entry['h3'])
                identity = {key:entry['h3'][key] for key in ('panel_id','take','variant')}
                if not restore:
                    scripts = export_scripts(project['scripts'], project['metadata']['duration_ms'])
                    payload = dict(version=1, identity=identity, video_sha256=video_digest(video), scripts=scripts,
                        axis_settings=project['config']['axis_settings'], enabled_axes=project['config']['enabled_axes'],
                        review={key:entry[key] for key in ('quality','note','audio_sync','intensity','intensity_mode','tags')})
                    path.parent.mkdir(parents=True, exist_ok=True); atomic_json(path, payload)
                else:
                    if not path.is_file(): raise ValueError('No portable draft is saved for this take.')
                    if path.stat().st_size > 64*1024*1024: raise ValueError('Portable draft exceeds 64 MB.')
                    payload = json.loads(path.read_text(encoding='utf-8'))
                    if payload.get('version') != 1 or payload.get('identity') != identity or payload.get('video_sha256') != video_digest(video):
                        raise PlanConflict('This portable draft belongs to different video content. The current curves were kept.')
                    scripts = export_scripts(payload['scripts'], project['metadata']['duration_ms'])
                    review = payload['review']
                    if (type(review.get('quality')) is not int or not 0 <= review['quality'] <= 5
                            or not isinstance(review.get('note'),str) or len(review['note'])>2000
                            or type(review.get('audio_sync')) is not bool
                            or type(review.get('intensity')) is not int or not 0 <= review['intensity'] <= 5
                            or review.get('intensity_mode') not in ('auto','manual')):
                        raise ValueError('Invalid portable review fields.')
                    tags = normalize_tags(review.get('tags',[]))
                    if set(scripts)-set(SUFFIXES) or set(payload['enabled_axes'])-set(scripts): raise ValueError('Invalid portable script axes.')
                    for axis,script in scripts.items():
                        if project['timeline']['main'][axis].get('locked'): raise PlanConflict('Unlock Main before restoring a portable draft.')
                        project['scripts'][axis] = script
                        project['config']['axis_settings'][axis] = payload['axis_settings'][axis]
                        project['timeline']['main'][axis].update(edited=True,assembled=True,processing_generated=False,regions=[])
                    project['config']['enabled_axes'] = payload['enabled_axes']
                    validate(project)
                    self.save_version(folder,clip,'Before restoring portable draft',revision=revision)
                    self.editors.save(entry['editor_session'], project, revision)
                    decision = state['decisions'].setdefault(clip,{})
                    decision.update({key:review[key] for key in ('quality','note','audio_sync','intensity','intensity_mode')})
                    edit_tags(decision,tags); decision['batch_result']='ready'; self.write(state)
                return dict(path=str(path), listing=self.scan(folder))

    def h3_skip_waiting(self, folder, clip):
        with LOCK:
            state = self.read(folder)
            if state.get('kind') != 'h3': raise ValueError('Open an H3 Animator project first.')
            batch = state.get('batch') or {}
            if clip == batch.get('current_id'): raise PlanConflict('This clip is already processing. Pause after it finishes.')
            if clip not in {e['id'] for e in batch.get('items', [])}: raise ValueError('This clip is not in the batch.')
            control = state.setdefault('batch_control', {})
            control['skip_ids'] = list(set(control.get('skip_ids', [])) | {clip})
            self.write(state)
            return self.scan(folder)

    def exclude_h3_page(self, folder, page, excluded, *, panel=None):
        from .h3_project import exclude
        with LOCK:
            state = self.read(folder)
            if state.get('kind') != 'h3': raise ValueError('Open an H3 Animator project first.')
            entries = self.scan(folder)['entries']
            if any((panel in e['h3']['source_panel_ids'] if panel else page in e['h3']['source_page_ids']) and e['processing'] for e in entries):
                raise PlanConflict('Wait for this page’s active clip to finish before excluding it.')
            exclude(state['root'], page=page, panel=panel, excluded=excluded)
            return self.scan(folder)

    def approve(self, folder, clip, revision, replace=False, expected=None, *, compact=False):
        if type(revision) is not int:
            raise ValueError('Open Motion Studio and save its edits before approving this video.')
        # Keep reruns, plan saves and editor saves out of the export transaction.
        with LOCK, PLAN_LOCK, EDITOR_LOCK:
            entry, video = self.entry(folder, clip)
            with editing_session(entry['timeline']): pass
            if entry['status'] == 'ignored':
                raise PlanConflict('Restore this ignored video before approving it.')
            versions = self.script_versions(video)
            if versions and (replace is not True or expected != versions):
                raise PlanConflict('Matching scripts exist or changed. Reopen this clip, review it, then choose Approve & replace scripts.')
            if expected is not None and expected != versions:
                raise PlanConflict('The scripts changed since this clip was opened. Reopen it before approving.')
            editor = self.editors.read(entry['editor_session'])
            if not editor or editor['revision'] != revision:
                raise PlanConflict('Motion Studio changed. Review the latest saved curves before approving.')
            project = editor['project']; source = fingerprint(video)
            if not same_video(project, {'metadata': {'source': source}}):
                raise PlanConflict('The video changed since processing. Refresh the folder and process it again.')
            validate(project)
            plan = self.plans.read(entry['timeline'])
            progress = (plan or {}).get('progress') or {}
            if progress.get('stage') not in (None, 'complete', 'error'):
                raise PlanConflict('This video is still processing. Wait for its result before approving.')
            scripts = project['scripts']
            if self.read(folder).get('kind') == 'h3':
                from .h3_project import export_scripts
                scripts = export_scripts(scripts, plan['info']['end_ms'])
            contents = {}
            for axis, script in scripts.items():
                validate_actions(script['actions'])
                contents[video.with_name(video.stem + SUFFIXES[axis] + '.funscript')] = json.dumps(script, allow_nan=False, separators=(',', ':')).encode()
            created = []
            backups = {}
            try:
                if versions:
                    backup = video.parent / '.s3f-backups' / (datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S') + '-' + uuid.uuid4().hex[:8])
                    backup.mkdir(parents=True)
                    for name, expected_hash in versions.items():
                        path = video.parent / name
                        data = path.read_bytes()
                        if path.is_symlink() or hashlib.sha256(data).hexdigest() != expected_hash:
                            raise PlanConflict('A script changed during approval. Reopen the clip before replacing it.')
                        saved = backup / path.name
                        with saved.open('xb') as output:
                            output.write(data); output.flush(); os.fsync(output.fileno())
                        backups[path] = saved
                for path, data in contents.items():
                    if path in backups:
                        temporary = path.with_name('.' + path.name + '.' + uuid.uuid4().hex + '.tmp')
                        try:
                            with temporary.open('xb') as output:
                                output.write(data); output.flush(); os.fsync(output.fileno())
                            if path.is_symlink() or hashlib.sha256(path.read_bytes()).hexdigest() != versions[path.name]:
                                raise PlanConflict('A script changed during approval. Reopen the clip before replacing it.')
                            os.replace(temporary, path); created.append(path)
                        finally:
                            temporary.unlink(missing_ok=True)
                    else:
                        with path.open('xb') as output:
                            created.append(path); output.write(data); output.flush(); os.fsync(output.fileno())
                # An approval replaces the reviewed axis set, including axes
                # removed from Main. Back them up and roll them back on failure.
                for path in backups:
                    if path not in contents:
                        if path.is_symlink() or hashlib.sha256(path.read_bytes()).hexdigest() != versions[path.name]:
                            raise PlanConflict('A script changed during approval. Reopen the clip before replacing it.')
                        path.unlink(); created.append(path)
                state = self.read(folder)
                state['decisions'].setdefault(clip, {}).update(status='approved', files=[p.name for p in contents], editor_revision=revision,
                    updated=datetime.now(timezone.utc).isoformat())
                decision=state['decisions'][clip]
                if decision.get('intensity_mode', 'manual' if decision.get('intensity') else 'auto') == 'auto':
                    decision['intensity_mode'] = 'auto'
                    decision['intensity'] = self.intensity_estimate(folder, clip)['level']
                self.save_version(folder,clip,'Approved '+datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M'),
                    quality=decision.get('quality',0),note=decision.get('note',''),project=project)
                self.write(state)
            except Exception:
                for path in created:
                    if path in backups: os.replace(backups[path], path)
                    else: path.unlink(missing_ok=True)
                raise
            return dict(files=[str(p) for p in contents], backups=[str(p) for p in backups.values()],
                        script_versions=self.script_versions(video),
                        listing=self.clip_listing(folder, clip) if compact else self.scan(folder))

    def batch_entries(self, folder, subfolder='', retry_failed=False, clip_ids=None, *, reprocess=False):
        prefix = subfolder_name(subfolder)
        entries=self.scan(folder)['entries']
        if clip_ids is not None:
            if not isinstance(clip_ids,list) or not clip_ids or len(clip_ids)>1000 or any(not isinstance(i,str) for i in clip_ids):
                raise ValueError('Select at least one video to process.')
            if set(clip_ids)-{e['id'] for e in entries}:raise PlanConflict('A selected video moved or changed. Refresh the library.')
        if reprocess and clip_ids is None: raise ValueError('Select explicit clips to reprocess.')
        return [e for e in entries if (e['status'] != 'ignored' if reprocess else e['status'] == 'pending') and (clip_ids is None or e['id'] in clip_ids)
                   and not e.get('civitai_set_aside')
                   and (clip_ids is not None or e.get('h3', {}).get('main', True))
                   and e.get('h3', {}).get('render_mode') != 'still'
                   and not e.get('h3', {}).get('selection_error')
                   and (not prefix or e['name'].startswith(prefix + '/')) and (reprocess or e.get('batch_result') != 'ready')
                   and (not retry_failed or e.get('batch_result')=='error')]

    def needs_tracker(self, folder, subfolder='', retry_failed=False, clip_ids=None, *, reprocess=False):
        return any((self.plans.read(e['timeline']) or {}).get('plan',{}).get('stabilization')
                   for e in self.batch_entries(folder,subfolder,retry_failed,clip_ids,reprocess=reprocess))

    def process_batch(self, folder, subfolder, process, interrupt=lambda: None, interrupt_errors=(), progress=lambda event: None, *, retry_failed=False, clip_ids=None, reprocess=False):
        """Serial inference through the caller's ComfyUI job; no approval/export."""
        prefix = subfolder_name(subfolder)
        entries = self.batch_entries(folder,prefix,retry_failed,clip_ids,reprocess=reprocess)
        with LOCK:
            if folder in BATCH_RUNNING:raise PlanConflict('This folder already has a running batch.')
            BATCH_RUNNING.add(folder)
            state=self.read(folder);state['batch_control']={};self.write(state)
        report = dict(stage='running', subfolder=prefix, total=len(entries), completed=[], failed=[], skipped=[], deferred=[], current=None,current_id=None)
        report['items'] = [dict(id=e['id'], name=e['name'], label=e.get('h3', {}).get('label', e['name'])) for e in entries]
        started=time.monotonic();durations=[]
        def publish():
            report['elapsed_seconds']=round(time.monotonic()-started,1)
            remaining=report['total']-sum(len(report[key]) for key in ('completed','failed','skipped','deferred'))
            report['eta_seconds']=round(sum(durations)/len(durations)*remaining) if durations else None
            with LOCK:
                state = self.read(folder); state['batch'] = copy.deepcopy(report); self.write(state)
            progress(copy.deepcopy(report))
        try:
            publish()
            for entry in entries:
                interrupt()
                with LOCK:
                    if self.read(folder).get('batch_control',{}).get('pause'):
                        report['stage']='paused';break
                    if entry['id'] in self.read(folder).get('batch_control', {}).get('skip_ids', []):
                        report['skipped'].append(entry['name']); publish(); continue
                    # A deleted or retired take must not abandon independent work.
                    if not Path(self.read(folder)['root']).is_dir():
                        raise OSError('The project folder is unavailable. Restore the drive before resuming.')
                    try:
                        state = self.read(folder)
                        if state.get('kind') == 'h3':
                            from .h3_project import catalogue
                            catalogue(state['root'], refresh=True)
                        current, _ = self.entry(folder, entry['id'])
                    except PlanConflict as error:
                        report['skipped'].append(entry['name'])
                        report.setdefault('skip_reasons', {})[entry['name']] = str(error)
                        publish(); continue
                    if current['status'] == 'ignored' or current.get('civitai_set_aside') or (not reprocess and (current['status'] != 'pending' or current.get('batch_result') == 'ready')):
                        report['skipped'].append(entry['name']); publish(); continue
                    if any(key[0]==folder and value[0]==entry['id'] and value[1]>time.monotonic() for key,value in REVIEW_LEASES.items()):
                        report['deferred'].append(entry['name']);publish();continue
                    ACTIVE[entry['timeline']]=ACTIVE[entry['editor_session']]=threading.get_ident()
                report.update(current=entry['name'],current_id=entry['id']);publish();clip_started=time.monotonic()
                try:
                    process(entry)
                except BaseException as error:
                    if isinstance(error, interrupt_errors) or not isinstance(error, Exception): raise
                    result, message = 'error', str(error)
                    report['failed'].append(dict(name=entry['name'], error=message))
                else:
                    result, message = 'ready', None
                    report['completed'].append(entry['name'])
                finally:
                    with LOCK:
                        ACTIVE.pop(entry['timeline'],None);ACTIVE.pop(entry['editor_session'],None)
                durations.append(time.monotonic()-clip_started)
                with LOCK:
                    state = self.read(folder)
                    state['decisions'].setdefault(entry['id'], {}).update(batch_result=result, error=message)
                    self.write(state)
                report.update(current=None,current_id=None)
                publish()
        except BaseException:
            report['stage'] = 'stopped'; publish(); raise
        finally:
            with LOCK:
                BATCH_RUNNING.discard(folder)
                for entry in entries:
                    for key in (entry['timeline'],entry['editor_session']):
                        if ACTIVE.get(key)==threading.get_ident():ACTIVE.pop(key,None)
        report.update(stage='paused' if report['stage']=='paused' else 'complete',current=None,current_id=None);publish()
        return report
