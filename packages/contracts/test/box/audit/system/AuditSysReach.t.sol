// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Currency} from "v4-core/src/types/Currency.sol";
import {ItemReveal} from "../../../../src/box/interfaces/BoxTypes.sol";
import {EthIn, TIn, TOut} from "../common/AuditGhostLedger.sol";
import {AuditSysChecks} from "./AuditSysChecks.sol";
import {AuditSysHandler} from "./AuditSysHandler.sol";
import {Act, Exc} from "./AuditSysWorld.sol";

/// @title AuditSysReachSilentTest
/// @notice TEST ONLY (SH-AUDIT-B0 round 2, review of the system campaign). The handler's reach at the edges the review
/// found short or unmeasured, pinned on the campaign's own world from shard S3's start (graduated, r0 silent, the clock
/// inside r0's backup window): the fix of a backup exactly at the history window's edge (8,191 blocks past the target,
/// the last block EIP-2935 serves) passes and is counted at the edge; one block later it is refused.
/// forge-config: default.evm_version = "osaka"
contract AuditSysReachSilentTest is AuditSysChecks {
    AuditSysHandler internal h;

    function setUp() public override {
        super.setUp();
        _toSilentFromGraduation();
        h = new AuditSysHandler(this);
        _setUpSys("REACH3", address(h));
        gRewardHolder = keeper;
        gReward = graduationReward;
        safe0 = safe.balance;
    }

    /// @dev r0's backup through the handler's own action, no edge warp (S3's clock is inside the window).
    function _startR0Backup() internal returns (uint64 target) {
        h.startBackup(0, 2);
        assertEq(gStarted.length, 1, "fixture: the backup started");
        assertEq(gStarted[0], r0, "fixture: r0's backup");
        (, target,,) = src.backupOf(r0);
        assertGt(target, 0, "fixture: a target block");
    }

    /// The late mode of `fixBackup` lands on the history window's edge (8,191 blocks past the target): the fix passes
    /// there, the handler records it as the largest passing distance and counts the landing at the edge.
    function testReach_AUDIT_SYS_fixBackupAtTheHistoryWindowEdgePasses() public {
        uint64 target = _startR0Backup();
        // lateSeed 260: % 5 == 0 (the late mode), (>> 8) % 3 == 1 (the window's last block).
        h.fixBackup(0, 1, 260);
        assertEq(vm.getBlockNumber() - target, src.HISTORY_WINDOW(), "the fix ran 8,191 blocks past the target");
        (,, uint64 fixedAt,) = src.backupOf(r0);
        assertGt(fixedAt, 0, "the fix passed at the window's edge");
        assertEq(aOk[uint256(Act.FixBackup)], 1, "counted as a success");
        assertEq(gFixOkMaxDistance, src.HISTORY_WINDOW(), "recorded as the largest passing distance");
        assertEq(gEdge[3 * E_HISTORY + 1], 1, "counted at the edge");
        assertEq(violations, 0, lastViolation);
    }

    /// One block past the window the history contract serves nothing: the fix is refused (HeaderUnavailable), as the
    /// rule says, and recorded as the smallest refused distance.
    function testReach_AUDIT_SYS_fixBackupPastTheHistoryWindowIsRefused() public {
        uint64 target = _startR0Backup();
        // lateSeed 515: % 5 == 0, (>> 8) % 3 == 2 (one block past the window).
        h.fixBackup(0, 1, 515);
        assertEq(vm.getBlockNumber() - target, src.HISTORY_WINDOW() + 1, "8,192 blocks past the target");
        (,, uint64 fixedAt,) = src.backupOf(r0);
        assertEq(fixedAt, 0, "refused past the window");
        assertEq(aRefused[uint256(Act.FixBackup)], 1, "counted as a refusal");
        assertEq(gFixRefusedMinDistance, src.HISTORY_WINDOW() + 1, "recorded as the smallest refused distance");
        assertEq(gEdge[3 * E_HISTORY + 2], 1, "counted one block after the edge");
        assertEq(violations, 0, lastViolation);
    }
}

/// @title AuditSysReachSteadyTest
/// @notice From shard S2's start (graduated on r0, the word accepted, five Misfits outside, the window's tax in the
/// launch router): the sweep action forces no ETH of its own (the campaign's one forced-ETH action is `forceEth`,
/// plan § 3.2), and the next-batch exception (W1-U4-3) is sized in Q, never in raw T units.
/// forge-config: default.evm_version = "osaka"
contract AuditSysReachSteadyTest is AuditSysChecks {
    AuditSysHandler internal h;

    function setUp() public override {
        super.setUp();
        _toGraduated();
        _advance(1);
        _post(r0);
        vm.prank(keeper);
        tickets.acceptGraduationWord();
        h = new AuditSysHandler(this);
        _setUpSys("REACH2", address(h));
        gRewardHolder = keeper;
        gReward = graduationReward;
        for (uint256 id = 1; id <= 5; ++id) {
            address owner = tickets.ownerOf(id);
            ItemReveal memory r = tree.itemReveal(tickets.numberOf(id));
            vm.prank(owner);
            uint256 item = tickets.open(id, r);
            ++gBurnedPlaceholders;
            _noteDelivered(item);
        }
        _syncGhosts();
        safe0 = safe.balance;
    }

    /// A sweep of the window's tax, then a sweep of the empty router (an even seed): the action deals no ETH onto the
    /// router, so the ledger's forced class and the router's forced total do not move; the empty sweep is a refusal
    /// (NothingToSweep), not a violation.
    function testReach_AUDIT_SYS_routerSweepForcesNoEth() public {
        h.routerSweep(1);
        assertEq(aOk[uint256(Act.RouterSweep)], 1, "fixture: the window's tax swept");
        assertEq(a.launchRouter.balance, 0, "fixture: the router is empty");
        uint256 forced0 = ghostEthIn(EthIn.Forced);
        h.routerSweep(0);
        assertEq(ghostEthIn(EthIn.Forced), forced0, "the sweep action forced no ETH");
        assertEq(gForcedTotal[a.launchRouter], 0, "nothing forced onto the router by the action");
        assertEq(aRefused[uint256(Act.RouterSweep)], 1, "an empty sweep is refused");
        assertEq(violations, 0, lastViolation);
        _checkX01_ethConservation();
    }

    /// A stranger's T claims minted to the receiver (a T next batch, W1-U4-3's class): the exception counts it, and
    /// its size stays in Q (wei), so the campaign's "largest next batch" figure never mixes raw T units in.
    function testReach_AUDIT_SYS_nextBatchExceptionSizedInQ() public {
        uint256 amount = 1e18;
        address payer = eoa[0];
        vm.prank(payer);
        token.approve(address(lp), type(uint256).max);
        uint256 t0 = token.balanceOf(payer);
        lp.mintClaims(Currency.wrap(a.token), amount, payer, a.receiver);
        _noteTChange(t0, token.balanceOf(payer), TIn.Other, TOut.Other);
        (, uint256 tb) = receiver.booked();
        assertGe(pm.balanceOf(a.receiver, uint256(uint160(a.token))), tb + amount, "fixture: T claims above the ledger");
        uint256 c0 = excCount[uint256(Exc.W1_U4_3)];
        h.poke(0);
        assertGt(excCount[uint256(Exc.W1_U4_3)], c0, "the T next batch is counted");
        assertLt(excMax[uint256(Exc.W1_U4_3)], amount, "sized in Q, not in raw T units");
        _checkX09_claimsMatchLedgers();
        _checkX01_ethConservation();
    }
}
