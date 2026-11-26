// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {NoFailureSweep} from "../../test/box-v2/rc5-a/NoFailureSweep.sol";
import {CQ11WDeploymentFixture} from "../../test/box-v2/m1-64/CQ11WDeployment.t.sol";
import {CoreV2LocalActions} from "../local/CoreV2LocalActions.sol";
import {VerifyCoreV2} from "./VerifyCoreV2.s.sol";
import {BoxFactoryV2} from "../../src/box-v2/BoxFactoryV2.sol";
import {BoxCoordinatorV2} from "../../src/box-v2/BoxCoordinatorV2.sol";
import {BoxTokenV2} from "../../src/box-v2/BoxTokenV2.sol";
import {BoxCollectionV2} from "../../src/box-v2/BoxCollectionV2.sol";
import {IBoxHookV2, ProtocolSkip} from "../../src/box-v2/interfaces/IBoxHookV2.sol";
import {IBoxReceiverV2, IBoxReceiverItemsV2} from "../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {IHolderLedgerV2} from "../../src/box-v2/interfaces/IHolderLedgerV2.sol";
import {IItemLedgerV2} from "../../src/box-v2/interfaces/IItemLedgerV2.sol";
import {IPileVaultV2} from "../../src/box-v2/interfaces/IPileVaultV2.sol";
import {IShopVaultV2} from "../../src/box-v2/interfaces/IShopVaultV2.sol";
import {BoxSpec} from "../../src/box-v2/interfaces/SpecTypes.sol";
import {Branch} from "../../src/box-v2/interfaces/RecipeTypes.sol";
import {BoxClones} from "../../src/box/libraries/BoxClones.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PriceLimitSwapper} from "../../test/research/hookgas/HookGasKit.sol";
import {HostileCollection} from "../../test/box-v2/kit/m2/ShopDoubles.sol";
import {SepoliaTestToken} from "./SepoliaV2TestSet.sol";
import {ERC20} from "solmate/src/tokens/ERC20.sol";
import {IListingRegistry, ListingClass, ListingRecord} from "../../src/box-v2/interfaces/IListingRegistry.sol";
import {IVmFrameGasV2} from "../lib/CoreV2GasMeter.sol";
import {SepoliaV2Gas} from "./SepoliaV2Gas.sol";
import {BoxLayoutV2} from "../../src/box-v2/libraries/BoxLayoutV2.sol";

