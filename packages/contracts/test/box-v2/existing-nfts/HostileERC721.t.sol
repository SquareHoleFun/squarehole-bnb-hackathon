// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {SetAdmissionV2} from "../../../src/box-v2/set/SetAdmissionV2.sol";
import {SetRefused} from "../../../src/box-v2/set/SetTypesV2.sol";
import {HostileERC721} from "./fixtures/HostileERC721.sol";

/// @dev A receipt recorder, deliberately NOT a vault or a guard implementation.
contract ReceiptRecorder {
    uint256 public receipts;
    address public operator;
    address public from;
    uint256 public id;
    uint256 public reentries;
    bool public reject;

    function setReject(bool value) external {
        reject = value;
    }

    function reenter() external {
        ++reentries;
    }

    function onERC721Received(address operator_, address from_, uint256 id_, bytes calldata) external returns (bytes4) {
        require(!reject, "reject");
        ++receipts;
        operator = operator_;
        from = from_;
        id = id_;
        return 0x150b7a02;
    }

    function checkIntake(address nft, uint256 id_) external view {
        SetAdmissionV2.requireToken(nft, id_);
    }
}

contract NonReceiverCreator {}

/// @notice Proves the hostile fixture behaviours are real, so E-03..E-05 can reuse them.
/// @dev These tests assert the attacks themselves, not vault resistance or financial rollback.
contract HostileERC721Test is Test {
    HostileERC721 private nft;
    ReceiptRecorder private recipient;

    function setUp() public {
        nft = new HostileERC721();
        recipient = new ReceiptRecorder();
    }

    function test_E02_fixtureApprovalTransfersAndUnsafeGift() public {
        nft.mint(address(this), 0);
        nft.approve(address(0xbeef), 0);
        vm.prank(address(0xbeef));
        nft.safeTransferFrom(address(this), address(recipient), 0);
        assertEq(nft.actualOwner(0), address(recipient));
        assertEq(nft.getApproved(0), address(0));
        assertEq(recipient.receipts(), 1);
        assertEq(recipient.operator(), address(0xbeef));
        assertEq(recipient.from(), address(this));
        assertEq(recipient.id(), 0);
        nft.mint(address(this), type(uint256).max);
        nft.transferFrom(address(this), address(recipient), type(uint256).max);
        assertEq(nft.actualOwner(type(uint256).max), address(recipient));
        assertEq(recipient.receipts(), 1); // unsafe gifts bypass the receiver entirely
    }

    function test_E02_fixtureEveryTransferAttack() public {
        for (uint256 i; i <= uint256(HostileERC721.TransferMode.HugeRevert); ++i) {
            HostileERC721.TransferMode mode = HostileERC721.TransferMode(i);
            ReceiptRecorder sink = new ReceiptRecorder();
            nft.mint(address(this), i);
            nft.setTransferMode(i, mode);
            nft.setCallback(address(sink), abi.encodeCall(sink.reenter, ()));
            bytes memory data =
                abi.encodeWithSignature("safeTransferFrom(address,address,uint256)", address(this), address(sink), i);
            // Recorder writes several fresh slots: allow Amsterdam state gas. This is NOT a vault transfer cap.
            (bool ok, uint256 size) = _boundedCall(address(nft), data, 1_000_000);
            bool fails = mode == HostileERC721.TransferMode.Revert || mode == HostileERC721.TransferMode.BurnGas
                || mode == HostileERC721.TransferMode.HugeRevert;
            assertEq(ok, !fails);
            bool noMove = fails || mode == HostileERC721.TransferMode.NoOp
                || mode == HostileERC721.TransferMode.CallbackWithoutTransfer;
            assertEq(nft.actualOwner(i), noMove ? address(this) : address(sink));
            uint256 receipts = fails || mode == HostileERC721.TransferMode.NoOp
                || mode == HostileERC721.TransferMode.MissingReceipt
                ? 0
                : (mode == HostileERC721.TransferMode.DuplicateReceipt ? 2 : 1);
            assertEq(sink.receipts(), receipts);
            if (receipts != 0) {
                assertEq(sink.operator(), mode == HostileERC721.TransferMode.WrongOperator ? address(0) : address(this));
                assertEq(sink.from(), mode == HostileERC721.TransferMode.WrongFrom ? address(0) : address(this));
                assertEq(sink.id(), mode == HostileERC721.TransferMode.WrongId ? i ^ 1 : i);
            }
            assertEq(sink.reentries(), mode == HostileERC721.TransferMode.Reenter ? 1 : 0);
            if (mode == HostileERC721.TransferMode.HugeReturn || mode == HostileERC721.TransferMode.HugeRevert) {
                assertEq(size, 65_536);
            }
        }
    }

    function test_E02_fixtureSpoofedUnsolicitedReceiptAndReceiverRefusal() public {
        nft.spoofReceipt(address(recipient), address(0xbad), address(0xcafe), 99);
        assertEq(recipient.receipts(), 1);
        assertEq(recipient.operator(), address(0xbad));
        assertEq(recipient.from(), address(0xcafe));
        assertEq(recipient.id(), 99);
        assertEq(nft.actualOwner(99), address(0));
        nft.mint(address(this), 99);
        recipient.setReject(true);
        vm.expectRevert(bytes("reject"));
        nft.safeTransferFrom(address(this), address(recipient), 99);
        assertEq(nft.actualOwner(99), address(this));
    }

    function test_E02_fixtureCreatorWithoutReceiverUsesTransferFrom() public {
        NonReceiverCreator creator = new NonReceiverCreator();
        nft.mint(address(this), 1);
        vm.expectRevert();
        nft.safeTransferFrom(address(this), address(creator), 1);
        assertEq(nft.actualOwner(1), address(this));
        nft.transferFrom(address(this), address(creator), 1);
        assertEq(nft.actualOwner(1), address(creator));
    }

    function test_E02_fixtureLockChangedAfterCustodyAndPauseSeizeBurn() public {
        nft.setSupports5192(true);
        nft.mint(address(this), 1);
        recipient.checkIntake(address(nft), 1);
        nft.safeTransferFrom(address(this), address(recipient), 1);
        nft.setLocked(1, true);
        vm.expectRevert(abi.encodeWithSelector(SetRefused.selector, uint16(39), uint16(10)));
        recipient.checkIntake(address(nft), 1);
        vm.prank(address(recipient));
        vm.expectRevert(bytes("restricted"));
        nft.transferFrom(address(recipient), address(this), 1);
        nft.setLocked(1, false);
        recipient.checkIntake(address(nft), 1);
        nft.setPaused(true);
        recipient.checkIntake(address(nft), 1); // admission cannot detect arbitrary pauses
        vm.prank(address(recipient));
        vm.expectRevert(bytes("restricted"));
        nft.transferFrom(address(recipient), address(this), 1);
        nft.seize(1, address(this));
        assertEq(nft.actualOwner(1), address(this));
        nft.burn(1);
        assertEq(nft.actualOwner(1), address(0));
    }

    function test_E02_fixtureHugeProbeReallySucceedsInside30000Gas() public {
        bytes memory data = abi.encodeWithSignature("supportsInterface(bytes4)", bytes4(0x01ffc9a7));
        nft.setReply(data, HostileERC721.ReplyMode.Return, 1, 65_536);
        vm.cool(address(nft));
        (bool ok, uint256 size) = _boundedCall(address(nft), data, 30_000);
        assertTrue(ok);
        assertEq(size, 65_536);
        nft.setReply(data, HostileERC721.ReplyMode.Revert, 1, 65_536);
        (ok, size) = _boundedCall(address(nft), data, 30_000);
        assertFalse(ok);
        assertEq(size, 65_536);
    }

    function test_E02_fixtureMetadataMutatesRevertsAndGrows() public {
        bytes memory data = abi.encodeWithSignature("tokenURI(uint256)", uint256(1));
        nft.setMetadata(1, false, 32);
        (bool ok, bytes memory first) = address(nft).call(data);
        assertTrue(ok);
        assertEq(abi.decode(first, (uint256)), 1);
        nft.setMetadata(2, false, 32);
        (, bytes memory second) = address(nft).call(data);
        assertEq(abi.decode(second, (uint256)), 2);
        nft.setMetadata(3, true, 32);
        (ok,) = address(nft).call(data);
        assertFalse(ok);
        nft.setMetadata(4, false, 65_536);
        uint256 size;
        (ok, size) = _boundedCall(address(nft), data, 60_000);
        assertTrue(ok);
        assertEq(size, 65_536);
    }

    function _boundedCall(address target, bytes memory data, uint256 cap) private returns (bool ok, uint256 size) {
        assembly ("memory-safe") {
            ok := call(cap, target, 0, add(data, 32), mload(data), 0, 0)
            size := returndatasize()
        }
    }
}
