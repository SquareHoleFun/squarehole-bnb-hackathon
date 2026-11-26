// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {AuditU2LaneBase} from "./AuditU2LaneBase.sol";
import {BoxCoordinator} from "../../../../src/box/BoxCoordinator.sol";
import {BoxLaunchRouter} from "../../../../src/box/BoxLaunchRouter.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {IBoxCoordinator} from "../../../../src/box/interfaces/IBoxCoordinator.sol";
import {IBoxHook} from "../../../../src/box/interfaces/IBoxHook.sol";
import {IBoxLaunchRouter} from "../../../../src/box/interfaces/IBoxLaunchRouter.sol";
import {IBoxToken} from "../../../../src/box/interfaces/IBoxToken.sol";
import {TransientReentrancyGuard} from "../../../../src/libraries/TransientReentrancyGuard.sol";
import {BoxBuildV1} from "sh-box-build/BoxBuildV1.sol";
import {CodeScan} from "../../conformance/CodeScan.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {BoxClones} from "../../../../src/box/libraries/BoxClones.sol";

/// @notice TEST ONLY: the refund recipient tries to buy again with a real refund, and accepts the outer refund.
contract AuditU2LaneRefundBuyer {
    BoxLaunchRouter internal immutable router;
    bool public attempted;
    bool public succeeded;
    bytes4 public reason;

    constructor(BoxLaunchRouter router_) {
        router = router_;
    }

    receive() external payable {
        attempted = true;
        bytes memory ret;
        (succeeded, ret) =
            address(router).call{value: 1}(abi.encodeCall(router.buy, (1, 0, address(this), block.timestamp)));
        reason = bytes4(ret);
    }
}

