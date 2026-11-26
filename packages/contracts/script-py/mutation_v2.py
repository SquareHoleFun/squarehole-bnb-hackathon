#!/usr/bin/env python3
"""Core v2 money mutation campaigns.

Directed campaigns, from packages/contracts:
  python3 script-py/mutation_v2.py --m3 [--list] [--mutant <id> ...]
  python3 script-py/mutation_v2.py --m2 [--list] [--mutant <id> ...]
  python3 script-py/mutation_v2.py --cq11 [--list] [--mutant <id> ...]
M2 includes the inherited CQ11 faults; M3 reruns inherited faults on its changed money files.
Each campaign pins the integrated production implementation and its exact test selection.
Every directed mutant runs previously green tests on the default EVM and Amsterdam. M2/M3 may explicitly explain
a survivor in the pinned manifest and ticket evidence; it is reported as explained, never killed.
Builds, setup failures, skips, timeouts and absent tests never count as kills or explanations. Sources are hash-pinned;
only an isolated copy is edited. Artifacts are rebuilt for deployCode users. Fuzz runs default to 256, FFI is off,
and all scratch, stdout/stderr and report.json remain under .cache/m3-62 (M3), .cache/m2-62 (M2) or .cache/m1-62b (CQ11).
Exit 0 means all selected mutants were killed or explicitly explained; 1 means an unexplained survivor or unusable
test result, 2 bad configuration,
3 a build/baseline/source error. This is a directed campaign, not an exhaustive operator mutation score.

Historical pre-CQ11 automatic mode (M1-62 wave 1), retained for its existing callers and tests:

Each ticket M1-62 names is listed in script-py/mutation_v2.json with its money-path sources under src/box-v2/ and its
test folders. For each built source, forge's own mutation testing (`forge test --mutate`, the manifest's pinned
Foundry, checked with `forge --version` first) plants each mutant in a copy of the project, runs the ticket's tests and
reports the survivors. Its summary must be whole and add up, or the run is forge's error. A survivor fails the run
unless the manifest argues it equivalent: same file, source line (and its occurrence where the text repeats), original
and mutant, with a reason and its evidence file; a row may pin its file's sha256 (rows on frozen files must).

Skips: once a mutant of an expression survives, forge skips the other mutants of that expression and of the
expressions inside it ("adaptive"; no flag turns it off) and its report gives only their count. Forge's own results
file (cache/mutation/*.results) names each one with its byte span and text [V probes], so this script runs them
itself: in a copy of the project under its TMPDIR it puts each skipped mutant's text in place of its span and runs the
ticket's plain `forge test` there (once unmutated first, which must pass). A mutant that fails a test or does not
compile is killed; one that passes is a survivor like forge's (argued or alive); one past --timeout timed out. A file
is green when no survivor is alive, none timed out and every skipped mutant was run. A crash or unexplained
non-zero exit in a planted run is forge's error (exit 3), never a killed mutant.

Safety: this script never writes a source. Forge mutates copies in a temporary folder this script owns (TMPDIR), and
the planted runs use this script's own copy there; the folder is removed at the end, also on SIGINT or SIGTERM, which
stop forge's whole process group. Each source's sha256 is compared before and after its run; a changed one (someone
edited it meanwhile) fails the run and is left as it is. No network: fork tests are excluded (`excludeTests`), no
variable naming a fork or an RPC reaches forge, FOUNDRY_FFI is false, FOUNDRY_PROFILE is dropped (the default
profile), and no RPC, key, FFI or broadcast is passed. The artifacts the manifest names (the kit's PoolManager) must
be built first (`forge build`). script-py/mutation_smoke_b2.py is v1's separate tool.

Usage (from packages/contracts):
  python3 script-py/mutation_v2.py --list
  python3 script-py/mutation_v2.py --ticket M1-42 [--ticket M1-44 ...] [--scope ticket|v2] [--strict]
  python3 script-py/mutation_v2.py --changed-since <rev>      # the tickets whose sources or test folders changed
  python3 script-py/mutation_v2.py --file src/box-v2/<file>.sol --tests 'test/box-v2/<folder>/**'
Options: --jobs N (parallel mutants, default 4) · --timeout S (per mutant, default 1800) · --fuzz-runs N
         · --report <file.json> · --allow-pending (skip sources still missing or stubs)
         · --strict (a v2 source in neither the run nor notInRun fails; always so with --scope v2)
         · --root/--manifest/--forge
Exit: 0 no survivor left unargued and no mutant unrun · 1 a survivor, a timed-out mutant or a skipped one not run
      · 2 usage or manifest, or an unplaced v2 source under --strict or --scope v2
      · 3 forge failed (baseline, compile, no test, a report that does not add up, another version than the pin), an
        artifact is not built, the tests fail in the runner's copy, or a source changed
      · 4 a listed source is missing or still a stub · 130/143 stopped
"""
from __future__ import annotations

import sys

sys.dont_write_bytecode = True

import argparse  # noqa: E402
import hashlib  # noqa: E402
import json  # noqa: E402
import re  # noqa: E402
import os  # noqa: E402
import shutil  # noqa: E402
import signal  # noqa: E402
import subprocess  # noqa: E402
import tempfile  # noqa: E402
import time  # noqa: E402
import traceback  # noqa: E402
from datetime import datetime, timezone  # noqa: E402
from pathlib import Path  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "script-py" / "mutation_v2.json"
PREFIX = "packages/contracts/"
STUB_MARK = "revert NotBuilt()"
V2_TESTS = "test/box-v2/**"
DEFAULT_EXCLUDE = "{**/*Fork*.t.sol,test/box-v2/fork/**}"
DEFAULT_JOBS = 4
DEFAULT_TIMEOUT = 1800
EQUIVALENT_KEYS = ("ticket", "file", "line", "original", "mutant", "reason", "evidence")
SUMMARY_KEYS = ("total", "killed", "survived", "invalid", "skipped", "timed_out")
COVER_ROOT = "src/box-v2"
COVER_SKIP = ("src/box-v2/interfaces/", "src/box-v2/stubs/")
MUTATION_CACHE = "cache/mutation"  # foundry.toml's cache_path, then forge's folder for its mutation results
LINKED = ("lib", "node_modules")  # linked, not copied, into the planted runs' copy (as forge's own copies link lib/)
COMPILE_FAILED = "Compiler run failed"  # forge's message when a planted mutant does not compile [V probe]
# The text forge puts in place of a mutant's span, by the field of its kind [V probes on forge 1.8.3].
PLANT_FIELDS = {"BinaryOpExpr": "mutated_expr", "YulOpcode": "mutated_expr", "UnaryOperator": "new_expression",
                "RequireCondition": "mutated_call"}
