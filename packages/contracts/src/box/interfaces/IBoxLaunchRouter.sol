// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {BoxKind} from "./BoxTypes.sol";

/// @title IBoxLaunchRouter (slice S4; per-box clone with immutable arguments)
/// @notice The box's launch-window router. A copy of LaunchTaxRouter (src/v2/LaunchTaxRouter.sol:55-313) with the
/// D1 changes (plan § 3.2) and one tax destination for every box (F68 (2a), F77):
///
/// - `buy`: anyone, only while `block.timestamp` is in [openAt, openAt + WINDOW_SECONDS) (384 s; F80, a clock time)
///   and the curve is open; keeps tax = ceil(qIn × pips(step) / 10^6), step = ⌊(block.timestamp − openAt) / 12⌋
///   (0 … 31), from the version's table (BoxSpecV1.LAUNCH_TAX_TABLE_HASH; 93.1974% → 8.0565%, BC-024) and swaps the
///   rest exact-in with P1 as the price limit. A buy that reaches P1 closes the curve: the router keeps the partial fill,
///   refunds the unspent input and the tax on it to the payer in the same call, and charges tax only on the input
///   that entered the curve (BC-096, BC-022).
/// - `bootstrap` (BoxSpecV1.BOOTSTRAP_ETH, untaxed, T to the coordinator, which burns it) and `creatorBuy` (the
///   spec's `creatorBuy`, untaxed, 1% pool fee, T to the creator; refused if it would close the curve; F61 O2,
///   BC-116): the coordinator only, once each, inside createBox, before the open. No other untaxed or pre-open buy.
/// - **Tax destination** (`sweep()`, anyone), every box alike (box 0 since F77, superseding F68 (1b)): nothing moves
///   until graduation, then all of it becomes the hook's Q claims (its depth budget; BC-110, BC-140); at a failure
///   (v2, S11) it joins the refund range. Never the Safe, never FIT. Box 0 has no failure path: if it never graduates,
///   its tax stays here.
/// - No owner, admin, pause, upgrade, setter or rescue; no `receive`/`fallback` (plain ETH refused, forced ETH swept
///   with the tax). Recipients that cannot pass tokens on (this router, the hook, the PoolManager) are refused.
/// @dev Invariants: the router holds only unswept tax (BC-022); it serves only its own pool; the tax never enters the
/// curve or the raise.
interface IBoxLaunchRouter is IUnlockCallback {
    /// @notice One taxed buy, raw amounts. `step` is the tax step (0 … 31, see `buy`); `refund` is the unspent input
    /// plus its tax returned on a closing fill.
    event TaxedBuy(
        address indexed buyer,
        address indexed recipient,
        uint256 step,
        uint256 qIn,
        uint256 tax,
        uint256 tokensOut,
        uint256 refund
    );
    event Bootstrapped(address indexed recipient, uint256 qIn, uint256 tokensOut);
    /// @notice The creator buy (published, BC-116/BC-117).
    event CreatorBought(address indexed creator, uint256 qIn, uint256 tokensOut);
    /// @notice Tax moved into the hook's depth budget (every box; `toDepth` is always true since F77).
    event Swept(address indexed to, uint256 amount, bool toDepth);

    error ZeroAddress();
    error NotCoordinator(address caller);
    error AlreadyInitialised();
    error RecipientRefused(address recipient);
    /// @notice Before the open (Unix seconds).
    error NotOpen(uint256 openAt);
    /// @notice From `windowEnd` (openAt + WINDOW_SECONDS, Unix seconds) on, buy through any route.
    error WindowClosed(uint256 windowEnd);
    /// @notice The curve is closed: buy through any route after `graduate()`.
    error CurveIsClosed();
    error Expired(uint256 deadline);
    error AmountTooSmall();
    error WrongValue(uint256 sent, uint256 required);
    error InsufficientOutput(uint256 tokensOut, uint256 minTokensOut);
    error AlreadyBootstrapped();
    error NotBootstrapped();
    error AlreadyCreatorBought();
    /// @notice The bootstrap and the creator buy come before the open (Unix seconds).
    error AfterOpen(uint256 openAt);
    /// @notice The creator buy would reach P1 (it must stay below the raise, BC-116).
    error CreatorBuyClosesCurve();
    error NotPoolManager();
    error UnexpectedDelta();
    /// @notice The tax waits for graduation (or failure, v2).
    error NotGraduated();
    error NothingToSweep();
    error RefundFailed();

    /// @notice The box's coordinator only (the `coordinator` argument, a clone of `coordinatorImplementation()`), once,
    /// in createBox: openAt = the `openAt` argument, or block.timestamp + 1 when it is 0 (Now) or not after
    /// block.timestamp (the hook's rule; the factory re-reads both).
    function initialize() external;

    /// @notice Anyone, in the window while the curve is open. Native-ETH Q: `qIn == msg.value`; ERC-20 Q (S12):
    /// `msg.value == 0` and `qIn` is pulled from the caller.
    function buy(uint256 qIn, uint256 minTokensOut, address recipient, uint256 deadline)
        external
        payable
        returns (uint256 tokensOut);
    /// @notice The coordinator only, once, before the open: BOOTSTRAP_ETH (or the Q list's equivalent), untaxed.
    function bootstrap() external payable returns (uint256 tokensOut);
    /// @notice The coordinator only, once, after the bootstrap, before the open: untaxed, T to `creator`.
    function creatorBuy(address creator, uint256 qIn) external payable returns (uint256 tokensOut);
    /// @notice Anyone: moves the held tax to its destination (see the contract notes).
    function sweep() external returns (uint256 amount);

    /// @notice What a buy of `qIn` would pay now: the tax kept and the Q swapped. Reverts outside the window. It
    /// answers the clock's step only: read `hook.closed()` first; after the close no taxed buy exists, and at a closing
    /// fill the tax is charged on the filled input only (box 0's own review W2-U2-1, F147).
    function quote(uint256 qIn) external view returns (uint256 tax, uint256 swapIn);
    /// @notice ceil(qIn × taxPips(step) / 10^6).
    function taxFor(uint256 qIn, uint256 step) external pure returns (uint256 tax);
    /// @notice The table's entry for a 12-second step (pips); 0 from step 32 (WINDOW_STEPS) on.
    function taxPips(uint256 step) external pure returns (uint256);
    function taxTable() external pure returns (uint24[32] memory);

    function kind() external view returns (BoxKind);
    function coordinator() external view returns (address);
    /// @notice The version's coordinator implementation: only a clone of it may initialise this router (BC-100).
    function coordinatorImplementation() external view returns (address);
    function hook() external view returns (address);
    function token() external view returns (address);
    function q() external view returns (address);
    /// @notice When the window opens (Unix seconds), equal to the hook's `openAt()`; 0 before `initialize`.
    function openAt() external view returns (uint256);
    function bootstrapped() external view returns (bool);
    function creatorBought() external view returns (bool);
    function totalTaxCollected() external view returns (uint256);
    function totalSwept() external view returns (uint256);
}
