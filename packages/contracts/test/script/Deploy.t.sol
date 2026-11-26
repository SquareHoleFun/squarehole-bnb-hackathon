// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {DN404Mirror} from "dn404/DN404Mirror.sol";
import {IRewardLedger} from "../../src/interfaces/IRewardLedger.sol";
import {RewardLedger} from "../../src/RewardLedger.sol";
import {SquareHoleRegistry} from "../../src/SquareHoleRegistry.sol";
import {SquareHoleHook} from "../../src/SquareHoleHook.sol";
import {SquareHoleToken} from "../../src/SquareHoleToken.sol";
import {MockTetherUSD} from "../../src/testnet/MockTetherUSD.sol";
import {Deploy} from "../../script/Deploy.s.sol";
import {SquareHoleSystemDeployer} from "../../script/DeploySquareHole.s.sol";

/// @notice The per-chain deployment script (SH-B2 Build B item 8; SH-E F10 plan), executed in-process with recorded
/// broadcasts: nothing is sent anywhere. Local config: PoolManager from the pinned source, local WETH/USDC, mock USDT,
/// the system, three templates, The Misfits (T = FIT), the FIT template and ORCHARD (quote FIT); the manifest JSON
/// round-trips; metadata manifest hashes follow the file-or-pinned-hash rule and the configs pin the metadata lane's
/// reviewed manifests; the Sepolia config parses to the canonical addresses and the SH-E defaults; Ethereum mainnet is
/// refused.
contract DeployScriptTest is Test {
    using stdJson for string;

    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    /// keccak256 of the metadata lane's manifests (sh-e-nft-metadata at 02043cb: apps/web/public/nft/the-misfits/ and
    /// orchard/manifest.json), pinned in script/config/31337.json and 11155111.json.
    bytes32 internal constant MISFITS_MANIFEST_HASH =
        0x8f4b336693549802635b2c52fb4885b33fd999c1d90a53af1b4c445d99f790e3;
    bytes32 internal constant ORCHARD_MANIFEST_HASH =
        0x4263aa5f7469f1c4f1f663417d7002c39a87fdd90e6e3cc65a9fbe178cdddbc0;
    /// Test fixtures for the file-present path (no config pins their hashes).
    string internal constant MISFITS_FIXTURE = "script/config/the-misfits.manifest.placeholder.json";
    string internal constant ORCHARD_FIXTURE = "script/config/orchard.manifest.placeholder.json";
    address internal deployer = makeAddr("testnetDeployer");
    Deploy internal script;

    function setUp() public {
        if (CREATE2_DEPLOYER.code.length == 0) {
            // Arachnid's deterministic deployment proxy (the same code on anvil, Sepolia and mainnet).
            vm.etch(
                CREATE2_DEPLOYER,
                hex"7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3"
            );
        }
        script = new Deploy();
    }

    function test_deployAll_localConfig_launchesTheMisfitsThenOrchard() public {
        Deploy.Config memory c = script.loadConfig(31_337);
        uint256 gasBefore = gasleft();
        Deploy.Result memory r = script.deployAll(c, deployer);
        emit log_named_uint("deployAll (local config) gas, in-process", gasBefore - gasleft());
        emit log_named_uint("transactions from the deployer", vm.getNonce(deployer));
        assertEq(vm.getNonce(deployer), 17, "4 prerequisites + 7 system + 4 templates + 2 launches");

        // Prerequisites (local only) and the mock USDT.
        assertTrue(r.poolManagerFromSource && r.wethLocal && r.usdcLocal);
        assertEq(MockTetherUSD(r.usdt).symbol(), "USDT-TEST");
        assertEq(MockTetherUSD(r.usdt).owner(), deployer);
        // System wiring.
        SquareHoleRegistry registry = r.system.registry;
        assertEq(registry.admin(), deployer);
        assertEq(registry.launcher(), address(r.system.launcher));
        assertEq(r.system.launcher.converter(), address(r.system.converter));
        assertEq(uint160(address(r.system.hook)) & 0x3FFF, 0x2A60);
        // Templates: WETH 1, USDC 2, USDT-TEST 3, then FIT 4 (The Misfits' token, admitted after launch 1).
        assertEq(registry.templateCount(), 4);
        assertEq(registry.template(r.wethTemplate).quote, r.weth);
        assertEq(registry.template(r.usdcTemplate).quote, r.usdc);
        assertEq(registry.template(r.usdtTemplate).quote, r.usdt);
        assertEq(registry.template(r.fitTemplate).quote, r.misfits.token, "FIT = The Misfits' T");
        assertEq(registry.latestTemplateFor(r.misfits.token), r.fitTemplate);
        assertEq(registry.pairCount(), 2);

        // Launch 1, The Misfits (F10): DN404 "The Misfits" / FIT, 10,000 NFTs x 100,000 FIT = 1e9 FIT, quote WETH,
        // R = Q (holders earn WETH), baseURI on the Cloudflare Pages project.
        SquareHoleRegistry.PairRecord memory m = registry.pair(r.misfits.pairId);
        SquareHoleToken misfits = SquareHoleToken(payable(m.token));
        assertEq(uint8(m.kind), uint8(SquareHoleRegistry.AssetKind.Collection));
        assertEq(misfits.name(), "The Misfits");
        assertEq(misfits.symbol(), "FIT");
        assertEq(m.units, 10_000);
        assertEq(m.fractionsPerNft, 100_000);
        assertEq(misfits.unit(), 1e23, "one NFT = 100,000 FIT");
        assertEq(m.initialSupply, 1e27);
        assertEq(m.quote, r.weth);
        assertEq(m.rewardSide, uint8(IRewardLedger.PayoutAsset.Q));
        assertEq(m.converter, address(0));
        assertEq(m.creator, deployer);
        assertEq(m.units, registry.maxCollectionUnits(m.templateVersion), "exactly the template's NFT bound");
        assertEq(misfits.baseURI(), "https://squarehole-7ua.pages.dev/nft/the-misfits/");
        assertEq(DN404Mirror(payable(m.mirror)).totalSupply(), 0, "no NFT exists before the first buy");
        assertFalse(RewardLedger(m.ledger).isExcluded(address(r.system.converter)), "R = Q: no converter role");
        // The committed commitment: the pinned keccak256 of the metadata lane's manifest (its file when merged, which
        // must then match; the pin stands in while the file is missing).
        (bytes32 h,) = script.metadataManifestHash(c.misfits, "THE_MISFITS");
        assertEq(h, MISFITS_MANIFEST_HASH, "the reviewed manifest's hash");
        assertEq(m.metadataManifestHash, h);
        assertEq(misfits.metadataManifestHash(), h);

        // Launch 2, ORCHARD: DN404 "ORCHARD" / ORCH, 1,000 NFTs x 1,000,000 ORCH, quote FIT, R = T (holders earn ORCH).
        SquareHoleRegistry.PairRecord memory o = registry.pair(r.orchard.pairId);
        SquareHoleToken orchard = SquareHoleToken(payable(o.token));
        assertEq(orchard.name(), "ORCHARD");
        assertEq(orchard.symbol(), "ORCH");
        assertEq(o.units, 1_000);
        assertEq(o.fractionsPerNft, 1_000_000);
        assertEq(o.initialSupply, 1e27);
        assertEq(o.quote, m.token, "quoted in FIT");
        assertEq(o.templateVersion, r.fitTemplate);
        assertEq(o.rewardSide, uint8(IRewardLedger.PayoutAsset.T));
        assertEq(o.converter, address(r.system.converter));
        assertTrue(RewardLedger(o.ledger).isExcluded(address(r.system.converter)));
        assertEq(orchard.baseURI(), "https://squarehole-7ua.pages.dev/nft/orchard/");
        (h,) = script.metadataManifestHash(c.orchard, "ORCHARD");
        assertEq(h, ORCHARD_MANIFEST_HASH, "the reviewed manifest's hash");
        assertEq(o.metadataManifestHash, h);
    }

    /// The Sepolia budget plan: ORCHARD disabled → 16 transactions, FIT still admitted as a quote.
    function test_deployAll_orchardDisabled_misfitsOnly() public {
        Deploy.Config memory c = script.loadConfig(31_337);
        c.orchard.enabled = false;
        Deploy.Result memory r = script.deployAll(c, deployer);
        assertEq(vm.getNonce(deployer), 16);
        assertEq(r.system.registry.pairCount(), 1);
        assertEq(r.orchard.pairId, bytes32(0));
        assertEq(r.system.registry.template(r.fitTemplate).quote, r.misfits.token);
    }

    /// tokenURI = baseURI + id + ".json" on the deployed Misfits (ADR-0011 F10 addendum).
    function test_deployAll_misfitsTokenUri() public {
        Deploy.Result memory r = script.deployAll(script.loadConfig(31_337), deployer);
        SquareHoleRegistry.PairRecord memory m = r.system.registry.pair(r.misfits.pairId);
        address holder = makeAddr("misfitsHolder");
        // Move one whole NFT's worth out of the launch inventory (the hook's rounding dust stays behind) by
        // impersonating the PoolManager, which holds the seeded supply.
        vm.prank(r.poolManager);
        SquareHoleToken(payable(m.token)).transfer(holder, 1e23);
        assertEq(DN404Mirror(payable(m.mirror)).balanceOf(holder), 1);
        uint256 id = SquareHoleToken(payable(m.token)).ownedIds(holder, 0, 1)[0];
        assertEq(
            DN404Mirror(payable(m.mirror)).tokenURI(id),
            string.concat("https://squarehole-7ua.pages.dev/nft/the-misfits/", vm.toString(id), ".json")
        );
    }

    /*//////////////////////////////////////////////////////////////
                    METADATA MANIFEST COMMITMENTS (SH-E)
    //////////////////////////////////////////////////////////////*/

    /// Both configs pin the metadata lane's reviewed manifests (sh-e-nft-metadata at 02043cb, keccak256 of
    /// apps/web/public/nft/<slug>/manifest.json): the stand-in before the merge is the same commitment the file gives
    /// after it, so the merged files deploy without a config edit. Once the files are merged here, they must match and
    /// the public-broadcast gate (both launches) must pass with the committed configs.
    function test_config_pinsTheMetadataLaneManifests() public {
        uint256[2] memory chains = [uint256(31_337), 11_155_111];
        for (uint256 i; i < 2; ++i) {
            Deploy.Config memory c = script.loadConfig(chains[i]);
            assertEq(c.misfits.manifestHash, MISFITS_MANIFEST_HASH);
            assertEq(c.orchard.manifestHash, ORCHARD_MANIFEST_HASH);
            assertEq(c.misfits.manifest, "../../apps/web/public/nft/the-misfits/manifest.json");
            assertEq(c.orchard.manifest, "../../apps/web/public/nft/orchard/manifest.json");
            // Either source gives the pinned commitment (a merged file that differs reverts here).
            (bytes32 h, bool misfitsFile) = script.metadataManifestHash(c.misfits, "THE_MISFITS");
            assertEq(h, MISFITS_MANIFEST_HASH);
            bool orchardFile;
            (h, orchardFile) = script.metadataManifestHash(c.orchard, "ORCHARD");
            assertEq(h, ORCHARD_MANIFEST_HASH);
            emit log_named_string("metadata manifest files merged", misfitsFile && orchardFile ? "yes" : "no");
            if (misfitsFile && orchardFile) {
                c.orchard.enabled = true;
                script.requireMetadataManifestFiles(c); // the Stage E broadcast gate, with ORCHARD on
            }
        }
    }

    /// File present: its keccak256 is the commitment (a pinned hash must match); file missing: the pinned hash, and a
    /// public-chain broadcast is refused. The fixtures are the committed script/config placeholder files, with pins set
    /// here (never the configs' pins).
    function test_metadataManifestHash_fileOrPinnedHash() public {
        Deploy.LaunchConfig memory l = script.loadConfig(31_337).misfits;
        bytes32 fixture = _fileHash(MISFITS_FIXTURE);
        bytes32 otherFixture = _fileHash(ORCHARD_FIXTURE);
        assertTrue(fixture != otherFixture);

        // An existing file with a matching pin, and without a pin.
        l.manifest = MISFITS_FIXTURE;
        l.manifestHash = fixture;
        (bytes32 h, bool fromFile) = script.metadataManifestHash(l, "THE_MISFITS");
        assertTrue(fromFile);
        assertEq(h, fixture);
        l.manifestHash = bytes32(0);
        (h, fromFile) = script.metadataManifestHash(l, "THE_MISFITS");
        assertTrue(fromFile);
        assertEq(h, fixture);
        // An existing file that differs from the pin (e.g. a regenerated manifest merged without a re-pin): refused,
        // and the message names the file's hash to re-pin after review.
        l.manifest = ORCHARD_FIXTURE;
        l.manifestHash = fixture;
        vm.expectRevert(
            bytes(
                string.concat(
                    "Deploy: THE_MISFITS metadata manifest file differs from the configured manifestHash (file keccak256 ",
                    vm.toString(otherFixture),
                    "; review the file, then re-pin)"
                )
            )
        );
        script.metadataManifestHash(l, "THE_MISFITS");
        // A missing file: the pin, or a refusal without one.
        l.manifest = "script/config/no-such-manifest.json";
        (h, fromFile) = script.metadataManifestHash(l, "THE_MISFITS");
        assertFalse(fromFile);
        assertEq(h, fixture);
        l.manifestHash = bytes32(0);
        vm.expectRevert("Deploy: THE_MISFITS has neither a metadata manifest file nor a configured manifestHash");
        script.metadataManifestHash(l, "THE_MISFITS");
    }

    function test_requireMetadataManifestFiles_publicBroadcastNeedsTheFiles() public {
        Deploy.Config memory c = script.loadConfig(11_155_111);
        c.misfits.manifestHash = _fileHash(MISFITS_FIXTURE); // explicit pins, independent of the committed config
        c.orchard.manifestHash = _fileHash(ORCHARD_FIXTURE);
        c.misfits.manifest = "script/config/no-such-manifest.json";
        vm.expectRevert(
            bytes(
                string.concat(
                    "Deploy: a public-chain broadcast needs the committed metadata manifest file of THE_MISFITS (",
                    vm.projectRoot(),
                    "/script/config/no-such-manifest.json)"
                )
            )
        );
        script.requireMetadataManifestFiles(c);
        c.misfits.manifest = MISFITS_FIXTURE;
        c.orchard.enabled = false;
        script.requireMetadataManifestFiles(c); // passes: the file exists (and matches the pin)
        c.orchard.enabled = true;
        c.orchard.manifest = "script/config/no-such-manifest.json";
        vm.expectRevert(
            bytes(
                string.concat(
                    "Deploy: a public-chain broadcast needs the committed metadata manifest file of ORCHARD (",
                    vm.projectRoot(),
                    "/script/config/no-such-manifest.json)"
                )
            )
        );
        script.requireMetadataManifestFiles(c);
        c.orchard.manifest = ORCHARD_FIXTURE;
        script.requireMetadataManifestFiles(c); // both files exist and match their pins
        // A file that exists but differs from its pin is refused as well (not only a missing one).
        c.orchard.manifestHash = _fileHash(MISFITS_FIXTURE);
        vm.expectRevert(
            bytes(
                string.concat(
                    "Deploy: ORCHARD metadata manifest file differs from the configured manifestHash (file keccak256 ",
                    vm.toString(_fileHash(ORCHARD_FIXTURE)),
                    "; review the file, then re-pin)"
                )
            )
        );
        script.requireMetadataManifestFiles(c);
    }

    function _fileHash(string memory rel) internal view returns (bytes32) {
        return keccak256(vm.readFileBinary(string.concat(vm.projectRoot(), "/", rel)));
    }

    function test_writeManifest_roundTripsAsJson() public {
        Deploy.Config memory c = script.loadConfig(31_337);
        Deploy.Result memory r = script.deployAll(c, deployer);
        vm.createDir(string.concat(vm.projectRoot(), "/deployments/dry-run"), true); // gitignored; absent in a clone
        string memory path = string.concat(vm.projectRoot(), "/deployments/dry-run/forge-test-31337.json");
        script.writeManifest(
            c, r, path, "simulated", script.normalizeProvenance("0123456789ABCDEF0123456789abcdef01234567", "true")
        );
        string memory json = vm.readFile(path);
        vm.removeFile(path);

        assertEq(json.readString(".schema"), "squarehole.deployment/v1");
        assertEq(json.readUint(".chainId"), 31_337);
        assertEq(json.readString(".status"), "simulated");
        assertTrue(json.readBool(".dryRun"));
        assertEq(json.readString(".gitCommit"), "0123456789abcdef0123456789abcdef01234567", "lowercased");
        assertTrue(json.readBool(".gitDirty"));
        assertEq(json.readUint(".simulatedAtBlock"), block.number);
        assertFalse(vm.keyExistsJson(json, ".startBlock"), "a simulation never claims deployment blocks");
        assertEq(json.readAddress(".deployer"), deployer);
        assertEq(json.readAddress(".contracts.registry.address"), address(r.system.registry));
        assertEq(json.readBytes32(".contracts.registry.codehash"), address(r.system.registry).codehash);
        assertEq(
            json.readBytes(".contracts.registry.constructorArgs"), abi.encode(deployer, address(r.system.launcher))
        );
        assertEq(json.readAddress(".contracts.hook.address"), address(r.system.hook));
        assertEq(json.readBytes32(".contracts.hook.salt"), r.system.hookSalt);
        assertEq(json.readAddress(".contracts.USDT.address"), r.usdt);
        assertEq(json.readUint(".templates.FIT.version"), r.fitTemplate);
        // Raw amounts are decimal strings, never JSON numbers.
        assertEq(json.readString(".templates.WETH.startFdvQ"), "1000000000000000000");
        assertEq(json.readString(".launches.THE_MISFITS.initialSupply"), "1000000000000000000000000000");
        assertEq(json.readString(".launches.THE_MISFITS.name"), "The Misfits");
        assertEq(json.readString(".launches.THE_MISFITS.symbol"), "FIT");
        assertEq(json.readString(".launches.THE_MISFITS.units"), "10000");
        assertEq(json.readString(".launches.THE_MISFITS.fractionsPerNft"), "100000");
        assertEq(json.readString(".launches.THE_MISFITS.nftUnit"), "100000000000000000000000");
        assertEq(json.readString(".launches.THE_MISFITS.rewardSide"), "Q");
        assertEq(json.readString(".launches.THE_MISFITS.baseURI"), "https://squarehole-7ua.pages.dev/nft/the-misfits/");
        assertEq(
            json.readString(".launches.THE_MISFITS.metadataManifestPath"),
            "../../apps/web/public/nft/the-misfits/manifest.json"
        );
        (, bool fromFile) = script.metadataManifestHash(c.misfits, "THE_MISFITS");
        assertEq(json.readString(".launches.THE_MISFITS.metadataManifestSource"), fromFile ? "file" : "configuredHash");
        assertEq(json.readString(".launches.ORCHARD.rewardSide"), "T");
        assertEq(json.readString(".launches.ORCHARD.symbol"), "ORCH");
        assertEq(json.readAddress(".launches.ORCHARD.quote"), r.misfits.token);
        assertEq(json.readBytes32(".launches.THE_MISFITS.pairId"), r.misfits.pairId);
        assertEq(json.readAddress(".launches.THE_MISFITS.contracts.token.address"), r.misfits.token);
        // The recorded constructor arguments are the deployed ones (what a source verifier needs).
        _assertTokenArgs(json, ".launches.THE_MISFITS", r.system.registry.pair(r.misfits.pairId));
        _assertTokenArgs(json, ".launches.ORCHARD", r.system.registry.pair(r.orchard.pairId));
        _assertLedgerArgs(json, ".launches.THE_MISFITS", r.system.registry.pair(r.misfits.pairId), address(0));
        _assertLedgerArgs(
            json, ".launches.ORCHARD", r.system.registry.pair(r.orchard.pairId), address(r.system.converter)
        );
        assertEq(
            json.readBytes(".launches.THE_MISFITS.contracts.mirror.constructorArgs"),
            abi.encode(address(r.system.collectionDeployer))
        );
        assertEq(
            json.readBytes(".launches.ORCHARD.contracts.feeCollector.constructorArgs"),
            abi.encode(
                r.orchard.token,
                r.misfits.token,
                r.system.registry.pair(r.orchard.pairId).ledger,
                deployer,
                address(r.system.hook),
                r.poolManager
            )
        );
    }

    function _assertTokenArgs(string memory json, string memory key, SquareHoleRegistry.PairRecord memory m)
        internal
        view
    {
        SquareHoleToken t = SquareHoleToken(payable(m.token));
        bytes memory args = json.readBytes(string.concat(key, ".contracts.token.constructorArgs"));
        SquareHoleToken.LaunchTerms memory terms = abi.decode(args, (SquareHoleToken.LaunchTerms));
        assertEq(terms.name, t.name());
        assertEq(terms.symbol, t.symbol());
        assertEq(terms.fractionsPerNft, t.fractionsPerNft());
        assertEq(terms.collectionSize, t.collectionSize());
        assertEq(terms.initialHolder, t.initialHolder());
        assertEq(terms.feeCollector, t.feeCollector());
        assertEq(terms.rewardLedger, t.rewardLedger());
        assertEq(terms.baseURI, t.baseURI());
        assertEq(terms.metadataManifestHash, t.metadataManifestHash());
        // The launcher passes r normalized to 1e9 / N, so the recorded argument is the one T was created with.
        assertEq(terms.fractionsPerNft, m.fractionsPerNft);
    }

    /// The ledger's constructor makes no external call: a fresh copy from the recorded arguments has exactly the
    /// deployed runtime code (every immutable included).
    function _assertLedgerArgs(
        string memory json,
        string memory key,
        SquareHoleRegistry.PairRecord memory m,
        address converter
    ) internal {
        bytes memory ledgerArgs = json.readBytes(string.concat(key, ".contracts.rewardLedger.constructorArgs"));
        RewardLedger.Config memory lc = abi.decode(ledgerArgs, (RewardLedger.Config));
        assertEq(lc.converter, converter);
        assertTrue(lc.nftMirror);
        address copy = deployCode("RewardLedger.sol:RewardLedger", ledgerArgs);
        assertEq(keccak256(copy.code), keccak256(m.ledger.code), "ledger runtime reproduced from the manifest");
    }

    /*//////////////////////////////////////////////////////////////
                 HOOK SQUATTING (review round B, blocking)
    //////////////////////////////////////////////////////////////*/

    /// Review round B: the hook's init code and salt are public (deployer address and nonce), so anyone can deploy the
    /// byte-identical hook at the planned address through the public CREATE2 deployer before the deployment runs.
    /// The deployment adopts it (same init code, checked code hash) and consumes the hook's nonce with a 0-value no-op
    /// call (`registry.templateCount()` as a transaction), so the launcher still lands at nonce + 6 where the hook
    /// expects it.
    function test_deployAll_adoptsAHookSquattedAtThePlannedAddress() public {
        Deploy.Config memory c = script.loadConfig(31_337);
        // The PoolManager, WETH and USDC come first on the local chain (nonces 0..2), the mock USDT at 3; the system
        // starts at nonce 4. The probe mirrors the script's plan from public data only.
        address squatted = new HookSquatProbe().squat(script, deployer, 4, vm.computeCreateAddress(deployer, 0));
        assertGt(squatted.code.length, 0, "the probe pre-deployed the hook");
        Deploy.Result memory r = script.deployAll(c, deployer);
        assertEq(address(r.system.hook), squatted, "the pre-deployed hook is adopted");
        assertTrue(r.system.hookAdopted);
        assertEq(r.system.hook.launcher(), address(r.system.launcher), "the nonce plan held");
        assertEq(address(r.system.launcher), vm.computeCreateAddress(deployer, 4 + 6));
        assertEq(vm.getNonce(deployer), 17, "same number of deployer transactions as without the squat");
        // The adopted deployment launches and trades like any other.
        assertEq(r.system.registry.pair(r.misfits.pairId).hook, squatted);
    }

    /// Code that is NOT the hook's init-code output can never sit at the planned address (CREATE2 binds the init
    /// code), but the script checks the code hash anyway and refuses anything else.
    function test_deployAll_refusesForeignCodeAtThePlannedHookAddress() public {
        Deploy.Config memory c = script.loadConfig(31_337);
        HookSquatProbe probe = new HookSquatProbe();
        address planned = probe.plannedHook(script, deployer, 4, vm.computeCreateAddress(deployer, 0));
        vm.etch(planned, hex"00");
        vm.expectRevert("hook: foreign code at the planned address");
        script.deployAll(c, deployer);
    }

    function test_loadConfig_sepoliaUsesTheCanonicalAddresses() public {
        Deploy.Config memory c = script.loadConfig(11_155_111);
        assertEq(c.poolManager, 0xE03A1074c86CFeDd5C142C4F04F1a1536e203543);
        assertEq(c.weth, 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14);
        assertEq(c.usdc, 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238);
        assertTrue(c.deployMockTether && c.withConverter);
        // SH-E plan (F10): The Misfits / FIT, 10,000 NFTs, WETH, R = Q; ORCHARD vs FIT behind the budget flag.
        assertTrue(c.misfits.enabled);
        assertEq(c.misfits.name, "The Misfits");
        assertEq(c.misfits.symbol, "FIT");
        assertEq(c.misfits.units, 10_000);
        assertEq(c.misfits.fractionsPerNft, 100_000);
        assertEq(c.misfits.quote, "WETH");
        assertEq(uint8(c.misfits.rewardSide), uint8(IRewardLedger.PayoutAsset.Q));
        assertEq(c.misfits.baseURI, "https://squarehole-7ua.pages.dev/nft/the-misfits/");
        assertEq(c.orchard.name, "ORCHARD");
        assertEq(c.orchard.symbol, "ORCH");
        assertEq(c.orchard.units, 1_000);
        assertEq(c.orchard.quote, "FIT");
        assertEq(uint8(c.orchard.rewardSide), uint8(IRewardLedger.PayoutAsset.T));
        assertEq(c.orchard.baseURI, "https://squarehole-7ua.pages.dev/nft/orchard/");
        emit log_named_string("ORCHARD enabled on Sepolia by default", c.orchard.enabled ? "true" : "false");
    }

    function test_run_refusesEthereumMainnet() public {
        vm.chainId(1);
        vm.expectRevert("Deploy: Ethereum mainnet is not authorised (G08)");
        script.run();
    }

    function test_deployAll_refusesAConfigOfAnotherChain() public {
        Deploy.Config memory c = script.loadConfig(11_155_111);
        vm.expectRevert("Deploy: config is for another chain");
        script.deployAll(c, deployer);
    }
}

