// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ItemReveal} from "../../../../src/box/interfaces/BoxTypes.sol";
import {AuditSysInvariants} from "./AuditSysInvariants.sol";
import {AuditSysHandler} from "./AuditSysHandler.sol";

/// @title AuditSysSteadyInvariants
/// @notice TEST ONLY (SH-AUDIT-B0 round 2, plan § 3.2 shard S2). Box 0 graduated on r0 (R0-A's `_toGraduated`), r0
/// posted and the word accepted, the five placeholders opened with their reveals (five Misfits outside, each with its
/// stream slot), the window's tax still in the launch router: fees and epochs, depth, FIT's executor (its 1-hour
/// average fills as the run's clock moves), draws (a draw in the run's first blocks falls on a committed round, later
/// ones on silent rounds that only the backup answers), the stream, the vault and the collection; weighted towards
/// X01-X18.
/// forge-config: default.evm_version = "osaka"
contract AuditSysSteadyInvariants is AuditSysInvariants {
    AuditSysHandler internal h;

    function setUp() public override {
        super.setUp();
        _toGraduated();
        _advance(1);
        _post(r0);
        vm.prank(keeper);
        tickets.acceptGraduationWord();
        h = new AuditSysHandler(this);
        _setUpSys("S2", address(h));
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
        _weights();
        targetSelector(FuzzSelector({addr: address(h), selectors: selPool}));
        targetContract(address(h));
    }

    function _weights() internal {
        _w(AuditSysHandler.swapBuyIn.selector, 4);
        _w(AuditSysHandler.swapSellIn.selector, 4);
        _w(AuditSysHandler.swapBuyOut.selector, 2);
        _w(AuditSysHandler.swapSellOut.selector, 2);
        _w(AuditSysHandler.swapMulti.selector, 2);
        _w(AuditSysHandler.collect.selector, 6);
        _w(AuditSysHandler.fundFees.selector, 3);
        _w(AuditSysHandler.fundDepth.selector, 2);
        _w(AuditSysHandler.forceEth.selector, 1);
        _w(AuditSysHandler.royalty.selector, 2);
        _w(AuditSysHandler.flush.selector, 2);
        _w(AuditSysHandler.sweepWeth.selector, 1);
        _w(AuditSysHandler.routerSweep.selector, 1);
        _w(AuditSysHandler.payFit.selector, 3);
        _w(AuditSysHandler.payPlatform.selector, 3);
        _w(AuditSysHandler.claimReward.selector, 1);
        _w(AuditSysHandler.giftClaims.selector, 1);
        _w(AuditSysHandler.deepen.selector, 4);
        _w(AuditSysHandler.poke.selector, 2);
        _w(AuditSysHandler.execute.selector, 4);
        _w(AuditSysHandler.fundBudget.selector, 1);
        _w(AuditSysHandler.draw.selector, 5);
        _w(AuditSysHandler.drawMany.selector, 2);
        _w(AuditSysHandler.settle.selector, 3);
        _w(AuditSysHandler.openDraw.selector, 5);
        _w(AuditSysHandler.postRound.selector, 2);
        _w(AuditSysHandler.postAll.selector, 2);
        _w(AuditSysHandler.addBounty.selector, 1);
        _w(AuditSysHandler.withdrawBounty.selector, 1);
        _w(AuditSysHandler.startBackup.selector, 2);
        _w(AuditSysHandler.fixBackup.selector, 2);
        _w(AuditSysHandler.backupCycle.selector, 3);
        _w(AuditSysHandler.enterTerminal.selector, 1);
        _w(AuditSysHandler.pick.selector, 3);
        _w(AuditSysHandler.pickBatch.selector, 1);
        _w(AuditSysHandler.returnItem.selector, 3);
        _w(AuditSysHandler.returnItems.selector, 1);
        _w(AuditSysHandler.reveal.selector, 3);
        _w(AuditSysHandler.transferItem.selector, 3);
        _w(AuditSysHandler.itemToBox.selector, 1);
        _w(AuditSysHandler.approveItem.selector, 1);
        _w(AuditSysHandler.streamClaim.selector, 3);
        _w(AuditSysHandler.streamClaimFor.selector, 2);
        _w(AuditSysHandler.streamBurn.selector, 1);
        _w(AuditSysHandler.transferT.selector, 1);
        _w(AuditSysHandler.tToBox.selector, 1);
        _w(AuditSysHandler.burnT.selector, 1);
        _w(AuditSysHandler.probePool.selector, 1);
        _w(AuditSysHandler.warp.selector, 8);
    }
}
