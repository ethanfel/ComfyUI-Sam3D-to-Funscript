import copy
import hashlib
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch, MagicMock

from sam3d_funscript.folder_store import FolderStore, identity, motion_session
from sam3d_funscript.public_dataset import build_dataset, encoded_video_id, publish_dataset, validate_snapshot, preserve_published_videos
from sam3d_funscript.video import fingerprint
from sam3d_funscript.civitai_metadata import CivitaiMetadata, from_api


class PublicDatasetTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.videos = self.root / 'private-library'; self.videos.mkdir()
        self.store = FolderStore(self.root / 'store')
        self.folder = self.store.prepare(str(self.videos))['folder']
        self.destination = self.root / 'dataset'

    def clip(self, identifier='123', folder='', approved=False, quality=0, pos=80, audio_sync=False, intensity=0):
        video = self.videos / folder / f'PrivateCreator_civitai_{identifier}_original.mp4'
        video.parent.mkdir(parents=True, exist_ok=True); video.write_bytes(b'fixture video never decoded')
        source = fingerprint(video); clip = identity(source); timeline = identity([self.folder, clip]); session = motion_session(timeline)
        scripts = {axis: dict(version='1.0', inverted=False, range=100,
            actions=[{'at': 0, 'pos': 20}, {'at': 500, 'pos': pos}],
            metadata={'private': '/media/private', 'secret': 'hf_DO_NOT_PUBLISH'}) for axis in ('L0', 'R1')}
        project = dict(metadata=dict(source=source, duration_ms=1000, private_note='DO_NOT_PUBLISH'),
                       scripts=scripts, timeline={'main': {}})
        self.store.editors.write(session, dict(project=project, revision=2))
        self.store.plans.write(dict(session=timeline, project_path='/private/project.json', editor_session=session,
            editor_only=False, result_current=True, info={'source': source, 'end_ms': 1000}, progress={'stage': 'complete'}))
        state = self.store.read(self.folder)
        state['decisions'][clip] = dict(batch_result='ready', quality=quality, note='PRIVATE NOTE', audio_sync=audio_sync, intensity=intensity,
                                       status='approved' if approved else None, editor_revision=2 if approved else None)
        if approved:
            files = []
            for axis, suffix in [('L0', ''), ('R1', '.roll')]:
                path = video.with_name(video.stem + suffix + '.funscript')
                path.write_text(json.dumps(scripts[axis])); files.append(path.name)
            state['decisions'][clip]['files'] = files
        self.store.write(state)
        return clip, timeline, session

    def build(self, **kwargs):
        return build_dataset(self.store.root, self.destination, **kwargs)

    def index(self, identifier='123'):
        key = encoded_video_id(identifier)
        return json.loads((self.destination / f'index/{key[:2]}/{key}.json').read_text())

    def metadata(self, identifier='123', creator='ActualCreator'):
        metadata=from_api(dict(id=identifier,username=creator,postId=77,width=640,height=960), 'civitai.red')
        CivitaiMetadata(self.store.root).save([dict(id=identifier,metadata=metadata)])

    def test_public_civitai_metadata_exports_for_scripts_and_unscripted_copies(self):
        self.clip(approved=True)
        _, _, session=self.clip('456')
        self.store.editors.path(session).unlink()
        self.metadata();self.metadata('456')
        self.build()
        validate_snapshot(self.destination)
        rows=[json.loads(line) for line in (self.destination/'data/videos.jsonl').read_text().splitlines()]
        self.assertEqual(len(rows),2)
        for row in rows:
            self.assertEqual((row['creator_username'],row['post_id']),('ActualCreator','77'))
            self.assertEqual(row['civitai_metadata']['width'],640)
        self.assertEqual(self.index()['variants'][0]['creator_username'],'ActualCreator')
        self.assertEqual(self.index('456')['variants'],[])
        row=json.loads((self.destination/'data/catalog.jsonl').read_text())
        self.assertEqual(row['civitai_metadata']['post_url'],'https://civitai.red/posts/77')

    def test_reexport_without_local_cache_preserves_published_source_metadata(self):
        self.clip(approved=True);self.metadata();self.build()
        previous_root=self.destination;previous=validate_snapshot(previous_root)
        original=self.index()['variants'][0]
        CivitaiMetadata(self.store.root).path.unlink()
        self.destination=self.root/'fresh';self.build()
        self.assertIsNone(self.index()['creator_username'])
        merged, _, retained=preserve_published_videos(self.destination,previous,
            lambda name:(previous_root/name).read_bytes(),self.root/'merged')
        self.assertEqual(retained,0)
        self.destination=merged;validate_snapshot(merged)
        index=self.index()
        self.assertEqual(index['creator_username'],'ActualCreator')
        self.assertEqual(index['variants'][0]['variant_id'],original['variant_id'])
        self.assertEqual(index['variants'][0]['scripts'],original['scripts'])
        self.assertEqual(index['variants'][0]['review_status'],'approved')

    def test_audio_sync_and_tags_export_without_any_editor_or_script(self):
        clip, _, session = self.clip(audio_sync=True, quality=4, folder='dance')
        self.store.editors.path(session).unlink()
        state = self.store.read(self.folder)
        state['decisions'][clip].update(tag_sources={'local': ['woman', 'solo']}, tag_excluded=['solo'])
        self.store.write(state)
        result = self.build()
        self.assertEqual((result['videos'], result['videos_with_scripts'], result['metadata_only_videos'], result['scripts']), (1, 0, 1, 0))
        manifest = validate_snapshot(self.destination)
        self.assertEqual(manifest['review_counts'], {})
        row = json.loads((self.destination / 'data/videos.jsonl').read_text())
        self.assertEqual((row['tags'], row['audio_sync'], row['categories']), (['woman'], True, ['dance']))
        self.assertFalse(row['has_script'])
        index = self.index()
        self.assertEqual(index['variants'], [])
        self.assertIsNone(index['preferred_variant'])
        self.assertNotIn('review_status', row)
        self.assertEqual((self.destination / 'data/catalog.jsonl').read_bytes(), b'')
        public = b''.join(p.read_bytes() for p in self.destination.rglob('*') if p.is_file())
        for private in (b'PrivateCreator', b'PRIVATE NOTE', b'/media/private', b'hf_DO_NOT_PUBLISH'):
            self.assertNotIn(private, public)

    def test_video_tags_merge_across_copies_without_requiring_scripts(self):
        self.clip(folder='one')
        clip, _, session = self.clip(folder='two', audio_sync=True)
        self.store.editors.path(session).unlink()
        state = self.store.read(self.folder)
        state['decisions'][clip]['tag_sources'] = {'local': ['woman']}
        self.store.write(state)
        result = self.build()
        self.assertEqual((result['videos'], result['variants']), (1, 1))
        row = json.loads((self.destination / 'data/videos.jsonl').read_text())
        self.assertEqual(row['tags'], ['woman'])
        self.assertEqual(row['categories'], ['one', 'two'])
        self.assertTrue(row['has_script'])
        self.assertTrue(row['audio_sync'])
        self.assertEqual(self.index()['tags'], ['woman'])

    def test_retained_script_gets_new_video_metadata_and_tag_removals(self):
        clip, timeline, _ = self.clip(approved=True)
        self.build()
        previous_root = self.destination
        previous = validate_snapshot(previous_root)
        original = self.index()['variants'][0]
        plan = self.store.plans.read(timeline)
        plan['result_current'] = False
        self.store.plans.write(plan)
        for number, tags in enumerate((['woman', 'dancing'], [])):
            self.metadata(creator=f'UpdatedCreator{number}')
            state = self.store.read(self.folder)
            state['decisions'][clip].update(tags_manual=tags, audio_sync=bool(tags))
            self.store.write(state)
            self.destination = self.root / f'metadata-{number}'
            self.build()
            self.assertFalse(self.index()['has_script'])
            merged, manifest, retained = preserve_published_videos(self.destination, previous,
                lambda name: (previous_root / name).read_bytes(), self.root / f'merged-{number}')
            self.assertEqual(retained, 1)
            self.assertEqual((manifest['videos_with_scripts'], manifest['metadata_only_videos']), (1, 0))
            self.destination = merged
            index = self.index()
            self.assertEqual(index['tags'], sorted(tags))
            self.assertEqual(index['audio_sync'], bool(tags))
            self.assertEqual(index['variants'][0]['review_status'], 'approved')
            self.assertEqual(index['variants'][0]['creator_username'],f'UpdatedCreator{number}')
            self.assertEqual(index['variants'][0]['scripts'], original['scripts'])
            self.assertEqual(index['variants'][0]['variant_id'], original['variant_id'])
            row = json.loads((merged / 'data/catalog.jsonl').read_text())
            self.assertEqual(row['tags'], sorted(tags))
            self.assertEqual(row['audio_sync'], bool(tags))
            previous_root, previous = merged, manifest

    def test_refresh_retains_metadata_only_records_from_an_earlier_upload(self):
        _, _, session = self.clip(audio_sync=True)
        self.store.editors.path(session).unlink()
        self.build()
        old_root, previous = self.destination, validate_snapshot(self.destination)
        for video in self.videos.glob('*.mp4'):
            video.unlink()
        self.clip('124')
        self.destination = self.root / 'refresh'
        self.build()
        self.destination, manifest, retained = preserve_published_videos(self.destination, previous,
            lambda name: (old_root / name).read_bytes(), self.root / 'merged')
        self.assertEqual(retained, 0)
        self.assertEqual((manifest['videos'], manifest['videos_with_scripts'], manifest['metadata_only_videos']), (2, 1, 1))
        self.assertTrue(self.index()['audio_sync'])
        self.assertFalse(self.index()['has_script'])

    def test_legacy_publication_without_video_catalog_gets_current_tags(self):
        clip, timeline, _ = self.clip(approved=True)
        self.build()
        old_root, previous = self.destination, validate_snapshot(self.destination)
        # Recreate the schema actually published before the video catalog existed.
        del previous['files']['data/videos.jsonl']
        for key in ('video_catalog', 'videos_with_scripts', 'metadata_only_videos'):
            del previous[key]
        (old_root / 'data/videos.jsonl').unlink()
        index_path = next(name for name in previous['files'] if name.startswith('index/'))
        index = json.loads((old_root / index_path).read_text())
        for key in ('has_script', 'tag_sources', 'audio_sync'):
            del index[key]
        (old_root / index_path).write_text(json.dumps(index))
        previous['files'][index_path] = hashlib.sha256((old_root / index_path).read_bytes()).hexdigest()
        (old_root / 'manifest.json').write_text(json.dumps(previous))
        plan = self.store.plans.read(timeline)
        plan['result_current'] = False
        self.store.plans.write(plan)
        state = self.store.read(self.folder)
        state['decisions'][clip]['tags_manual'] = ['dancing']
        self.store.write(state)
        self.destination = self.root / 'refresh'
        self.build()
        self.destination, manifest, retained = preserve_published_videos(self.destination, previous,
            lambda name: (old_root / name).read_bytes(), self.root / 'merged')
        self.assertEqual(retained, 1)
        self.assertEqual(self.index()['tags'], ['dancing'])
        self.assertEqual(self.index()['variants'][0]['review_status'], 'approved')
        self.assertTrue(json.loads((self.destination / 'data/videos.jsonl').read_text())['has_script'])
        validate_snapshot(self.destination)

    def test_tags_export_with_provenance_and_removals_without_approving_drafts(self):
        clip,_,_=self.clip()
        state=self.store.read(self.folder)
        state['decisions'][clip].update(tag_sources={'local':['solo','long hair'],'civitai':['woman']},tags_manual=['dancing'],tag_excluded=['solo'])
        self.store.write(state);self.build(use_folder_approval=True)
        index=self.index();variant=index['variants'][0]
        self.assertEqual(variant['tags'],['dancing','long hair','woman'])
        self.assertEqual(index['tags'],variant['tags'])
        self.assertEqual(variant['tag_sources'],{'local':['long hair'],'civitai':['woman'],'manual':['dancing']})
        self.assertEqual(variant['review_status'],'draft')
        row=json.loads((self.destination/'data/catalog.jsonl').read_text().splitlines()[0])
        self.assertEqual(row['tags'],variant['tags'])
        self.assertNotIn('PRIVATE NOTE',json.dumps(index))

    def test_stable_lookup_multi_axis_and_no_private_fields(self):
        self.clip(approved=True, quality=4)
        result = self.build(use_folder_approval=True)
        self.assertEqual((result['videos'], result['variants'], result['scripts']), (1, 1, 2))
        manifest = validate_snapshot(self.destination)
        self.assertEqual(manifest['license'], 'gpl-3.0')
        self.assertEqual(encoded_video_id('123'), hashlib.sha256(b'civitai:123').hexdigest())
        index = self.index(); variant = index['variants'][0]
        self.assertEqual(variant['review_status'], 'approved'); self.assertEqual(variant['quality'], 4)
        self.assertEqual(set(variant['scripts']), {'L0', 'R1'})
        for axis, script in variant['scripts'].items():
            data = (self.destination / script['path']).read_bytes()
            self.assertEqual(hashlib.sha256(data).hexdigest(), script['sha256'])
            self.assertEqual(set(json.loads(data)), {'version', 'range', 'inverted', 'actions'})
        public = b''.join(p.read_bytes() for p in self.destination.rglob('*') if p.is_file())
        for private in (b'PrivateCreator', b'DO_NOT_PUBLISH', b'PRIVATE NOTE', str(self.root).encode(), b'/media/private'):
            self.assertNotIn(private, public)
        self.assertTrue((self.destination / 'LICENSE').read_text().lstrip().startswith('GNU GENERAL PUBLIC LICENSE'))

    def test_auto_intensity_uses_exported_curve_and_preserves_manual_ratings(self):
        from test_intensity import wave
        from sam3d_funscript.intensity import estimate_intensity
        clip, timeline, session = self.clip(quality=3)
        self.store.review(self.folder, clip, 3, intensity_mode='auto')
        editor = self.store.editors.read(session)
        editor['project']['metadata']['duration_ms'] = 20000
        editor['project']['scripts']['L0'] = {'actions': wave(hz=2)['scripts']['L0']['actions']}
        editor['revision'] += 1; self.store.editors.write(session, editor)
        expected = estimate_intensity(editor['project'])['level']
        self.build(); variant = self.index()['variants'][0]
        self.assertEqual((variant['intensity'], variant['intensity_mode']), (expected, 'auto'))
        self.assertEqual((variant['quality'], variant['review_status']), (3, 'draft'))
        before = variant['variant_id']
        self.store.review(self.folder, clip, 3, intensity=2, intensity_mode='manual')
        self.destination = self.root/'manual'; self.build(); variant = self.index()['variants'][0]
        self.assertEqual((variant['intensity'], variant['intensity_mode']), (2, 'manual'))
        self.assertEqual(variant['variant_id'], before)

    def test_duplicate_intensity_tie_keeps_manual_provenance(self):
        automatic, _, _ = self.clip(folder='automatic', quality=5)
        self.store.review(self.folder, automatic, 5, intensity_mode='auto')
        level = self.store.entry(self.folder, automatic)[0]['intensity']
        self.clip(folder='manual', quality=1, intensity=level)
        self.build(); variants = self.index()['variants']
        self.assertEqual(len(variants), 1)
        self.assertEqual((variants[0]['intensity'], variants[0]['intensity_mode']), (level, 'manual'))

    def test_intensity_metadata_does_not_change_motion_or_review_status(self):
        clip, _, _ = self.clip(quality=2, audio_sync=True)
        self.build(); previous = self.index()['variants'][0]
        self.assertEqual(previous['intensity'], 0)
        self.store.review(self.folder, clip, 2, intensity=4)
        self.destination = self.root / 'intense'; self.build()
        variant = self.index()['variants'][0]
        row = json.loads((self.destination / 'data/catalog.jsonl').read_text())
        self.assertEqual((variant['intensity'], row['intensity']), (4, 4))
        self.assertEqual((variant['quality'], variant['audio_sync'], variant['review_status']), (2, True, 'draft'))
        self.assertEqual((variant['variant_id'], variant['scripts']), (previous['variant_id'], previous['scripts']))
        self.clip(folder='copy', quality=5)
        self.destination = self.root / 'duplicate'; self.build()
        self.assertEqual(self.index()['variants'][0]['intensity'], 4)
        self.store.review(self.folder, clip, 2, intensity=0)
        self.destination = self.root / 'cleared'; self.build()
        self.assertEqual(self.index()['variants'][0]['intensity'], 0)

    def test_audio_sync_metadata_keeps_script_identity_and_draft_status(self):
        clip, _, _ = self.clip()
        self.build()
        original = self.index()['variants'][0]
        self.assertIs(original['audio_sync'], False)
        self.store.review(self.folder, clip, audio_sync=True)
        self.destination = self.root / 'marked-dataset'; self.build()
        marked = self.index()['variants'][0]
        catalog = json.loads((self.destination / 'data/catalog.jsonl').read_text())
        self.assertIs(marked['audio_sync'], True)
        self.assertIs(catalog['audio_sync'], True)
        self.assertEqual((marked['review_status'], marked['quality']), ('draft', 0))
        self.assertEqual(marked['variant_id'], original['variant_id'])
        self.assertEqual(marked['scripts'], original['scripts'])
        self.store.review(self.folder, clip, audio_sync=False)
        self.destination = self.root / 'unmarked-dataset'; self.build()
        self.assertEqual(self.index()['variants'][0], original)

    def test_bulk_audio_sync_labels_export_for_approved_and_draft_clips(self):
        approved,_,_ = self.clip('123',approved=True,quality=4)
        draft,_,_ = self.clip('124',quality=2)
        self.store.review_audio_sync(self.folder,[approved,draft],True)
        self.build(use_folder_approval=True)
        for identifier,status,quality in [('123','approved',4),('124','draft',2)]:
            variant = self.index(identifier)['variants'][0]
            self.assertTrue(variant['audio_sync'])
            self.assertEqual((variant['review_status'],variant['quality']),(status,quality))

    def test_duplicate_downloads_deduplicate_without_mixing_variants(self):
        self.clip(folder='one', approved=True, quality=3)
        self.clip(folder='two', quality=5, audio_sync=True)
        self.clip(folder='different', pos=70, quality=5)
        result = self.build(use_folder_approval=True)
        self.assertEqual((result['videos'], result['variants'], result['scripts']), (1, 2, 4))
        index = self.index()
        self.assertEqual(index['variants'][0]['review_status'], 'approved')
        self.assertEqual(index['preferred_variant'], index['variants'][0]['variant_id'])
        self.assertEqual(index['categories'], ['different', 'one', 'two'])
        self.assertEqual(index['variants'][0]['category_paths'], ['one', 'two'])
        self.assertEqual(index['variants'][1]['category_paths'], ['different'])
        self.assertIs(index['variants'][0]['audio_sync'], True)
        self.assertIs(index['variants'][1]['audio_sync'], False)
        for variant in index['variants']:
            positions = [json.loads((self.destination / axis['path']).read_text())['actions'][-1]['pos']
                         for axis in variant['scripts'].values()]
            self.assertEqual(len(set(positions)), 1)

    def test_category_name_and_hierarchy_are_public_but_library_root_is_not(self):
        self.clip(folder='September_2026/dance')
        self.build()
        index = self.index()
        catalog = json.loads((self.destination / 'data/catalog.jsonl').read_text())
        for item in (index, index['variants'][0], catalog):
            self.assertEqual(item['categories'], ['dance'])
            self.assertEqual(item['category_paths'], ['September_2026/dance'])
        public = b''.join(p.read_bytes() for p in self.destination.rglob('*') if p.is_file())
        for private in (b'private-library', b'PrivateCreator', str(self.root).encode(), b'PRIVATE NOTE', b'hf_DO_NOT_PUBLISH'):
            self.assertNotIn(private, public)
        self.assertEqual(catalog['review_status'], 'draft')
        validate_snapshot(self.destination)

    def test_category_changes_keep_content_ids_and_merge_duplicate_locations(self):
        self.clip(folder='September_2026/dance')
        self.build()
        previous = self.index()['variants'][0]
        self.clip(folder='October_2026/dance', quality=4)
        self.clip(folder='collection/movement', quality=3)
        self.destination = self.root/'categorized'
        self.assertEqual(self.build()['variants'], 1)
        variant = self.index()['variants'][0]
        self.assertEqual(variant['variant_id'], previous['variant_id'])
        self.assertEqual(variant['scripts'], previous['scripts'])
        self.assertEqual(variant['categories'], ['dance', 'movement'])
        self.assertEqual(variant['category_paths'], ['October_2026/dance', 'September_2026/dance', 'collection/movement'])
        self.assertEqual(variant['quality'], 4)

    def test_unsorted_and_temporary_downloads_do_not_publish_internal_directories(self):
        self.clip('121')
        temporary, _, _ = self.clip('122', folder='.s3f-civitai-review/122')
        unsorted, _, _ = self.clip('123', folder='.s3f-civitai-review/123')
        self.clip('124', folder='.s3f-civitai-review/124')  # No managed record.
        state = self.store.read(self.folder)
        for identifier, clip, category in [('122',temporary,'September_2026/dance'), ('123',unsorted,'')]:
            name = f'.s3f-civitai-review/{identifier}/PrivateCreator_civitai_{identifier}_original.mp4'
            state.setdefault('civitai', {})[clip] = dict(id=identifier, name=name, source=fingerprint(self.videos/name),
                                                      temporary=True, category=category, state='pending')
        self.store.write(state)
        self.build()
        self.assertEqual(self.index('122')['category_paths'], ['September_2026/dance'])
        for identifier in ('121', '123', '124'):
            self.assertEqual(self.index(identifier)['categories'], [])
            self.assertEqual(self.index(identifier)['category_paths'], [])
        public = (self.destination/'data/catalog.jsonl').read_text()
        self.assertNotIn('.s3f-civitai-review', public)

    def test_category_path_rejects_absolute_paths_and_hidden_bookkeeping(self):
        from sam3d_funscript.public_dataset import public_category_path
        for value in ('/media/private/dance', 'C:\\private\\dance', '../outside', 'private/../dance',
                      '.s3f-civitai-review/123', 'private/.hidden/dance', '~/dance', 'dance\nsecret', None):
            with self.subTest(value=value):
                self.assertIsNone(public_category_path('.s3f-civitai-review/123/video.mp4', {'temporary':True, 'category':value}))

    def test_category_changed_while_reading_is_skipped(self):
        clip, _, _ = self.clip(folder='.s3f-civitai-review/123')
        state = self.store.read(self.folder)
        name = '.s3f-civitai-review/123/PrivateCreator_civitai_123_original.mp4'
        state['civitai'] = {clip:dict(id='123', name=name, source=fingerprint(self.videos/name),
                                    temporary=True, category='dance', state='pending')}
        self.store.write(state)
        real = self.store.editors.read
        def reassign_after_read(instance, session):
            project = real(session)
            state['civitai'][clip]['category'] = 'movement'; self.store.write(state)
            return project
        with patch('sam3d_funscript.editor.EditorStore.read', new=reassign_after_read):
            self.assertEqual(self.build()['skip_counts'], {'changed during snapshot': 1})

    def test_new_edits_are_drafts_until_reapproved(self):
        _, _, session = self.clip(approved=True)
        state = self.store.editors.read(session); state['revision'] += 1
        state['project']['scripts']['L0']['actions'][-1]['pos'] = 77
        self.store.editors.write(session, state)
        self.build()
        self.assertEqual(self.index()['variants'][0]['review_status'], 'draft')

    def test_relocation_or_presentation_revision_keeps_approved_content(self):
        _, _, session = self.clip(approved=True)
        state = self.store.editors.read(session); state['revision'] += 1
        self.store.editors.write(session, state)
        self.build(use_folder_approval=True)
        self.assertEqual(self.index()['variants'][0]['review_status'], 'approved')

    def test_default_preserves_approvals_without_promoting_unreviewed_scripts(self):
        self.clip('123', approved=True, quality=5)
        self.clip('124', quality=4)
        self.build()
        manifest = validate_snapshot(self.destination)
        self.assertEqual(manifest['review_policy'], 'folder-approval')
        self.assertEqual(manifest['review_counts'], {'approved': 1, 'draft': 1})
        rows = [json.loads(line) for line in (self.destination / 'data/catalog.jsonl').read_text().splitlines()]
        self.assertEqual({row['civitai_id']: row['review_status'] for row in rows}, {'123': 'approved', '124': 'draft'})
        for identifier, status in [('123', 'approved'), ('124', 'draft')]:
            self.assertEqual({v['review_status'] for v in self.index(identifier)['variants']}, {status})
        self.assertNotIn('All variants are unvalidated drafts', (self.destination / 'README.md').read_text())

    def test_refresh_of_old_draft_labels_preserves_script_identity(self):
        self.clip(approved=True)
        self.build(use_folder_approval=False)
        previous = self.index()['variants'][0]
        self.assertEqual(previous['review_status'], 'draft')
        self.destination = self.root / 'refresh'
        self.build()
        current = self.index()['variants'][0]
        self.assertEqual(current['review_status'], 'approved')
        self.assertEqual((current['variant_id'], current['scripts']), (previous['variant_id'], previous['scripts']))

    def test_filter_approved_and_quality(self):
        self.clip('123', approved=True, quality=4)
        self.clip('124', quality=5)
        self.clip('125', approved=True, quality=1)
        result = self.build(approved_only=True, min_quality=3)
        self.assertEqual(result['videos'], 1)
        self.assertEqual(result['skip_counts'], {'not approved': 1, 'quality filter': 1})

    def test_skip_for_now_keeps_saved_drafts_eligible_without_writing_store(self):
        working, _, _ = self.clip('120')
        ignored, _, _ = self.clip('121')
        _, failed_plan, _ = self.clip('122')
        _, stale_plan, _ = self.clip('123')
        self.clip('124')
        state = self.store.read(self.folder)
        state['batch'] = dict(stage='running', current_id=working)
        state['decisions'][ignored]['status'] = 'ignored'; self.store.write(state)
        for session, update in [(failed_plan, {'progress': {'stage': 'error'}}), (stale_plan, {'result_current': False})]:
            plan = self.store.plans.read(session); plan.update(update); self.store.plans.write(plan)
        before = {p: p.read_bytes() for p in self.store.root.rglob('*.json')}
        with patch.object(FolderStore, 'scan', side_effect=AssertionError('Must not recover or mutate a running queue')):
            result = self.build()
        self.assertEqual((result['videos'], result['videos_with_scripts']), (5, 2))
        self.assertEqual(self.index('121')['variants'][0]['review_status'], 'draft')
        self.assertEqual(set(result['skip_counts']), {'processing', 'failed processing', 'outdated processing result'})
        self.assertEqual(before, {p: p.read_bytes() for p in self.store.root.rglob('*.json')})

    def test_changed_editor_during_snapshot_is_skipped(self):
        _, _, session = self.clip()
        real = self.store.editors.read
        def edit_after_read(instance, key):
            old = real(key)
            newer = copy.deepcopy(old); newer['revision'] += 1
            newer['project']['scripts']['L0']['actions'][-1]['pos'] = 61
            instance.write(key, newer)
            return old
        with patch('sam3d_funscript.editor.EditorStore.read', new=edit_after_read):
            result = self.build()
        self.assertEqual(result['videos'], 0)
        self.assertEqual(result['skip_counts'], {'changed during snapshot': 1})
        self.assertFalse(self.destination.exists())

    def test_blank_or_imported_main_not_published_automatically(self):
        _, timeline, session = self.clip()
        plan = self.store.plans.read(timeline); plan['editor_only'] = True; self.store.plans.write(plan)
        self.assertEqual(self.build()['variants'], 0)
        state = self.store.editors.read(session)
        state['project']['metadata']['imported_scripts'] = ['private.funscript']
        state['project']['timeline']['main'] = {'L0': {'edited': True}}
        self.store.editors.write(session, state)
        self.destination = self.root / 'imported'
        self.assertEqual(self.build()['variants'], 0)
        del state['project']['metadata']['imported_scripts']; self.store.editors.write(session, state)
        self.destination = self.root / 'authored'
        self.assertEqual(self.build()['variants'], 1)

    def test_invalid_actions_rejected_and_names_never_enter_public_paths(self):
        _, _, session = self.clip()
        state = self.store.editors.read(session); state['project']['scripts']['L0']['actions'][1]['at'] = 0
        self.store.editors.write(session, state)
        self.assertEqual(self.build()['variants'], 0)
        for value in ('../private', '00123', 'https://civitai.com/images/123', '-1', '0'):
            with self.assertRaises(ValueError): encoded_video_id(value)

    def test_snapshot_checksums_links_and_path_traversal(self):
        self.clip(); self.build()
        path = self.destination / 'data/catalog.jsonl'; original = path.read_bytes(); path.write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'changed'): validate_snapshot(self.destination)
        path.unlink(); outside = self.root / 'outside'; outside.write_bytes(original); path.symlink_to(outside)
        with self.assertRaisesRegex(ValueError, 'inside'): validate_snapshot(self.destination)
        path.unlink(); path.write_bytes(original)
        manifest_path = self.destination / 'manifest.json'; manifest = json.loads(manifest_path.read_text())
        manifest['files']['../outside'] = hashlib.sha256(original).hexdigest(); manifest_path.write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, 'file list'): validate_snapshot(self.destination)

    def test_export_does_not_overwrite_a_snapshot(self):
        self.clip(); self.build()
        with self.assertRaisesRegex(ValueError, 'existing exports'): self.build()

    def test_publish_uses_only_verified_public_files_and_one_pinned_commit(self):
        self.clip(); self.build()
        (self.destination / 'private.env').write_text('DO_NOT_UPLOAD')
        api = MagicMock(); api.repo_info.return_value = types.SimpleNamespace(private=False, sha='old-head', siblings=[])
        api.upload_folder.return_value = types.SimpleNamespace(oid='new-head')
        with patch('huggingface_hub.HfApi', return_value=api):
            result = publish_dataset(self.destination, 'owner/dataset')
        self.assertEqual(result['commit'], 'new-head')
        api.create_repo.assert_called_once_with('owner/dataset', repo_type='dataset', private=False, exist_ok=True)
        sent = api.upload_folder.call_args.kwargs
        self.assertEqual(sent['parent_commit'], 'old-head'); self.assertNotIn('private.env', sent['allow_patterns'])
        self.assertEqual(set(sent['allow_patterns']), set(validate_snapshot(self.destination)['files']) | {'manifest.json'})

    def test_publish_rejects_private_or_unrelated_repositories(self):
        self.clip(); self.build()
        api = MagicMock()
        with patch('huggingface_hub.HfApi', return_value=api):
            api.repo_info.return_value = types.SimpleNamespace(private=True, siblings=[], sha='head')
            with self.assertRaisesRegex(ValueError, 'private'): publish_dataset(self.destination, 'owner/data')
            api.repo_info.return_value = types.SimpleNamespace(private=False, siblings=[types.SimpleNamespace(rfilename='other.json')], sha='head')
            with self.assertRaisesRegex(ValueError, 'empty dataset'): publish_dataset(self.destination, 'owner/data')
        api.upload_folder.assert_not_called()

    def test_update_deletes_only_files_managed_by_previous_snapshot(self):
        self.clip(); self.build()
        previous = validate_snapshot(self.destination)
        obsolete = 'index/aa/' + 'a'*64 + '.json'; previous['files'][obsolete] = 'b'*64
        old = self.root / 'old-manifest.json'; old.write_text(json.dumps(previous))
        api = MagicMock(); api.repo_info.return_value = types.SimpleNamespace(private=False, sha='head',
            siblings=[types.SimpleNamespace(rfilename='manifest.json'), types.SimpleNamespace(rfilename='user-notes.md')])
        api.upload_folder.return_value = types.SimpleNamespace(oid='new-head')
        def old_file(repo, name, **kwargs):
            return str(old if name == 'manifest.json' else self.destination / name)
        with patch('huggingface_hub.HfApi', return_value=api), patch('huggingface_hub.hf_hub_download', side_effect=old_file) as download:
            publish_dataset(self.destination, 'owner/data')
        self.assertEqual(api.upload_folder.call_args.kwargs['delete_patterns'], [obsolete])
        self.assertEqual(download.call_args.kwargs['revision'], 'head')

    def test_refresh_retains_unavailable_videos_and_replaces_ready_results(self):
        self.clip('123', pos=80)
        _, deferred_plan, _ = self.clip('124', approved=True, quality=4, audio_sync=True)
        self.build(use_folder_approval=True)
        old_root = self.destination
        old_variant = self.index('123')['variants'][0]
        old_deferred = self.index('124')['variants'][0]
        self.clip('123', pos=65, quality=5)
        self.clip('125', quality=2)
        plan = self.store.plans.read(deferred_plan); plan['result_current'] = False; self.store.plans.write(plan)
        self.destination = self.root / 'refresh'; self.build()
        source_before = {p: p.read_bytes() for p in self.destination.rglob('*') if p.is_file()}
        (self.destination / 'private.env').write_text('DO_NOT_UPLOAD')
        api = MagicMock(); api.repo_info.return_value = types.SimpleNamespace(private=False, sha='pinned-head',
            siblings=[types.SimpleNamespace(rfilename='manifest.json')])
        def inspect_upload(**kwargs):
            upload = Path(kwargs['folder_path']); manifest = validate_snapshot(upload)
            self.assertEqual((manifest['videos'], manifest['variants'], manifest['scripts']), (3, 3, 6))
            self.assertEqual(manifest['review_counts'], {'draft': 2, 'approved': 1})
            rows = {row['civitai_id']: row for row in map(json.loads, (upload / 'data/catalog.jsonl').read_text().splitlines())}
            self.assertEqual(rows['124']['scripts'], old_deferred['scripts'])
            self.assertEqual((rows['124']['quality'], rows['124']['audio_sync']), (4, True))
            self.assertNotEqual(rows['123']['variant_id'], old_variant['variant_id'])
            self.assertEqual(set(kwargs['delete_patterns']), {axis['path'] for axis in old_variant['scripts'].values()})
            self.assertNotIn('private.env', kwargs['allow_patterns'])
            self.assertFalse((upload / 'private.env').exists())
            self.assertIn('3 Civitai video IDs and 3 saved Main variants', (upload / 'README.md').read_text())
            return types.SimpleNamespace(oid='new-head')
        api.upload_folder.side_effect = inspect_upload
        with patch('huggingface_hub.HfApi', return_value=api), patch('huggingface_hub.hf_hub_download',
                side_effect=lambda repo, name, **kw: str(old_root / name)) as download:
            result = publish_dataset(self.destination, 'owner/data')
        self.assertEqual(result['retained_videos'], 1)
        self.assertEqual(result['videos'], 3)
        self.assertTrue(all(call.kwargs['revision'] == 'pinned-head' for call in download.call_args_list))
        self.assertEqual(source_before, {p: p.read_bytes() for p in source_before})

    def test_retained_publication_checksum_failure_stops_upload(self):
        self.clip('123'); self.build()
        old_root = self.destination
        self.destination = self.root / 'refresh'; self.build()
        (old_root / 'data/catalog.jsonl').write_text('corrupted')
        api = MagicMock(); api.repo_info.return_value = types.SimpleNamespace(private=False, sha='head',
            siblings=[types.SimpleNamespace(rfilename='manifest.json')])
        with patch('huggingface_hub.HfApi', return_value=api), patch('huggingface_hub.hf_hub_download',
                side_effect=lambda repo, name, **kw: str(old_root / name)):
            with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
                publish_dataset(self.destination, 'owner/data')
        api.upload_folder.assert_not_called()


if __name__ == '__main__':
    unittest.main()
