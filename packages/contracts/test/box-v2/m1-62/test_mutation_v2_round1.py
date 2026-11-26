"""M1-62 review round 1: pins for the runner's fixes and the manifest's rows.

Runner: forge's adaptive skips behind argued rows, the kit's artifact, every v2 source run or left out with why, the
fork folder and fork variables, a changed source never written back, rows that name an occurrence or pin a frozen
file's hash, the report after each source, --changed-since on shared files. Manifest: ConverterExtension in M1-21,
the new files of M1-20-b and M1-40, every source on today's wave-1 branches listed.

Run (from the repository root):
    python3 -m unittest discover -s packages/contracts/test/box-v2/m1-62 -p 'test_*.py'
"""
from __future__ import annotations

import sys

sys.dont_write_bytecode = True

import hashlib  # noqa: E402
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
REPO = CONTRACTS.parents[1]
SCRIPT = CONTRACTS / "script-py" / "mutation_v2.py"
MANIFEST = CONTRACTS / "script-py" / "mutation_v2.json"
FILE_MAP = REPO / "docs" / "design" / "core-v2-m1-file-owners.md"

PATH = "src/box-v2/libraries/A.sol"
# Lines 4 and 6 have the same text (low 2); line 5 has one survivor in the tests below.
LIB = ("pragma solidity 0.8.26;\nlibrary A {\n    function f(uint256 x) internal pure returns (uint256) {\n"
       "        if (x == 0) return 0;\n        if (x > 10) return 1;\n        if (x == 0) return 0;\n"
       "        return x - 1;\n    }\n}\n")
STUB = "pragma solidity 0.8.26;\nlibrary B {\n    error NotBuilt();\n    function g() internal pure {\n" \
       "        revert NotBuilt();\n    }\n}\n"
ARTIFACT = "out/PoolManager.sol/PoolManager.json"
EXCLUDE = "{**/*Fork*.t.sol,test/box-v2/fork/**}"

# Every v2 source outside interfaces/ and stubs/ on the wave-1 branches (sh-v2-m1-*) on 2026-10-06 UTC that the first
# manifest had in neither `tickets` nor `notInRun` [V: `git ls-tree` of each branch]. The merged tree must list them.
WAVE1_SOURCES = [
    "src/box-v2/BoxCollectionV2.sol", "src/box-v2/BoxCoordinatorV2.sol", "src/box-v2/BoxHookV2.sol",
    "src/box-v2/BoxHookV2Base.sol", "src/box-v2/BoxHookV2Extension.sol", "src/box-v2/BoxLaunchRouterV2.sol",
    "src/box-v2/BoxPriceSamplerV2.sol", "src/box-v2/BoxReceiverV2Cold.sol", "src/box-v2/BoxSpecV2.sol",
    "src/box-v2/BoxTicketsV2.sol", "src/box-v2/BoxTokenV2.sol", "src/box-v2/BoxVaultV2.sol",
    "src/box-v2/ListingRouteChecker.sol", "src/box-v2/libraries/BoxCollectionV2Args.sol",
    "src/box-v2/libraries/BoxCoordinatorV2Args.sol", "src/box-v2/libraries/BoxHookV2Args.sol",
    "src/box-v2/libraries/BoxLaunchRouterV2Args.sol", "src/box-v2/libraries/BoxPriceSamplerV2Args.sol",
    "src/box-v2/libraries/BoxReceiverV2Args.sol", "src/box-v2/libraries/BoxRoyaltyRouterV2Args.sol",
    "src/box-v2/libraries/BoxSwapModuleV2Args.sol", "src/box-v2/libraries/BoxTicketsV2Args.sol",
    "src/box-v2/libraries/BoxVaultV2Args.sol", "src/box-v2/libraries/HopTypes.sol",
    "src/box-v2/libraries/IntakeLedgers.sol", "src/box-v2/libraries/ReceiverV2Seam.sol",
    "src/box-v2/plugins/HalvingRule.sol", "src/box-v2/plugins/PrisonersRule.sol",
]

