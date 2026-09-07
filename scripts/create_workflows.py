"""Generate canvas-editable examples and an API companion for automated validation."""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

API = {
    "1": {"class_type": "S3F_VideoPose", "inputs": {
        "video": ["4", 0], "model_file": "sam_3d_body_dinov3_bf16.safetensors",
        "sample_fps": 16.0, "start_seconds": 0.0, "duration_seconds": 0.0, "max_frames": 2000,
        "rois_json": "[[0,0,1,1]]", "batch_size": 8, "fov": 0.0, "use_cache": True}},
    "2": {"class_type": "S3F_BuildMotion", "inputs": {
        "poses": ["1", 0], "target_person": 0, "target_anchor": "pelvis", "reference_person": -1,
        "reference_anchor": "pelvis", "frame": "camera", "smoothing_ms": 80.0,
        "enabled_axes": "L0,L1,L2,R0,R1,R2", "settings_json": "{}"}},
    "3": {"class_type": "S3F_PreviewExport", "inputs": {"project": ["2", 0], "filename": "rcowgirl_6"}},
    "4": {"class_type": "LoadVideo", "inputs": {"file": "videos/nsfw/rcowgirl_6.mp4"}},
}


def make_node(node_id, spec, position, size, inputs, outputs, widgets, title):
    return {"id": node_id, "type": spec["class_type"], "pos": position, "size": size,
            "flags": {}, "order": node_id - 1, "mode": 0, "inputs": inputs, "outputs": outputs,
            "properties": {"Node name for S&R": spec["class_type"]}, "widgets_values": widgets,
            "title": title}


def core_workflow():
    """An additional native-node path; leave the original examples intact."""
    api = {
        "1": {"class_type": "LoadVideo", "inputs": {"file": "videos/nsfw/rcowgirl_6.mp4"}},
        "2": {"class_type": "Video Slice", "inputs": {"video": ["1", 0], "start_time": 0.0, "duration": 0.0, "strict_duration": False}},
        "3": {"class_type": "GetVideoComponents", "inputs": {"video": ["2", 0]}},
        "4": {"class_type": "SAM3DBody_Loader", "inputs": {"model_file": "sam_3d_body_dinov3_bf16.safetensors"}},
        "5": {"class_type": "SAM3DBody_Predict", "inputs": {"sam3d_body_model": ["4", 0], "image": ["3", 0],
            "run_hand_refinement": False, "fov": 0.0, "batch_size": 8}},
        "6": {"class_type": "S3F_CorePoseAdapter", "inputs": {"mhr_pose_data": ["5", 0], "video": ["2", 0]}},
        "7": {"class_type": "S3F_BuildMotion", "inputs": {**API["2"]["inputs"], "poses": ["6", 0]}},
        "8": {"class_type": "S3F_PreviewExport", "inputs": {"project": ["7", 0], "filename": "rcowgirl_6_core"}},
    }
    def output(name, type_name, links, slot=0):
        return {"name": name, "type": type_name, "links": links, "slot_index": slot}
    def port(name, type_name, link):
        return {"name": name, "type": type_name, "link": link}
    nodes = [
        make_node(1, api["1"], [80, 150], [340, 550], [], [output("VIDEO", "VIDEO", [1])],
                  [api["1"]["inputs"]["file"]], "1 · Load video · core"),
        make_node(2, api["2"], [500, 150], [290, 190], [port("video", "VIDEO", 1)], [output("VIDEO", "VIDEO", [2, 6])],
                  [0.0, 0.0, False], "2 · Trim video · core"),
        make_node(3, api["3"], [870, 150], [260, 160], [port("video", "VIDEO", 2)],
                  [output(name, kind, [3] if slot == 0 else None, slot) for slot, (name, kind) in enumerate([
                      ("images", "IMAGE"), ("audio", "AUDIO"), ("fps", "FLOAT"), ("bit_depth", "COMBO"), ("color_space", "COMBO")])],
                  [], "3 · Get video components · core"),
        make_node(4, api["4"], [500, 490], [360, 100], [], [output("sam3d_body_model", "SAM3D_BODY_MODEL", [4])],
                  [api["4"]["inputs"]["model_file"]], "Load SAM3D Body model · core"),
        make_node(5, api["5"], [1210, 150], [330, 250],
                  [port("sam3d_body_model", "SAM3D_BODY_MODEL", 4), port("image", "IMAGE", 3),
                   port("track_data", "SAM3_TRACK_DATA", None), port("bboxes", "BOUNDING_BOX", None)],
                  [output("mhr_pose_data", "MHR_POSE_DATA", [5])], [False, 0.0, 8], "4 · SAM3D Body prediction · core"),
        make_node(6, api["6"], [1620, 150], [300, 150],
                  [port("mhr_pose_data", "MHR_POSE_DATA", 5), port("video", "VIDEO", 6)],
                  [output("poses", "S3F_POSE_SEQUENCE", [7]), output("cache_path", "STRING", None, 1)],
                  [], "5 · Adapt native poses & timing"),
        make_node(7, api["7"], [2000, 150], [380, 440], [port("poses", "S3F_POSE_SEQUENCE", 7)],
                  [output("S3F_MOTION_PROJECT", "S3F_MOTION_PROJECT", [8])],
                  list(API["2"]["inputs"].values())[1:], "6 · Anchors & axis calibration"),
        make_node(8, api["8"], [2470, 150], [1100, 980], [port("project", "S3F_MOTION_PROJECT", 8)],
                  [output("project_path", "STRING", None)], ["rcowgirl_6_core"], "7 · Review, edit & export"),
    ]
    links = [[1, 1, 0, 2, 0, "VIDEO"], [2, 2, 0, 3, 0, "VIDEO"], [3, 3, 0, 5, 1, "IMAGE"],
             [4, 4, 0, 5, 0, "SAM3D_BODY_MODEL"], [5, 5, 0, 6, 0, "MHR_POSE_DATA"],
             [6, 2, 0, 6, 1, "VIDEO"], [7, 6, 0, 7, 0, "S3F_POSE_SEQUENCE"], [8, 7, 0, 8, 0, "S3F_MOTION_PROJECT"]]
    groups = [{"title": title, "bounding": box, "color": color, "font_size": 22, "flags": {}}
              for title, box, color in [
                  ("Core video & SAM3D", [50, 70, 1520, 710], "#365770"),
                  ("Native pose adapter", [1590, 70, 360, 280], "#446958"),
                  ("Motion authoring", [1970, 70, 440, 610], "#446958"),
                  ("Preview & export", [2440, 70, 1160, 1100], "#655079")]]
    workflow = {"last_node_id": 8, "last_link_id": 8, "nodes": nodes, "links": links, "groups": groups,
                "config": {}, "extra": {"ds": {"scale": .45, "offset": [30, 20]}}, "version": .4}
    (ROOT / "workflows/core_video_to_funscript.json").write_text(json.dumps(workflow, indent=2))
    (ROOT / "workflows/core_video_to_funscript.api.json").write_text(json.dumps(api, indent=2))


