// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {AuditU1LaneBase} from "./AuditU1LaneBase.sol";
import {BoxCloneArgs as A} from "../../../../src/box/libraries/BoxCloneArgs.sol";
import {BoxClones} from "../../../../src/box/libraries/BoxClones.sol";
import {BoxCollection} from "../../../../src/box/BoxCollection.sol";
import {BoxVault} from "../../../../src/box/BoxVault.sol";
import {BoxTickets} from "../../../../src/box/BoxTickets.sol";
import {BoxRoyaltyRouter} from "../../../../src/box/BoxRoyaltyRouter.sol";
import {BoxItemStream} from "../../../../src/box/BoxItemStream.sol";
import {BoxCloneBase} from "../../../../src/box/BoxCloneBase.sol";
import {BoxCloneReader} from "../../../../src/box/BoxCloneReader.sol";

/// @notice Exposes the production readers without changing their implementation. This is a byte-codec harness,
/// not a stand-in world/callee. It permits raw enum maxima and private argument fields to be checked too.
contract AuditU1LaneBaseReader is BoxCloneBase {
    function read(uint256 offset, uint256 width) external view returns (uint256) {
        return _argUint(offset, width);
    }

    function text(uint256 offset, uint256 length) external view returns (bytes memory) {
        return _argBytes(offset, length);
    }
}

contract AuditU1LaneReceivingReader is AuditU1LaneBaseReader {
    function _argsBase() internal pure override returns (uint256) {
        return 51;
    }
}

contract AuditU1LaneWordReader is BoxCloneReader {
    function read(uint256 offset, uint256 width) external view returns (uint256) {
        return _argUint(offset, width);
    }

    function signed24(uint256 offset) external view returns (int24) {
        return _argInt24(offset);
    }
}

