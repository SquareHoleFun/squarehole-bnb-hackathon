"""M1-62: the per-ticket mutation manifest (script-py/mutation_v2.json) against the ticket and the wave-1 file map.

Run (from the repository root):
    python3 -m unittest discover -s packages/contracts/test/box-v2/m1-62 -p 'test_*.py'
"""
from __future__ import annotations

import sys

sys.dont_write_bytecode = True

import hashlib  # noqa: E402
import json  # noqa: E402
import re  # noqa: E402
import unittest  # noqa: E402
from pathlib import Path  # noqa: E402

HERE = Path(__file__).resolve().parent
CONTRACTS = HERE.parents[2]
REPO = CONTRACTS.parents[1]
MANIFEST = CONTRACTS / "script-py" / "mutation_v2.json"
FILE_MAP = REPO / "docs" / "design" / "core-v2-m1-file-owners.md"
SMOKE = CONTRACTS / "script-py" / "mutation_smoke_b2.py"
# script-py/mutation_smoke_b2.py at f1727d7c (file map § 8, M1-62's row: "stays as it is").
SMOKE_SHA256 = "948a73cef4ad38e068be4541846dad8b53ade761d935099b6c7ca128a3904983"

# The parts M1-62's entry names (core-v2-m1-tickets.md § 2, M1-62, its "after" list).
TICKETS = ["M1-20", "M1-21", "M1-30", "M1-31", "M1-32", "M1-40", "M1-41", "M1-42", "M1-44", "M1-50"]

# The money paths M1-62's goal names, in its order (§ 2, M1-62 "Goal"); the converter's item is split by its parts.
MONEY_PATHS = [
    "listing checks",
    "the relisting rule",
    "the box-token rule",
    "converter: four hop kinds",
    "converter: FIXED_RATE's pins",
    "converter: two hops",
    "converter: box-token routes",
    "converter: the clocks",
    "converter: the tips",
    "ERC-20 intake and pulls",
    "fail() and its table",
    "recipe engine and the forward calls",
    "the Cap30Days and humble caps with the box-pool floor",
    "legs",
    "the RULE call checks",
    "royalties",
    "the ETH-in helper",
    "box-pool converter room and pace",
    "module room, pace and alternation",
    "outside-hop start-of-block limits",
    "spot step limits and the kept deepen guard",
    "the chunk loader",
    "M1-32's box-token raise band, T_TOO_HIGH and depth floor at creation",
]

# Test folders that do not carry the ticket's number: M1-31's failure suite and M1-42's hostile RULE mocks (file map
# § 6, M1-42's row: `test/box-v2/hostile/*`; M1-31's red tests on `sh-v2-m1-31`).
NAMED_TEST_FOLDERS = {"M1-31": {"failure"}, "M1-42": {"hostile"}}


def manifest() -> dict:
    return json.loads(MANIFEST.read_text())


def files_of(m: dict) -> list[tuple[str, dict]]:
    return [(t, f) for t, entry in m["tickets"].items() for f in entry["files"]]


def map_rows() -> list[str]:
    return [line for line in FILE_MAP.read_text().splitlines() if line.startswith("| ")]


def frozen_section() -> str:
    text = FILE_MAP.read_text()
    return text.split("## 2. Frozen by M1-00", 1)[1].split("\n## 3.", 1)[0]


