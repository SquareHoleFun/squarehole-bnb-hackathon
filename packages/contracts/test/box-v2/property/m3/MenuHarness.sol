// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {NoFailureSweep} from "../../rc5-a/NoFailureSweep.sol";

import {M340Base} from "../../m3-40/Fixture.sol";
import {M332ModelJournal} from "../../m3-32/ModelJournal.sol";
import {HolderModel} from "../../m2-00/HolderModel.sol";
import {ItemModel} from "../../m3-00/ItemModel.sol";
import {ItemHistoryModel} from "../../m3-00/ItemHistoryModel.sol";
import {ItemKit} from "../../kit/m3/ItemKit.sol";
import {HostileToken} from "../../kit/HostileToken.sol";
import {HostileCollection} from "../../kit/m2/ShopDoubles.sol";
import {PoolDriver} from "../../kit/BoxV2TestBase.sol";
import {MockDrandSource, SparseBoxTree} from "../../../box/items/BoxItemsKit.sol";
import {BoxSpec, AddOn} from "../../../../src/box-v2/interfaces/SpecTypes.sol";
import {Side, Branch} from "../../../../src/box-v2/interfaces/RecipeTypes.sol";
import {IBoxReceiverV2, IBoxReceiverItemsV2, ItemFundingV2, FeeBatchV2} from "../../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {IBoxHookV2, TradeBatchV2} from "../../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {IBoxVaultItemsV2} from "../../../../src/box-v2/interfaces/IBoxVaultV2.sol";
import {IItemLedgerV2} from "../../../../src/box-v2/interfaces/IItemLedgerV2.sol";
import {IHolderLedgerV2} from "../../../../src/box-v2/interfaces/IHolderLedgerV2.sol";
import {IShopVaultV2, IStarterSetLoaderV2, ShopConfigV2} from "../../../../src/box-v2/interfaces/IShopVaultV2.sol";
import {BoxTokenV2} from "../../../../src/box-v2/BoxTokenV2.sol";
import {PileVaultV2} from "../../../../src/box-v2/PileVaultV2.sol";
import {BoxLayoutV2} from "../../../../src/box-v2/libraries/BoxLayoutV2.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";

