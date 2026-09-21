import copy
import hashlib
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch, MagicMock

from sam3d_funscript.folder_store import FolderStore, identity, motion_session
from sam3d_funscript.public_dataset import build_dataset, encoded_video_id, publish_dataset, validate_snapshot
from sam3d_funscript.video import fingerprint


class PublicDatasetTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.videos = self.root / 'private-library'; self.videos.mkdir()
        self.store = FolderStore(self.root / 'store')
        self.folder = self.store.prepare(str(self.videos))['folder']
        self.destination = self.root / 'dataset'

    def clip(self, identifier='123', folder='', approved=False, quality=0, pos=80):
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
        state['decisions'][clip] = dict(batch_result='ready', quality=quality, note='PRIVATE NOTE',
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

    def test_duplicate_downloads_deduplicate_without_mixing_variants(self):
        self.clip(folder='one', approved=True, quality=3)
        self.clip(folder='two', quality=5)
        self.clip(folder='different', pos=70, quality=5)
        result = self.build(use_folder_approval=True)
        self.assertEqual((result['videos'], result['variants'], result['scripts']), (1, 2, 4))
        index = self.index()
        self.assertEqual(index['variants'][0]['review_status'], 'approved')
        self.assertEqual(index['preferred_variant'], index['variants'][0]['variant_id'])
        self.assertEqual(index['categories'], ['different', 'one', 'two'])
        self.assertEqual(index['variants'][0]['category_paths'], ['one', 'two'])
        self.assertEqual(index['variants'][1]['category_paths'], ['different'])
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
        self.build(use_folder_approval=True)
        self.assertEqual(self.index()['variants'][0]['review_status'], 'draft')

    def test_relocation_or_presentation_revision_keeps_approved_content(self):
        _, _, session = self.clip(approved=True)
        state = self.store.editors.read(session); state['revision'] += 1
        self.store.editors.write(session, state)
        self.build(use_folder_approval=True)
        self.assertEqual(self.index()['variants'][0]['review_status'], 'approved')

    def test_default_keeps_local_approvals_and_quality_ratings_as_drafts(self):
        self.clip('123', approved=True, quality=5)
        self.clip('124', quality=4)
        self.build()
        manifest = validate_snapshot(self.destination)
        self.assertEqual(manifest['review_policy'], 'all-drafts')
        self.assertEqual(manifest['review_counts'], {'draft': 2})
        rows = [json.loads(line) for line in (self.destination / 'data/catalog.jsonl').read_text().splitlines()]
        self.assertEqual({row['review_status'] for row in rows}, {'draft'})
        for identifier in ('123', '124'):
            self.assertEqual({v['review_status'] for v in self.index(identifier)['variants']}, {'draft'})
        self.assertIn('All variants are unvalidated drafts', (self.destination / 'README.md').read_text())

    def test_filter_approved_and_quality(self):
        self.clip('123', approved=True, quality=4)
        self.clip('124', quality=5)
        self.clip('125', approved=True, quality=1)
        result = self.build(approved_only=True, min_quality=3)
        self.assertEqual(result['videos'], 1)
        self.assertEqual(result['skip_counts'], {'not approved': 1, 'quality filter': 1})

    def test_skip_live_failed_ignored_and_stale_results_without_writing_store(self):
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
        self.assertEqual(result['videos'], 1)
        self.assertEqual(set(result['skip_counts']), {'processing', 'ignored', 'failed processing', 'outdated processing result'})
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
        self.assertEqual(self.build()['videos'], 0)
        state = self.store.editors.read(session)
        state['project']['metadata']['imported_scripts'] = ['private.funscript']
        state['project']['timeline']['main'] = {'L0': {'edited': True}}
        self.store.editors.write(session, state)
        self.assertEqual(self.build()['videos'], 0)
        del state['project']['metadata']['imported_scripts']; self.store.editors.write(session, state)
        self.assertEqual(self.build()['videos'], 1)

    def test_invalid_actions_rejected_and_names_never_enter_public_paths(self):
        _, _, session = self.clip()
        state = self.store.editors.read(session); state['project']['scripts']['L0']['actions'][1]['at'] = 0
        self.store.editors.write(session, state)
        self.assertEqual(self.build()['videos'], 0)
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
        with patch('huggingface_hub.HfApi', return_value=api), patch('huggingface_hub.hf_hub_download', return_value=str(old)) as download:
            publish_dataset(self.destination, 'owner/data')
        self.assertEqual(api.upload_folder.call_args.kwargs['delete_patterns'], [obsolete])
        self.assertEqual(download.call_args.kwargs['revision'], 'head')


if __name__ == '__main__':
    unittest.main()
