// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {AuditU5LaneBase} from "./AuditU5LaneBase.sol";
import {FitBuybackExecutor, IBurnableToken} from "../../../../src/box/FitBuybackExecutor.sol";
import {BoxCoordinator} from "../../../../src/box/BoxCoordinator.sol";
import {BoxHook} from "../../../../src/box/BoxHook.sol";
import {BoxToken} from "../../../../src/box/BoxToken.sol";
import {BoxVault} from "../../../../src/box/BoxVault.sol";
import {TransientReentrancyGuard} from "../../../../src/libraries/TransientReentrancyGuard.sol";

/// @dev TEST ONLY: unsolicited ETH bypasses receive() by SELFDESTRUCT in its creation transaction.
contract AuditU5LaneForceEther {
    constructor(address payable to) payable {
        selfdestruct(to);
    }
}

/// @dev TEST ONLY adversarial PoolManager callee. Re-enters guarded entries while unlock is active;
/// returns an empty Run so the test isolates callback authentication, not swap correctness.
contract AuditU5LaneReenterManager {
    bytes32 public slot;
    uint256 public locked;

    constructor(int24 tick) {
        slot = bytes32(
            uint256(TickMath.getSqrtPriceAtTick(tick)) | (uint256(uint24(tick)) << 160) | (uint256(3000) << 208)
        );
    }

    function extsload(bytes32) external view returns (bytes32) {
        return slot;
    }

    function unlock(bytes calldata) external returns (bytes memory) {
        bytes[4] memory calls = [
            abi.encodeWithSignature("execute(uint256)", 1),
            abi.encodeWithSignature("poke()"),
            abi.encodeWithSignature("fundBudget()"),
            bytes("")
        ];
        for (uint256 i; i < calls.length; ++i) {
            (bool ok, bytes memory reason) = msg.sender.call(calls[i]);
            require(
                !ok
                    && keccak256(reason)
                        == keccak256(abi.encodeWithSelector(TransientReentrancyGuard.Reentrancy.selector)),
                "lock"
            );
            ++locked;
        }
        return FitBuybackExecutor(payable(msg.sender)).unlockCallback(abi.encode(uint256(0), uint160(0), uint256(0)));
    }
}

