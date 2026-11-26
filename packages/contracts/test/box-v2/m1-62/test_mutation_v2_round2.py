"""M1-62 review round 2: pins for forge's report and version, the mutants forge skips, and three lows.

Finding 1: forge's summary must be whole and agree with its survivors; forge's version must be the manifest's pin.
Finding 2: forge names every mutant it skipped in its own results file (cache/mutation/*.results); the runner plants
each in a copy of the project and runs the ticket's plain tests there, so no mutant is left unrun or argued as a span.
Lows: a frozen file's row pins its sha256; an unplaced v2 source fails under --strict and --scope v2; no FFI or other
profile reaches forge; BoxSwapModuleV2Args runs with M1-41.

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

try:
    import yaml  # PyYAML
except ImportError:  # pragma: no cover
    yaml = None

HERE = Path(__file__).resolve().parent
CONTRACTS = HERE.parents[2]
REPO = CONTRACTS.parents[1]
SCRIPT = CONTRACTS / "script-py" / "mutation_v2.py"
MANIFEST = CONTRACTS / "script-py" / "mutation_v2.json"
WORKFLOW = REPO / ".github" / "workflows" / "mutation-v2.yml"

PATH = "src/box-v2/libraries/A.sol"
LIB = ("pragma solidity 0.8.26;\nlibrary A {\n"
       "    function f(uint256[] memory ids) internal pure returns (uint256 t) {\n"
       "        if (ids.length == 0) return 0;\n        for (uint256 i = 0; i < ids.length; ++i) t += ids[i];\n"
       "    }\n}\n")
LINE4 = "if (ids.length == 0) return 0;"
LINE5 = "for (uint256 i = 0; i < ids.length; ++i) t += ids[i];"
REAL_VERSION = ("forge Version: 1.8.3\nCommit SHA: cae51ad458f6abb64852b7709eb784352429825d\n"
                "Build Timestamp: 2026-09-15T10:34:23.361078000Z (1789468463)\nBuild Profile: dist\n")

# A fake forge. `--version` answers FAKE_VERSION. `test --mutate` prints FAKE_JSON and, as forge does, writes
# FAKE_RESULTS into cache/mutation/ under the project. A plain `test` (the runner's planted runs) reads FAKE_SRC in its
# working folder: it fails when FAKE_BASELINE_FAIL is set or a FAKE_KILL text is in the file, hangs on FAKE_HANG.
# R4: FAKE_ON selects a planted mutant whose stdout, stderr and exit (negative means signal) are controlled.
FAKE_FORGE = textwrap.dedent('''\
    #!/usr/bin/env python3
    import json, os, sys, time
    argv = sys.argv[1:]
    with open(os.environ["FAKE_LOG"], "a") as log:
        log.write(json.dumps({"argv": argv, "cwd": os.getcwd(), "ffi": os.environ.get("FOUNDRY_FFI"),
                              "profile": os.environ.get("FOUNDRY_PROFILE")}) + "\\n")
    if argv == ["--version"]:
        version = os.environ.get("FAKE_VERSION", "1.8.3")
        sys.stdout.write(os.environ.get("FAKE_VERSION_TEXT") or
                         "forge Version: %s\\nCommit SHA: cae51ad4\\nBuild Profile: dist\\n" % version)
        sys.exit(0)
    if "--mutate" in argv:
        if os.environ.get("FAKE_RESULTS"):
            os.makedirs("cache/mutation", exist_ok=True)
            with open("cache/mutation/fake_%d.results" % time.time_ns(), "w") as f:
                f.write(os.environ["FAKE_RESULTS"])
        sys.stdout.write(os.environ.get("FAKE_JSON", ""))
        sys.exit(0)
    text = open(os.environ["FAKE_SRC"]).read()
    if os.environ.get("FAKE_BASELINE_FAIL"):
        sys.stderr.write("Error: a test failed\\n")
        sys.exit(1)
    if os.environ.get("FAKE_HANG") and os.environ["FAKE_HANG"] in text:
        time.sleep(60)
    if os.environ.get("FAKE_ON") and os.environ["FAKE_ON"] in text:
        sys.stdout.write(os.environ.get("FAKE_STDOUT", ""))
        sys.stderr.write(os.environ.get("FAKE_STDERR", ""))
        sys.stdout.flush()
        sys.stderr.flush()
        code = int(os.environ["FAKE_EXIT"])
        if code < 0:
            os.kill(os.getpid(), -code)
        sys.exit(code)
    if any(k and k in text for k in os.environ.get("FAKE_KILL", "").split("|")):
        print("[FAIL: fixture] test_mutant() (gas: 1)")
        sys.exit(1)
    sys.exit(0)
''')


def load():
    spec = importlib.util.spec_from_file_location("mutation_v2_round2", SCRIPT)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def span(text: str, occurrence: int = 1) -> tuple[int, int]:
    data, lo = LIB.encode(), -1
    for _ in range(occurrence):
        lo = data.index(text.encode(), lo + 1)
    return lo, lo + len(text.encode())


def mutant(root: Path, text: str, mutation: object, line: int, status: str) -> list:
    lo, hi = span(text)
    return [{"path": str((root / PATH).resolve()), "span": {"lo": lo, "hi": hi}, "mutation": mutation,
             "original": text, "source_line": LIB.splitlines()[line - 1].strip(), "line_number": line,
             "column_number": 13}, status]


def binary(new: str) -> dict:
    return {"BinaryOpExpr": {"new_op": "X", "mutated_expr": new}}


def unary(new: str) -> dict:
    return {"UnaryOperator": {"new_expression": new, "resulting_op_kind": "X"}}


S4 = {"line": 4, "column": 13, "original": "ids.length == 0", "mutant": "ids.length <= 0"}
S5 = {"line": 5, "column": 45, "original": "++i", "mutant": "i++"}


def row(line: str, original: str, mutant_text: str, **extra) -> dict:
    return {"ticket": "M1-42", "file": PATH, "line": line, "original": original, "mutant": mutant_text,
            "reason": "a reason of more than thirty characters", "evidence": "docs/evidence/SH-V2-M1-42.md", **extra}


R4 = row(LINE4, "ids.length == 0", "ids.length <= 0")
R5 = row(LINE5, "++i", "i++")


def summary(**over) -> dict:
    s = {"killed": 2, "survived": 2, "invalid": 0, "skipped": 2, "timed_out": 0}
    s.update(over)
    s.setdefault("total", sum(s[k] for k in ("killed", "survived", "invalid", "skipped", "timed_out")))
    return s


def report(survivors: list | None = None, **over) -> str:
    survivors = [S4, S5] if survivors is None else survivors
    return json.dumps({"summary": summary(survived=len(survivors), **over),
                       "survived_mutants": {PATH: survivors} if survivors else {}})


class Fixture(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = tempfile.TemporaryDirectory()
        self.root = Path(self.dir.name)
        for d in ("libraries", "interfaces", "stubs"):
            (self.root / "src/box-v2" / d).mkdir(parents=True)
        (self.root / PATH).write_text(LIB)
        (self.root / "lib").mkdir()
        self.forge = self.root / "fake-forge"
        self.forge.write_text(FAKE_FORGE)
        self.forge.chmod(0o755)
        self.log = self.root / "forge.log"
        self.report = self.root / "r.json"

    def tearDown(self) -> None:
        self.dir.cleanup()

    def results(self, *extra: list, statuses: tuple = ("Skipped", "Skipped")) -> str:
        """Forge's results file: the two survivors, one killed sibling each and the two skipped siblings."""
        r = self.root
        rows = [mutant(r, "ids.length == 0", binary("ids.length < 0"), 4, "Dead"),
                mutant(r, "ids.length == 0", binary("ids.length <= 0"), 4, "Alive"),
                mutant(r, "ids.length == 0", binary("ids.length > 0"), 4, statuses[0]),
                mutant(r, "++i", unary("~i"), 5, "Dead"),
                mutant(r, "++i", unary("i++"), 5, "Alive"),
                mutant(r, "++i", unary("--i"), 5, statuses[1]), *extra]
        return json.dumps({"mutant_count": len(rows), "mutant_hash": 1, "results": rows})

    def manifest(self, equivalents: list | None = None, **extra) -> None:
        m = {"tickets": {"M1-42": {"tests": ["test/box-v2/hostile/**"],
                                   "files": [{"path": PATH, "owner": "M1-42"}]}},
             "moneyPaths": {}, "notInRun": [], "equivalents": [R4, R5] if equivalents is None else equivalents,
             **extra}
        (self.root / "m.json").write_text(json.dumps(m))

    def run_ticket(self, out: str, *args: str, **env: str) -> subprocess.CompletedProcess:
        full = {k: v for k, v in os.environ.items() if "FORK" not in k.upper() and "RPC" not in k.upper()}
        full.update(FAKE_LOG=str(self.log), FAKE_JSON=out, FAKE_SRC=PATH, **env)
        return subprocess.run([sys.executable, str(SCRIPT), "--root", str(self.root), "--manifest",
                               str(self.root / "m.json"), "--forge", str(self.forge), "--ticket", "M1-42", "--report",
                               str(self.report), *args], capture_output=True, text=True, env=full, timeout=120)

    def calls(self) -> list[dict]:
        return [json.loads(x) for x in self.log.read_text().splitlines()] if self.log.exists() else []

    def file_result(self) -> dict:
        return json.loads(self.report.read_text())["tickets"][0]["files"][0]