def main():
    nodes = [
        make_node(1, API["1"], [80, 140], [380, 480], [{"name": "video", "type": "VIDEO", "link": 3}],
                  [{"name": "poses", "type": "S3F_POSE_SEQUENCE", "links": [1], "slot_index": 0},
                   {"name": "cache_path", "type": "STRING", "links": None, "slot_index": 1}],
                  list(API["1"]["inputs"].values())[1:], "1 · Stream video & estimate poses"),
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
    cache_workflow = json.loads(json.dumps(workflow))
    node = cache_workflow["nodes"][0]
    node.update(type="S3F_LoadPoseCache", title="1 · Reopen cached poses", size=[380, 120],
                widgets_values=["/absolute/path/to/poses.npz"], inputs=[], outputs=node["outputs"][:1],
                properties={"Node name for S&R": "S3F_LoadPoseCache"})
    (ROOT / "workflows/cached_pose_to_funscript.json").write_text(json.dumps(cache_workflow, indent=2))
    loader = make_node(4, API["4"], [-350, 140], [340, 550], [],
        [{"name": "VIDEO", "type": "VIDEO", "links": [3], "slot_index": 0}],
        [API["4"]["inputs"]["file"]], "Load video · core")
    workflow["nodes"].append(loader)
    workflow["links"].append([3, 4, 0, 1, 0, "VIDEO"])
    workflow["last_node_id"] = 4; workflow["last_link_id"] = 3
    workflow["groups"].insert(0, {"title": "Core video input", "bounding": [-380, 60, 400, 680],
        "color": "#365770", "font_size": 22, "flags": {}})
    workflow["extra"]["ds"] = {"scale": .6, "offset": [400, 20]}
    (ROOT / "workflows/video_to_funscript.json").write_text(json.dumps(workflow, indent=2))
    (ROOT / "workflows/video_to_funscript.api.json").write_text(json.dumps(API, indent=2))
    comparison = json.loads(json.dumps(workflow))
    comparison["nodes"][2]["pos"] = [1450, 140]
    comparison["nodes"][2]["inputs"][0]["link"] = 4
    comparison["nodes"][2]["order"] = 3
    comparison["nodes"].append(make_node(5, {"class_type": "S3F_CompareReference"}, [1030, 140], [340, 240],
        [{"name": "project", "type": "S3F_MOTION_PROJECT", "link": 2}],
        [{"name": "project_with_reference", "type": "S3F_MOTION_PROJECT", "links": [4], "slot_index": 0},
         {"name": "comparison_json", "type": "STRING", "links": None, "slot_index": 1}],
        ["/absolute/path/to/reference.funscript", "L0", 0.0], "3 · Compare reference"))
    comparison["nodes"][-1]["order"] = 2
    comparison["links"] = [[1, 1, 0, 2, 0, "S3F_POSE_SEQUENCE"], [2, 2, 0, 5, 0, "S3F_MOTION_PROJECT"],
                           [3, 4, 0, 1, 0, "VIDEO"], [4, 5, 0, 3, 0, "S3F_MOTION_PROJECT"]]
    comparison["last_node_id"] = 5; comparison["last_link_id"] = 4
    comparison["groups"][3]["bounding"] = [1000, 60, 1320, 850]
    (ROOT / "workflows/video_with_reference.json").write_text(json.dumps(comparison, indent=2))
    core_workflow()


if __name__ == "__main__":
    main()
