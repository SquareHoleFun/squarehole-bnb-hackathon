// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @dev Unit-test delegate proxy, not evidence of any deployed Safe release or signature enforcement.
contract SafeProxyFixture {
    address internal singleton;

    constructor(address implementation) {
        singleton = implementation;
    }

    fallback() external payable {
        assembly ("memory-safe") {
            let target := and(sload(0), 0xffffffffffffffffffffffffffffffffffffffff)
            if eq(calldataload(0), shl(224, 0xa619486e)) {
                mstore(0, target)
                return(0, 32)
            }
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), target, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            if iszero(ok) { revert(0, returndatasize()) }
            return(0, returndatasize())
        }
    }
}
