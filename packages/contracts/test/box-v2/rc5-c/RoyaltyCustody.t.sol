// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {RoyaltyRelease} from "../kit/RoyaltyRelease.sol";

import {RoyaltyToxicToken} from "../m1-40b/M140bRoyalty.t.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";
import {BoxRoyaltyRouterV2} from "../../../src/box-v2/BoxRoyaltyRouterV2.sol";
import {BoxRoyaltyRouterV2Args} from "../../../src/box-v2/libraries/BoxRoyaltyRouterV2Args.sol";
import {RoyaltyDestination} from "../../../src/box/interfaces/BoxTypes.sol";
import {RoyaltyRouterTest, RoyaltySink} from "../cq11-c/RoyaltyRouter.t.sol";
import {ReceiverFixture} from "../cq11-b/ReceiverFixture.sol";
import {HostileToken} from "../kit/HostileToken.sol";
import {KitRebasingToken} from "../m1-20c/M1_20cTokens.sol";
import {IBoxReceiverV2} from "../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {IBoxRoyaltyRouterV2} from "../../../src/box-v2/interfaces/IBoxPeripheryV2.sol";

contract RoyaltyPayeeSink is RoyaltySink {
    address public creatorPayee;
    function setPayee(address value) external { creatorPayee = value; }
}

