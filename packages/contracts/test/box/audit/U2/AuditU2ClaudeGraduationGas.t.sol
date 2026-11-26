// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IBoxCoordinator} from "../../../../src/box/interfaces/IBoxCoordinator.sol";
import {IBoxItemStream} from "../../../../src/box/interfaces/IBoxItemStream.sol";
import {IBoxReceiver} from "../../../../src/box/interfaces/IBoxReceiver.sol";
import {IBoxTickets} from "../../../../src/box/interfaces/IBoxTickets.sol";
import {AuditU2ClaudeBase, AuditU2ClaudeProbe} from "./AuditU2ClaudeBase.sol";

/// @notice P2.9 and P2.13 (BC-098; BoxCoordinator.sol:47-53, :105, :121, :286-291, :532-542; F95 R19M; F90 V3;
/// docs/runbooks/sepolia-core-v1.md:595-631): on the factory's box 0 at the close (the world's `_toClosed`, a fee batch
/// collected before it), `graduate()` is all or nothing at every caller gas limit: either it reverts and nothing of its
/// state moved (`_graduationDigest`), or it completes and each of the four pokes was given exactly `POKE_GAS`
/// (2,600,000), read from the CALL itself by a gas logger at each target, in the coordinator's order. The targets are
/// the real contracts behind a logger (`Real`), or stand-ins that revert, burn every unit of gas, return 1 MB, revert
/// with 1 MB, or re-enter `graduate`, `claimReward`, `collect` and `sweep` before running their real poke (`Reenter`;
/// the receiver stays real there, so the re-entries run after its settlement). Each mode runs under Osaka and
/// Amsterdam. `least` is the least gas to the unit (binary search, every probe in a rolled-back snapshot); the fuzz
/// draws limits over [least − 3 × POKE_GAS, least + 3 × POKE_GAS]; the fine steps probe ±1, ±2, ±63, ±64, ±65, ±1,000
/// and ±10,000 around it. P2.13: the least and the gas used with every poke exhausting its budget stay below EIP-7825's
/// 16,777,216 with the margin logged (`U2C|` lines). The `FirstBatch` variants close without any fee batch collected
/// before (one placeholder taken, then a single closing buy after the window), so the migration's last harvest and
/// the receiver's settlement carry the curve's whole first batch: the runbook's heaviest path.
abstract contract AuditU2ClaudeGraduationGasBase is AuditU2ClaudeBase {
    enum Mode {
        Real,
        Revert,
        BurnAll,
        ReturnBomb,
        RevertBomb,
        Reenter
    }

    uint256 internal least;
    bytes32 internal digestBefore;

    function _mode() internal pure virtual returns (Mode);

    /// @dev The close: the world's (a fee batch collected in bonding), or the first batch final.
    function _firstBatch() internal pure virtual returns (bool) {
        return false;
    }

    /// @dev With the first batch final: the closing buy runs past P1 to the lowest price (an exact-input overshoot, as
    /// the Universal Router's can), so the migration walks the price back across every empty tick (BC-025).
    function _overshoot() internal pure virtual returns (bool) {
        return false;
    }

    function setUp() public virtual override {
        super.setUp();
        if (_firstBatch()) {
            _warpTo(hook.windowEndsAt());
            _buy(eoa[0], 0.5 ether);
            _take(eoa[0], 1);
            _closeWith(eoa[2], 3 * raise, _overshoot() ? _minLimit() : _p1());
            if (_overshoot()) require(_sqrtP() == _minLimit(), "the overshoot ran to the lowest price");
        } else {
            _toClosed();
        }
        // The world graduates here (AuditPhases._toGraduated): a request now fixes round r0.
        _warpTo(_requestTimeFor(r0));
        Mode m = _mode();
        for (uint256 i; i < 4; ++i) {
            if (m == Mode.Real) _etchLoggedReal(i);
            else if (m == Mode.Revert) _etchHostile(i, HostileMode.Revert);
            else if (m == Mode.BurnAll) _etchHostile(i, HostileMode.BurnAll);
            else if (m == Mode.ReturnBomb) _etchHostile(i, HostileMode.ReturnBomb);
            else if (m == Mode.RevertBomb) _etchHostile(i, HostileMode.RevertBomb);
            else if (i == 0) _etchLoggedReal(i);
            else _etchReenter(i);
        }
        digestBefore = _graduationDigest();
        least = _leastGraduateGas(keeper, POKE_FLOOR, 40_000_000);
    }

    function _expectedFailures() internal pure virtual returns (uint256) {
        Mode m = _mode();
        return m == Mode.Revert || m == Mode.BurnAll || m == Mode.RevertBomb ? 4 : 0;
    }

    /// The outcome at one gas limit: success with four exact budgets and the mode's effects, or a revert that left the
    /// state as it was.
    function _checkProbe(AuditU2ClaudeProbe memory p, uint256 gasLimit) internal view {
        if (gasLimit >= least) {
            assertTrue(p.ok, "at or above the least gas graduate() completes");
            _checkComplete(p);
        } else {
            assertFalse(p.ok, "below the least gas graduate() reverts");
            assertEq(p.digest, digestBefore, "a refused graduate() changed nothing");
            assertFalse(coordinator.graduated(), "not graduated after the rollback");
        }
    }

    function _checkComplete(AuditU2ClaudeProbe memory p) internal view {
        assertTrue(p.graduated, "graduated");
        for (uint256 i; i < 4; ++i) {
            assertEq(p.givenTo[i], pokeTargets[i], "the pokes in the coordinator's order");
            assertEq(p.given[i], POKE_GAS, "each poke is given exactly POKE_GAS");
        }
        assertEq(p.pokeFailures, _expectedFailures(), "PokeFailed exactly for the failing targets");
        assertEq(p.reward, coordinator.raise() / 1000, "the reward is the cap (0.1% of R)");
        Mode m = _mode();
        if (m == Mode.Real || m == Mode.Reenter) {
            assertTrue(p.settled, "the receiver settled");
            assertTrue(p.wordRequested, "the graduation word was requested");
            assertTrue(p.executorGraduated, "FIT's executor sees the graduation");
            assertTrue(p.streamStarted, "the stream started");
        }
        if (hostileTargets) {
            // F126: the stream's baseline was written before any poke: with the receiver and the stream hostile nothing
            // after the migration moved either balance, so the baseline equals them.
            assertEq(p.baselineClaims, p.receiverTClaims, "baseline: the receiver's T claims after the migration");
            assertEq(p.baselineBalance, p.streamT, "baseline: the stream's T after the migration");
            // The world's bonding sold T, so its curve holds T fees; the first-batch close only bought.
            if (!_firstBatch()) assertGt(p.baselineClaims, 0, "the curve's T fees were there");
        }
        if (m == Mode.Reenter) {
            assertEq(p.reentries, 12, "three targets tried four calls each");
            assertEq(p.reentriesRefusedByLock, 6, "graduate and claimReward refused by the coordinator's lock");
        }
    }

    function testProperty_AUDIT_U2_leastGasGivesEveryPokeItsWholeBudget() public {
        AuditU2ClaudeProbe memory at = _probe(keeper, least);
        _checkProbe(at, least);
        AuditU2ClaudeProbe memory below = _probe(keeper, least - 1);
        _checkProbe(below, least - 1);
        assertEq(bytes4(below.err), IBoxCoordinator.GasTooLow.selector, "one gas less: GasTooLow");
        (, uint256 required) = abi.decode(_tailOf(below.err), (uint256, uint256));
        assertEq(required, POKE_FLOOR, "GasTooLow names the floor 2,651,269");
        emit log_named_string("U2C|mode|evm", string.concat(_modeName(), "|", vm.getEvmVersion()));
        emit log_named_uint("U2C|least call gas", least);
        emit log_named_uint("U2C|gas used at the least (this frame's view)", at.used);
        emit log_named_uint("U2C|least plus 21,064 intrinsic", least + 21_064);
        emit log_named_uint("U2C|margin to EIP-7825 (least + intrinsic)", TX_GAS_CAP - (least + 21_064));
        assertLt(least + 21_064, TX_GAS_CAP, "P2.13: the least transaction fits EIP-7825");
    }

    function testProperty_AUDIT_U2_fineStepsAroundTheLeastGas() public {
        uint256[7] memory d = [uint256(1), 2, 63, 64, 65, 1_000, 10_000];
        for (uint256 i; i < d.length; ++i) {
            _checkProbe(_probe(keeper, least - d[i]), least - d[i]);
            _checkProbe(_probe(keeper, least + d[i]), least + d[i]);
        }
    }

    function testFuzz_AUDIT_U2_everyGasLimitIsAllOrNothing(uint256 seed) public {
        uint256 lo = least > 3 * POKE_GAS + POKE_FLOOR ? least - 3 * POKE_GAS : POKE_FLOOR;
        uint256 g = bound(seed, lo, least + 3 * POKE_GAS);
        _checkProbe(_probe(keeper, g), g);
    }

    function _tailOf(bytes memory err) internal pure returns (bytes memory t) {
        t = new bytes(err.length - 4);
        for (uint256 i; i < t.length; ++i) {
            t[i] = err[i + 4];
        }
    }

    function _modeName() internal pure returns (string memory) {
        Mode m = _mode();
        if (m == Mode.Real && _overshoot()) return "real targets, first batch final, overshoot to the lowest price";
        if (m == Mode.BurnAll && _overshoot()) {
            return "all four burn every unit of gas, first batch final, overshoot to the lowest price";
        }
        if (m == Mode.Real) return _firstBatch() ? "real targets, first batch final" : "real targets";
        if (m == Mode.BurnAll && _firstBatch()) return "all four burn every unit of gas, first batch final";
        if (m == Mode.Revert) return "all four revert";
        if (m == Mode.BurnAll) return "all four burn every unit of gas";
        if (m == Mode.ReturnBomb) return "all four return 1 MB";
        if (m == Mode.RevertBomb) return "all four revert with 1 MB";
        return "tickets, executor and stream re-enter";
    }
}

