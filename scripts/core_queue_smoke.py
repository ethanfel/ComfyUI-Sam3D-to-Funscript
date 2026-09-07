"""Execute the core-node workflow and verify full-video and trimmed timelines."""

import argparse
import copy
import json
from pathlib import Path
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default="http://127.0.0.1:8198")
    args = parser.parse_args()

    def get(path):
        with urllib.request.urlopen(args.base + path, timeout=15) as response:
            return json.load(response)

    def queue(prompt, name):
        request = urllib.request.Request(args.base + "/prompt",
            data=json.dumps({"prompt": prompt, "client_id": "s3f-core-validation"}).encode(),
            headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=15) as response:
            result = json.load(response)
        print(f"Queued {name}: {result['prompt_id']}", flush=True)
        started = time.monotonic()
        while time.monotonic() - started < 360:
            history = get("/history/" + result["prompt_id"])
            if history:
                item = history[result["prompt_id"]]
                assert item["status"]["status_str"] == "success", item["status"]
                project_path = Path(item["outputs"]["8"]["text"][0])
                print(f"Completed {name} in {time.monotonic()-started:.2f}s: {project_path}", flush=True)
                return json.loads(project_path.read_text()), project_path, item
            time.sleep(.5)
        raise TimeoutError(f"{name} exceeded six minutes")

    api = json.loads((ROOT / "workflows/core_video_to_funscript.api.json").read_text())
    # Match the existing browser smoke test's exported script filename.
    api["8"]["inputs"]["filename"] = "rcowgirl_6"
    full, full_path, full_history = queue(api, "full core video")
    assert len(full["times_ms"]) == 539
    assert full["metadata"]["adapter"] == "core-mhr/1"
    assert full["times_ms"][0] == 0 and full["times_ms"][-1] == 16812.5
    assert full["metadata"]["duration_ms"] == 16843.75
    assert len(full["scripts"]) == 6
    trimmed_api = copy.deepcopy(api)
    trimmed_api["2"]["inputs"].update(start_time=4.0, duration=1.0)
    trimmed_api["8"]["inputs"]["filename"] = "rcowgirl_6_core_trimmed"
    trimmed, trimmed_path, trimmed_history = queue(trimmed_api, "trimmed core video")
    assert len(trimmed["times_ms"]) == 32
    assert trimmed["times_ms"][0] == 4000 and trimmed["times_ms"][-1] == 4968.75
    assert trimmed["metadata"]["duration_ms"] == 5000
    assert trimmed["scripts"]["L0"]["actions"][-1]["at"] == 5000
    report = {"full_project": str(full_path), "trimmed_project": str(trimmed_path),
        "full_frames": 539, "trimmed_frames": 32, "original_timeline_preserved": True,
        "full_history": full_history, "trimmed_history": trimmed_history}
    destination = ROOT / "development/core-queue-validation.json"
    destination.write_text(json.dumps(report, indent=2))
    print(json.dumps({k: v for k, v in report.items() if not k.endswith("history")}, indent=2), flush=True)


if __name__ == "__main__":
    main()
