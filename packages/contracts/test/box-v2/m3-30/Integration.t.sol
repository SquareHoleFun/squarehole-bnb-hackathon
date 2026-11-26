// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PileIntegrationFixture, PileVaultV2, CoordinatorViews, BoxClones} from "./IntegrationFixture.sol";
import {IBoxCoordinatorV2, ChunkPart, FailCause} from "../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";
import {HostileToken} from "../kit/HostileToken.sol";

contract PileIntegrationTest is PileIntegrationFixture {
    function test_S5_realNonceAdmissionAuthenticatesPileAlias() public {
        _prepare(false, false, SEED, false, 0);
        _deploy(); box.launch(); _load();
        assertTrue(box.gateOpen()); assertFalse(box.starterSetPending());
        assertEq(box.starterSetLoader(), address(pile)); assertEq(box.vault(), address(pile));
        assertEq(box.roleAddress(4), address(0)); assertEq(box.roleAddress(7), address(0));
        assertEq(box.roleAddress(16), address(0));
        assertEq(address(box).code, BoxClones.runtime(coordinatorImpl, _args(address(box))));
    }
    // An external wrapper keeps expectRevert attached to the whole deploy attempt, not fixture getters.
    function deployPrepared() external { _deploy(); }
    function _args(address clone) private view returns (bytes memory args) {
        bytes memory code = clone.code; args = new bytes(code.length - BoxClones.ARGS_OFFSET);
        for (uint256 i; i < args.length; ++i) args[i] = code[i + BoxClones.ARGS_OFFSET];
    }
    function test_G1_seedAndChunksBothOrdersScheduledAndLateOpening() public {
        for (uint256 order; order < 2; ++order) {
            _make(false, false, SEED, true, 1_000_100);
            assertTrue(box.starterSetPending()); assertFalse(box.gateOpen());
            if (order == 0) {
                box.loadChunk(ChunkPart.Table, hex"00", 0); assertFalse(box.gateOpen()); _load();
            } else {
                _load(); assertFalse(box.gateOpen()); assertFalse(box.starterSetPending());
                vm.warp(1_000_200); box.loadChunk(ChunkPart.Table, hex"00", 0);
            }
            assertTrue(box.gateOpen()); assertFalse(box.starterSetPending());
            uint256 at = order == 0 ? 1_000_100 : 1_000_201;
            assertEq(hook.openAt(), at); assertEq(router.openAt(), at);
            assertEq(box.deadline(), at + 30 days);
            assertEq(seedToken.balanceOf(CREATOR), 0); assertEq(_assetBalance(address(pile)), SEED);
            vm.expectRevert(PileVaultV2.WrongPhase.selector); pile.loadSeed();
        }
    }
    function test_G1_realSetOpenRefusalRollsBackSeedAllowanceAndCompletion() public {
        _make(false, false, SEED, false, 0);
        vm.prank(BOB); vm.expectRevert(abi.encodeWithSelector(IBoxCoordinatorV2.NotStarterSetLoader.selector, BOB));
        box.starterSetLoaded();
        router.setRefuseOpen(true);
        vm.expectRevert(); pile.loadSeed();
        assertEq(_assetBalance(CREATOR), SEED); assertEq(_assetBalance(address(pile)), 0);
        assertEq(seedToken.allowance(CREATOR, address(pile)), SEED);
        assertTrue(box.starterSetPending()); assertFalse(box.gateOpen()); assertEq(hook.openAt(), 0);
        router.setRefuseOpen(false); _load();
        assertEq(seedToken.allowance(CREATOR, address(pile)), 0);
        assertTrue(box.gateOpen()); assertFalse(box.starterSetPending());
        vm.prank(address(pile)); vm.expectRevert(IBoxCoordinatorV2.NOT_OFFERED.selector); box.starterSetLoaded();
    }
    function test_G1_chunkLastRefusalKeepsFundedSeedAndRetriesChunk() public {
        _make(false, false, SEED, true, 0); _load(); router.setRefuseOpen(true);
        vm.expectRevert(); box.loadChunk(ChunkPart.Table, hex"00", 0);
        assertFalse(box.gateOpen()); assertFalse(box.starterSetPending()); assertEq(_assetBalance(address(pile)), SEED);
        router.setRefuseOpen(false); box.loadChunk(ChunkPart.Table, hex"00", 0);
        assertTrue(box.gateOpen()); assertEq(_assetBalance(CREATOR), 0);
    }
    function test_G1_zeroSeedUsesUnmodifiedCoordinatorNoLoaderOrPull() public {
        _make(false, false, 0, false, 0);
        assertEq(box.starterSetLoader(), address(0)); assertFalse(box.starterSetPending()); assertTrue(box.gateOpen());
        assertEq(vm.computeCreateAddress(coordinatorImpl, 1).codehash, keccak256(type(CoordinatorViews).runtimeCode));
        vm.expectRevert(IBoxCoordinatorV2.NOT_OFFERED.selector); box.starterSetLoaded();
        vm.expectRevert(PileVaultV2.WrongPhase.selector); pile.loadSeed();
        hook.fill(); box.graduate();
        vm.prank(ALICE); assertEq(pile.redeem(100, 0, ALICE), 0);
        assertEq(token.totalSupply(), 0);
    }
    function test_S1_realListingAdmissionAndRaiseUpdateDoNotChangeSeed() public {
        _make(false, false, SEED, false, 0);
        (bool listed, uint32 id) = listings.newestListingOf(asset); assertTrue(listed);
        listings.updateRaise(id, 4_000_000);
        assertEq(pile.seedAmount(), SEED); assertEq(box.raise(), 1e18);
        _load(); hook.fill(); box.graduate();
        vm.prank(ALICE); assertEq(pile.redeem(100, SEED, ALICE), SEED);
        assertEq(token.totalSupply(), 0); assertEq(_assetBalance(address(pile)), 0);
    }
    function test_S1_unlistedAndOwnTRejectedAtRealLaunchEvenForZeroSeed() public {
        for (uint256 kind; kind < 2; ++kind) {
            _prepare(false, false, 0, false, 0);
            address bad = kind == 0 ? address(new HostileToken("Unlisted", "U", 6)) : address(token);
            codes[3] = BoxClones.initCode(pileImpl,
                abi.encodePacked(address(box), address(token), bad, CREATOR, uint256(0)));
            _deploy(); vm.expectRevert(PileVaultV2.InvalidWiring.selector); box.launch();
            assertEq(token.totalSupply(), 1e30); assertFalse(box.graduated());
            vm.expectRevert(PileVaultV2.WrongPhase.selector); pile.loadSeed();
        }
    }
    function test_R10_nativeLoadIsSeparateExactCreatorPaymentAndRetries() public {
        _make(true, false, SEED, false, 0);
        assertEq(address(pile).balance, 0); assertEq(CREATOR.balance, SEED); assertTrue(box.starterSetPending());
        vm.deal(BOB, SEED); vm.prank(BOB); vm.expectRevert(PileVaultV2.WrongValue.selector); pile.loadSeed{value: SEED}();
        vm.prank(CREATOR); vm.expectRevert(PileVaultV2.WrongValue.selector); pile.loadSeed{value: SEED - 1}();
        router.setRefuseOpen(true);
        vm.prank(CREATOR); vm.expectRevert(); pile.loadSeed{value: SEED}();
        assertEq(CREATOR.balance, SEED); assertEq(address(pile).balance, 0); assertTrue(box.starterSetPending());
        router.setRefuseOpen(false); _load();
        assertEq(CREATOR.balance, 0); assertEq(address(pile).balance, SEED); assertTrue(box.gateOpen());
        hook.fill(); box.graduate();
        vm.prank(ALICE); assertEq(pile.redeem(100, SEED, ALICE), SEED); assertEq(ALICE.balance, SEED);
    }
    function test_R11_realFailureCausesSeedPAndOtherRemainSeparate() public {
        for (uint256 same; same < 2; ++same) {
            for (uint256 cause; cause < 3; ++cause) {
                _make(false, same == 1, SEED, cause == 1, 0); _load();
                // Backed P claims are the pot. Identical asset addresses do not merge real seed custody.
                _fund(p, address(hook), 1234); seedToken.setBlocked(address(pile), true);
                vm.mockCallRevert(asset, abi.encodeCall(seedToken.balanceOf, (address(pile))), "seed read refused");
                if (cause == 0) {
                    uint256 end = box.deadline(); vm.warp(end - 1); vm.expectRevert(); box.fail();
                    vm.warp(end); box.fail(); assertEq(uint256(box.failCause()), uint256(FailCause.Deadline));
                } else if (cause == 1) {
                    uint256 end = box.openAt() + box.GATE_CAP(); vm.warp(end - 1); vm.expectRevert(); box.failClosed();
                    vm.warp(end); box.failClosed(); assertEq(uint256(box.failCause()), uint256(FailCause.ClosedPastCap));
                } else {
                    hook.fill(); uint256 end = block.timestamp + 7 days;
                    vm.warp(end - 1); vm.expectRevert(); box.fail();
                    vm.warp(end); box.fail(); assertEq(uint256(box.failCause()), uint256(FailCause.GraduationTimedOut));
                }
                vm.clearMockedCalls();
                assertTrue(box.failed()); _pot(1234, 100);
                assertEq(_assetBalance(address(pile)), SEED);
                vm.expectRevert(); pile.returnSeed(); _pot(1234, 100);
                vm.prank(ALICE); assertEq(box.claim(40, ALICE), 493); _pot(741, 60);
                seedToken.setBlocked(address(pile), false);
                vm.prank(BOB); assertEq(pile.returnSeed(), SEED); _pot(741, 60);
                assertEq(_assetBalance(CREATOR), SEED); assertEq(_assetBalance(BOB), 0);
                vm.prank(ALICE); assertEq(box.claim(60, ALICE), 741); _pot(0, 0);
                assertEq(price.balanceOf(ALICE), 1234); assertEq(token.balanceOf(ALICE), 0);
                vm.expectRevert(); pile.returnSeed(); vm.expectRevert(); pile.loadSeed();
                vm.expectRevert(IBoxCoordinatorV2.AlreadyFailed.selector); box.graduate();
                if (cause == 1) { box.loadChunk(ChunkPart.Table, hex"00", 0); assertFalse(box.gateOpen()); }
            }
        }
    }
    function test_R11_globalPauseFailsOnlyOwnAssetPayoutThenRetries() public {
        for (uint256 same; same < 2; ++same) {
            _make(false, same == 1, SEED, false, 0); _load(); _fund(p, address(hook), 1200);
            seedToken.setPaused(true); vm.warp(box.deadline()); box.fail(); _pot(1200, 100);
            vm.expectRevert(); pile.returnSeed();
            if (same == 0) { vm.prank(ALICE); assertEq(box.claim(100, ALICE), 1200); _pot(0, 0); }
            else {
                vm.prank(ALICE); vm.expectRevert(); box.claim(100, ALICE); _pot(1200, 100);
                assertEq(token.balanceOf(ALICE), 100);
            }
            seedToken.setPaused(false); assertEq(pile.returnSeed(), SEED);
            if (same == 1) { _pot(1200, 100); vm.prank(ALICE); assertEq(box.claim(100, ALICE), 1200); }
            _pot(0, 0); assertEq(_assetBalance(CREATOR), SEED);
        }
    }
    function test_R11_unloadedNativeAndERC20FailureNeverPullsOrReopens() public {
        for (uint256 native_; native_ < 2; ++native_) {
            _make(native_ == 1, false, SEED, true, 0);
            vm.warp(box.openAt() + box.GATE_CAP()); box.failClosed();
            assertEq(pile.returnSeed(), 0); assertEq(_assetBalance(CREATOR), SEED);
            vm.expectRevert(PileVaultV2.WrongPhase.selector); pile.loadSeed();
            vm.prank(address(pile)); vm.expectRevert(IBoxCoordinatorV2.AlreadyFailed.selector); box.starterSetLoaded();
            box.loadChunk(ChunkPart.Table, hex"00", 0); assertFalse(box.gateOpen());
        }
    }
    function test_R11_nativeSeedEqualsPFailurePotAndReturnConserve() public {
        _make(true, true, SEED, false, 0); _load(); _fund(p, address(hook), 1234);
        vm.warp(box.deadline()); box.fail(); _pot(1234, 100);
        assertEq(pile.returnSeed(), SEED); assertEq(CREATOR.balance, SEED); _pot(1234, 100);
        vm.prank(ALICE); assertEq(box.claim(100, ALICE), 1234); _pot(0, 0);
        assertEq(ALICE.balance, 1234); assertEq(address(pile).balance, 0);
    }
}
