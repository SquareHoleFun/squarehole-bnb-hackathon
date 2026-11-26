// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxBuildGuard} from "sh-box-build/BoxBuildV1.sol";
import {BoxClones} from "./libraries/BoxClones.sol";

/// @title BoxCloneBase
/// @notice The shared shape of a per-box clone implementation (core-v1-interfaces § 3; SH-S0-spikes § 2): settings are
/// the clone's immutable arguments, read from its own code; the box's coordinator (argument 0 of every box clone) is
/// the only caller of `initialize`, once. Generalises the S0 spike's `S0CloneImpl` (test/spikes/SpikeBoxFactory.sol:
/// 52-79), whose factory check becomes a coordinator check: the `coordinator` argument, which must also be a clone of
/// the version's coordinator implementation (`BoxClones.isCloneOf`; BC-100, review of sh-core-v1), whose `deploy` and
/// `launch` only the factory can call.
/// @dev The implementation itself is never initialised and holds nothing: every state-changing entry point refuses an
/// uninitialised clone (S0 decision 9), and the implementation is one. BoxBuildGuard (F78): empty in the mainnet build; in
/// the rehearsal build every implementation's constructor refuses chain id 1.
abstract contract BoxCloneBase is BoxBuildGuard {
    /// @dev Where the arguments start in the clone's code: 45 for the standard EIP-1167 runtime.
    function _argsBase() internal pure virtual returns (uint256) {
        return BoxClones.ARGS_OFFSET;
    }

    /// @dev The 20-byte address at argument offset `offset`.
    function _argAddress(uint256 offset) internal view returns (address a) {
        uint256 at = _argsBase() + offset;
        assembly ("memory-safe") {
            extcodecopy(address(), 0x00, at, 20)
            a := shr(96, mload(0x00))
        }
    }

    /// @dev The 32-byte word at argument offset `offset`.
    function _argWord(uint256 offset) internal view returns (bytes32 w) {
        uint256 at = _argsBase() + offset;
        assembly ("memory-safe") {
            extcodecopy(address(), 0x00, at, 32)
            w := mload(0x00)
        }
    }

    /// @dev The big-endian unsigned integer of `size` bytes (1 to 32) at argument offset `offset`.
    function _argUint(uint256 offset, uint256 size) internal view returns (uint256 v) {
        uint256 at = _argsBase() + offset;
        assembly ("memory-safe") {
            mstore(0x00, 0)
            extcodecopy(address(), 0x00, at, size)
            v := shr(sub(256, shl(3, size)), mload(0x00))
        }
    }

    /// @dev `length` bytes of the arguments from offset `offset`, copied into new memory.
    function _argBytes(uint256 offset, uint256 length) internal view returns (bytes memory out) {
        uint256 at = _argsBase() + offset;
        out = new bytes(length);
        assembly ("memory-safe") {
            extcodecopy(address(), add(out, 0x20), at, length)
        }
    }
}
