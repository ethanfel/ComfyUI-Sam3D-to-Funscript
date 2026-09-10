"""Preview assets, generated projects and revision-checked local editor drafts."""

from pathlib import Path
import asyncio
from fractions import Fraction
import json
import math
import re
import uuid

from aiohttp import web
import folder_paths
from server import PromptServer

from .sam3d_funscript.core import load_project
from .sam3d_funscript.standalone import standalone_html
from .sam3d_funscript.editor import EditorStore, Conflict
from .sam3d_funscript.reference_preview import reference_preview
from .sam3d_funscript.processing_store import ProcessingStore, PlanConflict


def register_routes():
    routes = PromptServer.instance.routes
    assets = Path(__file__).parent / "assets"
    thumbnail_slots = asyncio.Semaphore(2)

    def editor_store():
        return EditorStore(Path(folder_paths.get_output_directory()) / "sam3d_funscript")

    def processing_store():
        return ProcessingStore(Path(folder_paths.get_output_directory()) / "sam3d_funscript" / "processing")

    def processing_state(request):
        try:
            state = processing_store().read(request.match_info["session"])
        except ValueError as error:
            raise web.HTTPBadRequest(text=str(error))
        if state is None:
            raise web.HTTPNotFound(text="Queue the timeline node once to load its video.")
        return state

    @routes.get("/sam3d_funscript/timelines/{session}")
    async def processing_get(request):
        return web.json_response(processing_state(request), headers={"Cache-Control": "no-store"})

    @routes.post("/sam3d_funscript/timelines/{session}")
    async def processing_save(request):
        request = request.clone(client_max_size=16 * 1024 * 1024)
        try:
            body = await request.json()
            state = processing_store().save(request.match_info["session"], body["revision"], body["plan"])
            return web.json_response(state)
        except PlanConflict as error:
            raise web.HTTPConflict(text=str(error))
        except (ValueError, TypeError, KeyError) as error:
            raise web.HTTPBadRequest(text=str(error))

    @routes.get("/sam3d_funscript/timelines/{session}/video")
    async def processing_video(request):
        path = Path(processing_state(request)["info"]["source"]["path"])
        if not path.is_file():
            raise web.HTTPNotFound(text="Source video moved; choose its new location in the workflow.")
        return web.FileResponse(path)

    @routes.get("/sam3d_funscript/timelines/{session}/thumbnail")
    async def processing_thumbnail(request):
        state = processing_state(request)
        try:
            at = float(request.query.get("at_ms", "0"))
            if not math.isfinite(at):
                raise ValueError("Thumbnail time must be finite")
            at = max(float(Fraction(state["info"]["start"]) * 1000), min(at, state["info"]["end_ms"] - .001))
        except (ValueError, TypeError) as error:
            raise web.HTTPBadRequest(text=str(error))
        directory = processing_store().directory(state["session"]) / "thumbnails" / state["info"]["source_id"]
        path = directory / f"{round(at)}.jpg"

        def generate():
            from contextlib import closing
            import cv2
            from .sam3d_funscript.reference import decode
            info = {**state["info"], "start": str(Fraction(str(at)) / 1000), "duration": "0"}
            with closing(decode(info)) as frames:
                frame = next(frames, None)
            if frame is None:
                return False
            pixels = frame[0]
            small = cv2.resize(pixels, (192, max(1, round(pixels.shape[0] * 192 / pixels.shape[1]))), interpolation=cv2.INTER_AREA)
            okay, encoded = cv2.imencode(".jpg", small, [cv2.IMWRITE_JPEG_QUALITY, 75])
            if not okay:
                return False
            directory.mkdir(parents=True, exist_ok=True)
            temporary = directory / f".{path.name}.{uuid.uuid4().hex}.tmp"
            temporary.write_bytes(encoded.tobytes())
            temporary.replace(path)
            return True

        if not path.is_file():
            async with thumbnail_slots:
                if not path.is_file() and not await asyncio.to_thread(generate):
                    raise web.HTTPNotFound(text="No source frame at this time")
        return web.FileResponse(path)

    @routes.get("/sam3d_funscript/editors/{session}")
    async def editor_get(request):
        try:
            state = editor_store().read(request.match_info["session"])
        except ValueError as error:
            raise web.HTTPBadRequest(text=str(error))
        return web.json_response(state, headers={"Cache-Control": "no-store"})

    @routes.post("/sam3d_funscript/editors/{session}")
    async def editor_save(request):
        # Pose projects can exceed aiohttp's default 1 MB request limit.
        request = request.clone(client_max_size=512 * 1024 * 1024)
        try:
            body = await request.json()
            state = editor_store().save(request.match_info["session"], body["project"], body["revision"])
            return web.json_response({"revision": state["revision"]})
        except Conflict as error:
            raise web.HTTPConflict(text=str(error))
        except (ValueError, KeyError, TypeError) as error:
            raise web.HTTPBadRequest(text=str(error))

    def project_path(request):
        name = request.match_info["project"]
        if not re.fullmatch(r"[\w.-]+_[0-9a-f]{12}", name):
            raise web.HTTPNotFound()
        root = (Path(folder_paths.get_output_directory()) / "sam3d_funscript").resolve()
        path = (root / name / "project.json").resolve()
        if not path.is_relative_to(root) or not path.is_file():
            raise web.HTTPNotFound()
        return path

    @routes.get("/sam3d_funscript/assets/{name}")
    async def asset(request):
        name = request.match_info["name"]
        if name == "viewer-standalone.html":
            return web.Response(text=standalone_html(), content_type="text/html")
        if name not in ("viewer.html", "viewer.js", "viewer.css", "curve.mjs", "curve-edit.mjs", "patterns.mjs", "timeline.mjs", "editor-session.mjs", "viewport.mjs", "device-output.mjs", "reference.html", "reference.js", "reference.css", "reference-edit.mjs", "video-preview.mjs", "processing-timeline.html", "processing-timeline.css", "processing-timeline.js", "processing-timeline-edit.mjs", "workspace.html", "workspace.css", "workspace.js", "workflow-host.mjs", "cut-markers.mjs", "timeline-layout.mjs"):
            raise web.HTTPNotFound()
        return web.FileResponse(assets / name)

    def reference_path(request):
        identifier = request.match_info["reference"]
        if not re.fullmatch(r"[0-9a-f]{24}", identifier):
            raise web.HTTPNotFound()
        root = (Path(folder_paths.get_output_directory()) / "sam3d_funscript" / "reference").resolve()
        path = (root / identifier / "reference.json").resolve()
        if not path.is_relative_to(root) or not path.is_file():
            raise web.HTTPNotFound()
        return path

    @routes.get("/sam3d_funscript/reference/{reference}")
    async def reference_project(request):
        return web.FileResponse(reference_path(request), headers={"Cache-Control": "no-store"})

    @routes.get("/sam3d_funscript/reference/{reference}/video/{kind}")
    async def reference_video(request):
        manifest = reference_path(request)
        kind = request.match_info["kind"]
        if kind == "source":
            path = Path(json.loads(manifest.read_text())["info"]["source"]["path"])
        elif kind == "stabilized":
            path = manifest.with_name("stabilized.mp4")
        else:
            raise web.HTTPNotFound()
        if not path.is_file():
            raise web.HTTPNotFound()
        return web.FileResponse(path)

    @routes.get("/sam3d_funscript/assets/device-previews/{name}")
    async def device_asset(request):
        name = request.match_info["name"]
        if name not in ("device-wireframes.mjs", "preview.html", "handy2.svg", "sr6.svg", "preview.svg"):
            raise web.HTTPNotFound()
        return web.FileResponse(assets / "device-previews" / name)

    @routes.get("/sam3d_funscript/projects/{project}")
    async def project(request):
        return web.FileResponse(project_path(request))

    def video_source(project_file):
        manifest = project_file.with_name("source.json")
        return json.loads(manifest.read_text()) if manifest.is_file() else load_project(project_file)["metadata"]["source"]

    @routes.get("/sam3d_funscript/video/{project}/reference")
    async def video_reference(request):
        project_file = project_path(request)
        preview = project_file.with_name("reference-preview.json")
        if preview.is_file():
            return web.FileResponse(preview)
        return web.json_response(reference_preview(video_source(project_file)))

    @routes.get("/sam3d_funscript/video/{project}")
    async def video(request):
        project_file = project_path(request)
        source = video_source(project_file)
        variant = request.query.get("variant", "stabilized")
        if variant == "original":
            original = project_file.with_name("original-source.json")
            if original.is_file():
                source = json.loads(original.read_text())
            else:
                comparison = reference_preview(source)
                if not comparison:
                    raise web.HTTPNotFound(text="This project has no reference stabilization source.")
                source = comparison["source"]
        elif variant != "stabilized":
            raise web.HTTPBadRequest(text="Unknown video variant")
        path = Path(source["path"])
        if path.suffix.lower() not in (".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v") or not path.is_file():
            raise web.HTTPNotFound(text="Source video moved or unsupported; select a local file in the preview.")
        return web.FileResponse(path)
