// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";
import {BoxSwapModule} from "../../../src/box/BoxSwapModule.sol";
import {IBoxPriceAverage} from "../../../src/box/interfaces/IBoxHook.sol";
import {IBoxSwapModule} from "../../../src/box/interfaces/IBoxSwapModule.sol";
import {ClaimsFunder} from "../../utils/ClaimsFunder.sol";
import {BoxS45Base} from "./BoxS45Base.sol";
import {EthClaimsMinter, SettablePriceAverage} from "./BoxS45Mocks.sol";

/// @notice TEST ONLY: the fixtures of S5.M2's module tests (docs/design/swap-module-v1.md § 4.3-4.8): Standard boxes
/// with a real `BoxSwapModule` clone (BoxS45Base's `realModule`), graduated on a local PoolManager, budgets fed through
/// the receiver's own split, the box's price sampler made ready, and independent re-computations of the bounds from
/// TickMath (so the module is not checked against its own library).
abstract contract BoxSwapModuleBase is BoxS45Base {
    using StateLibrary for IPoolManager;

    uint256 internal constant Q96 = 1 << 96;
    int24 internal constant IMPACT = 49;
    int24 internal constant BAND = 99;
    /// The minimum-output and fee-note slack: ⌊49 / 60⌋ + 4 swap steps (FitBuybackExecutor `_maxSwapSteps`).
    uint256 internal constant SLACK = 4;

    EthClaimsMinter internal minter;
    ClaimsFunder internal funder;

    struct Result {
        IBoxSwapModule.Stop stop;
        uint256 amountIn;
        uint256 amountOut;
        uint256 tip;
    }

    function _setUpModuleWorld() internal {
        _setUpWorld();
        minter = new EthClaimsMinter(pm);
        funder = new ClaimsFunder(pm);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Boxes

    /// A Standard box with a real module; `settable` uses SettablePriceAverage instead of the box's sampler.
    function _mp(uint8 qs, uint8 ts, bool settable) internal pure returns (Params memory p) {
        p = _standardParams(address(0));
        (p.qStream, p.tStream, p.realModule) = (qs, ts, true);
        if (settable) p.averageKind = 1;
    }

    /// The default box: BUYBACK_BURN_T (buyers' 10/15 bought and burned) and BURN_T, W4's sells of FIT's 3/15.
    function _defaultParams() internal pure returns (Params memory) {
        return _mp(BoxSpecV1.Q_STREAM_BUYBACK_BURN_T, BoxSpecV1.T_STREAM_BURN_T, false);
    }

    function _graduatedBox(Params memory p) internal returns (Box memory b) {
        b = _buildAndLaunch(p);
        _skipWindow(b);
        _closeAndGraduate(b);
    }

    function _m(Box memory b) internal pure returns (BoxSwapModule) {
        return BoxSwapModule(b.module);
    }

    /// The price average ready at the current price: the sampler's first poke (P1) and a full hour; a settable one
    /// set to spot (average and sample).
    function _readyAverage(Box memory b) internal {
        if (_isSettable(b)) {
            int24 t = _spotTick(b);
            SettablePriceAverage(b.average).set(true, t, t);
            return;
        }
        IBoxPriceAverage(b.average).poke();
        _roll(301);
        IBoxPriceAverage(b.average).poke();
    }

    /// The sampler poked every block for `blocks` blocks at the current price (the average follows the price).
    function _hold(Box memory b, uint256 blocks) internal {
        for (uint256 i; i < blocks; ++i) {
            _roll(1);
            IBoxPriceAverage(b.average).poke();
        }
    }

    /// The tick of the pool's √price (Slot0's tick reads one lower when a downward swap ended exactly on a tick, as
    /// `migrate`'s walk to P1 does).
    function _spotTick(Box memory b) internal view returns (int24) {
        return TickMath.getTickAtSqrtPrice(_sqrtP(b));
    }

    function _isSettable(Box memory b) internal view returns (bool) {
        return b.average.code.length != 45 + 60;
    }

    // ------------------------------------------------------------------------------------------------------------
    // Budgets, through the receiver's own split

    /// A Q batch by `fundFees` (BUYBACK_BURN_T books 10/15 to the module's burn-buy ledger).
    function _feedQ(Box memory b, uint256 q) internal {
        vm.deal(address(this), address(this).balance + q);
        b.receiver.fundFees{value: q}();
    }

    /// A T batch of `t` with the smallest valid Q batch beside it (FIT's 3/15, SELL_FOR_Q's 10/15 after graduation).
    function _feedT(Box memory b, uint256 t) internal {
        deal(address(b.t), bob, b.t.balanceOf(bob) + t);
        funder.deposit(address(b.t), bob, t, address(b.receiver));
        _mintQ(b, 0.01 ether);
        b.receiver.collect(keeper);
    }

    function _mintQ(Box memory b, uint256 q) internal {
        vm.deal(address(this), address(this).balance + q);
        minter.mintTo{value: q}(address(b.receiver));
    }

    // ------------------------------------------------------------------------------------------------------------
    // Steps

    function _step(Box memory b, IBoxSwapModule.Action a, address tipTo) internal returns (Result memory r) {
        (r.stop, r.amountIn, r.amountOut, r.tip) = _m(b).step(a, tipTo);
    }

    function _budgets(Box memory b) internal view returns (uint256 qBurn, uint256 tForFit, uint256 tBurnPending) {
        (qBurn,, tForFit,, tBurnPending) = _m(b).budgets();
    }

    /// Σ Q ledgers == the module's Q claims, Σ T ledgers == its T claims, the T to burn == its T balance (BC-132).
    function _assertLedgersAreClaims(Box memory b) internal view {
        (uint256 qBurn, uint256 qCreator, uint256 tForFit, uint256 tForCreator, uint256 tBurn) = _m(b).budgets();
        assertEq(qBurn + qCreator, _claims(b.module, address(0)), "the module's Q ledgers are its Q claims");
        assertEq(tForFit + tForCreator, _claims(b.module, address(b.t)), "the module's T ledgers are its T claims");
        assertEq(tBurn, b.t.balanceOf(b.module), "the T held to burn is its T balance");
        assertEq(b.module.balance, 0, "the module holds no ETH");
    }

    // ------------------------------------------------------------------------------------------------------------
    // An attacker's round trip around a step (BC-129's sandwich)

    /// The push: `ticks` the step's way in the step's block (buys: T dearer, sells: T cheaper). Returns what `a` paid
    /// (buys: Q; sells: T) and what it got.
    function _push(Box memory b, bool buy, uint256 ticks, address a) internal returns (uint256 paid, uint256 got) {
        // forge-lint: disable-next-line(unsafe-typecast)
        int24 d = int24(int256(ticks));
        uint160 limit = TickMath.getSqrtPriceAtTick(buy ? _spotTick(b) - d : _spotTick(b) + d);
        if (buy) {
            (got, paid) = _buy(b, a, 50 ether, limit);
            return (paid, got);
        }
        uint256 tIn = 100_000_000e18;
        deal(address(b.t), a, tIn);
        uint256 e0 = a.balance;
        vm.startPrank(a);
        b.t.approve(address(swapper), type(uint256).max);
        // forge-lint: disable-next-line(unsafe-typecast)
        swapper.swap(b.key, false, -int256(tIn), limit);
        paid = tIn - b.t.balanceOf(a);
        // The T it did not sell leaves, so its T balance is what the unwind buys back.
        b.t.transfer(address(0xdead), b.t.balanceOf(a));
        vm.stopPrank();
        got = a.balance - e0;
    }

    /// The unwind: sells the T bought (returns the Q back), or buys back with the Q received (returns the T back).
    function _unwind(Box memory b, bool buy, uint256 got, address a) internal returns (uint256) {
        if (buy) return _sell(b, a, got);
        vm.prank(a);
        // forge-lint: disable-next-line(unsafe-typecast)
        swapper.swap{value: got}(b.key, true, -int256(got), 0);
        return b.t.balanceOf(a);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Independent bounds (TickMath only)

    /// Buys: the higher of the average and the latest sample (cheaper T); sells: the lower (dearer T).
    function _ref(Box memory b, bool buy) internal view returns (int24) {
        (, int24 avg,) = IBoxPriceAverage(b.average).twap();
        int24 sample = IBoxPriceAverage(b.average).latestSampleTick();
        if (buy) return sample > avg ? sample : avg;
        return sample < avg ? sample : avg;
    }

    function _bandSqrt(bool buy, int24 refTick) internal pure returns (uint160) {
        return TickMath.getSqrtPriceAtTick(buy ? refTick - BAND : refTick + BAND);
    }

    /// √spot moved by at most 49 ticks: buys down, sells up.
    function _impactSqrt(bool buy, uint160 sqrtSpot) internal pure returns (uint256) {
        return buy
            ? FullMath.mulDivRoundingUp(sqrtSpot, TickMath.getSqrtPriceAtTick(-IMPACT), Q96)
            : FullMath.mulDiv(sqrtSpot, TickMath.getSqrtPriceAtTick(IMPACT), Q96);
    }

    /// The step's limit by § 4.4: the nearer to spot of the impact and the band (0: none left).
    function _limit(bool buy, uint160 sqrtSpot, int24 refTick) internal pure returns (uint160) {
        uint256 impact = _impactSqrt(buy, sqrtSpot);
        uint256 band = _bandSqrt(buy, refTick);
        uint256 l = buy ? (impact > band ? impact : band) : (impact < band ? impact : band);
        if (buy ? l >= sqrtSpot : l <= sqrtSpot) return 0;
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint160(l);
    }

    /// (in − 1% − 2 slack) at the limit price, less the slack.
    function _minOut(bool buy, uint256 amountIn, uint160 limit) internal pure returns (uint256) {
        uint256 net = amountIn * 99 / 100;
        if (net <= 2 * SLACK) return 0;
        uint256 out = buy
            ? FullMath.mulDiv(FullMath.mulDiv(net - 2 * SLACK, limit, Q96), limit, Q96)
            : FullMath.mulDiv(FullMath.mulDiv(net - 2 * SLACK, Q96, limit), Q96, limit);
        return out > SLACK ? out - SLACK : 0;
    }

    function _tipOf(uint256 q) internal pure returns (uint256 t) {
        t = q * 500 / 10_000;
        if (t > 0.0005 ether) t = 0.0005 ether;
    }

    /// T valued in Q at a tick (T per Q = 1.0001^tick).
    function _tInQ(uint256 t, int24 tick) internal pure returns (uint256) {
        uint256 s = TickMath.getSqrtPriceAtTick(tick);
        return FullMath.mulDiv(FullMath.mulDiv(t, Q96, s), Q96, s);
    }

    /// The T worth `q` of Q at a tick.
    function _qInT(uint256 q, int24 tick) internal pure returns (uint256) {
        uint256 s = TickMath.getSqrtPriceAtTick(tick);
        return FullMath.mulDiv(FullMath.mulDiv(q, s, Q96), s, Q96);
    }
}
