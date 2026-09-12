"""Resumable, bounded timeline processing on the original video's clock.

Inference chunks are implementation details: calibration is calculated over the
completed region, and output actions are clipped to the requested coverage.
"""
from copy import deepcopy
from fractions import Fraction
import json
import math
from pathlib import Path

import numpy as np

from .anchors import ANCHORS
from .mesh_anchor import MASK_ANCHOR, normalize_paint, prepare_patch, VERSION as MESH_ANCHOR_VERSION
from .core import AXES, PoseSequence, build_project, default_config, validate_actions, remove_redundant_actions
from .reference import atomic_json, config_for_source, digest, run_reference, source_info
from .reference_tracker import resolve_checkpoint
from .timeline import combine_projects, GEOMETRY
from .video import extract_video, fingerprint, parse_rois

VERSION = 1


def _number(value, label, minimum=0):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < minimum:
        raise ValueError(f"{label} must be a finite number >= {minimum}")
    return float(value)


def parse_plan(raw):
    """A blank node widget means no submitted plan, like the default {}."""
    if isinstance(raw, str):
        if not raw.strip():
            return {}
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError as error:
            raise ValueError(f"Invalid timeline plan JSON at line {error.lineno}, column {error.colno}: {error.msg}. "
                             "Use an object such as {}, or leave the field blank to reuse the saved plan.") from error
    if not isinstance(raw, dict):
        raise ValueError("Timeline plan must be a JSON object")
    return deepcopy(raw)


def normalize_plan(raw, info):
    """Validate a portable plan. Region times are original-relative milliseconds."""
    raw = parse_plan(raw)
    changed = bool(raw.get("source_id") and raw["source_id"] != info["source_id"])
    if changed:
        raw = {}
    if raw.get("version", VERSION) != VERSION:
        raise ValueError("Unsupported processing timeline version")
    start, end = float(Fraction(info["start"]) * 1000), float(info["end_ms"])
    if not 0 <= start < end:
        raise ValueError("Video needs a known, positive timeline duration")
    default_region = {"id": "tracking_0", "name": "Full video", "start_ms": start, "end_ms": end}
    plan = {"version": VERSION, "source_id": info["source_id"], "source_changed": changed,
            "tracking": [], "stabilization": [], "selection": raw.get("selection", [start, start]),
            "selected_ids": raw.get("selected_ids", []), "join_ms": _number(raw.get("join_ms", 200), "Join duration"),
            "gap_policy": raw.get("gap_policy", "hold"), "chunk_seconds": _number(raw.get("chunk_seconds", 30), "Chunk duration", 1)}
    if plan["gap_policy"] not in ("hold", "neutral"):
        raise ValueError("Gap policy must be hold or neutral")
    if plan["chunk_seconds"] > 600:
        raise ValueError("Chunk duration must be at most 600 seconds")
    selection = plan["selection"]
    if not isinstance(selection, list) or len(selection) != 2:
        raise ValueError("Selection needs [start_ms, end_ms]")
    selection = [_number(v, "Selection time") for v in selection]
    if not start <= selection[0] <= selection[1] <= end:
        raise ValueError("Selection lies outside the video trim")
    plan["selection"] = selection
    if not isinstance(plan["selected_ids"], list) or not all(isinstance(v, str) for v in plan["selected_ids"]):
        raise ValueError("Selected region IDs must be a list of strings")
    identities = set()
    for lane in ("tracking", "stabilization"):
        regions = raw.get(lane, [default_region] if lane == "tracking" else [])
        if not isinstance(regions, list):
            raise ValueError(f"{lane} must be a list of regions")
        for i, source in enumerate(regions):
            if not isinstance(source, dict):
                raise ValueError("Each timeline region must be an object")
            a, b = (_number(source.get(key), key) for key in ("start_ms", "end_ms"))
            if not start <= a < b <= end:
                raise ValueError("Region boundaries must lie inside the video trim")
            identifier = str(source.get("id", f"{lane}_{i}"))
            if not identifier or identifier in identities:
                raise ValueError("Timeline region IDs must be distinct and nonempty")
            identities.add(identifier)
            region = {"id": identifier, "name": str(source.get("name", f"{lane.title()} {i+1}")),
                      "start_ms": a, "end_ms": b, "enabled": source.get("enabled", True), "locked": source.get("locked", False)}
            if type(region["enabled"]) is not bool or type(region["locked"]) is not bool:
                raise ValueError("Region enabled and locked flags must be booleans")
            if lane == "tracking":
                method = source.get("method", "sam3d")
                if method != "sam3d":
                    raise ValueError("The supported pose tracking method is sam3d")
                anchor, person = source.get("anchor", "pelvis"), source.get("person", 0)
                rois = parse_rois(source.get("rois", [[0, 0, 1, 1]]))
                if anchor != MASK_ANCHOR and anchor not in ANCHORS:
                    raise ValueError(f"Unknown tracking anchor: {anchor}")
                extra_anchors = source.get("additional_anchors", [])
                if not isinstance(extra_anchors, list) or any(not isinstance(a, str) or a not in ANCHORS for a in extra_anchors):
                    raise ValueError("Additional anchors must be a list of supported anchor names")
                extra_anchors = list(dict.fromkeys(a for a in extra_anchors if a != anchor))
                if type(person) is not int or not 0 <= person < len(rois):
                    raise ValueError("Tracking person must identify an existing ROI slot")
                settings = source.get("settings", {})
                if not isinstance(settings, dict):
                    raise ValueError("Region calibration settings must be an object")
                unknown = set(settings) - set(default_config())
                if unknown:
                    raise ValueError(f"Unknown calibration settings: {sorted(unknown)}")
                region.update(method=method, anchor=anchor, additional_anchors=extra_anchors, person=person, rois=rois,
                              smoothing_ms=_number(source.get("smoothing_ms", 30), "Smoothing"), settings=deepcopy(settings))
                if 'candidate_people' in source:
                    candidates = source['candidate_people']
                    if not isinstance(candidates, list) or not candidates or any(type(p) is not int or not 0 <= p < len(rois) for p in candidates):
                        raise ValueError('Candidate people must identify existing person rectangles')
                    region['candidate_people'] = list(dict.fromkeys([person, *candidates]))
                if 'automatic' in source:
                    auto = source['automatic']
                    if not isinstance(auto, dict) or auto.get('version') != 1 or type(auto.get('suggest')) is not bool:
                        raise ValueError('Invalid automatic scene settings')
                    if not isinstance(auto.get('people'), list) or not isinstance(auto.get('review'), list) or any(not isinstance(r, str) for r in auto['review']):
                        raise ValueError('Invalid automatic scene review')
                    for detected in auto['people']:
                        if not isinstance(detected, dict) or not isinstance(detected.get('coverage'), (float, int)) or not 0 <= detected['coverage'] <= 1:
                            raise ValueError('Invalid automatic person coverage')
                    region['automatic'] = deepcopy(auto)
                isolated = source.get('isolate_subject', False)
                if type(isolated) is not bool:
                    raise ValueError('Exclude outside person crop must be a boolean')
                if isolated:
                    region['isolate_subject'] = True
                if source.get("mask_anchor") is not None:
                    region["mask_anchor"] = normalize_paint(source["mask_anchor"], info["width"], info["height"])
            else:
                reference = deepcopy(source.get("reference", {}))
                if not isinstance(reference, dict):
                    raise ValueError("Reference settings must be an object")
                # Point frame numbers are relative to this region. The
                # enclosing timeline validates source identity, not a stale trim ID.
                reference.pop("source_id", None)
                reference, _ = config_for_source(reference, info)
                reference.pop("source_id", None)
                region.update(reference=reference, agreement_pixels=_number(source.get("agreement_pixels", 12), "Agreement tolerance"),
                              max_step_pixels=_number(source.get("max_step_pixels", 48), "Maximum step"))
            plan[lane].append(region)
        plan[lane].sort(key=lambda r: (r["start_ms"], r["end_ms"], r["id"]))
        enabled = [r for r in plan[lane] if r["enabled"]]
        if any(a["end_ms"] > b["start_ms"] for a, b in zip(enabled, enabled[1:])):
            raise ValueError(f"Enabled {lane} regions overlap; split them at a shared boundary")
    plan["selected_ids"] = list(dict.fromkeys(v for v in plan["selected_ids"] if v in identities))
    return plan


