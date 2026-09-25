"""Dedicated H3 Animator project workspace; no personal paths in the template."""
import json
from pathlib import Path
from create_folder_timeline_workflow import build_workflow as folder_workflow


def build_workflow(project_path=''):
    workflow, api = folder_workflow(project_path)
    node, note = workflow['nodes']
    node['type'] = api['1']['class_type'] = 'S3F_H3ProjectTimeline'
    node['properties']['Node name for S&R'] = node['type']
    node['title'] = 'H3 Animator · Funscript workspace'
    node['widgets_values'].pop(1)
    api['1']['inputs'].pop('include_subfolders')
    note['title'] = 'Start here · H3 project'
    note['widgets_values'] = [
        '1. Set folder_path to an H3 Animator project containing project.json and index.json. Leave operation on prepare and Run.\n\n'
        '2. Open H3 project workspace. Pages and panels follow reading order. The page/panel sidebar shows H3 main takes, including joined panels; All completed takes shows alternatives.\n\n'
        '3. Check drawings tests the full page, a clean panel image, or three frames of the selected video. Confidence starts at 0.15. Select a person box and Test 2 seconds to inspect real pose and motion before full processing.\n\n'
        '4. Exclude pages, panels (including future takes), or individual videos with no content to track. Restore them any time. Nothing is deleted.\n\n'
        '5. Select panels or page ranges without loading videos, then Start selected in the editable queue. Processing presets inherit from project to page to panel. Refine with the full Timeline and Motion Studio tools; approve to save scripts beside the video.\n\n'
        'Guide: docs/h3-project.md'
    ]
    return workflow, api


def main():
    root = Path(__file__).resolve().parents[1]
    for name, data in zip(('workflows/03_h3_project.json', 'extras/api/03_h3_project.api.json'), build_workflow()):
        (root / name).write_text(json.dumps(data, indent=2) + '\n')


if __name__ == '__main__':
    main()
