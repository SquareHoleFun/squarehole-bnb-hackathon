// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {BoxCollectionV2} from "../../src/box-v2/BoxCollectionV2.sol";
import {BoxClones} from "../../src/box/libraries/BoxClones.sol";
import {UniqueArtChecks, UniqueArtFixture} from "../box-v2/unique-art/UniqueArtFixture.sol";
import {BagHoldersRevealFixture} from "../box-v2/unique-art/bag-holders.sol";
import {IBoxCollection} from "../../src/box/interfaces/IBoxCollection.sol";
import {BoxSpec} from "../../src/box-v2/interfaces/SpecTypes.sol";
import {BoxFactoryV2} from "../../src/box-v2/BoxFactoryV2.sol";
import {IBoxCoordinatorV2, ChunkPart} from "../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";
import {IListingRegistry} from "../../src/box-v2/interfaces/IListingRegistry.sol";
import {PrepareCoreV2Box} from "../../script/sepolia-v2/PrepareCoreV2Box.s.sol";

/// @notice The new unique Bag Holders edition: the same committed fixture as the four-kit T07 suite.
/// Local replay is always enabled; the historical Sepolia fork check remains explicitly opt-in.
contract AlchemistRevealsTest is UniqueArtChecks {
    function _data() internal override returns (bytes memory) { return _fixtureCode("bag-holders.sol:BagHoldersRevealFixture"); }

    function _replay(BoxCollectionV2 c, UniqueArtFixture.Data memory f) private {
        assertEq(f.items.length, 420); assertEq(f.modelItems, 420);
        assertEq(c.revealRoot(), f.root);
        assertEq(c.revealedCount(), 0);
        address implementation;
        assembly ("memory-safe") {
            extcodecopy(c, 0, 10, 20)
            implementation := shr(96, mload(0))
        }
        assertTrue(BoxClones.isCloneOf(address(c), implementation));
        uint256 total; uint256 maximum; uint256 first;
        uint256 sample;
        for (uint256 i; i < f.items.length; ++i) {
            // Use actual reveal-open-v2 output at all seven sample ids, including the first and last.
            bytes memory data = _call(f.items[i]);
            if (sample < f.sampleIds.length && f.items[i].id == f.sampleIds[sample]) {
                assertEq(data, f.calls[sample]);
                data = f.calls[sample++];
            }
            // Isolated assertion frame also checks both events, all returned fields, exact metadata and economics.
            uint256 used = this.checkReveal(c, f.items[i], data) + 21_000;
            for (uint256 j; j < data.length; ++j) used += data[j] == 0 ? 4 : 16;
            if (i == 0) first = used;
            if (used > maximum) maximum = used;
            total += used;
        }
        assertEq(sample, 7);
        // Only the reveal call plus intrinsic/calldata, with accounts warmed by precondition checks. Storage
        // originals are shared across calls: these are local envelopes, never RPC estimates or receipt gas.
        emit log_named_uint("420 warm reveal envelopes total", total);
        emit log_named_uint("first warm reveal envelope", first);
        emit log_named_uint("largest warm reveal envelope", maximum);
        assertEq(c.revealedCount(), 420);
        vm.recordLogs();
        (bool duplicate, bytes memory reason) = address(c).call(_call(f.items[0]));
        assertFalse(duplicate);
        assertEq(reason, abi.encodeWithSelector(IBoxCollection.AlreadyRevealed.selector, 1));
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(c.revealedCount(), 420);
    }

    function test_all420BagHoldersRevealAndLocalGas() public {
        UniqueArtFixture.Data memory f = _fixture();
        _replay(_collection(f, 4), f);
    }

    function test_wrongRootRevertsWithoutRevealing() public {
        UniqueArtFixture.Data memory f = _fixture();
        BoxSpec memory spec = abi.decode(f.encodedSpec, (BoxSpec));
        spec.revealRoot = bytes32(uint256(1));
        f.encodedSpec = abi.encode(spec); f.root = spec.revealRoot; f.specHash = keccak256(f.encodedSpec);
        BoxCollectionV2 c = _collection(f, 4);
        vm.recordLogs();
        (bool ok, bytes memory reason) = address(c).call(f.calls[0]);
        assertFalse(ok);
        assertEq(reason, abi.encodeWithSelector(IBoxCollection.InvalidProof.selector, 1));
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(c.revealedCount(), 0); assertFalse(c.isRevealed(1));
        (bool revealed, uint128 traits, bytes32 image, bytes32 model) = c.traitsOf(1);
        assertFalse(revealed); assertEq(traits, 0); assertEq(image, bytes32(0)); assertEq(model, bytes32(0));
    }

    function test_forkCreatesBagHoldersAndRevealsAll420() public {
        if (!vm.envOr("SH_EX_L4_FORK", false)) { vm.skip(true); return; }
        vm.createSelectFork(vm.envString("SEPOLIA_FORK_RPC_URL"), vm.envUint("SH_EX_L4_FORK_BLOCK"));
        require(block.chainid == 11_155_111, "Sepolia fork required");
        UniqueArtFixture.Data memory f = _fixture();
        BoxSpec memory spec = abi.decode(f.encodedSpec, (BoxSpec));
        BoxFactoryV2 factory = BoxFactoryV2(0xFAe1E6CFF43CAdcBE01885BdD0AA6218263de393);
        // Isolate art acceptance from future tLINK admission; use the fork's native listing and exact current raise.
        spec.raise = IListingRegistry(factory.listingRegistry()).listing(0).raise;
        spec.creatorBuy = 0;
        spec.marketplaceOwner = address(this);
        string memory prepared = new PrepareCoreV2Box().prepare(address(factory), address(this), spec, 0);
        vm.deal(address(this), 10 ether);
        uint256 value = vm.parseUint(vm.parseJsonString(prepared, ".nativeValue"));
        (bool ok, bytes memory result) = address(factory).call{value: value, gas: 16_500_000}(vm.parseJsonBytes(prepared, ".createData"));
        assertTrue(ok, "fork create failed");
        (,address coordinator,) = abi.decode(result, (uint256,address,address));
        IBoxCoordinatorV2 c = IBoxCoordinatorV2(coordinator);
        _load(c, ChunkPart.Table, vm.parseJsonBytes(prepared, ".tableCall"));
        _load(c, ChunkPart.Texts, vm.parseJsonBytes(prepared, ".textsCall"));
        assertTrue(c.gateOpen());
        _replay(BoxCollectionV2(c.collection()), f);
    }

    function _load(IBoxCoordinatorV2 c, ChunkPart part, bytes memory data) private {
        (, uint256 loaded, uint256 length) = c.chunkState(part);
        if (loaded < length) { (bool ok,) = address(c).call(data); assertTrue(ok, "chunk load failed"); }
    }
}
