// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {TransientReentrancyGuard} from "../libraries/TransientReentrancyGuard.sol";
import {BoxCloneBase} from "./BoxCloneBase.sol";
import {BoxPlaceholderToken} from "./BoxPlaceholderToken.sol";
import {DrawStatus, ItemReveal, TicketPhase} from "./interfaces/BoxTypes.sol";
import {IBoxCollection} from "./interfaces/IBoxCollection.sol";
import {IBoxTickets} from "./interfaces/IBoxTickets.sol";
import {IBoxTicketsInFlight} from "./interfaces/IBoxTicketsInFlight.sol";
import {IBoxToken} from "./interfaces/IBoxToken.sol";
import {IBoxVault} from "./interfaces/IBoxVault.sol";
import {IDrandSource} from "./interfaces/IDrandSource.sol";
import {BoxCloneArgs as A} from "./libraries/BoxCloneArgs.sol";
import {BoxClones} from "./libraries/BoxClones.sol";
import {BoxEncoding} from "./libraries/BoxEncoding.sol";
import {BoxShuffle} from "./libraries/BoxShuffle.sol";
import {DrandWords} from "./randomness/DrandWords.sol";

/// @title BoxTickets (add-on 1 `placeholders`; slice S3; the implementation of its per-box clone)
/// @notice The vault's ticket adapter and the placeholder NFT for any new-collection box that picks the add-on (F55).
/// A copy of MisfitsPlaceholders (src/v2/MisfitsPlaceholders.sol:53-801 at 46a030f6) with the add-on's texts, N, firstId,
/// the open delay and the source as clone arguments (`BoxCloneArgs.TicketsArgs`), drand as the only randomness
/// (IDrandSource; F61 R4: free requests, `msg.value` a posting bounty), and the safety net's RETURN_GRACE at 30 days
/// (auto-reveal-and-fast-draws § 1.7; v2: 180).
///
/// - **Curve** (from `openAt`, a clock time (F80), until graduation): `take` k placeholders (the vault's quote ⌈A·k/n⌉
///   plus the 1% draw fee, burned); `handBack` (the return quote less 5%; the last slot moves into the freed one). No
///   number yet.
/// - **Graduation** (the vault's gate opens) closes takes and hand-backs, fixes q and freezes transfers until the
///   graduation word (key 0) is stored: `requestGraduationWord` (the coordinator's graduation poke, or anyone, or the
///   first draw) and `acceptGraduationWord`. Slot j then holds item firstId + π_w(j) (`BoxShuffle`), and `open`
///   delivers it with its reveal in one transaction. q = 0: no word, π the identity.
/// - **Draws** after graduation: one word per ticket (key = ticket id), settled strictly in request order (lazy
///   Fisher-Yates over the positions [q, N), mapped through π_w). `openDraw` by the drawer delivers to the address it
///   names; anyone else delivers to the drawer, at once for a drawer without code (the keeper's fast open), for a
///   contract drawer only after REVEAL_GRACE (review of sh-core-v1; MisfitsPlaceholders.sol:431-453 let anyone). While
///   `openDraw`'s `_deliver` (the vault's delivery, then the reveal) or `cancelDraw`'s `_release` runs, `ticketInFlight`
///   names that ticket (`IBoxTicketsInFlight`, transient, 0 at every other time), so the per-item stream books each draw
///   from its own request (R1 of the architecture review of 2026-10-07).
/// - **Only the box's coordinator initialises**, a clone of the version's coordinator implementation (BC-100).
/// - **Silence → terminal mode**: a queue head without a usable word `SILENCE` (7 days) after its request, or
///   `SILENCE_UNREQUESTED` (30 days) after graduation when nobody requested the graduation word, lets anyone
///   `enterTerminal`: fee-free cancels and number-less hand-backs; `takeByNumber` from `TAKE_DELAY` (3 days). Both
///   silences start the second after their deadline (a word ready at the deadline still counts), while the graces
///   open at their edge. After the 30 days, until someone enters terminal mode, anyone may still request the
///   graduation word (or draw, which requests it): that late request gives the word a new 7-day clock, the never-stuck
///   runbook's rescue (F142; box 0's own review FQ-27, FQ-30, F147).
/// - **Safety net** (F55): an item handed over without its reveal opens after `REVEAL_GRACE` (30 days) and is
///   returnable unrevealed `RETURN_GRACE` (30 days) after it left (`returnableFrom`, read by the vault): about 60 days.
/// - Payments run through here (genesis review M-2); no T and no ETH stays here after a call. **A draw pays its round's
///   posting** (F75 W3): after its request the round's pot is topped up to DRAND_BOUNTY_GAS × the base fee from
///   `msg.value` and the rest goes back to the drawer (`DrandWords.payRound`, `BountyTooLow`; review of sh-f75), so the
///   first draw of a round pays it and later draws of that round get all they sent back. A drawer that refuses ETH
///   still draws: its rest joins the pot. The graduation word's request needs none; ETH sent with it is its bounty.
///   No owner, setter, pause, upgrade, rescue or mint outside `take` (F23 C2).
/// @dev Checks, effects, then interactions, under a transient lock (the vault holds its own), taken by two calls
/// (`nonReentrantCall`; the inline `nonReentrant` costs about 500 bytes more here, F75 W3 and BC-069's margin). An
/// uninitialised clone (`openAt` 0; `initialize` never stores 0) refuses `take` and `setApprovalForAll`; every other
/// write needs a placeholder, a draw or the vault's adapter role, none of which an uninitialised clone can have.
/// Written for Square Hole (MIT, no third-party code).
contract BoxTickets is TransientReentrancyGuard, BoxCloneBase, BoxPlaceholderToken, IBoxTicketsInFlight {
    /// @dev One slot. `settleHours`: request to settlement, rounded up, saturating (MisfitsPlaceholders.sol:105-112) at
    /// 65,535 hours (7.48 years): a contract drawer's REVEAL_GRACE runs from the settlement rounded up to the hour, so
    /// a draw settled later than that after its request has no first-right window (box 0's own review W2-U6-1, F147).
    struct Draw {
        address drawer;
        uint40 requestedAt;
        DrawStatus status;
        uint32 offset;
        uint16 settleHours;
    }

    /// @notice A word counts only if ready at most this long after its request (the source's SILENCE, F61 R4).
    uint256 public constant SILENCE = 7 days;
    /// @notice A graduation word nobody requested is silent this long after graduation.
    uint256 public constant SILENCE_UNREQUESTED = 30 days;
    /// @notice After a number is fixed, its holder may open without the reveal once this much time has passed.
    uint256 public constant REVEAL_GRACE = 30 days;
    /// @notice Takes by number start this long after terminal mode began.
    uint256 public constant TAKE_DELAY = 3 days;
    /// @notice An item that left without its reveal can be returned unrevealed this long after it left (F55's safety
    /// net; auto-reveal-and-fast-draws § 1.7: 30, down from v2's 180).
    uint256 public constant RETURN_GRACE = 30 days;

    uint8 private constant _KIND_PLACEHOLDER = 1;
    uint8 private constant _KIND_DRAW = 2;
    /// @dev Gas for one `wordOf` read (IDrandSource answers within 50,000), and the gas left that guarantees it all.
    uint256 private constant _WORD_GAS = 50_000;
    uint256 private constant _WORD_GAS_REQUIRED = _WORD_GAS + _WORD_GAS / 63 + 5_000;
    /// @dev Transient: the draw ticket in flight (`ticketInFlight`, R1), set right before `openDraw`'s `_deliver` and
    /// `cancelDraw`'s `_release` and cleared right after each returns, written inline (a helper cost 27 bytes more,
    /// BC-069's margin). Slot 1: the lock's slot is a hash and nothing else here is transient.
    uint256 private constant _IN_FLIGHT = 1;

    /// @inheritdoc IBoxTickets
    address public immutable coordinatorImplementation;

    /// @inheritdoc IBoxTickets
    uint256 public openAt;
    TicketState private _state;
    /// @inheritdoc IBoxTickets
    bytes32 public graduationWord;
    mapping(uint256 => Draw) private _draws;
    /// @dev Lazy Fisher-Yates over the draw pool: index → position + 1 (0: index i holds position q + i).
    mapping(uint256 => uint256) private _swap;
    /// @dev The token in a live slot; 0 means token slot + 1 (every slot ≥ q holds 0).
    mapping(uint256 => uint256) private _slotToken;
    /// @dev Item id → when it left through this contract without its reveal (0: never).
    mapping(uint256 => uint256) private _leftUnrevealedAt;

    // ------------------------------------------------------------------------------------------------------------
    // Initialise

    /// @param coordinatorImplementation_ the version's BoxCoordinator implementation: only its clones may initialise.
    constructor(address coordinatorImplementation_) {
        coordinatorImplementation = coordinatorImplementation_;
    }

    /// @inheritdoc IBoxTickets
    function initialize() external {
        // Only the box's coordinator, a clone of the version's coordinator code (BC-100; review of sh-core-v1).
        if (msg.sender != coordinator() || !BoxClones.isCloneOf(msg.sender, coordinatorImplementation)) {
            revert NotCoordinator(msg.sender);
        }
        if (openAt != 0) revert AlreadyInitialised();
        // The hook's rule (BoxHook.initialize; F80): 0 (Now) or a time this block has reached opens in the next block.
        uint256 open_ = _argUint(A.T_OPEN_AT, 4);
        openAt = open_ <= block.timestamp ? block.timestamp + 1 : open_;
        if (!_token().approve(vault(), type(uint256).max)) revert TokenNotPulled();
    }

    // ------------------------------------------------------------------------------------------------------------
    // The curve: take and hand back placeholders (MisfitsPlaceholders.sol:238-294)

    /// @inheritdoc IBoxTickets
    function take(uint256 count, uint256 maxTokenIn, uint256 deadline)
        external
        nonReentrantCall
        returns (uint256 firstTokenId)
    {
        _checkDeadline(deadline);
        uint256 open_ = openAt;
        if (open_ == 0) revert NotInitialised();
        if (block.timestamp < open_) revert NotOpenYet(open_);
        (uint256 principal, uint256 fee) = _quote(count, maxTokenIn);
        if (_gateOpenedAt() != 0) revert TakesClosed();
        TicketState memory s = _state;
        firstTokenId = uint256(s.minted) + 1;
        uint256 firstSlot = s.slots;
        for (uint256 i; i < count; ++i) {
            uint256 id = firstTokenId + i;
            uint256 slot = firstSlot + i;
            // casting to 'uint32' is safe because slot < q + count ≤ N ≤ type(uint32).max (the vault bounds count)
            // forge-lint: disable-next-line(unsafe-typecast)
            _tokens[id] = Token({owner: msg.sender, slot: uint32(slot)});
            if (id != slot + 1) _slotToken[slot] = id;
            emit Transfer(address(0), msg.sender, id);
        }
        _balances[msg.sender] += count;
        // casting is safe because count < N ≤ type(uint32).max (the sums are checked)
        // forge-lint: disable-next-line(unsafe-typecast)
        (s.minted, s.slots) = (s.minted + uint40(count), s.slots + uint32(count));
        _state = s;
        emit PlaceholdersTaken(msg.sender, firstTokenId, count, principal, fee, firstSlot);

        _lock(count, principal + fee);
    }

    /// @inheritdoc IBoxTickets
    function handBack(uint256[] calldata tokenIds, uint256 minTokenOut, uint256 deadline)
        external
        nonReentrantCall
        returns (uint256 principal, uint256 fee)
    {
        _checkDeadline(deadline);
        uint256 k = tokenIds.length;
        if (k == 0) revert InvalidTokenList();
        TicketState memory s = _state;
        bool curve = _gateOpenedAt() == 0;
        if (!curve && (s.terminalAt == 0 || s.wordAcceptedAt != 0)) revert HandBackClosed();
        for (uint256 i; i < k; ++i) {
            uint256 id = tokenIds[i];
            Token memory t = _tokens[id];
            if (t.owner != msg.sender) revert NotHolder(id); // a repeated id is burned by then
            _burn(id, t.owner);
            if (curve) s.slots = _compact(t.slot, s.slots);
        }
        unchecked {
            _balances[msg.sender] -= k; // each id was the caller's
        }
        _state = s;
        (principal, fee) = _release(k, msg.sender, minTokenOut);
        emit PlaceholdersHandedBack(msg.sender, k, principal, fee);
    }

    // ------------------------------------------------------------------------------------------------------------
    // The graduation word (`:298-342`)

    /// @inheritdoc IBoxTickets
    function requestGraduationWord() external payable nonReentrantCall {
        TicketState memory s = _state;
        if (_gateOpenedAt() == 0) revert NotGraduated();
        if (s.terminalAt != 0) revert TerminalMode();
        if (s.slots == 0) revert NoPlaceholders();
        if (s.wordRequestedAt != 0) revert WordAlreadyRequested();
        s.wordRequestedAt = _now();
        _state = s;
        emit GraduationWordRequested(msg.sender, _request(0, msg.value), msg.value);
    }

    /// @inheritdoc IBoxTickets
    function acceptGraduationWord() external nonReentrantCall {
        TicketState memory s = _state;
        if (s.wordAcceptedAt != 0) revert WordAlreadyAccepted();
        if (s.terminalAt != 0) revert TerminalMode();
        if (s.wordRequestedAt == 0) revert WordNotRequested();
        (bytes32 word, uint256 readyAt, bool usable) = _usableWord(0, s.wordRequestedAt);
        if (!usable) revert WordNotReady();
        graduationWord = word;
        s.wordAcceptedAt = _now();
        _state = s;
        emit GraduationWordStored(word, s.slots, readyAt);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Draws after graduation (`:346-392`)

    /// @inheritdoc IBoxTickets
    function draw(uint256 maxTokenIn, uint256 deadline) external payable nonReentrantCall returns (uint256 ticketId) {
        _checkDeadline(deadline);
        TicketState memory s = _state;
        if (s.terminalAt != 0) revert TerminalMode();
        (uint256 principal, uint256 fee) = _quote(1, maxTokenIn);
        uint256 gateAt = _gateOpenedAt();
        if (gateAt == 0) revert NotGraduated();
        bool sendWord = s.slots != 0 && s.wordRequestedAt == 0;
        if (!sendWord) {
            // This draw would wait behind the head: refuse it when the head is dead (it could never settle).
            (bool exists, bool dead, uint256 key, uint256 headDeadline) = _head(s, gateAt);
            if (exists && dead) revert QueueDead(key, headDeadline);
        }
        ticketId = ++s.drawsRequested;
        if (sendWord) s.wordRequestedAt = _now();
        _state = s;
        _draws[ticketId] =
            Draw({drawer: msg.sender, requestedAt: _now(), status: DrawStatus.Requested, offset: 0, settleHours: 0});

        _lock(1, principal + fee);
        // Both requests fix the same round (the first ≥ now + MARGIN), so one bounty serves them.
        if (sendWord) emit GraduationWordRequested(msg.sender, _request(0, 0), 0);
        uint256 round = _request(ticketId, 0);
        // F75 W3, "the draw pays the drand round's posting": the round's pot is topped up to DRAND_BOUNTY_GAS (600,000)
        // × the block's base fee, the pay of whoever posts the round (usually the drawer's own page), and the rest of
        // msg.value goes back to the drawer under this lock, or into the pot if the drawer refuses it (review of
        // sh-f75). The first draw of a round pays; later draws get theirs back. BountyTooLow.
        uint256 paid = DrandWords.payRound(IDrandSource(source()), round, msg.value, msg.sender);
        emit DrawRequested(ticketId, msg.sender, principal, fee, round, paid);
    }

    /// @inheritdoc IBoxTickets
    function settle(uint256 maxCount) external nonReentrantCall returns (uint256 settled) {
        TicketState memory s = _state;
        if (s.terminalAt != 0) revert TerminalMode();
        if (s.slots != 0 && s.wordAcceptedAt == 0) revert WordNotAccepted();
        settled = _settle(s, maxCount, type(uint256).max);
        if (settled == 0) revert NothingSettled();
    }

    // ------------------------------------------------------------------------------------------------------------
    // Opening (`:401-454`)

    /// @inheritdoc IBoxTickets
    function open(uint256 tokenId, ItemReveal calldata r) external nonReentrantCall returns (uint256 itemId) {
        TicketState memory s = _state;
        if (s.wordAcceptedAt == 0) revert WordNotAccepted();
        Token memory t = _tokenOf(tokenId);
        bool holder = msg.sender == t.owner;
        if (!holder && !_mayAct(t.owner, tokenId, _ERA_KNOWN)) revert NotAuthorized(msg.sender, tokenId);
        _burn(tokenId, t.owner);
        unchecked {
            --_balances[t.owner];
        }
        itemId = _itemOfSlot(t.slot);

        bool revealed = _deliver(itemId, t.owner, r, uint256(s.wordAcceptedAt) + REVEAL_GRACE, holder);
        emit Opened(tokenId, _KIND_PLACEHOLDER, itemId, t.owner, revealed, _gateOpenedAt());
    }

    /// @inheritdoc IBoxTickets
    function openDraw(uint256 ticketId, address to, ItemReveal calldata r)
        external
        nonReentrantCall
        returns (uint256 itemId)
    {
        Draw memory d = _draws[ticketId];
        if (d.status == DrawStatus.None) revert UnknownDraw(ticketId);
        if (d.status == DrawStatus.Requested) {
            TicketState memory s = _state;
            if (s.terminalAt == 0 && (s.slots == 0 || s.wordAcceptedAt != 0)) _settle(s, type(uint256).max, ticketId);
            d = _draws[ticketId];
            if (d.status != DrawStatus.Settled) revert NotSettled(ticketId);
        } else if (d.status != DrawStatus.Settled) {
            revert DrawClosed(ticketId);
        }
        bool drawer = msg.sender == d.drawer;
        uint256 graceAt = _settledAt(d) + REVEAL_GRACE;
        // A contract drawer (an aggregator, a relayer) chooses the recipient itself: before the grace a third party
        // may open only for a drawer without code (the keeper's fast open to the drawer's own wallet; an EIP-7702
        // account counts as one), so nobody can push an item into a contract that cannot move it out (review of
        // sh-core-v1). After the grace anyone may open, to the drawer, so no draw stays shut for good.
        if (!drawer && block.timestamp < graceAt && _hasContractCode(d.drawer)) {
            revert DrawerOpensFirst(ticketId, graceAt);
        }
        _draws[ticketId].status = DrawStatus.Opened;
        itemId = firstId() + d.offset;
        address recipient = drawer && to != address(0) ? to : d.drawer;

        // The ticket in flight while `_deliver` runs (the vault's delivery, then the reveal): the stream starts the
        // item at this ticket's request (R1).
        assembly ("memory-safe") {
            tstore(_IN_FLIGHT, ticketId)
        }
        bool revealed = _deliver(itemId, recipient, r, graceAt, drawer);
        assembly ("memory-safe") {
            tstore(_IN_FLIGHT, 0)
        }
        emit Opened(ticketId, _KIND_DRAW, itemId, recipient, revealed, d.requestedAt);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Terminal mode (`:458-521`)

    /// @inheritdoc IBoxTickets
    function enterTerminal() external nonReentrantCall {
        TicketState memory s = _state;
        if (s.terminalAt != 0) revert AlreadyTerminal();
        uint256 gateAt = _gateOpenedAt();
        if (gateAt == 0) revert NotGraduated();
        (bool exists, bool dead, uint256 key, uint256 deadline) = _head(s, gateAt);
        if (!exists) revert NothingPending();
        if (!dead) revert HeadNotDead(key, deadline);
        s.terminalAt = _now();
        _state = s;
        emit TerminalModeEntered(block.timestamp, key);
    }

    /// @inheritdoc IBoxTickets
    function cancelDraw(uint256 ticketId) external nonReentrantCall returns (uint256 principal) {
        if (_state.terminalAt == 0) revert NotTerminal();
        Draw storage d = _draws[ticketId];
        if (d.status != DrawStatus.Requested) revert NotCancellable(ticketId);
        d.status = DrawStatus.Cancelled;
        address drawer = d.drawer;

        // The ticket in flight while the vault releases it: the stream books its accrual since its request (R1).
        assembly ("memory-safe") {
            tstore(_IN_FLIGHT, ticketId)
        }
        (principal,) = _release(1, drawer, 0);
        assembly ("memory-safe") {
            tstore(_IN_FLIGHT, 0)
        }
        emit TicketCancelled(ticketId, drawer, principal);
    }

    /// @inheritdoc IBoxTickets
    function takeByNumber(
        uint256 itemId,
        uint256 poolIndex,
        uint256 maxTokenIn,
        uint256 deadline,
        ItemReveal calldata r
    ) external nonReentrantCall returns (uint256 principal, uint256 fee) {
        _checkDeadline(deadline);
        TicketState memory s = _state;
        if (s.terminalAt == 0) revert NotTerminal();
        uint256 takeFrom = uint256(s.terminalAt) + TAKE_DELAY;
        if (block.timestamp < takeFrom) revert TooEarly(takeFrom);
        (bool numbered, uint256 position) = _numberPosition(s, itemId);
        if (numbered) {
            if (position < s.slots) revert NumberTaken(itemId);
            if (poolIndex >= _left(s) || _positionAt(poolIndex, s.slots) != position) {
                revert NotInPool(itemId, poolIndex);
            }
        }
        (principal, fee) = _quote(1, maxTokenIn);

        _lock(1, principal + fee);
        // The vault refuses (NotHidden) a shelf or outside item.
        bool revealed = _deliver(itemId, msg.sender, r, takeFrom, true);
        emit TakenByNumber(msg.sender, itemId, principal, fee, revealed);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Views (`:525-591`)

    /// @inheritdoc IBoxTickets
    function phase() public view returns (TicketPhase) {
        TicketState memory s = _state;
        if (s.terminalAt != 0) return TicketPhase.Terminal;
        if (_gateOpenedAt() == 0) return block.timestamp < openAt ? TicketPhase.BeforeOpen : TicketPhase.Curve;
        return s.slots != 0 && s.wordAcceptedAt == 0 ? TicketPhase.AwaitingWord : TicketPhase.Drawing;
    }

    /// @inheritdoc IBoxTickets
    function numberOf(uint256 tokenId) external view returns (uint256) {
        Token memory t = _tokenOf(tokenId);
        if (_state.wordAcceptedAt == 0) return 0;
        return _itemOfSlot(t.slot);
    }

    /// @inheritdoc IBoxTickets
    function slotOf(uint256 tokenId) external view returns (uint256) {
        return _tokenOf(tokenId).slot;
    }

    /// @inheritdoc IBoxTickets
    function drawTicket(uint256 ticketId) external view returns (DrawView memory v) {
        Draw memory d = _draws[ticketId];
        v.drawer = d.drawer;
        v.status = d.status;
        v.requestedAt = d.requestedAt;
        if (d.status == DrawStatus.Settled || d.status == DrawStatus.Opened) {
            v.itemId = firstId() + d.offset;
            v.revealFallbackAt = _settledAt(d) + REVEAL_GRACE;
        }
    }

    /// @inheritdoc IBoxTickets
    function poolPositionAt(uint256 index) external view returns (uint256) {
        return _positionAt(index, _state.slots);
    }

    /// @inheritdoc IBoxTickets
    function returnableFrom(uint256 itemId) external view returns (uint256) {
        uint256 at = _leftUnrevealedAt[itemId];
        return at == 0 ? 0 : at + RETURN_GRACE;
    }

    /// @inheritdoc IBoxTickets
    function status() external view returns (TicketState memory) {
        return _state;
    }

    /// @inheritdoc IBoxTicketsInFlight
    function ticketInFlight() external view returns (uint256 ticketId) {
        assembly ("memory-safe") {
            ticketId := tload(_IN_FLIGHT)
        }
    }

    /// @inheritdoc IBoxTickets
    function coordinator() public view returns (address) {
        return _argAddress(A.T_COORDINATOR);
    }

    /// @inheritdoc IBoxTickets
    function vault() public view returns (address) {
        return _argAddress(A.T_VAULT);
    }

    /// @inheritdoc IBoxTickets
    function collection() public view returns (address) {
        return _argAddress(A.T_COLLECTION);
    }

    /// @inheritdoc IBoxTickets
    function token() public view returns (address) {
        return _argAddress(A.T_TOKEN);
    }

    /// @inheritdoc IBoxTickets
    function source() public view returns (address) {
        return _argAddress(A.T_SOURCE);
    }

    /// @inheritdoc IBoxTickets
    function collectionSize() public view returns (uint256) {
        return _argUint(A.T_COLLECTION_SIZE, 4);
    }

    /// @inheritdoc IBoxTickets
    function firstId() public view returns (uint256) {
        return uint256(_argWord(A.T_FIRST_ID));
    }

    /// @inheritdoc IBoxTickets
    function name() public view returns (string memory) {
        return string(_argBytes(A.T_TEXT_BYTES, _argUint(A.T_TEXTS, 1)));
    }

    /// @inheritdoc IBoxTickets
    function symbol() external view returns (string memory) {
        return string(_argBytes(A.T_TEXT_BYTES + _argUint(A.T_TEXTS, 1), _argUint(A.T_TEXTS + 1, 1)));
    }

    /// @dev The placeholder's description (the add-on's param 3), fixed.
    function _description() private view returns (string memory) {
        uint256 start = A.T_TEXT_BYTES + _argUint(A.T_TEXTS, 1) + _argUint(A.T_TEXTS + 1, 1);
        return string(_argBytes(start, _argUint(A.T_TEXTS + 2, 2)));
    }

    /// @notice The same JSON for every live placeholder: the add-on's name and description, the collection's hidden
    /// picture (`IBoxCollection.hiddenSvg`) and one "Status: Placeholder" attribute (PlaceholderToken.sol:45-51).
    function tokenURI(uint256 tokenId) external view returns (string memory) {
        ownerOf(tokenId);
        bytes memory json = bytes(
            string.concat(
                '{"name":"',
                name(),
                '","description":"',
                _description(),
                '","image":"data:image/svg+xml;base64,',
                BoxEncoding.base64(bytes(IBoxCollection(collection()).hiddenSvg())),
                '","attributes":[{"trait_type":"Status","value":"Placeholder"}]}'
            )
        );
        return string.concat("data:application/json;base64,", BoxEncoding.base64(json));
    }

    // ------------------------------------------------------------------------------------------------------------
    // Internals (`:595-800`)

    function _vault() private view returns (IBoxVault) {
        return IBoxVault(vault());
    }

    function _token() private view returns (IBoxToken) {
        return IBoxToken(token());
    }

    /// @dev The word for key `key` from the source, with `bounty` for its round; returns the round.
    function _request(uint256 key, uint256 bounty) private returns (uint256) {
        return IDrandSource(source()).request{value: bounty}(key);
    }

    /// @dev The vault releases `count` tickets to `to` (a hand-back or a cancel).
    function _release(uint256 count, address to, uint256 minTokenOut) private returns (uint256, uint256) {
        return _vault().releaseTickets(count, to, minTokenOut);
    }

    /// @dev The block time in 40 bits.
    function _now() private view returns (uint40) {
        // casting to 'uint40' is safe because block timestamps stay below 2^40 for another 34,000 years
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint40(block.timestamp);
    }

    function _checkDeadline(uint256 deadline) private view {
        if (block.timestamp > deadline) revert DeadlineExpired(deadline, block.timestamp);
    }

    /// @dev The vault's quote for `count` tickets (it reverts as `openTickets` would), bounded by `maxTokenIn`.
    function _quote(uint256 count, uint256 maxTokenIn) private view returns (uint256 principal, uint256 fee) {
        (principal, fee) = _vault().quoteTake(count);
        if (principal + fee > maxTokenIn) revert MaxTokenExceeded(principal + fee, maxTokenIn);
    }

    /// @dev Pulls `total` from the caller to here, then the vault pulls it from here for `count` tickets. Same
    /// transaction, same state: the vault's amount equals the quote, so nothing stays here.
    function _lock(uint256 count, uint256 total) private {
        if (!_token().transferFrom(msg.sender, address(this), total)) revert TokenNotPulled();
        (uint256 principal, uint256 fee) = _vault().openTickets(count, total);
        if (principal + fee != total) revert TokenNotPulled(); // same state as the quote: never
    }

    /// @dev Frees `slot` of q live slots: the last slot's token moves into it. Returns q − 1.
    function _compact(uint256 slot, uint256 q) private returns (uint32) {
        uint256 last = q - 1;
        if (slot != last) {
            uint256 atLast = _slotToken[last];
            uint256 moved = atLast == 0 ? last + 1 : atLast;
            // casting to 'uint32' is safe because slot < q ≤ type(uint32).max
            // forge-lint: disable-next-line(unsafe-typecast)
            _tokens[moved].slot = uint32(slot);
            _slotToken[slot] = moved == slot + 1 ? 0 : moved;
            if (atLast != 0) delete _slotToken[last];
        } else if (_slotToken[last] != 0) {
            delete _slotToken[last];
        }
        // casting to 'uint32' is safe because last < q ≤ type(uint32).max
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint32(last);
    }

    /// @dev Settles draws in order from the head, at most `maxCount`, never past ticket `lastId`, stopping at the first
    /// whose word is not usable. The caller checked that the pool is live (word stored, or q = 0) and not terminal.
    function _settle(TicketState memory s, uint256 maxCount, uint256 lastId) private returns (uint256 settled) {
        Pool memory pool = _pool(s.slots);
        uint256 left = _left(s);
        while (settled < maxCount && s.drawsSettled < s.drawsRequested && s.drawsSettled < lastId && left != 0) {
            uint256 id = uint256(s.drawsSettled) + 1;
            Draw storage d = _draws[id];
            uint256 requestedAt = d.requestedAt;
            (bytes32 word,, bool usable) = _usableWord(id, requestedAt);
            if (!usable) break;
            uint256 offset = _offsetOf(pool, _takePosition(BoxShuffle.pickIndex(word, id, left), left, pool.slots));
            uint256 hoursTaken = (block.timestamp - requestedAt + 1 hours - 1) / 1 hours;
            d.status = DrawStatus.Settled;
            // casting is safe because offset < N ≤ type(uint32).max and hoursTaken is capped at type(uint16).max
            // forge-lint: disable-next-line(unsafe-typecast)
            d.offset = uint32(offset);
            // forge-lint: disable-next-line(unsafe-typecast)
            d.settleHours = uint16(hoursTaken > type(uint16).max ? type(uint16).max : hoursTaken);
            emit DrawSettled(id, pool.firstId + offset, word);
            unchecked {
                --left;
                ++s.drawsSettled;
                ++settled;
            }
        }
        if (settled != 0) _state = s;
    }

    /// @dev The shuffle's inputs for one settlement run (q, w, N and its Feistel halves, firstId).
    struct Pool {
        uint256 slots;
        bytes32 word;
        uint256 n;
        uint256 u;
        uint256 v;
        uint256 firstId;
    }

    function _pool(uint256 slots) private view returns (Pool memory p) {
        p.slots = slots;
        p.word = graduationWord;
        p.n = collectionSize();
        (p.u, p.v) = BoxShuffle.halves(p.n);
        p.firstId = firstId();
    }

    /// @dev The item placeholder slot `slot` opens into once the word is stored: firstId + π_w(slot).
    function _itemOfSlot(uint256 slot) private view returns (uint256) {
        Pool memory p = _pool(1);
        return p.firstId + _offsetOf(p, slot);
    }

    /// @dev Pool position → item offset: π_w(position), or the position itself when q = 0.
    function _offsetOf(Pool memory p, uint256 position) private pure returns (uint256) {
        return p.slots == 0 ? position : BoxShuffle.permute(p.word, position, p.n, p.u, p.v);
    }

    /// @dev Lazy Fisher-Yates: returns the position at `index` of the `left` remaining ones and moves the last into it.
    function _takePosition(uint256 index, uint256 left, uint256 slots) private returns (uint256 position) {
        uint256 atIndex = _swap[index];
        position = atIndex == 0 ? slots + index : atIndex - 1;
        uint256 last = left - 1;
        if (index != last) {
            uint256 atLast = _swap[last];
            _swap[index] = (atLast == 0 ? slots + last : atLast - 1) + 1;
            if (atLast != 0) delete _swap[last];
        } else if (atIndex != 0) {
            delete _swap[index];
        }
    }

    function _settledAt(Draw memory d) private pure returns (uint256) {
        return uint256(d.requestedAt) + uint256(d.settleHours) * 1 hours;
    }

    /// @dev R: the draw pool's undrawn positions.
    function _left(TicketState memory s) private view returns (uint256) {
        return collectionSize() - s.slots - s.drawsSettled;
    }

    /// @dev The position at pool index `index` (the lazy Fisher-Yates array).
    function _positionAt(uint256 index, uint256 slots) private view returns (uint256) {
        uint256 at = _swap[index];
        return at == 0 ? slots + index : at - 1;
    }

    /// @dev Item `itemId`'s position in the shuffle: π_w⁻¹(offset), or the offset itself when q = 0. `numbered` is
    /// false while placeholders wait for a word that has not been stored: then no number has been given at all.
    function _numberPosition(TicketState memory s, uint256 itemId)
        private
        view
        returns (bool numbered, uint256 position)
    {
        uint256 first = firstId();
        uint256 n = collectionSize();
        if (itemId < first || itemId - first >= n) revert IneligibleId(itemId);
        uint256 offset = itemId - first;
        if (s.slots != 0 && s.wordAcceptedAt == 0) return (false, 0);
        numbered = true;
        if (s.slots == 0) return (true, offset);
        (uint256 u, uint256 v) = BoxShuffle.halves(n);
        position = BoxShuffle.invert(graduationWord, offset, n, u, v);
    }

    /// @dev The vault hands item `id` to `to` for one ticket; then the reveal is posted unless it is revealed already.
    /// An empty proof: from `fallbackAt` and only if `mayFallback` (the holder, drawer or taker itself calls); it leaves
    /// unrevealed, returnable once revealed or after `RETURN_GRACE`. The collection's `reveal` reverts on any proof that
    /// does not verify.
    function _deliver(uint256 id, address to, ItemReveal calldata r, uint256 fallbackAt, bool mayFallback)
        private
        returns (bool revealed)
    {
        _vault().deliverTicket(id, to);
        IBoxCollection c = IBoxCollection(collection());
        if (c.isRevealed(id)) return true;
        if (r.proof.length == 0) {
            if (block.timestamp < fallbackAt || !mayFallback) revert RevealRequired(id, fallbackAt);
            _leftUnrevealedAt[id] = block.timestamp;
            return false;
        }
        c.reveal(id, r.traitsPacked, r.imageHash, r.avatarHash, r.modelHash, r.salt, r.proof);
        return true;
    }

    /// @dev True for an account with code other than an EIP-7702 delegation (23 bytes: 0xef0100 ‖ address), whose key
    /// holder can always move what it receives.
    function _hasContractCode(address a) private view returns (bool yes) {
        assembly ("memory-safe") {
            let size := extcodesize(a)
            extcodecopy(a, 0x00, 0, 3)
            yes := and(gt(size, 0), iszero(and(eq(size, 23), eq(shr(232, mload(0x00)), 0xef0100))))
        }
    }

    function _gateOpenedAt() private view returns (uint256) {
        return _vault().gateOpenedAt();
    }

    /// @dev The placeholder's era: known once the word is stored or terminal mode began; else curve, then frozen.
    function _era() internal view override returns (uint8) {
        TicketState memory s = _state;
        if (s.terminalAt != 0 || s.wordAcceptedAt != 0) return _ERA_KNOWN;
        return _gateOpenedAt() == 0 ? _ERA_CURVE : _ERA_FROZEN;
    }

    /// @dev Placeholders are never sent to the vault, the collection or T (F25 (3)).
    function _isSystem(address to) internal view override returns (bool) {
        return to == vault() || to == collection() || to == token();
    }

    function _requireLive() internal view override {
        if (openAt == 0) revert NotInitialised();
    }

    /// @dev The queue's head (`key` 0: the graduation word until stored, else the oldest unsettled draw), its deadline,
    /// and whether it is dead: past the deadline without a usable word (an unrequested word has none).
    function _head(TicketState memory s, uint256 gateAt)
        private
        view
        returns (bool exists, bool dead, uint256 key, uint256 deadline)
    {
        uint256 since;
        bool requested = true;
        if (s.slots != 0 && s.wordAcceptedAt == 0) {
            requested = s.wordRequestedAt != 0;
            since = s.wordRequestedAt;
            deadline = requested ? since + SILENCE : gateAt + SILENCE_UNREQUESTED;
        } else {
            if (s.drawsSettled == s.drawsRequested) return (false, false, 0, 0);
            key = uint256(s.drawsSettled) + 1;
            since = _draws[key].requestedAt;
            deadline = since + SILENCE;
        }
        exists = true;
        if (block.timestamp <= deadline) return (true, false, key, deadline);
        dead = true;
        if (requested) {
            (,, bool usable) = _usableWord(key, since);
            dead = !usable;
        }
    }

    /// @dev A word counts if it is non-zero and was ready no earlier than the request, no later than now and no later
    /// than `SILENCE` after the request.
    function _usableWord(uint256 key, uint256 requestedAt)
        private
        view
        returns (bytes32 word, uint256 readyAt, bool usable)
    {
        (word, readyAt) = _wordOf(key);
        usable = word != bytes32(0) && readyAt >= requestedAt && readyAt <= block.timestamp
            && readyAt <= requestedAt + SILENCE;
    }

    /// @dev `source.wordOf(this, key)` with `_WORD_GAS` and a 64-byte return copied at most: a source that reverts,
    /// burns its gas or answers short reads as "no word". A caller that leaves too little gas for the full read
    /// reverts `GasTooLow`, so the failure is always the source's own.
    function _wordOf(uint256 key) private view returns (bytes32 word, uint256 readyAt) {
        if (gasleft() < _WORD_GAS_REQUIRED) revert GasTooLow();
        address src = source();
        bytes4 selector = IDrandSource.wordOf.selector;
        bool ok;
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            mstore(ptr, selector)
            mstore(add(ptr, 4), address())
            mstore(add(ptr, 36), key)
            ok := staticcall(_WORD_GAS, src, ptr, 68, ptr, 64)
            if and(ok, gt(returndatasize(), 63)) {
                word := mload(ptr)
                readyAt := mload(add(ptr, 32))
            }
        }
        if (readyAt > type(uint64).max) return (bytes32(0), 0);
    }
}
