// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {DeployCoreV1} from "../../script/DeployCoreV1.s.sol";
import {BoxSpecV1} from "../../src/box/BoxSpecV1.sol";

contract MainnetSpecHarness is DeployCoreV1 {
    function check(BoxSpecV1.BoxSpec memory spec, uint256 chain) external pure {
        _checkSpecForChain(chain, spec);
    }
}

contract DeployCoreV1MainnetSpecTest is Test {
    MainnetSpecHarness internal h;

    function setUp() public {
        h = new MainnetSpecHarness();
    }

    function synthetic() internal view returns (BoxSpecV1.BoxSpec memory s) {
        s = h.fixtureSpec();
        s.revealRoot = keccak256("synthetic mainnet spec root");
        s.generatorHash = bytes32(bytes20(hex"1234567890abcdef1234567890abcdef12345678"));
        // v1, description "Synthetic", type Family, values Alpha/Beta.
        s.metadataTable = hex"01000953796e746865746963010646616d696c790205416c7068610442657461";
    }

    function test_refusesFixtureBuiltSpecOnMainnet() public {
        BoxSpecV1.BoxSpec memory s = h.fixtureSpec();
        vm.expectRevert(abi.encodeWithSelector(DeployCoreV1.TestCommitmentRefused.selector, s.revealRoot));
        h.check(s, 1);
    }

    function test_acceptsSyntheticSpecAndKeepsSepoliaFixtures() public view {
        h.check(synthetic(), 1);
        h.check(h.fixtureSpec(), 11_155_111);
    }

    function test_refusesEveryKnownTestRootAndZeroIndependently() public {
        bytes32[5] memory roots = [h.fixtureSpec().revealRoot, bytes32(0),
            root("test/vectors/box/sepolia-box0-test-set.json"),
            root("test/vectors/misfits-commitment.json"), root("test/vectors/sepolia-test-set.json")];
        for (uint256 i; i < roots.length; ++i) {
            BoxSpecV1.BoxSpec memory s = synthetic();
            s.revealRoot = roots[i];
            vm.expectRevert(abi.encodeWithSelector(DeployCoreV1.TestCommitmentRefused.selector, s.revealRoot));
            h.check(s, 1);
        }
    }

    function test_refusesEveryTestGeneratorIndependently() public {
        bytes32[3] memory hashes = [h.fixtureSpec().generatorHash,
            keccak256("sepolia-core-v1.box0-test-set/1: no generator (test data)"),
            keccak256("sepolia-full.test-set/1: no generator (test data)")];
        for (uint256 i; i < hashes.length; ++i) {
            BoxSpecV1.BoxSpec memory s = synthetic();
            s.generatorHash = hashes[i];
            vm.expectRevert(abi.encodeWithSelector(bytes4(keccak256("TestGeneratorRefused(bytes32)")), hashes[i]));
            h.check(s, 1);
        }
    }

    function test_refusesZeroSafe() public {
        BoxSpecV1.BoxSpec memory s = synthetic();
        s.marketplaceOwner = address(0);
        vm.expectRevert(bytes4(keccak256("ZeroPlatformSafe()")));
        h.check(s, 1);
    }

    // Exporter fix1 c81400c8, box0-export/placeholders.ts and box0-commitment-export.json.
    function test_refusesBothExporterTestRootsIndependently() public {
        bytes32[2] memory roots = [
            bytes32(0xdfc000d2ce029fc889fb15f05384153d543afc63a3a60a22e302ee11bcb0979f),
            bytes32(0xfdbae7713f2c54f1f75970cddee81cf4fb1ef9d17c69255b85b90fe34e6c26fc)
        ];
        for (uint256 i; i < roots.length; ++i) {
            BoxSpecV1.BoxSpec memory s = synthetic();
            s.revealRoot = roots[i];
            vm.expectRevert(abi.encodeWithSelector(DeployCoreV1.TestCommitmentRefused.selector, s.revealRoot));
            h.check(s, 1);
        }
    }

    function test_refusesExporterFixtureGeneratorIndependently() public {
        BoxSpecV1.BoxSpec memory s = synthetic();
        s.generatorHash = bytes32(bytes20(hex"31349e9b3d9338f711f34c6a3acebc4b758707c5"));
        vm.expectRevert(abi.encodeWithSelector(DeployCoreV1.TestGeneratorRefused.selector, s.generatorHash));
        h.check(s, 1);
    }

    function test_generatorZeroRemainsAnExplicitFounderChoice() public view {
        BoxSpecV1.BoxSpec memory s = synthetic();
        s.generatorHash = bytes32(0);
        h.check(s, 1);
    }

    function test_refusesEveryTestTableEvenWithAnotherDescription() public {
        bytes[4] memory tables = [h.fixtureSpec().metadataTable,
            table("test/vectors/box/sepolia-box0-test-set.json"),
            table("test/vectors/misfits-commitment.json"), table("test/vectors/sepolia-test-set.json")];
        for (uint256 i; i < tables.length; ++i) {
            BoxSpecV1.BoxSpec memory s = synthetic();
            s.metadataTable = tables[i];
            vm.expectRevert(bytes4(keccak256("TestMetadataTableRefused()")));
            h.check(s, 1);
            uint256 start = 3 + (uint256(uint8(tables[i][1])) << 8) + uint8(tables[i][2]);
            bytes memory tail = new bytes(tables[i].length - start);
            for (uint256 j; j < tail.length; ++j) tail[j] = tables[i][start + j];
            s.metadataTable = bytes.concat(hex"010005", bytes("Fresh"), tail);
            vm.expectRevert(bytes4(keccak256("TestMetadataTableRefused()")));
            h.check(s, 1);
        }
    }

    function root(string memory path) internal view returns (bytes32) {
        return vm.parseJsonBytes32(vm.readFile(path), ".root");
    }

    function table(string memory path) internal view returns (bytes memory) {
        return vm.parseJsonBytes(vm.readFile(path), ".metadataTable");
    }
}
