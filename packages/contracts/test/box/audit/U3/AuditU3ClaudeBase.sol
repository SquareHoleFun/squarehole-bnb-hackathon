// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {CustomRevert} from "v4-core/src/libraries/CustomRevert.sol";
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
import {BoxSwapBounds} from "../../../../src/box/libraries/BoxSwapBounds.sol";
import {IBoxHook, IBoxPriceAverage} from "../../../../src/box/interfaces/IBoxHook.sol";
import {AuditPhases} from "../common/AuditPhases.sol";

/// @title AuditU3ClaudeActor
/// @notice TEST ONLY (SH-AUDIT-B0-U3, Claude). A router-like account with code that does, inside ONE
/// `PoolManager.unlock`, what an outside contract can do to box 0's pool: any list of swaps (each optionally wrapped in
/// try/catch, so a refused second swap does not undo the first), an outside liquidity change, a donation, a call to any
/// contract from inside the unlock (a foreign unlock for `deepen`, `collect`, `graduate`), and ERC-6909 claims minted
/// from its own ETH or T to any recipient (a claim gift to the hook). Settlement: ETH owed is paid from this contract's
/// balance (`msg.value`; the rest stays here and goes back with `sweepTo`), T owed is pulled from `payer` (who approved
/// this contract), positive deltas are taken to `recipient`. A stand-in for the Universal Router and for any attacker
/// contract (the world's `AuditRouterSwapper` has no try/catch and no other actions).
contract AuditU3ClaudeActor is IUnlockCallback {
    using TransientStateLibrary for IPoolManager;
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    enum Mode {
        Swaps,
        Modify,
        Donate,
        Call,
        MintClaims,
        SwapsTraced
    }

    struct Leg {
        SwapParams params;
        bool tryCatch;
    }

    /// @notice One leg of a traced unlock: whether it passed; if not, whether the hook refused it (v4's WrappedError)
    /// and the reason's selector; right after it, the pool's √price and the hook's `closedAtBlock`.
    struct Trace {
        bool ok;
        bool byHook;
        bytes4 reason;
        uint160 sqrtAfter;
        uint256 closedAt;
    }

    IPoolManager public immutable pm;
    address private _payer;
    address private _recipient;

    error OnlyPoolManager(address caller);
    error PullFailed(uint256 amount);

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    /// @notice The legs in order inside one unlock; returns which succeeded and their deltas, and the revert data of
    /// the first caught failure.
    function swaps(PoolKey memory key, Leg[] memory legs, address payer, address recipient)
        external
        payable
        returns (bool[] memory ok, BalanceDelta[] memory deltas, bytes memory firstError)
    {
        (_payer, _recipient) = (payer, recipient);
        (ok, deltas, firstError) =
            abi.decode(pm.unlock(abi.encode(Mode.Swaps, abi.encode(key, legs))), (bool[], BalanceDelta[], bytes));
        (_payer, _recipient) = (address(0), address(0));
    }

    /// @notice The legs in order inside one unlock, each traced (`Trace`); a leg without try/catch that fails reverts
    /// the whole unlock with its own revert data.
    function swapsTraced(PoolKey memory key, Leg[] memory legs, address payer, address recipient)
        external
        payable
        returns (Trace[] memory traces)
    {
        (_payer, _recipient) = (payer, recipient);
        traces = abi.decode(pm.unlock(abi.encode(Mode.SwapsTraced, abi.encode(key, legs))), (Trace[]));
        (_payer, _recipient) = (address(0), address(0));
    }

    /// @notice An outside `modifyLiquidity` (any delta, any salt) inside its own unlock.
    function modify(PoolKey memory key, ModifyLiquidityParams memory p, address payer) external payable {
        _payer = payer;
        _recipient = payer;
        pm.unlock(abi.encode(Mode.Modify, abi.encode(key, p)));
        (_payer, _recipient) = (address(0), address(0));
    }

    /// @notice An outside `donate` inside its own unlock.
    function donate(PoolKey memory key, uint256 a0, uint256 a1, address payer) external payable {
        _payer = payer;
        pm.unlock(abi.encode(Mode.Donate, abi.encode(key, a0, a1)));
        _payer = address(0);
    }

    /// @notice A call to `target` from inside this contract's unlock (the PoolManager is unlocked while it runs).
    function callInside(address target, bytes memory data) external returns (bool success, bytes memory ret) {
        (success, ret) = abi.decode(pm.unlock(abi.encode(Mode.Call, abi.encode(target, data))), (bool, bytes));
    }

    /// @notice ERC-6909 claims of `currency` minted to `recipient`: ETH from `msg.value`, T pulled from `payer`.
    function mintClaims(Currency currency, uint256 amount, address payer, address recipient) external payable {
        _payer = payer;
        pm.unlock(abi.encode(Mode.MintClaims, abi.encode(currency, amount, recipient)));
        _payer = address(0);
    }

    /// @notice Sends this contract's ETH to `to` (what a router's SWEEP does).
    function sweepTo(address to) external {
        uint256 b = address(this).balance;
        if (b != 0) {
            (bool ok,) = to.call{value: b}("");
            require(ok, "AuditU3ClaudeActor: sweep");
        }
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(pm)) revert OnlyPoolManager(msg.sender);
        (Mode mode, bytes memory arg) = abi.decode(data, (Mode, bytes));
        if (mode == Mode.Swaps) return _swaps(arg);
        if (mode == Mode.SwapsTraced) return _swapsTraced(arg);
        if (mode == Mode.Modify) {
            (PoolKey memory key, ModifyLiquidityParams memory p) = abi.decode(arg, (PoolKey, ModifyLiquidityParams));
            pm.modifyLiquidity(key, p, "");
            _resolve(key.currency0);
            _resolve(key.currency1);
            return "";
        }
        if (mode == Mode.Donate) {
            (PoolKey memory key, uint256 a0, uint256 a1) = abi.decode(arg, (PoolKey, uint256, uint256));
            pm.donate(key, a0, a1, "");
            _resolve(key.currency0);
            _resolve(key.currency1);
            return "";
        }
        if (mode == Mode.Call) {
            (address target, bytes memory callData) = abi.decode(arg, (address, bytes));
            (bool success, bytes memory ret) = target.call(callData);
            return abi.encode(success, ret);
        }
        (Currency c, uint256 amount, address recipient) = abi.decode(arg, (Currency, uint256, address));
        pm.mint(recipient, uint256(uint160(Currency.unwrap(c))), amount);
        _resolve(c);
        return "";
    }

    function _swaps(bytes memory arg) private returns (bytes memory) {
        (PoolKey memory key, Leg[] memory legs) = abi.decode(arg, (PoolKey, Leg[]));
        bool[] memory ok = new bool[](legs.length);
        BalanceDelta[] memory deltas = new BalanceDelta[](legs.length);
        bytes memory firstError;
        for (uint256 i; i < legs.length; ++i) {
            if (legs[i].tryCatch) {
                try pm.swap(key, legs[i].params, "") returns (BalanceDelta d) {
                    (ok[i], deltas[i]) = (true, d);
                } catch (bytes memory err) {
                    if (firstError.length == 0) firstError = err;
                }
            } else {
                deltas[i] = pm.swap(key, legs[i].params, "");
                ok[i] = true;
            }
        }
        _resolve(key.currency0);
        _resolve(key.currency1);
        return abi.encode(ok, deltas, firstError);
    }

    function _swapsTraced(bytes memory arg) private returns (bytes memory) {
        (PoolKey memory key, Leg[] memory legs) = abi.decode(arg, (PoolKey, Leg[]));
        Trace[] memory traces = new Trace[](legs.length);
        for (uint256 i; i < legs.length; ++i) {
            if (legs[i].tryCatch) {
                try pm.swap(key, legs[i].params, "") {
                    traces[i].ok = true;
                } catch (bytes memory err) {
                    (traces[i].byHook, traces[i].reason) = reasonOf(err);
                }
            } else {
                pm.swap(key, legs[i].params, "");
                traces[i].ok = true;
            }
            (traces[i].sqrtAfter,,,) = pm.getSlot0(key.toId());
            traces[i].closedAt = IBoxHook(address(key.hooks)).closedAtBlock();
        }
        _resolve(key.currency0);
        _resolve(key.currency1);
        return abi.encode(traces);
    }

    /// @notice A revert's reason: inside v4's `WrappedError(target, selector, reason, details)` (a hook's revert) the
    /// inner reason's selector, else the revert's own selector.
    function reasonOf(bytes memory err) public pure returns (bool byHook, bytes4 reason) {
        if (err.length < 4) return (false, bytes4(0));
        bytes4 sel;
        assembly ("memory-safe") {
            sel := mload(add(err, 0x20))
        }
        if (sel != CustomRevert.WrappedError.selector) return (false, sel);
        bytes memory body = new bytes(err.length - 4);
        for (uint256 i; i < body.length; ++i) {
            body[i] = err[i + 4];
        }
        (,, bytes memory inner,) = abi.decode(body, (address, bytes4, bytes, bytes));
        if (inner.length < 4) return (true, bytes4(0));
        assembly ("memory-safe") {
            reason := mload(add(inner, 0x20))
        }
        byHook = true;
    }

    function _resolve(Currency c) private {
        int256 d = pm.currencyDelta(address(this), c);
        if (d < 0) {
            // casting to 'uint256' is safe because d < 0 here
            // forge-lint: disable-next-line(unsafe-typecast)
            uint256 owed = uint256(-d);
            if (c.isAddressZero()) {
                pm.settle{value: owed}();
            } else {
                pm.sync(c);
                (bool ok, bytes memory ret) =
                    Currency.unwrap(c).call(abi.encodeWithSelector(0x23b872dd, _payer, address(pm), owed));
                if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert PullFailed(owed);
                pm.settle();
            }
        } else if (d > 0) {
            // casting to 'uint256' is safe because d > 0 here
            // forge-lint: disable-next-line(unsafe-typecast)
            pm.take(c, _recipient, uint256(d));
        }
    }

    receive() external payable {}
}

