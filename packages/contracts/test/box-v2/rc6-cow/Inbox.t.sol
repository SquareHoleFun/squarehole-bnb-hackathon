// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {RoyaltyCustodyTest} from "../rc5-c/RoyaltyCustody.t.sol";
import {FactoryLife} from "../kit/FactoryLife.sol";
import {IBoxCoordinator} from "../../../src/box/interfaces/IBoxCoordinator.sol";
import {IBoxCoordinatorV2} from "../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";

import {BoxRoyaltyRouterV2} from "../../../src/box-v2/BoxRoyaltyRouterV2.sol";
import {RoyaltyCowHandler} from "../../../src/box-v2/RoyaltyCowHandler.sol";
import {CowOrder, CowSignaturePayload, RoyaltyCowHash, ICowSettlement, IConditionalOrderGenerator} from "../../../src/box-v2/interfaces/IRoyaltyCow.sol";
import {InboxListingOffline} from "../kit/RoyaltyRelease.sol";
import {HostileToken} from "../kit/HostileToken.sol";
import {M363Base} from "../m3-63-fix-create/Fixture.sol";
import {ShopNFT} from "../m2-32/ShopFixture.sol";
import {IBoxReceiverV2} from "../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {ShopConfigV2} from "../../../src/box-v2/interfaces/IShopVaultV2.sol";
import {BoxSpec, AddOn} from "../../../src/box-v2/interfaces/SpecTypes.sol";

