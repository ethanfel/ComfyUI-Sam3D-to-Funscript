"""Neutral video fixtures: discovery, existing downloads, staging and review."""
import json
import errno
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

import av
import numpy as np

from sam3d_funscript.civitai_library import CivitaiLibrary, download_urls, video_extension, media_url, DOWNLOADS, CheckedRedirects
from sam3d_funscript.civitai_review import CivitaiReview, STAGING
from sam3d_funscript.folder_store import FolderStore
from sam3d_funscript.processing_store import PlanConflict

REMOTE='https://image.civitai.com/key/uuid/width=450/123.mp4'


class CivitaiLibraryTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.videos=self.root/'videos';self.videos.mkdir()
        self.fixture=self.root/'neutral.mp4'
        with av.open(str(self.fixture),'w') as out:
            stream=out.add_stream('libx264',rate=10);stream.width=64;stream.height=48;stream.pix_fmt='yuv420p'
            for i in range(10):
                for packet in stream.encode(av.VideoFrame.from_ndarray(np.full((48,64,3),i*20,np.uint8),format='rgb24')):out.mux(packet)
            for packet in stream.encode():out.mux(packet)
        self.library=CivitaiLibrary(self.root/'output');self.folders=self.library.folders
        self.folder=self.folders.prepare(str(self.videos))['folder'];self.review=CivitaiReview(self.library)
        self.env=patch.dict(os.environ,{'CIVITAI_API_TOKEN':''});self.env.start();self.addCleanup(self.env.stop)
        DOWNLOADS.clear();self.addCleanup(DOWNLOADS.clear)

    def local(self,name):
        path=self.videos/name;path.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(self.fixture,path);return path

    def download(self,identifier='123',category='Dance'):
        record={'id':int(identifier),'type':'video','username':'Creator','url':REMOTE}
        def transfer(url,path,progress):shutil.copy2(self.fixture,path);progress(path.stat().st_size,path.stat().st_size)
        with patch('sam3d_funscript.civitai_library.fetch_json',return_value={'items':[record]}),patch('sam3d_funscript.civitai_library.transfer_video',side_effect=transfer):
            return self.library.download(self.folder,identifier,category)

    def edit(self,entry):
        self.folders.open(self.folder,entry['id']);editor=self.folders.editors.read(entry['editor_session'])
        project=editor['project'];project['scripts']['L0']['actions']=[{'at':0,'pos':10},{'at':500,'pos':90}]
        project['timeline']['main']['L0']['edited']=True
        return self.folders.editors.save(entry['editor_session'],project,editor['revision'])

    def test_existing_userscript_downloads_and_duplicates_are_indexed_without_changes(self):
        originals=[self.local('September/Dance/A_civitai_123_original.mp4'),self.local('Other/B_civitai_123_fullsize.mp4'),self.local('C_civitai_456_playback (1).mp4')]
        scripts=originals[0].with_suffix('.funscript');scripts.write_text('{"actions":[]}')
        before={p:p.read_bytes() for p in originals+[scripts]}
        result=self.library.catalogue(self.folder)
        self.assertEqual(set(result['items']),{'123','456'});self.assertEqual(len(result['items']['123']),2)
        self.assertEqual(result['categories'],['Other','September/Dance'])
        self.assertTrue(any(e['processed'] for e in result['items']['123']))
        self.assertEqual(before,{p:p.read_bytes() for p in before})

    def test_existing_id_is_reused_without_request_or_move(self):
        path=self.local('Old/Creator_civitai_123_original.mp4')
        with patch('sam3d_funscript.civitai_library.fetch_json') as fetch:
            result=self.library.download(self.folder,'123','New')
        fetch.assert_not_called();self.assertTrue(result['reused']);self.assertEqual(result['entry']['category'],'Old');self.assertTrue(path.exists())

    def test_browsing_saves_metadata_for_every_local_copy_and_gallery_reuses_it(self):
        first=self.local('Old/Unknown_civitai_123_original.mp4')
        second=self.local('Other/Unknown_civitai_123_original.mp4')
        before={path:path.read_bytes() for path in (first,second)}
        record={'id':123,'type':'video','url':REMOTE,'username':'ActualCreator','postId':77,'width':640,'height':960}
        with patch('sam3d_funscript.civitai_library.fetch_json',return_value={'items':[record]}):
            self.library.browse(self.folder,{})
        library=CivitaiLibrary(self.library.root)
        catalogue=library.catalogue(self.folder)
        self.assertEqual((catalogue['metadata']['known'],catalogue['metadata']['total']),(1,1))
        self.assertEqual([entry['creator_username'] for entry in catalogue['items']['123']],['ActualCreator']*2)
        self.assertEqual(before,{path:path.read_bytes() for path in before})
        with patch('sam3d_funscript.civitai_library.fetch_json',return_value={'items':[record]}) as fetch:
            library.gallery(self.folder,{'id':'123','kind':'post'})
        fetch.assert_called_once()
        self.assertEqual(parse_qs(urlsplit(fetch.call_args.args[0]).query)['postId'],['77'])

    def test_api_preserves_sort_and_cursor_order_and_filters_invalid_items(self):
        data={'items':[{'id':9,'type':'video','url':REMOTE,'stats':[]},{'id':3,'type':'video','url':REMOTE},
                       {'id':1,'type':'image','url':REMOTE},{'id':2,'type':'video','url':'http://localhost/private'}],
              'metadata':{'nextCursor':'next:9'}}
        with patch('sam3d_funscript.civitai_library.fetch_json',return_value=data) as fetch:
            result=self.library.browse(self.folder,{'site':'civitai.com','sort':'Most Collected','period':'Week','cursor':'prior:4'})
        query=parse_qs(urlsplit(fetch.call_args.args[0]).query)
        self.assertEqual(query['sort'],['Most Collected']);self.assertEqual(query['cursor'],['prior:4']);self.assertEqual(query['type'],['video'])
        self.assertEqual(query['browsingLevel'],['31'])
        self.assertEqual([i['id'] for i in result['items']],['9','3']);self.assertEqual(result['next_cursor'],'next:9')

    def test_selected_ratings_and_saved_key_are_sent_on_every_page(self):
        self.library.set_token('fixture-secret')
        for level in (1,2,4,8,16,31):
            for cursor in (None,'next:9'):
                with self.subTest(level=level,cursor=cursor),patch('sam3d_funscript.civitai_library.fetch_json',return_value={'items':[]}) as fetch:
                    self.library.browse(self.folder,{'browsingLevel':level,'cursor':cursor})
                    query=parse_qs(urlsplit(fetch.call_args.args[0]).query)
                    self.assertEqual(query['browsingLevel'],[str(level)])
                    self.assertEqual(query.get('cursor'),[cursor] if cursor else None)
                    self.assertEqual(fetch.call_args.args[1],'fixture-secret')

    def test_post_gallery_resolves_local_video_and_preserves_post_on_next_page(self):
        self.library.set_token('fixture-secret')
        record={'id':123,'type':'video','url':REMOTE,'postId':77,'username':'Creator'}
        with patch('sam3d_funscript.civitai_library.fetch_json',side_effect=[{'items':[record]}, {'items':[record,{**record,'id':124}],'metadata':{'nextCursor':'next'}}]) as fetch:
            result=self.library.gallery(self.folder,{'id':'123','kind':'post','site':'civitai.com','browsingLevel':16,'sort':'Oldest','period':'Week'})
        queries=[parse_qs(urlsplit(call.args[0]).query) for call in fetch.call_args_list]
        self.assertEqual(queries[0]['imageId'],['123']);self.assertEqual(queries[1]['postId'],['77'])
        self.assertNotIn('imageId',queries[1]);self.assertEqual(queries[1]['period'],['AllTime'])
        self.assertTrue(all(q['browsingLevel']==['16'] for q in queries))
        self.assertTrue(all(call.args[1]=='fixture-secret' for call in fetch.call_args_list))
        self.assertEqual([r['id'] for r in result['items']],['123','124'])
        self.assertEqual(result['gallery']['post_id'],'77');self.assertEqual(result['next_cursor'],'next')
        with patch('sam3d_funscript.civitai_library.fetch_json',return_value={'items':[record]}) as fetch:
            self.library.gallery(self.folder,{'id':'123','kind':'post','postId':'77','cursor':'next'})
        fetch.assert_called_once();query=parse_qs(urlsplit(fetch.call_args.args[0]).query)
        self.assertEqual(query['postId'],['77']);self.assertEqual(query['cursor'],['next'])

    def test_creator_gallery_resolves_author_without_guessing_from_filename(self):
        record={'id':123,'type':'video','url':REMOTE,'postId':77,'username':'Real_Creator'}
        with patch('sam3d_funscript.civitai_library.fetch_json',side_effect=[{'items':[record]}, {'items':[{**record,'id':125,'postId':88}]}]) as fetch:
            result=self.library.gallery(self.folder,{'id':'123','kind':'creator'})
        query=parse_qs(urlsplit(fetch.call_args.args[0]).query)
        self.assertEqual(query['username'],['Real_Creator']);self.assertNotIn('postId',query)
        self.assertEqual(query['period'],['AllTime']);self.assertEqual(result['gallery']['username'],'Real_Creator')
        with patch('sam3d_funscript.civitai_library.fetch_json',return_value={'items':[]}) as fetch:
            self.library.gallery(self.folder,{'id':'123','kind':'creator','username':'Real_Creator','cursor':'next'})
        fetch.assert_called_once()

    def test_galleries_do_not_fall_back_to_unrelated_videos(self):
        record={'id':123,'type':'video','url':REMOTE}
        for data in ({'items':[]},{'items':[record]},{'items':[{**record,'id':999,'postId':77,'username':'Other'}]}):
            for kind in ('post','creator'):
                with self.subTest(data=data,kind=kind),patch('sam3d_funscript.civitai_library.fetch_json',return_value=data) as fetch,self.assertRaises(ValueError):
                    self.library.gallery(self.folder,{'id':'123','kind':kind})
                fetch.assert_called_once()
        with patch('sam3d_funscript.civitai_library.fetch_json',return_value={'items':[{**record,'postId':88}]}),self.assertRaisesRegex(ValueError,'outside the requested post'):
            self.library.gallery(self.folder,{'id':'123','kind':'post','postId':'77'})
        for options in ({'id':'123','kind':'unknown'},{'id':'../123','kind':'post'},{'id':'123','kind':'post','postId':'bad'}):
            with patch('sam3d_funscript.civitai_library.fetch_json') as fetch,self.assertRaises(ValueError):self.library.gallery(self.folder,options)
            fetch.assert_not_called()

    def test_download_lookup_does_not_fall_back_to_public_ratings(self):
        self.library.set_token('fixture-secret')
        def fetch(url,token):
            query=parse_qs(urlsplit(url).query)
            self.assertEqual(query['imageId'],['123']);self.assertEqual(token,'fixture-secret')
            return {'items':[{'id':123,'type':'video','username':'Creator','url':REMOTE}] if query.get('browsingLevel')==['31'] else []}
        def transfer(url,path,progress):shutil.copy2(self.fixture,path)
        with patch('sam3d_funscript.civitai_library.fetch_json',side_effect=fetch),patch('sam3d_funscript.civitai_library.transfer_video',side_effect=transfer):
            result=self.library.download(self.folder,'123','Dance')
        self.assertTrue(result['entry']['civitai_temporary'])

    def test_download_does_not_require_hard_links(self):
        with patch('sam3d_funscript.civitai_library.os.link',side_effect=PermissionError(errno.EACCES,'CIFS denies hard links')) as link:
            entry=self.download()['entry']
        link.assert_not_called()
        self.assertEqual((self.videos/entry['name']).read_bytes(),self.fixture.read_bytes())
        self.assertTrue(entry['civitai_temporary'])
        self.assertEqual(list(self.videos.rglob('*.part')),[])

    def test_download_preserves_a_destination_created_during_transfer(self):
        target=self.videos/STAGING/'123'/'Creator_civitai_123_original.mp4'
        record={'id':123,'type':'video','username':'Creator','url':REMOTE}
        def transfer(url,path,progress):
            shutil.copy2(self.fixture,path);target.write_bytes(b'existing file')
        with patch('sam3d_funscript.civitai_library.fetch_json',return_value={'items':[record]}),patch('sam3d_funscript.civitai_library.transfer_video',side_effect=transfer):
            with self.assertRaises(FileExistsError):self.library.download(self.folder,'123','Dance')
        self.assertEqual(target.read_bytes(),b'existing file')
        self.assertEqual(list(self.videos.rglob('*.part')),[])

    def test_failed_download_rename_removes_reservation_and_allows_retry(self):
        replace=os.replace
        def fail_publish(source,target):
            if Path(source).name.startswith('.s3f-download-'):raise PermissionError(errno.EACCES,'Rename denied')
            return replace(source,target)
        with patch('sam3d_funscript.civitai_library.os.replace',side_effect=fail_publish):
            with self.assertRaises(PermissionError):self.download()
        self.assertEqual(list((self.videos/STAGING/'123').iterdir()),[])
        self.assertEqual(DOWNLOADS[(self.folder,'123')]['state'],'error')
        entry=self.download()['entry']
        self.assertEqual((self.videos/entry['name']).read_bytes(),self.fixture.read_bytes())

    def test_bad_api_data_and_sites_fail_cleanly(self):
        for options in ({'site':'localhost'},{'sort':'garbage'},{'imageId':'../1'}):
            with self.assertRaises(ValueError):self.library.query(options)
        for level in (None,True,0,-1,32,63,1.5,'16',[]):
            with self.subTest(level=level),self.assertRaises(ValueError):self.library.query({'browsingLevel':level})
        for data in ([],{'items':None},{'items':[],'metadata':{'nextCursor':[]}}):
            with patch('sam3d_funscript.civitai_library.fetch_json',return_value=data),self.assertRaises(ValueError):self.library.browse(self.folder,{})

    def test_original_downloads_never_keep_thumbnail_transforms(self):
        urls=download_urls(REMOTE+'?width=300&token=example')
        self.assertEqual(len(urls),3);self.assertTrue(all('width=' not in u and 'token=example' in u for u,k in urls))
        self.assertTrue(urls[-1][0].endswith('transcode=true,original=true,quality=100/123.mp4?token=example'))
        for url in ('http://image.civitai.com/x','https://image.civitai.com.evil/x','https://user@image.civitai.com/x','https://localhost/x'):
            with self.assertRaises(ValueError):media_url(url)

    def test_staging_survives_restart_without_scripts_or_category_move(self):
        entry=self.download(category='')['entry'];editor=self.edit(entry)
        self.assertTrue(entry['civitai_temporary']);self.assertTrue(entry['name'].startswith(STAGING+'/123/'))
        self.assertFalse(list(self.videos.rglob('*.funscript')))
        reopened=CivitaiLibrary(self.library.root);item=reopened.catalogue(self.folder)['items']['123'][0]
        self.assertEqual(item['id'],entry['id']);self.assertTrue(item['civitai_temporary'])
        self.assertEqual(reopened.folders.editors.read(entry['editor_session']),editor)

    def test_approval_moves_video_and_exact_scripts_keeps_edits_locks_notes_and_identity(self):
        entry=self.download()['entry'];editor=self.edit(entry)
        self.folders.review(self.folder,entry['id'],4,'Keep this version')
        plan=self.folders.plans.read(entry['timeline']);plan['plan']['tracking'][0]['locked']=True;self.folders.plans.write(plan)
        old_path=self.videos/entry['name'];result=self.review.approve(self.folder,entry['id'],'Final/Dance',editor['revision'])
        self.assertFalse(old_path.exists());self.assertEqual(len(result['files']),6)
        current=result['listing']['entries'][0];self.assertEqual(current['id'],entry['id']);self.assertFalse(current['civitai_temporary']);self.assertEqual(current['quality'],4)
        self.assertEqual(current['note'],'Keep this version');self.assertEqual(current['status'],'approved')
        final=self.videos/current['name'];self.assertEqual(final.read_bytes(),self.fixture.read_bytes())
        self.assertEqual(json.loads(final.with_suffix('.funscript').read_text()),editor['project']['scripts']['L0'])
        reopened=FolderStore(self.library.root);reopened.open(self.folder,entry['id'])
        saved=reopened.editors.read(entry['editor_session'])
        self.assertEqual(saved['project']['scripts'],editor['project']['scripts']);self.assertEqual(saved['project']['metadata']['source']['path'],str(final))
        self.assertTrue(reopened.plans.read(entry['timeline'])['plan']['tracking'][0]['locked'])

    def test_approval_collision_keeps_staging_and_draft(self):
        entry=self.download()['entry'];editor=self.edit(entry)
        target=self.local('Dance/'+Path(entry['name']).name);before=target.read_bytes()
        with self.assertRaises(PlanConflict):self.review.approve(self.folder,entry['id'],'Dance',editor['revision'])
        self.assertEqual(target.read_bytes(),before);self.assertTrue((self.videos/entry['name']).exists())
        self.assertEqual(self.folders.editors.read(entry['editor_session']),editor)

    def test_approval_failure_recovers_staged_clip_and_leaves_no_partial_library_files(self):
        entry=self.download()['entry'];editor=self.edit(entry)
        with patch('sam3d_funscript.civitai_review.shutil.copyfileobj',side_effect=OSError('Disk full')),self.assertRaises(OSError):
            self.review.approve(self.folder,entry['id'],'Dance',editor['revision'])
        self.assertTrue((self.videos/entry['name']).exists());self.assertEqual(list((self.videos/'Dance').iterdir()),[])
        self.assertEqual(self.folders.editors.read(entry['editor_session'])['project']['scripts'],editor['project']['scripts'])
        result=self.review.approve(self.folder,entry['id'],'Dance',editor['revision'],True,self.folders.script_versions(self.videos/entry['name']))
        self.assertTrue(result['relocated'])

    def test_restart_rolls_back_an_uncommitted_category_transfer(self):
        entry=self.download()['entry'];editor=self.edit(entry)
        with patch('sam3d_funscript.civitai_review.shutil.copyfileobj',side_effect=KeyboardInterrupt),self.assertRaises(KeyboardInterrupt):
            self.review.approve(self.folder,entry['id'],'Dance',editor['revision'])
        self.assertTrue(self.review.journal_path(self.folder).exists())
        reopened=CivitaiLibrary(self.library.root);item=reopened.catalogue(self.folder)['items']['123'][0]
        self.assertTrue(item['civitai_temporary']);self.assertTrue((self.videos/entry['name']).exists())
        self.assertEqual(list((self.videos/'Dance').iterdir()),[])
        self.assertEqual(self.folders.editors.read(entry['editor_session'])['project']['scripts'],editor['project']['scripts'])

    def test_restart_finishes_a_committed_transfer_and_keeps_new_source(self):
        entry=self.download()['entry'];editor=self.edit(entry);recover=self.review.recover
        def interrupted_cleanup(folder):
            path=self.review.journal_path(folder)
            if path.exists() and json.loads(path.read_text())['committed']:raise KeyboardInterrupt()
            return recover(folder)
        with patch.object(self.review,'recover',side_effect=interrupted_cleanup),self.assertRaises(KeyboardInterrupt):
            self.review.approve(self.folder,entry['id'],'Dance',editor['revision'])
        reopened=CivitaiLibrary(self.library.root);item=reopened.catalogue(self.folder)['items']['123'][0]
        self.assertFalse(item['civitai_temporary']);self.assertFalse((self.videos/entry['name']).exists())
        self.assertTrue((self.videos/item['name']).exists());self.assertEqual(item['id'],entry['id'])
        reopened.folders.open(self.folder,entry['id'])
        self.assertEqual(reopened.folders.editors.read(entry['editor_session'])['project']['scripts'],editor['project']['scripts'])

    def test_reject_deletes_owned_temporary_video_but_preserves_existing_library(self):
        staged=self.download()['entry'];self.edit(staged)
        existing=self.local('Old/Creator_civitai_456_original.mp4');script=existing.with_suffix('.funscript');script.write_text('{}')
        local=self.library.catalogue(self.folder)['items']['456'][0]
        self.assertTrue(self.review.reject(self.folder,staged['id'])['deleted']);self.assertFalse((self.videos/staged['name']).exists())
        self.assertFalse(self.review.reject(self.folder,local['id'])['deleted']);self.assertTrue(existing.exists());self.assertEqual(script.read_text(),'{}')
        self.assertIn('123',self.library.catalogue(self.folder)['ignored'])

    def test_manual_file_inside_staging_is_not_owned_and_is_not_deleted(self):
        path=self.local(STAGING+'/777/X_civitai_777_original.mp4');entry=self.library.catalogue(self.folder)['items']['777'][0]
        self.assertFalse(self.review.reject(self.folder,entry['id'])['deleted']);self.assertTrue(path.exists())

    def test_ignore_restore_existing_copies_is_shared_with_folder_and_keeps_notes(self):
        self.local('Old/C_civitai_123_original.mp4');entry=self.library.catalogue(self.folder)['items']['123'][0]
        self.folders.review(self.folder,entry['id'],3,'Keep note')
        self.library.ignore(self.folder,'123',True);self.assertEqual(self.folders.scan(self.folder)['counts']['ignored'],1)
        self.library.ignore(self.folder,'123',False);self.assertEqual(self.folders.scan(self.folder)['counts']['pending'],1)
        self.assertEqual(self.folders.scan(self.folder)['entries'][0]['note'],'Keep note')

    def test_selected_bulk_only_processes_selected_unscripted_nonignored_clips(self):
        for id in ('1','2','3','4'):self.local('X_civitai_'+id+'_original.mp4')
        index=self.library.catalogue(self.folder)['items'];ids={k:v[0]['id'] for k,v in index.items()}
        (self.videos/'X_civitai_2_original.funscript').write_text(json.dumps({'actions':[{'at':0,'pos':20},{'at':1000,'pos':80}]}));self.library.ignore(self.folder,'3',True)
        visited=[];result=self.folders.process_batch(self.folder,'',lambda e:visited.append(e['id']),clip_ids=[ids['1'],ids['2'],ids['3']])
        self.assertEqual(visited,[ids['1']]);self.assertEqual(result['total'],1)
        self.assertFalse((self.videos/'X_civitai_1_original.funscript').exists())
        with self.assertRaises(PlanConflict):self.folders.batch_entries(self.folder,clip_ids=['a'*32])
        with self.assertRaises(ValueError):self.folders.batch_entries(self.folder,clip_ids=[])

    def test_failed_download_cleans_parts_and_rejects_html_and_avif(self):
        for content in (b'<html>Not a video</html>',b'\x00\x00\x00\x20ftypavif'+b'0'*40):
            file=self.root/'bad.part';file.write_bytes(content)
            with self.assertRaises(ValueError):video_extension(file)
        with patch('sam3d_funscript.civitai_library.fetch_json',return_value={'items':[{'id':123,'type':'video','url':REMOTE}]}),patch('sam3d_funscript.civitai_library.transfer_video',side_effect=lambda u,p,f:p.write_text('<html>access denied</html>')),self.assertRaises(ValueError):
            self.library.download(self.folder,'123','Dance')
        self.assertFalse(list(self.videos.rglob('*.part')));self.assertFalse(list(self.videos.rglob('*.mp4')))

    def test_category_traversal_and_symlink_escape_are_refused(self):
        for category in ('../outside','/tmp','a/../../b','.hidden','a\\b'):
            with self.assertRaises(ValueError):self.library.add_category(self.folder,category)
        (self.videos/STAGING).symlink_to(self.root,target_is_directory=True)
        with self.assertRaises(ValueError):self.download()
        self.assertFalse((self.root/'123').exists())

    def test_api_key_is_private_not_in_catalogue_and_redirects_are_restricted(self):
        self.library.set_token('fixture-secret');path=self.library.root/'civitai/api-key'
        self.assertEqual(path.stat().st_mode&0o777,0o600)
        result=self.library.catalogue(self.folder);self.assertTrue(result['token_configured']);self.assertNotIn('fixture-secret',json.dumps(result))
        with self.assertRaises(ValueError):CheckedRedirects(False).redirect_request(None,None,302,'',{},'https://elsewhere.test')
        with self.assertRaises(ValueError):CheckedRedirects(True).redirect_request(None,None,302,'',{},'http://127.0.0.1/private')
        self.assertEqual(self.library.set_token(''),{'configured':False})


if __name__=='__main__':unittest.main()