class ForgeReportTest(unittest.TestCase):
    """Finding 1: the summary is whole, adds up and agrees with the survivors, or the run is forge's error."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.m = load()

    def parse(self, s: dict, survivors: dict | None = None, key: str = "survived_mutants") -> dict:
        return self.m.parse_forge_json(json.dumps({"summary": s, key: survivors or {}}))

    def test_whole_summary_parses_with_forges_extra_keys(self) -> None:
        s = dict(summary(survived=1), mutation_score=72.2, duration_secs=28.5)
        got = self.parse(s, {PATH: [S4]})
        self.assertEqual(got["summary"]["skipped"], 2)
        self.assertEqual(len(got["survivors"]), 1)

    def test_missing_or_renamed_counts_are_errors(self) -> None:
        for gone in ("total", "killed", "survived", "invalid", "skipped", "timed_out"):
            s = summary(survived=0)
            s.pop(gone)
            with self.assertRaises(self.m.ForgeError, msg=gone):
                self.parse(s)
        with self.assertRaises(self.m.ForgeError):
            self.parse(dict(summary(survived=0), skipped=True))
        with self.assertRaises(self.m.ForgeError):
            self.parse(dict(summary(survived=0), skipped="2"))

    def test_survived_must_match_the_list(self) -> None:
        with self.assertRaises(self.m.ForgeError) as e:
            self.parse(summary(survived=3))
        self.assertIn("3", str(e.exception))
        with self.assertRaises(self.m.ForgeError):
            self.parse(summary(survived=1), {PATH: [S4]}, key="survivors")  # the survivors under a renamed key

    def test_counts_must_add_up(self) -> None:
        with self.assertRaises(self.m.ForgeError) as e:
            self.parse(summary(survived=0, total=99))
        self.assertIn("99", str(e.exception))

    def test_version_in_forges_output(self) -> None:
        self.assertEqual(self.m.version_in(REAL_VERSION), "1.8.3")
        self.assertEqual(self.m.version_in("forge 0.2.0 (c2233ec 2024-01-01T00:00:00Z)\n"), "0.2.0")
        self.assertIsNone(self.m.version_in("error: unknown option\n"))


class ForgeReportCliTest(Fixture):
    """Finding 1 through the command line: the reviewer's probes now exit 3."""

    def test_renamed_survivors_and_skips_exit_3(self) -> None:
        self.manifest([])
        renamed = json.dumps({"summary": {k: v for k, v in summary(survived=2).items() if k != "skipped"} |
                              {"skipped_mutants": 2}, "survivors": {PATH: [S4, S5]}})
        r = self.run_ticket(renamed)
        self.assertEqual(r.returncode, 3, r.stdout + r.stderr)
        self.assertIn("skipped", r.stdout)
        lying = json.dumps({"summary": summary(survived=3, skipped=0), "survived_mutants": {}})
        r = self.run_ticket(lying)
        self.assertEqual(r.returncode, 3, r.stdout + r.stderr)

    def test_version_mismatch_stops_before_forge_runs(self) -> None:
        self.manifest([], forge="1.8.3")
        r = self.run_ticket(report([], skipped=0), FAKE_VERSION="1.8.4")
        self.assertEqual(r.returncode, 3, r.stdout + r.stderr)
        self.assertIn("1.8.4", r.stderr)
        self.assertIn("1.8.3", r.stderr)
        self.assertEqual([c["argv"] for c in self.calls()], [["--version"]])
        self.assertEqual(json.loads(self.report.read_text())["exitCode"], 3)

    def test_version_match_runs_and_is_reported(self) -> None:
        self.manifest([], forge="1.8.3")
        r = self.run_ticket(report([], skipped=0, killed=4), FAKE_VERSION_TEXT=REAL_VERSION)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(self.calls()[0]["argv"], ["--version"])
        self.assertEqual(json.loads(self.report.read_text())["forge"], "1.8.3")

    def test_unreadable_version_is_exit_3(self) -> None:
        self.manifest([], forge="1.8.3")
        r = self.run_ticket(report([], skipped=0), FAKE_VERSION_TEXT="nothing here\n")
        self.assertEqual(r.returncode, 3, r.stdout + r.stderr)
        self.assertEqual(len(self.calls()), 1)


