// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VmSafe} from "forge-std/Vm.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {BoxCollection} from "../../../../src/box/BoxCollection.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {BoxTickets} from "../../../../src/box/BoxTickets.sol";
import {BoxVault} from "../../../../src/box/BoxVault.sol";
import {IBoxCollection} from "../../../../src/box/interfaces/IBoxCollection.sol";
import {IBoxItemStream} from "../../../../src/box/interfaces/IBoxItemStream.sol";
import {IBoxReceiver} from "../../../../src/box/interfaces/IBoxReceiver.sol";
import {IBoxVault} from "../../../../src/box/interfaces/IBoxVault.sol";
import {ItemReveal, VaultAction} from "../../../../src/box/interfaces/BoxTypes.sol";
import {BoxClones} from "../../../../src/box/libraries/BoxClones.sol";
import {TransientReentrancyGuard} from "../../../../src/libraries/TransientReentrancyGuard.sol";
import {TIn, TOut} from "../common/AuditGhostLedger.sol";
import {AuditU5FableBase, AuditU5FableExecLogs} from "./AuditU5FableBase.sol";

/// @notice TEST ONLY: an item recipient whose ERC-721 receiver hook runs a planned list of calls while the delivery
/// (the vault's `deliverTicket` inside the tickets' `openDraw`) is still on the stack, and records each answer.
contract AuditU5FableHookRecipient {
    address[] public targets;
    bytes[] public datas;
    bool[] public oks;
    bytes[] public rets;

    function plan(address target, bytes calldata data) external {
        targets.push(target);
        datas.push(data);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
        for (uint256 i; i < targets.length; ++i) {
            (bool ok, bytes memory ret) = targets[i].call(datas[i]);
            oks.push(ok);
            rets.push(ret);
        }
        return this.onERC721Received.selector;
    }

    function count() external view returns (uint256) {
        return oks.length;
    }
}