def apply_processing_scope(plan, scope, info):
    """One-shot UI scope never rewrites the saved editor selection."""
    if not isinstance(scope, dict):
        raise ValueError("Choose a marked range or selected regions")
    scoped = deepcopy(plan)
    if scope.get("kind") == "range":
        times = scope.get("range")
        if not isinstance(times, list) or len(times) != 2:
            raise ValueError("Marked range needs two boundaries")
        a, b = (_number(t, "Marked boundary") for t in times)
        if not float(Fraction(info["start"]) * 1000) <= a < b <= info["end_ms"]:
            raise ValueError("Mark a nonempty range inside the video")
        scoped.update(selection=[a, b], selected_ids=[])
    elif scope.get("kind") == "regions":
        ids = scope.get("ids")
        enabled = {r["id"] for lane in ("tracking", "stabilization") for r in plan[lane] if r["enabled"]}
        if not isinstance(ids, list) or not ids or any(not isinstance(i, str) or i not in enabled for i in ids):
            raise ValueError("Select enabled regions from this plan")
        scoped.update(selection=[plan["selection"][0]] * 2, selected_ids=list(dict.fromkeys(ids)))
    else:
        raise ValueError("Unknown processing scope")
    return scoped


def compile_jobs(plan, info):
    """Split tracking at independent stabilization boundaries and bounded chunks.

    Context never crosses a stabilization boundary. Its extra frames support
    filtering and sparse short selections, but only core coverage is exported.
    """
    jobs = []
    stabilizers = [r for r in plan["stabilization"] if r["enabled"]]
    source_start, source_end = float(Fraction(info["start"]) * 1000), float(info["end_ms"])
    for region in plan["tracking"]:
        if not region["enabled"]:
            continue
        left, right = region["start_ms"], region["end_ms"]
        boundaries = {left, right}
        for stabilization in stabilizers:
            if stabilization["start_ms"] < right and stabilization["end_ms"] > left:
                boundaries.update((max(left, stabilization["start_ms"]), min(right, stabilization["end_ms"])))
        boundaries = sorted(boundaries)
        for a, b in zip(boundaries, boundaries[1:]):
            stabilization = next((r for r in stabilizers if r["start_ms"] <= a and r["end_ms"] >= b), None)
            if stabilization:
                context_start, context_end = stabilization["start_ms"], stabilization["end_ms"]
            else:
                context_start = max([source_start] + [r["end_ms"] for r in stabilizers if r["end_ms"] <= a])
                context_end = min([source_end] + [r["start_ms"] for r in stabilizers if r["start_ms"] >= b])
            context_ms = max(500, region["smoothing_ms"] * 3)
            if region.get('automatic'):
                context_start, context_end = max(left, context_start), min(right, context_end)
            count = max(1, math.ceil((b-a) / (plan["chunk_seconds"] * 1000)))
            for i in range(count):
                begin = a + i * plan["chunk_seconds"] * 1000
                finish = min(b, begin + plan["chunk_seconds"] * 1000)
                jobs.append({"id": digest([region["id"], begin, finish, stabilization["id"] if stabilization else None]),
                             "region_id": region["id"], "start_ms": begin, "end_ms": finish,
                             "context_start_ms": max(context_start, begin-context_ms),
                             "context_end_ms": min(context_end, finish+context_ms),
                             "stabilization_id": stabilization["id"] if stabilization else None})
    return jobs


