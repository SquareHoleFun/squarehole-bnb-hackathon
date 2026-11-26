#!/usr/bin/env python3
"""Placeholder check of the route-only Sepolia rehearsal (F30 Q2: "different names and placeholders, so nothing is
spoiled"; docs/v2/sepolia-rehearsal.md).

What reaches the chain in the rehearsal is bytecode: the creation code of the three deployer libraries and of
`RouteRehearsalGenesis` (the four transactions), which embeds the creation and runtime code of everything the genesis
creates. Contract, file, variable and parameter names and comments never reach it; function, event and error names
reach it only as hashes (4-byte selectors, 32-byte event topics), which public signature databases map back to names.

This script checks, for the nine contracts the rehearsal deploys:
  1. ABI names: no function, event or error whose name contains a hint (FIT, Misfit, Square, Hole, Stonk, Sorter).
  2. Bytecode bytes: none of those words, case-insensitive, anywhere in the creation or runtime code (strict: any
     occurrence fails, readable or not), and every text-like printable run listed so the strings can be read.
  3. Hashes in the code: every PUSH4 immediate (function and error selectors, including the selectors of calls into
     other contracts) and every PUSH32 immediate (event topics; left-aligned error selectors) is collected; with
     --openchain they are looked up in the public openchain signature database and any known name containing a hint
     is reported.
  4. With --dry-run <forge run-latest.json>: the same byte and hash checks on the exact transaction inputs forge
     would broadcast.

Offline by default (steps 1, 2, 4 and the collection in 3). Exit status 1 when a hint is found.

Usage (from packages/contracts, after `forge build`):
  python3 script-py/rehearsal_name_scan.py [--dry-run broadcast/RehearseRouteSepolia.s.sol/11155111/dry-run/run-latest.json]
                                           [--openchain] [--json <report.json>]
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

# The nine contracts of the rehearsal: the three linked deployer libraries forge sends first, the genesis, and the five
# contracts the genesis creates in its constructor (RouteRehearsalGenesis's table).
REHEARSAL_ARTIFACTS = [
    "GenesisDeployers.sol/GenesisExecutorDeployer.json",
    "GenesisDeployers.sol/RehearsalTokenDeployer.json",
    "GenesisDeployers.sol/GenesisPoolDeployer.json",
    "RouteRehearsalGenesis.sol/RouteRehearsalGenesis.json",
    "RehearsalToken.sol/RehearsalToken.json",
    "FitPoolHook.sol/FitPoolHook.json",
    "FitFeeCollector.sol/FitFeeCollector.json",
    "FitBuybackBurner.sol/FitBuybackBurner.json",
    # The launch window's router (F33) replaced the one-shot bootstrap buyer at the same genesis nonce.
    "LaunchTaxRouter.sol/LaunchTaxRouter.json",
]

# The whole v2 system (docs/v2/sepolia-full.md, `--set full`, scanned in the neutral build `--out out-neutral`): the six
# linked deployer libraries, the randomness source, the genesis and everything it and `completeGenesis` create.
FULL_ARTIFACTS = [
    "GenesisDeployers.sol/GenesisAdapterDeployer.json",
    "GenesisDeployers.sol/GenesisVaultDeployer.json",
    "GenesisDeployers.sol/GenesisTokenDeployer.json",
    "GenesisDeployers.sol/GenesisPoolDeployer.json",
    "GenesisDeployers.sol/GenesisHookDeployer.json",
    "GenesisDeployers.sol/GenesisExecutorDeployer.json",
    "ChainlinkDrandSource.sol/ChainlinkDrandSource.json",
    "MisfitsGenesis.sol/MisfitsGenesis.json",
    "FitToken.sol/FitToken.json",
    "MisfitsCollection.sol/MisfitsCollection.json",
    "MisfitsVault.sol/MisfitsVault.json",
    "FitPoolHook.sol/FitPoolHook.json",
    "FitFeeCollector.sol/FitFeeCollector.json",
    "LaunchTaxRouter.sol/LaunchTaxRouter.json",
    "MisfitsPlaceholders.sol/MisfitsPlaceholders.json",
    "FitBuybackBurner.sol/FitBuybackBurner.json",
]

# The project's names: FIT, The Misfits ("misfit" contains "fit"), Square Hole, The Stonk, The Sorter.
HINT_WORDS = ("fit", "square", "stonk", "sorter", "hole")
HINT = re.compile("|".join(HINT_WORDS), re.IGNORECASE)
HINT_BYTES = [w.encode() for w in HINT_WORDS]
LINK_PLACEHOLDER = re.compile(r"__\$[0-9a-fA-F]{34}\$__")
OPENCHAIN = "https://api.openchain.xyz/signature-database/v1/lookup"

# ------------------------------------------------------------------------------------------------ keccak-256

_RC = [
    0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000, 0x000000000000808B,
    0x0000000080000001, 0x8000000080008081, 0x8000000000008009, 0x000000000000008A, 0x0000000000000088,
    0x0000000080008009, 0x000000008000000A, 0x000000008000808B, 0x800000000000008B, 0x8000000000008089,
    0x8000000000008003, 0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
    0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
]
_ROT = [[0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61], [28, 55, 25, 21, 56], [27, 20, 39, 8, 14]]
_MASK = (1 << 64) - 1


def _rol(v: int, n: int) -> int:
    return ((v << n) | (v >> (64 - n))) & _MASK if n else v


def _keccak_f(a: list[list[int]]) -> None:
    for rc in _RC:
        c = [a[x][0] ^ a[x][1] ^ a[x][2] ^ a[x][3] ^ a[x][4] for x in range(5)]
        d = [c[(x - 1) % 5] ^ _rol(c[(x + 1) % 5], 1) for x in range(5)]
        for x in range(5):
            for y in range(5):
                a[x][y] ^= d[x]
        b = [[0] * 5 for _ in range(5)]
        for x in range(5):
            for y in range(5):
                b[y][(2 * x + 3 * y) % 5] = _rol(a[x][y], _ROT[x][y])
        for x in range(5):
            for y in range(5):
                a[x][y] = b[x][y] ^ ((~b[(x + 1) % 5][y]) & b[(x + 2) % 5][y])
        a[0][0] ^= rc


def keccak256(data: bytes) -> bytes:
    rate = 136
    msg = bytearray(data) + b"\x01"
    msg += b"\x00" * ((-len(msg)) % rate)
    msg[-1] |= 0x80
    a = [[0] * 5 for _ in range(5)]
    for off in range(0, len(msg), rate):
        block = msg[off : off + rate]
        for i in range(rate // 8):
            a[i % 5][i // 5] ^= int.from_bytes(block[8 * i : 8 * i + 8], "little")
        _keccak_f(a)
    return b"".join(a[i % 5][i // 5].to_bytes(8, "little") for i in range(4))


# ------------------------------------------------------------------------------------------------ helpers


def canonical_type(param: dict) -> str:
    t = param["type"]
    if t.startswith("tuple"):
        return "(" + ",".join(canonical_type(c) for c in param["components"]) + ")" + t[len("tuple") :]
    return t


def signature(item: dict) -> str:
    return f"{item['name']}({','.join(canonical_type(p) for p in item.get('inputs', []))})"


def code_bytes(hex_code: str) -> bytes:
    """Artifact bytecode as bytes; unlinked library references become 20 zero bytes."""
    h = hex_code[2:] if hex_code.startswith("0x") else hex_code
    return bytes.fromhex(LINK_PLACEHOLDER.sub("0" * 40, h))


def push_immediates(code: bytes) -> tuple[set[str], set[str]]:
    """Linear sweep for the hashes in the code.

    4-byte values: every PUSH4 immediate (the dispatcher's selectors, calls into other contracts), the top four bytes
    of a left-aligned PUSH32, and `PUSHn v, PUSH1 s, SHL` with s >= 224 (solc's constant optimizer drops a
    selector's trailing zero bits, e.g. 0x7b37dc60 << 224 becomes PUSH4 0x03d9bee3, PUSH1 0xe5, SHL).
    32-byte values: every PUSH32 immediate (event topics).
    """
    p4: set[str] = set()
    p32: set[str] = set()
    ops: list[tuple[int, int]] = []  # (opcode, immediate as int; -1 when none)
    i = 0
    while i < len(code):
        op = code[i]
        if 0x60 <= op <= 0x7F:
            n = op - 0x5F
            imm = code[i + 1 : i + 1 + n]
            if n == 4 and len(imm) == 4:
                p4.add("0x" + imm.hex())
            elif n == 32 and len(imm) == 32:
                p32.add("0x" + imm.hex())
                if imm[4:] == b"\x00" * 28:
                    p4.add("0x" + imm[:4].hex())
            ops.append((op, int.from_bytes(imm, "big") if imm else 0))
            i += 1 + n
        else:
            ops.append((op, -1))
            i += 1
    for k in range(len(ops) - 2):
        (op_v, v), (op_s, s), (op_shl, _) = ops[k], ops[k + 1], ops[k + 2]
        if 0x60 <= op_v <= 0x7F and op_s == 0x60 and op_shl == 0x1B and 224 <= s < 256:
            word = (v << s) & ((1 << 256) - 1)
            if word and word & ((1 << 224) - 1) == 0:
                p4.add("0x" + (word >> 224).to_bytes(4, "big").hex())
    return p4, p32


def printable_runs(code: bytes, minimum: int) -> list[str]:
    return [m.group().decode() for m in re.finditer(rb"[\x20-\x7e]{%d,}" % minimum, code)]


def text_like(run: str) -> bool:
    """A printable run that reads as text (four lower-case letters in a row, or two words), not as opcodes."""
    return bool(re.search(r"[a-z]{4,}|[A-Za-z]+ [A-Za-z]+", run))


def byte_hints(code: bytes) -> list[dict]:
    """Every case-insensitive occurrence of a hint word in the raw bytes, with its printable context."""
    low = code.lower()
    hits = []
    for word in HINT_BYTES:
        start = 0
        while (i := low.find(word, start)) != -1:
            a, b = i, i + len(word)
            while a > 0 and 0x20 <= code[a - 1] <= 0x7E:
                a -= 1
            while b < len(code) and 0x20 <= code[b] <= 0x7E:
                b += 1
            hits.append({"offset": i, "word": word.decode(), "printable_context": code[a:b].decode(errors="replace")})
            start = i + 1
    return hits


def openchain_lookup(functions: list[str], events: list[str]) -> dict:
    """Unfiltered lookup (spam collisions included), in batches."""
    result: dict = {"function": {}, "event": {}}
    for kind, values in (("function", functions), ("event", events)):
        for k in range(0, len(values), 40):
            batch = values[k : k + 40]
            query = urllib.parse.urlencode({kind: ",".join(batch), "filter": "false"})
            req = urllib.request.Request(f"{OPENCHAIN}?{query}", headers={"User-Agent": "squarehole-rehearsal-scan"})
            with urllib.request.urlopen(req, timeout=30) as resp:
                body = json.load(resp)
            if not body.get("ok"):
                raise RuntimeError(f"openchain error: {body}")
            for h, entries in (body["result"].get(kind) or {}).items():
                result[kind][h] = [e["name"] for e in (entries or [])]
    return result


# ------------------------------------------------------------------------------------------------ main


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="out", help="forge out directory (default: out)")
    ap.add_argument("--dry-run", help="forge script run-latest.json whose transaction inputs are scanned too")
    ap.add_argument("--openchain", action="store_true", help="look the collected hashes up on openchain")
    ap.add_argument("--json", help="write the full report here")
    ap.add_argument("--set", choices=("route", "full"), default="route",
                    help="route: the route-only rehearsal's nine contracts (default); full: the whole v2 system")
    args = ap.parse_args()
    artifacts = FULL_ARTIFACTS if args.set == "full" else REHEARSAL_ARTIFACTS

    out = Path(args.out)
    findings: list[str] = []
    report: dict = {"contracts": {}, "transactions": [], "openchain": None}
    all_p4: set[str] = set()
    all_p32: set[str] = set()
    abi_functions: dict[str, str] = {}
    abi_events: dict[str, str] = {}

    for rel in artifacts:
        art = json.loads((out / rel).read_text())
        name = rel.split("/")[-1].removesuffix(".json")
        entry: dict = {"functions": {}, "events": {}, "errors": {}, "strings": [], "byte_hints": []}
        for item in art["abi"]:
            if item["type"] not in ("function", "event", "error"):
                continue
            sig = signature(item)
            h = keccak256(sig.encode())
            key = {"function": "functions", "event": "events", "error": "errors"}[item["type"]]
            digest = "0x" + (h.hex() if item["type"] == "event" else h[:4].hex())
            entry[key][sig] = digest
            (abi_events if item["type"] == "event" else abi_functions)[digest] = f"{name}.{sig}"
            if HINT.search(item["name"]):
                findings.append(f"ABI name: {name}.{sig}")
        # Forge's own selectors must match ours (library signatures use contract type names, e.g. IPoolManager).
        for sig, sel in art.get("methodIdentifiers", {}).items():
            abi_functions["0x" + sel] = f"{name}.{sig}"
            entry["functions"][sig] = "0x" + sel
        runtime = code_bytes(art["deployedBytecode"]["object"])
        creation = code_bytes(art["bytecode"]["object"])
        entry["sizes"] = {"creation": len(creation), "runtime": len(runtime)}
        for code in (creation, runtime):
            p4, p32 = push_immediates(code)
            all_p4 |= p4
            all_p32 |= p32
            for hit in byte_hints(code):
                entry["byte_hints"].append(hit)
                findings.append(f"hint bytes in {name} code at {hit['offset']}: {hit['printable_context']!r}")
        entry["strings"] = sorted(set(printable_runs(creation, 6) + printable_runs(runtime, 6)))
        entry["text_strings"] = [s for s in entry["strings"] if text_like(s)]
        report["contracts"][name] = entry

    if args.dry_run:
        run = json.loads(Path(args.dry_run).read_text())
        for tx in run.get("transactions", []):
            data = tx["transaction"].get("input") or tx["transaction"].get("data") or "0x"
            code = bytes.fromhex(data[2:])
            p4, p32 = push_immediates(code)
            all_p4 |= p4
            all_p32 |= p32
            hits = byte_hints(code)
            for hit in hits:
                findings.append(f"hint bytes in tx {tx.get('contractName')} at {hit['offset']}: {hit['printable_context']!r}")
            report["transactions"].append(
                {
                    "contract": tx.get("contractName"),
                    "address": tx.get("contractAddress"),
                    "input_bytes": len(code),
                    "input_keccak256": "0x" + keccak256(code).hex(),
                    "byte_hints": hits,
                    "text_strings": sorted(s for s in set(printable_runs(code, 6)) if text_like(s)),
                }
            )

    report["push4"] = sorted(all_p4)
    report["push32"] = sorted(all_p32)
    report["abi_selectors"] = abi_functions
    report["abi_topics"] = abi_events
    missing_sel = sorted(set(abi_functions) - all_p4)
    report["abi_selectors_not_in_code"] = {h: abi_functions[h] for h in missing_sel}

    if args.openchain:
        functions = sorted(all_p4 | set(abi_functions))
        events = sorted(all_p32 | set(abi_events))
        oc = openchain_lookup(functions, events)
        known = {k: {h: n for h, n in v.items() if n} for k, v in oc.items()}
        report["openchain"] = {"queried": {"function": len(functions), "event": len(events)}, "known": known}
        for kind, table in known.items():
            for h, names in table.items():
                for n in names:
                    if HINT.search(n.split("(")[0]):
                        findings.append(f"openchain {kind} {h} -> {n}")

    if args.json:
        Path(args.json).write_text(json.dumps(report, indent=2, sort_keys=True))

    print(f"contracts scanned: {len(artifacts)}; transactions scanned: {len(report['transactions'])}")
    print(f"4-byte values in the code: {len(all_p4)}; 32-byte values: {len(all_p32)}; ABI selectors not found in the "
          f"code: {len(report['abi_selectors_not_in_code'])}")
    for name, entry in report["contracts"].items():
        print(f"- {name}: creation {entry['sizes']['creation']} B, runtime {entry['sizes']['runtime']} B, "
              f"{len(entry['functions'])} functions, {len(entry['events'])} events, {len(entry['errors'])} errors, "
              f"hint bytes: {len(entry['byte_hints'])}")
        for s in entry["text_strings"]:
            print(f"    text: {s!r}")
    for tx in report["transactions"]:
        print(f"- tx {tx['contract']} -> {tx['address']}: input {tx['input_bytes']} B, keccak {tx['input_keccak256']}, "
              f"hint bytes: {len(tx['byte_hints'])}, text strings: {len(tx['text_strings'])}")
    if report["openchain"]:
        k = report["openchain"]["known"]
        print(f"openchain: {len(k['function'])} of {report['openchain']['queried']['function']} 4-byte values and "
              f"{len(k['event'])} of {report['openchain']['queried']['event']} 32-byte values have known names")
    if findings:
        print("HINTS FOUND:")
        for f in findings:
            print("  " + f)
        return 1
    print(f"no hint found ({', '.join(HINT_WORDS)}; case-insensitive)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