PLANT_WHOLE = {"DeleteExpression": "assert(true)", "ElimDelegate": "call"}


class ForgeError(Exception):
    """Forge did not finish a mutation run (baseline, compile, no test, no report) or a source changed."""


class ManifestError(Exception):
    """The manifest or the command line names something that does not exist."""


class Interrupted(Exception):
    def __init__(self, signum: int) -> None:
        super().__init__(f"stopped by signal {signum}")
        self.code = 128 + signum


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def file_state(path: Path) -> str:
    """`missing`, `stub` (a wave-1 stub whose bodies still revert `NotBuilt()`) or `built`."""
    if not path.is_file():
        return "missing"
    return "stub" if STUB_MARK in path.read_text() else "built"


def uncovered(root: Path, m: dict) -> list[str]:
    """Each v2 source outside interfaces/ and stubs/ that is in no ticket's files and not in `notInRun`."""
    listed = {f["path"] for e in m.get("tickets", {}).values() for f in e.get("files", [])}
    listed |= {n.get("path") for n in m.get("notInRun", [])}
    base = root / COVER_ROOT
    found = sorted(p.relative_to(root).as_posix() for p in base.rglob("*.sol")) if base.is_dir() else []
    return [p for p in found if not p.startswith(COVER_SKIP) and p not in listed]


def warn_uncovered(paths: list[str]) -> None:
    for p in paths:
        print(f"WARNING {p}: in no ticket's files and not in notInRun (add it to one, with why)")


def forge_env(tmp: Path, fuzz_runs: int | None) -> dict:
    """The caller's environment without any variable naming a fork or an RPC (SH_FORK_*, MAINNET_FORK_RPC_URL,
    FOUNDRY_ETH_RPC_URL, ETH_RPC_URL, FOUNDRY_FORK_*, ...), so no test can opt in to a network; FFI off and the
    default profile (another profile builds with other remappings into another out folder)."""
    env = {k: v for k, v in os.environ.items()
           if "FORK" not in k.upper() and "RPC" not in k.upper() and k != "FOUNDRY_PROFILE"}
    env["FOUNDRY_FFI"] = "false"
    env["TMPDIR"] = str(tmp)
    if fuzz_runs:
        env["FOUNDRY_FUZZ_RUNS"] = str(fuzz_runs)
    return env


def version_in(text: str) -> str | None:
    """The X.Y.Z of `forge --version` (`forge Version: 1.8.3` on 1.8.3 [V]; `forge 0.2.0 (...)` on older ones)."""
    found = re.search(r"(?:Version:|^forge)\s*v?(\d+\.\d+\.\d+)", text, re.MULTILINE)
    return found.group(1) if found else None


def forge_version(forge: str) -> str | None:
    try:
        r = subprocess.run([forge, "--version"], capture_output=True, text=True, timeout=120,
                           env=forge_env(Path(tempfile.gettempdir()), None))
    except (OSError, subprocess.TimeoutExpired):
        return None
    return version_in(r.stdout) if r.returncode == 0 else None


def match_glob(globs: list[str]) -> str:
    return globs[0] if len(globs) == 1 else "{" + ",".join(globs) + "}"


def forge_command(forge: str, path: str, match: str, exclude: str, jobs: int, timeout: int) -> list[str]:
    return [forge, "test", "--mutate", path, "--match-path", match, "--no-match-path", exclude, "--json",
            "--mutation-jobs", str(jobs), "--mutation-timeout", str(timeout)]


def parse_forge_json(text: str) -> dict:
    """Forge's `--json` mutation report: the summary and each survivor with its file. The summary must hold the six
    counts as whole numbers, list as many survivors as it counts, and add up (total = killed + survived + invalid +
    skipped + timed out, as in every recorded run [V]); otherwise forge's report changed shape and nothing is read."""
    lines = [x for x in text.splitlines() if x.startswith("{")]
    data = None
    for candidate in (text.strip(), lines[-1] if lines else ""):
        try:
            data = json.loads(candidate)
            break
        except json.JSONDecodeError:
            continue
    if data is None:
        raise ForgeError("forge printed no JSON report")
    if not isinstance(data, dict) or not isinstance(data.get("summary"), dict):
        raise ForgeError("forge's report has no summary")
    try:
        survivors = [{"file": f, "line": int(s["line"]), "column": int(s["column"]), "original": s["original"],
                      "mutant": s["mutant"]}
                     for f, items in (data.get("survived_mutants") or {}).items() for s in items]
    except (KeyError, TypeError, ValueError, AttributeError):
        raise ForgeError("forge's report has a survivor without line, column, original or mutant") from None
    s = data["summary"]
    bad = [k for k in SUMMARY_KEYS if type(s.get(k)) is not int or s[k] < 0]
    if bad:
        raise ForgeError(f"forge's summary has no whole-number {', '.join(bad)} (did forge's report change shape?)")
    if s["survived"] != len(survivors):
        raise ForgeError(f"forge's summary counts {s['survived']} survived, its report lists {len(survivors)}")
    parts = sum(s[k] for k in SUMMARY_KEYS[1:])
    if s["total"] != parts:
        raise ForgeError(f"forge's summary does not add up: total {s['total']}, killed + survived + invalid + "
                         f"skipped + timed out = {parts}")
    return {"summary": s, "survivors": survivors}


def kind_of(mutation: object) -> str:
    if isinstance(mutation, str):
        return mutation
    return str(next(iter(mutation), "?")) if isinstance(mutation, dict) else repr(mutation)


