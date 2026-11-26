// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {M132aBase} from "../m1-32a/M132aBase.sol";
import {BoxSpec, ReleaseContext} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {IBoxFactoryV2} from "../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";
import {BoxSpecV2} from "../../../src/box-v2/BoxSpecV2.sol";
import {SetSpecV2} from "../../../src/box-v2/set/SetTypesV2.sol";
import {SetConstantsV2 as C} from "../../../src/box-v2/set/SetConstantsV2.sol";
import {SetFactoryV2Planner} from "../../../src/box-v2/set/SetFactoryV2Planner.sol";
import {ISetFactory} from "./SetReleaseFixture.sol";

/// The actual old release remains unable to admit EXISTING or to accept the new creation ABI.
contract SetReleaseBoundaryTest is M132aBase {
    function test_E06_oldValidatorPlannerFactoryStayClosed() public {
        SetFactoryV2Planner setPlanner = SetFactoryV2Planner(
            deployCode(
                "SetFactoryV2Planner.sol:SetFactoryV2Planner",
                abi.encode(deployCode("SetSpecV2Validator.sol:SetSpecV2Validator"), address(planner.parts()))
            )
        );
        SetSpecV2 memory s;
        s.format = C.FORMAT;
        s.schema = C.SCHEMA;
        s.release = C.RELEASE;
        s.tokenName = "Set";
        s.tokenSymbol = "SET";
        s.raise = listings.listing(0).raise;
        s.count = 10;
        s.setHash = keccak256("set");
        s.pickFeeBps = 500;
        s.deadlineDays = 30;
        s.collection = address(0x721);
        s.logoSha256 = keccak256("logo");
        BoxSpec memory projected = setPlanner.project(s);
        ReleaseContext memory ctx = planner.context(release, projected);
        (uint16 reason, uint16 field) = planner.validator().validate(projected, ctx);
        assertEq(reason, BoxSpecV2.REASON_NOT_OFFERED);
        assertEq(field, BoxSpecV2.FIELD_BOX_TYPE);
        bytes memory refused = abi.encodeWithSelector(IBoxFactoryV2.InvalidSpec.selector, reason, field);
        assertEq(factory.refusal(projected, CREATOR), refused);
        vm.expectRevert(refused);
        factory.predictBox(CREATOR, projected, 0);
        vm.expectRevert(refused);
        factory.createBox(projected, 0, 0);
        (bool accepted,) = address(factory).call(abi.encodeCall(ISetFactory.createBox, (s, bytes32(0), bytes32(0))));
        assertFalse(accepted, "new ABI cannot enter old factory");
        assertEq(registry.boxCount(), 0);
    }
}