def _model_identity(model_file):
    if Path(model_file).is_file():
        return fingerprint(model_file)
    import folder_paths
    return fingerprint(folder_paths.get_full_path_or_raise("detection", model_file))


def _region_settings(region, anchor=None, person=None):
    return {**deepcopy(region["settings"]), "target_anchor": anchor or region["anchor"], "target_person": region["person"] if person is None else person,
            "smoothing_ms": region["smoothing_ms"], "enabled_axes": list(AXES)}


def _stable(value):
    result = {k: deepcopy(v) for k, v in value.items() if k not in ("name", "locked", "enabled")}
    mask = result.get("reference", {}).get("point_mask")
    if mask:
        mask.pop("spacing", None); mask.pop("limit", None)
    return result


def _stabilized_rois(rois, info, manifest, start, end):
    times = np.asarray(manifest["data"]["source_times_ms"])
    shifts = np.asarray(manifest["data"]["shift_xy"])
    selected = (times >= start) & (times <= end)
    shifts = shifts[selected] if selected.any() else shifts
    padding = np.asarray(manifest["video"]["padding_xy"])
    size = np.asarray(manifest["video"]["size_wh"])
    original = np.asarray([info["width"], info["height"]])
    result = []
    for x, y, w, h in rois:
        lo = np.maximum(0, [x, y]*original + padding - shifts.max(axis=0))
        hi = np.minimum(size, [x+w, y+h]*original + padding - shifts.min(axis=0))
        result.append([*(lo/size), *((hi-lo)/size)])
    return np.asarray(result).tolist()


def _original_sequence(sequence, info, manifest=None):
    """Keep inferred 3D motion in its analysis basis, invert only the 2D preview."""
    sequence.metadata = deepcopy(sequence.metadata)
    if manifest:
        data, encoded = manifest["data"], manifest["video"]
        local = np.asarray(data["times_ms"])
        absolute = np.asarray(data["source_times_ms"])
        index = np.searchsorted(local, sequence.times_ms)
        index = np.clip(index, 0, len(local)-1)
        earlier = np.maximum(0, index-1)
        index = np.where(np.abs(local[earlier]-sequence.times_ms) < np.abs(local[index]-sequence.times_ms), earlier, index)
        if not np.allclose(local[index], sequence.times_ms, rtol=0, atol=.01):
            raise ValueError("Stabilized pose timing does not match the original presentation timestamps")
        sequence.times_ms = absolute[index].copy()
        shifts = np.asarray(data["shift_xy"])[index]
        sequence.pixels = sequence.pixels - np.asarray(encoded["padding_xy"])[None, None, None, :] + shifts[:, None, None, :]
        origin = Fraction(info["source_origin"])
        sequence.metadata["timestamps"] = [{"time_ms": float(t), "pts": Fraction(data["source_pts"][i]).numerator,
            "time_base": [1, Fraction(data["source_pts"][i]).denominator], "origin": [origin.numerator, origin.denominator]}
            for t, i in zip(sequence.times_ms, index)]
    sequence.metadata.update(source=deepcopy(info["source"]), image_size=[info["height"], info["width"]],
                             source_origin_ms=float(Fraction(info.get("source_origin", "0"))*1000))
    sequence.metadata.pop("reference_stabilization", None)
    sequence.metadata.pop("mask_boxes", None) if manifest else None
    return sequence


def _coverage(records):
    result = []
    for r in sorted(records, key=lambda r: r["start_ms"]):
        a, b = r["start_ms"], r["end_ms"]
        if result and a <= result[-1][1] + .001:
            result[-1][1] = max(result[-1][1], b)
        else:
            result.append([a, b])
    return result


def _uncovered(start, end, covered):
    """Subtract completed half-open intervals without changing their boundaries."""
    remaining = [(start, end)]
    for left, right in covered:
        updated = []
        for a, b in remaining:
            if right <= a or left >= b:
                updated.append((a, b))
            else:
                if a < left:
                    updated.append((a, left))
                if right < b:
                    updated.append((right, b))
        remaining = updated
    return remaining


def _merge_sequences(records, region, info):
    """Merge overlapping context by preferring samples inside each chunk's core."""
    rows = {}
    coverage = _coverage(records)
    cuts = set()
    for ordinal, record in enumerate(records):
        sequence = PoseSequence.load(record["path"])
        cuts.update(sequence.times_ms[1:][np.diff(sequence.segments) != 0].tolist())
        for i, time in enumerate(sequence.times_ms):
            if not region["start_ms"] <= time < region["end_ms"]:
                continue
            # Only retained job coverage contributes output; neighbouring context
            # is used by extraction but not assigned to an unprocessed interval.
            if not any(a <= time < b for a, b in coverage):
                continue
            rank = (record["start_ms"] <= time < record["end_ms"], ordinal)
            if time not in rows or rank > rows[time][0]:
                rows[float(time)] = (rank, sequence, i, record.get("stabilization_id"))
    times = sorted(rows)
    if len(times) < 2:
        raise ValueError("Selected timeline coverage contains fewer than two sampled frames; select a longer interval")
    points, pixels, valid, segments, timing = [], [], [], [], []
    previous = None
    previous_time = None
    ordered_cuts = np.asarray(sorted(cuts))
    segment = 0
    for time in times:
        _, sequence, i, stabilization = rows[time]
        if previous is not None:
            previous_sequence, previous_i, previous_stabilization = previous
            if stabilization != previous_stabilization or np.searchsorted(ordered_cuts, previous_time, side="right") != np.searchsorted(ordered_cuts, time, side="right"):
                segment += 1
        points.append(sequence.points[i]); pixels.append(sequence.pixels[i]); valid.append(sequence.valid[i]); segments.append(segment)
        if sequence.metadata.get("timestamps"):
            timing.append(sequence.metadata["timestamps"][i])
        previous = sequence, i, stabilization
        previous_time = time
    metadata = deepcopy(rows[times[0]][1].metadata)
    metadata.update(source=deepcopy(info["source"]), image_size=[info["height"], info["width"]], rois=region["rois"],
                    duration_ms=max(b for a, b in coverage), analysed_start_ms=times[0], analysed_end_ms=times[-1],
                    sample_count=len(times), timestamps=timing, processing_region=deepcopy(region), processing_coverage=coverage)
    return PoseSequence(np.asarray(times), np.stack(points), np.stack(pixels), np.stack(valid), np.asarray(segments), metadata).validate()


