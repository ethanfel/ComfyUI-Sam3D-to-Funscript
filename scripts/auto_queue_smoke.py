"""Check Auto direction against saved projects through ComfyUI, without inference."""

import argparse
import copy
import json
from pathlib import Path
import subprocess
import sys

from queue_smoke import queue, ROOT

sys.path.insert(0, str(ROOT))
from sam3d_funscript.core import PoseSequence, build_project


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("projects", nargs="+", type=Path, help="Saved projects with an accessible pose cache")
    args = parser.parse_args()
    reports = []
    for original_path in args.projects:
        original = json.loads(original_path.read_text())
        config = copy.deepcopy(original["config"])
        config["axis_settings"]["L0"].update(component="auto", auto_fit=True)
        cache_path = original["metadata"]["cache_path"]
        expected = build_project(PoseSequence.load(cache_path), config)
        visible = ("target_person", "target_anchor", "reference_person", "reference_anchor", "frame", "smoothing_ms")
        api = {
            "1": {"class_type": "S3F_LoadPoseCache", "inputs": {"cache_path": cache_path}},
            "2": {"class_type": "S3F_BuildMotion", "inputs": {"poses": ["1", 0],
                **{key: config[key] for key in visible}, "enabled_axes": ",".join(config["enabled_axes"]),
                "settings_json": json.dumps({key: value for key, value in config.items() if key not in (*visible, "enabled_axes")})}},
            "3": {"class_type": "S3F_PreviewExport", "inputs": {"project": ["2", 0], "filename": "auto_direction"}},
        }
        item = queue(api)
        path = Path(item["outputs"]["3"]["text"][0])
        actual = json.loads(path.read_text())
        assert actual["scripts"] == expected["scripts"]
        assert actual["config"] == expected["config"]
        subprocess.run(["node", "tests/test_auto.mjs", str(path)], cwd=ROOT, check=True)
        # Keep a served copy of the older project to test Auto without new hints.
        old = queue({"1": {"class_type": "S3F_LoadProject", "inputs": {"project_path": str(original_path.resolve())}},
                     "3": {"class_type": "S3F_PreviewExport", "inputs": {"project": ["1", 0], "filename": "before_auto"}}})
        old_path = Path(old["outputs"]["3"]["text"][0])
        actions = actual["scripts"]["L0"]["actions"]
        reports.append({"original": str(original_path), "project": str(path), "before_project": str(old_path),
                        "L0": actual["config"]["axis_settings"]["L0"],
                        "script_span": max(a["pos"] for a in actions) - min(a["pos"] for a in actions),
                        "directions": actual["metrics"]["L0"]["auto_direction"],
                        "other_scripts_unchanged": all(actual["scripts"][axis] == original["scripts"][axis] for axis in actual["scripts"] if axis != "L0")})
        assert reports[-1]["other_scripts_unchanged"]
        if len(reports) == 1:
            workflow = json.loads((ROOT / "workflows/cached_pose_to_funscript.json").read_text())
            workflow["nodes"][0]["widgets_values"] = [cache_path]
            workflow["nodes"][1]["widgets_values"] = [*[config[key] for key in visible], ",".join(config["enabled_axes"]), api["2"]["inputs"]["settings_json"]]
            # Keep this fixture focused on Auto; inactive legacy reference points
            # otherwise add an override node during the separate migration test.
            if config["reference_person"] < 0:
                workflow["nodes"][1]["widgets_values"][3] = "pelvis"
            (ROOT / "development/auto-workflow.json").write_text(json.dumps(workflow, indent=2))
    (ROOT / "development/auto-queue-validation.json").write_text(json.dumps(reports, indent=2))
    print(json.dumps(reports, indent=2))


if __name__ == "__main__":
    main()
