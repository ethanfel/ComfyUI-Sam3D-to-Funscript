"""Create a synthetic moving-marker clip for video_preview_browser_smoke.mjs (no GPU)."""
import sys,json
from fractions import Fraction
from pathlib import Path
from unittest.mock import patch
import av,numpy as np
sys.path.insert(0,str(Path.cwd()))
sys.path.insert(0,str(Path.cwd()/'tests'))
from test_core import fixture
from sam3d_funscript.reference import run_reference,decode
from sam3d_funscript.video import fingerprint
from sam3d_funscript.core import build_project,export_project
root=Path('development/reference-node/preview-fixture').resolve();root.mkdir(exist_ok=True)
source=root/'original.mp4';checkpoint=root/'fixture.pth';checkpoint.write_bytes(b'synthetic tracking fixture')
with av.open(str(source),'w') as container:
 stream=container.add_stream('libx264',rate=25);stream.width=320;stream.height=240;stream.pix_fmt='yuv420p';stream.options={'crf':'12'}
 for i in range(100):
  rgb=np.full((240,320,3),24,np.uint8);x,y=80+i,70+i//2;rgb[y-6:y+7,x-6:x+7]=[250,20,20]
  frame=av.VideoFrame.from_ndarray(rgb,format='rgb24');frame.pts=i;frame.time_base=Fraction(1,25)
  for packet in stream.encode(frame):container.mux(packet)
 for packet in stream.encode():container.mux(packet)
def tracker(info,config,checkpoint,destination,*args):
 rows=list(decode(info));shifts=np.array([[i,i//2] for i in range(len(rows))]);points=np.array(config['points'])[None,:,:]+shifts[:,None,:]
 np.savez_compressed(destination,points=points,visible=np.ones(points.shape[:-1],bool),source_times_ms=[float(r[2]*1000) for r in rows],metadata=json.dumps({'source_pts':[str(r[1]) for r in rows],'frame_durations_ms':[40]*len(rows)}))
with patch('sam3d_funscript.reference.track',side_effect=tracker):
 manifest,video=run_reference(source,Fraction(32,25),Fraction(51,25),{'points':[[110,86],[112,86],[114,86]]},checkpoint,Path('development/output/sam3d_funscript/reference'),use_cache=False)
sequence=fixture();sequence.metadata.update(source=fingerprint(video),image_size=manifest['video']['size_wh'][::-1],model={'fixture':True})
sequence.pixels[:]=np.array([112,86])+manifest['video']['padding_xy']
project=build_project(sequence)
path=export_project(project,'development/output/sam3d_funscript','preview_switch_test')
plain=export_project(build_project(fixture()),'development/output/sam3d_funscript','preview_plain_test')
legacy=dict(project);legacy['metadata']={k:v for k,v in project['metadata'].items() if k!='reference_stabilization'}
legacy_path=path.parent.with_name('preview_legacy_test_000000000000');legacy_path.mkdir(exist_ok=True)
(legacy_path/'project.json').write_text(json.dumps(legacy));(legacy_path/'source.json').write_text(json.dumps(legacy['metadata']['source']))
report={'project':path.parent.name,'plain':plain.parent.name,'legacy':legacy_path.name,'original':str(source),'stabilized':str(video.resolve()),'html':str(path.with_name('viewer.html').resolve()),'mapping':project['metadata']['reference_stabilization']}
(root/'report.json').write_text(json.dumps(report,indent=2));print(json.dumps({k:v for k,v in report.items() if k!='mapping'},indent=2))
