#!/usr/bin/env python3
"""Writes hackathon/flap-rules/commands.txt: the Flap rules, stake and launches real run (SH-287 / SH-290).

  python3 hackathon/flap-rules/make-commands.py      # from the repository root

Every step: a comment line `# <n> <what>`, the dry call, the send, a check read ending in `# expect <text>`.
Forge steps: the simulation (no --broadcast, no key) is the dry call, the same line with the keystore and
--broadcast is the send. Lines run from the repository root; forge lines carry their own `cd` in a subshell.
Addresses made by earlier steps are read from the deployments files with jq when the line runs.
"""
import os

D, A, B = (
    "0x2EF9A78074bbf674bEA16f21154a30c821A3C576",  # hack-deployer
    "0x2908E3351ec8F20a8a6746773e42EA1D2FFb3c7F",  # hack-alice
    "0xc979F6Cb8902f56f76b926358dC451cBF8f310F0",  # hack-bob
)
WHO = {"deployer": (D, "hack-deployer"), "alice": (A, "hack-alice"), "bob": (B, "hack-bob")}
HELPER = "0x77779969a11eff7582f3bCf48135A846A3457777"
PORTAL = "0x000042108465206185A077Edc3F3fd2b49060000"
USD = "0x190C989D5665a0e404B444b53CAE9AbCfb600157"
GAS = "--legacy --with-gas-price 100000000"
CGAS = "--chain 97 --legacy --gas-price 100000000"
DEP = "bounties/flap/deployments"
NATIVE = f"{DEP}/97-rules-native.json"
USDF = f"{DEP}/97-rules-usdt.json"
STAKEF = f"{DEP}/97-stake.json"
SWEET = f"{DEP}/97-rules-native-sale.json"
PACKET = f"{DEP}/97-rules-usdt-sale.json"


def j(file, key):
    return f"$(jq -r .{key} {file})"


def key(who):
    _, name = WHO[who]
    return f"--account {name} --password-file ~/.secrets/{name}.pass"


steps = []


def forge(n, what, who, script, env, check):
    addr, _ = WHO[who]
    base = f"( cd bounties/flap && {env} forge script script/{script} --rpc-url \"$RPC\" --sender {addr} {GAS} --slow"
    steps.append((n, what, f"{base} )", f"{base} {key(who)} --broadcast )", check))


def cast(n, what, who, to_sig_args, check, value=None):
    addr, _ = WHO[who]
    v = f" --value {value}" if value else ""
    dry = f"cast call --from {addr} {to_sig_args}{v} --rpc-url \"$RPC\""
    send = f"cast send {to_sig_args}{v} {key(who)} --rpc-url \"$RPC\" {CGAS}"
    steps.append((n, what, dry, send, check))


def call(target, sig, *args, expect):
    parts = ["cast call", target, f"'{sig}'", *args, '--rpc-url "$RPC"']
    return " ".join(parts) + f"   # expect {expect}"


n = 0


def nxt():
    global n
    n += 1
    return n


# ── the contracts ──────────────────────────────────────────────────────────
forge(nxt(), "deploy the rules pair for BNB (4 tx) -> deployments/97-rules-native.json", "deployer",
      "DeployRules.s.sol", "VARIANT=native",
      call(j(NATIVE, "rulesVaultFactory"), "quote()(address)", expect="0x0000000000000000000000000000000000000000"))
forge(nxt(), "deploy the rules pair for the test dollar (4 tx) -> deployments/97-rules-usdt.json", "deployer",
      "DeployRules.s.sol", "VARIANT=usdt",
      call(j(USDF, "rulesVaultFactory"), "quote()(address)", expect=USD))
forge(nxt(), "deploy the RailStakeFactory (1 tx) -> deployments/97-stake.json", "deployer",
      "DeployStake.s.sol", "",
      call(j(STAKEF, "factory"), "MIN_PERIOD()(uint256)", expect="3600"))

# ── Flap's helper: multiplier 0 for the two rules launcher factories (no Portal floor) ─────────────
for file, label in ((NATIVE, "BNB"), (USDF, "test-dollar")):
    lf = j(file, "launcherFactory")
    cast(nxt(), f"Flap's helper: whitelist the rules {label} launcher factory at multiplier 0", "deployer",
         f"{HELPER} 'whitelist(address,uint16)' {lf} 0",
         call(PORTAL, "launcherFactoryMultiplier(address)(bool,uint16)", lf, expect="true 0"))

# ── gas and BNB for the two buyers ────────────────────────────────────────
for who in ("alice", "bob"):
    addr, _ = WHO[who]
    steps.append((nxt(), f"{who} gets 0.06 tBNB from hack-deployer (curve buy, pool trade, gas)",
                  f"cast call --from {D} {addr} --value 60000000000000000 --rpc-url \"$RPC\"",
                  f"cast send {addr} --value 60000000000000000 {key('deployer')} --rpc-url \"$RPC\" {CGAS}",
                  f"cast balance {addr} --rpc-url \"$RPC\"   # expect >=60000000000000000"))