class SkippedMutantsTest(Fixture):
    """Finding 2: every mutant forge skipped is run by the runner in a copy of the project, or the run is red."""

    def test_multiline_results_match_collapsed_originals(self) -> None:
        # R4 M1: even a Dead row on another expression must not reject this file's skips.
        mod = load()
        text = b"// byte offsets: \xc3\xa9\nlibrary A {\n    bool ok = a >= lo\n\t        && a <= hi;\n}\n"
        (self.root / PATH).write_bytes(text)
        expression = b"a >= lo\n\t        && a <= hi"
        lo = text.index(expression)
        entry = {"path": str(self.root / PATH), "span": {"lo": lo, "hi": lo + len(expression)},
                 "original": "a >= lo && a <= hi", "line_number": 3, "column_number": 15,
                 "mutation": binary("a >= lo || a <= hi")}
        cache = self.root / "cache/mutation"
        cache.mkdir(parents=True)
        results = cache / "multiline.results"
        results.write_text(json.dumps({"mutant_count": 2, "results": [[entry, "Dead"], [entry, "Skipped"]]}))
        counts = summary(killed=1, survived=0, skipped=1)
        for seen in ({}, mod.stamps(cache)):
            with self.subTest(cached=bool(seen)):
                got = mod.forge_results(cache, self.root / PATH, seen, counts)
                self.assertIsInstance(got, list, got)
                self.assertEqual(len(got), 1)
                self.assertEqual(got[0]["mutant"], "a >= lo || a <= hi")

    def test_multiline_fit_still_checks_line_span_and_original(self) -> None:
        mod = load()
        text = b"if (a >= lo\n    && a <= hi) {}\n"
        entry = {"span": {"lo": 4, "hi": 24}, "original": "a >= lo && a <= hi", "line_number": 1}
        for bad in (dict(entry, line_number=2), dict(entry, original="a > lo && a <= hi"),
                    dict(entry, span={"lo": -1, "hi": 24}), dict(entry, span={"lo": 4, "hi": len(text) + 1})):
            with self.subTest(entry=bad):
                self.assertFalse(mod.fits(bad, text))

    def test_skipped_mutants_are_run_and_killed(self) -> None:
        self.manifest()
        r = self.run_ticket(report(), FAKE_RESULTS=self.results(), FAKE_KILL="ids.length > 0|--i")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        planted = self.file_result()["planted"]
        self.assertEqual(sorted((p["original"], p["mutant"], p["result"]) for p in planted),
                         [("++i", "--i", "killed"), ("ids.length == 0", "ids.length > 0", "killed")])
        plain = [c for c in self.calls() if c["argv"][:1] == ["test"] and "--mutate" not in c["argv"]]
        self.assertEqual(len(plain), 3, "one baseline, then one run per skipped mutant")
        for c in plain:
            self.assertNotEqual(Path(c["cwd"]).resolve(), self.root.resolve(), "planted runs use a copy")
            self.assertFalse(Path(c["cwd"]).exists(), "the copy is removed at the end")
            argv = c["argv"]
            self.assertEqual(argv[argv.index("--match-path") + 1], "test/box-v2/hostile/**")
        self.assertEqual((self.root / PATH).read_text(), LIB, "the source is never written")
        self.assertIn("run here: 2 killed", r.stdout)

    def test_planted_survivor_is_alive_unless_argued(self) -> None:
        self.manifest()
        r = self.run_ticket(report(), FAKE_RESULTS=self.results(), FAKE_KILL="ids.length > 0")
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn("ALIVE src/box-v2/libraries/A.sol:5", r.stdout)
        self.assertIn("++i -> --i", r.stdout)
        (alive,) = self.file_result()["alive"]
        self.assertEqual((alive["mutant"], alive.get("runHere")), ("--i", True))
        self.manifest([R4, R5, row(LINE5, "++i", "--i")])
        r = self.run_ticket(report(), FAKE_RESULTS=self.results(), FAKE_KILL="ids.length > 0")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_old_span_rule_case_is_green_once_siblings_die(self) -> None:
        # Round 1's dry run on VaultFailure.sol: three argued rows, three skips, red with no way out but `span: all`.
        self.manifest()
        r = self.run_ticket(report(), FAKE_RESULTS=self.results(), FAKE_KILL="ids.length > 0|--i")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(self.file_result()["notGreen"], [])

    def test_skips_no_results_file_names_are_not_run(self) -> None:
        self.manifest()
        r = self.run_ticket(report())
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn("2 skipped mutant(s) not run", r.stdout)
        self.assertIn("results", self.file_result()["notGreen"][0])

    def test_results_that_disagree_with_the_summary_are_not_used(self) -> None:
        self.manifest()
        r = self.run_ticket(report(), FAKE_RESULTS=self.results(statuses=("Skipped", "Dead")), FAKE_KILL="x")
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn("2 skipped mutant(s) not run", r.stdout)

    def test_unknown_kind_is_not_run(self) -> None:
        self.manifest()
        odd = mutant(self.root, "ids.length == 0", {"Ternary": {"if_true": "x"}}, 4, "Skipped")
        r = self.run_ticket(report(skipped=3), FAKE_RESULTS=self.results(odd), FAKE_KILL="ids.length > 0|--i")
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn("Ternary", r.stdout)

    def test_cache_hit_reads_the_earlier_results(self) -> None:
        self.manifest()
        (self.root / "cache/mutation").mkdir(parents=True)
        (self.root / "cache/mutation/old.results").write_text(self.results())
        r = self.run_ticket(report(), FAKE_KILL="ids.length > 0|--i")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(len(self.file_result()["planted"]), 2)

    def test_results_of_another_text_are_not_used(self) -> None:
        self.manifest()
        (self.root / "cache/mutation").mkdir(parents=True)
        (self.root / "cache/mutation/old.results").write_text(self.results())
        (self.root / PATH).write_text("// moved down\n" + LIB)
        r = self.run_ticket(report(), FAKE_KILL="ids.length > 0|--i")
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn("2 skipped mutant(s) not run", r.stdout)

    def test_baseline_failing_in_the_copy_is_exit_3(self) -> None:
        self.manifest()
        r = self.run_ticket(report(), FAKE_RESULTS=self.results(), FAKE_BASELINE_FAIL="1")
        self.assertEqual(r.returncode, 3, r.stdout + r.stderr)
        self.assertIn("copy", r.stdout)

    def test_planted_run_past_the_timeout_is_red(self) -> None:
        self.manifest()
        r = self.run_ticket(report(), "--timeout", "2", FAKE_RESULTS=self.results(), FAKE_KILL="ids.length > 0",
                            FAKE_HANG="--i")
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn("1 mutant(s) timed out", r.stdout)

    def test_planted_crashes_exit_3(self) -> None:
        # R4 M2: this --i survives normally; a crash must never turn it into a killed mutant.
        self.manifest()
        for code, message in ((-9, ""), (101, "thread 'main' panicked: forge panic"),
                              (1, "Error: No space left on device"),
                              (-9, "[FAIL: partial output] test_mutant()"),
                              (101, "[FAIL: partial output] test_mutant()"),
                              (2, "1 failing test"), (-9, "Compiler run failed")):
            with self.subTest(code=code, message=message):
                r = self.run_ticket(report(), FAKE_RESULTS=self.results(), FAKE_KILL="ids.length > 0",
                                    FAKE_ON="--i", FAKE_EXIT=str(code), FAKE_STDERR=message)
                self.assertEqual(r.returncode, 3, r.stdout + r.stderr)
                self.assertEqual(json.loads(self.report.read_text())["exitCode"], 3)
                error = self.file_result()["error"]
                self.assertIn("planted", error)
                self.assertIn(str(code), error)
                self.assertIn("--i", error)
                self.assertNotIn("killed", {p["result"] for p in self.file_result()["planted"]})
                self.assertEqual((self.root / PATH).read_text(), LIB, "the source is never written")

    def test_planted_test_failures_and_compile_errors_are_classified(self) -> None:
        self.manifest()
        for stream in ("FAKE_STDOUT", "FAKE_STDERR"):
            for message, expected in (("[FAIL: assertion failed] test_mutant()", "killed"),
                                      ("Encountered 1 failing test", "killed"),
                                      ("Error: Compiler run failed", "invalid")):
                with self.subTest(stream=stream, message=message):
                    r = self.run_ticket(report(), FAKE_RESULTS=self.results(), FAKE_KILL="ids.length > 0",
                                        FAKE_ON="--i", FAKE_EXIT="1", **{stream: message})
                    self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
                    planted = next(p for p in self.file_result()["planted"] if p["mutant"] == "--i")
                    self.assertEqual(planted["result"], expected)

    def test_span_all_is_retired(self) -> None:
        self.manifest([dict(R4, span="all")])
        r = self.run_ticket(report())
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
        self.assertIn("retired", r.stderr)
        self.assertEqual(self.calls(), [])

    def test_plant_text_of_forges_kinds(self) -> None:
        m = load()
        cases = [(binary("a <= b"), "a <= b"), (unary("i++"), "i++"),
                 ({"RequireCondition": {"mutated_call": 'require(true, "x")'}}, 'require(true, "x")'),
                 ({"YulOpcode": {"original_opcode": "add", "new_opcode": "sub", "mutated_expr": "sub(a, 1)"}},
                  "sub(a, 1)"),
                 ({"Assignment": {"Literal": {"Bool": False}}}, "false"),
                 ({"Assignment": {"Literal": {"Number": "0x0"}}}, "0"),
                 ("DeleteExpression", "assert(true)"), ("ElimDelegate", "call")]
        for mutation, text in cases:
            self.assertEqual(m.plant_text(mutation), text, mutation)
        for odd in ({"Ternary": {"if_true": "x"}}, "Swap", {"Assignment": {"Identifier": "y"}}, None, {}):
            self.assertIsNone(m.plant_text(odd), odd)


