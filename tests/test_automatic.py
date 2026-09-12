from copy import deepcopy
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch, Mock

import numpy as np

from sam3d_funscript.automatic import available_scenes, person_envelopes, prepare_automatic
from sam3d_funscript.processing_timeline import normalize_plan, compile_jobs
from test_processing_timeline import info, region


def sample(*boxes):
    return {'at_ms': 0, 'people': [{'box': list(box), 'confidence': .9} for box in boxes]}


class AutomaticTests(unittest.TestCase):
    def test_person_envelopes_follow_movement_and_expand_for_zoom(self):
        samples = [sample([.1, .2, .3, .6]), sample([.09, .15, .36, .7]), sample([.07, .1, .42, .8])]
        people, omitted = person_envelopes(samples)
        self.assertEqual((len(people), omitted), (1, 0))
        x, y, w, h = people[0]['roi']
        self.assertLess(x, .07); self.assertLess(y, .1)
        self.assertGreater(x+w, .42); self.assertGreater(y+h, .8)
        self.assertEqual(people[0]['coverage'], 1)
        self.assertIn('Large framing change; review crop', people[0]['review'])

    def test_two_people_keep_separate_boxes_when_detector_order_changes(self):
        left, right = [.05, .1, .4, .9], [.6, .1, .95, .9]
        people, _ = person_envelopes([sample(left, right), sample(right, left), sample(left, right)])
        self.assertEqual(len(people), 2)
        self.assertLess(people[0]['roi'][0], people[1]['roi'][0])
        self.assertEqual([p['coverage'] for p in people], [1, 1])

    def test_isolated_false_detection_is_omitted_and_missing_people_are_flagged(self):
        a, b = [.05, .1, .4, .9], [.6, .1, .95, .9]
        people, _ = person_envelopes([sample(a,b), sample(a), sample(), sample()])
        self.assertEqual(len(people), 1)
        self.assertIn('Person missing in sampled frames', people[0]['review'])
        self.assertEqual(person_envelopes([sample(), sample()]), ([], 0))

    def test_all_people_keeps_more_than_three_reliable_people(self):
        boxes = [[x, .1, x+.12, .9] for x in (.02, .22, .42, .62, .82)]
        people, omitted = person_envelopes([sample(*boxes), sample(*reversed(boxes))])
        self.assertEqual((len(people), omitted), (5, 0))

    def test_scene_partition_respects_trim_cuts_and_existing_disabled_or_locked_regions(self):
        current = info(start=1, end=4000)
        plan = normalize_plan({'tracking': [region('keep', 1800, 2400, locked=True), region('disabled', 3000, 3500, enabled=False)]}, current)
        before = deepcopy(plan)
        existing, scenes = available_scenes(current, {'times_ms': [0, 2000, 2900, 9000]}, plan)
        self.assertEqual(scenes, [(1,1000,1800), (2,2400,2900), (3,2900,3000), (3,3500,4000)])
        self.assertEqual(existing, plan['tracking']); self.assertEqual(plan, before)

    def test_only_untouched_placeholder_is_replaced(self):
        current = info(); plan = normalize_plan({}, current); cuts = {'times_ms': [2000]}
        self.assertEqual(len(available_scenes(current,cuts,plan,True)[1]), 2)
        self.assertEqual(available_scenes(current,cuts,plan,False)[1], [])
        for update in ({'smoothing_ms': 50}, {'enabled':False}, {'isolate_subject':True}, {'locked':True}, {'anchor':'mouth'}):
            changed = deepcopy(plan); changed['tracking'][0].update(update)
            self.assertEqual(available_scenes(current,cuts,changed,True)[1], [])

    def test_preparation_reuses_detections_and_keeps_four_anchors_per_person(self):
        current = info(); plan = normalize_plan({}, current)
        detector = Mock(return_value=sample([.05,.1,.4,.9], [.6,.1,.95,.9])['people'])
        def frames(*args, **kwargs):
            start = kwargs['start_seconds']*1000
            for offset in (0, 500): yield np.zeros((240,320,3),np.uint8), {'time_ms': start+offset}
        with tempfile.TemporaryDirectory() as folder, patch('sam3d_funscript.automatic.video_frames', side_effect=frames):
            cuts = {'source_id':current['source_id'], 'times_ms':[2000]}
            output, report = prepare_automatic(current,plan,cuts,folder,replace_default=True,detector=detector)
            self.assertEqual(detector.call_count,4); self.assertEqual(report['scenes_added'],2)
            for r in output['tracking']:
                self.assertTrue(r['isolate_subject'])
                self.assertEqual(r['candidate_people'], [0,1]); self.assertEqual(len([r['anchor'],*r['additional_anchors']]),4)
                for job in compile_jobs(output,current):
                    own = next(r for r in output['tracking'] if r['id']==job['region_id'])
                    self.assertGreaterEqual(job['context_start_ms'],own['start_ms']);self.assertLessEqual(job['context_end_ms'],own['end_ms'])
            again, _ = prepare_automatic(current,plan,cuts,folder,replace_default=True,detector=detector)
            self.assertEqual(detector.call_count,4);self.assertEqual(again,output)
            unchanged, r = prepare_automatic(current,output,cuts,folder,detector=detector)
            self.assertEqual(r['scenes_added'],0);self.assertEqual(unchanged,output)

    def test_no_people_produces_disabled_review_scene_not_invented_tracking(self):
        current=info();plan=normalize_plan({},current)
        def frames(*args,**kwargs):
            yield np.zeros((4,4,3),np.uint8), {'time_ms':0}
        with tempfile.TemporaryDirectory() as folder, patch('sam3d_funscript.automatic.video_frames',side_effect=frames):
            result,report=prepare_automatic(current,plan,{'source_id':current['source_id'],'times_ms':[]},folder,replace_default=True,detector=lambda _:[])
            self.assertFalse(result['tracking'][0]['enabled']);self.assertIn('No reliable person',report['review'][0]['reasons'][0])

    def test_malformed_options_and_candidate_indices_fail_before_inference(self):
        with self.assertRaisesRegex(ValueError,'another video'):
            prepare_automatic(info(),normalize_plan({},info()),{'source_id':'other'},'/tmp',detector=lambda _:[])
        for indices in ([2], [], ['0']):
            with self.assertRaisesRegex(ValueError,'Candidate people'):
                normalize_plan({'tracking':[region(candidate_people=indices)]},info())


if __name__ == '__main__': unittest.main()
