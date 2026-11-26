// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {M132aBase} from "../m1-32a/M132aBase.sol";
import {ListingRaises} from "../../../src/box-v2/ListingRegistry.sol";
import {IListingRegistry, ListingRecord, QParameters} from "../../../src/box-v2/interfaces/IListingRegistry.sol";
import {BoxCoordinatorV2} from "../../../src/box-v2/BoxCoordinatorV2.sol";
import {BoxSpec} from "../../../src/box-v2/interfaces/SpecTypes.sol";

/// TA20-4 / BC-162 / BC-215 / F123. Real factory, registry and coordinators; offline PoolManager.
contract SepoliaListingBatchTest is M132aBase {
    address private constant PLATFORM_SAFE = 0x9432380a67745b453886698F9539aC035DF80B34;
    uint256 private constant TEST_RAISE = 100000000000000000;

    function setUp() public override {
        super.setUp();
        vm.chainId(11155111);
        listings.proposeLister(PLATFORM_SAFE);
        vm.prank(PLATFORM_SAFE);
        listings.acceptLister();
    }

    function test_TA20_nativePointOneEthHasBuildableLayoutAndPositiveParameters() public {
        QParameters memory q = ListingRaises.parameters(TEST_RAISE);
        assertGt(q.bootstrapQ, 0);
        assertGt(q.batchMinQ, 0);
        assertGt(q.tipMaxQ, 0);
        assertGt(q.swapStepMinQ, 0);
        listings.checkLayout(TEST_RAISE);
        ListingRecord memory before_ = listings.listing(0);
        vm.expectEmit(true, false, false, true, address(listings));
        emit IListingRegistry.RaiseUpdated(0, before_.raise, TEST_RAISE);
        vm.prank(PLATFORM_SAFE);
        listings.updateRaise(0, TEST_RAISE);
        ListingRecord memory after_ = listings.listing(0);
        assertEq(after_.raise, TEST_RAISE);
        assertEq(abi.encode(after_.q), abi.encode(q));
        before_.raise = TEST_RAISE;
        before_.q = q;
        assertEq(abi.encode(after_), abi.encode(before_), "row identity is unchanged");
        assertEq(listings.listingCount(), 1);
    }

    function testFuzz_TA20_updateRaiseIsListerOnlyAndRefusalPreservesRow(address caller) public {
        vm.assume(caller != PLATFORM_SAFE);
        bytes memory before_ = abi.encode(listings.listing(0));
        vm.expectRevert(abi.encodeWithSelector(IListingRegistry.NotLister.selector, caller));
        vm.prank(caller);
        listings.updateRaise(0, TEST_RAISE);
        assertEq(abi.encode(listings.listing(0)), before_);
    }

    function test_TA20_existingCoordinatorsKeepRaiseAndFutureBoxesGetPointOneEth() public {
        BoxSpec memory original = _spec();
        BoxCoordinatorV2 oldBox = _create(original);
        uint256 oldBootstrap = oldBox.bootstrapQ();
        vm.prank(PLATFORM_SAFE);
        listings.updateRaise(0, TEST_RAISE);
        BoxSpec memory updated = _spec();
        assertEq(updated.raise, TEST_RAISE);
        BoxCoordinatorV2 newBox = _create(updated);
        assertNotEq(address(newBox), address(oldBox));
        assertEq(newBox.raise(), TEST_RAISE);
        assertEq(newBox.bootstrapQ(), ListingRaises.parameters(TEST_RAISE).bootstrapQ);
        assertEq(oldBox.raise(), original.raise);
        assertEq(oldBox.bootstrapQ(), oldBootstrap);
        assertEq(registry.recordOf(oldBox.boxId()).raise, original.raise);
        assertEq(registry.recordOf(newBox.boxId()).raise, TEST_RAISE);
        assertNotEq(oldBox.raise(), newBox.raise());
    }
}
