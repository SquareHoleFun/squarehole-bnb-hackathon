// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {RoyaltyCowConfig} from "../../src/box-v2/interfaces/IRoyaltyCow.sol";
import {BoxReceiverV2} from "../../src/box-v2/BoxReceiverV2.sol";
import {ReceiverCodeV21} from "../../src/box-v2/interfaces/IFeeModulesV21.sol";
import {CoreV2GasRules} from "./CoreV2GasRules.sol";
import {BoxFactoryV2Planner} from "../../src/box-v2/BoxFactoryV2Planner.sol";

/// @notice Shared artifact deployment for the script and local rehearsal. No stand-in part is selectable.
abstract contract CoreV2Deployment is CoreV2GasRules {
    bool internal chargesStateGas;

    struct Config {
        address deployer;
        address manager;
        address weth;
        address randomness;
        address v1Registry;
        address fitSafe;
        address platformSafe;
        RoyaltyCowConfig cow;
    }
    event DeploymentGas(string artifact, uint256 total, uint256 stateGas);
    error DeploymentFailed(string artifact);
    error PartTooLarge(string artifact, uint256 size);
    error WrongFactoryPrediction(address expected, address actual);
    /// @notice Script reports each creation; these are simulated until a broadcast receipt confirms them.
    event PartDeployed(string artifact, address part, bytes32 codeHash, uint256 size);

    /// @dev Caller establishes the deployer context before entering. No funds or approvals are transferred.
    function _deployCoreV2(Config memory c) internal returns (BoxFactoryV2Planner.Release memory r) {
        r.factory = vm.computeCreateAddress(c.deployer, uint256(vm.getNonce(c.deployer)) + 23);
        r.poolManager = c.manager;
        r.weth = c.weth;
        r.randomness = c.randomness;
        address[] memory directory = new address[](1);
        directory[0] = c.v1Registry;
        r.registry = _deploy("BoxRegistryV2.sol:BoxRegistryV2", abi.encode(r.factory, directory));
        r.listingRegistry =
            _deploy("ListingRegistry.sol:ListingRegistry", abi.encode(c.platformSafe, r.registry, c.manager, c.weth));
        address ci = _deploy("BoxCoordinatorV2.sol:BoxCoordinatorV2", abi.encode(c.manager, r.factory));
        r.implementations[0] = ci;
        r.implementations[1] = _deploy("BoxTokenV2.sol:BoxTokenV2", abi.encode(ci));
        address ext = _deploy("BoxHookV2Extension.sol:BoxHookV2Extension", abi.encode(c.manager));
        r.implementations[2] = _deploy("BoxHookV2.sol:BoxHookV2", abi.encode(c.manager, ci, ext));
        r.implementations[3] = _deploy("BoxVaultV2.sol:BoxVaultV2", abi.encode(ci));
        r.implementations[4] = _deploy("BoxCollectionV2.sol:BoxCollectionV2", abi.encode(ci));
        ReceiverCodeV21 memory receiverCode = _receiverCode(c);
        r.implementations[5] = _deploy(
            "BoxReceiverV2.sol:BoxReceiverV2", abi.encode(c.manager, ci, c.fitSafe, c.platformSafe, receiverCode)
        );
        r.implementations[6] = _deploy("BoxLaunchRouterV2.sol:BoxLaunchRouterV2", abi.encode(c.manager, ci));
        r.implementations[7] = _deploy("BoxTicketsV2.sol:BoxTicketsV2", abi.encode(ci));
        r.implementations[8] = _deploy("BoxRoyaltyRouterV2.sol:BoxRoyaltyRouterV2", abi.encode(c.cow));
        address validator = _deploy("BoxSpecV2Validator.sol:BoxSpecV2Validator", "");
        address parts = _deploy("BoxFactoryV2Parts.sol:BoxFactoryV2Parts", "");
        address planner = _deploy("BoxFactoryV2Planner.sol:BoxFactoryV2Planner", abi.encode(validator, parts));
        address checks = _deploy("BoxFactoryV2Checks.sol:BoxFactoryV2Checks", "");
        address factory = _deploy("BoxFactoryV2.sol:BoxFactoryV2", abi.encode(r, planner, checks));
        if (factory != r.factory) revert WrongFactoryPrediction(r.factory, factory);
    }

    /// @dev Script-only artifact CREATE, preserving the pinned compiler output and refusing oversized runtime.
    function _deploy(string memory artifact, bytes memory args) internal returns (address part) {
        bytes memory code = bytes.concat(vm.getCode(artifact), args);
        uint256 before_ = gasleft();
        assembly ("memory-safe") { part := create(0, add(code, 32), mload(code)) }
        uint256 used = before_ - gasleft();
        uint256 stateGas = _frameStateGas();
        // Internal CREATE already charges creation/init-code execution. Add the transaction envelope and
        // deployment calldata; do not count the 32k CREATE cost a second time.
        used += 21_000;
        for (uint256 i; i < code.length; ++i) {
            used += code[i] == 0 ? 4 : 16;
        }
        _checkGasStep(
            GasStep(artifact, used, stateGas, false),
            chargesStateGas,
            block.gaslimit < 54_500_000 ? block.gaslimit : 54_500_000
        );
        emit DeploymentGas(artifact, used, stateGas);
        if (part == address(0) || part.code.length == 0) revert DeploymentFailed(artifact);
        if (part.code.length > 22_118) revert PartTooLarge(artifact, part.code.length);
        emit PartDeployed(artifact, part, part.codehash, part.code.length);
    }

    function _receiverCode(Config memory c) internal returns (ReceiverCodeV21 memory code) {
        require(keccak256(type(BoxReceiverV2).creationCode) != bytes32(0), "linked receiver");
        code.views = _deploy("ReceiverViews.sol:ReceiverViews", "");
        code.modules[0] = _deploy("EatPriceCoinFeeModuleV21.sol:EatPriceCoinFeeModuleV21", abi.encode(c.manager, code.views));
        code.modules[1] = _deploy("HoldersTFeeModuleV21.sol:HoldersTFeeModuleV21", abi.encode(c.manager, code.views));
        code.modules[2] = _deploy("ItemsTFeeModuleV21.sol:ItemsTFeeModuleV21", abi.encode(c.manager, code.views));
        code.modules[3] = _deploy("PileFeeModuleV21.sol:PileFeeModuleV21", abi.encode(c.manager, code.views));
        address[] memory initial = new address[](4);
        for (uint256 i; i < 4; ++i) initial[i] = code.modules[i];
        // Every release action becomes selectable one day after this deployment; no production bypass.
        code.directory = _deploy("FeeModuleDirectoryV21.sol:FeeModuleDirectoryV21", abi.encode(c.platformSafe, initial));
        address receiver = vm.computeCreateAddress(c.deployer, uint256(vm.getNonce(c.deployer)) + 1);
        code.callback = _deploy("BoxReceiverV2Extension.sol:BoxReceiverV2Extension", abi.encode(c.manager, code.views, receiver));
    }
}
