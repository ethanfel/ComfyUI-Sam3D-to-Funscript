"""ComfyUI nodes. Native SAM3D owns inference and model memory management."""

import json
import uuid
from pathlib import Path

import folder_paths

from .sam3d_funscript.core import ANCHORS, PoseSequence, build_project, export_project, load_project
from .sam3d_funscript.video import extract_video, fingerprint, video_input_range
from .sam3d_funscript.calibration import load_reference, compare_project
from .sam3d_funscript.native import adapt_native_poses
from .sam3d_funscript.anchors import GENERAL_ANCHORS, MHR70_NAMES
from .sam3d_funscript.timeline import ProjectInputs, combine_projects

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
            "video": ("VIDEO", {"tooltip": "Connect core Load Video or Trim Video. Decodes sampled frames in small batches without Get Video Components."}),
            "model_file": (folder_paths.get_filename_list("detection"),),
            "sample_fps": ("FLOAT", {"default": 16, "min": 0, "max": 120, "step": 1, "tooltip": "0 keeps every frame. Original PTS are preserved."}),
            "start_seconds": ("FLOAT", {"default": 0, "min": 0, "max": 86400, "tooltip": "Additional offset inside the connected VIDEO's trim."}),
            "duration_seconds": ("FLOAT", {"default": 0, "min": 0, "max": 86400, "tooltip": "0 uses the remaining input video, bounded by its trim and the sample limit."}),
            "max_frames": ("INT", {"default": 2000, "min": 2, "max": 100000}),
            "rois_json": ("STRING", {"default": "[[0,0,1,1]]", "multiline": True, "tooltip": "Ordered static person crops: normalized [x,y,width,height]. Ignored when mask_video is connected."}),
            "batch_size": ("INT", {"default": 8, "min": 1, "max": 128, "tooltip": "Maximum person crops per model forward. Larger batches use more VRAM and buffered RGB RAM; CPU crop buffers stay bounded separately. Try 16–32 first; very large batches may not be faster. Cache hits skip inference."}),
            "fov": ("FLOAT", {"default": 0, "min": 0, "max": 179}),
            "use_cache": ("BOOLEAN", {"default": True}),
        }, "optional": {
            "mask_video": ("VIDEO", {"tooltip": "One person's white-on-black mask video from core Load Video. Must match the source timeline and canvas; smaller resolution is supported. Black frames mark missing poses. Overrides ROIs and outputs person slot 0."}),
        }}

    RETURN_TYPES = ("S3F_POSE_SEQUENCE", "STRING")
    RETURN_NAMES = ("poses", "cache_path")
    FUNCTION = "run"
    CATEGORY = CATEGORY

    @classmethod
    def IS_CHANGED(cls, video, model_file, use_cache=True, mask_video=None, **kwargs):
        # ComfyUI can fingerprint a node before its upstream VIDEO is available.
        if not use_cache or video is None:
            return float("nan")
        path, start, duration = video_input_range(video)
        signature = [fingerprint(path), float(start), float(duration), fingerprint(folder_paths.get_full_path_or_raise("detection", model_file))]
        if mask_video is not None:
            mask_path, mask_start, mask_duration = video_input_range(mask_video)
            signature.append([fingerprint(mask_path), float(mask_start), float(mask_duration)])
        return json.dumps(signature, sort_keys=True)

    def run(self, video, start_seconds=0.0, duration_seconds=0.0, mask_video=None, **kwargs):
        cache = Path(folder_paths.get_output_directory()) / "sam3d_funscript" / "cache"
        path, start, duration = video_input_range(video, start_seconds, duration_seconds)
        mask_range = video_input_range(mask_video) if mask_video is not None else None
        sequence = extract_video(path, cache_dir=cache, start_seconds=start, duration_seconds=duration,
                                 mask_video_range=mask_range, **kwargs)
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