# A fake forge: logs argv, its environment's names and the report file as it is now; prints FAKE_JSON and FAKE_ERR.
FAKE_FORGE = textwrap.dedent('''\
    #!/usr/bin/env python3
    import json, os, sys
    report = os.environ.get("FAKE_REPORT")
    seen = open(report).read() if report and os.path.exists(report) else None
    with open(os.environ["FAKE_LOG"], "a") as log:
        log.write(json.dumps({"argv": sys.argv[1:], "env": sorted(os.environ), "report": seen}) + "\\n")
    if os.environ.get("FAKE_TOUCH"):
        with open(os.environ["FAKE_TOUCH"], "a") as f:
            f.write("// touched\\n")
    sys.stdout.write(os.environ.get("FAKE_JSON", ""))
    sys.stderr.write(os.environ.get("FAKE_ERR", ""))
    sys.exit(int(os.environ.get("FAKE_EXIT", "0")))
''')


def load():
    spec = importlib.util.spec_from_file_location("mutation_v2_round1", SCRIPT)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def survivor(line: int, original: str, mutant: str) -> dict:
    return {"line": line, "column": 13, "original": original, "mutant": mutant}


def forge_out(survivors: list | None = None, path: str = PATH, **over) -> str:
    survivors = survivors or []
    s = {"killed": 20 - len(survivors), "survived": len(survivors), "invalid": 0, "skipped": 0, "timed_out": 0}
    s.update(over)
    s.setdefault("total", sum(s[k] for k in ("killed", "survived", "invalid", "skipped", "timed_out")))  # round 2
    return json.dumps({"summary": s, "survived_mutants": {path: survivors} if survivors else {}})


def row(line: str, original: str, mutant: str, **extra) -> dict:
    return {"ticket": "M1-42", "file": PATH, "line": line, "original": original, "mutant": mutant,
            "reason": "a reason of more than thirty characters", "evidence": "docs/evidence/SH-V2-M1-42.md", **extra}


S5 = survivor(5, "x > 10", "x >= 10")
R5 = row("if (x > 10) return 1;", "x > 10", "x >= 10")


