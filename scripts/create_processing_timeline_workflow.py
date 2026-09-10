"""Generate the canvas-editable processing timeline example and its API companion.

Run from any directory with Python. The example contains no private source media or
reference selections; choose a VIDEO before queueing its initial prepare operation.
"""

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
        "3": {"class_type": "S3F_StandaloneExport", "inputs": {
            "project_0": ["2", 0], "filename": "processing_timeline"}},
        "4": {"class_type": "S3F_PreviewExport", "inputs": {
            "editor_session": ["3", 2], "filename": "processing_timeline"}},
    }
    notes = (
        "PROCESSING TIMELINE\n\n"
        "1. Choose a video in the core Load Video node. Leave operation on prepare and run once. "
        "The timeline opens without extracting the whole video.\n\n"
        "2. Click Open processing timeline. Detect cuts to add scene guides, then define tracking regions and choose anchors. "
        "Use a separate stabilization region only where a reference needs to be held still.\n\n"
        "3. Apply the plan and process the required regions from the timeline. "
        "Review results and lock approved regions. Save the workflow to retain the plan.\n\n"
        "4. Run the workflow to send the latest completed result to Motion Studio. Leave operation "
        "on prepare to reuse it, or choose all, selected or unfinished to process during that run.\n\n"
        "The compact standalone node owns the Motion Studio editing session. Its editor_session "
        "connection makes the embedded preview share the same edits.\n\n"
        "sample_fps = 0 follows source frames. Larger batch_size changes extraction batching; "
        "it does not change region timing.\n\n"
        "First version: SAM3D anchor tracking and optional CoTracker3 reference stabilization. "
        "Use an original person mask only when stabilization is disabled. "
        "See docs/processing-timeline.md for cache, lock and gap behavior."
    )
    nodes = [
        make_node(1, "LoadVideo", "1 · Source video · core", [96, 144], [384, 752], [],
                  [output_port("VIDEO", "VIDEO", 0, [1])], [""], 0),
        make_node(2, "S3F_ProcessingTimeline", "2 · Plan and process video regions", [576, 144], [448, 496],
                  [input_port("video", "VIDEO", 1), input_port("mask_video", "VIDEO", optional=True)],
                  [output_port("project", "S3F_MOTION_PROJECT", 0, [2]),
                   output_port("timeline_path", "STRING", 1)], list(settings.values()), 2),
        make_node(3, "S3F_StandaloneExport", "3 · Motion Studio · open in new tab", [1120, 144], [384, 256],
                  [input_port("editor_session", "S3F_EDITOR_SESSION", optional=True),
                   input_port("project_0", "S3F_MOTION_PROJECT", 2, True),
                   input_port("project_1", "S3F_MOTION_PROJECT", optional=True)],
                  [output_port("project_path", "STRING", 0), output_port("viewer_path", "STRING", 1),
                   output_port("editor_session", "S3F_EDITOR_SESSION", 2, [3])], ["processing_timeline"], 3),
        make_node(4, "S3F_PreviewExport", "Linked preview · same editing session", [1600, 144], [1120, 1056],
                  [input_port("editor_session", "S3F_EDITOR_SESSION", 3, True),
                   input_port("project_0", "S3F_MOTION_PROJECT", optional=True)],
                  [output_port("project_path", "STRING", 0), output_port("editor_session", "S3F_EDITOR_SESSION", 1)],
                  ["processing_timeline"], 4),
        make_node(5, "Note", "Read first · regional processing", [576, 752], [448, 608], [], [], [notes], 1),
    ]
    nodes[-1].update(color="#432", bgcolor="#653")
    groups = [
        {"id": number, "title": title, "bounding": bounds, "color": color, "font_size": 22, "flags": {}}
        for number, title, bounds, color in [
            (1, "Core video input", [64, 64, 448, 912], "#365770"),
            (2, "Tracking and stabilization regions", [544, 64, 512, 1336], "#446958"),
            (3, "Motion Studio · standalone session", [1088, 64, 448, 416], "#655079"),
            (4, "Motion Studio · linked preview", [1568, 64, 1184, 1184], "#655079"),
        ]
    ]
    workflow = {
        "last_node_id": 5, "last_link_id": 3, "nodes": nodes,
        "links": [[1, 1, 0, 2, 0, "VIDEO"], [2, 2, 0, 3, 1, "S3F_MOTION_PROJECT"],
                  [3, 3, 2, 4, 0, "S3F_EDITOR_SESSION"]],
        "groups": groups, "config": {}, "extra": {"ds": {"scale": 0.5, "offset": [40, 20]}}, "version": 0.4,
    }
    return workflow, api


def main():
    workflow, api = build_workflow()
    destination = ROOT / "workflows"
    destination.mkdir(parents=True, exist_ok=True)
    for suffix, value in ((".json", workflow), (".api.json", api)):
        (destination / ("processing_timeline" + suffix)).write_text(json.dumps(value, indent=2) + "\n")


if __name__ == "__main__":
    main()
