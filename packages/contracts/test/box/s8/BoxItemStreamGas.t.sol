// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {BoxCollection} from "../../../src/box/BoxCollection.sol";
import {BoxCoordinator} from "../../../src/box/BoxCoordinator.sol";
import {BoxItemStream} from "../../../src/box/BoxItemStream.sol";
import {BoxReceiver} from "../../../src/box/BoxReceiver.sol";
import {BoxTickets} from "../../../src/box/BoxTickets.sol";
import {BoxVault} from "../../../src/box/BoxVault.sol";
import {ItemReveal} from "../../../src/box/interfaces/BoxTypes.sol";
import {IBoxCollection} from "../../../src/box/interfaces/IBoxCollection.sol";
import {IBoxItemStream} from "../../../src/box/interfaces/IBoxItemStream.sol";
import {IBoxReceiver} from "../../../src/box/interfaces/IBoxReceiver.sol";
import {IBoxVault} from "../../../src/box/interfaces/IBoxVault.sol";
import {S0StateDiff} from "../../spikes/S0StateDiff.sol";
import {BoxItemStreamGasBase} from "./BoxItemStreamGasBase.sol";

/// @notice S8's gas table on box 0 built from the core v1 contracts with its fixture spec (the stream on; created by factory
/// v1 through `CoreBox0Kit` since the S7 × S8 integration), today (Osaka)
/// and under Glamsterdam (`vm.setEvmVersion("amsterdam")`), the method of CoreBox0Gas / SH-S0-spikes § 2.4: `gasleft()`
/// deltas in the caller's frame (under `amsterdam` they include EIP-8037 state gas), every box account cooled first so
/// each operation starts cold like its own transaction, the slots written from zero counted beside each figure.
///
/// - **Each capped call alone** (BC-065: "the observer's worst case, including any slot written from zero after
///   Glamsterdam, stays under its gas cap, so no checkpoint is skipped"): the stream's own frame, called as the
///   collection, the vault or the receiver would, from the same cold state, for every path: a delivery of a placeholder
///   (the shuffle check) and of a draw (a first exit: the item's record from zero), a transfer by a first-time seller
///   (its owed slot from zero) and a known one, a return by a first-time earner, the vault's four actions and the
///   receiver's notice with its burn. Each must stay under its cap, OBSERVER_GAS or STREAM_NOTIFY_GAS (the paths and
///   the world are BoxItemStreamGasBase's; Box0StreamCeiling.t.sol holds them to their measured headroom, F87).
/// - **The user's transfer with the stream on and off** (the same transfer from the same state; off: the stream's code
///   replaced by a STOP, so the collection's capped call returns at once): the stream's share of a Misfit transfer.
/// Lines: `S8GAS|<operation>|<today|glamsterdam total> <gas>|new slots <k>|...`, collected in docs/evidence/SH-S8-stream.md.
/// forge-config: default.evm_version = "osaka"
contract BoxItemStreamGasTest is BoxItemStreamGasBase {
    // ------------------------------------------------------------------------------------------------------------
    // The capped calls alone, every path, both schedules (BoxItemStreamGasBase._observerPaths)

    function test_BC065_everyObserverPathUnderItsCap_today() public {
        _observerPaths(false);
    }

    function test_BC065_everyObserverPathUnderItsCap_glamsterdam() public {
        _observerPaths(true);
    }

    // ------------------------------------------------------------------------------------------------------------
    // The user's operations with the stream on (and the same transfer with it off)

    function test_gas_userOperations_today() public {
        _userOperations(false);
    }

    function test_gas_userOperations_glamsterdam() public {
        _userOperations(true);
    }

    function _userOperations(bool g) internal {
        _life();
        // A Misfit transfer by a first-time seller: stream on, then the same with the stream's code a STOP.
        uint256 snap = vm.snapshotState();
        uint256 on = _op(
            "Misfit transferFrom, first-time seller, stream on",
            g,
            alice,
            a.collection,
            abi.encodeWithSignature("transferFrom(address,address,uint256)", alice, erin, aliceItem)
        );
        vm.revertToState(snap);
        vm.etch(a.itemStream, hex"00");
        uint256 off = _op(
            "Misfit transferFrom, first-time seller, stream code a STOP",
            g,
            alice,
            a.collection,
            abi.encodeWithSignature("transferFrom(address,address,uint256)", alice, erin, aliceItem)
        );
        vm.revertToState(snap);
        emit log_string(string.concat(
                "S8GAS|the stream's share of that transfer|", g ? "glamsterdam total " : "today ", vm.toString(on - off)
            ));
        // A known seller's second transfer, on and off.
        vm.prank(alice);
        BoxCollection(a.collection).transferFrom(alice, erin, aliceItem);
        vm.roll(block.number + 1);
        uint256 known = vm.snapshotState();
        on = _op(
            "Misfit transferFrom, known seller, stream on",
            g,
            alice,
            a.collection,
            abi.encodeWithSignature("transferFrom(address,address,uint256)", alice, erin, aliceSecond)
        );
        vm.revertToState(known);
        vm.etch(a.itemStream, hex"00");
        off = _op(
            "Misfit transferFrom, known seller, stream code a STOP",
            g,
            alice,
            a.collection,
            abi.encodeWithSignature("transferFrom(address,address,uint256)", alice, erin, aliceSecond)
        );
        emit log_string(string.concat(
                "S8GAS|the stream's share of that transfer|", g ? "glamsterdam total " : "today ", vm.toString(on - off)
            ));
        vm.revertToState(snap);
        // A placeholder opened (its Misfit's first exit), a draw opened, a draw requested, a return.
        ItemReveal memory none;
        _op(
            "tickets.open (placeholder to Misfit), stream on",
            g,
            bob,
            a.tickets,
            abi.encodeCall(BoxTickets.open, (bobToken, none))
        );
        vm.revertToState(snap);
        _op(
            "tickets.openDraw by the drawer, stream on",
            g,
            carol,
            a.tickets,
            abi.encodeCall(BoxTickets.openDraw, (drawTicket, address(0), none))
        );
        vm.revertToState(snap);
        vm.warp(block.timestamp + 31 days);
        vm.roll(block.number + 31 * 7_200);
        _op(
            "vault.returnItem by a first-time earner (unrevealed after RETURN_GRACE), stream on",
            g,
            alice,
            a.vault,
            abi.encodeCall(BoxVault.returnItem, (aliceItem, 0, block.timestamp))
        );
        vm.revertToState(snap);
        // A fee batch with the stream's notice and burn.
        _fees();
        _op(
            "receiver.collect, batch with the stream's notice and burn",
            g,
            keeper,
            a.receiver,
            abi.encodeCall(IBoxReceiver.collect, (keeper))
        );
        // A claim of two Misfits' accrual.
        uint256[] memory ids = new uint256[](2);
        (ids[0], ids[1]) = (aliceItem, aliceSecond);
        _op("stream.claim, two Misfits", g, alice, a.itemStream, abi.encodeCall(IBoxItemStream.claim, (ids, alice)));
        vm.revertToState(snap);
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
        // BC-065: no checkpoint skipped (and the receiver's notice taken) under this schedule.
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            bytes32 t0 = logs[i].topics[0];
            assertTrue(t0 != IBoxCollection.TransferObserverFailed.selector, "no transfer checkpoint skipped");
            assertTrue(t0 != IBoxVault.VaultObserverFailed.selector, "no vault checkpoint skipped");
            assertTrue(t0 != IBoxReceiver.StreamNotifyFailed.selector, "the notice ran");
        }
        _line(label, g, used, c);
    }

    // ------------------------------------------------------------------------------------------------------------
    // The coordinator's poke at graduation

    function test_gas_graduationPoke_today() public {
        _graduationPoke(false);
    }

    function test_gas_graduationPoke_glamsterdam() public {
        _graduationPoke(true);
    }

    /// Isolated cold start cost: mock a reverting stream start at graduation, then measure the real call.
    /// F126 preserves this fail-safe graduated state; it is only a gas fixture.
    function _graduationPoke(bool g) internal {
        b.toClosed();
        vm.mockCallRevert(a.itemStream, abi.encodeWithSelector(IBoxItemStream.onGraduation.selector), "");
        BoxCoordinator(a.coordinator).graduate();
        vm.clearMockedCalls();
        assertFalse(st.started());
        vm.roll(block.number + 1);
        _begin(g);
        uint256 g0 = gasleft();
        (bool ok,) = a.itemStream.call(abi.encodeCall(IBoxItemStream.onGraduation, ()));
        uint256 used = g0 - gasleft();
        S0StateDiff.Counts memory c = S0StateDiff.count(vm.stopAndReturnStateDiff());
        vm.setEvmVersion("osaka");
        assertTrue(ok, "the stream starts");
        assertTrue(st.started());
        _line("poke: stream.onGraduation (box 0, receiver settled)", g, used, c);
        assertLt(used, BoxCoordinator(a.coordinator).POKE_GAS(), "within POKE_GAS");
    }

    // ------------------------------------------------------------------------------------------------------------
    // What box 0 with its stream costs through factory v1 (S7 × S8)

    function test_gas_streamAddOnCost_today() public {
        _addOnCost(false);
    }

    function test_gas_streamAddOnCost_glamsterdam() public {
        _addOnCost(true);
    }

    /// Box 0 as factory v1 creates it, with its stream, from the world before setUp's creation: created (createBox),
    /// closed, graduated by a keeper and given one sell and a batch after graduation; the creation, `graduate()` and that
    /// batch measured as CoreBox0Gas does. Since the S7 × S8 integration template 0 requires the stream, so the A/B
    /// without it that S8 measured on SH-core-wave-2's builder (SH-S8-stream § 5: +212,421 creation, +47,648
    /// graduate(), +20,999 first collect today) can no longer be built through the factory; these are the with-stream
    /// figures on the factory's box 0.
    function _addOnCost(bool g) internal {
        vm.revertToState(_beforeCreation);
        uint256[3] memory c = _boxCosts(g);
        string[3] memory what = [
            "creation (createBox: validate, coordinator CREATE, deploy, launch, re-reads, record)",
            "graduate() with every real poke",
            "receiver.collect after graduation (a sell's T side streamed)"
        ];
        for (uint256 i; i < 3; ++i) {
            emit log_string(string.concat(
                    "S8GAS|box 0 with add-on 2 through factory v1: ",
                    what[i],
                    g ? "|glamsterdam total " : "|today ",
                    vm.toString(c[i])
                ));
        }
    }

    function _boxCosts(bool g) internal returns (uint256[3] memory c) {
        vm.setEvmVersion(g ? "amsterdam" : "osaka");
        b.create();
        vm.setEvmVersion("osaka");
        c[0] = b.creationGas();
        (a, impls) = (b.addresses(), b.impls());
        assertTrue(a.itemStream != address(0) && a.itemStream.code.length != 0, "the factory created the stream");
        b.toClosed();
        vm.roll(block.number + 1);
        _begin(g);
        vm.prank(keeper);
        uint256 g0 = gasleft();
        BoxCoordinator(a.coordinator).graduate();
        c[1] = g0 - gasleft();
        vm.stopAndReturnStateDiff();
        vm.setEvmVersion("osaka");
        assertTrue(BoxItemStream(a.itemStream).started(), "the graduation poke started the stream");
        vm.roll(block.number + 1);
        uint256 t = b.buy(dave, 1 ether, 0);
        b.sell(dave, t);
        vm.roll(block.number + 12);
        _begin(g);
        vm.prank(keeper);
        g0 = gasleft();
        BoxReceiver(payable(a.receiver)).collect(keeper);
        c[2] = g0 - gasleft();
        vm.stopAndReturnStateDiff();
        vm.setEvmVersion("osaka");
    }
}
