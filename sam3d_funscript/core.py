"""Geometry, temporal processing and portable project files. Distances are metres."""

from dataclasses import dataclass
import json
from pathlib import Path
import re
import uuid

import numpy as np
from scipy.ndimage import gaussian_filter1d
from scipy.spatial.transform import Rotation

from .anchors import ANCHORS
from .standalone import standalone_html

AXES = ("L0", "L1", "L2", "R0", "R1", "R2")
SUFFIXES = dict(zip(AXES, ("", ".surge", ".sway", ".twist", ".roll", ".pitch")))
SCHEMA = "sam3d-funscript/1"


@dataclass
class PoseSequence:
    times_ms: np.ndarray
    points: np.ndarray  # N,P,70,3, camera XYZ metres (right, down, forward)
    pixels: np.ndarray  # N,P,70,2, original video pixels
    valid: np.ndarray  # N,P; presence supplied by adapter, NOT model confidence
    segments: np.ndarray  # N; filters never cross a segment boundary
    metadata: dict

    def validate(self):
        n = len(self.times_ms)
        if n < 2 or not np.isfinite(self.times_ms).all() or np.any(np.diff(self.times_ms) <= 0):
            raise ValueError("At least two strictly increasing, finite timestamps are required")
        if self.times_ms[0] < 0:
            raise ValueError("Video timestamps must be nonnegative")
        if self.points.ndim != 4 or self.points.shape[0] != n or self.points.shape[2:] != (70, 3):
            raise ValueError("Expected N × people × 70 × 3 MHR keypoints")
        if self.pixels.shape != self.points.shape[:-1] + (2,) or self.valid.shape != self.points.shape[:2]:
            raise ValueError("Pose, projection and visibility shapes disagree")
        if self.segments.shape != (n,) or np.any(np.diff(self.segments) < 0):
            raise ValueError("Segments must be ordered and match frame count")
        return self

    def save(self, path):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
        with temporary.open("wb") as handle:
            np.savez_compressed(handle, times_ms=self.times_ms, points=self.points, pixels=self.pixels,
                                valid=self.valid, segments=self.segments,
                                metadata=np.array(json.dumps(self.metadata, allow_nan=False)))
        temporary.replace(path)

    @classmethod
    def load(cls, path):
        with np.load(path, allow_pickle=False) as data:
            return cls(*(data[key].copy() for key in ("times_ms", "points", "pixels", "valid", "segments")),
                       json.loads(str(data["metadata"]))).validate()


def body_basis(points):
    """Right-handed columns: anatomical right, torso up, forward (right × up)."""
    right = points[:, 10] - points[:, 9]
    up = points[:, [5, 6]].mean(axis=1) - points[:, [9, 10]].mean(axis=1)
    good = np.isfinite(right).all(axis=1) & np.isfinite(up).all(axis=1)
    right_norm = np.linalg.norm(right, axis=1)
    good &= right_norm > 1e-5
    right = right / np.maximum(right_norm[:, None], 1e-12)
    up = up - np.sum(up * right, axis=1)[:, None] * right
    up_norm = np.linalg.norm(up, axis=1)
    good &= up_norm > 1e-5
    up = up / np.maximum(up_norm[:, None], 1e-12)
    return np.stack((right, up, np.cross(right, up)), axis=-1), good


def anchor(points, name):
    if name not in ANCHORS:
        raise ValueError(f"Unknown anchor {name}; choose {', '.join(ANCHORS)}")
    return points[:, ANCHORS[name]].mean(axis=1)


def spans(valid, segments, times, max_gap_ms):
    start = None
    for i, present in enumerate(valid):
        boundary = i > 0 and (segments[i] != segments[i - 1] or times[i] - times[i - 1] > max_gap_ms)
        if start is not None and (not present or boundary):
            yield start, i
            start = None
        if present and start is None:
            start = i
    if start is not None:
        yield start, len(valid)


def smooth_span(times, values, smoothing_ms):
    """Resample each valid span uniformly before symmetric offline filtering."""
    if len(times) < 3 or smoothing_ms <= 0:
        return values.copy()
    grid = np.linspace(times[0], times[-1], max(2, round((times[-1] - times[0]) / np.median(np.diff(times))) + 1))
    sigma = smoothing_ms / (grid[1] - grid[0])
    return np.stack([np.interp(times, grid, gaussian_filter1d(np.interp(grid, times, column), sigma, mode="nearest"))
                     for column in values.T], axis=1)


def simplify(times, values, tolerance=0.75):
    """Vertical-error RDP, measured at original integer-millisecond samples."""
    if len(times) < 3:
        return np.arange(len(times))
    keep = {0, len(times) - 1}
    stack = [(0, len(times) - 1)]
    while stack:
        left, right = stack.pop()
        if right <= left + 1:
            continue
        predicted = np.interp(times[left + 1:right], [times[left], times[right]], [values[left], values[right]])
        errors = np.abs(values[left + 1:right] - predicted)
        k = left + 1 + int(np.argmax(errors))
        if errors[k - left - 1] > tolerance:
            keep.add(k)
            stack.extend(((left, k), (k, right)))
    return np.array(sorted(keep))


