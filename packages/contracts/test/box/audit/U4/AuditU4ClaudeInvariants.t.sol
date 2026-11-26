// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {AuditU4ClaudeBase, U4Books} from "./AuditU4ClaudeBase.sol";
import {AuditU4ClaudeHandler, IU4Weth, U4HandlerWorld} from "./AuditU4ClaudeHandler.sol";

/// @title AuditU4ClaudeCampaign
/// @notice TEST ONLY (SH-AUDIT-B0 U4, Claude). What the invariant worlds and the handler's reach test share: the
/// handler's view of the world (six EOAs as callers; tips to two EOAs, the contract drawer, the EIP-7702 EOA and the
/// receiver itself; refusing tips to the world's `ethRefuser` and `gasBurner`), its selectors, and the late world.
abstract contract AuditU4ClaudeCampaign is AuditU4ClaudeBase {
    function _handlerWorld() internal view returns (U4HandlerWorld memory w) {
        w.pm = pm;
        w.a = a;
        w.key = poolKey;
        w.swapper = routerSwapper;
        w.gifter = gifter;
        w.actors = new address[](6);
        for (uint256 i; i < 6; ++i) {
            w.actors[i] = eoa[i];
        }
        w.tipTos = new address[](5);
        w.tipTos[0] = eoa[4];
        w.tipTos[1] = eoa[5];
        w.tipTos[2] = address(contractDrawer);
        w.tipTos[3] = eoa7702;
        w.tipTos[4] = a.receiver; // a self-tip: plain ETH that only fundDepth takes (P4.5)
        w.badTips = new address[](2);
        w.badTips[0] = address(ethRefuser);
        w.badTips[1] = address(gasBurner);
        w.sqrtP1 = curve.sqrtPriceLowerX96;
        w.raise = raise;
    }

    function _selectors() internal pure returns (bytes4[] memory sel) {
        sel = new bytes4[](20);
        sel[0] = AuditU4ClaudeHandler.buy.selector;
        sel[1] = AuditU4ClaudeHandler.sell.selector;
        sel[2] = AuditU4ClaudeHandler.collect.selector;
        sel[3] = AuditU4ClaudeHandler.collectBadTip.selector;
        sel[4] = AuditU4ClaudeHandler.fundFees.selector;
        sel[5] = AuditU4ClaudeHandler.fundDepth.selector;
        sel[6] = AuditU4ClaudeHandler.giftClaims.selector;
        sel[7] = AuditU4ClaudeHandler.giftCoordinator.selector;
        sel[8] = AuditU4ClaudeHandler.forceEth.selector;
        sel[9] = AuditU4ClaudeHandler.payRoyalty.selector;
        sel[10] = AuditU4ClaudeHandler.payRoyaltyStipend.selector;
        sel[11] = AuditU4ClaudeHandler.flush.selector;
        sel[12] = AuditU4ClaudeHandler.payFit.selector;
        sel[13] = AuditU4ClaudeHandler.payPlatform.selector;
        sel[14] = AuditU4ClaudeHandler.onGraduation.selector;
        sel[15] = AuditU4ClaudeHandler.execute.selector;
        sel[16] = AuditU4ClaudeHandler.deepen.selector;
        sel[17] = AuditU4ClaudeHandler.closeAndGraduate.selector;
        sel[18] = AuditU4ClaudeHandler.warp.selector;
        sel[19] = AuditU4ClaudeHandler.warp.selector; // the clock twice as often: epoch edges are the point
    }

    /// @notice Box 0 graduated with the receiver's poke failing (harness, `_toGraduatedLate`), with held P of a 50 ETH
    /// pre-graduation fundFees, the curve's held parts, a 0.3 ETH final batch and 2 ETH of gifts to the coordinator;
    /// then `lateBy` seconds pass with no receiver call (the settlement waits for the first one).
    function _toLateWorld(uint256 lateBy) internal {
        _toBonding();
        _fundFees(eoa[1], 50 ether);
        _batchOf(0.3 ether);
        _giftEth(a.coordinator, 2 ether);
        _toGraduatedLate();
        if (lateBy != 0) {
            vm.roll(vm.getBlockNumber() + 1 + lateBy / 12);
            vm.warp(vm.getBlockTimestamp() + lateBy);
        }
    }
}

