// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Uniswap v4-core @ 46c68346, MIT files only (interfaces, types, libraries; DEPENDENCIES.md).
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {Slot0} from "v4-core/src/types/Slot0.sol";
import {BoxSpecV1} from "./BoxSpecV1.sol";
import {IBoxHook} from "./interfaces/IBoxHook.sol";
import {DepthKind} from "./interfaces/BoxTypes.sol";
import {BoxCloneReader} from "./BoxCloneReader.sol";

/// @title BoxHookBase
/// @notice The storage, constants and shared internals of the box hook's two code halves: `BoxHook` (the clone's
/// implementation: swap callbacks, `harvest`, views) and `BoxHookExtension` (launch, migration and depth, reached by
/// `BoxHook` through a DELEGATECALL to a fixed address, because one contract would exceed EIP-170's 24,576 bytes:
/// 28,223 bytes measured, SH-S4S5 evidence). Both halves run in the clone's context (its address, its storage, its
/// code arguments) and declare exactly this storage, so the layout is the same by construction.
///
/// **Clone arguments** (`abi.encodePacked`, 203 bytes, the order chosen so each callback copies one run of bytes):
///
/// | Offset | Bytes | Argument |
/// |---:|---:|---|
/// | 0 | 20 | `q` (address(0) = native ETH; v1: Q is currency0, so q < token) |
/// | 20 | 20 | `token` (T) |
/// | 40 | 20 | √P1 (the curve's lower √price; the graduation price when Q is currency0) |
/// | 60 | 20 | √P0 (the curve's upper √price; the start) |
/// | 80 | 20 | `launchRouter` |
/// | 100 | 1 | `kind` (`BoxKind`) |
/// | 101 | 3 | curve lower tick |
/// | 104 | 3 | curve upper tick |
/// | 107 | 4 | `openAt` (BoxSpec field 15: uint32 Unix seconds, 0 = Now; `initialize` turns it into the open time) |
/// | 111 | 16 | curve liquidity |
/// | 127 | 16 | `raise` (Q raw units) |
/// | 143 | 20 | `coordinator` |
/// | 163 | 20 | `receiver` |
/// | 183 | 20 | `priceAverage` |
///
/// **State word** `_w` (one slot, read once per swap): bit 0 launched; 40-bit deployBlock (8), openAt (48, Unix seconds),
/// closedAtBlock (88), migratedAtBlock (128), lastDeepenBlock (168); bits 208-231 unused (the removed rungs' harvest
/// tick, F77); bits 232-235 which L7 positions (ask, bid, sentinel) and the pair exist (v4 refuses a zero-liquidity
/// poke of an empty position).
abstract contract BoxHookBase is BoxCloneReader {
    // ------------------------------------------------------------------ errors beyond IBoxHook

    /// @notice v1 serves pools whose Q is currency0 (native ETH always is); the other order is S12's.
    error QNotCurrency0(address q, address token);
    error UnknownKind(uint8 kind);
    /// @notice A curve argument differs from BoxLayoutV1's curve for the raise.
    error InvalidCurve();
    error TokenTransferFailed();

    // ------------------------------------------------------------------ version constants (P where marked)

    /// @dev ≥ 300 blocks between depth adds (dynamic-pool-share § 1.3; BC-119).
    uint256 internal constant _COOLDOWN = 300;
    /// @dev |spot − average| and |spot − latest sample| at most 99 ticks (§ 1.3-1.4; BC-119).
    int24 internal constant _MAX_DEV = 99;
    /// @dev One add takes at most 10% of the Q the core positions hold within 10% of t_ref (§ 1.3; BC-120).
    uint256 internal constant _CAP_PCT = 10;
    /// @dev 10% in ticks: 1.0001^953 = 1.09997.
    int24 internal constant _BAND = 953;
    /// @dev MIN_ADD = 0.5% of the raise (BC-119: 0.021034900425 ETH for box 0).
    uint256 internal constant _MIN_ADD_BPS = 50;
    /// @dev The `deepen()` tip: min(5% of the add, the cap), from the Q budget (§ 1.3). The cap is P: the D2 tip cap
    /// (BoxSpecV1.FEE_BATCH_TIP_MAX_ETH) until BC-017's gas measurement re-sizes both.
    uint256 internal constant _TIP_BPS = 500;
    uint256 internal constant _TIP_CAP = BoxSpecV1.FEE_BATCH_TIP_MAX_ETH;
    uint256 internal constant _BPS = 10_000;

    /// @dev Salts (FitLaunchShape.sol:99 uses 1 for the migrated positions): curve 0, L7 1, pair 3. Salt 2 was box
    /// 0's rungs, removed by F77 (every box pairs and locks); it is never used and the pair's salt is not renumbered.
    bytes32 internal constant _SALT_CURVE = bytes32(0);
    bytes32 internal constant _SALT_L7 = bytes32(uint256(1));
    bytes32 internal constant _SALT_PAIR = bytes32(uint256(3));
    /// @dev Lock.IS_UNLOCKED_SLOT of v4-core @ 46c68346 (`src/libraries/Lock.sol:8`, read by value: that file is BUSL).
    bytes32 internal constant _IS_UNLOCKED_SLOT = 0xc090fc4683624cfc3884e9d8de5eca132f2d0ec062aff75d43c0465d5ceeab23;
    /// @dev Pool.State offsets (StateLibrary @ 46c68346): active liquidity, positions mapping.
    uint256 internal constant _LIQUIDITY_OFFSET = 3;
    uint256 internal constant _POSITIONS_OFFSET = 6;

    // Unlock actions (`abi.encode(uint8 action, bytes arg)`): harvest runs in BoxHook, the rest in the extension.
    uint8 internal constant _ACT_LAUNCH = 1;
    uint8 internal constant _ACT_MIGRATE = 2;
    uint8 internal constant _ACT_HARVEST = 3;
    uint8 internal constant _ACT_DEEPEN = 4;

    // Clone argument offsets (see the contract notes).
    uint256 internal constant _A_Q = 0;
    uint256 internal constant _A_TOKEN = 20;
    uint256 internal constant _A_ROUTER = 80;
    uint256 internal constant _A_KIND = 100;
    uint256 internal constant _A_TICK_LOWER = 101;
    uint256 internal constant _A_TICK_UPPER = 104;
    uint256 internal constant _A_OPEN_AT = 107;
    uint256 internal constant _A_LIQUIDITY = 111;
    uint256 internal constant _A_RAISE = 127;
    uint256 internal constant _A_COORDINATOR = 143;
    uint256 internal constant _A_RECEIVER = 163;
    uint256 internal constant _A_AVERAGE = 183;
    uint256 internal constant _ARGS_LENGTH = 203;

    // State word bit layout.
    uint256 internal constant _M40 = (1 << 40) - 1;
    uint256 internal constant _B_LAUNCHED = 1;
    uint256 internal constant _O_DEPLOY = 8;
    uint256 internal constant _O_OPEN = 48;
    uint256 internal constant _O_CLOSED = 88;
    uint256 internal constant _O_MIGRATED = 128;
    uint256 internal constant _O_DEEPEN = 168;
    uint256 internal constant _B_ASK = 1 << 232;
    uint256 internal constant _B_BID = 1 << 233;
    uint256 internal constant _B_SENTINEL = 1 << 234;
    uint256 internal constant _B_PAIR = 1 << 235;

    // ------------------------------------------------------------------ immutables and storage

    IPoolManager internal immutable _pm;

    uint256 internal _w;
    uint256 internal _reserveMinted;

    /// @dev What one `migrate` did.
    struct Migration {
        uint256 qFromCurve;
        uint256 tFromCurve;
        uint128 askLiquidity;
        uint128 bidLiquidity;
        uint128 sentinelLiquidity;
        uint256 tokenPulled;
        uint256 qDust;
    }

    /// @dev One `deepen()`'s plan, computed outside the unlock and executed inside it. For a conversion (S5.M5),
    /// `qMax` is its input ceiling and `limit` its √price limit; `tipReserve` is the tip the Q side keeps back.
    struct DeepenPlan {
        DepthKind kind;
        int24 tickLower;
        int24 tickUpper;
        uint256 qMax;
        uint256 tMax;
        uint160 sqrtSpot;
        address tipTo;
        int24 spot;
        int24 tRef;
        uint160 limit;
        uint256 tipReserve;
    }

    /// @dev A tick band in √prices, for the add cap.
    struct Band {
        bytes32 id;
        uint160 lo;
        uint160 hi;
    }

    /// @dev The clone arguments a call needs, read once.
    struct Args {
        address q;
        address token;
        uint160 sqrtP1;
        uint160 sqrtP0;
        int24 tickLower;
        int24 tickUpper;
    }

    constructor(IPoolManager poolManager_) {
        _pm = poolManager_;
    }

    // ------------------------------------------------------------------ argument reads

    function _raise() internal view returns (uint256) {
        return _argUint(_A_RAISE, 16);
    }

    /// @dev D6: 0.1% of R (BoxSpecV1.GRADUATION_REWARD_CAP_BPS).
    function _reserveCap() internal view returns (uint256) {
        return _raise() * BoxSpecV1.GRADUATION_REWARD_CAP_BPS / _BPS;
    }

    function _minAdd() internal view returns (uint256) {
        return _raise() * _MIN_ADD_BPS / _BPS;
    }

    /// @dev The hook's ERC-6909 claims of Q and T on the PoolManager: the depth budget.
    function _depthBudget() internal view returns (uint256 qBudget, uint256 tBudget) {
        (address q_, address t_) = _argAddress2(_A_Q);
        qBudget = _pm.balanceOf(address(this), uint256(uint160(q_)));
        tBudget = _pm.balanceOf(address(this), uint256(uint160(t_)));
    }

    /// @dev Mints poked fees as claims: before graduation first the D6 reserve to the coordinator, the rest of Q and
    /// all of T to the receiver (the hook's positive deltas become their claims; the deltas net to zero).
    function _distribute(Args memory a, uint256 qFees, uint256 tFees, bool beforeGraduation)
        internal
        returns (uint256 toReserve)
    {
        if (beforeGraduation && qFees != 0) {
            uint256 minted = _reserveMinted;
            uint256 cap = _reserveCap();
            if (minted < cap) {
                toReserve = cap - minted < qFees ? cap - minted : qFees;
                _reserveMinted = minted + toReserve;
                _pm.mint(_argAddress(_A_COORDINATOR), uint256(uint160(a.q)), toReserve);
            }
        }
        address recv = _argAddress(_A_RECEIVER);
        if (qFees > toReserve) _pm.mint(recv, uint256(uint160(a.q)), qFees - toReserve);
        if (tFees != 0) _pm.mint(recv, uint256(uint160(a.token)), tFees);
    }

    /// @dev Collects one position's fees with a zero-liquidity `modifyLiquidity` (FitPoolHook.sol:754-766).
    function _poke(PoolKey memory key, int24 lower, int24 upper, bytes32 salt)
        internal
        returns (uint256 qFee, uint256 tFee)
    {
        (, BalanceDelta fees) = _pm.modifyLiquidity(
            key, ModifyLiquidityParams({tickLower: lower, tickUpper: upper, liquidityDelta: 0, salt: salt}), ""
        );
        // casting to 'uint128' is safe because accrued fees are never negative
        // forge-lint: disable-next-line(unsafe-typecast)
        qFee = uint256(uint128(fees.amount0()));
        // forge-lint: disable-next-line(unsafe-typecast)
        tFee = uint256(uint128(fees.amount1()));
    }

    function _initialised() internal view returns (uint256 w) {
        w = _w;
        if ((w >> _O_DEPLOY) & _M40 == 0) revert IBoxHook.NotInitialised();
    }

    /// @dev A nested unlock would revert in the PoolManager anyway (AlreadyUnlocked); this names it (BC-119).
    function _noForeignUnlock() internal view {
        if (_pm.exttload(_IS_UNLOCKED_SLOT) != bytes32(0)) revert IBoxHook.ForeignUnlock();
    }

    /// @dev Q, T, √P1 and √P0 in one copy (the hot path's arguments).
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

    function _args() internal view returns (Args memory a) {
        (a.q, a.token, a.sqrtP1, a.sqrtP0) = _hotArgs();
        a.tickLower = _argInt24(_A_TICK_LOWER);
        a.tickUpper = _argInt24(_A_TICK_UPPER);
    }

    function _key(Args memory a) internal view returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(a.q),
            currency1: Currency.wrap(a.token),
            fee: BoxSpecV1.LP_FEE,
            tickSpacing: BoxSpecV1.TICK_SPACING,
            hooks: IHooks(address(this))
        });
    }

    /// @dev keccak256(abi.encode(PoolKey)) without building the struct (PoolId.toId).
    function _poolIdOf(address q_, address t_) internal view returns (bytes32 id) {
        assembly ("memory-safe") {
            let p := mload(0x40)
            mstore(p, q_)
            mstore(add(p, 0x20), t_)
            mstore(add(p, 0x40), 10000) // LP_FEE
            mstore(add(p, 0x60), 60) // TICK_SPACING
            mstore(add(p, 0x80), address())
            id := keccak256(p, 0xa0)
        }
    }

    /// @dev The pool's Slot0 (StateLibrary: keccak256(poolId, POOLS_SLOT = 6)).
    function _slot0(bytes32 id) internal view returns (Slot0) {
        return Slot0.wrap(_pm.extsload(keccak256(abi.encodePacked(id, bytes32(uint256(6))))));
    }

    function _activeLiquidity(bytes32 id) internal view returns (uint128) {
        bytes32 stateSlot = keccak256(abi.encodePacked(id, bytes32(uint256(6))));
        return uint128(uint256(_pm.extsload(bytes32(uint256(stateSlot) + _LIQUIDITY_OFFSET))));
    }

    /// @dev This hook's position liquidity (Position.calculatePositionKey; StateLibrary's slot).
    function _positionLiquidity(bytes32 id, int24 lower, int24 upper, bytes32 salt) internal view returns (uint128) {
        bytes32 stateSlot = keccak256(abi.encodePacked(id, bytes32(uint256(6))));
        bytes32 positionKey = keccak256(abi.encodePacked(address(this), lower, upper, salt));
        bytes32 slot = keccak256(abi.encode(positionKey, uint256(stateSlot) + _POSITIONS_OFFSET));
        return uint128(uint256(_pm.extsload(slot)));
    }

    function _tipOf(uint256 amount) internal pure returns (uint256) {
        uint256 tip = amount * _TIP_BPS / _BPS;
        uint256 cap = _TIP_CAP;
        return tip < cap ? tip : cap;
    }

    /// @dev Pays `amount` T from the coordinator (which approved this hook) straight into the PoolManager and settles
    /// it (FitPoolHook.sol:378-380, :824-831): accepts no return data or ABI-encoded `true`.
    function _pullToken(address token_, uint256 amount) internal {
        _pm.sync(Currency.wrap(token_));
        if (token_.code.length == 0) revert TokenTransferFailed();
        (bool ok, bytes memory ret) =
            token_.call(abi.encodeWithSelector(0x23b872dd, _argAddress(_A_COORDINATOR), address(_pm), amount));
        if (!ok || (ret.length != 0 && (ret.length != 32 || abi.decode(ret, (uint256)) != 1))) {
            revert TokenTransferFailed();
        }
        _pm.settle();
    }
}
