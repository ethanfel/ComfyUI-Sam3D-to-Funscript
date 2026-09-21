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

    async def test_folder_routes_open_ignore_restore_and_approve_saved_main(self):
        from sam3d_funscript.folder_store import FolderStore
        store = FolderStore(self.root / 'sam3d_funscript')
        listing = store.prepare(str(self.root), False)
        entry = listing['entries'][0]
        url = '/sam3d_funscript/folders/' + listing['folder']
        response = await self.client.get(url)
        self.assertEqual(response.status, 200)
        self.assertEqual((await response.json())['counts']['pending'], 1)
        response = await self.client.post(url + '/ignore', json={'clip': entry['id'], 'note': 'Unusable tracking'})
        self.assertEqual(response.status, 200)
        self.assertEqual((await response.json())['counts']['ignored'], 1)
        response = await self.client.post(url + '/ignore', json={'clip': entry['id'], 'ignored': False})
        self.assertEqual(response.status, 200)
        response = await self.client.post(url + '/open', json={'clip': entry['id']})
        self.assertEqual(response.status, 200, await response.text())
        editor = store.editors.read(entry['editor_session'])
        response = await self.client.post(url + '/approve', json={'clip': entry['id'], 'revision': editor['revision'] - 1})
        self.assertEqual(response.status, 409)
        response = await self.client.post(url + '/approve', json={'clip': entry['id'], 'revision': editor['revision']})
        self.assertEqual(response.status, 200, await response.text())
        self.assertEqual((await response.json())['listing']['counts']['approved'], 1)
        self.assertTrue(self.video.with_suffix('.funscript').exists())
        for name in ('folder.html', 'folder.js', 'folder.css'):
            response = await self.client.get('/sam3d_funscript/assets/' + name)
            self.assertEqual(response.status, 200)

    async def test_civitai_catalogue_browse_local_ranges_and_validation(self):
        import shutil
        module=importlib.import_module('frame_route_fixture.sam3d_funscript.civitai_library')
        library=module.CivitaiLibrary(self.root/'sam3d_funscript')
        shutil.copy2(self.video,self.root/'Neutral_civitai_123_original.mp4')
        folder=library.folders.prepare(str(self.root))['folder'];base='/sam3d_funscript/civitai/'+folder
        response=await self.client.get(base);self.assertEqual(response.status,200)
        data=await response.json();entry=data['items']['123'][0]
        response=await self.client.get(base+'/local/'+entry['id'],headers={'Range':'bytes=0-31'})
        self.assertEqual(response.status,206);self.assertEqual(len(await response.read()),32)
        self.assertFalse((library.folders.plans.directory(entry['timeline'])/'timeline.json').exists())
        with patch.object(module,'fetch_json',return_value={'items':[],'metadata':{'nextCursor':'test'}}):
            response=await self.client.post(base+'/browse',json={'sort':'Newest','site':'civitai.com'})
            self.assertEqual((await response.json())['next_cursor'],'test')
        for action,body in [('browse',[]),('category',{'name':'../outside'}),('download',{'id':'../123','category':'Dance'})]:
            response=await self.client.post(base+'/'+action,json=body);self.assertEqual(response.status,400)
        for name in ('civitai-browser.mjs','civitai-queue.mjs','civitai-browser.css'):
            self.assertEqual((await self.client.get('/sam3d_funscript/assets/'+name)).status,200)

    async def test_civitai_queue_actions_persist_without_starting_downloads(self):
        from sam3d_funscript.folder_store import FolderStore
        store=FolderStore(self.root/'sam3d_funscript');folder=store.prepare(str(self.root))['folder']
        url='/sam3d_funscript/civitai/'+folder+'/queue'
        module=importlib.import_module('frame_route_fixture.sam3d_funscript.civitai_library')
        with patch.object(module,'fetch_json') as fetch:
            response=await self.client.post(url,json={'action':'add','items':[{'id':'123','name':'Neutral clip'}]})
            self.assertEqual(response.status,200);queue=await response.json()
            self.assertEqual(queue['items'][0]['state'],'waiting')
            response=await self.client.get('/sam3d_funscript/civitai/'+folder)
            self.assertEqual((await response.json())['queue']['items'],queue['items'])
            start='/sam3d_funscript/folders/'+folder+'/queue_start'
            response=await self.client.post(start,json={});self.assertEqual(response.status,200)
            self.assertEqual((await response.json())['stage'],'queued')
            self.assertEqual((await self.client.post(start,json={})).status,409)
            response=await self.client.post(url,json={'action':'pause'})
            self.assertEqual((await response.json())['stage'],'paused')
            response=await self.client.post(url,json={'action':'remove','key':queue['items'][0]['key']})
            self.assertEqual((await response.json())['items'],[])
            fetch.assert_not_called()
        self.assertEqual((await self.client.post(url,json={'action':'add','items':[{'id':'../bad'}]})).status,400)

    async def test_civitai_local_and_temporary_thumbnails_are_lazy_cached_images(self):
        import shutil
        module=importlib.import_module('frame_route_fixture.sam3d_funscript.civitai_library')
        library=module.CivitaiLibrary(self.root/'sam3d_funscript')
        videos=self.root/'library';videos.mkdir()
        shutil.copy2(self.video,videos/'Neutral_civitai_123_original.mp4')
        folder=library.folders.prepare(str(videos))['folder']
        remote={'id':456,'type':'video','url':'https://image.civitai.com/key/uuid/width=450/456.mp4'}
        with patch.object(module,'fetch_json',return_value={'items':[remote]}),patch.object(module,'transfer_video',side_effect=lambda url,path,progress:shutil.copy2(self.video,path)):
            staged=library.download(folder,'456','Neutral')['entry']
        self.assertTrue(staged['civitai_temporary'])
        base='/sam3d_funscript/civitai/'+folder
        with patch.object(av,'open',side_effect=AssertionError('Listing must not decode videos')):
            response=await self.client.get(base)
            entries=[group[0] for group in (await response.json())['items'].values()]
        self.assertFalse((library.root/'civitai'/'thumbnails').exists())
        for entry in entries:
            url=base+'/thumbnail/'+entry['id']
            response=await self.client.get(url)
            self.assertEqual(response.status,200,await response.text() if response.status!=200 else '')
            self.assertEqual(response.content_type,'image/jpeg')
            pixels=cv2.imdecode(np.frombuffer(await response.read(),np.uint8),cv2.IMREAD_COLOR)
            self.assertEqual(pixels.shape,(48,64,3))
            self.assertGreater(pixels[:,:,2].mean(),220)  # The first frame is red.
            self.assertLess(pixels[:,:,:2].mean(),15)
            with patch.object(av,'open',side_effect=AssertionError('Cached preview must not decode again')):
                cached=await self.client.get(url,headers={'If-None-Match':response.headers['ETag']})
                self.assertEqual(cached.status,304)
            self.assertFalse((library.folders.plans.directory(entry['timeline'])/'timeline.json').exists())
        self.assertEqual((await self.client.get(base+'/thumbnail/not-a-clip')).status,404)
        self.assertEqual((await self.client.get(base+'/thumbnail/'+'0'*32)).status,404)

    async def test_civitai_thumbnail_resizes_and_refreshes_when_local_video_changes(self):
        module=importlib.import_module('frame_route_fixture.sam3d_funscript.civitai_library')
        library=module.CivitaiLibrary(self.root/'sam3d_funscript')
        videos=self.root/'library';videos.mkdir()
        video=videos/'Neutral_civitai_123_original.mp4'
        folder=library.folders.prepare(str(videos))['folder']
        ids=[]
        for channel in (0,2):
            with av.open(str(video),'w') as out:
                stream=out.add_stream('libx264',rate=30)
                stream.width,stream.height,stream.pix_fmt=640,480,'yuv420p'
                image=np.zeros((480,640,3),np.uint8);image[:,:,channel]=240
                for packet in stream.encode(av.VideoFrame.from_ndarray(image,format='bgr24')):out.mux(packet)
                for packet in stream.encode():out.mux(packet)
            entry=library.catalogue(folder)['items']['123'][0];ids.append(entry['id'])
            response=await self.client.get('/sam3d_funscript/civitai/'+folder+'/thumbnail/'+entry['id'])
            self.assertEqual(response.status,200)
            pixels=cv2.imdecode(np.frombuffer(await response.read(),np.uint8),cv2.IMREAD_COLOR)
            self.assertEqual(pixels.shape,(270,360,3))
            self.assertGreater(pixels[:,:,channel].mean(),220)
        self.assertNotEqual(*ids)

    async def test_folder_versions_presets_and_active_clip_save_guard(self):
        module=importlib.import_module('frame_route_fixture.sam3d_funscript.folder_store')
        store=module.FolderStore(self.root/'sam3d_funscript')
        listing=store.prepare(str(self.root),False);entry=listing['entries'][0];folder=listing['folder']
        url='/sam3d_funscript/folders/'+folder
        response=await self.client.post(url+'/open',json={'clip':entry['id'],'client':'b'*32})
        self.assertEqual(response.status,200,await response.text())
        editor=store.editors.read(entry['editor_session'])
        version=await self.client.post(url+'/save_version',json={'clip':entry['id'],'name':'Original','revision':editor['revision'],'quality':4})
        self.assertEqual(version.status,200,await version.text());version=await version.json()
        response=await self.client.post(url+'/versions',json={'clip':entry['id']})
        self.assertEqual((await response.json())[0]['name'],'Original')
        response=await self.client.post(url+'/preset',json={'subfolder':'nested','settings':{'preferred_anchor':'mouth'}})
        self.assertEqual(response.status,200,await response.text())
        response=await self.client.post(url+'/preset',json={'subfolder':'nested/deeper'})
        self.assertEqual((await response.json())['settings']['preferred_anchor'],'mouth')
        response=await self.client.post(url+'/issues',json={'clip':entry['id']})
        self.assertEqual(response.status,200)
        module.ACTIVE[entry['timeline']]=module.ACTIVE[entry['editor_session']]=-1
        try:
            response=await self.client.post('/sam3d_funscript/editors/'+entry['editor_session'],json={'revision':editor['revision'],'project':editor['project']})
            self.assertEqual(response.status,409,await response.text())
            state=store.plans.read(entry['timeline'])
            response=await self.client.post('/sam3d_funscript/timelines/'+entry['timeline'],json={'revision':state['revision'],'plan':state['plan']})
            self.assertEqual(response.status,409,await response.text())
            response=await self.client.post(url+'/restore_version',json={'clip':entry['id'],'version':version['id'],'revision':editor['revision']})
            self.assertEqual(response.status,409,await response.text())
        finally:
            module.ACTIVE.pop(entry['timeline']);module.ACTIVE.pop(entry['editor_session'])
        response=await self.client.post(url+'/restore_version',json={'clip':entry['id'],'version':version['id'],'revision':editor['revision']})
        self.assertEqual(response.status,200,await response.text())
        self.assertFalse(self.video.with_suffix('.funscript').exists())

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

    async def test_timeline_import_graph_is_served(self):
        import re
        from urllib.parse import urljoin, urlsplit
        pending = ['/sam3d_funscript/assets/processing-timeline.js', '/sam3d_funscript/assets/viewer.js']
        visited = set()
        while pending:
            url = pending.pop()
            if url in visited:
                continue
            visited.add(url)
            response = await self.client.get(url)
            self.assertEqual(response.status, 200, url)
            source = await response.text()
            for relative in re.findall(r'''(?:from\s*|import\s*\()\s*["'](\./[^"']+)["']''', source):
                pending.append(urlsplit(urljoin(url, relative)).path)
        self.assertIn('/sam3d_funscript/assets/timeline-restore.mjs', visited)
        self.assertIn('/sam3d_funscript/assets/audio-lane.mjs', visited)
        self.assertIn('/sam3d_funscript/assets/audio-analysis.mjs', visited)
        self.assertIn('/sam3d_funscript/assets/audio-patterns.mjs', visited)
        # EDL is deliberately optional at startup, including across a live
        # file update before the server reloads its asset allowlist.
        self.assertNotIn('/sam3d_funscript/assets/cut-import.mjs', visited)
        response = await self.client.get('/sam3d_funscript/assets/cut-import.mjs')
        self.assertEqual(response.status, 200)

    async def test_video_soundtrack_uses_project_source_and_original_variant(self):
        from test_video_audio import audio_video
        import io
        import wave
        from urllib.parse import quote
        source = self.root / 'music with spaces.mkv'
        audio_video(source)
        directory = self.root / 'sam3d_funscript' / 'neutral_aaaaaaaaaaaa'
        directory.mkdir()
        atomic_json(directory / 'project.json', {})
        atomic_json(directory / 'source.json', {'path': str(self.video)})
        atomic_json(directory / 'original-source.json', {'path': str(source)})
        url = '/sam3d_funscript/video/neutral_aaaaaaaaaaaa/audio'
        before = self.store.read(self.session)
        response = await self.client.get(url)
        self.assertEqual(response.status, 400)
        self.assertIn('no audio track', await response.text())
        response = await self.client.get(url, params={'variant': 'original'})
        self.assertEqual(response.status, 200)
        self.assertEqual(response.content_type, 'audio/wav')
        self.assertEqual(float(response.headers['X-S3F-Audio-Start-Ms']), 2000)
        self.assertEqual(response.headers['X-S3F-Audio-Name'], quote(source.name))
        data = await response.read()
        with wave.open(io.BytesIO(data)) as audio:
            self.assertEqual(audio.getframerate(), 11025)
            self.assertGreater(audio.getnframes(), 4000)
        response = await self.client.get(url, params={'variant': 'original'})
        self.assertEqual(await response.read(), data)
        for suffix, status in [('?variant=arbitrary', 400), ('?variant=../../source', 400)]:
            response = await self.client.get(url + suffix)
            self.assertEqual(response.status, status)
        response = await self.client.get('/sam3d_funscript/video/missing_aaaaaaaaaaaa/audio')
        self.assertEqual(response.status, 404)
        self.assertEqual(self.store.read(self.session), before)

    async def test_initial_mask_capability_and_installed_core_model_list(self):
        folders = sys.modules['folder_paths']
        folders.folder_names_and_paths = {'checkpoints': [], 'diffusion_models': [], 'sam3': []}
        folders.get_filename_list = lambda group: {
            'checkpoints':['sam3.pt','sam_3d_body.safetensors','other-model.safetensors'],
            'diffusion_models':['SAM3/full.safetensors','SAM3/sam3.1.safetensors'],
            'sam3':['sam3.1_multiplex.pt','SAM2Matting-SAM3.pt','sam3.json','sam3d_body.pt']}[group]
        before = self.store.read(self.session)
        response = await self.client.get('/sam3d_funscript/reference-capabilities')
        self.assertEqual((await response.json())['sam3_mask_seed'],1)
        response = await self.client.get('/sam3d_funscript/mask-seed-models')
        self.assertEqual(response.status,200)
        self.assertEqual(response.headers['Cache-Control'],'no-store')
        self.assertEqual(await response.json(),[
            {'value':'checkpoints:sam3.pt','label':'SAM3 · sam3.pt (checkpoints)'},
            {'value':'diffusion_models:SAM3/full.safetensors','label':'SAM3 · SAM3/full.safetensors (diffusion_models)'},
            {'value':'diffusion_models:SAM3/sam3.1.safetensors','label':'SAM3.1 · SAM3/sam3.1.safetensors (diffusion_models)'},
            {'value':'sam3:sam3.1_multiplex.pt','label':'SAM3.1 · sam3.1_multiplex.pt (sam3)'}])
        self.assertEqual(self.store.read(self.session),before)

    def edl_request(self):
        return {'source_id': self.info['source_id'], 'fps': '30', 'filename': 'montage.edl',
                'text': 'TITLE: Test\nFCM: NON-DROP FRAME\n'
                        '001 AX V C 08:00:00:00 08:00:00:03 01:00:00:00 01:00:00:03\n* FROM CLIP NAME: Opening\n'
                        '002 AX V C 09:00:00:00 09:00:00:03 01:00:00:03 01:00:00:06\n* FROM CLIP NAME: Closing\n'}

    async def test_edl_preview_import_and_restart_preserve_plan_and_motion(self):
        state = self.store.read(self.session)
        state['plan']['tracking'][0]['locked'] = True
        state = self.store.save(self.session, state['revision'], state['plan'])
        self.store.finish(self.session, state['revision'], {'regions': []}, self.root/'saved'/'project.json')
        before = self.store.read(self.session)
        self.assertTrue(before['result_current'])
        body = self.edl_request()
        response = await self.client.post(self.base+'/cuts/import', json=body)
        self.assertEqual(response.status, 200, await response.text())
        preview = await response.json()
        self.assertEqual(preview['cuts']['times_ms'], [100])
        self.assertEqual(preview['cuts']['segments'][1]['name'], 'Closing')
        self.assertEqual(self.store.read(self.session), before)
        response = await self.client.post(self.base+'/cuts/import', json={**body, 'preview': False, 'expected_cuts': preview['expected_cuts']})
        self.assertEqual(response.status, 200, await response.text())
        after = await response.json()
        for key in ('plan', 'revision', 'project', 'report', 'result_current'):
            self.assertEqual(after[key], before[key], key)
        reopened = ProcessingStore(self.store.root).prepare(self.session, self.info)
        self.assertEqual(reopened['scene_cuts'], preview['cuts'])

    async def test_edl_invalid_or_stale_import_never_overwrites_saved_markers(self):
        body = self.edl_request()
        response = await self.client.post(self.base+'/cuts/import', json=body)
        preview = await response.json()
        self.store.update_cuts(self.session, self.info['source_id'], {'source_id':self.info['source_id'], 'times_ms':[50]})
        before = self.store.read(self.session)
        response = await self.client.post(self.base+'/cuts/import', json={**body, 'preview':False, 'expected_cuts':preview['expected_cuts']})
        self.assertEqual(response.status, 409)
        for update, status in [({'source_id':'other'},409), ({'text':'garbage'},400), ({'fps':25},400), ({'preview':False},400)]:
            response = await self.client.post(self.base+'/cuts/import', json={**body, **update})
            self.assertEqual(response.status, status, await response.text())
        self.assertEqual(self.store.read(self.session), before)

    async def test_manual_cut_exact_frame_persists_without_changing_locked_motion(self):
        state = self.store.read(self.session)
        state['plan']['tracking'][0]['locked'] = True
        state = self.store.save(self.session, state['revision'], state['plan'])
        self.store.finish(self.session, state['revision'], {'regions': []}, self.root/'saved'/'project.json')
        before = self.store.read(self.session)
        index = await (await self.client.get(self.base + '/frames', params={'source_id': self.info['source_id']})).json()
        at = index['times_ms'][1]
        body = {'source_id': self.info['source_id'], 'action': 'add', 'frame': 1, 'expected_cuts': None}
        response = await self.client.post(self.base + '/cuts/edit', json=body)
        self.assertEqual(response.status, 200, await response.text())
        added = await response.json()
        self.assertEqual(added['scene_cuts']['times_ms'], [at])
        self.assertEqual(added['scene_cuts']['manual_times_ms'], [at])
        for key in ('plan', 'revision', 'project', 'report', 'result_current'):
            self.assertEqual(added[key], before[key], key)
        reopened = ProcessingStore(self.store.root).prepare(self.session, self.info)
        self.assertEqual(reopened, added)
        body['expected_cuts'] = added['scene_cuts']
        duplicate = await self.client.post(self.base + '/cuts/edit', json=body)
        self.assertEqual(await duplicate.json(), added)
        response = await self.client.post(self.base + '/cuts/edit', json={**body, 'action': 'remove'})
        removed = await response.json()
        self.assertEqual(response.status, 200)
        self.assertEqual(removed['scene_cuts']['times_ms'], [])
        self.assertEqual(removed['scene_cuts']['manual_times_ms'], [])
        for key in ('plan', 'revision', 'project', 'report', 'result_current'):
            self.assertEqual(removed[key], before[key], key)

    async def test_manual_cut_rejects_invalid_and_stale_edits(self):
        body = {'source_id': self.info['source_id'], 'action': 'add', 'frame': 1, 'expected_cuts': None}
        before = self.store.read(self.session)
        for change in ({'frame': True}, {'frame': 1.5}, {'frame': -1}, {'frame': 0}, {'frame': 6}, {'action': 'clear'}):
            response = await self.client.post(self.base + '/cuts/edit', json={**body, **change})
            self.assertEqual(response.status, 400, await response.text())
        response = await self.client.post(self.base + '/cuts/edit', json={k:v for k,v in body.items() if k!='expected_cuts'})
        self.assertEqual(response.status, 400)
        response = await self.client.post(self.base + '/cuts/edit', json={**body, 'source_id': 'old'})
        self.assertEqual(response.status, 409)
        self.assertEqual(self.store.read(self.session), before)
        await self.client.post(self.base + '/cuts/edit', json=body)
        before = self.store.read(self.session)
        response = await self.client.post(self.base + '/cuts/edit', json={**body, 'frame': 2})
        self.assertEqual(response.status, 409)
        self.assertEqual(self.store.read(self.session), before)

    async def test_editor_assets_revalidate_after_updates(self):
        for name in ('processing-timeline.html', 'processing-timeline.js',
                     'processing-timeline-edit.mjs', 'cut-markers.mjs', 'reference-mask.mjs', 'stabilization-steps.mjs',
                     'processing-state.mjs', 'timeline-restore.mjs', 'timeline-subject.mjs',
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
        self.assertEqual(capabilities['anchor_preview'], 1)
        self.assertEqual(capabilities['timeline_scope'], 1)
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
