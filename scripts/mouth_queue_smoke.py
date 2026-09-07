"""Validate mouth extraction through streaming and core ComfyUI workflows."""

import argparse
import copy
import json
from pathlib import Path

import numpy as np

from queue_smoke import get, queue, ROOT


def result(prompt, node):
    item = queue(prompt)
    path = Path(item["outputs"][str(node)]["text"][0])
    return json.loads(path.read_text()), path


def check(project):
    assert project["config"]["target_anchor"] == "mouth"
    assert project["anchor_indices"]["target"] == [70, 71]
    assert len(project["points"][0][0]) == 72
    assert any(project["valid"])
    assert any("neutral facial expression" in text for text in project["warnings"])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mask-fixture", action="store_true", help="Also use the existing s3f_mask_test video fixtures")
    args = parser.parse_args()
    info = get("/object_info")
    assert "mouth" in info["S3F_BuildMotion"]["input"]["required"]["target_anchor"][0]
    api = json.loads((ROOT / "workflows/video_to_funscript.api.json").read_text())
    api["2"]["inputs"]["target_anchor"] = "mouth"
    api["3"]["inputs"]["filename"] = "mouth"
    stream, stream_path = result(api, 3)
    check(stream)
    assert len(stream["times_ms"]) == 270
    assert stream["metadata"]["settings"]["cache_version"] == 2
    print(f"Streaming mouth project: {stream_path}", flush=True)
    # Load the same compact cache, with no dependency on a model or video decoder.
    cached = copy.deepcopy(api)
    cached["1"] = {"class_type": "S3F_LoadPoseCache", "inputs": {"cache_path": stream["metadata"]["cache_path"]}}
    reused, _ = result(cached, 3)
    assert reused["scripts"] == stream["scripts"]

    core = json.loads((ROOT / "workflows/core_video_to_funscript.api.json").read_text())
    core["2"]["inputs"]["duration"] = .25
    core["7"]["inputs"]["target_anchor"] = "mouth"
    core["8"]["inputs"]["filename"] = "mouth_core"
    native, native_path = result(core, 8)
    check(native)
    assert len(native["times_ms"]) == 8
    print(f"Core body-only mouth project: {native_path}", flush=True)
    # Body anchors still work without facial output or the optional model input.
    del core["6"]["inputs"]["sam3d_body_model"]
    core["7"]["inputs"]["target_anchor"] = "pelvis"
    legacy, _ = result(core, 8)
    assert all(legacy["valid"])
    assert legacy["points"][0][0][70:] == [[None] * 3, [None] * 3]

    report = {"stream_project": str(stream_path), "core_project": str(native_path),
              "stream_samples": len(stream["times_ms"]), "stream_valid_fraction": float(np.mean(stream["valid"])),
              "core_samples": len(native["times_ms"]), "cache_reuse_identical_scripts": True,
              "body_without_optional_model_still_works": True}
    if args.mask_fixture:
        masked = copy.deepcopy(api)
        masked["4"]["inputs"]["file"] = "s3f_mask_test/source.mp4"
        masked["5"] = {"class_type": "LoadVideo", "inputs": {"file": "s3f_mask_test/person_A.mp4"}}
        masked["1"]["inputs"].update(duration_seconds=1.25, mask_video=["5", 0])
        masked["3"]["inputs"]["filename"] = "mouth_mask"
        project, mask_path = result(masked, 3)
        check(project)
        assert len(project["times_ms"]) == 20
        assert [i for i, valid in enumerate(project["valid"]) if not valid] == [12, 13, 14, 15]
        assert all(project["points"][i][0][70:] == [[None] * 3, [None] * 3] for i in range(12, 16))
        report.update(mask_project=str(mask_path), mask_missing_frames_preserved=True)
    workflow = json.loads((ROOT / "workflows/cached_pose_to_funscript.json").read_text())
    workflow["nodes"][0]["widgets_values"] = [stream["metadata"]["cache_path"]]
    workflow["nodes"][1]["widgets_values"][1] = "mouth"
    (ROOT / "development/mouth-workflow.json").write_text(json.dumps(workflow, indent=2))
    (ROOT / "development/mouth-queue-validation.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2), flush=True)


if __name__ == "__main__":
    main()
