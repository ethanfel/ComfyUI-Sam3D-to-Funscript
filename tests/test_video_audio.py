"""Audio extraction keeps presentation timing without loading video frames."""
from fractions import Fraction
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import wave

import av
import numpy as np

from sam3d_funscript.video_audio import extract_video_audio


def audio_video(path, starts=(16000, 18000)):
    """A silent video and two audio chunks, with a delayed start and a real gap."""
    with av.open(str(path), 'w') as output:
        video = output.add_stream('ffv1', rate=1)
        video.width, video.height, video.pix_fmt = 16, 16, 'yuv420p'
        audio = output.add_stream('pcm_s16le', rate=8000)
        audio.layout = 'mono'
        for packet in video.encode(av.VideoFrame.from_ndarray(np.zeros((16, 16, 3), np.uint8), format='rgb24')):
            output.mux(packet)
        for start in starts:
            frame = av.AudioFrame.from_ndarray(np.full((1, 1000), 8000, np.int16), format='s16', layout='mono')
            frame.sample_rate, frame.pts, frame.time_base = 8000, start, Fraction(1, 8000)
            for packet in audio.encode(frame):
                output.mux(packet)
        for stream in (video, audio):
            for packet in stream.encode():
                output.mux(packet)


class VideoAudioTests(unittest.TestCase):
    def test_delayed_audio_resampling_and_timestamp_gap(self):
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / 'source.mkv'
            audio_video(source)
            result, offset = extract_video_audio(source, Path(temp) / 'cache')
            self.assertAlmostEqual(offset, 2000, delta=.1)
            with wave.open(str(result)) as audio:
                self.assertEqual((audio.getnchannels(), audio.getsampwidth(), audio.getframerate()), (1, 2, 11025))
                self.assertAlmostEqual(audio.getnframes() / 11025, .375, delta=.001)
                data = np.frombuffer(audio.readframes(audio.getnframes()), dtype='<i2')
            self.assertGreater(np.median(data[200:1000]), 7000)
            self.assertTrue(np.all(data[1700:2400] == 0), 'Gaps must not move subsequent beats earlier')
            self.assertGreater(np.median(data[3100:3900]), 7000)

    def test_cache_avoids_decoding_and_source_change_invalidates_it(self):
        with tempfile.TemporaryDirectory() as temp:
            source, cache = Path(temp) / 'source.mkv', Path(temp) / 'cache'
            audio_video(source, (0, 1000))
            first = extract_video_audio(source, cache)
            with patch('sam3d_funscript.video_audio.av.open', side_effect=AssertionError('Cache must not decode')):
                self.assertEqual(extract_video_audio(source, cache), first)
            import os
            stat = source.stat()
            os.utime(source, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1000000))
            second = extract_video_audio(source, cache)
            self.assertNotEqual(first[0], second[0])
            self.assertEqual(first[0].read_bytes(), second[0].read_bytes())

    def test_decode_failure_cleans_temporary_files(self):
        with tempfile.TemporaryDirectory() as temp:
            source, cache = Path(temp) / 'bad.mp4', Path(temp) / 'cache'
            source.write_bytes(b'not a video')
            with self.assertRaisesRegex(ValueError, 'Could not decode'):
                extract_video_audio(source, cache)
            self.assertEqual(list(cache.iterdir()), [])


if __name__ == '__main__':
    unittest.main()
