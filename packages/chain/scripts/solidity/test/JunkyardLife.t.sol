// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {CQ11WDeploymentFixture} from "test/box-v2/m1-64/CQ11WDeployment.t.sol";
import {CoreV2LocalActions} from "script/local/CoreV2LocalActions.sol";
import {Branch} from "src/box-v2/interfaces/RecipeTypes.sol";
import {IFeeModulesV21} from "src/box-v2/interfaces/IFeeModulesV21.sol";
import {BoxSpec, AddOn} from "src/box-v2/interfaces/SpecTypes.sol";
import {BoxCoordinatorV2} from "src/box-v2/BoxCoordinatorV2.sol";
import {BoxTokenV2} from "src/box-v2/BoxTokenV2.sol";
import {BoxFactoryV2Parts} from "src/box-v2/BoxFactoryV2Parts.sol";
import {BoxClones} from "src/box/libraries/BoxClones.sol";
import {ChunkPart} from "src/box-v2/interfaces/IBoxCoordinatorV2.sol";
import {IBoxReceiverV2} from "src/box-v2/interfaces/IBoxReceiverV2.sol";
import {IBoxHookV2} from "src/box-v2/interfaces/IBoxHookV2.sol";
import {IHolderLedgerV2} from "src/box-v2/interfaces/IHolderLedgerV2.sol";
import {IShopVaultV2, IStarterSetLoaderV2, ShopConfigV2} from "src/box-v2/interfaces/IShopVaultV2.sol";
import {IListingRegistry, ListingClass} from "src/box-v2/interfaces/IListingRegistry.sol";
import {PriceLimitSwapper} from "test/research/hookgas/HookGasKit.sol";
import {PoolManager} from "v4-core/src/PoolManager.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {JunkyardGold, JunkyardSafeDouble, JunkyardCollection} from "../JunkyardLocal.s.sol";

