// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IDrandSource} from "../../../../src/box/interfaces/IDrandSource.sol";
import {DrandWords} from "../../../../src/box/randomness/DrandWords.sol";

/// @notice TEST ONLY. The randomness half of the tickets add-on (`IBoxTickets`, slice S3), without the vault, the
/// placeholder NFT or the shuffle: the graduation word (key 0) and one word per draw ticket (key = ticket id), settled
/// strictly in request order, and terminal mode when the queue's head is silent. It is the consumer change S9 hands to
/// S3: MisfitsPlaceholders' flow (src/v2/MisfitsPlaceholders.sol:324-470, :731-789) with every `IRandomnessSource` call
/// replaced by `DrandWords` on `IDrandSource` (no fee, no refund; a posting bounty in the draw price), and the
/// graduation word requested by the coordinator's graduation poke (`graduate`, try/catch, as the coordinator does).
/// The BC-053 suite runs two of these ("two boxes") on one shared source.
contract DrawQueueConsumer {
    struct Draw {
        address drawer;
        uint40 requestedAt;
        bool settled;
        bytes32 word;
    }

    event GraduationWordRequested(address indexed requester, uint256 round, uint256 bounty);
    event GraduationWordStored(bytes32 word, uint256 readyAt);
    event DrawRequested(uint256 indexed ticketId, address indexed drawer, uint256 round, uint256 bounty);
    event DrawSettled(uint256 indexed ticketId, bytes32 word);
    event TerminalModeEntered(uint256 timestamp, uint256 deadKey);
    event PokeFailed(bytes reason);

    error NotGraduated();
    error AlreadyGraduated();
    error TerminalMode();
    error AlreadyTerminal();
    error WordAlreadyRequested();
    error WordNotRequested();
    error WordAlreadyAccepted();
    error WordNotReady();
    error WordNotAccepted();
    error NothingSettled();
    error NothingPending();
    error HeadNotDead(uint256 key, uint256 deadline);
    error QueueDead(uint256 key, uint256 deadline);

    /// @notice The graduation word nobody requested is silent this long after graduation (IBoxTickets).
    uint256 public constant SILENCE_UNREQUESTED = 30 days;
    /// @notice The gas the coordinator's graduation poke gives `requestGraduationWord` (the S6 constant this models).
    uint256 public immutable pokeGas;

    IDrandSource public immutable source;
    /// @notice Whether placeholders were taken during the curve (q > 0): only then is a graduation word needed.
    bool public immutable needsWord;

    uint40 public gateAt;
    uint40 public wordRequestedAt;
    uint40 public wordAcceptedAt;
    uint40 public terminalAt;
    uint32 public drawsRequested;
    uint32 public drawsSettled;
    bytes32 public graduationWord;
    mapping(uint256 => Draw) internal _draws;

    constructor(IDrandSource source_, bool needsWord_, uint256 pokeGas_) {
        source = source_;
        needsWord = needsWord_;
        pokeGas = pokeGas_;
    }

    // ------------------------------------------------------------------------------------------------------------
    // Graduation and its word

    /// @notice The coordinator's graduation (the parts that touch randomness): the gate opens, then the graduation
    /// poke requests the word in try/catch behind `pokeGas` (core-v1-interfaces § 2), so a failing poke never blocks
    /// graduation; anyone may request later.
    function graduate() external {
        if (gateAt != 0) revert AlreadyGraduated();
        gateAt = uint40(block.timestamp);
        if (!needsWord) return;
        try this.requestGraduationWord{gas: pokeGas}() {}
        catch (bytes memory reason) {
            emit PokeFailed(reason);
        }
    }

    /// @notice Anyone, once, after graduation: requests key 0; `msg.value` is its posting bounty (none required: the
    /// coordinator's poke sends none).
    function requestGraduationWord() external payable {
        if (gateAt == 0) revert NotGraduated();
        if (terminalAt != 0) revert TerminalMode();
        if (!needsWord || wordRequestedAt != 0) revert WordAlreadyRequested();
        wordRequestedAt = uint40(block.timestamp);
        uint256 round = DrandWords.request(source, 0, msg.value);
        emit GraduationWordRequested(msg.sender, round, msg.value);
    }

    /// @notice Anyone, once the word counts (MisfitsPlaceholders.sol:346-357).
    function acceptGraduationWord() external {
        if (wordAcceptedAt != 0) revert WordAlreadyAccepted();
        if (terminalAt != 0) revert TerminalMode();
        if (wordRequestedAt == 0) revert WordNotRequested();
        (bytes32 word, uint256 readyAt, bool ok) = DrandWords.usableWord(source, 0, wordRequestedAt);
        if (!ok) revert WordNotReady();
        graduationWord = word;
        wordAcceptedAt = uint40(block.timestamp);
        emit GraduationWordStored(word, readyAt);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Draws

    /// @notice One draw (MisfitsPlaceholders.sol:364-392 without the vault): `msg.value` is its posting bounty, part
    /// of the draw price; after the request its round's pot must hold `DrandWords.roundTarget()` (the first draw of a
    /// round tops it up). A draw that also sends the graduation word (nobody had) makes both requests in one block, so
    /// they share that round and its pot.
    function draw() external payable returns (uint256 ticketId) {
        if (terminalAt != 0) revert TerminalMode();
        if (gateAt == 0) revert NotGraduated();
        bool sendWord = needsWord && wordRequestedAt == 0;
        if (!sendWord) {
            (bool exists, bool dead, uint256 key, uint256 headDeadline) = head();
            if (exists && dead) revert QueueDead(key, headDeadline);
        }
        ticketId = ++drawsRequested;
        _draws[ticketId] = Draw({drawer: msg.sender, requestedAt: uint40(block.timestamp), settled: false, word: 0});
        if (sendWord) {
            wordRequestedAt = uint40(block.timestamp);
            uint256 wordRound = DrandWords.request(source, 0, 0);
            emit GraduationWordRequested(msg.sender, wordRound, 0);
        }
        uint256 round = DrandWords.request(source, ticketId, msg.value);
        DrandWords.checkFunded(source, round);
        emit DrawRequested(ticketId, msg.sender, round, msg.value);
    }

    /// @notice Settles up to `maxCount` draws in request order, stopping at the first whose word does not count yet.
    function settle(uint256 maxCount) external returns (uint256 settled) {
        if (terminalAt != 0) revert TerminalMode();
        if (needsWord && wordAcceptedAt == 0) revert WordNotAccepted();
        uint256 done = drawsSettled;
        uint256 requested = drawsRequested;
        while (settled < maxCount && done < requested) {
            uint256 id = done + 1;
            Draw storage d = _draws[id];
            (bytes32 word,, bool ok) = DrandWords.usableWord(source, id, d.requestedAt);
            if (!ok) break;
            d.settled = true;
            d.word = word;
            emit DrawSettled(id, word);
            unchecked {
                ++done;
                ++settled;
            }
        }
        if (settled == 0) revert NothingSettled();
        // casting to 'uint32' is safe because done <= drawsRequested, a uint32
        // forge-lint: disable-next-line(unsafe-typecast)
        drawsSettled = uint32(done);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Terminal mode

    /// @notice Anyone, once the queue's head is past its deadline without a word that counts (F61 R4: 7 silent days).
    function enterTerminal() external {
        if (terminalAt != 0) revert AlreadyTerminal();
        if (gateAt == 0) revert NotGraduated();
        (bool exists, bool dead, uint256 key, uint256 headDeadline) = head();
        if (!exists) revert NothingPending();
        if (!dead) revert HeadNotDead(key, headDeadline);
        terminalAt = uint40(block.timestamp);
        emit TerminalModeEntered(block.timestamp, key);
    }

    /// @notice The queue's head: the graduation word until it is stored, then the oldest unsettled draw
    /// (MisfitsPlaceholders.sol:731-755); `dead` when past its deadline without a word that counts.
    function head() public view returns (bool exists, bool dead, uint256 key, uint256 headDeadline) {
        uint256 since;
        bool requested = true;
        if (needsWord && wordAcceptedAt == 0) {
            requested = wordRequestedAt != 0;
            since = wordRequestedAt;
            headDeadline = requested ? DrandWords.deadline(since) : uint256(gateAt) + SILENCE_UNREQUESTED;
        } else {
            if (drawsSettled == drawsRequested) return (false, false, 0, 0);
            key = uint256(drawsSettled) + 1;
            since = _draws[key].requestedAt;
            headDeadline = DrandWords.deadline(since);
        }
        exists = true;
        if (block.timestamp <= headDeadline) return (true, false, key, headDeadline);
        dead = requested ? DrandWords.isDead(source, key, since) : true;
    }

    function drawOf(uint256 ticketId) external view returns (Draw memory) {
        return _draws[ticketId];
    }
}
