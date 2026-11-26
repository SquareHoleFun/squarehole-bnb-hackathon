// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {BoxCollection} from "../../../src/box/BoxCollection.sol";
import {BoxCoordinator} from "../../../src/box/BoxCoordinator.sol";
import {BoxHook} from "../../../src/box/BoxHook.sol";
import {BoxLayoutV1} from "../../../src/box/BoxLayoutV1.sol";
import {BoxReceiver} from "../../../src/box/BoxReceiver.sol";
import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";
import {BoxTickets} from "../../../src/box/BoxTickets.sol";
import {BoxToken} from "../../../src/box/BoxToken.sol";
import {BoxVault} from "../../../src/box/BoxVault.sol";
import {IBoxCollection} from "../../../src/box/interfaces/IBoxCollection.sol";
import {IBoxCoordinator} from "../../../src/box/interfaces/IBoxCoordinator.sol";
import {IBoxPriceAverage} from "../../../src/box/interfaces/IBoxHook.sol";
import {IBoxItemStream} from "../../../src/box/interfaces/IBoxItemStream.sol";
import {IBoxReceiver} from "../../../src/box/interfaces/IBoxReceiver.sol";
import {IBoxTickets} from "../../../src/box/interfaces/IBoxTickets.sol";
import {IBoxVault} from "../../../src/box/interfaces/IBoxVault.sol";
import {IVmFrameGas} from "../../../script/lib/CoreV1Deployment.sol";
import {S0StateDiff} from "../../spikes/S0StateDiff.sol";
import {OpenTime} from "../utils/OpenTime.sol";
import {BoxItemStreamGasBase} from "./BoxItemStreamGasBase.sol";

