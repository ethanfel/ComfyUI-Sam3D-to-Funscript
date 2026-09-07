"""Verify default per-anchor Auto through ComfyUI using an existing pose cache."""
import copy
import json
from pathlib import Path
import subprocess
import sys

from queue_smoke import queue, ROOT

sys.path.insert(0, str(ROOT))
from sam3d_funscript.core import PoseSequence, build_project

out = ROOT / 'development/adaptive-auto'
out.mkdir(parents=True, exist_ok=True)
cache = str(Path(sys.argv[1]).resolve())
api = json.loads((ROOT / 'workflows/multitrack_anchors.api.json').read_text())
api['1']['inputs']['cache_path'] = cache
api['5']['inputs']['filename'] = 'adaptive_auto'
for node in ('2', '3', '4'):
    api[node]['inputs']['settings_json'] = '{}'
item = queue(api)
path = Path(item['outputs']['5']['text'][0])
project = json.loads(path.read_text())
sequence = PoseSequence.load(cache)
reports = []
for source in project['timeline']['sources']:
    data = source['data']
    anchor = data['config']['target_anchor']
    expected = build_project(sequence, {'target_anchor': anchor})
    assert data['scripts'] == expected['scripts']
    assert data['config']['axis_settings']['L0']['calibration'] == 'adaptive'
    probe = out / f'{anchor}.node.json'
    probe.write_text(json.dumps(expected, allow_nan=False))
    subprocess.run(['node', 'tests/test_auto.mjs', str(probe)], cwd=ROOT, check=True)
    reports.append({'anchor': anchor, 'calibration': data['metrics']['L0']['auto_calibration']})
# Produce a legacy single-anchor fixture to verify upgrading a saved curve in the editor.
legacy_api = copy.deepcopy(api)
legacy_api['3']['inputs']['settings_json'] = '{"axis_settings":{"L0":{"calibration":"clip"}}}'
legacy_api['5']['inputs'] = {'project_0': ['3', 0], 'filename': 'adaptive_before'}
legacy_item = queue(legacy_api)
legacy_path = Path(legacy_item['outputs']['5']['text'][0])
legacy = json.loads(legacy_path.read_text())
for axis in legacy['config']['axis_settings'].values():
    axis.pop('calibration', None)
# Initialize its timeline in the browser, like a pre-multitrack project.
legacy.pop('timeline', None)
old_path = out / 'legacy.project.json'
old_path.write_text(json.dumps(legacy, allow_nan=False))
report = {'project': str(path), 'id': path.parent.name, 'legacy_project': str(old_path), 'anchors': reports}
(out / 'queue-report.json').write_text(json.dumps(report, indent=2))
print(json.dumps(report, indent=2))
