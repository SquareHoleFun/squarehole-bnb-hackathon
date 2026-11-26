// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {M244Base} from "../m2-44/Fixture.sol";
import {BoxSpec, BoxType} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";
import {IBoxReceiverV2, IBoxReceiverItemsV2} from "../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {IBoxCoordinatorV2, IBoxFactoryPileV2} from "../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";
import {IBoxVaultV2, IBoxVaultItemsV2} from "../../../src/box-v2/interfaces/IBoxVaultV2.sol";
import {IBoxTicketsItemsV2} from "../../../src/box-v2/interfaces/IBoxPeripheryV2.sol";
import {TradeBatchV2} from "../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {IHolderLedgerV2} from "../../../src/box-v2/interfaces/IHolderLedgerV2.sol";
import {ReceiverArgs, BoxReceiverV2Args} from "../../../src/box-v2/libraries/BoxReceiverV2Args.sol";
import {ItemSourceModel} from "../m3-00/ItemSourceModel.sol";
import {FreezeRules} from "../m3-00/FreezeRules.sol";
import {Currency} from "v4-core/src/types/Currency.sol";

/// M302-WIRING/GATE/H/SOURCE: no core implementation is replaced in these baseline checks.
contract M302BaselineTest is M244Base {
    function test_receiverItemArgumentIsIndependentOfM2HolderAndAdjacentWords() public {
        _start(_holders());
        assertEq(receiver.itemLedger(), address(0));
        assertEq(receiver.holderLedger(), box.roleAddress(17));
        assertEq(address(receiver).code.length, 45 + 263);
        ReceiverArgs memory args;
        args.coordinator = address(box);
        args.hook = address(hook);
        args.t = address(token);
        args.registry = address(registry);
        args.launchRouter = box.launchRouter();
        args.holderLedger = box.roleAddress(17);
        args.itemLedger = address(0x1616);
        args.boxId = 123;
        args.batchMinQ = 111;
        args.tipMaxQ = 222;
        args.stepMinQ = 333;
        args.buyersChoice = 4;
        args.sellersChoice = 4;
        IBoxReceiverV2 probe = IBoxReceiverV2(
            BoxClones.create(BoxClones.initCode(release.implementations[5], BoxReceiverV2Args.encode(args)))
        );
        vm.prank(address(box));
        probe.initialize();
        assertEq(probe.itemLedger(), args.itemLedger);
        assertEq(probe.holderLedger(), args.holderLedger);
        assertEq(probe.boxId(), 123);
        bytes memory code = address(probe).code;
        assertEq(_word(code, 45 + 172, 16), 111);
        assertEq(_word(code, 45 + 188, 16), 222);
        assertEq(_word(code, 45 + 204, 16), 333);
        assertEq(_word(code, 45 + 243, 20), uint160(args.itemLedger));
        assertEq(_word(code, 45 + 223, 20), uint160(args.holderLedger));
        // M3-23 exposes the journal on every receiver; a holders-only box has no item receipts.
        IBoxReceiverItemsV2 funding = IBoxReceiverItemsV2(address(probe));
        assertEq(funding.itemFundingCount(), 0);
        vm.expectRevert(IBoxReceiverV2.InvalidChoice.selector);
        funding.itemFunding(0);
        vm.expectRevert(IBoxReceiverV2.InvalidChoice.selector);
        funding.itemFunding(1);
    }

    function test_factoryCollectionHasRealJournalButZeroRoleDoesNoRecording() public {
        BoxSpec memory spec = _hiddenSpec();
        spec.buyers = _holders().buyers;
        _start(spec);
        // M3-32 creates role 16 only for Items; this collection selects Holders instead.
        assertEq(box.roleAddress(16), address(0));
        assertEq(receiver.itemLedger(), address(0));
        assertNotEq(box.roleAddress(17), address(0));
        assertEq(token.ledger(), box.roleAddress(17));
        IBoxVaultV2 vault = IBoxVaultV2(box.vault());
        IBoxVaultItemsV2 history = IBoxVaultItemsV2(address(vault));
        assertEq(history.ITEM_BATCH_MAX(), 1);
        assertEq(history.itemLifecycleCount(), 0);
        assertEq(IBoxTicketsItemsV2(box.tickets()).activeItemTicket(0), bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(IBoxVaultV2.InvalidQuantity.selector, 1, 0));
        history.itemLifecycle(1);
        vm.expectRevert(abi.encodeWithSelector(IBoxVaultV2.NotAdapter.selector, address(this)));
        vault.openTickets(1, type(uint256).max);
        // M3-32 implements the S5 predicate; a collection vault is not a pile clone.
        assertFalse(IBoxFactoryPileV2(address(factory)).isPileVault(address(vault)));
    }

    function test_seedOnlyLoaderAuthenticatesCompletionAndRollsBackFailedOpen() public {
        _createShop(0, 100 ether, false, false);
        assertTrue(shop.seedReady());
        assertTrue(box.starterSetPending());
        assertFalse(box.gateOpen());
        assertEq(box.starterSetLoader(), box.roleAddress(19));
        assertTrue(BoxClones.isCloneOf(box.vault(), release.implementations[21]));
        assertTrue(BoxClones.isCloneOf(address(token), release.implementations[20]));
        vm.expectRevert(abi.encodeWithSelector(IBoxCoordinatorV2.NotStarterSetLoader.selector, address(this)));
        box.starterSetLoaded();
        bytes memory reason = abi.encodePacked("setOpen refused");
        uint256 opening = box.openAt() > block.timestamp + 1 ? box.openAt() : block.timestamp + 1;
        vm.mockCallRevert(address(hook), abi.encodeWithSignature("setOpen(uint256)", opening), reason);
        vm.expectRevert(reason);
        loader.complete();
        (,, bool notified) = loader.progress();
        assertFalse(notified);
        assertTrue(box.starterSetPending());
        assertFalse(box.gateOpen());
        vm.clearMockedCalls();
        loader.complete();
        assertTrue(box.gateOpen());
        assertFalse(box.starterSetPending());
        assertEq(box.effectiveOpenAt(), opening);
        vm.expectRevert();
        loader.complete();
    }

    function test_HIncludesExactlyIntegratedShopLiquidAndBackedClaimsAndStaysFixed() public {
        _createShop(0, 1000 ether, false, true);
        _trade();
        vm.prank(CREATOR);
        token.transfer(address(buyer), 100 ether);
        buyer.mintClaims(Currency.wrap(address(token)), address(shop), 100 ether);
        vm.warp(box.deadline());
        box.fail();
        uint256 hBase = _held(address(box)) + _held(address(hook)) + _held(address(receiver));
        uint256 held = _held(address(shop));
        uint256 closed = hook.closedTResidue();
        (uint256 pot, uint256 left) = box.claimState();
        assertEq(held, 1100 ether);
        assertEq(left, token.totalSupply() - hBase - held - closed);
        _assertOutstanding();
        // Compose the preserved M2 exclusion with S5's separate PILE-only term.
        // This arithmetic comparison does not stand in for production pile authentication.
        FreezeRules rules = new FreezeRules();
        uint256 modeledPile = rules.outstanding(
            BoxType.PILE,
            token.totalSupply(),
            hBase,
            token.balanceOf(address(shop)),
            pm.balanceOf(address(shop), uint160(address(token))),
            0,
            0,
            closed
        );
        assertEq(modeledPile, left);
        uint256 modeledShop = rules.outstanding(BoxType.SHOP, token.totalSupply(), hBase + held, 0, 0, 0, 0, closed);
        assertEq(modeledShop, left, "M2 shop H composes with zero S5 pile term and zero K");
        assertEq(shop.burnFailedT(), held);
        (uint256 afterPot, uint256 afterLeft) = box.claimState();
        assertEq(afterPot, pot);
        assertEq(afterLeft, left, "post-freeze burn does not reprice claims");
        uint256 paid = _claimT(CREATOR) + _claimT(address(buyer));
        assertEq(paid, pot);
        (afterPot, afterLeft) = box.claimState();
        assertEq(afterPot, 0);
        assertEq(afterLeft, 0);
    }

    function test_sourceModelMatchesActualNativeFunding() public {
        _sources(0);
    }

    function test_sourceModelMatchesActualSixDecimalFunding() public {
        _sources(6);
    }

    function test_sourceModelMatchesActualEightDecimalFunding() public {
        _sources(8);
    }

    function test_sourceModelMatchesActualEighteenDecimalFunding() public {
        _sources(18);
    }

    function _sources(uint8 decimals) private {
        BoxSpec memory spec = _holders();
        if (decimals != 0) {
            (BoxSpec memory priced,) = _priceSpec(3, 3, decimals);
            spec.pricing = priced.pricing;
            spec.raise = priced.raise;
        }
        spec.creatorBuy = spec.raise / 100;
        _start(spec);
        uint256 money = _money();
        _trade();
        receiver.collect(address(0));
        ItemSourceModel model = new ItemSourceModel();
        IHolderLedgerV2 holder = IHolderLedgerV2(box.roleAddress(17));
        uint256 total;
        for (uint8 side = 1; side <= 2; ++side) {
            TradeBatchV2 memory batch = hook.tradeBatch(side);
            assertTrue(batch.closed);
            assertTrue(receiver.holderBatchClosed(side));
            assertGt(batch.tradeUnits, 0);
            model.receiveSource(side, side, 1, side, batch.netP, 0, batch.netP);
            model.allocate(side, 0, true);
            uint256 paid = receiver.holderBatchPaid(side);
            assertEq(paid, model.choice(side), "M3 consumes actual net source amounts after D6");
            assertTrue(holder.settleBatch(side, 64));
            (,,, uint256 residue) = holder.batchState(side);
            uint256 credit = holder.claimable(side, CREATOR);
            assertEq(credit + residue, paid);
            if (credit != 0) {
                vm.prank(CREATOR); assertEq(holder.claim(side, CREATOR), credit);
            } else assertEq(side, 2, "curve seller T fees do not fund P credits");
            assertEq(holder.flushResidue(side), residue);
            total += paid;
        }
        assertGt(total, 0);
        assertEq(pm.balanceOf(address(holder), uint160(box.q())), 0);
        assertEq(model.pending(), 0);
        assertEq(model.accounted(), model.received());
        assertEq(_money(), money);
        _booked();
    }

    function _held(address at) private view returns (uint256) {
        return token.balanceOf(at) + pm.balanceOf(at, uint160(address(token)));
    }

    function _word(bytes memory code, uint256 start, uint256 length) private pure returns (uint256 value) {
        for (uint256 i; i < length; ++i) {
            value = (value << 8) | uint8(code[start + i]);
        }
    }
}
