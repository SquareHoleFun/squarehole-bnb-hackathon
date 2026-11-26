// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {M340Base} from "../../m3-40/Fixture.sol";
import {M3SpecTest} from "../../m3-10/M3Spec.t.sol";

contract RulesRemovedSpecTest is M3SpecTest {}

contract RulesRemovedDispatchTest is M340Base {
    function test_P08_removedSelectorsCannotRunInEitherM3FamilyBeforeOrAfterFailure() public {
        for (uint256 family; family < 2; ++family) {
            _start(family == 0 ? _items(1, 2) : _pile(address(0), 0));
            _buy(box.raise() / 10);
            receiver.collect(address(0));
            _refuseRemoved();
            vm.warp(box.deadline());
            box.fail();
            _refuseRemoved();
        }
    }

    function _refuseRemoved() private {
        string[16] memory signatures = [string("claimFor(uint256,address)"), "claimFor(uint256[])",
            "settleCap()", "claimTip(address)", "redeemHeldT()", "enterClosing()", "priceAverage()",
            "convert(address,uint256)", "gift(address,uint256)", "setRule(address)", "setTarget(address)",
            "setLeg(address)", "pair(uint256,uint256)", "unpair(uint256)", "fundBudget(uint256)",
            "eligibleHolder(address)"];
        uint256[8] memory roles = [uint256(0), 1, 2, 3, 4, 5, 7, 16];
        uint256 supply = token.totalSupply();
        (uint256 pot, uint256 left) = box.claimState();
        for (uint256 i; i < roles.length; ++i) {
            address target = box.roleAddress(roles[i]);
            if (target == address(0)) continue;
            uint256 beforeP = pm.balanceOf(target, 0);
            for (uint256 k; k < signatures.length; ++k) {
                bytes4 selector = bytes4(keccak256(bytes(signatures[k])));
                uint256[] memory ids = new uint256[](1);
                ids[0] = 1;
                bytes memory data = k == 1 ? abi.encodeWithSelector(selector, ids)
                    : abi.encodePacked(selector, abi.encode(uint256(1), CREATOR, uint256(1)));
                vm.prank(CREATOR);
                (bool ok,) = target.call(data);
                assertFalse(ok, signatures[k]);
            }
            assertEq(pm.balanceOf(target, 0), beforeP);
        }
        (uint256 afterPot, uint256 afterLeft) = box.claimState();
        assertEq(afterPot, pot);
        assertEq(afterLeft, left);
        assertEq(token.totalSupply(), supply);
        assertEq(box.roleAddress(11), address(0));
        assertEq(box.roleAddress(20), address(0));
        assertEq(box.roleAddress(21), address(0));
        assertEq(box.roleAddress(22), address(0));
    }
}
