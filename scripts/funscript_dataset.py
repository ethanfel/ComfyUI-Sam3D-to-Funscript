"""Build or publish a public funscript snapshot without restarting ComfyUI."""
import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from sam3d_funscript.public_dataset import build_dataset, publish_dataset, validate_snapshot


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    build = commands.add_parser('build', help='Read saved Main results into a new local snapshot; no network or GPU work')
    build.add_argument('--store', required=True, type=Path, help='ComfyUI output/sam3d_funscript directory')
    build.add_argument('--output', required=True, type=Path, help='New public dataset directory')
    build.add_argument('--folder', action='append', help='Registered folder ID; repeat or omit for all registered folders')
    build.add_argument('--approved-only', action='store_true')
    build.add_argument('--use-folder-approval', action='store_true', help='Use approved labels only if local approvals represent scripts you personally validated; default labels everything draft')
    build.add_argument('--min-quality', type=int, default=0)
    check = commands.add_parser('check', help='Verify a local snapshot before upload')
    check.add_argument('directory', type=Path)
    publish = commands.add_parser('publish', help='Create/update a PUBLIC Hugging Face dataset using your HF login or HF_TOKEN')
    publish.add_argument('directory', type=Path)
    publish.add_argument('--repo', required=True, help='Hugging Face account/dataset-name')
    args = parser.parse_args()
    if args.command == 'build':
        result = build_dataset(args.store, args.output, folders=args.folder, approved_only=args.approved_only, min_quality=args.min_quality,
                               use_folder_approval=args.use_folder_approval)
        report_path = args.output.with_name(args.output.name + '.local-report.json')
        report_path.parent.mkdir(parents=True, exist_ok=True)
        with report_path.open('x', encoding='utf-8') as out:
            json.dump(result, out, indent=2)
        summary = {key: value for key, value in result.items() if key != 'skipped'}
        summary.update(dataset=str(args.output) if result['videos'] else None, local_report=str(report_path))
        print(json.dumps(summary, indent=2))
    elif args.command == 'check':
        manifest = validate_snapshot(args.directory)
        print(json.dumps({key: manifest[key] for key in ('schema', 'license', 'videos', 'variants', 'scripts')}, indent=2))
    else:
        os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
        print(json.dumps(publish_dataset(args.directory, args.repo), indent=2))


if __name__ == '__main__':
    main()