def plant_text(mutation: object) -> str | None:
    """The text forge puts in place of a mutant's span, for the kinds forge 1.8.3 wrote in the probes; None for any
    other (such a mutant cannot be run here, so its file is not green)."""
    if isinstance(mutation, str):
        return PLANT_WHOLE.get(mutation)
    if not isinstance(mutation, dict) or len(mutation) != 1:
        return None
    ((kind, value),) = mutation.items()
    if not isinstance(value, dict):
        return None
    if kind in PLANT_FIELDS:
        text = value.get(PLANT_FIELDS[kind])
        return text if isinstance(text, str) and text else None
    literal = value.get("Literal") if kind == "Assignment" and len(value) == 1 else None
    if isinstance(literal, dict) and len(literal) == 1:
        ((lit, v),) = literal.items()
        if lit == "Bool" and isinstance(v, bool):
            return "true" if v else "false"
        if lit == "Number" and isinstance(v, str):
            try:
                return str(int(v, 16))  # forge writes "0x0" and shows "0"
            except ValueError:
                return None
    return None


def stamps(cache: Path) -> dict[str, tuple[int, int]]:
    out = {}
    for p in cache.glob("*.results") if cache.is_dir() else []:
        try:
            st = p.stat()
        except OSError:
            continue
        out[p.name] = (st.st_mtime_ns, st.st_size)
    return out


def fits(m: dict, text: bytes) -> bool:
    """A results entry belongs to this text: its span lies on its line, inside its whitespace-collapsed original."""
    lo, hi = m["span"]["lo"], m["span"]["hi"]
    return (type(lo) is int and type(hi) is int and 0 <= lo < hi <= len(text)
            and " ".join(text[lo:hi].decode(errors="replace").split()) in " ".join(m["original"].split())
            and text[:lo].count(b"\n") + 1 == m["line_number"])


def forge_results(cache: Path, src: Path, seen: dict, summary: dict) -> list[dict] | str:
    """The mutants forge skipped in this run, from its results file: forge writes one per run under cache/mutation
    with every mutant's byte span, text, line and status (Dead, Alive, Invalid, Skipped) [V probes: 5 of 5 runs]. The
    file written during the run is the one; if forge wrote none (it served its cache), every earlier file of this
    source whose entries fit its text and whose counts match the summary (their union: a superset is safe). A string
    says why the skipped mutants cannot be named."""
    target, text = os.path.realpath(src), src.read_bytes()
    fresh, earlier = [], []
    for name, stamp in sorted(stamps(cache).items()):
        new = seen.get(name) != stamp
        try:
            data = json.loads((cache / name).read_text())
            rows = data["results"]
            if not rows or any(os.path.realpath(m["path"]) != target for m, _ in rows):
                continue
            skipped = [m for m, status in rows if status == "Skipped"]
            ok = (data.get("mutant_count") == summary["total"] and len(skipped) == summary["skipped"]
                  and all(fits(m, text) for m, _ in rows))
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            if new:  # this run's file, unreadable: never fall back to older ones
                fresh.append((False, []))
            continue
        (fresh if new else earlier).append((ok, skipped))
    chosen = [skipped for ok, skipped in (fresh or earlier) if ok]
    if not chosen:
        why = "does not match its summary or its source" if fresh or earlier else "was not found"
        return f"forge's results file for this run ({MUTATION_CACHE}/*.results) {why}"
    out, keys = [], set()
    for skipped in chosen:
        for m in skipped:
            text_in = plant_text(m.get("mutation"))
            if text_in is None:
                return (f"forge's mutation kind {kind_of(m.get('mutation'))} (line {m.get('line_number')}) is not one "
                        "this script can plant")
            key = (m["span"]["lo"], m["span"]["hi"], text_in)
            if key not in keys:
                keys.add(key)
                out.append({"line": m["line_number"], "column": m.get("column_number", 0), "original": m["original"],
                            "mutant": text_in, "lo": key[0], "hi": key[1], "kind": kind_of(m["mutation"])})
    return out


def own_paths(survivors: list[dict], path: str) -> list[dict]:
    """One source is mutated per call, so every survivor is that source's. Forge keys them by a path relative to a
    root of its own (`contracts/src/...` from packages/contracts) [V: the dry run]; keep forge's key beside ours."""
    return [dict(s, file=path) if s["file"] == path else dict(s, file=path, forgeFile=s["file"]) for s in survivors]


def source(root: Path, rel: str) -> tuple[list[str], str]:
    """A source's stripped lines and its sha256 (none and "" if it cannot be read)."""
    try:
        data = (root / rel).read_bytes()
    except OSError:
        return [], ""
    return [x.strip() for x in data.decode(errors="replace").splitlines()], hashlib.sha256(data).hexdigest()


def row_fits(e: dict, digest: str, twins: int, occurrence: int) -> str | None:
    """None if row `e` argues the survivor whose line text it matches, else why not."""
    if e.get("sha256") and e["sha256"] != digest:
        return f"its row pins sha256 {e['sha256'][:12]}, the file is {digest[:12]} now: re-argue it"
    if twins > 1 and e.get("occurrence") != occurrence:
        return (f"its line text occurs {twins} times; this is occurrence {occurrence}, "
                f"the row names {e.get('occurrence', 'none')}")
    return None


def classify(survivors: list[dict], equivalents: list[dict], root: Path) -> tuple[list, list, list]:
    """Split survivors into alive and argued equivalent; equivalents no survivor matched are stale."""
    alive, argued, used, files = [], [], set(), {}
    for s in survivors:
        lines, digest = files.setdefault(s["file"], source(root, s["file"]))
        text = lines[s["line"] - 1] if 0 < s["line"] <= len(lines) else ""
        twins, occurrence = lines.count(text), lines[:s["line"]].count(text)
        s, hit = dict(s, text=text), None
        for i, e in enumerate(equivalents):
            if (e["file"], e["original"], e["mutant"]) != (s["file"], s["original"], s["mutant"]) \
                    or e["line"].strip() != text:
                continue
            why = row_fits(e, digest, twins, occurrence)
            if why is None:
                hit = i
                break
            s["note"] = why
        if hit is None:
            alive.append(s)
        else:
            used.add(hit)
            e = equivalents[hit]
            argued.append(dict(s, reason=e["reason"], evidence=e["evidence"]))
    return alive, argued, [e for i, e in enumerate(equivalents) if i not in used]


