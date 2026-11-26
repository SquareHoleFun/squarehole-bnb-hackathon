#!/usr/bin/env python3
"""Licence scan of everything Square Hole's production contracts import (committed so reviewers can re-run it).

Walks the import closure of every `src/**/*.sol` file, resolving Foundry's remappings from foundry.toml, and prints
each file with its `SPDX-License-Identifier`. Exits non-zero if any file in the closure is not MIT (the task's rule:
Square Hole contracts import only MIT-licensed interfaces and libraries; the BUSL-1.1 PoolManager is used only by
tests, which are outside this closure). No network.

Usage (from packages/contracts):  python3 script-py/check_src_licences.py
"""
from __future__ import annotations

import sys

sys.dont_write_bytecode = True

import re  # noqa: E402
from pathlib import Path  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
IMPORT = re.compile(r'^\s*import\s+(?:[^"\']*?\bfrom\s+)?["\']([^"\']+)["\']', re.M)
SPDX = re.compile(r"SPDX-License-Identifier:\s*([^\s*]+)")


def remappings() -> list[tuple[str, Path]]:
    text = (ROOT / "foundry.toml").read_text()
    block = text[text.index("remappings") : text.index("]", text.index("remappings"))]
    pairs = re.findall(r'"([^"=]+)=([^"]+)"', block)
    return sorted(((p, ROOT / t) for p, t in pairs), key=lambda x: -len(x[0]))


def resolve(spec: str, importer: Path, maps: list[tuple[str, Path]]) -> Path:
    if spec.startswith("."):
        return (importer.parent / spec).resolve()
    for prefix, target in maps:
        if spec.startswith(prefix):
            return (target / spec[len(prefix) :]).resolve()
    raise SystemExit(f"unresolved import {spec!r} in {importer.relative_to(ROOT)}")


def main() -> int:
    maps = remappings()
    todo = sorted((ROOT / "src").rglob("*.sol"))
    seen: dict[Path, str] = {}
    while todo:
        path = todo.pop()
        if path in seen:
            continue
        text = path.read_text()
        match = SPDX.search(text)
        seen[path] = match.group(1) if match else "NONE"
        todo.extend(resolve(spec, path, maps) for spec in IMPORT.findall(text))
    bad = 0
    for path in sorted(seen, key=lambda p: str(p)):
        licence = seen[path]
        bad += licence != "MIT"
        print(f"{licence:<10} {path.relative_to(ROOT)}")
    print(f"{len(seen)} files in the import closure of src/; {len(seen) - bad} MIT, {bad} other")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
