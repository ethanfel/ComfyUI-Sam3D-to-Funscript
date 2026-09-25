"""Read H3 Animator's active reading order without changing its catalogue."""
import base64
import io
import json
import re
import math
import threading
from contextlib import closing
from pathlib import Path

from .reference import atomic_json

CATALOGUES = {}
STATE_FILE = '.s3f-h3.json'
PROBE_LOCK = threading.Lock()
PROBE_DETECTOR = None


def inside(root, relative):
    if not isinstance(relative, str) or Path(relative).is_absolute() or '..' in Path(relative).parts:
        raise ValueError('Invalid H3 project asset path.')
    path = (root / relative).resolve()
    if not path.is_relative_to(root):
        raise ValueError('H3 assets must stay inside the project.')
    return path


def read_json(path):
    return json.loads(path.read_text(encoding='utf-8'))


def catalogue(directory, *, refresh=False):
    root = Path(directory).resolve(strict=True)
    try:
        stamp = tuple((root / name).stat().st_mtime_ns for name in ('project.json', 'index.json'))
    except FileNotFoundError as error:
        raise ValueError('Choose an H3 Animator project containing project.json and index.json.') from error
    pairs_file = root / 'flf_sequence.json'
    stamp += (pairs_file.stat().st_mtime_ns if pairs_file.exists() else None,)
    cached = CATALOGUES.get(str(root))
    if not refresh and cached and cached[0] == stamp:
        return cached[1]
    project, index = read_json(root / 'project.json'), read_json(root / 'index.json')
    if project.get('schema_version') != 1 or index.get('schema_version') != 1:
        raise ValueError('Unsupported H3 Animator project schema.')
    pages, panels, clips, warnings = [], [], {}, []
    layouts, page_errors = {}, {}
    active = {}
    for page in project['pages']:
        pid = page['page_id']
        if not re.fullmatch(r'page_\d+', pid):
            raise ValueError('Invalid H3 page ID.')
        try:
            current = inside(root, f'pages/{pid}/current.json')
            layout = read_json(inside(root, read_json(current)['layout'])) if current.is_file() else {'panels': []}
            if not isinstance(layout, dict) or not isinstance(layout.get('panels'), list): raise ValueError('Invalid panel layout')
            rows = {}
            for panel in layout['panels']:
                if not isinstance(panel, dict) or not isinstance(panel.get('panel_id'), str): raise ValueError('Invalid panel identity')
                folder = inside(root, panel['folder'])
                if not folder.is_relative_to(root / 'pages' / pid): raise ValueError('Panel belongs to another page')
                rows[panel['folder']] = (panel['panel_id'], pid)
            layouts[pid] = layout; active.update(rows)
        except (ValueError, OSError, KeyError, TypeError) as error:
            layouts[pid] = {'panels': []}
            page_errors[pid] = f'Cannot read active layout: {error}'
            warnings.append(f'{pid}: {page_errors[pid]}. Repair this page in H3 Animator, then refresh.')
    sequence_error = None
    try:
        raw_pairs = read_json(pairs_file).get('pairs', []) if pairs_file.exists() else []
        if not isinstance(raw_pairs, list) or any(not isinstance(p, dict) or not isinstance(p.get('endpoints'), list)
                or any(not isinstance(e, dict) for e in p['endpoints']) for p in raw_pairs):
            raise ValueError('Invalid joined-panel selections')
    except (ValueError, OSError, TypeError, AttributeError) as error:
        raw_pairs = []; sequence_error = f'Cannot read joined-panel selections: {error}'
        warnings.append(sequence_error + '. Repair flf_sequence.json before processing main takes.')
    pairs, consumed = {}, set()
    for pair in raw_pairs:
        endpoints = pair.get('endpoints', [])
        if (len(endpoints) != 2 or not re.fullmatch(r'flf_[a-f0-9]{16}', str(pair.get('variant', '')))
                or any(not isinstance(e.get('folder'), str) or e.get('folder') not in active or active[e['folder']][0] != e.get('panel_id') for e in endpoints)
                or endpoints[0]['folder'] == endpoints[1]['folder']):
            warnings.append('A joined-panel selection no longer matches the active layout. Reselect it in H3 Animator.')
            continue
        first, last = (e['folder'] for e in endpoints)
        if {first, last} & (set(pairs) | consumed):
            warnings.append('Overlapping joined-panel selections were skipped. Reselect them in H3 Animator.')
            continue
        pairs[first] = pair
        consumed.add(last)

    def image_version(relative):
        if not relative: return None
        try:
            stat = inside(root, relative).stat()
            return f'{stat.st_mtime_ns}:{stat.st_size}'
        except (ValueError, OSError):
            return None

    for page in sorted(project['pages'], key=lambda p: p['order']):
        pid = page['page_id']
        # Removed pages and retired layouts must never reappear as pending videos.
        layout = layouts[pid]
        page_clips = []
        # Current layouts are authoritative while H3 is still exporting index.json.
        for position, panel in enumerate(layout['panels']):
            folder = inside(root, panel['folder'])
            pair = pairs.get(panel['folder'])
            in_sequence = panel['folder'] not in consumed
            reference = next((name for name in ('clean_reference.png', 'reference.png', 'source.png') if (folder / name).is_file()), None)
            image = (folder / reference).relative_to(root).as_posix() if reference else None
            panels.append(dict(id=panel['panel_id'], page_id=pid, order=position,
                               image=image, image_version=image_version(image), folder=panel['folder'], joined_into=next((active[f][0] for f, p in pairs.items() if p['endpoints'][1]['folder'] == panel['folder']), None)))
            committed, eligible = [], []
            markers = [p for p in (folder / 'takes').glob('take_*/render.json') if re.fullmatch(r'take_\d+', p.parent.name)]
            for marker in sorted(markers, key=lambda p: int(p.parent.name[5:]), reverse=True):
                if (marker.parent / 'error.json').exists():
                    continue
                try:
                    render = read_json(inside(root, marker.relative_to(root).as_posix()))
                    if not isinstance(render, dict): raise ValueError('Expected an object')
                    if render.get('panel_id') != panel['panel_id']:
                        raise ValueError('The render belongs to a different panel')
                    variants = render.get('variants') or {'bubbles_on': render.get('video')}
                    if not isinstance(variants, dict): raise ValueError('Invalid video variants')
                    settings = render.get('settings', {})
                    if not isinstance(settings, dict): raise ValueError('Invalid render settings')
                except (ValueError, OSError) as error:
                    warnings.append(f'Skipped {marker.relative_to(root)}: {error}')
                    continue
                available = {}
                for variant, filename in [('bubbles_off', 'video_clean.mp4'), ('bubbles_on', 'video.mp4')]:
                    relative = f'takes/{marker.parent.name}/{filename}'
                    if variants.get(variant) == relative:
                        unresolved = folder / relative
                        if unresolved.is_symlink(): continue
                        video = inside(root, unresolved.relative_to(root).as_posix())
                        if video == unresolved and video.is_file():
                            available[variant] = video.relative_to(root).as_posix()
                if not available:
                    continue
                if settings.get('bubble_mode') == 'switchable' and set(available) != {'bubbles_on', 'bubbles_off'}:
                    warnings.append(f'Skipped incomplete switchable take {marker.parent.relative_to(root)}; both video variants are required by H3 Animator.')
                    continue
                variant = 'bubbles_off' if 'bubbles_off' in available else 'bubbles_on'
                name = available[variant]
                position_key = settings.get('reference_position', 'first')
                joined = bool(re.fullmatch(r'flf_[a-f0-9]{16}', str(position_key)))
                assembly = not sequence_error and in_sequence and (position_key == pair['variant'] if pair else not (pairs_file.exists() and joined))
                sources = pair['endpoints'] if pair and assembly else [dict(folder=panel['folder'], panel_id=panel['panel_id'])]
                mode = 'flf' if joined else settings.get('render_mode', 'animated')
                data = dict(page_id=pid, page_order=page['order'], panel_id=panel['panel_id'],
                            panel_order=position, take=marker.parent.name, variant=variant,
                            variants=available, latest=not committed, main=False, in_sequence=assembly,
                            source_panel_ids=[e['panel_id'] for e in sources],
                            source_page_ids=list(dict.fromkeys(active[e['folder']][1] for e in sources)),
                            selection_error=sequence_error, render_mode=mode, loop=settings.get('loop_video') is True,
                            reference_position=position_key,
                            label=f"Page {page['order'] + 1} · Panel {position + 1} · {marker.parent.name}")
                if joined: data['label'] += ' · Joined panels'
                elif mode == 'still': data['label'] += ' · Still / camera motion'
                elif data['loop']: data['label'] += ' · Loop'
                clips[name] = data
                committed.append(name)
                if assembly: eligible.append(name)
            selection = folder / 'main_take.json'
            chosen = None
            if selection.exists():
                try: chosen = read_json(inside(root, selection.relative_to(root).as_posix()))['take_id']
                except (ValueError, OSError, KeyError, TypeError) as error:
                    warnings.append(f'Invalid main take selection in {panel["folder"]}; using the newest eligible take: {error}')
            main = next((name for name in eligible if clips[name]['take'] == chosen), next(iter(eligible), None))
            if main:
                clips[main]['main'] = True
                clips[main]['label'] += ' · H3 main'
            page_clips.extend(committed)
        pages.append(dict(id=pid, order=page['order'], name=page.get('source_name', pid),
                          image=page['image'], image_version=image_version(page['image']), error=page_errors.get(pid), panels=len(layout['panels']), videos=len(page_clips)))
    result = dict(title=root.name, pages=pages, panels=panels, clips=clips, warnings=warnings)
    CATALOGUES[str(root)] = stamp, result
    return result


