"""M1-62: script-py/mutation_v2.py without forge: its parts, and its command line against a fake forge.

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
import textwrap  # noqa: E402
import unittest  # noqa: E402
from pathlib import Path  # noqa: E402

HERE = Path(__file__).resolve().parent
CONTRACTS = HERE.parents[2]
SCRIPT = CONTRACTS / "script-py" / "mutation_v2.py"

BUILT = "pragma solidity 0.8.26;\nlibrary A {\n    function f(uint256 x) internal pure returns (uint256) {\n" \
        "        if (x > 10) return 1;\n        return x - 1;\n    }\n}\n"
STUB = "pragma solidity 0.8.26;\nlibrary B {\n    error NotBuilt();\n    function g() internal pure {\n" \
       "        revert NotBuilt();\n    }\n}\n"

# A fake forge: prints FAKE_JSON (or FAKE_ERR), exits FAKE_EXIT, logs argv and two env values, may edit a file.
FAKE_FORGE = textwrap.dedent('''\
    #!/usr/bin/env python3
    import json, os, sys
    with open(os.environ["FAKE_LOG"], "a") as log:
        log.write(json.dumps({"argv": sys.argv[1:], "fuzz": os.environ.get("FOUNDRY_FUZZ_RUNS"),
                              "tmp": os.environ.get("TMPDIR"), "cwd": os.getcwd()}) + "\\n")
    if os.environ.get("FAKE_TOUCH"):
        with open(os.environ["FAKE_TOUCH"], "a") as f:
            f.write("// touched\\n")
    sys.stdout.write(os.environ.get("FAKE_JSON", ""))
    sys.stderr.write(os.environ.get("FAKE_ERR", ""))
    sys.exit(int(os.environ.get("FAKE_EXIT", "0")))
''')


def load():
    spec = importlib.util.spec_from_file_location("mutation_v2", SCRIPT)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def summary(**over) -> dict:
    # Review round 2, finding 1: forge's counts add up to its total, so the total follows the parts unless given.
    s = {"killed": 8, "survived": 0, "invalid": 2, "skipped": 0, "timed_out": 0}
    s.update(over)
    s.setdefault("total", sum(s[k] for k in ("killed", "survived", "invalid", "skipped", "timed_out")))
    return s


def forge_json(survivors: dict | None = None, **over) -> str:
    survivors = survivors or {}
    n = sum(len(v) for v in survivors.values())
    return json.dumps({"summary": summary(survived=n, **over), "survived_mutants": survivors})


SURVIVOR = {"src/box-v2/libraries/A.sol": [{"line": 4, "column": 13, "original": "x > 10", "mutant": "x >= 10"}]}


class PartsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.m = load()

    def test_file_state(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            Path(d, "a.sol").write_text(BUILT)
            Path(d, "b.sol").write_text(STUB)
            self.assertEqual(self.m.file_state(Path(d, "a.sol")), "built")
            self.assertEqual(self.m.file_state(Path(d, "b.sol")), "stub")
            self.assertEqual(self.m.file_state(Path(d, "c.sol")), "missing")

    def test_match_glob(self) -> None:
        self.assertEqual(self.m.match_glob(["test/box-v2/m1-42/**"]), "test/box-v2/m1-42/**")
        self.assertEqual(self.m.match_glob(["test/box-v2/m1-44/**", "test/box-v2/hostile/**"]),
                         "{test/box-v2/m1-44/**,test/box-v2/hostile/**}")

    def test_forge_command(self) -> None:
        cmd = self.m.forge_command("forge", "src/box-v2/libraries/A.sol", "test/box-v2/m1-42/**",
                                   "**/*Fork*.t.sol", jobs=4, timeout=600)
        self.assertEqual(cmd, ["forge", "test", "--mutate", "src/box-v2/libraries/A.sol", "--match-path",
                               "test/box-v2/m1-42/**", "--no-match-path", "**/*Fork*.t.sol", "--json",
                               "--mutation-jobs", "4", "--mutation-timeout", "600"])
        self.assertFalse({"--fork-url", "--ffi", "--broadcast"} & set(cmd))

    def test_parse_forge_json(self) -> None:
        r = self.m.parse_forge_json(forge_json(SURVIVOR))
        self.assertEqual(r["summary"]["survived"], 1)
        self.assertEqual(r["survivors"], [{"file": "src/box-v2/libraries/A.sol", "line": 4, "column": 13,
                                           "original": "x > 10", "mutant": "x >= 10"}])
        for bad in ("", "not json", json.dumps({"survived_mutants": {}})):
            with self.assertRaises(self.m.ForgeError):
                self.m.parse_forge_json(bad)

    def test_classify(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / "src/box-v2/libraries").mkdir(parents=True)
            (root / "src/box-v2/libraries/A.sol").write_text(BUILT)
            survivors = self.m.parse_forge_json(forge_json(SURVIVOR))["survivors"]
            eq = {"ticket": "M1-42", "file": "src/box-v2/libraries/A.sol", "line": "if (x > 10) return 1;",
                  "original": "x > 10", "mutant": "x >= 10", "reason": "r" * 30, "evidence": "e"}
            other = dict(eq, original="x - 1", mutant="x + 1", line="return x - 1;")
            alive, argued, stale = self.m.classify(survivors, [eq, other], root)
            self.assertEqual((len(alive), len(argued), len(stale)), (0, 1, 1))
            self.assertEqual(argued[0]["reason"], "r" * 30)
            self.assertIs(stale[0], other)
            alive, argued, _ = self.m.classify(survivors, [dict(eq, line="if (x > 11) return 1;")], root)
            self.assertEqual((len(alive), len(argued)), (1, 0))
            self.assertEqual(alive[0]["text"], "if (x > 10) return 1;")

    def test_exit_code(self) -> None:
        ok = {"state": "built", "summary": summary(), "alive": [], "error": None}
        self.assertEqual(self.m.exit_code([ok]), 0)
        self.assertEqual(self.m.exit_code([ok, dict(ok, alive=[{"line": 1}])]), 1)
        self.assertEqual(self.m.exit_code([dict(ok, summary=summary(timed_out=1))]), 1)
        self.assertEqual(self.m.exit_code([ok, dict(ok, error="baseline failed")]), 3)
        self.assertEqual(self.m.exit_code([ok, dict(ok, state="stub", summary=None)]), 4)
        self.assertEqual(self.m.exit_code([dict(ok, state="stub", summary=None, skipped=True)]), 0)
        self.assertEqual(self.m.exit_code([]), 2)

    def test_tickets_for_changes(self) -> None:
        m = {"tickets": {"M1-42": {"tests": ["test/box-v2/hostile/**"],
                                   "files": [{"path": "src/box-v2/libraries/RuleCall.sol"}]},
                         "M1-44": {"tests": ["test/box-v2/m1-44/**"],
                                   "files": [{"path": "src/box-v2/libraries/RoyaltyBooking.sol"}]}}}
        f = self.m.tickets_for_changes
        self.assertEqual(f(m, ["packages/contracts/src/box-v2/libraries/RuleCall.sol"]), ["M1-42"])
        self.assertEqual(f(m, ["packages/contracts/test/box-v2/m1-44/M144Router.t.sol", "docs/x.md"]), ["M1-44"])
        self.assertEqual(f(m, ["docs/evidence/SH-V2-M1-42.md"]), [])
        self.assertEqual(f(m, ["packages/contracts/script-py/mutation_v2.json"]), ["M1-42", "M1-44"])


class CommandLineTest(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = tempfile.TemporaryDirectory()
        self.root = Path(self.dir.name)
        lib = self.root / "src/box-v2/libraries"
        lib.mkdir(parents=True)
        (lib / "A.sol").write_text(BUILT)
        (lib / "B.sol").write_text(STUB)
        self.forge = self.root / "fake-forge"
        self.forge.write_text(FAKE_FORGE)
        self.forge.chmod(0o755)
        self.log = self.root / "forge.log"
        self.write_manifest([])

    def tearDown(self) -> None:
        self.dir.cleanup()

    def write_manifest(self, equivalents: list, files: tuple = ("A.sol",)) -> None:
        m = {"excludeTests": "**/*Fork*.t.sol",
             "tickets": {"M1-42": {"tests": ["test/box-v2/hostile/**"],
                                   "files": [{"path": f"src/box-v2/libraries/{n}", "owner": "M1-42"} for n in files]}},
             "moneyPaths": {}, "notInRun": [], "equivalents": equivalents}
        (self.root / "m.json").write_text(json.dumps(m))

    def run_cli(self, *args: str, **env: str) -> subprocess.CompletedProcess:
        full = dict(os.environ, FAKE_LOG=str(self.log), **env)
        return subprocess.run([sys.executable, str(SCRIPT), "--root", str(self.root), "--manifest",
                               str(self.root / "m.json"), "--forge", str(self.forge), *args],
                              capture_output=True, text=True, env=full, timeout=60)

    def calls(self) -> list[dict]:
        return [json.loads(x) for x in self.log.read_text().splitlines()] if self.log.exists() else []

    def test_green(self) -> None:
        r = self.run_cli("--ticket", "M1-42", "--report", str(self.root / "r.json"), FAKE_JSON=forge_json())
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        (call,) = self.calls()
        self.assertEqual(call["argv"][:4], ["test", "--mutate", "src/box-v2/libraries/A.sol", "--match-path"])
        self.assertEqual(call["argv"][4], "test/box-v2/hostile/**")
        self.assertEqual(Path(call["cwd"]).resolve(), self.root.resolve())
        self.assertNotEqual(call["tmp"], os.environ.get("TMPDIR"))
        self.assertFalse(Path(call["tmp"]).exists(), "the run's temp folder is removed")
        report = json.loads((self.root / "r.json").read_text())
        self.assertEqual(report["exitCode"], 0)
        self.assertEqual(report["tickets"][0]["files"][0]["summary"]["killed"], 8)

    def test_survivor_is_red(self) -> None:
        r = self.run_cli("--ticket", "M1-42", FAKE_JSON=forge_json(SURVIVOR))
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn("src/box-v2/libraries/A.sol:4", r.stdout)
        self.assertIn("x > 10 -> x >= 10", r.stdout)

    def test_argued_equivalent_is_green(self) -> None:
        self.write_manifest([{"ticket": "M1-42", "file": "src/box-v2/libraries/A.sol", "line": "if (x > 10) return 1;",
                              "original": "x > 10", "mutant": "x >= 10", "reason": "a reason of thirty characters!",
                              "evidence": "docs/evidence/SH-V2-M1-42.md"}])
        r = self.run_cli("--ticket", "M1-42", FAKE_JSON=forge_json(SURVIVOR))
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("equivalent", r.stdout)

    def test_timeout_is_red(self) -> None:
        r = self.run_cli("--ticket", "M1-42", FAKE_JSON=forge_json(timed_out=1))
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)

    def test_forge_failure(self) -> None:
        r = self.run_cli("--ticket", "M1-42", FAKE_EXIT="1", FAKE_ERR="Error: unmutated baseline run failed")
        self.assertEqual(r.returncode, 3, r.stdout + r.stderr)
        self.assertIn("baseline", r.stdout + r.stderr)

    def test_stub_is_not_built(self) -> None:
        self.write_manifest([], files=("A.sol", "B.sol", "C.sol"))
        r = self.run_cli("--ticket", "M1-42", FAKE_JSON=forge_json())
        self.assertEqual(r.returncode, 4, r.stdout + r.stderr)
        self.assertEqual(len(self.calls()), 1, "forge runs only on the built file")
        self.assertIn("B.sol: stub", r.stdout)
        self.assertIn("C.sol: missing", r.stdout)
        self.assertEqual(self.run_cli("--ticket", "M1-42", "--allow-pending", FAKE_JSON=forge_json()).returncode, 0)

    def test_unknown_ticket(self) -> None:
        r = self.run_cli("--ticket", "M1-99")
        self.assertEqual(r.returncode, 2)
        self.assertIn("unknown ticket M1-99", r.stderr)
        self.assertEqual(self.calls(), [])

    def test_scope_options_and_fuzz_runs(self) -> None:
        # Review round 2, low 1: --scope v2 fails on a v2 source in neither list, so this fixture's stub is placed.
        m = json.loads((self.root / "m.json").read_text())
        m["notInRun"] = [{"path": "src/box-v2/libraries/B.sol", "owner": "M1-42", "why": "this fixture's stub"}]
        (self.root / "m.json").write_text(json.dumps(m))
        r = self.run_cli("--ticket", "M1-42", "--scope", "v2", "--jobs", "2", "--timeout", "900", "--fuzz-runs", "64",
                         FAKE_JSON=forge_json())
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        (call,) = self.calls()
        argv = call["argv"]
        self.assertEqual(argv[argv.index("--match-path") + 1], "test/box-v2/**")
        self.assertEqual(argv[argv.index("--mutation-jobs") + 1], "2")
        self.assertEqual(argv[argv.index("--mutation-timeout") + 1], "900")
        self.assertEqual(call["fuzz"], "64")

    def test_single_file_mode(self) -> None:
        r = self.run_cli("--file", "src/box-v2/libraries/A.sol", "--tests", "test/box-v2/m1-00b/**",
                         FAKE_JSON=forge_json())
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        argv = self.calls()[0]["argv"]
        self.assertEqual(argv[argv.index("--match-path") + 1], "test/box-v2/m1-00b/**")

    def test_source_changed_fails_and_is_not_written_back(self) -> None:
        # Review round 1, low 3: forge never writes a source, so a change is someone else's; keep it, report hashes.
        a = self.root / "src/box-v2/libraries/A.sol"
        r = self.run_cli("--ticket", "M1-42", FAKE_JSON=forge_json(), FAKE_TOUCH=str(a))
        self.assertEqual(r.returncode, 3, r.stdout + r.stderr)
        self.assertEqual(a.read_text(), BUILT + "// touched\n")
        self.assertIn("not written back", r.stdout)
        self.assertIn("sha256", r.stdout)

    def test_list(self) -> None:
        self.write_manifest([], files=("A.sol", "B.sol"))
        r = self.run_cli("--list")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("M1-42", r.stdout)
        self.assertIn("A.sol  built", r.stdout)
        self.assertIn("B.sol  stub", r.stdout)
        self.assertEqual(self.calls(), [])


if __name__ == "__main__":
    unittest.main()