/// forge-config: default.evm_version = "osaka"
contract AuditU2ClaudeGraduationGasRealTest is AuditU2ClaudeGraduationGasBase {
    function _mode() internal pure override returns (Mode) {
        return Mode.Real;
    }
}

/// forge-config: default.evm_version = "amsterdam"
contract AuditU2ClaudeGraduationGasRealAmsterdamTest is AuditU2ClaudeGraduationGasRealTest {}

/// forge-config: default.evm_version = "osaka"
contract AuditU2ClaudeGraduationGasRevertTest is AuditU2ClaudeGraduationGasBase {
    function _mode() internal pure override returns (Mode) {
        return Mode.Revert;
    }
}

/// forge-config: default.evm_version = "amsterdam"
contract AuditU2ClaudeGraduationGasRevertAmsterdamTest is AuditU2ClaudeGraduationGasRevertTest {}

/// forge-config: default.evm_version = "osaka"
contract AuditU2ClaudeGraduationGasBurnAllTest is AuditU2ClaudeGraduationGasBase {
    function _mode() internal pure override returns (Mode) {
        return Mode.BurnAll;
    }
}

/// forge-config: default.evm_version = "amsterdam"
contract AuditU2ClaudeGraduationGasBurnAllAmsterdamTest is AuditU2ClaudeGraduationGasBurnAllTest {}

