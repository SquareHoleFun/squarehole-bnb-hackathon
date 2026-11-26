// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {BoxCollectionV2} from "../../../src/box-v2/BoxCollectionV2.sol";
import {BoxCollectionV2Args} from "../../../src/box-v2/libraries/BoxCollectionV2Args.sol";
import {BoxSpec} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {ChunkPart} from "../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";
import {IBoxCollection} from "../../../src/box/interfaces/IBoxCollection.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";

library UniqueArtFixture {
    struct Item {
        uint256 id;
        uint128 traitsPacked;
        bytes32 imageHash;
        bytes32 avatarHash;
        bytes32 modelHash;
        bytes32 salt;
        bytes32[] proof;
        string tokenJSON;
    }
    // Field order is the test writer's fixtureAbi, not Foundry's alphabetic JSON decoding order.
    struct Data {
        bytes encodedSpec;
        bytes32 root;
        bytes32 specHash;
        uint256 modelItems;
        Item[] items;
        uint256[] sampleIds;
        bytes[] calls;
    }
}

/// Minimal chunk provider only; every reveal, proof check, write, event and metadata read uses production code.
contract UniqueArtCoordinator {
    mapping(ChunkPart => address) private pointers;
    mapping(ChunkPart => uint256) private lengths;
    mapping(ChunkPart => bytes32) private roots;

    function load(ChunkPart part, bytes memory data) external {
        pointers[part] = BoxClones.create(BoxClones.initCode(bytes.concat(hex"00", data)));
        lengths[part] = data.length;
        roots[part] = keccak256(bytes.concat(data, bytes32(0)));
    }
    function chunkRoot(ChunkPart part) external view returns (bytes32, uint256) {
        return (roots[part], lengths[part]);
    }
    function chunkState(ChunkPart part) external view returns (bytes32, uint256, uint256) {
        uint256 count = pointers[part] == address(0) ? 0 : 1;
        return (0, count, count);
    }
    function chunkPointer(ChunkPart part, uint256) external view returns (address) { return pointers[part]; }
}

interface IUniqueArtData {
    function data() external view returns (bytes memory);
}

