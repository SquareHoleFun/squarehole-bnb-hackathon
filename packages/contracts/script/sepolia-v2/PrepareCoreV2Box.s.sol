// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Script} from "forge-std/Script.sol";
import {CoreV2LocalActions} from "../local/CoreV2LocalActions.sol";
import {BoxFactoryV2} from "../../src/box-v2/BoxFactoryV2.sol";
import {IBoxFactoryV2, IBoxCoordinatorV2, ChunkPart} from "../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";
import {BoxFactoryV2Parts} from "../../src/box-v2/BoxFactoryV2Parts.sol";
import {BoxCollectionV2} from "../../src/box-v2/BoxCollectionV2.sol";
import {BoxSpec, AddOn} from "../../src/box-v2/interfaces/SpecTypes.sol";
import {Branch} from "../../src/box-v2/interfaces/RecipeTypes.sol";
import {ListingRecord, IListingRegistry} from "../../src/box-v2/interfaces/IListingRegistry.sol";
import {HostileCollection} from "../../test/box-v2/kit/m2/ShopDoubles.sol";
import {BoxClones} from "../../src/box/libraries/BoxClones.sol";
import {SparseBoxTree} from "../../test/box/items/BoxItemsKit.sol";
import {BoxLayoutV2} from "../../src/box-v2/libraries/BoxLayoutV2.sol";
import {SepoliaV2Gas} from "./SepoliaV2Gas.sol";