class LowsTest(Fixture):
    """Lows 1 and 2: frozen rows pin the file; unplaced sources fail when strict; no FFI or other profile."""

    def test_frozen_row_without_sha256_is_refused(self) -> None:
        m = {"tickets": {"M1-31": {"tests": ["test/box-v2/m1-31/**"],
                                   "files": [{"path": PATH, "owner": "M1-00 (frozen)", "frozen": True}]}},
             "equivalents": [dict(R4, ticket="M1-31")]}
        (self.root / "m.json").write_text(json.dumps(m))
        mod = load()
        with self.assertRaises(mod.ManifestError) as e:
            mod.load_manifest(self.root / "m.json")
        self.assertIn("sha256", str(e.exception))

    def test_unplaced_source_fails_when_strict(self) -> None:
        (self.root / "src/box-v2/libraries/X.sol").write_text("pragma solidity 0.8.26;\n")
        self.manifest([])
        out = report([], skipped=0, killed=4)
        self.assertEqual(self.run_ticket(out).returncode, 0)
        for flags in (("--strict",), ("--scope", "v2")):
            r = self.run_ticket(out, *flags)
            self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
            self.assertIn("src/box-v2/libraries/X.sol", r.stdout + r.stderr)
        self.assertEqual(len([c for c in self.calls() if "--mutate" in c["argv"]]), 1, "strict runs stop first")

    def test_no_ffi_and_no_other_profile(self) -> None:
        self.manifest()
        r = self.run_ticket(report(), FAKE_RESULTS=self.results(), FAKE_KILL="ids.length > 0|--i",
                            FOUNDRY_FFI="true", FOUNDRY_PROFILE="rehearsal")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        for c in self.calls():
            self.assertEqual((c["ffi"], c["profile"]), ("false", None), c["argv"])