/// @notice Box 0's gas ceilings, on box 0 as factory v1 creates it with its stream (BoxItemStreamGasBase's world and
/// method: every account cooled first, Glamsterdam as `vm.setEvmVersion("amsterdam")`, EIP-8037 state gas in
/// `gasleft`). F87 (2026-10-05, the founder: "Raise it, better safe than sorry - not spent gas will be returned
/// anyways") raised the stream's observer ceiling; F90 (desk round 16) set the numbers: R16H "Raise to 460,000 (2x from
/// cold)" and R16I "Raise to 1,600,000 (2x after Glamsterdam)" for the coordinator's `POKE_GAS`, which F95 (desk round
/// 19) R19M raised again: "Raise to 2,600,000 (2x)", so the settlement of the box's first batch keeps 2x too.
///
/// - **The ceilings** (BC-065): `OBSERVER_GAS` 460,000 on the collection and the vault (250,000 before F87, 440,000 in
///   F87's first build), `STREAM_NOTIFY_GAS` 200,000 on the receiver (kept: a failed notice only delays a burn, while
///   its ceiling, not its use, comes out of the graduation poke's room), and BoxSpecV1's copies of both.
/// - **The headroom** (the design's rule for a capped call is at least twice the measured need, box-factory.md:283,
///   :325): every observer path (first exit of a placeholder's and a draw's Misfit, a first-time and a known seller, a
///   return, the vault's Withdrawn, Returned, TicketsOpened and TicketsReleased in terminal mode to a first-time
///   earner) and the receiver's notice with its burn, under both schedules, ratios logged. Held from cold: the worst
///   path at least 2x (F90 R16H; since F126 a draw's cancel, 225,108 under Glamsterdam, so 460,000 is 2.04x; SH-box0-r1),
///   the notice at least 1.60x (124,880 of 200,000).
/// - **A transfer needs the whole ceiling**: the least gas with which a Misfit `transferFrom` succeeds (a first-time
///   and a known seller), found to the unit; at that gas the stream's checkpoint is taken (no `TransferObserverFailed`,
///   the record names the new holder); one gas less reverts `ObserverGasTooLow` naming the collection's floor,
///   460,000 + 460,000 / 63 + 10,000 = 477,301 left at the call (so the floor sets the least, not the stream's use).
/// - **Each ceiling arrives whole** (EIP-150): with the stream's code a gas logger, at the least gas for a transfer, a
///   return (the vault's notice and the collection's), a take on the curve (the vault's notice alone) and a fee batch
///   (the receiver's notice), every capped call receives exactly its ceiling, and one gas less is refused naming the
///   floor (477,301; the receiver's 200,000 + 200,000 / 63 + 5,000 = 208,174).
/// - **Fail-safe** (BC-065 "a skip on failure"): a stream that reverts, burns all its gas or returns a large buffer
///   cannot block a transfer, a vault action or a fee batch; it costs a transfer at most its ceiling.
/// - **Graduation** (BC-065): the receiver's settlement (which notifies the stream when the curve's last fees hold T)
///   fits `POKE_GAS`, alone and when the stream's own poke runs it, with the margins logged; `graduate()` runs every
///   real poke without a `PokeFailed`.
/// - **`POKE_GAS`** (BC-098, F95 R19M): 2,600,000 on the coordinator and BoxSpecV1 (F90's 1,600,000 before); every
///   graduation poke of box 0 alone from cold (the receiver's settlement with its notice, with a batch before the
///   close and with the first batch final at graduation; the stream's poke running that settlement; the tickets' word
///   request; FIT's executor's sample; the stream's start) fits it under both schedules with at least 2x, the
///   settlement of the box's first batch after Glamsterdam included (at 1,600,000 it had 1.30x and 1.24x);
///   `graduate()`'s least gas, to the unit, runs every poke (one gas less reverts `GasTooLow` naming 2,600,000 +
///   2,600,000 / 63 + 10,000 = 2,651,269), and its execution gas, at that least and with every poke burning its whole
///   budget (graduation still succeeds), stays under EIP-7825's 16,777,216 per transaction; so does a successful
///   transaction with all four pokes exhausting their budgets.
///   With every poke's target a gas logger, each of the four pokes receives exactly 2,600,000 at `graduate()`'s least
///   gas (the CALL's own budget, not only the getter and the floor; SH-box0-stream-gas's F90 review).
/// Lines: `F95|...` (`F90|...` before F95), collected in docs/evidence/SH-box0-stream-gas.md.
/// forge-config: default.evm_version = "osaka"
contract Box0StreamCeilingTest is BoxItemStreamGasBase {
    /// @dev F90 R16H: "Raise to 460,000 (2x from cold)" (F87's first build 440,000; S3's 250,000 before).
    uint256 internal constant F90_OBSERVER_GAS = 460_000;
    /// @dev The receiver's notice: S8's 200,000, kept (SH-box0-stream-gas § The notice).
    uint256 internal constant STREAM_NOTIFY_GAS_KEPT = 200_000;
    /// @dev F95 R19M: "Raise to 2,600,000 (2x)" (F90 R16I's 1,600,000 before; S6's 1,000,000 before that).
    uint256 internal constant F95_POKE_GAS = 2_600_000;
    /// @dev The collection's and the vault's floor at the observer call: the cap, the 1/64 EIP-150 keeps, and 10,000 for
    /// the call's own cost (5,000 before SH-box0-stream-gas's review; the collection's cold call itself about 3,050
    /// today and 3,450 after Glamsterdam at F90, from a 3,000-margin mutant; F87's margin-0 mutant gave 2,978-3,378).
    uint256 internal constant OBSERVER_FLOOR = F90_OBSERVER_GAS + F90_OBSERVER_GAS / 63 + 10_000;
    /// @dev The receiver's floor at the notice (unchanged since S8).
    uint256 internal constant NOTICE_FLOOR = STREAM_NOTIFY_GAS_KEPT + STREAM_NOTIFY_GAS_KEPT / 63 + 5_000;
    /// @dev The coordinator's floor at each poke (BoxCoordinator `_POKE_GAS_REQUIRED`).
    uint256 internal constant POKE_FLOOR = F95_POKE_GAS + F95_POKE_GAS / 63 + 10_000;
    /// @dev The headroom held, in basis points of the need: 2x for the worst observer path from cold (F90 R16H) and for
    /// every graduation poke under both schedules (F95 R19M), the receiver's settlement when its batch is the box's
    /// first included (no fee batch before the close; seven slots written from zero: 1,235,026 from cold after
    /// Glamsterdam, 1,285,607 inside the stream's poke, which F90's 1,600,000 held only 1.2955x and 1.2445x); 1.60x for
    /// the notice (S8's 200,000, kept).
    uint256 internal constant OBSERVER_HEADROOM_BPS = 20_000;
    uint256 internal constant POKE_HEADROOM_BPS = 20_000;
    uint256 internal constant NOTICE_HEADROOM_BPS = 16_000;
    uint256 internal constant GENEROUS = 5_000_000;
    /// @dev EIP-7825's gas cap per transaction; after Glamsterdam it binds only the execution gas (EIP-8037's state gas
    /// is paid apart from it).
    uint256 internal constant TX_GAS_CAP = 16_777_216;

    /// Code put at the stream's address to make it misbehave (`vm.etch`).
    bytes internal constant STOP = hex"00";
    bytes internal constant REVERTS = hex"60006000fd"; // revert(0, 0)
    bytes internal constant BURNS_ALL = hex"5b600056"; // jumpdest; jump(0): loops until its gas is gone
    bytes internal constant RETURNS_64K = hex"620100006000f3"; // return(0, 65536)
    /// GAS; PUSH1 0; MSTORE; PUSH1 32; PUSH1 0; LOG0; STOP: logs the gas left after GAS (what it was given, less 2).
    bytes internal constant GAS_LOGGER = hex"5a60005260206000a000";

    /// One call's outcome, read inside its snapshot: success, the revert data, the fail-safe reports in its logs, and
    /// the state after it (the item's holder and the stream's record of it; the receiver settled, the stream started).
    struct Try {
        bool ok;
        bytes4 err;
        bytes errData;
        bool skipped;
        bool vaultSkipped;
        bool funded;
        bool noticeFailed;
        bool pokeFailed;
        bool requested;
        address holder;
        address recorded;
        bool settled;
        bool started;
    }

    /// The least gas for a transfer and the outcomes at it and at one gas less.
    struct Least {
        uint256 gas;
        Try at;
        Try below;
    }

    /// One call with the gas logger at the stream's address: success, the revert data, and the gas each capped call
    /// gave the stream (the logged values plus 2), in order.
    struct Probe {
        bool ok;
        bytes errData;
        uint256[] given;
    }

    // ------------------------------------------------------------------------------------------------------------
    // The ceilings

    function test_BC065_box0StreamCeilingsAreF90s() public view {
        assertEq(BoxCollection(impls.collection).OBSERVER_GAS(), F90_OBSERVER_GAS, "the collection's ceiling");
        assertEq(IBoxCollection(a.collection).observerGas(), F90_OBSERVER_GAS, "box 0's collection reads it");
        assertEq(BoxVault(impls.vault).OBSERVER_GAS(), F90_OBSERVER_GAS, "the vault's ceiling");
        assertEq(IBoxVault(a.vault).observerGas(), F90_OBSERVER_GAS, "box 0's vault reads it");
        assertEq(
            BoxReceiver(payable(impls.receiver)).STREAM_NOTIFY_GAS(), STREAM_NOTIFY_GAS_KEPT, "the receiver's notice"
        );
        assertEq(BoxReceiver(payable(a.receiver)).STREAM_NOTIFY_GAS(), STREAM_NOTIFY_GAS_KEPT, "box 0's receiver");
        assertEq(BoxSpecV1.ADD_ON_PER_ITEM_STREAM_OBSERVER_GAS, F90_OBSERVER_GAS, "BoxSpecV1's observer ceiling");
        assertEq(BoxSpecV1.STREAM_NOTIFY_GAS, STREAM_NOTIFY_GAS_KEPT, "BoxSpecV1's notice ceiling");
        assertEq(observerCap, F90_OBSERVER_GAS);
        assertEq(notifyCap, STREAM_NOTIFY_GAS_KEPT);
    }

    /// F95 R19M: every graduation poke gets 2,600,000 (the implementation, box 0's clone and BoxSpecV1's copy).
    function test_BC098_box0PokeGasIsF95s() public view {
        assertEq(BoxCoordinator(impls.coordinator).POKE_GAS(), F95_POKE_GAS, "the coordinator's POKE_GAS");
        assertEq(BoxCoordinator(a.coordinator).POKE_GAS(), F95_POKE_GAS, "box 0's coordinator reads it");
        assertEq(BoxSpecV1.POKE_GAS, F95_POKE_GAS, "BoxSpecV1's POKE_GAS");
    }

    // ------------------------------------------------------------------------------------------------------------
    // The headroom: every path, measured from cold

    function test_BC065_everyStreamPathKeepsItsHeadroom_today() public {
        _headroom(false);
    }

    function test_BC065_everyStreamPathKeepsItsHeadroom_glamsterdam() public {
        _headroom(true);
    }

    function _headroom(bool g) internal {
        (uint256 worst, uint256 notice) = _observerPaths(g);
        _ratio("OBSERVER_GAS over the worst observer path", g, observerCap, worst);
        _ratio("STREAM_NOTIFY_GAS over the notice", g, notifyCap, notice);
        assertGe(
            observerCap * 10_000,
            worst * OBSERVER_HEADROOM_BPS,
            "OBSERVER_GAS at least 2x every observer path (F90 R16H)"
        );
        assertGe(notifyCap * 10_000, notice * NOTICE_HEADROOM_BPS, "STREAM_NOTIFY_GAS at least 1.60x the notice");
    }

    // ------------------------------------------------------------------------------------------------------------
    // The least gas for a Misfit transfer

    function test_BC065_aMisfitTransferNeedsTheWholeCeiling_today() public {
        _leastTransfers(false);
    }

    function test_BC065_aMisfitTransferNeedsTheWholeCeiling_glamsterdam() public {
        _leastTransfers(true);
    }

    function _leastTransfers(bool g) internal {
        _life();
        uint256 snap = vm.snapshotState();
        Least memory first = _leastTransfer("first-time seller to a fresh holder", g, aliceItem);
        vm.revertToState(snap);
        // A known seller: alice's earnings slot exists after her first transfer.
        vm.prank(alice);
        BoxCollection(a.collection).transferFrom(alice, erin, aliceItem);
        vm.roll(block.number + 1);
        Least memory known = _leastTransfer("known seller", g, aliceSecond);
        vm.revertToState(snap);
        _assertLeast(first);
        _assertLeast(known);
    }

    /// The least gas with which alice's transfer of `id` to erin succeeds, to the unit, with the outcome at it and at one
    /// gas less (both logged before anything is asserted, so a failing run still reports them).
    function _leastTransfer(string memory label, bool g, uint256 id) internal returns (Least memory l) {
        bytes memory data = abi.encodeCall(BoxCollection.transferFrom, (alice, erin, id));
        l.gas = _least(g, data);
        l.at = _try(g, data, l.gas, id);
        l.below = _try(g, data, l.gas - 1, id);
        emit log_string(string.concat(
                "F95|least gas for a Misfit transferFrom (call gas, cold)|",
                label,
                g ? "|glamsterdam " : "|today ",
                vm.toString(l.gas),
                "|observer ceiling ",
                vm.toString(observerCap),
                l.below.err == IBoxCollection.ObserverGasTooLow.selector
                    ? "|one less: ObserverGasTooLow"
                    : "|one less: out of gas"
            ));
    }

    /// At the least gas the checkpoint is taken; one gas less reverts `ObserverGasTooLow` naming the collection's floor.
    function _assertLeast(Least memory l) internal view {
        assertTrue(l.at.ok, "the least gas succeeds");
        assertFalse(l.at.skipped, "with the checkpoint taken (no TransferObserverFailed)");
        assertEq(l.at.holder, erin, "the transfer happened");
        assertEq(l.at.recorded, erin, "the stream's record names the new holder");
        assertFalse(l.below.ok, "one gas less fails");
        assertEq(l.below.err, IBoxCollection.ObserverGasTooLow.selector, "with ObserverGasTooLow, as before F87");
        (uint256 left, uint256 required) = _gasArgs(l.below.errData);
        assertEq(required, OBSERVER_FLOOR, "the floor: the cap, its 1/63 and 10,000 (477,301)");
        assertLt(left, required);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Each ceiling arrives whole at the least gas

    function test_BC065_eachCapReachesTheStreamWholeAtTheLeastGas_today() public {
        _delivered(false);
    }

    function test_BC065_eachCapReachesTheStreamWholeAtTheLeastGas_glamsterdam() public {
        _delivered(true);
    }

    function _delivered(bool g) internal {
        uint256 fresh = vm.snapshotState();
        // A take on the curve: the vault's notice (TicketsOpened) and no item moves, so the vault's own floor binds.
        b.toWindow();
        OpenTime.to(BoxHook(a.hook).windowEndsAt());
        b.buy(alice, 1 ether, 0);
        vm.prank(alice);
        BoxToken(a.token).approve(a.tickets, type(uint256).max);
        vm.etch(a.itemStream, GAS_LOGGER);
        _wholeAtLeast(
            "a take on the curve (the vault's notice)",
            g,
            alice,
            a.tickets,
            abi.encodeCall(BoxTickets.take, (1, type(uint256).max, block.timestamp)),
            1,
            observerCap,
            IBoxVault.ObserverGasTooLow.selector,
            OBSERVER_FLOOR
        );
        vm.revertToState(fresh);
        _life();
        uint256 lived = vm.snapshotState();
        vm.etch(a.itemStream, GAS_LOGGER);
        _wholeAtLeast(
            "a Misfit transferFrom (the collection's observer)",
            g,
            alice,
            a.collection,
            abi.encodeCall(BoxCollection.transferFrom, (alice, erin, aliceItem)),
            1,
            observerCap,
            IBoxCollection.ObserverGasTooLow.selector,
            OBSERVER_FLOOR
        );
        // A return after RETURN_GRACE: the vault's notice, then the collection's for the item coming back.
        vm.warp(block.timestamp + 31 days);
        vm.roll(block.number + 31 * 7_200);
        _wholeAtLeast(
            "a return (the vault's notice, then the collection's observer)",
            g,
            alice,
            a.vault,
            abi.encodeCall(BoxVault.returnItem, (aliceItem, 0, block.timestamp)),
            2,
            observerCap,
            IBoxVault.ObserverGasTooLow.selector,
            OBSERVER_FLOOR
        );
        vm.revertToState(lived);
        // A fee batch: the receiver's notice to the stream.
        _fees();
        vm.etch(a.itemStream, GAS_LOGGER);
        _wholeAtLeast(
            "a fee batch (the receiver's notice)",
            g,
            keeper,
            a.receiver,
            abi.encodeCall(IBoxReceiver.collect, (keeper)),
            1,
            notifyCap,
            BoxReceiver.StreamGasTooLow.selector,
            NOTICE_FLOOR
        );
        vm.revertToState(fresh);
    }

    /// At the least gas for `who`'s call (to the unit), each of the `calls` capped calls gives the stream exactly `cap`;
    /// one gas less is refused with `selector`, naming `floor`.
    function _wholeAtLeast(
        string memory label,
        bool g,
        address who,
        address target,
        bytes memory data,
        uint256 calls,
        uint256 cap,
        bytes4 selector,
        uint256 floor
    ) internal {
        uint256 least = _leastCall(g, who, target, data);
        Probe memory at = _probe(g, who, target, data, least);
        Probe memory below = _probe(g, who, target, data, least - 1);
        string memory given = "";
        for (uint256 i; i < at.given.length; ++i) {
            given = string.concat(given, i == 0 ? "" : ", ", vm.toString(at.given[i]));
        }
        emit log_string(string.concat(
                "F95|each cap whole at the least gas|",
                label,
                g ? "|glamsterdam least " : "|today least ",
                vm.toString(least),
                "|the stream given ",
                given,
                "|cap ",
                vm.toString(cap)
            ));
        assertTrue(at.ok, "the least gas succeeds");
        assertEq(at.given.length, calls, "every capped call reached the stream");
        for (uint256 i; i < calls; ++i) {
            assertEq(at.given[i], cap, "the stream receives its whole ceiling at the least gas");
        }
        assertFalse(below.ok, "one gas less fails");
        assertEq(bytes4(below.errData), selector, "refused before the capped call");
        (uint256 left, uint256 required) = _gasArgs(below.errData);
        assertEq(required, floor, "naming the floor");
        assertLt(left, required);
    }

    /// `who`'s call with `gasCap` from a cold snapshot under the schedule, reverted after; the gas logger's values.
    function _probe(bool g, address who, address target, bytes memory data, uint256 gasCap)
        internal
        returns (Probe memory p)
    {
        uint256 snap = vm.snapshotState();
        vm.setEvmVersion(g ? "amsterdam" : "osaka");
        _coolAll();
        vm.recordLogs();
        vm.prank(who);
        (p.ok, p.errData) = target.call{gas: gasCap}(data);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        vm.setEvmVersion("osaka");
        vm.revertToState(snap);
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == a.itemStream && logs[i].topics.length == 0) ++n;
        }
        p.given = new uint256[](n);
        n = 0;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == a.itemStream && logs[i].topics.length == 0) {
                p.given[n++] = abi.decode(logs[i].data, (uint256)) + 2;
            }
        }
    }

    /// The arguments of `ObserverGasTooLow(gasLeft, required)` / `StreamGasTooLow(gasLeft, required)`.
    function _gasArgs(bytes memory err) internal pure returns (uint256 left, uint256 required) {
        assertEq(err.length, 68, "a (gasLeft, required) error");
        assembly ("memory-safe") {
            left := mload(add(err, 36))
            required := mload(add(err, 68))
        }
    }

    // ------------------------------------------------------------------------------------------------------------
    // Fail-safe: a misbehaving stream blocks nothing

    function test_BC065_delayedStartObserversStayWithinCaps_today() public {
        delayStart = true;
        (uint256 worst, uint256 notice) = _observerPaths(false);
        assertGe(observerCap * 10_000, worst * 20_000, "delayed observer retains 2x");
        assertGe(notifyCap * 10_000, notice * NOTICE_HEADROOM_BPS, "delayed notice retains 1.60x");
        _ratio("delayed-start observer", false, observerCap, worst);
        _ratio("delayed-start notice", false, notifyCap, notice);
    }

    function test_BC065_delayedStartObserversStayWithinCaps_glamsterdam() public {
        delayStart = true;
        (uint256 worst, uint256 notice) = _observerPaths(true);
        assertGe(observerCap * 10_000, worst * 20_000, "delayed observer retains 2x");
        assertGe(notifyCap * 10_000, notice * NOTICE_HEADROOM_BPS, "delayed notice retains 1.60x");
        _ratio("delayed-start observer", true, observerCap, worst);
        _ratio("delayed-start notice", true, notifyCap, notice);
    }

    function test_BC065_aMisbehavingStreamCannotBlockATransfer_today() public {
        _misbehaving(false);
    }

    function test_BC065_aMisbehavingStreamCannotBlockATransfer_glamsterdam() public {
        _misbehaving(true);
    }

    function _misbehaving(bool g) internal {
        _life();
        bytes memory data = abi.encodeCall(BoxCollection.transferFrom, (alice, erin, aliceItem));
        uint256 snap = vm.snapshotState();
        uint256 quiet = _leastWith(g, data, STOP, "a stream that does nothing (STOP)", false);
        vm.revertToState(snap);
        _leastWith(g, data, REVERTS, "a stream that reverts", true);
        vm.revertToState(snap);
        uint256 burns = _leastWith(g, data, BURNS_ALL, "a stream that burns all its gas", true);
        assertLe(burns, quiet + observerCap, "a misbehaving stream costs a transfer at most its ceiling");
        vm.revertToState(snap);
        _leastWith(g, data, RETURNS_64K, "a stream that returns 64 KiB (not copied)", false);
        vm.revertToState(snap);
        // A vault action (a return after RETURN_GRACE) and a fee batch with a stream that burns all its gas.
        vm.etch(a.itemStream, BURNS_ALL);
        vm.warp(block.timestamp + 31 days);
        vm.roll(block.number + 31 * 7_200);
        Try memory r = _call(
            g, alice, a.vault, abi.encodeCall(BoxVault.returnItem, (aliceItem, 0, block.timestamp)), GENEROUS, aliceItem
        );
        assertTrue(r.ok, "the return completes");
        assertTrue(r.vaultSkipped && r.skipped, "both checkpoints skipped, reported");
        assertEq(r.holder, a.vault, "the Misfit is back in the vault");
        _fees();
        Try memory c = _call(g, keeper, a.receiver, abi.encodeCall(IBoxReceiver.collect, (keeper)), GENEROUS, aliceItem);
        assertTrue(c.ok, "the fee batch completes");
        assertTrue(c.noticeFailed, "the notice failed, reported (StreamNotifyFailed)");
        vm.revertToState(snap);
    }

    /// With `code` at the stream's address: the least gas for the transfer; at it the transfer happened and the
    /// checkpoint's failure is reported exactly when `reported`.
    function _leastWith(bool g, bytes memory data, bytes memory code, string memory label, bool reported)
        internal
        returns (uint256 least)
    {
        vm.etch(a.itemStream, code);
        assertTrue(_try(g, data, GENEROUS, aliceItem).ok, "it completes with ample gas");
        least = _least(g, data);
        Try memory at = _try(g, data, least, aliceItem);
        assertTrue(at.ok);
        assertEq(at.holder, erin, "the transfer happened");
        assertEq(at.skipped, reported, "TransferObserverFailed exactly when the stream failed");
        emit log_string(string.concat(
                "F95|least gas for a Misfit transferFrom (call gas, cold)|first-time seller, ",
                label,
                g ? "|glamsterdam " : "|today ",
                vm.toString(least)
            ));
    }

    // ------------------------------------------------------------------------------------------------------------
    // Graduation: the receiver's settlement notifies the stream inside POKE_GAS

    function test_BC065_graduationSettlesAndNotifiesWithinPokeGas_today() public {
        _graduation(false);
    }

    function test_BC065_graduationSettlesAndNotifiesWithinPokeGas_glamsterdam() public {
        _graduation(true);
    }

    function _graduation(bool g) internal {
        _toClosed(true);
        uint256 closed = vm.snapshotState();
        uint256 pokeGas = BoxCoordinator(a.coordinator).POKE_GAS();
        // graduate() with every real poke: none fails, the receiver settled and notified, the stream started.
        Try memory gr = _call(g, keeper, a.coordinator, abi.encodeCall(IBoxCoordinator.graduate, ()), 30_000_000, 0);
        assertTrue(gr.ok, "graduate()");
        assertFalse(gr.pokeFailed, "no poke failed");
        assertTrue(gr.settled && gr.funded && !gr.noticeFailed, "the receiver settled and notified the stream");
        assertTrue(gr.started, "the stream started");
        vm.revertToState(closed);
        // Isolate cold call costs: skip settlement and mock a successful no-op start. F126 makes this
        // unstarted graduated state unreachable in production; it is only a gas measurement fixture.
        vm.mockCallRevert(a.receiver, abi.encodeWithSelector(IBoxReceiver.onGraduation.selector), "");
        vm.mockCallRevert(a.itemStream, abi.encodeWithSelector(IBoxItemStream.onGraduation.selector), "");
        vm.prank(keeper);
        BoxCoordinator(a.coordinator).graduate();
        vm.clearMockedCalls();
        vm.roll(block.number + 1);
        uint256 graduated = vm.snapshotState();
        _pokeMargin("receiver.onGraduation (the settlement, its notice)", g, a.receiver, pokeGas);
        vm.revertToState(graduated);
        _pokeMargin("stream.onGraduation (runs the settlement and its notice, then starts)", g, a.itemStream, pokeGas);
        vm.revertToState(closed);
    }

    /// The least gas for `target.onGraduation()` from cold; at it the settlement notified the stream (StreamFunded),
    /// and it fits POKE_GAS.
    function _pokeMargin(string memory label, bool g, address target, uint256 pokeGas) internal {
        assertFalse(BoxReceiver(payable(a.receiver)).graduationSettled(), "the receiver's poke was made to fail");
        bytes memory data = abi.encodeWithSelector(IBoxReceiver.onGraduation.selector);
        uint256 least = _leastCall(g, keeper, target, data);
        Try memory at = _call(g, keeper, target, data, least, 0);
        assertTrue(at.ok && at.settled, label);
        assertTrue(at.funded && !at.noticeFailed, "the settlement's notice ran (StreamFunded, no StreamNotifyFailed)");
        assertLt(least, pokeGas, "within POKE_GAS");
        _ratio(string.concat("POKE_GAS over ", label), g, pokeGas, least);
    }

    /// Box 0 closed as `_life` closes it (placeholders taken, so the tickets' poke requests the word; the keeper's
    /// graduate() 12 s before the drand round), with T-side fees from the curve not yet batched, so the settlement at
    /// graduation splits T and notifies the stream (the case the notice's ceiling must fit inside POKE_GAS). With
    /// `batchBefore` a fee batch ran before the close; without it the settlement's batch is the box's first.
    function _toClosed(bool batchBefore) internal {
        b.toWindow();
        OpenTime.to(BoxHook(a.hook).windowEndsAt());
        uint256 tA = b.buy(alice, 1 ether, 0);
        b.buy(bob, 1 ether, 0);
        _take(alice, 3);
        _take(bob, 2);
        b.sell(alice, tA / 4);
        vm.roll(block.number + 12);
        if (batchBefore) BoxReceiver(payable(a.receiver)).collect(keeper);
        vm.roll(block.number + 12);
        b.sell(alice, tA / 4);
        BoxLayoutV1.Curve memory c = b.curve();
        b.buy(carol, 3 * BoxCoordinator(a.coordinator).raise(), c.sqrtPriceLowerX96);
        assertTrue(BoxHook(a.hook).closed(), "closed");
        vm.warp(src.roundTime(r0) - 12);
        vm.roll(block.number + 1);
    }

    // ------------------------------------------------------------------------------------------------------------
    // POKE_GAS (F95 R19M): every graduation poke at most half of it; graduate()'s least gas and EIP-7825's cap

    function test_BC098_everyGraduationPokeKeepsItsHeadroom_today() public {
        _pokes(false);
    }

    function test_BC098_everyGraduationPokeKeepsItsHeadroom_glamsterdam() public {
        _pokes(true);
    }

    function _pokes(bool g) internal {
        uint256 fresh = vm.snapshotState();
        _pokesAfter(g, true);
        vm.revertToState(fresh);
        _pokesAfter(g, false);
        vm.revertToState(fresh);
    }

    /// Isolated cold costs: optional pokes mocked to revert, stream start mocked to revert.
    /// F126 preserves this fail-safe graduated state; each call is measured alone: the least gas with which it does its work, at most half of POKE_GAS, the
    /// receiver's settlement when its batch is the box's first (and the stream's poke running it) included (F95 R19M;
    /// F90's 1,600,000 held only 1.24x there, SH-box0-stream-gas § POKE_GAS).
    function _pokesAfter(bool g, bool batchBefore) internal {
        _toClosed(batchBefore);
        vm.mockCallRevert(a.receiver, abi.encodeWithSelector(IBoxReceiver.onGraduation.selector), "");
        vm.mockCallRevert(a.tickets, abi.encodeWithSelector(IBoxTickets.requestGraduationWord.selector), "");
        vm.mockCallRevert(a.executor, abi.encodeWithSelector(IBoxPriceAverage.poke.selector), "");
        vm.mockCallRevert(a.itemStream, abi.encodeWithSelector(IBoxItemStream.onGraduation.selector), "");
        vm.prank(keeper);
        BoxCoordinator(a.coordinator).graduate();
        vm.clearMockedCalls();
        vm.roll(block.number + 1);
        string memory when = batchBefore ? ", a batch before the close" : ", the first batch final at graduation";
        Try memory t = _pokeHeadroom(
            string.concat("receiver.onGraduation (the settlement and its notice", when, ")"),
            g,
            a.receiver,
            IBoxReceiver.onGraduation.selector,
            POKE_HEADROOM_BPS
        );
        assertTrue(t.settled && t.funded && !t.noticeFailed, "the receiver settled and notified the stream");
        t = _pokeHeadroom(
            string.concat("stream.onGraduation (runs the settlement and its notice, then starts", when, ")"),
            g,
            a.itemStream,
            IBoxItemStream.onGraduation.selector,
            POKE_HEADROOM_BPS
        );
        assertTrue(t.settled && t.funded && !t.noticeFailed && t.started, "settled, notified and started");
        if (!batchBefore) return;
        t = _pokeHeadroom(
            "tickets.requestGraduationWord (the drand request)",
            g,
            a.tickets,
            IBoxTickets.requestGraduationWord.selector,
            POKE_HEADROOM_BPS
        );
        assertTrue(t.requested, "the graduation word requested");
        _pokeHeadroom(
            "executor.poke (FIT's price average sample)",
            g,
            a.executor,
            IBoxPriceAverage.poke.selector,
            POKE_HEADROOM_BPS
        );
        BoxReceiver(payable(a.receiver)).onGraduation();
        t = _pokeHeadroom(
            "stream.onGraduation (its start, the receiver settled)",
            g,
            a.itemStream,
            IBoxItemStream.onGraduation.selector,
            POKE_HEADROOM_BPS
        );
        assertTrue(t.started, "the stream started");
    }

    /// The least gas for the poke `sel` on `target` from cold (anyone's), its outcome at that gas (logged with the
    /// slots it writes from zero), and POKE_GAS at least `holdBps` of it.
    function _pokeHeadroom(string memory label, bool g, address target, bytes4 sel, uint256 holdBps)
        internal
        returns (Try memory at)
    {
        bytes memory data = abi.encodeWithSelector(sel);
        uint256 least = _leastCall(g, keeper, target, data);
        at = _call(g, keeper, target, data, least, 0);
        uint256 pokeGas = BoxCoordinator(a.coordinator).POKE_GAS();
        uint256 snap = vm.snapshotState();
        _begin(g);
        vm.prank(keeper);
        (bool ok,) = target.call{gas: least}(data);
        S0StateDiff.Counts memory c = S0StateDiff.count(vm.stopAndReturnStateDiff());
        vm.setEvmVersion("osaka");
        vm.revertToState(snap);
        _ratio(string.concat("POKE_GAS over ", label, " (new slots ", vm.toString(c.newSlots), ")"), g, pokeGas, least);
        assertTrue(at.ok && ok, label);
        assertGe(pokeGas * 10_000, least * holdBps, "POKE_GAS keeps its headroom over every graduation poke");
    }

    function test_BC098_eachPokeReceivesExactlyPokeGas_today() public {
        _pokeBudgets(false);
    }

    function test_BC098_eachPokeReceivesExactlyPokeGas_glamsterdam() public {
        _pokeBudgets(true);
    }

    function _pokeBudgets(bool g) internal {
        uint256 fresh = vm.snapshotState();
        _pokeBudgetsAfter(g, true);
        vm.revertToState(fresh);
        _pokeBudgetsAfter(g, false);
        vm.revertToState(fresh);
    }

    /// Every graduation poke's target a gas logger (the receiver, the tickets, FIT's executor, the stream): at
    /// graduate()'s least gas, to the unit, each poke's CALL hands its target exactly POKE_GAS, in poke order (the
    /// budget itself, which the getter, the floor and the burn bounds do not pin); one gas less reverts `GasTooLow`
    /// naming the floor.
    function _pokeBudgetsAfter(bool g, bool batchBefore) internal {
        _toClosed(batchBefore);
        address[4] memory targets = _pokeTargets();
        for (uint256 i; i < 4; ++i) {
            vm.etch(targets[i], GAS_LOGGER);
        }
        bytes memory data = abi.encodeCall(IBoxCoordinator.graduate, ());
        uint256 least = _leastGraduate(g, TX_GAS_CAP - 21_000 - _calldataGas(data), targets);
        PokeProbe memory at = _probePokes(g, least, targets);
        PokeProbe memory below = _probePokes(g, least - 1, targets);
        uint256 pokeGas = BoxCoordinator(a.coordinator).POKE_GAS();
        string memory given = "";
        for (uint256 i; i < at.given.length; ++i) {
            given = string.concat(given, i == 0 ? "" : ", ", vm.toString(at.given[i]));
        }
        emit log_string(string.concat(
                "F95|each poke's budget at graduate()'s least gas (every poke's target a gas logger)",
                batchBefore ? "|a batch before the close" : "|the first batch final",
                g ? "|glamsterdam least " : "|today least ",
                vm.toString(least),
                "|the pokes given ",
                given,
                "|POKE_GAS ",
                vm.toString(pokeGas)
            ));
        assertTrue(at.ok, "the least gas graduates");
        assertEq(at.given.length, 4, "every poke reached its target");
        for (uint256 i; i < 4; ++i) {
            assertEq(at.to[i], targets[i], "in poke order");
            assertEq(at.given[i], pokeGas, "each poke receives exactly POKE_GAS");
            assertEq(at.given[i], F95_POKE_GAS, "each poke receives exactly 2,600,000 (F95 R19M)");
        }
        assertFalse(below.ok, "one gas less fails");
        assertEq(bytes4(below.errData), IBoxCoordinator.GasTooLow.selector, "refused before a poke (GasTooLow)");
        (uint256 left, uint256 required) = _gasArgs(below.errData);
        assertEq(required, POKE_FLOOR, "naming the poke floor (2,651,269)");
        assertLt(left, required);
    }

    function test_BC098_graduateLeastGasAndTheTransactionCap_today() public {
        _graduateGas(false);
    }

    function test_BC098_graduateLeastGasAndTheTransactionCap_glamsterdam() public {
        _graduateGas(true);
    }

    /// graduate()'s least gas with every real poke, to the unit, from cold, with a batch before the close and with the
    /// first batch final at graduation: at it every poke ran (no `PokeFailed`, the receiver settled and notified, the
    /// stream started); one gas less reverts `GasTooLow` naming the poke floor. Its execution gas (the gas used less
    /// EIP-8037's state gas) at that least, and with every poke burning its whole budget (each poke's code an endless
    /// loop), stays under EIP-7825's cap with the transaction's intrinsic gas; so does the least transaction with every
    /// poke burning (a fixed `graduate()` limit must cover it to complete whatever the pokes do).
    function _graduateGas(bool g) internal {
        uint256 fresh = vm.snapshotState();
        _graduateGasAfter(g, true);
        vm.revertToState(fresh);
        _graduateGasAfter(g, false);
        vm.revertToState(fresh);
        // Last: `_graduateUsed` reads the gas used in this frame, whose memory the searches below would grow.
        _graduateLeastBurning(g, true);
        vm.revertToState(fresh);
        _graduateLeastBurning(g, false);
        vm.revertToState(fresh);
    }

    function _graduateGasAfter(bool g, bool batchBefore) internal {
        _toClosed(batchBefore);
        uint256 closed = vm.snapshotState();
        bytes memory data = abi.encodeCall(IBoxCoordinator.graduate, ());
        uint256 intrinsic = 21_000 + _calldataGas(data);
        uint256 least = _leastCallUpTo(g, keeper, a.coordinator, data, TX_GAS_CAP - intrinsic);
        Try memory at = _call(g, keeper, a.coordinator, data, least, 0);
        Try memory below = _call(g, keeper, a.coordinator, data, least - 1, 0);
        Used memory u = _graduateUsed(g, least);
        // Every poke burning its whole budget: the most execution gas graduate() can use.
        vm.etch(a.receiver, BURNS_ALL);
        vm.etch(a.tickets, BURNS_ALL);
        vm.etch(a.executor, BURNS_ALL);
        vm.etch(a.itemStream, BURNS_ALL);
        Used memory burn = _graduateUsed(g, TX_GAS_CAP - intrinsic);
        vm.revertToState(closed);
        _logUsed(
            string.concat(
                batchBefore
                    ? "graduate() at its least gas, a batch before the close (call gas, cold) "
                    : "graduate() at its least gas, the first batch final (call gas, cold) ",
                vm.toString(least),
                ", with intrinsic ",
                vm.toString(least + intrinsic),
                below.err == IBoxCoordinator.GasTooLow.selector ? ", one less: GasTooLow" : ", one less: other"
            ),
            g,
            u,
            intrinsic
        );
        _logUsed(
            batchBefore
                ? "graduate() with every poke burning its budget, a batch before the close"
                : "graduate() with every poke burning its budget, the first batch final",
            g,
            burn,
            intrinsic
        );
        assertTrue(at.ok && u.ok, "the least gas graduates");
        assertFalse(at.pokeFailed, "with every poke run");
        assertTrue(at.settled && at.funded && !at.noticeFailed && at.started, "settled, notified, started");
        assertFalse(below.ok, "one gas less fails");
        assertEq(below.err, IBoxCoordinator.GasTooLow.selector, "refused before a poke (GasTooLow)");
        (uint256 left, uint256 required) = _gasArgs(below.errData);
        assertEq(required, POKE_FLOOR, "naming the poke floor (2,651,269)");
        assertLt(left, required);
        assertLe(least + intrinsic, TX_GAS_CAP, "the least transaction fits EIP-7825's cap");
        assertLe(u.used - u.state + intrinsic, TX_GAS_CAP, "its execution gas fits the cap");
        assertTrue(burn.ok, "F126: graduation survives all four exhausted poke budgets");
        assertGe(burn.used, 4 * F95_POKE_GAS, "four whole budgets of 2,600,000 burned");
        assertLe(burn.used - burn.state + intrinsic, TX_GAS_CAP, "the most execution gas fits the cap");
    }

    /// Least gas with every poke exhausting its budget. One gas less reverts GasTooLow;
    /// the successful worst-budget transaction fits EIP-7825's cap.
    function _graduateLeastBurning(bool g, bool batchBefore) internal {
        _toClosed(batchBefore);
        uint256 intrinsic = 21_000 + _calldataGas(abi.encodeCall(IBoxCoordinator.graduate, ()));
        uint256 snap = vm.snapshotState();
        address[4] memory targets = _pokeTargets();
        for (uint256 i; i < 4; ++i) {
            vm.etch(targets[i], BURNS_ALL);
        }
        uint256 least = _leastGraduate(g, TX_GAS_CAP - intrinsic, targets);
        PokeProbe memory below = _probePokes(g, least - 1, targets);
        vm.revertToState(snap);
        bool tooLow = bytes4(below.errData) == IBoxCoordinator.GasTooLow.selector;
        emit log_string(string.concat(
                "F126|graduate() least gas, all four pokes exhaust their budgets",
                batchBefore ? ", a batch before the close" : ", the first batch final",
                " (call gas, cold)",
                g ? "|glamsterdam " : "|today ",
                vm.toString(least),
                "|with intrinsic ",
                vm.toString(least + intrinsic),
                tooLow ? "|one less: GasTooLow" : "|one less: other",
                "|cap ",
                vm.toString(TX_GAS_CAP)
            ));
        assertFalse(below.ok, "one gas less fails");
        assertTrue(tooLow, "refused at a poke (GasTooLow)");
        (uint256 left, uint256 required) = _gasArgs(below.errData);
        assertEq(required, POKE_FLOOR, "naming the poke floor (2,651,269)");
        assertLt(left, required);
        assertLe(least + intrinsic, TX_GAS_CAP, "with every poke burning, the least transaction fits EIP-7825's cap");
    }

    /// One graduate() measured by `_graduateUsed`.
    struct Used {
        bool ok;
        uint256 used;
        uint256 state;
        uint256 frameState;
    }

    /// graduate() by the keeper with `gasCap` from cold under the schedule, reverted after: success, the gas used (the
    /// caller's gasleft() delta, which under `amsterdam` includes EIP-8037's state gas), the state gas at the unit costs
    /// of the slots, accounts and code it wrote from zero, and Foundry's own count of the frame's state gas.
    function _graduateUsed(bool g, uint256 gasCap) internal returns (Used memory u) {
        uint256 snap = vm.snapshotState();
        vm.setEvmVersion(g ? "amsterdam" : "osaka");
        _coolAll();
        vm.startStateDiffRecording();
        vm.prank(keeper);
        uint256 g0 = gasleft();
        (u.ok,) = a.coordinator.call{gas: gasCap}(abi.encodeCall(IBoxCoordinator.graduate, ()));
        u.used = g0 - gasleft();
        int64 fs = IVmFrameGas(address(vm)).lastFrameGas().gasStateUsed;
        S0StateDiff.Counts memory c = S0StateDiff.count(vm.stopAndReturnStateDiff());
        vm.setEvmVersion("osaka");
        vm.revertToState(snap);
        u.frameState = fs > 0 ? uint256(uint64(fs)) : 0;
        if (g) u.state = c.newSlots * STATE_GAS_PER_SLOT + c.accounts * 183_600 + c.codeBytes * 1_530;
    }

    function _logUsed(string memory label, bool g, Used memory u, uint256 intrinsic) internal {
        emit log_string(string.concat(
                "F95|",
                label,
                g ? "|glamsterdam " : "|today ",
                u.ok ? "ok" : "FAILED",
                "|used ",
                vm.toString(u.used),
                "|state gas ",
                vm.toString(u.state),
                " (Foundry's frame count ",
                vm.toString(u.frameState),
                ")|execution with intrinsic ",
                vm.toString(u.used - u.state + intrinsic),
                "|cap ",
                vm.toString(TX_GAS_CAP)
            ));
    }

    function _calldataGas(bytes memory data) internal pure returns (uint256 gas) {
        for (uint256 i; i < data.length; ++i) {
            gas += data[i] == 0 ? 4 : 16;
        }
    }

    /// One graduate() with stand-ins at the pokes' targets: success, the revert data, and for each LOG0 of a target
    /// (the gas logger's) its emitter and the gas its poke gave it (the logged value plus 2), in order.
    struct PokeProbe {
        bool ok;
        bytes errData;
        address[] to;
        uint256[] given;
    }

    /// The graduation pokes' targets, in poke order (BoxCoordinator.graduate).
    function _pokeTargets() internal view returns (address[4] memory) {
        return [a.receiver, a.tickets, a.executor, a.itemStream];
    }

    /// The keeper's graduate() with `gasCap` from cold under the schedule, reverted after. The stand-ins at the targets
    /// answer no view, so only the call's outcome and the targets' LOG0s are read.
    function _probePokes(bool g, uint256 gasCap, address[4] memory targets) internal returns (PokeProbe memory p) {
        uint256 snap = vm.snapshotState();
        vm.setEvmVersion(g ? "amsterdam" : "osaka");
        _coolAll();
        vm.recordLogs();
        vm.prank(keeper);
        (p.ok, p.errData) = a.coordinator.call{gas: gasCap}(abi.encodeCall(IBoxCoordinator.graduate, ()));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        vm.setEvmVersion("osaka");
        vm.revertToState(snap);
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            if (_isPokeLog(logs[i], targets)) ++n;
        }
        p.to = new address[](n);
        p.given = new uint256[](n);
        n = 0;
        for (uint256 i; i < logs.length; ++i) {
            if (_isPokeLog(logs[i], targets)) {
                p.to[n] = logs[i].emitter;
                p.given[n++] = abi.decode(logs[i].data, (uint256)) + 2;
            }
        }
    }

    function _isPokeLog(Vm.Log memory l, address[4] memory targets) internal pure returns (bool) {
        if (l.topics.length != 0) return false;
        for (uint256 i; i < 4; ++i) {
            if (l.emitter == targets[i]) return true;
        }
        return false;
    }

    /// graduate()'s least gas with stand-ins at the pokes' targets, to the unit (every try from one cold snapshot).
    function _leastGraduate(bool g, uint256 ample, address[4] memory targets) internal returns (uint256 hi) {
        uint256 lo = 20_000;
        hi = ample;
        assertTrue(_probePokes(g, hi, targets).ok, "graduates with ample gas");
        while (hi - lo > 1) {
            uint256 mid = (lo + hi) / 2;
            if (_probePokes(g, mid, targets).ok) hi = mid;
            else lo = mid;
        }
    }

    // ------------------------------------------------------------------------------------------------------------
    // Helpers

    /// Alice's call `data` to the collection with `gasCap` from a cold snapshot under the schedule, reverted after.
    function _try(bool g, bytes memory data, uint256 gasCap, uint256 id) internal returns (Try memory t) {
        return _call(g, alice, a.collection, data, gasCap, id);
    }

    function _call(bool g, address who, address target, bytes memory data, uint256 gasCap, uint256 id)
        internal
        returns (Try memory t)
    {
        uint256 snap = vm.snapshotState();
        vm.setEvmVersion(g ? "amsterdam" : "osaka");
        _coolAll();
        vm.recordLogs();
        vm.prank(who);
        (t.ok, t.errData) = target.call{gas: gasCap}(data);
        if (t.errData.length >= 4) t.err = bytes4(t.errData);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics.length == 0) continue;
            bytes32 t0 = logs[i].topics[0];
            if (t0 == IBoxCollection.TransferObserverFailed.selector) t.skipped = true;
            if (t0 == IBoxVault.VaultObserverFailed.selector) t.vaultSkipped = true;
            if (t0 == IBoxReceiver.StreamFunded.selector) t.funded = true;
            if (t0 == IBoxReceiver.StreamNotifyFailed.selector) t.noticeFailed = true;
            if (t0 == IBoxCoordinator.PokeFailed.selector) t.pokeFailed = true;
            if (t0 == IBoxTickets.GraduationWordRequested.selector) t.requested = true;
        }
        vm.setEvmVersion("osaka");
        if (id != 0) t.holder = BoxCollection(a.collection).ownerOf(id);
        // The real stream is a 227-byte clone; the stand-ins `vm.etch` puts there are a few bytes and answer no view.
        if (a.itemStream.code.length > 100) {
            if (id != 0) (t.recorded,) = IBoxItemStream(a.itemStream).pendingOf(id);
            t.started = IBoxItemStream(a.itemStream).started();
        }
        t.settled = BoxReceiver(payable(a.receiver)).graduationSettled();
        vm.revertToState(snap);
    }

    function _least(bool g, bytes memory data) internal returns (uint256) {
        return _leastCall(g, alice, a.collection, data);
    }

    /// The least gas with which `who`'s call succeeds, to the unit (every try from the same cold snapshot).
    function _leastCall(bool g, address who, address target, bytes memory data) internal returns (uint256) {
        return _leastCallUpTo(g, who, target, data, GENEROUS);
    }

    function _leastCallUpTo(bool g, address who, address target, bytes memory data, uint256 ample)
        internal
        returns (uint256 hi)
    {
        uint256 lo = 20_000;
        hi = ample;
        assertTrue(_call(g, who, target, data, hi, 0).ok, "succeeds with ample gas");
        while (hi - lo > 1) {
            uint256 mid = (lo + hi) / 2;
            if (_call(g, who, target, data, mid, 0).ok) hi = mid;
            else lo = mid;
        }
    }

    /// `cap / need` to four decimals.
    function _ratio(string memory what, bool g, uint256 cap, uint256 need) internal {
        uint256 r = cap * 10_000 / need;
        uint256 frac = r % 10_000;
        string memory pad = frac < 10 ? "000" : frac < 100 ? "00" : frac < 1_000 ? "0" : "";
        emit log_string(string.concat(
                "F95|",
                what,
                g ? "|glamsterdam " : "|today ",
                vm.toString(r / 10_000),
                ".",
                pad,
                vm.toString(frac),
                "x|needs ",
                vm.toString(need),
                "|ceiling ",
                vm.toString(cap)
            ));
    }
}
