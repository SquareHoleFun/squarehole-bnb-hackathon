// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Vm} from "forge-std/Vm.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {BoxReceiverV2} from "../../../src/box-v2/BoxReceiverV2.sol";
import {ReceiverCodeV21} from "../../../src/box-v2/interfaces/IFeeModulesV21.sol";

import {ReceiverBooksV21} from "../../../src/box-v2/libraries/ReceiverBooksV21.sol";

import {ReceiverPendingV21} from "../../../src/box-v2/libraries/ReceiverPendingV21.sol";

import {ReceiverRewardsV21} from "../../../src/box-v2/libraries/ReceiverRewardsV21.sol";

import {RewardAccountingV21} from "../../../src/box-v2/libraries/RewardAccountingV21.sol";

import {FeeModuleProofV21} from "../../../src/box-v2/libraries/FeeModuleProofV21.sol";

import {ReceiverModuleCallV21} from "../../../src/box-v2/libraries/ReceiverModuleCallV21.sol";

/// Test-only artifact deployment. Production deploys these as separately measured transactions.
library ReceiverDeploy {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    function cool(address receiver) internal {
        (address views, address callback, address directory) = BoxReceiverV2(receiver).receiverCode();
        for (uint8 choice = 6; choice <= 9; ++choice) {
            (address module,) = BoxReceiverV2(receiver).feeModule(choice);
            vm.cool(module);
        }
        vm.cool(views); vm.cool(callback); vm.cool(directory); vm.cool(receiver);
        vm.cool(address(ReceiverBooksV21));
        vm.cool(address(ReceiverPendingV21));
        vm.cool(address(ReceiverRewardsV21));
        vm.cool(address(RewardAccountingV21));
        vm.cool(address(FeeModuleProofV21));
        vm.cool(address(ReceiverModuleCallV21));
    }
    function code(IPoolManager pm) internal returns (ReceiverCodeV21 memory c) {
        require(keccak256(type(BoxReceiverV2).creationCode) != bytes32(0), "linked receiver");
        c.views = _deploy("ReceiverViews.sol:ReceiverViews", "");
        c.modules[0] = _deploy("EatPriceCoinFeeModuleV21.sol:EatPriceCoinFeeModuleV21", abi.encode(pm, c.views));
        c.modules[1] = _deploy("HoldersTFeeModuleV21.sol:HoldersTFeeModuleV21", abi.encode(pm, c.views));
        c.modules[2] = _deploy("ItemsTFeeModuleV21.sol:ItemsTFeeModuleV21", abi.encode(pm, c.views));
        c.modules[3] = _deploy("PileFeeModuleV21.sol:PileFeeModuleV21", abi.encode(pm, c.views));
        address[] memory initial = new address[](4);
        for (uint256 i; i < 4; ++i) initial[i] = c.modules[i];
        // Fixture registrations precede the simulated release by one day; production never bypasses the delay.
        uint256 now_ = block.timestamp;
        if (now_ < 1 days) now_ = 1 days;
        vm.warp(now_ - 1 days);
        c.directory = _deploy("FeeModuleDirectoryV21.sol:FeeModuleDirectoryV21", abi.encode(address(this), initial));
        vm.warp(now_);
        address receiver = address(this).code.length == 0 ? address(this) : vm.computeCreateAddress(address(this), uint256(vm.getNonce(address(this))) + 1);
        c.callback = _deploy("BoxReceiverV2Extension.sol:BoxReceiverV2Extension", abi.encode(pm, c.views, receiver));
    }
    function args(IPoolManager pm, address ci, address fit, address platform) internal returns (bytes memory) {
        return abi.encode(pm, ci, fit, platform, code(pm));
    }
    function _deploy(string memory artifact, bytes memory args_) private returns (address part) {
        bytes memory init = bytes.concat(vm.getCode(artifact), args_);
        assembly ("memory-safe") { part := create(0, add(init, 32), mload(init)) }
        require(part != address(0), "receiver fixture deploy");
    }
}
