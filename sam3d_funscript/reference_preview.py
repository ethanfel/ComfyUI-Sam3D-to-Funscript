"""Portable 2D mapping between a reference render and its original source."""
import json
import re
from pathlib import Path


def reference_preview(source):
    path = Path(source.get("path", ""))
    if path.name != "stabilized.mp4" or not re.fullmatch(r"[0-9a-f]{24}", path.parent.name):
        return None
    manifest = path.with_name("reference.json")
    if not manifest.is_file():
        return None
    data = json.loads(manifest.read_text())
    if data.get("state") != "ready" or data.get("id") != path.parent.name:
        return None
    info, motion, video = data["info"], data["data"], data["video"]
    return {"version": 1, "reference": data["id"], "source": info["source"],
            "image_size": [info["height"], info["width"]], "padding_xy": video["padding_xy"],
            "times_ms": motion["times_ms"], "shift_xy": motion["shift_xy"],
            "source_offset_ms": video["source_offset_ms"],
            **({'transform_xy': motion['transform_xy']} if 'transform_xy' in motion else {})}