def _assembled_actions(parts, axis, duration, join_ms, gap_policy):
    """Join into the incoming section, retaining the previous value at its edge."""
    values = {0: 50}
    protected = []
    cursor, previous = 0, 50
    for start, end, project in parts:
        start, end = round(start), round(end)
        if end <= start:
            continue
        actions = project["scripts"][axis]["actions"]
        if start > cursor:
            gap_value = previous if gap_policy == "hold" else 50
            values[cursor] = gap_value
            values[max(cursor, start-1)] = gap_value
            previous = gap_value
        width = 0 if cursor == start == 0 else min(round(join_ms), end-start)
        protected.extend([cursor, start-1, start, end, start+width])
        times = {start, end, *(a["at"] for a in actions if start <= a["at"] <= end)}
        if width:
            times.update(range(start, start+width, max(1, min(10, width))))
            times.add(start+width)
        ordered_times = np.asarray(sorted(times))
        positions = np.interp(ordered_times, [a["at"] for a in actions], [a["pos"] for a in actions])
        if width:
            fraction = np.minimum(1, (ordered_times-start)/width)
            fraction = fraction*fraction*(3-2*fraction)
            positions = previous + (positions-previous)*fraction
        for at, value in zip(ordered_times.tolist(), positions.tolist()):
            values[at] = round(max(0, min(100, value)))
        cursor, previous = end, values[end]
    if cursor < duration:
        values[cursor] = previous if gap_policy == "hold" else 50
        values[duration] = values[cursor]
    return remove_redundant_actions([{"at": int(at), "pos": int(pos)} for at, pos in sorted(values.items()) if at <= duration], protected)


def assemble_projects(region_projects, plan, info):
    if not region_projects:
        return None
    ordered = sorted(region_projects, key=lambda p: p["metadata"]["processing_coverage"][0][0])
    project = combine_projects({f"project_{i}": value for i, value in enumerate(ordered)})
    # combine_projects deliberately preserves single inputs; create the same
    # Motion Studio structure explicitly when the plan has only one region.
    if "timeline" not in project:
        from .timeline import SOURCE_FIELDS
        project = {**project, "config": deepcopy(project["config"]), "scripts": deepcopy(project["scripts"])}
        data = {key: deepcopy(project[key]) for key in SOURCE_FIELDS if key in project}
        project["timeline"] = {"version": 1, "sources": [{"id": "project_0", "label": "project_0", "geometry": "base", "data": data}],
            "latest": {"project_0": "project_0"}, "geometries": {}, "tracks": [], "main": {}, "active": "main", "selection": [0, 0]}
        project["timeline"]["tracks"].append({"id": "track_0", "name": ordered[0]["metadata"]["processing_region"]["name"],
            "source": "project_0", "axis": "L0", "settings": deepcopy(data["config"]["axis_settings"]["L0"]), "script": deepcopy(data["scripts"]["L0"])})
    primary = [(i, p) for i, p in enumerate(ordered) if p["metadata"].get("processing_anchor", {}).get("primary", True)]
    parts = sorted([(a, b, p) for _, p in primary for a, b in p["metadata"]["processing_coverage"]], key=lambda item: item[0])
    if any(previous[1] > following[0] for previous, following in zip(parts, parts[1:])):
        raise ValueError("Completed region coverage overlaps. Unlock and adjust the conflicting regions before assembling them.")
    duration = round(info["end_ms"])
    for axis in AXES:
        project["scripts"][axis] = {"version": "1.0", "inverted": False, "range": 100,
            "actions": _assembled_actions(parts, axis, duration, plan["join_ms"], plan["gap_policy"])}
        project["timeline"]["main"][axis] = {"assembled": True, "source": "project_0", "regions": [
            {"start": a, "end": b, "source": f"project_{i}", "axis": axis,
             "settings": deepcopy(p["config"]["axis_settings"][axis]), "name": p["metadata"]["processing_region"]["name"],
             "join": "blend" if plan["join_ms"] else "cut", "blend_ms": min(plan["join_ms"], b-a)}
            for i, p in primary for a, b in p["metadata"]["processing_coverage"]]}
        project["metrics"][axis] = {"actions": len(project["scripts"][axis]["actions"]), "assembled": True}
    for source, p in zip(project["timeline"]["sources"], ordered):
        region = p["metadata"]["processing_region"]
        anchor = p["config"]["target_anchor"]
        source["label"] = f"{region['name']} · {anchor.replace('_', ' ')}"
        source["input"] = f"region:{region['id']}:{anchor}"
        if region.get('candidate_people'):
            source['input'] += f":person{p['config']['target_person']}"
            source['label'] += f" · person {p['config']['target_person']}"
    project["timeline"]["latest"] = {s["input"]: s["id"] for s in project["timeline"]["sources"]}
    for track, p in zip(project["timeline"]["tracks"], ordered):
        track["name"] = f"{p['metadata']['processing_region']['name']} · {p['config']['target_anchor'].replace('_', ' ')}"
        if p['metadata']['processing_region'].get('candidate_people'):
            track['name'] += f" · person {p['config']['target_person']}"
        track["locked"] = p["metadata"]["processing_region"].get("locked", False)
    project["metadata"] = {**project["metadata"], "source": deepcopy(info["source"]), "duration_ms": float(info["end_ms"]),
        "source_origin_ms": float(Fraction(info.get("source_origin", "0"))*1000),
        "image_size": [info["height"], info["width"]], "processing_timeline": {"version": VERSION, "plan": deepcopy(plan), "coverage": [[a, b] for a, b, _ in parts]}}
    project["warnings"] = list(dict.fromkeys(warning for p in ordered for warning in p.get("warnings", [])))
    project["warnings"].append(f"Unprocessed gaps use {plan['gap_policy']}; all six output axes use the same completed regions. Joins are illustrative script blends, not device-limit checks.")
    return project


