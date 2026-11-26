// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {SquareHoleHook} from "../../src/SquareHoleHook.sol";
import {SquareHoleLauncher} from "../../src/SquareHoleLauncher.sol";
import {SquareHoleRegistry} from "../../src/SquareHoleRegistry.sol";
import {IRewardLedger} from "../../src/interfaces/IRewardLedger.sol";

/// @title ManifestVerifier (review round B)
/// @notice Read-only check of a DEPLOYED manifest (`deployments/<chainId>.json`) against the chain the script runs on:
/// status and provenance; every contract address has code with the recorded code hash; the hook's permission bits and
/// the system's wiring (launcher ↔ hook ↔ registry ↔ PoolManager ↔ converter, admin, treasury); every template equals
/// the registry's record (`active` is skipped: retiring is the admin's documented power); every launch equals
/// `registry.pair(pairId)` field by field, its four contracts carry the recorded code hashes, and every registry block
/// lies inside the deployment's receipt range. Used by the finalizer before it writes and by
/// script/VerifyManifest.s.sol for anyone re-checking a committed manifest.
abstract contract ManifestVerifier is Script {
    using stdJson for string;

    uint160 private constant VERIFY_HOOK_FLAGS = 0x2A60;

    function verifyManifest(string memory json) public view {
        require(json.readUint(".chainId") == block.chainid, "verify: manifest is for another chain");
        require(_eqv(json.readString(".status"), "deployed"), "verify: not a deployed manifest");
        require(!json.readBool(".dryRun"), "verify: dry run");
        require(bytes(json.readString(".gitCommit")).length == 40, "verify: git commit");
        bool dirty = json.readBool(".gitDirty");
        require(block.chainid == 31_337 || !dirty, "verify: a public-chain manifest must come from a clean tree");
        uint256 startBlock = json.readUint(".startBlock");
        uint256 endBlock = json.readUint(".endBlock");
        require(startBlock != 0 && startBlock <= endBlock && endBlock <= block.number, "verify: receipt block range");

        _verifyContractHashes(json, ".contracts");
        _verifyWiring(json);
        _verifyTemplates(json, startBlock, endBlock);
        string[] memory launches = vm.parseJsonKeys(json, ".launches");
        for (uint256 i; i < launches.length; ++i) {
            _verifyLaunch(json, string.concat(".launches.", launches[i]), startBlock, endBlock);
        }
    }

    /// Every object under `root` with an `address`: code with exactly the recorded hash (zero address = not deployed).
    function _verifyContractHashes(string memory json, string memory root) internal view {
        string[] memory keys = vm.parseJsonKeys(json, root);
        for (uint256 i; i < keys.length; ++i) {
            string memory k = string.concat(root, ".", keys[i]);
            address a = json.readAddress(string.concat(k, ".address"));
            if (a == address(0)) continue;
            require(a.code.length != 0, string.concat("verify: no code at ", keys[i]));
            require(
                a.codehash == json.readBytes32(string.concat(k, ".codehash")),
                string.concat("verify: code hash of ", keys[i])
            );
        }
    }

    function _verifyWiring(string memory json) internal view {
        SquareHoleRegistry registry = SquareHoleRegistry(json.readAddress(".contracts.registry.address"));
        SquareHoleLauncher launcher = SquareHoleLauncher(json.readAddress(".contracts.launcher.address"));
        SquareHoleHook hook = SquareHoleHook(json.readAddress(".contracts.hook.address"));
        address pm = json.readAddress(".contracts.poolManager.address");
        require(uint160(address(hook)) & 0x3FFF == VERIFY_HOOK_FLAGS, "verify: hook permission bits");
        require(hook.launcher() == address(launcher) && address(hook.poolManager()) == pm, "verify: hook wiring");
        require(
            address(launcher.hook()) == address(hook) && address(launcher.registry()) == address(registry)
                && address(launcher.poolManager()) == pm,
            "verify: launcher wiring"
        );
        require(registry.launcher() == address(launcher), "verify: registry launcher");
        require(registry.admin() == json.readAddress(".registryAdmin"), "verify: registry admin");
        require(launcher.treasury() == json.readAddress(".treasury"), "verify: treasury");
        require(
            launcher.converter() == json.readAddress(".contracts.claimConverter.address"), "verify: claim converter"
        );
        require(
            address(launcher.coreDeployer()) == json.readAddress(".contracts.coreDeployer.address")
                && address(launcher.collectionDeployer())
                    == json.readAddress(".contracts.collectionTokenDeployer.address")
                && address(launcher.fungibleDeployer()) == json.readAddress(".contracts.fungibleTokenDeployer.address"),
            "verify: launch deployers"
        );
    }

    function _verifyTemplates(string memory json, uint256 startBlock, uint256 endBlock) internal view {
        SquareHoleRegistry registry = SquareHoleRegistry(json.readAddress(".contracts.registry.address"));
        string[] memory keys = vm.parseJsonKeys(json, ".templates");
        for (uint256 i; i < keys.length; ++i) {
            string memory k = string.concat(".templates.", keys[i]);
            // casting to 'uint32' is safe because template versions are uint32 in the registry
            // forge-lint: disable-next-line(unsafe-typecast)
            SquareHoleRegistry.LaunchTemplate memory t =
                registry.template(uint32(json.readUint(string.concat(k, ".version"))));
            require(
                t.quote == json.readAddress(string.concat(k, ".quote"))
                    && t.startFdvQ == vm.parseUint(json.readString(string.concat(k, ".startFdvQ")))
                    && t.minStartUnitValueQ == vm.parseUint(json.readString(string.concat(k, ".minStartUnitValueQ")))
                    && t.tickSpacing == json.readInt(string.concat(k, ".tickSpacing"))
                    && t.rangeTicks == json.readInt(string.concat(k, ".rangeTicks"))
                    && t.shape == json.readUint(string.concat(k, ".shape")),
                string.concat("verify: template ", keys[i])
            );
            uint256 added = json.readUint(string.concat(k, ".addedAtBlock"));
            require(
                t.addedAtBlock == added && added >= startBlock && added <= endBlock,
                string.concat("verify: template block ", keys[i])
            );
        }
    }

    function _verifyLaunch(string memory json, string memory k, uint256 startBlock, uint256 endBlock) internal view {
        SquareHoleRegistry registry = SquareHoleRegistry(json.readAddress(".contracts.registry.address"));
        SquareHoleRegistry.PairRecord memory p = registry.pair(json.readBytes32(string.concat(k, ".pairId")));
        require(p.token != address(0), string.concat("verify: unknown pair ", k));
        _verifyLaunchIdentity(json, k, p);
        _verifyLaunchPool(json, k, p);
        require(
            p.createdAtBlock == json.readUint(string.concat(k, ".createdAtBlock")) && p.createdAtBlock >= startBlock
                && p.createdAtBlock <= endBlock,
            string.concat("verify: launch block ", k)
        );
        string memory c = string.concat(k, ".contracts");
        require(
            json.readAddress(string.concat(c, ".token.address")) == p.token
                && json.readAddress(string.concat(c, ".mirror.address")) == p.mirror
                && json.readAddress(string.concat(c, ".rewardLedger.address")) == p.ledger
                && json.readAddress(string.concat(c, ".feeCollector.address")) == p.collector,
            string.concat("verify: launch contracts ", k)
        );
        _verifyContractHashes(json, c);
    }

    function _verifyLaunchIdentity(string memory json, string memory k, SquareHoleRegistry.PairRecord memory p)
        internal
        pure
    {
        bool collection = p.kind == SquareHoleRegistry.AssetKind.Collection;
        require(
            _eqv(json.readString(string.concat(k, ".kind")), collection ? "collection" : "token")
                && _eqv(
                    json.readString(string.concat(k, ".rewardSide")),
                    p.rewardSide == uint8(IRewardLedger.PayoutAsset.T) ? "T" : "Q"
                ) && json.readAddress(string.concat(k, ".quote")) == p.quote
                && json.readAddress(string.concat(k, ".converter")) == p.converter
                && json.readAddress(string.concat(k, ".creator")) == p.creator
                && json.readBytes32(string.concat(k, ".metadataManifestHash")) == p.metadataManifestHash,
            string.concat("verify: launch identity ", k)
        );
        require(
            vm.parseUint(json.readString(string.concat(k, ".units"))) == p.units
                && vm.parseUint(json.readString(string.concat(k, ".fractionsPerNft"))) == p.fractionsPerNft
                && vm.parseUint(json.readString(string.concat(k, ".initialSupply"))) == p.initialSupply
                && json.readUint(string.concat(k, ".templateVersion")) == p.templateVersion
                && vm.parseUint(json.readString(string.concat(k, ".startFdvQ"))) == p.startFdvQ
                && vm.parseUint(json.readString(string.concat(k, ".minStartUnitValueQ"))) == p.minStartUnitValueQ,
            string.concat("verify: launch terms ", k)
        );
    }

    function _verifyLaunchPool(string memory json, string memory k, SquareHoleRegistry.PairRecord memory p)
        internal
        pure
    {
        require(
            json.readBytes32(string.concat(k, ".poolId")) == p.poolId
                && json.readInt(string.concat(k, ".tickSpacing")) == p.tickSpacing
                && json.readInt(string.concat(k, ".tickLower")) == p.tickLower
                && json.readInt(string.concat(k, ".tickUpper")) == p.tickUpper
                && vm.parseUint(json.readString(string.concat(k, ".liquidity"))) == p.liquidity
                && vm.parseUint(json.readString(string.concat(k, ".sqrtPriceX96"))) == p.sqrtPriceX96
                && p.hook == json.readAddress(".contracts.hook.address"),
            string.concat("verify: launch pool ", k)
        );
    }

    function _eqv(string memory a, string memory b) private pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }
}
