// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {M132aBase} from "./M132aBase.sol";
import {BoxSpec, AddOn} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {IBoxFactoryV2} from "../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";

contract M132aSpecTest is M132aBase {
    function _sameRefusal(BoxSpec memory s) internal {
        bytes memory reason = factory.refusal(s, CREATOR);
        assertGt(reason.length, 0);
        vm.expectRevert(reason);
        vm.prank(CREATOR);
        factory.createBox(s, 0, 0);
        assertEq(registry.boxCount(), 0);
    }

    function test_badFormatAndRetiredRecipeRefuseBeforePayment() public {
        BoxSpec memory s = _spec();
        s.format = 1;
        _sameRefusal(s);
        s = _spec();
        s.sellers.a.dest = 3;
        _sameRefusal(s);
        s = _spec();
        s.gradLayout = 1;
        _sameRefusal(s);
    }

    function test_addOnTenAndSplitAndRuleAreRefused() public {
        BoxSpec memory s = _collectionSpec();
        s.addOns = new AddOn[](1);
        s.addOns[0] = AddOn(10, abi.encode(uint8(1)));
        _sameRefusal(s);
        s = _spec();
        s.buyers.split = 2;
        _sameRefusal(s);
        s = _spec();
        s.buyers.a.legParams = hex"1234";
        _sameRefusal(s);
    }

    function test_openAheadLimit() public {
        vm.warp(1_800_000_000);
        BoxSpec memory s = _spec();
        s.openAt = uint32(block.timestamp + 14 days + 1);
        bytes memory reason = factory.refusal(s, CREATOR);
        assertEq(bytes4(reason), IBoxFactoryV2.OpenAtTooFar.selector);
        _sameRefusal(s);
    }

    function test_releaseViewsAndSizes() public view {
        assertEq(factory.registry(), address(registry));
        assertEq(factory.listingRegistry(), address(listings));
        assertEq(factory.poolManager(), address(pm));
        assertEq(factory.weth(), release.weth);
        assertEq(factory.randomness(), release.randomness);
        assertNotEq(factory.versionCodeHash(), bytes32(0));
        assertLe(address(factory).code.length, 22_118);
        assertLe(address(factory.checks()).code.length, 22_118);
        assertLe(address(planner).code.length, 22_118);
        assertLe(address(planner.parts()).code.length, 22_118);
        for (uint256 i; i < 9; ++i) {
            assertLe(factory.implementation(i).code.length, 22_118);
        }
    }
}