class ManifestTest(unittest.TestCase):
    def test_tickets_are_m1_62s_list(self) -> None:
        self.assertEqual(list(manifest()["tickets"]), TICKETS)

    def test_money_paths_are_the_goals(self) -> None:
        m = manifest()
        self.assertEqual(list(m["moneyPaths"]), MONEY_PATHS)
        paths = {f["path"] for _, f in files_of(m)}
        for name, covered in m["moneyPaths"].items():
            self.assertTrue(covered, f"{name}: no file")
            for p in covered:
                self.assertIn(p, paths, f"{name}: {p} is in no ticket's files")

    def test_every_file_is_a_money_path_or_says_why(self) -> None:
        m = manifest()
        named = {p for covered in m["moneyPaths"].values() for p in covered}
        for _, f in files_of(m):
            if f["path"] not in named:
                self.assertGreaterEqual(len(f.get("extra", "")), 20, f"{f['path']}: no money path and no reason")

    def test_cq8_room_and_start_of_block_targets_replace_the_step_band(self) -> None:
        paths = manifest()["moneyPaths"]
        self.assertNotIn("the price band and step limits", paths)
        expected = {
            "box-pool converter room and pace": {
                "src/box-v2/ListingRegistry.sol",
                "src/box-v2/libraries/ConverterStep.sol",
                "src/box-v2/ConverterExtension.sol",
            },
            "module room, pace and alternation": {
                "src/box-v2/libraries/ModuleSteps.sol",
                "src/box-v2/libraries/ModuleConvert.sol",
            },
            "outside-hop start-of-block limits": {
                "src/box-v2/libraries/HopV3.sol",
                "src/box-v2/libraries/HopV2Snapshot.sol",
                "src/box-v2/libraries/ConverterStep.sol",
            },
            "spot step limits and the kept deepen guard": {
                "src/box-v2/libraries/BoxSwapBoundsV2.sol",
            },
        }
        for name, sources in expected.items():
            self.assertEqual(set(paths[name]), sources, name)

    def test_files_are_v2_sources_once_each(self) -> None:
        m = manifest()
        seen: set[str] = set()
        skipped = {n["path"] for n in m["notInRun"]}
        for _, f in files_of(m):
            p = f["path"]
            self.assertTrue(p.startswith("src/box-v2/") and p.endswith(".sol"), p)
            self.assertNotIn("/stubs/", p)
            if "/interfaces/" in p:
                self.assertTrue(f.get("frozen"), f"{p}: an interface file is mutated only as a frozen table")
            self.assertNotIn(p, seen, f"{p}: in two tickets")
            self.assertNotIn(p, skipped, f"{p}: both run and not in the run")
            seen.add(p)

    def test_owners_match_the_file_map(self) -> None:
        rows = map_rows()
        frozen = frozen_section()
        for ticket, f in files_of(manifest()):
            owner, p = f["owner"], f["path"]
            if f.get("frozen"):
                self.assertEqual(owner, "M1-00 (frozen)", p)
                self.assertIn(Path(p).name, frozen, f"{p}: not in the file map's § 2")
                continue
            if f.get("newFile"):  # a new file of its owner's, in no row: test_mutation_v2_round1.py checks it
                continue
            self.assertTrue(owner == ticket or owner.startswith(ticket + "-"), f"{p}: owner {owner} not of {ticket}")
            short = "v2/" + p[len("src/box-v2/"):]
            mine = [r for r in rows if re.match(rf"\| {re.escape(owner)}( |\|)", r)]
            self.assertTrue(mine, f"{owner}: no row in the file map")
            self.assertTrue(any(short in r for r in mine), f"{p}: not in {owner}'s row")

    def test_every_shared_stub_library_is_in_the_run(self) -> None:
        rows = frozen_section().splitlines()
        stub_row = next(r for r in rows if r.startswith("| Stubs of wave 1's shared libraries"))
        names = re.findall(r"`(?:v2/libraries/)?([A-Za-z0-9]+\.sol)`", stub_row.split("|")[1])
        self.assertEqual(len(names), 15, names)
        paths = {f["path"] for _, f in files_of(manifest())}
        for n in names:
            self.assertIn(f"src/box-v2/libraries/{n}", paths)

    def test_tests_are_the_tickets_folders(self) -> None:
        for ticket, entry in manifest()["tickets"].items():
            self.assertTrue(entry["tests"], ticket)
            for g in entry["tests"]:
                found = re.fullmatch(r"test/box-v2/([a-z0-9-]+)/\*\*", g)
                self.assertIsNotNone(found, g)
                assert found is not None
                folder = found.group(1)
                ok = folder.startswith(ticket.lower()) or folder in NAMED_TEST_FOLDERS.get(ticket, set())
                self.assertTrue(ok, f"{ticket}: {g} is not its folder")

    def test_runs_never_fork(self) -> None:
        # Review round 1, low 1: M1-23's fork folder too (test/box-v2/fork/Routes.t.sol has no "Fork" in its name).
        self.assertEqual(manifest()["excludeTests"], "{**/*Fork*.t.sol,test/box-v2/fork/**}")

    def test_equivalents_are_argued(self) -> None:
        m = manifest()
        for e in m["equivalents"]:
            self.assertIn(e["ticket"], TICKETS)
            self.assertIn(e["file"], {f["path"] for f in m["tickets"][e["ticket"]]["files"]})
            for key in ("line", "original", "mutant"):
                self.assertTrue(e[key], key)
            self.assertGreaterEqual(len(e["reason"]), 30, e)
            self.assertRegex(e["evidence"], r"^docs/evidence/SH-V2-M1-\d\d[a-z]?\.md$")

    def test_not_in_run_say_why(self) -> None:
        for n in manifest()["notInRun"]:
            self.assertTrue(n["path"].startswith("src/box-v2/"), n)
            self.assertTrue(n["owner"].startswith("M1-"), n)
            self.assertGreaterEqual(len(n["why"]), 20, n)

    def test_smoke_script_unchanged(self) -> None:
        self.assertEqual(hashlib.sha256(SMOKE.read_bytes()).hexdigest(), SMOKE_SHA256)


if __name__ == "__main__":
    unittest.main()
