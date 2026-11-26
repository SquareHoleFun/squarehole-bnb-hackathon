#!/usr/bin/env python3
"""Probes for the post-fork rehearsal of the Sepolia runbook (docs/runbooks/sepolia-core-v1.md;
docs/evidence/SH-box0-final-candidate.md), on a LOCAL anvil only (127.0.0.1, ports 8553-8599, never 8552, or the workflow lanes' 5460-5469). No key
anywhere: every sender is an account the local anvil has unlocked (its own test accounts, or one it impersonates). Each
line it prints starts PROBE|.

  graduate   --rpc R --registry X --sender K       graduate()'s estimate; its least call gas (eth_call to the unit);
                                                   one gas less (the refusal it names); calls at 3,000,000, 6,000,000
                                                   and 15,000,000
  t-pending  --rpc R --registry X --sender K --wallet W
                                                   on a snapshot after the window: W sells tokens into the curve (its
                                                   1% fee in T, pending at the close), then fills it to P1; `graduate`
                                                   as above; graduate() sent with 15,000,000 and its follow-ups
                                                   (`followups`); then the snapshot is reverted
  followups  --rpc R --registry X [--tx H]         the four follow-ups of the last graduate() (or of H): the gas each
                                                   was handed, the gas it used, and PokeFailed logs
  transfer   --rpc R --registry X --wallet W --to K --id N
                                                   a Misfit transferFrom(W, K, N): estimate, least call gas, one less
  trader     --rpc R --registry X --wallet W --at B --hold H --value E
                                                   (runs in the background) W buys E at block B, sells the tokens back
                                                   H blocks later, then exits
  ledger     --rpc R --from-block B --registry X --out F
                                                   every transaction from block B to the latest: block, sender, what,
                                                   gas used, status (a TSV), and the sums per sender
  draws      --rpc R --registry X --state F [--from-block B]
                                                   R1 (each draw earns from its own request; SH-box0-r1), after G6:
                                                   the runbook's draw (ticket 1) checked from its logs; then three
                                                   fresh drawers (keyless addresses, impersonated, funded by anvil)
                                                   request draws A, B and C with a sell of T between each (J moves),
                                                   so all three are open at once; their rounds posted, settled; C
                                                   opened, a sell, B opened; A left open (its state in F)
  draws-late --rpc R --registry X --state F        after G7 (hours later): a sell, A opened late; every draw's item
                                                   checked again, then each drawer claims: the stream's credit equals
                                                   the exact model, J now - J at the draw's own request, to the unit

The exact model reads J (the stream's `index()`) from the chain itself: at a draw's request (the block before and the
block of the request; a draw burns its fee, so J does not move in it), at its opening and at its claim. A draw's item
must start at its own J at request (`pendingOf` at the opening's block: J there less the amount), the open draws' count
and J sum (`openTickets`) must move by exactly that draw, and a claim must credit J at the claim less J at the request
(`Credited`) and pay that less the one raw unit kept. Each line also gives what main's mean rule (before R1) would have
started the item at, for comparison. Any difference to the unit stops the probe (PROBE|FAILED).
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from pathlib import Path

CONTRACTS = Path(__file__).resolve().parents[1]
POKE_GAS = 2_600_000
SWAPTEST = "0x9B6b46e2c869aa39918Db7f52f5557FE577B6eEe"
SWAP = "swap((address,address,uint24,int24,address),(bool,int256,uint160),(bool,bool),bytes)"
MIN_SQRT_PLUS_1 = 4295128740
MAX_SQRT_MINUS_1 = 1461446703485210103287273052203988822378723970341


def say(*parts: object) -> None:
    print("PROBE|" + "|".join(str(p) for p in parts), flush=True)


def cast(*args: str, check: bool = True) -> str:
    r = subprocess.run(["cast", *args], capture_output=True, text=True)
    if check and r.returncode != 0:
        raise RuntimeError(f"cast {' '.join(args[:3])}…: {r.stderr.strip()[-400:]}")
    return r.stdout.strip() if r.returncode == 0 else "ERR " + r.stderr.strip()


def first(out: str) -> str:
    return out.splitlines()[0].split(" ")[0] if out else ""


def pinned_drand_code_hashes() -> set[str]:
    """The pinned DrandSource's runtime code hashes (src/box/randomness/DrandSourcePins.sol; one value on both chains)."""
    pins = CONTRACTS / "src/box/randomness/DrandSourcePins.sol"
    found = re.findall(r"bytes32 internal constant CODE_HASH_(?:MAINNET|SEPOLIA) = (0x[0-9a-fA-F]{64});", pins.read_text())
    if not found:
        raise SystemExit(f"{pins}: no CODE_HASH_ constant")
    return {h.lower() for h in found}


