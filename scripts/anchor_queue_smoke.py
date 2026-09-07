"""Exercise general anchors, overrides and legacy APIs on the real ComfyUI queue.

Pass an existing pose cache from a source video for an additional browser fixture.
No model inference is performed.
"""

import argparse
import copy
import json
import sys
from pathlib import Path
import urllib.error

from queue_smoke import get, queue, ROOT

sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))
from test_core import fixture
from sam3d_funscript.anchors import ANCHORS, GENERAL_ANCHORS, MHR70_NAMES
from sam3d_funscript.core import PoseSequence, build_project


def run_project(prompt):
    item = queue(prompt)
    path = Path(item["outputs"]["3"]["text"][0])
    return json.loads(path.read_text()), path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cache", type=Path)
    args = parser.parse_args()
    info = get("/object_info")
    assert info["S3F_BuildMotion"]["input"]["required"]["target_anchor"][0] == list(GENERAL_ANCHORS)
    assert info["S3F_AnchorOverride"]["input"]["required"]["anchor"][0] == list(MHR70_NAMES)
    sequence = fixture()
    for person in range(2):
        for joint in range(70):
            sequence.points[:, person, joint, 0] += (person + 1) * (joint + 1) * sequence.times_ms / 100000
    cache = ROOT / "development/anchor-fixture.npz"
    sequence.save(cache)
    api = json.loads((ROOT / "workflows/detailed_anchor_override.api.json").read_text())
    api["1"]["inputs"]["cache_path"] = str(cache)
    api["2"]["inputs"].update(reference_person=1, reference_anchor="right_hand", reference_anchor_override=["5", 0])
    api["5"] = {"class_type": "S3F_AnchorOverride", "inputs": {"anchor": "right_pinky_tip"}}
    overrides, _ = run_project(api)
    config = {k: v for k, v in api["2"]["inputs"].items()
              if k not in ("poses", "settings_json", "target_anchor_override", "reference_anchor_override")}
    config.update(target_anchor="left_index_tip", reference_anchor="right_pinky_tip", enabled_axes=config["enabled_axes"].split(","))
    expected = build_project(sequence, config)
    assert overrides["config"] == expected["config"]
    assert overrides["scripts"] == expected["scripts"]
    assert overrides["anchor_indices"] == {"target": [46], "reference": [37]}

    for name in GENERAL_ANCHORS:
        prompt = copy.deepcopy(api)
        del prompt["2"]["inputs"]["target_anchor_override"], prompt["2"]["inputs"]["reference_anchor_override"]
        prompt["2"]["inputs"].update(target_anchor=name, reference_anchor=name)
        project, _ = run_project(prompt)
        expected = build_project(sequence, {**config, "target_anchor": name, "reference_anchor": name})
        assert project["scripts"] == expected["scripts"]
        assert project["anchor_indices"] == {"target": list(ANCHORS[name]), "reference": list(ANCHORS[name])}

    legacy = copy.deepcopy(api)
    del legacy["2"]["inputs"]["target_anchor_override"], legacy["2"]["inputs"]["reference_anchor_override"]
    legacy["2"]["inputs"].update(target_anchor="left_index_tip", reference_anchor="right_pinky_tip")
    old, _ = run_project(legacy)
    assert old["scripts"] == overrides["scripts"]
    legacy["2"]["inputs"]["target_anchor"] = "nonexistent_landmark"
    try:
        queue(legacy)
    except urllib.error.HTTPError as error:
        assert error.code == 400
        assert "Unknown anchor" in error.read().decode()
    else:
        raise AssertionError("Unknown legacy anchor passed prompt validation")

    report = {"general_choices": list(GENERAL_ANCHORS), "detailed_choices": len(MHR70_NAMES),
              "both_overrides_take_precedence": True, "legacy_api_preserved": True,
              "all_general_anchors_match_direct_math": True, "unknown_anchor_rejected": True}
    if args.cache:
        real = json.loads((ROOT / "workflows/detailed_anchor_override.api.json").read_text())
        real["1"]["inputs"]["cache_path"] = str(args.cache.resolve())
        del real["2"]["inputs"]["target_anchor_override"]
        project, project_path = run_project(real)
        expected = build_project(PoseSequence.load(args.cache), {"target_anchor": "left_hand"})
        assert project["scripts"] == expected["scripts"]
        workflow = json.loads((ROOT / "workflows/detailed_anchor_override.json").read_text())
        workflow["nodes"][0]["widgets_values"] = [str(args.cache.resolve())]
        workflow_path = ROOT / "development/anchor-workflow.json"
        workflow_path.write_text(json.dumps(workflow, indent=2))
        report.update(hand_project=str(project_path), browser_workflow=str(workflow_path))
    (ROOT / "development/anchor-queue-validation.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
