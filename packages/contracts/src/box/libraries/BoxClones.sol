// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title BoxClones
/// @notice Fixed minimal clones with immutable arguments, the per-box contract kind (F61 A1; launch pipeline v1 § 2
/// "Clone kind"; SH-S0-spikes § 2): a clone's runtime is a proxy that DELEGATECALLs one implementation, written into
/// its code for good, followed by `abi.encodePacked` arguments, which the proxy never executes. The implementation
/// reads them with `EXTCODECOPY(address(), argsOffset + offset, length)` (in a DELEGATECALL frame `address()` is the
/// clone; CODECOPY would read the implementation). No admin, no upgrade, no storage slot for the target. For the
/// factory (S7), the coordinator's `deploy` (S6) and the tests.
///
/// Two runtimes:
/// - **Standard** (`runtime`, `initCode`): the 45-byte EIP-1167 runtime, arguments from byte 45. The layout of the S0
///   spike (test/spikes/S0Clones.sol:7-33), OpenZeppelin's `cloneDeterministicWithImmutableArgs` and Solady's `LibClone`.
/// - **Receiving** (`receivingRuntime`, `initCodeReceiving`), for the royalty router only (BC-114): a plain EIP-1167
///   proxy cannot accept a marketplace's 2,300-gas `transfer`, because its DELEGATECALL to a cold implementation costs
///   2,600 gas (3,000 after Glamsterdam, EIP-8038) before any code runs. Six bytes in front of the proxy stop a call
///   with empty calldata at once (`CALLDATASIZE PUSH1 0x05 JUMPI STOP JUMPDEST`, about 15 gas), so a plain ETH payment
///   is accepted without delegating, writing or logging anything; every call with calldata delegates exactly as
///   EIP-1167 does (its internal jump target moved from 0x2b to 0x31). Arguments from byte 51. Solady's earlier
///   clone-with-immutable-arguments runtime did the same for the same reason.
/// @dev Integration (SH-core-wave-2): slices S3 and S4+S5 each wrote this library; this file is their union (S3's
/// `initCode(implementation, args)`, `create`, `create2`, `predict`; S4+S5's `initCode(runtime)` and the receiving
/// variant's names, which S3's "receive-first" names now follow). Written for Square Hole (MIT).
library BoxClones {
    /// @notice A runtime longer than EIP-170 allows (24,576 bytes); `length` is the runtime's length.
    error ArgsTooLong(uint256 length);
    error DeployFailed();

    /// @dev EIP-1167 runtime around the 20-byte implementation address (S0Clones.sol:12-13).
    bytes10 internal constant PROXY_HEAD = 0x363d3d373d3d3d363d73;
    bytes15 internal constant PROXY_TAIL = 0x5af43d82803e903d91602b57fd5bf3;
    /// @dev The receiving variant: the 6-byte prefix, then the proxy with its success jump at 0x31 (0x2b + 6).
    bytes6 internal constant RECEIVE_PREFIX = 0x36600557005b;
    bytes15 internal constant RECEIVING_PROXY_TAIL = 0x5af43d82803e903d91603157fd5bf3;
    /// @dev Where the arguments start in each runtime.
    uint256 internal constant ARGS_OFFSET = 45;
    uint256 internal constant RECEIVING_ARGS_OFFSET = 51;
    /// @dev EIP-170.
    uint256 private constant _MAX_RUNTIME = 24_576;

    /// @notice The standard clone's runtime (what `address.code` reads): the 45-byte proxy, then the arguments.
    function runtime(address implementation, bytes memory args) internal pure returns (bytes memory) {
        return abi.encodePacked(PROXY_HEAD, implementation, PROXY_TAIL, args);
    }

    /// @notice The receiving clone's runtime (royalty router): the 6-byte prefix, the proxy, then the arguments.
    function receivingRuntime(address implementation, bytes memory args) internal pure returns (bytes memory) {
        return abi.encodePacked(RECEIVE_PREFIX, PROXY_HEAD, implementation, RECEIVING_PROXY_TAIL, args);
    }

    /// @notice Creation code that returns `runtime_`: a 10-byte constructor (`PUSH2 len RETURNDATASIZE DUP2 PUSH1 0x0a
    /// RETURNDATASIZE CODECOPY RETURN`), then the runtime (S0Clones.initCode, S0Clones.sol:20-29).
    function initCode(bytes memory runtime_) internal pure returns (bytes memory) {
        if (runtime_.length > _MAX_RUNTIME) revert ArgsTooLong(runtime_.length);
        // casting to 'uint16' is safe because the length was checked above
        // forge-lint: disable-next-line(unsafe-typecast)
        return abi.encodePacked(hex"61", uint16(runtime_.length), hex"3d81600a3d39f3", runtime_);
    }

    /// @notice Creation code of a standard clone of `implementation` carrying `args`.
    function initCode(address implementation, bytes memory args) internal pure returns (bytes memory) {
        return initCode(runtime(implementation, args));
    }

    /// @notice Creation code of a receiving clone of `implementation` carrying `args` (the royalty router).
    function initCodeReceiving(address implementation, bytes memory args) internal pure returns (bytes memory) {
        return initCode(receivingRuntime(implementation, args));
    }

    /// @notice CREATEs `code` (the box's coordinator deploys its contracts by nonce, SH-S0-spikes § 2.2).
    function create(bytes memory code) internal returns (address a) {
        assembly ("memory-safe") {
            a := create(0, add(code, 0x20), mload(code))
        }
        if (a == address(0)) revert DeployFailed();
    }

    /// @notice CREATE2s `code` with `salt` (the hook clone at its mined address; S0Clones.sol:66-71).
    function create2(bytes memory code, bytes32 salt) internal returns (address a) {
        assembly ("memory-safe") {
            a := create2(0, add(code, 0x20), mload(code), salt)
        }
        if (a == address(0)) revert DeployFailed();
    }

    /// @notice Whether `account`'s code begins with the standard clone proxy of `implementation` (its first 45 bytes are
    /// PROXY_HEAD ‖ implementation ‖ PROXY_TAIL): a clone of that code, whatever its arguments. An account without code,
    /// or still in its constructor, reads as zero bytes and is never a clone. Every box implementation's `initialize()`
    /// asks this of its caller with the version's coordinator implementation (review of sh-core-v1; SH-S0-spikes
    /// decision 7; BC-100): only the factory can drive that code (`deploy`, `launch`), so a stranger's clone of any box
    /// implementation can never be initialised. One EXTCODECOPY of the (warm) caller, at initialisation only.
    function isCloneOf(address account, address implementation) internal view returns (bool yes) {
        assembly ("memory-safe") {
            // The 45 bytes into scratch space: word 0 = PROXY_HEAD ‖ implementation ‖ the tail's first 2 bytes (5af4),
            // word 1 starts with the tail's other 13 bytes.
            extcodecopy(account, 0x00, 0, 45)
            let head :=
                or(
                    shl(176, 0x363d3d373d3d3d363d73),
                    shl(16, and(implementation, 0xffffffffffffffffffffffffffffffffffffffff))
                )
            yes := and(eq(mload(0x00), or(head, 0x5af4)), eq(shr(152, mload(0x20)), 0x3d82803e903d91602b57fd5bf3))
        }
    }

    /// @notice Whether `account`'s code begins with the receiving runtime of `implementation` (its first 51 bytes are
    /// RECEIVE_PREFIX ‖ PROXY_HEAD ‖ implementation ‖ RECEIVING_PROXY_TAIL): a royalty router clone of that code, whatever
    /// its arguments. As `isCloneOf`, an account without code is never one. For factory v1's re-reads (review of the
    /// Misfits line): one EXTCODECOPY at creation only.
    function isReceivingCloneOf(address account, address implementation) internal view returns (bool yes) {
        assembly ("memory-safe") {
            // The 51 bytes into scratch space: word 0 = RECEIVE_PREFIX ‖ PROXY_HEAD ‖ the implementation's first 16
            // bytes, word 1 starts with its last 4 bytes and the 15-byte tail.
            extcodecopy(account, 0x00, 0, 51)
            let impl := and(implementation, 0xffffffffffffffffffffffffffffffffffffffff)
            yes := and(
                eq(mload(0x00), or(shl(128, 0x36600557005b363d3d373d3d3d363d73), shr(32, impl))),
                eq(shr(104, mload(0x20)), or(shl(120, and(impl, 0xffffffff)), 0x5af43d82803e903d91603157fd5bf3))
            )
        }
    }

    /// @notice The CREATE2 address of `initCodeHash` deployed by `deployer` with `salt` (EIP-1014; S0Clones.sol:33-43).
    function predict(address deployer, bytes32 salt, bytes32 initCodeHash) internal pure returns (address a) {
        assembly ("memory-safe") {
            let p := mload(0x40)
            mstore(add(p, 0x40), initCodeHash)
            mstore(add(p, 0x20), salt)
            mstore(p, deployer)
            mstore8(add(p, 0x0b), 0xff)
            a := and(keccak256(add(p, 0x0b), 85), 0xffffffffffffffffffffffffffffffffffffffff)
        }
    }
}
