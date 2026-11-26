// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {AuditU4LaneBase} from "./AuditU4LaneBase.sol";
import {AuditU4LaneHostile, AuditU4LaneStipendPayer} from "./AuditU4LaneCallees.sol";
import {IBoxReceiver} from "../../../../src/box/interfaces/IBoxReceiver.sol";

/// @notice Callee substitutions only: real factory receiver, both halves and the PoolManager remain unchanged.
abstract contract AuditU4LaneGasCases is AuditU4LaneBase {
    /// @notice Ticket 11 / BC-139: reverting and gas-exhausting stream receives T; collect succeeds and emits failure.
    /// The only stand-in is onStreamFunds at the already-settled stream address.
    function testProperty_AUDIT_U4_streamFailureCannotBlockAccounting() public {
        _graduate();
        uint256 streamed = token.balanceOf(a.itemStream);
        for (uint256 mode; mode < 2; ++mode) {
            AuditU4LaneHostile hostile = new AuditU4LaneHostile(mode == 1);
            vm.etch(a.itemStream, address(hostile).code);
            _q(0.01 ether);
            _t(150);
            vm.recordLogs();
            uint256 before = gasleft();
            r.collect{gas: 1_500_000}(tipper);
            uint256 used = before - gasleft();
            assertLt(used, 1_000_000, "bounded even when stream consumes 200k");
            emit log_named_uint(mode == 0 ? "stream reverting collect gas" : "stream exhausting collect gas", used);
            Vm.Log[] memory logs = vm.getRecordedLogs();
            bool failed;
            for (uint256 i; i < logs.length; ++i) {
                if (logs[i].emitter == a.receiver && logs[i].topics[0] == IBoxReceiver.StreamNotifyFailed.selector) {
                    assertEq(abi.decode(logs[i].data, (uint256)), 130);
                    failed = true;
                }
            }
            assertTrue(failed);
            streamed += 130;
            assertEq(token.balanceOf(a.itemStream), streamed);
            _balanced();
            (uint256 qb, uint256 tb) = r.booked();
            assertEq(pm.balanceOf(a.receiver, 0), qb);
            assertEq(pm.balanceOf(a.receiver, uint256(uint160(a.token))), tb);
        }
    }

    /// @notice BC-021, accepted M22: etched fixed Safe refuses ETH; only payPlatform rolls back.
    function testProperty_AUDIT_U4_hostileSafeKeepsOwnCreditOnly() public {
        _graduate();
        r.fundFees{value: 15 ether}();
        bytes memory originalCode = a.platform.code;
        for (uint256 mode; mode < 2; ++mode) {
            AuditU4LaneHostile hostile = new AuditU4LaneHostile(mode == 1);
            vm.etch(a.platform, address(hostile).code);
            uint256 owed = r.platformOwed();
            uint256 claims = pm.balanceOf(a.receiver, 0);
            (bool ok,) = a.receiver.call{gas: 1_000_000}(abi.encodeCall(IBoxReceiver.payPlatform, ()));
            assertFalse(ok);
            assertEq(r.platformOwed(), owed);
            assertEq(pm.balanceOf(a.receiver, 0), claims);
            r.fundFees{value: 15}();
            r.fundDepth{value: 15}();
            _q(0.01 ether);
            _t(150);
            r.collect(tipper);
            assertGt(r.payFit(), 0);
            _balanced();
        }
        vm.etch(a.platform, originalCode);
        uint256 safe = a.platform.balance;
        uint256 owed = r.platformOwed();
        assertEq(r.payPlatform(), owed);
        assertEq(a.platform.balance - safe, owed);
    }

    /// @notice BC-017/021: a hostile caller-selected tipper can only roll back that collect, preserving all claims.
    /// This regression pins existing isolation; proof 53 separately records the stronger ticket 12/13 mismatch.
    function testProperty_AUDIT_U4_hostileTipPreservesRetryAndOtherFunctions() public {
        _graduate();
        for (uint256 mode; mode < 2; ++mode) {
            AuditU4LaneHostile hostile = new AuditU4LaneHostile(mode == 1);
            _q(0.01 ether);
            _t(150);
            uint256 q = pm.balanceOf(a.receiver, 0);
            uint256 t = pm.balanceOf(a.receiver, uint256(uint160(a.token)));
            bytes32 total = keccak256(abi.encode(_totals()));
            (bool ok,) = a.receiver.call{gas: 1_000_000}(abi.encodeCall(IBoxReceiver.collect, (address(hostile))));
            assertFalse(ok);
            assertEq(pm.balanceOf(a.receiver, 0), q);
            assertEq(pm.balanceOf(a.receiver, uint256(uint160(a.token))), t);
            assertEq(keccak256(abi.encode(_totals())), total);
            r.fundFees{value: 15}();
            r.fundDepth{value: 15}();
            r.payFit();
            r.payPlatform();
            r.collect(tipper);
            _balanced();
        }
    }

    /// @notice Ticket 13 / BC-017: fixed ledger layout; cold collect metered at small, 2^120 and 2^126 fee volume.
    /// This bounds the tested valid-state gas, not arbitrary caller gas or malicious recipient execution.
    function testProperty_AUDIT_U4_collectGasIndependentOfLedgerMagnitude() public {
        _graduate();
        uint256[3] memory sizes = [uint256(15), uint256(1) << 120, uint256(1) << 126];
        uint256 first;
        for (uint256 i; i < sizes.length; ++i) {
            vm.deal(address(this), sizes[i] + 1 ether);
            r.fundFees{value: sizes[i]}();
            _q(0.01 ether);
            _t(150);
            vm.cool(a.receiver);
            vm.cool(a.hook);
            vm.cool(a.poolManager);
            vm.cool(a.itemStream);
            vm.cool(a.token);
            vm.cool(a.coordinator);
            uint256 before = gasleft();
            r.collect{gas: 1_500_000}(tipper);
            uint256 used = before - gasleft();
            assertLt(used, 1_000_000);
            if (i == 0) first = used;
            else assertLe(used, first + 100_000, "no growth with numeric ledger size");
            emit log_named_uint("cold collect gas", used);
            _balanced();
        }
    }

    /// @notice BC-114: empty-calldata 2,300-gas receipt is independent of the cold delegatecall cost on either fork.
    function testProperty_AUDIT_U4_coldStipendReceipt() public {
        AuditU4LaneStipendPayer payer = new AuditU4LaneStipendPayer();
        vm.deal(address(payer), 1);
        vm.cool(a.royaltyRouter);
        payer.pay(payable(a.royaltyRouter), 1);
        vm.cool(a.royaltyRouter);
        payer.pay(payable(a.royaltyRouter), 0);
        assertEq(a.royaltyRouter.balance, 1);
    }
}

/// forge-config: default.evm_version = "osaka"
contract AuditU4LaneGasOsaka is AuditU4LaneGasCases {}

/// forge-config: default.evm_version = "amsterdam"
contract AuditU4LaneGasAmsterdam is AuditU4LaneGasCases {}
