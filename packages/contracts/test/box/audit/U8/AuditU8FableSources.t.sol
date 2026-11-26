// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {IDrandSource} from "../../../../src/box/interfaces/IDrandSource.sol";
import {BackedSourcePins} from "../../../../src/box/randomness/BackedSourcePins.sol";
import {BoxBackedSource} from "../../../../src/box/randomness/BoxBackedSource.sol";
import {DrandSource} from "../../../../src/box/randomness/DrandSource.sol";
import {DrandSourcePins} from "../../../../src/box/randomness/DrandSourcePins.sol";
import {PinnedBackedSource} from "../../randomness/utils/PinnedBackedSource.sol";
import {PinnedDrandSource} from "../../randomness/utils/PinnedDrandSource.sol";
import {EthIn, EthOut} from "../common/AuditGhostLedger.sol";
import {AuditU8FableBase, AuditU8FableReentrantRecipient} from "./AuditU8FableBase.sol";

/// @title AuditU8FableSourcesTest (SH-AUDIT-B0-U8-F, lenses L1, L2, L3, L7 and L8 on the two sources)
/// @notice The pinned DrandSource and BoxBackedSource of the shared world across box 0's life: ETH held equals the
/// unposted pots plus the unwithdrawn credits (IDrandSource.sol:23-25, DrandSource.sol:43-48); the backed source
/// forwards every wei and holds nothing (BoxBackedSource.sol:12-15); one request per (consumer, key) with the exact
/// forwarded key encoding (BoxBackedSource.sol:118-125, :250-252); words carry their tag (:107-108, DrandSource.sol:
/// 75); once-only posts, starts and fixes with their callers and moments (DrandSource.sol:115-130, BoxBackedSource.sol:
/// 157-207); a re-entering, refusing, gas-burning or EIP-7702-delegated bounty recipient (DrandSource.sol:132-144);
/// the round clock against quicknet's genesis and period at every boundary (DrandSource.sol:199-209) and near
/// 2^64; the start window's edges; the CREATE2 pins (DrandSourcePins.sol, BackedSourcePins.sol, BC-101, F143).
/// forge-config: default.evm_version = "osaka"
contract AuditU8FableSourcesTest is AuditU8FableBase {
    uint256 internal constant GENESIS = 1_692_803_367;

    /// @dev Rounds outside r0 … r0 + 47 that a test gave a pot (watched for the balance equality), each once: two
    /// requests in one block share a round.
    uint256[] internal watched;

    function _watch(uint256 round) internal {
        if (round >= r0 && round < r0 + 48) return;
        for (uint256 i; i < watched.length; ++i) {
            if (watched[i] == round) return;
        }
        watched.push(round);
    }

    /// @dev Σ unposted pots over the rounds this world touches plus Σ credits of its posters, read from the views.
    function _potsAndCredits() internal view returns (uint256 sum) {
        for (uint256 i; i < 48; ++i) {
            sum += drand.bountyOf(r0 + i);
        }
        for (uint256 i; i < watched.length; ++i) {
            sum += drand.bountyOf(watched[i]);
        }
        address[11] memory who = [
            poster,
            keeper,
            eoa[0],
            eoa[1],
            eoa[2],
            eoa[3],
            eoa[4],
            eoa[5],
            eoa7702,
            address(contractDrawer),
            address(this)
        ];
        for (uint256 i; i < who.length; ++i) {
            sum += drand.owedTo(who[i]);
        }
    }

    function _assertSourcesBalanced(string memory when) internal view {
        assertEq(address(drand).balance, _potsAndCredits() + ghostEthIn(EthIn.Forced), when);
        assertEq(address(src).balance, 0, string.concat("the backed source holds nothing: ", when));
    }

    // ------------------------------------------------------------------------------------------------ L1 P8.1

    /// P8.1: through creation, graduation, the posted rounds, the draws' pots, a silent round, a withdrawal, direct
    /// bounties and requests, the DrandSource holds exactly Σ unposted pots + Σ unwithdrawn credits, the ghost ledger
    /// balances, and the backed source holds 0 wei after every call (IDrandSource.sol:24-25; DrandSource.sol:44-46).
    function testProperty_AUDIT_U8_ethHeldEqualsPotsPlusCreditsAcrossBox0sLife() public {
        _assertSourcesBalanced("created");
        _toGraduated();
        _assertSourcesBalanced("graduated (the word's request carries no pot)");
        assertEq(drand.bountyOf(r0), 0, "the graduation word's request carries no bounty");
        _toDrawing();
        _assertSourcesBalanced("drawing: two draws paid their rounds' pots, posted and credited to the poster");
        assertEq(drand.owedTo(poster), 2 * 600_000 * AUDIT_BASE_FEE, "two 600,000-gas pots at 1 gwei");
        _toSilent();
        _assertSourcesBalanced("silent: draw C's pot waits on an unposted round");
        assertEq(drand.bountyOf(silentRound), 600_000 * AUDIT_BASE_FEE, "draw C's pot");
        uint256 credit = drand.owedTo(poster);
        uint256 e0 = eoa[0].balance;
        assertEq(_withdrawBounty(poster, payable(eoa[0])), credit);
        assertEq(eoa[0].balance - e0, credit, "the credit left to its recipient");
        assertEq(drand.owedTo(poster), 0);
        _assertSourcesBalanced("after the withdrawal");
        _addBounty(eoa[1], silentRound, 0.02 ether, true);
        _addBounty(eoa[2], silentRound + 100, 0.03 ether, false);
        _watch(silentRound + 100);
        _watch(_requestRound(eoa[3], 77, 0.04 ether, true));
        _watch(_requestRound(eoa[4], 78, 0.05 ether, false));
        _assertSourcesBalanced("after bounties and requests through both sources");
        _assertGhostLedger();
        // M27 (accepted, F126): forced ETH stays and is the only thing the equality excludes.
        _forceEth(address(drand), 1 wei);
        _assertSourcesBalanced("forced ETH counted apart (M27)");
        _assertGhostLedger();
    }

    /// P8.1: the backed source forwards exactly `msg.value` on `request` and `addBounty` (zero included), has no
    /// `receive`, and reverts whole when the DrandSource refuses, so it never holds a wei (BoxBackedSource.sol:13-15);
    /// forced ETH there has no exit either (the same class as M27: nothing reads the balance).
    function testProperty_AUDIT_U8_backedSourceForwardsEveryWeiAndHoldsNothing() public {
        _toGraduated();
        _requestRound(eoa[0], 1, 0, true);
        _requestRound(eoa[1], 1, 1 wei, true);
        _requestRound(eoa[2], 1, 1.5 ether, true);
        _addBounty(eoa[0], r0 + 4, 0, true);
        _addBounty(eoa[0], r0 + 4, 0.25 ether, true);
        assertEq(drand.bountyOf(r0), 1.5 ether + 1 wei, "both requests' values in r0's pot");
        assertEq(drand.bountyOf(r0 + 4), 0.25 ether);
        assertEq(src.bountyOf(r0 + 4), 0.25 ether, "bountyOf forwards too");
        assertEq(address(src).balance, 0);
        _fund(eoa[3], 1 ether);
        vm.prank(eoa[3]);
        (bool ok,) = address(src).call{value: 1 wei}("");
        assertFalse(ok, "no receive");
        vm.prank(eoa[3]);
        (ok,) = address(src).call{value: 1 wei}(hex"12345678");
        assertFalse(ok, "no fallback");
        _advance(1);
        _post(r0);
        vm.prank(eoa[3]);
        vm.expectRevert(abi.encodeWithSelector(IDrandSource.RoundKnown.selector, r0));
        src.addBounty{value: 1 wei}(r0);
        vm.prank(eoa[3]);
        vm.expectRevert(abi.encodeWithSelector(IDrandSource.InvalidRound.selector, 0));
        src.addBounty{value: 1 wei}(0);
        assertEq(address(src).balance, 0, "a refused forward returns the value with the revert");
        _assertSourcesBalanced("after forwards and refusals");
        _forceEth(address(src), 3 wei);
        _requestRound(eoa[4], 1, 0.1 ether, true);
        _addBounty(eoa[4], r0 + 8, 0.1 ether, true);
        assertEq(address(src).balance, 3 wei, "forwards move msg.value only: forced ETH stays (M27's class)");
        _assertGhostLedger();
    }

    // ------------------------------------------------------------------------------------------------ L2 P8.2

    /// P8.2: the key the backed source forwards is keccak256(abi.encode(consumer, key)) (padded, 64 bytes), keyed on
    /// the DrandSource by (the backed source, that key): the request is found under exactly that encoding and under
    /// no packed or swapped one; the tickets' graduation word (key 0) is the same.
    function testProperty_AUDIT_U8_forwardedKeysUseThePaddedEncoding() public {
        _toGraduated();
        uint256 round = _requestRound(eoa[0], 5, 0, true);
        assertEq(round, r0);
        uint256 id = uint256(keccak256(abi.encode(eoa[0], uint256(5))));
        (uint64 at, uint64 r) = drand.requestOf(address(src), id);
        assertEq(r, r0, "found under keccak256(abi.encode(consumer, key))");
        assertEq(at, uint64(vm.getBlockTimestamp()));
        (, r) = drand.requestOf(address(src), uint256(keccak256(abi.encodePacked(eoa[0], uint256(5)))));
        assertEq(r, 0, "not under the packed encoding");
        (, r) = drand.requestOf(address(src), uint256(keccak256(abi.encode(uint256(5), eoa[0]))));
        assertEq(r, 0, "not swapped");
        (, r) = drand.requestOf(eoa[0], 5);
        assertEq(r, 0, "not under the consumer's own address");
        (, r) = drand.requestOf(address(src), uint256(keccak256(abi.encode(a.tickets, uint256(0)))));
        assertEq(r, r0, "the tickets' graduation word is keyed the same way");
        (, r) = src.requestOf(eoa[0], 5);
        assertEq(r, r0, "and the backed source's requestOf finds it");
    }

    /// P8.2: for any two distinct (consumer, key) pairs both requests land, each under its own derived key, and
    /// neither blocks or reads the other; the same pair twice is refused with the DrandSource's error naming the
    /// backed source and the derived key.
    function testFuzz_AUDIT_U8_forwardedKeysDifferForDistinctPairs(address c1, uint256 k1, address c2, uint256 k2)
        public
    {
        vm.assume(c1 != c2 || k1 != k2);
        vm.assume(uint160(c1) > 0xffff && uint160(c2) > 0xffff);
        vm.assume(c1 != address(drand) && c2 != address(drand) && c1 != address(src) && c2 != address(src));
        vm.assume(c1.code.length == 0 && c2.code.length == 0);
        _warpTo(_requestTimeFor(r0));
        uint256 id1 = uint256(keccak256(abi.encode(c1, k1)));
        uint256 id2 = uint256(keccak256(abi.encode(c2, k2)));
        assertTrue(id1 != id2);
        vm.prank(c1);
        assertEq(src.request(k1), r0);
        vm.prank(c2);
        assertEq(src.request(k2), r0);
        (, uint64 r1) = drand.requestOf(address(src), id1);
        (, uint64 r2) = drand.requestOf(address(src), id2);
        assertEq(r1, r0);
        assertEq(r2, r0);
        vm.prank(c1);
        vm.expectRevert(abi.encodeWithSelector(IDrandSource.AlreadyRequested.selector, address(src), id1));
        src.request(k1);
        _advance(1);
        _post(r0);
        (bytes32 w1,) = src.wordOf(c1, k1);
        (bytes32 w2,) = src.wordOf(c2, k2);
        assertTrue(w1 != bytes32(0) && w2 != bytes32(0) && w1 != w2, "distinct words on one round");
    }

    /// P8.2: words carry their tag: the backed source's drand word is keccak256(abi.encode(DRAND_TAG, randomness,
    /// id)), its backup word uses BACKUP_TAG, the DrandSource's own uses WORD_TAG; the three differ for one round and
    /// one id, and the DrandSource's word for (the backed source, derived key) is none of the consumer's words.
    function testProperty_AUDIT_U8_wordsCarryTheirTag() public {
        _toGraduated();
        _requestRound(eoa[1], 7, 0, true);
        _requestRound(eoa[1], 7, 0, false);
        _advance(1);
        _post(r0);
        (bytes32 randomness, uint64 postedAt) = drand.beaconOf(r0);
        bytes32 id = keccak256(abi.encode(eoa[1], uint256(7)));
        (bytes32 backed, uint64 at) = src.wordOf(eoa[1], 7);
        assertEq(backed, keccak256(abi.encode(src.DRAND_TAG(), randomness, id)), "the drand tag");
        assertEq(at, postedAt);
        (bytes32 direct,) = drand.wordOf(eoa[1], 7);
        assertEq(direct, keccak256(abi.encode(drand.WORD_TAG(), randomness, id)), "the DrandSource's own tag");
        (bytes32 inner,) = drand.wordOf(address(src), uint256(id));
        assertEq(inner, keccak256(abi.encode(drand.WORD_TAG(), randomness, keccak256(abi.encode(address(src), id)))));
        assertTrue(backed != direct && backed != inner && direct != inner, "three distinct words");
        vm.prank(keeper);
        tickets.acceptGraduationWord();
        assertEq(tickets.graduationWord(), _word(src.DRAND_TAG(), randomness, 0), "the tickets store the tagged word");
        assertTrue(src.DRAND_TAG() != src.BACKUP_TAG() && src.DRAND_TAG() != drand.WORD_TAG());
        assertEq(src.DRAND_TAG(), keccak256("squarehole.randomness.backed.drand-quicknet"));
        assertEq(src.BACKUP_TAG(), keccak256("squarehole.randomness.backed.randao"));
        assertEq(drand.WORD_TAG(), keccak256("squarehole.randomness.drand-quicknet"));
    }

    /// P8.2 (backup tag): with drand silent, the backup word the tickets store is keccak256(abi.encode(BACKUP_TAG,
    /// prevRandao, id)) with the fix's time as readyAt.
    function testProperty_AUDIT_U8_backupWordsCarryTheBackupTag() public {
        _toSilentFromGraduation();
        bytes32 mix = keccak256("audit.u8.mix");
        uint256 startTime = vm.getBlockTimestamp();
        uint256 startBlock = vm.getBlockNumber();
        _backup(r0, mix, eoa[0]);
        (uint64 startedAt, uint64 target, uint64 fixedAt, bytes32 stored) = src.backupOf(r0);
        assertEq(stored, mix);
        assertEq(fixedAt, uint64(vm.getBlockTimestamp()));
        assertEq(startedAt, uint64(startTime), "started at the start's moment");
        assertEq(target, uint64(startBlock + src.TARGET_BLOCKS()), "the target is the start block + 256");
        (bytes32 w, uint64 at) = src.wordOf(a.tickets, 0);
        assertEq(w, _word(src.BACKUP_TAG(), mix, 0));
        assertEq(at, fixedAt);
        vm.prank(keeper);
        tickets.acceptGraduationWord();
        assertEq(tickets.graduationWord(), _word(src.BACKUP_TAG(), mix, 0));
        _assertGhostLedger();
    }

    /// P8.2: one request per (consumer, key) on either source, also for two requests in one block; two keys of one
    /// consumer in one block share a round; and during `request` the DrandSource makes no call out, so nothing can
    /// run inside it (every account access of the forwarded request is between the caller, the backed source and the
    /// DrandSource).
    function testProperty_AUDIT_U8_requestOncePerConsumerAndKey() public {
        _toGraduated();
        vm.startStateDiffRecording();
        uint256 round = _requestRound(eoa[0], 9, 0.01 ether, true);
        VmSafe.AccountAccess[] memory acc = vm.stopAndReturnStateDiff();
        for (uint256 i; i < acc.length; ++i) {
            if (acc[i].account == address(vm)) continue;
            if (acc[i].kind == VmSafe.AccountAccessKind.Call || acc[i].kind == VmSafe.AccountAccessKind.StaticCall) {
                assertTrue(
                    acc[i].account == address(src) || acc[i].account == address(drand),
                    "a request calls only the backed source and the DrandSource"
                );
                assertTrue(
                    acc[i].accessor == eoa[0] || acc[i].accessor == address(src), "from the caller or the wrapper"
                );
            } else {
                assertTrue(
                    acc[i].kind != VmSafe.AccountAccessKind.Create
                        && acc[i].kind != VmSafe.AccountAccessKind.DelegateCall
                        && acc[i].kind != VmSafe.AccountAccessKind.CallCode,
                    "no create or delegatecall inside a request"
                );
            }
        }
        assertEq(round, r0);
        uint256 id = uint256(keccak256(abi.encode(eoa[0], uint256(9))));
        vm.prank(eoa[0]);
        vm.expectRevert(abi.encodeWithSelector(IDrandSource.AlreadyRequested.selector, address(src), id));
        src.request(9);
        assertEq(_requestRound(eoa[0], 10, 0, true), r0, "another key of the same consumer: the same round");
        assertEq(_requestRound(eoa[0], 9, 0, false), r0, "the same key directly on the DrandSource: its own request");
        vm.prank(eoa[0]);
        vm.expectRevert(abi.encodeWithSelector(IDrandSource.AlreadyRequested.selector, eoa[0], 9));
        drand.request(9);
        (, uint64 r) = src.requestOf(eoa[0], 9);
        assertEq(r, r0, "the first request stands");
        assertEq(drand.bountyOf(r0), 0.01 ether, "its pot too");
        _assertGhostLedger();
    }

    // ------------------------------------------------------------------------------------------------ L2 P8.3

    /// P8.3: a post is refused one second before the round's time (RoundNotYet), lands at it, is refused again
    /// (RoundKnown) and so is a bounty on it; the pot goes to the first poster only (DrandSource.sol:115-130).
    function testProperty_AUDIT_U8_postRoundOncePerRoundFromItsTime() public {
        _toGraduated();
        uint256 at = drand.roundTime(r0);
        _addBounty(eoa[1], r0, 0.2 ether, true);
        _warpTo(at - 1);
        vm.prank(poster);
        vm.expectRevert(abi.encodeWithSelector(IDrandSource.RoundNotYet.selector, r0, at));
        drand.postRound(r0, _localSig(0));
        _warpTo(at);
        vm.prank(eoa[2]);
        assertEq(drand.postRound(r0, _localSig(0)), _boxDrand(r0).randomness);
        (, uint64 postedAt) = drand.beaconOf(r0);
        assertEq(postedAt, uint64(at), "readyAt is the post's moment");
        assertEq(drand.owedTo(eoa[2]), 0.2 ether, "the whole pot to the first poster");
        vm.prank(poster);
        vm.expectRevert(abi.encodeWithSelector(IDrandSource.RoundKnown.selector, r0));
        drand.postRound(r0, _localSig(0));
        vm.prank(poster);
        vm.expectRevert(abi.encodeWithSelector(IDrandSource.RoundKnown.selector, r0));
        drand.addBounty{value: 0}(r0);
        assertEq(drand.owedTo(poster), 0, "nothing for the second poster");
        _assertSourcesBalanced("after the post");
    }

    /// P8.3: `startBackup` by anyone only with the header of one of the last 8 blocks proved by `blockhash`, of a
    /// real shape, for an unposted round, once; the target is the including block + 256 (BoxBackedSource.sol:
    /// 157-190).
    function testProperty_AUDIT_U8_startBackupNeedsARecentProvedHeaderOnce() public {
        _toSilent();
        uint256 n = vm.getBlockNumber();
        bytes memory h = _parentHeader();
        (bool ok, bytes memory ret) = _tryStart(silentRound, n, h, eoa[0]);
        assertFalse(ok);
        assertEq(_sel(ret), BoxBackedSource.HeaderUnavailable.selector, "the current block");
        (ok, ret) = _tryStart(silentRound, n + 1, h, eoa[0]);
        assertEq(_sel(ret), BoxBackedSource.HeaderUnavailable.selector, "a future block");
        (ok, ret) = _tryStart(silentRound, n - 9, h, eoa[0]);
        assertEq(_sel(ret), BoxBackedSource.HeaderUnavailable.selector, "nine blocks back");
        vm.setBlockhash(n - 8, keccak256(h));
        vm.setBlockhash(n - 2, keccak256("another block's header"));
        (ok, ret) = _tryStart(silentRound, n - 2, h, eoa[0]);
        assertEq(_sel(ret), BoxBackedSource.WrongHeader.selector, "not that block's header");
        bytes memory shortList = bytes.concat(hex"f838", new bytes(0x38));
        vm.setBlockhash(n - 3, keccak256(shortList));
        (ok, ret) = _tryStart(silentRound, n - 3, shortList, eoa[0]);
        assertEq(_sel(ret), BoxBackedSource.BadHeader.selector, "a proved hash of something that is no header");
        (ok, ret) = _tryStart(r0, n - 1, h, eoa[0]);
        assertEq(_sel(ret), BoxBackedSource.RoundAlreadyPosted.selector, "a round drand answered");
        (uint64 startedAt,,,) = src.backupOf(silentRound);
        assertEq(startedAt, 0, "nothing started by any of them");
        (ok, ret) = _tryStart(silentRound, n - 8, h, eoa7702);
        assertTrue(ok, "eight blocks back, by anyone");
        assertEq(abi.decode(ret, (uint256)), n + 256, "the target counts from the including block");
        (uint64 s, uint64 target,,) = src.backupOf(silentRound);
        assertEq(s, uint64(vm.getBlockTimestamp()));
        assertEq(target, uint64(n + 256));
        (ok, ret) = _tryStart(silentRound, n - 1, h, eoa[1]);
        assertEq(_sel(ret), BoxBackedSource.BackupAlreadyStarted.selector, "once per round");
        _advance(3);
        (ok, ret) = _tryStart(silentRound, n + 2, _parentHeader(), eoa[1]);
        assertEq(_sel(ret), BoxBackedSource.BackupAlreadyStarted.selector, "never a second target");
        (, uint64 target2,,) = src.backupOf(silentRound);
        assertEq(target2, target);
    }

    /// P8.3: `fixBackup` by anyone with the target's own header: not before the target exists, through `blockhash`
    /// up to 256 blocks, through EIP-2935 up to 8,191 blocks, gone after; the next block's header and a header of
    /// the target's own number with another mix are refused; once (BoxBackedSource.sol:192-207, :254-260).
    function testProperty_AUDIT_U8_fixBackupProvesTheTargetByBlockhashThenHistoryOnce() public {
        _toSilent();
        uint256 target = _startBackup(silentRound, eoa[0]);
        bytes32 mix = keccak256("audit.u8.target mix");
        bytes memory h = _shapedHeader(target, mix, 21);
        vm.roll(target);
        (bool ok, bytes memory ret) = _tryFix(silentRound, h, eoa[1]);
        assertEq(_sel(ret), BoxBackedSource.HeaderUnavailable.selector, "at the target's own block");
        uint256 snap = vm.snapshotState();
        uint256 t0 = vm.getBlockTimestamp();
        uint256[4] memory served = [target + 1, target + 256, target + 257, target + 8191];
        for (uint256 i; i < 4; ++i) {
            vm.revertToState(snap);
            vm.roll(served[i]);
            vm.warp(t0 + 12 * (served[i] - target));
            _fixAtServedBlock(target, h, mix, served[i] - target);
        }
        vm.revertToState(snap);
        vm.roll(target + 8192);
        vm.warp(t0 + 12 * 8192);
        _serve(target, h);
        (ok, ret) = _tryFix(silentRound, h, eoa[1]);
        assertEq(_sel(ret), BoxBackedSource.HeaderUnavailable.selector, "gone at target + 8,192");
        (ok, ret) = _tryFix(r0, h, eoa[1]);
        assertEq(_sel(ret), BoxBackedSource.NoBackup.selector, "a round with no backup");
        (,, uint64 fixedAt,) = src.backupOf(silentRound);
        assertEq(fixedAt, 0);
    }

    /// At `distance` blocks past the target: the neighbour's header and a forged header of the target's number
    /// refused, the target's taken, a second fix refused.
    function _fixAtServedBlock(uint256 target, bytes memory h, bytes32 mix, uint256 distance) internal {
        _serve(target, h);
        bytes memory neighbour = _shapedHeader(target + 1, mix, 21);
        _serve(target + 1, neighbour);
        (bool ok, bytes memory ret) = _tryFix(silentRound, neighbour, eoa[1]);
        assertEq(_sel(ret), BoxBackedSource.WrongHeader.selector, "the next block's header");
        (ok, ret) = _tryFix(silentRound, _shapedHeader(target, keccak256("the fixer's choice"), 21), eoa[1]);
        assertEq(_sel(ret), BoxBackedSource.WrongHeader.selector, "the target's number with another mix");
        (ok, ret) = _tryFix(silentRound, h, eoa7702);
        assertTrue(ok, string.concat("fixed at target + ", vm.toString(distance)));
        assertEq(abi.decode(ret, (bytes32)), mix);
        (,, uint64 fixedAt, bytes32 stored) = src.backupOf(silentRound);
        assertEq(stored, mix);
        assertEq(fixedAt, uint64(vm.getBlockTimestamp()));
        (ok, ret) = _tryFix(silentRound, h, eoa[2]);
        assertEq(_sel(ret), BoxBackedSource.BackupAlreadyFixed.selector, "once");
    }

    // ------------------------------------------------------------------------------------------------ L3 P8.4

    /// P8.4: a recipient that re-enters `withdrawBounty` during its receipt finds nothing owed (the balance is
    /// cleared before the transfer, DrandSource.sol:140-142) and ends with exactly its credit; one that re-enters
    /// `postRound` of another round earns that round's pot as a new credit and nothing more; one that re-enters
    /// `request` only registers its own new request; one that pays the ETH straight back as a bounty keeps the
    /// ledger exact.
    function testProperty_AUDIT_U8_withdrawBountyClearsTheCreditBeforeSending() public {
        _toGraduated();
        AuditU8FableReentrantRecipient rec = new AuditU8FableReentrantRecipient(drand);
        _ghostAddOutside(address(rec));
        _addBounty(eoa[0], r0, 1 ether, true);
        _addBounty(eoa[0], r0 + 4, 0.5 ether, false);
        _advance(1);
        rec.post(r0, _localSig(0));
        assertEq(drand.owedTo(address(rec)), 1 ether);
        _reentryWithdraw(rec);
        _reentryPost(rec);
        _reentryRequest(rec);
        _reentryBountyBack(rec);
        assertEq(rec.received(), 1 ether + 0.25 ether + 0.5 ether + 0.125 ether, "every receipt was a credit");
        _assertSourcesBalanced("after four re-entering withdrawals");
        _assertGhostLedger();
    }

    /// 1: re-enter withdrawBounty: nothing owed inside (cleared before the transfer), exactly the credit received.
    function _reentryWithdraw(AuditU8FableReentrantRecipient rec) internal {
        rec.arm(1, 0, "", 0);
        uint256 e0 = address(rec).balance;
        uint256 d0 = address(drand).balance;
        rec.withdraw();
        assertEq(address(rec).balance - e0, 1 ether, "exactly the credit");
        assertEq(d0 - address(drand).balance, 1 ether);
        assertFalse(rec.reentryPassed(), "the re-entry failed");
        assertEq(_sel(rec.lastRevert()), IDrandSource.NothingOwed.selector, "cleared before the transfer");
        assertEq(drand.owedTo(address(rec)), 0);
        _noteEthOut(EthOut.BountyWithdraw, 1 ether);
    }

    /// 2: re-enter postRound of a round whose time has come (r0 + 4, with its 0.5 ETH pot) while withdrawing the
    /// credit of r0 + 8: the other pot becomes a new credit, nothing more leaves.
    function _reentryPost(AuditU8FableReentrantRecipient rec) internal {
        _addBounty(eoa[0], r0 + 8, 0.25 ether, false);
        _warpTo(drand.roundTime(r0 + 8));
        rec.post(r0 + 8, _localSig(8));
        assertEq(drand.owedTo(address(rec)), 0.25 ether);
        rec.arm(2, r0 + 4, _localSig(4), 0);
        uint256 e0 = address(rec).balance;
        rec.withdraw();
        assertEq(address(rec).balance - e0, 0.25 ether, "the credit being withdrawn, nothing of the other pot");
        assertTrue(rec.reentryPassed(), "the re-entrant post landed");
        assertEq(drand.owedTo(address(rec)), 0.5 ether, "the other round's pot is a new credit");
        (, uint64 postedAt) = drand.beaconOf(r0 + 4);
        assertEq(postedAt, uint64(vm.getBlockTimestamp()));
        _noteEthOut(EthOut.BountyWithdraw, 0.25 ether);
    }

    /// 3: re-enter request: only the recipient's own new request is registered.
    function _reentryRequest(AuditU8FableReentrantRecipient rec) internal {
        rec.arm(3, 0, "", 42);
        uint256 e0 = address(rec).balance;
        rec.withdraw();
        assertEq(address(rec).balance - e0, 0.5 ether);
        assertTrue(rec.reentryPassed());
        (, uint64 round) = drand.requestOf(address(rec), 42);
        assertEq(round, drand.roundAt(vm.getBlockTimestamp() + 12), "its own request, nothing else");
        _noteEthOut(EthOut.BountyWithdraw, 0.5 ether);
    }

    /// 4: pay the credit straight back into a pot during the receipt: the ledger stays exact.
    function _reentryBountyBack(AuditU8FableReentrantRecipient rec) internal {
        _addBounty(eoa[0], r0 + 12, 0.125 ether, false);
        _warpTo(drand.roundTime(r0 + 12));
        rec.post(r0 + 12, _localSig(12));
        rec.arm(4, r0 + 16, "", 0);
        uint256 e0 = address(rec).balance;
        uint256 d0 = address(drand).balance;
        rec.withdraw();
        assertTrue(rec.reentryPassed());
        assertEq(address(rec).balance, e0, "paid back in");
        assertEq(address(drand).balance, d0, "the DrandSource's balance is unchanged");
        assertEq(drand.bountyOf(r0 + 16), 0.125 ether, "as a pot of the next round");
        assertEq(drand.owedTo(address(rec)), 0);
    }

    /// P8.4 (hostile recipients): a recipient whose `receive` reverts or burns all its gas makes the withdrawal
    /// revert whole (WithdrawFailed) and the credit stays; so does a withdrawal to either source itself (neither has
    /// a `receive`: a credit cannot turn into forced ETH); the zero address is refused; nothing owed is refused
    /// (DrandSource.sol:136-144, :133-135).
    function testProperty_AUDIT_U8_withdrawBountyToHostileRecipientsKeepsTheCredit() public {
        _toDrawing();
        uint256 credit = drand.owedTo(poster);
        assertGt(credit, 0);
        uint256 d0 = address(drand).balance;
        vm.prank(poster);
        vm.expectRevert(IDrandSource.WithdrawFailed.selector);
        drand.withdrawBounty(payable(address(ethRefuser)));
        vm.prank(poster);
        vm.expectRevert(IDrandSource.WithdrawFailed.selector);
        drand.withdrawBounty(payable(address(gasBurner)));
        vm.prank(poster);
        vm.expectRevert(IDrandSource.WithdrawFailed.selector);
        drand.withdrawBounty(payable(address(drand)));
        vm.prank(poster);
        vm.expectRevert(IDrandSource.WithdrawFailed.selector);
        drand.withdrawBounty(payable(address(src)));
        vm.prank(poster);
        vm.expectRevert(IDrandSource.ZeroAddress.selector);
        drand.withdrawBounty(payable(address(0)));
        vm.prank(eoa[5]);
        vm.expectRevert(IDrandSource.NothingOwed.selector);
        drand.withdrawBounty(payable(eoa[5]));
        assertEq(drand.owedTo(poster), credit, "the credit stays");
        assertEq(address(drand).balance, d0);
        assertEq(_withdrawBounty(poster, payable(address(contractDrawer))), credit, "a contract that accepts");
        _assertSourcesBalanced("after the hostile attempts and one withdrawal");
        _assertGhostLedger();
    }

    /// L3 / the Amsterdam stipend note (R0-A): no path of this unit pays ETH with a 2,300-gas stipend. `withdrawBounty`
    /// forwards all gas (`to.call{value}`), and `DrandWords.payRound`'s refund does too (`call(gas(), …)`), so a
    /// payment to an EIP-7702-delegated EOA whose delegate needs more than the stipend (about 900 gas more under
    /// Amsterdam) succeeds on both EVMs: here the delegated EOA withdraws a credit to itself and draws (its refund
    /// through `payRound`) under the contract's EVM.
    function testProperty_AUDIT_U8_noStipendPayments_aDelegatedEoaIsPaidOnThisEvm() public {
        _toDrawing();
        _addBounty(eoa[0], r0 + 12, 0.3 ether, true);
        _warpTo(drand.roundTime(r0 + 12));
        vm.prank(eoa7702);
        drand.postRound(r0 + 12, _localSig(12));
        assertEq(drand.owedTo(eoa7702), 0.3 ether);
        uint256 e0 = eoa7702.balance;
        assertEq(_withdrawBounty(eoa7702, payable(eoa7702)), 0.3 ether);
        assertEq(eoa7702.balance - e0, 0.3 ether, "paid to the delegated EOA through its delegate's receive");
        e0 = eoa7702.balance;
        _draw(eoa7702, AUDIT_DRAW_VALUE);
        uint256 pot = 600_000 * AUDIT_BASE_FEE;
        // `_draw` funds the drawer with the draw's value first: what stayed behind is the round's pot, the rest came
        // back through `payRound`'s all-gas refund into the delegate's receive.
        assertEq(
            e0 + AUDIT_DRAW_VALUE - eoa7702.balance,
            pot,
            "the draw kept its round's pot and refunded the rest to the delegated EOA"
        );
        _assertGhostLedger();
    }

    // ------------------------------------------------------------------------------------------------ L7 P8.7, P8.14

    /// P8.7: `roundAt` / `roundTime` agree with quicknet's genesis (1,692,803,367) and 3-second period at every
    /// boundary: the first round at or after t, within 3 s of it, inverse of each other, round 1 at and before the
    /// genesis, and the 19 published round times.
    function testProperty_AUDIT_U8_roundClockAgreesWithQuicknetAtEveryBoundary() public view {
        assertEq(drand.GENESIS_TIME(), GENESIS);
        assertEq(drand.PERIOD(), 3);
        assertEq(drand.roundAt(0), 1);
        assertEq(drand.roundAt(GENESIS - 1), 1);
        assertEq(drand.roundAt(GENESIS), 1);
        assertEq(drand.roundAt(GENESIS + 1), 2);
        assertEq(drand.roundAt(GENESIS + 2), 2);
        assertEq(drand.roundAt(GENESIS + 3), 2);
        assertEq(drand.roundAt(GENESIS + 4), 3);
        assertEq(drand.roundTime(1), GENESIS);
        assertEq(drand.roundTime(2), GENESIS + 3);
        for (uint256 i; i < _boxDrandCount(); ++i) {
            Round memory r = _boxDrandAt(i);
            assertEq(drand.roundTime(r.round), r.time, "the published time");
            assertEq(drand.roundAt(r.time), r.round, "the round at its own time");
            assertEq(drand.roundAt(r.time - 1), r.round, "one second before: the same round");
            assertEq(drand.roundAt(r.time + 1), r.round + 1, "one second after: the next");
            assertEq(src.roundTime(r.round), r.time, "the backed source forwards both");
            assertEq(src.roundAt(r.time), r.round);
        }
    }

    function testFuzz_AUDIT_U8_roundClockIsTheFirstRoundAtOrAfterTheTime(uint256 t) public view {
        t = bound(t, 0, type(uint64).max);
        uint256 r = drand.roundAt(t);
        assertGe(r, 1);
        uint256 at = drand.roundTime(r);
        assertGe(at, t, "at or after t");
        if (r > 1) {
            assertLt(at - t, 3, "within the period");
            assertLt(drand.roundTime(r - 1), t, "the previous round is before t");
        }
        assertEq(drand.roundAt(at), r, "inverse");
    }

    /// P8.7: a request's round is strictly after its block and at least 12 s ahead, at most 14 s (the first round at
    /// or after now + 12 with a 3-s period), on both sources, for every clock from 14 s before the genesis to near
    /// 2^64 (earlier clocks get round 1, further ahead: the clock test pins that); the source's own text says "at most
    /// 15 s" (BoxBackedSource.sol:38), a conservative statement of the same bound.
    function testFuzz_AUDIT_U8_requestRoundIsTwelveToFourteenSecondsAhead(uint256 t) public {
        t = bound(t, GENESIS - 14, type(uint64).max - 100);
        vm.warp(t);
        uint256 rb = _requestRound(eoa[0], 1, 0, true);
        uint256 rd = _requestRound(eoa[1], 1, 0, false);
        assertEq(rb, rd);
        uint256 at = drand.roundTime(rb);
        assertGe(at, t + 12, "at least MARGIN ahead");
        assertLe(at, t + 14, "at most 14 s ahead");
        assertGt(at, t, "strictly after the request's block");
        (uint64 requestedAt, uint64 stored) = src.requestOf(eoa[0], 1);
        assertEq(requestedAt, uint64(t));
        assertEq(uint256(stored), rb, "the round fits its uint64 field without wrap");
    }

    /// P8.14: near the uint64 limit the request's round still fits its field and the clock does not wrap; absurd
    /// rounds are refused by `addBounty` and `postRound` (InvalidRound), by `startBackup` through the time rule or,
    /// above 2^254, by a checked overflow in `roundTime` (a panic, no state change); round 0 is InvalidRound
    /// everywhere.
    function testProperty_AUDIT_U8_roundArithmeticNearTheUint64Limit() public {
        uint256 t = type(uint64).max - 15;
        vm.warp(t);
        uint256 round = _requestRound(eoa[0], 1, 0, true);
        assertEq(round, (t + 12 - GENESIS + 2) / 3 + 1);
        assertLt(round, type(uint64).max);
        (uint64 requestedAt, uint64 stored) = src.requestOf(eoa[0], 1);
        assertEq(requestedAt, uint64(t));
        assertEq(uint256(stored), round);
        assertGt(drand.roundTime(round), t, "the round's time is after the request even at the limit");
        vm.prank(eoa[0]);
        vm.expectRevert(abi.encodeWithSelector(IDrandSource.InvalidRound.selector, uint256(type(uint64).max) + 1));
        drand.addBounty(uint256(type(uint64).max) + 1);
        vm.prank(eoa[0]);
        vm.expectRevert(abi.encodeWithSelector(IDrandSource.InvalidRound.selector, uint256(type(uint64).max) + 1));
        drand.postRound(uint256(type(uint64).max) + 1, _localSig(0));
        uint256 last = type(uint64).max;
        vm.prank(eoa[0]);
        vm.expectRevert(abi.encodeWithSelector(IDrandSource.RoundNotYet.selector, last, drand.roundTime(last)));
        drand.postRound(last, _localSig(0));
        vm.prank(eoa[0]);
        vm.expectRevert(abi.encodeWithSelector(IDrandSource.InvalidRound.selector, 0));
        drand.postRound(0, _localSig(0));
        vm.prank(eoa[0]);
        vm.expectRevert(abi.encodeWithSelector(IDrandSource.InvalidRound.selector, 0));
        drand.roundTime(0);
        bytes memory h = _parentHeader();
        (bool ok, bytes memory ret) = _tryStart(0, vm.getBlockNumber() - 1, h, eoa[0]);
        assertEq(_sel(ret), IDrandSource.InvalidRound.selector, "round 0: the DrandSource's error");
        (ok, ret) = _tryStart(last, vm.getBlockNumber() - 1, h, eoa[0]);
        assertEq(_sel(ret), BoxBackedSource.BackupTooEarly.selector, "the last uint64 round is far ahead");
        (ok, ret) = _tryStart(uint256(1) << 255, vm.getBlockNumber() - 1, h, eoa[0]);
        assertFalse(ok);
        assertEq(_sel(ret), bytes4(keccak256("Panic(uint256)")), "2^255: roundTime overflows (checked)");
        (uint64 startedAt,,,) = src.backupOf(0);
        assertEq(startedAt, 0);
    }

    /// P8.14 (the uint128 pot): a bounty that would take a round's pot to 2^128 is refused with PotOverflow on either
    /// source (unreachable with the ETH that exists; pinned so the narrowing stays honest), a pot of exactly 2^128 - 1
    /// is held, one more wei is refused, and the whole pot is credited to the poster (DrandSource.sol:64-65, :214-223).
    function testProperty_AUDIT_U8_potNarrowingRefusesTwoToTheOneTwentyEight() public {
        _toGraduated();
        uint256 max = type(uint128).max;
        uint256 round = r0 + 4;
        vm.deal(eoa[0], max + 1);
        vm.prank(eoa[0]);
        vm.expectRevert(abi.encodeWithSelector(DrandSource.PotOverflow.selector, round));
        drand.addBounty{value: max + 1}(round);
        vm.prank(eoa[0]);
        vm.expectRevert(abi.encodeWithSelector(DrandSource.PotOverflow.selector, round));
        src.addBounty{value: max + 1}(round);
        assertEq(drand.bountyOf(round), 0, "nothing landed");
        vm.prank(eoa[0]);
        drand.addBounty{value: max}(round);
        assertEq(drand.bountyOf(round), max, "exactly 2^128 - 1 is held");
        vm.prank(eoa[0]);
        vm.expectRevert(abi.encodeWithSelector(DrandSource.PotOverflow.selector, round));
        drand.addBounty{value: 1}(round);
        _warpTo(drand.roundTime(round));
        _post(round);
        assertEq(drand.owedTo(poster), max, "the whole pot credited to the poster");
        assertEq(drand.bountyOf(round), 0);
        assertEq(address(drand).balance, max, "held until withdrawn");
    }

    /// P8.14: the start window's edges: refused 1 s before 5 days and at exactly 5 days after the round's time
    /// (BackupTooEarly: the rule is "once 5 days have passed", BoxBackedSource.sol:16-17, :165), allowed from 5 days
    /// + 1 s to exactly 5 days 18 hours, refused 1 s later (BackupTooLate, :169).
    function testProperty_AUDIT_U8_startBackupWindowEdges() public {
        _toGraduated();
        uint256 rt = drand.roundTime(r0);
        uint256 at = rt + src.BACKUP_AFTER();
        uint256 until = rt + src.LATEST_START();
        assertEq(src.BACKUP_AFTER(), 5 days);
        assertEq(src.LATEST_START(), 5 days + 18 hours);
        assertEq(src.BACKUP_AFTER(), BoxSpecV1.BACKUP_AFTER_SECONDS);
        assertEq(src.LATEST_START(), BoxSpecV1.BACKUP_LATEST_START_SECONDS);
        uint256[5] memory when = [at - 1, at, at + 1, until, until + 1];
        bytes4[5] memory expected = [
            BoxBackedSource.BackupTooEarly.selector,
            BoxBackedSource.BackupTooEarly.selector,
            bytes4(0),
            bytes4(0),
            BoxBackedSource.BackupTooLate.selector
        ];
        uint256 snap = vm.snapshotState();
        uint256 t0 = vm.getBlockTimestamp();
        uint256 b0 = vm.getBlockNumber();
        for (uint256 i; i < 5; ++i) {
            vm.warp(t0);
            vm.roll(b0);
            _warpTo(when[i]);
            bytes memory h = _parentHeader();
            (bool ok, bytes memory ret) = _tryStart(r0, vm.getBlockNumber() - 1, h, eoa[i]);
            if (expected[i] == bytes4(0)) {
                assertTrue(ok, string.concat("allowed at offset ", vm.toString(when[i] - rt)));
                (uint64 startedAt,,,) = src.backupOf(r0);
                assertEq(startedAt, uint64(when[i]));
            } else {
                assertFalse(ok, string.concat("refused at offset ", vm.toString(when[i] - rt)));
                assertEq(_sel(ret), expected[i]);
                assertEq(
                    ret,
                    abi.encodeWithSelector(
                        expected[i], r0, expected[i] == BoxBackedSource.BackupTooEarly.selector ? at : until
                    )
                );
            }
            vm.revertToState(snap);
        }
    }

    // ------------------------------------------------------------------------------------------------ L8 P8.15, P8.13

    /// P8.15 / P8.13: both pins equal CREATE2(Arachnid deployer, salt, keccak256(compiled creation code)) and the
    /// deployed code's hash; the world's sources are those deployments; the backed source's DRAND constant is the
    /// pinned DrandSource; BoxSpecV1's copies agree; `isPinned` holds on chains 1 and 11155111 and on no other
    /// chain (`pinned` answers zeros there: no pin, so factory v1 refuses every other chain).
    function testProperty_AUDIT_U8_pinsEqualCreate2OfTheCompiledCode() public {
        assertEq(DrandSourcePins.INIT_CODE_HASH, keccak256(type(DrandSource).creationCode));
        assertEq(BackedSourcePins.INIT_CODE_HASH, keccak256(type(BoxBackedSource).creationCode));
        address d = address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(
                            bytes1(0xff), DrandSourcePins.DEPLOYER, DrandSourcePins.SALT, DrandSourcePins.INIT_CODE_HASH
                        )
                    )
                )
            )
        );
        address b = address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(
                            bytes1(0xff),
                            BackedSourcePins.DEPLOYER,
                            BackedSourcePins.SALT,
                            BackedSourcePins.INIT_CODE_HASH
                        )
                    )
                )
            )
        );
        assertEq(d, DrandSourcePins.ADDRESS_MAINNET);
        assertEq(d, DrandSourcePins.ADDRESS_SEPOLIA);
        assertEq(b, BackedSourcePins.ADDRESS_MAINNET);
        assertEq(b, BackedSourcePins.ADDRESS_SEPOLIA);
        assertEq(d, address(drand), "the world's DrandSource");
        assertEq(b, address(src), "the world's BoxBackedSource");
        assertEq(d, PinnedDrandSource.predict());
        assertEq(b, PinnedBackedSource.predict());
        assertEq(d.codehash, DrandSourcePins.CODE_HASH_MAINNET);
        assertEq(d.codehash, DrandSourcePins.CODE_HASH_SEPOLIA);
        assertEq(b.codehash, BackedSourcePins.CODE_HASH_MAINNET);
        assertEq(b.codehash, BackedSourcePins.CODE_HASH_SEPOLIA);
        assertEq(address(src.DRAND()), d, "DRAND is the pinned DrandSource");
        assertEq(BoxSpecV1.RANDOMNESS_SOURCE, b);
        assertEq(BoxSpecV1.RANDOMNESS_SOURCE_CODE_HASH, b.codehash);
        assertEq(BoxSpecV1.DRAND_SOURCE, d);
        assertEq(BoxSpecV1.DRAND_SOURCE_CODE_HASH, d.codehash);
        assertEq(tickets.source(), b, "box 0's tickets read the pinned backed source");
        assertEq(DrandSourcePins.DEPLOYER, 0x4e59b44847b379578588920cA78FbF26c0B4956C);
        assertEq(BackedSourcePins.DEPLOYER, DrandSourcePins.DEPLOYER);
        assertTrue(DrandSourcePins.isPinned(d) && BackedSourcePins.isPinned(b), "chain 1");
        vm.chainId(11_155_111);
        assertTrue(DrandSourcePins.isPinned(d) && BackedSourcePins.isPinned(b), "chain 11155111");
        uint256[5] memory others = [uint256(8453), 10, 17_000, 560_048, 31_337];
        for (uint256 i; i < 5; ++i) {
            vm.chainId(others[i]);
            (address at, bytes32 hash) = DrandSourcePins.pinned(others[i]);
            assertTrue(at == address(0) && hash == bytes32(0), "no DrandSource pin elsewhere");
            (at, hash) = BackedSourcePins.pinned(others[i]);
            assertTrue(at == address(0) && hash == bytes32(0), "no BoxBackedSource pin elsewhere");
            assertFalse(DrandSourcePins.isPinned(d) || BackedSourcePins.isPinned(b), "nothing is pinned elsewhere");
        }
        vm.chainId(1);
    }
}

