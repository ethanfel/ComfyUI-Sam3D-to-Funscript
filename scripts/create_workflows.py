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
    if spec["class_type"] == "S3F_BuildMotion":
        for name in ("target_anchor_override", "reference_anchor_override"):
            if not any(port["name"] == name for port in inputs):
                inputs.append({"name": name, "type": "S3F_ANCHOR", "link": None})
    return {"id": node_id, "type": spec["class_type"], "pos": position, "size": size,
            "flags": {}, "order": node_id - 1, "mode": 0, "inputs": inputs, "outputs": outputs,
            "properties": {"Node name for S&R": spec["class_type"]}, "widgets_values": widgets,
            "title": title}


def write_workflow(name, workflow, api):
    """Give each export branch a standalone owner and an explicitly linked view."""
    workflow, api = json.loads(json.dumps(workflow)), json.loads(json.dumps(api))
    next_node = max(node['id'] for node in workflow['nodes'])
    next_link = max((link[0] for link in workflow['links']), default=0)
    for owner in list(workflow['nodes']):
        if owner['type'] != 'S3F_PreviewExport':
            continue
        next_node += 1; next_link += 1
        old_inputs = owner['inputs']
        projects = [{**port, 'name': 'project_0' if port['name'] == 'project' else port['name']}
                    for port in old_inputs if port['name'].startswith('project')]
        if projects[-1]['link'] is not None:
            projects.append({'name': f"project_{len(projects)}", 'type': 'S3F_MOTION_PROJECT', 'link': None})
        owner['inputs'] = [{'name': 'editor_session', 'type': 'S3F_EDITOR_SESSION', 'link': None}, *projects]
        for link in workflow['links']:
            if link[3] == owner['id']:
                link[4] = next(i for i, port in enumerate(owner['inputs']) if port.get('link') == link[0])
        x, y = owner['pos']; width, height = owner['size']
        preview = make_node(next_node, {'class_type': 'S3F_PreviewExport'}, [x + 460, y], [width, height],
            [{'name': 'editor_session', 'type': 'S3F_EDITOR_SESSION', 'link': next_link},
             {'name': 'project_0', 'type': 'S3F_MOTION_PROJECT', 'link': None}],
            [{'name': 'project_path', 'type': 'STRING', 'links': None, 'slot_index': 0},
             {'name': 'editor_session', 'type': 'S3F_EDITOR_SESSION', 'links': None, 'slot_index': 1}],
            owner['widgets_values'][:1], 'Linked preview · same editing session')
        owner.update(type='S3F_StandaloneExport', title='Motion Studio · open in new tab',
                     size=[380, 190 + 22 * len(projects)], properties={'Node name for S&R': 'S3F_StandaloneExport'})
        owner['outputs'] = [
            {'name': 'project_path', 'type': 'STRING', 'links': None, 'slot_index': 0},
            {'name': 'viewer_path', 'type': 'STRING', 'links': None, 'slot_index': 1},
            {'name': 'editor_session', 'type': 'S3F_EDITOR_SESSION', 'links': [next_link], 'slot_index': 2}]
        workflow['nodes'].append(preview)
        workflow['links'].append([next_link, owner['id'], 2, next_node, 0, 'S3F_EDITOR_SESSION'])
        for group in workflow['groups']:
            gx, gy, gw, gh = group['bounding']
            if gx <= x < gx + gw and gy <= y < gy + gh:
                group['bounding'][2] = max(gw, x + 460 + width + 30 - gx)
                if 'preview' in group['title'].lower():
                    group['title'] = 'Motion Studio · standalone + linked preview'
        spec = api[str(owner['id'])]
        spec['class_type'] = 'S3F_StandaloneExport'
        if 'project' in spec['inputs']:
            spec['inputs']['project_0'] = spec['inputs'].pop('project')
        api[str(next_node)] = {'class_type': 'S3F_PreviewExport', 'inputs': {
            'editor_session': [str(owner['id']), 2], 'filename': owner['widgets_values'][0]}}
    workflow.update(last_node_id=next_node, last_link_id=next_link)
    pending = {node['id']: node for node in workflow['nodes']}; ordered = set()
    while pending:
        ready = [node for key, node in pending.items() if all(link[1] in ordered for link in workflow['links'] if link[3] == key)]
        if not ready:
            raise ValueError('Example workflow contains a cycle')
        for node in ready:
            node['order'] = len(ordered); ordered.add(node['id']); del pending[node['id']]
    (ROOT / f'workflows/{name}.json').write_text(json.dumps(workflow, indent=2) + '\n')
    (ROOT / f'workflows/{name}.api.json').write_text(json.dumps(api, indent=2) + '\n')


