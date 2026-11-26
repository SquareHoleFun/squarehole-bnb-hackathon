// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IRuleSplitter} from "./IRuleSplitter.sol";
import {IFeeRules} from "./IFeeRules.sol";
import {PairPriceGuard} from "./PairPriceGuard.sol";

interface IERC20Min {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IV2RouterMin {
    function WETH() external view returns (address);
    function swapExactETHForTokensSupportingFeeOnTransferTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable;
    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external;
}

/// @title RuleSplitter: one token's income shared among up to four rules fixed at construction
/// @notice See `IRuleSplitter`. How the code gives each property:
/// - Fixed at construction: token, asset and rules are written once, by `_initRuleSplitter` (the constructor of
///   `RuleSplitter`, or the one-time initializer of a vault built on `RuleSplitterBase`); there is no other writer of
///   them, no owner, no setter and no pause. `RuleSplitter` is a plain contract; a vault built on the base behind
///   Flap's Guardian-only beacon can have its CODE changed by that Guardian (see the vault).
/// - One rule never holds back the others: each delivery is a call whose failure is caught (`try`, or a low-level call
///   whose result is checked); the native coin to a CREATOR or PILE goes with a fixed gas allowance, so a target that
///   burns gas cannot exhaust the call. A failed delivery leaves the amount in `owed` for a later `distribute()`.
/// - Nothing stranded: each recognised amount is split with the last rule taking the remainder, so the parts sum to it
///   exactly; the balance always equals `totalOwed()` plus `pending()`.
/// - What a caller can influence: only WHEN `distribute()` runs, and how much gas it gives. It cannot choose amounts,
///   targets or paths. Too little gas makes a delivery fail and stay owed; the others are still paid. For a BUY_BURN
///   the moment decides the price paid.
/// Assumptions and stated limits (not guarded):
/// - The asset is a plain ERC-20 (no fee on its own transfers, no rebase): a delivery counts what it SENT (the amount
///   on success; for a buy, the amount less the router's unused allowance), so income that arrives during a delivery
///   stays income. A BUY_BURN target must be a contract, and there is at most one BUY_BURN rule (one guard, one pace),
///   both checked at construction.
/// - The buy is guarded by `PairPriceGuard` (Flap's pre-audit finding R2): at most 5 bps of the pair's quote reserve per buy, one
///   buy per 60 seconds, a nonzero minimum output from the pair's reserves; a larger part is bought in slices over
///   later calls and stays owed meanwhile. What the guard does not stop is stated in `PairPriceGuard`. The buy needs
///   a PancakeSwap V2 pair of exactly asset and token; without one its part stays owed.
/// - A payee that cannot take the native coin within `NATIVE_CALL_GAS` stays owed by `distribute()`; anyone can then
///   pay a CREATOR rule's owed part with all the gas they give through `payOwedCreator` (Flap's pre-audit note N4). A PILE
///   target is our own pile, which takes the coin within the allowance.
/// - After a successful buy, a failed read of the router's remaining allowance counts the whole amount as spent (never
///   as nothing, so a buy is never made twice from the same income). The asset is assumed to lower an allowance when
///   it is drawn (the splitter approves exactly the amount, never an unlimited one); an asset that kept an allowance
///   unchanged, as some do for an unlimited one, would read as nothing spent while its balance had gone.
/// - The rules run in the order given: a BUY_BURN makes the heaviest outside call, so a caller that runs it short of
///   gas could leave too little for the rules after it; our factories accept a BUY_BURN only as the last rule.
/// - `delivered(i)` and `burned(i)` are lifetime counters for pages; they wrap at 2^256 rather than ever revert.
/// - Anything but the asset sent here is stranded; the token's units sent here count as circulating in the pile.
/// - A splitter deployed outside our factories proves nothing about its targets: a page shows rules only for
///   splitters our factories created (their creation event names them).
/// @dev All logic and storage; `_initRuleSplitter` writes the configuration once. The storage below is the layout a
/// beacon proxy of a vault built on this base keeps across upgrades: append only, from the gap.
abstract contract RuleSplitterBase is IRuleSplitter {
    /// @inheritdoc IRuleSplitter
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    /// @notice Gas given to a CREATOR or PILE receiving the native coin (enough for a plain contract wallet).
    uint256 public constant NATIVE_CALL_GAS = 100_000;
    uint256 public constant MAX_RULES = 4;

    /// @inheritdoc IRuleSplitter
    address public token;
    /// @inheritdoc IRuleSplitter
    address public asset;

    Rule[] private _rules;
    uint256[4] private _owed;
    uint256[4] private _delivered;
    uint256[4] private _burned;
    /// @inheritdoc IRuleSplitter
    uint256 public totalOwed;
    /// @dev 0 before `_initRuleSplitter` (every entry refuses), 1 idle, 2 inside an entry.
    uint256 private _lock;
    /// @dev Flap's pre-audit finding R2: the buy-and-burn's guard, one slot (17, the last buy's time) taken from the gap.
    /// Zero until the first buy; nothing to initialise.
    PairPriceGuard.State private _buyGuard;
    /// @dev Room for later storage of this base in an upgraded implementation (a beacon proxy keeps its slots).
    uint256[39] private __gap;

    error NativeNotAccepted();
    /// @notice `payOwedCreator` names a rule that is not a CREATOR rule.
    error NotCreatorRule();
    /// @notice `payOwedCreator`'s payment failed; the part stays owed.
    error PaymentFailed();

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    /// @dev Writes the configuration once: refuses when it was written already (token set).
    function _initRuleSplitter(address token_, address asset_, Rule[] memory rules_) internal {
        if (token != address(0)) revert InvalidRules();
        if (token_ == address(0) || token_ == asset_) revert InvalidRules();
        uint256 n = rules_.length;
        if (n == 0 || n > MAX_RULES) revert InvalidRules();
        uint256 sum;
        bool burnSeen; // at most one BUY_BURN rule: the buy's guard keeps one pace
        for (uint256 i; i < n; ++i) {
            Rule memory r = rules_[i];
            if (r.bps == 0 || r.target == address(0) || r.target == address(this)) revert InvalidRules();
            if (r.kind == Kind.PILE) {
                if (IFeeRules(r.target).token() != token_ || IFeeRules(r.target).asset() != asset_) {
                    revert InvalidRules();
                }
            } else if (r.kind == Kind.BUY_BURN) {
                if (burnSeen) revert InvalidRules();
                burnSeen = true;
                if (r.target.code.length == 0) revert InvalidRules(); // a router without code could never buy
                if (asset_ == address(0) && IV2RouterMin(r.target).WETH() == address(0)) revert InvalidRules();
            } else if (r.kind != Kind.CREATOR) {
                revert InvalidRules();
            }
            sum += r.bps;
            _rules.push(r);
        }
        if (sum != 10_000) revert InvalidRules();
        if (asset_ != address(0) && asset_.code.length == 0) revert InvalidRules();
        token = token_;
        asset = asset_;
        _lock = 1;
    }

    /// @notice Income in the native coin, or the empty wake call after an ERC-20 payment. No work here.
    /// @dev Before the configuration is written (a locked beacon implementation, or a proxy not yet initialized) the
    /// native coin is refused too: nothing could ever pay it out.
    receive() external payable virtual {
        if (msg.value != 0 && (asset != address(0) || token == address(0))) revert NativeNotAccepted();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Views
    // ─────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IRuleSplitter
    function ruleCount() external view returns (uint256) {
        return _rules.length;
    }

    /// @inheritdoc IRuleSplitter
    function rule(uint256 i) external view returns (Kind kind, uint16 bps, address target) {
        Rule storage r = _rules[i];
        return (r.kind, r.bps, r.target);
    }

    /// @inheritdoc IRuleSplitter
    function owed(uint256 i) external view returns (uint256) {
        return _owed[i];
    }

    /// @inheritdoc IRuleSplitter
    function delivered(uint256 i) external view returns (uint256) {
        return _delivered[i];
    }

    /// @inheritdoc IRuleSplitter
    function burned(uint256 i) external view returns (uint256) {
        return _burned[i];
    }

    /// @inheritdoc IRuleSplitter
    function pending() public view returns (uint256) {
        uint256 bal = _balance();
        return bal > totalOwed ? bal - totalOwed : 0;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Distribute
    // ─────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IRuleSplitter
    function distribute() external nonReentrant {
        uint256 n = _rules.length;
        uint256 income = pending();
        if (income != 0) {
            emit IncomeRecognised(income);
            uint256 assigned;
            for (uint256 i; i < n; ++i) {
                // floor(income x bps / 10,000) without the product: it cannot overflow for any income
                uint256 bps = _rules[i].bps;
                uint256 part = i == n - 1 ? income - assigned : income / 10_000 * bps + income % 10_000 * bps / 10_000;
                assigned += part;
                _owed[i] += part;
                emit PartOwed(i, part, _owed[i]);
            }
            totalOwed += income;
        }
        for (uint256 i; i < n; ++i) {
            uint256 amount = _owed[i];
            if (amount == 0) continue;
            (uint256 spent, uint256 burnt) = _deliver(_rules[i], amount);
            if (spent != 0) {
                _owed[i] = amount - spent;
                totalOwed -= spent;
                // the lifetime counters are for pages and wrap at 2^256: a counter must never stop payments
                unchecked {
                    _delivered[i] += spent;
                    _burned[i] += burnt;
                }
                emit Delivered(i, spent, burnt);
            }
            if (_owed[i] != 0) emit LeftOwed(i, _owed[i]);
        }
    }

    /// @notice Flap's pre-audit note N4: pays CREATOR rule `i`'s owed part to the rule's own target with all the gas
    /// the caller gives, for a payee that needs more than `NATIVE_CALL_GAS`. Anyone may call it; it reverts when the
    /// payment fails (the part stays owed); with nothing owed it pays nothing. No new state: it books like a delivery.
    function payOwedCreator(uint256 i) external nonReentrant returns (uint256 paid) {
        Rule storage r = _rules[i];
        if (r.kind != Kind.CREATOR) revert NotCreatorRule();
        paid = _owed[i];
        if (paid == 0) return 0;
        _owed[i] = 0;
        totalOwed -= paid;
        unchecked {
            _delivered[i] += paid; // a counter for pages, wraps like distribute's
        }
        bool ok;
        if (asset == address(0)) {
            (ok,) = r.target.call{value: paid}("");
        } else {
            (bool callOk, bytes memory ret) = asset.call(abi.encodeCall(IERC20Min.transfer, (r.target, paid)));
            ok = callOk && _isTrue(ret);
        }
        if (!ok) revert PaymentFailed();
        emit Delivered(i, paid, 0);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Deliveries: each returns what it SENT (0 when the rule could not be served) and never reverts: every external
    // call is a low-level call (no code-exists check outside a catch) whose result is checked.
    // ─────────────────────────────────────────────────────────────────────────

    function _deliver(Rule storage r, uint256 amount) private returns (uint256 spent, uint256 burnt) {
        if (r.kind == Kind.BUY_BURN) return _buyBurn(r.target, amount);
        return (_pay(r.target, amount) ? amount : 0, 0); // CREATOR and PILE: a payment of the asset to the target
    }

    function _pay(address to, uint256 amount) private returns (bool) {
        if (asset == address(0)) {
            (bool sent,) = to.call{value: amount, gas: NATIVE_CALL_GAS}("");
            return sent;
        }
        (bool callOk, bytes memory ret) = asset.call(abi.encodeCall(IERC20Min.transfer, (to, amount)));
        return callOk && _isTrue(ret);
    }

    function _buyBurn(address router, uint256 amount) private returns (uint256 spent, uint256 burnt) {
        address[] memory path = new address[](2);
        path[1] = token;
        if (asset == address(0)) {
            (bool okWeth, bytes memory w) = router.staticcall(abi.encodeCall(IV2RouterMin.WETH, ()));
            if (!okWeth || w.length < 32) return (0, 0);
            uint256 word = abi.decode(w, (uint256)); // read as a word: an answer above 160 bits is no answer
            if (word > type(uint160).max || word == 0) return (0, 0);
            path[0] = address(uint160(word));
        } else {
            path[0] = asset;
        }
        // Flap's R2 fix as written: at most 5 bps of the pair's quote reserve, at most one buy per 60 seconds, a nonzero
        // minimum from the pair's reserves less tax, fee and 1% slippage. Stops a sandwich of a capped buy whose size was
        // fixed BEFORE the front-run; does NOT stop a trade earlier in this transaction (it moves the reserves the cap
        // and the minimum are read from). A part above the cap, or a call too soon, stays owed: nothing reverts. The
        // last buy's time is written only after a buy that spent, so a failed swap costs no minute.
        (PairPriceGuard.Wait wait, uint256 amountIn, uint256 minOut) =
            PairPriceGuard.plan(_buyGuard, router, path[0], token, amount);
        if (wait != PairPriceGuard.Wait.NONE) return (0, 0);
        uint256 deadBefore = _deadBalance();
        spent = _swap(router, path, amountIn, minOut);
        if (spent == 0) return (0, 0);
        // "Spent" starts the minute. On the native path: a successful router call. On the token-quote path: after a
        // successful call, an allowance that shows a draw, or an allowance read that fails or answers short (then the
        // whole slice counts as spent, never as nothing, as the note on allowances above says). A cleanup approval
        // that fails is ignored and changes none of this.
        PairPriceGuard.markBought(_buyGuard);
        uint256 deadAfter = _deadBalance();
        burnt = deadAfter > deadBefore ? deadAfter - deadBefore : 0;
    }

    /// @dev The buy itself: returns what it sent, 0 when it failed (a failed call, an approval refused, nothing drawn).
    function _swap(address router, address[] memory path, uint256 amountIn, uint256 minOut)
        private
        returns (uint256 spent)
    {
        if (asset == address(0)) {
            (bool ok,) = router.call{value: amountIn}(
                abi.encodeCall(
                    IV2RouterMin.swapExactETHForTokensSupportingFeeOnTransferTokens, (minOut, path, DEAD, block.timestamp)
                )
            );
            return ok ? amountIn : 0; // the call took exactly msg.value
        }
        if (!_approve(router, amountIn)) return 0;
        (bool ok2,) = router.call(
            abi.encodeCall(
                IV2RouterMin.swapExactTokensForTokensSupportingFeeOnTransferTokens,
                (amountIn, minOut, path, DEAD, block.timestamp)
            )
        );
        // what was sent: the amount less what the router did not draw from the allowance
        uint256 left = ok2 ? _allowance(router) : amountIn;
        _approve(router, 0);
        return !ok2 || left >= amountIn ? 0 : amountIn - left;
    }

    /// @dev The token's balance at DEAD, or 0 when the read fails (it can never revert a distribution).
    function _deadBalance() private view returns (uint256) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeCall(IERC20Min.balanceOf, (DEAD)));
        return ok && ret.length >= 32 ? abi.decode(ret, (uint256)) : 0;
    }

    function _allowance(address spender) private view returns (uint256) {
        (bool ok, bytes memory ret) =
            asset.staticcall(abi.encodeWithSignature("allowance(address,address)", address(this), spender));
        return ok && ret.length >= 32 ? abi.decode(ret, (uint256)) : 0;
    }

    function _isTrue(bytes memory ret) private pure returns (bool) {
        if (ret.length == 0) return true; // a token that returns nothing on success
        if (ret.length < 32) return false;
        return abi.decode(ret, (uint256)) == 1; // read as a word: a malformed bool cannot revert here
    }

    function _approve(address spender, uint256 amount) private returns (bool) {
        (bool callOk, bytes memory ret) = asset.call(abi.encodeCall(IERC20Min.approve, (spender, amount)));
        return callOk && _isTrue(ret);
    }

    function _balance() private view returns (uint256) {
        return asset == address(0) ? address(this).balance : IERC20Min(asset).balanceOf(address(this));
    }
}

/// @title RuleSplitter: the plain contract, configured by its constructor (no proxy, no upgrade)
contract RuleSplitter is RuleSplitterBase {
    constructor(address token_, address asset_, Rule[] memory rules_) {
        _initRuleSplitter(token_, asset_, rules_);
    }

    /// @dev Configured by its constructor, so always configured: one read (the asset), which keeps a plain payment
    /// within a 2,300-gas stipend, as before the base existed.
    receive() external payable override {
        if (msg.value != 0 && asset != address(0)) revert NativeNotAccepted();
    }
}
