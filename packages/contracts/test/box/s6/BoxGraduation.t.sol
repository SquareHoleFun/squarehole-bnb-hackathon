// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {SqrtPriceMath} from "v4-core/src/libraries/SqrtPriceMath.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {BoxCoordinator} from "../../../src/box/BoxCoordinator.sol";
import {BoxLaunchRouter} from "../../../src/box/BoxLaunchRouter.sol";
import {BoxLayoutV1} from "../../../src/box/BoxLayoutV1.sol";
import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";
import {FitBuybackExecutor} from "../../../src/box/FitBuybackExecutor.sol";
import {IBoxCoordinator} from "../../../src/box/interfaces/IBoxCoordinator.sol";
import {IBoxHook} from "../../../src/box/interfaces/IBoxHook.sol";
import {BoxKind, BoxPhase, FeeBatch} from "../../../src/box/interfaces/BoxTypes.sol";
import {PriceLimitSwapper} from "../../research/hookgas/HookGasKit.sol";
import {BoxS6Base} from "./BoxS6Base.sol";
import {HostileModule, MockBoxTickets} from "./BoxS6Mocks.sol";
import {OpenTime} from "../utils/OpenTime.sol";

/// @notice TEST ONLY: closes the curve and graduates in one transaction (BC-026), optionally buying right after
/// (BC-028's searcher); or, as the payer of a launch-router buy, graduates inside the router's refund.
contract CloseAndGraduate {
    PriceLimitSwapper internal immutable swapper;
    IBoxCoordinator internal coordinator;
    bool internal graduateOnRefund;
    uint256 public rewardSeen;
    uint160 public priceBeforeFollowUp;

    constructor(PriceLimitSwapper swapper_) {
        swapper = swapper_;
    }

    /// @param closeLimit 0: the extreme price (an exact-input overshoot); else the limit (√P1: an exact close)
    function run(IBoxCoordinator c, PoolKey calldata key, uint256 ethIn, uint160 closeLimit, uint256 followUpEth)
        external
        payable
        returns (uint256 reward)
    {
        // forge-lint: disable-next-line(unsafe-typecast)
        swapper.swap{value: ethIn}(key, true, -int256(ethIn), closeLimit);
        reward = c.graduate();
        if (followUpEth != 0) {
            (priceBeforeFollowUp,,,) = _slot0(c, key);
            // forge-lint: disable-next-line(unsafe-typecast)
            swapper.swap{value: followUpEth}(key, true, -int256(followUpEth), 0);
        }
    }

    function buyThroughRouter(IBoxCoordinator c, BoxLaunchRouter router, uint256 qIn) external payable {
        (coordinator, graduateOnRefund) = (c, true);
        router.buy{value: qIn}(qIn, 0, address(this), block.timestamp);
        graduateOnRefund = false;
    }

    function claim(IBoxCoordinator c, address to) external returns (uint256) {
        return c.claimReward(to);
    }

    receive() external payable {
        if (graduateOnRefund) {
            graduateOnRefund = false;
            rewardSeen = coordinator.graduate();
        }
    }

    function _slot0(IBoxCoordinator c, PoolKey calldata key) internal view returns (uint160, int24, uint24, uint24) {
        IPoolManager pm_ = IPoolManager(c.poolManager());
        bytes32 slot = keccak256(abi.encodePacked(keccak256(abi.encode(key)), bytes32(uint256(6))));
        uint256 w = uint256(pm_.extsload(slot));
        return (uint160(w), 0, 0, 0);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}

/// @notice BC-026 (graduation follows at once), BC-027 (the reward from the curve's fees, with the real hook and
/// receiver), BC-028 (front-running changes only who closes and who is paid) and BC-043's coordinator part, on boxes
/// built through the coordinator's `deploy` and `launch`.
contract BoxGraduationTest is BoxS6Base {
    bytes32 internal constant MIGRATED_TOPIC =
        keccak256("Migrated(bytes32,uint256,uint256,uint128,uint128,uint128,uint256,uint256)");

    function setUp() public {
        _setUpWorld();
    }

    // ------------------------------------------------------------------------------------------------------------
    // BC-026: graduation follows at once

    function test_BC026_inTheClosingBlock_N4269_box0() public {
        _closingBlockCase(_box0Params());
    }

    function test_BC026_inTheClosingBlock_N69_standard() public {
        Params memory p = _standardParams();
        p.n = 69;
        _closingBlockCase(p);
    }

    function test_BC026_inTheClosingBlock_N10000_standardWithTickets() public {
        Params memory p = _creatorParams(carol);
        p.n = 10_000;
        p.tickets = true;
        p.royalty = true;
        _closingBlockCase(p);
    }

    function _closingBlockCase(Params memory p) internal {
        Box memory b = _buildAndLaunch(p);
        assertEq(b.vault.n(), p.n);
        _skipWindow(b);
        _fillTo(b, 500_000);
        uint256 executorTime = _executorTime(b);
        _close(b, carol);
        uint256 closedAt = block.number;
        assertEq(uint256(b.coord.phase()), uint256(BoxPhase.Closed));
        vm.prank(keeper);
        uint256 reward = b.coord.graduate();
        assertEq(block.number, closedAt, "no block wait");
        assertEq(b.coord.graduatedAtBlock(), closedAt);
        assertEq(b.hook.migratedAtBlock(), closedAt);
        assertEq(b.coord.graduatedAt(), block.timestamp);
        assertEq(uint256(b.coord.phase()), uint256(BoxPhase.Graduated));
        assertEq(reward, b.hook.reserveCap());
        // In the same call: the gate opened, the receiver settled, the word requested, the executor poked.
        assertEq(b.vault.gateOpenedAt(), block.timestamp, "the vault gate opened in graduate()");
        assertTrue(_recv(b).graduationSettled(), "the receiver's settlement ran in graduate()");
        if (b.tickets != address(0)) {
            assertEq(MockBoxTickets(b.tickets).requester(), address(b.coord), "graduation word requested");
        }
        if (b.kind == BoxKind.Box0) {
            assertEq(_executorTime(b), block.timestamp, "FIT's executor sampled P1 in graduate()");
            assertGt(block.timestamp, executorTime);
        } else {
            assertEq(HostileModule(payable(b.executor)).pokes(), 1, "the executor poked");
        }
        // Once only, for anyone.
        vm.prank(searcher);
        vm.expectRevert(IBoxCoordinator.AlreadyGraduated.selector);
        b.coord.graduate();
        _roll(10);
        vm.expectRevert(IBoxCoordinator.AlreadyGraduated.selector);
        b.coord.graduate();
        // Trading resumes from exactly P1.
        assertEq(_sqrtP(b), b.curve.sqrtPriceLowerX96);
        (uint256 got,) = _buy(b, alice, 0.1 ether, 0);
        assertGt(got, 0);
    }

    function _executorTime(Box memory b) internal view returns (uint256) {
        if (b.kind != BoxKind.Box0) return 0;
        return FitBuybackExecutor(payable(b.executor)).oracle().time;
    }

    function test_BC026_inTheClosingTransaction_exactAndOvershoot() public {
        for (uint256 overshoot; overshoot < 2; ++overshoot) {
            Box memory b = _buildAndLaunch(_box0Params());
            _skipWindow(b);
            _fillTo(b, 980_000);
            CloseAndGraduate cg = new CloseAndGraduate(swapper);
            vm.deal(address(cg), 10 ether);
            uint256 reward = cg.run(
                IBoxCoordinator(address(b.coord)), b.key, 1 ether, overshoot == 1 ? 0 : b.curve.sqrtPriceLowerX96, 0
            );
            assertTrue(b.coord.graduated(), "closed and graduated in one transaction");
            assertEq(reward, b.hook.reserveCap());
            assertEq(b.coord.rewardOf(address(cg)), reward);
            assertEq(_sqrtP(b), b.curve.sqrtPriceLowerX96, "back at exactly P1 after an overshoot too");
        }
    }

    /// @dev The window's closing buy through the launch router: the payer graduates inside the router's refund (still
    /// the closing transaction, with the router's own lock held).
    function test_BC026_insideTheLaunchRoutersRefund() public {
        Box memory b = _buildAndLaunch(_box0Params());
        OpenTime.toStep(b.hook.openAt(), 31);
        uint256 qIn = 30 ether;
        CloseAndGraduate cg = new CloseAndGraduate(swapper);
        vm.deal(address(cg), qIn);
        cg.buyThroughRouter(IBoxCoordinator(address(b.coord)), b.router, qIn);
        assertTrue(b.hook.closed());
        assertTrue(b.coord.graduated(), "graduated inside the refund");
        assertEq(cg.rewardSeen(), b.hook.reserveCap());
        assertEq(b.coord.graduatedAtBlock(), b.hook.closedAtBlock());
    }

    function test_BC026_muchLater() public {
        Box memory b = _buildAndLaunch(_box0Params());
        _skipWindow(b);
        _close(b, carol);
        _roll(100_000);
        vm.prank(keeper);
        b.coord.graduate();
        assertEq(b.coord.graduatedAtBlock(), block.number);
        assertGt(b.coord.graduatedAtBlock(), b.hook.closedAtBlock());
    }

    function test_BC026_beforeTheCloseAlwaysReverts() public {
        Box memory b = _build(_box0Params());
        vm.expectRevert(IBoxCoordinator.NotLaunched.selector);
        b.coord.graduate();
        _launch(b);
        vm.expectRevert(IBoxCoordinator.NotClosed.selector);
        b.coord.graduate(); // upcoming
        OpenTime.toStep(b.hook.openAt(), 0);
        vm.expectRevert(IBoxCoordinator.NotClosed.selector);
        b.coord.graduate(); // window
        _skipWindow(b);
        uint256[4] memory fills = [uint256(1), 210_000, 700_000, 999_999];
        for (uint256 i; i < fills.length; ++i) {
            _fillTo(b, fills[i]);
            assertFalse(b.hook.closed());
            vm.expectRevert(IBoxCoordinator.NotClosed.selector);
            b.coord.graduate();
        }
        // Sells after a near-full curve keep it open.
        _sell(b, alice, b.t.balanceOf(alice) / 2);
        vm.expectRevert(IBoxCoordinator.NotClosed.selector);
        b.coord.graduate();
        assertEq(uint256(b.coord.phase()), uint256(BoxPhase.Bonding));
    }

    // ------------------------------------------------------------------------------------------------------------
    // BC-027: the graduation caller is paid from the curve's fees (real hook and receiver)

    function test_BC027_collectNever() public {
        Box memory b = _buildAndLaunch(_box0Params());
        _skipWindow(b);
        _close(b, carol);
        _rewardCase(b);
    }

    function test_BC027_collectJustBefore() public {
        Box memory b = _buildAndLaunch(_box0Params());
        _skipWindow(b);
        (uint256 t,) = _buy(b, alice, 1 ether, 0);
        _sell(b, alice, t / 2);
        _close(b, carol);
        // A collect front-running graduate() in the same block takes its batch, not the reward.
        FeeBatch memory fb = _recv(b).collect(searcher);
        assertEq(fb.qToReserve, b.hook.reserveCap(), "the batch topped the reserve up first");
        assertGt(fb.tip, 0, "the collector got its tip");
        _rewardCase(b);
    }

    function test_BC027_manyBatches() public {
        Box memory b = _buildAndLaunch(_creatorParams(bob));
        _skipWindow(b);
        for (uint256 i; i < 12; ++i) {
            (uint256 t,) = _buy(b, alice, 0.3 ether, 0);
            _sell(b, alice, t / 2);
            if (i % 2 == 1) _recv(b).collect(keeper);
            _roll(3);
        }
        assertFalse(b.hook.closed());
        _close(b, carol);
        _recv(b).collect(keeper);
        _rewardCase(b);
    }

    /// @dev The reward is min(the curve's Q fees, 0.1% of R), from the reserve, once, as a claim; nothing from the raise.
    function _rewardCase(Box memory b) internal {
        uint256 curveFees = _curveQFeesAccrued(b);
        uint256 cap = b.hook.reserveCap();
        assertEq(cap, b.raise * 10 / 10_000, "0.1% of R");
        assertEq(b.coord.rewardCap(), cap, "the coordinator's own cap equals the hook's");
        assertGe(curveFees, b.raise / 100, "closing takes at least 1% of R in fees");
        vm.recordLogs();
        vm.prank(keeper);
        uint256 reward = b.coord.graduate();
        assertEq(reward, curveFees < cap ? curveFees : cap, "min(curve fees, cap)");
        assertEq(b.hook.reserveMinted(), reward, "the reserve the hook minted here, all of it");
        assertEq(b.coord.rewardOf(keeper), reward, "credited as a claim");
        assertEq(_claims(address(b.coord), address(0)), reward, "held as Q claims until pulled");
        assertEq(b.coord.reserve(), 0);
        // Nothing from the raise: the graduated positions hold exactly R (plus the Q dust minted as fees).
        (uint256 qFromCurve, uint128 bid, uint128 sentinel, uint256 qDust) = _migrated(b);
        assertEq(qFromCurve, b.raise, "the curve held exactly R");
        uint160 maxS = TickMath.getSqrtPriceAtTick(BoxSpecV1.MAX_USABLE_TICK);
        uint256 poolQ = SqrtPriceMath.getAmount0Delta(b.curve.sqrtPriceLowerX96, maxS, bid, true)
            + SqrtPriceMath.getAmount0Delta(b.curve.sqrtPriceUpperX96, maxS, sentinel, true);
        assertEq(poolQ + qDust, b.raise, "the pool holds all of R");
        assertEq(b.t.balanceOf(address(b.coord)), 0, "the pool share left only into the pool (and dust burned)");
        // The pull.
        uint256 before = alice.balance;
        vm.prank(keeper);
        b.coord.claimReward(alice);
        assertEq(alice.balance - before, reward, "paid in Q");
        assertEq(_claims(address(b.coord), address(0)), 0, "the coordinator holds nothing");
        vm.prank(keeper);
        vm.expectRevert(IBoxCoordinator.NothingToClaim.selector);
        b.coord.claimReward(alice);
    }

    function _migrated(Box memory b) internal view returns (uint256 q, uint128 bid, uint128 sentinel, uint256 dust) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(b.hook) && logs[i].topics[0] == MIGRATED_TOPIC) {
                (q,,, bid, sentinel,, dust) =
                    abi.decode(logs[i].data, (uint256, uint256, uint128, uint128, uint128, uint256, uint256));
                return (q, bid, sentinel, dust);
            }
        }
        revert("no Migrated");
    }

    // ------------------------------------------------------------------------------------------------------------
    // BC-028: graduation front-running

    struct Outcome {
        uint128 ask;
        uint128 bid;
        uint128 sentinel;
        uint256 supply;
        uint256 coordT;
        uint160 sqrtP;
        uint256 reward;
        address rewardee;
        uint256 poolT;
    }

    /// @dev Alice's closing buy and the keeper's graduate() are pending; a searcher front-runs the close (an
    /// exact-input overshoot, not an exact close), copies graduate() and buys right after, in one transaction. The
    /// layout, the burns and the price are identical; only the closer and the rewarded caller differ; the searcher's
    /// buy starts at exactly P1.
    function test_BC028_frontRunningChangesOnlyWhoClosesAndWhoIsPaid() public {
        Box memory b = _buildAndLaunch(_box0Params());
        _skipWindow(b);
        _fillTo(b, 700_000);
        uint256 snap = vm.snapshotState();
        // The honest order.
        _close(b, alice);
        vm.prank(keeper);
        b.coord.graduate();
        Outcome memory honest = _outcome(b, keeper);
        vm.revertToState(snap);
        // The front-run.
        CloseAndGraduate s = new CloseAndGraduate(swapper);
        vm.deal(address(s), 20 ether);
        s.run(IBoxCoordinator(address(b.coord)), b.key, 2 * b.raise, 0, 0.5 ether);
        assertEq(s.priceBeforeFollowUp(), b.curve.sqrtPriceLowerX96, "the first buy after graduation starts at P1");
        Outcome memory front = _outcome(b, address(s));
        assertEq(front.ask, honest.ask, "ask");
        assertEq(front.bid, honest.bid, "full-range bid");
        assertEq(front.sentinel, honest.sentinel, "bid sentinel");
        assertEq(front.coordT, honest.coordT, "nothing left with the coordinator");
        assertEq(front.reward, honest.reward, "the same reward");
        assertEq(honest.rewardee, keeper);
        assertEq(front.rewardee, address(s), "only who is paid changed");
        // The burns: the supply right after graduation (before the follow-up buy) is the same; the follow-up buy
        // burns nothing.
        assertEq(front.supply, honest.supply, "the same burns");
        // The pending buy and graduate() of the honest pair now land on a graduated pool: graduate() reverts, the
        // buy trades at the graduated price.
        vm.prank(keeper);
        vm.expectRevert(IBoxCoordinator.AlreadyGraduated.selector);
        b.coord.graduate();
        (uint256 got,) = _buy(b, alice, 1 ether, 0);
        assertGt(got, 0);
    }

    function _outcome(Box memory b, address rewardee) internal view returns (Outcome memory o) {
        (o.ask, o.bid, o.sentinel) = b.hook.graduatedLayout();
        o.supply = b.t.totalSupply();
        o.coordT = b.t.balanceOf(address(b.coord));
        o.sqrtP = _sqrtP(b);
        o.reward = b.coord.rewardOf(rewardee);
        o.rewardee = rewardee;
        o.poolT = b.t.balanceOf(address(pm));
    }

    /// @dev The same with an exact close by the searcher and exact output: every close path gives the same layout.
    function test_BC028_everyClosePathGivesTheSameLayout() public {
        Box memory b = _buildAndLaunch(_standardParams());
        _skipWindow(b);
        _fillTo(b, 210_000);
        uint256 snap = vm.snapshotState();
        Outcome[3] memory o;
        for (uint256 path; path < 3; ++path) {
            vm.revertToState(snap);
            vm.deal(bob, 20 ether);
            vm.prank(bob);
            if (path == 0) {
                swapper.swap{value: 2 * b.raise}(b.key, true, -int256(2 * b.raise), b.curve.sqrtPriceLowerX96);
            } else if (path == 1) {
                swapper.swap{value: 2 * b.raise}(b.key, true, -int256(2 * b.raise), 0);
            } else {
                uint256 tLeft =
                    SqrtPriceMath.getAmount1Delta(b.curve.sqrtPriceLowerX96, _sqrtP(b), b.curve.liquidity, false);
                swapper.swap{value: 2 * b.raise}(b.key, true, int256(tLeft + 1e18), b.curve.sqrtPriceLowerX96);
            }
            vm.prank(path == 0 ? keeper : searcher);
            b.coord.graduate();
            o[path] = _outcome(b, path == 0 ? keeper : searcher);
        }
        for (uint256 path = 1; path < 3; ++path) {
            assertEq(o[path].ask, o[0].ask);
            assertEq(o[path].bid, o[0].bid);
            assertEq(o[path].sentinel, o[0].sentinel);
            assertEq(o[path].supply, o[0].supply);
            assertEq(o[path].sqrtP, o[0].sqrtP);
            assertEq(o[path].reward, o[0].reward);
            assertEq(o[path].poolT, o[0].poolT);
        }
    }

    // ------------------------------------------------------------------------------------------------------------
    // BC-043 (the coordinator's part): T sent to the coordinator joins the ask, never breaking graduation

    function test_BC043_tSentToTheCoordinatorJoinsTheAsk() public {
        Box memory b = _buildAndLaunch(_box0Params());
        _skipWindow(b);
        (uint256 t,) = _buy(b, alice, 1 ether, 0);
        uint256 snap = vm.snapshotState();
        _close(b, carol);
        b.coord.graduate();
        (uint128 askPlain,,) = b.hook.graduatedLayout();
        uint256 supplyPlain = b.t.totalSupply();
        vm.revertToState(snap);
        uint256 shareBefore = b.coord.poolShare();
        vm.prank(alice);
        b.t.transfer(address(b.coord), t);
        assertEq(b.coord.poolShare(), shareBefore + t, "joins the pool share");
        _close(b, carol);
        vm.recordLogs();
        b.coord.graduate();
        (uint128 askGift,,) = b.hook.graduatedLayout();
        assertGt(askGift, askPlain, "a thicker ask");
        assertEq(b.t.balanceOf(address(b.coord)), 0, "all of it into the pool or burned");
        assertApproxEqAbs(b.t.totalSupply(), supplyPlain, 1e6, "the gift is not burned: only rounding dust differs");
    }

    // ------------------------------------------------------------------------------------------------------------
    // Life with the real coordinator: box 0 and a creator box (launch to payouts)

    function test_lifecycle_box0() public {
        Box memory b = _buildAndLaunch(_box0Params());
        assertEq(b.t.totalSupply(), BoxSpecV1.ISSUANCE - _bootstrapBurned(b), "the bootstrap T burned at launch");
        assertEq(b.t.balanceOf(address(b.coord)), b.curve.poolShare, "the coordinator keeps the pool share");
        assertEq(b.coord.poolShare(), b.curve.poolShare);
        assertEq(uint256(b.coord.phase()), uint256(BoxPhase.Upcoming));
        _roll(1);
        assertEq(uint256(b.coord.phase()), uint256(BoxPhase.Window));
        _skipWindow(b);
        assertEq(uint256(b.coord.phase()), uint256(BoxPhase.Bonding));
        (uint256 tOut,) = _buy(b, alice, 1 ether, 0);
        _sell(b, alice, tOut / 2);
        _recv(b).collect(keeper);
        assertEq(b.coord.reserve(), b.hook.reserveCap());
        _close(b, bob);
        vm.prank(keeper);
        b.coord.graduate();
        _buy(b, alice, 1 ether, 0);
        _recv(b).collect(keeper);
        _recv(b).payFit();
        _recv(b).payPlatform();
        assertGt(safe.balance, 0, "the Safe paid (capped)");
        uint256 tips = keeper.balance;
        vm.prank(keeper);
        b.coord.claimReward(keeper);
        assertEq(keeper.balance - tips, b.hook.reserveCap(), "the reward, on top of the collects' tips");
    }

    function _bootstrapBurned(Box memory b) internal view returns (uint256) {
        return BoxSpecV1.ISSUANCE - b.t.totalSupply();
    }

    function test_lifecycle_creatorBoxWithCreatorBuy() public {
        Params memory p = _creatorParams(carol);
        p.creatorBuy = 0.5 ether;
        p.creator = carol;
        Box memory b = _buildAndLaunch(p);
        assertGt(b.t.balanceOf(carol), 0, "the creator buy's T to the creator");
        assertEq(b.router.creatorBought(), true);
        assertEq(b.coord.creatorBuyAmount(), 0.5 ether);
        _skipWindow(b);
        (uint256 tOut,) = _buy(b, alice, 1 ether, 0);
        _sell(b, alice, tOut / 2);
        _recv(b).collect(keeper);
        _close(b, bob);
        vm.prank(searcher);
        b.coord.graduate();
        (uint256 oq,) = _recv(b).creatorOwed();
        assertGt(oq, 0, "held creator fees released at graduation");
        vm.prank(carol);
        _recv(b).claimCreator(carol);
        assertEq(b.coord.rewardOf(searcher), b.hook.reserveCap());
    }
}