def validate_actions(actions):
    if not isinstance(actions, list) or not actions:
        raise ValueError("An axis must contain at least one action")
    last = -1
    for action in actions:
        if not isinstance(action, dict) or set(action) != {"at", "pos"}:
            raise ValueError("Actions require only at and pos")
        at, pos = action["at"], action["pos"]
        if type(at) is not int or type(pos) is not int or at <= last or not 0 <= pos <= 100:
            raise ValueError("Actions need increasing nonnegative integer milliseconds and integer positions 0–100")
        last = at
    return actions


def default_config():
    return {"target_person": 0, "target_anchor": "pelvis", "reference_person": -1,
            "reference_anchor": "pelvis", "frame": "camera", "smoothing_ms": 80.0,
            "max_gap_ms": 250.0, "neutral_window_ms": 500.0, "tolerance": 0.75,
            "enabled_axes": list(AXES), "axis_settings": {
                axis: {"component": i % 3, "range": 0.2 if i < 3 else 60.0,
                       "center": 50, "invert": False} for i, axis in enumerate(AXES)}}


def build_project(sequence, overrides=None):
    sequence.validate()
    config = default_config()
    overrides = overrides or {}
    unknown = set(overrides) - set(config)
    if unknown:
        raise ValueError(f"Unknown conversion settings: {sorted(unknown)}")
    config.update({k: v for k, v in overrides.items() if k != "axis_settings"})
    for axis, values in overrides.get("axis_settings", {}).items():
        if axis not in AXES or set(values) - set(config["axis_settings"][axis]):
            raise ValueError(f"Unknown axis or settings for {axis}")
        config["axis_settings"][axis].update(values)
    if not config["enabled_axes"] or len(set(config["enabled_axes"])) != len(config["enabled_axes"]) or set(config["enabled_axes"]) - set(AXES):
        raise ValueError("enabled_axes must be a nonempty unique list of L0,L1,L2,R0,R1,R2")
    for key in ("smoothing_ms", "max_gap_ms", "neutral_window_ms", "tolerance"):
        value = config[key]
        if not isinstance(value, (float, int)) or not np.isfinite(value) or value < 0:
            raise ValueError(f"{key} must be a finite nonnegative number")
    target, reference = config["target_person"], config["reference_person"]
    people = sequence.points.shape[1]
    if type(target) is not int or not 0 <= target < people or type(reference) is not int or not -1 <= reference < people:
        raise ValueError("Person index is outside the extracted ROI slots")
    if reference == target:
        raise ValueError("Target and reference must be different people; use reference_person=-1 for the camera")
    if config["frame"] not in ("camera", "reference_body") or (config["frame"] == "reference_body" and reference < 0):
        raise ValueError("reference_body requires a reference person")
    points = sequence.points[:, target]
    basis, good = body_basis(points)
    position = anchor(points, config["target_anchor"])
    valid = sequence.valid[:, target].copy() & good & np.isfinite(position).all(axis=1)
    if reference >= 0:
        ref_points = sequence.points[:, reference]
        origin = anchor(ref_points, config["reference_anchor"])
        position = position - origin
        valid &= sequence.valid[:, reference] & np.isfinite(origin).all(axis=1)
        if config["frame"] == "reference_body":
            ref_basis, ref_good = body_basis(ref_points)
            valid &= ref_good
            position = np.einsum("nji,nj->ni", ref_basis, position)
            basis = np.einsum("nji,njk->nik", ref_basis, basis)
    if not valid.any():
        raise ValueError("No usable target/reference poses")
    times = sequence.times_ms
    # Channel component order: up, forward, left. Device signs remain editable.
    mapping = np.array([[0, -1, 0], [0, 0, 1], [-1, 0, 0]]) if config["frame"] == "camera" else np.array([[0, 1, 0], [0, 0, 1], [-1, 0, 0]])
    raw = np.full((len(times), 6), np.nan)
    processed = raw.copy()
    ranges = list(spans(valid, sequence.segments, times, config["max_gap_ms"]))
    for start, end in ranges:
        t = times[start:end]
        baseline = t <= t[0] + config["neutral_window_ms"]
        p = position[start:end]
        raw[start:end, :3] = (p - np.median(p[baseline], axis=0)) @ mapping.T
        # Remove the neutral orientation; unwrap sign-continuous quaternion rotations
        # via a rotation vector (not independently wrapped Euler angles).
        neutral = Rotation.from_matrix(basis[start:end][baseline]).mean().as_matrix()
        rotations = Rotation.from_matrix(basis[start:end] @ neutral.T)
        q = rotations.as_quat()
        for i in range(1, len(q)):
            if np.dot(q[i], q[i - 1]) < 0:
                q[i] *= -1
        norm = np.linalg.norm(q[:, :3], axis=1)
        angle = 2 * np.arctan2(norm, q[:, 3])
        vectors = q[:, :3] * (angle / np.maximum(norm, 1e-12))[:, None]
        raw[start:end, 3:] = np.rad2deg(vectors) @ mapping.T
        processed[start:end] = smooth_span(t, raw[start:end], config["smoothing_ms"])
    scripts, metrics = {}, {}
    rounded_times = np.rint(times).astype(np.int64)
    if np.any(np.diff(rounded_times) <= 0):
        raise ValueError("Sampling resolution exceeds integer-millisecond funscript timing")
    for axis in config["enabled_axes"]:
        settings = config["axis_settings"][axis]
        component = settings["component"]
        if type(component) is not int or component not in (0, 1, 2):
            raise ValueError("Axis component must be 0, 1 or 2")
        extent, center = settings["range"], settings["center"]
        if not isinstance(extent, (float, int)) or not np.isfinite(extent) or extent <= 0 or not np.isfinite(center) or not 0 <= center <= 100:
            raise ValueError("Axis range must be positive and center must be in 0–100")
        component += 3 if axis.startswith("R") else 0
        positions = center + processed[:, component] / extent * 100 * (-1 if settings["invert"] else 1)
        quantized = np.rint(np.clip(positions, 0, 100))
        actions = []
        for start, end in ranges:
            # Hold the last known value through gaps/cuts; no inferred movement there.
            if actions and rounded_times[start] > actions[-1]["at"] + 1:
                actions.append({"at": int(rounded_times[start]) - 1, "pos": actions[-1]["pos"]})
            indices = simplify(rounded_times[start:end], quantized[start:end], config["tolerance"]) + start
            actions.extend({"at": int(rounded_times[i]), "pos": int(quantized[i])} for i in indices)
        if actions[0]["at"] > 0:
            actions.insert(0, {"at": 0, "pos": actions[0]["pos"]})
        duration_ms = round(sequence.metadata.get("duration_ms", times[-1]))
        if duration_ms > actions[-1]["at"]:
            actions.append({"at": duration_ms, "pos": actions[-1]["pos"]})
        scripts[axis] = {"version": "1.0", "inverted": False, "range": 100, "actions": validate_actions(actions)}
        metrics[axis] = {"actions": len(actions), "clipped_fraction": float(np.mean((positions[valid] < 0) | (positions[valid] > 100))),
                         "raw_span": float(np.ptp(raw[valid, component])), "units": "m" if component < 3 else "deg"}
    warnings = list(sequence.metadata.get("warnings", []))
    if len(ranges) > 1:
        warnings.append("Gaps/cuts hold the previous position, then step at the next valid span. Review these boundaries before playback.")
    if reference < 0:
        warnings.append("Camera-relative motion includes camera movement and monocular depth/scale drift.")
    return {"schema": SCHEMA, "metadata": sequence.metadata, "config": config, "scripts": scripts,
            "anchor_indices": {"target": list(ANCHORS[config["target_anchor"]]),
                               "reference": list(ANCHORS[config["reference_anchor"]]) if reference >= 0 else None},
            "metrics": metrics, "warnings": warnings, "times_ms": times.tolist(), "valid": valid.tolist(),
            "segments": sequence.segments.tolist(), "raw": nullable(raw), "processed": nullable(processed),
            "pixels": nullable(sequence.pixels), "points": nullable(sequence.points)}


