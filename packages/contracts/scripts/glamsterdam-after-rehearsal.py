#!/usr/bin/env python3
"""The runbook's Z1 = after (docs/runbooks/sepolia-core-v1.md), pasted into zsh against a LOCAL chain that runs Sepolia's
Glamsterdam rules (docs/evidence/SH-glamsterdam-after.md; for box 0's final candidate, docs/evidence/
SH-box0-final-candidate.md and scripts/post-fork-rehearsal.sh). Writes the runner files; `zsh -f -i` reads them as a
paste.

Every sh block is the runbook's own, with only these changes:
  - Z1's line `true` (the runbook's default since the review of d091e6bd), RPC (the settings' fifth line, and the
    life's setup line that keeps it) the local chain, SPEC (and Step 0's files) in
    script/config/rehearsal-runs/<port>/ (gitignored), Step 0's time the one given, with the rehearsal knob
    SH_OPEN_AT_MIN_LEAD (the runbook sets none);
  - the senders, one of:
      --keys <dir>  throwaway devnet accounts and their key files (made for the devnet, never a real wallet's: refused
                    under ~/.config/example-deployer), for a geth devnet;
      --unlocked    accounts the local anvil has unlocked (its own test accounts, or addresses it impersonates; the
                    runner impersonates WALLET, KEEPER and W1): no key at all. Step 3's `--private-key "$(sed …)"`
                    becomes `--unlocked`, every `--private-key "$(key $X_KEYFILE)"` becomes `--from $X --unlocked`,
                    the key files are `none` and `key` is replaced by a function that refuses;
    --deployer / --wallet1 name them (default: the runbook's testnet deployer and wallet 1);
  - Steps 2 and 3 run script/rehearsal/DeployCoreV1Devnet.s.sol (--script devnet, the default: the deploy script with
    Sepolia's fork time 0, for a devnet whose clock is before the fork, so drand's rounds exist; it refuses any chain
    past block 1,000,000) or the deploy script itself (--script real: a chain whose clock is past the fork);
  - Step 5's REGISTRY the one Step 3 deployed (an argument of the life runner);
  - the Sepolia platform Safe file (SH-SEP-BOX0-SAFE; the settings' SPEC since box 0's platform must be the Sepolia
    platform Safe): --platform-safe <a Safe on the local chain> is written into the rehearsal's own Safe file before
    the settings (as we commit the founder's Safe before he runs the runbook) and exported as SH_SEPOLIA_PLATFORM_SAFE
    for Step 0, which checks it on the chain (a 1-of-1 Safe) and writes it again with its time.
The runner sets FOUNDRY_NO_STORAGE_CACHING=true (no local chain state in Foundry's shared cache). Between blocks it adds
its own lines, each printed as REHEARSAL|...:
  deploy: --fund <ether>: wallet 1 sends that much to WALLET before Step 1 (the founder's transfer from his wallet app,
          § Z1 = after: fund the deployer; --unlocked only).
  life:   the verifier (Step 5's block) before the open, after the window, after graduation and at the end;
          --clock real: the runbook's waits run as written (the chain makes its own blocks, real time: drand's rounds
          exist); --clock fast: each pass of a chain-time wait mines one 12-second block instead of sleeping (a chain
          whose clock is past drand's published rounds: --skip its drand blocks);
          --skip G2,G3,...: those blocks are left out;
          G7 (the keeper's block, the runbook's last): interval mining off (automine on), the chain mined in 12-second
          blocks to --keeper-start blocks after graduation, wallet 1's trade in the background (--trade-at blocks after
          graduation: a buy, held 10 blocks, sold back: scripts/post-fork-probes.py trader), and the block's wait for
          the next block mines one 12-second block per pass (as core-v1-life-run.sh --runbook does for its waits);
          --probes: scripts/post-fork-probes.py before F4 (t-pending, on a snapshot), before F5 (graduate), after F5
          (followups) and before G6 (transfer); --ledger-from <block>: every transaction from that block at the end;
          --draws: R1's life (SH-box0-r1): after G6, scripts/post-fork-probes.py draws (the runbook's draw checked,
          then three draws by fresh drawers open at once, two opened), and after G7, draws-late (the third opened
          hours later, every draw's credit against the exact model); needs drand's rounds (not with --skip G4).

  python3 scripts/glamsterdam-after-rehearsal.py deploy --rpc http://127.0.0.1:8555 --open-at 2026-10-05T01:00Z \
      --keys <scratch dir with deployer.env/.addr, wallet1.env/.addr> --out <dir>
  python3 scripts/glamsterdam-after-rehearsal.py life --rpc ... --keys ... --registry 0x... --out <dir>
  python3 scripts/glamsterdam-after-rehearsal.py deploy --rpc http://127.0.0.1:8561 --unlocked --script real \
      --open-at 2026-10-06T14:40Z --fund 3.35 --out <dir>
  then, from packages/contracts: env PS1= PS2= zsh -f -i +o promptcr +o promptsp < <dir>/deploy-runner.zsh (and life)
"""
from __future__ import annotations