def export_scripts(scripts, duration_ms):
    """Validate H3 sidecars against FunCiv's manga motion contract."""
    from .core import validate_actions, AXES
    if not isinstance(scripts, dict) or set(scripts)-set(AXES): raise ValueError('Invalid H3 script axes.')
    if 'L0' not in scripts:
        raise ValueError('FunCiv needs a Main L0 script. Enable the stroke axis before approving.')
    duration = max(1, round(duration_ms))
    result = {}
    for axis, script in scripts.items():
        actions = validate_actions(script['actions'])
        if len(actions) > 500000 or actions[-1]['at'] > duration_ms + 50:
            raise ValueError(f'{axis} does not fit this video for FunCiv. Keep at most 500,000 actions inside the video duration before approving.')
        # One key means a constant hold in Motion Studio; FunCiv needs two keys.
        if len(actions) == 1:
            actions = [{'at': 0, 'pos': actions[0]['pos']}, {'at': duration, 'pos': actions[0]['pos']}]
        result[axis] = {**script, 'actions': actions}
    return result


def decisions(root):
    path = Path(root) / STATE_FILE
    if path.is_symlink():
        raise ValueError('The H3 funscript review file must not be a link.')
    defaults = {'version': 1, 'excluded_pages': [], 'excluded_videos': [], 'excluded_panels': [], 'confidence': .15}
    if not path.exists(): return defaults
    try:
        saved = read_json(path)
        if not isinstance(saved, dict): raise ValueError('Expected an object')
        state = {**defaults, **saved}
        if type(state['version']) is not int or state['version'] != 1: raise ValueError('Unsupported version')
        for key in ('excluded_pages', 'excluded_videos', 'excluded_panels'):
            if not isinstance(state[key], list) or any(not isinstance(value, str) or not value for value in state[key]):
                raise ValueError(f'{key} must be a list of IDs or paths')
        if any(not re.fullmatch(r'page_\d+', value) for value in state['excluded_pages']):
            raise ValueError('Invalid excluded page ID')
        for value in state['excluded_videos']: inside(Path(root).resolve(), value)
        validate_confidence(state['confidence'])
        presets = state.get('presets', {})
        if not isinstance(presets, dict): raise ValueError('Presets must be an object')
        from .folder_review import preset_settings
        for settings in presets.values():
            if not isinstance(settings, dict): raise ValueError('Invalid processing preset')
            validate_confidence(settings.get('confidence', state['confidence']))
            preset_settings({k:v for k,v in settings.items() if k != 'confidence'})
        return state
    except ValueError as error:
        raise ValueError(f'Invalid H3 funscript review file {path.name}: {error}. The file has been kept unchanged.') from error


