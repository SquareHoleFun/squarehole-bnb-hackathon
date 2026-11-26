// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";

/// @notice The committed spec files a deployed box 0 may have been created from (the post-deploy verifier's
/// `test_deployed_theSpecIsACommittedSpecFile`, docs/runbooks/sepolia-core-v1.md Step 5): SH_CORE_V1_SPEC_FILE when
/// set, then the chain's default file `script/config/box0-spec.<chainId>.json` and its twins: `.safe.json` (desk
/// question Z3: the mainnet Safe's address), `.rehearsal.json` (F78: the rehearsal build's raise) and
/// `.rehearsal.sepolia-safe.json` (SH-SEP-BOX0-SAFE: the rehearsal file with the Sepolia platform Safe as platform, the
/// box 0 core v2 is deployed on).
library CommittedSpecFiles {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @notice The files tried, in order ("" where SH_CORE_V1_SPEC_FILE is not set).
    function candidates(string memory specFileEnv, uint256 chainId) internal pure returns (string[5] memory) {
        string memory base = string.concat("script/config/box0-spec.", vm.toString(chainId));
        return [
            specFileEnv,
            string.concat(base, ".json"),
            string.concat(base, ".safe.json"),
            string.concat(base, ".rehearsal.json"),
            string.concat(base, ".rehearsal.sepolia-safe.json")
        ];
    }

    /// @notice The first existing candidate whose `.specHash` is `specHash`; "" when none.
    function matching(string memory specFileEnv, uint256 chainId, bytes32 specHash)
        internal
        view
        returns (string memory)
    {
        string[5] memory c = candidates(specFileEnv, chainId);
        for (uint256 i; i < c.length; ++i) {
            if (bytes(c[i]).length == 0 || !vm.exists(c[i])) continue;
            if (vm.parseJsonBytes32(vm.readFile(c[i]), ".specHash") == specHash) return c[i];
        }
        return "";
    }
}
