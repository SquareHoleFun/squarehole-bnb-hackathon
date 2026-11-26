// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VmSafe} from "forge-std/Vm.sol";
import {console} from "forge-std/console.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IRewardLedger} from "../src/interfaces/IRewardLedger.sol";
import {SquareHoleLauncher} from "../src/SquareHoleLauncher.sol";
import {SquareHoleRegistry} from "../src/SquareHoleRegistry.sol";
import {MockTetherUSD} from "../src/testnet/MockTetherUSD.sol";
import {SquareHoleSystemDeployer} from "./DeploySquareHole.s.sol";
import {DeploymentManifest} from "./lib/DeploymentManifest.sol";
import {ManifestVerifier} from "./lib/ManifestVerifier.sol";
import {LocalUSDC, LocalWETH9} from "./local/LocalQuoteMocks.sol";

/// @title DeployBase (SH-B2 Build B item 8; Stage C/E)
/// @notice Everything the deployment, the finalizer (script/WriteManifest.s.sol) and the verifier
/// (script/VerifyManifest.s.sol) share: the per-chain configuration (`script/config/<chainId>.json`), the deployment
/// itself (`deployAll`) and the manifest writer. `Deploy` below is the entry point that broadcasts.
abstract contract DeployBase is SquareHoleSystemDeployer, DeploymentManifest, ManifestVerifier {
    using stdJson for string;

    /// @notice One launch template (registry fields chosen by the protocol, never by creators).
    struct TemplateConfig {
        uint256 startFdvQ;
        uint256 minStartUnitValueQ;
        int24 tickSpacing;
        int24 rangeTicks;
    }

    /// @notice One protocol launch of this deployment (The Misfits / FIT, then optionally ORCHARD vs FIT).
    struct LaunchConfig {
        bool enabled; // THE_MISFITS must be enabled; ORCHARD is optional (config, or env SH_LAUNCH_ORCHARD)
        SquareHoleRegistry.AssetKind kind;
        string name;
        string symbol;
        uint256 units; // collection: N NFTs (F10: the supply is always 1e9 tokens, one NFT = 1e27 / N raw)
        uint256 fractionsPerNft; // 0 or exactly 1e9 / N (a cross-check)
        string quote; // "WETH" | "USDC" | "USDT" | "FIT"
        IRewardLedger.PayoutAsset rewardSide;
        string baseURI; // immutable; tokenURI(id) = baseURI + id + ".json"
        // Metadata manifest file, path relative to the package root (env SH_METADATA_MANIFEST_<KEY> overrides it).
        // When the file exists its keccak256 is the launch's metadataManifestHash (and must equal `manifestHash` if
        // that is set); when it does not, `manifestHash` is used (simulations and the local chain only: a public-chain
        // broadcast requires the file). The committed configs pin keccak256 of the metadata lane's reviewed manifest
        // files, so the stand-in and the file agree; a regenerated manifest needs a re-pin (SH-E review).
        string manifest;
        bytes32 manifestHash; // zero: take the file's hash (no pin)
    }

    struct Config {
        uint256 chainId;
        string network;
        address poolManager; // zero: deploy from the pinned source (31337 only)
        address weth; // zero: deploy LocalWETH9 (31337 only)
        address usdc; // zero: deploy LocalUSDC (31337 only)
        bool deployMockTether;
        address registryAdmin; // zero: the deployer
        address treasury; // zero: the deployer
        bool withConverter;
        TemplateConfig wethTemplate;
        TemplateConfig usdcTemplate;
        TemplateConfig usdtTemplate;
        TemplateConfig fitTemplate; // FIT (The Misfits' T) admitted as a quote after launch 1
        LaunchConfig misfits; // launch 1: The Misfits, T symbol FIT
        LaunchConfig orchard; // launch 2 (optional): ORCHARD vs FIT
    }

    struct LaunchResult {
        bytes32 pairId; // zero: not launched (ORCHARD disabled)
        address token;
        uint32 templateVersion;
        bytes32 manifestHash;
    }

    struct Result {
        address deployer;
        uint256 startBlock;
        uint256 startTimestamp;
        address admin;
        address treasury;
        address poolManager;
        bool poolManagerFromSource;
        address weth;
        bool wethLocal;
        address usdc;
        bool usdcLocal;
        address usdt; // MockTetherUSD (zero when not deployed)
        Deployment system;
        uint32 wethTemplate;
        uint32 usdcTemplate;
        uint32 usdtTemplate;
        uint32 fitTemplate;
        LaunchResult misfits; // its T is FIT
        LaunchResult orchard;
    }

    /*//////////////////////////////////////////////////////////////
                                 CONFIG
    //////////////////////////////////////////////////////////////*/

    /// @notice Reads `script/config/<chainId>.json` (amounts as decimal strings).
    function loadConfig(uint256 chainId) public view returns (Config memory c) {
        string memory json =
            vm.readFile(string.concat(vm.projectRoot(), "/script/config/", vm.toString(chainId), ".json"));
        c.chainId = json.readUint(".chainId");
        require(c.chainId == chainId, "Deploy: config chain id mismatch");
        c.network = json.readString(".network");
        c.poolManager = json.readAddress(".poolManager");
        c.weth = json.readAddress(".quotes.WETH");
        c.usdc = json.readAddress(".quotes.USDC");
        c.deployMockTether = json.readBool(".deployMockTether");
        c.registryAdmin = json.readAddress(".registryAdmin");
        c.treasury = json.readAddress(".treasury");
        c.withConverter = json.readBool(".withConverter");
        c.wethTemplate = _templateConfig(json, ".templates.WETH");
        c.usdcTemplate = _templateConfig(json, ".templates.USDC");
        c.usdtTemplate = _templateConfig(json, ".templates.USDT");
        c.fitTemplate = _templateConfig(json, ".templates.FIT");
        c.misfits = _launchConfig(json, ".launches.THE_MISFITS");
        require(c.misfits.enabled, "Deploy: THE_MISFITS (launch 1) cannot be disabled");
        c.orchard = _launchConfig(json, ".launches.ORCHARD");
        // Budget switch without editing the committed config (e.g. SH_LAUNCH_ORCHARD=false for a Misfits-only run).
        string memory orchardEnv = vm.envOr("SH_LAUNCH_ORCHARD", string(""));
        if (bytes(orchardEnv).length != 0) {
            require(_eq(orchardEnv, "true") || _eq(orchardEnv, "false"), "Deploy: SH_LAUNCH_ORCHARD must be true/false");
            c.orchard.enabled = _eq(orchardEnv, "true");
        }
    }

    function _templateConfig(string memory json, string memory key) internal pure returns (TemplateConfig memory t) {
        t.startFdvQ = vm.parseUint(json.readString(string.concat(key, ".startFdvQ")));
        t.minStartUnitValueQ = vm.parseUint(json.readString(string.concat(key, ".minStartUnitValueQ")));
        // casting to 'int24' is safe because the config's spacing and range are small (checked by the registry)
        // forge-lint: disable-next-line(unsafe-typecast)
        t.tickSpacing = int24(json.readInt(string.concat(key, ".tickSpacing")));
        // forge-lint: disable-next-line(unsafe-typecast)
        t.rangeTicks = int24(json.readInt(string.concat(key, ".rangeTicks")));
    }

    function _launchConfig(string memory json, string memory key) internal view returns (LaunchConfig memory l) {
        string memory enabledKey = string.concat(key, ".enabled");
        l.enabled = vm.keyExistsJson(json, enabledKey) ? json.readBool(enabledKey) : true;
        string memory kind = json.readString(string.concat(key, ".kind"));
        if (_eq(kind, "collection")) l.kind = SquareHoleRegistry.AssetKind.Collection;
        else require(_eq(kind, "token"), "Deploy: kind must be token or collection");
        l.name = json.readString(string.concat(key, ".name"));
        l.symbol = json.readString(string.concat(key, ".symbol"));
        l.units = vm.parseUint(json.readString(string.concat(key, ".units")));
        l.fractionsPerNft = vm.parseUint(json.readString(string.concat(key, ".fractionsPerNft")));
        l.quote = json.readString(string.concat(key, ".quote"));
        string memory side = json.readString(string.concat(key, ".rewardSide"));
        if (_eq(side, "T")) l.rewardSide = IRewardLedger.PayoutAsset.T;
        else require(_eq(side, "Q"), "Deploy: rewardSide must be Q or T");
        l.baseURI = json.readString(string.concat(key, ".baseURI"));
        l.manifest = json.readString(string.concat(key, ".manifest"));
        string memory hashKey = string.concat(key, ".manifestHash");
        if (vm.keyExistsJson(json, hashKey)) {
            string memory h = json.readString(hashKey);
            if (bytes(h).length != 0) l.manifestHash = vm.parseBytes32(h);
        }
    }

    /*//////////////////////////////////////////////////////////////
                           METADATA MANIFESTS
    //////////////////////////////////////////////////////////////*/

    /// @notice Where a launch's metadata manifest is read: SH_METADATA_MANIFEST_<key> or the config path, relative to
    /// the package root unless absolute (it must lie inside foundry.toml's read permissions: script/config or
    /// ../../apps/web/public).
    function metadataManifestPath(LaunchConfig memory l, string memory key) public view returns (string memory) {
        string memory path = vm.envOr(string.concat("SH_METADATA_MANIFEST_", key), l.manifest);
        if (bytes(path).length != 0 && bytes(path)[0] == "/") return path;
        return string.concat(vm.projectRoot(), "/", path);
    }

    /// @notice The launch's metadata manifest commitment: keccak256 of the manifest file's bytes when it exists (then a
    /// configured `manifestHash` must equal it), otherwise the configured `manifestHash` (see LaunchConfig).
    function metadataManifestHash(LaunchConfig memory l, string memory key)
        public
        view
        returns (bytes32 h, bool fromFile)
    {
        string memory path = metadataManifestPath(l, key);
        if (vm.exists(path)) {
            h = keccak256(vm.readFileBinary(path));
            require(
                l.manifestHash == bytes32(0) || l.manifestHash == h,
                string.concat(
                    "Deploy: ",
                    key,
                    " metadata manifest file differs from the configured manifestHash (file keccak256 ",
                    vm.toString(h),
                    "; review the file, then re-pin)"
                )
            );
            return (h, true);
        }
        require(
            l.manifestHash != bytes32(0),
            string.concat("Deploy: ", key, " has neither a metadata manifest file nor a configured manifestHash")
        );
        return (l.manifestHash, false);
    }

    /// @notice A public-chain broadcast commits to the real metadata manifests (immutable per launch): every enabled
    /// launch's manifest file must exist. Simulations and the local chain may use the configured hash.
    function requireMetadataManifestFiles(Config memory c) public view {
        _requireManifestFile(c.misfits, "THE_MISFITS");
        if (c.orchard.enabled) _requireManifestFile(c.orchard, "ORCHARD");
    }

    function _requireManifestFile(LaunchConfig memory l, string memory key) internal view {
        (, bool fromFile) = metadataManifestHash(l, key);
        require(
            fromFile,
            string.concat(
                "Deploy: a public-chain broadcast needs the committed metadata manifest file of ",
                key,
                " (",
                metadataManifestPath(l, key),
                ")"
            )
        );
    }

    /*//////////////////////////////////////////////////////////////
                               DEPLOYMENT
    //////////////////////////////////////////////////////////////*/

    /// @notice The whole deployment from `deployer` (a real broadcast in a script, recorded broadcasts in tests).
    function deployAll(Config memory c, address deployer) public returns (Result memory r) {
        require(c.chainId == block.chainid, "Deploy: config is for another chain");
        require(block.chainid != 1, "Deploy: Ethereum mainnet is not authorised (G08)");
        bool local = block.chainid == LOCAL_CHAIN_ID;
        r.deployer = deployer;
        r.startBlock = block.number;
        r.startTimestamp = block.timestamp;
        r.admin = c.registryAdmin == address(0) ? deployer : c.registryAdmin;
        r.treasury = c.treasury == address(0) ? deployer : c.treasury;
        // Templates and the protocol launches are added in this same run, so the admin must sign it.
        require(r.admin == deployer, "Deploy: the registry admin must be the deployer");

        _prerequisites(c, r, local);
        r.system = deploy(
            Params({
                poolManager: IPoolManager(r.poolManager),
                admin: r.admin,
                treasury: r.treasury,
                withConverter: c.withConverter
            }),
            deployer
        );

        vm.startBroadcast(deployer);
        SquareHoleRegistry registry = r.system.registry;
        r.wethTemplate = _addTemplate(registry, r.weth, c.wethTemplate);
        r.usdcTemplate = _addTemplate(registry, r.usdc, c.usdcTemplate);
        if (r.usdt != address(0)) r.usdtTemplate = _addTemplate(registry, r.usdt, c.usdtTemplate);
        // Launch 1: The Misfits, whose fractional token is FIT (F10); then FIT becomes an admitted quote asset.
        r.misfits = _launch(r, c.misfits, "THE_MISFITS");
        r.fitTemplate = _addTemplate(registry, r.misfits.token, c.fitTemplate);
        // Launch 2 (optional): ORCHARD, quoted in FIT.
        if (c.orchard.enabled) r.orchard = _launch(r, c.orchard, "ORCHARD");
        vm.stopBroadcast();
    }

    function _prerequisites(Config memory c, Result memory r, bool local) internal {
        address deployer = r.deployer;
        r.poolManager = c.poolManager;
        if (r.poolManager == address(0)) {
            require(local, "Deploy: poolManager is required outside chain 31337");
            vm.broadcast(deployer);
            r.poolManager = deployCode("PoolManager.sol:PoolManager", abi.encode(deployer));
            r.poolManagerFromSource = true;
        }
        r.weth = c.weth;
        if (r.weth == address(0)) {
            require(local, "Deploy: WETH is required outside chain 31337");
            vm.broadcast(deployer);
            r.weth = address(new LocalWETH9());
            r.wethLocal = true;
        }
        r.usdc = c.usdc;
        if (r.usdc == address(0)) {
            require(local, "Deploy: USDC is required outside chain 31337");
            vm.broadcast(deployer);
            r.usdc = address(new LocalUSDC());
            r.usdcLocal = true;
        }
        require(r.poolManager.code.length != 0 && r.weth.code.length != 0 && r.usdc.code.length != 0, "Deploy: code");
        if (c.deployMockTether) {
            vm.broadcast(deployer);
            r.usdt = address(new MockTetherUSD(deployer));
        }
    }

    function _addTemplate(SquareHoleRegistry registry, address quote, TemplateConfig memory t)
        internal
        returns (uint32)
    {
        return registry.addTemplate(quote, t.startFdvQ, t.minStartUnitValueQ, t.tickSpacing, t.rangeTicks);
    }

    function _launch(Result memory r, LaunchConfig memory l, string memory key)
        internal
        returns (LaunchResult memory out)
    {
        out.templateVersion = _templateFor(r, l.quote);
        require(out.templateVersion != 0, "Deploy: no template for the launch quote");
        (out.manifestHash,) = metadataManifestHash(l, key);
        (out.pairId, out.token) = r.system.launcher
            .createLaunch(
                SquareHoleLauncher.LaunchParams({
                    kind: l.kind,
                    name: l.name,
                    symbol: l.symbol,
                    units: l.units,
                    fractionsPerNft: l.fractionsPerNft,
                    templateVersion: out.templateVersion,
                    payoutAsset: l.rewardSide,
                    baseURI: l.baseURI,
                    metadataManifestHash: out.manifestHash
                })
            );
    }

    function _templateFor(Result memory r, string memory quote) internal pure returns (uint32) {
        if (_eq(quote, "WETH")) return r.wethTemplate;
        if (_eq(quote, "USDC")) return r.usdcTemplate;
        if (_eq(quote, "USDT")) return r.usdtTemplate;
        if (_eq(quote, "FIT")) return r.fitTemplate;
        revert("Deploy: unknown quote key");
    }

    function _eq(string memory a, string memory b) internal pure returns (bool) {
        return _same(a, b);
    }

    /*//////////////////////////////////////////////////////////////
                                MANIFEST
    //////////////////////////////////////////////////////////////*/

    /// @notice Path of a manifest of `status` for `chainId` (see DeploymentManifest for the three kinds).
    function manifestPath(uint256 chainId, string memory status) public view returns (string memory) {
        string memory dir = _same(status, STATUS_DEPLOYED)
            ? "/deployments/"
            : (_same(status, STATUS_PENDING) ? "/deployments/pending/" : "/deployments/dry-run/");
        return string.concat(vm.projectRoot(), dir, vm.toString(chainId), ".json");
    }

    /// @notice Writes the manifest JSON of `status` to `path` (see DeploymentManifest for the schema).
    function writeManifest(
        Config memory c,
        Result memory r,
        string memory path,
        string memory status,
        Provenance memory g
    ) public returns (string memory json) {
        json = buildManifest(c, r, status, g);
        vm.writeJson(json, path);
    }

    /// @notice The manifest JSON of `status` from the state this call reads (the simulation for "simulated" and
    /// "pending-broadcast", the live chain for "deployed").
    function buildManifest(Config memory c, Result memory r, string memory status, Provenance memory g)
        public
        returns (string memory)
    {
        bool deployed = _same(status, STATUS_DEPLOYED);
        require(
            deployed || _same(status, STATUS_PENDING) || _same(status, STATUS_SIMULATED), "manifest: unknown status"
        );
        if (deployed) requireDeploymentProvenance(block.chainid, g);
        string memory root = "squarehole.deployment";
        _resetObject(root);
        vm.serializeString(root, "schema", MANIFEST_SCHEMA);
        vm.serializeUint(root, "chainId", block.chainid);
        vm.serializeString(root, "network", c.network);
        vm.serializeString(root, "status", status);
        vm.serializeBool(root, "dryRun", !deployed);
        _serializeNullableString(root, "gitCommit", g.gitCommit);
        if (bytes(g.gitDirty).length == 0) vm.serializeString(root, "gitDirty", JSON_NULL);
        else vm.serializeBool(root, "gitDirty", _same(g.gitDirty, "true"));
        _blocksJson(root, r, deployed);
        vm.serializeAddress(root, "deployer", r.deployer);
        vm.serializeAddress(root, "registryAdmin", r.admin);
        vm.serializeAddress(root, "treasury", r.treasury);
        vm.serializeString(root, "build", _buildJson());
        vm.serializeString(root, "contracts", _contractsJson(r));
        vm.serializeString(root, "templates", _templatesJson(r));
        string memory json = vm.serializeString(root, "launches", _launchesJson(c, r));
        return vm.replace(json, string.concat('"', JSON_NULL, '"'), "null");
    }

    /// @dev Deployed: the receipts' blocks (finalizer); otherwise the block of forge's local execution, named so.
    function _blocksJson(string memory root, Result memory r, bool deployed) internal {
        if (!deployed) {
            vm.serializeUint(root, "simulatedAtBlock", r.startBlock);
            vm.serializeUint(root, "simulatedAtTimestamp", r.startTimestamp);
            return;
        }
        ChainRecord memory k = _chainRecord;
        require(k.startBlock != 0 && k.endBlock >= k.startBlock, "manifest: no receipts recorded");
        vm.serializeUint(root, "startBlock", k.startBlock);
        vm.serializeUint(root, "endBlock", k.endBlock);
        if (k.startTimestamp == 0) vm.serializeString(root, "startTimestamp", JSON_NULL);
        else vm.serializeUint(root, "startTimestamp", k.startTimestamp);
        vm.serializeUint(root, "finalizedAtBlock", k.finalizedAtBlock);
        vm.serializeUint(root, "transactions", k.transactions);
        _serializeNullableString(root, "broadcastCommit", k.broadcastCommit);
    }

    function _launchesJson(Config memory c, Result memory r) internal returns (string memory) {
        string memory k = "launches";
        _resetObject(k);
        string memory json =
            vm.serializeString(k, "THE_MISFITS", _launchJsonFor(c.misfits, r, r.misfits, "THE_MISFITS"));
        if (r.orchard.pairId != bytes32(0)) {
            json = vm.serializeString(k, "ORCHARD", _launchJsonFor(c.orchard, r, r.orchard, "ORCHARD"));
        }
        return json;
    }

    function _launchJsonFor(LaunchConfig memory l, Result memory r, LaunchResult memory out, string memory key)
        internal
        returns (string memory)
    {
        (bytes32 h, bool fromFile) = metadataManifestHash(l, key);
        return _launchJson(
            string.concat("launch.", key),
            r.system.registry,
            out.pairId,
            _relativeManifestPath(l, key),
            fromFile,
            h,
            l.baseURI
        );
    }

    /// @dev The manifest path as recorded in the deployment manifest: the configured (package-relative) path, or the
    /// env override as given.
    function _relativeManifestPath(LaunchConfig memory l, string memory key) internal view returns (string memory) {
        return vm.envOr(string.concat("SH_METADATA_MANIFEST_", key), l.manifest);
    }

    function _contractsJson(Result memory r) internal returns (string memory) {
        string memory k = "contracts";
        _resetObject(k);
        Deployment memory d = r.system;
        vm.serializeString(
            k,
            "poolManager",
            _contractJson(
                "c.poolManager",
                r.poolManager,
                r.poolManagerFromSource
                    ? "PoolManager (Uniswap v4-core @ pin; LOCAL, BUSL-1.1 non-production)"
                    : "canonical Uniswap v4 PoolManager",
                r.poolManagerFromSource ? abi.encode(r.deployer) : bytes("")
            )
        );
        vm.serializeString(
            k,
            "registry",
            _contractJson(
                "c.registry", address(d.registry), "SquareHoleRegistry", abi.encode(r.admin, address(d.launcher))
            )
        );
        vm.serializeString(
            k,
            "claimConverter",
            _contractJson(
                "c.converter",
                address(d.converter),
                "SquareHoleClaimConverter",
                abi.encode(r.poolManager, address(d.registry))
            )
        );
        vm.serializeString(k, "hook", _hookJson(r));
        vm.serializeString(
            k,
            "coreDeployer",
            _contractJson("c.core", address(d.coreDeployer), "CoreDeployer", abi.encode(address(d.launcher)))
        );
        vm.serializeString(
            k,
            "collectionTokenDeployer",
            _contractJson(
                "c.collection",
                address(d.collectionDeployer),
                "CollectionTokenDeployer",
                abi.encode(address(d.launcher))
            )
        );
        vm.serializeString(
            k,
            "fungibleTokenDeployer",
            _contractJson(
                "c.fungible", address(d.fungibleDeployer), "FungibleTokenDeployer", abi.encode(address(d.launcher))
            )
        );
        vm.serializeString(
            k,
            "launcher",
            _contractJson(
                "c.launcher",
                address(d.launcher),
                "SquareHoleLauncher",
                abi.encode(
                    r.poolManager,
                    address(d.hook),
                    address(d.registry),
                    r.treasury,
                    address(d.launcher.converter()),
                    address(d.coreDeployer),
                    address(d.collectionDeployer),
                    address(d.fungibleDeployer)
                )
            )
        );
        vm.serializeString(
            k,
            "WETH",
            _contractJson("c.weth", r.weth, r.wethLocal ? "LocalWETH9 (LOCAL mock)" : "WETH9 (canonical)", bytes(""))
        );
        vm.serializeString(
            k,
            "USDC",
            _contractJson(
                "c.usdc", r.usdc, r.usdcLocal ? "LocalUSDC (LOCAL mock)" : "USDC (Circle, canonical)", bytes("")
            )
        );
        return vm.serializeString(
            k,
            "USDT",
            r.usdt == address(0)
                ? _contractJson("c.usdt", address(0), "not deployed", bytes(""))
                : _contractJson("c.usdt", r.usdt, "MockTetherUSD (USDT-TEST; testnet mock)", abi.encode(r.deployer))
        );
    }

    function _hookJson(Result memory r) internal returns (string memory) {
        string memory k = "c.hook";
        Deployment memory d = r.system;
        _resetObject(k);
        vm.serializeString(k, "contract", "SquareHoleHook");
        vm.serializeAddress(k, "address", address(d.hook));
        vm.serializeBytes32(k, "codehash", address(d.hook).codehash);
        vm.serializeBytes(k, "constructorArgs", abi.encode(r.poolManager, address(d.launcher)));
        vm.serializeAddress(k, "create2Deployer", CREATE2_DEPLOYER);
        vm.serializeBytes32(k, "salt", d.hookSalt);
        vm.serializeUint(k, "miningIterations", d.hookMiningIterations);
        // true: an identical hook was already at the planned address (squatted or front-run) and was adopted.
        vm.serializeBool(k, "adopted", d.hookAdopted);
        TxRef memory t = _deploymentTx[address(d.hook)];
        if (t.blockNumber != 0) {
            vm.serializeUint(k, "deployedAtBlock", t.blockNumber);
            vm.serializeBytes32(k, "deploymentTx", t.hash);
        }
        return vm.serializeString(k, "permissionFlags", "0x2a60");
    }

    function _templatesJson(Result memory r) internal returns (string memory) {
        string memory k = "templates";
        _resetObject(k);
        SquareHoleRegistry registry = r.system.registry;
        vm.serializeString(k, "WETH", _templateJson("t.WETH", registry, r.wethTemplate));
        vm.serializeString(k, "USDC", _templateJson("t.USDC", registry, r.usdcTemplate));
        if (r.usdtTemplate != 0) vm.serializeString(k, "USDT", _templateJson("t.USDT", registry, r.usdtTemplate));
        return vm.serializeString(k, "FIT", _templateJson("t.FIT", registry, r.fitTemplate));
    }
}

