"""Automatic per-anchor fitting: activity changes must not flatten later motion."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

import numpy as np

from sam3d_funscript.anchors import ANCHORS
from sam3d_funscript.core import PoseSequence, build_project
from sam3d_funscript.direction import adaptive_motion
from test_core import fixture

ROOT = Path(__file__).resolve().parents[1]


def activity_fixture():
    times = np.arange(0, 16001, 40, dtype=float)
    points = np.repeat(fixture(72).points[:1], len(times), axis=0)
    late = times >= 6000
    # The hand changes activity, position and direction. Mouth moves separately.
    movement = np.c_[.35 * np.sin(times / 220), np.zeros(len(times)), np.zeros(len(times))]
    movement[late] = np.c_[np.full(late.sum(), .7), 1 + .03 * np.sin(times[late] * np.pi / 250), np.full(late.sum(), .4)]
    points[:, 0, ANCHORS['left_hand'], :] += movement[:, None]
    points[:, 0, ANCHORS['mouth'], 2] += (.06 * np.sin(times / 300))[:, None]
    return PoseSequence(times, points, np.zeros(points.shape[:-1] + (2,)),
                        np.ones((len(times), 2), bool), np.zeros(len(times), int),
                        {'duration_ms': 16040, 'source': {'path': 'synthetic.mp4'}, 'image_size': [100, 100]})


def span(project, after):
    actions = project['scripts']['L0']['actions']
    return np.ptp([a['pos'] for a in actions if a['at'] >= after])


class AdaptiveTests(unittest.TestCase):
    def test_default_hand_auto_recovers_late_motion_without_selection(self):
        sequence = activity_fixture()
        config = {'target_anchor': 'left_hand', 'smoothing_ms': 0}
        adaptive = build_project(sequence, config)
        legacy = build_project(sequence, {**config, 'axis_settings': {'L0': {'calibration': 'clip'}}})
        self.assertEqual(adaptive['config']['axis_settings']['L0']['calibration'], 'adaptive')
        self.assertLess(span(legacy, 9000), 10)
        self.assertGreater(span(adaptive, 9000), 80)
        self.assertLess(adaptive['metrics']['L0']['clipped_fraction'], .01)
        # Auto calibration for other anchors cannot inherit the hand's motion.
        for anchor in ('mouth', 'right_hand'):
            expected = build_project(sequence, {'target_anchor': anchor})
            sequence.points[:, 0, ANCHORS['left_hand']] += np.linspace(0, 20, len(sequence.times_ms))[:, None, None]
            actual = build_project(sequence, {'target_anchor': anchor})
            self.assertEqual(expected['scripts'], actual['scripts'])

    def test_stillness_and_small_jitter_do_not_become_full_scale_motion(self):
        times = np.arange(0, 12001, 40, dtype=float)
        raw = np.zeros((len(times), 6))
        active = times < 4000
        raw[active, 0] = .1 * np.sin(times[active] / 200)
        raw[~active, 0] = raw[active, 0][-1]
        _, fitted, ranges, _, _ = adaptive_motion(times, raw, raw, [(0, len(times))], [])
        mapped = fitted / ranges * 100
        self.assertLess(np.ptp(mapped[~active]), 1e-10, 'Changing calibration must not move a stationary anchor')
        raw[:, 0] = .0001 * np.sin(times / 200)
        _, fitted, ranges, _, _ = adaptive_motion(times, raw, raw, [(0, len(times))], [])
        np.testing.assert_allclose(ranges, .04)
        self.assertLess(np.ptp(fitted / ranges * 100), 1)
        raw[:, 3] = .01 * np.sin(times / 200)
        _, fitted, ranges, _, _ = adaptive_motion(times, raw, raw, [(0, len(times))], [], True)
        np.testing.assert_allclose(ranges, 10)
        self.assertLess(np.ptp(fitted / ranges * 100), 1)

    def test_smooth_direction_changes_do_not_flip_polarity(self):
        times = np.arange(0, 12001, 20, dtype=float)
        theta = times / times[-1] * np.pi
        raw = np.zeros((len(times), 6))
        raw[:, :2] = .06 * np.sin(times / 180)[:, None] * np.c_[np.cos(theta), np.sin(theta)]
        _, fitted, ranges, directions, _ = adaptive_motion(times, raw, raw, [(0, len(times))], [])
        self.assertTrue(np.all(np.sum(directions[1:] * directions[:-1], axis=1) > .99))
        positions = fitted / ranges * 100
        self.assertLess(np.max(np.abs(np.diff(positions))), 12)
        self.assertGreater(np.ptp(positions[times > 9000]), 70)

    def test_single_sample_and_nonuniform_short_spans(self):
        times = np.array([100., 500., 1800., 1900., 1910.])
        raw = np.arange(30.).reshape(5, 6) / 100
        _, fitted, ranges, _, reports = adaptive_motion(times, raw, raw, [(0, 1), (1, 2), (2, 5)], [])
        self.assertTrue(np.isfinite(fitted).all())
        self.assertEqual(fitted[0], 0)
        self.assertEqual(fitted[1], 0)
        self.assertEqual(ranges[0], .04)
        self.assertTrue(all(r['start'] < r['end'] for r in reports))

    def test_manual_calibration_and_exact_invert_still_work(self):
        sequence = activity_fixture()
        config = {'target_anchor': 'left_hand'}
        normal = build_project(sequence, config)
        inverted = build_project(sequence, {**config, 'axis_settings': {'L0': {'invert': True}}})
        self.assertEqual(inverted['scripts']['L0']['actions'],
                         [{**a, 'pos': 100 - a['pos']} for a in normal['scripts']['L0']['actions']])
        manual = build_project(sequence, {**config, 'axis_settings': {'L0': {'range': .2, 'center': 40}}})
        self.assertFalse(manual['config']['axis_settings']['L0']['auto_fit'])
        self.assertNotIn('auto_calibration', manual['metrics']['L0'])
        self.assertEqual(manual['config']['axis_settings']['L0']['range'], .2)

    def test_browser_parity_across_activity_changes_cuts_and_old_clip_mode(self):
        sequence = activity_fixture()
        sequence.times_ms += np.sin(np.arange(len(sequence.times_ms))) * 6
        sequence.valid[90:95, 0] = False
        sequence.segments[320:] = 1
        sequence.points[320:] += [5, 2, 3]
        with tempfile.TemporaryDirectory() as folder:
            paths = []
            for mode in ('adaptive', 'clip'):
                for anchor in ('left_hand', 'mouth'):
                    project = build_project(sequence, {'target_anchor': anchor, 'axis_settings': {
                        axis: {'component': 'auto', 'auto_fit': True, 'calibration': mode} for axis in ('L0', 'R0')}})
                    path = Path(folder) / f'{mode}-{anchor}.json'
                    path.write_text(json.dumps(project, allow_nan=False))
                    paths.append(str(path))
            result = subprocess.run(['node', 'tests/test_auto.mjs', *paths], cwd=ROOT, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