def validate_confidence(confidence):
    if type(confidence) not in (int, float) or not math.isfinite(confidence) or not .05 <= confidence <= 1:
        raise ValueError('Person confidence must be between 0.05 and 1.')


def set_confidence(root, confidence):
    validate_confidence(confidence)
    state = decisions(root); state['confidence'] = confidence
    if 'project' in state.get('presets', {}): state['presets']['project']['confidence'] = confidence
    atomic_json(Path(root) / STATE_FILE, state)


def exclude(root, *, page=None, panel=None, video=None, excluded=True):
    if type(excluded) is not bool or sum(bool(v) for v in (page, panel, video)) != 1:
        raise ValueError('Choose one page, panel or video to exclude or restore.')
    book = catalogue(root)
    if (page and page not in {p['id'] for p in book['pages']} or panel and panel not in {p['id'] for p in book['panels']}
            or video and video not in book['clips']):
        raise ValueError('This page or video is no longer in the active H3 project.')
    state = decisions(root)
    key, value = ('excluded_pages', page) if page else ('excluded_panels', panel) if panel else ('excluded_videos', video)
    items = set(state.get(key, []))
    # Both variants belong to one take; switching the available video must not
    # silently undo an exclusion or make it impossible to restore.
    if video: items = {item for item in items if Path(item).parent != Path(video).parent}
    if excluded: items.add(value)
    else: items.discard(value)
    state[key] = sorted(items)
    atomic_json(Path(root) / STATE_FILE, state)


