// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {ReceiverCodeV21} from "../src/box-v2/interfaces/IFeeModulesV21.sol";
import {FeeModuleDirectoryV21} from "../src/box-v2/FeeModuleDirectoryV21.sol";
import {Script} from "forge-std/Script.sol";
import {CoreV2ReleaseInventory} from "./sepolia-v2/CoreV2ReleaseInventory.sol";
import {FactoryChecksCurve} from "../src/box-v2/libraries/FactoryChecksCurve.sol";
import {ReceiverShopV21} from "../src/box-v2/libraries/ReceiverShopV21.sol";
import {ReceiverPendingV21} from "../src/box-v2/libraries/ReceiverPendingV21.sol";
import {ReceiverRewardsV21} from "../src/box-v2/libraries/ReceiverRewardsV21.sol";
import {RewardAccountingV21} from "../src/box-v2/libraries/RewardAccountingV21.sol";
import {ReceiverBooksV21} from "../src/box-v2/libraries/ReceiverBooksV21.sol";
import {FeeModuleProofV21} from "../src/box-v2/libraries/FeeModuleProofV21.sol";
import {ReceiverModuleCallV21} from "../src/box-v2/libraries/ReceiverModuleCallV21.sol";
// Artifact-only CREATEs must still be reachable to the script compiler and linker.
import {BoxFactoryV2Checks} from "../src/box-v2/libraries/BoxFactoryV2Checks.sol";
import {ItemLedgerV2} from "../src/box-v2/ItemLedgerV2.sol";
import {PileVaultV2} from "../src/box-v2/PileVaultV2.sol";
import {HolderLedgerV2} from "../src/box-v2/HolderLedgerV2.sol";
import {BoxTokenV2Ledger} from "../src/box-v2/BoxTokenV2Ledger.sol";
import {ShopVaultV2} from "../src/box-v2/ShopVaultV2.sol";
import {StarterSetLoaderV2} from "../src/box-v2/StarterSetLoaderV2.sol";
import {BoxVaultV2} from "../src/box-v2/BoxVaultV2.sol";
import {BoxCollectionV2} from "../src/box-v2/BoxCollectionV2.sol";
import {BoxTicketsV2} from "../src/box-v2/BoxTicketsV2.sol";
import {BoxRoyaltyRouterV2} from "../src/box-v2/BoxRoyaltyRouterV2.sol";
import {CoreV2Deployment} from "./sepolia-v2/CoreV2Deployment.sol";
import {CoreV2SafeChecks} from "./lib/CoreV2SafeChecks.sol";
import {CoreV2ReleaseBuild} from "./lib/CoreV2ReleaseBuild.sol";
import {BoxFactoryV2} from "../src/box-v2/BoxFactoryV2.sol";
import {IListingRegistry, ListingRecord} from "../src/box-v2/interfaces/IListingRegistry.sol";
import {BoxFactoryV2Planner} from "../src/box-v2/BoxFactoryV2Planner.sol";
import {IBoxRegistry} from "../src/box/interfaces/IBoxRegistry.sol";
import {IBoxCoordinator} from "../src/box/interfaces/IBoxCoordinator.sol";
import {IBoxReceiver} from "../src/box/interfaces/IBoxReceiver.sol";
import {BoxKind} from "../src/box/interfaces/BoxTypes.sol";
import {BoxSpecV1} from "../src/box/BoxSpecV1.sol";
import {DrandSourcePins} from "../src/box/randomness/DrandSourcePins.sol";
import {BackedSourcePins} from "../src/box/randomness/BackedSourcePins.sol";
import {BoxBackedSource} from "../src/box/randomness/BoxBackedSource.sol";

