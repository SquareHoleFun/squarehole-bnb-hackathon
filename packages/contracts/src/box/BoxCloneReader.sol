// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxBuildGuard} from "sh-box-build/BoxBuildV1.sol";

/// @title BoxCloneReader
/// @notice Reads the immutable arguments of a fixed minimal clone (F61 A1; launch pipeline v1 § 2 "Clone kind"): an
/// EIP-1167 proxy (45 bytes of runtime) followed by `abi.encodePacked` arguments that the proxy never executes. In the
/// implementation's DELEGATECALL frame `address()` is the clone, so `EXTCODECOPY(address(), 45 + offset, length)`
/// reads the clone's own arguments (copied from the S0 spike, test/spikes/SpikeBoxHook.sol:682-704, and
/// test/spikes/S0Clones.sol:7-17). Each read copies only the bytes it needs into scratch memory (0x00-0x3f), so a
/// read costs a warm EXTCODECOPY (100 gas plus 3 a word) and allocates nothing.
/// @dev Called on the implementation itself (not through a clone) these read the implementation's own code bytes,
/// which are not arguments; every implementation therefore refuses use before `initialize` (S0 decision 9), and
/// `initialize` checks `msg.sender` against the `coordinator` argument, an address nobody controls on the
/// implementation, and that it is a clone of the version's coordinator implementation (BC-100).
/// Integration (SH-core-wave-2): written by S4+S5 as `libraries/BoxCloneArgs.sol`; renamed and moved here because S3's
/// `libraries/BoxCloneArgs.sol` (the argument layouts and encoders) took that name. The reader's code is unchanged (the
/// review of sh-core-v1 later changed the hook, launch router and receiver themselves, re-measured in SH-core-wave-2
/// § Review). S3's clones read
/// through `BoxCloneBase` (a virtual arguments offset for the receiving variant); folding the two is a follow-up.
/// BoxBuildGuard (F78): empty in the mainnet build; in the rehearsal build every implementation's constructor refuses
/// chain id 1.
abstract contract BoxCloneReader is BoxBuildGuard {
    /// @dev Length of the EIP-1167 runtime; the arguments start at this code offset.
    uint256 internal constant _ARGS_START = 45;

    /// @dev The 20-byte address at argument offset `offset`.
    function _argAddress(uint256 offset) internal view returns (address a) {
        assembly ("memory-safe") {
            extcodecopy(address(), 0, add(_ARGS_START, offset), 20)
            a := shr(96, mload(0))
        }
    }

    /// @dev Two adjacent addresses at `offset` (one copy).
    function _argAddress2(uint256 offset) internal view returns (address a, address b) {
        assembly ("memory-safe") {
            extcodecopy(address(), 0, add(_ARGS_START, offset), 40)
            a := shr(96, mload(0))
            b := shr(96, mload(20))
        }
    }

    /// @dev The big-endian unsigned integer of `bytesLength` (1-32) bytes at `offset`.
    function _argUint(uint256 offset, uint256 bytesLength) internal view returns (uint256 v) {
        assembly ("memory-safe") {
            extcodecopy(address(), 0, add(_ARGS_START, offset), bytesLength)
            v := shr(sub(256, mul(8, bytesLength)), mload(0))
        }
    }

    /// @dev The byte at `offset`.
    function _argUint8(uint256 offset) internal view returns (uint8 v) {
        assembly ("memory-safe") {
            extcodecopy(address(), 0, add(_ARGS_START, offset), 1)
            v := shr(248, mload(0))
        }
    }

    /// @dev The 16-byte unsigned integer at `offset`.
    function _argUint128(uint256 offset) internal view returns (uint128 v) {
        assembly ("memory-safe") {
            extcodecopy(address(), 0, add(_ARGS_START, offset), 16)
            v := shr(128, mload(0))
        }
    }

    /// @dev The 20-byte unsigned integer at `offset` (a √price).
    function _argUint160(uint256 offset) internal view returns (uint160 v) {
        assembly ("memory-safe") {
            extcodecopy(address(), 0, add(_ARGS_START, offset), 20)
            v := shr(96, mload(0))
        }
    }

    /// @dev The signed 24-bit integer at `offset` (3 bytes, two's complement).
    function _argInt24(uint256 offset) internal view returns (int24 v) {
        assembly ("memory-safe") {
            extcodecopy(address(), 0, add(_ARGS_START, offset), 3)
            v := signextend(2, shr(232, mload(0)))
        }
    }
}
