// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {BoxCollection} from "../../../src/box/BoxCollection.sol";
import {BoxCoordinator} from "../../../src/box/BoxCoordinator.sol";
import {BoxHook} from "../../../src/box/BoxHook.sol";
import {BoxItemStream} from "../../../src/box/BoxItemStream.sol";
import {BoxLayoutV1} from "../../../src/box/BoxLayoutV1.sol";
import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";
import {BoxTickets} from "../../../src/box/BoxTickets.sol";
import {BoxToken} from "../../../src/box/BoxToken.sol";
import {DrawStatus, ItemReveal} from "../../../src/box/interfaces/BoxTypes.sol";
import {IBoxCollection} from "../../../src/box/interfaces/IBoxCollection.sol";
import {IBoxItemStream} from "../../../src/box/interfaces/IBoxItemStream.sol";
import {IBoxTickets} from "../../../src/box/interfaces/IBoxTickets.sol";
import {IBoxVault} from "../../../src/box/interfaces/IBoxVault.sol";
import {BoxShuffle} from "../../../src/box/libraries/BoxShuffle.sol";
import {SepoliaBox0TestSet} from "../../../script/lib/SepoliaBox0TestSet.sol";
import {S0StateDiff} from "../../spikes/S0StateDiff.sol";
import {TransientReentrancyGuard} from "../../../src/libraries/TransientReentrancyGuard.sol";
import {OpenTime} from "../utils/OpenTime.sol";
import {BoxItemStreamGasBase} from "./BoxItemStreamGasBase.sol";

/// What `R1OneTransaction.openCaughtThenOpenDraw` saw, in the one call: the caught opening's revert data, the ticket in
/// flight and the stream's open draws right after the catch, the other draw's item and the ticket in flight after it.
struct CaughtThenOpened {
    bytes why;
    uint256 afterCatch;
    uint256 draws;
    uint256 drawIndexSum;
    uint256 item;
    uint256 afterOther;
}

/// @notice TEST ONLY. Calls box 0's tickets add-on more than once inside one call. Forge clears transient storage between
/// a test's own calls (each is its own transaction there), so only calls made inside one call share it, as the calls
/// of one transaction do on a chain. After each call it reads `ticketInFlight()` (by its selector, so the file builds
/// before IBoxTicketsInFlight exists). It can draw, hold placeholders and receive Misfits.
contract R1OneTransaction {
    BoxTickets internal immutable _tix;

    constructor(BoxTickets tix_) {
        _tix = tix_;
    }

    receive() external payable {}

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    function approve(address token) external {
        BoxToken(token).approve(address(_tix), type(uint256).max);
    }

    function draw() external returns (uint256) {
        return _tix.draw(type(uint256).max, block.timestamp);
    }

    function inFlight() public view returns (uint256) {
        (bool ok, bytes memory ret) = address(_tix).staticcall(abi.encodeWithSignature("ticketInFlight()"));
        require(ok && ret.length == 32, "the tickets add-on names the ticket in flight (IBoxTicketsInFlight)");
        return abi.decode(ret, (uint256));
    }

    /// Its own draw opened, then a placeholder it holds opened, in one transaction.
    function openDrawThenOpen(uint256 ticketId, uint256 tokenId)
        external
        returns (uint256 drawItem, uint256 afterDraw, uint256 placeholderItem, uint256 afterOpen)
    {
        ItemReveal memory none;
        drawItem = _tix.openDraw(ticketId, address(0), none);
        afterDraw = inFlight();
        placeholderItem = _tix.open(tokenId, none);
        afterOpen = inFlight();
    }

    /// Its own draw opened alone, without the reveal.
    function openDraw(uint256 ticketId) external returns (uint256) {
        ItemReveal memory none;
        return _tix.openDraw(ticketId, address(0), none);
    }

    /// A batch opener's way (SH-box0-r1 review round 2): its draw `caught` opened inside try/catch, which reverts after
    /// the vault's delivery and the stream's checkpoint (before its grace, no reveal: `RevealRequired`); the opener
    /// carries on and opens its draw `other` in the same transaction.
    function openCaughtThenOpenDraw(uint256 caught, uint256 other, IBoxItemStream stream)
        external
        returns (CaughtThenOpened memory r)
    {
        ItemReveal memory none;
        try _tix.openDraw(caught, address(0), none) returns (uint256) {
            revert("the caught opening must revert");
        } catch (bytes memory err) {
            r.why = err;
        }
        r.afterCatch = inFlight();
        (, r.draws, r.drawIndexSum) = stream.openTickets();
        r.item = _tix.openDraw(other, address(0), none);
        r.afterOther = inFlight();
    }

    /// A draw cancelled (anyone may, in terminal mode), then placeholders it holds handed back, in one transaction.
    function cancelThenHandBack(uint256 ticketId, uint256[] calldata tokens)
        external
        returns (uint256 afterCancel, uint256 afterHandBack)
    {
        _tix.cancelDraw(ticketId);
        afterCancel = inFlight();
        _tix.handBack(tokens, 0, block.timestamp);
        afterHandBack = inFlight();
    }

    /// The same, the hand-back first.
    function handBackThenCancel(uint256 ticketId, uint256[] calldata tokens)
        external
        returns (uint256 afterHandBack, uint256 afterCancel)
    {
        _tix.handBack(tokens, 0, block.timestamp);
        afterHandBack = inFlight();
        _tix.cancelDraw(ticketId);
        afterCancel = inFlight();
    }

    /// Lets the vault pull its T for a named pick.
    function approveVault(address token, address vault) external {
        BoxToken(token).approve(vault, type(uint256).max);
    }

    /// Both of the stream's transient sources in one transaction, terminal mode (SH-box0-r1 review round 3): a take by
    /// number of `itemId` (the stream's own exit mark), its own draw `drawA` opened and draw `drawB` cancelled (the
    /// tickets add-on's ticket in flight), in that order, or the reverse when `reversed`. Returns A's item and
    /// `ticketInFlight()` after each of the three calls, in call order.
    function takeOpenCancel(uint256 itemId, uint256 poolIndex, uint256 drawA, uint256 drawB, bool reversed)
        external
        returns (uint256 itemA, uint256[3] memory afterEach)
    {
        ItemReveal memory none;
        if (reversed) {
            _tix.cancelDraw(drawB);
            afterEach[0] = inFlight();
            itemA = _tix.openDraw(drawA, address(0), none);
            afterEach[1] = inFlight();
            _tix.takeByNumber(itemId, poolIndex, type(uint256).max, block.timestamp, none);
            afterEach[2] = inFlight();
        } else {
            _tix.takeByNumber(itemId, poolIndex, type(uint256).max, block.timestamp, none);
            afterEach[0] = inFlight();
            itemA = _tix.openDraw(drawA, address(0), none);
            afterEach[1] = inFlight();
            _tix.cancelDraw(drawB);
            afterEach[2] = inFlight();
        }
    }

    /// The same before terminal mode (SH-box0-r1 review round 3): a named pick of shelf item `id` (the stream's own exit
    /// mark, from the vault's `Withdrawn`), then its own draw `drawA` opened (the ticket in flight), or the reverse when
    /// `reversed`. Returns A's item and `ticketInFlight()` after each of the two calls, in call order.
    function pickAndOpenDraw(IBoxVault vault, uint256 id, uint256 drawA, bool reversed)
        external
        returns (uint256 itemA, uint256[2] memory afterEach)
    {
        ItemReveal memory none;
        if (reversed) {
            itemA = _tix.openDraw(drawA, address(0), none);
            afterEach[0] = inFlight();
            vault.withdraw(id, type(uint256).max, block.timestamp);
            afterEach[1] = inFlight();
        } else {
            vault.withdraw(id, type(uint256).max, block.timestamp);
            afterEach[0] = inFlight();
            itemA = _tix.openDraw(drawA, address(0), none);
            afterEach[1] = inFlight();
        }
    }
}