class ManifestRound2Test(unittest.TestCase):
    """Low 3 and finding 1 on the real manifest and workflow."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.m = json.loads(MANIFEST.read_text())
        cls.run_paths = {f["path"]: (t, f) for t, e in cls.m["tickets"].items() for f in e["files"]}

    def test_swap_module_args_run_with_m1_41(self) -> None:
        p = "src/box-v2/libraries/BoxSwapModuleV2Args.sol"
        ticket, f = self.run_paths[p]
        self.assertEqual((ticket, f["owner"]), ("M1-41", "M1-41-a"))
        self.assertIn("tipMaxQ", f["newFile"])
        self.assertIn(p, self.m["moneyPaths"]["legs"])
        self.assertNotIn(p, {n["path"] for n in self.m["notInRun"]})

    def test_args_rows_say_what_they_read(self) -> None:
        for n in self.m["notInRun"]:
            self.assertNotIn("no money arithmetic or check", n["why"], n["path"])
        why = {n["path"]: n["why"] for n in self.m["notInRun"]}
        for name, word in (("BoxCoordinatorV2Args", "raise"), ("BoxLaunchRouterV2Args", "bootstrapQ"),
                           ("BoxHookV2Args", "tipMaxQ"), ("BoxVaultV2Args", "pick fee")):
            self.assertIn(word, why[f"src/box-v2/libraries/{name}.sol"], name)

    def test_rows_argue_one_mutant(self) -> None:
        for e in self.m["equivalents"]:
            self.assertIn(e.get("span", "mutant"), ("mutant",), e)

    @unittest.skipIf(yaml is None, "PyYAML is not installed")
    def test_workflow_pins_the_manifests_forge_and_is_strict(self) -> None:
        assert yaml is not None
        text = WORKFLOW.read_text()
        data = yaml.safe_load(text)
        (job,) = data["jobs"].values()
        foundry = next(s for s in job["steps"] if s.get("uses", "").startswith("foundry-rs/foundry-toolchain@"))
        self.assertEqual(foundry["with"]["version"], "v" + self.m["forge"])
        run = next(s for s in job["steps"] if "mutation_v2.py" in s.get("run", ""))
        self.assertIn("--strict", run["run"])


if __name__ == "__main__":
    unittest.main()
