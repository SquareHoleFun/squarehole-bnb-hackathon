#!/usr/bin/env python3
"""Replay a DeployCoreV1 dry run on a LOCAL anvil fork (docs/runbooks/sepolia-core-v1.md, docs/evidence/SH-sepolia-prep.md).

Nothing here touches a public chain: every call goes to the local anvil given by --rpc (127.0.0.1 or localhost, ports
8550-8558), a fork of Sepolia started by `scripts/core-v1-simulate.sh sepolia-replay`. The sender of the dry run (the
testnet deployer) is IMPERSONATED with anvil_impersonateAccount, so no key exists anywhere: anvil accepts its
eth_sendTransaction without a signature. Each transaction of forge's PUBLIC dry-run record
(broadcast/DeployCoreV1.s.sol/<chain>/dry-run/run-latest.json; never forge's cache/ record, which holds sensitive values)
is sent exactly as recorded (to, input, value, nonce, forge's gas limit), one per block (anvil's automine), as the
founder's `--slow` broadcast sends them. Each must succeed and leave code at the address forge predicted.

Prints `REPLAY|...` lines and writes a JSON summary: per transaction the status, gas used, block and address; the totals
(gas used; SepETH at the given base fee; forge's reserve: the gas limits at twice the base fee plus its tip).

Usage: python3 scripts/core-v1-replay.py broadcast/DeployCoreV1.s.sol/11155111/dry-run/run-latest.json \
         --rpc http://127.0.0.1:8554 [--base-fee-wei <wei>] [--out .s7-sim/replay-sepolia.json]
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.request
from pathlib import Path

LOCAL = re.compile(r"^http://(127\.0\.0\.1|localhost):855[0-8]/?$")
PRIORITY_WEI = 1_000_000  # forge's 0.001 gwei tip on Sepolia (its dry run printed it)


def rpc(url: str, method: str, params: list):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    for attempt in range(6):
        req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=600) as resp:
            out = json.load(resp)
        if "error" not in out:
            return out["result"]
        # The fork fetches missing state from the public RPC, which sometimes drops a connection: reads are retried.
        if method.startswith("eth_get") and attempt < 5:
            time.sleep(2 * (attempt + 1))
            continue
        raise RuntimeError(f"{method}: {out['error']}")
    raise RuntimeError(f"{method}: no answer")


def receipt(url: str, tx_hash: str) -> dict:
    for _ in range(120):
        r = rpc(url, "eth_getTransactionReceipt", [tx_hash])
        if r:
            return r
        time.sleep(0.5)
    raise RuntimeError(f"no receipt for {tx_hash}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("dry_run")
    ap.add_argument("--rpc", default="http://127.0.0.1:8554")
    ap.add_argument("--base-fee-wei", type=int, default=0, help="the public chain's base fee, for the SepETH figures")
    ap.add_argument("--out")
    args = ap.parse_args()

    if not LOCAL.match(args.rpc):
        print("refusing: the replay only talks to a local anvil on 127.0.0.1:8550-8558", file=sys.stderr)
        return 2
    path = Path(args.dry_run)
    if "cache" in path.parts or path.parts[-2:] != ("dry-run", "run-latest.json") or "broadcast" not in path.parts:
        print("refusing: give forge's public dry-run record, broadcast/<script>/<chain>/dry-run/run-latest.json", file=sys.stderr)
        return 2

    run = json.loads(path.read_text())
    txs = run["transactions"]
    senders = {t["transaction"]["from"].lower() for t in txs}
    if len(senders) != 1:
        print(f"refusing: more than one sender in the record: {senders}", file=sys.stderr)
        return 2
    sender = senders.pop()
    chain = int(rpc(args.rpc, "eth_chainId", []), 16)
    first_nonce = int(txs[0]["transaction"]["nonce"], 16)
    nonce = int(rpc(args.rpc, "eth_getTransactionCount", [sender, "latest"]), 16)
    if nonce != first_nonce:
        print(f"stop: the sender's nonce is {nonce}, the record starts at {first_nonce} (the addresses would differ)", file=sys.stderr)
        return 1
    balance = int(rpc(args.rpc, "eth_getBalance", [sender, "latest"]), 16)
    print(f"REPLAY|chain {chain}|sender {sender}|nonce {nonce}|balance {balance} wei|{len(txs)} transactions")

    rpc(args.rpc, "anvil_impersonateAccount", [sender])
    rows = []
    try:
        for i, t in enumerate(txs):
            tx = t["transaction"]
            send = {"from": sender, "data": tx["input"], "value": tx.get("value", "0x0"), "gas": tx["gas"], "nonce": tx["nonce"]}
            if tx.get("to"):
                send["to"] = tx["to"]
            h = rpc(args.rpc, "eth_sendTransaction", [send])
            r = receipt(args.rpc, h)
            at = (t.get("contractAddress") or "").lower()
            code = rpc(args.rpc, "eth_getCode", [at, "latest"]) if at else "0x"
            created = (r.get("contractAddress") or "").lower()
            ok = int(r["status"], 16) == 1 and (t["transactionType"] != "CREATE" or created == at) and len(code) > 2
            row = {
                "step": i + 1,
                "type": t["transactionType"],
                "contract": t.get("contractName"),
                "address": at,
                "status": int(r["status"], 16),
                "gasLimit": int(tx["gas"], 16),
                "gasUsed": int(r["gasUsed"], 16),
                "block": int(r["blockNumber"], 16),
                "codeBytes": (len(code) - 2) // 2,
                "ok": ok,
            }
            rows.append(row)
            print(
                f"REPLAY|{row['step']}|{row['type']} {row['contract']}|{row['address']}|status {row['status']}|"
                f"gas used {row['gasUsed']}|limit {row['gasLimit']}|block {row['block']}|code {row['codeBytes']} bytes"
            )
            if not ok:
                print(f"stop: step {i + 1} failed (status, predicted address or code)", file=sys.stderr)
                return 1
    finally:
        rpc(args.rpc, "anvil_stopImpersonatingAccount", [sender])

    used = sum(r["gasUsed"] for r in rows)
    limits = sum(r["gasLimit"] for r in rows)
    value = sum(int(t["transaction"].get("value", "0x0"), 16) for t in txs)
    summary = {
        "chain": chain,
        "sender": sender,
        "firstNonce": first_nonce,
        "transactions": len(rows),
        "gasUsed": used,
        "gasLimits": limits,
        "valueWei": value,
        "baseFeeWei": args.base_fee_wei,
        "costAtBaseFeeWei": used * args.base_fee_wei + value,
        "forgeReserveWei": limits * (2 * args.base_fee_wei + PRIORITY_WEI) + value,
        "rows": rows,
    }
    print(f"REPLAY|total|gas used {used}|gas limits {limits}|value {value} wei")
    if args.base_fee_wei:
        print(
            f"REPLAY|at base fee {args.base_fee_wei / 1e9:.4f} gwei|cost {summary['costAtBaseFeeWei'] / 1e18:.6f} ETH|"
            f"forge reserves {summary['forgeReserveWei'] / 1e18:.6f} ETH (limits at 2 x base fee + 0.001 gwei)"
        )
    if args.out:
        Path(args.out).write_text(json.dumps(summary, indent=2) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