import argparse
import re
from pathlib import Path

CONTRACTS = Path(__file__).resolve().parents[1]
RUNBOOK = CONTRACTS.parents[1] / "docs/runbooks/sepolia-core-v1.md"
DEPLOYER_KEYFILE = "~/.config/example-deployer/sepolia-deployer.env"
TESTNET_DEPLOYER = "0x1F1481667Ef20928d55524dfE4640f96Bd9b4eeE"
WALLET1 = "0x5583f846B0dDC80f49ea0E89C51520bA341c6658"
# The runbook's example registry (nonce 13), which the life runner swaps for the rehearsal's own: since F143's
# sixteen-transaction deployment (the BoxBackedSource call is row 14) the factory and its registry moved by one nonce.
EXAMPLE_REGISTRY = "0xa94936CD8994FA94FA31bc1fC992586f2468bfcb"
SPEC_FILES = ("box0-spec.11155111.rehearsal.json", "box0-spec.11155111.json", "box0-spec.11155111.safe.json",
              "box0-spec.11155111.rehearsal.sepolia-safe.json")
SAFE_FILE = SPEC_FILES[3]
CHAIN_WAIT = re.compile(r'^(\s*until \[ "\$\(cast block latest --field timestamp --rpc-url \$RPC\)" -ge "[^\n]*" \]; do )'
                        r'sleep [0-9]+(; done)$', re.M)
NEXT_BLOCK_WAIT = re.compile(r'^(\s*until NB=\$\(cast block-number --rpc-url \$RPC\) && \[ "\$NB" -gt "\$N" \]; do )'
                             r'sleep [0-9]+(; done)$', re.M)


def blocks(text: str) -> list[tuple[str, str]]:
    """(the heading above it, the body) of every sh block, in order."""
    out, heading = [], ""
    for m in re.finditer(r"^(#{2,3}) ([^\n]+)$|^```sh\n(.*?)^```", text, re.M | re.S):
        if m.group(2):
            heading = m.group(2)
        else:
            out.append((heading, m.group(3)))
    return out


def plain(heading: str) -> str:
    """A heading as plain text for the runner's echo lines (no backquote, $, quote or backslash: none expands)."""
    return re.sub(r"[`$\"'\\]", "", heading)


def one(found: list, what: str):
    if len(found) != 1:
        raise SystemExit(f"expected one {what} block in the runbook, found {len(found)}")
    return found[0]


def sub(body: str, pattern: str, repl: str, what: str, count: int = 1) -> str:
    new, n = re.subn(pattern, repl, body, flags=re.M)
    if n != count:
        raise SystemExit(f"{what}: expected {count} match(es) of {pattern!r}, found {n}")
    return new


def senders(a) -> dict:
    """The deployer and wallet 1: throwaway keys (--keys) or anvil-unlocked addresses (--unlocked)."""
    if a.unlocked:
        return {"deployer": a.deployer, "wallet1": a.wallet1, "deployer_file": "none", "wallet1_file": "none"}
    d = Path(a.keys)
    if "/.config/example-deployer" in str(d.resolve()):
        raise SystemExit("--keys must be the rehearsal's own throwaway keys, never ~/.config/example-deployer")
    return {n: (d / f"{n}.addr").read_text().strip() for n in ("deployer", "wallet1")} | {
        f"{n}_file": str(d / f"{n}.env") for n in ("deployer", "wallet1")
    }


