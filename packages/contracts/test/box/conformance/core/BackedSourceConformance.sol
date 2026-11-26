// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IDrandSource} from "../../../../src/box/interfaces/IDrandSource.sol";
import {BackedSourcePins} from "../../../../src/box/randomness/BackedSourcePins.sol";
import {BoxBackedSource} from "../../../../src/box/randomness/BoxBackedSource.sol";
import {DrandSourcePins} from "../../../../src/box/randomness/DrandSourcePins.sol";
import {BoxDrandVectors} from "../../randomness/utils/BoxDrandVectors.sol";
import {HeaderVectors} from "../../backup/HeaderVectors.sol";
import {ProbeState} from "../../randomness/utils/ProbeState.sol";
import {CodeScan} from "../CodeScan.sol";

/// @notice BC-053's instance checks on box 0's BoxBackedSource (F143; the verifier's rewrite of "drand only, no backup
/// source"), in the S2 harness's shape: one abstract suite, run by every core v1 provider on the source its box's
/// coordinator names (`_backedSource()`), each check inside `vm.snapshotState` / `vm.revertToState`, nothing
/// broadcast. On a live chain anyone may already have posted a probe's committed round, requested from its labelled
/// consumers (`makeAddr` keys are public) or forced ETH into the source: each probe first resets the round, the backup
/// and the request on its snapshot (`ProbeState`, rc8 open item 78), writing nothing where nobody touched them, and the
/// ETH check is behavioural (no plain transfer in, a request's value forwarded whole). The DrandSource it names still runs S9's three instance checks (`DrandSourceConformance`, on
/// `BoxBackedSource.DRAND`). Checks:
/// - **fixed at creation, no owner, no restart:** the code dispatches the reviewed functions only (no owner, admin,
///   pause, upgrade, setter, rescue, Chainlink or restart function; the prototype's restart error is absent), makes no
///   delegate call and cannot change its code; its constants are F143's (5 days, the latest start at 5 days 18 hours,
///   a start's header at most 8 blocks old, 256 blocks, EIP-2935's window and address, the consumers' 7 days and
///   MARGIN, both equal to the DrandSource's); on chains 1 and 11155111 both it and the DrandSource it names are the
///   pinned deployments (address and code hash);
/// - **drand first, then the backup by the rule only:** a word comes from the drand round fixed at the request once
///   anyone posts it; an unposted round may fall back only from 5 days to 5 days 18 hours after its time, for anyone,
///   with the header of one of the last 8 blocks, proved by its hash (a header that does not match, one too old and the
///   current block's are refused); a posted round never falls back; a start after the latest time is refused and a
///   drand post still counts; once started, a late drand post is ignored; the fix takes only the target's own header
///   (a neighbour's is refused); the backup word is the target's prevRandao bound to (consumer, key);
/// - **one target per round:** a second start is refused, also at the latest start with the target's mix public, and
///   after the target has left EIP-2935's window.
abstract contract BackedSourceConformance is BoxDrandVectors {
    /// @dev The backed source under test.
    function _backedSource() internal view virtual returns (BoxBackedSource);

    modifier backedCheck() {
        uint256 snap = vm.snapshotState();
        _;
        vm.revertToState(snap);
    }

    /// BC-053 (F143): the backup is fixed at creation, with no owner, no setter and no restart.
    function test_BC053_backedSourceFixedAtCreation_noOwnerNoRestart() public virtual backedCheck {
        BoxBackedSource src = _backedSource();
        address at = address(src);
        assertGt(at.code.length, 0, "the source has code");
        assertFalse(CodeScan.isDelegation(at.code), "not a delegation");
        bytes memory code = at.code;
        assertFalse(CodeScan.hasOpcode(code, CodeScan.OP_DELEGATECALL), "no DELEGATECALL");
        assertFalse(CodeScan.hasOpcode(code, CodeScan.OP_CALLCODE), "no CALLCODE");
        assertFalse(CodeScan.hasOpcode(code, CodeScan.OP_SELFDESTRUCT), "no SELFDESTRUCT");
        assertFalse(CodeScan.hasOpcode(code, 0xf0), "no CREATE");
        assertFalse(CodeScan.hasOpcode(code, 0xf5), "no CREATE2");
        uint32[] memory words = CodeScan.pushedWords(code);
        bytes4[5] memory used = [
            BoxBackedSource.startBackup.selector,
            BoxBackedSource.fixBackup.selector,
            BoxBackedSource.wordOf.selector,
            BoxBackedSource.request.selector,
            BoxBackedSource.isSilent.selector
        ];
        for (uint256 i; i < used.length; ++i) {
            assertTrue(CodeScan.pushes(words, used[i]), "positive control");
        }
        string[25] memory denied = [
            "owner()",
            "pendingOwner()",
            "transferOwnership(address)",
            "acceptOwnership()",
            "renounceOwnership()",
            "admin()",
            "pause()",
            "unpause()",
            "paused()",
            "upgradeTo(address)",
            "upgradeToAndCall(address,bytes)",
            "setSource(address)",
            "setDrand(address)",
            "setBackupAfter(uint256)",
            "setTargetBlocks(uint256)",
            "rescue(address)",
            "withdraw()",
            "postRound(uint256,bytes)",
            "restartBackup(uint256)",
            "restartBackup(uint256,bytes)",
            "cancelBackup(uint256)",
            "startBackup(uint256)",
            "startBackup(uint256,bytes)",
            "requestFee()",
            "rawFulfillRandomWords(uint256,uint256[])"
        ];
        for (uint256 i; i < denied.length; ++i) {
            assertFalse(
                CodeScan.pushes(words, bytes4(keccak256(bytes(denied[i])))), string.concat("denied: ", denied[i])
            );
        }
        // The design study's restart (`BackupPending`, a fresh target after the window) is gone: solc pushes a custom
        // error's selector left-aligned with PUSH32, so the scan reads those (positive control: the one-start error).
        assertTrue(_pushes32(code, BoxBackedSource.BackupAlreadyStarted.selector), "positive control: one start");
        assertFalse(_pushes32(code, bytes4(keccak256("BackupPending(uint256,uint256)"))), "no restart error");
        // F143's constants.
        IDrandSource drand = src.DRAND();
        assertEq(address(drand), DrandSourcePins.ADDRESS_MAINNET, "names the pinned DrandSource");
        assertEq(src.BACKUP_AFTER(), 5 days, "F143 (2): 5 days, not 3");
        assertEq(src.LATEST_START(), 5 days + 18 hours, "the latest start (security review F1)");
        assertEq(src.RECENT_BLOCKS(), 8, "a start's header at most 8 blocks old (security review F3)");
        assertLe(
            src.LATEST_START() + 15 + 12 * (256 + 8191), 7 days, "the latest start's whole fix window inside 7 days"
        );
        assertEq(src.TARGET_BLOCKS(), 256, "the target 256 blocks ahead");
        assertEq(src.HISTORY_WINDOW(), 8191, "EIP-2935's window");
        assertEq(src.HISTORY(), 0x0000F90827F1C53a10cb7A02335B175320002935, "EIP-2935's contract");
        assertEq(src.SILENCE(), 7 days, "the consumers' 7 days");
        assertEq(src.SILENCE(), drand.SILENCE(), "the DrandSource's silence");
        assertEq(src.MARGIN(), drand.MARGIN(), "the DrandSource's margin");
        assertEq(src.DRAND_TAG(), keccak256("squarehole.randomness.backed.drand-quicknet"));
        assertEq(src.BACKUP_TAG(), keccak256("squarehole.randomness.backed.randao"));
        // Holds no ETH of its own: a plain transfer is refused and a request's value goes whole to the DrandSource's pot.
        // (Forced ETH, SELFDESTRUCT's transfer or a fee recipient's, can reach any address and stays unmovable here.)
        uint256 held = at.balance;
        vm.deal(address(this), 2);
        (bool accepted,) = at.call{value: 1}("");
        assertFalse(accepted, "no receive");
        address payer = makeAddr("bc053.backed.eth");
        ProbeState.freshBackedRequest(vm, src, payer, 0);
        uint256 round = src.roundAt(block.timestamp + src.MARGIN());
        uint256 pot = drand.bountyOf(round);
        vm.deal(payer, 1);
        vm.prank(payer);
        assertEq(src.request{value: 1}(0), round, "the round fixed at the request");
        assertEq(drand.bountyOf(round), pot + 1, "the request's value is the round's pot on the DrandSource");
        assertEq(at.balance, held, "holds nothing it was sent");
        if (block.chainid == 1 || block.chainid == 11_155_111) {
            assertTrue(BackedSourcePins.isPinned(at), "the pinned BoxBackedSource (address and code hash)");
            assertTrue(DrandSourcePins.isPinned(address(drand)), "the pinned DrandSource (address and code hash)");
        }
    }

    /// BC-053 (F143): drand first; the backup only by the rule (from 5 days to 5 days 18 hours, anyone, a recent
    /// block's header proved by its hash), never on a posted round; once started, a late drand post is ignored; the fix
    /// takes only the target's header.
    function test_BC053_backedSourceDrandFirstThenBackupByRule() public virtual backedCheck {
        BoxBackedSource src = _backedSource();
        address box = makeAddr("bc053.backed.box");
        _drandFirst(src, box);
        _backupByRuleOnly(src, box);
        _lateStartRefused(src, box);
    }

    /// @dev A posted round: drand's word, and it never falls back.
    function _drandFirst(BoxBackedSource src, address box) internal {
        uint256 round = _localFirst();
        uint256 at = src.roundTime(round);
        ProbeState.freshBackedRound(vm, src, round);
        ProbeState.freshBackedRequest(vm, src, box, 1);
        vm.warp(at - 12);
        vm.prank(box);
        assertEq(src.request(1), round, "the round fixed at the request");
        vm.warp(at);
        src.DRAND().postRound(round, _localSig(0));
        bytes32 r = _boxDrand(round).randomness;
        (bytes32 w1, uint64 ready1) = src.wordOf(box, 1);
        assertEq(w1, keccak256(abi.encode(src.DRAND_TAG(), r, keccak256(abi.encode(box, uint256(1))))), "drand's");
        assertEq(ready1, at);
        vm.warp(at + 5 days + 1);
        bytes memory parent = HeaderVectors.MAINNET;
        vm.setBlockhash(block.number - 1, keccak256(parent));
        vm.expectRevert(abi.encodeWithSelector(BoxBackedSource.RoundAlreadyPosted.selector, round));
        src.startBackup(round, block.number - 1, parent);
        (bytes32 again,) = src.wordOf(box, 1);
        assertEq(again, w1, "a posted round keeps its drand word");
    }

    /// @dev A round nobody posts: the start only after 5 days, by anyone, with a recent header proved by its hash; a
    /// late post ignored; the fix only with the target's header; the backup's word.
    function _backupByRuleOnly(BoxBackedSource src, address box) internal {
        uint256 late = _localFirst() + 3;
        uint256 lateAt = src.roundTime(late);
        ProbeState.freshBackedRound(vm, src, late);
        ProbeState.freshBackedRequest(vm, src, box, 3);
        vm.warp(lateAt - 12);
        vm.prank(box);
        assertEq(src.request(3), late);
        vm.warp(lateAt + 5 days);
        bytes memory parent = HeaderVectors.MAINNET;
        vm.setBlockhash(block.number - 1, keccak256(parent));
        vm.expectRevert(abi.encodeWithSelector(BoxBackedSource.BackupTooEarly.selector, late, lateAt + 5 days));
        src.startBackup(late, block.number - 1, parent);
        vm.warp(lateAt + 5 days + 1);
        _startProofsRefused(src, late, parent);
        // A header up to 8 blocks old still proves the format (a transaction included a few blocks late).
        vm.setBlockhash(block.number - 8, keccak256(parent));
        vm.prank(makeAddr("bc053.backed.anyone"));
        uint256 target = src.startBackup(late, block.number - 8, parent);
        assertEq(target, block.number + 256);
        src.DRAND().postRound(late, _localSig(3)); // too late: ignored for good
        (bytes32 w3, uint64 ready3) = src.wordOf(box, 3);
        assertEq(w3, bytes32(0), "no word until the fix");
        assertEq(ready3, 0);
        vm.roll(target + 2);
        bytes memory header = _syntheticHeader(target, keccak256("bc053.backed.mix"));
        bytes memory neighbour = _syntheticHeader(target + 1, keccak256("bc053.backed.neighbour"));
        vm.setBlockhash(target, keccak256(header));
        vm.setBlockhash(target + 1, keccak256(neighbour));
        vm.expectRevert(abi.encodeWithSelector(BoxBackedSource.WrongHeader.selector, target));
        src.fixBackup(late, neighbour);
        src.fixBackup(late, header);
        (w3, ready3) = src.wordOf(box, 3);
        bytes32 want =
            keccak256(abi.encode(src.BACKUP_TAG(), keccak256("bc053.backed.mix"), keccak256(abi.encode(box, 3))));
        assertEq(w3, want, "the backup's");
        assertEq(ready3, block.timestamp);
    }

    /// @dev A start inside the time rule still needs a recent header that hashes to its block's hash: another header,
    /// one 9 blocks old and the current block's are refused, and nothing starts.
    function _startProofsRefused(BoxBackedSource src, uint256 round, bytes memory parent) internal {
        uint256 n = block.number - 1;
        vm.setBlockhash(n, keccak256(parent));
        vm.expectRevert(abi.encodeWithSelector(BoxBackedSource.WrongHeader.selector, n));
        src.startBackup(round, n, HeaderVectors.SEPOLIA);
        vm.setBlockhash(block.number - 9, keccak256(parent));
        vm.expectRevert(abi.encodeWithSelector(BoxBackedSource.HeaderUnavailable.selector, block.number - 9));
        src.startBackup(round, block.number - 9, parent);
        vm.expectRevert(abi.encodeWithSelector(BoxBackedSource.HeaderUnavailable.selector, block.number));
        src.startBackup(round, block.number, parent);
        (uint64 startedAt,,,) = src.backupOf(round);
        assertEq(startedAt, 0, "nothing started");
    }

    /// @dev A start after the latest time (5 days 18 hours) is refused, and a drand post before the 7 days still counts.
    function _lateStartRefused(BoxBackedSource src, address box) internal {
        uint256 round = _localFirst() + 9;
        uint256 at = src.roundTime(round);
        ProbeState.freshBackedRound(vm, src, round);
        ProbeState.freshBackedRequest(vm, src, box, 9);
        vm.warp(at - 12);
        vm.prank(box);
        assertEq(src.request(9), round);
        vm.warp(at + 5 days + 18 hours + 1);
        bytes memory parent = HeaderVectors.MAINNET;
        vm.setBlockhash(block.number - 1, keccak256(parent));
        vm.expectRevert(abi.encodeWithSelector(BoxBackedSource.BackupTooLate.selector, round, at + 5 days + 18 hours));
        src.startBackup(round, block.number - 1, parent);
        vm.warp(at - 12 + 7 days - 30 minutes);
        src.DRAND().postRound(round, _localSig(9));
        (bytes32 w, uint64 readyAt) = src.wordOf(box, 9);
        assertTrue(w != bytes32(0), "the timely drand post counts");
        assertEq(readyAt, block.timestamp);
        vm.warp(at - 12 + 7 days + 1);
        assertFalse(src.isSilent(box, 9), "not silent");
    }

    /// BC-053 (F143): one target per round; a second start is refused, also at the latest start the rule allows with the
    /// target's mix public, and once the target left EIP-2935's window.
    function test_BC053_backedSourceOneTargetPerRound() public virtual backedCheck {
        BoxBackedSource src = _backedSource();
        uint256 round = _localFirst() + 6;
        uint256 at = src.roundTime(round);
        address box = makeAddr("bc053.backed.once");
        ProbeState.freshBackedRound(vm, src, round);
        ProbeState.freshBackedRequest(vm, src, box, 0);
        vm.warp(at - 12);
        vm.prank(box);
        src.request(0);
        vm.warp(at + 5 days + 1);
        bytes memory parent = HeaderVectors.MAINNET;
        vm.setBlockhash(block.number - 1, keccak256(parent));
        uint256 target = src.startBackup(round, block.number - 1, parent);
        vm.expectRevert(abi.encodeWithSelector(BoxBackedSource.BackupAlreadyStarted.selector, round));
        src.startBackup(round, block.number - 1, parent);
        // At the latest start the rule allows (the target long mined, its mix public): still the one target.
        vm.roll(target + 4800);
        vm.warp(at + 5 days + 18 hours);
        vm.setBlockhash(block.number - 1, keccak256(parent));
        vm.expectRevert(abi.encodeWithSelector(BoxBackedSource.BackupAlreadyStarted.selector, round));
        src.startBackup(round, block.number - 1, parent);
        // After the target's window (and the latest start): refused too.
        vm.roll(target + 8191 + 1);
        vm.warp(block.timestamp + 12 * (8191 + 1 - 4800));
        vm.setBlockhash(block.number - 1, keccak256(parent));
        vm.expectRevert(abi.encodeWithSelector(BoxBackedSource.BackupTooLate.selector, round, at + 5 days + 18 hours));
        src.startBackup(round, block.number - 1, parent);
        (, uint64 targetBlock,,) = src.backupOf(round);
        assertEq(targetBlock, target, "the first target stays");
        vm.warp(at - 12 + 7 days + 1);
        assertTrue(src.isSilent(box, 0), "silent after 7 days, as a round nobody posts");
    }

    /// @dev Whether the code pushes `selector` left-aligned with PUSH32 (how solc writes a custom error's selector).
    function _pushes32(bytes memory code, bytes4 selector) internal pure returns (bool) {
        bytes32 want = bytes32(selector);
        uint256 i;
        while (i < code.length) {
            uint8 op = uint8(code[i]);
            if (op >= 0x60 && op <= 0x7f) {
                uint256 n = op - 0x5f;
                if (op == 0x7f && i + 32 < code.length) {
                    bytes32 v;
                    for (uint256 k; k < 32; ++k) {
                        v |= bytes32(code[i + 1 + k]) >> (8 * k);
                    }
                    if (v == want) return true;
                }
                i += 1 + n;
            } else {
                ++i;
            }
        }
        return false;
    }

    /// A synthetic post-London header (13 fields, prevRandao, nonce, baseFee).
    function _syntheticHeader(uint256 number, bytes32 mix) internal pure returns (bytes memory) {
        bytes memory body = bytes.concat(
            bytes.concat(
                hex"a0", keccak256("parent"), hex"a0", keccak256("ommers"), hex"94", bytes20(address(0xC0FFEE))
            ),
            bytes.concat(hex"a0", keccak256("state"), hex"a0", keccak256("txs"), hex"a0", keccak256("receipts")),
            bytes.concat(hex"b90100", new bytes(256), hex"80", hex"84", bytes4(uint32(number)), hex"8403938700"),
            bytes.concat(hex"83bc614e", hex"846ab0a080", hex"83616263", hex"a0", mix, hex"880000000000000000", hex"07")
        );
        return bytes.concat(hex"f9", bytes2(uint16(body.length)), body);
    }
}
