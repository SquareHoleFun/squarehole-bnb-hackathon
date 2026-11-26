// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {SqrtPriceMath} from "v4-core/src/libraries/SqrtPriceMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";
import {IBoxHook} from "../../../src/box/interfaces/IBoxHook.sol";
import {DeepenSkip, DepthKind} from "../../../src/box/interfaces/BoxTypes.sol";
import {ClaimsFunder} from "../../utils/ClaimsFunder.sol";
import {NativeLiquidityHelper} from "../../v2/utils/NativeV4Callers.sol";
import {BoxS45Base} from "./BoxS45Base.sol";
import {EthClaimsMinter, ForeignUnlocker, SettablePriceAverage} from "./BoxS45Mocks.sol";

/// @notice S4: `deepen()` (BC-119 to BC-121, pair and lock of F72 (B), every box's since F77: box 0's included), its
/// sandwich bounds (dynamic-pool-share § 1.4), `collect()` while adds are blocked (BC-122), and the averages it reads
/// (box 0: FIT's executor ring; other boxes: their sampler).
contract BoxHookDepthTest is BoxS45Base {
    using StateLibrary for IPoolManager;

    ClaimsFunder internal funder;
    ForeignUnlocker internal foreign;
    EthClaimsMinter internal minter;
    address internal attacker = makeAddr("s45.attacker");

    struct Add {
        DepthKind kind;
        DeepenSkip skip;
        uint256 q;
        uint256 t;
        uint256 tip;
    }

    /// @dev The hook's depth budget and the receiver's unbooked claims (the next batch), both sides.
    struct Snap {
        uint256 hq;
        uint256 ht;
        uint256 rq;
        uint256 rt;
    }

    function _snap(Box memory b) internal view returns (Snap memory x) {
        (x.hq, x.ht) = b.hook.depthBudget();
        (x.rq, x.rt) = _receiverUnbooked(b);
    }

    function setUp() public {
        _setUpWorld();
        funder = new ClaimsFunder(pm);
        foreign = new ForeignUnlocker(pm);
        minter = new EthClaimsMinter(pm);
    }

    /// @dev Other fees for the next batch (so a collect is valid whatever the trades paid).
    function _otherFees(Box memory b, uint256 amount) internal {
        vm.deal(address(this), address(this).balance + amount);
        minter.mintTo{value: amount}(address(b.receiver));
    }

    // ------------------------------------------------------------------------------------------------------------
    // Fixtures

    function _graduatedBox0() internal returns (Box memory b) {
        Params memory p = _box0Params();
        p.averageKind = 1;
        b = _buildAndLaunch(p);
        _skipWindow(b);
        _closeAndGraduate(b);
    }

    function _graduatedStandard() internal returns (Box memory b) {
        Params memory p = _standardParams(address(0));
        p.averageKind = 1;
        b = _buildAndLaunch(p);
        _skipWindow(b);
        _closeAndGraduate(b);
    }

    function _avg(Box memory b) internal pure returns (SettablePriceAverage) {
        return SettablePriceAverage(b.average);
    }

    /// @dev The average and the latest sample sit at spot (+ offsets).
    function _setAverage(Box memory b, int24 avgOffset, int24 sampleOffset) internal {
        int24 spot = _tick(b);
        _avg(b).set(true, spot + avgOffset, spot + sampleOffset);
    }

    function _fundQ(Box memory b, uint256 amount) internal {
        vm.deal(address(this), address(this).balance + amount);
        b.receiver.fundDepth{value: amount}();
    }

    function _fundT(Box memory b, uint256 amount) internal {
        deal(address(b.t), bob, b.t.balanceOf(bob) + amount);
        funder.deposit(address(b.t), bob, amount, address(b.hook));
    }

    function _deepen(Box memory b) internal returns (Add memory a) {
        (a.kind, a.skip, a.q, a.t, a.tip) = b.hook.deepen(keeper);
    }

    function _toAddable(Box memory b) internal {
        uint256 last = b.hook.lastDeepenBlock();
        uint256 from = (last == 0 ? b.hook.migratedAtBlock() : last) + 300;
        if (block.number < from) _roll(from - block.number);
        _setAverage(b, 0, 0);
    }

    // ------------------------------------------------------------------------------------------------------------
    // BC-119: deepen() adds only when it is safe; otherwise a skip, never a revert, and the budget stays

    function test_BC119_beforeGraduationSkips() public {
        Params memory p = _box0Params();
        p.averageKind = 1;
        Box memory b = _buildAndLaunch(p);
        _fundQ(b, 1 ether);
        Add memory a = _deepen(b);
        assertEq(uint256(a.skip), uint256(DeepenSkip.NotGraduated));
        (uint256 qb, uint256 tb) = b.hook.depthBudget();
        assertEq(qb | tb, 0, "nothing in the hook before graduation");
        (uint256 dq,) = b.receiver.depthHeld();
        assertEq(dq, 1 ether, "the gift waits in the receiver (one hold rule, F77)");
    }

    function test_BC119_cooldown299And300() public {
        Box memory b = _graduatedBox0();
        _fundQ(b, 1 ether);
        _fundT(b, _tForQ(b, 1 ether));
        _setAverage(b, 0, 0);
        assertEq(uint256(_deepen(b).skip), uint256(DeepenSkip.Cooldown), "the first add counts from the migration");
        vm.roll(b.hook.migratedAtBlock() + 299);
        assertEq(uint256(_deepen(b).skip), uint256(DeepenSkip.Cooldown), "299 blocks");
        vm.roll(b.hook.migratedAtBlock() + 300);
        Add memory a = _deepen(b);
        assertEq(uint256(a.skip), uint256(DeepenSkip.None), "300 blocks");
        assertEq(uint256(a.kind), uint256(DepthKind.Pair), "box 0 pairs and locks (F77)");
        assertEq(b.hook.lastDeepenBlock(), block.number);
        assertEq(uint256(_deepen(b).skip), uint256(DeepenSkip.Cooldown), "never two adds in one block");
        vm.roll(block.number + 299);
        _setAverage(b, 0, 0);
        assertEq(uint256(_deepen(b).skip), uint256(DeepenSkip.Cooldown));
        vm.roll(block.number + 1);
        assertEq(uint256(_deepen(b).skip), uint256(DeepenSkip.None));
    }

    function test_BC119_averageNotReadyOrFailing() public {
        Box memory b = _graduatedBox0();
        _fundQ(b, 1 ether);
        _fundT(b, _tForQ(b, 1 ether));
        (uint256 q0, uint256 t0) = b.hook.depthBudget();
        _toAddable(b);
        _avg(b).set(false, _tick(b), _tick(b));
        assertEq(uint256(_deepen(b).skip), uint256(DeepenSkip.AverageNotReady), "no full window");
        _setAverage(b, 0, 0);
        _avg(b).setRevert(true);
        assertEq(uint256(_deepen(b).skip), uint256(DeepenSkip.AverageNotReady), "a failing source reads as not ready");
        (uint256 qb, uint256 tb) = b.hook.depthBudget();
        assertEq(qb, q0, "the budget stays");
        assertEq(tb, t0);
    }

    function test_BC119_caughtUpAndDeviation_99And100() public {
        Box memory b = _graduatedBox0();
        _fundQ(b, 1 ether);
        _fundT(b, _tForQ(b, 1 ether));
        _toAddable(b);
        _setAverage(b, 0, 100);
        assertEq(uint256(_deepen(b).skip), uint256(DeepenSkip.AverageNotCaughtUp), "sample 100 ticks off");
        _setAverage(b, 0, -100);
        assertEq(uint256(_deepen(b).skip), uint256(DeepenSkip.AverageNotCaughtUp));
        _setAverage(b, 100, 0);
        assertEq(uint256(_deepen(b).skip), uint256(DeepenSkip.Deviation), "spot 100 ticks from the average");
        _setAverage(b, -100, 0);
        assertEq(uint256(_deepen(b).skip), uint256(DeepenSkip.Deviation));
        _setAverage(b, -99, 99);
        assertEq(uint256(_deepen(b).skip), uint256(DeepenSkip.None), "99 ticks both ways");
    }

    function test_BC119_budgetBelowMinAdd() public {
        Box memory b = _graduatedBox0();
        uint256 minAdd = b.hook.minAdd();
        assertEq(minAdd, 21_034_900_425_000_000, "0.5% of box 0's raise");
        (uint256 already,) = b.hook.depthBudget(); // the settlement's 2/15 of the curve's fees (F77)
        _fundT(b, _tForQ(b, 1 ether));
        _fundQ(b, minAdd - 1 - already);
        _toAddable(b);
        assertEq(uint256(_deepen(b).skip), uint256(DeepenSkip.BudgetBelowMin));
        _fundQ(b, 1);
        assertEq(uint256(_deepen(b).skip), uint256(DeepenSkip.None), "exactly MIN_ADD adds");
    }

    function test_BC119_fromAForeignUnlockReverts() public {
        Box memory b = _graduatedBox0();
        _fundQ(b, 1 ether);
        _fundT(b, _tForQ(b, 1 ether));
        _toAddable(b);
        vm.expectRevert(IBoxHook.ForeignUnlock.selector);
        foreign.callInside(address(b.hook), abi.encodeCall(IBoxHook.deepen, (keeper)));
        // The receiver's collect reaches harvest(), which refuses a foreign unlock too.
        vm.expectRevert(IBoxHook.ForeignUnlock.selector);
        foreign.callInside(address(b.receiver), abi.encodeWithSignature("collect(address)", keeper));
        // The add itself runs only in the hook's own unlock callback.
        vm.prank(address(pm));
        vm.expectRevert();
        b.hook.unlockCallback(abi.encode(uint8(4), bytes("")));
    }

    // ------------------------------------------------------------------------------------------------------------
    // BC-120: the pair: size, place, permanence (every box; box 0 since F77)

    function test_BC120_pairPlaceSizeAndPermanence_atGraduationPrice() public {
        _pairCase(_graduatedBox0());
    }

    function test_BC120_pairPlaceSizeAndPermanence_at100x() public {
        Box memory b = _graduatedBox0();
        // 100x the graduation price: T 100 times dearer, the tick ~46,052 lower (buys move it down).
        _buy(b, alice, 60 ether, TickMath.getSqrtPriceAtTick(b.curve.tickLower - 46_052));
        _pairCase(b);
    }

    function test_BC120_pairPlaceSizeAndPermanence_standard() public {
        Box memory b = _graduatedStandard();
        _buy(b, alice, 3 ether, 0);
        _pairCase(b);
    }

    /// Each add = min(Q budget less the tip, 10% of the core's Q within 953 ticks of t_ref, the pair included) with
    /// matching T at spot; one full-range position at salt 3 owned by the hook; no position at salt 2 ever exists; its
    /// liquidity never decreases; nobody can remove, move or re-centre it.
    function _pairCase(Box memory b) internal {
        _fundQ(b, 50 ether);
        _fundT(b, _tForQ(b, 50 ether));
        _toAddable(b);
        int24 spot = _tick(b);
        uint256 cap = _coreQNearPrice(b, spot) / 10;
        (uint256 qb0, uint256 tb0) = b.hook.depthBudget();
        uint256 tip0 = keeper.balance;
        vm.recordLogs();
        Add memory a = _deepen(b);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(uint256(a.skip), uint256(DeepenSkip.None));
        assertEq(uint256(a.kind), uint256(DepthKind.Pair));
        assertLe(a.q, cap, "at most 10% of the core's Q within 953 ticks of t_ref");
        assertGe(a.q, cap * 9999 / 10_000, "the cap binds (budget far above one add)");
        assertApproxEqRel(a.t, _tForQ(b, a.q), 1e15, "matching T at the price");
        assertEq(a.tip, a.q * 500 / 10_000 < 0.0005 ether ? a.q * 500 / 10_000 : 0.0005 ether, "tip");
        assertEq(keeper.balance - tip0, a.tip, "tip paid in Q");
        (uint256 qb1, uint256 tb1) = b.hook.depthBudget();
        assertEq(qb0 - qb1, a.q + a.tip, "exactly the principal and the tip left the Q budget");
        assertEq(tb0 - tb1, a.t, "exactly the principal left the T budget");
        uint128 l = b.hook.pairedLiquidity();
        assertGt(l, 0);
        assertEq(l, _positionL(b, BoxSpecV1.MIN_USABLE_TICK, BoxSpecV1.MAX_USABLE_TICK, 3), "full range, salt 3");
        // The add touched only the full-range position at salt 3 (salt 2, the removed rungs', never exists).
        uint256 adds;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(pm) || logs[i].topics[0] != IPoolManager.ModifyLiquidity.selector) continue;
            if (address(uint160(uint256(logs[i].topics[2]))) != address(b.hook)) continue;
            (int24 lo, int24 hi, int256 delta, bytes32 salt) = abi.decode(logs[i].data, (int24, int24, int256, bytes32));
            assertEq(salt, bytes32(uint256(3)), "salt 3 only");
            assertEq(lo, BoxSpecV1.MIN_USABLE_TICK);
            assertEq(hi, BoxSpecV1.MAX_USABLE_TICK);
            assertGe(delta, 0, "never a removal");
            if (delta > 0) ++adds;
        }
        assertEq(adds, 1, "one add");
        // No one, us included, can remove, move or re-centre it.
        NativeLiquidityHelper lp = new NativeLiquidityHelper(pm);
        vm.expectRevert(
            _wrapped(
                address(b.hook),
                IHooks.beforeRemoveLiquidity.selector,
                abi.encodeWithSelector(IBoxHook.LiquidityLocked.selector)
            )
        );
        lp.modify(b.key, BoxSpecV1.MIN_USABLE_TICK, BoxSpecV1.MAX_USABLE_TICK, -1);
        (uint256 t,) = _buy(b, alice, 1 ether, 0);
        _sell(b, alice, t);
        b.receiver.collect(keeper);
        assertGe(b.hook.pairedLiquidity(), l, "the pair's liquidity never decreases");
    }

    // ------------------------------------------------------------------------------------------------------------
    // BC-121: an add into the pair with fees spends exactly the principal (box 0 since F77)

    function test_BC121_addIntoThePairWithFeesSpendsOnlyPrincipal() public {
        Box memory b = _graduatedBox0();
        _mergeCase(b);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Pair and lock (F72 (B)): other boxes' 2/15 on both sides, paired at the current price, the unmatched side waits

    /// The T side is the smaller (worth less than the Q the cap allows): all of it pairs, the Q left waits. The
    /// price is first raised (T dearer) so the core holds more Q near it and the 10% cap exceeds MIN_ADD.
    function test_pairAndLock_sizedByTheSmallerSide_TShort() public {
        Box memory b = _graduatedStandard();
        _buy(b, alice, 3 ether, 0);
        int24 spot = _tick(b);
        uint256 cap = _coreQNearPrice(b, spot) / 10;
        uint256 minAdd = b.hook.minAdd();
        assertGt(cap, minAdd * 12 / 10, "fixture: the cap exceeds MIN_ADD here");
        _fundQ(b, 5 ether);
        _fundT(b, _tForQ(b, (minAdd + cap) / 2));
        _toAddable(b);
        (uint256 q0, uint256 t0) = b.hook.depthBudget();
        Add memory a = _deepen(b);
        assertEq(uint256(a.kind), uint256(DepthKind.Pair));
        assertApproxEqRel(a.t, t0, 1e12, "the T side binds: all of it");
        assertLe(a.q, cap, "within the cap");
        assertApproxEqRel(a.q, (minAdd + cap) / 2, 1e15, "matching Q at the price");
        (uint256 q1, uint256 t1) = b.hook.depthBudget();
        assertEq(q0 - q1, a.q + a.tip);
        assertEq(t0 - t1, a.t);
        assertGt(q1, 4 ether, "the unmatched Q waits");
        assertEq(b.hook.pairedLiquidity(), _positionL(b, BoxSpecV1.MIN_USABLE_TICK, BoxSpecV1.MAX_USABLE_TICK, 3));
    }

    /// The Q side is the smaller (here: the 10% cap, at the graduation price below MIN_ADD as it scales with R too):
    /// that much Q pairs with the T it matches, the T left waits.
    function test_pairAndLock_sizedByTheSmallerSide_QShort() public {
        Box memory b = _graduatedStandard();
        _fundQ(b, 1 ether);
        _fundT(b, _tForQ(b, 5 ether));
        _toAddable(b);
        uint256 cap = _coreQNearPrice(b, _tick(b)) / 10;
        (uint256 q0, uint256 t0) = b.hook.depthBudget();
        Add memory a = _deepen(b);
        assertEq(uint256(a.kind), uint256(DepthKind.Pair));
        assertLe(a.q, cap);
        assertApproxEqRel(a.q, cap, 1e12, "the Q side binds");
        assertApproxEqRel(a.t, _tForQ(b, a.q), 1e15, "matching T at the price");
        (uint256 q1, uint256 t1) = b.hook.depthBudget();
        assertEq(q0 - q1, a.q + a.tip);
        assertEq(t0 - t1, a.t);
        assertGt(t1, t0 * 9 / 10, "the unmatched T waits");
    }

    function test_pairAndLock_qSideBelowMinSkipsTSideBelowMinConverts() public {
        _eitherSideBelowMin(true);
        _eitherSideBelowMin(false);
    }

    function _eitherSideBelowMin(bool box0) internal {
        Box memory b = box0 ? _graduatedBox0() : _graduatedStandard();
        _fundQ(b, 1 ether);
        (, uint256 tAlready) = b.hook.depthBudget();
        assertEq(tAlready, 0, "no sells, no T fees");
        _fundT(b, _tForQ(b, b.hook.minAdd()) * 99 / 100);
        _toAddable(b);
        // S5.M5 (F76; box 0 too since F77): a T side worth less than MIN_ADD no longer waits. The call buys T within
        // the swap bounds (BC-137); here that brings the T side to MIN_ADD, so the pair follows in the same unlock.
        Add memory a = _deepen(b);
        assertEq(uint256(a.skip), uint256(DeepenSkip.None), "T side worth less than MIN_ADD: a conversion");
        assertEq(uint256(a.kind), uint256(DepthKind.Pair), "which reaches MIN_ADD and pairs");
        Box memory c = box0 ? _graduatedBox0() : _graduatedStandard();
        (uint256 already,) = c.hook.depthBudget(); // the graduation batch's 2/15 is there already
        _fundQ(c, c.hook.minAdd() - 1 - already);
        _fundT(c, _tForQ(c, 1 ether));
        _toAddable(c);
        assertEq(uint256(_deepen(c).skip), uint256(DeepenSkip.BudgetBelowMin), "Q side below MIN_ADD");
    }

    function test_pairAndLock_mergeSpendsOnlyPrincipal() public {
        _mergeCase(_graduatedStandard());
    }

    /// Before adding into the pair it pokes it and mints its fees to the receiver as ordinary fees (split 10/3/2, or
    /// box 0's 11/2/2 with P capped), so the add spends exactly the principal on both sides.
    function _mergeCase(Box memory b) internal {
        _fundQ(b, 2 ether);
        _fundT(b, _tForQ(b, 2 ether));
        _toAddable(b);
        _deepen(b);
        uint128 l0 = b.hook.pairedLiquidity();
        (uint256 t,) = _buy(b, alice, 1 ether, 0);
        _sell(b, alice, t);
        _toAddable(b);
        (uint256 fq, uint256 ft) = _uncollected(b, BoxSpecV1.MIN_USABLE_TICK, BoxSpecV1.MAX_USABLE_TICK);
        assertGt(fq + ft, 0);
        Snap memory before = _snap(b);
        Add memory a = _deepen(b);
        Snap memory afterAdd = _snap(b);
        assertEq(afterAdd.rq - before.rq, fq, "the pair's fees to the receiver first");
        assertEq(afterAdd.rt - before.rt, ft);
        assertEq(before.hq - afterAdd.hq, a.q + a.tip);
        assertEq(before.ht - afterAdd.ht, a.t);
        assertGt(b.hook.pairedLiquidity(), l0, "never decreases");
    }

    // ------------------------------------------------------------------------------------------------------------
    // Sandwich bounds (dynamic-pool-share § 1.4): a same-block push within the 99-tick guard loses the attacker money

    function testFuzz_sandwich_pairAndLockLosesForTheAttacker(uint256 kSeed, bool up, bool box0) public {
        Box memory b = box0 ? _graduatedBox0() : _graduatedStandard();
        _fundQ(b, 3 ether);
        _fundT(b, _tForQ(b, 3 ether));
        _toAddable(b);
        int24 fair = _tick(b);
        // From 2 ticks: right after graduation the price sits exactly at P1 with the tick one below it.
        int24 k = int24(int256(bound(kSeed, 2, 98)));
        _avg(b).set(true, fair, fair); // the hour's average and the latest sample do not move in the push's block
        deal(address(b.t), attacker, 1e27);
        vm.deal(attacker, 2000 ether);
        Snap memory start = Snap(attacker.balance, b.t.balanceOf(attacker), 0, 0);
        if (up) _sellToTick(b, attacker, fair + k);
        else _buyToTick(b, attacker, fair - k);
        Add memory a = _deepen(b);
        assertEq(uint256(a.skip), uint256(DeepenSkip.None), "the guard admits a push under 99 ticks");
        if (up) _buyToTick(b, attacker, fair);
        else _sellToTick(b, attacker, fair);
        // Value the T leg at the fair price: the attacker's net in Q.
        int256 net = (int256(attacker.balance) - int256(start.hq))
            + _qValue(b, int256(b.t.balanceOf(attacker)) - int256(start.ht));
        emit log_named_int("attacker net (wei)", net);
        assertLt(net, 0, "the attacker loses: 1% each way exceeds the add's mispricing");
    }

    /// The attacker's best case over push sizes 2 to 98 ticks, both ways, on a standard box and on box 0 (logged for
    /// the evidence; each must lose).
    function test_sandwich_pairAndLockSweep() public {
        for (uint256 kind; kind < 2; ++kind) {
            int256 best = type(int256).min;
            int256 bestK;
            for (int24 k = 2; k <= 98; k += 12) {
                for (uint256 dir; dir < 2; ++dir) {
                    uint256 snap = vm.snapshotState();
                    int256 net = _sandwichNet(k, dir == 0, kind == 0);
                    assertLt(net, 0, "every push loses");
                    if (net > best) (best, bestK) = (net, dir == 0 ? int256(k) : -int256(k));
                    vm.revertToState(snap);
                }
            }
            string memory label = kind == 0 ? "box 0" : "standard";
            emit log_named_int(string.concat("S45W|", label, "|best attacker net over pushes (wei)"), best);
            emit log_named_int(string.concat("S45W|", label, "|at push (ticks, + = sell first)"), bestK);
        }
    }

    /// Box 0 with its real average, FIT's executor ring (one sample per block, the push's own block recorded by
    /// `deepen()`'s poke): every same-block push of 2 to 98 ticks, both ways, loses the attacker money (F77: only
    /// rungs were tested on box 0 before).
    function test_sandwich_box0PairAndLockWithTheExecutorRing() public {
        Box memory b = _buildAndLaunch(_box0Params());
        _skipWindow(b);
        _closeAndGraduate(b);
        _fundQ(b, 3 ether);
        _fundT(b, _tForQ(b, 3 ether));
        for (uint256 i; i < 600; ++i) {
            _roll(1);
            b.hook.priceAverage().poke();
        }
        int24 fair = _tick(b);
        int256 best = type(int256).min;
        for (int24 k = 2; k <= 98; k += 12) {
            for (uint256 dir; dir < 2; ++dir) {
                uint256 snap = vm.snapshotState();
                _roll(1); // a new block: the ring has no sample yet, so deepen()'s poke records the pushed tick
                deal(address(b.t), attacker, 1e27);
                vm.deal(attacker, 2000 ether);
                Snap memory start = Snap(attacker.balance, b.t.balanceOf(attacker), 0, 0);
                if (dir == 0) _sellToTick(b, attacker, fair + k);
                else _buyToTick(b, attacker, fair - k);
                Add memory a = _deepen(b);
                assertEq(uint256(a.skip), uint256(DeepenSkip.None), "the ring admits a push under 99 ticks");
                assertEq(uint256(a.kind), uint256(DepthKind.Pair));
                if (dir == 0) _buyToTick(b, attacker, fair);
                else _sellToTick(b, attacker, fair);
                int256 net = (int256(attacker.balance) - int256(start.hq))
                    + _qValue(b, int256(b.t.balanceOf(attacker)) - int256(start.ht));
                assertLt(net, 0, "every push loses");
                if (net > best) best = net;
                vm.revertToState(snap);
            }
        }
        emit log_named_int("S45W|box 0 (executor ring)|best attacker net over pushes (wei)", best);
    }

    function _sandwichNet(int24 k, bool up, bool box0) internal returns (int256 net) {
        Box memory b = box0 ? _graduatedBox0() : _graduatedStandard();
        _fundQ(b, 3 ether);
        _fundT(b, _tForQ(b, 3 ether));
        _toAddable(b);
        int24 fair = _tick(b);
        _avg(b).set(true, fair, fair);
        deal(address(b.t), attacker, 1e27);
        vm.deal(attacker, 2000 ether);
        Snap memory start = Snap(attacker.balance, b.t.balanceOf(attacker), 0, 0);
        if (up) _sellToTick(b, attacker, fair + k);
        else _buyToTick(b, attacker, fair - k);
        _deepen(b);
        if (up) _buyToTick(b, attacker, fair);
        else _sellToTick(b, attacker, fair);
        net = (int256(attacker.balance) - int256(start.hq))
            + _qValue(b, int256(b.t.balanceOf(attacker)) - int256(start.ht));
    }

    // ------------------------------------------------------------------------------------------------------------
    // BC-122: collect() works while adds are blocked and takes the core's and the pair's fees in the same batch

    function test_BC122_collectWhileAddsBlocked() public {
        Box memory b = _graduatedBox0();
        _fundQ(b, 10 ether);
        _fundT(b, _tForQ(b, 10 ether));
        _toAddable(b);
        assertEq(uint256(_deepen(b).kind), uint256(DepthKind.Pair), "fixture: box 0 has a pair");
        _avg(b).set(false, 0, 0);
        _buy(b, alice, 1 ether, 0);
        assertEq(uint256(_deepen(b).skip), uint256(DeepenSkip.Cooldown));
        b.receiver.collect(keeper);
        _roll(300);
        _buy(b, alice, 1 ether, 0);
        assertEq(uint256(_deepen(b).skip), uint256(DeepenSkip.AverageNotReady));
        b.receiver.collect(keeper);
        _buy(b, alice, 1 ether, 0);
        _setAverage(b, 150, 0);
        assertEq(uint256(_deepen(b).skip), uint256(DeepenSkip.Deviation));
        b.receiver.collect(keeper);
    }

    /// One collect() pokes at most four positions (ask, bid, sentinel and the pair; no rungs, no harvest step) and
    /// takes the pair's fees in its batch, so none are left uncollected.
    function test_BC122_collectTakesTheCoresAndThePairsFeesInOneBatch() public {
        Box memory b = _graduatedBox0();
        _fundQ(b, 10 ether);
        _fundT(b, _tForQ(b, 10 ether));
        _toAddable(b);
        _deepen(b);
        assertGt(b.hook.pairedLiquidity(), 0, "fixture: a pair");
        (uint256 t,) = _buy(b, alice, 2 ether, 0);
        _sell(b, alice, t);
        (uint256 fq, uint256 ft) = _uncollected(b, BoxSpecV1.MIN_USABLE_TICK, BoxSpecV1.MAX_USABLE_TICK);
        assertGt(fq + ft, 0, "the pair earned fees");
        vm.recordLogs();
        b.receiver.collect(keeper);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 pokes;
        bool pairPoked;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(pm) || logs[i].topics[0] != IPoolManager.ModifyLiquidity.selector) continue;
            if (address(uint160(uint256(logs[i].topics[2]))) != address(b.hook)) continue;
            (,, int256 delta, bytes32 salt) = abi.decode(logs[i].data, (int24, int24, int256, bytes32));
            assertEq(delta, 0, "only pokes");
            ++pokes;
            if (salt == bytes32(uint256(3))) pairPoked = true;
        }
        assertLe(pokes, 4, "at most four positions");
        assertTrue(pairPoked, "the pair is poked in the batch");
        (fq, ft) = _uncollected(b, BoxSpecV1.MIN_USABLE_TICK, BoxSpecV1.MAX_USABLE_TICK);
        assertEq(fq | ft, 0, "no pair fee left behind");
    }

    // ------------------------------------------------------------------------------------------------------------
    // The real averages: box 0 reads FIT's executor ring, other boxes their sampler

    function test_average_box0ExecutorRingCatchesUpThenAdds() public {
        Box memory b = _buildAndLaunch(_box0Params());
        _skipWindow(b);
        _closeAndGraduate(b);
        _fundQ(b, 1 ether);
        _fundT(b, _tForQ(b, 1 ether));
        _roll(300);
        Add memory a = _deepen(b);
        assertEq(uint256(a.skip), uint256(DeepenSkip.AverageNotCaughtUp), "the ring starts at the seed tick 204,060");
        // One sample per timestamp, at most 100 ticks each: about 269 samples from P0 to P1, then an hour.
        for (uint256 i; i < 600; ++i) {
            _roll(1);
            IBoxHook(address(b.hook)).priceAverage().poke();
        }
        a = _deepen(b);
        assertEq(uint256(a.skip), uint256(DeepenSkip.None), "caught up and ready");
        assertEq(uint256(a.kind), uint256(DepthKind.Pair), "box 0 pairs on its executor ring's average");
    }

    function test_average_standardSamplerSeedsAtP1() public {
        Box memory b = _buildAndLaunch(_standardParams(address(0)));
        _skipWindow(b);
        _fundQ(b, 1 ether);
        _fundT(b, _tForQ(b, 1 ether));
        b.hook.priceAverage().poke();
        (bool ready,,) = b.hook.priceAverage().twap();
        assertFalse(ready, "nothing before graduation");
        _closeAndGraduate(b);
        b.hook.priceAverage().poke();
        assertEq(b.hook.priceAverage().latestSampleTick(), b.curve.tickLower, "seeded at P1");
        for (uint256 i; i < 320; ++i) {
            _roll(1);
            b.hook.priceAverage().poke();
        }
        Add memory a = _deepen(b);
        assertEq(uint256(a.skip), uint256(DeepenSkip.None));
        assertEq(uint256(a.kind), uint256(DepthKind.Pair));
    }

    // ------------------------------------------------------------------------------------------------------------
    // Helpers

    function _absDiff(int24 x, int24 y) internal pure returns (uint256) {
        return x > y ? uint256(int256(x - y)) : uint256(int256(y - x));
    }

    function _positionL(Box memory b, int24 lo, int24 hi, uint256 salt) internal view returns (uint128 l) {
        (l,,) = pm.getPositionInfo(b.key.toId(), address(b.hook), lo, hi, bytes32(salt));
    }

    /// @dev The Q the L7 positions' and the pair's liquidity spans over [tRef, tRef + 953] (the hook's cap base).
    function _coreQNearPrice(Box memory b, int24 tRef) internal view returns (uint256 q) {
        uint160 sLo = TickMath.getSqrtPriceAtTick(tRef);
        uint160 sHi = TickMath.getSqrtPriceAtTick(tRef + 953);
        q += _in(b, BoxSpecV1.MIN_USABLE_TICK, b.curve.tickLower, 1, sLo, sHi);
        q += _in(b, b.curve.tickLower, BoxSpecV1.MAX_USABLE_TICK, 1, sLo, sHi);
        q += _in(b, b.curve.tickUpper, BoxSpecV1.MAX_USABLE_TICK, 1, sLo, sHi);
        q += _in(b, BoxSpecV1.MIN_USABLE_TICK, BoxSpecV1.MAX_USABLE_TICK, 3, sLo, sHi);
    }

    function _in(Box memory b, int24 lower, int24 upper, uint256 salt, uint160 sLo, uint160 sHi)
        internal
        view
        returns (uint256)
    {
        uint128 l = _positionL(b, lower, upper, salt);
        if (l == 0) return 0;
        uint160 a = TickMath.getSqrtPriceAtTick(lower);
        uint160 c = TickMath.getSqrtPriceAtTick(upper);
        if (a < sLo) a = sLo;
        if (c > sHi) c = sHi;
        if (a >= c) return 0;
        return SqrtPriceMath.getAmount0Delta(a, c, l, false);
    }

    /// @dev T worth `qAmount` at the current price (T per Q = (√P / 2^96)^2).
    function _tForQ(Box memory b, uint256 qAmount) internal view returns (uint256) {
        uint256 s = _sqrtP(b);
        return qAmount * s / (1 << 96) * s / (1 << 96);
    }

    function _qValue(Box memory b, int256 tAmount) internal view returns (int256) {
        uint256 s = _sqrtP(b);
        uint256 abs = tAmount < 0 ? uint256(-tAmount) : uint256(tAmount);
        uint256 v = abs * (1 << 96) / s * (1 << 96) / s;
        return tAmount < 0 ? -int256(v) : int256(v);
    }

    function _sellToTick(Box memory b, address who, int24 tick) internal {
        vm.startPrank(who);
        b.t.approve(address(swapper), type(uint256).max);
        swapper.swap(b.key, false, -int256(b.t.balanceOf(who)), TickMath.getSqrtPriceAtTick(tick));
        vm.stopPrank();
    }

    /// @dev Buys until the tick reaches `tick` (the caller holds the ETH; the swapper refunds the rest).
    function _buyToTick(Box memory b, address who, int24 tick) internal {
        uint256 v = who.balance;
        vm.prank(who);
        // forge-lint: disable-next-line(unsafe-typecast)
        swapper.swap{value: v}(b.key, true, -int256(v), TickMath.getSqrtPriceAtTick(tick));
    }

    /// @dev The fees the hook's pair position (salt 3) has accrued and not yet collected (read from fee growth).
    function _uncollected(Box memory b, int24 lo, int24 hi) internal view returns (uint256 q, uint256 t) {
        (uint128 l, uint256 f0, uint256 f1) =
            pm.getPositionInfo(b.key.toId(), address(b.hook), lo, hi, bytes32(uint256(3)));
        (uint256 g0, uint256 g1) = pm.getFeeGrowthInside(b.key.toId(), lo, hi);
        unchecked {
            q = (g0 - f0) * l / (1 << 128);
            t = (g1 - f1) * l / (1 << 128);
        }
    }

    function _receiverUnbooked(Box memory b) internal view returns (uint256 q, uint256 t) {
        (uint256 qb, uint256 tb) = b.receiver.booked();
        q = _claims(address(b.receiver), address(0)) - qb;
        t = _claims(address(b.receiver), address(b.t)) - tb;
    }
}
