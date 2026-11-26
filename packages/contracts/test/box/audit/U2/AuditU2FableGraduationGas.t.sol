// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VmSafe} from "forge-std/Vm.sol";
import {IBoxCoordinator} from "../../../../src/box/interfaces/IBoxCoordinator.sol";
import {IBoxLaunchRouter} from "../../../../src/box/interfaces/IBoxLaunchRouter.sol";
import {TransientReentrancyGuard} from "../../../../src/libraries/TransientReentrancyGuard.sol";
import {AuditU2FableBase, AuditU2FableHostilePoke} from "./AuditU2FableBase.sol";

/// @title AuditU2FableGraduationGasTest
/// @notice SH-AUDIT-B0-U2-F, P2.9 and P2.13 on the factory's box 0 at the close: graduation is all-or-nothing at every
/// caller gas cap (below the least gas it reverts and changes nothing; from it on it completes and each of the four
/// pokes was given exactly POKE_GAS), with the poke targets replaced by code that logs its gas, reverts, uses every
/// unit of gas, re-enters `graduate`, `claimReward`, `collect`, `sweep` and `buy`, returns 1 MB or reverts with 1
/// MB; the worst case (four pokes using their whole budget) stays below EIP-7825's cap. The budgets are measured, not
/// inferred: the stand-ins log `gas()` and the dispatcher's cost is calibrated. `AuditU2FableGraduationGasAmsterdamTest`
/// runs it all under Amsterdam.
/// forge-config: default.evm_version = "osaka"
contract AuditU2FableGraduationGasTest is AuditU2FableBase {
    uint256 internal constant AMPLE = 15_500_000;

    function setUp() public override {
        super.setUp();
        _toClosed();
    }

    // ============================================================================================ exact budgets

    /// P2.9 / BC-098 / F95 R19M: with a gas logger at every poke target, at the least gas that graduates and at caps
    /// above it (up to the least + 3 x POKE_GAS) every poke receives exactly 2,600,000; one gas less reverts GasTooLow
    /// naming the floor 2,651,269; below the least every cap fails and nothing changes.
    function testProperty_AUDIT_U2_eachPokeGetsExactlyPokeGasAtEveryCapThatGraduates() public {
        _etchPokeTargets(GAS_LOGGER);
        _sweep(0, 0, "gas logger");
    }

    /// P2.9: four poke targets that revert.
    function testProperty_AUDIT_U2_allOrNothingWithRevertingPokes() public {
        _hostileSweep(AuditU2FableHostilePoke.Mode.Revert, 4);
    }

    /// P2.9: four poke targets that use every unit of gas (the most expensive graduation there is).
    function testProperty_AUDIT_U2_allOrNothingWithGasBurningPokes() public {
        _hostileSweep(AuditU2FableHostilePoke.Mode.BurnGas, 4);
    }

    /// P2.9: four poke targets that re-enter `graduate` and `claimReward` (the lock), `collect`, `sweep` and `buy`.
    function testProperty_AUDIT_U2_allOrNothingWithReenteringPokes() public {
        _hostileSweep(AuditU2FableHostilePoke.Mode.Reenter, 0);
    }

    /// P2.9: four poke targets that return 1 MB (no return data is copied: no return bomb).
    function testProperty_AUDIT_U2_allOrNothingWithReturnBombPokes() public {
        _hostileSweep(AuditU2FableHostilePoke.Mode.ReturnBomb, 0);
    }

    /// P2.9: four poke targets that revert with 1 MB.
    function testProperty_AUDIT_U2_allOrNothingWithRevertBombPokes() public {
        _hostileSweep(AuditU2FableHostilePoke.Mode.RevertBomb, 4);
    }

    function _hostileSweep(AuditU2FableHostilePoke.Mode mode, uint256 expectedFailures) internal {
        bytes memory code = _hostileCode(mode);
        uint256 overhead = _hostileOverhead(code);
        _etchPokeTargets(code);
        _sweep(overhead, expectedFailures, vm.toString(uint256(mode)));
    }

    /// The sweep: the least gas by bisection, then caps around and above it.
    function _sweep(uint256 overhead, uint256 expectedFailures, string memory label) internal {
        uint256 least = _leastGraduate(keeper, AMPLE, overhead);
        emit log_named_string("stand-in", label);
        emit log_named_uint("least gas cap that graduates", least);
        Probe memory below = _probe(keeper, least - 1, overhead);
        assertFalse(below.ok, "one gas less fails");
        assertEq(_selector(below.err), IBoxCoordinator.GasTooLow.selector, "refused at a poke's floor");
        (uint256 left, uint256 required) = _gasArgs(below.err);
        assertEq(required, POKE_FLOOR, "naming the floor 2,651,269");
        assertLt(left, required);
        assertFalse(coordinator.graduated(), "nothing changed");
        // Below the least: a spread of caps from the first floor up; each fails, and never by a poke running short.
        uint256[6] memory under =
            [uint256(POKE_FLOOR), POKE_FLOOR + 200_000, least / 2, least * 3 / 4, least - 7, least - 1];
        for (uint256 i; i < under.length; ++i) {
            if (under[i] >= least) continue;
            Probe memory p = _probe(keeper, under[i], overhead);
            assertFalse(p.ok, "below the least: refused");
            _noShortPoke(p);
        }
        // At the least and above it: completes, four pokes seen, each given exactly POKE_GAS.
        uint256[9] memory over = [
            least,
            least + 1,
            least + 777,
            least + POKE_GAS / 2,
            least + POKE_GAS,
            least + POKE_GAS + 123_456,
            least + 2 * POKE_GAS,
            least + 3 * POKE_GAS,
            AMPLE
        ];
        for (uint256 i; i < over.length; ++i) {
            Probe memory p = _probe(keeper, over[i], overhead);
            assertTrue(p.ok, "from the least on: graduates");
            assertEq(p.pokeLogs, 4, "every poke reached its target");
            for (uint256 j; j < 4; ++j) {
                assertTrue(p.seen[j]);
                assertEq(p.given[j], POKE_GAS, "each poke receives exactly POKE_GAS");
            }
            assertEq(p.pokeFailed, expectedFailures, "PokeFailed exactly when the stand-in failed");
        }
    }

    /// A failed probe never came from a poke that was given less than POKE_GAS: either no poke ran (the gas ran out
    /// before the first floor, or a floor refused) or every poke that ran had its full budget.
    function _noShortPoke(Probe memory p) internal pure {
        for (uint256 j; j < 4; ++j) {
            if (p.seen[j]) assertEq(p.given[j], POKE_GAS, "a poke that ran had its whole budget");
        }
    }

    // ============================================================================================ re-entries

    /// P2.9 / L3: what re-entering pokes get: `graduate` and `claimReward` the lock's Reentrancy, `sweep` passes once
    /// the hook migrated (the tax becomes the hook's claims inside the poke; later ones find nothing), `buy` is
    /// refused (the curve is closed), `collect` on the real receiver's address runs or is refused by the batch
    /// minimum but never breaks graduation. Graduation completes with no failed poke.
    function testProperty_AUDIT_U2_reenteringPokesMeetTheLockAndGraduationCompletes() public {
        _etchPokeTargets(_hostileCode(AuditU2FableHostilePoke.Mode.Reenter));
        uint256 tax = a.launchRouter.balance;
        uint256 h0 = _claims(a.hook);
        vm.recordLogs();
        vm.prank(keeper);
        coordinator.graduate{gas: AMPLE}();
        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        uint256 grad;
        uint256 claim;
        uint256 sweeps;
        uint256 sweepOk;
        uint256 buys;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics.length == 0 || logs[i].topics[0] != AuditU2FableHostilePoke.Reentry.selector) continue;
            (bytes4 call_, bool ok, bytes4 err) = abi.decode(logs[i].data, (bytes4, bool, bytes4));
            if (call_ == IBoxCoordinator.graduate.selector) {
                ++grad;
                assertFalse(ok);
                assertEq(err, TransientReentrancyGuard.Reentrancy.selector, "graduate re-entry: the lock");
            } else if (call_ == IBoxCoordinator.claimReward.selector) {
                ++claim;
                assertFalse(ok);
                assertEq(err, TransientReentrancyGuard.Reentrancy.selector, "claimReward re-entry: the lock");
            } else if (call_ == IBoxLaunchRouter.sweep.selector) {
                ++sweeps;
                if (ok) ++sweepOk;
                else assertEq(err, IBoxLaunchRouter.NothingToSweep.selector, "later sweeps find nothing");
            } else if (call_ == IBoxLaunchRouter.buy.selector) {
                ++buys;
                assertFalse(ok, "no buy after the close");
            }
        }
        // Four pokes re-enter; three of them also call `collect` on the (hostile) receiver, whose fallback re-enters
        // once more: 4 + 3 of each call.
        assertEq(grad, 7);
        assertEq(claim, 7);
        assertEq(sweeps, 7);
        assertEq(sweepOk, 1, "the first poke's sweep moved the tax (the hook had migrated)");
        assertEq(buys, 7);
        assertTrue(coordinator.graduated());
        assertEq(a.launchRouter.balance, 0);
        assertEq(_claims(a.hook), h0 + tax, "the tax is the hook's depth budget");
        assertEq(coordinator.rewardOf(keeper), coordinator.rewardCap());
    }

    // ============================================================================================ the cap

    /// P2.13 / F90 V3 / EIP-7825: with four gas-burning pokes (each using its whole 2,600,000), the least transaction
    /// that graduates and the most execution gas it can use both fit the 16,777,216 cap; the margin is logged.
    function testProperty_AUDIT_U2_worstCaseGraduateFitsTheTransactionCap() public {
        bytes memory code = _hostileCode(AuditU2FableHostilePoke.Mode.BurnGas);
        uint256 overhead = _hostileOverhead(code);
        _etchPokeTargets(code);
        uint256 intrinsic = 21_000 + 4 * 16;
        uint256 least = _leastGraduate(keeper, AMPLE, overhead);
        uint256 snap = vm.snapshotState();
        uint256 g0 = gasleft();
        vm.prank(keeper);
        (bool ok,) = a.coordinator.call{gas: AMPLE}(abi.encodeCall(IBoxCoordinator.graduate, ()));
        uint256 used = g0 - gasleft();
        vm.revertToState(snap);
        assertTrue(ok);
        assertGe(used, 4 * POKE_GAS, "four whole budgets burned");
        assertLe(least + intrinsic, TX_GAS_CAP, "the least transaction fits the cap");
        assertLe(used + intrinsic, TX_GAS_CAP, "the most execution gas fits the cap");
        emit log_named_string("evm", vm.getEvmVersion());
        emit log_named_uint("worst case: least gas cap", least);
        emit log_named_uint("worst case: gas used at an ample cap", used);
        emit log_named_uint("margin below the EIP-7825 cap (used + intrinsic)", TX_GAS_CAP - used - intrinsic);
    }

    // ============================================================================================ one hostile

    /// P2.9 / BC-098: one hostile target at a time (the other three real): graduation completes; `PokeFailed` names
    /// the hostile poke exactly when it fails (a hostile receiver also fails the real stream's poke, which reads the
    /// receiver); the real pokes did their work.
    function testProperty_AUDIT_U2_oneHostileTargetNeverStopsTheOthers() public {
        address[4] memory t = _pokeTargets();
        AuditU2FableHostilePoke.Mode[4] memory modes = [
            AuditU2FableHostilePoke.Mode.Revert,
            AuditU2FableHostilePoke.Mode.BurnGas,
            AuditU2FableHostilePoke.Mode.ReturnBomb,
            AuditU2FableHostilePoke.Mode.RevertBomb
        ];
        for (uint256 j; j < 4; ++j) {
            for (uint256 k; k < 4; ++k) {
                uint256 snap = vm.snapshotState();
                vm.etch(t[j], _hostileCode(modes[k]));
                bool fails = modes[k] != AuditU2FableHostilePoke.Mode.ReturnBomb;
                vm.recordLogs();
                vm.prank(keeper);
                coordinator.graduate{gas: AMPLE}();
                (uint256 failures,,) = _parseGraduation(vm.getRecordedLogs());
                uint256 expected = (fails ? 1 : 0) + (j == 0 ? 1 : 0);
                assertEq(failures, expected, "PokeFailed count");
                assertTrue(coordinator.graduated());
                if (j != 0) assertTrue(receiver.graduationSettled(), "the real receiver settled");
                if (j != 0 && j != 3) assertTrue(stream.started(), "the real stream started");
                if (j != 1) assertGt(tickets.status().wordRequestedAt, 0, "the real tickets requested the word");
                assertEq(coordinator.rewardOf(keeper), coordinator.rewardCap());
                vm.revertToState(snap);
            }
        }
    }
}

/// The same under Amsterdam (Glamsterdam's repricing changes the base cost, never a poke's budget).
/// forge-config: default.evm_version = "amsterdam"
contract AuditU2FableGraduationGasAmsterdamTest is AuditU2FableGraduationGasTest {}
