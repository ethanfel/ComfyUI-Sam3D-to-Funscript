"""Exercise growing project inputs against ComfyUI using an existing pose cache."""

import json
from pathlib import Path
import sys

from queue_smoke import queue, ROOT

cache = sys.argv[1]
api = json.loads((ROOT / "workflows/multitrack_anchors.api.json").read_text())
api["1"]["inputs"]["cache_path"] = cache
result = queue(api)
path = Path(result["outputs"]["5"]["text"][0])
project = json.loads(path.read_text())
assert len(project["timeline"]["sources"]) == 3
assert len(project["timeline"]["tracks"]) == 3
assert not project["timeline"]["geometries"]
assert [s["data"]["config"]["target_anchor"] for s in project["timeline"]["sources"]] == ["mouth", "left_hand", "right_hand"]
assert project["scripts"] == project["timeline"]["sources"][0]["data"]["scripts"]
workflow = json.loads((ROOT / "workflows/multitrack_anchors.json").read_text())
workflow["nodes"][0]["widgets_values"] = [cache]
workflow["nodes"][-1]["properties"]["s3f_project"] = path.parent.name
(ROOT / "development/timeline-workflow.json").write_text(json.dumps(workflow, indent=2))
# Legacy API remains valid, and sparse numeric sockets sort numerically.
legacy = queue({"1": api["1"], "2": api["2"], "5": {"class_type": "S3F_PreviewExport", "inputs": {"project": ["2", 0], "filename": "timeline_legacy"}}})
legacy_path = Path(legacy["outputs"]["5"]["text"][0])
assert json.loads(legacy_path.read_text())["scripts"] == project["scripts"]
sparse = {**api, "5": {"class_type": "S3F_PreviewExport", "inputs": {"project_1000": ["4", 0], "project_2": ["3", 0], "filename": "timeline_sparse"}}}
result = queue(sparse)
sparse_path = Path(result["outputs"]["5"]["text"][0])
assert [s["id"] for s in json.loads(sparse_path.read_text())["timeline"]["sources"]] == ["project_2", "project_1000"]
report = {"project": str(path), "legacy": str(legacy_path), "sparse": str(sparse_path),
          "sources": 3, "geometry_copies": 1, "workflow": str(ROOT / "development/timeline-workflow.json")}
(ROOT / "development/timeline-queue-validation.json").write_text(json.dumps(report, indent=2))
print(json.dumps(report, indent=2))
