// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VmSafe} from "forge-std/Vm.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {BoxReceiver} from "../../../../src/box/BoxReceiver.sol";
import {FeeBatch} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxHook} from "../../../../src/box/interfaces/IBoxHook.sol";
import {IBoxReceiver} from "../../../../src/box/interfaces/IBoxReceiver.sol";
import {EthIn, EthOut} from "../common/AuditGhostLedger.sol";
import {AuditU4ClaudeBase} from "./AuditU4ClaudeBase.sol";
import {AuditU4ClaudeUnlocker} from "./AuditU4ClaudeHelpers.sol";

/// @title AuditU4ClaudeGasTest
/// @notice TEST ONLY (SH-AUDIT-B0 U4, Claude). Lens L5 (bounded cost, liveness) and L7 (packed fields' lifetime):
/// P4.13 (collect's cost bounded at any ledger size: at most four positions harvested plus constant work; the 0.005
/// ETH minimum the only refusal not caused by the caller's own choices), P4.18 (the uint128 ledgers and totals and
/// the 32-bit epoch counter: the lifetime bound, pinned at the edge).
/// Sources: BoxReceiver.sol:158-181, :941-988; BoxHook.sol:440-466 (`_harvestAll`: the curve, or at most the ask,
/// the bid, the sentinel and the pair); BoxReceiverBase.sol:44-55 (the state word), :59-118 (the uint128 ledgers),
/// :132-136 (`_u128`); BC-017, BC-018 (EIP-7825 cap 16,777,216), BC-122.
/// forge-config: default.evm_version = "osaka"
contract AuditU4ClaudeGasTest is AuditU4ClaudeBase {
    /// @dev The bound this suite pins for one collect under Osaka (the largest measured, with four positions, Q and T
    /// fees, the stream's 200,000-gas notice, REV-16 returns and a tip, is well below it; see the logged figures).
    /// Amsterdam's figures are about twice Osaka's: `AuditU4ClaudeForkAmsterdamTest` pins them against 1,600,000.
    uint256 internal constant COLLECT_GAS_BOUND = 800_000;
    uint256 internal constant EIP7825_CAP = 16_777_216;

    // ================================================================================================ P4.13

    /// collect's gas in every shape box 0 reaches: on the curve (reserve, T burn), graduated (three positions, the
    /// stream's notice), with the depth pair (four positions), with notes to return; and the batch size (0.005 ETH or
    /// 10,000 ETH) changes the cost by little: no loop over amounts, ledgers or history.
    function testProperty_AUDIT_U4_collectGasBounded() public {
        _toBonding();
        _tradeBothSides(0.6 ether);
        uint256 gBonding = _collectGas();
        _toGraduated();
        // Three positions, measured on a snapshot (the pair needs the price where the average is).
        uint256 snap = vm.snapshotState();
        _tradeBothSides(1 ether);
        uint256 gThree = _collectGas();
        vm.revertToState(snap);
        _makePair();
        _tradeBothSides(1 ether);
        vm.prank(a.executor);
        receiver.noteModuleFees(0.001 ether, 0);
        uint256 harvests = _countHarvestPokes();
        assertEq(harvests, 4, "the ask, the bid, the sentinel and the pair: four pokes");
        _tradeBothSides(1 ether);
        uint256 gFour = _collectGas();
        _batchOf(BATCH_MIN);
        uint256 gSmall = _collectGas();
        _batchOf(10_000 ether);
        uint256 gBig = _collectGas();
        emit log_named_uint("collect gas, bonding (curve, reserve, T burn)", gBonding);
        emit log_named_uint("collect gas, graduated, three positions, stream notice", gThree);
        emit log_named_uint("collect gas, four positions, a REV-16 note, stream notice", gFour);
        emit log_named_uint("collect gas, a 0.005 ETH gifted batch", gSmall);
        emit log_named_uint("collect gas, a 10,000 ETH gifted batch", gBig);
        uint256[5] memory g = [gBonding, gThree, gFour, gSmall, gBig];
        for (uint256 i; i < 5; ++i) {
            assertLt(g[i], COLLECT_GAS_BOUND, "collect within the bound");
            assertLt(g[i], EIP7825_CAP / 20, "a twentieth of the EIP-7825 cap");
        }
        uint256 d = gBig > gSmall ? gBig - gSmall : gSmall - gBig;
        assertLt(d, 30_000, "the amount barely changes the cost");
    }

    /// P4.13, BC-017: for any batch size and any accepting tip recipient, with enough gas, collect succeeds iff the
    /// batch's Q (after the reserve, plus it) is at least 0.005 ETH; the only refusal is BatchTooSmall.
    function testFuzz_AUDIT_U4_onlyTheMinimumRefusesCollect(uint96 qRaw, uint8 tipSeed, bool graduated) public {
        if (graduated) _toGraduated();
        else _toBonding();
        uint256 q = bound(qRaw, 0, 0.012 ether);
        if (q != 0) _giftEth(a.receiver, q);
        address[4] memory tips = [eoa[4], address(contractDrawer), eoa7702, address(0xdead)];
        address tipTo = tips[tipSeed % 4];
        vm.prank(keeper);
        (bool ok, bytes memory ret) = a.receiver.call{gas: 5_000_000}(abi.encodeCall(IBoxReceiver.collect, (tipTo)));
        if (q < BATCH_MIN) {
            assertFalse(ok);
            assertEq(ret, abi.encodeWithSelector(IBoxReceiver.BatchTooSmall.selector, q, BATCH_MIN), "BatchTooSmall");
        } else {
            assertTrue(ok, "a batch at or above the minimum is always collected");
        }
    }

    /// The refusals P4.13's "only reason" leaves to the caller (each the caller's own choice, never a third party's):
    /// a tip recipient that refuses ETH (testFuzz_AUDIT_U4_failingTipRecipientBlocksOnlyItsCollect), too little gas for
    /// the stream's whole 200,000 (StreamGasTooLow, stream-gas review R3), and a call from inside another PoolManager
    /// unlock (the hook's harvest refuses a foreign unlock). Each leaves the batch for the next caller.
    function testProperty_AUDIT_U4_collectRefusalsAreTheCallers() public {
        _toGraduated();
        _tradeBothSides(1 ether);
        uint256 enough = _minimalCollectGas();
        emit log_named_uint("the least gas a collect with a stream notice succeeds with", enough);
        (bool ok, bytes memory ret) = a.receiver.call{gas: enough - 1}(abi.encodeCall(IBoxReceiver.collect, (keeper)));
        assertFalse(ok);
        assertEq(bytes4(ret), BoxReceiver.StreamGasTooLow.selector, "just below: StreamGasTooLow, not out of gas");
        AuditU4ClaudeUnlocker unlocker = new AuditU4ClaudeUnlocker(pm);
        vm.expectRevert(IBoxHook.ForeignUnlock.selector);
        unlocker.run(a.receiver, abi.encodeCall(IBoxReceiver.collect, (keeper)));
        FeeBatch memory b = _collect(eoa[6], eoa[6]);
        assertGe(b.q, 0.009 ether, "the next caller collects the whole batch (1% of the 1 ETH buy)");
        (uint256 uq,) = _unbooked();
        assertEq(uq, 0);
        _assertGhostLedger();
    }

    // ================================================================================================ P4.18

    /// P4.18: the uint128 ledgers hold claims, and claims are backed by ETH in the PoolManager: a ledger can never
    /// exceed the ETH in existence (about 1.2e26 wei, far below 2^128 = 3.4e38), so `_u128` (BoxReceiverBase.sol:132)
    /// never truncates a reachable amount. The cumulative totals (`totals()`) are the first fields to fill: at the
    /// edge, a total at 2^128 − 1 − x takes a part of x and refuses x + 1 with an arithmetic panic (checked
    /// arithmetic: a total never wraps). Lifetime: 2^128 wei ≈ 3.4e20 ETH of FIT credits, 4.5e14 years at a million
    /// ETH of fees a year.
    function testProperty_AUDIT_U4_packedTotalsLifetimeBound() public {
        _toGraduated();
        // `_t` starts at slot 9: toFit (low 128 bits) and toPlatform (high 128 bits) share it.
        bytes32 raw = vm.load(a.receiver, bytes32(uint256(9)));
        (uint256 toFit,,,,,,) = receiver.totals();
        assertEq(uint256(raw) & type(uint128).max, toFit, "slot 9 low half is totals().toFit");
        uint256 part = 11 * ((15 ether + _qCarry()) / 15); // FIT's part of a 15 ETH intake
        _storeToFit(raw, type(uint128).max - part);
        _fundFees(eoa[1], 15 ether);
        (toFit,,,,,,) = receiver.totals();
        assertEq(toFit, type(uint128).max, "a total reaches 2^128 - 1 exactly");
        raw = vm.load(a.receiver, bytes32(uint256(9)));
        part = 11 * ((15 ether + _qCarry()) / 15);
        _storeToFit(raw, type(uint128).max - part + 1);
        vm.deal(eoa[1], 15 ether);
        vm.expectRevert(abi.encodeWithSignature("Panic(uint256)", 0x11));
        vm.prank(eoa[1]);
        receiver.fundFees{value: 15 ether}();
        assertLt(address(pm).balance, 2 ** 100, "all the ETH the PoolManager holds is far below 2^128");
    }

    /// P4.18: the epoch counter (bits 8-39 of the state word) is exact for 2^32 epochs after graduation (2^32 × 30 days
    /// ≈ 353 million years; the brief's 10,000 years is epoch 121,762). At 10,000 years and at the last epoch the
    /// counter, its keep and the carry bits beside it are exact. Beyond epoch 2^32 − 1 the shifted epoch would spill
    /// into the Q carry's byte (BoxReceiver.sol:765); that is the stated bound.
    function testProperty_AUDIT_U4_epochCounterLifetimeBound() public {
        _toGraduated();
        uint256 g = coordinator.graduatedAt();
        uint256[2] memory epochs = [uint256(121_762), uint256(type(uint32).max)];
        for (uint256 i; i < 2; ++i) {
            vm.roll(vm.getBlockNumber() + 1);
            vm.warp(g + epochs[i] * EPOCH + 1);
            uint256 keep = 2 * ((150 ether + 7 + _qCarry()) / 15);
            _fundFees(eoa[1], 150 ether + 7);
            (uint256 e, uint256 kept, uint256 remaining) = receiver.platformEpoch();
            assertEq(e, epochs[i], "the epoch");
            assertEq(kept, keep, "a fresh epoch's keep (no carry-over)");
            assertEq(remaining, CAP - keep);
            uint256 s = uint256(vm.load(a.receiver, bytes32(0)));
            assertEq((s >> 8) & type(uint32).max, epochs[i], "the stored 32-bit epoch");
            assertLt((s >> 40) & 0xff, 15, "the Q carry byte intact");
            assertEq(s & 3, 3, "initialised and settled bits intact");
        }
        _assertGhostLedger();
    }

    // ================================================================================================ helpers

    function _qCarry() internal view returns (uint256 q) {
        (q,) = receiver.carried();
    }

    function _storeToFit(bytes32 raw, uint256 value) internal {
        uint256 high = uint256(raw) >> 128 << 128;
        vm.store(a.receiver, bytes32(uint256(9)), bytes32(high | value));
    }

    /// One collect by the keeper; returns its gas (the external call's execution, measured around it).
    function _collectGas() internal returns (uint256 used) {
        uint256 e0 = keeper.balance;
        vm.prank(keeper);
        uint256 g0 = gasleft();
        receiver.collect(keeper);
        used = g0 - gasleft();
        _noteEthChange(e0, keeper.balance, EthIn.Other, EthOut.Tip);
    }

    function _countHarvestPokes() internal returns (uint256 pokes) {
        uint256 e0 = keeper.balance;
        vm.startStateDiffRecording();
        vm.prank(keeper);
        receiver.collect(keeper);
        VmSafe.AccountAccess[] memory acc = vm.stopAndReturnStateDiff();
        _bookKeeperTip(e0);
        for (uint256 i; i < acc.length; ++i) {
            if (acc[i].accessor != a.hook || acc[i].account != address(pm)) continue;
            if (acc[i].kind != VmSafe.AccountAccessKind.Call) continue;
            if (bytes4(acc[i].data) == IPoolManager.modifyLiquidity.selector) ++pokes;
        }
    }

    function _bookKeeperTip(uint256 e0) internal {
        _noteEthChange(e0, keeper.balance, EthIn.Other, EthOut.Tip);
    }

    /// The least gas `collect(keeper)` succeeds with now (binary search on a snapshot).
    function _minimalCollectGas() internal returns (uint256 lo) {
        uint256 hi = 3_000_000;
        lo = 100_000;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            uint256 snap = vm.snapshotState();
            (bool ok,) = a.receiver.call{gas: mid}(abi.encodeCall(IBoxReceiver.collect, (keeper)));
            vm.revertToState(snap);
            if (ok) hi = mid;
            else lo = mid + 1;
        }
    }
}
