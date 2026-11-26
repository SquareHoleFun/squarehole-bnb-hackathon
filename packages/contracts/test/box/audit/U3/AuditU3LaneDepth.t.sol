// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import "./AuditU3LaneBase.sol";

contract AuditU3LaneDepth is AuditU3LaneBase {
    using StateLibrary for IPoolManager;

    struct Conversion {
        uint256 q;
        uint256 t;
        int24 ref;
        uint160 before_;
        uint160 after_;
        uint160 limit;
    }

    struct PairBefore {
        uint256 q;
        uint256 t;
        uint128 l;
        uint160 s;
        uint256 cap;
        uint256 tipBalance;
    }

    /// @notice Property: ticket SH-AUDIT-B0-U3 item 11 requires no cooldown for an add below MIN_ADD.
    /// BC-119 and dynamic-pool-share.md:110-113 instead describe a minimum budget followed by a size cap.
    /// Expected under the ticket: skip, or principal >= 21,034,900,425,000,000 wei. Observed: a pair adds
    /// 18,983,101,111,604,053 wei and records this block, blocking the next 300 blocks.
    /// Steps: factory box 0; close at P1; graduate; fund 1 ETH and T worth 1 ETH; 600 real executor samples; deepen.
    /// Cause: BoxHookExtension.sol:273-287 applies the near-price cap after checking the two budgets' minimum.
    function test_AUDIT_U3_51_subMinimumPairStartsCooldown() public {
        _graduate();
        _fundQ(1 ether);
        _fundT(_tValue(1 ether));
        _hold(600);
        (DepthKind kind, DeepenSkip skip, uint256 q,,) = hook.deepen(keeper);
        assertEq(uint256(skip), uint256(DeepenSkip.None));
        assertEq(uint256(kind), uint256(DepthKind.Pair));
        emit log_named_uint("actual add", q);
        emit log_named_uint("MIN_ADD", hook.minAdd());
        assertEq(q, 18_983_101_111_604_053);
        assertLt(q, hook.minAdd());
        assertEq(hook.lastDeepenBlock(), block.number);
        (, DeepenSkip next,,,) = hook.deepen(keeper);
        assertEq(uint256(next), uint256(DeepenSkip.Cooldown));
    }

    function testProperty_AUDIT_U3_principalTipCapAndPairFees() public {
        _graduate();
        _fundQ(3 ether);
        _fundT(_tValue(3 ether));
        _hold(600);
        _pairPrincipal();
        uint256 bought = kit.buy(trader, 0.2 ether, 0);
        kit.sell(trader, bought / 2);
        _hold(600);
        (uint128 l, uint256 f0, uint256 f1) = pm.getPositionInfo(
            key.toId(), a.hook, BoxSpecV1.MIN_USABLE_TICK, BoxSpecV1.MAX_USABLE_TICK, bytes32(uint256(3))
        );
        (uint256 g0, uint256 g1) =
            pm.getFeeGrowthInside(key.toId(), BoxSpecV1.MIN_USABLE_TICK, BoxSpecV1.MAX_USABLE_TICK);
        uint256 fq = FullMath.mulDiv(g0 - f0, l, 1 << 128);
        uint256 ft = FullMath.mulDiv(g1 - f1, l, 1 << 128);
        assertGt(fq + ft, 0);
        uint256 rq = _claims(a.receiver, address(0));
        uint256 rt = _claims(a.receiver, a.token);
        _pairPrincipal();
        assertEq(_claims(a.receiver, address(0)) - rq, fq);
        assertEq(_claims(a.receiver, a.token) - rt, ft);
    }

    function _pairPrincipal() internal {
        PairBefore memory b;
        (b.q, b.t) = hook.depthBudget();
        b.l = hook.pairedLiquidity();
        b.s = _sqrt();
        {
            (, int24 ref,) = average.twap();
            int24 sample = average.latestSampleTick();
            if (sample > ref) ref = sample;
            b.cap = _coreQ(ref) / 10;
        }
        b.tipBalance = keeper.balance;
        (DepthKind kind, DeepenSkip skip, uint256 q, uint256 t, uint256 tip) = hook.deepen(keeper);
        assertEq(uint256(kind), uint256(DepthKind.Pair));
        assertEq(uint256(skip), uint256(DeepenSkip.None));
        uint128 added = hook.pairedLiquidity() - b.l;
        assertGt(added, 0);
        assertEq(
            q, SqrtPriceMath.getAmount0Delta(b.s, TickMath.getSqrtPriceAtTick(BoxSpecV1.MAX_USABLE_TICK), added, true)
        );
        assertEq(
            t, SqrtPriceMath.getAmount1Delta(TickMath.getSqrtPriceAtTick(BoxSpecV1.MIN_USABLE_TICK), b.s, added, true)
        );
        assertLe(q, b.cap);
        assertEq(tip, q / 20 < hook.deepenTipCap() ? q / 20 : hook.deepenTipCap());
        assertEq(keeper.balance - b.tipBalance, tip);
        (uint256 q1, uint256 t1) = hook.depthBudget();
        assertEq(b.q - q1, q + tip);
        assertEq(b.t - t1, t);
        assertEq(_sqrt(), b.s);
        _assertBalances();
        _assertWord();
    }

    /// @notice BC-119 guards tested against the actual executor's hour; the push is immediately before deepen.
    /// The known sub-MIN_ADD pair is separately pinned by proof 51, including its cooldown behaviour.
    function testProperty_AUDIT_U3_realAverage98Through101Ticks() public {
        _graduate();
        _fundQ(2 ether);
        _fundT(_tValue(2 ether));
        _hold(600);
        (bool ready, int24 ref,) = average.twap();
        assertTrue(ready);
        for (uint256 side; side < 2; ++side) {
            for (int24 d = 98; d <= 101; ++d) {
                uint256 snap = vm.snapshotState();
                _land(ref + (side == 0 ? -d : d));
                // An exact downward landing has slot0.tick = target - 1. Move one sqrt unit above that
                // boundary with a real sell, so the measured deviation is exactly d, in both directions.
                if (_tick() != ref + (side == 0 ? -d : d)) {
                    uint256 held = token.balanceOf(trader);
                    uint160 limit = _sqrt() + 1;
                    vm.prank(trader);
                    swapper.swap(key, false, -int256(held), limit);
                }
                assertEq(_tick(), ref + (side == 0 ? -d : d));
                uint256 last = hook.lastDeepenBlock();
                (DepthKind kind, DeepenSkip skip, uint256 q,,) = hook.deepen(keeper);
                if (d >= 100) {
                    assertTrue(skip == DeepenSkip.Deviation || skip == DeepenSkip.AverageNotCaughtUp);
                    assertEq(hook.lastDeepenBlock(), last);
                    assertEq(q, 0);
                } else {
                    assertEq(uint256(skip), uint256(DeepenSkip.None));
                    assertEq(uint256(kind), uint256(DepthKind.Pair));
                    assertLe(q, _coreQ(ref) / 10); // post-add base is only larger
                    assertEq(hook.lastDeepenBlock(), block.number);
                }
                _assertBalances();
                vm.revertToState(snap);
            }
        }
    }

    function testProperty_AUDIT_U3_conversionBoundsAndFeeReturn() public {
        _graduate();
        _fundQ(1 ether);
        _hold(600);
        _land(_tick() - 60); // remaining reference-band room makes this conversion's 5% tip uncapped
        (uint256 q0, uint256 t0) = hook.depthBudget();
        uint160 s0 = _sqrt();
        vm.recordLogs();
        (DepthKind kind, DeepenSkip skip, uint256 used,, uint256 tip) = hook.deepen(keeper);
        assertEq(uint256(skip), uint256(DeepenSkip.None));
        assertEq(uint256(kind), uint256(DepthKind.Convert));
        assertGe(used, BoxSpecV1.DEPTH_CONVERT_MIN_Q);
        assertLt(used / 20, hook.deepenTipCap());
        assertEq(tip, used / 20);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        uint256 note;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != a.hook || logs[i].topics[0] != IBoxHook.DepthConverted.selector) continue;
            Conversion memory c = abi.decode(logs[i].data, (Conversion));
            assertEq(c.q, used);
            assertLe(c.q, (q0 - _qValue(t0, s0)) / 2);
            assertGe(c.after_, TickMath.getSqrtPriceAtTick(c.ref - 99));
            assertGe(c.after_, FullMath.mulDivRoundingUp(c.before_, BoxSwapBounds.SQRT_IMPACT_DOWN_X96, 1 << 96));
            assertGe(c.after_, c.limit);
            assertEq(_claims(a.hook, a.token) - t0, c.t);
            note = BoxSwapBounds.feeNote(c.q, 10_000);
            found = true;
        }
        assertTrue(found);
        uint256 pending = receiver.hookFeesPending();
        assertEq(pending, note);
        (uint256 q1,) = hook.depthBudget();
        assertEq(q0 - q1, used + tip);
        // Ensure the batch minimum without changing the pending conversion note.
        minter.mintTo{value: 0.02 ether}(a.receiver);
        (uint256 beforeCollect,) = hook.depthBudget();
        (,, uint256 depth0,,,,) = receiver.totals();
        receiver.collect(keeper);
        (uint256 afterCollect,) = hook.depthBudget();
        (,, uint256 depth1,,,,) = receiver.totals();
        assertEq(afterCollect - beforeCollect, depth1 - depth0 + note);
        pending = receiver.hookFeesPending();
        assertEq(pending, 0);
        _assertBalances();
    }

    function testProperty_AUDIT_U3_collectWhileDepthBlockedPokesFour() public {
        _graduate();
        _fundQ(1 ether);
        _fundT(_tValue(1 ether));
        _hold(600);
        hook.deepen(keeper);
        kit.buy(trader, 0.7 ether, 0);
        (, DeepenSkip skip,,,) = hook.deepen(keeper);
        assertEq(uint256(skip), uint256(DeepenSkip.Cooldown));
        uint128 l0 = hook.pairedLiquidity();
        uint256 last = hook.lastDeepenBlock();
        vm.recordLogs();
        receiver.collect(keeper);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 count;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(pm) || logs[i].topics[0] != IPoolManager.ModifyLiquidity.selector) continue;
            assertEq(address(uint160(uint256(logs[i].topics[2]))), a.hook);
            (,, int256 delta,) = abi.decode(logs[i].data, (int24, int24, int256, bytes32));
            assertEq(delta, 0);
            ++count;
        }
        assertEq(count, 4);
        assertEq(hook.pairedLiquidity(), l0);
        assertEq(hook.lastDeepenBlock(), last);
        _assertBalances();
    }
}
