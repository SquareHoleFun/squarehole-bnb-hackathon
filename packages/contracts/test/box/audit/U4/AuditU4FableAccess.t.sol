// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxReceiverExtension} from "../../../../src/box/BoxReceiverExtension.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {BoxKind, ModuleProceedsTo, RoyaltyDestination} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxReceiver} from "../../../../src/box/interfaces/IBoxReceiver.sol";
import {BoxClones} from "../../../../src/box/libraries/BoxClones.sol";
import {CoreImpls} from "../../conformance/core/CoreBox0Kit.sol";
import {AuditU4FableBase, AuditU4FableTaker, AuditU4Tally} from "./AuditU4FableBase.sol";

/// @notice SH-AUDIT-B0 U4 (Fable), lenses L2 access and roles, L8 deployment, and BC-059: box 0's dormant paths are
/// inert for every caller (the hook, executor, coordinator, stream and every other box address included), fee notes
/// come only from the hook (Q only) and the executor, the settlement runs once and only after graduation and by the
/// first call after a failed poke, plain ETH is refused, the wiring is box 0's, and the executor's identity opens no
/// custody path.
/// forge-config: default.evm_version = "osaka"
contract AuditU4FableAccessTest is AuditU4FableBase {
    bytes4 internal constant REENTRANCY = 0xab143c06;

    function setUp() public override {
        super.setUp();
        _toBonding();
    }

    /// Every address that has an identity in box 0's world, plus a stranger, the Safe and the PoolManager.
    function _callers() internal view returns (address[15] memory c) {
        c = [
            eoa[0],
            a.hook,
            a.executor,
            a.coordinator,
            a.itemStream,
            a.tickets,
            a.vault,
            a.collection,
            a.launchRouter,
            a.royaltyRouter,
            a.token,
            safe,
            address(pm),
            a.receiver,
            address(this)
        ];
    }

    /// P4.8: `pullForModule`, `moduleProceeds`, `claimCreator`, `proposeCreatorPayee`, `acceptCreatorPayee` and
    /// `fundCreator` revert for every caller on box 0 (no module, no payee, no Creator royalties), before and after
    /// graduation; the module ledgers, the allowance and add-on 5's cap read zero.
    function testProperty_AUDIT_U4_dormantPathsRevertForEveryCaller() public {
        _assertDormant();
        _toGraduated();
        _assertDormant();
    }

    function _assertDormant() internal {
        address[15] memory c = _callers();
        (uint256 bq, uint256 bt) = receiver.booked();
        uint256 q0 = _claimsQ(a.receiver);
        for (uint256 i; i < c.length; ++i) {
            address who = c[i];
            vm.expectRevert(abi.encodeWithSelector(IBoxReceiver.NotModule.selector, who));
            vm.prank(who);
            receiver.pullForModule();
            vm.expectRevert(abi.encodeWithSelector(IBoxReceiver.NotModule.selector, who));
            vm.prank(who);
            receiver.moduleProceeds(ModuleProceedsTo.FitQ, 1);
            vm.expectRevert(abi.encodeWithSelector(IBoxReceiver.NotPayee.selector, who));
            vm.prank(who);
            receiver.claimCreator(who);
            vm.expectRevert(abi.encodeWithSelector(IBoxReceiver.NotPayee.selector, who));
            vm.prank(who);
            receiver.proposeCreatorPayee(who);
            vm.expectRevert(abi.encodeWithSelector(IBoxReceiver.NotPendingPayee.selector, who));
            vm.prank(who);
            receiver.acceptCreatorPayee();
            vm.expectRevert(IBoxReceiver.NotCreatorRoyalties.selector);
            vm.prank(who);
            receiver.fundCreator();
        }
        _assertDormantViews();
        (uint256 bq1, uint256 bt1) = receiver.booked();
        assertEq(bq1, bq);
        assertEq(bt1, bt);
        assertEq(_claimsQ(a.receiver), q0, "nothing moved");
    }

    function _assertDormantViews() internal view {
        (uint256 qBurn, uint256 qCreator, uint256 tForFit, uint256 tForCreator, uint256 qBack, uint256 tBack,) =
            receiver.moduleOwed();
        assertEq(qBurn | qCreator | tForFit | tForCreator | qBack | tBack, 0, "no module ledger");
        (uint256 aq, uint256 at) = receiver.moduleFeeAllowance();
        assertEq(aq | at, 0, "no allowance");
        (uint256 cap, uint8 ex, uint256 e, uint256 k, uint256 r) = receiver.creatorCap();
        assertEq(cap | ex | e | k | r, 0, "no creator cap (add-on 5)");
        (uint256 cq, uint256 ct) = receiver.creatorOwed();
        (uint256 hq, uint256 ht) = receiver.creatorHeld();
        assertEq(cq | ct | hq | ht, 0, "no creator credit");
        assertEq(receiver.creatorPayee(), address(0));
        assertEq(receiver.pendingCreatorPayee(), address(0));
        assertEq(receiver.swapModule(), address(0));
    }

    /// P4.8, BC-019, BC-133: `noteModuleFees` is accepted from the hook (Q only: the T is clipped, never stored) and
    /// from the executor (both sides, unbounded as built); every other caller gets `NotModule`; the extension refuses
    /// a direct call. A collect returns the executor's Q to FIT's ledger and the hook's Q to the hook's claims; the
    /// executor's T note is never returned on box 0 (an inert counter).
    function testProperty_AUDIT_U4_noteModuleFeesOnlyFromHookAndExecutor() public {
        _toGraduated();
        address[15] memory c = _callers();
        for (uint256 i; i < c.length; ++i) {
            if (c[i] == a.hook || c[i] == a.executor) continue;
            vm.expectRevert(abi.encodeWithSelector(IBoxReceiver.NotModule.selector, c[i]));
            vm.prank(c[i]);
            receiver.noteModuleFees(1, 1);
        }
        vm.expectEmit(true, false, false, true, a.receiver);
        emit IBoxReceiver.ModuleFeesNoted(a.hook, 5, 0);
        vm.expectEmit(true, false, false, true, a.receiver);
        emit IBoxReceiver.ModuleFeesClipped(a.hook, 0, 7);
        vm.prank(a.hook);
        receiver.noteModuleFees(5, 7);
        assertEq(receiver.hookFeesPending(), 5, "the hook's Q note waits");
        (uint256 pq, uint256 pt) = receiver.moduleFeesPending();
        assertEq(pq | pt, 0, "nothing on the executor's ledger from the hook");
        vm.expectEmit(true, false, false, true, a.receiver);
        emit IBoxReceiver.ModuleFeesNoted(a.executor, 9, 3);
        vm.prank(a.executor);
        receiver.noteModuleFees(9, 3);
        (pq, pt) = receiver.moduleFeesPending();
        assertEq(pq, 9);
        assertEq(pt, 3, "the T note is stored as built");
        BoxReceiverExtension ext = BoxReceiverExtension(receiver.extension());
        vm.expectRevert(BoxReceiverExtension.NotDelegated.selector);
        vm.prank(a.executor);
        ext.noteModuleFees(1, 0);
        vm.expectRevert(BoxReceiverExtension.NotDelegated.selector);
        vm.prank(a.coordinator);
        ext.initialize();
        vm.expectRevert(BoxReceiverExtension.NotDelegated.selector);
        ext.proposeCreatorPayee(eoa[0]);
        vm.expectRevert(BoxReceiverExtension.NotDelegated.selector);
        ext.acceptCreatorPayee();
        // The next batch returns both Q notes first; the executor's T note stays.
        _trade(eoa[3], 0.8 ether, 5_000);
        _advance(1);
        uint256 fit0 = receiver.fitOwed();
        uint256 hookQ0 = _claimsQ(a.hook);
        vm.recordLogs();
        _collect(keeper, keeper);
        AuditU4Tally memory t = _tally(vm.getRecordedLogs());
        assertEq(t.back, 9, "the executor's Q note returned");
        assertEq(t.hookBack, 5, "the hook's Q note returned");
        assertEq(t.backT, 0, "box 0 returns no T note");
        assertGe(receiver.fitOwed() - fit0, 9);
        assertGe(_claimsQ(a.hook) - hookQ0, 5);
        assertEq(receiver.hookFeesPending(), 0);
        (pq, pt) = receiver.moduleFeesPending();
        assertEq(pq, 0);
        assertEq(pt, 3, "the T note is never consumed on box 0 (inert)");
        _assertGhostLedger();
    }

    /// P4.9, BC-098, BC-143: `onGraduation` reverts before graduation and after the settlement; when the coordinator's
    /// poke failed, the first later receiver call of any kind settles (payFit, fundFees, collect, payPlatform,
    /// fundDepth, a royalty flush, the stream's own graduation poke).
    function testProperty_AUDIT_U4_settlementOnceOnlyAfterGraduationAndByTheFirstCall() public {
        vm.expectRevert(IBoxReceiver.NotGraduated.selector);
        receiver.onGraduation();
        _toClosed();
        vm.expectRevert(IBoxReceiver.NotGraduated.selector);
        receiver.onGraduation();
        uint256 closed = vm.snapshotState();
        _toGraduated();
        assertTrue(receiver.graduationSettled(), "the poke settled");
        vm.expectRevert(IBoxReceiver.AlreadySettled.selector);
        receiver.onGraduation();
        vm.revertToState(closed);
        _graduateWithFailedReceiverPoke(keeper);
        uint256 unsettled = vm.snapshotState();
        _payFit(eoa[0]);
        assertTrue(receiver.graduationSettled(), "payFit settled");
        vm.revertToState(unsettled);
        _fundFees(eoa[0], 1 ether);
        assertTrue(receiver.graduationSettled(), "fundFees settled");
        vm.revertToState(unsettled);
        _trade(eoa[3], 0.8 ether, 0);
        _advance(1);
        _collect(keeper, keeper);
        assertTrue(receiver.graduationSettled(), "collect settled");
        vm.revertToState(unsettled);
        _payPlatform(eoa[0]);
        assertTrue(receiver.graduationSettled(), "payPlatform settled (and paid the held share)");
        vm.revertToState(unsettled);
        _fundDepth(eoa[0], 1);
        assertTrue(receiver.graduationSettled(), "fundDepth settled");
        vm.revertToState(unsettled);
        _payRoyalty(eoa[2], 1 ether);
        royaltyRouter.flush();
        assertTrue(receiver.graduationSettled(), "a flush settled");
        vm.revertToState(unsettled);
        vm.prank(eoa[4]);
        stream.onGraduation();
        assertTrue(receiver.graduationSettled(), "the stream's repeated poke settled the receiver");
        vm.revertToState(unsettled);
        vm.prank(eoa[4]);
        receiver.onGraduation();
        assertTrue(receiver.graduationSettled(), "anyone's onGraduation settled");
        vm.expectRevert(IBoxReceiver.AlreadySettled.selector);
        receiver.onGraduation();
    }

    /// P4.9: the receiver takes ETH only from the PoolManager inside its own guarded calls: plain sends, a contract's
    /// call, and a PoolManager `take` from an outsider's unlock are all refused; `initialize` runs once; the callback
    /// only from the PoolManager inside a guarded call.
    function testProperty_AUDIT_U4_receiveRefusesPlainEth() public {
        _fund(eoa[0], 1);
        vm.prank(eoa[0]);
        (bool ok, bytes memory ret) = a.receiver.call{value: 1}("");
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(IBoxReceiver.EthRefused.selector, eoa[0]));
        vm.deal(address(contractDrawer), 1);
        vm.expectRevert(abi.encodeWithSelector(IBoxReceiver.EthRefused.selector, address(contractDrawer)));
        contractDrawer.exec(a.receiver, 1, "");
        AuditU4FableTaker taker = new AuditU4FableTaker(pm);
        vm.deal(address(taker), 1 ether);
        vm.expectRevert();
        taker.takeTo{value: 0}(a.receiver, 1 ether);
        assertEq(a.receiver.balance, 0, "the PoolManager could not push ETH at it from outside its calls");
        vm.expectRevert(abi.encodeWithSelector(IBoxReceiver.NotCoordinator.selector, eoa[0]));
        vm.prank(eoa[0]);
        receiver.initialize();
        vm.expectRevert(IBoxReceiver.AlreadyInitialised.selector);
        vm.prank(a.coordinator);
        receiver.initialize();
        vm.expectRevert(IBoxReceiver.NotPoolManager.selector);
        receiver.unlockCallback("");
        vm.expectRevert(IBoxReceiver.NotPoolManager.selector);
        vm.prank(address(pm));
        receiver.unlockCallback("");
        _assertGhostLedger();
    }

    /// P4.19 (L8): the receiver's clone arguments and the router's are box 0's; both clones are of the version's
    /// implementations; the constants are the mainnet build's.
    function testProperty_AUDIT_U4_wiringIsBox0s() public view {
        CoreImpls memory impls = kit.impls();
        assertEq(uint8(receiver.kind()), uint8(BoxKind.Box0));
        assertEq(receiver.coordinator(), a.coordinator);
        assertEq(receiver.hook(), a.hook);
        assertEq(receiver.token(), a.token);
        assertEq(receiver.q(), address(0), "native ETH");
        assertEq(receiver.executor(), a.executor);
        assertEq(receiver.platformSafe(), BoxSpecV1.PLATFORM_SAFE_MAINNET);
        assertEq(receiver.itemStream(), a.itemStream);
        assertEq(receiver.qStream(), BoxSpecV1.Q_STREAM_BUYBACK_BURN_T);
        assertEq(receiver.tStream(), BoxSpecV1.T_STREAM_PER_ITEM_STREAM);
        assertEq(uint8(receiver.royaltyDestination()), uint8(RoyaltyDestination.FeeHandling));
        assertEq(receiver.creatorPayee(), address(0), "no creator payee");
        assertEq(receiver.swapModule(), address(0), "no swap module");
        assertEq(receiver.coordinatorImplementation(), impls.coordinator);
        assertEq(receiver.extension(), impls.receiverExtension);
        assertEq(address(receiver.poolManager()), address(pm));
        assertTrue(BoxClones.isCloneOf(a.receiver, impls.receiver), "a clone of the version's receiver");
        assertEq(a.receiver.code.length, 45 + receiver.ARGS_LENGTH());
        assertEq(receiver.FEE_SHARE_DENOMINATOR(), 15);
        assertEq(receiver.TIP_BPS(), 1_000);
        assertEq(receiver.PLATFORM_CAP_WEI(), 32 ether, "the mainnet build's cap");
        assertEq(receiver.PLATFORM_EPOCH_SECONDS(), 2_592_000);
        assertEq(receiver.batchMin(), 0.005 ether);
        assertEq(receiver.tipMax(), 0.0005 ether);
        assertEq(receiver.STREAM_NOTIFY_GAS(), 200_000);
        assertEq(receiver.STREAM_NOTIFY_GAS(), BoxSpecV1.STREAM_NOTIFY_GAS);
        assertEq(royaltyRouter.receiver(), a.receiver, "the router's one sink");
        assertEq(royaltyRouter.coordinator(), a.coordinator);
        assertEq(royaltyRouter.weth(), a.weth);
        assertEq(uint8(royaltyRouter.destination()), uint8(RoyaltyDestination.FeeHandling));
        assertTrue(BoxClones.isReceivingCloneOf(a.royaltyRouter, impls.royaltyRouter), "a receiving clone");
        (address who, uint256 amount) = collection.royaltyInfo(1, 1 ether);
        assertEq(who, a.royaltyRouter, "BC-112: ERC-2981 names the router");
        assertEq(amount, 0.025 ether, "250 bps");
    }

    /// BC-059 (P4.14): every state-changing receiver function behaves the same for FIT's executor as for a stranger
    /// (the same success or the same revert), except `noteModuleFees`, which the executor alone may call and which moves
    /// no claim, ETH or T: the executor's identity reaches no custody function a user cannot.
    function testProperty_AUDIT_U4_executorIdentityOpensNoCustodyPath() public {
        _toGraduated();
        _trade(eoa[3], 0.8 ether, 3_000);
        _advance(1);
        bytes[13] memory calls = [
            abi.encodeCall(IBoxReceiver.collect, (eoa[5])),
            abi.encodeCall(IBoxReceiver.onGraduation, ()),
            abi.encodeCall(IBoxReceiver.pullForModule, ()),
            abi.encodeCall(IBoxReceiver.moduleProceeds, (ModuleProceedsTo.FitQ, 1)),
            abi.encodeCall(IBoxReceiver.fundFees, ()),
            abi.encodeCall(IBoxReceiver.fundDepth, ()),
            abi.encodeCall(IBoxReceiver.fundCreator, ()),
            abi.encodeCall(IBoxReceiver.payFit, ()),
            abi.encodeCall(IBoxReceiver.payPlatform, ()),
            abi.encodeCall(IBoxReceiver.claimCreator, (eoa[5])),
            abi.encodeCall(IBoxReceiver.proposeCreatorPayee, (eoa[5])),
            abi.encodeCall(IBoxReceiver.acceptCreatorPayee, ()),
            abi.encodeCall(IBoxReceiver.initialize, ())
        ];
        for (uint256 i; i < calls.length; ++i) {
            (bool okE, bytes4 selE) = _probe(a.executor, calls[i]);
            (bool okS, bytes4 selS) = _probe(eoa[0], calls[i]);
            assertEq(okE, okS, string.concat("same outcome for the executor and a stranger: call ", vm.toString(i)));
            if (!okE) assertEq(selE, selS, string.concat("same revert: call ", vm.toString(i)));
        }
        // The executor's own entry moves nothing.
        uint256 q0 = _claimsQ(a.receiver);
        uint256 t0 = _claimsT(a.receiver);
        uint256 e0 = a.receiver.balance;
        uint256 b0 = token.balanceOf(a.receiver);
        (uint256 bq, uint256 bt) = receiver.booked();
        vm.prank(a.executor);
        receiver.noteModuleFees(1 ether, 1 ether);
        assertEq(_claimsQ(a.receiver), q0);
        assertEq(_claimsT(a.receiver), t0);
        assertEq(a.receiver.balance, e0);
        assertEq(token.balanceOf(a.receiver), b0);
        (uint256 bq1, uint256 bt1) = receiver.booked();
        assertEq(bq1, bq, "a note is in no ledger of claims");
        assertEq(bt1, bt);
        assertEq(a.executor.balance, 0, "and pays the executor nothing by itself");
    }

    /// @dev `data` as `who` on a snapshot: whether it succeeded and, if not, its revert selector.
    function _probe(address who, bytes memory data) internal returns (bool ok, bytes4 sel) {
        uint256 snap = vm.snapshotState();
        vm.prank(who);
        bytes memory ret;
        (ok, ret) = a.receiver.call(data);
        sel = ok ? bytes4(0) : _selector(ret);
        vm.revertToState(snap);
    }
}
