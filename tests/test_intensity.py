import copy
import unittest

from sam3d_funscript.intensity import estimate_intensity


def wave(span=80, hz=1, seconds=20):
    return {'metadata': {'duration_ms': seconds * 1000}, 'scripts': {'L0': {'actions': [
        {'at': round(i * 500 / hz), 'pos': round(50 + (span / 2 if i % 2 else -span / 2))}
        for i in range(int(seconds * 2 * hz) + 1)]}}}


class IntensityTests(unittest.TestCase):
    def test_sustained_speed_and_stroke_range_increase_intensity(self):
        estimates = [estimate_intensity(wave(hz=hz)) for hz in (.125, .5, 1, 2)]
        self.assertEqual([e['level'] for e in estimates], [1, 3, 4, 5])
        shallow = estimate_intensity(wave(span=10, hz=2))
        self.assertLess(shallow['score'], estimates[-1]['score'] / 4)
        self.assertAlmostEqual(estimates[-1]['cycles_per_second'], 2, delta=.15)

    def test_point_density_does_not_change_the_estimate(self):
        sparse = wave(); dense = copy.deepcopy(sparse)
        points = sparse['scripts']['L0']['actions']; actions = []
        for a, b in zip(points, points[1:]):
            for part in range(10):
                actions.append({'at': a['at'] + (b['at'] - a['at']) * part / 10,
                                'pos': a['pos'] + (b['pos'] - a['pos']) * part / 10})
        dense['scripts']['L0']['actions'] = [*actions, points[-1]]
        self.assertEqual(estimate_intensity(sparse), estimate_intensity(dense))

    def test_flat_curve_and_tiny_jitter_are_very_gentle(self):
        still = wave(span=0)
        jitter = wave(span=2, hz=10)
        for project in (still, jitter):
            result = estimate_intensity(project)
            self.assertEqual((result['level'], result['score']), (1, 0))

    def test_brief_burst_does_not_rate_the_entire_clip_as_intense(self):
        burst = wave(hz=2, seconds=2)
        sustained = estimate_intensity(burst)
        burst['metadata']['duration_ms'] = 60000
        brief = estimate_intensity(burst)
        self.assertLessEqual(brief['level'], 2)
        self.assertLess(brief['score'], sustained['score'] / 5)

    def test_scene_changes_do_not_count_as_strokes(self):
        cuts = wave(span=100, hz=2)
        cut_times = [a['at'] for a in cuts['scripts']['L0']['actions'][1:-1]]
        self.assertEqual(estimate_intensity(cuts)['level'], 5)
        self.assertEqual(estimate_intensity(cuts, cut_times)['level'], 1)
        cuts['metadata']['scene_cuts'] = {'times_ms': cut_times}
        self.assertEqual(estimate_intensity(cuts)['level'], 1)

    def test_missing_or_invalid_curve_stays_unrated(self):
        for project in (None, {}, {'scripts': {'R1': {'actions': wave()['scripts']['L0']['actions']}}}):
            self.assertEqual(estimate_intensity(project)['level'], 0)
        for value in (float('nan'), float('inf'), -1, True):
            project = wave(); project['scripts']['L0']['actions'][1]['at'] = value
            self.assertEqual(estimate_intensity(project)['level'], 0)

    def test_analysis_does_not_modify_curves_or_quality(self):
        project = wave(); project['quality'] = 4; before = copy.deepcopy(project)
        estimate_intensity(project, [5000, 10000])
        self.assertEqual(project, before)


if __name__ == '__main__':
    unittest.main()
