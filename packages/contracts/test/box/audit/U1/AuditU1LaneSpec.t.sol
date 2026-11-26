// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {AuditU1LaneBase} from "./AuditU1LaneBase.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {BoxCollection} from "../../../../src/box/BoxCollection.sol";
import {BoxTickets} from "../../../../src/box/BoxTickets.sol";
import {BoxHook} from "../../../../src/box/BoxHook.sol";
import {BoxLayoutV1} from "../../../../src/box/BoxLayoutV1.sol";
import {BoxToken} from "../../../../src/box/BoxToken.sol";
import {BoxEncoding} from "../../../../src/box/libraries/BoxEncoding.sol";

/// forge-config: default.evm_version = "osaka"
contract AuditU1LaneSpec is AuditU1LaneBase {
    /// BC-012/063; BoxFactoryV1.sol:61-63. The production mainnet spec is absent at the start commit. This pins
    /// provenance for the shared mainnet-build fixture (script/config with shared N/root/open overrides), and
    /// accepts the real public spec automatically once supplied. No sealed production art is fabricated here.
    function testProperty_AUDIT_U1_unrereadFieldsFollowAvailableScriptSpec() public {
        if (vm.exists("script/config/box0-spec.1.json")) {
            encoded = vm.parseJsonBytes(vm.readFile("script/config/box0-spec.1.json"), ".encoded");
            BoxSpecV1.BoxSpec memory actual = _spec();
            vm.warp(uint256(actual.openAt) - 1 hours);
            kit.prepare(actual);
            a = kit.addresses();
        }
        _create();
        BoxSpecV1.BoxSpec memory s = _spec();
        BoxCollection c = BoxCollection(a.collection);
        assertEq(c.name(), s.collectionName);
        assertEq(c.symbol(), s.collectionSymbol);
        assertEq(c.description(), s.description);
        assertEq(c.generatorHash(), s.generatorHash);
        assertEq(c.collectionCoverSha256(), s.collectionCoverSha256);
        string[5] memory texts;
        uint16 royalty;
        bytes32 banner;
        string memory link;
        for (uint256 j; j < s.addOns.length; ++j) {
            if (s.addOns[j].id == 1) {
                (texts[0], texts[1], texts[2], texts[3], texts[4]) =
                    abi.decode(s.addOns[j].params, (string, string, string, string, string));
            }
            if (s.addOns[j].id == 4) (royalty,) = abi.decode(s.addOns[j].params, (uint16, uint8));
            if (s.addOns[j].id == 6) (banner,, link) = abi.decode(s.addOns[j].params, (bytes32, bytes32[], string));
        }
        assertEq(c.royaltyBps(), royalty);
        assertEq(c.bannerSha256(), banner);
        assertEq(c.externalLink(), link);
        assertEq(c.hiddenDescription(), texts[3]);
        assertEq(c.hiddenSvg(), texts[4]);
        BoxTickets tk = BoxTickets(a.tickets);
        assertEq(tk.name(), texts[0]);
        assertEq(tk.symbol(), texts[1]);
        _curveBytes(s);
        // Exercise tickets' private description decoder through a real live placeholder URI.
        vm.prank(a.coordinator);
        BoxToken(a.token).transfer(address(this), 1e24);
        BoxToken(a.token).approve(a.tickets, type(uint256).max);
        vm.warp(tk.openAt());
        vm.roll(block.number + 1);
        uint256 id = tk.take(1, type(uint256).max, block.timestamp);
        bytes memory json = bytes(
            string.concat(
                '{"name":"',
                texts[0],
                '","description":"',
                texts[2],
                '","image":"data:image/svg+xml;base64,',
                BoxEncoding.base64(bytes(texts[4])),
                '","attributes":[{"trait_type":"Status","value":"Placeholder"}]}'
            )
        );
        assertEq(tk.tokenURI(id), string.concat("data:application/json;base64,", BoxEncoding.base64(json)));
    }

    function _curveBytes(BoxSpecV1.BoxSpec memory s) internal view {
        BoxLayoutV1.Curve memory expected = BoxLayoutV1.curve(s.raise, false);
        (int24 lo, int24 hi, uint128 liquidity) = BoxHook(a.hook).curve();
        assertEq(lo, expected.tickLower);
        assertEq(hi, expected.tickUpper);
        assertEq(liquidity, expected.liquidity);
        assertEq(_arg(a.hook, 40, 20), expected.sqrtPriceLowerX96);
        assertEq(_arg(a.hook, 60, 20), expected.sqrtPriceUpperX96);
        assertEq(_arg(a.hook, 127, 16), s.raise);
        assertEq(_arg(a.launchRouter, 81, 20), expected.sqrtPriceLowerX96);
        assertEq(int24(uint24(_arg(a.itemStream, 140, 3))), expected.tickLower);
        assertEq(int24(uint24(_arg(a.itemStream, 143, 3))), expected.tickUpper);
    }

    function _arg(address account, uint256 offset, uint256 width) internal view returns (uint256 x) {
        assembly ("memory-safe") {
            extcodecopy(account, 0, add(45, offset), width)
            x := shr(sub(256, mul(width, 8)), mload(0))
        }
    }
}
