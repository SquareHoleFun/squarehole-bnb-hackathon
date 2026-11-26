// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {BoxItemStream} from "../../../src/box/BoxItemStream.sol";
import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";
import {BoxKind, VaultAction} from "../../../src/box/interfaces/BoxTypes.sol";
import {IBoxItemStream} from "../../../src/box/interfaces/IBoxItemStream.sol";
import {IBoxTickets} from "../../../src/box/interfaces/IBoxTickets.sol";
import {BoxCloneArgs} from "../../../src/box/libraries/BoxCloneArgs.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";
import {BoxShuffle} from "../../../src/box/libraries/BoxShuffle.sol";

/// @notice TEST ONLY. The stream with its pool read replaced by a value the test sets: U + R, the T fees on their
/// way (the real read is checked against the pool in BoxItemStreamLife.t.sol and BoxItemStreamPoolRead.t.sol).
contract BoxItemStreamHarness is BoxItemStream {
    uint256 public pendingOverride;

    constructor(address coordinatorImplementation_)
        BoxItemStream(IPoolManager(address(0)), coordinatorImplementation_)
    {}

    function setPending(uint256 pending) external {
        pendingOverride = pending;
    }

    function _pendingT() internal view override returns (uint256) {
        return pendingOverride;
    }
}

/// @notice TEST ONLY. A burnable T with the vault's floor as a switch (BoxToken's refusal, BC-016).
contract S8Token {
    mapping(address => uint256) public balanceOf;
    uint256 public totalSupply;
    bool public refuseBurns;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function setRefuseBurns(bool refuse) external {
        refuseBurns = refuse;
    }

    function burn(uint256 amount) external {
        require(!refuseBurns, "floor");
        balanceOf[msg.sender] -= amount;
        totalSupply -= amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @notice TEST ONLY. The coordinator implementation a stream names: its clones answer `graduated()` and initialise the
/// stream (only a clone of it may, BC-100).
contract S8CoordinatorImpl {
    bool public graduated;
    uint256 public streamStartBalance;
    uint256 public streamStartClaims;

    function recordGraduation(uint256 balance, uint256 claims) external {
        streamStartBalance = balance;
        streamStartClaims = claims;
        graduated = true;
    }

    function initStream(address stream) external {
        IBoxItemStream(stream).initialize();
    }

    function poke(address stream) external returns (bool ok) {
        (ok,) = stream.call(abi.encodeCall(IBoxItemStream.onGraduation, ()));
    }
}

/// @notice TEST ONLY. Box 0 around a stream, as the stream sees it: one contract plays the collection, the vault, the
/// tickets add-on, the receiver and the hook (their views and their calls into the stream, in the real contracts'
/// order: the vault's observer before n changes, then the collection's transfer observer per item). It moves no real
/// item: `ownerOf` is its own book. Ids are firstId … firstId + N − 1; the vault (this contract) holds what is inside.
contract S8World {
    BoxItemStreamHarness public stream;
    S8Token public token;
    address public coord;
    uint256 public immutable n;
    uint256 public immutable first;

    mapping(uint256 => address) internal _owner;
    uint256 public inside;
    uint256 public pendingTickets;
    uint64 public gateAt;
    IBoxTickets.TicketState internal _state;
    bytes32 public graduationWord;
    bool public settled;
    /// @notice Positions of the graduation word's shuffle a draw already took (≥ q).
    mapping(uint256 => bool) public positionTaken;
    uint256 public nextDrawPosition;
    uint256 public nextPlaceholderSlot;
    /// @notice BoxTickets' `ticketInFlight` (R1): the draw ticket whose item `openDraw` delivers, or which `cancelDraw`
    /// releases, set only while that call is in the vault (the stream reads it there), 0 at every other time.
    uint256 public ticketInFlight;
    /// @notice Draw tickets: 1 requested, 2 opened, 3 cancelled (BoxTickets' `DrawStatus`, shortened).
    mapping(uint256 => uint8) public ticketStatus;
    /// @notice The oldest ticket that may still be open (`openDraw(to)` opens the oldest open one).
    uint256 public oldestTicket = 1;

    constructor(uint256 n_, uint256 first_) {
        n = n_;
        first = first_;
        inside = n_;
        token = new S8Token();
        S8CoordinatorImpl ci = new S8CoordinatorImpl();
        coord = BoxClones.create(BoxClones.initCode(address(ci), ""));
        BoxItemStreamHarness impl = new BoxItemStreamHarness(address(ci));
        bytes memory args = BoxCloneArgs.stream(
            BoxCloneArgs.StreamArgs({
                coordinator: coord,
                token: address(token),
                collection: address(this),
                vault: address(this),
                tickets: address(this),
                receiver: address(this),
                hook: address(this),
                tickLower: -100,
                tickUpper: 100,
                // forge-lint: disable-next-line(unsafe-typecast)
                collectionSize: uint32(n_),
                firstId: first_
            })
        );
        stream = BoxItemStreamHarness(BoxClones.create(BoxClones.initCode(address(impl), args)));
    }

    /// @notice The coordinator's `launch` step for the stream (after construction: the stream reads this contract).
    function boot() external {
        S8CoordinatorImpl(coord).initStream(address(stream));
    }

    // ------------------------------------------------------------------------------------------------ views the stream reads

    function itemStream() external view returns (address) {
        return address(stream);
    }

    function kind() external pure returns (BoxKind) {
        return BoxKind.Box0;
    }

    function q() external pure returns (address) {
        return address(0);
    }

    function hook() external view returns (address) {
        return address(this);
    }

    function coordinator() external view returns (address) {
        return coord;
    }

    function transferObserver() external view returns (address) {
        return address(stream);
    }

    function observer() external view returns (address) {
        return address(stream);
    }

    function vault() external view returns (address) {
        return address(this);
    }

    function collection() external view returns (address) {
        return address(this);
    }

    function ticketAdapter() external view returns (address) {
        return address(this);
    }

    function collectionSize() external view returns (uint256) {
        return n;
    }

    function firstId() external view returns (uint256) {
        return first;
    }

    function curve() external pure returns (int24, int24, uint128) {
        return (-100, 100, 0);
    }

    function poolManager() external pure returns (address) {
        return address(0);
    }

    function gateOpenedAt() external view returns (uint256) {
        return gateAt;
    }

    function status() external view returns (IBoxTickets.TicketState memory) {
        return _state;
    }

    function streamCurveDepthT() external pure returns (uint256) {
        return 0; // this isolated stream world has no held depth ledger
    }

    function graduationSettled() external view returns (bool) {
        return settled;
    }

    function onGraduation() external {
        settled = true;
    }

    function ownerOf(uint256 id) public view returns (address) {
        require(id >= first && id < first + n, "id");
        address o = _owner[id];
        return o == address(0) ? address(this) : o;
    }

    // ------------------------------------------------------------------------------------------------ the box's life

    /// @notice Placeholders taken on the curve (the vault's TicketsOpened before n changes).
    function take(uint256 k) external {
        require(gateAt == 0, "curve");
        stream.onVaultAction(VaultAction.TicketsOpened, address(this), k, inside);
        inside -= k;
        pendingTickets += k;
        // forge-lint: disable-next-line(unsafe-typecast)
        _state.slots += uint32(k);
    }

    function handBackOnCurve(address holder, uint256 k) external {
        require(gateAt == 0, "curve");
        stream.onVaultAction(VaultAction.TicketsReleased, holder, k, inside);
        inside += k;
        pendingTickets -= k;
        // forge-lint: disable-next-line(unsafe-typecast)
        _state.slots -= uint32(k);
    }

    /// @notice Graduation: the gate, the receiver's settlement, the coordinator's poke of the stream.
    function graduate(bytes32 word) external {
        gateAt = uint64(block.timestamp);
        settled = true;
        graduationWord = word;
        // forge-lint: disable-next-line(unsafe-typecast)
        _state.wordAcceptedAt = uint40(block.timestamp);
        nextDrawPosition = _state.slots;
        S8CoordinatorImpl(coord).recordGraduation(token.balanceOf(address(stream)), stream.pendingOverride());
        require(S8CoordinatorImpl(coord).poke(address(stream)), "poke");
    }

    /// @notice The item placeholder slot `slot` opens into (BoxTickets `_itemOfSlot`).
    function placeholderItem(uint256 slot) public view returns (uint256) {
        (uint256 u, uint256 v) = BoxShuffle.halves(n);
        return first + BoxShuffle.permute(graduationWord, slot, n, u, v);
    }

    function drawItemAt(uint256 position) public view returns (uint256) {
        (uint256 u, uint256 v) = BoxShuffle.halves(n);
        return first + BoxShuffle.permute(graduationWord, position, n, u, v);
    }

    /// @notice A placeholder opened: its item delivered to `to` (no vault observer: n changed at the take).
    function openPlaceholder(address to) external returns (uint256 id) {
        id = placeholderItem(nextPlaceholderSlot++);
        _deliver(to, id);
    }

    /// @notice A draw requested (the vault's TicketsOpened after graduation). BoxTickets numbers the ticket before the
    /// vault's call (`draw`: `++drawsRequested`, then `_lock`), so `status().drawsRequested` names it during that call.
    function draw() external returns (uint256 ticketId) {
        ticketId = ++_state.drawsRequested;
        ticketStatus[ticketId] = 1;
        stream.onVaultAction(VaultAction.TicketsOpened, address(this), 1, inside);
        --inside;
        ++pendingTickets;
    }

    /// @notice A draw requested while the vault's capped call to the stream failed (fail-safe skip): numbered, its item
    /// counted out of the vault, the stream not told.
    function drawSkippingObserver() external returns (uint256 ticketId) {
        ticketId = ++_state.drawsRequested;
        ticketStatus[ticketId] = 1;
        --inside;
        ++pendingTickets;
    }

    /// @notice Draw `ticketId` opened while the collection's capped call to the stream failed (fail-safe skip): its item
    /// delivered to `to`, the stream not told (SH-box0-r1 review round 1, finding 10).
    function openDrawTicketSkippingObserver(uint256 ticketId, address to) external returns (uint256 id) {
        require(ticketStatus[ticketId] == 1, "not open");
        ticketStatus[ticketId] = 2;
        id = drawItemAt(nextDrawPosition++);
        require(_owner[id] == address(0), "left already");
        --pendingTickets;
        _owner[id] = to;
    }

    /// @notice The oldest open draw opened: the next free pool position's item delivered to `to`.
    function openDraw(address to) external returns (uint256 id) {
        while (ticketStatus[oldestTicket] != 1) {
            require(oldestTicket < _state.drawsRequested, "no open draw");
            ++oldestTicket;
        }
        return _openDraw(oldestTicket, to);
    }

    /// @notice Draw `ticketId` opened, in any order (BoxTickets `openDraw`): the next free pool position's item delivered
    /// to `to` with the ticket in flight.
    function openDrawTicket(uint256 ticketId, address to) external returns (uint256 id) {
        return _openDraw(ticketId, to);
    }

    function _openDraw(uint256 ticketId, address to) internal returns (uint256 id) {
        require(ticketStatus[ticketId] == 1, "not open");
        ticketStatus[ticketId] = 2;
        id = drawItemAt(nextDrawPosition++);
        ticketInFlight = ticketId;
        _deliver(to, id);
        ticketInFlight = 0;
    }

    function _deliver(address to, uint256 id) internal {
        require(_owner[id] == address(0), "left already");
        --pendingTickets;
        stream.onItemTransfer(address(this), to, id);
        _owner[id] = to;
    }

    /// @notice A named pick of `ids` (shelf items: ones that left and came back) by `to`.
    function withdraw(address to, uint256[] calldata ids) external {
        stream.onVaultAction(VaultAction.Withdrawn, to, ids.length, inside);
        inside -= ids.length;
        for (uint256 i; i < ids.length; ++i) {
            require(_owner[ids[i]] == address(0), "inside");
            stream.onItemTransfer(address(this), to, ids[i]);
            _owner[ids[i]] = to;
        }
    }

    /// @notice A named pick whose recipient's `onERC721Received` swaps between two deliveries (a fee of `f` lands after
    /// the vault's call and before the second item's transfer).
    function withdrawWithFeeBetween(address to, uint256[] calldata ids, uint256 f) external {
        stream.onVaultAction(VaultAction.Withdrawn, to, ids.length, inside);
        inside -= ids.length;
        for (uint256 i; i < ids.length; ++i) {
            stream.onItemTransfer(address(this), to, ids[i]);
            _owner[ids[i]] = to;
            if (i == 0) stream.setPending(stream.pendingOverride() + f);
        }
    }

    function returnItems(address from, uint256[] calldata ids) external {
        stream.onVaultAction(VaultAction.Returned, from, ids.length, inside);
        inside += ids.length;
        for (uint256 i; i < ids.length; ++i) {
            require(_owner[ids[i]] == from, "not theirs");
            stream.onItemTransfer(from, address(this), ids[i]);
            _owner[ids[i]] = address(0);
        }
    }

    function transfer(address from, address to, uint256 id) external {
        require(_owner[id] == from && from != address(0), "not theirs");
        require(to != address(this) && to != address(0), "to");
        stream.onItemTransfer(from, to, id);
        _owner[id] = to;
    }

    /// @notice A transfer the collection made while the observer failed (fail-safe skip).
    function transferSkippingObserver(address from, address to, uint256 id) external {
        require(_owner[id] == from, "not theirs");
        _owner[id] = to;
    }

    // ------------------------------------------------------------------------------------------------ terminal mode

    function enterTerminal(bool wordAccepted) external {
        // forge-lint: disable-next-line(unsafe-typecast)
        _state.terminalAt = uint40(block.timestamp);
        if (!wordAccepted) _state.wordAcceptedAt = 0;
    }

    /// @notice Tickets released with no draw in flight: placeholders handed back (BoxTickets `handBack`, on the curve
    /// or in terminal mode without the word).
    function releaseTickets(address to, uint256 k) external {
        stream.onVaultAction(VaultAction.TicketsReleased, to, k, inside);
        inside += k;
        pendingTickets -= k;
    }

    /// @notice A draw's cancel in terminal mode (BoxTickets `cancelDraw`): one ticket released to its drawer with the
    /// ticket in flight.
    function cancelDraw(uint256 ticketId, address drawer) external {
        require(_state.terminalAt != 0, "terminal");
        require(ticketStatus[ticketId] == 1, "not open");
        ticketStatus[ticketId] = 3;
        ticketInFlight = ticketId;
        stream.onVaultAction(VaultAction.TicketsReleased, drawer, 1, inside);
        ticketInFlight = 0;
        ++inside;
        --pendingTickets;
    }

    /// @notice A take by number in terminal mode: one ticket opened and its item delivered in the same transaction.
    function takeByNumber(address to, uint256 position) external returns (uint256 id) {
        stream.onVaultAction(VaultAction.TicketsOpened, address(this), 1, inside);
        --inside;
        id = drawItemAt(position);
        stream.onItemTransfer(address(this), to, id);
        _owner[id] = to;
    }

    // ------------------------------------------------------------------------------------------------ fees

    /// @notice A swap's T fee: U grows.
    function fee(uint256 amount) external {
        stream.setPending(stream.pendingOverride() + amount);
    }

    /// @notice The receiver's batch as box 0's after graduation: 13/15 of U + R (its carry included) to the stream and
    /// notified, the 2/15 to depth, the remainder carried. Returns what the stream got.
    function collect() external returns (uint256 sent) {
        uint256 total = stream.pendingOverride();
        uint256 unit = total / BoxSpecV1.FEE_SHARE_DENOMINATOR;
        sent = unit * BoxSpecV1.BOX0_FEE_SHARE_T_BURN;
        stream.setPending(total % BoxSpecV1.FEE_SHARE_DENOMINATOR);
        if (sent != 0) {
            token.mint(address(stream), sent);
            stream.onStreamFunds(sent);
        }
    }

    /// @notice T sent to the stream by anyone (a gift).
    function gift(uint256 amount) external {
        token.mint(address(stream), amount);
    }
}
