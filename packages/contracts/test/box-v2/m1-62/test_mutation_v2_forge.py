"""M1-62: script-py/mutation_v2.py with the real forge, on a small Foundry project built in a temporary folder.

Opt-in (each run compiles mutants; about a minute on a busy machine):
    SH_MUTATION_E2E=1 python3 -m unittest discover -s packages/contracts/test/box-v2/m1-62 -p 'test_*.py'
The project links this package's forge-std; nothing here touches packages/contracts' own sources or build.
"""
from __future__ import annotations

import sys

sys.dont_write_bytecode = True

import hashlib  # noqa: E402
import json  # noqa: E402
import os  # noqa: E402
import shutil  # noqa: E402
import signal  # noqa: E402
import subprocess  # noqa: E402
import tempfile  # noqa: E402
import time  # noqa: E402
import unittest  # noqa: E402
from pathlib import Path  # noqa: E402

HERE = Path(__file__).resolve().parent
CONTRACTS = HERE.parents[2]
SCRIPT = CONTRACTS / "script-py" / "mutation_v2.py"
MANIFEST = CONTRACTS / "script-py" / "mutation_v2.json"
FORGE_STD = CONTRACTS / "lib" / "forge-std"
FORGE = shutil.which("forge")
ENABLED = os.environ.get("SH_MUTATION_E2E") == "1"

FOUNDRY_TOML = """[profile.default]
src = "src"
test = "test"
out = "out"
libs = ["lib"]
solc = "0.8.26"
auto_detect_solc = false
remappings = ["forge-std/=lib/forge-std/src/"]
"""

# One boundary is untested on purpose: `amount > CAP` -> `amount >= CAP` survives (no test at exactly CAP).
LIBRARY = """// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

library SplitFixture {
    uint256 internal constant CAP = 1_000_000;

    error OverCap(uint256 amount);

    function split(uint256 amount) internal pure returns (uint256 fit, uint256 rest) {
        if (amount > CAP) revert OverCap(amount);
        fit = amount * 3 / 15;
        rest = amount - fit;
    }
}
"""

TESTS = """// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {SplitFixture} from "../../../src/box-v2/libraries/SplitFixture.sol";

contract SplitFixtureHarness {
    function split(uint256 amount) external pure returns (uint256, uint256) {
        return SplitFixture.split(amount);
    }
}

contract SplitFixtureTest is Test {
    SplitFixtureHarness internal h = new SplitFixtureHarness();

    function test_split() public view {
        (uint256 fit, uint256 rest) = h.split(100);
        assertEq(fit, %FIT%);
        assertEq(rest, 80);
    }

    function test_overCap() public {
        vm.expectRevert(abi.encodeWithSelector(SplitFixture.OverCap.selector, 1_000_001));
        h.split(1_000_001);
    }
}
"""

# Review round 2: round 1's dry run on VaultFailure.sol in small. Its three survivors are equivalent (a length is never
# below 0; `i` steps by 1 from 0 to the length; the increment's value is unused); with one job forge skips their
# siblings [V probe: 5 skipped], which the runner then runs itself and the tests kill.
LOOP_LIBRARY = """// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

library LoopFixture {
    error Empty();

    function sum(uint256[] memory ids) internal pure returns (uint256 t) {
        if (ids.length == 0) revert Empty();
        for (uint256 i = 0; i < ids.length; ++i) {
            t += ids[i];
        }
    }
}
"""

LOOP_TESTS = """// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {LoopFixture} from "../../../src/box-v2/libraries/LoopFixture.sol";

contract LoopFixtureHarness {
    function sum(uint256[] memory ids) external pure returns (uint256) {
        return LoopFixture.sum(ids);
    }
}

contract LoopFixtureTest is Test {
    LoopFixtureHarness internal h = new LoopFixtureHarness();

    function test_sum() public view {
        uint256[] memory a = new uint256[](3);
        a[0] = 3;
        a[1] = 5;
        a[2] = 6;
        assertEq(h.sum(a), 14);
    }

    function test_one() public view {
        uint256[] memory a = new uint256[](1);
        a[0] = 5;
        assertEq(h.sum(a), 5);
    }

    function test_empty() public {
        vm.expectRevert(LoopFixture.Empty.selector);
        h.sum(new uint256[](0));
    }
}
"""

LOOP = "src/box-v2/libraries/LoopFixture.sol"
LOOP_ROWS = [("if (ids.length == 0) revert Empty();", "ids.length == 0", "ids.length <= 0"),
             ("for (uint256 i = 0; i < ids.length; ++i) {", "i < ids.length", "i != ids.length"),
             ("for (uint256 i = 0; i < ids.length; ++i) {", "++i", "i++")]