contract InboxTest is RoyaltyCustodyTest {
    function test_RR_COW1_emptyCoinCannotRegister() public {
        vm.expectRevert(BoxRoyaltyRouterV2.NoOrder.selector);
        router.refreshOrder();
        assertFalse(router.orderRegistered());
        assertEq(router.oldestUnsoldAt(), 0);
    }

    function test_RR_COW1_dustCannotRegisterAndObservationStillStartsClock() public {
        vm.deal(address(router), 1);
        vm.expectRevert(BoxRoyaltyRouterV2.NoOrder.selector);
        router.refreshOrder();
        assertFalse(router.orderRegistered());
        assertEq(address(router).balance, 1, "refused registration rolls back wrapping");
        assertEq(router.oldestUnsoldAt(), 0);
        router.observe(address(weth));
        assertEq(router.oldestUnsoldAt(), block.timestamp);
        assertEq(weth.allowance(address(router), router.vaultRelayer()), 0);
        weth.mint(address(router), router.lotSize() - 1);
        router.refreshOrder();
        assertTrue(router.orderRegistered());
        assertEq(router.cowOrder().sellAmount, router.lotSize());
    }

    function test_AF1_observedDustSurvivesDay29Sale() public {
        vm.deal(address(router), 1 ether);
        router.refreshOrder();
        uint256 start = router.oldestUnsoldAt();
        vm.warp(start + 1 days);
        weth.mint(address(router), 1);
        router.observe(address(weth));
        assertEq(router.oldestUnsoldAt(), start);
        vm.warp(start + 29 days);
        vm.prank(router.vaultRelayer()); weth.transferFrom(address(router), address(this), 1 ether);
        router.observe(address(weth));
        assertEq(router.oldestUnsoldAt(), start, "observed dust never became zero");
        vm.warp(start + 30 days);
        vm.prank(PAYEE); assertEq(router.claimInKind(address(weth)), 1);
    }

    function test_IN02_secondCoinCanBeRefreshed() public {
        vm.deal(address(router), 1 ether);
        (bool ok,) = address(router).call(abi.encodeWithSignature("refreshOrder(address)", address(weth)));
        assertTrue(ok, "a coin is an input to the standing order");
    }
    function test_AF1_observedDustClockIsPerCoin() public {
        HostileToken usdc = new HostileToken("USDC", "USDC", 6);
        InboxListingOffline(router.listingRegistry()).set(address(usdc), 100e6);
        usdc.mint(address(router), 200e6); router.refreshOrder(address(usdc));
        vm.deal(address(router), 1 ether); router.refreshOrder();
        uint256 start = router.oldestUnsoldAt(address(usdc));
        vm.warp(start + 1 days);
        usdc.mint(address(router), 1); router.observe(address(usdc));
        vm.warp(start + 29 days);
        vm.prank(router.vaultRelayer()); usdc.transferFrom(address(router), address(this), 200e6);
        router.refreshOrder(address(usdc));
        assertEq(router.oldestUnsoldAt(address(usdc)), start);
        vm.prank(router.vaultRelayer()); weth.transferFrom(address(router), address(this), 0.05 ether);
        router.observe(address(weth));
        assertEq(router.oldestUnsoldAt(), block.timestamp, "whole-lot progress has its own clock");
        assertEq(router.oldestUnsoldAt(address(usdc)), start);
        vm.warp(start + 30 days);
        vm.prank(PAYEE); assertEq(router.claimInKind(address(usdc)), 1);
    }
    function test_IN02_allowanceCannotExceedTwentyLots() public {
        vm.deal(address(router), 100 ether);
        router.refreshOrder();
        assertEq(weth.allowance(address(router), router.vaultRelayer()), 20 * router.lotSize(), "on-chain hourly cap");
    }
    function test_IN04_anySaleRestartsClockEvenWithDust() public {
        vm.deal(address(router), 1 ether + 1);
        router.refreshOrder();
        vm.warp(block.timestamp + 1 days);
        vm.prank(router.vaultRelayer()); weth.transferFrom(address(router), address(this), 0.05 ether);
        router.refreshOrder();
        assertEq(router.oldestUnsoldAt(), block.timestamp, "partial progress restarts the coin clock");
    }
    function test_IN02_usdcAndWethOrdersPinEveryField() public {
        HostileToken usdc = new HostileToken("USDC", "USDC", 6);
        InboxListingOffline(router.listingRegistry()).set(address(usdc), 100e6);
        usdc.mint(address(router), 450e6);
        vm.deal(address(router), 2 ether);
        router.refreshOrder(address(weth)); router.refreshOrder(address(usdc));
        address[2] memory coins = [address(weth), address(usdc)];
        for (uint256 i; i < coins.length; ++i) {
            CowOrder memory o = router.cowOrder(coins[i]);
            assertEq(o.sellToken, coins[i]); assertEq(o.buyToken, address(p));
            assertEq(o.receiver, address(router)); assertEq(o.buyAmount, 1);
            assertEq(o.sellAmount, i == 0 ? 1 ether : 400e6);
            assertEq(o.validTo, (block.timestamp / 3600 + 1) * 3600);
            assertEq(o.appData, router.APP_DATA()); assertEq(o.feeAmount, 0);
            assertEq(o.kind, keccak256("sell")); assertFalse(o.partiallyFillable);
            assertEq(o.sellTokenBalance, keccak256("erc20")); assertEq(o.buyTokenBalance, keccak256("erc20"));
            CowOrder memory generated = IConditionalOrderGenerator(router.cowHandler()).getTradeableOrder(
                address(router), address(this), bytes32(0), abi.encode(coins[i]), "");
            assertEq(abi.encode(generated), abi.encode(o));
            bytes32 domain = ICowSettlement(router.settlement()).domainSeparator();
            bytes memory signature = abi.encode(o, CowSignaturePayload(new bytes32[](0), router.orderParams(coins[i]), ""));
            assertEq(router.isValidSignature(RoyaltyCowHash.digest(o, domain), signature), bytes4(0x1626ba7e));
            for (uint256 field; field < 12; ++field) {
                CowOrder memory changed = abi.decode(abi.encode(o), (CowOrder));
                assembly ("memory-safe") { let ptr := add(changed, mul(field, 32)) mstore(ptr, xor(mload(ptr), 1)) }
                (bool ok,) = address(router).staticcall(abi.encodeCall(router.isValidSignature,
                    (RoyaltyCowHash.digest(changed, domain), signature)));
                assertFalse(ok, "all twelve fields pinned for each coin");
            }
        }
    }
    function test_IN02_refillCannotRenewSpentHourlyAllowance() public {
        HostileToken usdc = new HostileToken("USDC", "USDC", 6);
        InboxListingOffline(router.listingRegistry()).set(address(usdc), 100e6);
        usdc.mint(address(router), 10000e6); router.refreshOrder(address(usdc));
        vm.deal(address(router), 100 ether); router.refreshOrder();
        for (uint256 i; i < 20; ++i) {
            vm.prank(router.vaultRelayer()); weth.transferFrom(address(router), address(this), 0.05 ether);
            router.refreshOrder();
            assertEq(weth.allowance(address(router), router.vaultRelayer()), (19 - i) * 0.05 ether);
            vm.prank(router.vaultRelayer()); usdc.transferFrom(address(router), address(this), 100e6);
            router.refreshOrder(address(usdc));
            assertEq(usdc.allowance(address(router), router.vaultRelayer()), (19 - i) * 100e6);
        }
        vm.prank(router.vaultRelayer()); vm.expectRevert(); weth.transferFrom(address(router), address(this), 1);
        vm.prank(router.vaultRelayer()); vm.expectRevert(); usdc.transferFrom(address(router), address(this), 1);
        vm.expectRevert(BoxRoyaltyRouterV2.NoOrder.selector); router.cowOrder();
        vm.expectRevert(BoxRoyaltyRouterV2.NoOrder.selector); router.cowOrder(address(usdc));
        vm.warp((block.timestamp / 3600 + 1) * 3600); router.refreshOrder(); router.refreshOrder(address(usdc));
        assertEq(weth.allowance(address(router), router.vaultRelayer()), 1 ether);
        assertEq(usdc.allowance(address(router), router.vaultRelayer()), 2000e6);
    }
    function test_IN02_unobservedSaleAcrossHoursIsChargedConservatively() public {
        vm.deal(address(router), 100 ether); router.refreshOrder();
        vm.warp((block.timestamp / 3600 + 1) * 3600);
        vm.prank(router.vaultRelayer()); weth.transferFrom(address(router), address(this), 0.5 ether);
        router.refreshOrder();
        assertEq(weth.allowance(address(router), router.vaultRelayer()), 0.5 ether);
    }
    function test_IN02_nothingDueAsksPosterToTryNextHour() public {
        vm.deal(address(router), 1 ether); router.refreshOrder();
        vm.prank(router.vaultRelayer()); weth.transferFrom(address(router), address(this), 1 ether);
        router.refreshOrder();
        assertTrue(router.orderRegistered(), "a real order persists after its lots sell");
        address handler = router.cowHandler();
        address coin = address(weth);
        vm.expectRevert(abi.encodeWithSelector(RoyaltyCowHandler.PollTryAtEpoch.selector,
            (block.timestamp / 3600 + 1) * 3600, "No income due"));
        IConditionalOrderGenerator(handler).getTradeableOrder(
            address(router), address(this), bytes32(0), abi.encode(coin), "");
    }
    function test_IN03_permitShapesCannotSpendEitherCoin() public {
        vm.deal(address(router), 1 ether); router.refreshOrder();
        bytes memory signature = abi.encode(router.cowOrder(), CowSignaturePayload(new bytes32[](0), router.orderParams(), ""));
        bytes32[3] memory shapes = [
            keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
            keccak256("Permit(address holder,address spender,uint256 nonce,uint256 expiry,bool allowed)"),
            keccak256("PermitTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline)TokenPermissions(address token,uint256 amount)")
        ];
        bytes32 domain = ICowSettlement(router.settlement()).domainSeparator();
        for (uint256 i; i < shapes.length; ++i) {
            bytes32 digest = keccak256(abi.encodePacked(hex"1901", domain,
                keccak256(abi.encode(shapes[i], address(router), address(this), type(uint256).max, 0, block.timestamp))));
            vm.expectRevert(BoxRoyaltyRouterV2.InvalidSignature.selector); router.isValidSignature(digest, signature);
        }
        (bool ok,) = address(router).staticcall(abi.encodeWithSignature("supportsInterface(bytes4)", bytes4(0x01ffc9a7)));
        assertFalse(ok);
        (ok,) = address(router).call(hex"deadbeef"); assertFalse(ok);
    }
    function test_IN04_freshWholeLotCannotInheritExpiredDustClock() public {
        vm.deal(address(router), 1); router.observe(address(weth));
        vm.warp(block.timestamp + 30 days);
        weth.mint(address(router), 1 ether);
        vm.prank(PAYEE); vm.expectRevert(BoxRoyaltyRouterV2.WaitForSale.selector);
        router.claimInKind(address(weth));
        router.refreshOrder();
        assertEq(router.oldestUnsoldAt(), block.timestamp);
    }
    function test_IN04_clocksIndependentAndBelowLotTransitionRestarts() public {
        HostileToken usdc = new HostileToken("USDC", "USDC", 6);
        InboxListingOffline(router.listingRegistry()).set(address(usdc), 100e6);
        usdc.mint(address(router), 200e6); router.refreshOrder(address(usdc));
        vm.deal(address(router), 1 ether); router.refreshOrder();
        uint256 first = router.oldestUnsoldAt();
        vm.warp(block.timestamp + 10 days);
        vm.prank(router.vaultRelayer()); usdc.transferFrom(address(router), address(this), 100e6);
        router.observe(address(usdc));
        assertEq(router.oldestUnsoldAt(address(usdc)), block.timestamp);
        assertEq(router.oldestUnsoldAt(), first);
        // A balance decrease to dust without allowance consumption is a separate observed restart.
        vm.prank(address(router)); weth.transfer(address(this), 0.99 ether);
        router.observe(address(weth));
        assertEq(router.oldestUnsoldAt(), block.timestamp);
        vm.warp(block.timestamp + 30 days);
        vm.prank(PAYEE); router.claimInKind(address(weth));
        assertEq(weth.balanceOf(PAYEE), 0.01 ether, "unchanged dust eventually exits");
    }

}

