// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AuditSysActions} from "./AuditSysActions.sol";

/// @title AuditSysHandler
/// @notice TEST ONLY (SH-AUDIT-B0 round 2). The system campaign's only fuzz target: each selector forwards its fuzzed
/// arguments to the shard (the test contract, which is the world), whose `h_*` action runs it fail-safe with the world's
/// booked helpers and counts it. Non-payable on purpose: forge sends no value to these calls.
contract AuditSysHandler {
    AuditSysActions internal immutable sys;

    constructor(AuditSysActions sys_) {
        sys = sys_;
    }

    // trading and graduation
    function windowBuy(uint256 a, uint256 b, uint256 c) external {
        sys.h_windowBuy(a, b, c);
    }

    function swapBuyIn(uint256 a, uint256 b, uint256 c) external {
        sys.h_swapBuyIn(a, b, c);
    }

    function swapSellIn(uint256 a, uint256 b) external {
        sys.h_swapSellIn(a, b);
    }

    function swapBuyOut(uint256 a, uint256 b) external {
        sys.h_swapBuyOut(a, b);
    }

    function swapSellOut(uint256 a, uint256 b) external {
        sys.h_swapSellOut(a, b);
    }

    function swapMulti(uint256 a, uint256 b) external {
        sys.h_swapMulti(a, b);
    }

    function closeCurve(uint256 a, uint256 b) external {
        sys.h_closeCurve(a, b);
    }

    function graduate(uint256 a, uint256 b) external {
        sys.h_graduate(a, b);
    }

    // fees and ETH intake
    function collect(uint256 a, uint256 b) external {
        sys.h_collect(a, b);
    }

    function fundFees(uint256 a, uint256 b) external {
        sys.h_fundFees(a, b);
    }

    function fundDepth(uint256 a, uint256 b) external {
        sys.h_fundDepth(a, b);
    }

    function forceEth(uint256 a, uint256 b) external {
        sys.h_forceEth(a, b);
    }

    function royalty(uint256 a, uint256 b, uint256 c) external {
        sys.h_royalty(a, b, c);
    }

    function flush(uint256 a) external {
        sys.h_flush(a);
    }

    function sweepWeth(uint256 a, uint256 b) external {
        sys.h_sweepWeth(a, b);
    }

    function routerSweep(uint256 a) external {
        sys.h_routerSweep(a);
    }

    function payFit(uint256 a) external {
        sys.h_payFit(a);
    }

    function payPlatform(uint256 a) external {
        sys.h_payPlatform(a);
    }

    function claimReward(uint256 a, uint256 b) external {
        sys.h_claimReward(a, b);
    }

    function giftClaims(uint256 a, uint256 b) external {
        sys.h_giftClaims(a, b);
    }

    // depth and the executor
    function deepen(uint256 a, uint256 b, uint256 c) external {
        sys.h_deepen(a, b, c);
    }

    function poke(uint256 a) external {
        sys.h_poke(a);
    }

    function execute(uint256 a) external {
        sys.h_execute(a);
    }

    function fundBudget(uint256 a, uint256 b) external {
        sys.h_fundBudget(a, b);
    }

    // tickets
    function take(uint256 a, uint256 b) external {
        sys.h_take(a, b);
    }

    function handBack(uint256 a) external {
        sys.h_handBack(a);
    }

    function transferPlaceholder(uint256 a, uint256 b) external {
        sys.h_transferPlaceholder(a, b);
    }

    function requestWord(uint256 a, uint256 b) external {
        sys.h_requestWord(a, b);
    }

    function acceptWord() external {
        sys.h_acceptWord();
    }

    function draw(uint256 a, uint256 b) external {
        sys.h_draw(a, b);
    }

    function drawMany(uint256 a, uint256 b) external {
        sys.h_drawMany(a, b);
    }

    function settle(uint256 a) external {
        sys.h_settle(a);
    }

    function openPlaceholder(uint256 a, uint256 b) external {
        sys.h_openPlaceholder(a, b);
    }

    function openDraw(uint256 a, uint256 b) external {
        sys.h_openDraw(a, b);
    }

    // randomness
    function postRound(uint256 a) external {
        sys.h_postRound(a);
    }

    function postAll() external {
        sys.h_postAll();
    }

    function addBounty(uint256 a, uint256 b) external {
        sys.h_addBounty(a, b);
    }

    function withdrawBounty(uint256 a) external {
        sys.h_withdrawBounty(a);
    }

    function startBackup(uint256 a, uint256 b) external {
        sys.h_startBackup(a, b);
    }

    function fixBackup(uint256 a, uint256 b, uint256 c) external {
        sys.h_fixBackup(a, b, c);
    }

    function backupCycle(uint256 a, uint256 b) external {
        sys.h_backupCycle(a, b);
    }

    // terminal mode
    function enterTerminal(uint256 a) external {
        sys.h_enterTerminal(a);
    }

    function cancelDraw(uint256 a) external {
        sys.h_cancelDraw(a);
    }

    function takeByNumber(uint256 a, uint256 b) external {
        sys.h_takeByNumber(a, b);
    }

    // vault and collection
    function pick(uint256 a, uint256 b) external {
        sys.h_pick(a, b);
    }

    function pickBatch(uint256 a, uint256 b) external {
        sys.h_pickBatch(a, b);
    }

    function returnItem(uint256 a) external {
        sys.h_returnItem(a);
    }

    function returnItems(uint256 a) external {
        sys.h_returnItems(a);
    }

    function reveal(uint256 a) external {
        sys.h_reveal(a);
    }

    function transferItem(uint256 a, uint256 b, uint256 c) external {
        sys.h_transferItem(a, b, c);
    }

    function itemToBox(uint256 a, uint256 b) external {
        sys.h_itemToBox(a, b);
    }

    function approveItem(uint256 a, uint256 b) external {
        sys.h_approveItem(a, b);
    }

    // the stream
    function streamClaim(uint256 a) external {
        sys.h_streamClaim(a);
    }

    function streamClaimFor(uint256 a, uint256 b) external {
        sys.h_streamClaimFor(a, b);
    }

    function streamBurn(uint256 a) external {
        sys.h_streamBurn(a);
    }

    // T by holders
    function transferT(uint256 a, uint256 b, uint256 c) external {
        sys.h_transferT(a, b, c);
    }

    function tToBox(uint256 a, uint256 b, uint256 c) external {
        sys.h_tToBox(a, b, c);
    }

    function burnT(uint256 a, uint256 b) external {
        sys.h_burnT(a, b);
    }

    // probes and time
    function probePool(uint256 a) external {
        sys.h_probePool(a);
    }

    function warp(uint256 a) external {
        sys.h_warp(a);
    }
}
