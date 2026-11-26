// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {M234Base} from "../../m2-34/Fixture.sol";
import {HolderModel} from "../../m2-00/HolderModel.sol";
import {HostileToken} from "../../kit/HostileToken.sol";
import {HostileCollection} from "../../kit/m2/ShopDoubles.sol";
import {PoolDriver} from "../../kit/BoxV2TestBase.sol";
import {BoxSpec, AddOn} from "../../../../src/box-v2/interfaces/SpecTypes.sol";
import {Branch} from "../../../../src/box-v2/interfaces/RecipeTypes.sol";
import {BoxTokenV2} from "../../../../src/box-v2/BoxTokenV2.sol";
import {BoxLayoutV2} from "../../../../src/box-v2/libraries/BoxLayoutV2.sol";
import {IBoxHookV2, TradeBatchV2} from "../../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {IBoxReceiverV2, FeeBatchV2} from "../../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {IHolderLedgerV2, IHolderTokenHistoryV2} from "../../../../src/box-v2/interfaces/IHolderLedgerV2.sol";
import {IShopVaultV2, IStarterSetLoaderV2} from "../../../../src/box-v2/interfaces/IShopVaultV2.sol";

/// M261: real factory/PM/box parts. The frozen oracle receives observed trade units and explicit T moves,
/// never production credit/history reads. External assets and the swap settlement actor are test fixtures.
abstract contract M261Harness is M234Base {
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    address internal constant SYSTEM = address(0x5157);
    HolderModel internal model;
    IHolderLedgerV2 internal ledger;
    uint8 internal buyChoice;
    uint8 internal sellChoice;
    uint256 internal nextBatch;
    uint256 internal nextPayout;
    uint256[2] internal carry;
    mapping(uint256 => uint256) internal paidTip;
    uint256 internal totalP;
    // Batch allocation can pass an unfinished seller. Model and claim each funded id once.
    mapping(uint256 => bool) internal settledBatch;
    mapping(uint256 => bool) internal paidBatch;

    function _m2Menu(uint8 buys, uint8 sells) internal view returns (BoxSpec memory s) {
        s = _menu(buys, sells);
        if (buys == 4) s.buyers.a = Branch(1, 6, "", abi.encode(uint8(1)));
        if (sells == 4) s.sellers.a = Branch(1, 6, "", abi.encode(uint8(1)));
    }

    // M2 admits TOKEN_ONLY, NEW_COLLECTION and SHOP. PILE and existing-NFT boxes are later milestones.
    function _open(uint8 kind, uint8 decimals, uint8 buys, uint8 sells) internal {
        BoxSpec memory s = kind == 1 ? _collectionSpec() : kind == 4
            ? _shop(address(new HostileCollection()), 0, 0, 100 ether) : _spec();
        BoxSpec memory choices = _m2Menu(buys, sells);
        s.buyers = choices.buyers; s.sellers = choices.sellers;
        s.creatorFeeRecipient = choices.creatorFeeRecipient;
        if (decimals != 0) {
            (BoxSpec memory priced,) = _priceSpec(3, 3, decimals);
            s.pricing = priced.pricing; s.raise = priced.raise;
        }
        s.creatorBuy = s.raise / 100;
        if (kind == 4) {
            box = _create(s); token = BoxTokenV2(box.token()); hook = IBoxHookV2(box.hook());
            receiver = IBoxReceiverV2(box.receiver()); layout = BoxLayoutV2.curve(s.raise, false);
            IShopVaultV2 shop = IShopVaultV2(box.vault());
            assertFalse(box.gateOpen()); assertEq(shop.budgetT(), 0);
            vm.prank(CREATOR); token.approve(address(shop), 100 ether);
            shop.fundSeed(); assertFalse(box.gateOpen());
            IStarterSetLoaderV2(box.starterSetLoader()).complete();
            assertTrue(box.gateOpen()); assertEq(shop.budgetT(), 100 ether);
            buyer = new PoolDriver(pm);
            if (decimals == 0) vm.deal(address(buyer), s.raise * 10);
            else HostileToken(box.q()).mint(address(buyer), s.raise * 10);
            vm.warp(box.effectiveOpenAt() + 384); vm.roll(block.number + 1);
        } else _start(s);
        buyChoice = buys; sellChoice = sells;
        ledger = IHolderLedgerV2(box.roleAddress(17));
        bool holders = buys == 4 || sells == 4;
        assertEq(address(ledger) != address(0), holders);
        assertEq(receiver.holderLedger(), address(ledger)); assertEq(hook.holderLedger(), address(ledger));
        nextBatch = 1; nextPayout = 1; carry = [uint256(0), 0];
        if (holders) {
            model = new HolderModel(SYSTEM);
            // Bootstrap is protocol, creator-buy notice precedes its first T receipt (zero eligible supply).
            for (uint256 id = 1; id <= 2; ++id) {
                TradeBatchV2 memory r = hook.tradeBatch(id);
                model.trade(id, r.protocolUnits, true, false);
                model.trade(id, r.tradeUnits, false, false);
            }
            model.move(SYSTEM, CREATOR, token.balanceOf(CREATOR), true);
        }
        totalP = _allP(); _assertState();
    }

    function _allP() internal view returns (uint256) { return _money() + _balance(ALICE) + _balance(BOB); }

    function _assertState() internal view {
        assertEq(_allP(), totalP, "M261: real P conservation after each action");
        _booked();
        if (address(ledger) == address(0)) return;
        address[4] memory holders = [CREATOR, ALICE, BOB, address(buyer)];
        IHolderTokenHistoryV2 history = IHolderTokenHistoryV2(address(token));
        uint256 checkpoint = history.holderCheckpoint();
        assertEq(history.eligibleSupplyAt(checkpoint), model.eligibleSupply(), "eligible supply vs moves");
        for (uint256 i; i < holders.length; ++i) {
            assertEq(token.balanceOf(holders[i]), model.balances(holders[i]), "T custody vs moves");
            assertEq(history.eligibleBalanceAt(holders[i], checkpoint),
                model.balanceAt(holders[i], model.checkpoint()), "eligibility vs independent history");
        }
        assertEq(history.eligibleBalanceAt(address(pm), checkpoint), 0);
        assertEq(history.eligibleBalanceAt(box.vault(), checkpoint), 0);
    }

    function _move(address from, address to, uint256 amount) internal {
        vm.prank(from); token.transfer(to, amount);
        if (address(ledger) != address(0)) model.move(from, to, amount, true);
        _assertState();
    }

    function _trade(bool buy, uint256 amount, bool notice) internal returns (uint256 received) {
        uint256 id = hook.currentTradeBatch(buy);
        TradeBatchV2 memory before = hook.tradeBatch(id);
        uint256 oldT = token.balanceOf(address(buyer));
        (, received) = buyer.swap(hook.poolKey(), buy, amount,
            buy ? (box.graduated() ? TickMath.MIN_SQRT_PRICE + 1 : layout.sqrtPriceEndX96)
                : (box.graduated() ? TickMath.MAX_SQRT_PRICE - 1 : layout.sqrtPriceStartX96));
        if (id != 0) {
            TradeBatchV2 memory after_ = hook.tradeBatch(id);
            // Model balances are still the pre-settlement state at the actual hook notice.
            model.trade(id, after_.tradeUnits - before.tradeUnits, false, notice);
            uint256 newT = token.balanceOf(address(buyer));
            if (newT > oldT) model.move(SYSTEM, address(buyer), newT - oldT, true);
            else model.move(address(buyer), SYSTEM, oldT - newT, true);
        }
        _assertState();
    }

    function _registerBuyer() internal {
        if (address(ledger) == address(0)) return;
        vm.prank(address(buyer)); ledger.register();
        vm.prank(address(buyer)); model.register();
        _assertState();
    }

    struct Buckets { uint256 fit; uint256 platform; uint256 keep; uint256 burn; uint256 pool; uint256 grow; }

    function _buckets() internal view returns (Buckets memory b) {
        b = Buckets(receiver.fitOwed(), receiver.platformOwed(), receiver.creatorP(),
            receiver.buyBackP(), receiver.poolHeldP(), receiver.growHeldP());
    }

    function _add(Buckets memory b, uint256 amount, uint8 choice, uint256 side, bool tradeSource) private {
        bool sourced = address(ledger) != address(0);
        uint256 gross = amount + (sourced ? 0 : carry[side]);
        uint256 unit = gross / 15;
        if (!sourced) carry[side] = gross % 15;
        b.fit += 2 * unit; b.platform += unit; b.pool += 2 * unit;
        if (choice == 1) b.keep += 10 * unit;
        if (choice == 2) b.burn += 10 * unit;
        if (choice == 3 || (choice == 4 && !tradeSource)) b.grow += 10 * unit;
    }

    /// Check every destination from independently split closed receipts; plain M1 retains side carry.
    function _collect(uint256 donation) internal {
        if (donation != 0) _gift(address(receiver), donation);
        Buckets memory expected = _buckets();
        FeeBatchV2 memory result = receiver.collect(address(0));
        assertEq(result.tip, 0);
        if (address(ledger) == address(0)) {
            _add(expected, result.buyersP, buyChoice, 0, true);
            _add(expected, result.sellersP, sellChoice, 1, true);
        } else {
            for (uint256 id = 1; id < hook.currentTradeBatch(true); ++id) {
                if (settledBatch[id] || !receiver.holderBatchClosed(id)) continue;
                _add(expected, hook.tradeBatch(id).netP, id % 2 == 1 ? buyChoice : sellChoice, id % 2 == 1 ? 0 : 1, true);
            }
            _add(expected, donation, buyChoice, 0, false);
        }
        if (box.graduated()) { expected.pool = 0; expected.grow = 0; }
        assertEq(abi.encode(_buckets()), abi.encode(expected), "M261: each fee destination");
        _fundAndSettle(); _assertState();
    }

    function _fundAndSettle() internal {
        if (address(ledger) == address(0)) return;
        uint256 end = hook.currentTradeBatch(true);
        for (uint256 id = 1; id < end; ++id) {
            TradeBatchV2 memory r = hook.tradeBatch(id);
            if (settledBatch[id] || !r.closed || !receiver.holderBatchClosed(id)) continue;
            settledBatch[id] = true;
            uint256 expected = (id % 2 == 1 ? buyChoice : sellChoice) == 4 ? 10 * ((r.netP - paidTip[id]) / 15) : 0;
            assertEq(receiver.holderBatchPaid(id), expected, "net source only; no cross-batch subsidy");
            model.close(id, expected);
            bool done;
            for (uint256 page; page < 128 && !done; ++page) {
                done = ledger.settleBatch(id, 3); model.settle(id, 3);
                if (!done) {
                    assertEq(ledger.claimable(id, CREATOR), 0);
                    vm.expectRevert(); ledger.flushResidue(id);
                }
            }
            assertTrue(done, "bounded settlement must finish");
            // The reference also enumerates ineligible contracts; production need not scan those zero rows.
            for (uint256 page; page < 128 && !model.finalized(id); ++page) model.settle(id, 3);
            assertTrue(model.finalized(id));
            _allocations(id);
        }
        while (nextBatch < end && settledBatch[nextBatch]) ++nextBatch;
    }

    function _allocations(uint256 id) internal view {
        address[4] memory holders = [CREATOR, ALICE, BOB, address(buyer)];
        uint256 sum;
        for (uint256 i; i < holders.length; ++i) {
            uint256 credit = ledger.claimable(id, holders[i]);
            assertEq(credit, model.credit(id, holders[i]), "M261: exact per-holder, per-batch allocation");
            sum += credit;
        }
        (,,, uint256 residue) = ledger.batchState(id);
        assertEq(residue, model.residue(id));
        assertEq(sum + residue, receiver.holderBatchPaid(id), "credits plus residue equal funding");
    }

    function _payouts() internal {
        if (address(ledger) == address(0)) return;
        address[4] memory holders = [CREATOR, ALICE, BOB, address(buyer)];
        uint256 end = hook.currentTradeBatch(true);
        for (uint256 id = 1; id < end; ++id) {
            if (!settledBatch[id] || paidBatch[id]) continue;
            paidBatch[id] = true;
            for (uint256 i; i < holders.length; ++i) {
                address who = holders[i]; uint256 credit = model.credit(id, who);
                if (credit == 0) continue;
                uint256 before = _balance(who);
                vm.expectRevert(); ledger.claim(id, who); // An unrelated caller cannot consume this credit.
                vm.prank(who); assertEq(ledger.claim(id, who), credit);
                vm.prank(who); assertEq(model.claim(id, who), credit);
                assertEq(_balance(who) - before, credit, "whole owner payout, no minimum or tip");
                vm.expectRevert(); vm.prank(who); ledger.claim(id, who);
                _assertState();
            }
            uint256 residue = model.flush(id);
            address destination = box.failed() ? address(receiver) : address(hook);
            uint256 beforeClaims = pm.balanceOf(destination, uint160(box.q()));
            assertEq(ledger.flushResidue(id), residue);
            assertEq(pm.balanceOf(destination, uint160(box.q())) - beforeClaims, residue);
            assertEq(ledger.flushResidue(id), 0);
        }
        while (nextPayout < end && paidBatch[nextPayout]) ++nextPayout;
        assertEq(pm.balanceOf(address(ledger), uint160(box.q())), 0, "all funded holder P has an exit");
        _assertState();
    }

    function _fillTracked() internal {
        for (uint256 i; i < 5 && !hook.closed(); ++i) _trade(true, box.raise() / 4, true);
        assertTrue(hook.closed());
    }

    function _royalty(uint256 amount) internal {
        address p = box.q();
        if (p == address(0)) receiver.fundRoyalty{value: amount}(address(0), amount);
        else {
            vm.prank(CREATOR); HostileToken(p).approve(address(receiver), amount);
            vm.prank(CREATOR); receiver.fundRoyalty(p, amount);
        }
        _assertState();
    }

    function _claimPot() internal {
        (uint256 pot, uint256 left) = box.claimState();
        uint256 fixedLeft = left;
        address[4] memory holders = [CREATOR, ALICE, BOB, address(buyer)];
        uint256 paid; uint256 handed;
        for (uint256 i; i < holders.length; ++i) {
            uint256 amount = token.balanceOf(holders[i]);
            if (amount == 0) continue;
            uint256 quote = box.quoteClaim(amount);
            vm.startPrank(holders[i]); token.approve(address(box), amount);
            uint256 p = box.claim(amount, holders[i]); vm.stopPrank();
            assertEq(p, quote); paid += p; handed += amount;
            if (address(ledger) != address(0)) model.move(holders[i], SYSTEM, amount, true);
            (, uint256 remaining) = box.claimState();
            assertEq(remaining, fixedLeft - handed, "fixed R40A count reduced only by claims");
            _assertState();
        }
        // These cases introduce no post-failure disposal and no unredeemed placeholders.
        assertEq(handed, fixedLeft); assertEq(paid, pot);
        (pot, left) = box.claimState(); assertEq(pot, 0); assertEq(left, 0);
    }

    function _idle() internal {
        Buckets memory before = _buckets();
        uint256 supply = token.totalSupply(); uint256 depth = hook.depthBudget();
        uint256 backing = pm.balanceOf(address(ledger), uint160(box.q()));
        vm.warp(vm.getBlockTimestamp() + 60 days);
        receiver.collect(address(0));
        assertEq(abi.encode(_buckets()), abi.encode(before), "60 idle days create no fees");
        assertEq(token.totalSupply(), supply); assertEq(hook.depthBudget(), depth);
        assertEq(pm.balanceOf(address(ledger), uint160(box.q())), backing);
        if (address(ledger) != address(0)) for (uint256 id = nextPayout; id < nextBatch; ++id) _allocations(id);
        _assertState();
    }

    function _life(uint8 kind, uint8 decimals, uint8 buys, uint8 sells, uint8 outcome, uint256 divisor) internal {
        _open(kind, decimals, buys, sells);
        _move(CREATOR, ALICE, token.balanceOf(CREATOR) / divisor);
        _trade(true, box.raise() / 10, true);
        _registerBuyer();
        _trade(false, token.balanceOf(address(buyer)) / divisor, true);
        _collect(17); _payouts();
        _move(ALICE, BOB, token.balanceOf(ALICE) / 2);
        _trade(true, box.raise() / 20, true);
        _move(BOB, ALICE, token.balanceOf(BOB));
        _trade(false, token.balanceOf(address(buyer)) / 7, true);
        _collect(14); // terminal dust never loans to the next source; M1 side carries stay separate.
        if (outcome == 0) {
            _fillTracked(); box.graduate(); assertTrue(box.graduated());
            _collect(0);
            _trade(true, box.raise() / 100, true);
            _trade(false, token.balanceOf(address(buyer)) / 11, true);
            _collect(0); _idle(); _payouts();
            uint256 keep = receiver.creatorP();
            address p = box.q();
            if (keep != 0) { vm.prank(CREATOR); assertEq(receiver.claimCreator(p, CREATOR), keep); }
            uint256 reward = box.rewardOf(address(this));
            if (reward != 0) assertEq(box.claimReward(address(this)), reward);
            vm.expectRevert(); box.fail();
        } else {
            if (outcome == 2) {
                _fillTracked(); uint256 filled = hook.closedAt();
                vm.warp(filled + 7 days - 1); vm.expectRevert(); box.fail();
                assertFalse(box.failed()); assertEq(hook.closedAt(), filled);
                vm.warp(filled + 7 days);
            } else vm.warp(box.deadline());
            box.fail(); assertTrue(box.failed());
            if (address(ledger) != address(0)) model.fail();
            _fundAndSettle(); _claimPot();
            if (kind == 4) {
                uint256 held = token.balanceOf(box.vault()); uint256 supply = token.totalSupply();
                assertEq(IShopVaultV2(box.vault()).burnFailedT(), held);
                assertEq(token.totalSupply(), supply - held); assertEq(token.balanceOf(box.vault()), 0);
                assertEq(token.balanceOf(CREATOR), 0, "excluded seed never returns as claimable T");
            }
            _idle(); _payouts();
            receiver.collect(address(0));
            uint256 owed = receiver.fitOwed();
            (uint256 latePot,) = box.claimState();
            _gift(address(receiver), 31); receiver.collect(address(0));
            _royalty(47); assertEq(receiver.fitOwed(), owed, "late P earns no FIT share");
            (uint256 afterLatePot,) = box.claimState();
            assertEq(afterLatePot, latePot + 78, "late P entirely in pot");
            vm.expectRevert(); box.graduate();
        }
        uint256 fit = receiver.fitOwed(); vm.prank(fitSafe); assertEq(receiver.payFit(), fit);
        uint256 platform = receiver.platformOwed(); assertEq(receiver.payPlatform(), platform);
        _assertState();
    }
}
