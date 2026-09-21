"""Persistent clip selection; downloads and inference run in ComfyUI's executor."""
import copy
import re
import threading
import time
import uuid

from .folder_store import LOCK, ACTIVE, BATCH_RUNNING, REVIEW_LEASES, FolderStore
from .processing_store import PlanConflict

RUNTIME = uuid.uuid4().hex
IN_FLIGHT = {'downloading', 'processing'}
RETRYABLE = {'error', 'deferred', 'interrupted'}


class FolderQueue:
    def __init__(self, root):
        self.folders = FolderStore(root)

    def _state(self, folder):
        state = self.folders.read(folder)
        queue = state.setdefault('processing_queue', {'stage': 'idle', 'items': []})
        changed=False
        for item in queue['items']:
            decision=state.get('decisions',{}).get(item.get('clip'),{})
            managed=state.get('civitai',{}).get(item.get('clip'))
            if managed and managed['name']!=item['name']:
                item['name']=managed['name'];changed=True
            if decision.get('status')=='approved' and item['state']=='ready':
                item.update(state='approved',note='Approved video and funscripts saved.');changed=True
            if decision.get('status')=='ignored' and item['state'] not in IN_FLIGHT and item['state']!='skipped':
                item.update(state='skipped',note='Rejected or ignored during review.',error=None);changed=True
        if queue.get('runtime') != RUNTIME and queue['stage'] in ('queued', 'running'):
            queue.update(stage='interrupted', pause=False)
            for item in queue['items']:
                if item['state'] in IN_FLIGHT:
                    item.update(state='interrupted', error='ComfyUI stopped. Retry this clip to continue.')
            self.folders.write(state)
        elif changed:self.folders.write(state)
        return state, queue

    def read(self, folder):
        with LOCK:
            _, queue = self._state(folder)
            return copy.deepcopy(queue)

    def change(self, folder, action, body):
        from .civitai_library import CivitaiLibrary, video_id, category_name, SITES
        with LOCK:
            state, queue = self._state(folder)
            items = queue['items']
            if action == 'add':
                rows = body.get('items')
                if not isinstance(rows, list) or not rows or any(not isinstance(row, dict) for row in rows):
                    raise ValueError('Select clips to add to the queue.')
                # Validate the entire selection before saving any additions.
                library = CivitaiLibrary(self.folders.root).catalogue(folder)
                additions = []
                for row in rows:
                    identifier = video_id(row.get('id', ''))
                    category = category_name(row['category']) if row.get('category') else ''
                    site = row.get('site', 'civitai.red')
                    if site not in SITES:raise ValueError('Invalid Civitai site.')
                    copies = library['items'].get(identifier, [])
                    clip = row.get('clip')
                    entry = next((e for e in copies if e['id'] == clip), None) if clip else (copies[0] if copies else None)
                    if clip and entry is None:raise PlanConflict('A selected local copy changed. Refresh the browser.')
                    if identifier in library['ignored'] or entry and entry['status'] == 'ignored':
                        raise ValueError('Restore ignored clips before adding them to the queue.')
                    if any(item['id'] == identifier for item in items + additions):continue
                    ready = bool(entry and entry['processed'])
                    additions.append(dict(key=uuid.uuid4().hex, id=identifier, clip=entry['id'] if entry else None,
                        name=entry['name'] if entry else str(row.get('name') or 'Civitai '+identifier)[:200],
                        category=category, site=site, state='approved' if entry and entry['status']=='approved' else 'ready' if ready else 'waiting', error=None,
                        note='Existing funscript or draft kept.' if ready else '', added_at=time.time()))
                # Catalogue recovery may update the folder state; preserve those changes.
                state, queue = self._state(folder)
                queue['items'].extend(additions)
                if queue['stage']=='complete' and any(item['state']=='waiting' for item in additions):queue['stage']='idle'
            elif action == 'pause':
                queue['pause'] = True
                if queue['stage'] != 'running':queue['stage'] = 'paused'
            elif action == 'clear_finished':
                queue['items'] = [item for item in items if item['state'] not in ('ready', 'approved', 'skipped')]
            elif action in ('remove', 'retry', 'first'):
                item = next((item for item in items if item['key'] == body.get('key')), None)
                if item is None:raise ValueError('This clip is no longer in the queue.')
                if item['state'] in IN_FLIGHT:raise PlanConflict('This clip is active. Pause after it finishes.')
                if action == 'remove':items.remove(item)
                elif action == 'retry':
                    if item['state'] not in RETRYABLE:raise ValueError('Only failed or interrupted clips need retrying.')
                    item.update(state='waiting', error=None, note='')
                else:
                    if item['state'] != 'waiting':raise ValueError('Only waiting clips can move to the front.')
                    items.remove(item);items.insert(0, item)
            else:raise ValueError('Unknown queue action.')
            self.folders.write(state)
            return copy.deepcopy(queue)

    def start(self, folder):
        with LOCK:
            state, queue = self._state(folder)
            if folder in BATCH_RUNNING or queue['stage'] in ('queued', 'running'):
                raise PlanConflict('This folder already has a queued or running job.')
            if not any(item['state'] == 'waiting' for item in queue['items']):
                raise ValueError('Add clips or retry a failed clip before starting.')
            queue.update(stage='queued', runtime=RUNTIME, ticket=uuid.uuid4().hex, pause=False, error=None)
            state['batch']=self.report(queue)
            self.folders.write(state)
            return copy.deepcopy(queue)

    def failed_start(self, folder, ticket, message):
        with LOCK:
            state, queue = self._state(folder)
            if queue.get('ticket') == ticket and queue['stage'] == 'queued':
                queue.update(stage='interrupted', error=message)
                self.folders.write(state)
            return copy.deepcopy(queue)

    def run(self, folder, ticket, process, interrupt=lambda: None, interrupt_errors=(), progress=lambda report: None):
        from .civitai_library import CivitaiLibrary
        if not isinstance(ticket, str) or not re.fullmatch(r'[a-f0-9]{32}', ticket):raise ValueError('Invalid queue run.')
        library = CivitaiLibrary(self.folders.root)
        with LOCK:
            state, queue = self._state(folder)
            if queue.get('ticket') != ticket:raise PlanConflict('This queue run was replaced. Refresh its status.')
            if queue['stage'] != 'queued':return self.report(queue)
            if folder in BATCH_RUNNING:raise PlanConflict('This folder is already processing.')
            BATCH_RUNNING.add(folder);queue['stage'] = 'running';self.folders.write(state)
        current = None

        def update(**values):
            with LOCK:
                state, queue = self._state(folder)
                item = next(row for row in queue['items'] if row['key'] == current['key'])
                item.update(values);self.folders.write(state)
                report = self.report(queue)
            progress(report)

        try:
            while True:
                interrupt()
                with LOCK:
                    state, queue = self._state(folder)
                    current = next((item for item in queue['items'] if item['state'] == 'waiting'), None)
                    if queue.get('pause') or current is None:
                        queue['stage'] = 'paused' if queue.get('pause') else 'complete'
                        self.folders.write(state);break
                    current = copy.deepcopy(current)
                    update(state='downloading' if not current['clip'] else 'processing')
                entry = None
                try:
                    if current['id'] in library.settings(folder)['ignored']:
                        update(state='skipped',note='Clip is ignored.');continue
                    if current['clip']:
                        entry, _ = self.folders.entry(folder, current['clip'])
                    else:
                        entry = library.download(folder, current['id'], current['category'], current['site'])['entry']
                    update(clip=entry['id'], name=entry['name'])
                    interrupt()
                    with LOCK:
                        entry, _ = self.folders.entry(folder, entry['id'])
                        plan = self.folders.plans.read(entry['timeline']) if entry['draft'] else None
                        if entry['status'] == 'ignored':
                            update(state='skipped', note='Clip is ignored.');continue
                        if entry['existing'] or entry['batch_result'] == 'ready' or plan and plan.get('project_path') and not plan.get('editor_only'):
                            update(state='ready', note='Existing funscript or draft kept.');continue
                        if any(key[0] == folder and lease[0] == entry['id'] and lease[1] > time.monotonic() for key, lease in REVIEW_LEASES.items()):
                            update(state='deferred', error='Open for review. Close this clip, then retry it.');continue
                        ACTIVE[entry['timeline']] = ACTIVE[entry['editor_session']] = threading.get_ident()
                    update(state='processing')
                    process(entry)
                except BaseException as error:
                    if isinstance(error, interrupt_errors) or not isinstance(error, Exception):raise
                    update(state='error', error=str(error))
                    if entry:
                        with LOCK:
                            state = self.folders.read(folder)
                            state['decisions'].setdefault(entry['id'], {}).update(batch_result='error', error=str(error))
                            self.folders.write(state)
                else:
                    with LOCK:
                        state = self.folders.read(folder)
                        state['decisions'].setdefault(entry['id'], {}).update(batch_result='ready', error=None)
                        self.folders.write(state)
                    update(state='ready', error=None, note='Draft funscript ready for review.')
                finally:
                    if entry:
                        with LOCK:
                            for key in (entry['timeline'], entry['editor_session']):
                                if ACTIVE.get(key) == threading.get_ident():ACTIVE.pop(key, None)
        except BaseException:
            with LOCK:
                state, queue = self._state(folder)
                queue['stage'] = 'interrupted'
                for item in queue['items']:
                    if item['state'] in IN_FLIGHT:item.update(state='interrupted', error='Processing stopped. Retry this clip to continue.')
                self.folders.write(state)
            raise
        finally:
            with LOCK:BATCH_RUNNING.discard(folder)
            progress(self.report(self.read(folder)))
        return self.report(self.read(folder))

    @staticmethod
    def report(queue):
        items = queue['items'];active = next((item for item in items if item['state'] in IN_FLIGHT), None)
        return dict(stage=queue['stage'], queue=True, total=len(items), current=active['name'] if active else None,
            current_id=active['clip'] if active else None, completed=[i['name'] for i in items if i['state'] in ('ready','approved')],
            failed=[dict(name=i['name'], error=i['error']) for i in items if i['state'] in ('error', 'interrupted')],
            skipped=[i['name'] for i in items if i['state'] == 'skipped'], deferred=[i['name'] for i in items if i['state'] == 'deferred'])