/// @notice Prepares deterministic TESTNET specimens. Writes public calldata, never signs or broadcasts.
/// The ten item hashes are synthetic test art, not a published collection or the Misfits.
contract PrepareCoreV2Box is Script, CoreV2LocalActions {
    event PreparedBox(string json);

    /// @notice Anyone prepares from the target chain's current listing. Founder reviews then sends the exact payload.
    function run() external returns (string memory json) {
        require(block.chainid == 11_155_111 || block.chainid == 31337, "testnet only");
        localFactory = BoxFactoryV2(vm.envAddress("CORE_V2_FACTORY"));
        localActor = vm.envAddress("CORE_V2_CREATOR");
        uint256 mode = vm.envUint("CORE_V2_KIND");
        require(mode <= 5, "kind 0..5");
        localNft = HostileCollection(vm.envOr("CORE_V2_SHOP_COLLECTION", address(0)));
        if (mode == 2) require(address(localNft).code.length != 0, "shop collection required");
        BoxSpec memory s = _localSpec(uint8(mode));
        uint256 id = vm.envOr("CORE_V2_LISTING", uint256(0));
        require(id <= type(uint32).max);
        ListingRecord memory listing = IListingRegistry(localFactory.listingRegistry()).listing(uint32(id));
        s.pricing.token = listing.token;
        s.pricing.listingId = uint32(id);
        s.raise = listing.raise;
        s.creatorBuy = listing.raise / 100;
        if (mode == 0 && vm.envOr("CORE_V2_BURN", false)) {
            s.buyers.a = Branch(2, 1, "", "");
            s.sellers.a = s.buyers.a;
            s.creatorFeeRecipient = address(0);
        }
        if (mode == 4) {
            uint256 policy = vm.envOr("CORE_V2_INSIDE_POLICY", uint256(1));
            require(policy == 1 || policy == 2);
            s.buyers.a.destParams = abi.encode(uint8(policy));
            s.sellers.a.destParams = abi.encode(uint8(policy));
            s.marketplaceOwner = localActor;
            if (vm.envOr("CORE_V2_HIDDEN", false)) {
                s.artMode = 2;
                s.revealListId = 0;
                s.addOns = new AddOn[](2);
                s.addOns[0] = AddOn(
                    1, abi.encode("Tickets", "TKT", "Draw", "Hidden", '<svg xmlns="http://www.w3.org/2000/svg"></svg>')
                );
                s.addOns[1] = AddOn(4, abi.encode(uint16(500), uint8(1)));
            }
        }
        if (mode == 5) {
            s.contentsParams = abi.encode(vm.envOr("CORE_V2_SEED_ASSET", address(0)), vm.envUint("CORE_V2_SEED_RAW"));
        }
        json = prepare(address(localFactory), localActor, s, vm.envOr("CORE_V2_SALT_START", uint256(0)));
        if (vm.envOr("CORE_V2_WRITE_MANIFEST", false)) vm.writeJson(json, vm.envString("CORE_V2_BOX_FILE"));
        emit PreparedBox(json);
    }

    struct Prepared {
        address coordinator;
        address token;
        address hook;
        bytes data;
        uint256 payment;
    }

    /// @notice Anyone mines public salts for a reviewed format-2 spec; no assets or allowances move.
    function prepare(address factory, address creator, BoxSpec memory s, uint256 start) public returns (string memory) {
        BoxFactoryV2 f = BoxFactoryV2(factory);
        Prepared memory p = _mine(f, creator, s, start);
        return _json(f, creator, s, p);
    }

    function _mine(BoxFactoryV2 f, address creator, BoxSpec memory s, uint256 start)
        private
        view
        returns (Prepared memory p)
    {
        bytes32 cs;
        bytes32 hs;
        bytes32 initHash;
        for (uint256 i = start; i < start + 100_000; ++i) {
            cs = bytes32(i);
            (p.coordinator, p.token, initHash) = f.predictBox(creator, s, cs);
            if (
                p.coordinator.code.length == 0 && p.token > s.pricing.token
                    && p.token < f.tokenAddressLimit(s.pricing.token)
            ) break;
            if (i + 1 == start + 100_000) revert("coordinator salt range exhausted");
        }
        bool found;
        for (uint256 i; i < 1_000_000; ++i) {
            hs = bytes32(i);
            p.hook = BoxClones.predict(p.coordinator, hs, initHash);
            if (uint160(p.hook) & 0x3fff == 0x2ae0 && uint160(p.hook) >> 152 != 0x91) {
                found = true;
                break;
            }
        }
        require(found, "hook salt range exhausted");
        p.data = abi.encodeCall(IBoxFactoryV2.createBox, (s, cs, hs));
        p.payment = f.boxQParameters(s.pricing.listingId, s.raise).bootstrapQ + s.creatorBuy;
    }

    function _json(BoxFactoryV2 f, address creator, BoxSpec memory s, Prepared memory p)
        private
        returns (string memory)
    {
        string memory key = "prepared-core-v2";
        vm.serializeJson(key, "{}");
        vm.serializeString(key, "status", "unsigned-testnet-input");
        vm.serializeString(key, "chainId", vm.toString(block.chainid));
        vm.serializeAddress(key, "factory", address(f));
        vm.serializeAddress(key, "creator", creator);
        vm.serializeBytes32(key, "versionCodeHash", f.versionCodeHash());
        vm.serializeAddress(key, "coordinator", p.coordinator);
        vm.serializeAddress(key, "token", p.token);
        vm.serializeAddress(key, "hook", p.hook);
        vm.serializeBytes(key, "specEncoded", abi.encode(s));
        vm.serializeBytes(key, "createData", p.data);
        vm.serializeString(key, "gasLimit", vm.toString(SepoliaV2Gas.creationEnvelope(p.data)));
        vm.serializeBytes32(key, "calldataHash", keccak256(p.data));
        vm.serializeString(key, "paymentRaw", vm.toString(p.payment));
        vm.serializeString(key, "nativeValue", vm.toString(s.pricing.token == address(0) ? p.payment : 0));
        vm.serializeAddress(key, "priceCoin", s.pricing.token);
        BoxLayoutV2.Curve memory curve = BoxLayoutV2.curve(s.raise, false);
        vm.serializeString(key, "curveBuyLimit", vm.toString(curve.sqrtPriceEndX96));
        vm.serializeString(key, "curveSellLimit", vm.toString(curve.sqrtPriceStartX96));
        if (s.boxType == 1) _itemCalls(key, f, s);
        return vm.serializeString(key, "raiseRaw", vm.toString(s.raise));
    }

    function _itemCalls(string memory key, BoxFactoryV2 f, BoxSpec memory s) private {
        BoxFactoryV2Parts.Box memory encoding;
        (, bytes memory texts) = f.planner().parts().partArgs(encoding, s);
        vm.serializeBytes(
            key, "tableCall", abi.encodeCall(IBoxCoordinatorV2.loadChunk, (ChunkPart.Table, s.metadataTable, 0))
        );
        vm.serializeBytes(key, "textsCall", abi.encodeCall(IBoxCoordinatorV2.loadChunk, (ChunkPart.Texts, texts, 0)));
        // Read chunk counters first. Send only an incomplete chunk; creation may already load either one.
        uint256[] memory positions = new uint256[](10);
        bytes32[] memory leaves = new bytes32[](10);
        for (uint256 i; i < 10; ++i) {
            positions[i] = i;
            leaves[i] = SparseBoxTree.leaf(i + 1, 0, bytes32(i + 1), 0, 0, 0);
        }
        string[] memory proofs = new string[](10);
        bytes[] memory revealCalls = new bytes[](10);
        for (uint256 i; i < 10; ++i) {
            bytes32[] memory proof = SparseBoxTree.proof(4, i, positions, leaves);
            // This tuple is ItemReveal's non-proof fields followed by the proof, for openDraw's reveal argument.
            proofs[i] = _revealTuple(i + 1, proof);
            revealCalls[i] = abi.encodeCall(BoxCollectionV2.reveal, (i + 1, 0, bytes32(i + 1), 0, 0, 0, proof));
        }
        vm.serializeString(key, "revealTuples", proofs);
        vm.serializeBytes(key, "revealCalls", revealCalls);
    }

    function _revealTuple(uint256 id, bytes32[] memory proof) private pure returns (string memory) {
        string memory items = "[";
        for (uint256 i; i < proof.length; ++i) {
            items = string.concat(items, i == 0 ? "" : ",", vm.toString(proof[i]));
        }
        string memory zero = vm.toString(bytes32(0));
        return string.concat("(0,", vm.toString(bytes32(id)), ",", zero, ",", zero, ",", zero, ",", items, "])");
    }
}
