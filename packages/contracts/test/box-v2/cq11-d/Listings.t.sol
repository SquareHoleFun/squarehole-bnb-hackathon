// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ListingRegistry} from "../../../src/box-v2/ListingRegistry.sol";
import {IListingRegistry, ListingRecord, ListingClass, ListingKind, ListingRefusal} from "../../../src/box-v2/interfaces/IListingRegistry.sol";
import {KitPlainToken} from "../m1-20c/M1_20cTokens.sol";

contract EmptyRegistryD {
    function directory() external pure returns (address[] memory) { return new address[](0); }
    function boxIdOf(address) external pure returns (bool, uint256) { return (false, 0); }
}

contract ListingsDTest is Test {
    ListingRegistry internal registry;
    KitPlainToken internal token;
    address internal manager;
    address internal wrapped = address(0x777);

    function setUp() public virtual {
        manager = deployCode("PoolManager.sol:PoolManager", abi.encode(address(this)));
        registry = ListingRegistry(deployCode("ListingRegistry.sol:ListingRegistry", abi.encode(address(this), address(new EmptyRegistryD()), manager, wrapped)));
        token = new KitPlainToken("Pricing", "P", 8);
        token.mint(address(this), 100_000);
        token.approve(address(registry), 10_000);
    }

    function test_BC215_nativeRowAndPermanentId() public {
        ListingRecord memory native = registry.listing(0);
        assertEq(native.token, address(0));
        assertEq(native.raise, registry.RAISE_ETH());
        assertEq(registry.listingCount(), 1);
        assertEq(uint8(native.class), uint8(ListingClass.NATIVE));
        assertEq(uint8(native.kind), uint8(ListingKind.LISTED));
        (bool known, uint32 id) = registry.newestListingOf(address(0));
        assertTrue(known); assertEq(id, 0);
        id = registry.add(address(token), ListingClass.STOCK, 1_000_000);
        assertEq(id, 1);
        vm.expectRevert(abi.encodeWithSelector(IListingRegistry.AlreadyListed.selector, address(token), id));
        registry.add(address(token), ListingClass.OTHER, 2_000_000);
        assertEq(registry.listingCount(), 2);
    }

    function test_BC215_probeConservesEveryBalanceAndAllowance() public {
        registry.add(address(token), ListingClass.STOCK, 1_000_000);
        assertEq(token.balanceOf(address(this)), 100_000);
        assertEq(token.totalSupply(), 100_000);
        assertEq(token.balanceOf(address(registry)), 0);
        assertEq(token.balanceOf(manager), 0);
        assertEq(token.allowance(address(this), address(registry)), 10_000);
    }

    function test_BC215_raiseUpdatePreservesIdentityAndOldSnapshot() public {
        uint32 id = registry.add(address(token), ListingClass.STOCK, 1_000_000);
        ListingRecord memory before_ = registry.listing(id);
        vm.expectEmit(true, false, false, true);
        emit IListingRegistry.RaiseUpdated(id, 1_000_000, 4_000_000);
        registry.updateRaise(id, 4_000_000);
        ListingRecord memory after_ = registry.listing(id);
        assertEq(before_.raise, 1_000_000);
        assertEq(after_.raise, 4_000_000);
        assertEq(after_.token, before_.token);
        assertEq(after_.listedAt, before_.listedAt);
        assertEq(after_.decimals, before_.decimals);
        assertEq(uint8(after_.class), uint8(before_.class));
        assertEq(uint8(after_.kind), uint8(before_.kind));
        assertGt(after_.q.bootstrapQ, before_.q.bootstrapQ);
        assertGt(after_.q.batchMinQ, 0);
        assertGt(after_.q.tipMaxQ, 0);
        assertGt(after_.q.swapStepMinQ, 0);
        registry.updateRaise(0, 1_000_000);
        assertEq(registry.listing(0).raise, 1_000_000);
    }

    function test_BC162_onlyListerCanAddAndUpdate() public {
        vm.prank(address(0x123));
        vm.expectRevert(abi.encodeWithSelector(IListingRegistry.NotLister.selector, address(0x123)));
        registry.add(address(token), ListingClass.OTHER, 1_000_000);
        vm.prank(address(0x123));
        vm.expectRevert(abi.encodeWithSelector(IListingRegistry.NotLister.selector, address(0x123)));
        registry.updateRaise(0, 1_000_000);
    }

    function test_boundsAndUnknownListingAreAtomic() public {
        uint256 original = registry.listing(0).raise;
        vm.expectRevert(abi.encodeWithSelector(IListingRegistry.ListingRefused.selector, ListingRefusal.RAISE_NOT_BUILDABLE));
        registry.updateRaise(0, 999_999);
        vm.expectRevert(abi.encodeWithSelector(IListingRegistry.ListingRefused.selector, ListingRefusal.RAISE_NOT_BUILDABLE));
        registry.updateRaise(0, uint256(type(uint128).max) + 1);
        vm.expectRevert(abi.encodeWithSelector(IListingRegistry.UnknownListing.selector, uint32(1)));
        registry.updateRaise(1, 1_000_000);
        assertEq(registry.listing(0).raise, original);
    }

    function testFuzz_layoutAndPositiveThresholds(uint128 raise) public {
        raise = uint128(bound(raise, 1_000_000, type(uint128).max));
        uint256 before_ = registry.listing(0).raise;
        try registry.updateRaise(0, raise) {} catch (bytes memory reason) {
            // Numeric bounds do not promise an exactly representable curve at every raw integer.
            assertEq(reason, abi.encodeWithSelector(IListingRegistry.ListingRefused.selector, ListingRefusal.RAISE_NOT_BUILDABLE));
            assertEq(registry.listing(0).raise, before_);
            return;
        }
        ListingRecord memory r = registry.listing(0);
        assertEq(r.raise, raise);
        assertGt(r.q.bootstrapQ, 0);
        assertGt(r.q.batchMinQ, 0);
        assertGt(r.q.tipMaxQ, 0);
        assertGt(r.q.swapStepMinQ, 0);
    }

    function test_BC162_twoStepAuthorityAndPermanentRenounce() public {
        address next = address(0x123);
        registry.proposeRenounce();
        registry.proposeLister(next);
        assertFalse(registry.renouncePending());
        vm.prank(next); registry.acceptLister();
        assertEq(registry.lister(), next);
        vm.prank(next); registry.proposeRenounce();
        vm.prank(next); registry.renounce();
        assertTrue(registry.renounced());
        vm.prank(next);
        vm.expectRevert(abi.encodeWithSelector(IListingRegistry.NotLister.selector, next));
        registry.updateRaise(0, 1_000_000);
    }
}
