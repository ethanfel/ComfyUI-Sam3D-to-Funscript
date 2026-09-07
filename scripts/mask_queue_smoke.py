"""Test native mask conditioning with two source panels and explicit missing masks."""

import json
from pathlib import Path
import sys
import urllib.request
import uuid

import av
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from sam3d_funscript.video import video_frames
from queue_smoke import BASE, ROOT, get, queue


def upload(path):
    boundary = uuid.uuid4().hex
    body = (f'--{boundary}\r\nContent-Disposition: form-data; name="subfolder"\r\n\r\ns3f_mask_test\r\n'
            f'--{boundary}\r\nContent-Disposition: form-data; name="image"; filename="{path.name}"\r\n'
            'Content-Type: video/mp4\r\n\r\n').encode() + path.read_bytes() + f'\r\n--{boundary}--\r\n'.encode()
    request = urllib.request.Request(BASE + "/upload/image", data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(request, timeout=30) as response:
        result = json.load(response)
    return result["subfolder"] + "/" + result["name"]


def fixture(source, destination):
    destination.mkdir(parents=True, exist_ok=True)
    writers = [av.open(str(destination / name), "w") for name in ("source.mp4", "person_A.mp4", "person_B.mp4")]
    streams = []
    for index, writer in enumerate(writers):
        stream = writer.add_stream("libx264", rate=16)
        stream.width, stream.height = (768, 512) if index == 0 else (384, 256)
        stream.pix_fmt = "yuv420p"
        stream.options = {"crf": "0", "preset": "fast"}
        streams.append(stream)
    later = video_frames(source, sample_fps=16, start_seconds=.5, duration_seconds=4, max_frames=64)
    try:
        for index, (rgb, _) in enumerate(video_frames(source, sample_fps=16, duration_seconds=4, max_frames=64)):
            other, _ = next(later)
            left = av.VideoFrame.from_ndarray(rgb, format="rgb24").reformat(width=384, height=512).to_ndarray(format="rgb24")
            right = av.VideoFrame.from_ndarray(other, format="rgb24").reformat(width=384, height=512).to_ndarray(format="rgb24")
            source_frame = np.concatenate((left, right), axis=1)
            masks = [np.zeros((256, 384, 3), np.uint8) for _ in range(2)]
            if not 12 <= index < 16:
                masks[0][:, :192] = 255
            if not 32 <= index < 36:
                masks[1][:, 192:] = 255
            for writer, stream, array in zip(writers, streams, [source_frame, *masks]):
                frame = av.VideoFrame.from_ndarray(array, format="rgb24")
                for packet in stream.encode(frame):
                    writer.mux(packet)
        for writer, stream in zip(writers, streams):
            for packet in stream.encode():
                writer.mux(packet)
    finally:
        later.close()
        for writer in writers:
            writer.close()


def main():
    folder = ROOT / "development/mask-fixture"
    fixture(Path("/media/p5/Comfyui/input/videos/nsfw/rcowgirl_6.mp4"), folder)
    info = get("/object_info/S3F_VideoPose")["S3F_VideoPose"]
    assert info["input"]["optional"]["mask_video"][0] == "VIDEO"
    api = json.loads((ROOT / "workflows/mask_videos_to_funscripts.api.json").read_text())
    for node_id, file in [("1", "source.mp4"), ("2", "person_A.mp4"), ("3", "person_B.mp4")]:
        api[node_id]["inputs"]["file"] = upload(folder / file)
    for node_id in ("4", "5"):
        api[node_id]["inputs"].update(batch_size=4, use_cache=False)
    result = queue(api)
    projects = []
    for branch, node_id in enumerate(("8", "9")):
        path = Path(result["outputs"][node_id]["text"][0])
        project = json.loads(path.read_text())
        missing = list(range(12, 16)) if branch == 0 else list(range(32, 36))
        assert len(project["times_ms"]) == 64 and project["times_ms"][-1] == 3937.5
        assert project["metadata"]["missing_mask_samples"] == 4
        assert np.flatnonzero(~np.array(project["valid"])).tolist() == missing
        pixels = np.array(project["pixels"], dtype=float)[:, 0]
        mean_x = float(np.nanmean(pixels[:, [9, 10], 0]))
        assert (mean_x < 384) if branch == 0 else (mean_x > 384), mean_x
        projects.append({"path": str(path), "mean_pelvis_x": mean_x,
            "missing_samples": missing, "cache_path": project["metadata"]["cache_path"]})
    assert projects[0]["cache_path"] != projects[1]["cache_path"]
    for node_id in ("4", "5"):
        api[node_id]["inputs"]["use_cache"] = True
    previous_keys = [json.loads(Path(p["path"]).read_text())["metadata"]["settings"] for p in projects]
    for attempt in range(3):
        cached = queue(api)
        cache_hits = []
        for branch, node_id in enumerate(("8", "9")):
            metadata = json.loads(Path(cached["outputs"][node_id]["text"][0]).read_text())["metadata"]
            cache_hits.append(metadata["cache_hit"])
            if not metadata["cache_hit"]:
                # Network input mounts can settle file mtimes after an upload.
                # A changed fingerprint must miss; an unchanged one must hit.
                assert metadata["settings"] != previous_keys[branch]
                previous_keys[branch] = metadata["settings"]
        if all(cache_hits):
            break
    assert all(cache_hits)
    workflow = json.loads((ROOT / "workflows/mask_videos_to_funscripts.json").read_text())
    for node in workflow["nodes"]:
        if node["type"] == "LoadVideo":
            node["widgets_values"] = [api[str(node["id"])]["inputs"]["file"]]
        if node["type"] == "S3F_StandaloneExport":
            node["properties"]["s3f_project"] = Path(projects[node["id"] - 8]["path"]).parent.name
    (ROOT / "development/mask-fixture/workflow.json").write_text(json.dumps(workflow, indent=2))
    report = {"projects": projects, "separate_person_selection": True, "missing_masks_preserved": True,
        "independent_caches_reused": True, "history": result}
    (ROOT / "development/mask-queue-validation.json").write_text(json.dumps(report, indent=2))
    print(json.dumps({k: v for k, v in report.items() if k != "history"}, indent=2), flush=True)


if __name__ == "__main__":
    main()
