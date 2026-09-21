"""Preview assets, generated projects and revision-checked local editor drafts."""

from pathlib import Path
import asyncio
from fractions import Fraction
import json
import math
import re
import uuid
from urllib.parse import quote

from aiohttp import web
import folder_paths
from server import PromptServer

from .sam3d_funscript.core import load_project
from .sam3d_funscript.standalone import standalone_html
from .sam3d_funscript.editor import EditorStore, Conflict
from .sam3d_funscript.reference_preview import reference_preview
from .sam3d_funscript.processing_store import ProcessingStore, PlanConflict
from .sam3d_funscript.video_audio import extract_video_audio


def register_routes():
    routes = PromptServer.instance.routes
    assets = Path(__file__).parent / "assets"
    thumbnail_slots = asyncio.Semaphore(2)
    frame_index_slots = asyncio.Semaphore(1)
    audio_slots = asyncio.Semaphore(1)

    def editor_store():
        return EditorStore(Path(folder_paths.get_output_directory()) / "sam3d_funscript")

    def processing_store():
        return ProcessingStore(Path(folder_paths.get_output_directory()) / "sam3d_funscript" / "processing")

    def folder_store():
        from .sam3d_funscript.folder_store import FolderStore
        return FolderStore(Path(folder_paths.get_output_directory()) / "sam3d_funscript")

    civitai_download_slots = asyncio.Semaphore(2)

    @routes.get('/sam3d_funscript/civitai/{folder}/thumbnail/{clip}')
    async def civitai_local_thumbnail(request):
        from .sam3d_funscript.civitai_library import CivitaiLibrary
        try:
            async with thumbnail_slots:
                path=await asyncio.to_thread(CivitaiLibrary(folder_store().root).thumbnail,
                    request.match_info['folder'],request.match_info['clip'])
            return web.FileResponse(path,headers={'Cache-Control':'private, max-age=86400'})
        except (ValueError,OSError) as error:raise web.HTTPNotFound(text=str(error))

    @routes.get('/sam3d_funscript/civitai/{folder}/local/{clip}')
    async def civitai_local_video(request):
        try:
            _,path=await asyncio.to_thread(folder_store().entry,request.match_info['folder'],request.match_info['clip'])
            return web.FileResponse(path,headers={'Cache-Control':'private, no-cache'})
        except (ValueError,OSError) as error:raise web.HTTPNotFound(text=str(error))

    @routes.get('/sam3d_funscript/civitai/{folder}')
    async def civitai_library(request):
        from .sam3d_funscript.civitai_library import CivitaiLibrary
        try:
            library=CivitaiLibrary(folder_store().root)
            return web.json_response(await asyncio.to_thread(library.catalogue,request.match_info['folder']),headers={'Cache-Control':'no-store'})
        except (ValueError,OSError) as error:raise web.HTTPBadRequest(text=str(error))

    @routes.post('/sam3d_funscript/civitai/{folder}/{action}')
    async def civitai_action(request):
        from .sam3d_funscript.civitai_library import CivitaiLibrary
        try:
            body=await request.json();library=CivitaiLibrary(folder_store().root)
            if not isinstance(body,dict):raise ValueError('Send a JSON object for the Civitai action.')
            folder=request.match_info['folder'];action=request.match_info['action']
            library.folders.read(folder)
            if action=='browse':result=await asyncio.to_thread(library.browse,folder,body)
            elif action=='category':result=await asyncio.to_thread(library.add_category,folder,body['name'])
            elif action=='ignore':result=await asyncio.to_thread(library.ignore,folder,body['id'],body.get('ignored',True))
            elif action=='key':result=await asyncio.to_thread(library.set_token,body.get('token',''))
            elif action=='queue':
                from .sam3d_funscript.folder_queue import FolderQueue
                result=await asyncio.to_thread(FolderQueue(library.root).change,folder,body.get('action'),body)
            elif action=='download':
                async with civitai_download_slots:
                    result=await asyncio.to_thread(library.download,folder,body['id'],body['category'],body.get('site','civitai.red'))
            else:raise ValueError('Unknown Civitai action.')
            return web.json_response(result,headers={'Cache-Control':'no-store'})
        except PlanConflict as error:raise web.HTTPConflict(text=str(error))
        except (ValueError,TypeError,KeyError,OSError) as error:raise web.HTTPBadRequest(text=str(error))

    @routes.get("/sam3d_funscript/folders/{folder}")
    async def folder_get(request):
        try:
            return web.json_response(await asyncio.to_thread(folder_store().scan, request.match_info['folder']), headers={'Cache-Control': 'no-store'})
        except (ValueError, OSError) as error:
            raise web.HTTPBadRequest(text=str(error))

    @routes.post("/sam3d_funscript/folders/{folder}/{action}")
    async def folder_action(request):
        try:
            body = await request.json()
            store, folder, action = folder_store(), request.match_info['folder'], request.match_info['action']
            if action == 'open':
                result = await asyncio.to_thread(store.open, folder, body['clip'], body.get('client'))
            elif action in ('queue_start','queue_failed'):
                from .sam3d_funscript.folder_queue import FolderQueue
                queue=FolderQueue(store.root)
                if action=='queue_start':result=await asyncio.to_thread(queue.start,folder)
                else:result=await asyncio.to_thread(queue.failed_start,folder,body['ticket'],str(body.get('error','Queue submission failed.')))
            elif action in ('civitai_approve','civitai_reject'):
                from .sam3d_funscript.civitai_library import CivitaiLibrary
                from .sam3d_funscript.civitai_review import CivitaiReview
                review=CivitaiReview(CivitaiLibrary(store.root))
                if action=='civitai_approve':
                    result=await asyncio.to_thread(review.approve,folder,body['clip'],body.get('category',''),body['revision'],body.get('replace',False),body.get('expected'))
                else:result=await asyncio.to_thread(review.reject,folder,body['clip'])
            elif action == 'ignore':
                result = await asyncio.to_thread(store.ignore, folder, body['clip'], body.get('ignored', True), body.get('note', ''))
            elif action == 'approve':
                entry,_=await asyncio.to_thread(store.entry,folder,body['clip'])
                if entry.get('civitai_temporary'):raise ValueError('Review this temporary clip in the Civitai tab and choose its approval category.')
                result = await asyncio.to_thread(store.approve, folder, body['clip'], body['revision'], body.get('replace', False), body.get('expected'))
            elif action == 'review':
                result = await asyncio.to_thread(store.review, folder, body['clip'], body.get('quality', 0), body.get('note', ''))
            elif action == 'lease':
                result = await asyncio.to_thread(store.hold_review, folder, body.get('clip'), body['client'])
            elif action == 'preset':
                result = await asyncio.to_thread(store.preset, folder, body.get('subfolder',''), body.get('settings'))
            elif action == 'versions':
                result = await asyncio.to_thread(store.versions, folder, body['clip'])
            elif action == 'version':
                result = await asyncio.to_thread(store.version, folder, body['clip'], body['version'])
            elif action == 'save_version':
                result = await asyncio.to_thread(store.save_version, folder, body['clip'], body['name'], body['revision'], body.get('quality',0), body.get('note',''))
            elif action == 'restore_version':
                result = await asyncio.to_thread(store.restore_version, folder, body['clip'], body['version'], body['revision'])
            elif action == 'rate_version':
                result = await asyncio.to_thread(store.rate_version, folder, body['clip'], body['version'],body['name'],body['quality'],body.get('note',''))
            elif action == 'issues':
                result = await asyncio.to_thread(store.issues, folder, body['clip'])
            elif action == 'pause':
                result = await asyncio.to_thread(store.pause_batch, folder)
            elif action == 'preflight':
                from .sam3d_funscript.folder_review import preflight
                needs_tracker=False if body.get('queue') is True else await asyncio.to_thread(store.needs_tracker,folder,body.get('subfolder',''),body.get('retry_failed') is True,body.get('clip_ids'))
                result = await asyncio.to_thread(preflight, body.get('settings',{}), needs_tracker=needs_tracker)
            else:
                raise ValueError('Unknown folder action')
            return web.json_response(result)
        except PlanConflict as error:
            raise web.HTTPConflict(text=str(error))
        except (ValueError, TypeError, KeyError, OSError) as error:
            raise web.HTTPBadRequest(text=str(error))

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
            from .sam3d_funscript.folder_store import editing_session
            with editing_session(request.match_info['session']):
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

    @routes.post("/sam3d_funscript/timelines/{session}/cuts/edit")
    async def processing_edit_cut(request):
        from .sam3d_funscript.frame_index import frame_index
        from .sam3d_funscript.scene_cuts import edit_cut
        from .sam3d_funscript.reference import digest
        request = request.clone(client_max_size=4 * 1024 * 1024)
        try:
            body = await request.json()
            if not isinstance(body, dict):
                raise ValueError('Cut edit must be a JSON object.')
            state = processing_state(request)
            if body['source_id'] != state['info']['source_id']:
                raise PlanConflict('The source video changed. Reload the timeline before editing cuts.')
            expected = digest(body['expected_cuts'])
            if expected != digest(state.get('scene_cuts')):
                raise PlanConflict('Cut markers changed in another tab or scan. Reload the markers and try again.')
            frame = body['frame']
            if type(frame) is not int or body['action'] not in ('add', 'remove'):
                raise ValueError('Choose a source frame and an add or remove action.')
            async with frame_index_slots:
                index = await asyncio.to_thread(frame_index, state['info'], processing_store().root / 'frame-index')
            if not index['first_frame'] < frame < index['end_frame']:
                raise ValueError('A cut must be inside the video, on the first frame of the new shot.')
            at = index['times_ms'][frame - index['first_frame']]
            result = edit_cut(state.get('scene_cuts'), body['source_id'], at, body['action'])
            from .sam3d_funscript.folder_store import editing_session
            with editing_session(state['session']):
                updated = processing_store().update_cuts(state['session'], body['source_id'], result,
                    {'stage': 'complete'}, expected=expected)
            return web.json_response(updated)
        except PlanConflict as error:
            raise web.HTTPConflict(text=str(error))
        except (ValueError, TypeError, KeyError, OSError) as error:
            raise web.HTTPBadRequest(text=str(error))

    @routes.post("/sam3d_funscript/timelines/{session}/cuts/import")
    async def processing_import_cuts(request):
        from .sam3d_funscript.edl import import_edl
        from .sam3d_funscript.frame_index import frame_index
        from .sam3d_funscript.reference import digest
        request = request.clone(client_max_size=4 * 1024 * 1024)
        try:
            body = await request.json()
            if not isinstance(body, dict):
                raise ValueError('EDL import must be a JSON object.')
            state = processing_state(request)
            if body['source_id'] != state['info']['source_id']:
                raise PlanConflict('The source video changed. Reload the timeline before importing cuts.')
            preview = body.get('preview', True)
            if not isinstance(preview, bool):
                raise ValueError('Invalid import preview option.')
            if not preview and not isinstance(body.get('expected_cuts'), str):
                raise ValueError('Preview the EDL before importing its cuts.')
            async with frame_index_slots:
                index = await asyncio.to_thread(frame_index, state['info'], processing_store().root / 'frame-index')
            result = await asyncio.to_thread(import_edl, body['text'], state['info'], index,
                fps=body['fps'], start_timecode=body.get('start_timecode', ''), filename=body.get('filename', ''))
            if processing_state(request)['info']['source_id'] != result['source_id']:
                raise PlanConflict('The source video changed while reading the EDL. Reload the timeline.')
            if preview:
                return web.json_response({'cuts': result, 'expected_cuts': digest(state.get('scene_cuts'))})
            from .sam3d_funscript.folder_store import editing_session
            with editing_session(state['session']):
                updated = processing_store().update_cuts(state['session'], result['source_id'], result,
                    {'stage': 'complete'}, expected=body['expected_cuts'])
            return web.json_response(updated)
        except PlanConflict as error:
            raise web.HTTPConflict(text=str(error))
        except (ValueError, TypeError, KeyError, OSError) as error:
            raise web.HTTPBadRequest(text=str(error))

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
        # Versioned key avoids previously cached, millisecond-rounded thumbnails
        # that could show the frame after a fractional-rate boundary.
        path = directory / f"frame-{round(at * 1_000_000)}.jpg"

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

    @routes.get("/sam3d_funscript/timelines/{session}/frames")
    async def processing_frames(request):
        from .sam3d_funscript.frame_index import frame_index
        state = processing_state(request)
        if request.query.get("source_id") != state["info"]["source_id"]:
            raise web.HTTPConflict(text="The source changed. Reload the timeline.")
        try:
            async with frame_index_slots:
                result = await asyncio.to_thread(frame_index, state["info"], processing_store().root / "frame-index")
            if processing_state(request)["info"]["source_id"] != result["source_id"]:
                raise web.HTTPConflict(text="The source changed while indexing frames. Reload the timeline.")
            return web.json_response(result)
        except (ValueError, OSError) as error:
            raise web.HTTPBadRequest(text=str(error))

    @routes.get("/sam3d_funscript/timelines/{session}/masks/{mask}/{frame}")
    async def processing_mask_frame(request):
        from contextlib import closing
        from .sam3d_funscript.reference_mask import MaskReader
        state = processing_state(request)
        identifier = request.match_info["mask"]
        if not re.fullmatch(r"[a-f0-9]{24}", identifier): raise web.HTTPNotFound()
        root = processing_store().directory(state["session"]).resolve()
        path = (root / "masks" / identifier / "mask.json").resolve()
        if not path.is_relative_to(root) or not path.is_file(): raise web.HTTPNotFound()
        try:
            index = int(request.match_info["frame"])
            with closing(MaskReader(path)) as reader:
                if reader.manifest["info"]["source"] != state["info"]["source"]: raise web.HTTPNotFound()
                if not 0 <= index < len(reader.manifest["frames"]): raise web.HTTPNotFound()
                png = reader.png(index)
            return web.Response(body=png, content_type="image/png", headers={"Cache-Control": "no-cache"})
        except (ValueError, OSError, KeyError):
            raise web.HTTPNotFound()

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
            from .sam3d_funscript.folder_store import editing_session
            with editing_session(request.match_info['session']):
                state = editor_store().save(request.match_info["session"], body["project"], body["revision"])
            return web.json_response({"revision": state["revision"]})
        except (Conflict, PlanConflict) as error:
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
            return web.Response(text=standalone_html(), content_type="text/html", headers={"Cache-Control": "no-cache"})
        if name not in ("civitai-browser.mjs", "civitai-queue.mjs", "civitai-browser.css", "folder.html", "folder.js", "folder.css", "viewer.html", "viewer.js", "viewer.css", "curve.mjs", "curve-edit.mjs", "patterns.mjs", "audio-analysis.mjs", "audio-patterns.mjs", "audio-lane.mjs", "timeline.mjs", "editor-session.mjs", "viewport.mjs", "device-output.mjs", "reference.html", "reference.js", "reference.css", "reference-edit.mjs", "reference-mask.mjs", "stabilization-steps.mjs", "mesh-anchor.mjs", "video-preview.mjs", "processing-timeline.html", "processing-timeline.css", "processing-timeline.js", "processing-timeline-edit.mjs", "workspace.html", "workspace.css", "workspace.js", "workflow-host.mjs", "cut-markers.mjs", "cut-import.mjs", "timeline-layout.mjs", "frame-clock.mjs", "processing-state.mjs", "timeline-restore.mjs", "timeline-subject.mjs"):
            raise web.HTTPNotFound()
        # Module entry points and imported helpers must revalidate together after
        # an update. Heuristic caching can otherwise mix incompatible exports.
        return web.FileResponse(assets / name, headers={"Cache-Control": "no-cache"})

    @routes.get("/sam3d_funscript/reference-capabilities")
    async def reference_capabilities(request):
        return web.json_response({"keyframes": 1, "tracking_modes": ["online", "offline"], "timeline_stabilize": 1, "reference_masks": 1, "mask_anchors": 1, "anchor_preview": 1, "timeline_scope": 1, "subject_crop": 1, "automatic_scenes": 1, "automatic_stabilization": 1, "similarity_stabilization": 1, "orientation_stabilization": 1, "sam3_mask_seed": 1}, headers={"Cache-Control": "no-store"})

    @routes.get('/sam3d_funscript/mask-seed-models')
    async def mask_seed_models(request):
        from .sam3d_funscript.mask_seed import core_models
        return web.json_response(await asyncio.to_thread(core_models), headers={'Cache-Control': 'no-store'})

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

    @routes.get("/sam3d_funscript/reference/{reference}/frames")
    async def reference_frames(request):
        from .sam3d_funscript.frame_index import frame_index
        path = reference_path(request)
        info = json.loads(path.read_text())["info"]
        async with frame_index_slots:
            result = await asyncio.to_thread(frame_index, info, path.parent.parent / "frame-index")
        return web.json_response(result)

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
        return web.FileResponse(assets / "device-previews" / name, headers={"Cache-Control": "no-cache"})

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

    def preview_video_path(request):
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
        return path

    @routes.get("/sam3d_funscript/video/{project}/audio")
    async def video_audio(request):
        source = preview_video_path(request)
        directory = Path(folder_paths.get_output_directory()) / 'sam3d_funscript' / 'audio-previews'
        try:
            async with audio_slots:
                path, start_ms = await asyncio.to_thread(extract_video_audio, source, directory)
            return web.FileResponse(path, headers={'Content-Type': 'audio/wav', 'Cache-Control': 'no-cache',
                'X-S3F-Audio-Start-Ms': str(start_ms), 'X-S3F-Audio-Name': quote(source.name)})
        except (ValueError, OSError) as error:
            raise web.HTTPBadRequest(text=str(error))

    @routes.get("/sam3d_funscript/video/{project}")
    async def video(request):
        return web.FileResponse(preview_video_path(request))