contract RoyaltyCustodyTest is RoyaltyRouterTest {
    address constant PAYEE = address(0xCAFE);

    function setUp() public override {
        super.setUp();
        RoyaltyPayeeSink code = new RoyaltyPayeeSink();
        vm.etch(address(sink), address(code).code);
        RoyaltyPayeeSink(address(sink)).setPayee(PAYEE);
    }

    function test_RC5_hostileTransfersKeepMoneyForRetry() public {
        RoyaltyToxicToken coin = new RoyaltyToxicToken();
        for (uint8 mode = 1; mode <= 5; ++mode) {
            coin.mint(address(router), 150);
            coin.script(mode, PAYEE, address(router));
            vm.prank(PAYEE);
            (bool ok,) = address(router).call{gas: 3_500_000}(abi.encodeWithSignature("claimInKind(address)", address(coin)));
            assertFalse(ok); assertEq(coin.balanceOf(address(router)), 150);
            coin.script(0, PAYEE, address(router));
            vm.prank(PAYEE); router.claimInKind(address(coin));
            assertEq(coin.balanceOf(PAYEE), uint256(mode) * 150);
        }
    }

    function test_RC5_rebasingClaimReportsDebitAndKeepsResidueClaimable() public {
        KitRebasingToken coin = new KitRebasingToken();
        coin.mint(address(router), 1 ether);
        uint256 beforeBalance = coin.balanceOf(address(router));
        assertEq(beforeBalance, 1 ether - 1);

        vm.expectEmit(true, true, false, true, address(router));
        emit IBoxRoyaltyRouterV2.InKindClaimed(address(coin), PAYEE, beforeBalance - 1);
        vm.prank(PAYEE);
        uint256 debit = router.claimInKind(address(coin));
        uint256 residue = coin.balanceOf(address(router));
        assertEq(residue, 1, "rounding residue stays in custody");
        assertEq(router.heldBalance(address(coin)), residue);
        assertEq(debit, beforeBalance - residue, "return the measured debit");
        assertEq(coin.balanceOf(PAYEE), debit);
        assertEq(coin.balanceOf(address(sink)), 0, "non-P never reaches the receiver");

        // One remaining share rounds a transfer down to zero shares: refuse that no-op atomically.
        vm.prank(PAYEE);
        vm.expectRevert(abi.encodeWithSelector(BoxRoyaltyRouterV2.TransferRefused.selector, address(coin)));
        router.claimInKind(address(coin));
        assertEq(coin.balanceOf(address(router)), residue);
        assertEq(coin.balanceOf(PAYEE), debit);

        // Another royalty makes the full share balance transferable, including the retained residue.
        coin.mint(address(router), 1 ether);
        uint256 laterBalance = coin.balanceOf(address(router));
        assertEq(laterBalance, 1 ether + residue);
        vm.expectEmit(true, true, false, true, address(router));
        emit IBoxRoyaltyRouterV2.InKindClaimed(address(coin), PAYEE, laterBalance);
        vm.prank(PAYEE);
        assertEq(router.claimInKind(address(coin)), laterBalance);
        assertEq(coin.balanceOf(address(router)), 0);
        assertEq(coin.balanceOf(PAYEE), debit + laterBalance);
    }

    function test_RC5_payeeTransferRevokesOldClaimant() public {
        address next = address(0xBEEF);
        RoyaltyPayeeSink(address(sink)).setPayee(next);
        vm.deal(address(router), 99);
        vm.prank(PAYEE); vm.expectRevert(BoxRoyaltyRouterV2.NotPayee.selector);
        router.claimInKind(address(0));
        router.flush(); vm.warp(block.timestamp + 30 days);
        vm.prank(next); router.claimInKind(address(0));
        assertEq(weth.balanceOf(next), 99); assertEq(address(router).balance, 0);
    }

    function test_RC6_payeeCodeCannotBlockWrappingOrWethClaim() public {
        vm.etch(PAYEE, hex"5f5ffd");
        vm.deal(address(router), 99);
        vm.prank(address(router)); weth.deposit{value: 70}();
        router.flush();
        assertEq(weth.balanceOf(address(router)), 99);
        assertEq(address(router).balance, 0);
        vm.warp(block.timestamp + 30 days);
        vm.prank(PAYEE); router.claimInKind(address(weth));
        assertEq(weth.balanceOf(PAYEE), 99);
    }

    function test_RC6_wethPriceCoinWrapsAndFundsReceiver() public {
        router = BoxRoyaltyRouterV2(payable(BoxClones.create(BoxClones.initCodeReceiving(address(impl),
            RoyaltyRelease.args(address(0xC0), address(sink), address(weth), RoyaltyDestination.FeeHandling, address(weth))))));
        vm.deal(address(router), 99);
        router.flush();
        assertEq(PAYEE.balance, 0);
        assertEq(weth.balanceOf(address(sink)), 99);
        vm.prank(PAYEE); vm.expectRevert(); router.claimInKind(address(weth));
        vm.prank(PAYEE); vm.expectRevert(); router.claimInKind(address(0));
    }

    function test_RC5_readsSilentEthReceipts() public {
        vm.deal(address(this), 10); payable(address(router)).transfer(10);
        (bool ok, bytes memory data) = address(router).staticcall(abi.encodeWithSignature("heldBalance(address)", address(0)));
        assertTrue(ok); assertEq(abi.decode(data, (uint256)), 10);
    }

    function test_RC5_nonPriceEtherNeverReachesReceiver() public {
        vm.deal(address(router), 100);
        router.flush();
        assertEq(sink.received(), 0, "no conversion custody at receiver");
        assertEq(PAYEE.balance, 0);
        assertEq(weth.balanceOf(address(router)), 100);
    }

    function testFuzz_RC5_payeeClaimsForeignCoin(uint128 amount) public {
        vm.assume(amount != 0);
        HostileToken coin = new HostileToken("foreign", "F", 6);
        coin.mint(address(router), amount);
        vm.prank(PAYEE);
        (bool ok,) = address(router).call(abi.encodeWithSignature("claimInKind(address)", address(coin)));
        assertTrue(ok, "payee must have an exit");
        assertEq(coin.balanceOf(PAYEE), amount);
        assertEq(coin.balanceOf(address(router)), 0);
    }

    function test_RC5_strangerCannotClaimOrRedirect() public {
        HostileToken coin = new HostileToken("foreign", "F", 6);
        coin.mint(address(router), 99);
        (bool ok,) = address(router).call(abi.encodeWithSignature("claimInKind(address)", address(coin)));
        assertFalse(ok);
        assertEq(coin.balanceOf(address(router)), 99);
    }

    function test_RC5_priceCoinKeepsBoxExit() public {
        p.mint(address(router), 99);
        vm.prank(PAYEE);
        (bool ok,) = address(router).call(abi.encodeWithSignature("claimInKind(address)", address(p)));
        assertFalse(ok);
        assertEq(router.sweep(address(p)), 99);
        assertEq(p.balanceOf(address(sink)), 99);
    }

    function testFuzz_RC5_noDigestOrInterfaceAccepted(bytes32 digest, bytes calldata signature) public {
        uint256[2] memory chains = [uint256(1), uint256(11155111)];
        for (uint256 i; i < chains.length; ++i) {
            vm.chainId(chains[i]);
            (bool ok,) = address(router).staticcall(abi.encodeWithSignature("isValidSignature(bytes32,bytes)", digest, signature));
            assertFalse(ok, "fallback has no signature authority on either chain");
            (ok,) = address(router).staticcall(abi.encodeWithSignature("supportsInterface(bytes4)", bytes4(0x1626ba7e)));
            assertFalse(ok, "CoW interface probe must revert");
        }
    }

}

contract RoyaltyReceiverCustodyTest is ReceiverFixture {
    function test_RC5_receiverRefusesForeignCoinBeforePull() public {
        HostileToken coin = new HostileToken("foreign", "F", 6);
        coin.mint(address(this), 99);
        coin.approve(address(r), 99);
        vm.expectRevert(IBoxReceiverV2.InvalidChoice.selector);
        r.fundRoyalty(address(coin), 99);
        assertEq(coin.balanceOf(address(this)), 99);
        assertEq(coin.balanceOf(CONVERSION), 0);
    }

    function test_RC5_receiverRefusesNonPriceEther() public {
        vm.expectRevert(IBoxReceiverV2.InvalidChoice.selector);
        r.fundRoyalty{value: 99}(address(0), 99);
    }
}
