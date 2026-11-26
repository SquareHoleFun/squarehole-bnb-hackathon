// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CQ11WDeploymentFixture} from "../m1-64/CQ11WDeployment.t.sol";
import {CoreV2LocalActions} from "../../../script/local/CoreV2LocalActions.sol";
import {BoxSpec, AddOn} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {BoxFactoryV2Parts} from "../../../src/box-v2/BoxFactoryV2Parts.sol";
import {BoxCoordinatorV2} from "../../../src/box-v2/BoxCoordinatorV2.sol";
import {ChunkLoader} from "../../../src/box-v2/libraries/ChunkLoader.sol";

/// Offline oracle; SH_WRITE_CREATE_VECTORS opts into writing the committed differential corpus.
contract CreateVectorsTest is CQ11WDeploymentFixture, CoreV2LocalActions {
    function test_createVectors() public {
        (localFactory,) = _run();
        localActor = address(0xA11CE);
        for (uint256 i; i < 4; ++i) {
            BoxSpec memory s = _localSpec(i == 0 ? 0 : 4);
            s.tokenName = string.concat("Vector ", vm.toString(i));
            s.description = "";
            if (i == 2) {
                s.description = unicode"Café 🎁";
                s.addOns = new AddOn[](2);
                s.addOns[0] = AddOn(1, abi.encode("Tickets", "TKT", unicode"Draw 🎲", "Hidden", "<svg/>"));
                s.addOns[1] = AddOn(6, abi.encode(bytes32(0), new bytes32[](0), "https://example.invalid/box"));
            }
            if (i == 3) {
                // Encoder boundary vector, not a claim that arbitrary metadata is a valid collection spec.
                s.metadataTable = new bytes(16_385);
                for (uint256 j; j < s.metadataTable.length; ++j) s.metadataTable[j] = bytes1(uint8(j % 251));
                s.description = string(new bytes(8193));
            }
            string memory json = _vector(s, i);
            string memory path = string.concat("test/vectors/create-v2/", vm.toString(i), ".json");
            if (vm.envOr("SH_WRITE_CREATE_VECTORS", false)) vm.writeJson(json, path);
            else assertEq(keccak256(vm.parseJson(vm.readFile(path))), keccak256(vm.parseJson(json)), path);
        }
    }

    function test_reservedHookVector() public {
        // Mined offline once; pin this rare negative case rather than searching 8M salts on every test run.
        uint256 salt = 0x7cbaac;
        address hook = _hook(address(40), salt, bytes32(0));
        assertEq(uint160(hook) & 0x3fff, 0x2ae0);
        assertEq(uint160(hook) >> 152, 0x91);
        string memory key = "reserved-hook";
        vm.serializeAddress(key, "coordinator", address(40));
        vm.serializeBytes32(key, "initHash", bytes32(0));
        vm.serializeBytes32(key, "hs", bytes32(salt));
        string memory json = vm.serializeAddress(key, "hook", hook);
        string memory path = "test/vectors/create-v2/reserved.json";
        if (vm.envOr("SH_WRITE_CREATE_VECTORS", false)) vm.writeJson(json, path);
        else assertEq(keccak256(vm.parseJson(vm.readFile(path))), keccak256(vm.parseJson(json)), path);
    }

    function _vector(BoxSpec memory s, uint256 id) private returns (string memory) {
        string memory key = string.concat("create-vector-", vm.toString(id));
        // predictBox validates the spec. Test text-encoder boundaries separately from admission.
        BoxSpec memory prediction = abi.decode(abi.encode(s), (BoxSpec));
        if (id >= 2) {
            BoxSpec memory validCollection = _localSpec(4);
            prediction.description = "";
            prediction.addOns = validCollection.addOns;
            prediction.metadataTable = validCollection.metadataTable;
        }
        _salts(key, prediction);
        vm.serializeBytes(key, "predictionSpecEncoded", abi.encode(prediction));
        vm.serializeAddress(key, "factory", address(localFactory));
        vm.serializeAddress(key, "creator", localActor);
        vm.serializeBytes(key, "specEncoded", abi.encode(s));
        vm.serializeAddress(key, "priceToken", s.pricing.token);
        vm.serializeAddress(key, "tokenAddressLimit", localFactory.tokenAddressLimit(s.pricing.token));
        BoxFactoryV2Parts.Box memory context;
        (, bytes memory texts) = localFactory.planner().parts().partArgs(context, s);
        uint256 chunkMax = BoxCoordinatorV2(localFactory.implementation(0)).CHUNK_MAX();
        assertEq(chunkMax, 8192);
        bytes memory header = bytes(vm.serializeString(key, "chunkMax", vm.toString(chunkMax)));
        // Remove only the closing brace before adding the two structured parts.
        assembly ("memory-safe") { mstore(header, sub(mload(header), 1)) }
        return string.concat(string(header), ',"table":',
            _chunks(s.metadataTable, string.concat(key, "-table"), chunkMax), ',"texts":',
            _chunks(texts, string.concat(key, "-texts"), chunkMax), "}");
    }

    function _salts(string memory key, BoxSpec memory s) private {
        string memory predictions = "[";
        address coordinator;
        address token;
        bytes32 initHash;
        uint256 cs;
        for (; cs < 4096; ++cs) {
            (coordinator, token, initHash) = localFactory.predictBox(localActor, s, bytes32(cs));
            string memory row = string.concat(key, "-prediction-", vm.toString(cs));
            vm.serializeAddress(row, "coordinator", coordinator);
            vm.serializeAddress(row, "token", token);
            predictions = string.concat(predictions, cs == 0 ? "" : ",", vm.serializeBytes32(row, "initHash", initHash));
            if (token > s.pricing.token && token < localFactory.tokenAddressLimit(s.pricing.token)) break;
        }
        assertLt(cs, 4096);
        vm.serializeJson(key, string.concat('{"predictions":', predictions, "]}"));
        uint256 hs;
        address hook;
        for (; hs < 1_000_000; ++hs) {
            hook = _hook(coordinator, hs, initHash);
            if (uint160(hook) & 0x3fff == 0x2ae0 && uint160(hook) >> 152 != 0x91) break;
        }
        assertLt(hs, 1_000_000);
        assertEq(hook, localFactory.predictHook(localActor, s, bytes32(cs), bytes32(hs)));
        vm.serializeBytes32(key, "cs", bytes32(cs));
        vm.serializeBytes32(key, "hs", bytes32(hs));
        vm.serializeAddress(key, "coordinator", coordinator);
        vm.serializeAddress(key, "token", token);
        vm.serializeAddress(key, "hook", hook);
    }

    function _hook(address coordinator, uint256 salt, bytes32 initHash) private pure returns (address hook) {
        // Scratch memory keeps a bounded salt search from allocating on every attempt.
        assembly ("memory-safe") {
            let p := mload(0x40)
            mstore(p, shl(248, 0xff))
            mstore(add(p, 1), shl(96, coordinator))
            mstore(add(p, 21), salt)
            mstore(add(p, 53), initHash)
            hook := and(keccak256(p, 85), 0xffffffffffffffffffffffffffffffffffffffff)
        }
    }

    function _chunks(bytes memory data, string memory key, uint256 max) private returns (string memory) {
        uint256 count = (data.length + max - 1) / max;
        bytes[] memory chunks = new bytes[](count);
        bytes32[] memory nextHashes = new bytes32[](count);
        bytes32 next;
        for (uint256 i = count; i > 0;) {
            --i;
            uint256 start = i * max;
            uint256 len = data.length - start > max ? max : data.length - start;
            chunks[i] = new bytes(len);
            for (uint256 j; j < len; ++j) chunks[i][j] = data[start + j];
            nextHashes[i] = next;
            next = keccak256(bytes.concat(chunks[i], next));
        }
        assertEq(next, ChunkLoader.rootOf(data, max));
        vm.serializeBytes(key, "data", data);
        vm.serializeBytes(key, "chunks", chunks);
        vm.serializeBytes32(key, "nextHashes", nextHashes);
        return vm.serializeBytes32(key, "root", next);
    }
}