/// forge-config: default.evm_version = "osaka"
contract AuditU1LaneArgs is AuditU1LaneBase {
    address internal reader;
    address internal receivingReader;
    address internal wordReader;

    function setUp() public override {
        super.setUp();
        reader = address(new AuditU1LaneBaseReader());
        receivingReader = address(new AuditU1LaneReceivingReader());
        wordReader = address(new AuditU1LaneWordReader());
    }

    function _value(uint256 seed, uint256 field, uint256 mode) internal pure returns (uint256) {
        if (mode < 2) return mode;
        if (mode == 2) return type(uint256).max;
        if (mode == 4) return 1 << 23;
        if (mode == 5) return (1 << 23) - 1;
        return uint256(keccak256(abi.encode(seed, field)));
    }

    function _text(uint256 seed, uint256 max) internal pure returns (string memory) {
        bytes memory b = new bytes(seed % (max + 1));
        for (uint256 i; i < b.length; ++i) {
            b[i] = bytes1(uint8(1 + (i % 254)));
        }
        return string(b);
    }

    function _get(address clone, string memory signature, bytes memory expected) internal {
        (bool ok, bytes memory got) = clone.staticcall(abi.encodeWithSignature(signature));
        assertTrue(ok, signature);
        assertEq(got, expected, signature);
        bytes memory original = clone.code;
        vm.etch(clone, bytes.concat(original, bytes32(type(uint256).max)));
        (ok, got) = clone.staticcall(abi.encodeWithSignature(signature));
        assertTrue(ok, signature);
        assertEq(got, expected, "no getter includes bytes beyond the encoding");
        vm.etch(clone, original);
    }

    function _roundTrip(bytes memory args, uint256[] memory widths, uint256[] memory expected, bool receiving)
        internal
    {
        address base = BoxClones.create(
            receiving ? BoxClones.initCodeReceiving(receivingReader, args) : BoxClones.initCode(reader, args)
        );
        address words = BoxClones.create(BoxClones.initCode(wordReader, args));
        address poisoned = BoxClones.create(
            receiving
                ? BoxClones.initCodeReceiving(receivingReader, bytes.concat(args, bytes32(type(uint256).max)))
                : BoxClones.initCode(reader, bytes.concat(args, bytes32(type(uint256).max)))
        );
        uint256 offset;
        for (uint256 j; j < widths.length; ++j) {
            assertLe(offset + widths[j], args.length, "reader never passes encoded end");
            assertEq(AuditU1LaneBaseReader(base).read(offset, widths[j]), expected[j], "base reader round-trip");
            assertEq(AuditU1LaneWordReader(words).read(offset, widths[j]), expected[j], "word reader round-trip");
            if (widths[j] == 3) {
                assertEq(AuditU1LaneWordReader(words).signed24(offset), int24(uint24(expected[j])), "signed read");
            }
            assertEq(
                AuditU1LaneBaseReader(poisoned).read(offset, widths[j]), expected[j], "tail cannot influence field"
            );
            offset += widths[j];
        }
    }

    function testFuzz_AUDIT_U1_collectionLayout(uint256 seed) public {
        for (uint256 mode; mode < 4; ++mode) {
            _collection(seed, mode);
        }
    }

    function _collection(uint256 seed, uint256 mode) internal {
        A.CollectionArgs memory x;
        x.coordinator = address(uint160(_value(seed, 0, mode)));
        x.vault = address(uint160(_value(seed, 1, mode)));
        x.token = address(uint160(_value(seed, 2, mode)));
        x.receiver = address(uint160(_value(seed, 3, mode)));
        x.revealUnlocker = address(uint160(_value(seed, 4, mode)));
        x.transferObserver = address(uint160(_value(seed, 5, mode)));
        x.royaltyRouter = address(uint160(_value(seed, 6, mode)));
        x.marketplaceOwner = address(uint160(_value(seed, 7, mode)));
        x.metadataTable = address(uint160(_value(seed, 8, mode)));
        x.collectionSize = uint32(_value(seed, 9, mode));
        x.revealTriggers = uint8(_value(seed, 10, mode));
        x.royaltyBps = uint16(_value(seed, 11, mode));
        x.royaltyDestination = uint8(_value(seed, 12, mode));
        x.firstId = uint256(_value(seed, 13, mode));
        x.revealRoot = bytes32(_value(seed, 14, mode));
        x.metadataTableHash = bytes32(_value(seed, 15, mode));
        x.generatorHash = bytes32(_value(seed, 16, mode));
        x.collectionCoverSha256 = bytes32(_value(seed, 17, mode));
        x.bannerSha256 = bytes32(_value(seed, 18, mode));
        x.name = _text(_value(seed, 19, mode), 64);
        x.symbol = _text(_value(seed, 20, mode), 64);
        x.description = _text(_value(seed, 21, mode), 64);
        x.hiddenDescription = _text(_value(seed, 22, mode), 64);
        x.hiddenSvg = _text(_value(seed, 23, mode), 64);
        x.externalLink = _text(_value(seed, 24, mode), 64);
        bytes memory args = A.collection(x);
        uint256[] memory widths = new uint256[](19);
        uint256[] memory values = new uint256[](19);
        widths[0] = 20;
        values[0] = uint160(x.coordinator);
        widths[1] = 20;
        values[1] = uint160(x.vault);
        widths[2] = 20;
        values[2] = uint160(x.token);
        widths[3] = 20;
        values[3] = uint160(x.receiver);
        widths[4] = 20;
        values[4] = uint160(x.revealUnlocker);
        widths[5] = 20;
        values[5] = uint160(x.transferObserver);
        widths[6] = 20;
        values[6] = uint160(x.royaltyRouter);
        widths[7] = 20;
        values[7] = uint160(x.marketplaceOwner);
        widths[8] = 20;
        values[8] = uint160(x.metadataTable);
        widths[9] = 4;
        values[9] = uint256(x.collectionSize);
        widths[10] = 1;
        values[10] = uint256(x.revealTriggers);
        widths[11] = 2;
        values[11] = uint256(x.royaltyBps);
        widths[12] = 1;
        values[12] = uint256(x.royaltyDestination);
        widths[13] = 32;
        values[13] = uint256(x.firstId);
        widths[14] = 32;
        values[14] = uint256(x.revealRoot);
        widths[15] = 32;
        values[15] = uint256(x.metadataTableHash);
        widths[16] = 32;
        values[16] = uint256(x.generatorHash);
        widths[17] = 32;
        values[17] = uint256(x.collectionCoverSha256);
        widths[18] = 32;
        values[18] = uint256(x.bannerSha256);
        _roundTrip(args, widths, values, false);
        address clone = BoxClones.create(BoxClones.initCode(factory.implementations().collection, args));
        _get(clone, "coordinator()", abi.encode(x.coordinator));
        _get(clone, "vault()", abi.encode(x.vault));
        _get(clone, "token()", abi.encode(x.token));
        _get(clone, "receiver()", abi.encode(x.receiver));
        _get(clone, "revealUnlocker()", abi.encode(x.revealUnlocker));
        _get(clone, "transferObserver()", abi.encode(x.transferObserver));
        _get(
            clone,
            "royaltyRouter()",
            abi.encode(x.royaltyDestination == 0 || x.royaltyDestination > 3 ? address(0) : x.royaltyRouter)
        );
        _get(clone, "owner()", abi.encode(x.marketplaceOwner));
        _get(clone, "metadataTable()", abi.encode(x.metadataTable));
        _get(clone, "collectionSize()", abi.encode(x.collectionSize));
        _get(clone, "revealTriggers()", abi.encode(x.revealTriggers));
        _get(clone, "royaltyBps()", abi.encode(x.royaltyBps));
        _get(clone, "royaltyDestination()", abi.encode(x.royaltyDestination > 3 ? uint8(0) : x.royaltyDestination));
        _get(clone, "firstId()", abi.encode(x.firstId));
        _get(clone, "revealRoot()", abi.encode(x.revealRoot));
        _get(clone, "metadataTableHash()", abi.encode(x.metadataTableHash));
        _get(clone, "generatorHash()", abi.encode(x.generatorHash));
        _get(clone, "collectionCoverSha256()", abi.encode(x.collectionCoverSha256));
        _get(clone, "bannerSha256()", abi.encode(x.bannerSha256));
        _get(clone, "name()", abi.encode(x.name));
        _get(clone, "symbol()", abi.encode(x.symbol));
        _get(clone, "description()", abi.encode(x.description));
        _get(clone, "hiddenDescription()", abi.encode(x.hiddenDescription));
        _get(clone, "hiddenSvg()", abi.encode(x.hiddenSvg));
        _get(clone, "externalLink()", abi.encode(x.externalLink));
    }

    function testFuzz_AUDIT_U1_vaultLayout(uint256 seed) public {
        for (uint256 mode; mode < 4; ++mode) {
            _vault(seed, mode);
        }
    }

    function _vault(uint256 seed, uint256 mode) internal {
        A.VaultArgs memory x;
        x.coordinator = address(uint160(_value(seed, 0, mode)));
        x.token = address(uint160(_value(seed, 1, mode)));
        x.collection = address(uint160(_value(seed, 2, mode)));
        x.ticketAdapter = address(uint160(_value(seed, 3, mode)));
        x.observer = address(uint160(_value(seed, 4, mode)));
        x.collectionSize = uint64(_value(seed, 5, mode));
        x.drawFeeBps = uint16(_value(seed, 6, mode));
        x.pickFeeBps = uint16(_value(seed, 7, mode));
        x.returnFeeBps = uint16(_value(seed, 8, mode));
        x.firstId = uint256(_value(seed, 9, mode));
        bytes memory args = A.vault(x);
        uint256[] memory widths = new uint256[](10);
        uint256[] memory values = new uint256[](10);
        widths[0] = 20;
        values[0] = uint160(x.coordinator);
        widths[1] = 20;
        values[1] = uint160(x.token);
        widths[2] = 20;
        values[2] = uint160(x.collection);
        widths[3] = 20;
        values[3] = uint160(x.ticketAdapter);
        widths[4] = 20;
        values[4] = uint160(x.observer);
        widths[5] = 8;
        values[5] = uint256(x.collectionSize);
        widths[6] = 2;
        values[6] = uint256(x.drawFeeBps);
        widths[7] = 2;
        values[7] = uint256(x.pickFeeBps);
        widths[8] = 2;
        values[8] = uint256(x.returnFeeBps);
        widths[9] = 32;
        values[9] = uint256(x.firstId);
        _roundTrip(args, widths, values, false);
        address clone = BoxClones.create(BoxClones.initCode(factory.implementations().vault, args));
        _get(clone, "coordinator()", abi.encode(x.coordinator));
        _get(clone, "token()", abi.encode(x.token));
        _get(clone, "collection()", abi.encode(x.collection));
        _get(clone, "ticketAdapter()", abi.encode(x.ticketAdapter));
        _get(clone, "observer()", abi.encode(x.observer));
        _get(clone, "collectionSize()", abi.encode(x.collectionSize));
        _get(clone, "drawFeeBps()", abi.encode(x.drawFeeBps));
        _get(clone, "pickFeeBps()", abi.encode(x.pickFeeBps));
        _get(clone, "returnFeeBps()", abi.encode(x.returnFeeBps));
        _get(clone, "firstId()", abi.encode(x.firstId));
    }

    function testFuzz_AUDIT_U1_ticketsLayout(uint256 seed) public {
        for (uint256 mode; mode < 4; ++mode) {
            _tickets(seed, mode);
        }
    }

    function _tickets(uint256 seed, uint256 mode) internal {
        A.TicketsArgs memory x;
        x.coordinator = address(uint160(_value(seed, 0, mode)));
        x.vault = address(uint160(_value(seed, 1, mode)));
        x.collection = address(uint160(_value(seed, 2, mode)));
        x.token = address(uint160(_value(seed, 3, mode)));
        x.source = address(uint160(_value(seed, 4, mode)));
        x.openAt = uint32(_value(seed, 5, mode));
        x.collectionSize = uint32(_value(seed, 6, mode));
        x.firstId = uint256(_value(seed, 7, mode));
        x.name = _text(_value(seed, 8, mode), 64);
        x.symbol = _text(_value(seed, 9, mode), 64);
        x.description = _text(_value(seed, 10, mode), 64);
        bytes memory args = A.tickets(x);
        uint256[] memory widths = new uint256[](8);
        uint256[] memory values = new uint256[](8);
        widths[0] = 20;
        values[0] = uint160(x.coordinator);
        widths[1] = 20;
        values[1] = uint160(x.vault);
        widths[2] = 20;
        values[2] = uint160(x.collection);
        widths[3] = 20;
        values[3] = uint160(x.token);
        widths[4] = 20;
        values[4] = uint160(x.source);
        widths[5] = 4;
        values[5] = uint256(x.openAt);
        widths[6] = 4;
        values[6] = uint256(x.collectionSize);
        widths[7] = 32;
        values[7] = uint256(x.firstId);
        _roundTrip(args, widths, values, false);
        address clone = BoxClones.create(BoxClones.initCode(factory.implementations().tickets, args));
        _get(clone, "coordinator()", abi.encode(x.coordinator));
        _get(clone, "vault()", abi.encode(x.vault));
        _get(clone, "collection()", abi.encode(x.collection));
        _get(clone, "token()", abi.encode(x.token));
        _get(clone, "source()", abi.encode(x.source));
        _get(clone, "collectionSize()", abi.encode(x.collectionSize));
        _get(clone, "firstId()", abi.encode(x.firstId));
        _get(clone, "name()", abi.encode(x.name));
        _get(clone, "symbol()", abi.encode(x.symbol));
    }

    function testFuzz_AUDIT_U1_royaltyLayout(uint256 seed) public {
        for (uint256 mode; mode < 4; ++mode) {
            _royalty(seed, mode);
        }
    }

    function _royalty(uint256 seed, uint256 mode) internal {
        A.RouterArgs memory x;
        x.coordinator = address(uint160(_value(seed, 0, mode)));
        x.receiver = address(uint160(_value(seed, 1, mode)));
        x.weth = address(uint160(_value(seed, 2, mode)));
        x.destination = uint8(_value(seed, 3, mode));
        bytes memory args = A.router(x);
        uint256[] memory widths = new uint256[](4);
        uint256[] memory values = new uint256[](4);
        widths[0] = 20;
        values[0] = uint160(x.coordinator);
        widths[1] = 20;
        values[1] = uint160(x.receiver);
        widths[2] = 20;
        values[2] = uint160(x.weth);
        widths[3] = 1;
        values[3] = uint256(x.destination);
        _roundTrip(args, widths, values, true);
        address clone = BoxClones.create(BoxClones.initCodeReceiving(factory.implementations().royaltyRouter, args));
        _get(clone, "coordinator()", abi.encode(x.coordinator));
        _get(clone, "receiver()", abi.encode(x.receiver));
        _get(clone, "weth()", abi.encode(x.weth));
        _get(clone, "destination()", abi.encode(x.destination == 2 || x.destination == 3 ? x.destination : uint8(1)));
    }

    function testFuzz_AUDIT_U1_streamLayout(uint256 seed) public {
        for (uint256 mode; mode < 6; ++mode) {
            _stream(seed, mode);
        }
    }

    function _stream(uint256 seed, uint256 mode) internal {
        A.StreamArgs memory x;
        x.coordinator = address(uint160(_value(seed, 0, mode)));
        x.token = address(uint160(_value(seed, 1, mode)));
        x.collection = address(uint160(_value(seed, 2, mode)));
        x.vault = address(uint160(_value(seed, 3, mode)));
        x.tickets = address(uint160(_value(seed, 4, mode)));
        x.receiver = address(uint160(_value(seed, 5, mode)));
        x.hook = address(uint160(_value(seed, 6, mode)));
        x.tickLower = int24(uint24(_value(seed, 7, mode)));
        x.tickUpper = int24(uint24(_value(seed, 8, mode)));
        x.collectionSize = uint32(_value(seed, 9, mode));
        x.firstId = uint256(_value(seed, 10, mode));
        bytes memory args = A.stream(x);
        uint256[] memory widths = new uint256[](11);
        uint256[] memory values = new uint256[](11);
        widths[0] = 20;
        values[0] = uint160(x.coordinator);
        widths[1] = 20;
        values[1] = uint160(x.token);
        widths[2] = 20;
        values[2] = uint160(x.collection);
        widths[3] = 20;
        values[3] = uint160(x.vault);
        widths[4] = 20;
        values[4] = uint160(x.tickets);
        widths[5] = 20;
        values[5] = uint160(x.receiver);
        widths[6] = 20;
        values[6] = uint160(x.hook);
        widths[7] = 3;
        values[7] = uint24(x.tickLower);
        widths[8] = 3;
        values[8] = uint24(x.tickUpper);
        widths[9] = 4;
        values[9] = uint256(x.collectionSize);
        widths[10] = 32;
        values[10] = uint256(x.firstId);
        _roundTrip(args, widths, values, false);
        address clone = BoxClones.create(BoxClones.initCode(factory.implementations().itemStream, args));
        _get(clone, "coordinator()", abi.encode(x.coordinator));
        _get(clone, "token()", abi.encode(x.token));
        _get(clone, "collection()", abi.encode(x.collection));
        _get(clone, "vault()", abi.encode(x.vault));
        _get(clone, "tickets()", abi.encode(x.tickets));
        _get(clone, "receiver()", abi.encode(x.receiver));
        _get(clone, "hook()", abi.encode(x.hook));
        _get(clone, "collectionSize()", abi.encode(x.collectionSize));
        _get(clone, "firstId()", abi.encode(x.firstId));
    }

    function testFuzz_AUDIT_U1_coordinatorLayout(uint256 seed) public {
        for (uint256 mode; mode < 4; ++mode) {
            uint256[] memory widths = new uint256[](17);
            uint256[] memory values = new uint256[](17);
            bytes memory args;
            widths[0] = 1;
            values[0] = _value(seed, 0, mode) & (type(uint256).max >> 248);
            args = bytes.concat(args, bytes1(uint8(values[0])));
            widths[1] = 20;
            values[1] = _value(seed, 1, mode) & (type(uint256).max >> 96);
            args = bytes.concat(args, bytes20(uint160(values[1])));
            widths[2] = 16;
            values[2] = _value(seed, 2, mode) & (type(uint256).max >> 128);
            args = bytes.concat(args, bytes16(uint128(values[2])));
            widths[3] = 16;
            values[3] = _value(seed, 3, mode) & (type(uint256).max >> 128);
            args = bytes.concat(args, bytes16(uint128(values[3])));
            widths[4] = 20;
            values[4] = _value(seed, 4, mode) & (type(uint256).max >> 96);
            args = bytes.concat(args, bytes20(uint160(values[4])));
            widths[5] = 32;
            values[5] = _value(seed, 5, mode) & (type(uint256).max >> 0);
            args = bytes.concat(args, bytes32(uint256(values[5])));
            widths[6] = 20;
            values[6] = _value(seed, 6, mode) & (type(uint256).max >> 96);
            args = bytes.concat(args, bytes20(uint160(values[6])));
            widths[7] = 20;
            values[7] = _value(seed, 7, mode) & (type(uint256).max >> 96);
            args = bytes.concat(args, bytes20(uint160(values[7])));
            widths[8] = 1;
            values[8] = _value(seed, 8, mode) & (type(uint256).max >> 248);
            args = bytes.concat(args, bytes1(uint8(values[8])));
            widths[9] = 1;
            values[9] = _value(seed, 9, mode) & (type(uint256).max >> 248);
            args = bytes.concat(args, bytes1(uint8(values[9])));
            widths[10] = 1;
            values[10] = _value(seed, 10, mode) & (type(uint256).max >> 248);
            args = bytes.concat(args, bytes1(uint8(values[10])));
            widths[11] = 1;
            values[11] = _value(seed, 11, mode) & (type(uint256).max >> 248);
            args = bytes.concat(args, bytes1(uint8(values[11])));
            widths[12] = 1;
            values[12] = _value(seed, 12, mode) & (type(uint256).max >> 248);
            args = bytes.concat(args, bytes1(uint8(values[12])));
            widths[13] = 1;
            values[13] = _value(seed, 13, mode) & (type(uint256).max >> 248);
            args = bytes.concat(args, bytes1(uint8(values[13])));
            widths[14] = 1;
            values[14] = _value(seed, 14, mode) & (type(uint256).max >> 248);
            args = bytes.concat(args, bytes1(uint8(values[14])));
            widths[15] = 1;
            values[15] = _value(seed, 15, mode) & (type(uint256).max >> 248);
            args = bytes.concat(args, bytes1(uint8(values[15])));
            widths[16] = 1;
            values[16] = _value(seed, 16, mode) & (type(uint256).max >> 248);
            args = bytes.concat(args, bytes1(uint8(values[16])));
            _roundTrip(args, widths, values, false);
            _manualDecoded(0, args, values);
        }
    }

    function testFuzz_AUDIT_U1_hookLayout(uint256 seed) public {
        for (uint256 mode; mode < 6; ++mode) {
            uint256[] memory widths = new uint256[](14);
            uint256[] memory values = new uint256[](14);
            bytes memory args;
            widths[0] = 20;
            values[0] = _value(seed, 0, mode) & (type(uint256).max >> 96);
            args = bytes.concat(args, bytes20(uint160(values[0])));
            widths[1] = 20;
            values[1] = _value(seed, 1, mode) & (type(uint256).max >> 96);
            args = bytes.concat(args, bytes20(uint160(values[1])));
            widths[2] = 20;
            values[2] = _value(seed, 2, mode) & (type(uint256).max >> 96);
            args = bytes.concat(args, bytes20(uint160(values[2])));
            widths[3] = 20;
            values[3] = _value(seed, 3, mode) & (type(uint256).max >> 96);
            args = bytes.concat(args, bytes20(uint160(values[3])));
            widths[4] = 20;
            values[4] = _value(seed, 4, mode) & (type(uint256).max >> 96);
            args = bytes.concat(args, bytes20(uint160(values[4])));
            widths[5] = 1;
            values[5] = _value(seed, 5, mode) & (type(uint256).max >> 248);
            args = bytes.concat(args, bytes1(uint8(values[5])));
            widths[6] = 3;
            values[6] = _value(seed, 6, mode) & (type(uint256).max >> 232);
            args = bytes.concat(args, bytes3(uint24(values[6])));
            widths[7] = 3;
            values[7] = _value(seed, 7, mode) & (type(uint256).max >> 232);
            args = bytes.concat(args, bytes3(uint24(values[7])));
            widths[8] = 4;
            values[8] = _value(seed, 8, mode) & (type(uint256).max >> 224);
            args = bytes.concat(args, bytes4(uint32(values[8])));
            widths[9] = 16;
            values[9] = _value(seed, 9, mode) & (type(uint256).max >> 128);
            args = bytes.concat(args, bytes16(uint128(values[9])));
            widths[10] = 16;
            values[10] = _value(seed, 10, mode) & (type(uint256).max >> 128);
            args = bytes.concat(args, bytes16(uint128(values[10])));
            widths[11] = 20;
            values[11] = _value(seed, 11, mode) & (type(uint256).max >> 96);
            args = bytes.concat(args, bytes20(uint160(values[11])));
            widths[12] = 20;
            values[12] = _value(seed, 12, mode) & (type(uint256).max >> 96);
            args = bytes.concat(args, bytes20(uint160(values[12])));
            widths[13] = 20;
            values[13] = _value(seed, 13, mode) & (type(uint256).max >> 96);
            args = bytes.concat(args, bytes20(uint160(values[13])));
            _roundTrip(args, widths, values, false);
            _manualDecoded(1, args, values);
        }
    }

    function testFuzz_AUDIT_U1_receiverLayout(uint256 seed) public {
        for (uint256 mode; mode < 4; ++mode) {
            uint256[] memory widths = new uint256[](15);
            uint256[] memory values = new uint256[](15);
            bytes memory args;
            widths[0] = 1;
            values[0] = _value(seed, 0, mode) & (type(uint256).max >> 248);
            args = bytes.concat(args, bytes1(uint8(values[0])));
            widths[1] = 20;
            values[1] = _value(seed, 1, mode) & (type(uint256).max >> 96);
            args = bytes.concat(args, bytes20(uint160(values[1])));
            widths[2] = 20;
            values[2] = _value(seed, 2, mode) & (type(uint256).max >> 96);
            args = bytes.concat(args, bytes20(uint160(values[2])));
            widths[3] = 20;
            values[3] = _value(seed, 3, mode) & (type(uint256).max >> 96);
            args = bytes.concat(args, bytes20(uint160(values[3])));
            widths[4] = 20;
            values[4] = _value(seed, 4, mode) & (type(uint256).max >> 96);
            args = bytes.concat(args, bytes20(uint160(values[4])));
            widths[5] = 20;
            values[5] = _value(seed, 5, mode) & (type(uint256).max >> 96);
            args = bytes.concat(args, bytes20(uint160(values[5])));
            widths[6] = 20;
            values[6] = _value(seed, 6, mode) & (type(uint256).max >> 96);
            args = bytes.concat(args, bytes20(uint160(values[6])));
            widths[7] = 20;
            values[7] = _value(seed, 7, mode) & (type(uint256).max >> 96);
            args = bytes.concat(args, bytes20(uint160(values[7])));
            widths[8] = 1;
            values[8] = _value(seed, 8, mode) & (type(uint256).max >> 248);
            args = bytes.concat(args, bytes1(uint8(values[8])));
            widths[9] = 1;
            values[9] = _value(seed, 9, mode) & (type(uint256).max >> 248);
            args = bytes.concat(args, bytes1(uint8(values[9])));
            widths[10] = 1;
            values[10] = _value(seed, 10, mode) & (type(uint256).max >> 248);
            args = bytes.concat(args, bytes1(uint8(values[10])));
            widths[11] = 20;
            values[11] = _value(seed, 11, mode) & (type(uint256).max >> 96);
            args = bytes.concat(args, bytes20(uint160(values[11])));
            widths[12] = 20;
            values[12] = _value(seed, 12, mode) & (type(uint256).max >> 96);
            args = bytes.concat(args, bytes20(uint160(values[12])));
            widths[13] = 16;
            values[13] = _value(seed, 13, mode) & (type(uint256).max >> 128);
            args = bytes.concat(args, bytes16(uint128(values[13])));
            widths[14] = 1;
            values[14] = _value(seed, 14, mode) & (type(uint256).max >> 248);
            args = bytes.concat(args, bytes1(uint8(values[14])));
            _roundTrip(args, widths, values, false);
            _manualDecoded(2, args, values);
        }
    }

    function testFuzz_AUDIT_U1_launchRouterLayout(uint256 seed) public {
        for (uint256 mode; mode < 4; ++mode) {
            uint256[] memory widths = new uint256[](7);
            uint256[] memory values = new uint256[](7);
            bytes memory args;
            widths[0] = 1;
            values[0] = _value(seed, 0, mode) & (type(uint256).max >> 248);
            args = bytes.concat(args, bytes1(uint8(values[0])));
            widths[1] = 20;
            values[1] = _value(seed, 1, mode) & (type(uint256).max >> 96);
            args = bytes.concat(args, bytes20(uint160(values[1])));
            widths[2] = 20;
            values[2] = _value(seed, 2, mode) & (type(uint256).max >> 96);
            args = bytes.concat(args, bytes20(uint160(values[2])));
            widths[3] = 20;
            values[3] = _value(seed, 3, mode) & (type(uint256).max >> 96);
            args = bytes.concat(args, bytes20(uint160(values[3])));
            widths[4] = 20;
            values[4] = _value(seed, 4, mode) & (type(uint256).max >> 96);
            args = bytes.concat(args, bytes20(uint160(values[4])));
            widths[5] = 20;
            values[5] = _value(seed, 5, mode) & (type(uint256).max >> 96);
            args = bytes.concat(args, bytes20(uint160(values[5])));
            widths[6] = 4;
            values[6] = _value(seed, 6, mode) & (type(uint256).max >> 224);
            args = bytes.concat(args, bytes4(uint32(values[6])));
            _roundTrip(args, widths, values, false);
            _manualDecoded(3, args, values);
        }
    }

    function _enum(address c, string memory signature, uint256 raw, uint256 maximum) internal {
        if (raw <= maximum) {
            _get(c, signature, abi.encode(raw));
        } else {
            (bool ok, bytes memory ret) = c.staticcall(abi.encodeWithSignature(signature));
            assertFalse(ok);
            assertEq(ret, abi.encodeWithSignature("Panic(uint256)", 0x21));
        }
    }

    function _manualDecoded(uint256 kind, bytes memory args, uint256[] memory v) internal {
        address impl = kind == 0
            ? factory.implementations().coordinator
            : kind == 1
                ? factory.implementations().hook
                : kind == 2 ? factory.implementations().receiver : factory.implementations().launchRouter;
        address c = BoxClones.create(BoxClones.initCode(impl, args));
        _enum(c, "kind()", kind == 1 ? v[5] : v[0], 2);
        if (kind == 2) _enum(c, "royaltyDestination()", v[10], 3);
        if (kind == 0) {
            _get(c, "q()", abi.encode(v[1]));
            _get(c, "raise()", abi.encode(v[2]));
            _get(c, "creatorBuyAmount()", abi.encode(v[3]));
            _get(c, "creator()", abi.encode(v[4]));
            _get(c, "specHash()", abi.encode(v[5]));
            _get(c, "randomness()", abi.encode(v[7]));
            for (uint256 j; j < 9; ++j) {
                (bool ok, bytes memory ret) = c.staticcall(abi.encodeWithSignature("nonceOf(uint8)", uint8(j)));
                assertTrue(ok);
                assertEq(abi.decode(ret, (uint256)), v[8 + j]);
            }
        } else if (kind == 1) {
            _get(c, "q()", abi.encode(v[0]));
            _get(c, "token()", abi.encode(v[1]));
            _get(c, "launchRouter()", abi.encode(v[4]));
            _get(c, "raise()", abi.encode(v[10]));
            _get(c, "coordinator()", abi.encode(v[11]));
            _get(c, "receiver()", abi.encode(v[12]));
            _get(c, "priceAverage()", abi.encode(v[13]));
            vm.store(c, bytes32(0), bytes32(uint256(1))); // reader-only harness: launched curve view
            _get(c, "curve()", abi.encode(int24(uint24(v[6])), int24(uint24(v[7])), uint128(v[9])));
        } else if (kind == 2) {
            _get(c, "q()", abi.encode(v[1]));
            _get(c, "token()", abi.encode(v[2]));
            _get(c, "coordinator()", abi.encode(v[3]));
            _get(c, "hook()", abi.encode(v[4]));
            _get(c, "executor()", abi.encode(v[5]));
            _get(c, "platformSafe()", abi.encode(v[6]));
            _get(c, "itemStream()", abi.encode(v[7]));
            _get(c, "qStream()", abi.encode(v[8]));
            _get(c, "tStream()", abi.encode(v[9]));
            _get(c, "creatorPayee()", abi.encode(v[11]));
            _get(c, "swapModule()", abi.encode(v[12]));
        } else {
            _get(c, "q()", abi.encode(v[1]));
            _get(c, "token()", abi.encode(v[2]));
            _get(c, "hook()", abi.encode(v[3]));
            _get(c, "coordinator()", abi.encode(v[4]));
        }
    }

    /// The text headers encode uint8/uint16 lengths; maxima too large for EIP-170 are encoded faithfully but
    /// rejected as a deployable clone. Zero and one-byte texts are separately exercised above.
    function testProperty_AUDIT_U1_textLengthMaximaAndRuntimeBound() public {
        A.CollectionArgs memory c;
        c.name = string(new bytes(255));
        c.symbol = c.name;
        c.externalLink = c.name;
        c.description = string(new bytes(65535));
        c.hiddenDescription = c.description;
        c.hiddenSvg = c.description;
        bytes memory encodedArgs = A.collection(c);
        assertEq(encodedArgs.length, 389 + 3 * 255 + 3 * 65535);
        assertEq(uint8(encodedArgs[380]), 255);
        assertEq(uint8(encodedArgs[381]), 255);
        for (uint256 j = 382; j < 389; ++j) {
            assertEq(uint8(encodedArgs[j]), 255);
        }
        vm.expectRevert(abi.encodeWithSelector(BoxClones.ArgsTooLong.selector, 45 + encodedArgs.length));
        this.wrap(encodedArgs);
        A.TicketsArgs memory t;
        t.name = c.name;
        t.symbol = c.symbol;
        t.description = c.description;
        encodedArgs = A.tickets(t);
        assertEq(encodedArgs.length, 144 + 510 + 65535);
        for (uint256 j = 140; j < 144; ++j) {
            assertEq(uint8(encodedArgs[j]), 255);
        }
        vm.expectRevert(abi.encodeWithSelector(BoxClones.ArgsTooLong.selector, 45 + encodedArgs.length));
        this.wrap(encodedArgs);
        assertEq(this.wrap(new bytes(24531)).length, 24586);
        vm.expectRevert(abi.encodeWithSelector(BoxClones.ArgsTooLong.selector, 24577));
        this.wrap(new bytes(24532));
    }

    function wrap(bytes memory args) external view returns (bytes memory) {
        return BoxClones.initCode(reader, args);
    }
}
