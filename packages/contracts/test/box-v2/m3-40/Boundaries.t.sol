// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {M340Base} from "./Fixture.sol";
import {BoxSpec, AddOn} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {BoxCoordinatorV2} from "../../../src/box-v2/BoxCoordinatorV2.sol";
import {BoxTokenV2} from "../../../src/box-v2/BoxTokenV2.sol";
import {BoxFactoryV2Planner} from "../../../src/box-v2/BoxFactoryV2Planner.sol";
import {CoordinatorViews} from "../../../src/box-v2/libraries/CoordinatorViews.sol";
import {IBoxFactoryPileV2} from "../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";
import {ShopConfigV2, IShopVaultV2} from "../../../src/box-v2/interfaces/IShopVaultV2.sol";
import {HostileCollection} from "../kit/m2/ShopDoubles.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolDriver} from "../kit/BoxV2TestBase.sol";

contract M340BoundariesTest is M340Base {
    function test_S5_falseFactoryPredicateRejectsAliasAndRollsBackCreation() public {
        BoxSpec memory s = _pile(address(0), 1 ether);
        (bytes32 cs, bytes32 hs) = _salts(s);
        BoxFactoryV2Planner.Plan memory plan = planner.plan(release, CREATOR, s, cs, hs);
        vm.mockCall(address(factory), abi.encodeCall(IBoxFactoryPileV2.isPileVault, (plan.roles[3])), abi.encode(false));
        uint256 before = CREATOR.balance;
        vm.expectRevert(CoordinatorViews.InvalidNonces.selector);
        vm.prank(CREATOR);
        factory.createBox{value: plan.payment}(s, cs, hs);
        assertEq(CREATOR.balance, before);
        assertEq(registry.boxCount(), 0);
        for (uint256 i; i < 24; ++i) assertEq(plan.roles[i].code.length, 0);
    }

    function test_S5_onlyRole19MayAliasRole3() public {
        CoordinatorViews views = new CoordinatorViews();
        bytes memory nonces = new bytes(24);
        nonces[1] = 0x01; nonces[5] = 0x02; nonces[6] = 0x03; nonces[3] = 0x04;
        nonces[19] = 0x04;
        views.checkNonces(4, bytes24(nonces));
        for (uint256 role; role < 24; ++role) {
            if (role == 1 || role == 3 || role == 5 || role == 6 || role == 19) continue;
            nonces[role] = 0x04;
            vm.expectRevert(CoordinatorViews.InvalidNonces.selector);
            views.checkNonces(4, bytes24(nonces));
            nonces[role] = 0x00;
        }
        for (uint8 nonce = 1; nonce <= 3; ++nonce) {
            nonces[19] = bytes1(nonce);
            vm.expectRevert(CoordinatorViews.InvalidNonces.selector);
            views.checkNonces(4, bytes24(nonces));
        }
        nonces[19] = 0x04;
        vm.expectRevert(CoordinatorViews.InvalidNonces.selector);
        views.checkNonces(3, bytes24(nonces));
    }

    function test_M2R9_S5_shopCustodyJoinsHOnceWithoutPileIdentityOrK() public {
        BoxSpec memory s = _spec();
        s.boxType = 4; s.creatorBuy = s.raise / 100;
        ShopConfigV2 memory cfg;
        cfg.seedT = 1000 ether;
        cfg.givePricesT = [uint256(1 ether), 2 ether, 4 ether, 8 ether];
        cfg.pickBps = 15000; cfg.weeklyBps = 1000; cfg.collectionBps = 250; cfg.listDelay = 7 days;
        cfg.curator = CREATOR;
        cfg.collections = new address[](1); cfg.collections[0] = address(new HostileCollection());
        cfg.tiers = new uint8[](1);
        s.contentsParams = abi.encode(cfg);
        s.addOns = new AddOn[](2);
        s.addOns[0] = AddOn(7, ""); s.addOns[1] = AddOn(8, abi.encode(bytes32(0), uint32(0)));
        box = _create(s);
        token = BoxTokenV2(box.token());
        IShopVaultV2 shop = IShopVaultV2(box.vault());
        vm.prank(CREATOR);
        token.approve(address(shop), cfg.seedT);
        shop.fundSeed();
        buyer = new PoolDriver(pm);
        vm.prank(CREATOR);
        token.transfer(address(buyer), 100 ether);
        buyer.mintClaims(Currency.wrap(address(token)), address(shop), 100 ether);
        assertEq(uint256(vm.load(address(box), bytes32(0))) >> 249, 0, "shop is never PILE");
        vm.warp(box.openAt() + 14 days);
        box.failClosed();
        (uint256 pot, uint256 left) = box.claimState();
        assertEq(left, token.balanceOf(CREATOR), "M2 shop H excludes liquid and backed claims exactly once");
        assertEq(shop.burnFailedT(), 1100 ether);
        (, uint256 fixedLeft) = box.claimState();
        assertEq(fixedLeft, left, "later shop burns never recount the fixed denominator");
        vm.startPrank(CREATOR);
        token.approve(address(box), left);
        assertEq(box.claim(left, CREATOR), pot, "quarantined shop T cannot dilute the holder's claim");
        vm.stopPrank();
        (pot, left) = box.claimState();
        assertEq(pot, 0);
        assertEq(left, 0);
    }

    function test_S6_requiredItemInitializationRollsBackEveryPart() public {
        BoxSpec memory s = _items(1, 2);
        (bytes32 cs, bytes32 hs) = _salts(s);
        BoxFactoryV2Planner.Plan memory plan = planner.plan(release, CREATOR, s, cs, hs);
        vm.mockCallRevert(release.implementations[16], abi.encodeWithSignature("initialize()"), "ledger init refused");
        vm.expectRevert(bytes("ledger init refused"));
        vm.prank(CREATOR);
        factory.createBox{value: plan.payment}(s, cs, hs);
        assertEq(registry.boxCount(), 0);
        for (uint256 i; i < 24; ++i) assertEq(plan.roles[i].code.length, 0);
    }
}
