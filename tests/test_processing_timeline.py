"""Timeline compiler, resumable execution, original PTS, and six-axis assembly."""
from copy import deepcopy
from fractions import Fraction
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import av
import numpy as np

from sam3d_funscript.core import AXES, PoseSequence, validate_actions
from sam3d_funscript.processing_timeline import (
    normalize_plan, compile_jobs, run_timeline, _original_sequence, _assembled_actions, apply_processing_scope,
)
from sam3d_funscript.video import video_frames
from sam3d_funscript.reference import source_info
from sam3d_funscript.masks import MaskVideoReader


def info(path="test.mp4", start=0, end=4000):
    return {"source_id": "fixture", "source": {"path": str(path), "size": 1, "mtime_ns": 1},
            "width": 320, "height": 240, "start": str(start), "duration": "0", "end_ms": end,
            "source_origin": "0", "rate": "25", "time_base": "1/1000"}


def region(identifier="r0", start=0, end=4000, **kwargs):
    return {"id": identifier, "name": identifier, "start_ms": start, "end_ms": end, **kwargs}


def fake_extract(source, model_file, cache_dir, **kwargs):
    a = kwargs["start_seconds"] * 1000
    b = a + kwargs["duration_seconds"] * 1000
    times = np.arange(np.ceil(a/40)*40, b, 40)
    people = len(kwargs["rois_json"])
    points = np.zeros((len(times), people, 72, 3))
    points[..., 2] = 3
    points[:, :, 9, 0] = -.2; points[:, :, 10, 0] = .2
    points[:, :, 5, :2] = [-.2, -.5]; points[:, :, 6, :2] = [.2, -.5]
    points[..., 1] += .05*np.sin(times[:, None, None]/200)
    pixels = np.ones(points.shape[:-1]+(2,))*100
    origin = [0, 1]
    metadata = {"source": {"path": str(source)}, "image_size": [240, 320], "duration_ms": b,
                "timestamps": [{"time_ms": float(t), "pts": int(t), "time_base": [1, 1000], "origin": origin} for t in times]}
    return PoseSequence(times, points, pixels, np.ones((len(times), people), bool), np.zeros(len(times), int), metadata)


