// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxTickets} from "../../../../src/box/BoxTickets.sol";
import {DrawStatus, TicketPhase} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxTickets} from "../../../../src/box/interfaces/IBoxTickets.sol";
import {IBoxVault} from "../../../../src/box/interfaces/IBoxVault.sol";
import {BoxBackedSource} from "../../../../src/box/randomness/BoxBackedSource.sol";
import {History2935} from "../../backup/History2935.sol";
import {AuditPhases} from "../common/AuditPhases.sol";

/// @notice TEST ONLY. Helpers shared by the U8 suites on the factory's box 0 (`AuditPhases`, read-only).
abstract contract AuditU8ClaudeBox0Base is AuditPhases {
    /// @dev Every address a word read or a tickets entry point touches, made cold (a transaction's worst case).
    function _coolAll() internal {
        vm.cool(address(src));
        vm.cool(address(drand));
        vm.cool(a.tickets);
        vm.cool(a.vault);
        vm.cool(a.token);
        vm.cool(a.coordinator);
        vm.cool(a.collection);
        vm.cool(a.itemStream);
        vm.cool(History2935.ADDRESS);
    }

    function _is(bytes memory ret, bytes memory expected) internal pure returns (bool) {
        return keccak256(ret) == keccak256(expected);
    }

    /// @dev A refusal for lack of gas: out of gas (no data) or the tickets' own `GasTooLow`.
    function _gasRefusal(bytes memory ret) internal pure returns (bool) {
        return ret.length == 0 || _is(ret, abi.encodeWithSelector(IBoxTickets.GasTooLow.selector));
    }
}

