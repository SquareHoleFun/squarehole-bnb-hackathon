// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Uniswap v4-core @ 46c68346, MIT files only (interfaces, types, libraries; DEPENDENCIES.md).
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/src/types/BeforeSwapDelta.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {BoxSpecV1} from "./BoxSpecV1.sol";
import {IBoxHook, IBoxPriceAverage} from "./interfaces/IBoxHook.sol";
import {BoxKind, BoxPhase, DeepenSkip, DepthKind} from "./interfaces/BoxTypes.sol";
import {BoxHookBase} from "./BoxHookBase.sol";
import {BoxClones} from "./libraries/BoxClones.sol";

/// @title BoxHook (slices S4 and S5; the implementation behind every box's hook clone, F61 A1, plan P7)
/// @notice See `IBoxHook` for the behaviour. Every box's hook is an EIP-1167 proxy with immutable arguments
/// (`BoxHookBase` lists them) at a CREATE2 address mined for flags 0x2AE0, running this code. It generalises
/// FitPoolHook (src/v2/FitPoolHook.sol:64-832) and the S0 spike (test/spikes/SpikeBoxHook.sol:33-724):
/// - **Kept from FitPoolHook:** the flags and permissions (`:154-156`, `:246-264`), the launch gate (`:545-560`), the
///   P0 floor (`:589-591`), the pokes (`:754-766`), the refused foreign initialise and donation (`:491-541`), the
///   state reads by `extsload` (`:768-799`); `launch`, `migrate` and the depth steps are in `BoxHookExtension`.
/// - **Changed for D1** (plan § 3.3): the block-end latch, the 32-block wait and the 10-tick band (`:699-721`) are
///   gone; the swap that ends at or beyond P1 closes the curve in its own `afterSwap`, and the gate applies only while
///   the curve is open (BC-096). **D2:** no fee work inside swaps (`:579-602` removed); `harvest()` pokes and mints in
///   batches. **D3:** no outside liquidity ever (`:501-531` replaced by a revert, as the spike `:429-451`). **D6:**
///   the graduation reserve is minted to the coordinator from the curve's Q fees. **L7, F64, F72, F77:** in the
///   extension; since F77 every box (box 0 included) deepens by pair and lock, so the hook has no rungs and does not
///   branch on the box kind (`kind` is a view and an `initialize` check).
/// - **Clone reads** (S0 § 1): the PoolManager, the coordinator implementation and the extension are immutables of this
///   code; everything
///   else is read from the clone's own code with one `EXTCODECOPY` of only the bytes a call needs; `deployBlock`,
///   `openAt` and the phase blocks share the one storage word every swap reads. After graduation `afterSwap`
///   returns before any argument read (S0's ≈ 450-gas trim, BC-018 under Glamsterdam).
/// @dev No owner, admin, pause, upgrade, setter, rescue, `receive` or `fallback` (F23 C2). The hook holds no ETH and
/// no T; its only balances are its ERC-6909 claims on the PoolManager, which are the depth budget. The one
/// DELEGATECALL target (`extension`) is fixed in this code, like the implementation behind the clone itself (A1).
contract BoxHook is IBoxHook, BoxHookBase {
    // ------------------------------------------------------------------ version constants

    /// @inheritdoc IBoxHook
    uint24 public constant LP_FEE = BoxSpecV1.LP_FEE;
    /// @inheritdoc IBoxHook
    int24 public constant TICK_SPACING = BoxSpecV1.TICK_SPACING;
    /// @inheritdoc IBoxHook
    uint256 public constant WINDOW_SECONDS = BoxSpecV1.WINDOW_SECONDS;
    /// @inheritdoc IBoxHook
    /// @dev beforeInitialize | beforeAddLiquidity | beforeRemoveLiquidity | beforeSwap | afterSwap | beforeDonate
    /// = 0x2AE0 (FitPoolHook.sol:154-156; BoxSpecV1.HOOK_FLAGS).
    uint160 public constant REQUIRED_FLAGS = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG
        | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
        | Hooks.BEFORE_DONATE_FLAG;
    /// @inheritdoc IBoxHook
    uint256 public constant DEEPEN_COOLDOWN_BLOCKS = _COOLDOWN;
    /// @inheritdoc IBoxHook
    int24 public constant MAX_DEVIATION_TICKS = _MAX_DEV;
    /// @notice One add takes at most this percentage of the Q the core holds within 10% of t_ref (BC-120).
    uint256 public constant ADD_CAP_PERCENT = _CAP_PCT;
    /// @notice The `deepen()` tip in basis points of the add (capped by `deepenTipCap()`).
    uint256 public constant DEEPEN_TIP_BPS = _TIP_BPS;
    /// @notice Length of the clone arguments.
    uint256 public constant ARGS_LENGTH = _ARGS_LENGTH;

    /// @inheritdoc IBoxHook
    /// @dev Only a clone of this code (whose `deploy` and `launch` only the factory can call) may `initialize` a hook
    /// clone, so a stranger's clone of this implementation stays inert (review of sh-core-v1; BC-100).
    address public immutable coordinatorImplementation;
    /// @notice The fixed code of `launch`, `migrate` and `deepen` (`BoxHookExtension`), run by DELEGATECALL in this
    /// clone's context.
    address public immutable extension;

    constructor(IPoolManager poolManager_, address coordinatorImplementation_, address extension_)
        BoxHookBase(poolManager_)
    {
        coordinatorImplementation = coordinatorImplementation_;
        extension = extension_;
        // The implementation itself is never a box: mark it initialised (deploy block 1) so `initialize` refuses it.
        _w = 1 << _O_DEPLOY;
    }

    // ================================================================== lifecycle and depth (forwarded)

    /// @inheritdoc IBoxHook
    function launch() external {
        _forward();
    }

    /// @inheritdoc IBoxHook
    function migrate(uint256) external returns (uint256, uint256, uint256, uint256) {
        _forward();
    }

    /// @inheritdoc IBoxHook
    function deepen(address) external returns (DepthKind, DeepenSkip, uint256, uint256, uint256) {
        _forward();
    }

    /// @notice PoolManager callback of this hook's own unlocks only (v4 calls back the caller of `unlock`): the
    /// harvest runs here, every other step in the extension.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(_pm)) revert NotPoolManager();
        if (uint256(bytes32(data[0:32])) != _ACT_HARVEST) _forward();
        (uint256 fq, uint256 ft, uint256 toReserve) = _harvestAll(_args());
        return abi.encode(fq, ft, toReserve);
    }

    /// @inheritdoc IBoxHook
    function initialize() external {
        if (msg.sender != _argAddress(_A_COORDINATOR) || !BoxClones.isCloneOf(msg.sender, coordinatorImplementation)) {
            revert NotCoordinator(msg.sender);
        }
        uint256 w = _w;
        if ((w >> _O_DEPLOY) & _M40 != 0) revert AlreadyInitialised();
        // Exactly the six flags and nothing else, no 0x91 prefix (FitPoolHook.sol:231-234).
        Hooks.validateHookPermissions(IHooks(address(this)), _permissions());
        if (uint160(address(this)) >> 152 == BoxSpecV1.HOOK_FORBIDDEN_ADDRESS_PREFIX) revert InvalidHookAddress();
        (address q_, address t_) = _argAddress2(_A_Q);
        if (q_ >= t_) revert QNotCurrency0(q_, t_);
        uint8 k = _argUint8(_A_KIND);
        if (k != uint8(BoxKind.Box0) && k != uint8(BoxKind.Standard)) revert UnknownKind(k);
        // The open is a clock time (F80; open-at-clock-time.md § 2.3). 0 (Now) or a time this block has reached opens
        // at this block's time + 1: never in the creation block, always in the next one (a block's timestamp exceeds
        // its parent's; 12 s more on Ethereum). The launch router and the tickets apply the same rule.
        uint256 open = _argUint(_A_OPEN_AT, 4);
        if (open <= block.timestamp) open = block.timestamp + 1;
        _w = (block.number << _O_DEPLOY) | (open << _O_OPEN);
    }

    /// @inheritdoc IBoxHook
    function harvest() external returns (uint256 qFees, uint256 tFees, uint256 qToReserve) {
        uint256 w = _initialised();
        if (msg.sender != _argAddress(_A_RECEIVER)) revert NotReceiver(msg.sender);
        if (w & _B_LAUNCHED == 0) revert NotInitialised();
        _noForeignUnlock();
        (qFees, tFees, qToReserve) =
            abi.decode(_pm.unlock(abi.encode(_ACT_HARVEST, bytes(""))), (uint256, uint256, uint256));
        emit Harvested(poolId(), qFees, tFees, qToReserve);
    }

    /// @notice Foreign initialisation with this hook always reverts; `launch` is the only initialiser (S0 decision 9).
    function beforeInitialize(address, PoolKey calldata, uint160) external view returns (bytes4) {
        if (msg.sender != address(_pm)) revert NotPoolManager();
        revert ForeignInitialize();
    }

    /// @notice Closed pool (D3; BC-032): no outside add, ever. The hook's own adds never reach here (noSelfCall).
    function beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        view
        returns (bytes4)
    {
        if (msg.sender != address(_pm)) revert NotPoolManager();
        revert LiquidityLocked();
    }

    /// @notice Closed pool (D3): no outside removal or poke (no outside position can exist).
    function beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        view
        returns (bytes4)
    {
        if (msg.sender != address(_pm)) revert NotPoolManager();
        revert LiquidityLocked();
    }

    /// @notice Donations would inflate fee growth without a trade.
    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external view returns (bytes4) {
        if (msg.sender != address(_pm)) revert NotPoolManager();
        revert DonationsDisabled();
    }

    /// @notice The gate (F33, F61 O1; FitPoolHook.sol:545-560), only while the curve is open (BC-096), on the block's
    /// time (F80): before `openAt` only the launch router and only in the creation block (the bootstrap and the creator
    /// buy); in [openAt, openAt + WINDOW_SECONDS) a buy (Q → T, `zeroForOne` since Q is currency0) only from the launch
    /// router; sells pass. Closed: every swap reverts until `migrate` (D1). After `migrate`: nothing. Changes no fee and
    /// no delta.
    function beforeSwap(address sender, PoolKey calldata, SwapParams calldata params, bytes calldata)
        external
        view
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        if (msg.sender != address(_pm)) revert NotPoolManager();
        uint256 w = _w;
        if ((w >> _O_MIGRATED) & _M40 == 0) {
            uint256 closedAt = (w >> _O_CLOSED) & _M40;
            if (closedAt != 0) revert CurveIsClosed(closedAt);
            uint256 open = (w >> _O_OPEN) & _M40;
            if (block.timestamp < open + WINDOW_SECONDS) {
                address router = _argAddress(_A_ROUTER);
                if (block.timestamp < open) {
                    if (sender != router || block.number != (w >> _O_DEPLOY) & _M40) revert TradingNotOpen(open);
                } else if (params.zeroForOne && sender != router) {
                    revert BuyThroughLaunchRouter(router, open + WINDOW_SECONDS);
                }
            }
        }
        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    /// @notice During the curve: the P0 floor (FitPoolHook.sol:589-591) and close on fill (D1): the swap that ends at
    /// or beyond P1 sets `closedAtBlock` here, in its own `afterSwap`. After `migrate` it returns at once (S0's trim:
    /// the key check is defence in depth, `beforeInitialize` already refuses every foreign pool).
    function afterSwap(address, PoolKey calldata key, SwapParams calldata, BalanceDelta, bytes calldata)
        external
        returns (bytes4, int128)
    {
        if (msg.sender != address(_pm)) revert NotPoolManager();
        uint256 w = _w;
        if ((w >> _O_MIGRATED) & _M40 == 0) {
            (address q_, address t_, uint160 sqrtP1, uint160 sqrtP0) = _hotArgs();
            if (
                Currency.unwrap(key.currency0) != q_ || Currency.unwrap(key.currency1) != t_ || key.fee != LP_FEE
                    || key.tickSpacing != TICK_SPACING || address(key.hooks) != address(this)
            ) revert UnknownPool();
            bytes32 id = _poolIdOf(q_, t_);
            uint160 sqrtP = _slot0(id).sqrtPriceX96();
            if (sqrtP > sqrtP0) revert BelowCurveFloor(sqrtP);
            if (sqrtP <= sqrtP1) {
                _w = w | (block.number << _O_CLOSED);
                emit CurveClosed(PoolId.wrap(id), block.number, sqrtP);
            }
        }
        return (IHooks.afterSwap.selector, 0);
    }

    /// @dev Never called: the corresponding flags are not in the address.
    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    /// @inheritdoc IBoxHook
    function poolManager() external view returns (IPoolManager) {
        return _pm;
    }

    /// @inheritdoc IBoxHook
    function poolKey() external view returns (PoolKey memory) {
        return _key(_args());
    }

    /// @inheritdoc IBoxHook
    function poolId() public view returns (PoolId) {
        (address q_, address t_) = _argAddress2(_A_Q);
        return PoolId.wrap(_poolIdOf(q_, t_));
    }

    /// @inheritdoc IBoxHook
    function kind() external view returns (BoxKind) {
        return BoxKind(_argUint(_A_KIND, 1));
    }

    /// @inheritdoc IBoxHook
    function token() external view returns (address) {
        return _argAddress(_A_TOKEN);
    }

    /// @inheritdoc IBoxHook
    function q() external view returns (address) {
        return _argAddress(_A_Q);
    }

    /// @inheritdoc IBoxHook
    function coordinator() external view returns (address) {
        return _argAddress(_A_COORDINATOR);
    }

    /// @inheritdoc IBoxHook
    function receiver() external view returns (address) {
        return _argAddress(_A_RECEIVER);
    }

    /// @inheritdoc IBoxHook
    function launchRouter() external view returns (address) {
        return _argAddress(_A_ROUTER);
    }

    /// @inheritdoc IBoxHook
    function priceAverage() external view returns (IBoxPriceAverage) {
        return IBoxPriceAverage(_argAddress(_A_AVERAGE));
    }

    /// @inheritdoc IBoxHook
    function raise() external view returns (uint256) {
        return _raise();
    }

    /// @inheritdoc IBoxHook
    function phase() external view returns (BoxPhase) {
        uint256 w = _w;
        if ((w >> _O_DEPLOY) & _M40 == 0 || w & _B_LAUNCHED == 0) {
            return (w >> _O_DEPLOY) & _M40 == 0 ? BoxPhase.None : BoxPhase.Upcoming;
        }
        if ((w >> _O_MIGRATED) & _M40 != 0) return BoxPhase.Graduated;
        if ((w >> _O_CLOSED) & _M40 != 0) return BoxPhase.Closed;
        uint256 open = (w >> _O_OPEN) & _M40;
        if (block.timestamp < open) return BoxPhase.Upcoming;
        return block.timestamp < open + WINDOW_SECONDS ? BoxPhase.Window : BoxPhase.Bonding;
    }

    /// @inheritdoc IBoxHook
    function deployBlock() external view returns (uint256) {
        return (_w >> _O_DEPLOY) & _M40;
    }

    /// @inheritdoc IBoxHook
    function openAt() public view returns (uint256) {
        return (_w >> _O_OPEN) & _M40;
    }

    /// @inheritdoc IBoxHook
    function windowEndsAt() external view returns (uint256) {
        return openAt() + WINDOW_SECONDS;
    }

    /// @inheritdoc IBoxHook
    function closed() external view returns (bool) {
        return (_w >> _O_CLOSED) & _M40 != 0;
    }

    /// @inheritdoc IBoxHook
    function closedAtBlock() external view returns (uint256) {
        return (_w >> _O_CLOSED) & _M40;
    }

    /// @inheritdoc IBoxHook
    function migratedAtBlock() external view returns (uint256) {
        return (_w >> _O_MIGRATED) & _M40;
    }

    /// @inheritdoc IBoxHook
    function curve() external view returns (int24 tickLower, int24 tickUpper, uint128 liquidity) {
        tickLower = _argInt24(_A_TICK_LOWER);
        tickUpper = _argInt24(_A_TICK_UPPER);
        uint256 w = _w;
        if (w & _B_LAUNCHED != 0 && (w >> _O_MIGRATED) & _M40 == 0) liquidity = _argUint128(_A_LIQUIDITY);
    }

    /// @inheritdoc IBoxHook
    function graduatedLayout()
        external
        view
        returns (uint128 askLiquidity, uint128 bidLiquidity, uint128 sentinelLiquidity)
    {
        bytes32 id = PoolId.unwrap(poolId());
        int24 lo = _argInt24(_A_TICK_LOWER);
        int24 hi = _argInt24(_A_TICK_UPPER);
        askLiquidity = _positionLiquidity(id, BoxSpecV1.MIN_USABLE_TICK, lo, _SALT_L7);
        bidLiquidity = _positionLiquidity(id, lo, BoxSpecV1.MAX_USABLE_TICK, _SALT_L7);
        sentinelLiquidity = _positionLiquidity(id, hi, BoxSpecV1.MAX_USABLE_TICK, _SALT_L7);
    }

    /// @inheritdoc IBoxHook
    function reserveCap() external view returns (uint256) {
        return _reserveCap();
    }

    /// @inheritdoc IBoxHook
    function reserveMinted() external view returns (uint256) {
        return _reserveMinted;
    }

    /// @inheritdoc IBoxHook
    function depthBudget() external view returns (uint256 qBudget, uint256 tBudget) {
        return _depthBudget();
    }

    /// @inheritdoc IBoxHook
    function lastDeepenBlock() external view returns (uint256) {
        return (_w >> _O_DEEPEN) & _M40;
    }

    /// @inheritdoc IBoxHook
    function pairedLiquidity() external view returns (uint128) {
        return
            _positionLiquidity(
                PoolId.unwrap(poolId()), BoxSpecV1.MIN_USABLE_TICK, BoxSpecV1.MAX_USABLE_TICK, _SALT_PAIR
            );
    }

    /// @inheritdoc IBoxHook
    function minAdd() external view returns (uint256) {
        return _minAdd();
    }

    /// @inheritdoc IBoxHook
    /// @dev P: the D2 tip cap (BoxSpecV1.FEE_BATCH_TIP_MAX_ETH) until BC-017's gas measurement re-sizes both.
    function deepenTipCap() external pure returns (uint256) {
        return _TIP_CAP;
    }

    /// @notice The permission set encoded in this hook's address.
    function getHookPermissions() external pure returns (Hooks.Permissions memory) {
        return _permissions();
    }

    // ================================================================== internals

    /// @dev Runs the current call's calldata in the extension by DELEGATECALL and returns or reverts with its data.
    function _forward() private {
        address ext = extension;
        assembly {
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), ext, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            if iszero(ok) { revert(0, returndatasize()) }
            return(0, returndatasize())
        }
    }

    /// @dev `harvest`'s unlock: pokes every position that can hold fees and mints them (BC-017, BC-122): before
    /// graduation the curve; after it at most four (the ask, the bid, the sentinel and the pair; no loop).
    function _harvestAll(Args memory a) private returns (uint256 qFees, uint256 tFees, uint256 qToReserve) {
        PoolKey memory key = _key(a);
        uint256 w = _w;
        uint256 fq;
        uint256 ft;
        if ((w >> _O_MIGRATED) & _M40 == 0) {
            (qFees, tFees) = _poke(key, a.tickLower, a.tickUpper, _SALT_CURVE);
            qToReserve = _distribute(a, qFees, tFees, true);
            return (qFees, tFees, qToReserve);
        }
        if (w & _B_ASK != 0) (qFees, tFees) = _poke(key, BoxSpecV1.MIN_USABLE_TICK, a.tickLower, _SALT_L7);
        if (w & _B_BID != 0) {
            (fq, ft) = _poke(key, a.tickLower, BoxSpecV1.MAX_USABLE_TICK, _SALT_L7);
            (qFees, tFees) = (qFees + fq, tFees + ft);
        }
        if (w & _B_SENTINEL != 0) {
            (fq, ft) = _poke(key, a.tickUpper, BoxSpecV1.MAX_USABLE_TICK, _SALT_L7);
            (qFees, tFees) = (qFees + fq, tFees + ft);
        }
        if (w & _B_PAIR != 0) {
            (fq, ft) = _poke(key, BoxSpecV1.MIN_USABLE_TICK, BoxSpecV1.MAX_USABLE_TICK, _SALT_PAIR);
            (qFees, tFees) = (qFees + fq, tFees + ft);
        }
        _distribute(a, qFees, tFees, false);
    }

    function _permissions() private pure returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: true,
            afterInitialize: false,
            beforeAddLiquidity: true,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: true,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: true,
            beforeDonate: true,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }
}
