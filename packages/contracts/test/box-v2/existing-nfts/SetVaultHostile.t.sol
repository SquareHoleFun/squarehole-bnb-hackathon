// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {
    SetVaultFixture,
    CustodyVault,
    SetMeasuredERC721,
    SetSpendingERC721,
    SetReentryRecorder
} from "./SetVaultFixture.sol";
import {HostileERC721} from "./fixtures/HostileERC721.sol";
import {StarterSetLoaderV2} from "../../../src/box-v2/StarterSetLoaderV2.sol";
import {SetRefused} from "../../../src/box-v2/set/SetTypesV2.sol";
import {SetReason as R} from "../../../src/box-v2/set/SetConstantsV2.sol";
import {Vm} from "forge-std/Vm.sol";

contract SetVaultHostileTest is SetVaultFixture {
    function test_nearFullTransferCapReservesFirstCustodyWrites() public {
        SetSpendingERC721 nft = new SetSpendingERC721();
        _configure(address(nft), 10);
        ids[0] = 77; // First array entry must also allocate a nonzero slot.
        for (uint256 i; i < 10; ++i) {
            nft.mint(CREATOR, ids[i]);
        }
        _deploy(true);
        // Isolate the vault frame from the loader's own page costs. Authentication is bypassed only by prank;
        // no hostile contract can impersonate the real loader. Refusal must retain an explicit outer-gas error.
        vm.prank(address(loader));
        (bool ok, bytes memory reason) =
            address(vault).call{gas: 740_000}(abi.encodeCall(vault.loadStarter, (collection, ids[0], uint8(0))));
        assertFalse(ok);
        assertEq(reason, abi.encodeWithSelector(CustodyVault.TransferGas.selector));
        _progress(0, false);
        (address[] memory cs, uint256[] memory ns, uint8[] memory ts) = _pageData(0, 1);
        uint256 beforeGas = gasleft();
        vm.prank(CREATOR);
        loader.load{gas: 2_000_000}(cs, ns, ts, hashes[1]);
        emit log_named_uint("first page with near-full transfer cap (local harness)", beforeGas - gasleft());
        _progress(1, false);
        _page(1, 9);
        loader.complete();
    }

    function test_allHostileTransferModesRollBackLastItemAndRetryPage() public {
        HostileERC721 nft = _hostile(33);
        _deploy(true);
        for (uint256 i = 1; i <= uint256(HostileERC721.TransferMode.HugeRevert); ++i) {
            if (i == uint256(HostileERC721.TransferMode.HugeReturn)) continue;
            nft.setTransferMode(ids[31], HostileERC721.TransferMode(i));
            nft.setCallback(address(loader), abi.encodeCall(loader.complete, ()));
            vm.expectRevert();
            _page(0, 32);
            _progress(0, false);
            for (uint256 j; j < 32; ++j) {
                assertEq(nft.actualOwner(ids[j]), CREATOR);
                assertFalse(vault.eligible(ids[j]));
            }
            assertFalse(vault.seedReady());
            assertFalse(box.gateOpen());
        }
        nft.setTransferMode(ids[31], HostileERC721.TransferMode.Normal);
        _page(0, 32);
        _progress(32, false);
        nft.setTransferMode(ids[32], HostileERC721.TransferMode.Revert);
        vm.expectRevert(CustodyVault.TransferRefused.selector);
        _page(32, 1);
        _progress(32, false);
        nft.setTransferMode(ids[32], HostileERC721.TransferMode.Normal);
        _page(32, 1);
        loader.complete();
        _progress(33, true);
    }

    function test_receiptRequiredAndPostTransferOwnershipRequired() public {
        HostileERC721 nft = _hostile(10);
        _deploy(true);
        nft.setTransferMode(ids[0], HostileERC721.TransferMode.MissingReceipt);
        vm.expectRevert(CustodyVault.ReceiptRefused.selector);
        _page(0, 10);
        _progress(0, false);
        nft.setTransferMode(ids[0], HostileERC721.TransferMode.NoOp);
        vm.expectRevert(CustodyVault.ReceiptRefused.selector);
        _page(0, 10);
        _progress(0, false);
        nft.setTransferMode(ids[0], HostileERC721.TransferMode.CallbackWithoutTransfer);
        vm.expectRevert(abi.encodeWithSelector(SetRefused.selector, R.OWNER_MISMATCH, uint16(10)));
        _page(0, 10);
        _progress(0, false);
    }

    function test_receiptCannotBeSpoofedBeforeOrAfterPull() public {
        HostileERC721 nft = _hostile(10);
        _deploy(true);
        vm.expectRevert(CustodyVault.ReceiptRefused.selector);
        nft.spoofReceipt(address(vault), address(vault), CREATOR, ids[0]);
        vm.expectRevert(CustodyVault.ReceiptRefused.selector);
        vault.onERC721Received(address(vault), CREATOR, ids[0], "");
        _page(0, 10);
        vm.expectRevert(CustodyVault.ReceiptRefused.selector);
        nft.spoofReceipt(address(vault), address(vault), CREATOR, ids[9]);
        _progress(10, false);
    }

    function test_wrongCollectionCannotSpoofDuringArmedPull() public {
        HostileERC721 nft = _hostile(10);
        _deploy(true);
        HostileERC721 other = new HostileERC721();
        nft.setTransferMode(ids[0], HostileERC721.TransferMode.Reenter);
        nft.setCallback(
            address(other), abi.encodeCall(other.spoofReceipt, (address(vault), address(vault), CREATOR, ids[0]))
        );
        vm.expectRevert(CustodyVault.TransferRefused.selector);
        _page(0, 10);
        _progress(0, false);
    }

    function test_reentryIntoEveryVaultMutationAndLoaderCompletion() public {
        HostileERC721 nft = _hostile(10);
        _deploy(true);
        nft.setTransferMode(ids[9], HostileERC721.TransferMode.Reenter);
        bytes[] memory calls = new bytes[](4);
        calls[0] = abi.encodeCall(vault.initialize, ());
        calls[1] = abi.encodeCall(vault.loadStarter, (collection, ids[9], uint8(0)));
        calls[2] = abi.encodeCall(vault.openGate, ());
        calls[3] = abi.encodeCall(vault.enterFailure, ());
        for (uint256 i; i < calls.length; ++i) {
            nft.setCallback(address(vault), calls[i]);
            vm.expectCall(address(vault), calls[i]);
            vm.expectRevert(CustodyVault.TransferRefused.selector);
            _page(0, 10);
            _progress(0, false);
        }
        nft.setCallback(address(loader), abi.encodeCall(loader.complete, ()));
        vm.expectRevert(CustodyVault.TransferRefused.selector);
        _page(0, 10);
        _progress(0, false);
        (address[] memory cs, uint256[] memory ns, uint8[] memory ts) = _pageData(0, 10);
        nft.setCallback(address(loader), abi.encodeCall(loader.load, (cs, ns, ts, bytes32(0))));
        vm.expectRevert(CustodyVault.TransferRefused.selector);
        _page(0, 10);
        _progress(0, false);
        nft.setTransferMode(ids[9], HostileERC721.TransferMode.Normal);
        _page(0, 10);
    }

    function test_sharedLockCausesCaughtReentryRefusals() public {
        HostileERC721 nft = _hostile(10);
        _deploy(true);
        SetReentryRecorder recorder = new SetReentryRecorder();
        bytes[] memory calls = new bytes[](6);
        calls[0] = abi.encodeCall(vault.initialize, ());
        calls[1] = abi.encodeCall(vault.loadStarter, (collection, ids[9], uint8(0)));
        calls[2] = abi.encodeCall(vault.openGate, ());
        calls[3] = abi.encodeCall(vault.enterFailure, ());
        calls[4] = abi.encodeCall(loader.complete, ());
        (address[] memory cs, uint256[] memory ns, uint8[] memory ts) = _pageData(0, 1);
        calls[5] = abi.encodeCall(loader.load, (cs, ns, ts, hashes[1]));
        for (uint256 i; i < calls.length; ++i) {
            nft.setTransferMode(ids[i], HostileERC721.TransferMode.Reenter);
            nft.setCallback(
                address(recorder),
                abi.encodeCall(recorder.attempt, (i < 4 ? address(vault) : address(loader), calls[i]))
            );
            _page(i, 1);
            assertEq(recorder.refusal(), bytes4(keccak256("Reentrancy()")));
            _progress(i + 1, false);
        }
        _page(6, 4);
        loader.complete();
    }

    function test_approvalFromAnotherOwnerCannotReplaceCreatorOwnership() public {
        HostileERC721 nft = _hostile(10);
        _deploy(true);
        nft.seize(ids[9], ALICE);
        vm.prank(ALICE);
        nft.approve(address(vault), ids[9]);
        vm.expectRevert(abi.encodeWithSelector(SetRefused.selector, R.OWNER_MISMATCH, uint16(10)));
        _page(0, 10);
        _progress(0, false);
        assertEq(nft.actualOwner(ids[9]), ALICE);
    }

    function test_admissionRechecksValidatorInterfacesAndLocksAfterEarlierPage() public {
        HostileERC721 nft = _hostile(33);
        _deploy(true);
        _page(0, 32);
        bytes memory validator = abi.encodeWithSignature("getTransferValidator()");
        nft.setReply(validator, HostileERC721.ReplyMode.Return, 0, 32);
        vm.expectRevert(abi.encodeWithSelector(SetRefused.selector, R.TRANSFER_VALIDATOR, uint16(10)));
        _page(32, 1);
        _progress(32, false);
        nft.setReply(validator, HostileERC721.ReplyMode.Default, 0, 0);
        bytes memory erc165 = abi.encodeWithSignature("supportsInterface(bytes4)", bytes4(0x01ffc9a7));
        nft.setReply(erc165, HostileERC721.ReplyMode.Return, 2, 32);
        vm.expectRevert(abi.encodeWithSelector(SetRefused.selector, R.INTERFACE_REFUSED, uint16(10)));
        _page(32, 1);
        _progress(32, false);
        nft.setReply(erc165, HostileERC721.ReplyMode.Default, 0, 0);
        nft.setSupports5192(true);
        nft.setLocked(ids[32], true);
        vm.expectRevert(abi.encodeWithSelector(SetRefused.selector, R.LOCK_REFUSED, uint16(10)));
        _page(32, 1);
        _progress(32, false);
        nft.setLocked(ids[32], false);
        _page(32, 1);
        loader.complete();
    }

    function test_admissionRechecksWithinSamePage() public {
        HostileERC721 nft = _hostile(10);
        _deploy(true);
        nft.setTransferMode(ids[0], HostileERC721.TransferMode.Reenter);
        nft.setCallback(
            address(nft),
            abi.encodeCall(
                nft.setReply, (abi.encodeWithSignature("getTransferValidator()"), HostileERC721.ReplyMode.Return, 0, 32)
            )
        );
        vm.expectRevert(abi.encodeWithSelector(SetRefused.selector, R.TRANSFER_VALIDATOR, uint16(10)));
        _page(0, 10);
        _progress(0, false);
        assertEq(nft.actualOwner(ids[0]), CREATOR);
    }

    function test_hugeTransferReturnIgnoredAndHugeRevertNotBubbled() public {
        HostileERC721 nft = _hostile(10);
        _deploy(true);
        nft.setTransferMode(ids[9], HostileERC721.TransferMode.HugeRevert);
        vm.expectRevert(CustodyVault.TransferRefused.selector);
        _page(0, 10);
        _progress(0, false);
        for (uint256 i; i < 10; ++i) {
            nft.setTransferMode(ids[i], HostileERC721.TransferMode.HugeReturn);
        }
        _page(0, 10);
        loader.complete();
        _progress(10, true);
    }

    function test_malformedAndGasBurningOwnerReadsRefuseWithoutProgress() public {
        HostileERC721 nft = _hostile(10);
        _deploy(true);
        bytes memory owner = abi.encodeWithSignature("ownerOf(uint256)", ids[9]);
        nft.setReply(owner, HostileERC721.ReplyMode.Return, uint160(CREATOR), 65_536);
        vm.expectRevert(abi.encodeWithSelector(SetRefused.selector, R.OWNER_MISMATCH, uint16(10)));
        _page(0, 10);
        _progress(0, false);
        nft.setReply(owner, HostileERC721.ReplyMode.BurnGas, 0, 0);
        vm.expectRevert(abi.encodeWithSelector(SetRefused.selector, R.OWNER_MISMATCH, uint16(10)));
        _page(0, 10);
        _progress(0, false);
    }

    function test_metadataAndIssuerSeizureCannotChangeRecordedMembership() public {
        HostileERC721 nft = _hostile(33);
        _deploy(true);
        _page(0, 32);
        nft.setMetadata(99, true, 1_000_000);
        nft.seize(ids[0], ALICE);
        assertTrue(vault.eligible(ids[0]));
        assertFalse(vault.isOutside(ids[0]));
        assertEq(vault.inside(), 32);
        _page(32, 1);
        assertTrue(vault.seedReady());
        loader.complete();
        // Completion is a proof of recorded guarded deposits, not perpetual truth from issuer-controlled code.
        assertEq(nft.actualOwner(ids[0]), ALICE);
        assertEq(vault.inside(), 33);
    }

    function test_transferCapAndLowOuterGasRefusal() public {
        SetMeasuredERC721 nft = new SetMeasuredERC721();
        _configure(address(nft), 10);
        for (uint256 i; i < 10; ++i) {
            nft.mint(CREATOR, ids[i]);
        }
        _deploy(true);
        (address[] memory cs, uint256[] memory ns, uint8[] memory ts) = _pageData(0, 1);
        vm.prank(CREATOR);
        (bool ok, bytes memory reason) =
            address(loader).call{gas: 1_200_000}(abi.encodeCall(loader.load, (cs, ns, ts, hashes[1])));
        assertFalse(ok);
        assertEq(reason, abi.encodeWithSelector(CustodyVault.TransferGas.selector));
        _progress(0, false);
        vm.recordLogs();
        _page(0, 1);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 entry;
        uint256 used;
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].emitter == address(nft)
                    && logs[i].topics[0] == keccak256("TransferGasMeasured(uint256,uint256)")
            ) {
                (entry, used) = abi.decode(logs[i].data, (uint256, uint256));
            }
        }
        assertLe(entry, 450_000);
        assertGt(entry, 445_000);
        emit log_named_uint("standard transfer plus receipt (excluding telemetry log)", used);
        emit log_named_uint("transfer gas at collection entry", entry);
        _page(1, 9);
        loader.complete();
    }
}
