// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {BoxCoordinator} from "../../../src/box/BoxCoordinator.sol";
import {BoxHook} from "../../../src/box/BoxHook.sol";
import {BoxReceiver} from "../../../src/box/BoxReceiver.sol";
import {HookGasFit, PriceLimitSwapper} from "../../research/hookgas/HookGasKit.sol";
import {BoxS6Base} from "./BoxS6Base.sol";
import {S6ClaimsMinter} from "./BoxS6Mocks.sol";

/// @notice TEST ONLY: drives two boxes (box 0 and a creator box) through random trades, collects, graduation attempts
/// by random callers, claims, gifts of Q claims and T to the coordinator, and time; it keeps the ghosts the
/// invariants compare against. Every action is total: a call the box refuses is caught, except `graduate()` after the
/// close, whose failure is recorded as a blocked graduation (BC-098).
contract BoxS6Handler is Test {
    using StateLibrary for IPoolManager;

    struct B {
        BoxCoordinator coord;
        BoxHook hook;
        BoxReceiver receiver;
        HookGasFit t;
        PoolKey key;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        uint160 sqrtP1;
        uint256 raise;
        uint256 graduations;
        uint256 credited;
        address rewardee;
        uint256 claimed;
        uint256 feesAtGraduation;
        uint256 giftsBefore;
        uint256 giftsAfter;
        uint256 tAfter;
        bool blocked;
    }

    IPoolManager internal immutable pm;
    PriceLimitSwapper internal immutable swapper;
    S6ClaimsMinter internal immutable minter;
    B[2] internal boxes;
    address[5] internal actors;
    uint256 public calls;

    constructor(IPoolManager pm_, PriceLimitSwapper swapper_, S6ClaimsMinter minter_) {
        (pm, swapper, minter) = (pm_, swapper_, minter_);
        actors = [makeAddr("h.alice"), makeAddr("h.bob"), makeAddr("h.carol"), makeAddr("h.keeper"), makeAddr("h.eve")];
    }

    function add(uint256 i, BoxS6Base.Box memory b) external {
        B storage x = boxes[i];
        (x.coord, x.hook, x.receiver, x.t, x.key) = (b.coord, b.hook, BoxReceiver(payable(b.receiver)), b.t, b.key);
        (x.tickLower, x.tickUpper, x.liquidity, x.sqrtP1, x.raise) =
        (b.curve.tickLower, b.curve.tickUpper, b.curve.liquidity, b.curve.sqrtPriceLowerX96, b.raise);
    }

    function box(uint256 i) external view returns (B memory) {
        return boxes[i];
    }

    // ------------------------------------------------------------------------------------------------------------
    // Actions

    function buy(uint256 which, uint256 actor, uint256 amount, bool toP1) external {
        ++calls;
        B storage x = boxes[which % 2];
        if (x.hook.closed() && !x.coord.graduated()) return;
        address a = actors[actor % 5];
        amount = bound(amount, 0.001 ether, 3 ether);
        vm.deal(a, a.balance + amount);
        vm.prank(a);
        // forge-lint: disable-next-line(unsafe-typecast)
        try swapper.swap{value: amount}(x.key, true, -int256(amount), toP1 || !x.coord.graduated() ? x.sqrtP1 : 0) {}
            catch {}
    }

    function sell(uint256 which, uint256 actor, uint256 pct) external {
        ++calls;
        B storage x = boxes[which % 2];
        if (x.hook.closed() && !x.coord.graduated()) return;
        address a = actors[actor % 5];
        uint256 amount = x.t.balanceOf(a) * bound(pct, 1, 100) / 100;
        if (amount == 0) return;
        vm.startPrank(a);
        x.t.approve(address(swapper), type(uint256).max);
        // forge-lint: disable-next-line(unsafe-typecast)
        try swapper.swap(x.key, false, -int256(amount), 0) {} catch {}
        vm.stopPrank();
    }

    function collect(uint256 which, uint256 actor) external {
        ++calls;
        B storage x = boxes[which % 2];
        vm.prank(actors[actor % 5]);
        try x.receiver.collect(actors[actor % 5]) {} catch {}
    }

    function graduate(uint256 which, uint256 actor) external {
        ++calls;
        B storage x = boxes[which % 2];
        address a = actors[actor % 5];
        bool due = x.hook.closed() && !x.coord.graduated();
        uint256 fees = _curveFees(x);
        vm.prank(a);
        try x.coord.graduate() returns (uint256 reward) {
            ++x.graduations;
            x.credited = reward;
            x.rewardee = a;
            x.feesAtGraduation = fees;
        } catch {
            if (due) x.blocked = true;
        }
    }

    function claim(uint256 which, uint256 actor, uint256 to) external {
        ++calls;
        B storage x = boxes[which % 2];
        vm.prank(actors[actor % 5]);
        try x.coord.claimReward(actors[to % 5]) returns (uint256 amount) {
            x.claimed += amount;
        } catch {}
    }

    function giftClaims(uint256 which, uint256 amount) external {
        ++calls;
        B storage x = boxes[which % 2];
        amount = bound(amount, 1, 0.05 ether);
        vm.deal(address(this), amount);
        minter.mintTo{value: amount}(address(x.coord));
        if (x.coord.graduated()) x.giftsAfter += amount;
        else x.giftsBefore += amount;
    }

    function giftT(uint256 which, uint256 actor, uint256 pct) external {
        ++calls;
        B storage x = boxes[which % 2];
        address a = actors[actor % 5];
        uint256 amount = x.t.balanceOf(a) * bound(pct, 1, 20) / 100;
        if (amount == 0) return;
        vm.prank(a);
        x.t.transfer(address(x.coord), amount);
        if (x.coord.graduated()) x.tAfter += amount;
    }

    function wait(uint256 blocks) external {
        ++calls;
        blocks = bound(blocks, 1, 400);
        vm.roll(block.number + blocks);
        vm.warp(block.timestamp + 12 * blocks);
    }

    function _curveFees(B storage x) internal view returns (uint256) {
        (uint256 inside0,) = pm.getFeeGrowthInside(x.key.toId(), x.tickLower, x.tickUpper);
        return FullMath.mulDiv(inside0, x.liquidity, 1 << 128);
    }

    function curveFees(uint256 i) external view returns (uint256) {
        return _curveFees(boxes[i]);
    }

    receive() external payable {}
}

