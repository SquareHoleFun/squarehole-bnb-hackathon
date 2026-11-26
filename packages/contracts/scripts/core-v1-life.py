#!/usr/bin/env python3
"""A quick life of box 0 on a LOCAL anvil fork after `core-v1-simulate.sh sepolia-replay` (F78; docs/evidence/
SH-rehearsal-build.md): the launch window waited out, the curve filled through the Universal Router 2.1.2, graduate(),
then the fee batch, FIT's buy-and-burn and the hook's depth steps (a conversion and a pair), each step's size printed
beside the build's minimum. Written for the rehearsal build (FOUNDRY_PROFILE=rehearsal: R 0.4206980085 ETH, the fixed
ETH amounts at 1/10); it reads every minimum from the deployed contracts, so it runs on the mainnet build too (with
`--fill-eth` and `--gift-eth` ten times larger).

Nothing here touches a public chain: every call goes to the local anvil given by --rpc (127.0.0.1 or localhost, ports
8550-8558, chain id 11155111, anvil). The accounts (a buyer, a keeper, a depth gifter: fixed labels' addresses that no
key controls) are IMPERSONATED with anvil_impersonateAccount and given their ETH with anvil_setBalance, so no key exists
anywhere. Waiting is anvil_mine (blocks 12 s apart). Calldata comes from `cast calldata` / `cast abi-encode`, reads from
`cast call`.

Steps (each prints a `LIFE|...` line; the JSON summary has them all):
 1. wait out the launch window (F80: blocks 12 s apart until one's time reaches the hook's windowEndsAt, Unix seconds);
 2. fill: the buyer's exact-input buy of --fill-eth through UR 2.1.2 (V4_SWAP: SWAP_EXACT_IN_SINGLE with the
    minHopPriceX36 layout, SETTLE_ALL, TAKE_ALL; then SWEEP of the unspent ETH back to the buyer): the swap ends at or
    beyond P1, so the hook closes the curve in it (D1);
 3. graduate() by the keeper (its reward: the reserve, 0.1% of R);
 4. a buy after graduation through UR 2.1.2 (--trade-eth), so the pool has fees beside the curve's;
 5. collect(keeper): the batch against batchMin() (FEE_BATCH_MIN_ETH) and the tip against tipMax(); payFit() and the
    launch router's sweep() when they have something;
 6. FIT's executor: its 1-hour average from pokes (13 × 25 blocks, 300 s), then execute(): the buy-and-burn, its
    budget against batchThreshold() (0.05% of FIT's market cap);
 7. deepen() on the fill's own depth budget (read-only: shows the budget against minAdd());
 8. a fundDepth() gift of --gift-eth (Q-only money, as the launch tax or the platform's excess above the cap), then
    deepen(): the swap engine's conversion (against DEPTH_CONVERT_MIN_Q) and the pair (against minAdd()). A price-guard
    skip (the average still following the price; ConvertBelowMin while FIT's own buy left the band only a sliver of
    room) waits 20 minutes of pokes and tries again; if only the conversion ran, an hour on (its cooldown), the pair.

Usage (from packages/contracts, the fork's anvil still running):
  python3 scripts/core-v1-life.py --rpc http://127.0.0.1:8550 --registry <registry> [--fill-eth 0.43] \
    [--trade-eth 0.1] [--gift-eth 0.005] [--out .s7-sim/life.json]
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
import urllib.request
from decimal import Decimal
from pathlib import Path

LOCAL = re.compile(r"^http://(127\.0\.0\.1|localhost):855[0-8]/?$")
SEPOLIA = 11_155_111
UR_2_1_2 = "0x7E4f6c5e954Da5c61B3423D81E2277431Ac043f3"
NATIVE = "0x0000000000000000000000000000000000000000"
WEI = 10**18
DEPTH_KIND = ["None", "Pair", "Convert"]
DEEPEN_SKIP = [
    "None",
    "NotGraduated",
    "Cooldown",
    "AverageNotReady",
    "AverageNotCaughtUp",
    "Deviation",
    "BudgetBelowMin",
    "ConvertBelowMin",
]
EXEC_STOP = ["MaxChunks", "BlockLimit", "BudgetSpent", "AtCeiling", "AtReserve", "NoLiquidity", "TwapNotReady", "NotGraduated", "BelowBatch"]
# graduate()'s gas limit: each of its four pokes is handed POKE_GAS (2,600,000 since F95), so 3,000,000 is refused
# (GasTooLow); about 12.9M with every poke burning its budget (SH-box0-stream-gas). FILL_GAS: the filling buy's limit;
# SEND_GAS: Fork.send's default for every other send.
GRADUATE_GAS = 15_000_000
FILL_GAS = 6_000_000
SEND_GAS = 3_000_000
GWEI = 10**9


class Fork:
    def __init__(self, url: str):
        self.url = url
        self.steps: list[dict] = []

    def rpc(self, method: str, params: list):
        body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
        for attempt in range(6):
            req = urllib.request.Request(self.url, data=body, headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=900) as resp:
                out = json.load(resp)
            if "error" not in out:
                return out["result"]
            # The fork fetches missing state from the public RPC, which sometimes drops a connection: reads are retried.
            if (method.startswith("eth_get") or method == "eth_call") and attempt < 5:
                time.sleep(2 * (attempt + 1))
                continue
            raise RuntimeError(f"{method}: {out['error']}")
        raise RuntimeError(f"{method}: no answer")

    def cast(self, *args: str) -> str:
        cmd = ["cast", *args]
        if args[0] == "call":
            cmd += ["--rpc-url", self.url]
        for attempt in range(4):
            p = subprocess.run(cmd, capture_output=True, text=True)
            if p.returncode == 0:
                return p.stdout.strip()
            if args[0] == "call" and attempt < 3 and ("connection" in p.stderr or "error sending" in p.stderr):
                time.sleep(2 * (attempt + 1))
                continue
            raise RuntimeError(f"cast {' '.join(args)}: {p.stderr.strip()}")
        raise RuntimeError("cast: no answer")

    def call(self, to: str, sig: str, *args: str, sender: str | None = None) -> list[str]:
        extra = ["--from", sender] if sender else []
        out = self.cast("call", to, sig, *args, *extra)
        # cast prints one decoded value a line; "123 [1.23e2]" keeps the exact number first.
        return [line.split(" [")[0].strip() for line in out.splitlines()]

    def uint(self, to: str, sig: str, *args: str) -> int:
        return int(self.call(to, sig, *args)[0])

    def block(self) -> int:
        return int(self.rpc("eth_blockNumber", []), 16)

    def balance(self, who: str) -> int:
        return int(self.rpc("eth_getBalance", [who, "latest"]), 16)

    def mine(self, blocks: int, interval: int = 12) -> None:
        # A fork mines slowly (each block may read the public RPC): 25 blocks a call.
        while blocks > 0:
            n = min(blocks, 25)
            self.rpc("anvil_mine", [hex(n), hex(interval)])
            blocks -= n

    def label(self, name: str) -> str:
        return "0x" + self.cast("keccak", name)[-40:]

    def account(self, name: str, eth_wei: int) -> str:
        a = self.cast("to-check-sum-address", self.label(name))
        self.rpc("anvil_impersonateAccount", [a])
        self.rpc("anvil_setBalance", [a, hex(eth_wei)])
        return a

    def funding(self, gas: int, value: int, at_least: int) -> int:
        """ETH an account needs for a send of `value` with a `gas` limit. The node checks gas × the max fee + value
        before it takes the send, and anvil fills the max fee from the base fee (0.3 ETH for 15,000,000 is refused at
        a 25-gwei base fee: SH-box0-stream-gas § The review of 0bfeed8b), so: the value plus twice gas × (2 × the latest
        base fee + 2 gwei), and never less than `at_least`."""
        base = int(self.rpc("eth_getBlockByNumber", ["latest", False])["baseFeePerGas"], 16)
        return max(at_least, value + 2 * gas * (2 * base + 2 * GWEI))

    def send(self, sender: str, to: str, data: str, value: int = 0, what: str = "", gas: int = SEND_GAS) -> dict:
        # An explicit gas limit, as a wallet or keeper sets one: anvil's own estimate runs in the pending block's
        # context, which on a fork whose clock was moved on (anvil_mine with an interval) need not be the mined block's,
        # so an estimate can follow a cheaper path (e.g. FIT's average "not ready") than the transaction then takes.
        h = self.rpc("eth_sendTransaction", [{"from": sender, "to": to, "data": data, "value": hex(value), "gas": hex(gas)}])
        for _ in range(240):
            r = self.rpc("eth_getTransactionReceipt", [h])
            if r:
                break
            time.sleep(0.5)
        else:
            raise RuntimeError(f"{what}: no receipt for {h}")
        if int(r["status"], 16) != 1:
            p = subprocess.run(["cast", "run", h, "--rpc-url", self.url], capture_output=True, text=True)
            trace = "\n".join((p.stdout + p.stderr).splitlines()[-40:])
            raise RuntimeError(f"{what}: transaction {h} reverted (gas used {int(r['gasUsed'], 16)})\n{trace}")
        return {"tx": h, "gasUsed": int(r["gasUsed"], 16), "block": int(r["blockNumber"], 16), "logs": len(r["logs"])}

    def record(self, step: str, **fields) -> None:
        self.steps.append({"step": step, **fields})
        shown = "|".join(f"{k} {eth(v) if k.endswith('Wei') else v}" for k, v in fields.items())
        print(f"LIFE|{step}|{shown}", flush=True)


def eth(wei: int) -> str:
    return f"{Decimal(wei) / Decimal(WEI):.10f}".rstrip("0").rstrip(".") + " ETH"


def ur_buy(f: Fork, token: str, hook: str, amount: int, recipient: str, deadline: int, sweep: bool) -> str:
    """UR 2.1.2: V4_SWAP (SWAP_EXACT_IN_SINGLE with minHopPriceX36 0, SETTLE_ALL, TAKE_ALL) [+ SWEEP of ETH]."""
    key = f"({NATIVE},{token},10000,60,{hook})"
    p0 = f.cast("abi-encode", "f(((address,address,uint24,int24,address),bool,uint128,uint128,uint256,bytes))", f"({key},true,{amount},1,0,0x)")
    p1 = f.cast("abi-encode", "f(address,uint256)", NATIVE, str(amount))
    p2 = f.cast("abi-encode", "f(address,uint256)", token, "1")
    swap = f.cast("abi-encode", "f(bytes,bytes[])", "0x060c0f", f"[{p0},{p1},{p2}]")
    if not sweep:
        return f.cast("calldata", "execute(bytes,bytes[],uint256)", "0x10", f"[{swap}]", str(deadline))
    sweep_in = f.cast("abi-encode", "f(address,address,uint256)", NATIVE, recipient, "0")
    return f.cast("calldata", "execute(bytes,bytes[],uint256)", "0x1004", f"[{swap},{sweep_in}]", str(deadline))


def timestamp(f: Fork) -> int:
    return int(f.rpc("eth_getBlockByNumber", ["latest", False])["timestamp"], 16)


def spot_tick(f: Fork, hook: str) -> int:
    """The pool's tick from the PoolManager (extsload of the pool's slot0: StateLibrary's layout at 46c68346)."""
    pm = f.call(hook, "poolManager()(address)")[0]
    pool_id = f.call(hook, "poolId()(bytes32)")[0]
    slot = f.cast("keccak", f.cast("abi-encode", "f(bytes32,uint256)", pool_id, "6"))
    word = int(f.call(pm, "extsload(bytes32)(bytes32)", slot)[0], 16)
    tick = (word >> 160) & 0xFFFFFF
    return tick - (1 << 24) if tick >= 1 << 23 else tick


