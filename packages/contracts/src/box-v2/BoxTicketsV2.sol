// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {TransientReentrancyGuard} from "../libraries/TransientReentrancyGuard.sol";
import {BoxCloneBase} from "../box/BoxCloneBase.sol";
import {BoxPlaceholderToken} from "../box/BoxPlaceholderToken.sol";
import {DrawStatus, ItemReveal, TicketPhase} from "../box/interfaces/BoxTypes.sol";
import {IBoxCollection} from "../box/interfaces/IBoxCollection.sol";
import {IBoxTickets} from "../box/interfaces/IBoxTickets.sol";
import {IBoxToken} from "../box/interfaces/IBoxToken.sol";
import {IDrandSource} from "../box/interfaces/IDrandSource.sol";
import {BoxClones} from "../box/libraries/BoxClones.sol";
import {BoxShuffle} from "../box/libraries/BoxShuffle.sol";
import {DrandWords} from "../box/randomness/DrandWords.sol";
import {GATE_CLOSED_OPEN_AT, IBoxCoordinatorV2, IBoxOpenGateV2} from "./interfaces/IBoxCoordinatorV2.sol";
import {IBoxTicketsV2, IBoxTicketsItemsV2} from "./interfaces/IBoxPeripheryV2.sol";
import {IBoxVaultV2, IBoxVaultItemsV2} from "./interfaces/IBoxVaultV2.sol";
import {BoxTicketsV2Views} from "./BoxTicketsV2Views.sol";
import {BoxTicketsV2Args as A} from "./libraries/BoxTicketsV2Args.sol";
import {IVaultFailureClock, VaultFailure} from "./libraries/VaultFailure.sol";

