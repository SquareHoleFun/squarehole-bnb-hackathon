// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {BoxBackedSource} from "../../../../src/box/randomness/BoxBackedSource.sol";
import {BackedSourcePins} from "../../../../src/box/randomness/BackedSourcePins.sol";
import {PinnedDrandSource} from "./PinnedDrandSource.sol";

/// @notice TEST ONLY. The pinned `BoxBackedSource` deployment (`BackedSourcePins.sol`, F143): its creation code (no
/// constructor input) sent through the canonical CREATE2 deployer with `BackedSourcePins.SALT`, as anyone would deploy
/// it on mainnet or Sepolia. Locally the deployer gets its on-chain code (PinnedDrandSource's copy) when the test EVM
/// does not have it; on a fork the real one is used.
library PinnedBackedSource {
    function initCode() internal pure returns (bytes memory) {
        return type(BoxBackedSource).creationCode;
    }

    /// @notice CREATE2(`DEPLOYER`, `SALT`, keccak256(creation code)).
    function predict() internal pure returns (address) {
        bytes32 h = keccak256(
            abi.encodePacked(bytes1(0xff), BackedSourcePins.DEPLOYER, BackedSourcePins.SALT, keccak256(initCode()))
        );
        return address(uint160(uint256(h)));
    }

    /// @notice Deploys it through the deployer (or returns the deployment already there).
    function deploy(Vm vm) internal returns (BoxBackedSource) {
        if (BackedSourcePins.DEPLOYER.code.length == 0) {
            vm.etch(BackedSourcePins.DEPLOYER, PinnedDrandSource.DEPLOYER_CODE);
        }
        address at = predict();
        if (at.code.length == 0) {
            (bool ok, bytes memory ret) =
                BackedSourcePins.DEPLOYER.call(bytes.concat(BackedSourcePins.SALT, initCode()));
            require(ok && ret.length == 20 && address(bytes20(ret)) == at, "the pinned backed source");
        }
        return BoxBackedSource(at);
    }
}
