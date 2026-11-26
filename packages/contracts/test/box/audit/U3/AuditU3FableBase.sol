// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VmSafe} from "forge-std/Vm.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {SqrtPriceMath} from "v4-core/src/libraries/SqrtPriceMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {TransientStateLibrary} from "v4-core/src/libraries/TransientStateLibrary.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {Slot0} from "v4-core/src/types/Slot0.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {DeepenSkip, DepthKind} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxHook} from "../../../../src/box/interfaces/IBoxHook.sol";
import {IBoxReceiver} from "../../../../src/box/interfaces/IBoxReceiver.sol";
import {BoxSwapBounds} from "../../../../src/box/libraries/BoxSwapBounds.sol";
import {EthIn, EthOut, TIn, TOut} from "../common/AuditGhostLedger.sol";
import {AuditPhases} from "../common/AuditPhases.sol";

interface IERC20Like {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

/// @title AuditU3FableClaimsGift
/// @notice TEST ONLY (SH-AUDIT-B0 U3, Fable). Turns ETH or T into ERC-6909 claims held by any address, inside this
/// contract's own PoolManager unlock: a stand-in for every outside path that lands claims on the hook (the receiver's
/// depth parts, a swept tax, the cap's excess) and for a stranger's gift of claims (P3.1: "third-party claim transfers
/// to the hook only enlarge the depth budget"). T must be transferred to this contract before `giftT`.
contract AuditU3FableClaimsGift is IUnlockCallback {
    IPoolManager public immutable pm;

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    function giftQ(address to) external payable returns (uint256) {
        return abi.decode(pm.unlock(abi.encode(address(0), to, msg.value)), (uint256));
    }

    function giftT(address token, address to, uint256 amount) external returns (uint256) {
        return abi.decode(pm.unlock(abi.encode(token, to, amount)), (uint256));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "gift: pm");
        (address asset, address to, uint256 amount) = abi.decode(data, (address, address, uint256));
        pm.sync(Currency.wrap(asset));
        uint256 paid;
        if (asset == address(0)) {
            paid = pm.settle{value: amount}();
        } else {
            require(IERC20Like(asset).transfer(address(pm), amount), "gift: T transfer");
            paid = pm.settle();
        }
        pm.mint(to, uint256(uint160(asset)), paid);
        return abi.encode(paid);
    }
}

