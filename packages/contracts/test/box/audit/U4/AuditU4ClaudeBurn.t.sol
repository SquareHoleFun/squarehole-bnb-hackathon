// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FeeBatch} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxSupplyFloor, IBoxToken} from "../../../../src/box/interfaces/IBoxToken.sol";
import {AuditU4ClaudeBase, U4Books} from "./AuditU4ClaudeBase.sol";

/// @title AuditU4ClaudeBurnTest
/// @notice TEST ONLY (SH-AUDIT-B0 U4, Claude). P4.2's refused burn: box 0's T side is 13/15 burned before graduation,
/// and "a refused burn (the vault's supply floor) leaves it waiting, never counted as burned" (BoxReceiver.sol:963-975;
/// BC-016, BC-139: "a refused burn waits in tBurnPending ... and never touches the depth part"); the wait is retried by
/// every later `_payOut` (collect, the settlement), never by fundFees (no T side), and burns whole once allowed.
/// Stand-ins (the property is how the receiver treats a refusal): the vault's `supplyFloor()` answered above the
/// supply with `vm.mockCall` (T's own `burn` then refuses with BurnBelowSupplyFloor, BoxToken.sol:122-136, as at a
/// real floor E + n); across graduation, a `vm.mockCallRevert` on T's `burn` of exactly the waiting amount (so the
/// coordinator's dust burn in graduate() still runs).
/// forge-config: default.evm_version = "osaka"
contract AuditU4ClaudeBurnTest is AuditU4ClaudeBase {
    /// Before graduation: a refused burn leaves exactly 13/15 of the batch's T units waiting, as real T at the receiver,
    /// supply and `tBurned` unchanged, the 2/15 held for depth as usual; a second refused batch adds to the wait; once
    /// the floor allows, the next collect burns the waiting T and its own 13/15, each counted once.
    function testFuzz_AUDIT_U4_refusedBurnWaitsThenBurnsWhole(uint96 buyRaw, uint96 sellFracRaw) public {
        _toBonding();
        _tradeBothSides(bound(buyRaw, 0.55 ether, 1.2 ether), bound(sellFracRaw, 20, 100));
        _refuseBurns();
        U4Books memory b0 = _books();
        U4Books memory b1 = _refusedBatch(b0);
        assertEq(b1.receiverT, b1.tBurnPending, "as real T at the receiver");
        assertEq(b1.claimsT - b1.bookedT, 0, "nothing unbooked");
        // A second refused batch: the wait grows by its own 13/15.
        _tradeBothSides(0.6 ether, 50);
        U4Books memory b2 = _refusedBatch(b1);
        assertEq(b2.tSupply, b0.tSupply, "still nothing burned");
        // The floor allows again: the next collect burns everything waiting and its own share, once.
        vm.clearMockedCalls();
        _tradeBothSides(0.6 ether, 50);
        U4Books memory b3 = _books();
        FeeBatch memory b = _collect(keeper, keeper);
        U4Books memory b4 = _books();
        uint256 burnt = b3.tBurnPending + 13 * ((b.t + b3.tCarry) / FIFTEEN);
        assertEq(b4.tBurnPending, 0, "nothing waits");
        assertEq(b4.receiverT, 0, "no T left at the receiver");
        assertEq(b3.tSupply - b4.tSupply, burnt, "the waiting T and the new 13/15, burned");
        assertEq(b4.tBurned - b3.tBurned, burnt, "each counted as burned once");
        _assertNoOpenDelta();
        _assertGhostLedger();
    }

    /// @dev One collect while burns are refused: exactly 13/15 of its T units join the wait, nothing is burned or
    /// counted as burned, the 2/15 is held for depth, the T carry as computed.
    function _refusedBatch(U4Books memory b0) internal returns (U4Books memory b1) {
        FeeBatch memory b = _collect(keeper, keeper);
        b1 = _books();
        uint256 v = (b.t + b0.tCarry) / FIFTEEN;
        assertGt(v, 0, "a T side to burn");
        assertEq(b1.tBurnPending - b0.tBurnPending, 13 * v, "13/15 waits in tBurnPending");
        assertEq(b1.tSupply, b0.tSupply, "nothing burned");
        assertEq(b1.tBurned, b0.tBurned, "never counted as burned (BC-016)");
        assertEq(b1.depthHeldT - b0.depthHeldT, 2 * v, "the 2/15 held for depth, untouched by the refusal");
        assertEq(b1.tCarry, (b.t + b0.tCarry) % FIFTEEN, "the T carry");
    }

    /// Across graduation: a burn still refused at the settlement keeps waiting (the T side now streams, so nothing new
    /// is added), fundFees leaves it alone, the stream gets exactly its 13/15, and the first collect after the refusal
    /// ends burns the whole wait.
    function testProperty_AUDIT_U4_pendingBurnRetriedAfterGraduation() public {
        _toBonding();
        _tradeBothSides(1 ether, 50);
        _refuseBurns();
        _collect(keeper, keeper);
        uint256 pending = receiver.tBurnPending();
        assertGt(pending, 0, "a burn waits");
        vm.clearMockedCalls();
        vm.mockCallRevert(a.token, abi.encodeCall(IBoxToken.burn, (pending)), "u4: refused");
        _toGraduated();
        assertTrue(receiver.graduationSettled());
        assertEq(receiver.tBurnPending(), pending, "the settlement's retry refused: still waiting");
        _fundFees(eoa[1], 3 ether);
        assertEq(receiver.tBurnPending(), pending, "fundFees has no T side and no retry");
        _tradeBothSides(1 ether, 50);
        U4Books memory b0 = _books();
        FeeBatch memory b = _collect(keeper, keeper);
        U4Books memory b1 = _books();
        uint256 v = (b.t + b0.tCarry) / FIFTEEN;
        assertEq(b1.tBurnPending, pending, "a collect's retry refused too");
        assertEq(_streamIn(b0, b1), 13 * v, "the stream gets exactly its 13/15 meanwhile");
        vm.clearMockedCalls();
        _tradeBothSides(1 ether, 50);
        U4Books memory b2 = _books();
        _collect(keeper, keeper);
        U4Books memory b3 = _books();
        assertEq(b3.tBurnPending, 0, "the first collect after the refusal ends burns the whole wait");
        assertEq(b3.tBurned - b2.tBurned, pending, "counted once");
        assertEq(b3.receiverT, 0);
        _assertNoOpenDelta();
        _assertGhostLedger();
    }

    function _refuseBurns() internal {
        vm.mockCall(
            a.vault, abi.encodeWithSelector(IBoxSupplyFloor.supplyFloor.selector), abi.encode(type(uint256).max)
        );
    }

    /// A buy of `q` and a sell of `pct` % of what it bought: Q and T fees in the positions for the next collect.
    function _tradeBothSides(uint256 q, uint256 pct) internal {
        uint256 tOut = _buy(eoa[3], q);
        _advance(1);
        _sell(eoa[3], tOut * pct / 100);
        _advance(1);
    }
}
