"""Shared public video metadata, independent of downloads and processing state."""
import json
import threading
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote, urlencode

from .reference import atomic_json

LOCK = threading.RLock()
RUNNING = set()
PUBLIC_FIELDS = ('creator_username', 'post_id', 'civitai_metadata')
DETAIL_FIELDS = ('created_at', 'width', 'height', 'base_model', 'model_version_ids', 'content_rating', 'stats', 'site', 'fetched_at')


def from_api(raw, site):
    from .civitai_library import SITES, video_id
    if site not in SITES: raise ValueError('Choose a supported Civitai site.')
    metadata = dict(id=video_id(raw['id']), site=site, fetched_at=datetime.now(timezone.utc).isoformat())
    for key, source in [('creator_username', 'username'), ('created_at', 'createdAt'), ('base_model', 'baseModel'), ('content_rating', 'nsfwLevel')]:
        value = raw.get(source)
        if isinstance(value, str) and value.strip() and len(value) <= 200:
            metadata[key] = value.strip()
    try: metadata['post_id'] = video_id(raw.get('postId'))
    except ValueError: pass
    for key in ('width', 'height'):
        if type(raw.get(key)) is int and 0 < raw[key] <= 100000: metadata[key] = raw[key]
    if type(raw.get('nsfwLevel')) is int and raw['nsfwLevel'] >= 0:
        metadata['content_rating'] = str(raw['nsfwLevel'])
    if isinstance(raw.get('modelVersionIds'), list):
        ids = []
        for value in raw['modelVersionIds']:
            try: ids.append(video_id(value))
            except ValueError: pass
        metadata['model_version_ids'] = sorted(set(ids))
    if isinstance(raw.get('stats'), dict):
        metadata['stats'] = {key: value for key, value in raw['stats'].items()
                             if key in ('cryCount', 'laughCount', 'likeCount', 'dislikeCount', 'heartCount', 'commentCount', 'collectedCount')
                             and type(value) is int and value >= 0}
    return metadata


def public_fields(metadata):
    metadata = metadata or {}
    details = {key: metadata[key] for key in DETAIL_FIELDS if key in metadata}
    identifier, site = metadata.get('id'), metadata.get('site')
    creator, post = metadata.get('creator_username'), metadata.get('post_id')
    if identifier and site:
        details['video_url'] = f'https://{site}/images/{identifier}'
        if post: details['post_url'] = f'https://{site}/posts/{post}'
        if creator: details['creator_url'] = f'https://{site}/user/{quote(creator, safe="")}/images'
    return dict(creator_username=creator, post_id=post, civitai_metadata=details)


def merge_fields(left, right):
    """Prefer the newest observed source data, retaining fields it omitted."""
    if (left.get('civitai_metadata') or {}).get('fetched_at', '') > (right.get('civitai_metadata') or {}).get('fetched_at', ''):
        left, right = right, left
    return dict(creator_username=right.get('creator_username') or left.get('creator_username'),
                post_id=right.get('post_id') or left.get('post_id'),
                civitai_metadata={**(left.get('civitai_metadata') or {}), **(right.get('civitai_metadata') or {})})


class CivitaiMetadata:
    def __init__(self, root):
        self.root = Path(root)
        self.path = self.root / 'civitai' / 'video-metadata.json'

    def read(self):
        with LOCK:
            return json.loads(self.path.read_text()) if self.path.is_file() else {}

    def save(self, records):
        if not records: return
        with LOCK:
            saved = self.read()
            for record in records:
                metadata = record.get('metadata')
                if not metadata: continue
                identifier = record['id']; old = saved.get(identifier, {})
                saved[identifier] = {**old, **metadata} if metadata['fetched_at'] >= old.get('fetched_at', '') else {**metadata, **old}
            self.path.parent.mkdir(parents=True, exist_ok=True)
            atomic_json(self.path, saved)

    def job_path(self, folder):
        from .folder_store import FolderStore
        FolderStore(self.root).path(folder)
        return self.root / 'civitai' / 'metadata-jobs' / (folder + '.json')

    def status(self, folder):
        with LOCK:
            path = self.job_path(folder)
            job = json.loads(path.read_text()) if path.is_file() else dict(stage='idle', completed=0, total=0, errors=[])
            if job['stage'] in ('running', 'stopping') and (str(self.root), folder) not in RUNNING:
                job['stage'] = 'interrupted'
            return job

    def publish(self, folder, job):
        path = self.job_path(folder); path.parent.mkdir(parents=True, exist_ok=True)
        atomic_json(path, job)

    def start(self, folder, identifiers, site, token, force=False):
        from .civitai_library import SITES, video_id
        from .processing_store import PlanConflict
        if site not in SITES or type(force) is not bool: raise ValueError('Choose a supported site and refresh mode.')
        identifiers = sorted({video_id(value) for value in identifiers})
        with LOCK:
            if any(root == str(self.root) for root, _ in RUNNING): raise PlanConflict('A metadata update is already running.')
            saved = self.read(); pending = [identifier for identifier in identifiers if force or not saved.get(identifier, {}).get('fetched_at')]
            job = dict(stage='running' if pending else 'complete', completed=0, total=len(pending), skipped=len(identifiers)-len(pending), errors=[], site=site)
            self.publish(folder, job)
            if pending:
                RUNNING.add((str(self.root), folder))
                try: threading.Thread(target=self.run, args=(folder, pending, site, token, job), daemon=True, name='s3f-civitai-metadata').start()
                except Exception:
                    RUNNING.discard((str(self.root), folder));job['stage']='error';self.publish(folder, job);raise
            return dict(job)

    def stop(self, folder):
        with LOCK:
            job = self.status(folder)
            if job['stage'] == 'running': job['stage'] = 'stopping';self.publish(folder, job)
            return job

    def run(self, folder, identifiers, site, token, job):
        from .civitai_library import CivitaiLibrary, fetch_json
        try:
            for offset in range(0, len(identifiers), 20):
                with LOCK:
                    if self.status(folder)['stage'] == 'stopping': job['stage']='stopped';break
                batch = identifiers[offset:offset+20]
                query = urlencode(dict(ids=','.join(batch), type='video', limit=20, period='AllTime', browsingLevel=31))
                try:
                    data = fetch_json(f'https://{site}/api/v1/images?{query}', token)
                    if not isinstance(data, dict) or not isinstance(data.get('items'), list): raise ValueError('Civitai returned an unexpected response.')
                    records = [record for raw in data['items'] if (record := CivitaiLibrary.record(raw, site)) and record['id'] in batch]
                    self.save(records); found = {record['id'] for record in records}
                    job['errors'].extend(dict(id=identifier, error='Unavailable or not accessible on this site.') for identifier in batch if identifier not in found)
                except (ValueError, OSError) as error:
                    job['errors'].extend(dict(id=identifier, error=str(error)) for identifier in batch)
                    # Keep saved progress and allow a later retry without hammering a failing API.
                    job['stage']='error';break
                job['completed'] += len(batch)
                with LOCK:
                    stopping = self.status(folder)['stage'] == 'stopping'
                    if stopping: job['stage']='stopped'
                    self.publish(folder, job)
                if stopping: break
            if job['stage'] == 'running': job['stage']='complete'
        except Exception as error:
            job['stage']='error';job['errors'].append(dict(id='', error=str(error)))
        finally:
            with LOCK:
                try: self.publish(folder, job)
                finally: RUNNING.discard((str(self.root), folder))
