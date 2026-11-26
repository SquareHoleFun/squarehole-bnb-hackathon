"""Offline F78 compiler-input comparison; run after the default and rehearsal U1 suites.

Bytecode is allowed to differ through build constants and the constructor guard. Comparing
compiler source hashes/settings pins that cause; differing byte positions alone cannot identify it.
"""
import copy
import json
from pathlib import Path
import re
import unittest


class AuditU1LaneBuildProfiles(unittest.TestCase):
    contracts = Path(__file__).resolve().parents[4]
    names = (
        "BoxCoordinator BoxHook BoxHookExtension BoxLaunchRouter BoxReceiver "
        "BoxReceiverExtension BoxCollection BoxVault BoxTickets BoxRoyaltyRouter "
        "BoxItemStream BoxFactoryV1Planner BoxFactoryV1 BoxRegistry BoxToken "
        "FitBuybackExecutor BoxBackedSource DrandSource"
    ).split()

    def testProperty_AUDIT_U1_compilerInputsDifferOnlyByBuildModule(self):
        for name in self.names:
            with self.subTest(contract=name):
                builds = [json.loads((self.contracts / out / f"{name}.sol" / f"{name}.json").read_text())
                          for out in ("out", "out-rehearsal")]
                metadata = [copy.deepcopy(b["metadata"]) for b in builds]
                for m, profile in zip(metadata, ("mainnet", "rehearsal")):
                    build_path = f"src/box/build/{profile}/BoxBuildV1.sol"
                    m["sources"].pop(build_path, None)
                    m["settings"]["remappings"] = [x.replace("build/rehearsal/", "build/mainnet/")
                                                        for x in m["settings"]["remappings"]]
                    # compiler output ABI includes the rehearsal constructor's additional custom error.
                    m.pop("output", None)
                self.assertEqual(metadata[0], metadata[1])
                # Public signatures cannot acquire an admin or setter through a profile.
                self.assertEqual(builds[0]["methodIdentifiers"], builds[1]["methodIdentifiers"])
                if name in ("BoxRegistry", "BoxToken", "BoxBackedSource", "DrandSource"):
                    self.assertEqual(builds[0]["bytecode"]["object"], builds[1]["bytecode"]["object"])

    def testProperty_AUDIT_U1_exactDocumentedBuildDifferences(self):
        texts = [(self.contracts / "src/box/build" / p / "BoxBuildV1.sol").read_text()
                 for p in ("mainnet", "rehearsal")]
        definitions = [dict(re.findall(r"(?:string|bool|uint256) internal constant (\w+) = ([^;]+);", text))
                       for text in texts]
        changed = {key for key in definitions[0] if definitions[0][key] != definitions[1][key]}
        box0 = {"RAISE", "BOOTSTRAP_ETH", "FEE_BATCH_MIN_ETH", "FEE_BATCH_TIP_MAX_ETH",
                "SWAP_STEP_MIN_Q", "DEPTH_CONVERT_MIN_Q", "PLATFORM_CAP_WEI"}
        presets = {f"CREATOR_FEE_CAP_PRESET_{i}" for i in range(5)}
        self.assertEqual(changed, box0 | presets | {"PROFILE", "REHEARSAL", "REFUSED_CHAIN_ID", "SCALE_DENOMINATOR"})
        for key in box0 | presets:
            self.assertEqual(int(definitions[0][key].replace("_", "")),
                             10 * int(definitions[1][key].replace("_", "")))
        # No hidden logic differences in the library: normalize only those explicitly enumerated constants.
        normalized = []
        for text in texts:
            library = text.split("library BoxBuildV1 {", 1)[1].split("\n}", 1)[0]
            library = re.sub(r"//[^\n]*", "", library)
            for key in changed:
                library = re.sub(rf"(constant {key} = )[^;]+", r"\1VALUE", library)
            normalized.append(re.sub(r"\s+", " ", library).strip())
        self.assertEqual(*normalized)


if __name__ == "__main__":
    unittest.main(verbosity=2)