/// @title Deploy (SH-B2 Build B item 8; Stage C/E)
/// @notice The per-chain Square Hole deployment: reads `script/config/<chainId>.json`, then in one run
/// 1. on the local chain only (31337): deploys the Uniswap v4 PoolManager from the pinned source (BUSL-1.1,
///    non-production use) and local WETH9 / USDC stand-ins; public chains use the canonical addresses of the config;
/// 2. on testnets: deploys the clearly labelled mock USDT (`MockTetherUSD`, "USDT-TEST");
/// 3. the Square Hole system (registry, claim converter, hook at a CREATE2 salt mined for its flags through the
///    canonical CREATE2 deployer, adopted if an identical hook is already there, per-launch deployers, launcher;
///    `SquareHoleSystemDeployer`);
/// 4. admits WETH, USDC and USDT-TEST with their launch templates;
/// 5. launch 1, The Misfits (F10): the root NFT collection whose fractional token is FIT: DN404, name "The Misfits",
///    symbol FIT, N = 10,000 NFTs of 100,000 FIT (the fixed 1e9 supply), quote WETH, R = Q (holders earn WETH),
///    baseURI `https://squarehole-7ua.pages.dev/nft/the-misfits/` (tokenURI = baseURI + id + ".json");
/// 6. admits FIT (The Misfits' token) as a quote asset with its own template;
/// 7. launch 2 (`launches.ORCHARD.enabled`, or SH_LAUNCH_ORCHARD=true/false): ORCHARD, DN404, symbol ORCH,
///    N = 1,000 NFTs of 1,000,000 ORCH, quote FIT, R = T (holders earn ORCH through the claim converter);
///    metadata manifest commitments: keccak256 of the manifest files (a configured hash stands in while a file is
///    missing, never for a public-chain broadcast); ADR-0011 F10 addendum records every default;
/// 8. writes the manifest of forge's LOCAL execution: `deployments/pending/<chainId>.json` ("pending-broadcast") with
///    --broadcast, `deployments/dry-run/<chainId>.json` ("simulated") without. It never writes
///    `deployments/<chainId>.json`: forge runs this function before it sends any transaction, so only the read-only
///    finalizer (script/WriteManifest.s.sol), run after the broadcast, records a deployment (review round B).
/// Keys: the deployer key comes ONLY from the env var DEPLOYER_PRIVATE_KEY at run time (never from a file). Without
/// it the script only simulates, as `--sender` (a broadcast without the key is refused). Ethereum mainnet is refused.
/// Git provenance: SH_GIT_COMMIT (40-hex) and SH_GIT_DIRTY ("true" / "false"), computed by the wrappers
/// (scripts/local-e2e.sh, scripts/deploy-sepolia.sh); `forge script` cannot run git. A broadcast needs both, and on
/// any chain but 31337 a clean tree; a simulation records unknown values as null.
/// Local:   scripts/local-e2e.sh (anvil, broadcast, finalize, verify, trades, report)
/// Sepolia: scripts/deploy-sepolia.sh (simulate, mainnet-collision check, broadcast --slow, finalize, verify)
/// Sepolia simulation only (no key, no broadcast):
///          forge script script/Deploy.s.sol --rpc-url $SEPOLIA_RPC_URL --sender <the deployer's public address>
contract Deploy is DeployBase {
    function _logManifestSources(Config memory c) internal view {
        _logManifestSource(c.misfits, "THE_MISFITS");
        if (c.orchard.enabled) _logManifestSource(c.orchard, "ORCHARD");
    }

    function _logManifestSource(LaunchConfig memory l, string memory key) internal view {
        (bytes32 h, bool fromFile) = metadataManifestHash(l, key);
        console.log(
            string.concat(
                "SQUAREHOLE_DEPLOY ",
                key,
                " metadataManifestHash ",
                vm.toString(h),
                fromFile ? " (file " : " (CONFIGURED HASH; file missing: ",
                _relativeManifestPath(l, key),
                ")"
            )
        );
    }

    function run() external returns (Result memory r) {
        require(block.chainid != 1, "Deploy: Ethereum mainnet is not authorised (G08)");
        bool broadcasting = vm.isContext(VmSafe.ForgeContext.ScriptBroadcast);
        Provenance memory g = provenanceFromEnv();
        // Before any transaction is recorded: a broadcast must be attributable to a pinned, (on public chains) clean
        // commit, or the finalizer could never write its manifest.
        if (broadcasting) requireDeploymentProvenance(block.chainid, g);
        uint256 key = vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0));
        address deployer;
        if (key != 0) {
            deployer = vm.rememberKey(key);
        } else {
            require(!broadcasting, "Deploy: DEPLOYER_PRIVATE_KEY is required to broadcast");
            deployer = msg.sender; // `--sender`: simulation only
        }
        Config memory c = loadConfig(block.chainid);
        if (broadcasting && block.chainid != LOCAL_CHAIN_ID) requireMetadataManifestFiles(c);
        _logManifestSources(c);
        r = deployAll(c, deployer);
        string memory status = broadcasting ? STATUS_PENDING : STATUS_SIMULATED;
        string memory path = manifestPath(block.chainid, status);
        vm.createDir(
            string.concat(vm.projectRoot(), broadcasting ? "/deployments/pending" : "/deployments/dry-run"), true
        );
        writeManifest(c, r, path, status, g);
        console.log(string.concat("SQUAREHOLE_DEPLOY manifest (", status, ")"), path);
        console.log("SQUAREHOLE_DEPLOY registry", address(r.system.registry));
        console.log("SQUAREHOLE_DEPLOY launcher", address(r.system.launcher));
        console.log("SQUAREHOLE_DEPLOY hook", address(r.system.hook));
        console.log("SQUAREHOLE_DEPLOY hook adopted", r.system.hookAdopted);
        console.log("SQUAREHOLE_DEPLOY The Misfits (T = FIT)", r.misfits.token);
        console.log("SQUAREHOLE_DEPLOY The Misfits NFT mirror", r.system.registry.pair(r.misfits.pairId).mirror);
        console.log("SQUAREHOLE_DEPLOY FIT template", r.fitTemplate);
        if (r.orchard.pairId != bytes32(0)) {
            console.log("SQUAREHOLE_DEPLOY ORCHARD (T = ORCH)", r.orchard.token);
            console.log("SQUAREHOLE_DEPLOY ORCHARD NFT mirror", r.system.registry.pair(r.orchard.pairId).mirror);
        } else {
            console.log("SQUAREHOLE_DEPLOY ORCHARD disabled (launches.ORCHARD.enabled / SH_LAUNCH_ORCHARD)");
        }
        if (broadcasting) {
            console.log("SQUAREHOLE_DEPLOY next: after ONCHAIN EXECUTION COMPLETE & SUCCESSFUL, run the read-only");
            console.log("SQUAREHOLE_DEPLOY finalizer script/WriteManifest.s.sol (writes deployments/<chainId>.json)");
        }
    }
}
