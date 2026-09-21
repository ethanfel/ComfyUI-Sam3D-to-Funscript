"""Read-only snapshots of saved Main scripts for a public, Civitai-addressed dataset."""
import hashlib
import json
import math
import re
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

from .core import SUFFIXES, validate_actions
from .editor import same_video
from .folder_store import FolderStore, VIDEO_EXTENSIONS, identity, motion_session
from .video import fingerprint

SCHEMA = 's3f-public-funscripts/1'
ID_PATTERN = re.compile(r'(?:^|_)civitai_([1-9]\d*)(?:_|\.)', re.I)
PUBLIC_PATH = re.compile(r'(?:README\.md|LICENSE|data/catalog\.jsonl|index/[a-f0-9]{2}/[a-f0-9]{64}\.json|scripts/[a-f0-9]{2}/[a-f0-9]{64}/[a-f0-9]{64}(?:\.(?:surge|sway|twist|roll|pitch))?\.funscript)')


def encoded_video_id(identifier):
    identifier = str(identifier)
    if not re.fullmatch(r'[1-9]\d{0,15}', identifier) or int(identifier) > 2**53-1:
        raise ValueError('Use a numeric Civitai video ID.')
    return hashlib.sha256(f'civitai:{identifier}'.encode('utf-8')).hexdigest()


def json_bytes(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False) + '\n').encode('utf-8')


def clean_script(script):
    validate_actions(script['actions'])
    inverted = script.get('inverted', False)
    span = script.get('range', 100)
    if type(inverted) is not bool or type(span) not in (int, float) or not math.isfinite(span) or not 0 <= span <= 100:
        raise ValueError('Invalid funscript range or inversion.')
    return dict(version='1.0', inverted=inverted, range=span,
                actions=[{'at': action['at'], 'pos': action['pos']} for action in script['actions']])


def processing(state, clip, plan):
    batch = state.get('batch') or {}
    if batch.get('stage') in ('queued', 'running') and batch.get('current_id') == clip:
        return True
    if any(item.get('clip') == clip and item.get('state') in ('downloading', 'processing')
           for item in state.get('processing_queue', {}).get('items', [])):
        return True
    return (plan.get('progress') or {}).get('stage') not in (None, 'complete', 'error')


def public_category_path(name, record):
    # A temporary download's directory is bookkeeping, not a category. Only
    # publish its chosen destination; ordinary files use their actual folder.
    value = record.get('category', '') if record.get('temporary') else str(PurePosixPath(name).parent)
    if not isinstance(value, str) or value.startswith(('/', '~')) or '\\' in value:
        return None
    parts = value.split('/')
    if any(not part or part.startswith('.') or ':' in part or any(ord(c) < 32 or ord(c) == 127 for c in part) for part in parts):
        return None
    return '/'.join(parts)


def candidates(state):
    root = Path(state['root']).resolve(strict=True)
    if not root.is_dir():
        raise ValueError('A registered library folder is unavailable.')
    managed = {record['name']: (clip, record) for clip, record in state.get('civitai', {}).items()
               if record.get('state') != 'rejected'}
    paths = root.rglob('*') if state.get('recursive', True) else root.iterdir()
    for path in sorted(paths):
        if path.suffix.lower() not in VIDEO_EXTENSIONS or path.is_symlink() or not path.is_file():
            continue
        if not path.resolve().is_relative_to(root):
            continue
        name = path.relative_to(root).as_posix()
        source = fingerprint(path)
        clip, record = managed.get(name, (identity(source), {}))
        if record and record.get('source') != source:
            clip, record = identity(source), {}
        timeline = identity([state['folder'], clip])
        match = ID_PATTERN.search(path.name)
        identifier = record.get('id') or (match.group(1) if match else None)
        yield dict(clip=clip, source=source, timeline=timeline, name=name, identifier=identifier,
                   category_path=public_category_path(name, record))


def matches_approved_export(decision, video, contents):
    if decision.get('status') != 'approved':
        return False
    video = Path(video)
    paths = {axis: video.with_name(video.stem + SUFFIXES[axis] + '.funscript') for axis in contents}
    if set(decision.get('files', [])) != {path.name for path in paths.values()}:
        return False
    for axis, path in paths.items():
        if path.is_symlink() or not path.is_file():
            return False
        if json_bytes(clean_script(json.loads(path.read_text()))) != contents[axis]:
            return False
    return True


