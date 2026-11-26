// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {BoxSpec} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {SetSpecV2} from "../../../src/box-v2/set/SetTypesV2.sol";
import {SetConstantsV2 as C} from "../../../src/box-v2/set/SetConstantsV2.sol";

interface ISetProjection {
    function project(SetSpecV2 calldata spec) external pure returns (BoxSpec memory);
}

contract SetReleaseTest is Test {
    function test_E06_plannerRefusesSubstituteValidatorOrEncoder() public {
        address validator = deployCode("SetSpecV2Validator.sol:SetSpecV2Validator");
        address parts = deployCode("BoxFactoryV2Parts.sol:BoxFactoryV2Parts");
        vm.expectRevert(bytes4(keccak256("WrongPlannerCode()")));
        deployCode("SetFactoryV2Planner.sol:SetFactoryV2Planner", abi.encode(parts, parts));
        vm.expectRevert(bytes4(keccak256("WrongPlannerCode()")));
        deployCode("SetFactoryV2Planner.sol:SetFactoryV2Planner", abi.encode(validator, validator));
    }

    function test_E06_projectOnlyGrowAndCommittedLoader() public {
        address validator = deployCode("SetSpecV2Validator.sol:SetSpecV2Validator");
        address parts = deployCode("BoxFactoryV2Parts.sol:BoxFactoryV2Parts");
        address planner = deployCode("SetFactoryV2Planner.sol:SetFactoryV2Planner", abi.encode(validator, parts));
        SetSpecV2 memory s;
        s.format = C.FORMAT;
        s.schema = C.SCHEMA;
        s.release = C.RELEASE;
        s.count = 33;
        s.setHash = keccak256("ordered sparse ids");
        BoxSpec memory projected = ISetProjection(planner).project(s);
        assertEq(projected.boxType, 2); // EXISTING, never SHOP.
        assertEq(projected.buyers.a.leg, 1);
        assertEq(projected.buyers.a.dest, 4);
        assertEq(projected.buyers.split, 1);
        assertEq(abi.encode(projected.buyers), abi.encode(projected.sellers));
        assertEq(projected.addOns.length, 1);
        assertEq(projected.addOns[0].id, 8);
        assertEq(projected.addOns[0].params, abi.encode(s.setHash, s.count));
        assertEq(projected.contentsParams.length, 0);
        assertEq(projected.metadataTable.length, 0);
    }
}
