// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {SetConversionFixture, HostileERC721} from "./SetConversionFixture.sol";
import {CustodyVault, SetReentryRecorder} from "./SetVaultFixture.sol";
import {SetRefused} from "../../../src/box-v2/set/SetTypesV2.sol";
import {SetReason as R} from "../../../src/box-v2/set/SetConstantsV2.sol";
import {TransientReentrancyGuard} from "../../../src/libraries/TransientReentrancyGuard.sol";

contract SetConversionHostileTest is SetConversionFixture {
    function test_hostilePickLastTransferRollsBackMoneyMembershipAndAllowance() public {
        _ready(10, 100003, true);
        HostileERC721 nft = HostileERC721(collection);
        vm.prank(ALICE);
        token.approve(address(vault), 100003); // finite allowance must roll back too
        HostileERC721.TransferMode[6] memory modes = [
            HostileERC721.TransferMode.Revert,
            HostileERC721.TransferMode.BurnGas,
            HostileERC721.TransferMode.NoOp,
            HostileERC721.TransferMode.CallbackWithoutTransfer,
            HostileERC721.TransferMode.Reenter,
            HostileERC721.TransferMode.HugeRevert
        ];
        uint256[] memory list = _list(0, 2);
        for (uint256 i; i < modes.length; ++i) {
            nft.setTransferMode(ids[1], modes[i]);
            nft.setCallback(address(vault), abi.encodeCall(conversion.returnItems, (list, 0, block.timestamp)));
            bytes32 beforeState = _stateHash();
            vm.prank(ALICE);
            vm.expectRevert();
            conversion.withdrawBatch(list, 100003, block.timestamp);
            assertEq(_stateHash(), beforeState);
            assertFalse(vault.isOutside(ids[0]));
            assertFalse(vault.isOutside(ids[1]));
            assertEq(nft.actualOwner(ids[0]), address(vault));
            assertEq(nft.actualOwner(ids[1]), address(vault));
        }
        nft.setTransferMode(ids[1], HostileERC721.TransferMode.HugeReturn);
        _pick(0, 2); // a huge successful response is discarded
        _invariants(0);
    }

    function test_hostileReturnLastTransferRollsBackEarlierReceiptAndAllMoney() public {
        _ready(10, 100003, true);
        HostileERC721 nft = HostileERC721(collection);
        _pick(0, 2);
        uint256[] memory list = _list(0, 2);
        for (uint256 i = 1; i <= uint256(HostileERC721.TransferMode.HugeRevert); ++i) {
            if (i == uint256(HostileERC721.TransferMode.HugeReturn)) continue;
            nft.setTransferMode(ids[1], HostileERC721.TransferMode(i));
            nft.setCallback(address(vault), abi.encodeCall(conversion.withdrawBatch, (list, 0, block.timestamp)));
            bytes32 beforeState = _stateHash();
            vm.prank(ALICE);
            vm.expectRevert();
            conversion.returnItems(list, 0, block.timestamp);
            assertEq(_stateHash(), beforeState);
            assertTrue(vault.isOutside(ids[0]));
            assertTrue(vault.isOutside(ids[1]));
            assertEq(nft.actualOwner(ids[0]), ALICE);
            assertEq(nft.actualOwner(ids[1]), ALICE);
        }
        nft.setTransferMode(ids[1], HostileERC721.TransferMode.HugeReturn);
        _return(0, 2);
        _invariants(0);
    }

    function test_returnRepeatsAdmissionAndOwnerObservations() public {
        _ready(10, 100003, true);
        HostileERC721 nft = HostileERC721(collection);
        _pick(0, 2);
        uint256[] memory list = _list(0, 2);
        bytes32 beforeState = _stateHash();
        nft.setSupports5192(true);
        nft.setLocked(ids[1], true);
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(SetRefused.selector, R.LOCK_REFUSED, 10));
        conversion.returnItems(list, 0, block.timestamp);
        assertEq(_stateHash(), beforeState);
        assertEq(nft.actualOwner(ids[0]), ALICE);
        nft.setLocked(ids[1], false);
        bytes memory probe = abi.encodeWithSignature("getTransferValidator()");
        nft.setReply(probe, HostileERC721.ReplyMode.Return, 0, 32);
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(SetRefused.selector, R.TRANSFER_VALIDATOR, 10));
        conversion.returnItems(list, 0, block.timestamp);
        assertEq(_stateHash(), beforeState);
        nft.setReply(probe, HostileERC721.ReplyMode.Default, 0, 0);
        nft.setPaused(true);
        vm.prank(ALICE);
        vm.expectRevert(CustodyVault.TransferRefused.selector);
        conversion.returnItems(list, 0, block.timestamp);
        assertEq(_stateHash(), beforeState);
        nft.setPaused(false);
        nft.setReply(abi.encodeWithSignature("ownerOf(uint256)", ids[1]), HostileERC721.ReplyMode.Return, 1, 65536);
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(SetRefused.selector, R.OWNER_MISMATCH, 10));
        conversion.returnItems(list, 0, block.timestamp);
        assertEq(nft.actualOwner(ids[0]), ALICE);
        assertEq(_stateHash(), beforeState);
    }

    function test_metadataAndPoolQuotesNeverConsulted() public {
        _ready(10, 100003, true);
        HostileERC721 nft = HostileERC721(collection);
        // Any hook/router/pool read now fails; graduation was the last required use.
        vm.etch(address(hook), hex"60006000fd");
        vm.etch(box.launchRouter(), hex"60006000fd");
        vm.etch(address(pm), hex"60006000fd");
        nft.setMetadata(999, true, 0);
        assertEq(conversion.quoteWithdraw(2), 20001);
        _pick(0, 2);
        nft.setMetadata(1000, false, 1_000_000);
        assertEq(conversion.quoteReturn(2), 19750);
        _return(0, 2);
        _invariants(0);
    }

    function test_sharedLockAcrossEveryMutatingEntryDuringPickAndReturn() public {
        _ready(10, 100003, true);
        HostileERC721 nft = HostileERC721(collection);
        SetReentryRecorder recorder = new SetReentryRecorder();
        uint256[] memory list = _list(0, 1);
        bytes[] memory calls = new bytes[](6);
        calls[0] = abi.encodeCall(conversion.withdrawBatch, (list, 0, block.timestamp));
        calls[1] = abi.encodeCall(conversion.returnItems, (list, 0, block.timestamp));
        calls[2] = abi.encodeCall(vault.loadStarter, (collection, ids[0], uint8(0)));
        calls[3] = abi.encodeCall(vault.enterFailure, ());
        calls[4] = abi.encodeCall(vault.openGate, ());
        calls[5] = abi.encodeCall(vault.initialize, ());
        nft.setTransferMode(ids[0], HostileERC721.TransferMode.Reenter);
        for (uint256 i; i < calls.length; ++i) {
            nft.setCallback(address(recorder), abi.encodeCall(recorder.attempt, (address(vault), calls[i])));
            _pick(0, 1);
            assertEq(recorder.refusal(), TransientReentrancyGuard.Reentrancy.selector);
            _return(0, 1);
            assertEq(recorder.refusal(), TransientReentrancyGuard.Reentrancy.selector);
        }
        _invariants(0);
    }

    function test_recipientRefusalRollsBackMoney() public {
        _ready(10, 100003, true);
        // Code without an ERC721 receiver must veto normal safe picks, including all monetary changes.
        vm.etch(ALICE, hex"60006000fd");
        bytes32 beforeState = _stateHash();
        uint256[] memory list = _list(0, 1);
        vm.prank(ALICE);
        vm.expectRevert(CustodyVault.TransferRefused.selector);
        conversion.withdrawBatch(list, 100003, block.timestamp);
        assertEq(_stateHash(), beforeState);
    }
}