def not_green(r: dict) -> list[str]:
    """Why a built source's run is not green (empty when it is): a survivor alive, a mutant timed out (forge's or a
    planted run's), or a mutant forge skipped that was not run here."""
    s, out = r["summary"], []
    planted = r.get("planted") or []
    if r["alive"]:
        out.append(f"{len(r['alive'])} survivor(s) alive")
    late = s.get("timed_out", 0) + sum(1 for p in planted if p.get("result") == "timed out")
    if late:
        out.append(f"{late} mutant(s) timed out")
    unrun = s.get("skipped", 0) - len(planted)
    if unrun > 0:
        out.append(f"{unrun} skipped mutant(s) not run" + (f": {r['unrun']}" if r.get("unrun") else ""))
    return out


def exit_code(results: list[dict]) -> int:
    if not results:
        return 2
    codes = set()
    for r in results:
        if r.get("error"):
            codes.add(3)
        elif r["state"] != "built":
            codes.add(0 if r.get("skipped") else 4)
        elif not_green(r):
            codes.add(1)
    return next((c for c in (3, 1, 4) if c in codes), 0)


def tickets_for_changes(manifest: dict, changed: list[str]) -> list[str]:
    """The tickets whose sources or test folders a list of repository paths touches; all if the runner changed."""
    rel = [p[len(PREFIX):] for p in changed if p.startswith(PREFIX)]
    shared = tuple(manifest.get("sharedPaths", []))
    if any(p.startswith("script-py/mutation_v2.") or p.startswith(shared) for p in rel):
        return list(manifest["tickets"])
    out = []
    for ticket, entry in manifest["tickets"].items():
        files = {f["path"] for f in entry["files"]}
        folders = [g[:-2] for g in entry["tests"]]
        if any(p in files or any(p.startswith(d) for d in folders) for p in rel):
            out.append(ticket)
    return out


def load_manifest(path: Path) -> dict:
    try:
        m = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as e:
        raise ManifestError(f"{path}: {e}") from None
    for ticket, entry in m.get("tickets", {}).items():
        if not entry.get("tests") or not all(g.endswith("/**") for g in entry["tests"]):
            raise ManifestError(f"{ticket}: tests must be folders ending in /**")
        if not all(f.get("path", "").startswith("src/") for f in entry.get("files", [])):
            raise ManifestError(f"{ticket}: every file needs a path under src/")
    frozen = {f.get("path") for e in m.get("tickets", {}).values() for f in e.get("files", []) if f.get("frozen")}
    for e in m.get("equivalents", []):
        if any(not e.get(k) for k in EQUIVALENT_KEYS):
            raise ManifestError(f"equivalent mutant without {', '.join(k for k in EQUIVALENT_KEYS if not e.get(k))}")
        if e.get("span", "mutant") != "mutant":
            raise ManifestError(f"{e['file']}: span {e['span']!r} is retired (review round 2): the runner runs every "
                                "mutant forge skips, so each row argues one mutant")
        if "occurrence" in e and (type(e["occurrence"]) is not int or e["occurrence"] < 1):
            raise ManifestError(f"{e['file']}: occurrence must be a positive whole number")
        if "sha256" in e and not re.fullmatch(r"[0-9a-f]{64}", str(e["sha256"])):
            raise ManifestError(f"{e['file']}: sha256 must be 64 lowercase hex digits")
        if e["file"] in frozen and "sha256" not in e:
            raise ManifestError(f"{e['file']}: a row on a frozen file pins the file's sha256")
    return m


