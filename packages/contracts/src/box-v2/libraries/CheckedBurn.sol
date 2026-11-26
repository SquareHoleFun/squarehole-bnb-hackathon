// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Internal listing/receiver checks. Receiver callers enclose every token call in a capped revertible frame.
library CheckedBurn {
    bytes4 internal constant SELECTOR = bytes4(keccak256("burn(uint256)"));
    error BurnRefused();

    /// @notice Internal callers read exactly one supply word; malformed or reverting reads refuse.
    function totalSupply(address token) internal view returns (uint256) {
        return _word(token, 0x18160ddd, 0, 4);
    }

    /// @notice Internal callers read exactly one balance word; no funds move.
    function balanceOf(address token, address account) internal view returns (uint256) {
        return _word(token, 0x70a08231, uint160(account), 36);
    }

    function _word(address token, uint32 selector, uint256 argument, uint256 length) private view returns (uint256 value) {
        bool ok;
        // Fixed scratch calldata and a bounded one-word result avoid dynamic return-data allocation.
        assembly ("memory-safe") {
            mstore(0, shl(224, selector))
            mstore(4, argument)
            ok := staticcall(gas(), token, 0, length, 0, 32)
            ok := and(ok, eq(returndatasize(), 32))
            value := mload(0)
        }
        if (!ok) revert BurnRefused();
    }

    /// @notice Internal receiver/listing only; call the sole supported burn selector and require exact supply/own-balance reductions.
    /// A revert restores the entire enclosing probe/unlock, including a preceding redemption.
    function burn(address token, uint256 amount) internal returns (uint256 supply) {
        supply = totalSupply(token);
        uint256 balance = balanceOf(token, address(this));
        bool ok;
        assembly ("memory-safe") {
            mstore(0, shl(224, 0x42966c68))
            mstore(4, amount)
            ok := call(gas(), token, 0, 0, 36, 0, 0)
        }
        if (!ok || supply < amount || balance < amount
            || totalSupply(token) != supply - amount
            || balanceOf(token, address(this)) != balance - amount) revert BurnRefused();
    }
}
