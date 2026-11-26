// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {RoyaltyCowConfig} from "../../src/box-v2/interfaces/IRoyaltyCow.sol";
import {CowOffline} from "../../test/box-v2/kit/RoyaltyRelease.sol";
import {ReceiverCodeV21} from "../../src/box-v2/interfaces/IFeeModulesV21.sol";

// Include artifact-only dependencies in forge script's compilation graph (the production routine uses vm.getCode).
import {BoxFactoryV2Checks} from "../../src/box-v2/libraries/BoxFactoryV2Checks.sol";
import {ItemLedgerV2} from "../../src/box-v2/ItemLedgerV2.sol";
import {PileVaultV2} from "../../src/box-v2/PileVaultV2.sol";
import {HolderLedgerV2} from "../../src/box-v2/HolderLedgerV2.sol";
import {BoxTokenV2Ledger} from "../../src/box-v2/BoxTokenV2Ledger.sol";
import {ShopVaultV2} from "../../src/box-v2/ShopVaultV2.sol";
import {StarterSetLoaderV2} from "../../src/box-v2/StarterSetLoaderV2.sol";
import {DeployCoreV2} from "../DeployCoreV2.s.sol";
import {BoxFactoryV2Planner} from "../../src/box-v2/BoxFactoryV2Planner.sol";
import {BoxFactoryV1} from "../../src/box/BoxFactoryV1.sol";
import {LocalTwin} from "./LocalTwin.sol";
import {LocalERC20, LocalPriceCoin, LocalUSDC, LocalLINK, LocalWBTC, LocalStockControls, LocalNVDAon, LocalAAPLon, LocalPAXG, LocalXAUt} from "./LocalQuoteMocks.sol";
import {IListingRegistry, ListingClass} from "../../src/box-v2/interfaces/IListingRegistry.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {console} from "forge-std/console.sol";

/// @notice LOCAL TEST DOUBLE, not a Safe. Readable custody endpoints for anvil only; no signatures are certified.
/// Both addresses are real deployed contracts. The manifest explicitly marks control proof as local-only.
contract LocalV2Custody {
    address[] private owners;
    uint256 private threshold;
    constructor(address[] memory owners_, uint256 threshold_) { owners = owners_; threshold = threshold_; }
    /// @notice Anyone may read the local fixture owners; no funds move.
    function getOwners() external view returns (address[] memory) { return owners; }
    /// @notice Anyone may read the local fixture threshold; no funds move.
    function getThreshold() external view returns (uint256) { return threshold; }
    /// @notice Safe-shaped local metadata only, not a signature/security assertion.
    function VERSION() external pure returns (string memory) { return "1.4.1"; }
    /// @notice This local double is its own code identity, not a proxy.
    function singleton() external view returns (address) { return address(this); }
    /// @notice There are no modules in the local double.
    function getModulesPaginated(address, uint256) external pure returns (address[] memory, address) {
        return (new address[](0), address(1));
    }
    /// @notice First local owner only: run real admission as the platform lister, then clear approval and return probe funds.
    /// All calls are required and atomic. This is fixture custody, not a Safe transaction/signature simulation.
    function listPriceCoin(IListingRegistry registry, LocalERC20 coin, ListingClass class, uint256 raise)
        external returns (uint32 id)
    {
        require(msg.sender == owners[0], "local owner only");
        require(coin.approve(address(registry), 10_000), "local probe approval");
        id = registry.add(address(coin), class, raise);
        require(coin.approve(address(registry), 0), "local clear approval");
        require(coin.transfer(msg.sender, 10_000), "local probe return");
    }
    /// @notice Only the first local owner may recover test funds; production Safe semantics are not simulated.
    function withdraw(address payable to, uint256 amount) external {
        require(msg.sender == owners[0], "local owner only");
        (bool ok,) = to.call{value: amount}(""); require(ok, "local withdrawal refused");
    }
    /// @notice First local owner only: recover test ERC-20 fees to its chosen recipient. Refusal reverts atomically.
    function withdrawToken(LocalERC20 coin, address to, uint256 amount) external {
        require(msg.sender == owners[0], "local owner only");
        require(to != address(0), "local recipient required");
        require(coin.transfer(to, amount), "local token withdrawal refused");
    }
    receive() external payable {}
}

