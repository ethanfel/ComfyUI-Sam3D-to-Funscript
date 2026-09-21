"""Generate the single-video starter and its API companion, with no private media."""

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def input_port(name, kind, link=None, optional=False):
    port = {"name": name, "type": kind, "link": link}
    if optional:
        port["shape"] = 7
    return port


def output_port(name, kind, slot, links=None):
    return {"name": name, "type": kind, "slot_index": slot, "links": links}


def make_node(node_id, kind, title, pos, size, inputs, outputs, widgets, order):
    properties = {"Node name for S&R": kind}
    if kind == "LoadVideo":
        properties["cnr_id"] = "comfy-core"
    elif kind.startswith("S3F_"):
        properties["aux_id"] = "ethanfel/ComfyUI-Sam3D-to-Funscript"
    return {"id": node_id, "type": kind, "title": title, "pos": pos, "size": size,
            "flags": {}, "order": order, "mode": 0, "inputs": inputs,
            "outputs": outputs, "properties": properties, "widgets_values": widgets}


def build_workflow():
    settings = {
        "model_file": "sam_3d_body_dinov3_bf16.safetensors",
        "sample_fps": 0.0,
        "batch_size": 8,
        "tracker_model": "cotracker3_scaled_online.pth",
        "operation": "prepare",
        "plan_json": "{}",
        "use_cache": True,
        "cut_sensitivity": "normal",
    }
    api = {
        "1": {"class_type": "LoadVideo", "inputs": {"file": ""}},
        "2": {"class_type": "S3F_ProcessingTimeline", "inputs": {"video": ["1", 0], **settings}},
    }
    notes = (
        "SINGLE VIDEO\n\n"
        "1. Choose or upload your video. Leave operation on prepare and click Run.\n\n"
        "2. Open processing timeline. Use Automatic mode, or add tracking and stabilization sections yourself.\n\n"
        "3. Open Motion Studio from the timeline to review, combine and edit results. For audio patterns or manual authoring, you can go straight to Motion Studio without tracking.\n\n"
        "4. Download project + scripts from Motion Studio. Save this workflow to return to its editing session.\n\n"
        "sample_fps = 0 uses every frame. Start with batch_size = 8.\n\n"
        "Guide: docs/processing-timeline.md"
    )
    nodes = [
        make_node(1, "LoadVideo", "1 · Choose video", [80, 100], [384, 600], [],
                  [output_port("VIDEO", "VIDEO", 0, [1])], [""], 0),
        make_node(2, "S3F_ProcessingTimeline", "2 · Timeline + Motion Studio", [560, 100], [480, 480],
                  [input_port("video", "VIDEO", 1), input_port("mask_video", "VIDEO", optional=True)],
                  [output_port("project", "S3F_MOTION_PROJECT", 0),
                   output_port("timeline_path", "STRING", 1)], list(settings.values()), 1),
        make_node(3, "Note", "Start here · single video", [1136, 100], [400, 450], [], [], [notes], 2),
    ]
    nodes[-1].update(color="#24343d", bgcolor="#30444f")
    workflow = {
        "last_node_id": 3, "last_link_id": 1, "nodes": nodes,
        "links": [[1, 1, 0, 2, 0, "VIDEO"]],
        "groups": [], "config": {}, "extra": {"ds": {"scale": 0.8, "offset": [30, 30]}}, "version": 0.4,
    }
    return workflow, api


def main():
    workflow, api = build_workflow()
    for name, value in (("workflows/01_single_video.json", workflow),
                        ("extras/api/01_single_video.api.json", api)):
        path = ROOT / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value, indent=2) + "\n")


if __name__ == "__main__":
    main()
