// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {BoxSpecV2Validator} from "../../../src/box-v2/BoxSpecV2Validator.sol";
import {BoxSpec, ReleaseContext} from "../../../src/box-v2/interfaces/SpecTypes.sol";
contract BoxSpecV2ProbeTest is Test {
    function test_M110b_calldataPathAgreesAndFitsTheValidatorGate() public {
        BoxSpecV2Validator v = new BoxSpecV2Validator();
        assertLe(address(v).code.length, 22_118);
        BoxSpec memory s; ReleaseContext memory ctx;
        (uint16 reason, uint16 field) = v.validate(s, ctx);
        assertEq(reason, 1); assertEq(field, 0);
    }
}
