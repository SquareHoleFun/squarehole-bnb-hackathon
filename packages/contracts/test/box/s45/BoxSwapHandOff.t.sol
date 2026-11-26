// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxReceiver} from "../../../src/box/BoxReceiver.sol";
import {BoxReceiverExtension} from "../../../src/box/BoxReceiverExtension.sol";
import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";
import {IBoxReceiver} from "../../../src/box/interfaces/IBoxReceiver.sol";
import {DepthKind, DeepenSkip, FeeBatch, ModuleProceedsTo} from "../../../src/box/interfaces/BoxTypes.sol";
import {ClaimsFunder} from "../../utils/ClaimsFunder.sol";
import {BoxS45Base} from "./BoxS45Base.sol";
import {EthClaimsMinter, MockFitExecutor, MockSwapModule} from "./BoxS45Mocks.sol";

/// @notice S5.M1, the receiver's hand-off to a Standard box's swap module (docs/design/swap-module-v1.md § 4.1-4.2,
/// § 4.7-4.8), against `MockSwapModule`: the `swapModule` argument and the `initialize` menu, the split bookings, the
/// pull with its transient snapshot, proceeds bounded by it, the fee-note allowance, and REV-16's return for the module
/// and the hook. Cases BC-130, BC-132 and BC-133 (receiver side). Every top-level call is its own transaction here
/// (Foundry's `isolate`, this repository's default), so a pull and a booking in two calls are two transactions.
contract BoxSwapHandOffTest is BoxS45Base {
    EthClaimsMinter internal minter;
    ClaimsFunder internal funder;

    /// LP_FEE (10,000 pips = 1%) over 10^6: the most a swap of an input can pay the pool.
    uint256 internal constant PIPS = 1_000_000;

    struct Owed {
        uint256 qBurn;
        uint256 qCreator;
        uint256 tForFit;
        uint256 tForCreator;
        uint256 qBack;
        uint256 tBack;
        bool held;
    }

    function setUp() public {
        _setUpWorld();
        minter = new EthClaimsMinter(pm);
        funder = new ClaimsFunder(pm);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Fixtures

    function _params(uint8 qs, uint8 ts) internal view returns (Params memory p) {
        p = _standardParams(address(0));
        (p.qStream, p.tStream) = (qs, ts);
        bool creator = qs == BoxSpecV1.Q_STREAM_TO_CREATOR || qs == BoxSpecV1.Q_STREAM_CREATOR_IN_T
            || ts == BoxSpecV1.T_STREAM_TO_CREATOR || ts == BoxSpecV1.T_STREAM_CREATOR_IN_Q;
        if (creator) p.payee = carol;
    }

    /// The default buyers' side (BUYBACK_BURN_T) with BURN_T: the module buys and burns T, and sells FIT's 3/15 (W4).
    function _buyBack() internal view returns (Params memory) {
        return _params(BoxSpecV1.Q_STREAM_BUYBACK_BURN_T, BoxSpecV1.T_STREAM_BURN_T);
    }

    function _graduated(Params memory p) internal returns (Box memory b) {
        b = _buildAndLaunch(p);
        _skipWindow(b);
        _closeAndGraduate(b);
    }

    function _mod(Box memory b) internal pure returns (MockSwapModule) {
        return MockSwapModule(payable(b.module));
    }

    function _fees(Box memory b, uint256 q) internal {
        vm.deal(address(this), address(this).balance + q);
        minter.mintTo{value: q}(address(b.receiver));
    }

    function _tFees(Box memory b, uint256 t) internal {
        deal(address(b.t), bob, b.t.balanceOf(bob) + t);
        funder.deposit(address(b.t), bob, t, address(b.receiver));
    }

    function _fundFees(Box memory b, uint256 amount) internal {
        vm.deal(address(this), address(this).balance + amount);
        b.receiver.fundFees{value: amount}();
    }

    /// A T batch of `t` (with the smallest valid Q batch beside it): returns the batch.
    function _tBatch(Box memory b, uint256 t) internal returns (FeeBatch memory) {
        _tFees(b, t);
        _fees(b, 0.01 ether);
        return b.receiver.collect(keeper);
    }

    function _owed(Box memory b) internal view returns (Owed memory o) {
        (o.qBurn, o.qCreator, o.tForFit, o.tForCreator, o.qBack, o.tBack, o.held) = b.receiver.moduleOwed();
    }

    function _qCarry(Box memory b) internal view returns (uint256 c) {
        (c,) = b.receiver.carried();
    }

    function _tCarry(Box memory b) internal view returns (uint256 c) {
        (, c) = b.receiver.carried();
    }

    function _depth(Box memory b) internal view returns (uint256 q, uint256 t) {
        (q, t) = b.hook.depthBudget();
    }

    /// The receiver's claims always cover every ledger (the rest is the next batch).
    function _assertCovered(Box memory b) internal view {
        (uint256 qb, uint256 tb) = b.receiver.booked();
        assertGe(_claims(address(b.receiver), address(0)), qb, "Q claims cover every Q ledger");
        assertGe(_claims(address(b.receiver), address(b.t)), tb, "T claims cover every T ledger");
    }

    // ============================================================================================================
    // BC-130: nothing converts before graduation; the module's ledgers, held then handed less 1 raw unit

    function test_BC130_buyBackQHeldUntilTheSettlementThenHandedLessOneUnit() public {
        Box memory b = _buildAndLaunch(_buyBack());
        MockSwapModule m = _mod(b);
        assertEq(b.receiver.swapModule(), b.module, "the clone argument");
        assertEq(m.initCalls(), 1, "the receiver's initialize ran the module's, once");
        _skipWindow(b);
        // Before graduation the buyers' 10/15 is held for the module (a buy on the curve would count fee money towards
        // the raise), FIT's 3/15 is held as today.
        uint256 c0 = _qCarry(b);
        uint256 fit0 = b.receiver.fitOwed();
        _fundFees(b, 0.15 ether);
        uint256 unit = (0.15 ether + c0) / 15;
        Owed memory o = _owed(b);
        assertEq(o.qBurn, unit * 10, "BUYBACK_BURN_T's 10/15 into the module's burn-buy ledger");
        assertEq(b.receiver.fitOwed() - fit0, unit * 3, "FIT's 3/15 as today");
        assertTrue(o.held, "held until the settlement");
        // The module can take nothing yet, and no step can open.
        uint256[6] memory got = m.pull();
        for (uint256 i; i < 6; ++i) {
            assertEq(got[i], 0, "pullForModule before the settlement hands over nothing");
        }
        assertEq(m.claimsOf(address(0)), 0);
        assertEq(_owed(b).qBurn, unit * 10, "the ledger is untouched");
        vm.expectRevert(IBoxReceiver.NoStepOpen.selector);
        m.step(ModuleProceedsTo.FitQ, 0, 0);
        // Graduation and the settlement move nothing to the module.
        _closeAndGraduate(b);
        assertTrue(b.receiver.graduationSettled());
        assertEq(m.claimsOf(address(0)), 0, "the settlement moves nothing to the module");
        o = _owed(b);
        assertFalse(o.held, "owed after the settlement");
        assertGe(o.qBurn, unit * 10, "the held Q plus the settlement's split of the last poke");
        // The pull hands the ledger less 1 raw unit, by ERC-6909 transfer.
        got = m.pull();
        assertEq(got[0], o.qBurn - 1, "qBurn handed, 1 raw unit kept");
        assertEq(m.claimsOf(address(0)), o.qBurn - 1, "the module holds exactly what was handed");
        assertEq(_owed(b).qBurn, 1, "no ledger returns to zero");
        // A later split adds to the ledger; the next pull hands exactly it.
        c0 = _qCarry(b);
        _fundFees(b, 0.15 ether);
        unit = (0.15 ether + c0) / 15;
        got = m.pull();
        assertEq(got[0], unit * 10, "the next pull: exactly the new 10/15");
        assertEq(got[1] + got[3] + got[4] + got[5], 0, "nothing else for a BUYBACK_BURN_T / BURN_T box");
        assertEq(_owed(b).qBurn, 1);
        _assertCovered(b);
    }

    function test_BC130_sellForQBurnedBeforeGraduationThenWaitsForTheModule() public {
        Box memory b = _buildAndLaunch(_params(BoxSpecV1.Q_STREAM_ALL_TO_FIT, BoxSpecV1.T_STREAM_SELL_FOR_Q));
        MockSwapModule m = _mod(b);
        _skipWindow(b);
        assertEq(_tCarry(b), 0, "fixture: no T carried");
        uint256 supply0 = b.t.totalSupply();
        _tBatch(b, 15e18);
        assertEq(supply0 - b.t.totalSupply(), 10e18, "before graduation SELL_FOR_Q's 10/15 is burned");
        assertEq(b.receiver.fitWaitingT(), 3e18, "FIT's 3/15 held for the module's sells (W4)");
        (, uint256 heldT) = b.receiver.depthHeld();
        assertEq(heldT, 2e18, "2/15 depth held");
        assertEq(_owed(b).tForFit, 3e18, "moduleOwed shows FIT's T share");
        _closeAndGraduate(b);
        uint256 w0 = b.receiver.fitWaitingT();
        uint256 supply1 = b.t.totalSupply();
        _tBatch(b, 15e18);
        assertEq(b.t.totalSupply(), supply1, "after graduation nothing of it is burned: the module sells it");
        assertEq(b.receiver.fitWaitingT() - w0, 13e18, "SELL_FOR_Q's 10/15 joins FIT's 3/15");
        uint256[6] memory got = m.pull();
        assertEq(got[2], w0 + 13e18 - 1, "tForFit handed, 1 raw unit kept");
        assertEq(m.claimsOf(address(b.t)), got[2]);
        assertEq(b.receiver.fitWaitingT(), 1);
        _assertCovered(b);
    }

    function test_BC130_creatorConversionsHeldThenHandedToTheirOwnLedgers() public {
        Box memory b = _buildAndLaunch(_params(BoxSpecV1.Q_STREAM_CREATOR_IN_T, BoxSpecV1.T_STREAM_CREATOR_IN_Q));
        MockSwapModule m = _mod(b);
        _skipWindow(b);
        uint256 c0 = _qCarry(b);
        _fundFees(b, 0.15 ether);
        uint256 unit = (0.15 ether + c0) / 15;
        assertEq(_owed(b).qCreator, unit * 10, "CREATOR_IN_T's Q into the module's creator-buy ledger");
        Owed memory o0 = _owed(b);
        uint256 w0 = b.receiver.fitWaitingT();
        _tBatch(b, 15e18);
        Owed memory o = _owed(b);
        assertEq(o.tForCreator - o0.tForCreator, 10e18, "CREATOR_IN_Q's T into the module's creator-sell ledger");
        assertEq(b.receiver.fitWaitingT() - w0, 3e18, "FIT's 3/15");
        assertTrue(o.held);
        (uint256 hq, uint256 ht) = b.receiver.creatorHeld();
        (uint256 oq, uint256 ot) = b.receiver.creatorOwed();
        assertEq(hq + ht + oq + ot, 0, "the creator is paid only from the module's proceeds");
        _closeAndGraduate(b);
        o = _owed(b);
        uint256[6] memory got = m.pull();
        assertEq(got[1], o.qCreator - 1, "qCreator");
        assertEq(got[2], o.tForFit - 1, "tForFit");
        assertEq(got[3], o.tForCreator - 1, "tForCreator");
        assertEq(got[0] + got[4] + got[5], 0);
        assertEq(m.claimsOf(address(0)), got[1]);
        assertEq(m.claimsOf(address(b.t)), got[2] + got[3]);
        o = _owed(b);
        assertEq(o.qCreator + o.tForFit + o.tForCreator, 3, "1 raw unit each");
        _assertCovered(b);
    }

    /// Every wei of a Standard box's split lands in a ledger, the hook or the carry, module ledgers included.
    function testFuzz_BC130_moduleLedgersPlusCarryEqualTheInput(uint96 q1, uint96 q2, uint96 t1) public {
        Box memory b = _graduated(_params(BoxSpecV1.Q_STREAM_BUYBACK_BURN_T, BoxSpecV1.T_STREAM_CREATOR_IN_Q));
        Snap memory s0 = _snap(b);
        uint256 qIn = uint256(q1) + q2;
        uint256 tIn;
        if (q1 != 0) _fundFees(b, q1);
        if (q2 != 0) _fundFees(b, q2);
        if (t1 != 0) {
            FeeBatch memory fb = _tBatch(b, t1);
            qIn += fb.q - fb.qToReserve - fb.tip;
            tIn = fb.t;
        }
        Snap memory s1 = _snap(b);
        uint256 qParts = (s1.module - s0.module) + (s1.fit - s0.fit) + (s1.depth - s0.depth);
        uint256 tParts = (s1.moduleT - s0.moduleT) + (s1.fitT - s0.fitT) + (s1.depthT - s0.depthT);
        assertEq(qParts + s1.carry, qIn + s0.carry, "Q: every wei split or carried");
        assertEq(tParts + s1.carryT, tIn + s0.carryT, "T: every wei split or carried");
        assertEq((s1.module - s0.module) * 3, (s1.fit - s0.fit) * 10, "10 : 3");
        assertEq((s1.moduleT - s0.moduleT) * 3, (s1.fitT - s0.fitT) * 10, "10 : 3 in T");
        _assertCovered(b);
    }

    /// One side's parts: the module's ledger (buy-back Q, creator-sell T), FIT's, depth (the hook's claims), the carry.
    struct Snap {
        uint256 module;
        uint256 fit;
        uint256 depth;
        uint256 carry;
        uint256 moduleT;
        uint256 fitT;
        uint256 depthT;
        uint256 carryT;
    }

    function _snap(Box memory b) internal view returns (Snap memory x) {
        Owed memory o = _owed(b);
        (x.module, x.moduleT) = (o.qBurn, o.tForCreator);
        (x.fit, x.fitT) = (b.receiver.fitOwed(), b.receiver.fitWaitingT());
        (x.depth, x.depthT) = _depth(b);
        (x.carry, x.carryT) = b.receiver.carried();
    }

    /// The module menu (swap-module § 4.2): the four actions that need a swap are accepted besides today's, every
    /// Standard box names a module (W4 makes every Standard box sell) that names this receiver and the box's Q, T and
    /// hook, box 0 names none; holder payouts, BURN_Q and the per-item stream on a Standard box stay refused.
    function test_BC130_initializeTakesTheModuleMenuAndChecksTheWiring() public {
        uint8[4] memory qs = [
            BoxSpecV1.Q_STREAM_ALL_TO_FIT,
            BoxSpecV1.Q_STREAM_TO_CREATOR,
            BoxSpecV1.Q_STREAM_BUYBACK_BURN_T,
            BoxSpecV1.Q_STREAM_CREATOR_IN_T
        ];
        uint8[4] memory ts = [
            BoxSpecV1.T_STREAM_BURN_T,
            BoxSpecV1.T_STREAM_TO_CREATOR,
            BoxSpecV1.T_STREAM_SELL_FOR_Q,
            BoxSpecV1.T_STREAM_CREATOR_IN_Q
        ];
        for (uint256 i; i < 4; ++i) {
            for (uint256 j; j < 4; ++j) {
                Box memory b = _build(_params(qs[i], ts[j]));
                vm.prank(address(b.coord));
                b.receiver.initialize();
                assertEq(_mod(b).initCalls(), 1, "the module initialised once, by its receiver");
                assertEq(b.receiver.swapModule(), b.module);
            }
        }
        // Still refused: holder payouts (S14), BURN_Q (S12) and the per-item stream on a Standard box.
        uint8[2][6] memory refused = [
            [BoxSpecV1.Q_STREAM_BURN_Q, BoxSpecV1.T_STREAM_BURN_T],
            [BoxSpecV1.Q_STREAM_PAY_HOLDERS_Q, BoxSpecV1.T_STREAM_BURN_T],
            [BoxSpecV1.Q_STREAM_HOLDERS_IN_T, BoxSpecV1.T_STREAM_BURN_T],
            [BoxSpecV1.Q_STREAM_ALL_TO_FIT, BoxSpecV1.T_STREAM_PAY_HOLDERS_T],
            [BoxSpecV1.Q_STREAM_ALL_TO_FIT, BoxSpecV1.T_STREAM_PER_ITEM_STREAM],
            [BoxSpecV1.Q_STREAM_ALL_TO_FIT, BoxSpecV1.T_STREAM_HOLDERS_IN_Q]
        ];
        for (uint256 i; i < refused.length; ++i) {
            Params memory p = _params(refused[i][0], refused[i][1]);
            Box memory b = _build(p);
            vm.prank(address(b.coord));
            vm.expectRevert(abi.encodeWithSelector(IBoxReceiver.ActionNotBuilt.selector, p.qStream, p.tStream));
            b.receiver.initialize();
        }
        // The creator conversions need a payee, like TO_CREATOR.
        {
            Params memory p = _params(BoxSpecV1.Q_STREAM_CREATOR_IN_T, BoxSpecV1.T_STREAM_BURN_T);
            p.payee = address(0);
            Box memory b = _build(p);
            vm.prank(address(b.coord));
            vm.expectRevert(abi.encodeWithSelector(IBoxReceiver.ActionNotBuilt.selector, p.qStream, p.tStream));
            b.receiver.initialize();
        }
        // A Standard box without a module.
        {
            Params memory p = _buyBack();
            Box memory b = _build(p);
            b.module = address(0);
            vm.etch(address(b.receiver), _clone(address(receiverImpl), _receiverArgs(b, p, address(b.hook))));
            vm.prank(address(b.coord));
            vm.expectRevert(IBoxReceiver.ZeroAddress.selector);
            b.receiver.initialize();
        }
        // A module wired to another receiver, Q, T or hook.
        for (uint256 k; k < 4; ++k) {
            Box memory b = _build(_buyBack());
            MockSwapModule m = _mod(b);
            address other = makeAddr("s5m1.other");
            address r = k == 0 ? other : address(b.receiver);
            address q_ = k == 1 ? other : address(0);
            address t_ = k == 2 ? other : address(b.t);
            address h = k == 3 ? other : address(b.hook);
            m.setWiring(r, q_, t_, h);
            vm.prank(address(b.coord));
            vm.expectRevert(abi.encodeWithSelector(IBoxReceiver.ModuleMismatch.selector, address(m)));
            b.receiver.initialize();
        }
        // Box 0 names none: its buy-back is FIT's executor.
        {
            Box memory z = _build(_box0Params());
            vm.prank(address(z.coord));
            z.receiver.initialize();
            assertEq(z.receiver.swapModule(), address(0));
            Params memory p = _box0Params();
            p.module = makeAddr("s5m1.box0Module");
            Box memory b = _build(p);
            vm.prank(address(b.coord));
            vm.expectRevert(abi.encodeWithSelector(IBoxReceiver.ModuleMismatch.selector, p.module));
            b.receiver.initialize();
        }
    }

    // ============================================================================================================
    // S5.M1's split (swap-module § 7): the receiver's cold half is a fixed DELEGATECALL target, inert on its own

    function test_split_extensionRefusesDirectCallsAndTheImplementationItsMismatch() public {
        vm.expectRevert(BoxReceiverExtension.NotDelegated.selector);
        receiverExt.initialize();
        vm.expectRevert(BoxReceiverExtension.NotDelegated.selector);
        receiverExt.noteModuleFees(1, 1);
        vm.expectRevert(BoxReceiverExtension.NotDelegated.selector);
        receiverExt.proposeCreatorPayee(alice);
        vm.expectRevert(BoxReceiverExtension.NotDelegated.selector);
        receiverExt.acceptCreatorPayee();
        assertEq(receiverImpl.extension(), address(receiverExt), "the hot half names its fixed extension");
        // The implementation itself stays inert through its extension (its own code bytes are no coordinator).
        vm.expectRevert();
        receiverImpl.initialize();
        // The two halves name one coordinator implementation.
        BoxReceiverExtension other = new BoxReceiverExtension(makeAddr("s5m1.otherCoordinator"));
        vm.expectRevert(abi.encodeWithSelector(BoxReceiver.ExtensionMismatch.selector, address(other)));
        new BoxReceiver(pm, address(coordImpl), address(other));
    }

    // ============================================================================================================
    // BC-132: the module spends only what it was handed and takes nothing else

    /// A graduated box whose module was handed Q (buy-back) and T (FIT's 3/15 and SELL_FOR_Q's 10/15).
    function _handed() internal returns (Box memory b, uint256[6] memory got) {
        b = _graduated(_params(BoxSpecV1.Q_STREAM_BUYBACK_BURN_T, BoxSpecV1.T_STREAM_SELL_FOR_Q));
        _fundFees(b, 1.5 ether);
        _tBatch(b, 150e18);
        got = _mod(b).pull();
        assertGt(got[0], 0.9 ether, "fixture: about 1 ETH of buy-back Q handed");
        assertGt(got[2], 100e18, "fixture: T handed for FIT");
    }

    /// forge-config: default.isolate = true
    function test_BC132_proceedsNeedAPullInTheSameTransaction() public {
        (Box memory b,) = _handed();
        MockSwapModule m = _mod(b);
        // The pull above was another transaction: its snapshot is gone.
        vm.expectRevert(IBoxReceiver.NoStepOpen.selector);
        m.proceeds(ModuleProceedsTo.FitQ, 0);
        m.pull();
        vm.expectRevert(IBoxReceiver.NoStepOpen.selector);
        m.proceeds(ModuleProceedsTo.FitQ, 0);
        // Pull and booking in one transaction (a step): booked.
        m.step(ModuleProceedsTo.FitQ, 0, 0);
        // A stranger, FIT's executor and another box's module can neither pull nor book.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IBoxReceiver.NotModule.selector, alice));
        b.receiver.pullForModule();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IBoxReceiver.NotModule.selector, alice));
        b.receiver.moduleProceeds(ModuleProceedsTo.FitQ, 0);
        Box memory c = _graduated(_buyBack());
        vm.prank(c.module);
        vm.expectRevert(abi.encodeWithSelector(IBoxReceiver.NotModule.selector, c.module));
        b.receiver.pullForModule();
        vm.prank(b.executor);
        vm.expectRevert(abi.encodeWithSelector(IBoxReceiver.NotModule.selector, b.executor));
        b.receiver.pullForModule();
        // Box 0 has no module: nobody pulls there.
        Box memory z = _graduated(_box0Params());
        vm.prank(z.executor);
        vm.expectRevert(abi.encodeWithSelector(IBoxReceiver.NotModule.selector, z.executor));
        z.receiver.pullForModule();
    }

    function test_BC132_proceedsBookAtMostWhatArrivedSinceThePull() public {
        (Box memory b,) = _handed();
        MockSwapModule m = _mod(b);
        uint256 x = 0.05 ether;
        uint256 fit0 = b.receiver.fitOwed();
        (uint256 toFit0,,,,,,) = b.receiver.totals();
        vm.expectEmit(address(b.receiver));
        emit IBoxReceiver.ModuleProceeds(ModuleProceedsTo.FitQ, x);
        m.step(ModuleProceedsTo.FitQ, x, x);
        assertEq(b.receiver.fitOwed() - fit0, x, "a sell's Q for FIT, booked");
        (uint256 toFit1,,,,,,) = b.receiver.totals();
        assertEq(toFit1 - toFit0, x, "and counted for FIT");
        // More than arrived: reverts, nothing booked.
        vm.expectRevert(abi.encodeWithSelector(IBoxReceiver.ProceedsTooLarge.selector, x + 1, x));
        m.step(ModuleProceedsTo.FitQ, x, x + 1);
        // The same arrival twice in one step.
        vm.expectRevert(abi.encodeWithSelector(IBoxReceiver.ProceedsTooLarge.selector, 1, 0));
        m.stepTwice(ModuleProceedsTo.FitQ, x, x, 1);
        // A T booking counts only T that arrived (here Q arrived), and a box without CREATOR_IN_T books no creator T.
        vm.expectRevert(abi.encodeWithSelector(IBoxReceiver.ProceedsTooLarge.selector, 1, 0));
        m.step(ModuleProceedsTo.CreatorT, 0, 1);
        vm.expectRevert(abi.encodeWithSelector(IBoxReceiver.ProceedsTooLarge.selector, 1, 0));
        m.step(ModuleProceedsTo.CreatorQ, 1, 1);
        // A step that pulls again cannot book the first pull's arrival under the second snapshot.
        vm.expectRevert(abi.encodeWithSelector(IBoxReceiver.ProceedsTooLarge.selector, x, 0));
        m.stepRepull(ModuleProceedsTo.FitQ, x, x);
        _assertCovered(b);
    }

    function test_BC132_creatorProceedsReachOnlyThePayeesLedger() public {
        Box memory b = _graduated(_params(BoxSpecV1.Q_STREAM_CREATOR_IN_T, BoxSpecV1.T_STREAM_CREATOR_IN_Q));
        MockSwapModule m = _mod(b);
        _fundFees(b, 1.5 ether);
        _tBatch(b, 150e18);
        m.pull();
        (uint256 q0, uint256 t0) = b.receiver.creatorOwed();
        m.step(ModuleProceedsTo.CreatorT, 7e18, 7e18);
        m.step(ModuleProceedsTo.CreatorQ, 0.02 ether, 0.02 ether);
        (uint256 q1, uint256 t1) = b.receiver.creatorOwed();
        assertEq(t1 - t0, 7e18, "a CREATOR_IN_T buy's T, owed to the payee");
        assertEq(q1 - q0, 0.02 ether, "a CREATOR_IN_Q sell's Q, owed to the payee");
        vm.prank(carol);
        (uint256 cq, uint256 ct) = b.receiver.claimCreator(carol);
        assertEq(cq, q1);
        assertEq(ct, t1);
        _assertCovered(b);
    }

    /// Fees the hook (or anyone) minted before the pull wait unbooked: they are the next batch, never proceeds.
    function test_BC132_proceedsNeverBookTheNextBatch() public {
        (Box memory b,) = _handed();
        MockSwapModule m = _mod(b);
        _fees(b, 0.2 ether);
        vm.expectRevert(abi.encodeWithSelector(IBoxReceiver.ProceedsTooLarge.selector, 0.2 ether, 0));
        m.step(ModuleProceedsTo.FitQ, 0, 0.2 ether);
        m.step(ModuleProceedsTo.FitQ, 0.05 ether, 0.05 ether);
        FeeBatch memory fb = b.receiver.collect(keeper);
        assertEq(fb.q, 0.2 ether, "the next batch is whole");
        // With fees waiting, only the snapshot keeps them out: a second booking of one arrival, or a booking after a
        // second pull, would otherwise take the waiting batch.
        _fees(b, 0.2 ether);
        vm.expectRevert(abi.encodeWithSelector(IBoxReceiver.ProceedsTooLarge.selector, 1, 0));
        m.stepTwice(ModuleProceedsTo.FitQ, 0.05 ether, 0.05 ether, 1);
        vm.expectRevert(abi.encodeWithSelector(IBoxReceiver.ProceedsTooLarge.selector, 0.05 ether, 0));
        m.stepRepull(ModuleProceedsTo.FitQ, 0.05 ether, 0.05 ether);
        fb = b.receiver.collect(keeper);
        assertEq(fb.q, 0.2 ether, "the waiting batch is whole again");
        // A collect inside the step books the waiting batch (and the module's own gift) as fees: nothing is left to
        // book as proceeds.
        _fees(b, 0.2 ether);
        vm.expectRevert(abi.encodeWithSelector(IBoxReceiver.ProceedsTooLarge.selector, 0.05 ether, 0));
        m.stepCollectingBetween(ModuleProceedsTo.FitQ, 0.05 ether, 0.05 ether);
        _assertCovered(b);
    }

    function test_BC132_feeNotesClippedToTheAllowanceNeverReverted() public {
        (Box memory b, uint256[6] memory got) = _handed();
        MockSwapModule m = _mod(b);
        uint256 aq = (got[0] + got[1] + got[4]) * BoxSpecV1.LP_FEE / PIPS;
        uint256 at = (got[2] + got[3] + got[5]) * BoxSpecV1.LP_FEE / PIPS;
        (uint256 fq, uint256 ft) = b.receiver.moduleFeeAllowance();
        assertEq(fq, aq, "Q allowance: handed x 1%");
        assertEq(ft, at, "T allowance: handed x 1%");
        vm.expectEmit(address(b.receiver));
        emit IBoxReceiver.ModuleFeesClipped(address(m), 5, 7);
        m.note(aq + 5, at + 7);
        (uint256 pq, uint256 pt) = b.receiver.moduleFeesPending();
        assertEq(pq, aq, "booked up to the allowance");
        assertEq(pt, at);
        (fq, ft) = b.receiver.moduleFeeAllowance();
        assertEq(fq + ft, 0, "the allowance is spent");
        m.note(1 ether, 1e18);
        (uint256 pq2, uint256 pt2) = b.receiver.moduleFeesPending();
        assertEq(pq2, pq, "beyond the allowance: clipped, not reverted");
        assertEq(pt2, pt);
        // The next pull adds to it.
        _fundFees(b, 0.15 ether);
        got = m.pull();
        (fq,) = b.receiver.moduleFeeAllowance();
        assertEq(fq, got[0] * BoxSpecV1.LP_FEE / PIPS);
    }

    /// Twin boxes, the same fees and pulls; one module lies about its fees. The next batch's reward, FIT and depth
    /// parts differ by exactly that module's allowance, never more.
    function test_BC132_aLyingModuleMovesNoBatchBeyondItsAllowance() public {
        (Box memory a,) = _handed();
        (Box memory c,) = _handed();
        _mod(a).note(1_000 ether, 1_000_000e18);
        (uint256 allowance,) = a.receiver.moduleFeesPending();
        assertGt(allowance, 0);
        uint256 pa = _qParts(a) + _qCarry(a);
        uint256 pc = _qParts(c) + _qCarry(c);
        _fees(a, 0.3 ether);
        _fees(c, 0.3 ether);
        FeeBatch memory fa = a.receiver.collect(keeper);
        FeeBatch memory fc = c.receiver.collect(keeper);
        assertEq(fa.tip, fc.tip, "the same tip");
        uint256 da = _qParts(a) + _qCarry(a) - pa;
        uint256 dc = _qParts(c) + _qCarry(c) - pc;
        assertEq(dc - da, allowance, "the liar moved exactly its allowance, to its own ledger");
        assertEq(_owed(a).qBack, allowance);
        _assertCovered(a);
    }

    function _qParts(Box memory b) internal view returns (uint256) {
        (uint256 dq,) = _depth(b);
        return _owed(b).qBurn + b.receiver.fitOwed() + dq;
    }

    function test_BC132_onlyItsModuleTheExecutorOrTheHookMayNote() public {
        Box memory b = _graduated(_buyBack());
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IBoxReceiver.NotModule.selector, alice));
        b.receiver.noteModuleFees(1, 0);
        vm.prank(b.executor);
        vm.expectRevert(abi.encodeWithSelector(IBoxReceiver.NotModule.selector, b.executor));
        b.receiver.noteModuleFees(1, 0);
        Box memory c = _graduated(_buyBack());
        vm.prank(c.module);
        vm.expectRevert(abi.encodeWithSelector(IBoxReceiver.NotModule.selector, c.module));
        b.receiver.noteModuleFees(1, 0);
        // The box's own hook (its depth conversions, S5.M5): Q only, no allowance.
        vm.prank(address(b.hook));
        b.receiver.noteModuleFees(3, 0);
        assertEq(b.receiver.hookFeesPending(), 3);
        // Box 0: FIT's executor and its hook, each to its own pending ledger.
        Box memory z = _graduated(_box0Params());
        vm.prank(z.executor);
        z.receiver.noteModuleFees(5, 0);
        vm.prank(address(z.hook));
        z.receiver.noteModuleFees(7, 0);
        (uint256 eq,) = z.receiver.moduleFeesPending();
        assertEq(eq, 5, "the executor's note");
        assertEq(z.receiver.hookFeesPending(), 7, "the hook's note, apart");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IBoxReceiver.NotModule.selector, alice));
        z.receiver.noteModuleFees(1, 0);
    }

    /// No core path calls the module after `initialize`: a reverting or gas-burning module blocks nothing; its budget
    /// waits. A module that re-enters at `initialize` can only refuse its own box's creation.
    function test_BC132_aBrokenModuleBlocksNothingElse() public {
        for (uint8 mode = 1; mode <= 2; ++mode) {
            Params memory p = _params(BoxSpecV1.Q_STREAM_BUYBACK_BURN_T, BoxSpecV1.T_STREAM_TO_CREATOR);
            Box memory b = _buildAndLaunch(p);
            _mod(b).setMode(mode);
            _skipWindow(b);
            (uint256 tOut,) = _buy(b, alice, 2 ether, 0);
            _sell(b, alice, tOut / 2);
            b.receiver.collect(keeper);
            _fundFees(b, 0.3 ether);
            b.receiver.fundDepth{value: 0}();
            _closeAndGraduate(b);
            assertTrue(b.receiver.graduationSettled(), "graduation and its settlement");
            (uint256 tOut2,) = _buy(b, alice, 1 ether, 0);
            _sell(b, alice, tOut2);
            b.receiver.collect(keeper);
            vm.prank(carol);
            b.receiver.claimCreator(carol);
            MockFitExecutor(payable(b.executor)).setGraduated(true);
            assertGt(b.receiver.payFit(), 0, "payFit");
            (DepthKind kind, DeepenSkip skip,,,) = b.hook.deepen(keeper);
            assertEq(uint256(kind), 0);
            assertTrue(skip != DeepenSkip.None, "deepen returns a skip, no revert");
            assertGt(_owed(b).qBurn, 1, "its budget waits");
            assertEq(_mod(b).claimsOf(address(0)), 0, "and is never pushed");
            _assertCovered(b);
        }
        Box memory r = _build(_buyBack());
        _mod(r).setReenter(1);
        vm.deal(address(this), BoxSpecV1.BOOTSTRAP_ETH);
        vm.expectRevert();
        r.coord.launch{value: BoxSpecV1.BOOTSTRAP_ETH}(address(0), 0);
    }

    // ============================================================================================================
    // BC-133: REV-16 for the module and the hook (receiver side)

    function test_BC133_moduleQFeesComeBackToItsLedgerWholeNeverSplit() public {
        (Box memory b,) = _handed();
        MockSwapModule m = _mod(b);
        uint256 fee = 0.004 ether;
        m.note(fee, 0);
        Owed memory o0 = _owed(b);
        uint256 p0 = _qParts(b);
        uint256 c0 = _qCarry(b);
        // The batch holds the module's own fee (its swap's LP fee reached the box's own positions) and others' fees.
        _fees(b, fee + 0.3 ether);
        vm.expectEmit(address(b.receiver));
        emit IBoxReceiver.ModuleFeesReturned(fee, 0, 0);
        FeeBatch memory fb = b.receiver.collect(keeper);
        assertEq(fb.q, fee + 0.3 ether);
        assertEq(_owed(b).qBack - o0.qBack, fee, "the module's fee back whole, to its own ledger");
        // Its burn-buy ledger, FIT and depth split only the rest (less the tip).
        assertEq(_qParts(b) + _qCarry(b) - p0, 0.3 ether - fb.tip + c0, "the rest split, the fee never split");
        (uint256 pq,) = b.receiver.moduleFeesPending();
        assertEq(pq, 0);
        uint256[6] memory got = m.pull();
        assertEq(got[4], fee - 1, "handed back on the next pull (1 raw unit kept)");
    }

    function test_BC133_moduleTFeesComeBackToItsSellLedger() public {
        (Box memory b,) = _handed();
        MockSwapModule m = _mod(b);
        uint256 fee = 1e18;
        m.note(0, fee);
        uint256 w0 = b.receiver.fitWaitingT();
        (, uint256 dt0) = _depth(b);
        uint256 tc0 = _tCarry(b);
        _tFees(b, fee);
        FeeBatch memory fb = _tBatch(b, 15e18);
        assertEq(fb.t, fee + 15e18);
        assertEq(_owed(b).tBack, fee, "the sell's T fee back whole");
        (, uint256 dt1) = _depth(b);
        uint256 unit = (15e18 + tc0) / 15;
        assertEq(b.receiver.fitWaitingT() - w0, unit * 13, "SELL_FOR_Q's 10/15 and FIT's 3/15 of the rest only");
        assertEq(dt1 - dt0, unit * 2, "2/15 of the rest to depth");
    }

    function test_BC133_hookConversionFeesReturnToDepthNeverSplit() public {
        Box memory b = _graduated(_buyBack());
        vm.prank(address(b.hook));
        vm.expectEmit(address(b.receiver));
        emit IBoxReceiver.ModuleFeesClipped(address(b.hook), 0, 5);
        b.receiver.noteModuleFees(0.002 ether, 5);
        assertEq(b.receiver.hookFeesPending(), 0.002 ether, "Q only: the hook never sells T (F72 (B))");
        _fees(b, 0.002 ether + 0.3 ether);
        (uint256 d0,) = _depth(b);
        uint256 c0 = _qCarry(b);
        FeeBatch memory fb = b.receiver.collect(keeper);
        (uint256 d1,) = _depth(b);
        uint256 unit = (0.3 ether - fb.tip + c0) / 15;
        assertEq(d1 - d0, 0.002 ether + unit * 2, "the conversion's fee back to the hook's claims, then 2/15");
        assertEq(b.receiver.hookFeesPending(), 0);
    }

    /// F77: box 0's receiver sees two noters; each note returns to its own ledger, neither credits the other.
    function test_BC133_box0ExecutorAndHookNotesReturnApart() public {
        Box memory z = _graduated(_box0Params());
        uint256 e = 0.003 ether;
        uint256 h = 0.002 ether;
        vm.prank(z.executor);
        z.receiver.noteModuleFees(e, 0);
        vm.prank(address(z.hook));
        z.receiver.noteModuleFees(h, 0);
        _fees(z, e + h + 0.3 ether);
        uint256 fit0 = z.receiver.fitOwed();
        uint256 plat0 = z.receiver.platformOwed();
        (uint256 d0,) = _depth(z);
        uint256 c0 = _qCarry(z);
        FeeBatch memory fb = z.receiver.collect(keeper);
        uint256 unit = (0.3 ether - fb.tip + c0) / 15;
        (uint256 d1,) = _depth(z);
        assertEq(z.receiver.fitOwed() - fit0, e + unit * 11, "the executor's fee back to FIT's budget, then 11/15");
        assertEq(d1 - d0, h + unit * 2, "the hook's fee back to its claims, then 2/15");
        assertEq(z.receiver.platformOwed() - plat0, unit * 2, "the platform's 2/15 of the rest only");
        assertEq(z.receiver.hookFeesPending(), 0);
    }

    /// Returns never exceed the batch: the rest of a note waits for later batches.
    function test_BC133_returnsNeverExceedTheBatch() public {
        Box memory b = _graduated(_buyBack());
        vm.prank(address(b.hook));
        b.receiver.noteModuleFees(1 ether, 0);
        _fees(b, 0.01 ether);
        (uint256 d0,) = _depth(b);
        FeeBatch memory fb = b.receiver.collect(keeper);
        (uint256 d1,) = _depth(b);
        assertEq(d1 - d0, 0.01 ether, "all of this batch, no more");
        assertEq(fb.tip, 0, "nothing left to tip");
        assertEq(b.receiver.hookFeesPending(), 0.99 ether);
        _assertCovered(b);
    }

    /// A note still pending when the settlement runs late (no poke, nobody called the receiver) is returned by the
    /// settlement's own split, not split.
    function test_BC133_aNotePendingAtTheSettlementIsReturnedNotSplit() public {
        Box memory b = _buildAndLaunch(_buyBack());
        _skipWindow(b);
        _close(b, carol);
        b.coord.setSkipPokes(true);
        b.coord.graduate();
        assertFalse(b.receiver.graduationSettled());
        vm.prank(address(b.hook));
        b.receiver.noteModuleFees(0.002 ether, 0);
        _fees(b, 0.002 ether);
        (uint256 d0,) = _depth(b);
        (uint256 heldQ,) = b.receiver.depthHeld();
        b.receiver.onGraduation();
        (uint256 d1,) = _depth(b);
        assertGe(d1 - d0, heldQ + 0.002 ether, "held depth plus the note, returned whole");
        assertEq(b.receiver.hookFeesPending(), 0);
        _assertCovered(b);
    }
}
