// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

/// @notice Real drand quicknet rounds (`test/vectors/drand-quicknet.json`, written by `script-py/drand_vectors.py`
/// from api.drand.sh; `--check` recomputes every derived field offline). The EIP-2537 precompiles exist from Prague on,
/// and mainnet and Sepolia run Osaka rules (`eth_config`, 2026-09-30), so every suite that checks a round runs its EVM
/// as Osaka through Foundry's inline config (evm_version "osaka" on the test contract; foundry.toml's
/// target stays Cancun, which is also the newest solc 0.8.26 compiles for). `vm.setEvmVersion` is not enough: it
/// changes the reported version but not the precompile set of a running test EVM (forge 1.8.3, checked).
abstract contract DrandVectors is Test {
    struct Round {
        uint256 round;
        uint256 time;
        bytes compressed;
        bytes xy;
        bytes32 randomness;
    }

    string internal _drandJson;

    function _loadDrand() internal {
        _drandJson = vm.readFile(string.concat(vm.projectRoot(), "/test/vectors/drand-quicknet.json"));
    }

    function _drandCount() internal view returns (uint256) {
        return vm.parseJsonUintArray(_drandJson, ".rounds").length;
    }

    function _drandAt(uint256 i) internal view returns (Round memory r) {
        r.round = vm.parseJsonUintArray(_drandJson, ".rounds")[i];
        r.time = vm.parseJsonUintArray(_drandJson, ".roundTimes")[i];
        r.compressed = vm.parseJsonBytesArray(_drandJson, ".signatures")[i];
        r.xy = vm.parseJsonBytesArray(_drandJson, ".signaturesXY")[i];
        r.randomness = vm.parseJsonBytes32Array(_drandJson, ".randomness")[i];
    }

    /// @dev The vector for `round` (reverts in the test if it is not committed).
    function _drand(uint256 round) internal view returns (Round memory r) {
        uint256[] memory rounds = vm.parseJsonUintArray(_drandJson, ".rounds");
        for (uint256 i; i < rounds.length; ++i) {
            if (rounds[i] == round) return _drandAt(i);
        }
        revert(string.concat("no committed vector for drand round ", vm.toString(round)));
    }

    /// @dev The first of the consecutive local rounds (script-py/drand_vectors.py LOCAL_FIRST).
    function _localFirstRound() internal view returns (uint256 first) {
        uint256[] memory rounds = vm.parseJsonUintArray(_drandJson, ".rounds");
        string[] memory why = vm.parseJsonStringArray(_drandJson, ".why");
        for (uint256 i; i < rounds.length; ++i) {
            if (keccak256(bytes(why[i])) == keccak256("local")) return rounds[i];
        }
        revert("no local rounds");
    }
}
