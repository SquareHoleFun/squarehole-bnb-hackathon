// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {BoxReceiver} from "../../../src/box/BoxReceiver.sol";
import {BoxRoyaltyRouter} from "../../../src/box/BoxRoyaltyRouter.sol";
import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";
import {BoxSwapBounds} from "../../../src/box/libraries/BoxSwapBounds.sol";
import {FitBuybackExecutor} from "../../../src/box/FitBuybackExecutor.sol";
import {IBoxHook} from "../../../src/box/interfaces/IBoxHook.sol";
import {IBoxReceiver} from "../../../src/box/interfaces/IBoxReceiver.sol";
import {IBoxRoyaltyRouter} from "../../../src/box/interfaces/IBoxRoyaltyRouter.sol";
import {BoxKind, DepthKind, FeeBatch, RoyaltyDestination} from "../../../src/box/interfaces/BoxTypes.sol";
import {ClaimsFunder} from "../../utils/ClaimsFunder.sol";
import {BoxS45Base} from "./BoxS45Base.sol";
import {
    AcceptingSafe,
    EthClaimsMinter,
    MockFitExecutor,
    MockItemStream,
    MockWETH,
    RefusingRecipient,
    SupplyFloorStandIn
} from "./BoxS45Mocks.sol";

/// @notice S5: BoxReceiver (D2 batches, splits, the cap, ETH intake, payouts, the payee), FIT's executor without the
/// treasury cut, and the royalty router. Cases BC-015 to -017, -019 to -021, -106 to -108, -111, -114, -118.
contract BoxReceiverTest is BoxS45Base {
    using StateLibrary for IPoolManager;

    EthClaimsMinter internal minter;
    ClaimsFunder internal funder;

    function setUp() public {
        _setUpWorld();
        minter = new EthClaimsMinter(pm);
        funder = new ClaimsFunder(pm);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Fixtures

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

    function _depthQ(Box memory b) internal view returns (uint256 q) {
        (q,) = b.hook.depthBudget();
    }

    function _kept(Box memory b) internal view returns (uint256 kept) {
        (, kept,) = b.receiver.platformEpoch();
    }

    struct Tot {
        uint256 toFit;
        uint256 toPlatform;
        uint256 qToDepth;
        uint256 tToDepth;
        uint256 tBurned;
        uint256 qToCreator;
        uint256 tToCreator;
    }

    function _tot(Box memory b) internal view returns (Tot memory x) {
        (x.toFit, x.toPlatform, x.qToDepth, x.tToDepth, x.tBurned, x.qToCreator, x.tToCreator) = b.receiver.totals();
    }

    function _graduated(Params memory p) internal returns (Box memory b) {
        b = _buildAndLaunch(p);
        _skipWindow(b);
        _closeAndGraduate(b);
    }

    // ------------------------------------------------------------------------------------------------------------
    // BC-015: the split per box and reward choice

    function test_BC015_standardSplitsTenThreeTwo() public {
        Box memory b = _graduated(_standardParams(address(0)));
        uint256 fit0 = b.receiver.fitOwed();
        uint256 d0 = _depthQ(b);
        _fundFees(b, 0.15 ether);
        // ALL_TO_FIT: the reward side joins FIT's share; 3/15 FIT; 2/15 depth.
        assertEq(b.receiver.fitOwed() - fit0, 0.1 ether + 0.03 ether, "10/15 reward (ALL_TO_FIT) + 3/15 FIT");
        assertEq(_depthQ(b) - d0, 0.02 ether, "2/15 into its own depth");
        assertEq(b.receiver.platformOwed(), 0, "C = 0: nothing to the platform");
    }

    function test_BC015_creatorSplitsTenThreeTwo() public {
        Box memory b = _graduated(_creatorParams(address(0), carol));
        (uint256 c0,) = b.receiver.creatorOwed();
        uint256 fit0 = b.receiver.fitOwed();
        uint256 d0 = _depthQ(b);
        _fundFees(b, 0.15 ether);
        (uint256 c1,) = b.receiver.creatorOwed();
        assertEq(c1 - c0, 0.1 ether, "10/15 to the creator");
        assertEq(b.receiver.fitOwed() - fit0, 0.03 ether, "3/15 FIT");
        assertEq(_depthQ(b) - d0, 0.02 ether, "2/15 depth");
    }

    /// F77: box 0's buyers' side 11/15 FIT, 2/15 its own pool, 2/15 platform (below the cap: kept); its sellers' side
    /// 13/15 burned, 2/15 its own pool.
    function test_BC015_box0SplitsElevenTwoTwo() public {
        Box memory b = _graduated(_box0Params());
        uint256 fit0 = b.receiver.fitOwed();
        uint256 owed0 = b.receiver.platformOwed();
        (uint256 dq0, uint256 dt0) = b.hook.depthBudget();
        _fundFees(b, 0.15 ether);
        assertEq(b.receiver.fitOwed() - fit0, 0.11 ether, "11/15 FIT");
        assertEq(b.receiver.platformOwed() - owed0, 0.02 ether, "2/15 kept (below the cap)");
        (uint256 dq1,) = b.hook.depthBudget();
        assertEq(dq1 - dq0, 0.02 ether, "2/15 into its own pool");
        // A T batch of 15 raw units (and a valid Q batch beside it): 13 burned, 2 into its pool.
        (, uint256 tCarry0) = b.receiver.carried();
        assertEq(tCarry0, 0, "fixture: no T carried yet");
        uint256 supply0 = b.t.totalSupply();
        _tFees(b, 15);
        _fees(b, 0.01 ether);
        b.receiver.collect(keeper);
        assertEq(supply0 - b.t.totalSupply(), 13, "13 raw units burned");
        (, uint256 dt1) = b.hook.depthBudget();
        assertEq(dt1 - dt0, 2, "2 raw units into its pool");
        assertEq(
            BoxSpecV1.BOX0_FEE_SHARE_FIT + BoxSpecV1.FEE_SHARE_DEPTH + BoxSpecV1.BOX0_FEE_SHARE_PLATFORM,
            BoxSpecV1.FEE_SHARE_DENOMINATOR
        );
        assertEq(BoxSpecV1.BOX0_FEE_SHARE_T_BURN + BoxSpecV1.FEE_SHARE_DEPTH, BoxSpecV1.FEE_SHARE_DENOMINATOR);
    }

    /// Remainders carried: the parts plus the carry always equal what came in, to the wei, for any batch sizes.
    function testFuzz_BC015_splitsAreExactWithCarry(uint96 a1, uint96 a2, uint96 a3) public {
        Box memory b = _graduated(_creatorParams(address(0), carol));
        (uint256 cq0,) = b.receiver.creatorOwed();
        uint256 fit0 = b.receiver.fitOwed();
        uint256 d0 = _depthQ(b);
        (uint256 carry0,) = b.receiver.carried();
        uint256 sum;
        uint96[3] memory xs = [a1, a2, a3];
        for (uint256 i; i < 3; ++i) {
            if (xs[i] == 0) continue;
            _fundFees(b, xs[i]);
            sum += xs[i];
        }
        (uint256 cq1,) = b.receiver.creatorOwed();
        (uint256 carry1,) = b.receiver.carried();
        uint256 parts = (cq1 - cq0) + (b.receiver.fitOwed() - fit0) + (_depthQ(b) - d0);
        assertEq(parts + carry1, sum + carry0, "every wei is split or carried");
        assertLt(carry1, 15);
        assertEq((cq1 - cq0) * 3, (b.receiver.fitOwed() - fit0) * 10, "10 : 3");
        assertEq((_depthQ(b) - d0) * 3, (b.receiver.fitOwed() - fit0) * 2, "2 : 3");
    }

    /// Box 0's buyers' side, any batch sizes (the cap's excess included): the parts plus the carry equal what came in,
    /// FIT gets 11 units for every 4 of depth and platform together, and the platform keeps at most 32 ETH an epoch.
    function testFuzz_BC015_box0SplitsAreExactWithCarry(uint96 a1, uint96 a2, uint96 a3) public {
        Box memory b = _graduated(_box0Params());
        Tot memory x0 = _tot(b);
        uint256 held0 = b.receiver.platformHeld();
        (uint256 carry0,) = b.receiver.carried();
        uint256 sum;
        uint96[3] memory xs = [a1, a2, a3];
        for (uint256 i; i < 3; ++i) {
            if (xs[i] == 0) continue;
            _fundFees(b, xs[i]);
            sum += xs[i];
        }
        Tot memory x1 = _tot(b);
        (uint256 carry1,) = b.receiver.carried();
        uint256 fit = x1.toFit - x0.toFit;
        uint256 rest =
            (x1.toPlatform - x0.toPlatform) + (b.receiver.platformHeld() - held0) + (x1.qToDepth - x0.qToDepth);
        assertEq(fit + rest + carry1, sum + carry0, "every wei is split or carried");
        assertLt(carry1, 15);
        assertEq(fit * 4, rest * 11, "11 : 4 (2/15 depth + 2/15 platform, its excess into depth)");
        assertLe(_kept(b), BoxSpecV1.PLATFORM_CAP_WEI, "at most 32 ETH kept in the epoch");
    }

    /// No unit of one box is credited to another: two boxes' receivers each see only their own pool.
    function test_BC015_noUnitOfOneBoxCreditedToAnother() public {
        Box memory a = _graduated(_standardParams(address(0)));
        Box memory c = _graduated(_creatorParams(address(0), carol));
        (uint256 qa,) = a.receiver.booked();
        (uint256 qc,) = c.receiver.booked();
        _buy(a, alice, 2 ether, 0);
        a.receiver.collect(keeper);
        (uint256 qc2,) = c.receiver.booked();
        assertEq(qc2, qc, "the other box's receiver did not move");
        (uint256 qa2,) = a.receiver.booked();
        assertGt(qa2, qa);
    }

    // ------------------------------------------------------------------------------------------------------------
    // BC-016: every reward action built in v1, end to end

    function test_BC016_allToFitReachesTheExecutorThroughFundBudget() public {
        Box memory b0 = _graduated(_box0Params());
        Box memory b = _graduated(_standardParams(b0.executor));
        _fundFees(b, 0.15 ether);
        uint256 owed = b.receiver.fitOwed();
        uint256 budget0 = FitBuybackExecutor(payable(b0.executor)).budget();
        assertEq(b.receiver.payFit(), owed);
        assertEq(FitBuybackExecutor(payable(b0.executor)).budget() - budget0, owed, "all of it, no treasury cut");
        assertEq(safe.balance, 0);
    }

    function test_BC016_burnTLowersSupplyExactlyOrWaits() public {
        Box memory b = _graduated(_standardParams(address(0)));
        // A floor that refuses the burn: the share waits, never counted as burned.
        SupplyFloorStandIn floor = new SupplyFloorStandIn();
        address vaultAddr = b.t.vault();
        vm.etch(vaultAddr, address(floor).code);
        SupplyFloorStandIn(vaultAddr).setFloor(type(uint256).max);
        _tFees(b, 15e18);
        _fees(b, 0.01 ether);
        uint256 supply0 = b.t.totalSupply();
        b.receiver.collect(keeper);
        assertEq(b.t.totalSupply(), supply0, "refused: nothing burned");
        assertEq(b.receiver.tBurnPending(), 10e18, "10/15 of 15 T waits");
        (,,,, uint256 tBurned,,) = b.receiver.totals();
        assertEq(tBurned, 0);
        SupplyFloorStandIn(vaultAddr).setFloor(0);
        _fees(b, 0.01 ether);
        b.receiver.collect(keeper);
        assertEq(supply0 - b.t.totalSupply(), 10e18, "BURN_T lowered T's supply by exactly the share");
        assertEq(b.receiver.tBurnPending(), 0);
    }

    function test_BC016_toCreatorCreditsExactlyTheRewardShare() public {
        Box memory b = _graduated(_creatorParams(address(0), carol));
        (uint256 q0, uint256 t0) = b.receiver.creatorOwed();
        _fundFees(b, 1.5 ether);
        _tFees(b, 150e18);
        _fees(b, 0.01 ether);
        b.receiver.collect(keeper);
        (uint256 q1, uint256 t1) = b.receiver.creatorOwed();
        assertGe(q1 - q0, 1 ether, "10/15 of the Q");
        assertEq(t1 - t0, 100e18, "10/15 of the T, in T (never sold)");
    }

    // ------------------------------------------------------------------------------------------------------------
    // BC-017: self-paying batches

    function test_BC017_noSwapMintsOrMovesFees() public {
        Box memory b = _buildAndLaunch(_standardParams(address(0)));
        _skipWindow(b);
        uint256 r0 = _claims(address(b.receiver), address(0));
        uint256 c0 = _claims(address(b.coord), address(0));
        (uint256 tOut,) = _buy(b, alice, 1 ether, 0);
        _sell(b, alice, tOut / 2);
        assertEq(_claims(address(b.receiver), address(0)), r0, "a swap mints nothing to the receiver");
        assertEq(_claims(address(b.coord), address(0)), c0, "nor to the coordinator");
        assertEq(address(b.receiver).balance, 0);
    }

    function test_BC017_belowAtAndAboveTheMinimum() public {
        Box memory b = _graduated(_standardParams(address(0)));
        _fees(b, 0.005 ether - 1);
        vm.expectRevert(abi.encodeWithSelector(IBoxReceiver.BatchTooSmall.selector, 0.005 ether - 1, 0.005 ether));
        b.receiver.collect(keeper);
        _fees(b, 1);
        uint256 k0 = keeper.balance;
        FeeBatch memory fb = b.receiver.collect(keeper);
        assertEq(fb.q, 0.005 ether, "at the minimum");
        assertEq(fb.tip, 0.0005 ether, "10% of the batch");
        assertEq(keeper.balance - k0, 0.0005 ether, "paid to the caller's tipTo in Q");
        _fees(b, 2 ether);
        fb = b.receiver.collect(keeper);
        assertEq(fb.tip, 0.0005 ether, "capped at 0.0005 ETH");
    }

    function test_BC017_feesEqualOnePercentOfEveryInput() public {
        Box memory b = _buildAndLaunch(_standardParams(address(0)));
        _skipWindow(b);
        uint256 inputs;
        for (uint256 i = 1; i < 6; ++i) {
            (, uint256 spent) = _buy(b, alice, i * 0.2 ether, 0);
            inputs += spent;
        }
        FeeBatch memory fb = b.receiver.collect(keeper);
        // The bootstrap's 0.0015 ETH paid its 1% too.
        assertApproxEqAbs(
            fb.q,
            (inputs + BoxSpecV1.BOOTSTRAP_ETH) / 100,
            10,
            "1% of every input (no protocol fee), within a wei per step"
        );
        assertEq(fb.qToReserve, b.hook.reserveCap(), "the reserve first");
    }

    // ------------------------------------------------------------------------------------------------------------
    // BC-019: the box's own trades are not charged again (REV-16)

    function test_BC019_moduleFeesReturnWholeFirst() public {
        Box memory b = _graduated(_box0Params());
        uint256 owed0 = b.receiver.platformOwed();
        vm.prank(b.executor);
        b.receiver.noteModuleFees(0.3 ether, 0);
        uint256 fit0 = b.receiver.fitOwed();
        _fees(b, 0.3 ether + 0.0005 ether + 1.5 ether); // the batch holds the module's own 0.3 ETH fee
        b.receiver.collect(keeper);
        // 0.3 ETH back whole; the tip; the rest 1.5 ETH split 11/15, 2/15 depth and 2/15 platform.
        assertEq(b.receiver.fitOwed() - fit0, 0.3 ether + 1.1 ether, "the module's own fee back, then 11/15");
        assertEq(b.receiver.platformOwed() - owed0, 0.2 ether, "2/15 of the rest only");
        (uint256 mq,) = b.receiver.moduleFeesPending();
        assertEq(mq, 0);
        vm.expectRevert(abi.encodeWithSelector(IBoxReceiver.NotModule.selector, alice));
        vm.prank(alice);
        b.receiver.noteModuleFees(1, 0);
        Box memory s = _graduated(_standardParams(b.executor));
        vm.prank(b.executor);
        vm.expectRevert(abi.encodeWithSelector(IBoxReceiver.NotModule.selector, b.executor));
        s.receiver.noteModuleFees(1, 0);
    }

    /// End to end: the executor's own chunk pays the pool fee; it reports a lower bound of it, which the receiver
    /// returns whole (the closed pool's fee from that swap is all the hook's positions earned).
    function test_BC019_executorReportsItsOwnFeeEndToEnd() public {
        Box memory b = _graduated(_box0Params());
        FitBuybackExecutor ex = FitBuybackExecutor(payable(b.executor));
        for (uint256 i; i < 600; ++i) {
            _roll(1);
            ex.poke();
        }
        _fees(b, 0.01 ether);
        b.receiver.collect(keeper); // clear the fees so far
        vm.deal(address(this), 1 ether);
        ex.fundBudget{value: 1 ether}();
        (, uint256 spent,) = ex.execute(1);
        assertGt(spent, 0, "bought a chunk");
        (uint256 noted,) = b.receiver.moduleFeesPending();
        _fees(b, 0.01 ether);
        FeeBatch memory fb = b.receiver.collect(keeper);
        uint256 earned = fb.q - 0.01 ether;
        assertLe(noted, earned, "never more than the positions got");
        assertLe(earned - noted, 16, "a lower bound within v4's rounding");
        assertEq(noted, spent / 100 - 2 * 4 * 1, "1% LP share less two wei per step");
    }

    // ------------------------------------------------------------------------------------------------------------
    // BC-020: nothing reaches swapping modules before graduation

    function test_BC020_fitShareWaitsForGraduation() public {
        Box memory b = _buildAndLaunch(_box0Params());
        _skipWindow(b);
        (uint256 t,) = _buy(b, alice, 2 ether, 0);
        _sell(b, alice, t);
        b.receiver.collect(keeper);
        assertGt(b.receiver.fitOwed(), 0, "11/15 credited");
        // F77: its 2/15 depth parts (Q and T) wait in the receiver too; nothing reaches the hook before graduation.
        (uint256 dq, uint256 dt) = b.receiver.depthHeld();
        assertEq(dq, b.receiver.platformHeld(), "the Q depth part: 2/15, as the platform's");
        assertGt(dt, 0, "the T depth part (sellers' 2/15)");
        (uint256 hq, uint256 ht) = b.hook.depthBudget();
        assertEq(hq | ht, 0, "nothing in the hook before graduation");
        vm.expectRevert(IBoxReceiver.NotGraduated.selector);
        b.receiver.payFit();
        FitBuybackExecutor ex = FitBuybackExecutor(payable(b.executor));
        vm.deal(address(this), 1 ether);
        ex.fundBudget{value: 1 ether}();
        (, uint256 spent,) = ex.execute(1);
        assertEq(spent, 0, "FIT's executor buys nothing before box 0 graduates");
        assertGt(b.receiver.platformHeld(), 0, "the 2/15 is held too");
        _closeAndGraduate(b);
        assertGt(b.receiver.payFit(), 0);
        (hq, ht) = b.hook.depthBudget();
        assertGe(hq, dq, "the held Q depth moved to the hook at the settlement");
        assertEq(ht, dt, "the held T depth too");
    }

    function test_BC102_otherBoxesFitShareWaitsForFit() public {
        MockFitExecutor ex = new MockFitExecutor();
        Box memory b = _graduated(_standardParams(address(ex)));
        _fundFees(b, 0.15 ether);
        vm.expectRevert(IBoxReceiver.NotGraduated.selector);
        b.receiver.payFit();
        ex.setGraduated(true);
        assertEq(b.receiver.payFit(), b.receiver.fitOwed() + ex.funded());
    }

    // ------------------------------------------------------------------------------------------------------------
    // BC-021: pull only; only box 0 has a platform payout

    function test_BC021_revertingRecipientsBlockOnlyThemselves() public {
        RefusingRecipient payee = new RefusingRecipient();
        Box memory b = _graduated(_creatorParams(address(0), address(payee)));
        MockFitExecutor(payable(b.executor)).setGraduated(true);
        _fundFees(b, 1.5 ether);
        vm.expectRevert();
        payee.call(address(b.receiver), abi.encodeCall(IBoxReceiver.claimCreator, (address(payee))));
        // Its own claim to another address works; the others' flows never waited.
        payee.call(address(b.receiver), abi.encodeCall(IBoxReceiver.claimCreator, (dave())));
        assertGt(dave().balance, 0);
        // A tip recipient that refuses blocks only its caller's collect.
        _fees(b, 0.1 ether);
        vm.expectRevert();
        b.receiver.collect(address(payee));
        b.receiver.collect(keeper);
        // FIT's share is paid whatever the payee does.
        assertGt(b.receiver.payFit(), 0);
    }

    function dave() internal returns (address) {
        return makeAddr("s45.dave");
    }

    function test_BC021_box0PaysOnlyTheFixedSafeAndOnlyItsCappedShare() public {
        AcceptingSafe aSafe = new AcceptingSafe();
        safe = address(aSafe);
        Box memory b = _graduated(_box0Params());
        _fundFees(b, 1.5 ether);
        uint256 owed = b.receiver.platformOwed();
        vm.prank(alice);
        assertEq(b.receiver.payPlatform(), owed, "anyone triggers it");
        assertEq(address(aSafe).balance, owed, "delivered to the Safe");
        vm.expectRevert(IBoxReceiver.NothingOwed.selector);
        b.receiver.payPlatform();
    }

    function test_BC021_aRefusingSafeKeepsItsCredit() public {
        RefusingRecipient refusing = new RefusingRecipient();
        safe = address(refusing);
        Box memory b = _graduated(_box0Params());
        _fundFees(b, 1.5 ether);
        uint256 owed = b.receiver.platformOwed();
        vm.expectRevert();
        b.receiver.payPlatform();
        assertEq(b.receiver.platformOwed(), owed, "the credit stays");
        assertGt(b.receiver.payFit(), 0, "nothing else waits for it");
    }

    function test_BC109_otherBoxesHaveNoPlatformPayee() public {
        Box memory b = _graduated(_standardParams(address(0)));
        assertEq(b.receiver.platformSafe(), address(0));
        vm.expectRevert(IBoxReceiver.NotBox0.selector);
        b.receiver.payPlatform();
        (uint256 e, uint256 k, uint256 r) = b.receiver.platformEpoch();
        assertEq(e | k | r, 0);
        // A standard receiver built with a platform address is refused at initialize.
        Params memory p = _standardParams(address(0));
        Box memory c = _build(p);
        address recv = address(c.receiver);
        bytes memory args = _receiverArgs(c, p, address(c.hook));
        // overwrite the platformSafe argument (offset 101) with a non-zero address
        for (uint256 i; i < 20; ++i) {
            args[101 + i] = bytes20(safe)[i];
        }
        vm.etch(recv, _clone(address(receiverImpl), args));
        vm.prank(address(c.coord));
        vm.expectRevert(IBoxReceiver.ZeroAddress.selector);
        c.receiver.initialize();
    }

    // ------------------------------------------------------------------------------------------------------------
    // BC-106: box 0's platform share is capped at 32 ETH per 30-day epoch, with no carry-over

    function test_BC106_capPerEpochNoCarryOver() public {
        Box memory b = _buildAndLaunch(_box0Params());
        _skipWindow(b);
        _close(b, carol);
        b.receiver.collect(keeper); // the curve's fees, before graduation: held
        // Top the held 2/15 up to exactly 0.006 ETH (BC-106's "holding a 2/15 share of 0.006 ETH").
        uint256 held = b.receiver.platformHeld();
        (uint256 carry,) = b.receiver.carried();
        uint256 units = (0.006 ether - held) / 2;
        _fundFees(b, units * 15 - carry);
        assertEq(b.receiver.platformHeld(), 0.006 ether, "held before graduation");
        (uint256 heldDepth,) = b.receiver.depthHeld();
        assertEq(heldDepth, 0.006 ether, "box 0's 2/15 depth part held beside it (F77)");
        b.coord.graduate();
        uint256 g = block.timestamp;
        uint256 settledKept = _kept(b);
        assertGe(settledKept, 0.006 ether, "the held share counts first in epoch 0");
        uint256 dustP = settledKept - 0.006 ether; // the migration's Q dust, split at the settlement
        assertLt(dustP, 1e6, "dust only");
        uint256 depth0 = _depthQ(b);
        // F77: each batch gives 11/15 to FIT, 2/15 to box 0's own pool and P = 2/15; P - keep joins its pool too.
        _batch(b, 150 ether, 110 ether, 20 ether, 20 ether);
        _batch(b, 112.5 ether, 82.5 ether, 11.994 ether - dustP, 15 ether + 3.006 ether + dustP);
        vm.warp(g + 2_591_999);
        _batch(b, 7.5 ether, 5.5 ether, 0, 1 ether + 1 ether);
        assertEq(_kept(b), 32 ether, "epoch 0 keeps exactly 32 ETH");
        assertEq(
            _depthQ(b) - depth0,
            36 ether + 4.006 ether + dustP,
            "20 + 15 + 1 ETH of 2/15, plus 3.006 + 1 ETH above the cap"
        );
        assertEq(b.receiver.payPlatform(), 32 ether);
        vm.warp(g + 2_592_000);
        _batch(b, 37.5 ether, 27.5 ether, 5 ether, 5 ether);
        _assertEpoch(b, 1, 5 ether, 27 ether);
        vm.warp(g + 5_184_000);
        _batch(b, 300 ether, 220 ether, 32 ether, 40 ether + 8 ether);
        _assertEpoch(b, 2, 32 ether, 0); // epoch 1's unused 27 ETH is not carried over
        assertEq(b.receiver.payPlatform(), 37 ether);
        assertEq(safe.balance, 69 ether, "32 + 5 + 32");
    }

    function _assertEpoch(Box memory b, uint256 epoch, uint256 kept, uint256 remaining) internal view {
        (uint256 e, uint256 k, uint256 r) = b.receiver.platformEpoch();
        assertEq(e, epoch, "epoch");
        assertEq(k, kept, "kept in the epoch");
        assertEq(r, remaining, "room left");
    }

    function _batch(Box memory b, uint256 amount, uint256 fit, uint256 keep, uint256 toDepth) internal {
        uint256 fit0 = b.receiver.fitOwed();
        uint256 owed0 = b.receiver.platformOwed();
        uint256 d0 = _depthQ(b);
        _fundFees(b, amount);
        assertEq(b.receiver.fitOwed() - fit0, fit, "11/15 to FIT's executor");
        assertEq(b.receiver.platformOwed() - owed0, keep, "keep = min(P, 32 ETH - kept)");
        assertEq(_depthQ(b) - d0, toDepth, "2/15 and P - keep to box 0's depth at once");
    }

    // ------------------------------------------------------------------------------------------------------------
    // BC-107: royalties and ETH gifts cannot push the platform past the cap

    function test_BC107_royaltiesGiftsAndForcedEthStayUnderTheCap() public {
        Box memory b = _graduated(_box0Params());
        // Bring the epoch to exactly 31 ETH kept.
        uint256 kept0 = _kept(b);
        (uint256 carry,) = b.receiver.carried();
        _fundFees(b, (31 ether - kept0) / 2 * 15 - carry);
        assertEq(_kept(b), 31 ether);
        MockWETH weth = new MockWETH();
        BoxRoyaltyRouter router = _royaltyRouter(b, address(weth), RoyaltyDestination.FeeHandling);
        vm.deal(address(this), 100 ether);
        weth.deposit{value: 30 ether}();
        weth.transfer(address(router), 30 ether);
        (bool ok,) = address(router).call{value: 6 ether}("");
        assertTrue(ok);
        uint256 fit0 = b.receiver.fitOwed();
        uint256 d0 = _depthQ(b);
        assertEq(router.flush(), 36 ether, "unwraps the 30 WETH, sends all 36 ETH");
        assertEq(b.receiver.fitOwed() - fit0, 26.4 ether, "11/15 to FIT");
        assertEq(_kept(b), 32 ether, "1 ETH kept: the cap reached");
        assertEq(_depthQ(b) - d0, 4.8 ether + 3.8 ether, "the 2/15 depth part and 3.8 ETH above the cap to depth");
        d0 = _depthQ(b);
        fit0 = b.receiver.fitOwed();
        _fundFees(b, 15 ether);
        assertEq(b.receiver.fitOwed() - fit0, 11 ether, "the gift's 11/15 to FIT");
        assertEq(_depthQ(b) - d0, 4 ether, "the gift's 2/15 depth and its 2/15 platform share all to depth");
        FitBuybackExecutor ex = FitBuybackExecutor(payable(b.executor));
        uint256 budget0 = ex.budget();
        (ok,) = address(ex).call{value: 10 ether}("");
        assertTrue(ok);
        assertEq(ex.budget() - budget0, 10 ether, "the executor's receive(): all to its budget (BC-108)");
        vm.deal(address(b.receiver), address(b.receiver).balance + 1 ether); // forced ETH
        d0 = _depthQ(b);
        vm.deal(alice, 5 ether);
        vm.prank(alice);
        b.receiver.fundDepth{value: 5 ether}();
        assertEq(_depthQ(b) - d0, 6 ether, "fundDepth's 5 ETH, and the forced 1 ETH may only join depth");
        d0 = _depthQ(b);
        _fees(b, 75 ether);
        b.receiver.collect(keeper);
        assertEq(_kept(b), 32 ether, "the 75 ETH batch keeps nothing more");
        assertGt(_depthQ(b) - d0, 19.99 ether, "its 2/15 depth and its 2/15 platform share to depth");
        assertEq(b.receiver.payPlatform(), 32 ether);
        assertEq(safe.balance, 32 ether, "the Safe's total for the epoch is exactly 32 ETH");
    }

    // ------------------------------------------------------------------------------------------------------------
    // BC-108: FIT's executor pays no uncapped treasury share

    function test_BC108_executorPaysNoTreasury() public {
        Box memory b = _graduated(_box0Params());
        FitBuybackExecutor ex = FitBuybackExecutor(payable(b.executor));
        uint256 budget0 = ex.budget();
        vm.deal(alice, 15 ether);
        vm.prank(alice);
        (bool ok,) = address(ex).call{value: 15 ether}("");
        assertTrue(ok);
        assertEq(ex.budget() - budget0, 15 ether, "15 ETH in, 15 ETH to the budget");
        AcceptingSafe sender = new AcceptingSafe();
        vm.deal(address(sender), 1 ether);
        vm.prank(address(sender));
        ex.fundBudget{value: 1 ether}();
        // box 0's receiver and another box's receiver pay through fundBudget().
        _fundFees(b, 0.15 ether);
        b.receiver.payFit();
        Box memory s = _graduated(_standardParams(b.executor));
        _fundFees(s, 0.15 ether);
        s.receiver.payFit();
        assertEq(safe.balance, 0, "no ETH reaching the executor by any path paid the Safe");
        assertEq(ex.budget(), address(ex).balance, "everything held is budget");
        // No treasury address, share or payTreasury().
        (bool has,) = address(ex).staticcall(abi.encodeWithSignature("treasury()"));
        assertFalse(has);
        (has,) = address(ex).call(abi.encodeWithSignature("payTreasury()"));
        assertFalse(has);
        (has,) = address(ex).staticcall(abi.encodeWithSignature("treasuryOwed()"));
        assertFalse(has);
    }

    // ------------------------------------------------------------------------------------------------------------
    // BC-111: the reward side to the creator pays exactly 10/15 (held until graduation, F69 C1)

    function test_BC111_creatorTenFifteenthsHeldThenOwed_eoa() public {
        _creatorCase(carol);
    }

    function test_BC111_creatorTenFifteenthsHeldThenOwed_safe() public {
        _creatorCase(address(new AcceptingSafe()));
    }

    function _creatorCase(address payee) internal {
        Box memory c = _buildAndLaunch(_creatorParams(address(0), payee));
        Box memory twin = _buildAndLaunch(_standardParams(address(0)));
        _skipWindow(c);
        _sameTrades(c);
        _sameTrades(twin);
        c.receiver.collect(keeper);
        twin.receiver.collect(keeper);
        (uint256 hq, uint256 ht) = c.receiver.creatorHeld();
        (uint256 oq, uint256 ot) = c.receiver.creatorOwed();
        assertGt(hq, 0, "held before graduation (F69 C1)");
        assertGt(ht, 0, "the T-side reward share, in T");
        assertEq(oq | ot, 0, "nothing claimable before graduation");
        Tot memory tc = _tot(c);
        Tot memory tt = _tot(twin);
        assertEq(tc.qToDepth, tt.qToDepth, "depth Q equals the twin's to the wei");
        assertEq(tc.tToDepth, tt.tToDepth, "depth T too");
        assertEq(tt.toFit - tc.toFit, tc.qToCreator, "the twin's extra FIT is exactly the creator's 10/15");
        assertEq(tt.tBurned, tc.tToCreator, "the twin burns what the creator is credited in T");
        _closeAndGraduate(c);
        (oq, ot) = c.receiver.creatorOwed();
        assertGe(oq, hq);
        assertEq(ot, ht);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IBoxReceiver.NotPayee.selector, alice));
        c.receiver.claimCreator(alice);
        uint256 tBefore = c.t.balanceOf(payee);
        vm.prank(payee);
        (uint256 pq, uint256 pt) = c.receiver.claimCreator(payee);
        assertEq(pq, oq);
        assertEq(pt, ot);
        assertEq(c.t.balanceOf(payee) - tBefore, ot, "paid as collected: T as T");
    }

    function _sameTrades(Box memory b) internal {
        _skipWindow(b);
        address trader = makeAddr("s45.sameTrader");
        (uint256 t1,) = _buy(b, trader, 0.7 ether, 0);
        _sell(b, trader, t1 / 3);
        (uint256 t2,) = _buy(b, trader, 0.4 ether, 0);
        _sell(b, trader, t2 / 2);
    }

    function test_creatorPayee_handOverOnlyByTheHolderInTwoSteps() public {
        Box memory b = _graduated(_creatorParams(address(0), carol));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IBoxReceiver.NotPayee.selector, alice));
        b.receiver.proposeCreatorPayee(alice);
        vm.prank(carol);
        b.receiver.proposeCreatorPayee(bob);
        assertEq(b.receiver.pendingCreatorPayee(), bob);
        assertEq(b.receiver.creatorPayee(), carol, "unchanged until accepted");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IBoxReceiver.NotPendingPayee.selector, alice));
        b.receiver.acceptCreatorPayee();
        _fundFees(b, 1.5 ether);
        vm.prank(bob);
        b.receiver.acceptCreatorPayee();
        assertEq(b.receiver.creatorPayee(), bob, "the role carries every unclaimed credit");
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(IBoxReceiver.NotPayee.selector, carol));
        b.receiver.claimCreator(carol);
        vm.prank(bob);
        (uint256 q,) = b.receiver.claimCreator(bob);
        assertGe(q, 1 ether);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Initialisation: what v1 builds, and nothing else

    /// S5.M1: the four actions that need the swap module (BUYBACK_BURN_T, CREATOR_IN_T, SELL_FOR_Q, CREATOR_IN_Q) are
    /// accepted now (BoxSwapHandOff.t.sol, BC-130); the rest of what v1 does not build stays refused.
    function test_initialize_refusesWhatV1DoesNotBuild() public {
        uint8[2][4] memory refused = [
            [BoxSpecV1.Q_STREAM_BURN_Q, BoxSpecV1.T_STREAM_BURN_T],
            [BoxSpecV1.Q_STREAM_PAY_HOLDERS_Q, BoxSpecV1.T_STREAM_BURN_T],
            [BoxSpecV1.Q_STREAM_ALL_TO_FIT, BoxSpecV1.T_STREAM_PAY_HOLDERS_T],
            [BoxSpecV1.Q_STREAM_ALL_TO_FIT, BoxSpecV1.T_STREAM_PER_ITEM_STREAM]
        ];
        for (uint256 i; i < refused.length; ++i) {
            Params memory p = _standardParams(address(0));
            (p.qStream, p.tStream) = (refused[i][0], refused[i][1]);
            Box memory b = _build(p);
            vm.prank(address(b.coord));
            vm.expectRevert(abi.encodeWithSelector(IBoxReceiver.ActionNotBuilt.selector, p.qStream, p.tStream));
            b.receiver.initialize();
        }
        // The payout currency is part of the stream value (main's BoxSpec, F70; review of sh-core-v1): HOLDERS_IN_* (7)
        // are holder payouts (S14). CREATOR_IN_T and CREATOR_IN_Q (6) go to the swap module since S5.M1.
        uint8[2][2] memory paidOtherwise =
            [[uint8(7), BoxSpecV1.T_STREAM_TO_CREATOR], [BoxSpecV1.Q_STREAM_TO_CREATOR, uint8(7)]];
        for (uint256 i; i < paidOtherwise.length; ++i) {
            Params memory p = _creatorParams(address(0), carol);
            (p.qStream, p.tStream) = (paidOtherwise[i][0], paidOtherwise[i][1]);
            Box memory b = _build(p);
            vm.prank(address(b.coord));
            vm.expectRevert(abi.encodeWithSelector(IBoxReceiver.ActionNotBuilt.selector, p.qStream, p.tStream));
            b.receiver.initialize();
        }
        // TO_CREATOR needs a payee; box 0 cannot pick it.
        Params memory q = _creatorParams(address(0), address(0));
        Box memory c = _build(q);
        vm.prank(address(c.coord));
        vm.expectRevert();
        c.receiver.initialize();
    }

    // ------------------------------------------------------------------------------------------------------------
    // BC-114: the royalty router never refuses a payment and flushes to its one sink

    function test_BC114_receiveNeverRefusesAndWritesNothing() public {
        Box memory b = _buildAndLaunch(_standardParams(address(0)));
        MockWETH weth = new MockWETH();
        BoxRoyaltyRouter r = _royaltyRouter(b, address(weth), RoyaltyDestination.FeeHandling);
        vm.record();
        (bool ok,) = address(r).call{value: 0}("");
        assertTrue(ok, "0 wei");
        StipendSender s = new StipendSender();
        vm.deal(address(s), 1 ether);
        s.send(payable(address(r)), 0.5 ether);
        (ok,) = address(r).call{value: 0}("");
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (ok,) = address(r).call{value: 0.25 ether}("");
        assertTrue(ok);
        (, bytes32[] memory writes) = vm.accesses(address(r));
        assertEq(writes.length, 0, "receive() writes no storage");
        assertEq(address(r).balance, 0.75 ether);
        vm.expectRevert(IBoxRoyaltyRouter.NotGraduated.selector);
        r.flush();
    }

    function test_BC114_flushToTheReceiversIntakeOnly() public {
        Box memory b = _graduated(_standardParams(address(0)));
        MockWETH weth = new MockWETH();
        BoxRoyaltyRouter feeR = _royaltyRouter(b, address(weth), RoyaltyDestination.FeeHandling);
        vm.deal(address(this), 10 ether);
        weth.deposit{value: 3 ether}();
        weth.transfer(address(feeR), 3 ether);
        (bool ok,) = address(feeR).call{value: 1.5 ether}("");
        assertTrue(ok);
        uint256 fit0 = b.receiver.fitOwed();
        assertEq(feeR.sweep(address(weth)), 4.5 ether, "sweep(WETH) is a flush");
        assertEq(b.receiver.fitOwed() - fit0, 3.9 ether, "split like the box's Q fees (13/15 for ALL_TO_FIT)");
        assertEq(address(feeR).balance, 0);
        vm.expectRevert(IBoxRoyaltyRouter.NothingToFlush.selector);
        feeR.flush();
        vm.expectRevert(abi.encodeWithSelector(IBoxRoyaltyRouter.TokenNotTaken.selector, address(0xdead)));
        feeR.sweep(address(0xdead));
        // PoolDepth: all of it to depth.
        boxSeed++;
        BoxRoyaltyRouter depthR = _royaltyRouter(b, address(weth), RoyaltyDestination.PoolDepth);
        (ok,) = address(depthR).call{value: 2 ether}("");
        uint256 d0 = _depthQ(b);
        depthR.flush();
        assertEq(_depthQ(b) - d0, 2 ether);
    }

    function test_BC114_aRevertingSinkLeavesTheEthForTheNextFlush() public {
        Box memory b = _graduated(_standardParams(address(0)));
        // A router whose receiver argument is a contract that refuses.
        RefusingRecipient sink = new RefusingRecipient();
        address a = _addr("royaltyRefusing");
        vm.etch(
            a,
            BoxClones.receivingRuntime(
                address(royaltyImpl),
                abi.encodePacked(address(b.coord), address(sink), address(0), uint8(RoyaltyDestination.FeeHandling))
            )
        );
        (bool ok,) = a.call{value: 1 ether}("");
        assertTrue(ok);
        vm.expectRevert(IBoxRoyaltyRouter.SinkFailed.selector);
        BoxRoyaltyRouter(payable(a)).flush();
        assertEq(a.balance, 1 ether, "nothing lost");
    }

    // ------------------------------------------------------------------------------------------------------------
    // BC-118: only the depth share deepens the pool; burns and rewards stay whole

    function test_BC118_burnAndRewardTotalsIgnoreTheDepthRule() public {
        Params memory pOn = _creatorParams(address(0), carol);
        pOn.averageKind = 1;
        Box memory on = _graduated(pOn);
        Box memory off = _graduated(_creatorParams(address(0), carol));
        Rule118 memory r;
        for (uint256 round; round < 3; ++round) {
            _fixedTrades(on);
            _fixedTrades(off);
            _fees(on, 0.5 ether);
            _fees(off, 0.5 ether);
            uint256 tw = 0.5 ether * uint256(_sqrtP(on)) / (1 << 96) * uint256(_sqrtP(on)) / (1 << 96);
            _tFees(on, tw);
            _tFees(off, tw);
            _collectCounted(on, r);
            off.receiver.collect(keeper);
            _roll(300);
            (, int24 t,,) = pm.getSlot0(on.key.toId());
            _avgSet(on, t);
            _deepenCounted(on, r);
        }
        assertGt(on.hook.pairedLiquidity(), 0, "the rule ran");
        assertEq(off.hook.pairedLiquidity(), 0);
        Tot memory xOn = _tot(on);
        Tot memory xOff = _tot(off);
        _log118(r, xOn, xOff);
        // Fee amounts do not depend on liquidity (1% of each input); what may differ is BC-118's named residue.
        uint256 residue = _residue118(r);
        assertApproxEqAbs(xOn.toFit, xOff.toFit, residue, "FIT's share whole");
        assertApproxEqAbs(xOn.qToCreator, xOff.qToCreator, residue, "the creator's Q whole");
        assertApproxEqAbs(xOn.tToCreator, xOff.tToCreator, residue, "the creator's T whole");
        (uint256 hq,) = on.hook.depthBudget();
        assertEq(_claims(address(on.hook), address(0)), hq, "the hook's Q claims are exactly the depth budget");
        assertEq(address(on.hook).balance, 0, "and it holds nothing else");
    }

    /// F77: box 0's pool grows by pair and lock too; FIT's 11/15 and the 13/15 burned stay whole whether it adds or
    /// not, and only its 2/15 depth parts (and the platform's excess) are ever in its hook.
    function test_BC118_box0BurnAndFitTotalsIgnoreTheDepthRule() public {
        Params memory pOn = _box0Params();
        pOn.averageKind = 1;
        Box memory on = _graduated(pOn);
        Box memory off = _graduated(_box0Params());
        Rule118 memory r;
        for (uint256 round; round < 3; ++round) {
            _fixedTrades(on);
            _fixedTrades(off);
            _fees(on, 0.5 ether);
            _fees(off, 0.5 ether);
            // Sellers' T worth 2 ETH at the price, so the T side's 2/15 reaches MIN_ADD.
            uint256 tw = 2 ether * uint256(_sqrtP(on)) / (1 << 96) * uint256(_sqrtP(on)) / (1 << 96);
            _tFees(on, tw);
            _tFees(off, tw);
            _collectCounted(on, r);
            off.receiver.collect(keeper);
            _roll(300);
            (, int24 t,,) = pm.getSlot0(on.key.toId());
            _avgSet(on, t);
            _deepenCounted(on, r);
        }
        assertGt(on.hook.pairedLiquidity(), 0, "box 0 pairs and locks");
        assertEq(off.hook.pairedLiquidity(), 0);
        Tot memory xOn = _tot(on);
        Tot memory xOff = _tot(off);
        _log118(r, xOn, xOff);
        uint256 residue = _residue118(r);
        assertApproxEqAbs(xOn.toFit, xOff.toFit, residue, "FIT's 11/15 whole");
        assertApproxEqAbs(xOn.tBurned, xOff.tBurned, residue, "the 13/15 burned whole");
        (uint256 hq, uint256 ht) = on.hook.depthBudget();
        assertEq(_claims(address(on.hook), address(0)), hq, "the hook's Q claims are exactly the depth budget");
        assertEq(_claims(address(on.hook), address(on.t)), ht, "and its T claims");
        assertEq(address(on.hook).balance, 0, "and it holds nothing else");
    }

    /// FQ-12 (F147): BC-118's residue named and pinned where it occurs. Box 0 with Q fees only, so the T side stays below
    /// MIN_ADD and `deepen()` converts part of the depth Q into T (S5.M5) before it can pair. Each conversion's fee note
    /// keeps 2 x SLACK raw units of its LP fee back from the depth budget (BoxSwapBounds.feeNote, BC-133), and that part
    /// is split like any fee. So the rule's run is never below the baseline in FIT's 11/15, the platform's 2/15 or the Q
    /// depth parts, and above it by at most the named residue; the T side stays whole. Measured: 3 conversions and 2
    /// pairs; FIT +11, the platform +2, the Q depth parts +2 wei (15 wei over 3 conversions); the T side equal.
    function test_BC118_box0ConversionResidueIsTheFeeNoteSlack() public {
        Params memory pOn = _box0Params();
        pOn.averageKind = 1;
        Box memory on = _graduated(pOn);
        Box memory off = _graduated(_box0Params());
        Rule118 memory r;
        for (uint256 round; round < 3; ++round) {
            _fixedTrades(on);
            _fixedTrades(off);
            _fees(on, 0.5 ether);
            _fees(off, 0.5 ether);
            _collectCounted(on, r);
            off.receiver.collect(keeper);
            _roll(300);
            (, int24 t,,) = pm.getSlot0(on.key.toId());
            _avgSet(on, t);
            _deepenCounted(on, r);
        }
        assertGt(r.conversions, 0, "the rule converted");
        Tot memory xOn = _tot(on);
        Tot memory xOff = _tot(off);
        _log118(r, xOn, xOff);
        uint256 residue = _residue118(r);
        assertGe(xOn.toFit, xOff.toFit, "FIT's 11/15 never below the baseline");
        assertGe(xOn.toPlatform, xOff.toPlatform, "nor the platform's 2/15");
        assertGe(xOn.qToDepth, xOff.qToDepth, "nor the Q depth parts");
        uint256 qAbove = (xOn.toFit - xOff.toFit) + (xOn.toPlatform - xOff.toPlatform) + (xOn.qToDepth - xOff.qToDepth);
        assertLe(qAbove, residue, "the Q side above the baseline by at most the named residue");
        assertApproxEqAbs(xOn.tBurned, xOff.tBurned, residue, "the 13/15 burned whole");
        assertApproxEqAbs(xOn.tToDepth, xOff.tToDepth, residue, "the T depth parts whole");
        (uint256 hq, uint256 ht) = on.hook.depthBudget();
        assertEq(_claims(address(on.hook), address(0)), hq, "the hook's Q claims are exactly the depth budget");
        assertEq(_claims(address(on.hook), address(on.t)), ht, "and its T claims");
    }

    /// Codex check F1 (XR-SH-AUDIT-B0-FINAL): repeated paired adds go into one position (BoxHookExtension._sizePair
    /// fixes the full range, _addDepth reuses _SALT_PAIR), and BoxHook._harvestAll pokes at most four after
    /// graduation. So three adds to the same pair over three collects allow at most four positions per collect, and
    /// more adds to it do not enlarge the allowance.
    function test_BC118_repeatedPairAddsShareOnePosition() public {
        Params memory p = _creatorParams(address(0), carol);
        p.averageKind = 1;
        Box memory b = _graduated(p);
        Rule118 memory r;
        uint128 last;
        for (uint256 round; round < 3; ++round) {
            _fixedTrades(b);
            _fees(b, 0.5 ether);
            uint256 tw = 0.5 ether * uint256(_sqrtP(b)) / (1 << 96) * uint256(_sqrtP(b)) / (1 << 96);
            _tFees(b, tw);
            _collectCounted(b, r);
            _roll(300);
            (, int24 t,,) = pm.getSlot0(b.key.toId());
            _avgSet(b, t);
            _deepenCounted(b, r);
            assertGt(b.hook.pairedLiquidity(), last, "each round adds to the same pair");
            last = b.hook.pairedLiquidity();
        }
        assertEq(r.pairs, 3, "three paired adds");
        assertEq(r.conversions, 0, "no conversion");
        emit log_named_uint("BC-118 positions harvested", r.positions);
        uint256 residue = _residue118(r);
        assertEq(r.pairPokes, 0, "no fee-bearing pair poke: no swap between a collect and the next add");
        assertLe(residue, 3 * 4, "at most four positions per collect (BoxHook._harvestAll)");
        r.pairs = 10;
        assertEq(_residue118(r), residue, "more adds to the same pair do not enlarge the allowance");
    }

    /// @dev What the rule's run did: its conversions, its paired adds, the positions each collect harvested (summed)
    /// and the fee-bearing pair pokes inside `deepen()`; `g0`/`g1` are the pool's fee growth at the last collect.
    struct Rule118 {
        uint256 conversions;
        uint256 pairs;
        uint256 positions;
        uint256 pairPokes;
        uint256 g0;
        uint256 g1;
    }

    /// @dev One collect, counting the positions its harvest pokes (BoxHook._harvestAll: after graduation the ask, the
    /// bid, the sentinel and the pair, each counted only when it holds liquidity; repeated adds share the one pair).
    function _collectCounted(Box memory b, Rule118 memory r) internal {
        (uint128 ask, uint128 bid, uint128 sentinel) = b.hook.graduatedLayout();
        if (ask != 0) ++r.positions;
        if (bid != 0) ++r.positions;
        if (sentinel != 0) ++r.positions;
        if (b.hook.pairedLiquidity() != 0) ++r.positions;
        b.receiver.collect(keeper);
        (r.g0, r.g1) = pm.getFeeGrowthGlobals(b.key.toId());
    }

    /// @dev One `deepen()`, counting its conversions and paired adds. An add into an existing pair pokes it first
    /// (BoxHookExtension._prepareDepthPosition); that poke floors fees once more only if fees accrued since the last
    /// collect's harvest: the pool's fee growth moved, or this call converted (its swap pays the positions' LP fee).
    function _deepenCounted(Box memory b, Rule118 memory r) internal {
        bool pairedBefore = b.hook.pairedLiquidity() != 0;
        (uint256 g0, uint256 g1) = pm.getFeeGrowthGlobals(b.key.toId());
        bool accrued = g0 != r.g0 || g1 != r.g1;
        vm.recordLogs();
        b.hook.deepen(keeper);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(b.hook)) continue;
            if (logs[i].topics[0] == IBoxHook.DepthConverted.selector) {
                ++r.conversions;
                accrued = true;
            }
            if (logs[i].topics[0] == IBoxHook.Deepened.selector) {
                (DepthKind kind,,, uint128 liquidity,,,) =
                    abi.decode(logs[i].data, (DepthKind, int24, int24, uint128, uint256, uint256, uint256));
                if (kind == DepthKind.Pair) ++r.pairs;
                if (kind == DepthKind.Pair && liquidity != 0 && pairedBefore && accrued) ++r.pairPokes;
            }
        }
    }

    /// @dev BC-118's named residue (FQ-12, F147), per compared total: each depth conversion's fee note keeps 2 x SLACK
    /// raw units of its LP fee from the depth budget, split as an ordinary fee instead (BoxSwapBounds.feeNote, BC-133),
    /// and v4 floors fees per position on every poke: less than 1 wei per position, per currency, at each collect
    /// (at most four after graduation, BoxHook._harvestAll: ask, bid, sentinel and the one shared pair, BC-067) and
    /// at each fee-bearing pair poke inside `deepen()`. Paired adds alone do not enlarge it (Codex check F1).
    function _residue118(Rule118 memory r) internal pure returns (uint256) {
        return r.conversions * 2 * BoxSwapBounds.SLACK + r.positions + r.pairPokes;
    }

    function _log118(Rule118 memory r, Tot memory xOn, Tot memory xOff) internal {
        emit log_named_uint("BC-118 conversions", r.conversions);
        emit log_named_uint("BC-118 pairs", r.pairs);
        emit log_named_uint("BC-118 positions harvested", r.positions);
        emit log_named_uint("BC-118 fee-bearing pair pokes", r.pairPokes);
        emit log_named_uint("BC-118 SLACK", BoxSwapBounds.SLACK);
        emit log_named_int("toFit on - off", int256(xOn.toFit) - int256(xOff.toFit));
        emit log_named_int("toPlatform on - off", int256(xOn.toPlatform) - int256(xOff.toPlatform));
        emit log_named_int("qToDepth on - off", int256(xOn.qToDepth) - int256(xOff.qToDepth));
        emit log_named_int("tToDepth on - off", int256(xOn.tToDepth) - int256(xOff.tToDepth));
        emit log_named_int("tBurned on - off", int256(xOn.tBurned) - int256(xOff.tBurned));
        emit log_named_int("qToCreator on - off", int256(xOn.qToCreator) - int256(xOff.qToCreator));
        emit log_named_int("tToCreator on - off", int256(xOn.tToCreator) - int256(xOff.tToCreator));
    }

    /// @dev Fixed inputs on both sides (exact-input buys in Q, exact-input sells in T): the fees are 1% of each input
    /// whatever the pool's liquidity, so both boxes' fee totals are the same.
    function _fixedTrades(Box memory b) internal {
        address trader = makeAddr("s45.fixedTrader");
        deal(address(b.t), trader, 1e25);
        _buy(b, trader, 0.7 ether, 0);
        _sell(b, trader, 3e24);
        _buy(b, trader, 0.4 ether, 0);
        _sell(b, trader, 2e24);
    }

    function _avgSet(Box memory b, int24 t) internal {
        (bool ok,) = b.average.call(abi.encodeWithSignature("set(bool,int24,int24)", true, t, t));
        assertTrue(ok);
    }

    // ------------------------------------------------------------------------------------------------------------
    // The per-item stream hook point (add-on 2; S8 builds the stream): T after graduation, capped, fail-safe

    function test_stream_tAfterGraduationCappedAndFailSafe() public {
        MockItemStream stream = new MockItemStream();
        Params memory p = _box0Params();
        p.tStream = BoxSpecV1.T_STREAM_PER_ITEM_STREAM;
        p.stream = address(stream);
        Box memory b = _buildAndLaunch(p);
        _skipWindow(b);
        (uint256 t,) = _buy(b, alice, 1 ether, 0);
        _sell(b, alice, t / 2);
        uint256 supply0 = b.t.totalSupply();
        b.receiver.collect(keeper);
        assertLt(b.t.totalSupply(), supply0, "before graduation: burned");
        assertEq(stream.notified(), 0);
        _closeAndGraduate(b);
        _tFees(b, 30e18);
        _fees(b, 0.01 ether);
        b.receiver.collect(keeper);
        // F77: the stream gets 13/15 of the T side; 2/15 goes into box 0's own pool.
        assertEq(stream.notified(), 26e18, "after graduation: 13/15 to the stream, notified");
        assertEq(b.t.balanceOf(address(stream)), 26e18);
        stream.setMode(true, false);
        _tFees(b, 15e18);
        _fees(b, 0.01 ether);
        vm.recordLogs();
        b.receiver.collect(keeper);
        assertEq(b.t.balanceOf(address(stream)), 39e18, "a reverting notice is skipped; the T arrived");
        _assertLog(address(b.receiver), keccak256("StreamNotifyFailed(address,uint256)"));
        stream.setMode(false, true);
        _tFees(b, 15e18);
        _fees(b, 0.01 ether);
        b.receiver.collect{gas: 3_000_000}(keeper);
        assertEq(b.t.balanceOf(address(stream)), 52e18, "a gas burner gets its cap only");
    }

    function _assertLog(address emitter, bytes32 topic) internal {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == emitter && logs[i].topics[0] == topic) return;
        }
        revert("log missing");
    }
}

/// @notice TEST ONLY: pays with Solidity's `transfer` (a 2,300-gas stipend), as some marketplaces do.
contract StipendSender {
    function send(address payable to, uint256 amount) external {
        to.transfer(amount);
    }

    receive() external payable {}
}
