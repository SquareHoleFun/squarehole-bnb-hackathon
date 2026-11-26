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
import {ReleaseConstantsV2} from "./interfaces/ReleaseConstantsV2.sol";
import {BoxSpecV1} from "../box/BoxSpecV1.sol";
import {BoxCloneReader} from "../box/BoxCloneReader.sol";
import {IBoxHookV2} from "./interfaces/IBoxHookV2.sol";
import {BoxKind} from "../box/interfaces/BoxTypes.sol";
import {BoxClones} from "../box/libraries/BoxClones.sol";
import {IBoxCoordinatorV2, GATE_CLOSED_OPEN_AT} from "./interfaces/IBoxCoordinatorV2.sol";
import {IBoxLaunchRouterV2} from "./interfaces/IBoxPeripheryV2.sol";
import {BoxLaunchRouterV2Args as A} from "./libraries/BoxLaunchRouterV2Args.sol";
import {PricingToken} from "./libraries/PricingToken.sol";

/// @title BoxLaunchRouterV2 (core v2 M1, ticket M1-30-a; the implementation behind every v2 box's launch-router clone)
/// @notice See `IBoxLaunchRouterV2`. A copy of v1's `BoxLaunchRouter` (the window, the 32-entry tax table, the closing
/// fill's refund, the untaxed bootstrap and creator buy, the tax held until graduation, then the hook's claims) with:
/// - **Any pricing token P** (ADR-0017 § 4): native ETH keeps v1's payment (`msg.value == qIn`); an ERC-20 P takes
///   `msg.value == 0` and pulls `qIn` from `msg.sender` by `transferFrom`, its own balance change checked
///   (`ShortTransfer`), before any swap. The closing fill's unspent P and its tax go back to the payer in P; the tax
///   is held in P and swept into the hook's P claims after graduation. P is always currency0 (BC-157).
/// - **The bootstrap and the creator buy in P** (wave 0's integrated review, M2): the bootstrap is the box's
///   `bootstrapQ` (a clone argument), not v1's `BOOTSTRAP_ETH`; for an ERC-20 P both are pulled exactly from the
///   coordinator, which approved them. Every v2 box is `Standard`, so the creator buy is never refused for the kind.
/// - **The open from the coordinator** (`IBoxOpenGateV2`; ADR-0017 § 6): at `initialize` the router takes the
///   coordinator's `effectiveOpenAt()` whole if its gate is open, else `GATE_CLOSED_OPEN_AT`; the coordinator then calls
///   `setOpen(t)` once. The window and its tax count from that open, never from the spec's.
/// - **The tax at a failure** (Amendment 3 C11): anyone may sweep to the coordinator's failure pot once it reports
///   `failed()`. Failure and each claim try a sweep under SWEEP_GAS. Sweeps handle at most four int128.max parts;
///   larger balances remain available for another permissionless call. After the last claim late receipts
///   remain in the coordinator forever, with no function to move them. Each return, event and lifetime total counts only P delivered by that call.
/// **Clone arguments**: `BoxLaunchRouterV2Args` (116 bytes).
/// @dev No owner, admin, pause, upgrade, setter, rescue, `receive` or `fallback`. Holds only unswept tax (BC-022).
contract BoxLaunchRouterV2 is IBoxLaunchRouterV2, TransientReentrancyGuard, BoxCloneReader {
    error NotInitialised();
    error InputNotFullySpent(uint256 spent, uint256 swapIn);
    /// @notice `setOpen` given 0 or `GATE_CLOSED_OPEN_AT` or more, or the coordinator reported an open gate with an open
    /// of 0 or beyond 40 bits. The hook's and the tickets' error (one selector; M1-30-b's change request 13).
    error OpenOutOfRange(uint256 openAt);

    uint256 public constant WINDOW_STEPS = BoxSpecV1.WINDOW_STEPS;
    uint256 public constant TAX_STEP_SECONDS = BoxSpecV1.TAX_STEP_SECONDS;
    uint256 public constant WINDOW_SECONDS = BoxSpecV1.WINDOW_SECONDS;
    uint256 public constant PIPS = 1_000_000;
    uint256 public constant ARGS_LENGTH = A.LENGTH;

    uint8 private constant _ACT_SWAP = 1;
    uint8 private constant _ACT_SWEEP = 2;
    uint256 private constant _MAX_SETTLEMENT_PART = uint256(uint128(type(int128).max));
    uint256 private constant _MAX_SWEEP = 4 * _MAX_SETTLEMENT_PART;

    uint256 private constant _M40 = (1 << 40) - 1;
    uint256 private constant _B_BOOTSTRAPPED = 1 << 40;
    uint256 private constant _B_CREATOR_BOUGHT = 1 << 41;

    IPoolManager public immutable poolManager;
    address public immutable coordinatorImplementation;

    /// @dev openAt (low 40 bits: 0 until `initialize`, `GATE_CLOSED_OPEN_AT` while the gate holds), bootstrapped,
    /// creatorBought.
    uint256 internal _s;
    /// @dev Lifetime totals in P's raw units, a word each (a raise near 2^128 keeps more than 128 bits of tax).
    uint256 internal _taxKept;
    uint256 internal _swept;

    constructor(IPoolManager poolManager_, address coordinatorImplementation_) {
        poolManager = poolManager_;
        coordinatorImplementation = coordinatorImplementation_;
        // The implementation is never a box's router: a non-zero open (1, in 1970) makes `initialize` refuse.
        _s = 1;
    }

    // ================================================================== lifecycle (coordinator)

    function initialize() external {
        address c = _argAddress(A.COORDINATOR);
        // Only the box's coordinator, a clone of the release's coordinator implementation (BC-100).
        if (msg.sender != c || !BoxClones.isCloneOf(msg.sender, coordinatorImplementation)) {
            revert NotCoordinator(msg.sender);
        }
        if (_s & _M40 != 0) revert AlreadyInitialised();
        uint256 open = GATE_CLOSED_OPEN_AT;
        if (IBoxCoordinatorV2(c).gateOpen()) {
            open = IBoxCoordinatorV2(c).effectiveOpenAt();
            if (open == 0 || open > _M40) revert OpenOutOfRange(open);
        }
        _s = open;
    }

    function setOpen(uint256 openAt_) external {
        uint256 s = _initialised();
        if (msg.sender != _argAddress(A.COORDINATOR)) revert NotCoordinator(msg.sender);
        if (s & _M40 != GATE_CLOSED_OPEN_AT) revert OpenAlreadySet();
        if (openAt_ == 0 || openAt_ >= GATE_CLOSED_OPEN_AT) revert OpenOutOfRange(openAt_);
        _s = (s & ~_M40) | openAt_;
        emit OpenSet(openAt_);
    }

    function bootstrap() external payable nonReentrant returns (uint256 tokensOut) {
        uint256 s = _beforeOpen();
        if (s & _B_BOOTSTRAPPED != 0) revert AlreadyBootstrapped();
        uint256 bq = _argUint(A.BOOTSTRAP_Q, 16);
        _s = s | _B_BOOTSTRAPPED;
        _payIn(bq);
        uint256 spent;
        (spent, tokensOut) = _swap(bq, msg.sender);
        if (spent != bq) revert InputNotFullySpent(spent, bq);
        if (tokensOut == 0) revert AmountTooSmall();
        emit Bootstrapped(msg.sender, bq, tokensOut);
    }

    function creatorBuy(address creator, uint256 qIn) external payable nonReentrant returns (uint256 tokensOut) {
        uint256 s = _beforeOpen();
        if (s & _B_BOOTSTRAPPED == 0) revert NotBootstrapped();
        if (s & _B_CREATOR_BOUGHT != 0) revert AlreadyCreatorBought();
        _checkRecipient(creator);
        if (qIn == 0) revert AmountTooSmall();
        _s = s | _B_CREATOR_BOUGHT;
        _payIn(qIn);
        uint256 spent;
        (spent, tokensOut) = _swap(qIn, creator);
        // It must stay below P1 (below the raise, BC-116): reaching P1 would close the curve at creation.
        if (spent != qIn || IBoxHookV2(_argAddress(A.HOOK)).closed()) revert CreatorBuyClosesCurve();
        if (tokensOut == 0) revert AmountTooSmall();
        emit CreatorBought(creator, qIn, tokensOut);
    }

    // ================================================================== the window

    function buy(uint256 qIn, uint256 minTokensOut, address recipient, uint256 deadline)
        external
        payable
        nonReentrant
        returns (uint256 tokensOut)
    {
        if (block.timestamp > deadline) revert Expired(deadline);
        _checkRecipient(recipient);
        uint256 step = _windowStep(_initialised());
        if (IBoxHookV2(_argAddress(A.HOOK)).closed()) revert CurveIsClosed();
        uint256 pips = taxPips(step);
        uint256 tax = _ceilTax(qIn, pips);
        uint256 swapIn = qIn - tax;
        if (swapIn == 0) revert AmountTooSmall();
        // ETH: exactly `msg.value`; an ERC-20 P: `msg.value` 0 and `qIn` pulled from the payer, checked, before the swap.
        _payIn(qIn);
        uint256 spent;
        (spent, tokensOut) = _swap(swapIn, recipient);
        uint256 refund;
        if (spent != swapIn) {
            // The closing fill (D1): the swap stopped at P1. Tax only on the input that entered the curve, at the same
            // rate of the gross; the rest goes back to the payer, in P.
            uint256 kept = (spent * pips + (PIPS - pips) - 1) / (PIPS - pips);
            if (kept < tax) tax = kept;
            refund = qIn - spent - tax;
        }
        if (tokensOut == 0) revert AmountTooSmall();
        if (tokensOut < minTokensOut) revert InsufficientOutput(tokensOut, minTokensOut);
        _taxKept += tax;
        emit TaxedBuy(msg.sender, recipient, step, qIn, tax, tokensOut, refund);
        if (refund != 0) {
            address p = _argAddress(A.P);
            if (p == address(0)) {
                (bool ok,) = msg.sender.call{value: refund}("");
                if (!ok) revert RefundFailed();
            } else {
                PricingToken.sendExact(p, msg.sender, refund);
            }
        }
    }

    /// @notice Anyone after graduation or failure: sweep P into hook depth or the coordinator's failure pot.
    /// @dev At most four settlement/mint pairs per call, including when gifts dwarf the launch tax.
    function sweep() external nonReentrant returns (uint256 amount) {
        _initialised();
        address p = _argAddress(A.P);
        amount = PricingToken.balanceOf(p, address(this));
        if (amount == 0) revert NothingToSweep();
        if (amount > _MAX_SWEEP) amount = _MAX_SWEEP;
        // The tax waits for graduation, then becomes the hook's P claims (its depth budget; F68 (2a), F77), or for the
        // box's failure (`toDepth` false; `_failureSweepTo`).
        address to = _argAddress(A.HOOK);
        bool graduated = IBoxHookV2(to).migratedAtBlock() != 0;
        if (!graduated) to = _failureSweepTo();
        _swept += amount;
        emit Swept(to, amount, graduated);
        poolManager.unlock(abi.encode(_ACT_SWEEP, abi.encode(amount, to)));
    }

    /// @notice PoolManager callback of this router's own unlocks (inside its guarded `buy`, `bootstrap`,
    /// `creatorBuy` or `sweep` only).
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager) || !_insideGuardedCall()) revert NotPoolManager();
        (uint8 action, bytes memory arg) = abi.decode(data, (uint8, bytes));
        address p = _argAddress(A.P);
        if (action == _ACT_SWEEP) {
            (uint256 amount, address to) = abi.decode(arg, (uint256, address));
            // Clear each transient delta before starting the next representable part.
            while (amount != 0) {
                uint256 part = amount > _MAX_SETTLEMENT_PART ? _MAX_SETTLEMENT_PART : amount;
                PricingToken.settle(poolManager, p, part);
                poolManager.mint(to, PricingToken.claimId(p), part);
                amount -= part;
            }
            return "";
        }
        (uint256 qIn, address recipient) = abi.decode(arg, (uint256, address));
        BalanceDelta delta = poolManager.swap(
            _poolKey(p),
            SwapParams({
                zeroForOne: true,
                // casting to 'int256' is safe because qIn ≤ what was paid in, far below 2^255
                // forge-lint: disable-next-line(unsafe-typecast)
                amountSpecified: -int256(qIn),
                sqrtPriceLimitX96: _argUint160(A.SQRT_P1)
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
        if (spent != 0) PricingToken.settle(poolManager, p, spent);
        if (out != 0) poolManager.take(Currency.wrap(_argAddress(A.TOKEN)), recipient, out);
        return abi.encode(spent, out);
    }

    // ================================================================== views

    function quote(uint256 qIn) external view returns (uint256 tax, uint256 swapIn) {
        tax = taxFor(qIn, _windowStep(_initialised()));
        swapIn = qIn - tax;
    }

    function taxFor(uint256 qIn, uint256 step) public pure returns (uint256) {
        return _ceilTax(qIn, taxPips(step));
    }

    function taxPips(uint256 step) public pure returns (uint256) {
        if (step >= WINDOW_STEPS) return 0;
        return taxTable()[step];
    }

    /// @dev v1's table (`BoxLaunchRouter.sol:278-313`), unchanged (BoxSpecV1.LAUNCH_TAX_TABLE_HASH).
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

    /// @notice Every v2 box is `Standard` (box 0 is v1's).
    function kind() external pure returns (BoxKind) {
        return BoxKind.Standard;
    }

    function coordinator() external view returns (address) {
        return _argAddress(A.COORDINATOR);
    }

    function hook() external view returns (address) {
        return _argAddress(A.HOOK);
    }

    function token() external view returns (address) {
        return _argAddress(A.TOKEN);
    }

    function q() external view returns (address) {
        return _argAddress(A.P);
    }

    /// @notice The box's untaxed bootstrap buy in P's raw units (`QParameters.bootstrapQ`).
    function bootstrapQ() external view returns (uint256) {
        return _argUint(A.BOOTSTRAP_Q, 16);
    }

    function openAt() external view returns (uint256) {
        return _s & _M40;
    }

    function bootstrapped() external view returns (bool) {
        return _s & _B_BOOTSTRAPPED != 0;
    }

    function creatorBought() external view returns (bool) {
        return _s & _B_CREATOR_BOUGHT != 0;
    }

    function totalTaxCollected() external view returns (uint256) {
        return _taxKept;
    }

    function totalSwept() external view returns (uint256) {
        return _swept;
    }

    // ================================================================== internals

    function _initialised() private view returns (uint256 s) {
        s = _s;
        if (s & _M40 == 0) revert NotInitialised();
    }

    /// @dev The coordinator only, before the open (the bootstrap and the creator buy, inside createBox).
    function _beforeOpen() private view returns (uint256 s) {
        s = _initialised();
        if (msg.sender != _argAddress(A.COORDINATOR)) revert NotCoordinator(msg.sender);
        uint256 open = s & _M40;
        if (block.timestamp >= open) revert AfterOpen(open);
    }

    /// @dev `amount` of P in from the caller (a buyer, or the coordinator for the bootstrap and the creator buy): ETH as
    /// exactly `msg.value`; an ERC-20 P with `msg.value` 0, pulled exactly (`PricingToken.ShortTransfer`, the selector
    /// of the router's frozen `ShortTransfer`).
    function _payIn(uint256 amount) private {
        address p = _argAddress(A.P);
        uint256 value = p == address(0) ? amount : 0;
        if (msg.value != value) revert WrongValue(msg.value, value);
        if (p != address(0)) PricingToken.pullExact(p, msg.sender, amount);
    }

    /// @dev The tax step of this block: (block.timestamp − openAt) / 12, rounded down, 0 … 31 (F80).
    function _windowStep(uint256 s) private view returns (uint256 step) {
        uint256 open = s & _M40;
        if (block.timestamp < open) revert NotOpen(open);
        step = (block.timestamp - open) / TAX_STEP_SECONDS;
        if (step >= WINDOW_STEPS) revert WindowClosed(open + WINDOW_SECONDS);
    }

    /// @dev After failure, any caller's sweep goes to the coordinator's pot as P claims.
    /// Before failure, revert NotGraduated; a failed coordinator read also reverts the sweep.
    function _failureSweepTo() private view returns (address) {
        address c = _argAddress(A.COORDINATOR);
        if (!IBoxCoordinatorV2(c).failed()) revert NotGraduated();
        return c;
    }

    /// @dev Tokens delivered to these could never move again (no rescue exists).
    function _checkRecipient(address recipient) private view {
        if (recipient == address(0)) revert ZeroAddress();
        if (recipient == address(this) || recipient == _argAddress(A.HOOK) || recipient == address(poolManager)) {
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

    function _poolKey(address p) private view returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(p),
            currency1: Currency.wrap(_argAddress(A.TOKEN)),
            fee: ReleaseConstantsV2.V2_POOL_FEE,
            tickSpacing: BoxSpecV1.TICK_SPACING,
            hooks: IHooks(_argAddress(A.HOOK))
        });
    }
}
