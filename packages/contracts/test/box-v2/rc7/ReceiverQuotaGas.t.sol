// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {IHolderTokenHistoryV2} from "../../../src/box-v2/interfaces/IHolderLedgerV2.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {ShopFeesTest, ShopFees, ShopReceiver} from "../shop-fees/ShopFees.t.sol";
import {BoxSpec} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {Branch} from "../../../src/box-v2/interfaces/RecipeTypes.sol";
import {FeeBatchV2} from "../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {HolderLedgerV2} from "../../../src/box-v2/HolderLedgerV2.sol";
import {ReceiverDeploy} from "../fee-modules/ReceiverDeploy.sol";
import {HostileToken} from "../kit/HostileToken.sol";
import {ReceiverShopV21} from "../../../src/box-v2/libraries/ReceiverShopV21.sol";
import {GasBudget} from "../gas/GasBudget.sol";

/// Exact allocation-bound fixture on factory-created boxes, real hook/PM/receiver/ledger and linked libraries.
/// Journal entries are seeded (no mocked calls) to put both sides' N sub-unit sources ahead of two valued sources.
/// Real trading/cursor progress is covered separately by KeeperCursorRule. Slot reads assert the seeded hook state.
contract ReceiverQuotaGasTest is ShopFeesTest {
    uint256 private constant PASSES = 5;
    address private constant TIP_TO = address(0xBEEF);
    // The first seven are af1's menus; the next three exercise native/ERC-20 item funding.
    // Part 3 review: the last four pay items on the buyers' side and holders on the sellers' side, so every buyer
    // source pays its item funding AND writes its holder-batch record before the second tip's admission check.
    enum Menu { HoldersP, HoldersT, HoldersTErc20, ShopP, ShopPErc20, ShopT, ShopTErc20,
        ItemsKeep, ItemsBurn, ItemsKeepErc20, ItemsKeepHoldersT, ItemsBurnHoldersT, ItemsBurnErc20HoldersT, ItemsBurnHoldersP }
    uint256 private constant FRESH_SLOT_MARGIN = 107_920;
    bool private selfTip;
    bool private untipped; // collect(address(0)): the Sepolia runbook's direct, untipped call
    bool private oneTip; // release review GK-2: the second valued buyer source closed with zero P

    uint256 private first;
    uint256 private value;

    function _openBound(bool shopBox, bool holdersT, bool erc20) private {
        _openBound(shopBox, holdersT, erc20, 0);
    }
    function _openBound(bool shopBox, bool holdersT, bool erc20, uint8 itemPolicy) private {
        _openBound(shopBox, holdersT, erc20, itemPolicy, 0);
    }
    /// sellersHolders: 0 keeps the menu's sellers; 1 (holders P) or 2 (holders T) replaces an item box's sellers.
    function _openBound(bool shopBox, bool holdersT, bool erc20, uint8 itemPolicy, uint8 sellersHolders) private {
        BoxSpec memory s = itemPolicy != 0 ? _items(itemPolicy, itemPolicy) : shopBox ? _shopSpec(2) : _spec();
        if (sellersHolders != 0) s.sellers.a = Branch(sellersHolders, 6, "", abi.encode(sellersHolders));
        if (erc20) {
            (BoxSpec memory priced,) = _priceSpec(3, 3, 18);
            s.pricing = priced.pricing; s.raise = priced.raise; s.creatorBuy = s.raise / 100;
        }
        if (itemPolicy == 0) {
            s.buyers.a = Branch(holdersT ? 2 : 1, 6, "", abi.encode(uint8(holdersT ? 2 : 1)));
            if (!shopBox) s.sellers.a = s.buyers.a;
        }
        if (shopBox) { _startShop(s); assertTrue(ShopFees(address(shop)).feesWanted()); }
        else _start(s);
        if (erc20) HostileToken(box.q()).mint(address(buyer), s.raise * 10);
        _fill(); box.graduate(); receiver.collect(address(0));
        // Each buyer source meets BATCH_MIN_Q but pays only a small fraction of the shared TIP_MAX_Q.
        value = factory.boxQParameters(s.pricing.listingId, box.raise()).batchMinQ;
        // Native tips also cover first payment to an empty account; ERC-20 balance starts at zero.
        vm.deal(TIP_TO, 0);
        first = hook.currentTradeBatch(true);
        assertEq(uint256(vm.load(address(hook), bytes32(uint256(7)))) * 2 + 1, first);
    }

    function _journal(uint256 passes, uint256 dust, bool buyersPass, bool sellersPass) private returns (uint256 end) {
        uint256 total;
        uint256 count = passes + 2;
        for (uint256 i; i < count; ++i) {
            for (uint256 side; side < 2; ++side) {
                uint256 id = first + i * 2 + side;
                uint256 sidePasses = (side == 0 ? buyersPass : sellersPass) ? passes : 0;
                uint256 amount = i < sidePasses ? dust : i < sidePasses + 2 ? value : 0;
                if (oneTip && side == 0 && i == sidePasses + 1) amount = 0;
                bytes32 base = keccak256(abi.encode(id, uint256(8)));
                vm.store(address(hook), bytes32(uint256(base) + 2), bytes32(amount));
                vm.store(address(hook), bytes32(uint256(base) + 3), bytes32(uint256(1)));
                assertEq(hook.tradeBatch(id).netP, amount); assertTrue(hook.tradeBatch(id).closed);
                total += amount;
            }
        }
        end = first + 2 * count;
        vm.store(address(hook), bytes32(uint256(7)), bytes32((end - 1) / 2));
        uint256 beforeTotal = hook.tradeBatchTotalP();
        vm.store(address(hook), bytes32(uint256(14)), bytes32(beforeTotal + total));
        assertEq(hook.tradeBatchTotalP(), beforeTotal + total);
        _gift(address(receiver), total);
    }

    function _cold() private {
        ReceiverDeploy.cool(release.implementations[5]);
        address[24] memory parts;
        address price = box.q();
        for (uint256 i; i < 24; ++i) parts[i] = box.roleAddress(i);
        for (uint256 i; i < 24; ++i) {
            if (parts[i] != address(0)) vm.cool(parts[i]);
            address implementation = release.implementations[i]; if (implementation != address(0)) vm.cool(implementation);
        }
        vm.cool(address(ReceiverShopV21)); vm.cool(price); vm.cool(address(pm)); vm.cool(TIP_TO);
    }
    function _measure(uint256 budget) private returns (uint256 used, FeeBatchV2 memory result) {
        bytes memory data = abi.encodeWithSignature("collect(address)", TIP_TO);
        address target = address(receiver);
        uint256 intrinsic = GasBudget.intrinsic(data);
        _cold(); uint256 beforeGas = gasleft();
        (bool ok, bytes memory ret) = target.call{gas: budget - intrinsic}(data);
        used = GasBudget.transaction(beforeGas - gasleft(), data);
        if (!ok) assembly ("memory-safe") { revert(add(ret, 32), mload(ret)) }
        result = abi.decode(ret, (FeeBatchV2));
    }
    function _amsterdam() private returns (bool) {
        bytes memory init = hex"6104006000f3";
        uint256 beforeGas = gasleft();
        assembly ("memory-safe") { pop(create(0, add(init, 32), mload(init))) }
        return beforeGas - gasleft() > 500_000;
    }
    function _pin(Menu menu, bool funded, bool amsterdam) private pure returns (uint256) {
        // Columns are empty/funded recipients; order matches Menu. Least transaction gas, not gasUsed.
        if (amsterdam) {
            if (funded) return [uint256(5_377_142), 5_392_135, 5_428_175, 5_382_250, 5_418_289,
                5_397_243, 5_433_283, 4_948_018, 4_958_676, 4_984_057,
                5_661_081, 5_671_738, 5_707_778, 5_669_320][uint256(menu)];
            return [uint256(5_569_610), 5_584_603, 5_529_228, 5_574_718, 5_519_343,
                5_589_711, 5_534_336, 5_140_486, 5_151_143, 5_085_111,
                5_853_548, 5_864_206, 5_808_831, 5_861_787][uint256(menu)];
        }
        if (funded) return [uint256(3_805_252), 3_796_560, 3_819_700, 3_810_360, 3_833_499,
            3_801_668, 3_824_807, 3_724_717, 3_727_944, 3_747_856,
            3_892_141, 3_895_368, 3_918_507, 3_892_949][uint256(menu)];
        return [uint256(3_833_632), 3_824_941, 3_837_347, 3_838_740, 3_851_147,
            3_830_048, 3_842_455, 3_753_096, 3_756_323, 3_765_503,
            3_920_521, 3_923_747, 3_936_154, 3_921_329][uint256(menu)];
    }

    // All trials forward exactly transaction gas less intrinsic gas. The same _cold() resets account AND
    // storage warmth after each snapshot restore. Abundant outer gas prevents EIP-150 clipping the trial.
    function _tryCollect(uint256 budget) private returns (bool ok, bytes memory ret) {
        bytes memory data = abi.encodeWithSignature("collect(address)", untipped ? address(0) : TIP_TO);
        uint256 execution = budget - GasBudget.intrinsic(data);
        address target = address(receiver);
        _cold();
        // A funded keeper tips itself. A truly empty native account must be a separate recipient:
        // impersonating it as caller would make it exist before the first tip and erase account-creation cost.
        if (selfTip) vm.prank(TIP_TO);
        return target.call{gas: execution}(data);
    }
    function _sameResult(bytes memory ret, FeeBatchV2 memory expected, uint256 end) private view {
        FeeBatchV2 memory actual = abi.decode(ret, (FeeBatchV2));
        assertEq(actual.tip, expected.tip, "both tips returned exactly");
        assertEq(actual.buyersP, expected.buyersP, "buyers returned exactly");
        assertEq(actual.sellersP, expected.sellersP, "sellers returned exactly");
        assertEq(uint256(vm.load(address(receiver), bytes32(uint256(20)))), end - 2);
        assertEq(uint256(vm.load(address(receiver), bytes32(uint256(41)))), end - 1);
    }
    function _probe(uint256 end, bool amsterdam) private returns (uint256 least) {
        uint256 snap = vm.snapshotState();
        (bool ok, bytes memory ret) = _tryCollect(15_000_000);
        assertTrue(ok, "unrestricted collect succeeds");
        FeeBatchV2 memory expected = abi.decode(ret, (FeeBatchV2));
        assertEq(expected.tip, 2 * (value / 20), "both valued buyers pay their tip");
        _sameResult(ret, expected, end);
        // No successes are assumed from gasUsed.
        uint256 low = GasBudget.intrinsic(abi.encodeWithSignature("collect(address)", TIP_TO));
        uint256 high = 15_000_000;
        while (low + 1 < high) {
            assertTrue(vm.revertToState(snap));
            uint256 mid = (low + high) / 2;
            (ok, ret) = _tryCollect(mid);
            if (ok) { _sameResult(ret, expected, end); high = mid; }
            else low = mid;
        }
        least = high;
        assertTrue(vm.revertToState(snap));
        (ok, ret) = _tryCollect(least);
        assertTrue(ok, "least succeeds"); _sameResult(ret, expected, end);
        assertTrue(vm.revertToState(snap));
        (ok, ret) = _tryCollect(least - 1);
        assertFalse(ok, "one gas below least must revert");
        assertEq(ret, abi.encodeWithSignature("Error(string)", "ReceiverGasTooLow"), "second tip admission binds");
        // Integer cross multiplication preserves the fractional part of 1.2 * (least + margin).
        // Part 3 review: 8M on Amsterdam. The items-buyers/holders-sellers menus need 7,166,552 > 7M.
        uint256 floor = amsterdam ? 8_000_000 : 5_000_000;
        emit log_named_uint("least transaction gas", least);
        emit log_named_uint("padded least plus fresh slot (rounded up)", ((least + FRESH_SLOT_MARGIN) * 12 + 9) / 10);
        assertLe((least + FRESH_SLOT_MARGIN) * 12, floor * 10, "fork floor covers 20 percent plus fresh slot");
        assertTrue(vm.revertToState(snap));
        (ok, ret) = _tryCollect(floor);
        assertTrue(ok, "exact fork floor succeeds (5M on default)"); _sameResult(ret, expected, end);
    }
    function _bound(Menu menu, bool funded) private {
        bool shopBox = menu >= Menu.ShopP && menu <= Menu.ShopTErc20;
        uint8 sellersHolders = menu == Menu.ItemsBurnHoldersP ? 1 : menu >= Menu.ItemsKeepHoldersT ? 2 : 0;
        bool holdersT = menu == Menu.HoldersT || menu == Menu.HoldersTErc20 || menu == Menu.ShopT || menu == Menu.ShopTErc20
            || sellersHolders == 2;
        bool erc20 = menu == Menu.HoldersTErc20 || menu == Menu.ShopPErc20 || menu == Menu.ShopTErc20 || menu == Menu.ItemsKeepErc20
            || menu == Menu.ItemsBurnErc20HoldersT;
        uint8 itemPolicy = menu == Menu.ItemsBurn || menu >= Menu.ItemsBurnHoldersT ? 2 : menu >= Menu.ItemsKeep ? 1 : 0;
        _openBound(shopBox, holdersT, erc20, itemPolicy, sellersHolders);
        bool amsterdam = _amsterdam();
        uint256 end = _journal(PASSES, 14, true, true);
        // Mixed menus fund holder T only on the sellers' side, after the second tip's admission check.
        _costlyState(holdersT, sellersHolders == 0);
        selfTip = funded;
        vm.deal(TIP_TO, funded ? 1 : 0);
        assertEq(TIP_TO.balance, funded ? 1 : 0);
        assertEq(vm.getNonce(TIP_TO), 0); assertEq(TIP_TO.code.length, 0);
        if (erc20) {
            if (funded) HostileToken(box.q()).mint(TIP_TO, 1);
            assertEq(HostileToken(box.q()).balanceOf(TIP_TO), funded ? 1 : 0);
        }
        emit log_named_uint("menu", uint256(menu)); emit log_named_uint("funded tip", funded ? 1 : 0);
        uint256 least = _probe(end, amsterdam);
        assertEq(least, _pin(menu, funded, amsterdam), "least transaction gas pin");
    }
    function test_RC7_boundHoldersPEmpty() public { _bound(Menu.HoldersP, false); }
    function test_RC7_boundHoldersPFunded() public { _bound(Menu.HoldersP, true); }
    function test_RC7_boundHoldersTEmpty() public { _bound(Menu.HoldersT, false); }
    function test_RC7_boundHoldersTFunded() public { _bound(Menu.HoldersT, true); }
    function test_RC7_boundHoldersTErc20Empty() public { _bound(Menu.HoldersTErc20, false); }
    function test_RC7_boundHoldersTErc20Funded() public { _bound(Menu.HoldersTErc20, true); }
    function test_RC7_boundShopPEmpty() public { _bound(Menu.ShopP, false); }
    function test_RC7_boundShopPFunded() public { _bound(Menu.ShopP, true); }
    function test_RC7_boundShopPErc20Empty() public { _bound(Menu.ShopPErc20, false); }
    function test_RC7_boundShopPErc20Funded() public { _bound(Menu.ShopPErc20, true); }
    function test_RC7_boundShopTEmpty() public { _bound(Menu.ShopT, false); }
    function test_RC7_boundShopTFunded() public { _bound(Menu.ShopT, true); }
    function test_RC7_boundShopTErc20Empty() public { _bound(Menu.ShopTErc20, false); }
    function test_RC7_boundShopTErc20Funded() public { _bound(Menu.ShopTErc20, true); }
    function test_RC7_boundItemsKeepEmpty() public { _bound(Menu.ItemsKeep, false); }
    function test_RC7_boundItemsKeepFunded() public { _bound(Menu.ItemsKeep, true); }
    function test_RC7_boundItemsBurnEmpty() public { _bound(Menu.ItemsBurn, false); }
    function test_RC7_boundItemsBurnFunded() public { _bound(Menu.ItemsBurn, true); }
    function test_RC7_boundItemsKeepErc20Empty() public { _bound(Menu.ItemsKeepErc20, false); }
    function test_RC7_boundItemsKeepErc20Funded() public { _bound(Menu.ItemsKeepErc20, true); }
    function test_RC7_boundItemsKeepHoldersTEmpty() public { _bound(Menu.ItemsKeepHoldersT, false); }
    function test_RC7_boundItemsKeepHoldersTFunded() public { _bound(Menu.ItemsKeepHoldersT, true); }
    function test_RC7_boundItemsBurnHoldersTEmpty() public { _bound(Menu.ItemsBurnHoldersT, false); }
    function test_RC7_boundItemsBurnHoldersTFunded() public { _bound(Menu.ItemsBurnHoldersT, true); }
    function test_RC7_boundItemsBurnErc20HoldersTEmpty() public { _bound(Menu.ItemsBurnErc20HoldersT, false); }
    function test_RC7_boundItemsBurnErc20HoldersTFunded() public { _bound(Menu.ItemsBurnErc20HoldersT, true); }
    function test_RC7_boundItemsBurnHoldersPEmpty() public { _bound(Menu.ItemsBurnHoldersP, false); }
    function test_RC7_boundItemsBurnHoldersPFunded() public { _bound(Menu.ItemsBurnHoldersP, true); }

    // Part 3 review: the runbook's untipped collect(ZERO) keeps its 5M row on both EVMs, one fresh slot included,
    // in the dearest tipped menu's state. No tip means no admission check: one gas less runs out of gas.
    function _untipped(bool amsterdam) private returns (uint256 least) {
        untipped = true;
        _openBound(false, true, false, 2, 2);
        uint256 end = _journal(PASSES, 14, true, true);
        _costlyState(true, false);
        uint256 snap = vm.snapshotState();
        (bool ok, bytes memory ret) = _tryCollect(15_000_000);
        assertTrue(ok, "unrestricted untipped collect succeeds");
        FeeBatchV2 memory expected = abi.decode(ret, (FeeBatchV2));
        assertEq(expected.tip, 0, "no tip");
        uint256 low = GasBudget.intrinsic(abi.encodeWithSignature("collect(address)", address(0)));
        uint256 high = 15_000_000;
        while (low + 1 < high) {
            assertTrue(vm.revertToState(snap));
            uint256 mid = (low + high) / 2;
            (ok, ret) = _tryCollect(mid);
            if (ok) high = mid; else low = mid;
        }
        least = high;
        assertTrue(vm.revertToState(snap));
        (ok, ret) = _tryCollect(least);
        assertTrue(ok, "least succeeds");
        _sameResult(ret, expected, end);
        assertTrue(vm.revertToState(snap));
        (ok,) = _tryCollect(least - 1);
        assertFalse(ok, "one gas below least must revert");
        emit log_named_uint("untipped least transaction gas", least);
        assertLe(least + FRESH_SLOT_MARGIN, 5_000_000, "runbook 5M row covers an untipped collect plus a fresh slot");
        assertEq(least, amsterdam ? 4_802_910 : 1_502_832, "untipped least transaction gas pin");
    }
    function test_RC7_untippedCollectFitsRunbookRow() public { _untipped(_amsterdam()); }

    function _clearSafeDebts() private {
        assertGt(receiver.payFit(), 0); assertGt(receiver.payPlatform(), 0);
        assertEq(receiver.fitOwed(), 0); assertEq(receiver.platformOwed(), 0);
    }

    // Public operations create the costly state; only the exact source queue itself is storage-seeded.
    // Run AFTER seeding: swaps append real fees behind this page and never overwrite a seeded entitlement.
    function _costlyState(bool holdersT, bool buyersRangeStart) private {
        _clearSafeDebts();
        if (holdersT) {
            for (uint256 i; i < 10 && vm.load(address(receiver), bytes32(uint256(26))) != bytes32(0); ++i) {
                vm.roll(block.number + 1); receiver.buyBack(address(0));
            }
            assertEq(vm.load(address(receiver), bytes32(uint256(26))), bytes32(0), "empty reward debt");
            if (buyersRangeStart) assertGt(uint256(vm.load(address(receiver), bytes32(uint256(29)))), 0, "positive historical range start");
        } else if (receiver.holderLedger() != address(0)) {
            // Exhaust old P credits through settlement, rightful claims and residue flushing.
            HolderLedgerV2 ledger = HolderLedgerV2(receiver.holderLedger());
            for (uint256 id = 1; id < first; ++id) {
                assertTrue(ledger.settleBatch(id, 64));
                for (uint256 h; h < IHolderTokenHistoryV2(address(token)).holderCount(); ++h) {
                    address holder = IHolderTokenHistoryV2(address(token)).holderAt(h);
                    if (ledger.claimable(id, holder) != 0) { vm.prank(holder); ledger.claim(id, holder); }
                }
                ledger.flushResidue(id);
            }
        }
        assertEq(pm.balanceOf(receiver.holderLedger(), uint160(box.q())), 0, "empty holder P claims");
        // First buyer/seller harvest counter writes, plus a positive unharvested buyer tail.
        buyer.swap(hook.poolKey(), false, token.balanceOf(address(buyer)) / 20, TickMath.MAX_SQRT_PRICE - 1);
        vm.roll(block.number + 1); hook.sellFees();
        buyer.swap(hook.poolKey(), true, value, TickMath.MIN_SQRT_PRICE + 1);
        assertEq(vm.load(address(receiver), bytes32(uint256(17))), bytes32(0), "virgin buyer harvest counter");
        assertEq(vm.load(address(receiver), bytes32(uint256(18))), bytes32(0), "virgin seller harvest counter");
        assertEq(receiver.fitOwed(), 0); assertEq(receiver.platformOwed(), 0);
        assertEq(ShopReceiver(address(receiver)).modulePendingP(true), 0);
    }

    // XR-RC7-RECEIVER-QUOTA F1: clearing both Safe debts alone defeated the old total-gas bound.
    // Keep this minimal regression separately from the stronger drained-debt/first-harvest cases above.
    function test_RC7_clearedSafeDebts() public {
        _openBound(true, true, true); _clearSafeDebts();
        uint256 end = _journal(PASSES, 14, true, true);
        bool amsterdam = _amsterdam();
        assertEq(_probe(end, amsterdam), amsterdam ? 5_058_161 : 3_747_282, "cleared Safe debt least gas pin");
    }

    function _slope(bool shopBox, bool holdersT) private {
        _openBound(shopBox, holdersT, false);
        uint256 snap = vm.snapshotState();
        _journal(0, 0, true, true); (uint256 base,) = _measure(15_000_000);
        assertTrue(vm.revertToState(snap));
        _journal(1, 14, true, false); (uint256 buyerExtra,) = _measure(15_000_000);
        assertTrue(vm.revertToState(snap));
        _journal(1, 14, false, true); (uint256 sellerExtra,) = _measure(15_000_000);
        emit log_named_uint("two valued per side transaction gas", base);
        emit log_named_uint("one buyer sub-unit marginal gas", buyerExtra - base);
        emit log_named_uint("one seller sub-unit marginal gas", sellerExtra - base);
    }
    function test_RC7_slopeHoldersT() public { _slope(false, true); }
    function test_RC7_slopeHoldersP() public { _slope(false, false); }
    function test_RC7_slopeShopHoldersT() public { _slope(true, true); }
    function test_RC7_slopeShopHoldersP() public { _slope(true, false); }

    function _zeroRange(bool shopBox) private {
        _openBound(shopBox, !shopBox, false);
        uint256 end = _journal(0, 0, true, true); receiver.collect(address(0));
        bytes32 journal = shopBox ? keccak256("squarehole.receiver.v21.shop.journal") : bytes32(uint256(26));
        assertGt(uint256(vm.load(address(receiver), bytes32(uint256(journal) + 3))), 0, "positive sources funded");
        uint256 id = end + (shopBox ? 1 : 0); // The next source, closed empty by the previous collect.
        receiver.collect(address(0));
        assertTrue(receiver.holderBatchClosed(id)); assertEq(receiver.holderBatchPaid(id), 0);
        bytes32 range = keccak256(abi.encode(id, uint256(journal) + 6));
        assertEq(vm.load(address(receiver), range), bytes32(0), "zero share writes no range start");
        assertEq(vm.load(address(receiver), bytes32(uint256(range) + 1)), bytes32(0), "zero share writes no range end");
        assertTrue(HolderLedgerV2(receiver.holderLedger()).settleBatch(id, 64));
        (bool complete,,,) = HolderLedgerV2(receiver.holderLedger()).batchState(id); assertTrue(complete);
    }
    function test_RC7_zeroHolderTRangeStillSettles() public { _zeroRange(false); }
    function test_RC7_zeroShopRangeStillSettles() public { _zeroRange(true); }

    // SH-V21-RC7-INT release review GK-2: the collect floors cover ordinary P only. The keeper estimates in a one-tip
    // state and signs max(estimate + max(20%, 150k), floor); a second valued buyer source closing before inclusion makes
    // the collect pay two tips. With ordinary P the signed limit still covers that. With a price coin whose transfer
    // burns the whole 2.8M TIP_GAS stipend (HostileToken looping into 0xBADD), the first tip burns 2.8M and the second
    // still needs its own admission, so the signed limit falls short and the collect reverts whole: keeper gas only.
    function _leastCollect() private returns (uint256 least) {
        uint256 snap = vm.snapshotState();
        (bool ok,) = _tryCollect(15_000_000);
        assertTrue(ok, "an unrestricted collect succeeds");
        assertTrue(vm.revertToState(snap));
        uint256 low = GasBudget.intrinsic(abi.encodeWithSignature("collect(address)", TIP_TO));
        least = 15_000_000;
        while (low + 1 < least) {
            uint256 mid = (low + least) / 2;
            (ok,) = _tryCollect(mid);
            if (ok) least = mid; else low = mid;
            assertTrue(vm.revertToState(snap));
        }
        (ok,) = _tryCollect(least - 1); assertFalse(ok, "least minus one reverts");
        assertTrue(vm.revertToState(snap));
    }
    function _keeperSigned(uint256 estimate, uint256 floor) private pure returns (uint256) {
        uint256 pct = estimate * 2_000 / 10_000; // packages/keeper/src/gas.ts gasLimitFrom
        uint256 limit = estimate + (pct > 150_000 ? pct : 150_000);
        return limit > floor ? limit : floor;
    }
    function _tipsRace(Menu menu, bool hostileP, bool oneTip_) private returns (uint256 least, bool amsterdam) {
        oneTip = oneTip_;
        bool erc20 = menu == Menu.ItemsBurnErc20HoldersT;
        _openBound(false, true, true, erc20 ? 2 : 0, erc20 ? 2 : 0);
        amsterdam = _amsterdam();
        _journal(PASSES, 14, true, true);
        _costlyState(true, !erc20);
        vm.deal(TIP_TO, 0);
        if (hostileP) {
            vm.etch(address(0xBADD), hex"5b600056");
            HostileToken(box.q()).armReentry(address(0xBADD), "");
        }
        least = _leastCollect();
    }
    function _race(Menu menu, bool hostileP) private {
        uint256 snap = vm.snapshotState();
        (uint256 one, bool amsterdam) = _tipsRace(menu, hostileP, true);
        assertTrue(vm.revertToState(snap));
        (uint256 two,) = _tipsRace(menu, hostileP, false);
        uint256 signed = _keeperSigned(one, amsterdam ? 8_000_000 : 5_000_000);
        emit log_named_uint("one-tip least", one);
        emit log_named_uint("signed from the one-tip estimate", signed);
        emit log_named_uint("two-tip least", two);
        if (hostileP) assertGt(two, signed, "GK-2 limitation: a stipend-burning P outruns the collect floor");
        else assertLe(two, signed, "ordinary P: the floor covers a second tip appearing before inclusion");
    }
    function test_RC7_tipsRaceHostilePItemsBurnErc20HoldersT() public { _race(Menu.ItemsBurnErc20HoldersT, true); }
    function test_RC7_tipsRaceHostilePHoldersTErc20() public { _race(Menu.HoldersTErc20, true); }
    function test_RC7_tipsRaceOrdinaryPItemsBurnErc20HoldersT() public { _race(Menu.ItemsBurnErc20HoldersT, false); }
    function test_RC7_tipsRaceOrdinaryPHoldersTErc20() public { _race(Menu.HoldersTErc20, false); }
}