/// @title AuditU3ClaudeTipTaker
/// @notice TEST ONLY (SH-AUDIT-B0-U3, Claude). A `deepen()` tip recipient with code, a stand-in for any contract a
/// caller names as `tipTo`. Armed, on the tip's receipt (inside the hook's own unlock: the tip is the call's last step,
/// `BoxHookExtension.sol:481-492`) it tries, in order, a second `deepen`, the receiver's `collect`, the hook's
/// `harvest`, a nested `unlock`, and a sale of `sellT` T in box 0's pool through the PoolManager the hook unlocked,
/// settling its own deltas itself (`take` pays it the Q, which re-enters `receive` disarmed); each outcome is recorded.
contract AuditU3ClaudeTipTaker {
    IPoolManager public immutable pm;
    address public immutable hook;
    address public immutable receiver;
    PoolKey internal _key;
    bool public armed;
    uint256 public sellT;
    uint256 public tipReceived;
    uint256 public qFromSale;
    bool public deepenOk;
    bool public collectOk;
    bool public harvestOk;
    bool public unlockOk;
    bool public swapOk;
    bytes4 public deepenReason;
    bytes4 public collectReason;
    bytes4 public harvestReason;
    bytes4 public unlockReason;
    bytes4 public swapReason;

    constructor(IPoolManager pm_, address hook_, address receiver_, PoolKey memory key_) {
        pm = pm_;
        hook = hook_;
        receiver = receiver_;
        _key = key_;
    }

    /// @notice Re-enter on the next ETH receipt, selling `sellT_` T inside the unlock (0: no sale).
    function arm(uint256 sellT_) external {
        armed = true;
        sellT = sellT_;
    }

    /// @notice Stand down (a deepen that skipped paid no tip).
    function disarm() external {
        armed = false;
    }

    receive() external payable {
        if (!armed) return;
        armed = false;
        tipReceived = msg.value;
        (deepenOk, deepenReason) = _try(hook, abi.encodeWithSignature("deepen(address)", address(this)));
        (collectOk, collectReason) = _try(receiver, abi.encodeWithSignature("collect(address)", address(this)));
        (harvestOk, harvestReason) = _try(hook, abi.encodeWithSignature("harvest()"));
        (unlockOk, unlockReason) = _try(address(pm), abi.encodeCall(IPoolManager.unlock, (bytes(""))));
        if (sellT != 0) _sell();
    }

    function _sell() private {
        // casting to 'int256' is safe because sellT is a T amount far below 2^255
        // forge-lint: disable-next-line(unsafe-typecast)
        SwapParams memory p = SwapParams(false, -int256(sellT), TickMath.MAX_SQRT_PRICE - 1);
        try pm.swap(_key, p, "") returns (BalanceDelta d) {
            swapOk = true;
            // casting to 'uint256' is safe because a sale's T side is negative and its Q side positive
            // forge-lint: disable-next-line(unsafe-typecast)
            uint256 owedT = uint256(uint128(-d.amount1()));
            // forge-lint: disable-next-line(unsafe-typecast)
            uint256 outQ = uint256(uint128(d.amount0()));
            pm.sync(_key.currency1);
            (bool ok,) = Currency.unwrap(_key.currency1)
                .call(abi.encodeWithSignature("transfer(address,uint256)", address(pm), owedT));
            require(ok, "AuditU3ClaudeTipTaker: T to the PoolManager");
            pm.settle();
            pm.take(_key.currency0, address(this), outQ);
            qFromSale = outQ;
        } catch (bytes memory err) {
            swapReason = err.length >= 4 ? bytes4(err) : bytes4(0);
        }
    }

    function _try(address target, bytes memory data) private returns (bool ok, bytes4 reason) {
        bytes memory ret;
        (ok, ret) = target.call(data);
        if (!ok && ret.length >= 4) reason = bytes4(ret);
    }
}

