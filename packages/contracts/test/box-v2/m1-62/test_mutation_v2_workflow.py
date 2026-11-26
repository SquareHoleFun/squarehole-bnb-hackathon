"""M1-62: the CI workflow of the per-ticket mutation runs (.github/workflows/mutation-v2.yml).

Run (from the repository root):
    python3 -m unittest discover -s packages/contracts/test/box-v2/m1-62 -p 'test_*.py'
"""
from __future__ import annotations

import sys

sys.dont_write_bytecode = True

import json  # noqa: E402
import os  # noqa: E402
import re  # noqa: E402
import unittest  # noqa: E402
from pathlib import Path  # noqa: E402

try:
    import yaml  # PyYAML
except ImportError:  # pragma: no cover
    yaml = None

# Review round 1, low 6: a skip is allowed only outside verify and CI. `pnpm check:mutation-v2` (change request 1)
# sets SH_MUTATION_REQUIRE_YAML=1, GitHub sets CI=true; there a missing PyYAML fails the suite.
REQUIRE_YAML = os.environ.get("SH_MUTATION_REQUIRE_YAML") == "1" or os.environ.get("CI") == "true"

HERE = Path(__file__).resolve().parent
CONTRACTS = HERE.parents[2]
REPO = CONTRACTS.parents[1]
WORKFLOW = REPO / ".github" / "workflows" / "mutation-v2.yml"
RESCUE_WORKFLOW = REPO / ".github" / "workflows" / "drand-rescue.yml"
# actions/checkout at the commit its v4 tag named on 2026-10-20 (SH-V21-RC8-INT § 2.1).
CHECKOUT_V4 = "actions/checkout@11d5960a326750d5838078e36cf38b85af677262"
MANIFEST = CONTRACTS / "script-py" / "mutation_v2.json"


def steps() -> list[dict]:
    (job,) = load()["jobs"].values()
    return job["steps"]


def load() -> dict:
    assert yaml is not None
    data = yaml.safe_load(WORKFLOW.read_text())
    assert isinstance(data, dict)
    return data


def triggers() -> dict:
    data = load()
    on = data.get("on", data.get(True))  # YAML 1.1 reads a bare `on` key as true
    assert isinstance(on, dict)
    return on


@unittest.skipIf(yaml is None and not REQUIRE_YAML, "PyYAML is not installed")
class WorkflowTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if yaml is None:
            raise AssertionError("PyYAML is required to check the workflow under verify and CI (pip install pyyaml)")

    def test_runs_only_by_hand(self) -> None:
        self.assertEqual(set(triggers()), {"workflow_dispatch"})

    def test_ticket_choices_are_the_manifests(self) -> None:
        inputs = triggers()["workflow_dispatch"]["inputs"]
        self.assertEqual(inputs["ticket"]["type"], "choice")
        self.assertEqual(inputs["ticket"]["options"], list(json.loads(MANIFEST.read_text())["tickets"]))
        self.assertEqual(inputs["scope"]["options"], ["ticket", "v2"])

    def test_read_only_and_no_secrets(self) -> None:
        self.assertEqual(load()["permissions"], {"contents": "read"})
        text = WORKFLOW.read_text()
        for word in ("secrets.", "fork-url", "RPC_URL", "--broadcast"):
            self.assertNotIn(word, text)

    def test_checkout_and_foundry_pin(self) -> None:
        checkout = next(s for s in steps() if s.get("uses", "").startswith("actions/checkout@"))
        self.assertEqual(checkout["with"]["submodules"], "recursive")
        self.assertIs(checkout["with"]["persist-credentials"], False)
        foundry = next(s for s in steps() if s.get("uses", "").startswith("foundry-rs/foundry-toolchain@"))
        self.assertEqual(foundry["with"]["version"], "v1.8.3")

    def test_runs_the_script_without_inline_expressions(self) -> None:
        run = next(s for s in steps() if "mutation_v2.py" in s.get("run", ""))
        self.assertEqual(run["working-directory"], "packages/contracts")
        self.assertIn('python3 script-py/mutation_v2.py --ticket "$TICKET" --scope "$SCOPE"', run["run"])
        self.assertEqual(run["env"]["TICKET"], "${{ inputs.ticket }}")
        self.assertEqual(run["env"]["SCOPE"], "${{ inputs.scope }}")
        for s in steps():
            self.assertNotIn("${{", s.get("run", ""), "inputs reach shell steps only through env")

    def test_build_before_the_run(self) -> None:
        # Review round 1, finding 2: the M1-03 kit loads the PoolManager from out/, which a filtered run never builds.
        names = [s.get("run", "") for s in steps()]
        build = next(i for i, run in enumerate(names) if run.strip().startswith("forge build"))
        run = next(i for i, run in enumerate(names) if "mutation_v2.py" in run)
        self.assertLess(build, run)
        self.assertEqual(steps()[build]["working-directory"], "packages/contracts")

    def test_actions_pinned_to_commits_where_known(self) -> None:
        # rc8 open item 69: checkout keeps its reviewed pin; foundry-toolchain v1 and
        # upload-artifact v4 stay tags until their commits are looked up (no network here), and nothing else is unpinned.
        uses = re.findall(r"^\s*(?:- )?uses: (\S+)(.*)$", WORKFLOW.read_text(), flags=re.M)
        self.assertEqual([u for u in uses if u[0].startswith("actions/checkout@")], [(CHECKOUT_V4, " # v4")])
        self.assertFalse(RESCUE_WORKFLOW.exists(), "F145 moves the second poster to Hetzner")
        unpinned = [u for u, _ in uses if not re.fullmatch(r"[\w.-]+/[\w.-]+@[0-9a-f]{40}", u)]
        self.assertEqual(unpinned, ["foundry-rs/foundry-toolchain@v1", "actions/upload-artifact@v4"])

    def test_report_is_kept(self) -> None:
        up = next(s for s in steps() if s.get("uses", "").startswith("actions/upload-artifact@"))
        self.assertEqual(up["if"], "always()")
        self.assertIn("mutation-v2-report.json", up["with"]["path"])


if __name__ == "__main__":
    unittest.main()