def image_path(root, *, page=None, panel=None):
    book = catalogue(root)
    rows, identifier = (book['panels'], panel) if panel else (book['pages'], page)
    row = next((r for r in rows if r['id'] == identifier), None)
    if not row or not row.get('image'): raise ValueError('No image for this active page or panel.')
    return inside(Path(root), row['image'])


def probe(source, confidence=.15, *, cancelled=None):
    """Seek to three bounded samples and reuse a serialized CPU detector."""
    from PIL import Image
    from .automatic import PersonDetector, detector_path
    from .reference import source_info
    from .video import video_frames
    global PROBE_DETECTOR
    def check():
        if cancelled is not None and cancelled.is_set(): raise ValueError('Detector check cancelled.')
    samples = []
    with PROBE_LOCK:
        check()
        path = detector_path()
        key = (str(path), Path(path).stat().st_mtime_ns if Path(path).exists() else None, confidence)
        if PROBE_DETECTOR is None or PROBE_DETECTOR[0] != key:
            PROBE_DETECTOR = key, PersonDetector(path, confidence=confidence)
        detector = PROBE_DETECTOR[1]
        def sample(rgb, at_ms):
            check(); people = detector(rgb); check()
            image = Image.fromarray(rgb); image.thumbnail((640, 640))
            output = io.BytesIO(); image.save(output, format='JPEG', quality=85)
            samples.append(dict(at_ms=at_ms, people=people,
                image='data:image/jpeg;base64,' + base64.b64encode(output.getvalue()).decode('ascii')))
        if Path(source).suffix.lower() in ('.png', '.jpg', '.jpeg', '.webp'):
            import numpy as np
            with Image.open(source) as image: sample(np.asarray(image.convert('RGB')), None)
        else:
            try: info = source_info(source)
            except StopIteration as error: raise ValueError('The video contains no decodable frames.') from error
            seen = set()
            for fraction in (.1, .5, .9):
                check()
                # video_frames seeks to the preceding keyframe and stops at the
                # requested sample, instead of decoding the whole long take.
                with closing(video_frames(source, sample_fps=0, start_seconds=info['end_ms']*fraction/1000, max_frames=2)) as frames:
                    frame = next(frames, None)
                if frame is None: continue
                rgb, timing = frame
                if timing['time_ms'] not in seen:
                    sample(rgb, timing['time_ms']); seen.add(timing['time_ms'])
            if not samples:
                with closing(video_frames(source, sample_fps=0, max_frames=2)) as frames:
                    frame = next(frames, None)
                if frame is None: raise ValueError('The video contains no decodable frames.')
                sample(frame[0], frame[1]['time_ms'])
    return dict(samples=samples, confidence=confidence, message='Person boxes only. Use a short tracking trial to inspect the pose and motion on this drawing.')


def preset(root, *, page=None, panel=None, settings=None):
    """Project defaults, then page and panel overrides; independent of take paths."""
    from .folder_review import DEFAULT_PRESET, preset_settings
    book = catalogue(root)
    row = next((p for p in book['panels'] if p['id'] == panel), None) if panel else None
    if panel and row is None: raise ValueError('Choose an active panel.')
    if panel: page = row['page_id']
    if page and page not in {p['id'] for p in book['pages']}: raise ValueError('Choose an active page.')
    state = decisions(root)
    scopes = ['project', *(['page:'+page] if page else []), *(['panel:'+panel] if panel else [])]
    if settings is not None:
        if not isinstance(settings, dict): raise ValueError('Invalid H3 preset')
        values = dict(settings); confidence = values.pop('confidence', state['confidence'])
        validate_confidence(confidence); values = preset_settings(values)
        state.setdefault('presets', {})[scopes[-1]] = {**values, 'confidence': confidence}
        if scopes[-1] == 'project': state['confidence'] = confidence
        atomic_json(Path(root) / STATE_FILE, state)
    result = {**DEFAULT_PRESET, 'confidence':state['confidence']}
    for key in scopes: result.update(state.get('presets', {}).get(key, {}))
    validate_confidence(result['confidence'])
    preset_settings({k:v for k,v in result.items() if k != 'confidence'})
    return dict(scope=scopes[-1], settings=result, overridden=scopes[-1] in state.get('presets', {}),
                inherited_from=next((key for key in reversed(scopes) if key in state.get('presets', {})), None))


