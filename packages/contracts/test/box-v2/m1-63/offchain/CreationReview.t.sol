// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {M132aBase} from "../../m1-32a/M132aBase.sol";
import {BoxCoordinatorV2} from "../../../../src/box-v2/BoxCoordinatorV2.sol";
import {BoxSpec} from "../../../../src/box-v2/interfaces/SpecTypes.sol";
import {IBoxRegistryV2} from "../../../../src/box-v2/interfaces/IBoxRegistryV2.sol";

contract CreationReview is M132aBase {
    function test_coordinatorFitsReleaseRuntimeBudget() public view {
        assertLe(release.implementations[0].code.length, 22_118, "coordinator runtime exceeds release budget");
    }

    function test_currentCreationRecordsZeroExecutorAndSnapshotsRaise() public {
        BoxSpec memory s = _spec();
        BoxCoordinatorV2 c = _create(s);
        IBoxRegistryV2.BoxRecordV2 memory before = registry.recordOf(0);
        assertEq(before.contracts[9], address(0), "indexer must accept the actual executor role");
        assertEq(before.codeHashes[9], bytes32(0));
        assertEq(before.contracts[11], address(0));
        assertEq(before.contracts[13], address(0));
        assertEq(c.raise(), s.raise);
        listings.updateRaise(0, s.raise * 2);
        assertEq(listings.listing(0).raise, s.raise * 2);
        assertEq(c.raise(), s.raise, "existing coordinator keeps its raise");
        assertEq(keccak256(abi.encode(registry.recordOf(0))), keccak256(abi.encode(before)));
        assertGt(factory.refusal(s, CREATOR).length, 0, "stale new spec must be refused");
        s.raise *= 2;
        assertEq(factory.refusal(s, CREATOR).length, 0);
        BoxCoordinatorV2 next = _create(s);
        assertEq(next.raise(), s.raise);
        assertEq(registry.recordOf(1).raise, s.raise);
    }
}