/// @notice TEST ONLY. A drawer whose `onERC721Received` acts while its own draw's item is being delivered, the ticket
/// still in flight (SH-box0-r1 review round 1, finding 5). Inside that window it reads `ticketInFlight()`, tries every
/// vault action that moves an item and every tickets action (each must revert `Reentrancy()`: BoxTickets and the vault
/// both hold their locks), then moves the new Misfit on and claims from the stream (the collection's lock is released
/// before the receiver hook, and the stream holds none there).
contract R1ReenteringDrawer {
    BoxTickets internal immutable _tix;
    IBoxVault internal immutable _vault;
    IBoxCollection internal immutable _col;
    IBoxItemStream internal immutable _stream;
    address internal immutable _next;
    uint256 internal _otherTicket;
    uint256 internal _placeholder;
    bool internal _armed;
    /// The ticket `ticketInFlight()` named inside the hook, and 0 read right after `openDraw` returned.
    uint256 public seenInFlight;
    uint256 public afterOpen;
    /// Actions refused with `Reentrancy()` inside the hook, and what the stream paid there.
    uint256 public refused;
    uint256 public claimed;

    constructor(BoxTickets tix_, IBoxVault vault_, IBoxCollection col_, IBoxItemStream stream_, address next_) {
        (_tix, _vault, _col, _stream, _next) = (tix_, vault_, col_, stream_, next_);
    }

    receive() external payable {}

    function approve(address token) external {
        BoxToken(token).approve(address(_tix), type(uint256).max);
        BoxToken(token).approve(address(_vault), type(uint256).max);
    }

    function draw() external returns (uint256) {
        return _tix.draw(type(uint256).max, block.timestamp);
    }

    /// Opens its own draw `ticketId`; the hook acts on the delivery, trying `otherTicket` (its other settled draw) and
    /// `placeholder` (a placeholder it holds) on the way.
    function openDrawReentering(uint256 ticketId, uint256 otherTicket, uint256 placeholder)
        external
        returns (uint256 item)
    {
        (_otherTicket, _placeholder, _armed) = (otherTicket, placeholder, true);
        ItemReveal memory none;
        item = _tix.openDraw(ticketId, address(0), none);
        require(!_armed, "the receiver hook ran");
        (bool ok, bytes memory ret) = address(_tix).staticcall(abi.encodeWithSignature("ticketInFlight()"));
        require(ok && ret.length == 32, "ticketInFlight()");
        afterOpen = abi.decode(ret, (uint256));
    }

    function onERC721Received(address, address, uint256 id, bytes calldata) external returns (bytes4) {
        if (!_armed) return this.onERC721Received.selector;
        _armed = false;
        (bool ok, bytes memory ret) = address(_tix).staticcall(abi.encodeWithSignature("ticketInFlight()"));
        require(ok && ret.length == 32, "ticketInFlight()");
        seenInFlight = abi.decode(ret, (uint256));
        uint256 deadline = block.timestamp;
        uint256[] memory one = new uint256[](1);
        one[0] = id;
        uint256[] memory tokens = new uint256[](1);
        tokens[0] = _placeholder;
        ItemReveal memory none;
        // The vault's item actions: its lock (deliverTicket's) refuses each before any check.
        _refused(address(_vault), abi.encodeCall(IBoxVault.withdraw, (id, type(uint256).max, deadline)));
        _refused(address(_vault), abi.encodeCall(IBoxVault.withdrawBatch, (one, type(uint256).max, deadline)));
        _refused(address(_vault), abi.encodeCall(IBoxVault.returnItem, (id, 0, deadline)));
        _refused(address(_vault), abi.encodeCall(IBoxVault.returnItems, (one, 0, deadline)));
        // The tickets add-on: its lock (openDraw's) refuses each.
        _refused(address(_tix), abi.encodeCall(BoxTickets.open, (_placeholder, none)));
        _refused(address(_tix), abi.encodeCall(BoxTickets.openDraw, (_otherTicket, address(0), none)));
        _refused(address(_tix), abi.encodeCall(BoxTickets.cancelDraw, (_otherTicket)));
        _refused(address(_tix), abi.encodeCall(BoxTickets.handBack, (tokens, 0, deadline)));
        _refused(address(_tix), abi.encodeCall(BoxTickets.draw, (type(uint256).max, deadline)));
        _refused(address(_tix), abi.encodeCall(BoxTickets.take, (1, type(uint256).max, deadline)));
        // The new Misfit moved on (the seller booked from the draw's request), then a claim.
        _col.transferFrom(address(this), _next, id);
        claimed = _stream.claim(new uint256[](0), address(this));
        return this.onERC721Received.selector;
    }

    function _refused(address target, bytes memory data) internal {
        (bool ok, bytes memory ret) = target.call(data);
        require(
            !ok && ret.length == 4 && bytes4(ret) == TransientReentrancyGuard.Reentrancy.selector,
            "refused with Reentrancy() while the ticket is in flight"
        );
        ++refused;
    }
}