def current_reference_mask(region, state):
    from .reference_mask import mask_geometry
    mask = region["reference"].get("point_mask")
    if not mask or not mask.get("strokes"):
        return None
    entry = state.get("masks", {}).get(region["id"])
    if not entry or any(entry["region"][k] != region[k] for k in ("start_ms", "end_ms")) or entry["mask"] != mask_geometry(mask) or not Path(entry["manifest_path"]).is_file():
        raise ValueError(f"Propagate the updated reference mask in {region['name']} before tracking")
    return {"id": entry["id"], "manifest_path": entry["manifest_path"]}


def run_mask_propagation(info, plan, root, checkpoint=None, region_ids=None, use_cache=True, progress=None, interrupt=None):
    """Propagate selected masks without loading CoTracker or SAM3D."""
    from .reference_mask import propagate_mask, mask_geometry
    plan = normalize_plan(plan, info)
    ids = plan["selected_ids"] if region_ids is None else region_ids
    regions = {r["id"]: r for r in plan["stabilization"] if r["enabled"]}
    if not isinstance(ids, list) or not ids or any(not isinstance(sid, str) or sid not in regions for sid in ids):
        raise ValueError("Select an enabled stabilization region for mask propagation")
    root = Path(root)
    directory = root / "results" / info["source_id"]
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / "state.json"
    state = json.loads(path.read_text()) if path.exists() else {"version": VERSION, "source_id": info["source_id"], "regions": {}}
    report = {"source_id": info["source_id"], "regions": [], "completed_jobs": 0, "total_jobs": len(set(ids))}
    for sid in dict.fromkeys(ids):
        region = regions[sid]
        if interrupt: interrupt()
        if region["locked"]:
            saved = current_reference_mask(region, state)
            if not saved: raise ValueError("Unlock this region to create a reference mask")
        else:
            mask = region["reference"].get("point_mask")
            if not mask or not mask.get("strokes"): raise ValueError("Paint a reference mask first")
            clip = source_info(info["source"]["path"], Fraction(str(region["start_ms"]))/1000,
                               Fraction(str(region["end_ms"]-region["start_ms"]))/1000)
            def emit(event):
                if progress: progress({**event, "region_id": sid, "region_name": region["name"], "completed_jobs": report["completed_jobs"], "total_jobs": report["total_jobs"]})
            emit({"stage": "mask_propagation", "frames": 0})
            manifest_path = propagate_mask(clip, mask, root / "masks", use_cache, emit, interrupt)
            manifest = json.loads(manifest_path.read_text())
            state.setdefault("masks", {})[sid] = {"id": manifest["id"], "manifest_path": str(manifest_path),
                "region": {k: region[k] for k in ("id", "start_ms", "end_ms")}, "mask": mask_geometry(mask), "frames": len(manifest["frames"])}
            atomic_json(path, state)
        report["regions"].append({"id": sid, "mask_id": state["masks"][sid]["id"]})
        report["completed_jobs"] += 1
    return report


def _stabilize_region(info, region, root, state, checkpoint, use_cache, progress, interrupt):
    """Share the rendered reference between quick tracking and pose extraction."""
    sid = region["id"]
    stored = state.setdefault("stabilization", {}).get(sid)
    if region["locked"] and stored and Path(stored["manifest_path"]).is_file() and Path(stored["video_path"]).is_file():
        return json.loads(Path(stored["manifest_path"]).read_text()), Path(stored["video_path"])
    if not region["reference"]["points"]:
        raise ValueError(f"Mark reference points in stabilization region {region['name']}")
    masks = current_reference_mask(region, state)
    tracked, rendered = run_reference(info["source"]["path"], Fraction(str(region["start_ms"]))/1000,
        Fraction(str(region["end_ms"]-region["start_ms"]))/1000,
        region["reference"], checkpoint, root / "reference", tolerance=region["agreement_pixels"],
        max_step=region["max_step_pixels"], use_cache=use_cache, progress=progress, interrupt=interrupt, reference_masks=masks)
    if rendered is None:
        raise ValueError("Stabilization reference points are missing")
    directory = root / "results" / info["source_id"]
    manifest_path = directory / (digest([sid, tracked["id"]])+".reference.json")
    atomic_json(manifest_path, tracked)
    state["stabilization"][sid] = {"region": deepcopy(region), "manifest_path": str(manifest_path), "video_path": str(rendered)}
    atomic_json(directory / "state.json", state)
    return tracked, rendered