def core_workflow():
    """An additional native-node path; leave the original examples intact."""
    api = {
        "1": {"class_type": "LoadVideo", "inputs": {"file": "videos/nsfw/rcowgirl_6.mp4"}},
        "2": {"class_type": "Video Slice", "inputs": {"video": ["1", 0], "start_time": 0.0, "duration": 0.0, "strict_duration": False}},
        "3": {"class_type": "GetVideoComponents", "inputs": {"video": ["2", 0]}},
        "4": {"class_type": "SAM3DBody_Loader", "inputs": {"model_file": "sam_3d_body_dinov3_bf16.safetensors"}},
        "5": {"class_type": "SAM3DBody_Predict", "inputs": {"sam3d_body_model": ["4", 0], "image": ["3", 0],
            "run_hand_refinement": False, "fov": 0.0, "batch_size": 8}},
        "6": {"class_type": "S3F_CorePoseAdapter", "inputs": {"mhr_pose_data": ["5", 0], "video": ["2", 0], "sam3d_body_model": ["4", 0]}},
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
        make_node(4, api["4"], [500, 490], [360, 100], [], [output("sam3d_body_model", "SAM3D_BODY_MODEL", [4, 9])],
                  [api["4"]["inputs"]["model_file"]], "Load SAM3D Body model · core"),
        make_node(5, api["5"], [1210, 150], [330, 250],
                  [port("sam3d_body_model", "SAM3D_BODY_MODEL", 4), port("image", "IMAGE", 3),
                   port("track_data", "SAM3_TRACK_DATA", None), port("bboxes", "BOUNDING_BOX", None)],
                  [output("mhr_pose_data", "MHR_POSE_DATA", [5])], [False, 0.0, 8], "4 · SAM3D Body prediction · core"),
        make_node(6, api["6"], [1620, 150], [300, 150],
                  [port("mhr_pose_data", "MHR_POSE_DATA", 5), port("video", "VIDEO", 6), port("sam3d_body_model", "SAM3D_BODY_MODEL", 9)],
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
             [6, 2, 0, 6, 1, "VIDEO"], [7, 6, 0, 7, 0, "S3F_POSE_SEQUENCE"], [8, 7, 0, 8, 0, "S3F_MOTION_PROJECT"],
             [9, 4, 0, 6, 2, "SAM3D_BODY_MODEL"]]
    groups = [{"title": title, "bounding": box, "color": color, "font_size": 22, "flags": {}}
              for title, box, color in [
                  ("Core video & SAM3D", [50, 70, 1520, 710], "#365770"),
                  ("Native pose adapter", [1590, 70, 360, 280], "#446958"),
                  ("Motion authoring", [1970, 70, 440, 610], "#446958"),
                  ("Preview & export", [2440, 70, 1160, 1100], "#655079")]]
    workflow = {"last_node_id": 8, "last_link_id": 9, "nodes": nodes, "links": links, "groups": groups,
                "config": {}, "extra": {"ds": {"scale": .45, "offset": [30, 20]}}, "version": .4}
    write_workflow("core_video_to_funscript", workflow, api)


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
    cache_api = {"1": {"class_type": "S3F_LoadPoseCache", "inputs": {"cache_path": "/absolute/path/to/poses.npz"}},
                 "2": API["2"], "3": API["3"]}
    write_workflow("cached_pose_to_funscript", cache_workflow, cache_api)
    detailed = json.loads(json.dumps(cache_workflow))
    detailed["nodes"][1]["inputs"][1]["link"] = 3
    detailed["nodes"][1]["widgets_values"][1] = "left_hand"
    detailed["nodes"].append(make_node(4, {"class_type": "S3F_AnchorOverride"}, [80, 350], [350, 100], [],
        [{"name": "anchor", "type": "S3F_ANCHOR", "links": [3], "slot_index": 0}],
        ["left_index_tip"], "Optional · target landmark override"))
    detailed["links"].append([3, 4, 0, 2, 1, "S3F_ANCHOR"])
    detailed["last_node_id"] = 4; detailed["last_link_id"] = 3
    detailed["groups"][0]["title"] = "Cached poses & detailed anchor"
    detailed["nodes"][2]["widgets_values"] = ["detailed_anchor"]
    detailed_api = {
        "1": {"class_type": "S3F_LoadPoseCache", "inputs": {"cache_path": "/absolute/path/to/poses.npz"}},
        "2": {"class_type": "S3F_BuildMotion", "inputs": {
            **API["2"]["inputs"], "target_anchor": "left_hand", "target_anchor_override": ["4", 0]}},
        "3": {"class_type": "S3F_PreviewExport", "inputs": {"project": ["2", 0], "filename": "detailed_anchor"}},
        "4": {"class_type": "S3F_AnchorOverride", "inputs": {"anchor": "left_index_tip"}},
    }
    write_workflow("detailed_anchor_override", detailed, detailed_api)
    loader = make_node(4, API["4"], [-350, 140], [340, 550], [],
        [{"name": "VIDEO", "type": "VIDEO", "links": [3], "slot_index": 0}],
        [API["4"]["inputs"]["file"]], "Load video · core")
    workflow["nodes"].append(loader)
    workflow["links"].append([3, 4, 0, 1, 0, "VIDEO"])
    workflow["last_node_id"] = 4; workflow["last_link_id"] = 3
    workflow["groups"].insert(0, {"title": "Core video input", "bounding": [-380, 60, 400, 680],
        "color": "#365770", "font_size": 22, "flags": {}})
    workflow["extra"]["ds"] = {"scale": .6, "offset": [400, 20]}
    write_workflow("video_to_funscript", workflow, API)
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
    comparison_api = json.loads(json.dumps(API))
    comparison_api["3"]["inputs"]["project"] = ["5", 0]
    comparison_api["5"] = {"class_type": "S3F_CompareReference", "inputs": {
        "project": ["2", 0], "reference_path": "/absolute/path/to/reference.funscript", "axis": "L0", "reference_offset_ms": 0.0}}
    write_workflow("video_with_reference", comparison, comparison_api)
    core_workflow()
    masked_workflow()
    multitrack_workflow()


def multitrack_workflow():
    """One pose cache feeds independent anchors and one growing preview node."""
    api = {"1": {"class_type": "S3F_LoadPoseCache", "inputs": {"cache_path": "/absolute/path/to/poses.npz"}}}
    nodes = [make_node(1, api["1"], [80, 650], [350, 120], [],
        [{"name": "poses", "type": "S3F_POSE_SEQUENCE", "links": [1, 2, 3]}],
        [api["1"]["inputs"]["cache_path"]], "Shared pose cache · no new inference")]
    links = []
    for slot, anchor in enumerate(("mouth", "left_hand", "right_hand")):
        node_id = slot + 2
        inputs = {**API["2"]["inputs"], "poses": ["1", 0], "target_anchor": anchor,
                  "settings_json": json.dumps({"axis_settings": {"L0": {"component": "auto", "auto_fit": True}}})}
        api[str(node_id)] = {"class_type": "S3F_BuildMotion", "inputs": inputs}
        nodes.append(make_node(node_id, api[str(node_id)], [550, 140 + slot * 530], [400, 440],
            [{"name": "poses", "type": "S3F_POSE_SEQUENCE", "link": slot + 1}],
            [{"name": "project", "type": "S3F_MOTION_PROJECT", "links": [slot + 4]}],
            list(inputs.values())[1:], f"project_{slot} · {anchor.replace('_', ' ')}"))
        links.extend([[slot + 1, 1, 0, node_id, 0, "S3F_POSE_SEQUENCE"],
                      [slot + 4, node_id, 0, 5, slot, "S3F_MOTION_PROJECT"]])
    api["5"] = {"class_type": "S3F_PreviewExport", "inputs": {
        **{f"project_{slot}": [str(slot + 2), 0] for slot in range(3)}, "filename": "multitrack"}}
    nodes.append(make_node(5, api["5"], [1060, 140], [1150, 1080],
        [{"name": f"project_{slot}", "type": "S3F_MOTION_PROJECT", "link": slot + 4 if slot < 3 else None} for slot in range(4)],
        [{"name": "project_path", "type": "STRING", "links": None}], ["multitrack"], "Main timeline + anchor tracks · open full editor"))
    groups = [{"title": title, "bounding": box, "color": color, "font_size": 22, "flags": {}}
        for title, box, color in [("Shared cached poses", [50, 570, 410, 250], "#365770"),
            ("Independent anchors & calibration", [520, 60, 460, 1630], "#446958"),
            ("Assemble main · select sections · blend joins", [1030, 60, 1210, 1230], "#655079")]]
    workflow = {"last_node_id": 5, "last_link_id": 6, "nodes": nodes, "links": links, "groups": groups,
        "config": {}, "extra": {"ds": {"scale": .5, "offset": [30, 20]}}, "version": .4}
    write_workflow("multitrack_anchors", workflow, api)


def masked_workflow():
    """Two independent person scripts sharing one lazy source VIDEO."""
    api = {
        "1": {"class_type": "LoadVideo", "inputs": {"file": "videos/nsfw/rcowgirl_6.mp4"}},
        "2": {"class_type": "LoadVideo", "inputs": {"file": "person_0_mask.mp4"}},
        "3": {"class_type": "LoadVideo", "inputs": {"file": "person_1_mask.mp4"}},
    }
    nodes, links = [], []
    for node_id, y, title, outgoing in [(1, 140, "Source video · shared", [1, 2]),
            (2, 800, "Person A mask · white on black", [3]), (3, 1460, "Person B mask · white on black", [4])]:
        nodes.append(make_node(node_id, api[str(node_id)], [80, y], [340, 550], [],
            [{"name": "VIDEO", "type": "VIDEO", "links": outgoing}], [api[str(node_id)]["inputs"]["file"]], title))
    for branch, y, name in [(0, 480, "person_A"), (1, 1300, "person_B")]:
        extract_id, motion_id, export_id = 4 + branch, 6 + branch, 8 + branch
        api[str(extract_id)] = {"class_type": "S3F_VideoPose", "inputs": {
            **API["1"]["inputs"], "video": ["1", 0], "mask_video": [str(2 + branch), 0]}}
        api[str(motion_id)] = {"class_type": "S3F_BuildMotion", "inputs": {
            **API["2"]["inputs"], "poses": [str(extract_id), 0]}}
        api[str(export_id)] = {"class_type": "S3F_PreviewExport", "inputs": {"project": [str(motion_id), 0], "filename": name}}
        nodes.append(make_node(extract_id, api[str(extract_id)], [520, y], [380, 480],
            [{"name": "video", "type": "VIDEO", "link": 1 + branch}, {"name": "mask_video", "type": "VIDEO", "link": 3 + branch}],
            [{"name": "poses", "type": "S3F_POSE_SEQUENCE", "links": [5 + branch]}, {"name": "cache_path", "type": "STRING", "links": None}],
            list(API["1"]["inputs"].values())[1:], f"{name} · stream masked poses"))
        nodes.append(make_node(motion_id, api[str(motion_id)], [980, y], [380, 440],
            [{"name": "poses", "type": "S3F_POSE_SEQUENCE", "link": 5 + branch}],
            [{"name": "S3F_MOTION_PROJECT", "type": "S3F_MOTION_PROJECT", "links": [7 + branch]}],
            list(API["2"]["inputs"].values())[1:], f"{name} · anchors & axes"))
        nodes.append(make_node(export_id, api[str(export_id)], [1450, y], [820, 720],
            [{"name": "project", "type": "S3F_MOTION_PROJECT", "link": 7 + branch}],
            [{"name": "project_path", "type": "STRING", "links": None}], [name], f"{name} · preview & export"))
        links.extend([[1 + branch, 1, 0, extract_id, 0, "VIDEO"], [3 + branch, 2 + branch, 0, extract_id, 1, "VIDEO"],
            [5 + branch, extract_id, 0, motion_id, 0, "S3F_POSE_SEQUENCE"],
            [7 + branch, motion_id, 0, export_id, 0, "S3F_MOTION_PROJECT"]])
    groups = [{"title": title, "bounding": box, "color": color, "font_size": 22, "flags": {}}
        for title, box, color in [("Core video inputs · matching timelines", [50, 60, 400, 2010], "#365770"),
            ("Person A · mask supplies identity · target_person = 0", [490, 400, 1810, 810], "#446958"),
            ("Person B · separate mask and script · target_person = 0", [490, 1220, 1810, 840], "#655079")]]
    workflow = {"last_node_id": 9, "last_link_id": 8, "nodes": nodes, "links": links, "groups": groups,
        "config": {}, "extra": {"ds": {"scale": .4, "offset": [30, 20]}}, "version": .4}
    write_workflow("mask_videos_to_funscripts", workflow, api)


if __name__ == "__main__":
    main()
