"""ComfyUI execution boundary for video-region processing plans."""
import hashlib
import json
from pathlib import Path
import re

import folder_paths

from .sam3d_funscript.core import export_project, load_project
from .sam3d_funscript.editor import EditorStore
from .sam3d_funscript.processing_store import ProcessingStore, PlanConflict
from .sam3d_funscript.reference import source_info, digest
from .sam3d_funscript.video import video_input_range


def motion_editor_session(workflow, node_id, timeline_session):
    """Share a sole direct standalone consumer; ambiguous branches stay separate."""
    nodes = {str(node["id"]): node for node in workflow.get("nodes", [])}
    if nodes.get(str(node_id), {}).get('type') in ('S3F_FolderTimeline', 'S3F_H3ProjectTimeline'):
        from .sam3d_funscript.folder_store import motion_session
        return motion_session(timeline_session)
    candidates = []
    for link in workflow.get("links", []):
        if not isinstance(link, list) or len(link) < 6 or str(link[1]) != str(node_id) or link[2] != 0:
            continue
        target = nodes.get(str(link[3]))
        if not target or target.get("type") != "S3F_StandaloneExport" or target.get("mode", 0) != 0:
            continue
        inputs = target.get("inputs", [])
        if link[4] >= len(inputs) or not inputs[link[4]]["name"].startswith("project"):
            continue
        # An editor_session input owns this standalone view and ignores projects.
        if any(port.get("name") == "editor_session" and port.get("link") is not None for port in inputs):
            continue
        projects = [port for port in inputs if port.get("name", "").startswith("project") and port.get("link") is not None]
        if len(projects) != 1:
            continue
        candidate = target.get("properties", {}).get("s3f_session")
        if isinstance(candidate, str) and re.fullmatch(r"[a-f0-9-]{32,36}", candidate):
            candidates.append(candidate)
    if len(candidates) == 1:
        return candidates[0]
    return hashlib.sha256(f"{timeline_session}:motion".encode()).hexdigest()[:32]


def publish_motion(project, session, output_root, timeline_state=None, *, preserve_main=False):
    if timeline_state is not None:
        metadata = project["metadata"]
        metadata.setdefault("processing_timeline", {})["session"] = timeline_state["session"]
        cuts = timeline_state.get("scene_cuts")
        if cuts and cuts.get("source_id") == timeline_state["info"]["source_id"]:
            metadata["scene_cuts"] = cuts
        else:
            metadata.pop("scene_cuts", None)
    for main in project.get("timeline", {}).get("main", {}).values():
        if not main.get("edited"):
            main["processing_generated"] = True
    path, _ = EditorStore(output_root).export(session, project, lambda data: export_project(data, output_root, "timeline"), preserve_main=preserve_main)
    return path


def bind_motion_editor(store, state, session, output_root):
    previous_session = state.get("editor_session")
    if previous_session and previous_session != session and state.get("project_path"):
        previous = EditorStore(output_root).read(previous_session)
        if previous:
            # A newly connected standalone adopts the latest saved edits, which
            # can be newer than the last exported project.json on disk.
            path = publish_motion(previous["project"], session, output_root, state)
            return store.bind_editor(state["session"], session, path)
    return store.bind_editor(state["session"], session)


