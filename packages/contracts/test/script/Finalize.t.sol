// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {SquareHoleRegistry} from "../../src/SquareHoleRegistry.sol";
import {DeployBase} from "../../script/Deploy.s.sol";
import {DeploymentManifest} from "../../script/lib/DeploymentManifest.sol";
import {WriteManifest} from "../../script/WriteManifest.s.sol";
import {HookSquatProbe} from "./Deploy.t.sol";

/// @notice Review round B (blocking): the deployment manifest is a record of the CHAIN, not of forge's pre-broadcast
/// simulation. `Deploy.run()` writes only a "pending-broadcast" plan; the read-only finalizer (script/WriteManifest.s.sol)
/// writes `deployments/<chainId>.json` from the broadcast receipts and the live registry, after checking addresses,
/// code hashes, the hook, every transaction and the git provenance. Here the "simulation" runs at block 5 and the
/// "chain" at blocks 90…100 (the same transactions from the same nonces), as on anvil (simulation at block 0, receipts
/// in blocks 1…17) or on Sepolia.
contract FinalizeTest is Test {
    using stdJson for string;

    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    string internal constant COMMIT = "0123456789abcdef0123456789abcdef01234567";
    uint256 internal constant SIM_BLOCK = 5;
    uint256 internal constant FIRST_BLOCK = 90;
    uint256 internal constant CALL_BLOCK = 100;
    uint256 internal constant HEAD_BLOCK = 130;

    address internal deployer = makeAddr("testnetDeployer");
    WriteManifest internal script;

    function setUp() public {
        if (CREATE2_DEPLOYER.code.length == 0) {
            vm.etch(
                CREATE2_DEPLOYER,
                hex"7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3"
            );
        }
        script = new WriteManifest();
        vm.createDir(string.concat(vm.projectRoot(), "/deployments/dry-run"), true); // gitignored
    }

    /// @dev One file per test (suites and tests run in parallel). msg.sig is the running test's selector only inside
    /// the test's own call (in setUp it is setUp's, which made every test share one file: a race, fixed in SH-E).
    function _outPath() internal view returns (string memory) {
        return string.concat(
            vm.projectRoot(), "/deployments/dry-run/forge-test-finalized-", vm.toString(uint32(msg.sig)), ".json"
        );
    }

    function _clean() internal view returns (DeploymentManifest.Provenance memory) {
        return script.normalizeProvenance(COMMIT, "false");
    }

    /// Forge's local execution (block 5) writes the plan; then the same transactions "land" in blocks 90…100.
    function _planThenLand()
        internal
        returns (DeployBase.Config memory c, DeployBase.Result memory r, string memory pending)
    {
        return _planThenLandWith(true);
    }

    function _planThenLandWith(bool orchard)
        internal
        returns (DeployBase.Config memory c, DeployBase.Result memory r, string memory pending)
    {
        // A stale output from an interrupted run (e.g. a mutation smoke check) would fake "written" or "nothing written".
        if (vm.exists(_outPath())) vm.removeFile(_outPath());
        c = script.loadConfig(31_337);
        c.orchard.enabled = orchard;
        uint256 snapshot = vm.snapshotState();
        vm.roll(SIM_BLOCK);
        DeployBase.Result memory sim = script.deployAll(c, deployer);
        pending = script.buildManifest(c, sim, "pending-broadcast", _clean());
        vm.revertToState(snapshot);
        vm.roll(CALL_BLOCK);
        r = script.deployAll(c, deployer);
        vm.roll(HEAD_BLOCK);
    }

    /// The broadcast record forge writes for the local config (17 transactions, in nonce order): prerequisites, the
    /// system, three templates, The Misfits, the FIT template, ORCHARD.
    function _broadcast(DeployBase.Result memory r) internal view returns (WriteManifest.BroadcastRun memory b) {
        b.chainId = 31_337;
        b.commit = "0123456";
        b.txs = new WriteManifest.BroadcastTx[](17);
        address[] memory none = new address[](0);
        b.txs[0] = _tx("CREATE", "", r.poolManager, address(0), "", FIRST_BLOCK, none);
        b.txs[1] = _tx("CREATE", "LocalWETH9", r.weth, address(0), "", FIRST_BLOCK + 1, none);
        b.txs[2] = _tx("CREATE", "LocalUSDC", r.usdc, address(0), "", FIRST_BLOCK + 2, none);
        b.txs[3] = _tx("CREATE", "MockTetherUSD", r.usdt, address(0), "", FIRST_BLOCK + 3, none);
        b.txs[4] = _tx("CREATE", "SquareHoleRegistry", address(r.system.registry), address(0), "", 94, none);
        b.txs[5] = _tx("CREATE", "SquareHoleClaimConverter", address(r.system.converter), address(0), "", 95, none);
        b.txs[6] = _tx("CREATE2", "SquareHoleHook", address(r.system.hook), CREATE2_DEPLOYER, "", 96, none);
        b.txs[7] = _tx("CREATE", "CoreDeployer", address(r.system.coreDeployer), address(0), "", 97, none);
        b.txs[8] =
            _tx("CREATE", "CollectionTokenDeployer", address(r.system.collectionDeployer), address(0), "", 98, none);
        b.txs[9] = _tx("CREATE", "FungibleTokenDeployer", address(r.system.fungibleDeployer), address(0), "", 99, none);
        b.txs[10] = _tx("CREATE", "SquareHoleLauncher", address(r.system.launcher), address(0), "", 99, none);
        address registry = address(r.system.registry);
        string memory addTemplate = "addTemplate(address,uint256,uint256,int24,int24)";
        b.txs[11] = _tx("CALL", "SquareHoleRegistry", registry, registry, addTemplate, CALL_BLOCK, none);
        b.txs[12] = _tx("CALL", "SquareHoleRegistry", registry, registry, addTemplate, CALL_BLOCK, none);
        b.txs[13] = _tx("CALL", "SquareHoleRegistry", registry, registry, addTemplate, CALL_BLOCK, none);
        address launcher = address(r.system.launcher);
        string memory createLaunch = "createLaunch((uint8,string,string,uint256,uint256,uint32,uint8,string,bytes32))";
        b.txs[14] = _tx(
            "CALL", "SquareHoleLauncher", launcher, launcher, createLaunch, CALL_BLOCK, _created(r, r.misfits.pairId)
        );
        b.txs[15] = _tx("CALL", "SquareHoleRegistry", registry, registry, addTemplate, CALL_BLOCK, none);
        if (r.orchard.pairId == bytes32(0)) {
            WriteManifest.BroadcastTx[] memory txs = new WriteManifest.BroadcastTx[](16);
            for (uint256 i; i < 16; ++i) {
                txs[i] = b.txs[i];
            }
            b.txs = txs;
            return b;
        }
        b.txs[16] = _tx(
            "CALL", "SquareHoleLauncher", launcher, launcher, createLaunch, CALL_BLOCK, _created(r, r.orchard.pairId)
        );
    }

    function _tx(
        string memory txType,
        string memory name,
        address contractAddress,
        address to,
        string memory fn,
        uint256 blockNumber,
        address[] memory created
    ) internal view returns (WriteManifest.BroadcastTx memory t) {
        t.hash = keccak256(abi.encode(txType, name, contractAddress, fn, blockNumber, created));
        t.txType = txType;
        t.contractName = name;
        t.contractAddress = contractAddress;
        t.from = deployer;
        t.to = to;
        t.fn = fn;
        t.success = true;
        t.blockNumber = blockNumber;
        t.blockTimestamp = blockNumber == FIRST_BLOCK ? 1_790_000_000 : 0;
        t.created = created;
    }

    function _created(DeployBase.Result memory r, bytes32 pairId) internal view returns (address[] memory a) {
        SquareHoleRegistry.PairRecord memory p = r.system.registry.pair(pairId);
        a = new address[](p.mirror == address(0) ? 3 : 4);
        (a[0], a[1], a[2]) = (p.ledger, p.collector, p.token);
        if (p.mirror != address(0)) a[3] = p.mirror;
    }

    function _finalize(
        DeployBase.Config memory c,
        string memory pending,
        WriteManifest.BroadcastRun memory b,
        DeploymentManifest.Provenance memory g
    ) internal returns (string memory json) {
        script.finalize(c, pending, b, g, _outPath());
        json = vm.readFile(_outPath());
        vm.removeFile(_outPath());
    }

    /*//////////////////////////////////////////////////////////////
                         BLOCKS COME FROM THE CHAIN
    //////////////////////////////////////////////////////////////*/

    function test_finalize_blocksComeFromTheReceiptsAndTheLiveRegistry() public {
        (DeployBase.Config memory c, DeployBase.Result memory r, string memory pending) = _planThenLand();
        SquareHoleRegistry registry = r.system.registry;
        // The plan carries the SIMULATION's blocks (this was the bug: the old manifest said 0 on anvil).
        assertEq(pending.readString(".status"), "pending-broadcast");
        assertTrue(pending.readBool(".dryRun"));
        assertEq(pending.readUint(".simulatedAtBlock"), SIM_BLOCK);
        assertEq(pending.readUint(".launches.THE_MISFITS.createdAtBlock"), SIM_BLOCK);

        string memory json = _finalize(c, pending, _broadcast(r), _clean());

        assertEq(json.readString(".status"), "deployed");
        assertFalse(json.readBool(".dryRun"));
        assertEq(json.readString(".gitCommit"), COMMIT);
        assertFalse(json.readBool(".gitDirty"));
        assertEq(json.readString(".broadcastCommit"), "0123456");
        assertEq(json.readUint(".startBlock"), FIRST_BLOCK, "first receipt");
        assertEq(json.readUint(".endBlock"), CALL_BLOCK, "last receipt");
        assertEq(json.readUint(".startTimestamp"), 1_790_000_000, "from the first receipt's logs");
        assertEq(json.readUint(".finalizedAtBlock"), HEAD_BLOCK);
        assertEq(json.readUint(".transactions"), 17);
        assertFalse(vm.keyExistsJson(json, ".simulatedAtBlock"));
        // Registry blocks: the live registry's, equal to the receipts'.
        assertEq(
            json.readUint(".launches.THE_MISFITS.createdAtBlock"),
            registry.pair(r.misfits.pairId).createdAtBlock,
            "createdAtBlock == registry.pair(id).createdAtBlock"
        );
        assertEq(json.readUint(".launches.THE_MISFITS.createdAtBlock"), CALL_BLOCK);
        assertEq(json.readUint(".launches.ORCHARD.createdAtBlock"), registry.pair(r.orchard.pairId).createdAtBlock);
        assertEq(json.readString(".launches.THE_MISFITS.symbol"), "FIT");
        assertEq(json.readString(".launches.THE_MISFITS.nftUnit"), "100000000000000000000000");
        assertEq(json.readString(".launches.ORCHARD.nftUnit"), "1000000000000000000000000");
        assertEq(json.readAddress(".launches.ORCHARD.quote"), r.misfits.token, "ORCHARD is quoted in FIT");
        assertEq(json.readUint(".templates.WETH.addedAtBlock"), registry.template(r.wethTemplate).addedAtBlock);
        assertEq(json.readUint(".templates.FIT.addedAtBlock"), CALL_BLOCK);
        // Each contract carries the block and hash of the transaction that created it.
        assertEq(json.readUint(".contracts.registry.deployedAtBlock"), 94);
        assertEq(json.readBytes32(".contracts.registry.deploymentTx"), _broadcast(r).txs[4].hash);
        assertEq(json.readUint(".contracts.hook.deployedAtBlock"), 96);
        assertFalse(json.readBool(".contracts.hook.adopted"));
        assertEq(json.readUint(".launches.THE_MISFITS.contracts.mirror.deployedAtBlock"), CALL_BLOCK);
        assertEq(json.readUint(".contracts.WETH.deployedAtBlock"), FIRST_BLOCK + 1, "LocalWETH9, created by the run");
        // Everything else is as before (addresses and code hashes of the plan, now read from the chain).
        assertEq(json.readAddress(".contracts.launcher.address"), address(r.system.launcher));
        assertEq(json.readBytes32(".contracts.hook.codehash"), address(r.system.hook).codehash);
        script.verifyManifest(json);
    }

    /// The budget plan without launch 2 (Sepolia default `launches.ORCHARD.enabled: false`): 16 transactions. The
    /// finalizer takes the launch set from the PLAN, whatever the config or SH_LAUNCH_ORCHARD say at finalization.
    function test_finalize_misfitsOnlyPlan() public {
        (DeployBase.Config memory c, DeployBase.Result memory r, string memory pending) = _planThenLandWith(false);
        assertFalse(vm.keyExistsJson(pending, ".launches.ORCHARD"), "the plan has no ORCHARD");
        assertEq(r.orchard.pairId, bytes32(0));
        WriteManifest.BroadcastRun memory b = _broadcast(r);
        assertEq(b.txs.length, 16);
        c.orchard.enabled = true; // a config flipped after the broadcast does not change what is recorded
        string memory json = _finalize(c, pending, b, _clean());
        assertEq(json.readUint(".transactions"), 16);
        assertFalse(vm.keyExistsJson(json, ".launches.ORCHARD"));
        assertEq(json.readUint(".templates.FIT.version"), r.fitTemplate);
        assertEq(json.readAddress(".templates.FIT.quote"), r.misfits.token, "FIT admitted even without ORCHARD");
        script.verifyManifest(json);
        // An ORCHARD createLaunch the plan does not contain is an unexpected transaction.
        WriteManifest.BroadcastTx[] memory txs = new WriteManifest.BroadcastTx[](17);
        for (uint256 i; i < 16; ++i) {
            txs[i] = b.txs[i];
        }
        txs[16] = b.txs[14];
        b.txs = txs;
        DeploymentManifest.Provenance memory g = _clean();
        vm.expectRevert("finalize: unexpected transactions in the broadcast record");
        script.finalize(c, pending, b, g, _outPath());
    }

    /// SH-E review: the recorded `metadataManifestSource` / `metadataManifestPath` must describe the on-chain
    /// commitment. A file at finalization whose bytes differ from what the launch committed (possible without a pin),
    /// or a configured hash that differs, is refused instead of being recorded as the source; nothing is written.
    function test_finalize_refusesAMetadataManifestThatDiffersFromTheChain() public {
        (DeployBase.Config memory c, DeployBase.Result memory r, string memory pending) = _planThenLand();
        WriteManifest.BroadcastRun memory b = _broadcast(r);
        DeploymentManifest.Provenance memory g = _clean();
        bytes32 committed = r.system.registry.pair(r.misfits.pairId).metadataManifestHash;
        assertEq(committed, c.misfits.manifestHash, "the launch committed the config's pin");

        // A manifest file without a pin: its keccak256 is not the launch's commitment.
        c.misfits.manifest = "script/config/the-misfits.manifest.placeholder.json";
        c.misfits.manifestHash = bytes32(0);
        (bytes32 h, bool fromFile) = script.metadataManifestHash(c.misfits, "THE_MISFITS");
        assertTrue(fromFile && h != committed);
        vm.expectRevert(
            "manifest: launch.THE_MISFITS metadata manifest file differs from the on-chain metadataManifestHash"
        );
        script.finalize(c, pending, b, g, _outPath());
        // No file and a configured hash other than the commitment.
        c.misfits.manifest = "script/config/no-such-manifest.json";
        c.misfits.manifestHash = keccak256("another manifest");
        vm.expectRevert(
            "manifest: launch.THE_MISFITS configured manifestHash differs from the on-chain metadataManifestHash"
        );
        script.finalize(c, pending, b, g, _outPath());
        assertFalse(vm.exists(_outPath()), "nothing written");

        // The committed config finalizes and records the commitment with its source.
        c = script.loadConfig(31_337);
        (, fromFile) = script.metadataManifestHash(c.misfits, "THE_MISFITS");
        string memory json = _finalize(c, pending, b, g);
        assertEq(json.readBytes32(".launches.THE_MISFITS.metadataManifestHash"), committed);
        assertEq(json.readString(".launches.THE_MISFITS.metadataManifestSource"), fromFile ? "file" : "configuredHash");
    }

    /// A front-run of the hook's CREATE2 (an identical hook deployed first from the mempool) makes only that
    /// transaction revert; after `--resume` the rest lands. The finalizer adopts the identical hook (code hash = plan).
    function test_finalize_adoptsAHookWhoseCreate2WasFrontRun() public {
        (DeployBase.Config memory c, DeployBase.Result memory r, string memory pending) = _planThenLand();
        WriteManifest.BroadcastRun memory b = _broadcast(r);
        b.txs[6].success = false;
        string memory json = _finalize(c, pending, b, _clean());
        assertTrue(json.readBool(".contracts.hook.adopted"));
        assertFalse(vm.keyExistsJson(json, ".contracts.hook.deployedAtBlock"), "not created by this deployment");
    }

    /// A hook squatted BEFORE the run: the plan already says "adopted", and the broadcast record has the no-op
    /// `registry.templateCount()` call in the hook's nonce slot instead of a CREATE2.
    function test_finalize_acceptsAHookAdoptedBeforeTheRun() public {
        address squatted = new HookSquatProbe().squat(script, deployer, 4, vm.computeCreateAddress(deployer, 0));
        (DeployBase.Config memory c, DeployBase.Result memory r, string memory pending) = _planThenLand();
        assertEq(address(r.system.hook), squatted);
        assertTrue(pending.readBool(".contracts.hook.adopted"), "the plan knows");
        WriteManifest.BroadcastRun memory b = _broadcast(r);
        address registry = address(r.system.registry);
        b.txs[6] = _tx("CALL", "SquareHoleRegistry", registry, registry, "templateCount()", 96, new address[](0));
        string memory json = _finalize(c, pending, b, _clean());
        assertTrue(json.readBool(".contracts.hook.adopted"));
        assertEq(json.readAddress(".contracts.hook.address"), squatted);
        // Without the no-op (e.g. a CREATE2 recorded instead) the record does not match the plan.
        b = _broadcast(r);
        DeploymentManifest.Provenance memory g = _clean();
        vm.expectRevert("finalize: hook transaction");
        script.finalize(c, pending, b, g, _outPath());
    }

    /*//////////////////////////////////////////////////////////////
                         REFUSALS (NOTHING WRITTEN)
    //////////////////////////////////////////////////////////////*/

    function test_finalize_refusesAFailedPendingOrUnexpectedTransaction() public {
        (DeployBase.Config memory c, DeployBase.Result memory r, string memory pending) = _planThenLand();
        WriteManifest.BroadcastRun memory b = _broadcast(r);
        DeploymentManifest.Provenance memory g = _clean();

        b.txs[10].success = false; // the launcher: a broadcast that failed partway
        vm.expectRevert("finalize: a transaction failed (fix the cause, then forge script --resume)");
        script.finalize(c, pending, b, g, _outPath());

        b = _broadcast(r);
        b.pending = 1;
        vm.expectRevert("finalize: transactions still pending (forge script --resume)");
        script.finalize(c, pending, b, g, _outPath());

        b = _broadcast(r);
        b.txs[3].from = makeAddr("someoneElse");
        vm.expectRevert("finalize: a transaction from another sender");
        script.finalize(c, pending, b, g, _outPath());

        // An extra transaction the plan does not contain.
        WriteManifest.BroadcastRun memory extra = _broadcast(r);
        WriteManifest.BroadcastTx[] memory txs = new WriteManifest.BroadcastTx[](18);
        for (uint256 i; i < 17; ++i) {
            txs[i] = extra.txs[i];
        }
        address registry = address(r.system.registry);
        txs[17] = _tx("CALL", "SquareHoleRegistry", registry, registry, "retireTemplate(uint32)", 101, new address[](0));
        extra.txs = txs;
        vm.expectRevert("finalize: unexpected transactions in the broadcast record");
        script.finalize(c, pending, extra, g, _outPath());

        // A launch that landed in another block than the registry records.
        b = _broadcast(r);
        b.txs[16].blockNumber = CALL_BLOCK - 1;
        vm.expectRevert("finalize: launch block differs from its receipt");
        script.finalize(c, pending, b, g, _outPath());
        assertFalse(vm.exists(_outPath()), "nothing written");
    }

    function test_finalize_refusesACodeHashOrAddressThatDiffersFromThePlan() public {
        (DeployBase.Config memory c, DeployBase.Result memory r, string memory pending) = _planThenLand();
        WriteManifest.BroadcastRun memory b = _broadcast(r);
        DeploymentManifest.Provenance memory g = _clean();
        string memory wrongHash = vm.replace(
            pending, vm.toString(address(r.system.converter).codehash), vm.toString(bytes32(uint256(0xbad)))
        );
        vm.expectRevert("finalize: code hash differs from the plan: claimConverter");
        script.finalize(c, wrongHash, b, g, _outPath());
        // The plan's hook is elsewhere (e.g. a plan from another nonce).
        string memory wrongHook =
            vm.replace(pending, vm.toString(address(r.system.hook)), vm.toString(makeAddr("elsewhere")));
        vm.expectRevert("finalize: hook differs from the plan");
        script.finalize(c, wrongHook, b, g, _outPath());
        assertFalse(vm.exists(_outPath()), "nothing written");
    }

    /// Git provenance: a deployed manifest needs the 40-hex commit and an explicit dirty flag, both equal to the plan's
    /// (the broadcast run's), and forge's own short commit of the run must match.
    function test_finalize_refusesUnknownOrMismatchedProvenance() public {
        (DeployBase.Config memory c, DeployBase.Result memory r, string memory pending) = _planThenLand();
        WriteManifest.BroadcastRun memory b = _broadcast(r);
        DeploymentManifest.Provenance memory unknownCommit = script.normalizeProvenance("unknown", "false");
        DeploymentManifest.Provenance memory unknownDirty = script.normalizeProvenance(COMMIT, "");
        DeploymentManifest.Provenance memory otherCommit =
            script.normalizeProvenance("fedcba9876543210fedcba9876543210fedcba98", "false");
        DeploymentManifest.Provenance memory dirty = script.normalizeProvenance(COMMIT, "true");
        DeploymentManifest.Provenance memory clean = _clean();

        vm.expectRevert("provenance: SH_GIT_COMMIT must be the 40-hex commit (git rev-parse HEAD)");
        script.finalize(c, pending, b, unknownCommit, _outPath());
        vm.expectRevert("provenance: SH_GIT_DIRTY must be set explicitly to true or false");
        script.finalize(c, pending, b, unknownDirty, _outPath());
        vm.expectRevert("finalize: SH_GIT_COMMIT differs from the plan's");
        script.finalize(c, pending, b, otherCommit, _outPath());
        vm.expectRevert("finalize: SH_GIT_DIRTY differs from the plan's");
        script.finalize(c, pending, b, dirty, _outPath());
        b.commit = "b726ead";
        vm.expectRevert("finalize: forge recorded the broadcast at another commit");
        script.finalize(c, pending, b, clean, _outPath());
        assertFalse(vm.exists(_outPath()), "nothing written");
    }

    function test_provenance_unknownIsNeverAValueAndPublicChainsNeedACleanTree() public view {
        // Unknown inputs normalize to "" (written as JSON null), never to a default.
        DeploymentManifest.Provenance memory g = script.normalizeProvenance("b726ead", "");
        assertEq(g.gitCommit, "");
        assertEq(g.gitDirty, "");
        g = script.normalizeProvenance("0123456789abcdef0123456789abcdef0123456g", "yes");
        assertEq(g.gitCommit, "", "non-hex");
        assertEq(g.gitDirty, "", "only true / false");
        g = script.normalizeProvenance(COMMIT, "true");
        script.requireDeploymentProvenance(31_337, g); // local chain: a dirty tree is recorded, not refused
        script.requireDeploymentProvenance(11_155_111, script.normalizeProvenance(COMMIT, "false"));
    }

    function test_provenance_publicChainRefusesADirtyTree() public {
        DeploymentManifest.Provenance memory g = script.normalizeProvenance(COMMIT, "true");
        vm.expectRevert("provenance: a public-chain deployment needs a clean tree (SH_GIT_DIRTY=false)");
        script.requireDeploymentProvenance(11_155_111, g);
    }

    function test_manifest_unknownProvenanceIsNull() public {
        DeployBase.Config memory c = script.loadConfig(31_337);
        DeployBase.Result memory r = script.deployAll(c, deployer);
        DeploymentManifest.Provenance memory unknown = script.normalizeProvenance("", "");
        string memory json = script.buildManifest(c, r, "simulated", unknown);
        assertEq(json.readString(".gitCommit"), "null", "JSON null");
        assertEq(json.readString(".gitDirty"), "null", "JSON null, not false");
        vm.expectRevert("provenance: SH_GIT_COMMIT must be the 40-hex commit (git rev-parse HEAD)");
        script.buildManifest(c, r, "deployed", unknown);
    }

    /*//////////////////////////////////////////////////////////////
                               VERIFIER
    //////////////////////////////////////////////////////////////*/

    function test_verifyManifest_rejectsATamperedManifest() public {
        (DeployBase.Config memory c, DeployBase.Result memory r, string memory pending) = _planThenLand();
        string memory json = _finalize(c, pending, _broadcast(r), _clean());
        script.verifyManifest(json);

        vm.expectRevert("verify: launch block .launches.ORCHARD");
        script.verifyManifest(vm.replace(json, '"createdAtBlock": 100', '"createdAtBlock": 99'));
        vm.expectRevert("verify: code hash of registry");
        script.verifyManifest(
            vm.replace(json, vm.toString(address(r.system.registry).codehash), vm.toString(bytes32(uint256(1))))
        );
        vm.expectRevert("verify: a public-chain manifest must come from a clean tree");
        vm.chainId(11_155_111);
        script.verifyManifest(
            vm.replace(
                vm.replace(json, '"gitDirty": false', '"gitDirty": true'), '"chainId": 31337', '"chainId": 11155111'
            )
        );
    }

    /*//////////////////////////////////////////////////////////////
                         BROADCAST RECORD PARSER
    //////////////////////////////////////////////////////////////*/

    /// The fields the finalizer reads, in forge's run-latest.json shape: nulls, hex quantities, receipts joined by hash
    /// (in any order), `additionalContracts`, the first log's block timestamp.
    function test_parseBroadcast_readsAForgeRunRecord() public view {
        string memory json = string.concat(
            '{"transactions":[',
            '{"hash":"0x',
            _h(1),
            '","transactionType":"CREATE","contractName":null,"contractAddress":"0x5fbdb2315678afecb367f032d93f642f64180aa3",',
            '"function":null,"arguments":null,"transaction":{"from":"0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266","to":null,',
            '"gas":"0x1","value":"0x0","input":"0x00","nonce":"0x0","chainId":"0x7a69"},"additionalContracts":[],"isFixedGasLimit":false},',
            '{"hash":"0x',
            _h(2),
            '","transactionType":"CALL","contractName":"SquareHoleLauncher","contractAddress":"0x610178da211fef7d417bc0e6fed39f05609ad788",',
            '"function":"createLaunch((uint8))","arguments":["x"],"transaction":{"from":"0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",',
            '"to":"0x610178da211fef7d417bc0e6fed39f05609ad788","gas":"0x1","value":"0x0","input":"0x00","nonce":"0x1","chainId":"0x7a69"},',
            '"additionalContracts":[{"transactionType":"CREATE","contractName":"RewardLedger","address":"0x9bd03768a7dcc129555de410ff8e85528a4f88b5","initCode":"0x00"}],',
            '"isFixedGasLimit":false}],',
            '"receipts":[{"status":"0x0","transactionHash":"0x',
            _h(2),
            '","blockNumber":"0x11","logs":[]},',
            '{"status":"0x1","transactionHash":"0x',
            _h(1),
            '","blockNumber":"0x1","logs":[{"blockNumber":"0x1","blockTimestamp":"0x6aac1e1c"}]}],',
            '"libraries":[],"pending":[],"returns":{},"timestamp":1790371111009,"chain":31337,"commit":"90304c9"}'
        );
        WriteManifest.BroadcastRun memory b = script.parseBroadcast(json);
        assertEq(b.chainId, 31_337);
        assertEq(b.commit, "90304c9");
        assertEq(b.pending, 0);
        assertEq(b.txs.length, 2);
        assertEq(b.txs[0].contractName, "", "null name");
        assertEq(b.txs[0].to, address(0), "null to");
        assertEq(b.txs[0].fn, "", "null function");
        assertEq(b.txs[0].contractAddress, 0x5FbDB2315678afecb367f032d93F642f64180aa3);
        assertTrue(b.txs[0].success);
        assertEq(b.txs[0].blockNumber, 1);
        assertEq(b.txs[0].blockTimestamp, 0x6aac1e1c);
        assertEq(b.txs[1].fn, "createLaunch((uint8))");
        assertFalse(b.txs[1].success, "status 0x0");
        assertEq(b.txs[1].blockNumber, 17);
        assertEq(b.txs[1].created.length, 1);
        assertEq(b.txs[1].created[0], 0x9bd03768a7DCc129555dE410FF8E85528A4F88b5);
    }

    function _h(uint256 i) internal pure returns (string memory) {
        bytes memory s = bytes(vm.toString(bytes32(i)));
        bytes memory out = new bytes(64);
        for (uint256 k; k < 64; ++k) {
            out[k] = s[k + 2];
        }
        return string(out);
    }
}
