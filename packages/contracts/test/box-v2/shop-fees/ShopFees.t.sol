// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {M363Base} from "../m3-63-fix-create/Fixture.sol";
import {ShopNFT} from "../m2-32/ShopFixture.sol";
import {BoxSpec, AddOn} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {Branch} from "../../../src/box-v2/interfaces/RecipeTypes.sol";
import {ShopConfigV2, IShopVaultV2, IStarterSetLoaderV2} from "../../../src/box-v2/interfaces/IShopVaultV2.sol";
import {BoxTokenV2} from "../../../src/box-v2/BoxTokenV2.sol";
import {BoxFactoryV2Parts} from "../../../src/box-v2/BoxFactoryV2Parts.sol";
import {ChunkPart} from "../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";
import {IBoxHookV2} from "../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {IBoxReceiverV2} from "../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {BoxLayoutV2} from "../../../src/box-v2/libraries/BoxLayoutV2.sol";
import {PoolDriver} from "../kit/BoxV2TestBase.sol";
import {IHolderLedgerV2} from "../../../src/box-v2/interfaces/IHolderLedgerV2.sol";
import {Vm} from "forge-std/Vm.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";

// Local additive shapes keep the red suite compilable before the implementation.
interface ShopFees {
    function ceilingT() external view returns (uint256);
    function feesWanted() external view returns (bool);
    function feesT() external view returns (uint256);
    function fundFromFees(uint256 amount) external;
}
interface ShopReceiver {
    function executeModule(bool sellers) external returns (uint256);
    function modulePendingP(bool sellers) external view returns (uint256);
    function sideModule(bool sellers) external view returns (address, bytes32);
}
contract ShopFeesTest is M363Base {
    ShopNFT internal nft;
    uint256 internal lastSellBatch;
    uint256 internal firstSellBatch;
    IShopVaultV2 internal shop;
    // Enough live room for the capped input to meet the real listing's step minimum.
    uint256 internal constant SEED = 1_000_000 ether;
    function _shopSpec(uint8 preset) internal returns (BoxSpec memory s) {
        s = _spec(); s.boxType = 4; s.creatorBuy = 0.1 ether;
        s.buyers = _side(3);
        s.sellers.a = Branch(2, 7, "", abi.encode(preset));
        nft = new ShopNFT();
        ShopConfigV2 memory cfg;
        cfg.seedT = SEED; cfg.givePricesT = [uint256(25 ether), 50 ether, 100 ether, 200 ether];
        cfg.pickBps = 20000; cfg.weeklyBps = 1000; cfg.collectionBps = 250;
        cfg.listDelay = 7 days; cfg.curator = CREATOR;
        cfg.collections = new address[](1); cfg.collections[0] = address(nft); cfg.tiers = new uint8[](1);
        s.contentsParams = abi.encode(cfg); s.addOns = new AddOn[](2);
        s.addOns[0] = AddOn(7, ""); s.addOns[1] = AddOn(8, abi.encode(bytes32(0), uint32(0)));
    }
    function _startShop(uint8 preset) internal {
        _startShop(_shopSpec(preset));
    }
    function _startShop(BoxSpec memory s) internal {
        box = _create(s);
        token = BoxTokenV2(box.token()); hook = IBoxHookV2(box.hook()); receiver = IBoxReceiverV2(box.receiver());
        shop = IShopVaultV2(box.vault());
        BoxFactoryV2Parts.Box memory empty; (, bytes memory texts) = planner.parts().partArgs(empty, s);
        if (texts.length != 0) box.loadChunk(ChunkPart.Texts, texts, 0);
        uint256 seed = abi.decode(s.contentsParams, (ShopConfigV2)).seedT;
        vm.prank(CREATOR); token.approve(address(shop), seed); shop.fundSeed();
        IStarterSetLoaderV2(box.starterSetLoader()).complete();
        layout = BoxLayoutV2.curve(s.raise, false); buyer = new PoolDriver(pm); vm.deal(address(buyer), s.raise * 100);
        vm.warp(box.effectiveOpenAt() + 384); vm.roll(block.number + 1);
    }
    function _sellCollect() internal {
        uint256 beforeT = token.balanceOf(address(buyer));
        if (box.graduated()) buyer.swap(hook.poolKey(), true, box.raise() * 3 / 20, TickMath.MIN_SQRT_PRICE + 1);
        else _buy(box.raise() / 10);
        buyer.swap(hook.poolKey(), false, token.balanceOf(address(buyer)) - beforeT,
            box.graduated() ? TickMath.MAX_SQRT_PRICE - 1 : layout.sqrtPriceStartX96);
        lastSellBatch = hook.currentTradeBatch(false);
        if (box.graduated()) {
            if (firstSellBatch == 0) firstSellBatch = lastSellBatch;
            _sellFeeP();
            // Conversion can freeze several pairs; drain ready pages without finishing pending tails.
            for (uint256 i; i < 16; ++i) receiver.collect(address(0));
        }
        receiver.collect(address(0));
    }
    function test_SF01_factoryPresetCoreChoiceAndJournalWithoutBuyersHolders() public {
        _startShop(2);
        assertEq(uint8(receiver.sellersChoice()), 11); assertTrue(receiver.holderLedger() != address(0));
        assertEq(ShopFees(address(shop)).ceilingT(), SEED * 2);
        (address module, bytes32 hash) = ShopReceiver(address(receiver)).sideModule(true);
        assertEq(module, address(0)); assertEq(hash, bytes32(0));
        _sellCollect(); uint256 pending = ShopReceiver(address(receiver)).modulePendingP(true);
        assertEq(pending, 0, "curve T fees burn"); assertEq(shop.budgetT(), SEED); _booked();
        receiver.collect(address(0)); assertEq(ShopReceiver(address(receiver)).modulePendingP(true), pending, "no double split");
        vm.expectRevert(); ShopReceiver(address(receiver)).executeModule(true);
    }
    function test_SF02_liveCeilingExactAllowanceAndHoldersExit() public {
        _startShop(2); _fill(); box.graduate(); receiver.collect(address(0)); for (uint256 i; i < 4; ++i) _sellCollect();
        uint256 pending = ShopReceiver(address(receiver)).modulePendingP(true);
        uint256 held = pm.balanceOf(receiver.holderLedger(), 0);
        vm.roll(block.number + 1);
        uint256 moved = ShopReceiver(address(receiver)).executeModule(true);
        assertGt(moved, 0);
        uint256 spent = pending - ShopReceiver(address(receiver)).modulePendingP(true) - (pm.balanceOf(receiver.holderLedger(), 0) - held);
        assertGt(spent, 0); assertGt(ShopFees(address(shop)).feesT(), 0);
        assertLe(shop.budgetT(), SEED * 2, "fees never exceed live ceiling");
        assertEq(shop.budgetT(), SEED + ShopFees(address(shop)).feesT());
        assertEq(token.balanceOf(address(receiver)), 0); assertEq(token.allowance(address(receiver), address(shop)), 0);
        uint256 room = SEED * 2 - shop.budgetT();
        vm.prank(CREATOR); token.transfer(address(receiver), room);
        vm.startPrank(address(receiver)); token.approve(address(shop), room); ShopFees(address(shop)).fundFromFees(room); vm.stopPrank();
        ShopReceiver(address(receiver)).executeModule(true);
        assertEq(ShopReceiver(address(receiver)).modulePendingP(true), 0);
        assertEq(pm.balanceOf(receiver.holderLedger(), 0) - held, pending - spent);
        assertEq(shop.budgetT(), SEED * 2); _booked();
    }
    function test_SF03_intakeOnlyLiveReceiverAndIdleWeeks() public {
        _startShop(4); vm.expectRevert(); ShopFees(address(shop)).fundFromFees(1);
        vm.prank(address(receiver)); vm.expectRevert(); ShopFees(address(shop)).fundFromFees(1);
        _fill(); box.graduate();
        vm.prank(CREATOR); token.transfer(address(receiver), SEED * 3);
        vm.startPrank(address(receiver)); token.approve(address(shop), SEED * 3);
        ShopFees(address(shop)).fundFromFees(SEED * 3); vm.stopPrank();
        vm.warp(block.timestamp + 35 days); assertFalse(ShopFees(address(shop)).feesWanted());
        vm.prank(address(receiver)); vm.expectRevert(); ShopFees(address(shop)).fundFromFees(1);
    }
    function test_SF04_failureNeverUsesBudgetOrPileRow9() public {
        _startShop(2); _sellCollect(); uint256 pending = ShopReceiver(address(receiver)).modulePendingP(true); assertEq(pending, 0);
        vm.warp(box.deadline()); vm.recordLogs(); box.fail(); Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = keccak256("FailureRouted(uint8,uint8,address,uint256)"); bool found;
        for (uint256 i; i < logs.length; ++i) if (logs[i].emitter == address(receiver) && logs[i].topics[0] == sig) {
            assertTrue(uint256(logs[i].topics[1]) != 9, "shop fees cannot return to seeder");
            if (uint256(logs[i].topics[1]) == 21) found = true;
        }
        assertFalse(found, "curve sales cannot create SHOP_FEES_PENDING P"); assertEq(ShopReceiver(address(receiver)).modulePendingP(true), 0);
        assertEq(ShopFees(address(shop)).feesT(), 0);
    }
    function test_SF05_finalUncollectedSellersFeesJoinClosingPot() public {
        _startShop(2);
        _buy(box.raise() / 10);
        buyer.swap(hook.poolKey(), false, token.balanceOf(address(buyer)) / 3, layout.sqrtPriceStartX96);
        assertEq(pm.balanceOf(receiver.holderLedger(), 0), 0);
        vm.warp(box.deadline()); box.fail();
        assertEq(pm.balanceOf(receiver.holderLedger(), 0), 0, "final shop fees cannot become new holder funding at failure");
    }

    function test_G1_B1_smallQueueWaitsUntilNextCollectionWhileShopWantsFees() public {
        _startShop(2); IHolderLedgerV2 ledger = IHolderLedgerV2(receiver.holderLedger());
        vm.prank(CREATOR); ledger.register();
        _fill(); box.graduate(); receiver.collect(address(0));
        _sellCollect(); uint256 pending = ShopReceiver(address(receiver)).modulePendingP(true);
        assertLt(pending, listings.listing(0).q.swapStepMinQ);
        assertTrue(ShopFees(address(shop)).feesWanted());
        uint256 resolved = ShopReceiver(address(receiver)).executeModule(true);
        assertEq(resolved, 0, "sub-minimum queue waits for collection");
        assertEq(ShopReceiver(address(receiver)).modulePendingP(true), pending);
        assertEq(pm.balanceOf(address(ledger), 0), 0);
        assertFalse(receiver.holderBatchClosed(lastSellBatch)); _booked();
        for (uint256 i; i < 16 && ShopReceiver(address(receiver)).modulePendingP(true) < listings.listing(0).q.swapStepMinQ; ++i) {
            uint256 beforeT = token.balanceOf(address(buyer));
            buyer.swap(hook.poolKey(), true, box.raise() / 10, TickMath.MIN_SQRT_PRICE + 1);
            buyer.swap(hook.poolKey(), false, token.balanceOf(address(buyer)) - beforeT, TickMath.MAX_SQRT_PRICE - 1);
            _sellFeeP();
            for (uint256 page; page < 16; ++page) receiver.collect(address(0));
        }
        vm.roll(block.number + 1);
        assertGt(ShopReceiver(address(receiver)).executeModule(true), 0);
        assertGt(ShopFees(address(shop)).feesT(), 0, "later collections buy T");
        _booked();
    }
    function test_G1_B1_smallQueuePaysHoldersWhenShopStopsWantingFees() public {
        _startShop(2); IHolderLedgerV2 ledger = IHolderLedgerV2(receiver.holderLedger());
        vm.prank(CREATOR); ledger.register();
        _fill(); box.graduate(); receiver.collect(address(0)); _sellCollect();
        uint256 pending = ShopReceiver(address(receiver)).modulePendingP(true);
        vm.prank(CREATOR); token.transfer(address(receiver), SEED);
        vm.startPrank(address(receiver)); token.approve(address(shop), SEED);
        ShopFees(address(shop)).fundFromFees(SEED); vm.stopPrank();
        assertEq(ShopReceiver(address(receiver)).executeModule(true), pending);
        assertTrue(receiver.holderBatchClosed(lastSellBatch)); assertEq(receiver.holderBatchPaid(lastSellBatch), pending);
        ledger.settleBatch(lastSellBatch, 64); uint256 due = ledger.claimable(lastSellBatch, CREATOR); assertGt(due, 0);
        vm.warp(block.timestamp + 3650 days); uint256 beforeP = CREATOR.balance;
        vm.prank(CREATOR); ledger.claim(lastSellBatch, CREATOR); assertEq(CREATOR.balance - beforeP, due);
        assertEq(ledger.claimable(lastSellBatch, CREATOR), 0); _booked();
    }
    function test_SF10_refusedIntakeRollsBackPurchasePendingAndAllowance() public {
        _startShop(2); _fill(); box.graduate(); receiver.collect(address(0)); for (uint256 i; i < 4; ++i) _sellCollect();
        uint256 pending = ShopReceiver(address(receiver)).modulePendingP(true);
        uint256 claims = pm.balanceOf(address(receiver), 0); uint256 budget = shop.budgetT();
        vm.roll(block.number + 1);
        vm.mockCallRevert(address(shop), abi.encodeWithSelector(ShopFees.fundFromFees.selector), "refused");
        vm.expectRevert(); ShopReceiver(address(receiver)).executeModule(true);
        assertEq(ShopReceiver(address(receiver)).modulePendingP(true), pending);
        assertEq(pm.balanceOf(address(receiver), 0), claims); assertEq(shop.budgetT(), budget);
        assertEq(token.balanceOf(address(receiver)), 0); assertEq(token.allowance(address(receiver), address(shop)), 0);
        vm.clearMockedCalls(); assertGt(ShopReceiver(address(receiver)).executeModule(true), 0);
    }

    function _tinyShop(uint256 seed) internal {
        // Exact admitted raise from the cross-review's real-factory/PoolManager reproduction.
        listings.updateRaise(0, 1000000000000000000000000000022);
        vm.deal(CREATOR, 1e33);
        BoxSpec memory s = _shopSpec(2); s.creatorBuy = s.raise / 50;
        ShopConfigV2 memory cfg = abi.decode(s.contentsParams, (ShopConfigV2));
        cfg.seedT = seed; cfg.givePricesT = [uint256(1), 2, 3, 4];
        s.contentsParams = abi.encode(cfg); _startShop(s);
        vm.prank(CREATOR); IHolderLedgerV2(receiver.holderLedger()).register();
        _fill(); box.graduate(); receiver.collect(address(0));
        for (uint256 i; i < 4; ++i) _sellCollect();
        vm.roll(block.number + 1);
    }

    function test_SF11_oneRawTokenRoomResolvesWithoutPriceMovement() public {
        _tinyShop(2);
        uint256 pending = ShopReceiver(address(receiver)).modulePendingP(true);
        assertGt(pending, 0);
        // Previously the first step left budget 3 / ceiling 4; the second reverted ReceiverEmptySwap.
        ShopReceiver(address(receiver)).executeModule(true);
        vm.roll(block.number + 1);
        ShopReceiver(address(receiver)).executeModule(true);
        assertEq(ShopReceiver(address(receiver)).modulePendingP(true), 0, "unspendable room must resolve");
        assertEq(pm.balanceOf(receiver.holderLedger(), 0), pending, "capped dust belongs to original holders");
        assertEq(shop.budgetT(), 2); assertEq(ShopFees(address(shop)).feesT(), 0);
        assertEq(token.balanceOf(address(receiver)), 0); assertEq(token.allowance(address(receiver), address(shop)), 0);
        uint256 allocated;
        IHolderLedgerV2 ledger = IHolderLedgerV2(receiver.holderLedger());
        for (uint256 id = firstSellBatch; id <= lastSellBatch; id += 2) {
            if (!receiver.holderBatchClosed(id)) continue; // Deferred sources have not funded this module yet.
            allocated += receiver.holderBatchPaid(id);
            ledger.settleBatch(id, 64);
            uint256 due = ledger.claimable(id, CREATOR);
            if (due == 0) { assertEq(hook.tradeBatch(id).tradeUnits, 0); continue; }
            vm.warp(block.timestamp + 35 days); uint256 beforeP = CREATOR.balance;
            vm.prank(CREATOR); ledger.claim(id, CREATOR);
            assertEq(CREATOR.balance - beforeP, due);
        }
        assertEq(allocated, pending); _booked();
    }

    function test_SF12_positiveRoomCappedPurchaseBelowStepMinimumPaysHolders() public {
        _tinyShop(1000);
        uint256 pending = ShopReceiver(address(receiver)).modulePendingP(true);
        assertEq(ShopReceiver(address(receiver)).executeModule(true), pending);
        assertEq(ShopFees(address(shop)).feesT(), 0, "apply minimum to capped input, not the queue");
        assertEq(shop.budgetT(), 1000);
        assertEq(ShopReceiver(address(receiver)).modulePendingP(true), 0);
        assertEq(pm.balanceOf(receiver.holderLedger(), 0), pending); _booked();
    }

    function test_SF13_aboveMinimumQueueWithZeroRawOutputWaitsForMoreFees() public {
        _startShop(2);
        _fill(); box.graduate(); receiver.collect(address(0));
        for (uint256 i; i < 4; ++i) _sellCollect();
        uint256 pending = ShopReceiver(address(receiver)).modulePendingP(true);
        assertGe(pending, listings.listing(0).q.swapStepMinQ);
        // A real external trade makes even the above-minimum queue worth less than one raw T.
        vm.deal(address(buyer), 1e39);
        buyer.swap(hook.poolKey(), true, 1e38, TickMath.MIN_SQRT_PRICE + 1);
        vm.roll(block.number + 1);
        uint256 lastStep = hook.lastProtocolBlock();
        assertEq(ShopReceiver(address(receiver)).executeModule(true), 0);
        assertEq(ShopFees(address(shop)).feesT(), 0); assertEq(shop.budgetT(), SEED);
        assertEq(ShopReceiver(address(receiver)).modulePendingP(true), pending);
        assertEq(pm.balanceOf(receiver.holderLedger(), 0), 0);
        assertEq(hook.lastProtocolBlock(), lastStep, "fallback must not attempt a swap"); _booked();
    }

}
