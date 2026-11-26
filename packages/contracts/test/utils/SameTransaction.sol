// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

/// @notice Runs a list of pranked calls inside ONE external call, so they share one transaction's EIP-1153
/// transient storage. Foundry clears transient storage between top-level test calls (and between invariant
/// calls), so a test that needs "take, swap, settle in one transaction" must go through this runner.
/// Models Uniswap v4 flash accounting at the level the ledger sees it: `PoolManager.take` is a T transfer from
/// the pool manager, `settle` a T transfer back to it, and a fee-bearing swap's `afterSwap` a
/// `collector.receiveFees` call from the fee source. Test-only.
contract SameTransaction is Test {
    struct Call {
        address from; // pranked msg.sender; zero = the runner itself
        address target;
        bytes data;
    }

    /// @notice Executes `calls` in order in this transaction; any failing call reverts the whole run with its
    /// own revert data.
    function run(Call[] calldata calls) external {
        for (uint256 i; i < calls.length; ++i) {
            if (calls[i].from != address(0)) vm.prank(calls[i].from);
            (bool ok, bytes memory ret) = calls[i].target.call(calls[i].data);
            if (!ok) {
                assembly ("memory-safe") {
                    revert(add(ret, 0x20), mload(ret))
                }
            }
        }
    }

    /// @notice An in-transaction assertion step: `view` must return `expected` at this point of the run.
    function expectUint(address target, bytes calldata viewCall, uint256 expected, string calldata label)
        external
        view
    {
        (bool ok, bytes memory ret) = target.staticcall(viewCall);
        require(ok, "view reverted");
        assertEq(abi.decode(ret, (uint256)), expected, label);
    }
}
