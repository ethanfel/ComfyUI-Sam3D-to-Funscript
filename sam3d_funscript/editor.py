"""Persistent editor sessions and immutable source revisions for preview reruns."""
import copy
import hashlib
import json
import re
import threading
from pathlib import Path

from .core import SCHEMA, AXES, validate_actions
from .timeline import GEOMETRY, SOURCE_FIELDS

LOCK = threading.RLock()


def same_video(a, b):
    a, b = a['metadata']['source'], b['metadata']['source']
    # JSON passes through JavaScript numbers. Nanosecond mtimes exceed its exact
    # integer range; compare their representable values, not lost low bits.
    return a.get('path') == b.get('path') and all(float(a[k]) == float(b[k]) for k in ('size', 'mtime_ns') if k in a and k in b)


def initialize(project):
    if project.get('timeline'):
        timeline = project['timeline']
        timeline.setdefault('latest', {s.get('input', s['id'].split('@')[0]): s['id'] for s in timeline['sources']})
        # Processing inputs are identified by region and anchor, not their current
        # row number. Adding another anchor must not redirect another region's row.
        names = {}
        for source in timeline['sources']:
            region = source['data'].get('metadata', {}).get('processing_region', {})
            if region.get('id'):
                name = f"region:{region['id']}:{source['data']['config']['target_anchor']}"
                names[source['id']] = name
                source['input'] = name
        timeline['latest'] = {names.get(source, name): source for name, source in timeline['latest'].items()}
        return project
    data = {k: copy.deepcopy(project[k]) for k in SOURCE_FIELDS if k in project}
    label = f"project_0 · {data['config']['target_anchor'].replace('_', ' ')} · person {data['config']['target_person']}"
    axis = 'L0' if 'L0' in data['scripts'] else next(iter(data['scripts']))
    project['timeline'] = dict(version=1, sources=[dict(id='project_0', label=label, geometry='base', data=data)], latest={'project_0': 'project_0'},
        geometries={}, tracks=[dict(id='track_0', name=label, source='project_0', axis=axis,
        settings=copy.deepcopy(data['config']['axis_settings'][axis]), script=copy.deepcopy(data['scripts'][axis]))],
        main={a: dict(assembled=False, source='project_0', regions=[]) for a in data['scripts']}, active='main', selection=[0, 0])
    return project


def validate(project):
    if project.get('schema') != SCHEMA or not project.get('times_ms') or not project.get('scripts'):
        raise ValueError('Invalid editor project')
    initialize(project)
    timeline = project['timeline']
    if timeline.get('version') != 1:
        raise ValueError('Unsupported editor timeline')
    sources = {s['id'] for s in timeline['sources']}
    if len(sources) != len(timeline['sources']) or len({t['id'] for t in timeline['tracks']}) != len(timeline['tracks']):
        raise ValueError('Duplicate editor source or track IDs')
    if any(source not in sources for source in timeline['latest'].values()):
        raise ValueError('Missing latest input source')
    for axis, script in project['scripts'].items():
        if axis not in AXES or timeline['main'][axis]['source'] not in sources:
            raise ValueError('Invalid main axis or source')
        validate_actions(script['actions'])
        for region in timeline['main'][axis]['regions']:
            if region['source'] not in sources:
                raise ValueError('Missing section source')
    for track in timeline['tracks']:
        if track['source'] not in sources or track['axis'] not in AXES:
            raise ValueError('Invalid track source or axis')
        validate_actions(track['script']['actions'])
    return project