/// @notice Offline EVM proof of the registry's recipe with actual factory, shop, curve and holder ledger.
contract JunkyardLifeTest is CQ11WDeploymentFixture, CoreV2LocalActions {
    address private constant ACTOR = address(0xA11CE);
    JunkyardGold private gold;
    JunkyardSafeDouble private safe;
    JunkyardCollection[6] private collections;
    BoxCoordinatorV2 private box;
    IShopVaultV2 private shop;
    uint256 private seed;
    uint256 private price;
    uint32 private listingId;
    function _beforeLocalTransaction() internal override { vm.roll(block.number + 1); vm.warp(block.timestamp + 1); }
    function _raw(string memory json, string memory key) private pure returns (uint256) { return vm.parseUint(vm.parseJsonString(json, key)); }
    function _execute(address target, bytes memory data) private {
        vm.prank(ACTOR); safe.execute(target, 0, data);
        _beforeLocalTransaction();
    }
    function _createJunkyard() private {
        (localFactory,) = _run(); localActor = ACTOR;
        localSwapper = new PriceLimitSwapper(IPoolManager(manager));
        gold = new JunkyardGold(DEPLOYER); safe = new JunkyardSafeDouble(ACTOR);
        string memory json = vm.readFile(string.concat(vm.envString("SH_EXAMPLES_CONTRACTS_ROOT"), "/../box-spec/examples/v2/junkyard.json"));
        IListingRegistry listings = IListingRegistry(localFactory.listingRegistry());
        gold.mint(address(platform), 10000);
        vm.startPrank(address(platform)); gold.approve(address(listings), 10000);
        listingId = listings.add(address(gold), ListingClass.OTHER, _raw(json, ".raise.amount"));
        vm.stopPrank();
        BoxSpec memory s = _localSpec(2);
        s.sellers.a = Branch(2, 7, "", abi.encode(uint8(_raw(json, ".fees.sellers.ceilingPreset"))));
        s.tokenName = vm.parseJsonString(json, ".name"); s.tokenSymbol = vm.parseJsonString(json, ".ticker");
        s.pricing.listingId = listingId; s.pricing.token = address(gold); s.raise = listings.listing(listingId).raise;
        assertEq(s.raise, _raw(json, ".raise.amount"), "local listing matches the registry raise");
        // Use the reviewed creator-buy.json input at the new one-gold raise.
        assertEq(s.raise, 1000000000000000000);
        assertEq(localFactory.boxQParameters(listingId, s.raise).bootstrapQ, 356550297290034);
        s.creatorBuy = 71278844301225191;
        s.deadlineDays = uint16(_raw(json, ".deadline.days"));
        ShopConfigV2 memory config;
        seed = _raw(json, ".contents.shop.seedT"); config.seedT = seed;
        for (uint256 i; i < 4; ++i) config.givePricesT[i] = _raw(json, string.concat(".contents.shop.givePricesT[", vm.toString(i), "]"));
        price = config.givePricesT[0]; config.pickBps = uint16(_raw(json, ".contents.shop.pickBps"));
        config.weeklyBps = uint16(_raw(json, ".contents.shop.weeklyBps")); config.collectionBps = uint16(_raw(json, ".contents.shop.collectionBps"));
        config.listDelay = uint32(_raw(json, ".contents.shop.listDelay")); config.curator = address(safe);
        config.collections = new address[](5); config.tiers = new uint8[](5);
        // All five Test Junk bindings start listed; index 5 is reserved for delayed curator admission.
        for (uint256 i; i < 6; ++i) { collections[i] = new JunkyardCollection(); if (i < 5) config.collections[i] = address(collections[i]); }
        address[] memory starterCollections = new address[](10); uint256[] memory ids = new uint256[](10); uint8[] memory tiers = new uint8[](10);
        uint256 cursor;
        for (uint256 c; c < 5; ++c) {
            for (uint256 id = 1; id <= 2; ++id) {
                collections[c].mint(address(safe), id); starterCollections[cursor] = address(collections[c]); ids[cursor++] = id;
            }
        }
        bytes32 root;
        for (uint256 i = 10; i != 0;) { --i; root = keccak256(abi.encode(starterCollections[i], ids[i], tiers[i], root)); }
        s.contentsParams = abi.encode(config); s.addOns[1] = AddOn(8, abi.encode(root, uint32(10)));
        gold.mint(address(safe), s.raise * 10); gold.mint(ACTOR, s.raise * 10);
        vm.warp(block.timestamp + 7 days); // price coin admission
        bytes32 cs; bytes32 hs; address predicted; bytes32 initHash;
        for (uint256 i;; ++i) {
            address t; cs = bytes32(i); (predicted, t, initHash) = localFactory.predictBox(address(safe), s, cs);
            if (t > s.pricing.token && t < localFactory.tokenAddressLimit(s.pricing.token)) break;
        }
        for (uint256 i;; ++i) { hs = bytes32(i); address h = BoxClones.predict(predicted, hs, initHash); if (uint160(h) & 0x3fff == 0x2ae0 && uint160(h) >> 152 != 0x91) break; }
        uint256 payment = localFactory.boxQParameters(listingId, s.raise).bootstrapQ + s.creatorBuy;
        _execute(address(gold), abi.encodeCall(gold.approve, (address(localFactory), payment)));
        bytes memory creation = abi.encodeCall(localFactory.createBox, (s, cs, hs));
        vm.prank(ACTOR); uint256 beforeGas = gasleft(); safe.execute(address(localFactory), 0, creation);
        uint256 used = beforeGas - gasleft(); uint256 stateGas = _frameStateGas();
        uint256 intrinsic = 21_000 + abi.encodeCall(safe.execute, (address(localFactory), 0, creation)).length * 40;
        emit log_named_uint("Junkyard Safe creation gas", used);
        emit log_named_uint("Junkyard creation state gas", stateGas);
        emit log_named_uint("Junkyard creation intrinsic upper bound", intrinsic);
        _checkGasStep(GasStep("Junkyard Safe creation", used + intrinsic, stateGas, true), stateGas != 0, 30_000_000);
        assertLe(used + intrinsic, 16_777_216, "Junkyard creation cap including calldata");
        _beforeLocalTransaction();
        box = BoxCoordinatorV2(predicted); shop = IShopVaultV2(box.vault());
        assertEq(box.creator(), address(safe)); assertEq(box.specHash(), keccak256(abi.encode(s)));
        BoxFactoryV2Parts.Box memory empty;
        (, bytes memory texts) = localFactory.planner().parts().partArgs(empty, s);
        if (texts.length != 0) _execute(address(box), abi.encodeCall(box.loadChunk, (ChunkPart.Texts, texts, bytes32(0))));
        IHolderLedgerV2 ledger = IHolderLedgerV2(box.roleAddress(17));
        _execute(address(ledger), abi.encodeCall(ledger.register, ()));
        BoxTokenV2 token = BoxTokenV2(box.token()); uint256 safeT = token.balanceOf(address(safe));
        // Exact PoolManager output for this input, including swap-step rounding.
        assertEq(safeT, 180195814884384475344482735, "creator buy exact curve output");
        assertEq(seed, 180_000_000 ether, "JY3 eighteen percent budget"); assertGt(safeT, seed);
        _execute(address(token), abi.encodeCall(token.approve, (address(shop), seed)));
        for (uint256 c; c < 5; ++c) _execute(address(collections[c]), abi.encodeCall(collections[c].setApprovalForAll, (address(shop), true)));
        IStarterSetLoaderV2 loader = IStarterSetLoaderV2(box.starterSetLoader());
        _execute(address(loader), abi.encodeCall(loader.load, (starterCollections, ids, tiers, bytes32(0))));
        shop.fundSeed(); loader.complete(); assertTrue(box.gateOpen()); assertEq(token.balanceOf(address(safe)), safeT - seed);
    }
    function test_registryJunkyardFillsGraduatesGivesPicksAndClaimsGold() public {
        _createJunkyard();
        vm.warp(box.effectiveOpenAt() + 384); vm.roll(block.number + 1);
        vm.startPrank(ACTOR); _tradeLocal(box); _fillLocal(box); vm.stopPrank();
        IBoxReceiverV2 receiver = IBoxReceiverV2(box.receiver());
        receiver.collect(address(0)); box.graduate(); assertTrue(box.graduated()); assertEq(shop.budgetT(), seed);
        uint256 safeGold = gold.balanceOf(address(safe));
        // F137: after graduation the sale's T fee reaches the sellers' side only through the public sellFees step.
        vm.startPrank(ACTOR); _tradeLocal(box); _sellLocalFees(box); vm.stopPrank(); receiver.collect(address(0));
        IHolderLedgerV2 ledger = IHolderLedgerV2(box.roleAddress(17)); uint256 claimed;
        for (uint256 batch = 1; batch <= 6; ++batch) {
            if (!receiver.holderBatchClosed(batch)) continue;
            ledger.settleBatch(batch, 64); uint256 due = ledger.claimable(batch, address(safe));
            assertEq(gold.balanceOf(address(safe)), safeGold + claimed, "claim only");
            if (due != 0) { _execute(address(ledger), abi.encodeCall(ledger.claim, (batch, address(safe)))); claimed += due; }
        }
        assertGt(claimed, 0); assertEq(gold.balanceOf(address(safe)), safeGold + claimed);
        _execute(address(shop), abi.encodeCall(shop.addCollection, (address(collections[5]), uint8(0))));
        (, uint256 pick, uint256 activeAt) = shop.collectionTerms(address(collections[5])); assertEq(pick, 2 * price);
        for (uint256 c; c < 6; ++c) {
            for (uint256 id = 100; id < 108; ++id) collections[c].mint(ACTOR, id);
            vm.prank(ACTOR); collections[c].setApprovalForAll(address(shop), true);
        }
        vm.warp(activeAt - 1); vm.prank(ACTOR); vm.expectRevert(IShopVaultV2.InvalidRequest.selector); shop.give(address(collections[5]), 100, price);
        vm.warp(activeAt);
        // 180M budget, 1M cheapest give: eighteen gives/week, four per collection.
        for (uint256 c; c < 4; ++c) for (uint256 id = 100; id < 104; ++id) {
            vm.prank(ACTOR); shop.give(address(collections[c]), id, price);
        }
        vm.prank(ACTOR); vm.expectRevert(IShopVaultV2.InvalidRequest.selector); shop.give(address(collections[0]), 104, price);
        for (uint256 id = 100; id < 102; ++id) { vm.prank(ACTOR); shop.give(address(collections[5]), id, price); }
        assertEq(shop.budgetT(), seed - 18 * price);
        vm.prank(ACTOR); vm.expectRevert(IShopVaultV2.InvalidRequest.selector); shop.give(address(collections[5]), 102, price);
        vm.startPrank(ACTOR);
        BoxTokenV2(box.token()).approve(address(shop), 2 * price);
        shop.pick(address(collections[5]), 100, 2 * price, ACTOR); vm.stopPrank();
        assertEq(shop.budgetT(), seed - 16 * price);
        vm.prank(ACTOR); vm.expectRevert(IShopVaultV2.InvalidRequest.selector); shop.give(address(collections[5]), 102, price);
        vm.warp(box.graduatedAt() + ((block.timestamp - box.graduatedAt()) / 7 days + 1) * 7 days);
        vm.prank(ACTOR); shop.give(address(collections[0]), 104, price);
        assertEq(shop.budgetT(), seed - 17 * price);
        _fillShopWithFeesThenPayHolders(receiver, ledger);
    }
    function _fillShopWithFeesThenPayHolders(IBoxReceiverV2 receiver, IHolderLedgerV2 ledger) private {
        IFeeModulesV21 step = IFeeModulesV21(address(receiver));
        assertEq(shop.ceilingT(), seed * 2);
        uint256 minimum = localFactory.boxQParameters(listingId, box.raise()).swapStepMinQ;
        for (uint256 i; i < 32 && step.modulePendingP(true) < minimum; ++i) {
            vm.startPrank(ACTOR); _tradeLocal(box); _sellLocalFees(box); vm.stopPrank(); receiver.collect(address(0));
        }
        assertGe(step.modulePendingP(true), minimum, "enough fees for a purchase");
        uint256 pending = step.modulePendingP(true); uint256 spent; uint256 refunded;
        uint256 beforeBudget = shop.budgetT();
        for (uint256 i; i < 4096 && refunded == 0; ++i) {
            if (step.modulePendingP(true) < minimum) {
                uint256 oldPending = step.modulePendingP(true);
                _roundTrip(); vm.startPrank(ACTOR); _sellLocalFees(box); vm.stopPrank(); receiver.collect(address(0));
                pending += step.modulePendingP(true) - oldPending;
            }
            uint256 held = IPoolManager(manager).balanceOf(address(ledger), uint160(address(gold)));
            _beforeLocalTransaction(); uint256 consumed = step.executeModule(true);
            uint256 refund = IPoolManager(manager).balanceOf(address(ledger), uint160(address(gold))) - held;
            spent += consumed - refund; refunded += refund;
            assertLe(shop.budgetT(), shop.ceilingT(), "fee intake ceiling");
            assertEq(BoxTokenV2(box.token()).allowance(address(receiver), address(shop)), 0, "exact per-step approval");
        }
        assertGt(shop.feesT(), 0, "G1-C1 fees buy TRASH before the ceiling");
        assertEq(shop.budgetT() - beforeBudget, shop.feesT());
        assertEq(spent + step.modulePendingP(true) + refunded, pending);
        emit log_named_uint("Junkyard fee purchases T", shop.feesT());
        uint256 room = shop.ceilingT() - shop.budgetT();
        emit log_named_uint("Junkyard remaining ceiling room T", room);
        assertGt(refunded, 0, "fee steps run until remaining room declines fees");
        // G1-C1: fees fill the ceiling until its room is worth less than one fee step at the live price, the shop
        // step's own refusal rule. F137 sells the sellers' T fees in the pool before the shop buys with that P, so T
        // ends cheaper than with sale fees in P, and that dust room holds more T than one give price.
        (uint160 spot,,,) = StateLibrary.getSlot0(IPoolManager(manager), PoolId.wrap(keccak256(abi.encode(IBoxHookV2(box.hook()).poolKey()))));
        uint256 roomP = FullMath.mulDiv(FullMath.mulDiv(room, 1 << 96, spot), 1 << 96, spot);
        emit log_named_uint("Junkyard remaining ceiling room in P at spot", roomP);
        assertLt(roomP, minimum, "G1-C1 fees approach the two-times ceiling");
        // F140 R60-HOOK (rc7 part 4): a sellFees page now sells up to 32 sources, so fee intake stops further below the
        // ceiling and the weekly give/pick below runs more rounds. Each round nets one give price out of the actor, so
        // the actor buys that T in the pool first (explicit test funding with minted gold, as _roundTrip does).
        _fundActorT(((room + price - 1) / price) * price, spot);
        // Picks, unlike fee intake, can carry the budget above the ceiling; give/pick waits for each week.
        for (uint256 i; i < shop.ceilingT() / price && shop.budgetT() < shop.ceilingT(); ++i) {
            vm.warp(block.timestamp + 7 days);
            vm.startPrank(ACTOR);
            BoxTokenV2(box.token()).approve(address(shop), 2 * price);
            shop.give(address(collections[5]), 100, price);
            shop.pick(address(collections[5]), 100, 2 * price, ACTOR);
            vm.stopPrank();
        }
        assertGe(shop.budgetT(), shop.ceilingT(), "shop filled");
        vm.warp(block.timestamp + 7 days); assertFalse(shop.feesWanted());
        _beforeLocalTransaction(); step.executeModule(true);
        assertEq(step.modulePendingP(true), 0, "ceiling refunds waiting tails");
        uint256 oldFees = shop.feesT();
        vm.startPrank(ACTOR); _tradeLocal(box); _sellLocalFees(box); vm.stopPrank(); receiver.collect(address(0));
        assertEq(step.modulePendingP(true), 0, "full shop sends sellers to holders");
        assertEq(shop.feesT(), oldFees, "no fee purchases at ceiling");
        uint256 sellerPaid;
        for (uint256 id = IBoxHookV2(box.hook()).currentTradeBatch(false) - 2; id != 0; id -= 2) if (receiver.holderBatchClosed(id) && receiver.holderBatchPaid(id) != 0) {
            sellerPaid += receiver.holderBatchPaid(id);
            ledger.settleBatch(id, 64); break;
        }
        assertGt(sellerPaid, 0, "sellers earn Test Gold after ceiling");
    }

    function _fundActorT(uint256 needT, uint160 spot) private {
        BoxTokenV2 token = BoxTokenV2(box.token());
        uint256 have = token.balanceOf(ACTOR);
        if (have >= needT) return;
        uint256 buy = needT - have;
        // At most four times the spot cost in gold (the pool is deep against one give price); the rest stays with the actor.
        uint256 maxGold = FullMath.mulDiv(FullMath.mulDiv(buy, 1 << 96, spot), 1 << 96, spot) * 4 + 1;
        gold.mint(ACTOR, maxGold); // Explicit test actor funding, never a receiver/shop gift.
        vm.startPrank(ACTOR);
        gold.approve(address(localSwapper), maxGold);
        _beforeLocalTransaction(); localSwapper.swap(IBoxHookV2(box.hook()).poolKey(), true, int256(buy), 0);
        gold.approve(address(localSwapper), 0);
        vm.stopPrank();
        assertGe(token.balanceOf(ACTOR), needT, "actor funded for the picks");
    }

    // Funded actors generate real fees and sell some original inventory back into the pool.
    // A pure round trip would leave too little pool T to reach a second 180M of shop inventory.
    function _roundTrip() private {
        IBoxHookV2 hook = IBoxHookV2(box.hook());
        BoxTokenV2 token = BoxTokenV2(box.token());
        uint256 beforeT = token.balanceOf(ACTOR);
        PoolId id = PoolId.wrap(keccak256(abi.encode(hook.poolKey())));
        (uint160 spot,,,) = StateLibrary.getSlot0(IPoolManager(manager), id);
        uint256 amount = FullMath.mulDiv(StateLibrary.getLiquidity(IPoolManager(manager), id), 20 * (1 << 96), spot);
        gold.mint(ACTOR, amount); // Explicit test actor funding, never a receiver/shop gift.
        vm.startPrank(ACTOR);
        gold.approve(address(localSwapper), amount);
        _beforeLocalTransaction(); localSwapper.swap(hook.poolKey(), true, -int256(amount), 0);
        uint256 bought = token.balanceOf(ACTOR) - beforeT + beforeT / 20;
        token.approve(address(localSwapper), bought);
        _beforeLocalTransaction(); localSwapper.swap(hook.poolKey(), false, -int256(bought), 0);
        vm.stopPrank();
    }
}