/// @notice Invariants of the coordinator over random lives of box 0 and a creator box (S6; BC-026, BC-027, BC-098).
contract BoxS6InvariantsTest is BoxS6Base {
    BoxS6Handler internal handler;

    function setUp() public {
        _setUpWorld();
        handler = new BoxS6Handler(pm, swapper, minter);
        Box memory b0 = _buildAndLaunch(_box0Params());
        Box memory b1 = _buildAndLaunch(_creatorParams(carol));
        _skipWindow(b0);
        _skipWindow(b1);
        handler.add(0, b0);
        handler.add(1, b1);
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](8);
        selectors[0] = BoxS6Handler.buy.selector;
        selectors[1] = BoxS6Handler.sell.selector;
        selectors[2] = BoxS6Handler.collect.selector;
        selectors[3] = BoxS6Handler.graduate.selector;
        selectors[4] = BoxS6Handler.claim.selector;
        selectors[5] = BoxS6Handler.giftClaims.selector;
        selectors[6] = BoxS6Handler.giftT.selector;
        selectors[7] = BoxS6Handler.wait.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// @dev Graduates at most once, only after the close, and the coordinator and the hook agree on it.
    function invariant_graduatesOnceAfterTheClose() public view {
        for (uint256 i; i < 2; ++i) {
            BoxS6Handler.B memory x = handler.box(i);
            assertLe(x.graduations, 1, "at most once");
            assertEq(x.coord.graduated(), x.hook.migratedAtBlock() != 0, "coordinator and hook agree");
            assertEq(x.coord.graduated(), x.graduations == 1, "only through graduate()");
            if (x.coord.graduated()) assertTrue(x.hook.closed(), "only after the close");
        }
    }

    /// @dev BC-098: once the curve closed, no graduate() attempt by anyone ever failed.
    function invariant_neverBlockedAfterTheClose() public view {
        for (uint256 i; i < 2; ++i) {
            assertFalse(handler.box(i).blocked, "graduate() reverted after the close");
        }
    }

    /// @dev BC-027: the credited reward is min(the curve's Q fees at graduation, 0.1% of R), and what was claimed plus
    /// what waits is exactly it.
    function invariant_rewardIsMinFeesCapAndPaidOnce() public view {
        for (uint256 i; i < 2; ++i) {
            BoxS6Handler.B memory x = handler.box(i);
            uint256 cap = x.coord.rewardCap();
            assertLe(x.credited, cap, "never above the cap");
            if (x.graduations == 1) {
                uint256 fees = x.feesAtGraduation;
                assertEq(x.credited, fees < cap ? fees : cap, "min(curve fees, cap)");
                assertEq(x.claimed + x.coord.rewardOf(x.rewardee), x.credited, "claimed + waiting == credited");
            }
        }
    }

    /// @dev Before graduation the coordinator holds the pool share and the reserve (plus outside gifts); after it,
    /// only the unclaimed reward (plus what was sent after graduation); never ETH.
    function invariant_coordinatorHoldsOnlyItsShare() public view {
        for (uint256 i; i < 2; ++i) {
            BoxS6Handler.B memory x = handler.box(i);
            uint256 qClaims = pm.balanceOf(address(x.coord), 0);
            assertEq(address(x.coord).balance, 0, "no ETH");
            if (!x.coord.graduated()) {
                assertEq(qClaims, x.hook.reserveMinted() + x.giftsBefore, "reserve + gifts");
                assertLe(x.hook.reserveMinted(), x.coord.rewardCap(), "reserve <= cap");
                assertLe(x.hook.reserveMinted(), handler.curveFees(i), "the reserve comes from the curve's fees");
                assertEq(x.coord.poolShare(), x.t.balanceOf(address(x.coord)));
            } else {
                assertEq(qClaims, x.coord.rewardOf(x.rewardee) + x.giftsAfter, "the unclaimed reward only");
                assertEq(x.t.balanceOf(address(x.coord)), x.tAfter, "no T but what arrived later");
                assertEq(x.coord.poolShare(), 0);
                assertEq(x.coord.reserve(), 0);
            }
        }
    }

    function invariant_callSummary() public view {
        assertGe(handler.calls(), 0);
    }

    /// @dev The handler reaches the states the invariants are about: both boxes close, graduate through the handler,
    /// pay a claim, and take gifts after graduation (a fixed sequence of its own actions).
    function test_handlerReachesGraduationAndClaims() public {
        for (uint256 i; i < 2; ++i) {
            handler.giftClaims(i, 0.01 ether);
            handler.giftT(i, 0, 10);
            handler.buy(i, 0, 3 ether, true);
            handler.buy(i, 1, 3 ether, true);
            assertTrue(handler.box(i).hook.closed(), "closed");
            handler.collect(i, 2);
            handler.graduate(i, 3);
            BoxS6Handler.B memory x = handler.box(i);
            assertEq(x.graduations, 1, "graduated through the handler");
            assertFalse(x.blocked);
            handler.claim(i, 3, 4);
            handler.giftClaims(i, 0.02 ether);
            handler.buy(i, 2, 1 ether, false);
            x = handler.box(i);
            assertEq(x.claimed, x.credited, "claimed");
            assertEq(x.giftsAfter, 0.02 ether);
        }
        invariant_graduatesOnceAfterTheClose();
        invariant_rewardIsMinFeesCapAndPaidOnce();
        invariant_coordinatorHoldsOnlyItsShare();
    }
}
