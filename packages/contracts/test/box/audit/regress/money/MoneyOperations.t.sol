// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AuditRegressMoneyFixture, AuditRegressMoneyGasSink} from "./MoneyFixture.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {SqrtPriceMath} from "v4-core/src/libraries/SqrtPriceMath.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {IBoxVault} from "../../../../../src/box/interfaces/IBoxVault.sol";
import {IBoxToken} from "../../../../../src/box/interfaces/IBoxToken.sol";
import {IDrandSource} from "../../../../../src/box/interfaces/IDrandSource.sol";
import {DeepenSkip, DepthKind} from "../../../../../src/box/interfaces/BoxTypes.sol";
import {ClaimsFunder} from "../../../../utils/ClaimsFunder.sol";
import {OpenTime} from "../../../utils/OpenTime.sol";

contract AuditRegressMoneyOperationsTest is AuditRegressMoneyFixture {
    using StateLibrary for IPoolManager;

    function testFuzz_M17_ticketRoundTripUsesCurrentQuoteAndConserves(uint8 raw) public {
        uint256 count = 1 + uint256(raw) % 10;
        OpenTime.to(hook.windowEndsAt());
        kit.buy(alice, 1 ether, 0);
        uint256 supply = token.totalSupply();
        uint256 n = vault.inside();
        uint256 wallet = token.balanceOf(alice);
        uint256 principal = (supply * count + n - 1) / n;
        uint256 fee = (principal + 99) / 100;
        vm.startPrank(alice);
        token.approve(a.tickets, type(uint256).max);
        tickets.take(count, principal + fee, block.timestamp);
        vm.stopPrank();
        assertEq(vault.escrowPrincipal(), principal);
        assertEq(token.balanceOf(a.vault), principal);
        assertEq(token.totalSupply(), supply - fee);
        assertEq(token.balanceOf(alice), wallet - principal - fee);
        assertEq(token.balanceOf(a.tickets), 0);
        assertEq(vault.inside(), n - count);
        assertEq(vault.pendingTickets(), count);
        uint256 back = (token.totalSupply() - principal) * count / (n - count);
        uint256 backFee = (back * 5 + 99) / 100;
        uint256[] memory ids = new uint256[](count);
        for (uint256 i; i < count; ++i) {
            ids[i] = i + 1;
        }
        vm.prank(alice);
        (uint256 got, uint256 charged) = tickets.handBack(ids, back - backFee, block.timestamp);
        assertEq(got, back);
        assertEq(charged, backFee);
        assertLt(back, principal, "the burned fee lowers the current quote");
        assertEq(token.totalSupply(), supply - fee - backFee);
        assertEq(token.balanceOf(alice), wallet - principal - fee + back - backFee);
        assertEq(vault.escrowPrincipal(), principal - back);
        assertEq(token.balanceOf(a.vault), vault.escrowPrincipal());
        assertEq(vault.inside(), n);
        assertEq(vault.pendingTickets(), 0);
        assertEq(token.balanceOf(a.tickets), 0);
        assertGe(vault.escrowPrincipal() * vault.inside(), vault.outside() * vault.activeSupply());
        assertGe(token.totalSupply(), vault.supplyFloor());
        vm.expectRevert(IBoxVault.LastItem.selector);
        vault.quoteWithdraw(n);
    }

    function test_M18_drawBountyRefundAndTerminalCancellationConserve() public {
        _graduate();
        vm.fee(1 gwei);
        uint256 target = 600_000 * block.basefee;
        kit.buy(alice, 0.1 ether, 0);
        vm.deal(alice, 2 * target + 123);
        vm.startPrank(alice);
        token.approve(a.tickets, type(uint256).max);
        uint256 first = tickets.draw{value: target + 123}(type(uint256).max, block.timestamp);
        assertEq(alice.balance, target + 123, "excess refunded");
        uint256 second = tickets.draw{value: target}(type(uint256).max, block.timestamp);
        vm.stopPrank();
        assertEq(alice.balance, target + 123, "same round pays no second bounty");
        IDrandSource src = IDrandSource(a.randomness);
        (, uint64 round) = src.requestOf(a.tickets, first);
        (, uint64 round2) = src.requestOf(a.tickets, second);
        assertEq(round, round2);
        assertEq(src.bountyOf(round), target);
        assertEq(a.tickets.balance, 0);
        vm.warp(block.timestamp + 7 days + 1);
        tickets.enterTerminal();
        uint256 before = token.balanceOf(alice);
        uint256 supply = token.totalSupply();
        uint256 escrow = vault.escrowPrincipal();
        uint256 returned = tickets.cancelDraw(first);
        returned += tickets.cancelDraw(second);
        assertEq(token.balanceOf(alice) - before, returned);
        assertEq(escrow - vault.escrowPrincipal(), returned);
        assertEq(token.totalSupply(), supply, "no hand-back fee after graduation");
        assertEq(token.balanceOf(a.vault), vault.escrowPrincipal());
        assertEq(src.bountyOf(round), target, "unposted bounty remains for the poster, not the drawer");
    }

    function test_M19_depthConversionConservesClaimsAndReturnsOwnFees() public {
        _graduate();
        vm.deal(address(this), 1 ether);
        receiver.fundDepth{value: 1 ether}();
        vm.roll(block.number + 300);
        vm.warp(block.timestamp + 3600);
        (uint160 sqrtBefore, int24 tickBefore,,) = kit.pm().getSlot0(hook.poolId());
        (uint256 q0, uint256 t0) = hook.depthBudget();
        uint256 keeperBefore = bob.balance;
        (DepthKind kind, DeepenSkip skip, uint256 used, uint256 paired, uint256 tip) = hook.deepen(bob);
        assertEq(uint256(skip), uint256(DeepenSkip.None));
        assertEq(uint256(kind), uint256(DepthKind.Convert));
        assertGt(used, 0);
        assertEq(paired, 0);
        (uint256 q1, uint256 t1) = hook.depthBudget();
        assertEq(q0 - q1, used + tip);
        assertGt(t1, t0, "bought FIT is claims, never a sale");
        assertEq(bob.balance - keeperBefore, tip);
        assertLe(tip, 0.0005 ether);
        assertLe(used, q0 / 2, "at most half the unpaired ETH");
        (uint160 sqrtAfter,,,) = kit.pm().getSlot0(hook.poolId());
        assertLe(sqrtAfter, sqrtBefore);
        assertGe(sqrtAfter, TickMath.getSqrtPriceAtTick(tickBefore - 49));
        uint256 note = receiver.hookFeesPending();
        assertGt(note, 0);
        // A separate user trade funds a qualifying batch; its sell is deliberately absent.
        kit.buy(alice, 0.6 ether, 0);
        uint256 depthBefore = _claims(a.hook, address(0));
        receiver.collect(bob);
        assertEq(receiver.hookFeesPending(), 0);
        assertGe(_claims(a.hook, address(0)) - depthBefore, note);
        (, skip,,,) = hook.deepen(bob);
        assertEq(uint256(skip), uint256(DeepenSkip.Cooldown));
    }

    function test_M20_pairDepthConsumesOnlyPrincipalAndTipAtCooldownBoundary() public {
        _graduate();
        vm.deal(address(this), 1 ether);
        receiver.fundDepth{value: 1 ether}();
        (uint160 sqrtPrice,,,) = kit.pm().getSlot0(hook.poolId());
        uint256 tAmount = FullMath.mulDiv(FullMath.mulDiv(1 ether, sqrtPrice, 1 << 96), sqrtPrice, 1 << 96);
        ClaimsFunder funder = new ClaimsFunder(kit.pm());
        funder.deposit(a.token, kit.carol(), tAmount, a.hook);
        vm.warp(block.timestamp + 3600);
        vm.roll(hook.migratedAtBlock() + 299);
        (uint256 q0, uint256 t0) = hook.depthBudget();
        (, DeepenSkip skip,,,) = hook.deepen(bob);
        assertEq(uint256(skip), uint256(DeepenSkip.Cooldown));
        assertEq(_claims(a.hook, address(0)), q0);
        assertEq(_claims(a.hook, a.token), t0);
        vm.roll(block.number + 1);
        uint256 cap = _depthCap();
        (DepthKind kind,, uint256 q, uint256 t, uint256 tip) = hook.deepen(bob);
        assertEq(uint256(kind), uint256(DepthKind.Pair));
        assertGt(q, 0);
        assertGt(t, 0);
        assertLe(q, cap, "pair spends at most 10% of core ETH in the 953-tick band");
        assertEq(q0 - _claims(a.hook, address(0)), q + tip);
        assertEq(t0 - _claims(a.hook, a.token), t);
        (uint160 sqrtAfter,,,) = kit.pm().getSlot0(hook.poolId());
        assertEq(sqrtAfter, sqrtPrice, "adding depth cannot move price");
        (, skip,,,) = hook.deepen(bob);
        assertEq(uint256(skip), uint256(DeepenSkip.Cooldown));
    }

    function _depthCap() private view returns (uint256 qCap) {
        (, int24 average,) = executor.twap();
        int24 sample = executor.latestSampleTick();
        int24 ref = sample > average ? sample : average;
        int24[3] memory lo = [int24(-887220), kit.curve().tickLower, kit.curve().tickUpper];
        int24[3] memory hi = [kit.curve().tickLower, int24(887220), int24(887220)];
        for (uint256 i; i < 3; ++i) {
            (uint128 liquidity,,) = kit.pm().getPositionInfo(hook.poolId(), a.hook, lo[i], hi[i], bytes32(uint256(1)));
            int24 lower = lo[i] > ref ? lo[i] : ref;
            int24 upper = hi[i] < ref + 953 ? hi[i] : ref + 953;
            if (upper > lower) {
                qCap += SqrtPriceMath.getAmount0Delta(
                    TickMath.getSqrtPriceAtTick(lower), TickMath.getSqrtPriceAtTick(upper), liquidity, false
                );
            }
        }
        qCap /= 10;
    }

    function test_M23_executorSmallBatchWaitsAndOutsideBandDoesNotSpend() public {
        _graduate();
        vm.warp(block.timestamp + 3600);
        uint256 minimum = executor.batchThreshold();
        assertGt(minimum, 1);
        vm.deal(address(this), minimum - 1);
        executor.fundBudget{value: minimum - 1}();
        (uint256 chunks, uint256 spent,) = executor.execute(1);
        assertEq(chunks + spent, 0);
        assertEq(executor.budget(), minimum - 1);
        vm.deal(address(this), 1 ether);
        executor.fundBudget{value: 1 ether}();
        kit.buy(alice, 1 ether, 0); // moves FIT beyond the executor's average band
        uint256 budget = executor.budget();
        (chunks, spent,) = executor.execute(1);
        assertEq(chunks + spent, 0);
        assertEq(executor.budget(), budget);
        // Even without a swap, unsolicited FIT has a burn exit.
        vm.prank(alice);
        token.transfer(a.executor, 1 ether);
        uint256 supply = token.totalSupply();
        (,, uint256 burned) = executor.execute(0);
        assertEq(burned, 1 ether);
        assertEq(supply - token.totalSupply(), burned);
    }

    function test_M24_priceSampleMovesAtMost100TicksPerTimestamp() public {
        _graduate();
        kit.buy(alice, 1 ether, 0);
        int24 before = executor.latestSampleTick();
        vm.warp(block.timestamp + 12);
        int24 after_ = executor.poke();
        assertEq(before - after_, 100);
        assertEq(executor.poke(), after_, "same timestamp cannot walk sample twice");
    }

    function test_M21_failedGraduationPokesCanBeRetriedWithoutDoublePayment() public {
        vm.pauseGasMetering();
        kit.toClosed();
        vm.resumeGasMetering();
        bytes memory receiverCode = a.receiver.code;
        bytes memory streamCode = a.itemStream.code;
        AuditRegressMoneyGasSink sink = new AuditRegressMoneyGasSink();
        vm.etch(a.receiver, address(sink).code);
        vm.etch(a.itemStream, address(sink).code);
        coordinator.graduate{gas: 15_000_000}();
        vm.etch(a.receiver, receiverCode);
        vm.etch(a.itemStream, streamCode);
        assertTrue(coordinator.graduated());
        assertTrue(vault.gateOpen());
        assertFalse(receiver.graduationSettled());
        uint256 reward = coordinator.rewardOf(address(this));
        receiver.onGraduation();
        stream.onGraduation();
        assertTrue(receiver.graduationSettled());
        assertTrue(stream.started());
        assertEq(coordinator.rewardOf(address(this)), reward);
        assertEq(_claims(a.coordinator, address(0)), reward);
        (uint256 q, uint256 t) = receiver.booked();
        assertEq(q, _claims(a.receiver, address(0)));
        assertEq(t, _claims(a.receiver, a.token));
    }

    function test_M22_failedPlatformRecipientKeepsCreditAndClaims() public {
        _graduate();
        uint256 owed = receiver.platformOwed();
        uint256 claims = _claims(a.receiver, address(0));
        AuditRegressMoneyGasSink sink = new AuditRegressMoneyGasSink();
        vm.etch(a.platform, address(sink).code);
        (bool ok,) = a.receiver.call{gas: 1_000_000}(abi.encodeWithSignature("payPlatform()"));
        assertFalse(ok);
        assertEq(receiver.platformOwed(), owed);
        assertEq(_claims(a.receiver, address(0)), claims);
        assertEq(a.receiver.balance, 0);
    }

    function test_M30_failedFundBudgetKeepsFitCreditAndClaims() public {
        _graduate();
        uint256 owed = receiver.fitOwed();
        assertGt(owed, 0);
        uint256 claims = _claims(a.receiver, address(0));
        uint256 budget = a.executor.balance;
        bytes memory code = a.executor.code;
        AuditRegressMoneyGasSink sink = new AuditRegressMoneyGasSink();
        vm.etch(a.executor, address(sink).code);
        (bool ok,) = a.receiver.call{gas: 1_000_000}(abi.encodeWithSignature("payFit()"));
        vm.etch(a.executor, code);
        assertFalse(ok);
        assertEq(receiver.fitOwed(), owed);
        assertEq(_claims(a.receiver, address(0)), claims);
        assertEq(a.executor.balance, budget);
        assertEq(a.receiver.balance, 0);
        receiver.payFit();
        assertEq(receiver.fitOwed(), 0);
        assertEq(a.executor.balance, budget + owed);
        assertEq(_claims(a.receiver, address(0)), claims - owed);
    }

    function test_M31_delayedSettlementChargesHeldPlatformToEpochZero() public {
        vm.deal(address(this), 600 ether);
        receiver.fundFees{value: 300 ether}();
        vm.pauseGasMetering();
        kit.toClosed();
        vm.resumeGasMetering();
        bytes memory code = a.receiver.code;
        AuditRegressMoneyGasSink sink = new AuditRegressMoneyGasSink();
        vm.etch(a.receiver, address(sink).code);
        coordinator.graduate{gas: 15_000_000}();
        vm.etch(a.receiver, code);
        assertFalse(receiver.graduationSettled());
        vm.warp(block.timestamp + 60 days);
        receiver.onGraduation();
        assertEq(receiver.platformOwed(), 32 ether, "held fees consume only epoch zero's cap");
        receiver.fundFees{value: 300 ether}();
        assertEq(receiver.platformOwed(), 64 ether, "epoch two still has its own cap");
        (uint256 q,) = receiver.booked();
        assertEq(q, _claims(a.receiver, address(0)));
    }

    function test_M33_deepenRejects100TickDeviationWithoutSpending() public {
        _graduate();
        vm.deal(address(this), 1 ether);
        receiver.fundDepth{value: 1 ether}();
        vm.roll(block.number + 300);
        vm.warp(block.timestamp + 3600);
        (, int24 spot,,) = kit.pm().getSlot0(hook.poolId());
        vm.mockCall(a.executor, abi.encodeWithSignature("latestSampleTick()"), abi.encode(spot));
        vm.mockCall(a.executor, abi.encodeWithSignature("twap()"), abi.encode(true, spot + 100, uint256(3600)));
        (uint256 q, uint256 t) = hook.depthBudget();
        (, DeepenSkip skip,,,) = hook.deepen(bob);
        assertEq(uint256(skip), uint256(DeepenSkip.Deviation));
        assertEq(_claims(a.hook, address(0)), q);
        assertEq(_claims(a.hook, a.token), t);
        // Just inside the permitted band, conversion can proceed without an earlier skip starting cooldown.
        vm.mockCall(a.executor, abi.encodeWithSignature("twap()"), abi.encode(true, spot - 99, uint256(3600)));
        (, skip,,,) = hook.deepen(bob);
        assertEq(uint256(skip), uint256(DeepenSkip.None));
    }
}
