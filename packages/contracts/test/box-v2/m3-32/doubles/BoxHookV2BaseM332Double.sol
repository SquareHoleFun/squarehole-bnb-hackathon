// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Test-only M3 fixture copy, synchronized with F137 plain-hook accounting.

import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {Slot0} from "v4-core/src/types/Slot0.sol";
import {BoxCloneReader} from "../../../../src/box/BoxCloneReader.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {TransientReentrancyGuard} from "../../../../src/libraries/TransientReentrancyGuard.sol";
import {IBoxHookV2, TradeBatchV2, IBoxHolderBatchNoticeV2} from "../../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {ReleaseConstantsV2 as C} from "../../../../src/box-v2/interfaces/ReleaseConstantsV2.sol";
import {BoxHookV2Args as A} from "../../../../src/box-v2/libraries/BoxHookV2Args.sol";

/// @notice Shared storage and accounting of the fixed hook implementations. P is always currency0.
abstract contract BoxHookV2BaseM332Double is BoxCloneReader, TransientReentrancyGuard {
    using PoolIdLibrary for PoolKey;
    error QNotCurrency0(address q, address token);
    error UnknownKind(uint8 kind);
    error InvalidCurve();
    error TokenTransferFailed();
    error UnexpectedDelta();
    error GasTooLow();
    error NotGraduated();
    error MigrationNotNeutral();
    error InsufficientOutput();
    uint256 internal constant _M40 = (1 << 40) - 1;
    uint256 internal constant _B_LAUNCHED = 1;
    uint256 internal constant _B_FAILED = 2;
    uint256 internal constant _B_ITEM_SOURCE = 4;
    uint256 internal constant _O_DEPLOY = 8;
    uint256 internal constant _O_OPEN = 48;
    uint256 internal constant _O_CLOSED = 88;
    uint256 internal constant _O_MIGRATED = 128;
    uint256 internal constant _O_PROTOCOL = 168;
    uint256 internal constant _O_DEADLINE = 208;
    uint256 internal constant _LIQUIDITY_OFFSET = 3;
    uint256 internal constant _POSITIONS_OFFSET = 6;
    bytes32 internal constant _IS_UNLOCKED_SLOT = 0xc090fc4683624cfc3884e9d8de5eca132f2d0ec062aff75d43c0465d5ceeab23;
    bytes32 internal constant _SALT_CURVE = bytes32(0);
    bytes32 internal constant _SALT_PAIR = bytes32(uint256(3));
    uint8 internal constant _ACT_LAUNCH = 1;
    uint8 internal constant _ACT_MIGRATE = 2;
    uint8 internal constant _ACT_HARVEST = 3;
    uint8 internal constant _ACT_DEEPEN = 4;
    uint8 internal constant _ACT_CLOSE = 5;
    uint8 internal constant _ACT_TIP = 6;
    uint8 internal constant _ACT_BURN = 7;
    uint8 internal constant _ACT_SELL_FEES = 8;
    IPoolManager internal immutable _pm;
    uint256 internal _w;
    uint128 internal _reserveMinted;
    uint256 internal _saleFeesPending;
    uint64 internal _closedAt;
    // Fee checkpoints already minted these claims; harvest reports them without minting twice.
    uint256 internal _buyersCheckpointed;
    uint256 internal _reserveCheckpointed;
    // Exact T attributed to this pool: deposits minus withdrawals, including rounding.
    // Never inferred from PoolManager's shared balance or ERC-6909 backing.
    uint256 internal _poolTInventory;
    // Additive storage shared by both hook halves. Zero-ledger M1 boxes never write these slots.
    uint256 internal _batchPair;
    mapping(uint256 => TradeBatchV2) internal _tradeBatches;
    bool internal _bootstrapRecorded;
    // Realized post-graduation LP fees only; gifts and refused burns never enter this counter.
    uint256 internal _tFeesPending;
    struct Args { address q; address token; uint160 sqrtP1; uint160 sqrtP0; int24 tickLower; int24 tickUpper; }
    constructor(IPoolManager pm) { _pm = pm; }
    /// @dev Internal argument reader; no money moves.
    function _raise() internal view returns (uint256) { return _argUint(A.RAISE, 16); }
    /// @dev Internal D6 limit: at most 0.1% of the fixed raise.
    function _reserveCap() internal view returns (uint256) { return _raise() / 1000; }
    /// @dev Internal tip reader; no money moves.
    function _tipMaxQ() internal view returns (uint256) { return _argUint(A.TIP_MAX_Q, 16); }
    /// @dev Internal budget reader; only P claims fund deepen.
    function _depthBudget() internal view returns (uint256) {
        return _pm.balanceOf(address(this), uint256(uint160(_argAddress(A.Q))));
    }
    /// @dev Internal pool key, shared by initialization, swaps and every position operation.
    function _key(Args memory a) internal view returns (PoolKey memory) {
        return PoolKey(Currency.wrap(a.q), Currency.wrap(a.token), C.V2_POOL_FEE, 60, IHooks(address(this)));
    }
    /// @dev Internal id uses exactly the public key, with no independent fee literal.
    function _poolIdOf(address q_, address t_) internal view returns (bytes32) {
        Args memory a; a.q = q_; a.token = t_;
        return PoolId.unwrap(_key(a).toId());
    }
    /// @dev Internal fee settlement: D6 first until migration, remaining P minted to receiver; never T fees.
    function _distribute(Args memory a, uint256 fees, bool beforeGraduation) internal returns (uint256 reserve) {
        uint256 cap = _reserveCap();
        if (beforeGraduation && _reserveMinted < cap) {
            reserve = cap - _reserveMinted;
            if (reserve > fees) reserve = fees;
            _reserveMinted += uint128(reserve);
            if (reserve != 0) _pm.mint(_argAddress(A.COORDINATOR), uint256(uint160(a.q)), reserve);
        }
        if (_hasBatches()) _tradeBatches[_batchId(true)].netP += fees - reserve;
        if (fees > reserve) _pm.mint(_argAddress(A.RECEIVER), uint256(uint160(a.q)), fees - reserve);
    }
    /// @dev Optional immutable tail: no registry, token or ledger read on a swap.
    function _holderLedger() internal view returns (address) { return _argAddress(A.HOLDER_LEDGER); }

    /// @dev Initialization caches role 16; fee paths never query the coordinator or item ledger.
    function _hasBatches() internal view returns (bool) {
        return _holderLedger() != address(0) || _w & _B_ITEM_SOURCE != 0;
    }

    /// @dev Independent side ids; zero is never a batch.
    function _batchId(bool buy) internal view returns (uint256) { return 2 * _batchPair + (buy ? 1 : 2); }

    /// @dev Lifecycle harvests (including migrate/close) seal both sides, even when nothing was funded.
    function _closeTradeBatches() internal {
        if (!_hasBatches()) return;
        _tradeBatches[_batchId(true)].closed = true;
        _tradeBatches[_batchId(false)].closed = true;
        ++_batchPair;
    }

    /// @dev Record before the fail-safe call. Units cannot depend on notice success or eligible supply.
    function _noticeTrade(address sender, bool buy, uint256 units) internal {
        address ledger = _holderLedger();
        if (!_hasBatches() || units == 0) return;
        uint256 id = _batchId(buy);
        TradeBatchV2 storage b = _tradeBatches[id];
        // The fixed launch router's first creation-block swap is bootstrap. Creator buy follows it.
        bool bootstrap = sender == _argAddress(A.ROUTER) && !_bootstrapRecorded
            && block.number == ((_w >> _O_DEPLOY) & _M40) && block.timestamp < ((_w >> _O_OPEN) & _M40);
        if (bootstrap) _bootstrapRecorded = true;
        if (sender == _argAddress(A.RECEIVER) || bootstrap) { b.protocolUnits += units; return; }
        b.tradeUnits += units;
        if (ledger == address(0)) return;
        bytes memory data = abi.encodeCall(IBoxHolderBatchNoticeV2.onTradeFeeBatch, (id, sender, buy, units));
        uint256 cap = C.HOLDER_NOTICE_GAS;
        // The notice can consume its entire cap. Keep the complete post-notice path funded:
        // fee checkpointing here, then PoolManager/router settlement after this callback returns.
        // Too little gas skips only the notice; the authoritative units above remain recorded.
        if (gasleft() < cap + cap / 63 + C.POKE_OVERHEAD_GAS + C.HOLDER_NOTICE_RESERVE_GAS) return;
        assembly ("memory-safe") { pop(call(cap, ledger, 0, add(data, 32), mload(data), 0, 0)) }
    }

    /// @dev Internal zero-liquidity poke; P fee credit is settled by _distribute.
    function _poke(PoolKey memory key, int24 lo, int24 hi, bytes32 salt) internal returns (uint256 fees) {
        (, BalanceDelta d) = _pm.modifyLiquidity(key, ModifyLiquidityParams(lo, hi, 0, salt), "");
        if (d.amount0() < 0 || d.amount1() < 0) revert UnexpectedDelta();
        _accountPoolT(d.amount1());
        _mintTFees(key, d.amount1(), salt == _SALT_PAIR);
        return uint256(int256(d.amount0()));
    }
    /// @dev Segregate LP T from pool inventory and other hook custody; never mint T to the receiver.
    function _mintTFees(PoolKey memory key, int128 amount, bool graduated) internal {
        if (amount == 0) return;
        uint256 fees = uint256(int256(amount));
        _pm.mint(address(this), uint160(Currency.unwrap(key.currency1)), fees);
        if (graduated) _tFeesPending += fees;
    }
    /// @dev Record this pool's T delta from the caller's perspective, including input LP fees.
    /// Own swaps skip callbacks, so lifecycle paths record their deltas explicitly.
    function _accountPoolT(int128 delta) internal {
        if (delta < 0) _poolTInventory += uint256(-int256(delta));
        else _poolTInventory -= uint256(int256(delta));
    }
    /// @dev Internal last-step update, shared by deepen and receiver buys.
    function _markProtocol() internal {
        _w = (_w & ~(_M40 << _O_PROTOCOL)) | (block.number << _O_PROTOCOL);
    }
    /// @dev Internal gas check prevents EIP-150 truncation from disguising an underfunded call as refusal.
    function _stipend(uint256 gasCap) internal view {
        if (gasleft() < gasCap + gasCap / 63 + C.POKE_OVERHEAD_GAS) revert GasTooLow();
    }
    /// @dev Internal fail-safe unlock; discard returndata so a failed token cannot expand the caller's memory.
    function _tryUnlock(uint8 action, bytes memory arg, uint256 gasCap) internal returns (bool ok) {
        _stipend(gasCap);
        bytes memory data = abi.encodeCall(_pm.unlock, (abi.encode(action, arg)));
        address manager = address(_pm);
        assembly ("memory-safe") { ok := call(gasCap, manager, 0, add(data, 32), mload(data), 0, 0) }
    }
    /// @dev Internal tip on actual moved P; unused reserve remains budget.
    function _tipOf(uint256 amount) internal view returns (uint256) {
        uint256 tip = amount / 20;
        uint256 cap = _tipMaxQ();
        return tip < cap ? tip : cap;
    }

    /// @dev Internal hook helper; external entry points enforce their caller and unlock rules.
    function _initialised() internal view returns (uint256 w) {
        w = _w;
        if ((w >> _O_DEPLOY) & _M40 == 0) revert IBoxHookV2.NotInitialised();
    }

    /// @dev Internal hook helper; external entry points enforce their caller and unlock rules.
    function _noForeignUnlock() internal view {
        if (_pm.exttload(_IS_UNLOCKED_SLOT) != bytes32(0)) revert IBoxHookV2.ForeignUnlock();
    }

    /// @dev Internal hook helper; external entry points enforce their caller and unlock rules.
    function _hotArgs() internal view returns (address q_, address t_, uint160 sqrtP1, uint160 sqrtP0) {
        assembly ("memory-safe") {
            let p := mload(0x40)
            extcodecopy(address(), p, 45, 80)
            q_ := shr(96, mload(p))
            t_ := shr(96, mload(add(p, 20)))
            sqrtP1 := shr(96, mload(add(p, 40)))
            sqrtP0 := shr(96, mload(add(p, 60)))
        }
    }

    /// @dev Internal hook helper; external entry points enforce their caller and unlock rules.
    function _args() internal view returns (Args memory a) {
        (a.q, a.token, a.sqrtP1, a.sqrtP0) = _hotArgs();
        a.tickLower = _argInt24(A.TICK_LOWER);
        a.tickUpper = _argInt24(A.TICK_UPPER);
    }

    /// @dev Internal hook helper; external entry points enforce their caller and unlock rules.
    function _slot0(bytes32 id) internal view returns (Slot0) {
        return Slot0.wrap(_pm.extsload(keccak256(abi.encodePacked(id, bytes32(uint256(6))))));
    }

    /// @dev Internal hook helper; external entry points enforce their caller and unlock rules.
    function _activeLiquidity(bytes32 id) internal view returns (uint128) {
        bytes32 stateSlot = keccak256(abi.encodePacked(id, bytes32(uint256(6))));
        return uint128(uint256(_pm.extsload(bytes32(uint256(stateSlot) + _LIQUIDITY_OFFSET))));
    }

    /// @dev Internal hook helper; external entry points enforce their caller and unlock rules.
    function _positionLiquidity(bytes32 id, int24 lower, int24 upper, bytes32 salt) internal view returns (uint128) {
        bytes32 stateSlot = keccak256(abi.encodePacked(id, bytes32(uint256(6))));
        bytes32 positionKey = keccak256(abi.encodePacked(address(this), lower, upper, salt));
        bytes32 slot = keccak256(abi.encode(positionKey, uint256(stateSlot) + _POSITIONS_OFFSET));
        return uint128(uint256(_pm.extsload(slot)));
    }

    /// @dev Internal hook helper; external entry points enforce their caller and unlock rules.
    function _pullToken(address token_, uint256 amount) internal {
        _pm.sync(Currency.wrap(token_));
        if (token_.code.length == 0) revert TokenTransferFailed();
        (bool ok, bytes memory ret) =
            token_.call(abi.encodeWithSelector(0x23b872dd, _argAddress(A.COORDINATOR), address(_pm), amount));
        if (!ok || (ret.length != 0 && (ret.length != 32 || abi.decode(ret, (uint256)) != 1))) {
            revert TokenTransferFailed();
        }
        _pm.settle();
    }
}
