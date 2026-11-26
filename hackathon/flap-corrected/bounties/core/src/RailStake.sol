// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IRailStake} from "./IRailStake.sol";

interface IRailStakeParams {
    function parameters() external view returns (address creator, address token, address asset, uint256 period);
}

/// @title RailStake
/// @notice Holder payouts on a token that keeps no balance history (a token born on someone else's launchpad):
/// holders stake the token and are paid the income that arrives here, evenly per staked token and second.
///
/// Properties, each with the harm it prevents:
/// - P1 Only the staker takes its stake out, in full, at any time: `unstake` has no time lock, no fee, no condition, and
///   touches only the token (never the asset), so a refusing asset, a failed payment or a huge unsynced amount cannot
///   freeze a stake. "In full" means the credited amount is sent: a token that taxes plain transfers delivers less
///   to the staker on the way out exactly as on the way in, and a token that stops its own transfers, or reports
///   success while moving nothing, cannot be helped. (Harm: holders' tokens held hostage by the payout side.)
/// - P2 Amounts are measured by balance: a stake is credited what this contract's token balance actually grew by,
///   and both reads must answer (a failed read reverts the stake, it never reads as zero); income is what the asset
///   balance holds above what is already counted. (Harm: a taxing token or one that does work inside transfers
///   credits more than arrived, and the last unstaker is short; a read that fails before the transfer would credit
///   the whole pool to the newcomer.)
/// - P3 Paid never exceeds arrived: with S = PRECISION, at every moment, over COUNTED income,
///   claimed * S + sum over stakers of earnedScaled() + undistributedScaled() == arrived * S exactly; income that
///   has arrived but no sync has counted is unsynced() on top. A claim pays only whole units of its own earnedScaled
///   and keeps the fraction, so rounding stays in the contract and is never lost or paid twice: two equal stakers
///   can each hold half a unit, claimable() shows whole units, and the fraction stays theirs.
/// - P4 Even over time: what is counted streams to the stakers per second, at ratePerSecond() = undistributed /
///   seconds left; a stake earns its share of each second it is staked and nothing for seconds it is not. A sync
///   that counts `income` while L is still streaming with r seconds left sets the seconds left to the amount-weighted
///   mean (L * r + income * period) / (L + income), which raises the rate from L / r by at most income / period
///   (Titu: (L + i)^2 / (L r + i p) <= L / r + i / p). So someone who stakes just before a sync and leaves s seconds
///   after earns at most its share of (L / r + income / period) * s plus one increment (a waiting carry, see
///   "Checkpoints change nothing beyond one increment"), times (R + 1) / R for the new end's rounding down to a whole second (R its
///   seconds left): the income itself yields it at most income * s / period more than staking at any other moment.
///   (Harm: a just-in-time staker taking the payment.)
/// - P5 Income while nobody stakes waits: unsynced income stays in the balance until a sync counts it; counted
///   income still streaming pauses (the stream's end moves with the clock while totalStaked is 0) and resumes, with
///   the same remaining seconds, when someone stakes. The first staker after a pause receives the stream at the
///   paused rate for as long as it stays alone: it cannot take the waiting amount at once, only per second.
/// - P6 No entry can be re-entered: stake, unstake, sync and claim share one lock; receiving does no work.
/// - P7 Nothing stops it for good: at most MAX_OUTSTANDING is counted and not yet claimed at a time (more waits in
///   the balance and is counted as claims make room), so an open-mint asset sent in any amount cannot overflow the
///   arithmetic; an asset or token that returns nothing is accepted, one that returns false or reverts fails only
///   the call that moves it (a claim stays owed; claimTo pays elsewhere).
/// - Checkpoints change nothing beyond one increment: a checkpoint (a sync, a stake, an unstake, a claim) streams the
///   elapsed seconds' share, rounded down; what does not yet make a whole increment per staked unit (one increment =
///   totalStaked / 1e27 asset units) waits in a carry with no time attached and is allocated at the first checkpoint
///   where it does. So checkpoints every block neither push income toward the end of the stream nor pull it forward,
///   beyond one increment. A staker who arrives while a carry waits shares it, and after a full exit and a pause the
///   whole waiting carry goes to whoever stakes next: below one increment at the OLD total, that is below one asset
///   unit for an old total of 1e27 raw token units and below 1e6 asset units (one unit of a six-decimal asset) for
///   1e33.
/// - Caller influence: the moment of a sync. New income lengthens the stream only by its own weight (P4), so a
///   tiny income synced every block moves the end by nothing measurable (each sync by at most
///   period * income / (L + income), rounded down) and cannot stretch a stream that should end. Delaying a sync
///   delays the start of new income's stream; anyone can sync. A sync that counts nothing changes no running stream.
/// - Receiving: a native payment with value is refused when the asset is an ERC-20 (it could never be counted or
///   leave; a splitter paying in the wrong asset keeps its part owed); a zero-value call is accepted.
///
/// Supported tokens and assets: a staking token and an asset that debit exactly the amount a transfer names (a token
/// that takes more than it is asked, or an asset that reports success without moving anything, breaks the books:
/// nothing here can detect it for an outgoing transfer). A token that taxes plain transfers is supported and delivers
/// less on the way out, as on the way in (pinned: 81 of 90 at 10%).
///
/// Stated limits: tokens sent here without `stake` are credited to nobody and stay; a token that takes tokens from
/// holders' balances without a transfer (negative rebase) can leave the last unstakers short; an asset whose balance
/// shrinks on its own leaves the last claims short. `claimTo` refuses the zero address and the stake itself (a claim
/// paid here would count as claimed and then arrive again as income).
/// - Supported range: what does not divide evenly among the staked units after a stream ends waits in the carry,
///   less than one increment (totalStaked / 1e27 asset units): below one asset unit while totalStaked is under 1e27
///   raw token units (1e9 tokens of 18 decimals); beyond that it can be several units and waits for the next income
///   or a smaller total. totalStaked is assumed below 2^255.
/// - With an asset anyone can mint, a huge amount fills MAX_OUTSTANDING and real income that arrives after it waits,
///   uncounted, until stakers claim and make room (it streams like any income, over about a period).
/// - The accumulator: it grows by at most what is released * 1e27 / totalStaked, and at most about MAX_OUTSTANDING
///   (2^112) asset units can be released per second; even at that rate every second with a total stake of one raw
///   unit, the arithmetic overflows only after 2^256 / (2^113 * 1e27) seconds, more than 3e8 years.
/// - `ratePerSecond()` rounds down to whole asset units and can read 0 while a stream pays; `ratePerSecondScaled()`
///   is the same rate * 1e27.
contract RailStake is IRailStake {
    uint256 public constant PRECISION = 1e27;
    uint256 public constant MAX_OUTSTANDING = 2 ** 112 - 1;

    address public immutable factory;
    address public immutable creator;
    address public immutable token;
    address public immutable asset;
    uint256 public immutable period;

    uint256 public totalStaked;
    mapping(address => uint256) public stakedOf;

    uint256 public arrived;
    uint256 public claimed;

    uint256 private _acc; // asset * PRECISION per staked token unit, accumulated
    uint256 private _uScaled; // counted income still to stream, * PRECISION
    uint256 private _carry; // streamed, not yet a whole increment per staked unit, * PRECISION
    uint256 private _last; // last accrual time
    uint256 private _end; // end of the current stream
    mapping(address => uint256) private _accOf;
    mapping(address => uint256) private _owedScaled;

    uint256 private _lock = 1;

    modifier locked() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor() {
        factory = msg.sender;
        (creator, token, asset, period) = IRailStakeParams(msg.sender).parameters();
        _last = block.timestamp;
        _end = block.timestamp;
    }

    /// Receives native income; does no work. Refuses value when the asset is an ERC-20 (it could never leave).
    receive() external payable {
        if (msg.value > 0 && asset != address(0)) revert WrongAsset();
    }

    // ── actions ─────────────────────────────────────────────────────────────

    function stake(uint256 amount) external locked returns (uint256 credited) {
        if (amount == 0) revert ZeroAmount();
        _update();
        _settle(msg.sender);
        uint256 before = _strictTokenBalance(); // both reads must answer: a failed read is never a zero
        (bool ok, bytes memory ret) =
            token.call(abi.encodeWithSelector(0x23b872dd, msg.sender, address(this), amount)); // transferFrom
        if (!ok || !_okReturn(ret)) revert TransferFailed();
        uint256 after_ = _strictTokenBalance();
        credited = after_ > before ? after_ - before : 0;
        if (credited == 0) revert ZeroAmount();
        stakedOf[msg.sender] += credited;
        totalStaked += credited;
        emit Staked(msg.sender, credited);
    }

    function unstake(uint256 amount) external locked {
        if (amount == 0) revert ZeroAmount();
        uint256 s = stakedOf[msg.sender];
        if (amount > s) revert NotStaked(s);
        _update();
        _settle(msg.sender);
        stakedOf[msg.sender] = s - amount;
        totalStaked -= amount;
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0xa9059cbb, msg.sender, amount)); // transfer
        if (!ok || !_okReturn(ret)) revert TransferFailed();
        emit Unstaked(msg.sender, amount);
    }

    function sync() external locked returns (uint256 income) {
        _update();
        uint256 held = arrived - claimed;
        uint256 bal = _assetBalance();
        if (bal > held) {
            income = bal - held;
            uint256 room = MAX_OUTSTANDING > held ? MAX_OUTSTANDING - held : 0;
            if (income > room) income = room;
        }
        if (income > 0) {
            arrived += income;
            uint256 left = _uScaled; // L, scaled
            uint256 secondsLeft = _end > block.timestamp ? _end - block.timestamp : 0;
            uint256 added = income * PRECISION;
            // the amount-weighted mean of the leftover's seconds left and a full period for the new income
            _end = block.timestamp + (left * secondsLeft + added * period) / (left + added);
            _uScaled = left + added;
        }
        emit Synced(income, (_uScaled + _carry) / PRECISION, _end);
    }

    function claim() external locked returns (uint256 paid) {
        paid = _claim(msg.sender);
    }

    function claimTo(address to) external locked returns (uint256 paid) {
        // a claim paid to the stake would count as claimed and then arrive again as income
        if (to == address(0) || to == address(this)) revert BadReceiver();
        paid = _claim(to);
    }

    // ── reads ───────────────────────────────────────────────────────────────

    function claimable(address account) external view returns (uint256) {
        return earnedScaled(account) / PRECISION;
    }

    /// What `account` has earned so far, * PRECISION (claims pay whole units and keep the fraction).
    function earnedScaled(address account) public view returns (uint256) {
        (uint256 acc,,,) = _accrue();
        return _owedScaled[account] + stakedOf[account] * (acc - _accOf[account]);
    }

    function undistributed() external view returns (uint256) {
        return undistributedScaled() / PRECISION;
    }

    /// Still to stream plus the carry: everything counted that is in nobody's earnings yet.
    function undistributedScaled() public view returns (uint256) {
        (, uint256 u,, uint256 carry) = _accrue();
        return u + carry;
    }

    function streamEnd() external view returns (uint256 end) {
        (,, end,) = _accrue();
    }

    function unsynced() external view returns (uint256) {
        uint256 held = arrived - claimed;
        uint256 bal = _assetBalance();
        return bal > held ? bal - held : 0;
    }

    function ratePerSecond() external view returns (uint256) {
        return ratePerSecondScaled() / PRECISION;
    }

    /// The rate * PRECISION (a page divides it itself: the whole-unit rate can read 0 while a stream pays).
    function ratePerSecondScaled() public view returns (uint256) {
        (, uint256 u, uint256 end,) = _accrue();
        if (totalStaked == 0 || end <= block.timestamp) return 0;
        return u / (end - block.timestamp);
    }

    // ── internals ───────────────────────────────────────────────────────────

    /// The accrual up to now: streams the elapsed share of what is undistributed into a carry and allocates the carry
    /// to the stakers in whole increments per staked unit (the rest waits for the next checkpoint); while nobody is
    /// staked, moves the stream's end with the clock (a pause) and the carry waits.
    function _accrue() internal view returns (uint256 acc, uint256 u, uint256 end, uint256 carry) {
        acc = _acc;
        u = _uScaled;
        end = _end;
        carry = _carry;
        uint256 last = _last;
        uint256 t = block.timestamp;
        if (t <= last) return (acc, u, end, carry);
        uint256 total = totalStaked;
        if (total == 0) return (acc, u, end > last ? end + (t - last) : end, carry); // the pause
        if (end > last) {
            uint256 upTo = t < end ? t : end;
            uint256 release = u * (upTo - last) / (end - last); // u <= 2^112 * 1e27 < 2^202; end - last <= period
            u -= release;
            carry += release;
        }
        uint256 inc = carry / total;
        acc += inc;
        carry -= inc * total; // less than one increment waits, with no time attached
    }

    function _update() internal {
        (_acc, _uScaled, _end, _carry) = _accrue();
        _last = block.timestamp;
    }

    function _settle(address account) internal {
        uint256 acc = _acc;
        _owedScaled[account] += stakedOf[account] * (acc - _accOf[account]);
        _accOf[account] = acc;
    }

    function _claim(address to) internal returns (uint256 paid) {
        _update();
        _settle(msg.sender);
        uint256 owed = _owedScaled[msg.sender];
        paid = owed / PRECISION;
        if (paid == 0) return 0;
        _owedScaled[msg.sender] = owed - paid * PRECISION;
        claimed += paid;
        bool ok;
        if (asset == address(0)) {
            (ok,) = to.call{value: paid}("");
        } else {
            bytes memory ret;
            (ok, ret) = asset.call(abi.encodeWithSelector(0xa9059cbb, to, paid));
            ok = ok && _okReturn(ret);
        }
        if (!ok) revert TransferFailed();
        emit Claimed(msg.sender, to, paid);
    }

    function _strictTokenBalance() internal view returns (uint256) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSelector(0x70a08231, address(this)));
        if (!ok || ret.length < 32) revert BalanceUnreadable();
        return abi.decode(ret, (uint256));
    }

    function _assetBalance() internal view returns (uint256) {
        return asset == address(0) ? address(this).balance : _balanceOf(asset);
    }

    function _balanceOf(address erc20) internal view returns (uint256) {
        (bool ok, bytes memory ret) = erc20.staticcall(abi.encodeWithSelector(0x70a08231, address(this)));
        if (!ok || ret.length < 32) return 0;
        return abi.decode(ret, (uint256));
    }

    /// Nothing, or a word equal to 1.
    function _okReturn(bytes memory ret) internal pure returns (bool) {
        if (ret.length == 0) return true;
        if (ret.length < 32) return false;
        return abi.decode(ret, (uint256)) == 1;
    }
}
