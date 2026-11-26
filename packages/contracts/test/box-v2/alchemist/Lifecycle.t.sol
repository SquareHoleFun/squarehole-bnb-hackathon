// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {AlchemistFixture} from "./Fixture.sol";
import {BoxSpec} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {IFeeModulesV21} from "../../../src/box-v2/interfaces/IFeeModulesV21.sol";
import {IPileVaultV2} from "../../../src/box-v2/interfaces/IPileVaultV2.sol";
import {AlchemistView} from "./Admission.t.sol";
import {AlchemistV3Pool, AlchemistTrader} from "./Pools.sol";
import {BoxSwapBoundsV2} from "../../../src/box-v2/libraries/BoxSwapBoundsV2.sol";
import {PoolDriver} from "../kit/BoxV2TestBase.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {Vm} from "forge-std/Vm.sol";

contract AlchemistLifecycleTest is AlchemistFixture {
    uint256 internal firstPendingAt;
    uint256 internal initialDepth;
    function _alchemist(bool graduate_) internal {
        _alchemist(graduate_, 1 ether);
    }
    function _alchemist(bool graduate_, uint256 inputCap) internal { _alchemist(graduate_, inputCap, false); }
    function _alchemist(bool graduate_, uint256 inputCap, bool both) internal {
        BoxSpec memory s = _alchemistSpec(inputCap, true, both);
        _start(s); fees = IFeeModulesV21(address(receiver));
        firstPendingAt = block.timestamp;
        _buy(s.raise / 10); receiver.collect(address(0));
        assertGt(fees.modulePendingP(false),0);
        vm.expectRevert(); fees.executeModule(false);
        if (graduate_) { _fill(); box.graduate(); receiver.collect(address(0)); }
        initialDepth = hook.depthBudget();
    }
    function test_G1_A1_oneCallCannotSpendAboveCreationCap() public {
        _alchemist(true, 1e15);
        uint256 pending = fees.modulePendingP(false);
        uint256 backing = pm.balanceOf(address(receiver), uint160(address(p)));
        assertGt(pending, 1e15);
        assertEq(fees.executeModule(false), 1e15, "only the admitted clip leaves the receiver");
        assertEq(fees.modulePendingP(false), pending - 1e15);
        assertEq(pm.balanceOf(address(receiver), uint160(address(p))), backing - 1e15);
        _noResidue(); _booked();
    }
    function test_AF1_separateDeployerAndKeeperConvertWithoutFallbackWait() public {
        _alchemist(true);
        assertEq(vm.getNonce(MODULE_DEPLOYER), 1, "separate deployer creates the action");
        assertEq(AlchemistView(module).conversionTrigger(), keeper);
        assertLt(block.timestamp, firstPendingAt + 7 days, "fallback has not opened");
        uint256 pending = fees.modulePendingP(false);
        vm.prank(MODULE_DEPLOYER);
        vm.expectRevert(bytes4(keccak256("ConversionTriggerOnly()")));
        fees.executeModule(false);
        assertEq(fees.modulePendingP(false), pending);
        assertEq(gold.balanceOf(box.vault()), 0);
        assertEq(fees.executeModule(false), pending, "keeper converts immediately");
        assertEq(fees.modulePendingP(false), 0);
        assertGt(gold.balanceOf(box.vault()), 0);
        _noResidue(); _booked();
    }
    function test_G1_A2_oversizedQueueDrainsInCeilingPendingOverCapCalls() public {
        _alchemist(true, 1e15);
        // The full queue does not fit this hop; every admitted clip does.
        v3.setLiquidity(1 ether);
        uint256 pending = fees.modulePendingP(false);
        uint256 calls = (pending + 1e15 - 1) / 1e15;
        assertGt(calls, 2); assertLt(calls, 100);
        uint256 moved;
        for (uint256 i; i < calls; ++i) {
            uint256 left = pending - moved;
            uint256 spent = fees.executeModule(false);
            assertGt(spent, 0, "each call makes bounded progress");
            assertLe(spent, 1e15); assertLe(spent, left);
            moved += spent;
            assertEq(fees.modulePendingP(false), pending - moved);
            _noResidue(); _booked();
        }
        assertEq(moved, pending); assertEq(fees.executeModule(false), 0);
        assertGt(gold.balanceOf(box.vault()), 0);
    }
    function test_E1_reviewRemainderConvertsInThreeCalls() public {
        uint256 cap = 3033670033670025;
        _alchemist(true, cap);
        assertEq(fees.modulePendingP(false), 6067340067340060);
        uint256 safeBefore = p.balanceOf(fitSafe);
        _drain(6067340067340060, cap);
        assertEq(p.balanceOf(fitSafe), safeBefore, "balance the tail; all review funds convert");
    }
    event DustToDepth(address indexed receiver, address indexed hook, address indexed asset, uint256 amount);
    /// RC4-L1: a real E2 step, including recordLogs' two logs from the rolled-back attempt.
    /// Normal runs compare the committed vector; SH_WRITE_DUST_FIXTURE=1 regenerates it for the burn bot.
    function test_RC4_dustLogFixture() public {
        _alchemist(true); _rawPending(10);
        uint256 backing = pm.balanceOf(address(receiver), uint160(address(p)));
        vm.recordLogs();
        assertEq(fees.executeModule(false), 10);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 7);
        address executor = AlchemistView(module).executor();
        _dustClaim(logs[0], address(receiver), address(receiver), module);
        _dustClaim(logs[1], module, module, executor);
        _dustClaim(logs[2], executor, executor, address(0));
        _dustTake(logs[3], executor);
        _dustClaim(logs[4], executor, executor, address(hook));
        assertEq(logs[5].emitter, module);
        assertEq(logs[5].topics.length, 4);
        assertEq(logs[5].topics[0], keccak256("DustToDepth(address,address,address,uint256)"));
        assertEq(logs[5].topics[1], bytes32(uint256(uint160(address(receiver)))));
        assertEq(logs[5].topics[2], bytes32(uint256(uint160(address(hook)))));
        assertEq(logs[5].topics[3], bytes32(uint256(uint160(address(p)))));
        assertEq(logs[5].data, abi.encode(uint256(10)));
        assertEq(logs[6].emitter, address(receiver));
        assertEq(logs[6].topics.length, 3);
        assertEq(logs[6].topics[0], keccak256("ModuleExecuted(bool,address,uint256)"));
        assertEq(logs[6].topics[1], bytes32(0));
        assertEq(logs[6].topics[2], bytes32(uint256(uint160(module))));
        assertEq(logs[6].data, abi.encode(uint256(10)));
        assertEq(pm.balanceOf(address(receiver), uint160(address(p))), backing - 10);
        assertEq(fees.modulePendingP(false), 0); assertEq(hook.depthBudget(), initialDepth + 10); assertEq(p.balanceOf(fitSafe), 0);
        assertEq(gold.balanceOf(box.vault()), 0); _noResidue(); _booked();
        string memory json = "[";
        for (uint256 i; i < logs.length; ++i) {
            string memory key = string.concat("dust-log-", vm.toString(i));
            vm.serializeAddress(key, "address", logs[i].emitter);
            vm.serializeBytes32(key, "topics", logs[i].topics);
            string memory entry = vm.serializeBytes(key, "data", logs[i].data);
            json = string.concat(json, i == 0 ? "" : ",", entry);
        }
        json = string.concat(json, "]");
        string memory path = "../burn-bot/test/vectors/alchemist-dust-recorded.json";
        if (vm.envOr("SH_WRITE_DUST_FIXTURE", false)) vm.writeJson(json, path);
        else assertEq(vm.parseJson(vm.readFile(path)), vm.parseJson(json), "regenerate the burn bot fixture");
    }
    function _dustClaim(Vm.Log memory entry, address caller, address from, address to) private view {
        assertEq(entry.emitter, address(pm)); assertEq(entry.topics.length, 4);
        assertEq(entry.topics[0], keccak256("Transfer(address,address,address,uint256,uint256)"));
        assertEq(entry.topics[1], bytes32(uint256(uint160(from))));
        assertEq(entry.topics[2], bytes32(uint256(uint160(to))));
        assertEq(entry.topics[3], bytes32(uint256(uint160(address(p)))));
        assertEq(entry.data, abi.encode(caller, uint256(10)));
    }
    function _dustTake(Vm.Log memory entry, address to) private view {
        assertEq(entry.emitter, address(p)); assertEq(entry.topics.length, 3);
        assertEq(entry.topics[0], keccak256("Transfer(address,address,uint256)"));
        assertEq(entry.topics[1], bytes32(uint256(uint160(address(pm)))));
        assertEq(entry.topics[2], bytes32(uint256(uint160(to))));
        assertEq(entry.data, abi.encode(uint256(10)));
    }
    function test_E2_dustGoesExactlyToBoxHookOnTriggerExecution() public {
        _alchemist(true);
        _rawPending(10);
        bool zero = address(p) < address(w);
        assertEq(BoxSwapBoundsV2.minOut(zero, 10, BoxSwapBoundsV2.roomLimit(zero, v3.spot(), 49), 3000), 0);
        vm.expectEmit(true, true, true, true, module);
        emit DustToDepth(address(receiver), address(hook), address(p), 10);
        _drain(10, 1 ether);
        assertEq(gold.balanceOf(box.vault()), 0);
        assertEq(hook.depthBudget(), initialDepth + 10); assertEq(p.balanceOf(fitSafe), 0);
    }
    function test_E2_blockedDustClaimTransferRestoresThenRetriesOnce() public {
        _alchemist(true); _rawPending(10);
        uint256 backing = pm.balanceOf(address(receiver), uint160(address(p)));
        vm.mockCallRevert(address(pm), abi.encodeWithSignature("transfer(address,uint256,uint256)", address(hook), uint160(address(p)), uint256(10)), "blocked claims");
        (bool ok, bytes memory data) = address(fees).call{gas:3500000}(abi.encodeCall(IFeeModulesV21.executeModule, (false)));
        assertTrue(ok); assertEq(abi.decode(data, (uint256)), 0);
        assertEq(fees.modulePendingP(false), 10);
        assertEq(pm.balanceOf(address(receiver), uint160(address(p))), backing);
        assertEq(p.balanceOf(fitSafe), 0); _noResidue(); _booked();
        vm.clearMockedCalls(); _drain(10, 1 ether);
        assertEq(hook.depthBudget(), initialDepth + 10); assertEq(p.balanceOf(fitSafe), 0);
    }
    /// RC5-B-CONSERVE: even a successful manager response must debit and credit exactly once.
    function test_B_inexactClaimMovementsRestorePending() public {
        _alchemist(true); _rawPending(10);
        uint256 backing = pm.balanceOf(address(receiver), uint160(address(p)));
        address executor = AlchemistView(module).executor();
        for (uint256 i; i < 3; ++i) {
            if (i == 0) vm.mockCall(address(pm), abi.encodeWithSignature("transfer(address,uint256,uint256)", address(hook), uint160(address(p)), uint256(10)), abi.encode(true));
            else vm.mockCall(address(pm), abi.encodeWithSignature("balanceOf(address,uint256)", i == 1 ? address(hook) : executor, uint160(address(p))), abi.encode(i == 1 ? uint256(0) : uint256(10)));
            assertEq(fees.executeModule(false), 0, "inexact transfer refuses");
            vm.clearMockedCalls();
            assertEq(fees.modulePendingP(false), 10);
            assertEq(pm.balanceOf(address(receiver), uint160(address(p))), backing);
            assertEq(hook.depthBudget(), initialDepth); assertEq(p.balanceOf(fitSafe), 0);
            _noResidue(); _booked();
        }
        _drain(10, 1 ether); assertEq(hook.depthBudget(), initialDepth + 10);
    }
    /// RC5-B-EXIT: the hook consumes dust with its next eligible depth budget.
    function test_B_dustJoinsNextDeepenWithoutSafePayment() public {
        _alchemist(true); _rawPending(10);
        assertEq(fees.executeModule(false), 10);
        assertEq(hook.depthBudget(), initialDepth + 10);
        PoolDriver funding = new PoolDriver(pm); p.mint(address(funding), 1e15);
        funding.mintClaims(Currency.wrap(address(p)), address(hook), 1e15);
        uint256 depth = hook.depthBudget();
        vm.roll(block.number + 1);
        hook.deepen(address(0));
        assertLt(hook.depthBudget(), depth, "dust is part of the spendable depth budget");
        assertEq(p.balanceOf(fitSafe), 0); assertEq(gold.balanceOf(box.vault()), 0);
        _noResidue(); _booked();
    }
    /// RC5-B-CONSERVE: P destinations sum in P; pile receipts reconcile independently in gold.
    function test_B_pendingPileAndDepthConserveDistinctAssets() public {
        _alchemist(true);
        uint256 inputBefore = p.balanceOf(address(v3));
        uint256 outputBefore = gold.balanceOf(address(v2));
        _rawPending(16); _drain(16, 1 ether);
        uint256 pile = gold.balanceOf(box.vault()); assertGt(pile, 0);
        _rawPending(10); _drain(10, 1 ether);
        assertEq(fees.modulePendingP(false), 0);
        assertEq(p.balanceOf(address(v3)) - inputBefore, 16);
        assertEq(hook.depthBudget() - initialDepth, 10);
        assertEq(p.balanceOf(address(v3)) - inputBefore + hook.depthBudget() - initialDepth, 26);
        assertEq(gold.balanceOf(box.vault()), pile, "dust never credits the pile");
        assertEq(outputBefore - gold.balanceOf(address(v2)), pile);
        assertEq(p.balanceOf(fitSafe), 0);
    }
    function test_E2_convertibleSmallAmountIsNotSentToFit() public {
        _alchemist(true); _rawPending(16);
        _drain(16, 1 ether);
        assertEq(p.balanceOf(fitSafe), 0, "actual hop inputs admit a positive minimum");
        assertGt(gold.balanceOf(box.vault()), 0);
    }
    /// SH-V21-G1-INT fix round, finding 2: the dust exit stays bounded at every live pool price. Displace the v3 hop
    /// until a full clip's checked minimum rounds to zero (free with liquidity out of range, cheap in a thin pool).
    function _displaceHop() internal {
        v3.setLiquidity(1 ether); w.mint(address(v3), 10 ether);
        bool zero = address(p) < address(w);
        uint160 target = zero ? uint160((uint256(1) << 96) / 1e8) : uint160((uint256(1) << 96) * 1e8);
        AlchemistAttacker attacker = new AlchemistAttacker(); p.mint(address(attacker), 1e30);
        attacker.swap(v3, zero, 1e30, target);
        assertEq(v3.spot(), target, "spot displaced");
        assertEq(BoxSwapBoundsV2.minOut(zero, 1e15, BoxSwapBoundsV2.roomLimit(zero, v3.spot(), 49), 3000), 0,
            "a full clip's minimum rounds to zero");
    }
    function test_E4_displacedHopRefusesFullClipsInsteadOfAddingDepth() public {
        _alchemist(true, 1e15);
        uint256 pending = fees.modulePendingP(false);
        assertGt(pending, 2e15);
        _displaceHop();
        uint256 safeBefore = p.balanceOf(fitSafe);
        uint256 backing = pm.balanceOf(address(receiver), uint160(address(p)));
        assertEq(fees.executeModule(false), 0, "the trigger's full clip refuses, it is not dust");
        vm.warp(firstPendingAt + 7 days);
        vm.prank(address(0xbeef)); assertEq(fees.executeModule(false), 0, "a fallback caller's full clip refuses too");
        assertEq(fees.modulePendingP(false), pending, "pending restored for retry");
        assertEq(pm.balanceOf(address(receiver), uint160(address(p))), backing);
        assertEq(p.balanceOf(fitSafe), safeBefore, "nothing paid to FIT");
        assertEq(gold.balanceOf(box.vault()), 0);
        _noResidue(); _booked();
    }
    function test_E4_dustExitStopsAtTheFixedDustSizeAtAnyPrice() public {
        _alchemist(true, 1e15);
        assertEq(AlchemistView(module).dustMax(), DUST);
        _displaceHop();
        _rawPending(DUST + 1);
        assertEq(fees.executeModule(false), 0, "one raw unit above the dust size refuses");
        assertEq(fees.modulePendingP(false), DUST + 1); assertEq(p.balanceOf(fitSafe), 0);
        _rawPending(DUST);
        vm.expectEmit(true, true, true, true, module);
        emit DustToDepth(address(receiver), address(hook), address(p), DUST);
        assertEq(fees.executeModule(false), DUST, "the dust size itself still adds depth");
        assertEq(fees.modulePendingP(false), 0); assertEq(hook.depthBudget(), initialDepth + DUST); assertEq(p.balanceOf(fitSafe), 0);
        assertEq(gold.balanceOf(box.vault()), 0);
        _noResidue(); _booked();
    }
    function test_E3_rawUnitBoundaries() public {
        uint256 cap = 1000;
        _alchemist(true, cap);
        uint256[8] memory amounts = [uint256(0), 1, cap - 1, cap, cap + 1, 2 * cap - 1, 2 * cap, 2 * cap + 1];
        for (uint256 i; i < amounts.length; ++i) { _rawPending(amounts[i]); _drain(amounts[i], cap); }
    }
    function testFuzz_E3_conservationAndTermination(uint96 rawCap, uint8 rawCalls, uint96 rawTail) public {
        uint256 cap = bound(uint256(rawCap), 1, 1e15);
        uint256 pending = uint256(rawCalls % 16) * cap + uint256(rawTail) % cap;
        _alchemist(true, cap); _rawPending(pending); _drain(pending, cap);
    }
    function _drain(uint256 pending, uint256 cap) internal {
        uint256 bound_ = pending / cap + (pending % cap == 0 ? 0 : 1);
        uint256 backing = pm.balanceOf(address(receiver), uint160(address(p)));
        uint256 poolBefore = p.balanceOf(address(v3));
        uint256 safeBefore = p.balanceOf(fitSafe);
        uint256 depthBefore = hook.depthBudget();
        uint256 goldPoolBefore = gold.balanceOf(address(v2));
        uint256 pileBefore = gold.balanceOf(box.vault());
        uint256 moved;
        for (uint256 i; i < bound_; ++i) {
            uint256 spent = fees.executeModule(false);
            assertGt(spent, 0, "E1/E3: no stranded positive tail"); assertLe(spent, cap);
            moved += spent;
            assertEq(fees.modulePendingP(false), pending - moved);
            assertEq(pm.balanceOf(address(receiver), uint160(address(p))), backing - moved);
            assertEq(p.balanceOf(address(v3)) - poolBefore + hook.depthBudget() - depthBefore + pending - moved, pending);
            assertEq(goldPoolBefore - gold.balanceOf(address(v2)), gold.balanceOf(box.vault()) - pileBefore);
            assertEq(p.balanceOf(fitSafe), safeBefore, "no dust enters custody");
            _noResidue(); _booked();
        }
        assertEq(moved, pending); assertEq(fees.modulePendingP(false), 0);
        assertEq(fees.executeModule(false), 0, "no duplicate spend");
    }
    /// Raw-unit fixtures adjust only this debt and its exact claims backing. All other real ledgers stay intact.
    /// Needed because the normal side split queues multiples of ten, not every raw boundary.
    function _rawPending(uint256 amount) internal {
        vm.record(); uint256 old = fees.modulePendingP(false);
        (bytes32[] memory reads,) = vm.accesses(address(receiver)); assertEq(reads.length, 1);
        if (amount > old) {
            PoolDriver funding = new PoolDriver(pm); p.mint(address(funding), amount - old);
            funding.mintClaims(Currency.wrap(address(p)), address(receiver), amount - old);
        } else if (old > amount) {
            vm.prank(address(receiver)); pm.transfer(address(this), uint160(address(p)), old - amount);
        }
        vm.store(address(receiver), reads[0], bytes32(amount)); _booked();
    }
    function _strangerRefused() internal {
        vm.prank(address(0xbeef));
        vm.expectRevert(bytes4(keccak256("ConversionTriggerOnly()")));
        fees.executeModule(false);
    }
    function test_D1_onlyTriggerWhileActive() public {
        _alchemist(true, 1e15);
        uint256 pending = fees.modulePendingP(false);
        _strangerRefused();
        assertEq(fees.modulePendingP(false), pending);
        assertEq(fees.executeModule(false), 1e15);
        _strangerRefused(); _noResidue(); _booked();
    }
    function test_D2_exactSevenDaysAndEveryConversionRestartsWait() public {
        _alchemist(true, 1e15);
        vm.warp(firstPendingAt + 7 days - 1); _strangerRefused();
        vm.warp(firstPendingAt + 7 days);
        vm.prank(address(0xbeef)); assertEq(fees.executeModule(false), 1e15);
        _strangerRefused();
        vm.warp(block.timestamp + 7 days - 1); _strangerRefused();
        vm.warp(block.timestamp + 1);
        vm.prank(address(0xcafe)); assertEq(fees.executeModule(false), 1e15);
        // A keeper conversion also restarts the wait, even before the fallback opens.
        vm.warp(block.timestamp + 1 days); assertEq(fees.executeModule(false), 1e15);
        vm.warp(block.timestamp + 7 days - 1); _strangerRefused();
        vm.warp(block.timestamp + 1);
        vm.prank(address(0xbeef)); assertGt(fees.executeModule(false), 0);
        _noResidue(); _booked();
    }
    function _newFees(uint256 amount) internal {
        PoolDriver funding = new PoolDriver(pm); p.mint(address(funding), amount);
        funding.mintClaims(Currency.wrap(address(p)), address(receiver), amount);
        receiver.collect(address(0));
    }
    function test_D2_receiptsAndFailedAttemptsNeverPostponeFallback() public {
        _alchemist(true, 1e15);
        vm.warp(firstPendingAt + 6 days);
        _newFees(1500);
        v2.setMode(1); assertEq(fees.executeModule(false), 0);
        vm.warp(firstPendingAt + 7 days);
        vm.prank(address(0xbeef)); assertEq(fees.executeModule(false), 0);
        v2.setMode(0);
        vm.prank(address(0xbeef)); assertEq(fees.executeModule(false), 1e15);
        _strangerRefused(); _noResidue(); _booked();
    }
    function test_D2_emptyQueueStartsFreshWaitOnNextReceipt() public {
        _alchemist(true);
        assertGt(fees.executeModule(false), 0);
        vm.warp(block.timestamp + 30 days);
        assertEq(fees.executeModule(false), 0);
        _newFees(1500); uint256 since = block.timestamp;
        _strangerRefused();
        vm.warp(since + 7 days - 1); _strangerRefused();
        vm.warp(since + 7 days);
        vm.prank(address(0xbeef)); assertGt(fees.executeModule(false), 0);
        _noResidue(); _booked();
    }
    function test_D2_eachSideWaitsIndependentlyAndZeroBookingsDoNotPostpone() public {
        _alchemist(true, 1e15, true);
        buyer.swap(hook.poolKey(), false, token.balanceOf(address(buyer)) / 4, TickMath.MAX_SQRT_PRICE - 1);
        _sellFeeP(); receiver.collect(address(0));
        assertGt(fees.modulePendingP(true), 0);
        uint256 sellerSince = block.timestamp;
        vm.warp(sellerSince + 7 days - 1);
        // A conversion on buyers and an empty collect cannot refresh sellers' clock.
        assertEq(fees.executeModule(false), 1e15); receiver.collect(address(0));
        vm.prank(address(0xbeef)); vm.expectRevert(bytes4(keccak256("ConversionTriggerOnly()")));
        fees.executeModule(true);
        vm.warp(sellerSince + 7 days);
        vm.prank(address(0xbeef)); assertGt(fees.executeModule(true), 0);
        _strangerRefused(); _noResidue(); _booked();
    }
    function test_D2_fallbackDustToDepthHasSameCallerRuleAndFreshReceiptClock() public {
        _alchemist(true); _rawPending(10); _strangerRefused();
        vm.warp(firstPendingAt + 7 days);
        vm.mockCallRevert(address(pm), abi.encodeWithSignature("transfer(address,uint256,uint256)", address(hook), uint160(address(p)), uint256(10)), "blocked claims");
        vm.prank(address(0xbeef)); assertEq(fees.executeModule(false), 0);
        vm.clearMockedCalls();
        vm.prank(address(0xbeef)); assertEq(fees.executeModule(false), 10);
        assertEq(hook.depthBudget(), initialDepth + 10); assertEq(p.balanceOf(fitSafe), 0);
        _newFees(15); _strangerRefused(); _noResidue(); _booked();
    }
    function test_D1_insufficientGasCannotBypassTriggerOrResetClock() public {
        _alchemist(true, 1e15);
        uint256 pending = fees.modulePendingP(false);
        for (uint256 gas = 10000; gas <= 200000; gas += 10000) {
            vm.prank(address(0xbeef));
            (bool ok,) = address(fees).call{gas: gas}(abi.encodeCall(IFeeModulesV21.executeModule, (false)));
            assertFalse(ok); assertEq(fees.modulePendingP(false), pending);
        }
        vm.warp(firstPendingAt + 7 days);
        vm.prank(address(0xbeef)); assertEq(fees.executeModule(false), 1e15);
    }
    function test_D3_review490TickSameTransactionNonTriggerRefused() public {
        _alchemist(true, 1e15); v3.setLiquidity(1 ether);
        AlchemistAttacker attacker = new AlchemistAttacker(); p.mint(address(attacker), 1 ether);
        bool zero = address(p) < address(w);
        uint160 beforeSpot = v3.spot(); uint256 pending = fees.modulePendingP(false);
        (bool ok, bytes memory reason) = attacker.pushAndConvert(v3, zero,
            BoxSwapBoundsV2.roomLimit(zero, beforeSpot, 490), fees);
        assertFalse(ok, "non-trigger cannot convert after displacing the route");
        assertEq(reason, abi.encodeWithSignature("ConversionTriggerOnly()"));
        assertNotEq(v3.spot(), beforeSpot, "earlier 490-tick swap really executed");
        assertEq(fees.modulePendingP(false), pending); assertEq(gold.balanceOf(box.vault()), 0);
        _noResidue(); _booked();
    }
    /// SH-V21-G1-INT fix round, finding 1 (A5 at graduation): a fee booked during a raise of seven days or more
    /// does not open the fallback at graduation. Each waiting side's seven days restart when graduation settles.
    function _lateGraduation() internal returns (uint256 graduatedAt) {
        _alchemist(false, 1e12);
        vm.warp(firstPendingAt + 7 days);
        _fill(); box.graduate(); graduatedAt = block.timestamp;
        assertGt(fees.modulePendingP(false), 2e12, "more than two clips wait from the raise");
    }
    function test_D4_raiseOfSevenDaysLeavesKeeperItsSevenDaysAfterGraduation() public {
        uint256 graduatedAt = _lateGraduation();
        uint256 pending = fees.modulePendingP(false);
        _strangerRefused(); assertEq(fees.modulePendingP(false), pending);
        vm.warp(graduatedAt + 7 days - 1); _strangerRefused();
        assertEq(fees.modulePendingP(false), pending); assertEq(gold.balanceOf(box.vault()), 0);
        vm.warp(graduatedAt + 7 days);
        vm.prank(address(0xbeef)); assertEq(fees.executeModule(false), 1e12, "fallback opens seven days after graduation");
        _strangerRefused(); _noResidue(); _booked();
    }
    function test_D4_keeperConvertsAtOnceWhenALongRaiseGraduates() public {
        _lateGraduation();
        uint256 pending = fees.modulePendingP(false);
        assertEq(fees.executeModule(false), 1e12, "the trigger needs no wait");
        assertEq(fees.modulePendingP(false), pending - 1e12);
        assertGt(gold.balanceOf(box.vault()), 0);
        _strangerRefused(); _noResidue(); _booked();
    }
    function test_D4_graduateDisplaceAndConvertInOneTransactionRefused() public {
        _alchemist(false, 1e12);
        vm.warp(firstPendingAt + 7 days);
        _fill(); v3.setLiquidity(1 ether);
        AlchemistAttacker attacker = new AlchemistAttacker(); p.mint(address(attacker), 1 ether);
        bool zero = address(p) < address(w);
        uint160 beforeSpot = v3.spot(); uint256 pending = fees.modulePendingP(false);
        (bool ok, bytes memory reason) = attacker.graduatePushAndConvert(address(box), v3, zero,
            BoxSwapBoundsV2.roomLimit(zero, beforeSpot, 490), fees);
        assertFalse(ok, "a stranger cannot graduate, displace and convert in one transaction");
        assertEq(reason, abi.encodeWithSignature("ConversionTriggerOnly()"));
        assertTrue(box.graduated(), "the same transaction's graduation went through");
        assertNotEq(v3.spot(), beforeSpot, "the same transaction's 490-tick swap went through");
        assertEq(fees.modulePendingP(false), pending); assertEq(gold.balanceOf(box.vault()), 0);
        _noResidue(); _booked();
    }
    function test_D4_settlementInsideExecuteModuleAlsoRestartsWait() public {
        _alchemist(false, 1e12);
        vm.warp(firstPendingAt + 7 days);
        _fill();
        // The coordinator's graduation poke fails, so the first later receiver call settles graduation itself.
        vm.mockCallRevert(address(receiver), abi.encodeWithSignature("onGraduation()"), "");
        box.graduate(); vm.clearMockedCalls();
        uint256 pending = fees.modulePendingP(false);
        // A stranger's executeModule settles in _prepare and is refused in the same call, which rolls both back.
        _strangerRefused(); assertEq(fees.modulePendingP(false), pending);
        vm.warp(block.timestamp + 1 days); _strangerRefused();
        receiver.collect(address(0)); uint256 settledAt = block.timestamp;
        vm.warp(settledAt + 7 days - 1); _strangerRefused();
        vm.warp(settledAt + 7 days);
        vm.prank(address(0xbeef)); assertGt(fees.executeModule(false), 0, "fallback opens seven days after settlement");
        _noResidue(); _booked();
    }
    function test_AL02_wholeLifeConvertsOnlyBudgetAndBurnsForGold() public {
        _alchemist(true);
        uint256 pending = fees.modulePendingP(false);
        uint256 backing = pm.balanceOf(address(receiver),uint160(address(p)));
        uint256 pPool = p.balanceOf(address(v3));
        uint256 goldPool = gold.balanceOf(address(v2));
        assertEq(fees.executeModule(false),pending);
        assertEq(p.balanceOf(address(v3)) - pPool,pending);
        uint256 received = gold.balanceOf(box.vault()); assertGt(received,0);
        assertEq(goldPool - gold.balanceOf(address(v2)),received);
        assertEq(pm.balanceOf(address(receiver),uint160(address(p))),backing - pending);
        assertEq(fees.modulePendingP(false),0); assertEq(fees.executeModule(false),0);
        _noResidue(); _booked();
        IPileVaultV2 pile = IPileVaultV2(box.vault());
        uint256 burn = token.balanceOf(address(buyer)) / 2;
        uint256 expected = received * burn / token.totalSupply() * 9500 / 10000;
        vm.startPrank(address(buyer)); token.approve(address(pile),burn);
        assertEq(pile.redeem(burn,expected,address(buyer)),expected); vm.stopPrank();
        assertEq(gold.balanceOf(box.vault()),received - expected);
        assertEq(address(receiver).code.length,45 + 391,"unchanged generic clone");
        assertEq(vm.getNonce(address(receiver)),1,"no per-box action clone");
    }
    function test_AL03_lateHopRefusalAndGasExhaustionRollBackEntireRoute() public {
        _alchemist(true);
        uint256 pending = fees.modulePendingP(false);
        uint256 pPool = p.balanceOf(address(v3));
        for (uint8 mode = 1; mode <= 3; ++mode) {
            v2.setMode(mode);
            (bool ok,bytes memory result) = address(fees).call{gas:3500000}(abi.encodeCall(IFeeModulesV21.executeModule,(false)));
            assertTrue(ok,"receiver restoration survives route failure"); assertEq(abi.decode(result,(uint256)),0);
            assertEq(fees.modulePendingP(false),pending); assertEq(p.balanceOf(address(v3)),pPool);
            assertEq(gold.balanceOf(box.vault()),0); _noResidue(); _booked();
        }
        v2.setMode(0); assertEq(fees.executeModule(false),pending);
    }
    function test_AL04_partialFillIsHeldThenRetrySucceeds() public {
        _alchemist(true); uint256 pending = fees.modulePendingP(false);
        v3.setLiquidity(1000); assertEq(fees.executeModule(false),0);
        assertEq(fees.modulePendingP(false),pending); _noResidue();
        v3.setLiquidity(1e24); assertEq(fees.executeModule(false),pending);
    }
    function test_AL05_failureHeldBudgetJoinsPotNeverGoldOrSeeder() public {
        _alchemist(false); uint256 pending = fees.modulePendingP(false); assertGt(pending,0);
        vm.warp(box.deadline()); box.fail();
        assertEq(fees.modulePendingP(false),0); assertEq(gold.balanceOf(box.vault()),0);
        vm.expectRevert(); fees.executeModule(false);
        assertEq(IPileVaultV2(box.vault()).returnSeed(),0); assertGt(_claimBuyer(),pending);
        _noResidue(); _booked();
    }
    function test_AL06_callbackCannotSpendOutsideSwapOrPayTwice() public {
        _alchemist(true); address executor = AlchemistView(module).executor();
        vm.expectRevert(); v3.forgeCallback(executor,1,0);
        uint256 pending = fees.modulePendingP(false); v3.setMode(2);
        assertEq(fees.executeModule(false),0); assertEq(fees.modulePendingP(false),pending);
        _noResidue();
    }
    function test_AL12_coldTriggerExecutionFitsKeeperEnvelopeAndCodehashRefusalRetries() public {
        _alchemist(true); uint256 pending = fees.modulePendingP(false);
        address executor = AlchemistView(module).executor();
        bytes memory code = executor.code; vm.etch(executor,hex"00");
        assertEq(fees.executeModule(false),0); assertEq(fees.modulePendingP(false),pending);
        vm.etch(executor,code);
        _coldRelease();
        address[9] memory cold = [module,executor,address(receiver),address(box),box.vault(),address(p),address(w),address(gold),address(pm)];
        for (uint256 i; i < cold.length; ++i) vm.cool(cold[i]);
        vm.cool(address(v2)); vm.cool(address(v3));
        uint256 before_ = gasleft();
        (bool ok,bytes memory result) = address(fees).call{gas:3500000 - 21204}(abi.encodeCall(IFeeModulesV21.executeModule,(false)));
        emit log_named_uint("cold conversion gas",before_ - gasleft() + 21204);
        assertTrue(ok); assertEq(abi.decode(result,(uint256)),pending); _noResidue();
    }
    function test_AL13_incompatiblePileRefusesAndAuthenticatesCaller() public {
        _alchemist(true); uint256 pending = fees.modulePendingP(false);
        (bool ok,) = module.call(abi.encodeWithSignature("execute(address,address,uint256)",address(pm),address(p),pending));
        assertFalse(ok);
        bytes memory code = box.vault().code; vm.etch(box.vault(),hex"00");
        assertEq(fees.executeModule(false),0); assertEq(fees.modulePendingP(false),pending);
        vm.etch(box.vault(),code); assertEq(fees.executeModule(false),pending);
    }
}

contract AlchemistAttacker is AlchemistTrader {
    function pushAndConvert(AlchemistV3Pool pool, bool zero, uint160 limit, IFeeModulesV21 fees)
        external returns (bool ok, bytes memory reason)
    {
        this.swap(pool, zero, 1 ether, limit);
        return address(fees).call(abi.encodeCall(IFeeModulesV21.executeModule, (false)));
    }
    /// Graduation is permissionless and pays its caller; one contract graduates, displaces a hop, then converts.
    function graduatePushAndConvert(address box, AlchemistV3Pool pool, bool zero, uint160 limit, IFeeModulesV21 fees)
        external returns (bool ok, bytes memory reason)
    {
        (bool graduated,) = box.call(abi.encodeWithSignature("graduate()"));
        require(graduated, "graduate");
        this.swap(pool, zero, 1 ether, limit);
        return address(fees).call(abi.encodeCall(IFeeModulesV21.executeModule, (false)));
    }
}