/// @title AuditU4ClaudeInvariants
/// @notice TEST ONLY (SH-AUDIT-B0 U4, Claude). The invariant suite the unit brief asks for, on the factory's box 0
/// after graduation (settled inside graduate()), with `AuditU4ClaudeHandler` driving collect (good and refusing tip
/// recipients), fundFees, fundDepth, royalties (all gas and 2,300-gas stipends) with flush and sweep, payFit,
/// payPlatform, onGraduation, forced ETH, claim gifts, FIT's executor's buys, deepen(), trades and clock steps across
/// 30-day epoch edges ± 1 s. Three more worlds inherit the same invariants: `AuditU4ClaudeLateInvariants` (graduated
/// with the receiver's poke failing: the first receiver call in the campaign settles late, harness as M31),
/// `AuditU4ClaudeLateEpochInvariants` (the same, 45 days on: the late settlement runs in epoch 1) and
/// `AuditU4ClaudeBondingInvariants` (on the curve, with coordinator gifts, the close and graduate() as actions).
/// Sources per invariant below; plan § 3.1 X01, X07, X08, X09.
/// forge-config: default.evm_version = "osaka"
contract AuditU4ClaudeInvariants is AuditU4ClaudeCampaign {
    AuditU4ClaudeHandler internal handler;

    /// @dev The receiver's totals and held parts when the campaign starts (the identities are over the campaign's
    /// own batches, whose events the handler reads).
    U4Books internal base;

    function setUp() public virtual override {
        super.setUp();
        _toWorld();
        handler = new AuditU4ClaudeHandler(_handlerWorld(), _canGraduate());
        base = _books();
        targetContract(address(handler));
        targetSelector(StdInvariant.FuzzSelector({addr: address(handler), selectors: _selectors()}));
    }

    function _toWorld() internal virtual {
        _toGraduated();
    }

    function _canGraduate() internal pure virtual returns (bool) {
        return false;
    }

    // ================================================================================================ invariants

    /// P4.3 (BC-015, IBoxReceiver.sol:62-64): the receiver's claims cover Σ ledgers, and box 0's ledgers are exactly
    /// FIT, the Safe's credit, the held P and depth, and the carries (< 15); the next batch changes only as each action
    /// allows (handler ghost `unbookedWrong`); the receiver holds T only while a burn is pending.
    function invariant_AUDIT_U4_claimsCoverLedgersAndNextBatch() public view {
        U4Books memory b = _books();
        assertGe(b.claimsQ, b.bookedQ, "Q claims >= Q ledgers");
        assertGe(b.claimsT, b.bookedT, "T claims >= T ledgers");
        assertLt(b.qCarry, 15, "Q carry < 15");
        assertLt(b.tCarry, 15, "T carry < 15");
        assertEq(b.bookedQ, b.fitOwed + b.platformOwed + b.platformHeld + b.depthHeldQ + b.qCarry, "box 0's Q ledgers");
        assertEq(b.bookedT, b.depthHeldT + b.tCarry, "box 0's T ledgers");
        assertEq(b.receiverT, b.tBurnPending, "T held only to burn");
        if (receiver.graduationSettled()) {
            assertEq(b.platformHeld + b.depthHeldQ + b.depthHeldT, 0, "nothing held after the settlement");
        }
        assertEq(handler.unbookedWrong(), 0, string.concat("the next batch moved wrongly in ", handler.lastWhere()));
    }

    /// P4.4 (BC-106, BC-107, BC-141): every epoch's credit (PlatformCredited `kept`, by the epoch the event names) is
    /// at most 32 ETH; platformEpoch's `kept` equals the current epoch's credits; everything credited is paid or owed;
    /// the Safe's ETH rises only through payPlatform, by exactly what was paid.
    function invariant_AUDIT_U4_platformCreditPerEpochCapped() public view {
        uint256 maxEpoch = handler.maxEpoch();
        for (uint256 e; e <= maxEpoch; ++e) {
            assertLe(handler.creditedInEpoch(e), CAP, "at most 32 ETH credited in an epoch");
        }
        if (receiver.graduationSettled()) {
            (uint256 ep, uint256 kept,) = receiver.platformEpoch();
            assertEq(kept, handler.creditedInEpoch(ep), "the epoch counter == the epoch's credits");
        }
        assertEq(handler.creditedTotal(), handler.paidToSafe() + receiver.platformOwed(), "credited == paid + owed");
        assertEq(safe.balance, handler.safe0() + handler.paidToSafe(), "the Safe: payPlatform only");
        assertEq(handler.safeMovedElsewhere(), 0, "the Safe's ETH moved outside payPlatform");
        assertEq(handler.eventsMismatch(), 0, string.concat("events vs totals in ", handler.lastWhere()));
    }

    /// P4.1, P4.2 (F77; BC-015, BC-133, BC-139): over the whole campaign the splits are exact in fifteenths, read from
    /// the receiver's totals and events: 2 × (FIT − returned executor notes) == 11 × (P kept + P excess + P held);
    /// 11 × (Q depth − cap excess − fundDepth) == 2 × (FIT − notes); 2 × (T burned + pending + streamed) == 13 × T depth.
    function invariant_AUDIT_U4_splitsExactAcrossTheLife() public view {
        U4Books memory b = _books();
        uint256 fit = b.toFit - base.toFit - handler.moduleQReturned();
        uint256 p = (b.toPlatform - base.toPlatform) + handler.capExcessTotal() + b.platformHeld - base.platformHeld;
        assertEq(2 * fit, 11 * p, "Q: FIT 11 : platform 2");
        uint256 depth = b.qToDepth - base.qToDepth - handler.capExcessTotal() - handler.fundDepthTotal();
        assertEq(11 * depth, 2 * fit, "Q: FIT 11 : depth 2");
        uint256 tRest = (b.tBurned + b.tBurnPending) - (base.tBurned + base.tBurnPending) + handler.streamedT();
        assertEq(2 * tRest, 13 * (b.tToDepth - base.tToDepth), "T: burned or streamed 13 : depth 2");
    }

    /// P4.7, X01 (the receiver's two payable ledgers): every wei ever credited to FIT's ledger is paid to the executor
    /// or still owed, and every wei credited to the Safe's is paid or owed: Δ(toFit − fitOwed) == Σ payFit and
    /// Δ(toPlatform − platformOwed) == Σ payPlatform (BoxReceiver.sol:333-355, :657-658, :752-753, :920-921).
    function invariant_AUDIT_U4_creditedEqualsPaidPlusOwed() public view {
        U4Books memory b = _books();
        assertEq(
            (b.toFit - b.fitOwed) - (base.toFit - base.fitOwed), handler.paidToFit(), "FIT: credited - owed == paid"
        );
        assertEq(
            (b.toPlatform - b.platformOwed) - (base.toPlatform - base.platformOwed),
            handler.paidToSafe(),
            "the Safe: credited - owed == paid"
        );
    }

    /// X01, X08, P4.5-P4.7, P4.10-P4.16 as handler ghosts: a collect refused only for the minimum (and a refusing tip
    /// recipient paid nothing); intake never reverts; payouts move exactly the owed amounts; the receiver's plain ETH is
    /// the forced ETH and self-tips only; the router accepts every payment (stipends too), its ETH and WETH leave only
    /// into fundFees and it holds exactly what was paid; the executor's ETH moves only through payFit and its own buys;
    /// coordinator gifts are forwarded whole at graduation; no PoolManager delta left open; the settlement once;
    /// nothing paid before graduation.
    function invariant_AUDIT_U4_noHandlerGhost() public view {
        string memory w = handler.lastWhere();
        assertEq(handler.collectRefusedOther(), 0, "collect refused for another reason than the minimum");
        assertEq(handler.badTipPaid(), 0, "a refusing tip recipient was paid");
        assertEq(handler.intakeReverted(), 0, "fundFees or fundDepth reverted");
        assertEq(handler.payoutWrong(), 0, string.concat("a payout moved the wrong amount: ", w));
        assertEq(handler.rawEthWrong(), 0, string.concat("plain ETH in the receiver: ", w));
        assertEq(a.receiver.balance, handler.expectedRawEth(), "the receiver's plain ETH");
        assertEq(handler.routerLeak(), 0, string.concat("the router: ", w));
        assertEq(
            a.royaltyRouter.balance + IU4Weth(a.weth).balanceOf(a.royaltyRouter), handler.routerHeld(), "router holds"
        );
        assertEq(handler.executorMovedElsewhere(), 0, "the executor's ETH");
        assertEq(
            a.executor.balance, handler.executor0() + handler.paidToFit() - handler.executorSpent(), "executor ETH"
        );
        assertEq(handler.coordinatorGiftWrong(), 0, "coordinator gifts");
        assertEq(handler.openDelta(), 0, string.concat("an open PoolManager delta after ", w));
        assertEq(handler.settleWrong(), 0, string.concat("the settlement: ", w));
        assertEq(handler.paidBeforeGraduation(), 0, string.concat("paid before graduation in ", w));
    }
}

