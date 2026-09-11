"""Real HTTP frame/thumbnail handlers with neutral media; no ComfyUI or GPU job."""
import importlib
import sys
import types
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import av
import cv2
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
import numpy as np

from sam3d_funscript.processing_store import ProcessingStore
from sam3d_funscript.reference import source_info, atomic_json


class FrameRouteTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.video = self.root / 'source.mp4'
        with av.open(str(self.video), 'w') as out:
            stream = out.add_stream('libx264', rate=30)
            stream.width, stream.height, stream.pix_fmt = 64, 48, 'yuv420p'
            for i in range(6):
                # Solid colors let us verify which exact frame thumbnail decoding chose.
                image = np.zeros((48, 64, 3), np.uint8)
                image[:, :, i % 3] = 240
                for packet in stream.encode(av.VideoFrame.from_ndarray(image, format='rgb24')):
                    out.mux(packet)
            for packet in stream.encode():
                out.mux(packet)
        self.session = 'a' * 32
        self.info = source_info(self.video)
        self.store = ProcessingStore(self.root / 'sam3d_funscript' / 'processing')
        self.store.prepare(self.session, self.info)
        self.base = '/sam3d_funscript/timelines/' + self.session
        package = types.ModuleType('frame_route_fixture')
        package.__path__ = [str(Path(__file__).resolve().parents[1])]
        folders = types.ModuleType('folder_paths')
        folders.get_output_directory = lambda: str(self.root)
        server = types.ModuleType('server')
        server.PromptServer = types.SimpleNamespace(instance=types.SimpleNamespace(routes=web.RouteTableDef()))
        modules = patch.dict(sys.modules, {'frame_route_fixture': package, 'folder_paths': folders, 'server': server})
        modules.start()
        self.addCleanup(modules.stop)
        module = importlib.import_module('frame_route_fixture.routes')
        module.register_routes()
        self.addCleanup(lambda: [sys.modules.pop(k, None) for k in list(sys.modules) if k.startswith('frame_route_fixture')])
        app = web.Application()
        app.add_routes(server.PromptServer.instance.routes)
        self.client = TestClient(TestServer(app))
        await self.client.start_server()
        self.addAsyncCleanup(self.client.close)

    async def test_index_and_fractional_thumbnail_match_exact_frame_without_plan_edits(self):
        before = self.store.read(self.session)
        response = await self.client.get(self.base + '/frames', params={'source_id': self.info['source_id']})
        self.assertEqual(response.status, 200, await response.text())
        data = await response.json()
        self.assertEqual(data['end_frame'], 6)
        at = data['times_ms'][1]  # 33.333333 ms: rounding this to 33 or 34 is wrong.
        response = await self.client.get(self.base + '/thumbnail', params={'at_ms': str(at)})
        self.assertEqual(response.status, 200)
        import cv2
        pixels = cv2.imdecode(np.frombuffer(await response.read(), np.uint8), cv2.IMREAD_COLOR)
        self.assertEqual(int(pixels.mean(axis=(0, 1)).argmax()), 1, 'second frame is green')
        self.assertEqual(self.store.read(self.session), before)
        response = await self.client.get('/sam3d_funscript/assets/frame-clock.mjs')
        self.assertEqual(response.status, 200)

    async def test_editor_assets_revalidate_after_updates(self):
        for name in ('processing-timeline.html', 'processing-timeline.js',
                     'processing-timeline-edit.mjs', 'cut-markers.mjs', 'reference-mask.mjs', 'stabilization-steps.mjs',
                     'processing-timeline.css', 'workspace.js',
                     'device-previews/device-wireframes.mjs'):
            url = '/sam3d_funscript/assets/' + name
            response = await self.client.get(url)
            self.assertEqual(response.status, 200, name)
            self.assertEqual(response.headers.get('Cache-Control'), 'no-cache', name)
            etag = response.headers['ETag']
            await response.read()
            response = await self.client.get(url, headers={'If-None-Match': etag})
            self.assertEqual(response.status, 304, name)
            self.assertEqual(response.headers.get('Cache-Control'), 'no-cache', name)

    async def test_wrong_source_and_changed_file_are_rejected(self):
        response = await self.client.get(self.base + '/frames', params={'source_id': 'old-source'})
        self.assertEqual(response.status, 409)
        self.video.touch()
        response = await self.client.get(self.base + '/frames', params={'source_id': self.info['source_id']})
        self.assertEqual(response.status, 400)
        self.assertIn('changed', await response.text())

    async def test_reference_capabilities_and_frame_navigation_before_tracking(self):
        response = await self.client.get('/sam3d_funscript/reference-capabilities')
        self.assertEqual(response.status, 200)
        capabilities = await response.json()
        self.assertEqual(capabilities['keyframes'], 1)
        self.assertEqual(capabilities['timeline_stabilize'], 1)
        self.assertEqual(capabilities['reference_masks'], 1)
        self.assertEqual(capabilities['mask_anchors'], 1)
        asset = await self.client.get('/sam3d_funscript/assets/mesh-anchor.mjs')
        self.assertEqual(asset.status, 200)
        self.assertIn('meshAnchorEditor', await asset.text())
        self.assertEqual(response.headers.get('Cache-Control'), 'no-store')
        identifier = 'b'*24
        manifest = self.root/'sam3d_funscript'/'reference'/identifier/'reference.json'
        manifest.parent.mkdir(parents=True)
        atomic_json(manifest, {'id': identifier, 'info': self.info, 'state': 'select_points'})
        before = manifest.read_bytes()
        response = await self.client.get(f'/sam3d_funscript/reference/{identifier}/frames')
        self.assertEqual(response.status, 200, await response.text())
        index = await response.json()
        self.assertEqual(len(index['times_ms']), 6)
        self.assertEqual(index['source_id'], self.info['source_id'])
        self.assertEqual(manifest.read_bytes(), before)

    async def test_packed_mask_preview_is_scoped_to_source_session_and_frame(self):
        import cv2
        identifier='e'*24
        directory=self.store.directory(self.session)/'masks'/identifier
        directory.mkdir(parents=True)
        _,png=cv2.imencode('.png', np.full((48,64),255,np.uint8))
        (directory/'packed.bin').write_bytes(png.tobytes())
        manifest={'info':self.info,'frames':[[0,len(png)]],'data_file':'packed.bin'}
        atomic_json(directory/'mask.json',manifest)
        before=self.store.read(self.session)
        response=await self.client.get(self.base+'/masks/'+identifier+'/0')
        self.assertEqual(response.status,200,await response.text() if response.status!=200 else '')
        self.assertEqual(await response.read(),png.tobytes());self.assertEqual(response.content_type,'image/png')
        for suffix in ('-1','1','nan'):
            response=await self.client.get(self.base+'/masks/'+identifier+'/'+suffix)
            self.assertEqual(response.status,404)
        response=await self.client.get(self.base+'/masks/'+'f'*24+'/0');self.assertEqual(response.status,404)
        manifest['info']={**self.info,'source':{'path':'another.mp4'}};atomic_json(directory/'mask.json',manifest)
        response=await self.client.get(self.base+'/masks/'+identifier+'/0');self.assertEqual(response.status,404)
        self.assertEqual(self.store.read(self.session),before)


if __name__ == '__main__':
    unittest.main()
