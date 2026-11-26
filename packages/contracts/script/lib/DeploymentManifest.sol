// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {FeeCollector} from "../../src/FeeCollector.sol";
import {RewardLedger} from "../../src/RewardLedger.sol";
import {SquareHoleFungibleToken} from "../../src/SquareHoleFungibleToken.sol";
import {SquareHoleHook} from "../../src/SquareHoleHook.sol";
import {SquareHoleRegistry} from "../../src/SquareHoleRegistry.sol";
import {SquareHoleToken} from "../../src/SquareHoleToken.sol";
import {IRewardLedger} from "../../src/interfaces/IRewardLedger.sol";

/// @title DeploymentManifest
/// @notice JSON writers of the deployment manifests (schema `squarehole.deployment/v1`). Conventions: raw amounts
/// and prices are DECIMAL STRINGS (never JSON numbers: JavaScript loses precision above 2^53); chain ids, blocks,
/// timestamps, ticks and template versions are numbers; addresses are EIP-55; `constructorArgs` is the exact ABI
/// encoding a verifier (Sourcify, Blockscout) needs; `codehash` is EXTCODEHASH of the state the writer reads. Per launch
/// the manifest also carries the ledger, collector, token and mirror constructor arguments, reconstructed from the
/// registry record and re-checked against the deployed contracts.
/// `status` says which state a manifest describes (review round B):
/// - "simulated" (`deployments/dry-run/<chainId>.json`): forge's local execution of a run without --broadcast;
/// - "pending-broadcast" (`deployments/pending/<chainId>.json`): forge's local execution of a --broadcast run, written
///   BEFORE any transaction is sent; the plan the finalizer checks the chain against, never a deployment record;
/// - "deployed" (`deployments/<chainId>.json`): written only by script/WriteManifest.s.sol after the broadcast, from
///   the broadcast receipts and the live chain, and only after every address, code hash and registry record matched.
/// Block fields: a deployed manifest has `startBlock` / `endBlock` (receipts) and registry blocks read from the chain;
/// the other two carry `simulatedAtBlock` and the simulation's registry blocks. Git provenance (`gitCommit`,
/// `gitDirty`) is null when unknown, never a default.
abstract contract DeploymentManifest is Script {
    string internal constant MANIFEST_SCHEMA = "squarehole.deployment/v1";
    string internal constant STATUS_SIMULATED = "simulated";
    string internal constant STATUS_PENDING = "pending-broadcast";
    string internal constant STATUS_DEPLOYED = "deployed";
    uint256 internal constant LOCAL_CHAIN_ID = 31_337;
    /// @dev Placeholder replaced by a JSON null after serialization (vm.serialize* cannot write null).
    string internal constant JSON_NULL = "__squarehole_json_null__";

    /// @notice Git provenance of a run: a 40-hex commit (lowercase) or "" when unknown; "true" / "false" or "" when
    /// unknown. Forge scripts cannot run git (FFI stays off), so wrappers pass SH_GIT_COMMIT and SH_GIT_DIRTY.
    struct Provenance {
        string gitCommit;
        string gitDirty;
    }

    /// @notice Where a deployment's transactions landed (set only by the finalizer, from the broadcast receipts).
    struct TxRef {
        bytes32 hash;
        uint256 blockNumber;
    }

    /// @notice Chain facts of a finalized deployment (set only by the finalizer).
    struct ChainRecord {
        uint256 startBlock; // first receipt
        uint256 endBlock; // last receipt
        uint256 startTimestamp; // block timestamp of startBlock from the receipt logs; 0 = not reported by the RPC
        uint256 finalizedAtBlock; // the chain head the finalizer read
        string broadcastCommit; // forge's short commit recorded in the broadcast file
        uint256 transactions;
    }

    mapping(address => TxRef) internal _deploymentTx;
    ChainRecord internal _chainRecord;

    /*//////////////////////////////////////////////////////////////
                               PROVENANCE
    //////////////////////////////////////////////////////////////*/

    /// @notice SH_GIT_COMMIT / SH_GIT_DIRTY, normalized: anything but a 40-hex commit and an explicit "true" / "false"
    /// is unknown (recorded as null).
    function provenanceFromEnv() public view returns (Provenance memory) {
        return normalizeProvenance(vm.envOr("SH_GIT_COMMIT", string("")), vm.envOr("SH_GIT_DIRTY", string("")));
    }

    function normalizeProvenance(string memory commit, string memory dirty) public pure returns (Provenance memory g) {
        if (_isCommit(commit)) g.gitCommit = vm.toLowercase(commit);
        if (_same(dirty, "true") || _same(dirty, "false")) g.gitDirty = dirty;
    }

    /// @notice What a broadcast and a deployed manifest need: a 40-hex commit, an explicit dirty flag and, on every
    /// chain but the local one, a clean tree.
    function requireDeploymentProvenance(uint256 chainId, Provenance memory g) public pure {
        require(
            bytes(g.gitCommit).length == 40, "provenance: SH_GIT_COMMIT must be the 40-hex commit (git rev-parse HEAD)"
        );
        require(bytes(g.gitDirty).length != 0, "provenance: SH_GIT_DIRTY must be set explicitly to true or false");
        require(
            chainId == LOCAL_CHAIN_ID || _same(g.gitDirty, "false"),
            "provenance: a public-chain deployment needs a clean tree (SH_GIT_DIRTY=false)"
        );
    }

    function _isCommit(string memory s) internal pure returns (bool) {
        bytes memory b = bytes(s);
        if (b.length != 40) return false;
        for (uint256 i; i < 40; ++i) {
            bytes1 c = b[i];
            bool hex_ = (c >= "0" && c <= "9") || (c >= "a" && c <= "f") || (c >= "A" && c <= "F");
            if (!hex_) return false;
        }
        return true;
    }

    function _same(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }

    /// @dev vm.serialize* objects persist per key for the whole run; every writer starts from an empty object.
    function _resetObject(string memory k) internal {
        vm.serializeJson(k, "{}");
    }

    function _serializeNullableString(string memory k, string memory key, string memory value) internal {
        vm.serializeString(k, key, bytes(value).length == 0 ? JSON_NULL : value);
    }
    /// @dev Pins (packages/contracts/DEPENDENCIES.md); the manifest repeats them for reviewers.
    string internal constant PIN_V4_CORE = "46c6834698c48bc4a463a86d8420f4eb1d7f3b75";
    string internal constant PIN_V4_PERIPHERY = "9969eec44cfdf07e24b41de47f40276a58401976";
    string internal constant PIN_DN404 = "3397cb11558ac853912ee87871422b6a29c9d346";
    string internal constant PIN_FORGE_STD = "bf647bd6046f2f7da30d0c2bf435e5c76a780c1b";

    function _buildJson() internal returns (string memory) {
        string memory k = "build";
        _resetObject(k);
        vm.serializeString(k, "solc", "0.8.26");
        vm.serializeString(k, "evmVersion", "cancun");
        vm.serializeUint(k, "optimizerRuns", 1_000);
        vm.serializeBool(k, "viaIR", false);
        vm.serializeString(k, "bytecodeHash", "none");
        vm.serializeString(k, "v4-core", PIN_V4_CORE);
        vm.serializeString(k, "v4-periphery", PIN_V4_PERIPHERY);
        vm.serializeString(k, "dn404", PIN_DN404);
        vm.serializeString(k, "forge-std", PIN_FORGE_STD);
        // Creation-code hashes of the per-launch templates (what every launch deploys; bytecode_hash = none).
        vm.serializeBytes32(k, "SquareHoleToken.creationCodeHash", keccak256(type(SquareHoleToken).creationCode));
        vm.serializeBytes32(
            k, "SquareHoleFungibleToken.creationCodeHash", keccak256(type(SquareHoleFungibleToken).creationCode)
        );
        vm.serializeBytes32(k, "RewardLedger.creationCodeHash", keccak256(type(RewardLedger).creationCode));
        return vm.serializeBytes32(k, "FeeCollector.creationCodeHash", keccak256(type(FeeCollector).creationCode));
    }

    function _contractJson(string memory k, address a, string memory kind, bytes memory constructorArgs)
        internal
        returns (string memory)
    {
        _resetObject(k);
        vm.serializeString(k, "contract", kind);
        vm.serializeAddress(k, "address", a);
        vm.serializeBytes32(k, "codehash", a == address(0) ? bytes32(0) : a.codehash);
        TxRef memory t = _deploymentTx[a];
        if (a != address(0) && t.blockNumber != 0) {
            vm.serializeUint(k, "deployedAtBlock", t.blockNumber);
            vm.serializeBytes32(k, "deploymentTx", t.hash);
        }
        return vm.serializeBytes(k, "constructorArgs", constructorArgs);
    }

    function _templateJson(string memory k, SquareHoleRegistry registry, uint32 version)
        internal
        returns (string memory)
    {
        SquareHoleRegistry.LaunchTemplate memory t = registry.template(version);
        _resetObject(k);
        vm.serializeUint(k, "version", version);
        vm.serializeAddress(k, "quote", t.quote);
        vm.serializeString(k, "startFdvQ", vm.toString(t.startFdvQ));
        vm.serializeString(k, "minStartUnitValueQ", vm.toString(t.minStartUnitValueQ));
        vm.serializeInt(k, "tickSpacing", t.tickSpacing);
        vm.serializeInt(k, "rangeTicks", t.rangeTicks);
        vm.serializeUint(k, "shape", t.shape);
        vm.serializeBool(k, "active", t.active);
        vm.serializeUint(k, "addedAtBlock", t.addedAtBlock);
        return vm.serializeString(k, "maxCollectionUnits", vm.toString(registry.maxCollectionUnits(version)));
    }

    /// @dev Every identity of one launch, read back from the registry (the record the app and indexer read).
    function _launchJson(
        string memory k,
        SquareHoleRegistry registry,
        bytes32 pairId,
        string memory manifestPath,
        bool manifestFromFile,
        bytes32 manifestHash,
        string memory baseURI
    ) internal returns (string memory) {
        SquareHoleRegistry.PairRecord memory p = registry.pair(pairId);
        require(p.token != address(0), "manifest: unknown pair");
        // The recorded source (file or configured hash) and path must describe the on-chain commitment: a file whose
        // bytes (or a configured hash that) differ from it would be a false provenance claim (SH-E review).
        require(
            manifestHash == p.metadataManifestHash,
            string.concat(
                "manifest: ",
                k,
                manifestFromFile ? " metadata manifest file" : " configured manifestHash",
                " differs from the on-chain metadataManifestHash"
            )
        );
        _resetObject(k);
        vm.serializeBytes32(k, "pairId", p.pairId);
        vm.serializeString(
            k, "appPairId", string.concat(vm.toString(p.chainId), ":", vm.toLowercase(vm.toString(p.token)))
        );
        vm.serializeString(k, "kind", p.kind == SquareHoleRegistry.AssetKind.Collection ? "collection" : "token");
        vm.serializeString(k, "name", _name(p.token));
        vm.serializeString(k, "symbol", _symbol(p.token));
        vm.serializeUint(k, "decimals", 18);
        vm.serializeString(k, "rewardSide", p.rewardSide == uint8(IRewardLedger.PayoutAsset.T) ? "T" : "Q");
        vm.serializeAddress(k, "quote", p.quote);
        vm.serializeAddress(k, "converter", p.converter);
        vm.serializeString(k, "units", vm.toString(p.units));
        // F10: whole tokens per NFT when an integer, else 0; `nftUnit` (collections) is always exact.
        vm.serializeString(k, "fractionsPerNft", vm.toString(p.fractionsPerNft));
        if (p.kind == SquareHoleRegistry.AssetKind.Collection) {
            vm.serializeString(k, "nftUnit", vm.toString(p.initialSupply / p.units));
        }
        vm.serializeString(k, "initialSupply", vm.toString(p.initialSupply));
        vm.serializeUint(k, "templateVersion", p.templateVersion);
        vm.serializeString(k, "startFdvQ", vm.toString(p.startFdvQ));
        vm.serializeString(k, "minStartUnitValueQ", vm.toString(p.minStartUnitValueQ));
        vm.serializeBytes32(k, "poolId", p.poolId);
        vm.serializeUint(k, "lpFeePips", SquareHoleHook(p.hook).LP_FEE());
        vm.serializeInt(k, "tickSpacing", p.tickSpacing);
        vm.serializeInt(k, "tickLower", p.tickLower);
        vm.serializeInt(k, "tickUpper", p.tickUpper);
        vm.serializeString(k, "liquidity", vm.toString(p.liquidity));
        vm.serializeString(k, "sqrtPriceX96", vm.toString(p.sqrtPriceX96));
        vm.serializeString(k, "baseURI", baseURI);
        vm.serializeBytes32(k, "metadataManifestHash", p.metadataManifestHash);
        vm.serializeString(k, "metadataManifestPath", manifestPath);
        // "file": the hash is keccak256 of that file; "configuredHash": the file was missing and the config's pinned
        // manifestHash was used (simulations and the local chain only; a public-chain broadcast requires the file).
        vm.serializeString(k, "metadataManifestSource", manifestFromFile ? "file" : "configuredHash");
        vm.serializeAddress(k, "creator", p.creator);
        vm.serializeUint(k, "createdAtBlock", p.createdAtBlock);
        return vm.serializeString(k, "contracts", _launchContractsJson(string.concat(k, ".c"), p, baseURI));
    }

    function _launchContractsJson(string memory k, SquareHoleRegistry.PairRecord memory p, string memory baseURI)
        internal
        returns (string memory)
    {
        bool collection = p.kind == SquareHoleRegistry.AssetKind.Collection;
        _resetObject(k);
        vm.serializeString(
            k,
            "token",
            _contractJson(
                string.concat(k, ".token"),
                p.token,
                collection ? "SquareHoleToken" : "SquareHoleFungibleToken",
                _tokenArgs(p, baseURI)
            )
        );
        vm.serializeString(
            k,
            "mirror",
            _contractJson(
                string.concat(k, ".mirror"),
                p.mirror,
                collection ? "DN404Mirror (dn404 @ pin)" : "none",
                collection ? abi.encode(_mirrorDeployer(p)) : bytes("")
            )
        );
        vm.serializeString(
            k, "rewardLedger", _contractJson(string.concat(k, ".ledger"), p.ledger, "RewardLedger", _ledgerArgs(p))
        );
        return vm.serializeString(
            k,
            "feeCollector",
            _contractJson(string.concat(k, ".collector"), p.collector, "FeeCollector", _collectorArgs(p))
        );
    }

    function _ledgerArgs(SquareHoleRegistry.PairRecord memory p) internal view returns (bytes memory) {
        RewardLedger ledger = RewardLedger(p.ledger);
        return abi.encode(
            RewardLedger.Config({
                token: p.token,
                quote: p.quote,
                feeCollector: p.collector,
                treasury: ledger.treasury(),
                payoutAsset: IRewardLedger.PayoutAsset(p.rewardSide),
                converter: p.converter,
                launcher: ledger.launcher(),
                poolManager: ledger.poolManager(),
                hook: p.hook,
                nftMirror: p.kind == SquareHoleRegistry.AssetKind.Collection
            })
        );
    }

    function _collectorArgs(SquareHoleRegistry.PairRecord memory p) internal view returns (bytes memory) {
        FeeCollector c = FeeCollector(p.collector);
        return abi.encode(p.token, p.quote, p.ledger, c.treasury(), c.feeSource(), c.poolManager());
    }

    function _tokenArgs(SquareHoleRegistry.PairRecord memory p, string memory baseURI)
        internal
        view
        returns (bytes memory)
    {
        if (p.kind == SquareHoleRegistry.AssetKind.Collection) {
            return abi.encode(
                SquareHoleToken.LaunchTerms({
                    name: _name(p.token),
                    symbol: _symbol(p.token),
                    fractionsPerNft: p.fractionsPerNft,
                    collectionSize: p.units,
                    initialHolder: p.hook,
                    feeCollector: p.collector,
                    rewardLedger: p.ledger,
                    baseURI: baseURI,
                    metadataManifestHash: p.metadataManifestHash
                })
            );
        }
        return abi.encode(
            SquareHoleFungibleToken.LaunchTerms({
                name: _name(p.token),
                symbol: _symbol(p.token),
                wholeSupply: p.units,
                initialHolder: p.hook,
                feeCollector: p.collector,
                rewardLedger: p.ledger,
                metadataManifestHash: p.metadataManifestHash
            })
        );
    }

    /// @dev DN404Mirror's constructor argument is the account that created T (the collection token deployer).
    function _mirrorDeployer(SquareHoleRegistry.PairRecord memory p) internal view returns (address) {
        (bool ok, bytes memory ret) =
            RewardLedger(p.ledger).launcher().staticcall(abi.encodeWithSignature("collectionDeployer()"));
        require(ok, "manifest: collectionDeployer");
        return abi.decode(ret, (address));
    }

    function _name(address token) internal view returns (string memory) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSignature("name()"));
        require(ok, "manifest: name");
        return abi.decode(ret, (string));
    }

    function _symbol(address token) internal view returns (string memory) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSignature("symbol()"));
        require(ok, "manifest: symbol");
        return abi.decode(ret, (string));
    }
}
