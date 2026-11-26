// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IDrandSource} from "../interfaces/IDrandSource.sol";
import {DrandSourcePins} from "./DrandSourcePins.sol";

/// @title BoxBackedSource (box 0's randomness source; one shared contract per chain, no clone; F143)
/// @notice drand quicknet first, through the shared pinned `DrandSource` (one post serves every box, v1 and v2), and a
/// backup fixed at creation: the RANDAO value (`prevRandao`) of a block committed in advance. Core v1's factory pins
/// this contract as box 0's source (`BackedSourcePins`); core v2 boxes keep the DrandSource alone.
///
/// - **drand first.** `request`, `addBounty` and `bountyOf` forward to `DRAND`, keyed there by this contract and
///   keccak256(consumer, key), so words stay per (consumer, key) as on DrandSource. Rounds are posted on `DRAND` itself
///   (`postRound`, `withdrawBounty`); nothing here posts, pays or holds ETH (no `receive`, and `request` and `addBounty`
///   forward all of `msg.value`).
/// - **The backup starts only by an on-chain rule** (F143 (2)): anyone, once `BACKUP_AFTER` = 5 days have passed since
///   a quicknet round's time with the round still unposted on `DRAND`, and no later than `LATEST_START` = 5 days
///   18 hours after it, calls `startBackup(round, headerBlock, header)`. The latest start keeps the target and the
///   fix's whole proof window inside the consumers' 7 days, plus at least 1 h 50 min 21 s of margin at 12-second
///   blocks; a later start could still be fixed early, but it would use up that margin and eventually push part of the
///   proof window past the deadline (security review F1). The start proves a recent block's header (one of the last
///   `RECENT_BLOCKS` = 8, so a transaction included a few blocks late still lands; review F3) against `blockhash` and
///   parses its field 13, so the header format the fix relies on still holds when the start is made: a fork that has
///   changed header hashing makes the start fail. It cannot see a fork still ahead: a start in the about 264 blocks
///   before a fork that changes header hashing commits to a target no header can prove, and the round then has no
///   word even if drand posts it later (review F2; no on-chain fix without a restart, which would bring back a choice
///   of words; S7's fork watch keeps box 0's rounds posted before day 5 when such a fork is scheduled). It fixes
///   `target = block.number + TARGET_BLOCKS` (256 blocks, about 51 minutes: past the beacon chain's proposer
///   lookahead, so the starter cannot know who proposes the blocks before it). **One target per round, never
///   another** (no restart: a restart let the only active fixer see each target's public mix and choose among up to
///   four words). Once started, the round's drand post is ignored for good, so nobody can choose between a known drand
///   word and the backup.
/// - **The fix** (`fixBackup(round, header)`): anyone, with the target block's RLP header, checked against its hash
///   (BLOCKHASH for 256 blocks, then EIP-2935's history contract for 8,191 blocks, about 27 hours). Field 13,
///   `prevRandao`, becomes the round's mix; word = keccak256(abi.encode(`BACKUP_TAG`, mix, keccak256(consumer, key))),
///   ready at the fix's time. A target nobody proves in its window leaves the round without a word, the same as a
///   round nobody posts: the consumer's 7 days decide (terminal mode).
/// - **Timeline** (pinned by test/box/backup/BackupTimeline.t.sol): a request's round is at most 15 s after it; the
///   latest start is 5 days 18 hours after the round, the target 256 blocks later and the last possible fix 8,191
///   blocks after the target: 5 days 18 hours + 15 s + 8,447 blocks × 12 s ≈ 6.92 days, inside BoxTickets' fixed
///   7 days (`SILENCE`), with 1 h 50 min to spare (an average block time up to 12.78 s).
///
/// **Who can bias a backup word.** Only the proposer of the slot just before the target (and those before it, if the
/// same entity holds them): 1 bit per withheld block, at that block's reward (EIP-4399). The drawer and the starter
/// cannot (no input; the target is 8 epochs ahead), and no fixer can change the word (the header is bound by its
/// hash); but a fixer who is the only one acting holds a veto, as a sole drand poster does: fix (the backup word) or
/// let the window pass (no word, terminal mode at 7 days).
///
/// Implements the part of `IDrandSource` the consumers call (`request`, `wordOf`, `bountyOf`, `addBounty`) and the
/// keeper's reads (`requestOf`, `isSilent`, `roundTime`, `roundAt`, `MARGIN`, `SILENCE`); `Requested` has
/// DrandSource's signature. No owner, admin, pause, upgrade, setter or rescue; no constructor input (the same address
/// and code on chains 1 and 11155111; F23 C2). Written for Square Hole (MIT, no third-party code).
/// @dev `wordOf` reads one slot here and calls `DRAND` twice (requestOf, beaconOf), or once and two slots here after a
/// start: about 20,000 gas cold on both EVMs, within the consumers' 50,000 (pinned in test/box/backup/).
contract BoxBackedSource {
    /// @notice A round's backup: when it was started, its target block and when it was fixed (one slot).
    struct Backup {
        uint64 startedAt;
        uint64 targetBlock;
        uint64 fixedAt;
    }

    /// @notice DrandSource's event, with the consumer and key as the consumer sent them.
    event Requested(address indexed consumer, uint256 indexed key, uint256 round, uint256 bounty);
    event BackupStarted(uint256 indexed round, uint256 targetBlock, address indexed by);
    event BackupFixed(uint256 indexed round, uint256 targetBlock, bytes32 mix, address indexed by);

    /// @notice drand answered the round: it can never fall back.
    error RoundAlreadyPosted(uint256 round);
    /// @notice Not yet `BACKUP_AFTER` past the round's time (`at`).
    error BackupTooEarly(uint256 round, uint256 at);
    /// @notice Later than `LATEST_START` past the round's time (`until`). The cutoff keeps the fix's whole proof window
    /// inside the 7 days with at least 1 h 50 min 21 s of margin at 12-second blocks; a later start could still be
    /// fixed early, but it would use up that margin and eventually push part of the proof window past the deadline.
    error BackupTooLate(uint256 round, uint256 until);
    /// @notice The round's one backup target is fixed already (there is never a second).
    error BackupAlreadyStarted(uint256 round);
    error BackupAlreadyFixed(uint256 round);
    error NoBackup(uint256 round);
    /// @notice The block's hash is not readable (not yet mined, out of the 8,191-block window, or for a start's header
    /// older than `RECENT_BLOCKS`).
    error HeaderUnavailable(uint256 blockNumber);
    /// @notice The header does not hash to the block's hash.
    error WrongHeader(uint256 blockNumber);
    /// @notice Not an RLP list whose field 13 is a 32-byte string.
    error BadHeader();

    /// @notice The shared quicknet source (the same address on chains 1 and 11155111; `DrandSourcePins`).
    IDrandSource public constant DRAND = IDrandSource(DrandSourcePins.ADDRESS_MAINNET);
    /// @notice DrandSource's MARGIN (F54).
    uint256 public constant MARGIN = 12 seconds;
    /// @notice The consumers' window (BoxTickets.SILENCE; F61 R4): a word, drand or backup, counts only if ready by then.
    uint256 public constant SILENCE = 7 days;
    /// @notice A round still unposted this long after its time may fall back (F143 (2): 5 days, not 3).
    uint256 public constant BACKUP_AFTER = 5 days;
    /// @notice The last moment after a round's time at which its backup may start (security review F1): the target and
    /// the fix's whole EIP-2935 window still end inside `SILENCE` (5 d 18 h + 15 s + 8,447 × 12 s < 7 d).
    uint256 public constant LATEST_START = 5 days + 18 hours;
    /// @notice How many blocks old the header a start proves may be (an inclusion delay; security review F3).
    uint256 public constant RECENT_BLOCKS = 8;
    /// @notice Blocks between the backup's start and its target.
    uint256 public constant TARGET_BLOCKS = 256;
    /// @notice EIP-2935's HISTORY_SERVE_WINDOW.
    uint256 public constant HISTORY_WINDOW = 8191;
    /// @notice EIP-2935's history contract (Prague/Pectra and later).
    address public constant HISTORY = 0x0000F90827F1C53a10cb7A02335B175320002935;
    bytes32 public constant DRAND_TAG = keccak256("squarehole.randomness.backed.drand-quicknet");
    bytes32 public constant BACKUP_TAG = keccak256("squarehole.randomness.backed.randao");

    /// @dev quicknet round → its backup.
    mapping(uint256 => Backup) private _backups;
    /// @dev quicknet round → its backup's mix (the target's prevRandao), once fixed.
    mapping(uint256 => bytes32) private _mixes;

    // ------------------------------------------------------------------------------------------------------------
    // The consumer's calls

    /// @notice Requests the word for (msg.sender, key): a DrandSource request keyed by this contract and
    /// keccak256(consumer, key). `msg.value` is the round's posting bounty, forwarded whole.
    function request(uint256 key) external payable returns (uint256 round) {
        round = DRAND.request{value: msg.value}(uint256(_id(msg.sender, key)));
        // DRAND is the pinned DrandSource (a constant): its code never calls back, so no reentrancy can reorder this.
        // forge-lint: disable-next-line(reentrancy-events)
        emit Requested(msg.sender, key, round, msg.value);
    }

    /// @notice Adds `msg.value` to the round's pot on DRAND.
    function addBounty(uint256 round) external payable {
        DRAND.addBounty{value: msg.value}(round);
    }

    function bountyOf(uint256 round) external view returns (uint256) {
        return DRAND.bountyOf(round);
    }

    /// @notice The word and when it became available: drand's while the round has no backup, else the backup's once
    /// fixed; (0, 0) otherwise.
    function wordOf(address consumer, uint256 key) public view returns (bytes32 word, uint64 readyAt) {
        bytes32 id = _id(consumer, key);
        // Only the request's round is needed here (its time is the consumer's to check).
        // forge-lint: disable-next-line(unused-return)
        (, uint64 round) = DRAND.requestOf(address(this), uint256(id));
        if (round == 0) return (bytes32(0), 0);
        Backup memory b = _backups[round];
        if (b.startedAt == 0) {
            (bytes32 randomness, uint64 postedAt) = DRAND.beaconOf(round);
            if (postedAt == 0) return (bytes32(0), 0);
            return (keccak256(abi.encode(DRAND_TAG, randomness, id)), postedAt);
        }
        if (b.fixedAt == 0) return (bytes32(0), 0);
        return (keccak256(abi.encode(BACKUP_TAG, _mixes[round], id)), b.fixedAt);
    }

    // ------------------------------------------------------------------------------------------------------------
    // The backup

    /// @notice Anyone, after `BACKUP_AFTER` and until `LATEST_START` past the round's time while it is unposted, with
    /// the RLP header of a recent block (`headerBlock`, one of the last `RECENT_BLOCKS`): commits the round to the
    /// RANDAO value of block.number + `TARGET_BLOCKS`. Once per round.
    function startBackup(uint256 round, uint256 headerBlock, bytes calldata header) external returns (uint256 target) {
        uint256 roundTime_ = DRAND.roundTime(round);
        uint256 at = roundTime_ + BACKUP_AFTER;
        // The rule is a time by design (F143 (2)): a validator's few seconds of drift cannot matter against 5 days.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp <= at) revert BackupTooEarly(round, at);
        uint256 until = roundTime_ + LATEST_START;
        // The same: hours of spare against seconds of drift.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > until) revert BackupTooLate(round, until);
        Backup memory b = _backups[round];
        if (b.startedAt != 0) revert BackupAlreadyStarted(round);
        // Only whether drand answered matters here.
        // forge-lint: disable-next-line(unused-return)
        (, uint64 postedAt) = DRAND.beaconOf(round);
        if (postedAt != 0) revert RoundAlreadyPosted(round);
        // The header format the fix relies on still holds now: keccak256(RLP) and prevRandao at field 13.
        if (headerBlock >= block.number || block.number - headerBlock > RECENT_BLOCKS) {
            revert HeaderUnavailable(headerBlock);
        }
        if (keccak256(header) != blockhash(headerBlock)) revert WrongHeader(headerBlock);
        _prevRandao(header);
        target = block.number + TARGET_BLOCKS;
        // casting to 'uint64' is safe because block times and numbers stay far below 2^64
        // forge-lint: disable-next-line(unsafe-typecast)
        b.startedAt = uint64(block.timestamp);
        // forge-lint: disable-next-line(unsafe-typecast)
        b.targetBlock = uint64(target);
        _backups[round] = b;
        emit BackupStarted(round, target, msg.sender);
    }

    /// @notice Anyone, with the target block's RLP header: stores its prevRandao as the round's mix.
    function fixBackup(uint256 round, bytes calldata header) external returns (bytes32 mix) {
        Backup memory b = _backups[round];
        if (b.startedAt == 0) revert NoBackup(round);
        if (b.fixedAt != 0) revert BackupAlreadyFixed(round);
        bytes32 h = _blockHash(b.targetBlock);
        if (h == bytes32(0)) revert HeaderUnavailable(b.targetBlock);
        if (keccak256(header) != h) revert WrongHeader(b.targetBlock);
        mix = _prevRandao(header);
        _mixes[round] = mix;
        // casting to 'uint64' is safe because block times stay far below 2^64
        // forge-lint: disable-next-line(unsafe-typecast)
        b.fixedAt = uint64(block.timestamp);
        _backups[round] = b;
        emit BackupFixed(round, b.targetBlock, mix, msg.sender);
    }

    /// @notice A round's backup: started (time), its target block, fixed (time) and its mix; zeros if none.
    function backupOf(uint256 round)
        external
        view
        returns (uint64 startedAt, uint64 targetBlock, uint64 fixedAt, bytes32 mix)
    {
        Backup memory b = _backups[round];
        return (b.startedAt, b.targetBlock, b.fixedAt, _mixes[round]);
    }

    // ------------------------------------------------------------------------------------------------------------
    // The keeper's reads

    /// @notice The request of (consumer, key) as DRAND holds it for this contract: its time and round (zeros if none).
    function requestOf(address consumer, uint256 key) public view returns (uint64 requestedAt, uint64 round) {
        return DRAND.requestOf(address(this), uint256(_id(consumer, key)));
    }

    /// @notice Requested, `SILENCE` past the request, and no word (drand or backup) ready by then. Final once true.
    function isSilent(address consumer, uint256 key) external view returns (bool) {
        (uint64 requestedAt,) = requestOf(consumer, key);
        if (requestedAt == 0) return false;
        uint256 deadline = uint256(requestedAt) + SILENCE;
        // The consumers' 7 days are a time by design (F61 R4), as on DrandSource.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp <= deadline) return false;
        (, uint64 readyAt) = wordOf(consumer, key);
        return readyAt == 0 || readyAt > deadline;
    }

    function roundTime(uint256 round) external pure returns (uint256) {
        return DRAND.roundTime(round);
    }

    function roundAt(uint256 timestamp) external pure returns (uint256) {
        return DRAND.roundAt(timestamp);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Internals

    function _id(address consumer, uint256 key) private pure returns (bytes32) {
        return keccak256(abi.encode(consumer, key));
    }

    /// @dev BLOCKHASH for the last 256 blocks, then EIP-2935's contract for 8,191; zero when out of reach.
    function _blockHash(uint256 n) private view returns (bytes32 h) {
        if (n >= block.number) return bytes32(0);
        if (block.number - n <= 256) return blockhash(n);
        (bool ok, bytes memory ret) = HISTORY.staticcall(abi.encode(n));
        if (ok && ret.length == 32) h = abi.decode(ret, (bytes32));
    }

    /// @dev Field 13 of the header list (parentHash, ommersHash, coinbase, stateRoot, txRoot, receiptsRoot, logsBloom,
    /// difficulty, number, gasLimit, gasUsed, timestamp, extraData, **prevRandao**, ...): fixed since London; later
    /// forks only append fields. The first 13 fields are byte strings; a list among them is refused.
    function _prevRandao(bytes calldata h) private pure returns (bytes32 mix) {
        if (h.length < 2) revert BadHeader();
        uint256 b0 = uint8(h[0]);
        if (b0 < 0xf8) revert BadHeader();
        uint256 ll = b0 - 0xf7;
        if (1 + ll + _be(h, 1, ll) != h.length) revert BadHeader();
        uint256 p = 1 + ll;
        for (uint256 i; i < 13; ++i) {
            p = _skip(h, p);
        }
        if (p + 33 > h.length || uint8(h[p]) != 0xa0) revert BadHeader();
        mix = bytes32(h[p + 1:p + 33]);
    }

    /// @dev The position after the byte string at `p`.
    function _skip(bytes calldata h, uint256 p) private pure returns (uint256) {
        // A malformed header fails the whole proof: reverting inside the field walk is the intent.
        // forge-lint: disable-next-line(require-revert-in-loop)
        if (p >= h.length) revert BadHeader();
        uint256 b = uint8(h[p]);
        if (b < 0x80) return p + 1;
        if (b <= 0xb7) return p + 1 + (b - 0x80);
        if (b < 0xc0) {
            uint256 ll = b - 0xb7;
            return p + 1 + ll + _be(h, p + 1, ll);
        }
        // forge-lint: disable-next-line(require-revert-in-loop)
        revert BadHeader();
    }

    /// @dev The big-endian number in h[p : p + n], 1 ≤ n ≤ 8.
    function _be(bytes calldata h, uint256 p, uint256 n) private pure returns (uint256 v) {
        // forge-lint: disable-next-line(require-revert-in-loop)
        if (n == 0 || n > 8 || p + n > h.length) revert BadHeader();
        for (uint256 i; i < n; ++i) {
            v = (v << 8) | uint8(h[p + i]);
        }
    }
}
