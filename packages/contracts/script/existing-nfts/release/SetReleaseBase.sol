// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {BoxReceiverV2} from "../../../src/box-v2/BoxReceiverV2.sol";
import {BoxHookV2} from "../../../src/box-v2/BoxHookV2.sol";
import {IBoxRegistryV2} from "../../../src/box-v2/interfaces/IBoxRegistryV2.sol";
import {ReceiverCodeV21} from "../../../src/box-v2/interfaces/IFeeModulesV21.sol";
import {SetFactoryV2Checks} from "../../../src/box-v2/set/SetFactoryV2Checks.sol";
import {SetReleaseV2} from "../../../src/box-v2/set/SetReleaseV2.sol";
import {BoxCoordinatorV2} from "../../../src/box-v2/BoxCoordinatorV2.sol";
import {BoxTokenV2} from "../../../src/box-v2/BoxTokenV2.sol";
import {BoxHookV2Extension} from "../../../src/box-v2/BoxHookV2Extension.sol";
import {StarterSetLoaderV2} from "../../../src/box-v2/StarterSetLoaderV2.sol";
import {BoxLaunchRouterV2} from "../../../src/box-v2/BoxLaunchRouterV2.sol";
import {BoxRegistryV2} from "../../../src/box-v2/BoxRegistryV2.sol";
import {ListingRegistry} from "../../../src/box-v2/ListingRegistry.sol";
import {FeeModuleDirectoryV21} from "../../../src/box-v2/FeeModuleDirectoryV21.sol";
import {BoxReceiverV2Extension} from "../../../src/box-v2/BoxReceiverV2Extension.sol";
import {SetVaultV2} from "../../../src/box-v2/set/SetVaultV2.sol";
import {SetSpecV2Validator} from "../../../src/box-v2/set/SetSpecV2Validator.sol";
import {SetFactoryV2Planner} from "../../../src/box-v2/set/SetFactoryV2Planner.sol";
import {SetFactoryV2} from "../../../src/box-v2/set/SetFactoryV2.sol";
import {BoxFactoryV2Parts} from "../../../src/box-v2/BoxFactoryV2Parts.sol";
import {ItemsTFeeModuleV21} from "../../../src/box-v2/modules/ItemsTFeeModuleV21.sol";
import {PileFeeModuleV21} from "../../../src/box-v2/modules/PileFeeModuleV21.sol";
import {EatPriceCoinFeeModuleV21} from "../../../src/box-v2/modules/EatPriceCoinFeeModuleV21.sol";
import {HoldersTFeeModuleV21} from "../../../src/box-v2/modules/HoldersTFeeModuleV21.sol";
import {ReceiverViews} from "../../../src/box-v2/libraries/ReceiverViews.sol";
import {FactoryChecksCurve} from "../../../src/box-v2/libraries/FactoryChecksCurve.sol";
import {ReceiverShopV21} from "../../../src/box-v2/libraries/ReceiverShopV21.sol";
import {ReceiverPendingV21} from "../../../src/box-v2/libraries/ReceiverPendingV21.sol";
import {ReceiverRewardsV21} from "../../../src/box-v2/libraries/ReceiverRewardsV21.sol";
import {RewardAccountingV21} from "../../../src/box-v2/libraries/RewardAccountingV21.sol";
import {ReceiverBooksV21} from "../../../src/box-v2/libraries/ReceiverBooksV21.sol";
import {FeeModuleProofV21} from "../../../src/box-v2/libraries/FeeModuleProofV21.sol";
import {ReceiverModuleCallV21} from "../../../src/box-v2/libraries/ReceiverModuleCallV21.sol";