def run_stabilization(info, plan, root, checkpoint, region_ids=None, use_cache=True, progress=None, interrupt=None):
    """Track complete selected stabilization regions without reading pose models or results."""
    plan = normalize_plan(plan, info)
    ids = plan["selected_ids"] if region_ids is None else region_ids
    if not isinstance(ids, list) or not ids or any(not isinstance(sid, str) for sid in ids):
        raise ValueError("Select a stabilization region to track")
    regions = {r["id"]: r for r in plan["stabilization"] if r["enabled"]}
    if any(sid not in regions for sid in ids):
        raise ValueError("Select an enabled stabilization region to track")
    selected = [regions[sid] for sid in dict.fromkeys(ids)]
    root = Path(root)
    directory = root / "results" / info["source_id"]
    directory.mkdir(parents=True, exist_ok=True)
    state_path = directory / "state.json"
    state = json.loads(state_path.read_text()) if state_path.exists() else {"version": VERSION, "source_id": info["source_id"], "regions": {}}
    report = {"source_id": info["source_id"], "regions": [], "completed_jobs": 0, "total_jobs": len(selected)}

    def emit(region, frames=0):
        if interrupt:
            interrupt()
        if progress:
            progress({"stage": "stabilization", "region_id": region["id"], "region_name": region["name"],
                      "frames": frames, "completed_jobs": report["completed_jobs"], "total_jobs": report["total_jobs"]})

    for region in selected:
        emit(region)
        manifest, _ = _stabilize_region(info, region, root, state, checkpoint, use_cache,
                                       lambda frames: emit(region, frames), interrupt)
        report["regions"].append({"id": region["id"], "reference_id": manifest["id"]})
        report["completed_jobs"] += 1
        emit(region)
    return report


