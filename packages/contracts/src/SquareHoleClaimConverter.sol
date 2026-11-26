// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {IRewardLedger} from "./interfaces/IRewardLedger.sol";
import {PoolManagerClaims} from "./libraries/PoolManagerClaims.sol";
import {TransientReentrancyGuard} from "./libraries/TransientReentrancyGuard.sol";
import {SquareHoleHook} from "./SquareHoleHook.sol";
import {SquareHoleRegistry} from "./SquareHoleRegistry.sol";

/// @title SquareHoleClaimConverter
/// @notice Claim-specific settlement for R = T launches (spec 05, ECO-07; ADR-0011 §6): a holder converts its OWN
/// earned Q entitlement, in full or in part, into T through the launch's canonical Square Hole pool, bounded by the
/// holder's minimum output and deadline, paying the normal pool fee (GOAL default: no exemption). It is not a swap
/// router: the only input is the caller's entitlement, the only pool is the registered pool of `token`, the only
/// recipient is the caller. No arbitrary targets, calldata or approvals; it never holds funds between transactions.
/// Emergency settlement (spec 05 "direct-source-Q claim fallback", published in ADR-0011 §6): while the canonical
/// pool has no T left to sell (its protocol-owned range is sold out), no conversion can fill; the caller may then take
/// its own entitlement in Q instead. The trigger is immutable code, not a switch: it reads the pool price.
/// @dev Conversion inside one PoolManager unlock: ledger.claimFor(holder, maxQIn) hands this contract up to `maxQIn`
/// of the entitlement as Q claims → exact-input swap Q → T on the registered pool (the hook's afterSwap indexes that
/// swap's fee as usual) → the Q debt is settled by burning the claims → T is taken straight to the holder. Any failure
/// (no entitlement, partial fill, output below the minimum, expired deadline) reverts everything, so the entitlement
/// is untouched. The fallback burns the claims and takes Q straight to the holder inside its own unlock.
contract SquareHoleClaimConverter is IUnlockCallback, TransientReentrancyGuard {
    using PoolManagerClaims for IPoolManager;

    event ClaimConverted(address indexed token, address indexed holder, uint256 qIn, uint256 tOut);
    /// @notice Emergency settlement: `qOut` of the holder's entitlement paid in Q because the pool was sold out.
    event ClaimPaidInQSoldOut(address indexed token, address indexed holder, uint256 qOut);

    error ZeroAddress();
    error NotPoolManager();
    error UnknownPair(address token);
    error UnknownPairId(bytes32 pairId);
    error NotPayoutT(address token);
    error Expired(uint256 deadline);
    error NothingToClaim();
    error PartialFill(uint256 qClaimed, uint256 qUsed);
    error InsufficientOutput(uint256 tOut, uint256 minTOut);
    error UnexpectedDelta();
    /// @notice The fallback is available only while the canonical pool's range holds no T.
    error PoolNotSoldOut(address token);

    /// @dev Unlock modes.
    uint8 internal constant MODE_CONVERT = 0;
    uint8 internal constant MODE_Q_FALLBACK = 1;
    /// @dev PoolManager storage slot of `pools` (v4-core StateLibrary.POOLS_SLOT at the pin). Read with `extsload`
    /// directly: StateLibrary itself is MIT but imports the BUSL-1.1 Position.sol, which src/ never imports.
    bytes32 internal constant POOLS_SLOT = bytes32(uint256(6));

    IPoolManager public immutable poolManager;
    SquareHoleRegistry public immutable registry;

    constructor(IPoolManager poolManager_, SquareHoleRegistry registry_) {
        if (address(poolManager_) == address(0) || address(registry_) == address(0)) revert ZeroAddress();
        poolManager = poolManager_;
        registry = registry_;
    }

    /// @notice Converts the caller's WHOLE Q entitlement in the launch `pairId` (the registry's canonical pair id,
    /// keccak256(abi.encode(chainId, token))) into T paid to the caller: ledger.claimFor(caller) → exactly that Q is
    /// swapped for T through the pair's canonical pool (fixed PoolKey from the registry) → T to the caller. Reverts
    /// atomically (the entitlement survives, ECO-07) on an expired deadline, an output below `minTOut`, a partial
    /// fill or an empty entitlement. Pays the normal pool fee. SH-B2 Build B item 6 (ADR-0011 §6).
    /// @param pairId registry pair id of an R = T launch wired to this converter
    /// @param minTOut the caller's minimum T output (raw)
    /// @param deadline last valid block timestamp
    function claimAsT(bytes32 pairId, uint256 minTOut, uint256 deadline)
        external
        nonReentrant
        returns (uint256 qIn, uint256 tOut)
    {
        SquareHoleRegistry.PairRecord memory r = registry.pair(pairId);
        if (r.token == address(0)) revert UnknownPairId(pairId);
        _checkPayoutT(r);
        (qIn, tOut) = _claimAsT(r, type(uint256).max, minTOut, deadline);
    }

    /// @notice Converts up to `maxQIn` of the caller's Q entitlement in `token`'s launch into T paid to the caller.
    /// @param token T of an R = T launch
    /// @param maxQIn the most raw Q to convert (`type(uint256).max`: the whole entitlement); the rest stays intact
    /// @param minTOut the caller's minimum T output (raw)
    /// @param deadline last valid block timestamp
    function claimAsT(address token, uint256 maxQIn, uint256 minTOut, uint256 deadline)
        external
        nonReentrant
        returns (uint256 qIn, uint256 tOut)
    {
        (qIn, tOut) = _claimAsT(_payoutTPair(token), maxQIn, minTOut, deadline);
    }

    function _claimAsT(SquareHoleRegistry.PairRecord memory r, uint256 maxQIn, uint256 minTOut, uint256 deadline)
        private
        returns (uint256 qIn, uint256 tOut)
    {
        if (block.timestamp > deadline) revert Expired(deadline);
        (qIn, tOut) = abi.decode(
            poolManager.unlock(abi.encode(MODE_CONVERT, msg.sender, maxQIn, minTOut, r)), (uint256, uint256)
        );
        emit ClaimConverted(r.token, msg.sender, qIn, tOut);
    }

    /// @notice Emergency settlement: pays up to `maxQ` of the caller's Q entitlement in Q, only while `token`'s
    /// canonical pool is sold out (`isSoldOut(token)`: the pool price is at or beyond the Q-only end of the
    /// protocol-owned range, so the pool holds no T to sell and every conversion reverts).
    /// @param token T of an R = T launch
    /// @param maxQ the most raw Q to take (`type(uint256).max`: the whole entitlement); the rest stays intact
    function claimAsQWhenSoldOut(address token, uint256 maxQ) external nonReentrant returns (uint256 qOut) {
        SquareHoleRegistry.PairRecord memory r = _payoutTPair(token);
        if (!_isSoldOut(r)) revert PoolNotSoldOut(token);
        (qOut,) = abi.decode(
            poolManager.unlock(abi.encode(MODE_Q_FALLBACK, msg.sender, maxQ, uint256(0), r)), (uint256, uint256)
        );
        emit ClaimPaidInQSoldOut(token, msg.sender, qOut);
    }

    /// @notice Whether `token`'s canonical pool holds no T in its protocol-owned range (the fallback trigger).
    /// False for unknown pairs.
    function isSoldOut(address token) external view returns (bool) {
        SquareHoleRegistry.PairRecord memory r = registry.pairOfToken(token);
        if (r.token == address(0)) return false;
        return _isSoldOut(r);
    }

    /// @notice PoolManager callback of `claimAsT`'s or `claimAsQWhenSoldOut`'s own unlock.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager) || !_insideGuardedCall()) revert NotPoolManager();
        (uint8 mode, address holder, uint256 maxQ, uint256 minTOut, SquareHoleRegistry.PairRecord memory r) =
            abi.decode(data, (uint8, address, uint256, uint256, SquareHoleRegistry.PairRecord));

        uint256 qIn = IRewardLedger(r.ledger).claimFor(holder, maxQ);
        if (qIn == 0) revert NothingToClaim();
        if (mode == MODE_Q_FALLBACK) {
            // Burning the entitlement's claims credits this contract; the take pays that credit to the holder.
            poolManager.burn(address(this), PoolManagerClaims.claimId(r.quote), qIn);
            poolManager.take(Currency.wrap(r.quote), holder, qIn);
            return abi.encode(qIn, uint256(0));
        }
        return abi.encode(qIn, _convert(holder, qIn, minTOut, r));
    }

    /// @dev Exact-input swap Q → T of the claimed `qIn` on the registered pool; settles with the claims and pays T.
    function _convert(address holder, uint256 qIn, uint256 minTOut, SquareHoleRegistry.PairRecord memory r)
        private
        returns (uint256 tOut)
    {
        bool qIsCurrency0 = r.quote < r.token;
        BalanceDelta delta = poolManager.swap(
            _key(r, qIsCurrency0),
            SwapParams({
                zeroForOne: qIsCurrency0,
                // casting to 'int256' is safe because qIn ≤ the ledger's lifetime cap (2^128 − 1)
                // forge-lint: disable-next-line(unsafe-typecast)
                amountSpecified: -int256(qIn),
                sqrtPriceLimitX96: qIsCurrency0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        int128 qDelta = qIsCurrency0 ? delta.amount0() : delta.amount1();
        int128 tDelta = qIsCurrency0 ? delta.amount1() : delta.amount0();
        // An exact-input Q → T swap without hook deltas can only debit Q and credit T.
        if (qDelta > 0 || tDelta < 0) revert UnexpectedDelta();
        // casting to 'uint128' is safe because qDelta ≤ 0 and tDelta ≥ 0 (checked above)
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 qUsed = uint256(uint128(-qDelta));
        if (qUsed != qIn) revert PartialFill(qIn, qUsed);
        // forge-lint: disable-next-line(unsafe-typecast)
        tOut = uint256(uint128(tDelta));
        if (tOut < minTOut) revert InsufficientOutput(tOut, minTOut);

        // Settle the Q debt with the entitlement's claims, then pay T straight to the holder.
        poolManager.burn(address(this), PoolManagerClaims.claimId(r.quote), qIn);
        poolManager.take(Currency.wrap(r.token), holder, tOut);
    }

    function _payoutTPair(address token) private view returns (SquareHoleRegistry.PairRecord memory r) {
        r = registry.pairOfToken(token);
        if (r.token == address(0)) revert UnknownPair(token);
        _checkPayoutT(r);
    }

    /// @dev Only R = T launches wired to this converter (ECO-04): the ledger itself also refuses any other caller.
    function _checkPayoutT(SquareHoleRegistry.PairRecord memory r) private view {
        if (r.rewardSide != uint8(IRewardLedger.PayoutAsset.T) || r.converter != address(this)) {
            revert NotPayoutT(r.token);
        }
    }

    function _key(SquareHoleRegistry.PairRecord memory r, bool qIsCurrency0) private view returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(qIsCurrency0 ? r.quote : r.token),
            currency1: Currency.wrap(qIsCurrency0 ? r.token : r.quote),
            fee: SquareHoleHook(r.hook).LP_FEE(),
            tickSpacing: r.tickSpacing,
            hooks: IHooks(r.hook)
        });
    }

    /// @dev The protocol-owned position holds no T: with T = currency0 buyers push the price up and the range is sold
    /// out at or above its upper tick; with T = currency1 buyers push it down and it is sold out at or below its lower
    /// tick (LaunchMath orientation). The position is the pool's only liquidity.
    function _isSoldOut(SquareHoleRegistry.PairRecord memory r) private view returns (bool) {
        uint160 sqrtPriceX96 = _sqrtPriceX96(r.poolId);
        if (r.token < r.quote) return sqrtPriceX96 >= TickMath.getSqrtPriceAtTick(r.tickUpper);
        return sqrtPriceX96 <= TickMath.getSqrtPriceAtTick(r.tickLower);
    }

    /// @dev The pool's current √price: the low 160 bits of `pools[poolId].slot0` (the same read as v4-core
    /// StateLibrary.getSlot0; `test_converter_fallbackRejectsNonPayoutTAndUnknownPairs` checks it in both orders).
    function _sqrtPriceX96(bytes32 poolId) private view returns (uint160) {
        bytes32 slot0 = poolManager.extsload(keccak256(abi.encodePacked(poolId, POOLS_SLOT)));
        // casting to 'uint160' keeps exactly the sqrtPriceX96 field of the packed slot0
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint160(uint256(slot0));
    }
}