/// @title AuditU3FableOutsider
/// @notice TEST ONLY. An account with code that tries, inside its own unlock, what the closed pool must refuse: an
/// outside add, removal or zero-liquidity poke, a donation, a direct call of the hook's `unlockCallback`, `deepen`
/// and the receiver's `collect` from inside a foreign unlock (P3.6, P3.8; BC-031, BC-032, BC-119).
contract AuditU3FableOutsider is IUnlockCallback {
    using TransientStateLibrary for IPoolManager;

    IPoolManager public immutable pm;
    /// @notice What `pm.exttload` of v4's unlocked slot read inside the last unlock.
    bytes32 public unlockedSlotSeen;

    uint8 private constant _MODIFY = 1;
    uint8 private constant _DONATE = 2;
    uint8 private constant _PROBE = 3;

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    function modify(PoolKey memory key, int24 lower, int24 upper, int256 delta) external payable {
        pm.unlock(abi.encode(_MODIFY, abi.encode(key, lower, upper, delta)));
    }

    function donate(PoolKey memory key, uint256 amount0, uint256 amount1) external payable {
        pm.unlock(abi.encode(_DONATE, abi.encode(key, amount0, amount1)));
    }

    /// @notice Inside a foreign unlock: the hook's `unlockCallback`, `deepen` and the receiver's `collect` each tried;
    /// returns the three revert selectors (0 for a success).
    function probe(address hook, address receiver)
        external
        returns (bytes4 callbackSel, bytes4 deepenSel, bytes4 collectSel)
    {
        return abi.decode(pm.unlock(abi.encode(_PROBE, abi.encode(hook, receiver))), (bytes4, bytes4, bytes4));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "outsider: pm");
        unlockedSlotSeen = pm.exttload(0xc090fc4683624cfc3884e9d8de5eca132f2d0ec062aff75d43c0465d5ceeab23);
        (uint8 act, bytes memory arg) = abi.decode(data, (uint8, bytes));
        if (act == _MODIFY) {
            (PoolKey memory key, int24 lower, int24 upper, int256 delta) =
                abi.decode(arg, (PoolKey, int24, int24, int256));
            pm.modifyLiquidity(key, ModifyLiquidityParams(lower, upper, delta, bytes32(0)), "");
            _settleAll(key);
            return "";
        }
        if (act == _DONATE) {
            (PoolKey memory key, uint256 a0, uint256 a1) = abi.decode(arg, (PoolKey, uint256, uint256));
            pm.donate(key, a0, a1, "");
            _settleAll(key);
            return "";
        }
        (address hook, address receiver) = abi.decode(arg, (address, address));
        bytes4 cb = _sel(hook, abi.encodeCall(IUnlockCallback.unlockCallback, (abi.encode(uint256(3), bytes("")))));
        bytes4 dp = _sel(hook, abi.encodeCall(IBoxHook.deepen, (address(this))));
        bytes4 cl = _sel(receiver, abi.encodeCall(IBoxReceiver.collect, (address(this))));
        return abi.encode(cb, dp, cl);
    }

    function _sel(address target, bytes memory call) private returns (bytes4 sel) {
        (bool ok, bytes memory ret) = target.call(call);
        if (ok) return bytes4(0);
        if (ret.length >= 4) sel = bytes4(ret);
        else sel = 0xffffffff;
    }

    function _settleAll(PoolKey memory key) private {
        _settle(key.currency0);
        _settle(key.currency1);
    }

    function _settle(Currency c) private {
        int256 d = pm.currencyDelta(address(this), c);
        if (d < 0) {
            // casting to 'uint256' is safe because d < 0 here
            // forge-lint: disable-next-line(unsafe-typecast)
            uint256 owed = uint256(-d);
            if (c.isAddressZero()) {
                pm.settle{value: owed}();
            } else {
                pm.sync(c);
                require(IERC20Like(Currency.unwrap(c)).transfer(address(pm), owed), "outsider: pay");
                pm.settle();
            }
        } else if (d > 0) {
            // forge-lint: disable-next-line(unsafe-typecast)
            pm.take(c, address(this), uint256(d));
        }
    }

    receive() external payable {}
}

/// @title AuditU3FableTipProbe
/// @notice TEST ONLY. A `deepen()` tip recipient whose `receive` runs inside the hook's own unlock (the tip is paid
/// last, by `PoolManager.take`): it tries `deepen` again, the receiver's `collect`, and a direct `PoolManager.swap`
/// of its own (settled by itself), and records what happened without reverting (P3.8, L3). Its ETH for the swap is
/// dealt by the test.
contract AuditU3FableTipProbe {
    using TransientStateLibrary for IPoolManager;

    IPoolManager public immutable pm;
    IBoxHook public immutable hook;
    IBoxReceiver public immutable receiver;
    PoolKey internal key;
    address internal immutable token;

    uint256 public tipsReceived;
    bytes4 public deepenSel;
    bytes4 public collectSel;
    bool public innerSwapOk;
    uint256 public innerSwapIn;
    bool public armed;

    constructor(IPoolManager pm_, IBoxHook hook_, IBoxReceiver receiver_, PoolKey memory key_) {
        pm = pm_;
        hook = hook_;
        receiver = receiver_;
        key = key_;
        token = Currency.unwrap(key_.currency1);
    }

    function arm(bool on) external {
        armed = on;
    }

    receive() external payable {
        tipsReceived += msg.value;
        if (!armed) return;
        deepenSel = _sel(address(hook), abi.encodeCall(IBoxHook.deepen, (address(this))));
        collectSel = _sel(address(receiver), abi.encodeCall(IBoxReceiver.collect, (address(this))));
        // A swap of our own while the PoolManager is unlocked by the hook: v4 lets any caller act inside an unlock.
        uint256 spend = 0.001 ether;
        if (address(this).balance < spend) return;
        try pm.swap(key, SwapParams(true, -int256(spend), TickMath.MIN_SQRT_PRICE + 1), "") returns (BalanceDelta d) {
            // forge-lint: disable-next-line(unsafe-typecast)
            uint256 owed = uint256(uint128(-d.amount0()));
            pm.settle{value: owed}();
            // forge-lint: disable-next-line(unsafe-typecast)
            pm.take(key.currency1, address(this), uint256(uint128(d.amount1())));
            innerSwapOk = true;
            innerSwapIn = owed;
        } catch {}
    }

    function _sel(address target, bytes memory call) private returns (bytes4 sel) {
        (bool ok, bytes memory ret) = target.call(call);
        if (ok) return bytes4(0);
        if (ret.length >= 4) sel = bytes4(ret);
        else sel = 0xffffffff;
    }
}

