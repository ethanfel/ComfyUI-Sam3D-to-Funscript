"""Generate the folder library / Civitai starter, without private media paths."""
import json
from pathlib import Path
from create_processing_timeline_workflow import make_node, input_port, output_port

ROOT = Path(__file__).resolve().parents[1]


def build_workflow(folder_path=''):
    settings = dict(folder_path=folder_path, include_subfolders=True, video_name='',
        model_file='sam_3d_body_dinov3_bf16.safetensors', sample_fps=0, batch_size=8,
        tracker_model='cotracker3_scaled_online.pth', operation='prepare', plan_json='{}', use_cache=True, cut_sensitivity='normal')
    node = make_node(1, 'S3F_FolderTimeline', 'Folder library · local clips + Civitai', [80, 100], [520, 480],
        [input_port('mask_video', 'VIDEO', optional=True)],
        [output_port('project', 'S3F_MOTION_PROJECT', 0), output_port('timeline_path', 'STRING', 1)], list(settings.values()), 0)
    note = make_node(2, 'Note', 'Start here · folder library', [696, 100], [460, 480], [], [], [
        '1. Set folder_path, leave operation on prepare, then Run.\n\n'
        '2. Open folder workspace. Browse Local clips or switch to Civitai. Both use the same Timeline and Motion Studio for review.\n\n'
        '3. Process a clip, or select a subfolder for bulk automatic processing. Bulk skips existing scripts and ignored clips.\n\n'
        '4. Review and refine, then approve to save scripts beside the video. Use ratings, notes and filters to organize your library.\n\n'
        'Civitai downloads stay temporary until approved into a category. Keep undecided drafts for later. Reject deletes only browser-created temporary downloads; existing local videos are kept.\n\n'
        'Guides: docs/folder-timeline.md and docs/civitai-browser.md'
    ], 1)
    note.update(color='#24343d', bgcolor='#30444f')
    workflow = dict(last_node_id=2, last_link_id=0, nodes=[node,note], links=[], groups=[], config={}, extra={'ds':{'scale':1,'offset':[30,30]}}, version=.4)
    return workflow, {'1':{'class_type':'S3F_FolderTimeline','inputs':settings}}


def main():
    workflow, api = build_workflow()
    for name,data in [('workflows/02_folder_library.json',workflow),('extras/api/02_folder_library.api.json',api)]:
        path = ROOT / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data,indent=2)+'\n')


if __name__=='__main__':
    main()
