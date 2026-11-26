"""Offline state round trips: python3 -m unittest discover -s packages/contracts/scripts."""
import copy
import importlib.util
import json
import unittest
from pathlib import Path
from unittest.mock import Mock, patch


spec = importlib.util.spec_from_file_location("post_fork_probes", Path(__file__).with_name("post-fork-probes.py"))
probes = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probes)

CREDIT = 48882681288475525212
PAYMENT = 48882681288475525211
J_REQUEST = 48282702740687649547
RAW_FIELDS = {"j_req", "item_start", "mean_start", "credited", "paid"}


def state():
    return {
        "drawers": {name: name.lower() for name in "ABC"},
        "draws": {
            name: {"ticket": i, "item": i + 10, "round": 42, "request_block": 100,
                   "j_req": J_REQUEST, **({"item_start": J_REQUEST, "mean_start": J_REQUEST}
                                          if name != "A" else {})}
            for i, name in enumerate("ABC", 2)
        },
        "runbook_draw": {"ticket": 1, "item": 1, "j_req": 0, "credited": CREDIT},
        "mean": [1, J_REQUEST],
        "late_from_block": 120,
    }


def open_draw(_box, st, name, _label):
    st["draws"][name].update(item_start=st["draws"][name]["j_req"], mean_start=probes.mean_rule(st))


class DrawStateTests(unittest.TestCase):
    def setUp(self):
        # No RPC, subprocesses or disk writes: only the probe's state and integer calculations run.
        self.enterContext(patch.object(probes.subprocess, "run", side_effect=AssertionError("unexpected subprocess")))
        self.enterContext(patch.object(probes, "say"))
        self.enterContext(patch.object(probes, "sell"))
        self.enterContext(patch.object(probes, "open_draw", side_effect=open_draw))
        self.write = self.enterContext(patch.object(probes.Path, "write_text"))
        self.box = Mock()
        self.box.block.return_value = 120
        self.box.send.return_value = {"status": "0x1", "blockNumber": "0x78", "gasUsed": "0x1"}

    def assert_decimal_state(self, saved):
        for record in [saved["runbook_draw"], *saved["draws"].values()]:
            for field in RAW_FIELDS & record.keys():
                with self.subTest(field=field, ticket=record["ticket"]):
                    self.assertIsInstance(record[field], str)
                    self.assertRegex(record[field], r"^(0|[1-9][0-9]*)$")
        self.assertIsInstance(saved["mean"][0], int)
        self.assertIsInstance(saved["mean"][1], str)
        self.assertEqual(saved["runbook_draw"]["j_req"], "0")
        self.assertEqual(saved["runbook_draw"]["credited"], str(CREDIT))
        self.assertEqual(saved["late_from_block"], 120)

    def test_draws_writes_decimal_strings(self):
        initial = state()
        self.box.read.return_value = "0"
        self.box.reads.return_value = ["word", "1"]
        settled = [{"topics": ["settled", hex(dr["ticket"]), hex(dr["item"])]}
                   for dr in initial["draws"].values()]
        with patch.multiple(probes, cast=Mock(return_value="0x"), chain_time=Mock(return_value=1),
                            drawer_addresses=Mock(return_value=initial["drawers"]),
                            runbook_draw=Mock(side_effect=lambda _box, st, _from: st.update(copy.deepcopy(initial))),
                            request_draw=Mock(), logs_of=Mock(return_value=settled), j_at=Mock(return_value=J_REQUEST),
                            tix=Mock(side_effect=[(0, 3, 3 * J_REQUEST), (0, 3, 3 * J_REQUEST), (0, 1, J_REQUEST)])):
            probes.draws(self.box, "draws.json", 1)
        self.write.assert_called_once()
        saved = json.loads(self.write.call_args.args[0])
        self.assert_decimal_state(saved)
        self.assertEqual(saved["mean"], [1, str(J_REQUEST)])
        self.assertNotIn("item_start", saved["draws"]["A"])
        for dr in saved["draws"].values():
            self.assertEqual(dr["j_req"], str(J_REQUEST))

    def test_draws_late_round_trip_preserves_one_raw_unit(self):
        for decimal_strings in (False, True):
            with self.subTest(decimal_strings=decimal_strings):
                initial = state()
                if decimal_strings:
                    for record in [initial["runbook_draw"], *initial["draws"].values()]:
                        for field in RAW_FIELDS & record.keys():
                            record[field] = str(record[field])
                    initial["mean"][1] = str(initial["mean"][1])
                self.box.read.side_effect = ["0", str(3 * CREDIT), "1"] * 3
                credited = [{"topics": ["credit", "owner", hex(dr["item"])], "data": "0x" + format(CREDIT, "064x")}
                            for dr in initial["draws"].values()]
                claimed = [{"data": "0x" + format(PAYMENT, "064x")}]
                self.write.reset_mock()
                with patch.object(probes.Path, "read_text", return_value=json.dumps(initial)), \
                     patch.multiple(probes, tix=Mock(side_effect=[(0, 1, J_REQUEST), (0, 0, 0)]),
                                    j_at=Mock(return_value=J_REQUEST + CREDIT),
                                    pending=Mock(side_effect=[(name.lower(), CREDIT) for name in "ABC"]),
                                    logs_of=Mock(side_effect=lambda _r, _addr, sig:
                                                 credited if sig == probes.CREDITED else claimed)):
                    probes.draws_late(self.box, "draws.json")
                self.write.assert_called_once()
                saved = json.loads(self.write.call_args.args[0])
                self.assert_decimal_state(saved)
                self.assertEqual(saved["mean"], [0, "0"])
                for dr in saved["draws"].values():
                    self.assertEqual(dr["j_req"], str(J_REQUEST))
                    self.assertEqual(dr["item_start"], str(J_REQUEST))
                    self.assertEqual(dr["mean_start"], str(J_REQUEST))
                    self.assertEqual(dr["credited"], str(CREDIT))
                    self.assertEqual(dr["paid"], str(PAYMENT))
                    self.assertEqual(int(dr["credited"]) - int(dr["paid"]), 1)