# ── (i) Sweet Jar: BNB, creator 10, pile 60, buy and burn 30 ───────────────
SW = f"VARIANT=native SALE_FILE=deployments/97-rules-native-sale.json"
SWEET_CREATE = (f"{SW} NAME='Sweet Jar' SYMBOL=SWEET META='<META_SWEET>' TARGET_WEI=100000000000000000 "
                f"VIRTUAL_WEI=680000000000000000 CREATOR_BPS=1000 PILE_BPS=6000 BURN_BPS=3000 SALT_SEED=sweet-jar")
L = j(SWEET, "launcher")
T = j(SWEET, "token")
SWEET_N = n + 1
forge(nxt(), "Sweet Jar: set the rules, then create the sale through Portal.newLauncher (2 tx; 0.005 salt fee)",
      "deployer", "CreateRulesSale.s.sol", SWEET_CREATE, call(L, "phase()(uint8)", expect="0"))
forge(nxt(), "Sweet Jar: alice buys 0.02 tBNB on the curve", "alice", "Sale.s.sol",
      f"{SW} ACTION=buy AMOUNT_WEI=20000000000000000", call(L, "tokensOf(address)(uint256)", A, expect=">=1"))
forge(nxt(), "Sweet Jar: bob buys 0.02 tBNB on the curve", "bob", "Sale.s.sol",
      f"{SW} ACTION=buy AMOUNT_WEI=20000000000000000", call(L, "tokensOf(address)(uint256)", B, expect=">=1"))
forge(nxt(), "Sweet Jar: the deployer buys the rest and launches (the fill)", "deployer", "Sale.s.sol",
      f"{SW} ACTION=complete", call(L, "phase()(uint8)", expect="1"))
for who in ("alice", "bob", "deployer"):
    addr, _ = WHO[who]
    forge(nxt(), f"Sweet Jar: {who} claims", who, "Sale.s.sol", f"{SW} ACTION=claim",
          call(T, "balanceOf(address)(uint256)", addr, expect=">=1"))
forge(nxt(), "Sweet Jar: alice buys on the pool for 0.005 tBNB", "alice", "Sale.s.sol",
      f"{SW} ACTION=pool-buy AMOUNT_WEI=5000000000000000", call(T, "balanceOf(address)(uint256)", A, expect=">=1"))
forge(nxt(), "Sweet Jar: bob sells 10,000,000 tokens on the pool", "bob", "Sale.s.sol",
      f"{SW} ACTION=pool-sell TOKENS_WEI=10000000000000000000000000", call(T, "balanceOf(address)(uint256)", B, expect=">=1"))
SPL_SW = f"$(cast call {L} 'pileVault()(address)' --rpc-url \"$RPC\")"
forge(nxt(), "Sweet Jar: dispatch the tax processor's waiting vault share to the splitter (a measured zero is fine)",
      "deployer", "RulesSale.s.sol", f"{SW} ACTION=dispatch",
      call(SPL_SW, "ruleCount()(uint256)", expect="3"))
forge(nxt(), "Sweet Jar: the share-out among the rules (creator, pile, buy and burn)", "deployer", "RulesSale.s.sol",
      f"{SW} ACTION=distribute", call(SPL_SW, "delivered(uint256)(uint256)", "0", expect=">=1"))
steps.append((nxt(), "Sweet Jar: the reads of each rule (no transaction): status, then the pile's and the burn's amounts",
              f"( cd bounties/flap && {SW} ACTION=status forge script script/RulesSale.s.sol --rpc-url \"$RPC\" )",
              call(SPL_SW, "delivered(uint256)(uint256)", "1", expect=">=1").split("   #")[0],
              call(SPL_SW, "burned(uint256)(uint256)", "2", expect=">=1")))

# ── (ii) Pay Packet: test dollar, creator 10, pile 30, holders 40 (the stake), buy and burn 20 ──────
PK = "VARIANT=usdt SALE_FILE=deployments/97-rules-usdt-sale.json DEPLOYMENTS_FILE=deployments/97-rules-usdt.json"
for who, amt in (("deployer", "5000000000000000000000"), ("alice", "1000000000000000000000"), ("bob", "1000000000000000000000")):
    addr, _ = WHO[who]
    forge(nxt(), f"Pay Packet: {who} mints {int(amt) // 10**18} test dollars (Flap's test USDT mints openly)", who,
          "TokenSale.s.sol", f"{PK} ACTION=mint AMOUNT_WEI={amt}",
          call(USD, "balanceOf(address)(uint256)", addr, expect=f">={amt}"))
PACKET_CREATE = (f"{PK} NAME='Pay Packet' SYMBOL=PACKET META='<META_PACKET>' CREATOR_BPS=1000 PILE_BPS=3000 "
                 f"HOLDERS_BPS=4000 BURN_BPS=2000 STAKE_PERIOD=86400 STAKE_FILE=deployments/97-stake.json SALT_SEED=pay-packet")
L2 = j(PACKET, "launcher")
T2 = j(PACKET, "token")
S2 = j(PACKET, "stake")
PACKET_N = n + 1
forge(nxt(), "Pay Packet: the creator's stake for the token to come, the rules naming it, then the sale (3 tx; 0.005 salt fee)",
      "deployer", "CreateRulesSale.s.sol", PACKET_CREATE, call(S2, "period()(uint256)", expect="86400"))
