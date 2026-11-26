// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {AuditU6LaneBase, AuditU6LaneArt} from "./AuditU6LaneBase.sol";
import {BoxTickets} from "../../../../src/box/BoxTickets.sol";
import {BoxToken} from "../../../../src/box/BoxToken.sol";
import {IBoxTickets} from "../../../../src/box/interfaces/IBoxTickets.sol";
import {ItemReveal} from "../../../../src/box/interfaces/BoxTypes.sol";
import {TransientReentrancyGuard} from "../../../../src/libraries/TransientReentrancyGuard.sol";

/// @notice Adversarial ERC-721 receiver: callback into all five requested entrypoints, observing final ownership.
contract AuditU6LaneCallback {
    BoxTickets internal immutable p;
    AuditU6LaneArt internal immutable art;
    address internal immutable collection;
    bool public sawFinalOwner;
    bool public took;
    bool public handedBack;
    bool public drew;
    bool public settled;
    bool public opened;
    bool public reused;
    uint256 public lockedCalls;
    uint256 public slot;

    constructor(BoxTickets p_, AuditU6LaneArt art_, address collection_) {
        p = p_;
        art = art_;
        collection = collection_;
        BoxToken(p_.token()).approve(address(p_), type(uint256).max);
    }

    function onERC721Received(address, address from, uint256 id, bytes calldata) external returns (bytes4) {
        if (msg.sender == collection) {
            // open has already burned the placeholder and decremented the holder balance before item delivery.
            (bool live,) = address(p).staticcall(abi.encodeCall(p.ownerOf, (1)));
            require(!live, "burn visible in nested receipt");
            bytes[] memory calls = _calls(1);
            for (uint256 i; i < calls.length; ++i) {
                (bool ok, bytes memory reason) = address(p).call(calls[i]);
                require(!ok && bytes4(reason) == TransientReentrancyGuard.Reentrancy.selector, "lock missing");
                ++lockedCalls;
            }
            return this.onERC721Received.selector;
        }
        require(msg.sender == address(p));
        sawFinalOwner = p.ownerOf(id) == address(this) && p.balanceOf(address(this)) == 1 && p.balanceOf(from) == 0;
        slot = p.slotOf(id);
        bytes[] memory calls = _calls(id);
        (took,) = address(p).call(calls[0]);
        (handedBack,) = address(p).call(calls[1]);
        if (handedBack) (reused,) = address(p).call(calls[1]);
        (drew,) = address(p).call(calls[2]);
        (settled,) = address(p).call(calls[3]);
        (opened,) = address(p).call(calls[4]);
        if (opened) (reused,) = address(p).call(calls[4]);
        return this.onERC721Received.selector;
    }

    function _calls(uint256 id) internal view returns (bytes[] memory calls) {
        calls = new bytes[](5);
        calls[0] = abi.encodeCall(p.take, (1, type(uint256).max, block.timestamp));
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        calls[1] = abi.encodeCall(p.handBack, (ids, 0, block.timestamp));
        calls[2] = abi.encodeCall(p.draw, (type(uint256).max, block.timestamp));
        calls[3] = abi.encodeCall(p.settle, (8));
        ItemReveal memory r;
        try p.numberOf(id) returns (uint256 number) {
            if (number != 0) r = art.reveal(number);
        } catch {}
        calls[4] = abi.encodeCall(p.open, (id, r));
    }
}

/// forge-config: default.evm_version = "osaka"
contract AuditU6LaneCallbacks is AuditU6LaneBase {
    function testProperty_AUDIT_U6_curveReceiptCanTakeAndReturnOnlyOnce() public {
        AuditU6LaneCallback receiver = new AuditU6LaneCallback(tickets, art, a.collection);
        _fund(address(receiver));
        vm.prank(alice);
        tickets.safeTransferFrom(alice, address(receiver), 1);
        assertTrue(receiver.sawFinalOwner());
        assertTrue(receiver.took());
        assertTrue(receiver.handedBack());
        assertFalse(receiver.reused());
        assertFalse(receiver.drew());
        assertFalse(receiver.settled());
        assertFalse(receiver.opened());
        assertEq(tickets.status().minted, 2);
        assertEq(tickets.status().slots, 1);
        assertEq(tickets.slotOf(2), 0, "new token compacted into the returned slot");
        assertEq(vault.pendingTickets(), 1);
        _empty();
    }

    function testProperty_AUDIT_U6_knownReceiptCanDrawSettleAndOpenOnlyOnce() public {
        _ready();
        _draw(bob, 0);
        _postRound(4); // a pending draw can settle during the placeholder receipt
        AuditU6LaneCallback receiver = new AuditU6LaneCallback(tickets, art, a.collection);
        _fund(address(receiver));
        uint256 number = tickets.numberOf(1);
        vm.prank(alice);
        tickets.safeTransferFrom(alice, address(receiver), 1);
        assertTrue(receiver.sawFinalOwner());
        assertFalse(receiver.took());
        assertFalse(receiver.handedBack());
        assertTrue(receiver.drew());
        assertTrue(receiver.settled());
        assertTrue(receiver.opened());
        assertFalse(receiver.reused());
        assertEq(receiver.lockedCalls(), 5);
        assertEq(collection.ownerOf(number), address(receiver));
        assertEq(tickets.balanceOf(address(receiver)), 0);
        assertEq(vault.pendingTickets(), 2);
        _empty();
    }
}
