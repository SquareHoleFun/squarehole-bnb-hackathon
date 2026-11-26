// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Script} from "forge-std/Script.sol";
import {CoreV2GasRules} from "./sepolia-v2/CoreV2GasRules.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IFeeModulesV21} from "../src/box-v2/interfaces/IFeeModulesV21.sol";
import {FeeModuleDirectoryV21} from "../src/box-v2/FeeModuleDirectoryV21.sol";
import {AlchemistFeeModuleV21} from "../src/box-v2/modules/AlchemistFeeModuleV21.sol";
import {AlchemistHopV21} from "../src/box-v2/modules/AlchemistRouteV21.sol";

/// @notice Offline simulation by default. Deploys a shared action and emits an unsigned registration for the Safe.
/// This script never signs, sends or bypasses the directory registration. No change to the core release inventory.
/// RC5-B deploys fresh dust-to-depth module/helper bytecode. Both live codehashes change; never reuse an RC4 row.
/// RegistrationPrepared emits the new pins; the new directory row must mature for its full one-day delay.
/// RC5 review pins (forge build, solc 0.8.26, SH-V21-RC5-INT): module creation code keccak256
/// 0xc866b823bb11a39459edd551183f365035e8ff55b4f41d0f7ed2d6cf22fae9af (21,291 B, the helper's creation code inside;
/// runtime 3,333 B), helper creation code keccak256 0x02137a9a21f6f79e35947094c5e3766724caeaf92459b943a556f7fa9c3791df
/// (16,502 B; runtime 13,388 B). Compare vm.getCode's output with them before a live run. Live codehashes embed the
/// constructor's immutables, so the registered pins are the moduleHash and executorHash RegistrationPrepared emits.
contract RegisterAlchemistV21 is Script, CoreV2GasRules {
    event RegistrationPrepared(address indexed safe, address indexed directory, address indexed module,
        bytes32 moduleHash, address executor, bytes32 executorHash, uint256 delay, bytes data);
    event DeploymentGas(uint256 totalGas, uint256 stateGas);
    /// @notice Anyone simulates; explicit ALCHEMIST_BROADCAST uses only the configured Foundry deployer signer.
    /// The caller supplies the reviewed pool route, the raw-P cap and dust size, and the platform trigger; none can
    /// change after creation. The constructor refuses a zero dust size or one above the cap.
    /// Release input rule for EVERY registration: dustMax must be small, 2 * dustMax < inputCap, and dustMax
    /// at most the route's reviewed raw rounding scale. These are release review requirements, stricter than
    /// the constructor's dustMax <= inputCap check; record the route-specific raw amounts before registration.
    function run(address deployer, address manager, address receiverImpl, address coordinatorImpl, AlchemistHopV21[] memory route,
        uint256 inputCap, uint256 dustMax, address trigger) external returns (address action, bytes memory safeData)
    {
        FeeModuleDirectoryV21 directory = _directory(receiverImpl);
        action = _deploy(deployer,abi.encode(IPoolManager(manager),receiverImpl,coordinatorImpl,route,inputCap,dustMax,trigger));
        safeData = abi.encodeCall(FeeModuleDirectoryV21.register,(action));
        _registration(directory,action,safeData);
    }

    /// @dev Internal read: the release receiver's own directory, which must still have an active lister.
    function _directory(address receiverImpl) private view returns (FeeModuleDirectoryV21 directory) {
        (,,address directory_) = IFeeModulesV21(receiverImpl).receiverCode();
        directory = FeeModuleDirectoryV21(directory_);
        require(directory.lister() != address(0) && !directory.renounced(), "inactive lister");
    }

    /// @dev Internal deployment of the encoded constructor arguments with the same execution/state-gas checks as the
    /// release scripts.
    function _deploy(address deployer, bytes memory args) private returns (address action) {
        bool sending = vm.envOr("ALCHEMIST_BROADCAST",false);
        // A live run must simulate the target chain's execution/state-gas rules first.
        if (sending) { _checkGlamsterdamSimulated(block.chainid,block.timestamp); vm.startBroadcast(deployer); }
        else vm.startPrank(deployer);
        bytes memory code = bytes.concat(vm.getCode("AlchemistFeeModuleV21.sol:AlchemistFeeModuleV21"),args);
        uint256 before_ = gasleft();
        assembly ("memory-safe") { action := create(0,add(code,32),mload(code)) }
        uint256 used = before_ - gasleft(); uint256 stateGas = _frameStateGas();
        if (sending) vm.stopBroadcast(); else vm.stopPrank();
        require(action.code.length != 0 && action.code.length <= 22_118,"action deployment");
        AlchemistFeeModuleV21 module = AlchemistFeeModuleV21(action);
        require(address(module.executor()).code.length <= 22_118,"route size");
        used += 21_000;
        for (uint256 i; i < code.length; ++i) used += code[i] == 0 ? 4 : 16;
        _checkGasStep(GasStep("Alchemist",used,stateGas,false),stateGas != 0,
            block.gaslimit < 54_500_000 ? block.gaslimit : 54_500_000);
        emit DeploymentGas(used,stateGas);
    }

    /// @dev Internal emitter; the lister Safe remains responsible for submitting this calldata.
    function _registration(FeeModuleDirectoryV21 directory, address action, bytes memory safeData) private {
        AlchemistFeeModuleV21 module = AlchemistFeeModuleV21(action);
        emit RegistrationPrepared(directory.lister(),address(directory),action,action.codehash,address(module.executor()),
            module.executorCodeHash(),directory.DELAY(),safeData);
    }
}
