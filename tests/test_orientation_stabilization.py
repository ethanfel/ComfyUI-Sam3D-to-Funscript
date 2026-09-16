from copy import deepcopy
from fractions import Fraction
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import av
import cv2
import numpy as np

from sam3d_funscript.orientation import analyze_orientation, normalize_orientation, _features, _match
from sam3d_funscript.reference import run_reference, source_info, decode
from sam3d_funscript.stabilization import transform_points
from sam3d_funscript.processing_timeline import normalize_plan, run_stabilization, run_timeline
from sam3d_funscript.automatic import prepare_mask_references, run_prepared_stabilization
from test_processing_timeline import region, fake_extract


def settings(method='features', keys=None):
    return {'method': method, 'target_degrees': 0, 'keys': keys if keys is not None else [
        {'frame': 0, 'head_xywh': [96, 96, 128, 128], 'angle_degrees': 0}]}


def pictures(angles):
    rng = np.random.default_rng(43)
    base = np.zeros((320, 320, 3), np.uint8)
    for x, y, radius, brightness in rng.integers([102, 102, 1, 60], [218, 218, 8, 255], size=(220, 4)):
        cv2.circle(base, (int(x), int(y)), int(radius), (int(brightness),)*3, -1)
    frames = []
    for i, angle in enumerate(angles):
        matrix = cv2.getRotationMatrix2D((160, 160), -angle, 1+i*.002)
        matrix[:, 2] += [i*.2, i*.1]
        image = cv2.warpAffine(base, matrix, (320, 320))
        # Independently moving, unrelated detail must not become the reference.
        image[5:65, 5:65] = rng.integers(0, 255, (60, 60, 3), dtype=np.uint8)
        frames.append(image)
    return frames


def movie(path, images, times=None):
    times = times if times is not None else list(range(0, len(images)*40, 40))
    with av.open(str(path), 'w') as container:
        stream = container.add_stream('ffv1', rate=25)
        stream.width = stream.height = 320; stream.pix_fmt = 'bgr0'
        stream.time_base = stream.codec_context.time_base = Fraction(1, 1000)
        for pixels, pts in zip(images, times):
            frame = av.VideoFrame.from_ndarray(pixels, format='bgr24')
            frame.pts = pts; frame.time_base = Fraction(1, 1000)
            for packet in stream.encode(frame): container.mux(packet)
        for packet in stream.encode(): container.mux(packet)


class OrientationTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(); self.addCleanup(temp.cleanup)
        self.root = Path(temp.name); self.source = self.root/'source.mkv'

    def test_features_follow_full_rotation_and_translation_despite_background(self):
        angles = np.arange(0, 361, 15)
        movie(self.source, pictures(angles))
        info = source_info(self.source, 0, 0)
        result = analyze_orientation(info, settings())
        self.assertNotIn('held', result['quality'], result['reasons'])
        np.testing.assert_allclose(result['orientation_degrees'], angles, atol=.8)
        matrices = np.asarray(result['transform_xy'])
        # Unit scale, tracked head pivot stays in place, and its arrow is upright.
        np.testing.assert_allclose(np.linalg.det(matrices[:, :, :2]), 1, atol=1e-7)
        points = np.asarray(result['points']); upright = transform_points(points, matrices)
        np.testing.assert_allclose(upright[:, 0], points[:, 0], atol=1e-5)
        np.testing.assert_allclose(upright[:, 1, 0], upright[:, 0, 0], atol=1e-5)
        self.assertTrue(np.all(upright[:, 1, 1] < upright[:, 0, 1]))

    def test_occlusion_holds_and_recovers_and_middle_reference_works(self):
        images = pictures([0, 15, 30, 45, 60, 75, 90])
        images[2:4] = [np.zeros_like(images[0]) for _ in range(2)]
        movie(self.source, images)
        value = settings(keys=[{'frame': 4, 'head_xywh': [72, 72, 178, 178], 'angle_degrees': 60}])
        result = analyze_orientation(source_info(self.source, 0, 0), value)
        self.assertEqual(result['quality'], ['tracked', 'tracked', 'held', 'held', 'manual', 'tracked', 'tracked'])
        np.testing.assert_array_equal(result['transform_xy'][1], result['transform_xy'][2])
        np.testing.assert_allclose(result['orientation_degrees'][-2:], [75, 90], atol=1)

    def test_manual_interpolates_actual_pts_and_unwraps_across_180(self):
        movie(self.source, pictures([170, 180, 190]), [0, 40, 100])
        value = settings('manual', [
            {'frame': 0, 'head_xywh': [96, 96, 128, 128], 'angle_degrees': 170},
            {'frame': 2, 'head_xywh': [106, 100, 128, 128], 'angle_degrees': -170}])
        reference = {'transform_mode': 'orientation', 'orientation': value}
        with patch('sam3d_funscript.reference_tracker.resolve_checkpoint', side_effect=AssertionError('No CoTracker lookup')):
            manifest, output = run_reference(self.source, 0, 0, reference, None, self.root/'render')
            cached, same = run_reference(self.source, 0, 0, reference, None, self.root/'render')
        self.assertTrue(cached['cache_hit']); self.assertEqual(same, output)
        self.assertTrue(manifest['video']['exact_frame_timing'])
        np.testing.assert_allclose(manifest['data']['orientation_degrees'], [170, 178, 190])
        self.assertEqual(manifest['data']['source_times_ms'], [0, 40, 100])
        decoded = list(decode(source_info(output, 0, 0)))
        self.assertEqual([p[1] for p in decoded], [Fraction(0), Fraction(1, 25), Fraction(1, 10)])
        detector = cv2.SIFT_create(nfeatures=1800, contrastThreshold=.025)
        upright = _features(pictures([0])[0], detector, [96, 96, 128, 128])
        for frame, expected in zip(decoded, [0, 2, 0]):
            matrix, _, reason = _match(upright, _features(frame[0], detector), [96, 96, 128, 128])
            self.assertIsNotNone(matrix, reason)
            self.assertAlmostEqual(np.degrees(np.arctan2(matrix[1, 0], matrix[0, 0])), expected, delta=.8,
                                   msg='encoded head pixels must have the requested orientation')
        value['target_degrees'] = 30
        changed, _ = run_reference(self.source, 0, 0, reference, None, self.root/'render')
        self.assertNotEqual(manifest['id'], changed['id'])

    def test_validation_cancellation_and_render_before_pose_extraction(self):
        movie(self.source, pictures([0, 15, 30]))
        info = source_info(self.source, 0, 0)
        for mutate in (lambda v:v.update(target_degrees=float('nan')), lambda v:v['keys'].append(deepcopy(v['keys'][0])),
                       lambda v:v['keys'][0].update(head_xywh=[0, 0, 321, 30])):
            value = settings(); mutate(value)
            with self.assertRaises(ValueError): normalize_orientation(value, 320, 320)
        with self.assertRaisesRegex(ValueError, 'inside'):
            analyze_orientation(info, settings(keys=[{'frame': 3, 'head_xywh': [96, 96, 128, 128], 'angle_degrees': 0}]))
        class Cancelled(BaseException): pass
        with self.assertRaises(Cancelled):
            run_reference(self.source, 0, 0, {'transform_mode': 'orientation', 'orientation': settings()}, None,
                          self.root/'cancel', interrupt=lambda:(_ for _ in ()).throw(Cancelled()))
        self.assertFalse(list((self.root/'cancel').rglob('reference.json')))
        end = info['end_ms']
        plan = normalize_plan({'tracking': [region('t', 0, end)], 'stabilization': [region('s', 0, end,
            reference={'transform_mode': 'orientation', 'orientation': settings()})], 'selected_ids': ['s']}, info)
        with (patch('sam3d_funscript.reference_tracker.resolve_checkpoint', side_effect=AssertionError('No CoTracker lookup')),
              patch('sam3d_funscript.processing_timeline.current_reference_mask', side_effect=AssertionError('No mask needed'))):
            report = run_stabilization(info, plan, self.root/'timeline', None)
            self.assertEqual(report['completed_jobs'], 1)
            with patch('sam3d_funscript.processing_timeline._model_identity', return_value='fixture'), \
                 patch('sam3d_funscript.processing_timeline.extract_video', side_effect=fake_extract) as extract:
                run_timeline(info, plan, self.root/'timeline', 'model')
                self.assertTrue(str(extract.call_args.args[0]).endswith('stabilized.mp4'))
                self.assertNotEqual(str(extract.call_args.args[0]), str(self.source))
        plan['tracking'][0]['automatic'] = {'version': 1, 'suggest': True, 'people': [], 'review': []}
        prepared, report = prepare_mask_references(info, plan)
        self.assertEqual(report, {'regions': ['s'], 'errors': {}})
        with patch('sam3d_funscript.processing_timeline.run_mask_propagation', side_effect=AssertionError('No mask propagation')):
            report = run_prepared_stabilization(info, prepared, self.root/'timeline', None, report)
        self.assertFalse(report['errors'])


if __name__ == '__main__': unittest.main()
