// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {CustomRevert} from "v4-core/src/libraries/CustomRevert.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {SetPoolFixture, SetSpecV2} from "./SetPoolFixture.sol";
import {SetLocalERC721} from "../../../script/local/SetReleaseLocal.s.sol";
import {PriceLimitSwapper} from "../../research/hookgas/HookGasKit.sol";
import {BoxCoordinatorV2} from "../../../src/box-v2/BoxCoordinatorV2.sol";
import {IBoxVaultV2} from "../../../src/box-v2/interfaces/IBoxVaultV2.sol";
import {IBoxHookV2} from "../../../src/box-v2/interfaces/IBoxHookV2.sol";

/// Offline contract counterpart; does not stand in for an indexer/RPC boot.
contract SetLocalLifeAf1Test is SetPoolFixture {
    SetLocalERC721 private art;
    PriceLimitSwapper private swapper;

    function test_af1_registryResolvesZeroPastNowAndFutureRequests() public {
        _recordOpen(0, block.timestamp + 1);
        _recordOpen(uint32(block.timestamp - 60), block.timestamp + 1);
        _recordOpen(uint32(block.timestamp), block.timestamp + 1);
        _recordOpen(uint32(block.timestamp + 3600), block.timestamp + 3600);
    }
    function _recordOpen(uint32 requested, uint256 resolved) private {
        SetSpecV2 memory s = _spec(); s.openAt = requested;
        BoxCoordinatorV2 c = _create(s);
        assertEq(registry.recordOf(c.boxId()).openAt, resolved, "authentic registry resolved time");
        assertEq(c.openAt(), resolved);
        bytes memory runtime = address(c).code;
        uint256 raw;
        for (uint256 i = 45 + 204; i < 45 + 208; ++i) raw = (raw << 8) | uint8(runtime[i]);
        assertEq(raw, requested, "immutable argument stays raw");
    }
    function _create40() private {
        art = new SetLocalERC721(); art.mintBatch(CREATOR, _ids(0, 40));
        (SetSpecV2 memory s, bytes32[] memory suffix) = _terms(address(art), 40);
        s.creatorBuy = s.raise / 100; _start(s);
        swapper = new PriceLimitSwapper(pm);
        assertEq(registry.recordOf(box.boxId()).openAt, block.timestamp + 1);
        assertEq(vault.inside(), 0, "created");
        _page(0, 16, suffix[16]);
        (uint32 loaded, bytes32 remaining, bool notified) = loader.progress();
        assertEq(loaded, 16); assertEq(remaining, suffix[16]); assertFalse(notified);
        while (loaded < 40) {
            uint32 size = 40 - loaded > 16 ? 16 : 40 - loaded;
            _page(loaded, size, suffix[loaded + size]);
            (loaded, remaining, notified) = loader.progress();
            assertEq(remaining, suffix[loaded]);
        }
        assertEq(vault.inside(), 40, "loaded");
        loader.complete();
        vm.prank(CREATOR); art.setApprovalForAll(address(vault), false);
        assertTrue(box.gateOpen(), "completed");
        vm.warp(box.effectiveOpenAt()); vm.roll(block.number + 1);
    }
    function _buy(uint256 amount, uint160 limit) private {
        PoolKey memory key = hook.poolKey();
        vm.prank(CREATOR); swapper.swap{value: amount}(key, true, -int256(amount), limit);
        vm.warp(block.timestamp + 1); vm.roll(block.number + 1);
    }
    function _pastWindow() private {
        // F2: reproduce the old timing against the real hook, then use this box's effective opening.
        uint256 amount = box.raise() / 4;
        uint256 until = box.effectiveOpenAt() + hook.WINDOW_SECONDS();
        PoolKey memory key = hook.poolKey();
        bytes memory reason = abi.encodeWithSelector(IBoxHookV2.BuyThroughLaunchRouter.selector, address(router), until);
        vm.expectRevert(abi.encodeWithSelector(CustomRevert.WrappedError.selector, address(hook),
            IHooks.beforeSwap.selector, reason, abi.encodePacked(Hooks.HookCallFailed.selector)));
        vm.prank(CREATOR); swapper.swap{value: amount}(key, true, -int256(amount), curve.sqrtPriceEndX96);
        vm.warp(until); vm.roll(block.number + 1);
    }
    function _pickInput() private view returns (uint256) {
        uint256 principal = vault.quoteWithdraw(32);
        return principal + (principal * vault.pickFeeBps() + 9999) / 10000;
    }
    function test_af1_realPool40Pick32Return16() public {
        _create40(); _pastWindow();
        for (uint256 i; i < 5 && !hook.closed(); ++i) _buy(box.raise() / 4, curve.sqrtPriceEndX96);
        assertTrue(hook.closed(), "filled"); box.graduate();
        assertTrue(vault.gateOpen(), "graduated");
        uint256 input = _pickInput();
        assertLt(token.balanceOf(CREATOR), input, "F3 original actor is short");
        vm.prank(CREATOR); token.approve(address(vault), input);
        uint256[] memory picked = _ids(0, 32);
        uint256 balance = token.balanceOf(CREATOR);
        vm.expectRevert(abi.encodeWithSelector(IBoxVaultV2.InsufficientToken.selector, balance, input));
        vm.prank(CREATOR); vault.withdrawBatch(picked, input, block.timestamp + 3600);
        for (uint256 i; i < 8 && token.balanceOf(CREATOR) < _pickInput(); ++i) _buy(box.raise() / 4, 0);
        input = _pickInput();
        assertGe(token.balanceOf(CREATOR), input, "fresh fee-inclusive quote funded from pool");
        vm.prank(CREATOR); token.approve(address(vault), input);
        vm.prank(CREATOR); vault.withdrawBatch(picked, input, block.timestamp + 3600);
        assertEq(vault.inside(), 8, "picked 32");
        for (uint256 i; i < 16; ++i) { vm.prank(CREATOR); art.approve(address(vault), _id(i)); }
        uint256 principal = vault.quoteReturn(16);
        uint256 net = principal - (principal * 500 + 9999) / 10000;
        vm.prank(CREATOR); vault.returnItems(_ids(0, 16), net, block.timestamp + 3600);
        assertEq(vault.inside(), 24, "returned 16");
        for (uint256 i; i < 40; ++i) assertEq(art.ownerOf(_id(i)), i >= 16 && i < 32 ? CREATOR : address(vault));
    }
    function test_af1_secondBoxFundingRecoveryDeferredAndClaim() public {
        _create40(); _pastWindow();
        uint256 before = token.balanceOf(CREATOR);
        _buy(box.raise() / 10, curve.sqrtPriceEndX96);
        uint256 sale = (token.balanceOf(CREATOR) - before) / 4;
        vm.prank(CREATOR); token.approve(address(swapper), sale);
        PoolKey memory key = hook.poolKey();
        vm.prank(CREATOR); swapper.swap(key, false, -int256(sale), curve.sqrtPriceStartX96);
        assertGt(token.balanceOf(CREATOR), before, "failure funded");
        vm.warp(box.deadline()); box.fail(); assertTrue(vault.failed(), "failed");
        art.setBlocked(0, true);
        assertEq(vault.releaseToCreator(_ids(0, 32)), 31, "recovered with one deferred");
        assertEq(vault.inside(), 9); assertEq(art.ownerOf(0), address(vault));
        art.setBlocked(0, false);
        uint256[] memory retry = new uint256[](1);
        assertEq(vault.releaseToCreator(retry), 1); assertEq(vault.inside(), 8);
        uint256 claim = token.balanceOf(CREATOR);
        vm.prank(CREATOR); token.approve(address(box), claim);
        uint256 p = CREATOR.balance;
        vm.prank(CREATOR); box.claim(claim, CREATOR);
        assertGt(CREATOR.balance, p, "P claimed"); assertEq(token.balanceOf(CREATOR), 0);
        assertEq(token.allowance(CREATOR, address(box)), 0, "exact claim approval consumed");
    }
}
