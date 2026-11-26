// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VmSafe} from "forge-std/Vm.sol";
import {BoxReceiver} from "../../../../src/box/BoxReceiver.sol";
import {IBoxReceiver} from "../../../../src/box/interfaces/IBoxReceiver.sol";
import {EthIn, EthOut} from "../common/AuditGhostLedger.sol";
import {AuditU4ClaudeBase} from "./AuditU4ClaudeBase.sol";
import {
    AuditU4ClaudeSafeProxy,
    AuditU4ClaudeSafeSingleton,
    AuditU4ClaudeStipendPayer,
    AuditU4ClaudeStreamStandIn,
    AuditU4ClaudeWeth9
} from "./AuditU4ClaudeHelpers.sol";

/// @title AuditU4ClaudeForkTest
/// @notice TEST ONLY (SH-AUDIT-B0 U4, Claude). The fork-sensitive U4 properties, run under Osaka here and under
/// Amsterdam in `AuditU4ClaudeForkAmsterdamTest` (the same tests): the router's 2,300-gas acceptance (P4.16, BC-114),
/// WETH9's stipend unwrap (P4.15), the stream's whole 200,000-gas notice (P4.11), payouts to an EIP-7702-delegated
/// account and to a Safe-shaped proxy (P4.12, L6), the settlement within POKE_GAS (BC-143).
/// R0-A observed that under Amsterdam a value call to an EIP-7702-delegated EOA needs about 900 gas beyond the
/// 2,300-gas stipend. U4 sends ETH only with all gas (BoxReceiver.sol:340 `fundBudget{value}`; the PoolManager's
/// `take`, v4-core Currency.sol:48 `call(gas(), …)`, for the tip and the Safe; BoxRoyaltyRouter.sol:69 `call{value}`;
/// no `transfer`, `send` or gas-capped value call in src/box), and receives stipend payments only at the royalty
/// router, a contract (the receiving clone). `testProperty_AUDIT_U4_noStipendSendToA7702Account` pins both halves.
/// forge-config: default.evm_version = "osaka"
contract AuditU4ClaudeForkTest is AuditU4ClaudeBase {
    function _isAmsterdam() internal view returns (bool) {
        return keccak256(bytes(vm.getEvmVersion())) == keccak256("amsterdam");
    }

    /// P4.16: transfer, send and a 2,300-gas call to the royalty router succeed under this fork.
    function testProperty_AUDIT_U4_routerStipendUnderThisFork() public {
        _toGraduated();
        AuditU4ClaudeStipendPayer payer = new AuditU4ClaudeStipendPayer();
        vm.deal(address(this), address(this).balance + 3 ether);
        uint256 r0 = a.royaltyRouter.balance;
        payer.payTransfer{value: 1 ether}(payable(a.royaltyRouter));
        assertTrue(payer.paySend{value: 1 ether}(payable(a.royaltyRouter)), "send");
        assertTrue(payer.payCall{value: 1 ether}(a.royaltyRouter, 2_300, ""), "2,300-gas call");
        assertEq(a.royaltyRouter.balance - r0, 3 ether);
        _noteEthIn(EthIn.Royalty, 3 ether);
        emit log_named_string("evm", vm.getEvmVersion());
        _assertGhostLedger();
    }

    /// P4.15: WETH9's `withdraw` (transfer, 2,300 gas) into the router works under this fork, and flush delivers.
    function testProperty_AUDIT_U4_weth9UnwrapUnderThisFork() public {
        vm.etch(a.weth, address(new AuditU4ClaudeWeth9()).code);
        _toGraduated();
        _payRoyaltyWeth(eoa[0], 5 ether);
        vm.expectCall(a.receiver, 5 ether, abi.encodeCall(IBoxReceiver.fundFees, ()));
        assertEq(royaltyRouter.flush(), 5 ether);
        _assertGhostLedger();
    }

    /// P4.11 under this fork: the stream's notice gets its whole 200,000 gas.
    function testProperty_AUDIT_U4_streamCapUnderThisFork() public {
        _toGraduated();
        uint256 tOut = _buy(eoa[3], 1 ether);
        _advance(1);
        _sell(eoa[3], tOut / 2);
        bytes memory code = a.itemStream.code;
        vm.etch(a.itemStream, address(new AuditU4ClaudeStreamStandIn(AuditU4ClaudeStreamStandIn.Mode.Accept)).code);
        vm.recordLogs();
        _collect(keeper, keeper);
        uint256 gasAtEntry;
        bool seen;
        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == a.itemStream && logs[i].topics[0] == AuditU4ClaudeStreamStandIn.Notified.selector) {
                (gasAtEntry,) = abi.decode(logs[i].data, (uint256, bytes));
                seen = true;
            }
        }
        vm.etch(a.itemStream, code);
        assertTrue(seen, "notified");
        emit log_named_uint("gas at the stream's entry", gasAtEntry);
        assertGe(gasAtEntry, 199_800, "the whole 200,000");
        assertLe(gasAtEntry, 200_000);
    }

    /// P4.12, L6: the tip to an EIP-7702-delegated EOA and the Safe's payout to an EIP-7702-delegated account or to a
    /// Safe-shaped proxy (a cold DELEGATECALL and a log: more than 2,300 gas) succeed under this fork: U4's payouts
    /// carry all gas. The stipend alone to the same 7702 account fails under Amsterdam (R0-A's observation), so a
    /// stipend payout would have broken here; none exists.
    function testProperty_AUDIT_U4_noStipendSendToA7702Account() public {
        _toGraduated();
        _batchOf(0.05 ether);
        uint256 e0 = eoa7702.balance;
        _collect(keeper, eoa7702);
        assertEq(eoa7702.balance - e0, TIP_MAX, "the tip reaches the 7702 EOA");
        _fundFees(eoa[1], 15 ether);
        vm.etch(safe, abi.encodePacked(hex"ef0100", address(delegate7702)));
        uint256 owed = receiver.platformOwed();
        assertEq(_payPlatform(keeper), owed, "the Safe as a 7702-delegated account is paid");
        AuditU4ClaudeSafeSingleton singleton = new AuditU4ClaudeSafeSingleton();
        vm.etch(safe, address(new AuditU4ClaudeSafeProxy(address(singleton))).code);
        _fundFees(eoa[1], 15 ether);
        owed = receiver.platformOwed();
        vm.expectEmit(safe);
        emit AuditU4ClaudeSafeSingleton.SafeReceived(address(pm), owed);
        assertEq(_payPlatform(keeper), owed, "a Safe proxy is paid (all gas)");
        vm.etch(safe, "");
        // The contrast: a bare 2,300-gas stipend to the 7702 EOA.
        vm.deal(address(this), address(this).balance + 1);
        bool stipendOk = payable(eoa7702).send(1);
        if (_isAmsterdam()) assertFalse(stipendOk, "Amsterdam: the stipend alone is short for a 7702 account");
        else assertTrue(stipendOk, "Osaka: the stipend suffices");
        emit log_named_string("evm", vm.getEvmVersion());
        emit log_named_string("stipend to the 7702 EOA", stipendOk ? "accepted" : "out of gas");
    }

    /// P4.11 at the least gas a collect succeeds with (EIP-150 under this fork): `_notifyStream` requires
    /// STREAM_NOTIFY_GAS + STREAM_NOTIFY_GAS / 63 + 5,000 = 208,174 left (BoxReceiver.sol:105, :978-988), so even the
    /// cheapest successful collect hands the stream its whole 200,000 (less the stand-in's own first opcodes), and one
    /// gas less is refused with StreamGasTooLow, never a short notice.
    function testProperty_AUDIT_U4_streamWholeCapAtTheLeastGas() public {
        _toGraduated();
        uint256 tOut = _buy(eoa[3], 1 ether);
        _advance(1);
        _sell(eoa[3], tOut / 2);
        _advance(1);
        bytes memory code = a.itemStream.code;
        vm.etch(a.itemStream, address(new AuditU4ClaudeStreamStandIn(AuditU4ClaudeStreamStandIn.Mode.Accept)).code);
        uint256 least = _leastCollectGas();
        (bool ok, bytes memory ret) = a.receiver.call{gas: least - 1}(abi.encodeCall(IBoxReceiver.collect, (keeper)));
        assertFalse(ok, "one gas less is refused");
        assertEq(bytes4(ret), BoxReceiver.StreamGasTooLow.selector, "with StreamGasTooLow");
        uint256 e0 = keeper.balance;
        vm.recordLogs();
        (ok,) = a.receiver.call{gas: least}(abi.encodeCall(IBoxReceiver.collect, (keeper)));
        assertTrue(ok, "the least gas");
        _noteEthChange(e0, keeper.balance, EthIn.Other, EthOut.Tip);
        uint256 gasAtEntry = _notifiedGas(vm.getRecordedLogs());
        vm.etch(a.itemStream, code);
        emit log_named_string("evm", vm.getEvmVersion());
        emit log_named_uint("the least gas a collect with a stream notice succeeds with", least);
        emit log_named_uint("gas at the stream's entry at that gas", gasAtEntry);
        assertGe(gasAtEntry, 199_800, "the whole 200,000 even at the least gas");
        assertLe(gasAtEntry, 200_000);
        _assertGhostLedger();
    }

    /// P4.13 under this fork: one collect with three positions (Q and T fees, the stream's notice) and one with four
    /// (the pair added, executor and hook notes to return: pranked notes of 0.001 ETH each, standing in for their
    /// real sizes) stay below this fork's bound (Osaka 800,000 as the Gas suite pins; Amsterdam 1,600,000: its state
    /// access repricing about doubles a collect) and far below EIP-7825's 16,777,216 transaction cap.
    function testProperty_AUDIT_U4_collectGasUnderThisFork() public {
        _toGraduated();
        uint256 limit = _isAmsterdam() ? 1_600_000 : 800_000;
        uint256 snap = vm.snapshotState();
        _tradeBothSides(1 ether);
        uint256 gThree = _collectGas();
        vm.revertToState(snap);
        _makePair();
        _tradeBothSides(1 ether);
        vm.prank(a.executor);
        receiver.noteModuleFees(0.001 ether, 0);
        vm.prank(a.hook);
        receiver.noteModuleFees(0.001 ether, 0);
        uint256 gFour = _collectGas();
        emit log_named_string("evm", vm.getEvmVersion());
        emit log_named_uint("collect gas, three positions, stream notice", gThree);
        emit log_named_uint("collect gas, four positions, two notes returned, stream notice", gFour);
        assertLt(gThree, limit, "three positions within this fork's bound");
        assertLt(gFour, limit, "four positions within this fork's bound");
        assertLt(gFour, uint256(16_777_216) / 10, "a tenth of the EIP-7825 cap");
        _assertGhostLedger();
    }

    function _collectGas() internal returns (uint256 used) {
        uint256 e0 = keeper.balance;
        vm.prank(keeper);
        uint256 g0 = gasleft();
        receiver.collect(keeper);
        used = g0 - gasleft();
        _noteEthChange(e0, keeper.balance, EthIn.Other, EthOut.Tip);
    }

    function _leastCollectGas() internal returns (uint256 lo) {
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

    function _notifiedGas(VmSafe.Log[] memory logs) internal view returns (uint256 gasAtEntry) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == a.itemStream && logs[i].topics[0] == AuditU4ClaudeStreamStandIn.Notified.selector) {
                (gasAtEntry,) = abi.decode(logs[i].data, (uint256, bytes));
            }
        }
    }

    /// BC-143 under this fork: the late settlement (harness) costs far less than POKE_GAS.
    function testProperty_AUDIT_U4_settlementWithinPokeGasUnderThisFork() public {
        _toBonding();
        _fundFees(eoa[1], 30 ether);
        _batchOf(1 ether);
        _toGraduatedLate();
        uint256 g0 = gasleft();
        receiver.onGraduation();
        uint256 used = g0 - gasleft();
        emit log_named_uint("onGraduation gas", used);
        assertLt(used, 2_600_000 / 4, "a quarter of POKE_GAS");
    }
}

/// forge-config: default.evm_version = "amsterdam"
contract AuditU4ClaudeForkAmsterdamTest is AuditU4ClaudeForkTest {}