forge(nxt(), "Pay Packet: alice buys for up to 300 test dollars on the curve", "alice", "TokenSale.s.sol",
      f"{PK} ACTION=buy MAX_COST_WEI=300000000000000000000", call(L2, "tokensOf(address)(uint256)", A, expect=">=1"))
forge(nxt(), "Pay Packet: bob buys for up to 200 test dollars on the curve", "bob", "TokenSale.s.sol",
      f"{PK} ACTION=buy MAX_COST_WEI=200000000000000000000", call(L2, "tokensOf(address)(uint256)", B, expect=">=1"))
forge(nxt(), "Pay Packet: the deployer buys the rest and launches (the fill)", "deployer", "TokenSale.s.sol",
      f"{PK} ACTION=complete", call(L2, "phase()(uint8)", expect="1"))
for who in ("alice", "bob", "deployer"):
    addr, _ = WHO[who]
    forge(nxt(), f"Pay Packet: {who} claims", who, "TokenSale.s.sol", f"{PK} ACTION=claim",
          call(T2, "balanceOf(address)(uint256)", addr, expect=">=1"))
forge(nxt(), "Pay Packet: alice buys on the pool for 100 test dollars", "alice", "TokenSale.s.sol",
      f"{PK} ACTION=pool-buy AMOUNT_WEI=100000000000000000000", call(T2, "balanceOf(address)(uint256)", A, expect=">=1"))
forge(nxt(), "Pay Packet: bob sells 10,000,000 tokens on the pool", "bob", "TokenSale.s.sol",
      f"{PK} ACTION=pool-sell TOKENS_WEI=10000000000000000000000000", call(T2, "balanceOf(address)(uint256)", B, expect=">=1"))
for who in ("alice", "bob"):
    addr, _ = WHO[who]
    forge(nxt(), f"Pay Packet: {who} stakes all her or his tokens", who, "Stake.s.sol", f"{PK} ACTION=stake",
          call(S2, "stakedOf(address)(uint256)", addr, expect=">=1"))
SPL_PK = f"$(cast call {L2} 'pileVault()(address)' --rpc-url \"$RPC\")"
forge(nxt(), "Pay Packet: dispatch the tax processor's waiting vault share to the splitter (a measured zero is fine)",
      "deployer", "RulesSale.s.sol", f"{PK} ACTION=dispatch", call(SPL_PK, "ruleCount()(uint256)", expect="4"))
forge(nxt(), "Pay Packet: the share-out: creator, pile, the holders' stake, buy and burn", "deployer", "RulesSale.s.sol",
      f"{PK} ACTION=distribute", call(S2, "unsynced()(uint256)", expect=">=1"))
forge(nxt(), "Pay Packet: a sync counts the holders' part and streams it over a day", "deployer", "Stake.s.sol",
      f"{PK} ACTION=sync", call(S2, "arrived()(uint256)", expect=">=1"))
# cast, not forge: a forge simulation in the sync's own second takes the nothing-to-pay path, and the gas it estimates
# from that is too little for the real payment a later block makes (seen on the fork)
cast(nxt(), "Pay Packet: alice claims what she earned so far (cast: gas estimated when it is sent)", "alice",
     f"{S2} 'claim()'", call(S2, "claimed()(uint256)", expect=">=1"))
forge(nxt(), "Pay Packet: bob unstakes all his tokens", "bob", "Stake.s.sol", f"{PK} ACTION=unstake",
      call(S2, "stakedOf(address)(uint256)", B, expect="0"))
steps.append((nxt(), "Pay Packet: the reads of each rule and of the stake (no transaction)",
              f"( cd bounties/flap && {PK} ACTION=status forge script script/RulesSale.s.sol --rpc-url \"$RPC\" )",
              f"( cd bounties/flap && {PK} ACTION=status forge script script/Stake.s.sol --rpc-url \"$RPC\" --sender {A} )",
              call(SPL_PK, "delivered(uint256)(uint256)", "2", expect=">=1")))

out = [
    "# SH-287 / SH-290: the Flap rules pairs, the stake factory, Sweet Jar (BNB) and Pay Packet (test dollar).",
    "# Generated by hackathon/flap-rules/make-commands.py. RPC=<the test network endpoint>; lines run from the repository",
    "# root of the merged checkout; forge lines cd into bounties/flap in a subshell; addresses made by earlier steps are",
    "# read from bounties/flap/deployments with jq when the line runs. Senders: hack-deployer " + D + ",",
    "# hack-alice " + A + ", hack-bob " + B + ". Gas price 0.1 gwei.",
    f"# Before step {SWEET_N} and step {PACKET_N} replace <META_SWEET> and <META_PACKET> with https://arweave.net/<id>#sha256=<hex>.",
    "# A forge dry call simulates and writes the deployments file it would write; the send writes it again for real.",
    "",
]
for n_, what, dry, send, check in steps:
    out += [f"# {n_} {what}", dry, send, check, ""]
path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "commands.txt")
open(path, "w").write("\n".join(out))
print(f"{len(steps)} steps -> {path}")
