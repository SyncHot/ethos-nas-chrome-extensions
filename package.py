#!/usr/bin/env python3
"""Build a distributable zip of the browser extension.

The zip is what you copy to another machine and unpack into Chrome's
"Load unpacked" dialog (or upload to the Chrome Web Store).

    .venv/bin/python browser-extension/package.py

Output: browser-extension/dist/ethos-nas-downloader-<version>.zip
"""

import json
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DIST = ROOT / "dist"

INCLUDE_FILES = ("manifest.json", "README.md")
INCLUDE_DIRS = ("src", "icons")


def main() -> int:
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    version = manifest["version"]
    DIST.mkdir(parents=True, exist_ok=True)
    target = DIST / f"ethos-nas-downloader-{version}.zip"

    count = 0
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name in INCLUDE_FILES:
            path = ROOT / name
            if path.is_file():
                archive.write(path, path.relative_to(ROOT).as_posix())
                count += 1
        for folder in INCLUDE_DIRS:
            base = ROOT / folder
            if not base.is_dir():
                continue
            for path in sorted(base.rglob("*")):
                if not path.is_file() or path.suffix == ".py":
                    continue
                archive.write(path, path.relative_to(ROOT).as_posix())
                count += 1

    print(f"Wrote {target.relative_to(ROOT.parent)} — {count} files, {target.stat().st_size:,} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