class Fixture(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = tempfile.TemporaryDirectory()
        self.root = Path(self.dir.name)
        for d in ("libraries", "interfaces", "stubs"):
            (self.root / "src/box-v2" / d).mkdir(parents=True)
        (self.root / PATH).write_text(LIB)
        (self.root / "src/box-v2/libraries/B.sol").write_text(STUB)
        self.forge = self.root / "fake-forge"
        self.forge.write_text(FAKE_FORGE)
        self.forge.chmod(0o755)
        self.log = self.root / "forge.log"
        self.report = self.root / "r.json"

    def tearDown(self) -> None:
        self.dir.cleanup()

    def manifest(self, equivalents: list | None = None, files: tuple = ("A.sol",), **extra) -> None:
        m = {"tickets": {"M1-42": {"tests": ["test/box-v2/hostile/**"],
                                   "files": [{"path": f"src/box-v2/libraries/{n}", "owner": "M1-42"} for n in files]}},
             "moneyPaths": {}, "notInRun": [], "equivalents": equivalents or [], **extra}
        (self.root / "m.json").write_text(json.dumps(m))

    def run_cli(self, *args: str, **env: str) -> subprocess.CompletedProcess:
        full = {k: v for k, v in os.environ.items() if "FORK" not in k.upper() and "RPC" not in k.upper()}
        full.update(FAKE_LOG=str(self.log), **env)
        return subprocess.run([sys.executable, str(SCRIPT), "--root", str(self.root), "--manifest",
                               str(self.root / "m.json"), "--forge", str(self.forge), *args],
                              capture_output=True, text=True, env=full, timeout=60)

    def run_ticket(self, out: str, *args: str, **env: str) -> subprocess.CompletedProcess:
        return self.run_cli("--ticket", "M1-42", "--report", str(self.report), *args, FAKE_JSON=out, **env)

    def calls(self) -> list[dict]:
        return [json.loads(x) for x in self.log.read_text().splitlines()] if self.log.exists() else []

    def file_result(self) -> dict:
        return json.loads(self.report.read_text())["tickets"][0]["files"][0]


class AdaptiveSkipsTest(Fixture):
    """Finding 1: forge skips a span's other mutants once one survives, so an argued row hides them. Since round 2
    the runner runs each skipped mutant itself (test_mutation_v2_round2.py); here forge's fake names none of them."""

    def test_argued_row_with_skips_is_red(self) -> None:
        self.manifest([R5])
        r = self.run_ticket(forge_out([S5], skipped=2))
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn("2 skipped mutant(s) not run", r.stdout)
        self.assertIn("skipped 2", r.stdout)
        self.assertTrue(self.file_result()["notGreen"][0].startswith("2 skipped mutant(s) not run"))

    def test_span_all_is_retired(self) -> None:
        self.manifest([dict(R5, span="all")])
        r = self.run_ticket(forge_out([S5], skipped=2))
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
        self.assertEqual(self.calls(), [])

    def test_skips_with_no_survivor_are_red(self) -> None:
        self.manifest()
        r = self.run_ticket(forge_out([], skipped=1))
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn("1 skipped mutant(s) not run", r.stdout)

    def test_alive_survivor_with_skips_says_both(self) -> None:
        self.manifest()
        r = self.run_ticket(forge_out([S5], skipped=3))
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn("1 survivor(s) alive", r.stdout)
        self.assertIn("3 skipped mutant(s) not run", r.stdout)

    def test_span_must_be_mutant(self) -> None:
        self.manifest([dict(R5, span="most")])
        self.assertEqual(self.run_ticket(forge_out([S5])).returncode, 2)
        self.assertEqual(self.calls(), [])

    def test_exit_code_counts_the_skips_run(self) -> None:
        m = load()
        base = {"state": "built", "alive": [], "error": None, "equivalent": [dict(S5, span="mutant")],
                "summary": {"total": 5, "survived": 1, "skipped": 2, "timed_out": 0}}
        self.assertEqual(m.exit_code([base]), 1)
        killed = [{"result": "killed"}, {"result": "invalid"}]
        self.assertEqual(m.exit_code([dict(base, planted=killed)]), 0)
        self.assertEqual(m.exit_code([dict(base, planted=killed[:1])]), 1)
        self.assertEqual(m.exit_code([dict(base, planted=[{"result": "killed"}, {"result": "timed out"}])]), 1)
        clean = dict(base, summary=dict(base["summary"], skipped=0))
        self.assertEqual(m.exit_code([clean]), 0)


class ArtifactTest(Fixture):
    """Finding 2: the kit loads the PoolManager from its artifact, which a filtered run never compiles."""

    def test_missing_artifact_stops_before_forge(self) -> None:
        self.manifest(artifacts=[ARTIFACT])
        r = self.run_ticket(forge_out())
        self.assertEqual(r.returncode, 3, r.stdout + r.stderr)
        self.assertIn("forge build", r.stdout + r.stderr)
        self.assertIn(ARTIFACT, r.stdout + r.stderr)
        self.assertEqual(self.calls(), [])
        (self.root / ARTIFACT).parent.mkdir(parents=True)
        (self.root / ARTIFACT).write_text("{}")
        self.assertEqual(self.run_ticket(forge_out()).returncode, 0)
        self.assertEqual(len(self.calls()), 1)

    def test_no_built_source_needs_no_artifact(self) -> None:
        self.manifest(files=("B.sol",), artifacts=[ARTIFACT])
        r = self.run_ticket(forge_out(), "--allow-pending")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)


