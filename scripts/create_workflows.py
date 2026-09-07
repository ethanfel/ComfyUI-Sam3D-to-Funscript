"""Generate canvas-editable examples and an API companion for automated validation."""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

API = {
    "1": {"class_type": "S3F_VideoPose", "inputs": {
        "video_path": "videos/nsfw/rcowgirl_6.mp4", "model_file": "sam_3d_body_dinov3_bf16.safetensors",
        "sample_fps": 16.0, "start_seconds": 0.0, "duration_seconds": 0.0, "max_frames": 2000,
        "rois_json": "[[0,0,1,1]]", "batch_size": 8, "fov": 0.0, "use_cache": True}},
    "2": {"class_type": "S3F_BuildMotion", "inputs": {
        "poses": ["1", 0], "target_person": 0, "target_anchor": "pelvis", "reference_person": -1,
        "reference_anchor": "pelvis", "frame": "camera", "smoothing_ms": 80.0,
        "enabled_axes": "L0,L1,L2,R0,R1,R2", "settings_json": "{}"}},
    "3": {"class_type": "S3F_PreviewExport", "inputs": {"project": ["2", 0], "filename": "rcowgirl_6"}},
}


def make_node(node_id, spec, position, size, inputs, outputs, widgets, title):
    return {"id": node_id, "type": spec["class_type"], "pos": position, "size": size,
            "flags": {}, "order": node_id - 1, "mode": 0, "inputs": inputs, "outputs": outputs,
            "properties": {"Node name for S&R": spec["class_type"]}, "widgets_values": widgets,
            "title": title}


def main():
    nodes = [
        make_node(1, API["1"], [80, 140], [380, 480], [],
                  [{"name": "poses", "type": "S3F_POSE_SEQUENCE", "links": [1], "slot_index": 0},
                   {"name": "cache_path", "type": "STRING", "links": None, "slot_index": 1}],
                  list(API["1"]["inputs"].values()), "1 · Video & person ROI"),
        make_node(2, API["2"], [550, 140], [380, 440],
                  [{"name": "poses", "type": "S3F_POSE_SEQUENCE", "link": 1}],
                  [{"name": "S3F_MOTION_PROJECT", "type": "S3F_MOTION_PROJECT", "links": [2], "slot_index": 0}],
                  list(API["2"]["inputs"].values())[1:], "2 · Anchors & axis calibration"),
        make_node(3, API["3"], [1030, 140], [820, 720],
                  [{"name": "project", "type": "S3F_MOTION_PROJECT", "link": 2}],
                  [{"name": "project_path", "type": "STRING", "links": None, "slot_index": 0}],
                  ["rcowgirl_6"], "3 · Review, edit & export"),
    ]
    workflow = {"last_node_id": 3, "last_link_id": 2, "nodes": nodes,
                "links": [[1, 1, 0, 2, 0, "S3F_POSE_SEQUENCE"], [2, 2, 0, 3, 0, "S3F_MOTION_PROJECT"]],
                "groups": [{"title": "SAM3D extraction · cached", "bounding": [50, 60, 440, 610], "color": "#365770", "font_size": 22, "flags": {}},
                           {"title": "Motion authoring", "bounding": [520, 60, 440, 610], "color": "#446958", "font_size": 22, "flags": {}},
                           {"title": "Preview · open full editor for more space", "bounding": [1000, 60, 890, 850], "color": "#655079", "font_size": 22, "flags": {}}],
                "config": {}, "extra": {"ds": {"scale": .65, "offset": [30, 20]}}, "version": .4}
    (ROOT / "workflows/video_to_funscript.json").write_text(json.dumps(workflow, indent=2))
    (ROOT / "workflows/video_to_funscript.api.json").write_text(json.dumps(API, indent=2))
    cache_workflow = json.loads(json.dumps(workflow))
    node = cache_workflow["nodes"][0]
    node.update(type="S3F_LoadPoseCache", title="1 · Reopen cached poses", size=[380, 120],
                widgets_values=["/absolute/path/to/poses.npz"], outputs=node["outputs"][:1],
                properties={"Node name for S&R": "S3F_LoadPoseCache"})
    (ROOT / "workflows/cached_pose_to_funscript.json").write_text(json.dumps(cache_workflow, indent=2))
    comparison = json.loads(json.dumps(workflow))
    comparison["nodes"][2]["pos"] = [1450, 140]
    comparison["nodes"][2]["inputs"][0]["link"] = 3
    comparison["nodes"][2]["order"] = 3
    comparison["nodes"].append(make_node(4, {"class_type": "S3F_CompareReference"}, [1030, 140], [340, 240],
        [{"name": "project", "type": "S3F_MOTION_PROJECT", "link": 2}],
        [{"name": "project_with_reference", "type": "S3F_MOTION_PROJECT", "links": [3], "slot_index": 0},
         {"name": "comparison_json", "type": "STRING", "links": None, "slot_index": 1}],
        ["/absolute/path/to/reference.funscript", "L0", 0.0], "3 · Compare reference"))
    comparison["nodes"][-1]["order"] = 2
    comparison["links"] = [[1, 1, 0, 2, 0, "S3F_POSE_SEQUENCE"], [2, 2, 0, 4, 0, "S3F_MOTION_PROJECT"], [3, 4, 0, 3, 0, "S3F_MOTION_PROJECT"]]
    comparison["last_node_id"] = 4; comparison["last_link_id"] = 3
    comparison["groups"][2]["bounding"] = [1000, 60, 1320, 850]
    (ROOT / "workflows/video_with_reference.json").write_text(json.dumps(comparison, indent=2))


if __name__ == "__main__":
    main()
