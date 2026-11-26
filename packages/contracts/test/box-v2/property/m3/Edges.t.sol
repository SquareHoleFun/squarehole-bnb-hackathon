// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {NoFailureSweep} from "../../rc5-a/NoFailureSweep.sol";

import {M361ItemLife} from "./ItemLifeHarness.sol";
import {BoxSpec, HostileToken, BoxTokenV2, IBoxHookV2, IBoxReceiverV2, PoolDriver, BoxLayoutV2, PileVaultV2} from "./MenuHarness.sol";
import {IBoxVaultV2} from "../../../../src/box-v2/interfaces/IBoxVaultV2.sol";
import {IBoxReceiverItemsV2} from "../../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {IBoxCoordinatorV2, IBoxFactoryV2} from "../../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";
import {AddOn} from "../../../../src/box-v2/interfaces/SpecTypes.sol";
import {ShopConfigV2} from "../../../../src/box-v2/interfaces/IShopVaultV2.sol";
import {ProtocolSkip} from "../../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";

contract M361EdgesTest is M361ItemLife {
    function test_shopMenuRefusesSeedBelowTwoCheapestGivesBeforeCustody() public {
        BoxSpec memory spec = _caseSpec(4, 0, 4, 4);
        ShopConfigV2 memory cfg = abi.decode(spec.contentsParams, (ShopConfigV2));
        // Keep a valid seed-only loader so every refusal isolates the funded-budget rule.
        spec.addOns = new AddOn[](2);
        spec.addOns[0] = AddOn(7, "");
        spec.addOns[1] = AddOn(8, abi.encode(bytes32(0), uint32(0)));
        bytes memory refusal = abi.encodeWithSelector(IBoxFactoryV2.InvalidSpec.selector, uint16(4), uint16(30));
        uint256[3] memory seeds = [uint256(0), 1 ether, 2 ether - 1];
        for (uint256 i; i < seeds.length; ++i) {
            cfg.seedT = seeds[i];
            spec.contentsParams = abi.encode(cfg);
            assertEq(factory.refusal(spec, CREATOR), refusal, "M361: seed cannot fund two cheapest gives");
            uint256 creatorP = CREATOR.balance;
            uint256 factoryP = address(factory).balance;
            uint64 factoryNonce = vm.getNonce(address(factory));
            vm.prank(CREATOR); vm.expectRevert(refusal);
            factory.createBox{value: 1 ether}(spec, 0, 0);
            assertEq(CREATOR.balance, creatorP);
            assertEq(address(factory).balance, factoryP);
            assertEq(vm.getNonce(address(factory)), factoryNonce);
        }
        cfg.seedT = 2 ether;
        spec.contentsParams = abi.encode(cfg);
        assertEq(factory.refusal(spec, CREATOR).length, 0, "F132: two cheapest gives suffice");
    }

    function test_menuRefusesItemsOnEveryOtherBoxType() public {
        for (uint8 kind = 3; kind <= 5; ++kind) {
            for (uint8 b = 1; b <= 6; ++b) for (uint8 s = 1; s <= 6; ++s) {
                BoxSpec memory spec = _caseSpec(kind, 0, b, s);
                assertEq(factory.refusal(spec, CREATOR).length != 0, b >= 5 || s >= 5);
            }
        }
        BoxSpec memory legacy = _caseSpec(1, 0, 5, 5);
        legacy.buyers.a.destParams = abi.encode(uint8(1), address(0), new uint256[](0));
        assertGt(factory.refusal(legacy, CREATOR).length, 0, "old lists do not silently map");
        legacy = _caseSpec(1, 0, 5, 5); legacy.boxType = 2;
        assertGt(factory.refusal(legacy, CREATOR).length, 0, "existing-NFT box remains deferred");
    }

    function test_pickBeforeCollectMeasuresRealFeesAndExecutableSaleValue() public {
        _itemLife(0, 6, 6, 51, false);
        address vault = box.vault();
        vm.prank(ALICE); IBoxVaultV2(vault).returnItem(secondItem, 0, block.timestamp); _trackT();
        _compareItems(1);
        uint256 beforeT = token.balanceOf(ALICE);
        vm.prank(ALICE);
        (uint256 pickPrincipal, uint256 pickFee) = IBoxVaultV2(vault).withdraw(secondItem, type(uint256).max, block.timestamp);
        _trackT();
        uint256 amount = box.raise() / 100;
        _fundLive(amount); _compareItems(1);
        (uint256 outside, uint256 stash) = items.itemCredit(secondItem);
        assertEq(outside, (10 * (amount / 15)) / 10, "just-picked item earns this whole batch share");
        assertEq(stash, 0, "burn policy creates no retained stash");
        _claimItem(secondItem, ALICE);
        vm.prank(ALICE);
        (uint256 returned, uint256 returnFee) = IBoxVaultV2(vault).returnItem(secondItem, 0, block.timestamp);
        uint256 costT = beforeT - token.balanceOf(ALICE);
        assertEq(costT, pickPrincipal + pickFee - returned + returnFee);
        assertGt(pickFee, 0); assertGt(returnFee, 0);
        _trackT(); _compareItems(1); _state();
        // Price the actual T loss through a real sale at this pool's current state, then restore the quote branch.
        uint256 snapshot = vm.snapshotState();
        vm.prank(ALICE); token.transfer(address(buyer), costT);
        (, uint256 costP) = buyer.swap(hook.poolKey(), false, costT, TickMath.MAX_SQRT_PRICE - 1);
        assertGt(costP, 0); assertTrue(vm.revertToState(snapshot));
        emit log_named_uint("pick fee T", pickFee);
        emit log_named_uint("return fee T", returnFee);
        emit log_named_uint("fee loss valued by executable P sale", costP);
        emit log_named_uint("just-picked item P allocation", outside);
        emit log_named_int("P allocation minus fee sale value (before gas)", int256(outside) - int256(costP));
    }

    function test_burnAndDepthUseOwnPoolAndRetainOtherLiabilities() public {
        _open(1, 6, 6, 4); _fillTracked(); _collect(0); box.graduate();
        receiver.collect(address(0)); _settleHolders(); _compareItems(1);
        _gift(address(receiver), box.raise() / 10); receiver.collect(address(0)); _settleHolders(); _compareItems(1);
        uint256 itemBacking = pm.balanceOf(address(items), uint160(box.q()));
        (ProtocolSkip skipped, uint256 moved,,) = hook.deepen(address(0));
        assertEq(uint256(skipped), uint256(ProtocolSkip.None)); assertGt(moved, 0);
        (skipped,,,) = receiver.buyBack(address(0)); assertEq(uint256(skipped), uint256(ProtocolSkip.StepTaken));
        vm.roll(block.number + 1);
        uint256 batch = hook.currentTradeBatch(true); uint256 protocol = hook.tradeBatch(batch).protocolUnits;
        uint256 before = receiver.buyBackP(); uint256 supply = token.totalSupply();
        uint256 spent; uint256 bought;
        (skipped, spent, bought,) = receiver.buyBack(address(0));
        assertEq(uint256(skipped), uint256(ProtocolSkip.None)); assertGt(spent, 0);
        assertEq(before - receiver.buyBackP(), spent);
        assertEq(supply - token.totalSupply() + receiver.tBurnPending(), bought);
        holderModel.trade(batch, hook.tradeBatch(batch).protocolUnits - protocol, true, false);
        assertEq(pm.balanceOf(address(items), uint160(box.q())), itemBacking, "burn cannot spend item claims");
        receiver.collect(address(0)); _settleHolders(); _compareItems(1); _state();
    }

    function test_conversionForwardRetryAndReturnsInAllPhasesKeep() public { _conversion(5); }
    function test_conversionForwardRetryAndReturnsInAllPhasesBurn() public { _conversion(6); }
    function _conversion(uint8 policy) private {
        _open(1, 6, policy, 4);
        HostileToken foreign = new HostileToken("Foreign royalty", "ROY", 8);
        foreign.mint(address(this), 300); foreign.approve(address(receiver), 300);
        foreign.setBlocked(conversionSafe, true);
        vm.expectRevert(); receiver.fundRoyalty(address(foreign), 300);
        assertEq(foreign.balanceOf(conversionSafe), 0);
        // The conversion itself is off chain. This fixture supplies actual P from existing custody at the Safe.
        _returnFromSafe(1501);
        assertEq(receiver.royaltyHeldP(), 1501);
        uint256 failedBranch = vm.snapshotState();
        vm.warp(box.deadline()); box.fail(); _trackT(); holderModel.fail(); _settleHolders();
        uint256 fit = receiver.fitOwed(); _returnFromSafe(1501);
        assertEq(receiver.fitOwed(), fit);
        _claimPot(); receiver.collect(address(0)); fit = receiver.fitOwed();
        _returnFromSafe(1501); assertEq(receiver.fitOwed(), fit);
        foreign.setBlocked(conversionSafe, false);
        // F136 (SH-V21-RC5-INT fix round): the lot that waited through the failure stays in the box for good.
        assertEq(foreign.balanceOf(address(this)), 300);
        assertEq(foreign.balanceOf(conversionSafe), 0); _payoutSafes(); _state();
        assertTrue(vm.revertToState(failedBranch));
        _fillTracked(); _collect(0); box.graduate(); receiver.collect(address(0));
        _settleHolders(); _compareItems(1);
        assertEq(receiver.royaltyHeldP(), 0);
        uint256 receipts = IBoxReceiverItemsV2(address(receiver)).itemFundingCount();
        _returnFromSafe(1501); _compareItems(1);
        assertEq(IBoxReceiverItemsV2(address(receiver)).itemFundingCount(), receipts + 1);
        assertEq(IBoxReceiverItemsV2(address(receiver)).itemFunding(receipts + 1).choiceP, 1000);
        foreign.setBlocked(conversionSafe, false);
        _state();
    }
    function _returnFromSafe(uint256 amount) private {
        HostileToken p = HostileToken(box.q());
        vm.prank(CREATOR); p.transfer(conversionSafe, amount);
        vm.startPrank(conversionSafe); p.approve(address(receiver), amount);
        receiver.fundRoyalty(address(p), amount); vm.stopPrank(); _state();
    }

    function test_unopenedItemsFailWithoutNFTOrSeedCode() public {
        BoxSpec memory spec = _caseSpec(1, 0, 5, 6);
        box = _create(spec); assertFalse(box.gateOpen());
        token = BoxTokenV2(box.token()); hook = IBoxHookV2(box.hook()); receiver = IBoxReceiverV2(box.receiver());
        buyer = new PoolDriver(pm); vm.deal(address(buyer), spec.raise * 10);
        _gift(address(receiver), 1501); receiver.collect(address(0)); assertGt(receiver.itemsHeldP(), 0);
        uint256 money = _allP();
        vm.mockCallRevert(box.collection(), abi.encodeWithSignature("transferFrom(address,address,uint256)"), "NFT");
        vm.mockCallRevert(box.roleAddress(16), abi.encodeWithSignature("sync(uint256)"), "ledger");
        uint256 boundary = box.openAt() + 14 days;
        vm.warp(boundary - 1); vm.expectRevert(); box.failClosed();
        vm.warp(boundary); box.failClosed();
        assertEq(_allP(), money); assertEq(receiver.itemsHeldP(), 0);
        assertEq(IBoxReceiverItemsV2(address(receiver)).itemFundingCount(), 0);
        vm.clearMockedCalls();
        totalP = money; _claimPot(); _payoutSafes();
    }

    function test_failedSeedPauseDoesNotBlockPAndPermanentClaimsKeepsCount() public {
        _open(5, 6, 4, 2); _trade(true, box.raise() / 10); _collect(0);
        PileVaultV2 pile = PileVaultV2(payable(box.vault())); HostileToken p = HostileToken(box.q());
        uint256 seed = p.balanceOf(address(pile)); p.setBlocked(address(pile), true);
        vm.warp(box.deadline()); box.fail(); holderModel.fail(); _trackT(); _settleHolders();
        (uint256 pot, uint256 left) = box.claimState();
        vm.expectRevert(); pile.returnSeed();
        uint256 half = token.balanceOf(CREATOR) / 2; uint256 quoted = box.quoteClaim(half);
        vm.startPrank(CREATOR); token.approve(address(box), half);
        assertEq(box.claim(half, CREATOR), quoted); vm.stopPrank();
        uint256 burn = token.balanceOf(CREATOR) / 2; vm.prank(CREATOR); token.burn(burn);
        (, uint256 afterCount) = box.claimState(); assertEq(afterCount, left - half, "count never recomputed after burn");
        p.setBlocked(address(pile), false); uint256 before = p.balanceOf(CREATOR);
        vm.prank(BOB); assertEq(pile.returnSeed(), seed); assertEq(p.balanceOf(CREATOR) - before, seed);
        vm.warp(box.failedAt() + 365 days - 1); NoFailureSweep.check(address(box));
        vm.warp(box.failedAt() + 365 days);
        NoFailureSweep.check(address(box));
        (, uint256 fixedCount) = box.claimState(); assertEq(fixedCount, afterCount);
        assertEq(box.quoteClaim(afterCount), pot - quoted);
        receiver.collect(address(0)); _payoutSafes(); _state();
    }

    function test_ownerOnlyItemClaimRejectsRemovedPushWithoutSpendingCredit() public {
        _itemLife(8, 5, 6, 30, true);
        _fundLive(1500); _compareItems(1);
        uint256[] memory ids = new uint256[](1); ids[0] = firstItem;
        (uint256 beforeCredit, uint256 beforeStash) = items.itemCredit(firstItem);
        (bool ok,) = address(items).call(abi.encodeWithSignature("claimFor(uint256[])", ids));
        assertFalse(ok);
        (uint256 afterCredit, uint256 afterStash) = items.itemCredit(firstItem);
        assertEq(afterCredit, beforeCredit); assertEq(afterStash, beforeStash);
        _claimItem(firstItem, BOB);
    }
}
