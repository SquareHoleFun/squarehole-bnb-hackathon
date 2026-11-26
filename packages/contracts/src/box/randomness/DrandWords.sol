// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IDrandSource} from "../interfaces/IDrandSource.sol";

/// @title DrandWords (slice S9; the consumer side of `IDrandSource`)
/// @notice What a consumer of the drand source does with its words, written once for the box core: the tickets
/// add-on (S3, `IBoxTickets`: the graduation word, key 0, and one word per draw ticket) and anything else that pulls a
/// word. Copied from the consumer side of `MisfitsPlaceholders` (src/v2/MisfitsPlaceholders.sol at `46a030f6`) with
/// the Chainlink fee and its refund path removed (F61 R4: drand only):
/// - `request`: the request with its posting bounty, which replaces `source.requestFee()` and
///   `source.request{value: fee}(key, refundTo)` (`:334-341`, `:377-391`); nothing comes back, so no refund path.
/// - `payRound` / `checkFunded` / `roundTarget`: the posting bounty funded from the draw price (F54: "gas built into
///   the draw price"; F66 K6: the public chores are paid from what users already pay; F75 W3: "the draw pays the drand
///   round's posting"). After a draw's request (or requests: a draw that also sends the graduation word makes two in
///   one block, and they share one round) the round's pot must hold at least `BOUNTY_GAS` × the block's base fee. That
///   pays whoever posts the round (the drawer's own page, our keeper, the open-source bot or a searcher), so the queue
///   moves when nobody of ours runs. `payRound` (BoxTickets, since the review of sh-f75) tops the pot up from the
///   draw's value and refunds the rest, so only the first draw of a round pays and every page can send the whole
///   target; `checkFunded` only checks a pot the draw already added its whole value to (no refund). Requests that carry
///   no draw (the graduation word, requested by the coordinator's graduation poke) need none; anyone may add one
///   (`IDrandSource.addBounty`).
/// - `wordOf`: the gas-bounded read (`:769-789`): a source that reverts, burns its gas or answers short reads as "no
///   word"; a caller that leaves too little gas for the full read reverts `GasTooLow`, so a failure is always the
///   source's own.
/// - `usable` / `usableWord`: a word counts if it is non-zero and was ready no earlier than its request, no later than
///   now and no later than `SILENCE` after the request (`:757-767`).
/// - `isDead`: the queue-head rule behind terminal mode (`:731-755`): past the deadline without a usable word. For a
///   request made at `requestedAt` through the pinned source this equals `IDrandSource.isSilent`, and like it, once
///   true it stays true.
/// - `isDelegation`: an EIP-7702 delegated account (`:791-799`), for the consumer's and the factory's pin checks.
/// @dev Internal functions only (inlined into the consumer). The constants are the version's (launch pipeline § 1:
/// "the randomness source" and the ticket timers are fixed per version).
library DrandWords {
    /// @notice The caller left too little gas for the bounded `wordOf` read.
    error GasTooLow();
    /// @notice A draw left its round's pot below the target (`roundTarget`).
    error BountyTooLow(uint256 pot, uint256 needed);

    /// @notice Gas one `wordOf` read gets (MisfitsPlaceholders.sol:191); the pinned source needs about 10,500 (measured, cold).
    uint256 internal constant WORD_GAS = 50_000;
    /// @dev The gas left that guarantees the read all of `WORD_GAS` (EIP-150 keeps 1/64) plus the call's own cost.
    uint256 internal constant WORD_GAS_REQUIRED = WORD_GAS + WORD_GAS / 63 + 5_000;
    /// @notice A word counts only if ready at most this long after its request (the source's `SILENCE`, F61 R4).
    uint256 internal constant SILENCE = 7 days;
    /// @notice The pot a drawn round must hold, in gas at the draw block's base fee: about 2.6 times a whole
    /// `postRound` transaction of a bountied round by a new poster today (229,538 measured) and about 1.5 times one
    /// after Glamsterdam (406,678, where the round's and the poster's new slots cost state gas;
    /// docs/evidence/SH-S9-drand-source.md). The margin covers the base fee rising by 12.5% a block for the two blocks
    /// until the round can be posted, and a priority tip.
    uint256 internal constant BOUNTY_GAS = 600_000;

    // ------------------------------------------------------------------------------------------------------------
    // Requests and the bounty

    /// @notice The pot, in wei, a round drawn in this block must hold.
    function roundTarget() internal view returns (uint256) {
        return BOUNTY_GAS * block.basefee;
    }

    /// @notice Reverts `BountyTooLow` unless `round`'s pot holds `roundTarget()`; called after the draw's requests,
    /// which added its whole bounty to the pot (no refund: S9's model consumer); BoxTickets uses `payRound` instead.
    function checkFunded(IDrandSource source, uint256 round) internal view {
        uint256 pot = source.bountyOf(round);
        uint256 needed = roundTarget();
        if (pot < needed) revert BountyTooLow(pot, needed);
    }

    /// @notice Pays `round`'s posting from `value` (F75 W3, with the refund of the review of sh-f75): tops the pot up to
    /// `roundTarget()` and sends the rest back to `refundTo`; if `refundTo` refuses it, the rest joins the pot, so a
    /// contract that takes no ETH can still pay. Reverts `BountyTooLow(pot + value, target)` when `value` cannot reach
    /// the target. Called after the requests that fixed `round` (made with no value), with the consumer's own lock
    /// held: the refund hands control to `refundTo`. Nothing of `value` stays with the consumer. The target is this
    /// block's: a later payment for a round already paid gets all of `value` back at the same base fee, and at a higher
    /// base fee tops the pot up again and gets back the rest (box 0's own review FQ-29, F147).
    /// @dev A page cannot see the round its transaction will get (the including block fixes it) nor the other draws of
    /// that block, so every page sends the whole target; with the refund only the first draw of the round pays it.
    /// @return paid What went into the pot: the shortfall, or all of `value` when the refund was refused.
    function payRound(IDrandSource source, uint256 round, uint256 value, address refundTo)
        internal
        returns (uint256 paid)
    {
        uint256 pot = source.bountyOf(round);
        uint256 target = roundTarget();
        uint256 rest;
        // Unchecked: a pot is below 2^128 wei and value below the ETH supply; paid ≤ value once the check passed.
        unchecked {
            if (pot + value < target) revert BountyTooLow(pot + value, target);
            if (pot < target) paid = target - pot;
            rest = value - paid;
        }
        if (rest != 0) {
            bool sent;
            assembly ("memory-safe") {
                sent := call(gas(), refundTo, rest, 0, 0, 0, 0)
            }
            if (!sent) paid = value;
        }
        if (paid != 0) source.addBounty{value: paid}(round);
    }

    /// @notice Requests the word for (this contract, `key`), adding `bounty` wei to its round's pot. Reverts only if the
    /// key was requested before (`IDrandSource.AlreadyRequested`).
    /// @return round The quicknet round fixed for it (posting starts at `source.roundTime(round)`).
    function request(IDrandSource source, uint256 key, uint256 bounty) internal returns (uint256 round) {
        round = source.request{value: bounty}(key);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Reading words

    /// @notice `source.wordOf(this, key)` with `WORD_GAS` and a 64-byte return copied at most (copy of
    /// MisfitsPlaceholders.sol:772-789): (0, 0) when the source reverts, burns its gas, answers short or names a time
    /// past 2^64.
    function wordOf(IDrandSource source, uint256 key) internal view returns (bytes32 word, uint256 readyAt) {
        if (gasleft() < WORD_GAS_REQUIRED) revert GasTooLow();
        address src = address(source);
        bytes4 selector = IDrandSource.wordOf.selector;
        bool ok;
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            mstore(ptr, selector)
            mstore(add(ptr, 4), address())
            mstore(add(ptr, 36), key)
            ok := staticcall(WORD_GAS, src, ptr, 68, ptr, 64)
            if and(ok, gt(returndatasize(), 63)) {
                word := mload(ptr)
                readyAt := mload(add(ptr, 32))
            }
        }
        if (readyAt > type(uint64).max) return (bytes32(0), 0);
    }

    /// @notice Whether a word read for a request made at `requestedAt` counts (MisfitsPlaceholders.sol:759-767).
    function usable(bytes32 word, uint256 readyAt, uint256 requestedAt) internal view returns (bool) {
        return
            word != bytes32(0) && readyAt >= requestedAt && readyAt <= block.timestamp
                && readyAt <= requestedAt + SILENCE;
    }

    /// @notice The word of (this contract, `key`), when it was ready, and whether it counts.
    function usableWord(IDrandSource source, uint256 key, uint256 requestedAt)
        internal
        view
        returns (bytes32 word, uint256 readyAt, bool ok)
    {
        (word, readyAt) = wordOf(source, key);
        ok = usable(word, readyAt, requestedAt);
    }

    /// @notice The last moment a request made at `requestedAt` can still get a word that counts.
    function deadline(uint256 requestedAt) internal pure returns (uint256) {
        return requestedAt + SILENCE;
    }

    /// @notice A request made at `requestedAt` that is past its deadline without a word that counts: the queue head
    /// that lets anyone enter terminal mode (MisfitsPlaceholders.sol:749-754).
    function isDead(IDrandSource source, uint256 key, uint256 requestedAt) internal view returns (bool) {
        if (block.timestamp <= deadline(requestedAt)) return false;
        (,, bool ok) = usableWord(source, key, requestedAt);
        return !ok;
    }

    // ------------------------------------------------------------------------------------------------------------
    // Pin checks

    /// @notice An EIP-7702 delegated account: 23 bytes of code starting 0xef0100 (MisfitsPlaceholders.sol:791-799).
    function isDelegation(address account) internal view returns (bool delegated) {
        assembly ("memory-safe") {
            if eq(extcodesize(account), 23) {
                let ptr := mload(0x40)
                extcodecopy(account, ptr, 0, 3)
                delegated := eq(shr(232, mload(ptr)), 0xef0100)
            }
        }
    }
}
