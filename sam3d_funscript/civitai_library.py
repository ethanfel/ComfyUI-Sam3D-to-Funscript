"""Civitai video discovery and category downloads, joined to the local folder library."""
from pathlib import Path
from urllib.parse import urlencode, urlsplit, urlunsplit, parse_qsl
from urllib.request import Request, build_opener, HTTPRedirectHandler
from urllib.error import HTTPError, URLError
import copy
import json
import os
import re
import threading
import time
import unicodedata
import uuid

from .folder_store import FolderStore, LOCK, editing_session, identity
from .reference import atomic_json
from .video import fingerprint
from .civitai_review import CivitaiReview, STAGING

SITES = ('civitai.red', 'civitai.com', 'civitaired.com')
SORTS = ('Most Reactions', 'Most Comments', 'Most Collected', 'Newest', 'Oldest')
PERIODS = ('AllTime', 'Year', 'Month', 'Week', 'Day')
ALL_RATINGS = 1 | 2 | 4 | 8 | 16  # PG, PG-13, R, X, XXX; excludes Blocked.
MEDIA_HOSTS = {'image.civitai.com', 'image.civitai.red', 'blobs-b2.civitai.com'}
MAX_VIDEO_BYTES = 4 * 1024**3
DOWNLOADS = {}
DOWNLOAD_LOCK = threading.Lock()
ID_PATTERN = re.compile(r'(?:^|_)civitai_([1-9]\d*)(?:_|\.)', re.I)


def video_id(value):
    value = str(value)
    if not re.fullmatch(r'[1-9]\d{0,15}', value) or int(value) > 2**53-1:
        raise ValueError('Invalid Civitai video ID.')
    return value


def safe_name(value):
    name = re.sub(r'[\x00-\x1f\x7f<>:"/\\|?*]', '_', unicodedata.normalize('NFC', str(value))).strip('. ')[:140].rstrip('. ')
    return name or 'video'


def category_name(value):
    if not isinstance(value, str) or not value or len(value) > 500 or value.startswith(('/', '~')):
        raise ValueError('Choose a category folder inside your library.')
    parts = value.split('/')
    if any(not p or p.startswith('.') or safe_name(p) != p for p in parts):
        raise ValueError('Category folders must use ordinary names, without . or .. segments.')
    return '/'.join(parts)


def media_url(value, *, redirect=False):
    if not isinstance(value, str): raise ValueError('Civitai did not return a video URL.')
    url = urlsplit(value)
    hosts = MEDIA_HOSTS if redirect else MEDIA_HOSTS - {'blobs-b2.civitai.com'}
    if url.scheme != 'https' or url.hostname not in hosts or url.username or url.password or url.port not in (None, 443):
        raise ValueError('Unsupported Civitai media address.')
    return value


def download_urls(raw):
    """Preserve the API's original; never silently save a small gallery preview."""
    media_url(raw)
    url = urlsplit(raw); parts = url.path.split('/')
    transforms={'width','height','quality','original','transcode','optimized','anim','blur','fit'}
    url=url._replace(query=urlencode([(k,v) for k,v in parse_qsl(url.query,keep_blank_values=True) if k not in transforms]))
    if len(parts) < 4 or not re.match(r'(?:width|height|quality|original|transcode|optimized|anim|blur|fit)=', parts[-2]):
        raise ValueError('Unsupported Civitai video delivery URL.')
    options = dict(part.split('=', 1) for part in parts[-2].split(',') if '=' in part)
    result = []
    if options == {'original':'true'}: result.append((urlunsplit(url._replace(fragment='')), 'original'))
    for delivery, kind in [('original=true', 'original'), ('original=true,quality=100', 'original'),
                           ('transcode=true,original=true,quality=100', 'fullsize')]:
        candidate = urlunsplit(url._replace(path='/'.join([*parts[:-2], delivery, parts[-1]]), fragment=''))
        if (candidate, kind) not in result: result.append((candidate, kind))
    return result


def poster_url(raw):
    try:
        media_url(raw); url=urlsplit(raw); parts=url.path.split('/')
        if len(parts)<4:return None
        return urlunsplit(url._replace(path='/'.join([*parts[:-2], 'width=360,anim=false', parts[-1]])))
    except ValueError:return None


class CheckedRedirects(HTTPRedirectHandler):
    def __init__(self, media): self.media=media
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not self.media: raise ValueError('Civitai redirected its API. Choose the current site address in the browser settings.')
        media_url(newurl, redirect=True)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def open_remote(url, *, token=None, media=False):
    headers={'Accept':'*/*' if media else 'application/json', 'User-Agent':'SAM3D-Funscript-Civitai/1.0'}
    if token and not media:headers['Authorization']='Bearer '+token
    try:return build_opener(CheckedRedirects(media)).open(Request(url, headers=headers), timeout=30)
    except HTTPError as error:
        retry=error.headers.get('Retry-After')
        message=f'Civitai returned HTTP {error.code}.'
        if error.code in (401,403):message+=' Check access on the selected site or set your Civitai API key.'
        if error.code in (429,503):message+=f' Retry after {retry} seconds.' if retry and retry.isdigit() else ' Wait briefly before retrying.'
        raise ValueError(message) from error
    except (URLError,TimeoutError) as error:raise ValueError('Could not reach Civitai. Check the connection and retry.') from error


