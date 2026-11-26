#!/usr/bin/env python3
"""Real drand quicknet rounds as test vectors for `DrandQuicknet` / `ChainlinkDrandSource` (SH-V2-randomness).

quicknet (League of Entropy; https://api.drand.sh/v2/beacons/quicknet/info) signs sha256(round as 8 bytes, big-endian)
with BLS12-381, signatures on G1 (48 bytes compressed), the group key on G2 (96 bytes compressed), scheme
`bls-unchained-g1-rfc9380`; a round's randomness is sha256(compressed signature). The contracts take points
uncompressed (EIP-2537 encoding), because decompressing on chain needs a 381-bit exponentiation (about 37,000 gas under
EIP-7883). This script decompresses off chain, and checks for every round that the point is on the curve, compresses
back to the published bytes, and hashes to the published randomness. Whether a signature is *valid* is decided on chain
only (the pairing check in `DrandQuicknet.verify`), so nothing here needs to be trusted: a wrong point fails there.

The committed file keeps the raw API fields next to the derived ones, so `--check` needs no network.

Usage (from packages/contracts):
  python3 script-py/drand_vectors.py --fetch   # fetch the rounds below from api.drand.sh and (re)write the vectors
  python3 script-py/drand_vectors.py --check   # recompute every derived field from the committed raw fields
"""
from __future__ import annotations

import sys

sys.dont_write_bytecode = True

import hashlib  # noqa: E402
import json  # noqa: E402
import urllib.request  # noqa: E402
from pathlib import Path  # noqa: E402

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "test" / "vectors" / "drand-quicknet.json"

# The beacon (https://api.drand.sh/v2/beacons/quicknet/info, read 2026-09-30).
CHAIN_HASH = "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971"
PUBLIC_KEY = (
    "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc2"
    "2b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a"
)
GENESIS_TIME = 1_692_803_367
PERIOD = 3
DST = b"BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_"
API = f"https://api.drand.sh/{CHAIN_HASH}/public/"

# The source's delays (ChainlinkDrandSource): the round fixed at a request is the first one at least this long after it.
DRAND_DELAY = 30  # the wrapper refused or is disabled: drand at once
FALLBACK_DELAY = 70 * 60  # a Chainlink request was sent: drand if Chainlink is silent for 1 hour

# The pinned fork blocks of the opt-in fork suites (block number, timestamp read on chain).
FORKS = {
    "mainnet": (26_055_260, 1_790_348_891),
    "sepolia": (11_780_483, 1_790_354_496),
}
# Requests the fork suites make, as seconds after the fork block's timestamp (0: the fork block itself).
FORK_REQUEST_OFFSETS = (0,)
# Consecutive rounds for the local suites (they warp the clock to match): 2026-09-30, about 12:52 UTC.
LOCAL_FIRST = 32_654_000
LOCAL_COUNT = 8

P = 0x1A0111EA397FE69A4B1BA7B6434BACD764774B84F38512BF6730D2A0F6B0F6241EABFFFEB153FFFFB9FEFFFFFFFFAAAB
HALF = (P - 1) // 2
# G2 generator (x = x0 + x1·i, y = y0 + y1·i), the standard BLS12-381 constants.
G2 = (
    0x024AA2B2F08F0A91260805272DC51051C6E47AD4FA403B02B4510B647AE3D1770BAC0326A805BBEFD48056C8C121BDB8,
    0x13E02B6052719F607DACD3A088274F65596BD0D09920B61AB5DA61BBDC7F5049334CF11213945D57E5AC7D055D042B7E,
    0x0CE5D527727D6E118CC9CDC6DA2E351AADFD9BAA8CBDD3A76D429A695160D12C923AC9CC3BACA289E193548608B82801,
    0x0606C4A02EA734CC32ACD2B02BC28B99CB3E287E85A763AF267492AB572E99AB3F370D275CEC1DA1AAA9075FF05F79BE,
)


