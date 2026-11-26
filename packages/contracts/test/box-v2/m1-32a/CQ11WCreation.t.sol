// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {M132aBase} from "./M132aBase.sol";
import {BoxCoordinatorV2} from "../../../src/box-v2/BoxCoordinatorV2.sol";
import {BoxTokenV2} from "../../../src/box-v2/BoxTokenV2.sol";
import {IBoxHookV2} from "../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {BoxSpec} from "../../../src/box-v2/interfaces/SpecTypes.sol";

contract CQ11WCreationTest is M132aBase {
    function test_createBoxUsesRealPartsAndRecordsCreationSnapshot() public {
        BoxSpec memory s = _spec();
        BoxCoordinatorV2 c = _create(s);
        assertEq(registry.boxCount(), 1);
        assertEq(registry.coordinatorOf(0), address(c));
        assertEq(c.raise(), s.raise);
        assertEq(c.creator(), CREATOR);
        assertEq(c.specHash(), keccak256(abi.encode(s)));
        assertTrue(c.gateOpen());
        assertGt(BoxTokenV2(c.token()).totalSupply(), 0);
        assertEq(IBoxHookV2(c.hook()).POOL_FEE(), 10_000);
        assertEq(c.roleAddress(11), address(0));
        assertEq(c.roleAddress(13), address(0));
        assertEq(address(factory).balance, 0);
        listings.updateRaise(0, 8 ether);
        assertEq(c.raise(), s.raise);
        assertEq(registry.recordOf(0).raise, s.raise);
    }

    function test_validSpecHasNoRefusalAfterRealWiring() public view {
        assertEq(factory.refusal(_spec(), CREATOR).length, 0);
    }
}
