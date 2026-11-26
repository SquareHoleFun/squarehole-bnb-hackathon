// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IBoxReceiver} from "../../../../src/box/interfaces/IBoxReceiver.sol";
import {EthOut} from "../common/AuditGhostLedger.sol";
import {AuditU4FableBase} from "./AuditU4FableBase.sol";

/// @notice SH-AUDIT-B0 U4 (Fable), lens L5 gas, liveness and bounded cost, under Osaka and Amsterdam: `collect`'s cost
/// is bounded whatever the ledgers hold (the harvest pokes at most four positions, the rest is constant work), a batch
/// below 0.005 ETH is the only reason a well-formed `collect` refuses in any phase, and the settlement fits the
/// coordinator's POKE_GAS with held parts and a stream notice.
abstract contract AuditU4FableGasBase is AuditU4FableBase {
    /// The bound stated for one `collect` on box 0 (harvest of up to 4 positions, one unlock, a burn or a stream notice
    /// of at most 200,000 gas), measured well below it under both EVMs.
    uint256 internal constant COLLECT_GAS_BOUND = 1_500_000;

    function _collectGas(address tipTo) internal returns (uint256 used) {
        uint256 e0 = tipTo.balance;
        vm.prank(keeper);
        uint256 g0 = gasleft();
        receiver.collect(tipTo);
        used = g0 - gasleft();
        _noteEthOut(EthOut.Tip, tipTo.balance - e0);
    }

    /// P4.13, BC-017, BC-018: `collect` costs the same order of gas on the curve, at the first graduated batch and
    /// after many batches with large ledgers and pending notes: no ledger size enters its cost.
    function testProperty_AUDIT_U4_collectGasIsBounded() public {
        _toBonding();
        _trade(eoa[3], 0.8 ether, 3_000);
        _advance(1);
        uint256 curve = _collectGas(keeper);
        _toGraduated();
        _trade(eoa[3], 0.8 ether, 3_000);
        _advance(1);
        uint256 first = _collectGas(keeper);
        for (uint256 i; i < 20; ++i) {
            _fundFees(eoa[i % 8], 30 ether);
            _trade(eoa[(i + 3) % 8], 0.8 ether, 3_000);
            _advance(1);
            _collect(keeper, keeper);
        }
        vm.prank(a.hook);
        receiver.noteModuleFees(1 ether, 0);
        vm.prank(a.executor);
        receiver.noteModuleFees(1 ether, 0);
        _trade(eoa[3], 0.8 ether, 3_000);
        _advance(1);
        uint256 late = _collectGas(eoa7702);
        emit log_named_string("evm", vm.getEvmVersion());
        emit log_named_uint("collect gas: curve batch", curve);
        emit log_named_uint("collect gas: first graduated batch", first);
        emit log_named_uint("collect gas: 22nd graduated batch, large ledgers, both notes pending", late);
        assertLt(curve, COLLECT_GAS_BOUND);
        assertLt(first, COLLECT_GAS_BOUND);
        assertLt(late, COLLECT_GAS_BOUND);
        assertLt(late, first + first / 2, "the 22nd batch costs no more than the first plus half");
        _assertGhostLedger();
    }

    /// P4.13, BC-017: in every phase a well-formed `collect` (enough gas, a recipient that takes ETH) either succeeds
    /// or reverts `BatchTooSmall`, and a gift of claims that brings the batch to the minimum makes it succeed.
    function testProperty_AUDIT_U4_onlyBatchTooSmallRefusesCollect() public {
        AuditPhase[5] memory phases =
            [AuditPhase.Created, AuditPhase.Window, AuditPhase.Bonding, AuditPhase.Closed, AuditPhase.Graduated];
        for (uint256 i; i < phases.length; ++i) {
            _toPhase(phases[i]);
            (bool ok, bytes memory ret) = _tryCollect();
            if (!ok) {
                assertEq(_selector(ret), IBoxReceiver.BatchTooSmall.selector, "the only refusal");
                (uint256 q, uint256 min) = abi.decode(_args(ret), (uint256, uint256));
                assertEq(min, BATCH_MIN);
                assertLt(q, BATCH_MIN);
                _mintClaimsTo(a.receiver, BATCH_MIN - q);
                (ok,) = _tryCollect();
                assertTrue(ok, "at the minimum it succeeds");
            }
            (uint256 uq,) = _unbooked();
            assertEq(uq, 0, "every claim booked");
        }
        _assertGhostLedger();
    }

    function _tryCollect() internal returns (bool ok, bytes memory ret) {
        uint256 e0 = keeper.balance;
        vm.prank(keeper);
        (ok, ret) = a.receiver.call(abi.encodeCall(IBoxReceiver.collect, (keeper)));
        if (ok) _noteEthOut(EthOut.Tip, keeper.balance - e0);
    }

    function _args(bytes memory ret) internal pure returns (bytes memory out) {
        out = new bytes(ret.length - 4);
        for (uint256 i; i < out.length; ++i) {
            out[i] = ret[i + 4];
        }
    }

    /// BC-143, BC-098: box 0's settlement, with held FIT, platform and depth parts and the final harvest's T to stream,
    /// fits the coordinator's POKE_GAS: the graduation poke succeeds, and after a failed poke a stranger's
    /// `onGraduation` with exactly POKE_GAS succeeds too.
    function testProperty_AUDIT_U4_settlementFitsPokeGas() public {
        _toBonding();
        _fundFees(eoa[0], 300 ether);
        _fundDepth(eoa[0], 1 ether);
        _trade(eoa[3], 0.8 ether, 5_000);
        _advance(1);
        uint256 closed = vm.snapshotState();
        _toGraduated();
        assertEq(graduationPokeFailures, 0, "every poke fit, the receiver's included");
        assertTrue(receiver.graduationSettled());
        vm.revertToState(closed);
        _graduateWithFailedReceiverPoke(keeper);
        uint256 pokeGas = coordinator.POKE_GAS();
        vm.prank(eoa[5]);
        uint256 g0 = gasleft();
        receiver.onGraduation{gas: pokeGas}();
        uint256 used = g0 - gasleft();
        emit log_named_string("evm", vm.getEvmVersion());
        emit log_named_uint("onGraduation gas with held parts and a stream notice", used);
        assertTrue(receiver.graduationSettled());
        assertLt(used, pokeGas);
        assertEq(receiver.platformOwed(), CAP, "the held 40 ETH capped at 32 in epoch 0");
        (uint256 dq, uint256 dt) = receiver.depthHeld();
        assertEq(dq | dt, 0, "held depth moved");
        _assertGhostLedger();
    }
}

/// forge-config: default.evm_version = "osaka"
contract AuditU4FableGasTest is AuditU4FableGasBase {}

/// forge-config: default.evm_version = "amsterdam"
contract AuditU4FableGasAmsterdamTest is AuditU4FableGasBase {}