class Box:
    def __init__(self, rpc: str, registry: str):
        if not re.fullmatch(r"http://127\.0\.0\.1:(85(5[3-9]|[6-9][0-9])|546[0-9])", rpc):
            raise SystemExit("--rpc must be a local chain on 127.0.0.1:8553-8599 or 5460-5469")
        self.rpc = rpc
        self.box = self.read(registry, "coordinatorOf(uint256)(address)", "0")
        for name, sig in (("hook", "hook()(address)"), ("token", "token()(address)"), ("receiver", "receiver()(address)"),
                          ("tickets", "tickets()(address)"), ("stream", "itemStream()(address)"),
                          ("executor", "executor()(address)"), ("collection", "collection()(address)"),
                          ("router", "launchRouter()(address)"), ("vault", "vault()(address)"),
                          ("source", "randomness()(address)")):
            setattr(self, name, self.read(self.box, sig))
        # F143: box 0's randomness() is its BoxBackedSource; rounds are timed, posted and paid on the DrandSource its
        # DRAND() names. Only a source whose code is the pinned DrandSource's (a drand-only box 0, before F143) is that
        # DrandSource itself. Any other source must answer DRAND() with an address: a failed read or another answer stops
        # the probe (rc8 part 2c, open item 84), so an RPC error on that one call never sends the draws' posts to the
        # backed source, which has no postRound.
        code_hash = first(cast("keccak", cast("code", self.source, "--rpc-url", self.rpc))).lower()
        if code_hash in pinned_drand_code_hashes():
            self.drand = self.source
        else:
            named = first(cast("call", self.source, "DRAND()(address)", "--rpc-url", self.rpc))
            if not re.fullmatch(r"0x[0-9a-fA-F]{40}", named):
                raise SystemExit(f"box 0's source {self.source} answered DRAND() with {named!r}, not an address: stopped")
            self.drand = named
        self.key = f"(0x0000000000000000000000000000000000000000,{self.token},10000,60,{self.hook})"

    def read(self, to: str, sig: str, *args: str) -> str:
        return first(cast("call", to, sig, *args, "--rpc-url", self.rpc))

    def reads(self, to: str, sig: str, *args: str, block: int | None = None) -> list[str]:
        """Every returned value (one per line, cast's annotation dropped), at `block` or the latest."""
        extra = ["--block", str(block)] if block is not None else []
        out = cast("call", to, sig, *args, "--rpc-url", self.rpc, *extra)
        return [ln.strip().split(" ")[0] for ln in out.splitlines() if ln.strip()]

    def rpc_call(self, method: str, *params: str) -> str:
        return cast("rpc", method, *params, "--rpc-url", self.rpc)

    def block(self) -> int:
        return int(cast("block-number", "--rpc-url", self.rpc))

    def send(self, sender: str, to: str, sig: str, *args: str, value: str | None = None,
             gas: int | None = None) -> dict:
        extra = (["--value", value] if value else []) + (["--gas-limit", str(gas)] if gas else [])
        out = cast("send", to, sig, *args, "--from", sender, "--unlocked", "--rpc-url", self.rpc, "--json", *extra)
        return json.loads(out)

    def call_ok(self, sender: str, to: str, sig: str, *args: str, gas: int | None = None,
                value: str | None = None) -> tuple[bool, str]:
        extra = (["--gas-limit", str(gas)] if gas else []) + (["--value", value] if value else [])
        r = subprocess.run(["cast", "call", to, sig, *args, "--from", sender, "--rpc-url", self.rpc, *extra],
                           capture_output=True, text=True)
        return r.returncode == 0, (r.stdout if r.returncode == 0 else r.stderr).strip()


def sqrt_at_tick(t: int) -> int:
    """v4 TickMath.getSqrtPriceAtTick (as core-v1-life-run.sh computes P1)."""
    c = [0xfff97272373d413259a46990580e213a, 0xfff2e50f5f656932ef12357cf3c7fdcc, 0xffe5caca7e10e4e61c3624eaa0941cd0,
         0xffcb9843d60f6159c9db58835c926644, 0xff973b41fa98c081472e6896dfb254c0, 0xff2ea16466c96a3843ec78b326b52861,
         0xfe5dee046a99a2a811c461f1969c3053, 0xfcbe86c7900a88aedcffc83b479aa3a4, 0xf987a7253ac413176f2b074cf7815e54,
         0xf3392b0822b70005940c7a398e4b70f3, 0xe7159475a2c29b7443b29c7fa6e889d9, 0xd097f3bdfd2022b8845ad8f792aa5825,
         0xa9f746462d870fdf8a65dc1f90e061e5, 0x70d869a156d2a1b890bb3df62baf32f7, 0x31be135f97d08fd981231505542fcfa6,
         0x9aa508b5b7a84e1c677de54f3e99bc9, 0x5d6af8dedb81196699c329225ee604, 0x2216e584f5fa1ea926041bedfe98,
         0x48a170391f7dc42444e8fa2]
    a = abs(t)
    p = 0xfffcb933bd6fad37aa2d162d1a594001 if a & 1 else 1 << 128
    for i, k in enumerate(c):
        if a & (2 << i):
            p = (p * k) >> 128
    if t > 0:
        p = ((1 << 256) - 1) // p
    return (p + (1 << 32) - 1) >> 32


def why(text: str) -> str:
    """The custom error a revert names, decoded by cast where it can."""
    m = re.search(r'data: \\?"(0x[0-9a-fA-F]{8,})', text)
    if not m:
        return text.splitlines()[-1][:160] if text else "?"
    data = m.group(1)
    sel = data[:10]
    known = {"GasTooLow(uint256,uint256)", "ObserverGasTooLow(uint256,uint256)", "CurveIsClosed()", "NotClosed()",
             "BatchTooSmall(uint256,uint256)", "WrappedError(address,bytes4,bytes,bytes)"}
    for sig in known:
        if cast("sig", sig) == sel:
            args = data[10:]
            words = [str(int(args[i:i + 64], 16)) for i in range(0, min(len(args), 128), 64)] if args else []
            return f"{sig.split('(')[0]}({', '.join(words)})" if "Wrapped" not in sig else sig.split("(")[0]
    return sel


