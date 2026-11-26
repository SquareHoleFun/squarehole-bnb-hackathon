#!/usr/bin/env python3
"""Rehearses hackathon/flap-rules/commands.txt on a local fork of chain 97 in the step runner's order.

  python3 -I hackathon/flap-rules/rehearse.py [--port 8578] [--file hackathon/flap-rules/commands.txt]

From the repository root. Starts its own anvil (refuses a port another node answers on), runs every step's dry call,
send and check, compares the check with its `# expect` (">=N" compares the first number; otherwise the output's first
words must equal the expected words), and prints the gas and each wallet's BNB spent per step and in total. No key:
each `--account <name> --password-file <file>` becomes `--unlocked` (forge keeps its --sender; cast send gets --from).
"""
import argparse
import os
import re
import subprocess
import sys
import time

sys.stdout.reconfigure(line_buffering=True)

WALLETS = {
    "hack-deployer": "0x2EF9A78074bbf674bEA16f21154a30c821A3C576",
    "hack-alice": "0x2908E3351ec8F20a8a6746773e42EA1D2FFb3c7F",
    "hack-bob": "0xc979F6Cb8902f56f76b926358dC451cBF8f310F0",
}
KEY = re.compile(r"--account (hack-[a-z]+) --password-file \S+")


def unlocked(line):
    m = KEY.search(line)
    if not m:
        return line
    repl = "--unlocked" if "forge script" in line else f"--unlocked --from {WALLETS[m.group(1)]}"
    return KEY.sub(repl, line)


def sh(cmd, env, timeout=900):
    p = subprocess.run(["bash", "-c", cmd], env=env, capture_output=True, text=True, timeout=timeout)
    return p.returncode, p.stdout, p.stderr


def steps_of(path):
    steps, cur = [], None
    for raw in open(path):
        line = raw.rstrip("\n")
        m = re.match(r"^# (\d+) (.*)$", line)
        if m:
            cur = {"n": int(m.group(1)), "what": m.group(2), "lines": []}
            steps.append(cur)
        elif cur is not None and line.strip() and not line.startswith("#"):
            cur["lines"].append(line)
    for s in steps:
        if len(s["lines"]) != 3:
            sys.exit(f"step {s['n']} has {len(s['lines'])} lines, not 3")
    return steps


def words(text):
    text = re.sub(r"\[[^\]]*\]", " ", text)  # cast's [1e18] annotations
    return text.split()


def matches(out, expect):
    if expect.startswith(">="):
        got = words(out)
        return bool(got) and got[0].isdigit() and int(got[0]) >= int(expect[2:])
    want = expect.split()
    got = words(out)
    return [w.lower() for w in got[: len(want)]] == [w.lower() for w in want]


def num(cmd, env):
    code, out, _ = sh(cmd, env, 60)
    return int(words(out)[0]) if code == 0 and words(out) else 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8578)
    ap.add_argument("--file", default="hackathon/flap-rules/commands.txt")
    ap.add_argument("--fork-url", default="https://bsc-testnet-rpc.publicnode.com")
    a = ap.parse_args()
    rpc = f"http://127.0.0.1:{a.port}"
    env = dict(os.environ, RPC=rpc)
    if sh(f"cast block-number -r {rpc}", env, 20)[0] == 0:
        sys.exit(f"port {a.port} is taken by another node")
    # blocks every second, as on the network: a step's transaction never shares a block (and its second) with the one
    # before it (the stake's claim right after a sync must see time pass, as it does live)
    anvil = subprocess.Popen(["anvil", "--port", str(a.port), "--fork-url", a.fork_url, "--auto-impersonate", "--silent",
                              "--block-time", "1"])
    try:
        for _ in range(60):
            if sh(f"cast block-number -r {rpc}", env, 20)[0] == 0:
                break
            time.sleep(1)
        time.sleep(1)
        if anvil.poll() is not None:
            sys.exit("the anvil this script started is not running")
        if num(f"cast chain-id -r {rpc}", env) != 97:
            sys.exit("not a fork of chain 97")
        print(f"anvil {anvil.pid} on {a.port}, fork block {num(f'cast block-number -r {rpc}', env)}")
        bal = lambda w: num(f"cast balance {w} -r {rpc}", env)
        start = {k: bal(v) for k, v in WALLETS.items()}
        print("start balances (wei): " + ", ".join(f"{k} {v}" for k, v in start.items()))
        total_gas = 0
        for s in steps_of(a.file):
            dry, send, check = (unlocked(x) for x in s["lines"])
            b0 = num(f"cast block-number -r {rpc}", env)
            before = {k: bal(v) for k, v in WALLETS.items()}
            for label, cmd in (("dry", dry), ("send", send)):
                code, out, err = sh(cmd, env)
                if code != 0:
                    print(f"STEP {s['n']} {label} FAILED (exit {code}): {s['what']}")
                    print((out + err)[-3000:])
                    sys.exit(1)
            cmd, _, expect = check.partition("# expect ")
            code, out, err = sh(cmd, env, 120)
            ok = code == 0 and matches(out, expect.strip())
            b1 = num(f"cast block-number -r {rpc}", env)
            gas = sum(num(f"cast block {b} --field gasUsed -r {rpc}", env) for b in range(b0 + 1, b1 + 1))
            total_gas += gas
            spent = {k: before[k] - bal(v) for k, v in WALLETS.items()}
            spent_s = ", ".join(f"{k[5:]} {v / 1e18:.6f}" for k, v in spent.items() if v)
            shown = " ".join(words(out))[:90]
            print(f"STEP {s['n']:>2} {'ok ' if ok else 'BAD'} gas {gas:>10,} | tBNB spent: {spent_s or '0'} | check '{shown}' expect '{expect.strip()}' | {s['what']}")
            if not ok:
                print((out + err)[-2000:])
                sys.exit(1)
        end = {k: bal(v) for k, v in WALLETS.items()}
        print(f"TOTAL gas {total_gas:,} = {total_gas * 100_000_000 / 1e18:.6f} tBNB at 0.1 gwei")
        for k in WALLETS:
            print(f"  {k}: spent {(start[k] - end[k]) / 1e18:.6f} tBNB (gas, salt fees, curve and pool buys, transfers)")
    finally:
        anvil.terminate()
        anvil.wait()


if __name__ == "__main__":
    main()