class Runner:
    """Runs forge once per source, in its own process group, with TMPDIR in a folder it removes."""

    def __init__(self, args: argparse.Namespace, root: Path, exclude: str) -> None:
        self.args, self.root, self.exclude = args, root, exclude
        self.tmp = Path(tempfile.mkdtemp(prefix="sh-mutation-v2-"))
        self.proc: subprocess.Popen | None = None
        self.ws: Path | None = None
        self.passed: set[str] = set()

    def close(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _stop(self) -> None:
        if self.proc is not None and self.proc.poll() is None:
            for sig, wait in ((signal.SIGTERM, 10), (signal.SIGKILL, 10)):
                try:
                    os.killpg(self.proc.pid, sig)
                    self.proc.wait(timeout=wait)
                    break
                except ProcessLookupError:
                    break
                except subprocess.TimeoutExpired:
                    continue

    def _call(self, cmd: list[str], cwd: Path, timeout: int | None = None) -> tuple[int | None, str, str]:
        """Forge in its own process group; the code is None when it ran past `timeout` and was stopped."""
        try:
            self.proc = subprocess.Popen(cmd, cwd=cwd, env=forge_env(self.tmp, self.args.fuzz_runs),
                                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                         start_new_session=True)
            try:
                out, err = self.proc.communicate(timeout=timeout)
            except subprocess.TimeoutExpired:
                self._stop()
                out, err = self.proc.communicate()
                return None, out, err
            return self.proc.returncode, out, err
        finally:
            self._stop()
            self.proc = None

    def forge(self, path: str, match: str) -> dict:
        src = self.root / path
        before = hashlib.sha256(src.read_bytes()).hexdigest()
        cache = self.root / MUTATION_CACHE
        seen = stamps(cache)
        cmd = forge_command(self.args.forge, path, match, self.exclude, self.args.jobs, self.args.timeout)
        try:
            code, out, err = self._call(cmd, self.root)
        finally:
            after = hashlib.sha256(src.read_bytes()).hexdigest() if src.is_file() else "missing"
        if after != before:
            raise ForgeError(f"{path} changed during the run (sha256 {before[:12]} before, {after[:12]} after); "
                             "not written back: forge never writes sources, so check who changed it, then rerun")
        if code != 0:
            said = [x.strip() for x in err.splitlines() if x.strip()]
            errors = [x for x in said if x.startswith("Error")] or said[-3:] or [f"forge exited {code}"]
            hint = ""
            if "baseline" in err:  # forge names its compiler profile even when a plain test fails
                hint = f" / to see the failing test: forge test --match-path '{match}' --no-match-path '{self.exclude}'"
            raise ForgeError(" / ".join(errors[-3:]) + hint)
        got = parse_forge_json(out)
        got["skipped"] = forge_results(cache, src, seen, got["summary"]) if got["summary"]["skipped"] else []
        return got

    def workspace(self) -> Path:
        """The planted runs' copy of the project, made once per run: lib/ and node_modules/ linked, cache/ without
        forge's mutation results, everything else copied (forge's own mutation copies also link lib/ [V])."""
        if self.ws is None:
            ws = self.tmp / "workspace"
            ws.mkdir()
            for p in sorted(self.root.iterdir()):
                if p.name == ".git":
                    continue
                if p.name in LINKED:
                    (ws / p.name).symlink_to(p.resolve())
                elif p.is_dir() and not p.is_symlink():
                    skip = shutil.ignore_patterns("mutation") if p.name == "cache" else None
                    shutil.copytree(p, ws / p.name, symlinks=True, ignore=skip)
                else:
                    shutil.copy2(p, ws / p.name, follow_symlinks=False)
            self.ws = ws
        return self.ws

    def plain(self, match: str) -> list[str]:
        return [self.args.forge, "test", "--match-path", match, "--no-match-path", self.exclude]

    def plant(self, path: str, match: str, mutants: list[dict]) -> list[dict]:
        """Runs each mutant forge skipped: its text in place of its span in the copy, then the ticket's plain tests
        there. killed: a test failed; invalid: it did not compile; survived: they passed; timed out: past --timeout.
        A signal, abnormal exit or exit 1 without a test/compile failure is a ForgeError."""
        ws = self.workspace()
        if match not in self.passed:
            code, out, err = self._call(self.plain(match), ws)
            if code != 0:
                said = [x.strip() for x in (out + err).splitlines() if x.strip()][-3:]
                raise ForgeError("the ticket's tests fail in the runner's copy of the project before any mutant is "
                                 f"planted, so no planted run could count: {' / '.join(said)}")
            self.passed.add(match)
        original, copy = (self.root / path).read_bytes(), ws / path
        if not copy.is_file() or copy.read_bytes() != original:
            raise ForgeError(f"{path}: the runner's copy of the project differs from the source")
        done = []
        for m in mutants:
            start = time.monotonic()
            print(f"    running skipped {path}:{m['line']}  {m['original']} -> {m['mutant']}", flush=True)
            copy.write_bytes(original[:m["lo"]] + m["mutant"].encode() + original[m["hi"]:])
            try:
                code, out, err = self._call(self.plain(match), ws, self.args.timeout)
            finally:
                copy.write_bytes(original)
            output = out + err
            if code is None:
                result = "timed out"
            elif code == 0:
                result = "survived"
            elif code == 1 and COMPILE_FAILED in output:
                result = "invalid"
            elif code == 1 and ("[FAIL" in output or "failing test" in output):
                result = "killed"
            else:
                said = [x.strip() for x in output.splitlines() if x.strip()][-3:]
                raise ForgeError(f"planted {path}:{m['line']} {m['original']} -> {m['mutant']}: "
                                 f"forge exited {code} without a completed test or compile failure: {' / '.join(said)}")
            done.append(dict(m, result=result, seconds=round(time.monotonic() - start)))
        return done

    def run_file(self, ticket: str, path: str, match: str, equivalents: list[dict]) -> dict:
        state = file_state(self.root / path)
        r = {"ticket": ticket, "path": path, "state": state, "skipped": False, "summary": None, "alive": [],
             "equivalent": [], "stale": [], "planted": [], "unrun": None, "notGreen": [], "error": None, "seconds": 0}
        if state != "built":
            r["skipped"] = self.args.allow_pending
            print(f"  {path}: {state}" + (" (skipped: --allow-pending)" if r["skipped"] else " (not built)"))
            return r
        start = time.monotonic()
        print(f"  {path}: forge running from {utc_now()}", flush=True)
        try:
            got = self.forge(path, match)
            found = got["skipped"]
            r["unrun"] = found if isinstance(found, str) else None
            r["planted"] = self.plant(path, match, found) if isinstance(found, list) and found else []
        except ForgeError as e:
            r["error"] = str(e)
            print(f"  {path}: forge failed: {e}")
            return r
        finally:
            r["seconds"] = round(time.monotonic() - start)
        grown = [{"file": path, "line": p["line"], "column": p["column"], "original": p["original"],
                  "mutant": p["mutant"], "runHere": True} for p in r["planted"] if p["result"] == "survived"]
        mine = [e for e in equivalents if e["file"] == path]
        r["alive"], r["equivalent"], r["stale"] = classify(own_paths(got["survivors"], path) + grown, mine, self.root)
        r["summary"] = s = got["summary"]
        r["notGreen"] = not_green(r)
        tally = {k: sum(1 for p in r["planted"] if p["result"] == k)
                 for k in ("killed", "invalid", "survived", "timed out")}
        here = f" (run here: {', '.join(f'{n} {k}' for k, n in tally.items())})" if r["planted"] else ""
        print(f"  {path}  built  mutants {s['total']}: killed {s['killed']}, survived {s['survived']} "
              f"({len(r['equivalent'])} argued equivalent), invalid {s['invalid']}, skipped {s['skipped']}{here}, "
              f"timed out {s['timed_out']}  [{r['seconds']} s]")
        for a in r["alive"]:
            note = f"  ({a['note']})" if a.get("note") else ""
            note += "  (skipped by forge, run here)" if a.get("runHere") else ""
            print(f"    ALIVE {a['file']}:{a['line']}:{a['column']}  {a['original']} -> {a['mutant']}  "
                  f"| {a['text']}{note}")
        for a in r["equivalent"]:
            print(f"    equivalent {a['file']}:{a['line']}  {a['original']} -> {a['mutant']}  ({a['evidence']})"
                  + ("  (skipped by forge, run here)" if a.get("runHere") else ""))
        for e in r["stale"]:
            print(f"    stale equivalent (no such survivor now): {e['file']}  {e['original']} -> {e['mutant']}")
        for why in r["notGreen"]:
            print(f"    NOT GREEN: {why}")
        return r


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Core v2 per-ticket mutation runs (M1-62).")
    what = p.add_mutually_exclusive_group(required=True)
    what.add_argument("--list", action="store_true", help="list tickets, sources and their state; run nothing")
    what.add_argument("--ticket", action="append", help="a ticket of the manifest (repeatable)")
    what.add_argument("--changed-since", metavar="REV", help="run the tickets whose files changed since REV")
    what.add_argument("--file", help="mutate one source (with --tests)")
    p.add_argument("--tests", action="append", help="with --file: a test folder glob (repeatable)")
    p.add_argument("--scope", choices=("ticket", "v2"), default="ticket",
                   help="ticket: the ticket's test folders; v2: every test under test/box-v2 (wave 3's aggregate)")
    p.add_argument("--strict", action="store_true",
                   help="fail (exit 2) when a v2 source is in neither the run nor notInRun (always with --scope v2)")
    p.add_argument("--jobs", type=int, default=DEFAULT_JOBS)
    p.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT, help="seconds per mutant")
    p.add_argument("--fuzz-runs", type=int, help="FOUNDRY_FUZZ_RUNS for the runs (default: foundry.toml's)")
    p.add_argument("--allow-pending", action="store_true", help="skip sources still missing or stubs")
    p.add_argument("--report", type=Path, help="write the results as JSON")
    p.add_argument("--root", type=Path, default=ROOT, help=argparse.SUPPRESS)
    p.add_argument("--manifest", type=Path, default=MANIFEST, help=argparse.SUPPRESS)
    p.add_argument("--forge", default=shutil.which("forge") or "forge",
                   help=argparse.SUPPRESS)
    args = p.parse_args(argv)
    if args.file and not args.tests:
        p.error("--file needs --tests")
    if args.jobs < 1 or args.timeout < 1:
        p.error("--jobs and --timeout must be positive")
    return args


