"""Check release metadata and basic source hygiene.

Run from the project root:
    python scripts/check_release.py
"""

from __future__ import annotations

import ast
import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "extension" / "manifest.json"
CONTENT = ROOT / "extension" / "content.js"
POPUP_JS = ROOT / "extension" / "popup.js"
POPUP_HTML = ROOT / "extension" / "popup.html"
RUN_PY = ROOT / "run.py"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8-sig")


def fail(message: str) -> None:
    raise SystemExit(f"[FAIL] {message}")


def main() -> None:
    manifest = json.loads(read(MANIFEST))
    version = str(manifest.get("version", ""))
    expected = f"v{version}"
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        fail(f"manifest version is not semantic versioning: {version!r}")

    checks = {
        "content.js BUILD": f"var BUILD = '{expected}",
        "popup.js BUILD": f"const BUILD = '{expected}'",
        "popup.html version": f"id=\"ver\"",
    }
    for label, needle in checks.items():
        if needle not in read(CONTENT if label.startswith("content") else POPUP_JS if label.startswith("popup.js") else POPUP_HTML):
            fail(f"{label} does not contain {needle!r}")

    if f'>{expected}</span>' not in read(POPUP_HTML):
        fail(f"popup.html does not display {expected}")

    ast.parse(read(RUN_PY), filename=str(RUN_PY))

    code_files = [CONTENT, POPUP_JS, POPUP_HTML, RUN_PY]
    banned = {
        "fixed material folder variable": "var MATERIAL_" + "FOLDER =",
        "webdriver override": "navigator" + ".webdriver",
        "automation-control flag": "Automation" + "Controlled",
    }
    joined = "\n".join(read(path) for path in code_files)
    for label, token in banned.items():
        if token in joined:
            fail(f"found {label}: {token!r}")

    print(f"Release checks passed for {expected}.")


if __name__ == "__main__":
    main()
