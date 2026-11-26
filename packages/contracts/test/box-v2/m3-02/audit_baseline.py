"""M302-SIZE/BOX0: audit fresh release artifacts and unchanged seams against the assigned pin.

Run from the repository root, passing the dedicated production build output directory.
Read-only; never fetches, changes Git configuration, or compares against local main.
"""

import json
from pathlib import Path
import subprocess
import sys


PIN = "9bb537926098684cdf2fbab9978b9ea035eb0f85"
OWNED = "packages/contracts/test/box-v2/m3-02/"
EVIDENCE = "docs/evidence/SH-V2-M3-02.md"
PROTECTED = (
    "packages/contracts/src/box",
    "packages/contracts/src/v2",
    "packages/box-spec/src/layout.ts",
    "packages/box-spec/vectors/cases.v1.json",
    "packages/chain/src/abi",
    "square-hole-core-v2",
    "square-hole-handoff",
)
# C15.18's surviving seams also cross v2/off-chain code. Pin the entire relevant source trees,
# including the private deployment preflight; do not duplicate process-wide environment tests.
SEAMS = (
    "packages/contracts/script/DeployCoreV2.s.sol",
    "packages/contracts/script/sepolia-v2/CoreV2Deployment.sol",
    "packages/contracts/src/box-v2",
    "packages/burn-bot",
    "docs/ops/burn-bot.md",
)


def git(*args):
    return subprocess.check_output(["git", *args], text=True).strip()


def audit(artifacts):
    changed = git("diff", "--name-only", PIN).splitlines()
    assert all(p.startswith(OWNED) or p == EVIDENCE for p in changed), changed
    assert not git("diff", PIN, "--", *PROTECTED, *SEAMS), "protected seam changed"
    assert not git("remote"), "lane must have no remote"
    subprocess.run(["git", "diff", "--check", PIN], check=True)
    print("Ownership, five box-0 seams, handoffs and no-remotes: PASS")

    manifest = json.loads(Path("packages/contracts/size-budget.v2.json").read_text())
    assert manifest["limitBytes"] == 24576 and manifest["minReserveBytes"] == 2458
    gates = dict(manifest["gates"])
    for name, folder in (
        ("StarterSetLoaderV2", ""), ("ItemLedgerV2", ""), ("ReceiverViews", "libraries/")
    ):
        gates.setdefault(name, {
            "source": f"src/box-v2/{folder}{name}.sol", "m1GateBytes": 22118, "reserveBytes": 2458
        })
    for name, gate in sorted(gates.items()):
        assert gate["m1GateBytes"] == 22118 and gate["reserveBytes"] == 2458
        artifact = artifacts / Path(gate["source"]).name / f"{name}.json"
        data = json.loads(artifact.read_text())
        metadata = data["metadata"]
        if isinstance(metadata, str):
            metadata = json.loads(metadata)
        settings = metadata["settings"]
        assert metadata["compiler"]["version"].startswith("0.8.26+"), name
        assert settings["compilationTarget"] == {gate["source"]: name}, name
        assert settings["optimizer"] == {"enabled": True, "runs": 1000}, name
        assert settings["evmVersion"] == "cancun" and not settings.get("viaIR", False), name
        assert settings["metadata"]["bytecodeHash"] == "none", name
        runtime = bytes.fromhex(data["deployedBytecode"]["object"].removeprefix("0x"))
        assert 0 < len(runtime) <= 22118, (name, len(runtime))
        print(f"{name}: {len(runtime)} B; room {22118 - len(runtime)} B; EIP-170 reserve >=2458 B")
    print(f"{len(gates)} exact production artifacts: PASS")


if __name__ == "__main__":
    audit(Path(sys.argv[1]))
