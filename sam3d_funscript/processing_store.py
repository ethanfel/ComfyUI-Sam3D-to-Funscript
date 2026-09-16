"""Revision-checked plans and lightweight status for the processing timeline."""
import copy
import json
import re
import threading
from fractions import Fraction
from pathlib import Path

from .reference import atomic_json, digest

LOCK = threading.RLock()


class PlanConflict(ValueError):
    pass


class ProcessingStore:
    def __init__(self, root):
        self.root = Path(root)

    def directory(self, session):
        if not isinstance(session, str) or not re.fullmatch(r"[0-9a-f]{32}", session):
            raise ValueError("Invalid processing timeline session")
        return self.root / session

    def read(self, session):
        with LOCK:
            path = self.directory(session) / "timeline.json"
            return json.loads(path.read_text()) if path.is_file() else None

    def write(self, state):
        directory = self.directory(state["session"])
        directory.mkdir(parents=True, exist_ok=True)
        atomic_json(directory / "timeline.json", state)
        return state

    @staticmethod
    def protect_locks(previous, incoming):
        for lane in ("tracking", "stabilization"):
            after = {region["id"]: region for region in incoming[lane]}
            for region in previous[lane]:
                if not region.get("locked"):
                    continue
                newer = after.get(region["id"])
                if newer is None:
                    raise PlanConflict(f"Unlock {region.get('name', region['id'])} before removing it.")
                # An explicit unlock authorizes changes; stale saves do not.
                if newer.get("locked") and newer != region:
                    raise PlanConflict(f"Unlock {region.get('name', region['id'])} before editing it.")

    def save(self, session, revision, plan):
        from .processing_timeline import normalize_plan
        with LOCK:
            state = self.read(session)
            if state is None:
                raise ValueError("Queue the timeline node once to load its video.")
            if revision != state["revision"]:
                raise PlanConflict("The timeline changed in another editor. Reload its latest plan before saving.")
            normalized = normalize_plan(plan, state["info"])
            if plan.get("source_id") and plan["source_id"] != state["info"]["source_id"]:
                raise PlanConflict("The source video changed. Reload the timeline before saving.")
            self.protect_locks(normalize_plan(state["plan"], state["info"]), normalized)
            if normalized != state["plan"]:
                state["plan"] = normalized
                state["revision"] += 1
                state["result_current"] = False
                self.write(state)
            return state

    def prepare(self, session, info, raw_plan="{}"):
        from .processing_timeline import normalize_plan, parse_plan
        raw = parse_plan(raw_plan)
        supplied = raw.get("plan", raw)
        if not isinstance(supplied, dict):
            raise ValueError("Timeline plan must be a JSON object")
        with LOCK:
            state = self.read(session)
            if state and state["info"]["source_id"] != info["source_id"]:
                if any(r.get("locked") for lane in ("tracking", "stabilization") for r in state["plan"][lane]):
                    raise PlanConflict("This timeline has locked regions for another video. Unlock them or use a new Timeline node.")
                state = None
            if state is None:
                state = {"session": session, "revision": 1, "info": info,
                         "plan": normalize_plan(supplied, info), "report": None,
                         "project": None, "project_path": None, "result_current": False}
                return self.write(state)
            # A reopened workflow can have an older serialized plan than the saved editor.
            # Use the persisted newer plan; its locks and edits survive queueing/restarts.
            if supplied and raw.get("revision", state["revision"]) >= state["revision"]:
                state = self.save(session, state["revision"], supplied)
            return state

    def progress(self, session, revision, value):
        with LOCK:
            state = self.read(session)
            if state and state["revision"] == revision:
                state["progress"] = value
                self.write(state)

    def update_cuts(self, session, source_id, result=None, progress=None, *, expected=None, preserve_manual=False):
        """Annotations never change a motion result, plan revision, or region lock."""
        with LOCK:
            state = self.read(session)
            if state is None or state["info"]["source_id"] != source_id:
                raise PlanConflict("The source video changed while updating cuts. Prepare the timeline again.")
            if expected is not None and digest(state.get('scene_cuts')) != expected:
                raise PlanConflict('Cut markers changed in another tab or scan. Reload the markers and try again; for an EDL import, preview it again.')
            if result is not None:
                if result.get("source_id") != source_id:
                    raise PlanConflict("Cut markers belong to another source video.")
                if preserve_manual:
                    from .scene_cuts import preserve_cut_edits
                    result = preserve_cut_edits(result, state.get('scene_cuts'))
                state["scene_cuts"] = copy.deepcopy(result)
            if progress is not None:
                state["cut_progress"] = copy.deepcopy(progress)
            return self.write(state)

    def stabilization_progress(self, session, revision, progress, report=None):
        """Reference-only runs never publish or clear the motion result."""
        with LOCK:
            state = self.read(session)
            if state is None or state["revision"] != revision:
                raise PlanConflict("The plan changed while tracking. Reload the timeline to review saved clips.")
            state["stabilization_progress"] = copy.deepcopy(progress)
            if report is not None:
                state["stabilization_report"] = copy.deepcopy(report)
            return self.write(state)

    def bind_editor(self, session, editor_session, project_path=None):
        from .editor import EditorStore
        EditorStore(self.root.parent).path(editor_session)  # Validate before persisting the link.
        with LOCK:
            state = self.read(session)
            if state is None:
                raise ValueError("Queue the timeline node once to load its video.")
            state["editor_session"] = editor_session
            if project_path is not None:
                state["project_path"] = str(project_path)
                state["project"] = Path(project_path).parent.name
            return self.write(state)

    def prepare_editor(self, session, source_id, editor_session):
        """Open authoring before inference, preserving the owner's video history."""
        from .core import export_project
        from .editor import EditorStore, blank_project
        with LOCK:
            state = self.read(session)
            if not state or state['info']['source_id'] != source_id or state.get('editor_session') != editor_session:
                raise PlanConflict('The Timeline video or editor changed. Reopen Motion Studio from the current Timeline.')
            if state.get('project_path') and Path(state['project_path']).is_file():
                return state
            info = state['info']
            project = blank_project(dict(source=info['source'], duration_ms=info['end_ms'],
                source_origin_ms=float(Fraction(info.get('source_origin', '0'))*1000), image_size=[info['height'], info['width']],
                processing_timeline=dict(session=session, plan=state['plan'], coverage=[])), float(Fraction(info['start'])*1000))
            editors = EditorStore(self.root.parent)
            path, _ = editors.export(editor_session, project, lambda data: export_project(data, self.root.parent, 'timeline'))
            state.update(project_path=str(path), project=path.parent.name,
                         editor_only=bool(editors.read(editor_session)['project']['metadata'].get('manual_only')))
            return self.write(state)

    def finish(self, session, revision, report, project_path=None, error=None):
        with LOCK:
            state = self.read(session)
            if state is None:
                return None
            state["report"] = copy.deepcopy(report)
            state["report"]["revision"] = revision
            state["result_current"] = revision == state["revision"] and error is None
            state["progress"] = {"stage": "error" if error is not None else "complete", "error": error}
            if project_path is not None:
                state["project_path"] = str(project_path)
                state["project"] = Path(project_path).parent.name
                state['editor_only'] = False
            elif error is None and not state.get('editor_only'):
                # An empty successful assembly must clear the old motion output.
                state["project_path"] = None
                state["project"] = None
            return self.write(state)