def snapshot_clip(store, state, entry, approved_only=False, min_quality=0, use_folder_approval=False):
    """Never call scan/open/queue recovery: this process must not mutate a live job."""
    clip, timeline = entry['clip'], entry['timeline']
    decision = state.get('decisions', {}).get(clip, {})
    if decision.get('status') == 'ignored':
        return None, 'ignored'
    quality = decision.get('quality', 0)
    if type(quality) is not int or not 0 <= quality <= 5:
        quality = 0
    if quality < min_quality:
        return None, 'quality filter'
    session = motion_session(timeline)
    editor_path = store.editors.path(session)
    if not editor_path.is_file():
        return None, 'no generated Main'
    if not entry['identifier']:
        return None, 'missing Civitai ID'
    key = encoded_video_id(entry['identifier'])
    plan = store.plans.read(timeline) or {}
    if processing(state, clip, plan):
        return None, 'processing'
    if (plan.get('progress') or {}).get('stage') == 'error':
        return None, 'failed processing'
    before = editor_path.stat()
    editor = store.editors.read(session)
    project = editor['project']
    if not same_video(project, {'metadata': {'source': entry['source']}}):
        return None, 'changed source'
    scripts = project['scripts']
    if not scripts or set(scripts) - set(SUFFIXES):
        raise ValueError('Unknown or missing Main axes.')
    contents = {axis: json_bytes(clean_script(script)) for axis, script in scripts.items()}
    approved = matches_approved_export(decision, entry['source']['path'], contents)
    if approved_only and not approved:
        return None, 'not approved'
    authored = not project['metadata'].get('imported_scripts') and (
        any(main.get('edited') for main in project.get('timeline', {}).get('main', {}).values())
        or bool(project.get('audio_patterns', {}).get('sections')))
    generated = bool(plan.get('project_path')) and not plan.get('editor_only', False)
    if not (approved or generated or authored):
        return None, 'no generated Main'
    if generated and plan.get('result_current') is False:
        return None, 'outdated processing result'
    checksums = {axis: hashlib.sha256(content).hexdigest() for axis, content in contents.items()}
    info = plan.get('info') or {}
    duration = info.get('end_ms', project['metadata'].get('duration_ms'))
    if type(duration) not in (int, float) or not math.isfinite(duration) or duration <= 0:
        raise ValueError('Missing video duration.')
    variant_id = hashlib.sha256(json_bytes({'scripts': checksums, 'duration_ms': duration})).hexdigest()
    files, axes = {}, {}
    for axis, content in contents.items():
        name = f'scripts/{key[:2]}/{key}/{variant_id}{SUFFIXES[axis]}.funscript'
        files[name] = content
        actions = scripts[axis]['actions']
        axes[axis] = dict(path=name, sha256=checksums[axis], action_count=len(actions),
                          start_ms=actions[0]['at'], end_ms=actions[-1]['at'])
    after = editor_path.stat()
    latest = store.read(state['folder'])
    latest_plan = store.plans.read(timeline) or {}
    if ((before.st_mtime_ns, before.st_size) != (after.st_mtime_ns, after.st_size)
            or latest.get('decisions', {}).get(clip, {}) != decision or latest_plan != plan
            or latest.get('civitai', {}).get(clip, {}) != state.get('civitai', {}).get(clip, {})
            or processing(latest, clip, latest_plan)
            or approved != matches_approved_export(latest.get('decisions', {}).get(clip, {}), entry['source']['path'], contents)
            or fingerprint(entry['source']['path']) != entry['source']):
        return None, 'changed during snapshot'
    variant = dict(variant_id=variant_id, review_status='approved' if approved and use_folder_approval else 'draft', quality=quality,
                   duration_ms=duration, timing='video-relative-ms', scripts=axes,
                   category_paths=[entry['category_path']] if entry.get('category_path') else [])
    return (key, str(entry['identifier']), variant, files), None