def keyless(body: str, what: str) -> str:
    """--unlocked: every key use becomes an unlocked sender; nothing that reads a key is left."""
    body = re.sub(r'--private-key "\$\(key \$([A-Z0-9]+)_KEYFILE\)"', r"--from $\1 --unlocked", body)
    body = re.sub(r'^(\s*)--private-key "\$\(sed [^\n]*\)" \\$', r"\1--unlocked \\", body, flags=re.M)
    body = re.sub(r"^key\(\) \{.*\}$", 'key() { echo "refused: no key in the rehearsal" >&2; return 1; }', body,
                  flags=re.M)
    if "--private-key" in body or "$(key " in body or "~/.config/example-deployer" in body:
        raise SystemExit(f"{what}: a key use is left")
    return body


def keyed(body: str, k: dict) -> str:
    """Step 3's key file: the throwaway deployer's (KEEPER_KEYFILE and W1_KEYFILE are set in the once-per-terminal block)."""
    return body.replace(DEPLOYER_KEYFILE, k["deployer_file"])


def deploy(a, text: str) -> str:
    k = senders(a)
    spec_dir = f"script/config/rehearsal-runs/{a.rpc.rsplit(':', 1)[1]}"
    script = "script/DeployCoreV1.s.sol" if a.script == "real" else "script/rehearsal/DeployCoreV1Devnet.s.sol"
    bs = blocks(text)
    settings = one([b for h, b in bs if re.search(r"^export SPEC=", b, re.M)], "settings")
    settings = sub(settings, r"^export SH_CORE_V1_GLAMSTERDAM_ACK=(?:true|false)$", "export SH_CORE_V1_GLAMSTERDAM_ACK=true",
                   "Z1")
    spec_name = re.search(r"^export SPEC=script/config/(\S+)$", settings, re.M)
    if spec_name is None or spec_name.group(1) not in SPEC_FILES:
        raise SystemExit("the settings' SPEC is none of the four Sepolia spec files in script/config")
    if spec_name.group(1) == SAFE_FILE and not a.platform_safe:
        raise SystemExit(f"the settings name {SAFE_FILE}: --platform-safe <the local chain's Safe> is needed")
    settings = sub(settings, r"^export SPEC=script/config/", f"export SPEC={spec_dir}/", "SPEC")
    settings = sub(settings, rf"^export WALLET={TESTNET_DEPLOYER}$", f"export WALLET={k['deployer']}", "WALLET")
    settings = sub(settings, r"^export RPC=\S+$", f"export RPC={a.rpc}", "RPC")
    unchanged = one([b for h, b in bs if re.search(r"^export PLATFORM=", b, re.M) and "AFTER=" in b], "unchanged")
    if re.search(r"^export RPC=", unchanged, re.M):
        raise SystemExit("the unchanged block sets RPC again: the settings' fifth line holds it")
    step0 = one([b for h, b in bs if b.startswith("scripts/sepolia-open-at.sh ")], "Step 0")
    step0 = sub(step0, r"^scripts/sepolia-open-at\.sh \S+$", f"scripts/sepolia-open-at.sh {a.open_at}", "Step 0 time")
    step1 = one([b for h, b in bs if h.startswith("Step 1")], "Step 1")
    step2 = one([b for h, b in bs if h.startswith("Step 2")], "Step 2")
    step3 = one([b for h, b in bs if h.startswith("Step 3")], "Step 3")
    step2 = sub(step2, r"script/DeployCoreV1\.s\.sol", script, "Step 2")
    step3 = sub(step3, r"script/DeployCoreV1\.s\.sol", script, "Step 3")
    step3 = keyless(step3, "Step 3") if a.unlocked else keyed(step3, k)
    parts = [
        f'cd "{CONTRACTS}"',
        # forge against a local chain with Sepolia's chain id must not write Foundry's shared RPC cache.
        "export FOUNDRY_NO_STORAGE_CACHING=true",
        f"export SH_SEPOLIA_SPEC_DIR={spec_dir} SH_OPEN_AT_MIN_LEAD={a.min_lead}",
        f"mkdir -p {spec_dir} && cp " + " ".join(f"script/config/{f}" for f in SPEC_FILES) + f" {spec_dir}/",
    ]
    if a.platform_safe:
        # Our commit of the founder's Safe, for this chain's Safe: the Safe file written with it (the time Step 0's).
        parts.append(f"export SH_SEPOLIA_PLATFORM_SAFE={a.platform_safe}")
        parts.append(f'echo "REHEARSAL|platform safe|{a.platform_safe}|written into {spec_dir}/{SAFE_FILE}"')
        parts.append(f"(cd ../.. && SH_SEPOLIA_SPEC_DIR={spec_dir} SH_SEPOLIA_OPEN_AT={a.open_at} SH_WRITE_VECTORS= "
                     "node_modules/.bin/vitest run packages/box-spec/src/sepolia-box0-spec.test.ts >/dev/null 2>&1) "
                     '|| echo "REFUSED: the rehearsal\'s Safe file was not written"')
    for label, body in (("settings (Z1 = after)", settings), ("unchanged", unchanged), ("Step 0", step0),
                        ("Step 1", step1), ("Step 2", step2), ("Step 3", step3)):
        if label == "Step 1" and a.fund:
            if not a.unlocked:
                raise SystemExit("--fund needs --unlocked (wallet 1 is impersonated)")
            parts.append(f'echo "REHEARSAL|fund|wallet 1 sends {a.fund} to WALLET (the founder wallet app)|'
                         f'WALLET nonce $(cast nonce $WALLET --rpc-url $RPC)"')
            parts.append(f"cast rpc anvil_impersonateAccount {k['wallet1']} --rpc-url $RPC >/dev/null")
            parts.append(f"cast send $WALLET --value {a.fund}ether --from {k['wallet1']} --unlocked --rpc-url $RPC "
                         "| grep -E '^(status|gasUsed) '")
            parts.append('echo "REHEARSAL|fund|WALLET nonce $(cast nonce $WALLET --rpc-url $RPC), balance '
                         '$(cast balance $WALLET --ether --rpc-url $RPC)"')
        if label == "Step 3" and a.unlocked:
            parts.append("cast rpc anvil_impersonateAccount $WALLET --rpc-url $RPC >/dev/null")
            parts.append('echo "REHEARSAL|block|before Step 3|block $(cast block-number --rpc-url $RPC)|WALLET nonce '
                         '$(cast nonce $WALLET --rpc-url $RPC), balance $(cast balance $WALLET --rpc-url $RPC) wei"')
        parts.append(f'echo "REHEARSAL|block|{label}|$(date -u +%H:%M:%S)"')
        parts.append(body.rstrip("\n"))
    parts.append('echo "REHEARSAL|after Step 3|block $(cast block-number --rpc-url $RPC)|WALLET nonce '
                 '$(cast nonce $WALLET --rpc-url $RPC), balance $(cast balance $WALLET --rpc-url $RPC) wei"')
    parts.append('echo "REHEARSAL|done|deploy"')
    return "\n".join(parts) + "\n"