class CoverageTest(Fixture):
    """Finding 4: every v2 source outside interfaces/ and stubs/ is run or left out with why."""

    def test_unlisted_source_warns_in_list_and_runs(self) -> None:
        for p in ("libraries/X.sol", "interfaces/I.sol", "stubs/S.sol"):
            (self.root / "src/box-v2" / p).write_text("pragma solidity 0.8.26;\n")
        self.manifest(files=("A.sol", "B.sol"))
        listed = self.run_cli("--list")
        self.assertEqual(listed.returncode, 0, listed.stderr)
        self.assertIn("WARNING src/box-v2/libraries/X.sol", listed.stdout)
        self.assertNotIn("I.sol", listed.stdout)
        self.assertNotIn("S.sol", listed.stdout)
        r = self.run_ticket(forge_out(), "--allow-pending")
        self.assertIn("WARNING src/box-v2/libraries/X.sol", r.stdout)
        self.assertEqual(json.loads(self.report.read_text())["uncovered"], ["src/box-v2/libraries/X.sol"])
        self.manifest(files=("A.sol", "B.sol"),
                      notInRun=[{"path": "src/box-v2/libraries/X.sol", "owner": "M1-42", "why": "a reason here"}])
        self.assertNotIn("WARNING", self.run_cli("--list").stdout)

    def test_shared_paths_start_every_ticket(self) -> None:
        m = {"sharedPaths": ["src/box-v2/interfaces/", "src/box-v2/libraries/HopTypes.sol", "test/box-v2/kit/"],
             "tickets": {"M1-42": {"tests": ["test/box-v2/hostile/**"], "files": [{"path": "src/box-v2/x/R.sol"}]},
                         "M1-44": {"tests": ["test/box-v2/m1-44/**"], "files": [{"path": "src/box-v2/x/Q.sol"}]}}}
        f = load().tickets_for_changes
        for changed in ("packages/contracts/src/box-v2/interfaces/ReleaseConstantsV2.sol",
                        "packages/contracts/src/box-v2/libraries/HopTypes.sol",
                        "packages/contracts/test/box-v2/kit/BoxV2TestBase.sol"):
            self.assertEqual(f(m, [changed]), ["M1-42", "M1-44"], changed)
        self.assertEqual(f(m, ["packages/contracts/src/box-v2/x/Q.sol"]), ["M1-44"])


class NoNetworkTest(Fixture):
    """Low 1: the fork folder is excluded and no fork or RPC variable reaches forge."""

    def test_fork_folder_and_variables(self) -> None:
        self.manifest()
        names = ("SH_FORK_MAINNET", "SH_FORK_SEPOLIA", "MAINNET_FORK_RPC_URL", "SEPOLIA_FORK_RPC_URL",
                 "FOUNDRY_ETH_RPC_URL", "ETH_RPC_URL", "FOUNDRY_FORK_BLOCK_NUMBER", "SH_CORE_V1_FORK_URL")
        r = self.run_ticket(forge_out(), **{n: "x" for n in names}, SH_KEEP_ME="1")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        (call,) = self.calls()
        self.assertFalse(set(names) & set(call["env"]), "a fork or RPC variable reached forge")
        self.assertIn("SH_KEEP_ME", call["env"])
        argv = call["argv"]
        self.assertEqual(argv[argv.index("--no-match-path") + 1], EXCLUDE, "the default when the manifest names none")


