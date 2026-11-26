// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import "./AuditU3LaneBase.sol";

contract AuditU3LaneBounds is AuditU3LaneBase {
    using StateLibrary for IPoolManager;

    function setUp() public override {
        super.setUp();
        _graduate();
        _fundQ(1 ether);
        _fundT(_tValue(1 ether));
        _hold(600);
    }

    /// @notice BC-137: differential on actual box-0 ask/bid/sentinel/pair and the old curve's boundaries.
    /// Estimated input is then swapped WITHOUT the tested limit, checking that its price move cannot exceed it.
    /// Independently a second real swap reaches the limit; six raw input units bound v4 step rounding.
    function testFuzz_AUDIT_U3_oneStepBoundAgainstRealLayouts(
        uint256 regionSeed,
        uint256 offsetSeed,
        uint256 stepSeed,
        bool buy,
        bool pair
    ) public {
        if (pair) hook.deepen(keeper);
        uint256 region = regionSeed % 5;
        int24 target;
        if (region == 0) {
            target = curve.tickLower - int24(int256(bound(offsetSeed, 60, 1200)));
        } else if (region == 1) {
            target = curve.tickLower + int24(bound(int256(offsetSeed % 121), 0, 120)) - 60;
        } else if (region == 2) {
            target = int24(
                int256(bound(offsetSeed, uint256(int256(curve.tickLower + 61)), uint256(int256(curve.tickUpper - 61))))
            );
        } else if (region == 3) {
            target = curve.tickUpper + int24(int256(bound(offsetSeed, 0, 120))) - 60;
        } else {
            target = curve.tickLower - int24(int256(bound(offsetSeed, 1201, 5000)));
        }
        _land(target);
        _checkReads();
        _boundAtSpot(buy, int24(int256(bound(stepSeed, 1, 49))));
    }

    function _boundAtSpot(bool buy, int24 ticks) internal {
        bytes32 slot = keccak256(abi.encode(PoolId.unwrap(key.toId()), uint256(6)));
        Slot0 s0 = Slot0.wrap(pm.extsload(slot));
        int24 spot = TickMath.getTickAtSqrtPrice(s0.sqrtPriceX96());
        uint160 limit = TickMath.getSqrtPriceAtTick(buy ? spot - ticks : spot + ticks);
        uint256 estimate = buy
            ? BoxSwapBounds.buyInput(pm, slot, s0, limit, 10_000)
            : BoxSwapBounds.sellInput(pm, slot, s0, limit, 10_000);
        assertGt(estimate, 0);
        uint256 snap = vm.snapshotState();
        vm.deal(trader, 100 ether);
        vm.prank(trader);
        swapper.swap{value: buy ? 100 ether : 0}(key, buy, -int256(estimate), 0);
        if (buy) assertGe(_sqrt(), limit, "bound must not understate real downward move");
        else assertLe(_sqrt(), limit, "bound must not understate real upward move");
        vm.revertToState(snap);
        vm.deal(trader, 100 ether);
        uint256 available = buy ? 100 ether : token.balanceOf(trader);
        vm.prank(trader);
        BalanceDelta actual = swapper.swap{value: buy ? 100 ether : 0}(key, buy, -int256(available), limit);
        assertEq(_sqrt(), limit);
        uint256 input = uint256(uint128(-(buy ? actual.amount0() : actual.amount1())));
        assertLe(estimate, input);
        assertLe(input - estimate, 6);
        _checkReads();
    }

    function testProperty_AUDIT_U3_storageReadsAndPositionSalts() public {
        _checkReads();
        hook.deepen(keeper);
        _checkReads();
        kit.buy(trader, 0.2 ether, 0);
        _checkReads();
        int24[5] memory los =
            [curve.tickLower, BoxSpecV1.MIN_USABLE_TICK, curve.tickLower, curve.tickUpper, BoxSpecV1.MIN_USABLE_TICK];
        int24[5] memory his = [
            curve.tickUpper,
            curve.tickLower,
            BoxSpecV1.MAX_USABLE_TICK,
            BoxSpecV1.MAX_USABLE_TICK,
            BoxSpecV1.MAX_USABLE_TICK
        ];
        uint256[5] memory salts = [uint256(0), 1, 1, 1, 3];
        bytes32[5] memory ids;
        for (uint256 i; i < 5; ++i) {
            ids[i] = keccak256(abi.encodePacked(a.hook, los[i], his[i], bytes32(salts[i])));
            assertEq(_position(los[i], his[i], 2), 0, "retired salt never used");
            for (uint256 j; j < i; ++j) {
                assertTrue(ids[i] != ids[j]);
            }
        }
        assertEq(salts[4], BoxSpecV1.DEPTH_PAIR_SALT);
        assertGt(hook.pairedLiquidity(), 0);
    }

    function _checkReads() internal view {
        PoolId id = key.toId();
        bytes32 slot = keccak256(abi.encode(PoolId.unwrap(id), uint256(6)));
        Slot0 raw = Slot0.wrap(pm.extsload(slot));
        (uint160 s, int24 tick, uint24 protocol, uint24 fee) = pm.getSlot0(id);
        assertEq(raw.sqrtPriceX96(), s);
        assertEq(raw.tick(), tick);
        assertEq(raw.protocolFee(), protocol);
        assertEq(raw.lpFee(), fee);
        assertEq(uint128(uint256(pm.extsload(bytes32(uint256(slot) + 3)))), pm.getLiquidity(id));
        int24[5] memory ticks = [
            BoxSpecV1.MIN_USABLE_TICK,
            curve.tickLower,
            curve.tickUpper,
            BoxSpecV1.MAX_USABLE_TICK,
            int24(tick / 60 * 60)
        ];
        for (uint256 i; i < ticks.length; ++i) {
            uint256 packed = uint256(pm.extsload(keccak256(abi.encode(ticks[i], uint256(slot) + 4))));
            (uint128 gross, int128 net) = pm.getTickLiquidity(id, ticks[i]);
            assertEq(uint128(packed), gross);
            assertEq(int256(packed) >> 128, net);
        }
        _readPosition(slot, curve.tickLower, curve.tickUpper, 0);
        (uint128 ask, uint128 bid, uint128 sentinel) = hook.graduatedLayout();
        assertEq(ask, _readPosition(slot, BoxSpecV1.MIN_USABLE_TICK, curve.tickLower, 1));
        assertEq(bid, _readPosition(slot, curve.tickLower, BoxSpecV1.MAX_USABLE_TICK, 1));
        assertEq(sentinel, _readPosition(slot, curve.tickUpper, BoxSpecV1.MAX_USABLE_TICK, 1));
        assertEq(hook.pairedLiquidity(), _readPosition(slot, BoxSpecV1.MIN_USABLE_TICK, BoxSpecV1.MAX_USABLE_TICK, 3));
    }

    function _readPosition(bytes32 slot, int24 lo, int24 hi, uint256 salt) internal view returns (uint128 l) {
        bytes32 id = keccak256(abi.encodePacked(a.hook, lo, hi, bytes32(salt)));
        bytes32 p = keccak256(abi.encode(id, uint256(slot) + 6));
        l = uint128(uint256(pm.extsload(p)));
        assertEq(l, _position(lo, hi, salt));
    }

    struct Totals {
        uint256 fit;
        uint256 platform;
        uint256 burns;
        uint256 stream;
    }

    /// @notice BC-118/F77: same factory state, fixed gross swap inputs, fees and funding, with/without pairing.
    /// No price mocks. The real item stream receives the reward share; any burns it performs are counted too.
    function testProperty_AUDIT_U3_depthDoesNotSpendBurnsOrRewardsResidue() public {
        uint256 snapshot = vm.snapshotState();
        Totals memory off = _feeHistory(false);
        vm.revertToState(snapshot);
        Totals memory on = _feeHistory(true);
        assertApproxEqAbs(on.fit, off.fit, 30);
        assertApproxEqAbs(on.platform, off.platform, 30);
        assertApproxEqAbs(on.burns, off.burns, 30);
        assertApproxEqAbs(on.stream, off.stream, 30);
        assertEq(on.fit, off.fit, "measured BC-118 FIT residue: zero wei");
        assertEq(on.platform, off.platform, "measured platform residue: zero wei");
        assertEq(on.burns, off.burns, "measured burn residue: zero raw T");
        assertEq(on.stream, off.stream, "measured stream residue: zero raw T");
        emit log_named_int("BC118 fit residue wei", int256(on.fit) - int256(off.fit));
        emit log_named_int("BC118 platform residue wei", int256(on.platform) - int256(off.platform));
        emit log_named_int("BC118 burned residue raw T", int256(on.burns) - int256(off.burns));
        emit log_named_int("BC118 stream residue raw T", int256(on.stream) - int256(off.stream));
    }

    function _feeHistory(bool adds) internal returns (Totals memory t) {
        for (uint256 i; i < 3; ++i) {
            kit.buy(trader, 0.7 ether, 0);
            kit.sell(trader, 3e24);
            kit.buy(trader, 0.4 ether, 0);
            kit.sell(trader, 2e24);
            minter.mintTo{value: 0.5 ether}(a.receiver);
            funder.deposit(a.token, trader, 2e24, a.receiver);
            receiver.collect(keeper);
            _hold(600);
            bytes32 totalsBefore = _totalsHash();
            uint256 burnsBefore = token.totalBurned();
            uint256 streamBefore = token.balanceOf(a.itemStream);
            if (adds) {
                (DepthKind kind,,,,) = hook.deepen(keeper);
                assertEq(uint256(kind), uint256(DepthKind.Pair));
            }
            assertEq(_totalsHash(), totalsBefore, "add cannot debit fee totals");
            assertEq(token.totalBurned(), burnsBefore);
            assertEq(token.balanceOf(a.itemStream), streamBefore);
        }
        (t.fit, t.platform,,,,,) = receiver.totals();
        t.burns = token.totalBurned();
        t.stream = token.balanceOf(a.itemStream);
        if (adds) assertGt(hook.pairedLiquidity(), 0);
        else assertEq(hook.pairedLiquidity(), 0);
    }

    function _totalsHash() internal view returns (bytes32) {
        (bool ok, bytes memory data) = a.receiver.staticcall(abi.encodeCall(receiver.totals, ()));
        require(ok);
        return keccak256(data);
    }
}
