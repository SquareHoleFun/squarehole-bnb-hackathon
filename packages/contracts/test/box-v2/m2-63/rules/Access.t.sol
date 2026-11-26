// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {M244Base} from "../../m2-44/Fixture.sol";
import {BoxClones} from "../../../../src/box/libraries/BoxClones.sol";
import {IHolderTokenHistoryV2} from "../../../../src/box-v2/interfaces/IHolderLedgerV2.sol";
import {IShopVaultV2} from "../../../../src/box-v2/interfaces/IShopVaultV2.sol";
import {IBoxReceiverV2} from "../../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {BoxSpec} from "../../../../src/box-v2/interfaces/SpecTypes.sol";

contract M263AccessTest is M244Base {
    function test_P01_creatorClaimRequiresPayeeWithClaimableCredit() public {
        BoxSpec memory s = _holders();
        s.buyers = _side(1); // Keep buyers' P; sellers still pay the M2 holder ledger.
        s.creatorFeeRecipient = CREATOR;
        s.creatorBuy = s.raise / 100;
        _start(s);
        assertTrue(box.roleAddress(17) != address(0));
        assertEq(receiver.holderLedger(), box.roleAddress(17));
        _trade();
        _fill();
        box.graduate();
        receiver.collect(address(0));
        assertTrue(box.graduated());
        assertFalse(box.failed());
        assertEq(receiver.holderBatchPaid(2), 0, "curve T fees burn; holder sale funding begins after graduation");
        uint256 credit = receiver.creatorP();
        assertGt(credit, 0, "creator authorization probe requires claimable P");
        assertEq(receiver.creatorPayee(), CREATOR);
        uint256 recipientBefore = ALICE.balance;
        uint256 custodyBefore = _pClaims(address(receiver));
        address priceCoin = box.q();

        vm.prank(ALICE);
        (bool ok, bytes memory reason) = address(receiver).call(
            abi.encodeCall(receiver.claimCreator, (priceCoin, ALICE))
        );
        assertFalse(ok, "only the creator payee may spend creator P");
        assertEq(reason, abi.encodeWithSelector(IBoxReceiverV2.NotPayee.selector, ALICE));
        assertEq(receiver.creatorP(), credit, "unauthorized claim preserves credit");
        assertEq(ALICE.balance, recipientBefore, "unauthorized claim pays nothing");
        assertEq(_pClaims(address(receiver)), custodyBefore, "unauthorized claim preserves custody");

        vm.prank(CREATOR);
        assertEq(receiver.claimCreator(priceCoin, ALICE), credit);
        assertEq(ALICE.balance - recipientBefore, credit, "payee can direct the whole payout");
        assertEq(receiver.creatorP(), 0);
        assertEq(_pClaims(address(receiver)), custodyBefore - credit);
    }

    function test_P01_restrictedMembersRejectUnrelatedCallerWithoutChangingCustody() public {
        _createShop(0, 100 ether, true, false);
        bytes32 beforeState = _state();
        _refuse(address(ledger), abi.encodeCall(ledger.onTradeFeeBatch, (1, ALICE, true, 1)));
        _refuse(address(ledger), abi.encodeCall(ledger.onTokenCheckpoint, (1, CREATOR, ALICE)));
        _refuse(address(token), abi.encodeCall(IHolderTokenHistoryV2.registerHolder, (ALICE)));
        _refuse(address(loader), abi.encodeCall(loader.load, (new address[](1), new uint256[](1), new uint8[](1), suffix[1])));
        _refuse(address(shop), abi.encodeCall(shop.loadStarter, (address(nft), 0, 0)));
        string[9] memory shopCalls = [string("initialize()"), "openGate()", "enterFailure()", "burnLiquid()",
            "burnClaims()", "acceptCurator()", "renounceCurator()", "returnSeed()", "withdrawBudget()"];
        for (uint256 i; i < shopCalls.length; ++i) _refuse(address(shop), abi.encodeWithSignature(shopCalls[i]));
        _refuse(address(shop), abi.encodeCall(shop.addCollection, (address(nft), 0)));
        _refuse(address(shop), abi.encodeCall(shop.proposeCurator, (ALICE)));
        _refuse(address(shop), abi.encodeWithSignature("returnOne(uint256)", 0));
        _refuse(address(shop), abi.encodeWithSignature("onERC721Received(address,address,uint256,bytes)", address(shop), CREATOR, 0, ""));
        _refuse(address(box), abi.encodeWithSignature("starterSetLoaded()"));
        _refuse(address(box), abi.encodeWithSignature("launch()"));
        _refuse(address(receiver), abi.encodeWithSignature("initialize()"));
        _refuse(address(receiver), abi.encodeCall(receiver.onGraduation, ()));
        _refuse(address(receiver), abi.encodeCall(receiver.enterFailure, ()));
        _refuse(address(receiver), abi.encodeCall(receiver.claimCreator, (address(0), ALICE)));
        _refuse(address(receiver), abi.encodeCall(receiver.proposeCreatorPayee, (ALICE)));
        _refuse(address(receiver), abi.encodeCall(receiver.acceptCreatorPayee, ()));
        _refuse(address(hook), abi.encodeCall(hook.harvest, ()));
        _refuse(address(hook), abi.encodeCall(hook.close, ()));
        _refuse(address(hook), abi.encodeCall(hook.migrate, (0)));
        _refuse(address(hook), abi.encodeWithSignature("setOpen(uint256)", block.timestamp));
        assertEq(_state(), beforeState, "refused entries cannot change custody or lifecycle");
    }

    function test_P02_initializersAreOnceOnlyAndUninitializedClonesAuthenticateCoordinator() public {
        _createShop(0, 40 ether, false, false);
        uint256[4] memory roles = [uint256(1), 3, 5, 2];
        for (uint256 i; i < roles.length; ++i) {
            address part = box.roleAddress(roles[i]);
            vm.prank(address(box));
            (bool again,) = part.call(abi.encodeWithSignature("initialize()"));
            assertFalse(again, "even the correct coordinator cannot initialize twice");
        }
        // Authentic clone format/arguments alone never grant an unrelated caller initialization rights.
        uint256[3] memory slots = [uint256(20), 21, 5];
        for (uint256 i; i < slots.length; ++i) {
            address original = box.roleAddress(roles[i]);
            address twin = BoxClones.create(BoxClones.initCode(release.implementations[slots[i]], _args(original)));
            _refuse(twin, abi.encodeWithSignature("initialize()"));
        }
        address shopTwin = BoxClones.create(BoxClones.initCode(release.implementations[21], _args(address(shop))));
        vm.prank(address(box));
        (bool ok,) = shopTwin.call(abi.encodeWithSignature("initialize()"));
        assertFalse(ok, "coordinator role 3 must name this shop");
        assertEq(IShopVaultV2(shopTwin).budgetT(), 0);
        assertFalse(IShopVaultV2(shopTwin).seedReady());
    }

    function test_P03_poolManagerIdentityAloneCannotArmPayoutOrBurnCallbacks() public {
        _createShop(0, 100 ether, false, true); _trade(); receiver.collect(address(0));
        bytes32 beforeState = _state();
        address[4] memory targets = [address(ledger), address(shop), address(receiver), address(box)];
        bytes[4] memory payloads = [abi.encode(ALICE, uint256(1)), bytes(""),
            abi.encode(uint256(1), address(0), ALICE, uint256(1)), abi.encode(uint8(1), ALICE, uint256(1))];
        bytes[4] memory errors = [abi.encodeWithSignature("InvalidRequest()"),
            abi.encodeWithSignature("Unauthorized(address)", address(pm)),
            abi.encodeWithSignature("Error(string)", "ReceiverUnarmedUnlock"),
            abi.encodeWithSignature("NotPoolManager()")];
        for (uint256 i; i < targets.length; ++i) {
            bytes memory input = abi.encodeWithSignature("unlockCallback(bytes)", payloads[i]);
            _refuse(targets[i], input);
            vm.prank(address(pm)); (bool ok, bytes memory reason) = targets[i].call(input);
            assertFalse(ok, "PM callback also requires an armed local operation");
            assertEq(reason, errors[i], "refusal is authentication, not malformed data or unavailable custody");
        }
        assertEq(_state(), beforeState);
    }

    function test_P04_systemRolesCannotRegisterAndOrdinaryContractsRegisterOnlyThemselves() public {
        _createShop(0, 40 ether, false, true);
        IHolderTokenHistoryV2 history = IHolderTokenHistoryV2(address(token));
        uint256 beforeCheckpoint = history.holderCheckpoint();
        for (uint256 role; role < 24; ++role) {
            address account = box.roleAddress(role);
            if (account == address(0)) continue;
            vm.prank(account); (bool ok,) = address(ledger).call(abi.encodeCall(ledger.register, ()));
            assertFalse(ok, "system role cannot opt into fees");
            assertEq(history.eligibleBalanceAt(account, beforeCheckpoint), 0);
        }
        vm.prank(address(pm)); vm.expectRevert(); ledger.register();
        assertEq(history.holderCheckpoint(), beforeCheckpoint);
        vm.prank(CREATOR); token.transfer(address(buyer), 10);
        uint256 beforeRegister = history.holderCheckpoint();
        assertEq(history.eligibleBalanceAt(address(buyer), beforeRegister), 0);
        vm.prank(address(buyer)); ledger.register();
        assertEq(history.eligibleBalanceAt(address(buyer), beforeRegister), 0, "registration never backdates");
        assertEq(history.eligibleBalanceAt(address(buyer), history.holderCheckpoint()), 10);
        uint256 registered = history.holderCheckpoint();
        vm.prank(address(buyer)); ledger.register();
        assertEq(history.holderCheckpoint(), registered, "registration is idempotent");
    }

    function test_P05_claimConsumesOnlyCallerCreditAndRemovedPushCannotSpend() public {
        _createShop(0, 40 ether, false, true); _trade(); receiver.collect(address(0));
        ledger.settleBatch(1, 64);
        uint256 credit = ledger.claimable(1, CREATOR); assertGt(credit, 0);
        _refuse(address(ledger), abi.encodeCall(ledger.claim, (1, ALICE)));
        _refuse(address(ledger), abi.encodeWithSignature("claimFor(uint256,address)", 1, CREATOR));
        assertEq(ledger.claimable(1, CREATOR), credit);
        uint256 beforeP = ALICE.balance;
        vm.prank(CREATOR); assertEq(ledger.claim(1, ALICE), credit);
        assertEq(ALICE.balance - beforeP, credit, "whole credit, no minimum or tip");
        assertEq(ledger.claimable(1, CREATOR), 0);
        vm.prank(CREATOR); vm.expectRevert(); ledger.claim(1, CREATOR);
    }

    function _refuse(address target, bytes memory data) private {
        vm.prank(ALICE); (bool ok,) = target.call(data); assertFalse(ok, "caller/removed-route refusal");
    }
    function _args(address clone) private view returns (bytes memory data) {
        data = new bytes(clone.code.length - BoxClones.ARGS_OFFSET);
        uint256 offset = BoxClones.ARGS_OFFSET;
        assembly ("memory-safe") { extcodecopy(clone, add(data, 32), offset, mload(data)) }
    }
    function _state() private view returns (bytes32) {
        return keccak256(abi.encode(token.totalSupply(), token.balanceOf(CREATOR), token.balanceOf(address(shop)),
            shop.inside(), shop.seedReady(), box.gateOpen(), box.failed(), box.graduated(),
            _pClaims(address(box)), _pClaims(address(receiver)), _pClaims(address(ledger)),
            IHolderTokenHistoryV2(address(token)).holderCheckpoint()));
    }
}
