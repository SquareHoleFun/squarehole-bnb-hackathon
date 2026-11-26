// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console} from "forge-std/console.sol";
import {ManifestVerifier} from "./lib/ManifestVerifier.sol";

/// @title VerifyManifest (review round B): READ-ONLY check of a deployed manifest against the chain
/// @notice Re-checks `deployments/<chainId>.json` (or SH_MANIFEST) against the chain the script runs on: every address
/// has code with the recorded code hash, the hook's permission bits and the system wiring, every template and every
/// launch equal to the registry's record, registry blocks inside the receipt range, provenance (see
/// `ManifestVerifier`). Run it before committing a public-chain manifest and whenever a reader wants to re-check one:
///   forge script script/VerifyManifest.s.sol --rpc-url <RPC of that chain>
/// Nothing is broadcast; no key is read.
contract VerifyManifest is ManifestVerifier {
    function run() external view {
        string memory path = vm.envOr(
            "SH_MANIFEST", string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json")
        );
        verifyManifest(vm.readFile(path));
        console.log("SQUAREHOLE_VERIFY OK: the manifest matches the chain at block", block.number);
        console.log("SQUAREHOLE_VERIFY manifest", path);
    }
}
