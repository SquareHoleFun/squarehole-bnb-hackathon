// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {ShopCoordinator, ShopNFT} from "../m2-32/ShopFixture.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";
import {IBoxTokenV2, BoxTokenV2Args} from "../../../src/box-v2/interfaces/IBoxTokenV2.sol";
import {IShopVaultV2, ShopConfigV2} from "../../../src/box-v2/interfaces/IShopVaultV2.sol";
import {ReceiverShopV21 as Journal} from "../../../src/box-v2/libraries/ReceiverShopV21.sol";

contract FeeShopCoordinator is ShopCoordinator {
    address public receiver;
    function setReceiver(address r) external { receiver = r; }
}
contract ShopJournalHarness {
    function fund(uint256 id, uint256 p) external { Journal.fund(id, p); }
    function consume(uint256 p, uint256 refund) external { Journal.consume(p, refund); }
    function funding(uint256 id) external view returns (bool, uint256) { return Journal.funding(id); }
}
contract ShopFeeVaultPropertiesTest is Test {
    address constant OWNER = address(0xABCD);
    FeeShopCoordinator coord;
    IShopVaultV2 shop;
    IBoxTokenV2 token;
    ShopNFT nft;
    function _deploy(uint256 seed, uint8 preset) private {
        vm.warp(100 days);
        address pm = deployCode("PoolManager.sol:PoolManager", abi.encode(address(this)));
        address ci = address(new FeeShopCoordinator());
        coord = FeeShopCoordinator(BoxClones.create(BoxClones.initCode(ci, "")));
        address si = deployCode("ShopVaultV2.sol:ShopVaultV2", abi.encode(pm, ci));
        address ti = deployCode("BoxTokenV2.sol:BoxTokenV2", abi.encode(ci));
        nft = new ShopNFT();
        address next = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        token = IBoxTokenV2(BoxClones.create(BoxClones.initCode(ti, BoxTokenV2Args.encode(address(coord), next, address(0), 1e30, "T", "T"))));
        ShopConfigV2 memory c;
        c.seedT = seed; c.givePricesT = [uint256(1), 2, 3, 4]; c.pickBps = 20000;
        c.weeklyBps = 1000; c.collectionBps = 250; c.listDelay = 7 days;
        c.collections = new address[](1); c.tiers = new uint8[](1);
        c.collections[0] = address(nft);
        shop = IShopVaultV2(BoxClones.create(BoxClones.initCode(si, abi.encodePacked(address(coord), address(token), OWNER, abi.encode(c), preset))));
        coord.wire(OWNER, address(token), address(shop), OWNER, pm); coord.setReceiver(OWNER);
        vm.prank(address(coord)); shop.initialize();
    }
    function testFuzz_SF06_ceilingMultiplySaturates(uint256 seed, uint8 pick) public {
        seed = bound(seed, 2, type(uint256).max); uint8 preset = [uint8(2), 4, 8][pick % 3];
        _deploy(seed, preset);
        assertEq(shop.ceilingT(), seed > type(uint256).max / preset ? type(uint256).max : seed * preset);
    }
    function test_SF07_idleWeeksAndFirstGiveUseLiveBudget() public {
        _deploy(1000, 2);
        vm.prank(address(coord)); token.initialize();
        vm.prank(address(coord)); token.transfer(OWNER, 3000);
        vm.prank(OWNER); token.approve(address(shop), 1000); shop.fundSeed();
        coord.phase(true, false, true); vm.prank(address(coord)); shop.openGate();
        vm.warp(block.timestamp + 7 days);
        vm.startPrank(OWNER); token.approve(address(shop), 1000); shop.fundFromFees(1000); vm.stopPrank();
        assertEq(shop.budgetT(), 2000);
        vm.warp(block.timestamp + 35 days); assertFalse(shop.feesWanted(), "idle weeks read live full budget");
        nft.mint(OWNER, 1); vm.startPrank(OWNER); nft.setApprovalForAll(address(shop), true); shop.give(address(nft), 1, 1); vm.stopPrank();
        assertEq(shop.budgetT(), 1999); assertFalse(shop.feesWanted(), "first give freezes this full week");
        vm.warp(block.timestamp + 7 days); assertTrue(shop.feesWanted(), "next week sees lower live budget");
        vm.startPrank(OWNER); token.approve(address(shop), 1); shop.fundFromFees(1); vm.expectRevert(); shop.fundFromFees(1); vm.stopPrank();
        assertEq(shop.budgetT(), 2000); assertEq(token.allowance(OWNER, address(shop)), 0);
    }
    function testFuzz_SF08_partialPurchasesRefundEveryBatchWithoutRoundingLoss(uint128 rawA, uint128 rawB, uint128 rawSpend) public {
        uint256 a = uint256(rawA) + 1; uint256 b = uint256(rawB) + 1;
        uint256 spent = uint256(rawSpend) % (a + b);
        ShopJournalHarness h = new ShopJournalHarness(); h.fund(2, a); h.fund(4, b);
        h.consume(spent, 0); h.consume(a + b - spent, a + b - spent);
        (bool ca, uint256 ra) = h.funding(2); (bool cb, uint256 rb) = h.funding(4);
        assertTrue(ca && cb); assertEq(ra + rb + spent, a + b);
    }
}
