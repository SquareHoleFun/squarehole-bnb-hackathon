// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Uniswap v4-core @ 46c68346, MIT files only (interfaces, types; DEPENDENCIES.md).
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {TransientReentrancyGuard} from "../libraries/TransientReentrancyGuard.sol";
import {BoxSpecV1} from "./BoxSpecV1.sol";
import {IBoxHook} from "./interfaces/IBoxHook.sol";
import {IBoxLaunchRouter} from "./interfaces/IBoxLaunchRouter.sol";
import {BoxKind} from "./interfaces/BoxTypes.sol";
import {BoxCloneReader} from "./BoxCloneReader.sol";
import {BoxClones} from "./libraries/BoxClones.sol";

/// @title BoxLaunchRouter (slice S4; the implementation behind every box's launch-router clone)
/// @notice See `IBoxLaunchRouter` for the behaviour. A copy of LaunchTaxRouter (src/v2/LaunchTaxRouter.sol:55-313):
/// the window and tax table (`:91-94`, `:204-254`, the same 32 entries, BoxSpecV1.LAUNCH_TAX_TABLE_HASH), the
/// refusals (`:147-153`, `:297-302`), the untaxed bootstrap (`:167-178`) and the swap through the PoolManager
/// (`:262-295`), with:
/// - **D1** (plan § 3.2; BC-096, BC-022): the swap's price limit is P1, and a buy that reaches it (and so closes the
///   curve in the hook's `afterSwap`) keeps its partial fill: the router keeps the tax only on the input that entered
///   the curve and refunds the unspent input and the tax on it to the payer in the same call (LaunchTaxRouter
///   refused such a buy whole, `:81-81`, `:283`). After the close it refuses (`CurveIsClosed`).
/// - **The creator buy** (F61 O2; BC-116): once, by the coordinator, after the bootstrap and before the open,
///   untaxed, T to the creator, refused when it would reach P1.
/// - **The tax's destination, one rule for every box** (F68 (2a); F77 extends it to box 0 and supersedes (1b)): held
///   until graduation, then settled into the PoolManager and minted as Q claims to the box's hook, its depth budget
///   (BC-110, BC-140); at a failure (version 2, S11) the refund range. Never the Safe, never FIT. Box 0 has no failure
///   path, so its tax stays here for good if it never graduates. The router branches on the box kind only to refuse
///   box 0 a creator buy.
/// - **v1 serves native-ETH Q** (`qIn == msg.value`); ERC-20 Q is S12's (`QNotSupported` at `initialize`), with no
///   new function: `buy` already takes `qIn`.
///
/// - **The window on the clock** (F80; docs/design/open-at-clock-time.md): `buy` from `openAt` for WINDOW_SECONDS (384
///   s), the table indexed by the 12-second step (block.timestamp − openAt) / 12; `openAt` follows the hook's rule
///   (BoxHook.initialize), so router and hook always agree.
///
/// **Clone arguments** (`abi.encodePacked`, 105 bytes): `kind` (1) · `q` (20) · `token` (20) · `hook` (20) ·
/// `coordinator` (20) · √P1 (20) · `openAt` (4: BoxSpec field 15, uint32 Unix seconds, 0 = Now). No Safe: no router
/// pays the platform (F77).
/// @dev No owner, admin, pause, upgrade, setter, rescue, `receive` or `fallback` (plain ETH is refused; forced ETH is
/// swept with the tax). Holds only unswept tax (BC-022).
contract BoxLaunchRouter is IBoxLaunchRouter, TransientReentrancyGuard, BoxCloneReader {
    /// @notice v1 routes only native-ETH Q (S12 adds ERC-20 Q).
    error QNotSupported(address q);
    error UnknownKind(uint8 kind);
    /// @notice Box 0's spec carries no creator buy (BC-116: MUST_BE_ZERO).
    error NoCreatorBuy();
    error NotInitialised();
    error InputNotFullySpent(uint256 spent, uint256 swapIn);

    /// @notice The window's steps, one per entry of the tax table (BoxSpecV1.WINDOW_STEPS, 32).
    uint256 public constant WINDOW_STEPS = BoxSpecV1.WINDOW_STEPS;
    /// @notice One step's length in seconds, one Ethereum slot (BoxSpecV1.TAX_STEP_SECONDS, 12; F80).
    uint256 public constant TAX_STEP_SECONDS = BoxSpecV1.TAX_STEP_SECONDS;
    /// @notice The window's length in seconds, WINDOW_STEPS × TAX_STEP_SECONDS (BoxSpecV1.WINDOW_SECONDS, 384).
    uint256 public constant WINDOW_SECONDS = BoxSpecV1.WINDOW_SECONDS;
    /// @notice Denominator of the table's entries (pips: 10^6 = 100%).
    uint256 public constant PIPS = 1_000_000;
    /// @notice Length of the clone arguments.
    uint256 public constant ARGS_LENGTH = 105;

    uint256 private constant _A_KIND = 0;
    uint256 private constant _A_Q = 1;
    uint256 private constant _A_TOKEN = 21;
    uint256 private constant _A_HOOK = 41;
    uint256 private constant _A_COORDINATOR = 61;
    uint256 private constant _A_SQRT_P1 = 81;
    uint256 private constant _A_OPEN_AT = 101;

    uint8 private constant _ACT_SWAP = 1;
    uint8 private constant _ACT_SWEEP = 2;

    uint256 private constant _M40 = (1 << 40) - 1;
    uint256 private constant _B_BOOTSTRAPPED = 1 << 40;
    uint256 private constant _B_CREATOR_BOUGHT = 1 << 41;

    IPoolManager public immutable poolManager;
    /// @inheritdoc IBoxLaunchRouter
    address public immutable coordinatorImplementation;

    /// @dev openAt (low 40 bits, Unix seconds; 0 until `initialize`), bootstrapped, creatorBought.
    uint256 internal _s;
    /// @dev Lifetime totals, raw Q units: tax kept (low 128 bits), swept (high 128 bits).
    uint256 internal _totals;

    constructor(IPoolManager poolManager_, address coordinatorImplementation_) {
        poolManager = poolManager_;
        coordinatorImplementation = coordinatorImplementation_;
        // The implementation is never a box's router: a non-zero open (1, in 1970) makes `initialize` refuse, and its
        // window is long past.
        _s = 1;
    }

    // ================================================================== lifecycle (coordinator)

    /// @inheritdoc IBoxLaunchRouter
    function initialize() external {
        // Only the box's coordinator, a clone of the version's coordinator code (BC-100; review of sh-core-v1).
        if (msg.sender != _argAddress(_A_COORDINATOR) || !BoxClones.isCloneOf(msg.sender, coordinatorImplementation)) {
            revert NotCoordinator(msg.sender);
        }
        if (_s & _M40 != 0) revert AlreadyInitialised();
        uint8 k = _argUint8(_A_KIND);
        if (k != uint8(BoxKind.Box0) && k != uint8(BoxKind.Standard)) revert UnknownKind(k);
        address q_ = _argAddress(_A_Q);
        if (q_ != address(0)) revert QNotSupported(q_);
        // The hook's rule (BoxHook.initialize): 0 (Now) or a time this block has reached opens in the next block.
        uint256 open = _argUint(_A_OPEN_AT, 4);
        _s = open <= block.timestamp ? block.timestamp + 1 : open;
    }

    /// @inheritdoc IBoxLaunchRouter
    function bootstrap() external payable nonReentrant returns (uint256 tokensOut) {
        uint256 s = _initialised();
        if (msg.sender != _argAddress(_A_COORDINATOR)) revert NotCoordinator(msg.sender);
        if (s & _B_BOOTSTRAPPED != 0) revert AlreadyBootstrapped();
        uint256 open = s & _M40;
        if (block.timestamp >= open) revert AfterOpen(open);
        if (msg.value != BoxSpecV1.BOOTSTRAP_ETH) revert WrongValue(msg.value, BoxSpecV1.BOOTSTRAP_ETH);
        _s = s | _B_BOOTSTRAPPED;
        uint256 spent;
        (spent, tokensOut) = _swap(msg.value, msg.sender);
        if (spent != msg.value) revert InputNotFullySpent(spent, msg.value);
        if (tokensOut == 0) revert AmountTooSmall();
        emit Bootstrapped(msg.sender, msg.value, tokensOut);
    }

    /// @inheritdoc IBoxLaunchRouter
    function creatorBuy(address creator, uint256 qIn) external payable nonReentrant returns (uint256 tokensOut) {
        uint256 s = _initialised();
        if (msg.sender != _argAddress(_A_COORDINATOR)) revert NotCoordinator(msg.sender);
        if (_argUint(_A_KIND, 1) != uint8(BoxKind.Standard)) revert NoCreatorBuy();
        if (s & _B_BOOTSTRAPPED == 0) revert NotBootstrapped();
        if (s & _B_CREATOR_BOUGHT != 0) revert AlreadyCreatorBought();
        uint256 open = s & _M40;
        if (block.timestamp >= open) revert AfterOpen(open);
        _checkRecipient(creator);
        if (qIn == 0) revert AmountTooSmall();
        if (msg.value != qIn) revert WrongValue(msg.value, qIn);
        _s = s | _B_CREATOR_BOUGHT;
        uint256 spent;
        (spent, tokensOut) = _swap(qIn, creator);
        // It must stay below P1 (below the raise, BC-116): reaching P1 would close the curve at creation.
        if (spent != qIn || IBoxHook(_argAddress(_A_HOOK)).closed()) revert CreatorBuyClosesCurve();
        if (tokensOut == 0) revert AmountTooSmall();
        emit CreatorBought(creator, qIn, tokensOut);
    }

    // ================================================================== the window

    /// @inheritdoc IBoxLaunchRouter
    function buy(uint256 qIn, uint256 minTokensOut, address recipient, uint256 deadline)
        external
        payable
        nonReentrant
        returns (uint256 tokensOut)
    {
        if (block.timestamp > deadline) revert Expired(deadline);
        _checkRecipient(recipient);
        if (msg.value != qIn) revert WrongValue(msg.value, qIn);
        uint256 step = _windowStep(_initialised());
        if (IBoxHook(_argAddress(_A_HOOK)).closed()) revert CurveIsClosed();
        uint256 pips = taxPips(step);
        uint256 tax = _ceilTax(qIn, pips);
        uint256 swapIn = qIn - tax;
        if (swapIn == 0) revert AmountTooSmall();
        uint256 spent;
        (spent, tokensOut) = _swap(swapIn, recipient);
        uint256 refund;
        if (spent != swapIn) {
            // The closing fill (D1): the swap stopped at P1. Tax only on the input that entered the curve, at the same
            // rate of the gross (tax / (gross − tax) = pips / (PIPS − pips)); the rest goes back to the payer.
            uint256 kept = (spent * pips + (PIPS - pips) - 1) / (PIPS - pips);
            if (kept < tax) tax = kept;
            refund = qIn - spent - tax;
        }
        if (tokensOut == 0) revert AmountTooSmall();
        if (tokensOut < minTokensOut) revert InsufficientOutput(tokensOut, minTokensOut);
        _totals += tax;
        emit TaxedBuy(msg.sender, recipient, step, qIn, tax, tokensOut, refund);
        if (refund != 0) {
            (bool ok,) = msg.sender.call{value: refund}("");
            if (!ok) revert RefundFailed();
        }
    }

    /// @inheritdoc IBoxLaunchRouter
    function sweep() external nonReentrant returns (uint256 amount) {
        _initialised();
        amount = address(this).balance;
        if (amount == 0) revert NothingToSweep();
        // Every box (box 0 since F77): the tax waits for graduation, then becomes the hook's Q claims.
        address hook_ = _argAddress(_A_HOOK);
        if (IBoxHook(hook_).migratedAtBlock() == 0) revert NotGraduated();
        _totals += amount << 128;
        emit Swept(hook_, amount, true);
        poolManager.unlock(abi.encode(_ACT_SWEEP, abi.encode(amount, hook_)));
    }

    /// @notice PoolManager callback of this router's own unlocks (inside its guarded `buy`, `bootstrap`,
    /// `creatorBuy` or `sweep` only).
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager) || !_insideGuardedCall()) revert NotPoolManager();
        (uint8 action, bytes memory arg) = abi.decode(data, (uint8, bytes));
        if (action == _ACT_SWEEP) {
            (uint256 amount, address hook_) = abi.decode(arg, (uint256, address));
            // The tax becomes the hook's Q claims: its depth budget (F68 (2a), F77).
            poolManager.sync(Currency.wrap(address(0)));
            if (poolManager.settle{value: amount}() != amount) revert UnexpectedDelta();
            poolManager.mint(hook_, 0, amount);
            return "";
        }
        (uint256 qIn, address recipient) = abi.decode(arg, (uint256, address));
        BalanceDelta delta = poolManager.swap(
            _poolKey(),
            SwapParams({
                zeroForOne: true,
                // casting to 'int256' is safe because qIn ≤ msg.value, far below 2^255
                // forge-lint: disable-next-line(unsafe-typecast)
                amountSpecified: -int256(qIn),
                sqrtPriceLimitX96: _argUint160(_A_SQRT_P1)
            }),
            ""
        );
        int128 d0 = delta.amount0();
        int128 d1 = delta.amount1();
        if (d0 > 0 || d1 < 0) revert UnexpectedDelta();
        // casting to 'uint128' is safe because d0 ≤ 0 and d1 ≥ 0 (checked above)
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 spent = uint256(uint128(-d0));
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 out = uint256(uint128(d1));
        if (spent > qIn) revert UnexpectedDelta();
        if (spent != 0) {
            poolManager.sync(Currency.wrap(address(0)));
            if (poolManager.settle{value: spent}() != spent) revert UnexpectedDelta();
        }
        if (out != 0) poolManager.take(Currency.wrap(_argAddress(_A_TOKEN)), recipient, out);
        return abi.encode(spent, out);
    }

    // ================================================================== views

    /// @inheritdoc IBoxLaunchRouter
    function quote(uint256 qIn) external view returns (uint256 tax, uint256 swapIn) {
        tax = taxFor(qIn, _windowStep(_initialised()));
        swapIn = qIn - tax;
    }

    /// @inheritdoc IBoxLaunchRouter
    function taxFor(uint256 qIn, uint256 step) public pure returns (uint256) {
        return _ceilTax(qIn, taxPips(step));
    }

    /// @inheritdoc IBoxLaunchRouter
    function taxPips(uint256 step) public pure returns (uint256) {
        if (step >= WINDOW_STEPS) return 0;
        return taxTable()[step];
    }

    /// @inheritdoc IBoxLaunchRouter
    /// @dev LaunchTaxRouter.sol:219-254, unchanged: one table fits every box (k is the version's span, BC-024).
    function taxTable() public pure returns (uint24[32] memory) {
        return [
            uint24(931_974),
            926_013,
            919_530,
            912_479,
            904_810,
            896_469,
            887_397,
            877_531,
            866_799,
            855_128,
            842_433,
            828_627,
            813_610,
            797_278,
            779_515,
            760_195,
            739_182,
            716_328,
            691_472,
            664_437,
            635_033,
            603_054,
            568_271,
            530_441,
            489_297,
            444_547,
            395_875,
            342_939,
            285_365,
            222_745,
            154_639,
            80_565
        ];
    }

    /// @inheritdoc IBoxLaunchRouter
    function kind() external view returns (BoxKind) {
        return BoxKind(_argUint(_A_KIND, 1));
    }

    /// @inheritdoc IBoxLaunchRouter
    function coordinator() external view returns (address) {
        return _argAddress(_A_COORDINATOR);
    }

    /// @inheritdoc IBoxLaunchRouter
    function hook() external view returns (address) {
        return _argAddress(_A_HOOK);
    }

    /// @inheritdoc IBoxLaunchRouter
    function token() external view returns (address) {
        return _argAddress(_A_TOKEN);
    }

    /// @inheritdoc IBoxLaunchRouter
    function q() external view returns (address) {
        return _argAddress(_A_Q);
    }

    /// @inheritdoc IBoxLaunchRouter
    function openAt() external view returns (uint256) {
        return _s & _M40;
    }

    /// @inheritdoc IBoxLaunchRouter
    function bootstrapped() external view returns (bool) {
        return _s & _B_BOOTSTRAPPED != 0;
    }

    /// @inheritdoc IBoxLaunchRouter
    function creatorBought() external view returns (bool) {
        return _s & _B_CREATOR_BOUGHT != 0;
    }

    /// @inheritdoc IBoxLaunchRouter
    function totalTaxCollected() external view returns (uint256) {
        // casting to 'uint128' keeps the low half, where the tax total lives
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint128(_totals);
    }

    /// @inheritdoc IBoxLaunchRouter
    function totalSwept() external view returns (uint256) {
        return _totals >> 128;
    }

    // ================================================================== internals

    function _initialised() private view returns (uint256 s) {
        s = _s;
        if (s & _M40 == 0) revert NotInitialised();
    }

    /// @dev The tax step of this block: (block.timestamp − openAt) / 12, rounded down, 0 … 31 (F80). Slots are 12 s
    /// apart, so on Ethereum each step holds exactly one slot whatever second openAt names; a missed slot leaves its
    /// step uncharged and the next block pays the next, lower step (open-at-clock-time.md § 2.4).
    function _windowStep(uint256 s) private view returns (uint256 step) {
        uint256 open = s & _M40;
        if (block.timestamp < open) revert NotOpen(open);
        step = (block.timestamp - open) / TAX_STEP_SECONDS;
        if (step >= WINDOW_STEPS) revert WindowClosed(open + WINDOW_SECONDS);
    }

    /// @dev Tokens delivered to these could never move again (no rescue exists): LaunchTaxRouter.sol:149-153.
    function _checkRecipient(address recipient) private view {
        if (recipient == address(0)) revert ZeroAddress();
        if (recipient == address(this) || recipient == _argAddress(_A_HOOK) || recipient == address(poolManager)) {
            revert RecipientRefused(recipient);
        }
    }

    function _swap(uint256 qIn, address recipient) private returns (uint256 spent, uint256 tokensOut) {
        (spent, tokensOut) =
            abi.decode(poolManager.unlock(abi.encode(_ACT_SWAP, abi.encode(qIn, recipient))), (uint256, uint256));
    }

    function _ceilTax(uint256 qIn, uint256 pips) private pure returns (uint256) {
        if (pips == 0) return 0;
        return (qIn * pips + PIPS - 1) / PIPS;
    }

    function _poolKey() private view returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(_argAddress(_A_TOKEN)),
            fee: BoxSpecV1.LP_FEE,
            tickSpacing: BoxSpecV1.TICK_SPACING,
            hooks: IHooks(_argAddress(_A_HOOK))
        });
    }
}
