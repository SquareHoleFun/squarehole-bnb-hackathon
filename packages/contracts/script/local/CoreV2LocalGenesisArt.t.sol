// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {CoreV2LocalGenesis} from "./CoreV2LocalGenesis.s.sol";
import {BoxSpecV1} from "../../src/box/BoxSpecV1.sol";

contract LocalGenesisArtHarness is CoreV2LocalGenesis {
    function spec(address platform) external view returns (BoxSpecV1.BoxSpec memory) {
        return _localGenesisSpec(platform);
    }
}

contract CoreV2LocalGenesisArtTest is Test {
    function test_localMisfitsUsesActualPngLogoCoverAndBannerWithoutChangingEconomics() public {
        address platform = address(0xA11CE);
        BoxSpecV1.BoxSpec memory s = new LocalGenesisArtHarness().spec(platform);
        assertEq(s.coverSha256, 0xab4b06835172a01b1c7214f00af8bb10a52cd55fb0abc714b7d18e4108cacd16);
        assertEq(s.collectionCoverSha256, 0x41cf86fd8bf4bf185534477e35ca01b8183316adc947a92f9c3d8933a90f11fb);
        bool hasBanner;
        for (uint256 i; i < s.addOns.length; ++i) {
            if (s.addOns[i].id != 6) continue;
            (bytes32 banner, bytes32[] memory teasers, string memory link) =
                abi.decode(s.addOns[i].params, (bytes32, bytes32[], string));
            assertEq(banner, 0xa8202b6917194146c6d2c9ddb53529dd9f064089d9019d9989dfb722dd921afe);
            assertEq(teasers.length, 0); assertEq(bytes(link).length, 0); hasBanner = true;
        }
        assertTrue(hasBanner);
        BoxSpecV1.BoxSpec memory expected = abi.decode(vm.parseJsonBytes(
            vm.readFile("test/vectors/box-spec/box-spec-v1.json"), ".columns.encoded[0]"), (BoxSpecV1.BoxSpec));
        expected.marketplaceOwner = platform; expected.openAt = 0;
        // These are the only additional differences allowed in the local genesis recipe.
        expected.coverSha256 = s.coverSha256;
        expected.collectionCoverSha256 = s.collectionCoverSha256;
        assertEq(abi.encode(s), abi.encode(expected));
    }
}