/// @notice Local dry run by default. Broadcast requires the explicitly named deployer; no keys are read here.
/// Verifies box 0 and the two protocol Safes before the first CREATE. All release contracts are the real M1, M2 and M3 parts.
/// Refuses a build whose release constants are not the release's (FOUNDRY_PROFILE=rehearsal: `NotReleaseBuild`) before
/// anything else, and reads the simulated listing registry's native row back before Foundry may send (`NotReleaseListing`).
contract DeployCoreV2 is Script, CoreV2Deployment, CoreV2ReleaseInventory, CoreV2ReleaseBuild {
    error BadReleaseInput();
    error MissingBox0();
    error WrongPlatformSafe();
    /// @notice F164 D2: the bot is never an owner of the platform Safe.
    error PlatformOwnerIsBot();
    /// @notice Simulated release description. A receipt and Safe transfer proofs are still required for release.
    event ReleaseManifest(string json);

    /// @notice Anyone may simulate. CORE_V2_BROADCAST opts into the caller's configured Foundry signer only.
    /// Returns a manifest with chain-read owners, threshold and version, fixed addresses and code commitments.
    function run() external returns (address factory, string memory manifest) {
        _requireReleaseBuild(_buildConstants());
        (Config memory c, address box0) = _config();
        string memory safes = _safePins(c);
        // The custody roles beside the Safe pins, in the same release object `_manifest` completes (SH-188).
        vm.serializeString("cq11-release", "owners", _ownerRoles());
        (chargesStateGas,) = _checkGlamsterdamSimulated(block.chainid, block.timestamp);
        bool sending = vm.envOr(_environmentKey("CORE_V2_BROADCAST"), false);
        if (sending) {
            if (msg.sender != c.deployer) revert BadReleaseInput();
            vm.startBroadcast(c.deployer);
        } else {
            vm.startPrank(c.deployer);
        }
        BoxFactoryV2Planner.Release memory r = _deployM2CoreV2(c);
        if (sending) vm.stopBroadcast();
        else vm.stopPrank();
        _requireReleaseListing(r.listingRegistry);
        factory = r.factory;
        manifest = _manifest(c, r, box0, safes, sending);
        if (vm.envOr(_environmentKey("CORE_V2_WRITE_MANIFEST"), false)) {
            vm.writeJson(
                manifest,
                string.concat("deployments/core-v2-", vm.toString(block.chainid), "-", vm.toString(factory), ".json")
            );
        }
        emit ReleaseManifest(manifest);
    }

    /// @dev Production checks the constants compiled into this script, which share every release artifact's
    /// `sh-box-build/` remapping. Offline fixtures may substitute another profile's real values to pin the refusal.
    function _buildConstants() internal view virtual returns (BuildConstants memory) { return _compiledBuild(); }

    /// @dev Production uses the documented keys verbatim. Offline fixtures may namespace host-global
    /// variables while running this exact preflight and deployment code in concurrent test worlds.
    function _environmentKey(string memory key) internal view virtual returns (string memory) { return key; }

    /// @dev Caller establishes the deployer context before entering. No funds or approvals are transferred.
    function _deployM2CoreV2(Config memory c) internal returns (BoxFactoryV2Planner.Release memory r) {
        r.factory = vm.computeCreateAddress(c.deployer, uint256(vm.getNonce(c.deployer)) + 29);
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
        r.implementations[17] = _deploy("HolderLedgerV2.sol:HolderLedgerV2", abi.encode(c.manager));
        r.implementations[19] = _deploy("StarterSetLoaderV2.sol:StarterSetLoaderV2", abi.encode(ci));
        r.implementations[20] = _deploy("BoxTokenV2Ledger.sol:BoxTokenV2Ledger", abi.encode(ci));
        r.implementations[21] = _deploy("ShopVaultV2.sol:ShopVaultV2", abi.encode(c.manager, ci));
        r.implementations[16] = _deploy("ItemLedgerV2.sol:ItemLedgerV2", abi.encode(c.manager, ci));
        r.implementations[22] = _deploy("PileVaultV2.sol:PileVaultV2", abi.encode(ci));
        // Include the linked checks artifact in a standalone forge script compilation.
        require(keccak256(type(BoxFactoryV2Checks).creationCode) != bytes32(0));
        address validator = _deploy("BoxSpecV2Validator.sol:BoxSpecV2Validator", "");
        address parts = _deploy("BoxFactoryV2Parts.sol:BoxFactoryV2Parts", "");
        address planner = _deploy("BoxFactoryV2Planner.sol:BoxFactoryV2Planner", abi.encode(validator, parts));
        address checks = _deploy("BoxFactoryV2Checks.sol:BoxFactoryV2Checks", "");
        address factory = _deploy("BoxFactoryV2.sol:BoxFactoryV2", abi.encode(r, planner, checks));
        if (factory != r.factory) revert WrongFactoryPrediction(r.factory, factory);
    }

    /// @dev Deployment preflight only: box 0's registry is the authority for the platform, source and executor seams.
    function _config() private view returns (Config memory c, address box0) {
        if (block.chainid != 1 && block.chainid != 11_155_111) revert BadReleaseInput();
        c.deployer = vm.envAddress(_environmentKey("CORE_V2_DEPLOYER"));
        c.manager = vm.envAddress(_environmentKey("CORE_V2_POOL_MANAGER"));
        c.weth = vm.envAddress(_environmentKey("CORE_V2_WETH"));
        c.cow.composableCow = vm.envAddress(_environmentKey("CORE_V2_COMPOSABLE_COW"));
        c.cow.settlement = vm.envAddress(_environmentKey("CORE_V2_COW_SETTLEMENT"));
        c.cow.minimumLot = vm.envUint(_environmentKey("CORE_V2_ROYALTY_MINIMUM_LOT"));
        c.v1Registry = vm.envAddress(_environmentKey("CORE_V2_V1_REGISTRY"));
        c.fitSafe = vm.envAddress(_environmentKey("CORE_V2_FIT_SAFE"));
        c.platformSafe = vm.envAddress(_environmentKey("CORE_V2_PLATFORM_SAFE"));
        if (
            c.deployer == address(0) || c.manager.code.length == 0 || c.weth.code.length == 0
                || c.fitSafe == c.platformSafe
        ) {
            revert BadReleaseInput();
        }
        if (c.v1Registry.code.length == 0 || IBoxRegistry(c.v1Registry).boxCount() == 0) revert MissingBox0();
        box0 = IBoxRegistry(c.v1Registry).coordinatorOf(0);
        if (box0 != vm.envAddress(_environmentKey("CORE_V2_BOX0")) || box0.code.length == 0) revert MissingBox0();
        IBoxCoordinator b = IBoxCoordinator(box0);
        if (
            b.kind() != BoxKind.Box0 || b.boxId() != 0 || b.q() != address(0) || b.poolManager() != c.manager
                || b.token().code.length == 0 || b.executor().code.length == 0
        ) {
            revert MissingBox0();
        }
        IBoxReceiver receiver = IBoxReceiver(b.receiver());
        if (receiver.coordinator() != box0 || receiver.executor() != b.executor()) revert MissingBox0();
        if (
            receiver.platformSafe() != c.platformSafe
                || (block.chainid == 1 && c.platformSafe != BoxSpecV1.PLATFORM_SAFE_MAINNET)
        ) revert WrongPlatformSafe();
        c.randomness = _drandBehind(b.randomness());
        if (!DrandSourcePins.isPinned(c.randomness)) revert BadReleaseInput();
    }

    /// @dev Core v2's randomness from box 0's source (F143): box 0 reads its pinned BoxBackedSource, and core v2 boxes
    /// stay drand-only, on the DrandSource that source names; a source that is no pinned backed source is returned as
    /// it is (the caller then requires the pinned DrandSource).
    function _drandBehind(address box0Source) internal view returns (address) {
        return BackedSourcePins.isPinned(box0Source) ? address(BoxBackedSource(box0Source).DRAND()) : box0Source;
    }

    /// @dev Reads custody once before any deployment. FIT has the founder/bot/backup owner set; the platform's owner set
    /// and threshold come from `_platformCustody` (2-of-3 on mainnet, the founder alone elsewhere).
    function _safePins(Config memory c) internal returns (string memory) {
        address[] memory owners = new address[](3);
        owners[0] = vm.envAddress(_environmentKey("CORE_V2_BOT"));
        owners[1] = vm.envAddress(_environmentKey("CORE_V2_FOUNDER"));
        owners[2] = vm.envAddress(_environmentKey("CORE_V2_BACKUP"));
        string memory version = vm.envString(_environmentKey("CORE_V2_SAFE_VERSION"));
        string memory fit = _safeJson(
            "cq11-fit",
            CoreV2SafeChecks.read(
                c.fitSafe,
                vm.envAddress(_environmentKey("CORE_V2_PINNED_FIT_SAFE")),
                owners,
                2,
                version,
                vm.envAddress(_environmentKey("CORE_V2_SAFE_SINGLETON")),
                vm.envBytes32(_environmentKey("CORE_V2_SAFE_SINGLETON_CODEHASH")),
                vm.envAddress(_environmentKey("CORE_V2_SAFE_GUARD")),
                vm.envAddress(_environmentKey("CORE_V2_SAFE_HANDLER")),
                vm.envBytes32(_environmentKey("CORE_V2_SAFE_PROXY_CODEHASH"))
            )
        );
        (address[] memory platformOwners, uint256 platformThreshold) = _platformCustody(owners[1], owners[0]);
        string memory platform = _safeJson(
            "cq11-platform",
            CoreV2SafeChecks.read(
                c.platformSafe,
                vm.envAddress(_environmentKey("CORE_V2_PINNED_PLATFORM_SAFE")),
                platformOwners,
                platformThreshold,
                vm.envString(_environmentKey("CORE_V2_PLATFORM_SAFE_VERSION")),
                vm.envAddress(_environmentKey("CORE_V2_PLATFORM_SAFE_SINGLETON")),
                vm.envBytes32(_environmentKey("CORE_V2_PLATFORM_SAFE_SINGLETON_CODEHASH")),
                vm.envAddress(_environmentKey("CORE_V2_PLATFORM_SAFE_GUARD")),
                vm.envAddress(_environmentKey("CORE_V2_PLATFORM_SAFE_HANDLER")),
                vm.envBytes32(_environmentKey("CORE_V2_PLATFORM_SAFE_PROXY_CODEHASH"))
            )
        );
        return string.concat('{"fit":', fit, ',"platform":', platform, "}");
    }

    /// @dev The three custody roles (`owners`: founder, bot, backup) the release manifest carries beside the Safe pins;
    /// on chain 1 the shared manifest parser needs them to tell the founder from the bot (F151, F164 D2).
    function _ownerRoles() internal returns (string memory) {
        string memory roles = "cq11-owners";
        vm.serializeAddress(roles, "founder", vm.envAddress(_environmentKey("CORE_V2_FOUNDER")));
        vm.serializeAddress(roles, "bot", vm.envAddress(_environmentKey("CORE_V2_BOT")));
        return vm.serializeAddress(roles, "backup", vm.envAddress(_environmentKey("CORE_V2_BACKUP")));
    }

    /// @dev The platform Safe's expected owners and threshold (F151 R68-SAFE). On mainnet: 2-of-3, the founder and the two
    /// owners he names, read from CORE_V2_PLATFORM_SECOND_OWNER and CORE_V2_PLATFORM_THIRD_OWNER the way the Safe's own
    /// address is read; a missing one reverts here, before any CREATE, and neither may be the bot (F164 D2). Order is
    /// free: CoreV2SafeChecks matches the set (Safe lists the newest owner first). Sepolia and local: the founder alone,
    /// threshold 1, as before; the two settings are not read there.
    function _platformCustody(address founder, address bot)
        internal
        view
        returns (address[] memory owners, uint256 threshold)
    {
        if (block.chainid != 1) {
            owners = new address[](1);
            owners[0] = founder;
            return (owners, 1);
        }
        owners = new address[](3);
        owners[0] = founder;
        owners[1] = vm.envAddress(_environmentKey("CORE_V2_PLATFORM_SECOND_OWNER"));
        owners[2] = vm.envAddress(_environmentKey("CORE_V2_PLATFORM_THIRD_OWNER"));
        if (owners[1] == bot || owners[2] == bot) revert PlatformOwnerIsBot();
        return (owners, 2);
    }

    /// @dev Serialize the observed owner order and exact version; raw counters are decimal strings.
    function _safeJson(string memory key, CoreV2SafeChecks.SafePin memory s) private returns (string memory) {
        vm.serializeAddress(key, "address", s.account);
        vm.serializeAddress(key, "owners", s.owners);
        vm.serializeString(key, "threshold", vm.toString(s.threshold));
        vm.serializeString(key, "version", s.version);
        vm.serializeBytes32(key, "codeHash", s.codeHash);
        vm.serializeAddress(key, "singleton", s.singleton);
        vm.serializeBytes32(key, "singletonCodeHash", s.singletonCodeHash);
        vm.serializeString(key, "controlTransferProof", "pending");
        vm.serializeAddress(key, "guard", s.guard);
        vm.serializeBytes32(key, "guardCodeHash", s.guard == address(0) ? bytes32(0) : s.guard.codehash);
        vm.serializeAddress(key, "handler", s.handler);
        vm.serializeBytes32(key, "handlerCodeHash", s.handler == address(0) ? bytes32(0) : s.handler.codehash);
        return vm.serializeBool(key, "modulesEnabled", false);
    }

    /// @dev Release data only; simulation is explicitly labelled and cannot certify live Safe control.
    /// V2.1 action choices mature one day after directory deployment; record readyAt on the target chain.
    function _manifest(
        Config memory c,
        BoxFactoryV2Planner.Release memory r,
        address box0,
        string memory safes,
        bool sending
    ) internal returns (string memory) {
        string memory k = "cq11-release";
        vm.serializeString(k, "format", "squarehole.core-v2-release/2");
        vm.serializeString(k, "milestones", "M1-64,M2-64,M3-64");
        vm.serializeString(k, "chainId", vm.toString(block.chainid));
        vm.serializeString(k, "observedBlock", vm.toString(block.number));
        vm.serializeString(k, "status", sending ? "broadcast-plan-awaiting-receipts" : "local-simulation");
        vm.serializeBool(k, "publicReleaseReady", false);
        vm.serializeAddress(k, "factory", r.factory);
        vm.serializeAddress(k, "registry", r.registry);
        vm.serializeAddress(k, "listingRegistry", r.listingRegistry);
        vm.serializeAddress(k, "poolManager", c.manager);
        vm.serializeAddress(k, "weth", c.weth);
        vm.serializeAddress(k, "composableCow", c.cow.composableCow);
        vm.serializeAddress(k, "cowSettlement", c.cow.settlement);
        vm.serializeString(k, "royaltyMinimumLot", vm.toString(c.cow.minimumLot));
        address handler = BoxRoyaltyRouterV2(payable(r.implementations[8])).cowHandler();
        vm.serializeAddress(k, "royaltyCowHandler", handler);
        vm.serializeBytes32(k, "royaltyCowHandlerCodeHash", handler.codehash);
        vm.serializeAddress(k, "randomness", c.randomness);
        BoxFactoryV2 f = BoxFactoryV2(r.factory);
        vm.serializeBytes32(k, "versionCodeHash", f.versionCodeHash());
        vm.serializeAddress(k, "checks", address(f.checks()));
        vm.serializeAddress(k, "planner", address(f.planner()));
        address[] memory parts = new address[](24);
        bytes32[] memory hashes = new bytes32[](24);
        for (uint256 i; i < 24; ++i) {
            parts[i] = r.implementations[i];
            if (parts[i] != address(0)) hashes[i] = parts[i].codehash;
        }
        vm.serializeAddress(k, "implementations", parts);
        vm.serializeBytes32(k, "implementationCodeHashes", hashes);
        _inventoryJson(k, f);
        string memory b = "cq11-box0";
        vm.serializeAddress(b, "registry", c.v1Registry);
        vm.serializeAddress(b, "coordinator", box0);
        vm.serializeAddress(b, "fit", IBoxCoordinator(box0).token());
        string memory boxJson = vm.serializeAddress(b, "executor", IBoxCoordinator(box0).executor());
        vm.serializeString(k, "box0", boxJson);
        vm.serializeString(k, "safes", safes);
        vm.serializeString(k, "listings", _nativeListing(r.listingRegistry));
        return vm.serializeString(
            k,
            "remainingProofs",
            "each Safe control transfer; payFit; payPlatform; per-box in-kind royalty claim and P sweep; deployment receipts; live seven-day hatch"
        );
    }

    /// @dev Include all supporting runtimes, not only clone implementation slots.
    function _inventoryJson(string memory key, BoxFactoryV2 f) private {
        (address[] memory parts, string[] memory names, bytes32[] memory hashes) =
            _inventory(f, [
                address(FactoryChecksCurve), address(ReceiverPendingV21), address(ReceiverRewardsV21),
                address(RewardAccountingV21), address(ReceiverBooksV21), address(FeeModuleProofV21),
                address(ReceiverModuleCallV21), address(ReceiverShopV21)
            ]);
        _checkViews(parts, names);
        vm.serializeAddress(key, "parts", parts);
        vm.serializeString(key, "partNames", names);
        vm.serializeBytes32(key, "partCodeHashes", hashes);
        // This is a simulation commitment: the real directory's immutable readyAt uses its creation block.
        FeeModuleDirectoryV21 directory = FeeModuleDirectoryV21(parts[29]);
        (,, uint64 readyAt,) = directory.record(0);
        string memory timeKey = "cq11-time-dependent-hash";
        vm.serializeString(timeKey, "part", "29");
        vm.serializeString(timeKey, "name", "FeeModuleDirectoryV21");
        string memory timing = vm.serializeString(timeKey, "simulatedCreationTime", vm.toString(uint256(readyAt) - directory.DELAY()));
        vm.serializeString(key, "timeDependentCodeHash", timing);
    }

    /// @dev Snapshot the live native listing in decimal raw units; later raise updates do not rewrite this record.
    function _nativeListing(address registry) private returns (string memory) {
        ListingRecord memory row = IListingRegistry(registry).listing(0);
        string memory key = "cq11-native-listing";
        vm.serializeString(key, "id", vm.toString(row.id));
        vm.serializeAddress(key, "token", row.token);
        vm.serializeString(key, "decimals", vm.toString(row.decimals));
        vm.serializeString(key, "raise", vm.toString(row.raise));
        vm.serializeString(key, "bootstrapQ", vm.toString(row.q.bootstrapQ));
        string memory value = vm.serializeAddress(key, "lister", IListingRegistry(registry).lister());
        return string.concat('{"0":', value, "}");
    }
}