contract InboxFactoryTest is FactoryLife {
    function test_AF2_unreadableFundedInboxRecoversAfterPublicSweep() public {
        _unreadableCreatorRemainder(200000001, 200000237);
    }

    function test_AF2_unreadableEmptyInboxKeepsBootstrapRemainder() public {
        _unreadableCreatorRemainder(0, 236);
    }

    function _unreadableCreatorRemainder(uint256 pending, uint256 expected) private {
        (BoxSpec memory s, HostileToken p) = _priceSpec(1, 2, 6);
        _start(s);
        uint256 beforeBalance = p.balanceOf(CREATOR);
        BoxRoyaltyRouterV2 inbox = BoxRoyaltyRouterV2(payable(box.royaltyRouter()));
        p.mint(address(inbox), pending);
        vm.mockCallRevert(address(p), abi.encodeCall(p.balanceOf, (address(inbox))), hex"deadbeef");
        vm.warp(box.deadline()); box.fail();
        assertTrue(box.failed());
        vm.clearMockedCalls();
        vm.prank(address(0xA11CE)); inbox.sweepPriceCoin();
        assertEq(box.quoteClaim(0), expected);
        vm.prank(CREATOR); assertEq(box.claim(0, CREATOR), expected);
        assertEq(p.balanceOf(CREATOR) - beforeBalance, expected);
        (uint256 pot, uint256 left) = box.claimState();
        assertEq(pot, 0); assertEq(left, 0);
    }

    function test_AF2_claimWhileReadStillRefusedThenClaimLaterIncome() public {
        (BoxSpec memory s, HostileToken p) = _priceSpec(1, 2, 6);
        _start(s);
        uint256 beforeBalance = p.balanceOf(CREATOR);
        BoxRoyaltyRouterV2 inbox = BoxRoyaltyRouterV2(payable(box.royaltyRouter()));
        p.mint(address(inbox), 200000001);
        vm.mockCallRevert(address(p), abi.encodeCall(p.balanceOf, (address(inbox))), hex"deadbeef");
        vm.warp(box.deadline()); box.fail();
        assertEq(box.quoteClaim(0), 236);
        vm.prank(CREATOR); assertEq(box.claim(0, CREATOR), 236);
        vm.clearMockedCalls();
        for (uint256 i; i < 3; ++i) {
            uint256 amount = i == 0 ? 200000001 : i;
            if (i != 0) p.mint(address(inbox), amount);
            vm.warp(block.timestamp + 400 days);
            vm.prank(address(0xA11CE)); inbox.sweepPriceCoin();
            assertEq(box.quoteClaim(0), amount);
            vm.prank(CREATOR); assertEq(box.claim(0, CREATOR), amount);
            vm.prank(CREATOR); vm.expectRevert(); box.claim(0, CREATOR);
        }
        assertEq(p.balanceOf(CREATOR) - beforeBalance, 200000240);
    }

    function test_AF2_repeatedBoundedSweepsCreditExactlyOnce() public {
        (BoxSpec memory s, HostileToken p) = _priceSpec(1, 2, 6);
        _start(s);
        uint256 beforeBalance = p.balanceOf(CREATOR);
        BoxRoyaltyRouterV2 inbox = BoxRoyaltyRouterV2(payable(box.royaltyRouter()));
        uint256 batch = 4 * uint256(uint128(type(int128).max));
        p.mint(address(inbox), 2 * batch + 37);
        vm.mockCallRevert(address(p), abi.encodeCall(p.balanceOf, (address(inbox))), hex"deadbeef");
        vm.warp(box.deadline()); box.fail();
        vm.clearMockedCalls();
        for (uint256 i; i < 3; ++i) {
            vm.prank(address(0xA11CE)); assertEq(inbox.sweepPriceCoin(), i < 2 ? batch : 37);
            assertEq(box.quoteClaim(0), 236 + 2 * batch + 37);
        }
        vm.prank(address(0xB0B)); assertEq(inbox.sweepPriceCoin(), 0);
        vm.prank(CREATOR); assertEq(box.claim(0, CREATOR), 236 + 2 * batch + 37);
        assertEq(p.balanceOf(CREATOR) - beforeBalance, 236 + 2 * batch + 37);
    }

    function test_AF2_failedPayoutAndIntakeRemainRetryableWithoutDoubleCredit() public {
        (BoxSpec memory s, HostileToken p) = _priceSpec(1, 2, 6);
        _start(s);
        BoxRoyaltyRouterV2 inbox = BoxRoyaltyRouterV2(payable(box.royaltyRouter()));
        vm.warp(box.deadline()); box.fail();
        p.mint(address(inbox), 77);
        p.setBlocked(address(inbox), true);
        vm.expectRevert(); inbox.sweepPriceCoin();
        assertEq(box.quoteClaim(0), 313, "preview includes pending P; intake is still conditional");
        p.setBlocked(address(inbox), false);
        p.setBlocked(CREATOR, true);
        vm.prank(CREATOR); vm.expectRevert(IBoxCoordinator.ClaimFailed.selector); box.claim(0, CREATOR);
        assertEq(p.balanceOf(address(inbox)), 77, "failed payment rolls back claim's sweep too");
        assertEq(box.quoteClaim(0), 313, "rolled-back sweep is still pending in the preview");
        vm.prank(address(0xA11CE)); inbox.sweep(address(p));
        assertEq(box.quoteClaim(0), 313);
        vm.prank(CREATOR); vm.expectRevert(IBoxCoordinator.ClaimFailed.selector); box.claim(0, CREATOR);
        assertEq(box.quoteClaim(0), 313, "independent credit survives refused payment");
        vm.prank(CREATOR); assertEq(box.claim(0, address(0xB0B)), 313);
        assertEq(p.balanceOf(address(0xB0B)), 313);
    }

    function test_AF2_onlyFixedInboxCreditsAndOnlyCreatorClaims() public {
        (BoxSpec memory s,) = _priceSpec(1, 2, 6);
        _start(s);
        vm.warp(box.deadline()); box.fail();
        vm.expectRevert(IBoxCoordinatorV2.InvalidClaim.selector); box.creditInbox(77);
        vm.prank(box.receiver()); vm.expectRevert(IBoxCoordinatorV2.InvalidClaim.selector); box.creditInbox(77);
        assertEq(box.quoteClaim(0), 236);
        vm.expectRevert(IBoxCoordinatorV2.InvalidClaim.selector); box.claim(0, address(this));
        vm.prank(CREATOR); assertEq(box.claim(0, CREATOR), 236);
    }

    function test_AF1_blockedFundedInboxFailureAndPartialClaims() public {
        _blockedInboxClaims(200e6 + 1);
    }

    function test_AF1_blockedEmptyInboxControl() public {
        _blockedInboxClaims(0);
    }

    function _blockedInboxClaims(uint256 pending) private {
        (BoxSpec memory s, HostileToken p) = _priceSpec(1, 2, 6);
        _start(s); _buy(box.raise() / 5);
        BoxRoyaltyRouterV2 inbox = BoxRoyaltyRouterV2(payable(box.royaltyRouter()));
        vm.deal(address(inbox), 1 ether); inbox.refreshOrder();
        p.mint(address(inbox), pending);
        p.setBlocked(address(inbox), true);
        vm.warp(box.deadline());
        CowOrder memory order = inbox.cowOrder();
        bytes32 digest = RoyaltyCowHash.digest(order, ICowSettlement(inbox.settlement()).domainSeparator());
        bytes memory signature = abi.encode(order, CowSignaturePayload(new bytes32[](0), inbox.orderParams(), ""));
        assertEq(inbox.isValidSignature(digest, signature), bytes4(0x1626ba7e));
        box.fail();
        assertTrue(box.failed(), "issuer cannot veto failure");
        vm.expectRevert(BoxRoyaltyRouterV2.NoOrder.selector); inbox.cowOrder();
        vm.expectRevert(BoxRoyaltyRouterV2.InvalidSignature.selector); inbox.isValidSignature(digest, signature);
        inbox.refreshOrder();
        assertEq(HostileToken(inbox.weth()).allowance(address(inbox), inbox.vaultRelayer()), 0);
        (uint256 pot, uint256 left) = box.claimState();
        uint256 firstT = left / 3;
        uint256 firstP = FullMath.mulDiv(pot, firstT, left);
        assertEq(box.quoteClaim(firstT), firstP);
        assertEq(_claimPart(firstT), firstP, "available pot pays without the blocked inbox");
        assertEq(p.balanceOf(address(inbox)), pending);
        if (pending != 0) {
            assertEq(box.quoteClaim(left - firstT), pot - firstP + pending, "quote assumes successful intake");
            vm.prank(address(buyer)); vm.expectRevert(IBoxCoordinator.ClaimFailed.selector);
            box.claim(left - firstT, address(buyer));
            assertEq(token.balanceOf(address(buyer)), left - firstT, "last share stays retryable");
        }
        p.setBlocked(address(inbox), false);
        vm.prank(address(0xA11CE)); inbox.sweepPriceCoin();
        uint256 nextT = (left - firstT) / 2;
        uint256 nextP = FullMath.mulDiv(pot - firstP + pending, nextT, left - firstT);
        assertEq(_claimPart(nextT), nextP);
        assertEq(_claimPart(left - firstT - nextT), pot - firstP + pending - nextP);
        (pot, left) = box.claimState();
        assertEq(pot, 0); assertEq(left, 0); assertEq(p.balanceOf(address(inbox)), 0);
        p.mint(address(inbox), 77);
        vm.prank(address(0xA11CE)); inbox.sweepPriceCoin();
        vm.prank(CREATOR); vm.expectRevert(IBoxCoordinatorV2.InvalidClaim.selector); box.claim(0, CREATOR);
        (pot,) = box.claimState(); assertEq(pot, 77, "exhausted holder box never becomes creator-only");
    }

    function test_AF2_blockedNoBuyerRemainderIncludesLaterIntake() public {
        (BoxSpec memory s, HostileToken p) = _priceSpec(1, 2, 6);
        _start(s);
        _blockedCreatorRemainder(p, false);
    }

    function test_AF1_lateBlockedIncomeCannotVetoFixedCreatorRefund() public {
        (BoxSpec memory s, HostileToken p) = _priceSpec(1, 2, 6);
        _start(s);
        address inbox = box.royaltyRouter(); p.mint(inbox, 200e6);
        vm.warp(box.deadline()); box.fail();
        uint256 fixedRefund = box.quoteClaim(0);
        p.mint(inbox, 77); p.setBlocked(inbox, true);
        vm.prank(CREATOR); assertEq(box.claim(0, CREATOR), fixedRefund);
        assertEq(p.balanceOf(inbox), 77, "blocked income does not veto the known refund");
        p.setBlocked(inbox, false);
        vm.prank(address(0xA11CE)); BoxRoyaltyRouterV2(payable(inbox)).sweepPriceCoin();
        vm.prank(CREATOR); assertEq(box.claim(0, CREATOR), 77);
    }

    function test_AF1_blockedInboxCannotVetoFailClosed() public {
        (BoxSpec memory priced, HostileToken p) = _priceSpec(1, 2, 6);
        BoxSpec memory s = _collectionSpec();
        s.pricing = priced.pricing; s.raise = priced.raise;
        box = _create(s);
        assertFalse(box.gateOpen());
        _blockedCreatorRemainder(p, true);
    }

    function _blockedCreatorRemainder(HostileToken p, bool closed) private {
        BoxRoyaltyRouterV2 inbox = BoxRoyaltyRouterV2(payable(box.royaltyRouter()));
        p.mint(address(inbox), 200e6 + 1);
        p.setBlocked(address(inbox), true);
        if (closed) { vm.warp(box.openAt() + 14 days); box.failClosed(); }
        else { vm.warp(box.deadline()); box.fail(); }
        assertTrue(box.failed());
        (uint256 pot, uint256 left) = box.claimState();
        assertEq(left, 0);
        assertEq(box.quoteClaim(0), pot, "preview includes readable pending P");
        vm.prank(CREATOR); assertEq(box.claim(0, CREATOR), pot - 200e6 - 1, "refused intake pays only funded remainder");
        p.mint(address(inbox), 77);
        p.setBlocked(address(inbox), false);
        vm.prank(address(0xA11CE)); inbox.sweepPriceCoin();
        vm.prank(CREATOR); assertEq(box.claim(0, CREATOR), 200e6 + 1 + 77);
        (pot, left) = box.claimState(); assertEq(pot, 0); assertEq(left, 0);
        assertEq(p.balanceOf(address(inbox)), 0);
    }

    function test_AF1_arbitraryIntakeRevertDoesNotVetoFailure() public {
        _start(_spec()); _buy(box.raise() / 5);
        address inbox = box.royaltyRouter();
        vm.deal(inbox, 1 ether);
        vm.mockCallRevert(inbox, abi.encodeWithSignature("sweepPriceCoin()"), hex"deadbeef");
        vm.warp(box.deadline()); box.fail();
        assertTrue(box.failed());
        (uint256 pot, uint256 left) = box.claimState();
        assertEq(_claimPart(left / 2), FullMath.mulDiv(pot, left / 2, left));
        vm.clearMockedCalls();
        _claimWithIncome();
        assertEq(inbox.balance, 0);
    }

    function test_AF2_nativeCreatorClaimsPendingWethAfterIntake() public {
        _start(_spec());
        BoxRoyaltyRouterV2 inbox = BoxRoyaltyRouterV2(payable(box.royaltyRouter()));
        vm.deal(address(inbox), 2 ether);
        vm.prank(address(inbox));
        (bool ok,) = inbox.weth().call{value: 1 ether}(abi.encodeWithSignature("deposit()"));
        assertTrue(ok);
        vm.mockCallRevert(address(inbox), abi.encodeCall(inbox.sweepPriceCoin, ()), hex"deadbeef");
        vm.warp(box.deadline()); box.fail();
        (uint256 pot,) = box.claimState();
        assertEq(box.quoteClaim(0), pot);
        vm.prank(CREATOR); assertEq(box.claim(0, CREATOR), pot - 2 ether, "refused intake pays funded remainder");
        vm.clearMockedCalls();
        vm.prank(CREATOR); assertEq(box.claim(0, CREATOR), 2 ether);
        assertEq(inbox.pendingPriceCoin(), 0);
        (pot,) = box.claimState(); assertEq(pot, 0);
    }

    function test_AF1_unreadableInboxCannotVetoFailureOrConsumeLastShare() public {
        (BoxSpec memory s, HostileToken p) = _priceSpec(1, 2, 6);
        _start(s); _buy(box.raise() / 5);
        address inbox = box.royaltyRouter(); p.mint(inbox, 200e6);
        vm.mockCallRevert(address(p), abi.encodeCall(p.balanceOf, (inbox)), hex"deadbeef");
        vm.warp(box.deadline()); box.fail();
        assertTrue(box.failed());
        (uint256 pot, uint256 left) = box.claimState();
        assertEq(_claimPart(left / 2), FullMath.mulDiv(pot, left / 2, left));
        vm.expectRevert(IBoxCoordinator.ClaimFailed.selector); box.quoteClaim(left - left / 2);
        vm.clearMockedCalls();
        _claimWithIncome();
        assertEq(p.balanceOf(inbox), 0);
    }

    function _claimPart(uint256 amount) private returns (uint256 paid) {
        vm.startPrank(address(buyer)); token.approve(address(box), amount);
        paid = box.claim(amount, address(buyer)); vm.stopPrank();
    }

    function test_IN07_tokenBoxHasIncomeInbox() public {
        assertTrue(_create(_spec()).royaltyRouter() != address(0), "every box gets an inbox");
    }
    function test_IN06_claimSweepsPriceCoinBoughtBeforeFailure() public {
        (BoxSpec memory s, HostileToken p) = _priceSpec(1, 2, 6);
        _start(s); _buy(box.raise() / 5);
        BoxRoyaltyRouterV2 inbox = BoxRoyaltyRouterV2(payable(box.royaltyRouter()));
        p.mint(address(inbox), 200e6);
        vm.warp(box.deadline()); box.fail();
        (uint256 beforePot,) = box.claimState();
        assertEq(p.balanceOf(address(inbox)), 0, "failure sweeps old income");
        p.mint(address(inbox), 200e6);
        assertEq(_claimWithIncome(), beforePot + 200e6, "claim includes unswept CoW proceeds");
        assertEq(p.balanceOf(address(inbox)), 0);
    }
    function test_IN06_nativePriceClaimUnwrapsInboxWeth() public {
        _start(_spec()); _buy(box.raise() / 5);
        BoxRoyaltyRouterV2 inbox = BoxRoyaltyRouterV2(payable(box.royaltyRouter()));
        vm.deal(address(inbox), 1 ether);
        vm.warp(box.deadline()); box.fail();
        (uint256 beforePot,) = box.claimState();
        assertEq(address(inbox).balance, 0);
        vm.deal(address(inbox), 1 ether);
        address w = inbox.weth();
        vm.prank(address(inbox));
        (bool wrapped,) = w.call{value: 1 ether}(abi.encodeWithSignature("deposit()"));
        assertTrue(wrapped);
        assertEq(_claimWithIncome(), beforePot + 1 ether);
    }

    function test_IN06_failureSweepsBeforeFixingNoBuyerRemainder() public {
        _start(_spec());
        address inbox = box.royaltyRouter(); vm.deal(inbox, 1 ether);
        vm.warp(box.deadline()); box.fail();
        assertEq(inbox.balance, 0, "income present at failure belongs in fixed creator remainder");
        uint256 quoted = box.quoteClaim(0);
        assertGt(quoted, 0.99 ether);
        vm.prank(CREATOR); assertEq(box.claim(0, CREATOR), quoted);
    }
    function _claimWithIncome() private returns (uint256 paid) {
        uint256 held = token.balanceOf(address(buyer));
        vm.startPrank(address(buyer)); token.approve(address(box), held);
        paid = box.claim(held, address(buyer)); vm.stopPrank();
        (uint256 pot, uint256 left) = box.claimState(); assertEq(pot, 0); assertEq(left, 0);
    }

}