/// forge-config: default.evm_version = "osaka"
contract AuditU2ClaudeGraduationGasReturnBombTest is AuditU2ClaudeGraduationGasBase {
    function _mode() internal pure override returns (Mode) {
        return Mode.ReturnBomb;
    }
}

/// forge-config: default.evm_version = "amsterdam"
contract AuditU2ClaudeGraduationGasReturnBombAmsterdamTest is AuditU2ClaudeGraduationGasReturnBombTest {}

/// forge-config: default.evm_version = "osaka"
contract AuditU2ClaudeGraduationGasRevertBombTest is AuditU2ClaudeGraduationGasBase {
    function _mode() internal pure override returns (Mode) {
        return Mode.RevertBomb;
    }
}

/// forge-config: default.evm_version = "amsterdam"
contract AuditU2ClaudeGraduationGasRevertBombAmsterdamTest is AuditU2ClaudeGraduationGasRevertBombTest {}

/// forge-config: default.evm_version = "osaka"
contract AuditU2ClaudeGraduationGasReenterTest is AuditU2ClaudeGraduationGasBase {
    function _mode() internal pure override returns (Mode) {
        return Mode.Reenter;
    }
}

/// forge-config: default.evm_version = "amsterdam"
contract AuditU2ClaudeGraduationGasReenterAmsterdamTest is AuditU2ClaudeGraduationGasReenterTest {}

/// forge-config: default.evm_version = "osaka"
contract AuditU2ClaudeGraduationGasRealFirstBatchTest is AuditU2ClaudeGraduationGasBase {
    function _mode() internal pure override returns (Mode) {
        return Mode.Real;
    }

    function _firstBatch() internal pure override returns (bool) {
        return true;
    }
}

/// forge-config: default.evm_version = "amsterdam"
contract AuditU2ClaudeGraduationGasRealFirstBatchAmsterdamTest is AuditU2ClaudeGraduationGasRealFirstBatchTest {}

