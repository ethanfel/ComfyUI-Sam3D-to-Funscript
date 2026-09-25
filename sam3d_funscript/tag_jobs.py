"""Background, per-folder tagging jobs; finished labels survive browser closure."""
import copy
import math
import threading
from pathlib import Path
from datetime import datetime, timezone

from .clip_tags import MODEL, MODEL_REVISION, MODEL_LOCK, ImageTagger, civitai_tags, local_tags, normalize_tags
from .folder_store import FolderStore, LOCK
from .processing_store import PlanConflict

RUNNING = set()


def needed_sources(decision, entry, job):
    from .civitai_library import ID_PATTERN
    match = ID_PATTERN.search(Path(entry['name']).name)
    identifier = str(entry.get('civitai_id') or (match.group(1) if match else ''))
    requested = {}
    if job['source'] != 'local' and (identifier or job['source'] == 'civitai'):
        requested['civitai'] = dict(id=identifier, site=job['site'])
    if job['source'] != 'civitai':
        requested['local'] = dict(model=MODEL, revision=MODEL_REVISION, frames=job['frames'], threshold=job['threshold'])
    if job.get('force'):
        return requested
    analysis = decision.get('tag_analysis', {})
    saved = analysis.get('sources', {})
    needed = {}
    for source, settings in requested.items():
        if source in saved:
            current = source in decision.get('tag_sources', {}) and saved[source] == settings
        else:
            # The first tagger saved one analysis record. Reuse those completed
            # results instead of making everyone repeat the initial tagging run.
            current = source in decision.get('tag_sources', {}) and bool(analysis.get('updated'))
            if source == 'local':
                # The original format used this pinned model but omitted its revision.
                revision = analysis.get('revision', '627aef95638667ddcaa3ac8ae625e88ea5b02f51')
                current = current and analysis.get('model') == MODEL and revision == MODEL_REVISION and analysis.get('frames') == job['frames'] and analysis.get('threshold') == job['threshold']
        if not current:
            needed[source] = settings
    return needed


class TagJobs:
    def __init__(self, root):
        self.store = FolderStore(root)

    def read(self, folder):
        with LOCK:
            job = copy.deepcopy(self.store.read(folder).get('tag_job', {'stage': 'idle', 'completed': 0, 'total': 0, 'errors': []}))
            if job['stage'] in ('running', 'stopping') and (str(self.store.root), folder) not in RUNNING:
                job['stage'] = 'interrupted'
            return {**job, 'incremental': True}

    def start(self, folder, clip_ids, source='both', frames=1, threshold=.35, site='civitai.red', force=False):
        from .civitai_library import SITES
        if source not in ('both', 'civitai', 'local') or type(frames) is not int or frames not in (1, 3):
            raise ValueError('Choose Civitai, local or both, and one or three frames.')
        if type(threshold) not in (int, float) or not math.isfinite(threshold) or not 0.05 <= threshold <= .95 or site not in SITES:
            raise ValueError('Choose a threshold from 0.05 to 0.95 and a supported Civitai site.')
        if type(force) is not bool:
            raise ValueError('Retag all must be true or false.')
        with LOCK:
            key = (str(self.store.root), folder)
            if key in RUNNING: raise PlanConflict('A tagging job is already running for this folder.')
            entries = self.store.selected_entries(folder, clip_ids)
            job = dict(stage='running', completed=0, total=0, selected=len(entries), skipped=0, current=None, errors=[],
                       source=source, frames=frames, threshold=threshold, site=site, force=force,
                       started_at=datetime.now(timezone.utc).isoformat())
            state = self.store.read(folder)
            entries = [entry for entry in entries if needed_sources(state['decisions'].get(entry['id'], {}), entry, job)]
            job['total'] = len(entries)
            job['skipped'] = job['selected'] - job['total']
            if not entries:
                job['stage'] = 'complete'
            state['tag_job'] = job; self.store.write(state)
            if not entries:
                return self.read(folder)
            RUNNING.add(key)
            try:
                threading.Thread(target=self.run, args=(folder, entries, copy.deepcopy(job)), daemon=True, name='s3f-tags').start()
            except Exception:
                RUNNING.discard(key)
                job['stage'] = 'error'; state['tag_job'] = job; self.store.write(state)
                raise
            return {**copy.deepcopy(job), 'incremental': True}

    def stop(self, folder):
        with LOCK:
            state = self.store.read(folder)
            if (str(self.store.root), folder) in RUNNING:
                state['tag_job']['stage'] = 'stopping'; self.store.write(state)
        return self.read(folder)

    def run(self, folder, entries, job):
        from .civitai_library import CivitaiLibrary
        if job['stage'] != 'running': return
        tagger, model_error = None, None
        def publish():
            with LOCK:
                state = self.store.read(folder)
                stopping = state.get('tag_job', {}).get('stage') == 'stopping'
                if stopping and job['stage'] == 'running': job['stage'] = 'stopping'
                state['tag_job'] = copy.deepcopy(job); self.store.write(state)
                return stopping
        try:
            for entry in entries:
                if publish(): break
                job['current'] = entry['name']; publish()
                try:
                    _, path = self.store.entry(folder, entry['id'])
                    decision = self.store.read(folder)['decisions'].get(entry['id'], {})
                    pending = needed_sources(decision, entry, job)
                    suggestions = {}
                    for source, settings in pending.items():
                        try:
                            if source == 'civitai':
                                if not settings['id']:
                                    raise ValueError('No Civitai ID in this clip’s filename or download record.')
                                tags = civitai_tags(settings['id'], job['site'], CivitaiLibrary(self.store.root).token())
                            else:
                                if model_error: raise model_error
                                if tagger is None:
                                    try:
                                        with MODEL_LOCK: tagger = ImageTagger()
                                    except Exception as error:
                                        model_error = error
                                        raise
                                with MODEL_LOCK: tags = local_tags(tagger, path, job['frames'], job['threshold'])
                            suggestions[source] = normalize_tags(tags)
                        except Exception as error:
                            job['errors'].append(dict(name=entry['name'], error=str(error), source=source))
                    with LOCK:
                        self.store.entry(folder, entry['id'])  # Refuse results for a replaced video.
                        state = self.store.read(folder); decision = state['decisions'].setdefault(entry['id'], {})
                        analysis = decision.setdefault('tag_analysis', {})
                        for source, settings in pending.items():
                            analysis.setdefault('sources', {})[source] = settings if source in suggestions else None
                            if source in suggestions:
                                decision.setdefault('tag_sources', {})[source] = suggestions[source]
                        if 'local' in suggestions:
                            analysis.update(model=MODEL, revision=MODEL_REVISION, frames=job['frames'], threshold=job['threshold'])
                        analysis['updated'] = datetime.now(timezone.utc).isoformat()
                        self.store.write(state)
                except Exception as error: job['errors'].append(dict(name=entry['name'], error=str(error)))
                job['completed'] += 1
            job['stage'] = 'stopped' if job['stage'] == 'stopping' else 'complete'
        except Exception as error:
            job['stage'] = 'error'; job['errors'].append(dict(name=job['current'] or '', error=str(error)))
        finally:
            job['current'] = None
            with LOCK:
                try: publish()
                finally: RUNNING.discard((str(self.store.root), folder))
