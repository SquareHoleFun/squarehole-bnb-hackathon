// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FactoryLife} from "../kit/FactoryLife.sol";
import {IBoxTickets} from "../../../src/box/interfaces/IBoxTickets.sol";
import {IBoxVaultV2} from "../../../src/box-v2/interfaces/IBoxVaultV2.sol";
import {BoxSpec} from "../../../src/box-v2/interfaces/SpecTypes.sol";

contract ItemLifeTest is FactoryLife {
    function test_factoryHiddenArtHandsBackPlaceholdersThenClaimsExactPot() public {
        BoxSpec memory s = _hiddenSpec();
        _start(s);
        _buy(s.raise / 3);
        IBoxTickets tickets = IBoxTickets(box.tickets());
        IBoxVaultV2 vault = IBoxVaultV2(box.vault());
        (uint256 principal, uint256 fee) = vault.quoteTake(2);
        assertGe(token.balanceOf(address(buyer)), principal + fee);
        vm.startPrank(address(buyer));
        token.approve(address(tickets), principal + fee);
        uint256 first = tickets.take(2, principal + fee, block.timestamp);
        vm.stopPrank();
        vm.warp(box.deadline());
        box.fail();
        (uint256 pot, uint256 left) = box.claimState();
        uint256 wallet = token.balanceOf(address(buyer));
        assertGt(left, wallet, "open placeholders remain outstanding claims");
        uint256[] memory ids = new uint256[](2);
        ids[0] = first;
        ids[1] = first + 1;
        vm.prank(address(buyer));
        (uint256 returned, uint256 handBackFee) = tickets.handBack(ids, 0, block.timestamp);
        assertEq(handBackFee, 0);
        assertEq(wallet + returned, left, "vault K excluded, placeholder principal counted exactly once");
        assertEq(_claimBuyer(), pot);
    }
}
