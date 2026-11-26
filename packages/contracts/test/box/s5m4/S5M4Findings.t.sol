// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VmSafe} from "forge-std/Vm.sol";
import {BoxLayoutV1} from "../../../src/box/BoxLayoutV1.sol";
import {BoxReceiver} from "../../../src/box/BoxReceiver.sol";
import {FitBuybackExecutor} from "../../../src/box/FitBuybackExecutor.sol";
import {S5M4Base} from "./S5M4Base.sol";
import {S5M4Kit} from "./S5M4Kit.sol";

/// @notice Two facts S5.M4's measurements turned up, pinned so the review can see them (docs/evidence/SH-misfits-line.md
/// § S5.M4, findings, and § Review, finding 4).
/// 1. A `payFit()` (or box 0's `payPlatform()`) empties the receiver's ledger slot `fitOwed | platformOwed`, so the next
///    `collect()` writes that slot from zero again (≈ 98k of state gas under Glamsterdam, EIP-8037). Not a defect of
///    the built rules; it changes what a keeper pays.
/// 2. FIT's executor seeded its average at the curve's start (P0); nothing samples it during the curve unless someone
///    pokes it, and after graduation its sample walked to P1 at most 100 ticks a sample, 26,880 ticks for one raise, so
///    its first buy-and-burn (and box 0's first deepen(), which reads the same average) waited for that walk and the
///    hour's average to follow (first buy at the 576th sample here), unless a keeper poked it during the curve. Since
///    the review the planner seeds it at P1, where graduate() leaves the price (as Standard boxes' samplers start), and
///    the factory checks that seed: with no poke during the curve the average is P1 at graduation, and only a price
///    move after it has to be followed (first buy at the 318th sample here, after a 2,077-tick move).
contract S5M4FindingsTest is S5M4Base {
    function setUp() public {
        _setUpLocal();
        _createAll();
        a = k.addresses();
    }

    function test_finding_aCollectAfterPayFitWritesTheOwedSlotFromZero() public {
        _box0Graduated();
        _stdGraduated(D);
        S5M4Kit.StdBox memory x = _std(D);
        BoxReceiver r = BoxReceiver(payable(x.receiver));
        _trade(x.key, x.token, 1 ether, 2);
        r.collect(keeper);
        assertGt(r.fitOwed(), 0, "fixture: FIT's share owed");
        // Slot 1 of the receiver (BoxReceiverBase: `_s` at 0, then `Ledgers _l`): fitOwed | platformOwed.
        assertTrue(vm.load(x.receiver, bytes32(uint256(1))) != bytes32(0));
        r.payFit();
        assertEq(vm.load(x.receiver, bytes32(uint256(1))), bytes32(0), "payFit leaves the slot zero");
        _trade(x.key, x.token, 1 ether, 2);
        vm.startStateDiffRecording();
        r.collect(keeper);
        VmSafe.AccountAccess[] memory acc = vm.stopAndReturnStateDiff();
        assertTrue(_writtenFromZero(acc, x.receiver, bytes32(uint256(1))), "the next collect writes it from zero");
    }

    /// Before the review the same run first bought at its 576th sample after graduation (the walk of 26,880 ticks from
    /// P0, then the hour; S5.M4 pinned it as "301 not enough, 700 enough"). Now the average is P1 at graduation with no
    /// poke during the curve, and after the kit's trades right after graduation (2,077 ticks) about an hour of samples
    /// is enough (318), as for a Standard box's sampler (S5.M4: 300 samples): the hour's average must come within 99
    /// ticks of the moved price (the checkpoint ring's 515-second spacing adds a few minutes). Logged as
    /// `S5M4|FIT executor's first buy after graduation, samples`.
    function test_finding_fitsExecutorStartsAtP1SoAnHourOfSamplesIsEnough() public {
        BoxLayoutV1.Curve memory c = k.curve();
        assertEq(c.tickStart - c.tickEnd, 26_880, "P0 to P1: 26,880 ticks for one raise");
        assertEq(c.tickEnd, c.tickLower, "P1 is the curve's lower tick (ETH is currency0)");
        FitBuybackExecutor ex = FitBuybackExecutor(payable(a.executor));
        assertEq(ex.latestSampleTick(), c.tickEnd, "seeded at P1 when box 0 was created, not at P0");
        // No poke during the curve; graduate() pokes it once, at P1; then the kit's buy and sell move the price.
        k.toGraduated();
        (bool ready, int24 avg,) = ex.twap();
        assertTrue(ready, "ready at graduation: box 0 was created more than an hour before");
        assertEq(avg, c.tickEnd, "the hour's average is P1, not P0: no walk of 26,880 ticks");
        _fundFees(a.receiver, 3 ether);
        BoxReceiver(payable(a.receiver)).payFit();
        uint256 n;
        uint256 chunks;
        while (chunks == 0 && n < 330) {
            _hold(a.executor, 1);
            ++n;
            uint256 snap = vm.snapshotState();
            (chunks,,) = ex.execute(1);
            if (chunks == 0) vm.revertToState(snap);
        }
        emit log_named_uint("S5M4|FIT executor's first buy after graduation, samples", n);
        assertEq(chunks, 1, "it buys within 330 samples (66 minutes at 12 s; 576 from P0)");
        assertGt(n, 250, "not before the hour's average has followed the moved price");
        int256 gap = int256(ex.latestSampleTick()) - int256(_tick(k.poolKey()));
        assertLe(gap < 0 ? -gap : gap, 100, "its sample caught up with box 0's price");
    }

    function _writtenFromZero(VmSafe.AccountAccess[] memory acc, address who, bytes32 slot)
        internal
        pure
        returns (bool)
    {
        for (uint256 i; i < acc.length; ++i) {
            for (uint256 j; j < acc[i].storageAccesses.length; ++j) {
                VmSafe.StorageAccess memory w = acc[i].storageAccesses[j];
                if (w.account == who && w.slot == slot && w.isWrite && !w.reverted && w.previousValue == bytes32(0)) {
                    return w.newValue != bytes32(0);
                }
            }
        }
        return false;
    }
}
