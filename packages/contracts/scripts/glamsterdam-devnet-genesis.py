#!/usr/bin/env python3
"""The genesis of a LOCAL geth devnet that runs Sepolia's Glamsterdam rules (docs/evidence/SH-glamsterdam-after.md).

geth v1.17.7 (`geth --dev dumpgenesis`: the system contracts, the CREATE2 deployer, the precompiles' balances) with
Sepolia's chain id (11155111, which the DrandSource pin and the spec files need), Amsterdam active from block 0
(`amsterdamTime: 0`; the dev config's later `bogotaTime` removed), Sepolia's 60,000,000 gas limit and a 1-gwei base fee,
plus the Sepolia accounts box 0's deployment and life read, as Sepolia has them at --block (code, balance, nonce, and
the PoolManager's owner slot; every other slot they read is a fresh pool's, zero on Sepolia): Uniswap v4's PoolManager,
Uniswap's PoolSwapTest, WETH9, the CREATE2 deployer, the zero address and the testnet deployer (the spec files'
platform). Then the rehearsal's own accounts, `--account <address>=<wei>[:<nonce>]`, each a throwaway key made for the
devnet (never a real wallet's). Sepolia is only read, through a keyless public RPC (--rpc).

  python3 scripts/glamsterdam-devnet-genesis.py --dev-genesis dev.json --out genesis.json --time <unix seconds> \
      --account 0x...=2536417132133740072:13 --account 0x...=2618476857580613200
"""
from __future__ import annotations

import argparse
import json
import time
import urllib.request

SEPOLIA = 11_155_111
POOL_MANAGER = "0xe03a1074c86cfedd5c142c4f04f1a1536e203543"
SEPOLIA_ACCOUNTS = {
    POOL_MANAGER: ["0x0"],  # its owner (Owned, slot 0); protocolFeeController (slot 2) is zero on Sepolia
    "0x9b6b46e2c869aa39918db7f52f5557fe577b6eee": [],  # PoolSwapTest (the runbook's SWAPTEST)
    "0xfff9976782d46cc05630d1f6ebab18b2324d6b14": [],  # WETH9
    "0x4e59b44847b379578588920ca78fbf26c0b4956c": [],  # the CREATE2 deployer (DrandSourcePins.DEPLOYER)
    "0x0000000000000000000000000000000000000000": [],
    "0x1f1481667ef20928d55524dfe4640f96bd9b4eee": [],  # the testnet deployer: the spec files' platform
}


def rpc(url: str, method: str, params: list) -> object:
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    for attempt in range(6):
        try:
            req = urllib.request.Request(url, body, {"Content-Type": "application/json", "User-Agent": "curl/8.7.1"})
            reply = json.load(urllib.request.urlopen(req, timeout=60))
            if "error" in reply:
                raise RuntimeError(reply["error"])
            return reply["result"]
        except Exception:
            if attempt == 5:
                raise
            time.sleep(2 * (attempt + 1))
    raise AssertionError("unreachable")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dev-genesis", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--rpc", default="https://ethereum-sepolia-rpc.publicnode.com")
    ap.add_argument("--block", default="latest")
    ap.add_argument("--time", type=int, default=0, help="genesis timestamp (default: now - 30 s)")
    ap.add_argument("--account", action="append", default=[], help="address=wei[:nonce]")
    a = ap.parse_args()

    dev = json.load(open(a.dev_genesis))
    cfg = dict(dev["config"])
    cfg["chainId"] = SEPOLIA
    cfg.pop("bogotaTime", None)
    cfg["amsterdamTime"] = 0
    alloc = {("0x" + k.lower().removeprefix("0x")): v for k, v in dev["alloc"].items()}
    block = a.block
    if block == "latest":
        block = rpc(a.rpc, "eth_blockNumber", [])
    if int(rpc(a.rpc, "eth_chainId", []), 16) != SEPOLIA:
        raise SystemExit("--rpc is not Sepolia")
    read = {}
    for addr, slots in SEPOLIA_ACCOUNTS.items():
        entry = {
            "balance": hex(int(rpc(a.rpc, "eth_getBalance", [addr, block]), 16)),
            "nonce": hex(int(rpc(a.rpc, "eth_getTransactionCount", [addr, block]), 16)),
        }
        code = rpc(a.rpc, "eth_getCode", [addr, block])
        if len(code) > 2:
            entry["code"] = code
        storage = {}
        for s in slots:
            value = rpc(a.rpc, "eth_getStorageAt", [addr, s, block])
            if int(value, 16):
                storage["0x" + format(int(s, 16), "064x")] = value
        if storage:
            entry["storage"] = storage
        alloc[addr] = entry
        read[addr] = {"code bytes": max(0, len(code) // 2 - 1), "slots": len(storage)}
    for spec in a.account:
        addr, rest = spec.split("=", 1)
        wei, _, nonce = rest.partition(":")
        alloc[addr.lower()] = {"balance": hex(int(wei)), "nonce": hex(int(nonce or 0))}
    genesis = {
        "config": cfg,
        "nonce": "0x0",
        "timestamp": hex(a.time or int(time.time()) - 30),
        "extraData": "0x",
        "gasLimit": hex(60_000_000),
        "difficulty": "0x0",
        "mixHash": "0x" + "00" * 32,
        "coinbase": "0x" + "00" * 20,
        "alloc": alloc,
        "number": "0x0",
        "gasUsed": "0x0",
        "parentHash": "0x" + "00" * 32,
        "baseFeePerGas": hex(1_000_000_000),
    }
    json.dump(genesis, open(a.out, "w"), indent=1)
    print(json.dumps({"sepolia block": int(block, 16), "read": read, "accounts": a.account}))


if __name__ == "__main__":
    main()
