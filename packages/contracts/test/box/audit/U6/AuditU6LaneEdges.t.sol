// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AuditU6LaneBase} from "./AuditU6LaneBase.sol";
import {BoxTickets} from "../../../../src/box/BoxTickets.sol";
import {BoxCoordinator} from "../../../../src/box/BoxCoordinator.sol";
import {DrawStatus, ItemReveal, TicketPhase} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxTickets} from "../../../../src/box/interfaces/IBoxTickets.sol";
import {IDrandSource} from "../../../../src/box/interfaces/IDrandSource.sol";
import {BoxBackedSource} from "../../../../src/box/randomness/BoxBackedSource.sol";

/// @notice Stand-in only for a hostile wordOf callee. A budget above 50,000 would return a usable word and fail the
/// no-settlement assertion; within the stipend it reverts, returns 31 bytes, or exhausts its whole budget.
contract AuditU6LaneHostileWord {
    uint256 internal immutable mode;

    constructor(uint256 mode_) {
        mode = mode_;
    }

    function wordOf(address, uint256) external view returns (bytes32, uint64) {
        if (gasleft() > 50_000) return (bytes32(uint256(1)), uint64(block.timestamp));
        if (mode == 0) revert("hostile source");
        if (mode == 1) {
            assembly ("memory-safe") {
                mstore(0, 1)
                return(0, 31)
            }
        }
        assembly ("memory-safe") { for {} 1 {} {} }
    }
}