def least(box: Box, sender: str, to: str, sig: str, *args: str, lo: int, hi: int) -> tuple[int, str]:
    """The least gas limit with which the call succeeds (lo fails, hi succeeds), and the refusal one gas below it."""
    ok, out = box.call_ok(sender, to, sig, *args, gas=hi)
    if not ok:
        raise RuntimeError(f"{sig} fails at {hi}: {why(out)}")
    ok, out = box.call_ok(sender, to, sig, *args, gas=lo)
    if ok:
        raise RuntimeError(f"{sig} succeeds at {lo}")
    while hi - lo > 1:
        mid = (lo + hi) // 2
        ok, out = box.call_ok(sender, to, sig, *args, gas=mid)
        if ok:
            hi = mid
        else:
            lo = mid
    _, below = box.call_ok(sender, to, sig, *args, gas=hi - 1)
    return hi, why(below)


def graduate_probe(box: Box, sender: str, label: str) -> None:
    est = cast("estimate", box.box, "graduate()", "--from", sender, "--rpc-url", box.rpc, check=False)
    say("graduate", label, "block", box.block(), "eth_estimateGas", est)
    lo_gas, below = least(box, sender, box.box, "graduate()", lo=1_000_000, hi=15_000_000)
    say("graduate", label, "least call gas", lo_gas, "one gas less", below)
    for g in (3_000_000, 6_000_000, 15_000_000):
        ok, out = box.call_ok(sender, box.box, "graduate()", gas=g)
        say("graduate", label, f"as a call with {g:,}", "succeeds" if ok else "refused " + why(out))


def last_tx_to(box: Box, to: str, selector: str, blocks: int = 40) -> str:
    n = box.block()
    for b in range(n, max(0, n - blocks), -1):
        blk = json.loads(box.rpc_call("eth_getBlockByNumber", hex(b), "true"))
        for tx in reversed(blk["transactions"]):
            if (tx.get("to") or "").lower() == to.lower() and tx["input"].startswith(selector):
                return tx["hash"]
    raise RuntimeError(f"no transaction to {to} with {selector} in the last {blocks} blocks")


def followups(box: Box, tx: str, label: str) -> None:
    rcpt = json.loads(box.rpc_call("eth_getTransactionReceipt", tx))
    trace = json.loads(box.rpc_call("debug_traceTransaction", tx, '{"tracer":"callTracer"}'))
    names = {box.receiver.lower(): "receiver onGraduation (the settlement)", box.tickets.lower():
             "tickets requestGraduationWord", box.executor.lower(): "FIT executor poke",
             box.stream.lower(): "stream onGraduation (its start)"}
    found = []

    def walk(f: dict) -> None:
        if f.get("type") == "CALL" and int(f.get("gas", "0x0"), 16) == POKE_GAS and \
                f.get("from", "").lower() == box.box.lower():
            found.append(f)
        for c in f.get("calls", []) or []:
            walk(c)

    walk(trace)
    failed = sum(1 for lg in rcpt["logs"] if lg["topics"][0] == cast("keccak", "PokeFailed(address,bytes4)"))
    say("followups", label, "tx", tx, "status", int(rcpt["status"], 16), "gas used", f"{int(rcpt['gasUsed'], 16):,}",
        "PokeFailed logs", failed, "follow-ups handed exactly 2,600,000", len(found))
    for f in found:
        used = int(f.get("gasUsed", "0x0"), 16)
        say("followups", label, names.get(f["to"].lower(), f["to"]), f"gas used {used:,}",
            f"{POKE_GAS / used:.2f}x" if used else "-", "error " + f["error"] if f.get("error") else "ok")


def t_pending(box: Box, sender: str, wallet: str) -> None:
    snap = box.rpc_call("evm_snapshot").strip('"')
    try:
        if box.read(box.hook, "closed()(bool)") != "false":
            raise RuntimeError("the curve is already closed")
        p1 = sqrt_at_tick(int(first(cast("call", box.hook, "curve()(int24,int24,uint128)", "--rpc-url", box.rpc))))
        box.rpc_call("anvil_setBalance", wallet, hex(2 * 10 ** 18))
        held = int(box.read(box.token, "balanceOf(address)(uint256)", wallet))
        sell = held // 4
        box.send(wallet, box.token, "approve(address,uint256)", SWAPTEST, cast("max-uint"))
        r = box.send(wallet, SWAPTEST, SWAP, box.key, f"(false,-{sell},{MAX_SQRT_MINUS_1})", "(false,false)", "0x")
        say("t-pending", "wallet sells", f"{sell / 1e18:,.0f} tokens into the curve (its fee in T)", "status",
            int(r["status"], 16), "gas", int(r["gasUsed"], 16))
        r = box.send(wallet, SWAPTEST, SWAP, box.key, f"(true,-500000000000000000,{p1})", "(false,false)", "0x",
                     value="0.5ether")
        say("t-pending", "fill to P1", "status", int(r["status"], 16), "closed", box.read(box.hook, "closed()(bool)"))
        graduate_probe(box, sender, "T pending")
        r = box.send(sender, box.box, "graduate()", gas=15_000_000)
        say("t-pending", "graduate() sent with 15,000,000", "status", int(r["status"], 16), "gas used",
            f"{int(r['gasUsed'], 16):,}", "phase", box.read(box.box, "phase()(uint8)"), "settled",
            box.read(box.receiver, "graduationSettled()(bool)"))
        followups(box, r["transactionHash"], "T pending")
    finally:
        box.rpc_call("evm_revert", snap)
        say("t-pending", "snapshot reverted", "closed", box.read(box.hook, "closed()(bool)"), "phase",
            box.read(box.box, "phase()(uint8)"))


