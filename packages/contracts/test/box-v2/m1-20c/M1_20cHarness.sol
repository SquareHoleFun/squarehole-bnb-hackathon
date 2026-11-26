// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IListingChecksHost, ListingChecks} from "../../../src/box-v2/libraries/ListingChecks.sol";
import {BoxTokenProof} from "../../../src/box-v2/libraries/BoxTokenProof.sol";
import {BoxProofView, IBoxTokenProofProbe, IListingChecksProbe} from "./M1_20cProbes.sol";

/// @title ListingChecksProbe
/// @notice TEST ONLY (M1-20-c). The red tests' face of `ListingChecks`: each entry calls the library and nothing else,
/// and it hosts the probe's two entries as M1-20-b's registry does (`IListingChecksHost`).
contract ListingChecksProbe is IListingChecksProbe, IListingChecksHost {
    address public immutable poolManager;

    constructor(address poolManager_) {
        poolManager = poolManager_;
    }

    /// The token checks without the reverse proof: the red tests run no release, so no box registry.
    function checkToken(address token, address funder) external returns (uint8 decimals) {
        decimals = ListingChecks.checkStatic(token);
        ListingChecks.checkTransfers(token, funder);
    }

    /// What `add()` runs: `ListingChecks.checkToken`, the reverse proof first.
    function checkAddedToken(address token, address funder, address boxRegistry) external returns (uint8) {
        return ListingChecks.checkToken(token, funder, boxRegistry);
    }

    function probeTransfers(address token, address funder) external {
        ListingChecks.probe(token, funder, poolManager);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        return ListingChecks.onUnlock(poolManager, data);
    }
}

/// @title BoxTokenProofProbe
/// @notice TEST ONLY (M1-20-c). The red tests' face of `BoxTokenProof`, over this release's box registry; `prove`
/// (without the state) for the further tests.
contract BoxTokenProofProbe is IBoxTokenProofProbe {
    address public immutable boxRegistry;

    constructor(address boxRegistry_) {
        boxRegistry = boxRegistry_;
    }

    function isBoxToken(address token) external view returns (bool) {
        return BoxTokenProof.isBoxToken(boxRegistry, token);
    }

    function proveBox(uint8 registryIndex, uint256 boxId) external view returns (BoxProofView memory) {
        return _view(BoxTokenProof.proveBox(boxRegistry, registryIndex, boxId));
    }

    function prove(uint8 registryIndex, uint256 boxId) external view returns (BoxProofView memory) {
        return _view(BoxTokenProof.prove(boxRegistry, registryIndex, boxId));
    }

    function _view(BoxTokenProof.Proof memory p) private pure returns (BoxProofView memory) {
        return BoxProofView(p.registryIndex, p.boxId, p.registry, p.coordinator, p.token, p.hook, p.pricingToken);
    }
}