def nullable(array):
    values = np.asarray(array, dtype=object)
    values[~np.isfinite(array)] = None
    return values.tolist()


def load_project(path):
    project = json.loads(Path(path).read_text())
    if project.get("schema") != SCHEMA or not project.get("scripts") or set(project["scripts"]) - set(AXES):
        raise ValueError("Not a SAM3D Funscript project")
    for script in project["scripts"].values():
        validate_actions(script["actions"])
    return project


def export_project(project, output_dir, name="motion"):
    # A separate run directory keeps old results intact and stale axes out of playback.
    name = re.sub(r"[^\w.-]+", "_", name).strip(".") or "motion"
    output = Path(output_dir) / f"{name}_{uuid.uuid4().hex[:12]}"
    output.mkdir(parents=True, exist_ok=False)
    for axis, script in project["scripts"].items():
        if axis not in AXES:
            raise ValueError(f"Unknown axis {axis}")
        validate_actions(script["actions"])
        (output / f"{name}{SUFFIXES[axis]}.funscript").write_text(json.dumps(script, separators=(",", ":"), allow_nan=False))
    path = output / "project.json"
    path.write_text(json.dumps(project, separators=(",", ":"), allow_nan=False))
    # Video range requests need only this small manifest, not every cached pose.
    (output / "source.json").write_text(json.dumps(project["metadata"]["source"], allow_nan=False))
    (output / "viewer.html").write_text(standalone_html(project))
    return path
