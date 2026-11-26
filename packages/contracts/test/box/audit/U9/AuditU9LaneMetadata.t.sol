// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AuditBox0World} from "../common/AuditBox0World.sol";
import {AuditU9LaneTables} from "./AuditU9LaneTables.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {BoxCollection} from "../../../../src/box/BoxCollection.sol";
import {BoxClones} from "../../../../src/box/libraries/BoxClones.sol";
import {BoxCloneArgs} from "../../../../src/box/libraries/BoxCloneArgs.sol";
import {BoxData} from "../../../../src/box/libraries/BoxData.sol";
import {BoxMetadataTable} from "../../../../src/box/libraries/BoxMetadataTable.sol";

/// @notice BC-001/052/054, F29/F75 W1. Real BoxCollection code, clone arguments and table data contracts.
/// The factory-built world's coordinator authorizes initialization of parameterized collection clones (prank);
/// this isolates table/renderer coverage without rebuilding the complete factory per generated table. No mock renderer.
/// forge-config: default.evm_version = "osaka"
contract AuditU9LaneMetadata is AuditBox0World {
    address internal collectionImpl;

    function setUp() public override {
        super.setUp();
        collectionImpl = address(new BoxCollection(collection.coordinatorImplementation()));
    }

    function checkTable(bytes memory t) external pure {
        BoxMetadataTable.validate(t);
    }

    function _collection(bytes memory table, uint128 traits) internal returns (BoxCollection c) {
        BoxCloneArgs.CollectionArgs memory args;
        args.coordinator = a.coordinator;
        args.vault = a.vault;
        args.token = a.token;
        args.receiver = a.receiver;
        args.marketplaceOwner = safe;
        args.metadataTable = BoxData.write(table);
        args.collectionSize = 10;
        args.revealTriggers = 4;
        args.firstId = 1;
        args.metadataTableHash = keccak256(table);
        args.name = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
        args.symbol = "U9";
        args.description = "U9 collection";
        args.collectionCoverSha256 = bytes32(uint256(1));
        // A depth-four commitment for ten items; only item 1 is revealed in this render experiment.
        bytes32 leaf =
            keccak256(abi.encode(uint256(1), traits, bytes32(uint256(1)), bytes32(0), bytes32(uint256(2)), bytes32(0)));
        bytes32[] memory proof = new bytes32[](4);
        for (uint256 i; i < 4; ++i) {
            proof[i] = leaf;
            leaf = keccak256(abi.encodePacked(leaf, leaf));
        }
        args.revealRoot = leaf;
        c = BoxCollection(BoxClones.create(BoxClones.initCode(collectionImpl, BoxCloneArgs.collection(args))));
        vm.prank(a.coordinator);
        c.initialize();
        _json(c, 1); // hidden branch before reveal
        c.reveal(1, traits, bytes32(uint256(1)), bytes32(0), bytes32(uint256(2)), bytes32(0), proof);
    }

    function _json(BoxCollection c, uint256 id) internal view {
        string memory json = c.tokenJSON(id);
        // The URI's payload must be precisely the independently base64-encoded, successfully parsed JSON.
        assertEq(c.tokenURI(id), string.concat("data:application/json;base64,", vm.toBase64(bytes(json))));
        vm.parseJson(json);
        assertEq(
            vm.parseJsonString(json, ".name"), string.concat("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA #", vm.toString(id))
        );
    }

    function _accepted(bytes memory table) internal view returns (bool accepted) {
        BoxSpecV1.BoxSpec memory s = kit.spec();
        s.metadataTable = table;
        (uint16 r, uint16 f) = BoxSpecV1.validate(s, BoxSpecV1.contextV1());
        (bool libraryAccepts,) = address(this).staticcall(abi.encodeCall(this.checkTable, (table)));
        accepted = r == 0;
        assertEq(accepted, libraryAccepts, "spec/table agreement");
        if (!accepted) {
            assertEq(f, BoxSpecV1.FIELD_METADATA_TABLE);
            assertTrue(r == BoxSpecV1.REASON_METADATA_TABLE_MALFORMED || r == BoxSpecV1.REASON_LENGTH_OUT_OF_RANGE);
        }
    }

    function testFuzz_AUDIT_U9_acceptedStructuredTablesRender(uint256 seed, uint128 traits, uint8 change) public {
        bytes memory table = AuditU9LaneTables.table(
            seed % 1025, (seed >> 16) % 17, 1 + (seed >> 24) % 12, 1 + (seed >> 32) % 32, 1 + (seed >> 40) % 32
        );
        if (change % 4 == 1) table[(seed >> 48) % table.length] = bytes1(uint8(seed >> 64));
        if (change % 4 == 2) table = bytes.concat(table, hex"00");
        if (change % 4 == 3) {
            assembly ("memory-safe") { mstore(table, sub(mload(table), 1)) }
        }
        if (_accepted(table)) _json(_collection(table, traits), 1);
    }

    function testFuzz_AUDIT_U9_arbitraryAcceptedTableRenders(bytes memory table, uint128 traits) public {
        if (_accepted(table)) _json(_collection(table, traits), 1);
    }

    /// Each possible byte in description, trait name and value, including all controls and invalid UTF-8.
    function testProperty_AUDIT_U9_allMetadataTextBytesRefusedOrJsonSafe() public {
        uint256[3] memory positions = [uint256(3), 6, 9];
        for (uint256 pos; pos < positions.length; ++pos) {
            for (uint256 value; value < 256; ++value) {
                bytes memory table = hex"0100014401014e010156";
                table[positions[pos]] = bytes1(uint8(value));
                bool expected = value >= 32 && value <= 126 && value != 34 && value != 92;
                assertEq(_accepted(table), expected);
                if (expected) {
                    string memory json = string.concat(
                        '{"description":"',
                        string(BoxMetadataTable.description(table)),
                        '","attributes":[',
                        string(BoxMetadataTable.attributes(table, 1)),
                        "]}"
                    );
                    vm.parseJson(json);
                }
            }
        }
    }

    function _gas(string memory fork) internal {
        vm.setEvmVersion(fork);
        for (uint256 shape; shape < 3; ++shape) {
            bytes memory table = AuditU9LaneTables.maximum(shape);
            assertEq(table.length, 24_575);
            assertTrue(_accepted(table));
            uint128 traits = shape == 2 ? type(uint128).max / 255 : type(uint128).max;
            BoxCollection c = _collection(table, traits);
            if (shape != 0) {
                assertEq(
                    bytes(vm.parseJsonString(c.tokenJSON(1), ".attributes[15].value")).length, shape == 1 ? 1 : 255
                );
            }
            // Measure a separate cold per-token call after initializing/revealing. No setup or JSON parsing metered.
            address tableAddress = c.metadataTable();
            bytes32 metadataSlot = keccak256(abi.encode(uint256(1), uint256(5)));
            vm.cool(address(c));
            vm.cool(collectionImpl);
            vm.cool(tableAddress);
            vm.coolSlot(address(c), metadataSlot);
            vm.coolSlot(address(c), bytes32(uint256(metadataSlot) + 1));
            vm.coolSlot(address(c), bytes32(uint256(metadataSlot) + 2));
            uint256 before = gasleft();
            string memory uri = c.tokenURI(1);
            uint256 used = before - gasleft();
            emit log_named_string("metadata fork", fork);
            emit log_named_uint("table shape", shape);
            emit log_named_uint("table bytes", table.length);
            emit log_named_uint("tokenURI bytes", bytes(uri).length);
            emit log_named_uint("tokenURI gas per revealed token", used);
            assertLt(used, 9_200_000, "measured per-token bound for all maximum-table shapes");
            _json(c, 1);
            _json(c, 10); // last accepted id, hidden branch
        }
    }

    function testProperty_AUDIT_U9_maximumTableRenderGasOsaka() public {
        _gas("osaka");
    }

    function testProperty_AUDIT_U9_maximumTableRenderGasAmsterdam() public {
        _gas("amsterdam");
    }
}
