// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {DrandSource} from "../../../../src/box/randomness/DrandSource.sol";
import {DrandSourcePins} from "../../../../src/box/randomness/DrandSourcePins.sol";

/// @notice TEST ONLY. The pinned `DrandSource` deployment (`DrandSourcePins.sol`): its creation code (no constructor
/// input) sent through the canonical CREATE2 deployer with `DrandSourcePins.SALT`, as anyone would deploy it on mainnet
/// or Sepolia. Locally the deployer gets its on-chain code (copied from test/v2/utils/PinnedSource.sol) when the test
/// EVM does not have it; on a fork the real one is used.
library PinnedDrandSource {
    /// @dev Arachnid's deterministic-deployment proxy, byte for byte as deployed at `DrandSourcePins.DEPLOYER`.
    bytes internal constant DEPLOYER_CODE =
        hex"7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";

    function initCode() internal pure returns (bytes memory) {
        return type(DrandSource).creationCode;
    }

    /// @notice CREATE2(`DEPLOYER`, `SALT`, keccak256(creation code)).
    function predict() internal pure returns (address) {
        bytes32 h = keccak256(
            abi.encodePacked(bytes1(0xff), DrandSourcePins.DEPLOYER, DrandSourcePins.SALT, keccak256(initCode()))
        );
        return address(uint160(uint256(h)));
    }

    /// @notice Deploys it through the deployer (or returns the deployment already there).
    function deploy(Vm vm) internal returns (DrandSource) {
        if (DrandSourcePins.DEPLOYER.code.length == 0) vm.etch(DrandSourcePins.DEPLOYER, DEPLOYER_CODE);
        address at = predict();
        if (at.code.length == 0) {
            (bool ok, bytes memory ret) = DrandSourcePins.DEPLOYER.call(bytes.concat(DrandSourcePins.SALT, initCode()));
            require(ok && ret.length == 20 && address(bytes20(ret)) == at, "the pinned deployment");
        }
        return DrandSource(at);
    }
}
