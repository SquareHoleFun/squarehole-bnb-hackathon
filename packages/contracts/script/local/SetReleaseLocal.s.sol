// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DeployCoreV2} from "../DeployCoreV2.s.sol";
import {LocalTwin} from "./LocalTwin.sol";
import {BoxFactoryV1} from "../../src/box/BoxFactoryV1.sol";
import {BoxReceiverV2} from "../../src/box-v2/BoxReceiverV2.sol";
import {BoxHookV2} from "../../src/box-v2/BoxHookV2.sol";
import {IBoxRegistryV2} from "../../src/box-v2/interfaces/IBoxRegistryV2.sol";
import {FactoryChecksCurve} from "../../src/box-v2/libraries/FactoryChecksCurve.sol";
import {ReceiverCodeV21} from "../../src/box-v2/interfaces/IFeeModulesV21.sol";
import {RoyaltyCowConfig} from "../../src/box-v2/interfaces/IRoyaltyCow.sol";
import {SetFactoryV2} from "../../src/box-v2/set/SetFactoryV2.sol";
import {SetFactoryV2Planner} from "../../src/box-v2/set/SetFactoryV2Planner.sol";
import {SetFactoryV2Checks} from "../../src/box-v2/set/SetFactoryV2Checks.sol";
import {SetSpecV2Validator} from "../../src/box-v2/set/SetSpecV2Validator.sol";
import {SetVaultV2} from "../../src/box-v2/set/SetVaultV2.sol";
import {StarterSetLoaderV2} from "../../src/box-v2/StarterSetLoaderV2.sol";
import {SetReleaseV2} from "../../src/box-v2/set/SetReleaseV2.sol";
import {ERC721} from "solmate/src/tokens/ERC721.sol";
import {console} from "forge-std/console.sol";

/// @notice Local issuer fixture: the deployment sender can mint and exercise one deferred recovery.
contract SetLocalERC721 is ERC721 {
    address public immutable issuer;
    mapping(uint256 => bool) public blocked;
    constructor() ERC721("Local Existing NFTs", "LSET") { issuer = msg.sender; }
    /// @notice Issuer only, for local preparation; no production collection is changed.
    function mintBatch(address to, uint256[] calldata ids) external {
        require(msg.sender == issuer, "issuer only");
        for (uint256 i; i < ids.length; ++i) _mint(to, ids[i]);
    }
    /// @notice Issuer only: simulate an issuer-controlled transfer failure in local recovery.
    function setBlocked(uint256 id, bool value) external { require(msg.sender == issuer, "issuer only"); blocked[id] = value; }
    /// @notice Standard ownership/approval transfer except the explicit local failure fixture.
    function transferFrom(address from, address to, uint256 id) public override { require(!blocked[id], "local deferred"); super.transferFrom(from, to, id); }
    /// @notice Local metadata is deliberately absent; it never gates the lifecycle.
    function tokenURI(uint256) public pure override returns (string memory) { return ""; }
}

/// @notice One-shot local deployment address reservation; only its creating sender can consume nonce one.
contract SetLocalFactorySlot {
    address private immutable sender = msg.sender;
    bool private used;
    /// @notice Sender only: deploy the exact factory initcode once; no later authority over the factory.
    function deploy(bytes calldata init) external returns (address deployed) {
        require(msg.sender == sender && !used, "local factory slot"); used = true;
        bytes memory code = init;
        assembly ("memory-safe") { deployed := create(0, add(code, 32), mload(code)) }
        require(deployed != address(0), "factory deployment failed");
    }
}