/// @title BoxTicketsV2 (core v2 M1, ticket M1-30-b; add-on 1 `placeholders`, the implementation of its per-box clone)
/// @notice v1's tickets add-on (`BoxTickets.sol`, copied, never edited; ADR-0017 § 10) with `IBoxTicketsV2`'s two
/// changes, and v1's rules otherwise (`BoxTickets.sol:19-53`: the curve, graduation and its word, draws settled in
/// request order, terminal mode, the safety net, payments through here, no T or ETH kept):
/// - **The open from the coordinator** (`IBoxOpenGateV2`; ADR-0017 § 6; BC-220, N14): at `initialize` the tickets read
///   the coordinator's gate: open, they take its `effectiveOpenAt()`; holding, they store `GATE_CLOSED_OPEN_AT`, so
///   `take()` reverts `NotOpenYet` for everyone, the creator right after the creator buy included, until the
///   coordinator's `setOpen(t)`, once. Never the spec's `openAt`, which v1 kept (`BoxTickets.sol:112-115`).
/// - **The request time at delivery** (`IBoxVaultV2.deliverTicket(id, to, requestedAt)`; BC-232): the vault hands it to
///   the item ledger as the item's exit. A draw's is its request (`Draw.requestedAt`); a take by number's is the take;
///   a placeholder's is the graduation time [P]: a placeholder keeps no time of its own (`Token` is v1's one slot), and
///   it holds a number only from graduation, when the takes close.
/// - **The placeholders' description loads with the texts** (ADR-0017 § 6; `ChunkPart.Texts`): `tokenURI` reads it
///   and the hidden SVG from the collection in one call (`placeholderTexts()`, one read of the part); the name and the
///   symbol stay clone arguments (`BoxTicketsV2Args`), since the ERC-721 views need them (review round 1, M3).
/// - **Failure (F114 R28B)**: fee-free hand-backs compact slots until the vault's 14-day window ends. Then the same
///   request/acceptGraduationWord entries use key 0 once to assign every kept slot with the graduation permutation.
///   Transfers freeze until acceptance or source-silence terminal mode; failure never enables new draws or numbered
///   takes. Terminal cancellations stay fee-free without expiry, as (e1); late words cannot undo terminal mode.
/// @dev Checks, effects, then interactions, under a transient lock taken by two calls (`nonReentrantCall`), as v1's.
/// An uninitialised clone (`openAt` 0) refuses `take` and `setApprovalForAll`. Written for Square Hole (MIT, no
/// third-party code).
contract BoxTicketsV2 is
    IBoxTicketsV2,
    IBoxTicketsItemsV2,
    TransientReentrancyGuard,
    BoxCloneBase,
    BoxPlaceholderToken
{
    /// @notice Preserve the existing ABI error, now bubbled by the stateless numbered-take check.
    error AlreadyFailed();

    /// @notice `setOpen` given 0 or `GATE_CLOSED_OPEN_AT`, which would leave the gate closed or the open unset (and
    /// `initialize` open again): change request 13, one name in `IBoxOpenGateV2` for the hook, the router and these.
    error OpenOutOfRange(uint256 openAt);

    /// @dev One slot. `settleHours`: request to settlement, rounded up, saturating (MisfitsPlaceholders.sol:105-112).
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
    /// @dev One key is sufficient for the frozen one-entry item batch. Cleared immediately after the vault call.
    bytes32 private constant _ITEM_CONTEXT = keccak256("squarehole.v2.tickets.itemContext");
    /// @dev Gas for one `wordOf` read (IDrandSource answers within 50,000), and the gas left that guarantees it all.
    uint256 private constant _WORD_GAS = 50_000;
    uint256 private constant _WORD_GAS_REQUIRED = _WORD_GAS + _WORD_GAS / 63 + 5_000;

    /// @inheritdoc IBoxTickets
    address public immutable coordinatorImplementation;
    /// @dev Fixed stateless metadata/shuffle code part; no funds move through it.
    BoxTicketsV2Views private immutable _views;

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
        _views = new BoxTicketsV2Views();
    }

    /// @inheritdoc IBoxTickets
    function initialize() external {
        // Only the box's coordinator, a clone of the version's coordinator code (BC-100; review of sh-core-v1).
        if (msg.sender != coordinator() || !BoxClones.isCloneOf(msg.sender, coordinatorImplementation)) {
            revert NotCoordinator(msg.sender);
        }
        if (openAt != 0) revert AlreadyInitialised();
        // The open as the coordinator's gate has it (`IBoxOpenGateV2`): its effective open, which is 0 while the gate
        // holds (`IBoxCoordinatorV2.effectiveOpenAt`), so closed until `setOpen`.
        uint256 open_ = IBoxCoordinatorV2(msg.sender).effectiveOpenAt();
        openAt = open_ == 0 ? GATE_CLOSED_OPEN_AT : open_;
        if (!_token().approve(vault(), type(uint256).max)) revert TokenNotPulled();
    }

    /// @inheritdoc IBoxOpenGateV2
    function setOpen(uint256 openAt_) external {
        if (msg.sender != coordinator()) revert NotCoordinator(msg.sender);
        if (openAt != GATE_CLOSED_OPEN_AT) revert OpenAlreadySet();
        if (openAt_ == 0 || openAt_ >= GATE_CLOSED_OPEN_AT) revert OpenOutOfRange(openAt_);
        openAt = openAt_;
        emit OpenSet(openAt_);
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
        TicketState memory s = _loadState();
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

        _lock(count, principal + fee, _KIND_PLACEHOLDER, firstTokenId);
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
        TicketState memory s = _loadState();
        uint256 failureEnd = _failureWindowEnds();
        bool curve;
        if (failureEnd != 0) {
            if (s.wordAcceptedAt != 0 || (s.terminalAt == 0 && block.timestamp >= failureEnd)) {
                revert VaultFailure.FailureWindowClosed(failureEnd);
            }
            curve = s.terminalAt == 0; // compact only before the failure window closes
        } else {
            curve = _gateOpenedAt() == 0;
            if (!curve && (s.terminalAt == 0 || s.wordAcceptedAt != 0)) revert HandBackClosed();
        }
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
        (principal, fee) = _release(k, msg.sender, minTokenOut, 0, tokenIds[0]);
        emit PlaceholdersHandedBack(msg.sender, k, principal, fee);
    }

    // ------------------------------------------------------------------------------------------------------------
    // The graduation word (`:298-342`)

    /// @inheritdoc IBoxTickets
    function requestGraduationWord() external payable nonReentrantCall {
        TicketState memory s = _loadState();
        uint256 at = _assignmentAt();
        if (at == 0) revert NotGraduated();
        if (block.timestamp < at) revert TooEarly(at);
        if (s.terminalAt != 0) revert TerminalMode();
        if (s.slots == 0) revert NoPlaceholders();
        if (s.wordRequestedAt != 0) revert WordAlreadyRequested();
        s.wordRequestedAt = _now();
        _state = s;
        emit GraduationWordRequested(msg.sender, _request(0, msg.value), msg.value);
    }

    /// @inheritdoc IBoxTickets
    function acceptGraduationWord() external nonReentrantCall {
        TicketState memory s = _loadState();
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
        TicketState memory s = _loadState();
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

        _lock(1, principal + fee, _KIND_DRAW, ticketId);
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
        TicketState memory s = _loadState();
        if (s.terminalAt != 0) revert TerminalMode();
        if (s.slots != 0 && s.wordAcceptedAt == 0) revert WordNotAccepted();
        settled = _settle(s, maxCount, type(uint256).max);
        if (settled == 0) revert NothingSettled();
    }

    // ------------------------------------------------------------------------------------------------------------
    // Opening (`:401-454`)

    /// @inheritdoc IBoxTickets
    function open(uint256 tokenId, ItemReveal calldata r) external nonReentrantCall returns (uint256 itemId) {
        TicketState memory s = _loadState();
        if (s.wordAcceptedAt == 0) revert WordNotAccepted();
        Token memory t = _tokenOf(tokenId);
        bool holder = msg.sender == t.owner;
        if (!holder && !_mayAct(t.owner, tokenId, _ERA_KNOWN)) revert NotAuthorized(msg.sender, tokenId);
        _burn(tokenId, t.owner);
        unchecked {
            --_balances[t.owner];
        }
        itemId = _itemOfSlot(t.slot);

        uint256 gateAt = _assignmentAt();
        _deliver(itemId, t.owner, gateAt, _KIND_PLACEHOLDER, tokenId);
        bool revealed = _reveal(itemId, r, uint256(s.wordAcceptedAt) + REVEAL_GRACE, holder);
        emit Opened(tokenId, _KIND_PLACEHOLDER, itemId, t.owner, revealed, gateAt);
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
            TicketState memory s = _loadState();
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

        _deliver(itemId, recipient, d.requestedAt, _KIND_DRAW, ticketId);
        bool revealed = _reveal(itemId, r, graceAt, drawer);
        emit Opened(ticketId, _KIND_DRAW, itemId, recipient, revealed, d.requestedAt);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Terminal mode (`:458-521`)

    /// @inheritdoc IBoxTickets
    function enterTerminal() external nonReentrantCall {
        TicketState memory s = _loadState();
        if (s.terminalAt != 0) revert AlreadyTerminal();
        uint256 gateAt = _assignmentAt();
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

        (principal,) = _release(1, drawer, 0, ticketId, ticketId);
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
        uint256 takeFrom = _views.checkNumber(address(this), itemId, poolIndex);
        (principal, fee) = _quote(1, maxTokenIn);

        _lock(1, principal + fee, 3, itemId);
        // The vault refuses (NotHidden) a shelf or outside item.
        _deliver(itemId, msg.sender, block.timestamp, 3, itemId);
        bool revealed = _reveal(itemId, r, takeFrom, true);
        emit TakenByNumber(msg.sender, itemId, principal, fee, revealed);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Views (`:525-591`)

    /// @inheritdoc IBoxTickets
    function phase() public view returns (TicketPhase) {
        return _views.phase(address(this));
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

    /// @inheritdoc IBoxTickets
    function coordinator() public view returns (address) {
        return _argAddress(A.COORDINATOR);
    }

    /// @inheritdoc IBoxTickets
    function vault() public view returns (address) {
        return _argAddress(A.VAULT);
    }

    /// @inheritdoc IBoxTickets
    function collection() public view returns (address) {
        return _argAddress(A.COLLECTION);
    }

    /// @inheritdoc IBoxTickets
    function token() public view returns (address) {
        return _argAddress(A.TOKEN);
    }

    /// @inheritdoc IBoxTickets
    function source() public view returns (address) {
        return _argAddress(A.SOURCE);
    }

    /// @inheritdoc IBoxTickets
    function collectionSize() public view returns (uint256) {
        return _argUint(A.COLLECTION_SIZE, 4);
    }

    /// @inheritdoc IBoxTickets
    function firstId() public view returns (uint256) {
        return uint256(_argWord(A.FIRST_ID));
    }

    /// @inheritdoc IBoxTickets
    function name() public view returns (string memory) {
        return string(_argBytes(A.TEXT_BYTES, _argUint(A.TEXTS, 1)));
    }

    /// @inheritdoc IBoxTickets
    function symbol() external view returns (string memory) {
        return string(_argBytes(A.TEXT_BYTES + _argUint(A.TEXTS, 1), _argUint(A.TEXTS + 1, 1)));
    }

    /// @dev The placeholder's description (the add-on's param 3), fixed.
    /// @notice The same JSON for every live placeholder: the add-on's name and description, the collection's hidden
    /// picture and one "Status: Placeholder" attribute (PlaceholderToken.sol:45-51); the description and the picture
    /// from the collection's `Texts` part (`placeholderTexts()`).
    function tokenURI(uint256 tokenId) external view returns (string memory) {
        ownerOf(tokenId);
        // Forward the helper's ABI string verbatim, avoiding a decode/re-encode of dynamic metadata here.
        address target = address(_views);
        bytes4 selector = BoxTicketsV2Views.tokenURI.selector;
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            mstore(ptr, selector)
            mstore(add(ptr, 4), address())
            let ok := staticcall(gas(), target, ptr, 36, 0, 0)
            returndatacopy(ptr, 0, returndatasize())
            if iszero(ok) { revert(ptr, returndatasize()) }
            return(ptr, returndatasize())
        }
    }

    // ------------------------------------------------------------------------------------------------------------
    // Internals (`:595-800`)

    /// @inheritdoc IBoxTicketsItemsV2
    function activeItemTicket(uint256 index) external view returns (bytes32 key) {
        if (index != 0) return bytes32(0);
        bytes32 slot = _ITEM_CONTEXT;
        assembly ("memory-safe") { key := tload(slot) }
    }

    /// @dev Only locked custody entries call this immediately around their vault call; never around payer pulls,
    /// randomness, refunds or reveal work. Role zero does not hash keys or access transient context storage.
    function _beginItemContext(uint8 domain, uint256 nativeId, uint256 count) private returns (bool) {
        if (_vault().itemLedger() == address(0)) return false;
        if (count > 1) revert IBoxVaultItemsV2.ItemBatchTooLarge(count, 1);
        bytes32 key = keccak256(abi.encode(address(this), domain, nativeId));
        bytes32 slot = _ITEM_CONTEXT;
        assembly ("memory-safe") { tstore(slot, key) }
        return true;
    }

    function _clearItemContext() private {
        bytes32 slot = _ITEM_CONTEXT;
        assembly ("memory-safe") { tstore(slot, 0) }
    }

    function _vault() private view returns (IBoxVaultV2) {
        return IBoxVaultV2(vault());
    }

    function _token() private view returns (IBoxToken) {
        return IBoxToken(token());
    }

    /// @dev The word for key `key` from the source, with `bounty` for its round; returns the round.
    function _request(uint256 key, uint256 bounty) private returns (uint256) {
        return IDrandSource(source()).request{value: bounty}(key);
    }

    /// @dev A draw cancellation carries its id; a placeholder hand-back carries 0, even with pending draws.
    function _release(uint256 count, address to, uint256 minTokenOut, uint256 ticketId, uint256 nativeId)
        private
        returns (uint256, uint256)
    {
        bool context = _beginItemContext(ticketId == 0 ? _KIND_PLACEHOLDER : _KIND_DRAW, nativeId, count);
        (uint256 principal, uint256 fee) = _vault().releaseTickets(count, to, minTokenOut, ticketId);
        if (context) _clearItemContext();
        return (principal, fee);
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
    function _lock(uint256 count, uint256 total, uint8 domain, uint256 nativeId) private {
        if (!_token().transferFrom(msg.sender, address(this), total)) revert TokenNotPulled();
        bool context = _beginItemContext(domain, nativeId, count);
        (uint256 principal, uint256 fee) = _vault().openTickets(count, total);
        if (context) _clearItemContext();
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

    /// @dev The shuffle's inputs for one settlement run (q, w, N, firstId).
    struct Pool {
        uint256 slots;
        bytes32 word;
        uint256 n;
        uint256 firstId;
    }

    function _pool(uint256 slots) private view returns (Pool memory p) {
        p.slots = slots;
        p.word = graduationWord;
        p.n = collectionSize();
        p.firstId = firstId();
    }

    /// @dev The item placeholder slot `slot` opens into once the word is stored: firstId + π_w(slot).
    function _itemOfSlot(uint256 slot) private view returns (uint256) {
        Pool memory p = _pool(1);
        return p.firstId + _offsetOf(p, slot);
    }

    /// @dev Pool position → item offset: π_w(position), or the position itself when q = 0.
    function _offsetOf(Pool memory p, uint256 position) private view returns (uint256) {
        return p.slots == 0 ? position : _views.permute(p.word, position, p.n);
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

    /// @dev Authenticated identity exists only during this vault call. The vault commits custody before callbacks.
    function _deliver(uint256 id, address to, uint256 requestedAt, uint8 domain, uint256 nativeId) private {
        bool context = _beginItemContext(domain, nativeId, 1);
        _vault().deliverTicket(id, to, requestedAt);
        if (context) _clearItemContext();
    }

    /// @dev Runs only after delivery and context clearing. A refused proof reverts delivery and journal together.
    /// An empty proof needs the existing holder/drawer permission and fallback time; unrevealed returns keep the grace.
    function _reveal(uint256 id, ItemReveal calldata r, uint256 fallbackAt, bool mayFallback)
        private
        returns (bool revealed)
    {
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

    function _failureWindowEnds() private view returns (uint256) {
        return IVaultFailureClock(vault()).failureWindowEnds();
    }

    /// @dev Failure uses the existing key-0 word, permutation, reveal grace and source-silence checks. Slots compact
    /// only during the 14-day window and are fixed before any request. No per-holder draw or new take is opened.
    function _assignmentAt() private view returns (uint256) {
        uint256 end = _failureWindowEnds();
        return end == 0 ? _gateOpenedAt() : end;
    }

    /// @dev The placeholder's era: known once the word is stored or terminal mode began; else curve, then frozen.
    function _era() internal view override returns (uint8) {
        TicketState memory s = _loadState();
        if (s.terminalAt != 0 || s.wordAcceptedAt != 0) return _ERA_KNOWN;
        uint256 at = _assignmentAt();
        return at == 0 || block.timestamp < at ? _ERA_CURVE : _ERA_FROZEN;
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

    /// @dev Decode the packed state once in runtime code; callers receive an independent memory snapshot.
    function _loadState() private view returns (TicketState memory) {
        return _state;
    }
}