class S3F_CorePoseAdapter:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "mhr_pose_data": ("MHR_POSE_DATA",),
            "video": ("VIDEO", {"tooltip": "The same file-backed VIDEO connected to Get Video Components, including any Trim Video node. Preserves original frame timestamps."}),
        }, "optional": {
            "sam3d_body_model": ("SAM3D_BODY_MODEL", {"tooltip": "The same model used for native prediction. Recovers mouth corners from body-only output without running inference again. Optional when native facial landmarks are already present."}),
        }}

    RETURN_TYPES = ("S3F_POSE_SEQUENCE", "STRING")
    RETURN_NAMES = ("poses", "cache_path")
    FUNCTION = "run"
    CATEGORY = CATEGORY

    def run(self, mhr_pose_data, video, sam3d_body_model=None):
        cache = Path(folder_paths.get_output_directory()) / "sam3d_funscript" / "cache"
        sequence = adapt_native_poses(mhr_pose_data, video, cache, sam3d_body_model)
        return sequence, sequence.metadata["cache_path"]


class S3F_AnchorOverride:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "anchor": (list(MHR70_NAMES), {"tooltip": "Detailed MHR70 landmark. Connect to target_anchor_override or reference_anchor_override on Poses → Multi-axis Motion. Left/right are the person's anatomical sides."}),
        }}

    RETURN_TYPES = ("S3F_ANCHOR",)
    RETURN_NAMES = ("anchor",)
    FUNCTION = "run"
    CATEGORY = CATEGORY

    def run(self, anchor):
        if anchor not in MHR70_NAMES:
            raise ValueError(f"Unknown detailed anchor: {anchor}")
        return (anchor,)