/// @title AuditU4ClaudeLateInvariants
/// @notice The same invariants with the receiver's graduation poke failed (harness): held P of a 50 ETH pre-graduation
/// fundFees, the curve's held parts, a final batch and forwarded coordinator gifts wait for the first receiver call
/// of the campaign, whenever it comes (epoch 0 however late, BC-106, BC-143).
/// forge-config: default.evm_version = "osaka"
contract AuditU4ClaudeLateInvariants is AuditU4ClaudeInvariants {
    function _toWorld() internal virtual override {
        _toLateWorld(0);
    }
}

/// @title AuditU4ClaudeLateEpochInvariants
/// @notice The late world 45 days after graduation: the first receiver call settles in epoch 1, crediting the held P
/// and the final batch in epoch 0 and its own P in epoch 1 (BC-106: "however late the settlement runs").
/// forge-config: default.evm_version = "osaka"
contract AuditU4ClaudeLateEpochInvariants is AuditU4ClaudeInvariants {
    function _toWorld() internal override {
        _toLateWorld(45 days);
    }
}

/// @title AuditU4ClaudeBondingInvariants
/// @notice The same invariants from the curve (bonding): nothing paid before graduation (X08, BC-020), coordinator
/// gifts, then the close and graduate() as a handler action, after which the graduated rules hold.
/// forge-config: default.evm_version = "osaka"
contract AuditU4ClaudeBondingInvariants is AuditU4ClaudeInvariants {
    function _toWorld() internal override {
        _toBonding();
    }

    function _canGraduate() internal pure override returns (bool) {
        return true;
    }
}

/// @title AuditU4ClaudeAmsterdamInvariants
/// @notice The graduated world's invariants under Amsterdam, so every handler action (the stream's capped notice, the
/// stipend payments, the payouts with all gas, the 7702 tip recipient) runs with that fork's gas schedule.
/// forge-config: default.evm_version = "amsterdam"
contract AuditU4ClaudeAmsterdamInvariants is AuditU4ClaudeInvariants {}
