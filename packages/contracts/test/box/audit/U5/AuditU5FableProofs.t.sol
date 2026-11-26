// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IBoxToken} from "../../../../src/box/interfaces/IBoxToken.sol";
import {AuditU5FableBase, AuditU5FableExecLogs} from "./AuditU5FableBase.sol";

/// @title AuditU5FableProofsTest
/// @notice SH-AUDIT-B0-U5-F proof tests (plan § 1.1): each pins a behaviour observed at `sh-audit-b0` and passes
/// while it exists; at fix time it flips into the property assertion.
/// forge-config: default.evm_version = "osaka"
contract AuditU5FableProofsTest is AuditU5FableBase {
    // Not a register row (triage 2b row 3); accepted as built (FQ-23, F147): the floor cannot bind on box 0.
    /// @notice Proof 25 (severity: note). Property: "If T's floor refuses a burn, the executor either does not buy or
    /// holds the T in a documented way; never a revert that blocks `execute` for good" (unit brief P5.2; the lane
    /// ticket's item 2: "execute skips without spending budget, and later calls still make progress"); P5.11 "execute
    /// never reverts after graduation"; the receiver (`BoxReceiver.sol:963-975`, BC-016) and the stream
    /// (`BoxItemStream.sol:644-652`, `BurnRefused`) both catch a refused burn and let the T wait.
    /// Source of the behaviour: `FitBuybackExecutor.sol:513-524` `_burnHeld` calls `token.burn(amount)` with no
    /// try/catch after the chunk was bought inside `execute`'s own unlock, so a `BurnBelowSupplyFloor` revert from
    /// T (`BoxToken.sol:122-136`) reverts the whole execution.
    /// Expected (per P5.2): the execution skips the buy or keeps the T, and reports `Stop.*`; the budget is spent or
    /// kept, but the call returns.
    /// Observed: `execute` reverts with T's own error; nothing is spent (the revert undoes the swap), and every later
    /// `execute` reverts the same way until the floor relaxes, because each one buys again and burns again. Unsolicited
    /// T sent to the executor makes every execution revert too while the floor binds, batch or not.
    /// Steps: graduated box 0, the FIT share paid into the budget (0.0302 ETH, one batch of 0.0101 ETH buys 493,932
    /// FIT); T's `burn(uint256)` made to revert `BurnBelowSupplyFloor(1, 2)` (stand-in by `vm.mockCallRevert`, the
    /// only way to make the real vault's floor bind: on box 0 it cannot, see the evidence); `execute(1)` reverts,
    /// budget unchanged; a gift of 1 T then `execute(1)` reverts too; mock cleared, `execute(1)` buys one chunk.
    /// Reachability on box 0: the floor is E + n (escrow principal plus items inside); the executor burns only what it
    /// bought in the same call plus gifts, and the pool's locked positions always hold T beyond any chunk's 49 ticks,
    /// so supply − burn ≥ E + (the pool's T) > E + n: the floor never binds for the executor on box 0. The defect is
    /// a robustness gap against the stated property, with no reachable effect: severity note.
    function testAccepted_AUDIT_U5_25_executeRevertsWhenTheBurnIsRefused() public {
        _toGraduated();
        _payFit(keeper);
        uint256 budget = executor.budget();
        assertGe(budget, executor.batchThreshold(), "a batch is open");
        bytes memory floorError =
            abi.encodeWithSelector(IBoxToken.BurnBelowSupplyFloor.selector, uint256(1), uint256(2));
        vm.mockCallRevert(a.token, IBoxToken.burn.selector, floorError);
        // Observed: the whole execution reverts with the token's error (no skip, no `Stop` reason).
        vm.expectRevert(floorError);
        vm.prank(keeper);
        executor.execute(1);
        assertEq(executor.budget(), budget, "nothing spent (the swap was undone with the revert)");
        assertEq(token.balanceOf(a.executor), 0, "nothing held");
        // Observed: with unsolicited T held, even an execution that would buy nothing reverts while the floor binds.
        _transferT(eoa[2], a.executor, 1);
        _advance(1);
        vm.expectRevert(floorError);
        vm.prank(keeper);
        executor.execute(0);
        // Once the floor relaxes, the next execution buys and burns (progress resumes; the budget was never lost).
        vm.clearMockedCalls();
        AuditU5FableExecLogs.ExecLog memory e = _execute(keeper, 1);
        assertEq(e.chunks, 1, "progress once the floor relaxes");
        assertEq(e.unsolicitedBurned, 1, "the gift burned with it");
        assertEq(executor.budget(), budget - e.ethSpent);
        _assertGhostLedger();
    }

    /// X − X₀ modulo N: how far the next J increment is.
    function _dust() internal view returns (uint256) {
        return (stream.streamValue() - stream.startValue()) % editionSize;
    }

    // W2-U5-1, accepted as built (FQ-22, F147): owners short by at most N - 1 - m raw units until the next fee.
    /// @notice Proof 26 (severity: note). Property: "keeping m back means a later full collect always covers every
    /// owner" (`BoxItemStream.sol:628-630`, the NatSpec of `_burnSurplus`; the interface: the stream keeps the owners'
    /// accrual "plus one raw unit per slot outside once started (J is floored), before it burns",
    /// `IBoxItemStream.sol` `liabilities()`); unit brief P5.3 "Σ claimed + Σ claimable + Σ burned ≤ Σ received at
    /// every point, equality up to the documented 1 raw unit kept per claim and per-item flooring".
    /// Source of the behaviour: the margin kept at a burn is m, the slots outside at that moment
    /// (`_burnSurplus`, `:635`). A slot that leaves the vault after the burn (`_rebook`, `:475-481`) is owed a whole
    /// raw unit at the next increment of J = ⌊(X − X₀)/N⌋ (`:335-346`), while the rise of X behind that increment can
    /// be as small as 13 raw units (one fifteenth of a 15-unit T fee); the collect that brings that rise in adds only
    /// it, so the first collect after k new slots can leave owners short by up to k − 13 raw units.
    /// Expected (per the NatSpec): held ≥ liabilities after every full collect.
    /// Observed: with 30 takes by number between a burn and a 26-raw-unit rise, the collect leaves held 4 raw units
    /// (4e-18 FIT) below liabilities; a claim then pays up to what is held and leaves the rest owed; the next batch
    /// covers everyone again. No value is lost or created: the shortfall is bounded by the new slots, in raw units,
    /// and never repeats without new slots. Within the brief's per-item flooring allowance; the sentence "always
    /// covers" holds from the second batch on. Severity note (documentation against code, no effect).
    /// Steps: terminal mode, 3 days on (takes by number need no reveal); a sell and a collect (the notice's burn:
    /// held = liabilities + m); dust sells of 2,000 raw T (fee about 20 raw) until X − X₀ is within 13 raw units of
    /// the next multiple of N; a collect; 30 takes by number (m + 30, J unchanged); one dust sell (X + 26, J + 1,
    /// liabilities + m + 30); a collect: held < liabilities by 4; a normal batch: covered.
    function testAccepted_AUDIT_U5_26_collectAfterNewSlotsLeavesOwnersShortByRawUnits() public {
        _toTerminal();
        _warpTo(uint256(tickets.status().terminalAt) + tickets.TAKE_DELAY() + 1);
        _sell(eoa[4], token.balanceOf(eoa[4]) / 2);
        _collectWithQ(keeper);
        uint256 n = editionSize;
        // Steer the dust (X − X₀ mod N) to within 13 raw units of the next increment with dust sells (fee ~20 raw).
        uint256 guard;
        while (_dust() < n - 13 && guard++ < 600) {
            _sell(eoa[4], 2_000);
        }
        assertGe(_dust(), n - 13, "dust steered");
        _collectWithQ(keeper);
        assertGe(_dust(), n - 13, "a collect leaves X");
        uint256 j0 = stream.index();
        uint256 held0 = _streamT();
        uint256 liabilities0 = stream.liabilities();
        uint256 m0 = stream.outsideCount();
        assertGe(held0, liabilities0, "covered after the burn");
        assertLe(held0 - liabilities0, m0, "only the margin stays");
        // 30 slots leave the vault: takes by number (no X change, no J change).
        uint256 got;
        for (uint256 idx; got < 30 && idx < 300; ++idx) {
            (uint256 item, bool hidden) = _poolItem(idx);
            if (!hidden) continue;
            _takeByNumber(eoa[2], item, idx, false);
            ++got;
        }
        assertEq(got, 30);
        assertEq(stream.index(), j0, "J unchanged by the takes");
        assertEq(stream.outsideCount(), m0 + 30);
        // One dust sell rolls J over: every slot outside, the 30 new ones included, is owed one more raw unit.
        _sell(eoa[4], 2_000);
        assertEq(stream.index(), j0 + 1, "J incremented by the smallest rise");
        assertEq(stream.liabilities(), liabilities0 + m0 + 30, "every slot outside got a raw unit");
        _collectWithQ(keeper);
        uint256 held = _streamT();
        uint256 liabilities = stream.liabilities();
        emit log_named_uint("held after the collect", held);
        emit log_named_uint("liabilities after the collect", liabilities);
        emit log_named_uint("short by (raw units)", liabilities - held);
        // Observed: the collect brought 13-26 raw units for 30 new slots, so the owners are not covered.
        assertLt(held, liabilities, "owners uncovered right after this collect");
        assertLe(liabilities - held, 30 - 13, "by at most the new slots less the smallest rise, in raw units");
        // The next batch covers everyone again (no value lost: the shortfall stayed owed).
        _sell(eoa[4], token.balanceOf(eoa[4]) / 4);
        _collectWithQ(keeper);
        assertGe(_streamT(), stream.liabilities(), "covered after the next batch");
        _assertGhostLedger();
    }
}