class S3F_BuildMotion:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "poses": ("S3F_POSE_SEQUENCE",),
            "target_person": ("INT", {"default": 0, "min": 0, "max": 7}),
            "target_anchor": (list(GENERAL_ANCHORS), {"tooltip": "Hands average wrist + 20 finger points. Mouth averages reconstructed outer mouth corners; requires a new pose cache or the model connected to the core adapter. Base SAM3D does not measure mouth opening. Left/right are anatomical. Connected override takes precedence; rotation follows the torso."}),
            "reference_person": ("INT", {"default": -1, "min": -1, "max": 7, "tooltip": "-1 uses camera coordinates."}),
            "reference_anchor": (list(GENERAL_ANCHORS), {"tooltip": "General anchor on the reference person. Hands average all 21 hand points. A connected reference_anchor_override takes precedence. Ignored when reference_person is -1."}),
            "frame": (["camera", "reference_body"],),
            "smoothing_ms": ("FLOAT", {"default": 80, "min": 0, "max": 2000}),
            "enabled_axes": ("STRING", {"default": "L0,L1,L2,R0,R1,R2"}),
            "settings_json": ("STRING", {"default": "{}", "multiline": True,
                "tooltip": "Optional max_gap_ms, neutral_window_ms, tolerance and axis_settings. L0 Auto adapts direction, origin and range to this anchor over time. Set calibration to clip for a single whole-clip fit. Explicit component/range/center keeps manual calibration unless auto_fit is true. Translation ranges in metres; rotations in degrees."}),
        }, "optional": {
            "target_anchor_override": ("S3F_ANCHOR", {"tooltip": "Connect Detailed Anchor Override to replace target_anchor with a specific landmark."}),
            "reference_anchor_override": ("S3F_ANCHOR", {"tooltip": "Connect Detailed Anchor Override to replace reference_anchor. Ignored when reference_person is -1."}),
        }}

    RETURN_TYPES = ("S3F_MOTION_PROJECT",)
    FUNCTION = "run"
    CATEGORY = CATEGORY

    @classmethod
    def VALIDATE_INPUTS(cls, target_anchor="pelvis", reference_anchor="pelvis"):
        # Older API prompts and converted combo inputs can still name any anchor.
        # Only these two enums bypass Comfy's default list validation.
        for name in (target_anchor, reference_anchor):
            if name not in ANCHORS:
                return f"Unknown anchor: {name}"
        return True

    def run(self, poses, enabled_axes, settings_json, target_anchor_override=None,
            reference_anchor_override=None, **kwargs):
        extras = json.loads(settings_json)
        if not isinstance(extras, dict) or set(extras) & (set(kwargs) | {
                "enabled_axes", "target_anchor_override", "reference_anchor_override"}):
            raise ValueError("settings_json must be an object and cannot override visible node controls")
        for key, override in (("target_anchor", target_anchor_override),
                              ("reference_anchor", reference_anchor_override)):
            if override is not None:
                if not isinstance(override, str) or override not in ANCHORS:
                    raise ValueError(f"Unknown {key}_override: {override}")
                kwargs[key] = override
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
        return {"required": {"filename": ("STRING", {"default": "motion"})}, "optional": ProjectInputs(editor=True),
                "hidden": {"unique_id": "UNIQUE_ID", "extra_pnginfo": "EXTRA_PNGINFO"}}

    RETURN_TYPES = ("STRING", "S3F_EDITOR_SESSION")
    RETURN_NAMES = ("project_path", "editor_session")
    FUNCTION = "run"
    CATEGORY = CATEGORY
    OUTPUT_NODE = True

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        # Editor changes live outside the graph's cached upstream pose inputs.
        return float("nan")

    def run(self, project=None, filename="motion", unique_id=None, extra_pnginfo=None, editor_session=None, **projects):
        root = Path(folder_paths.get_output_directory()) / "sam3d_funscript"
        from .sam3d_funscript.editor import EditorStore
        store = EditorStore(root)
        if editor_session is not None:
            session = editor_session['session']
            path = store.export_path(session)
        else:
            if project is not None:
                projects["project"] = project
            combined = combine_projects(projects)
            workflow = (extra_pnginfo or {}).get("workflow", {})
            node = next((n for n in workflow.get("nodes", []) if str(n["id"]) == str(unique_id)), {})
            session = node.get("properties", {}).get("s3f_session") or uuid.uuid4().hex
            path, _ = store.export(session, combined, lambda data: export_project(data, root, filename))
        return {"ui": {"s3f_project": [path.parent.name], "text": [str(path)]},
                "result": (str(path), {"session": session})}


class S3F_StandaloneExport(S3F_PreviewExport):
    """Same authoring/export path, with a compact node and a dedicated editor tab."""

    RETURN_TYPES = ("STRING", "STRING", "S3F_EDITOR_SESSION")
    RETURN_NAMES = ("project_path", "viewer_path", "editor_session")

    def run(self, **kwargs):
        output = super().run(**kwargs)
        path = Path(output["result"][0]).with_name("viewer.html")
        output["result"] = (output["result"][0], str(path), output["result"][1])
        return output


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


NODE_CLASS_MAPPINGS = {cls.__name__: cls for cls in (S3F_VideoPose, S3F_LoadPoseCache, S3F_CorePoseAdapter, S3F_AnchorOverride, S3F_BuildMotion, S3F_LoadProject, S3F_PreviewExport, S3F_StandaloneExport, S3F_CompareReference)}
NODE_DISPLAY_NAME_MAPPINGS = {
    "S3F_VideoPose": "SAM3D Video → Cached Poses", "S3F_LoadPoseCache": "Load SAM3D Pose Cache",
    "S3F_BuildMotion": "Poses → Multi-axis Motion", "S3F_LoadProject": "Load Funscript Project",
    "S3F_PreviewExport": "Preview & Export Funscripts",
    "S3F_StandaloneExport": "Motion Studio · Standalone",
    "S3F_CompareReference": "Compare Reference Funscript",
    "S3F_CorePoseAdapter": "Core SAM3D → Funscript Poses",
    "S3F_AnchorOverride": "Detailed Anchor Override",
}