def plan(args: argparse.Namespace, m: dict) -> list[tuple[str, list[str], list[str]]]:
    """(ticket, sources, test globs) for each run asked."""
    if args.file:
        return [("(file)", [args.file], args.tests)]
    if args.changed_since:
        diff = subprocess.run(["git", "-C", str(args.root), "diff", "--name-only", f"{args.changed_since}...HEAD"],
                              capture_output=True, text=True)
        if diff.returncode != 0:
            raise ManifestError(f"git diff {args.changed_since}...HEAD: {diff.stderr.strip()}")
        tickets = tickets_for_changes(m, diff.stdout.split())
    else:
        tickets = args.ticket
    out = []
    for t in tickets:
        if t not in m.get("tickets", {}):
            raise ManifestError(f"unknown ticket {t} (known: {', '.join(m.get('tickets', {}))})")
        entry = m["tickets"][t]
        out.append((t, [f["path"] for f in entry["files"]], entry["tests"]))
    return out


def write_report(path: Path | None, args: argparse.Namespace, started: str, tickets: list[dict], code: int | None,
                 missing: list[str]) -> None:
    """The report so far: written after each source (`exitCode` null) and at the end."""
    if path is None:
        return
    head = subprocess.run(["git", "-C", str(args.root), "rev-parse", "HEAD"], capture_output=True, text=True)
    report = {"tool": "script-py/mutation_v2.py", "commit": head.stdout.strip() or None, "started": started,
              "finished": utc_now() if code is not None else None, "forge": getattr(args, "forge_version", None),
              "scope": args.scope, "jobs": args.jobs, "timeoutSeconds": args.timeout, "fuzzRuns": args.fuzz_runs,
              "uncovered": missing, "tickets": tickets, "exitCode": code}
    tmp = path.with_name(path.name + ".part")
    tmp.write_text(json.dumps(report, indent=2) + "\n")
    tmp.replace(path)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    try:
        m = load_manifest(args.manifest) if args.manifest.exists() or not args.file else {}
        missing = uncovered(args.root, m) if m.get("tickets") else []
        if args.list:
            for t, entry in m["tickets"].items():
                print(f"{t}  tests {match_glob(entry['tests'])}")
                for f in entry["files"]:
                    print(f"  {f['path']}  {file_state(args.root / f['path'])}")
            warn_uncovered(missing)
            return 0
        runs = plan(args, m)
    except ManifestError as e:
        print(f"mutation_v2: {e}", file=sys.stderr)
        return 2
    if not runs:
        print("no ticket's sources or test folders changed")
        return 0
    warn_uncovered(missing)
    started = utc_now()
    if missing and (args.strict or args.scope == "v2"):
        print(f"mutation_v2: {', '.join(missing)}: in no ticket's files and not in notInRun (--strict and --scope v2 "
              "fail on it; add each to one, with why)", file=sys.stderr)
        write_report(args.report, args, started, [], 2, missing)
        return 2
    built = any(file_state(args.root / p) == "built" for _, files, _ in runs for p in files)
    unbuilt = [a for a in m.get("artifacts", []) if built and not (args.root / a).is_file()]
    if unbuilt:
        print(f"mutation_v2: {', '.join(unbuilt)} not built: run `forge build` in packages/contracts first (the "
              "M1-03 kit loads the PoolManager from its artifact, and a filtered run never compiles it)",
              file=sys.stderr)
        write_report(args.report, args, started, [], 3, missing)
        return 3
    if built and m.get("forge"):
        args.forge_version = forge_version(args.forge)
        if args.forge_version != m["forge"]:
            print(f"mutation_v2: {args.forge} is forge {args.forge_version or '(no version read)'}; the manifest pins "
                  f"{m['forge']} (\"forge\" in script-py/mutation_v2.json): install that one (foundryup --install "
                  f"v{m['forge']}), or move the pin in its own reviewed change", file=sys.stderr)
            write_report(args.report, args, started, [], 3, missing)
            return 3

    def stop(signum: int, _frame: object) -> None:
        raise Interrupted(signum)

    old = {s: signal.signal(s, stop) for s in (signal.SIGINT, signal.SIGTERM)}
    done, results = [], []
    runner = Runner(args, args.root, m.get("excludeTests", DEFAULT_EXCLUDE))
    try:
        for ticket, files, tests in runs:
            match = V2_TESTS if args.scope == "v2" else match_glob(tests)
            print(f"{ticket}  tests {match}  (scope {args.scope}, jobs {args.jobs}, timeout {args.timeout} s)",
                  flush=True)
            entry = {"ticket": ticket, "tests": match, "files": []}
            done.append(entry)
            for path in files:
                r = runner.run_file(ticket, path, match, m.get("equivalents", []))
                entry["files"].append(r)
                results.append(r)
                write_report(args.report, args, started, done, None, missing)
                sys.stdout.flush()
        code = exit_code(results)
    except Interrupted as e:
        print(f"mutation_v2: {e}; forge stopped, sources unchanged", file=sys.stderr)
        code = e.code
    except Exception:  # an internal error must not read as a survivor's exit 1
        traceback.print_exc()
        code = 3
    finally:
        runner.close()
        for s, h in old.items():
            signal.signal(s, h)
    alive = sum(len(r["alive"]) for r in results)
    red = sum(1 for r in results if r["notGreen"])
    print(f"verdict: exit {code} ({alive} survivor(s) alive, {red} of {len(results)} source(s) not green)")
    write_report(args.report, args, started, done, code, missing)
    return code