/// @notice Separate local add-on graph beside core v2. Broadcasts only to a checked loopback Anvil.
contract SetReleaseLocal is DeployCoreV2 {
    /// @dev Address-only handoff between processes. Never carry simulated hashes into the factory run.
    struct Parts {
        address slot;
        address registry;
        address listingRegistry;
        address[24] implementations;
        address planner;
        address checks;
        address nft;
    }

    /// @notice First broadcast: reserve the factory and deploy every part, including the local collection.
    function runParts(address genesisFactory, address fitSafe) external {
        Config memory c = _localConfig(genesisFactory, fitSafe);
        vm.startBroadcast(msg.sender);
        Parts memory p = _deployParts(c);
        vm.stopBroadcast();
        console.log(string.concat("LOCALSET|slot|", vm.toString(p.slot)));
        console.log(string.concat("LOCALSET|planner|", vm.toString(p.planner)));
        console.log(string.concat("LOCALSET|checks|", vm.toString(p.checks)));
        // The factory embeds the exact checks runtime, including this linked library address.
        console.log(string.concat("LOCALSET|checksLibrary|", vm.toString(address(FactoryChecksCurve))));
        console.log(string.concat("LOCALSET|nft|", vm.toString(p.nft)));
        // Registry and implementation addresses also appear in the inherited PartDeployed events.
        console.log(string.concat("LOCALSET|parts|", vm.toString(abi.encode(p))));
    }

    /// @notice Fresh run after runParts receipts: hash mined code, then deploy through the sender-bound slot.
    function runLocal(address genesisFactory, address fitSafe, bytes calldata parts) external {
        Config memory c = _localConfig(genesisFactory, fitSafe);
        Parts memory p = abi.decode(parts, (Parts));
        SetReleaseV2 memory r = _readRelease(c, p);
        vm.startBroadcast(msg.sender);
        address factory = _deployFactory(r, p);
        vm.stopBroadcast();
        console.log(string.concat("LOCALSET|factory|", vm.toString(factory)));
        console.log(string.concat("LOCALSET|nft|", vm.toString(p.nft)));
    }

    function _localConfig(address genesisFactory, address fitSafe) private returns (Config memory) {
        LocalTwin.check(block.chainid, abi.decode(vm.rpc("web3_clientVersion", "[]"), (string)));
        BoxFactoryV1 genesis = BoxFactoryV1(genesisFactory);
        return Config(msg.sender, address(genesis.poolManager()), genesis.weth(), address(0),
            address(genesis.registry()), fitSafe, genesis.platformSafe(), RoyaltyCowConfig(address(0), address(0), 0));
    }

    function _deployParts(Config memory c) internal returns (Parts memory p) {
        p.slot = address(new SetLocalFactorySlot());
        address factory = vm.computeCreateAddress(p.slot, 1);
        address[] memory directory = new address[](1); directory[0] = c.v1Registry;
        p.registry = _deploy("BoxRegistryV2.sol:BoxRegistryV2", abi.encode(factory, directory));
        p.listingRegistry = _deploy("ListingRegistry.sol:ListingRegistry", abi.encode(c.platformSafe, p.registry, c.manager, c.weth));
        address ci = _deploy("BoxCoordinatorV2.sol:BoxCoordinatorV2", abi.encode(c.manager, factory));
        p.implementations[0] = ci;
        p.implementations[1] = _deploy("BoxTokenV2.sol:BoxTokenV2", abi.encode(ci));
        address extension = _deploy("BoxHookV2Extension.sol:BoxHookV2Extension", abi.encode(c.manager));
        p.implementations[2] = _deploy("BoxHookV2.sol:BoxHookV2", abi.encode(c.manager, ci, extension));
        p.implementations[19] = _deploy("StarterSetLoaderV2.sol:StarterSetLoaderV2", abi.encode(ci));
        p.implementations[3] = _deploy("SetVaultV2.sol:SetVaultV2", abi.encode(ci, p.implementations[19]));
        ReceiverCodeV21 memory receiverCode = _receiverCode(c);
        p.implementations[5] = _deploy("BoxReceiverV2.sol:BoxReceiverV2", abi.encode(c.manager, ci, c.fitSafe, c.platformSafe, receiverCode));
        p.implementations[6] = _deploy("BoxLaunchRouterV2.sol:BoxLaunchRouterV2", abi.encode(c.manager, ci));
        address validator = _deploy("SetSpecV2Validator.sol:SetSpecV2Validator", "");
        address parts = _deploy("BoxFactoryV2Parts.sol:BoxFactoryV2Parts", "");
        p.planner = _deploy("SetFactoryV2Planner.sol:SetFactoryV2Planner", abi.encode(validator, parts));
        // Keep the linked checks artifact in this script's compilation graph.
        require(keccak256(type(SetFactoryV2Checks).creationCode) != bytes32(0), "linked set checks");
        p.checks = _deploy("SetFactoryV2Checks.sol:SetFactoryV2Checks", "");
        p.nft = address(new SetLocalERC721());
    }

    /// @dev This run creates no parts. Every hash is observed from already mined code, including directory members.
    function _readRelease(Config memory c, Parts memory p) internal view returns (SetReleaseV2 memory r) {
        r.factory = vm.computeCreateAddress(p.slot, 1);
        r.registry = p.registry; r.listingRegistry = p.listingRegistry;
        r.poolManager = c.manager; r.weth = c.weth; r.fitSafe = c.fitSafe; r.platformSafe = c.platformSafe;
        r.implementations = p.implementations;
        for (uint256 i; i < 24; ++i) if (r.implementations[i] != address(0)) r.implementationHashes[i] = r.implementations[i].codehash;
        address[13] memory deps;
        deps[0] = r.registry; deps[1] = r.listingRegistry; deps[2] = c.manager; deps[3] = c.weth;
        deps[4] = BoxHookV2(r.implementations[2]).extension();
        deps[5] = vm.computeCreateAddress(r.implementations[0], 1);
        BoxReceiverV2 receiver = BoxReceiverV2(payable(r.implementations[5]));
        (deps[6], deps[7], deps[8]) = receiver.receiverCode();
        for (uint8 i; i < 4; ++i) (deps[9 + i],) = receiver.feeModule(i + 6);
        for (uint256 i; i < 13; ++i) r.dependencyHashes[i] = deps[i].codehash;
        r.plannerHash = p.planner.codehash;
        address[] memory directory = IBoxRegistryV2(r.registry).directory();
        bytes32[] memory hashes = new bytes32[](directory.length);
        for (uint256 i; i < directory.length; ++i) hashes[i] = directory[i].codehash;
        r.directoryHash = keccak256(abi.encode(directory, hashes));
    }

    function _deployFactory(SetReleaseV2 memory r, Parts memory p) internal returns (address factory) {
        factory = SetLocalFactorySlot(p.slot).deploy(bytes.concat(vm.getCode("SetFactoryV2.sol:SetFactoryV2"), abi.encode(r, p.planner, p.checks)));
        require(factory == r.factory, "set factory address");
    }
}
