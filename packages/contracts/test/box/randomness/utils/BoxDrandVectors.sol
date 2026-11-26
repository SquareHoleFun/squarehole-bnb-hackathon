// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

/// @notice TEST ONLY. Real drand quicknet rounds for the box source (`test/vectors/drand-quicknet-box.json`, written by
/// `script-py/drand_box_vectors.py` from api.drand.sh; `--check` recomputes every derived field offline): the round a
/// request at each pinned fork block fixes (12 s margin), 16 consecutive local rounds and round 1. The EIP-2537
/// precompiles exist from Prague on, so every suite that checks a round runs its EVM as Osaka through Foundry's inline
/// config (`evm_version = "osaka"` on the test contract), as the v2 suites do (test/v2/utils/DrandVectors.sol).
abstract contract BoxDrandVectors is Test {
    struct Round {
        uint256 round;
        uint256 time;
        bytes compressed;
        bytes xy;
        bytes32 randomness;
    }

    string internal _boxDrandJson;

    function _loadBoxDrand() internal {
        _boxDrandJson = vm.readFile(string.concat(vm.projectRoot(), "/test/vectors/drand-quicknet-box.json"));
    }

    function _boxDrandCount() internal view returns (uint256) {
        return vm.parseJsonUintArray(_boxDrandJson, ".rounds").length;
    }

    function _boxDrandAt(uint256 i) internal view returns (Round memory r) {
        r.round = vm.parseJsonUintArray(_boxDrandJson, ".rounds")[i];
        r.time = vm.parseJsonUintArray(_boxDrandJson, ".roundTimes")[i];
        r.compressed = vm.parseJsonBytesArray(_boxDrandJson, ".signatures")[i];
        r.xy = vm.parseJsonBytesArray(_boxDrandJson, ".signaturesXY")[i];
        r.randomness = vm.parseJsonBytes32Array(_boxDrandJson, ".randomness")[i];
    }

    /// @dev The vector for `round` (reverts in the test if it is not committed).
    function _boxDrand(uint256 round) internal view returns (Round memory r) {
        uint256[] memory rounds = vm.parseJsonUintArray(_boxDrandJson, ".rounds");
        for (uint256 i; i < rounds.length; ++i) {
            if (rounds[i] == round) return _boxDrandAt(i);
        }
        revert(string.concat("no committed box vector for drand round ", vm.toString(round)));
    }

    /// @dev The first of the 16 consecutive local rounds (script-py/drand_box_vectors.py LOCAL_FIRST).
    function _localFirst() internal view returns (uint256 first) {
        uint256[] memory rounds = vm.parseJsonUintArray(_boxDrandJson, ".rounds");
        string[] memory why = vm.parseJsonStringArray(_boxDrandJson, ".why");
        for (uint256 i; i < rounds.length; ++i) {
            if (keccak256(bytes(why[i])) == keccak256("local")) return rounds[i];
        }
        revert("no local rounds");
    }

    /// @dev Local round `first + i`'s signature (i < 16).
    function _localSig(uint256 i) internal view returns (bytes memory) {
        return _boxDrand(_localFirst() + i).xy;
    }
}
