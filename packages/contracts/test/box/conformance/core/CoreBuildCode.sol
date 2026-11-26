// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";

/// @title CoreBuildCode
/// @notice TEST ONLY. Is the code at an address this repository's build of a contract, the build of the active Foundry
/// profile (the mainnet build by default, F78's rehearsal build under FOUNDRY_PROFILE=rehearsal)? The runtime code is
/// compared byte for byte with the build's artifact (`<out>/<Name>.sol/<Name>.json`, `deployedBytecode.object`) with
/// only the immutables masked: the byte ranges solc lists in `deployedBytecode.immutableReferences`, which a
/// constructor fills (the PoolManager's address, the factory's, a curve value) and the artifact holds as zeros. Every
/// other byte must be equal, so a contract from another build or from changed code differs.
///
/// The artifact is first matched with the compilation the caller runs: its creation code must be the caller's
/// `type(X).creationCode` (`Result.artifactIsThisBuild`), so a stale or wrong output folder cannot pass for the build.
library CoreBuildCode {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @dev One entry of `deployedBytecode.immutableReferences` (JSON keys in alphabetical order).
    struct ImmutableRef {
        uint256 length;
        uint256 start;
    }

    struct Result {
        /// The artifact read is the caller's compilation (its creation code is the caller's `type(X).creationCode`).
        bool artifactIsThisBuild;
        /// The code at the address and the artifact's runtime code have the same length.
        bool sameLength;
        /// Every byte outside the immutables is equal.
        bool same;
        /// The first differing byte outside the immutables (`type(uint256).max` when none).
        uint256 firstDifference;
        /// How many bytes the immutables cover (masked).
        uint256 maskedBytes;
        /// The artifact compared with.
        string artifact;
    }

    /// @notice The active profile's build output folder: `FOUNDRY_OUT` if set, else `foundry.toml`'s `out` of
    /// FOUNDRY_PROFILE (`out` by default, `out-rehearsal` for `rehearsal`, `out-neutral` for `sepolia-neutral`).
    function outDir() internal view returns (string memory) {
        string memory out = VM.envOr("FOUNDRY_OUT", string(""));
        if (bytes(out).length != 0) return out;
        bytes32 profile = keccak256(bytes(VM.envOr("FOUNDRY_PROFILE", string("default"))));
        if (profile == keccak256("rehearsal")) return "out-rehearsal";
        if (profile == keccak256("sepolia-neutral")) return "out-neutral";
        return "out";
    }

    /// @notice Compares the code at `deployed` with this build's `name` (a contract in `src/.../<name>.sol`), whose
    /// creation code in the caller's compilation is `creationCode`.
    function compare(address deployed, string memory name, bytes memory creationCode)
        internal
        view
        returns (Result memory r)
    {
        r.artifact = string.concat(outDir(), "/", name, ".sol/", name, ".json");
        r.firstDifference = type(uint256).max;
        string memory json = VM.readFile(r.artifact);
        r.artifactIsThisBuild = keccak256(VM.parseJsonBytes(json, ".bytecode.object")) == keccak256(creationCode);
        bytes memory expected = VM.parseJsonBytes(json, ".deployedBytecode.object");
        bytes memory code = deployed.code;
        r.sameLength = expected.length == code.length;
        if (!r.sameLength) return r;
        r.maskedBytes = _mask(json, expected, code);
        if (keccak256(expected) == keccak256(code)) {
            r.same = true;
            return r;
        }
        for (uint256 i; i < code.length; ++i) {
            if (expected[i] != code[i]) {
                r.firstDifference = i;
                break;
            }
        }
    }

    /// @notice The byte ranges of `name`'s immutables in this build (empty for a contract without any).
    function immutableRanges(string memory name) internal view returns (ImmutableRef[] memory all) {
        string memory json = VM.readFile(string.concat(outDir(), "/", name, ".sol/", name, ".json"));
        string memory key = ".deployedBytecode.immutableReferences";
        if (!VM.keyExistsJson(json, key)) return all;
        string[] memory ids = VM.parseJsonKeys(json, key);
        uint256 n;
        ImmutableRef[][] memory each = new ImmutableRef[][](ids.length);
        for (uint256 i; i < ids.length; ++i) {
            each[i] = abi.decode(VM.parseJson(json, string.concat(key, ".", ids[i])), (ImmutableRef[]));
            n += each[i].length;
        }
        all = new ImmutableRef[](n);
        n = 0;
        for (uint256 i; i < each.length; ++i) {
            for (uint256 j; j < each[i].length; ++j) {
                all[n++] = each[i][j];
            }
        }
    }

    /// @dev Copies the deployed bytes of every immutable range into `expected` (the artifact holds zeros there);
    /// returns the bytes masked.
    function _mask(string memory json, bytes memory expected, bytes memory code) private view returns (uint256 masked) {
        string memory key = ".deployedBytecode.immutableReferences";
        if (!VM.keyExistsJson(json, key)) return 0;
        string[] memory ids = VM.parseJsonKeys(json, key);
        for (uint256 i; i < ids.length; ++i) {
            ImmutableRef[] memory refs =
                abi.decode(VM.parseJson(json, string.concat(key, ".", ids[i])), (ImmutableRef[]));
            for (uint256 j; j < refs.length; ++j) {
                for (uint256 k = refs[j].start; k < refs[j].start + refs[j].length; ++k) {
                    expected[k] = code[k];
                }
                masked += refs[j].length;
            }
        }
    }
}