def dataset_card(video_count, variant_count, use_folder_approval=False):
    review_note = ('Review labels follow matching approved folder exports. The publisher must have reviewed those scripts.'
                   if use_folder_approval else
                   '**All variants are unvalidated drafts.** Local “Approve & save” actions and quality ratings do not mark them as validated in this dataset.')
    return f'''---
license: gpl-3.0
pretty_name: Civitai motion scripts
tags:
- funscript
- motion
- civitai
configs:
- config_name: default
  data_files:
  - split: train
    path: data/catalog.jsonl
---

# Civitai motion scripts

{video_count} Civitai video IDs and {variant_count} saved Main variants. All available
axes are exported. The funscripts and dataset metadata are licensed under
GNU GPL version 3 (see LICENSE). This license does not cover the linked videos.

{review_note}

## Look up a video

Compute the lowercase hexadecimal SHA-256 of UTF-8 `civitai:<decimal video ID>`,
without whitespace or leading zeroes. Request `index/<first two hash characters>/<hash>.json`.
The index lists script variants and a preferred variant (approved first, then
highest quality; ties use the variant hash). Check `review_status` before using a
draft. Quality is the author's 0–5 rating; 0 means unrated. Hashes provide stable
names, not anonymity: numeric Civitai IDs are present in the index and catalog.

Download the chosen axis at `variant.scripts.L0.path` (or another axis), and verify
its `sha256`. Pin all downloads to the same Hugging Face commit to keep a consistent
snapshot. The catalog is JSON Lines, one row per variant. `manifest.json` documents
the schema, counts and SHA-256 of every managed file.

## Categories

Each catalog row and variant includes `categories` (final folder names, such as
`dance`) and `category_paths` (folders relative to the library, such as
`September_2026/dance`). Each video's index includes the union across its variants.
Identical scripts found in several folders retain all their categories without
duplicating the scripts or changing their hashes. These are the publisher's folder
labels, not Civitai tags or validation status.

Files directly in the library root have empty lists. Temporary downloads use their
chosen destination category, if any; internal review directories are never labels.
Older snapshots without these fields can be treated as having empty lists.

## Download a script

```python
import hashlib, json
from huggingface_hub import HfApi, hf_hub_download

repo = "YOUR_ACCOUNT/YOUR_DATASET"
video_id = "142699180"
revision = HfApi().repo_info(repo, repo_type="dataset").sha
key = hashlib.sha256(f"civitai:{{video_id}}".encode()).hexdigest()
def get(path):
    return hf_hub_download(repo, path, repo_type="dataset", revision=revision)
with open(get(f"index/{{key[:2]}}/{{key}}.json")) as file:
    index = json.load(file)
variant = next(v for v in index["variants"] if v["variant_id"] == index["preferred_variant"])
axis = variant["scripts"]["L0"]
with open(get(axis["path"]), "rb") as file:
    data = file.read()
assert hashlib.sha256(data).hexdigest() == axis["sha256"]
script = json.loads(data)
```

## Timing and review

Actions use integer milliseconds from the local source video's beginning and
positions 0–100. Use the same untrimmed clip and check `duration_ms` before playback.
The Civitai ID identifies a post, not the bytes of a particular download or edit.
Transcodes, cuts and speed changes can affect synchronization. Multiple script
variants for the same post stay separate; axes are never combined across variants.

Only completed saved Main results are collected. Processing, failed, ignored,
outdated and unidentified clips are skipped. Unsaved browser edits and historical
source tracks are not included. Drafts can contain tracking errors or incomplete
coverage and are not automatically approved. An approved result edited afterward
is labelled as a draft until approved again when folder approval labels are enabled.

Category names and relative category paths are public. No videos, audio,
thumbnails, original filenames, absolute local paths, private notes,
model caches or API keys are included. Obtain videos separately through Civitai
with the access required by that service. `start_ms` and `end_ms` describe each
axis's action extent, not a claim that every scene has been reviewed.
'''


def build_dataset(store_root, destination, *, folders=None, approved_only=False, min_quality=0, use_folder_approval=False):
    store = FolderStore(store_root)
    destination = Path(destination)
    if destination.exists():
        raise ValueError('Choose a new snapshot directory; existing exports are kept.')
    if type(min_quality) is not int or not 0 <= min_quality <= 5:
        raise ValueError('Quality must be between 0 and 5.')
    folder_ids = folders if folders is not None else [p.stem for p in sorted((store.root / 'folders').glob('*.json'))]
    if not folder_ids:
        raise ValueError('No registered Folder workspaces found in this store.')
    indexes, files, skipped = {}, {}, []
    for folder in dict.fromkeys(folder_ids):
        state = store.read(folder)
        for entry in candidates(state):
            try:
                item, reason = snapshot_clip(store, state, entry, approved_only, min_quality, use_folder_approval)
            except (ValueError, KeyError, TypeError, OSError) as error:
                item, reason = None, f'invalid or unavailable result: {type(error).__name__}'
            if item is None:
                skipped.append(dict(folder=folder, name=entry['name'], reason=reason))
                continue
            key, identifier, variant, contents = item
            index = indexes.setdefault(key, dict(schema=SCHEMA, video_key=key, civitai_id=identifier, variants={}))
            prior = index['variants'].get(variant['variant_id'])
            category_paths = set(variant['category_paths']) | set(prior['category_paths'] if prior else [])
            rank = lambda value: (value['review_status'] == 'approved', value['quality'])
            if prior is None or rank(variant) > rank(prior):
                index['variants'][variant['variant_id']] = variant
            index['variants'][variant['variant_id']]['category_paths'] = sorted(category_paths)
            files.update(contents)
    if not indexes:
        return dict(videos=0, variants=0, scripts=0, skipped=skipped, skip_counts=dict(Counter(s['reason'] for s in skipped)))
    catalog = []
    for key, index in sorted(indexes.items()):
        index['variants'] = sorted(index['variants'].values(), key=lambda v: (v['review_status'] != 'approved', -v['quality'], v['variant_id']))
        for variant in index['variants']:
            variant['categories'] = sorted({PurePosixPath(path).name for path in variant['category_paths']})
        index['category_paths'] = sorted({path for variant in index['variants'] for path in variant['category_paths']})
        index['categories'] = sorted({category for variant in index['variants'] for category in variant['categories']})
        index['preferred_variant'] = index['variants'][0]['variant_id']
        index_path = f'index/{key[:2]}/{key}.json'
        files[index_path] = json_bytes(index)
        for variant in index['variants']:
            catalog.append(dict(video_key=key, civitai_id=index['civitai_id'], index_path=index_path,
                                preferred=variant['variant_id'] == index['preferred_variant'], **variant))
    files['data/catalog.jsonl'] = b''.join(json_bytes(row) for row in catalog)
    files['README.md'] = dataset_card(len(indexes), len(catalog), use_folder_approval).encode('utf-8')
    files['LICENSE'] = (Path(__file__).resolve().parents[1] / 'LICENSE').read_bytes()
    manifest = dict(schema=SCHEMA, license='gpl-3.0', created_at=datetime.now(timezone.utc).isoformat(),
                    review_policy='folder-approval' if use_folder_approval else 'all-drafts',
                    review_counts=dict(Counter(row['review_status'] for row in catalog)),
                    naming='sha256(utf8("civitai:" + decimal_video_id))', videos=len(indexes), variants=len(catalog),
                    scripts=sum(len(row['scripts']) for row in catalog), catalog='data/catalog.jsonl',
                    files={name: hashlib.sha256(content).hexdigest() for name, content in sorted(files.items())})
    # Write the manifest last: a half-written snapshot cannot pass publication validation.
    destination.mkdir(parents=True)
    for name, content in files.items():
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
    (destination / 'manifest.json').write_bytes(json_bytes(manifest))
    return {key: manifest[key] for key in ('videos', 'variants', 'scripts')} | dict(
        skipped=skipped, skip_counts=dict(Counter(s['reason'] for s in skipped)))


