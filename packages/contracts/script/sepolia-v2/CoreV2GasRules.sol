// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CommonBase} from "forge-std/Base.sol";
import {IVmFrameGasV2} from "../lib/CoreV2GasMeter.sol";

/// @title CoreV2GasRules (ticket M1-64)
/// @notice `DeployCoreV1`'s EIP-8037 and EIP-7825 rules (which see for each value and its source), shared by every v2
/// script that sends: `DeployCoreV2` and `DeploySepoliaV2TestSet` (review round 1: the seed's pools are the run's
/// heaviest transactions). forge sets each transaction's limit from its own simulation, so after Sepolia's Glamsterdam
/// (2026-10-06 13:53:36 UTC) the simulation must charge EIP-8037's state gas (`--hardfork amsterdam`;
/// `GlamsterdamNotSimulated`), before it must not (`GlamsterdamSimulatedBeforeFork`), and no Sepolia run starts in its
/// last hour (`GlamsterdamTooClose`); on mainnet forge's EVM must charge a code byte what the chain's RPC estimate does
/// (`ChainRulesNotSimulated`). Every transaction's execution gas fits EIP-7825 at forge's 130% (`StepGasTooHigh`), and
/// under EIP-8037 each planned limit, at the 110% the commands send with (a call's with forge's search allowance), leaves
/// 5M of the block (`StepTooBigForBlock`). v1's acknowledgement variable is not asked for: the measurement is the guard,
/// and v2 is sent after the fork [P]. `--resume` does not run the script again, so none of this guards a resume.
/// @dev No key, no broadcast here. Written for Square Hole (MIT).
abstract contract CoreV2GasRules is CommonBase {
    uint256 internal constant RULES_SEPOLIA = 11_155_111;
    /// @notice Glamsterdam on Sepolia (EIP-7773; `DeployCoreV1.GLAMSTERDAM_SEPOLIA`).
    uint256 public constant GLAMSTERDAM_SEPOLIA = 1_791_294_816;
    uint256 public constant GLAMSTERDAM_MARGIN = 1 hours;
    uint256 public constant STATE_GAS_PER_CODE_BYTE_MIN = 1_000;
    uint256 public constant CHAIN_CODE_BYTE_GAS_MAX_PERCENT = 105;
    uint256 public constant TX_GAS_CAP = 16_777_216;
    uint256 public constant GAS_ESTIMATE_MULTIPLIER = 130;
    /// @notice The `--gas-estimate-multiplier` every v2 command sends with after the fork (v1's runbook's Z1 = after).
    uint256 public constant GAS_ESTIMATE_MULTIPLIER_AFTER = 110;
    /// @notice forge's search above a call's use in the script (`DeployCoreV1.CALL_LIMIT_ALLOWANCE`).
    uint256 public constant CALL_LIMIT_ALLOWANCE = 115;
    uint256 public constant BLOCK_STATE_GAS_ROOM = 5_000_000;

    error GlamsterdamTooClose(uint256 timestamp, uint256 fork);
    error GlamsterdamNotSimulated(uint256 gasPerCodeByte, uint256 min);
    error GlamsterdamSimulatedBeforeFork(uint256 timestamp, uint256 fork);
    error ChainRulesNotSimulated(uint256 chainId, uint256 forgeGasPerCodeByte, uint256 chainGasPerCodeByte);
    error StepGasTooHigh(string label, uint256 executionGas, uint256 max);
    error StepTooBigForBlock(string label, uint256 plannedLimit, uint256 max);

    /// @notice One transaction's gas as the script measured it (the caller frame's `gasleft()` delta).
    struct GasStep {
        string label;
        /// All its gas: before EIP-8037 its execution gas; under EIP-8037 its state gas too.
        uint256 gas;
        /// EIP-8037's state gas of its frame (0 without EIP-8037).
        uint256 stateGas;
        /// A call (forge's limit search adds `CALL_LIMIT_ALLOWANCE`), not a CREATE.
        bool viaCall;
    }

    function _checkGlamsterdamWindow(uint256 chainId, uint256 timestamp) internal pure {
        uint256 fork = GLAMSTERDAM_SEPOLIA;
        if (chainId == RULES_SEPOLIA && timestamp < fork && timestamp + GLAMSTERDAM_MARGIN >= fork) {
            revert GlamsterdamTooClose(timestamp, fork);
        }
    }

    /// @dev Two measuring CREATEs from the script itself: call it outside any broadcast.
    function _checkGlamsterdamSimulated(uint256 chainId, uint256 timestamp)
        internal
        returns (bool stateGas, uint256 gasPerCodeByte)
    {
        gasPerCodeByte = _codeByteGas();
        uint256 chainGasPerCodeByte = chainId == RULES_SEPOLIA ? 0 : _chainCodeByteGas();
        _checkGlamsterdamRules(chainId, timestamp, gasPerCodeByte, chainGasPerCodeByte);
        stateGas = gasPerCodeByte >= STATE_GAS_PER_CODE_BYTE_MIN;
    }

    function _checkGlamsterdamRules(
        uint256 chainId,
        uint256 timestamp,
        uint256 gasPerCodeByte,
        uint256 chainGasPerCodeByte
    ) internal pure {
        bool charged = gasPerCodeByte >= STATE_GAS_PER_CODE_BYTE_MIN;
        if (chainId == RULES_SEPOLIA) {
            if (timestamp >= GLAMSTERDAM_SEPOLIA && !charged) {
                revert GlamsterdamNotSimulated(gasPerCodeByte, STATE_GAS_PER_CODE_BYTE_MIN);
            }
            if (timestamp < GLAMSTERDAM_SEPOLIA && charged) {
                revert GlamsterdamSimulatedBeforeFork(timestamp, GLAMSTERDAM_SEPOLIA);
            }
        } else if (
            charged != (chainGasPerCodeByte >= STATE_GAS_PER_CODE_BYTE_MIN)
                || chainGasPerCodeByte * 100 > gasPerCodeByte * CHAIN_CODE_BYTE_GAS_MAX_PERCENT
        ) {
            revert ChainRulesNotSimulated(chainId, gasPerCodeByte, chainGasPerCodeByte);
        }
    }

    /// @dev Gas per deployed code byte in forge's EVM: two measuring CREATEs, outside any broadcast.
    function _codeByteGas() internal virtual returns (uint256) {
        return (_createCost(2_048) - _createCost(1_024)) / 1_024;
    }

    /// @dev The same on the chain: its RPC's `eth_estimateGas` of the two creations (read-only).
    function _chainCodeByteGas() internal virtual returns (uint256) {
        uint256 small = _estimateCreate(1_024);
        uint256 large = _estimateCreate(2_048);
        require(large > small, "the chain's estimates are not a creation's");
        return (large - small) / 1_024;
    }

    function _estimateCreate(uint16 size) internal returns (uint256) {
        bytes memory r = vm.rpc(
            "eth_estimateGas", string.concat('[{"data":"', vm.toString(_measuringInitCode(size)), '"},"latest"]')
        );
        require(r.length != 0 && r.length <= 32, "not an RPC quantity");
        return uint256(bytes32(r)) >> (256 - 8 * r.length);
    }

    function _measuringInitCode(uint16 size) internal pure returns (bytes memory) {
        return abi.encodePacked(hex"61", size, hex"6000f3");
    }

    function _createCost(uint16 size) internal returns (uint256 g) {
        bytes memory init = _measuringInitCode(size);
        address created;
        uint256 g0 = gasleft();
        assembly ("memory-safe") {
            created := create(0, add(init, 0x20), mload(init))
        }
        g = g0 - gasleft();
        require(created != address(0) && created.code.length == size, "the measuring CREATE failed");
    }

    /// @dev One transaction against EIP-7825 (execution gas at forge's 130%) and, under EIP-8037, the block's room.
    function _checkGasStep(GasStep memory s, bool stateGas, uint256 blockGasLimit) internal pure {
        uint256 maxExecution = TX_GAS_CAP * 100 / GAS_ESTIMATE_MULTIPLIER - 500_000;
        uint256 execution = _executionGas(s);
        if (execution > maxExecution) revert StepGasTooHigh(s.label, execution, maxExecution);
        if (!stateGas) return;
        uint256 maxLimit = blockGasLimit > BLOCK_STATE_GAS_ROOM ? blockGasLimit - BLOCK_STATE_GAS_ROOM : 0;
        uint256 limit = _plannedLimit(s);
        if (limit > maxLimit) revert StepTooBigForBlock(s.label, limit, maxLimit);
    }

    function _checkGasSteps(GasStep[] memory steps, bool stateGas, uint256 blockGasLimit) internal pure {
        for (uint256 k; k < steps.length; ++k) {
            _checkGasStep(steps[k], stateGas, blockGasLimit);
        }
    }

    /// @dev Its gas less its frame's state gas (an upper bound: a CREATE's new-account charge is outside its frame).
    function _executionGas(GasStep memory s) internal pure returns (uint256) {
        return s.gas - (s.stateGas < s.gas ? s.stateGas : s.gas);
    }

    /// @dev The limit forge sets after the fork, from above: a CREATE's gas, a call's with its search allowance, times
    /// `GAS_ESTIMATE_MULTIPLIER_AFTER`.
    function _plannedLimit(GasStep memory s) internal pure returns (uint256) {
        uint256 g = s.viaCall ? s.gas * CALL_LIMIT_ALLOWANCE / 100 : s.gas;
        return g * GAS_ESTIMATE_MULTIPLIER_AFTER / 100;
    }

    /// @dev EIP-8037's state gas of the frame that just ended (`CoreV1Deployment._lastFrameStateGas`).
    function _frameStateGas() internal view returns (uint256) {
        int64 s = IVmFrameGasV2(address(vm)).lastFrameGas().gasStateUsed;
        return s > 0 ? uint256(uint64(s)) : 0;
    }
}
