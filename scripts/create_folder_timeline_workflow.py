"""Generate a standalone folder-review workflow, without private media paths."""
import json
from pathlib import Path
from create_processing_timeline_workflow import make_node, input_port, output_port

ROOT = Path(__file__).resolve().parents[1]


def build_workflow(folder_path=''):
    settings = dict(folder_path=folder_path, include_subfolders=True, video_name='',
        model_file='sam_3d_body_dinov3_bf16.safetensors', sample_fps=0, batch_size=8,
        tracker_model='cotracker3_scaled_online.pth', operation='prepare', plan_json='{}', use_cache=True, cut_sensitivity='normal')
    node = make_node(1, 'S3F_FolderTimeline', 'Folder Processing Timeline', [80, 100], [520, 480],
        [input_port('mask_video', 'VIDEO', optional=True)],
        [output_port('project', 'S3F_MOTION_PROJECT', 0), output_port('timeline_path', 'STRING', 1)], list(settings.values()), 0)
    note = make_node(2, 'Note', 'Folder review · one video at a time', [680, 100], [480, 460], [], [], [
        '1. Set folder_path, leave operation on prepare, then Run.\n\n'
        '2. Open folder workspace. Previous/next arrows browse one clip at a time, with Timeline and Motion Studio together on the same page.\n\n'
        '3. Select a subfolder, expand Bulk automatic processing and process unscripted clips. Existing scripts, ignored videos and completed bulk drafts are skipped. Results wait for review.\n\n'
        '4. Refine any clip with the usual tracking, masks, stabilization, joins and audio tools. Existing scripts load in Main and can be improved manually.\n\n'
        '5. Approve & save next to video writes Main scripts beside the source. Approve & replace scripts backs up previous files. Nothing is approved automatically.\n\n'
        '6. Rate scripts from 1–5 stars, add notes, and filter by quality or script status. Ignore video keeps its draft and can be undone.\n\n'
        '7. Review completed clips during bulk processing. Pause after a clip, resume, or retry only failures. Subfolder presets set anchor preference, smoothing and range.\n\n'
        '8. Click review flags to inspect a range. Save named versions, compare with Main, or restore with a recovery copy. Approve & next speeds review.\n\n'
        'No output connections are required. Bulk uses the node’s model settings through ComfyUI’s queue. Completed drafts survive interruption.'
    ], 1)
    workflow = dict(last_node_id=2, last_link_id=0, nodes=[node,note], links=[], groups=[], config={}, extra={'ds':{'scale':1,'offset':[30,30]}}, version=.4)
    return workflow, {'1':{'class_type':'S3F_FolderTimeline','inputs':settings}}


if __name__=='__main__':
    workflow, api = build_workflow()
    for name,data in [('folder_timeline.json',workflow),('folder_timeline.api.json',api)]:
        (ROOT/'workflows'/name).write_text(json.dumps(data,indent=2)+'\n')