class S3F_ProcessingTimeline:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "video": ("VIDEO", {"tooltip": "Core Load Video or Trim Video. Plan regions on the original source timeline."}),
            "model_file": (folder_paths.get_filename_list("detection"),),
            "sample_fps": ("FLOAT", {"default": 0, "min": 0, "max": 120, "step": 1, "tooltip": "0 analyzes every source frame. Original timestamps are retained."}),
            "batch_size": ("INT", {"default": 8, "min": 1, "max": 128}),
            "tracker_model": (folder_paths.get_filename_list("cotracker") or ["cotracker3_scaled_online.pth"],),
            "operation": (["prepare", "automatic", "all", "selected", "unfinished", "detect_cuts", "stabilize", "propagate_mask", "extract_anchors", "preview_anchor", "seed_mask"], {"default": "prepare", "tooltip": "Automatic fills uncovered scenes with person crops and four anchor candidates. Prepare opens/restores the editor. Stabilize runs without SAM3D."}),
            "plan_json": ("STRING", {"default": "{}", "multiline": True, "tooltip": "The timeline editor saves its source-bound regions and revision here. Blank or {} reuses the saved plan; a new session starts with a full-video region."}),
            "use_cache": ("BOOLEAN", {"default": True}),
        }, "optional": {"mask_video": ("VIDEO", {"tooltip": "Optional person mask matching the original video. Used by tracking regions."}),
            "cut_sensitivity": (["normal", "low", "high"], {"default": "normal", "tooltip": "Hard-cut detection sensitivity. High finds smaller changes; low reduces extra markers."})},
            "hidden": {"unique_id": "UNIQUE_ID", "extra_pnginfo": "EXTRA_PNGINFO"}}

    RETURN_TYPES = ("S3F_MOTION_PROJECT", "STRING")
    RETURN_NAMES = ("project", "timeline_path")
    FUNCTION = "run"
    CATEGORY = "motion/SAM3D Funscript"
    OUTPUT_NODE = True

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")  # Saved plans/results can change in the dedicated editor.

    def run(self, video, model_file, sample_fps=0, batch_size=8,
            tracker_model="cotracker3_scaled_online.pth", operation="prepare", plan_json="{}",
            use_cache=True, mask_video=None, unique_id=None, extra_pnginfo=None, cut_sensitivity="normal"):
        from comfy_execution.graph import ExecutionBlocker
        from comfy.model_management import throw_exception_if_processing_interrupted, InterruptProcessingException
        from server import PromptServer
        from .sam3d_funscript.processing_timeline import run_timeline, parse_plan

        if operation not in ("prepare", "automatic", "all", "selected", "unfinished", "detect_cuts", "stabilize", "propagate_mask", "extract_anchors", "preview_anchor", "seed_mask"):
            raise ValueError("Unknown timeline processing operation")
        submitted = parse_plan(plan_json)
        path, start, duration = video_input_range(video)
        info = source_info(path, start, duration)
        workflow = (extra_pnginfo or {}).get("workflow", {})
        node = next((n for n in workflow.get("nodes", []) if str(n["id"]) == str(unique_id)), {})
        session = node.get("properties", {}).get("s3f_timeline_session")
        if not session:
            session = hashlib.sha256(f"{info['source_id']}:{unique_id}".encode()).hexdigest()[:32]
        output_root = Path(folder_paths.get_output_directory()) / "sam3d_funscript"
        store = ProcessingStore(output_root / "processing")
        prior = store.read(session)
        if operation != "prepare" and prior and isinstance(submitted, dict) and "revision" in submitted:
            if submitted["revision"] != prior["revision"]:
                raise PlanConflict("This plan changed after the job was queued. Reload the latest timeline and process again.")
        state = store.prepare(session, info, submitted)
        automatic_report = None
        stabilization_errors = {}
        stabilization_reviews = {}
        if operation == 'automatic':
            from .sam3d_funscript.automatic import prepare_automatic, prepare_mask_references, run_prepared_stabilization
            from .sam3d_funscript.scene_cuts import detect_cuts
            if mask_video is not None:
                raise ValueError('Automatic person discovery uses the original video. Disconnect the single-person mask input for this pass.')
            revision = state['revision']
            def auto_progress(event):
                store.progress(session, revision, event)
                PromptServer.instance.send_sync('s3f_timeline_progress', {'session': session, **event})
            try:
                cuts = state.get('scene_cuts')
                if not cuts or cuts.get('source_id') != info['source_id']:
                    expected_cuts = digest(cuts)
                    cuts = detect_cuts(info, output_root/'cut_cache', cut_sensitivity, use_cache,
                        progress=auto_progress, interrupt=throw_exception_if_processing_interrupted)
                    state = store.update_cuts(session, info['source_id'], cuts, expected=expected_cuts, preserve_manual=True)
                    cuts = state['scene_cuts']
                options = submitted.get('automatic_options', {})
                if not isinstance(options, dict): raise ValueError('Invalid automatic mode options')
                stabilization_mode = options.get('stabilization', 'prepared_masks')
                if stabilization_mode not in ('prepared_masks', 'existing'):
                    raise ValueError('Invalid automatic stabilization mode')
                plan, automatic_report = prepare_automatic(info, state['plan'], cuts, store.directory(session),
                    replace_default=not state.get('report') and (state.get('editor_only') or not state.get('project_path')),
                    people_mode=options.get('people', 'all'), confidence=options.get('confidence', .4), min_track_confidence=options.get('min_track_confidence', .45), use_cache=use_cache, progress=auto_progress,
                    interrupt=throw_exception_if_processing_interrupted)
                if options.get('folder_preset'):
                    from .sam3d_funscript.folder_review import apply_preset
                    plan = apply_preset(plan, options['folder_preset'])
                if stabilization_mode == 'prepared_masks':
                    plan, prepared = prepare_mask_references(info, plan)
                state = store.save(session, revision, plan)
                revision = state['revision']
                if stabilization_mode == 'prepared_masks' and prepared['regions']:
                    stabilization_report = run_prepared_stabilization(info, state['plan'], store.directory(session),
                        folder_paths.get_full_path('cotracker', tracker_model), prepared, use_cache=use_cache,
                        progress=auto_progress, interrupt=throw_exception_if_processing_interrupted)
                    stabilization_errors = stabilization_report['errors']
                    stabilization_reviews = stabilization_report['review']
                    state = store.stabilization_progress(session, revision, {'stage':'complete'}, stabilization_report)
                    automatic_report['stabilization'] = stabilization_report
                auto_progress({'stage': 'auto_ready', **automatic_report})
            except (Exception, InterruptProcessingException) as error:
                auto_progress({'stage': 'error', 'error': str(error) or 'Automatic planning cancelled'})
                raise
            # Only automatic scenes are queued here. Other saved regions remain
            # available to the assembly but are not newly processed by this pass.
            submitted['processing_scope'] = {'kind': 'regions', 'ids': [r['id'] for r in state['plan']['tracking'] if r.get('automatic') and r['enabled']]}
            operation = 'selected' if submitted['processing_scope']['ids'] else 'prepare'
        if operation == 'seed_mask':
            from .sam3d_funscript.mask_seed import seed_mask
            seed = seed_mask(info, state['plan'], submitted.get('mask_seed'), store.directory(session),
                use_cache=use_cache, interrupt=throw_exception_if_processing_interrupted,
                progress=lambda event: PromptServer.instance.send_sync('s3f_timeline_progress', {'session': session, **event}))
            return {'ui': {'s3f_timeline': [session], 's3f_timeline_status': ['Initial mask ready · review with Paint / Erase'],
                           's3f_mask_seed': [seed], 's3f_timeline_project': [state.get('project')]},
                    'result': (ExecutionBlocker(None), str(store.directory(session) / 'timeline.json'))}
        if operation == 'preview_anchor':
            from .sam3d_funscript.anchor_preview import preview_anchor
            preview = preview_anchor(info, state['plan'], submitted.get('anchor_preview'), model_file,
                store.directory(session), use_cache=use_cache,
                mask_video_range=video_input_range(mask_video) if mask_video is not None else None,
                interrupt=throw_exception_if_processing_interrupted,
                progress=lambda event: PromptServer.instance.send_sync('s3f_timeline_progress', {'session': session, **event}))
            return {'ui': {'s3f_timeline': [session], 's3f_timeline_status': [f"Anchor preview ready · frame {preview['frame']}"],
                           's3f_anchor_preview': [preview], 's3f_timeline_project': [state.get('project')]},
                    'result': (ExecutionBlocker(None), str(store.directory(session) / 'timeline.json'))}
        if operation == "detect_cuts":
            from .sam3d_funscript.scene_cuts import detect_cuts
            expected_cuts = digest(state.get('scene_cuts'))

            def cut_progress(event):
                store.update_cuts(session, info["source_id"], progress=event)
                PromptServer.instance.send_sync("s3f_timeline_progress", {"session": session, **event})

            try:
                cut_progress({"stage": "scene_cuts", "frames": 0, "cuts": 0})
                cuts = detect_cuts(info, output_root / "cut_cache", cut_sensitivity, use_cache,
                                   progress=cut_progress, interrupt=throw_exception_if_processing_interrupted)
                state = store.update_cuts(session, info["source_id"], cuts, {"stage": "complete"}, expected=expected_cuts, preserve_manual=True)
                cuts = state['scene_cuts']
            except (Exception, InterruptProcessingException) as error:
                store.update_cuts(session, info["source_id"], progress={"stage": "error", "error": str(error) or "Cut detection cancelled"})
                raise
            summary = f"{len(cuts['times_ms'])} hard-cut markers ready." + (" Scan cache reused." if cuts["cache_hit"] else "")
            return {"ui": {"s3f_timeline": [session], "s3f_timeline_status": [summary],
                           "s3f_timeline_project": [state.get("project")]},
                    "result": (ExecutionBlocker(None), str(store.directory(session) / "timeline.json"))}
        if operation in ("stabilize", "propagate_mask"):
            from .sam3d_funscript.processing_timeline import run_stabilization, run_mask_propagation
            revision = state["revision"]
            last_marker = None

            def tracking_progress(event):
                nonlocal last_marker
                PromptServer.instance.send_sync("s3f_timeline_progress", {"session": session, "revision": revision, **event})
                marker = (event.get("region_id"), event.get("completed_jobs"))
                if marker != last_marker:
                    store.stabilization_progress(session, revision, event)
                    last_marker = marker

            try:
                worker = run_mask_propagation if operation == "propagate_mask" else run_stabilization
                report = worker(info, state["plan"], store.directory(session),
                    folder_paths.get_full_path("cotracker", tracker_model),
                    region_ids=submitted.get("stabilization_ids"), use_cache=use_cache,
                    progress=tracking_progress, interrupt=throw_exception_if_processing_interrupted)
                state = store.stabilization_progress(session, revision, {"stage": "complete"}, report)
            except (Exception, InterruptProcessingException) as error:
                message = str(error) or "Tracking cancelled; completed clips are kept."
                store.stabilization_progress(session, revision, {"stage": "error", "error": message})
                raise
            return {"ui": {"s3f_timeline": [session], "s3f_timeline_status": ["Mask propagation complete" if operation == "propagate_mask" else "Tracking complete · stabilized clip ready"],
                           "s3f_timeline_project": [state.get("project")]},
                    "result": (ExecutionBlocker(None), str(store.directory(session) / "timeline.json"))}
        editor_session = motion_editor_session(workflow, unique_id, session)
        state = bind_motion_editor(store, state, editor_session, output_root)
        revision, plan = state["revision"], state["plan"]
        if operation == "selected" and submitted.get("processing_scope") is not None:
            from .sam3d_funscript.processing_timeline import apply_processing_scope
            plan = apply_processing_scope(plan, submitted["processing_scope"], info)
        if operation == "extract_anchors":
            from .sam3d_funscript.processing_timeline import overlaps_range
            ids = submitted.get("stabilization_ids", [])
            if not isinstance(ids, list) or len(ids) != 1 or not isinstance(ids[0], str):
                raise ValueError("Select one enabled stabilization region for anchor extraction")
            regions = [r for r in plan["stabilization"] if r["id"] in ids and r["enabled"]]
            if len(regions) != 1:
                raise ValueError("Select one enabled stabilization region for anchor extraction")
            region = regions[0]
            if not any(r["enabled"] and overlaps_range(r, region['start_ms'], region['end_ms']) for r in plan['tracking']):
                raise ValueError("Add a tracking region for this section before extracting anchors")
            plan = {**plan, "selection": [region["start_ms"], region["end_ms"]]}
            operation = "selected"
        if operation != "prepare":
            checkpoint = folder_paths.get_full_path("cotracker", tracker_model)
            last_stage = None

            def progress(event):
                nonlocal last_stage
                PromptServer.instance.send_sync("s3f_timeline_progress", {"session": session, "revision": revision, **event})
                marker = (event.get("stage"), event.get("completed_jobs"), event.get("region_id"))
                if marker != last_stage:
                    store.progress(session, revision, event)
                    last_stage = marker

            try:
                result, report = run_timeline(info, plan, store.directory(session), model_file,
                    sample_fps=sample_fps, batch_size=batch_size, checkpoint=checkpoint,
                    operation=operation, use_cache=use_cache,
                    mask_video_range=video_input_range(mask_video) if mask_video is not None else None,
                    **({'stabilization_errors': stabilization_errors} if stabilization_errors else {}),
                    **({'stabilization_reviews': stabilization_reviews} if stabilization_reviews else {}),
                    progress=progress, interrupt=throw_exception_if_processing_interrupted)
                result_path = publish_motion(result, editor_session, output_root, store.read(session), preserve_main=submitted.get("preserve_main") is True) if result is not None else None
                state = store.finish(session, revision, report, result_path)
            except (Exception, InterruptProcessingException) as error:
                message = str(error) or ("Processing cancelled; completed chunks are kept." if isinstance(error, InterruptProcessingException) else type(error).__name__)
                report_file = store.directory(session) / "results" / info["source_id"] / "report.json"
                try:
                    report = json.loads(report_file.read_text())
                except (OSError, ValueError):
                    report = {}
                report.setdefault("warnings", []).append(message)
                store.finish(session, revision, report, error=message)
                raise
        elif state.get("project_path") and Path(state["project_path"]).is_file() and not EditorStore(output_root).read(editor_session):
            # Existing processing results acquire a persistent editor on upgrade
            # or when a newly connected standalone becomes their session owner.
            result_path = publish_motion(load_project(state["project_path"]), editor_session, output_root, state)
            state = store.bind_editor(session, editor_session, result_path)
        if operation == 'prepare':
            state = store.prepare_editor(session, info['source_id'], editor_session)
        project = load_project(state["project_path"]) if state.get("project_path") and Path(state["project_path"]).is_file() else ExecutionBlocker(None)
        summary = "Timeline ready · select regions and process in the editor."
        if state.get("project"):
            summary = ("Motion Studio ready · audio and manual patterns are available without tracking." if state.get('editor_only') else
                "Motion result ready." + (" Plan changed since this result; process affected regions to update it." if not state.get("result_current") else ""))
        if automatic_report is not None:
            if not automatic_report['scenes_added']:
                summary = automatic_report['message']
            else:
                summary = f"Automatic pass · {automatic_report['scenes_added']} scenes added. Review candidates in Motion Studio."
                if operation == 'prepare':
                    summary = 'Automatic pass found no usable scenes. Open the timeline to correct the flagged person crops.'
            stabilization = automatic_report.get('stabilization')
            if stabilization:
                completed = sum(r['id'] not in stabilization['errors'] for r in stabilization['regions'])
                summary += f" Stabilization: {completed} sections ready, {len(stabilization['errors'])} failed, {len(stabilization['review'])} need review."
        timeline_path = str(store.directory(session) / "timeline.json")
        return {"ui": {"s3f_timeline": [session], "s3f_timeline_status": [summary],
                       "s3f_timeline_project": [state.get("project")], "text": [timeline_path]},
                "result": (project, timeline_path)}