class PlanTests(unittest.TestCase):
    def test_fractional_stabilization_boundary_does_not_include_the_previous_scene(self):
        cut = 161958.33333333334
        current = info(end=170250)
        for start in (161958.333333, 161958.333334):
            with self.subTest(start=start):
                plan = normalize_plan({'tracking':[region('scene27',158000,cut),region('scene28',cut,170250)],
                    'stabilization':[region('s',start,170250)]},current)
                before = deepcopy(plan)
                jobs = compile_jobs(plan,current)
                self.assertEqual([(j['region_id'],j['stabilization_id']) for j in jobs],
                    [('scene27',None),('scene28','s')])
                self.assertEqual([(j['start_ms'],j['end_ms']) for j in jobs],[(158000,cut),(cut,170250)])
                self.assertEqual(jobs[0]['context_end_ms'],cut)
                self.assertEqual(plan,before,'comparison tolerance must not rewrite saved regions')
        plan['stabilization'][0]['start_ms']=cut-1000/24
        jobs=compile_jobs(plan,current)
        self.assertEqual([(j['region_id'],j['stabilization_id']) for j in jobs],
            [('scene27',None),('scene27','s'),('scene28','s')],'a genuine one-frame overlap remains included')

    def test_subject_crop_is_optional_and_requires_a_boolean(self):
        ordinary = normalize_plan({'tracking': [region()]}, info())
        disabled = normalize_plan({'tracking': [region(isolate_subject=False)]}, info())
        self.assertEqual(ordinary, disabled, 'old default signatures remain valid')
        isolated = normalize_plan({'tracking': [region(isolate_subject=True)]}, info())
        self.assertTrue(isolated['tracking'][0]['isolate_subject'])
        for value in ('false', 1, None):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, 'boolean'):
                normalize_plan({'tracking': [region(isolate_subject=value)]}, info())

    def test_blank_plan_is_the_default_but_nonempty_invalid_json_is_rejected(self):
        for raw in ('', ' \n\t '):
            self.assertEqual(normalize_plan(raw, info()), normalize_plan({}, info()))
        for raw in ('{broken', '[]', 'null', 'false', '""'):
            with self.subTest(raw=raw), self.assertRaisesRegex(ValueError, 'timeline plan JSON|JSON object'):
                normalize_plan(raw, info())

    def test_explicit_scope_ignores_other_selection_and_preserves_saved_plan(self):
        plan = normalize_plan({'tracking': [region('a', 0, 2000), region('b', 2000, 4000)],
                               'selection': [200, 400], 'selected_ids': ['b']}, info())
        before = deepcopy(plan)
        scoped = apply_processing_scope(plan, {'kind': 'regions', 'ids': ['b']}, info())
        self.assertEqual(scoped['selection'], [200, 200])
        scoped = apply_processing_scope(plan, {'kind': 'range', 'range': [500, 1500]}, info())
        self.assertEqual(scoped['selection'], [500, 1500])
        self.assertEqual(scoped['selected_ids'], [])
        self.assertEqual(plan, before)
        for scope in ({'kind': 'regions', 'ids': ['missing']}, {'kind': 'range', 'range': [True, 1000]},
                      {'kind': 'range', 'range': [1000, 5000]}, {'kind': 'unknown'}):
            with self.assertRaises(ValueError):
                apply_processing_scope(plan, scope, info())

    def test_source_switch_resets_region_points_and_trim_defines_default_bounds(self):
        current = info(start=2, end=5000)
        plan = normalize_plan({"source_id": "old", "tracking": [region()],
                               "stabilization": [region("s", reference={"points": [[2, 2]]*3})]}, current)
        self.assertTrue(plan["source_changed"])
        self.assertEqual(plan["stabilization"], [])
        self.assertEqual([(r["start_ms"], r["end_ms"]) for r in plan["tracking"]], [(2000, 5000)])

    def test_overlap_same_lane_fails_independent_lanes_and_adjacent_boundaries_work(self):
        with self.assertRaisesRegex(ValueError, "overlap"):
            normalize_plan({"tracking": [region("a", 0, 2500), region("b", 2000, 4000)]}, info())
        plan = normalize_plan({"tracking": [region("a", 0, 2000), region("b", 2000, 4000)],
                               "stabilization": [region("s", 1000, 3000)]}, info())
        self.assertEqual(len(plan["tracking"]), 2)
        with self.assertRaisesRegex(ValueError, "supported"):
            normalize_plan({"tracking": [region(method="invented")]}, info())

    def test_compiler_splits_stabilization_and_keeps_context_inside_its_basis(self):
        plan = normalize_plan({"chunk_seconds": 1, "stabilization": [region("s", 1200, 2700)]}, info())
        jobs = compile_jobs(plan, info())
        self.assertEqual([(j["start_ms"], j["end_ms"], j["stabilization_id"]) for j in jobs],
                         [(0,1000,None), (1000,1200,None), (1200,2200,"s"), (2200,2700,"s"), (2700,3700,None), (3700,4000,None)])
        for job in jobs:
            if job["stabilization_id"]:
                self.assertGreaterEqual(job["context_start_ms"], 1200)
                self.assertLessEqual(job["context_end_ms"], 2700)
            elif job["start_ms"] >= 2700:
                self.assertGreaterEqual(job["context_start_ms"], 2700)
            else:
                self.assertLessEqual(job["context_end_ms"], 1200)


class ExecutionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.model = self.root/"model.safetensors"; self.model.write_bytes(b"fixture")
        self.info = info()
        self.extract = patch("sam3d_funscript.processing_timeline.extract_video", side_effect=fake_extract).start()
        self.addCleanup(patch.stopall)

    def run_plan(self, plan, **kwargs):
        return run_timeline(self.info, plan, self.root, str(self.model), **kwargs)

    def test_automatic_people_share_poses_and_keep_distinct_sources_across_reruns(self):
        from sam3d_funscript.editor import initialize, merge_projects
        automatic = {'version':1,'suggest':True,'people':[{'coverage':1} for _ in range(9)],'review':[]}
        plan = {'tracking':[region(anchor='pelvis',additional_anchors=['mouth','left_hand','right_hand'],
            rois=[[0,0,1,1] for _ in range(9)],candidate_people=list(range(9)),automatic=automatic)]}
        project, report = self.run_plan(plan)
        self.assertEqual(self.extract.call_count,1)
        self.assertEqual(len(project['timeline']['tracks']),36)
        self.assertEqual(len(report['regions'][0]['candidates']),36)
        self.assertEqual(sum(c['suggested'] for c in report['regions'][0]['candidates']),1)
        initialize(project)
        self.assertEqual(len(project['timeline']['latest']),36)
        self.assertEqual(len({s['input'] for s in project['timeline']['sources']}),36)
        for axis in AXES: self.assertEqual(len(project['timeline']['main'][axis]['regions']),1)
        again, _ = self.run_plan(plan)
        self.assertEqual(self.extract.call_count,1)
        merged = merge_projects(project,again)
        self.assertEqual(len(merged['timeline']['tracks']),36)
        plan['tracking'][0].update(person=8,anchor='right_hand',additional_anchors=['pelvis','mouth','left_hand'])
        plan['tracking'][0]['automatic']['suggest']=False
        changed,_ = self.run_plan(plan)
        self.assertEqual(self.extract.call_count,1,'switching people reuses the multi-person pose cache')
        primary=[s for s in changed['timeline']['sources'] if s['data']['metadata']['processing_anchor']['primary']]
        self.assertEqual(len(primary),1)
        self.assertEqual(primary[0]['data']['config']['target_person'],8)
        self.assertEqual(primary[0]['data']['config']['target_anchor'],'right_hand')

    def test_automatic_short_or_failed_candidates_do_not_block_later_scenes(self):
        automatic = {'version':1,'suggest':True,'people':[],'review':[]}
        plan = {'tracking':[region('short',0,1000,automatic=automatic), region('good',1000,4000,automatic=automatic)]}
        def extract(*args, **kwargs):
            if kwargs['start_seconds'] == 0:
                raise ValueError('Selected video range contains fewer than two sampled frames')
            return fake_extract(*args, **kwargs)
        self.extract.side_effect = extract
        project, report = self.run_plan(plan)
        self.assertEqual(report['regions'][0]['state'],'error')
        self.assertEqual(report['regions'][1]['state'],'complete')
        self.assertEqual(len(project['timeline']['sources']),1)
        self.assertEqual(project['timeline']['sources'][0]['data']['metadata']['processing_region']['id'],'good')
        # Missing target poses are candidate failures, not a fake flat source.
        def invalid(*args, **kwargs):
            sequence = fake_extract(*args, **kwargs)
            if kwargs['start_seconds'] == 0: sequence.valid[:] = False
            return sequence
        self.extract.side_effect = invalid
        project, report = self.run_plan(plan, use_cache=False)
        self.assertEqual(report['regions'][0]['state'],'error')
        self.assertIn('No usable anchor',report['regions'][0]['error'])
        self.assertEqual(report['regions'][1]['state'],'complete')
        self.assertEqual(len(project['timeline']['sources']),1)

    def test_subject_crop_reprocesses_only_the_changed_section(self):
        plan = {'tracking': [region('a', 0, 2000), region('b', 2000, 4000)]}
        self.run_plan(plan)
        self.assertEqual(self.extract.call_count, 2)
        self.assertNotIn('isolate_subject', self.extract.call_args.kwargs)
        plan['tracking'][0]['isolate_subject'] = True
        self.run_plan(plan)
        self.assertEqual(self.extract.call_count, 3)
        self.assertTrue(self.extract.call_args.kwargs['isolate_subject'])
        self.run_plan(plan)
        self.assertEqual(self.extract.call_count, 3)
        plan['tracking'][0]['isolate_subject'] = False
        self.run_plan(plan)
        self.assertEqual(self.extract.call_count, 4)
        self.assertNotIn('isolate_subject', self.extract.call_args.kwargs)

    def test_multiple_anchors_share_inference_and_only_main_anchor_is_assembled(self):
        plan = {"tracking": [region(anchor="mouth", additional_anchors=["left_hand", "right_hand"])]}
        project, report = self.run_plan(plan)
        self.assertEqual(self.extract.call_count, 1)
        self.assertEqual([s["data"]["config"]["target_anchor"] for s in project["timeline"]["sources"]], ["mouth", "left_hand", "right_hand"])
        self.assertEqual(len(project["timeline"]["geometries"]), 0)
        for axis in AXES:
            self.assertEqual(len(project["timeline"]["main"][axis]["regions"]), 1)
            self.assertEqual(project["timeline"]["main"][axis]["regions"][0]["source"], "project_0")
        self.assertEqual(report["regions"][0]["anchors"], ["mouth", "left_hand", "right_hand"])
        plan["tracking"][0]["locked"] = True
        retained, _ = self.run_plan(plan, use_cache=False)
        self.assertEqual(self.extract.call_count, 1)
        self.assertEqual(retained["scripts"], project["scripts"])
        self.assertEqual(len(retained["timeline"]["sources"]), 3)

    def test_adding_or_changing_anchors_reuses_completed_pose_chunks(self):
        plan = {"tracking": [region(anchor="mouth")], "selection": [1000, 2000]}
        first, _ = self.run_plan(plan, operation="selected")
        self.assertEqual(self.extract.call_count, 1)
        plan["tracking"][0]["additional_anchors"] = ["left_hand"]
        expanded, _ = self.run_plan(plan, operation="selected")
        self.assertEqual(self.extract.call_count, 1)
        self.assertEqual(len(expanded["timeline"]["sources"]), 2)
        self.assertEqual(expanded["metadata"]["processing_timeline"]["coverage"], [[1000, 2000]])
        plan["tracking"][0].update(anchor="left_hand", additional_anchors=["mouth"])
        swapped, _ = self.run_plan(plan, operation="selected")
        self.assertEqual(self.extract.call_count, 1)
        self.assertEqual(swapped["config"]["target_anchor"], "left_hand")

    def test_detailed_main_and_additional_anchors_share_poses_and_keep_six_axes(self):
        anchors = ["left_index_tip", "right_ear", "left_heel"]
        project, report = self.run_plan({"tracking": [region(anchor=anchors[0], additional_anchors=anchors[1:])]})
        self.assertEqual(self.extract.call_count, 1)
        self.assertEqual([s["data"]["config"]["target_anchor"] for s in project["timeline"]["sources"]], anchors)
        self.assertEqual(report["regions"][0]["anchors"], anchors)
        for source in project["timeline"]["sources"]:
            self.assertEqual(set(source["data"]["scripts"]), set(AXES))

    def test_adding_anchor_keeps_other_regions_assigned_to_their_own_source(self):
        from sam3d_funscript.editor import merge_projects
        plan = {"tracking": [region("a", 0, 2000), region("b", 2000, 4000, anchor="mouth")]}
        first, _ = self.run_plan(plan)
        plan["tracking"][0]["additional_anchors"] = ["left_hand"]
        second, _ = self.run_plan(plan)
        merged = merge_projects(first, second)
        self.assertEqual(len(merged["timeline"]["tracks"]), 3)
        sources = {s["id"]: s for s in merged["timeline"]["sources"]}
        mouth_track = next(t for t in merged["timeline"]["tracks"] if "mouth" in t["name"])
        self.assertEqual(sources[mouth_track["source"]]["input"], "region:b:mouth")

    def test_chunks_calibrate_together_cache_resume_and_locked_result_survives_rerun(self):
        plan = {"chunk_seconds": 1, "tracking": [region()]}
        first, report = self.run_plan(plan)
        self.assertEqual(self.extract.call_count, 4)
        self.assertEqual(first["times_ms"], list(np.arange(0, 4000, 40)))
        self.assertEqual(set(first["scripts"]), set(AXES))
        self.assertEqual(first["metadata"]["duration_ms"], 4000)
        for axis in AXES:
            validate_actions(first["scripts"][axis]["actions"])
            self.assertEqual(first["timeline"]["main"][axis]["regions"][0]["start"], 0)
            self.assertEqual(first["timeline"]["main"][axis]["regions"][0]["end"], 4000)
        again, report = self.run_plan(plan)
        self.assertEqual(self.extract.call_count, 4)
        self.assertTrue(all(j["state"] == "cached" for j in report["jobs"]))
        locked = deepcopy(plan); locked["tracking"][0].update(locked=True, anchor="left_hand", smoothing_ms=0)
        protected, report = self.run_plan(locked, use_cache=False)
        self.assertEqual(self.extract.call_count, 4)
        self.assertEqual(protected["scripts"], again["scripts"])
        self.assertEqual(report["regions"][0]["state"], "locked")
        self.assertIn("retained", report["warnings"][0])

    def test_selected_range_remains_on_original_clock_and_has_explicit_gap(self):
        # The inspector's selected region remains selected while shift-dragging
        # time; a marked range takes precedence over that region selection.
        plan = {"selection": [1250, 2750], "selected_ids": ["r0"], "chunk_seconds": 1, "tracking": [region()], "join_ms": 0}
        project, report = self.run_plan(plan, operation="selected")
        self.assertEqual(project["metadata"]["processing_timeline"]["coverage"], [[1250, 2750]])
        self.assertGreaterEqual(project["times_ms"][0], 1250)
        self.assertLess(project["times_ms"][-1], 2750)
        self.assertEqual(project["scripts"]["L0"]["actions"][0], {"at": 0, "pos": 50})
        self.assertEqual(project["scripts"]["L0"]["actions"][-1]["at"], 4000)
        self.assertEqual(report["regions"][0]["state"], "partial")
        completed, report = self.run_plan(plan, operation="unfinished")
        self.assertEqual(completed["metadata"]["processing_timeline"]["coverage"], [[0, 4000]])
        # Resume processes the two remaining quarter chunks, not the already
        # approved middle of either partially completed chunk.
        newly_completed = [(j["start_ms"], j["end_ms"]) for j in report["jobs"] if j["state"] == "complete"]
        self.assertEqual(newly_completed, [(0,1000), (1000,1250), (2750,3000), (3000,4000)])

    def test_fractional_selection_does_not_run_the_previous_scene(self):
        cut=1958.3333333333333
        plan={'tracking':[region('previous',0,cut),region('current',cut,4000)],
              'selection':[1958.333333,4000]}
        _,report=self.run_plan(plan,operation='selected')
        self.assertEqual(self.extract.call_count,1)
        self.assertEqual({j['region_id'] for j in report['jobs']},{'current'})
        self.assertEqual(report['regions'][0]['state'],'pending')
        self.assertEqual(report['regions'][1]['state'],'complete')
        plan['selection']=[1958.333334,3999.9999997]
        _,report=self.run_plan(plan,operation='selected',use_cache=False)
        self.assertEqual({j['region_id'] for j in report['jobs']},{'current'})
        self.assertEqual(report['regions'][1]['coverage'],[[cut,4000]])
        self.assertEqual(report['regions'][1]['state'],'complete')

    def test_failed_chunk_preserves_previous_completed_chunk(self):
        count = 0
        def fail_second(*args, **kwargs):
            nonlocal count
            count += 1
            if count == 2:
                raise RuntimeError("synthetic inference failure")
            return fake_extract(*args, **kwargs)
        self.extract.side_effect = fail_second
        plan = {"chunk_seconds": 1}
        with self.assertRaisesRegex(RuntimeError, "synthetic"):
            self.run_plan(plan)
        state = json.loads((self.root/"results"/"fixture"/"state.json").read_text())
        self.assertEqual(len(state["regions"]["tracking_0"]["jobs"]), 1)
        self.extract.side_effect = fake_extract
        project, report = self.run_plan(plan, operation="unfinished")
        self.assertEqual(report["jobs"][0]["state"], "cached")
        self.assertEqual(project["metadata"]["processing_timeline"]["coverage"], [[0, 4000]])

    def test_baseexception_cancellation_saves_report_then_propagates(self):
        class Cancelled(BaseException):
            pass
        count = 0
        def cancel_second(*args, **kwargs):
            nonlocal count
            count += 1
            if count == 2:
                raise Cancelled("cancelled by user")
            return fake_extract(*args, **kwargs)
        self.extract.side_effect = cancel_second
        with self.assertRaises(Cancelled):
            self.run_plan({"chunk_seconds": 1})
        report = json.loads((self.root/"results"/"fixture"/"report.json").read_text())
        self.assertEqual(report["completed_jobs"], 1)
        self.assertEqual(report["jobs"][-1]["error"], "cancelled by user")

    def test_multiple_anchors_keep_separate_preview_and_update_all_axes(self):
        plan = {"tracking": [region("a", 0, 2000, anchor="mouth"), region("b", 2000, 4000, anchor="left_hand")]}
        project, _ = self.run_plan(plan)
        self.assertEqual([s["data"]["config"]["target_anchor"] for s in project["timeline"]["sources"]], ["mouth", "left_hand"])
        for axis in AXES:
            self.assertEqual([r["source"] for r in project["timeline"]["main"][axis]["regions"]], ["project_0", "project_1"])
        self.assertEqual(project["metadata"]["image_size"], [240, 320])
        self.assertEqual(project["metadata"]["source"], self.info["source"])

    def test_mask_person_mismatch_fails_before_inference(self):
        with self.assertRaisesRegex(ValueError, "one person"):
            self.run_plan({"tracking": [region(person=1, rois=[[0,0,.5,1],[.5,0,.5,1]])]},
                          mask_video_range=("mask.mp4", 0, 0))
        self.extract.assert_not_called()

    def test_selected_stabilization_without_tracking_reports_actionable_error(self):
        plan = {"tracking": [region("r", 0, 1000)], "stabilization": [region("s", 1500, 3000)], "selected_ids": ["s"]}
        with self.assertRaisesRegex(ValueError, "no enabled tracking coverage"):
            self.run_plan(plan, operation="selected")
        self.extract.assert_not_called()
        plan["selection"] = [1600, 2500]
        with self.assertRaisesRegex(ValueError, "Add or enable"):
            self.run_plan(plan, operation="selected")

    def test_locked_old_coverage_cannot_silently_overlap_a_new_region(self):
        self.run_plan({"tracking": [region("a", 0, 2000)]})
        # A caller bypassing editor lock controls gets an explicit conflict,
        # rather than quietly composing over the retained locked half-second.
        with self.assertRaisesRegex(ValueError, "coverage overlaps"):
            self.run_plan({"tracking": [region("a", 0, 1500, locked=True), region("b", 1500, 4000)]})

    def test_stabilization_runs_whole_region_once_and_maps_projection_back(self):
        checkpoint = self.root/"checkpoint.pth"; checkpoint.write_bytes(b"fixture")
        stabilized = self.root/"stabilized.mp4"; stabilized.write_bytes(b"fixture")
        times = np.arange(1200, 2800, 40)
        local = times-times[0]
        manifest = {"id": "stab", "data": {"times_ms": local.tolist(), "source_times_ms": times.tolist(),
                     "source_pts": [str(Fraction(int(t), 1000)) for t in times], "shift_xy": [[5, 8]]*len(times)},
                    "video": {"padding_xy": [20, 30], "size_wh": [360, 300]}}
        plan = {"chunk_seconds": 1, "tracking": [region("r", 1400, 2600)],
                "stabilization": [region("s", 1200, 2800, reference={"points": [[10,10],[20,10],[15,20]]})]}
        with patch("sam3d_funscript.processing_timeline.run_reference", return_value=(manifest, stabilized)) as tracker:
            project, _ = self.run_plan(plan, checkpoint=checkpoint)
        self.assertEqual(tracker.call_count, 1)
        self.assertEqual(tracker.call_args.args[1:3], (Fraction(6,5), Fraction(8,5)))
        self.assertGreaterEqual(project["times_ms"][0], 1400)
        np.testing.assert_allclose(np.asarray(project["pixels"])[0,0,0], [85,78])
        self.assertEqual(project["metadata"]["source"], self.info["source"])
        with patch("sam3d_funscript.processing_timeline.run_reference", side_effect=AssertionError("must reuse")):
            cached, _ = self.run_plan(plan, checkpoint=checkpoint)
            self.assertEqual(len(cached["metadata"]["processing_timeline"]["stabilized_regions"]), 1)
            plan["stabilization"][0].update(locked=True, reference={"points": [[30,30],[40,30],[35,40]]})
            # Disabling general caches must still preserve the locked reference.
            retained, _ = self.run_plan(plan, checkpoint=checkpoint, use_cache=False)
            np.testing.assert_allclose(np.asarray(retained["pixels"])[0,0,0], [85,78])
            self.assertEqual(retained["metadata"]["processing_timeline"]["plan"]["stabilization"][0]["reference"]["points"],
                             [[10,10],[20,10],[15,20]])
        with self.assertRaisesRegex(ValueError, "source mask"):
            self.run_plan(plan, mask_video_range=("mask.mp4", 0, 0))

    def test_join_is_bounded_and_hold_and_neutral_gaps_differ(self):
        p = {"scripts": {"L0": {"actions": [{"at": 0, "pos": 10}, {"at": 2000, "pos": 90}]}}}
        parts = [(0, 1000, p), (1500, 2000, p)]
        held = _assembled_actions(parts, "L0", 2500, 200, "hold")
        neutral = _assembled_actions(parts, "L0", 2500, 200, "neutral")
        self.assertEqual(next(a["pos"] for a in held if a["at"] == 1499), 50)
        self.assertEqual(held[0]["pos"], 10)
        self.assertEqual(held[-1]["pos"], 90)
        self.assertEqual(neutral[-1]["pos"], 50)
        self.assertTrue(all(0 <= a["pos"] <= 100 for a in held))