def cq11_plant(original: bytes, row: dict) -> bytes:
    """One reviewed edit on the pinned production file, never an edit to an oracle or a mock."""
    if hashlib.sha256(original).hexdigest() != row["sha256"]:
        raise ManifestError("mutation source hash changed; review and repin the mutant")
    before, after = row["before"].encode(), row["after"].encode()
    if not before or before == after or original.count(before) != 1:
        raise ManifestError("mutation needs one unique, nonempty anchor and a different replacement")
    return original.replace(before, after, 1)


def cq11_manifest(root: Path, path: Path, campaign: str = "cq11") -> dict:
    """Validate a directed campaign independently of the historical automatic runs."""
    if campaign not in ("cq11", "m2", "m3"):
        raise ManifestError("unknown directed campaign")
    config = json.loads(path.read_text()).get(campaign)
    if not isinstance(config, dict) or not config.get("mutants"):
        raise ManifestError(f"no {campaign} campaign in the manifest")
    seen = set()
    for row in config["mutants"]:
        if not re.fullmatch(r"[a-z0-9-]+", row["id"]) or row["id"] in seen:
            raise ManifestError("mutant ids must be unique lowercase names")
        seen.add(row["id"])
        for key, prefix, suffix in (("file", "src/box-v2/", ".sol"),
                                    ("testFile", f"test/box-v2/{'m1-62' if campaign == 'cq11' else campaign + '-62'}/", ".t.sol")):
            rel = Path(row[key])
            if (not row[key].startswith(prefix) or not row[key].endswith(suffix)
                    or ".." in rel.parts or not (root / rel).is_file()
                    or (root / rel).resolve() != root.resolve() / rel):
                raise ManifestError(f"invalid {key}: {row[key]}")
        if "/interfaces/" in row["file"] or "/stubs/" in row["file"]:
            raise ManifestError("CQ11 mutates production implementations only; shapes stay frozen")
        if not row.get("requirement") or not re.fullmatch(r"[A-Za-z0-9]+", row["contract"]):
            raise ManifestError("each mutant needs a requirement and exact test contract")
        if "survivorExplanation" in row or "survivorEvidence" in row:
            reason = row.get("survivorExplanation")
            if (campaign not in ("m2", "m3") or not isinstance(reason, str) or len(reason.strip()) < 80
                    or row.get("survivorEvidence") != f"docs/evidence/SH-V2-{campaign.upper()}-62.md"):
                raise ManifestError("survivor explanations need a substantive reason and the ticket evidence")
        cq11_plant((root / row["file"]).read_bytes(), row)
    return config


def cq11_results(code: int | None, output: str) -> dict:
    if code not in (0, 1):
        raise ForgeError("forge did not finish a test run")
    try:
        data = json.loads(output)
        results = {}
        for suite, value in data.items():
            for name, result in value["test_results"].items():
                if not name.startswith("test") or result["status"] not in ("Success", "Failure"):
                    raise ForgeError("setup failure, skipped test or unknown test status")
                results[f"{suite}::{name}"] = result["status"]
    except (ValueError, TypeError, KeyError, AttributeError):
        raise ForgeError("forge returned no complete test JSON") from None
    if not results or (code == 0) != all(s == "Success" for s in results.values()):
        raise ForgeError("no tests or inconsistent forge exit/status")
    return results


def cq11_tests(code: int | None, output: str) -> dict:
    tests = cq11_results(code, output)
    if any(s != "Success" for s in tests.values()):
        raise ForgeError("unmutated baseline must pass every selected test")
    return tests


def cq11_verdict(code: int | None, output: str, baseline: dict,
                 explanation: str | None = None) -> tuple[str, list[str]]:
    try:
        tests = cq11_results(code, output)
        if tests.keys() != baseline.keys():
            raise ForgeError("mutant did not execute exactly the baseline tests")
    except ForgeError as exc:
        return "error", [str(exc)]
    killed_by = sorted(name for name, status in tests.items() if status == "Failure")
    if not killed_by and explanation:
        return "explained", [explanation]
    return ("killed" if killed_by else "survived"), killed_by


class CQ11Runner(Runner):
    """Retained, isolated scratch copy. No production file is ever planted or restored in place.

    Unlike the historical automatic runner, no directory is deleted, even on interruption.
    A build precedes each mutant's tests: deployCode/etch users must see the mutated artifact too.
    """

    def __init__(self, args: argparse.Namespace) -> None:
        self.args, self.root = args, args.root
        args.scratch.mkdir(parents=True, exist_ok=True)
        self.tmp = Path(tempfile.mkdtemp(prefix="cq11-", dir=args.scratch)).resolve()
        self.ws = self.tmp / "workspace"
        self.ws.mkdir()
        self.proc = None

    def close(self) -> None:
        self._stop()

    def copy(self) -> None:
        for name in ("src", "test", "script", "script-py", "out", "cache"):
            path = self.root / name
            if path.is_dir():
                shutil.copytree(path, self.ws / name, symlinks=True,
                                ignore=shutil.ignore_patterns("mutation", "__pycache__"))
        for name in ("foundry.toml", "size-budget.v2.json"):
            shutil.copy2(self.root / name, self.ws / name)
        (self.ws / "lib").symlink_to((self.root / "lib").resolve(), target_is_directory=True)

    def call(self, command: list[str], label: str) -> tuple[int | None, str]:
        code, out, err = self._call(command, self.ws, self.args.timeout)
        (self.tmp / f"{label}.stdout").write_text(out)
        (self.tmp / f"{label}.stderr").write_text(err)
        return code, out

    def build(self, label: str) -> None:
        code, _ = self.call([self.args.forge, "build", "--offline", "src",
                            "lib/v4-core/src/PoolManager.sol"], label)
        if code != 0:
            raise ForgeError(f"{label}: build failed or timed out; never counts as a kill")

    def test(self, row: dict, evm: str, label: str) -> tuple[int | None, str]:
        command = [self.args.forge, "test", "--offline", "--match-path", row["testFile"],
                   "--match-contract", f"^{row['contract']}$", "--json"]
        if evm != "default":
            command += ["--hardfork", evm]
        return self.call(command, label)