/// @notice One-use reservation; no authority over the resulting factory. Final seal must precede phase 2.
contract SetFactorySlot {
    error SlotRefused();
    address public immutable sender = msg.sender;
    bytes32 public immutable configHash;
    uint256 public immutable chainId = block.chainid;
    bytes32 public partsHash;
    uint256 public sealedBlock;
    bool public used;

    constructor(bytes32 reviewedConfigHash) {
        configHash = reviewedConfigHash;
    }

    function seal(bytes32 hash) external {
        if (msg.sender != sender || sealedBlock != 0 || hash == bytes32(0)) revert SlotRefused();
        partsHash = hash;
        sealedBlock = block.number;
    }

    function deploy(bytes calldata init) external returns (address deployed) {
        if (msg.sender != sender || used || sealedBlock == 0 || block.number <= sealedBlock || block.chainid != chainId)
        {
            revert SlotRefused();
        }
        used = true;
        bytes memory code = init;
        assembly ("memory-safe") { deployed := create(0, add(code, 32), mload(code)) }
        if (deployed == address(0)) {
            // Preserve factory refusal diagnostics; the reverted frame also restores slot availability.
            assembly ("memory-safe") {
                let size := returndatasize()
                let ptr := mload(0x40)
                returndatacopy(ptr, 0, size)
                revert(ptr, size)
            }
        }
    }
}

