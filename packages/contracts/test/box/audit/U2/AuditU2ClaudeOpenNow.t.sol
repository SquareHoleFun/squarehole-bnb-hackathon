// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxCollection} from "../../../../src/box/BoxCollection.sol";
import {BoxCoordinator} from "../../../../src/box/BoxCoordinator.sol";
import {BoxHook} from "../../../../src/box/BoxHook.sol";
import {BoxItemStream} from "../../../../src/box/BoxItemStream.sol";
import {BoxLaunchRouter} from "../../../../src/box/BoxLaunchRouter.sol";
import {BoxReceiver} from "../../../../src/box/BoxReceiver.sol";
import {BoxRoyaltyRouter} from "../../../../src/box/BoxRoyaltyRouter.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {BoxTickets} from "../../../../src/box/BoxTickets.sol";
import {BoxToken} from "../../../../src/box/BoxToken.sol";
import {BoxVault} from "../../../../src/box/BoxVault.sol";
import {FitBuybackExecutor} from "../../../../src/box/FitBuybackExecutor.sol";
import {IBoxFactoryV1} from "../../../../src/box/interfaces/IBoxFactoryV1.sol";
import {IBoxLaunchRouter} from "../../../../src/box/interfaces/IBoxLaunchRouter.sol";
import {CoreBox0Kit} from "../../conformance/core/CoreBox0Kit.sol";
import {EthIn} from "../common/AuditGhostLedger.sol";
import {
    AuditU2ClaudeBase,
    AuditU2ClaudeBuy,
    AuditU2ClaudeClaimGifter,
    AuditU2ClaudeGraduation
} from "./AuditU2ClaudeBase.sol";