def cq11_main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Money mutations; kill or explicitly explain each fault on both EVMs.")
    campaigns = parser.add_mutually_exclusive_group(required=True)
    campaigns.add_argument("--cq11", action="store_true")
    campaigns.add_argument("--m2", action="store_true")
    campaigns.add_argument("--m3", action="store_true")
    parser.add_argument("--list", action="store_true")
    parser.add_argument("--mutant", action="append", help="run only these ids (repeatable); default: all")
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--manifest", type=Path, default=MANIFEST)
    parser.add_argument("--scratch", type=Path)
    parser.add_argument("--timeout", type=int, default=600)
    parser.add_argument("--fuzz-runs", type=int, default=256)
    parser.add_argument("--forge", default=shutil.which("forge") or "forge")
    args = parser.parse_args(argv)
    campaign = "m3" if args.m3 else "m2" if args.m2 else "cq11"
    if args.scratch is None:
        args.scratch = ROOT.parents[1] / ".cache" / ("m1-62b" if campaign == "cq11" else campaign + "-62")
    if args.timeout < 1 or args.fuzz_runs < 1:
        parser.error("timeout and fuzz runs must be positive")
    try:
        config = cq11_manifest(args.root, args.manifest, campaign)
        rows = config["mutants"]
        if args.mutant:
            unknown = set(args.mutant) - {r["id"] for r in rows}
            if unknown:
                raise ManifestError(f"unknown mutants: {sorted(unknown)}")
            rows = [r for r in rows if r["id"] in args.mutant]
        if args.list:
            for row in rows:
                print(f"{row['id']}: {row['area']} / {row['file']} / {row['requirement']}")
            return 0
        version = forge_version(args.forge)
        if version != config["forge"]:
            raise ManifestError(f"CQ11 requires forge {config['forge']}, found {version}")
    except (ManifestError, OSError, ValueError, KeyError) as exc:
        print(f"CQ11: {exc}", file=sys.stderr)
        return 2
    runner = CQ11Runner(args)
    report = {"campaign": "SH-V2-M1-62b" if campaign == "cq11" else f"SH-V2-{campaign.upper()}-62", "started": utc_now(), "forge": version,
              "fuzzRuns": args.fuzz_runs, "evms": ["default", "amsterdam"],
              "manifestSha256": hashlib.sha256(args.manifest.read_bytes()).hexdigest(),
              "selected": [r["id"] for r in rows], "baselines": [], "results": [], "exitCode": None}
    report_path = runner.tmp / "report.json"

    def save() -> None:
        report_path.write_text(json.dumps(report, indent=2) + "\n")

    def stop(signum: int, _frame: object) -> None:
        raise Interrupted(signum)

    old_signals = {s: signal.signal(s, stop) for s in (signal.SIGINT, signal.SIGTERM)}
    originals = {row["file"]: (args.root / row["file"]).read_bytes() for row in rows}
    code = 3
    try:
        runner.copy()
        print(f"CQ11 scratch: {runner.tmp.relative_to(args.scratch.resolve())}", flush=True)
        runner.build("baseline-build")
        baselines = {}
        for row in rows:
            for evm in report["evms"]:
                key = (row["testFile"], row["contract"], evm)
                if key not in baselines:
                    result = runner.test(row, evm, f"baseline-{row['contract']}-{evm}")
                    baselines[key] = cq11_tests(*result)
                    report["baselines"].append({"file": key[0], "contract": key[1], "evm": evm,
                                                "tests": sorted(baselines[key])})
                    save()
        for row in rows:
            target = runner.ws / row["file"]
            original = originals[row["file"]]
            if target.read_bytes() != original:
                raise ForgeError("scratch source was not restored before planting")
            target.write_bytes(cq11_plant(original, row))
            entry = {"id": row["id"], "area": row["area"], "file": row["file"], "sha256": row["sha256"],
                     "before": row["before"], "after": row["after"], "runs": []}
            if row.get("survivorExplanation"):
                entry["survivorExplanation"] = row["survivorExplanation"]
                entry["survivorEvidence"] = row["survivorEvidence"]
            report["results"].append(entry)
            try:
                runner.build(row["id"] + "-build")
                for evm in report["evms"]:
                    result = runner.test(row, evm, f"{row['id']}-{evm}")
                    verdict, detail = cq11_verdict(*result, baselines[(row["testFile"], row["contract"], evm)],
                                                   row.get("survivorExplanation"))
                    entry["runs"].append({"evm": evm, "verdict": verdict, "detail": detail})
                    print(f"{row['id']} {evm}: {verdict}" + (f" ({detail[0]})" if detail else ""), flush=True)
                    save()
            finally:
                target.write_bytes(original)
        code = 0 if all(run["verdict"] in ("killed", "explained")
                        for entry in report["results"] for run in entry["runs"]) else 1
    except Interrupted as exc:
        code = exc.code
        report["error"] = str(exc)
    except (ForgeError, OSError, ManifestError) as exc:
        report["error"] = str(exc)
        print(f"CQ11: {exc}", file=sys.stderr)
    finally:
        runner.close()
        for sig, handler in old_signals.items():
            signal.signal(sig, handler)
        if any((args.root / path).read_bytes() != original for path, original in originals.items()):
            code = 3
            report["error"] = "working-tree production source changed during campaign"
        report["exitCode"] = code
        report["finished"] = utc_now()
        save()
        print(f"CQ11 report: {report_path.relative_to(args.scratch.resolve())}; exit {code}", flush=True)
    return code


if __name__ == "__main__":
    sys.exit(cq11_main(sys.argv[1:]) if {"--cq11", "--m2", "--m3"} & set(sys.argv[1:]) else main(sys.argv[1:]))
