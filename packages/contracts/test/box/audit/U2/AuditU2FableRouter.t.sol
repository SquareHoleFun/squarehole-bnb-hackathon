// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VmSafe} from "forge-std/Vm.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {BoxPhase} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxHook} from "../../../../src/box/interfaces/IBoxHook.sol";
import {IBoxLaunchRouter} from "../../../../src/box/interfaces/IBoxLaunchRouter.sol";
import {TransientReentrancyGuard} from "../../../../src/libraries/TransientReentrancyGuard.sol";
import {AuditActor} from "../common/AuditActors.sol";
import {EthIn, EthOut, TOut} from "../common/AuditGhostLedger.sol";
import {AuditU2FableBase, AuditU2FableReentrantPayer} from "./AuditU2FableBase.sol";

/// @title AuditU2FableRouterTest
/// @notice SH-AUDIT-B0-U2-F, the launch router on the factory's box 0 (mainnet build, Osaka): L1 conservation (P2.1,
/// P2.2), L4 the tax step and the one open time (P2.11), L6 exact input at the P1 limit and the partial close (P2.14),
/// L7 rounding and the minimum buy (P2.15), L3 the refund's re-entry and refusal (P2.10), L2 the router's callers
/// (part of P2.7). `AuditU2FableRouterAmsterdamTest` runs the same under Amsterdam; `AuditU2FableRouterNowTest` the
/// open-time rule for "Now".
/// forge-config: default.evm_version = "osaka"
contract AuditU2FableRouterTest is AuditU2FableBase {
    // ============================================================================================ L1 conservation

    /// P2.1 / BC-022 / M04: for every window buy, msg.value == pool spend + tax kept + refund, to the wei, at every
    /// tax step, with and without a partial close at P1, with ETH forced into the router before the call; the tax is
    /// the ceiling rule on the gross, or on the spent input at the same rate when the fill is partial; the TaxedBuy
    /// event carries the same figures; the router holds the tax plus the forced ETH and nothing else.
    function testFuzz_AUDIT_U2_windowBuyConserves(uint96 raw, uint8 stepRaw, uint96 forcedRaw) public {
        uint256 step = uint256(stepRaw) % 32;
        uint256 gross = bound(uint256(raw), 1e13, 100 ether);
        uint256 forced = bound(uint256(forcedRaw), 0, 1 ether);
        _warpTo(hook.openAt() + step * SLOT);
        _forceEth(a.launchRouter, forced);
        uint256 pips = launchRouter.taxPips(step);
        Buy memory b = _measuredBuy(eoa[0], gross, eoa[0], 1);
        assertTrue(b.ok, "the buy passed");
        assertEq(gross, b.spent + b.tax + b.refund, "gross == spend + tax + refund");
        if (b.refund == 0) {
            assertEq(b.tax, _ceilTax(gross, pips), "full fill: ceil(gross x pips)");
            assertEq(b.spent, gross - b.tax, "full fill: the whole net input entered the curve");
        } else {
            assertTrue(b.closed, "only a closing fill is partial");
            assertEq(b.tax, _partialTax(gross, b.spent, pips), "partial fill: tax on the spent input at the same rate");
            assertEq(_sqrtPrice(), curve.sqrtPriceLowerX96, "a partial fill stops exactly at P1");
            assertLe(b.tax, _ceilTax(gross, pips), "never more than the gross tax");
        }
        assertEq(b.eventTax, b.tax, "TaxedBuy.tax");
        assertEq(b.eventRefund, b.refund, "TaxedBuy.refund");
        assertEq(b.eventOut, b.tOut, "TaxedBuy.tokensOut");
        assertGt(b.tOut, 0);
        assertEq(launchRouter.totalTaxCollected(), b.tax, "the lifetime tax total");
        assertEq(launchRouter.totalSwept(), 0);
        assertEq(a.launchRouter.balance, forced + b.tax, "the router holds the tax and the forced ETH only");
        _assertGhostLedger();
    }

    /// P2.1: all 32 steps, one small buy (full fill) and one buy sized past P1 (partial close) each, from the same
    /// window state.
    function testProperty_AUDIT_U2_everyStepConservesWithAndWithoutAClose() public {
        uint256 open = hook.openAt();
        for (uint256 step; step < 32; ++step) {
            uint256 snap = vm.snapshotState();
            _warpTo(open + step * SLOT);
            uint256 pips = launchRouter.taxPips(step);
            Buy memory s = _measuredBuy(eoa[1], 0.01 ether, eoa[1], 1);
            assertTrue(s.ok);
            assertEq(s.refund, 0, "0.01 ETH never closes");
            assertEq(s.tax, _ceilTax(0.01 ether, pips));
            assertEq(0.01 ether, s.spent + s.tax);
            uint256 gross = _grossFor(_qToP1() + 0.5 ether, pips);
            Buy memory c = _measuredBuy(eoa[2], gross, eoa[2], 1);
            assertTrue(c.ok, "the closing buy passed");
            assertTrue(c.closed, "closed in its own afterSwap");
            assertGt(c.refund, 0, "the unspent input came back");
            assertEq(gross, c.spent + c.tax + c.refund);
            assertEq(c.tax, _partialTax(gross, c.spent, pips));
            assertEq(_sqrtPrice(), curve.sqrtPriceLowerX96);
            assertEq(a.launchRouter.balance, s.tax + c.tax);
            // Refused after the close, whatever the step.
            Buy memory d = _measuredBuy(eoa[3], 0.01 ether, eoa[3], 1);
            assertFalse(d.ok);
            assertEq(_selector(d.err), IBoxLaunchRouter.CurveIsClosed.selector);
            _assertGhostLedger();
            vm.revertToState(snap);
        }
    }

    /// P2.1 / BC-140 / F77: after graduation `sweep()` turns the router's whole balance (tax and forced ETH) into the
    /// hook's Q claims and nothing else: no other claim balance moves, the Safe gets nothing, the router is empty; a
    /// second sweep is refused, and ETH forced in later is swept the same way.
    function testProperty_AUDIT_U2_sweepIsTheWholeBalanceIntoHookClaimsOnly() public {
        _toClosed();
        _forceEth(a.launchRouter, 0.3 ether);
        uint256 tax = launchRouter.totalTaxCollected();
        assertEq(a.launchRouter.balance, tax + 0.3 ether);
        vm.expectRevert(IBoxLaunchRouter.NotGraduated.selector);
        launchRouter.sweep();
        (, uint256 failures) = _graduate(keeper);
        assertEq(failures, 0);
        uint256 h0 = _claims(a.hook);
        uint256 r0_ = _claims(a.receiver);
        uint256 c0 = _claims(a.coordinator);
        uint256 s0 = safe.balance;
        uint256 pm0 = address(pm).balance;
        vm.recordLogs();
        vm.prank(eoa[5]);
        uint256 swept = launchRouter.sweep();
        assertEq(swept, tax + 0.3 ether, "the whole balance");
        assertEq(a.launchRouter.balance, 0);
        assertEq(_claims(a.hook), h0 + swept, "the hook's Q claims rose by exactly the sweep");
        assertEq(_claims(a.receiver), r0_, "no receiver claim moved");
        assertEq(_claims(a.coordinator), c0, "no coordinator claim moved");
        assertEq(safe.balance, s0, "nothing to the Safe");
        assertEq(address(pm).balance, pm0 + swept, "the ETH went into the PoolManager");
        assertEq(launchRouter.totalSwept(), swept);
        assertEq(launchRouter.totalTaxCollected(), tax, "the tax total is unchanged by a sweep");
        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        bool seen;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == a.launchRouter && logs[i].topics[0] == IBoxLaunchRouter.Swept.selector) {
                assertEq(address(uint160(uint256(logs[i].topics[1]))), a.hook, "Swept.to == the hook");
                (uint256 amount, bool toDepth) = abi.decode(logs[i].data, (uint256, bool));
                assertEq(amount, swept);
                assertTrue(toDepth);
                seen = true;
            }
        }
        assertTrue(seen, "Swept emitted");
        vm.expectRevert(IBoxLaunchRouter.NothingToSweep.selector);
        launchRouter.sweep();
        _forceEth(a.launchRouter, 1);
        assertEq(launchRouter.sweep(), 1, "forced ETH after the sweep is swept too");
        assertEq(_claims(a.hook), h0 + swept + 1);
        _assertGhostLedger();
    }

    /// P2.2 / BC-022 / F77 / BC-027: the tax never enters the curve, the raise or the Safe: in the window the pool
    /// holds the bootstrap plus the spent inputs only (the tax waits in the router); at the close the pool's ETH less
    /// every claim is at least R (R plus the unharvested LP fees); `migrate` takes exactly R out of the curve (within
    /// the removal's rounding), not a wei of tax; the Safe holds nothing through the close, graduation and the sweep,
    /// and its later receipts are the fee split's P, below the tax by construction.
    function testProperty_AUDIT_U2_taxNeverEntersTheCurveTheRaiseOrTheSafe() public {
        _toWindow();
        uint256 spent = ghostEthIn(EthIn.WindowBuy) - ghostEthOut(EthOut.Refund) - a.launchRouter.balance;
        assertEq(address(pm).balance, BoxSpecV1.BOOTSTRAP_ETH + spent, "the pool: bootstrap + spent inputs");
        assertEq(a.launchRouter.balance, launchRouter.totalTaxCollected(), "the router: the tax");
        assertEq(safe.balance, 0);
        _toClosed();
        uint256 poolLessClaims = address(pm).balance - _claims(a.coordinator) - _claims(a.receiver) - _claims(a.hook);
        assertGe(poolLessClaims, raise, "at the close the pool holds R plus unharvested fees");
        assertEq(safe.balance, 0);
        uint256 tax = launchRouter.totalTaxCollected();
        (,, Migrated memory m,) = _graduateMeasured(keeper);
        assertTrue(m.seen);
        assertLe(m.qFromCurve, raise, "the curve held at most R");
        assertLe(raise - m.qFromCurve, 2, "and R within the removal's rounding: no tax in the curve");
        assertEq(a.launchRouter.balance, tax, "the tax is still in the router after graduation");
        _advance(1);
        _buy(eoa[0], 1 ether);
        _collect(keeper, keeper);
        uint256 hookBefore = _claims(a.hook);
        launchRouter.sweep();
        assertEq(_claims(a.hook) - hookBefore, tax, "the tax is the hook's depth budget");
        uint256 paid = _payPlatform(keeper);
        assertGt(paid, 0);
        assertEq(safe.balance, paid, "the Safe's only receipts: the fee split's P");
        assertLt(paid, tax, "below the tax: none of it reached the Safe");
        _assertGhostLedger();
    }

    /// P2.1: the router holds nothing but unswept tax (and forced ETH): plain ETH is refused (no receive/fallback), and
    /// after the window and public trading its balance is exactly its tax total.
    function testProperty_AUDIT_U2_routerHoldsOnlyUnsweptTax() public {
        (bool ok,) = a.launchRouter.call{value: 1}("");
        assertFalse(ok, "plain ETH refused");
        (ok,) = a.launchRouter.call{value: 1}(abi.encodeWithSignature("nothing()"));
        assertFalse(ok, "unknown selectors with value refused");
        _toBonding();
        assertEq(a.launchRouter.balance, launchRouter.totalTaxCollected() - launchRouter.totalSwept());
        assertEq(a.launchRouter.balance, launchRouter.totalTaxCollected());
    }

    // ============================================================================================ L4 time rules

    /// P2.7 / P2.11 / BC-023: `buy` works from openAt to openAt + 383 s and at no other second: openAt - 1 is NotOpen,
    /// openAt + 384 is WindowClosed; the step is (t - openAt) / 12; the hook's gate agrees to the second.
    function testProperty_AUDIT_U2_windowEdgesToTheSecond() public {
        uint256 open = hook.openAt();
        assertEq(launchRouter.openAt(), open);
        _warpTo(open - 1);
        Buy memory b = _measuredBuy(eoa[0], 0.01 ether, eoa[0], 1);
        assertFalse(b.ok);
        assertEq(b.err, abi.encodeWithSelector(IBoxLaunchRouter.NotOpen.selector, open));
        vm.expectRevert(abi.encodeWithSelector(IBoxLaunchRouter.NotOpen.selector, open));
        launchRouter.quote(1 ether);
        uint256[5] memory at = [uint256(0), 11, 12, 371, 383];
        uint256[5] memory want = [uint256(0), 0, 1, 30, 31];
        for (uint256 i; i < 5; ++i) {
            _warpTo(open + at[i]);
            (uint256 tax,) = launchRouter.quote(1 ether);
            assertEq(tax, launchRouter.taxFor(1 ether, want[i]), "quote at the step");
            b = _measuredBuy(eoa[0], 0.01 ether, eoa[0], 1);
            assertTrue(b.ok);
            assertEq(b.step, want[i]);
            assertEq(b.tax, _ceilTax(0.01 ether, launchRouter.taxPips(want[i])));
        }
        // The hook's gate at the last window second: a public buy is refused, a public sell passes.
        bytes memory gate = _hookRevert(
            IHooks.beforeSwap.selector,
            abi.encodeWithSelector(IBoxHook.BuyThroughLaunchRouter.selector, a.launchRouter, open + 384)
        );
        _fund(eoa[1], 0.01 ether);
        vm.prank(eoa[1]);
        vm.expectRevert(gate);
        routerSwapper.swapOne{value: 0.01 ether}(
            poolKey,
            SwapParams({
                zeroForOne: true, amountSpecified: -int256(0.01 ether), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            "",
            eoa[1]
        );
        _sell(eoa[0], token.balanceOf(eoa[0]) / 10);
        _warpTo(open + 384);
        b = _measuredBuy(eoa[0], 0.01 ether, eoa[0], 1);
        assertFalse(b.ok);
        assertEq(b.err, abi.encodeWithSelector(IBoxLaunchRouter.WindowClosed.selector, open + 384));
        vm.expectRevert(abi.encodeWithSelector(IBoxLaunchRouter.WindowClosed.selector, open + 384));
        launchRouter.quote(1 ether);
        assertEq(launchRouter.taxPips(32), 0, "no table entry from step 32 on");
        _buy(eoa[1], 0.01 ether);
        assertEq(uint8(hook.phase()), uint8(BoxPhase.Bonding));
        _assertGhostLedger();
    }

    /// P2.11 / F80: the tax step is a function of block.timestamp - openAt alone (12-second steps): extra blocks
    /// without time change nothing, and the quote equals the table at that step.
    function testFuzz_AUDIT_U2_taxStepDependsOnlyOnTheElapsedTime(uint16 elapsedRaw, uint8 extraBlocks) public {
        uint256 elapsed = uint256(elapsedRaw) % 384;
        uint256 open = hook.openAt();
        _warpTo(open + elapsed);
        vm.roll(vm.getBlockNumber() + extraBlocks);
        uint256 step = elapsed / 12;
        (uint256 tax, uint256 swapIn) = launchRouter.quote(1 ether);
        assertEq(tax, _ceilTax(1 ether, launchRouter.taxTable()[step]));
        assertEq(swapIn, 1 ether - tax);
        Buy memory b = _measuredBuy(eoa[4], 0.02 ether, eoa[4], 1);
        assertTrue(b.ok);
        assertEq(b.step, step);
        assertEq(b.tax, _ceilTax(0.02 ether, launchRouter.taxPips(step)));
    }

    /// P2.11 / AR-15 / BC-023: one open time for the hook, the router and the tickets (a set time here: the spec's);
    /// the bootstrap is the only pre-open buy (box 0 has no creator buy: P2.6 / BC-116), nothing else trades before
    /// the open by any route.
    function testProperty_AUDIT_U2_oneOpenTimeAndOnlyTheBootstrapBeforeIt() public {
        uint256 open = hook.openAt();
        assertEq(open, createdAt + AUDIT_OPEN_DELAY, "the spec's time");
        assertEq(launchRouter.openAt(), open, "router == hook");
        assertEq(tickets.openAt(), open, "tickets == hook");
        assertTrue(launchRouter.bootstrapped());
        assertFalse(launchRouter.creatorBought());
        assertEq(coordinator.creatorBuyAmount(), 0, "BC-116: box 0 has no creator buy");
        vm.deal(a.coordinator, 1 ether);
        vm.prank(a.coordinator);
        vm.expectRevert(abi.encodeWithSelector(bytes4(keccak256("NoCreatorBuy()"))));
        launchRouter.creatorBuy{value: 1}(eoa[0], 1);
        vm.prank(a.coordinator);
        vm.expectRevert(IBoxLaunchRouter.AlreadyBootstrapped.selector);
        launchRouter.bootstrap{value: BoxSpecV1.BOOTSTRAP_ETH}();
        vm.deal(a.coordinator, 0);
        _fund(eoa[0], 1 ether);
        vm.prank(eoa[0]);
        vm.expectRevert(abi.encodeWithSelector(IBoxLaunchRouter.NotCoordinator.selector, eoa[0]));
        launchRouter.creatorBuy{value: 1}(eoa[0], 1);
        vm.prank(eoa[0]);
        vm.expectRevert(abi.encodeWithSelector(IBoxLaunchRouter.NotCoordinator.selector, eoa[0]));
        launchRouter.bootstrap{value: BoxSpecV1.BOOTSTRAP_ETH}();
        vm.prank(eoa[0]);
        vm.expectRevert(abi.encodeWithSelector(IBoxLaunchRouter.NotCoordinator.selector, eoa[0]));
        launchRouter.initialize();
        Buy memory b = _measuredBuy(eoa[0], 0.01 ether, eoa[0], 1);
        assertFalse(b.ok, "a window buy before the open");
        bytes memory gate =
            _hookRevert(IHooks.beforeSwap.selector, abi.encodeWithSelector(IBoxHook.TradingNotOpen.selector, open));
        vm.prank(eoa[0]);
        vm.expectRevert(gate);
        routerSwapper.swapOne{value: 0.01 ether}(
            poolKey,
            SwapParams({
                zeroForOne: true, amountSpecified: -int256(0.01 ether), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            "",
            eoa[0]
        );
        assertEq(token.totalSupply() + token.totalBurned(), BoxSpecV1.ISSUANCE);
        assertEq(token.balanceOf(address(kit)), 0, "the bootstrap's T was burned");
    }

    // ============================================================================================ L6 the swap

    /// P2.14 / BC-096 / D1: the router's swap is exact input with P1 as the price limit: a buy whose net input would
    /// cross P1 stops at P1, closes the curve in its own afterSwap, charges tax only on what entered the curve and
    /// refunds the unspent input plus the tax on it in the same call; a past deadline or a short output reverts the
    /// whole buy (nothing closed, nothing kept).
    function testProperty_AUDIT_U2_partialCloseStopsAtP1AndRefundsTheUnspentInputWithItsTax() public {
        _toWindow();
        uint256 step = (vm.getBlockTimestamp() - hook.openAt()) / SLOT;
        uint256 pips = launchRouter.taxPips(step);
        uint256 need = _qToP1();
        uint256 gross = _grossFor(need + 2 ether, pips);
        uint256 fullTax = _ceilTax(gross, pips);
        // A short output reverts everything.
        _fund(eoa[2], gross);
        vm.prank(eoa[2]);
        (bool ok, bytes memory err) = a.launchRouter.call{value: gross}(
            abi.encodeCall(IBoxLaunchRouter.buy, (gross, type(uint256).max, eoa[2], vm.getBlockTimestamp()))
        );
        assertFalse(ok);
        assertEq(_selector(err), IBoxLaunchRouter.InsufficientOutput.selector);
        assertFalse(hook.closed(), "a reverted closing buy closes nothing");
        // A past deadline too.
        vm.prank(eoa[2]);
        (ok, err) = a.launchRouter.call{value: gross}(
            abi.encodeCall(IBoxLaunchRouter.buy, (gross, 1, eoa[2], vm.getBlockTimestamp() - 1))
        );
        assertFalse(ok);
        assertEq(_selector(err), IBoxLaunchRouter.Expired.selector);
        vm.deal(eoa[2], 0);
        Buy memory b = _measuredBuy(eoa[2], gross, eoa[2], 1);
        assertTrue(b.ok);
        assertTrue(b.closed);
        assertEq(_sqrtPrice(), curve.sqrtPriceLowerX96, "stopped exactly at P1");
        assertEq(uint8(hook.phase()), uint8(BoxPhase.Closed));
        uint256 unspent = (gross - fullTax) - b.spent;
        assertEq(b.refund, unspent + (fullTax - b.tax), "refund == unspent input + the tax on it");
        assertEq(b.tax, _partialTax(gross, b.spent, pips));
        assertGt(b.spent, need, "the spend covered the curve's remaining Q and the LP fee on it");
        assertGt(b.tOut, 0);
        _assertGhostLedger();
    }

    // ============================================================================================ L7 rounding

    /// P2.15: the gross tax is ceil(qIn x pips / 10^6): above the exact tax by less than one wei; the partial-fill tax
    /// ceil(spent x pips / (10^6 - pips)) likewise, and never above the gross tax.
    function testFuzz_AUDIT_U2_taxRoundingFavoursTheBoxByLessThanOneWei(uint128 qIn, uint8 stepRaw, uint128 spent)
        public
        view
    {
        uint256 step = uint256(stepRaw) % 32;
        uint256 pips = launchRouter.taxPips(step);
        uint256 tax = launchRouter.taxFor(qIn, step);
        assertGe(tax * PIPS, uint256(qIn) * pips, "never below the exact tax");
        assertLt(tax * PIPS - uint256(qIn) * pips, PIPS, "less than one wei above it");
        uint256 full = _ceilTax(qIn, pips);
        spent = uint128(bound(uint256(spent), 0, uint256(qIn) - (full > qIn ? qIn : full)));
        uint256 p = _partialTax(qIn, spent, pips);
        assertLe(p, full);
        uint256 kept = (uint256(spent) * pips + (PIPS - pips) - 1) / (PIPS - pips);
        if (kept <= full) {
            assertGe(kept * (PIPS - pips), uint256(spent) * pips, "the same rate on the spent input, rounded up");
            assertLt(kept * (PIPS - pips) - uint256(spent) * pips, PIPS - pips);
        }
    }

    /// P2.15: the smallest buy each step accepts. 1 wei is refused at every step (its tax rounds to the whole wei); a
    /// gross whose net input is 1 wei is refused too (the pool's 1% LP fee rounds that wei away and nothing comes
    /// out); the least gross is the first q whose net input q - ceil(q x pips) reaches 2 wei, and one wei less is
    /// refused (AmountTooSmall both ways).
    function testProperty_AUDIT_U2_minimumBuyPerStep() public {
        uint256 open = hook.openAt();
        for (uint256 step; step < 32; ++step) {
            uint256 snap = vm.snapshotState();
            _warpTo(open + step * SLOT);
            _minimumBuyAt(step);
            vm.revertToState(snap);
        }
    }

    function _minimumBuyAt(uint256 step) internal {
        uint256 pips = launchRouter.taxPips(step);
        Buy memory one = _measuredBuy(eoa[0], 1, eoa[0], 1);
        assertFalse(one.ok, "1 wei is refused");
        assertEq(_selector(one.err), IBoxLaunchRouter.AmountTooSmall.selector);
        uint256 least;
        for (uint256 q = 2; q <= 128; ++q) {
            uint256 s2 = vm.snapshotState();
            Buy memory b = _measuredBuy(eoa[0], q, eoa[0], 1);
            vm.revertToState(s2);
            if (b.ok) {
                least = q;
                break;
            }
            assertEq(_selector(b.err), IBoxLaunchRouter.AmountTooSmall.selector, "below the least: AmountTooSmall");
        }
        assertGt(least, 1, "a least gross exists below 128 wei");
        assertGe(least - _ceilTax(least, pips), 2, "its net input is at least 2 wei");
        assertLt((least - 1) - _ceilTax(least - 1, pips), 2, "one wei less nets under 2 wei");
        Buy memory m = _measuredBuy(eoa[0], least, eoa[0], 1);
        assertTrue(m.ok);
        assertEq(least, m.spent + m.tax + m.refund);
        assertEq(m.spent, least - _ceilTax(least, pips));
        assertGt(m.tOut, 0);
    }

    /// P2.15: a buy of the raise at step 0 (93% tax, no close) and at step 31, and a buy of 100 x R that closes the
    /// curve, each conserve to the wei.
    function testProperty_AUDIT_U2_buysOfTheRaiseAndBeyondConserve() public {
        uint256 open = hook.openAt();
        uint256 snap = vm.snapshotState();
        _warpTo(open);
        Buy memory r0b = _measuredBuy(eoa[1], raise, eoa[1], 1);
        assertTrue(r0b.ok);
        assertEq(r0b.refund, 0, "at step 0 the raise nets 6.8%: no close");
        assertEq(raise, r0b.spent + r0b.tax);
        vm.revertToState(snap);
        _warpTo(open + 31 * SLOT);
        Buy memory r31 = _measuredBuy(eoa[1], raise, eoa[1], 1);
        assertTrue(r31.ok);
        assertEq(raise, r31.spent + r31.tax + r31.refund);
        Buy memory big = _measuredBuy(eoa[2], 100 * raise, eoa[2], 1);
        assertTrue(big.ok);
        assertTrue(big.closed);
        assertEq(100 * raise, big.spent + big.tax + big.refund);
        assertEq(big.tax, _partialTax(100 * raise, big.spent, launchRouter.taxPips(31)));
        _assertGhostLedger();
    }

    // ============================================================================================ L3 the refund

    /// P2.10: a payer whose `receive` reverts, or uses all the gas it is given, makes the whole closing buy revert
    /// (RefundFailed): no tax kept, no T delivered, the curve still open; the same buy by a plain payer passes.
    function testProperty_AUDIT_U2_refundToARefusingOrGasBurningPayerRevertsTheWholeBuy() public {
        _toWindow();
        uint256 step = (vm.getBlockTimestamp() - hook.openAt()) / SLOT;
        uint256 gross = _grossFor(_qToP1() + 1 ether, launchRouter.taxPips(step));
        AuditActor[2] memory payers = [ethRefuser, gasBurner];
        for (uint256 i; i < 2; ++i) {
            AuditActor p = payers[i];
            vm.deal(address(p), gross);
            uint256 tax0 = launchRouter.totalTaxCollected();
            uint256 rb0 = a.launchRouter.balance;
            uint256 pm0 = address(pm).balance;
            bytes memory data = abi.encodeCall(IBoxLaunchRouter.buy, (gross, 1, address(p), vm.getBlockTimestamp()));
            (bool ok, bytes memory err) =
                address(p).call{gas: 30_000_000}(abi.encodeCall(AuditActor.exec, (a.launchRouter, gross, data)));
            assertFalse(ok, "the closing buy reverted as a whole");
            assertEq(_selector(err), IBoxLaunchRouter.RefundFailed.selector);
            assertFalse(hook.closed());
            assertEq(launchRouter.totalTaxCollected(), tax0);
            assertEq(a.launchRouter.balance, rb0);
            assertEq(address(pm).balance, pm0);
            assertEq(token.balanceOf(address(p)), 0);
            assertEq(address(p).balance, gross, "the payer kept its ETH");
            vm.deal(address(p), 0);
        }
        Buy memory b = _measuredBuy(eoa[2], gross, eoa[2], 1);
        assertTrue(b.ok && b.closed);
        _assertGhostLedger();
    }

    /// P2.10 / BC-026: a payer that re-enters from the refund: `buy` and `sweep` meet the lock (Reentrancy); a
    /// `graduate()` from the refund passes (the closing transaction may graduate, BC-026) and leaves the router's
    /// figures right: the buy completes, the tax is kept, and a later `sweep()` moves exactly it.
    function testProperty_AUDIT_U2_reentryFromTheRefundMeetsTheLockAndGraduationIsAllowed() public {
        _toWindow();
        AuditU2FableReentrantPayer payer = new AuditU2FableReentrantPayer(launchRouter, coordinator);
        _ghostAddOutside(address(payer));
        uint256 gross = _grossFor(_qToP1() + 1 ether, launchRouter.taxPips(_stepNow()));
        uint256 snap = vm.snapshotState();
        _reentryRound(payer, gross, false);
        vm.revertToState(snap);
        _reentryRound(payer, gross, true);
    }

    function _reentryRound(AuditU2FableReentrantPayer payer, uint256 gross, bool graduates) internal {
        payer.setGraduateOnRefund(graduates);
        vm.deal(address(payer), gross + 1 ether);
        uint256 pm0 = address(pm).balance;
        uint256 rb0 = a.launchRouter.balance;
        uint256 tax0 = launchRouter.totalTaxCollected();
        vm.recordLogs();
        uint256 tOut = payer.buy(gross);
        _checkReentries(vm.getRecordedLogs(), address(payer), graduates);
        assertTrue(hook.closed());
        assertEq(coordinator.graduated(), graduates);
        uint256 tax = a.launchRouter.balance - rb0;
        uint256 refund = address(payer).balance - 1 ether;
        if (!graduates) assertEq(gross, (address(pm).balance - pm0) + tax + refund, "conserved around the re-entries");
        assertEq(tax, launchRouter.totalTaxCollected() - tax0, "this buy's tax");
        assertEq(token.balanceOf(address(payer)), tOut);
        _noteEthIn(EthIn.WindowBuy, gross);
        _noteEthOut(EthOut.Refund, refund);
        _noteTOut(TOut.Buy, tOut);
        if (graduates) {
            assertEq(coordinator.rewardOf(address(payer)), coordinator.rewardCap(), "credited to the closer");
            uint256 h0 = _claims(a.hook);
            assertEq(launchRouter.sweep(), tax + rb0, "the whole router balance, this buy's tax included");
            assertEq(_claims(a.hook) - h0, tax + rb0);
        }
        _assertGhostLedger();
    }

    function _checkReentries(VmSafe.Log[] memory logs, address payer, bool graduates) internal pure {
        uint256 reentries;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != payer) continue;
            (bytes4 call_, bool ok, bytes4 err) = abi.decode(logs[i].data, (bytes4, bool, bytes4));
            ++reentries;
            if (call_ == IBoxLaunchRouter.buy.selector || call_ == IBoxLaunchRouter.sweep.selector) {
                assertFalse(ok, "the router is locked during the refund");
                assertEq(err, TransientReentrancyGuard.Reentrancy.selector);
            } else {
                assertTrue(ok, "graduate() from the closing transaction passes");
            }
        }
        assertEq(reentries, graduates ? 3 : 2);
    }

    /// Wave-1 fact: the refund is sent with all gas (`call{value}`), never a 2,300 stipend, so an EIP-7702-delegated
    /// payer receives its partial-close refund on this EVM (Osaka here, Amsterdam in the twin).
    function testProperty_AUDIT_U2_refundReachesAnEip7702Payer() public {
        _toWindow();
        uint256 step = (vm.getBlockTimestamp() - hook.openAt()) / SLOT;
        uint256 gross = _grossFor(_qToP1() + 1 ether, launchRouter.taxPips(step));
        Buy memory b = _measuredBuy(eoa7702, gross, eoa7702, 1);
        assertTrue(b.ok, "the 7702 payer's closing buy passed");
        assertTrue(b.closed);
        assertGt(b.refund, 0, "and its refund arrived");
        assertEq(gross, b.spent + b.tax + b.refund);
        emit log_named_string("evm", vm.getEvmVersion());
        _assertGhostLedger();
    }

    // ============================================================================================ L2 inert code

    /// P2.7 / BC-100: the version's launch-router implementation is no box's router: its window is long past (open 1),
    /// it holds nothing to sweep, and nobody initialises it.
    function testProperty_AUDIT_U2_routerImplementationIsInert() public {
        address impl = kit.impls().launchRouter;
        IBoxLaunchRouter r = IBoxLaunchRouter(impl);
        assertEq(r.openAt(), 1);
        _fund(eoa[0], 1 ether);
        vm.prank(eoa[0]);
        vm.expectRevert(abi.encodeWithSelector(IBoxLaunchRouter.WindowClosed.selector, 1 + 384));
        r.buy{value: 1 ether}(1 ether, 1, eoa[0], vm.getBlockTimestamp());
        vm.expectRevert(IBoxLaunchRouter.NothingToSweep.selector);
        r.sweep();
        vm.prank(a.coordinator);
        vm.expectRevert();
        r.initialize();
    }
}

/// The same under Amsterdam (Glamsterdam's repricing): the refund path and every conservation rule hold there too.
/// forge-config: default.evm_version = "amsterdam"
contract AuditU2FableRouterAmsterdamTest is AuditU2FableRouterTest {}

/// @notice The open-time rule for "Now" (openAt 0, F80): the hook, the router and the tickets all open at the creation
/// block's time + 1; the bootstrap traded in the creation block; the window's steps count from that second.
/// forge-config: default.evm_version = "osaka"
contract AuditU2FableRouterNowTest is AuditU2FableBase {
    function setUp() public override {
        _setUpAuditWorldVariant(true, 0);
    }

    /// P2.11 / AR-15 / BC-023 (Now): one open time, the next second; the window from it.
    function testProperty_AUDIT_U2_nowOpensAtTheCreationTimePlusOneEverywhere() public {
        uint256 open = createdAt + 1;
        assertEq(hook.openAt(), open, "hook: creation time + 1");
        assertEq(launchRouter.openAt(), open, "router: the same");
        assertEq(tickets.openAt(), open, "tickets: the same");
        assertEq(hook.windowEndsAt(), open + 384);
        assertTrue(launchRouter.bootstrapped(), "the bootstrap traded in the creation block");
        assertEq(hook.deployBlock(), createdAtBlock);
        // Still the creation block: nothing but the bootstrap could trade (the router refuses: not open).
        Buy memory b = _measuredBuy(eoa[0], 0.01 ether, eoa[0], 1);
        assertFalse(b.ok);
        assertEq(b.err, abi.encodeWithSelector(IBoxLaunchRouter.NotOpen.selector, open));
        // The next block (12 s on Ethereum) is step 0; (12 s + 1 s) / 12 is step 0 too, the second block step 1.
        _advance(1);
        b = _measuredBuy(eoa[0], 0.01 ether, eoa[0], 1);
        assertTrue(b.ok);
        assertEq(b.step, 0);
        _advance(1);
        b = _measuredBuy(eoa[1], 0.01 ether, eoa[1], 1);
        assertTrue(b.ok);
        assertEq(b.step, 1);
        _warpTo(open + 384);
        b = _measuredBuy(eoa[1], 0.01 ether, eoa[1], 1);
        assertFalse(b.ok);
        assertEq(b.err, abi.encodeWithSelector(IBoxLaunchRouter.WindowClosed.selector, open + 384));
        _assertGhostLedger();
    }
}