/// @title AuditU3ClaudeBoundsHarness
/// @notice TEST ONLY. BoxSwapBounds' internal functions, compiled here as the hook compiles them, read against the real
/// PoolManager (the library is the one engine `deepen()`'s conversion uses).
contract AuditU3ClaudeBoundsHarness {
    function buyInput(IPoolManager pm, bytes32 stateSlot, uint160 limit, uint24 swapFee)
        external
        view
        returns (uint256)
    {
        return BoxSwapBounds.buyInput(pm, stateSlot, Slot0.wrap(pm.extsload(stateSlot)), limit, swapFee);
    }

    function sellInput(IPoolManager pm, bytes32 stateSlot, uint160 limit, uint24 swapFee)
        external
        view
        returns (uint256)
    {
        return BoxSwapBounds.sellInput(pm, stateSlot, Slot0.wrap(pm.extsload(stateSlot)), limit, swapFee);
    }

    function stepLimit(bool buy, uint160 sqrtSpot, int24 refTick) external pure returns (uint160) {
        return BoxSwapBounds.stepLimit(buy, sqrtSpot, refTick);
    }

    function minOut(bool buy, uint256 amountIn, uint160 limit, uint24 swapFee) external pure returns (uint256) {
        return BoxSwapBounds.minOut(buy, amountIn, limit, swapFee);
    }

    function fees(IPoolManager pm, bytes32 stateSlot, bool zeroForOne)
        external
        view
        returns (uint24 swapFee, uint24 lpShare)
    {
        return BoxSwapBounds.fees(Slot0.wrap(pm.extsload(stateSlot)), zeroForOne);
    }

    function feeNote(uint256 amountIn, uint24 lpShare) external pure returns (uint256) {
        return BoxSwapBounds.feeNote(amountIn, lpShare);
    }

    function readAverage(IBoxPriceAverage avg) external returns (bool ready, int24 twapTick, int24 sampleTick) {
        return BoxSwapBounds.readAverage(avg);
    }
}

