"""ComfyUI execution boundary for video-region processing plans."""
import hashlib
import json
from pathlib import Path
import re

import folder_paths

from .sam3d_funscript.core import export_project, load_project
from .sam3d_funscript.editor import EditorStore
from .sam3d_funscript.processing_store import ProcessingStore, PlanConflict
from .sam3d_funscript.reference import source_info
from .sam3d_funscript.video import video_input_range


def motion_editor_session(workflow, node_id, timeline_session):
    """Share a sole direct standalone consumer; ambiguous branches stay separate."""
    nodes = {str(node["id"]): node for node in workflow.get("nodes", [])}
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


def publish_motion(project, session, output_root, timeline_state=None):
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
    path, _ = EditorStore(output_root).export(session, project, lambda data: export_project(data, output_root, "timeline"))
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
            "operation": (["prepare", "all", "selected", "unfinished", "detect_cuts", "stabilize", "propagate_mask", "extract_anchors"], {"default": "prepare", "tooltip": "Prepare opens/restores the editor. Stabilize tracks selected stabilization regions without SAM3D. Detect cuts only adds timeline guides."}),
            "plan_json": ("STRING", {"default": "{}", "multiline": True, "tooltip": "The timeline editor saves its source-bound regions and revision here with the workflow."}),
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
        from .sam3d_funscript.processing_timeline import run_timeline

        if operation not in ("prepare", "all", "selected", "unfinished", "detect_cuts", "stabilize", "propagate_mask", "extract_anchors"):
            raise ValueError("Unknown timeline processing operation")
        path, start, duration = video_input_range(video)
        info = source_info(path, start, duration)
        workflow = (extra_pnginfo or {}).get("workflow", {})
        node = next((n for n in workflow.get("nodes", []) if str(n["id"]) == str(unique_id)), {})
        session = node.get("properties", {}).get("s3f_timeline_session")
        if not session:
            session = hashlib.sha256(f"{info['source_id']}:{unique_id}".encode()).hexdigest()[:32]
        output_root = Path(folder_paths.get_output_directory()) / "sam3d_funscript"
        store = ProcessingStore(output_root / "processing")
        submitted = json.loads(plan_json) if isinstance(plan_json, str) else plan_json
        prior = store.read(session)
        if operation != "prepare" and prior and isinstance(submitted, dict) and "revision" in submitted:
            if submitted["revision"] != prior["revision"]:
                raise PlanConflict("This plan changed after the job was queued. Reload the latest timeline and process again.")
        state = store.prepare(session, info, plan_json)
        if operation == "detect_cuts":
            from .sam3d_funscript.scene_cuts import detect_cuts

            def cut_progress(event):
                store.update_cuts(session, info["source_id"], progress=event)
                PromptServer.instance.send_sync("s3f_timeline_progress", {"session": session, **event})

            try:
                cut_progress({"stage": "scene_cuts", "frames": 0, "cuts": 0})
                cuts = detect_cuts(info, output_root / "cut_cache", cut_sensitivity, use_cache,
                                   progress=cut_progress, interrupt=throw_exception_if_processing_interrupted)
                state = store.update_cuts(session, info["source_id"], cuts, {"stage": "complete"})
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
        if operation == "extract_anchors":
            ids = submitted.get("stabilization_ids", [])
            if not isinstance(ids, list) or len(ids) != 1 or not isinstance(ids[0], str):
                raise ValueError("Select one enabled stabilization region for anchor extraction")
            regions = [r for r in plan["stabilization"] if r["id"] in ids and r["enabled"]]
            if len(regions) != 1:
                raise ValueError("Select one enabled stabilization region for anchor extraction")
            region = regions[0]
            if not any(r["enabled"] and r["start_ms"] < region["end_ms"] and r["end_ms"] > region["start_ms"] for r in plan["tracking"]):
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
                    progress=progress, interrupt=throw_exception_if_processing_interrupted)
                result_path = publish_motion(result, editor_session, output_root, store.read(session)) if result is not None else None
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
        project = load_project(state["project_path"]) if state.get("project_path") and Path(state["project_path"]).is_file() else ExecutionBlocker(None)
        summary = "Timeline ready · select regions and process in the editor."
        if state.get("project"):
            summary = "Motion result ready." + (" Plan changed since this result; process affected regions to update it." if not state.get("result_current") else "")
        timeline_path = str(store.directory(session) / "timeline.json")
        return {"ui": {"s3f_timeline": [session], "s3f_timeline_status": [summary],
                       "s3f_timeline_project": [state.get("project")], "text": [timeline_path]},
                "result": (project, timeline_path)}
