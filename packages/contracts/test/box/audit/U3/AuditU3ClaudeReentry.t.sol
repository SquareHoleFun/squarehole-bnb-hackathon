// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {BoxHookExtension} from "../../../../src/box/BoxHookExtension.sol";
import {DeepenSkip, DepthKind} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxCoordinator} from "../../../../src/box/interfaces/IBoxCoordinator.sol";
import {IBoxHook} from "../../../../src/box/interfaces/IBoxHook.sol";
import {IBoxReceiver} from "../../../../src/box/interfaces/IBoxReceiver.sol";
import {EthIn, EthOut, TIn, TOut} from "../common/AuditGhostLedger.sol";
import {AuditU3ClaudeBase, AuditU3ClaudeTipTaker} from "./AuditU3ClaudeBase.sol";
import {AuditU3ClaudeDeepenWatch, AuditU3DeepenRec} from "./AuditU3ClaudeDeepenWatch.sol";

/// @notice SH-AUDIT-B0-U3 (Claude), lens L3 (P3.8) on the factory's box 0: what code outside the box can do while the
/// hook's own unlock is open (a `deepen()` tip recipient with code), what the hook refuses from inside another
/// account's unlock, who can reach `unlockCallback`, and the one storage word the hook's two code halves share across
/// the forwarded calls (`BoxHookBase.sol:43-46`, `:107-118`; `BoxHook.sol:85-109`, `BoxHookExtension.sol:52-138`).
/// forge-config: default.evm_version = "osaka"
contract AuditU3ClaudeReentryTest is AuditU3ClaudeBase {
    uint256 internal constant W_UNUSED_MASK = ((uint256(1) << 24) - 1) << 208; // bits 208-231 (F77's removed rungs)
    uint256 internal constant W_LOW_GAP_MASK = 0xfe; // bits 1-7
    uint256 internal constant W_HIGH_MASK = ~uint256(0) << 236; // bits 236-255

    AuditU3ClaudeTipTaker internal taker;
    AuditU3ClaudeDeepenWatch internal watch;

    // ============================================================================================================
    // A tip recipient with code inside the hook's unlock

    /// `deepen(tipTo)` pays the tip last, inside its own unlock, so a `tipTo` with code runs while the PoolManager is
    /// unlocked by the hook. Such a recipient can neither deepen again (`ForeignUnlock`), collect (the harvest refuses
    /// a foreign unlock), harvest (`NotReceiver`) nor open a nested unlock (`AlreadyUnlocked`); it can trade in the
    /// pool and settle its own deltas, which leaves the deepen's accounting exact: the watch's rules hold (the hook's
    /// claims moved by exactly qUsed + tip and tOut − tUsed), the tip is min(5%, cap) and reaches the recipient whole,
    /// and the hook's storage word moves only by the cooldown block (IBoxHook.sol:85-87, BC-119 "from inside another
    /// unlock it reverts", BC-121).
    function testProperty_AUDIT_U3_tipRecipientInsideTheHooksUnlock() public {
        _graduatedWithBudget();
        _armTaker(token.balanceOf(whale) / 50);
        uint256 w0 = uint256(vm.load(a.hook, bytes32(0)));
        (uint256 e0, uint256 t0) = (address(taker).balance, token.balanceOf(address(taker)));
        AuditU3DeepenRec memory r = watch.deepenAs(keeper, address(taker));
        _noteEthChange(e0, address(taker).balance, EthIn.Other, EthOut.Tip);
        _noteTChange(t0, token.balanceOf(address(taker)), TIn.Sell, TOut.Other);
        (uint8 code, string memory why) = watch.violation(r);
        assertEq(code, 0, why);
        assertEq(r.kind, uint8(DepthKind.Convert), "the first deepen converts");
        assertGt(r.tip, 0);
        assertEq(taker.tipReceived(), r.tip, "the tip reached the recipient whole");
        assertFalse(taker.deepenOk(), "no second deepen inside the unlock");
        assertEq(taker.deepenReason(), IBoxHook.ForeignUnlock.selector);
        assertFalse(taker.collectOk(), "no collect inside the hook's unlock");
        assertEq(taker.collectReason(), IBoxHook.ForeignUnlock.selector, "the harvest refuses the foreign unlock");
        assertFalse(taker.harvestOk());
        assertEq(taker.harvestReason(), IBoxHook.NotReceiver.selector);
        assertFalse(taker.unlockOk(), "no nested unlock");
        assertEq(taker.unlockReason(), IPoolManager.AlreadyUnlocked.selector);
        assertTrue(taker.swapOk(), "a trade inside the hook's unlock passes the graduated hook");
        assertGt(taker.qFromSale(), 0);
        uint256 w1 = uint256(vm.load(a.hook, bytes32(0)));
        uint256 deepenField = ((uint256(1) << 40) - 1) << 168;
        assertEq(w1 & ~deepenField, w0 & ~deepenField, "only lastDeepenBlock moved in the state word");
        assertEq(hook.lastDeepenBlock(), vm.getBlockNumber());
        assertEq(a.hook.balance, 0, "the hook holds no ETH");
        assertEq(token.balanceOf(a.hook), 0, "the hook holds no T");
        _assertGhostLedger();
    }

    /// The same recipient on a pair: the pair is added at the price the deepen planned, before the recipient trades,
    /// so its trade cannot change what the pair took; the watch's rules hold and the pair never shrinks.
    function testProperty_AUDIT_U3_tipRecipientAfterAPair() public {
        _graduatedWithBudget();
        _watchedBy(keeper);
        _advance(300);
        _armTaker(token.balanceOf(whale) / 50);
        (uint256 e0, uint256 t0) = (address(taker).balance, token.balanceOf(address(taker)));
        AuditU3DeepenRec memory r = watch.deepenAs(keeper, address(taker));
        _noteEthChange(e0, address(taker).balance, EthIn.Other, EthOut.Tip);
        _noteTChange(t0, token.balanceOf(address(taker)), TIn.Sell, TOut.Other);
        (uint8 code, string memory why) = watch.violation(r);
        assertEq(code, 0, why);
        assertEq(r.kind, uint8(DepthKind.Pair));
        assertTrue(taker.swapOk());
        assertEq(hook.pairedLiquidity(), r.pair0 + r.liquidity, "the pair grew by the add, untouched by the trade");
        _assertGhostLedger();
    }

    // ============================================================================================================
    // Inside another account's unlock

    /// From inside any other account's unlock: `deepen` reverts `ForeignUnlock` in every phase (before graduation too,
    /// ahead of the NotGraduated skip); the receiver's `collect` reverts with the harvest's `ForeignUnlock`;
    /// `graduate()` of a closed curve cannot run (its migration needs an unlock of its own: `AlreadyUnlocked`), so a
    /// buy to P1 and a sale back can never share one unlock with the graduation (BC-025, BC-119;
    /// `BoxHookBase.sol:237-240`).
    function testProperty_AUDIT_U3_foreignUnlockRefusals() public {
        _toBonding();
        _assertForeignRefusals();
        _toClosed();
        (bool ok, bytes memory ret) = u3actor.callInside(a.coordinator, abi.encodeCall(IBoxCoordinator.graduate, ()));
        assertFalse(ok, "graduate() inside a foreign unlock");
        (, bytes4 reason) = u3actor.reasonOf(ret);
        assertEq(reason, IPoolManager.AlreadyUnlocked.selector, "the migration's own unlock is refused");
        assertFalse(coordinator.graduated());
        _assertForeignRefusals();
        _toGraduated();
        _assertForeignRefusals();
    }

    function _assertForeignRefusals() internal {
        (bool ok, bytes memory ret) = u3actor.callInside(a.hook, abi.encodeCall(IBoxHook.deepen, (keeper)));
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(IBoxHook.ForeignUnlock.selector), "deepen: ForeignUnlock");
        (ok, ret) = u3actor.callInside(a.receiver, abi.encodeCall(IBoxReceiver.collect, (keeper)));
        assertFalse(ok);
        (, bytes4 reason) = u3actor.reasonOf(ret);
        assertEq(reason, IBoxHook.ForeignUnlock.selector, "collect: the harvest refuses");
    }

    // ============================================================================================================
    // Who reaches unlockCallback

    /// `unlockCallback` of either half acts only for the hook's own unlock: from any account but the PoolManager every
    /// action reverts `NotPoolManager` (the hook) or `NotDelegated` (the extension called directly); the PoolManager
    /// calls back only the account that unlocked it (v4 `PoolManager.unlock`), and outside an unlock the hook's own
    /// steps are refused by v4 (`ManagerLocked`), so even a call carrying the PoolManager's address cannot act; the
    /// hook's claims and positions do not move (`BoxHook.sol:102-109`, `BoxHookExtension.sol:128-138`).
    function testFuzz_AUDIT_U3_unlockCallbackOnlyForTheHooksOwnUnlock(address caller, uint8 action) public {
        vm.assume(caller != address(pm));
        _graduatedWithBudget();
        uint8 act = uint8(bound(action, 1, 4));
        bytes memory data = _actionData(act);
        vm.prank(caller);
        (bool ok, bytes memory ret) = a.hook.call(abi.encodeCall(IUnlockCallback.unlockCallback, (data)));
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(IBoxHook.NotPoolManager.selector));
        address ext = hook.extension();
        vm.prank(caller);
        (ok, ret) = ext.call(abi.encodeCall(BoxHookExtension.unlockCallback, (data)));
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(BoxHookExtension.NotDelegated.selector));
        (uint256 q0, uint256 t0) = _hookClaims();
        (uint128 ask0, uint128 bid0, uint128 sent0) = hook.graduatedLayout();
        vm.prank(address(pm));
        (ok, ret) = a.hook.call(abi.encodeCall(IUnlockCallback.unlockCallback, (data)));
        assertFalse(ok, "outside an unlock the hook's steps are refused");
        assertEq(ret, abi.encodeWithSelector(IPoolManager.ManagerLocked.selector));
        (uint256 q1, uint256 t1) = _hookClaims();
        assertEq(q1, q0);
        assertEq(t1, t0);
        (uint128 ask1, uint128 bid1, uint128 sent1) = hook.graduatedLayout();
        assertEq(ask1, ask0);
        assertEq(bid1, bid0);
        assertEq(sent1, sent0);
    }

    /// @dev Each action's data as the hook encodes it (`abi.encode(uint8 action, bytes arg)`); deepen's plan is a
    /// conversion of the whole Q budget, its tip to a stranger.
    function _actionData(uint8 act) internal view returns (bytes memory) {
        if (act == 1) return abi.encode(uint8(1), abi.encode(uint128(1)));
        if (act == 2) return abi.encode(uint8(2), abi.encode(uint256(0)));
        if (act == 3) return abi.encode(uint8(3), bytes(""));
        (uint256 q, uint256 t) = _hookClaims();
        int24 spot = _tickNow();
        // DeepenPlan(kind, tickLower, tickUpper, qMax, tMax, sqrtSpot, tipTo, spot, tRef, limit, tipReserve)
        return abi.encode(
            uint8(4),
            abi.encode(
                DepthKind.Convert,
                int24(0),
                int24(0),
                q,
                t,
                _sqrtP(),
                address(0xBEEF),
                spot,
                spot,
                _sqrtAt(spot - 40),
                q
            )
        );
    }

    // ============================================================================================================
    // The shared storage word across the forwarded calls

    /// `_w` decoded field by field through box 0's life (P3.8): after creation (initialize, launch), in the window, in
    /// bonding, closed, graduated, after a conversion and after a pair: the launched bit, deployBlock, openAt,
    /// closedAtBlock, migratedAtBlock, lastDeepenBlock and the position bits equal the views and the events' blocks;
    /// bits 1-7, 208-231 and 236-255 stay zero; `_reserveMinted` (slot 1) equals its view; the extension's own storage
    /// stays empty. Each write by one half keeps every field the other half wrote.
    function testProperty_AUDIT_U3_stateWordFieldByFieldThroughTheLife() public {
        uint256 created = createdAtBlock;
        _assertWord(created, 0, 0, 0, false);
        _toWindow();
        _assertWord(created, 0, 0, 0, false);
        _toBonding();
        _assertWord(created, 0, 0, 0, false);
        _toClosed();
        uint256 closedAt = hook.closedAtBlock();
        assertEq(closedAt, vm.getBlockNumber(), "closed in the closing buy's block");
        _assertWord(created, closedAt, 0, 0, false);
        _toGraduated();
        uint256 migratedAt = hook.migratedAtBlock();
        _assertWord(created, closedAt, migratedAt, 0, false);
        vm.prank(keeper);
        launchRouter.sweep();
        _advance(300);
        watch = new AuditU3ClaudeDeepenWatch(pm, hook, executor, receiver);
        _watchedBy(keeper);
        _assertWord(created, closedAt, migratedAt, vm.getBlockNumber(), false);
        _advance(300);
        _watchedBy(keeper);
        assertGt(hook.pairedLiquidity(), 0);
        _assertWord(created, closedAt, migratedAt, vm.getBlockNumber(), true);
        address ext = hook.extension();
        for (uint256 slot; slot < 4; ++slot) {
            assertEq(vm.load(ext, bytes32(slot)), bytes32(0), "the extension's own storage stays empty");
        }
    }

    function _assertWord(uint256 deployB, uint256 closedB, uint256 migratedB, uint256 deepenB, bool pair)
        internal
        view
    {
        uint256 w = uint256(vm.load(a.hook, bytes32(0)));
        uint256 m40 = (uint256(1) << 40) - 1;
        assertEq(w & 1, 1, "launched");
        assertEq((w >> 8) & m40, deployB, "deployBlock");
        assertEq((w >> 8) & m40, hook.deployBlock());
        assertEq((w >> 48) & m40, hook.openAt(), "openAt");
        assertEq((w >> 48) & m40, createdAt + AUDIT_OPEN_DELAY);
        assertEq((w >> 88) & m40, closedB, "closedAtBlock");
        assertEq((w >> 128) & m40, migratedB, "migratedAtBlock");
        assertEq((w >> 168) & m40, deepenB, "lastDeepenBlock");
        bool graduated = migratedB != 0;
        assertEq((w >> 232) & 1 == 1, graduated && _askL() != 0, "ask bit");
        assertEq((w >> 233) & 1 == 1, graduated && _bidL() != 0, "bid bit");
        assertEq((w >> 234) & 1 == 1, graduated && _sentinelL() != 0, "sentinel bit");
        assertEq((w >> 235) & 1 == 1, pair, "pair bit");
        assertEq(_pairL() != 0, pair, "the pair bit says whether the pair exists");
        assertEq(w & W_LOW_GAP_MASK, 0, "bits 1-7");
        assertEq(w & W_UNUSED_MASK, 0, "bits 208-231 (F77)");
        assertEq(w & W_HIGH_MASK, 0, "bits 236-255");
        assertEq(uint256(vm.load(a.hook, bytes32(uint256(1)))), hook.reserveMinted(), "slot 1: reserveMinted");
    }

    // ------------------------------------------------------------------------------------------------ helpers

    /// @dev Graduated, the tax swept, 300 blocks on, the whale holding T (bought on the curve), the watch and the
    /// taker.
    function _graduatedWithBudget() internal {
        _toBonding();
        _buy(whale, 0.5 ether);
        _toGraduated();
        vm.prank(keeper);
        launchRouter.sweep();
        _advance(300);
        watch = new AuditU3ClaudeDeepenWatch(pm, hook, executor, receiver);
        taker = new AuditU3ClaudeTipTaker(pm, a.hook, a.receiver, poolKey);
        _ghostAddOutside(address(taker));
    }

    /// @dev Arms the taker to sell `t` T inside the next tip, the T moved to it from the whale (outside to outside).
    function _armTaker(uint256 t) internal {
        _transferT(whale, address(taker), t);
        taker.arm(t);
    }

    function _watchedBy(address caller) internal returns (AuditU3DeepenRec memory r) {
        uint256 e0 = caller.balance;
        r = watch.deepenAs(caller, caller);
        _noteEthChange(e0, caller.balance, EthIn.Other, EthOut.Tip);
        (uint8 code, string memory why) = watch.violation(r);
        assertEq(code, 0, why);
        assertTrue(r.skip == uint8(DeepenSkip.None), "acted");
    }
}
