// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {BoxLaunchRouter} from "../../../../src/box/BoxLaunchRouter.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {IBoxHook} from "../../../../src/box/interfaces/IBoxHook.sol";
import {IBoxLaunchRouter} from "../../../../src/box/interfaces/IBoxLaunchRouter.sol";
import {TransientReentrancyGuard} from "../../../../src/libraries/TransientReentrancyGuard.sol";
import {EthIn, EthOut, TOut} from "../common/AuditGhostLedger.sol";
import {
    AuditU2ClaudeBase,
    AuditU2ClaudeBuy,
    AuditU2ClaudeGraduation,
    AuditU2ClaudeReentrantBuyer
} from "./AuditU2ClaudeBase.sol";

/// @notice U2's launch router on the factory's box 0 (mainnet build): L1 value flow, L4 the clock, L6 the PoolManager
/// path, L7 rounding. Every buy is measured from the outside (`_measuredBuy`: the payer's, the router's and the
/// PoolManager's ETH, the recipient's T) and compared with the router's `TaxedBuy` event and the ghost ledger.
/// - P2.1, P2.15 (IBoxLaunchRouter.sol:11-16, :29-30; BoxLaunchRouter.sol:24-27, :157-190; BC-022, BC-096): msg.value ==
///   pool spend + tax kept + refund to the wei, at every step, with and without a partial close, with forced ETH in
///   the router; the tax is ceil(qIn × pips / 10^6), or at a partial close ceil(spent × pips / (10^6 − pips)), so it
///   favours the box by less than 1 wei; the refund only at a close, then the price is exactly P1.
/// - P2.2 (BC-022, BC-140, F77): the tax waits in the router, never enters the curve, the raise or the Safe; after
///   graduation `sweep()` turns the router's whole balance (tax and forced ETH) into the hook's Q claims.
/// - P2.7, P2.11 (BC-023, BC-024, F80): the window [openAt, openAt + 384) to the second; the step is
///   ⌊(block.timestamp − openAt) / 12⌋ whatever the block number; the 32 entries are 1 − k^(−(32 − b)/32).
/// - P2.10: a payer that refuses the refund makes the closing buy revert whole; one that re-enters `buy` meets the lock.
/// - P2.14: the router's state-changing ABI has no exact-output entry; its swap is exact input to P1.
/// forge-config: default.evm_version = "osaka"
contract AuditU2ClaudeRouterTest is AuditU2ClaudeBase {
    /// About the swap input the curve takes to fill from creation (R / 0.99 ≈ 4.2495 ETH, the 1% fee included, less
    /// the bootstrap's 0.0015): a prefill of 50.0%-99.9% of it leaves the curve open.
    uint256 internal constant FILL_ETH = 4.25 ether;

    // ============================================================================================ conservation

    /// @notice P2.1 / P2.15 for one buy at any step, after an optional prefill in the same step, with forced ETH in the
    /// router and the T to the payer, another account or the coordinator (BC-043).
    function testFuzz_AUDIT_U2_everyWindowBuyConserves(
        uint256 stepSeed,
        uint256 qSeed,
        uint256 forcedSeed,
        uint256 prefillSeed,
        uint8 recipientKind
    ) public {
        uint256 forced = bound(forcedSeed, 0, 10 ether);
        _forceEth(a.launchRouter, forced);
        uint256 step = bound(stepSeed, 0, 31);
        uint256 offset = (stepSeed >> 8) % 12;
        _warpTo(hook.openAt() + 12 * step + offset);
        uint256 pips = launchRouter.taxPips(step);
        uint256 taxBefore = forced;
        if (prefillSeed % 3 == 0) {
            // Fill the curve to 50.0%-99.9% first (its swap input), in the same step.
            uint256 share = bound(prefillSeed >> 2, 500, 999);
            uint256 prefill = FILL_ETH * share / 1000 * PIPS / (PIPS - pips);
            AuditU2ClaudeBuy memory p = _measuredBuy(eoa[3], prefill, eoa[3]);
            if (p.ok) taxBefore += p.tax;
        }
        uint256 qIn = _logAmount(qSeed, 1, 300 ether);
        address recipient = recipientKind % 3 == 0 ? eoa[0] : (recipientKind % 3 == 1 ? eoa[1] : a.coordinator);
        AuditU2ClaudeBuy memory b = _measuredBuy(eoa[0], qIn, recipient);
        if (!b.ok) {
            bytes4 sel = bytes4(b.err);
            assertTrue(
                sel == IBoxLaunchRouter.AmountTooSmall.selector || sel == IBoxLaunchRouter.CurveIsClosed.selector,
                "only a too-small buy or a closed curve is refused in the window"
            );
            if (sel == IBoxLaunchRouter.CurveIsClosed.selector) assertTrue(b.closedBefore, "refused closed: it was");
            assertEq(b.spent + b.tax, 0, "a refused buy moves nothing");
            assertEq(a.launchRouter.balance, taxBefore, "the router's balance is unchanged");
        } else {
            _checkBuy(b, step, pips);
            assertEq(a.launchRouter.balance, taxBefore + b.tax, "the router holds forced ETH plus every tax kept");
            assertEq(
                a.launchRouter.balance, launchRouter.totalTaxCollected() + forced, "router ETH == tax counted + forced"
            );
        }
        _assertGhostLedger();
    }

    /// @notice One successful buy: conservation, the tax formula and its rounding, the refund rule, the event.
    function _checkBuy(AuditU2ClaudeBuy memory b, uint256 step, uint256 pips) internal view {
        assertEq(b.qIn, b.spent + b.tax + b.refund, "msg.value == pool spend + tax kept + refund (to the wei)");
        assertEq(b.step, step, "the step of the clock");
        assertEq(b.eventStep, step, "TaxedBuy: step");
        assertEq(b.eventTax, b.tax, "TaxedBuy: tax == what the router kept");
        assertEq(b.eventRefund, b.refund, "TaxedBuy: refund == what came back");
        assertEq(b.tDelivered, b.tokensOut, "the recipient got tokensOut");
        assertGt(b.tokensOut, 0);
        uint256 full = _taxFull(b.qIn, pips);
        if (b.refund == 0) {
            assertEq(b.tax, full, "no refund: tax == ceil(qIn x pips / 10^6)");
            assertEq(b.spent, b.qIn - full, "no refund: the whole swap input entered the pool");
            // Favours the box by less than 1 wei: tax - 1 < qIn x pips / 10^6 <= tax (pips > 0 in the window).
            assertGe(b.tax * PIPS, b.qIn * pips);
            assertLt((b.tax - 1) * PIPS, b.qIn * pips);
        } else {
            assertTrue(b.closedAfter && !b.closedBefore, "a refund only at the closing fill");
            assertEq(_sqrtP(), _p1(), "the closing fill stops exactly at P1");
            assertLt(b.spent, b.qIn - full, "a partial fill");
            assertEq(b.tax, _taxPartial(b.spent, pips), "tax == ceil(spent x pips / (10^6 - pips))");
            assertLe(b.tax, full, "never more than the gross's tax");
            assertGe(b.tax * (PIPS - pips), b.spent * pips, "the filled part pays at least its rate");
            assertLt((b.tax - 1) * (PIPS - pips), b.spent * pips, "and less than 1 wei more");
            // The refund is the unspent input and the tax on it. Its tax share is within 1 wei of the exact
            // qIn·r − spent·r/(1 − r) (r = pips / 10^6), compared by cross-multiplying with 10^6 × (10^6 − pips).
            uint256 unspent = b.qIn - full - b.spent;
            uint256 shareOfTax = full - b.tax;
            assertEq(b.refund, unspent + shareOfTax);
            uint256 scale = PIPS * (PIPS - pips);
            uint256 exactScaled = b.qIn * pips * (PIPS - pips) - b.spent * pips * PIPS;
            uint256 shareScaled = shareOfTax * scale;
            uint256 gap = shareScaled > exactScaled ? shareScaled - exactScaled : exactScaled - shareScaled;
            assertLt(gap, scale, "the refund's tax share is within 1 wei of its exact value");
            assertLe(b.refund * (PIPS - pips), (b.qIn * (PIPS - pips) - b.spent * PIPS), "never above the exact refund");
        }
    }

    /// @notice Every one of the 32 steps charges its table entry (BoxSpecV1.sol:42-52; IBoxLaunchRouter.sol:12-14), to
    /// the wei, and the table is the published one.
    function testProperty_AUDIT_U2_everyStepChargesItsTableEntry() public {
        uint24[32] memory t = launchRouter.taxTable();
        assertEq(keccak256(abi.encode(t)), BoxSpecV1.LAUNCH_TAX_TABLE_HASH, "the published table");
        assertEq(t[0], BoxSpecV1.LAUNCH_TAX_PIPS_BLOCK_0, "93.1974% in step 0");
        assertEq(t[31], BoxSpecV1.LAUNCH_TAX_PIPS_BLOCK_31, "8.0565% in step 31");
        assertEq(launchRouter.taxPips(32), 0, "0 from step 32 on");
        uint256 open = hook.openAt();
        for (uint256 s; s < 32; ++s) {
            _warpTo(open + 12 * s + (s * 5) % 12);
            assertEq(launchRouter.taxPips(s), t[s]);
            if (s > 0) assertLt(t[s], t[s - 1], "the table falls step by step");
            AuditU2ClaudeBuy memory b = _measuredBuy(eoa[s % 6], 0.01 ether + s, eoa[s % 6]);
            assertTrue(b.ok, "a small buy in every step");
            _checkBuy(b, s, t[s]);
            (uint256 qTax, uint256 swapIn) = launchRouter.quote(1 ether);
            assertEq(qTax, _taxFull(1 ether, t[s]), "quote: the step's tax");
            assertEq(qTax + swapIn, 1 ether);
        }
        _assertGhostLedger();
    }

    /// @notice BC-024: each entry is 1 − k^(−(32 − b)/32), k = 1.0001^26,880, rounded to the nearest pip:
    /// k^(−(32 − b)/32) = 1.0001^(−840 × (32 − b)) = (√P(tick −840 × (32 − b)) / 2^96)^2 with the pinned TickMath.
    function testProperty_AUDIT_U2_taxTableIsOneMinusKToTheStep() public {
        uint24[32] memory t = launchRouter.taxTable();
        uint256 worst;
        for (uint256 b; b < 32; ++b) {
            // casting to 'int24' is safe because 840 x 32 = 26,880 < 2^23
            // forge-lint: disable-next-line(unsafe-typecast)
            int24 tick = -int24(int256(840 * (32 - b)));
            uint256 sqrtP = TickMath.getSqrtPriceAtTick(tick);
            // 10^12 × (1 − price): the entry in micro-pips.
            uint256 exact = 1e12 - FullMath.mulDiv(sqrtP * sqrtP, 1e12, uint256(1) << 192);
            uint256 entry = uint256(t[b]) * 1e6;
            uint256 dev = entry > exact ? entry - exact : exact - entry;
            if (dev > worst) worst = dev;
            assertLe(dev, 500_000, "within half a pip of 1 - k^(-(32 - b)/32)");
        }
        emit log_named_uint("U2C|BC-024 worst deviation from the exact entry, micro-pips", worst);
    }

    // ============================================================================================ the clock

    /// @notice P2.7 / BC-023 to the second: before openAt nothing buys; [openAt, openAt + 384) only the router buys
    /// (sells pass anywhere); from openAt + 384 the router refuses and every route buys.
    function testProperty_AUDIT_U2_windowEdgesToTheSecond() public {
        uint256 open = hook.openAt();
        assertEq(launchRouter.openAt(), open, "router and hook: one open");
        assertEq(tickets.openAt(), open, "tickets too");
        _warpTo(open - 1);
        vm.deal(eoa[0], 1 ether);
        vm.prank(eoa[0]);
        vm.expectRevert(abi.encodeWithSelector(IBoxLaunchRouter.NotOpen.selector, open));
        launchRouter.buy{value: 0.001 ether}(0.001 ether, 1, eoa[0], open);
        vm.expectRevert(abi.encodeWithSelector(IBoxLaunchRouter.NotOpen.selector, open));
        launchRouter.quote(1 ether);
        _expectStandInBuyReverts(
            _hookRevert(IHooks.beforeSwap.selector, abi.encodeWithSelector(IBoxHook.TradingNotOpen.selector, open))
        );

        _warpTo(open);
        AuditU2ClaudeBuy memory b = _measuredBuy(eoa[0], 0.001 ether, eoa[0]);
        assertTrue(b.ok);
        assertEq(b.eventStep, 0, "the open's own second is step 0");
        _warpTo(open + 11);
        assertEq(_measuredBuy(eoa[1], 0.001 ether, eoa[1]).eventStep, 0, "openAt + 11: still step 0");
        _warpTo(open + 12);
        assertEq(_measuredBuy(eoa[1], 0.001 ether, eoa[1]).eventStep, 1, "openAt + 12: step 1");
        _warpTo(open + 383);
        b = _measuredBuy(eoa[1], 0.001 ether, eoa[1]);
        assertEq(b.eventStep, 31, "the window's last second is step 31");
        assertEq(b.tax, _taxFull(0.001 ether, BoxSpecV1.LAUNCH_TAX_PIPS_BLOCK_31));
        _expectStandInBuyReverts(
            _hookRevert(
                IHooks.beforeSwap.selector,
                abi.encodeWithSelector(IBoxHook.BuyThroughLaunchRouter.selector, a.launchRouter, open + 384)
            )
        );
        assertGt(_sell(eoa[1], token.balanceOf(eoa[1]) / 2), 0, "a sell passes in the window");

        _warpTo(open + 384);
        vm.deal(eoa[0], 1 ether);
        vm.prank(eoa[0]);
        vm.expectRevert(abi.encodeWithSelector(IBoxLaunchRouter.WindowClosed.selector, open + 384));
        launchRouter.buy{value: 0.001 ether}(0.001 ether, 1, eoa[0], open + 384);
        assertGt(_buy(eoa[4], 0.001 ether), 0, "from openAt + 384 every route buys");
        _assertGhostLedger();
    }

    function _expectStandInBuyReverts(bytes memory reason) internal {
        vm.deal(eoa[4], 1 ether);
        vm.prank(eoa[4]);
        vm.expectRevert(reason);
        routerSwapper.swapOne{value: 0.001 ether}(
            poolKey,
            SwapParams({
                zeroForOne: true, amountSpecified: -0.001 ether, sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            "",
            eoa[4]
        );
    }

    /// @notice P2.11 (F80; BoxLaunchRouter.sol:364-372): the step is a function of block.timestamp − openAt alone; the
    /// block number (any, later) changes nothing.
    function testFuzz_AUDIT_U2_taxStepDependsOnlyOnTheClock(uint256 tSeed, uint256 blockSeed, uint256 qSeed) public {
        uint256 open = hook.openAt();
        uint256 t = bound(tSeed, open, open + 383);
        vm.warp(t);
        vm.roll(vm.getBlockNumber() + bound(blockSeed, 1, 1_000_000));
        uint256 step = (t - open) / 12;
        uint256 q = bound(qSeed, 1e9, 1 ether);
        (uint256 tax,) = launchRouter.quote(q);
        assertEq(tax, launchRouter.taxFor(q, step), "quote uses the clock's step");
        AuditU2ClaudeBuy memory b = _measuredBuy(eoa[2], q, eoa[2]);
        assertTrue(b.ok);
        assertEq(b.eventStep, step, "the buy is taxed at the clock's step");
        assertEq(b.tax, tax, "and pays what quote said");
    }

    // ============================================================================================ the close

    /// @notice P2.14 / BC-096: in the window a buy that would cross P1 stops at P1, closes the curve in its own call,
    /// keeps tax only on the filled input and refunds the rest; then the router refuses (CurveIsClosed), every swap
    /// reverts until graduate(); after graduate() any route buys at the pool fee alone while the router still refuses.
    function testProperty_AUDIT_U2_partialCloseStopsAtP1AndRefundsInTheSameCall() public {
        _toWindow();
        uint256 step = (vm.getBlockTimestamp() - hook.openAt()) / 12;
        uint256 pips = launchRouter.taxPips(step);
        AuditU2ClaudeBuy memory b = _measuredBuy(eoa[5], 300 ether, eoa[5]);
        assertTrue(b.ok, "the closing buy");
        assertGt(b.refund, 0, "a partial fill with a refund");
        _checkBuy(b, step, pips);
        assertEq(hook.closedAtBlock(), vm.getBlockNumber(), "closed in its own block, by its own swap");
        AuditU2ClaudeBuy memory again = _measuredBuy(eoa[5], 1 ether, eoa[5]);
        assertEq(bytes4(again.err), IBoxLaunchRouter.CurveIsClosed.selector, "the router refuses after the close");
        (uint256 reward,) = _graduate(keeper);
        assertGt(reward, 0, "graduate() in the closing block");
        again = _measuredBuy(eoa[5], 1 ether, eoa[5]);
        assertEq(bytes4(again.err), IBoxLaunchRouter.CurveIsClosed.selector, "and after graduation");
        assertGt(_buy(eoa[4], 0.01 ether), 0, "after graduate() any route buys (1% only), inside the window's time");
        _assertGhostLedger();
    }

    /// @notice P2.1 / P2.2 / BC-140: forced ETH before the window and every tax kept wait in the router through the
    /// close and graduation (graduate() never waits for them); the curve's Q at migration is the raise, without them;
    /// `sweep()` before graduation reverts and moves nothing; after it, anyone's sweep moves the whole balance into the
    /// hook's Q claims, exactly, and the Safe receives nothing at any point.
    function testProperty_AUDIT_U2_taxAndForcedEthBecomeDepthAndNothingElse() public {
        _forceEth(a.launchRouter, 0.123456789 ether);
        uint256 open = hook.openAt();
        uint256 kept;
        _warpTo(open);
        AuditU2ClaudeBuy memory b = _measuredBuy(eoa[0], 0.1 ether, eoa[0]);
        kept += b.tax;
        _warpTo(open + 12 * 31);
        b = _measuredBuy(eoa[1], 1 ether, eoa[1]);
        kept += b.tax;
        // BC-140's figures: 0.1 ETH at step 0 and 1 ETH at step 31 keep 0.1737624 ETH.
        assertEq(kept, 173_762_400_000_000_000, "BC-140: 0.0931974 + 0.080565 ETH");
        b = _measuredBuy(eoa[2], 300 ether, eoa[2]);
        assertGt(b.refund, 0, "closed by a partial fill at step 31");
        kept += b.tax;
        assertEq(launchRouter.totalTaxCollected(), kept);
        vm.expectRevert(IBoxLaunchRouter.NotGraduated.selector);
        launchRouter.sweep();
        assertEq(a.launchRouter.balance, kept + 0.123456789 ether, "a refused sweep moves nothing");

        AuditU2ClaudeGraduation memory g = _graduateRecorded(keeper);
        assertGt(g.reward, 0);
        assertEq(g.qFromCurve, raise, "the curve held exactly the raise at P1: no tax in it");
        assertEq(a.launchRouter.balance, kept + 0.123456789 ether, "graduation does not touch the router");
        assertEq(safe.balance, 0, "the Safe has nothing");
        assertEq(pm.balanceOf(safe, 0), 0);

        uint256 hookClaims = pm.balanceOf(a.hook, 0);
        vm.prank(eoa[7]);
        uint256 swept = launchRouter.sweep();
        assertEq(swept, kept + 0.123456789 ether, "sweep moves tax and forced ETH");
        assertEq(pm.balanceOf(a.hook, 0) - hookClaims, swept, "into the hook's Q claims, exactly");
        assertEq(a.launchRouter.balance, 0);
        assertEq(launchRouter.totalSwept(), swept);
        assertEq(safe.balance, 0, "the Safe still has nothing");
        assertEq(pm.balanceOf(safe, 0), 0);
        vm.expectRevert(IBoxLaunchRouter.NothingToSweep.selector);
        launchRouter.sweep();
        _assertGhostLedger();
    }

    // ============================================================================================ the payer

    /// @notice P2.10: the closing buy of a payer whose `receive` reverts reverts whole (`RefundFailed`): no tax kept, no
    /// T delivered, the curve still open; the same payer's buy without a refund passes.
    function testProperty_AUDIT_U2_refusingPayerRevertsTheWholeClosingBuy() public {
        _toWindow();
        address payer = address(ethRefuser);
        vm.deal(payer, 400 ether);
        uint256 r0_ = a.launchRouter.balance;
        uint256 p0 = address(pm).balance;
        vm.expectRevert(IBoxLaunchRouter.RefundFailed.selector);
        ethRefuser.exec(
            a.launchRouter,
            300 ether,
            abi.encodeCall(IBoxLaunchRouter.buy, (300 ether, 1, payer, vm.getBlockTimestamp()))
        );
        assertEq(a.launchRouter.balance, r0_, "no tax kept");
        assertEq(address(pm).balance, p0, "nothing entered the pool");
        assertEq(token.balanceOf(payer), 0, "no T delivered");
        assertFalse(hook.closed(), "the curve is still open");
        assertEq(payer.balance, 400 ether);
        // Without a refund nothing is sent back, so the same payer buys.
        ethRefuser.exec(
            a.launchRouter,
            0.01 ether,
            abi.encodeCall(IBoxLaunchRouter.buy, (0.01 ether, 1, payer, vm.getBlockTimestamp()))
        );
        assertGt(token.balanceOf(payer), 0);
    }

    /// @notice P2.10: a payer that re-enters `buy` from the refund's `receive` meets the router's lock (Reentrancy);
    /// the outer closing buy completes and conserves.
    function testProperty_AUDIT_U2_reenteringPayerMeetsTheLock() public {
        _toWindow();
        AuditU2ClaudeReentrantBuyer rb = new AuditU2ClaudeReentrantBuyer(launchRouter);
        vm.deal(address(rb), 0);
        uint256 r0_ = a.launchRouter.balance;
        uint256 p0 = address(pm).balance;
        vm.deal(address(this), 300 ether);
        uint256 out = rb.buy{value: 300 ether}(300 ether, address(rb));
        assertGt(out, 0);
        assertTrue(hook.closed());
        assertFalse(rb.innerSucceeded(), "the inner buy did not pass");
        assertEq(bytes4(rb.innerRevert()), TransientReentrancyGuard.Reentrancy.selector, "refused by the lock");
        uint256 refund = address(rb).balance;
        uint256 tax = a.launchRouter.balance - r0_;
        uint256 spent = address(pm).balance - p0;
        assertEq(300 ether, spent + tax + refund, "the outer buy conserves");
        // Booked by hand: the stand-in payer is outside the ghost ledger.
        _ghostAddOutside(address(rb));
        _noteEthIn(EthIn.WindowBuy, 300 ether);
        _noteEthOut(EthOut.Refund, refund);
        _noteTOut(TOut.Buy, out);
        _assertGhostLedger();
    }

    // ============================================================================================ the ABI

    /// @notice P2.14: the router's only state-changing entry points are initialize, bootstrap, creatorBuy, buy, sweep
    /// and unlockCallback (read from the compiled ABI): no exact-output buy, no sell, no admin; buy is exact input.
    function testProperty_AUDIT_U2_routerOffersNoExactOutputPath() public view {
        string memory json =
            vm.readFile(string.concat(vm.projectRoot(), "/out/BoxLaunchRouter.sol/BoxLaunchRouter.json"));
        string[6] memory expected = ["bootstrap", "buy", "creatorBuy", "initialize", "sweep", "unlockCallback"];
        uint256 found;
        for (uint256 i;; ++i) {
            string memory k = string.concat(".abi[", vm.toString(i), "]");
            if (!vm.keyExistsJson(json, k)) break;
            if (keccak256(bytes(vm.parseJsonString(json, string.concat(k, ".type")))) != keccak256("function")) {
                continue;
            }
            string memory m = vm.parseJsonString(json, string.concat(k, ".stateMutability"));
            if (keccak256(bytes(m)) == keccak256("view") || keccak256(bytes(m)) == keccak256("pure")) continue;
            string memory name = vm.parseJsonString(json, string.concat(k, ".name"));
            bool listed;
            for (uint256 j; j < expected.length; ++j) {
                if (keccak256(bytes(name)) == keccak256(bytes(expected[j]))) listed = true;
            }
            assertTrue(listed, string.concat("an unlisted state-changing function: ", name));
            ++found;
        }
        assertEq(found, expected.length, "exactly the six");
    }

    // ============================================================================================ the wiring (L8)

    /// @notice P2.17 / BC-012 for the router and the coordinator: every argument view names box 0's own contracts and
    /// the build's numbers (the router's price limit is the curve's P1: a closing fill stops exactly there, pinned by
    /// the partial-close tests); the router implementation is inert (its `initialize` refuses everyone, its window is
    /// 1970's, its `sweep` has nothing; BoxLaunchRouter.sol:91-97).
    function testProperty_AUDIT_U2_routerNamesItsBoxAndItsImplementationIsInert() public {
        assertEq(launchRouter.coordinator(), a.coordinator);
        assertEq(launchRouter.hook(), a.hook);
        assertEq(launchRouter.token(), a.token);
        assertEq(launchRouter.q(), address(0), "native ETH");
        assertEq(uint8(launchRouter.kind()), uint8(coordinator.kind()), "box 0's kind");
        assertEq(address(launchRouter.poolManager()), address(pm));
        assertEq(launchRouter.coordinatorImplementation(), kit.impls().coordinator);
        assertEq(launchRouter.openAt(), hook.openAt());
        assertEq(coordinator.launchRouter(), a.launchRouter);
        assertEq(hook.launchRouter(), a.launchRouter, "the hook's gate names the same router");
        assertEq(coordinator.q(), address(0));
        assertEq(coordinator.raise(), raise);
        assertEq(coordinator.poolManager(), address(pm));
        assertEq(coordinator.factory(), address(factory));
        assertEq(coordinator.creatorBuyAmount(), 0);
        assertEq(coordinator.executor(), a.executor);
        assertEq(coordinator.randomness(), address(src), "the pinned backed source");
        assertEq(coordinator.POKE_GAS(), POKE_GAS);
        assertEq(hook.coordinator(), a.coordinator);
        assertEq(hook.raise(), raise);
        // The implementation: never a box's router.
        BoxLaunchRouter impl = BoxLaunchRouter(payable(kit.impls().launchRouter));
        assertEq(impl.openAt(), 1, "the implementation's open is 1970's second 1");
        vm.prank(a.coordinator);
        vm.expectRevert(abi.encodeWithSelector(IBoxLaunchRouter.NotCoordinator.selector, a.coordinator));
        impl.initialize();
        vm.deal(eoa[0], 1 ether);
        vm.prank(eoa[0]);
        vm.expectRevert(abi.encodeWithSelector(IBoxLaunchRouter.WindowClosed.selector, 1 + 384));
        impl.buy{value: 1}(1, 1, eoa[0], vm.getBlockTimestamp());
        vm.expectRevert(IBoxLaunchRouter.NothingToSweep.selector);
        impl.sweep();
        vm.expectRevert(abi.encodeWithSelector(IBoxLaunchRouter.WindowClosed.selector, 1 + 384));
        impl.quote(1 ether);
        vm.deal(eoa[0], 0);
    }

    // ============================================================================================ the bootstrap

    /// @notice P2.6 / BC-004 / M03: after creation T is held by the pool and the coordinator only, the bootstrap's T was
    /// burned in the creation transaction (supply + burned == 1e27, burned > 0); the bootstrap and a creator buy are
    /// refused for good (AlreadyBootstrapped; NoCreatorBuy for box 0); no other pre-open buy exists.
    function testProperty_AUDIT_U2_bootstrapBurnedAndNoOtherPreOpenBuy() public {
        assertEq(token.totalSupply() + token.totalBurned(), BoxSpecV1.ISSUANCE);
        assertGt(token.totalBurned(), 0, "the bootstrap's T was burned");
        assertEq(token.balanceOf(address(pm)) + token.balanceOf(a.coordinator), token.totalSupply(), "two holders");
        assertEq(token.balanceOf(a.coordinator), curve.poolShare, "the coordinator holds exactly the pool share");
        assertEq(token.balanceOf(address(pm)) + token.totalBurned(), curve.curveT, "the curve's T less the bootstrap's");
        assertTrue(launchRouter.bootstrapped());
        assertFalse(launchRouter.creatorBought());
        assertEq(coordinator.creatorBuyAmount(), 0, "box 0's spec carries no creator buy");
        vm.deal(a.coordinator, 1 ether);
        vm.prank(a.coordinator);
        vm.expectRevert(IBoxLaunchRouter.AlreadyBootstrapped.selector);
        launchRouter.bootstrap{value: BoxSpecV1.BOOTSTRAP_ETH}();
        vm.prank(a.coordinator);
        vm.expectRevert(BoxLaunchRouter.NoCreatorBuy.selector);
        launchRouter.creatorBuy{value: 0.1 ether}(eoa[0], 0.1 ether);
        vm.deal(eoa[0], 1 ether);
        vm.prank(eoa[0]);
        vm.expectRevert(abi.encodeWithSelector(IBoxLaunchRouter.NotCoordinator.selector, eoa[0]));
        launchRouter.bootstrap{value: BoxSpecV1.BOOTSTRAP_ETH}();
        vm.deal(a.coordinator, 0);
    }
}

/// @notice The 7702 check for U2's two ETH payments to an address a user chooses or controls (task note, wave 1: under
/// Amsterdam a value call to an EIP-7702-delegated EOA leaves its delegate about 3,000 gas less than a direct call, so a
/// 2,300-gas stipend to one fails): the launch router's refund (`BoxLaunchRouter.sol:187`, `msg.sender.call{value}`,
/// all gas) and the reward (`BoxCoordinator.sol:303`, :316 → v4 `CurrencyLibrary.transfer`, `call(gas(), ...)`,
/// lib/v4-core/src/types/Currency.sol:48). Neither is stipend-only, so both reach the world's 7702 EOA on Osaka and
/// Amsterdam; the control shows a 2,300 stipend to the same account failing on Amsterdam only.
/// forge-config: default.evm_version = "osaka"
contract AuditU2ClaudeEth7702Test is AuditU2ClaudeBase {
    function testProperty_AUDIT_U2_stipendControlOnThe7702Account() public {
        vm.deal(address(this), 1 ether);
        bool ok = payable(eoa7702).send(1);
        if (_isAmsterdam()) assertFalse(ok, "control: a 2,300 stipend to the 7702 EOA fails under Amsterdam");
        else assertTrue(ok, "control: the stipend reaches it under Osaka");
        (bool full,) = eoa7702.call{value: 1}("");
        assertTrue(full, "with all gas it accepts on both forks");
    }

    function testProperty_AUDIT_U2_routerRefundReachesA7702Payer() public {
        _toWindow();
        uint256 e0 = eoa7702.balance;
        AuditU2ClaudeBuy memory b = _measuredBuy(eoa7702, 300 ether, eoa7702);
        assertTrue(b.ok, "the 7702 EOA's closing buy");
        assertGt(b.refund, 0, "with a refund");
        assertEq(eoa7702.balance, e0 + b.refund, "the refund reached the delegated account");
        _assertGhostLedger();
    }

    function testProperty_AUDIT_U2_rewardReachesA7702Recipient() public {
        _toClosed();
        uint256 snap = vm.snapshotState();
        // The 7702 EOA graduates and pulls its own reward.
        (uint256 reward,) = _graduate(eoa7702);
        assertGt(reward, 0);
        uint256 e0 = eoa7702.balance;
        assertEq(_claimReward(eoa7702, eoa7702), reward);
        assertEq(eoa7702.balance - e0, reward, "paid to the delegated account");
        _assertGhostLedger();
        vm.revertToState(snap);
        // A keeper's reward sent to the 7702 EOA.
        (reward,) = _graduate(keeper);
        e0 = eoa7702.balance;
        assertEq(_claimReward(keeper, eoa7702), reward);
        assertEq(eoa7702.balance - e0, reward);
    }
}

/// forge-config: default.evm_version = "amsterdam"
contract AuditU2ClaudeEth7702AmsterdamTest is AuditU2ClaudeEth7702Test {}