abstract contract UniqueArtChecks is Test {
    function _data() internal virtual returns (bytes memory);

    function _fixtureCode(string memory artifact) internal returns (bytes memory) {
        // Only the large, inert vector provider is etched. Production collections use normal CREATE below.
        // Inlining all vector bytes into test constructors exceeds Amsterdam's deployment gas budget.
        address dataProvider = address(0xDA7A);
        vm.etch(dataProvider, vm.getDeployedCode(artifact));
        return IUniqueArtData(dataProvider).data();
    }

    function _fixture() internal returns (UniqueArtFixture.Data memory) {
        return abi.decode(_data(), (UniqueArtFixture.Data));
    }

    function _collection(UniqueArtFixture.Data memory f, uint8 triggers) internal returns (BoxCollectionV2 c) {
        BoxSpec memory s = abi.decode(f.encodedSpec, (BoxSpec));
        assertEq(keccak256(abi.encode(s)), f.specHash, "unchanged complete economic/art spec");
        assertEq(s.revealRoot, f.root);
        assertEq(s.n, f.items.length);
        assertEq(s.firstId, 1);
        assertEq(s.artMode, 1);
        address ci = address(new UniqueArtCoordinator());
        UniqueArtCoordinator coordinator = UniqueArtCoordinator(BoxClones.create(BoxClones.initCode(ci, "")));
        coordinator.load(ChunkPart.Table, s.metadataTable);
        coordinator.load(ChunkPart.Texts, BoxCollectionV2Args.texts(s.description, "", "", "", ""));
        BoxCollectionV2Args.Args memory a;
        a.coordinator = address(coordinator);
        a.vault = address(0xB0B); a.token = address(0x70); a.receiver = address(0x80);
        a.marketplaceOwner = s.marketplaceOwner;
        a.collectionSize = s.n; a.firstId = s.firstId; a.revealRoot = f.root;
        a.revealTriggers = triggers;
        a.revealUnlocker = address(this);
        a.generatorHash = s.generatorHash; a.collectionCoverSha256 = s.coverSha256;
        a.name = s.collectionName; a.symbol = s.collectionSymbol;
        for (uint256 i; i < s.addOns.length; ++i) {
            if (s.addOns[i].id == 4) {
                (a.royaltyBps, a.royaltyDestination) = abi.decode(s.addOns[i].params, (uint16, uint8));
                a.royaltyRouter = address(0x90);
            }
        }
        BoxCollectionV2 impl = new BoxCollectionV2(ci);
        c = BoxCollectionV2(BoxClones.create(BoxClones.initCode(address(impl), BoxCollectionV2Args.encode(a))));
        vm.prank(address(coordinator)); c.initialize();
        assertEq(c.metadataTableBytes(), s.metadataTable);
        assertEq(c.royaltyBps(), a.royaltyBps);
        assertEq(uint8(c.royaltyDestination()), a.royaltyDestination);
    }

    function _call(UniqueArtFixture.Item memory item) internal pure returns (bytes memory) {
        return abi.encodeCall(BoxCollectionV2.reveal, (item.id, item.traitsPacked, item.imageHash,
            item.avatarHash, item.modelHash, item.salt, item.proof));
    }

    function _economics(BoxCollectionV2 c) internal view returns (bytes32) {
        (address payee, uint256 amount) = c.royaltyInfo(1, 10 ether);
        return keccak256(abi.encode(c.totalSupply(), c.balanceOf(c.vault()), c.vault(), c.token(), c.receiver(),
            c.owner(), c.royaltyBps(), c.royaltyDestination(), c.royaltyRouter(), payee, amount));
    }

    // External per-item frame bounds EVM memory growth during a full edition replay.
    function checkReveal(BoxCollectionV2 c, UniqueArtFixture.Item memory item, bytes memory callData) external returns (uint256 used) {
        uint256 count = c.revealedCount();
        bytes32 economicState = _economics(c);
        assertFalse(c.isRevealed(item.id));
        assertTrue(c.isRevealable(item.id));
        assertEq(c.leafOf(item.id, item.traitsPacked, item.imageHash, item.avatarHash, item.modelHash, item.salt),
            keccak256(abi.encode(item.id, item.traitsPacked, item.imageHash, item.avatarHash, item.modelHash, item.salt)));
        vm.recordLogs();
        uint256 before_ = gasleft();
        (bool ok, bytes memory reason) = address(c).call(callData);
        used = before_ - gasleft();
        assertTrue(ok, string(reason));
        _events(c, item);
        _revealed(c, item);
        assertEq(c.revealedCount(), count + 1);
        assertEq(_economics(c), economicState, "reveal cannot change economics");
    }

    function _events(BoxCollectionV2 c, UniqueArtFixture.Item memory item) private {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 2, "only reveal and metadata events");
        assertEq(logs[0].emitter, address(c));
        assertEq(logs[0].topics.length, 2);
        assertEq(logs[0].topics[0], keccak256("Revealed(uint256,uint128,bytes32,bytes32,bytes32)"));
        assertEq(logs[0].topics[1], bytes32(item.id));
        assertEq(logs[0].data, abi.encode(item.traitsPacked, item.imageHash, item.avatarHash, item.modelHash));
        assertEq(logs[1].emitter, address(c));
        assertEq(logs[1].topics.length, 1);
        assertEq(logs[1].topics[0], keccak256("MetadataUpdate(uint256)"));
        assertEq(logs[1].data, abi.encode(item.id));
    }

    function _revealed(BoxCollectionV2 c, UniqueArtFixture.Item memory item) private view {
        (bool revealed, uint128 traits, bytes32 image, bytes32 model) = c.traitsOf(item.id);
        assertTrue(revealed); assertEq(traits, item.traitsPacked);
        assertEq(image, item.imageHash); assertEq(model, item.modelHash);
        // V2 has no avatar getter/storage. The zero avatar is committed and checked in the event above.
        assertEq(item.avatarHash, bytes32(0));
        string memory metadata = c.tokenJSON(item.id);
        assertEq(metadata, item.tokenJSON, "reviewed traits and independent raw CIDv1 metadata");
        assertEq(vm.keyExistsJson(metadata, ".animation_url"), item.modelHash != bytes32(0));
        assertEq(c.ownerOf(item.id), c.vault());
        assertEq(c.getApproved(item.id), address(0));
        assertTrue(c.isRevealed(item.id)); assertFalse(c.isRevealable(item.id));
    }

    function _all(BoxCollectionV2 c, UniqueArtFixture.Data memory f) internal {
        uint256 models;
        for (uint256 i; i < f.items.length; ++i) {
            assertEq(f.items[i].id, i + 1);
            this.checkReveal(c, f.items[i], _call(f.items[i]));
            if (f.items[i].modelHash != bytes32(0)) ++models;
        }
        assertEq(c.revealedCount(), f.items.length);
        assertEq(models, f.modelItems);
        emit log_named_uint("items checked", f.items.length);
        emit log_named_uint("model items checked", models);
    }

}

