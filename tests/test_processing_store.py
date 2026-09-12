from copy import deepcopy
from pathlib import Path
import tempfile
import unittest

from sam3d_funscript.processing_store import ProcessingStore, PlanConflict


class ProcessingStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = ProcessingStore(self.tmp.name)
        self.session = "a" * 32
        self.info = {"source_id": "source-a", "source": {"path": "video.mp4"},
                     "start": "2", "end_ms": 10000, "width": 640, "height": 480}
        self.state = self.store.prepare(self.session, self.info)

    def test_stale_editor_and_workflow_cannot_overwrite_newer_plan(self):
        plan = deepcopy(self.state["plan"])
        plan["tracking"][0]["anchor"] = "mouth"
        newer = self.store.save(self.session, 1, plan)
        self.assertEqual(newer["revision"], 2)
        with self.assertRaisesRegex(PlanConflict, "another editor"):
            self.store.save(self.session, 1, self.state["plan"])
        restored = self.store.prepare(self.session, self.info, {"revision": 1, "plan": self.state["plan"]})
        self.assertEqual(restored["plan"]["tracking"][0]["anchor"], "mouth")

    def test_blank_plan_starts_new_session_and_restores_saved_edits_without_resetting(self):
        for raw in ('', ' \n\t ', '{}'):
            with self.subTest(raw=raw):
                fresh = self.store.prepare('b' * 32, self.info, raw)
                self.assertEqual(fresh['plan'], self.state['plan'])
        plan = deepcopy(self.state['plan'])
        plan['tracking'][0].update(anchor='mouth', locked=True)
        saved = self.store.save(self.session, self.state['revision'], plan)
        saved = self.store.finish(self.session, saved['revision'], {'completed_jobs': 8}, Path(self.tmp.name)/'cached/project.json')
        before = (self.store.directory(self.session)/'timeline.json').read_bytes()
        for raw in ('', ' \n\t ', '{}'):
            restored = ProcessingStore(self.tmp.name).prepare(self.session, self.info, raw)
            self.assertEqual(restored, saved)
            self.assertEqual((self.store.directory(self.session)/'timeline.json').read_bytes(), before)

    def test_invalid_plan_never_resets_saved_state(self):
        before = (self.store.directory(self.session)/'timeline.json').read_bytes()
        for raw in ('{broken', '[]', 'null', 'false', '""', {'plan': []}):
            with self.subTest(raw=raw), self.assertRaisesRegex(ValueError, 'timeline plan JSON|JSON object'):
                self.store.prepare(self.session, self.info, raw)
            self.assertEqual((self.store.directory(self.session)/'timeline.json').read_bytes(), before)

    def test_locks_protect_edits_deletion_and_source_switch_until_unlocked(self):
        plan = deepcopy(self.state["plan"])
        plan["tracking"][0]["locked"] = True
        locked = self.store.save(self.session, 1, plan)
        edited = deepcopy(plan); edited["tracking"][0]["anchor"] = "mouth"
        with self.assertRaisesRegex(PlanConflict, "Unlock"):
            self.store.save(self.session, locked["revision"], edited)
        deleted = deepcopy(plan); deleted["tracking"] = []
        with self.assertRaisesRegex(PlanConflict, "Unlock"):
            self.store.save(self.session, locked["revision"], deleted)
        with self.assertRaisesRegex(PlanConflict, "locked regions"):
            self.store.prepare(self.session, {**self.info, "source_id": "source-b"})
        edited["tracking"][0]["locked"] = False
        self.store.save(self.session, locked["revision"], edited)
        switched = self.store.prepare(self.session, {**self.info, "source_id": "source-b"}, edited)
        self.assertEqual(switched["plan"]["tracking"][0]["anchor"], "pelvis")
        self.assertIsNone(switched["project"])

    def test_stale_completion_does_not_claim_current_plan_is_processed(self):
        plan = deepcopy(self.state["plan"]); plan["tracking"][0]["anchor"] = "mouth"
        self.store.save(self.session, 1, plan)
        finished = self.store.finish(self.session, 1, {"regions": []}, Path(self.tmp.name)/"result"/"project.json")
        self.assertFalse(finished["result_current"])
        self.assertEqual(finished["report"]["revision"], 1)
        self.assertEqual(finished["plan"]["tracking"][0]["anchor"], "mouth")

    def test_sessions_and_source_identity_reject_invalid_updates(self):
        with self.assertRaisesRegex(ValueError, "Invalid"):
            self.store.read("../escape")
        plan = deepcopy(self.state["plan"]); plan["source_id"] = "other"
        with self.assertRaisesRegex(PlanConflict, "source video changed"):
            self.store.save(self.session, 1, plan)

    def test_empty_success_clears_previous_result_but_failure_preserves_it(self):
        old = Path(self.tmp.name)/"old"/"project.json"
        self.store.finish(self.session, 1, {}, old)
        failed = self.store.finish(self.session, 1, {}, error="cancelled")
        self.assertEqual(failed["project_path"], str(old))
        self.assertFalse(failed["result_current"])
        empty = self.store.finish(self.session, 1, {})
        self.assertIsNone(empty["project_path"])
        self.assertIsNone(empty["project"])


    def test_editor_binding_keeps_plan_revision_and_preserves_it_on_prepare(self):
        bound = self.store.bind_editor(self.session, "b" * 32)
        self.assertEqual(bound["editor_session"], "b" * 32)
        self.assertEqual(bound["revision"], self.state["revision"])
        self.assertEqual(self.store.prepare(self.session, self.info)["editor_session"], "b" * 32)
        with self.assertRaisesRegex(ValueError, "Invalid editor session"):
            self.store.bind_editor(self.session, "../other")


if __name__ == "__main__":
    unittest.main()
