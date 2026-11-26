// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {ReferenceChecks} from "./ReferenceChecks.sol";

/// @notice SIZE-C2: full return/revert bytes match the pinned arithmetic, including invalid raises.
contract FactoryMovedResultsTest is Test {
    address internal referenceChecks;
    address internal curveChecks;

    function setUp() public {
        referenceChecks = address(new ReferenceChecks());
        curveChecks = deployCode("FactoryChecksCurve.sol:FactoryChecksCurve");
    }

    function test_curveBoundaries() public view {
        uint256[12] memory raises = [uint256(0), 1, 999_999, 1_000_000, 43_368_085, 43_368_086,
            43_368_087, 1e8, 1e18, 4_206_980_085_000_000_000, type(uint128).max, type(uint256).max];
        for (uint256 i; i < raises.length; ++i) _compare(raises[i]);
    }

    function testFuzz_admittedRaiseRange(uint128 raise) public view {
        _compare(bound(uint256(raise), 1_000_000, type(uint128).max));
    }

    function testFuzz_fullWidthRaises(uint256 raise) public view {
        _compare(raise);
    }

    function _compare(uint256 raise) private view {
        bytes memory input = abi.encodeWithSignature("curve(uint256)", raise);
        (bool oldOK, bytes memory oldResult) = referenceChecks.staticcall(input);
        (bool newOK, bytes memory newResult) = curveChecks.staticcall(input);
        assertEq(newOK, oldOK, "success/refusal changed");
        assertEq(newResult, oldResult, "return/revert bytes changed");
    }
}