/// @notice Review round B's squatting probe: computes the deployment's hook init code and salt from public data (the
/// deployer's address and nonce) and deploys the identical hook through the public CREATE2 deployer first.
contract HookSquatProbe {
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    function plannedHook(SquareHoleSystemDeployer script, address deployer, uint256 systemNonce, address poolManager)
        public
        view
        returns (address)
    {
        (bytes32 salt, bytes memory init) = _plan(script, deployer, systemNonce, poolManager);
        return
            address(
                uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), CREATE2_DEPLOYER, salt, keccak256(init)))))
            );
    }

    function squat(SquareHoleSystemDeployer script, address deployer, uint256 systemNonce, address poolManager)
        external
        returns (address hook)
    {
        (bytes32 salt, bytes memory init) = _plan(script, deployer, systemNonce, poolManager);
        (bool ok, bytes memory ret) = CREATE2_DEPLOYER.call(abi.encodePacked(salt, init));
        require(ok && ret.length == 20, "probe: CREATE2 failed");
        hook = address(bytes20(ret));
    }

    function _plan(SquareHoleSystemDeployer script, address deployer, uint256 systemNonce, address poolManager)
        internal
        view
        returns (bytes32 salt, bytes memory init)
    {
        address launcher = _createAddress(deployer, systemNonce + 6);
        init = abi.encodePacked(type(SquareHoleHook).creationCode, abi.encode(poolManager, launcher));
        (salt,) = script.mineHookSalt(keccak256(init));
    }

    function _createAddress(address a, uint256 nonce) internal pure returns (address) {
        require(nonce > 0 && nonce < 0x80, "probe: small nonces only");
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xd6), bytes1(0x94), a, uint8(nonce))))));
    }
}
