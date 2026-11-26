// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";

/// @notice Test helpers for the clock-time open (DECISION-LOG F80; docs/design/open-at-clock-time.md): the block number
/// and the time move together, 12 seconds a block, as on Ethereum, so a test written in blocks keeps its meaning.
/// `to` lands on an exact second (the per-second probes); `toSlot` lands on the next block of a 12-second slot grid
/// anchored at the current block, as a chain without missed slots would.
library OpenTime {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 internal constant SLOT = 12;

    /// @dev Forward to time `t` (never back: the samplers and the drand source read the clock), the block number moved
    /// by one per started 12 s.
    function to(uint256 t) internal {
        uint256 now_ = VM.getBlockTimestamp();
        if (t <= now_) return;
        VM.roll(VM.getBlockNumber() + (t - now_ + SLOT - 1) / SLOT);
        VM.warp(t);
    }

    /// @dev Forward to the first block at or after `t` on the 12-second grid of the current block (Ethereum's slots,
    /// none missed): the block a chain would actually produce for "the first block at or after t".
    function toSlot(uint256 t) internal {
        uint256 now_ = VM.getBlockTimestamp();
        if (t <= now_) return;
        uint256 slots = (t - now_ + SLOT - 1) / SLOT;
        VM.roll(VM.getBlockNumber() + slots);
        VM.warp(now_ + SLOT * slots);
    }

    /// @dev To the start of step `k` of the window that opens at `openAt` (step 0 is the open; 32 is the window's end).
    function toStep(uint256 openAt, uint256 k) internal {
        to(openAt + SLOT * k);
    }

    /// @dev The openAt `blocks` blocks of 12 s from now (what the old openDelayBlocks meant).
    function inBlocks(uint256 blocks) internal view returns (uint32) {
        return uint32(VM.getBlockTimestamp() + SLOT * blocks);
    }
}
