"""SH-V2-M1-62b: a mutation kill must be a real, previously passing test failure."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

CONTRACTS = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location("mutation_v2", CONTRACTS / "script-py/mutation_v2.py")
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)


def report(status="Success", name="test_money()"):
    return json.dumps({"test/box-v2/m1-62/MoneyMutation.t.sol:Money": {
        "test_results": {name: {"status": status, "reason": "assertion failed"}}
    }})


class CQ11MutationTest(unittest.TestCase):
    def test_manifest_covers_all_eight_required_areas_with_real_sources(self):
        config = M.cq11_manifest(CONTRACTS, M.MANIFEST)
        self.assertEqual({m["area"] for m in config["mutants"]}, {
            "sale-fee", "default-override", "split", "claim", "hatch", "late-money", "raise", "step"
        })
        for row in config["mutants"]:
            with self.subTest(mutant=row["id"]):
                source = (CONTRACTS / row["file"]).read_bytes()
                self.assertNotEqual(M.cq11_plant(source, row), source)

    def test_exact_unique_anchor_and_hash_required(self):
        source = b"fee = amount / 100;\n"
        row = {"before": "amount / 100", "after": "amount / 99", "sha256": M.hashlib.sha256(source).hexdigest()}
        self.assertEqual(M.cq11_plant(source, row), b"fee = amount / 99;\n")
        for bad in (dict(row, sha256="0" * 64), dict(row, before="missing"), dict(row, after=row["before"])):
            with self.assertRaises(M.ManifestError):
                M.cq11_plant(source, bad)
        doubled = source + source
        with self.assertRaises(M.ManifestError):
            M.cq11_plant(doubled, dict(row, sha256=M.hashlib.sha256(doubled).hexdigest()))

    def test_success_and_failure_have_matching_test_identity(self):
        baseline = M.cq11_tests(0, report())
        self.assertEqual(M.cq11_verdict(0, report(), baseline)[0], "survived")
        status, killed_by = M.cq11_verdict(1, report("Failure"), baseline)
        self.assertEqual(status, "killed")
        self.assertEqual(killed_by, list(baseline))

    def test_compile_error_empty_output_timeout_skip_or_missing_test_never_kills(self):
        baseline = M.cq11_tests(0, report())
        for code, output in ((1, "Compiler run failed"), (1, "[FAIL] misleading text"),
                             (0, "{}"), (None, report("Failure")), (1, report("Skipped")),
                             (1, report("Failure", "setUp()")), (1, report("Failure", "test_other()")),
                             (0, report("Failure")), (1, report())):
            with self.subTest(code=code, output=output):
                self.assertEqual(M.cq11_verdict(code, output, baseline)[0], "error")

    def test_red_baseline_is_refused(self):
        for code, output in ((1, report("Failure")), (0, "{}"), (0, report("Skipped"))):
            with self.assertRaises(M.ForgeError):
                M.cq11_tests(code, output)

    def test_cli_rebuilds_artifacts_isolates_sources_and_never_fakes_a_kill(self):
        # Keep all scratch evidence. The lane never deletes files, including on failed runs.
        scratch = CONTRACTS.parents[1] / ".cache/m1-62b/runner-tests"
        scratch.mkdir(parents=True, exist_ok=True)
        for outcome, expected in (("kill", 0), ("survive", 1), ("compile", 3),
                                  ("baseline", 3), ("empty", 1), ("skip", 1), ("timeout", 1)):
            with self.subTest(outcome=outcome):
                root = Path(tempfile.mkdtemp(prefix=outcome + "-", dir=scratch))
                source = root / "src/box-v2/Money.sol"
                source.parent.mkdir(parents=True)
                source.write_text("original")
                test = root / "test/box-v2/m1-62/MoneyMutation.t.sol"
                test.parent.mkdir(parents=True)
                test.write_text("independent test")
                (root / "lib").mkdir()
                (root / "foundry.toml").write_text("")
                (root / "size-budget.v2.json").write_text("{}")
                forge = root / "forge-fixture"
                forge.write_text(f"#!{sys.executable}\n" + '''
import json, os, pathlib, sys, time
args = sys.argv[1:]
if args == ["--version"]:
    print("forge Version: 1.8.3")
    sys.exit(0)
assert "--offline" in args
assert os.environ["FOUNDRY_FFI"] == "false"
assert os.environ["FOUNDRY_FUZZ_RUNS"] == "256"
source = pathlib.Path("src/box-v2/Money.sol").read_text()
outcome = ''' + repr(outcome) + '''
artifact = pathlib.Path("artifact")
if args[0] == "build":
    if source != "original" and outcome == "compile":
        sys.exit(1)
    artifact.write_text(source)
    sys.exit(0)
assert artifact.read_text() == source, "stale deployCode artifact"
if source != "original" and outcome == "timeout":
    time.sleep(3)
if source != "original" and outcome == "empty":
    print("{}")
    sys.exit(0)
status = "Success"
if outcome == "baseline" or (source != "original" and outcome == "kill"):
    status = "Failure"
if source != "original" and outcome == "skip":
    status = "Skipped"
print(json.dumps({"Money": {"test_results": {"test_money()": {"status": status}}}}))
sys.exit(1 if status == "Failure" else 0)
''')
                forge.chmod(0o755)
                row = dict(id="money", area="claim", file="src/box-v2/Money.sol",
                           sha256=M.hashlib.sha256(source.read_bytes()).hexdigest(),
                           before="original", after="mutant", testFile="test/box-v2/m1-62/MoneyMutation.t.sol",
                           contract="Money", requirement="C15.14")
                manifest = root / "manifest.json"
                manifest.write_text(json.dumps({"cq11": {"forge": "1.8.3", "mutants": [row]}}))
                cmd = [sys.executable, str(M.MANIFEST.with_suffix(".py")), "--cq11", "--root", str(root),
                       "--manifest", str(manifest), "--forge", str(forge), "--scratch", str(root / "runs"),
                       "--timeout", "1" if outcome == "timeout" else "20"]
                run = subprocess.run(cmd, text=True, capture_output=True, env=dict(os.environ), timeout=30)
                self.assertEqual(run.returncode, expected, run.stdout + run.stderr)
                self.assertEqual(source.read_text(), "original")
                workspace = next((root / "runs").glob("cq11-*/workspace"))
                self.assertEqual((workspace / row["file"]).read_text(), "original")
                evidence = json.loads((workspace.parent / "report.json").read_text())
                self.assertEqual(evidence["exitCode"], expected)
                self.assertEqual(evidence["evms"], ["default", "amsterdam"])
                if outcome == "kill":
                    self.assertEqual([r["verdict"] for r in evidence["results"][0]["runs"]], ["killed", "killed"])


if __name__ == "__main__":
    unittest.main()