/// @notice No environment or key reads. JSON is supplied explicitly by the reviewed Node entry point.
abstract contract SetReleaseBase is Script {
    error WrongChain();
    error MainnetAcknowledgement();
    error InvalidConfig();
    error HandoffMismatch();
    error DeploymentFailed(string artifact);
    error SizeLimit(string artifact);

    struct ReleaseConfig {
        uint256 chainId;
        address poolManager;
        address weth;
        address platformSafe;
        address fitSafe;
        address[] v1RegistryDirectory;
    }

    /// @dev Only addresses cross the process boundary. No simulated runtime hash is accepted.
    struct Parts {
        address slot;
        address registry;
        address listingRegistry;
        address[24] implementations;
        address planner;
        address checks;
    }
    event PartAddress(string artifact, address part, uint256 initcodeBytes, uint256 runtimeBytes);

    function _config(string memory json, bytes32 ack) internal view returns (ReleaseConfig memory c) {
        c.chainId = vm.parseUint(vm.parseJsonString(json, ".chainId"));
        if (c.chainId != block.chainid || (c.chainId != 1 && c.chainId != 11155111 && c.chainId != 31337)) {
            revert WrongChain();
        }
        if (c.chainId == 1 && (ack == bytes32(0) || ack != keccak256(bytes(json)))) revert MainnetAcknowledgement();
        c.poolManager = vm.parseJsonAddress(json, ".poolManager");
        c.weth = vm.parseJsonAddress(json, ".weth");
        c.platformSafe = vm.parseJsonAddress(json, ".platformSafe");
        c.fitSafe = vm.parseJsonAddress(json, ".fitSafe");
        c.v1RegistryDirectory = vm.parseJsonAddressArray(json, ".v1RegistryDirectory");
        if (
            c.poolManager.code.length == 0 || c.weth.code.length == 0 || c.platformSafe.code.length == 0
                || c.fitSafe.code.length == 0 || c.fitSafe == c.platformSafe || c.v1RegistryDirectory.length == 0
        ) revert InvalidConfig();
        for (uint256 i; i < c.v1RegistryDirectory.length; ++i) {
            if (c.v1RegistryDirectory[i].code.length == 0) revert InvalidConfig();
            for (uint256 j; j < i; ++j) {
                if (c.v1RegistryDirectory[i] == c.v1RegistryDirectory[j]) revert InvalidConfig();
            }
        }
    }

    function _deployParts(ReleaseConfig memory c, bytes32 configHash, address sender)
        internal
        returns (Parts memory p)
    {
        p.slot = address(new SetFactorySlot(configHash));
        address factory = vm.computeCreateAddress(p.slot, 1);
        p.registry = _deploy("BoxRegistryV2.sol:BoxRegistryV2", abi.encode(factory, c.v1RegistryDirectory));
        p.listingRegistry = _deploy(
            "ListingRegistry.sol:ListingRegistry", abi.encode(c.platformSafe, p.registry, c.poolManager, c.weth)
        );
        address ci = _deploy("BoxCoordinatorV2.sol:BoxCoordinatorV2", abi.encode(c.poolManager, factory));
        p.implementations[0] = ci;
        p.implementations[1] = _deploy("BoxTokenV2.sol:BoxTokenV2", abi.encode(ci));
        address extension = _deploy("BoxHookV2Extension.sol:BoxHookV2Extension", abi.encode(c.poolManager));
        p.implementations[2] = _deploy("BoxHookV2.sol:BoxHookV2", abi.encode(c.poolManager, ci, extension));
        p.implementations[19] = _deploy("StarterSetLoaderV2.sol:StarterSetLoaderV2", abi.encode(ci));
        p.implementations[3] = _deploy("SetVaultV2.sol:SetVaultV2", abi.encode(ci, p.implementations[19]));
        ReceiverCodeV21 memory code = _receiverCode(c, sender);
        p.implementations[5] =
            _deploy("BoxReceiverV2.sol:BoxReceiverV2", abi.encode(c.poolManager, ci, c.fitSafe, c.platformSafe, code));
        p.implementations[6] = _deploy("BoxLaunchRouterV2.sol:BoxLaunchRouterV2", abi.encode(c.poolManager, ci));
        address validator = _deploy("SetSpecV2Validator.sol:SetSpecV2Validator", "");
        address parts = _deploy("BoxFactoryV2Parts.sol:BoxFactoryV2Parts", "");
        p.planner = _deploy("SetFactoryV2Planner.sol:SetFactoryV2Planner", abi.encode(validator, parts));
        require(keccak256(type(SetFactoryV2Checks).creationCode) != bytes32(0), "linked checks");
        p.checks = _deploy("SetFactoryV2Checks.sol:SetFactoryV2Checks", "");
        SetFactorySlot(p.slot).seal(keccak256(abi.encode(p)));
    }

    function _receiverCode(ReleaseConfig memory c, address sender) private returns (ReceiverCodeV21 memory code) {
        require(keccak256(type(BoxReceiverV2).creationCode) != bytes32(0), "linked receiver");
        code.views = _deploy("ReceiverViews.sol:ReceiverViews", "");
        code.modules[0] =
            _deploy("EatPriceCoinFeeModuleV21.sol:EatPriceCoinFeeModuleV21", abi.encode(c.poolManager, code.views));
        code.modules[1] =
            _deploy("HoldersTFeeModuleV21.sol:HoldersTFeeModuleV21", abi.encode(c.poolManager, code.views));
        code.modules[2] = _deploy("ItemsTFeeModuleV21.sol:ItemsTFeeModuleV21", abi.encode(c.poolManager, code.views));
        code.modules[3] = _deploy("PileFeeModuleV21.sol:PileFeeModuleV21", abi.encode(c.poolManager, code.views));
        address[] memory initial = new address[](4);
        for (uint256 i; i < 4; ++i) {
            initial[i] = code.modules[i];
        }
        code.directory = _deploy("FeeModuleDirectoryV21.sol:FeeModuleDirectoryV21", abi.encode(c.platformSafe, initial));
        address receiver = vm.computeCreateAddress(sender, uint256(vm.getNonce(sender)) + 1);
        code.callback = _deploy(
            "BoxReceiverV2Extension.sol:BoxReceiverV2Extension", abi.encode(c.poolManager, code.views, receiver)
        );
    }

    function _deploy(string memory artifact, bytes memory args) internal returns (address part) {
        bytes memory code = bytes.concat(vm.getCode(artifact), args);
        if (code.length > 49152) revert SizeLimit(artifact);
        assembly ("memory-safe") { part := create(0, add(code, 32), mload(code)) }
        if (part == address(0) || part.code.length == 0) revert DeploymentFailed(artifact);
        if (part.code.length > 24576) revert SizeLimit(artifact);
        if (
            (keccak256(bytes(artifact)) == keccak256("SetVaultV2.sol:SetVaultV2")
                    || keccak256(bytes(artifact)) == keccak256("SetFactoryV2Planner.sol:SetFactoryV2Planner")
                    || keccak256(bytes(artifact)) == keccak256("SetFactoryV2Checks.sol:SetFactoryV2Checks"))
                && part.code.length > 22118
        ) revert SizeLimit(artifact);
        emit PartAddress(artifact, part, code.length, part.code.length);
    }

    /// @dev This run creates no parts. Every hash is observed from already mined code, including directory members.
    function _readRelease(ReleaseConfig memory c, Parts memory p) internal view returns (SetReleaseV2 memory r) {
        r.factory = vm.computeCreateAddress(p.slot, 1);
        r.registry = p.registry;
        r.listingRegistry = p.listingRegistry;
        r.poolManager = c.poolManager;
        r.weth = c.weth;
        r.fitSafe = c.fitSafe;
        r.platformSafe = c.platformSafe;
        r.implementations = p.implementations;
        for (uint256 i; i < 24; ++i) {
            if (r.implementations[i] != address(0)) r.implementationHashes[i] = r.implementations[i].codehash;
        }
        address[13] memory deps;
        deps[0] = r.registry;
        deps[1] = r.listingRegistry;
        deps[2] = c.poolManager;
        deps[3] = c.weth;
        deps[4] = BoxHookV2(r.implementations[2]).extension();
        deps[5] = vm.computeCreateAddress(r.implementations[0], 1);
        BoxReceiverV2 receiver = BoxReceiverV2(payable(r.implementations[5]));
        (deps[6], deps[7], deps[8]) = receiver.receiverCode();
        for (uint8 i; i < 4; ++i) {
            (deps[9 + i],) = receiver.feeModule(i + 6);
        }
        for (uint256 i; i < 13; ++i) {
            r.dependencyHashes[i] = deps[i].codehash;
        }
        r.plannerHash = p.planner.codehash;
        address[] memory directory = IBoxRegistryV2(r.registry).directory();
        bytes32[] memory hashes = new bytes32[](directory.length);
        for (uint256 i; i < directory.length; ++i) {
            hashes[i] = directory[i].codehash;
        }
        r.directoryHash = keccak256(abi.encode(directory, hashes));
    }

    function _deployFactory(ReleaseConfig memory c, Parts memory p, bytes32 configHash)
        internal
        returns (address factory)
    {
        SetFactorySlot slot = SetFactorySlot(p.slot);
        if (
            slot.configHash() != configHash || slot.chainId() != block.chainid
                || slot.partsHash() != keccak256(abi.encode(p))
                || keccak256(abi.encode(IBoxRegistryV2(p.registry).directory()))
                    != keccak256(abi.encode(c.v1RegistryDirectory))
        ) revert HandoffMismatch();
        SetReleaseV2 memory r = _readRelease(c, p);
        bytes memory init =
            bytes.concat(vm.getCode("SetFactoryV2.sol:SetFactoryV2"), abi.encode(r, p.planner, p.checks));
        if (init.length > 49152) revert SizeLimit("SetFactoryV2");
        factory = slot.deploy(init);
        if (factory != r.factory) revert HandoffMismatch();
        if (factory.code.length > 22118) revert SizeLimit("SetFactoryV2");
        emit PartAddress("SetFactoryV2.sol:SetFactoryV2", factory, init.length, factory.code.length);
    }

    function _printLibraries() internal pure {
        console.log(
            string.concat(
                "SETRELEASE|library|src/box-v2/libraries/FactoryChecksCurve.sol:FactoryChecksCurve|",
                vm.toString(address(FactoryChecksCurve))
            )
        );
        console.log(
            string.concat(
                "SETRELEASE|library|src/box-v2/libraries/ReceiverShopV21.sol:ReceiverShopV21|",
                vm.toString(address(ReceiverShopV21))
            )
        );
        console.log(
            string.concat(
                "SETRELEASE|library|src/box-v2/libraries/ReceiverPendingV21.sol:ReceiverPendingV21|",
                vm.toString(address(ReceiverPendingV21))
            )
        );
        console.log(
            string.concat(
                "SETRELEASE|library|src/box-v2/libraries/ReceiverRewardsV21.sol:ReceiverRewardsV21|",
                vm.toString(address(ReceiverRewardsV21))
            )
        );
        console.log(
            string.concat(
                "SETRELEASE|library|src/box-v2/libraries/RewardAccountingV21.sol:RewardAccountingV21|",
                vm.toString(address(RewardAccountingV21))
            )
        );
        console.log(
            string.concat(
                "SETRELEASE|library|src/box-v2/libraries/ReceiverBooksV21.sol:ReceiverBooksV21|",
                vm.toString(address(ReceiverBooksV21))
            )
        );
        console.log(
            string.concat(
                "SETRELEASE|library|src/box-v2/libraries/FeeModuleProofV21.sol:FeeModuleProofV21|",
                vm.toString(address(FeeModuleProofV21))
            )
        );
        console.log(
            string.concat(
                "SETRELEASE|library|src/box-v2/libraries/ReceiverModuleCallV21.sol:ReceiverModuleCallV21|",
                vm.toString(address(ReceiverModuleCallV21))
            )
        );
    }
}