SURVIVOR = {"file": "src/box-v2/libraries/SplitFixture.sol", "line": 10, "original": "amount > CAP",
            "mutant": "amount >= CAP"}
EQUIVALENT = {"ticket": "M1-99", "file": SURVIVOR["file"], "line": "if (amount > CAP) revert OverCap(amount);",
              "original": "amount > CAP", "mutant": "amount >= CAP",
              "reason": "fixture only: argued here so the run turns green", "evidence": "docs/evidence/SH-V2-M1-62.md"}


def tree_hash(root: Path) -> str:
    h = hashlib.sha256()
    for p in sorted((root / "src").rglob("*")) + sorted((root / "test").rglob("*")):
        if p.is_file():
            h.update(str(p.relative_to(root)).encode() + b"\0" + p.read_bytes())
    return h.hexdigest()


def make_project(root: Path, fit: str = "20", equivalents: list | None = None, loop: bool = False) -> None:
    (root / "src/box-v2/libraries").mkdir(parents=True)
    (root / "test/box-v2/m1-99").mkdir(parents=True)
    (root / "lib").mkdir()
    (root / "lib/forge-std").symlink_to(FORGE_STD)
    (root / "foundry.toml").write_text(FOUNDRY_TOML)
    if loop:
        (root / LOOP).write_text(LOOP_LIBRARY)
        (root / "test/box-v2/m1-99/LoopFixture.t.sol").write_text(LOOP_TESTS)
    else:
        (root / "src/box-v2/libraries/SplitFixture.sol").write_text(LIBRARY)
        (root / "test/box-v2/m1-99/SplitFixture.t.sol").write_text(TESTS.replace("%FIT%", fit))
    # Review round 2, finding 1: the manifest's forge pin, checked against `forge --version` before any run.
    manifest = {"forge": json.loads(MANIFEST.read_text())["forge"], "excludeTests": "**/*Fork*.t.sol",
                "tickets": {"M1-99": {"tests": ["test/box-v2/m1-99/**"],
                                      "files": [{"path": LOOP if loop else SURVIVOR["file"], "owner": "M1-99"}]}},
                "moneyPaths": {}, "notInRun": [], "equivalents": equivalents or []}
    (root / "m.json").write_text(json.dumps(manifest))


def command(root: Path, jobs: str = "2") -> list[str]:
    assert FORGE is not None
    return [sys.executable, str(SCRIPT), "--root", str(root), "--manifest", str(root / "m.json"), "--forge", FORGE,
            "--ticket", "M1-99", "--jobs", jobs, "--report", str(root / "report.json")]


@unittest.skipUnless(ENABLED and FORGE and FORGE_STD.joinpath("src/Test.sol").exists(),
                     "set SH_MUTATION_E2E=1 (needs forge and the forge-std submodule)")
