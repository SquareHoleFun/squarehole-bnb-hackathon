#!/usr/bin/env python3
"""One drand quicknet round as `DrandSource.postRound(uint256 round, bytes signature)` takes it.

Prints the 96-byte uncompressed signature (x || y, 0x-prefixed), decompressed from api.drand.sh's published (compressed)
signature with script-py/drand_vectors.py's own decoder (the S9 vectors' code path), after checking that it compresses
back to the published bytes and that sha256 of it is the published randomness. Read-only: keyless HTTPS GETs to
drand's public relays (api.drand.sh first, then api2, api3 and drand.cloudflare.com when one answers with an error),
nothing signed or sent anywhere.

Usage (from packages/contracts):
  python3 scripts/drand-round.py <round>          # the round's signature, or exit 2 if it is not out yet
  python3 scripts/drand-round.py <round> --wait   # wait (up to 10 minutes) until the round is published
  python3 scripts/drand-round.py --time <round>   # the round's time (unix seconds), offline

Then (anyone may post a round once its time has come; the round's bounty pot goes to the poster):
  cast send <DrandSource> 'postRound(uint256,bytes)' <round> "$(python3 scripts/drand-round.py <round> --wait)" ...
"""
from __future__ import annotations

import sys

sys.dont_write_bytecode = True

import hashlib  # noqa: E402
import json  # noqa: E402
import time  # noqa: E402
import urllib.error  # noqa: E402
import urllib.request  # noqa: E402
from pathlib import Path  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "script-py"))

import drand_vectors as dv  # noqa: E402

WAIT_SECONDS = 600
# The League of Entropy's public HTTP relays for quicknet (the same chain hash as drand_vectors.API).
RELAYS = [dv.API] + [
    f"https://{host}/{dv.CHAIN_HASH}/public/" for host in ("api2.drand.sh", "api3.drand.sh", "drand.cloudflare.com")
]


def fetch(rnd: int) -> dict | None:
    """The round from the first relay that has it; None if a relay says it is not out yet; raises if none answers."""
    errors = []
    for base in RELAYS:
        try:
            # A plain User-Agent: drand.cloudflare.com refuses urllib's default one (HTTP 403).
            req = urllib.request.Request(base + str(rnd), headers={"User-Agent": "curl/8 (squarehole drand-round)"})
            with urllib.request.urlopen(req, timeout=30) as resp:  # noqa: S310 (fixed https URLs)
                data = json.load(resp)
        except urllib.error.HTTPError as e:
            # A relay answers 425 (Too Early) or 404 for a round that is not out yet.
            if e.code in (404, 425):
                return None
            errors.append(f"{base}: HTTP {e.code}")
            continue
        except (urllib.error.URLError, TimeoutError, ValueError) as e:
            errors.append(f"{base}: {e}")
            continue
        if data.get("round") != rnd:
            errors.append(f"{base}: answered round {data.get('round')}")
            continue
        return data
    raise RuntimeError("no drand relay answered: " + "; ".join(errors))


def signature_xy(data: dict) -> str:
    sig = bytes.fromhex(data["signature"])
    x, y = dv.g1_decompress(sig)
    if dv.g1_compress(x, y) != sig:
        raise RuntimeError("the decompressed point does not compress back to the published signature")
    if hashlib.sha256(sig).hexdigest() != data["randomness"]:
        raise RuntimeError("randomness != sha256(signature)")
    return "0x" + x.to_bytes(48, "big").hex() + y.to_bytes(48, "big").hex()


def main(argv: list[str]) -> int:
    if len(argv) >= 2 and argv[0] == "--time":
        print(dv.round_time(int(argv[1])))
        return 0
    if not argv:
        print(__doc__, file=sys.stderr)
        return 1
    rnd = int(argv[0])
    wait = "--wait" in argv[1:]
    deadline = time.time() + WAIT_SECONDS
    while True:
        try:
            data = fetch(rnd)
        except RuntimeError as e:
            if not wait or time.time() > deadline:
                print(str(e), file=sys.stderr)
                return 3
            print(f"{e}; trying again", file=sys.stderr)
            time.sleep(5)
            continue
        if data is not None:
            print(signature_xy(data))
            return 0
        if not wait or time.time() > deadline:
            left = dv.round_time(rnd) - int(time.time())
            print(f"round {rnd} is not published yet (its time is in {left} s)", file=sys.stderr)
            return 2
        time.sleep(max(1, min(10, dv.round_time(rnd) - int(time.time()) + 1)))


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