/// @title AuditU8ClaudeBox0Test (SH-AUDIT-B0 U8 on the factory's box 0: words, the timeline, the bounty ETH)
/// @notice The shared world's box 0 (mainnet build, real tickets on the pinned backed source), graduated with the
/// graduation word requested on r0 (`AuditPhases._toGraduated`). Properties and sources:
/// - L4 P8.6 (`BoxBackedSource.sol:28-32`, F143, ADR-0013 § 3.3 rule 3 amendment): box 0's graduation word never
///   changes once readable, whether it came from drand (a later start is refused) or from the backup (the drand post
///   made after the start is ignored; the stored word is the backup's); `graduationWord` equals the source's word.
/// - L5 P8.10 (`BoxBackedSource.sol:38-41`, `BoxSpecV1.sol:170-182`): from box 0's real request, the latest start, the
///   target 256 blocks later and the last block EIP-2935 serves fit inside BoxTickets' 7 days: at 12-second blocks with
///   6,624 s (1 h 50 min 24 s) to spare, at 6-second blocks with 57,306 s (15 h 55 min 6 s); the fix window, from the
///   target's block to the last provable one, is 8,191 blocks: 98,292 s (27 h 18 min 12 s) at 12 s and 49,146 s
///   (13 h 39 min 6 s) at 6 s, the figure the keeper's fix job (F4) must meet; one block later the round has no word.
/// - L1 P8.1 (`IDrandSource.sol:23-25`, X01): through box 0's draws the DrandSource holds exactly the pots and the
///   poster's credits; a withdrawal to the EIP-7702 EOA pays it; a bounty through the backed source and forced ETH at
///   both sources keep the ghost ledger balanced (forced ETH stays: M27); the tickets and the backed source hold 0.
/// forge-config: default.evm_version = "osaka"
contract AuditU8ClaudeBox0Test is AuditU8ClaudeBox0Base {
    function setUp() public virtual override {
        super.setUp();
        _toGraduated();
    }

    /// @notice drand first on box 0: r0 posted, the word read, accepted; on day 5 a start is refused
    /// (`RoundAlreadyPosted`) and 30 days later the word and `graduationWord` are unchanged.
    function testProperty_AUDIT_U8_box0DrandWordNeverMoves() public {
        _advance(1);
        _post(r0);
        (bytes32 randomness,) = drand.beaconOf(r0);
        bytes32 w = _word(src.DRAND_TAG(), randomness, 0);
        (bytes32 got, uint64 readyAt) = src.wordOf(a.tickets, 0);
        assertEq(got, w);
        assertEq(readyAt, vm.getBlockTimestamp());
        vm.prank(keeper);
        tickets.acceptGraduationWord();
        assertEq(tickets.graduationWord(), w);
        _warpTo(src.roundTime(r0) + 5 days + 1);
        bytes memory p = _parentHeader();
        vm.expectRevert(abi.encodeWithSelector(BoxBackedSource.RoundAlreadyPosted.selector, r0));
        src.startBackup(r0, vm.getBlockNumber() - 1, p);
        _warpTo(src.roundTime(r0) + 30 days);
        (got, readyAt) = src.wordOf(a.tickets, 0);
        assertEq(got, w, "never moves");
        assertEq(tickets.graduationWord(), w);
        assertFalse(src.isSilent(a.tickets, 0));
    }

    /// @notice drand silent for 5 days: a start fixes the target; r0's committed signature, posted after the start, is
    /// ignored (no word until the fix, `WordNotReady`); the fix gives the backup word, which the tickets store; a second
    /// start or fix is refused and the word never moves.
    function testProperty_AUDIT_U8_box0BackupWordNeverMovesAndIgnoresLatePost() public {
        _toSilentFromGraduation();
        uint256 target = _startBackup(r0, eoa[2]);
        _post(r0);
        (bytes32 got,) = src.wordOf(a.tickets, 0);
        assertEq(got, bytes32(0), "the drand post after the start is ignored");
        vm.expectRevert(IBoxTickets.WordNotReady.selector);
        tickets.acceptGraduationWord();
        _advance(src.TARGET_BLOCKS() + 1);
        bytes32 mix = keccak256("audit.u8.box0.mix");
        _fixBackup(r0, mix, keeper);
        bytes32 w = _word(src.BACKUP_TAG(), mix, 0);
        (got,) = src.wordOf(a.tickets, 0);
        assertEq(got, w);
        (bytes32 randomness,) = drand.beaconOf(r0);
        assertTrue(w != _word(src.DRAND_TAG(), randomness, 0), "not drand's word");
        vm.prank(eoa[3]);
        tickets.acceptGraduationWord();
        assertEq(tickets.graduationWord(), w);
        bytes memory p = _parentHeader();
        vm.expectRevert(abi.encodeWithSelector(BoxBackedSource.BackupAlreadyStarted.selector, r0));
        src.startBackup(r0, vm.getBlockNumber() - 1, p);
        bytes memory h = _mineHeader(target, mix);
        vm.expectRevert(abi.encodeWithSelector(BoxBackedSource.BackupAlreadyFixed.selector, r0));
        src.fixBackup(r0, h);
        _warpTo(src.roundTime(r0) + 30 days);
        (got,) = src.wordOf(a.tickets, 0);
        assertEq(got, w, "never moves");
        assertFalse(src.isSilent(a.tickets, 0));
    }

    /// @notice The worst case at 12-second blocks: the latest start, the fix at the last block EIP-2935 serves, accepted.
    function testProperty_AUDIT_U8_box0TimelineAt12sBlocks() public {
        _timeline(12, 6_624);
    }

    /// @notice The same at 6-second blocks: the fix window in seconds halves, the spare grows.
    function testProperty_AUDIT_U8_box0TimelineAt6sBlocks() public {
        _timeline(6, 57_306);
    }

    function _timeline(uint256 slot, uint256 spare) internal {
        uint256 requestedAt = tickets.status().wordRequestedAt;
        assertEq(src.roundTime(r0) - requestedAt, 12, "box 0's request, 12 s before its round");
        uint256 deadline = requestedAt + tickets.SILENCE();
        uint256 until = src.roundTime(r0) + src.LATEST_START();
        _warpTo(until);
        uint256 startedAt = vm.getBlockTimestamp();
        uint256 target = _startBackup(r0, eoa[2]);
        assertEq(target, vm.getBlockNumber() + 256);
        uint256 window = src.HISTORY_WINDOW();
        vm.roll(target + window);
        vm.warp(startedAt + slot * (256 + window));
        assertEq(slot * window, slot == 12 ? 98_292 : 49_146, "the fix window in seconds (8,191 blocks)");
        bytes memory h = _mineHeader(target, keccak256("the last provable mix"));
        uint256 snap = vm.snapshotState();
        src.fixBackup(r0, h);
        (,, uint64 fixedAt,) = src.backupOf(r0);
        assertEq(fixedAt - startedAt, slot * 8447, "8,447 blocks after the start");
        assertEq(deadline - fixedAt, spare, "the spare before the 7 days end");
        vm.prank(keeper);
        tickets.acceptGraduationWord();
        assertEq(uint8(tickets.phase()), uint8(TicketPhase.Drawing), "the word counts");
        vm.revertToState(snap);
        vm.roll(target + window + 1);
        vm.warp(vm.getBlockTimestamp() + slot);
        History2935.put(vm, target, keccak256(h));
        vm.expectRevert(abi.encodeWithSelector(BoxBackedSource.HeaderUnavailable.selector, target));
        src.fixBackup(r0, h);
    }

    /// @notice Bounty ETH on box 0: two draws' pots (600,000 gas × 1 gwei each) credited to the poster, nothing more;
    /// withdrawn to the EIP-7702 EOA; a far round's bounty through the backed source; forced ETH at both sources. The
    /// DrandSource holds pots + credits + forced; the tickets and the backed source hold nothing but forced ETH; the
    /// ghost ledger balances; the EIP-7702 drawer of draw C got its refund (all gas, on both EVMs).
    function testProperty_AUDIT_U8_box0BountyFlowsBalance() public {
        uint256 e7702 = eoa7702.balance;
        _toSilent();
        assertEq(
            eoa7702.balance - e7702, AUDIT_DRAW_VALUE - 600_000 * AUDIT_BASE_FEE, "draw C's refund reached the 7702 EOA"
        );
        assertEq(drand.bountyOf(silentRound), 600_000 * AUDIT_BASE_FEE, "draw C's pot waits");
        uint256 credits = drand.owedTo(poster);
        assertEq(credits, 2 * 600_000 * AUDIT_BASE_FEE, "draws A and B paid their rounds' posts");
        assertEq(address(drand).balance, credits + drand.bountyOf(silentRound));
        assertEq(a.tickets.balance, 0);
        assertEq(address(src).balance, 0);
        _withdrawBounty(poster, payable(eoa7702));
        assertEq(drand.owedTo(poster), 0);
        _addBounty(eoa[2], r0 + 1000, 0.01 ether, true);
        _forceEth(address(src), 7);
        _forceEth(address(drand), 11);
        assertEq(address(drand).balance, drand.bountyOf(silentRound) + drand.bountyOf(r0 + 1000) + 11, "pots + forced");
        assertEq(address(src).balance, 7, "forced ETH stays at the backed source (no exit, M27's class)");
        _assertGhostLedger();
    }
}

