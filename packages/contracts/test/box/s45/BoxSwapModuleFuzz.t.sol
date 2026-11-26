// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {Slot0} from "v4-core/src/types/Slot0.sol";
import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";
import {IBoxPriceAverage} from "../../../src/box/interfaces/IBoxHook.sol";
import {IBoxSwapModule} from "../../../src/box/interfaces/IBoxSwapModule.sol";
import {BoundsHarness} from "./BoxSwapBounds.t.sol";
import {BoxSwapModuleBase} from "./BoxSwapModuleBase.sol";

/// @notice S5.M2's fuzz campaigns on one graduated default box with its sampler ready (built once in `setUp`; every
/// run starts from that state): step sizes from below the minimum to far beyond one step's room, and same-block pushes
/// of 1 to 150 ticks before a step (BC-129).
contract BoxSwapModuleFuzzTest is BoxSwapModuleBase {
    IBoxSwapModule.Action internal constant BUY = IBoxSwapModule.Action.BuyBurn;
    IBoxSwapModule.Action internal constant SELL = IBoxSwapModule.Action.SellForFit;

    Box internal box;

    function setUp() public {
        _setUpModuleWorld();
        Box memory b = _graduatedBox(_defaultParams());
        _readyAverage(b);
        _roll(1);
        box = b;
    }

    /// Any budget: a skip with the budget kept (below the minimum, nothing to do), or one bounded step that spends at
    /// most its budget less the tip it reserves, moves the price at most 49 ticks within the band, returns at least
    /// the minimum, pays min(5%, cap) and keeps every ledger equal to the module's claims.
    function testFuzz_BC129_anyStepSizeIsBounded(uint256 qFees, uint256 tFees, bool buy) public {
        Box memory b = box;
        qFees = bound(qFees, 0, 30 ether);
        // T fees up to 100M T (10% of issuance: T dealt to the payer beyond the real supply would let the receiver's
        // BURN_T share burn more than exists).
        tFees = bound(tFees, 0, 100_000_000e18);
        if (qFees != 0) _feedQ(b, qFees);
        if (tFees != 0) _feedT(b, tFees);
        _m(b).sync();
        Before memory x;
        (x.q, x.t,) = _budgets(b);
        uint256 budget = buy ? x.q : x.t;
        x.spend = budget > 0 ? budget - 1 : 0;
        (x.sqrtP, x.tick, x.supply) = (_sqrtP(b), _spotTick(b), b.t.totalSupply());
        Result memory r = _step(b, buy ? BUY : SELL, keeper);
        int24 ref = _ref(b, buy);
        if (r.stop != IBoxSwapModule.Stop.None) {
            _checkSkip(b, buy, x, r, ref);
            return;
        }
        assertGe(
            buy ? x.spend : _tInQ(x.spend, ref), BoxSpecV1.SWAP_STEP_MIN_Q, "a step ran: its budget reached the min"
        );
        uint160 limit = _limit(buy, x.sqrtP, ref);
        if (buy) _checkBuy(b, x, r, ref, limit);
        else _checkSell(b, x, r, ref, limit);
        assertGe(r.amountOut, _minOut(buy, r.amountIn, limit), "at least the minimum at the limit price");
        assertLe(r.tip, 0.0005 ether, "never above FEE_BATCH_TIP_MAX_ETH");
        _assertLedgersAreClaims(b);
    }

    /// S5 review (findings 1 and 2): `BoxSwapBounds.buyInput` and `sellInput`, the input one step can spend before its
    /// limit, are what a real exact-input swap to that limit spends, never more and short of it by at most a few raw
    /// units of rounding, wherever spot stands: moved 0-150 ticks either way from P1 and landed exactly on a tick from
    /// either side (P1 included, where the ask's and the bid's liquidity meet, so a step from there crosses it at once),
    /// then a step of 1-49 ticks either way (the module's point-7 burn reads the sell side, deepen()'s conversion the
    /// buy side).
    function testFuzz_BC129_stepInputIsWhatOneSwapSpendsToItsLimit(int256 offset, int256 via, uint256 ticks, bool buy)
        public
    {
        Box memory b = box;
        BoundsHarness h = new BoundsHarness();
        // forge-lint: disable-next-line(unsafe-typecast)
        int24 target = _spotTick(b) + int24(bound(offset, -150, 150));
        // forge-lint: disable-next-line(unsafe-typecast)
        _moveTo(b, target + int24(bound(via, -60, 60)));
        _moveTo(b, target);
        // forge-lint: disable-next-line(unsafe-typecast)
        int24 d = int24(int256(bound(ticks, 1, 49)));
        uint160 limit = TickMath.getSqrtPriceAtTick(buy ? _spotTick(b) - d : _spotTick(b) + d);
        bytes32 slot = StateLibrary._getPoolStateSlot(b.key.toId());
        Slot0 s0 = Slot0.wrap(pm.extsload(slot));
        (uint24 fee,) = h.fees(s0.lpFee(), s0.protocolFee(), buy);
        uint256 est = h.stepInput(pm, slot, s0, buy, limit, fee);
        uint256 real = _swapTo(b, buy, limit);
        assertEq(_sqrtP(b), limit, "fixture: the swap reached its limit");
        assertLe(est, real, "never more than the swap spends");
        assertLe(real - est, 6, "short of it by rounding only");
    }

    /// Spot moved to exactly `tick`'s √price, by a buy from above or a sell from below.
    function _moveTo(Box memory b, int24 tick) internal {
        uint160 s = TickMath.getSqrtPriceAtTick(tick);
        uint160 cur = _sqrtP(b);
        if (s != cur) _swapTo(b, s < cur, s);
    }

    /// An exact-input swap far larger than the room, stopped by `limit`; returns the input it spent.
    function _swapTo(Box memory b, bool buy, uint160 limit) internal returns (uint256 spent) {
        address mover = makeAddr("s5review.mover");
        BalanceDelta delta;
        if (buy) {
            vm.deal(mover, 100 ether);
            vm.prank(mover);
            delta = swapper.swap{value: 100 ether}(b.key, true, -100 ether, limit);
            return uint256(uint128(-delta.amount0()));
        }
        deal(address(b.t), mover, 200_000_000e18);
        vm.startPrank(mover);
        b.t.approve(address(swapper), type(uint256).max);
        delta = swapper.swap(b.key, false, -200_000_000e18, limit);
        vm.stopPrank();
        return uint256(uint128(-delta.amount1()));
    }

    /// The state before a step.
    struct Before {
        uint256 q;
        uint256 t;
        uint256 spend;
        uint160 sqrtP;
        int24 tick;
        uint256 supply;
    }

    function _checkSkip(Box memory b, bool buy, Before memory x, Result memory r, int24 ref) internal view {
        if (x.spend == 0) {
            assertEq(uint256(r.stop), uint256(IBoxSwapModule.Stop.NothingToDo));
        } else {
            assertEq(uint256(r.stop), uint256(IBoxSwapModule.Stop.BelowStepMin), "the only other skip here");
            assertLt(buy ? x.spend : _tInQ(x.spend, ref), BoxSpecV1.SWAP_STEP_MIN_Q);
        }
        (uint256 q1, uint256 t1,) = _budgets(b);
        assertEq(q1, x.q, "budget kept");
        assertEq(t1, x.t, "budget kept");
        assertEq(_sqrtP(b), x.sqrtP, "no trade");
    }

    function _checkBuy(Box memory b, Before memory x, Result memory r, int24 ref, uint160 limit) internal view {
        uint160 s1 = _sqrtP(b);
        assertLe(r.amountIn + r.tip, x.spend, "spends at most the budget less the kept unit");
        assertLe(r.amountIn, x.spend - _tipOf(x.spend), "the tip reserved first");
        assertGe(s1, limit);
        assertGe(uint256(s1), _impactSqrt(true, x.sqrtP), "at most 49 ticks");
        assertGe(s1, _bandSqrt(true, ref), "never beyond the band");
        assertGe(_spotTick(b), x.tick - IMPACT - 1);
        assertEq(r.tip, _tipOf(r.amountIn));
        (uint256 q2,,) = _budgets(b);
        assertEq(x.q - q2, r.amountIn + r.tip, "the ledger moved by exactly input and tip");
        assertEq(x.supply - b.t.totalSupply(), r.amountOut - 1, "bought T burned, 1 raw unit kept");
        // The caller chooses no size: the step stops at its limit or spends all it may.
        if (s1 != limit) assertEq(r.amountIn, x.spend - _tipOf(x.spend), "a small budget converts whole");
    }

    function _checkSell(Box memory b, Before memory x, Result memory r, int24 ref, uint160 limit) internal view {
        uint160 s1 = _sqrtP(b);
        assertLe(r.amountIn, x.spend);
        assertLe(s1, limit);
        assertLe(uint256(s1), _impactSqrt(false, x.sqrtP), "at most 49 ticks");
        assertLe(s1, _bandSqrt(false, ref), "never beyond the band");
        assertLe(_spotTick(b), x.tick + IMPACT);
        assertEq(r.tip, _tipOf(r.amountOut));
        (, uint256 t2,) = _budgets(b);
        assertEq(x.t - t2, r.amountIn, "the ledger moved by exactly the input");
        if (s1 != limit) assertEq(r.amountIn, x.spend, "a small budget converts whole");
    }

    /// An attacker pushes 1 to 150 ticks the step's way in the step's block, either before the block's sample (the
    /// step's own poke then records the pushed price) or after it (the poke is a no-op). The step's reference is never
    /// beyond the average the wrong way (buys: never below it; sells: never above it), its price never beyond that
    /// reference ∓ 99 ticks, and the attacker's round trip never profits.
    function testFuzz_BC129_aSameBlockPushNeverLoosensTheLimit(uint256 pushTicks, bool buy, bool sampledFirst) public {
        Box memory b = box;
        pushTicks = bound(pushTicks, 1, 150);
        _feedQ(b, 1.5 ether);
        _feedT(b, 3_000_000e18);
        _m(b).sync();
        _roll(1);
        if (sampledFirst) IBoxPriceAverage(b.average).poke();
        Pushed memory x;
        (, x.avg,) = IBoxPriceAverage(b.average).twap();
        x.sampleBefore = IBoxPriceAverage(b.average).latestSampleTick();
        address a = address(uint160(uint256(keccak256("s5m2.fuzz.attacker"))));
        (x.paid, x.got) = _push(b, buy, pushTicks, a);
        x.sqrtP = _sqrtP(b);
        Result memory r = _step(b, buy ? BUY : SELL, keeper);
        _checkPushed(b, buy, sampledFirst, x, r);
        assertLt(_unwind(b, buy, x.got, a), x.paid, "the attacker never profits");
    }

    struct Pushed {
        int24 avg;
        int24 sampleBefore;
        uint256 paid;
        uint256 got;
        uint160 sqrtP;
    }

    function _checkPushed(Box memory b, bool buy, bool sampledFirst, Pushed memory x, Result memory r) internal view {
        int24 ref = _ref(b, buy);
        // The reference: never the wrong side of the average; with the block already sampled, exactly as unpushed.
        if (buy) assertGe(ref, x.avg, "a buy's reference is never below the average");
        else assertLe(ref, x.avg, "a sell's reference is never above the average");
        if (sampledFirst) {
            assertEq(ref, _unpushedRef(buy, x.avg, x.sampleBefore), "sampled first: the push cannot move the reference");
        }
        if (r.stop == IBoxSwapModule.Stop.None) {
            if (buy) assertGe(_sqrtP(b), _bandSqrt(true, ref), "never below reference - 99");
            else assertLe(_sqrtP(b), _bandSqrt(false, ref), "never above reference + 99");
            assertGe(r.amountOut, _minOut(buy, r.amountIn, _limit(buy, x.sqrtP, ref)));
        } else {
            assertEq(uint256(r.stop), uint256(IBoxSwapModule.Stop.AtBand), "pushed past the band: it waits");
        }
    }

    function _unpushedRef(bool buy, int24 avg, int24 sample) internal pure returns (int24) {
        if (buy) return sample > avg ? sample : avg;
        return sample < avg ? sample : avg;
    }
}