def transfer(box: Box, wallet: str, to: str, item: str) -> None:
    sig = "transferFrom(address,address,uint256)"
    est = cast("estimate", box.collection, sig, wallet, to, item, "--from", wallet, "--rpc-url", box.rpc, check=False)
    lo_gas, below = least(box, wallet, box.collection, sig, wallet, to, item, lo=100_000, hi=3_000_000)
    say("transfer", f"item {item}", f"{wallet} to {to}", "eth_estimateGas", est, "least call gas", lo_gas,
        "one gas less", below)


def trader(box: Box, wallet: str, at: int, hold: int, value: str) -> None:
    while box.block() < at:
        time.sleep(0.5)
    before = int(box.read(box.token, "balanceOf(address)(uint256)", wallet))
    r = box.send(wallet, SWAPTEST, SWAP, box.key, f"(true,-{int(float(value) * 10 ** 18)},{MIN_SQRT_PLUS_1})",
                 "(false,false)", "0x", value=f"{value}ether")
    bought = int(box.read(box.token, "balanceOf(address)(uint256)", wallet)) - before
    say("trader", "block", int(r["blockNumber"], 16), f"bought {bought / 1e18:,.0f} tokens for {value} ETH", "gas",
        int(r["gasUsed"], 16), "latest sample", box.read(box.executor, "latestSampleTick()(int24)"))
    sell_at = int(r["blockNumber"], 16) + hold
    while box.block() < sell_at:
        time.sleep(0.5)
    box.send(wallet, box.token, "approve(address,uint256)", SWAPTEST, cast("max-uint"))
    r = box.send(wallet, SWAPTEST, SWAP, box.key, f"(false,-{bought},{MAX_SQRT_MINUS_1})", "(false,false)", "0x")
    say("trader", "block", int(r["blockNumber"], 16), "sold them back", "gas", int(r["gasUsed"], 16),
        "latest sample", box.read(box.executor, "latestSampleTick()(int24)"))


# ------------------------------------------------------------------------------------------------ R1: overlapping draws

DRAWERS = ("A", "B", "C")
DRAWER_BUY = 1_500_000_000_000_000  # wei each drawer swaps for T: its draw (236,334 tokens) and its sells
DRAW_SELL = 100_000 * 10 ** 18  # T sold into the pool between steps: its 1% fee, in T, moves J
# The sell after draw B is three times the others, so J's steps between the requests differ and main's mean rule (for
# comparison) starts each of the three draws elsewhere than its own request.
DRAW_SELLS = {"A": DRAW_SELL, "B": 3 * DRAW_SELL, "C": DRAW_SELL}
DRAW_VALUE = "0.005ether"  # the draw's round bounty (600,000 x the base fee); the rest comes back in the draw
ZERO = "0x0000000000000000000000000000000000000000"
REVEAL = "(uint128,bytes32,bytes32,bytes32,bytes32,bytes32[])"
OPEN_DRAW = f"openDraw(uint256,address,{REVEAL})"
DRAW_REQUESTED = "DrawRequested(uint256,address,uint256,uint256,uint256,uint256)"
DRAW_SETTLED = "DrawSettled(uint256,uint256,bytes32)"
OPENED = "Opened(uint256,uint8,uint256,address,bool,uint256)"
CREDITED = "Credited(address,uint256,uint256)"
CLAIMED = "Claimed(address,address,uint256)"
TOPICS: dict[str, str] = {}


def topic(sig: str) -> str:
    if sig not in TOPICS:
        TOPICS[sig] = cast("keccak", sig)
    return TOPICS[sig]


def data_word(data: str, i: int) -> int:
    return int(data[2 + 64 * i:2 + 64 * (i + 1)], 16)


def mined(r: dict, what_: str) -> int:
    """The block of a transaction that succeeded."""
    if int(r["status"], 16) != 1:
        raise RuntimeError(f"{what_}: transaction {r['transactionHash']} failed")
    return int(r["blockNumber"], 16)


def used(r: dict) -> str:
    return f"{int(r['gasUsed'], 16):,}"


def logs_of(r: dict, address: str, sig: str) -> list[dict]:
    return [lg for lg in r["logs"] if lg["address"].lower() == address.lower() and lg["topics"][0] == topic(sig)]


def need(ok: bool, what_: str) -> None:
    if not ok:
        raise RuntimeError(what_)


def chain_time(box: Box) -> int:
    return int(cast("block", "latest", "--field", "timestamp", "--rpc-url", box.rpc))


def j_at(box: Box, block: int | None = None) -> int:
    """J, the stream's index, after `block` (or now)."""
    return int(box.reads(box.stream, "index()(uint256)", block=block)[0])


