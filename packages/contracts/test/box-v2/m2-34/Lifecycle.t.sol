// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {M234Base} from "./Fixture.sol";
import {BoxSpec} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {BoxCoordinatorV2} from "../../../src/box-v2/BoxCoordinatorV2.sol";
import {BoxTokenV2} from "../../../src/box-v2/BoxTokenV2.sol";
import {IBoxHookV2, TradeBatchV2} from "../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {IBoxReceiverV2} from "../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {IHolderLedgerV2} from "../../../src/box-v2/interfaces/IHolderLedgerV2.sol";
import {IShopVaultV2, IStarterSetLoaderV2} from "../../../src/box-v2/interfaces/IShopVaultV2.sol";
import {BoxLayoutV2} from "../../../src/box-v2/libraries/BoxLayoutV2.sol";
import {PoolDriver} from "../kit/BoxV2TestBase.sol";
import {HostileCollection} from "../kit/m2/ShopDoubles.sol";

contract M234LifecycleTest is M234Base {
    function test_realHolderBoxTradesHarvestsAndPaysBothBatches() public {
        BoxSpec memory s = _holders(); s.creatorBuy = s.raise / 100;
        _start(s);
        _earnAndClaim();
    }

    function test_realHolderBoxPaysSixEightAndEighteenDecimalPriceCoins() public {
        uint8[3] memory decimals = [uint8(6), 8, 18];
        for (uint256 i; i < decimals.length; ++i) {
            (BoxSpec memory s,) = _priceSpec(3, 3, decimals[i]);
            s.buyers = _holders().buyers; s.sellers = _holders().sellers;
            s.creatorBuy = s.raise / 100;
            _start(s);
            _earnAndClaim();
        }
    }

    function test_realShopLoadsOpensTradesHarvestsAndClaimsThenGivesAndPicks() public {
        HostileCollection nft = new HostileCollection();
        address[] memory collections = new address[](10);
        uint256[] memory ids = new uint256[](10);
        uint8[] memory tiers = new uint8[](10);
        bytes32 root;
        for (uint256 i = 10; i != 0;) {
            --i; collections[i] = address(nft); ids[i] = i;
            root = keccak256(abi.encode(address(nft), i, uint8(0), root));
            nft.mint(CREATOR, i);
        }
        BoxSpec memory s = _shop(address(nft), root, 10, 1000 ether);
        box = _create(s); token = BoxTokenV2(box.token()); hook = IBoxHookV2(box.hook());
        receiver = IBoxReceiverV2(box.receiver()); layout = BoxLayoutV2.curve(s.raise, false);
        IShopVaultV2 shop = IShopVaultV2(box.vault());
        IStarterSetLoaderV2 loader = IStarterSetLoaderV2(box.starterSetLoader());
        assertFalse(box.gateOpen());
        for (uint256 i; i < 10; ++i) assertEq(nft.ownerOf(i), CREATOR, "creation pulled no NFT");
        vm.startPrank(CREATOR);
        token.approve(address(shop), 1000 ether); nft.setApprovalForAll(address(shop), true);
        loader.load(collections, ids, tiers, 0);
        vm.stopPrank();
        assertFalse(box.gateOpen());
        vm.expectRevert(); loader.complete();
        shop.fundSeed(); assertFalse(box.gateOpen());
        loader.complete(); assertTrue(box.gateOpen()); assertEq(shop.inside(), 10);
        buyer = new PoolDriver(pm); vm.deal(address(buyer), s.raise * 10);
        vm.warp(box.effectiveOpenAt() + 384); vm.roll(block.number + 1);
        _earnAndClaim();
        _fill(); box.graduate();
        vm.warp(block.timestamp + 7 days);
        nft.mint(CREATOR, 100);
        uint256 beforeT = token.balanceOf(CREATOR);
        vm.prank(CREATOR); assertEq(shop.give(address(nft), 100, 1 ether), 1 ether);
        assertEq(token.balanceOf(CREATOR), beforeT + 1 ether);
        vm.startPrank(CREATOR);
        token.approve(address(shop), 1.5 ether);
        assertEq(shop.pick(address(nft), 100, 1.5 ether, CREATOR), 1.5 ether);
        vm.stopPrank();
        assertEq(shop.budgetT(), 1000.5 ether); assertEq(nft.ownerOf(100), CREATOR);
    }

    function _earnAndClaim() private {
        IHolderLedgerV2 ledger = IHolderLedgerV2(box.roleAddress(17));
        uint256 money = _money();
        (, uint256 bought) = _buy(box.raise() / 10);
        assertGt(bought, 0);
        buyer.swap(hook.poolKey(), false, bought / 4, layout.sqrtPriceStartX96);
        assertEq(hook.saleFeesPending(), 0, "curve T fees do not mint P");
        // Before these trades only creator T is eligible; the unregistered driver cannot earn.
        uint256 creatorBefore = _balance(CREATOR);
        uint256 tipBefore = _balance(address(this));
        receiver.collect(address(this));
        assertEq(hook.saleFeesPending(), 0);
        uint256 funding;
        for (uint256 id = 1; id <= 2; ++id) {
            TradeBatchV2 memory receipt = hook.tradeBatch(id);
            assertTrue(receipt.closed); assertTrue(receiver.holderBatchClosed(id));
            uint256 paid = receiver.holderBatchPaid(id);
            if (id % 2 == 0) assertEq(paid, 0, "curve sellers have no P"); else assertGt(paid, 0);
            funding += paid;
            assertTrue(ledger.settleBatch(id, 64));
            uint256 credit = ledger.claimable(id, CREATOR);
            if (id % 2 == 0) { assertEq(credit, 0); continue; }
            assertGt(credit, 0);
            assertEq(ledger.claimable(id, address(buyer)), 0);
            (,,, uint256 residue) = ledger.batchState(id);
            assertEq(credit + residue, paid, "funding belongs to creator or residue");
            vm.prank(CREATOR); assertEq(ledger.claim(id, CREATOR), credit);
            assertEq(ledger.flushResidue(id), residue);
            vm.expectRevert(); vm.prank(CREATOR); ledger.claim(id, CREATOR);
        }
        assertGt(funding, 0); assertGt(_balance(CREATOR), creatorBefore);
        assertGe(_balance(address(this)), tipBefore);
        assertEq(pm.balanceOf(address(ledger), uint256(uint160(box.q()))), 0);
        assertEq(_money(), money, "all underlying P conserved across trades, tips and claims");
        _booked();
    }
}
