// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

contract ThreeFreshSlots {
    uint256[3] private slots;

    function write() external {
        slots = [uint256(1), 2, 3];
    }
}

/// Control for interpreting the matrix: a 300k CALL cannot itself exclude an inherited reservoir.
contract CollectionReservoirTest is Test {
    ThreeFreshSlots private target;
    bool private amsterdam;
    bool private reservoir;

    function setUp() public {
        target = new ThreeFreshSlots();
        amsterdam = keccak256(bytes(vm.getEvmVersion())) == keccak256("amsterdam");
        reservoir = vm.envOr("SH_RESERVOIR", false);
    }

    function test_threeNewSlots() public {
        _measure(false);
    }

    function test_threeNewSlotsCooled() public {
        vm.cool(address(target));
        _measure(true);
    }

    function _measure(bool cooled) private {
        (bool ok,) = address(target).call{gas: 300_000}(abi.encodeCall(target.write, ()));
        (bool read, bytes memory raw) = address(vm).staticcall(abi.encodeWithSignature("lastFrameGas()"));
        assertTrue(read);
        (,,,,, uint64 stateGas) = abi.decode(raw, (uint64, uint64, uint64, int64, uint64, uint64));
        assertEq(ok, !amsterdam || (reservoir && !cooled));
        if (reservoir && !cooled) assertGt(stateGas, 0);
        emit log_named_uint("three slots success", ok ? 1 : 0);
        emit log_named_uint("state gas", stateGas);
    }
}
