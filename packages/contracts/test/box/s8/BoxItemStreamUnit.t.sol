// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {BoxItemStream} from "../../../src/box/BoxItemStream.sol";
import {VaultAction} from "../../../src/box/interfaces/BoxTypes.sol";
import {IBoxItemStream} from "../../../src/box/interfaces/IBoxItemStream.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";
import {BoxItemStreamHarness, S8CoordinatorImpl, S8World} from "./BoxS8World.sol";

/// @notice S8 units: the stream's rules one by one on the test world (BoxS8World: the stream's pool read replaced by a
/// value the test sets; the real read is BoxItemStreamLife's). N = 10 and fees in multiples of 150 raw units, so the
/// index moves by whole numbers: a fee of 150·k is 13·k per item after graduation (13/15, ÷ N).
contract BoxItemStreamUnitTest is Test {
    S8World internal w;
    BoxItemStreamHarness internal s;
    address internal alice = makeAddr("s8.alice");
    address internal bob = makeAddr("s8.bob");
    address internal carol = makeAddr("s8.carol");
    bytes32 internal constant WORD = keccak256("s8.unit.word");

    function setUp() public {
        w = new S8World(10, 1);
        w.boot();
        s = w.stream();
    }

    function _ids(uint256 a) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = a;
    }

    function _ids(uint256 a, uint256 b) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](2);
        (ids[0], ids[1]) = (a, b);
    }

    /// Fees of 150·k raw T after graduation: the index rises by 13·k (13/15 to the stream, ÷ N = 10).
    function _fee(uint256 k) internal {
        w.fee(150 * k);
    }

    /// An item that left the vault once and came back (a shelf item, as a named pick needs).
    function _shelfItem(address via) internal returns (uint256 id) {
        w.draw();
        id = w.openDraw(via);
        w.returnItems(via, _ids(id));
    }

    // ------------------------------------------------------------------------------------------------ initialise

    function test_initialize_onlyTheCoordinatorsCloneOnce() public {
        S8World x = new S8World(10, 1);
        BoxItemStreamHarness st = x.stream();
        vm.expectRevert(abi.encodeWithSelector(IBoxItemStream.NotCoordinator.selector, address(this)));
        st.initialize();
        // A clone of another implementation named as the coordinator is refused too (BC-100).
        address impostor = BoxClones.create(BoxClones.initCode(address(new S8CoordinatorImpl()), ""));
        vm.prank(impostor);
        vm.expectRevert(abi.encodeWithSelector(IBoxItemStream.NotCoordinator.selector, impostor));
        st.initialize();
        x.boot();
        vm.expectRevert(IBoxItemStream.AlreadyInitialised.selector);
        x.boot();
    }

    function test_initialize_refusesWiringThatDoesNotNameIt() public {
        bytes4[7] memory views = [
            S8World.itemStream.selector,
            S8World.q.selector,
            S8World.transferObserver.selector,
            S8World.observer.selector,
            S8World.ticketAdapter.selector,
            S8World.collectionSize.selector,
            S8World.curve.selector
        ];
        uint256[7] memory code = [uint256(1), 2, 3, 4, 5, 6, 7];
        for (uint256 i; i < views.length; ++i) {
            S8World x = new S8World(10, 1);
            bytes memory wrong = i == 6 ? abi.encode(int24(-160), int24(100), uint128(0)) : abi.encode(uint256(0xbad));
            vm.mockCall(address(x), abi.encodeWithSelector(views[i]), wrong);
            vm.expectRevert(abi.encodeWithSelector(IBoxItemStream.WiringMismatch.selector, code[i]));
            x.boot();
            vm.clearMockedCalls();
        }
    }

    function test_entryPoints_refuseStrangers() public {
        vm.expectRevert(abi.encodeWithSelector(IBoxItemStream.NotCollection.selector, address(this)));
        s.onItemTransfer(address(w), alice, 1);
        vm.expectRevert(abi.encodeWithSelector(IBoxItemStream.NotVault.selector, address(this)));
        s.onVaultAction(VaultAction.Withdrawn, alice, 1, 10);
        vm.expectRevert(abi.encodeWithSelector(IBoxItemStream.NotReceiver.selector, address(this)));
        s.onStreamFunds(1);
        // An uninitialised clone refuses every state-changing entry point but the observers' callers' checks.
        S8World x = new S8World(10, 1);
        BoxItemStreamHarness st = x.stream();
        vm.expectRevert(IBoxItemStream.NotInitialised.selector);
        st.burn();
        vm.expectRevert(IBoxItemStream.NotInitialised.selector);
        st.onGraduation();
        vm.expectRevert(IBoxItemStream.NotInitialised.selector);
        st.claim(new uint256[](0), alice);
    }

    // ------------------------------------------------------------------------------------------------ the start

    function test_onGraduation_onceAfterGraduation_runsTheSettlementFirst() public {
        vm.expectRevert(IBoxItemStream.NotGraduated.selector);
        s.onGraduation();
        assertFalse(w.settled());
        w.graduate(WORD);
        assertTrue(w.settled(), "the receiver settled before the start");
        assertTrue(s.started());
        vm.expectRevert(IBoxItemStream.AlreadyStarted.selector);
        s.onGraduation();
    }

    /// G07 point 4: before graduation the T side is burned in full; what reaches the stream before its start (the
    /// settlement's split of the curve's last fees) is burned at once, and nothing accrues to anyone.
    function test_beforeTheStart_arrivalsBurnAndNothingAccrues() public {
        w.take(3);
        _fee(10);
        uint256 sent = w.collect();
        assertEq(sent, 1_300);
        (, uint256 burned) = s.totals();
        assertEq(burned, 1_300, "burned at once: no owner before the start");
        assertEq(w.token().balanceOf(address(s)), 0);
        assertEq(s.index(), 0);
        w.graduate(WORD);
        assertEq(s.startValue(), 1_300, "X0: what arrived before");
        assertEq(s.index(), 0, "accrual counts from here");
        assertEq(s.liabilities(), 0);
    }

    // ------------------------------------------------------------------------------------------------ placeholders, draws

    /// G07 point 4 (BC-065): a placeholder's share starts at graduation and passes to the Misfit when it is opened.
    function test_BC065_placeholderShareFromGraduationPassesToItsMisfit() public {
        w.take(2);
        w.graduate(WORD);
        assertEq(s.outsideCount(), 2, "open placeholders are outside");
        _fee(10); // J 130
        uint256 id = w.openPlaceholder(alice);
        (address owner, uint256 pending) = s.pendingOf(id);
        assertEq(owner, alice);
        assertEq(pending, 130, "its whole share since graduation");
        assertEq(s.liabilities(), 260, "the other placeholder accrues too");
        _fee(10); // J 260
        w.transfer(alice, bob, id);
        assertEq(s.owedOf(alice), 260, "the opener earned from graduation on");
        (, pending) = s.pendingOf(id);
        assertEq(pending, 0, "the buyer starts now");
    }

    /// A draw's share starts at its request (G07 point 4) and passes to its Misfit at the opening.
    function test_drawShareFromItsRequest() public {
        w.graduate(WORD);
        _fee(10); // J 130
        w.draw();
        _fee(5); // J 195
        uint256 id = w.openDraw(alice);
        (, uint256 pending) = s.pendingOf(id);
        assertEq(pending, 65, "only since its request");
    }

    /// Several open draws: each opening starts its item at its own ticket's J at request, in any order (R1, Codex review
    /// 2026-10-07; the open draws' mean before, 195 for both here); the open draws' J sum stays exact.
    function test_concurrentDraws_eachFromItsOwnRequest() public {
        w.graduate(WORD);
        uint256 t1 = w.draw(); // at J 0
        _fee(10); // J 130
        uint256 t2 = w.draw(); // at J 130
        (, uint256 d, uint256 sum) = s.openTickets();
        assertEq(d, 2);
        assertEq(sum, 130);
        _fee(10); // J 260
        uint256 first = w.openDrawTicket(t2, alice); // the later request opens first
        (, uint256 a) = s.pendingOf(first);
        assertEq(a, 130, "since its own request: 260 - 130");
        (, d, sum) = s.openTickets();
        assertEq(d, 1);
        assertEq(sum, 0, "the other draw's J at request is left");
        uint256 second = w.openDrawTicket(t1, bob);
        (, uint256 b) = s.pendingOf(second);
        assertEq(b, 260, "since its own request: 260 - 0");
    }

    // ------------------------------------------------------------------------------------------------ the vault's calls

    /// A named pick starts at its vault call (before n changes), even when a fee lands before its item's transfer.
    function test_namedPick_startsAtItsVaultCall() public {
        w.graduate(WORD);
        uint256 x = _shelfItem(carol);
        uint256 y = _shelfItem(carol);
        _fee(10); // J 130
        w.withdrawWithFeeBetween(alice, _ids(x, y), 1_500); // +130 between the deliveries
        (, uint256 px) = s.pendingOf(x);
        (, uint256 py) = s.pendingOf(y);
        assertEq(px, 130);
        assertEq(py, 130, "outside from the vault call, not from its transfer");
    }

    function test_return_booksTheHolderAndClears() public {
        w.graduate(WORD);
        w.draw();
        uint256 id = w.openDraw(alice);
        _fee(10);
        w.returnItems(alice, _ids(id));
        assertEq(s.owedOf(alice), 130);
        (address owner, uint256 pending) = s.pendingOf(id);
        assertEq(owner, address(0), "inside: no record");
        assertEq(pending, 0);
        assertEq(s.outsideCount(), 0);
        _fee(10);
        assertEq(s.owedOf(alice), 130, "nothing more while inside");
    }

    function test_transfer_booksTheSellerOnly() public {
        w.graduate(WORD);
        w.draw();
        uint256 id = w.openDraw(alice);
        _fee(10);
        vm.recordLogs();
        w.transfer(alice, bob, id);
        assertEq(s.owedOf(alice), 130);
        assertEq(s.owedOf(bob), 0);
        _fee(20);
        (address owner, uint256 pending) = s.pendingOf(id);
        assertEq(owner, bob);
        assertEq(pending, 260);
    }

    /// A transfer the observer missed (a skipped call): the next checkpoint repairs the record; the accrual since the last
    /// checkpoint goes to the owner it recorded (SH-S8-stream § 3).
    function test_missedCheckpoint_repairedToTheRecordedOwner() public {
        w.graduate(WORD);
        w.draw();
        uint256 id = w.openDraw(alice);
        _fee(10);
        w.transferSkippingObserver(alice, bob, id);
        _fee(10);
        vm.expectEmit(address(s));
        emit IBoxItemStream.CheckpointRepaired(id, alice, bob);
        w.transfer(bob, carol, id);
        assertEq(s.owedOf(alice), 260, "the recorded owner");
        assertEq(s.owedOf(bob), 0);
        (address owner,) = s.pendingOf(id);
        assertEq(owner, carol, "the record names the actual holder again");
    }

    // ------------------------------------------------------------------------------------------------ claims, burns

    /// REV-01: a claim never pays more than the stream holds; the rest stays owed until the next batch; one raw unit stays
    /// booked so the owner's slot never returns to zero.
    function test_claim_paysWhatIsHeld_restWaits_keepsOneRawUnit() public {
        w.graduate(WORD);
        w.draw();
        uint256 id = w.openDraw(alice);
        _fee(100); // J 1,300 on fees not yet collected
        vm.prank(alice);
        uint256 paid = s.claim(_ids(id), alice);
        assertEq(paid, 0, "nothing held yet");
        assertEq(s.owedOf(alice), 1_300);
        w.collect(); // 13,000 arrive, of which the inside share (9 items) is burned down to alice's 1,300 + the margin
        assertEq(w.token().balanceOf(address(s)), 1_301, "her accrual plus one raw unit for her outside slot");
        vm.prank(alice);
        paid = s.claim(new uint256[](0), carol);
        assertEq(paid, 1_299, "all but the one raw unit kept booked");
        assertEq(w.token().balanceOf(carol), 1_299, "to the address she named");
        assertEq(s.owedOf(alice), 1);
    }

    function test_claimFor_paysTheOwnerItself_contractsIncluded_andRefusals() public {
        w.graduate(WORD);
        address vaultLike = address(new Holder());
        w.draw();
        uint256 id = w.openDraw(vaultLike);
        _fee(10);
        w.collect();
        uint256 paid = s.claimFor(vaultLike, _ids(id));
        assertEq(paid, 129);
        assertEq(w.token().balanceOf(vaultLike), 129, "paid to the contract owner itself");
        vm.expectRevert(abi.encodeWithSelector(IBoxItemStream.NotOwner.selector, id, alice));
        s.claimFor(alice, _ids(id));
        vm.expectRevert(IBoxItemStream.SelfClaim.selector);
        s.claimFor(address(s), new uint256[](0));
        vm.prank(alice);
        vm.expectRevert(IBoxItemStream.SelfClaim.selector);
        s.claim(new uint256[](0), address(s));
        vm.expectRevert(IBoxItemStream.ZeroAddress.selector);
        s.claimFor(address(0), new uint256[](0));
        // The vault holds what is inside: it never earns.
        vm.expectRevert(abi.encodeWithSelector(IBoxItemStream.NotOwner.selector, uint256(2), address(w)));
        s.claimFor(address(w), _ids(2));
    }

    /// The items-inside share is burned in the receiver's notice; a burn the vault's floor refuses waits (BC-016's rule).
    function test_burn_insideShare_andARefusedBurnWaits() public {
        w.graduate(WORD);
        w.draw();
        w.openDraw(alice);
        _fee(100); // 13,000 to the stream at the next batch; 1,300 alice's
        w.token().setRefuseBurns(true);
        vm.recordLogs();
        w.collect();
        assertEq(w.token().balanceOf(address(s)), 13_000, "refused: it waits");
        (, uint256 burned) = s.totals();
        assertEq(burned, 0);
        w.token().setRefuseBurns(false);
        assertEq(s.burn(), 13_000 - 1_300 - 1, "anyone's burn later");
        (, burned) = s.totals();
        assertEq(burned, 11_699);
    }

    /// T given to the stream directly is shared at arrival, per slot, like a fee.
    function test_gift_sharedAtArrival() public {
        w.graduate(WORD);
        w.draw();
        uint256 id = w.openDraw(alice);
        w.gift(1_000);
        (, uint256 pending) = s.pendingOf(id);
        assertEq(pending, 100);
    }

    /// X never falls: the index is continuous across the receiver's batches (13/15 sent, the carry kept as pending).
    function test_index_continuousAcrossBatches() public {
        w.graduate(WORD);
        w.fee(1_234_567);
        uint256 j0 = s.index();
        w.collect();
        assertEq(s.index(), j0, "unchanged by the batch");
        w.fee(7);
        assertGe(s.index(), j0);
        w.collect();
        assertGe(s.index(), j0);
    }

    // ------------------------------------------------------------------------------------------------ terminal mode

    function test_takeByNumber_startsNow() public {
        w.graduate(WORD);
        _fee(10);
        w.enterTerminal(true);
        uint256 id = w.takeByNumber(alice, 9);
        (address owner, uint256 pending) = s.pendingOf(id);
        assertEq(owner, alice);
        assertEq(pending, 0, "outside from now");
    }

    /// Terminal mode with the word stored: a draw's cancel (its ticket in flight) is booked from its request.
    function test_terminal_cancelBookedFromItsRequest() public {
        w.take(1);
        w.graduate(WORD);
        _fee(10);
        uint256 t = w.draw(); // J 130
        _fee(10); // J 260
        w.enterTerminal(true);
        w.cancelDraw(t, bob);
        assertEq(s.owedOf(bob), 130, "from its request");
    }

    /// Terminal mode without the word: placeholders handed back are booked from graduation, a draw's cancel from its own
    /// request; the ticket in flight tells them apart (R1: the tie-break by the release's size is gone).
    function test_terminal_handBacksFromGraduation_cancelFromItsRequest() public {
        w.take(2);
        w.graduate(WORD);
        _fee(10); // J 130
        uint256 t = w.draw(); // a draw at J 130
        _fee(10); // J 260
        w.enterTerminal(false);
        w.releaseTickets(alice, 1); // one placeholder, a draw open
        assertEq(s.owedOf(alice), 260, "a placeholder: from graduation");
        uint256 before = s.liabilities();
        w.cancelDraw(t, bob);
        assertEq(s.owedOf(bob), 130, "the cancel: from its request");
        assertEq(s.liabilities(), before, "nothing lost");
        w.releaseTickets(carol, 1);
        assertEq(s.owedOf(carol), 260);
    }
}

contract Holder {}