class S3F_FolderTimeline(S3F_ProcessingTimeline):
    LIBRARY_KIND = None
    @classmethod
    def INPUT_TYPES(cls):
        inputs = super().INPUT_TYPES()
        inputs['required'].pop('video')
        inputs['required'] = {
            'folder_path': ('STRING', {'default': '', 'tooltip': 'Browse and refine videos individually, or create drafts in bulk. Bulk skips matching funscripts and ignored videos.'}),
            'include_subfolders': ('BOOLEAN', {'default': True}),
            'video_name': ('STRING', {'default': '', 'tooltip': 'Selected by the folder browser. Blank opens the next pending video.'}),
            **inputs['required']}
        return inputs

    def run(self, folder_path, model_file, include_subfolders=True, video_name='', operation='prepare', **kwargs):
        import copy
        from comfy_execution.graph import ExecutionBlocker
        from comfy_api.latest._input_impl.video_types import VideoFromFile
        from .sam3d_funscript.folder_store import FolderStore
        folders = FolderStore(Path(folder_paths.get_output_directory()) / 'sam3d_funscript')
        listing = folders.prepare(folder_path, include_subfolders, kind=self.LIBRARY_KIND)
        from .sam3d_funscript.processing_timeline import parse_plan
        submitted = parse_plan(kwargs.get('plan_json', '{}'))
        if 'h3_trial' in submitted:
            if self.LIBRARY_KIND != 'h3': raise ValueError('Drawing trials require an H3 project node.')
            from .sam3d_funscript.h3_project import tracking_trial
            from .sam3d_funscript.folder_store import LOCK as folder_lock, ACTIVE
            from comfy.model_management import throw_exception_if_processing_interrupted
            request = submitted['h3_trial']
            entry, path = folders.entry(listing['folder'], request.get('clip'))
            if entry['name'] != video_name: raise PlanConflict('The selected take changed. Run the trial again.')
            if entry['status'] == 'ignored': raise PlanConflict('Restore this panel or take before testing motion.')
            import threading
            with folder_lock:
                if entry['timeline'] in ACTIVE: raise PlanConflict('This take is already processing.')
                ACTIVE[entry['timeline']] = ACTIVE[entry['editor_session']] = threading.get_ident()
            try:
                info = source_info(path)
                result = tracking_trial(info, request, model_file, folders.root, interrupt=throw_exception_if_processing_interrupted)
            finally:
                with folder_lock:
                    ACTIVE.pop(entry['timeline'], None); ACTIVE.pop(entry['editor_session'], None)
            result['clip'] = entry['id']
            return {'ui': {'s3f_h3_trial': [result]}, 'result': (ExecutionBlocker(None), '')}
        if operation == 'automatic' and ('folder_batch' in submitted or 'folder_queue' in submitted):
            from comfy.model_management import throw_exception_if_processing_interrupted, InterruptProcessingException
            from server import PromptServer
            queued = 'folder_queue' in submitted
            batch = submitted['folder_queue'] if queued else submitted['folder_batch']
            if not isinstance(batch, dict): raise ValueError('Invalid folder batch')
            if kwargs.get('mask_video') is not None: raise ValueError('Prepare masks separately for each clip; disconnect the shared mask before bulk processing.')
            from .sam3d_funscript.folder_review import preflight
            reprocess = not queued and batch.get('reprocess') is True
            needs_tracker = not queued and folders.needs_tracker(listing['folder'],batch.get('subfolder',''),batch.get('retry_failed') is True,batch.get('clip_ids'),reprocess=reprocess)
            checks = preflight({'model_file':model_file,'tracker_model':kwargs.get('tracker_model','cotracker3_scaled_online.pth')},needs_tracker=needs_tracker)
            if not checks['ok']:
                message='Batch preflight failed: '+'; '.join(checks['errors'])
                if queued:
                    from .sam3d_funscript.folder_queue import FolderQueue
                    FolderQueue(folders.root).failed_start(listing['folder'],batch.get('ticket'),message)
                raise ValueError(message)
            def process(entry):
                current = folders.open(listing['folder'], entry['id'])
                if queued and (folders.plans.read(current['timeline']) or {}).get('plan',{}).get('stabilization'):
                    checks=preflight({'model_file':model_file,'tracker_model':kwargs.get('tracker_model','cotracker3_scaled_online.pth')},needs_tracker=True)
                    if not checks['ok']:raise ValueError('; '.join(checks['errors']))
                options = copy.deepcopy(kwargs)
                extra = options['extra_pnginfo'] = options.get('extra_pnginfo') or {}
                nodes = extra.setdefault('workflow', {}).setdefault('nodes', [])
                node = next((n for n in nodes if str(n['id']) == str(options.get('unique_id'))), None)
                if node is None:
                    node = {'id': options.get('unique_id'), 'type': type(self).__name__}; nodes.append(node)
                node.setdefault('properties', {})['s3f_timeline_session'] = current['timeline']
                options['plan_json'] = '{}'
                operation = 'automatic'
                if reprocess:
                    editor = folders.editors.read(current['editor_session'])
                    if editor: folders.save_version(listing['folder'], current['id'], 'Before bulk reprocess', project=editor['project'])
                    state = folders.plans.read(current['timeline'])
                    operation = 'all' if state.get('report') and state['plan'].get('tracking') else 'automatic'
                    options['plan_json'] = json.dumps({'plan': {}, 'preserve_main': True})
                    options['use_cache'] = False
                result = self.run(folder_path, model_file, include_subfolders, current['name'], operation, **options)
                state = folders.plans.read(current['timeline'])
                errors = [job.get('error', 'Processing failed') for job in (state.get('report') or {}).get('jobs', []) if job.get('state') == 'error']
                if errors or state.get('editor_only') or not state.get('project_path'):
                    raise ValueError('; '.join(errors[:3]) or 'No motion was generated. Review this clip manually.')
                editor=folders.editors.read(current['editor_session'])
                if editor and not reprocess:folders.save_version(listing['folder'],current['id'],'Automatic draft',project=editor['project'])
                return result
            progress=lambda event: PromptServer.instance.send_sync('s3f_folder_progress', {'folder': listing['folder'], **event})
            if queued:
                from .sam3d_funscript.folder_queue import FolderQueue
                report=FolderQueue(folders.root).run(listing['folder'],batch.get('ticket'),process,
                    throw_exception_if_processing_interrupted,(InterruptProcessingException,),progress)
            else:
                report = folders.process_batch(listing['folder'], batch.get('subfolder', ''), process,
                    throw_exception_if_processing_interrupted, (InterruptProcessingException,),
                    progress,retry_failed=batch.get('retry_failed') is True,clip_ids=batch.get('clip_ids'),reprocess=reprocess)
            # Never navigate the review workspace when a background batch ends.
            return {'ui':{'s3f_folder':[listing['folder']], 's3f_folder_batch':[report],
                's3f_timeline_status':[f"Bulk {report['stage']} · {len(report['completed'])} drafts ready, {len(report['failed'])} failed"]},
                'result':(ExecutionBlocker(None),str(folders.path(listing['folder'])))}
        entry = folders.choose(listing['folder'], video_name)
        if entry is None and listing['entries']:
            entry = next((e for e in listing['entries'] if e.get('h3', {}).get('main', True)), listing['entries'][0])
        if entry is None:
            return {'ui': {'s3f_folder': [listing['folder']], 's3f_folder_entry': [None],
                's3f_timeline_status': ['No pending videos · open the folder to review completed or ignored clips.']},
                'result': (ExecutionBlocker(None), str(folders.path(listing['folder'])))}
        if operation != 'prepare' and entry['name'] != video_name:
            raise PlanConflict('Select a video in the folder browser before processing.')
        if operation != 'prepare' and entry['status'] == 'ignored':
            raise PlanConflict('Restore this ignored video before processing.')
        extra = copy.deepcopy(kwargs.pop('extra_pnginfo', None) or {})
        workflow = extra.setdefault('workflow', {}); nodes = workflow.setdefault('nodes', [])
        node = next((n for n in nodes if str(n['id']) == str(kwargs.get('unique_id'))), None)
        if node is None:
            node = {'id': kwargs.get('unique_id'), 'type': type(self).__name__}; nodes.append(node)
        properties = node.setdefault('properties', {})
        if properties.get('s3f_timeline_session') != entry['timeline']:
            if operation != 'prepare':
                raise PlanConflict('The selected folder video changed after this job was queued. Reopen it before processing.')
            kwargs['plan_json'] = '{}'
        properties['s3f_timeline_session'] = entry['timeline']
        entry = folders.open(listing['folder'], entry['id'])
        if operation=='automatic':
            if self.LIBRARY_KIND == 'h3':
                from .sam3d_funscript.h3_project import preset as h3_preset
                submitted.setdefault('automatic_options', {})['confidence'] = h3_preset(listing['root'], panel=entry['h3']['panel_id'])['settings']['confidence']
                submitted['automatic_options']['min_track_confidence'] = submitted['automatic_options']['confidence']
                kwargs['plan_json'] = json.dumps(submitted)
            preset=folders.clip_preset(listing['folder'],entry)
            if preset:
                for key in ('sample_fps','batch_size','cut_sensitivity'):kwargs[key]=preset[key]
                submitted.setdefault('automatic_options',{})['folder_preset']=preset
                kwargs['plan_json']=json.dumps(submitted)
        result = super().run(VideoFromFile(str(Path(listing['root']) / entry['name'])), model_file,
            operation=operation, extra_pnginfo=extra, **kwargs)
        # Editor saves can be newer than the last published project file.
        if operation == 'prepare':
            editor = folders.editors.read(entry['editor_session'])
            if editor: result['result'] = (editor['project'], result['result'][1])
        result['ui'].update(s3f_folder=[listing['folder']], s3f_folder_entry=[entry])
        return result


class S3F_H3ProjectTimeline(S3F_FolderTimeline):
    LIBRARY_KIND = 'h3'

    @classmethod
    def INPUT_TYPES(cls):
        inputs = super().INPUT_TYPES()
        inputs['required']['folder_path'] = ('STRING', {'default': '', 'tooltip': 'H3 Animator project directory containing project.json and index.json. Uses active pages, panels and completed takes in reading order.'})
        inputs['required'].pop('include_subfolders')
        return inputs
