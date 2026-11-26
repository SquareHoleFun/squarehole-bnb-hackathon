// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {SetFailureFixture, RecoveryVault} from "./SetFailureFixture.sol";
import {HostileERC721} from "./fixtures/HostileERC721.sol";
import {SetReentryRecorder} from "./SetVaultFixture.sol";
import {TransientReentrancyGuard} from "../../../src/libraries/TransientReentrancyGuard.sol";
import {Vm} from "forge-std/Vm.sol";

contract SetFailureHostileTest is SetFailureFixture {
    function test_revertingAndGasBurningIdsDoNotBlockOthersAndRetryExactlyOnce() public {
        _start(10, 10, true);
        HostileERC721 nft = HostileERC721(collection);
        _failClosed();
        nft.setTransferMode(ids[0], HostileERC721.TransferMode.Revert);
        nft.setTransferMode(ids[5], HostileERC721.TransferMode.BurnGas);
        vm.recordLogs();
        assertEq(recovery().releaseToCreator(_list(0, 10)), 8);
        _events(8, 2);
        assertEq(vault.inside(), 2);
        assertEq(nft.actualOwner(ids[0]), address(vault));
        assertEq(nft.actualOwner(ids[5]), address(vault));
        for (uint256 i; i < 10; ++i) {
            if (i != 0 && i != 5) assertEq(nft.actualOwner(ids[i]), CREATOR);
        }
        nft.setTransferMode(ids[0], HostileERC721.TransferMode.Normal);
        nft.setTransferMode(ids[5], HostileERC721.TransferMode.Normal);
        vm.recordLogs();
        assertEq(recovery().releaseToCreator(_list(0, 10)), 2);
        _events(2, 8);
        assertEq(vault.inside(), 0);
        assertEq(recovery().releaseToCreator(_list(0, 10)), 0);
        assertEq(token.balanceOf(CREATOR), 0);
    }

    function test_noOpHugeRevertAndDishonestPostOwnerRollBackOnlyTheirItem() public {
        _start(10, 10, true);
        HostileERC721 nft = HostileERC721(collection);
        _failClosed();
        nft.setTransferMode(ids[0], HostileERC721.TransferMode.NoOp);
        nft.setTransferMode(ids[1], HostileERC721.TransferMode.HugeRevert);
        nft.setReply(
            abi.encodeWithSignature("ownerOf(uint256)", ids[2]),
            HostileERC721.ReplyMode.Return,
            uint160(address(vault)),
            32
        ); // Precheck passes, postcheck must undo the actual transfer.
        nft.setTransferMode(ids[3], HostileERC721.TransferMode.HugeReturn);
        assertEq(recovery().releaseToCreator(_list(0, 10)), 7);
        assertEq(vault.inside(), 3);
        for (uint256 i; i < 3; ++i) {
            assertEq(nft.actualOwner(ids[i]), address(vault));
        }
        nft.setTransferMode(ids[0], HostileERC721.TransferMode.Normal);
        nft.setTransferMode(ids[1], HostileERC721.TransferMode.Normal);
        nft.setReply(abi.encodeWithSignature("ownerOf(uint256)", ids[2]), HostileERC721.ReplyMode.Default, 0, 0);
        assertEq(recovery().releaseToCreator(_list(0, 3)), 3);
    }

    function test_seizedBurnedAndOwnerProbeFailuresStayCountedAndRetryable() public {
        _start(10, 10, true);
        HostileERC721 nft = HostileERC721(collection);
        _failClosed();
        nft.seize(ids[0], ALICE);
        nft.burn(ids[1]);
        nft.setReply(abi.encodeWithSignature("ownerOf(uint256)", ids[2]), HostileERC721.ReplyMode.BurnGas, 0, 0);
        nft.setReply(abi.encodeWithSignature("ownerOf(uint256)", ids[3]), HostileERC721.ReplyMode.Return, 0, 65_536);
        assertEq(recovery().releaseToCreator(_list(0, 10)), 6);
        assertEq(vault.inside(), 4);
        assertFalse(vault.isOutside(ids[0]));
        nft.seize(ids[0], address(vault));
        nft.mint(address(vault), ids[1]);
        nft.setReply(abi.encodeWithSignature("ownerOf(uint256)", ids[2]), HostileERC721.ReplyMode.Default, 0, 0);
        nft.setReply(abi.encodeWithSignature("ownerOf(uint256)", ids[3]), HostileERC721.ReplyMode.Default, 0, 0);
        assertEq(recovery().releaseToCreator(_list(0, 4)), 4);
        assertEq(vault.inside(), 0);
    }

    function test_recoveryDoesNotRepeatAdmissionAndPauseOnlyDefersTransfers() public {
        _start(10, 10, true);
        HostileERC721 nft = HostileERC721(collection);
        _failClosed();
        nft.setReply(abi.encodeWithSignature("getTransferValidator()"), HostileERC721.ReplyMode.Return, 0, 32);
        nft.setReply(
            abi.encodeWithSignature("supportsInterface(bytes4)", bytes4(0x01ffc9a7)),
            HostileERC721.ReplyMode.BurnGas,
            0,
            0
        );
        nft.setSupports5192(true);
        nft.setReply(abi.encodeWithSignature("locked(uint256)", ids[0]), HostileERC721.ReplyMode.Return, 1, 32);
        nft.setMetadata(9, true, 65_536);
        nft.setPaused(true);
        assertEq(recovery().releaseToCreator(_list(0, 10)), 0);
        assertEq(vault.inside(), 10);
        nft.setPaused(false);
        assertEq(recovery().releaseToCreator(_list(0, 10)), 10);
    }

    function test_recoverySharesLockWithEveryMutationAndReceiptStaysDisarmed() public {
        _start(10, 10, true);
        _failClosed();
        HostileERC721 nft = HostileERC721(collection);
        SetReentryRecorder recorder = new SetReentryRecorder();
        bytes[] memory calls = new bytes[](7);
        calls[0] = abi.encodeCall(vault.initialize, ());
        calls[1] = abi.encodeCall(vault.loadStarter, (collection, ids[0], uint8(0)));
        calls[2] = abi.encodeCall(vault.openGate, ());
        calls[3] = abi.encodeCall(vault.enterFailure, ());
        calls[4] = abi.encodeCall(conversion.withdrawBatch, (_list(0, 1), type(uint256).max, block.timestamp));
        calls[5] = abi.encodeCall(conversion.returnItems, (_list(0, 1), 0, block.timestamp));
        calls[6] = abi.encodeCall(RecoveryVault.releaseToCreator, (_list(0, 1)));
        for (uint256 i; i < calls.length; ++i) {
            nft.setTransferMode(ids[i], HostileERC721.TransferMode.Reenter);
            nft.setCallback(address(recorder), abi.encodeCall(recorder.attempt, (address(vault), calls[i])));
            assertEq(recovery().releaseToCreator(_list(i, 1)), 1);
            assertEq(recorder.refusal(), TransientReentrancyGuard.Reentrancy.selector);
        }
        nft.setTransferMode(ids[7], HostileERC721.TransferMode.Reenter);
        nft.setCallback(address(vault), abi.encodeCall(RecoveryVault.releaseOne, (ids[8])));
        assertEq(recovery().releaseToCreator(_list(7, 1)), 0); // NFT cannot invoke the self-only entry.
        nft.setCallback(
            address(nft), abi.encodeCall(nft.spoofReceipt, (address(vault), address(vault), CREATOR, ids[7]))
        );
        assertEq(recovery().releaseToCreator(_list(7, 1)), 0);
        nft.setTransferMode(ids[7], HostileERC721.TransferMode.Normal);
        assertEq(recovery().releaseToCreator(_list(7, 3)), 3);
    }

    function _events(uint256 successes, uint256 deferred) private {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 foundSuccess;
        uint256 foundDeferred;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(vault)) continue;
            assertEq(logs[i].topics[1], bytes32(uint256(uint160(collection))));
            if (logs[i].topics[0] == keccak256("ReleaseSucceeded(address,uint256,address)")) {
                ++foundSuccess;
                assertEq(logs[i].topics[3], bytes32(uint256(uint160(CREATOR))));
            } else {
                assertEq(logs[i].topics[0], keccak256("ReleaseDeferred(address,uint256)"));
                ++foundDeferred;
            }
        }
        assertEq(foundSuccess, successes);
        assertEq(foundDeferred, deferred);
    }
}
