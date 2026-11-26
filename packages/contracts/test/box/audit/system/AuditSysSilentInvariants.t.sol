// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AuditSysInvariants} from "./AuditSysInvariants.sol";
import {AuditSysHandler} from "./AuditSysHandler.sol";

/// @title AuditSysSilentInvariants
/// @notice TEST ONLY (SH-AUDIT-B0 round 2, plan § 3.2 shard S3). Box 0 graduated with drand silent from the start
/// (R0-A's `_toSilentFromGraduation`: the graduation word requested on r0, r0 never posted, the clock 5 days and 1 s
/// past r0's time, five placeholders live): backup starts and fixes inside and outside their windows, draws behind
/// the silent head, the 7-day silence and terminal mode, cancels, number-less hand-backs and takes by number. No round
/// is posted here (drand stays silent); weighted towards X11-X13, X19 and X21.
/// forge-config: default.evm_version = "osaka"
contract AuditSysSilentInvariants is AuditSysInvariants {
    AuditSysHandler internal h;

    function setUp() public virtual override {
        super.setUp();
        _toSilentFromGraduation();
        h = new AuditSysHandler(this);
        _setUpSys("S3", address(h));
        gRewardHolder = keeper;
        gReward = graduationReward;
        safe0 = safe.balance;
        _weights();
        targetSelector(FuzzSelector({addr: address(h), selectors: selPool}));
        targetContract(address(h));
    }

    function _weights() internal {
        _w(AuditSysHandler.startBackup.selector, 4);
        _w(AuditSysHandler.fixBackup.selector, 4);
        _w(AuditSysHandler.backupCycle.selector, 4);
        _w(AuditSysHandler.acceptWord.selector, 2);
        _w(AuditSysHandler.draw.selector, 4);
        _w(AuditSysHandler.drawMany.selector, 1);
        _w(AuditSysHandler.settle.selector, 2);
        _w(AuditSysHandler.openDraw.selector, 2);
        _w(AuditSysHandler.openPlaceholder.selector, 2);
        _w(AuditSysHandler.transferPlaceholder.selector, 1);
        _w(AuditSysHandler.enterTerminal.selector, 3);
        _w(AuditSysHandler.cancelDraw.selector, 3);
        _w(AuditSysHandler.takeByNumber.selector, 3);
        _w(AuditSysHandler.handBack.selector, 2);
        _w(AuditSysHandler.addBounty.selector, 1);
        _w(AuditSysHandler.swapBuyIn.selector, 2);
        _w(AuditSysHandler.swapSellIn.selector, 1);
        _w(AuditSysHandler.collect.selector, 2);
        _w(AuditSysHandler.fundFees.selector, 1);
        _w(AuditSysHandler.payFit.selector, 1);
        _w(AuditSysHandler.payPlatform.selector, 1);
        _w(AuditSysHandler.claimReward.selector, 1);
        _w(AuditSysHandler.pick.selector, 1);
        _w(AuditSysHandler.returnItem.selector, 2);
        _w(AuditSysHandler.reveal.selector, 1);
        _w(AuditSysHandler.transferItem.selector, 1);
        _w(AuditSysHandler.itemToBox.selector, 1);
        _w(AuditSysHandler.streamClaim.selector, 1);
        _w(AuditSysHandler.forceEth.selector, 1);
        _w(AuditSysHandler.tToBox.selector, 1);
        _w(AuditSysHandler.probePool.selector, 1);
        _w(AuditSysHandler.warp.selector, 8);
    }
}

/// @title AuditSysSilent6sInvariants
/// @notice The silent shard with 6-second blocks in the campaign's own clock moves (plan § 3.2: "a 6-s variant runs
/// once"): the block-counted rules (the backup's 256-block target and 8,191-block history, the deepen cooldown, one
/// executor chunk per block) against the time-counted ones (5 days, 5 days 18 hours, 7 days, 30 days).
/// forge-config: default.evm_version = "osaka"
contract AuditSysSilent6sInvariants is AuditSysSilentInvariants {
    function setUp() public override {
        super.setUp();
        blockSeconds = 6;
        shardName = "S3x6s";
    }
}