/// @notice R1 (Codex architecture review 2026-10-07) on box 0 as factory v1 creates it: the real tickets add-on, vault,
/// collection and stream, real drand rounds. Draws requested at different J by different drawers earn exactly from their
/// own request: opened newest first and oldest first, one left waiting while others pass it, opened to an address the
/// drawer names, sold between the openings, cancelled in terminal mode with the word stored, and cancelled beside a
/// placeholder's hand-back in one transaction without it; a draw opened and then a placeholder opened in one transaction.
/// The tickets add-on names the ticket in flight only during that call into the vault: the one-transaction cases run
/// inside one call (R1OneTransaction), since forge clears transient storage between a test's own calls. Both of the
/// stream's transient sources in one transaction (review round 3): a take by number beside a draw's opening and another's
/// cancel in terminal mode, and a named pick beside a draw's opening before it, each in both orders. Then the gas of a
/// request, an opening, a cancel, a hand-back and a claim, from cold, today and under Glamsterdam (`R1GAS|` lines,
/// docs/evidence/SH-box0-r1.md).
/// forge-config: default.evm_version = "osaka"
contract BoxItemStreamExactDrawsBox0Test is BoxItemStreamGasBase {
    address internal frank = makeAddr("r1.box0.frank");
    address internal gina = makeAddr("r1.box0.gina");
    address internal hal = makeAddr("r1.box0.hal");

    /// Box 0 graduated on a real round (alice holds two placeholders), the word stored when `withWord`, three drawers
    /// funded and approved.
    function _graduated(bool withWord) internal {
        b.toWindow();
        OpenTime.to(BoxHook(a.hook).windowEndsAt());
        b.buy(alice, 1 ether, 0);
        _take(alice, 2);
        BoxLayoutV1.Curve memory c = b.curve();
        b.buy(carol, 3 * BoxCoordinator(a.coordinator).raise(), c.sqrtPriceLowerX96);
        vm.warp(src.roundTime(r0) - 12);
        vm.roll(block.number + 1);
        vm.prank(keeper);
        BoxCoordinator(a.coordinator).graduate();
        if (withWord) {
            vm.warp(src.roundTime(r0));
            src.postRound(r0, _localSig(0));
            tix.acceptGraduationWord();
        }
        address[3] memory drawers = [carol, frank, gina];
        for (uint256 i; i < 3; ++i) {
            b.buy(drawers[i], 0.5 ether, 0);
            vm.prank(drawers[i]);
            BoxToken(a.token).approve(a.tickets, type(uint256).max);
        }
        assertTrue(st.started());
    }

    /// A draw by `who` whose word is local round r0 + k; its ticket and the stream's J at the request.
    function _drawAt(address who, uint256 k) internal returns (uint256 t, uint256 j) {
        vm.warp(src.roundTime(r0 + k) - 12);
        vm.roll(block.number + 1);
        vm.prank(who);
        t = tix.draw(type(uint256).max, block.timestamp);
        j = st.index();
    }

    /// Three draws by carol, frank and gina at rising J (trades before and between them).
    function _threeDraws() internal returns (uint256[3] memory t, uint256[3] memory j) {
        _trade(2);
        (t[0], j[0]) = _drawAt(carol, 3);
        _trade(3);
        (t[1], j[1]) = _drawAt(frank, 6);
        _trade(3);
        (t[2], j[2]) = _drawAt(gina, 9);
        _trade(3);
        assertGt(j[1], j[0] + 1, "the requests' J differ");
        assertGt(j[2], j[1] + 1, "the requests' J differ");
        (, uint256 d, uint256 sum) = st.openTickets();
        assertEq(d, 3);
        assertEq(sum, j[0] + j[1] + j[2]);
    }

    /// The three rounds posted and every draw settled; past REVEAL_GRACE, so each drawer opens without the reveal.
    function _settleAll() internal {
        vm.warp(src.roundTime(r0 + 9));
        src.postRound(r0 + 3, _localSig(3));
        src.postRound(r0 + 6, _localSig(6));
        src.postRound(r0 + 9, _localSig(9));
        tix.settle(3);
        vm.warp(block.timestamp + 31 days);
        vm.roll(block.number + 31 * 7_200);
    }

    /// `ticketInFlight()` read by its selector (so the file builds before IBoxTicketsInFlight exists): it must answer, and
    /// 0 between transactions. (Forge clears transient storage between a test's own calls, so this read cannot show the
    /// slot cleared inside a transaction: R1OneTransaction's reads do.)
    function _inFlightOutside() internal view {
        (bool ok, bytes memory ret) = a.tickets.staticcall(abi.encodeWithSignature("ticketInFlight()"));
        assertTrue(ok && ret.length == 32, "the tickets add-on names the ticket in flight (IBoxTicketsInFlight)");
        assertEq(abi.decode(ret, (uint256)), 0, "no ticket in flight outside an opening's or a cancel's vault call");
    }

    function _open(address drawer, uint256 t, address to) internal returns (uint256 id, uint256 j) {
        ItemReveal memory none;
        j = st.index();
        vm.prank(drawer);
        id = tix.openDraw(t, to, none);
    }

    function _pending(uint256 id) internal view returns (address owner, uint256 amount) {
        return st.pendingOf(id);
    }

    // ------------------------------------------------------------------------------------------------ openings

    /// Newest first: each Misfit's record starts at its own ticket's request (the mean put all three at their mean),
    /// gina's opened to an address she names (hal).
    function test_BC065_box0DrawsEarnFromTheirOwnRequests_newestFirst() public {
        _graduated(true);
        (uint256[3] memory t, uint256[3] memory j) = _threeDraws();
        _settleAll();
        _trade(2);
        (uint256 i3, uint256 jo3) = _open(gina, t[2], hal);
        _assertSince(i3, hal, jo3, j[2], "ticket 3, opened to the address gina named: since its own request");
        _trade(2);
        (uint256 i2, uint256 jo2) = _open(frank, t[1], address(0));
        _assertSince(i2, frank, jo2, j[1], "ticket 2: since its own request");
        _trade(2);
        (uint256 i1, uint256 jo1) = _open(carol, t[0], address(0));
        _assertSince(i1, carol, jo1, j[0], "ticket 1: since its own request");
        _assertSince(i3, hal, jo1, j[2], "ticket 3 still since its own request");
        (, uint256 d, uint256 sum) = st.openTickets();
        assertEq(d, 0);
        assertEq(sum, 0, "every request's J left the sum");
        _inFlightOutside();
    }

    /// Oldest first, the first Misfit sold between the openings and alice's placeholder Misfit opened and sold while the
    /// draws waited: each seller is booked from the request (or the start) to the sale, each buyer from the sale.
    function test_BC065_box0DrawsEarnFromTheirOwnRequests_oldestFirstWithTransfers() public {
        _graduated(true);
        (uint256[3] memory t, uint256[3] memory j) = _threeDraws();
        _settleAll();
        uint256 ph;
        uint256 jp;
        {
            ItemReveal memory none;
            vm.prank(alice);
            ph = tix.open(1, none); // a placeholder's Misfit, while the draws wait
            _trade(2);
            jp = st.index();
            vm.prank(alice);
            BoxCollection(a.collection).transferFrom(alice, dave, ph);
            assertEq(st.owedOf(alice), jp, "alice: her placeholder's share from graduation to the sale");
        }
        (uint256 i1, uint256 jo1) = _open(carol, t[0], address(0));
        _assertSince(i1, carol, jo1, j[0], "ticket 1: since its own request");
        _trade(2);
        uint256 js = st.index();
        {
            uint256 carolBefore = st.owedOf(carol);
            vm.prank(carol);
            BoxCollection(a.collection).transferFrom(carol, erin, i1);
            assertEq(st.owedOf(carol) - carolBefore, js - j[0], "carol: from ticket 1's request to the sale");
        }
        _trade(2);
        (uint256 i2, uint256 jo2) = _open(frank, t[1], address(0));
        _assertSince(i2, frank, jo2, j[1], "ticket 2: since its own request");
        (uint256 i3, uint256 jo3) = _open(gina, t[2], address(0));
        _assertSince(i3, gina, jo3, j[2], "ticket 3: since its own request");
        _assertSince(i1, erin, jo3, js, "erin: from her purchase");
        _assertSince(ph, dave, jo3, jp, "dave: from his purchase");
        _inFlightOutside();
    }

    /// Item `id`'s record names `owner` and holds exactly J `now` − `since`.
    function _assertSince(uint256 id, address owner, uint256 now_, uint256 since, string memory what) internal view {
        (address o, uint256 p) = st.pendingOf(id);
        assertEq(o, owner, what);
        assertEq(p, now_ - since, what);
    }

    /// A draw left waiting (carol's, J at r0 + 3) while frank's and gina's are requested, settled and opened at once; then
    /// carol's opens: everyone exactly from their own request (the mean moved the waiting draw's accrual to the others).
    function test_R1_box0_staleDrawPassedByOthers() public {
        _graduated(true);
        (uint256 t1, uint256 j1) = _drawAt(carol, 3);
        _trade(3);
        (uint256 t2, uint256 j2) = _drawAt(frank, 6);
        vm.warp(src.roundTime(r0 + 6));
        src.postRound(r0 + 3, _localSig(3));
        src.postRound(r0 + 6, _localSig(6));
        tix.settle(2);
        vm.warp(block.timestamp + 31 days);
        vm.roll(block.number + 31 * 7_200);
        _trade(2);
        (uint256 i2, uint256 jo2) = _open(frank, t2, address(0));
        (, uint256 p2) = _pending(i2);
        assertEq(p2, jo2 - j2, "a passer: since its own request");
        _trade(3);
        (uint256 i1, uint256 jo1) = _open(carol, t1, address(0));
        (, uint256 p1) = _pending(i1);
        assertEq(p1, jo1 - j1, "the waiting draw: everything since its request");
        _inFlightOutside();
    }

    /// The tickets add-on names a draw only while its opening's delivery or its cancel's release is in the vault: read in
    /// the same transaction right after each (R1OneTransaction), it is 0 again, so no later vault call of that
    /// transaction (a hand-back, a placeholder's opening) can be taken for that draw. Its own draw opened, then a
    /// placeholder it holds opened, in one transaction: each Misfit starts where it should (the draw at its request,
    /// the placeholder's at graduation), with no checkpoint skipped.
    function test_R1_box0_ticketInFlightOnlyDuringTheVaultCall() public {
        _graduated(true);
        _inFlightOutside();
        R1OneTransaction one = new R1OneTransaction(tix);
        b.buy(address(one), 0.5 ether, 0);
        one.approve(a.token);
        vm.prank(alice);
        tix.transferFrom(alice, address(one), 1); // a placeholder, transferable once the word is stored
        _trade(2);
        vm.warp(src.roundTime(r0 + 3) - 12);
        vm.roll(block.number + 1);
        uint256 t = one.draw();
        uint256 jr = st.index();
        _inFlightOutside();
        _trade(3);
        vm.warp(src.roundTime(r0 + 3));
        src.postRound(r0 + 3, _localSig(3));
        tix.settle(1);
        vm.warp(block.timestamp + 31 days);
        vm.roll(block.number + 31 * 7_200);
        _trade(2);
        (uint256 pBefore,,) = st.openTickets();
        vm.recordLogs();
        (uint256 di, uint256 afterDraw, uint256 pi, uint256 afterOpen) = one.openDrawThenOpen(t, 1);
        _noCheckpointSkipped();
        uint256 j = st.index();
        assertEq(afterDraw, 0, "nothing in flight after openDraw, in the same transaction");
        assertEq(afterOpen, 0, "nothing in flight after open, in the same transaction");
        _assertSince(di, address(one), j, jr, "the draw's Misfit: since its own request");
        _assertSince(pi, address(one), j, 0, "the placeholder's Misfit: from graduation, not taken for the draw");
        (uint256 p, uint256 d,) = st.openTickets();
        assertEq(d, 0, "the draw left the open draws once");
        assertEq(p, pBefore - 1, "one open placeholder fewer");
        _inFlightOutside();
    }

    /// A drawer contract acting inside its own draw's delivery, the ticket in flight (R1ReenteringDrawer; SH-box0-r1
    /// review round 1, finding 5): it sees its ticket named; ten vault and tickets actions are refused with
    /// `Reentrancy()`; it moves the new Misfit on and claims. The seller is booked J now − J at its request once, the
    /// buyer starts now, the open draws lose exactly that ticket, nothing stays in flight and no checkpoint is skipped.
    function test_R1_box0_reenteringRecipientWhileItsTicketIsInFlight() public {
        _graduated(true);
        R1ReenteringDrawer one = new R1ReenteringDrawer(
            tix, IBoxVault(a.vault), IBoxCollection(a.collection), IBoxItemStream(a.itemStream), hal
        );
        b.buy(address(one), 0.5 ether, 0);
        one.approve(a.token);
        vm.prank(alice);
        tix.transferFrom(alice, address(one), 1); // a placeholder, transferable once the word is stored
        _trade(2);
        vm.warp(src.roundTime(r0 + 3) - 12);
        vm.roll(block.number + 1);
        uint256 t = one.draw();
        uint256 jr = st.index();
        _trade(3);
        vm.warp(src.roundTime(r0 + 6) - 12);
        vm.roll(block.number + 1);
        uint256 other = one.draw();
        uint256 jOther = st.index();
        _trade(3);
        vm.warp(src.roundTime(r0 + 6));
        src.postRound(r0 + 3, _localSig(3));
        src.postRound(r0 + 6, _localSig(6));
        tix.settle(2);
        vm.warp(block.timestamp + 31 days);
        vm.roll(block.number + 31 * 7_200);
        _fees();
        _collect(); // a batch: the stream holds the T its claim pays (J also counts T not yet collected)
        uint256 j = st.index();
        assertGt(j, jr + 1, "fees since the request");
        assertGe(BoxToken(a.token).balanceOf(a.itemStream), j - jr, "the stream holds what the seller will claim");
        (uint256 p0, uint256 d0, uint256 sum0) = st.openTickets();
        assertEq(d0, 2);
        assertEq(sum0, jr + jOther);
        vm.recordLogs();
        uint256 item = one.openDrawReentering(t, other, 1);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(st.index(), j, "J did not move in the call");
        assertEq(one.seenInFlight(), t, "the hook saw its own ticket in flight");
        assertEq(one.refused(), 10, "every vault and tickets action refused with Reentrancy()");
        assertEq(one.afterOpen(), 0, "nothing in flight after openDraw, in the same transaction");
        // The seller booked once, from its own request; paid all but the one raw unit the stream keeps (REV-01).
        uint256 credits;
        for (uint256 i; i < logs.length; ++i) {
            bytes32 t0 = logs[i].topics.length == 0 ? bytes32(0) : logs[i].topics[0];
            assertTrue(t0 != IBoxCollection.TransferObserverFailed.selector, "no transfer checkpoint skipped");
            assertTrue(t0 != IBoxVault.VaultObserverFailed.selector, "no vault checkpoint skipped");
            assertTrue(t0 != IBoxItemStream.TicketsCredited.selector, "no ticket credited");
            if (t0 == IBoxItemStream.Credited.selector && logs[i].emitter == a.itemStream) {
                ++credits;
                assertEq(logs[i].topics[1], bytes32(uint256(uint160(address(one)))), "the seller");
                assertEq(logs[i].topics[2], bytes32(item), "its Misfit");
                assertEq(abi.decode(logs[i].data, (uint256)), j - jr, "J now - J at its own request");
            }
        }
        assertEq(credits, 1, "booked once");
        assertEq(one.claimed(), j - jr - 1, "the claim inside the window paid it");
        assertEq(st.owedOf(address(one)), 1);
        assertEq(BoxCollection(a.collection).ownerOf(item), hal);
        _assertSince(item, hal, j, j, "the buyer: from now");
        (uint256 p1, uint256 d1, uint256 sum1) = st.openTickets();
        assertEq(d1, d0 - 1, "exactly its ticket left the open draws");
        assertEq(sum1, sum0 - jr, "with its own J at request");
        assertEq(p1, p0, "no placeholder taken for it");
        _inFlightOutside();
    }

    /// A revert between the slot's write and its clear, caught in the same transaction (SH-box0-r1 review round 2): a
    /// drawer contract opens its draw A before A's grace without the reveal inside try/catch. `openDraw` reverts
    /// `RevealRequired` after the vault's delivery and the stream's checkpoint took A. In the same call it opens its
    /// draw B (past B's grace). The revert rolls back BoxTickets' slot and the stream's open draws: nothing in flight
    /// after the catch, the open draws still hold A with its own J, B is booked from its own request. A, opened later by
    /// its drawer after its grace, is booked once, from its own request. No checkpoint skipped.
    function test_R1_box0_caughtRevertAfterTheStreamTookTheDraw() public {
        _graduated(true);
        R1OneTransaction one = new R1OneTransaction(tix);
        b.buy(address(one), 0.5 ether, 0);
        one.approve(a.token);
        // B (ticket 1) at r0 + 3, A (ticket 2) at r0 + 9: A's grace ends 18 seconds after B's.
        uint256[4] memory x = _twoDrawsBy(one); // tB, jB, tA, jA
        assertGt(
            tix.drawTicket(x[2]).revealFallbackAt, tix.drawTicket(x[0]).revealFallbackAt, "A's grace ends after B's"
        );
        vm.warp(tix.drawTicket(x[0]).revealFallbackAt);
        vm.roll(block.number + 30 * 7_200);
        _trade(2);
        (uint256 p0, uint256 d0, uint256 sum0) = st.openTickets();
        assertEq(d0, 2);
        assertEq(sum0, x[1] + x[3]);
        uint256 itemB = _caughtThenB(one, x);
        (uint256 p1, uint256 d1, uint256 sum1) = st.openTickets();
        assertEq(d1, 1, "only B left the open draws");
        assertEq(sum1, x[3], "A's own J at request stays");
        assertEq(p1, p0, "no placeholder taken");
        _openALater(one, x, itemB);
        (uint256 p2, uint256 d2, uint256 sum2) = st.openTickets();
        assertEq(d2, 0, "A left the open draws once");
        assertEq(sum2, 0, "both requests' J left the sum");
        assertEq(p2, p0);
        _inFlightOutside();
    }

    /// The one call: A's opening caught, then B's. Returns B's item.
    function _caughtThenB(R1OneTransaction one, uint256[4] memory x) internal returns (uint256 itemB) {
        IBoxTickets.DrawView memory va = tix.drawTicket(x[2]);
        vm.recordLogs();
        CaughtThenOpened memory r = one.openCaughtThenOpenDraw(x[2], x[0], IBoxItemStream(a.itemStream));
        _noCheckpointSkipped();
        assertEq(
            r.why,
            abi.encodeWithSelector(IBoxTickets.RevealRequired.selector, va.itemId, va.revealFallbackAt),
            "A's opening reverted RevealRequired (after the delivery)"
        );
        assertEq(r.afterCatch, 0, "nothing in flight after the caught revert, in the same transaction");
        assertEq(r.draws, 2, "after the catch the open draws still hold A");
        assertEq(r.drawIndexSum, x[1] + x[3], "with A's own J at request");
        assertEq(r.afterOther, 0, "nothing in flight after B's opening");
        itemB = r.item;
        _assertSince(itemB, address(one), st.index(), x[1], "B, opened in the same transaction: since its own request");
        _assertSince(va.itemId, address(0), 0, 0, "A's item has no record");
        assertEq(BoxCollection(a.collection).ownerOf(va.itemId), a.vault, "A's item still in the vault");
        assertEq(uint8(tix.drawTicket(x[2]).status), uint8(DrawStatus.Settled), "A still settled, not opened");
    }

    /// A, after its grace, by its drawer: booked once, from its own request (no ticket credited, no checkpoint skipped).
    function _openALater(R1OneTransaction one, uint256[4] memory x, uint256 itemB) internal {
        IBoxTickets.DrawView memory va = tix.drawTicket(x[2]);
        uint256 j = st.index();
        vm.warp(va.revealFallbackAt);
        vm.roll(block.number + 1);
        _trade(2);
        uint256 jo = st.index();
        assertGt(jo, j, "fees since B's opening");
        vm.recordLogs();
        assertEq(one.openDraw(x[2]), va.itemId);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            bytes32 t0 = logs[i].topics.length == 0 ? bytes32(0) : logs[i].topics[0];
            assertTrue(t0 != IBoxCollection.TransferObserverFailed.selector, "no transfer checkpoint skipped");
            assertTrue(t0 != IBoxVault.VaultObserverFailed.selector, "no vault checkpoint skipped");
            assertTrue(t0 != IBoxItemStream.TicketsCredited.selector, "no ticket credited");
        }
        _assertSince(va.itemId, address(one), jo, x[3], "A: since its own request");
        _assertSince(itemB, address(one), jo, x[1], "B: still since its own request");
    }

    /// Two draws by `one`, settled: B at r0 + 3 and A at r0 + 9, trades before, between and after. Returns tB, jB, tA,
    /// jA (each ticket and the stream's J at its request).
    function _twoDrawsBy(R1OneTransaction one) internal returns (uint256[4] memory x) {
        _trade(2);
        vm.warp(src.roundTime(r0 + 3) - 12);
        vm.roll(block.number + 1);
        x[0] = one.draw();
        x[1] = st.index();
        _trade(3);
        vm.warp(src.roundTime(r0 + 9) - 12);
        vm.roll(block.number + 1);
        x[2] = one.draw();
        x[3] = st.index();
        assertGt(x[3], x[1] + 1, "the requests' J differ");
        _trade(3);
        vm.warp(src.roundTime(r0 + 9));
        src.postRound(r0 + 3, _localSig(3));
        src.postRound(r0 + 9, _localSig(9));
        tix.settle(2);
        assertEq(uint8(tix.drawTicket(x[0]).status), uint8(DrawStatus.Settled));
        assertEq(uint8(tix.drawTicket(x[2]).status), uint8(DrawStatus.Settled));
    }

    /// Neither observer reported a failure in the recorded logs: every checkpoint was taken.
    function _noCheckpointSkipped() internal {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            bytes32 t0 = logs[i].topics.length == 0 ? bytes32(0) : logs[i].topics[0];
            assertTrue(t0 != IBoxCollection.TransferObserverFailed.selector, "no transfer checkpoint skipped");
            assertTrue(t0 != IBoxVault.VaultObserverFailed.selector, "no vault checkpoint skipped");
        }
    }

    // ------------------------------------------------------------------------------------------------ terminal mode

    /// The word stored, no draw word for SILENCE: three cancels, newest first, each booked to its drawer from its own
    /// request; nothing in flight before or after each.
    function test_BC065_box0CancelsEarnFromTheirOwnRequests() public {
        _graduated(true);
        (uint256[3] memory t, uint256[3] memory j) = _threeDraws();
        vm.warp(block.timestamp + 8 days);
        vm.roll(block.number + 8 * 7_200);
        tix.enterTerminal();
        address[3] memory drawers = [carol, frank, gina];
        for (uint256 k = 3; k > 0; --k) {
            _trade(2);
            uint256 jc = st.index();
            uint256 before = st.owedOf(drawers[k - 1]);
            tix.cancelDraw(t[k - 1]);
            assertEq(st.owedOf(drawers[k - 1]) - before, jc - j[k - 1], "a cancel: from its own request");
            _inFlightOutside();
        }
        (, uint256 d, uint256 sum) = st.openTickets();
        assertEq(d, 0);
        assertEq(sum, 0);
    }

    /// Without the word (it was never posted): a draw's cancel and a placeholder's hand-back in one transaction (inside
    /// one call, R1OneTransaction, which holds the placeholder), both orders. The hand-back is booked from graduation
    /// (J 0), the cancel from its request, nothing in flight after each; the tie-break that took a lone release for a
    /// placeholder while one was open is gone.
    function test_R1_box0_noWord_cancelAndHandBackInOneTransaction() public {
        for (uint256 order; order < 2; ++order) {
            uint256 snap = vm.snapshotState();
            _graduated(false);
            _trade(2);
            (uint256 t1, uint256 j1) = _drawAt(frank, 3);
            assertGt(j1, 0, "a request after fees");
            _trade(3);
            vm.warp(block.timestamp + 8 days);
            vm.roll(block.number + 8 * 7_200);
            tix.enterTerminal();
            R1OneTransaction one = new R1OneTransaction(tix);
            vm.prank(alice);
            tix.transferFrom(alice, address(one), 1); // transferable in terminal mode
            _trade(2);
            uint256 jc = st.index();
            uint256 frankBefore = st.owedOf(frank);
            uint256[] memory tokens = new uint256[](1);
            tokens[0] = 1;
            vm.recordLogs();
            (uint256 first, uint256 second) =
                order == 0 ? one.cancelThenHandBack(t1, tokens) : one.handBackThenCancel(t1, tokens);
            _noCheckpointSkipped();
            assertEq(first, 0, "nothing in flight after the first call, in the same transaction");
            assertEq(second, 0, "nothing in flight after the second");
            assertEq(st.owedOf(frank) - frankBefore, jc - j1, "the cancel: from its own request");
            assertEq(st.owedOf(address(one)), jc, "the hand-back: from graduation, not taken for the cancelled draw");
            (uint256 p, uint256 d,) = st.openTickets();
            assertEq(p, 1, "alice's other placeholder");
            assertEq(d, 0);
            _inFlightOutside();
            vm.revertToState(snap);
        }
    }

    // ------------------------------------------------------------------------------------------------ both transient sources

    /// The stream's own exit mark (`_EXITS`: a take by number's or a named pick's J and count) and the tickets add-on's
    /// ticket in flight, in one transaction (SH-box0-r1 review round 3). Terminal mode, the word stored, past
    /// TAKE_DELAY: a take by number, the drawer contract's draw A opened and frank's draw B cancelled, in one call; then
    /// the reverse order. The take's own delivery uses up its mark, so A's Misfit starts at A's own request and B's cancel
    /// books frank from B's own request; the taken item starts now. The open draws keep exactly gina's C (count and J
    /// sum). Nothing is in flight after each call; the one credit is B's cancel; no checkpoint is skipped.
    function test_R1_box0_takeByNumberBesideDrawsInOneTransaction() public {
        _graduated(true);
        R1OneTransaction one = new R1OneTransaction(tix);
        b.buy(address(one), 1 ether, 0);
        one.approve(a.token);
        uint256[6] memory x = _terminalDraws(one); // tA, jA, tB, jB, tC, jC
        (uint256 item, uint256 poolIndex) = _hiddenNumber();
        for (uint256 reversed; reversed < 2; ++reversed) {
            uint256 snap = vm.snapshotState();
            _takeOpenCancel(one, x, item, poolIndex, reversed == 1);
            vm.revertToState(snap);
        }
    }

    /// Before terminal mode: a named pick of a returned shelf item (the vault's `Withdrawn` sets the stream's exit mark)
    /// and the drawer contract's draw A opened, in one call; then the reverse order. Box 0 is created with the Sepolia
    /// test commitment, so the shelf item is revealed with public data (a named pick takes revealed items only). The
    /// picked item starts now, A's Misfit at A's own request; the open draws keep exactly frank's B. Nothing is in flight
    /// after each call; no credit; no checkpoint is skipped.
    function test_R1_box0_namedPickBesideADrawInOneTransaction() public {
        _withTestCommitment();
        _graduated(true);
        R1OneTransaction one = new R1OneTransaction(tix);
        b.buy(address(one), 1 ether, 0);
        one.approve(a.token);
        one.approveVault(a.token, a.vault);
        // A by `one` at r0 + 3, settled; B by frank at r0 + 6, never settled (its round is never posted).
        uint256[4] memory x; // tA, jA, tB, jB
        _trade(2);
        vm.warp(src.roundTime(r0 + 3) - 12);
        vm.roll(block.number + 1);
        x[0] = one.draw();
        x[1] = st.index();
        _trade(3);
        (x[2], x[3]) = _drawAt(frank, 6);
        _trade(3);
        vm.warp(src.roundTime(r0 + 6));
        src.postRound(r0 + 3, _localSig(3));
        assertEq(tix.settle(2), 1, "A settles; B's round never comes");
        uint256 shelf = _returnedShelfItem();
        vm.warp(tix.drawTicket(x[0]).revealFallbackAt);
        vm.roll(block.number + 30 * 7_200);
        _trade(2);
        assertGt(x[3], x[1] + 1, "the requests' J differ");
        assertGt(st.index(), x[3] + 1, "fees since the requests");
        assertEq(tix.status().terminalAt, 0, "before terminal mode");
        for (uint256 reversed; reversed < 2; ++reversed) {
            uint256 snap = vm.snapshotState();
            _pickAndOpen(one, x, shelf, reversed == 1);
            vm.revertToState(snap);
        }
    }

    /// One call of `takeOpenCancel` and what it must leave.
    function _takeOpenCancel(R1OneTransaction one, uint256[6] memory x, uint256 item, uint256 poolIndex, bool reversed)
        internal
    {
        (uint256 p0,,) = st.openTickets();
        uint256 frankBefore = st.owedOf(frank);
        uint256 j = st.index();
        vm.recordLogs();
        (uint256 itemA, uint256[3] memory afterEach) = one.takeOpenCancel(item, poolIndex, x[0], x[2], reversed);
        _creditsOnly(vm.getRecordedLogs(), 1, frank, j - x[3]);
        assertEq(st.index(), j, "J did not move in the call");
        for (uint256 k; k < 3; ++k) {
            assertEq(afterEach[k], 0, "nothing in flight after each call, in the same transaction");
        }
        assertEq(BoxCollection(a.collection).ownerOf(item), address(one), "the take by number");
        _assertSince(item, address(one), j, j, "the taken item: from now");
        _assertSince(itemA, address(one), j, x[1], "A's Misfit: from A's own request");
        assertEq(st.owedOf(frank) - frankBefore, j - x[3], "B's cancel: frank from B's own request");
        (uint256 p, uint256 d, uint256 sum) = st.openTickets();
        assertEq(d, 1, "only gina's C stays open");
        assertEq(sum, x[5], "with C's own J at request");
        assertEq(p, p0, "no placeholder taken");
        _inFlightOutside();
    }

    /// One call of `pickAndOpenDraw` and what it must leave.
    function _pickAndOpen(R1OneTransaction one, uint256[4] memory x, uint256 shelf, bool reversed) internal {
        (uint256 p0,,) = st.openTickets();
        uint256 j = st.index();
        vm.recordLogs();
        (uint256 itemA, uint256[2] memory afterEach) = one.pickAndOpenDraw(IBoxVault(a.vault), shelf, x[0], reversed);
        _creditsOnly(vm.getRecordedLogs(), 0, address(0), 0);
        assertEq(st.index(), j, "J did not move in the call");
        assertEq(afterEach[0], 0, "nothing in flight after the first call, in the same transaction");
        assertEq(afterEach[1], 0, "nothing in flight after the second");
        assertEq(BoxCollection(a.collection).ownerOf(shelf), address(one), "the named pick");
        _assertSince(shelf, address(one), j, j, "the picked item: from now");
        _assertSince(itemA, address(one), j, x[1], "A's Misfit: from A's own request");
        (uint256 p, uint256 d, uint256 sum) = st.openTickets();
        assertEq(d, 1, "only frank's B stays open");
        assertEq(sum, x[3], "with B's own J at request");
        assertEq(p, p0, "no placeholder taken");
        _inFlightOutside();
    }

    /// Draw A by `one` at r0 + 3, settled; frank's B at r0 + 6 and gina's C at r0 + 9, never settled (their rounds are
    /// never posted); trades before, between and after. Terminal mode from B's silence; then past A's grace (later than
    /// TAKE_DELAY), and two more trades. Returns tA, jA, tB, jB, tC, jC.
    function _terminalDraws(R1OneTransaction one) internal returns (uint256[6] memory x) {
        _trade(2);
        vm.warp(src.roundTime(r0 + 3) - 12);
        vm.roll(block.number + 1);
        x[0] = one.draw();
        x[1] = st.index();
        _trade(3);
        (x[2], x[3]) = _drawAt(frank, 6);
        _trade(3);
        (x[4], x[5]) = _drawAt(gina, 9);
        _trade(3);
        vm.warp(src.roundTime(r0 + 9));
        src.postRound(r0 + 3, _localSig(3));
        assertEq(tix.settle(3), 1, "A settles; B's and C's rounds never come");
        vm.warp(block.timestamp + 8 days);
        vm.roll(block.number + 8 * 7_200);
        tix.enterTerminal();
        uint256 graceA = tix.drawTicket(x[0]).revealFallbackAt;
        assertGt(graceA, uint256(tix.status().terminalAt) + tix.TAKE_DELAY(), "A's grace ends after TAKE_DELAY");
        vm.warp(graceA);
        vm.roll(block.number + 23 * 7_200);
        _trade(2);
        assertGt(x[3], x[1] + 1, "the requests' J differ");
        assertGt(x[5], x[3] + 1, "the requests' J differ");
        assertGt(st.index(), x[5] + 1, "fees since the requests");
        (, uint256 d, uint256 sum) = st.openTickets();
        assertEq(d, 3);
        assertEq(sum, x[1] + x[3] + x[5]);
    }

    /// A hidden item a take by number may name, with its pool index: index 0 of the draw pool and the item at its
    /// position (the graduation word's shuffle, as BoxTickets numbers items).
    function _hiddenNumber() internal view returns (uint256 item, uint256 poolIndex) {
        uint256 n = st.collectionSize();
        (uint256 u, uint256 v) = BoxShuffle.halves(n);
        poolIndex = 0;
        item = st.firstId() + BoxShuffle.permute(tix.graduationWord(), tix.poolPositionAt(poolIndex), n, u, v);
        assertTrue(IBoxVault(a.vault).isHidden(item), "a hidden item, still in the draw pool");
    }

    /// Box 0 created again by factory v1 from its fixture with one field changed: the reveal root is the Sepolia test
    /// commitment's (`SepoliaBox0TestSet`), so any item can be revealed from public data.
    function _withTestCommitment() internal {
        vm.revertToState(_beforeCreation);
        BoxSpecV1.BoxSpec memory s =
            abi.decode(vm.parseJsonBytes(vm.readFile(BOX_SPEC_VECTORS), ".columns.encoded[0]"), (BoxSpecV1.BoxSpec));
        s.revealRoot = SepoliaBox0TestSet.root();
        b.prepare(s);
        b.create();
        (a, impls) = (b.addresses(), b.impls());
        st = BoxItemStream(a.itemStream);
        tix = BoxTickets(a.tickets);
        assertEq(BoxCollection(a.collection).revealRoot(), SepoliaBox0TestSet.root(), "the test commitment");
        assertEq(st.firstId(), 1, "ids 1 to 4,269, as the test set's");
    }

    /// alice's first placeholder opened with its reveal (the test commitment's data and proof), then returned: a revealed
    /// shelf item, which a named pick may take.
    function _returnedShelfItem() internal returns (uint256 id) {
        id = tix.numberOf(1);
        SepoliaBox0TestSet.Entry memory e = SepoliaBox0TestSet.entry(id);
        ItemReveal memory r =
            ItemReveal(e.traitsPacked, e.imageHash, e.avatarHash, e.modelHash, e.salt, SepoliaBox0TestSet.proof(id));
        vm.prank(alice);
        assertEq(tix.open(1, r), id);
        assertTrue(BoxCollection(a.collection).isRevealed(id), "revealed on its way out");
        _trade(2);
        vm.startPrank(alice);
        BoxCollection(a.collection).setApprovalForAll(a.vault, true);
        IBoxVault(a.vault).returnItem(id, 0, block.timestamp);
        vm.stopPrank();
        assertTrue(IBoxVault(a.vault).isOnShelf(id), "on the shelf");
    }

    /// The recorded logs of one call: no checkpoint skipped, no holder booked (every item in the call left the vault),
    /// and exactly `credits` ticket credits, each to `account` for one ticket and `amount`.
    function _creditsOnly(Vm.Log[] memory logs, uint256 credits, address account, uint256 amount) internal pure {
        uint256 seen;
        for (uint256 i; i < logs.length; ++i) {
            bytes32 t0 = logs[i].topics.length == 0 ? bytes32(0) : logs[i].topics[0];
            assertTrue(t0 != IBoxCollection.TransferObserverFailed.selector, "no transfer checkpoint skipped");
            assertTrue(t0 != IBoxVault.VaultObserverFailed.selector, "no vault checkpoint skipped");
            assertTrue(t0 != IBoxItemStream.Credited.selector, "no holder booked");
            if (t0 != IBoxItemStream.TicketsCredited.selector) continue;
            ++seen;
            assertEq(logs[i].topics[1], bytes32(uint256(uint160(account))), "the cancelled draw's drawer");
            (uint256 count, uint256 booked) = abi.decode(logs[i].data, (uint256, uint256));
            assertEq(count, 1, "one ticket");
            assertEq(booked, amount, "J now - J at its own request");
        }
        assertEq(seen, credits, "ticket credits in the call");
    }

    // ------------------------------------------------------------------------------------------------ gas

    function test_R1_box0_gas_today() public {
        _userGas(false);
    }

    function test_R1_box0_gas_glamsterdam() public {
        _userGas(true);
    }

    /// Two requests (the first open draw, then one beside it), a cancel in terminal mode to a first-time earner, a
    /// placeholder's hand-back in terminal mode without the word, both openings by their drawers and a claim of a draw's
    /// Misfit, each from cold as its own transaction.
    function _userGas(bool g) internal {
        uint256 start = vm.snapshotState();
        _graduated(true);
        vm.warp(src.roundTime(r0 + 3) - 12);
        vm.roll(block.number + 1);
        _op("tickets.draw (a request, no other draw open)", g, carol, a.tickets, _drawCall());
        _trade(3);
        vm.warp(src.roundTime(r0 + 6) - 12);
        vm.roll(block.number + 1);
        _op("tickets.draw (a request, one other draw open)", g, frank, a.tickets, _drawCall());
        _trade(3);
        uint256 snap = vm.snapshotState();
        vm.warp(block.timestamp + 8 days);
        vm.roll(block.number + 8 * 7_200);
        tix.enterTerminal();
        _trade(1);
        _op(
            "tickets.cancelDraw (terminal, the drawer a first-time earner)",
            g,
            keeper,
            a.tickets,
            abi.encodeCall(BoxTickets.cancelDraw, (2))
        );
        vm.revertToState(snap);
        vm.warp(src.roundTime(r0 + 6));
        src.postRound(r0 + 3, _localSig(3));
        src.postRound(r0 + 6, _localSig(6));
        tix.settle(2);
        vm.warp(block.timestamp + 31 days);
        vm.roll(block.number + 31 * 7_200);
        _trade(2);
        ItemReveal memory none;
        _op(
            "tickets.openDraw by the drawer (the newer draw first, unrevealed after the grace)",
            g,
            frank,
            a.tickets,
            abi.encodeCall(BoxTickets.openDraw, (2, address(0), none))
        );
        _op(
            "tickets.openDraw by the drawer (the older draw)",
            g,
            carol,
            a.tickets,
            abi.encodeCall(BoxTickets.openDraw, (1, address(0), none))
        );
        _fees();
        _collect();
        _trade(1);
        uint256[] memory ids = new uint256[](1);
        ids[0] = tix.drawTicket(2).itemId;
        _op(
            "stream.claim, one Misfit (a draw's)",
            g,
            frank,
            a.itemStream,
            abi.encodeCall(IBoxItemStream.claim, (ids, frank))
        );
        vm.revertToState(start);
        // Terminal mode without the word: a placeholder handed back (the stream asks the tickets add-on what is in
        // flight: nothing, so a placeholder).
        _graduated(false);
        _drawAt(frank, 3);
        _trade(3);
        vm.warp(block.timestamp + 8 days);
        vm.roll(block.number + 8 * 7_200);
        tix.enterTerminal();
        _trade(1);
        uint256[] memory tokens = new uint256[](1);
        tokens[0] = 1;
        _op(
            "tickets.handBack, one placeholder (terminal, no word; alice a first-time earner)",
            g,
            alice,
            a.tickets,
            abi.encodeCall(BoxTickets.handBack, (tokens, 0, block.timestamp))
        );
        _op(
            "tickets.cancelDraw (terminal, no word; the drawer a first-time earner)",
            g,
            keeper,
            a.tickets,
            abi.encodeCall(BoxTickets.cancelDraw, (1))
        );
    }

    function _drawCall() internal view returns (bytes memory) {
        return abi.encodeCall(BoxTickets.draw, (type(uint256).max, block.timestamp));
    }

    function _op(string memory label, bool g, address who, address target, bytes memory data)
        internal
        returns (uint256 used)
    {
        _begin(g);
        vm.recordLogs();
        vm.prank(who);
        uint256 g0 = gasleft();
        (bool ok, bytes memory err) = target.call(data);
        used = g0 - gasleft();
        S0StateDiff.Counts memory c = S0StateDiff.count(vm.stopAndReturnStateDiff());
        vm.setEvmVersion("osaka");
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(err, 0x20), mload(err))
            }
        }
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            bytes32 t0 = logs[i].topics[0];
            assertTrue(t0 != IBoxCollection.TransferObserverFailed.selector, "no transfer checkpoint skipped");
            assertTrue(t0 != IBoxVault.VaultObserverFailed.selector, "no vault checkpoint skipped");
        }
        emit log_string(string.concat(
                "R1GAS|",
                label,
                g ? "|glamsterdam total " : "|today ",
                vm.toString(used),
                "|new slots ",
                vm.toString(c.newSlots),
                g ? string.concat("|of which state gas ", vm.toString(c.newSlots * STATE_GAS_PER_SLOT)) : ""
            ));
    }
}