class VideoSeekTests(unittest.TestCase):
    def test_seek_preserves_vfr_pts_and_nonzero_stream_origin(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)/"source.mkv"
            with av.open(str(source), "w") as container:
                stream = container.add_stream("ffv1", rate=25); stream.width=stream.height=32; stream.pix_fmt="bgr0"
                stream.time_base=stream.codec_context.time_base=Fraction(1,1000)
                for index, pts in enumerate([2000,2040,2110,2200,2350,2400]):
                    pixels = np.zeros((32,32,3),np.uint8)
                    pixels[:, index:index+2] = 255
                    frame=av.VideoFrame.from_ndarray(pixels,format="bgr24")
                    frame.pts=pts;frame.time_base=Fraction(1,1000)
                    for packet in stream.encode(frame):container.mux(packet)
                for packet in stream.encode():container.mux(packet)
            all_frames = list(video_frames(source, sample_fps=0))
            trimmed = list(video_frames(source, sample_fps=0, start_seconds=.1, duration_seconds=.3))
            self.assertEqual([t["time_ms"] for _,t in trimmed], [110,200,350])
            self.assertEqual([t["pts"] for _,t in trimmed], [t["pts"] for _,t in all_frames[2:5]])
            self.assertEqual(trimmed[0][1]["origin"], [2,1])
            with MaskVideoReader(source, Fraction(1,10), Fraction(3,10)) as masks:
                first_packed, first_box = masks.at(Fraction(11,100), (32,32))
                final_packed, final_box = masks.at(Fraction(35,100), (32,32))
                self.assertEqual(first_box, [2/32,0,2/32,1])
                self.assertEqual(final_box, [4/32,0,2/32,1])
                self.assertEqual(masks.origin, Fraction(2))
                with self.assertRaisesRegex(ValueError, "trim does not cover"):
                    masks.at(Fraction(4,10), (32,32))
            current = source_info(source, Fraction(1,10), Fraction(3,10))
            self.assertEqual(float(current["end_ms"]), 400)
            model = Path(temporary)/"model.safetensors"; model.write_bytes(b"fixture")
            def timestamped_extract(path, model_file, cache_dir, **kwargs):
                decoded = list(video_frames(path, sample_fps=0, start_seconds=kwargs["start_seconds"],
                                            duration_seconds=kwargs["duration_seconds"]))
                count = len(decoded)
                sequence = fake_extract(path, model_file, cache_dir, start_seconds=0, duration_seconds=count*.04, rois_json=[[0,0,1,1]])
                sequence.times_ms = np.asarray([row[1]["time_ms"] for row in decoded])
                sequence.metadata["timestamps"] = [row[1] for row in decoded]
                return sequence
            with patch("sam3d_funscript.processing_timeline.extract_video", side_effect=timestamped_extract):
                project, report = run_timeline(current, {}, Path(temporary)/"run", str(model))
            self.assertEqual(project["times_ms"], [110,200,350])
            self.assertEqual(project["metadata"]["duration_ms"], 400)
            self.assertEqual(project["metadata"]["processing_timeline"]["coverage"], [[100,400]])
            self.assertEqual(project["metadata"]["timestamps"][0]["origin"], [2,1])
            self.assertEqual(project["metadata"]["source_origin_ms"], 2000)
            self.assertEqual(project["timeline"]["sources"][0]["data"]["metadata"]["source_origin_ms"], 2000)


if __name__ == "__main__":
    unittest.main()
