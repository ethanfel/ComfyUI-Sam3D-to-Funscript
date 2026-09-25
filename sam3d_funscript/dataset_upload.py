"""User-triggered uploads, independent of the ComfyUI processing queue."""
import copy
import json
from pathlib import Path
import tempfile
import threading
from datetime import datetime, timezone

from .folder_store import FolderStore
from .processing_store import PlanConflict
from .public_dataset import build_dataset, publish_dataset
from .reference import atomic_json


LOCK = threading.RLock()
RUNNING = set()
ACTIVE = ('building', 'uploading')


def credentials():
    try:
        from huggingface_hub import get_token
        return dict(available=True, authenticated=bool(get_token()))
    except ImportError:
        return dict(available=False, authenticated=False)


class DatasetUpload:
    def __init__(self, root):
        self.store = FolderStore(root)
        self.directory = self.store.root / 'dataset_uploads'

    def path(self, folder):
        self.store.path(folder)  # Validate the workspace ID before using it as a filename.
        return self.directory / (folder + '.json')

    def _read(self, folder):
        path = self.path(folder)
        state = json.loads(path.read_text()) if path.is_file() else dict(
            repo='', job=dict(stage='idle'), last_upload=None)
        # Older saved settings must not force approved results back to drafts.
        state['use_folder_approval'] = True
        return state

    def read(self, folder):
        self.store.read(folder)
        with LOCK:
            state = self._read(folder)
            if state['job']['stage'] in ACTIVE and (str(self.store.root), folder) not in RUNNING:
                state['job'] = dict(stage='interrupted', error='ComfyUI restarted during the upload. Check the dataset before retrying.')
            return {**state, **credentials(), 'video_metadata': True,
                    'busy': any(root == str(self.store.root) for root, _ in RUNNING)}

    def start(self, folder, repo):
        auth = credentials()
        if not auth['available']:
            raise ValueError('Install huggingface_hub in the ComfyUI Python environment, then retry.')
        from huggingface_hub.utils import validate_repo_id
        if not isinstance(repo, str):
            raise ValueError('Enter a Hugging Face repository as account/dataset.')
        repo = repo.strip()
        validate_repo_id(repo)
        if repo.count('/') != 1:
            raise ValueError('Use account/dataset, for example your-account/your-dataset.')
        if not auth['authenticated']:
            raise ValueError('Sign in on the ComfyUI server with hf auth login, or set HF_TOKEN, then retry.')
        self.store.read(folder)
        with LOCK:
            if any(root == str(self.store.root) for root, _ in RUNNING):
                raise PlanConflict('A dataset upload is already running. Wait for it to finish.')
            state = self._read(folder)
            state.update(repo=repo,
                         job=dict(stage='building', repo=repo, started_at=datetime.now(timezone.utc).isoformat()))
            self.directory.mkdir(parents=True, exist_ok=True)
            atomic_json(self.path(folder), state)
            key = (str(self.store.root), folder)
            RUNNING.add(key)
            try:
                threading.Thread(target=self.run, args=(folder, repo),
                                 daemon=True, name='s3f-dataset-upload').start()
            except Exception:
                RUNNING.discard(key)
                state['job'] = dict(stage='error', error='Could not start the upload worker.')
                atomic_json(self.path(folder), state)
                raise
            return self.read(folder)

    def run(self, folder, repo):
        def update(**fields):
            with LOCK:
                state = self._read(folder)
                state['job'].update(fields)
                if fields.get('stage') == 'complete':
                    state['last_upload'] = copy.deepcopy(state['job'])
                atomic_json(self.path(folder), state)

        try:
            with tempfile.TemporaryDirectory(prefix='snapshot-', dir=self.directory) as temporary:
                snapshot = Path(temporary) / 'dataset'
                result = build_dataset(self.store.root, snapshot, folders=[folder], use_folder_approval=True)
                summary = {key: value for key, value in result.items() if key != 'skipped'}
                if not result['videos']:
                    update(stage='empty', summary=summary, error='No eligible videos with Civitai IDs were found. Nothing was uploaded.')
                    return
                update(stage='uploading', summary=summary)
                published = publish_dataset(snapshot, repo)
                update(stage='complete', result=published, finished_at=datetime.now(timezone.utc).isoformat())
        except Exception as error:
            update(stage='error', error=str(error))
        finally:
            with LOCK:
                RUNNING.discard((str(self.store.root), folder))
