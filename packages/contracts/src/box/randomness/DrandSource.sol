// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IDrandSource} from "../interfaces/IDrandSource.sol";
import {BoxDrandQuicknet} from "./BoxDrandQuicknet.sol";

/// @title DrandSource (slice S9; one shared contract per chain, no clone)
/// @notice The randomness of every box: drand quicknet only (F61 R4: no Chainlink VRF or other backup exists here or can
/// be switched to; BC-053). One word per (consumer, key), pulled with `wordOf`; this contract never calls a consumer.
/// Owned by nobody: no owner, admin, pause, upgrade, setter, rescue or fee (F23 C2); no constructor input, so the same
/// init code gives the same address and code on every chain (`DrandSourcePins.sol`).
///
/// Generalised from `ChainlinkDrandSource` (src/v2/ChainlinkDrandSource.sol at `46a030f6`) by keeping its drand half and
/// dropping the VRF half: the request record and the domain-separated word (`:69-81`, `:186-228`), `postRound`
/// (`:255-267`), `roundAt` / `roundTime` (`:298-307`), `withdrawRefund`'s pull pattern for the bounties (`:270-278`);
/// the BLS check is `BoxDrandQuicknet`, the box core's copy of `DrandQuicknet`.
///
/// - **Request** (`request`): fixes, for (msg.sender, key), the first quicknet round at least `MARGIN` = 12 s after the
///   request's block (F54; auto-reveal-and-fast-draws § 3.1, the 12 s row: on mainnet, whose block times are 2 mod 3 s
///   against the rounds' 0 mod 3, that is the round 13 s later, postable from the second block after the request). So
///   the word is unknown to everyone, the requester and the block's proposer included, when the request lands; a
///   proposer would need two consecutive slots to see it first (§ 3.1). Free: `msg.value` is a posting bounty added to
///   that round's pot, never a fee. Once per (consumer, key).
/// - **Post** (`postRound`): anyone (our keeper, the page, the open-source bot, a bounty hunter; F66 K6), once per
///   round, from the round's own time on, checked on chain against quicknet's group key. The round's whole pot is
///   credited to the poster, who pulls it (`withdrawBounty`). A round has exactly one valid signature, so the poster
///   chooses only the moment, and `readyAt` is that moment.
/// - **Silence** (F61 R4): a request with no word ready within `SILENCE` = 7 days is silent (`isSilent`), for good: a
///   late post does not undo it. The consumer (BoxTickets) then lets anyone enter terminal mode. The source keeps
///   answering honestly afterwards; a late word is the consumer's to ignore.
///
/// **Words.** word = keccak256(abi.encode(`WORD_TAG`, randomness, keccak256(abi.encode(consumer, key)))): requests that
/// share a round get different words, and no consumer can obtain, change or block another's (each request is keyed by
/// its own caller; a post only adds a round). The tag is v2's drand tag (`ChainlinkDrandSource.sol:134`), so a bot's
/// word code carries over. `readyAt` is the round's posting time: never before the request (the round's time is at least
/// `MARGIN` after it, and a round is posted only from its time on) and never moved; `wordOf` reads at most three
/// storage slots (about 8,000 to 13,000 gas cold, measured; consumers allow 50,000).
///
/// **Bounties.** A round's pot is a uint128 next to its posting time (one slot), so a post of a round that carries a
/// bounty writes one new slot (the randomness) and the poster's balance. Copying a pending post is possible: the copier
/// gets the pot, the word is the same (the round has one signature); keepers post through a private mempool. A pot on a
/// round nobody ever posts (drand halted for good) stays here: there is no rescue (F23 C2).
/// @dev Invariants (tested): `wordOf` never changes once non-zero and answers within 50,000 gas in every state; the
/// round of a request is strictly later than its block; `readyAt` ≥ the request's time + `MARGIN`; ETH held ≥ Σ pots of
/// unposted rounds + Σ unwithdrawn bounties, with equality unless someone forces ETH in (SELFDESTRUCT, block rewards;
/// such ETH stays here, as nothing can move it). Written for Square Hole (MIT, no third-party code). The only external
/// calls are the EIP-2537, SHA-256 and MODEXP precompiles (STATICCALL) and the ETH transfer of `withdrawBounty`, made
/// after the balance is cleared.
contract DrandSource is IDrandSource {
    /// @notice One request: when it was made and the quicknet round fixed then (both zero if never).
    struct Request {
        uint64 requestedAt;
        uint64 round;
    }

    /// @dev One quicknet round: its randomness (sha256 of the compressed signature, as the League publishes it) once
    /// posted (slot 0); when it was posted here and the pot of bounties waiting for that post (slot 1).
    struct Round {
        bytes32 randomness;
        uint64 postedAt;
        uint128 pot;
    }

    /// @notice Unreachable (a pot would hold more ETH than exists); here so the uint128 pot is never truncated.
    error PotOverflow(uint256 round);

    /// @notice A request's round is the first at least this long after it (F54; auto-reveal § 3.1).
    uint256 public constant MARGIN = 12 seconds;
    /// @notice A request with no word ready this long after it is silent (F61 R4; the placeholders add-on's SILENCE).
    uint256 public constant SILENCE = 7 days;
    /// @notice quicknet's round 1 time and period (`BoxDrandQuicknet`).
    uint256 public constant GENESIS_TIME = BoxDrandQuicknet.GENESIS_TIME;
    uint256 public constant PERIOD = BoxDrandQuicknet.PERIOD;
    /// @notice The words' domain tag (v2's drand tag, `ChainlinkDrandSource.DRAND_WORD_TAG`).
    bytes32 public constant WORD_TAG = keccak256("squarehole.randomness.drand-quicknet");

    /// @dev keccak256(consumer, key) → the request.
    mapping(bytes32 => Request) private _requests;
    /// @dev quicknet round → its randomness, posting time and pot.
    mapping(uint256 => Round) private _rounds;
    /// @dev poster → bounties credited and not yet withdrawn.
    mapping(address => uint256) private _owed;

    // ------------------------------------------------------------------------------------------------------------
    // Requests and bounties

    /// @inheritdoc IDrandSource
    /// @dev The round's time is at least `MARGIN` after this block, so the round cannot be posted yet and its pot can
    /// only go to a later poster.
    function request(uint256 key) external payable returns (uint256 round) {
        bytes32 id = _id(msg.sender, key);
        if (_requests[id].requestedAt != 0) revert AlreadyRequested(msg.sender, key);
        round = roundAt(block.timestamp + MARGIN);
        // casting to 'uint64' is safe because a round of any block time below 2^63 s fits
        // forge-lint: disable-next-line(unsafe-typecast)
        _requests[id] = Request({requestedAt: _now(), round: uint64(round)});
        if (msg.value != 0) _addToPot(round, msg.value);
        emit Requested(msg.sender, key, round, msg.value);
    }

    /// @inheritdoc IDrandSource
    /// @dev Any round number a post could ever carry (1 … 2^64 − 1), not yet posted; `msg.value` 0 is allowed (an empty
    /// event). A pot on a round far in the future waits for that round's time.
    function addBounty(uint256 round) external payable {
        if (round == 0 || round > type(uint64).max) revert InvalidRound(round);
        if (_rounds[round].postedAt != 0) revert RoundKnown(round);
        if (msg.value != 0) _addToPot(round, msg.value);
        emit BountyAdded(round, msg.sender, msg.value);
    }

    /// @inheritdoc IDrandSource
    /// @dev Copy of `ChainlinkDrandSource.postRound` (src/v2/ChainlinkDrandSource.sol:255-267) plus the pot's credit.
    /// api.drand.sh gives the signature compressed; the page, the keeper and the bot decompress it (x, then y with the
    /// compressed sign bit), as script-py/drand_vectors.py does.
    function postRound(uint256 round, bytes calldata signature) external returns (bytes32 randomness) {
        if (round == 0 || round > type(uint64).max) revert InvalidRound(round);
        Round storage r = _rounds[round];
        if (r.postedAt != 0) revert RoundKnown(round);
        uint256 at = roundTime(round);
        if (block.timestamp < at) revert RoundNotYet(round, at);
        bool valid;
        // casting to 'uint64' is safe because round <= type(uint64).max (checked above)
        // forge-lint: disable-next-line(unsafe-typecast)
        (valid, randomness) = BoxDrandQuicknet.verify(uint64(round), signature);
        if (!valid) revert InvalidSignature(round);
        uint256 pot = r.pot;
        _rounds[round] = Round({randomness: randomness, postedAt: _now(), pot: 0});
        if (pot != 0) _owed[msg.sender] += pot;
        emit RoundPosted(round, randomness, msg.sender, pot);
    }

    /// @inheritdoc IDrandSource
    /// @dev Copy of `ChainlinkDrandSource.withdrawRefund` (src/v2/ChainlinkDrandSource.sol:270-278): the balance is
    /// cleared before the transfer, which gets all remaining gas; a recipient that refuses reverts the whole call and
    /// the credit stays.
    function withdrawBounty(address payable to) external returns (uint256 amount) {
        if (to == address(0)) revert ZeroAddress();
        amount = _owed[msg.sender];
        if (amount == 0) revert NothingOwed();
        _owed[msg.sender] = 0;
        emit BountyWithdrawn(msg.sender, to, amount);
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert WithdrawFailed();
    }

    // ------------------------------------------------------------------------------------------------------------
    // Views

    /// @inheritdoc IDrandSource
    /// @dev Reads the request, then the round's posting time, then (only if posted) its randomness: at most three
    /// slots in every state, so it answers within the consumers' 50,000 gas.
    function wordOf(address consumer, uint256 key) external view returns (bytes32 word, uint64 readyAt) {
        bytes32 id = _id(consumer, key);
        uint256 round = _requests[id].round;
        if (round == 0) return (bytes32(0), 0);
        Round storage r = _rounds[round];
        readyAt = r.postedAt;
        if (readyAt == 0) return (bytes32(0), 0);
        word = keccak256(abi.encode(WORD_TAG, r.randomness, id));
    }

    /// @inheritdoc IDrandSource
    function requestOf(address consumer, uint256 key) external view returns (uint64 requestedAt, uint64 round) {
        Request memory q = _requests[_id(consumer, key)];
        return (q.requestedAt, q.round);
    }

    /// @inheritdoc IDrandSource
    /// @dev Silent means: requested, `SILENCE` has passed since the request, and its round was not posted by then
    /// (not posted at all, or posted later). The second clause makes silence final: once true it stays true, so a
    /// late post cannot hand anyone the choice between terminal mode and a word already public.
    function isSilent(address consumer, uint256 key) external view returns (bool) {
        Request memory q = _requests[_id(consumer, key)];
        if (q.requestedAt == 0) return false;
        uint256 deadline = uint256(q.requestedAt) + SILENCE;
        if (block.timestamp <= deadline) return false;
        uint256 postedAt = _rounds[q.round].postedAt;
        return postedAt == 0 || postedAt > deadline;
    }

    /// @inheritdoc IDrandSource
    function beaconOf(uint256 round) external view returns (bytes32 randomness, uint64 postedAt) {
        Round storage r = _rounds[round];
        return (r.randomness, r.postedAt);
    }

    /// @inheritdoc IDrandSource
    function bountyOf(uint256 round) external view returns (uint256) {
        return _rounds[round].pot;
    }

    /// @inheritdoc IDrandSource
    function owedTo(address poster) external view returns (uint256) {
        return _owed[poster];
    }

    /// @inheritdoc IDrandSource
    /// @dev Copy of src/v2/ChainlinkDrandSource.sol:299-302.
    function roundAt(uint256 timestamp) public pure returns (uint256) {
        if (timestamp <= GENESIS_TIME) return 1;
        return (timestamp - GENESIS_TIME + PERIOD - 1) / PERIOD + 1;
    }

    /// @inheritdoc IDrandSource
    /// @dev Copy of src/v2/ChainlinkDrandSource.sol:305-307; round 0 does not exist (`InvalidRound`, where v2 panics).
    function roundTime(uint256 round) public pure returns (uint256) {
        if (round == 0) revert InvalidRound(0);
        return GENESIS_TIME + (round - 1) * PERIOD;
    }

    // ------------------------------------------------------------------------------------------------------------
    // Internals

    /// @dev A pot cannot reach 2^128 wei (more ETH than exists, about 2^87 wei today); the check only keeps the
    /// narrowing honest.
    function _addToPot(uint256 round, uint256 amount) private {
        Round storage r = _rounds[round];
        uint256 pot = uint256(r.pot) + amount;
        if (pot > type(uint128).max) revert PotOverflow(round);
        // casting to 'uint128' is safe because pot <= type(uint128).max (checked above)
        // forge-lint: disable-next-line(unsafe-typecast)
        r.pot = uint128(pot);
    }

    function _id(address consumer, uint256 key) private pure returns (bytes32) {
        return keccak256(abi.encode(consumer, key));
    }

    function _now() private view returns (uint64) {
        // casting to 'uint64' is safe because block timestamps stay below 2^64 s
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint64(block.timestamp);
    }
}