def fetch_json(url, token=None):
    with open_remote(url, token=token) as response:
        data=response.read(8*1024**2+1)
    if len(data)>8*1024**2:raise ValueError('The Civitai response was too large.')
    try:return json.loads(data)
    except (ValueError,UnicodeError) as error:raise ValueError('Civitai returned a web page instead of API data. Open the site to check access, or try the other site address.') from error


def transfer_video(url, path, progress):
    media_url(url); started=time.monotonic(); size=0
    with open_remote(url, media=True) as response, path.open('xb') as output:
        total=int(response.headers.get('Content-Length') or 0)
        if total>MAX_VIDEO_BYTES:raise ValueError('This video exceeds the 4 GB download limit.')
        while True:
            chunk=response.read(256*1024)
            if not chunk:break
            size+=len(chunk)
            if size>MAX_VIDEO_BYTES or time.monotonic()-started>900:raise ValueError('The video exceeded the download size or time limit.')
            output.write(chunk);progress(size,total)
        output.flush();os.fsync(output.fileno())
    if not size or total and size!=total:raise ValueError('The video download was incomplete. Retry it.')


def video_extension(path):
    import av
    # Reject HTML, still images, and damaged containers before exposing a library clip.
    with path.open('rb') as file:header=file.read(4096)
    if len(header)<12:raise ValueError('The download is not a video container.')
    if header[4:8]==b'ftyp':
        brands=header[8:min(int.from_bytes(header[:4],'big'),len(header))]
        if any(b in brands for b in (b'avif',b'avis',b'heic',b'heix',b'mif1',b'msf1')):
            raise ValueError('Civitai returned a still image instead of a video.')
    elif not header.startswith(b'\x1aE\xdf\xa3') and not (header.startswith(b'RIFF') and header[8:12]==b'AVI '):
        raise ValueError('The download is not a supported video container.')
    with av.open(str(path)) as container:
        if not container.streams.video:raise ValueError('The downloaded file has no video stream.')
        formats=set(container.format.name.split(','))
        if not formats.intersection({'mov','mp4','matroska','webm','avi'}):raise ValueError('The server did not return a supported video container.')
        stream=container.streams.video[0]
        if next(container.decode(stream),None) is None:raise ValueError('The downloaded video could not be decoded.')
    return 'mp4' if 'mov' in formats or 'mp4' in formats else 'avi' if 'avi' in formats else 'webm' if b'webm' in header else 'mkv'