/// @title AuditU3FableBoundsHarness
/// @notice TEST ONLY. Exposes `BoxSwapBounds`' internal functions the hook's conversion uses (P3.14, P3.16).
contract AuditU3FableBoundsHarness {
    function stepLimit(bool buy, uint160 sqrtSpot, int24 refTick) external pure returns (uint160) {
        return BoxSwapBounds.stepLimit(buy, sqrtSpot, refTick);
    }

    function minOut(bool buy, uint256 amountIn, uint160 limit, uint24 fee) external pure returns (uint256) {
        return BoxSwapBounds.minOut(buy, amountIn, limit, fee);
    }

    function feeNote(uint256 amountIn, uint24 lpShare) external pure returns (uint256) {
        return BoxSwapBounds.feeNote(amountIn, lpShare);
    }

    function fees(Slot0 s0, bool zeroForOne) external pure returns (uint24, uint24) {
        return BoxSwapBounds.fees(s0, zeroForOne);
    }

    function buyInput(IPoolManager pm, bytes32 stateSlot, Slot0 s0, uint160 limit, uint24 swapFee)
        external
        view
        returns (uint256)
    {
        return BoxSwapBounds.buyInput(pm, stateSlot, s0, limit, swapFee);
    }
}

/// @title AuditU3FableBase
/// @notice TEST ONLY (SH-AUDIT-B0 U3, the Fable auditor). The shared base of the U3 Fable suites: the audit world
/// (`AuditPhases`, read-only) plus the hook-specific reads and drivers the suites share: the pool's slot0 through
/// `StateLibrary`, the hook's five positions, the curve's Q and T at the price, fills to a share of R, price pushes to
/// a tick through the Universal Router stand-in, the executor ring warmed to a ready 1-hour average, claim gifts, the
/// cap base `_coreQNear` recomputed independently of the hook, and v4's wrapped hook reverts.
abstract contract AuditU3FableBase is AuditPhases {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    bytes32 internal constant SALT_CURVE = bytes32(0);
    bytes32 internal constant SALT_L7 = bytes32(uint256(1));
    bytes32 internal constant SALT_RUNGS_NEVER_USED = bytes32(uint256(2));
    bytes32 internal constant SALT_PAIR = bytes32(uint256(3));
    int24 internal constant MIN_T = BoxSpecV1.MIN_USABLE_TICK;
    int24 internal constant MAX_T = BoxSpecV1.MAX_USABLE_TICK;
    uint256 internal constant Q96 = 1 << 96;

    AuditU3FableClaimsGift internal gift;
    AuditU3FableOutsider internal outsider;
    AuditU3FableBoundsHarness internal bounds;
    PoolId internal poolId;

    function setUp() public virtual override {
        super.setUp();
        poolId = poolKey.toId();
        gift = new AuditU3FableClaimsGift(pm);
        outsider = new AuditU3FableOutsider(pm);
        bounds = new AuditU3FableBoundsHarness();
        vm.label(address(gift), "u3.gift");
        vm.label(address(outsider), "u3.outsider");
        _ghostAddOutside(address(gift));
        _ghostAddOutside(address(outsider));
    }

    // ------------------------------------------------------------------------------------------------ pool reads

    function _sqrtP() internal view returns (uint160 s) {
        (s,,,) = pm.getSlot0(poolId);
    }

    /// @dev Slot0's tick: what the hook's `_priceGuards` and the executor's samples read. After a swap that ends
    /// exactly on an initialised tick moving down (the close at √P1), v4 sets it to that tick − 1 while the √price
    /// sits on the tick (Pool.swap: `tick = zeroForOne ? tickNext − 1 : tickNext`).
    function _tick() internal view returns (int24 t) {
        (, t,,) = pm.getSlot0(poolId);
    }

    /// @dev The tick of the √price itself (`TickMath.getTickAtSqrtPrice`): the reference for a push by k ticks, so a
    /// limit at tick + k is always strictly beyond spot (`_tick()` can be one below it, see there).
    function _spotTick() internal view returns (int24) {
        return TickMath.getTickAtSqrtPrice(_sqrtP());
    }

    function _slot0() internal view returns (Slot0) {
        return Slot0.wrap(pm.extsload(_stateSlot()));
    }

    function _stateSlot() internal view returns (bytes32) {
        return keccak256(abi.encodePacked(PoolId.unwrap(poolId), bytes32(uint256(6))));
    }

    function _posL(int24 lower, int24 upper, bytes32 salt) internal view returns (uint128 l) {
        (l,,) = pm.getPositionInfo(poolId, a.hook, lower, upper, salt);
    }

    /// @dev (curve, ask, bid, sentinel, pair) liquidity.
    function _positions() internal view returns (uint128[5] memory l) {
        l[0] = _posL(curve.tickLower, curve.tickUpper, SALT_CURVE);
        l[1] = _posL(MIN_T, curve.tickLower, SALT_L7);
        l[2] = _posL(curve.tickLower, MAX_T, SALT_L7);
        l[3] = _posL(curve.tickUpper, MAX_T, SALT_L7);
        l[4] = _posL(MIN_T, MAX_T, SALT_PAIR);
    }

    /// @dev The Q the curve holds at the price (between P1 and P0; R once fully crossed).
    function _curveQ() internal view returns (uint256) {
        uint160 s = _sqrtP();
        if (s >= curve.sqrtPriceUpperX96) return 0;
        if (s <= curve.sqrtPriceLowerX96) s = curve.sqrtPriceLowerX96;
        return SqrtPriceMath.getAmount0Delta(s, curve.sqrtPriceUpperX96, curve.liquidity, false);
    }

    /// @dev The T left on the curve between P1 and the price.
    function _curveTLeft() internal view returns (uint256) {
        uint160 s = _sqrtP();
        if (s <= curve.sqrtPriceLowerX96) return 0;
        if (s > curve.sqrtPriceUpperX96) s = curve.sqrtPriceUpperX96;
        return SqrtPriceMath.getAmount1Delta(curve.sqrtPriceLowerX96, s, curve.liquidity, false);
    }

    /// @dev One position's principal at the current price (what a full removal would pay), both sides.
    function _principal(int24 lower, int24 upper, uint128 l) internal view returns (uint256 q, uint256 t) {
        if (l == 0) return (0, 0);
        uint160 s = _sqrtP();
        uint160 lo = TickMath.getSqrtPriceAtTick(lower);
        uint160 hi = TickMath.getSqrtPriceAtTick(upper);
        if (s <= lo) {
            q = SqrtPriceMath.getAmount0Delta(lo, hi, l, false);
        } else if (s >= hi) {
            t = SqrtPriceMath.getAmount1Delta(lo, hi, l, false);
        } else {
            q = SqrtPriceMath.getAmount0Delta(s, hi, l, false);
            t = SqrtPriceMath.getAmount1Delta(lo, s, l, false);
        }
    }

    /// @dev The Q the hook's core positions (L7 and the pair) span over [tRef, tRef + 953] as if the price stood at
    /// tRef: the add cap's base, recomputed here from StateLibrary reads (BC-120; BoxHookExtension `_coreQNearPrice`).
    function _coreQNear(int24 tRef) internal view returns (uint256 q) {
        int24 bandHi = tRef + 953;
        if (bandHi > MAX_T) bandHi = MAX_T;
        if (tRef < MIN_T || tRef >= bandHi) return 0;
        uint160 lo = TickMath.getSqrtPriceAtTick(tRef);
        uint160 hi = TickMath.getSqrtPriceAtTick(bandHi);
        q += _q0In(MIN_T, curve.tickLower, SALT_L7, lo, hi);
        q += _q0In(curve.tickLower, MAX_T, SALT_L7, lo, hi);
        q += _q0In(curve.tickUpper, MAX_T, SALT_L7, lo, hi);
        q += _q0In(MIN_T, MAX_T, SALT_PAIR, lo, hi);
    }

    function _q0In(int24 lower, int24 upper, bytes32 salt, uint160 bLo, uint160 bHi) internal view returns (uint256) {
        uint128 l = _posL(lower, upper, salt);
        if (l == 0) return 0;
        uint160 lo = TickMath.getSqrtPriceAtTick(lower);
        uint160 hi = TickMath.getSqrtPriceAtTick(upper);
        if (lo < bLo) lo = bLo;
        if (hi > bHi) hi = bHi;
        if (lo >= hi) return 0;
        return SqrtPriceMath.getAmount0Delta(lo, hi, l, false);
    }

    /// @dev `t` valued in Q at √price `s`, rounded down (BoxHookExtension `_tInQ`).
    function _tInQ(uint256 t, uint160 s) internal pure returns (uint256) {
        return FullMath.mulDiv(FullMath.mulDiv(t, Q96, s), Q96, s);
    }

    /// @dev T worth `q` at √price `s`, rounded down.
    function _tForQ(uint256 q, uint160 s) internal pure returns (uint256) {
        return FullMath.mulDiv(FullMath.mulDiv(q, s, Q96), s, Q96);
    }

    function _tipOf(uint256 amount) internal pure returns (uint256) {
        uint256 tip = amount * 500 / 10_000;
        return tip < BoxSpecV1.FEE_BATCH_TIP_MAX_ETH ? tip : BoxSpecV1.FEE_BATCH_TIP_MAX_ETH;
    }

    function _absDiff(int24 x, int24 y) internal pure returns (int24) {
        return x > y ? x - y : y - x;
    }

    /// @dev The reference tick as the hook computes it after its own poke: the higher of the average and the sample.
    function _tRef() internal view returns (int24) {
        (, int24 avg,) = executor.twap();
        int24 sample = executor.latestSampleTick();
        return sample > avg ? sample : avg;
    }

    // ------------------------------------------------------------------------------------------------ drivers

    /// @dev Buys until the curve holds `fillPpm` millionths of R (nothing if it already holds more).
    function _fillTo(uint256 fillPpm) internal {
        uint256 target = raise * fillPpm / 1e6;
        uint256 held = _curveQ();
        if (target <= held) return;
        uint160 limit =
            SqrtPriceMath.getNextSqrtPriceFromInput(_sqrtP(), curve.liquidity, target - held, true);
        if (limit < curve.sqrtPriceLowerX96) limit = curve.sqrtPriceLowerX96;
        _buyTo(eoa[0], 2 * raise, limit);
    }

    /// @dev A buy by `who` that stops at `tick` (the rest refunded): the price moves down to it. Nothing if the
    /// tick's √price is not below spot (v4 would refuse the limit).
    function _pushDownTo(address who, int24 tick) internal {
        uint160 limit = TickMath.getSqrtPriceAtTick(tick);
        if (limit >= _sqrtP()) return;
        _buyTo(who, 200 ether, limit);
    }

    /// @dev A sell by `who` of all its T that stops at `tick`: the price moves up to it (or as far as its T goes).
    /// Nothing if the tick's √price is not above spot.
    function _pushUpTo(address who, int24 tick) internal {
        uint160 limit = TickMath.getSqrtPriceAtTick(tick);
        if (limit <= _sqrtP()) return;
        uint256 t = token.balanceOf(who);
        require(t != 0, "u3: the pusher holds no T");
        _swap(who, SwapParams({zeroForOne: false, amountSpecified: _amount(t, true), sqrtPriceLimitX96: limit}), 0);
    }

    /// @dev `blocks` blocks of 12 s, the executor ring poked on each (one sample a block, at most 100 ticks a sample).
    function _warmRing(uint256 blocks) internal {
        for (uint256 i; i < blocks; ++i) {
            _advance(1);
            executor.poke();
        }
    }

    /// @dev Pokes the ring block by block for at least `minBlocks` and until the hour average and the latest sample
    /// both sit within one tick of slot0's tick, at most 1,200 blocks. After a move of k ticks the sample needs k/100
    /// pokes and the average a window (3,600 s plus up to one checkpoint spacing of 515 s: about 345 blocks) of samples
    /// at the new price; with no move it returns after one block. `minBlocks` ≥ 300 also passes `deepen`'s cooldown.
    function _catchUp(uint256 minBlocks) internal {
        int24 spot = _tick();
        for (uint256 i; i < 1_200; ++i) {
            _advance(1);
            executor.poke();
            if (i + 1 < minBlocks) continue;
            (bool ready, int24 avg,) = executor.twap();
            if (ready && _absDiff(avg, spot) <= 1 && _absDiff(executor.latestSampleTick(), spot) <= 1) return;
        }
        revert("u3: the ring did not catch up in 1,200 blocks");
    }

    /// @dev T claims minted to the hook from `payer`'s T (booked as T into the system).
    function _giftT(address payer, uint256 amount) internal returns (uint256 paid) {
        uint256 t0 = token.balanceOf(payer);
        vm.prank(payer);
        require(token.transfer(address(gift), amount), "u3: T to the gift");
        paid = gift.giftT(a.token, a.hook, amount);
        _noteTChange(t0, token.balanceOf(payer), TIn.Direct, TOut.Other);
    }

    /// @dev Q claims minted to the hook by a stranger (booked as a depth gift).
    function _giftQ(address who, uint256 amount) internal returns (uint256 paid) {
        _fund(who, amount);
        uint256 e0 = who.balance;
        vm.prank(who);
        paid = gift.giftQ{value: amount}(a.hook);
        _noteEthChange(e0, who.balance, EthIn.FundDepth, EthOut.Other);
    }

    /// @dev A swap by `who` through the stand-in that must revert with `revertData` (nothing is booked: no state
    /// changes). `vm.expectRevert` ignores the cheatcode calls before the swap.
    function _swapExpect(address who, SwapParams memory p, uint256 ethValue, bytes memory revertData) internal {
        if (ethValue != 0) _fund(who, ethValue);
        if (!p.zeroForOne) {
            vm.prank(who);
            token.approve(address(routerSwapper), type(uint256).max);
        }
        vm.prank(who);
        vm.expectRevert(revertData);
        routerSwapper.swapOne{value: ethValue}(poolKey, p, "", who);
    }

    function _buyParams(uint256 q, uint160 limit) internal pure returns (SwapParams memory) {
        return SwapParams({zeroForOne: true, amountSpecified: _amount(q, true), sqrtPriceLimitX96: limit});
    }

    function _buyOutParams(uint256 t, uint160 limit) internal pure returns (SwapParams memory) {
        return SwapParams({zeroForOne: true, amountSpecified: _amount(t, false), sqrtPriceLimitX96: limit});
    }

    function _sellParams(uint256 t, uint160 limit) internal pure returns (SwapParams memory) {
        return SwapParams({zeroForOne: false, amountSpecified: _amount(t, true), sqrtPriceLimitX96: limit});
    }

    function _sellOutParams(uint256 q, uint160 limit) internal pure returns (SwapParams memory) {
        return SwapParams({zeroForOne: false, amountSpecified: _amount(q, false), sqrtPriceLimitX96: limit});
    }

    /// @dev The four swap shapes (exact-in buy, exact-out buy, exact-in sell, exact-out sell) by `who`, each expected
    /// to revert with the hook's `reason` in `beforeSwap`.
    function _everyShapeReverts(address who, bytes memory reason) internal {
        bytes memory data = _hookRevert(IHooks.beforeSwap.selector, reason);
        _swapExpect(who, _buyParams(0.01 ether, TickMath.MIN_SQRT_PRICE + 1), 0.01 ether, data);
        _swapExpect(who, _buyOutParams(1e18, TickMath.MIN_SQRT_PRICE + 1), 0.01 ether, data);
        _swapExpect(who, _sellParams(1e18, TickMath.MAX_SQRT_PRICE - 1), 0, data);
        _swapExpect(who, _sellOutParams(1, TickMath.MAX_SQRT_PRICE - 1), 0, data);
    }

    /// @dev One hook position's fees owed and not yet collected, from fee growth (what a poke would mint).
    function _uncollected(int24 lo, int24 hi, bytes32 salt) internal view returns (uint256 q, uint256 t) {
        (uint128 l, uint256 f0, uint256 f1) = pm.getPositionInfo(poolId, a.hook, lo, hi, salt);
        if (l == 0) return (0, 0);
        (uint256 g0, uint256 g1) = pm.getFeeGrowthInside(poolId, lo, hi);
        unchecked {
            q = (g0 - f0) * l / (1 << 128);
            t = (g1 - f1) * l / (1 << 128);
        }
    }

    function _allUncollected() internal view returns (uint256 q, uint256 t) {
        (uint256 a0, uint256 b0) = _uncollected(curve.tickLower, curve.tickUpper, SALT_CURVE);
        (uint256 a1, uint256 b1) = _uncollected(MIN_T, curve.tickLower, SALT_L7);
        (uint256 a2, uint256 b2) = _uncollected(curve.tickLower, MAX_T, SALT_L7);
        (uint256 a3, uint256 b3) = _uncollected(curve.tickUpper, MAX_T, SALT_L7);
        (uint256 a4, uint256 b4) = _uncollected(MIN_T, MAX_T, SALT_PAIR);
        q = a0 + a1 + a2 + a3 + a4;
        t = b0 + b1 + b2 + b3 + b4;
    }

    /// @dev The hook's own storage: slot 0 the state word, slot 1 reserveMinted.
    function _word() internal view returns (uint256) {
        return uint256(vm.load(a.hook, bytes32(0)));
    }

    function _hookClaims() internal view returns (uint256 q, uint256 t) {
        q = pm.balanceOf(a.hook, 0);
        t = pm.balanceOf(a.hook, uint256(uint160(a.token)));
    }

    /// @dev The hook holds nothing but claims, and its claims are its depth budget (P3.1; `IBoxHook.sol:89-91`).
    function _assertHookHoldsOnlyClaims() internal view {
        assertEq(a.hook.balance, 0, "P3.1: the hook holds no ETH");
        assertEq(token.balanceOf(a.hook), 0, "P3.1: the hook holds no T");
        (uint256 q, uint256 t) = _hookClaims();
        (uint256 qb, uint256 tb) = hook.depthBudget();
        assertEq(q, qb, "P3.1: Q claims == Q budget");
        assertEq(t, tb, "P3.1: T claims == T budget");
    }

    /// @dev Decodes one `DepthConverted` event from recorded logs (the last one emitted by the hook).
    function _lastConverted(VmSafe.Log[] memory logs)
        internal
        view
        returns (bool found, uint256 qIn, uint256 tOut, int24 tRef, uint160 before, uint160 after_, uint160 limit)
    {
        for (uint256 i = logs.length; i > 0; --i) {
            VmSafe.Log memory l = logs[i - 1];
            if (l.emitter == a.hook && l.topics[0] == IBoxHook.DepthConverted.selector) {
                (qIn, tOut, tRef, before, after_, limit) =
                    abi.decode(l.data, (uint256, uint256, int24, uint160, uint160, uint160));
                return (true, qIn, tOut, tRef, before, after_, limit);
            }
        }
    }

    function _countTopic(VmSafe.Log[] memory logs, address emitter, bytes32 topic) internal pure returns (uint256 n) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == emitter && logs[i].topics[0] == topic) ++n;
        }
    }

    /// @dev Σ of the receiver's `DepthFunded(q, t)` in `logs`: every depth part moved to the hook's claims (the held
    /// parts at the settlement, and each batch's part after graduation).
    function _depthFunded(VmSafe.Log[] memory logs) internal view returns (uint256 q, uint256 t) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == a.receiver && logs[i].topics[0] == keccak256("DepthFunded(uint256,uint256)")) {
                (uint256 dq, uint256 dt) = abi.decode(logs[i].data, (uint256, uint256));
                q += dq;
                t += dt;
            }
        }
    }

    /// @dev Σ of the hook's conversion notes the receiver returned (`ModuleFeesReturned`'s `hookQ`) in `logs`.
    function _hookBack(VmSafe.Log[] memory logs) internal view returns (uint256 back) {
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].emitter == a.receiver
                    && logs[i].topics[0] == keccak256("ModuleFeesReturned(uint256,uint256,uint256)")
            ) {
                (,, uint256 hb) = abi.decode(logs[i].data, (uint256, uint256, uint256));
                back += hb;
            }
        }
    }
}