/// @notice Offline rehearsal only. Genesis/Safe read endpoints and NFT assets are labelled test doubles.
/// Every v2 money/custody implementation comes from the public deploy entry. Never broadcasts or reads a key.
abstract contract SepoliaAllRehearsal is CQ11WDeploymentFixture, CoreV2LocalActions {
    using StateLibrary for IPoolManager;
    address internal constant ACTOR = address(0xA11CE);
    address internal constant RECIPIENT = address(0xB0B);
    // The scalar/small-page calls below reserve 50k for intrinsic gas (well above
    // 21k + 40 * their calldata length); gas figures are the runbook's total envelopes.
    uint256 private serial;
    BoxCoordinatorV2 private keeperBox;
    event RehearsalStep(string step, address box, uint256 timestamp);

    function _rehearse() internal {
        // Explicit genesis read double: v2 deploys and pays the FIT Safe before box 0 graduates.
        vm.mockCall(address(box0), abi.encodeWithSignature("graduated()"), abi.encode(false));
        assertFalse(BoxCoordinatorV2(address(box0)).graduated());
        string memory manifest;
        (localFactory, manifest) = _run();
        assertEq(new VerifyCoreV2().verify(manifest), address(localFactory));
        // Offline only: observe the same one-day release-action notice required on Sepolia/mainnet.
        vm.warp(vm.getBlockTimestamp() + 1 days);
        localActor = ACTOR;
        vm.deal(ACTOR, 200 ether);
        localSwapper = new PriceLimitSwapper(IPoolManager(manager));
        localNft = new HostileCollection();
        vm.startPrank(ACTOR);
        // Fill first; seven simulated days overlap every other short life, as the live run must do.
        BoxCoordinatorV2 hatch = _newBox(_localSpec(3));
        _openTime(hatch);
        _fillLocal(hatch);
        uint256 hatchAt = IBoxHookV2(hatch.hook()).closedAt() + 7 days;
        vm.expectRevert();
        hatch.fail{gas: SepoliaV2Gas.FAIL - 21_160}();
        emit RehearsalStep("0 hatch filled; wait starts", address(hatch), block.timestamp);
        _plain();
        _boxCoinPrice();
        _holders();
        _items();
        _pile();
        // The keeper clock is simulated, never described as 24 hours of process uptime.
        for (uint256 hour; hour < 24; ++hour) {
            vm.warp(vm.getBlockTimestamp() + 1 hours);
            vm.roll(block.number + 1);
            IBoxReceiverV2(keeperBox.receiver()).collect{gas: 5_000_000 - 50_000}(address(0));
            IBoxHookV2(keeperBox.hook()).deepen{gas: 8_000_000 - 50_000}(address(0));
        }
        emit RehearsalStep("24 hourly local keeper calls; simulated time", address(keeperBox), block.timestamp);
        vm.warp(hatchAt - 1);
        vm.expectRevert();
        hatch.fail{gas: SepoliaV2Gas.FAIL - 21_160}();
        vm.warp(hatchAt);
        hatch.fail{gas: SepoliaV2Gas.FAIL - 21_160}();
        assertEq(uint8(hatch.failCause()), 3);
        _claimFailure(hatch);
        emit RehearsalStep("7d hatch and owner claim", address(hatch), block.timestamp);
        _shop(); // Its seven-day collection delay is separate from the hatch clock.
        _failedShop();
        _failedItemsAndSeed();
        vm.stopPrank();
        assertEq(new VerifyCoreV2().verify(manifest), address(localFactory));
        assertFalse(BoxCoordinatorV2(address(box0)).graduated());
        assertGt(address(fit).balance, 0, "native FIT proceeds held before genesis graduation");
    }

    function _plain() private {
        BoxCoordinatorV2 b = _newBox(_localSpec(0));
        _openTime(b);
        uint256 initial = _nativeTotal(b);
        _tradeLocal(b);
        _fourKinds(b);
        IBoxReceiverV2 r = IBoxReceiverV2(b.receiver());
        assertEq(IBoxHookV2(b.hook()).saleFeesPending(), 0);
        r.collect{gas: 5_000_000 - 50_000}(address(0));
        assertEq(IBoxHookV2(b.hook()).saleFeesPending(), 0);
        _fillLocal(b);
        b.graduate{gas: SepoliaV2Gas.GRADUATE - 21_160}();
        b.claimReward{gas: 3_000_000 - 50_000}(ACTOR);
        keeperBox = b;
        _tradeLocal(b);
        vm.roll(block.number + 1); IBoxHookV2(b.hook()).sellFees();
        r.collect{gas: 5_000_000 - 50_000}(address(0));
        IBoxHookV2 h = IBoxHookV2(b.hook());
        uint128 liquidity = h.pairedLiquidity();
        for (uint256 i; i < 3; ++i) {
            vm.roll(block.number + 1);
            h.deepen{gas: 8_000_000 - 50_000}(address(0));
        }
        assertGt(h.pairedLiquidity(), liquidity);
        (uint128 paired,,) =
            IPoolManager(manager).getPositionInfo(h.poolId(), address(h), -887220, 887220, bytes32(uint256(3)));
        assertEq(paired, h.pairedLiquidity());
        (int24 low, int24 high,) = h.curve();
        (uint128 oldCurve,,) = IPoolManager(manager).getPositionInfo(h.poolId(), address(h), low, high, bytes32(0));
        assertEq(oldCurve, 0);
        r.claimCreator{gas: 5_000_000 - 50_000}(address(0), ACTOR);
        _safeClaims(r);
        assertLe(r.booked(address(0)), IPoolManager(manager).balanceOf(address(r), 0));
        assertEq(_nativeTotal(b), initial, "real native P conserved");
        assertEq(BoxTokenV2(b.token()).totalSupply() > 0, true);
        emit RehearsalStep("plain trades harvest graduate deepen claims", address(b), block.timestamp);
        BoxSpec memory s = _localSpec(0);
        s.buyers.a = Branch(2, 1, "", "");
        s.sellers.a = s.buyers.a;
        s.creatorFeeRecipient = address(0);
        BoxCoordinatorV2 burn = _newBox(s);
        _openTime(burn);
        _tradeLocal(burn);
        _fillLocal(burn);
        burn.graduate{gas: SepoliaV2Gas.GRADUATE - 21_160}();
        IBoxReceiverV2 br = IBoxReceiverV2(burn.receiver());
        br.collect{gas: 5_000_000 - 50_000}(address(0));
        uint256 supply = BoxTokenV2(burn.token()).totalSupply();
        for (uint256 i; i < 3; ++i) {
            vm.roll(block.number + 1);
            br.buyBack{gas: 8_000_000 - 50_000}(address(0));
        }
        assertLt(BoxTokenV2(burn.token()).totalSupply(), supply, "own-pool buyback burns T");
    }

    function _fourKinds(BoxCoordinatorV2 b) private {
        IBoxHookV2 h = IBoxHookV2(b.hook());
        BoxTokenV2 t = BoxTokenV2(b.token());
        uint256 beforeT = t.balanceOf(ACTOR);
        localSwapper.swap{value: 0.1 ether, gas: 8_000_000 - 50_000}(h.poolKey(), true, int256(1 ether), 0);
        assertEq(t.balanceOf(ACTOR) - beforeT, 1 ether, "exact-out buy");
        t.approve{gas: 1_000_000 - 50_000}(address(localSwapper), t.balanceOf(ACTOR));
        uint256 beforeP = ACTOR.balance;
        uint256 counter = h.saleFeesPending();
        localSwapper.swap{gas: 8_000_000 - 50_000}(h.poolKey(), false, int256(10000), 0);
        assertEq(ACTOR.balance - beforeP, 10000, "exact-out sale net P");
        assertEq(h.saleFeesPending(), counter, "sale fee is T LP growth");
        (, int24 tick,,) = IPoolManager(manager).getSlot0(h.poolId());
        uint160 limit = TickMath.getSqrtPriceAtTick(tick + 1);
        uint256 offered = t.balanceOf(ACTOR) / 2;
        beforeT = t.balanceOf(ACTOR);
        localSwapper.swap{gas: 8_000_000 - 50_000}(h.poolKey(), false, -int256(offered), limit);
        assertGt(beforeT - t.balanceOf(ACTOR), 0);
        assertLt(beforeT - t.balanceOf(ACTOR), offered);
    }

    function _holders() private {
        _holderLife(_localSpec(1), "native holders five owners trade transfer claim");
        _listedHolders(18, ListingClass.STOCK, "stock holders five owners trade transfer claim");
        _listedHolders(8, ListingClass.OTHER, "8-decimal holders five owners trade transfer claim");
    }

    function _listedHolders(uint8 decimals, ListingClass class, string memory label) private {
        // Labelled issuer-minted test coins. STOCK exercises the actual listing class, not an issuer feed.
        SepoliaTestToken p = new SepoliaTestToken("Rehearsal price coin", "TEST", decimals, ACTOR);
        uint256 raise = 10 ** uint256(decimals);
        p.mint{gas: 1_000_000 - 50_000}(ACTOR, 100 * raise);
        p.mint{gas: 1_000_000 - 50_000}(address(platform), 10000);
        IListingRegistry listings = IListingRegistry(localFactory.listingRegistry());
        vm.stopPrank();
        vm.startPrank(address(platform));
        p.approve{gas: 1_000_000 - 50_000}(address(listings), 10000);
        uint32 id = listings.add{gas: 15_000_000 - 50_000}(address(p), class, raise);
        p.approve{gas: 1_000_000 - 50_000}(address(listings), 0);
        vm.stopPrank();
        vm.startPrank(ACTOR);
        _holderLife(_pricedSpec(1, listings.listing(id)), label);
    }

    function _holderLife(BoxSpec memory s, string memory label) private {
        BoxCoordinatorV2 b = _newBox(s);
        BoxTokenV2 t = BoxTokenV2(b.token());
        uint256 seed = t.balanceOf(ACTOR) / 10;
        for (uint160 i = 1; i < 5; ++i) {
            address owner = address(uint160(ACTOR) + i);
            vm.deal(owner, 50 ether);
            if (b.q() != address(0)) ERC20(b.q()).transfer{gas: 8_000_000 - 50_000}(owner, b.raise() * 5);
            t.transfer{gas: 8_000_000 - 50_000}(owner, seed);
        }
        _openTime(b);
        _holderRound(b);
        _holderClaims(b, 1);
        uint256 firstBatch = IBoxHookV2(b.hook()).currentTradeBatch(true);
        _fillPriced(b);
        b.graduate{gas: SepoliaV2Gas.GRADUATE - 21_160}();
        _holderRound(b);
        _holderClaims(b, firstBatch);
        emit RehearsalStep(label, address(b), block.timestamp);
    }

    function _holderRound(BoxCoordinatorV2 b) private {
        vm.stopPrank();
        for (uint160 i; i < 5; ++i) {
            address owner = address(uint160(ACTOR) + i);
            vm.startPrank(owner);
            _tradePriced(b, owner);
            BoxTokenV2 t = BoxTokenV2(b.token());
            address next = address(uint160(ACTOR) + (i + 1) % 5);
            uint256 sent = t.balanceOf(owner) / 10;
            uint256 beforeT = t.balanceOf(next);
            t.transfer{gas: 8_000_000 - 50_000}(next, sent);
            assertEq(t.balanceOf(next) - beforeT, sent);
            vm.stopPrank();
            vm.roll(block.number + 1);
        }
        vm.startPrank(ACTOR);
    }

    function _holderClaims(BoxCoordinatorV2 b, uint256 firstBatch) private {
        IHolderLedgerV2 l = IHolderLedgerV2(b.roleAddress(17));
        uint256[5] memory beforeP;
        uint256[5] memory paid;
        if (b.graduated()) {
            IBoxHookV2 h = IBoxHookV2(b.hook());
            for (uint256 step; step < 256; ++step) {
                vm.roll(block.number + 1);
                (ProtocolSkip skip,,,) = h.sellFees{gas: 5_000_000 - 50_000}();
                if (skip == ProtocolSkip.BelowMinimum) break;
            }
        }
        for (uint160 i; i < 5; ++i) {
            beforeP[i] = _priceBalance(b.q(), address(uint160(ACTOR) + i));
        }
        IBoxReceiverV2(b.receiver()).collect{gas: 5_000_000 - 50_000}(address(0));
        uint256 end = IBoxHookV2(b.hook()).currentTradeBatch(true);
        for (uint256 batch = firstBatch; batch < end; ++batch) {
            if (!IBoxReceiverV2(b.receiver()).holderBatchClosed(batch)) {
                IBoxReceiverV2(b.receiver()).collect{gas: 5_000_000 - 50_000}(address(0));
                if (!IBoxReceiverV2(b.receiver()).holderBatchClosed(batch)) {
                    assertEq(batch % 2, 0, "buyers never wait behind seller activity");
                    bool waiting;
                    for (uint256 seller = 2; seller <= batch; seller += 2) {
                        if (IBoxHookV2(b.hook()).tradeBatchPendingT(seller) != 0) waiting = true;
                    }
                    assertTrue(waiting, "only pending T delays the seller cursor");
                    vm.expectRevert(); l.settleBatch(batch, 64);
                    continue; // Later buyer sources can already be funded and claimable.
                }
            }
            bool complete;
            for (uint256 page; page < 64 && !complete; ++page) {
                complete = l.settleBatch{gas: 15_000_000 - 50_000}(batch, 64);
            }
            assertTrue(complete, "holder settlement must finish");
            for (uint160 i; i < 5; ++i) {
                address owner = address(uint160(ACTOR) + i);
                assertEq(_priceBalance(b.q(), owner), beforeP[i] + paid[i], "no pushed holder payout");
            }
            uint256 backing = IPoolManager(manager).balanceOf(address(l), uint160(b.q()));
            uint256 batchPaid;
            vm.stopPrank();
            for (uint160 i; i < 5; ++i) {
                address owner = address(uint160(ACTOR) + i);
                uint256 credit = l.claimable(batch, owner);
                if (credit == 0) continue;
                vm.startPrank(owner);
                assertEq(l.claim{gas: 8_000_000 - 50_000}(batch, owner), credit);
                assertEq(l.claimable(batch, owner), 0);
                vm.expectRevert(IHolderLedgerV2.InvalidRequest.selector);
                l.claim{gas: 8_000_000 - 50_000}(batch, owner);
                vm.stopPrank();
                paid[i] += credit;
                batchPaid += credit;
                assertEq(_priceBalance(b.q(), owner), beforeP[i] + paid[i]);
            }
            vm.startPrank(ACTOR);
            (,,, uint256 residue) = l.batchState(batch);
            assertEq(batchPaid + residue, IBoxReceiverV2(b.receiver()).holderBatchPaid(batch));
            assertEq(IPoolManager(manager).balanceOf(address(l), uint160(b.q())) + batchPaid, backing);
            assertEq(l.flushResidue{gas: 5_000_000 - 50_000}(batch), residue);
        }
        for (uint256 i; i < 5; ++i) {
            assertGt(paid[i], 0, "each of five owners claims P in each phase");
        }
    }

    function _boxCoinPrice() private {
        assertTrue(keeperBox.graduated());
        IListingRegistry listings = IListingRegistry(localFactory.listingRegistry());
        vm.stopPrank();
        vm.startPrank(address(platform));
        uint32 id = listings.add{gas: 15_000_000 - 50_000}(keeperBox.token(), ListingClass.STANDARD, 100 ether);
        vm.stopPrank();
        vm.startPrank(ACTOR);
        BoxCoordinatorV2 b = _newBox(_pricedSpec(0, listings.listing(id)));
        assertEq(b.q(), keeperBox.token());
        _openTime(b);
        _tradePriced(b, ACTOR);
        IBoxReceiverV2 r = IBoxReceiverV2(b.receiver());
        r.collect{gas: 5_000_000 - 50_000}(address(0));
        _fillPriced(b);
        b.graduate{gas: SepoliaV2Gas.GRADUATE - 21_160}();
        b.claimReward{gas: 3_000_000 - 50_000}(ACTOR);
        _tradePriced(b, ACTOR);
        r.collect{gas: 5_000_000 - 50_000}(address(0));
        (uint256 owed,) = r.creatorOwed(b.q());
        uint256 beforeP = _priceBalance(b.q(), ACTOR);
        r.claimCreator{gas: 5_000_000 - 50_000}(b.q(), ACTOR);
        assertGt(owed, 0);
        assertEq(_priceBalance(b.q(), ACTOR) - beforeP, owed);
        _safeClaims(r);
        assertLe(r.booked(b.q()), IPoolManager(manager).balanceOf(address(r), uint160(b.q())));
        emit RehearsalStep("graduated box-coin price trades harvest graduate claims", address(b), block.timestamp);
    }

    function _pricedSpec(uint8 mode, ListingRecord memory row) private view returns (BoxSpec memory s) {
        s = _localSpec(mode);
        s.pricing.token = row.token;
        s.pricing.listingId = row.id;
        s.raise = row.raise;
        s.creatorBuy = row.raise / 100;
    }

    function _priceBalance(address p, address owner) private view returns (uint256) {
        return p == address(0) ? owner.balance : ERC20(p).balanceOf(owner);
    }

    function _buyPriced(BoxCoordinatorV2 b, uint256 amount) private {
        if (b.q() != address(0)) ERC20(b.q()).approve{gas: 1_000_000 - 50_000}(address(localSwapper), amount);
        uint160 limit = b.graduated() ? 0 : BoxLayoutV2.curve(b.raise(), false).sqrtPriceEndX96;
        localSwapper.swap{value: b.q() == address(0) ? amount : 0, gas: 8_000_000 - 50_000}(
            IBoxHookV2(b.hook()).poolKey(), true, -int256(amount), limit
        );
        if (b.q() != address(0)) ERC20(b.q()).approve{gas: 1_000_000 - 50_000}(address(localSwapper), 0);
    }

    function _tradePriced(BoxCoordinatorV2 b, address owner) private {
        BoxTokenV2 t = BoxTokenV2(b.token());
        uint256 beforeT = t.balanceOf(owner);
        uint256 beforeP = _priceBalance(b.q(), owner);
        _buyPriced(b, b.raise() / 50);
        uint256 bought = t.balanceOf(owner) - beforeT;
        assertGt(bought, 0);
        assertLt(_priceBalance(b.q(), owner), beforeP);
        uint256 sale = bought / 4;
        t.approve{gas: 1_000_000 - 50_000}(address(localSwapper), sale);
        beforeP = _priceBalance(b.q(), owner);
        uint160 limit = b.graduated() ? 0 : BoxLayoutV2.curve(b.raise(), false).sqrtPriceStartX96;
        localSwapper.swap{gas: 8_000_000 - 50_000}(IBoxHookV2(b.hook()).poolKey(), false, -int256(sale), limit);
        assertGt(_priceBalance(b.q(), owner), beforeP);
        assertEq(t.balanceOf(owner), beforeT + bought - sale);
        t.approve{gas: 1_000_000 - 50_000}(address(localSwapper), 0);
    }

    function _fillPriced(BoxCoordinatorV2 b) private {
        for (uint256 i; i < 5 && !IBoxHookV2(b.hook()).closed(); ++i) {
            _buyPriced(b, b.raise() / 4);
        }
        assertTrue(IBoxHookV2(b.hook()).closed());
    }

    function _items() private {
        BoxCoordinatorV2 b = _newBox(_localSpec(4));
        _loadLocalM3(b, 4);
        _openTime(b);
        IBoxReceiverV2 r = IBoxReceiverV2(b.receiver());
        _tradeLocal(b);
        r.collect{gas: 5_000_000 - 50_000}(address(0));
        assertGt(r.itemsHeldP(), 0);
        _fillLocal(b);
        b.graduate{gas: SepoliaV2Gas.GRADUATE - 21_160}();
        _withdrawLocalItem(b);
        _tradeLocal(b);
        r.collect{gas: 5_000_000 - 50_000}(address(0));
        IItemLedgerV2 l = IItemLedgerV2(b.roleAddress(16));
        l.sync{gas: 15_000_000 - 50_000}(32);
        (uint256 credit, uint256 stash) = l.itemCredit(1);
        assertGt(credit + stash, 0);
        BoxCollectionV2(b.collection()).transferFrom{gas: 8_000_000 - 50_000}(ACTOR, RECIPIENT, 1);
        uint256[] memory ids = new uint256[](1);
        ids[0] = 1;
        vm.expectRevert();
        l.claim{gas: 4_000_000 - 50_000}(ids, ACTOR);
        vm.stopPrank();
        vm.prank(RECIPIENT);
        assertEq(l.claim{gas: 4_000_000 - 50_000}(ids, RECIPIENT), credit + stash);
        vm.startPrank(ACTOR);
        emit RehearsalStep("every item retained stash transfer current-owner claim", address(b), block.timestamp);
    }

    function _pile() private {
        BoxCoordinatorV2 b = _newBox(_localSpec(5));
        assertFalse(b.gateOpen());
        IPileVaultV2 p = IPileVaultV2(b.vault());
        assertEq(b.roleAddress(19), address(p));
        p.loadSeed{value: 1 ether, gas: 8_000_000 - 50_000}();
        assertTrue(b.gateOpen());
        _openTime(b);
        _fillLocal(b);
        b.graduate{gas: SepoliaV2Gas.GRADUATE - 21_160}();
        BoxTokenV2 t = BoxTokenV2(b.token());
        uint256 amount = t.balanceOf(ACTOR) / 4;
        uint256 supply = t.totalSupply();
        assertEq(p.supplyFloor(), 0);
        assertEq(p.quoteRedeem(supply), address(p).balance, "full supply quotes all assets, no leave-behind");
        uint256 quote = p.quoteRedeem(amount);
        assertEq(quote, 1 ether * amount / supply);
        t.approve{gas: 1_000_000 - 50_000}(address(p), amount);
        uint256 beforeP = ACTOR.balance;
        vm.expectRevert();
        p.redeem{gas: 8_000_000 - 50_000}(amount, quote + 1, ACTOR);
        assertEq(ACTOR.balance, beforeP);
        assertEq(t.totalSupply(), supply);
        assertEq(t.allowance(ACTOR, address(p)), amount);
        assertEq(p.redeem{gas: 8_000_000 - 50_000}(amount, quote, ACTOR), quote);
        assertEq(ACTOR.balance - beforeP, quote);
        assertEq(address(p).balance + quote, 1 ether);
        assertEq(t.totalSupply() + amount, supply);
        assertEq(p.quoteRedeem(t.totalSupply()), address(p).balance);
        emit RehearsalStep("pile exact seed and redemption", address(b), block.timestamp);
    }

    function _shop() private {
        BoxCoordinatorV2 b = _newBox(_localSpec(2));
        assertFalse(b.gateOpen());
        _loadLocalShop(b);
        assertTrue(b.gateOpen());
        _openTime(b);
        _fillLocal(b);
        b.graduate{gas: SepoliaV2Gas.GRADUATE - 21_160}();
        vm.warp(vm.getBlockTimestamp() + 7 days);
        uint256 beforeT = BoxTokenV2(b.token()).balanceOf(ACTOR);
        uint256 budget = IShopVaultV2(b.vault()).budgetT();
        _givePickLocal(b);
        assertEq(localNft.ownerOf(100), ACTOR);
        assertEq(IShopVaultV2(b.vault()).budgetT(), budget + 0.5 ether);
        assertEq(BoxTokenV2(b.token()).balanceOf(ACTOR) + 0.5 ether, beforeT);
        emit RehearsalStep("shop starter set seed give and pick", address(b), block.timestamp);
    }

    function _failedItemsAndSeed() private {
        BoxSpec memory s = _localSpec(4);
        s.deadlineDays = 60;
        BoxCoordinatorV2 b = _newBox(s);
        _loadLocalM3(b, 4);
        _openTime(b);
        _tradeLocal(b);
        IBoxReceiverV2 r = IBoxReceiverV2(b.receiver());
        r.collect{gas: 5_000_000 - 50_000}(address(0));
        uint256 held = r.itemsHeldP();
        assertGt(held, 0);
        vm.warp(b.deadline());
        b.fail{gas: SepoliaV2Gas.FAIL - 21_160}();
        assertEq(uint8(b.failCause()), 1);
        assertEq(r.itemsHeldP(), 0);
        assertEq(IBoxReceiverItemsV2(address(r)).itemFundingCount(), 0);
        (uint256 pot,) = b.claimState();
        assertGt(pot, held);
        _claimFailure(b);
        s = _localSpec(5);
        s.deadlineDays = 60;
        BoxCoordinatorV2 failedPile = _newBox(s);
        IPileVaultV2 p = IPileVaultV2(failedPile.vault());
        p.loadSeed{value: 1 ether, gas: 8_000_000 - 50_000}();
        _openTime(failedPile);
        _tradeLocal(failedPile);
        vm.warp(failedPile.deadline());
        failedPile.fail{gas: SepoliaV2Gas.FAIL - 21_160}();
        _claimFailure(failedPile);
        uint256 beforeP = ACTOR.balance;
        assertEq(p.returnSeed{gas: 8_000_000 - 50_000}(), 1 ether);
        assertEq(ACTOR.balance - beforeP, 1 ether);
        emit RehearsalStep(
            "deadline claims held items to pot seed returns separately", address(failedPile), block.timestamp
        );
        // RC5 claims remain open past the former year boundary; this clock warp is local only.
        uint256 sweptAt = b.failedAt() + 365 days;
        vm.warp(sweptAt - 1);
        NoFailureSweep.check(address(b));
        vm.warp(sweptAt);
        (pot,) = b.claimState();
        NoFailureSweep.check(address(b));
        (, uint256 remainingT) = b.claimState();
        assertEq(b.quoteClaim(remainingT), pot);
        _claimFailure(b); // An actual owner claim still succeeds after the old deadline.
        _safeClaims(r);
        emit RehearsalStep("365d simulated: claims stay open", address(b), block.timestamp);
    }

    function _failedShop() private {
        localNft = new HostileCollection();
        BoxCoordinatorV2 b = _newBox(_localSpec(2));
        _loadLocalShop(b);
        _openTime(b);
        _tradeLocal(b);
        vm.warp(b.deadline());
        b.fail{gas: SepoliaV2Gas.FAIL - 21_160}();
        assertEq(uint8(b.failCause()), 1);
        _claimFailure(b);
        IShopVaultV2 shop = IShopVaultV2(b.vault());
        uint256[] memory indexes = new uint256[](10);
        for (uint256 i; i < 10; ++i) {
            indexes[i] = i;
            assertEq(localNft.ownerOf(i), address(shop));
        }
        uint256 beforeT = BoxTokenV2(b.token()).balanceOf(ACTOR);
        uint256 returned;
        // FINAL2-GAS measures a 2M envelope for ONE starter. Keep each NFT retry independent.
        for (uint256 i; i < indexes.length; ++i) {
            returned += _returnStarter(shop, indexes[i]);
        }
        assertEq(returned, 10);
        for (uint256 i; i < 10; ++i) {
            assertEq(localNft.ownerOf(i), ACTOR);
        }
        assertEq(shop.inside(), 0);
        for (uint256 i; i < indexes.length; ++i) {
            assertEq(_returnStarter(shop, indexes[i]), 0, "starter return is once only");
        }
        shop.burnFailedT{gas: 5_000_000 - 50_000}();
        assertEq(BoxTokenV2(b.token()).balanceOf(ACTOR), beforeT, "failed seed never returned as T");
        assertEq(shop.failedT(), 0);
        emit RehearsalStep("failed shop starter recovery and owner claim", address(b), block.timestamp);
    }

    function _claimFailure(BoxCoordinatorV2 b) private {
        (uint256 pot, uint256 left) = b.claimState();
        uint256 amount = BoxTokenV2(b.token()).balanceOf(ACTOR) / 2;
        uint256 quote = b.quoteClaim(amount);
        assertGt(quote, 0);
        BoxTokenV2(b.token()).approve{gas: 1_000_000 - 50_000}(address(b), amount);
        uint256 beforeP = ACTOR.balance;
        assertEq(b.claim{gas: 8_000_000 - 50_000}(amount, ACTOR), quote);
        assertEq(ACTOR.balance - beforeP, quote);
        (uint256 afterPot, uint256 afterLeft) = b.claimState();
        assertEq(afterPot + quote, pot);
        assertEq(afterLeft + amount, left);
    }

    function _safeClaims(IBoxReceiverV2 r) private {
        address p = BoxCoordinatorV2(r.coordinator()).q();
        uint256 beforeP = _priceBalance(p, address(fit));
        uint256 owed = r.fitOwed();
        vm.stopPrank();
        vm.prank(address(fit));
        r.payFit{gas: 12_500_000 - 50_000}();
        vm.prank(address(platform));
        r.payPlatform{gas: 12_500_000 - 50_000}();
        vm.startPrank(ACTOR);
        assertEq(_priceBalance(p, address(fit)) - beforeP, owed, "FIT proceeds wait in Safe custody");
    }

    function _openTime(BoxCoordinatorV2 b) private {
        vm.warp(b.effectiveOpenAt() + 384);
        vm.roll(block.number + 1);
    }

    function _nativeTotal(BoxCoordinatorV2 b) private view returns (uint256) {
        return ACTOR.balance + RECIPIENT.balance + manager.balance + address(fit).balance + address(platform).balance
            + address(conversion).balance + address(b).balance + b.receiver().balance + b.launchRouter().balance
            + b.hook().balance + address(localSwapper).balance;
    }

    event SepoliaTransactionGas(address target, bytes4 selector, uint256 envelope, uint256 grossGas);

    function _transaction(address target, uint256 value, bytes memory data, uint256 envelope)
        private
        returns (bytes memory result)
    {
        uint256 budget = SepoliaV2Gas.callGas(envelope, data);
        SepoliaV2Gas.requireCallerGas(budget);
        bool ok;
        (ok, result) = target.call{value: value, gas: budget}(data);
        IVmFrameGasV2.Gas memory frame = IVmFrameGasV2(address(vm)).lastFrameGas();
        uint256 used = uint256(frame.gasTotalUsed);
        if (frame.gasStateUsed > 0) used += uint256(uint64(frame.gasStateUsed));
        if (!ok) {
            assembly ("memory-safe") { revert(add(result, 32), mload(result)) }
        }
        // Frame execution plus positive state charge; never subtract a state refund.
        uint256 gross = used + SepoliaV2Gas.intrinsic(data);
        assertLe(gross, envelope, "measured transaction exceeds its envelope");
        emit SepoliaTransactionGas(target, bytes4(data), envelope, gross);
    }

    function _returnStarter(IShopVaultV2 shop, uint256 index) private returns (uint256) {
        uint256[] memory page = new uint256[](1);
        page[0] = index;
        return abi.decode(
            _transaction(address(shop), 0, abi.encodeCall(shop.returnStarter, (page)), SepoliaV2Gas.RETURN_STARTER),
            (uint256)
        );
    }

    function _newBox(BoxSpec memory s) private returns (BoxCoordinatorV2) {
        bytes32 cs;
        bytes32 hs;
        address predicted;
        bytes32 initHash;
        for (uint256 i = ++serial * 100;; ++i) {
            address t;
            cs = bytes32(i);
            (predicted, t, initHash) = localFactory.predictBox(ACTOR, s, cs);
            if (t > s.pricing.token && t < localFactory.tokenAddressLimit(s.pricing.token)) break;
        }
        for (uint256 i;; ++i) {
            hs = bytes32(i);
            address h = BoxClones.predict(predicted, hs, initHash);
            if (uint160(h) & 0x3fff == 0x2ae0 && uint160(h) >> 152 != 0x91) break;
        }
        uint256 value = localFactory.boxQParameters(s.pricing.listingId, s.raise).bootstrapQ + s.creatorBuy;
        if (s.pricing.token != address(0)) {
            ERC20(s.pricing.token).approve{gas: 1_000_000 - 50_000}(address(localFactory), value);
            value = 0;
        }
        bytes memory data = abi.encodeCall(localFactory.createBox, (s, cs, hs));
        bytes memory result = _transaction(address(localFactory), value, data, SepoliaV2Gas.creationEnvelope(data));
        (, address c,) = abi.decode(result, (uint256, address, address));
        return BoxCoordinatorV2(c);
    }
}
