// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ReuseFixture} from "./ReuseFixture.sol";
import {StarterSetLoaderV2} from "../../../src/box-v2/StarterSetLoaderV2.sol";
import {IBoxCoordinatorV2} from "../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";
import {BoxSpecV2} from "../../../src/box-v2/BoxSpecV2.sol";
import {BoxSpec, BoxType, ReleaseContext} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {IBoxRegistryV2} from "../../../src/box-v2/interfaces/IBoxRegistryV2.sol";
import {IBoxToken} from "../../../src/box/interfaces/IBoxToken.sol";

contract ExistingNftsReuseTest is ReuseFixture {
    function test_E00_gateWaitsForExactSetAndPermissionlessCompletion() public {
        assertTrue(vault.initialized());
        assertEq(box.collection(), address(0));
        assertEq(box.tickets(), address(0));
        assertFalse(box.gateOpen());
        _page(0, 32);
        vm.expectRevert(StarterSetLoaderV2.InvalidRequest.selector);
        loader.complete();
        assertFalse(box.gateOpen());
        _page(32, 1);
        assertFalse(box.gateOpen());
        vm.prank(ALICE);
        loader.complete();
        assertTrue(box.gateOpen());
        assertEq(box.effectiveOpenAt(), block.timestamp + 1);
        assertFalse(vault.opened(), "conversion waits for graduation");
    }

    function test_E00_loaderRefusesWrongCallerOversizedPageAndWrongCommitment() public {
        address[] memory collections = new address[](1);
        uint256[] memory ids = new uint256[](1);
        uint8[] memory tiers = new uint8[](1);
        collections[0] = NFT;
        ids[0] = _id(0);
        vm.expectRevert(abi.encodeWithSelector(StarterSetLoaderV2.Unauthorized.selector, address(this)));
        loader.load(collections, ids, tiers, hashes[1]);
        vm.expectRevert(StarterSetLoaderV2.InvalidRequest.selector);
        _page(0, 33);
        ids[0] = 42;
        vm.prank(CREATOR);
        vm.expectRevert(StarterSetLoaderV2.InvalidRequest.selector);
        loader.load(collections, ids, tiers, hashes[1]);
        (uint32 loaded, bytes32 remaining, bool notified) = loader.progress();
        assertEq(loaded, 0);
        assertEq(remaining, hashes[0]);
        assertFalse(notified);
        assertEq(vault.loaded(), 0);
    }

    function test_E00_completionFailureRollsBackAndRetriesOnce() public {
        _loadAll();
        hook.setRejectOpen(true);
        vm.expectRevert("open refused");
        loader.complete();
        (,, bool notified) = loader.progress();
        assertFalse(notified);
        assertTrue(box.starterSetPending());
        assertFalse(box.gateOpen());
        hook.setRejectOpen(false);
        loader.complete();
        assertEq(hook.openAt(), box.effectiveOpenAt());
        vm.expectRevert(StarterSetLoaderV2.InvalidRequest.selector);
        loader.complete();
    }

    function test_E00_onlyLoaderCanNotifyCoordinator() public {
        vm.expectRevert(abi.encodeWithSelector(IBoxCoordinatorV2.NotStarterSetLoader.selector, address(this)));
        box.starterSetLoaded();
        assertTrue(box.starterSetPending());
    }

    function test_E00_graduationOpensMinimalVaultWithoutCollectionOrTickets() public {
        _loadAll();
        loader.complete();
        _give(ALICE, 700);
        hook.fill();
        box.graduate();
        assertTrue(box.graduated());
        assertTrue(vault.opened());
        // Direct retry must succeed: coordinator's optional receiver poke could otherwise hide a refusal.
        vm.prank(address(box));
        receiver.onGraduation();
        assertEq(token.totalSupply(), 700);
    }

    function test_E00_failClosedPartialSetFreezesWithoutCollectionCalls() public {
        _page(0, 10);
        _give(ALICE, 700);
        _fund(address(hook), 7000);
        vm.warp(box.openAt() + box.GATE_CAP());
        box.failClosed();
        assertTrue(box.failed());
        assertTrue(vault.failed());
        assertFalse(box.gateOpen());
        assertEq(vault.loaded(), 10);
        (uint256 pot, uint256 left) = box.claimState();
        assertEq(pot, 7000);
        assertEq(left, 700);
        vm.expectRevert(StarterSetLoaderV2.InvalidRequest.selector);
        loader.complete();
        vm.expectRevert(StarterSetLoaderV2.InvalidRequest.selector);
        _page(10, 1);
        vm.prank(address(loader));
        vm.expectRevert(IBoxCoordinatorV2.AlreadyFailed.selector);
        box.starterSetLoaded();
        vm.startPrank(ALICE);
        token.approve(address(box), 700);
        assertEq(box.claim(700, ALICE), 7000);
        vm.stopPrank();
        assertEq(ALICE.balance, 7000);
    }

    function test_E00_failureUsesShareKAndRealReceiverReserveSplit() public {
        _loadAll();
        loader.complete();
        _give(ALICE, 700);
        vm.prank(address(box));
        token.approve(address(vault), 300);
        vault.pull(token, address(box), 300);
        vault.setFailureProbe(200, 0, false);
        hook.configure(0, 150, 0);
        _fund(address(hook), 1500);
        vm.warp(box.deadline());
        box.fail();
        (uint256 pot, uint256 left) = box.claimState();
        assertEq(left, 800, "subtract K=200, not all 300 in the vault (SHOP)");
        assertEq(pot, 1470, "reserve 150: FIT 20 + platform 10 retained, depth 120 returned");
        assertEq(pm.balanceOf(address(receiver), 0), 30);
        assertEq(token.balanceOf(address(vault)), 300);
        assertTrue(vault.failed());
        _fund(address(receiver), 80);
        vm.startPrank(ALICE);
        token.approve(address(box), 700);
        assertEq(box.claim(700, ALICE), uint256(1470 + 80) * 700 / 800);
        vm.stopPrank();
    }

    function testFuzz_E00_KClipsToVaultBalance(uint96 requested, uint96 held) public {
        uint256 amount = bound(uint256(held), 0, 1e24);
        uint256 k = bound(uint256(requested), 0, 1e24);
        _give(ALICE, 700);
        vm.prank(address(box));
        token.approve(address(vault), amount);
        vault.pull(token, address(box), amount);
        vault.setFailureProbe(k, 0, false);
        vm.warp(box.openAt() + box.GATE_CAP());
        box.failClosed();
        (, uint256 left) = box.claimState();
        assertEq(left, 700 + amount - (k > amount ? amount : k));
    }

    function test_E00_requiredFailureHookRevertsAtomically() public {
        vault.setFailureProbe(0, 0, true);
        _give(ALICE, 700);
        _fund(address(hook), 7000);
        vm.warp(box.openAt() + box.GATE_CAP());
        vm.expectRevert();
        box.failClosed();
        assertFalse(box.failed());
        assertFalse(hook.failed());
        assertEq(pm.balanceOf(address(hook), 0), 7000);
        vault.setFailureProbe(0, 0, false);
        box.failClosed();
        assertTrue(box.failed());
    }

    function test_E00_filledTimeoutUsesSameMinimalFailureABI() public {
        _loadAll();
        loader.complete();
        _give(ALICE, 700);
        hook.fill();
        vm.warp(hook.closedAt() + 7 days);
        box.fail();
        assertTrue(vault.failed());
        assertFalse(vault.opened());
    }

    function test_E00_tokenReadsFloorAndOnlyVaultCanPullEscrow() public {
        _give(ALICE, 700);
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(IBoxToken.DirectSendRefused.selector, address(vault)));
        token.transfer(address(vault), 100);
        vm.prank(ALICE);
        token.approve(address(vault), 100);
        vault.pull(token, ALICE, 100);
        uint256 supply = token.totalSupply();
        vault.setFailureProbe(0, supply, false);
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(IBoxToken.BurnBelowSupplyFloor.selector, supply - 1, supply));
        token.burn(1);
        assertEq(token.balanceOf(ALICE), 600);
        assertEq(token.balanceOf(address(vault)), 100);
    }

    function test_E00_registryRecordsNewSchemaAndOnlyPresentRoles() public view {
        IBoxRegistryV2.BoxRecordV2 memory r = registry.recordOf(0);
        assertEq(r.specHash, keccak256(encodedSpec));
        assertEq(r.contracts[3], address(vault));
        assertEq(r.contracts[19], address(loader));
        assertEq(r.contracts[4], address(0));
        assertEq(r.contracts[7], address(0));
        assertEq(r.contracts[16], address(0));
        assertEq(r.contracts[17], address(0));
        assertEq(r.codeHashes[3], address(vault).codehash);
    }

    function test_E00_oldValidatorStillRefusesExistingKind() public pure {
        BoxSpec memory s;
        s.format = 2;
        s.version = 2;
        s.boxType = uint8(BoxType.EXISTING);
        ReleaseContext memory ctx;
        (uint16 reason, uint16 field) = BoxSpecV2.validate(s, ctx);
        assertEq(reason, BoxSpecV2.REASON_NOT_OFFERED);
        assertEq(field, BoxSpecV2.FIELD_BOX_TYPE);
    }
}
