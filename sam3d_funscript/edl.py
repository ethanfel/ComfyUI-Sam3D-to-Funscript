"""Import single-track CMX3600 hard cuts on the rendered video's frame clock."""
from fractions import Fraction
import re

from .reference import digest

MAX_EDL_BYTES = 2 * 1024 * 1024
TIMECODE = r"\d{2}:\d{2}:\d{2}[:;]\d{2,3}"
EVENT = re.compile(r"^\s*(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+)$")


def frame_rate(value):
    aliases = {'23.976': '24000/1001', '29.97': '30000/1001',
               '47.952': '48000/1001', '59.94': '60000/1001', '119.88': '120000/1001'}
    try:
        rate = Fraction(aliases.get(str(value).strip(), str(value).strip()))
    except (ValueError, ZeroDivisionError, TypeError):
        raise ValueError('Enter the Resolve timeline frame rate, such as 25 or 30000/1001.') from None
    if not 1 <= rate <= 120:
        raise ValueError('Timeline frame rate must be between 1 and 120 fps.')
    return rate


def timecode_frames(value, rate, drop=False):
    if not isinstance(value, str) or not re.fullmatch(TIMECODE, value):
        raise ValueError('Use a timecode such as 01:00:00:00 (HH:MM:SS:FF).')
    h, m, s, f = map(int, re.split('[:;]', value))
    nominal = round(rate)
    if h > 23 or m > 59 or s > 59 or f >= nominal:
        raise ValueError(f'Invalid timecode {value} at {float(rate):g} fps.')
    if ';' in value and not drop:
        raise ValueError('Semicolon timecodes require drop-frame timing.')
    frames = ((h * 60 + m) * 60 + s) * nominal + f
    if drop:
        if rate not in (Fraction(30000, 1001), Fraction(60000, 1001)):
            raise ValueError('Drop-frame EDLs require 29.97 or 59.94 fps.')
        skipped = 2 if nominal == 30 else 4
        if m % 10 and s == 0 and f < skipped:
            raise ValueError(f'Invalid skipped drop-frame timecode {value}.')
        minutes = h * 60 + m
        frames -= skipped * (minutes - minutes // 10)
    return frames


def parse_edl(text, rate):
    if not isinstance(text, str) or not text.strip():
        raise ValueError('Choose a timeline EDL containing video edits.')
    if len(text.encode('utf-8')) > MAX_EDL_BYTES:
        raise ValueError('The EDL is too large (maximum 2 MB).')
    events, current, modes = [], None, set()
    for line_number, line in enumerate(text.lstrip('\ufeff').splitlines(), 1):
        line = line.strip()
        if not line:
            continue
        if line.upper().startswith('FCM:'):
            mode = line.split(':', 1)[1].strip().upper()
            if mode not in ('DROP FRAME', 'NON-DROP FRAME'):
                raise ValueError(f'Unsupported EDL timing mode on line {line_number}.')
            modes.add(mode)
            continue
        name = re.match(r'^\*\s*FROM CLIP NAME:\s*(.*)$', line, re.I)
        if name and current is not None:
            current['name'] = name[1].strip()[:120]
            continue
        match = EVENT.match(line)
        if not match:
            if line[:1].isdigit():
                raise ValueError(f'Malformed EDL edit on line {line_number}.')
            continue  # TITLE, comments and source retime metadata do not define cuts.
        current = None
        number, reel, channel, transition, tail = match.groups()
        if 'V' not in channel.upper():
            continue  # Audio edits never partition the video.
        if transition.upper() != 'C':
            raise ValueError(f'Edit {number} uses a transition. Import a single video track with hard cuts; dissolves and wipes are not supported yet.')
        codes = tail.split()
        if len(codes) != 4 or not all(re.fullmatch(TIMECODE, code) for code in codes):
            raise ValueError(f'Malformed video timecodes on line {line_number}.')
        current = {'event': number, 'name': 'Black' if reel.upper() == 'BL' else '',
                   'record_in': codes[2], 'record_out': codes[3]}
        events.append(current)
    if not events:
        raise ValueError('No video edits found. Export the timeline as EDL, rather than “Timeline Markers to EDL”.')
    if len(events) > 20000 or len(modes) > 1:
        raise ValueError('Use one timeline EDL with a single timing mode and at most 20,000 video edits.')
    drop = modes == {'DROP FRAME'} or (not modes and any(';' in e['record_in'] + e['record_out'] for e in events))
    for event in events:
        event['in'] = timecode_frames(event['record_in'], rate, drop)
        event['out'] = timecode_frames(event['record_out'], rate, drop)
        if event['out'] <= event['in']:
            raise ValueError(f'Edit {event["event"]} has an invalid range or crosses midnight. Use an EDL within one timecode day.')
    events.sort(key=lambda e: (e['in'], e['out']))
    if any(b['in'] < a['out'] for a, b in zip(events, events[1:])):
        raise ValueError('Video edits overlap. Export only the montage’s final single video track.')
    return events, drop


def import_edl(text, info, index, *, fps, start_timecode='', filename=''):
    """Build annotations only. The caller previews them before an atomic save.

    Record timecodes address the montage, not the original source clip. The
    chosen origin addresses frame zero of the file, even for an upstream trim.
    """
    rate = frame_rate(fps)
    events, drop = parse_edl(text, rate)
    if not isinstance(start_timecode, str):
        raise ValueError('Video start timecode must be text.')
    start_timecode = start_timecode.strip() or events[0]['record_in']
    origin = timecode_frames(start_timecode, rate, drop)
    if index['source_id'] != info['source_id']:
        raise ValueError('The source video changed. Reload the timeline.')
    first, stop = index['first_frame'], index['end_frame']
    frame_ms = float(1000 / rate)
    # EDL frame numbers require a matching constant-rate render. Do not silently
    # drift through a VFR source or reinterpret a 25 fps montage as 24 fps.
    for offset, at in enumerate(index['times_ms']):
        if offset == 0 and first:  # Upstream trim may clamp its first timestamp.
            continue
        if abs(at - (first + offset) * frame_ms) > max(1, frame_ms * .05):
            raise ValueError('The EDL frame rate does not match the video clock. Choose the render’s frame rate and use a constant-frame-rate montage.')

    def at(frame):
        return index['end_ms'] if frame == stop else index['times_ms'][frame - first]

    segments, boundaries = [], set()
    for event in events:
        left, right = event['in'] - origin, event['out'] - origin
        a, b = max(first, left), min(stop, right)
        if a >= b:
            continue
        boundaries.update(frame for frame in (left, right) if first < frame < stop)
        segments.append({'start_ms': at(a), 'end_ms': at(b), 'name': event['name'],
                         'event': event['event'], 'record_in': event['record_in'], 'record_out': event['record_out']})
    if not segments:
        raise ValueError('No EDL edits overlap this video. Check the video start timecode and export range.')
    warnings = []
    if events[0]['in'] - origin < first or events[-1]['out'] - origin > stop:
        warnings.append('Edits outside the loaded video range are excluded. Check the start timecode if this is a full-timeline render.')
    if events[0]['in'] - origin > first or events[-1]['out'] - origin < stop:
        warnings.append('The EDL does not cover the whole loaded video. Check its frame rate and video start timecode.')
    if any(b['in'] > a['out'] for a, b in zip(events, events[1:])):
        warnings.append('The EDL contains gaps; their edges are included as cut markers.')
    return {'version': 1, 'source_id': info['source_id'], 'format': 'edl', 'detector': 'Imported EDL',
            'filename': str(filename).replace('\\', '/').split('/')[-1][:200], 'edl_hash': digest(text),
            'settings': {'frame_rate': str(rate), 'drop_frame': drop, 'start_timecode': start_timecode},
            'times_ms': [at(frame) for frame in sorted(boundaries)], 'segments': segments,
            'edit_count': len(events), 'warnings': warnings, 'cache_hit': False}