def managed_files(manifest):
    if manifest.get('schema') != SCHEMA or manifest.get('license') != 'gpl-3.0':
        raise ValueError('Not a GPL-3.0 public funscript dataset snapshot.')
    files = manifest.get('files')
    if not isinstance(files, dict) or not {'README.md', 'LICENSE', 'data/catalog.jsonl'} <= files.keys():
        raise ValueError('Incomplete dataset manifest.')
    if any(not PUBLIC_PATH.fullmatch(name) or not isinstance(checksum, str) or not re.fullmatch(r'[a-f0-9]{64}', checksum)
           for name, checksum in files.items()):
        raise ValueError('Invalid public dataset file list.')
    return files


def validate_snapshot(directory):
    root = Path(directory).resolve(strict=True)
    manifest_path = root / 'manifest.json'
    if manifest_path.is_symlink():
        raise ValueError('Dataset files must not be symlinks.')
    manifest = json.loads(manifest_path.read_text())
    for name, checksum in managed_files(manifest).items():
        path = root / name
        if path.is_symlink() or not path.resolve().is_relative_to(root):
            raise ValueError('Dataset files must stay inside the snapshot directory.')
        if hashlib.sha256(path.read_bytes()).hexdigest() != checksum:
            raise ValueError(f'Dataset file changed: {name}. Build a new snapshot.')
    return manifest


def publish_dataset(directory, repo_id):
    """Only this explicitly called function loads the optional Hub upload client."""
    from huggingface_hub import HfApi, hf_hub_download

    manifest = validate_snapshot(directory)
    api = HfApi(endpoint='https://huggingface.co')
    api.create_repo(repo_id, repo_type='dataset', private=False, exist_ok=True)
    info = api.repo_info(repo_id, repo_type='dataset')
    if info.private:
        raise ValueError('Choose a public dataset repository; this repository is private.')
    remote_files = {entry.rfilename for entry in info.siblings}
    obsolete = []
    if 'manifest.json' in remote_files:
        previous = json.loads(Path(hf_hub_download(repo_id, 'manifest.json', repo_type='dataset', revision=info.sha,
                                                  endpoint='https://huggingface.co')).read_text())
        obsolete = sorted(managed_files(previous).keys() - manifest['files'].keys())
    elif remote_files - {'.gitattributes'}:
        raise ValueError('Choose an empty dataset or an earlier public funscript dataset export.')
    result = api.upload_folder(repo_id=repo_id, repo_type='dataset', folder_path=str(directory),
        allow_patterns=[*manifest['files'], 'manifest.json'], delete_patterns=obsolete or None,
        parent_commit=info.sha, commit_message=f'Update funscripts: {manifest["videos"]} videos, {manifest["scripts"]} scripts')
    return dict(url=f'https://huggingface.co/datasets/{repo_id}', commit=result.oid)
