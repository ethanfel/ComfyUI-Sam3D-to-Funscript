"""Preview assets, generated projects and revision-checked local editor drafts."""

from pathlib import Path
import json
import re

from aiohttp import web
import folder_paths
from server import PromptServer

from .sam3d_funscript.core import load_project
from .sam3d_funscript.standalone import standalone_html
from .sam3d_funscript.editor import EditorStore, Conflict


def register_routes():
    routes = PromptServer.instance.routes
    assets = Path(__file__).parent / "assets"

    def editor_store():
        return EditorStore(Path(folder_paths.get_output_directory()) / "sam3d_funscript")

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
        if name not in ("viewer.html", "viewer.js", "viewer.css", "curve.mjs", "timeline.mjs", "editor-session.mjs", "viewport.mjs", "device-output.mjs"):
            raise web.HTTPNotFound()
        return web.FileResponse(assets / name)

    @routes.get("/sam3d_funscript/assets/device-previews/{name}")
    async def device_asset(request):
        name = request.match_info["name"]
        if name not in ("device-wireframes.mjs", "preview.html", "handy2.svg", "sr6.svg", "preview.svg"):
            raise web.HTTPNotFound()
        return web.FileResponse(assets / "device-previews" / name)

    @routes.get("/sam3d_funscript/projects/{project}")
    async def project(request):
        return web.FileResponse(project_path(request))

    @routes.get("/sam3d_funscript/video/{project}")
    async def video(request):
        project_file = project_path(request)
        manifest = project_file.with_name("source.json")
        source = json.loads(manifest.read_text()) if manifest.is_file() else load_project(project_file)["metadata"]["source"]
        path = Path(source["path"])
        if path.suffix.lower() not in (".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v") or not path.is_file():
            raise web.HTTPNotFound(text="Source video moved or unsupported; select a local file in the preview.")
        return web.FileResponse(path)