def tix(box: Box, block: int | None = None) -> tuple[int, int, int]:
    """The stream's open tickets: placeholders, draws, the draws' J sum at request."""
    p, d, s = (int(x) for x in box.reads(box.stream, "openTickets()(uint256,uint256,uint256)", block=block))
    return p, d, s


def pending(box: Box, item: int, block: int | None = None) -> tuple[str, int]:
    owner, amount = box.reads(box.stream, "pendingOf(uint256)(address,uint256)", str(item), block=block)
    return owner.lower(), int(amount)


def get_logs(box: Box, address: str, topics: list[str | None], from_block: int) -> list[dict]:
    f = {"fromBlock": hex(from_block), "toBlock": "latest", "address": address, "topics": topics}
    return json.loads(box.rpc_call("eth_getLogs", "--raw", json.dumps([f])))


def drawer_addresses() -> dict[str, str]:
    """Fresh addresses nobody holds a key for (keccak of a label, its last 20 bytes); the local anvil impersonates them."""
    return {n: "0x" + cast("keccak", f"squarehole.box0-r1.rehearsal.drawer.{n}")[-40:] for n in DRAWERS}


def reveal_of(item: int) -> str:
    """The item's reveal from the Sepolia test set (G3's and G4's script; local, no RPC)."""
    r = subprocess.run(["forge", "script", "script/SepoliaBox0Reveal.s.sol", "--sig", "run(uint256)", str(item)],
                       capture_output=True, text=True, cwd=CONTRACTS)
    m = re.search(r"REVEAL\|(\S+)", r.stdout)
    if not m:
        raise RuntimeError(f"no reveal for item {item}: {r.stderr.strip()[-300:]}")
    return m.group(1)


def mean_rule(st: dict) -> int:
    """Where main's code before R1 (BoxItemStream `_ticketSince` at f991c697) starts the next opened draw: the open
    draws' mean J at request, taken off the sum. For comparison only."""
    d, s = st["mean"]
    since = s // d
    st["mean"] = [d - 1, s - since]
    return since


def draw_state_values(st: dict, value_type: type[str] | type[int]) -> dict:
    """Copy state with raw values as decimal strings for JSON, or exact ints for resumed calculations.

    The mean pair is [draw count, J sum]; only its sum is a raw value. Blocks, IDs and counts keep their types.
    """
    raw_fields = {"j_req", "item_start", "mean_start", "credited", "paid"}

    def record_values(record: dict) -> dict:
        return {key: value_type(value) if key in raw_fields else value for key, value in record.items()}

    return {**st, "runbook_draw": record_values(st["runbook_draw"]),
            "draws": {name: record_values(dr) for name, dr in st["draws"].items()},
            "mean": [st["mean"][0], value_type(st["mean"][1])]}


def sell(box: Box, who: str, label: str, amount: int = DRAW_SELL) -> int:
    j0 = j_at(box)
    r = box.send(who, SWAPTEST, SWAP, box.key, f"(false,-{amount},{MAX_SQRT_MINUS_1})", "(false,false)", "0x")
    b = mined(r, "a sell")
    j1 = j_at(box, b)
    need(j1 > j0, f"a sell of T did not move J ({j0} to {j1})")
    say("draws", f"sell {label}", f"{amount // 10 ** 18:,} tokens", "block", b, "J", f"{j0} to {j1}", "gas", used(r))
    return j1


def runbook_draw(box: Box, st: dict, from_block: int) -> None:
    """The runbook's own draw (G4, ticket 1): J at its request from the open draws' sum, its item's credit at G6's
    claim (the item's first `Credited`) against J there."""
    req = get_logs(box, box.tickets, [topic(DRAW_REQUESTED), "0x" + format(1, "064x")], from_block)
    need(len(req) == 1, f"ticket 1's request: {len(req)} logs from block {from_block}")
    b = int(req[0]["blockNumber"], 16)
    (_, d0, s0), (_, d1, s1) = tix(box, b - 1), tix(box, b)
    j_req = s1 - s0
    need(d1 == d0 + 1 and j_req == j_at(box, b) == j_at(box, b - 1),
         f"ticket 1's request at block {b}: open draws {d0} to {d1}, J sum +{j_req}, J {j_at(box, b - 1)} to {j_at(box, b)}")
    # Opened's first topic is a placeholder token or a draw ticket: kind 2 is a draw (placeholder token 1 has kind 1).
    opened = [lg for lg in get_logs(box, box.tickets, [topic(OPENED), "0x" + format(1, "064x")], from_block)
              if data_word(lg["data"], 0) == 2]
    need(len(opened) == 1, "ticket 1 was not opened once")
    item = int(opened[0]["topics"][2], 16)
    bo = int(opened[0]["blockNumber"], 16)
    credited = get_logs(box, box.stream, [topic(CREDITED), None, "0x" + format(item, "064x")], bo)
    need(len(credited) >= 1, f"item {item} (ticket 1) was never credited (G6's claim)")
    bc = int(credited[0]["blockNumber"], 16)
    amount = data_word(credited[0]["data"], 0)
    jc = j_at(box, bc)
    need(amount == jc - j_req, f"ticket 1's item {item}: credited {amount} at block {bc}, the exact model {jc - j_req}")
    st["runbook_draw"] = {"ticket": 1, "item": item, "j_req": j_req, "request_block": b, "open_block": bo,
                          "claim_block": bc, "credited": amount}
    say("draws", "the runbook's draw (G4)", "ticket 1", f"item {item}", f"requested at block {b} (J {j_req})",
        f"opened at block {bo}", f"G6's claim at block {bc} (J {jc}) credited {amount}",
        "= J there - J at its own request: exact")


