from copy import deepcopy
from fractions import Fraction
import unittest

from sam3d_funscript.edl import frame_rate, timecode_frames, import_edl, parse_edl


def edit(n, start, end, name='', channel='V', transition='C'):
    # Source and record times deliberately differ.
    return f'{n:03} AX {channel} {transition} 09:00:00:00 09:00:10:00 {start} {end}\n* FROM CLIP NAME: {name}\n'


def clock(rate=25, count=100, first=0, stop=None):
    rate = frame_rate(rate)
    stop = count if stop is None else stop
    return {'source_id': 'video', 'first_frame': first, 'end_frame': stop,
            'times_ms': [float(Fraction(i*1000, 1)/rate) for i in range(first, stop)],
            'end_ms': float(Fraction(stop*1000, 1)/rate)}


class EdlTests(unittest.TestCase):
    def imported(self, text, rate=25, index=None, **kwargs):
        return import_edl(text, {'source_id': 'video'}, index or clock(rate), fps=rate, **kwargs)

    def test_record_times_names_bom_crlf_and_audio(self):
        text = '\ufeffTITLE: Montage\r\nFCM: NON-DROP FRAME\r\n' + edit(1,'01:00:00:00','01:00:02:00','Opening')
        text += edit(2,'01:00:00:00','01:00:03:00','Sound',channel='A')
        text += edit(3,'01:00:02:00','01:00:04:00','Next <clip>',channel='AA/V')
        result = self.imported(text, filename='C:\\exports\\montage.edl')
        self.assertEqual(result['times_ms'], [2000])
        self.assertEqual([s['name'] for s in result['segments']], ['Opening', 'Next <clip>'])
        self.assertEqual(result['settings']['start_timecode'], '01:00:00:00')
        self.assertEqual(result['filename'], 'montage.edl')
        self.assertEqual(result['warnings'], [])

    def test_fractional_rate_uses_exact_indexed_boundary(self):
        result = self.imported(edit(1,'01:00:00:00','01:00:01:00')+edit(2,'01:00:01:00','01:00:04:00'), '23.976')
        self.assertEqual(result['times_ms'][0], 1001)
        self.assertEqual(result['settings']['frame_rate'], '24000/1001')

    def test_drop_frame_at_minute_and_tenth_minute(self):
        for rate, nominal, skipped in [('29.97',30,2), ('59.94',60,4)]:
            fps=frame_rate(rate)
            self.assertEqual(timecode_frames(f'00:01:00;{skipped:02}',fps,True), nominal*60)
            self.assertEqual(timecode_frames('00:10:00;00',fps,True),nominal*600-skipped*9)
            text='FCM: DROP FRAME\n'+edit(1,'00:00:59:00',f'00:01:00:{skipped:02}')+edit(2,f'00:01:00:{skipped:02}','00:01:01:00')
            result=self.imported(text,rate)
            self.assertAlmostEqual(result['times_ms'][0],1001)
            self.assertTrue(result['settings']['drop_frame'])
            with self.assertRaisesRegex(ValueError,'skipped'):
                timecode_frames('00:01:00;00',fps,True)

    def test_semicolon_without_fcm_and_invalid_timecodes(self):
        result=self.imported(edit(1,'01:00:00;00','01:00:01;00')+edit(2,'01:00:01;00','01:00:02;00'),'29.97')
        self.assertTrue(result['settings']['drop_frame'])
        for value,rate,drop in [('01:00:00:25',25,False),('24:00:00:00',25,False),('00:61:00:00',25,False),('00:00:00;00',25,False),('00:00:00:00',25,True)]:
            with self.assertRaises(ValueError): timecode_frames(value,Fraction(rate),drop)

    def test_in_out_render_origin_and_upstream_trim_use_original_file_clock(self):
        text=edit(1,'01:00:00:00','01:00:02:00','A')+edit(2,'01:00:02:00','01:00:04:00','B')
        partial=self.imported(text,index=clock(count=50),start_timecode='01:00:01:00')
        self.assertEqual(partial['times_ms'],[1000])
        self.assertEqual([(s['start_ms'],s['end_ms']) for s in partial['segments']],[(0,1000),(1000,2000)])
        trimmed=self.imported(text,index=clock(first=25,stop=75))
        self.assertEqual(trimmed['times_ms'],[2000])
        self.assertEqual(trimmed['segments'][0]['start_ms'],1000)
        self.assertEqual(trimmed['segments'][-1]['end_ms'],3000)

    def test_gaps_include_both_edges_and_no_artificial_endpoints(self):
        result=self.imported(edit(1,'00:00:00:00','00:00:01:00')+edit(2,'00:00:02:00','00:00:04:00'))
        self.assertEqual(result['times_ms'],[1000,2000])
        self.assertIn('gaps', ' '.join(result['warnings']))
        self.assertEqual(self.imported(edit(1,'00:00:00:00','00:00:04:00'))['times_ms'],[])

    def test_out_of_range_reports_warning_or_no_overlap(self):
        text=edit(1,'01:00:00:00','01:00:03:00')
        self.assertIn('whole loaded video',' '.join(self.imported(text)['warnings']))
        with self.assertRaisesRegex(ValueError,'No EDL edits overlap'):
            self.imported(text,start_timecode='02:00:00:00')

    def test_bad_rate_vfr_and_wrong_source_are_rejected(self):
        text=edit(1,'00:00:00:00','00:00:04:00')
        for rate in ('no', '1/0', 'NaN', 0, -25, 121):
            with self.assertRaises(ValueError): self.imported(text,rate)
        with self.assertRaisesRegex(ValueError,'frame rate does not match'):
            self.imported(text,rate=24,index=clock())
        vfr=clock();vfr['times_ms'][50]+=10
        with self.assertRaisesRegex(ValueError,'frame rate does not match'):
            self.imported(text,index=vfr)
        wrong=clock();wrong['source_id']='other'
        with self.assertRaisesRegex(ValueError,'source video changed'):
            self.imported(text,index=wrong)

    def test_audio_only_markers_malformed_overlap_and_transitions(self):
        for text in ('', 'TITLE: Markers\n* Marker 1', edit(1,'00:00:00:00','00:00:04:00',channel='A'),
                     '001 malformed', edit(1,'00:00:00:00','00:00:00:00'),
                     edit(1,'00:00:00:00','00:00:03:00')+edit(2,'00:00:02:00','00:00:04:00'),
                     edit(1,'00:00:00:00','00:00:04:00',transition='D 025'),
                     'FCM: DROP FRAME\nFCM: NON-DROP FRAME\n'+edit(1,'00:00:00:00','00:00:04:00')):
            with self.subTest(text=text), self.assertRaises(ValueError): self.imported(text)

    def test_preview_does_not_mutate_frame_index(self):
        index=clock();before=deepcopy(index)
        self.imported(edit(1,'00:00:00:00','00:00:04:00'),index=index)
        self.assertEqual(index,before)


if __name__ == '__main__': unittest.main()
