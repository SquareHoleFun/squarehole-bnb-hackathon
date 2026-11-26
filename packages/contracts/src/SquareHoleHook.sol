// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Uniswap v4-core @ 46c68346, MIT files only (interfaces, types, Hooks library; see DEPENDENCIES.md).
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta} from "v4-core/src/types/BeforeSwapDelta.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {IFeeCollector} from "./interfaces/IFeeCollector.sol";
import {SafeERC20Lite} from "./libraries/SafeERC20Lite.sol";

/// @title SquareHoleHook
/// @notice The Uniswap v4 hook of every Square Hole pool (Path A, fee form A1; ADR-0006, ADR-0011). One immutable
/// instance per deployment serves many pools; each pool is registered once by the immutable launcher.
/// - The pool has a static 3% LP fee (30,000 pips). The hook has NO return-delta flag and no dynamic fee, so it
///   matches Uniswap's auto-admission rule; its address never starts with 0x91 (checked at construction).
/// - The only liquidity is the protocol-owned launch position, owned by this hook: single-sided T over the
///   template's range, principal permanently locked (there is no code path that removes it).
/// - At every swap, `afterSwap` collects exactly the fees that swap accrued to the position (a zero-liquidity
///   `modifyLiquidity`, which never touches principal), turns them into ERC-6909 claims on the PoolManager and
///   delivers them to the launch's fee collector, which burns native T and splits Q at that moment (ECO-09).
/// - Foreign `initialize`, `addLiquidity`, `removeLiquidity` and `donate` revert. v4 never calls a hook for actions
///   the hook performs itself (`Hooks.noSelfCall`), so the hook's own initialize/seed/collect calls pass.
/// @dev No owner, no admin, no upgrade, no arbitrary calls, no ERC-20 transfer inside a swap.
contract SquareHoleHook is IHooks, IUnlockCallback {
    /// @notice Per-pool registration, written once by `launchPool`.
    struct PoolConfig {
        address collector; // the launch's FeeCollector (fee source = this hook)
        int24 tickLower; // the protocol-owned position's range
        int24 tickUpper;
        bool tIsCurrency0; // orientation of T in the PoolKey
    }

    event PoolLaunched(
        PoolId indexed poolId,
        address indexed token,
        address indexed collector,
        int24 tickLower,
        int24 tickUpper,
        uint128 liquidity,
        uint160 sqrtPriceX96,
        uint256 tDeposited
    );

    error NotPoolManager();
    error NotLauncher();
    error InvalidHookAddress();
    error InvalidLaunch();
    error PoolAlreadyLaunched();
    error UnknownPool();
    error ForeignInitialize();
    error LiquidityLocked();
    error DonationsDisabled();
    error HookNotImplemented();

    /// @notice Static LP fee of every Square Hole pool: 3% (30,000 pips, below Uniswap's 11% auto-admission cap).
    uint24 public constant LP_FEE = 30_000;
    /// @notice Salt of the protocol-owned position (one position per pool).
    bytes32 public constant POSITION_SALT = bytes32(0);
    /// @notice Low 14 address bits this hook must have: beforeInitialize | beforeAddLiquidity |
    /// beforeRemoveLiquidity | afterSwap | beforeDonate = 0x2A60. No return-delta flag.
    uint160 public constant REQUIRED_FLAGS = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG
        | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_DONATE_FLAG;

    IPoolManager public immutable poolManager;
    /// @notice The only address that can register (initialize and seed) pools.
    address public immutable launcher;

    mapping(PoolId => PoolConfig) private _pools;

    constructor(IPoolManager poolManager_, address launcher_) {
        if (address(poolManager_) == address(0) || launcher_ == address(0)) revert InvalidLaunch();
        // Exactly the five flags above and nothing else (a mined CREATE2 address).
        Hooks.validateHookPermissions(IHooks(address(this)), getHookPermissions());
        // Uniswap's routing policy treats a 0x91 address prefix differently (ADR-0006 context 3).
        if (uint160(address(this)) >> 152 == 0x91) revert InvalidHookAddress();
        poolManager = poolManager_;
        launcher = launcher_;
    }

    /// @notice The permission set encoded in this hook's address.
    function getHookPermissions() public pure returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: true,
            afterInitialize: false,
            beforeAddLiquidity: true,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: true,
            afterRemoveLiquidity: false,
            beforeSwap: false,
            afterSwap: true,
            beforeDonate: true,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        _;
    }

    /*//////////////////////////////////////////////////////////////
                               LAUNCH
    //////////////////////////////////////////////////////////////*/

    /// @notice Arguments of `launchPool` (computed by the launcher from the registry template, LaunchMath).
    struct LaunchPoolParams {
        PoolKey key;
        uint160 sqrtPriceX96; // initial price: the T-only end of the range
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        address collector;
    }

    /// @notice Initializes `p.key` at `p.sqrtPriceX96` and seeds the protocol-owned single-sided T position with
    /// `p.liquidity` over [tickLower, tickUpper], paid from this hook's T balance (T's initial holder is this hook).
    /// @dev Launcher only. The Q side of the seed must be zero (single-sided); T left over by liquidity rounding
    /// stays in this hook (an excluded role) and never circulates. Returns the T deposited.
    function launchPool(LaunchPoolParams calldata p) external returns (uint256 tDeposited) {
        if (msg.sender != launcher) revert NotLauncher();
        (address token, bool tIsCurrency0) = _checkLaunch(p);
        PoolId id = p.key.toId();
        if (_pools[id].collector != address(0)) revert PoolAlreadyLaunched();
        _pools[id] = PoolConfig(p.collector, p.tickLower, p.tickUpper, tIsCurrency0);

        // Self-initiated: v4 skips this hook's beforeInitialize (Hooks.noSelfCall).
        poolManager.initialize(p.key, p.sqrtPriceX96);
        tDeposited =
            abi.decode(poolManager.unlock(abi.encode(p.key, p.tickLower, p.tickUpper, p.liquidity, token)), (uint256));
        emit PoolLaunched(id, token, p.collector, p.tickLower, p.tickUpper, p.liquidity, p.sqrtPriceX96, tDeposited);
    }

    /// @dev The key must name this hook, the static fee, and exactly the collector's T and Q.
    function _checkLaunch(LaunchPoolParams calldata p) private view returns (address token, bool tIsCurrency0) {
        if (address(p.key.hooks) != address(this) || p.key.fee != LP_FEE || p.liquidity == 0) revert InvalidLaunch();
        IFeeCollector c = IFeeCollector(p.collector);
        token = c.token();
        address quote = c.quote();
        if (c.feeSource() != address(this) || c.poolManager() != address(poolManager)) revert InvalidLaunch();
        address currency0 = Currency.unwrap(p.key.currency0);
        address currency1 = Currency.unwrap(p.key.currency1);
        tIsCurrency0 = currency0 == token;
        if (tIsCurrency0 ? currency1 != quote : (currency1 != token || currency0 != quote)) revert InvalidLaunch();
    }

    /// @notice PoolManager callback of `launchPool`'s unlock: adds the position and pays its T.
    function unlockCallback(bytes calldata data) external onlyPoolManager returns (bytes memory) {
        (PoolKey memory key, int24 tickLower, int24 tickUpper, uint128 liquidity, address token) =
            abi.decode(data, (PoolKey, int24, int24, uint128, address));
        // Only a pool registered in this transaction's launchPool can reach here with a fresh position.
        if (_pools[key.toId()].collector == address(0)) revert UnknownPool();
        (BalanceDelta delta,) = poolManager.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: tickLower,
                tickUpper: tickUpper,
                liquidityDelta: int256(uint256(liquidity)),
                salt: POSITION_SALT
            }),
            ""
        );
        bool tIsCurrency0 = Currency.unwrap(key.currency0) == token;
        int128 tDelta = tIsCurrency0 ? delta.amount0() : delta.amount1();
        int128 qDelta = tIsCurrency0 ? delta.amount1() : delta.amount0();
        // Single-sided T only: the launch never asks anyone for Q (no first buy, no creator deposit).
        if (qDelta != 0 || tDelta >= 0) revert InvalidLaunch();
        // casting to 'uint128' is safe because tDelta < 0 was checked above (-tDelta > 0, fits in 127 bits)
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 owed = uint256(uint128(-tDelta));
        poolManager.sync(Currency.wrap(token));
        SafeERC20Lite.safeTransfer(token, address(poolManager), owed);
        poolManager.settle();
        return abi.encode(owed);
    }

    /*//////////////////////////////////////////////////////////////
                            HOOK CALLBACKS
    //////////////////////////////////////////////////////////////*/

    /// @notice Foreign pool initialization with this hook always reverts: legitimate pools are initialized by this
    /// hook itself inside `launchPool` (launcher only), which v4 does not call back.
    function beforeInitialize(address, PoolKey calldata, uint160) external view onlyPoolManager returns (bytes4) {
        revert ForeignInitialize();
    }

    /// @notice Only the protocol-owned launch position (added by this hook itself) may exist.
    function beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        view
        onlyPoolManager
        returns (bytes4)
    {
        revert LiquidityLocked();
    }

    /// @notice Launch liquidity principal is permanently locked; nobody else has a position to remove. The hook's own
    /// zero-liquidity fee collection is self-initiated and not called back.
    function beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        view
        onlyPoolManager
        returns (bytes4)
    {
        revert LiquidityLocked();
    }

    /// @notice Donations would inflate fee growth without a trade (v4-core Pool.sol warns about single-position
    /// pools); they are never fee events.
    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        view
        onlyPoolManager
        returns (bytes4)
    {
        revert DonationsDisabled();
    }

    /// @notice Fee attribution at swap time. Collects the fees this swap accrued to the protocol-owned position
    /// (Pool.sol fee growth × position liquidity, floor), mints them as ERC-6909 claims to this hook, grants the
    /// collector an exact allowance and calls `receiveFees`, which pulls the claims, burns-to-be native T, splits Q
    /// and indexes holder Q before the swap's settle/take (the B1 flash-guard ordering).
    /// @dev Fail-closed: any failure reverts the swap. There is no ERC-20 or other third-party code on this path
    /// (only PoolManager accounting and the launch's own collector and ledger), so an issuer pause, denylist or
    /// transfer hook cannot brick a pool. Reverts that remain: the collector/ledger reentrancy lock (a swap started
    /// from inside a claim/payout callback of the same launch), the ledger's lifetime holder-Q cap (2^128 − 1) and
    /// the ledger's fail-closed flash guard (`PoolOutflowAtFeeEvent`: a buy after a take of T in the same
    /// transaction).
    function afterSwap(address, PoolKey calldata key, SwapParams calldata, BalanceDelta, bytes calldata)
        external
        onlyPoolManager
        returns (bytes4, int128)
    {
        PoolConfig memory config = _pools[key.toId()];
        if (config.collector == address(0)) revert UnknownPool();
        (, BalanceDelta fees) = poolManager.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: config.tickLower, tickUpper: config.tickUpper, liquidityDelta: 0, salt: POSITION_SALT
            }),
            ""
        );
        // casting to 'uint128' is safe because accrued fees are never negative (Pool.sol: feesOwed.toInt128())
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 fee0 = uint256(uint128(fees.amount0()));
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 fee1 = uint256(uint128(fees.amount1()));
        if (fee0 | fee1 != 0) {
            if (fee0 != 0) _mintClaimsFor(key.currency0, config.collector, fee0);
            if (fee1 != 0) _mintClaimsFor(key.currency1, config.collector, fee1);
            (uint256 tFee, uint256 qFee) = config.tIsCurrency0 ? (fee0, fee1) : (fee1, fee0);
            IFeeCollector(config.collector).receiveFees(tFee, qFee);
        }
        return (IHooks.afterSwap.selector, 0);
    }

    /// @dev Converts this hook's positive delta (the collected fee) into claims held by this hook and approves the
    /// collector for exactly that amount; the collector's pull brings the hook's claims and allowance back to zero.
    function _mintClaimsFor(Currency currency, address collector, uint256 amount) private {
        uint256 id = currency.toId();
        poolManager.mint(address(this), id, amount);
        poolManager.approve(collector, id, amount);
    }

    /// @dev Never called: the corresponding flags are not in this hook's address.
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

    function beforeSwap(address, PoolKey calldata, SwapParams calldata, bytes calldata)
        external
        pure
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        revert HookNotImplemented();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    /*//////////////////////////////////////////////////////////////
                                 VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @notice Registration of `poolId` (zero collector = not a Square Hole pool).
    function poolConfig(PoolId poolId) external view returns (PoolConfig memory) {
        return _pools[poolId];
    }
}