class EquivalentRowsTest(Fixture):
    """Low 2: a row on a line whose text repeats names its occurrence; a row may pin its file's sha256."""

    S6 = survivor(6, "x == 0", "x <= 0")
    R6 = row("if (x == 0) return 0;", "x == 0", "x <= 0")

    def test_repeated_line_needs_its_occurrence(self) -> None:
        self.manifest([self.R6])
        r = self.run_ticket(forge_out([self.S6]))
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn("occurs 2 times", r.stdout)
        self.manifest([dict(self.R6, occurrence=1)])
        self.assertEqual(self.run_ticket(forge_out([self.S6])).returncode, 1)
        self.manifest([dict(self.R6, occurrence=2)])
        self.assertEqual(self.run_ticket(forge_out([self.S6])).returncode, 0)

    def test_row_pins_its_files_hash(self) -> None:
        digest = hashlib.sha256(LIB.encode()).hexdigest()
        self.manifest([dict(R5, sha256=digest)])
        self.assertEqual(self.run_ticket(forge_out([S5])).returncode, 0)
        self.manifest([dict(R5, sha256="0" * 64)])
        r = self.run_ticket(forge_out([S5]))
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn("sha256", r.stdout)
        self.manifest([dict(R5, sha256="abc")])
        self.assertEqual(self.run_ticket(forge_out([S5])).returncode, 2)
        self.manifest([dict(R5, occurrence=0)])
        self.assertEqual(self.run_ticket(forge_out([S5])).returncode, 2)


class BaselineHintTest(Fixture):
    """The dry run on sh-v2-m1-42: forge blames its compiler profile when a plain test fails; name the plain run."""

    def test_failed_baseline_names_the_plain_run(self) -> None:
        self.manifest()
        err = "Error: Mutation testing compiler profile failed its unmutated baseline run; adjust `--mutation-via-ir`"
        r = self.run_ticket("", FAKE_EXIT="1", FAKE_ERR=err)
        self.assertEqual(r.returncode, 3, r.stdout + r.stderr)
        self.assertIn(f"forge test --match-path 'test/box-v2/hostile/**' --no-match-path '{EXCLUDE}'", r.stdout)


class ReportTest(Fixture):
    """Low 5 (part): the report is written after each source, so a lost run leaves what it finished."""

    def test_report_after_each_source(self) -> None:
        (self.root / "src/box-v2/libraries/C.sol").write_text(LIB.replace("library A", "library C"))
        self.manifest(files=("A.sol", "C.sol"))
        r = self.run_ticket(forge_out(), FAKE_REPORT=str(self.report))
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        first, second = self.calls()
        self.assertIsNone(first["report"])
        partial = json.loads(second["report"])
        self.assertIsNone(partial["exitCode"])
        (entry,) = partial["tickets"][0]["files"]
        self.assertEqual(entry["path"], PATH)
        self.assertEqual(entry["summary"]["killed"], 20)
        self.assertEqual(json.loads(self.report.read_text())["exitCode"], 0)
        self.assertIn(f"{PATH}: forge running", r.stdout)


class YamlRequiredTest(unittest.TestCase):
    """Low 6: under verify or CI the workflow tests fail, not skip, when PyYAML is missing."""

    def run_without_yaml(self, **env: str) -> subprocess.CompletedProcess:
        code = ("import sys, unittest; sys.modules['yaml'] = None; "
                f"suite = unittest.defaultTestLoader.discover({str(HERE)!r}, pattern='test_mutation_v2_workflow.py'); "
                "sys.exit(0 if unittest.TextTestRunner().run(suite).wasSuccessful() else 1)")
        full = {k: v for k, v in os.environ.items() if k not in ("CI", "SH_MUTATION_REQUIRE_YAML")}
        full.update(env)
        return subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, env=full, timeout=60)

    def test_skips_only_outside_verify_and_ci(self) -> None:
        r = self.run_without_yaml()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("skipped", r.stderr)
        self.assertNotEqual(self.run_without_yaml(SH_MUTATION_REQUIRE_YAML="1").returncode, 0)
        self.assertNotEqual(self.run_without_yaml(CI="true").returncode, 0)


