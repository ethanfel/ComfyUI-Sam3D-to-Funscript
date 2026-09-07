"""Package anchor projects on one video timeline without duplicating pose arrays."""

import copy
import hashlib
import json
import re

from .core import AXES, SCHEMA, validate_actions

GEOMETRY = ("points", "pixels", "times_ms", "segments")
SOURCE_FIELDS = ("metadata", "config", "scripts", "metrics", "warnings", "valid", "raw",
                 "processed", "orientation_hints", "anchor_indices", "references")


class ProjectInputs(dict):
    """Typed, numbered optional inputs; only project_0 is advertised initially."""

    def __init__(self, editor=False):
        self.editor = editor
        super().__init__()
        if editor:
            self['editor_session'] = ('S3F_EDITOR_SESSION', {'tooltip':
                'Share the connected Motion Studio session. This view uses the upstream projects; its own project inputs are ignored.'})
        self['project_0'] = ("S3F_MOTION_PROJECT", {"tooltip":
            "Connect anchor/calibration projects from the same video. Another input appears automatically."})

    def __contains__(self, name):
        return (self.editor and name == 'editor_session') or name == "project" or bool(re.fullmatch(r"project_\d+", name))

    def __getitem__(self, name):
        if self.editor and name == 'editor_session':
            return dict.__getitem__(self, name)
        if name not in self:
            raise KeyError(name)
        return ("S3F_MOTION_PROJECT",)


def combine_projects(inputs):
    projects = [(name, value) for name, value in inputs.items() if value is not None]
    if not projects:
        raise ValueError("Connect at least one motion project to project_0.")
    if "project" in inputs and "project_0" in inputs:
        raise ValueError("Use project_0, or the legacy project input, not both.")
    projects = [("project_0" if name == "project" else name, value) for name, value in projects]
    if any(not re.fullmatch(r"project_\d+", name) for name, _ in projects):
        raise ValueError("Motion project inputs must be named project_0, project_1, …")
    projects.sort(key=lambda item: int(item[0].split("_")[1]))
    for name, value in projects:
        if not isinstance(value, dict) or value.get("schema") != SCHEMA or not value.get("scripts") or not value.get("times_ms"):
            raise ValueError(f"{name} is not a motion project.")
        if set(value["scripts"]) - set(AXES):
            raise ValueError(f"{name} has an unknown output axis.")
        for script in value["scripts"].values():
            validate_actions(script["actions"])
    if len(projects) == 1:
        return projects[0][1]  # Reopening a composed project preserves every edit.
    base = projects[0][1]
    identity = base["metadata"]["source"]
    for name, value in projects:
        source = value["metadata"]["source"]
        if source.get("path") != identity.get("path") or any(
                key in source and key in identity and source[key] != identity[key] for key in ("size", "mtime_ns")):
            raise ValueError(f"{name} uses a different source video. Tracks must share the original video timeline.")
        if value.get("timeline"):
            raise ValueError("Load a saved track project on its own to resume editing. Connect original anchor projects to assemble new tracks.")

    output = {**base, "config": copy.deepcopy(base["config"]), "scripts": copy.deepcopy(base["scripts"]),
              "metrics": copy.deepcopy(base.get("metrics", {}))}
    timeline = {"version": 1, "sources": [], "latest": {}, "geometries": {}, "tracks": [], "main": {},
                "active": "main", "selection": [0, 0]}
    hashes = {}
    for name, value in projects:
        geometry = {key: value.get(key) for key in GEOMETRY}
        digest = hashlib.sha256(json.dumps(geometry, separators=(",", ":"), allow_nan=False).encode()).hexdigest()
        if digest not in hashes:
            key = "base" if not hashes else name
            hashes[digest] = key
            if key != "base":
                timeline["geometries"][key] = geometry
        data = {key: value[key] for key in SOURCE_FIELDS if key in value}
        label = f"{name} · {value['config']['target_anchor'].replace('_', ' ')} · person {value['config']['target_person']}"
        timeline["sources"].append({"id": name, "label": label, "geometry": hashes[digest], "data": data})
        timeline["latest"][name] = name
        axis = "L0" if "L0" in value["scripts"] else next(iter(value["scripts"]))
        timeline["tracks"].append({"id": f"track_{len(timeline['tracks'])}", "name": label,
            "source": name, "axis": axis, "settings": copy.deepcopy(value["config"]["axis_settings"][axis]),
            "script": copy.deepcopy(value["scripts"][axis])})
        for axis, script in value["scripts"].items():
            if axis not in output["scripts"]:
                output["scripts"][axis] = copy.deepcopy(script)
                output["config"]["axis_settings"][axis] = copy.deepcopy(value["config"]["axis_settings"][axis])
            if axis not in timeline["main"]:
                timeline["main"][axis] = {"assembled": False, "source": name, "regions": []}
    output["config"]["enabled_axes"] = list(output["scripts"])
    # Each source retains its own analysed range; the shared ruler spans all of them.
    output["metadata"] = {**base["metadata"], "duration_ms": max(p["metadata"]["duration_ms"] for _, p in projects)}
    output["timeline"] = timeline
    return output
