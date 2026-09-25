import json
import threading
import unittest
from unittest.mock import patch

import test_public_dataset as fixtures
from sam3d_funscript.dataset_upload import DatasetUpload, RUNNING
from sam3d_funscript.processing_store import PlanConflict
from sam3d_funscript.public_dataset import validate_snapshot


class DatasetUploadTests(unittest.TestCase):
    clip = fixtures.PublicDatasetTests.clip

    def setUp(self):
        fixtures.PublicDatasetTests.setUp(self)
        self.upload = DatasetUpload(self.store.root)
        auth = patch('sam3d_funscript.dataset_upload.credentials', return_value=dict(available=True, authenticated=True))
        auth.start(); self.addCleanup(auth.stop)
        self.addCleanup(lambda: RUNNING.discard((str(self.store.root), self.folder)))

    def start(self):
        with patch('sam3d_funscript.dataset_upload.threading.Thread'):
            return self.upload.start(self.folder, 'tester/example')

    def test_upload_preserves_review_status_tags_and_source_files(self):
        clip, _, _ = self.clip(approved=True, quality=4, audio_sync=True, intensity=3)
        self.store.review(self.folder, clip, 4, audio_sync=True, intensity=3, tags=['woman', 'dancing'])
        self.clip('124', quality=5)
        original = {path: path.read_bytes() for path in self.root.rglob('*') if path.is_file()}
        started = self.start()
        self.assertEqual(started['job']['stage'], 'building')
        self.assertTrue(started['use_folder_approval'])
        self.assertTrue(started['busy'])
        paths = []
        def publish(directory, repo):
            paths.append(directory)
            self.assertEqual(repo, 'tester/example')
            self.assertEqual(self.upload.read(self.folder)['job']['stage'], 'uploading')
            manifest = validate_snapshot(directory)
            self.assertEqual(manifest['review_policy'], 'folder-approval')
            self.assertEqual(manifest['review_counts'], {'approved': 1, 'draft': 1})
            rows = {row['civitai_id']: row for row in map(json.loads, (directory / 'data/catalog.jsonl').read_text().splitlines())}
            row = rows['123']
            self.assertEqual(rows['124']['review_status'], 'draft')
            self.assertEqual(row['tags'], ['dancing', 'woman'])
            self.assertEqual(row['review_status'], 'approved')
            self.assertEqual((row['quality'], row['audio_sync'], row['intensity']), (4, True, 3))
            return dict(url='https://huggingface.co/datasets/tester/example', commit='abc', videos=2, variants=2, scripts=4)
        with patch('sam3d_funscript.dataset_upload.publish_dataset', side_effect=publish) as published:
            self.upload.run(self.folder, 'tester/example')
        published.assert_called_once()
        done = DatasetUpload(self.store.root).read(self.folder)
        self.assertEqual(done['job']['stage'], 'complete')
        self.assertEqual(done['last_upload'], done['job'])
        self.assertFalse(done['busy'])
        self.assertFalse(paths[0].exists(), 'Temporary export is cleaned up')
        for path, data in original.items():
            self.assertEqual(path.read_bytes(), data, str(path))

    def test_background_worker_does_not_block_and_rejects_duplicate(self):
        self.clip()
        entered, finish = threading.Event(), threading.Event()
        def publish(*args):
            entered.set()
            if not finish.wait(5):
                raise RuntimeError('Test timed out')
            raise RuntimeError('Simulated upload failure')
        with patch('sam3d_funscript.dataset_upload.publish_dataset', side_effect=publish):
            state = self.upload.start(self.folder, 'tester/example')
            try:
                self.assertTrue(state['busy'])
                self.assertTrue(entered.wait(5))
                with self.assertRaises(PlanConflict):
                    self.upload.start(self.folder, 'tester/example')
            finally:
                finish.set()
                for worker in threading.enumerate():
                    if worker.name == 's3f-dataset-upload':
                        worker.join(5)
        self.assertEqual(self.upload.read(self.folder)['job']['stage'], 'error')
        self.assertFalse(self.upload.read(self.folder)['busy'])

    def test_empty_snapshot_does_not_publish(self):
        self.start()
        with patch('sam3d_funscript.dataset_upload.publish_dataset') as publish:
            self.upload.run(self.folder, 'tester/example')
        publish.assert_not_called()
        self.assertEqual(self.upload.read(self.folder)['job']['stage'], 'empty')
        self.assertFalse(self.upload.read(self.folder)['busy'])

    def test_metadata_only_workspace_still_uploads(self):
        _, _, session = self.clip(audio_sync=True)
        self.store.editors.path(session).unlink()
        self.start()
        def publish(directory, repo):
            manifest = validate_snapshot(directory)
            self.assertEqual((manifest['videos'], manifest['variants'], manifest['scripts']), (1, 0, 0))
            self.assertTrue(json.loads((directory / 'data/videos.jsonl').read_text())['audio_sync'])
            return dict(commit='metadata', videos=1, variants=0, scripts=0)
        with patch('sam3d_funscript.dataset_upload.publish_dataset', side_effect=publish) as published:
            self.upload.run(self.folder, 'tester/example')
        published.assert_called_once()
        self.assertEqual(self.upload.read(self.folder)['job']['stage'], 'complete')

    def test_failure_preserves_last_success_and_settings(self):
        self.clip(approved=True)
        self.start()
        def publish(directory, repo):
            self.assertEqual(validate_snapshot(directory)['review_counts'], {'approved': 1})
            return dict(commit='abc')
        with patch('sam3d_funscript.dataset_upload.publish_dataset', side_effect=publish):
            self.upload.run(self.folder, 'tester/example')
        previous = self.upload.read(self.folder)['last_upload']
        self.assertIsNotNone(previous)
        self.start()
        with patch('sam3d_funscript.dataset_upload.build_dataset', side_effect=OSError('Disk full')):
            self.upload.run(self.folder, 'tester/example')
        state = self.upload.read(self.folder)
        self.assertEqual(state['last_upload'], previous)
        self.assertEqual(state['job']['error'], 'Disk full')
        self.assertTrue(state['use_folder_approval'])
        self.assertFalse(state['busy'])
        self.assertEqual(list(self.upload.directory.glob('snapshot-*')), [])

    def test_restart_reports_interrupted_and_allows_retry(self):
        self.start()
        RUNNING.discard((str(self.store.root), self.folder))
        self.assertEqual(DatasetUpload(self.store.root).read(self.folder)['job']['stage'], 'interrupted')
        self.assertEqual(self.start()['job']['stage'], 'building')

    def test_legacy_setting_cannot_force_approved_scripts_to_draft(self):
        self.clip(approved=True)
        self.upload.directory.mkdir()
        self.upload.path(self.folder).write_text(json.dumps(dict(
            repo='tester/example', use_folder_approval=False, job={'stage': 'idle'}, last_upload=None)))
        self.assertTrue(self.upload.read(self.folder)['use_folder_approval'])
        self.start()
        def publish(directory, repo):
            self.assertEqual(validate_snapshot(directory)['review_counts'], {'approved': 1})
            return dict(commit='abc')
        with patch('sam3d_funscript.dataset_upload.publish_dataset', side_effect=publish):
            self.upload.run(self.folder, 'tester/example')
        self.assertEqual(self.upload.read(self.folder)['job']['stage'], 'complete')

    def test_invalid_settings_or_missing_login_do_not_start_worker(self):
        with patch('sam3d_funscript.dataset_upload.threading.Thread') as worker:
            for repo in (None, '', 'dataset', '../somewhere', 'https://huggingface.co/datasets/tester/test'):
                with self.assertRaises(ValueError):
                    self.upload.start(self.folder, repo)
            with patch('sam3d_funscript.dataset_upload.credentials', return_value=dict(available=True, authenticated=False)):
                with self.assertRaisesRegex(ValueError, 'hf auth login'):
                    self.upload.start(self.folder, 'tester/example')
            worker.assert_not_called()
        self.assertFalse(self.upload.path(self.folder).exists())


if __name__ == '__main__':
    unittest.main()
