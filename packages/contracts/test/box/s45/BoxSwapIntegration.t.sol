// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";
import {IBoxHook} from "../../../src/box/interfaces/IBoxHook.sol";
import {IBoxSwapModule} from "../../../src/box/interfaces/IBoxSwapModule.sol";
import {DeepenSkip, DepthKind, FeeBatch} from "../../../src/box/interfaces/BoxTypes.sol";
import {BoxSwapModuleBase} from "./BoxSwapModuleBase.sol";

/// @notice The S5 integration on `sh-s5-swap` (S5.M2's module, S5.M3's creator conversions and add-on 5's cap, S5.M5's
/// depth conversions, merged): a Standard box as it ships, a real `BoxSwapModule` clone, the box's sampler and a hook
/// that converts. Each slice tested its half with a stand-in for the other: S5.M5 ran Standard boxes with M1's mock
/// module, S5.M2 and S5.M3 ran the module beside a hook that could not convert. These checks run both on one box.
/// - Two bounded T buyers in one pool (swap-module § 4.5, "two swappers in one block"; § 4.5 called it I): the
///   module's BuyBurn and the hook's conversion, in one block, in either order, after a push, never take the price past
///   the shared t_ref − 99 of the one sampler (BC-137, the Standard twin of box 0's two FIT buyers).
/// - REV-16 with both noters of a Standard box (§ 4.2): the module's note back to `moduleBackQ`, the hook's to its
///   claims, neither split nor crossed (BC-133).
/// - Add-on 5's POOL_DEPTH excess (M3) is depth money like any other (M5): a BuyForCreator step and the conversion of
///   the cap's excess in one block, the creator's T, room and ledgers untouched by the hook, the creator-first
///   attribution intact (BC-136).
contract BoxSwapIntegrationTest is BoxSwapModuleBase {
    IBoxSwapModule.Action internal constant BUY = IBoxSwapModule.Action.BuyBurn;
    IBoxSwapModule.Action internal constant BUY_C = IBoxSwapModule.Action.BuyForCreator;

    address internal attacker = makeAddr("s5int.attacker");

    /// What one `deepen()` returned, and its `DepthConverted` event.
    struct Deep {
        DepthKind kind;
        DeepenSkip skip;
        uint256 qUsed;
        uint256 tip;
        bool converted;
        uint256 qIn;
        uint256 tOut;
    }

    /// The receiver's ledgers a batch can move.
    struct Books {
        uint256 qBurn;
        uint256 qCreator;
        uint256 qBack;
        uint256 fit;
        uint256 hookQ;
        uint256 carry;
        uint256 kept;
    }

    function setUp() public {
        _setUpModuleWorld();
    }

    // ============================================================================================================
    // BC-137: the module's buy-back and the hook's conversion, two bounded T buyers in one pool

    /// One block, either order, after a same-block push of 0-60 ticks the buyers' way: the price never passes the
    /// shared t_ref − 99 (the sampler records one sample a timestamp, so both read the same reference).
    function testFuzz_BC137_aStandardBoxsModuleAndConversionInOneBlockShareOneBand(uint256 kSeed, bool moduleFirst)
        public
    {
        Box memory b = _twoBuyerBox(_defaultParams());
        _roll(1);
        int24 fair = _tick(b);
        // forge-lint: disable-next-line(unsafe-typecast)
        int24 k = int24(int256(bound(kSeed, 0, 60)));
        if (k > 0) {
            vm.deal(attacker, 2000 ether);
            _buyToTick(b, attacker, fair - k);
        }
        _bothBuyers(b, BUY, moduleFirst);
        assertGe(_sqrtP(b), TickMath.getSqrtPriceAtTick(_ref(b, true) - BAND), "never past the shared band");
        _assertHookClaimsAreItsBudget(b);
        _assertLedgersAreClaims(b);
    }

    /// With no push both run in full in either order: the first moves at most 49 ticks, the second stops at the
    /// nearer of its own 49 ticks and the shared band, so together they move at most 99 ticks from the reference.
    function test_BC137_aStandardBoxsModuleAndConversionBothRunWithinOneBand() public {
        for (uint256 i; i < 2; ++i) {
            Box memory b = _twoBuyerBox(_defaultParams());
            _roll(1);
            int24 ref0 = _spotTick(b);
            (Result memory r, Deep memory d) = _bothBuyers(b, BUY, i == 0);
            assertEq(uint256(r.stop), uint256(IBoxSwapModule.Stop.None), "the module stepped");
            assertEq(uint256(d.kind), uint256(DepthKind.Convert), "the hook converted in the same block");
            assertTrue(d.converted, "its DepthConverted event");
            int24 ref = _ref(b, true);
            assertEq(ref, ref0, "one reference for both: the sampler's P1 sample and its average");
            assertGe(_sqrtP(b), TickMath.getSqrtPriceAtTick(ref - BAND), "never past the shared band");
            assertLe(_spotTick(b), ref - 2 * IMPACT + 1, "both moved: about 2 x 49 ticks");
            _assertHookClaimsAreItsBudget(b);
            _assertLedgersAreClaims(b);
        }
    }

    // ============================================================================================================
    // BC-133: a Standard box's two noters in one batch

    /// The module's BuyBurn and the hook's conversion in one block: the next collect returns the module's note whole
    /// to `moduleBackQ` and the hook's whole to its claims, before the tip and the split; the batch's rest splits
    /// 10/15, 3/15, 2/15 as usual; the next pull hands the module's back to its burn-buy ledger.
    function test_BC133_aStandardBoxsModuleAndHookNotesFromOneBlockReturnApart() public {
        for (uint256 i; i < 2; ++i) {
            Box memory b = _twoBuyerBox(_defaultParams());
            // Clear the fees waiting from the setup, so the next batch holds only the two swaps' fees and 0.3 ETH.
            _mintQ(b, 0.01 ether);
            b.receiver.collect(keeper);
            _roll(1);
            (Result memory r, Deep memory d) = _bothBuyers(b, BUY, i == 0);
            assertEq(uint256(r.stop), uint256(IBoxSwapModule.Stop.None), "fixture: the module stepped");
            assertEq(uint256(d.kind), uint256(DepthKind.Convert), "fixture: the hook converted");
            (uint256 e, uint256 eT) = b.receiver.moduleFeesPending();
            uint256 h = b.receiver.hookFeesPending();
            assertEq(e, r.amountIn / 100 - 2 * SLACK, "the module's note: its own swap's fee");
            assertEq(eT, 0, "a buy notes no T");
            assertEq(h, d.qIn / 100 - 2 * SLACK, "the hook's note: its own conversion's fee");
            _mintQ(b, 0.3 ether);
            Books memory x0 = _books(b);
            FeeBatch memory fb = b.receiver.collect(keeper);
            Books memory x1 = _books(b);
            uint256 earned = fb.q - fb.qToReserve - 0.3 ether;
            assertLe(e + h, earned, "never more than the box's positions earned from the two swaps");
            assertLe(earned - e - h, 2 * (2 * SLACK + 8), "within the slack of both fees");
            uint256 unit = (fb.q - fb.qToReserve - e - h - fb.tip + x0.carry) / 15;
            assertEq(x1.qBack - x0.qBack, e, "the module's fee back to moduleBackQ, whole");
            assertEq(x1.hookQ - x0.hookQ, h + unit * 2, "the hook's fee back to its claims, whole, then the 2/15");
            assertEq(x1.qBurn - x0.qBurn, unit * 10, "the buy-back's 10/15 of the rest only");
            assertEq(x1.fit - x0.fit, unit * 3, "FIT's 3/15 of the rest only");
            assertEq(b.receiver.hookFeesPending(), 0, "the hook's note returned");
            (e, eT) = b.receiver.moduleFeesPending();
            assertEq(e + eT, 0, "the module's note returned");
            // The next pull hands the module's fee back into its burn-buy ledger (each receiver ledger keeps 1).
            (uint256 q0,,) = _budgets(b);
            _m(b).sync();
            (uint256 q1,,) = _budgets(b);
            assertEq(q1 - q0, (x1.qBurn - 1) + (x1.qBack - 1), "handed back beside the batch's 10/15");
            _assertHookClaimsAreItsBudget(b);
            _assertLedgersAreClaims(b);
        }
    }

    // ============================================================================================================
    // BC-136 with BC-137: add-on 5's POOL_DEPTH excess is depth money, converted like any other

    /// A CREATOR_IN_T box with add-on 5 (0.5 ETH an epoch, POOL_DEPTH): the buyers' 10/15 beyond the room goes into
    /// the hook's claims; in one block a BuyForCreator step buys the creator's T and `deepen()` converts the excess;
    /// the creator's T, room and ledgers are untouched by the hook; at the next collect the module's note returns to
    /// `moduleBackQ` and the hook's to its claims, the batch's 10/15 (the room spent) goes to depth too; the next pull
    /// gives the creator-buy ledger its own fee first.
    function test_BC136_aCapExcessIntoDepthIsConvertedBesideACreatorStep() public {
        Box memory b = _capExcessBox();
        (uint256 e, uint256 h) = _creatorBuyAndConversion(b);
        _notesApartThenTheCreatorsFeeFirst(b, e, h);
    }

    /// A CREATOR_IN_T box with add-on 5 (0.5 ETH an epoch, POOL_DEPTH), graduated; 3 ETH of fees: the buyers' 10/15
    /// (2 ETH) fills the epoch's room, the rest and the 2/15 go to the hook; the sampler ready; setup fees cleared.
    function _capExcessBox() internal returns (Box memory b) {
        Params memory p = _mp(BoxSpecV1.Q_STREAM_CREATOR_IN_T, BoxSpecV1.T_STREAM_BURN_T, false);
        p.payee = carol;
        (p.creatorCap, p.capExcess) = (0.5 ether, BoxSpecV1.CAP_EXCESS_POOL_DEPTH);
        b = _graduatedBox(p);
        Books memory x0 = _books(b);
        uint256 unit0 = (3 ether + x0.carry) / 15;
        _feedQ(b, 3 ether);
        Books memory x1 = _books(b);
        uint256 counted = x1.kept - x0.kept;
        assertGt(counted, 0, "fixture: the creator's room counted");
        assertEq(_remaining(b), 0, "fixture: the room spent");
        assertEq(x1.qCreator - x0.qCreator, counted, "the creator-buy ledger: the room only");
        assertEq(x1.hookQ - x0.hookQ, unit0 * 2 + (unit0 * 10 - counted), "the 2/15 and the cap's excess to the hook");
        _readyAverage(b);
        _mintQ(b, 0.01 ether);
        b.receiver.collect(keeper);
    }

    /// One block: the creator's buy, then the conversion of the depth Q (the cap's excess among it). Returns the two
    /// fee notes (the module's, the hook's).
    function _creatorBuyAndConversion(Box memory b) internal returns (uint256 e, uint256 h) {
        (uint256 owedQ0, uint256 owedT0) = b.receiver.creatorOwed();
        uint256 kept0 = _books(b).kept;
        _roll(1);
        (Result memory r, Deep memory d) = _bothBuyers(b, BUY_C, true);
        assertEq(uint256(r.stop), uint256(IBoxSwapModule.Stop.None), "the creator's buy ran");
        assertEq(uint256(d.kind), uint256(DepthKind.Convert), "the hook converted the excess");
        assertGe(_sqrtP(b), TickMath.getSqrtPriceAtTick(_ref(b, true) - BAND), "never past the shared band");
        (uint256 owedQ1, uint256 owedT1) = b.receiver.creatorOwed();
        assertEq(owedT1 - owedT0, r.amountOut, "the creator's T: exactly what its step bought");
        assertEq(owedQ1, owedQ0, "no Q to the creator");
        assertEq(_books(b).kept, kept0, "the hook's conversion counts nothing against the creator's room");
        (uint256 cfq,) = _m(b).creatorFeesPending();
        (e,) = b.receiver.moduleFeesPending();
        h = b.receiver.hookFeesPending();
        assertEq(cfq, e, "the module's note is the creator-buy ledger's");
        assertEq(h, d.qIn / 100 - 2 * SLACK, "the hook's note");
    }

    /// The next batch returns both notes apart, and the 10/15 beyond the spent room goes into depth; the next pull gives
    /// the creator-buy ledger its own fee first (swap-module § 4.8).
    function _notesApartThenTheCreatorsFeeFirst(Box memory b, uint256 e, uint256 h) internal {
        _mintQ(b, 0.3 ether);
        Books memory y0 = _books(b);
        FeeBatch memory fb = b.receiver.collect(keeper);
        Books memory y1 = _books(b);
        uint256 unit = (fb.q - fb.qToReserve - e - h - fb.tip + y0.carry) / 15;
        assertEq(y1.qBack - y0.qBack, e, "the module's fee back to moduleBackQ");
        assertEq(y1.hookQ - y0.hookQ, h + unit * 12, "the hook's fee, the 2/15 and the 10/15 past the room");
        assertEq(y1.qCreator, y0.qCreator, "nothing more to the creator-buy ledger this epoch");
        assertEq(y1.fit - y0.fit, unit * 3, "FIT's 3/15");
        // The receiver's back ledger keeps 1 raw unit (its first return), so the pull hands e - 1, all of it the
        // creator's, and 1 stays owed.
        (uint256 mb0, uint256 mq0,,,) = _m(b).budgets();
        _m(b).sync();
        (uint256 mb1, uint256 mq1,,,) = _m(b).budgets();
        assertEq(mq1 - mq0, (y1.qCreator > 1 ? y1.qCreator - 1 : 0) + (e - 1), "the creator-buy ledger: its own fee");
        assertEq(mb1, mb0, "nothing of it to the burn-buy ledger");
        (uint256 cfq,) = _m(b).creatorFeesPending();
        assertEq(cfq, 1, "the raw unit the receiver's back ledger keeps is still owed to the creator-buy ledger");
        _assertHookClaimsAreItsBudget(b);
        _assertLedgersAreClaims(b);
    }

    // ============================================================================================================
    // Helpers

    /// Graduated, 1.5 ETH of fees through the split (the module's 10/15, the hook's 2/15), 1 ETH of Q-only depth by
    /// `fundDepth()`, the sampler ready at P1 (an hour of pokes), past `deepen()`'s cooldown.
    function _twoBuyerBox(Params memory p) internal returns (Box memory b) {
        b = _graduatedBox(p);
        _feedQ(b, 1.5 ether);
        vm.deal(address(this), address(this).balance + 1 ether);
        b.receiver.fundDepth{value: 1 ether}();
        _readyAverage(b);
        (, uint256 t) = b.hook.depthBudget();
        assertEq(t, 0, "fixture: Q-only depth");
    }

    /// The module's step (`a`) and `deepen()` in the current block, in the order given.
    function _bothBuyers(Box memory b, IBoxSwapModule.Action a, bool moduleFirst)
        internal
        returns (Result memory r, Deep memory d)
    {
        if (moduleFirst) {
            r = _step(b, a, keeper);
            d = _deepen(b);
        } else {
            d = _deepen(b);
            r = _step(b, a, keeper);
        }
    }

    function _deepen(Box memory b) internal returns (Deep memory d) {
        vm.recordLogs();
        (d.kind, d.skip, d.qUsed,, d.tip) = b.hook.deepen(keeper);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(b.hook) || logs[i].topics[0] != IBoxHook.DepthConverted.selector) continue;
            d.converted = true;
            (d.qIn, d.tOut) = abi.decode(logs[i].data, (uint256, uint256));
        }
    }

    function _books(Box memory b) internal view returns (Books memory x) {
        (x.qBurn, x.qCreator,,, x.qBack,,) = b.receiver.moduleOwed();
        x.fit = b.receiver.fitOwed();
        x.hookQ = _claims(address(b.hook), address(0));
        (x.carry,) = b.receiver.carried();
        (,,, x.kept,) = b.receiver.creatorCap();
    }

    function _remaining(Box memory b) internal view returns (uint256 rem) {
        (,,,, rem) = b.receiver.creatorCap();
    }

    /// The hook's claims are its depth budget, and it holds no ETH and no T.
    function _assertHookClaimsAreItsBudget(Box memory b) internal view {
        (uint256 q, uint256 t) = b.hook.depthBudget();
        assertEq(q, _claims(address(b.hook), address(0)), "the hook's Q claims are its Q budget");
        assertEq(t, _claims(address(b.hook), address(b.t)), "the hook's T claims are its T budget");
        assertEq(address(b.hook).balance, 0, "no ETH in the hook");
        assertEq(b.t.balanceOf(address(b.hook)), 0, "no T in the hook");
    }

    function _buyToTick(Box memory b, address who, int24 tick) internal {
        uint256 v = who.balance;
        vm.prank(who);
        // forge-lint: disable-next-line(unsafe-typecast)
        swapper.swap{value: v}(b.key, true, -int256(v), TickMath.getSqrtPriceAtTick(tick));
    }
}
