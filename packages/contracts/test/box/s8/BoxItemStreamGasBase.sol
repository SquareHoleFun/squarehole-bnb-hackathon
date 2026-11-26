// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxCollection} from "../../../src/box/BoxCollection.sol";
import {BoxCoordinator} from "../../../src/box/BoxCoordinator.sol";
import {BoxHook} from "../../../src/box/BoxHook.sol";
import {BoxItemStream} from "../../../src/box/BoxItemStream.sol";
import {BoxLayoutV1} from "../../../src/box/BoxLayoutV1.sol";
import {BoxReceiver} from "../../../src/box/BoxReceiver.sol";
import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";
import {BoxTickets} from "../../../src/box/BoxTickets.sol";
import {BoxToken} from "../../../src/box/BoxToken.sol";
import {BoxVault} from "../../../src/box/BoxVault.sol";
import {ItemReveal, VaultAction} from "../../../src/box/interfaces/BoxTypes.sol";
import {IBoxItemStream, IBoxTransferObserver, IBoxVaultObserver} from "../../../src/box/interfaces/IBoxItemStream.sol";
import {IBoxTicketsInFlight} from "../../../src/box/interfaces/IBoxTicketsInFlight.sol";
import {IDrandSource} from "../../../src/box/interfaces/IDrandSource.sol";
import {S0StateDiff} from "../../spikes/S0StateDiff.sol";
import {BoxDrandVectors} from "../randomness/utils/BoxDrandVectors.sol";
import {CoreBox0Kit, CoreBoxAddresses, CoreImpls} from "../conformance/core/CoreBox0Kit.sol";
import {OpenTime} from "../utils/OpenTime.sol";

