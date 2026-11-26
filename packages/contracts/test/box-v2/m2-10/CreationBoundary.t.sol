// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {M132aBase} from "../m1-32a/M132aBase.sol";
import {BoxFactoryV2} from "../../../src/box-v2/BoxFactoryV2.sol";
import {BoxFactoryV2Planner} from "../../../src/box-v2/BoxFactoryV2Planner.sol";
import {BoxSpec} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {Branch} from "../../../src/box-v2/interfaces/RecipeTypes.sol";

/// @dev Real production release, planner and factory; no permissive validator or invented ledger wiring.
contract M210CreationBoundaryTest is M132aBase {
    function test_M210C_plannerRefusesMissingLedgerTokenBeforeFactoryPayment() public {
        assertEq(factory.implementation(17), address(0));
        assertEq(factory.implementation(20), address(0));
        for (uint256 sides = 1; sides <= 3; ++sides) {
            BoxSpec memory s = _spec();
            if (sides & 1 != 0) s.buyers.a = Branch(1, 6, "", abi.encode(uint8(1)));
            if (sides & 2 != 0) s.sellers.a = Branch(1, 6, "", abi.encode(uint8(1)));
            // M2-10 admits the recipe. The read-only seam even predicts its role-17 address.
            assertEq(planner.refusal(release, s).length, 0);
            (address predicted,,) = factory.predictBox(CREATOR, s, bytes32(0));
            uint256 payment = factory.boxQParameters(0, s.raise).bootstrapQ;
            uint256 creatorBefore = CREATOR.balance;
            uint256 managerBefore = address(pm).balance;
            uint256 countBefore = registry.boxCount();
            vm.expectRevert(abi.encodeWithSelector(BoxFactoryV2Planner.NoCode.selector, address(0)));
            vm.prank(CREATOR);
            factory.createBox{value: payment}(s, bytes32(0), bytes32(0));
            assertEq(CREATOR.balance, creatorBefore, "creation payment returned");
            assertEq(address(factory).balance, 0);
            assertEq(address(pm).balance, managerBefore);
            assertEq(registry.boxCount(), countBefore);
            assertEq(predicted.code.length, 0);
        }
    }

    function test_M210C_factoryRejectsUnadmittedM2ImplementationSlots() public {
        address checks = address(factory.checks());
        for (uint256 i; i < 2; ++i) {
            uint256 slot = i == 0 ? 17 : 20;
            release.implementations[slot] = release.implementations[1];
            vm.expectRevert(BoxFactoryV2.BadPreviewRelease.selector);
            new BoxFactoryV2(release, address(planner), checks);
            release.implementations[slot] = address(0);
        }
    }
}