class ForgeRunTest(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = tempfile.TemporaryDirectory()
        self.root = Path(self.dir.name)

    def tearDown(self) -> None:
        self.dir.cleanup()

    def test_survivor_found_then_argued(self) -> None:
        make_project(self.root)
        before = tree_hash(self.root)
        r = subprocess.run(command(self.root), capture_output=True, text=True, timeout=900)
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        report = json.loads((self.root / "report.json").read_text())
        (entry,) = report["tickets"][0]["files"]
        self.assertEqual([{k: a[k] for k in SURVIVOR} for a in entry["alive"]], [SURVIVOR])
        self.assertGreater(entry["summary"]["killed"], 20)
        self.assertEqual(tree_hash(self.root), before, "sources and tests untouched")
        manifest = json.loads((self.root / "m.json").read_text())
        manifest["equivalents"] = [EQUIVALENT]
        (self.root / "m.json").write_text(json.dumps(manifest))
        r = subprocess.run(command(self.root), capture_output=True, text=True, timeout=900)
        self.assertIn("equivalent", r.stdout)
        # Review round 2, finding 2: forge skips the span's other mutants once one survives (how many depends on its
        # scheduling); the runner runs each one itself and the tests kill them, so the argued row is green.
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        (entry,) = json.loads((self.root / "report.json").read_text())["tickets"][0]["files"]
        self.assertEqual(len(entry["planted"]), entry["summary"]["skipped"])
        self.assertEqual(tree_hash(self.root), before, "sources and tests untouched")
        manifest["equivalents"] = [dict(EQUIVALENT, span="all")]
        (self.root / "m.json").write_text(json.dumps(manifest))
        r = subprocess.run(command(self.root), capture_output=True, text=True, timeout=900)
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)  # round 2: `span: all` is retired

    def test_skipped_siblings_of_argued_rows_are_run(self) -> None:
        rows = [{"ticket": "M1-99", "file": LOOP, "line": line, "original": o, "mutant": mu,
                 "reason": "fixture only: argued equivalent as in VaultFailure.sol",
                 "evidence": "docs/evidence/SH-V2-M1-62.md"} for line, o, mu in LOOP_ROWS]
        make_project(self.root, equivalents=rows, loop=True)
        before = tree_hash(self.root)
        r = subprocess.run(command(self.root, jobs="1"), capture_output=True, text=True, timeout=900)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        (entry,) = json.loads((self.root / "report.json").read_text())["tickets"][0]["files"]
        self.assertEqual(len(entry["equivalent"]), 3)
        self.assertGreater(entry["summary"]["skipped"], 0, "one job: forge skips behind the argued survivors")
        self.assertEqual(len(entry["planted"]), entry["summary"]["skipped"])
        self.assertEqual({p["result"] for p in entry["planted"]} - {"killed", "invalid"}, set(), entry["planted"])
        self.assertEqual(tree_hash(self.root), before, "sources and tests untouched")

    def test_failing_baseline_is_an_error(self) -> None:
        make_project(self.root, fit="21")
        r = subprocess.run(command(self.root), capture_output=True, text=True, timeout=900)
        self.assertEqual(r.returncode, 3, r.stdout + r.stderr)

    def test_multiline_condition_keeps_skipped_siblings_runnable(self) -> None:
        # R4 M1: forge flattens originals while spans retain newlines; all range mutants die.
        rows = [{"ticket": "M1-99", "file": LOOP, "line": line, "original": o, "mutant": mu,
                 "reason": "fixture only: argued equivalent as in VaultFailure.sol",
                 "evidence": "docs/evidence/SH-V2-M1-62.md"} for line, o, mu in LOOP_ROWS]
        make_project(self.root, equivalents=rows, loop=True)
        (self.root / LOOP).write_text(LOOP_LIBRARY.replace("library LoopFixture {", """library LoopFixture {
    function within(uint256 a, uint256 lo, uint256 hi) internal pure returns (bool) {
        return a >= lo
            && a <= hi;
    }
"""))
        tests = self.root / "test/box-v2/m1-99/LoopFixture.t.sol"
        tests.write_text(LOOP_TESTS.replace("contract LoopFixtureTest is Test {", """contract LoopFixtureTest is Test {
    function test_range() public pure {
        assertFalse(LoopFixture.within(1, 2, 4));
        assertTrue(LoopFixture.within(2, 2, 4));
        assertTrue(LoopFixture.within(3, 2, 4));
        assertTrue(LoopFixture.within(4, 2, 4));
        assertFalse(LoopFixture.within(5, 2, 4));
        assertFalse(LoopFixture.within(3, 4, 2));
    }
"""))
        before = tree_hash(self.root)
        r = subprocess.run(command(self.root, jobs="1"), capture_output=True, text=True, timeout=900)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        (entry,) = json.loads((self.root / "report.json").read_text())["tickets"][0]["files"]
        self.assertEqual(len(entry["equivalent"]), 3)
        self.assertGreater(entry["summary"]["skipped"], 0)
        self.assertEqual(len(entry["planted"]), entry["summary"]["skipped"])
        self.assertEqual(entry["alive"], [])
        self.assertEqual(entry["notGreen"], [])
        self.assertEqual(tree_hash(self.root), before, "sources and tests untouched")

    def test_sigterm_stops_forge_and_keeps_sources(self) -> None:
        make_project(self.root)
        before = tree_hash(self.root)
        p = subprocess.Popen(command(self.root), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        child = None
        for _ in range(600):
            found = subprocess.run(["pgrep", "-P", str(p.pid)], capture_output=True, text=True).stdout.split()
            if found:
                child = int(found[0])
                break
            time.sleep(0.05)
        self.assertIsNotNone(child, "forge started")
        time.sleep(1.0)
        p.send_signal(signal.SIGTERM)
        out, err = p.communicate(timeout=60)
        self.assertEqual(p.returncode, 143, out + err)
        time.sleep(0.5)
        assert child is not None
        with self.assertRaises(ProcessLookupError):
            os.kill(child, 0)
        self.assertEqual(tree_hash(self.root), before)
        report = json.loads((self.root / "report.json").read_text())
        self.assertEqual(report["exitCode"], 143)


if __name__ == "__main__":
    unittest.main()
