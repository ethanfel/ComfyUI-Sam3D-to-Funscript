"""Small, file-backed audio previews on the source video's presentation clock."""
import hashlib
import json
from pathlib import Path
import tempfile
import wave

import av


def extract_video_audio(source, directory):
    source, directory = Path(source), Path(directory)
    stat = source.stat()
    identity = [str(source.resolve()), stat.st_size, stat.st_mtime_ns, 1]
    key = hashlib.sha256(json.dumps(identity).encode()).hexdigest()[:24]
    directory.mkdir(parents=True, exist_ok=True)
    path, metadata = directory / (key + '.wav'), directory / (key + '.json')
    if path.is_file() and metadata.is_file():
        return path, json.loads(metadata.read_text())['start_ms']
    with tempfile.NamedTemporaryFile(dir=directory, suffix='.wav', delete=False) as temporary:
        staging = Path(temporary.name)
    staging_metadata = staging.with_suffix('.json')
    rate, written, origin = 11025, 0, None
    try:
        with av.open(str(source)) as container, wave.open(str(staging), 'wb') as output:
            output.setparams((1, 2, rate, 0, 'NONE', 'not compressed'))
            if not container.streams.audio:
                raise ValueError('This video has no audio track. Choose a full-mix audio file instead.')
            resampler = av.AudioResampler(format='s16', layout='mono', rate=rate)

            def write(frame):
                nonlocal origin, written
                timestamp = frame.pts * frame.time_base if frame.pts is not None else None
                if origin is None:
                    origin = timestamp if timestamp is not None else 0
                start = round((timestamp - origin) * rate) if timestamp is not None else written
                # Retain real gaps instead of moving later music earlier.
                while written < start:
                    count = min(start - written, rate)
                    output.writeframesraw(bytes(count * 2))
                    written += count
                skip = max(0, written - start)
                if skip < frame.samples:
                    output.writeframesraw(frame.to_ndarray().astype('<i2', copy=False).tobytes()[skip * 2:])
                    written += frame.samples - skip

            for frame in container.decode(container.streams.audio[0]):
                for converted in resampler.resample(frame):
                    write(converted)
            for converted in resampler.resample(None):
                write(converted)
            if not written:
                raise ValueError('This video has no decodable audio. Choose a full-mix audio file instead.')
        after = source.stat()
        if (stat.st_size, stat.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
            raise ValueError('The video changed while reading its audio. Try again.')
        staging.replace(path)
        start_ms = float(origin * 1000)
        staging_metadata.write_text(json.dumps({'start_ms': start_ms}))
        staging_metadata.replace(metadata)
        return path, start_ms
    except av.error.FFmpegError as error:
        raise ValueError('Could not decode this video\'s audio. Choose a full-mix audio file instead.') from error
    finally:
        staging.unlink(missing_ok=True)
        staging_metadata.unlink(missing_ok=True)
