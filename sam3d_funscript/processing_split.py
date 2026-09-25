"""Partition saved detections without inference or recalibrating their curves."""
from bisect import bisect_left
from copy import deepcopy
import json
from pathlib import Path

import numpy as np

from .reference import atomic_json, digest
from .timeline import GEOMETRY, SOURCE_FIELDS


def configuration(region, bounds=True):
    omitted = {'name', 'enabled', 'locked'}
    if not bounds:
        omitted.update(('id', 'start_ms', 'end_ms'))
    return {k: v for k, v in region.items() if k not in omitted}


def split_groups(previous, incoming):
    """Accept exact partitions of unchanged tracking; never infer cache ancestry
    from a user-supplied filename or a region with changed detection settings.
    """
    if previous['stabilization'] != incoming['stabilization']:
        return {}
    old_ids = {r['id'] for r in previous['tracking']}
    groups = {}
    for old in previous['tracking']:
        if not old['enabled'] or old['locked']:
            continue
        parts = sorted((r for r in incoming['tracking'] if r['enabled'] and
                        (r['id'] == old['id'] or r['id'] not in old_ids) and
                        old['start_ms'] <= r['start_ms'] < r['end_ms'] <= old['end_ms'] and
                        configuration(r, False) == configuration(old, False)), key=lambda r: r['start_ms'])
        if (len(parts) > 1 and parts[0]['id'] == old['id'] and parts[0]['start_ms'] == old['start_ms']
                and parts[-1]['end_ms'] == old['end_ms']
                and all(a['end_ms'] == b['start_ms'] for a, b in zip(parts, parts[1:]))):
            groups[old['id']] = parts
    return groups


def clip_coverage(coverage, start, end):
    return [[max(start, a), min(end, b)] for a, b in coverage if max(start, a) < min(end, b)]


def clip_script(script, start, end):
    result = deepcopy(script)
    actions = script['actions']
    if not actions:
        return result
    low, high = round(start), round(end)
    times = sorted({low, high, *(a['at'] for a in actions if low <= a['at'] <= high)})
    values = np.interp(times, [a['at'] for a in actions], [a['pos'] for a in actions])
    result['actions'] = [{'at': at, 'pos': round(float(pos))} for at, pos in zip(times, values)]
    return result


def clip_project(project, region):
    start, end = region['start_ms'], region['end_ms']
    times = project['times_ms']
    first, last = bisect_left(times, start), bisect_left(times, end)
    if first == last:
        return None
    result = deepcopy(project)
    result.pop('timeline', None)
    for key in (*GEOMETRY, 'valid', 'raw', 'processed'):
        if key in project:
            result[key] = deepcopy(project[key][first:last])
    metadata = result['metadata']
    for key in ('timestamps', 'mask_boxes'):
        if key in metadata:
            metadata[key] = metadata[key][first:last]
    metadata.update(processing_region=deepcopy(region), duration_ms=end,
                    analysed_start_ms=times[first], analysed_end_ms=times[last-1], sample_count=last-first,
                    processing_coverage=clip_coverage(metadata.get('processing_coverage', [[start, end]]), start, end))
    result['orientation_hints'] = [{**h, 'start': max(first, h['start'])-first, 'end': min(last, h['end'])-first}
                                   for h in project.get('orientation_hints', []) if h['end'] > first and h['start'] < last]
    result['scripts'] = {axis: clip_script(script, start, end) for axis, script in project['scripts'].items()}
    # These curves keep their original scale and values; fitting them again
    # would change good motion solely because its region became shorter.
    result['metrics'] = {axis: {'actions': len(script['actions']), 'split_retained': True} for axis, script in result['scripts'].items()}
    return result