contract InboxAllShapesTest is M363Base {
    function test_IN07_allFourShapesHaveAnInboxAndDefaultPayee() public {
        BoxSpec[4] memory specs = [_spec(), _collectionSpec(), _shopSpec(), _pile(address(0), 0)];
        for (uint256 i; i < specs.length; ++i) {
            BoxRoyaltyRouterV2 inbox = BoxRoyaltyRouterV2(payable(_create(specs[i]).royaltyRouter()));
            assertTrue(address(inbox) != address(0));
            assertEq(address(inbox).code.length, 96, "receiving prefix plus frozen arguments");
            assertEq(IBoxReceiverV2(inbox.receiver()).creatorPayee(), CREATOR);
            assertEq(inbox.listVersion(), listings.sellableVersion());
            assertEq(inbox.listingRegistry(), address(listings));
            vm.deal(address(inbox), 150);
            inbox.sweepPriceCoin();
            assertEq(IBoxReceiverV2(inbox.receiver()).royaltyHeldP(), 150);
        }
    }
    function _shopSpec() private returns (BoxSpec memory s) {
        s = _spec(); s.boxType = 4; s.creatorBuy = s.raise / 100;
        ShopConfigV2 memory cfg;
        cfg.seedT = 100 ether; cfg.givePricesT = [uint256(1 ether), 2 ether, 4 ether, 8 ether];
        cfg.pickBps = 15000; cfg.weeklyBps = 1000; cfg.collectionBps = 250; cfg.listDelay = 7 days;
        cfg.curator = CREATOR; cfg.collections = new address[](1); cfg.collections[0] = address(new ShopNFT());
        cfg.tiers = new uint8[](1); s.contentsParams = abi.encode(cfg);
        s.addOns = new AddOn[](2); s.addOns[0] = AddOn(7, ""); s.addOns[1] = AddOn(8, abi.encode(bytes32(0), uint32(0)));
    }

}