/// forge-config: default.evm_version = "osaka"
contract AuditU5LaneExecutor is AuditU5LaneBase {
    using StateLibrary for IPoolManager;

    // Not a register row (triage 2a row 7); accepted as built (FQ-23, F147): the floor cannot bind on box 0.
    /// @notice U5.2/U5.11; FitBuybackExecutor.sol:239-265,513-524; BC-041/BC-108.
    /// Expected: a refused supply-floor burn skips without reverting or spending, then retries successfully.
    /// Observed: execute reverts atomically; budget and pool state are unchanged. Clearing the refusal permits a buy.
    /// Steps/amounts: graduate factory box 0; fund 1 ETH; mock only the vault floor to current supply;
    /// execute one chunk; restore the real floor and execute again. This is a callee-refusal fault injection.
    function testAccepted_AUDIT_U5_51_floorRefusalRevertsAtomicallyThenRetries() public {
        _graduateReady();
        _fund(1 ether);
        vm.mockCall(a.vault, abi.encodeCall(BoxVault.supplyFloor, ()), abi.encode(BoxToken(a.token).totalSupply()));
        uint256 budget = _executor().budget();
        uint256 supply = BoxToken(a.token).totalSupply();
        (uint160 price,,,) = IPoolManager(a.poolManager).getSlot0(BoxHook(a.hook).poolId());
        (bool ok, bytes memory reason) = a.executor.call(abi.encodeCall(FitBuybackExecutor.execute, (1)));
        assertFalse(ok, "current code propagates the burn refusal");
        assertEq(bytes4(reason), bytes4(keccak256("BurnBelowSupplyFloor(uint256,uint256)")));
        assertEq(_executor().budget(), budget);
        assertEq(BoxToken(a.token).totalSupply(), supply);
        (uint160 afterPrice,,,) = IPoolManager(a.poolManager).getSlot0(BoxHook(a.hook).poolId());
        assertEq(afterPrice, price);
        vm.clearMockedCalls();
        (uint256 chunks, uint256 spent, uint256 burned) = _executor().execute(1);
        assertEq(chunks, 1);
        assertGt(spent, 0);
        assertGt(burned, 0);
    }

    function testProperty_AUDIT_U5_factoryPinAndWiring() public {
        FitBuybackExecutor e = _executor();
        assertEq(keccak256(type(FitBuybackExecutor).creationCode), b.factory().executorInitCodeHash());
        assertEq(e.launchPhase(), a.coordinator);
        assertEq(address(e.token()), a.token);
        assertEq(address(e.poolManager()), a.poolManager);
        assertEq(e.hooks(), a.hook);
        assertEq(e.receiver(), a.receiver);
        assertEq(e.poolId(), keccak256(abi.encode(e.poolKey())));
        assertEq(keccak256(abi.encode(e.poolKey())), keccak256(abi.encode(b.poolKey())));
        assertEq(e.latestSampleTick(), b.curve().tickLower, "seed P1");
        FitBuybackExecutor twin = new FitBuybackExecutor(
            IPoolManager(a.poolManager), IBurnableToken(a.token), a.coordinator, a.hook, a.receiver, b.curve().tickLower
        );
        assertEq(a.executor.codehash, address(twin).codehash, "runtime including every immutable");
    }

    function testProperty_AUDIT_U5_forcedBudgetThresholdChunkAndBurn() public {
        _graduateReady();
        FitBuybackExecutor e = _executor();
        uint256 threshold = e.batchThreshold();
        uint256 initial = e.budget();
        // The receiver may already have funded budget at graduation. Remove no funds: compare two snapshots
        // with a threshold-sized gift, and pin the total actual balance passed to the real swap.
        _fund(threshold + 1);
        uint256 credited = e.totalToBudget();
        vm.deal(address(this), 1 ether);
        new AuditU5LaneForceEther{value: 1 ether}(payable(a.executor));
        assertEq(e.totalToBudget(), credited, "forced ETH bypasses funding events/counter");
        assertEq(e.budget(), initial + threshold + 1 + 1 ether);
        uint256 before = e.budget();
        uint256 poolBalance = a.poolManager.balance;
        uint256 supply = BoxToken(a.token).totalSupply();
        uint256 callerBalance = bob.balance;
        vm.prank(bob);
        (uint256 chunks, uint256 spent, uint256 burned) = e.execute(type(uint256).max);
        assertEq(chunks, 1);
        assertGt(spent, 0);
        assertEq(e.budget(), before - spent);
        assertEq(a.poolManager.balance, poolBalance + spent, "ETH only to PoolManager swap settlement");
        assertEq(BoxToken(a.token).totalSupply(), supply - burned);
        assertEq(BoxToken(a.token).balanceOf(a.executor), 0);
        assertEq(bob.balance, callerBalance);
        (chunks, spent, burned) = e.execute(10);
        assertEq(chunks | spent | burned, 0, "one chunk per block");
    }

    function testProperty_AUDIT_U5_forcedWeiCrossesTheSameBatchThreshold() public {
        _graduateReady();
        FitBuybackExecutor e = _executor();
        uint256 threshold = e.batchThreshold();
        assertLt(e.budget(), threshold);
        _fund(threshold - e.budget() - 1);
        (uint256 chunks, uint256 used,) = e.execute(1);
        assertEq(chunks | used, 0);
        assertEq(e.budget(), threshold - 1);
        uint256 credited = e.totalToBudget();
        vm.deal(address(this), 1);
        new AuditU5LaneForceEther{value: 1}(payable(a.executor));
        assertEq(e.totalToBudget(), credited);
        assertEq(e.budget(), threshold);
        (chunks, used,) = e.execute(1);
        assertEq(chunks, 1);
        assertGt(used, 0);
        assertEq(e.budget(), threshold - used);
    }

    function testFuzz_AUDIT_U5_callersHaveIdenticalProgress(uint160 who) public {
        vm.assume(who > 0x10000);
        _graduateReady();
        uint256 snap = vm.snapshotState();
        _fund(1 ether);
        (uint256 c, uint256 e, uint256 t) = _executor().execute(9);
        uint256 remaining = _executor().budget();
        vm.revertToState(snap);
        // Same starting state and actual budget, with the entire additional ETH bypassing the funding counter.
        vm.deal(address(this), 1 ether);
        new AuditU5LaneForceEther{value: 1 ether}(payable(a.executor));
        vm.prank(address(who));
        _executor().poke();
        vm.prank(address(who));
        (uint256 c2, uint256 e2, uint256 t2) = _executor().execute(9);
        assertEq(abi.encode(c, e, t), abi.encode(c2, e2, t2), "caller and funding route cannot change a chunk");
        assertEq(_executor().budget(), remaining);
    }

    function testProperty_AUDIT_U5_seedAndKnownCurveSampling() public {
        FitBuybackExecutor e = _executor();
        int24 seed = e.latestSampleTick();
        b.toBonding();
        vm.warp(block.timestamp + 1);
        e.poke();
        assertEq(e.latestSampleTick(), seed + 100, "documented curve-poke caveat of Misfits-line item 4");
        _fund(1 ether);
        (uint256 chunks, uint256 spent,) = e.execute(10);
        assertEq(chunks | spent, 0, "nothing bought before graduation");
        vm.warp(block.timestamp + 3600);
        e.poke();
        (bool ready,,) = e.twap();
        assertTrue(ready, "average readiness is time-based, not graduation-based");
    }

    function testFuzz_AUDIT_U5_sampleClampAndTimestamp(uint8 blocksHeld) public {
        _graduateReady();
        FitBuybackExecutor e = _executor();
        int24 seed = e.latestSampleTick();
        b.buy(dave, 10 ether, 0);
        uint256 count = bound(blocksHeld, 1, 100);
        for (uint256 i; i < count; ++i) {
            vm.warp(block.timestamp + 12);
            vm.roll(block.number + 1);
            FitBuybackExecutor.Oracle memory before = e.oracle();
            e.poke();
            FitBuybackExecutor.Oracle memory after_ = e.oracle();
            int256 diff = int256(after_.tick) - before.tick;
            assertLe(uint256(diff < 0 ? -diff : diff), 100);
            e.poke();
            assertEq(abi.encode(e.oracle()), abi.encode(after_), "one sample per timestamp");
        }
        (bool ready, int24 avg, uint32 window) = e.twap();
        assertTrue(ready);
        // b samples, 12 seconds apart: sum 100*k*12, k=0..b-1, divided by window >=3600.
        uint256 deviation = uint256(int256(seed) > avg ? int256(seed) - avg : int256(avg) - seed);
        uint256 bound_ = (600 * count * (count - 1) + window - 1) / window + 1;
        assertLe(deviation, bound_);
        assertGe(window, 3600);
    }

    function testProperty_AUDIT_U5_callbackAndReentrantEntries() public {
        _graduateReady();
        vm.expectRevert(FitBuybackExecutor.NotPoolManager.selector);
        _executor().unlockCallback("");
        vm.prank(a.poolManager);
        vm.expectRevert(FitBuybackExecutor.NotPoolManager.selector);
        _executor().unlockCallback("");
        AuditU5LaneReenterManager hostile = new AuditU5LaneReenterManager(b.curve().tickLower);
        FitBuybackExecutor e = new FitBuybackExecutor(
            IPoolManager(address(hostile)),
            IBurnableToken(a.token),
            a.coordinator,
            a.hook,
            a.receiver,
            b.curve().tickLower
        );
        vm.warp(block.timestamp + 3601);
        vm.deal(address(this), 1 ether);
        e.fundBudget{value: 1 ether}();
        e.execute(1);
        assertEq(hostile.locked(), 4);
    }

    function testProperty_AUDIT_U5_graduationLatch() public {
        _graduateReady();
        _executor().execute(0);
        assertTrue(_executor().graduationSeen());
        vm.mockCall(a.coordinator, abi.encodeCall(BoxCoordinator.graduated, ()), abi.encode(false));
        assertTrue(_executor().fitGraduated());
        _fund(1 ether);
        (uint256 chunks,,) = _executor().execute(1);
        assertEq(chunks, 1);
    }

    /// @notice U5.9; BoxSpecV1.sol:101-102 and FitBuybackExecutor.sol:506-511.
    /// Expected from the ticket's symmetric wording: no buy outside +/-99 ticks of the average.
    /// Observed: the bound is one-sided. A sale moves FIT to a cheaper price above average+99;
    /// execute buys one <=49-tick chunk there. This is a specification distinction, not loss of the price ceiling.
    /// Steps/amounts: graduate; fund 1 ETH; sell half the fixture buyer's FIT; execute one chunk.
    /// Logs record the exact sale, ticks and swap amounts for the evidence.
    function test_AUDIT_U5_52_averageBandIsOneSided() public {
        _graduateReady();
        _fund(1 ether);
        uint256 sold = BoxToken(a.token).balanceOf(b.alice()) / 2;
        b.sell(b.alice(), sold);
        (, int24 average,) = _executor().twap();
        (, int24 beforeTick,,) = IPoolManager(a.poolManager).getSlot0(BoxHook(a.hook).poolId());
        assertGt(beforeTick, average + 99);
        (uint256 chunks, uint256 spent, uint256 burned) = _executor().execute(1);
        assertEq(chunks, 1);
        (, int24 afterTick,,) = IPoolManager(a.poolManager).getSlot0(BoxHook(a.hook).poolId());
        assertGt(afterTick, average + 99);
        emit log_named_uint("proof52 sold FIT", sold);
        emit log_named_int("proof52 average", average);
        emit log_named_int("proof52 before tick", beforeTick);
        emit log_named_int("proof52 after tick", afterTick);
        emit log_named_uint("proof52 spent ETH", spent);
        emit log_named_uint("proof52 burned FIT", burned);
    }

    function testProperty_AUDIT_U5_thresholdAtBothPriceEndsSupply1e27() public {
        BoxToken t = new BoxToken("Audit", "AUD", address(this), address(0x12345));
        int24[2] memory ticks = [TickMath.MIN_TICK, TickMath.MAX_TICK];
        for (uint256 i; i < 2; ++i) {
            FitBuybackExecutor e = new FitBuybackExecutor(
                IPoolManager(a.poolManager), IBurnableToken(address(t)), a.coordinator, a.hook, a.receiver, ticks[i]
            );
            vm.warp(block.timestamp + 3600);
            uint256 sqrt = TickMath.getSqrtPriceAtTick(ticks[i]);
            uint256 cap = FullMath.mulDiv(FullMath.mulDiv(1e27, 1 << 96, sqrt), 1 << 96, sqrt);
            assertEq(e.batchThreshold(), cap * 5 / 10000);
            assertLe(cap, type(uint256).max / 5);
        }
    }
}