/// @notice The same under Amsterdam.
/// forge-config: default.evm_version = "amsterdam"
contract AuditU8ClaudeBox0AmsterdamTest is AuditU8ClaudeBox0Test {}

/// @title AuditU8ClaudeBox0GraduationGasTest (U8 P8.8 on box 0: a usable graduation word cannot be starved)
/// @notice Box 0 graduated; the graduation word usable (drand posted on time, or the backup fixed on day 5), the
/// clock 1 s past the request's 7 days, the word not accepted. At any gas limit: `enterTerminal` never passes (only
/// `HeadNotDead(0, deadline)`, `GasTooLow` or out of gas), and `acceptGraduationWord` either stores the right word or
/// reverts for gas (never `WordNotReady`). Sources: `DrandWords.sol:23-25`, `BoxTickets.sol:776-778` (the copy), F61 R4.
/// forge-config: default.evm_version = "osaka"
contract AuditU8ClaudeBox0GraduationGasTest is AuditU8ClaudeBox0Base {
    bytes32 internal expected;
    uint256 internal deadline;

    function setUp() public virtual override {
        super.setUp();
        _toGraduated();
        if (_backupWord()) {
            _toSilentFromGraduation();
            _backup(r0, keccak256("audit.u8.gas.mix"), eoa[2]);
            expected = _word(src.BACKUP_TAG(), keccak256("audit.u8.gas.mix"), 0);
        } else {
            _advance(1);
            _post(r0);
            (bytes32 randomness,) = drand.beaconOf(r0);
            expected = _word(src.DRAND_TAG(), randomness, 0);
        }
        deadline = uint256(tickets.status().wordRequestedAt) + tickets.SILENCE();
        _warpTo(deadline + 1);
    }

    function _backupWord() internal pure virtual returns (bool) {
        return false;
    }

    function testFuzz_AUDIT_U8_enterTerminalNeverPassesOnAUsableGraduationWord(uint256 gas) public {
        gas = bound(gas, 21_000, 400_000);
        _coolAll();
        (bool ok, bytes memory ret) = a.tickets.call{gas: gas}(abi.encodeCall(BoxTickets.enterTerminal, ()));
        assertFalse(ok, "never terminal on a usable word");
        assertTrue(_gasRefusal(ret) || _is(ret, abi.encodeWithSelector(IBoxTickets.HeadNotDead.selector, 0, deadline)));
        assertEq(uint8(tickets.phase()), uint8(TicketPhase.AwaitingWord));
    }

    function testFuzz_AUDIT_U8_acceptNeverReadsNoWordForLackOfGas(uint256 gas) public {
        gas = bound(gas, 21_000, 400_000);
        _coolAll();
        (bool ok, bytes memory ret) = a.tickets.call{gas: gas}(abi.encodeCall(BoxTickets.acceptGraduationWord, ()));
        if (ok) {
            assertEq(tickets.graduationWord(), expected, "the right word");
        } else {
            assertTrue(_gasRefusal(ret), "a refusal for gas, never WordNotReady");
            assertEq(tickets.graduationWord(), bytes32(0));
        }
    }
}

