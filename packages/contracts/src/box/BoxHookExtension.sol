// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Uniswap v4-core @ 46c68346 and v4-periphery @ 9969eec, MIT files only (interfaces, types, libraries; DEPENDENCIES.md).
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {SqrtPriceMath} from "v4-core/src/libraries/SqrtPriceMath.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {Slot0} from "v4-core/src/types/Slot0.sol";
import {LiquidityAmounts} from "v4-periphery/src/libraries/LiquidityAmounts.sol";
import {BoxLayoutV1} from "./BoxLayoutV1.sol";
import {BoxSpecV1} from "./BoxSpecV1.sol";
import {IBoxHook, IBoxPriceAverage} from "./interfaces/IBoxHook.sol";
import {IBoxReceiver} from "./interfaces/IBoxReceiver.sol";
import {DeepenSkip, DepthKind} from "./interfaces/BoxTypes.sol";
import {BoxHookBase} from "./BoxHookBase.sol";
import {BoxSwapBounds} from "./libraries/BoxSwapBounds.sol";

/// @title BoxHookExtension (slices S4 and S5; the cold half of the box hook)
/// @notice `launch`, `migrate` and `deepen` of `IBoxHook` (see there for the behaviour), and the unlock steps they
/// open. `BoxHook` forwards these three entry points, and its own unlock callbacks for them, here by DELEGATECALL to a
/// fixed address (an immutable of `BoxHook`'s code, the same for every box of the version): the code runs in the box's
/// hook clone, with its address, storage and code arguments. Split off only for EIP-170 (`BoxHookBase` notes). Copies
/// and generalises FitPoolHook (src/v2/FitPoolHook.sol:285-485): the launch (`:285-301`, `:362-381`), the migration
/// (`:323-349`, `:384-457`: removal, walk to P1; L7 replaces b′), and adds pair and lock (F72 (B);
/// dynamic-pool-share.md §§ 1.3-1.4) for every box: since F77 box 0 too, so box 0's ETH-only depth ladder (§ 1.2) and
/// its rung code are gone and no depth step branches on the box kind. S5.M5 (R F76; docs/design/swap-module-v1.md § 8,
/// as revised in § 15 finding 2; every box since F77, box0-like-others.md § 5.3) adds the depth conversion: Q that
/// cannot be paired buys T in small capped steps inside the swap module's bounds (`BoxSwapBounds`, compiled in, the
/// one engine reviewed once), the T waits as the hook's claims, and the pair follows in the same unlock once both sides
/// reach MIN_ADD.
/// @dev Called directly (not through a delegatecall) every entry point reverts (`NotDelegated`), and the
/// extension's own storage is never initialised, so it can do nothing for anyone. No owner, admin, pause, upgrade,
/// setter or rescue (F23 C2).
contract BoxHookExtension is BoxHookBase {
    /// @notice A direct call to the extension (it runs only inside a box's hook clone).
    error NotDelegated();

    /// @dev This contract's own address: a delegatecall frame has the clone's.
    address internal immutable _self;

    constructor(IPoolManager poolManager_) BoxHookBase(poolManager_) {
        _self = address(this);
    }

    /// @notice IBoxHook.launch, reached through BoxHook.
    function launch() external {
        _onlyDelegated();
        uint256 w = _initialised();
        if (msg.sender != _argAddress(_A_COORDINATOR)) revert IBoxHook.NotCoordinator(msg.sender);
        if (w & _B_LAUNCHED != 0) revert IBoxHook.AlreadyLaunched();
        Args memory a = _args();
        uint128 liquidity = _argUint128(_A_LIQUIDITY);
        _checkCurve(a, liquidity);
        _w = w | _B_LAUNCHED;
        PoolKey memory key = _key(a);
        // Self-initiated: v4 skips this hook's beforeInitialize (Hooks.noSelfCall), so this is the only initialiser.
        _pm.initialize(key, a.sqrtP0);
        uint256 deposited = abi.decode(_pm.unlock(abi.encode(_ACT_LAUNCH, abi.encode(liquidity))), (uint256));
        emit IBoxHook.PoolLaunched(key.toId(), a.tickLower, a.tickUpper, liquidity, a.sqrtP0, deposited);
    }

    /// @notice IBoxHook.migrate, reached through BoxHook.
    function migrate(uint256 tokenBudget)
        external
        returns (uint256 qFromCurve, uint256 tFromCurve, uint256 tokenPulled, uint256 qDust)
    {
        _onlyDelegated();
        uint256 w = _initialised();
        if (msg.sender != _argAddress(_A_COORDINATOR)) revert IBoxHook.NotCoordinator(msg.sender);
        if ((w >> _O_MIGRATED) & _M40 != 0) revert IBoxHook.AlreadyMigrated();
        if ((w >> _O_CLOSED) & _M40 == 0) revert IBoxHook.NotClosed();
        // Written before the unlock: every swap callback reads it.
        _w = w | (block.number << _O_MIGRATED);
        Migration memory m = abi.decode(_pm.unlock(abi.encode(_ACT_MIGRATE, abi.encode(tokenBudget))), (Migration));
        emit IBoxHook.Migrated(
            _typedPoolId(),
            m.qFromCurve,
            m.tFromCurve,
            m.askLiquidity,
            m.bidLiquidity,
            m.sentinelLiquidity,
            m.tokenPulled,
            m.qDust
        );
        return (m.qFromCurve, m.tFromCurve, m.tokenPulled, m.qDust);
    }

    /// @notice IBoxHook.deepen, reached through BoxHook.
    function deepen(address tipTo)
        external
        returns (DepthKind kind_, DeepenSkip skip, uint256 qUsed, uint256 tUsed, uint256 tip)
    {
        _onlyDelegated();
        uint256 w = _initialised();
        _noForeignUnlock();
        DeepenPlan memory p;
        (p, skip) = _planDeepen(w);
        if (skip != DeepenSkip.None) {
            emit IBoxHook.DeepenSkipped(_typedPoolId(), skip);
            return (DepthKind.None, skip, 0, 0, 0);
        }
        p.tipTo = tipTo;
        // Cooldown (and one add or conversion per block) recorded before the unlock.
        _w = (w & ~(_M40 << _O_DEEPEN)) | (block.number << _O_DEEPEN);
        uint128 liquidity;
        (kind_, qUsed, tUsed, tip, liquidity) = abi.decode(
            _pm.unlock(abi.encode(_ACT_DEEPEN, abi.encode(p))), (DepthKind, uint256, uint256, uint256, uint128)
        );
        bool pair = kind_ == DepthKind.Pair;
        emit IBoxHook.Deepened(
            _typedPoolId(),
            kind_,
            pair ? BoxSpecV1.MIN_USABLE_TICK : int24(0),
            pair ? BoxSpecV1.MAX_USABLE_TICK : int24(0),
            liquidity,
            qUsed,
            tUsed,
            tip
        );
    }

    /// @notice The unlock steps of the three entry points above (BoxHook forwards its callback here for them).
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        _onlyDelegated();
        if (msg.sender != address(_pm)) revert IBoxHook.NotPoolManager();
        (uint8 action, bytes memory arg) = abi.decode(data, (uint8, bytes));
        Args memory a = _args();
        PoolKey memory key = _key(a);
        if (action == _ACT_DEEPEN) return _deepenStep(a, key, abi.decode(arg, (DeepenPlan)));
        if (action == _ACT_MIGRATE) return abi.encode(_migrate(a, key, abi.decode(arg, (uint256))));
        return abi.encode(_seedCurve(a, key, abi.decode(arg, (uint128))));
    }

    function _onlyDelegated() private view {
        if (address(this) == _self) revert NotDelegated();
    }

    function _typedPoolId() private view returns (PoolId) {
        (address q_, address t_) = _argAddress2(_A_Q);
        return PoolId.wrap(_poolIdOf(q_, t_));
    }

    /// @dev `launch`'s unlock: the curve position, its T pulled from the coordinator (FitPoolHook.sol:362-381).
    function _seedCurve(Args memory a, PoolKey memory key, uint128 liquidity) private returns (uint256 owed) {
        (BalanceDelta delta,) = _pm.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: a.tickLower,
                tickUpper: a.tickUpper,
                liquidityDelta: int256(uint256(liquidity)),
                salt: _SALT_CURVE
            }),
            ""
        );
        // Single-sided T only: the launch never asks anyone for Q.
        if (delta.amount0() != 0 || delta.amount1() >= 0) revert InvalidCurve();
        // casting to 'uint128' is safe because amount1 < 0 was checked above
        // forge-lint: disable-next-line(unsafe-typecast)
        owed = uint256(uint128(-delta.amount1()));
        _pullToken(a.token, owed);
    }

    /// @dev `migrate`'s unlock: the curve's last fees (reserve first), its removal, the walk to P1, then L7.
    function _migrate(Args memory a, PoolKey memory key, uint256 tokenBudget) private returns (Migration memory m) {
        (uint256 fq, uint256 ft) = _poke(key, a.tickLower, a.tickUpper, _SALT_CURVE);
        _distribute(a, fq, ft, true);
        // M1: the whole curve out; its fees were just poked, so the delta is principal only (FitPoolHook.sol:392-416).
        bytes32 id = _poolIdOf(a.q, a.token);
        uint128 curveLiquidity = _argUint128(_A_LIQUIDITY);
        (BalanceDelta out,) = _pm.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: a.tickLower,
                tickUpper: a.tickUpper,
                liquidityDelta: -int256(uint256(curveLiquidity)),
                salt: _SALT_CURVE
            }),
            ""
        );
        // casting to 'uint128' is safe because a removal's amounts are never negative
        // forge-lint: disable-next-line(unsafe-typecast)
        m.qFromCurve = uint256(uint128(out.amount0()));
        // forge-lint: disable-next-line(unsafe-typecast)
        m.tFromCurve = uint256(uint128(out.amount1()));
        if (_activeLiquidity(id) != 0) revert IBoxHook.MigrationNotNeutral();
        // M2: nothing is in range, so a zero-amount self-swap only walks the price to exactly P1 (FitPoolHook.sol:419-426).
        uint160 sqrtP = _slot0(id).sqrtPriceX96();
        if (sqrtP != a.sqrtP1) {
            BalanceDelta walked = _pm.swap(
                key, SwapParams({zeroForOne: sqrtP > a.sqrtP1, amountSpecified: -1, sqrtPriceLimitX96: a.sqrtP1}), ""
            );
            if (BalanceDelta.unwrap(walked) != 0 || _slot0(id).sqrtPriceX96() != a.sqrtP1) {
                revert IBoxHook.MigrationNotNeutral();
            }
        }
        _seedLayout(a, key, m, tokenBudget);
    }

    /// @dev M3: BoxLayoutV1's ASK_FULL_BID_SENTINEL (F61 L7; BC-067) at exactly P1, salt 1. Each add must take exactly
    /// the library's amount; Q the positions cannot take goes to the receiver as fees; T beyond the curve's comes
    /// from the coordinator's pool share (at most `tokenBudget`).
    function _seedLayout(Args memory a, PoolKey memory key, Migration memory m, uint256 tokenBudget) private {
        BoxLayoutV1.Graduated memory g = BoxLayoutV1.graduated(
            _curveOf(a), BoxSpecV1.GRAD_LAYOUT_ASK_FULL_BID_SENTINEL, m.qFromCurve, tokenBudget + m.tFromCurve
        );
        uint256 flags;
        if (_addL7(key, g.bid, true)) flags |= _B_BID;
        if (_addL7(key, g.sentinel, true)) flags |= _B_SENTINEL;
        if (_addL7(key, g.ask, false)) flags |= _B_ASK;
        _w |= flags;
        (m.askLiquidity, m.bidLiquidity, m.sentinelLiquidity) = (g.ask.liquidity, g.bid.liquidity, g.sentinel.liquidity);
        m.qDust = g.qDust;
        if (g.ask.amount < m.tFromCurve) revert IBoxHook.MigrationNotNeutral();
        m.tokenPulled = g.ask.amount - m.tFromCurve;
        if (m.tokenPulled != 0) _pullToken(a.token, m.tokenPulled);
        if (m.qDust != 0) _pm.mint(_argAddress(_A_RECEIVER), uint256(uint160(a.q)), m.qDust);
    }

    /// @dev One L7 position; false (nothing added) for zero liquidity. At exactly P1 each range is single-sided.
    function _addL7(PoolKey memory key, BoxLayoutV1.Position memory p, bool isQ) private returns (bool) {
        if (p.liquidity == 0) return false;
        (BalanceDelta owed,) = _pm.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: p.tickLower,
                tickUpper: p.tickUpper,
                liquidityDelta: int256(uint256(p.liquidity)),
                salt: _SALT_L7
            }),
            ""
        );
        int128 other = isQ ? owed.amount1() : owed.amount0();
        int128 taken = isQ ? owed.amount0() : owed.amount1();
        // casting to 'uint128' is safe because taken ≤ 0 is checked first
        // forge-lint: disable-next-line(unsafe-typecast)
        if (other != 0 || taken > 0 || uint256(uint128(-taken)) != p.amount) revert IBoxHook.MigrationNotNeutral();
        return true;
    }

    /// @dev Every guard of `deepen()` (dynamic-pool-share §§ 1.3-1.4; BC-119), outside the unlock. A failed guard is a
    /// skip reason; the budget stays. One path for every box (F72 (B), F77): pair and lock, or (S5.M5) a conversion
    /// first when the T side is below MIN_ADD.
    function _planDeepen(uint256 w) private returns (DeepenPlan memory p, DeepenSkip skip) {
        uint256 migrated = (w >> _O_MIGRATED) & _M40;
        if (migrated == 0) return (p, DeepenSkip.NotGraduated);
        uint256 last = (w >> _O_DEEPEN) & _M40;
        // The first add counts from the migration (the layout's own seeding).
        if (block.number < (last == 0 ? migrated : last) + _COOLDOWN) return (p, DeepenSkip.Cooldown);
        Args memory a = _args();
        skip = _priceGuards(a, p);
        if (skip != DeepenSkip.None) return (p, skip);
        (uint256 qBudget, uint256 tBudget) = _depthBudget();
        uint256 minAdd = _minAdd();
        if (qBudget < minAdd) return (p, DeepenSkip.BudgetBelowMin);
        // The tip comes from the Q side, so it is reserved before anything is sized.
        p.tipReserve = _tipOf(qBudget);
        uint256 tValue = _tInQ(tBudget, p.sqrtSpot);
        // Pair and lock (F72 (B)): the T side holds a chunk worth MIN_ADD at the price.
        if (tValue >= minAdd) {
            return (p, _sizePair(a, p, qBudget, tBudget) ? DeepenSkip.None : DeepenSkip.BudgetBelowMin);
        }
        return (p, _planConvert(a, p, qBudget, tValue, minAdd));
    }

    /// @dev The pair's size: the Q budget less the tip, capped at 10% of the core's Q near t_ref (BC-120); the T side
    /// whole (the add takes the smaller side at the price). False when the cap is zero.
    function _sizePair(Args memory a, DeepenPlan memory p, uint256 qBudget, uint256 tBudget)
        private
        view
        returns (bool)
    {
        p.qMax = qBudget - p.tipReserve;
        uint256 cap = _coreQNearPrice(a, p.tRef) * _CAP_PCT / 100;
        if (cap < p.qMax) p.qMax = cap;
        if (p.qMax == 0) return false;
        p.kind = DepthKind.Pair;
        p.tickLower = BoxSpecV1.MIN_USABLE_TICK;
        p.tickUpper = BoxSpecV1.MAX_USABLE_TICK;
        p.tMax = tBudget;
        return true;
    }

    /// @dev S5.M5 (swap-module § 8 rules 2 and 4): the T side is below MIN_ADD, so the call buys T. Its input ceiling
    /// (kept in `qMax`) is DEPTH_CONVERT_SHARE_BPS of the unpaired Q (Q budget − T value), at most the Q budget less the
    /// tip; its limit the swap module's buy limit (BoxSwapBounds: the nearer of spot − 49 ticks and t_ref − 99 ticks,
    /// t_ref the cheaper-T of the average and the latest sample, as `_priceGuards` set it), so one conversion spends at
    /// most the 49-tick room. The minimum is checked on what it can spend (S5 review): the smaller of the ceiling and
    /// the room before the limit (BoxSwapBounds.buyInput). Alone that needs DEPTH_CONVERT_MIN_Q; below it the
    /// conversion runs only when the pair is expected to follow in the same unlock: the least T it can buy (the minimum
    /// output at the limit), valued at spot, brings the T side to MIN_ADD with the Q side still at it. So a sliver of
    /// room (a push to the band's edge, the box's own buy-back) is a skip that starts no cooldown, not a conversion.
    function _planConvert(Args memory a, DeepenPlan memory p, uint256 qBudget, uint256 tValue, uint256 minAdd)
        private
        view
        returns (DeepenSkip)
    {
        uint256 x = (qBudget - tValue) * BoxSpecV1.DEPTH_CONVERT_SHARE_BPS / _BPS;
        if (x > qBudget - p.tipReserve) x = qBudget - p.tipReserve;
        p.limit = BoxSwapBounds.stepLimit(true, p.sqrtSpot, p.tRef);
        if (p.limit == 0) return DeepenSkip.ConvertBelowMin;
        bytes32 id = _poolIdOf(a.q, a.token);
        Slot0 s0 = _slot0(id);
        (uint24 swapFee,) = BoxSwapBounds.fees(s0, true);
        uint256 spend = BoxSwapBounds.buyInput(_pm, _stateSlotOf(id), s0, p.limit, swapFee);
        if (spend > x) spend = x;
        if (spend < BoxSpecV1.DEPTH_CONVERT_MIN_Q) {
            uint256 tLeast = BoxSwapBounds.minOut(true, spend, p.limit, swapFee);
            if (qBudget - x < minAdd || tValue + _tInQ(tLeast, p.sqrtSpot) < minAdd) return DeepenSkip.ConvertBelowMin;
        }
        p.kind = DepthKind.Convert;
        p.qMax = x;
        return DeepenSkip.None;
    }

    /// @dev The price guards: the average poked (fail-safe: a failing source reads as not ready), ready, caught up
    /// (latest sample within 99 ticks of spot) and |spot − average| ≤ 99. t_ref is the cheaper-T tick of the average
    /// and the latest sample; with Q as currency0 that is the higher tick (more T per Q), as
    /// BuybackBurner._referenceTick (BuybackBurner.sol:651-654). Writes spot, √spot and t_ref into `p`.
    function _priceGuards(Args memory a, DeepenPlan memory p) private returns (DeepenSkip) {
        IBoxPriceAverage avg = IBoxPriceAverage(_argAddress(_A_AVERAGE));
        try avg.poke() {}
        catch {
            return DeepenSkip.AverageNotReady;
        }
        bool ready;
        int24 avgTick;
        try avg.twap() returns (bool r, int24 t, uint32) {
            (ready, avgTick) = (r, t);
        } catch {}
        if (!ready) return DeepenSkip.AverageNotReady;
        int24 sample;
        try avg.latestSampleTick() returns (int24 s) {
            sample = s;
        } catch {
            return DeepenSkip.AverageNotReady;
        }
        Slot0 s0 = _slot0(_poolIdOf(a.q, a.token));
        p.spot = s0.tick();
        p.sqrtSpot = s0.sqrtPriceX96();
        if (_absDiff(sample, p.spot) > _MAX_DEV) return DeepenSkip.AverageNotCaughtUp;
        if (_absDiff(avgTick, p.spot) > _MAX_DEV) return DeepenSkip.Deviation;
        p.tRef = sample > avgTick ? sample : avgTick;
        return DeepenSkip.None;
    }

    /// @dev `deepen`'s unlock: a conversion first if planned (S5.M5), then, if both sides now reach MIN_ADD at the
    /// re-read price, the pair (a planned pair goes straight there): poke it (fees to the receiver), add exactly the
    /// principal the budget allows, burn exactly that from this hook's claims, then pay the tip (last, so a tip
    /// recipient's code runs after the trade and the add). Returns (kind, every Q spent, T paired, tip, liquidity).
    function _deepenStep(Args memory a, PoolKey memory key, DeepenPlan memory p) private returns (bytes memory) {
        uint256 qIn;
        if (p.kind == DepthKind.Convert) {
            (qIn, p.sqrtSpot) = _convert(a, key, p);
            (uint256 q, uint256 t) = _depthBudget();
            uint256 minAdd = _minAdd();
            if (q >= minAdd && _tInQ(t, p.sqrtSpot) >= minAdd) _sizePair(a, p, q, t);
        }
        uint128 liquidity;
        uint256 qUsed;
        uint256 tUsed;
        if (p.kind == DepthKind.Pair) {
            liquidity = _depthLiquidity(p);
            if (liquidity != 0) {
                _prepareDepthPosition(a, key, p);
                (qUsed, tUsed) = _addDepth(key, p, liquidity);
            }
        }
        uint256 tip = _settleDepth(a, p.tipTo, qUsed, tUsed, qIn);
        return abi.encode(p.kind, qIn + qUsed, tUsed, tip, liquidity);
    }

    /// @dev S5.M5: one exact-input buy of at most `p.qMax` Q down to `p.limit` in this box's own pool (the hook's own
    /// swap skips its callbacks, v4 Hooks.noSelfCall; the pool is closed, so every LP fee it pays reaches this box's
    /// positions), checked as FitBuybackExecutor checks its chunks (FitBuybackExecutor.sol:452-481): the deltas, the
    /// √price re-read against the limit, the minimum output on what it spent. Paid by burning the depth budget's Q
    /// claims; the T bought is minted as this hook's T claims (the depth budget; no token moves, no T is ever sold).
    /// Then REV-16 (BC-133): its own LP fee noted to the receiver as the swap module notes its steps' (a hook note: Q
    /// only, no allowance), which returns it to these claims in the next batch, never split. Returns the Q spent and
    /// the √price after.
    function _convert(Args memory a, PoolKey memory key, DeepenPlan memory p)
        private
        returns (uint256 qIn, uint160 sqrtAfter)
    {
        bytes32 id = _poolIdOf(a.q, a.token);
        Slot0 s0 = _slot0(id);
        uint256 tOut;
        (qIn, tOut) = _buy(key, p);
        sqrtAfter = _slot0(id).sqrtPriceX96();
        uint256 fee;
        {
            (uint24 swapFee, uint24 lpShare) = BoxSwapBounds.fees(s0, true);
            uint256 least = BoxSwapBounds.minOut(true, qIn, p.limit, swapFee);
            if (sqrtAfter < p.limit || tOut < least) {
                revert IBoxHook.ConversionOutOfBounds(sqrtAfter, p.limit, tOut, least);
            }
            fee = BoxSwapBounds.feeNote(qIn, lpShare);
        }
        if (qIn != 0) _pm.burn(address(this), uint256(uint160(a.q)), qIn);
        if (tOut != 0) _pm.mint(address(this), uint256(uint160(a.token)), tOut);
        _converted(id, qIn, tOut, p, s0.sqrtPriceX96(), sqrtAfter);
        if (fee != 0) IBoxReceiver(_argAddress(_A_RECEIVER)).noteModuleFees(fee, 0);
    }

    /// @dev The swap itself: exact input of at most `p.qMax` Q, Q in and T out only, never more than asked.
    function _buy(PoolKey memory key, DeepenPlan memory p) private returns (uint256 qIn, uint256 tOut) {
        BalanceDelta d = _pm.swap(
            key,
            // casting to 'int256' is safe because qMax is at most the Q budget (raw amounts below 2^128)
            // forge-lint: disable-next-line(unsafe-typecast)
            SwapParams({zeroForOne: true, amountSpecified: -int256(p.qMax), sqrtPriceLimitX96: p.limit}),
            ""
        );
        if (d.amount0() > 0 || d.amount1() < 0) revert IBoxHook.MigrationNotNeutral();
        // casting to 'uint128' is safe because amount0 ≤ 0 and amount1 ≥ 0 (checked above)
        // forge-lint: disable-next-line(unsafe-typecast)
        (qIn, tOut) = (uint256(uint128(-d.amount0())), uint256(uint128(d.amount1())));
        if (qIn > p.qMax) revert IBoxHook.MigrationNotNeutral();
    }

    function _converted(bytes32 id, uint256 qIn, uint256 tOut, DeepenPlan memory p, uint160 before, uint160 after_)
        private
    {
        emit IBoxHook.DepthConverted(PoolId.wrap(id), qIn, tOut, p.tRef, before, after_, p.limit);
    }

    /// @dev The liquidity the plan's budget funds: both sides at the price, sized by the smaller.
    function _depthLiquidity(DeepenPlan memory p) private pure returns (uint128) {
        return LiquidityAmounts.getLiquidityForAmounts(
            p.sqrtSpot,
            TickMath.getSqrtPriceAtTick(p.tickLower),
            TickMath.getSqrtPriceAtTick(p.tickUpper),
            p.qMax,
            p.tMax
        );
    }

    /// @dev Before adding into the pair once it exists: poke it and mint its fees to the receiver as ordinary fees
    /// (BC-121), so the add spends principal only. A new pair sets its flag.
    function _prepareDepthPosition(Args memory a, PoolKey memory key, DeepenPlan memory p) private {
        if (_positionLiquidity(_poolIdOf(a.q, a.token), p.tickLower, p.tickUpper, _SALT_PAIR) != 0) {
            (uint256 fq, uint256 ft) = _poke(key, p.tickLower, p.tickUpper, _SALT_PAIR);
            _distribute(a, fq, ft, false);
        } else {
            _w |= _B_PAIR;
        }
    }

    /// @dev The add; returns the principal it took (callerDelta − feesAccrued, PoolManager.sol:170-171), each side
    /// within the plan's budget.
    function _addDepth(PoolKey memory key, DeepenPlan memory p, uint128 liquidity)
        private
        returns (uint256 qUsed, uint256 tUsed)
    {
        (BalanceDelta callerDelta, BalanceDelta feesAccrued) = _pm.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: p.tickLower,
                tickUpper: p.tickUpper,
                liquidityDelta: int256(uint256(liquidity)),
                salt: _SALT_PAIR
            }),
            ""
        );
        int256 p0 = int256(callerDelta.amount0()) - int256(feesAccrued.amount0());
        int256 p1 = int256(callerDelta.amount1()) - int256(feesAccrued.amount1());
        if (p0 > 0 || p1 > 0) revert IBoxHook.MigrationNotNeutral();
        // casting to 'uint256' is safe because p0, p1 ≤ 0 (checked above)
        // forge-lint: disable-next-line(unsafe-typecast)
        (qUsed, tUsed) = (uint256(-p0), uint256(-p1));
        if (qUsed > p.qMax || tUsed > p.tMax) revert IBoxHook.MigrationNotNeutral();
    }

    /// @dev Burns exactly the principal from this hook's claims (the depth budget), then pays the tip in Q, last: one
    /// tip for the call, on every Q it spent (a conversion's input `qIn` and the pair's Q), within the reserve.
    function _settleDepth(Args memory a, address tipTo, uint256 qUsed, uint256 tUsed, uint256 qIn)
        private
        returns (uint256 tip)
    {
        if (qUsed != 0) _pm.burn(address(this), uint256(uint160(a.q)), qUsed);
        if (tUsed != 0) _pm.burn(address(this), uint256(uint160(a.token)), tUsed);
        tip = _tipOf(qUsed + qIn);
        if (tip != 0) {
            _pm.burn(address(this), uint256(uint160(a.q)), tip);
            _pm.take(Currency.wrap(a.q), tipTo, tip);
        }
    }

    /// @dev The add cap's base (dynamic-pool-share § 1.3, "the ETH the core holds within 10% below t_ref"): the Q
    /// the core positions' liquidity (L7 and the pair) spans on the bid side over [t_ref, t_ref + 953] ticks, as if
    /// the price stood at t_ref. It reads no spot price itself, but t_ref takes the latest sample, which this call's
    /// own poke records at the spot: a push in the call's block moves t_ref within [average, average + 99 ticks] (up
    /// to + 198 with a sample planted earlier in the block) and the cap with it, by under 1% either way (about 1.5% at
    /// most with a planted sample; box 0's own review W2-U3-1, F147); the closed pool (D3) fixes the liquidity.
    function _coreQNearPrice(Args memory a, int24 tRef) private view returns (uint256 q_) {
        int24 bandHi = tRef + _BAND;
        if (bandHi > BoxSpecV1.MAX_USABLE_TICK) bandHi = BoxSpecV1.MAX_USABLE_TICK;
        if (tRef < BoxSpecV1.MIN_USABLE_TICK || tRef >= bandHi) return 0;
        Band memory b;
        b.id = _poolIdOf(a.q, a.token);
        b.lo = TickMath.getSqrtPriceAtTick(tRef);
        b.hi = TickMath.getSqrtPriceAtTick(bandHi);
        uint256 w = _w;
        if (w & _B_ASK != 0) q_ += _q0In(b, BoxSpecV1.MIN_USABLE_TICK, a.tickLower, _SALT_L7);
        if (w & _B_BID != 0) q_ += _q0In(b, a.tickLower, BoxSpecV1.MAX_USABLE_TICK, _SALT_L7);
        if (w & _B_SENTINEL != 0) q_ += _q0In(b, a.tickUpper, BoxSpecV1.MAX_USABLE_TICK, _SALT_L7);
        if (w & _B_PAIR != 0) q_ += _q0In(b, BoxSpecV1.MIN_USABLE_TICK, BoxSpecV1.MAX_USABLE_TICK, _SALT_PAIR);
    }

    /// @dev Q (token0) one position holds inside the band's √prices.
    function _q0In(Band memory b, int24 lower, int24 upper, bytes32 salt) private view returns (uint256) {
        uint128 l = _positionLiquidity(b.id, lower, upper, salt);
        if (l == 0) return 0;
        uint160 lo = TickMath.getSqrtPriceAtTick(lower);
        uint160 hi = TickMath.getSqrtPriceAtTick(upper);
        if (lo < b.lo) lo = b.lo;
        if (hi > b.hi) hi = b.hi;
        if (lo >= hi) return 0;
        return SqrtPriceMath.getAmount0Delta(lo, hi, l, false);
    }

    /// @dev The pool's Pool.State slot (StateLibrary @ 46c68346: keccak256(poolId, POOLS_SLOT = 6)).
    function _stateSlotOf(bytes32 id) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(id, bytes32(uint256(6))));
    }

    /// @dev `t` valued in Q at √price `s` (T per Q = (s / 2^96)^2), rounded down.
    function _tInQ(uint256 t, uint160 s) private pure returns (uint256) {
        return FullMath.mulDiv(FullMath.mulDiv(t, 1 << 96, s), 1 << 96, s);
    }

    function _absDiff(int24 x, int24 y) private pure returns (int24) {
        return x > y ? x - y : y - x;
    }

    /// @dev BoxLayoutV1's curve rebuilt from the arguments (no bisection: `_checkCurve` proved them at launch).
    function _curveOf(Args memory a) private view returns (BoxLayoutV1.Curve memory c) {
        c.tIsCurrency0 = false;
        c.raise = _raise();
        (c.tickLower, c.tickUpper) = (a.tickLower, a.tickUpper);
        (c.tickStart, c.tickEnd) = (a.tickUpper, a.tickLower);
        (c.sqrtPriceLowerX96, c.sqrtPriceUpperX96) = (a.sqrtP1, a.sqrtP0);
        (c.sqrtPriceStartX96, c.sqrtPriceEndX96) = (a.sqrtP0, a.sqrtP1);
        c.liquidity = _argUint128(_A_LIQUIDITY);
    }

    /// @dev The arguments must be BoxLayoutV1.curve(raise, Q as currency0) (BoxLayoutV1.sol:118-143), checked
    /// without its bisection: the centre tick, the ticks, their √prices, and `liquidity` the least L whose fully
    /// crossed range holds exactly the raise (L holds it, L − 1 does not; the amount is monotonic in L).
    function _checkCurve(Args memory a, uint128 liquidity) private view {
        uint256 r = _raise();
        int24 centre = BoxLayoutV1.centreTick(r, false);
        int24 half = BoxSpecV1.CURVE_SPAN_TICKS / 2;
        if (
            r == 0 || a.tickLower != centre - half || a.tickUpper != centre + half
                || a.tickLower < BoxSpecV1.MIN_USABLE_TICK || a.tickUpper > BoxSpecV1.MAX_USABLE_TICK
                || a.sqrtP1 != TickMath.getSqrtPriceAtTick(a.tickLower)
                || a.sqrtP0 != TickMath.getSqrtPriceAtTick(a.tickUpper) || liquidity == 0
                || SqrtPriceMath.getAmount0Delta(a.sqrtP1, a.sqrtP0, liquidity, false) != r
                || SqrtPriceMath.getAmount0Delta(a.sqrtP1, a.sqrtP0, liquidity - 1, false) >= r
        ) revert InvalidCurve();
    }
}
