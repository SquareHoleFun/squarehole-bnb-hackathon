// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {BoxReceiver} from "../../../src/box/BoxReceiver.sol";
import {BoxSwapModule} from "../../../src/box/BoxSwapModule.sol";
import {BoxToken} from "../../../src/box/BoxToken.sol";
import {FitBuybackExecutor} from "../../../src/box/FitBuybackExecutor.sol";
import {DeepenSkip, DepthKind} from "../../../src/box/interfaces/BoxTypes.sol";
import {IBoxHook, IBoxPriceAverage} from "../../../src/box/interfaces/IBoxHook.sol";
import {IBoxSwapModule} from "../../../src/box/interfaces/IBoxSwapModule.sol";
import {S5M4Base} from "./S5M4Base.sol";
import {S5M4Kit} from "./S5M4Kit.sol";

/// @title S5M4Sandwich
/// @notice S5.M4's sandwich campaign (BC-129; swap-module § 4.5) against **every protocol swap step type** of version 1,
/// on box 0 as factory v1 creates it and on the kit's Standard boxes beside it: the module's `BuyBurn` and `SellForFit`
/// (box D), `BuyForCreator` and `SellForCreator` (box C, add-on 5 at 32 ETH), `deepen()`'s depth conversion on a
/// Standard box (D) and on box 0, and FIT's executor's buy-and-burn chunk (box 0's buy-back). From one state where each
/// step is due (budgets fed through the boxes' own receivers, every average ready and caught up), an attacker pushes
/// 1-150 ticks the step's way in the step's block, either after the block's sample (the step's poke is then a no-op) or
/// before it (the step's poke records the pushed price), the step runs, and the attacker unwinds at once:
/// - the attacker never profits: a push with Q gets less Q back, a push with T gets less T back (two 1% fees against at
///   most the step's own move of ≤ 49 ticks, ≈ 0.49%, all of which the box's own positions earn);
/// - the step never takes the price beyond the reference ∓ 99 ticks of its own average (buys: the cheaper-T of the
///   average and the latest sample; sells: the dearer-T), nor more than 49 ticks from where it found it; a push past
///   the band makes it wait (`AtBand`, `AtCeiling`, `Deviation`), never trade worse.
/// The bounds are recomputed here from TickMath, not from the contracts' library. The world is local (the PoolManager
/// from the pinned source) or a fork (the chain's canonical PoolManager and WETH): `_world()`.
abstract contract S5M4Sandwich is S5M4Base {
    uint256 internal constant Q96 = 1 << 96;
    int24 internal constant IMPACT = 49;
    int24 internal constant BAND = 99;

    /// Step types, in the order of the fuzzed selector.
    uint8 internal constant BUY_BURN = 0;
    uint8 internal constant SELL_FOR_FIT = 1;
    uint8 internal constant BUY_FOR_CREATOR = 2;
    uint8 internal constant SELL_FOR_CREATOR = 3;
    uint8 internal constant CONVERT_STANDARD = 4;
    uint8 internal constant CONVERT_BOX0 = 5;
    uint8 internal constant FIT_EXECUTOR = 6;

    address internal attacker = makeAddr("s5m4.attacker");
    bool internal _ready;

    /// One step type's pool, its average and whether it buys T.
    struct Target {
        PoolKey key;
        address token;
        address average;
        bool buy;
    }

    /// What the push left and what the step did.
    struct Attack {
        uint160 sqrtBefore;
        uint256 paid;
        uint256 got;
        bool traded;
    }

    function _world() internal virtual;

    /// @dev On a fork, run with `--disable-block-gas-limit`: the kit's own CREATE (its init code carries every
    /// implementation's creation code, ≈ 0.32 MB) and the version's deployment do not fit the fork block's gas limit.
    function setUp() public virtual {
        _world();
        if (_ready) {
            _createAll();
            a = k.addresses();
            _stdWindowBuy(D);
            _stdWindowBuy(C);
            _box0Graduated();
            _stdGraduated(D);
            _stdGraduated(C);
            _feed();
        }
    }

    /// Every step due from one state: fees on both sides of D and C through real trades (the module's ledgers), Q into
    /// D's and box 0's depth (conversions), FIT's executor funded and its average walked to box 0's price.
    function _feed() internal {
        S5M4Kit.StdBox memory d = _std(D);
        S5M4Kit.StdBox memory c = _std(C);
        _trade(d.key, d.token, 2 ether, 5);
        _trade(c.key, c.token, 2 ether, 5);
        _fundFees(d.receiver, 1 ether);
        _fundFees(c.receiver, 1 ether);
        _fundFees(a.receiver, 2 ether);
        _fundDepthQ(d.receiver, 1 ether);
        _fundDepthQ(a.receiver, 1 ether);
        for (uint256 i; i < 700; ++i) {
            k.roll(1);
            IBoxPriceAverage(d.sampler).poke();
            IBoxPriceAverage(c.sampler).poke();
            IBoxPriceAverage(a.executor).poke();
        }
        BoxReceiver(payable(d.receiver)).collect(keeper);
        BoxReceiver(payable(c.receiver)).collect(keeper);
        BoxReceiver(payable(a.receiver)).payFit();
        _module(D).sync();
        _module(C).sync();
        k.roll(1);
    }

    function _fundDepthQ(address receiver, uint256 q) internal {
        vm.deal(address(this), address(this).balance + q);
        BoxReceiver(payable(receiver)).fundDepth{value: q}();
    }

    // ------------------------------------------------------------------------------------------------ the campaign

    /// One fuzzed round: a push of `ticks` the step's way in a new block (after or before the block's sample), the
    /// step, the unwind.
    function _round(uint8 kind, uint256 ticks, bool sampledFirst) internal returns (bool traded) {
        if (!_ready) vm.skip(true);
        ticks = bound(ticks, 1, 150);
        Target memory t = _target(kind);
        k.roll(1);
        if (sampledFirst) IBoxPriceAverage(t.average).poke();
        Attack memory r;
        (r.paid, r.got) = _push(t, ticks);
        r.sqrtBefore = _sqrtP(t.key);
        r.traded = _step(kind);
        if (r.traded) _checkBounds(t, r.sqrtBefore);
        uint256 back = _unwind(t, r.got);
        assertLt(back, r.paid, "the attacker never profits");
        return r.traded;
    }

    /// Not vacuous: every step type trades after a 1-tick push (sampled first) and waits after a 150-tick one.
    function _everyTypeTradesAndWaits() internal {
        if (!_ready) vm.skip(true);
        for (uint8 kind; kind <= FIT_EXECUTOR; ++kind) {
            uint256 snap = vm.snapshotState();
            assertTrue(_round(kind, 1, true), "a 1-tick push: the step trades");
            vm.revertToState(snap);
            assertFalse(_round(kind, 150, true), "a 150-tick push: the step waits");
            vm.revertToState(snap);
        }
    }

    function _target(uint8 kind) internal view returns (Target memory t) {
        if (kind == CONVERT_BOX0 || kind == FIT_EXECUTOR) {
            return Target({key: k.poolKey(), token: a.token, average: a.executor, buy: true});
        }
        S5M4Kit.StdBox memory x = _std(kind == BUY_FOR_CREATOR || kind == SELL_FOR_CREATOR ? C : D);
        bool buy = kind != SELL_FOR_FIT && kind != SELL_FOR_CREATOR;
        return Target({key: x.key, token: x.token, average: x.sampler, buy: buy});
    }

    /// Runs the step; returns whether it swapped.
    function _step(uint8 kind) internal returns (bool) {
        if (kind <= SELL_FOR_CREATOR) {
            IBoxSwapModule.Action action = kind == BUY_BURN
                ? IBoxSwapModule.Action.BuyBurn
                : kind == SELL_FOR_FIT
                    ? IBoxSwapModule.Action.SellForFit
                    : kind == BUY_FOR_CREATOR
                        ? IBoxSwapModule.Action.BuyForCreator
                        : IBoxSwapModule.Action.SellForCreator;
            BoxSwapModule m = _module(kind == BUY_FOR_CREATOR || kind == SELL_FOR_CREATOR ? C : D);
            vm.prank(keeper);
            (IBoxSwapModule.Stop stop, uint256 amountIn,,) = m.step(action, keeper);
            if (stop != IBoxSwapModule.Stop.None) {
                assertEq(uint256(stop), uint256(IBoxSwapModule.Stop.AtBand), "pushed past the band: it waits");
            }
            return amountIn != 0;
        }
        if (kind == FIT_EXECUTOR) {
            vm.prank(keeper);
            (, uint256 spent,) = FitBuybackExecutor(payable(a.executor)).execute(1);
            return spent != 0;
        }
        address hook = kind == CONVERT_BOX0 ? a.hook : _std(D).hook;
        vm.recordLogs();
        vm.prank(keeper);
        (DepthKind dk, DeepenSkip skip,,,) = IBoxHook(hook).deepen(keeper);
        if (skip != DeepenSkip.None) {
            assertTrue(
                skip == DeepenSkip.Deviation || skip == DeepenSkip.ConvertBelowMin
                    || skip == DeepenSkip.AverageNotCaughtUp,
                "pushed: it waits, never worse"
            );
            return false;
        }
        assertTrue(dk == DepthKind.Convert || dk == DepthKind.Pair, "a conversion (and a pair)");
        return _converted(hook);
    }

    function _converted(address hook) internal view returns (bool) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == hook && logs[i].topics[0] == IBoxHook.DepthConverted.selector) return true;
        }
        return false;
    }

    /// The price after a step that swapped: within the band of its own reference (read after the step's poke) and at
    /// most 49 ticks from where the step found it.
    function _checkBounds(Target memory t, uint160 sqrtBefore) internal view {
        (, int24 avg,) = IBoxPriceAverage(t.average).twap();
        int24 sample = IBoxPriceAverage(t.average).latestSampleTick();
        uint160 s = _sqrtP(t.key);
        if (t.buy) {
            int24 ref = sample > avg ? sample : avg;
            assertGe(s, TickMath.getSqrtPriceAtTick(ref - BAND), "a buy never below reference - 99");
            assertGe(
                uint256(s),
                FullMath.mulDivRoundingUp(sqrtBefore, TickMath.getSqrtPriceAtTick(-IMPACT), Q96),
                "a buy moves at most 49 ticks"
            );
        } else {
            int24 ref = sample < avg ? sample : avg;
            assertLe(s, TickMath.getSqrtPriceAtTick(ref + BAND), "a sell never above reference + 99");
            assertLe(
                uint256(s),
                FullMath.mulDiv(sqrtBefore, TickMath.getSqrtPriceAtTick(IMPACT), Q96),
                "a sell moves at most 49 ticks"
            );
        }
    }

    // ------------------------------------------------------------------------------------------------ the attacker

    /// The push: `ticks` the step's way (buys: T dearer, the tick down; sells: T cheaper, the tick up), with Q for a
    /// buy and with T (from the kit's closer, bought at the close) for a sell. Returns what it paid and what it got.
    function _push(Target memory t, uint256 ticks) internal returns (uint256 paid, uint256 got) {
        // forge-lint: disable-next-line(unsafe-typecast)
        int24 d = int24(int256(ticks));
        int24 spot = _tick(t.key);
        uint160 limit = TickMath.getSqrtPriceAtTick(t.buy ? spot - d : spot + d);
        if (t.buy) {
            // The kit deals the 100 ETH; the swapper refunds what the limit left unspent.
            uint256 e0 = attacker.balance + 100 ether;
            got = k.swapOn(t.key, t.token, attacker, true, 100 ether, limit);
            paid = e0 - attacker.balance;
            return (paid, got);
        }
        // The kit's closer holds T of every box (each curve's closing buy).
        address whale = k.carol();
        uint256 stock = BoxToken(t.token).balanceOf(whale) / 2;
        vm.prank(whale);
        BoxToken(t.token).transfer(attacker, stock);
        got = k.swapOn(t.key, t.token, attacker, false, stock, limit);
        paid = stock - BoxToken(t.token).balanceOf(attacker);
        // The T it did not sell goes back, so its T balance is what the unwind buys.
        uint256 left = BoxToken(t.token).balanceOf(attacker);
        vm.prank(attacker);
        BoxToken(t.token).transfer(whale, left);
    }

    /// The unwind: the T bought sold back (returns the Q back), or the Q received spent on T (returns the T back).
    function _unwind(Target memory t, uint256 got) internal returns (uint256) {
        if (got == 0) return 0;
        if (t.buy) {
            uint256 e0 = attacker.balance;
            k.swapOn(t.key, t.token, attacker, false, got, 0);
            return attacker.balance - e0;
        }
        return k.swapOn(t.key, t.token, attacker, true, got, 0);
    }
}