/// forge-config: default.evm_version = "osaka"
contract AuditU8ClaudeBox0GraduationBackupGasTest is AuditU8ClaudeBox0GraduationGasTest {
    function _backupWord() internal pure override returns (bool) {
        return true;
    }
}

/// forge-config: default.evm_version = "amsterdam"
contract AuditU8ClaudeBox0GraduationGasAmsterdamTest is AuditU8ClaudeBox0GraduationGasTest {}

/// forge-config: default.evm_version = "amsterdam"
contract AuditU8ClaudeBox0GraduationBackupGasAmsterdamTest is AuditU8ClaudeBox0GraduationBackupGasTest {}

/// @title AuditU8ClaudeBox0DrawHeadTest (U8 P8.6 and P8.8 on box 0's silent draw C)
/// @notice `AuditPhases._toSilent`: draw C (the EIP-7702 EOA) on a round drand never answers, the clock 5 days and 1 s
/// past that round's time. Properties:
/// - P8.6: neither the starter nor the fixer nor the moment of the fix (anywhere in the 8,191-block window) changes
///   draw C's word or its item: both are a function of the target block's prevRandao (modelled as the chain's fixed
///   mix for that block) and draw C's id;
/// - P8.8: with C's backup word fixed and the clock past C's 7 days, at any gas limit `enterTerminal` never passes,
///   `settle(1)` settles C or reverts for gas (never `NothingSettled`), and a new draw is never refused `QueueDead`
///   (its other refusals are for gas: out of gas, `GasTooLow`, or the vault's `ObserverGasTooLow` floor).
/// forge-config: default.evm_version = "osaka"
contract AuditU8ClaudeBox0DrawHeadTest is AuditU8ClaudeBox0Base {
    function setUp() public virtual override {
        super.setUp();
        _toSilent();
    }

    /// @dev The chain's mix for block `n` (what its header would carry).
    function _chainMix(uint256 n) internal pure returns (bytes32) {
        return keccak256(abi.encode("audit.u8.chain.mix", n));
    }

    function _runBackup(address starter, address fixer, uint256 fixDelay) internal returns (bytes32 w, uint256 item) {
        uint256 target = _startBackup(silentRound, starter);
        vm.roll(target + fixDelay);
        vm.warp(vm.getBlockTimestamp() + SLOT * (256 + fixDelay));
        _fixBackup(silentRound, _chainMix(target), fixer);
        (w,) = src.wordOf(a.tickets, drawC);
        _settle(keeper, 1);
        item = tickets.drawTicket(drawC).itemId;
    }

    function testFuzz_AUDIT_U8_starterAndFixerCannotChooseDrawCsItem(uint256 s, uint256 f, uint256 fixDelay) public {
        uint256 snap = vm.snapshotState();
        (bytes32 w1, uint256 item1) = _runBackup(eoa[2], poster, 1);
        vm.revertToState(snap);
        address starter = address(uint160(uint256(keccak256(abi.encode("starter", s)))));
        address fixer = address(uint160(uint256(keccak256(abi.encode("fixer", f)))));
        fixDelay = bound(fixDelay, 1, src.HISTORY_WINDOW());
        (bytes32 w2, uint256 item2) = _runBackup(starter, fixer, fixDelay);
        assertEq(w2, w1, "the same word");
        assertEq(item2, item1, "the same item");
        assertEq(w1, _word(src.BACKUP_TAG(), _chainMix(vm.getBlockNumber() - fixDelay), drawC));
    }
}