if __name__ == "__main__":
    unittest.main()


BACKED = "0x4FE27aE2810DAdA5F2f0f425F6623FdbE6A321fb"
DRAND = "0xbeEcE13fBdd67D0A696cB7cfD28103Ed37ba79A6"
# The runtime code hashes the two sources are pinned by (src/box/randomness/DrandSourcePins.sol, BackedSourcePins.sol).
DRAND_CODE_HASH = "0xb835f0713da5f533832670cd4fa7ba4cc94b93203025f9412d87c9b575a54218"
BACKED_CODE_HASH = "0x7b3be4b9531713d98f065160d3c2dd2f517a0d5203672d8cd3df590d82f2ffa3"
CODE = {DRAND.lower(): "0xd5a2d0", BACKED.lower(): "0xbacced"}
KECCAK = {"0xd5a2d0": DRAND_CODE_HASH, "0xbacced": BACKED_CODE_HASH}
FAILED = object()


def fake_cast(source, drand_answer, code_answer=None):
    """cast for Box(): the registry's box 0, its roles, its randomness(), that source's code and its DRAND() (an
    address, a malformed answer, or FAILED: a revert or an RPC error, as cast reports either)."""
    def run(*args, check=True):
        def failed(why):
            if check:
                raise RuntimeError(f"cast {' '.join(args[:3])}…: {why}")
            return "ERR " + why
        if args[0] == "code":
            if args[1] != source:
                raise AssertionError(f"code read on {args[1]}")
            if code_answer is FAILED:
                return failed("error sending request for url")
            return code_answer if code_answer is not None else CODE[source.lower()]
        if args[0] == "keccak":
            return KECCAK.get(args[1], "0x" + "77" * 32)
        if args[0] != "call":
            raise AssertionError(f"unexpected cast {args[:2]}")
        to, sig = args[1], args[2]
        if sig == "coordinatorOf(uint256)(address)":
            return "0x00000000000000000000000000000000000000b0"
        if sig == "randomness()(address)":
            return source
        if sig == "DRAND()(address)":
            if to != source:
                raise AssertionError(f"DRAND() read on {to}")
            if drand_answer is FAILED:
                return failed("execution reverted")
            return drand_answer
        return "0x" + format(abs(hash(sig)) % (1 << 160), "040x")
    return run


def box_with(cast_fake):
    with patch.object(probes, "cast", side_effect=cast_fake):
        return probes.Box("http://127.0.0.1:8572", "0x00000000000000000000000000000000000000a0")


class BoxSourceTests(unittest.TestCase):
    """rc8 part 2b (F143): rounds are posted, timed and paid on the DrandSource, never on box 0's backed source.
    rc8 part 2c (open item 84): a DRAND() read that fails or answers no address stops the probe; only a source whose code
    is the pinned DrandSource's is a drand-only source."""

    def test_box0_on_its_backed_source_posts_on_the_drand_source_it_names(self):
        box = box_with(fake_cast(BACKED, DRAND))
        self.assertEqual(box.drand, DRAND)
        self.assertEqual(box.source, BACKED)

    def test_a_drand_only_box_keeps_its_source_as_the_drand_source(self):
        box = box_with(fake_cast(DRAND, FAILED))
        self.assertEqual(box.drand, DRAND)
        self.assertEqual(box.source, DRAND)

    def test_a_failed_drand_read_stops_instead_of_posting_on_the_backed_source(self):
        with self.assertRaises((RuntimeError, SystemExit)):
            box_with(fake_cast(BACKED, FAILED))

    def test_a_drand_answer_that_is_no_address_stops(self):
        for answer in ("", "0x", "ERR execution reverted", "0x1234"):
            with self.subTest(answer=answer), self.assertRaises((RuntimeError, SystemExit)):
                box_with(fake_cast(BACKED, answer))

    def test_a_failed_code_read_stops(self):
        with self.assertRaises((RuntimeError, SystemExit)):
            box_with(fake_cast(BACKED, DRAND, code_answer=FAILED))

    def test_other_code_without_drand_stops(self):
        with self.assertRaises((RuntimeError, SystemExit)):
            box_with(fake_cast(BACKED, FAILED, code_answer="0x60006000"))

    def test_the_drand_only_rule_reads_the_pinned_code_hash(self):
        self.assertEqual(probes.pinned_drand_code_hashes(), {DRAND_CODE_HASH})
