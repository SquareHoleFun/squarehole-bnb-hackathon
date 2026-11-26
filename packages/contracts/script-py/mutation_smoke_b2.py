#!/usr/bin/env python3
"""Mutation smoke check of the SH-B2 Build B code, its review-round-B fixes and the SH-E F10 changes (committed so
reviewers can re-run it).

Each mutant plants ONE fault (an exact, unique text replacement), runs the listed Foundry test contracts, and restores
the source byte for byte (hash-checked, also on failure or Ctrl-C). A mutant is "killed" when `forge test` fails
(a failing test or a compile error). Nothing else is touched; no network, no keys.

Usage (from packages/contracts):  python3 script-py/mutation_smoke_b2.py            # every mutant
                                  python3 script-py/mutation_smoke_b2.py MB-B13 ...  # selected mutants
"""
from __future__ import annotations

import sys

sys.dont_write_bytecode = True

import hashlib  # noqa: E402
import os  # noqa: E402
import subprocess  # noqa: E402
from pathlib import Path  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
os.environ["PATH"] = os.path.expanduser("~/.foundry/bin") + os.pathsep + os.environ.get("PATH", "")

# (id, description, file, original text, mutated text, test contracts regex)
MUTANTS = [
    ("MB-B1", "converter (pair id): payout-T check skipped", "src/SquareHoleClaimConverter.sol",
     "        if (r.token == address(0)) revert UnknownPairId(pairId);\n        _checkPayoutT(r);",
     "        if (r.token == address(0)) revert UnknownPairId(pairId);", "V4ClaimConverterTest"),
    ("MB-B2", "converter (pair id): converts half the entitlement", "src/SquareHoleClaimConverter.sol",
     "(qIn, tOut) = _claimAsT(r, type(uint256).max, minTOut, deadline);",
     "(qIn, tOut) = _claimAsT(r, IRewardLedger(r.ledger).claimable(msg.sender) / 2, minTOut, deadline);",
     "V4ClaimConverterTest"),
    ("MB-B3", "converter: deadline not enforced", "src/SquareHoleClaimConverter.sol",
     "        if (block.timestamp > deadline) revert Expired(deadline);\n        (qIn, tOut) = abi.decode(",
     "        (qIn, tOut) = abi.decode(", "V4ClaimConverterTest"),
    ("MB-B4", "mock USDT: transfer returns a bool", "src/testnet/MockTetherUSD.sol",
     "    function transfer(address to, uint256 value) external whenNotPaused {\n"
     "        if (isBlackListed[msg.sender]) revert BlackListed(msg.sender);\n"
     "        _move(msg.sender, to, value);\n    }",
     "    function transfer(address to, uint256 value) external whenNotPaused returns (bool) {\n"
     "        if (isBlackListed[msg.sender]) revert BlackListed(msg.sender);\n"
     "        _move(msg.sender, to, value);\n        return true;\n    }", "MockTetherUSDTest"),
    ("MB-B5", "mock USDT: approve from non-zero allowed", "src/testnet/MockTetherUSD.sol",
     "if (value != 0 && allowance[msg.sender][spender] != 0) revert ApproveFromNonZero();", "",
     "MockTetherUSDTest"),
    ("MB-B6", "mock USDT: blacklist also blocks the recipient", "src/testnet/MockTetherUSD.sol",
     "        if (isBlackListed[msg.sender]) revert BlackListed(msg.sender);\n        _move(msg.sender, to, value);",
     "        if (isBlackListed[msg.sender] || isBlackListed[to]) revert BlackListed(msg.sender);\n"
     "        _move(msg.sender, to, value);", "MockTetherUSDTest|V4MockTetherTest"),
    ("MB-B7", "mock USDT: max allowance reduced", "src/testnet/MockTetherUSD.sol",
     "if (allowed < MAX_UINT) allowance[from][msg.sender] = allowed - value;",
     "allowance[from][msg.sender] = allowed - value;", "MockTetherUSDTest"),
    ("MB-B8", "mock USDT: fee not capped", "src/testnet/MockTetherUSD.sol",
     "if (fee > maximumFee) fee = maximumFee;", "", "MockTetherUSDTest"),
    ("MB-B9", "mock USDT: faucet lifetime cap off by one", "src/testnet/MockTetherUSD.sol",
     "if (faucetMinted + amount > FAUCET_TOTAL_CAP) revert FaucetExhausted();",
     "if (faucetMinted + amount >= FAUCET_TOTAL_CAP) revert FaucetExhausted();", "MockTetherUSDTest"),
    ("MB-B10", "mock USDT: pause ignored by transferFrom", "src/testnet/MockTetherUSD.sol",
     "function transferFrom(address from, address to, uint256 value) external whenNotPaused {",
     "function transferFrom(address from, address to, uint256 value) external {",
     "MockTetherUSDTest|V4MockTetherTest"),
    ("MB-B11", "deploy: every launch's reward side forced to Q (ORCHARD is R = T)", "script/Deploy.s.sol",
     "                    payoutAsset: l.rewardSide,", "                    payoutAsset: IRewardLedger.PayoutAsset.Q,",
     "DeployScriptTest"),
    ("MB-B12", "deploy: manifest hash not bound to the manifest file (SH-E: file-or-pinned-hash rule)",
     "script/Deploy.s.sol", "            h = keccak256(vm.readFileBinary(path));",
     "            h = keccak256(bytes(path));", "DeployScriptTest"),
    # Review round B fixes.
    ("MB-B13", "deploy: a hook already at the planned address is not adopted", "script/DeploySquareHole.s.sol",
     "        if (plannedHook.code.length != 0) {", "        if (false) {", "DeployScriptTest"),
    ("MB-B14", "deploy: an adopted hook's code hash is not checked", "script/DeploySquareHole.s.sol",
     "            require(\n                plannedHook.codehash == referenceHookCodehash(plannedHook, d.hookSalt, hookInit),\n"
     "                \"hook: foreign code at the planned address\"\n            );\n",
     "", "DeployScriptTest"),
    ("MB-B15", "finalize: launch block not checked against its receipt", "script/WriteManifest.s.sol",
     '            require(p.createdAtBlock == t.blockNumber, "finalize: launch block differs from its receipt");\n',
     "", "FinalizeTest"),
    ("MB-B16", "finalize: a failed transaction is accepted", "script/WriteManifest.s.sol",
     '_same(t.txType, "CREATE2") && _same(t.contractName, "SquareHoleHook") && !hookFrontRun,', "true,",
     "FinalizeTest"),
    ("MB-B17", "provenance: a dirty tree is accepted on a public chain", "script/lib/DeploymentManifest.sol",
     'chainId == LOCAL_CHAIN_ID || _same(g.gitDirty, "false"),', "true,", "FinalizeTest"),
    ("MB-B18", "finalize: code hashes not compared with the plan", "script/WriteManifest.s.sol",
     "json.readBytes32(string.concat(k, \".codehash\")) == pending.readBytes32(string.concat(k, \".codehash\")),",
     "true,", "FinalizeTest"),
    ("MB-B19", "manifest: an unknown dirty flag written as false", "script/Deploy.s.sol",
     'if (bytes(g.gitDirty).length == 0) vm.serializeString(root, "gitDirty", JSON_NULL);',
     'if (bytes(g.gitDirty).length == 0) vm.serializeBool(root, "gitDirty", false);', "FinalizeTest"),
    ("MB-B20", "finalize: the plan's commit is not compared", "script/WriteManifest.s.sol",
     'require(_same(pending.readString(".gitCommit"), g.gitCommit), "finalize: SH_GIT_COMMIT differs from the plan\'s");',
     "", "FinalizeTest"),
    # SH-E (ADR-0009 F10 addendum): the fixed 1e9 supply, the N rule, tokenURI, the deploy plan's manifest guards.
    ("MB-E1", "token: N that does not divide 1e27 accepted (e.g. 3,333)", "src/SquareHoleToken.sol",
     "if (n == 0 || n > MAX_COLLECTION_SIZE || FIXED_SUPPLY % n != 0) revert InvalidCollectionSize(n);",
     "if (n == 0 || n > MAX_COLLECTION_SIZE) revert InvalidCollectionSize(n);",
     "SquareHoleTokenTest|V4LaunchSystemTest"),
    ("MB-E2", "token: the r cross-check is ignored", "src/SquareHoleToken.sol",
     "        if (r != 0 && r != _wholeTokensPerNft(n)) revert InvalidFractionsPerNft(r);\n", "",
     "SquareHoleTokenTest|V4LaunchSystemTest"),
    ("MB-E3", "core: the F08 bound (1 … 1e9) instead of the fixed supply", "src/base/LaunchTokenCore.sol",
     "if (wholeSupply_ != FIXED_WHOLE_SUPPLY) revert InvalidSupply(wholeSupply_);",
     "if (wholeSupply_ == 0 || wholeSupply_ > FIXED_WHOLE_SUPPLY) revert InvalidSupply(wholeSupply_);",
     "SquareHoleFungibleTokenTest|V4LaunchSystemTest"),
    ("MB-E4", "token: tokenURI without the .json suffix", "src/SquareHoleToken.sol",
     'return string.concat(base, _toDecimalString(id), ".json");', "return string.concat(base, _toDecimalString(id));",
     "SquareHoleTokenTest"),
    ("MB-E5", "launcher: records the creator's r instead of the derived one", "src/SquareHoleLauncher.sol",
     "                    ? SquareHoleToken(payable(d.token)).fractionsPerNft()",
     "                    ? p.fractionsPerNft", "V4LaunchSystemTest|V4IntegrationTest"),
    ("MB-E6", "launcher: r = 0 not normalized (constructor args differ from the record)", "src/SquareHoleLauncher.sol",
     "        return FIXED_WHOLE_SUPPLY % units == 0 ? FIXED_WHOLE_SUPPLY / units : 0;", "        return 0;",
     "V4LaunchSystemTest"),
    ("MB-E7", "deploy: a manifest file that differs from the pinned hash is accepted", "script/Deploy.s.sol",
     "                l.manifestHash == bytes32(0) || l.manifestHash == h,", "                true,",
     "DeployScriptTest"),
    ("MB-E8", "deploy: a public-chain broadcast accepts the configured hash (file missing)", "script/Deploy.s.sol",
     "        require(\n            fromFile,\n", "        require(\n            true,\n", "DeployScriptTest"),
    ("MB-E9", "finalizer: a manifest source that differs from the on-chain commitment is recorded",
     "script/lib/DeploymentManifest.sol", "            manifestHash == p.metadataManifestHash,\n",
     "            true,\n", "FinalizeTest"),
]


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run_mutant(mid: str, desc: str, rel: str, old: str, new: str, tests: str) -> tuple[str, str, int]:
    path = ROOT / rel
    source = path.read_bytes()
    before = sha(path)
    text = source.decode()
    if text.count(old) != 1:
        raise SystemExit(f"{mid}: the original text occurs {text.count(old)} times in {rel} (must be exactly once)")
    try:
        path.write_text(text.replace(old, new))
        r = subprocess.run(["forge", "test", "--match-contract", tests], cwd=ROOT, capture_output=True, text=True)
        out = r.stdout + r.stderr
        # forge prints each failure twice (suite and summary): count distinct failing tests.
        failed = len({line.split("] ", 1)[-1].split(" (", 1)[0] for line in out.splitlines() if line.startswith("[FAIL")})
        how = "compile error" if "Compiler run failed" in out else f"{failed} failing"
        return ("killed" if r.returncode != 0 else "SURVIVED"), how, failed
    finally:
        path.write_bytes(source)
        assert sha(path) == before, f"{rel} not restored"


def main() -> int:
    wanted = set(sys.argv[1:])
    selected = [m for m in MUTANTS if not wanted or m[0] in wanted]
    killed = 0
    for mid, desc, rel, old, new, tests in selected:
        verdict, how, _ = run_mutant(mid, desc, rel, old, new, tests)
        killed += verdict == "killed"
        print(f"{mid:<7} {verdict:<9} {how:<14} {desc}  [{tests}]", flush=True)
    print(f"killed {killed} / {len(selected)}")
    return 0 if killed == len(selected) else 1


if __name__ == "__main__":
    sys.exit(main())
