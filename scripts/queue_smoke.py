"""Check disk-cache interoperability and reopen an edited browser project in ComfyUI."""

import json
import os
from pathlib import Path
import time
import urllib.request
import zipfile

BASE = os.environ.get("S3F_TEST_BASE", "http://127.0.0.1:8197")
ROOT = Path(__file__).resolve().parents[1]


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=10) as response:
        return json.load(response)


def queue(prompt):
    request = urllib.request.Request(BASE + "/prompt", data=json.dumps({"prompt": prompt, "client_id": "s3f-final-validation"}).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=10) as response:
        result = json.load(response)
    started = time.monotonic()
    while time.monotonic() - started < 360:
        history = get("/history/" + result["prompt_id"])
        if history:
            item = history[result["prompt_id"]]
            assert item["status"]["status_str"] == "success", item["status"]
            return item
        time.sleep(.2)
    raise TimeoutError("Test workflow exceeded six minutes")


def main():
    api = json.loads((ROOT / "workflows/video_to_funscript.api.json").read_text())
    api["4"]["inputs"]["file"] = "videos/nsfw/cowgirl_7.mp4"
    api["1"]["inputs"].update(duration_seconds=4.0, sample_fps=16.0)
    api["3"]["inputs"]["filename"] = "cowgirl_7_cache_check"
    cached = queue(api)
    cache_project_path = cached["outputs"]["3"]["text"][0]
    project = json.loads(Path(cache_project_path).read_text())
    assert project["metadata"]["cache_hit"], "CLI cache did not transfer to node execution"
    browser = ROOT / "development/browser"
    archive = max(browser.glob("*.zip"), key=lambda p: p.stat().st_mtime_ns)
    with zipfile.ZipFile(archive) as zipped:
        assert zipped.testzip() is None
        edited = json.loads(zipped.read("project.json"))
    edited_path = browser / "edited_project.json"
    edited_path.write_text(json.dumps(edited))
    reopened = queue({
        "1": {"class_type": "S3F_LoadProject", "inputs": {"project_path": str(edited_path)}},
        "2": {"class_type": "S3F_PreviewExport", "inputs": {"project": ["1", 0], "filename": "rcowgirl_6_edited"}},
    })
    result_path = Path(reopened["outputs"]["2"]["text"][0])
    assert json.loads(result_path.read_text())["scripts"] == edited["scripts"]
    same_reference = queue({
        "1": {"class_type": "S3F_LoadProject", "inputs": {"project_path": cache_project_path}},
        "2": {"class_type": "S3F_CompareReference", "inputs": {"project": ["1", 0],
              "reference_path": str(Path(cache_project_path).parent / "cowgirl_7_cache_check.funscript"), "axis": "L0", "reference_offset_ms": 0}},
        "3": {"class_type": "S3F_PreviewExport", "inputs": {"project": ["2", 0], "filename": "reference_queue_check"}},
    })
    compared_path = Path(same_reference["outputs"]["3"]["text"][0])
    compared = json.loads(compared_path.read_text())
    assert compared["reference_comparison"]["L0"]["rmse"] == 0
    assert compared_path.with_name("source.json").is_file()
    report = {"cache_hit_across_cli_and_comfyui": True, "browser_edits_reimported_exactly": True,
              "reference_comparison_node_passed": True,
              "cache_workflow": cached, "edited_project_workflow": reopened, "reference_workflow": same_reference}
    (ROOT / "development/final-queue-validation.json").write_text(json.dumps(report, indent=2))
    print(json.dumps({k: v for k, v in report.items() if not k.endswith("workflow")}, indent=2))


if __name__ == "__main__":
    main()
