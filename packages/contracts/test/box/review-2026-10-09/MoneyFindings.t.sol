// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {MoneyFixture, MoneyGasSink} from "./MoneyFixture.sol";

/// F126 imports only M28; the other money findings are explicitly out of scope.
contract MoneyFindingsTest is MoneyFixture {
    bool private firstBatch;

    function test_BC065_M28_firstBatchSettlementFailureKeepsExactEarnings() public {
        firstBatch = true;
        _compareRetry(a.receiver, false, true);
    }

    function test_BC065_M28_firstBatchStreamFailureKeepsExactEarnings() public {
        firstBatch = true;
        _compareRetry(a.itemStream, true, false);
    }

    function _close() internal {
        if (!firstBatch) {
            kit.toClosed();
            return;
        }
        kit.toWindow();
        vm.warp(hook.windowEndsAt());
        uint256 bought = kit.buy(kit.alice(), 0.6 ether, 0);
        kit.sell(kit.alice(), bought / 3);
        vm.startPrank(kit.alice());
        token.approve(a.tickets, type(uint256).max);
        tickets.take(1, type(uint256).max, block.timestamp);
        vm.stopPrank();
        kit.buy(bob, 3 * coordinator.raise(), kit.curve().sqrtPriceLowerX96);
    }

    function test_BC065_M28_failedStreamStartKeepsGraduationAndEarnings() public {
        _compareRetry(a.itemStream, false, false);
    }

    function test_BC065_M28_exhaustedStreamBudgetKeepsGraduationAndEarnings() public {
        _compareRetry(a.itemStream, true, false);
    }

    function test_BC065_M28_failedSettlementKeepsGraduationAndEarnings() public {
        _compareRetry(a.receiver, false, false);
    }

    function test_BC065_M28_claimBeforeRetryKeepsExactEarnings() public {
        _compareRetry(a.itemStream, false, true);
    }

    function test_BC065_M28_settlementAndClaimBeforeRetryKeepExactEarnings() public {
        _compareRetry(a.receiver, false, true);
    }

    function _compareRetry(address target, bool exhaust, bool claimBeforeRetry) internal {
        vm.pauseGasMetering();
        _close();
        // Both an already burned gift and a still-held gift predate graduation and earn nothing for owners.
        vm.prank(kit.alice());
        token.transfer(a.itemStream, 1000);
        stream.burn();
        vm.prank(kit.alice());
        token.transfer(a.itemStream, 2000);
        uint256 closed = vm.snapshotState();
        vm.resumeGasMetering();
        vm.prank(alice);
        uint256 reward = coordinator.graduate();
        uint256 expected = _earnAndClaim();
        stream.burn(); // release the rounding reserve after the placeholder leaves
        uint256 expectedIndex = stream.index();
        (uint256 expectedClaimed, uint256 expectedBurned) = stream.totals();
        assertGt(expected, 0, "control pays the placeholder owner");
        vm.revertToState(closed);

        bytes memory code = target.code;
        if (exhaust) {
            MoneyGasSink sink = new MoneyGasSink();
            vm.etch(target, address(sink).code);
        } else {
            vm.mockCallRevert(target, abi.encodeWithSignature("onGraduation()"), "refused");
        }
        vm.prank(alice);
        (bool ok,) = a.coordinator.call{gas: 15_000_000}(abi.encodeWithSignature("graduate()"));
        vm.etch(target, code);
        vm.clearMockedCalls();
        assertTrue(ok, "graduation must survive a failed stream or settlement");
        assertTrue(coordinator.graduated() && vault.gateOpen());
        assertFalse(stream.started());
        assertEq(coordinator.rewardOf(alice), reward);
        uint256 at = coordinator.graduatedAt();
        uint256 atBlock = coordinator.graduatedAtBlock();
        vm.warp(block.timestamp + 1 days);
        vm.roll(block.number + 100);
        uint256 actual;
        if (claimBeforeRetry) actual = _earnAndClaim();
        else _earn();
        vm.prank(bob);
        stream.onGraduation();
        if (!claimBeforeRetry) actual = _claimPlaceholder();
        stream.burn();
        assertTrue(stream.started() && receiver.graduationSettled());
        assertEq(actual, expected, "retry pays precisely the on-time control");
        assertEq(stream.index(), expectedIndex);
        (uint256 claimed, uint256 burned) = stream.totals();
        assertEq(claimed, expectedClaimed);
        assertEq(burned, expectedBurned);
        assertEq(coordinator.graduatedAt(), at);
        assertEq(coordinator.graduatedAtBlock(), atBlock);
        assertEq(coordinator.rewardOf(bob), 0);
        vm.expectRevert(bytes4(keccak256("AlreadyStarted()")));
        stream.onGraduation();
        vm.expectRevert(bytes4(keccak256("AlreadyGraduated()")));
        coordinator.graduate();
        assertEq(stream.index(), expectedIndex);
    }

    function _earn() internal {
        uint256 bought = kit.buy(alice, 0.6 ether, 0);
        kit.sell(alice, bought / 2);
        receiver.collect(bob); // funds/settles before startup too; must not burn owners' earnings
        stream.burn();
    }

    function _earnAndClaim() internal returns (uint256) {
        _earn();
        return _claimPlaceholder();
    }

    function _claimPlaceholder() internal returns (uint256) {
        vm.warp(block.timestamp + 8 days);
        tickets.enterTerminal();
        uint256[] memory ids = new uint256[](1);
        ids[0] = 1; // the kit's first curve placeholder
        address holder = tickets.ownerOf(1);
        vm.prank(holder);
        tickets.handBack(ids, 0, block.timestamp);
        return stream.claimFor(holder, new uint256[](0));
    }

    /// M-28: a failed graduation start followed by trading cannot move the stream's financial start time.
    function test_M28_delayedStreamStartMustKeepPostGraduationEarnings() public {
        vm.pauseGasMetering();
        kit.toClosed();
        vm.resumeGasMetering();
        bytes memory code = a.itemStream.code;
        MoneyGasSink sink = new MoneyGasSink();
        vm.etch(a.itemStream, address(sink).code);
        (bool ok,) = a.coordinator.call{gas: 15_000_000}(abi.encodeWithSignature("graduate()"));
        vm.etch(a.itemStream, code);
        assertTrue(ok, "graduation succeeds even when the stream exhausts its budget");
        assertTrue(coordinator.graduated());
        assertFalse(stream.started());
        assertEq(stream.outsideCount(), 1, "one curve placeholder earns from graduation");
        uint256 atGraduation = stream.streamValue();
        uint256 bought = kit.buy(alice, 0.6 ether, 0);
        kit.sell(alice, bought / 2);
        uint256 accrued = (stream.streamValue() - atGraduation) / 4269;
        assertGt(accrued, 0);
        stream.onGraduation();
        assertEq(stream.index(), accrued, "M-28: delayed start erased post-graduation earnings");
    }
}