def life(a, text: str) -> str:
    k = senders(a)
    rpc = a.rpc
    spec_dir = f"script/config/rehearsal-runs/{rpc.rsplit(':', 1)[1]}"
    start = text.index("## After the deploy: filling the curve")
    bs = blocks(text[start:])
    verifier = one([b for h, b in blocks(text) if h.startswith("Step 5")], "Step 5")
    verifier = sub(verifier, rf"^export REGISTRY={EXAMPLE_REGISTRY}$", f"export REGISTRY={a.registry}", "REGISTRY")
    skip = {s for s in (a.skip or "").split(",") if s}
    probes = f"python3 scripts/post-fork-probes.py --rpc {rpc} --registry {a.registry}"
    mine = f"cast rpc anvil_mine 0x1 0xc --rpc-url {rpc} >/dev/null"
    settings = one([b for h, b in blocks(text) if re.search(r"^export SPEC=", b, re.M)], "settings")
    spec_name = re.search(r"^export SPEC=script/config/(\S+)$", settings, re.M)
    if spec_name is None or spec_name.group(1) not in SPEC_FILES:
        raise SystemExit("the settings' SPEC is none of the four Sepolia spec files in script/config")
    out = [f'cd "{CONTRACTS}"', "export FOUNDRY_NO_STORAGE_CACHING=true",
           f"export SH_CORE_V1_SPEC_FILE={spec_dir}/{spec_name.group(1)}"]
    if a.unlocked:
        out.append(f"for a in {k['deployer']} {k['wallet1']}; do cast rpc anvil_impersonateAccount $a --rpc-url {rpc} "
                   ">/dev/null; done")

    def verify(label: str) -> None:
        out.append(f'echo "REHEARSAL|verifier|{label}|block $(cast block-number --rpc-url {rpc})|$(date -u +%H:%M:%S)"')
        out.append(verifier.rstrip("\n"))

    def chain_wait(var: str) -> str:
        """Wait until the chain's latest block is at $var: as written (real clock) or mined (fast clock)."""
        step = mine if a.clock == "fast" else "sleep 3"
        return f'until [ "$(cast block latest --field timestamp --rpc-url $RPC)" -ge "${var}" ]; do {step}; done'

    draws = f"{probes} draws --state {a.out}/draws-state.json" + (
        f" --from-block {a.ledger_from}" if a.ledger_from is not None else "")
    if a.draws and skip & {"G2", "G3", "G4", "G6"}:
        raise SystemExit("--draws needs drand's rounds and the runbook's draw: G2, G3, G4 and G6 must run")
    tags = []
    for heading, body in bs:
        tag = heading.split(" ")[0]
        tags.append(tag)
        if tag == "G7" and a.draws:
            out.append(f'echo "REHEARSAL|draws|R1: several draws open at once, one opened late|block '
                       f'$(cast block-number --rpc-url {rpc})|$(date -u +%H:%M:%S)"')
            out.append(draws)
        if tag in skip:
            out.append(f'echo "REHEARSAL|skipped|{plain(heading)}"')
            continue
        body = sub(body, r"^export RPC=\S+$", f"export RPC={rpc}", "RPC", body.count("export RPC="))
        if tag == "Once":
            body = sub(body, rf"^export REGISTRY={EXAMPLE_REGISTRY}$", f"export REGISTRY={a.registry}", "REGISTRY")
            body = sub(body, rf"^export KEEPER={TESTNET_DEPLOYER} KEEPER_KEYFILE=\S+$",
                       f"export KEEPER={k['deployer']} KEEPER_KEYFILE={k['deployer_file']}", "KEEPER")
            body = sub(body, rf"^export W1={WALLET1} W1_KEYFILE=\S+$",
                       f"export W1={k['wallet1']} W1_KEYFILE={k['wallet1_file']}", "W1")
        if a.unlocked:
            body = keyless(body, heading)
        if "~/.config/example-deployer" in body:
            raise SystemExit(f"{heading}: a real key file is left")
        if a.clock == "fast":
            body = CHAIN_WAIT.sub(lambda m: f"{m.group(1)}{mine}{m.group(2)}", body)
        if tag == "F3":
            out.append('echo "REHEARSAL|wait|the end of the window|$(date -u +%H:%M:%S)"')
            out.append(chain_wait("END"))
            verify("after the window")
        if tag == "F4" and a.probes:
            out.append(f"{probes} t-pending --sender $KEEPER --wallet $W1")
        if tag == "F5" and a.probes:
            out.append(f"{probes} graduate --sender $KEEPER")
        if tag == "G6" and a.probes:
            out.append(f"{probes} transfer --wallet $W1 --to $KEEPER --id $ITEM2")
        if tag == "G7":
            if not NEXT_BLOCK_WAIT.search(body):
                raise SystemExit("G7: the keeper block has no wait for the next block")
            body = NEXT_BLOCK_WAIT.sub(lambda m: f"{m.group(1)}{mine}{m.group(2)}", body)
            out.append(f"cast rpc evm_setIntervalMining 0 --rpc-url {rpc} >/dev/null; "
                       f"cast rpc evm_setAutomine true --rpc-url {rpc} >/dev/null")
            out.append(f"M=$(c $HOOK 'migratedAtBlock()(uint256)'); B=$(cast block-number --rpc-url {rpc}); "
                       f"if [ $B -lt $((M + {a.keeper_start})) ]; then cast rpc anvil_mine "
                       f"$(cast to-hex $((M + {a.keeper_start} - B))) 0xc --rpc-url {rpc} --rpc-timeout 600 >/dev/null; fi")
            out.append(f'echo "REHEARSAL|keeper|graduation at block $M; the keeper block from block '
                       f'$(cast block-number --rpc-url {rpc}) (graduation + {a.keeper_start} or later)"')
            if a.trade_at:
                out.append(f"{probes} trader --wallet $W1 --at $((M + {a.trade_at})) --hold 10 --value 0.055 &")
        out.append(f'echo "REHEARSAL|block|{plain(heading)}|block $(cast block-number --rpc-url {rpc})|'
                   f'$(date -u +%H:%M:%S)"')
        out.append(body.rstrip("\n"))
        if tag == "Once":
            verify("before the open")
        if tag == "F5":
            if a.probes:
                out.append(f"{probes} followups")
            verify("after graduation")
        if tag == "G7" and a.trade_at:
            out.append("wait")
    if tags[-1] != "G7":
        raise SystemExit(f"the keeper block (G7) is not the runbook's last ({tags[-1]})")
    if a.draws:
        out.append(f'echo "REHEARSAL|draws|R1: the late opening and the claims|block '
                   f'$(cast block-number --rpc-url {rpc})|$(date -u +%H:%M:%S)"')
        out.append(f"{probes} draws-late --state {a.out}/draws-state.json")
    verify("at the end")
    if a.ledger_from is not None:
        out.append(f"python3 scripts/post-fork-probes.py ledger --rpc {rpc} --from-block {a.ledger_from} "
                   f"--out {a.out}/ledger.tsv")
    out.append('echo "REHEARSAL|done|life"')
    return "\n".join(out) + "\n"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("part", choices=["deploy", "life"])
    ap.add_argument("--rpc", required=True)
    who = ap.add_mutually_exclusive_group(required=True)
    who.add_argument("--keys", help="a folder of throwaway devnet keys (deployer, wallet1: .env and .addr)")
    who.add_argument("--unlocked", action="store_true", help="anvil-unlocked senders: no key at all")
    ap.add_argument("--deployer", default=TESTNET_DEPLOYER, help="--unlocked: WALLET and KEEPER")
    ap.add_argument("--wallet1", default=WALLET1, help="--unlocked: W1")
    ap.add_argument("--script", choices=["devnet", "real"], default="devnet")
    ap.add_argument("--open-at", help="deploy: Step 0's time, like 2026-10-05T01:00Z")
    ap.add_argument("--min-lead", default="1200", help="deploy: SH_OPEN_AT_MIN_LEAD (seconds, at least 900)")
    ap.add_argument("--fund", help="deploy, --unlocked: wallet 1 sends this much ether to WALLET before Step 1")
    ap.add_argument("--platform-safe", help="deploy: the local chain's Sepolia platform Safe (the Safe file's platform)")
    ap.add_argument("--registry", help="life: the registry Step 3 deployed")
    ap.add_argument("--clock", choices=["real", "fast"], default="real")
    ap.add_argument("--skip", help="life: blocks left out, by tag (G2,G3,...)")
    ap.add_argument("--probes", action="store_true")
    ap.add_argument("--keeper-start", type=int, default=280, help="life: G7 starts this many blocks after graduation")
    ap.add_argument("--trade-at", type=int, default=0, help="life: wallet 1 trades this many blocks after graduation")
    ap.add_argument("--ledger-from", type=int)
    ap.add_argument("--draws", action="store_true", help="life: R1's overlapping draws after G6, the late one after G7")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    if not re.fullmatch(r"http://127\.0\.0\.1:(85(5[3-9]|[6-9][0-9])|546[0-9])", a.rpc):
        raise SystemExit("--rpc must be a local chain on 127.0.0.1:8553-8599 or 5460-5469")
    if a.platform_safe and not re.fullmatch(r"0x[0-9a-fA-F]{40}", a.platform_safe):
        raise SystemExit(f"--platform-safe {a.platform_safe} is not an address")
    if a.unlocked:
        for addr in (a.deployer, a.wallet1):
            if not re.fullmatch(r"0x[0-9a-fA-F]{40}", addr):
                raise SystemExit(f"{addr} is not an address")
    text = RUNBOOK.read_text()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    if a.part == "deploy":
        (out / "deploy-runner.zsh").write_text(deploy(a, text))
    else:
        (out / "life-runner.zsh").write_text(life(a, text))
    print(f"written into {out}")


if __name__ == "__main__":
    main()
