// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {console} from "forge-std/console.sol";

contract Trivial {
    uint256 public x;

    function noop() external {}

    function noopWithData(bytes calldata) external {}
}

/// @notice RESEARCH ONLY: what `vm.lastFrameGas().gasTotalUsed` counts for a call from the test contract (and for a
/// call made inside another frame), so the hook-gas tables label it right.
contract FrameGasProbe is Test {
    error Used(uint256 gasUsed);

    function test_frameGasOfATopLevelCall() public {
        if (!vm.envOr("SH_RESEARCH_HOOKGAS", false)) vm.skip(true);
        Trivial t = new Trivial();
        t.noop();
        Vm.Gas memory g = vm.lastFrameGas();
        console.log("HF|top-level noop() gasTotalUsed", g.gasTotalUsed);
        bytes memory data = new bytes(1000);
        t.noopWithData(data);
        console.log("HF|top-level noopWithData(1000 zero bytes) gasTotalUsed", vm.lastFrameGas().gasTotalUsed);
        try this.inner(t) {}
        catch (bytes memory r) {
            uint256 used;
            assembly ("memory-safe") {
                used := mload(add(r, 36))
            }
            console.log("HF|nested noop() gasTotalUsed (inside another call)", used);
        }
    }

    function inner(Trivial t) external {
        t.noop();
        revert Used(vm.lastFrameGas().gasTotalUsed);
    }
}