def split_editor(project, groups, plan):
    from .editor import geometry, initialize, validate
    result = initialize(deepcopy(project))
    timeline = result['timeline']
    latest_ids = set(timeline['latest'].values())
    mapping = {}
    for source in list(timeline['sources']):
        old = source['data']['metadata'].get('processing_region', {})
        if source['id'] not in latest_ids or old.get('id') not in groups:
            continue
        full = {'schema': result['schema'], **source['data'], **geometry(result, source)}
        children = []
        for region in groups[old['id']]:
            data = clip_project(full, region)
            if data is None:
                continue
            suffix = digest([source['id'], region])[:16]
            source_id = f"split_{suffix}"
            geo_id = 'split_geometry_' + digest([source['geometry'], region['start_ms'], region['end_ms']])[:16]
            timeline['geometries'][geo_id] = {k: data[k] for k in GEOMETRY}
            anchor, person = data['config']['target_anchor'], data['config']['target_person']
            label = f"{region['name']} · {anchor.replace('_', ' ')}"
            input_id = f"region:{region['id']}:{anchor}"
            if region.get('candidate_people'):
                input_id += f':person{person}'; label += f' · person {person}'
            child = dict(id=source_id, input=input_id, label=label, geometry=geo_id,
                         data={k: data[k] for k in SOURCE_FIELDS if k in data})
            timeline['sources'].append(child); timeline['latest'][input_id] = source_id
            children.append((region, child))
        if children:
            mapping[source['id']] = children
    tracks = []
    for track in timeline['tracks']:
        children = mapping.get(track['source'])
        if not children:
            tracks.append(track); continue
        for index, (region, child) in enumerate(children):
            start, end = region['start_ms'], region['end_ms']
            if track.get('window'):
                start, end = max(start, track['window'][0]), min(end, track['window'][1])
                if start >= end:
                    continue
            item = deepcopy(track)
            item.update(id=track['id'] if index == 0 else f"{track['id']}~{digest(region)[:12]}", source=child['id'],
                        name=track['name'] if index == 0 and track.get('custom_name') else child['label'],
                        script=clip_script(track['script'], start, end))
            if 'window' in item:
                item['window'] = [start, end]
            tracks.append(item)
    timeline['tracks'] = tracks
    for main in timeline['main'].values():
        regions = []
        for interval in main['regions']:
            children = mapping.get(interval['source'])
            if not children:
                regions.append(interval); continue
            for region, child in children:
                a, b = max(interval['start'], region['start_ms']), min(interval['end'], region['end_ms'])
                if a < b:
                    regions.append({**interval, 'start': a, 'end': b, 'source': child['id'],
                                    'blend_ms': max(0, min(b-a, interval.get('blend_ms', 0)-(a-interval['start'])) )})
        main['regions'] = regions
        if main['source'] in mapping:
            main['source'] = mapping[main['source']][0][1]['id']
    # Authored Main, locks, audio blocks and calibration remain byte-for-byte
    # unchanged. Only source selection/section bounds are partitioned.
    result['metadata'].setdefault('processing_timeline', {})['plan'] = deepcopy(plan)
    validate(result)
    return result


def signature_region(region, entry, stabilizers):
    """Compare retained poses against the original inference's model/settings."""
    origin = (entry or {}).get('split_origin')
    if not origin or any(region.get(k) != entry['region'].get(k) for k in ('id', 'start_ms', 'end_ms')):
        return region, None
    references = origin['stabilization_regions']
    if any(r['id'] not in stabilizers or configuration(stabilizers[r['id']]) != configuration(r) for r in references):
        return region, None
    # A newly added reference inside the original interval also invalidates it.
    original = origin['region']
    ids = {r['id'] for r in references}
    current = {r['id'] for r in stabilizers.values() if r['enabled'] and r['start_ms'] < original['end_ms'] and r['end_ms'] > original['start_ms']}
    if ids != current:
        return region, None
    return {**region, **{k: original[k] for k in ('id', 'start_ms', 'end_ms')}}, ids


