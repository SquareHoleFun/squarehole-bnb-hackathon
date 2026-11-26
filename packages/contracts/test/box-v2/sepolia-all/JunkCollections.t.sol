// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {ERC721Holder} from "v4-core/lib/openzeppelin-contracts/contracts/token/ERC721/utils/ERC721Holder.sol";
import {JunkCollection} from "../../../src/test-coins/JunkCollection.sol";
import {JunkCollectionCatalog} from "../../../src/test-coins/JunkCollectionCatalog.sol";
import {JunkCollections} from "../../../script/sepolia-v2/JunkCollections.s.sol";
import {BoxEncoding} from "../../../src/box/libraries/BoxEncoding.sol";

// Models only the deployed Safe's ERC721 receiver, not its signature/threshold machinery.
contract JunkSafeReceiver is ERC721Holder {}

contract JunkCollectionsTest is Test {
    address private constant FOUNDER = address(0xF040);
    JunkSafeReceiver private safe;
    address[5] private collections;

    function setUp() public {
        vm.chainId(31337);
        safe = new JunkSafeReceiver();
        for (uint8 kind; kind < 5; ++kind) {
            JunkCollection collection = new JunkCollection(FOUNDER, kind);
            collections[kind] = address(collection);
            vm.startPrank(FOUNDER);
            collection.mint(address(safe), 1, 1);
            collection.mint(address(safe), 2, 2);
            vm.stopPrank();
        }
    }

    function test_TA40_fiveNamedCollectionsTenSafeStartersAndRawImageMetadata() public view {
        string[5] memory names = ["Test Junk Bent Cans", "Test Junk Lost Cogs", "Test Junk Split Boots",
            "Test Junk Cracked Mugs", "Test Junk Tangled Wires"];
        string[5] memory symbols = ["tJCAN", "tJCOG", "tJBOOT", "tJMUG", "tJWIRE"];
        for (uint8 kind; kind < 5; ++kind) {
            JunkCollection collection = JunkCollection(collections[kind]);
            assertEq(collection.name(), names[kind]);
            assertEq(collection.symbol(), symbols[kind]);
            assertEq(collection.owner(), FOUNDER);
            assertEq(collection.kind(), kind);
            assertEq(collection.balanceOf(address(safe)), 2);
            assertEq(collection.balanceOf(FOUNDER), 0);
            assertTrue(collection.supportsInterface(0x01ffc9a7));
            assertTrue(collection.supportsInterface(0x80ac58cd));
            assertTrue(collection.supportsInterface(0x5b5e139f));
            assertFalse(collection.supportsInterface(0xffffffff));
            for (uint8 picture = 1; picture <= 2; ++picture) {
                assertEq(collection.ownerOf(picture), address(safe));
                string memory image = string.concat("ipfs://", BoxEncoding.rawCidV1(JunkCollectionCatalog.digest(kind, picture)));
                assertEq(collection.imageURI(picture), image);
                string memory json = collection.metadataJSON(picture);
                assertEq(vm.parseJsonString(json, ".image"), image);
                assertEq(vm.parseJsonString(json, ".name"), string.concat(names[kind], " #", vm.toString(picture)));
                assertEq(collection.tokenURI(picture), string.concat("data:application/json;base64,", BoxEncoding.base64(bytes(json))));
            }
        }
    }

    function test_TA40_authorizationInvalidMintAndReceiverRollback() public {
        JunkCollection collection = JunkCollection(collections[0]);
        vm.expectRevert("owner"); collection.mint(address(safe), 3, 1);
        vm.startPrank(FOUNDER);
        vm.expectRevert(); collection.mint(address(safe), 1, 2);
        vm.expectRevert(); collection.mint(address(0), 3, 1);
        vm.expectRevert(); collection.mint(address(safe), 0, 1);
        vm.expectRevert(); collection.mint(address(safe), 3, 0);
        vm.expectRevert(); collection.mint(address(safe), 3, 3);
        vm.expectRevert(); collection.mint(address(this), 3, 1); // not a receiver
        collection.mint(address(safe), 3, 2); // failed receipt did not consume the id
        vm.stopPrank();
        assertEq(collection.balanceOf(address(safe)), 3);
        assertEq(collection.imageURI(1), string.concat("ipfs://", BoxEncoding.rawCidV1(JunkCollectionCatalog.digest(0, 1))));
        vm.expectRevert(); collection.tokenURI(99);
        vm.expectRevert(); collection.imageURI(99);
    }

    function testFuzz_TA40_ownerMintsImmutableArtAndApprovedTransfers(uint256 id, uint8 picture) public {
        id = bound(id, 3, type(uint256).max);
        picture = uint8(bound(picture, 1, 2));
        JunkCollection collection = JunkCollection(collections[2]);
        vm.prank(FOUNDER); collection.mint(address(safe), id, picture);
        string memory beforeURI = collection.tokenURI(id);
        vm.expectRevert(); collection.transferFrom(address(safe), FOUNDER, id);
        vm.prank(address(safe)); collection.approve(address(this), id);
        collection.transferFrom(address(safe), FOUNDER, id);
        assertEq(collection.ownerOf(id), FOUNDER);
        assertEq(collection.getApproved(id), address(0));
        assertEq(collection.tokenURI(id), beforeURI);
    }

    function test_TA40_chainKindAndAddressGuards() public {
        JunkCollections script = new JunkCollections();
        vm.chainId(1);
        vm.expectRevert(); new JunkCollection(FOUNDER, 0);
        vm.expectRevert(); script.run();
        vm.chainId(10);
        vm.expectRevert(); new JunkCollection(FOUNDER, 0);
        vm.chainId(11_155_111);
        assertEq(new JunkCollection(FOUNDER, 4).owner(), FOUNDER);
        vm.chainId(31337);
        vm.expectRevert(); new JunkCollection(address(0), 0);
        vm.expectRevert(); new JunkCollection(FOUNDER, 5);
    }

    // Keep all environment mutations in one test: Foundry's environment is process-global across test workers.
    function test_TA40_scriptGuardsSimulatesAndRecordsEveryTransaction() public {
        JunkCollections script = new JunkCollections();
        vm.setEnv("JUNK_DEPLOYER", vm.toString(FOUNDER));
        vm.setEnv("JUNK_SAFE", vm.toString(address(safe)));
        vm.setEnv("JUNK_BROADCAST", "false");
        address[5] memory simulated = script.run();
        for (uint8 i; i < 5; ++i) {
            assertEq(JunkCollection(simulated[i]).owner(), FOUNDER);
            assertEq(JunkCollection(simulated[i]).name(), JunkCollectionCatalog.name(i));
            assertEq(JunkCollection(simulated[i]).balanceOf(address(safe)), 2);
        }
        vm.setEnv("JUNK_BROADCAST", "true");
        vm.expectRevert("deployer"); script.run();
        vm.setEnv("JUNK_DEPLOYER", vm.toString(address(this)));
        vm.recordLogs();
        address[5] memory issued = script.run();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 creations;
        uint256 mints;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != keccak256("JunkTransactionGas(string,uint256,uint256)")) continue;
            (string memory label, uint256 total, uint256 state) = abi.decode(logs[i].data, (string, uint256, uint256));
            assertGt(total, 21_000);
            assertLe(total * 130 / 100, 16_777_216);
            assertLe(state, total);
            if (keccak256(bytes(label)) == keccak256("deploy")) ++creations;
            else { assertEq(label, "mint"); ++mints; }
            emit log_named_uint(label, total);
        }
        assertEq(creations, 5);
        assertEq(mints, 10);
        for (uint256 i; i < 5; ++i) {
            assertEq(JunkCollection(issued[i]).owner(), address(this));
            assertEq(JunkCollection(issued[i]).balanceOf(address(safe)), 2);
        }
        vm.setEnv("JUNK_BROADCAST", "false");
        vm.setEnv("JUNK_SAFE", vm.toString(address(0)));
        vm.expectRevert(); script.run();
        vm.setEnv("JUNK_SAFE", vm.toString(FOUNDER));
        vm.expectRevert(); script.run();
        vm.setEnv("JUNK_SAFE", vm.toString(address(safe)));
        vm.setEnv("JUNK_DEPLOYER", vm.toString(address(0)));
        vm.expectRevert(); script.run();
        vm.setEnv("JUNK_DEPLOYER", vm.toString(FOUNDER));
    }
}
