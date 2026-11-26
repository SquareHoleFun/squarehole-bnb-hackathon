// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BackedSourcePins} from "../../../../src/box/randomness/BackedSourcePins.sol";
import {BoxBackedSource} from "../../../../src/box/randomness/BoxBackedSource.sol";
import {DrandSourcePins} from "../../../../src/box/randomness/DrandSourcePins.sol";
import {DrawStatus, TicketPhase} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxTickets} from "../../../../src/box/interfaces/IBoxTickets.sol";
import {EthIn, EthOut, TIn, TOut} from "../common/AuditGhostLedger.sol";
import {AuditU6ClaudeAgent, AuditU6ClaudeBase} from "./AuditU6ClaudeBase.sol";

/// @notice U6 lens L6 (external protocol assumptions) with the real BoxBackedSource and DrandSource of box 0: P6.14
/// (a backup started for a round several draws share gives each its own word; a drand post after the start is ignored
/// for good, `BoxBackedSource.sol:16-37, 138-152`; F143), the source pins (BC-101), and the ETH-send audit asked for
/// after wave 1: every ETH payment of this unit to an address a user chooses or controls, checked for a 2,300-gas
/// stipend path, on Osaka and Amsterdam (a value call to an EIP-7702-delegated EOA leaves its code about 3,000 gas
/// less under Amsterdam, so a stipend-only payment to one fails there).
/// forge-config: default.evm_version = "osaka"
contract AuditU6ClaudeBackupTest is AuditU6ClaudeBase {
    /// P6.14: four draws in one block share a silent round; one backup start and one fix give each of them its own
    /// domain-separated word, ready inside every draw's 7 days; all four settle in order (the oracle's items); a second
    /// start or fix of the round is refused.
    function testProperty_AUDIT_U6_backupServesASharedRound() public {
        _toDrawing();
        _advance(1);
        uint256[4] memory ids;
        address[4] memory who = [eoa[3], eoa[4], eoa[5], address(contractDrawer)];
        for (uint256 i; i < 4; ++i) {
            ids[i] = _draw(who[i], AUDIT_DRAW_VALUE);
        }
        (, uint64 round) = src.requestOf(a.tickets, ids[0]);
        assertFalse(_committed(round), "drand silent for it");
        for (uint256 i = 1; i < 4; ++i) {
            (, uint64 r) = src.requestOf(a.tickets, ids[i]);
            assertEq(r, round, "one round for the block");
        }
        _warpTo(src.roundTime(round) + src.BACKUP_AFTER() + 1);
        _backup(round, MIX, eoa[5]);
        vm.expectRevert(abi.encodeWithSelector(BoxBackedSource.BackupAlreadyStarted.selector, round));
        src.startBackup(round, vm.getBlockNumber() - 1, _parentHeader());
        (,, uint64 fixedAt,) = src.backupOf(round);
        for (uint256 i; i < 4; ++i) {
            (bytes32 w, uint64 readyAt) = src.wordOf(a.tickets, ids[i]);
            assertEq(w, _word(src.BACKUP_TAG(), MIX, ids[i]), "each its own backup word");
            assertEq(readyAt, fixedAt);
            assertLe(readyAt, tickets.drawTicket(ids[i]).requestedAt + tickets.SILENCE(), "inside its 7 days");
            for (uint256 j; j < i; ++j) {
                (bytes32 wj,) = src.wordOf(a.tickets, ids[j]);
                assertTrue(w != wj, "distinct words");
            }
        }
        assertEq(_settle(keeper, 4), 4);
        _assertItemsMatchOracle();
        bytes memory h = _mineHeader(vm.getBlockNumber() - 1, MIX);
        vm.expectRevert(abi.encodeWithSelector(BoxBackedSource.BackupAlreadyFixed.selector, round));
        src.fixBackup(round, h);
        _assertGhostLedger();
    }

    /// P6.14: two committed rounds left unposted for 5 days. One gets a backup start, after which its valid drand post
    /// is accepted by the DrandSource (and its pot paid to that poster: backup review F7, recorded) but ignored for
    /// box 0: its two draws get the backup's words once fixed. The other round, posted late with no start, gives its
    /// draw drand's word. All three settle in order with those words.
    function testProperty_AUDIT_U6_drandPostAfterStartIsIgnored() public {
        _toWordAccepted();
        uint256[3] memory d;
        d[0] = _draw(eoa[3], AUDIT_DRAW_VALUE);
        d[1] = _draw(eoa[4], AUDIT_DRAW_VALUE);
        _advance(1);
        d[2] = _draw(eoa[5], AUDIT_DRAW_VALUE);
        (, uint64 ra) = src.requestOf(a.tickets, d[0]);
        (, uint64 rb) = src.requestOf(a.tickets, d[2]);
        assertEq(ra, r0 + 4);
        assertEq(rb, r0 + 8);
        _warpTo(src.roundTime(ra) + src.BACKUP_AFTER() + 1);
        _startBackup(ra, eoa[6]);
        _postIgnored(ra, d[0]);
        _post(rb); // no start for rb: drand's word, late but inside the 7 days
        vm.expectRevert(IBoxTickets.NothingSettled.selector);
        tickets.settle(3);
        _advance(src.TARGET_BLOCKS() + 1);
        _fixBackup(ra, MIX, poster);
        _assertWords(d, ra, rb);
        assertEq(_settle(keeper, 3), 3);
        _assertItemsMatchOracle();
        _assertGhostLedger();
    }

    /// @dev Posts started round `ra` on the DrandSource: accepted there, its pot paid to the poster, ignored for box 0.
    function _postIgnored(uint256 ra, uint256 d0) internal {
        uint256 owed0 = drand.owedTo(poster);
        uint256 pot = drand.bountyOf(ra);
        _post(ra); // valid, accepted by the DrandSource
        (, uint64 postedAt) = drand.beaconOf(ra);
        assertGt(postedAt, 0, "the DrandSource took the post");
        assertEq(drand.owedTo(poster) - owed0, pot, "and paid its pot to the poster (F7, recorded)");
        (bytes32 w1, uint64 t1) = src.wordOf(a.tickets, d0);
        assertEq(w1, bytes32(0), "ignored for box 0 once the backup started");
        assertEq(t1, 0);
    }

    function _assertWords(uint256[3] memory d, uint256 ra, uint256 rb) internal view {
        (bytes32 w,) = src.wordOf(a.tickets, d[0]);
        assertEq(w, _word(src.BACKUP_TAG(), MIX, d[0]), "the backup's word");
        (bytes32 drandA,) = drand.beaconOf(ra);
        assertTrue(w != _word(src.DRAND_TAG(), drandA, d[0]), "never drand's word for the started round");
        (w,) = src.wordOf(a.tickets, d[1]);
        assertEq(w, _word(src.BACKUP_TAG(), MIX, d[1]), "the backup's word");
        (w,) = src.wordOf(a.tickets, d[2]);
        (bytes32 randomness,) = drand.beaconOf(rb);
        assertEq(w, _word(src.DRAND_TAG(), randomness, d[2]), "drand's word");
    }

    /// P6.14 with slow blocks (13 s each, missed slots): a backup started at the latest start and fixed at the end of
    /// EIP-2935's window lands after the draw's 7 days; the tickets read that word as late (unusable), as the source's
    /// `isSilent` does, and the head is dead.
    function testProperty_AUDIT_U6_lateBackupWordDoesNotCount() public {
        _toSilent();
        uint256 deadline = tickets.drawTicket(drawC).requestedAt + tickets.SILENCE();
        _warpTo(src.roundTime(silentRound) + src.LATEST_START());
        uint256 target = _startBackup(silentRound, eoa[5]);
        uint256 blocks = target + 8_191 - vm.getBlockNumber();
        vm.roll(vm.getBlockNumber() + blocks);
        vm.warp(vm.getBlockTimestamp() + 13 * blocks);
        assertGt(vm.getBlockTimestamp(), deadline, "the window ends after the deadline on a slow chain");
        _fixBackup(silentRound, MIX, poster);
        (bytes32 w, uint64 readyAt) = src.wordOf(a.tickets, drawC);
        assertTrue(w != bytes32(0));
        assertGt(readyAt, deadline, "fixed after the 7 days");
        assertTrue(src.isSilent(a.tickets, drawC), "the source calls it silent");
        vm.expectRevert(IBoxTickets.NothingSettled.selector);
        tickets.settle(1);
        tickets.enterTerminal();
        assertEq(uint8(tickets.phase()), uint8(TicketPhase.Terminal), "the tickets agree: dead head");
        _assertGhostLedger();
    }

    /// The ETH-send audit (wave 1's measured fact). This unit sends ETH on three paths only:
    /// (1) a draw's refund of `msg.value` less the pot's shortfall to the drawer (`DrandWords.sol:93`): `call(gas(), …)`,
    ///     all the gas, never a stipend; (2) `requestGraduationWord`'s value and (3) the draw's pot top-up, both to
    ///     the pinned source (`BoxTickets.sol:528-530`, `DrandWords.sol:97`), not an address a user chooses.
    /// Pinned here on both EVMs: the 7702 drawer and a contract drawer whose `receive` does more than 2,300 gas of work
    /// get their whole rest; the control `send` (2,300 stipend) to the same 7702 account fails under Amsterdam and
    /// passes under Osaka, so the world shows the stipend problem and this unit's refund does not have it.
    function testProperty_AUDIT_U6_noStipendPathToUserAddresses() public {
        _toWordAccepted();
        uint256 target = _target();
        uint256 e0 = eoa7702.balance;
        _draw(eoa7702, 4 * target);
        assertEq(e0 + 4 * target - eoa7702.balance, target, "the 7702 drawer's rest came back in full");
        // a contract drawer whose receive costs more than a stipend allows (a storage write, a call)
        AuditU6ClaudeAgent ag = _agent(eoa[3], token.balanceOf(eoa[3]) / 4);
        ag.exec(address(token), 0, abi.encodeCall(token.approve, (a.tickets, type(uint256).max)));
        ag.addOnEth(a.tickets, 0, abi.encodeCall(tickets.status, ()));
        vm.deal(address(ag), 4 * target);
        uint256 t0 = token.balanceOf(address(ag));
        uint256 deadline = vm.getBlockTimestamp();
        ag.exec(a.tickets, 4 * target, abi.encodeCall(tickets.draw, (type(uint256).max, deadline)));
        _noteEthChange(4 * target, address(ag).balance, EthIn.DrawValue, EthOut.Refund);
        _noteTChange(t0, token.balanceOf(address(ag)), TIn.Draw, TOut.Other);
        assertEq(ag.ethReceived(), 4 * target, "a later draw of the round: all of it back, through a costly receive");
        // the control: a 2,300-gas stipend to the 7702 account
        vm.deal(address(this), 1);
        bool sent = payable(eoa7702).send(1);
        if (keccak256(bytes(vm.getEvmVersion())) == keccak256("amsterdam")) {
            assertFalse(sent, "amsterdam: a stipend cannot pay a delegated account");
        } else {
            assertTrue(sent, "osaka: the stipend is enough");
        }
        _assertTicketsHoldNothing();
        _assertGhostLedger();
    }

    /// BC-101 / F143 / L8: box 0's tickets read the pinned BoxBackedSource (address and code hash), not a delegation,
    /// and it names the pinned DrandSource.
    function testProperty_AUDIT_U6_sourcePinned() public view {
        assertEq(tickets.source(), BackedSourcePins.ADDRESS_MAINNET);
        assertEq(tickets.source().codehash, BackedSourcePins.CODE_HASH_MAINNET, "the pinned code");
        assertTrue(tickets.source().code.length != 23, "not an EIP-7702 delegation");
        assertEq(address(src.DRAND()), DrandSourcePins.ADDRESS_MAINNET);
        assertEq(address(drand).codehash, DrandSourcePins.CODE_HASH_MAINNET);
        assertEq(coordinator.randomness(), tickets.source(), "the coordinator's randomness is the same source");
    }
}

/// The same under Amsterdam.
/// forge-config: default.evm_version = "amsterdam"
contract AuditU6ClaudeBackupAmsterdamTest is AuditU6ClaudeBackupTest {}
