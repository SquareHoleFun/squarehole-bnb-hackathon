"""Hand-calculated anchors for the independent CQ11 oracle (no Solidity imports)."""
import importlib.util
import copy
import json
from pathlib import Path
import sys
import unittest

MODEL = Path(__file__).resolve().parents[3] / "script-py/models/cq11.py"
spec = importlib.util.spec_from_file_location("cq11", MODEL)
cq11 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cq11)
sys.path.insert(0, str(MODEL.parent))
import cq11_vectors as vectors


class ReferenceAnchors(unittest.TestCase):
    def test_sale_rounds_up_at_both_denominators(self):
        for amount, fee in ((0, 0), (1, 1), (99, 1), (100, 1), (101, 2)):
            self.assertEqual(cq11.evaluate("sale", [0, amount]), [fee, amount, amount - fee])
        for net, fee in ((0, 0), (1, 1), (98, 1), (99, 1), (100, 2)):
            self.assertEqual(cq11.evaluate("sale", [1, net]), [fee, net + fee, net])

    def test_side_carries_are_separate(self):
        self.assertEqual(cq11.evaluate("split", [14, 1, 1, 2]), [0, 0, 0, 0, 0, 0, 14, 1])
        self.assertEqual(cq11.evaluate("split", [31, 46, 1, 3]), [10, 5, 10, 20, 0, 30, 1, 1])

    def test_claim_last_gets_dust_and_large_product_is_exact(self):
        self.assertEqual(cq11.evaluate("claim", [101, 100, 33]), [33, 68, 67])
        self.assertEqual(cq11.evaluate("claim", [68, 67, 67]), [68, 0, 0])
        self.assertEqual(cq11.evaluate("claim", [2**200, 2**128, 2**127]), [2**199, 2**199, 2**127])

    def test_reserve_is_fees_principal_is_not(self):
        self.assertEqual(cq11.evaluate("failure", [1000, 31, 0, 0, 1, 2, 5]), [1019, 5, 2, 5])
        self.assertEqual(cq11.evaluate("failure", [1000, 31, 0, 0, 3, 2, 0]), [1004, 25, 2, 0])

    def test_hatch_is_inclusive_and_exclusive_with_graduation(self):
        self.assertEqual(cq11.evaluate("hatch", [10, 604809, 1, 0, 0]), [0, 604810])
        self.assertEqual(cq11.evaluate("hatch", [10, 604810, 1, 0, 0]), [1, 604810])
        for flags in ([0, 0, 0], [1, 1, 0], [1, 0, 1]):
            self.assertEqual(cq11.evaluate("hatch", [10, 604810, *flags])[0], 0)

    def test_late_money_never_spends_an_unpaid_entitlement(self):
        self.assertEqual(cq11.evaluate("late", [120, 1, 0]), [0, 120])
        self.assertEqual(cq11.evaluate("late", [120, 0, 100]), [20, 100])
        self.assertEqual(cq11.evaluate("late", [20, 0, 0]), [20, 0])

    def test_raise_snapshots_and_ceiling(self):
        values = cq11.evaluate("raise", [4_206_980_085_000_000_000, 1_000_000])
        self.assertEqual(values, [4_206_980_085_000_000_000, 15 * 10**14, 5 * 10**15, 5 * 10**14, 5 * 10**15,
                                  1_000_000, 357, 1189, 119, 1189])

    def test_protocol_step_does_not_mark_user_swaps(self):
        self.assertEqual(cq11.evaluate("step", [8, 8, 1]), [0, 8])
        self.assertEqual(cq11.evaluate("step", [8, 9, 1]), [1, 9])
        self.assertEqual(cq11.evaluate("step", [8, 9, 0]), [1, 8])

    def test_default_corpus_matches_independent_oracle(self):
        for name in vectors.SCENARIOS:
            with self.subTest(scenario=name):
                corpus = json.loads((vectors.VECTORS / f"{name}.json").read_text())
                self.assertGreaterEqual(len(corpus["cases"]), 1 if name == "dust" else 200)
                vectors.validate(name, corpus)

    def test_corpus_check_rejects_missing_or_tampered_comparisons(self):
        original = json.loads((vectors.VECTORS / "dust.json").read_text())
        mutations = [copy.deepcopy(original) for _ in range(4)]
        mutations[0]["cases"][0]["queries"][0]["outputs"][0] = "1"
        mutations[1]["cases"][0]["queries"].pop()
        mutations[2]["cases"][0]["queries"][0]["outputs"][0] = 0
        mutations[3]["cases"] = []
        for corpus in mutations:
            with self.assertRaises(ValueError):
                vectors.validate("dust", corpus)


if __name__ == "__main__":
    unittest.main()
