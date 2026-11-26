// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {SqrtPriceMath} from "v4-core/src/libraries/SqrtPriceMath.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {BoxPhase} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxHook} from "../../../../src/box/interfaces/IBoxHook.sol";
import {AuditU3ClaudeActor, AuditU3ClaudeBase} from "./AuditU3ClaudeBase.sol";

/// @notice SH-AUDIT-B0-U3 (Claude), lenses L3 and L7 on the curve (P3.9, P3.15): from the bonding phase of the
/// factory's box 0, swaps of every shape through a router-like caller (exact input and exact output, both directions, 1
/// wei to the full curve, any price limit, two and three swaps in one unlock with or without try/catch around the later
/// ones). Properties: the swap that ends at or beyond √P1 sets `closedAtBlock` in its own afterSwap and only that one;
/// no later swap in the same unlock, transaction or block succeeds until `graduate()`; before migration the price never
/// ends above √P0 (`BoxHook.sol:204-228`, `IBoxHook.sol:51-53`, BC-025, D1). Every failed swap's reason is the
/// documented one for its phase (a refused sell is `BelowCurveFloor`, a swap after the close is `CurveIsClosed`).
/// forge-config: default.evm_version = "osaka"
contract AuditU3ClaudeCloseTest is AuditU3ClaudeBase {
    address internal trader = makeAddr("audit.u3.trader");
    uint160 internal sqrtP0;
    uint160 internal sqrtP1;

    function setUp() public override {
        super.setUp();
        _toBonding();
        sqrtP0 = curve.sqrtPriceUpperX96;
        sqrtP1 = curve.sqrtPriceLowerX96;
        // The trader holds T for sells (bought on the curve, at the 1% fee alone) and approves the actor.
        _buy(trader, 0.5 ether);
        vm.prank(trader);
        token.approve(address(u3actor), type(uint256).max);
        _fund(trader, 100 ether);
    }

    // ============================================================================================================
    // One swap of any shape

    /// One swap, any shape: if it succeeds, the curve is closed exactly when the price ended at or below √P1, in this
    /// block, and the price is never above √P0; if it fails, the reason is `BelowCurveFloor` (a sell past P0) or v4's
    /// own refusal of the input, never the gate (bonding) (BC-025, `BoxHook.sol:220-225`).
    function testFuzz_AUDIT_U3_oneSwapClosesOnlyAtOrPastP1(uint256 size, uint256 limitSeed, bool exactIn, bool buy)
        public
    {
        AuditU3ClaudeActor.Leg[] memory legs = new AuditU3ClaudeActor.Leg[](1);
        legs[0] = _randomLeg(size, limitSeed, exactIn, buy, true);
        uint160 before = _sqrtP();
        (bool[] memory ok,, bytes memory err) = _run(legs);
        if (ok[0]) {
            uint160 s = _sqrtP();
            assertLe(s, sqrtP0, "never above P0 before migration");
            assertEq(hook.closed(), s <= sqrtP1, "closed exactly when the swap ended at or beyond P1");
            if (s <= sqrtP1) {
                assertEq(hook.closedAtBlock(), vm.getBlockNumber(), "in its own block");
                assertEq(uint8(hook.phase()), uint8(BoxPhase.Closed));
            }
        } else {
            assertEq(_sqrtP(), before, "a refused swap moves nothing");
            assertFalse(hook.closed());
            bytes4 r = _hookReason(err);
            if (r != bytes4(0)) {
                assertEq(r, IBoxHook.BelowCurveFloor.selector, "the only hook refusal in bonding");
                assertFalse(buy, "only a sell can end above P0");
            }
        }
    }

    /// Exact landings: a buy limited at exactly √P1 closes (exact input and exact output larger than the curve); a buy
    /// limited one unit above √P1 does not, and the next 1-wei-input buy that reaches P1 does, in its own block.
    function testProperty_AUDIT_U3_closesAtExactlyP1NotOneAbove() public {
        AuditU3ClaudeActor.Leg[] memory legs = new AuditU3ClaudeActor.Leg[](1);
        legs[0] = _leg(true, -int256(3 * raise), sqrtP1 + 1, false);
        _run(legs);
        assertEq(_sqrtP(), sqrtP1 + 1);
        assertFalse(hook.closed(), "one unit above P1: open");
        uint256 tLeft = SqrtPriceMath.getAmount1Delta(sqrtP1, sqrtP1 + 1, curve.liquidity, false);
        emit log_named_uint("T left on the curve one unit above P1 (raw)", tLeft);
        _advance(1);
        // A 1-wei input is all fee (v4 rounds its net input to zero): the price stays and the curve stays open.
        legs[0] = _leg(true, -1, TickMath.MIN_SQRT_PRICE + 1, false);
        (bool[] memory ok,,) = _run(legs);
        assertTrue(ok[0]);
        assertEq(_sqrtP(), sqrtP1 + 1, "a 1-wei buy moves nothing");
        assertFalse(hook.closed());
        // Two wei: 1 of input after the fee buys the last unit and ends exactly at P1 (the fee takes the other): that
        // buy closes the curve, in its own block.
        legs[0] = _leg(true, -2, TickMath.MIN_SQRT_PRICE + 1, false);
        (ok,,) = _run(legs);
        assertTrue(ok[0]);
        assertEq(_sqrtP(), sqrtP1, "ends exactly at P1");
        assertTrue(hook.closed(), "the buy that reached P1 closed it");
        assertEq(hook.closedAtBlock(), vm.getBlockNumber());
    }

    /// The close and graduate() in the same block: the swaps after the close in that block are refused until
    /// graduate(), then pass in that same block (D1: graduate() may follow the close at once).
    function testProperty_AUDIT_U3_closeAndGraduateInOneBlock() public {
        AuditU3ClaudeActor.Leg[] memory legs = new AuditU3ClaudeActor.Leg[](1);
        legs[0] = _leg(true, -int256(3 * raise), sqrtP1, false);
        _run(legs);
        assertTrue(hook.closed());
        legs[0] = _leg(false, -1e18, TickMath.MAX_SQRT_PRICE - 1, true);
        (bool[] memory ok,, bytes memory err) = _run(legs);
        assertFalse(ok[0]);
        assertEq(_hookReason(err), IBoxHook.CurveIsClosed.selector);
        _graduate(keeper);
        assertEq(hook.migratedAtBlock(), hook.closedAtBlock(), "graduated in the closing block");
        (ok,,) = _run(legs);
        assertTrue(ok[0], "a sell in the same block after graduate()");
    }

    /// Exact output larger than all the T the curve has left: the swap runs to its limit (no liquidity beyond P1),
    /// pays only for the T it received, and closes (BC-025 "an exact-output close pays exactly").
    function testProperty_AUDIT_U3_exactOutputBeyondTheCurveCloses() public {
        uint256 tLeft = SqrtPriceMath.getAmount1Delta(sqrtP1, _sqrtP(), curve.liquidity, false);
        AuditU3ClaudeActor.Leg[] memory legs = new AuditU3ClaudeActor.Leg[](1);
        legs[0] = _leg(true, int256(tLeft * 2), TickMath.MIN_SQRT_PRICE + 1, false);
        uint256 t0 = token.balanceOf(trader);
        (bool[] memory ok, BalanceDelta[] memory d,) = _run(legs);
        assertTrue(ok[0]);
        assertTrue(hook.closed());
        assertEq(_sqrtP(), TickMath.MIN_SQRT_PRICE + 1, "it ran to its limit with no liquidity past P1");
        uint256 got = token.balanceOf(trader) - t0;
        assertLe(got, tLeft + 1, "only the T the curve held");
        assertGe(got + 1, tLeft);
        assertEq(uint256(int256(d[0].amount1())), got);
    }

    /// An exact-output buy of exactly the T the curve has left (SqrtPriceMath, rounded down) and of one raw unit less
    /// (BC-025 "an exact-output close pays exactly"): each pays what v4's own maths asks for the price it reached (its
    /// net input and the 1% fee, rounded up per swap step); the first ends at P1 and closes; one unit less leaves the
    /// price above P1 with at most 1 raw unit of T on the curve, and the next 2-wei buy closes it, so no T can be
    /// stranded on an open curve.
    function testProperty_AUDIT_U3_exactOutputOfExactlyTheTLeft() public {
        uint256 snap = vm.snapshotState();
        for (uint256 k; k < 2; ++k) {
            vm.revertToState(snap);
            uint160 s0 = _sqrtP();
            uint256 tLeft = SqrtPriceMath.getAmount1Delta(sqrtP1, s0, curve.liquidity, false);
            AuditU3ClaudeActor.Leg[] memory legs = new AuditU3ClaudeActor.Leg[](1);
            legs[0] = _leg(true, int256(tLeft - k), TickMath.MIN_SQRT_PRICE + 1, false);
            (bool[] memory ok, BalanceDelta[] memory d,) = _run(legs);
            assertTrue(ok[0]);
            uint160 s1 = _sqrtP();
            emit log_named_uint(k == 0 ? "exactly the T left: closed" : "one unit less: closed", hook.closed() ? 1 : 0);
            // casting to 'uint256' is safe because a buy's T side is positive
            // forge-lint: disable-next-line(unsafe-typecast)
            assertEq(uint256(int256(d[0].amount1())), tLeft - k, "exactly the T asked for");
            // casting to 'uint256' is safe because a buy's Q side is negative
            // forge-lint: disable-next-line(unsafe-typecast)
            uint256 paid = uint256(-int256(d[0].amount0()));
            uint256 net = SqrtPriceMath.getAmount0Delta(s1, s0, curve.liquidity, true);
            uint256 single = net + FullMath.mulDivRoundingUp(net, 10_000, 990_000);
            // v4 rounds each swap step's input and fee up (word boundaries split the move): a few raw units at most.
            assertGe(paid, single, "the net input plus the 1% fee");
            assertLe(paid - single, 4, "and no more than per-step rounding");
            emit log_named_uint("  paid above one-step rounding (wei)", paid - single);
            if (k == 0) {
                assertTrue(hook.closed(), "the whole T left: closed");
                assertEq(s1, sqrtP1, "at exactly P1");
            } else if (!hook.closed()) {
                assertGt(s1, sqrtP1);
                assertLe(SqrtPriceMath.getAmount1Delta(sqrtP1, s1, curve.liquidity, false), 1, "at most 1 unit left");
                legs[0] = _leg(true, -2, TickMath.MIN_SQRT_PRICE + 1, false);
                _run(legs);
                assertTrue(hook.closed(), "a 2-wei buy closes it");
            }
        }
    }

    // ============================================================================================================
    // Several swaps in one unlock around P1

    /// A buy that crosses P1 then any second swap in the same unlock: without try/catch the whole unlock reverts with
    /// the second swap's `CurveIsClosed` and nothing changes (the round trip is impossible, BC-025); with try/catch
    /// the first swap's close stands, the second is refused `CurveIsClosed(this block)`, and a third likewise.
    function testFuzz_AUDIT_U3_crossThenAnySwapInOneUnlock(
        uint256 size1,
        bool exactIn1,
        uint256 size2,
        uint256 limitSeed2,
        bool exactIn2,
        bool buy2,
        bool catchLater
    ) public {
        AuditU3ClaudeActor.Leg[] memory legs = new AuditU3ClaudeActor.Leg[](3);
        // The first leg ends at or beyond P1: a buy limited at or below √P1 with more input than the curve holds.
        uint256 tLeft = SqrtPriceMath.getAmount1Delta(sqrtP1, _sqrtP(), curve.liquidity, false);
        int256 a1 = exactIn1 ? -int256(bound(size1, 3 * raise, 6 * raise)) : int256(bound(size1, tLeft + 1, 2 * tLeft));
        uint160 l1 = uint160(bound(uint256(keccak256(abi.encode(size1))), TickMath.MIN_SQRT_PRICE + 1, sqrtP1));
        legs[0] = _leg(true, a1, l1, false);
        legs[1] = _randomLeg(size2, limitSeed2, exactIn2, buy2, catchLater);
        legs[2] = _randomLeg(size2 / 3 + 1, limitSeed2 / 7, !exactIn2, !buy2, catchLater);
        uint160 before = _sqrtP();
        (bool ok, bytes memory ret) = address(this).call(abi.encodeCall(this.runExternal, (legs)));
        if (!catchLater) {
            assertFalse(ok, "the second swap of the unlock reverts it all");
            bytes memory closedNow = _hookRevert(
                IHooks.beforeSwap.selector, abi.encodeWithSelector(IBoxHook.CurveIsClosed.selector, vm.getBlockNumber())
            );
            assertEq(ret, closedNow, "CurveIsClosed from the later swap's beforeSwap");
            assertFalse(hook.closed());
            assertEq(_sqrtP(), before, "nothing changed");
            return;
        }
        assertTrue(ok, "with try/catch the unlock completes");
        (bool[] memory oks,, bytes memory err) = abi.decode(ret, (bool[], BalanceDelta[], bytes));
        assertTrue(oks[0], "the crossing swap stands");
        assertFalse(oks[1], "the second is refused");
        assertFalse(oks[2], "and the third");
        assertEq(_hookReason(err), IBoxHook.CurveIsClosed.selector);
        assertTrue(hook.closed());
        assertEq(hook.closedAtBlock(), vm.getBlockNumber());
        assertLe(_sqrtP(), sqrtP1);
    }

    /// After the close, in the same block and later blocks, every swap is refused until graduate(); graduate() may run
    /// in the closing block itself, after which every swap passes in that block.
    function testProperty_AUDIT_U3_noSwapAfterTheCloseUntilGraduation() public {
        AuditU3ClaudeActor.Leg[] memory legs = new AuditU3ClaudeActor.Leg[](1);
        legs[0] = _leg(true, -int256(3 * raise), sqrtP1, false);
        _run(legs);
        assertTrue(hook.closed());
        uint256 closedAt = vm.getBlockNumber();
        for (uint256 b; b < 3; ++b) {
            for (uint256 k; k < 4; ++k) {
                legs[0] = _randomLeg(uint256(keccak256(abi.encode(b, k))), k * 977, k % 2 == 0, k < 2, true);
                (bool[] memory ok,, bytes memory err) = _run(legs);
                assertFalse(ok[0]);
                assertEq(_hookReason(err), IBoxHook.CurveIsClosed.selector);
            }
            if (b == 0) {
                // Same block, a second transaction: still refused (checked above at b == 0); then the next blocks.
                _advance(1);
            } else {
                _advance(7);
            }
        }
        assertEq(hook.closedAtBlock(), closedAt, "never rewritten");
        _graduate(keeper);
        legs[0] = _leg(true, -1e15, TickMath.MIN_SQRT_PRICE + 1, true);
        (bool[] memory okAfter,,) = _run(legs);
        assertTrue(okAfter[0], "after graduate() in the same block, swaps pass");
    }

    /// Before migration the price never ends above √P0: a sell of more T than the curve sold, at any limit above P0,
    /// is refused `BelowCurveFloor(the price it reached)`; a sell limited at exactly √P0 ends there and passes.
    /// The T outside the box before migration is at most what the curve sold (part of it sits in the placeholders'
    /// escrow), so no real holder can reach P0; the test gives a stand-in holder more T than the curve sold (forge-std
    /// `deal`, outside the box, no ghost check here), as "T from elsewhere", to reach the floor.
    function testFuzz_AUDIT_U3_priceNeverAboveP0BeforeMigration(uint256 extra, uint256 limitSeed) public {
        uint256 tSold = SqrtPriceMath.getAmount1Delta(_sqrtP(), sqrtP0, curve.liquidity, true);
        deal(address(token), whale, 3 * tSold);
        uint256 have = token.balanceOf(whale);
        vm.prank(whale);
        token.approve(address(u3actor), type(uint256).max);
        // More than the curve's T back to P0 after the 1% fee (the fee is taken from the input).
        uint256 tIn = bound(extra, tSold * 102 / 100, have);
        uint160 limit = uint160(bound(limitSeed, uint256(sqrtP0) + 1, TickMath.MAX_SQRT_PRICE - 1));
        AuditU3ClaudeActor.Leg[] memory legs = new AuditU3ClaudeActor.Leg[](1);
        legs[0] = _leg(false, -int256(tIn), limit, true);
        vm.prank(whale);
        (bool[] memory ok,, bytes memory err) = u3actor.swaps(poolKey, legs, whale, whale);
        assertFalse(ok[0], "a sell that would end above P0");
        assertEq(_hookReason(err), IBoxHook.BelowCurveFloor.selector);
        assertLe(_sqrtP(), sqrtP0);
        legs[0] = _leg(false, -int256(tIn), sqrtP0, true);
        vm.prank(whale);
        (ok,,) = u3actor.swaps(poolKey, legs, whale, whale);
        assertTrue(ok[0], "limited at exactly P0: passes");
        assertEq(_sqrtP(), sqrtP0, "and ends exactly at P0");
        assertFalse(hook.closed());
    }

    // ------------------------------------------------------------------------------------------------ helpers

    /// @notice Runs `legs` through the actor as the trader (who sends 20 ETH and gets the rest back) and returns the
    /// actor's result; external so a test can see a reverting unlock as data.
    function runExternal(AuditU3ClaudeActor.Leg[] memory legs)
        external
        returns (bool[] memory ok, BalanceDelta[] memory deltas, bytes memory firstError)
    {
        require(msg.sender == address(this), "self only");
        return _run(legs);
    }

    function _run(AuditU3ClaudeActor.Leg[] memory legs)
        internal
        returns (bool[] memory ok, BalanceDelta[] memory deltas, bytes memory firstError)
    {
        _fund(trader, 20 ether);
        vm.prank(trader);
        (ok, deltas, firstError) = u3actor.swaps{value: 20 ether}(poolKey, legs, trader, trader);
        u3actor.sweepTo(trader);
    }

    /// @notice A swap of a random shape: a buy pays at most 6 R of ETH or asks for at most twice the curve's T left; a
    /// sell spends at most the trader's T or asks for at most the curve's Q; the limit is anywhere on the swap's side
    /// of spot, half the time within 2,000 ticks of P1 (buys) or P0 (sells).
    function _randomLeg(uint256 size, uint256 limitSeed, bool exactIn, bool buy, bool tryCatch)
        internal
        view
        returns (AuditU3ClaudeActor.Leg memory)
    {
        uint160 s = _sqrtP();
        int256 amount;
        uint160 limit;
        if (buy) {
            uint256 tLeft = s > sqrtP1 ? SqrtPriceMath.getAmount1Delta(sqrtP1, s, curve.liquidity, false) : 1e18;
            amount = exactIn ? -int256(bound(size, 1, 6 * raise)) : int256(bound(size, 1, 2 * tLeft + 1));
            uint256 lo = TickMath.MIN_SQRT_PRICE + 1;
            uint256 hi = s > lo + 1 ? s - 1 : lo;
            if (limitSeed % 2 == 0) {
                uint256 near = TickMath.getSqrtPriceAtTick(curve.tickLower - 2_000);
                lo = near > lo && near < hi ? near : lo;
            }
            limit = uint160(bound(limitSeed, lo, hi));
        } else {
            uint256 tHave = token.balanceOf(trader);
            // An exact-output sell asks for at most the Q the trader's whole T would fetch (so the actor can pay it).
            uint256 qMax = 1;
            if (s < sqrtP0 && s >= sqrtP1) {
                uint160 sAll = SqrtPriceMath.getNextSqrtPriceFromInput(s, curve.liquidity, tHave * 98 / 100, false);
                if (sAll > sqrtP0) sAll = sqrtP0;
                qMax = SqrtPriceMath.getAmount0Delta(s, sAll, curve.liquidity, false) * 98 / 100 + 1;
            }
            amount = exactIn ? -int256(bound(size, 1, tHave)) : int256(bound(size, 1, qMax));
            uint256 lo = uint256(s) + 1;
            uint256 hi = TickMath.MAX_SQRT_PRICE - 1;
            if (limitSeed % 2 == 0) {
                uint256 near = TickMath.getSqrtPriceAtTick(curve.tickUpper + 2_000);
                hi = near > lo ? near : hi;
            }
            limit = uint160(bound(limitSeed, lo, hi));
        }
        return _leg(buy, amount, limit, tryCatch);
    }
}
