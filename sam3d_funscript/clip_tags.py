"""Editable clip tags and optional CPU image tagging. No media is sent online."""
import csv
import math
import threading
import unicodedata
from pathlib import Path
from urllib.parse import urlencode

MODEL = 'SmilingWolf/wd-swinv2-tagger-v3'
MODEL_REVISION = '627aef95638667ddcaa3ac8ae625e88ea5b02f51'
MODEL_LOCK = threading.Lock()


def normalize_tags(value):
    if not isinstance(value, list) or len(value) > 500:
        raise ValueError('Use a list of at most 500 tags.')
    result = set()
    for tag in value:
        if not isinstance(tag, str) or len(tag) > 120:
            raise ValueError('Each tag must be text of up to 120 characters.')
        tag = ' '.join(unicodedata.normalize('NFKC', tag).lower().replace('_', ' ').split())
        if any(ord(c) < 32 for c in tag): raise ValueError('Invalid tag text.')
        if tag: result.add(tag)
    return sorted(result)


def tag_fields(decision):
    sources = decision.get('tag_sources', {})
    excluded = set(decision.get('tag_excluded', []))
    effective = {source: sorted(set(tags) - excluded) for source, tags in sources.items()}
    manual = decision.get('tags_manual', [])
    if manual: effective['manual'] = sorted(set(manual))
    tags = sorted({tag for values in effective.values() for tag in values})
    return dict(tags=tags, tag_sources=effective)


def edit_tags(decision, tags):
    tags = set(normalize_tags(tags))
    automatic = {tag for values in decision.get('tag_sources', {}).values() for tag in values}
    decision['tags_manual'] = sorted(tags)
    decision['tag_excluded'] = sorted((set(decision.get('tag_excluded', [])) | (automatic - tags)) - tags)


def civitai_tags(identifier, site, token):
    from .civitai_library import SITES, fetch_json, video_id
    if site not in SITES: raise ValueError('Choose a supported Civitai site.')
    identifier = video_id(identifier)
    import json
    query = urlencode({'input': json.dumps({'json': {'id': int(identifier), 'type': 'image', 'take': 100}})})
    payload = fetch_json(f'https://{site}/api/trpc/tag.getVotableTags?{query}', token)
    try:
        data = payload['result']['data']
        if isinstance(data, dict): data = data['json']
        if not isinstance(data, list): raise TypeError()
        return normalize_tags([tag['name'] for tag in data if isinstance(tag, dict) and isinstance(tag.get('name'), str)])
    except (KeyError, TypeError) as error:
        raise ValueError('Civitai did not return tag data. Its tag API may have changed.') from error


def model_directory():
    import folder_paths
    return Path(folder_paths.models_dir) / 'taggers' / 'wd-swinv2-tagger-v3'


class ImageTagger:
    def __init__(self):
        try:
            import onnxruntime as ort
            from huggingface_hub import hf_hub_download
        except ImportError as error:
            raise ValueError('Local tagging needs requirements-tagging.txt installed in ComfyUI’s Python environment.') from error
        directory = model_directory()
        directory.mkdir(parents=True, exist_ok=True)
        for name in ('selected_tags.csv', 'model.onnx'):
            if not (directory / name).is_file():
                hf_hub_download(MODEL, name, revision=MODEL_REVISION, local_dir=directory)
        with (directory / 'selected_tags.csv').open(newline='', encoding='utf-8') as file:
            self.labels = list(csv.DictReader(file))
        options = ort.SessionOptions(); options.intra_op_num_threads = 2; options.inter_op_num_threads = 1
        self.model = ort.InferenceSession(str(directory / 'model.onnx'), sess_options=options, providers=['CPUExecutionProvider'])
        self.input = self.model.get_inputs()[0]
        self.size = self.input.shape[1]

    def predict(self, image, threshold):
        import numpy as np
        from PIL import Image
        side = max(image.size)
        canvas = Image.new('RGB', (side, side), 'white')
        canvas.paste(image.convert('RGB'), ((side-image.width)//2, (side-image.height)//2))
        pixels = np.asarray(canvas.resize((self.size, self.size), Image.Resampling.BICUBIC), dtype=np.float32)
        scores = self.model.run(None, {self.input.name: pixels[None, :, :, ::-1].copy()})[0][0]
        if len(scores) != len(self.labels): raise ValueError('The tagger model and label file do not match.')
        return normalize_tags([row['name'] for row, score in zip(self.labels, scores) if row['category'] == '0' and math.isfinite(float(score)) and score >= threshold])


def sample_images(path, count):
    import av
    # Some downloaded MP4s contain non-UTF-8 comments. These text fields are
    # irrelevant to tagging; tolerate them without changing the video itself.
    with av.open(str(path), metadata_errors='replace') as container:
        stream = container.streams.video[0]; stream.codec_context.thread_count = 2
        first = next(container.decode(stream), None)
        if first is None: raise ValueError('This video has no decodable image.')
        yield first.to_image()
        if count == 1: return
        duration = float(stream.duration * stream.time_base) if stream.duration else (container.duration or 0) / av.time_base
        if duration <= 0: raise ValueError('Cannot sample three frames without a video duration; choose First frame.')
        for fraction in (.5, .9):
            target = (stream.start_time or 0) + int(duration * fraction / stream.time_base)
            container.seek(target, stream=stream, backward=True)
            frame = None
            for candidate in container.decode(stream):
                frame = candidate
                if frame.pts is None or frame.pts >= target: break
            if frame is not None: yield frame.to_image()


def local_tags(tagger, path, frames, threshold):
    return sorted({tag for image in sample_images(path, frames) for tag in tagger.predict(image, threshold)})