class ManifestRound1Test(unittest.TestCase):
    """Findings 3 and 4 on the real manifest and tree."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.m = json.loads(MANIFEST.read_text())
        cls.run_paths = {f["path"]: (t, f) for t, e in cls.m["tickets"].items() for f in e["files"]}
        cls.out = {n["path"]: n for n in cls.m["notInRun"]}

    def test_every_v2_source_is_run_or_says_why(self) -> None:
        base = CONTRACTS / "src" / "box-v2"
        found = [p.relative_to(CONTRACTS).as_posix() for p in base.rglob("*.sol")]
        mine = [p for p in found if not p.startswith(("src/box-v2/interfaces/", "src/box-v2/stubs/"))]
        self.assertTrue(mine)
        for p in mine:
            self.assertTrue(p in self.run_paths or p in self.out, f"{p}: neither run nor in notInRun")
        self.assertEqual(load().uncovered(CONTRACTS, self.m), [])

    def test_todays_wave1_sources_are_listed(self) -> None:
        for p in WAVE1_SOURCES:
            self.assertTrue(p in self.run_paths or p in self.out, f"{p}: neither run nor in notInRun")

    def test_converter_extension_runs_with_m1_21(self) -> None:
        p = "src/box-v2/ConverterExtension.sol"
        ticket, f = self.run_paths[p]
        self.assertEqual((ticket, f["owner"]), ("M1-21", "M1-21-f"))
        self.assertNotIn(p, self.out)
        for name in ("converter: the tips", "converter: two hops"):
            self.assertIn(p, self.m["moneyPaths"][name])

    def test_new_files_run_with_their_tickets(self) -> None:
        rows = [line for line in FILE_MAP.read_text().splitlines() if line.startswith("| ")]
        expected = {"src/box-v2/ListingRouteChecker.sol": ("M1-20", "M1-20-b"),
                    "src/box-v2/BoxReceiverV2Cold.sol": ("M1-40", "M1-40-a"),
                    "src/box-v2/libraries/IntakeLedgers.sol": ("M1-40", "M1-40-b")}
        for p, (ticket, owner) in expected.items():
            got, f = self.run_paths[p]
            self.assertEqual((got, f["owner"]), (ticket, owner), p)
        for p, (ticket, f) in self.run_paths.items():
            if not f.get("newFile"):
                continue
            self.assertGreaterEqual(len(f["newFile"]), 20, p)
            self.assertTrue(f["owner"].startswith(ticket + "-") or f["owner"] == ticket, p)
            short = "v2/" + p[len("src/box-v2/"):]
            self.assertFalse([r for r in rows if short in r], f"{p}: a file-map row names it, so it is not new")
        self.assertIn("src/box-v2/ListingRouteChecker.sol", self.m["moneyPaths"]["listing checks"])
        recipe = self.m["moneyPaths"]["recipe engine and the forward calls"]
        self.assertIn("src/box-v2/BoxReceiverV2Cold.sol", recipe)
        self.assertIn("src/box-v2/libraries/IntakeLedgers.sol", recipe)

    def test_artifact_fork_folder_and_shared_paths(self) -> None:
        self.assertEqual(self.m["artifacts"], [ARTIFACT])
        self.assertEqual(self.m["excludeTests"], EXCLUDE)
        for p in ("src/box-v2/interfaces/", "src/box-v2/stubs/", "src/box-v2/libraries/HopTypes.sol",
                  "test/box-v2/kit/"):
            self.assertIn(p, self.m["sharedPaths"])

    def test_rows_name_their_span_and_frozen_rows_pin_the_file(self) -> None:
        for e in self.m["equivalents"]:
            self.assertIn(e.get("span", "mutant"), ("mutant",), e)  # round 2: `all` retired
            if self.run_paths[e["file"]][1].get("frozen"):
                digest = hashlib.sha256((CONTRACTS / e["file"]).read_bytes()).hexdigest()
                self.assertEqual(e.get("sha256"), digest, f"{e['file']}: a frozen file's row pins its sha256")


if __name__ == "__main__":
    unittest.main()