/// @dev M361: default production money/custody parts; only M340's named S6 hook/checker handoffs are doubles.
abstract contract M361Harness is M340Base {
    address internal constant ALICE = address(0xA361);
    address internal constant BOB = address(0xB361);
    address internal constant SYSTEM = address(0x51361);
    IHolderLedgerV2 internal holders;
    HolderModel internal holderModel;
    IItemLedgerV2 internal items;
    ItemModel internal itemModel;
    M332ModelJournal internal journal;
    uint8 internal buys;
    uint8 internal sells;
    uint256 internal nextBatch;
    uint256 internal totalP;
    uint256 internal itemPaid;
    uint256 internal itemFlushed;
    uint256[2] internal carry;
    uint256[2] internal heldBySide;
    bytes32[] internal ticketKeys;

    // 5/6 encode the SAME fifth choice with Keep/Burn respectively, never a sixth fee choice.
    function _menuSide(uint8 choice) internal pure returns (Side memory s) {
        s = _side(choice);
        if (choice == 4) s.a = Branch(1, 6, "", abi.encode(uint8(1)));
        if (choice >= 5) s.a = Branch(1, 8, "", abi.encode(uint8(choice - 4)));
    }

    function _caseSpec(uint8 kind, uint8 decimals, uint8 b, uint8 s) internal returns (BoxSpec memory spec) {
        spec = kind == 1 ? _hiddenSpec() : _spec();
        spec.boxType = kind;
        if (kind == 1) {
            spec.n = 10; spec.firstId = 1;
            (uint256[] memory positions, bytes32[] memory leaves) = _tree();
            spec.revealRoot = SparseBoxTree.root(4, positions, leaves);
        }
        if (kind == 4) {
            ShopConfigV2 memory cfg;
            cfg.givePricesT = [uint256(1 ether), 2 ether, 4 ether, 8 ether];
            cfg.pickBps = 15000; cfg.weeklyBps = 1000; cfg.collectionBps = 250;
            // Exact admission boundary: the 2.5% collection allowance can pay one cheapest give.
            cfg.seedT = 40 ether;
            cfg.listDelay = 7 days; cfg.curator = CREATOR;
            cfg.collections = new address[](1); cfg.collections[0] = address(new HostileCollection());
            cfg.tiers = new uint8[](1);
            spec.contentsParams = abi.encode(cfg);
            spec.addOns = new AddOn[](2); spec.addOns[0] = AddOn(7, "");
            spec.addOns[1] = AddOn(8, abi.encode(bytes32(0), uint32(0)));
        }
        if (decimals != 0) {
            (BoxSpec memory priced,) = _priceSpec(3, 3, decimals);
            spec.pricing = priced.pricing; spec.raise = priced.raise;
        }
        if (kind == 5) {
            spec.contentsParams = abi.encode(spec.pricing.token, spec.raise * 2);
            if (decimals != 0) HostileToken(spec.pricing.token).mint(CREATOR, spec.raise * 2);
        }
        spec.buyers = _menuSide(b); spec.sellers = _menuSide(s);
        bool royalties;
        for (uint256 i; i < spec.addOns.length; i++) if (spec.addOns[i].id == 4) royalties = true;
        spec.creatorFeeRecipient = b == 1 || s == 1 || royalties ? CREATOR : address(0);
        spec.creatorBuy = spec.raise / 100;
    }

    function _open(uint8 kind, uint8 decimals, uint8 b, uint8 s) internal {
        BoxSpec memory spec = _caseSpec(kind, decimals, b, s);
        if (kind != 4 && kind != 5) _start(spec);
        else {
            box = _create(spec);
            token = BoxTokenV2(box.token()); hook = IBoxHookV2(box.hook()); receiver = IBoxReceiverV2(box.receiver());
            assertFalse(box.gateOpen());
            if (kind == 4) {
                IShopVaultV2 shop = IShopVaultV2(box.vault());
                IStarterSetLoaderV2 loader = IStarterSetLoaderV2(box.starterSetLoader());
                uint256 seed = abi.decode(spec.contentsParams, (ShopConfigV2)).seedT;
                uint256 beforeT = token.balanceOf(CREATOR);
                assertFalse(shop.seedReady()); assertEq(shop.budgetT(), 0);
                vm.expectRevert(); loader.complete();
                vm.prank(CREATOR); token.approve(address(shop), seed);
                vm.prank(BOB); shop.fundSeed();
                assertEq(beforeT - token.balanceOf(CREATOR), seed);
                assertEq(token.balanceOf(address(shop)), seed); assertEq(shop.budgetT(), seed);
                assertTrue(shop.seedReady()); assertFalse(box.gateOpen());
                vm.prank(BOB); loader.complete();
            } else {
                PileVaultV2 pile = PileVaultV2(payable(box.vault()));
                uint256 before = _rawBalance(spec.pricing.token, CREATOR);
                if (decimals == 0) { vm.prank(CREATOR); pile.loadSeed{value: spec.raise * 2}(); }
                else {
                    vm.prank(CREATOR); HostileToken(spec.pricing.token).approve(address(pile), spec.raise * 2);
                    vm.prank(BOB); pile.loadSeed();
                }
                assertEq(before - _rawBalance(spec.pricing.token, CREATOR), spec.raise * 2);
            }
            assertTrue(box.gateOpen());
            layout = BoxLayoutV2.curve(spec.raise, false); buyer = new PoolDriver(pm);
            if (decimals == 0) vm.deal(address(buyer), spec.raise * 10);
            else HostileToken(spec.pricing.token).mint(address(buyer), spec.raise * 10);
            vm.warp(box.effectiveOpenAt() + 384); vm.roll(block.number + 1);
        }
        buys = b; sells = s; nextBatch = 1;
        holders = IHolderLedgerV2(box.roleAddress(17)); items = IItemLedgerV2(box.roleAddress(16));
        assertEq(address(holders) != address(0), b == 4 || s == 4);
        assertEq(address(items) != address(0), b >= 5 || s >= 5);
        assertEq(receiver.holderLedger(), address(holders)); assertEq(receiver.itemLedger(), address(items));
        if (address(holders) != address(0)) {
            holderModel = new HolderModel(SYSTEM);
            for (uint256 id = 1; id <= 2; ++id) {
                TradeBatchV2 memory r = hook.tradeBatch(id);
                holderModel.trade(id, r.protocolUnits, true, false);
                holderModel.trade(id, r.tradeUnits, false, false);
            }
            _trackT();
        }
        if (address(items) != address(0)) {
            journal = new M332ModelJournal(box.vault(), address(receiver), address(items));
            itemModel = new ItemModel(ItemHistoryModel(address(journal)));
        }
        totalP = _allP(); _state();
    }

    function _rawBalance(address asset, address who) internal view returns (uint256) {
        return asset == address(0) ? who.balance : HostileToken(asset).balanceOf(who);
    }
    function _allP() internal view returns (uint256) {
        return _money() + _balance(ALICE) + _balance(BOB) + (box.vault() == address(0) ? 0 : _balance(box.vault()));
    }
    function _accounts() internal view returns (address[4] memory) { return [CREATOR, ALICE, BOB, address(buyer)]; }
    // Observe actual T settlement deltas, never production eligibility/credit reads. No trade occurs between moves.
    function _trackT() internal {
        if (address(holders) == address(0)) return;
        address[4] memory accounts = _accounts();
        for (uint256 i; i < accounts.length; ++i) {
            uint256 actual = token.balanceOf(accounts[i]); uint256 old = holderModel.balances(accounts[i]);
            if (actual > old) holderModel.move(SYSTEM, accounts[i], actual - old, true);
            if (old > actual) holderModel.move(accounts[i], SYSTEM, old - actual, true);
        }
    }
    function _state() internal view { assertEq(_allP(), totalP, "M361: real P conserved"); _booked(); }
    function _trade(bool buy, uint256 amount) internal {
        uint256 id = hook.currentTradeBatch(buy); TradeBatchV2 memory before = hook.tradeBatch(id);
        buyer.swap(hook.poolKey(), buy, amount,
            buy ? (box.graduated() ? TickMath.MIN_SQRT_PRICE + 1 : layout.sqrtPriceEndX96)
                : (box.graduated() ? TickMath.MAX_SQRT_PRICE - 1 : layout.sqrtPriceStartX96));
        if (address(holders) != address(0)) {
            holderModel.trade(id, hook.tradeBatch(id).tradeUnits - before.tradeUnits, false, true);
            _trackT();
        }
        if (!buy && box.graduated()) _sellFeeP();
        _state();
    }
    function _fillTracked() internal {
        for (uint256 i; i < 5 && !hook.closed(); ++i) _trade(true, box.raise() / 4);
        assertTrue(hook.closed());
    }

    struct Buckets { uint256 fit; uint256 platform; uint256 keep; uint256 burn; uint256 pool; uint256 grow; uint256 held; }
    function _buckets() internal view returns (Buckets memory) {
        return Buckets(receiver.fitOwed(), receiver.platformOwed(), receiver.creatorP(), receiver.buyBackP(),
            receiver.poolHeldP(), receiver.growHeldP(), receiver.itemsHeldP());
    }
    function _add(Buckets memory b, uint256 amount, uint8 choice, uint256 side, bool tradeSource) private {
        bool sourced = address(holders) != address(0) || address(items) != address(0);
        uint256 gross = amount + (sourced ? 0 : carry[side]); uint256 u = gross / 15;
        if (!sourced) carry[side] = gross % 15;
        b.fit += 2*u; b.platform += u; b.pool += 2*u;
        if (choice == 1) b.keep += 10*u;
        if (choice == 2) b.burn += 10*u;
        if (choice == 3 || (choice == 4 && !tradeSource)) b.grow += 10*u;
        if (choice >= 5) {
            if (!box.graduated()) { b.held += 10*u; heldBySide[side] += 10*u; }
            else if (choice == 6) {
                // All items remain inside in the menu matrix. Lifecycle suites check historical counts separately.
                uint256 inside = IBoxVaultItemsV2(box.vault()).itemLifecycleCount();
                assertEq(inside, 0, "bucket helper only for untouched custody");
                b.burn += (10*u / journal.n()) * journal.n();
            }
        }
    }
    function _collect(uint256 donation) internal {
        if (donation != 0) _gift(address(receiver), donation);
        Buckets memory expected = _buckets();
        uint256 receiptStart = IBoxReceiverItemsV2(address(receiver)).itemFundingCount();
        FeeBatchV2 memory result = receiver.collect(address(0)); assertEq(result.tip, 0);
        if (address(holders) == address(0) && address(items) == address(0)) {
            _add(expected, result.buyersP, buys, 0, true); _add(expected, result.sellersP, sells, 1, true);
        } else {
            for (uint256 id = nextBatch; id < hook.currentTradeBatch(true); ++id)
                _add(expected, hook.tradeBatch(id).netP, id % 2 == 1 ? buys : sells, id % 2 == 1 ? 0 : 1, true);
            _add(expected, donation, buys, 0, false);
        }
        if (box.graduated()) { expected.pool = 0; expected.grow = 0; }
        assertEq(abi.encode(_buckets()), abi.encode(expected), "M361: exact receiver destinations");
        for (uint256 id = receiptStart + 1; id <= IBoxReceiverItemsV2(address(receiver)).itemFundingCount(); ++id) {
            ItemFundingV2 memory r = IBoxReceiverItemsV2(address(receiver)).itemFunding(id);
            assertTrue(r.source == 1 || r.source == 2);
            uint256 gross = r.source == 1 ? hook.tradeBatch(r.batchId).netP : donation;
            assertEq(r.choiceP, 10 * (gross / 15), "independent net Items source allocation");
            if (r.source == 1) assertEq(r.side, r.batchId % 2 == 1 ? 1 : 2);
            else { assertEq(r.side, 1); assertEq(r.batchId, 0); }
        }
        _settleHolders(); _compareItems(3); _state();
    }

    function _graduationReceipts() internal view {
        uint256 count = IBoxReceiverItemsV2(address(receiver)).itemFundingCount();
        assertEq(count, (buys >= 5 ? 1 : 0) + (sells >= 5 ? 1 : 0));
        for (uint256 id = 1; id <= count; ++id) {
            ItemFundingV2 memory r = IBoxReceiverItemsV2(address(receiver)).itemFunding(id);
            assertEq(r.source, 3); assertEq(r.batchId, 0);
            assertEq(r.choiceP, heldBySide[r.side - 1]);
            assertEq(r.ledgerP, (r.side == 1 ? buys : sells) == 5 ? r.choiceP : 0);
        }
    }

    function _settleHolders() internal {
        uint256 end = hook.currentTradeBatch(true);
        if (address(holders) != address(0)) for (uint256 id = nextBatch; id < end; ++id) {
            TradeBatchV2 memory r = hook.tradeBatch(id); assertTrue(r.closed);
            uint256 funding = (id % 2 == 1 ? buys : sells) == 4 ? 10 * (r.netP / 15) : 0;
            assertTrue(receiver.holderBatchClosed(id)); assertEq(receiver.holderBatchPaid(id), funding);
            holderModel.close(id, funding);
            bool done;
            for (uint256 page; page < 128 && !done; ++page) done = holders.settleBatch(id, 3);
            assertTrue(done);
            for (uint256 page; page < 128 && !holderModel.finalized(id); ++page) holderModel.settle(id, 3);
            assertTrue(holderModel.finalized(id));
            address[4] memory accounts = _accounts(); uint256 sum;
            for (uint256 i; i < accounts.length; ++i) {
                uint256 p = holders.claimable(id, accounts[i]);
                assertEq(p, holderModel.credit(id, accounts[i]), "each holder, each batch"); sum += p;
                if (p == 0) continue;
                uint256 before = _balance(accounts[i]);
                vm.prank(accounts[i]); assertEq(holders.claim(id, accounts[i]), p);
                vm.prank(accounts[i]); assertEq(holderModel.claim(id, accounts[i]), p);
                assertEq(_balance(accounts[i]) - before, p);
            }
            (,,, uint256 residue) = holders.batchState(id);
            assertEq(residue, holderModel.residue(id)); assertEq(sum + residue, funding);
            assertEq(holders.flushResidue(id), holderModel.flush(id));
        }
        nextBatch = end;
    }

    function _compareItems(uint256 page) internal {
        if (address(items) == address(0)) return;
        uint256 fEnd = journal.itemFundingCount(); uint256 lEnd = journal.itemLifecycleCount();
        for (uint256 i; i < fEnd + lEnd + 1; ++i) {
            uint256 f = items.fundingCursor(); uint256 l = items.lifecycleCursor();
            items.sync(page); itemModel.sync(page);
            assertLe(items.fundingCursor() - f, page); assertLe(items.lifecycleCursor() - l, page);
            if (items.fundingCursor() == fEnd && items.lifecycleCursor() == lEnd) break;
        }
        assertEq(items.fundingCursor(), fEnd); assertEq(items.lifecycleCursor(), lEnd);
        ItemKit.compare(itemModel, items, 1, journal.n(), ticketKeys);
        assertEq(pm.balanceOf(address(items), uint160(box.q())) + itemPaid + itemFlushed, journal.ledgerTransferred());
    }
    function _tree() internal pure returns (uint256[] memory positions, bytes32[] memory leaves) {
        positions = new uint256[](10); leaves = new bytes32[](10);
        for (uint256 i; i < 10; ++i) {
            positions[i] = i; leaves[i] = SparseBoxTree.leaf(i + 1, 0, bytes32(i + 1), 0, 0, 0);
        }
    }

    function _royalty(uint256 amount) internal {
        address p = box.q();
        if (p == address(0)) receiver.fundRoyalty{value: amount}(p, amount);
        else { vm.prank(CREATOR); HostileToken(p).approve(address(receiver), amount);
            vm.prank(CREATOR); receiver.fundRoyalty(p, amount); }
        _state();
    }
    function _payoutSafes() internal {
        uint256 fit = receiver.fitOwed(); uint256 platform = receiver.platformOwed();
        vm.prank(fitSafe); assertEq(receiver.payFit(), fit);
        assertEq(receiver.payPlatform(), platform); _state();
    }
    function _claimPot() internal {
        (uint256 pot, uint256 left) = box.claimState(); uint256 paid; uint256 handed;
        address[4] memory accounts = _accounts();
        for (uint256 i; i < accounts.length; ++i) {
            uint256 t = token.balanceOf(accounts[i]); if (t == 0) continue;
            uint256 quote = box.quoteClaim(t); uint256 before = _balance(accounts[i]);
            vm.startPrank(accounts[i]); token.approve(address(box), t);
            assertEq(box.claim(t, accounts[i]), quote); vm.stopPrank();
            assertEq(_balance(accounts[i]) - before, quote); paid += quote; handed += t;
            (, uint256 count) = box.claimState(); assertEq(count, left - handed);
        }
        assertEq(handed, left); assertEq(paid, pot); _trackT(); _state();
    }
    function _redeemPile() internal {
        PileVaultV2 pile = PileVaultV2(payable(box.vault()));
        uint256 seedBefore = _balance(address(pile));
        address[2] memory accounts = [CREATOR, address(buyer)]; uint256 total;
        for (uint256 i; i < accounts.length; ++i) {
            uint256 t = token.balanceOf(accounts[i]) / 2; uint256 supply = token.totalSupply();
            uint256 p = FullMath.mulDiv(_balance(address(pile)), t, supply);
            assertEq(pile.quoteRedeem(t), p); uint256 before = _balance(accounts[i]);
            vm.startPrank(accounts[i]); token.approve(address(pile), t);
            assertEq(pile.redeem(t, p, accounts[i]), p); vm.stopPrank();
            assertEq(_balance(accounts[i]) - before, p); assertEq(token.totalSupply(), supply - t); total += p;
        }
        assertEq(_balance(address(pile)) + total, seedBefore); _trackT(); _state();
    }
    function _life(uint8 kind, uint8 decimals, uint8 b, uint8 s, uint8 outcome) internal {
        _open(kind, decimals, b, s);
        _trade(true, box.raise() / 10);
        if (address(holders) != address(0)) {
            vm.prank(address(buyer)); holders.register(); vm.prank(address(buyer)); holderModel.register();
        }
        _trade(false, token.balanceOf(address(buyer)) / 9); _collect(17);
        uint256 giftT = token.balanceOf(CREATOR) / 3;
        vm.prank(CREATOR); token.transfer(ALICE, giftT); _trackT();
        _trade(true, box.raise() / 20); _trade(false, token.balanceOf(address(buyer)) / 11); _collect(14);
        if (outcome == 0) {
            _fillTracked(); _collect(0); box.graduate(); receiver.collect(address(0)); _graduationReceipts();
            _settleHolders(); _compareItems(1); _trackT(); _state();
            _trade(true, box.raise() / 100); _trade(false, token.balanceOf(address(buyer)) / 17); _collect(0);
            _royalty(1501); _compareItems(2);
            if (kind == 5) _redeemPile();
            uint256 keep = receiver.creatorP(); address p = box.q();
            if (keep != 0) { vm.prank(CREATOR); assertEq(receiver.claimCreator(p, CREATOR), keep); }
            if (box.rewardOf(address(this)) != 0) box.claimReward(address(this));
            vm.expectRevert(); box.fail();
        } else {
            if (outcome == 2) {
                _fillTracked(); uint256 filled = hook.closedAt();
                vm.warp(filled + 7 days - 1); vm.expectRevert(); box.fail();
                assertFalse(box.failed()); assertEq(hook.closedAt(), filled); vm.warp(filled + 7 days);
            } else vm.warp(box.deadline());
            box.fail(); assertTrue(box.failed());
            if (address(holders) != address(0)) holderModel.fail();
            _trackT(); _settleHolders(); _claimPot();
            assertEq(IBoxReceiverItemsV2(address(receiver)).itemFundingCount(), 0);
            assertEq(receiver.itemsHeldP(), 0);
            if (kind == 5) {
                uint256 seed = _balance(box.vault()); uint256 before = _balance(CREATOR);
                assertEq(PileVaultV2(payable(box.vault())).returnSeed(), seed); assertEq(_balance(CREATOR) - before, seed);
            }
            // Holder residue was just returned as unbooked P; book it before measuring new late money.
            receiver.collect(address(0));
            uint256 fit = receiver.fitOwed(); _gift(address(box), 31);
            NoFailureSweep.check(address(box)); _royalty(47);
            assertEq(receiver.fitOwed(), fit); vm.expectRevert(); box.graduate();
        }
        _payoutSafes(); _compareItems(3); _state();
    }
}
