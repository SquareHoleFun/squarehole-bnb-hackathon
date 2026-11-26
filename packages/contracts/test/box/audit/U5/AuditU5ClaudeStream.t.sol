// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxClones} from "../../../../src/box/libraries/BoxClones.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {BoxTickets} from "../../../../src/box/BoxTickets.sol";
import {VaultAction} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxItemStream} from "../../../../src/box/interfaces/IBoxItemStream.sol";
import {TIn, TOut} from "../common/AuditGhostLedger.sol";
import {AuditU5ClaudeBase} from "./AuditU5ClaudeBase.sol";

/// @title AuditU5ClaudeStreamTest
/// @notice SH-AUDIT-B0 U5 (Claude): box 0's per-item stream (`src/box/BoxItemStream.sol`, `IBoxItemStream.sol`) on the
/// factory's box 0 in the shared world's Drawing phase: the graduation word accepted, draw A opened by eoa[3]
/// (`itemA`), draw B settled for the contract drawer (`itemB`, in the vault), placeholder 1 opened by eoa[0]
/// (`itemP1`), placeholders 2-3 (eoa[0]) and 4-5 (eoa[1]) open: seven slots outside (m = 7), X = X₀ = 0, J = 0 (no swap
/// since graduation). Lenses L1-L7 of the U5 brief for the stream; the start's order (P5.7) is in
/// `AuditU5ClaudeStreamStart.t.sol`, the observer gas (P5.12) in `AuditU5ClaudeGas.t.sol`.
/// forge-config: default.evm_version = "osaka"
contract AuditU5ClaudeStreamTest is AuditU5ClaudeBase {
    function setUp() public override {
        super.setUp();
        _toDrawing();
    }

    /// A sell of `t` T by eoa[2] (its T fee raises X) and a buy big enough for a fee batch, then the batch.
    function _feesAndBatch(uint256 t) internal {
        if (t != 0) _sell(eoa[2], t);
        _buy(eoa[4], 0.6 ether);
        _collect(keeper, keeper);
    }

    function _ids(uint256 a0) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = a0;
    }

    function _ids(uint256 a0, uint256 a1) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](2);
        (ids[0], ids[1]) = (a0, a1);
    }

    /// What `account` has from the stream: paid (its T rise from claims is booked by the caller), booked, and the
    /// accrual on `ids` (items recorded to it).
    function _owedAndPending(address account, uint256[] memory ids) internal view returns (uint256 total) {
        total = stream.owedOf(account);
        for (uint256 i; i < ids.length; ++i) {
            (address o, uint256 p) = stream.pendingOf(ids[i]);
            if (o == account) total += p;
        }
    }

    // ================================================================================================ L1

    /// P5.3 (BoxItemStream.sol:29-36; IBoxItemStream.sol:41-48): X never falls and moves only by a swap's T fee or a
    /// gift. Each step of a life (sells of any size, buys, fee batches, Misfit transfers, claims, claimFor, burns, T
    /// gifts, time) keeps X equal to its StateLibrary rebuild, never lowers it, leaves it exactly unchanged on every
    /// step that is neither a sell nor a gift, and keeps J = ⌊(X − X₀)/N⌋ non-decreasing; F (T received) is
    /// balance + claimed + burned and changes only by arrivals (batches, gifts).
    function testFuzz_AUDIT_U5_streamValueNeverFallsAndJFollowsIt(uint256 seed) public {
        uint256 lastX = stream.streamValue();
        uint256 lastJ = stream.index();
        for (uint256 i; i < 24; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            uint256 op = r % 9;
            uint256 x0 = stream.streamValue();
            uint256 f0 = _streamF();
            bool moves; // a sell or a gift may raise X
            bool arrives; // a batch or a gift may raise F
            if (op == 0) {
                _sell(eoa[2], 1 + (r >> 8) % 3_000_000 ether);
                moves = true;
            } else if (op == 1) {
                _buy(eoa[4], 1e12 + (r >> 8) % 0.3 ether);
            } else if (op == 2) {
                _buy(eoa[4], 0.6 ether);
                _collect(keeper, keeper);
                arrives = true;
            } else if (op == 3) {
                address to = (r >> 8) & 1 == 0 ? eoa[5] : eoa[3];
                address from = collection.ownerOf(itemA);
                if (from != to) {
                    vm.prank(from);
                    collection.transferFrom(from, to, itemA);
                }
            } else if (op == 4) {
                _claimStream(eoa[0], _ids(itemP1));
            } else if (op == 5) {
                _claimStreamFor(eoa[6], collection.ownerOf(itemA), _ids(itemA));
            } else if (op == 6) {
                vm.prank(eoa[(r >> 8) % 8]);
                stream.burn();
            } else if (op == 7) {
                _transferT(eoa[2], a.itemStream, 1 + (r >> 8) % 1e21);
                moves = true;
                arrives = true;
            } else {
                _advance(1 + (r >> 8) % 20);
            }
            uint256 x1 = stream.streamValue();
            assertEq(x1, _refX(), "X == its StateLibrary rebuild");
            assertGe(x1, lastX, "X never falls");
            if (!moves) assertEq(x1, x0, "X moves only by a swap's fee or a gift");
            uint256 j = stream.index();
            assertEq(j, (x1 - stream.startValue()) / editionSize, "J = (X - X0) / N");
            assertGe(j, lastJ, "J never falls");
            uint256 f1 = _streamF();
            if (!arrives) assertEq(f1, f0, "F changes only by arrivals");
            else assertGe(f1, f0);
            (lastX, lastJ) = (x1, j);
        }
        _assertGhostLedger();
    }

    /// R1 (docs/reviews/ARCHITECTURE-AND-PLAN-REVIEW-2026-10-07.md:79; BoxItemStream.sol:527-535): each draw earns
    /// only from its own request. Draw B (the contract drawer's, requested before any fee) and a new draw D (eoa[4]'s,
    /// requested after fees) are opened after more fees: B's Misfit carries exactly J − J(B's request) = J, D's
    /// exactly J − J(D's request); neither carries what accrued before its own request.
    function testProperty_AUDIT_U5_eachDrawEarnsOnlyFromItsOwnRequest() public {
        _feesAndBatch(4_000_000 ether);
        uint256 jReqD = stream.index();
        assertGt(jReqD, 0, "fees before D's request");
        uint256 d = _draw(eoa[4], AUDIT_DRAW_VALUE);
        (, uint64 round) = src.requestOf(a.tickets, d);
        assertEq(round, r0 + 12, "a committed round");
        (,, uint256 sum) = stream.openTickets();
        assertEq(sum, 0 + jReqD, "the open draws' J at request: B's 0 and D's");
        _feesAndBatch(2_500_000 ether);
        _advance(1);
        _post(r0 + 12);
        _settle(keeper, 1);
        uint256 itemD = _openDraw(eoa[4], d, eoa[4], true);
        vm.prank(address(contractDrawer));
        contractDrawer.exec(
            a.tickets, 0, abi.encodeCall(BoxTickets.openDraw, (drawB, address(contractDrawer), _reveal(itemB)))
        );
        uint256 j = stream.index();
        (address oD, uint256 pD) = stream.pendingOf(itemD);
        (address oB, uint256 pB) = stream.pendingOf(itemB);
        assertEq(oD, eoa[4]);
        assertEq(oB, address(contractDrawer));
        assertEq(pD, j - jReqD, "D: from its own request only");
        assertEq(pB, j, "B: from its own request (before any fee)");
        (, uint256 draws,) = stream.openTickets();
        assertEq(draws, 0, "both draws taken off the open draws");
    }

    /// P5.3 (IBoxItemStream.sol:49-54): items inside the vault earn nothing and have no record; after a batch the
    /// stream burns their share, keeping exactly the owners' accrual not yet paid plus one raw unit per outside slot;
    /// a second burn right after burns nothing.
    function testProperty_AUDIT_U5_insideItemsEarnNothingAndOnlySurplusIsBurned() public {
        uint256 inside = a.vault == collection.ownerOf(itemB) ? itemB : 0;
        assertEq(inside, itemB, "draw B's Misfit waits in the vault");
        _feesAndBatch(3_000_000 ether);
        (address o, uint256 p) = stream.pendingOf(itemB);
        assertEq(o, address(0));
        assertEq(p, 0, "an item inside has no record");
        uint256 held = token.balanceOf(a.itemStream);
        assertEq(held, stream.liabilities() + stream.outsideCount(), "after the batch: owners' accrual + m");
        (, uint256 burned0) = stream.totals();
        vm.prank(eoa[6]);
        assertEq(stream.burn(), 0, "nothing more to burn");
        (, uint256 burned1) = stream.totals();
        assertEq(burned1, burned0);
        // The burned share is the inside slots' (N − m of N), to J's flooring and the margin.
        uint256 s = stream.streamValue() - stream.startValue();
        uint256 m = stream.outsideCount();
        uint256 insideShare = (s / editionSize) * (editionSize - m);
        assertApproxEqAbs(burned1, insideShare, editionSize + m, "burned = the inside share (to N + m raw units)");
    }

    /// P5.4 (IBoxItemStream.sol:105-111; BoxItemStream.sol:655-682): `claim(ids, to)` books only ids the caller owns
    /// (another's reverts `NotOwner`) and pays `to`; `claimFor(account, ids)` books only `account`'s ids and pays
    /// `account` itself, whoever calls; a repeated id in one call pays once; a claim keeps 1 raw unit booked.
    function testProperty_AUDIT_U5_claimsPayOnlyTheOwnerAndARepeatedIdOnce() public {
        _feesAndBatch(3_000_000 ether);
        uint256 j = stream.index();
        // Another's id: refused.
        vm.prank(eoa[5]);
        vm.expectRevert(abi.encodeWithSelector(IBoxItemStream.NotOwner.selector, itemA, eoa[5]));
        stream.claim(_ids(itemA), eoa[5]);
        // A repeated id pays once.
        uint256 t0 = token.balanceOf(eoa[5]);
        uint256 t3 = token.balanceOf(eoa[3]);
        vm.prank(eoa[3]);
        uint256 paid = stream.claim(_ids(itemA, itemA), eoa[5]);
        _noteTChange(t0, token.balanceOf(eoa[5]), TIn.Other, TOut.StreamClaim);
        assertEq(paid, j - 1, "J since the open, once, less the 1 raw unit kept");
        assertEq(stream.owedOf(eoa[3]), 1, "1 raw unit stays booked");
        assertEq(token.balanceOf(eoa[5]), t0 + paid, "paid to `to`");
        assertEq(token.balanceOf(eoa[3]), t3, "nothing to the caller");
        // claimFor by a stranger pays the owner itself.
        uint256 e0 = token.balanceOf(eoa[0]);
        uint256 s6 = token.balanceOf(eoa[6]);
        paid = _claimStreamFor(eoa[6], eoa[0], _ids(itemP1));
        assertEq(paid, j - 1, "the placeholder's Misfit: J since graduation");
        assertEq(token.balanceOf(eoa[0]), e0 + paid, "paid to the owner");
        assertEq(token.balanceOf(eoa[6]), s6, "nothing to the stranger");
        vm.expectRevert(abi.encodeWithSelector(IBoxItemStream.NotOwner.selector, itemA, eoa[0]));
        stream.claimFor(eoa[0], _ids(itemA));
        // The edges: the vault, the stream itself, zero.
        vm.expectRevert(abi.encodeWithSelector(IBoxItemStream.NotOwner.selector, itemB, a.vault));
        stream.claimFor(a.vault, _ids(itemB));
        vm.expectRevert(IBoxItemStream.SelfClaim.selector);
        stream.claimFor(a.itemStream, new uint256[](0));
        vm.prank(eoa[3]);
        vm.expectRevert(IBoxItemStream.SelfClaim.selector);
        stream.claim(new uint256[](0), a.itemStream);
        vm.prank(eoa[3]);
        vm.expectRevert(IBoxItemStream.ZeroAddress.selector);
        stream.claim(new uint256[](0), address(0));
        vm.expectRevert(IBoxItemStream.ZeroAddress.selector);
        stream.claimFor(address(0), new uint256[](0));
        _assertGhostLedger();
    }

    /// F61 X1 and the 2026-10-21 EIP-7702 measurement: an EIP-7702 EOA earns and is paid like any owner on either fork
    /// (the stream pays T, an ERC-20 transfer, and sends no ETH), by `claim` from itself and by anyone's `claimFor`; a
    /// contract owner (the contract drawer) is paid by `claimFor` too.
    function testProperty_AUDIT_U5_aDelegatedEoaAndAContractOwnerArePaid() public {
        vm.prank(eoa[3]);
        collection.transferFrom(eoa[3], eoa7702, itemA);
        vm.prank(address(contractDrawer));
        contractDrawer.exec(
            a.tickets, 0, abi.encodeCall(BoxTickets.openDraw, (drawB, address(contractDrawer), _reveal(itemB)))
        );
        _feesAndBatch(3_000_000 ether);
        uint256 j = stream.index();
        uint256 t0 = token.balanceOf(eoa7702);
        vm.prank(eoa7702);
        uint256 paid = stream.claim(_ids(itemA), eoa7702);
        assertEq(paid, j - 1, "the 7702 EOA paid its Misfit's accrual");
        assertEq(token.balanceOf(eoa7702), t0 + paid);
        _feesAndBatch(1_000_000 ether);
        uint256 more = _claimStreamFor(eoa[1], eoa7702, _ids(itemA));
        assertEq(more, stream.index() - j, "and by anyone's claimFor (its 1 raw unit paid with the rest)");
        uint256 c0 = token.balanceOf(address(contractDrawer));
        uint256 cp = _claimStreamFor(eoa[1], address(contractDrawer), _ids(itemB));
        assertGt(cp, 0);
        assertEq(token.balanceOf(address(contractDrawer)), c0 + cp, "a contract owner is paid by claimFor");
    }

    // ================================================================================================ L2

    /// P5.5 (BoxItemStream.sol:149-150, :169-171, :187-190, :121-126): `onStreamFunds` only from the receiver,
    /// `onItemTransfer` only from the collection, `onVaultAction` only from the vault, `initialize` only from the
    /// coordinator clone and only once; every other caller is refused with its error and nothing changes.
    function testFuzz_AUDIT_U5_eachHookPointOnlyFromItsCaller(address caller) public {
        vm.assume(caller != a.receiver && caller != a.collection && caller != a.vault && caller != a.coordinator);
        uint256 x0 = stream.streamValue();
        uint256 inside = vault.inside();
        vm.startPrank(caller);
        vm.expectRevert(abi.encodeWithSelector(IBoxItemStream.NotReceiver.selector, caller));
        stream.onStreamFunds(1);
        vm.expectRevert(abi.encodeWithSelector(IBoxItemStream.NotCollection.selector, caller));
        stream.onItemTransfer(eoa[3], caller, itemA);
        vm.expectRevert(abi.encodeWithSelector(IBoxItemStream.NotVault.selector, caller));
        stream.onVaultAction(VaultAction.Withdrawn, caller, 1, inside);
        vm.expectRevert(abi.encodeWithSelector(IBoxItemStream.NotCoordinator.selector, caller));
        stream.initialize();
        vm.stopPrank();
        vm.prank(a.coordinator);
        vm.expectRevert(IBoxItemStream.AlreadyInitialised.selector);
        stream.initialize();
        assertEq(stream.streamValue(), x0);
        (address o,) = stream.pendingOf(itemA);
        assertEq(o, eoa[3], "the record untouched");
    }

    /// AR-03 (F126; docs/reviews/BOX0-REVIEW-2026-10-09-access.md:64) regression: a clone of the stream with box 0's
    /// own arguments but never initialised refuses its observers and its notice even from the very callers it names
    /// (`NotInitialised`), and its burn and claims.
    function testProperty_AUDIT_U5_anUninitialisedCloneRefusesItsHookPoints() public {
        address clone = BoxClones.create(BoxClones.initCode(a.itemStream.code));
        IBoxItemStream s = IBoxItemStream(clone);
        uint256 inside = vault.inside();
        vm.prank(a.receiver);
        vm.expectRevert(IBoxItemStream.NotInitialised.selector);
        s.onStreamFunds(1);
        vm.prank(a.collection);
        vm.expectRevert(IBoxItemStream.NotInitialised.selector);
        s.onItemTransfer(eoa[3], eoa[4], itemA);
        vm.prank(a.vault);
        vm.expectRevert(IBoxItemStream.NotInitialised.selector);
        s.onVaultAction(VaultAction.Withdrawn, eoa[4], 1, inside);
        vm.expectRevert(IBoxItemStream.NotInitialised.selector);
        s.burn();
        vm.prank(eoa[3]);
        vm.expectRevert(IBoxItemStream.NotInitialised.selector);
        s.claim(_ids(itemA), eoa[3]);
        vm.expectRevert(IBoxItemStream.NotInitialised.selector);
        s.onGraduation();
        assertEq(s.index(), 0);
    }

    /// P5.5 (BoxItemStream.sol:121-132, :701-723): `initialize` checks that the contracts it reads name it. A fresh copy
    /// of box 0's stream clone (box 0's own arguments), initialised by box 0's very coordinator, is refused
    /// `WiringMismatch(1)`: box 0's receiver names the real stream, so no second stream can be wired to box 0.
    function testProperty_AUDIT_U5_initializeRefusesACloneTheBoxDoesNotName() public {
        address clone = BoxClones.create(BoxClones.initCode(a.itemStream.code));
        vm.prank(a.coordinator);
        vm.expectRevert(abi.encodeWithSelector(IBoxItemStream.WiringMismatch.selector, uint256(1)));
        IBoxItemStream(clone).initialize();
    }

    /// L8 (BoxItemStream.sol:701-723; BoxFactoryV1 `_verifyCode`, BC-063): the stream is a clone of the version's
    /// stream implementation (the factory checked the code) whose arguments are box 0's own: its coordinator, T,
    /// collection, vault, tickets, receiver, hook, curve ticks, N and first id, and every contract it reads names it.
    function testProperty_AUDIT_U5_streamIsBox0sCloneWiredToBox0() public view {
        assertTrue(BoxClones.isCloneOf(a.itemStream, kit.impls().itemStream), "a clone of the version's stream");
        assertEq(stream.coordinatorImplementation(), kit.impls().coordinator);
        assertEq(stream.coordinator(), a.coordinator);
        assertEq(stream.token(), a.token);
        assertEq(stream.collection(), a.collection);
        assertEq(stream.vault(), a.vault);
        assertEq(stream.tickets(), a.tickets);
        assertEq(stream.receiver(), a.receiver);
        assertEq(stream.hook(), a.hook);
        assertEq(stream.poolManager(), address(pm));
        assertEq(stream.collectionSize(), editionSize);
        assertEq(stream.firstId(), BoxSpecV1.FIRST_ID);
        assertEq(receiver.itemStream(), a.itemStream, "the receiver pays it");
        assertEq(collection.transferObserver(), a.itemStream, "the collection observes through it");
        assertEq(vault.observer(), a.itemStream, "the vault observes through it");
        assertEq(coordinator.itemStream(), a.itemStream);
    }

    /// P5.6: `burn` is anyone's and burns the same surplus whoever calls; `onGraduation` is refused once started.
    function testFuzz_AUDIT_U5_burnIsAnyonesAndTheSameForAnyCaller(address caller) public {
        _sell(eoa[2], 2_000_000 ether);
        _buy(eoa[4], 0.6 ether);
        // A gift so a burn has surplus to take (the batch's own notice already burned the batch's).
        _collect(keeper, keeper);
        uint256 j0 = stream.index();
        assertEq(token.balanceOf(a.itemStream), stream.liabilities() + stream.outsideCount(), "the batch burned");
        _transferT(eoa[2], a.itemStream, 7 ether);
        uint256 dj = stream.index() - j0;
        uint256 snap = vm.snapshotState();
        vm.prank(keeper);
        uint256 b0 = stream.burn();
        vm.revertToState(snap);
        vm.prank(caller);
        uint256 b1 = stream.burn();
        assertEq(b1, b0, "the same surplus");
        assertEq(b1, 7 ether - stream.outsideCount() * dj, "the gift less the outside slots' share of it");
        vm.prank(caller);
        vm.expectRevert(IBoxItemStream.AlreadyStarted.selector);
        stream.onGraduation();
    }

    // ================================================================================================ L4

    /// P5.10 (BoxItemStream.sol:574-589, :41-48): inside one block, the order of a draw request, a settle and a fee
    /// batch changes no account's total: a batch moves no X (it turns pending T into held T exactly), a settle never
    /// calls the stream, so the draw's J at request, J itself and every owner's booked + pending accrual are the same in
    /// all orders (a sell earlier in the block included).
    function testProperty_AUDIT_U5_orderInsideABlockChangesNoTotal() public {
        _sell(eoa[2], 2_000_000 ether);
        _buy(eoa[4], 0.6 ether);
        uint256[3] memory sums;
        uint256[3] memory js;
        uint256[3] memory e0;
        uint256[3] memory e3;
        for (uint256 order; order < 3; ++order) {
            uint256 snap = vm.snapshotState();
            if (order == 0) {
                _collect(keeper, keeper);
                _draw(eoa[4], AUDIT_DRAW_VALUE);
            } else if (order == 1) {
                _draw(eoa[4], AUDIT_DRAW_VALUE);
                _collect(keeper, keeper);
            } else {
                _draw(eoa[4], AUDIT_DRAW_VALUE);
                _collect(keeper, keeper);
                _sell(eoa[2], 1_000_000 ether); // a later sell: after the request, in every order the same
            }
            _advance(1);
            _post(r0 + 12);
            if (order == 0) {
                _settle(keeper, 1);
                _buy(eoa[4], 0.6 ether);
                _collect(keeper, keeper);
            } else {
                _buy(eoa[4], 0.6 ether);
                _collect(keeper, keeper);
                _settle(keeper, 1);
            }
            (,, sums[order]) = stream.openTickets();
            js[order] = stream.index();
            e0[order] = _owedAndPending(eoa[0], _ids(itemP1));
            e3[order] = _owedAndPending(eoa[3], _ids(itemA));
            vm.revertToState(snap);
        }
        assertEq(sums[1], sums[0], "the draw's J at request");
        assertEq(js[1], js[0], "J");
        assertEq(e0[1], e0[0], "eoa[0]'s accrual");
        assertEq(e3[1], e3[0], "eoa[3]'s accrual");
        assertEq(sums[2], sums[0], "a later sell does not reach back to the request");
        assertGt(js[2], js[0], "but raises J");
    }

    // ================================================================================================ L6

    /// P5.13 (BoxItemStream.sol:76-84, :383-417): the stream's one-`extsload` read of box 0's pool (slot0, the T fee
    /// growth, four ticks' outside growth, four positions) and of the receiver's T claims equals StateLibrary's reads,
    /// across sells and buys of any size on both sides of P1 and P0, batches and a deepen.
    function testFuzz_AUDIT_U5_poolReadEqualsStateLibrary(uint256 seed) public {
        for (uint256 i; i < 12; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            uint256 op = r % 4;
            if (op == 0) _sell(eoa[2], 1 + (r >> 8) % 10_000_000 ether);
            else if (op == 1) _buy(eoa[4], 1e9 + (r >> 8) % 3 ether);
            else if (op == 2) _feesAndBatch(0);
            else _deepen(keeper, keeper);
            assertEq(stream.streamValue(), _refX(), "X == the StateLibrary rebuild");
            _advance(1 + (r >> 32) % 300);
        }
    }

    // ================================================================================================ L7

    /// P5.14 (BoxItemStream.sol:29-36, :467-472): J's flooring leaves at most N − 1 raw units of X unallocated at any
    /// time (r = (X − X₀) mod N), and none of it is ever paid: after any batch the owners' accrual is Σ m·ΔJ in whole J
    /// units, F = held + claimed + burned exactly, and paid + held + burned never exceeds what arrived.
    function testFuzz_AUDIT_U5_flooringLeavesLessThanNAndNothingIsPaidTwice(uint256 t1, uint256 t2) public {
        t1 = bound(t1, 1, 5_000_000 ether);
        t2 = bound(t2, 1, 5_000_000 ether);
        _feesAndBatch(t1);
        uint256 s = stream.streamValue() - stream.startValue();
        assertLt(s % editionSize, editionSize, "r < N");
        uint256 jBefore = stream.index();
        uint256 paid = _claimStreamFor(eoa[6], eoa[0], _ids(itemP1));
        paid += _claimStreamFor(eoa[6], eoa[3], _ids(itemA));
        uint256 kept = stream.owedOf(eoa[0]); // 1 after a claim that paid, J itself (0 or 1) after one that could not
        _feesAndBatch(t2);
        uint256 owed = kept + stream.index() - jBefore;
        uint256 again = _claimStreamFor(eoa[6], eoa[0], _ids(itemP1));
        assertEq(again, owed < 2 ? 0 : owed - 1, "the second claim pays only J since the first, 1 raw unit kept again");
        (uint256 claimed, uint256 burned) = stream.totals();
        assertEq(claimed, paid + again, "claimed = paid");
        assertEq(_streamF(), token.balanceOf(a.itemStream) + claimed + burned);
        assertLe(claimed + burned, _streamF(), "never more out than in");
    }

    /// The packed widths' edge (BoxItemStream.sol:97-104, :496-499): a record keeps J in 96 bits, the books keep Σ m·ΔJ
    /// in 127, X₀ in 128, claimed and burned in 120 each. The stated lifetime argument (":497: J < 2^96: X − X₀ would
    /// need N·2^96 raw T") holds with a margin: at N 1,969 that is 1.56·10^32 raw units (1.56·10^14 FIT), 156,000 times
    /// T's whole issuance, and the other fields are wider still. (The comment's "above 10^31 FIT for N 4,269" is too
    /// high by a factor of about 3·10^16: N·2^96 is 3.4·10^14 FIT; see `AuditU5ClaudeProofs`.)
    function testProperty_AUDIT_U5_packedWidthsHoldForAnyReachableLife() public view {
        uint256 jEdge = editionSize * (uint256(1) << 96);
        assertGt(jEdge / BoxSpecV1.ISSUANCE, 150_000, "J's 96 bits: 156,000 issuances of fees");
        assertGt((uint256(1) << 120) / BoxSpecV1.ISSUANCE, 1_000_000_000, "claimed/burned 120 bits: 10^9 issuances");
        assertGt((uint256(1) << 127) / BoxSpecV1.ISSUANCE, 1e11, "booked 127 bits");
        assertGt((uint256(1) << 128) / BoxSpecV1.ISSUANCE, 1e11, "X0 128 bits");
        assertLt(editionSize, uint256(1) << 32, "m in 32 bits");
    }
}

/// forge-config: default.evm_version = "amsterdam"
contract AuditU5ClaudeStreamAmsterdamTest is AuditU5ClaudeStreamTest {}
