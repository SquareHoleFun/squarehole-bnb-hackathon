// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {M132aBase} from "./M132aBase.sol";
import {BoxSpec, AddOn} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {BoxFactoryV2Planner} from "../../../src/box-v2/BoxFactoryV2Planner.sol";
import {BoxFactoryV2Parts} from "../../../src/box-v2/BoxFactoryV2Parts.sol";
import {BoxCoordinatorV2} from "../../../src/box-v2/BoxCoordinatorV2.sol";
import {BoxReceiverV2} from "../../../src/box-v2/BoxReceiverV2.sol";
import {BoxTokenV2} from "../../../src/box-v2/BoxTokenV2.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";
import {IBoxFactoryV2, ChunkPart} from "../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";
import {IBoxHookV2} from "../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {IBoxTickets} from "../../../src/box/interfaces/IBoxTickets.sol";
import {ListingClass} from "../../../src/box-v2/interfaces/IListingRegistry.sol";
import {KitPlainToken} from "../m1-20c/M1_20cTokens.sol";

/// Real-part integration replacing the pre-CQ11 stand-in creation tests (BC-219/220, C14/C15).
contract M132aCreationTest is M132aBase {
    function test_allNineFeeChoicesIncludeTheCoreIncomeInbox() public {
        for (uint8 buy = 1; buy <= 3; ++buy) {
            for (uint8 sell = 1; sell <= 3; ++sell) {
                BoxSpec memory s = _spec();
                s.buyers.a.leg = buy == 2 ? 2 : 1;
                s.buyers.a.dest = buy == 1 ? 2 : buy == 2 ? 1 : 4;
                s.sellers.a.leg = sell == 2 ? 2 : 1;
                s.sellers.a.dest = sell == 1 ? 2 : sell == 2 ? 1 : 4;
                if (buy == 1 || sell == 1) s.creatorFeeRecipient = CREATOR;
                BoxCoordinatorV2 c = _create(s);
                BoxReceiverV2 r = BoxReceiverV2(c.receiver());
                assertEq(uint8(r.buyersChoice()), buy);
                assertEq(uint8(r.sellersChoice()), sell);
                for (uint256 role; role < 24; ++role) {
                    address a = c.roleAddress(role);
                    if (role <= 2 || role == 5 || role == 6) {
                        assertTrue(BoxClones.isCloneOf(a, release.implementations[role]));
                    } else if (role == 8) {
                        assertTrue(BoxClones.isReceivingCloneOf(a, release.implementations[8]));
                    } else {
                        assertEq(a, address(0));
                    }
                }
            }
        }
        assertEq(registry.boxCount(), 9);
    }

    function _price(uint8 decimals) internal returns (BoxSpec memory s, KitPlainToken p) {
        p = new KitPlainToken("Price", "P", decimals);
        p.mint(address(this), 10_000);
        p.approve(address(listings), 10_000);
        s = _spec();
        s.pricing.token = address(p);
        s.raise = 10 ** uint256(decimals);
        s.pricing.listingId = listings.add(address(p), ListingClass.OTHER, s.raise);
        p.mint(CREATOR, s.raise);
        vm.prank(CREATOR);
        p.approve(address(factory), s.raise);
    }

    function test_erc20CreationSixEightEighteenDecimalsConservesPaymentAndApprovals() public {
        uint8[3] memory ds = [uint8(6), 8, 18];
        for (uint256 i; i < ds.length; ++i) {
            (BoxSpec memory s, KitPlainToken p) = _price(ds[i]);
            s.creatorBuy = s.raise / 100;
            uint256 payment = factory.boxQParameters(s.pricing.listingId, s.raise).bootstrapQ + s.creatorBuy;
            p.mint(address(factory), 7);
            BoxCoordinatorV2 c = _create(s);
            assertEq(p.balanceOf(address(factory)), 7);
            assertEq(p.balanceOf(CREATOR), s.raise - payment);
            assertEq(p.allowance(address(factory), address(c)), 0);
            assertEq(p.balanceOf(address(c)), 0);
            assertGt(BoxTokenV2(c.token()).balanceOf(CREATOR), 0);
        }
    }

    function test_shortPullRollsBackBeforeDeployment() public {
        (BoxSpec memory s, KitPlainToken p) = _price(6);
        (bytes32 cs, bytes32 hs) = _salts(s);
        uint256 payment = factory.boxQParameters(s.pricing.listingId, s.raise).bootstrapQ;
        vm.mockCall(address(p), abi.encodeWithSelector(p.transferFrom.selector), abi.encode(true));
        vm.expectRevert(abi.encodeWithSelector(IBoxFactoryV2.ShortTransfer.selector, address(p), payment, 0));
        vm.prank(CREATOR);
        factory.createBox(s, cs, hs);
        assertEq(registry.boxCount(), 0);
        assertEq(p.balanceOf(CREATOR), s.raise);
    }

    function test_exactEthAndExistingDust() public {
        BoxSpec memory s = _spec();
        (bytes32 cs, bytes32 hs) = _salts(s);
        uint256 value = factory.boxQParameters(0, s.raise).bootstrapQ;
        vm.expectRevert(abi.encodeWithSelector(IBoxFactoryV2.WrongValue.selector, value + 1, value));
        vm.prank(CREATOR);
        factory.createBox{value: value + 1}(s, cs, hs);
        vm.deal(address(factory), 19);
        _create(s);
        assertEq(address(factory).balance, 19);
    }

    function test_creatorBuyAndFutureOpenAreReadBack() public {
        vm.warp(1_800_000_000);
        BoxSpec memory s = _spec();
        s.creatorBuy = 0.1 ether;
        s.openAt = uint32(block.timestamp + 1 days);
        BoxCoordinatorV2 c = _create(s);
        assertGt(BoxTokenV2(c.token()).balanceOf(CREATOR), 0);
        assertEq(c.effectiveOpenAt(), s.openAt);
        assertEq(c.deadline(), s.openAt + 30 days);
    }

    function test_raiseChangeInvalidatesOldSpecAndNextBoxSnapshotsNewRaise() public {
        BoxSpec memory s = _spec();
        BoxCoordinatorV2 old = _create(s);
        listings.updateRaise(0, 8 ether);
        bytes memory refusal = factory.refusal(s, CREATOR);
        assertGt(refusal.length, 0);
        vm.expectRevert(refusal);
        vm.prank(CREATOR);
        factory.createBox(s, 0, 0);
        s.raise = 8 ether;
        BoxCoordinatorV2 fresh = _create(s);
        assertNotEq(old.raise(), fresh.raise());
        assertEq(fresh.raise(), 8 ether);
        assertEq(registry.boxCount(), 2);
    }

    function test_hiddenArtTicketsAndRoyaltyRouterThenPermissionlessChunks() public {
        BoxSpec memory s = _hiddenSpec();
        assertEq(factory.refusal(s, CREATOR), "");
        (bytes32 cs, bytes32 hs) = _salts(s);
        BoxFactoryV2Planner.Plan memory p = planner.plan(release, CREATOR, s, cs, hs);
        BoxCoordinatorV2 c = _create(s);
        assertFalse(c.gateOpen());
        assertGt(c.tickets().code.length, 0);
        assertGt(c.royaltyRouter().code.length, 0);
        BoxFactoryV2Parts.Box memory b;
        b.nonces = p.nonces;
        b.roles = p.roles;
        b.boxId = p.boxId;
        b.q = p.q;
        b.registry = address(registry);
        b.listingRegistry = address(listings);
        b.weth = release.weth;
        b.randomness = release.randomness;
        (, bytes memory texts) = planner.parts().partArgs(b, s);
        vm.expectRevert();
        c.loadChunk(ChunkPart.Table, hex"1234", 0);
        c.loadChunk(ChunkPart.Table, s.metadataTable, 0);
        assertFalse(c.gateOpen());
        vm.warp(block.timestamp + 10);
        c.loadChunk(ChunkPart.Texts, texts, 0);
        assertTrue(c.gateOpen());
        assertEq(c.effectiveOpenAt(), block.timestamp + 1);
        assertEq(IBoxHookV2(c.hook()).openAt(), c.effectiveOpenAt());
        assertEq(IBoxTickets(c.tickets()).openAt(), c.effectiveOpenAt());
    }
}