def request_draw(box: Box, st: dict, name: str) -> None:
    who = st["drawers"][name]
    principal, fee = (int(x) for x in box.reads(box.vault, "quoteTake(uint256)(uint256,uint256)", "1"))
    r = box.send(who, box.tickets, "draw(uint256,uint256)", str(principal + fee), str(chain_time(box) + 600),
                 value=DRAW_VALUE)
    b = mined(r, f"draw {name}")
    req = logs_of(r, box.tickets, DRAW_REQUESTED)
    need(len(req) == 1, f"draw {name}: {len(req)} DrawRequested logs")
    ticket, rnd = int(req[0]["topics"][1], 16), data_word(req[0]["data"], 2)
    (p0, d0, s0), (p1, d1, s1) = tix(box, b - 1), tix(box, b)
    j0, j1 = j_at(box, b - 1), j_at(box, b)
    # A draw burns its fee and escrows its principal: J does not move in it, so J before and after its block is the J
    # its request saw; the stream must add exactly that to the open draws' sum.
    need(j0 == j1, f"draw {name}: J moved in its block ({j0} to {j1})")
    need(d1 == d0 + 1 and s1 - s0 == j1 and p1 == p0,
         f"draw {name}: open draws {d0} to {d1}, J sum +{s1 - s0} (J {j1}), placeholders {p0} to {p1}")
    st["mean"] = [st["mean"][0] + 1, st["mean"][1] + j1]
    st["draws"][name] = {"ticket": ticket, "j_req": j1, "request_block": b, "round": rnd, "request_gas": used(r)}
    say("draws", f"draw {name} requested", f"ticket {ticket}", "block", b, f"J at request {j1}", f"open draws {d1}",
        f"J sum {s1}", "gas", used(r))


def open_draw(box: Box, st: dict, name: str, label: str) -> None:
    dr, who = st["draws"][name], st["drawers"][name]
    item = dr["item"]
    r = box.send(who, box.tickets, OPEN_DRAW, str(dr["ticket"]), ZERO, reveal_of(item))
    b = mined(r, f"open draw {name}")
    j = j_at(box, b)
    owner, amount = pending(box, item, b)
    (p0, d0, s0), (p1, d1, s1) = tix(box, b - 1), tix(box, b)
    old = mean_rule(st)
    since = j - amount
    need(owner == who.lower(), f"draw {name}'s item {item}: the stream records {owner}, not its drawer {who}")
    # J moved after every request (a sell), so a start at the request leaves an amount above 0: `since` is exact.
    need(amount > 0, f"draw {name}'s item {item}: nothing pending at J {j} (it started at J or later)")
    need(since == dr["j_req"], f"draw {name}'s item {item} starts at {since}, not at its own request's J {dr['j_req']}")
    need(d1 == d0 - 1 and s0 - s1 == dr["j_req"] and p1 == p0,
         f"draw {name}'s opening: open draws {d0} to {d1}, J sum -{s0 - s1} (its J {dr['j_req']})")
    need(int(box.reads(box.tickets, "ticketInFlight()(uint256)", block=b)[0]) == 0, "a ticket left in flight")
    dr.update(item_start=since, open_block=b, open_gas=used(r), mean_start=old)
    say("draws", f"draw {name} opened ({label})", f"ticket {dr['ticket']}", f"item {item}", "block", b, f"J {j}",
        f"its item starts at {since} = J at its own request", f"main's mean rule: {old} ({old - since:+})",
        f"open draws {d1}", f"J sum {s1}", "gas", used(r))