/// @notice The world of S8's gas table (moved here from BoxItemStreamGas.t.sol unchanged, so the F87 ceiling tests in
/// Box0StreamCeiling.t.sol measure the same paths from the same state): box 0 built from the core v1 contracts with its
/// fixture spec (the stream on; created by factory v1 through `CoreBox0Kit`), a month into its life, and the method of
/// CoreBox0Gas / SH-S0-spikes § 2.4: every box account cooled first so each operation starts cold like its own
/// transaction, Glamsterdam as `vm.setEvmVersion("amsterdam")` (EIP-8037 state gas counted in `gasleft`), the slots
/// written from zero counted beside each figure.
///
/// - `_observerPaths` measures each capped call alone (BC-065): the stream's own frame, called as the collection, the
///   vault or the receiver would, from the same cold state, for every path: a delivery of a placeholder (the shuffle
///   check) and of a draw (a first exit: the item's record from zero; its ticket in flight, R1), the two first exits
///   that start now (a draw whose request the stream never saw; an exit no ticket and no mark explains), a transfer by a
///   first-time seller (its owed slot from zero) and a known one, a return by a first-time earner, the vault's four
///   actions (TicketsOpened a draw's request with its ticket's J written from zero, the worst since R1;
///   TicketsReleased in terminal mode to a first-time earner, a draw's cancel and a placeholder handed back) and the
///   receiver's notice with its burn. It returns the worst observer path and the notice, each the least forwarded gas
///   with which the call succeeds. Where the stream reads the ticket in flight (a draw's delivery, its cancel), the
///   view is mocked: forge clears transient storage between a test's calls, so the tickets add-on's slot cannot be set
///   for a frame measured alone. The view's own code, measured apart from cold (`_inFlightOwnCode`: the clone and its
///   implementation both cold), is added to those two figures; the hand-back path checks the sum (it reads the real
///   view, then a mocked one). The sum is within about one 64-gas step of a cold read inside the frame, not above it:
///   the hand-back check gives 3,462 / 3,097 (Glamsterdam / today) against 3,424 / 3,024 added, so +38 / +73
///   (SH-box0-r1 review round 2). A real `openDraw` or `cancelDraw` reads the view warm, about 5,000 lower.
abstract contract BoxItemStreamGasBase is BoxDrandVectors {
    uint256 internal constant STATE_GAS_PER_SLOT = 97_920;
    string internal constant BOX_SPEC_VECTORS = "test/vectors/box-spec/box-spec-v1.json";

    CoreBox0Kit internal b;
    CoreBoxAddresses internal a;
    CoreImpls internal impls;
    BoxItemStream internal st;
    BoxTickets internal tix;
    IDrandSource internal src;
    uint256 internal r0;
    uint256 internal observerCap;
    uint256 internal notifyCap;

    address internal alice = makeAddr("s8.gas.alice");
    address internal bob = makeAddr("s8.gas.bob");
    address internal carol = makeAddr("s8.gas.carol");
    address internal dave = makeAddr("s8.gas.dave");
    address internal erin = makeAddr("s8.gas.erin");
    address internal keeper = makeAddr("s8.gas.keeper");
    uint256 internal aliceItem;
    uint256 internal aliceSecond;
    uint256 internal bobToken;
    uint256 internal drawTicket;
    /// @dev The world before setUp's createBox (factory v1 creates box 0 once; `_addOnCost` creates it again from here).
    uint256 internal _beforeCreation;

    function setUp() public virtual {
        _loadBoxDrand();
        r0 = _localFirst();
        b = new CoreBox0Kit();
        b.setUpWorld();
        // Rounds are posted on the DrandSource; box 0 reads them through its BoxBackedSource (F143).
        src = IDrandSource(address(b.drand()));
        vm.warp(src.roundTime(r0) - 1 days);
        b.prepare(
            abi.decode(vm.parseJsonBytes(vm.readFile(BOX_SPEC_VECTORS), ".columns.encoded[0]"), (BoxSpecV1.BoxSpec))
        );
        _beforeCreation = vm.snapshotState();
        b.create();
        a = b.addresses();
        impls = b.impls();
        st = BoxItemStream(a.itemStream);
        tix = BoxTickets(a.tickets);
        observerCap = BoxCollection(a.collection).OBSERVER_GAS();
        notifyCap = BoxReceiver(payable(a.receiver)).STREAM_NOTIFY_GAS();
    }

    /// Box 0 a month after graduation: placeholders taken on the curve, the word stored, a draw settled, two Misfits
    /// opened (alice's, from her placeholders), trading and batches, so every record and global word exists.
    bool internal delayStart;

    function _life() internal {
        b.toWindow();
        OpenTime.to(BoxHook(a.hook).windowEndsAt());
        b.buy(alice, 1 ether, 0);
        b.buy(bob, 1 ether, 0);
        _take(alice, 3);
        _take(bob, 2);
        bobToken = 4;
        BoxLayoutV1.Curve memory c = b.curve();
        b.buy(carol, 3 * BoxCoordinator(a.coordinator).raise(), c.sqrtPriceLowerX96);
        vm.warp(src.roundTime(r0) - 12);
        vm.roll(block.number + 1);
        if (delayStart) vm.mockCallRevert(a.itemStream, abi.encodeCall(IBoxItemStream.onGraduation, ()), "");
        vm.prank(keeper);
        BoxCoordinator(a.coordinator).graduate();
        vm.clearMockedCalls();
        vm.warp(src.roundTime(r0));
        src.postRound(r0, _localSig(0));
        tix.acceptGraduationWord();
        _trade(3);
        b.buy(carol, 0.5 ether, 0);
        vm.startPrank(carol);
        BoxToken(a.token).approve(a.tickets, type(uint256).max);
        vm.warp(src.roundTime(r0 + 5) - 12);
        drawTicket = tix.draw(type(uint256).max, block.timestamp);
        vm.stopPrank();
        vm.warp(src.roundTime(r0 + 5));
        src.postRound(r0 + 5, _localSig(5));
        tix.settle(1);
        vm.warp(block.timestamp + 31 days);
        vm.roll(block.number + 31 * 7_200);
        ItemReveal memory none;
        vm.startPrank(alice);
        aliceItem = tix.open(1, none);
        aliceSecond = tix.open(2, none);
        vm.stopPrank();
        _trade(3);
        _collect();
        _trade(2);
        vm.prank(alice);
        BoxCollection(a.collection).setApprovalForAll(a.vault, true);
        assertEq(st.started(), !delayStart);
        assertGt(st.index(), 0, "the index moved");
    }

    function _take(address who, uint256 k) internal {
        vm.startPrank(who);
        BoxToken(a.token).approve(a.tickets, type(uint256).max);
        tix.take(k, type(uint256).max, block.timestamp);
        vm.stopPrank();
    }

    function _trade(uint256 k) internal {
        for (uint256 i; i < k; ++i) {
            vm.roll(block.number + 1);
            uint256 t = b.buy(dave, 0.3 ether, 0);
            b.sell(dave, t);
        }
    }

    function _collect() internal {
        try BoxReceiver(payable(a.receiver)).collect(keeper) {} catch {}
    }

    // ------------------------------------------------------------------------------------------------------------
    // The capped calls alone, every path

    /// Every observer path and the receiver's notice under one schedule (`g`: Glamsterdam), each under its cap; returns
    /// the worst observer path and the notice (the least forwarded gas with which each succeeds).
    function _observerPaths(bool g) internal returns (uint256 worst, uint256 notice) {
        _life();
        // A first exit, a placeholder's Misfit (the shuffle check; the item's record written from zero).
        uint256 phItem = _placeholderItem(bobToken);
        worst = _max(
            worst,
            _frame(
                "transfer observer: delivery of a placeholder's Misfit (first exit)",
                g,
                a.collection,
                abi.encodeCall(IBoxTransferObserver.onItemTransfer, (a.vault, bob, phItem))
            )
        );
        // A first exit, a draw's Misfit: from its own ticket's J at request (R1), the ticket the tickets add-on names in
        // flight during `openDraw`'s vault call (mocked, plus the view's own code).
        uint256 own = _inFlightOwnCode(g);
        _mockInFlight(drawTicket);
        worst = _max(
            worst,
            _withOwn(
                "transfer observer: delivery of a draw's Misfit (first exit, its ticket in flight)",
                g,
                own,
                _frame(
                    "transfer observer: delivery of a draw's Misfit (first exit, its ticket in flight; view mocked)",
                    g,
                    a.collection,
                    abi.encodeCall(
                        IBoxTransferObserver.onItemTransfer, (a.vault, carol, tix.drawTicket(drawTicket).itemId)
                    )
                )
            )
        );
        vm.clearMockedCalls();
        // The two "starts now" fallbacks of a first exit (SH-box0-r1 review round 1, finding 6). (a) A draw whose request
        // the stream never saw: its ticket in flight (mocked: an id without a record), so the item starts now.
        _mockInFlight(drawTicket + 1);
        worst = _max(
            worst,
            _withOwn(
                "transfer observer: delivery of a draw whose request the stream never saw (starts now)",
                g,
                own,
                _frame(
                    "transfer observer: delivery of a draw whose request the stream never saw (starts now; view mocked)",
                    g,
                    a.collection,
                    abi.encodeCall(
                        IBoxTransferObserver.onItemTransfer, (a.vault, carol, tix.drawTicket(drawTicket).itemId)
                    )
                )
            )
        );
        vm.clearMockedCalls();
        // (b) An exit no ticket and no mark explains (a draw's unopened item, nothing in flight): the real view, the
        // shuffle check, then the item starts now.
        worst = _max(
            worst,
            _frame(
                "transfer observer: an exit no ticket and no mark explains (the real view, the shuffle check; starts now)",
                g,
                a.collection,
                abi.encodeCall(IBoxTransferObserver.onItemTransfer, (a.vault, carol, tix.drawTicket(drawTicket).itemId))
            )
        );
        // A transfer by a first-time seller to a fresh holder (the seller's owed slot from zero).
        worst = _max(
            worst,
            _frame(
                "transfer observer: first-time seller to a fresh holder",
                g,
                a.collection,
                abi.encodeCall(IBoxTransferObserver.onItemTransfer, (alice, erin, aliceItem))
            )
        );
        // A known seller (owed slot exists).
        _asCollection(abi.encodeCall(IBoxTransferObserver.onItemTransfer, (alice, erin, aliceItem)));
        vm.roll(block.number + 1);
        worst = _max(
            worst,
            _frame(
                "transfer observer: known seller",
                g,
                a.collection,
                abi.encodeCall(IBoxTransferObserver.onItemTransfer, (alice, erin, aliceSecond))
            )
        );
        uint256 snap = vm.snapshotState();
        // A return by a first-time earner (erin; the record cleared).
        worst = _max(
            worst,
            _frame(
                "transfer observer: return by a first-time earner",
                g,
                a.collection,
                abi.encodeCall(IBoxTransferObserver.onItemTransfer, (erin, a.vault, aliceItem))
            )
        );
        vm.revertToState(snap);
        uint256 inside = BoxVault(a.vault).inside();
        worst = _max(
            worst,
            _frame(
                "vault observer: Withdrawn (a named pick)",
                g,
                a.vault,
                abi.encodeCall(IBoxVaultObserver.onVaultAction, (VaultAction.Withdrawn, dave, 1, inside))
            )
        );
        worst = _max(
            worst,
            _frame(
                "vault observer: Returned",
                g,
                a.vault,
                abi.encodeCall(IBoxVaultObserver.onVaultAction, (VaultAction.Returned, erin, 1, inside))
            )
        );
        // A draw's request: BoxTickets numbers the ticket (`++drawsRequested`) before its call to the vault, so the
        // stream keeps this J for a new ticket id, a slot written from zero (R1). Here `drawsRequested` is moved on in
        // the tickets' own storage (slot 5, bits 192-223) as the draw would, and the real `status()` is read, cold.
        snap = vm.snapshotState();
        vm.store(a.tickets, bytes32(uint256(5)), bytes32(uint256(vm.load(a.tickets, bytes32(uint256(5)))) + (1 << 192)));
        assertEq(tix.status().drawsRequested, drawTicket + 1, "a new ticket id");
        worst = _max(
            worst,
            _frame(
                "vault observer: TicketsOpened (a draw, its ticket's J from zero)",
                g,
                a.vault,
                abi.encodeCall(IBoxVaultObserver.onVaultAction, (VaultAction.TicketsOpened, a.tickets, 1, inside))
            )
        );
        vm.revertToState(snap);
        // Terminal mode: a draw's cancel, its ticket in flight (as above), booked from its own request to a first-time
        // earner (owed slot from zero). Until R1 this path read the tickets' `status()` instead (the real read since
        // SH-box0-stream-gas: 226,116 under Glamsterdam on main before R1, SH-box0-r1; 219,800 mocked before that).
        snap = vm.snapshotState();
        _mockInFlight(drawTicket);
        worst = _max(
            worst,
            _withOwn(
                "vault observer: TicketsReleased (terminal, a draw's cancel, its ticket in flight, a first-time earner)",
                g,
                own,
                _frame(
                    "vault observer: TicketsReleased (terminal, a draw's cancel, a first-time earner; view mocked)",
                    g,
                    a.vault,
                    abi.encodeCall(
                        IBoxVaultObserver.onVaultAction,
                        (VaultAction.TicketsReleased, makeAddr("s8.gas.new"), 1, inside)
                    )
                )
            )
        );
        vm.clearMockedCalls();
        vm.revertToState(snap);
        // Terminal mode without the word: a placeholder handed back (no ticket in flight, the real view read), booked
        // from graduation to a first-time earner. Then the same with the view mocked (answering 0): the difference is
        // the view's own code, the figure added to the two mocked paths above.
        snap = vm.snapshotState();
        bytes memory handBack = abi.encodeCall(
            IBoxVaultObserver.onVaultAction, (VaultAction.TicketsReleased, makeAddr("s8.gas.new"), 1, inside)
        );
        uint256 handBackReal = _frame(
            "vault observer: TicketsReleased (terminal, a placeholder handed back, a first-time earner)",
            g,
            a.vault,
            handBack
        );
        worst = _max(worst, handBackReal);
        _mockInFlight(0);
        uint256 handBackMocked = _frame(
            "vault observer: TicketsReleased (terminal, a placeholder handed back, a first-time earner; view mocked)",
            g,
            a.vault,
            handBack
        );
        vm.clearMockedCalls();
        vm.revertToState(snap);
        emit log_string(string.concat(
                "S8GAS|the view's own code on the hand-back path (real less mocked, to 64 gas)|",
                g ? "glamsterdam " : "today ",
                vm.toString(handBackReal - handBackMocked),
                "|measured apart ",
                vm.toString(own)
            ));
        assertApproxEqAbs(handBackReal - handBackMocked, own, 128, "the view's own code adds as measured apart");
        emit log_string(string.concat(
                "S8GAS|worst observer path|",
                g ? "glamsterdam needs " : "today needs ",
                vm.toString(worst),
                "|cap ",
                vm.toString(observerCap)
            ));
        assertLt(worst, observerCap, "every observer path under OBSERVER_GAS (BC-065)");
        // The receiver's notice with a burn (the items-inside share), against STREAM_NOTIFY_GAS.
        _fees();
        notice = _noticeFrame(g);
        emit log_string(string.concat(
                "S8GAS|receiver notice|",
                g ? "glamsterdam needs " : "today needs ",
                vm.toString(notice),
                "|cap ",
                vm.toString(notifyCap)
            ));
        assertLt(notice, notifyCap, "the notice under STREAM_NOTIFY_GAS");
    }

    /// The tickets add-on's `ticketInFlight()` answers `t` (mocked: the stream's frame measured alone).
    function _mockInFlight(uint256 t) internal {
        vm.mockCall(a.tickets, abi.encodeCall(IBoxTicketsInFlight.ticketInFlight, ()), abi.encode(t));
    }

    /// The tickets add-on's `ticketInFlight()` read for real and mocked: the same call from the same cold state (box
    /// 0's clone and its implementation). The difference is what the view's own code costs from cold (the delegate call
    /// to the implementation, its dispatch, the transient read), which the paths that mock it leave out (R1). Read
    /// inside a capped frame it costs a little more (the hand-back check: +38 / +73 gas, about one 64-gas step). In
    /// a real `openDraw` or `cancelDraw` both addresses are warm already (the tickets add-on made the call): less.
    function _inFlightOwnCode(bool g) internal returns (uint256 own) {
        uint256 real = _viewCall(g);
        _mockInFlight(0);
        uint256 mocked = _viewCall(g);
        vm.clearMockedCalls();
        own = real - mocked;
        emit log_string(string.concat(
                "S8GAS|the in-flight view's own code from cold, added where mocked|",
                g ? "glamsterdam " : "today ",
                vm.toString(own),
                "|real call ",
                vm.toString(real),
                "|mocked call ",
                vm.toString(mocked)
            ));
    }

    function _viewCall(bool g) internal returns (uint256 used) {
        uint256 snap = vm.snapshotState();
        vm.setEvmVersion(g ? "amsterdam" : "osaka");
        _coolAll();
        uint256 g0 = gasleft();
        uint256 t = IBoxTicketsInFlight(a.tickets).ticketInFlight();
        used = g0 - gasleft();
        vm.setEvmVersion("osaka");
        vm.revertToState(snap);
        assertEq(t, 0, "no ticket in flight between calls");
    }

    /// A path measured with the view mocked, plus the view's own code: the figure held against the cap.
    function _withOwn(string memory label, bool g, uint256 own, uint256 mocked) internal returns (uint256 needs) {
        needs = mocked + own;
        emit log_string(string.concat(
                "S8GAS|", label, g ? "|glamsterdam needs " : "|today needs ", vm.toString(needs), " (mocked + own code)"
            ));
    }

    /// The receiver's notice in its own frame after a batch landed: the stream burns the items-inside share.
    function _noticeFrame(bool g) internal returns (uint256 gasUsed) {
        // A batch arrives (redeemed to the stream) with the notice failing, so the T waits; then the notice alone.
        vm.mockCallRevert(a.itemStream, abi.encodeWithSelector(IBoxItemStream.onStreamFunds.selector), "");
        BoxReceiver(payable(a.receiver)).collect(keeper);
        vm.clearMockedCalls();
        (, uint256 burnedBefore) = st.totals();
        gasUsed = _frame(
            "receiver notice: onStreamFunds with its burn",
            g,
            a.receiver,
            abi.encodeCall(IBoxItemStream.onStreamFunds, (1))
        );
        (, uint256 burnedAfter) = st.totals();
        assertEq(burnedAfter, burnedBefore, "the frame ran in a snapshot");
    }

    function _fees() internal {
        for (uint256 i; i < 4; ++i) {
            vm.roll(block.number + 1);
            uint256 t = b.buy(dave, 1 ether, 0);
            b.sell(dave, t);
        }
    }

    /// One call to the stream as `caller` from a cold state, as its capped caller makes it (`call{gas: g}`): the least
    /// gas with which it succeeds (binary search to 64 gas; every try from the same cold snapshot), logged with the slots
    /// it writes from zero. That is the figure the cap must cover: the caller forwards exactly its cap.
    function _frame(string memory label, bool g, address caller, bytes memory data) internal returns (uint256 needs) {
        uint256 lo = 5_000;
        uint256 hi = 1_000_000;
        while (hi - lo > 64) {
            uint256 mid = (lo + hi) / 2;
            if (_tryWith(g, caller, data, mid)) hi = mid;
            else lo = mid;
        }
        needs = hi;
        uint256 snap = vm.snapshotState();
        _begin(g);
        vm.prank(caller);
        (bool ok,) = a.itemStream.call{gas: needs}(data);
        S0StateDiff.Counts memory c = S0StateDiff.count(vm.stopAndReturnStateDiff());
        vm.setEvmVersion("osaka");
        vm.revertToState(snap);
        assertTrue(ok, label);
        emit log_string(string.concat(
                "S8GAS|",
                label,
                g ? "|glamsterdam needs " : "|today needs ",
                vm.toString(needs),
                "|new slots ",
                vm.toString(c.newSlots),
                g ? string.concat("|of which state gas ", vm.toString(c.newSlots * STATE_GAS_PER_SLOT)) : ""
            ));
    }

    function _tryWith(bool g, address caller, bytes memory data, uint256 gasCap) internal returns (bool ok) {
        uint256 snap = vm.snapshotState();
        vm.setEvmVersion(g ? "amsterdam" : "osaka");
        _coolAll();
        vm.prank(caller);
        (ok,) = a.itemStream.call{gas: gasCap}(data);
        vm.setEvmVersion("osaka");
        vm.revertToState(snap);
    }

    function _asCollection(bytes memory data) internal {
        vm.prank(a.collection);
        (bool ok,) = a.itemStream.call(data);
        assertTrue(ok);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Helpers (CoreBox0Gas's method)

    function _placeholderItem(uint256 tokenId) internal view returns (uint256) {
        return tix.numberOf(tokenId);
    }

    function _max(uint256 x, uint256 y) internal pure returns (uint256) {
        return x > y ? x : y;
    }

    function _coolAll() internal {
        address[26] memory list = [
            a.coordinator,
            a.token,
            a.collection,
            a.vault,
            a.hook,
            a.receiver,
            a.launchRouter,
            a.tickets,
            a.royaltyRouter,
            a.executor,
            a.table,
            a.poolManager,
            a.randomness,
            a.weth,
            a.itemStream,
            address(b.swapper()),
            impls.coordinator,
            impls.hook,
            impls.hookExtension,
            impls.launchRouter,
            impls.receiver,
            impls.receiverExtension,
            impls.collection,
            impls.vault,
            impls.tickets,
            impls.itemStream
        ];
        for (uint256 i; i < list.length; ++i) {
            vm.cool(list[i]);
        }
        vm.cool(impls.royaltyRouter);
    }

    function _begin(bool g) internal {
        vm.setEvmVersion(g ? "amsterdam" : "osaka");
        _coolAll();
        vm.startStateDiffRecording();
    }

    function _line(string memory label, bool g, uint256 used, S0StateDiff.Counts memory c) internal {
        emit log_string(string.concat(
                "S8GAS|",
                label,
                g ? "|glamsterdam total " : "|today ",
                vm.toString(used),
                "|new slots ",
                vm.toString(c.newSlots),
                g ? string.concat("|of which state gas ", vm.toString(c.newSlots * STATE_GAS_PER_SLOT)) : ""
            ));
    }
}
