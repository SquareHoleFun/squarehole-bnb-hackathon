"""M3-62: attributable production faults, exact test identities and per-item money checks."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import unittest

CONTRACTS = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location("mutation_v2", CONTRACTS / "script-py/mutation_v2.py")
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)
INHERITED_FILES = {
    "src/box-v2/BoxReceiverV2.sol", "src/box-v2/BoxReceiverV2Base.sol",
    "src/box-v2/BoxCoordinatorV2.sol", "src/box-v2/libraries/CoordinatorFailure.sol",
    "src/box-v2/libraries/CoordinatorViews.sol", "src/box-v2/BoxFactoryV2Planner.sol",
}


class M3CampaignTest(unittest.TestCase):
    def test_all_money_rules_and_inherited_faults_have_pinned_production_targets(self):
        manifest = json.loads(M.MANIFEST.read_text())
        self.assertIn("m3", manifest, "M3 money mutations are missing")
        rows = M.cq11_manifest(CONTRACTS, M.MANIFEST, "m3")["mutants"]
        self.assertTrue({"request-index", "count-split", "ownership", "stash", "seed-recipient",
                         "pile-denominator", "rounding", "failure-h", "journal"} <= {r["area"] for r in rows})
        expected = {r["id"] for r in manifest["m2"]["mutants"] if r["file"] in INHERITED_FILES}
        self.assertEqual({r["inherited"] for r in rows if "inherited" in r}, expected)
        for row in rows:
            original = (CONTRACTS / row["file"]).read_bytes()
            self.assertNotEqual(M.cq11_plant(original, row), original)
            self.assertTrue(row["testFile"].startswith("test/box-v2/m3-62/"))

    def test_cli_selects_m3_and_rejects_unknown_fault(self):
        command = [sys.executable, str(M.MANIFEST.with_suffix(".py")), "--m3", "--list"]
        result = subprocess.run(command, capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("request-index", result.stdout)
        bad = subprocess.run(command + ["--mutant", "no-such-fault"], capture_output=True, text=True, timeout=15)
        self.assertEqual(bad.returncode, 2)
        self.assertIn("unknown mutants", bad.stderr)

    def test_missing_individual_payout_assertion_is_not_a_kill(self):
        def report(status, name="test_eachItemsPayout()"):
            return json.dumps({"Money": {"test_results": {name: {"status": status}}}})
        baseline = M.cq11_tests(0, report("Success"))
        self.assertEqual(M.cq11_verdict(0, report("Success"), baseline)[0], "survived")
        self.assertEqual(M.cq11_verdict(1, report("Failure"), baseline)[0], "killed")
        for code, output in [(1, "Compiler run failed"), (None, ""), (0, "{}"),
                             (0, report("Skipped")), (1, report("Failure", "setUp()")),
                             (1, report("Failure", "test_totalOnly()"))]:
            self.assertEqual(M.cq11_verdict(code, output, baseline)[0], "error")


if __name__ == "__main__":
    unittest.main()
