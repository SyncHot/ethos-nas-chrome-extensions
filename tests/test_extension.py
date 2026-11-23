#!/usr/bin/env python3
"""Static guard for this extension repository.

No server and no browser needed: verifies the MV3 manifest, that every file it
references exists, that the icons are real PNGs of the declared size, and that
the HTML/JS stay within Chrome's extension CSP (no inline scripts, no remote
code, no eval).

Run: python3 tests/test_extension.py
"""
import json
import re
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXT = ROOT
FAILURES = []

# Directories that are not extension sources (rglob is used for the secret scan).
SKIP_DIRS = {".git", "node_modules", "dist", "__pycache__"}

# Permissions the feature actually needs. Anything else must be added
# deliberately to this list in the same commit as the manifest change.
ALLOWED_PERMISSIONS = {
    "activeTab", "clipboardRead", "contextMenus", "downloads", "notifications",
    "scripting", "storage",
}


def check(name, ok, detail=""):
    suffix = f" — {detail}" if detail and not ok else ""
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}{suffix}")
    if not ok:
        FAILURES.append(name)
    return bool(ok)


def png_size(path: Path):
    """(width, height) from a PNG IHDR chunk, or None when not a PNG."""
    data = path.read_bytes()
    if not data.startswith(b"\x89PNG\r\n\x1a\n") or len(data) < 24:
        return None
    return struct.unpack(">II", data[16:24])


def main() -> int:
    print("Browser extension guard")

    manifest_path = EXT / "manifest.json"
    check("manifest.json exists", manifest_path.is_file())
    if not manifest_path.is_file():
        return 1

    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        check("manifest.json is valid JSON", False, str(exc))
        return 1
    check("manifest.json is valid JSON", True)
    check("Manifest V3", manifest.get("manifest_version") == 3, str(manifest.get("manifest_version")))
    check("version is semver", bool(re.fullmatch(r"\d+\.\d+\.\d+", str(manifest.get("version", "")))),
          str(manifest.get("version")))
    check("name + description are set", bool(manifest.get("name") and manifest.get("description")))

    permissions = set(manifest.get("permissions") or [])
    check("permissions are allowlisted", permissions <= ALLOWED_PERMISSIONS,
          f"unexpected: {sorted(permissions - ALLOWED_PERMISSIONS)}")
    check("capture needs downloads+storage", {"downloads", "storage"} <= permissions)
    check("clipboard auto-fill needs clipboardRead", "clipboardRead" in permissions)
    hosts = manifest.get("host_permissions") or []
    check("host permissions are http(s) only",
          bool(hosts) and all(re.fullmatch(r"https?://[^/]+/\*", h) for h in hosts), str(hosts))

    background = (manifest.get("background") or {}).get("service_worker")
    check("service worker is a module and exists",
          (manifest.get("background") or {}).get("type") == "module"
          and bool(background) and (EXT / background).is_file(), str(background))

    action = manifest.get("action") or {}
    popup = action.get("default_popup")
    check("action popup exists", bool(popup) and (EXT / popup).is_file(), str(popup))
    options_page = (manifest.get("options_ui") or {}).get("page")
    check("options page exists", bool(options_page) and (EXT / options_page).is_file(), str(options_page))

    for index, script in enumerate(manifest.get("content_scripts") or []):
        check(f"content script #{index} matches http(s)",
              script.get("matches") == ["http://*/*", "https://*/*"], str(script.get("matches")))
        for js in script.get("js") or []:
            check(f"content script file {js} exists", (EXT / js).is_file())

    for key, path in (manifest.get("icons") or {}).items():
        icon = EXT / path
        size = png_size(icon) if icon.is_file() else None
        check(f"icon {key} is a {key}px PNG", size == (int(key), int(key)), str(size))
    for key, path in ((action.get("default_icon")) or {}).items():
        check(f"action icon {key} exists", (EXT / path).is_file(), path)

    commands = manifest.get("commands") or {}
    check("keyboard shortcut is declared", "send-current-tab" in commands)

    # ── Files: imports, CSS/JS links, CSP ──────────────────────────────────
    js_files = sorted(EXT.glob("src/**/*.js"))
    check("JavaScript files exist", len(js_files) >= 4, str(len(js_files)))
    for path in js_files:
        text = path.read_text(encoding="utf-8")
        rel = path.relative_to(EXT)
        check(f"{rel}: no eval/new Function", "eval(" not in text and "new Function(" not in text)
        for target in re.findall(r"""from\s+["'](\.[^"']+)["']""", text):
            resolved = (path.parent / target).resolve()
            check(f"{rel}: import {target} exists", resolved.is_file(), str(resolved))

    for path in sorted(EXT.glob("src/*.html")):
        text = path.read_text(encoding="utf-8")
        rel = path.relative_to(EXT)
        check(f"{rel}: no inline <script>", not re.search(r"<script(?![^>]*\bsrc=)[^>]*>", text, re.I))
        check(f"{rel}: no inline event handlers", not re.search(r"\son[a-z]+\s*=", text, re.I))
        check(f"{rel}: no remote assets", not re.search(r"(?:src|href)\s*=\s*[\"']https?://", text, re.I))
        for asset in re.findall(r"""(?:src|href)=["']([^"']+)["']""", text):
            if asset.startswith("#") or "://" in asset:
                continue
            check(f"{rel}: asset {asset} exists", (path.parent / asset).is_file(), asset)

    shared = EXT / "src" / "lib" / "shared.js"
    check("shared settings module exists", shared.is_file())
    if shared.is_file():
        text = shared.read_text(encoding="utf-8")
        for symbol in ("DEFAULT_SETTINGS", "classifyLink", "normalizeNasUrl", "HOSTER_DOMAINS",
                       "normCategoryList", "categoryLabel"):
            check(f"shared.js exports {symbol}", f"export" in text and symbol in text)

    # The README is the install guide — keep it.
    check("README.md exists", (EXT / "README.md").is_file())
    check("packaging script exists", (EXT / "package.py").is_file())
    check("icon generator exists", (EXT / "scripts" / "make-icons.py").is_file())

    # ── Destination handling ───────────────────────────────────────────────
    # Every send path must forward the picked category: right-click menus and
    # captured downloads use the stored default, .torrent uploads pass it as a
    # query parameter (the NAS applies folder > category > download_dir).
    background_text = (EXT / "src" / "background.js").read_text(encoding="utf-8")
    check(".torrent uploads forward the category",
          'query.set("category", category)' in background_text)
    check("postTorrent receives the category",
          "postTorrent(url, { name: name || fileNameFromUrl(url), folder, category })"
          in background_text)
    popup_text = (EXT / "src" / "popup.js").read_text(encoding="utf-8")
    check("popup persists the picked category",
          'persistDestination({ category: $("category").value })' in popup_text)
    check("popup persists the folder default",
          'persistDestination({ folder: $("folder").value.trim() })' in popup_text)

    # ── No secrets committed ───────────────────────────────────────────────
    leaked_files = []
    for path in EXT.rglob("*"):
        if any(part in SKIP_DIRS for part in path.parts):
            continue
        if not path.is_file() or path.suffix not in {".js", ".json", ".html", ".md", ".py"}:
            continue
        if re.search(r"ethos_[0-9a-f]{48}", path.read_text(encoding="utf-8", errors="replace")):
            leaked_files.append(path.relative_to(EXT).as_posix())
    check("no hardcoded API key", not leaked_files, ", ".join(leaked_files))

    if FAILURES:
        print(f"\n{len(FAILURES)} check(s) failed: {', '.join(FAILURES)}")
        return 1
    print("\nAll browser-extension checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