abstract contract UniqueArtTestBase is UniqueArtChecks {
    function test_everyCommittedItem() public {
        UniqueArtFixture.Data memory f = _fixture();
        _all(_collection(f, 4), f);
    }

    function test_revealToolCallsIncludingFirstAndLast() public {
        UniqueArtFixture.Data memory f = _fixture();
        BoxCollectionV2 c = _collection(f, 4);
        assertEq(f.sampleIds.length, 7); assertEq(f.calls.length, 7);
        assertEq(f.sampleIds[0], 1); assertEq(f.sampleIds[6], f.items.length);
        for (uint256 i; i < f.calls.length; ++i) {
            UniqueArtFixture.Item memory item = f.items[f.sampleIds[i] - 1];
            assertEq(f.calls[i], _call(item), "actual prepareOpenReveals output");
            this.checkReveal(c, item, f.calls[i]);
        }
        assertEq(c.revealedCount(), 7);
    }

    function _state(BoxCollectionV2 c, uint256 id) private view returns (bytes32) {
        bytes32 metadata;
        bytes32 status;
        {
            (bool revealed, uint128 traits, bytes32 image, bytes32 model) = c.traitsOf(id);
            metadata = keccak256(abi.encode(revealed, traits, image, model));
        }
        {
            (bool left, bool unlocked, bool visible, bool revealable) = c.revealState(id);
            status = keccak256(abi.encode(left, unlocked, visible, revealable));
        }
        return keccak256(abi.encode(_economics(c), c.revealedCount(), c.ownerOf(id), c.getApproved(id),
            metadata, status, c.tokenJSON(id)));
    }

    function _reject(BoxCollectionV2 c, bytes memory data, bytes memory errorData, uint256 observedId) internal {
        bytes32 beforeState = _state(c, observedId);
        vm.record(); vm.recordLogs();
        (bool ok, bytes memory reason) = address(c).call(data);
        assertFalse(ok); assertEq(reason, errorData);
        assertEq(vm.getRecordedLogs().length, 0, "failed reveal emits nothing");
        (, bytes32[] memory writes) = vm.accesses(address(c));
        assertEq(writes.length, 0, "reject before any storage write");
        assertEq(_state(c, observedId), beforeState, "failed reveal changes no state");
    }

    function test_invalidFieldsRepeatMissingAndLocked() public {
        UniqueArtFixture.Data memory f = _fixture();
        BoxCollectionV2 c = _collection(f, 4);
        // First and last exercise both ends of the index-directed tree (including its padded tail).
        for (uint256 edge; edge < 2; ++edge) {
            uint256 index = edge == 0 ? 0 : f.items.length - 1;
            for (uint256 field; field < 7; ++field) {
                UniqueArtFixture.Item memory item = abi.decode(abi.encode(f.items[index]), (UniqueArtFixture.Item));
                if (field == 0) item.modelHash = bytes32(uint256(item.modelHash) ^ 1);
                if (field == 1) item.imageHash = bytes32(uint256(item.imageHash) ^ 1);
                if (field == 2) item.avatarHash = bytes32(uint256(item.avatarHash) ^ 1);
                if (field == 3) item.traitsPacked ^= 1;
                if (field == 4) item.salt = bytes32(uint256(item.salt) ^ 1);
                if (field == 5) item.proof[0] = bytes32(uint256(item.proof[0]) ^ 1);
                if (field == 6) item.proof = new bytes32[](0);
                _reject(c, _call(item), abi.encodeWithSelector(IBoxCollection.InvalidProof.selector, item.id), item.id);
            }
            this.checkReveal(c, f.items[index], _call(f.items[index]));
            _reject(c, _call(f.items[index]), abi.encodeWithSelector(IBoxCollection.AlreadyRevealed.selector, f.items[index].id), f.items[index].id);
        }
        UniqueArtFixture.Item memory missing = f.items[1];
        missing.id = 0;
        _reject(c, _call(missing), abi.encodeWithSelector(IBoxCollection.ERC721NonexistentToken.selector, 0), 2);
        missing.id = f.items.length + 1;
        _reject(c, _call(missing), abi.encodeWithSelector(IBoxCollection.ERC721NonexistentToken.selector, missing.id), 2);
        BoxCollectionV2 locked = _collection(f, 2);
        _reject(locked, _call(f.items[0]), abi.encodeWithSelector(IBoxCollection.NotRevealable.selector, 1), 1);
        locked.unlockReveal(1);
        this.checkReveal(locked, f.items[0], _call(f.items[0]));
        // 14 field/proof mutations + 2 repeats + 2 nonexistent ids + 1 locked item = 19 refusals per kit.
    }
}
