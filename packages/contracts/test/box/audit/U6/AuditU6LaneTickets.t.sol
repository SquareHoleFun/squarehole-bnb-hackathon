// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AuditU6LaneBase} from "./AuditU6LaneBase.sol";
import {BoxHook} from "../../../../src/box/BoxHook.sol";
import {BoxTickets} from "../../../../src/box/BoxTickets.sol";
import {BoxToken} from "../../../../src/box/BoxToken.sol";
import {DrawStatus, ItemReveal} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxTickets} from "../../../../src/box/interfaces/IBoxTickets.sol";
import {IBoxCollection} from "../../../../src/box/interfaces/IBoxCollection.sol";
import {IBoxVault} from "../../../../src/box/interfaces/IBoxVault.sol";
import {BackedSourcePins} from "../../../../src/box/randomness/BackedSourcePins.sol";
import {BoxShuffle} from "../../../../src/box/libraries/BoxShuffle.sol";

/// @notice Adversarial payee only: rejects refunds but can receive an NFT and choose a draw recipient.
contract AuditU6LaneDrawer {
    function draw(BoxTickets p, BoxToken t, uint256 value) external returns (uint256) {
        t.approve(address(p), type(uint256).max);
        return p.draw{value: value}(type(uint256).max, block.timestamp);
    }

    function open(BoxTickets p, uint256 id, address to, ItemReveal calldata r) external {
        p.openDraw(id, to, r);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    function delegatedMarker() external pure returns (uint256) {
        return 7702;
    }
}

/// @notice Factory box 0, real pinned sources and committed quicknet signatures. U6.1–5,9,11,15–17.
/// forge-config: default.evm_version = "osaka"
contract AuditU6LaneTickets is AuditU6LaneBase {
    function testProperty_AUDIT_U6_initializeHookRuleAndPinnedSource() public view {
        assertEq(tickets.openAt(), uint256(b.creationTime()) + 1);
        assertEq(tickets.openAt(), BoxHook(a.hook).openAt());
        assertEq(tickets.source(), BackedSourcePins.ADDRESS_MAINNET);
        assertEq(token.allowance(a.tickets, a.vault), type(uint256).max);
        _empty();
    }

    /// IBoxTickets curve quotes, F30/F55, M17 regression: ceil in, floor out, ceil fees; all pre-action state.
    function testFuzz_AUDIT_U6_takeHandBackQuotes(uint256 count) public {
        count = bound(count, 1, 12);
        uint256 s = token.totalSupply();
        uint256 e = vault.escrowPrincipal();
        uint256 n = vault.inside();
        uint256 p = ((s - e) * count + n - 1) / n;
        uint256 f = (p + 99) / 100;
        (uint256 qp, uint256 qf) = vault.quoteTake(count);
        assertEq(qp, p);
        assertEq(qf, f);
        uint256 balance = token.balanceOf(alice);
        uint256 first = _take(alice, count);
        assertEq(token.balanceOf(alice), balance - p - f);
        assertEq(token.totalSupply(), s - f);
        assertEq(vault.escrowPrincipal(), e + p);
        _empty();
        s = token.totalSupply();
        e = vault.escrowPrincipal();
        n = vault.inside();
        p = (s - e) * count / n;
        f = (p * 5 + 99) / 100;
        (qp, qf) = vault.quoteHandBack(count);
        assertEq(qp, p);
        assertEq(qf, f);
        uint256[] memory ids = new uint256[](count);
        for (uint256 i; i < count; ++i) {
            ids[i] = first + i;
        }
        balance = token.balanceOf(alice);
        vm.prank(alice);
        (qp, qf) = tickets.handBack(ids, p - f, block.timestamp);
        assertEq(qp, p);
        assertEq(qf, f);
        assertEq(token.balanceOf(alice), balance + p - f);
        assertEq(token.totalSupply(), s - f);
        assertEq(vault.escrowPrincipal(), e - p);
        assertEq(vault.pendingTickets(), 1);
        _empty();
    }

    function testProperty_AUDIT_U6_bountyRefundAndRefusingDrawer() public {
        _ready();
        vm.fee(1 gwei);
        uint256 before = alice.balance;
        _draw(alice, 1 ether);
        (, uint64 round) = src.requestOf(a.tickets, 1);
        assertEq(src.bountyOf(round), 600_000 gwei);
        assertEq(alice.balance, before - 600_000 gwei);
        before = bob.balance;
        _draw(bob, 1 ether);
        assertEq(bob.balance, before);
        vm.fee(0.5 gwei);
        _draw(bob, 1 ether);
        assertEq(bob.balance, before, "falling base fee refunds everything");
        AuditU6LaneDrawer rejector = new AuditU6LaneDrawer();
        _fund(address(rejector));
        rejector.draw(tickets, token, 1 ether);
        assertEq(src.bountyOf(round), 1 ether + 600_000 gwei);
        _empty();
    }

    /**
     * @notice U6.3 / F75 W3; DrandWords.sol:85-90, IBoxTickets.sol:176-184.
     * Expected: later draws of an already funded round refund all ETH even if basefee changes.
     * Observed: the target is recomputed; the second drawer pays another 600,000 gwei.
     * Steps: graduate, draw at 1 gwei with 1 ETH, change basefee to 2 gwei, draw with 1 ETH.
     * Amounts: first pot 600,000 gwei; final pot 1,200,000 gwei; second refund 0.9994 ETH.
     * This counterfactual basefee change within one quicknet round is not normal mainnet slot timing.
     */
    function test_AUDIT_U6_51_risingBasefeeRetopsPaidRound() public {
        _ready();
        vm.fee(1 gwei);
        _draw(alice, 1 ether);
        uint256 before = bob.balance;
        vm.fee(2 gwei);
        _draw(bob, 1 ether);
        assertEq(before - bob.balance, 600_000 gwei);
        (, uint64 r1) = src.requestOf(a.tickets, 1);
        (, uint64 r2) = src.requestOf(a.tickets, 2);
        assertEq(r1, r2);
        assertEq(src.bountyOf(r2), 1_200_000 gwei);
        _empty();
    }

    function testProperty_AUDIT_U6_approvalsExpireInFrozenAndKnownEras() public {
        uint256 second = _take(alice, 1);
        vm.startPrank(alice);
        tickets.approve(bob, 1);
        tickets.setApprovalForAll(bob, true);
        vm.stopPrank();
        assertEq(tickets.getApproved(1), bob);
        _closeGraduate();
        assertEq(tickets.getApproved(1), address(0));
        assertFalse(tickets.isApprovedForAll(alice, bob));
        vm.prank(alice);
        tickets.approve(bob, second); // even a newly given era-2 approval never counts
        assertEq(tickets.getApproved(second), address(0));
        vm.prank(alice);
        vm.expectRevert(IBoxTickets.Frozen.selector);
        tickets.transferFrom(alice, bob, 1);
        _postRound(0);
        tickets.acceptGraduationWord();
        for (uint256 id = 1; id <= second; ++id) {
            vm.prank(bob);
            vm.expectRevert(abi.encodeWithSelector(IBoxTickets.NotAuthorized.selector, bob, id));
            tickets.transferFrom(alice, bob, id);
        }
        ItemReveal memory r = art.reveal(tickets.numberOf(1));
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.NotAuthorized.selector, bob, 1));
        tickets.open(1, r);
        vm.prank(alice);
        tickets.setApprovalForAll(bob, true);
        vm.prank(bob);
        uint256 item = tickets.open(1, r);
        assertEq(collection.ownerOf(item), alice);
        r = art.reveal(tickets.numberOf(second));
        vm.prank(alice);
        item = tickets.open(second, r);
        assertEq(collection.ownerOf(item), alice);
        _empty();
    }

    function testProperty_AUDIT_U6_eoaAndReal7702OpenImmediatelyToDrawer() public {
        _ready();
        _draw(alice, 0);
        uint256 key = 0x7702;
        address delegated = vm.addr(key);
        AuditU6LaneDrawer implementation = new AuditU6LaneDrawer();
        vm.signAndAttachDelegation(address(implementation), key);
        assertEq(delegated.code, abi.encodePacked(hex"ef0100", address(implementation)));
        assertEq(AuditU6LaneDrawer(delegated).delegatedMarker(), 7702, "actual delegated execution");
        _fund(delegated);
        _draw(delegated, 0);
        _postRound(4);
        tickets.settle(2);
        for (uint256 id = 1; id <= 2; ++id) {
            ItemReveal memory r = art.reveal(tickets.drawTicket(id).itemId);
            uint256 item = tickets.openDraw(id, bob, r);
            assertEq(collection.ownerOf(item), id == 1 ? alice : delegated);
        }
        _empty();
    }

    function testProperty_AUDIT_U6_contractDrawerRecipientAndExactGrace() public {
        _ready();
        AuditU6LaneDrawer drawer = new AuditU6LaneDrawer();
        _fund(address(drawer));
        drawer.draw(tickets, token, 0);
        drawer.draw(tickets, token, 0);
        _postRound(4);
        tickets.settle(2);
        ItemReveal memory r = art.reveal(tickets.drawTicket(1).itemId);
        uint256 edge = tickets.drawTicket(1).revealFallbackAt;
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.DrawerOpensFirst.selector, 1, edge));
        tickets.openDraw(1, bob, r);
        drawer.open(tickets, 2, bob, art.reveal(tickets.drawTicket(2).itemId));
        assertEq(collection.ownerOf(tickets.drawTicket(2).itemId), bob);
        vm.warp(edge - 1);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.DrawerOpensFirst.selector, 1, edge));
        tickets.openDraw(1, bob, r);
        vm.warp(edge);
        uint256 item = tickets.openDraw(1, bob, r);
        assertEq(collection.ownerOf(item), address(drawer));
        _empty();
    }

    function testProperty_AUDIT_U6_revealAndReturnExactGraces() public {
        _ready();
        uint256 edge = uint256(tickets.status().wordAcceptedAt) + 30 days;
        uint256 number = tickets.numberOf(1);
        ItemReveal memory none;
        vm.warp(edge - 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.RevealRequired.selector, number, edge));
        tickets.open(1, none);
        vm.warp(edge);
        vm.prank(alice);
        tickets.open(1, none);
        assertFalse(collection.isRevealed(number));
        assertEq(tickets.returnableFrom(number), edge + 30 days);
        vm.warp(edge + 30 days - 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.NotRevealed.selector, number));
        vault.returnItem(number, 0, block.timestamp);
        vm.warp(edge + 30 days);
        vm.prank(alice);
        vault.returnItem(number, 0, block.timestamp);
        assertEq(collection.ownerOf(number), a.vault);
        _empty();
    }

    /// ADR-0013 section 3.3 rule 2 / row 9: shelf activity cannot change a pending hidden draw.
    function testProperty_AUDIT_U6_shelfInterleavingLeavesDrawOutcomeFixed() public {
        _ready();
        uint256 placeholderItem = tickets.numberOf(1);
        ItemReveal memory r = art.reveal(placeholderItem);
        vm.prank(alice);
        tickets.open(1, r);
        _draw(bob, 0);
        _draw(bob, 0);
        uint256 snap = vm.snapshotState();
        _postRound(4);
        tickets.settle(2);
        uint256 first = tickets.drawTicket(1).itemId;
        uint256 second = tickets.drawTicket(2).itemId;
        vm.revertToState(snap);
        vm.prank(alice);
        vault.returnItem(placeholderItem, 0, block.timestamp);
        vm.prank(alice);
        vault.withdraw(placeholderItem, type(uint256).max, block.timestamp);
        _postRound(4);
        tickets.settle(2);
        assertEq(tickets.drawTicket(1).itemId, first);
        assertEq(tickets.drawTicket(2).itemId, second);
        assertTrue(first != placeholderItem && second != placeholderItem);
        _empty();
    }

    function testProperty_AUDIT_U6_roundCeilingAndRequestImmutability() public {
        _ready();
        for (uint256 i; i < 3; ++i) {
            _draw(alice, 0);
            (uint64 at, uint64 round) = src.requestOf(a.tickets, i + 1);
            uint256 delta = src.roundTime(round) - at;
            assertGe(delta, 12);
            assertLe(delta, 14);
            assertEq(round, src.roundAt(uint256(at) + 12));
            vm.warp(block.timestamp + 1);
            (, uint64 unchanged) = src.requestOf(a.tickets, i + 1);
            assertEq(unchanged, round);
        }
    }

    /// ADR-0013 section 9 row 16: another item's proof cannot open this item's assigned number.
    function testProperty_AUDIT_U6_wrongRevealRollsBackDeliveryAndBurn() public {
        _ready();
        uint256 number = tickets.numberOf(1);
        uint256 other = number == tickets.firstId() ? number + 1 : number - 1;
        ItemReveal memory wrong = art.reveal(other);
        uint256 pending = vault.pendingTickets();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IBoxCollection.InvalidProof.selector, number));
        tickets.open(1, wrong);
        assertEq(tickets.ownerOf(1), alice);
        assertEq(collection.ownerOf(number), a.vault);
        assertEq(vault.pendingTickets(), pending);
        assertFalse(collection.isRevealed(number));
        ItemReveal memory correct = art.reveal(number);
        vm.prank(alice);
        tickets.open(1, correct);
        assertTrue(collection.isRevealed(number));
        _empty();
    }

    /// U6.9/10: every selected and remaining position partitions the factory's entire actual collection.
    function testFuzz_AUDIT_U6_lazyPoolPartition(uint256 count) public {
        count = bound(count, 1, 24);
        _ready();
        for (uint256 i; i < count; ++i) {
            _draw(alice, 0);
        }
        _postRound(4);
        uint256 n = tickets.collectionSize();
        uint256 q = tickets.status().slots;
        bool[] memory seen = new bool[](n);
        (uint256 u, uint256 v) = BoxShuffle.halves(n);
        for (uint256 i; i < q; ++i) {
            seen[i] = true;
        }
        for (uint256 id = 1; id <= count; ++id) {
            (bytes32 word,) = src.wordOf(a.tickets, id);
            uint256 index = uint256(keccak256(abi.encode(word, id))) % (n - q - id + 1);
            uint256 expectedPosition = tickets.poolPositionAt(index);
            tickets.settle(1);
            uint256 offset = tickets.drawTicket(id).itemId - tickets.firstId();
            uint256 position = BoxShuffle.invert(tickets.graduationWord(), offset, n, u, v);
            assertEq(position, expectedPosition);
            assertFalse(seen[position]);
            seen[position] = true;
        }
        for (uint256 i; i < n - q - count; ++i) {
            uint256 position = tickets.poolPositionAt(i);
            assertLt(position, n);
            assertFalse(seen[position], "no used slot remains and no remaining slot repeats");
            seen[position] = true;
        }
        for (uint256 i; i < n; ++i) {
            assertTrue(seen[i], "no slot lost");
        }
    }

    function testProperty_AUDIT_U6_fifoFixedInputsAndLazyPool() public {
        _ready();
        _draw(alice, 0); // round r0 + 4
        _onRound(7);
        _draw(bob, 0);
        _postRound(7); // later word first
        vm.expectRevert(IBoxTickets.NothingSettled.selector);
        tickets.settle(2);
        assertEq(tickets.status().drawsSettled, 0);
        _postRound(4);
        uint256 n = tickets.collectionSize();
        uint256 q = tickets.status().slots;
        uint256[] memory pool = new uint256[](n - q);
        for (uint256 i; i < pool.length; ++i) {
            pool[i] = q + i;
        }
        (uint256 u, uint256 v) = BoxShuffle.halves(n);
        for (uint256 id = 1; id <= 2; ++id) {
            (bytes32 w,) = src.wordOf(a.tickets, id);
            uint256 left = pool.length - id + 1;
            uint256 pick = uint256(keccak256(abi.encode(w, id))) % left;
            uint256 pos = pool[pick];
            pool[pick] = pool[left - 1];
            uint256 expected = tickets.firstId() + BoxShuffle.permute(tickets.graduationWord(), pos, n, u, v);
            assertEq(tickets.settle(1), 1);
            assertEq(tickets.drawTicket(id).itemId, expected);
            assertEq(tickets.status().drawsSettled, id);
            for (uint256 j; j < left - 1; ++j) {
                assertEq(tickets.poolPositionAt(j), pool[j]);
            }
        }
        bytes32 word = tickets.graduationWord();
        vm.expectRevert(IBoxTickets.WordAlreadyAccepted.selector);
        tickets.acceptGraduationWord();
        assertEq(tickets.graduationWord(), word);
        (, uint64 fixedRound) = src.requestOf(a.tickets, 1);
        assertEq(fixedRound, r0 + 4);
        assertGe(src.roundTime(fixedRound), tickets.drawTicket(1).requestedAt + 12);
        _empty();
    }
}

/// Scheduled open time uses the same hook rule; mainnet factory permits a future clock time.
/// forge-config: default.evm_version = "osaka"
contract AuditU6LaneScheduledOpen is AuditU6LaneBase {
    function _openTime() internal view override returns (uint32) {
        return uint32(block.timestamp + 120);
    }

    function testProperty_AUDIT_U6_initializeScheduledOpen() public view {
        assertEq(tickets.openAt(), uint256(b.creationTime()) + 120);
        assertEq(tickets.openAt(), BoxHook(a.hook).openAt());
        assertEq(tickets.source(), BackedSourcePins.ADDRESS_MAINNET);
    }
}

/// A previously scheduled time reached before inclusion follows the hook's next-second rule.
/// forge-config: default.evm_version = "osaka"
contract AuditU6LaneElapsedOpen is AuditU6LaneBase {
    function _openTime() internal view override returns (uint32) {
        return uint32(block.timestamp - 1);
    }

    function testProperty_AUDIT_U6_initializeElapsedOpen() public view {
        assertEq(tickets.openAt(), uint256(b.creationTime()) + 1);
        assertEq(tickets.openAt(), BoxHook(a.hook).openAt());
    }
}
