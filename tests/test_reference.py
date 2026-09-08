"""Reference edits, source identity, cache independence, and clip timing."""
from fractions import Fraction
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import av
import numpy as np

from sam3d_funscript.stabilization import correct_sections
from sam3d_funscript.reference import source_info, decode, config_for_source, tracking_key, run_reference
from sam3d_funscript.reference_preview import reference_preview


class ReferenceTests(unittest.TestCase):
    def test_manual_sections_only_replace_their_own_intervals(self):
        times = [0, 20, 70, 100, 160, 200]
        shifts = np.zeros((6, 2));valid = [1, 0, 0, 1, 0, 1]
        sections = [{"keys": [{"at_ms": 20, "xy": [12, 20]}, {"at_ms": 100, "xy": [20, 28]}]},
                    {"keys": [{"at_ms": 160, "xy": [14, 22]}]}]
        output, quality = correct_sections(times, shifts, valid, [10, 20], sections)
        np.testing.assert_allclose(output, [[0, 0], [2, 0], [7, 5], [10, 8], [4, 2], [0, 0]])
        self.assertEqual(quality.tolist(), ["tracked", "manual", "manual", "manual", "manual", "tracked"])
        np.testing.assert_array_equal(shifts, np.zeros((6, 2)))

    def test_overlapping_sections_and_duplicate_times_are_explicit_errors(self):
        section = {"keys": [{"at_ms": 0, "xy": [0, 0]}, {"at_ms": 100, "xy": [1, 1]}]}
        with self.assertRaisesRegex(ValueError, "overlap"):
            correct_sections([0, 100], np.zeros((2, 2)), [1, 1], [0, 0], [section, section])
        with self.assertRaisesRegex(ValueError, "distinct"):
            correct_sections([0, 100], np.zeros((2, 2)), [1, 1], [0, 0], [{"keys": [section["keys"][0]]*2}])

    def test_source_switch_clears_source_specific_points_and_corrections(self):
        info = {"source_id": "new", "width": 64, "height": 64}
        config, changed = config_for_source({"source_id": "old", "points": [[1, 2]]*3, "sections": [{"keys": []}]}, info)
        self.assertTrue(changed)
        self.assertEqual(config["points"], [])
        self.assertEqual(config["sections"], [])

    def test_cached_tracking_survives_manual_edits_and_trim_keeps_frame_timing(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary);source = root / "source.mkv";checkpoint = root / "model.pth";checkpoint.write_bytes(b"fixture")
            with av.open(str(source), "w") as container:
                stream = container.add_stream("ffv1", rate=25);stream.width=stream.height=64;stream.pix_fmt="bgr0"
                stream.time_base=stream.codec_context.time_base=Fraction(1,1000)
                for pts in [0,40,100,180,240,400]:
                    frame=av.VideoFrame.from_ndarray(np.full((64,64,3),pts%255,np.uint8),format="bgr24");frame.pts=pts;frame.time_base=Fraction(1,1000)
                    for packet in stream.encode(frame):container.mux(packet)
                for packet in stream.encode():container.mux(packet)
            info=source_info(source,Fraction(1,10),Fraction(3,20))
            config,_=config_for_source({"points":[[20,20],[30,20],[25,30]]},info)
            def fake_track(info,config,checkpoint,destination,*args):
                rows=list(decode(info));baseline=np.array(config["points"])
                np.savez_compressed(destination,points=np.broadcast_to(baseline,(len(rows),3,2)),visible=np.ones((len(rows),3),bool),
                    source_times_ms=[float(r[2]*1000) for r in rows],metadata=json.dumps({"source_pts":[str(r[1]) for r in rows],"frame_durations_ms":[40]*len(rows)}))
            with patch("sam3d_funscript.reference.track", side_effect=fake_track) as tracker:
                first,video=run_reference(source,Fraction(1,10),Fraction(3,20),config,checkpoint,root/"runs")
                self.assertEqual(first["data"]["source_times_ms"],[100,180,240])
                self.assertEqual(first["data"]["times_ms"],[0,80,140])
                key=tracking_key(info,config,checkpoint)
                config["sections"]=[{"keys":[{"at_ms":80,"xy":[26,25]}]}]
                self.assertEqual(key,tracking_key(info,config,checkpoint))
                edited,edited_video=run_reference(source,Fraction(1,10),Fraction(3,20),config,checkpoint,root/"runs")
                self.assertEqual(tracker.call_count,1)
                self.assertTrue(edited["cache_hit"])
                self.assertNotEqual(video,edited_video)
                self.assertEqual(edited["data"]["quality"],["tracked","manual","tracked"])
                preview=reference_preview({"path":str(edited_video)})
                self.assertEqual(preview["source"]["path"],str(source))
                self.assertEqual(preview["source_offset_ms"],100)
                self.assertEqual(preview["times_ms"],[0,80,140])
                self.assertEqual(preview["shift_xy"],edited["data"]["shift_xy"])
                self.assertEqual(preview["padding_xy"],edited["video"]["padding_xy"])
                self.assertNotIn("points",preview)
                self.assertIsNone(reference_preview({"path":str(source)}))
                with av.open(str(edited_video)) as container:
                    self.assertEqual([f.pts*f.time_base for f in container.decode(video=0)],[Fraction(0),Fraction(8,100),Fraction(14,100)])
                config["points"][0][0]+=1
                self.assertNotEqual(key,tracking_key(info,config,checkpoint))


if __name__ == "__main__":
    unittest.main()