/// forge-config: default.evm_version = "osaka"
contract AuditU2ClaudeGraduationGasBurnAllFirstBatchTest is AuditU2ClaudeGraduationGasBase {
    function _mode() internal pure override returns (Mode) {
        return Mode.BurnAll;
    }

    function _firstBatch() internal pure override returns (bool) {
        return true;
    }
}

/// forge-config: default.evm_version = "amsterdam"
contract AuditU2ClaudeGraduationGasBurnAllFirstBatchAmsterdamTest is AuditU2ClaudeGraduationGasBurnAllFirstBatchTest {}

/// @notice The real targets with the first batch final and the closing buy overshooting to the lowest price.
/// forge-config: default.evm_version = "osaka"
contract AuditU2ClaudeGraduationGasRealOvershootTest is AuditU2ClaudeGraduationGasRealFirstBatchTest {
    function _overshoot() internal pure override returns (bool) {
        return true;
    }
}

/// forge-config: default.evm_version = "amsterdam"
contract AuditU2ClaudeGraduationGasRealOvershootAmsterdamTest is AuditU2ClaudeGraduationGasRealOvershootTest {}

/// @notice P2.13's worst case: every poke burns its whole budget, the first batch is final and the migration walks
/// the price back from the lowest price.
/// forge-config: default.evm_version = "osaka"
contract AuditU2ClaudeGraduationGasBurnAllOvershootTest is AuditU2ClaudeGraduationGasBurnAllFirstBatchTest {
    function _overshoot() internal pure override returns (bool) {
        return true;
    }
}

/// forge-config: default.evm_version = "amsterdam"
contract AuditU2ClaudeGraduationGasBurnAllOvershootAmsterdamTest is AuditU2ClaudeGraduationGasBurnAllOvershootTest {}

/// @notice M21 holds (money review 2026-10-09; BoxCoordinator.sol:51: "a failure is logged (`PokeFailed`) and anyone
/// repeats the poke later"): graduation with all four poke targets reverting completes, credits the reward once and
/// leaves every follow-up undone; with the targets' code back, anyone runs each follow-up once (a second run of the
/// receiver's, the tickets' and the stream's is refused), the reward is still credited once and pulled once.
/// forge-config: default.evm_version = "osaka"
contract AuditU2ClaudePokeRetryTest is AuditU2ClaudeBase {
    function testProperty_AUDIT_U2_failedPokesAreRetriedOnceByAnyone() public {
        _toClosed();
        _warpTo(_requestTimeFor(r0));
        bytes[4] memory original;
        for (uint256 i; i < 4; ++i) {
            original[i] = pokeTargets[i].code;
            _etchHostile(i, HostileMode.Revert);
        }
        (uint256 reward, uint256 failures) = _graduate(keeper);
        assertEq(failures, 4, "every follow-up failed");
        assertTrue(coordinator.graduated() && vault.gateOpen(), "graduation and the gate are committed");
        assertEq(coordinator.rewardOf(keeper), reward);
        for (uint256 i; i < 4; ++i) {
            vm.etch(pokeTargets[i], original[i]);
        }
        hostileTargets = false;
        assertFalse(receiver.graduationSettled());
        assertFalse(stream.started());
        assertEq(tickets.status().wordRequestedAt, 0);
        vm.startPrank(eoa[5]);
        receiver.onGraduation();
        vm.expectRevert(IBoxReceiver.AlreadySettled.selector);
        receiver.onGraduation();
        tickets.requestGraduationWord();
        vm.expectRevert(IBoxTickets.WordAlreadyRequested.selector);
        tickets.requestGraduationWord();
        executor.poke();
        stream.onGraduation();
        vm.expectRevert(IBoxItemStream.AlreadyStarted.selector);
        stream.onGraduation();
        vm.expectRevert(IBoxCoordinator.AlreadyGraduated.selector);
        coordinator.graduate();
        vm.stopPrank();
        assertTrue(receiver.graduationSettled() && stream.started() && executor.fitGraduated());
        assertEq(coordinator.rewardOf(keeper), reward, "the reward credited once, unchanged by the retries");
        assertEq(_claimReward(keeper, keeper), reward);
        vm.prank(keeper);
        vm.expectRevert(IBoxCoordinator.NothingToClaim.selector);
        coordinator.claimReward(keeper);
        _assertGhostLedger();
    }
}

/// forge-config: default.evm_version = "amsterdam"
contract AuditU2ClaudePokeRetryAmsterdamTest is AuditU2ClaudePokeRetryTest {}
