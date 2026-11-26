"""M2-62: production faults must reach real, green money tests on both EVMs."""
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


class M2CampaignTest(unittest.TestCase):
    def test_campaign_covers_every_m2_money_owner_and_inherits_cq11(self):
        manifest = json.loads(M.MANIFEST.read_text())
        self.assertIn("m2", manifest, "M2 money mutations are missing")
        config = M.cq11_manifest(CONTRACTS, M.MANIFEST, "m2")
        rows = config["mutants"]
        self.assertTrue({"holder", "token-history", "hook-notice", "receiver-funding",
                         "shop", "starter", "failure-h", "year-sweep"} <= {r["area"] for r in rows})
        self.assertEqual({r["inherited"] for r in rows if "inherited" in r},
                         {r["id"] for r in manifest["cq11"]["mutants"]})
        for row in rows:
            self.assertTrue(row["testFile"].startswith("test/box-v2/m2-62/"))
            self.assertNotEqual(M.cq11_plant((CONTRACTS / row["file"]).read_bytes(), row),
                                (CONTRACTS / row["file"]).read_bytes())

    def test_cli_selects_m2_without_running_historical_engine(self):
        result = subprocess.run([sys.executable, str(M.MANIFEST.with_suffix(".py")), "--m2", "--list"],
                                capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("year-sweep", result.stdout)

    def test_survival_and_incomplete_results_cannot_be_called_kills(self):
        def report(status, name="test_money()"):
            return json.dumps({"Money": {"test_results": {name: {"status": status}}}})
        baseline = M.cq11_tests(0, report("Success"))
        self.assertEqual(M.cq11_verdict(0, report("Success"), baseline)[0], "survived")
        self.assertEqual(M.cq11_verdict(1, report("Failure"), baseline)[0], "killed")
        for code, output in [(1, "Compiler run failed"), (None, ""), (0, "{}"),
                             (0, report("Skipped")), (1, report("Failure", "setUp()")),
                             (1, report("Failure", "test_other()"))]:
            self.assertEqual(M.cq11_verdict(code, output, baseline)[0], "error")

    def test_explained_survival_stays_distinct_and_cannot_hide_execution_errors(self):
        output = json.dumps({"Money": {"test_results": {"test_money()": {"status": "Success"}}}})
        failed = output.replace("Success", "Failure")
        baseline = M.cq11_tests(0, output)
        reason = "The current public balance cap masks the redundant private counter change."
        self.assertEqual(M.cq11_verdict(0, output, baseline, reason), ("explained", [reason]))
        self.assertEqual(M.cq11_verdict(1, failed, baseline, reason)[0], "killed")
        for code, bad in [(1, "Compiler run failed"), (None, ""), (0, "{}"),
                          (0, output.replace("Success", "Skipped")),
                          (1, failed.replace("test_money()", "setUp()"))]:
            self.assertEqual(M.cq11_verdict(code, bad, baseline, reason)[0], "error")


if __name__ == "__main__":
    unittest.main()