def draws(box: Box, state: str, from_block: int | None) -> None:
    st: dict = {"drawers": drawer_addresses(), "draws": {}}
    runbook_draw(box, st, from_block if from_block is not None else max(1, box.block() - 3000))
    p, d, s = tix(box)
    st["mean"] = [d, s]
    say("draws", "before", f"open placeholders {p}, open draws {d}, J sum {s}", f"J {j_at(box)}",
        "drawers " + " ".join(f"{n} {a}" for n, a in st["drawers"].items()))
    for name, who in st["drawers"].items():
        code = cast("code", who, "--rpc-url", box.rpc)
        need(code == "0x", f"drawer {name} {who} has code")
        box.rpc_call("anvil_impersonateAccount", who)
        box.rpc_call("anvil_setBalance", who, hex(10 ** 18))
        r = box.send(who, SWAPTEST, SWAP, box.key, f"(true,-{DRAWER_BUY},{MIN_SQRT_PLUS_1})", "(false,false)", "0x",
                     value=str(DRAWER_BUY))
        mined(r, f"drawer {name}'s buy")
        for spender in (box.tickets, SWAPTEST):
            mined(box.send(who, box.token, "approve(address,uint256)", spender, cast("max-uint")), "an approval")
        say("draws", f"drawer {name}", who, f"bought {int(box.read(box.token, 'balanceOf(address)(uint256)', who)) / 1e18:,.0f} "
            f"tokens for {DRAWER_BUY / 1e18} ETH", "gas", used(r))
    # Three draws open at once, J different at each request.
    for i, name in enumerate(DRAWERS):
        if i:
            prev = DRAWERS[i - 1]
            sell(box, st["drawers"][prev], f"after draw {prev}", DRAW_SELLS[prev])
        request_draw(box, st, name)
    sell(box, st["drawers"][DRAWERS[-1]], f"after draw {DRAWERS[-1]}", DRAW_SELLS[DRAWERS[-1]])
    p, d, s = tix(box)
    want = st["mean"]
    need([d, s] == want, f"open draws {d}, J sum {s}; the three requests make {want}")
    say("draws", "open at once", f"{d} draws", f"J sum {s}",
        "J at request " + ", ".join(f"{n} {st['draws'][n]['j_req']}" for n in DRAWERS))
    # Their rounds, posted by drawer A (a post waits for the round's time, as G4's block does), then one settle.
    poster = st["drawers"][DRAWERS[0]]
    for name in DRAWERS:
        rnd = st["draws"][name]["round"]
        at = int(box.read(box.drand, "roundTime(uint256)(uint256)", str(rnd)))
        while chain_time(box) < at:
            time.sleep(3)
        if int(box.reads(box.drand, "beaconOf(uint256)(bytes32,uint64)", str(rnd))[1]) == 0:
            sig = subprocess.run(["python3", "scripts/drand-round.py", str(rnd), "--wait"], capture_output=True,
                                 text=True, cwd=CONTRACTS)
            need(sig.returncode == 0 and sig.stdout.startswith("0x"), f"round {rnd}: {sig.stderr.strip()[-200:]}")
            r = box.send(poster, box.drand, "postRound(uint256,bytes)", str(rnd), sig.stdout.strip())
            say("draws", f"round {rnd} posted (draw {name})", "block", mined(r, f"round {rnd}"), "gas", used(r))
    r = box.send(poster, box.tickets, "settle(uint256)", "10")
    b = mined(r, "settle")
    settled = {int(lg["topics"][1], 16): int(lg["topics"][2], 16) for lg in logs_of(r, box.tickets, DRAW_SETTLED)}
    for name in DRAWERS:
        t = st["draws"][name]["ticket"]
        need(t in settled, f"draw {name} (ticket {t}) not settled")
        st["draws"][name]["item"] = settled[t]
    say("draws", "settled", "block", b, ", ".join(f"{n}: ticket {st['draws'][n]['ticket']} item "
                                                  f"{st['draws'][n]['item']}" for n in DRAWERS), "gas", used(r))
    # The newest first, then the middle one after a sell; the oldest stays open for hours.
    open_draw(box, st, "C", "the newest first")
    sell(box, st["drawers"]["C"], "after C's opening")
    open_draw(box, st, "B", "next")
    r = box.send(poster, box.drand, "withdrawBounty(address)", poster)
    mined(r, "withdrawBounty")
    p, d, s = tix(box)
    need(d == 1 and s == st["draws"]["A"]["j_req"], f"after B: open draws {d}, J sum {s}; A alone is open")
    st["late_from_block"] = box.block()
    Path(state).write_text(json.dumps(draw_state_values(st, str), indent=1))
    say("draws", "PASSED", "A open alone", f"J sum {s} = A's J at request", f"state {state}")


def draws_late(box: Box, state: str) -> None:
    st = draw_state_values(json.loads(Path(state).read_text()), int)
    for who in st["drawers"].values():
        box.rpc_call("anvil_impersonateAccount", who)
    a = st["draws"]["A"]
    p, d, s = tix(box)
    need(d == 1 and s == a["j_req"], f"before A's late opening: open draws {d}, J sum {s}")
    sell(box, st["drawers"]["B"], "before A's late opening")
    open_draw(box, st, "A", f"late: {box.block() - a['request_block']} blocks after its request")
    p, d, s = tix(box)
    need(d == 0 and s == 0, f"after A: open draws {d}, J sum {s}")
    # Every draw's item at one block: pending = J there - J at its own request.
    b = box.block()
    j = j_at(box, b)
    for name in DRAWERS:
        dr, who = st["draws"][name], st["drawers"][name]
        owner, amount = pending(box, dr["item"], b)
        need(owner == who.lower() and amount == j - dr["j_req"],
             f"draw {name}'s item {dr['item']} at block {b}: {owner} {amount}; the exact model {who} {j - dr['j_req']}")
        say("draws-late", f"draw {name}", f"item {dr['item']}", "block", b, f"pending {amount}",
            "= J now - J at its own request", f"main's mean rule: {j - dr['mean_start']} ({dr['j_req'] - dr['mean_start']:+})")
    # Each drawer claims its item: the stream credits exactly that, and pays it less the one raw unit kept.
    total = 0
    for name in DRAWERS:
        dr, who = st["draws"][name], st["drawers"][name]
        owed0 = int(box.read(box.stream, "owedOf(address)(uint256)", who))
        held0 = int(box.read(box.token, "balanceOf(address)(uint256)", box.stream))
        r = box.send(who, box.stream, "claim(uint256[],address)", f"[{dr['item']}]", who)
        bc = mined(r, f"claim {name}")
        jc = j_at(box, bc)
        exact = jc - dr["j_req"]
        credited = [data_word(lg["data"], 0) for lg in logs_of(r, box.stream, CREDITED)
                    if int(lg["topics"][2], 16) == dr["item"]]
        claimed = [data_word(lg["data"], 0) for lg in logs_of(r, box.stream, CLAIMED)]
        pay = min(owed0 + exact - 1, held0) if owed0 + exact >= 2 else 0
        owed1 = int(box.read(box.stream, "owedOf(address)(uint256)", who))
        need(credited == [exact], f"claim {name}: credited {credited}, the exact model [{exact}]")
        need(claimed == ([pay] if pay else []) and owed1 == owed0 + exact - pay,
             f"claim {name}: paid {claimed}, owed {owed0} to {owed1}; the exact model pays {pay}")
        total += exact
        dr.update(claim_block=bc, credited=exact, paid=pay, claim_gas=used(r))
        say("draws-late", f"claim {name}", f"item {dr['item']}", "block", bc, f"J {jc}",
            f"credited {exact} = J - J at its own request {dr['j_req']}", f"paid {pay}", f"owed {owed1}",
            f"main's mean rule would credit {jc - dr['mean_start']} ({dr['j_req'] - dr['mean_start']:+})", "gas", used(r))
    Path(state).write_text(json.dumps(draw_state_values(st, str), indent=1))
    say("draws-late", "PASSED", "every draw credited exactly from its own request", f"three items {total} in all",
        f"state {state}")


