// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Core v2 M1: a wave-1 library frozen as a stub before wave 1 (wave 0's integrated review, finding M3; file map § 2, §
// 1 rule 8). Its owner, M1-31, writes the bodies and may add entries; the entries below are called by the vault copy
// (M1-30-b) in wave 1, so a change to one goes through the integrator. Signatures [P]: the integrator's, from the
// frozen interfaces they serve. Bodies: M1-31 (wave 1).

import {IBoxVaultV2} from "../interfaces/IBoxVaultV2.sol";

/// @notice The ERC-721 entry `release` uses: `transferFrom`, so a creator that is a contract with no
/// `onERC721Received` still gets its items back (F99) [P].
interface IVaultFailureItems {
    function transferFrom(address from, address to, uint256 id) external;
}

/// @notice F114 R28B: the vault owns the failure clock; tickets read the same boundary.
interface IVaultFailureClock {
    function failureWindowEnds() external view returns (uint256);
}

/// @title VaultFailure (the vault's failure path)
/// @notice `enterFailure` and `releaseToCreator` (F99: the creator's unused NFTs go back to the creator), and the
/// hand-back quote frozen at the failure (review round 1).
/// @dev State at its own ERC-7201 slot (file map § 1 rule 3), so the vault's storage base is untouched. `enter` moves
/// no item (`IBoxCoordinatorV2` step 1); `release` runs after it, called by anyone through the shell, in batches, and
/// reads no quote. After the failure no price reads the live A or n (`failed-launch-recovery.md:427`, "no function
/// reads A/n for a price once failed"): the hand-back and K use the quote `enter(A, n)` froze.
library VaultFailure {
    /// @notice The wave-0 stub's refusal. No built entry reverts with it; it stays declared because the frozen
    /// `LibraryStubs.t.sol` names it (SH-V2-M1-31.md, change request 1).
    error NotBuilt();
    /// @notice A quote entry after the zero-argument `enter()`: the vault failed, but froze no quote (review round 2).
    error QuoteNotFrozen();
    /// @notice The 14-day hand-back window ended; only failure-terminal cancellations remain available.
    error FailureWindowClosed(uint256 endsAt);

    uint256 internal constant HAND_BACK_WINDOW = 14 days;

    /// @custom:storage-location erc7201:squarehole.v2.BoxVaultV2.VaultFailure
    struct Layout {
        bool entered;
        bool quoteFrozen;
        uint40 failedAt;
        /// ⌊A ÷ n⌋ at step 1: one placeholder's hand-back after the failure.
        uint256 quote;
    }

    /// @notice keccak256(abi.encode(uint256(keccak256("squarehole.v2.BoxVaultV2.VaultFailure")) - 1)) &
    /// ~bytes32(uint256(0xff)) (file map § 1 rule 3).
    bytes32 internal constant LAYOUT_SLOT = 0x11982c77a3170037e2639c081ae6407a20c775dffbe9baa42abb49116fca6500;

    /// @notice Once, inside the vault's `enterFailure()` (the shell checks the caller; `AlreadyFailed`). Emits
    /// `FailureEntered(msg.sender, block.timestamp)` from the vault, so the shell emits nothing more (a shell that
    /// emits it too reports the failure twice). Freezes no quote: the vault copy calls `enter(A, n)` instead (change
    /// request 6), and after this entry alone the quote entries revert `QuoteNotFrozen`.
    function enter() internal {
        Layout storage s = _layout();
        if (s.entered) revert IBoxVaultV2.AlreadyFailed();
        s.entered = true;
        // Timestamps fit in 40 bits for another 34,000 years, as the vault's counts do.
        // forge-lint: disable-next-line(unsafe-typecast)
        s.failedAt = uint40(block.timestamp);
        // forge-lint: disable-next-line(reentrancy-events)
        emit IBoxVaultV2.FailureEntered(msg.sender, block.timestamp);
    }

    /// @notice `enter` with the hand-back quote frozen (review round 1, change request 6): the vault's
    /// `enterFailure()` calls this in place of `enter()`, with its active supply A (T's supply less the escrow) and the
    /// items inside n read before any burn (step 1). One placeholder then hands back exactly ⌊A ÷ n⌋ of T for good
    /// (`failed-launch-recovery.md:427`, `:430`: "frozenQuote"), whatever the failure's burns and the releases later do
    /// to A and n, so K below is fixed from step 1 and no release can raise a hand-back. Precondition: `inside` ≥ 1
    /// whenever a placeholder is open (the vault keeps its last item, `LastItem`; before graduation n = N − t). With
    /// `inside` 0 the quote is 0 and the whole escrow reads as K, which is right only with no placeholder open.
    function enter(uint256 activeSupply, uint256 inside) internal {
        enter();
        Layout storage s = _layout();
        s.quoteFrozen = true;
        s.quote = inside == 0 ? 0 : activeSupply / inside;
    }

    /// @notice After a frozen `enter`: the T `count` placeholders hand back, `count` × ⌊A ÷ n⌋, no fee (change request
    /// 6). Refuses before the failure (`NotFailed`) and after the zero-argument `enter()` (`QuoteNotFrozen`).
    function quoteAtFailure(uint256 count) internal view returns (uint256) {
        Layout storage s = _layout();
        if (!s.quoteFrozen) {
            if (s.entered) revert QuoteNotFrozen();
            revert IBoxVaultV2.NotFailed();
        }
        return count * s.quote;
    }

    /// @notice After a frozen `enter`: the escrow surplus K = `escrow` − `tickets` × ⌊A ÷ n⌋, the T no placeholder can
    /// take out (`escrowSurplus()`'s shape; exact, so `kRemainder` is 0). Each hand-back lowers the escrow and the open
    /// placeholders together, so K stays what it was at step 1. `tickets` is the placeholders still open, not N − n:
    /// items released to the creator leave n, never the escrow.
    function surplusAtFailure(uint256 escrow, uint256 tickets)
        internal
        view
        returns (uint256 kFloor, uint256 kRemainder)
    {
        uint256 owed = quoteAtFailure(tickets);
        kFloor = escrow > owed ? escrow - owed : 0;
        kRemainder = 0;
    }

    /// @notice Refuses once the vault failed (`AlreadyFailed`): the vault copy's `openTickets` (so the tickets'
    /// `take()`) and every entry that would price at the live A and n after the failure (change request 6).
    function checkNotFailed() internal view {
        if (_layout().entered) revert IBoxVaultV2.AlreadyFailed();
    }

    /// @notice `IBoxVaultV2.failed`.
    function entered() internal view returns (bool) {
        return _layout().entered;
    }

    /// @notice Zero before failure; thereafter the exclusive end of fee-free ordinary hand-backs (F114 R28B).
    function windowEnds() internal view returns (uint256) {
        Layout storage s = _layout();
        return s.entered ? uint256(s.failedAt) + HAND_BACK_WINDOW : 0;
    }

    /// @notice The frozen quote remains readable for accounting forever; only hand-backs use this time guard.
    function checkHandBack(bool terminal) internal view {
        uint256 end = windowEnds();
        if (!terminal && block.timestamp >= end) revert FailureWindowClosed(end);
    }

    /// @notice Hands `ids` of `collection` to `creator` (`ReleasedToCreator`); the shell checks each id is one nobody
    /// kept (`NotReleasable`) and updates its own counts first. Refuses before `enter` (`NotFailed`) and an empty list
    /// (`InvalidIdList`).
    function release(address collection, address creator, uint256[] memory ids) internal {
        if (!_layout().entered) revert IBoxVaultV2.NotFailed();
        if (ids.length == 0) revert IBoxVaultV2.InvalidIdList();
        for (uint256 i; i < ids.length; ++i) {
            // forge-lint: disable-next-line(calls-loop)
            IVaultFailureItems(collection).transferFrom(address(this), creator, ids[i]);
        }
        // forge-lint: disable-next-line(reentrancy-events)
        emit IBoxVaultV2.ReleasedToCreator(creator, ids);
    }

    function _layout() private pure returns (Layout storage s) {
        bytes32 slot = LAYOUT_SLOT;
        assembly ("memory-safe") {
            s.slot := slot
        }
    }
}
