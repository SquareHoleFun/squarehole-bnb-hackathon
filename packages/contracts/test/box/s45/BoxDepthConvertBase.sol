// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {SqrtPriceMath} from "v4-core/src/libraries/SqrtPriceMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";
import {IBoxHook, IBoxPriceAverage} from "../../../src/box/interfaces/IBoxHook.sol";
import {DeepenSkip, DepthKind} from "../../../src/box/interfaces/BoxTypes.sol";
import {ClaimsFunder} from "../../utils/ClaimsFunder.sol";
import {BoxS45Base} from "./BoxS45Base.sol";
import {EthClaimsMinter, SettablePriceAverage} from "./BoxS45Mocks.sol";

/// @notice TEST ONLY: the fixtures of S5.M5's depth conversions inside `deepen()` (docs/design/swap-module-v1.md § 8,
/// as revised in § 15 finding 2; box0-like-others.md § 5.3): graduated boxes (box 0 and a Standard box) with Q-only
/// or mostly-Q depth, the price average at spot or offset, every `deepen()` recorded with its `DepthConverted` event,
/// and independent re-computations of the conversion's bounds from TickMath (the hook is not checked against its own
/// library).
abstract contract BoxDepthConvertBase is BoxS45Base {
    using StateLibrary for IPoolManager;

    uint256 internal constant Q96 = 1 << 96;
    int24 internal constant IMPACT = 49;
    int24 internal constant BAND = 99;
    /// The minimum-output and fee-note slack: ⌊49 / 60⌋ + 4 swap steps (FitBuybackExecutor `_maxSwapSteps`).
    uint256 internal constant SLACK = 4;
    uint256 internal constant MIN_Q = 0.005 ether;
    uint256 internal constant TIP_CAP = 0.0005 ether;

    ClaimsFunder internal funder;
    EthClaimsMinter internal minter;

    /// What one `deepen()` returned.
    struct Deep {
        DepthKind kind;
        DeepenSkip skip;
        uint256 q;
        uint256 t;
        uint256 tip;
    }

    /// Its `DepthConverted` event, if any.
    struct Conv {
        bool seen;
        uint256 qIn;
        uint256 tOut;
        int24 ref;
        uint160 sqrtBefore;
        uint160 sqrtAfter;
        uint160 limit;
    }

    /// The hook's budget around a call.
    struct Budget {
        uint256 q;
        uint256 t;
    }

    function _setUpConvertWorld() internal {
        _setUpWorld();
        funder = new ClaimsFunder(pm);
        minter = new EthClaimsMinter(pm);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Boxes

    /// A graduated box 0 or Standard box; `settable`: SettablePriceAverage instead of its real average.
    function _graduated(bool box0, bool settable) internal returns (Box memory b) {
        Params memory p = box0 ? _box0Params() : _standardParams(address(0));
        if (settable) p.averageKind = 1;
        b = _buildAndLaunch(p);
        _skipWindow(b);
        _closeAndGraduate(b);
    }

    function _isSettable(Box memory b) internal view returns (bool) {
        return b.average.code.length != 45 + 60 && b.average != b.executor;
    }

    // ------------------------------------------------------------------------------------------------------------
    // Budgets

    function _budget(Box memory b) internal view returns (Budget memory x) {
        (x.q, x.t) = b.hook.depthBudget();
    }

    /// Q into the depth budget by `fundDepth()` (after graduation: at once into the hook's claims).
    function _fundQ(Box memory b, uint256 amount) internal {
        if (amount == 0) return;
        vm.deal(address(this), address(this).balance + amount);
        b.receiver.fundDepth{value: amount}();
    }

    /// The hook's Q budget brought to exactly `target` (it only grows: the target must be at least the current one).
    function _setQ(Box memory b, uint256 target) internal {
        (uint256 q,) = b.hook.depthBudget();
        require(target >= q, "fixture: Q target below the budget");
        _fundQ(b, target - q);
    }

    /// T claims straight into the hook (sellers' 2/15 over time, topped up here).
    function _fundT(Box memory b, uint256 amount) internal {
        if (amount == 0) return;
        deal(address(b.t), bob, b.t.balanceOf(bob) + amount);
        funder.deposit(address(b.t), bob, amount, address(b.hook));
    }

    /// Other fees for the next batch (so a collect is valid whatever the trades paid).
    function _mintQ(Box memory b, uint256 amount) internal {
        vm.deal(address(this), address(this).balance + amount);
        minter.mintTo{value: amount}(address(b.receiver));
    }

    // ------------------------------------------------------------------------------------------------------------
    // Prices

    /// The tick of the pool's √price (Slot0's tick reads one lower when a downward swap ended exactly on a tick, as
    /// `migrate`'s walk to P1 does).
    function _spotTick(Box memory b) internal view returns (int24) {
        return TickMath.getTickAtSqrtPrice(_sqrtP(b));
    }

    /// A settable average and its latest sample at Slot0's tick (+ offsets), ready.
    function _setAverage(Box memory b, int24 avgOffset, int24 sampleOffset) internal {
        int24 spot = _tick(b);
        SettablePriceAverage(b.average).set(true, spot + avgOffset, spot + sampleOffset);
    }

    /// Past the cooldown, and a settable average set to spot.
    function _toAddable(Box memory b) internal {
        uint256 last = b.hook.lastDeepenBlock();
        uint256 from = (last == 0 ? b.hook.migratedAtBlock() : last) + 300;
        if (block.number < from) _roll(from - block.number);
        if (_isSettable(b)) _setAverage(b, 0, 0);
    }

    /// The buy's reference as deepen() reads it: the higher tick (cheaper T) of the average and the latest sample.
    function _ref(Box memory b) internal view returns (int24) {
        (, int24 avg,) = IBoxPriceAverage(b.average).twap();
        int24 sample = IBoxPriceAverage(b.average).latestSampleTick();
        return sample > avg ? sample : avg;
    }

    /// § 4.4's buy limit from TickMath alone: the nearer to spot of 49 ticks of impact and t_ref − 99 (0: no room).
    function _limitOf(uint160 sqrtSpot, int24 refTick) internal pure returns (uint160) {
        uint256 impact = FullMath.mulDivRoundingUp(sqrtSpot, TickMath.getSqrtPriceAtTick(-IMPACT), Q96);
        uint256 band = TickMath.getSqrtPriceAtTick(refTick - BAND);
        uint256 l = impact > band ? impact : band;
        // forge-lint: disable-next-line(unsafe-typecast)
        return l >= sqrtSpot ? 0 : uint160(l);
    }

    /// (in − 1% − 2 slack) at the limit price, less the slack.
    function _minOut(uint256 amountIn, uint160 limit) internal pure returns (uint256) {
        uint256 net = amountIn * 99 / 100;
        if (net <= 2 * SLACK) return 0;
        uint256 out = FullMath.mulDiv(FullMath.mulDiv(net - 2 * SLACK, limit, Q96), limit, Q96);
        return out > SLACK ? out - SLACK : 0;
    }

    /// T valued in Q at a √price, rounded down (as the hook values its T side).
    function _tValue(uint256 t, uint160 sqrtP) internal pure returns (uint256) {
        return FullMath.mulDiv(FullMath.mulDiv(t, Q96, sqrtP), Q96, sqrtP);
    }

    /// The T worth `q` at a √price.
    function _tFor(uint256 q, uint160 sqrtP) internal pure returns (uint256) {
        return FullMath.mulDiv(FullMath.mulDiv(q, sqrtP, Q96), sqrtP, Q96);
    }

    function _tipOf(uint256 q) internal pure returns (uint256 t) {
        t = q * 500 / 10_000;
        if (t > TIP_CAP) t = TIP_CAP;
    }

    /// The conversion's ceiling: half the unpaired Q, at most the Q budget less the tip.
    function _ceiling(uint256 q, uint256 tValue) internal pure returns (uint256 x) {
        x = (q - tValue) * 5000 / 10_000;
        if (x > q - _tipOf(q)) x = q - _tipOf(q);
    }

    /// REV-16's note of one conversion: its LP fee (1%, no protocol fee here) less two slack units per swap step.
    function _note(uint256 qIn) internal pure returns (uint256) {
        uint256 fee = qIn * 10_000 / 1_000_000;
        return fee > 2 * SLACK ? fee - 2 * SLACK : 0;
    }

    // ------------------------------------------------------------------------------------------------------------
    // Calls

    function _deepen(Box memory b) internal returns (Deep memory d, Conv memory c) {
        vm.recordLogs();
        (d.kind, d.skip, d.q, d.t, d.tip) = b.hook.deepen(keeper);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        c = _conversionOf(b, logs);
        _assertTheHookNeverSells(b, logs);
    }

    function _conversionOf(Box memory b, Vm.Log[] memory logs) internal pure returns (Conv memory c) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(b.hook) || logs[i].topics[0] != IBoxHook.DepthConverted.selector) continue;
            require(!c.seen, "one conversion per call");
            c.seen = true;
            (c.qIn, c.tOut, c.ref, c.sqrtBefore, c.sqrtAfter, c.limit) =
                abi.decode(logs[i].data, (uint256, uint256, int24, uint160, uint160, uint160));
        }
    }

    /// F72 (B): T is never sold. Every swap the hook makes in its pool pays Q and receives T (the caller's delta, which
    /// v4 emits: negative = paid).
    function _assertTheHookNeverSells(Box memory b, Vm.Log[] memory logs) internal pure {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics.length < 3 || logs[i].topics[0] != IPoolManager.Swap.selector) continue;
            if (address(uint160(uint256(logs[i].topics[2]))) != address(b.hook)) continue;
            (int128 a0, int128 a1) = abi.decode(logs[i].data, (int128, int128));
            assertLe(a0, 0, "the hook pays Q");
            assertGe(a1, 0, "the hook never pays T (F72 (B))");
        }
    }

    /// The hook's claims are its depth budget; it holds no ETH and no T.
    function _assertClaimsAreTheBudget(Box memory b) internal view {
        (uint256 q, uint256 t) = b.hook.depthBudget();
        assertEq(q, _claims(address(b.hook), address(0)), "Q claims == Q budget");
        assertEq(t, _claims(address(b.hook), address(b.t)), "T claims == T budget");
        assertEq(address(b.hook).balance, 0, "no ETH in the hook");
        assertEq(b.t.balanceOf(address(b.hook)), 0, "no T in the hook");
    }

    function _positionL(Box memory b, int24 lo, int24 hi, uint256 salt) internal view returns (uint128 l) {
        (l,,) = pm.getPositionInfo(b.key.toId(), address(b.hook), lo, hi, bytes32(salt));
    }

    /// Q a full-range position of liquidity `l` holds at √price `s` (for the pair's ratio).
    function _fullRangeQ(uint128 l, uint160 s) internal pure returns (uint256) {
        return SqrtPriceMath.getAmount0Delta(s, TickMath.getSqrtPriceAtTick(BoxSpecV1.MAX_USABLE_TICK), l, true);
    }
}
