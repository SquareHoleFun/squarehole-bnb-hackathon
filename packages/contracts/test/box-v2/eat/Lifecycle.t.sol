// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {NoFailureSweep} from "../rc5-a/NoFailureSweep.sol";
import {M363Base, LifeCustody} from "../m3-63-fix-create/Fixture.sol";
import {BoxSpec} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {Branch} from "../../../src/box-v2/interfaces/RecipeTypes.sol";
import {ListingClass} from "../../../src/box-v2/interfaces/IListingRegistry.sol";
import {BoxTokenV2} from "../../../src/box-v2/BoxTokenV2.sol";
import {BoxCoordinatorV2} from "../../../src/box-v2/BoxCoordinatorV2.sol";
import {IBoxHookV2} from "../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {IBoxReceiverV2} from "../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {IBoxReceiverEatV21} from "../../../src/box-v2/interfaces/IBoxReceiverEatV21.sol";
import {BoxLayoutV2} from "../../../src/box-v2/libraries/BoxLayoutV2.sol";

abstract contract EatLife is M363Base {
    BoxTokenV2 internal price;
    BoxCoordinatorV2 internal origin;
    IBoxReceiverEatV21 internal eat;
    bytes4 internal constant BURN = bytes4(keccak256("burn(uint256)"));
    function _eatSpec() internal view returns (BoxSpec memory s) {
        s = _menu(2, 2);
        s.buyers.a = Branch(1, 1, "", ""); s.sellers.a = Branch(1, 1, "", "");
    }
    function _linkedEat(bool burn, bool firstHolder) internal {
        if (firstHolder) vm.etch(CREATOR, address(new LifeCustody()).code);
        BoxSpec memory first = _spec();
        first.buyers.a = Branch(1, 6, "", abi.encode(uint8(1)));
        first.sellers.a = Branch(1, 6, "", abi.encode(uint8(1)));
        _start(first); _fill(); box.graduate(); origin = box; price = token;
        vm.startPrank(address(buyer));
        price.transfer(address(this), 10_000); price.transfer(CREATOR, 1000 ether);
        vm.stopPrank(); price.approve(address(listings), 10_000);
        uint32 id = burn ? listings.addWithBurn(address(price), ListingClass.OTHER, 100 ether, BURN)
            : listings.add(address(price), ListingClass.OTHER, 100 ether);
        BoxSpec memory second = _eatSpec();
        second.pricing.token = address(price); second.pricing.listingId = id; second.raise = 100 ether;
        vm.prank(CREATOR); price.approve(address(factory), 1000 ether);
        box = _create(second);
        token = BoxTokenV2(box.token()); hook = IBoxHookV2(box.hook()); receiver = IBoxReceiverV2(box.receiver());
        eat = IBoxReceiverEatV21(address(receiver)); layout = BoxLayoutV2.curve(second.raise, false);
        vm.warp(box.effectiveOpenAt() + 384); vm.roll(block.number + 1);
        _buy(20 ether); receiver.collect(address(0));
        assertGt(eat.eatPendingP(), 0); assertEq(eat.priceBurnSelector(), burn ? BURN : bytes4(0));
    }
}
contract EatLifecycleTest is EatLife {
    function test_EAT15_factoryNativeBothSidesGraduatesThenEats() public {
        _start(_eatSpec()); _fill(); box.graduate(); receiver.collect(address(0));
        eat = IBoxReceiverEatV21(address(receiver));
        assertEq(uint8(receiver.buyersChoice()), 6); assertEq(uint8(receiver.sellersChoice()), 6);
        uint256 pending = eat.eatPendingP(); uint256 before_ = address(0xdEaD).balance;
        assertGt(pending, 0); assertEq(eat.eatPriceCoin(), pending);
        assertEq(address(0xdEaD).balance - before_, pending); _booked();
    }
    function test_EAT16_realLedgerPriceBurnAndSupplyConservation() public {
        _linkedEat(true, false); _fill(); box.graduate(); receiver.collect(address(0));
        uint256 supply = price.totalSupply(); uint256 amount = eat.eatPendingP();
        assertEq(eat.eatPriceCoin(), amount); assertEq(price.totalSupply(), supply - amount);
        assertEq(eat.eatenP(), amount); assertEq(price.balanceOf(address(receiver)), 0); _booked();
    }
    function test_EAT17_realFailureKeepsFixedCountAndPermanentClaims() public {
        _linkedEat(true, false);
        uint256 pending = eat.eatPendingP(); assertGt(pending, 0);
        vm.warp(box.deadline()); box.fail();
        assertEq(eat.eatPendingP(), 0); assertEq(eat.eatenP(), 0);
        (uint256 pot, uint256 left) = box.claimState(); assertGt(pot, pending);
        uint256 held = token.balanceOf(address(buyer));
        vm.prank(address(buyer)); token.burn(held / 2);
        (, uint256 fixedLeft) = box.claimState(); assertEq(fixedLeft, left);
        vm.warp(box.failedAt() + 365 days); NoFailureSweep.check(address(box));
        (uint256 retained,) = box.claimState(); assertEq(retained, pot);
        assertEq(box.quoteClaim(left), pot);
        uint256 fit = receiver.fitOwed(); assertLt(fit, pending);
        assertEq(receiver.payFit(), fit); _booked();
    }
}
