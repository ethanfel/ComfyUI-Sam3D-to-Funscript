from fractions import Fraction
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import av
import numpy as np

from sam3d_funscript.frame_index import frame_index
from sam3d_funscript.reference import source_info, decode


def video(path, pts, rate=25, base=Fraction(1, 1000), codec='ffv1'):
    with av.open(str(path), 'w') as out:
        stream = out.add_stream(codec, rate=rate)
        stream.width, stream.height = 64, 48
        stream.pix_fmt = 'yuv420p' if codec == 'libx264' else 'bgr0'
        stream.time_base = stream.codec_context.time_base = base
        for tick in pts:
            frame = av.VideoFrame.from_ndarray(np.zeros((48, 64, 3), np.uint8), format='bgr24')
            frame.pts, frame.time_base = tick, base
            for packet in stream.encode(frame):
                out.mux(packet)
        for packet in stream.encode():
            out.mux(packet)


class FrameIndexTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)

    def test_vfr_origin_trims_and_shared_cache(self):
        path = self.root / 'vfr.mkv'
        video(path, [2000, 2030, 2100, 2120, 2200, 2250])
        info = source_info(path, Fraction(30, 1000), Fraction(220, 1000))
        result = frame_index(info, self.root / 'cache')
        self.assertEqual(result['first_frame'], 1)
        self.assertEqual(result['end_frame'], 5)
        self.assertEqual(result['times_ms'], [30, 100, 120, 200])
        self.assertEqual(result['end_ms'], 250)
        whole = source_info(path)
        with patch('sam3d_funscript.frame_index.av.open', side_effect=AssertionError('decoded again')):
            cached = frame_index(whole, self.root / 'cache')
        self.assertEqual(cached['first_frame'], 0)
        self.assertEqual(cached['end_frame'], 6)

    def test_between_frame_trim_uses_first_included_frame_not_fps_estimate(self):
        path = self.root / 'vfr.mkv'
        video(path, [0, 30, 100, 120, 200, 250])
        result = frame_index(source_info(path, Fraction(31, 1000), Fraction(190, 1000)), self.root / 'cache')
        self.assertEqual(result['first_frame'], 2)
        self.assertEqual(result['times_ms'], [100, 120, 200])
        self.assertEqual(result['end_ms'], 221)

    def test_fractional_rate_boundaries_include_exact_first_frame_and_exclude_next(self):
        path = self.root / 'fractional.mp4'
        video(path, range(12), rate=Fraction(30000, 1001), base=Fraction(1001, 30000), codec='libx264')
        info = source_info(path)
        result = frame_index(info, self.root / 'cache')
        self.assertEqual(result['end_frame'], 12)
        # Each editable one-frame region must decode that frame, even when its
        # rational PTS has no exact decimal representation (e.g. NTSC rates).
        for index in [1, 2, 7, 10]:
            a, b = result['times_ms'][index:index+2]
            frames = list(decode({**info, 'start': str(Fraction(str(a))/1000), 'duration': str((Fraction(str(b))-Fraction(str(a)))/1000)}))
            self.assertEqual(len(frames), 1)
            self.assertEqual(frames[0][2], Fraction(index * 1001, 30000))

    def test_changed_source_and_empty_trim_rejected(self):
        path = self.root / 'source.mkv'
        video(path, [0, 40, 80])
        info = source_info(path)
        frame_index(info, self.root / 'cache')
        empty = source_info(path, Fraction(1), Fraction(1))
        with self.assertRaisesRegex(ValueError, 'no source frames'):
            frame_index(empty, self.root / 'cache')
        video(path, [0, 40, 80, 120])
        with self.assertRaisesRegex(ValueError, 'changed'):
            frame_index(info, self.root / 'cache')


if __name__ == '__main__':
    unittest.main()
