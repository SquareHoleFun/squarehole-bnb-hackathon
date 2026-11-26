"""M1-62: further tests of script-py/mutation_v2.py, added after the red commit (manifest refusals, forge's report
with other lines and with its own path keys, the real manifest's listing, --changed-since through git, a broken
report as exit 3).

Run (from the repository root):
    python3 -m unittest discover -s packages/contracts/test/box-v2/m1-62 -p 'test_*.py'
"""
from __future__ import annotations

import sys

sys.dont_write_bytecode = True

import importlib.util  # noqa: E402
import json  # noqa: E402
import os  # noqa: E402
import subprocess  # noqa: E402
import tempfile  # noqa: E402
import unittest  # noqa: E402
from pathlib import Path  # noqa: E402

HERE = Path(__file__).resolve().parent
CONTRACTS = HERE.parents[2]
SCRIPT = CONTRACTS / "script-py" / "mutation_v2.py"
MANIFEST = CONTRACTS / "script-py" / "mutation_v2.json"


def load(path: Path = SCRIPT, name: str = "mutation_v2"):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def git(root: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(root), "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", *args],
                   check=True, capture_output=True)


class MoreTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.m = load()

    def test_real_manifest_loads_and_lists(self) -> None:
        manifest = self.m.load_manifest(MANIFEST)
        r = subprocess.run([sys.executable, str(SCRIPT), "--list"], capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)
        for ticket, entry in manifest["tickets"].items():
            self.assertIn(ticket, r.stdout)
            for f in entry["files"]:
                self.assertIn(f["path"], r.stdout)

    def test_manifest_refusals(self) -> None:
        good = {"tickets": {"M1-42": {"tests": ["test/box-v2/hostile/**"], "files": [{"path": "src/a.sol"}]}},
                "equivalents": []}
        bad_tests = json.loads(json.dumps(good))
        bad_tests["tickets"]["M1-42"]["tests"] = ["test/box-v2/hostile/X.t.sol"]
        bad_file = json.loads(json.dumps(good))
        bad_file["tickets"]["M1-42"]["files"] = [{"path": "test/a.sol"}]
        unargued = dict(good, equivalents=[{"ticket": "M1-42", "file": "src/a.sol", "line": "x", "original": "a",
                                            "mutant": "b", "evidence": "docs/evidence/SH-V2-M1-42.md"}])
        with tempfile.TemporaryDirectory() as d:
            for case in (good, bad_tests, bad_file, unargued):
                p = Path(d, "m.json")
                p.write_text(json.dumps(case))
                if case is good:
                    self.m.load_manifest(p)
                    continue
                with self.assertRaises(self.m.ManifestError):
                    self.m.load_manifest(p)
            Path(d, "m.json").write_text("{")
            with self.assertRaises(self.m.ManifestError):
                self.m.load_manifest(Path(d, "m.json"))

    def test_report_after_other_lines(self) -> None:
        s = {"total": 1, "killed": 1, "survived": 0, "invalid": 0, "skipped": 0, "timed_out": 0}  # whole (round 2)
        text = "Compiling 3 files\n" + json.dumps({"summary": s, "survived_mutants": {}})
        self.assertEqual(self.m.parse_forge_json(text)["summary"]["killed"], 1)

    def test_exit_code_order(self) -> None:
        ok = {"state": "built", "summary": {"timed_out": 0}, "alive": [], "error": None}
        alive = dict(ok, alive=[{"line": 1}])
        stub = dict(ok, state="stub", summary=None)
        self.assertEqual(self.m.exit_code([alive, stub]), 1)
        self.assertEqual(self.m.exit_code([alive, stub, dict(ok, error="x")]), 3)

    def test_changed_since(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            repo = Path(d)
            root = repo / "packages/contracts"
            (root / "src/box-v2/libraries").mkdir(parents=True)
            (root / "src/box-v2/libraries/A.sol").write_text("pragma solidity 0.8.26;\n")
            m = {"tickets": {"M1-42": {"tests": ["test/box-v2/hostile/**"],
                                       "files": [{"path": "src/box-v2/libraries/A.sol"}]}},
                 "equivalents": []}
            (root / "m.json").write_text(json.dumps(m))
            git(repo, "init", "-q")
            git(repo, "add", ".")
            git(repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "base")
            cli = [sys.executable, str(SCRIPT), "--root", str(root), "--manifest", str(root / "m.json"),
                   "--changed-since", "HEAD", "--forge", "false"]
            r = subprocess.run(cli, capture_output=True, text=True, timeout=60)
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
            self.assertIn("no ticket's sources or test folders changed", r.stdout)
            r = subprocess.run(cli[:-3] + ["no-such-rev", "--forge", "false"], capture_output=True, text=True,
                               timeout=60)
            self.assertEqual(r.returncode, 2, r.stdout + r.stderr)


class ForgeKeysTest(unittest.TestCase):
    """The dry run on FailureTableV2.sol: forge keyed its survivors `contracts/src/...` from packages/contracts."""

    def setUp(self) -> None:
        self.base = load(HERE / "test_mutation_v2_runner.py", "m162_runner_tests")
        self.dir = tempfile.TemporaryDirectory()
        self.root = Path(self.dir.name)
        (self.root / "src/box-v2/libraries").mkdir(parents=True)
        (self.root / "src/box-v2/libraries/A.sol").write_text(self.base.BUILT)
        self.forge = self.root / "fake-forge"
        self.forge.write_text(self.base.FAKE_FORGE)
        self.forge.chmod(0o755)

    def tearDown(self) -> None:
        self.dir.cleanup()

    def run_cli(self, equivalents: list, out: str) -> subprocess.CompletedProcess:
        m = {"tickets": {"M1-42": {"tests": ["test/box-v2/hostile/**"],
                                   "files": [{"path": "src/box-v2/libraries/A.sol", "owner": "M1-42"}]}},
             "equivalents": equivalents}
        (self.root / "m.json").write_text(json.dumps(m))
        env = dict(os.environ, FAKE_LOG=str(self.root / "log"), FAKE_JSON=out)
        return subprocess.run([sys.executable, str(SCRIPT), "--root", str(self.root), "--manifest",
                               str(self.root / "m.json"), "--forge", str(self.forge), "--ticket", "M1-42", "--report",
                               str(self.root / "r.json")], capture_output=True, text=True, env=env, timeout=60)

    def test_survivor_under_forges_own_key(self) -> None:
        keyed = {"contracts/src/box-v2/libraries/A.sol": self.base.SURVIVOR["src/box-v2/libraries/A.sol"]}
        r = self.run_cli([], self.base.forge_json(keyed))
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn("src/box-v2/libraries/A.sol:4:13  x > 10 -> x >= 10  | if (x > 10) return 1;", r.stdout)
        (alive,) = json.loads((self.root / "r.json").read_text())["tickets"][0]["files"][0]["alive"]
        self.assertEqual(alive["forgeFile"], "contracts/src/box-v2/libraries/A.sol")
        eq = {"ticket": "M1-42", "file": "src/box-v2/libraries/A.sol", "line": "if (x > 10) return 1;",
              "original": "x > 10", "mutant": "x >= 10", "reason": "a reason of thirty characters!",
              "evidence": "docs/evidence/SH-V2-M1-42.md"}
        self.assertEqual(self.run_cli([eq], self.base.forge_json(keyed)).returncode, 0)

    def test_broken_survivor_is_exit_3(self) -> None:
        out = json.dumps({"summary": {"total": 1, "survived": 1}, "survived_mutants": {"x.sol": [{"line": 1}]}})
        r = self.run_cli([], out)
        self.assertEqual(r.returncode, 3, r.stdout + r.stderr)
        self.assertIn("survivor without line", r.stdout)


if __name__ == "__main__":
    unittest.main()
