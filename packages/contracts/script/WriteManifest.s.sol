// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console} from "forge-std/console.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {SquareHoleClaimConverter} from "../src/SquareHoleClaimConverter.sol";
import {SquareHoleHook} from "../src/SquareHoleHook.sol";
import {SquareHoleLauncher} from "../src/SquareHoleLauncher.sol";
import {SquareHoleRegistry} from "../src/SquareHoleRegistry.sol";
import {CollectionTokenDeployer, CoreDeployer, FungibleTokenDeployer} from "../src/deployers/LaunchDeployers.sol";
import {DeployBase} from "./Deploy.s.sol";

/// @title WriteManifest (review round B): the post-broadcast, READ-ONLY finalizer of a deployment
/// @notice `script/Deploy.s.sol --broadcast` writes only `deployments/pending/<chainId>.json` (its plan, from forge's
/// local execution before any transaction is sent). After the broadcast, this script reads
/// - forge's broadcast record `broadcast/Deploy.s.sol/<chainId>/run-latest.json` (every transaction with its receipt),
/// - the pending plan, and
/// - the live chain (the RPC the script runs against),
/// and writes `deployments/<chainId>.json` ("deployed") only if all three agree:
/// - every transaction came from the planned deployer and succeeded, nothing is pending, and nothing unexpected was
///   sent (the hook's CREATE2 alone may have failed, when an identical hook front-ran it: then its code is checked and
///   adopted; a hook adopted before the run shows up as the no-op `registry.templateCount()` call instead);
/// - every contract of the plan was created by one of those transactions (or, for the canonical PoolManager, WETH and
///   USDC, exists), and every planned address has code with exactly the planned code hash;
/// - the hook sits at the CREATE2 address of the planned salt and the hook's init code, with its permission bits;
/// - `addTemplate` and `createLaunch` landed in the blocks the live registry records (`addedAtBlock`,
///   `createdAtBlock`); the manifest takes its block fields from the receipts and the registry, never from the plan;
/// - git provenance: SH_GIT_COMMIT is a 40-hex commit equal to the plan's and prefixed by forge's own record of the
///   run, SH_GIT_DIRTY is explicit and equal to the plan's, and on every chain but 31337 it is "false".
/// The finished JSON is re-verified against the chain (`ManifestVerifier`) before it is written. Nothing is broadcast.
/// Run: SH_GIT_COMMIT=… SH_GIT_DIRTY=… forge script script/WriteManifest.s.sol --rpc-url <the deployment's RPC>
/// (SH_BROADCAST_FILE overrides the broadcast record's path).
contract WriteManifest is DeployBase {
    using stdJson for string;

    /// @notice One transaction of forge's broadcast record, joined with its receipt.
    struct BroadcastTx {
        bytes32 hash;
        string txType; // "CREATE" | "CREATE2" | "CALL"
        string contractName; // "" when forge recorded null
        address contractAddress; // zero when null
        address from;
        address to; // zero when null
        string fn; // "" when null
        bool success;
        uint256 blockNumber;
        uint256 blockTimestamp; // from the receipt's first log (0 when absent)
        address[] created; // `additionalContracts` (contracts created inside the call)
    }

    struct BroadcastRun {
        uint256 chainId;
        string commit; // forge's short git commit of the run ("" when null)
        uint256 pending; // transactions still pending
        BroadcastTx[] txs;
    }

    function run() external returns (Result memory r) {
        require(block.chainid != 1, "WriteManifest: Ethereum mainnet is not authorised (G08)");
        string memory broadcastFile = vm.envOr(
            "SH_BROADCAST_FILE",
            string.concat(vm.projectRoot(), "/broadcast/Deploy.s.sol/", vm.toString(block.chainid), "/run-latest.json")
        );
        BroadcastRun memory b = parseBroadcast(vm.readFile(broadcastFile));
        string memory pending = vm.readFile(manifestPath(block.chainid, STATUS_PENDING));
        string memory out = manifestPath(block.chainid, STATUS_DEPLOYED);
        r = finalize(loadConfig(block.chainid), pending, b, provenanceFromEnv(), out);
        console.log("SQUAREHOLE_FINALIZE broadcast record", broadcastFile);
        console.log("SQUAREHOLE_FINALIZE transactions", b.txs.length);
        console.log("SQUAREHOLE_FINALIZE blocks", _chainRecord.startBlock, _chainRecord.endBlock);
        console.log("SQUAREHOLE_FINALIZE manifest (deployed, verified against the chain)", out);
    }

    /*//////////////////////////////////////////////////////////////
                          BROADCAST RECORD PARSER
    //////////////////////////////////////////////////////////////*/

    /// @notice Parses forge's `run-latest.json` (transactions joined with receipts by hash).
    function parseBroadcast(string memory json) public view returns (BroadcastRun memory b) {
        b.chainId = json.readUint(".chain");
        b.commit = _nullable(json.readStringOr(".commit", "null"));
        while (vm.keyExistsJson(json, string.concat(".pending[", vm.toString(b.pending), "]"))) {
            ++b.pending;
        }
        uint256 n;
        while (vm.keyExistsJson(json, string.concat(".transactions[", vm.toString(n), "]"))) {
            ++n;
        }
        uint256 m;
        while (vm.keyExistsJson(json, string.concat(".receipts[", vm.toString(m), "]"))) {
            ++m;
        }
        bytes32[] memory receiptHashes = new bytes32[](m);
        for (uint256 j; j < m; ++j) {
            receiptHashes[j] = json.readBytes32(string.concat(".receipts[", vm.toString(j), "].transactionHash"));
        }
        b.txs = new BroadcastTx[](n);
        for (uint256 i; i < n; ++i) {
            b.txs[i] = _parseTx(json, i, receiptHashes);
        }
    }

    function _parseTx(string memory json, uint256 i, bytes32[] memory receiptHashes)
        internal
        view
        returns (BroadcastTx memory t)
    {
        string memory k = string.concat(".transactions[", vm.toString(i), "]");
        t.hash = json.readBytes32(string.concat(k, ".hash"));
        t.txType = json.readString(string.concat(k, ".transactionType"));
        t.contractName = _nullable(json.readStringOr(string.concat(k, ".contractName"), "null"));
        t.contractAddress = _nullableAddress(json.readStringOr(string.concat(k, ".contractAddress"), "null"));
        t.from = json.readAddress(string.concat(k, ".transaction.from"));
        t.to = _nullableAddress(json.readStringOr(string.concat(k, ".transaction.to"), "null"));
        t.fn = _nullable(json.readStringOr(string.concat(k, ".function"), "null"));
        uint256 created;
        while (vm.keyExistsJson(json, string.concat(k, ".additionalContracts[", vm.toString(created), "]"))) {
            ++created;
        }
        t.created = new address[](created);
        for (uint256 c; c < created; ++c) {
            t.created[c] = json.readAddress(string.concat(k, ".additionalContracts[", vm.toString(c), "].address"));
        }
        uint256 j = type(uint256).max;
        for (uint256 x; x < receiptHashes.length; ++x) {
            if (receiptHashes[x] == t.hash) j = x;
        }
        require(j != type(uint256).max, "finalize: a transaction has no receipt (forge script --resume)");
        string memory rk = string.concat(".receipts[", vm.toString(j), "]");
        t.success = json.readUint(string.concat(rk, ".status")) == 1;
        t.blockNumber = json.readUint(string.concat(rk, ".blockNumber"));
        if (vm.keyExistsJson(json, string.concat(rk, ".logs[0].blockTimestamp"))) {
            t.blockTimestamp = json.readUint(string.concat(rk, ".logs[0].blockTimestamp"));
        }
    }

    function _nullable(string memory s) internal pure returns (string memory) {
        return _same(s, "null") ? "" : s;
    }

    function _nullableAddress(string memory s) internal pure returns (address) {
        return _same(s, "null") || bytes(s).length == 0 ? address(0) : vm.parseAddress(s);
    }

    /*//////////////////////////////////////////////////////////////
                                FINALIZE
    //////////////////////////////////////////////////////////////*/

    /// @notice Checks the broadcast record and the plan against the live chain, then writes the deployed manifest to
    /// `out` (see the contract notice). Reverts, writing nothing, on any mismatch.
    function finalize(
        Config memory c,
        string memory pending,
        BroadcastRun memory b,
        Provenance memory g,
        string memory out
    ) public returns (Result memory r) {
        requireDeploymentProvenance(block.chainid, g);
        require(b.chainId == block.chainid && c.chainId == block.chainid, "finalize: broadcast record chain id");
        require(b.pending == 0, "finalize: transactions still pending (forge script --resume)");
        require(b.txs.length != 0, "finalize: empty broadcast record");
        require(_same(pending.readString(".status"), STATUS_PENDING), "finalize: not a pending-broadcast plan");
        require(pending.readUint(".chainId") == block.chainid, "finalize: plan chain id");
        require(_same(pending.readString(".gitCommit"), g.gitCommit), "finalize: SH_GIT_COMMIT differs from the plan's");
        require(
            pending.readBool(".gitDirty") == _same(g.gitDirty, "true"), "finalize: SH_GIT_DIRTY differs from the plan's"
        );
        require(
            bytes(b.commit).length == 0 || _startsWith(g.gitCommit, vm.toLowercase(b.commit)),
            "finalize: forge recorded the broadcast at another commit"
        );

        r.deployer = pending.readAddress(".deployer");
        bool hookFrontRun = _recordTransactions(b, r.deployer);
        _resultFromChain(c, pending, b, r);
        r.system.hookAdopted = r.system.hookAdopted || hookFrontRun;
        _checkTemplateBlocks(b, r);
        _checkLaunches(b, r, pending);
        _chainRecord.finalizedAtBlock = block.number;
        _chainRecord.broadcastCommit = b.commit;
        _chainRecord.transactions = b.txs.length;

        string memory json = buildManifest(c, r, STATUS_DEPLOYED, g);
        _matchesPlan(json, pending, ".contracts");
        _matchesPlan(json, pending, ".launches.THE_MISFITS.contracts");
        if (r.orchard.pairId != bytes32(0)) _matchesPlan(json, pending, ".launches.ORCHARD.contracts");
        verifyManifest(json);
        vm.writeJson(json, out);
    }

    /// Every transaction from the deployer and successful (only the hook's CREATE2 may have failed: front-run);
    /// records the receipt block and hash of every contract created. Returns whether the hook CREATE2 failed.
    function _recordTransactions(BroadcastRun memory b, address deployer) internal returns (bool hookFrontRun) {
        uint256 first = type(uint256).max;
        uint256 last;
        for (uint256 i; i < b.txs.length; ++i) {
            BroadcastTx memory t = b.txs[i];
            require(t.from == deployer, "finalize: a transaction from another sender");
            require(t.blockNumber != 0, "finalize: receipt without a block");
            if (t.blockNumber < first) {
                first = t.blockNumber;
                _chainRecord.startTimestamp = t.blockTimestamp;
            }
            if (t.blockNumber > last) last = t.blockNumber;
            if (!t.success) {
                require(
                    _same(t.txType, "CREATE2") && _same(t.contractName, "SquareHoleHook") && !hookFrontRun,
                    "finalize: a transaction failed (fix the cause, then forge script --resume)"
                );
                hookFrontRun = true;
                continue;
            }
            if (t.contractAddress != address(0) && !_same(t.txType, "CALL")) {
                _deploymentTx[t.contractAddress] = TxRef(t.hash, t.blockNumber);
            }
            for (uint256 j; j < t.created.length; ++j) {
                _deploymentTx[t.created[j]] = TxRef(t.hash, t.blockNumber);
            }
        }
        _chainRecord.startBlock = first;
        _chainRecord.endBlock = last;
    }

    /// The deployment's contracts: created ones by name from the broadcast record, the rest from the live wiring,
    /// every one required to equal the plan.
    function _resultFromChain(Config memory c, string memory pending, BroadcastRun memory b, Result memory r)
        internal
        view
    {
        uint256 expectedTxs = 7; // registry, converter, hook (CREATE2 or the no-op), 3 deployers, launcher
        r.system.registry = SquareHoleRegistry(_createdByName(b, "SquareHoleRegistry"));
        r.system.converter = SquareHoleClaimConverter(_createdByName(b, "SquareHoleClaimConverter"));
        r.system.coreDeployer = CoreDeployer(_createdByName(b, "CoreDeployer"));
        r.system.collectionDeployer = CollectionTokenDeployer(_createdByName(b, "CollectionTokenDeployer"));
        r.system.fungibleDeployer = FungibleTokenDeployer(_createdByName(b, "FungibleTokenDeployer"));
        r.system.launcher = SquareHoleLauncher(_createdByName(b, "SquareHoleLauncher"));
        r.system.hook = r.system.launcher.hook();
        r.admin = r.system.registry.admin();
        r.treasury = r.system.launcher.treasury();
        r.poolManager = address(r.system.launcher.poolManager());
        if (!c.withConverter) r.system.converter = SquareHoleClaimConverter(address(0));
        require(r.system.launcher.converter() == address(r.system.converter), "finalize: converter wiring");
        require(r.system.registry.launcher() == address(r.system.launcher), "finalize: registry wiring");
        require(r.admin == r.deployer, "finalize: registry admin");

        // Quotes and the local-only prerequisites.
        r.poolManagerFromSource = c.poolManager == address(0);
        if (r.poolManagerFromSource) {
            require(_deploymentTx[r.poolManager].blockNumber != 0, "finalize: PoolManager not created by the run");
            ++expectedTxs;
        } else {
            require(r.poolManager == c.poolManager, "finalize: PoolManager differs from the config");
        }
        (r.weth, r.wethLocal) = c.weth == address(0) ? (_createdByName(b, "LocalWETH9"), true) : (c.weth, false);
        (r.usdc, r.usdcLocal) = c.usdc == address(0) ? (_createdByName(b, "LocalUSDC"), true) : (c.usdc, false);
        if (r.wethLocal) ++expectedTxs;
        if (r.usdcLocal) ++expectedTxs;
        if (c.deployMockTether) {
            r.usdt = _createdByName(b, "MockTetherUSD");
            ++expectedTxs;
        }

        _hookFromPlan(pending, b, r);
        r.wethTemplate = _templateVersion(pending, ".templates.WETH", r.system.registry, r.weth);
        r.usdcTemplate = _templateVersion(pending, ".templates.USDC", r.system.registry, r.usdc);
        if (r.usdt != address(0)) {
            r.usdtTemplate = _templateVersion(pending, ".templates.USDT", r.system.registry, r.usdt);
        }
        // Launch 1 (The Misfits, T = FIT) always; launch 2 (ORCHARD vs FIT) when the PLAN has it (the config's or
        // SH_LAUNCH_ORCHARD's choice at broadcast time; the finalizer never re-decides it).
        r.misfits = _launchFromPlan(pending, ".launches.THE_MISFITS.pairId", r.system.registry);
        r.fitTemplate = _templateVersion(pending, ".templates.FIT", r.system.registry, r.misfits.token);
        uint256 launches = 1;
        if (vm.keyExistsJson(pending, ".launches.ORCHARD")) {
            r.orchard = _launchFromPlan(pending, ".launches.ORCHARD.pairId", r.system.registry);
            ++launches;
        }
        expectedTxs += (r.usdt != address(0) ? 4 : 3) + launches; // addTemplate calls + createLaunch calls
        require(b.txs.length == expectedTxs, "finalize: unexpected transactions in the broadcast record");
    }

    function _launchFromPlan(string memory pending, string memory key, SquareHoleRegistry registry)
        internal
        view
        returns (LaunchResult memory out)
    {
        out.pairId = pending.readBytes32(key);
        SquareHoleRegistry.PairRecord memory p = registry.pair(out.pairId);
        require(p.token != address(0), string.concat("finalize: launch not in the registry: ", key));
        out.token = p.token;
        out.templateVersion = p.templateVersion;
        out.manifestHash = p.metadataManifestHash;
    }

    /// The hook: at the launcher's hook address = the plan's, at the CREATE2 address of the plan's salt and the hook's
    /// init code, created by the run's CREATE2 (or adopted: then the run's no-op `registry.templateCount()` call used its
    /// nonce).
    function _hookFromPlan(string memory pending, BroadcastRun memory b, Result memory r) internal pure {
        address hook = address(r.system.hook);
        require(hook == pending.readAddress(".contracts.hook.address"), "finalize: hook differs from the plan");
        r.system.hookSalt = pending.readBytes32(".contracts.hook.salt");
        r.system.hookMiningIterations = pending.readUint(".contracts.hook.miningIterations");
        r.system.hookAdopted = pending.readBool(".contracts.hook.adopted");
        bytes memory init = abi.encodePacked(
            type(SquareHoleHook).creationCode, abi.encode(IPoolManager(r.poolManager), address(r.system.launcher))
        );
        require(hookAddress(r.system.hookSalt, keccak256(init)) == hook, "finalize: hook is not the salt's CREATE2");
        require(uint160(hook) & 0x3FFF == HOOK_FLAGS, "finalize: hook permission bits");
        bool create2;
        bool noOp;
        for (uint256 i; i < b.txs.length; ++i) {
            BroadcastTx memory t = b.txs[i];
            if (_same(t.txType, "CREATE2") && t.contractAddress == hook) create2 = true;
            if (_same(t.txType, "CALL") && t.to == address(r.system.registry) && _same(t.fn, "templateCount()")) {
                noOp = true;
            }
        }
        require(r.system.hookAdopted ? (noOp && !create2) : (create2 && !noOp), "finalize: hook transaction");
    }

    function _templateVersion(string memory pending, string memory key, SquareHoleRegistry registry, address quote)
        internal
        view
        returns (uint32 v)
    {
        // casting to 'uint32' is safe because template versions are uint32 in the registry
        // forge-lint: disable-next-line(unsafe-typecast)
        v = uint32(pending.readUint(string.concat(key, ".version")));
        require(v != 0 && registry.template(v).quote == quote, string.concat("finalize: template ", key));
    }

    /// `addTemplate` receipts, in order, landed in the blocks the registry records.
    function _checkTemplateBlocks(BroadcastRun memory b, Result memory r) internal view {
        uint32[4] memory order = [r.wethTemplate, r.usdcTemplate, r.usdtTemplate, r.fitTemplate];
        uint256 next;
        for (uint256 i; i < b.txs.length; ++i) {
            BroadcastTx memory t = b.txs[i];
            if (!_same(t.txType, "CALL") || !_startsWith(t.fn, "addTemplate(")) continue;
            require(t.to == address(r.system.registry), "finalize: addTemplate to another contract");
            while (next < 4 && order[next] == 0) ++next;
            require(next < 4, "finalize: too many addTemplate calls");
            require(
                r.system.registry.template(order[next]).addedAtBlock == t.blockNumber,
                "finalize: template block differs from its receipt"
            );
            ++next;
        }
    }

    /// `createLaunch` receipts (The Misfits, then ORCHARD when planned) created the recorded token, landed in the
    /// recorded block.
    function _checkLaunches(BroadcastRun memory b, Result memory r, string memory pending) internal view {
        bytes32[2] memory ids = [r.misfits.pairId, r.orchard.pairId];
        uint256 expected = r.orchard.pairId == bytes32(0) ? 1 : 2;
        uint256 next;
        for (uint256 i; i < b.txs.length; ++i) {
            BroadcastTx memory t = b.txs[i];
            if (!_same(t.txType, "CALL") || !_startsWith(t.fn, "createLaunch(")) continue;
            require(t.to == address(r.system.launcher) && next < expected, "finalize: unexpected createLaunch");
            SquareHoleRegistry.PairRecord memory p = r.system.registry.pair(ids[next]);
            require(p.createdAtBlock == t.blockNumber, "finalize: launch block differs from its receipt");
            require(p.creator == r.deployer, "finalize: launch creator");
            bool token;
            for (uint256 j; j < t.created.length; ++j) {
                if (t.created[j] == p.token) token = true;
            }
            require(token, "finalize: the launch transaction did not create the recorded token");
            ++next;
        }
        require(next == expected, "finalize: the planned launches (The Misfits, ORCHARD if planned)");
        require(
            r.misfits.token == pending.readAddress(".launches.THE_MISFITS.contracts.token.address"),
            "finalize: launch tokens differ from the plan"
        );
        if (expected == 2) {
            require(
                r.orchard.token == pending.readAddress(".launches.ORCHARD.contracts.token.address"),
                "finalize: launch tokens differ from the plan"
            );
        }
    }

    /// Every contract under `root`: the address and the (live) code hash equal the plan's.
    function _matchesPlan(string memory json, string memory pending, string memory root) internal pure {
        string[] memory keys = vm.parseJsonKeys(pending, root);
        for (uint256 i; i < keys.length; ++i) {
            string memory k = string.concat(root, ".", keys[i]);
            require(
                json.readAddress(string.concat(k, ".address")) == pending.readAddress(string.concat(k, ".address")),
                string.concat("finalize: address differs from the plan: ", keys[i])
            );
            require(
                json.readBytes32(string.concat(k, ".codehash")) == pending.readBytes32(string.concat(k, ".codehash")),
                string.concat("finalize: code hash differs from the plan: ", keys[i])
            );
        }
    }

    function _createdByName(BroadcastRun memory b, string memory name) internal pure returns (address a) {
        for (uint256 i; i < b.txs.length; ++i) {
            BroadcastTx memory t = b.txs[i];
            if (_same(t.contractName, name) && _same(t.txType, "CREATE") && t.success) {
                require(a == address(0), string.concat("finalize: two contracts named ", name));
                a = t.contractAddress;
            }
        }
        require(a != address(0), string.concat("finalize: not created by the run: ", name));
    }

    function _startsWith(string memory s, string memory prefix) internal pure returns (bool) {
        bytes memory a = bytes(s);
        bytes memory p = bytes(prefix);
        if (p.length > a.length) return false;
        for (uint256 i; i < p.length; ++i) {
            if (a[i] != p[i]) return false;
        }
        return true;
    }
}
