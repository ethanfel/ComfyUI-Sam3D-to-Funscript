"""Regenerate the three starters; --advanced also refreshes node recipes and fixtures."""

import argparse

import create_advanced_workflows
import create_folder_timeline_workflow
import create_h3_project_workflow
import create_processing_timeline_workflow


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--advanced', action='store_true')
    args = parser.parse_args()
    create_processing_timeline_workflow.main()
    create_folder_timeline_workflow.main()
    create_h3_project_workflow.main()
    if args.advanced:
        create_advanced_workflows.main()


if __name__ == '__main__':
    main()
