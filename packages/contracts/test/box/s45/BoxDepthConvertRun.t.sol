// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {BoxKind, DeepenSkip, DepthKind} from "../../../src/box/interfaces/BoxTypes.sol";
import {IBoxPriceAverage} from "../../../src/box/interfaces/IBoxHook.sol";
import {BoxDepthConvertBase} from "./BoxDepthConvertBase.sol";
import {OpenTime} from "../utils/OpenTime.sol";

/// @notice S5.M5 over time (BC-137's graduation-depth case; box0-like-others.md § 5.3's speed and § 9's "Q-only
/// backlog" risk): Q-only depth placed by one `deepen()` every 300 blocks, nobody else trading, on each box's real
/// price average (box 0: FIT's executor ring; a Standard box: its sampler), every call checked against the bounds and
/// the rule "no add below MIN_ADD". Logged for the evidence (S5M5R|...).
contract BoxDepthConvertRunTest is BoxDepthConvertBase {
    using StateLibrary for IPoolManager;

    /// One run's counts.
    struct Run {
        uint256 calls;
        uint256 alone;
        uint256 withPair;
        uint256 pairOnly;
        uint256 qSpent;
        DeepenSkip end;
    }

    function setUp() public {
        _setUpConvertWorld();
    }

    // ============================================================================================================
    // BC-137's graduation-depth case: BC-110's tax, no T, at P1

    function test_BC137_graduationDepthRun_standard() public {
        _graduationDepthRun(false);
    }

    function test_BC137_graduationDepthRun_box0() public {
        _graduationDepthRun(true);
    }

    /// BC-110's 0.1737624 ETH of launch tax (window buys of 0.1 ETH at the open and 1 ETH at its last block) and no T,
    /// at P1, one deepen() an hour: conversions alone until the T side reaches MIN_ADD, then about every second call
    /// pairs, every add with both sides at MIN_ADD, until less than one more step's minimum is left.
    function _graduationDepthRun(bool box0) internal {
        Box memory b = _buildAndLaunch(box0 ? _box0Params() : _standardParams(address(0)));
        uint256 tax = _windowTax(b);
        assertEq(tax, 0.1737624 ether, "BC-110's tax");
        _skipWindow(b);
        _closeAndGraduate(b);
        _readyRealAverage(b);
        b.router.sweep();
        Budget memory start = _budget(b);
        assertEq(start.t, 0, "no T: the curve saw buys only");
        assertGe(start.q, tax, "the tax and the settlement's 2/15 of the curve's fees");
        string memory label = box0 ? "box 0" : "standard";
        Run memory r = _place(b, 60, label);
        Budget memory end = _budget(b);
        uint256 minAdd = b.hook.minAdd();
        assertTrue(
            r.end == DeepenSkip.BudgetBelowMin || r.end == DeepenSkip.ConvertBelowMin, "it ends for want of budget"
        );
        assertLt(end.q, minAdd + 2 * MIN_Q, "placed in full but for less than one more step's minimum");
        assertGt(b.hook.pairedLiquidity(), 0, "the tax is in the pair");
        assertGt(r.withPair, 0, "conversions paired in their own unlock");
        emit log_named_uint(string.concat("S5M5R|", label, "|graduation depth: calls (one an hour)"), r.calls);
        emit log_named_uint(string.concat("S5M5R|", label, "|conversions alone"), r.alone);
        emit log_named_uint(string.concat("S5M5R|", label, "|conversions with a pair"), r.withPair);
        emit log_named_uint(string.concat("S5M5R|", label, "|pairs without a conversion"), r.pairOnly);
        emit log_named_uint(string.concat("S5M5R|", label, "|Q budget at the start (wei)"), start.q);
        emit log_named_uint(string.concat("S5M5R|", label, "|Q spent: converted and paired (wei)"), r.qSpent);
        emit log_named_uint(string.concat("S5M5R|", label, "|Q left (wei)"), end.q);
        emit log_named_uint(string.concat("S5M5R|", label, "|T left (wei)"), end.t);
        emit log_named_uint(string.concat("S5M5R|", label, "|ended with skip"), uint256(r.end));
    }

    // ============================================================================================================
    // A large Q-only backlog on box 0: 10 ETH of launch tax, placed over time; collect() and graduate() never wait

    /// box0-like-others § 5.3 and § 9: a Misfits launch tax of tens of ETH could take weeks to months to place. Here
    /// 10 ETH (BC-110's window buys, the rest forced ETH, which `sweep()` places alike) waits in the router through
    /// `graduate()` (which never calls it, BC-098), then becomes the hook's Q claims. One deepen() an hour, a fee batch
    /// collected every six hours (each succeeds, and returns the conversions' notes to the depth budget), nobody else
    /// trading, on FIT's executor ring. The Q placed per day is logged for the evidence.
    function test_BC137_box0TenEthBacklogPlacedOverTimeNeverBlocksCollectOrGraduate() public {
        Box memory b = _buildAndLaunch(_box0Params());
        uint256 tax = _windowTax(b);
        vm.deal(address(b.router), 10 ether);
        assertGt(tax, 0);
        _skipWindow(b);
        _close(b, carol);
        b.coord.graduate();
        assertTrue(b.coord.graduated(), "graduate() never waits for the tax");
        assertEq(address(b.router).balance, 10 ether, "and never touched it");
        _readyRealAverage(b);
        b.router.sweep();
        Budget memory start = _budget(b);
        assertGe(start.q, 10 ether);
        uint256 minAdd = b.hook.minAdd();
        int24 tick0 = _tick(b);
        vm.pauseGasMetering();
        uint256 day;
        uint256 spent;
        uint256 collects;
        bool done;
        for (day = 1; day <= 120 && !done; ++day) {
            uint256 daySpent;
            for (uint256 h; h < 24; ++h) {
                if (h % 6 == 5) {
                    _mintQ(b, 0.01 ether);
                    b.receiver.collect(keeper); // never blocked by the backlog or the conversions
                    ++collects;
                }
                _toNextDeepen(b);
                (Deep memory d,, bool stop) = _checkedDeepen(b, minAdd);
                daySpent += d.q;
                if (stop) {
                    done = true;
                    break;
                }
            }
            spent += daySpent;
            emit log_named_uint(string.concat("S5M5B|day ", vm.toString(day), "|Q placed that day (wei)"), daySpent);
            emit log_named_uint(string.concat("S5M5B|day ", vm.toString(day), "|Q budget left (wei)"), _budget(b).q);
            emit log_named_int(string.concat("S5M5B|day ", vm.toString(day), "|ticks moved"), int256(tick0 - _tick(b)));
        }
        vm.resumeGasMetering();
        --day;
        emit log_named_uint("S5M5B|days run", day);
        emit log_named_uint("S5M5B|Q placed in total (wei)", spent);
        emit log_named_uint("S5M5B|average Q placed per day (wei)", spent / day);
        emit log_named_uint("S5M5B|collects, all succeeded", collects);
        emit log_named_uint("S5M5B|Q budget left (wei)", _budget(b).q);
        assertTrue(done, "10 ETH placed within 120 days");
        assertLt(_budget(b).q, minAdd + 2 * MIN_Q, "placed in full but for less than one more step's minimum");
        assertGt(spent, 9 ether, "about all of it placed");
        _assertClaimsAreTheBudget(b);
    }

    // ============================================================================================================
    // Helpers

    /// BC-110's window buys: 0.1 ETH at the open, 1 ETH in the window's last block. Returns the tax the router holds.
    function _windowTax(Box memory b) internal returns (uint256) {
        OpenTime.toStep(b.hook.openAt(), 0);
        vm.deal(alice, 2 ether);
        vm.prank(alice);
        b.router.buy{value: 0.1 ether}(0.1 ether, 0, alice, block.timestamp);
        OpenTime.toStep(b.hook.openAt(), 31);
        vm.prank(alice);
        b.router.buy{value: 1 ether}(1 ether, 0, alice, block.timestamp);
        return address(b.router).balance;
    }

    /// The real average made ready as our keeper would: a Standard box's sampler poked at graduation (its window
    /// starts at P1); box 0's executor ring poked until it has walked from its seed to P1 and held an hour.
    function _readyRealAverage(Box memory b) internal {
        IBoxPriceAverage avg = IBoxPriceAverage(b.average);
        if (b.kind == BoxKind.Standard) {
            avg.poke();
            return;
        }
        for (uint256 i; i < 600; ++i) {
            _roll(1);
            avg.poke();
        }
    }

    function _toNextDeepen(Box memory b) internal {
        uint256 last = b.hook.lastDeepenBlock();
        uint256 from = (last == 0 ? b.hook.migratedAtBlock() : last) + 300;
        if (block.number < from) _roll(from - block.number);
    }

    function _place(Box memory b, uint256 maxCalls, string memory label) internal returns (Run memory r) {
        uint256 minAdd = b.hook.minAdd();
        for (uint256 i; i < maxCalls; ++i) {
            _toNextDeepen(b);
            (Deep memory d, Conv memory c, bool stop) = _checkedDeepen(b, minAdd);
            if (stop) {
                r.end = d.skip;
                break;
            }
            ++r.calls;
            r.qSpent += d.q;
            if (d.kind == DepthKind.Convert) ++r.alone;
            else if (c.seen) ++r.withPair;
            else ++r.pairOnly;
            _logCall(label, i + 1, d, _budget(b).q);
        }
    }

    function _logCall(string memory label, uint256 n, Deep memory d, uint256 qLeft) internal {
        string memory head = string.concat("S5M5R|", label, "|call ", vm.toString(n), "|kind ", vm.toString(uint256(d.kind)));
        emit log_string(string.concat(
                head, "|Q spent ", vm.toString(d.q), "|T paired ", vm.toString(d.t), "|Q left ", vm.toString(qLeft)
            ));
    }

    /// One deepen(), every bound checked: a conversion within its limit (t_ref read back in the same block) and above
    /// its minimum output; a conversion alone with a ceiling of at least 0.005 ETH; every add with both sides at
    /// MIN_ADD (the T side at the re-read price after a conversion); the hook's claims its budget. `stop`: a skip other
    /// than the cooldown or the average.
    function _checkedDeepen(Box memory b, uint256 minAdd) internal returns (Deep memory d, Conv memory c, bool stop) {
        Budget memory before = _budget(b);
        uint160 s0 = _sqrtP(b);
        (d, c) = _deepen(b);
        if (d.skip != DeepenSkip.None) {
            assertTrue(
                d.skip == DeepenSkip.BudgetBelowMin || d.skip == DeepenSkip.ConvertBelowMin,
                "the run only waits for budget (cooldown and average are kept)"
            );
            return (d, c, true);
        }
        if (c.seen) {
            assertEq(c.ref, _ref(b), "t_ref as the average reads in this block");
            assertEq(c.limit, _limitOf(s0, c.ref), "the nearer of 49 ticks and t_ref - 99");
            assertGe(c.sqrtAfter, c.limit, "never past the limit");
            assertGe(c.tOut, _minOut(c.qIn, c.limit), "the minimum output");
            assertLe(c.qIn, _ceiling(before.q, _tValue(before.t, s0)), "at most half the unpaired Q");
        }
        if (d.kind == DepthKind.Convert) {
            assertGe(_ceiling(before.q, _tValue(before.t, s0)), MIN_Q, "a conversion alone needs 0.005 ETH");
        } else {
            assertEq(uint256(d.kind), uint256(DepthKind.Pair));
            assertGe(before.q - c.qIn, minAdd, "no add below MIN_ADD: the Q side");
            assertGe(_tValue(before.t + c.tOut, c.seen ? c.sqrtAfter : s0), minAdd, "no add below MIN_ADD: the T side");
        }
        _assertClaimsAreTheBudget(b);
    }
}