/// @notice The same under Amsterdam (Glamsterdam's repricing: the 7702 delegate's receive needs more than a stipend).
/// forge-config: default.evm_version = "amsterdam"
contract AuditU8FableSourcesAmsterdamTest is AuditU8FableSourcesTest {
    function _evm() internal pure override returns (string memory) {
        return "amsterdam";
    }
}

/// @title AuditU8FablePinsFreshTest (SH-AUDIT-B0-U8-F, lens L8 outside the world)
/// @notice A fresh EVM (chain id 1, then 11155111) holding nothing but the Arachnid deployer: ETH forced onto both
/// predicted addresses before anyone deploys changes neither address nor code hash (the deployments land, the ETH
/// stays, M27's class), a second deployment through the deployer is refused (CREATE2 on an occupied address) and
/// changes nothing, the deployed backed source names the deployed DrandSource and takes a request
/// (DrandSourcePins.sol:4-19, BackedSourcePins.sol:4-15; BC-101).
contract AuditU8FablePinsFreshTest is Test {
    function testProperty_AUDIT_U8_pinsHoldWithEthAtThePredictedAddressesAndRefuseASecondDeployment() public {
        uint256[2] memory chains = [uint256(1), 11_155_111];
        uint256 snap = vm.snapshotState();
        for (uint256 i; i < 2; ++i) {
            vm.chainId(chains[i]);
            _deployWithEthInPlace(chains[i]);
            vm.revertToState(snap);
        }
    }

    function _deployWithEthInPlace(uint256 chainId) internal {
        address d = PinnedDrandSource.predict();
        address b = PinnedBackedSource.predict();
        assertEq(d.code.length, 0, "fresh");
        assertEq(b.code.length, 0);
        assertFalse(DrandSourcePins.isPinned(d) || BackedSourcePins.isPinned(b), "nothing deployed: not pinned");
        vm.deal(d, 1 ether);
        vm.deal(b, 2 wei);
        DrandSource drand_ = PinnedDrandSource.deploy(vm);
        BoxBackedSource src_ = PinnedBackedSource.deploy(vm);
        (address pinnedD, bytes32 hashD) = DrandSourcePins.pinned(chainId);
        (address pinnedB, bytes32 hashB) = BackedSourcePins.pinned(chainId);
        assertEq(address(drand_), pinnedD, "the address is unchanged by the balance");
        assertEq(address(src_), pinnedB);
        assertEq(address(drand_).codehash, hashD, "the code hash is unchanged by the balance");
        assertEq(address(src_).codehash, hashB);
        assertEq(address(drand_).balance, 1 ether, "the forced ETH stays (M27's class)");
        assertEq(address(src_).balance, 2 wei);
        assertTrue(DrandSourcePins.isPinned(d) && BackedSourcePins.isPinned(b), "pinned once deployed");
        // A CREATE2 collision burns all the gas the creation gets (EIP-684 semantics), so the attempts are capped.
        (bool ok, bytes memory ret) = DrandSourcePins.DEPLOYER.call{gas: 3_000_000}(
            bytes.concat(DrandSourcePins.SALT, type(DrandSource).creationCode)
        );
        assertFalse(ok, "a second deployment is refused by the deployer");
        assertEq(ret.length, 0);
        (ok, ret) = BackedSourcePins.DEPLOYER.call{gas: 3_000_000}(
            bytes.concat(BackedSourcePins.SALT, type(BoxBackedSource).creationCode)
        );
        assertFalse(ok);
        assertEq(address(drand_).codehash, hashD, "and changes nothing");
        assertEq(address(src_).codehash, hashB);
        assertEq(address(src_.DRAND()), d, "the backed source names the deployed DrandSource");
        uint256 round = src_.request(1);
        assertEq(round, drand_.roundAt(vm.getBlockTimestamp() + 12), "and forwards a request to it");
        (, uint64 stored) = src_.requestOf(address(this), 1);
        assertEq(uint256(stored), round);
    }
}