/// @title AuditU3ClaudeBase
/// @notice TEST ONLY (SH-AUDIT-B0-U3, Claude). The shared world (`AuditPhases`: the factory's box 0 on the mainnet
/// build, the real FitBuybackExecutor as the price average) plus U3's reads: the pool's state through v4's own
/// StateLibrary (never the hook's `extsload` code, so a test compares the two), the hook's positions by key, its
/// claims, the executor's average as `deepen()` will see it, and price landings after graduation.
abstract contract AuditU3ClaudeBase is AuditPhases {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    bytes32 internal constant SALT_CURVE = bytes32(0);
    bytes32 internal constant SALT_L7 = bytes32(uint256(1));
    bytes32 internal constant SALT_PAIR = bytes32(uint256(3));
    int24 internal constant MIN_T = BoxSpecV1.MIN_USABLE_TICK;
    int24 internal constant MAX_T = BoxSpecV1.MAX_USABLE_TICK;

    AuditU3ClaudeActor internal u3actor;
    AuditU3ClaudeBoundsHarness internal bounds;
    /// @notice A T holder (outside the box) used to move the price after graduation.
    address internal whale;

    function setUp() public virtual override {
        super.setUp();
        u3actor = new AuditU3ClaudeActor(pm);
        bounds = new AuditU3ClaudeBoundsHarness();
        whale = makeAddr("audit.u3.whale");
        vm.label(address(u3actor), "audit.u3.actor");
        vm.label(whale, "audit.u3.whale");
        // Outside holders of the ghost ledger (they may hold T or ETH between calls).
        _ghostAddOutside(whale);
        _ghostAddOutside(address(u3actor));
    }

    // ------------------------------------------------------------------------------------------------ pool reads

    function _id() internal view returns (PoolId) {
        return poolKey.toId();
    }

    function _stateSlot() internal view returns (bytes32) {
        return StateLibrary._getPoolStateSlot(poolKey.toId());
    }

    function _sqrtP() internal view returns (uint160 s) {
        (s,,,) = pm.getSlot0(poolKey.toId());
    }

    function _tickNow() internal view returns (int24 t) {
        (, t,,) = pm.getSlot0(poolKey.toId());
    }

    function _activeL() internal view returns (uint128) {
        return pm.getLiquidity(poolKey.toId());
    }

    /// @notice The hook's position liquidity by v4's own key (Position.calculatePositionKey) and StateLibrary.
    function _posL(int24 lower, int24 upper, bytes32 salt) internal view returns (uint128) {
        bytes32 key = keccak256(abi.encodePacked(a.hook, lower, upper, salt));
        return pm.getPositionLiquidity(poolKey.toId(), key);
    }

    function _curveL() internal view returns (uint128) {
        return _posL(curve.tickLower, curve.tickUpper, SALT_CURVE);
    }

    function _askL() internal view returns (uint128) {
        return _posL(MIN_T, curve.tickLower, SALT_L7);
    }

    function _bidL() internal view returns (uint128) {
        return _posL(curve.tickLower, MAX_T, SALT_L7);
    }

    function _sentinelL() internal view returns (uint128) {
        return _posL(curve.tickUpper, MAX_T, SALT_L7);
    }

    function _pairL() internal view returns (uint128) {
        return _posL(MIN_T, MAX_T, SALT_PAIR);
    }

    /// @notice The fees v4 owes the hook's position (`Position.update`: (feeGrowthInside − last) × L / 2^128, floored),
    /// read through StateLibrary: what a zero-liquidity poke of it would collect now.
    function _owed(int24 lower, int24 upper, bytes32 salt) internal view returns (uint256 q, uint256 t) {
        (uint128 l, uint256 last0, uint256 last1) = pm.getPositionInfo(poolKey.toId(), a.hook, lower, upper, salt);
        if (l == 0) return (0, 0);
        (uint256 in0, uint256 in1) = pm.getFeeGrowthInside(poolKey.toId(), lower, upper);
        unchecked {
            q = FullMath.mulDiv(in0 - last0, l, 1 << 128);
            t = FullMath.mulDiv(in1 - last1, l, 1 << 128);
        }
    }

    /// @notice Σ `_owed` over every position the hook has: the curve before the migration, then ask, bid, sentinel and
    /// the pair.
    function _owedAll() internal view returns (uint256 q, uint256 t) {
        uint256 fq;
        uint256 ft;
        (q, t) = _owed(curve.tickLower, curve.tickUpper, SALT_CURVE);
        (fq, ft) = _owed(MIN_T, curve.tickLower, SALT_L7);
        (q, t) = (q + fq, t + ft);
        (fq, ft) = _owed(curve.tickLower, MAX_T, SALT_L7);
        (q, t) = (q + fq, t + ft);
        (fq, ft) = _owed(curve.tickUpper, MAX_T, SALT_L7);
        (q, t) = (q + fq, t + ft);
        (fq, ft) = _owed(MIN_T, MAX_T, SALT_PAIR);
        (q, t) = (q + fq, t + ft);
    }

    /// @notice The hook's ERC-6909 claims of Q (ETH, id 0) and T.
    function _hookClaims() internal view returns (uint256 q, uint256 t) {
        q = pm.balanceOf(a.hook, 0);
        t = pm.balanceOf(a.hook, uint256(uint160(a.token)));
    }

    // ------------------------------------------------------------------------------------------------ the average

    /// @notice The executor's 1-hour average and its latest sample as they read now.
    function _avgNow() internal view returns (bool ready, int24 avg, int24 sample) {
        (ready, avg,) = executor.twap();
        sample = executor.latestSampleTick();
    }

    /// @notice The sample `deepen()`'s own poke leaves in this block: unchanged if the executor sampled at this
    /// timestamp already or the pool has no active liquidity, else the spot tick clamped to ±100 of the last sample
    /// (FitBuybackExecutor._observe).
    function _sampleAfterPoke() internal view returns (int24) {
        int24 last = executor.latestSampleTick();
        if (uint256(executor.oracle().time) == vm.getBlockTimestamp() || _activeL() == 0) return last;
        int24 spot = _tickNow();
        int24 lo = last - BoxSpecV1.EXECUTOR_MAX_OBSERVATION_STEP;
        int24 hi = last + BoxSpecV1.EXECUTOR_MAX_OBSERVATION_STEP;
        return spot < lo ? lo : (spot > hi ? hi : spot);
    }

    // ------------------------------------------------------------------------------------------------ moving the price

    /// @notice Gives `who` T bought from the pool (after graduation): an exact-input buy of `eth` at any price.
    function _buyT(address who, uint256 eth) internal returns (uint256 t) {
        t = _buy(who, eth);
    }

    /// @notice Moves the pool's price to exactly `target` (after graduation): a buy when the target is below spot, a
    /// sell by `whale` (which must hold enough T) when above. The world books both on the ghost ledger.
    function _land(uint160 target) internal {
        uint160 s = _sqrtP();
        if (target == s) return;
        if (target < s) {
            _buyTo(whale, 1_000 ether, target);
        } else {
            uint256 tIn = token.balanceOf(whale);
            require(tIn != 0, "AuditU3ClaudeBase: the whale holds no T");
            _swap(
                whale,
                SwapParams({zeroForOne: false, amountSpecified: _amount(tIn, true), sqrtPriceLimitX96: target}),
                0
            );
        }
        require(_sqrtP() == target, "AuditU3ClaudeBase: landed exactly");
    }

    /// @notice Moves the price by `ticks` (positive: up, a sell of T; negative: down, a buy) from spot, to the exact
    /// √price of spot's tick plus `ticks` (so a landing on a tick boundary from either side can be chosen by the
    /// caller).
    function _push(int24 ticks) internal {
        int24 t = _tickNow() + ticks;
        _land(TickMath.getSqrtPriceAtTick(t));
    }

    /// @notice √price of `tick`.
    function _sqrtAt(int24 tick) internal pure returns (uint160) {
        return TickMath.getSqrtPriceAtTick(tick);
    }

    /// @notice Q (token0) a range of `l` holds between √prices `lo` and `hi` (rounded down).
    function _q0(uint160 lo, uint160 hi, uint128 l) internal pure returns (uint256) {
        if (lo >= hi || l == 0) return 0;
        return SqrtPriceMath.getAmount0Delta(lo, hi, l, false);
    }

    function _abs(int256 x) internal pure returns (uint256) {
        // casting to 'uint256' is safe because the value is non-negative on both branches
        // forge-lint: disable-next-line(unsafe-typecast)
        return x >= 0 ? uint256(x) : uint256(-x);
    }

    /// @notice An actor whose `swaps` legs are built from parameters (exact input when `amount < 0`).
    function _leg(bool zeroForOne, int256 amount, uint160 limit, bool tryCatch)
        internal
        pure
        returns (AuditU3ClaudeActor.Leg memory)
    {
        return AuditU3ClaudeActor.Leg({
            params: SwapParams({zeroForOne: zeroForOne, amountSpecified: amount, sqrtPriceLimitX96: limit}),
            tryCatch: tryCatch
        });
    }

    /// @notice The unwrapped hook-revert selector inside the PoolManager's WrappedError (0 if not a hook revert).
    function _hookReason(bytes memory err) internal pure returns (bytes4 reason) {
        // WrappedError(address target, bytes4 selector, bytes reason, bytes details)
        if (err.length < 4) return bytes4(0);
        bytes4 sel;
        assembly ("memory-safe") {
            sel := mload(add(err, 0x20))
        }
        if (sel != CustomRevert.WrappedError.selector) return bytes4(0);
        bytes memory body = new bytes(err.length - 4);
        for (uint256 i; i < body.length; ++i) {
            body[i] = err[i + 4];
        }
        (,, bytes memory inner,) = abi.decode(body, (address, bytes4, bytes, bytes));
        if (inner.length < 4) return bytes4(0);
        assembly ("memory-safe") {
            reason := mload(add(inner, 0x20))
        }
    }

    /// @notice The unit's own reference to the PoolManager as an IHooks-free key (for a second pool's key).
    function _keyWith(uint24 fee, int24 spacing, address hooks_) internal view returns (PoolKey memory k) {
        k = PoolKey({
            currency0: poolKey.currency0,
            currency1: poolKey.currency1,
            fee: fee,
            tickSpacing: spacing,
            hooks: IHooks(hooks_)
        });
    }
}