def digest(value):
    def browser_numbers(item):
        if type(item) in (int, float):
            return 0.0 if item == 0 else float(item)  # JS serializes -0 as 0.
        if isinstance(item, list):
            return [browser_numbers(v) for v in item]
        if isinstance(item, dict):
            return {k: browser_numbers(v) for k, v in item.items()}
        return item
    return hashlib.sha256(json.dumps(browser_numbers(value), sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def geometry(project, source):
    return {k: project.get(k) for k in GEOMETRY} if source['geometry'] == 'base' else project['timeline']['geometries'][source['geometry']]


def source_digest(data):
    # A cache hit or another export path is not a changed motion input.
    metadata = {k: v for k, v in data['metadata'].items() if k not in ('cache_hit', 'cache_path', 'inference_seconds', 'performance')}
    return digest({**data, 'metadata': metadata})


def merge_projects(previous, incoming):
    """Follow changed inputs on unlocked lanes; retain locks and composed sections."""
    old, new = initialize(copy.deepcopy(previous)), initialize(copy.deepcopy(incoming))
    was_processing_generated = 'processing_timeline' in old['metadata'] and all(
        main.get('processing_generated') for main in old['timeline']['main'].values())
    locked = any(t.get('locked') for t in old['timeline']['tracks']) or any(m.get('locked') for m in old['timeline']['main'].values())
    if not same_video(old, new):
        if locked:
            raise ValueError('This editor has locked tracks from another video. Use a new Preview node for the new video, or explicitly unlock those tracks first.')
        return new
    out, timeline = old, old['timeline']
    sources = {s['id']: s for s in timeline['sources']}
    geometries = {digest(geometry(out, s)): s['geometry'] for s in timeline['sources']}
    mapping = {}
    old_inputs = {s.get('input', s['id']) for s in timeline['sources']}
    for source in new['timeline']['sources']:
        original = source.get('input', source['id'])
        data_hash = source_digest(source['data'])
        geo = geometry(new, source)
        geo_hash = digest(geo)
        match = next((s for s in sources.values() if s.get('input', s['id']) == original
            and source_digest(s['data']) == data_hash and digest(geometry(out, s)) == geo_hash), None)
        if match:
            mapping[source['id']] = match['id']
            continue
        key = source['id']
        if key in sources:
            key = f"{original}@{digest([data_hash, geo_hash])[:16]}"
        geo_key = geometries.get(geo_hash)
        if geo_key is None:
            geo_key = f"geometry_{geo_hash[:16]}"
            timeline['geometries'][geo_key] = geo
            geometries[geo_hash] = geo_key
        snapshot = {**source, 'id': key, 'input': original, 'geometry': geo_key}
        if key != original:
            snapshot['label'] = source['label'] + ' · updated'
        timeline['sources'].append(snapshot); sources[key] = snapshot
        mapping[source['id']] = key
    latest = {name: mapping[source] for name, source in new['timeline']['latest'].items()}
    timeline['latest'] = latest
    for track in timeline['tracks']:
        if track.get('locked') or track.get('window'):
            continue
        source = sources[track['source']]
        new_id = latest.get(source.get('input', source['id']))
        if new_id and track['axis'] in sources[new_id]['data']['scripts']:
            data = sources[new_id]['data']; axis = track['axis']
            if not track.get('custom_name') and re.fullmatch(r'project_\d+ · .+ · person \d+(?: · updated)?', track['name']):
                track['name'] = f"{source.get('input', source['id'])} · {data['config']['target_anchor'].replace('_', ' ')} · person {data['config']['target_person']}"
            if new_id == track['source']:
                continue
            track.update(source=new_id, settings=copy.deepcopy(data['config']['axis_settings'][axis]), script=copy.deepcopy(data['scripts'][axis]))
            track.pop('metrics', None)
            track.pop('edited', None)
            track.pop('patterns', None)
    for track in new['timeline']['tracks']:
        source = next(s for s in new['timeline']['sources'] if s['id'] == track['source'])
        if source.get('input', source['id']) in old_inputs:
            continue
        n = 0
        while any(t['id'] == f'track_{n}' for t in timeline['tracks']): n += 1
        timeline['tracks'].append({**track, 'id': f'track_{n}', 'source': mapping[track['source']]})
    for axis, main in new['timeline']['main'].items():
        prior = timeline['main'].get(axis, {})
        generated = prior.get('processing_generated') and main.get('processing_generated') and not prior.get('edited')
        if prior.get('locked') or (prior.get('assembled') and not generated) or (prior.get('source') == mapping[main['source']] and not generated):
            continue
        main = copy.deepcopy(main); main['source'] = mapping[main['source']]
        for region in main['regions']: region['source'] = mapping[region['source']]
        timeline['main'][axis] = main
        out['scripts'][axis] = new['scripts'][axis]
        out['config']['axis_settings'][axis] = new['config']['axis_settings'][axis]
        out.setdefault('metrics', {})[axis] = new.get('metrics', {}).get(axis, {})
    out['config']['enabled_axes'] = list(out['scripts'])
    generated_main = bool(timeline['main']) and all(main.get('processing_generated') and not main.get('edited')
        and not main.get('locked') for main in timeline['main'].values())
    retained_tracks = any(track.get('edited') or track.get('locked') or track.get('window') for track in timeline['tracks'])
    if was_processing_generated and 'processing_timeline' in new['metadata'] and generated_main and not retained_tracks:
        # A shorter processing trim replaces the generated result's extent.
        # Authored/locked lanes retain the historical ruler they may still use;
        # ordinary multi-project Motion Studio merging keeps its existing rule.
        out['metadata']['duration_ms'] = new['metadata']['duration_ms']
    else:
        out['metadata']['duration_ms'] = max(out['metadata']['duration_ms'], new['metadata']['duration_ms'])
    if 'processing_timeline' in new['metadata']:
        out['metadata']['processing_timeline'] = copy.deepcopy(new['metadata']['processing_timeline'])
        if 'scene_cuts' in new['metadata']:
            out['metadata']['scene_cuts'] = copy.deepcopy(new['metadata']['scene_cuts'])
        else:
            out['metadata'].pop('scene_cuts', None)
    # Keep historical poses only while a track or a copied main section uses them.
    used = set(latest.values()) | {t['source'] for t in timeline['tracks']}
    for main in timeline['main'].values():
        used.add(main['source'])
        used.update(r['source'] for r in main['regions'])
    timeline['sources'] = [s for s in timeline['sources'] if s['id'] in used]
    used_geometry = {s['geometry'] for s in timeline['sources']}
    timeline['geometries'] = {k: v for k, v in timeline['geometries'].items() if k in used_geometry}
    return validate(out)


class Conflict(ValueError):
    pass


class EditorStore:
    def __init__(self, root):
        self.root = Path(root) / 'editor_sessions'

    def path(self, session):
        if not isinstance(session, str) or not re.fullmatch(r'[a-f0-9-]{32,36}', session):
            raise ValueError('Invalid editor session ID')
        return self.root / f'{session}.json'

    def read(self, session):
        with LOCK:
            path = self.path(session)
            return json.loads(path.read_text()) if path.is_file() else None

    def export_path(self, session):
        state = self.read(session)
        if not state or not state.get('output'):
            raise ValueError('Run the upstream Motion Studio node before opening its shared session.')
        return self.root.parent / state['output'] / 'project.json'

    def write(self, session, state):
        path = self.path(session)
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix('.tmp')
        temporary.write_text(json.dumps(state, separators=(',', ':'), allow_nan=False))
        temporary.replace(path)
        return state

    def save(self, session, project, revision):
        validate(project)
        with LOCK:
            old = self.read(session)
            if revision != (old['revision'] if old else 0):
                raise Conflict('Another editor or rerun updated this session. Download your edits before reloading; they have not overwritten the saved tracks.')
            return self.write(session, dict(revision=revision + 1, project=project, output=old.get('output') if old else None))

    def export(self, session, incoming, exporter):
        with LOCK:
            old = self.read(session)
            project = merge_projects(old['project'], incoming) if old else initialize(copy.deepcopy(incoming))
            path = exporter(project)
            state = self.write(session, dict(revision=(old['revision'] if old else 0) + 1, project=project, output=path.parent.name))
            return path, state['revision']
