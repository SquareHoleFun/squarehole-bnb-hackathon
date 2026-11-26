#!/usr/bin/env python3
"""Real drand quicknet rounds for the box core's `DrandSource` (slice S9; docs/evidence/SH-S9-drand-source.md).

The same beacon, decoding and checks as `drand_vectors.py` (whose functions this script imports, so both files are
derived by one code path); only the rounds differ, because the box source fixes the first round at least 12 s
(`MARGIN`, F54) after a request instead of v2's 30 s or 70 minutes:
- the round a request at each pinned fork block fixes (mainnet 26,055,260 and Sepolia 11,780,483, the blocks the v2 fork
  suites already use), so the opt-in fork suites verify a real round on the real chains' state;
- 16 consecutive local rounds from 32,654,000 for the local suites (they warp the clock to match);
- round 1, the genesis round.

The committed file keeps the raw API fields next to the derived ones, so `--check` needs no network.

Usage (from packages/contracts):
  python3 script-py/drand_box_vectors.py --fetch   # fetch the rounds from api.drand.sh and (re)write the vectors
  python3 script-py/drand_box_vectors.py --check   # recompute every derived field from the committed raw fields
"""
from __future__ import annotations

import sys

sys.dont_write_bytecode = True

import json  # noqa: E402
import urllib.request  # noqa: E402
from pathlib import Path  # noqa: E402

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import drand_vectors as dv  # noqa: E402

OUT = HERE.parent / "test" / "vectors" / "drand-quicknet-box.json"

# DrandSource.MARGIN: a request's round is the first at least this long after the request's block.
MARGIN = 12
# Consecutive rounds for the local suites (2026-09-30, about 12:52 UTC; the first eight are drand_vectors.py's too).
LOCAL_FIRST = 32_654_000
LOCAL_COUNT = 16


def wanted_rounds() -> list[tuple[int, str]]:
    rounds: list[tuple[int, str]] = [(1, "genesis round")]
    rounds += [(LOCAL_FIRST + i, "local") for i in range(LOCAL_COUNT)]
    for name, (block, ts) in dv.FORKS.items():
        rounds.append((dv.round_at(ts + MARGIN), f"{name} fork block {block}: request + {MARGIN} s"))
    seen: dict[int, str] = {}
    for rnd, why in rounds:
        seen[rnd] = f"{seen[rnd]}; {why}" if rnd in seen else why
    return sorted(seen.items())


def derive(raw: list[dict]) -> dict:
    out = dv.derive(raw)
    out["schema"] = "squarehole.drand-quicknet-box/v1"
    out["generator"] = "packages/contracts/script-py/drand_box_vectors.py"
    out["margin"] = MARGIN
    return out


def fetch() -> list[dict]:
    raw = []
    for rnd, why in wanted_rounds():
        with urllib.request.urlopen(dv.API + str(rnd), timeout=30) as resp:  # noqa: S310 (fixed https URL)
            data = json.load(resp)
        assert data["round"] == rnd
        raw.append({"round": rnd, "why": why, "signature": data["signature"], "randomness": data["randomness"]})
    return raw


def main() -> int:
    mode = sys.argv[1] if len(sys.argv) > 1 else "--check"
    if mode == "--fetch":
        vectors = derive(fetch())
        OUT.write_text(json.dumps(vectors, indent=1) + "\n")
        print(f"wrote {OUT.relative_to(HERE.parent)}: {len(vectors['rounds'])} rounds")
        return 0
    if mode == "--check":
        committed = json.loads(OUT.read_text())
        raw = [
            {"round": r, "why": w, "signature": s[2:], "randomness": h[2:]}
            for r, w, s, h in zip(
                committed["rounds"], committed["why"], committed["signatures"], committed["randomness"], strict=True
            )
        ]
        again = derive(raw)
        if again != committed:
            print("box drand vectors differ from a recomputation", file=sys.stderr)
            return 1
        wanted = [r for r, _ in wanted_rounds()]
        if wanted != committed["rounds"]:
            print(f"the committed rounds are not the wanted ones: run --fetch ({wanted})", file=sys.stderr)
            return 1
        print(f"box drand vectors OK: {len(committed['rounds'])} rounds, every derived field recomputed")
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
