#!/usr/bin/env python3
"""Bytecode hashes of every src/ contract in a Foundry build (F78, docs/evidence/SH-rehearsal-build.md).

  python3 scripts/bytecode-hashes.py <out-dir> > hashes.json        every src/ contract's creation and deployed bytecode
  python3 scripts/bytecode-hashes.py --compare <before.json> <after.json> [--markdown]
                                                                     identical, changed, added and removed contracts

The proof that the default (mainnet) build stays byte-identical when a source change is meant to change nothing in it:
hash every src/ contract's bytecode before and after (each from a clean `forge build --force`) and compare. Read from
each artifact's `metadata.settings.compilationTarget` (the source file and contract name), its `bytecode.object`
(creation code) and `deployedBytecode.object` (runtime code, immutables as zeros). sha256 of the lower-case hex text; a contract
with neither (an interface, a library of internal functions only) is listed with empty hashes. Read-only.
"""

import hashlib
import json
import os
import sys


def _hash(hex_code: str) -> str:
    """sha256 of the hex text (lower case, no 0x): unlinked library placeholders (`__$…$__`) are not hex bytes."""
    code = (hex_code[2:] if hex_code.startswith("0x") else hex_code).lower()
    if not code:
        return ""
    return hashlib.sha256(code.encode("ascii")).hexdigest()


def collect(out_dir: str) -> dict:
    rows = {}
    for root, _dirs, files in os.walk(out_dir):
        if os.path.basename(root) == "build-info":
            continue
        for name in files:
            if not name.endswith(".json"):
                continue
            with open(os.path.join(root, name), encoding="utf-8") as f:
                art = json.load(f)
            target = (art.get("metadata") or {}).get("settings", {}).get("compilationTarget") or {}
            for source, contract in target.items():
                if not source.startswith("src/"):
                    continue
                key = f"{source}:{contract}"
                creation = _hash(art.get("bytecode", {}).get("object", ""))
                runtime = _hash(art.get("deployedBytecode", {}).get("object", ""))
                size = len(art.get("deployedBytecode", {}).get("object", "").removeprefix("0x")) // 2
                rows[key] = {"creation": creation, "runtime": runtime, "runtimeBytes": size}
    return dict(sorted(rows.items()))


def compare(before: dict, after: dict, markdown: bool) -> int:
    same = [k for k in before if k in after and before[k] == after[k]]
    changed = [k for k in before if k in after and before[k] != after[k]]
    removed = [k for k in before if k not in after]
    added = [k for k in after if k not in before]
    with_code = [k for k in same if before[k]["runtime"] or before[k]["creation"]]
    if markdown:
        print("| Contract | Runtime bytes | Runtime sha256 (before = after) | Creation sha256 (before = after) |")
        print("|---|---:|---|---|")
        for k in with_code:
            r = before[k]
            print(f"| `{k}` | {r['runtimeBytes']:,} | `{r['runtime'][:16]}` | `{r['creation'][:16]}` |")
        print()
    print(f"src contracts: {len(before)} before, {len(after)} after")
    print(f"identical (creation and runtime): {len(same)} ({len(with_code)} with code)")
    for label, keys in (("CHANGED", changed), ("REMOVED", removed), ("ADDED", added)):
        print(f"{label}: {len(keys)}")
        for k in keys:
            print(f"  {k}")
    return 1 if changed or removed else 0


def main(argv: list) -> int:
    if len(argv) >= 3 and argv[0] == "--compare":
        with open(argv[1], encoding="utf-8") as f:
            before = json.load(f)
        with open(argv[2], encoding="utf-8") as f:
            after = json.load(f)
        return compare(before, after, "--markdown" in argv)
    if len(argv) == 1 and not argv[0].startswith("-"):
        json.dump(collect(argv[0]), sys.stdout, indent=1)
        print()
        return 0
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