/// @title AuditU5FableStreamTest
/// @notice SH-AUDIT-B0-U5-F, box 0's per-item stream on the factory's box 0 (mainnet build, Osaka): the eight lenses
/// as passing property and fuzz tests. Sources: `IBoxItemStream.sol:33-56`, `BoxItemStream.sol:25-60`; BC-065; F23 A3,
/// F61 X1, F87, F90 R16H, F126; architecture review R1 (`ARCHITECTURE-AND-PLAN-REVIEW-2026-10-07.md:79`).
/// forge-config: default.evm_version = "osaka"
contract AuditU5FableStreamTest is AuditU5FableBase {
    using StateLibrary for IPoolManager;

    address[] internal accounts;
    uint256[] internal outside;

    function _track() internal {
        delete accounts;
        delete outside;
        for (uint256 i; i < 8; ++i) {
            accounts.push(eoa[i]);
        }
        accounts.push(address(contractDrawer));
        accounts.push(eoa7702);
        accounts.push(address(gasBurner));
        accounts.push(address(ethRefuser));
        if (itemA != 0) outside.push(itemA);
        if (itemP1 != 0) outside.push(itemP1);
    }

    /// The two ledgers agree: `liabilities()` (Σ m·ΔJ − claimed) equals Σ owed + Σ pending of the outside items + the
    /// open tickets' accrual (every observer call ran, so nothing is unattributed).
    function _assertLedgersAgree() internal view {
        assertEq(_ledgerFromRecords(accounts, outside), stream.liabilities(), "aggregate == per-item ledger");
    }

    /// An item still inside the vault (hidden or on the shelf).
    function _insideItem() internal view returns (uint256 id) {
        for (id = tickets.firstId(); id < tickets.firstId() + editionSize; ++id) {
            if (vault.isInside(id)) return id;
        }
        revert("no item inside");
    }

    function _assertXMatches(string memory where) internal view {
        assertEq(_streamXIndependent(), stream.streamValue(), where);
    }

    /// A sell by `who` of `t` T: returns the T fee the pool's positions received (by StateLibrary).
    function _sellFee(address who, uint256 t) internal returns (uint256 fee) {
        (, uint256 u1Before) = _uncollected();
        _sell(who, t);
        (, uint256 u1After) = _uncollected();
        fee = u1After - u1Before;
    }

    /// Collects with the receiver's `StreamFunded` amount read from its event.
    function _collectFunded(address caller) internal returns (uint256 funded) {
        _buy(eoa[4], 0.6 ether);
        _advance(1);
        vm.recordLogs();
        _collect(caller, caller);
        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == a.receiver && logs[i].topics[0] == IBoxReceiver.StreamFunded.selector) {
                funded += abi.decode(logs[i].data, (uint256));
            }
            if (logs[i].emitter == a.receiver && logs[i].topics[0] == IBoxReceiver.StreamNotifyFailed.selector) {
                revert("the stream's notice failed");
            }
        }
    }

    // ================================================================================================ L1 / L6: X

    /// P5.13 / P5.3: X = F + 13·⌊(U + R)/15⌋ as the stream reads it by `extsload` (PoolManager slots: `balanceOf` 4,
    /// `_pools` 6, StateLibrary's offsets) equals the same formula from v4's StateLibrary at every state: sells (T
    /// fees), buys (Q fees), a batch, a gift, a claim, a transfer, a return, a pick, a draw, an opening, a deepen.
    function testProperty_AUDIT_U5_streamXMatchesIndependentReadsAcrossActions() public {
        _toDrawing();
        _assertXMatches("at Drawing");
        _sell(eoa[3], token.balanceOf(eoa[3]) / 2);
        _assertXMatches("after a sell");
        _buy(eoa[4], 0.7 ether);
        _assertXMatches("after a buy");
        _advance(1);
        _collect(keeper, keeper);
        _assertXMatches("after a collect");
        _transferT(eoa[4], a.itemStream, 1e21);
        _assertXMatches("after a gift");
        _claimStream(eoa[3], _ids(itemA));
        _assertXMatches("after a claim");
        _transferItem(eoa[0], eoa[1], itemP1);
        _assertXMatches("after a transfer");
        _returnItem(eoa[1], itemP1);
        _assertXMatches("after a return");
        _pick(eoa[2], itemP1);
        _assertXMatches("after a pick");
        _draw(eoa[2], AUDIT_DRAW_VALUE);
        _assertXMatches("after a draw");
        _openDraw(address(contractDrawer), drawB, address(contractDrawer), true);
        _assertXMatches("after an opening");
        _fundDepth(eoa[5], 1 ether);
        _advance(301);
        _deepen(keeper, keeper);
        _assertXMatches("after a deepen");
        _sell(eoa[2], token.balanceOf(eoa[2]) / 3);
        _assertXMatches("after another sell");
        _collectWithQ(keeper);
        _assertXMatches("after the last collect");
        _assertGhostLedger();
    }

    /// P5.3: X never falls and never jumps except at a sell (by 13/15 of its T fee, to one fifteenth) or a gift: a
    /// buy, a collect, a claim, a transfer, a return, a pick, a draw, a settle-free opening and a burn leave X as it is.
    function testProperty_AUDIT_U5_streamXNeverFallsAndIsContinuous() public {
        _toDrawing();
        uint256 x = stream.streamValue();
        uint256 fee = _sellFee(eoa[3], token.balanceOf(eoa[3]) / 2);
        uint256 x1 = stream.streamValue();
        assertGe(x1, x, "never falls");
        assertApproxEqAbs(x1 - x, fee * 13 / 15, 13, "a sell raises X by 13/15 of its fee");
        x = x1;
        _buy(eoa[4], 0.7 ether);
        assertEq(stream.streamValue(), x, "a buy (Q fee) leaves X");
        _advance(1);
        _collect(keeper, keeper);
        assertEq(stream.streamValue(), x, "a collect leaves X (continuous across the hand-off)");
        _claimStream(eoa[3], _ids(itemA));
        assertEq(stream.streamValue(), x, "a claim leaves X");
        _transferItem(eoa[0], eoa[1], itemP1);
        assertEq(stream.streamValue(), x, "a transfer leaves X");
        _returnItem(eoa[1], itemP1);
        assertEq(stream.streamValue(), x, "a return leaves X");
        _pick(eoa[2], itemP1);
        assertEq(stream.streamValue(), x, "a pick leaves X");
        _draw(eoa[2], AUDIT_DRAW_VALUE);
        assertEq(stream.streamValue(), x, "a draw leaves X");
        _openDraw(address(contractDrawer), drawB, address(contractDrawer), true);
        assertEq(stream.streamValue(), x, "an opening leaves X");
        vm.prank(eoa[5]);
        stream.burn();
        assertEq(stream.streamValue(), x, "a burn leaves X");
        _transferT(eoa[4], a.itemStream, 777);
        assertEq(stream.streamValue(), x + 777, "a gift raises X by itself");
        _assertGhostLedger();
    }

    /// P5.3: conservation: every T the receiver handed the stream (`StreamFunded`) or a gift is held, paid or burned,
    /// to the raw unit; claimed + claimable ≤ received − burned (the stream never promises more than it holds after a
    /// collect).
    function testProperty_AUDIT_U5_streamConservation() public {
        _toDrawing();
        _track();
        uint256 received;
        uint256 gifts;
        for (uint256 i; i < 4; ++i) {
            _sell(eoa[3], token.balanceOf(eoa[3]) / 4);
            received += _collectFunded(keeper);
            if (i == 1) {
                _transferT(eoa[4], a.itemStream, 5e20);
                gifts += 5e20;
            }
            if (i == 2) _claimStream(eoa[3], _ids(itemA));
            (uint256 claimed, uint256 burned) = stream.totals();
            assertEq(_streamT() + claimed + burned, received + gifts, "held + paid + burned == received");
            assertGe(_streamT(), stream.liabilities(), "owners covered after a collect");
            assertLe(claimed + stream.liabilities(), received + gifts - burned, "claimed + claimable <= in - burned");
            _assertLedgersAgree();
        }
        _assertGhostLedger();
    }

    /// G07 point 4, BC-065: items outside earn J each; items inside earn nothing and their share is burned at the next
    /// notice; an item that comes back stops earning (its record cleared) and its share is burned from then on.
    function testProperty_AUDIT_U5_insideBurnsOutsideEarns() public {
        _toDrawing();
        _track();
        _sell(eoa[3], token.balanceOf(eoa[3]) / 2);
        _collectFunded(keeper);
        uint256 j = stream.index();
        assertGt(j, 0);
        (address o, uint256 pending) = stream.pendingOf(itemA);
        assertEq(o, eoa[3]);
        assertEq(pending, j, "an item outside since the start earned J");
        (o, pending) = stream.pendingOf(itemP1);
        assertEq(o, eoa[0]);
        assertEq(pending, j);
        (o, pending) = stream.pendingOf(itemB);
        assertEq(o, address(0), "a settled, unopened draw's item has no record yet (its ticket accrues)");
        (o, pending) = stream.pendingOf(_insideItem());
        assertEq(o, address(0), "an item inside has no record");
        assertEq(pending, 0, "an item inside earns nothing");
        (, uint256 burned) = stream.totals();
        uint256 m = stream.outsideCount();
        // The inside share was burned by the notice: the stream keeps the owners' accrual plus one raw unit per slot.
        assertEq(_streamT() - stream.liabilities(), m, "only the per-slot margin is kept");
        assertGt(burned, 0, "the items-inside share was burned");
        assertApproxEqAbs(burned, (editionSize - m) * j, editionSize + m + 30, "about (N - m) x J");
        // A return: the item stops earning; its holder keeps what was booked.
        uint256 owedBefore = stream.owedOf(eoa[3]);
        _returnItem(eoa[3], itemA);
        assertEq(stream.owedOf(eoa[3]), owedBefore + j, "the return booked its accrual");
        (o, pending) = stream.pendingOf(itemA);
        assertEq(o, address(0), "inside again: no record");
        _sell(eoa[2], token.balanceOf(eoa[2]) / 4);
        _collectFunded(keeper);
        assertEq(stream.owedOf(eoa[3]), owedBefore + j, "nothing more for the returned item");
        (, pending) = stream.pendingOf(itemA);
        assertEq(pending, 0);
        delete outside;
        outside.push(itemP1);
        _assertLedgersAgree();
        _assertGhostLedger();
    }

    /// P5.4: `claimFor(account, ids)` pays `account` itself, never the caller (F61 X1: a contract owner is paid by
    /// anyone's call); `claim(ids, to)` is the owner's only, and pays `to`.
    function testProperty_AUDIT_U5_claimForPaysOnlyTheAccount() public {
        _toDrawing();
        // The holder at the time of the accrual earns: the item moves first, then the fees come.
        _transferItem(eoa[3], address(contractDrawer), itemA);
        _sell(eoa[3], token.balanceOf(eoa[3]) / 2);
        _collectFunded(keeper);
        uint256 callerT = token.balanceOf(eoa[5]);
        uint256 paid = _claimStreamFor(eoa[5], address(contractDrawer), _ids(itemA));
        assertGt(paid, 0, "the contract holder was paid");
        assertEq(token.balanceOf(eoa[5]), callerT, "the caller got nothing");
        // claim(ids, to): only the owner of each id.
        vm.prank(eoa[5]);
        vm.expectRevert(abi.encodeWithSelector(IBoxItemStream.NotOwner.selector, itemP1, eoa[5]));
        stream.claim(_ids(itemP1), eoa[5]);
        vm.prank(eoa[5]);
        vm.expectRevert(abi.encodeWithSelector(IBoxItemStream.NotOwner.selector, itemP1, eoa[5]));
        stream.claimFor(eoa[5], _ids(itemP1));
        uint256 toT = token.balanceOf(eoa[7]);
        vm.prank(eoa[0]);
        paid = stream.claim(_ids(itemP1), eoa[7]);
        _noteTChange(toT, token.balanceOf(eoa[7]), TIn.Other, TOut.StreamClaim);
        assertEq(token.balanceOf(eoa[7]) - toT, paid, "paid to `to`");
        assertEq(stream.owedOf(eoa[0]), 1, "one raw unit kept booked");
        _assertGhostLedger();
    }

    /// P5.4: a repeated id in one claim pays once (the second checkpoint finds nothing since the first); the same
    /// across one call and two.
    function testProperty_AUDIT_U5_duplicateIdsInOneClaimPayOnce() public {
        _toDrawing();
        _sell(eoa[3], token.balanceOf(eoa[3]) / 2);
        _collectFunded(keeper);
        uint256 snap = vm.snapshotState();
        uint256 once = _claimStream(eoa[3], _ids(itemA));
        uint256 owedOnce = stream.owedOf(eoa[3]);
        vm.revertToState(snap);
        uint256[] memory dup = new uint256[](3);
        (dup[0], dup[1], dup[2]) = (itemA, itemA, itemA);
        uint256 thrice = _claimStream(eoa[3], dup);
        assertEq(thrice, once, "duplicates pay once");
        assertEq(stream.owedOf(eoa[3]), owedOnce);
        assertEq(_claimStream(eoa[3], _ids(itemA)), 0, "nothing more right away");
    }

    /// Box-factory § 2.2: a claim pays what is owed less one raw unit kept, and at most what the stream holds; the
    /// rest stays owed until the next collect.
    function testProperty_AUDIT_U5_claimPaysUpToHeldAndKeepsOneRawUnit() public {
        _toDrawing();
        _sell(eoa[3], token.balanceOf(eoa[3]) / 2);
        // Before any collect the stream holds nothing: the accrual is owed but unpaid.
        assertEq(_streamT(), 0);
        uint256 j = stream.index();
        assertGt(j, 0);
        uint256 paid = _claimStream(eoa[3], _ids(itemA));
        assertEq(paid, 0, "nothing held: nothing paid");
        assertEq(stream.owedOf(eoa[3]), j, "booked, still owed");
        _collectFunded(keeper);
        paid = _claimStream(eoa[3], _ids(itemA));
        uint256 j2 = stream.index();
        assertEq(paid, j2 - 1, "paid all but one raw unit");
        assertEq(stream.owedOf(eoa[3]), 1);
        _assertGhostLedger();
    }

    /// R1 (architecture review 2026-10-07), BC-065: a draw earns only from its own request: draw B (requested at J 0)
    /// opened after accrual starts its item at J 0; draw C requested at J1 > 0 and cancelled in terminal mode books
    /// exactly J_cancel − J1 to its drawer; neither sees the other's interval.
    function testProperty_AUDIT_U5_drawEarnsOnlyFromItsOwnRequest() public {
        _toDrawing();
        _track();
        _sell(eoa[3], token.balanceOf(eoa[3]) / 2);
        _collectFunded(keeper);
        uint256 j1 = stream.index();
        assertGt(j1, 0);
        (, uint256 d, uint256 sum) = stream.openTickets();
        assertEq(d, 1, "draw B open");
        assertEq(sum, 0, "requested at J 0");
        // Draw C (the world's silent draw by the 7702 EOA) is requested now, at J1.
        _toSilent();
        (, d, sum) = stream.openTickets();
        assertEq(d, 2);
        assertEq(sum, j1, "C's request index");
        _sell(eoa[2], token.balanceOf(eoa[2]) / 4);
        _collectFunded(keeper);
        uint256 j2 = stream.index();
        assertGt(j2, j1);
        // B opens by its drawer: its item starts at J 0, so its pending is J now.
        uint256 item = _openDraw(address(contractDrawer), drawB, address(contractDrawer), true);
        (address o, uint256 pending) = stream.pendingOf(item);
        assertEq(o, address(contractDrawer));
        assertEq(pending, j2, "B earned from its request at J 0");
        outside.push(item);
        // Terminal mode, C cancelled: its drawer gets J_cancel − J1 exactly.
        _toTerminal();
        uint256 owedBefore = stream.owedOf(eoa7702);
        _cancelDraw(eoa[5], drawC);
        uint256 jc = stream.index();
        assertEq(stream.owedOf(eoa7702) - owedBefore, jc - j1, "C earned from its own request only");
        (, d, sum) = stream.openTickets();
        assertEq(d, 0);
        assertEq(sum, 0);
        _assertLedgersAgree();
        _assertGhostLedger();
    }

    /// G07 point 4: a placeholder earns from the start and passes its share to the Misfit it opens into (the opener's
    /// item starts at J 0); the open placeholders' count falls by one.
    function testProperty_AUDIT_U5_placeholderEarnsFromTheStartAndPassesToItsMisfit() public {
        _toDrawing();
        _sell(eoa[3], token.balanceOf(eoa[3]) / 2);
        _collectFunded(keeper);
        uint256 j = stream.index();
        (uint256 p,,) = stream.openTickets();
        assertEq(p, 4, "placeholders 2-5 open");
        uint256 item = _open(eoa[0], 2, true);
        (address o, uint256 pending) = stream.pendingOf(item);
        assertEq(o, eoa[0]);
        assertEq(pending, j, "the placeholder's accrual since the start");
        (p,,) = stream.openTickets();
        assertEq(p, 3);
        // Handed to another holder before opening: the opener's slot earns, the first holder nothing (no stream
        // checkpoint on placeholder transfers: documented, the accrual follows the ticket).
        vm.prank(eoa[1]);
        tickets.transferFrom(eoa[1], eoa[6], 4);
        item = _open(eoa[6], 4, true);
        (o, pending) = stream.pendingOf(item);
        assertEq(o, eoa[6]);
        assertEq(pending, j, "the holder at the opening gets the whole share");
        assertEq(stream.owedOf(eoa[1]), 0);
        _assertGhostLedger();
    }

    /// `burn()` (anyone) takes only the surplus not owed: after a collect it leaves the owners' accrual plus one raw
    /// unit per outside slot; while the accrual exceeds what is held (between batches) it burns nothing.
    function testProperty_AUDIT_U5_burnTakesOnlySurplusNotOwed() public {
        _toDrawing();
        _sell(eoa[3], token.balanceOf(eoa[3]) / 2);
        // A gift smaller than the accrual: liabilities exceed the holding, nothing to burn.
        _transferT(eoa[4], a.itemStream, 1e18);
        assertGt(stream.liabilities(), _streamT());
        vm.prank(eoa[5]);
        assertEq(stream.burn(), 0, "nothing burned while owed exceeds held");
        _collectFunded(keeper);
        vm.prank(eoa[5]);
        uint256 burned = stream.burn();
        assertEq(burned, 0, "the notice burned already");
        uint256 m = stream.outsideCount();
        assertLe(_streamT() - stream.liabilities(), m, "only the margin stays");
        // A gift after the notice: the next burn takes exactly the surplus beyond owed + margin.
        _transferT(eoa[4], a.itemStream, 1e21);
        uint256 jBefore = stream.index();
        vm.prank(eoa[5]);
        burned = stream.burn();
        assertEq(stream.index(), jBefore, "a burn does not change J");
        assertEq(_streamT(), stream.liabilities() + m, "held == owed + one raw unit per outside slot");
        assertGt(burned, 0);
        _assertGhostLedger();
    }

    /// After every collect the stream holds at least what owners have accrued and not claimed (owners covered), over
    /// a run of batches, claims, transfers and returns.
    function testProperty_AUDIT_U5_ownersCoveredAfterEveryCollect() public {
        _toDrawing();
        _track();
        for (uint256 i; i < 6; ++i) {
            _sell(eoa[3 + i % 2], token.balanceOf(eoa[3 + i % 2]) / 5);
            if (i == 2) _transferItem(eoa[3], eoa[4], itemA);
            if (i == 3) _claimStream(eoa[4], _ids(itemA));
            if (i == 4) _returnItem(eoa[0], itemP1);
            _collectFunded(keeper);
            assertGe(_streamT(), stream.liabilities(), "owners covered");
            assertLe(_streamT() - stream.liabilities(), stream.outsideCount(), "margin only");
        }
        delete outside;
        outside.push(itemA);
        _assertLedgersAgree();
        _assertGhostLedger();
    }

    // ================================================================================================ L2 access

    /// P5.5: `onStreamFunds` only from the receiver, `onItemTransfer` only from the collection, `onVaultAction` only
    /// from the vault; `initialize` only by the coordinator and only once (fuzzed caller).
    function testFuzz_AUDIT_U5_streamObserversRefuseStrangers(address caller) public {
        _toDrawing();
        vm.assume(caller != a.receiver && caller != a.collection && caller != a.vault && caller != a.coordinator);
        uint256 inside = vault.inside();
        vm.expectRevert(abi.encodeWithSelector(IBoxItemStream.NotReceiver.selector, caller));
        vm.prank(caller);
        stream.onStreamFunds(1);
        vm.expectRevert(abi.encodeWithSelector(IBoxItemStream.NotCollection.selector, caller));
        vm.prank(caller);
        stream.onItemTransfer(eoa[3], caller, itemA);
        vm.expectRevert(abi.encodeWithSelector(IBoxItemStream.NotVault.selector, caller));
        vm.prank(caller);
        stream.onVaultAction(VaultAction.Withdrawn, caller, 1, inside);
        vm.expectRevert(abi.encodeWithSelector(IBoxItemStream.NotCoordinator.selector, caller));
        vm.prank(caller);
        stream.initialize();
        vm.expectRevert(IBoxItemStream.AlreadyInitialised.selector);
        vm.prank(a.coordinator);
        stream.initialize();
    }

    /// P5.6: `burn`, `claimFor` and `onGraduation` are anyone's; `onGraduation` once (`AlreadyStarted` after).
    function testProperty_AUDIT_U5_streamOpenEntryPoints() public {
        _toDrawing();
        address[3] memory callers = [eoa[7], address(contractDrawer), eoa7702];
        for (uint256 i; i < 3; ++i) {
            vm.prank(callers[i]);
            stream.burn();
            _claimStreamFor(callers[i], eoa[3], _ids(itemA));
            vm.expectRevert(IBoxItemStream.AlreadyStarted.selector);
            vm.prank(callers[i]);
            stream.onGraduation();
        }
    }

    // ================================================================================================ L3 reentrancy

    /// P5.7 / F126 (M28): the stream's start value is the coordinator's baseline whatever happened to graduation's
    /// pokes: every poke fine; the stream's poke failed; the receiver's and the stream's pokes failed and a stranger
    /// starts the stream later (which settles the receiver first); or a stranger settles the receiver first, then
    /// trading, then the stream's start. Each gives the same X₀ and, after the same trading, the same J; the delayed
    /// start keeps the owners' accrual since graduation.
    function testProperty_AUDIT_U5_graduationPokeOrdersGiveTheSameStart() public {
        _toClosed();
        // A gift before graduation makes X₀ non-zero (the curve's T was burned by the receiver's curve batches).
        _transferT(eoa[2], a.itemStream, 3e21);
        _warpTo(_requestTimeFor(r0));
        uint256 snap = vm.snapshotState();
        uint256[4] memory starts;
        uint256[4] memory indexes;
        uint256[4] memory owedA;
        for (uint256 v; v < 4; ++v) {
            if (v != 0) vm.revertToState(snap);
            if (v == 1) vm.mockCallRevert(a.itemStream, IBoxItemStream.onGraduation.selector, "stream poke fails");
            if (v >= 2) vm.mockCallRevert(a.receiver, IBoxReceiver.onGraduation.selector, "receiver poke fails");
            (, uint256 failures) = _graduate(keeper);
            vm.clearMockedCalls();
            assertEq(failures, v == 0 ? 0 : (v == 1 ? 1 : 2), "poke failures as arranged");
            assertEq(stream.started(), v == 0, "started only when its poke ran");
            if (v == 3) {
                vm.prank(eoa[7]);
                receiver.onGraduation();
            }
            // The same trading: a sell (T fees) and a batch, with the stream not yet started in three variants.
            _sell(eoa[0], token.balanceOf(eoa[0]) / 2);
            _collectFunded(keeper);
            uint256 jBefore = stream.index();
            if (v != 0) {
                vm.prank(eoa[7]);
                stream.onGraduation();
            }
            assertTrue(stream.started());
            assertEq(stream.index(), jBefore, "a delayed start keeps the accrual since graduation (F126)");
            starts[v] = stream.startValue();
            indexes[v] = stream.index();
            // Placeholders accrue from the start: the same payout for the same holder in every variant.
            _post(r0);
            vm.prank(keeper);
            tickets.acceptGraduationWord();
            uint256 item = _open(eoa[0], 1, true);
            _claimStream(eoa[0], _ids(item));
            owedA[v] = stream.owedOf(eoa[0]) + token.balanceOf(eoa[0]);
        }
        for (uint256 v = 1; v < 4; ++v) {
            assertEq(starts[v], starts[0], "the same X0");
            assertEq(indexes[v], indexes[0], "the same J");
            assertEq(owedA[v], owedA[0], "the same payout");
        }
        assertEq(
            starts[0],
            coordinator.streamStartBalance() + 13
                * ((coordinator.streamStartClaims() - receiver.streamCurveDepthT()) / 15),
            "X0 is the coordinator's baseline (F126)"
        );
        assertGe(starts[0], 3e21, "the gift is in X0");
        assertGt(indexes[0], 0, "and the sell after graduation accrued");
    }

    /// L3: calls made from an item recipient's ERC-721 hook while the delivery is on the stack: a claim for the item
    /// just delivered pays exactly its accrual since the draw's request (the record was written before the hook), a
    /// return of the unrevealed item is refused, and re-entries into the tickets and the vault meet their locks; the
    /// two ledgers still agree afterwards.
    function testProperty_AUDIT_U5_callbacksDuringADeliveryCannotDoubleBook() public {
        _toDrawing();
        _track();
        _sell(eoa[3], token.balanceOf(eoa[3]) / 2);
        _collectFunded(keeper);
        uint256 j = stream.index();
        AuditU5FableHookRecipient rcpt = new AuditU5FableHookRecipient();
        accounts.push(address(rcpt));
        _ghostAddOutside(address(rcpt));
        ItemReveal memory r = _reveal(itemB);
        rcpt.plan(a.itemStream, abi.encodeCall(IBoxItemStream.claimFor, (address(rcpt), _ids(itemB))));
        rcpt.plan(a.vault, abi.encodeCall(IBoxVault.returnItem, (itemB, 0, type(uint256).max)));
        rcpt.plan(a.tickets, abi.encodeCall(BoxTickets.openDraw, (drawB, address(rcpt), r)));
        rcpt.plan(a.vault, abi.encodeCall(IBoxVault.withdraw, (itemA, type(uint256).max, type(uint256).max)));
        rcpt.plan(a.itemStream, abi.encodeCall(IBoxItemStream.claimFor, (address(rcpt), _ids(itemB))));
        uint256 t0 = token.balanceOf(address(rcpt));
        contractDrawer.exec(a.tickets, 0, abi.encodeCall(BoxTickets.openDraw, (drawB, address(rcpt), r)));
        uint256 paidInHook = token.balanceOf(address(rcpt)) - t0;
        _noteTChange(t0, token.balanceOf(address(rcpt)), TIn.Other, TOut.StreamClaim);
        assertEq(rcpt.count(), 5);
        assertTrue(rcpt.oks(0), "a claim inside the hook runs (no lock held by the stream)");
        assertEq(paidInHook, j - 1, "paid the draw's accrual since its request at J 0, less the unit kept");
        assertFalse(rcpt.oks(1), "a return from inside the delivery meets the vault's lock");
        assertEq(bytes4(rcpt.rets(1)), TransientReentrancyGuard.Reentrancy.selector);
        assertFalse(rcpt.oks(2), "the tickets' lock");
        assertEq(bytes4(rcpt.rets(2)), TransientReentrancyGuard.Reentrancy.selector);
        assertFalse(rcpt.oks(3), "the vault's lock");
        assertEq(bytes4(rcpt.rets(3)), TransientReentrancyGuard.Reentrancy.selector);
        assertTrue(rcpt.oks(4));
        assertEq(abi.decode(rcpt.rets(4), (uint256)), 0, "a second claim in the hook pays nothing more");
        (address o, uint256 pending) = stream.pendingOf(itemB);
        assertEq(o, address(rcpt));
        assertEq(pending, 0, "checkpointed at J now by the claim");
        assertEq(stream.owedOf(address(rcpt)), 1);
        assertEq(collection.ownerOf(itemB), address(rcpt));
        assertTrue(collection.isRevealed(itemB), "revealed after the delivery, as planned");
        outside.push(itemB);
        _assertLedgersAgree();
        _assertGhostLedger();
    }

    // ================================================================================================ L4 ordering

    /// P5.10: inside one block the order of a collect, a settle-free opening, a claim and a transfer does not change
    /// any account's total (owed + paid): only swaps move X, and they are fixed here before the block's actions.
    function testProperty_AUDIT_U5_orderWithinABlockDoesNotChangeTotals() public {
        _toDrawing();
        _sell(eoa[3], token.balanceOf(eoa[3]) / 2);
        _buy(eoa[4], 0.6 ether);
        _advance(1);
        uint256 snap = vm.snapshotState();
        uint256[3][4] memory totals;
        for (uint256 order; order < 4; ++order) {
            if (order != 0) vm.revertToState(snap);
            uint256[4] memory seq = order == 0
                ? [uint256(0), 1, 2, 3]
                : (order == 1 ? [uint256(3), 2, 1, 0] : (order == 2 ? [uint256(1), 3, 0, 2] : [uint256(2), 0, 3, 1]));
            for (uint256 k; k < 4; ++k) {
                uint256 s = seq[k];
                if (s == 0) _collect(keeper, keeper);
                else if (s == 1) _openDraw(address(contractDrawer), drawB, address(contractDrawer), true);
                else if (s == 2) _claimStream(eoa[3], _ids(itemA));
                else _transferItem(eoa[0], eoa[1], itemP1);
            }
            // Everyone checkpointed and paid where possible.
            _claimStream(eoa[3], _ids(itemA));
            _claimStream(eoa[1], _ids(itemP1));
            _claimStreamFor(eoa[7], address(contractDrawer), _ids(tickets.drawTicket(drawB).itemId));
            totals[order][0] = stream.owedOf(eoa[3]) + token.balanceOf(eoa[3]);
            totals[order][1] = stream.owedOf(eoa[1]) + token.balanceOf(eoa[1]) + stream.owedOf(eoa[0]);
            totals[order][2] = stream.owedOf(address(contractDrawer)) + token.balanceOf(address(contractDrawer));
        }
        for (uint256 order = 1; order < 4; ++order) {
            for (uint256 i; i < 3; ++i) {
                assertEq(totals[order][i], totals[0][i], "the same total in every order");
            }
        }
    }

    // ================================================================================================ L5 gas

    /// P5.12: every observer path measured from cold stays under its cap (460,000; F90 R16H) with the margin logged,
    /// the notice with a burn under 200,000 (BoxSpecV1.STREAM_NOTIFY_GAS); the real deliveries, picks and returns
    /// never report a failed observer.
    function testProperty_AUDIT_U5_observerPathsWithinCaps() public {
        _toDrawing();
        uint256 cap = BoxCollection(a.collection).OBSERVER_GAS();
        uint256 noticeCap = BoxSpecV1.STREAM_NOTIFY_GAS;
        uint256 inside = vault.inside();
        uint256 g0;
        uint256[8] memory used;
        // (0) a draw's request: `_drawJ` written from zero, `_tix`, `_book`.
        vm.prank(a.vault);
        g0 = gasleft();
        stream.onVaultAction(VaultAction.TicketsOpened, a.tickets, 1, inside);
        used[0] = g0 - gasleft();
        // (1) a batch pick of 5, (2) a return of 2, (3) a hand-back release.
        vm.prank(a.vault);
        g0 = gasleft();
        stream.onVaultAction(VaultAction.Withdrawn, eoa[0], 5, inside - 1);
        used[1] = g0 - gasleft();
        vm.prank(a.vault);
        g0 = gasleft();
        stream.onVaultAction(VaultAction.Returned, eoa[0], 2, inside - 6);
        used[2] = g0 - gasleft();
        vm.prank(a.vault);
        g0 = gasleft();
        stream.onVaultAction(VaultAction.TicketsReleased, eoa[1], 1, inside - 4);
        used[3] = g0 - gasleft();
        // (4) a transfer between holders (owner's owed written from zero), (5) a placeholder's delivery.
        vm.prank(a.collection);
        g0 = gasleft();
        stream.onItemTransfer(eoa[3], eoa[7], itemA);
        used[4] = g0 - gasleft();
        uint256 item2 = tickets.numberOf(2);
        vm.prank(a.collection);
        g0 = gasleft();
        stream.onItemTransfer(a.vault, eoa[0], item2);
        used[5] = g0 - gasleft();
        // (6) the notice with a burn, (7) without.
        _transferT(eoa[4], a.itemStream, 1e21);
        vm.prank(a.receiver);
        g0 = gasleft();
        stream.onStreamFunds(1e21);
        used[6] = g0 - gasleft();
        vm.prank(a.receiver);
        g0 = gasleft();
        stream.onStreamFunds(0);
        used[7] = g0 - gasleft();
        string[8] memory names = [
            "onVaultAction TicketsOpened (draw)",
            "onVaultAction Withdrawn x5",
            "onVaultAction Returned x2",
            "onVaultAction TicketsReleased",
            "onItemTransfer holder->holder (cold)",
            "onItemTransfer vault->holder (placeholder path)",
            "onStreamFunds with a burn",
            "onStreamFunds without a burn"
        ];
        for (uint256 i; i < 8; ++i) {
            emit log_named_uint(names[i], used[i]);
            uint256 limit = i < 6 ? cap : noticeCap;
            assertLe(used[i] * 3, limit * 2, "at most two thirds of its cap");
        }
    }

    /// The real paths (an opening with its reveal, a transfer, a return, a pick, a take by number in terminal mode)
    /// never report `TransferObserverFailed` or `VaultObserverFailed`: every observer call fit its cap.
    function testProperty_AUDIT_U5_realDeliveriesNeverFailTheirObservers() public {
        _toDrawing();
        vm.recordLogs();
        _openDraw(address(contractDrawer), drawB, address(contractDrawer), true);
        _open(eoa[0], 2, true);
        _transferItem(eoa[3], eoa[4], itemA);
        _returnItem(eoa[4], itemA);
        _pick(eoa[2], itemA);
        _toTerminal();
        _warpTo(uint256(tickets.status().terminalAt) + tickets.TAKE_DELAY() + 1);
        (uint256 item, bool hidden) = _poolItem(0);
        assertTrue(hidden);
        _takeByNumber(eoa[2], item, 0, false);
        _cancelDraw(eoa[5], drawC);
        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(
                logs[i].topics[0] != IBoxCollection.TransferObserverFailed.selector, "a transfer observer failed"
            );
            assertTrue(logs[i].topics[0] != IBoxVault.VaultObserverFailed.selector, "a vault observer failed");
        }
        _assertGhostLedger();
    }

    /// P5.12: `claim(ids)` gas grows linearly in the number of ids; the slope is measured over 1, 2, 4, 8 and 16 items
    /// held by one account (taken by number in terminal mode, no reveal needed) and pinned under a bound.
    function testProperty_AUDIT_U5_claimGasLinearInIds() public {
        _toTerminal();
        _warpTo(uint256(tickets.status().terminalAt) + tickets.TAKE_DELAY() + 1);
        uint256[] memory mine = new uint256[](16);
        uint256 got;
        for (uint256 idx; got < 16 && idx < 200; ++idx) {
            (uint256 item, bool hidden) = _poolItem(idx);
            if (!hidden) continue;
            _takeByNumber(eoa[2], item, idx, false);
            mine[got++] = item;
        }
        assertEq(got, 16);
        _sell(eoa[4], token.balanceOf(eoa[4]) / 2);
        _collectFunded(keeper);
        uint256[5] memory ks = [uint256(1), 2, 4, 8, 16];
        uint256[5] memory gas;
        for (uint256 i; i < 5; ++i) {
            uint256[] memory ids = new uint256[](ks[i]);
            for (uint256 j; j < ks[i]; ++j) {
                ids[j] = mine[j];
            }
            uint256 snap = vm.snapshotState();
            vm.prank(eoa[2]);
            uint256 g0 = gasleft();
            stream.claim(ids, eoa[2]);
            gas[i] = g0 - gasleft();
            vm.revertToState(snap);
            emit log_named_uint(string.concat("claim gas, ids = ", vm.toString(ks[i])), gas[i]);
        }
        uint256 slope = (gas[4] - gas[3]) / 8;
        emit log_named_uint("slope per id (8 -> 16)", slope);
        assertLt(slope, 16_000, "under 16k gas per id");
        for (uint256 i = 1; i < 5; ++i) {
            assertLe(gas[i], gas[0] + 16_000 * (ks[i] - 1), "linear bound");
        }
    }

    // ================================================================================================ L7 arithmetic

    /// P5.14: per batch the stream attributes N·J of the X − X₀ it saw and keeps the rest as dust below N raw units
    /// (never paid twice: the two ledgers agree and the burn takes only what no owner can claim); the packed fields fit
    /// the stated lifetime (J < 2^96 would need N·2^96 raw T through the stream: 155,993 whole issuances).
    function testProperty_AUDIT_U5_perItemFlooringDustBoundedAndWidthsFit() public {
        _toDrawing();
        _track();
        for (uint256 i; i < 3; ++i) {
            _sell(eoa[3], token.balanceOf(eoa[3]) / 3);
            _collectFunded(keeper);
            uint256 x = stream.streamValue();
            uint256 x0 = stream.startValue();
            uint256 j = stream.index();
            assertEq(j, (x - x0) / editionSize, "J = floor((X - X0) / N)");
            assertLt(x - x0 - j * editionSize, editionSize, "dust below N");
            _assertLedgersAgree();
        }
        uint256 n = editionSize;
        uint256 jMax = (uint256(1) << 96) - 1;
        assertGe(jMax * n / BoxSpecV1.ISSUANCE, 155_993, "whole issuances needed before J overflows its 96 bits");
        assertLt(BoxSpecV1.ISSUANCE, uint256(1) << 120, "claimed and burned (120 bits) hold more than the issuance");
        assertLe(n * jMax, (uint256(1) << 128) - 1, "the open draws' index sum (128 bits) holds N x J_max");
        assertLe(n * jMax, (uint256(1) << 127) - 1, "the booked accrual (127 bits) holds N x J_max");
        assertLe(n, (uint256(1) << 32) - 1, "m, placeholders and draws (32 bits) hold N");
    }

    // ================================================================================================ L8 wiring

    /// The stream is box 0's own: a clone of the version's implementation, wired to box 0's coordinator, T, collection,
    /// vault, tickets, receiver and hook with N and the first id; the receiver, the collection and the vault name it.
    function testProperty_AUDIT_U5_streamIsBoxZerosOwn() public view {
        assertTrue(BoxClones.isCloneOf(a.itemStream, kit.impls().itemStream), "a clone of the implementation");
        assertEq(stream.coordinatorImplementation(), kit.impls().coordinator);
        assertEq(stream.coordinator(), a.coordinator);
        assertEq(stream.poolManager(), address(pm));
        assertEq(stream.token(), a.token);
        assertEq(stream.collection(), a.collection);
        assertEq(stream.vault(), a.vault);
        assertEq(stream.tickets(), a.tickets);
        assertEq(stream.receiver(), a.receiver);
        assertEq(stream.hook(), a.hook);
        assertEq(stream.collectionSize(), editionSize);
        assertEq(stream.firstId(), tickets.firstId());
        assertEq(receiver.itemStream(), a.itemStream, "the receiver names it");
        assertEq(collection.transferObserver(), a.itemStream, "the collection names it");
        assertEq(vault.observer(), a.itemStream, "the vault names it");
        assertEq(coordinator.itemStream(), a.itemStream, "the coordinator names it");
        assertEq(BoxVault(a.vault).observerGas(), BoxCollection(a.collection).OBSERVER_GAS());
        assertEq(BoxCollection(a.collection).OBSERVER_GAS(), 460_000, "F90 R16H");
    }
}
