"""Folder presets and explainable review hints; ratings remain user-authored."""
from copy import deepcopy
from pathlib import Path
import importlib.util
import math

ANCHORS = ('mouth', 'pelvis', 'left_hand', 'right_hand')
DEFAULT_PRESET = dict(preferred_anchor='auto', smoothing_ms=30, range_mode='adaptive', movement_range=.2,
                      sample_fps=0, batch_size=8, cut_sensitivity='normal')


def subfolder_name(value):
    if not isinstance(value, str) or Path(value).is_absolute() or '..' in Path(value).parts:
        raise ValueError('Choose a subfolder inside the registered folder.')
    return value.strip('/')


def preset_settings(raw):
    if not isinstance(raw, dict) or set(raw)-set(DEFAULT_PRESET): raise ValueError('Invalid folder preset fields')
    result = {**DEFAULT_PRESET, **raw}
    if result['preferred_anchor'] not in ('auto', *ANCHORS): raise ValueError('Choose an automatic anchor or one of the four candidates.')
    if result['range_mode'] not in ('adaptive', 'fixed'): raise ValueError('Choose adaptive or fixed movement range.')
    if result['cut_sensitivity'] not in ('low', 'normal', 'high'): raise ValueError('Invalid cut sensitivity')
    for key, low, high in [('smoothing_ms', 0, 2000), ('movement_range', .001, 10), ('sample_fps', 0, 120), ('batch_size', 1, 128)]:
        value=result[key]
        if type(value) not in (int,float) or not math.isfinite(value) or not low <= value <= high: raise ValueError(f'Invalid preset {key}')
    if type(result['batch_size']) is not int: raise ValueError('Batch size must be an integer')
    return result


def apply_preset(plan, raw):
    settings=preset_settings(raw); result=deepcopy(plan)
    for region in result['tracking']:
        if not region.get('automatic') or region['locked']: continue
        region['smoothing_ms']=settings['smoothing_ms']
        region['automatic']['preferred_anchor']=settings['preferred_anchor']
        if settings['range_mode']=='fixed':
            axes=region.setdefault('settings',{}).setdefault('axis_settings',{})
            for axis in ('L0','L1','L2'):
                axes.setdefault(axis,{}).update(range=settings['movement_range'],auto_fit=False,calibration='clip')
        else:
            axes=region.setdefault('settings',{}).setdefault('axis_settings',{})
            for axis in ('L0','L1','L2'): axes.setdefault(axis,{}).update(auto_fit=True,calibration='adaptive')
    return result


def preflight(settings, *, needs_tracker=False):
    import folder_paths
    from .automatic import detector_path
    checks=[]; errors=[]
    for category,key,label in [('detection','model_file','SAM3D model'), *([('cotracker','tracker_model','Stabilization tracker')] if needs_tracker else [])]:
        name=settings.get(key,''); path=folder_paths.get_full_path(category,name) if name else None
        if not path or not Path(path).is_file(): errors.append(f'{label} is missing: {name or "choose a model on the node"}')
        else: checks.append(f'{label}: {Path(path).name}')
    try: checks.append('Person detector: '+detector_path().name)
    except (ValueError,OSError) as error: errors.append(str(error))
    if importlib.util.find_spec('ultralytics') is None: errors.append('Install ultralytics in the ComfyUI Python environment.')
    return dict(ok=not errors, checks=checks, errors=errors)


def review_issues(project, state=None):
    """Ranges to inspect, never a correctness score or an automatic star rating."""
    state=state or {}; duration=(project or {}).get('metadata',{}).get('duration_ms',state.get('info',{}).get('end_ms',1))
    issues=[]; seen=set()
    def add(reason,start=0,end=None,track=None):
        start=max(0,float(start));end=min(duration,float(end if end is not None else duration))
        if end<=start: return
        key=(reason,round(start),round(end),track)
        if key in seen or len(issues)>=150:return
        seen.add(key);issues.append(dict(reason=reason,start_ms=start,end_ms=end,track=track))
    for region in state.get('plan',{}).get('tracking',[]):
        for reason in region.get('automatic',{}).get('review',[]):add(reason,region['start_ms'],region['end_ms'])
    for row in (state.get('report') or {}).get('regions',[]):
        region=next((r for r in state.get('plan',{}).get('tracking',[]) if r['id']==row['id']),{})
        for reason in [*row.get('review',[]), *([row['error']] if row.get('error') else [])]:add(reason,region.get('start_ms',0),region.get('end_ms'))
    if not project:return issues
    timeline=project.get('timeline',{});latest=set(timeline.get('latest',{}).values())
    for source in timeline.get('sources',[]):
        if latest and source['id'] not in latest:continue
        data=source['data'];metadata=data.get('metadata',{});region=metadata.get('processing_region',{})
        if metadata.get('processing_anchor',{}).get('primary') is False:continue
        track=next((t['id'] for t in timeline.get('tracks',[]) if t['source']==source['id'] and t['axis']=='L0'),None)
        start=region.get('start_ms',data.get('times_ms',[0])[0]);end=region.get('end_ms',data.get('times_ms',[duration])[-1])
        for reason in metadata.get('automatic_candidate',{}).get('review',[]):add(reason,start,end,track)
        if data.get('metrics',{}).get('L0',{}).get('clipped_fraction',0)>.05:add('More than 5% of movement is clipped',start,end,track)
        times=data.get('times_ms',[]);valid=data.get('valid',[]);missing=None
        for i,(at,good) in enumerate(zip(times,valid)):
            if not good and missing is None:missing=at
            if missing is not None and (good or i==len(times)-1):
                if at-missing>=200:add('Missing tracking samples',missing,at,track)
                missing=None
    cuts=(state.get('scene_cuts') or {}).get('times_ms',[])
    actions=project.get('scripts',{}).get('L0',{}).get('actions',[])
    for a,b in zip(actions,actions[1:]):
        if b['at']-a['at']<=150 and abs(b['pos']-a['pos'])>=55 and not any(a['at']-80<=cut<=b['at']+80 for cut in cuts):
            add('Sudden movement jump',max(0,a['at']-250),min(duration,b['at']+250))
    # Report sustained flat ranges, including scripts sampled densely.
    if actions:
        start=actions[0]['at'];lo=hi=actions[0]['pos']
        for i,action in enumerate(actions[1:],1):
            if max(hi,action['pos'])-min(lo,action['pos'])>5:
                end=actions[i-1]['at']
                if end-start>=2000:add('Little movement — check whether the scene is still',start,end)
                start=action['at'];lo=hi=action['pos']
            else:lo=min(lo,action['pos']);hi=max(hi,action['pos'])
        if actions[-1]['at']-start>=2000:add('Little movement — check whether the scene is still',start,actions[-1]['at'])
    return sorted(issues,key=lambda item:(item['start_ms'],item['end_ms'],item['reason']))
