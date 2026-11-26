"""Regression: the existing package/root commands must compare models without FFI.

Only this ticket's Solidity files run; neither verify nor unrelated suites run.
Run explicitly with Python after selecting the project's Node/pnpm PATH.
"""
import os
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[5]
MATCH = "test/box-v2/m1-62/*Reference.t.sol"


class StandardEntryPoints(unittest.TestCase):
    def test_existing_commands_without_ffi_on_both_evms(self):
        env = dict(os.environ, FOUNDRY_FFI="false", FOUNDRY_FUZZ_RUNS="256", CQ11_LIVE_FFI="false")
        for entry in (["pnpm", "test:contracts"], ["pnpm", "--filter", "@squarehole/contracts", "test"]):
            for evm in ([], ["--hardfork", "amsterdam"]):
                with self.subTest(entry=entry, evm=evm):
                    command = [*entry, "--match-path", MATCH, *evm]
                    run = subprocess.run(command, cwd=ROOT, env=env, text=True, capture_output=True, timeout=300)
                    output = run.stdout + run.stderr
                    self.assertEqual(run.returncode, 0, output[-10000:])
                    self.assertIn("13 tests passed, 0 failed, 0 skipped", output)
                    self.assertNotIn("[SKIP", output)
                    self.assertEqual(output.count("runs: 256,"), 11, output[-10000:])


if __name__ == "__main__":
    unittest.main()
