// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title S0Clones
/// @notice SPIKE ONLY (S0, docs/evidence/SH-S0-spikes.md; never deployed): fixed minimal clones with immutable
/// arguments, the clone kind of launch-pipeline-v1 § 2 ("EIP-1167 code plus arguments", the layout OpenZeppelin's
/// `Clones.cloneDeterministicWithImmutableArgs` and Solady's `LibClone` use). A clone's runtime is the 45-byte EIP-1167
/// proxy followed by its arguments, which the proxy never executes; the implementation reads them with
/// `EXTCODECOPY(address(), 45 + offset, length)` (in a DELEGATECALL frame `address()` is the clone). The target is
/// written into the clone's code and can never change: no admin, no upgrade.
library S0Clones {
    /// @dev EIP-1167 runtime around the 20-byte implementation address.
    bytes10 internal constant PROXY_HEAD = 0x363d3d373d3d3d363d73;
    bytes15 internal constant PROXY_TAIL = 0x5af43d82803e903d91602b57fd5bf3;
    /// @dev Length of the EIP-1167 runtime; the arguments start at this code offset.
    uint256 internal constant ARGS_OFFSET = 45;
    /// @dev Low 14 address bits that carry a v4 hook's permissions (`Hooks.ALL_HOOK_MASK`).
    uint160 internal constant ALL_HOOK_MASK = (1 << 14) - 1;

    error ArgsTooLong(uint256 length);
    error DeployFailed();

    /// @notice Creation code of a clone of `implementation` carrying `args`: a 10-byte constructor that returns the
    /// runtime (`PUSH2 len RETURNDATASIZE DUP2 PUSH1 0x0a RETURNDATASIZE CODECOPY RETURN`), then the runtime.
    function initCode(address implementation, bytes memory cloneArgs) internal pure returns (bytes memory) {
        uint256 runtimeLength = ARGS_OFFSET + cloneArgs.length;
        if (runtimeLength > 0xffff) revert ArgsTooLong(cloneArgs.length);
        return abi.encodePacked(
            hex"61", uint16(runtimeLength), hex"3d81600a3d39f3", PROXY_HEAD, implementation, PROXY_TAIL, cloneArgs
        );
    }

    /// @notice The CREATE2 address of `initCodeHash` deployed by `deployer` with `salt` (EIP-1014). Hashes in scratch
    /// memory past the free pointer, allocating nothing (a mining loop calls it thousands of times).
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

    /// @notice Mines a salt, from `start` upward, whose CREATE2 address carries exactly `flags` in its low 14 bits
    /// and does not start with 0x91 (Uniswap's review trigger; FitPoolHook refuses it too). Off-chain work in
    /// production (the creation page, ≈ 16,384 tries on average); here a pure loop so a test can reproduce it.
    function mineHookSalt(address deployer, bytes32 initCodeHash, uint160 flags, uint256 start, uint256 maxTries)
        internal
        pure
        returns (bytes32 salt, address hook, uint256 tries)
    {
        for (uint256 i; i < maxTries; ++i) {
            salt = bytes32(start + i);
            hook = predict(deployer, salt, initCodeHash);
            if (uint160(hook) & ALL_HOOK_MASK == flags && uint160(hook) >> 152 != 0x91) return (salt, hook, i + 1);
        }
        revert DeployFailed();
    }

    /// @notice CREATE2-deploys `code` with `salt` (reverts on a collision or a failing constructor).
    function deploy(bytes memory code, bytes32 salt, uint256 value) internal returns (address a) {
        assembly ("memory-safe") {
            a := create2(value, add(code, 0x20), mload(code), salt)
        }
        if (a == address(0)) revert DeployFailed();
    }
}
