// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Reentrancy lock in EIP-1153 transient storage (available on Sepolia and mainnet since Dencun).
/// The slot is cleared at the end of every guarded call and by the EVM at the end of each transaction.
abstract contract TransientReentrancyGuard {
    error Reentrancy();

    /// @dev `uint256(keccak256("squarehole.reentrancy.lock")) - 1`.
    uint256 private constant _LOCK_SLOT = 0xef31a04cf6d735a65317e38e827797a212a707e4f76ab21853f1c9877af28024;

    modifier nonReentrant() {
        assembly ("memory-safe") {
            if tload(_LOCK_SLOT) {
                mstore(0x00, 0xab143c06) // `Reentrancy()`.
                revert(0x1c, 0x04)
            }
            tstore(_LOCK_SLOT, 1)
        }
        _;
        assembly ("memory-safe") {
            tstore(_LOCK_SLOT, 0)
        }
    }

    /// @dev The same lock as `nonReentrant` (same slot, same `Reentrancy()` revert), taken and released by two calls
    /// instead of inline code. For a contract close to EIP-170 with many guarded functions: the inline lock repeats
    /// the 32-byte slot three times in each (BoxTickets, F75 W3). Unused, it adds no byte to any contract.
    modifier nonReentrantCall() {
        _enterLock();
        _;
        _exitLock();
    }

    function _enterLock() private {
        assembly ("memory-safe") {
            if tload(_LOCK_SLOT) {
                mstore(0x00, 0xab143c06) // `Reentrancy()`.
                revert(0x1c, 0x04)
            }
            tstore(_LOCK_SLOT, 1)
        }
    }

    function _exitLock() private {
        assembly ("memory-safe") {
            tstore(_LOCK_SLOT, 0)
        }
    }

    /// @dev True while a `nonReentrant` function of this contract is executing (e.g. to accept a PoolManager
    /// unlock callback only from inside this contract's own guarded payout).
    function _insideGuardedCall() internal view returns (bool locked) {
        assembly ("memory-safe") {
            locked := tload(_LOCK_SLOT)
        }
    }
}
