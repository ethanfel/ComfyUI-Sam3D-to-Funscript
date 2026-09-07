"""Build the offline viewer from the same assets served by ComfyUI."""

import json
from pathlib import Path
import re

ASSETS = Path(__file__).resolve().parents[1] / "assets"


def standalone_html(project=None):
    html = (ASSETS / "viewer.html").read_text()
    css = (ASSETS / "viewer.css").read_text()
    script = (ASSETS / "viewer.js").read_text()

    def inline_module(match):
        names, filename = match.groups()
        source = (ASSETS / filename).read_text()
        # Timeline uses curve helpers, already bound by the preceding import.
        source = re.sub(r'^import \{[^}]+\} from "\./curve\.mjs";\n', "", source, flags=re.MULTILINE)
        source = re.sub(r"^export ", "", source, flags=re.MULTILINE)
        # Each module keeps its own scope (both export a different AXES constant).
        return f"const {{{names}}} = (() => {{\n{source}\nreturn {{{names}}};\n}})();"

    script = re.sub(r'import \{([^}]+)\} from "\./(curve\.mjs|timeline\.mjs|device-previews/device-wireframes\.mjs)";',
                    inline_module, script)
    script = script.replace("</script", "<\\/script")
    data = json.dumps(project, separators=(",", ":"), allow_nan=False).replace("<", "\\u003c")
    html = html.replace('<link rel="stylesheet" href="viewer.css">', f"<style>{css}</style>")
    return html.replace('<script type="module" src="viewer.js"></script>',
                        f'<script id="s3f-project" type="application/json">{data}</script>\n'
                        f'<script type="module">{script}</script>')
