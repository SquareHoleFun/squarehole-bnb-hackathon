// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {RoyaltyRelease} from "../kit/RoyaltyRelease.sol";
// RC5-C: own-router custody; non-P goes to the current payee and P to the receiver.
import {ReceiverFixture} from "../cq11-b/ReceiverFixture.sol";
import {BoxRoyaltyRouterV2} from "../../../src/box-v2/BoxRoyaltyRouterV2.sol";
import {BoxRoyaltyRouterV2Args} from "../../../src/box-v2/libraries/BoxRoyaltyRouterV2Args.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";
import {RoyaltyDestination} from "../../../src/box/interfaces/BoxTypes.sol";

contract ReceiverWETH {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function deposit() external payable {
        balanceOf[msg.sender] += msg.value;
    }

    function transfer(address to, uint256 n) external returns (bool) {
        balanceOf[msg.sender] -= n;
        balanceOf[to] += n;
        return true;
    }

    function withdraw(uint256 n) external {
        balanceOf[msg.sender] -= n;
        payable(msg.sender).transfer(n);
    }
}

contract ReceiverRouterTest is ReceiverFixture {
    ReceiverWETH internal weth;

    function _router() internal returns (BoxRoyaltyRouterV2 router) {
        weth = new ReceiverWETH();
        BoxRoyaltyRouterV2 impl = new BoxRoyaltyRouterV2(RoyaltyRelease.config());
        router = BoxRoyaltyRouterV2(
            payable(BoxClones.create(
                    BoxClones.initCodeReceiving(
                        address(impl),
                        RoyaltyRelease.args(
                            address(coord), address(r), address(weth), RoyaltyDestination.FeeHandling, r.q()
                        )
                    )
                ))
        );
    }

    function test_routerETHAndWETHRemainForCowBeforeGraduation() public {
        BoxRoyaltyRouterV2 router = _router();
        payable(address(router)).transfer(100);
        weth.deposit{value: 200}();
        weth.transfer(address(router), 200);
        assertEq(router.flush(), 100);
        assertEq(PAYEE.balance, 0);
        assertEq(CONVERSION.balance, 0);
        assertEq(address(router).balance, 0);
        assertEq(weth.balanceOf(address(router)), 300);
        assertEq(r.royaltyHeldP(), 0);
    }

    function test_routerPricingTokenSweepHeldWholeAndAllowanceCleared() public {
        BoxRoyaltyRouterV2 router = _router();
        p.mint(address(router), 150);
        router.sweep(address(p));
        assertEq(r.royaltyHeldP(), 150);
        assertEq(p.allowance(address(router), address(r)), 0);
        coord.graduation(r);
        assertEq(r.creatorP(), 100);
        assertEq(r.fitOwed(), 20);
        _booked();
    }

    function test_routerPausedPricingTokenRefusalLeavesFundsForRetry() public {
        BoxRoyaltyRouterV2 router = _router();
        p.mint(address(router), 150);
        p.setPaused(true);
        vm.expectRevert();
        router.sweep(address(p));
        assertEq(p.balanceOf(address(router)), 150);
        p.setPaused(false);
        router.sweep(address(p));
        assertEq(r.royaltyHeldP(), 150);
        _booked();
    }

    function test_routerIntoNativePriceReceiverEscrowsAndFailedReturnGoesToPot() public {
        r = _receiver(1, 1, 1, address(0), true);
        BoxRoyaltyRouterV2 router = _router();
        payable(address(router)).transfer(150);
        router.flush();
        assertEq(r.royaltyHeldP(), 150);
        coord.failure(r);
        assertEq(_balance(address(coord)), 150);
        payable(address(router)).transfer(30);
        router.flush();
        assertEq(r.fitOwed(), 0);
        assertEq(_balance(address(coord)), 180);
        _booked();
    }
}