SELECTORS = {}


def what(tx: dict) -> str:
    if not tx.get("to"):
        return "create"
    sel = tx["input"][:10]
    if not SELECTORS:
        for sig in ("graduate()", "claimReward(address)", "sweep()", "payFit()", "payPlatform()", "collect(address)",
                    "deepen(address)", "poke()", "execute(uint256)", "postRound(uint256,bytes)",
                    "acceptGraduationWord()", "settle(uint256)", "withdrawBounty(address)", "approve(address,uint256)",
                    "take(uint256,uint256,uint256)", "draw(uint256,uint256)", "buy(uint256,uint256,address,uint256)",
                    "open(uint256,(uint128,bytes32,bytes32,bytes32,bytes32,bytes32[]))",
                    "openDraw(uint256,address,(uint128,bytes32,bytes32,bytes32,bytes32,bytes32[]))",
                    "claim(uint256[],address)", "transferFrom(address,address,uint256)", SWAP,
                    "createBox((bytes32,bytes))", "deploy(bytes32,bytes)"):
            SELECTORS[cast("sig", sig)] = sig.split("(")[0]
    return SELECTORS.get(sel, sel if tx["input"] != "0x" else "transfer")


def ledger(rpc: str, start: int, out: str) -> None:
    n = int(cast("block-number", "--rpc-url", rpc))
    per: dict[str, int] = {}
    with open(out, "w") as f:
        f.write("block\ttimestamp\tfrom\tto\twhat\tgas_used\tstatus\ttx\n")
        for b in range(start, n + 1):
            blk = json.loads(cast("rpc", "eth_getBlockByNumber", hex(b), "true", "--rpc-url", rpc))
            for tx in blk["transactions"]:
                r = json.loads(cast("rpc", "eth_getTransactionReceipt", tx["hash"], "--rpc-url", rpc))
                gas = int(r["gasUsed"], 16)
                per[tx["from"].lower()] = per.get(tx["from"].lower(), 0) + gas
                f.write(f"{b}\t{int(blk['timestamp'], 16)}\t{tx['from']}\t{tx.get('to') or '-'}\t{what(tx)}\t"
                        f"{gas}\t{int(r['status'], 16)}\t{tx['hash']}\n")
    for who, gas in per.items():
        say("ledger", who, f"{gas:,} gas", f"blocks {start}-{n}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("what", choices=["graduate", "t-pending", "followups", "transfer", "trader", "ledger", "draws",
                                     "draws-late"])
    ap.add_argument("--rpc", required=True)
    ap.add_argument("--registry")
    ap.add_argument("--sender")
    ap.add_argument("--wallet")
    ap.add_argument("--to")
    ap.add_argument("--id")
    ap.add_argument("--tx")
    ap.add_argument("--at", type=int)
    ap.add_argument("--hold", type=int, default=10)
    ap.add_argument("--value", default="0.055")
    ap.add_argument("--from-block", type=int)
    ap.add_argument("--out")
    ap.add_argument("--state", help="draws, draws-late: the JSON file that carries the draws from one to the other")
    a = ap.parse_args()
    if a.what == "ledger":
        if not re.fullmatch(r"http://127\.0\.0\.1:(85(5[3-9]|[6-9][0-9])|546[0-9])", a.rpc):
            raise SystemExit("--rpc must be a local chain on 127.0.0.1:8553-8599 or 5460-5469")
        ledger(a.rpc, a.from_block, a.out)
        return
    box = Box(a.rpc, a.registry)
    if a.what == "graduate":
        graduate_probe(box, a.sender, "the runbook's path")
    elif a.what == "t-pending":
        t_pending(box, a.sender, a.wallet)
    elif a.what == "followups":
        followups(box, a.tx or last_tx_to(box, box.box, cast("sig", "graduate()")), "the runbook's path")
    elif a.what == "transfer":
        transfer(box, a.wallet, a.to, a.id)
    elif a.what == "trader":
        trader(box, a.wallet, a.at, a.hold, a.value)
    elif a.what == "draws":
        draws(box, a.state, a.from_block)
    elif a.what == "draws-late":
        draws_late(box, a.state)


if __name__ == "__main__":
    try:
        main()
    except RuntimeError as e:
        say("FAILED", e)
        sys.exit(1)