/// @notice Local M3 release: the production M2 deployment recipe plus item/pile implementations.
/// Retains inherited per-part gas and size checks; custody endpoints are explicitly local doubles.
/// Uses the real genesis factory, platform and pinned drand. Never edits/deploys substitute v2 money parts.
contract DeployCoreV2Local is DeployCoreV2 {
    /// @notice Explicit local dependencies only. The existing 11155111 entry and all public pins stay unchanged.
    function runAlpha(address manager, address weth, address drand, address fit, address platform)
        external returns (address factory)
    {
        LocalTwin.checkAlpha(block.chainid, abi.decode(vm.rpc("web3_clientVersion", "[]"), (string)));
        factory = _deployAlpha(msg.sender, manager, weth, drand, fit, platform);
        console.log(string.concat("ALPHA|factory|", vm.toString(factory)));
    }

    function _deployAlpha(address deployer, address manager, address weth, address drand, address fit, address platform)
        internal returns (address)
    {
        require(block.chainid == 31337, "alpha local only");
        _measureLocalGas();
        vm.startBroadcast(deployer);
        address cow = address(new CowOffline());
        Config memory c = Config(deployer, manager, weth, drand, address(0), fit, platform,
            RoyaltyCowConfig(cow, cow, 0.05 ether));
        address factory = _deployLocalCoreV2(c).factory;
        vm.stopBroadcast();
        return factory;
    }

    /// @notice Anvil-only, signed by the explicitly supplied unlocked sender. No key or public RPC is used.
    function runLocal(address genesisFactory, address fit) external returns (address) {
        LocalTwin.check(block.chainid, abi.decode(vm.rpc("web3_clientVersion", "[]"), (string)));
        BoxFactoryV1 genesis = BoxFactoryV1(genesisFactory);
        _measureLocalGas();
        vm.startBroadcast(msg.sender);
        // RC6 (F138): a fresh anvil has no CoW Protocol. Unless the caller names both endpoints, one offline double
        // serves as ComposableCoW and settlement, as in the release fixture (RoyaltyRelease.config()): inbox orders
        // register locally but never settle. The WETH minimum defaults to the release's 0.05 WETH.
        address composableCow = vm.envOr("CORE_V2_COMPOSABLE_COW", address(0));
        address settlement = vm.envOr("CORE_V2_COW_SETTLEMENT", address(0));
        if (composableCow == address(0) || settlement == address(0)) composableCow = settlement = address(new CowOffline());
        Config memory c = Config(msg.sender, address(genesis.poolManager()), genesis.weth(), _drandBehind(genesis.randomness()),
            address(genesis.registry()), fit, genesis.platformSafe(), RoyaltyCowConfig(composableCow, settlement,
                vm.envOr("CORE_V2_ROYALTY_MINIMUM_LOT", uint256(0.05 ether))));
        BoxFactoryV2Planner.Release memory r = _deployLocalCoreV2(c);
        vm.stopBroadcast();
        console.log(string.concat("LOCALV2|factory|", vm.toString(r.factory)));
        IListingRegistry listings = IListingRegistry(r.listingRegistry);
        console.log(string.concat("LOCALV2|usdc|", vm.toString(listings.listing(1).token)));
        console.log(string.concat("LOCALV2|link|", vm.toString(listings.listing(2).token)));
        console.log(string.concat("LOCALV2|wbtc|", vm.toString(listings.listing(3).token)));
        console.log(string.concat("LOCALV2|nvdaon|", vm.toString(listings.listing(4).token)));
        console.log(string.concat("LOCALV2|aaplon|", vm.toString(listings.listing(5).token)));
        console.log(string.concat("LOCALV2|paxg|", vm.toString(listings.listing(6).token)));
        console.log(string.concat("LOCALV2|xaut|", vm.toString(listings.listing(7).token)));
        return r.factory;
    }

    /// @dev Caller establishes the deployer context. Local coin admission clears approvals and returns probe funds to it.
    function _deployLocalCoreV2(Config memory c) internal returns (BoxFactoryV2Planner.Release memory r) {
        r.factory = vm.computeCreateAddress(c.deployer, uint256(vm.getNonce(c.deployer)) + 29);
        r.poolManager = c.manager;
        r.weth = c.weth;
        r.randomness = c.randomness;
        address[] memory directory = new address[](c.v1Registry == address(0) ? 0 : 1);
        if (directory.length != 0) directory[0] = c.v1Registry;
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
        r.implementations[16] = _deploy(_localItemLedgerArtifact(), abi.encode(c.manager, ci));
        r.implementations[22] = _deploy("PileVaultV2.sol:PileVaultV2", abi.encode(ci));
        address validator = _deploy("BoxSpecV2Validator.sol:BoxSpecV2Validator", "");
        address parts = _deploy("BoxFactoryV2Parts.sol:BoxFactoryV2Parts", "");
        address planner = _deploy("BoxFactoryV2Planner.sol:BoxFactoryV2Planner", abi.encode(validator, parts));
        address checks = _deploy("BoxFactoryV2Checks.sol:BoxFactoryV2Checks", "");
        address factory = _deploy("BoxFactoryV2.sol:BoxFactoryV2", abi.encode(r, planner, checks));
        if (factory != r.factory) revert WrongFactoryPrediction(r.factory, factory);
        if (c.v1Registry != address(0)) _listLocalCoins(c, IListingRegistry(r.listingRegistry));
    }

    /// @dev Called only after the predicted factory exists. Use real probe, layout and Q-parameter checks.
    /// Static quotes per ETH: 2,000 USDC, 100 LINK, 0.05 WBTC, 10 NVDAon, 8 AAPLon, 0.5 PAXG/XAUt.
    /// These fixture prices are not market quotes; CQ11 admits coins without external pools/converters.
    function _listLocalCoins(Config memory c, IListingRegistry listings) private {
        LocalStockControls controls = new LocalStockControls(c.deployer);
        LocalPriceCoin[7] memory coins = [LocalPriceCoin(address(new LocalUSDC())),
            LocalPriceCoin(address(new LocalLINK())), LocalPriceCoin(address(new LocalWBTC())),
            LocalPriceCoin(address(new LocalNVDAon(controls))), LocalPriceCoin(address(new LocalAAPLon(controls))),
            LocalPriceCoin(address(new LocalPAXG())), LocalPriceCoin(address(new LocalXAUt()))];
        uint256[7] memory unitsPerEth = [uint256(2000e6), 100e18, 5e6, 10e18, 8e18, 5e17, 5e5];
        for (uint256 i; i < coins.length; ++i) {
            uint256 raise = FullMath.mulDivRoundingUp(listings.listing(0).raise, unitsPerEth[i], 1 ether);
            coins[i].mint(c.platformSafe, 10_000);
            coins[i].mint(c.deployer, raise * 10);
            uint32 id = LocalV2Custody(payable(c.platformSafe)).listPriceCoin(
                listings, coins[i], i == 0 ? ListingClass.STABLE : i == 3 || i == 4 ? ListingClass.STOCK : ListingClass.OTHER, raise
            );
            require(id == i + 1, "unexpected local listing id");
        }
    }

    /// @dev Offline test subclasses can identify a missing seam explicitly; broadcasts always use the real part.
    function _localItemLedgerArtifact() internal pure virtual returns (string memory) {
        return "ItemLedgerV2.sol:ItemLedgerV2";
    }

    /// @dev Local chains fix their own time/fork. Retain production per-step gas and size checks under either EVM.
    function _measureLocalGas() internal {
        // Make the external FactoryChecksCurve library reachable to forge's script linker.
        // Merely naming Checks in vm.getCode leaves that artifact unlinked in a script dry run.
        require(keccak256(type(BoxFactoryV2Checks).creationCode) != bytes32(0), "missing linked checks");
        chargesStateGas = _codeByteGas() >= STATE_GAS_PER_CODE_BYTE_MIN;
    }
}
