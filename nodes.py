"""ComfyUI nodes. Native SAM3D owns inference and model memory management."""

import json
from pathlib import Path

import folder_paths

from .sam3d_funscript.core import ANCHORS, PoseSequence, build_project, export_project, load_project
from .sam3d_funscript.video import extract_video, fingerprint
from .sam3d_funscript.calibration import load_reference, compare_project

CATEGORY = "motion/SAM3D Funscript"


def resolve_input(value):
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = Path(folder_paths.get_input_directory()) / path
    return path.resolve(strict=True)


class S3F_VideoPose:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "video_path": ("STRING", {"default": "videos/nsfw/rcowgirl_6.mp4"}),
            "model_file": (folder_paths.get_filename_list("detection"),),
            "sample_fps": ("FLOAT", {"default": 16, "min": 0, "max": 120, "step": 1, "tooltip": "0 keeps every frame. Original PTS are preserved."}),
            "start_seconds": ("FLOAT", {"default": 0, "min": 0, "max": 86400}),
            "duration_seconds": ("FLOAT", {"default": 0, "min": 0, "max": 86400, "tooltip": "0 means until EOF or sample limit."}),
            "max_frames": ("INT", {"default": 2000, "min": 2, "max": 100000}),
            "rois_json": ("STRING", {"default": "[[0,0,1,1]]", "multiline": True, "tooltip": "Ordered static person crops: normalized [x,y,width,height]. Not automatic tracking."}),
            "batch_size": ("INT", {"default": 8, "min": 1, "max": 128}),
            "fov": ("FLOAT", {"default": 0, "min": 0, "max": 179}),
            "use_cache": ("BOOLEAN", {"default": True}),
        }}

    RETURN_TYPES = ("S3F_POSE_SEQUENCE", "STRING")
    RETURN_NAMES = ("poses", "cache_path")
    FUNCTION = "run"
    CATEGORY = CATEGORY

    @classmethod
    def IS_CHANGED(cls, video_path, model_file, use_cache=True, **kwargs):
        if not use_cache:
            return float("nan")
        return json.dumps([fingerprint(resolve_input(video_path)), fingerprint(folder_paths.get_full_path_or_raise("detection", model_file))], sort_keys=True)

    def run(self, video_path, **kwargs):
        cache = Path(folder_paths.get_output_directory()) / "sam3d_funscript" / "cache"
        sequence = extract_video(resolve_input(video_path), cache_dir=cache, **kwargs)
        return sequence, sequence.metadata["cache_path"]


class S3F_LoadPoseCache:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"cache_path": ("STRING", {"default": ""})}}

    RETURN_TYPES = ("S3F_POSE_SEQUENCE",)
    FUNCTION = "run"
    CATEGORY = CATEGORY

    @classmethod
    def IS_CHANGED(cls, cache_path):
        return json.dumps(fingerprint(resolve_input(cache_path)), sort_keys=True)

    def run(self, cache_path):
        return (PoseSequence.load(resolve_input(cache_path)),)


class S3F_BuildMotion:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "poses": ("S3F_POSE_SEQUENCE",),
            "target_person": ("INT", {"default": 0, "min": 0, "max": 7}),
            "target_anchor": (list(ANCHORS),),
            "reference_person": ("INT", {"default": -1, "min": -1, "max": 7, "tooltip": "-1 uses camera coordinates."}),
            "reference_anchor": (list(ANCHORS),),
            "frame": (["camera", "reference_body"],),
            "smoothing_ms": ("FLOAT", {"default": 80, "min": 0, "max": 2000}),
            "enabled_axes": ("STRING", {"default": "L0,L1,L2,R0,R1,R2"}),
            "settings_json": ("STRING", {"default": "{}", "multiline": True,
                "tooltip": "Optional max_gap_ms, neutral_window_ms, tolerance and axis_settings. Translation ranges in metres; rotations in degrees."}),
        }}

    RETURN_TYPES = ("S3F_MOTION_PROJECT",)
    FUNCTION = "run"
    CATEGORY = CATEGORY

    def run(self, poses, enabled_axes, settings_json, **kwargs):
        extras = json.loads(settings_json)
        if not isinstance(extras, dict) or set(extras) & (set(kwargs) | {"enabled_axes"}):
            raise ValueError("settings_json must be an object and cannot override visible node controls")
        config = {**extras, **kwargs, "enabled_axes": [a.strip() for a in enabled_axes.split(",") if a.strip()]}
        return (build_project(poses, config),)


class S3F_LoadProject:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"project_path": ("STRING", {"default": ""})}}

    RETURN_TYPES = ("S3F_MOTION_PROJECT",)
    FUNCTION = "run"
    CATEGORY = CATEGORY

    @classmethod
    def IS_CHANGED(cls, project_path):
        return json.dumps(fingerprint(resolve_input(project_path)), sort_keys=True)

    def run(self, project_path):
        return (load_project(resolve_input(project_path)),)


class S3F_PreviewExport:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"project": ("S3F_MOTION_PROJECT",), "filename": ("STRING", {"default": "motion"})}}

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("project_path",)
    FUNCTION = "run"
    CATEGORY = CATEGORY
    OUTPUT_NODE = True

    def run(self, project, filename):
        root = Path(folder_paths.get_output_directory()) / "sam3d_funscript"
        path = export_project(project, root, filename)
        return {"ui": {"s3f_project": [path.parent.name], "text": [str(path)]}, "result": (str(path),)}


class S3F_CompareReference:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "project": ("S3F_MOTION_PROJECT",),
            "reference_path": ("STRING", {"default": "", "tooltip": "Paired authored .funscript. Compared positions are read as written."}),
            "axis": (["L0", "L1", "L2", "R0", "R1", "R2"],),
            "reference_offset_ms": ("FLOAT", {"default": 0, "min": -3600000, "max": 3600000,
                "tooltip": "Positive shifts reference actions later on the video timeline. Does not shift generated output."}),
        }}

    RETURN_TYPES = ("S3F_MOTION_PROJECT", "STRING")
    RETURN_NAMES = ("project_with_reference", "comparison_json")
    FUNCTION = "run"
    CATEGORY = CATEGORY

    @classmethod
    def IS_CHANGED(cls, reference_path, **kwargs):
        return json.dumps(fingerprint(resolve_input(reference_path)), sort_keys=True)

    def run(self, project, reference_path, axis="L0", reference_offset_ms=0):
        reference = load_reference(resolve_input(reference_path))
        output, report = compare_project(project, reference, axis, reference_offset_ms)
        return output, json.dumps(report, indent=2)


NODE_CLASS_MAPPINGS = {cls.__name__: cls for cls in (S3F_VideoPose, S3F_LoadPoseCache, S3F_BuildMotion, S3F_LoadProject, S3F_PreviewExport, S3F_CompareReference)}
NODE_DISPLAY_NAME_MAPPINGS = {
    "S3F_VideoPose": "SAM3D Video → Cached Poses", "S3F_LoadPoseCache": "Load SAM3D Pose Cache",
    "S3F_BuildMotion": "Poses → Multi-axis Motion", "S3F_LoadProject": "Load Funscript Project",
    "S3F_PreviewExport": "Preview & Export Funscripts",
    "S3F_CompareReference": "Compare Reference Funscript",
}