/// @notice The same under Amsterdam (the fix reads EIP-2935's history for most of the window).
/// forge-config: default.evm_version = "amsterdam"
contract AuditU8ClaudeBox0DrawHeadAmsterdamTest is AuditU8ClaudeBox0DrawHeadTest {}

/// @title AuditU8ClaudeBox0DrawHeadGasTest (U8 P8.8: draw C's usable backup word cannot be starved)
/// forge-config: default.evm_version = "osaka"
contract AuditU8ClaudeBox0DrawHeadGasTest is AuditU8ClaudeBox0Base {
    uint256 internal deadline;
    address internal drawer;

    function setUp() public virtual override {
        super.setUp();
        _toSilent();
        _backup(silentRound, keccak256("audit.u8.drawC.mix"), eoa[2]);
        deadline = tickets.drawTicket(drawC).requestedAt + tickets.SILENCE();
        _warpTo(deadline + 1);
        drawer = eoa[4];
        _buy(drawer, 0.5 ether); // T for one more draw, bought in the graduated pool
        _approveT(drawer, a.tickets);
        _fund(drawer, 1 ether);
    }

    function testFuzz_AUDIT_U8_enterTerminalNeverPassesOnAUsableDrawHead(uint256 gas) public {
        gas = bound(gas, 21_000, 400_000);
        _coolAll();
        (bool ok, bytes memory ret) = a.tickets.call{gas: gas}(abi.encodeCall(BoxTickets.enterTerminal, ()));
        assertFalse(ok);
        assertTrue(
            _gasRefusal(ret) || _is(ret, abi.encodeWithSelector(IBoxTickets.HeadNotDead.selector, drawC, deadline))
        );
        assertEq(uint8(tickets.phase()), uint8(TicketPhase.Drawing));
    }

    function testFuzz_AUDIT_U8_settleNeverSkipsAUsableHead(uint256 gas) public {
        gas = bound(gas, 21_000, 600_000);
        _coolAll();
        (bool ok, bytes memory ret) = a.tickets.call{gas: gas}(abi.encodeCall(BoxTickets.settle, (1)));
        if (ok) {
            assertEq(abi.decode(ret, (uint256)), 1);
            assertEq(uint8(tickets.drawTicket(drawC).status), uint8(DrawStatus.Settled));
        } else {
            assertTrue(_gasRefusal(ret), "never NothingSettled on a usable word");
            assertEq(uint8(tickets.drawTicket(drawC).status), uint8(DrawStatus.Requested));
        }
    }

    function testFuzz_AUDIT_U8_drawNeverRefusedQueueDeadOnAUsableHead(uint256 gas) public {
        gas = bound(gas, 21_000, 1_500_000);
        _coolAll();
        uint256 deadline_ = vm.getBlockTimestamp();
        vm.prank(drawer);
        (bool ok, bytes memory ret) = a.tickets.call{value: AUDIT_DRAW_VALUE, gas: gas}(
            abi.encodeCall(BoxTickets.draw, (type(uint256).max, deadline_))
        );
        if (ok) return;
        assertTrue(ret.length < 4 || bytes4(ret) != IBoxTickets.QueueDead.selector, "never QueueDead on a usable head");
        // The other refusals are for gas: out of gas, the tickets' GasTooLow, or the vault's observer floor.
        assertTrue(_gasRefusal(ret) || bytes4(ret) == IBoxVault.ObserverGasTooLow.selector, "a refusal for gas only");
    }
}

/// forge-config: default.evm_version = "amsterdam"
contract AuditU8ClaudeBox0DrawHeadGasAmsterdamTest is AuditU8ClaudeBox0DrawHeadGasTest {}