class CivitaiLibrary:
    def __init__(self, root):
        self.root=Path(root);self.folders=FolderStore(root)

    def thumbnail(self, folder, clip):
        """Cache one small preview on demand without opening a processing session."""
        import av
        import cv2
        self.folders.read(folder)
        if not isinstance(clip, str) or not re.fullmatch(r'[a-f0-9]{32}', clip):
            raise ValueError('Invalid clip ID.')
        target=self.root/'civitai'/'thumbnails'/folder/(clip+'.jpg')
        if target.is_file():return target
        _,source=self.folders.entry(folder,clip)
        with av.open(str(source)) as container:
            if not container.streams.video:raise ValueError('This file has no video stream.')
            stream=container.streams.video[0]
            stream.codec_context.thread_count=2
            frame=next(container.decode(stream),None)
            if frame is None:raise ValueError('No preview frame in this video.')
            scale=min(1,360/max(frame.width,frame.height))
            pixels=frame.reformat(width=max(1,round(frame.width*scale)),height=max(1,round(frame.height*scale))).to_ndarray(format='bgr24')
        okay,encoded=cv2.imencode('.jpg',pixels,[cv2.IMWRITE_JPEG_QUALITY,80])
        if not okay:raise ValueError('Could not create the video thumbnail.')
        target.parent.mkdir(parents=True,exist_ok=True)
        temporary=target.with_name('.'+uuid.uuid4().hex+'.tmp')
        try:
            temporary.write_bytes(encoded.tobytes())
            os.replace(temporary,target)
        finally:temporary.unlink(missing_ok=True)
        return target

    def settings_path(self, folder):
        self.folders.path(folder)
        return self.root/'civitai'/f'{folder}.json'

    def settings(self, folder):
        path=self.settings_path(folder)
        return json.loads(path.read_text()) if path.is_file() else {'categories':[], 'ignored':[]}

    def token(self):
        path=self.root/'civitai'/'api-key'
        return path.read_text().strip() if path.is_file() else os.environ.get('CIVITAI_API_TOKEN','').strip()

    def set_token(self, token):
        if not isinstance(token,str) or len(token)>8192 or '\n' in token or '\r' in token:raise ValueError('Invalid API key.')
        path=self.root/'civitai'/'api-key';path.parent.mkdir(parents=True,exist_ok=True)
        if not token.strip():path.unlink(missing_ok=True)
        else:
            temporary=path.with_name('key-'+uuid.uuid4().hex)
            try:
                with os.fdopen(os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'w') as out:out.write(token.strip())
                os.replace(temporary,path)
            finally:temporary.unlink(missing_ok=True)
        return {'configured':bool(self.token())}

    def catalogue(self, folder):
        from .folder_queue import FolderQueue
        CivitaiReview(self).recover(folder)
        listing=self.folders.scan(folder);settings=self.settings(folder);index={};categories=set(settings['categories'])
        for entry in listing['entries']:
            match=ID_PATTERN.search(Path(entry['name']).name)
            parent=Path(entry['name']).parent.as_posix()
            if parent!='.' and not parent.startswith(STAGING+'/'):categories.add(parent)
            if not match:continue
            row=copy.deepcopy(entry);row['category']=entry['category_hint'] if entry.get('civitai_temporary') else '' if parent=='.' else parent
            state=self.folders.plans.read(row['timeline']) if row['draft'] and not row['existing'] else None
            row['processed']=bool(row['existing'] or row['batch_result']=='ready' or state and state.get('project_path') and not state.get('editor_only'))
            index.setdefault(match.group(1),[]).append(row)
        with DOWNLOAD_LOCK:downloads={key[1]:dict(value) for key,value in DOWNLOADS.items() if key[0]==folder}
        return {'folder':folder,'root':listing['root'],'items':index,'categories':sorted(categories,key=str.casefold),
                'ignored':settings['ignored'],'downloads':downloads,'token_configured':bool(self.token()),'recursive':listing['recursive'],
                'queue':FolderQueue(self.root).read(folder)}

    def add_category(self, folder, name):
        name=category_name(name)
        with LOCK:
            self.folders.read(folder);settings=self.settings(folder)
            if name not in settings['categories']:settings['categories'].append(name)
            path=self.settings_path(folder);path.parent.mkdir(parents=True,exist_ok=True);atomic_json(path,settings)
        return self.catalogue(folder)

    def ignore(self, folder, identifier, ignored):
        identifier=video_id(identifier)
        if not isinstance(ignored,bool):raise ValueError('Choose ignore or restore.')
        with LOCK:
            self.folders.read(folder);settings=self.settings(folder)
            entries=self.catalogue(folder)['items'].get(identifier,[])
            for entry in entries:
                with editing_session(entry['timeline']):pass
            for entry in entries:self.folders.ignore(folder,entry['id'],ignored,entry['note'])
            settings['ignored']=[i for i in settings['ignored'] if i!=identifier]
            if ignored:settings['ignored'].append(identifier)
            path=self.settings_path(folder);path.parent.mkdir(parents=True,exist_ok=True);atomic_json(path,settings)
        return self.catalogue(folder)

    @staticmethod
    def query(options):
        site=options.get('site','civitai.red');sort=options.get('sort','Most Reactions');period=options.get('period','Month')
        if site not in SITES or sort not in SORTS or period not in PERIODS:raise ValueError('Choose a supported Civitai site, sort and period.')
        level=options.get('browsingLevel',ALL_RATINGS)
        if type(level) is not int or not 1<=level<=ALL_RATINGS:raise ValueError('Choose a supported Civitai content rating.')
        query={'type':'video','limit':24,'sort':sort,'period':period,'browsingLevel':level}
        for name in ('username','cursor','modelId','modelVersionId','imageId'):
            value=options.get(name)
            if value not in (None,''):
                if not isinstance(value,(str,int)) or len(str(value))>500:raise ValueError('Invalid Civitai filter.')
                query[name]=video_id(value) if name.endswith('Id') else str(value)
        return site,query

    @staticmethod
    def record(raw, site):
        if not isinstance(raw,dict) or raw.get('type')!='video':return None
        try:identifier=video_id(raw['id']);url=media_url(raw['url'])
        except (ValueError,KeyError):return None
        stats=raw.get('stats') if isinstance(raw.get('stats'),dict) else {}
        return {'id':identifier,'username':str(raw.get('username') or '')[:140], 'url':url,'poster':poster_url(url),
                'page':f'https://{site}/images/{identifier}','width':raw.get('width'),'height':raw.get('height'),
                'created_at':str(raw.get('createdAt') or ''),'stats':{k:v for k,v in stats.items() if isinstance(v,(int,float))}}

    def browse(self, folder, options):
        self.folders.read(folder);site,query=self.query(options)
        data=fetch_json(f'https://{site}/api/v1/images?'+urlencode(query), self.token())
        if not isinstance(data,dict) or not isinstance(data.get('items'),list):raise ValueError('Civitai returned an unexpected response.')
        items=[record for raw in data['items'] if (record:=self.record(raw,site))]
        # Do not re-sort results locally: Civitai defines ranking and cursor order.
        metadata=data.get('metadata') if isinstance(data.get('metadata'),dict) else {}
        cursor=metadata.get('nextCursor')
        if cursor is not None and (not isinstance(cursor,(str,int)) or len(str(cursor))>500):raise ValueError('Civitai returned an invalid page cursor.')
        return {'items':items,'next_cursor':cursor,'library':self.catalogue(folder)}

    def download(self, folder, identifier, category, site='civitai.red'):
        identifier=video_id(identifier);category=category_name(category) if category else ''
        if site not in SITES:raise ValueError('Invalid Civitai site.')
        key=(folder,identifier)
        with DOWNLOAD_LOCK:
            if DOWNLOADS.get(key,{}).get('state')=='downloading':raise ValueError('This video is already downloading.')
            DOWNLOADS[key]={'state':'downloading','bytes':0,'total':0}
        temporary=None
        def progress(size,total):
            with DOWNLOAD_LOCK:DOWNLOADS[key].update(bytes=size,total=total)
        try:
            library=self.catalogue(folder)
            if identifier in library['items']:
                entries=library['items'][identifier];entry=next((e for e in entries if e['category']==category),entries[0])
                return {'entry':entry,'reused':True}
            if not library['recursive']:raise ValueError('Enable include_subfolders on the Folder node before downloading into categories.')
            if identifier in library['ignored']:raise ValueError('Restore this ignored video before downloading it.')
            root=Path(library['root']).resolve();destination=root/STAGING/identifier
            if not destination.resolve().is_relative_to(root):raise ValueError('The category points outside the library.')
            destination.mkdir(parents=True,exist_ok=True)
            # Exact-ID lookups also default to PG without an explicit rating filter.
            data=fetch_json(f'https://{site}/api/v1/images?'+urlencode({'type':'video','limit':1,'imageId':identifier,'browsingLevel':ALL_RATINGS}),self.token())
            if not isinstance(data,dict) or not isinstance(data.get('items'),list):raise ValueError('Civitai returned an unexpected response.')
            record=next((self.record(r,site) for r in data['items'] if isinstance(r,dict) and str(r.get('id'))==identifier),None)
            if not record:raise ValueError('Civitai did not return this video. Check its availability and your account access.')
            if not destination.resolve().is_relative_to(root):raise ValueError('The category points outside the library.')
            temporary=destination/('.s3f-download-'+uuid.uuid4().hex+'.part');last_error=None
            for url,kind in download_urls(record['url']):
                try:
                    transfer_video(url,temporary,progress);extension=video_extension(temporary);break
                except (ValueError,OSError) as error:
                    last_error=error;temporary.unlink(missing_ok=True)
                    cause=getattr(error,'__cause__',None)
                    if isinstance(cause,HTTPError) and cause.code not in (404,415,422):raise
            else:raise ValueError(f'Could not download a full-size video: {last_error}')
            creator=safe_name(record['username'])+'_' if record['username'] else ''
            target=destination/f'{creator}civitai_{identifier}_{kind}.{extension}'
            with LOCK:
                # Reserve the name, then replace only our own empty file. CIFS
                # shares can allow ordinary writes/renames but reject hard links.
                # Keep scans out until the complete file and its record are ready.
                with target.open('xb'):pass
                try:os.replace(temporary,target)
                except BaseException:
                    target.unlink(missing_ok=True)
                    raise
                temporary=None
                state=self.folders.read(folder);source=fingerprint(target);clip=identity(source)
                state.setdefault('civitai',{})[clip]={'id':identifier,'name':target.relative_to(root).as_posix(),
                    'source':source,'temporary':True,'category':category,'state':'pending'}
                self.folders.write(state)
            if category:self.add_category(folder,category)
            entries=self.catalogue(folder)['items'].get(identifier,[])
            entry=next((e for e in entries if e['name']==target.relative_to(root).as_posix()),None)
            if not entry:raise ValueError('Video saved. Refresh the folder to open it.')
            return {'entry':entry,'reused':False,'source_kind':kind}
        except Exception as error:
            with DOWNLOAD_LOCK:DOWNLOADS[key].update(state='error',error=str(error))
            raise
        finally:
            if temporary:temporary.unlink(missing_ok=True)
            with DOWNLOAD_LOCK:
                if DOWNLOADS[key]['state']=='downloading':DOWNLOADS[key]['state']='complete'