def loop_issues(project, duration_ms):
    """Inspect position and velocity continuity; never change authored motion."""
    issues = []
    for axis, script in (project or {}).get('scripts', {}).items():
        if axis not in project.get('config', {}).get('enabled_axes', project.get('scripts', {})): continue
        actions = script.get('actions', [])
        if len(actions) < 2: continue
        first, second, previous, last = actions[0], actions[1], actions[-2], actions[-1]
        velocity = lambda a,b: (b['pos']-a['pos'])*1000/max(1,b['at']-a['at'])
        jump = abs(first['pos']-last['pos'])
        delta = abs(velocity(first,second)-velocity(previous,last))
        if jump >= 10 or delta >= 80:
            reason = f'{axis} loop seam · {jump:.1f} position jump · {delta:.1f}/s velocity change'
            for a,b in ((0,min(750,duration_ms)), (max(0,duration_ms-750),duration_ms)):
                issues.append(dict(reason=reason,start_ms=a,end_ms=b,track=None))
    return issues


def tracking_trial(info, request, model_file, directory, *, interrupt=None, progress=None):
    """Two seconds of real extraction in an isolated workspace; never publishes Main."""
    import tempfile
    from .processing_timeline import normalize_plan, run_timeline
    from .folder_review import ANCHORS
    if not isinstance(request, dict) or request.get('anchor') not in ANCHORS:
        raise ValueError('Choose a supported anchor for the drawing trial.')
    at = request.get('at_ms', 0)
    if type(at) not in (int,float) or not math.isfinite(at) or not 0 <= at < info['end_ms']:
        raise ValueError('Choose a frame inside this take.')
    start = max(0, min(at, info['end_ms']-2000)); end = min(info['end_ms'], start+2000)
    plan = normalize_plan({'tracking':[dict(id='h3_trial',name='Drawing trial',start_ms=start,end_ms=end,
        rois=[request.get('roi')],person=0,anchor=request['anchor'],isolate_subject=True,smoothing_ms=30)],'stabilization':[]},info)
    with tempfile.TemporaryDirectory(prefix='h3-trial-', dir=directory) as temporary:
        project, report = run_timeline(info, plan, Path(temporary), model_file, sample_fps=6, batch_size=2,
                                      interrupt=interrupt, progress=progress)
    if project is None: raise ValueError('No motion was extracted. Inspect the person rectangle or choose another anchor.')
    sources = project.get('timeline',{}).get('sources',[])
    geometry = sources[0]['data'] if sources else project
    from PIL import Image
    from .video import video_frames
    images = []
    with closing(video_frames(info['source']['path'], sample_fps=6, start_seconds=start/1000, duration_seconds=(end-start)/1000, max_frames=14)) as frames:
        for rgb,timing in frames:
            if interrupt: interrupt()
            image = Image.fromarray(rgb); image.thumbnail((480,480)); output=io.BytesIO(); image.save(output, format='JPEG', quality=75)
            images.append(dict(at_ms=timing['time_ms'], image='data:image/jpeg;base64,'+base64.b64encode(output.getvalue()).decode('ascii')))
    return dict(source_id=info['source_id'], start_ms=start, end_ms=end, anchor=request['anchor'], images=images,
                scripts=project['scripts'], times_ms=geometry.get('times_ms',[]), pixels=geometry.get('pixels',[]),
                width=info['width'],height=info['height'], warnings=report.get('warnings',[]))


def draft_path(root, metadata):
    panel, take, variant = (metadata[k] for k in ('panel_id','take','variant'))
    if not re.fullmatch(r'page_\d+_panel_\d+', panel) or not re.fullmatch(r'take_\d+', take) or variant not in ('bubbles_on','bubbles_off'):
        raise ValueError('Invalid portable draft identity.')
    path = Path(root) / '.s3f-drafts' / panel / f'{take}-{variant}.json'
    if any(p.is_symlink() for p in (path, path.parent, path.parent.parent)):
        raise ValueError('Portable drafts cannot use linked files or directories.')
    return path


def video_digest(path):
    import hashlib
    with Path(path).open('rb') as source: return hashlib.file_digest(source, 'sha256').hexdigest()
