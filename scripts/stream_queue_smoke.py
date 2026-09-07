"""Validate the lazy VIDEO entry, trim bounds, disk cache and expanded anchors."""

import copy
import json
from pathlib import Path

import av

from queue_smoke import get, queue, ROOT


def project_from_history(item):
    path = Path(item["outputs"]["3"]["text"][0])
    return json.loads(path.read_text()), path


def main():
    info = get("/object_info")
    assert info["S3F_VideoPose"]["input"]["required"]["video"][0] == "VIDEO"
    choices = info["S3F_BuildMotion"]["input"]["required"]["target_anchor"][0]
    assert len(choices) == 8 and "left_hand" in choices and "neck" in choices
    detailed = info["S3F_AnchorOverride"]["input"]["required"]["anchor"][0]
    assert len(detailed) == 70 and "left_index_tip" in detailed
    api = json.loads((ROOT / "workflows/video_to_funscript.api.json").read_text())
    api["1"]["inputs"]["use_cache"] = False
    full, full_path = project_from_history(queue(api))
    assert not full["metadata"]["cache_hit"]
    assert len(full["times_ms"]) == 270
    assert full["times_ms"][0] == 0 and full["times_ms"][-1] == 16812.5
    assert full["metadata"]["duration_ms"] == 16843.75
    print(f"Full streaming inference: {full_path}", flush=True)

    trimmed_api = copy.deepcopy(api)
    trimmed_api["5"] = {"class_type": "Video Slice", "inputs": {
        "video": ["4", 0], "start_time": 4.0, "duration": .24, "strict_duration": False}}
    trimmed_api["1"]["inputs"].update(video=["5", 0], start_seconds=.0625, duration_seconds=2.0, sample_fps=0)
    trimmed_api["3"]["inputs"]["filename"] = "stream_trim"
    trimmed, trimmed_path = project_from_history(queue(trimmed_api))
    assert trimmed["times_ms"] == [4062.5, 4093.75, 4125.0, 4156.25, 4187.5, 4218.75]
    with av.open(full["metadata"]["source"]["path"]) as container:
        base = container.streams.video[0].time_base
        end_ms = float(int(4.24 / base) * base * 1000)
    assert trimmed["metadata"]["duration_ms"] == end_ms
    assert trimmed["scripts"]["L0"]["actions"][-1]["at"] == round(end_ms)
    print(f"Upstream trim and additional offset: {trimmed_path}", flush=True)

    api["1"]["inputs"]["use_cache"] = True
    api["6"] = {"class_type": "S3F_AnchorOverride", "inputs": {"anchor": "left_index_tip"}}
    api["2"]["inputs"]["target_anchor_override"] = ["6", 0]
    anchor, anchor_path = project_from_history(queue(api))
    assert anchor["metadata"]["cache_hit"]
    assert anchor["anchor_indices"]["target"] == [46]
    assert anchor["metadata"]["cache_path"] == full["metadata"]["cache_path"]
    assert anchor["scripts"]["L0"] != full["scripts"]["L0"]
    report = {"full_project": str(full_path), "trimmed_project": str(trimmed_path),
        "anchor_project": str(anchor_path), "full_frames": 270, "trimmed_frames": 6,
        "anchor_choices": len(choices), "anchor_change_reused_cache": True,
        "trim_end_ms": end_ms, "inference_seconds": full["metadata"]["inference_seconds"]}
    (ROOT / "development/stream-queue-validation.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2), flush=True)


if __name__ == "__main__":
    main()