def deepen_preview(f: Fork, hook: str, keeper: str) -> dict:
    kind, skip, q_used, t_used, tip = f.call(hook, "deepen(address)(uint8,uint8,uint256,uint256,uint256)", keeper, sender=keeper)
    return {"kind": DEPTH_KIND[int(kind)], "skip": DEEPEN_SKIP[int(skip)], "q": int(q_used), "t": int(t_used), "tip": int(tip)}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--rpc", default="http://127.0.0.1:8550")
    ap.add_argument("--registry", required=True)
    ap.add_argument("--fill-eth", default="0.43", help="the filling buy's exact input (the unspent part is swept back)")
    ap.add_argument("--trade-eth", default="0.1", help="a buy after graduation")
    ap.add_argument("--gift-eth", default="0.005", help="the fundDepth() gift before the second deepen()")
    ap.add_argument("--out")
    args = ap.parse_args()

    if not LOCAL.match(args.rpc):
        print("refusing: the life check only talks to a local anvil on 127.0.0.1:8550-8558", file=sys.stderr)
        return 2
    f = Fork(args.rpc)
    chain = int(f.rpc("eth_chainId", []), 16)
    client = f.rpc("web3_clientVersion", [])
    if chain != SEPOLIA or "anvil" not in client.lower():
        print(f"refusing: chain {chain} / {client} is not a local anvil fork of Sepolia", file=sys.stderr)
        return 2
    to_wei = lambda s: int(Decimal(s) * WEI)  # noqa: E731

    reg = args.registry
    coord = f.call(reg, "coordinatorOf(uint256)(address)", "0")[0]
    hook = f.call(coord, "hook()(address)")[0]
    token = f.call(hook, "token()(address)")[0]
    receiver = f.call(hook, "receiver()(address)")[0]
    router = f.call(hook, "launchRouter()(address)")[0]
    executor = f.call(receiver, "executor()(address)")[0]
    raise_wei = f.uint(hook, "raise()(uint256)")
    min_add = f.uint(hook, "minAdd()(uint256)")
    tip_cap = f.uint(hook, "deepenTipCap()(uint256)")
    batch_min = f.uint(receiver, "batchMin()(uint256)")
    tip_max = f.uint(receiver, "tipMax()(uint256)")
    cap = f.uint(receiver, "PLATFORM_CAP_WEI()(uint256)")
    wall = int(time.time())
    f.record("clock", latestBlock=f.block(), latestTimestamp=timestamp(f), wallClock=wall)
    f.record(
        "box 0",
        coordinator=coord,
        hook=hook,
        token=token,
        receiver=receiver,
        executor=executor,
        raiseWei=raise_wei,
        minAddWei=min_add,
        deepenTipCapWei=tip_cap,
        batchMinWei=batch_min,
        tipMaxWei=tip_max,
        platformCapWei=cap,
    )

    # Each account holds what its largest send needs up front at the fork's base fee (Fork.funding): the buyer the fill
    # and the trade (5.3 ETH in the mainnet build's sizes, more than the 2 it had), the keeper graduate()'s 15,000,000
    # gas limit (0.3 ETH covered it only below about 19 gwei), the gifter its gift.
    buyer = f.account("squarehole.rehearsal.life.buyer", f.funding(FILL_GAS, to_wei(args.fill_eth) + to_wei(args.trade_eth), to_wei("2")))
    keeper = f.account("squarehole.rehearsal.life.keeper", f.funding(GRADUATE_GAS, 0, to_wei("0.3")))
    gifter = f.account("squarehole.rehearsal.life.gifter", f.funding(SEND_GAS, to_wei(args.gift_eth), to_wei("0.1")))
    f.record("accounts", buyerWei=f.balance(buyer), keeperWei=f.balance(keeper), gifterWei=f.balance(gifter))

    # 1. The window, on the clock since F80: blocks 12 s apart until one's time reaches windowEndsAt (openAt + 384 s).
    end = f.uint(hook, "windowEndsAt()(uint256)")
    now = timestamp(f)
    if now < end:
        f.mine((end - now + 11) // 12)
    f.record(
        "window waited out", block=f.block(), time=timestamp(f), windowEndsAt=end, phase=f.call(hook, "phase()(uint8)")[0]
    )

    # 2. The fill.
    fill = to_wei(args.fill_eth)
    before = f.balance(buyer)
    data = ur_buy(f, token, hook, fill, buyer, timestamp(f) + 600, sweep=True)
    r = f.send(buyer, UR_2_1_2, data, fill, "fill", gas=FILL_GAS)
    gas_price = int(f.rpc("eth_getTransactionByHash", [r["tx"]])["gasPrice"], 16)
    spent = before - f.balance(buyer) - r["gasUsed"] * gas_price
    closed = f.call(hook, "closed()(bool)")[0] == "true"
    f.record(
        "fill (UR 2.1.2)",
        sentWei=fill,
        spentWei=spent,
        sweptBackWei=fill - spent,
        tokensOut=f.uint(token, "balanceOf(address)(uint256)", buyer),
        closed=closed,
        closedAtBlock=f.uint(hook, "closedAtBlock()(uint256)"),
        gasUsed=r["gasUsed"],
        urBalanceWei=f.balance(UR_2_1_2),
    )
    if not closed:
        print("stop: the fill did not close the curve", file=sys.stderr)
        return 1

    # 3. graduate() with GRADUATE_GAS: covers it whatever the pokes do.
    f.mine(1)
    r = f.send(keeper, coord, f.cast("calldata", "graduate()"), 0, "graduate", gas=GRADUATE_GAS)
    f.record(
        "graduate()",
        gasUsed=r["gasUsed"],
        migratedAtBlock=f.uint(hook, "migratedAtBlock()(uint256)"),
        rewardWei=f.uint(coord, "rewardOf(address)(uint256)", keeper),
        rewardCapWei=f.uint(coord, "rewardCap()(uint256)"),
        phase=f.call(coord, "phase()(uint8)")[0],
    )

    # 4. A buy after graduation.
    f.mine(1)
    trade = to_wei(args.trade_eth)
    before_t = f.uint(token, "balanceOf(address)(uint256)", buyer)
    r = f.send(buyer, UR_2_1_2, ur_buy(f, token, hook, trade, buyer, timestamp(f) + 600, sweep=False), trade, "trade")
    f.record("buy after graduation (UR 2.1.2)", inWei=trade, tokensOut=f.uint(token, "balanceOf(address)(uint256)", buyer) - before_t, gasUsed=r["gasUsed"])

    # 5. The fee batch; FIT's share; the launch tax.
    f.mine(1)
    # FeeBatch (q, t, qToReserve, tip): four static words, so it decodes as four return values.
    q, t, to_reserve, tip = (int(x) for x in f.call(receiver, "collect(address)(uint256,uint256,uint256,uint256)", keeper, sender=keeper))
    r = f.send(keeper, receiver, f.cast("calldata", "collect(address)", keeper), 0, "collect")
    f.record("collect()", batchQWei=q, batchMinWei=batch_min, batchT=t, qToReserveWei=to_reserve, tipWei=tip, tipMaxWei=tip_max, gasUsed=r["gasUsed"])
    owed = f.uint(receiver, "fitOwed()(uint256)")
    if owed:
        r = f.send(keeper, receiver, f.cast("calldata", "payFit()"), 0, "payFit")
        f.record("payFit()", amountWei=owed, gasUsed=r["gasUsed"])
    held = f.balance(router)
    if held:
        r = f.send(keeper, router, f.cast("calldata", "sweep()"), 0, "sweep")
        f.record("launch router sweep()", amountWei=held, gasUsed=r["gasUsed"])
    depth_q, depth_t = (int(x) for x in f.call(hook, "depthBudget()(uint256,uint256)"))
    epoch, kept, remaining = (int(x) for x in f.call(receiver, "platformEpoch()(uint256,uint256,uint256)"))
    f.record("after the batch", depthQWei=depth_q, depthT=depth_t, executorBudgetWei=f.uint(executor, "budget()(uint256)"), platformKeptWei=kept, platformRemainingWei=remaining, epoch=epoch)

    # 6. FIT's executor: its average from pokes 25 blocks (300 s) apart: the sample walks at most 100 ticks an
    # observation to the price (the post-graduation buy moved it), then a full hour more so the average reaches it
    # (deepen's guards want |spot - average| <= 99 ticks). Then the buy-and-burn.
    spot = lambda: spot_tick(f, hook)  # noqa: E731
    for _ in range(40):
        f.mine(25)
        f.send(keeper, executor, f.cast("calldata", "poke()"), 0, "poke")
        if int(f.call(executor, "latestSampleTick()(int24)")[0]) == spot():
            break
    for _ in range(13):
        f.mine(25)
        f.send(keeper, executor, f.cast("calldata", "poke()"), 0, "poke")
    ready, twap_tick, window = f.call(executor, "twap()(bool,int24,uint32)")
    budget = f.uint(executor, "budget()(uint256)")
    threshold = f.uint(executor, "batchThreshold()(uint256)")
    f.record("FIT's average", ready=ready, twapTick=twap_tick, window=window, latestSampleTick=f.call(executor, "latestSampleTick()(int24)")[0], spotTick=spot(), block=f.block())
    supply = f.uint(token, "totalSupply()(uint256)")
    chunks, spent_e, burned = (int(x) for x in f.call(executor, "execute(uint256)(uint256,uint256,uint256)", "8", sender=keeper))
    f.record("execute() preview (latest block)", chunks=chunks, ethSpentWei=spent_e, fitBurned=burned)
    eth0 = f.balance(executor)
    r = f.send(keeper, executor, f.cast("calldata", "execute(uint256)", "8"), 0, "execute")
    spent_e = eth0 - f.balance(executor)
    burned = supply - f.uint(token, "totalSupply()(uint256)")
    f.record(
        "FIT buy-and-burn execute()",
        budgetWei=budget,
        batchThresholdWei=threshold,
        chunks=chunks,
        ethSpentWei=spent_e,
        fitBurned=burned,
        gasUsed=r["gasUsed"],
    )

    # 7. deepen() on the fill's own depth (read-only).
    depth_q, depth_t = (int(x) for x in f.call(hook, "depthBudget()(uint256,uint256)"))
    p = deepen_preview(f, hook, keeper)
    f.record("deepen() preview, the fill's depth only", depthQWei=depth_q, depthT=depth_t, minAddWei=min_add, kind=p["kind"], skip=p["skip"])

    # 8. A Q-only gift, then the swap engine's conversion and the pair.
    gift = to_wei(args.gift_eth)
    r = f.send(gifter, receiver, f.cast("calldata", "fundDepth()"), gift, "fundDepth")
    depth_q, depth_t = (int(x) for x in f.call(hook, "depthBudget()(uint256,uint256)"))
    f.record("fundDepth() gift", giftWei=gift, depthQWei=depth_q, depthT=depth_t, gasUsed=r["gasUsed"])
    # DEPTH_CONVERT_MIN_Q has no getter; it equals FEE_BATCH_MIN_ETH (batchMin()) in every build profile
    # (test/box/rehearsal/RehearsalBuild.t.sol checks it).
    convert_min = batch_min
    def pokes(n: int) -> None:
        for _ in range(n):
            f.mine(25)
            f.send(keeper, executor, f.cast("calldata", "poke()"), 0, "poke")

    for attempt in range(12):
        f.send(keeper, executor, f.cast("calldata", "poke()"), 0, "poke")
        p = deepen_preview(f, hook, keeper)
        if p["skip"] != "None":
            ready, twap_tick, _ = f.call(executor, "twap()(bool,int24,uint32)")
            f.record("deepen() skip", attempt=attempt, skip=p["skip"], depthQWei=depth_q, minAddWei=min_add, spotTick=spot(), twapTick=twap_tick)
            if p["skip"] in ("Cooldown", "AverageNotReady", "AverageNotCaughtUp", "Deviation", "ConvertBelowMin"):
                # The average follows the price over its hour (FIT's own buy moved the price to the band's edge, so a
                # conversion has only a sliver of room: ConvertBelowMin, BoxSwapBounds.buyInput): 20 more minutes.
                pokes(4)
                continue
            break
        paired0 = f.uint(hook, "pairedLiquidity()(uint128)")
        q0, t0 = (int(x) for x in f.call(hook, "depthBudget()(uint256,uint256)"))
        keeper0 = f.balance(keeper)
        r = f.send(keeper, hook, f.cast("calldata", "deepen(address)", keeper), 0, "deepen")
        q1, t1 = (int(x) for x in f.call(hook, "depthBudget()(uint256,uint256)"))
        f.record(
            "deepen()",
            attempt=attempt,
            kind=p["kind"],
            qUsedWei=p["q"],
            tUsed=p["t"],
            tipWei=p["tip"],
            depthQBeforeWei=q0,
            depthQAfterWei=q1,
            depthTBefore=t0,
            depthTAfter=t1,
            depthConvertMinWei=convert_min,
            minAddWei=min_add,
            pairedLiquidityBefore=paired0,
            pairedLiquidityAfter=f.uint(hook, "pairedLiquidity()(uint128)"),
            keeperGasPaidWei=keeper0 - f.balance(keeper),
            gasUsed=r["gasUsed"],
        )
        if p["kind"] == "Pair":
            break
        # A conversion alone starts the 300-block cooldown: an hour on, with the average kept fresh, the pair.
        pokes(12)
        depth_q = q1

    if args.out:
        Path(args.out).write_text(json.dumps({"rpc": args.rpc, "registry": reg, "steps": f.steps}, indent=2) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
