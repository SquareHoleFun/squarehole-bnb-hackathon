// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AuditSysInvariants} from "./AuditSysInvariants.sol";
import {AuditSysHandler} from "./AuditSysHandler.sol";

/// @title AuditSysCurveInvariants
/// @notice TEST ONLY (SH-AUDIT-B0 round 2, plan § 3.2 shard S1). Box 0 from its creation, an hour before `openAt`:
/// the window's taxed buys, bonding, takes and hand-backs, the close in its shapes and graduation at random gas, then
/// whatever the run reaches after it; weighted towards X01-X09, X16 and X20. Every invariant after every call; the
/// closing driver at the end of each run.
/// forge-config: default.evm_version = "osaka"
contract AuditSysCurveInvariants is AuditSysInvariants {
    AuditSysHandler internal h;

    function setUp() public override {
        super.setUp();
        h = new AuditSysHandler(this);
        _setUpSys("S1", address(h));
        safe0 = safe.balance;
        _weights();
        targetSelector(FuzzSelector({addr: address(h), selectors: selPool}));
        targetContract(address(h));
    }

    function _weights() internal {
        _w(AuditSysHandler.windowBuy.selector, 10);
        _w(AuditSysHandler.swapBuyIn.selector, 6);
        _w(AuditSysHandler.swapSellIn.selector, 4);
        _w(AuditSysHandler.swapBuyOut.selector, 2);
        _w(AuditSysHandler.swapSellOut.selector, 2);
        _w(AuditSysHandler.swapMulti.selector, 2);
        _w(AuditSysHandler.closeCurve.selector, 3);
        _w(AuditSysHandler.graduate.selector, 4);
        _w(AuditSysHandler.collect.selector, 4);
        _w(AuditSysHandler.fundFees.selector, 2);
        _w(AuditSysHandler.fundDepth.selector, 2);
        _w(AuditSysHandler.forceEth.selector, 2);
        _w(AuditSysHandler.royalty.selector, 2);
        _w(AuditSysHandler.flush.selector, 1);
        _w(AuditSysHandler.sweepWeth.selector, 1);
        _w(AuditSysHandler.routerSweep.selector, 2);
        _w(AuditSysHandler.payFit.selector, 1);
        _w(AuditSysHandler.payPlatform.selector, 1);
        _w(AuditSysHandler.claimReward.selector, 2);
        _w(AuditSysHandler.giftClaims.selector, 2);
        _w(AuditSysHandler.take.selector, 6);
        _w(AuditSysHandler.handBack.selector, 2);
        _w(AuditSysHandler.transferPlaceholder.selector, 2);
        _w(AuditSysHandler.requestWord.selector, 1);
        _w(AuditSysHandler.acceptWord.selector, 4);
        _w(AuditSysHandler.postAll.selector, 4);
        _w(AuditSysHandler.draw.selector, 3);
        _w(AuditSysHandler.settle.selector, 3);
        _w(AuditSysHandler.openPlaceholder.selector, 4);
        _w(AuditSysHandler.deepen.selector, 1);
        _w(AuditSysHandler.poke.selector, 1);
        _w(AuditSysHandler.execute.selector, 1);
        _w(AuditSysHandler.fundBudget.selector, 1);
        _w(AuditSysHandler.transferT.selector, 1);
        _w(AuditSysHandler.tToBox.selector, 2);
        _w(AuditSysHandler.burnT.selector, 1);
        _w(AuditSysHandler.probePool.selector, 1);
        _w(AuditSysHandler.warp.selector, 6);
    }
}