def retain_splits(store, state, previous, was_current=False):
    """Stage a split as a recoverable multi-file save. Returns False if no saved
    detection matches; changed settings use the normal processing path.
    """
    from .editor import EditorStore, LOCK as EDITOR_LOCK
    from .processing_timeline import _coverage
    groups = split_groups(previous, state['plan'])
    if not groups or (state.get('progress') or {}).get('stage') not in (None, 'complete', 'error'):
        return False
    directory = store.directory(state['session']) / 'results' / state['info']['source_id']
    cache_path = directory / 'state.json'
    if not cache_path.is_file():
        return False
    cache = json.loads(cache_path.read_text())
    if cache.get('source_id') != state['info']['source_id']:
        return False
    writes, retained = {}, {}
    old_regions = {r['id']: r for r in previous['tracking']}
    report = deepcopy(state.get('report') or {'regions': []})
    rows = {r['id']: r for r in report.get('regions', [])}
    for parent, parts in groups.items():
        entry = cache['regions'].get(parent)
        if not entry or configuration(entry.get('region', {})) != configuration(old_regions[parent]):
            continue
        references = sorted((r for r in previous['stabilization'] if r['enabled'] and r['start_ms'] < old_regions[parent]['end_ms'] and r['end_ms'] > old_regions[parent]['start_ms']), key=lambda r: r['id'])
        if [configuration(r) for r in entry.get('stabilization_regions', [])] != [configuration(r) for r in references]:
            continue
        paths = [entry.get('project_path'), *entry.get('additional_project_paths', [])]
        if not all(path and Path(path).is_file() for path in paths):
            continue
        projects = [json.loads(Path(path).read_text()) for path in paths]
        if any(configuration(p['metadata'].get('processing_region', {})) != configuration(old_regions[parent]) for p in projects):
            continue
        retained[parent] = parts
        rows.pop(parent, None)
        for region in parts:
            a, b = region['start_ms'], region['end_ms']
            child = deepcopy(entry)
            child['region'] = deepcopy(region)
            child['split_origin'] = deepcopy(entry.get('split_origin') or dict(region=entry['region'], stabilization_regions=references))
            child['stabilization_regions'] = [r for r in references if r['start_ms'] < b and r['end_ms'] > a]
            child['jobs'] = [{**j, 'start_ms': max(a, j['start_ms']), 'end_ms': min(b, j['end_ms']), 'region_id': region['id'],
                              'id': digest([region['id'], max(a, j['start_ms']), min(b, j['end_ms']), j.get('stabilization_id')])}
                             for j in entry['jobs'] if j['start_ms'] < b and j['end_ms'] > a and Path(j['path']).is_file()]
            paths = []
            for project in projects:
                clipped = clip_project(project, region)
                if clipped is None:
                    continue
                path = directory / (digest(['split', entry['signature'], region, clipped['config']])+'.project.json')
                writes[path] = clipped; paths.append(str(path))
            child.pop('project_path', None); child['additional_project_paths'] = paths[1:]
            if paths:
                child['project_path'] = paths[0]
            cache['regions'][region['id']] = child
            coverage = _coverage(child['jobs'])
            rows[region['id']] = dict(id=region['id'], region=deepcopy(region), start_ms=a, end_ms=b,
                stabilization_regions=child['stabilization_regions'], coverage=coverage,
                state='complete' if paths and coverage == [[a,b]] else 'partial' if paths else 'pending',
                **({'project_path': paths[0]} if paths else {}))
    if not retained:
        return False
    report.update(regions=[rows[r['id']] for r in state['plan']['tracking'] if r['id'] in rows], revision=state['revision'])
    state['report'] = report
    state['retained_splits'] = dict(revision=state['revision'], regions=[r['id'] for parts in retained.values() for r in parts])
    # A pure partition changes presentation, not the generated output.
    expected = deepcopy(previous)
    expected['tracking'] = [part for r in previous['tracking'] for part in retained.get(r['id'], [r])]
    state['result_current'] = was_current and all(expected[k] == state['plan'][k] for k in ('tracking', 'stabilization', 'gap_policy', 'join_ms', 'chunk_seconds'))
    writes[cache_path] = cache; writes[directory/'report.json'] = report
    editors = EditorStore(store.root.parent)
    with EDITOR_LOCK:
        session = state.get('editor_session')
        editor = editors.read(session) if session else None
        if editor:
            editor['project'] = split_editor(editor['project'], retained, state['plan'])
            editor['revision'] += 1; writes[editors.path(session)] = editor
        output = Path(state['project_path']) if state.get('project_path') else None
        if output and output.is_file():
            project = editor['project'] if editor else split_editor(json.loads(output.read_text()), retained, state['plan'])
            writes[output] = project
            if (directory/'project.json').is_file():
                writes[directory/'project.json'] = project
        writes[store.directory(state['session'])/'timeline.json'] = state
        originals = {path: json.loads(path.read_text()) if path.is_file() else None for path in writes}
        changed = []
        try:
            for path, value in writes.items():
                changed.append(path); atomic_json(path, value)
        except Exception:
            for path in reversed(changed):
                if originals[path] is None:
                    path.unlink(missing_ok=True)
                else:
                    atomic_json(path, originals[path])
            raise
    return True
