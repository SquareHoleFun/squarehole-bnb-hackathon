// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IFeeRules} from "./IFeeRules.sol";

interface IERC20Like {
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title FeeRules: a pile that every holder of one token can redeem
/// @notice See `IFeeRules`. The pile is this contract's live balance of `asset`; nothing but `redeem` moves it out.
/// Revenue needs no call: a plain transfer (native or ERC-20) grows the pile, and `receive()` does no work (it only
/// refuses native coin when the pile is held in an ERC-20, so nothing can be stranded here by mistake).
/// Redemption rule (the same as the platform's pile): `pile * amount / circulatingSupply`, rounded down, so every
/// rounding unit stays in the pile for the holders still in; the holder who hands in the whole circulating supply
/// receives the whole pile, so nothing is left stranded. A hand-in may pay revenue into the pile (some tax tokens
/// do their tax work inside ordinary transfers): the payout is fixed before it and the new revenue stays for the
/// remaining holders; a hand-in that takes from the pile is refused.
/// Circulating supply leaves out DEAD, address(0), this contract and up to four excluded holders fixed at
/// construction, so the last holder property holds with them: when every token outside them is handed in, the pile
/// is empty.
/// There is no owner, no setter, no pause and no upgrade path: `token`, `asset` and the excluded holders are
/// immutable.
contract FeeRules is IFeeRules {
    /// @inheritdoc IFeeRules
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    /// @inheritdoc IFeeRules
    address public immutable token;
    /// @inheritdoc IFeeRules
    address public immutable asset;

    /// @notice The most excluded holders a pile can have.
    uint256 public constant MAX_EXCLUDED = 4;
    uint256 private immutable _excludedCount;
    address private immutable _ex0;
    address private immutable _ex1;
    address private immutable _ex2;
    address private immutable _ex3;

    /// @inheritdoc IFeeRules
    uint256 public totalTokensRedeemed;
    /// @inheritdoc IFeeRules
    uint256 public totalPaidOut;

    /// @dev The pile as last reported by `RevenueRecognised`; only feeds that event, never a payout.
    uint256 private _recognised;
    uint256 private _lock = 1;

    /// @notice A zero token, a token equal to the asset, or an excluded list that is too long, holds zero, DEAD,
    /// the token, or a duplicate.
    error InvalidConfig();
    /// @notice Redemption paid to the zero address or to this contract.
    error InvalidRecipient();
    /// @notice Native coin sent while the pile is held in an ERC-20.
    error NativeNotAccepted();

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(address token_, address asset_, address[] memory excluded_) {
        if (token_ == address(0) || token_ == asset_) revert InvalidConfig();
        uint256 n = excluded_.length;
        if (n > MAX_EXCLUDED) revert InvalidConfig();
        for (uint256 i; i < n; ++i) {
            address e = excluded_[i];
            if (e == address(0) || e == DEAD || e == token_ || e == address(this)) revert InvalidConfig();
            for (uint256 j; j < i; ++j) {
                if (excluded_[j] == e) revert InvalidConfig();
            }
        }
        token = token_;
        asset = asset_;
        _excludedCount = n;
        _ex0 = n > 0 ? excluded_[0] : address(0);
        _ex1 = n > 1 ? excluded_[1] : address(0);
        _ex2 = n > 2 ? excluded_[2] : address(0);
        _ex3 = n > 3 ? excluded_[3] : address(0);
    }

    /// @notice Revenue in the native coin, or the empty wake call that follows an ERC-20 payment. No work here.
    receive() external payable virtual {
        if (msg.value != 0 && asset != address(0)) revert NativeNotAccepted();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Views
    // ─────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IFeeRules
    function pile() public view returns (uint256) {
        return asset == address(0) ? address(this).balance : IERC20Like(asset).balanceOf(address(this));
    }

    /// @inheritdoc IFeeRules
    function excludedHolders() public view returns (address[] memory list) {
        uint256 n = _excludedCount;
        list = new address[](n);
        if (n > 0) list[0] = _ex0;
        if (n > 1) list[1] = _ex1;
        if (n > 2) list[2] = _ex2;
        if (n > 3) list[3] = _ex3;
    }

    /// @notice Whether `account` is one of the excluded holders (it may not redeem).
    function isExcluded(address account) public view returns (bool) {
        uint256 n = _excludedCount;
        return (n > 0 && account == _ex0) || (n > 1 && account == _ex1) || (n > 2 && account == _ex2)
            || (n > 3 && account == _ex3);
    }

    /// @inheritdoc IFeeRules
    function circulatingSupply() public view returns (uint256) {
        IERC20Like t = IERC20Like(token);
        uint256 supply = t.totalSupply();
        uint256 gone = t.balanceOf(DEAD) + t.balanceOf(address(0)) + t.balanceOf(address(this));
        uint256 n = _excludedCount;
        if (n > 0) gone += t.balanceOf(_ex0);
        if (n > 1) gone += t.balanceOf(_ex1);
        if (n > 2) gone += t.balanceOf(_ex2);
        if (n > 3) gone += t.balanceOf(_ex3);
        return gone >= supply ? 0 : supply - gone;
    }

    /// @inheritdoc IFeeRules
    function quoteRedeem(uint256 amount) public view returns (uint256 assetOut) {
        if (amount == 0) return 0;
        uint256 circulating = circulatingSupply();
        if (amount > circulating) revert ExceedsCirculating(amount, circulating);
        return _quote(pile(), amount, circulating);
    }

    /// @inheritdoc IFeeRules
    function totalReceived() external view returns (uint256) {
        return pile() + totalPaidOut;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Actions
    // ─────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IFeeRules
    function redeem(uint256 amount, uint256 minOut) external returns (uint256 assetOut) {
        return _redeem(amount, minOut, msg.sender);
    }

    /// @inheritdoc IFeeRules
    function redeemTo(uint256 amount, uint256 minOut, address to) external returns (uint256 assetOut) {
        return _redeem(amount, minOut, to);
    }

    /// @inheritdoc IFeeRules
    function sync() external nonReentrant {
        _recognise();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internals
    // ─────────────────────────────────────────────────────────────────────────

    function _redeem(uint256 amount, uint256 minOut, address to) private nonReentrant returns (uint256 assetOut) {
        if (amount == 0) revert ZeroAmount();
        if (to == address(0) || to == address(this)) revert InvalidRecipient();
        if (isExcluded(msg.sender)) revert ExcludedHolder(msg.sender);
        uint256 pileBefore = _recognise();

        IERC20Like t = IERC20Like(token);
        uint256 circulating = circulatingSupply();
        if (amount > circulating) revert ExceedsCirculating(amount, circulating);
        assetOut = _quote(pileBefore, amount, circulating);

        // Hand-in: exactly `amount` leaves the holder, at least `amount` reaches DEAD, and the pile does not shrink.
        // Some tax tokens run their pending tax work inside ordinary transfers and pay this pile in the same call:
        // that revenue is recognised below and stays in the pile for the remaining holders (the payout was fixed
        // above from the pile and the circulating supply as they were before the hand-in). "At least" at DEAD: a
        // token may burn its own tax there in the same transfer; the holder's debit is exact, so any extra came from
        // elsewhere and only lowers the circulating supply for the holders who remain (it can raise nobody's payout
        // here, which is already fixed), and if it ends circulation this redemption is the last one (below).
        uint256 holderBefore = t.balanceOf(msg.sender);
        uint256 deadBefore = t.balanceOf(DEAD);
        _callOptionalBool(address(t), abi.encodeCall(IERC20Like.transferFrom, (msg.sender, DEAD, amount)));
        uint256 pileMid = pile();
        if (
            t.balanceOf(DEAD) < deadBefore + amount || holderBefore < amount
                || t.balanceOf(msg.sender) != holderBefore - amount || pileMid < pileBefore
        ) revert InexactMovement();
        if (pileMid > pileBefore) emit RevenueRecognised(pileMid - pileBefore, pileMid);
        // Decided by the supply AFTER the hand-in: if nothing circulates any more, this is the last redemption and
        // it takes the whole pile, revenue that arrived during the hand-in and tokens burned with it included.
        if (circulatingSupply() == 0) assetOut = pileMid;
        // `minOut` is compared with the final payout; a refusal rolls the hand-in back.
        if (assetOut < minOut) revert BelowMinimum(assetOut, minOut);

        totalTokensRedeemed += amount;
        totalPaidOut += assetOut;
        _recognised = pileMid - assetOut;

        // Payout, exact against the fresh snapshot `pileMid`: the pile loses exactly `assetOut`, and for an ERC-20
        // the recipient gains exactly `assetOut` (an asset that taxes or skips its own transfers is refused, so
        // nobody is paid below `minOut` and `totalPaidOut` is what was really paid). For the native coin the debit
        // is exact by the transfer itself; a recipient that pays the pile back during its own payment is refused,
        // so no revenue can arrive after a payout's numbers were fixed.
        if (assetOut != 0) {
            if (asset == address(0)) {
                (bool ok,) = to.call{value: assetOut}("");
                if (!ok) revert PaymentFailed();
            } else {
                uint256 toBefore = IERC20Like(asset).balanceOf(to);
                _callOptionalBool(asset, abi.encodeCall(IERC20Like.transfer, (to, assetOut)));
                if (IERC20Like(asset).balanceOf(to) != toBefore + assetOut) revert InexactMovement();
            }
            if (pile() != pileMid - assetOut) revert InexactMovement();
        }
        emit Redeemed(msg.sender, to, amount, assetOut);
    }

    /// @dev Reports revenue that arrived since the last report and returns the live pile.
    function _recognise() private returns (uint256 current) {
        current = pile();
        uint256 seen = _recognised;
        if (current > seen) {
            _recognised = current;
            emit RevenueRecognised(current - seen, current);
        } else if (current < seen) {
            _recognised = current; // only reachable through a payout, which already moved the baseline
        }
    }

    function _quote(uint256 balance, uint256 amount, uint256 circulating) private pure returns (uint256) {
        if (amount == circulating) return balance; // the last holder empties the pile
        return _mulDiv(balance, amount, circulating);
    }

    /// @dev floor(a * b / d) with a 512-bit intermediate (the standard Remco Bloemen algorithm). d > 0.
    function _mulDiv(uint256 a, uint256 b, uint256 d) private pure returns (uint256 result) {
        unchecked {
            uint256 prod0;
            uint256 prod1;
            assembly {
                let mm := mulmod(a, b, not(0))
                prod0 := mul(a, b)
                prod1 := sub(sub(mm, prod0), lt(mm, prod0))
            }
            if (prod1 == 0) return prod0 / d;
            require(d > prod1);
            uint256 remainder;
            assembly {
                remainder := mulmod(a, b, d)
                prod1 := sub(prod1, gt(remainder, prod0))
                prod0 := sub(prod0, remainder)
            }
            uint256 twos = d & (~d + 1);
            assembly {
                d := div(d, twos)
                prod0 := div(prod0, twos)
                twos := add(div(sub(0, twos), twos), 1)
            }
            prod0 |= prod1 * twos;
            uint256 inv = (3 * d) ^ 2;
            inv *= 2 - d * inv;
            inv *= 2 - d * inv;
            inv *= 2 - d * inv;
            inv *= 2 - d * inv;
            inv *= 2 - d * inv;
            inv *= 2 - d * inv;
            result = prod0 * inv;
        }
    }

    /// @dev Calls an ERC-20 function that returns a bool or nothing; reverts on failure or on `false`.
    function _callOptionalBool(address target, bytes memory data) private {
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool))) || (ret.length == 0 && target.code.length == 0)) {
            revert InexactMovement();
        }
    }
}
