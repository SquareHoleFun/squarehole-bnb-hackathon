// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AuditRegressMoneyFixture, AuditRegressMoneyGasSink} from "./MoneyFixture.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {BoxSpecV1} from "../../../../../src/box/BoxSpecV1.sol";
import {BoxRoyaltyRouter} from "../../../../../src/box/BoxRoyaltyRouter.sol";
import {IBoxCoordinator} from "../../../../../src/box/interfaces/IBoxCoordinator.sol";
import {IBoxLaunchRouter} from "../../../../../src/box/interfaces/IBoxLaunchRouter.sol";
import {FeeBatch, DepthKind, DeepenSkip} from "../../../../../src/box/interfaces/BoxTypes.sol";
import {OpenTime} from "../../../utils/OpenTime.sol";

contract AuditRegressMoneyFlowsTest is AuditRegressMoneyFixture {
    using StateLibrary for IPoolManager;

    struct BatchBefore {
        uint256 x;
        uint256 qc;
        uint256 tc;
        uint256 fit;
        uint256 plat;
        uint256 dq;
        uint256 dt;
        uint256 supply;
        uint256 held;
        uint256 tipBalance;
    }

    function test_M03_bootstrapAndInitialSupplyConserve() public view {
        assertEq(token.totalSupply() + token.totalBurned(), 1e27);
        assertGt(token.totalBurned(), 0, "bootstrap bought and burned");
        assertEq(token.balanceOf(a.poolManager) + token.balanceOf(a.coordinator), token.totalSupply());
        assertEq(a.poolManager.balance, BoxSpecV1.BOOTSTRAP_ETH);
        assertEq(a.coordinator.balance + a.launchRouter.balance + address(kit.factory()).balance, 0);
        assertEq(token.balanceOf(a.vault), vault.escrowPrincipal());
        assertEq(vault.escrowPrincipal(), 0);
        assertEq(vault.inside(), 4269);
    }

    function testFuzz_M04_windowTaxAndPartialRefundConserve(uint96 raw, uint8 stepRaw) public {
        uint256 gross = bound(uint256(raw), 1e12, 100 ether);
        uint256 step = uint256(stepRaw) % 32;
        OpenTime.toStep(hook.openAt(), step);
        vm.deal(alice, gross);
        uint256 pmBefore = a.poolManager.balance;
        vm.prank(alice);
        uint256 out = router.buy{value: gross}(gross, 1, alice, block.timestamp);
        uint256 spent = a.poolManager.balance - pmBefore;
        uint256 tax = a.launchRouter.balance;
        uint256 pips = router.taxPips(step);
        uint256 fullTax = (gross * pips + 999_999) / 1_000_000;
        uint256 expected = spent == gross - fullTax ? fullTax : (spent * pips + 999_999 - pips) / (1_000_000 - pips);
        assertEq(tax, expected);
        assertEq(gross, spent + tax + alice.balance, "spent + tax + refund");
        assertEq(token.balanceOf(alice), out);
        assertGt(out, 0);
        if (alice.balance != 0) assertTrue(hook.closed(), "only a closing fill is partial");
        vm.expectRevert(IBoxLaunchRouter.NotGraduated.selector);
        router.sweep();
        assertEq(a.launchRouter.balance, tax, "premature sweep is atomic");
    }

    function testFuzz_M05_feeIntakeCarriesRatherThanLosesRemainders(uint96 x, uint96 y) public {
        uint256 first = bound(uint256(x), 0, 400 ether);
        uint256 second = bound(uint256(y), 0, 400 ether);
        vm.deal(address(this), first + second);
        receiver.fundFees{value: first}();
        receiver.fundFees{value: second}();
        uint256 total = first + second;
        (uint256 qDepth, uint256 tDepth) = receiver.depthHeld();
        (uint256 carry, uint256 tCarry) = receiver.carried();
        assertEq(receiver.fitOwed(), 11 * (total / 15));
        assertEq(receiver.platformHeld(), 2 * (total / 15));
        assertEq(qDepth, 2 * (total / 15));
        assertEq(carry, total % 15);
        assertLt(carry, 15);
        assertEq(tDepth + tCarry, 0);
        (uint256 bookedQ, uint256 bookedT) = receiver.booked();
        assertEq(bookedQ, total);
        assertEq(bookedT, 0);
        assertEq(_claims(a.receiver, address(0)), total);
        assertEq(a.receiver.balance, 0);
    }

    function test_M06_capExcessAndEpochBoundaryConserve() public {
        _graduate();
        vm.deal(address(this), 900 ether);
        uint256 fitBefore = receiver.fitOwed();
        uint256 platBefore = receiver.platformOwed();
        uint256 depthBefore = _claims(a.hook, address(0));
        (uint256 carryBefore,) = receiver.carried();
        receiver.fundFees{value: 300 ether}();
        (uint256 carryAfter,) = receiver.carried();
        assertEq(receiver.platformOwed(), 32 ether);
        assertEq(
            receiver.fitOwed() - fitBefore + receiver.platformOwed() - platBefore + _claims(a.hook, address(0))
                - depthBefore + carryAfter,
            300 ether + carryBefore
        );
        uint256 end = coordinator.graduatedAt() + 30 days;
        vm.warp(end - 1);
        receiver.fundFees{value: 300 ether}();
        assertEq(receiver.platformOwed(), 32 ether, "cap does not reset early");
        vm.warp(end);
        receiver.fundFees{value: 300 ether}();
        assertEq(receiver.platformOwed(), 64 ether);
        (uint256 epoch, uint256 kept, uint256 remaining) = receiver.platformEpoch();
        assertEq(epoch, 1);
        assertEq(kept, 32 ether);
        assertEq(remaining, 0);
        uint256 safeBefore = a.platform.balance;
        assertEq(receiver.payPlatform(), 64 ether);
        assertEq(a.platform.balance - safeBefore, 64 ether);
        assertEq(receiver.platformOwed(), 0);
    }

    function test_M07_tradeBatchConservesBothAssetsAndStreamValue() public {
        _graduate();
        uint256 bought = kit.buy(alice, 1 ether, 0);
        kit.sell(alice, bought / 2);
        BatchBefore memory s;
        s.x = stream.streamValue();
        (s.qc, s.tc) = receiver.carried();
        s.fit = receiver.fitOwed();
        s.plat = receiver.platformOwed();
        (s.dq, s.dt) = hook.depthBudget();
        s.supply = token.totalSupply();
        s.held = token.balanceOf(a.itemStream);
        s.tipBalance = bob.balance;
        FeeBatch memory batch = receiver.collect(bob);
        (uint256 nq, uint256 nt) = receiver.carried();
        (uint256 aq, uint256 at) = hook.depthBudget();
        assertEq(batch.qToReserve, 0, "reserve only on the curve");
        assertEq(bob.balance - s.tipBalance, batch.tip);
        assertLe(batch.tip, 0.0005 ether);
        assertEq(receiver.fitOwed() - s.fit, 11 * ((batch.q - batch.tip + s.qc) / 15));
        assertEq(receiver.platformOwed() - s.plat, 2 * ((batch.q - batch.tip + s.qc) / 15));
        assertEq(
            batch.q + s.qc, receiver.fitOwed() - s.fit + receiver.platformOwed() - s.plat + aq - s.dq + batch.tip + nq
        );
        assertEq(at - s.dt, 2 * ((batch.t + s.tc) / 15));
        assertEq(
            batch.t + s.tc, at - s.dt + token.balanceOf(a.itemStream) + s.supply - token.totalSupply() + nt - s.held
        );
        assertEq(stream.streamValue(), s.x, "collection only changes custody, never X");
        assertEq(token.balanceOf(a.receiver), 0);
        (uint256 bookedQ, uint256 bookedT) = receiver.booked();
        assertEq(_claims(a.receiver, address(0)), bookedQ);
        assertEq(_claims(a.receiver, a.token), bookedT);
    }

    function test_M08_forcedEthAndTaxBecomeDepthNotPlatformFees() public {
        _graduate();
        uint256 tax = a.launchRouter.balance;
        vm.deal(a.launchRouter, tax + 19);
        vm.deal(a.receiver, 23);
        uint256 fit = receiver.fitOwed();
        uint256 plat = receiver.platformOwed();
        uint256 depth = _claims(a.hook, address(0));
        assertEq(router.sweep(), tax + 19);
        receiver.fundDepth();
        assertEq(_claims(a.hook, address(0)) - depth, tax + 42);
        assertEq(receiver.fitOwed(), fit);
        assertEq(receiver.platformOwed(), plat);
        assertEq(a.launchRouter.balance + a.receiver.balance, 0);
    }

    function test_M09_rewardIsCappedOnceAndFailedPaymentRollsBack() public {
        _graduate();
        uint256 reward = coordinator.rewardOf(address(this));
        assertEq(reward, coordinator.raise() / 1000);
        assertEq(reward, hook.reserveMinted());
        assertEq(_claims(a.coordinator, address(0)), reward);
        AuditRegressMoneyGasSink sink = new AuditRegressMoneyGasSink();
        vm.expectRevert(IBoxCoordinator.ClaimFailed.selector);
        coordinator.claimReward{gas: 1_000_000}(address(sink));
        assertEq(coordinator.rewardOf(address(this)), reward);
        assertEq(_claims(a.coordinator, address(0)), reward);
        uint256 before = bob.balance;
        coordinator.claimReward(bob);
        assertEq(bob.balance - before, reward);
        assertEq(coordinator.rewardOf(address(this)), 0);
        vm.expectRevert(IBoxCoordinator.NothingToClaim.selector);
        coordinator.claimReward(bob);
        vm.expectRevert(IBoxCoordinator.AlreadyGraduated.selector);
        coordinator.graduate();
        assertEq(token.balanceOf(a.coordinator), 0, "all leftover pool-share dust burned");
    }

    function test_M10_executorBudgetBurnAndBlockAndPriceBounds() public {
        _graduate();
        vm.deal(address(this), 0.3 ether);
        executor.fundBudget{value: 0.1 ether}();
        (bool ok,) = a.executor.call{value: 0.1 ether}("");
        assertTrue(ok);
        vm.deal(a.executor, a.executor.balance + 0.1 ether); // forced ETH also belongs to budget
        assertEq(executor.totalToBudget(), 0.2 ether);
        assertEq(executor.budget(), 0.3 ether);
        vm.warp(block.timestamp + 3600);
        vm.roll(block.number + 300);
        (uint160 sqrtBefore, int24 tickBefore,,) = kit.pm().getSlot0(hook.poolId());
        uint256 supply = token.totalSupply();
        (uint256 chunks, uint256 spent, uint256 burned) = executor.execute(99);
        assertEq(chunks, 1);
        assertGt(spent, 0);
        assertGt(burned, 0);
        assertEq(executor.budget() + spent, 0.3 ether);
        assertEq(executor.totalEthSpent(), spent);
        assertEq(executor.totalBurned(), burned);
        assertEq(supply - token.totalSupply(), burned);
        assertEq(token.balanceOf(a.executor), 0);
        (uint160 sqrtAfter, int24 tickAfter,,) = kit.pm().getSlot0(hook.poolId());
        assertLe(sqrtAfter, sqrtBefore);
        assertGe(sqrtAfter, TickMath.getSqrtPriceAtTick(tickBefore - 49));
        (, int24 average,) = executor.twap();
        assertGe(tickAfter, average - 99);
        (chunks, spent, burned) = executor.execute(99);
        assertEq(chunks + spent + burned, 0, "a second caller cannot get a second step this block");
        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 12);
        (chunks,,) = executor.execute(1);
        assertEq(chunks, 1, "allowance resets with the block");
    }

    function test_M11_royaltyEthAndWethUseCappedFeeSplit() public {
        _graduate();
        vm.deal(address(this), 3 ether);
        (bool ok,) = a.royaltyRouter.call{value: 1 ether, gas: 2300}("");
        assertTrue(ok, "receiving clone accepts a stipend");
        kit.weth().deposit{value: 2 ether}();
        kit.weth().transfer(a.royaltyRouter, 2 ether);
        uint256 fit = receiver.fitOwed();
        uint256 plat = receiver.platformOwed();
        uint256 depth = _claims(a.hook, address(0));
        (uint256 carry,) = receiver.carried();
        assertEq(BoxRoyaltyRouter(payable(a.royaltyRouter)).flush(), 3 ether);
        assertEq(a.royaltyRouter.balance, 0);
        assertEq(kit.weth().balanceOf(a.royaltyRouter), 0);
        (uint256 afterCarry,) = receiver.carried();
        assertEq(
            receiver.fitOwed() - fit + receiver.platformOwed() - plat + _claims(a.hook, address(0)) - depth
                + afterCarry,
            3 ether + carry
        );
    }

    function test_M32_curveSaleBurnAndBothFeeSplitsConserve() public {
        OpenTime.to(hook.windowEndsAt());
        uint256 bought = kit.buy(alice, 0.6 ether, 0);
        kit.sell(alice, bought / 2);
        uint256 supply = token.totalSupply();
        FeeBatch memory batch = receiver.collect(bob);
        (uint256 qDepth, uint256 tDepth) = receiver.depthHeld();
        (uint256 qCarry, uint256 tCarry) = receiver.carried();
        assertEq(supply - token.totalSupply(), 13 * (batch.t / 15));
        assertEq(tDepth, 2 * (batch.t / 15));
        assertEq(tCarry, batch.t % 15);
        assertEq(batch.t, supply - token.totalSupply() + tDepth + tCarry);
        assertEq(receiver.fitOwed(), 11 * ((batch.q - batch.qToReserve - batch.tip) / 15));
        assertEq(receiver.platformHeld(), 2 * ((batch.q - batch.qToReserve - batch.tip) / 15));
        assertEq(batch.q, batch.qToReserve + batch.tip + receiver.fitOwed() + receiver.platformHeld() + qDepth + qCarry);
        assertEq(token.balanceOf(a.itemStream), 0);
        assertEq(token.balanceOf(a.receiver), 0);
        assertEq(_claims(a.coordinator, address(0)), hook.reserveMinted());
        assertLe(hook.reserveMinted(), coordinator.raise() / 1000);
    }
}
