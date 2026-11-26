// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {FactoryLife, LifeCustody} from "../kit/FactoryLife.sol";
import {HostileToken} from "../kit/HostileToken.sol";
import {BoxCoordinatorV2} from "../../../src/box-v2/BoxCoordinatorV2.sol";
import {IBoxReceiverV2} from "../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {BoxSpec, AddOn} from "../../../src/box-v2/interfaces/SpecTypes.sol";

import {BoxRoyaltyRouterV2} from "../../../src/box-v2/BoxRoyaltyRouterV2.sol";

contract RoyaltyLifeTest is FactoryLife {
    function test_inKindAndPriceCoinExitsInEveryPhase() public {
        uint256 initial = vm.snapshotState();
        for (uint8 phase; phase < 4; ++phase) {
            if (phase != 0) assertTrue(vm.revertToState(initial));
            _royalties(phase);
        }
    }
    function _royalties(uint8 phase) private {
        (BoxSpec memory priced, HostileToken p) = _priceSpec(1, 2, 18);
        BoxSpec memory s = _collectionSpec();
        s.pricing = priced.pricing; s.raise = priced.raise;
        s.buyers = priced.buyers; s.sellers = priced.sellers;
        s.creatorFeeRecipient = CREATOR;
        s.addOns = new AddOn[](1);
        s.addOns[0] = AddOn(4, abi.encode(uint16(500), uint8(1)));
        _start(s); _buy(box.raise() / 5);
        BoxRoyaltyRouterV2 royalty = BoxRoyaltyRouterV2(payable(box.roleAddress(8)));
        if (phase == 1) { _fill(); box.graduate(); }
        else if (phase >= 2) {
            vm.warp(box.deadline()); box.fail();
            if (phase == 3) _claimBuyer();
        }
        uint256 beforeEth = CREATOR.balance;
        vm.deal(address(royalty), 7500);
        royalty.flush(); assertEq(CREATOR.balance, beforeEth);
        if (phase < 2) vm.warp(block.timestamp + 30 days);
        address wrapped = royalty.weth();
        vm.prank(CREATOR); royalty.claimInKind(wrapped);
        assertEq(HostileToken(royalty.weth()).balanceOf(CREATOR), 7500);
        assertEq(conversionSafe.balance, 0);
        HostileToken foreign = new HostileToken("foreign", "F", 6);
        foreign.mint(address(royalty), 99);
        vm.prank(CREATOR); royalty.claimInKind(address(foreign));
        assertEq(foreign.balanceOf(CREATOR), 99);
        assertEq(foreign.balanceOf(address(royalty)), 0);
        uint256 creator = receiver.creatorP(); uint256 fit = receiver.fitOwed();
        uint256 platform = receiver.platformOwed();
        (uint256 pot, uint256 left) = box.claimState();
        p.mint(address(royalty), 1500); royalty.sweep(address(p));
        assertEq(p.balanceOf(address(royalty)), 0);
        if (phase == 0) assertEq(receiver.royaltyHeldP(), 1500);
        else if (phase == 1) {
            assertEq(receiver.creatorP() - creator, 1000);
            assertEq(receiver.fitOwed() - fit, 200);
            assertEq(receiver.platformOwed() - platform, 100);
        } else {
            (uint256 afterPot, uint256 afterLeft) = box.claimState();
            assertEq(afterPot, pot + 1500); assertEq(afterLeft, left);
            assertEq(receiver.fitOwed(), fit); assertEq(receiver.platformOwed(), platform);
        }
    }
}