/// @notice Box 0 created with `openAt` = 0 ("Now", F80) and with ETH and claims already at its predicted addresses
/// before the creation transaction (L8: "pre-existing balances at a predicted address change nothing"). The world's
/// own setUp checks that the hook's open equals the spec's field, which a Now spec does not satisfy (it opens at the
/// creation time + 1), so this contract runs the world's steps itself (`AuditBox0World._setUpAuditWorld`, unchanged
/// otherwise) with the two additions between `prepare` and `create`.
/// - P2.11 / AR-15 / BC-023 (IBoxLaunchRouter.sol:74-76, BoxLaunchRouter.sol:112-114, BoxHook.sol:125-130,
///   BoxTickets.sol:123): hook, router and tickets report the same open, the creation block's time + 1; nothing buys
///   in the creation block (the bootstrap aside); the next block is step 0.
/// - P2.17 (pre-funding): 1.5 ETH sent to the predicted launch router and 0.25 ETH to the predicted coordinator as plain
///   transfers to empty accounts, 0.75 ETH of claims minted to the predicted coordinator: the router's buys conserve
///   with it there, the router's sweep moves it with the tax into the hook's claims, graduation forwards the claims to
///   the receiver as fees and the reward stays the cap; the coordinator's 0.25 ETH has no exit (no `receive`, nothing
///   reads its balance; forced ETH, the accepted M27 class).
/// forge-config: default.evm_version = "osaka"
contract AuditU2ClaudeOpenNowTest is AuditU2ClaudeBase {
    uint256 internal constant PREFUND_ROUTER = 1.5 ether;
    uint256 internal constant PREFUND_COORDINATOR = 0.25 ether;
    uint256 internal constant PREFUND_CLAIMS = 0.75 ether;

    function _auditSpec() internal view override returns (BoxSpecV1.BoxSpec memory s) {
        s = super._auditSpec();
        s.openAt = 0;
    }

    function setUp() public override {
        _requireEip2537();
        _loadBoxDrand();
        r0 = _localFirst();
        vm.pauseGasMetering();
        kit = new CoreBox0Kit();
        vm.resumeGasMetering();
        kit.setUpWorld();
        pm = kit.pm();
        src = kit.source();
        drand = kit.drand();
        factory = kit.factory();
        vm.warp(src.roundTime(r0) - 1 days);
        vm.fee(AUDIT_BASE_FEE);
        _makeActors();
        BoxSpecV1.BoxSpec memory s = _auditSpec();
        editionSize = s.n;
        raise = s.raise;
        kit.prepare(s);
        // The addition: value at the predicted addresses before the creation transaction.
        IBoxFactoryV1.Box0Addresses memory b = factory.box0Addresses();
        vm.deal(address(this), address(this).balance + 10 ether);
        (bool ok,) = b.launchRouter.call{value: PREFUND_ROUTER}("");
        require(ok && b.launchRouter.code.length == 0, "pre-fund: a plain transfer to the empty router address");
        (ok,) = b.coordinator.call{value: PREFUND_COORDINATOR}("");
        require(ok && b.coordinator.code.length == 0, "pre-fund: a plain transfer to the empty coordinator address");
        AuditU2ClaudeClaimGifter early = new AuditU2ClaudeClaimGifter(pm);
        early.giftEthClaims{value: PREFUND_CLAIMS}(b.coordinator);
        createdAt = vm.getBlockTimestamp();
        createdAtBlock = vm.getBlockNumber();
        kit.create();
        a = kit.addresses();
        poolKey = kit.poolKey();
        curve = kit.curve();
        coordinator = BoxCoordinator(a.coordinator);
        hook = BoxHook(a.hook);
        launchRouter = BoxLaunchRouter(payable(a.launchRouter));
        receiver = BoxReceiver(payable(a.receiver));
        executor = FitBuybackExecutor(payable(a.executor));
        tickets = BoxTickets(a.tickets);
        vault = BoxVault(a.vault);
        collection = BoxCollection(a.collection);
        stream = BoxItemStream(a.itemStream);
        royaltyRouter = BoxRoyaltyRouter(payable(a.royaltyRouter));
        token = BoxToken(a.token);
        safe = a.platform;
        require(b.coordinator == a.coordinator && b.launchRouter == a.launchRouter, "the predicted addresses");
        _labelWorld();
        _bookWorld();
        _ghostAddOutside(address(early));
        _noteEthIn(EthIn.Forced, PREFUND_ROUTER + PREFUND_COORDINATOR);
        _noteEthIn(EthIn.Other, PREFUND_CLAIMS);
        _assertGhostLedger();
        _setUpU2();
    }

    function testProperty_AUDIT_U2_nowOpensAtTheCreationTimePlusOneForAllThree() public {
        uint256 open = createdAt + 1;
        assertEq(hook.openAt(), open, "the hook: creation time + 1");
        assertEq(launchRouter.openAt(), open, "the router: the same second");
        assertEq(tickets.openAt(), open, "the tickets: the same second");
        // In the creation block nothing buys (the bootstrap ran inside createBox).
        vm.deal(eoa[0], 1 ether);
        vm.prank(eoa[0]);
        vm.expectRevert(abi.encodeWithSelector(IBoxLaunchRouter.NotOpen.selector, open));
        launchRouter.buy{value: 0.001 ether}(0.001 ether, 1, eoa[0], createdAt);
        // The next block (12 s later) is step 0 of 32: (12 − 1) / 12 = 0.
        _advance(1);
        AuditU2ClaudeBuy memory first = _measuredBuy(eoa[0], 0.01 ether, eoa[0]);
        assertTrue(first.ok);
        assertEq(first.eventStep, 0);
        // The 32nd block after creation is step 31, the 33rd is past the window: 32 blocks of tax, as F80 says.
        _advance(31);
        assertEq(_measuredBuy(eoa[1], 0.01 ether, eoa[1]).eventStep, 31);
        _advance(1);
        AuditU2ClaudeBuy memory late = _measuredBuy(eoa[1], 0.01 ether, eoa[1]);
        assertEq(bytes4(late.err), IBoxLaunchRouter.WindowClosed.selector);
        _assertGhostLedger();
    }

    function testProperty_AUDIT_U2_preFundedPredictedAddressesChangeNothing() public {
        assertEq(a.launchRouter.balance, PREFUND_ROUTER, "the router starts with the pre-funded ETH");
        assertEq(launchRouter.totalTaxCollected(), 0);
        assertEq(a.coordinator.balance, PREFUND_COORDINATOR);
        assertEq(pm.balanceOf(a.coordinator, 0), PREFUND_CLAIMS, "claims sent before the coordinator existed");
        assertEq(coordinator.reserve(), 0, "the reserve view ignores them");
        // Window buys conserve as usual, the pre-funded ETH untouched.
        _advance(3);
        AuditU2ClaudeBuy memory b = _measuredBuy(eoa[0], 0.3 ether, eoa[0]);
        assertTrue(b.ok);
        assertEq(b.qIn, b.spent + b.tax + b.refund);
        assertEq(a.launchRouter.balance, PREFUND_ROUTER + b.tax);
        AuditU2ClaudeBuy memory c = _measuredBuy(eoa[1], 300 ether, eoa[1]);
        assertGt(c.refund, 0, "a partial close");
        assertEq(c.qIn, c.spent + c.tax + c.refund);
        AuditU2ClaudeGraduation memory g = _graduateRecorded(keeper);
        assertEq(g.reward, coordinator.rewardCap(), "the reward is the cap, not the cap plus the claims");
        assertEq(g.forwarded, PREFUND_CLAIMS, "the pre-sent claims go to the receiver as fees");
        assertEq(pm.balanceOf(a.coordinator, 0), g.reward);
        uint256 hook0 = pm.balanceOf(a.hook, 0);
        uint256 swept = launchRouter.sweep();
        assertEq(swept, PREFUND_ROUTER + b.tax + c.tax, "the sweep moves the pre-funded ETH with the tax");
        assertEq(pm.balanceOf(a.hook, 0) - hook0, swept);
        assertEq(a.coordinator.balance, PREFUND_COORDINATOR, "the coordinator's plain ETH stays (forced ETH, no exit)");
        assertEq(safe.balance, 0);
        _assertGhostLedger();
    }
}
