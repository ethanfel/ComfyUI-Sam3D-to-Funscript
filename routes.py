"""Read-only preview routes; only generated projects under our output directory."""

from pathlib import Path
import json
import re

from aiohttp import web
import folder_paths
from server import PromptServer

from .sam3d_funscript.core import load_project


def register_routes():
    routes = PromptServer.instance.routes
    assets = Path(__file__).parent / "assets"

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
        if name not in ("viewer.html", "viewer.js", "viewer.css", "curve.mjs"):
            raise web.HTTPNotFound()
        return web.FileResponse(assets / name)

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