/// forge-config: default.evm_version = "osaka"
contract AuditU2LaneProperties is AuditU2LaneBase {
    struct BuyBefore {
        uint256 payer;
        uint256 manager;
        uint256 router;
        uint256 safeEth;
        uint256 tax;
        uint256 tokenBalance;
    }

    // W2-U2-2, accepted as built (FQ-17, R66-GIFT, F147): gifted T joins the ask; BC-027/029/067 now say so.
    /// @notice Ticket 4; IBoxCoordinator.sol:12 (BC-043), BoxCoordinator.sol:253-258.
    /// Expected by the ticket: a 1 T gift leaves the migration budget unchanged and is burned as dust.
    /// Observed: budget increases by 1e18, ask liquidity increases, and the gift stays in circulating supply.
    /// Steps: close factory box 0; snapshot plain graduation; restore; transfer 1e18 T to coordinator; graduate.
    /// Amounts: original share 201862030679196583428034117; gift 1000000000000000000 raw T.
    /// The interface explicitly says gifts join the share; this is a ticket/interface discrepancy, not a new exploit.
    function testAccepted_AUDIT_U2_51_donatedTJoinsMigrationAsk() public {
        _closeLane();
        uint256 original = coordinator.poolShare();
        uint256 snap = vm.snapshotState();
        coordinator.graduate();
        (uint128 plainAsk,,) = hook.graduatedLayout();
        uint256 plainSupply = token.totalSupply();
        vm.revertToState(snap);
        vm.prank(eoa[0]);
        token.transfer(a.coordinator, 1 ether);
        assertEq(coordinator.poolShare(), original + 1 ether);
        vm.expectCall(a.hook, abi.encodeCall(IBoxHook.migrate, (original + 1 ether)));
        coordinator.graduate();
        (uint128 giftAsk,,) = hook.graduatedLayout();
        assertGt(giftAsk, plainAsk);
        assertEq(token.balanceOf(a.coordinator), 0);
        assertApproxEqAbs(token.totalSupply(), plainSupply, 1e6, "only liquidity rounding changes dust");
    }

    /// @dev BC-022/024/096, F77: every table entry, full fill and a partial close, with forced ETH present.
    function testProperty_AUDIT_U2_all32StepsFullAndPartial() public {
        uint256 snap = vm.snapshotState();
        for (uint256 step; step < 32; ++step) {
            for (uint256 closing; closing < 2; ++closing) {
                vm.revertToState(snap);
                vm.warp(hook.openAt() + step * 12);
                _forceEth(a.launchRouter, 123456789);
                _checkBuy(closing == 0 ? 0.01 ether : 20 * raise, step, closing == 1);
                if (closing == 1) {
                    vm.recordLogs();
                    coordinator.graduate();
                    Vm.Log[] memory logs = vm.getRecordedLogs();
                    bool found;
                    for (uint256 j; j < logs.length; ++j) {
                        if (logs[j].emitter == a.hook && logs[j].topics[0] == IBoxHook.Migrated.selector) {
                            (uint256 q,,,,,,) = abi.decode(
                                logs[j].data, (uint256, uint256, uint128, uint128, uint128, uint256, uint256)
                            );
                            assertEq(q, raise, "tax never enters R");
                            found = true;
                        }
                    }
                    assertTrue(found);
                    _checkSweep();
                }
            }
        }
    }

    function testFuzz_AUDIT_U2_buyConservation(uint256 gross, uint8 step, uint96 forced) public {
        step %= 32;
        gross = bound(gross, 1e6, 20 * raise);
        vm.warp(hook.openAt() + uint256(step) * 12);
        _forceEth(a.launchRouter, forced);
        _checkBuy(gross, step, false);
        assertEq(a.launchRouter.balance, launchRouter.totalTaxCollected() + forced);
    }

    function _checkBuy(uint256 gross, uint256 step, bool mustClose) internal {
        _fund(eoa[0], gross);
        BuyBefore memory b = BuyBefore(
            eoa[0].balance,
            address(pm).balance,
            a.launchRouter.balance,
            safe.balance,
            launchRouter.totalTaxCollected(),
            token.balanceOf(eoa[0])
        );
        vm.recordLogs();
        _expectExactInput(gross, step);
        vm.prank(eoa[0]);
        uint256 out = launchRouter.buy{value: gross}(gross, 1, eoa[0], block.timestamp);
        uint256 spent = address(pm).balance - b.manager;
        uint256 tax = launchRouter.totalTaxCollected() - b.tax;
        uint256 refund = eoa[0].balance + gross - b.payer;
        assertEq(gross, spent + tax + refund, "wei conservation");
        assertEq(a.launchRouter.balance, b.router + tax, "only tax retained");
        assertEq(safe.balance, b.safeEth, "no tax to platform");
        assertEq(token.balanceOf(eoa[0]) - b.tokenBalance, out);
        uint256 pips = launchRouter.taxPips(step);
        if (refund == 0) {
            assertEq(tax, (gross * pips + 999999) / 1e6);
        } else {
            assertEq(tax, (spent * pips + (1e6 - pips) - 1) / (1e6 - pips));
            assertLt(tax, launchRouter.taxFor(gross, step), "unspent input's tax refunded");
            assertTrue(hook.closed());
            assertEq(_priceLane(), curve.sqrtPriceLowerX96, "stops at P1");
        }
        if (mustClose) {
            assertTrue(hook.closed());
            assertGt(refund, 0);
        }
        _buyEvent(abi.encode(step, gross, tax, out, refund));
    }

    function _expectExactInput(uint256 gross, uint256 step) internal {
        uint256 input = gross - launchRouter.taxFor(gross, step);
        vm.expectCall(
            address(pm),
            abi.encodeCall(
                IPoolManager.swap, (poolKey, SwapParams(true, -int256(input), curve.sqrtPriceLowerX96), bytes(""))
            )
        );
    }

    function _buyEvent(bytes memory expected) internal {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == a.launchRouter && logs[i].topics[0] == IBoxLaunchRouter.TaxedBuy.selector) {
                assertEq(logs[i].data, expected);
                ++found;
            }
        }
        assertEq(found, 1, "one taxed buy event");
    }

    function _checkSweep() internal {
        uint256 amount = a.launchRouter.balance;
        uint256 q0 = pm.balanceOf(a.hook, 0);
        uint256 pm0 = address(pm).balance;
        bytes32 others = _sweepOthers();
        uint256 swept0 = launchRouter.totalSwept();
        assertEq(launchRouter.sweep(), amount);
        assertEq(a.launchRouter.balance, 0);
        assertEq(pm.balanceOf(a.hook, 0), q0 + amount);
        assertEq(address(pm).balance, pm0 + amount);
        assertEq(_sweepOthers(), others, "each unrelated holding unchanged");
        assertEq(launchRouter.totalSwept(), swept0 + amount);
    }

    function _sweepOthers() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                pm.balanceOf(a.receiver, 0),
                pm.balanceOf(a.coordinator, 0),
                pm.balanceOf(safe, 0),
                pm.balanceOf(a.executor, 0),
                safe.balance,
                a.executor.balance,
                a.receiver.balance,
                a.coordinator.balance,
                a.hook.balance
            )
        );
    }

    /// @dev BC-024: cross-multiplication pins ceil's exact error <1 wei, including input 1 and R.
    function testFuzz_AUDIT_U2_taxRounding(uint256 gross, uint8 step) public view {
        gross = bound(gross, 1, raise);
        step %= 32;
        _rounding(gross, step);
        _rounding(1, step);
        _rounding(raise, step);
    }

    function _rounding(uint256 gross, uint256 step) internal view {
        uint256 tax = launchRouter.taxFor(gross, step);
        uint256 numerator = gross * launchRouter.taxPips(step);
        assertGe(tax * 1e6, numerator);
        assertLt(tax * 1e6 - numerator, 1e6);
    }

    /// @dev F80: block.number and a second within the slot cannot affect the step. Both edge seconds are tested.
    function testFuzz_AUDIT_U2_clockOnly(uint8 elapsed, uint64 number) public {
        uint256 second = uint256(elapsed) % 12;
        for (uint256 step; step < 32; ++step) {
            vm.warp(hook.openAt() + 12 * step + second);
            vm.roll(uint256(number) + 1);
            (uint256 tax, uint256 input) = launchRouter.quote(1 ether);
            assertEq(tax, launchRouter.taxFor(1 ether, step));
            assertEq(tax + input, 1 ether);
        }
        assertEq(keccak256(abi.encode(launchRouter.taxTable())), BoxSpecV1.LAUNCH_TAX_TABLE_HASH);
        assertEq(hook.openAt(), launchRouter.openAt());
        assertEq(hook.openAt(), tickets.openAt());
    }

    function testProperty_AUDIT_U2_windowEdges() public {
        uint256 open = hook.openAt();
        vm.warp(open - 1);
        vm.deal(eoa[0], 1 ether);
        vm.prank(eoa[0]);
        vm.expectRevert(abi.encodeWithSelector(IBoxLaunchRouter.NotOpen.selector, open));
        launchRouter.buy{value: 1 ether}(1 ether, 0, eoa[0], open + 384);
        vm.warp(open);
        _checkBuy(0.01 ether, 0, false);
        vm.warp(open + 383);
        _checkBuy(0.01 ether, 31, false);
        vm.warp(open + 384);
        vm.prank(eoa[0]);
        vm.expectRevert(abi.encodeWithSelector(IBoxLaunchRouter.WindowClosed.selector, open + 384));
        launchRouter.buy{value: 0.01 ether}(0.01 ether, 0, eoa[0], open + 384);
    }

    function testProperty_AUDIT_U2_factoryOnceAndCallerRules() public {
        bytes[] memory codes = new bytes[](0);
        vm.prank(eoa[0]);
        vm.expectRevert(abi.encodeWithSelector(IBoxCoordinator.NotFactory.selector, eoa[0]));
        coordinator.deploy(codes, "", bytes32(0), 0);
        vm.prank(address(factory));
        vm.expectRevert(BoxCoordinator.AlreadyDeployed.selector);
        coordinator.deploy(codes, "", bytes32(0), 0);
        vm.prank(eoa[0]);
        vm.expectRevert(abi.encodeWithSelector(IBoxCoordinator.NotFactory.selector, eoa[0]));
        coordinator.launch();
        vm.prank(address(factory));
        vm.expectRevert(IBoxCoordinator.AlreadyLaunched.selector);
        coordinator.launch();
        vm.prank(eoa[0]);
        vm.expectRevert(abi.encodeWithSelector(IBoxLaunchRouter.NotCoordinator.selector, eoa[0]));
        launchRouter.bootstrap();
        vm.prank(a.coordinator);
        vm.expectRevert(IBoxLaunchRouter.AlreadyBootstrapped.selector);
        launchRouter.bootstrap();
        vm.prank(a.coordinator);
        vm.expectRevert(BoxLaunchRouter.NoCreatorBuy.selector);
        launchRouter.creatorBuy(eoa[0], 1);
        vm.expectRevert(IBoxCoordinator.NotClosed.selector);
        coordinator.graduate();
        _forceEth(a.launchRouter, 1);
        vm.expectRevert(IBoxLaunchRouter.NotGraduated.selector);
        launchRouter.sweep();
        _closeLane();
        vm.prank(eoa[2]);
        uint256 reward = coordinator.graduate();
        vm.expectRevert(IBoxCoordinator.AlreadyGraduated.selector);
        coordinator.graduate();
        vm.prank(eoa[3]);
        vm.expectRevert(IBoxCoordinator.NothingToClaim.selector);
        coordinator.claimReward(eoa[3]);
        uint256 before = eoa[4].balance;
        vm.prank(eoa[2]);
        assertEq(coordinator.claimReward(eoa[4]), reward);
        assertEq(eoa[4].balance - before, reward);
        vm.prank(eoa[2]);
        vm.expectRevert(IBoxCoordinator.NothingToClaim.selector);
        coordinator.claimReward(eoa[4]);
    }

    /// @dev A fresh real router clone with identical immutable arguments isolates the pre-open guard from the
    /// existing factory router's already-bootstrapped latch. It never swaps against another pool.
    function testProperty_AUDIT_U2_bootstrapAfterOpenRefused() public {
        bytes memory init = BoxClones.initCode(a.launchRouter.code);
        address fresh;
        assembly ("memory-safe") { fresh := create(0, add(init, 32), mload(init)) }
        assertTrue(fresh != address(0));
        BoxLaunchRouter router = BoxLaunchRouter(payable(fresh));
        vm.prank(a.coordinator);
        router.initialize();
        assertFalse(router.bootstrapped());
        uint256 open = router.openAt();
        vm.warp(open);
        vm.deal(a.coordinator, BoxSpecV1.BOOTSTRAP_ETH);
        vm.prank(a.coordinator);
        vm.expectRevert(abi.encodeWithSelector(IBoxLaunchRouter.AfterOpen.selector, open));
        router.bootstrap{value: BoxSpecV1.BOOTSTRAP_ETH}();
        assertFalse(router.bootstrapped());
    }

    function testProperty_AUDIT_U2_oneWeiBuyHasNoSpendableInput() public {
        uint256 open = hook.openAt();
        for (uint256 step; step < 32; ++step) {
            vm.warp(open + step * 12);
            (uint256 tax, uint256 input) = launchRouter.quote(1);
            assertEq(tax, 1);
            assertEq(input, 0);
            vm.deal(eoa[0], 1);
            vm.prank(eoa[0]);
            vm.expectRevert(IBoxLaunchRouter.AmountTooSmall.selector);
            launchRouter.buy{value: 1}(1, 0, eoa[0], block.timestamp);
        }
        assertEq(launchRouter.totalTaxCollected(), 0);
    }

    function testProperty_AUDIT_U2_callbacksNeedOwnUnlock() public {
        bytes memory routerData = abi.encode(uint8(2), abi.encode(uint256(1), eoa[0]));
        bytes memory coordData = abi.encode(eoa[0], uint256(1));
        for (uint256 i; i < 2; ++i) {
            address caller = i == 0 ? eoa[0] : address(pm);
            vm.prank(caller);
            vm.expectRevert(IBoxLaunchRouter.NotPoolManager.selector);
            launchRouter.unlockCallback(routerData);
            vm.prank(caller);
            vm.expectRevert(IBoxCoordinator.NotPoolManager.selector);
            coordinator.unlockCallback(coordData);
        }
        // Positive controls use the same callback bodies during their own real unlocks.
        vm.warp(hook.openAt());
        _checkBuy(20 * raise, 0, true);
        vm.prank(keeper);
        coordinator.graduate();
        _checkSweep();
        vm.prank(keeper);
        coordinator.claimReward(keeper);
    }

    /// @dev BC-027, F78: donated ERC-6909 Q reaches next-batch fees, never the caller's reward.
    function testFuzz_AUDIT_U2_rewardAndTransferredClaims(uint96 donation, bool collectFirst) public {
        uint256 gift = bound(donation, 1, raise);
        _closeLane();
        _giftClaimsLane(gift);
        if (collectFirst) receiver.collect(keeper);
        uint256 minted0 = hook.reserveMinted();
        uint256 held0 = pm.balanceOf(a.coordinator, 0);
        vm.recordLogs();
        vm.prank(eoa[3]);
        uint256 reward = coordinator.graduate();
        uint256 minted = hook.reserveMinted();
        uint256 held = held0 + minted - minted0;
        assertEq(reward, _min(_min(minted, raise / 1000), held));
        assertEq(coordinator.rewardCap(), BoxBuildV1.RAISE / 1000);
        assertEq(pm.balanceOf(a.coordinator, 0), reward);
        assertEq(coordinator.rewardOf(eoa[3]), reward);
        bool found;
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == a.coordinator && logs[i].topics[0] == BoxCoordinator.ClaimsForwarded.selector) {
                assertEq(address(uint160(uint256(logs[i].topics[1]))), a.receiver);
                assertEq(abi.decode(logs[i].data, (uint256)), held - reward);
                assertGe(held - reward, gift);
                found = true;
            }
        }
        assertTrue(found);
        assertTrue(receiver.graduationSettled(), "gift included by first settlement");
    }

    function _min(uint256 x, uint256 y) internal pure returns (uint256) {
        return x < y ? x : y;
    }

    /// @dev BC-096: rejected refund rolls back pool close, payment, output, tax and every storage write.
    function testProperty_AUDIT_U2_rejectingRefundIsAtomic() public {
        vm.warp(hook.openAt());
        uint256 gross = 20 * raise;
        address who = address(ethRefuser);
        vm.deal(who, gross);
        uint160 price = _priceLane();
        uint256 manager = address(pm).balance;
        uint256 tax = launchRouter.totalTaxCollected();
        uint256 supply = token.totalSupply();
        vm.startStateDiffRecording();
        vm.prank(who);
        (bool ok, bytes memory ret) =
            a.launchRouter.call{value: gross}(abi.encodeCall(launchRouter.buy, (gross, 0, who, block.timestamp)));
        Vm.AccountAccess[] memory changes = vm.stopAndReturnStateDiff();
        assertFalse(ok);
        assertEq(bytes4(ret), IBoxLaunchRouter.RefundFailed.selector);
        _allWritesReverted(changes);
        assertFalse(hook.closed());
        assertEq(_priceLane(), price);
        assertEq(address(pm).balance, manager);
        assertEq(who.balance, gross);
        assertEq(token.balanceOf(who), 0);
        assertEq(token.totalSupply(), supply);
        assertEq(launchRouter.totalTaxCollected(), tax);
        assertEq(a.launchRouter.balance, 0);
    }

    function testProperty_AUDIT_U2_refundBuyReentryMeetsLock() public {
        vm.warp(hook.openAt());
        AuditU2LaneRefundBuyer buyer = new AuditU2LaneRefundBuyer(launchRouter);
        uint256 gross = 20 * raise;
        vm.deal(address(buyer), gross);
        vm.prank(address(buyer));
        launchRouter.buy{value: gross}(gross, 1, address(buyer), block.timestamp);
        assertTrue(buyer.attempted());
        assertFalse(buyer.succeeded());
        assertEq(buyer.reason(), TransientReentrancyGuard.Reentrancy.selector);
        assertTrue(hook.closed());
        assertGt(address(buyer).balance, 0);
    }

    function testProperty_AUDIT_U2_noExactOutputEntry() public {
        bytes memory code = CodeScan.minimalProxyTarget(a.launchRouter.code).code;
        uint32[] memory words = CodeScan.pushedWords(code);
        assertTrue(CodeScan.pushes(words, IBoxLaunchRouter.buy.selector));
        assertFalse(CodeScan.pushes(words, bytes4(keccak256("buyExactOutput(uint256,uint256,address,uint256)"))));
        assertFalse(CodeScan.pushes(words, bytes4(keccak256("exactOutput(bytes)"))));
        (bool ok,) = a.launchRouter
            .call(
                abi.encodeWithSignature(
                    "buyExactOutput(uint256,uint256,address,uint256)", 1, 1, eoa[0], block.timestamp
                )
            );
        assertFalse(ok);
    }

    /// @dev BC-004: the creation call's bootstrap has already burned T, before any public purchase.
    function testProperty_AUDIT_U2_bootstrapBurnedAtCreation() public view {
        assertTrue(launchRouter.bootstrapped());
        assertFalse(launchRouter.creatorBought());
        assertEq(coordinator.creatorBuyAmount(), 0);
        assertGt(token.totalBurned(), 0);
        assertEq(token.totalSupply() + token.totalBurned(), 1e27);
        assertEq(token.balanceOf(a.coordinator) + token.balanceOf(address(pm)), token.totalSupply());
        assertEq(a.launchRouter.balance, 0);
        assertEq(launchRouter.totalTaxCollected(), 0);
        assertEq(address(pm).balance, BoxSpecV1.BOOTSTRAP_ETH);
        assertLt(block.timestamp, hook.openAt());
    }

    function testFuzz_AUDIT_U2_transfersAndBurnFloor(uint256 amount, uint256 burnAmount) public {
        _closeLane();
        amount = bound(amount, 0, token.balanceOf(eoa[0]));
        vm.prank(eoa[0]);
        token.transfer(eoa[1], amount);
        vm.prank(eoa[1]);
        token.approve(eoa[2], amount);
        for (uint256 i; i < 2; ++i) {
            address to = i == 0 ? a.vault : a.token;
            vm.prank(eoa[1]);
            vm.expectRevert(abi.encodeWithSelector(IBoxToken.DirectSendRefused.selector, to));
            token.transfer(to, amount);
            vm.prank(eoa[2]);
            vm.expectRevert(abi.encodeWithSelector(IBoxToken.DirectSendRefused.selector, to));
            token.transferFrom(eoa[1], to, amount);
        }
        vm.prank(eoa[1]);
        token.approve(a.vault, amount);
        vm.prank(a.vault);
        token.transferFrom(eoa[1], a.vault, amount);
        assertEq(token.balanceOf(a.vault), amount, "vault's own pull permitted");
        uint256 supply = token.totalSupply();
        burnAmount = bound(burnAmount, 0, token.balanceOf(eoa[0]));
        vm.prank(eoa[0]);
        token.burn(burnAmount);
        assertEq(token.totalSupply(), supply - burnAmount);
        assertGe(token.totalSupply(), vault.supplyFloor());
        assertEq(token.totalSupply() + token.totalBurned(), 1e27);
    }

    /// @dev The actual vault supplies E+n. Consolidating T by holder impersonation isolates the final floor wei.
    function testProperty_AUDIT_U2_burnAtActualVaultFloor() public {
        address[2] memory holders = [a.coordinator, address(pm)];
        for (uint256 i; i < holders.length; ++i) {
            uint256 amount = token.balanceOf(holders[i]);
            vm.prank(holders[i]);
            token.transfer(eoa[0], amount);
        }
        uint256 floor = vault.supplyFloor();
        uint256 amount = token.totalSupply() - floor;
        vm.prank(eoa[0]);
        token.burn(amount);
        assertEq(token.totalSupply(), floor);
        vm.prank(eoa[0]);
        vm.expectRevert(abi.encodeWithSelector(IBoxToken.BurnBelowSupplyFloor.selector, floor - 1, floor));
        token.burn(1);
        assertEq(token.totalSupply(), floor);
    }
}
