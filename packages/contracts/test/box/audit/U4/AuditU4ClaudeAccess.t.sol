// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VmSafe} from "forge-std/Vm.sol";
import {BoxReceiverExtension} from "../../../../src/box/BoxReceiverExtension.sol";
import {BoxRoyaltyRouter} from "../../../../src/box/BoxRoyaltyRouter.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {BoxKind, ModuleProceedsTo, RoyaltyDestination} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxReceiver} from "../../../../src/box/interfaces/IBoxReceiver.sol";
import {IBoxRoyaltyRouter} from "../../../../src/box/interfaces/IBoxRoyaltyRouter.sol";
import {BoxCloneArgs} from "../../../../src/box/libraries/BoxCloneArgs.sol";
import {BoxClones} from "../../../../src/box/libraries/BoxClones.sol";
import {CoreImpls} from "../../conformance/core/CoreBox0Kit.sol";
import {AuditU4ClaudeBase} from "./AuditU4ClaudeBase.sol";

/// @title AuditU4ClaudeAccessTest
/// @notice TEST ONLY (SH-AUDIT-B0 U4, Claude). Lens L2 (access and roles) and L8 (deployment) for box 0's receiver and
/// royalty router: P4.8 (dormant module, creator and add-on 5 paths inert for every caller, the hook, the executor,
/// the coordinator and the stream included; `noteModuleFees` only from the hook and the executor), P4.9 (`onGraduation`
/// once, only after graduation; `receive` refuses plain ETH), P4.14 (BC-059: what FIT's executor reaches on the
/// receiver, recorded as it runs), P4.19 (the clones' code and wiring at `initialize`), and the implementations' own
/// inertness (BC-012). Sources: BoxReceiver.sol:151-153, :184-235, :310-320, :358-408, :1018-1022; BoxReceiverExtension
/// .sol:50-174; BoxRoyaltyRouter.sol:47-110; BoxFactoryV1Planner.sol:268-290; IBoxReceiver.sol:148-196; BC-010,
/// BC-012, BC-019, BC-021, BC-059, BC-100, BC-109, BC-133.
/// forge-config: default.evm_version = "osaka"
contract AuditU4ClaudeAccessTest is AuditU4ClaudeBase {
    // ================================================================================================ P4.8

    /// Every caller (a stranger, every box 0 contract, the Safe, the PoolManager, the receiver itself, address(0)),
    /// in the bonding and graduated phases: the dormant entry points revert with their access error and write
    /// nothing; the module, creator and add-on 5 views stay zero.
    function testFuzz_AUDIT_U4_dormantPathsInertForEveryCaller(
        uint256 callerSeed,
        address stranger,
        uint256 amount,
        uint8 dest,
        address to,
        bool graduated
    ) public {
        if (graduated) _toGraduated();
        else _toBonding();
        address caller = _caller(callerSeed, stranger);
        bytes32 before = _storageHash();
        vm.deal(caller, caller.balance + 1 ether);
        vm.startPrank(caller);
        vm.expectRevert(abi.encodeWithSelector(IBoxReceiver.NotModule.selector, caller));
        receiver.pullForModule();
        vm.expectRevert(abi.encodeWithSelector(IBoxReceiver.NotModule.selector, caller));
        receiver.moduleProceeds(ModuleProceedsTo(dest % 4), amount);
        vm.expectRevert(abi.encodeWithSelector(IBoxReceiver.NotPayee.selector, caller));
        receiver.claimCreator(to);
        vm.expectRevert(abi.encodeWithSelector(IBoxReceiver.NotPayee.selector, caller));
        receiver.proposeCreatorPayee(to);
        vm.expectRevert(abi.encodeWithSelector(IBoxReceiver.NotPendingPayee.selector, caller));
        receiver.acceptCreatorPayee();
        vm.expectRevert(IBoxReceiver.NotCreatorRoyalties.selector);
        receiver.fundCreator{value: 1 + amount % 1 ether}();
        vm.stopPrank();
        assertEq(_storageHash(), before, "nothing written");
        _assertDormantViews();
    }

    function _assertDormantViews() internal view {
        assertEq(receiver.swapModule(), address(0), "no module");
        assertEq(receiver.creatorPayee(), address(0), "no creator payee");
        assertEq(receiver.pendingCreatorPayee(), address(0));
        (uint256 cap, uint8 ex, uint256 ce, uint256 ck, uint256 cr) = receiver.creatorCap();
        assertEq(cap + ex + ce + ck + cr, 0, "no add-on 5 cap");
        (uint256 m1, uint256 m2, uint256 m3, uint256 m4, uint256 m5, uint256 m6,) = receiver.moduleOwed();
        assertEq(m1 + m2 + m3 + m4 + m5 + m6, 0, "module ledgers zero");
        (uint256 aq, uint256 at) = receiver.moduleFeeAllowance();
        assertEq(aq + at, 0, "no fee-note allowance");
        (uint256 oq, uint256 ot) = receiver.creatorOwed();
        (uint256 hq, uint256 ht) = receiver.creatorHeld();
        assertEq(oq + ot + hq + ht, 0, "creator ledgers zero");
        assertEq(receiver.fitWaitingT(), 0, "no T for a module to sell");
    }

    /// P4.8 through a whole life (trades, batches, the settlement, payouts, royalties, executor notes): the dormant
    /// ledgers never move.
    function testProperty_AUDIT_U4_dormantLedgersStayZeroThroughALife() public {
        _toBonding();
        _assertDormantViews();
        _toGraduated();
        _assertDormantViews();
        uint256 tOut = _buy(eoa[3], 2 ether);
        _advance(1);
        _sell(eoa[3], tOut / 2);
        _collect(keeper, keeper);
        _payFit(keeper);
        _payPlatform(keeper);
        _payRoyalty(eoa[0], 1 ether);
        royaltyRouter.flush();
        _executeOnce(false);
        _batchOf(0.05 ether);
        _collect(keeper, keeper);
        _assertDormantViews();
        _assertGhostLedger();
    }

    /// P4.8: `noteModuleFees` from anyone but box 0's hook and FIT's executor reverts `NotModule`; the hook's note is
    /// Q only (its T is clipped and logged), the executor's is booked whole (box 0 has no allowance: "unbounded as
    /// built", BoxReceiverExtension.sol:133-145), and its T note is never returned (box 0 returns no T, BoxReceiver
    /// .sol:910): an inert number, never split, never paid.
    function testFuzz_AUDIT_U4_noteModuleFeesOnlyHookAndExecutor(
        uint256 callerSeed,
        address stranger,
        uint96 q,
        uint96 t
    ) public {
        _toGraduated();
        address caller = _caller(callerSeed, stranger);
        if (caller != a.hook && caller != a.executor) {
            vm.expectRevert(abi.encodeWithSelector(IBoxReceiver.NotModule.selector, caller));
            vm.prank(caller);
            receiver.noteModuleFees(q, t);
        }
        uint256 hook0 = receiver.hookFeesPending();
        (uint256 mq0, uint256 mt0) = receiver.moduleFeesPending();
        if (t != 0) {
            vm.expectEmit(a.receiver);
            emit IBoxReceiver.ModuleFeesClipped(a.hook, 0, t);
        }
        vm.prank(a.hook);
        receiver.noteModuleFees(q, t);
        assertEq(receiver.hookFeesPending() - hook0, q, "the hook's Q note");
        (uint256 mq1, uint256 mt1) = receiver.moduleFeesPending();
        assertEq(mq1, mq0, "a hook note is not a module note");
        assertEq(mt1, mt0, "the hook's T is clipped");
        vm.prank(a.executor);
        receiver.noteModuleFees(q, t);
        (uint256 mq2, uint256 mt2) = receiver.moduleFeesPending();
        assertEq(mq2 - mq1, q, "the executor's Q note, whole");
        assertEq(mt2 - mt1, t, "the executor's T note, whole (no allowance on box 0)");
        // A batch returns the Q notes, never a T note; the T side splits whole.
        _giftEth(a.receiver, uint256(q) * 2 + BATCH_MIN);
        _collect(keeper, keeper);
        (uint256 mq3, uint256 mt3) = receiver.moduleFeesPending();
        assertEq(mq3, 0, "the executor's Q note returned to fitOwed");
        assertEq(mt3, mt2, "box 0 never returns a T note");
        assertEq(receiver.hookFeesPending(), 0, "the hook's note returned to its claims");
    }

    // ================================================================================================ P4.9

    /// P4.9: `onGraduation` reverts NotGraduated before graduation (created, window, bonding, closed); graduate()'s
    /// poke settles once; after that AlreadySettled for every caller.
    function testFuzz_AUDIT_U4_onGraduationOnceAfterGraduation(address caller) public {
        _expectOnGraduation(caller, IBoxReceiver.NotGraduated.selector);
        _toWindow();
        _expectOnGraduation(caller, IBoxReceiver.NotGraduated.selector);
        _toBonding();
        _expectOnGraduation(caller, IBoxReceiver.NotGraduated.selector);
        _toClosed();
        _expectOnGraduation(caller, IBoxReceiver.NotGraduated.selector);
        _toGraduated();
        assertTrue(receiver.graduationSettled());
        _expectOnGraduation(caller, IBoxReceiver.AlreadySettled.selector);
    }

    /// P4.9's late path (harness): with the poke failed, the first later receiver call by anyone settles (here a
    /// payFit), once; an explicit onGraduation afterwards reverts AlreadySettled.
    function testProperty_AUDIT_U4_firstLaterCallSettlesOnce() public {
        _toBonding();
        _fundFees(eoa[1], 3 ether);
        _toGraduatedLate();
        uint256 fitHeld = receiver.fitOwed();
        assertFalse(receiver.graduationSettled());
        uint256 paid = _payFit(eoa[6]);
        assertTrue(receiver.graduationSettled(), "settled by the first later call");
        assertGe(paid, fitHeld, "the held FIT share paid after the settlement");
        _expectOnGraduation(eoa[2], IBoxReceiver.AlreadySettled.selector);
        _assertGhostLedger();
    }

    function _expectOnGraduation(address caller, bytes4 err) internal {
        vm.expectRevert(err);
        vm.prank(caller);
        receiver.onGraduation();
    }

    /// P4.9: plain ETH (any sender, the PoolManager included, any amount, with all gas or a stipend) is refused
    /// outside the receiver's own guarded calls.
    function testFuzz_AUDIT_U4_receiveRefusesPlainEth(address sender, uint96 value, bool graduated) public {
        if (graduated) _toGraduated();
        vm.assume(sender != a.receiver);
        address[2] memory senders = [sender, address(pm)];
        for (uint256 i; i < 2; ++i) {
            vm.deal(senders[i], senders[i].balance + uint256(value) + 1);
            vm.prank(senders[i]);
            (bool ok, bytes memory ret) = a.receiver.call{value: uint256(value) + 1}("");
            assertFalse(ok, "plain ETH refused");
            assertEq(ret, abi.encodeWithSelector(IBoxReceiver.EthRefused.selector, senders[i]));
        }
    }

    /// P4.9 / L6: `unlockCallback` is refused unless the PoolManager calls it inside the receiver's own unlock.
    function testFuzz_AUDIT_U4_unlockCallbackOnlyInItsOwnUnlock(address sender, uint256 amount) public {
        _toGraduated();
        bytes memory data = abi.encode(uint8(2), abi.encode(amount, sender));
        address[2] memory senders = [sender, address(pm)];
        for (uint256 i; i < 2; ++i) {
            vm.expectRevert(IBoxReceiver.NotPoolManager.selector);
            vm.prank(senders[i]);
            receiver.unlockCallback(data);
        }
    }

    // ================================================================================================ L8, BC-012

    /// P4.19: box 0's receiver is the EIP-1167 clone of the version's receiver implementation with exactly the 201
    /// argument bytes the planner writes (box 0, native Q, T, the coordinator, the hook, FIT's executor, the mainnet
    /// Safe, the per-item stream, BUYBACK_BURN_T / PER_ITEM_STREAM, FeeHandling royalties, no payee, no module, no
    /// cap); the royalty router is the receiving clone naming box 0's coordinator, receiver, WETH and FeeHandling.
    function testProperty_AUDIT_U4_clonesAndWiringAreBox0s() public view {
        CoreImpls memory im = kit.impls();
        bytes memory args = abi.encodePacked(
            uint8(BoxKind.Box0), address(0), a.token, a.coordinator, a.hook, a.executor, safe, a.itemStream
        );
        args = abi.encodePacked(
            args,
            BoxSpecV1.Q_STREAM_BUYBACK_BURN_T,
            BoxSpecV1.T_STREAM_PER_ITEM_STREAM,
            BoxSpecV1.ROYALTY_DESTINATION_FEE_HANDLING,
            address(0),
            address(0),
            uint128(0),
            uint8(0)
        );
        assertEq(args.length, 201, "201 argument bytes");
        assertEq(a.receiver.code, BoxClones.runtime(im.receiver, args), "the receiver's code");
        assertEq(receiver.extension(), im.receiverExtension, "the fixed extension");
        assertEq(receiver.coordinatorImplementation(), im.coordinator);
        assertEq(uint8(receiver.kind()), uint8(BoxKind.Box0));
        assertEq(receiver.q(), address(0), "native ETH");
        assertEq(receiver.token(), a.token);
        assertEq(receiver.coordinator(), a.coordinator);
        assertEq(receiver.hook(), a.hook);
        assertEq(receiver.executor(), a.executor);
        assertEq(receiver.platformSafe(), BoxSpecV1.PLATFORM_SAFE_MAINNET);
        assertEq(receiver.itemStream(), a.itemStream);
        assertEq(receiver.qStream(), BoxSpecV1.Q_STREAM_BUYBACK_BURN_T);
        assertEq(receiver.tStream(), BoxSpecV1.T_STREAM_PER_ITEM_STREAM);
        assertEq(uint8(receiver.royaltyDestination()), uint8(RoyaltyDestination.FeeHandling));
        assertEq(receiver.PLATFORM_CAP_WEI(), 32 ether, "the mainnet cap");
        assertEq(receiver.PLATFORM_EPOCH_SECONDS(), 2_592_000);
        assertEq(receiver.batchMin(), 0.005 ether);
        assertEq(receiver.tipMax(), 0.0005 ether);
        assertEq(receiver.TIP_BPS(), 1_000);
        assertEq(receiver.FEE_SHARE_DENOMINATOR(), 15);
        bytes memory rargs = BoxCloneArgs.router(
            BoxCloneArgs.RouterArgs({
                coordinator: a.coordinator,
                receiver: a.receiver,
                weth: a.weth,
                destination: uint8(RoyaltyDestination.FeeHandling)
            })
        );
        assertEq(a.royaltyRouter.code, BoxClones.receivingRuntime(im.royaltyRouter, rargs), "the router's code");
        assertEq(royaltyRouter.coordinator(), a.coordinator);
        assertEq(royaltyRouter.receiver(), a.receiver);
        assertEq(royaltyRouter.weth(), a.weth);
        assertEq(uint8(royaltyRouter.destination()), uint8(RoyaltyDestination.FeeHandling));
        (address payTo, uint256 royalty) = collection.royaltyInfo(collection.firstId(), 1 ether);
        assertEq(payTo, a.royaltyRouter, "ERC-2981 names the router, never the Safe or a payee (BC-112)");
        assertEq(royalty, 0.025 ether, "250 bps");
    }

    /// P4.19, BC-100: initialize runs once, by box 0's coordinator only; the extension refuses direct calls; the
    /// receiver implementation and the extension cannot be initialised.
    function testFuzz_AUDIT_U4_initializeOnceByTheCoordinator(address caller) public {
        vm.assume(caller != a.coordinator);
        vm.expectRevert(IBoxReceiver.AlreadyInitialised.selector);
        vm.prank(a.coordinator);
        receiver.initialize();
        vm.expectRevert(abi.encodeWithSelector(IBoxReceiver.NotCoordinator.selector, caller));
        vm.prank(caller);
        receiver.initialize();
        CoreImpls memory im = kit.impls();
        vm.expectRevert(BoxReceiverExtension.NotDelegated.selector);
        vm.prank(caller);
        BoxReceiverExtension(im.receiverExtension).initialize();
        vm.expectRevert();
        vm.prank(a.coordinator);
        IBoxReceiver(im.receiver).initialize();
    }

    /// BC-012 ("calling an implementation directly reverts"), L8: the receiver implementation refuses every
    /// state-changing entry point that could move value, and the royalty router implementation flushes nothing; ETH
    /// sent to the router implementation by mistake is accepted and stays there (not box 0's).
    function testProperty_AUDIT_U4_implementationsAreInert() public {
        CoreImpls memory im = kit.impls();
        IBoxReceiver ri = IBoxReceiver(im.receiver);
        vm.deal(address(this), address(this).balance + 3 ether);
        vm.expectRevert();
        ri.collect(address(this));
        vm.expectRevert();
        ri.onGraduation();
        vm.expectRevert();
        ri.fundFees{value: 1 ether}();
        vm.expectRevert();
        ri.fundDepth{value: 1 ether}();
        vm.expectRevert();
        ri.payFit();
        vm.expectRevert();
        ri.payPlatform();
        vm.expectRevert();
        ri.noteModuleFees(1, 1);
        vm.expectRevert();
        ri.pullForModule();
        assertEq(im.receiver.balance, 0, "the receiver implementation holds nothing");
        BoxRoyaltyRouter rr = BoxRoyaltyRouter(payable(im.royaltyRouter));
        (bool ok,) = im.royaltyRouter.call{value: 1 ether}("");
        assertTrue(ok, "the implementation's receive accepts");
        vm.expectRevert(IBoxRoyaltyRouter.NotGraduated.selector);
        rr.flush();
        assertEq(im.royaltyRouter.balance, 1 ether, "and keeps it: nothing flushes from the implementation");
    }

    /// L2, L8 (BoxReceiver.sol:79-80, BoxReceiverExtension.sol:18-19, BoxRoyaltyRouter.sol:35, IBoxRoyaltyRouter.sol:20;
    /// F23 C2 "no owner, admin, pause, upgrade, setter or rescue"): read from the build artifacts, the functions that
    /// are neither view nor pure are exactly the documented entry points, each of whose caller rules this suite tests
    /// (BoxReceiver 15, its extension 4, the royalty router 2; the receiver's and router's `receive` aside, P4.9 and
    /// P4.16). A function added later fails this test until it is reviewed.
    function testProperty_AUDIT_U4_entryPointsAreExactlyTheDocumentedOnes() public view {
        string[15] memory r = [
            "acceptCreatorPayee",
            "claimCreator",
            "collect",
            "fundCreator",
            "fundDepth",
            "fundFees",
            "initialize",
            "moduleProceeds",
            "noteModuleFees",
            "onGraduation",
            "payFit",
            "payPlatform",
            "proposeCreatorPayee",
            "pullForModule",
            "unlockCallback"
        ];
        string[] memory receiverWriters = new string[](15);
        for (uint256 i; i < 15; ++i) {
            receiverWriters[i] = r[i];
        }
        _assertWriters("BoxReceiver", receiverWriters, 59);
        string[] memory extWriters = new string[](4);
        (extWriters[0], extWriters[1], extWriters[2], extWriters[3]) =
        ("acceptCreatorPayee", "initialize", "noteModuleFees", "proposeCreatorPayee");
        _assertWriters("BoxReceiverExtension", extWriters, 5);
        string[] memory routerWriters = new string[](2);
        (routerWriters[0], routerWriters[1]) = ("flush", "sweep");
        _assertWriters("BoxRoyaltyRouter", routerWriters, 6);
    }

    /// @dev The artifact's functions: `total` of them, and those neither view nor pure exactly `writers`, in ABI order.
    function _assertWriters(string memory name, string[] memory writers, uint256 total) internal view {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/out/", name, ".sol/", name, ".json"));
        string[] memory names = abi.decode(vm.parseJson(json, ".abi[?(@.type=='function')].name"), (string[]));
        string[] memory mut = abi.decode(vm.parseJson(json, ".abi[?(@.type=='function')].stateMutability"), (string[]));
        assertEq(names.length, total, string.concat(name, ": the number of functions"));
        assertEq(mut.length, total);
        uint256 n;
        for (uint256 i; i < names.length; ++i) {
            bytes32 m = keccak256(bytes(mut[i]));
            if (m == keccak256("view") || m == keccak256("pure")) continue;
            assertLt(n, writers.length, string.concat(name, ": an undocumented writer: ", names[i]));
            assertEq(names[i], writers[n], string.concat(name, ": the writers"));
            ++n;
        }
        assertEq(n, writers.length, string.concat(name, ": every documented writer present"));
    }

    // ================================================================================================ P4.14 (BC-059)

    /// P4.14, BC-059: recorded while FIT's executor runs a real buy-and-burn and box 0 runs batches and payouts, the
    /// executor calls exactly one receiver function, `noteModuleFees` (FitBuybackExecutor.sol:270; REV-16, which by
    /// design only the executor and the hook may call, BC-019, BC-133); every custody function its flows rely on
    /// (collect, payFit, fundFees, fundDepth, payPlatform, the router's flush) makes the same progress from a stranger.
    function testProperty_AUDIT_U4_executorReachesOnlyItsNoteOnTheReceiver() public {
        _toGraduated();
        vm.startStateDiffRecording();
        _executeOnce(true);
        VmSafe.AccountAccess[] memory acc = vm.stopAndReturnStateDiff();
        uint256 notes;
        for (uint256 i; i < acc.length; ++i) {
            if (acc[i].accessor != a.executor || acc[i].account != a.receiver) continue;
            VmSafe.AccountAccessKind k = acc[i].kind;
            // Only calls: Resume (a frame resuming), EXTCODESIZE before a high-level call and the like are not calls.
            if (k != VmSafe.AccountAccessKind.Call && k != VmSafe.AccountAccessKind.StaticCall) continue;
            assertEq(bytes4(acc[i].data), IBoxReceiver.noteModuleFees.selector, "the executor's only receiver call");
            ++notes;
        }
        assertEq(notes, 1, "one note per execute that spent");
        (uint256 noted,) = receiver.moduleFeesPending();
        assertGt(noted, 0);
        // The custody progress the executor's budget depends on needs no identity: a stranger collects (the note
        // returns to fitOwed), pays FIT, funds and pays the Safe.
        address stranger = makeAddr("u4.stranger");
        _batchOf(0.05 ether);
        uint256 fit0 = receiver.fitOwed();
        _collect(stranger, stranger);
        assertGe(receiver.fitOwed() - fit0, noted, "the note returned to FIT by a stranger's collect");
        uint256 budget0 = executor.budget();
        uint256 paid = _payFit(stranger);
        assertEq(executor.budget() - budget0, paid, "a stranger's payFit funds the budget");
        _fundFees(stranger, 1 ether);
        _fundDepth(stranger, 1 ether);
        _payPlatform(stranger);
        _assertGhostLedger();
    }

    // ================================================================================================ helpers

    /// @notice A caller from the stranger, every box 0 contract, the Safe, the PoolManager, the receiver itself and
    /// address(0).
    function _caller(uint256 seed, address stranger) internal view returns (address) {
        address[15] memory c = [
            stranger,
            a.hook,
            a.executor,
            a.coordinator,
            a.itemStream,
            a.tickets,
            a.vault,
            a.collection,
            a.launchRouter,
            a.royaltyRouter,
            safe,
            address(pm),
            a.receiver,
            a.token,
            address(0)
        ];
        return c[seed % c.length];
    }

    /// @notice keccak of the receiver's storage slots 0-18 (BoxReceiverBase's layout: the state word, the ledgers,
    /// the totals, the payee pair, the module ledgers, the stream's curve depth).
    function _storageHash() internal view returns (bytes32) {
        bytes32[19] memory w;
        for (uint256 i; i < 19; ++i) {
            w[i] = vm.load(a.receiver, bytes32(i));
        }
        return keccak256(abi.encode(w));
    }

    /// @notice One real buy-and-burn by FIT's executor (as the money review's M10): the budget funded through payFit,
    /// an hour of samples, a chunk (`mustBuy`: the price may be outside its band after trades, then it skips).
    function _executeOnce(bool mustBuy) internal {
        _fundFees(eoa[1], 3 ether);
        _payFit(keeper);
        vm.warp(vm.getBlockTimestamp() + 3600);
        vm.roll(vm.getBlockNumber() + 300);
        uint256 supply0 = token.totalSupply();
        (uint256 chunks, uint256 spent,) = executor.execute(1);
        if (!mustBuy) return;
        assertEq(chunks, 1, "the executor bought a chunk");
        assertGt(spent, 0);
        assertLt(token.totalSupply(), supply0, "and burned it");
    }
}