/// @notice U6.6,8,11,12,14,16 on the factory world. Only explicit hostile-call tests replace source behavior.
/// forge-config: default.evm_version = "osaka"
contract AuditU6LaneEdges is AuditU6LaneBase {
    function testProperty_AUDIT_U6_silentQueueBoundAndCancelCurrentPrincipal() public {
        _ready();
        for (uint256 i; i < 8; ++i) {
            _draw(alice, 0);
        }
        uint256 at = tickets.drawTicket(1).requestedAt;
        vm.expectRevert(IBoxTickets.NotTerminal.selector);
        tickets.cancelDraw(1);
        vm.warp(at + 7 days - 1);
        _headAlive(1, at + 7 days);
        vm.warp(at + 7 days);
        _headAlive(1, at + 7 days); // AR-18 accepted inclusive word deadline, not a new finding
        vm.warp(at + 7 days + 1);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.QueueDead.selector, 1, at + 7 days));
        tickets.draw(type(uint256).max, block.timestamp);
        tickets.enterTerminal();
        uint256 supply = token.totalSupply();
        for (uint256 id = 1; id <= 8; ++id) {
            (uint256 currentPrincipal, uint256 fee) = vault.quoteHandBack(1);
            assertEq(fee, 0);
            uint256 before = token.balanceOf(alice);
            uint256 escrow = vault.escrowPrincipal();
            assertEq(tickets.cancelDraw(id), currentPrincipal);
            assertEq(token.balanceOf(alice), before + currentPrincipal);
            assertEq(vault.escrowPrincipal(), escrow - currentPrincipal);
            assertEq(uint8(tickets.drawTicket(id).status), uint8(DrawStatus.Cancelled));
            _empty();
        }
        assertEq(token.totalSupply(), supply, "request fees stay burned; no new burn on cancel");
        assertEq(vault.pendingTickets(), 1, "one placeholder remains; every draw closed in 1 + 8 calls");
    }

    function testProperty_AUDIT_U6_wordReadyAtInclusiveDeadlineSettlesLater() public {
        _ready();
        _draw(alice, 0);
        uint256 edge = tickets.drawTicket(1).requestedAt + 7 days;
        uint256 snap = vm.snapshotState();
        vm.warp(edge);
        _postRound(4);
        vm.warp(edge + 30 days);
        _headAlive(1, edge);
        assertEq(tickets.settle(1), 1);
        assertEq(uint8(tickets.drawTicket(1).status), uint8(DrawStatus.Settled));
        vm.revertToState(snap);
        vm.warp(edge + 1);
        _postRound(4);
        vm.expectRevert(IBoxTickets.NothingSettled.selector);
        tickets.settle(1);
        tickets.enterTerminal();
        assertEq(uint8(tickets.phase()), uint8(TicketPhase.Terminal));
    }

    function _headAlive(uint256 key, uint256 edge) internal {
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.HeadNotDead.selector, key, edge));
        tickets.enterTerminal();
    }

    /// Failed optional graduation poke stand-in; all subsequent requests and words use the real sources.
    function _unrequested() internal returns (uint256 at) {
        b.buy(b.carol(), 3 * b.spec().raise, b.curve().sqrtPriceLowerX96);
        vm.warp(src.roundTime(r0) - 12);
        vm.mockCallRevert(address(src), abi.encodeWithSelector(IDrandSource.request.selector, 0), "failed poke");
        BoxCoordinator(a.coordinator).graduate();
        vm.clearMockedCalls();
        assertEq(tickets.status().wordRequestedAt, 0);
        at = block.timestamp;
    }

    /**
     * @notice U6.16 / IBoxTickets.sol:22-24 and BoxTickets.sol:739-760: unrequested graduation word, 30 days.
     * Expected: entry at gate + 30 days. Observed: HeadNotDead at the edge; entry at edge + 1 second.
     * Steps: fail the optional request poke, advance to edge - 1, edge, edge + 1 and enter.
     * Amounts: one pending placeholder; no draw or ETH principal moves.
     */
    function test_AUDIT_U6_52_unrequestedTerminalNeedsOneMoreSecond() public {
        uint256 at = _unrequested();
        vm.warp(at + 30 days - 1);
        _headAlive(0, at + 30 days);
        vm.warp(at + 30 days);
        _headAlive(0, at + 30 days);
        vm.warp(at + 30 days + 1);
        tickets.enterTerminal();
        assertEq(uint8(tickets.phase()), uint8(TicketPhase.Terminal));
    }

    function testProperty_AUDIT_U6_threeDayNamedTakeExactEdge() public {
        ItemReveal memory r = art.reveal(2);
        vm.expectRevert(IBoxTickets.NotTerminal.selector);
        tickets.takeByNumber(2, 0, type(uint256).max, block.timestamp, r);
        _closeGraduate();
        vm.warp(block.timestamp + 7 days + 1);
        tickets.enterTerminal();
        uint256 edge = block.timestamp + 3 days;
        vm.warp(edge - 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.TooEarly.selector, edge));
        tickets.takeByNumber(2, 0, type(uint256).max, block.timestamp, r);
        vm.warp(edge);
        vm.prank(alice);
        tickets.takeByNumber(2, 0, type(uint256).max, block.timestamp, r);
        assertEq(collection.ownerOf(2), alice);
        _empty();
    }

    /**
     * @notice U6.16 / F143 / ADR-0013 section 3.3 rule 3; BoxBackedSource.sol:162-165.
     * Expected: backup starts at round time + 5 days. Observed: BackupTooEarly at the edge; starts edge + 1.
     * Steps: graduate on a committed round, try the valid parent header at edge - 1, edge, edge + 1.
     * Amounts: zero ETH; one graduation request; target is start block + 256.
     */
    function test_AUDIT_U6_53_backupStartNeedsOneMoreSecond() public {
        _closeGraduate();
        uint256 edge = src.roundTime(r0) + 5 days;
        bytes memory h = _parent();
        vm.warp(edge - 1);
        vm.expectRevert(abi.encodeWithSelector(BoxBackedSource.BackupTooEarly.selector, r0, edge));
        src.startBackup(r0, block.number - 1, h);
        vm.warp(edge);
        vm.expectRevert(abi.encodeWithSelector(BoxBackedSource.BackupTooEarly.selector, r0, edge));
        src.startBackup(r0, block.number - 1, h);
        vm.warp(edge + 1);
        assertEq(src.startBackup(r0, block.number - 1, h), block.number + 256);
    }

    function testProperty_AUDIT_U6_backupLatestStartAndSharedRound() public {
        _closeGraduate();
        for (uint256 i; i < 3; ++i) {
            _draw(alice, 0); // key 0 and all draws share r0
        }
        for (uint256 id; id <= 3; ++id) {
            (uint64 at, uint64 round) = src.requestOf(a.tickets, id);
            assertEq(round, r0);
            assertGe(src.roundTime(round), uint256(at) + 12);
        }
        uint256 edge = src.roundTime(r0) + 5 days + 18 hours;
        uint256 snap = vm.snapshotState();
        vm.warp(edge + 1);
        bytes memory h = _parent();
        vm.expectRevert(abi.encodeWithSelector(BoxBackedSource.BackupTooLate.selector, r0, edge));
        src.startBackup(r0, block.number - 1, h);
        vm.revertToState(snap);
        vm.warp(edge - 1);
        _start(r0, bob);
        vm.revertToState(snap);
        vm.warp(edge);
        uint256 target = _start(r0, bob);
        drand.postRound(r0, _localSig(0));
        for (uint256 id; id <= 3; ++id) {
            (bytes32 w, uint64 readyAt) = src.wordOf(a.tickets, id);
            assertEq(w, bytes32(0), "late drand ignored after backup start");
            assertEq(readyAt, 0);
        }
        _advance(src.TARGET_BLOCKS() + 1_000); // beyond BLOCKHASH: real EIP-2935 history code
        bytes32 mix = keccak256("shared backup mix");
        src.fixBackup(r0, _mine(target, mix));
        tickets.acceptGraduationWord();
        assertEq(tickets.graduationWord(), _word(src.BACKUP_TAG(), mix, 0));
        assertEq(tickets.settle(3), 3);
        for (uint256 id = 1; id <= 3; ++id) {
            (bytes32 w, uint64 readyAt) = src.wordOf(a.tickets, id);
            assertEq(w, _word(src.BACKUP_TAG(), mix, id));
            assertLe(readyAt, tickets.drawTicket(id).requestedAt + 7 days);
            uint256 item = tickets.drawTicket(id).itemId;
            ItemReveal memory reveal = art.reveal(item);
            vm.prank(alice);
            tickets.openDraw(id, bob, reveal);
            assertEq(collection.ownerOf(item), bob);
        }
        _empty();
    }

    function testProperty_AUDIT_U6_hostileReadsBoundedAndAtomic() public {
        _ready();
        _draw(alice, 0);
        bytes32 before = _digest();
        for (uint256 mode; mode < 3; ++mode) {
            AuditU6LaneHostileWord hostile = new AuditU6LaneHostileWord(mode);
            vm.etch(address(src), address(hostile).code);
            uint256 gasBefore = gasleft();
            (bool ok, bytes memory ret) = a.tickets.call{gas: 180_000}(abi.encodeCall(BoxTickets.settle, (1)));
            uint256 used = gasBefore - gasleft();
            assertFalse(ok);
            assertEq(ret, abi.encodeWithSelector(IBoxTickets.NothingSettled.selector));
            emit log_named_uint("hostile settle gas", used);
            assertLt(used, 120_000, "50k callee stipend plus bounded adapter overhead");
            assertEq(_digest(), before, "all observable ticket/vault/token state unchanged");
            _empty();
        }
        (bool success, bytes memory reason) = a.tickets.call{gas: 50_000}(abi.encodeCall(BoxTickets.settle, (1)));
        assertFalse(success);
        assertEq(reason, abi.encodeWithSelector(IBoxTickets.GasTooLow.selector));
        assertEq(_digest(), before);
    }

    function _digest() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                tickets.status(),
                tickets.drawTicket(1),
                tickets.graduationWord(),
                tickets.poolPositionAt(0),
                tickets.ownerOf(1),
                vault.pendingTickets(),
                vault.escrowPrincipal(),
                vault.inside(),
                token.totalSupply(),
                token.balanceOf(alice),
                token.balanceOf(a.vault)
            )
        );
    }
}

/// Gas stipends and EIP-2935 must also work under the later fork's prices.
/// forge-config: default.evm_version = "amsterdam"
contract AuditU6LaneEdgesAmsterdam is AuditU6LaneEdges {}
