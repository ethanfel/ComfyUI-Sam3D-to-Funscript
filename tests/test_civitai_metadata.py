import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

from sam3d_funscript.civitai_library import CivitaiLibrary
from sam3d_funscript.civitai_metadata import CivitaiMetadata, RUNNING, from_api, public_fields
from sam3d_funscript.folder_store import FolderStore
from sam3d_funscript.processing_store import PlanConflict


def raw(identifier, **fields):
    return dict(id=int(identifier), type='video', url='https://image.civitai.com/key/uuid/123.mp4',
                username='Public Creator', postId=77, **fields)


class CivitaiMetadataTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(); self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        videos = self.root / 'videos'; videos.mkdir()
        self.store = CivitaiMetadata(self.root / 'store')
        self.folder = FolderStore(self.store.root).prepare(str(videos))['folder']
        self.addCleanup(RUNNING.clear)

    def start(self, identifiers, force=False):
        with patch('sam3d_funscript.civitai_metadata.threading.Thread') as thread:
            result = self.store.start(self.folder, identifiers, 'civitai.red', 'test-secret', force)
        return result, thread.call_args.kwargs['args'] if thread.called else None

    def test_allowlisted_fields_persist_without_media_links_or_secrets(self):
        record = CivitaiLibrary.record(raw(123, width=640, height=960, createdAt='2026-09-01T00:00:00Z',
            baseModel='Test model', modelVersionIds=[3, '4', None, '../bad', 3], nsfwLevel=1,
            stats={'likeCount': 12, 'commentCount': 4, 'private': 42, 'heartCount': -1},
            meta={'prompt': 'PRIVATE PROMPT'}, token='SECRET'), 'civitai.red')
        self.store.save([record])
        saved = CivitaiMetadata(self.store.root).read()['123']
        public = public_fields(saved)
        self.assertEqual((public['creator_username'], public['post_id']), ('Public Creator', '77'))
        details = public['civitai_metadata']
        self.assertEqual(details['model_version_ids'], ['3', '4'])
        self.assertEqual(details['content_rating'], '1')
        self.assertEqual(details['stats'], {'likeCount': 12, 'commentCount': 4})
        self.assertEqual(details['creator_url'], 'https://civitai.red/user/Public%20Creator/images')
        for value in ('PRIVATE PROMPT', 'SECRET', 'image.civitai.com', 'token', 'meta"'):
            self.assertNotIn(value, self.store.path.read_text())

    def test_sparse_and_older_responses_do_not_erase_source_details(self):
        first = from_api(raw(123, width=640), 'civitai.red'); first['fetched_at'] = '2026-09-24'
        self.store.save([dict(id='123', metadata=first)])
        self.store.save([dict(id='123', metadata=dict(id='123', fetched_at='2026-09-25'))])
        self.store.save([dict(id='123', metadata=dict(id='123', width=1, fetched_at='2020-01-01'))])
        saved = self.store.read()['123']
        self.assertEqual((saved['creator_username'], saved['width'], saved['fetched_at']), ('Public Creator', 640, '2026-09-25'))

    def test_incremental_recovery_batches_deduplicates_and_retries_unavailable_ids(self):
        self.store.save([CivitaiLibrary.record(raw(1), 'civitai.red')])
        job, args = self.start([str(i) for i in range(1, 24)] + ['2'])
        self.assertEqual((job['total'], job['skipped']), (22, 1))
        def fetch(url, token):
            self.assertEqual(token, 'test-secret')
            query = parse_qs(urlsplit(url).query)
            self.assertEqual(query['browsingLevel'], ['31'])
            ids = query['ids'][0].split(','); self.assertLessEqual(len(ids), 20)
            return {'items': [raw(i) for i in ids if i != '5'] + [raw(999)]}
        with patch('sam3d_funscript.civitai_library.fetch_json', side_effect=fetch) as request:
            self.store.run(*args)
        self.assertEqual(request.call_count, 2)
        job = self.store.status(self.folder)
        self.assertEqual((job['stage'], job['completed']), ('complete', 22))
        self.assertEqual([error['id'] for error in job['errors']], ['5'])
        self.assertNotIn('999', self.store.read())
        job, args = self.start([str(i) for i in range(1, 24)])
        self.assertEqual((job['total'], job['skipped']), (1, 22))
        with patch('sam3d_funscript.civitai_library.fetch_json', return_value={'items': [raw(5)]}): self.store.run(*args)
        job, args = self.start([str(i) for i in range(1, 24)])
        self.assertEqual(job['stage'], 'complete'); self.assertIsNone(args)
        self.assertNotIn('test-secret', self.store.job_path(self.folder).read_text())

    def test_stop_keeps_completed_batch_and_refresh_is_explicit(self):
        job, args = self.start([str(i) for i in range(1, 23)])
        with self.assertRaises(PlanConflict): self.start(['23'])
        def fetch(url, token):
            self.store.stop(self.folder)
            return {'items': [raw(i) for i in parse_qs(urlsplit(url).query)['ids'][0].split(',')]}
        with patch('sam3d_funscript.civitai_library.fetch_json', side_effect=fetch) as request: self.store.run(*args)
        request.assert_called_once()
        self.assertEqual(self.store.status(self.folder)['stage'], 'stopped')
        self.assertEqual(len(self.store.read()), 20)
        self.assertFalse(RUNNING)
        job, args = self.start(['1'], force=True)
        self.assertEqual(job['total'], 1)
        with patch('sam3d_funscript.civitai_library.fetch_json', return_value={'items': [raw(1)]}): self.store.run(*args)

    def test_api_failure_stops_job_and_interrupted_jobs_can_be_retried(self):
        _, args = self.start([str(i) for i in range(1, 23)])
        with patch('sam3d_funscript.civitai_library.fetch_json', side_effect=ValueError('Rate limited')) as request: self.store.run(*args)
        request.assert_called_once()
        self.assertEqual(self.store.status(self.folder)['stage'], 'error')
        self.assertFalse(RUNNING)
        _, args = self.start(['1'])
        RUNNING.clear()
        self.assertEqual(self.store.status(self.folder)['stage'], 'interrupted')
        job, _ = self.start(['1'])
        self.assertEqual(job['stage'], 'running')