def round_at(timestamp: int) -> int:
    """The first round whose time is at or after `timestamp` (ChainlinkDrandSource.roundAt)."""
    if timestamp <= GENESIS_TIME:
        return 1
    return -(-(timestamp - GENESIS_TIME) // PERIOD) + 1


def round_time(rnd: int) -> int:
    return GENESIS_TIME + (rnd - 1) * PERIOD


# --- Fp and Fp2 ------------------------------------------------------------------------------------------------------


def fp_sqrt(a: int) -> int | None:
    r = pow(a, (P + 1) // 4, P)  # p ≡ 3 (mod 4)
    return r if r * r % P == a % P else None


def fp2_mul(a: tuple[int, int], b: tuple[int, int]) -> tuple[int, int]:
    return ((a[0] * b[0] - a[1] * b[1]) % P, (a[0] * b[1] + a[1] * b[0]) % P)


def fp2_sqrt(a: tuple[int, int]) -> tuple[int, int] | None:
    """A square root in Fp2 = Fp[i]/(i² + 1) via the norm (p ≡ 3 mod 4)."""
    a0, a1 = a
    if a1 == 0:
        r = fp_sqrt(a0)
        if r is not None:
            return (r, 0)
        r = fp_sqrt(-a0 % P)
        return (0, r) if r is not None else None
    alpha = fp_sqrt((a0 * a0 + a1 * a1) % P)
    if alpha is None:
        return None
    inv2 = pow(2, P - 2, P)
    for delta in ((a0 + alpha) * inv2 % P, (a0 - alpha) * inv2 % P):
        x0 = fp_sqrt(delta)
        if x0 is None or x0 == 0:
            continue
        x1 = a1 * pow(2 * x0, P - 2, P) % P
        cand = (x0, x1)
        if fp2_mul(cand, cand) == (a0 % P, a1 % P):
            return cand
    return None


# --- Points (ZCash compressed encoding) --------------------------------------------------------------------------------


def g1_decompress(data: bytes) -> tuple[int, int]:
    assert len(data) == 48, "a G1 point is 48 bytes compressed"
    flags = data[0] >> 5
    assert flags & 0b100, "compression flag"
    assert not flags & 0b010, "not the point at infinity"
    x = int.from_bytes(bytes([data[0] & 0x1F]) + data[1:], "big")
    assert x < P
    y = fp_sqrt((x * x * x + 4) % P)
    assert y is not None, "x is on the curve"
    if (y > HALF) != bool(flags & 0b001):
        y = P - y
    return x, y


def g1_compress(x: int, y: int) -> bytes:
    out = bytearray(x.to_bytes(48, "big"))
    out[0] |= 0x80 | (0x20 if y > HALF else 0)
    return bytes(out)


def fp2_larger(y: tuple[int, int]) -> bool:
    """ZCash's sign rule for Fp2: compare c1 first, c0 only when c1 is zero."""
    return y[1] > HALF if y[1] != 0 else y[0] > HALF


def g2_decompress(data: bytes) -> tuple[tuple[int, int], tuple[int, int]]:
    assert len(data) == 96, "a G2 point is 96 bytes compressed"
    flags = data[0] >> 5
    assert flags & 0b100 and not flags & 0b010
    x1 = int.from_bytes(bytes([data[0] & 0x1F]) + data[1:48], "big")  # c1 first
    x0 = int.from_bytes(data[48:], "big")
    x = (x0, x1)
    rhs = fp2_mul(fp2_mul(x, x), x)
    rhs = ((rhs[0] + 4) % P, (rhs[1] + 4) % P)  # + 4(1 + i)
    y = fp2_sqrt(rhs)
    assert y is not None, "x is on the twist"
    if fp2_larger(y) != bool(flags & 0b001):
        y = ((-y[0]) % P, (-y[1]) % P)
    return x, y


def g2_on_curve(x: tuple[int, int], y: tuple[int, int]) -> bool:
    rhs = fp2_mul(fp2_mul(x, x), x)
    rhs = ((rhs[0] + 4) % P, (rhs[1] + 4) % P)
    return fp2_mul(y, y) == rhs


def fp64(v: int) -> str:
    """One Fp element in EIP-2537 encoding (64 bytes, big-endian, top 16 bytes zero)."""
    return v.to_bytes(64, "big").hex()


# --- Vectors ------------------------------------------------------------------------------------------------------------


def wanted_rounds() -> list[tuple[int, str]]:
    rounds: list[tuple[int, str]] = [(1, "genesis round")]
    rounds += [(LOCAL_FIRST + i, "local") for i in range(LOCAL_COUNT)]
    for name, (block, ts) in FORKS.items():
        for off in FORK_REQUEST_OFFSETS:
            at = ts + off
            rounds.append((round_at(at + DRAND_DELAY), f"{name} fork block {block} + {off} s: drand at once"))
            rounds.append((round_at(at + FALLBACK_DELAY), f"{name} fork block {block} + {off} s: Chainlink fallback"))
    seen: dict[int, str] = {}
    for rnd, why in rounds:
        seen[rnd] = f"{seen[rnd]}; {why}" if rnd in seen else why
    return sorted(seen.items())


def derive(raw: list[dict]) -> dict:
    pk_x, pk_y = g2_decompress(bytes.fromhex(PUBLIC_KEY))
    assert g2_on_curve(pk_x, pk_y)
    assert g2_on_curve((G2[0], G2[1]), (G2[2], G2[3]))
    neg_g2_y = ((-G2[2]) % P, (-G2[3]) % P)
    out = {
        "schema": "squarehole.drand-quicknet/v1",
        "generator": "packages/contracts/script-py/drand_vectors.py",
        "source": API + "{round}",
        "chainHash": "0x" + CHAIN_HASH,
        "genesisTime": GENESIS_TIME,
        "period": PERIOD,
        "dst": DST.decode(),
        "publicKey": "0x" + PUBLIC_KEY,
        # EIP-2537 encoding: x.c0 || x.c1 || y.c0 || y.c1, 64 bytes each.
        "publicKeyG2": "0x" + fp64(pk_x[0]) + fp64(pk_x[1]) + fp64(pk_y[0]) + fp64(pk_y[1]),
        "negG2Generator": "0x" + fp64(G2[0]) + fp64(G2[1]) + fp64(neg_g2_y[0]) + fp64(neg_g2_y[1]),
        "forks": {name: {"block": b, "timestamp": t} for name, (b, t) in FORKS.items()},
        "rounds": [],
        "roundTimes": [],
        "why": [],
        "signatures": [],
        "randomness": [],
        # The uncompressed signature as `postRound` takes it: x (48 bytes) || y (48 bytes).
        "signaturesXY": [],
    }
    for r in raw:
        sig = bytes.fromhex(r["signature"])
        x, y = g1_decompress(sig)
        assert g1_compress(x, y) == sig, "compresses back to the published bytes"
        assert hashlib.sha256(sig).hexdigest() == r["randomness"], "randomness = sha256(signature)"
        out["rounds"].append(r["round"])
        out["roundTimes"].append(round_time(r["round"]))
        out["why"].append(r["why"])
        out["signatures"].append("0x" + r["signature"])
        out["randomness"].append("0x" + r["randomness"])
        out["signaturesXY"].append("0x" + x.to_bytes(48, "big").hex() + y.to_bytes(48, "big").hex())
    return out


def fetch() -> list[dict]:
    raw = []
    for rnd, why in wanted_rounds():
        with urllib.request.urlopen(API + str(rnd), timeout=30) as resp:  # noqa: S310 (fixed https URL)
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
            print("drand vectors differ from a recomputation", file=sys.stderr)
            return 1
        wanted = [r for r, _ in wanted_rounds()]
        if wanted != committed["rounds"]:
            print(f"the committed rounds are not the wanted ones: run --fetch ({wanted})", file=sys.stderr)
            return 1
        print(f"drand vectors OK: {len(committed['rounds'])} rounds, every derived field recomputed")
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
