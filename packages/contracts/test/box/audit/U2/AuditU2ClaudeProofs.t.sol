// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IBoxLaunchRouter} from "../../../../src/box/interfaces/IBoxLaunchRouter.sol";
import {AuditU2ClaudeBase, AuditU2ClaudeBuy, AuditU2ClaudeForcing} from "./AuditU2ClaudeBase.sol";

/// @notice U2's proof tests (plan § 1.1): each passes while the defect exists and asserts the observed behaviour.
/// forge-config: default.evm_version = "osaka"
contract AuditU2ClaudeProofsTest is AuditU2ClaudeBase {
    /// @notice AUDIT-U2-02's gift: the least raw T that leaves no bid sentinel (measured in the test), rounded up to the
    /// whole T: 6,306,641 T.
    uint256 internal constant GIFT_02 = 6_306_641 ether;

    // W2-U2-1, accepted as built (FQ-18, F147): quote() answers the clock's step only; its NatSpec now says so.
    /// @notice AUDIT-U2-01 (low): the launch router's `quote(qIn)` keeps answering a taxed buy once the curve is closed.
    /// - **Property and source.** `IBoxLaunchRouter.sol:92`: `quote` is "What a buy of qIn would pay now: the tax kept
    ///   and the Q swapped. Reverts outside the window." `IBoxLaunchRouter.sol:79` and `BoxLaunchRouter.sol:167`: a
    ///   buy is possible only "in the window while the curve is open" (`CurveIsClosed` otherwise). BC-096: "the
    ///   router-only buy gate ends at the close; after graduate() the Universal Router and the V4Quoter buy at the 1%
    ///   fee alone".
    /// - **Expected.** Once the curve is closed no taxed buy exists: `quote` refuses as `buy` does (`CurveIsClosed`),
    ///   or at least answers no tax.
    /// - **Observed.** `quote` reads only the clock (`BoxLaunchRouter.sol:250-253`: `taxFor(qIn, _windowStep(...))`),
    ///   so from the close until openAt + 384 s it answers the step's full tax and swap input, before and after
    ///   graduation, while `buy` reverts `CurveIsClosed` and every other route buys untaxed.
    /// - **Steps.** The world's window (step 4); a launch-router buy of 300 ETH closes the curve with a partial fill; in
    ///   the same block `quote(1 ether)`; `graduate()`; `quote(1 ether)` again; `buy` and an untaxed buy through the
    ///   Universal Router stand-in.
    /// - **Amounts.** Step 4 (904,810 pips): `quote(1 ether)` answers tax 0.90481 ETH and swap input 0.09519 ETH, the
    ///   same before and after graduation; the router's buy of 1 ETH reverts `CurveIsClosed`; the stand-in buys with
    ///   0.01 ETH and the router's balance does not move.
    function testAccepted_AUDIT_U2_01_quoteAnswersATaxedBuyAfterTheClose() public {
        _toWindow();
        uint256 step = (vm.getBlockTimestamp() - hook.openAt()) / 12;
        uint256 pips = launchRouter.taxPips(step);
        AuditU2ClaudeBuy memory closing = _measuredBuy(eoa[5], 300 ether, eoa[5]);
        assertTrue(closing.ok && closing.refund > 0 && hook.closed(), "a partial fill closed the curve");

        assertEq(step, 4);
        assertEq(pips, 904_810);
        (uint256 tax, uint256 swapIn) = launchRouter.quote(1 ether);
        assertEq(tax, 0.90481 ether, "observed: quote answers the step's full tax");
        assertEq(swapIn, 1 ether - tax, "and a swap input");
        assertGt(tax, 0.8 ether, "a tax above 80%");
        AuditU2ClaudeBuy memory refused = _measuredBuy(eoa[4], 1 ether, eoa[4]);
        assertEq(bytes4(refused.err), IBoxLaunchRouter.CurveIsClosed.selector, "while the buy it quotes reverts");

        _graduate(keeper);
        (uint256 taxAfter, uint256 swapInAfter) = launchRouter.quote(1 ether);
        assertEq(taxAfter, tax, "observed: the same taxed answer after graduation");
        assertEq(swapInAfter, swapIn);
        refused = _measuredBuy(eoa[4], 1 ether, eoa[4]);
        assertEq(bytes4(refused.err), IBoxLaunchRouter.CurveIsClosed.selector, "the router still refuses");
        uint256 routerBefore = a.launchRouter.balance;
        assertGt(_buy(eoa[4], 0.01 ether), 0, "every other route buys at the pool fee alone");
        assertEq(a.launchRouter.balance, routerBefore, "no tax kept on it");
        assertLt(vm.getBlockTimestamp(), hook.windowEndsAt(), "all of it inside openAt + 384 s");
        _assertGhostLedger();
    }

    // W2-U2-2, accepted as built (FQ-17, R66-GIFT, F147): gifted T joins the ask; BC-027/029/067 now say so.
    /// @notice AUDIT-U2-02 (low): T sent to the coordinator before `graduate()` removes the graduated layout's bid
    /// sentinel and makes forcing graduation cheaper than BC-029 states.
    /// - **Property and source.** BC-029 (docs/design/launch-pipeline/conformance-cases.json; launch-pipeline-v1.md
    ///   § 3.4:233-237): a forcer that buys to P1, calls `graduate()` and sells everything back "costs at least 0.670,
    ///   0.121 and 0.0019 ETH at 20.7%, 70.1% and 98.1% fill by ETH" "with the full-range bid and the bid sentinel".
    ///   BC-067: "The graduated positions are exactly three: the ask (the pool share from P1 to the maximum price at
    ///   L_ask), the full-range bid (L_ask ...) and the bid sentinel (the rest of the curve's Q from P0 ...)"; § 3.4
    ///   puts 0.1275 ETH in the sentinel. BC-043 allows a gift to the coordinator to "join the ask or be burned at
    ///   graduation, never breaking it"; the U2 brief's P2.4 expects it burned and the budget handed to `migrate`
    ///   unchanged.
    /// - **Expected.** Whatever T reaches the coordinator, box 0 graduates into the three positions with the sentinel
    ///   holding the rest of R, and the BC-029 round trip at 20.7% costs at least 0.670 ETH.
    /// - **Observed.** `graduate()` hands the coordinator's whole T balance to `migrate` (`BoxCoordinator.sol:253-256`;
    ///   BC-043 and `IBoxCoordinator.sol:14`: "T sent here joins it"); the layout sizes the bid at the ask's liquidity
    ///   from that T (`BoxHookExtension.sol:208-210`, `BoxLayoutV1.sol:161-166`), so a gift of 6,306,641 T (3.12% of the
    ///   pool share, 0.1275 ETH at P1) lets the bid take all of R: no sentinel position is created (two positions), and
    ///   a forcer that makes this gift out of its own buy sells back into the deeper bid and pays about 0.040 ETH (6%)
    ///   less than BC-029's 0.670 ETH at 20.7% fill (up to 7%, 0.069 ETH, on an empty curve; no saving from about 45%
    ///   fill on). The pool still keeps more than the curve held (BC-029's second clause holds).
    /// - **Steps.** After the window, one buy fills the curve to 20.7% of R (BC-029's fill); in a snapshot the forcer
    ///   (eoa[5]) buys to P1, calls `graduate()`, sells all its T (the control); in the same state the forcer buys to
    ///   P1, transfers 6,306,641 T to the coordinator, calls `graduate()`, sells the rest.
    /// - **Amounts.** The control: paid 3.369833542833333334 ETH, received 2.699610612085362310, cost 0.670222930747971024
    ///   (BC-029: 0.670), three positions, 0.127453916467356637 ETH in the sentinel. With the gift: paid the same,
    ///   received 2.739649117114085129, cost 0.630184425719248205 ETH (0.040038505028722819 less, 5.97%), no sentinel,
    ///   bid liquidity 29,593,267,062,925,791,907,988 instead of 28,696,714,735,121,197,504,483; the pool still keeps
    ///   0.596486090290914869 ETH more than the curve held (0.636524595319637687 without the gift). The least gift:
    ///   6,306,640.853187956289397397 T (31,242 ppm of the pool share, 0.1275 ETH at P1), measured at the end.
    ///   Asserted: the control at least 0.670 ETH with three positions; the gifted round trip below 0.670 ETH by more
    ///   than 0.03 ETH with no sentinel; the least gift between GIFT_02 - 1 T and GIFT_02.
    function testAccepted_AUDIT_U2_02_tGiftToTheCoordinatorDropsTheSentinelAndCheapensForcing() public {
        _warpTo(hook.windowEndsAt());
        _fillTo(207_000);
        uint256 snap = vm.snapshotState();
        AuditU2ClaudeForcing memory plain = _force(eoa[5], 0);
        uint256 plainShare = curve.poolShare;
        vm.revertToState(snap);
        snap = vm.snapshotState();
        AuditU2ClaudeForcing memory gifted = _force(eoa[5], GIFT_02);

        // The control: BC-029 and BC-067 hold without the gift.
        assertGe(plain.cost + 1e12, 0.67 ether, "control: BC-029's 0.670 ETH at 20.7% fill");
        assertGt(plain.sentinel, 0, "control: three positions");
        assertApproxEqAbs(_sentinelQ(plain.sentinel), 0.1275 ether, 0.0001 ether, "control: 0.1275 ETH in the sentinel");
        // Observed with the gift.
        assertEq(gifted.sentinel, 0, "observed: no sentinel position, two positions instead of BC-067's three");
        assertGt(gifted.bid, plain.bid, "observed: the bid took the sentinel's Q");
        assertGt(gifted.ask, plain.ask, "the ask holds the pool share and the gift");
        assertLt(gifted.cost, 0.67 ether, "observed: the round trip costs less than BC-029's 0.670 ETH");
        assertGt(plain.cost, gifted.cost + 0.03 ether, "by more than 0.03 ETH");
        assertGe(gifted.poolQAfter, gifted.qBefore, "the pool still keeps what the curve held");
        assertEq(gifted.reward, plain.reward, "the same reward");
        assertEq(token.balanceOf(eoa[5]), 0, "the forcer holds no T at the end of either round trip");

        emit log_named_decimal_uint("U2C|AUDIT-U2-02|fill, share of R", gifted.qBefore * 1e18 / raise, 18);
        emit log_named_decimal_uint("U2C|AUDIT-U2-02|control cost, ETH", plain.cost, 18);
        emit log_named_decimal_uint("U2C|AUDIT-U2-02|gifted cost, ETH", gifted.cost, 18);
        emit log_named_decimal_uint("U2C|AUDIT-U2-02|saving, ETH", plain.cost - gifted.cost, 18);
        emit log_named_decimal_uint("U2C|AUDIT-U2-02|gift, T", gifted.gift, 18);
        emit log_named_uint("U2C|AUDIT-U2-02|gift, ppm of the pool share", gifted.gift * 1e6 / plainShare);
        emit log_named_decimal_uint("U2C|AUDIT-U2-02|control: paid, ETH", plain.paid, 18);
        emit log_named_decimal_uint("U2C|AUDIT-U2-02|control: received, ETH", plain.received, 18);
        emit log_named_decimal_uint("U2C|AUDIT-U2-02|gifted: paid, ETH", gifted.paid, 18);
        emit log_named_decimal_uint("U2C|AUDIT-U2-02|gifted: received, ETH", gifted.received, 18);
        emit log_named_decimal_uint("U2C|AUDIT-U2-02|control: sentinel Q, ETH", _sentinelQ(plain.sentinel), 18);
        emit log_named_uint("U2C|AUDIT-U2-02|control: ask = bid liquidity", plain.bid);
        emit log_named_uint("U2C|AUDIT-U2-02|control: sentinel liquidity", plain.sentinel);
        emit log_named_uint("U2C|AUDIT-U2-02|gifted: ask liquidity", gifted.ask);
        emit log_named_uint("U2C|AUDIT-U2-02|gifted: bid liquidity", gifted.bid);
        emit log_named_decimal_uint(
            "U2C|AUDIT-U2-02|control: pool Q after - curve Q before, ETH", plain.poolQAfter - plain.qBefore, 18
        );
        emit log_named_decimal_uint(
            "U2C|AUDIT-U2-02|gifted: pool Q after - curve Q before, ETH", gifted.poolQAfter - gifted.qBefore, 18
        );
        _assertGhostLedger();

        // The amount: the least raw T whose gift leaves no sentinel, from the state right after the forcer's buy to P1
        // (binary search, each probe a graduation in a rolled-back snapshot); GIFT_02 is it rounded up to the whole T.
        vm.revertToState(snap);
        _buyTo(eoa[5], 3 * raise, _p1());
        uint256 lo = GIFT_02 - 1 ether;
        uint256 hi = GIFT_02;
        assertGt(_sentinelAfterGift(eoa[5], lo), 0, "one T less than GIFT_02 leaves a sentinel");
        assertEq(_sentinelAfterGift(eoa[5], hi), 0, "GIFT_02 leaves none");
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (_sentinelAfterGift(eoa[5], mid) == 0) hi = mid;
            else lo = mid + 1;
        }
        emit log_named_uint("U2C|AUDIT-U2-02|least gift that leaves no sentinel, raw T", lo);
        emit log_named_uint("U2C|AUDIT-U2-02|its ppm of the pool share", lo * 1e6 / plainShare);
        uint256 p1 = _p1();
        emit log_named_decimal_uint(
            "U2C|AUDIT-U2-02|its worth at P1, ETH", lo * (uint256(1) << 96) / p1 * (uint256(1) << 96) / p1, 18
        );
        _assertGhostLedger();
    }

    /// @dev The sentinel's liquidity after `from` sends `gift` T to the coordinator and graduates (rolled back).
    function _sentinelAfterGift(address from, uint256 gift) internal returns (uint128 sentinel) {
        uint256 snap = vm.snapshotState();
        _transferT(from, a.coordinator, gift);
        _graduate(from);
        (,, sentinel) = hook.graduatedLayout();
        vm.revertToState(snap);
    }
}