def run_timeline(info, plan, root, model_file, sample_fps=0, batch_size=8, checkpoint=None,
                 operation="all", use_cache=True, mask_video_range=None, progress=None, interrupt=None):
    """Process selected work and atomically checkpoint each completed chunk."""
    plan = normalize_plan(plan, info)
    if operation not in ("all", "selected", "unfinished"):
        raise ValueError("Operation must be all, selected, or unfinished")
    if mask_video_range is not None and any(r["enabled"] for r in plan["stabilization"]):
        raise ValueError("A source mask cannot be used on independently stabilized regions. Use person ROIs here, or supply a matching stabilized mask outside this timeline.")
    if mask_video_range is not None and any(r["enabled"] and r["person"] != 0 for r in plan["tracking"]):
        raise ValueError("A mask video identifies one person. Set tracking person to 0 for masked regions.")
    model = _model_identity(model_file)
    _number(sample_fps, "Sample rate")
    if type(batch_size) is not int or batch_size < 1:
        raise ValueError("Batch size must be a positive integer")
    root = Path(root); directory = root / "results" / info["source_id"]
    directory.mkdir(parents=True, exist_ok=True)
    state_path = directory / "state.json"
    state = json.loads(state_path.read_text()) if state_path.exists() else {"version": VERSION, "source_id": info["source_id"], "regions": {}}
    state.setdefault("stabilization", {})
    # A lock protects the last completed reference even when a caller bypasses
    # the editor's locked-setting controls or explicitly disables caches.
    for index, region in enumerate(plan["stabilization"]):
        previous = state["stabilization"].get(region["id"])
        if region["locked"] and previous and Path(previous.get("manifest_path", "")).is_file() and Path(previous.get("video_path", "")).is_file():
            plan["stabilization"][index] = {**deepcopy(previous["region"]), "locked": True, "enabled": region["enabled"], "name": region["name"]}
    plan = normalize_plan(plan, info)
    jobs = compile_jobs(plan, info)
    stabilizers = {r["id"]: r for r in plan["stabilization"] if r["enabled"]}
    report = {"version": VERSION, "source_id": info["source_id"], "operation": operation, "regions": [], "jobs": [], "warnings": [],
              "completed_jobs": 0, "total_jobs": 0, "state_path": str(state_path)}
    selected = set(plan["selected_ids"])
    if operation == "selected" and not selected and plan["selection"][1] <= plan["selection"][0]:
        raise ValueError("Select a region or a nonempty timeline range before processing the selection")
    if operation == "selected":
        a, b = plan["selection"]
        intersects = any(j["start_ms"] < b and j["end_ms"] > a for j in jobs) if b > a else any(
            j["region_id"] in selected or j["stabilization_id"] in selected for j in jobs)
        if not intersects:
            raise ValueError("The selection has no enabled tracking coverage. Add or enable a tracking region there; stabilization runs together with overlapping tracking regions.")
    manifests, projects = {}, []

    def emit(stage, region_id, **extra):
        if interrupt:
            interrupt()
        if progress:
            progress({"stage": stage, "region_id": region_id, "completed_jobs": report["completed_jobs"], "total_jobs": report["total_jobs"], **extra})

    for region in plan["tracking"]:
        if not region["enabled"]:
            continue
        region_jobs = [deepcopy(j) for j in jobs if j["region_id"] == region["id"]]
        dependencies = {j["stabilization_id"] for j in region_jobs} - {None}
        tracker_identity = {k: fingerprint(p) if (p := resolve_checkpoint(checkpoint, stabilizers[k]["reference"].get("tracking_mode", "online"))) else None for k in sorted(dependencies)}
        # Preserve the existing signature for unchanged, online-only plans.
        if not dependencies:
            tracker_identity = None
        elif all(stabilizers[k]["reference"].get("tracking_mode", "online") == "online" for k in dependencies):
            tracker_identity = next(iter(tracker_identity.values()))
        signature = digest({"version": VERSION, "region": _stable(region), "stabilization": [_stable(stabilizers[k]) for k in sorted(dependencies)],
                            "model": model, "checkpoint": tracker_identity,
                            "sample_fps": sample_fps, "mask": [fingerprint(mask_video_range[0]), *map(str, mask_video_range[1:])] if mask_video_range else None})
        pose_region = {k: v for k, v in _stable(region).items() if k not in ("anchor", "additional_anchors", "settings", "candidate_people", "automatic")}
        if region.get('candidate_people'):
            pose_region.pop('person', None)  # All ROI slots are already cached.
        pose_signature = digest({"region": pose_region,
            "stabilization": [_stable(stabilizers[k]) for k in sorted(dependencies)], "model": model,
            "checkpoint": tracker_identity, "sample_fps": sample_fps,
            "mask": [fingerprint(mask_video_range[0]), *map(str, mask_video_range[1:])] if mask_video_range else None})
        mask_dependencies = {k: state.get("masks", {}).get(k, {}).get("id") for k in sorted(dependencies)
                             if stabilizers[k]["reference"].get("point_mask", {}).get("strokes")}
        if mask_dependencies:
            signature = digest([signature, mask_dependencies])
            pose_signature = digest([pose_signature, mask_dependencies])
        if region["anchor"] == MASK_ANCHOR:
            signature = digest([signature, "mesh_anchor", MESH_ANCHOR_VERSION])
            pose_signature = digest([pose_signature, "mesh_anchor", MESH_ANCHOR_VERSION])
        entry = state["regions"].get(region["id"])
        row = {"id": region["id"], "start_ms": region["start_ms"], "end_ms": region["end_ms"], "state": "pending"}
        report["regions"].append(row)
        if region["locked"] and entry and entry.get("project_path") and Path(entry["project_path"]).is_file():
            project = json.loads(Path(entry["project_path"]).read_text())
            project["metadata"]["processing_region"]["locked"] = True
            projects.append(project); row.update(state="locked", coverage=project["metadata"]["processing_coverage"])
            for path in entry.get("additional_project_paths", []):
                extra = json.loads(Path(path).read_text())
                extra["metadata"]["processing_region"]["locked"] = True
                projects.append(extra)
            if entry["signature"] != signature:
                report["warnings"].append(f"Locked region {region['name']} retained its completed settings and coverage. Unlock it to apply changes.")
            continue
        if not entry or entry["signature"] != signature:
            retained = entry.get("jobs", []) if entry and entry.get("pose_signature") == pose_signature else []
            entry = {"signature": signature, "pose_signature": pose_signature, "jobs": retained, "region": deepcopy(region)}
            state["regions"][region["id"]] = entry
        entry["stabilization_regions"] = [deepcopy(stabilizers[k]) for k in sorted(dependencies)]
        row.update(region=deepcopy(entry["region"]), stabilization_regions=deepcopy(entry["stabilization_regions"]))
        pending = region_jobs
        if operation == "selected":
            if plan["selection"][1] > plan["selection"][0]:
                a, b = plan["selection"]
                pending = [j for j in pending if j["start_ms"] < b and j["end_ms"] > a]
                for job in pending:
                    job["start_ms"], job["end_ms"] = max(a, job["start_ms"]), min(b, job["end_ms"])
                    job["id"] = digest([job["region_id"], job["start_ms"], job["end_ms"], job["stabilization_id"]])
                    margin = max(500, region["smoothing_ms"]*3)
                    job["context_start_ms"] = max(job["context_start_ms"], job["start_ms"]-margin)
                    job["context_end_ms"] = min(job["context_end_ms"], job["end_ms"]+margin)
            else:
                pending = [j for j in pending if region["id"] in selected or j["stabilization_id"] in selected]
        if use_cache or operation == "unfinished" or region["locked"]:
            covered = _coverage([r for r in entry["jobs"] if Path(r["path"]).is_file()])
            missing = []
            for job in pending:
                intervals = _uncovered(job["start_ms"], job["end_ms"], covered)
                if not intervals:
                    report["jobs"].append({**job, "state": "cached"})
                    report["completed_jobs"] += 1
                    report["total_jobs"] += 1
                for a, b in intervals:
                    missing.append({**job, "start_ms": a, "end_ms": b,
                                    "id": digest([job["region_id"], a, b, job["stabilization_id"]])})
            pending = missing
        report["total_jobs"] += len(pending)
        mesh_patch = None
        for job in pending:
            emit("poses", region["id"], job_id=job["id"])
            existing = next((r for r in entry["jobs"] if r["id"] == job["id"] and Path(r["path"]).is_file()), None)
            if existing and (use_cache or operation == "unfinished" or region["locked"]):
                report["completed_jobs"] += 1
                report["jobs"].append({**job, "state": "cached"})
                continue
            manifest = None
            source, offset = info["source"]["path"], 0
            start, end = job["context_start_ms"], job["context_end_ms"]
            rois = region["rois"]
            sid = job["stabilization_id"]
            try:
                if region["anchor"] == MASK_ANCHOR and mesh_patch is None:
                    emit("mask_anchor", region["id"])
                    mesh_patch = prepare_patch(info, region, model_file, root, use_cache=use_cache,
                        mask_video_range=mask_video_range, interrupt=interrupt)
                if sid:
                    stabilization = stabilizers[sid]
                    if sid not in manifests:
                        emit("stabilization", region["id"], stabilization_id=sid)
                        manifests[sid] = _stabilize_region(info, stabilization, root, state, checkpoint, use_cache,
                            lambda frames: emit("stabilization", region["id"], stabilization_id=sid, frames=frames), interrupt)
                    manifest, source = manifests[sid]
                    if source is None:
                        raise ValueError("Stabilization reference points are missing")
                    offset = manifest["data"]["source_times_ms"][0]
                    rois = _stabilized_rois(rois, info, manifest, start, end)
                sequence = extract_video(source, model_file, root / "poses", sample_fps=sample_fps,
                    start_seconds=max(0, start-offset)/1000, duration_seconds=(end-max(start, offset))/1000,
                    # Average FPS cannot bound a VFR interval's actual count.
                    # Duration bounds decoded memory; never silently truncate it.
                    max_frames=2**31-1,
                    rois_json=rois, batch_size=batch_size, use_cache=use_cache, mask_video_range=mask_video_range,
                    **({'isolate_subject': True} if region.get('isolate_subject') else {}),
                    **({"mesh_anchor": mesh_patch} if mesh_patch else {}))
                sequence = _original_sequence(sequence, info, manifest)
                path = directory / (digest([signature, job["id"]])+".npz")
                sequence.save(path)
                entry["jobs"] = [r for r in entry["jobs"] if r["id"] != job["id"]] + [{**job, "path": str(path)}]
                entry.pop("project_path", None)
                atomic_json(state_path, state)
                report["completed_jobs"] += 1
                report["jobs"].append({**job, "state": "complete"})
            except BaseException as error:
                # Keep completed caches recoverable while letting the executor
                # report the actual error/cancellation instead of a partial success.
                # ComfyUI cancellation inherits BaseException, and is re-raised.
                row.update(state="error", error=str(error))
                report["jobs"].append({**job, "state": "error", "error": str(error)})
                atomic_json(directory / "report.json", report)
                atomic_json(state_path, state)
                if region.get('automatic') and isinstance(error, ValueError) and 'fewer than two sampled frames' in str(error):
                    row.setdefault('review', []).append(str(error))
                    continue
                raise
        records = [r for r in entry["jobs"] if Path(r["path"]).is_file()]
        if records:
            emit("assembly", region["id"])
            try:
                sequence = _merge_sequences(records, region, info)
            except ValueError as error:
                if not region.get('automatic'): raise
                row.update(state='error', error=str(error))
                continue
            paths, candidates = [], []
            shared_geometry = None
            for person in region.get('candidate_people', [region['person']]):
                for anchor in [region["anchor"], *region["additional_anchors"]]:
                    try:
                        project = build_project(sequence, _region_settings(region, anchor, person))
                    except ValueError as error:
                        if not region.get('automatic'): raise
                        row.setdefault('review', []).append(f'Person {person} · {anchor}: {error}')
                        continue
                    if shared_geometry is None:
                        shared_geometry = {key: project[key] for key in GEOMETRY}
                    else:
                        project.update(shared_geometry)
                    project['metadata'] = {**project['metadata'], 'processing_anchor': {'anchor': anchor,
                        'primary': anchor == region['anchor'] and person == region['person']}}
                    if region.get('automatic'):
                        from .automatic import candidate_review
                        project['metadata']['automatic_candidate'] = candidate_review(sequence, region, person, anchor, project)
                    candidates.append(project)
            if not candidates:
                row.update(state='error', error='No usable anchor candidates; review the person crops')
                continue
            if region.get('automatic', {}).get('suggest'):
                candidates.sort(key=lambda p: (-p['metadata']['automatic_candidate']['score'],
                    bool(p['metadata']['automatic_candidate']['review']), p['config']['target_person'], p['config']['target_anchor']))
                for i, project in enumerate(candidates):
                    project['metadata']['processing_anchor']['primary'] = i == 0
                    project['metadata']['automatic_candidate']['suggested'] = i == 0
            for project in candidates:
                anchor, person = project['config']['target_anchor'], project['config']['target_person']
                project_path = directory / (digest([signature, anchor, person, [r["id"] for r in records]])+".project.json")
                atomic_json(project_path, project)
                paths.append(str(project_path)); projects.append(project)
            entry["project_path"], entry["additional_project_paths"] = paths[0], paths[1:]
            atomic_json(state_path, state)
            coverage = _coverage(records)
            row.update(state="complete" if coverage == [[region["start_ms"], region["end_ms"]]] else "partial", coverage=coverage,
                       project_path=paths[0], anchors=[region["anchor"], *region["additional_anchors"]])
            if region.get('automatic'):
                row['candidates'] = [p['metadata']['automatic_candidate'] for p in candidates]
                primary = next((p for p in candidates if p['metadata']['processing_anchor']['primary']), candidates[0])
                row['review'] = list(dict.fromkeys([*row.get('review', []), *primary['metadata']['automatic_candidate']['review']]))
    project = assemble_projects(projects, plan, info)
    if project:
        used = {record.get("stabilization_id") for region in report["regions"]
                for record in state["regions"].get(region["id"], {}).get("jobs", [])} - {None}
        for sid in used - set(manifests):
            stored = state["stabilization"].get(sid)
            if stored and Path(stored["manifest_path"]).is_file() and Path(stored["video_path"]).is_file():
                manifests[sid] = json.loads(Path(stored["manifest_path"]).read_text()), Path(stored["video_path"])
        project["metadata"]["processing_timeline"]["stabilized_regions"] = [
            {"id": sid, "source": fingerprint(path), "reference_id": manifest["id"], "source_times_ms": manifest["data"]["source_times_ms"],
             "times_ms": manifest["data"]["times_ms"], "shift_xy": manifest["data"]["shift_xy"], "padding_xy": manifest["video"]["padding_xy"]}
            for sid, (manifest, path) in manifests.items()]
        result_path = directory / "project.json"
        atomic_json(result_path, project)
        report["result_path"] = str(result_path)
    atomic_json(directory / "report.json", report)
    return project, report
