// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {M260Measure} from "./Measure.sol";
import {GasBudget} from "../GasBudget.sol";
import {BoxSpec, AddOn} from "../../../../src/box-v2/interfaces/SpecTypes.sol";
import {IBoxFactoryV2} from "../../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";
import {HostileCollection} from "../../kit/m2/ShopDoubles.sol";
import {ShopConfigV2} from "../../../../src/box-v2/interfaces/IShopVaultV2.sol";

contract M260CreationTest is M260Measure {
    function test_plainOpenArtStillUnder10M() public { _creation("plain open art", _collectionSpec(), 10000000); }
    function test_tokenWithHolders() public { _creation("holder token creation", _holders(), 49500000); }
    function test_hiddenArtWithHoldersAndAddons() public {
        BoxSpec memory s = _hiddenSpec(); s.buyers = _holders().buyers; s.sellers = _holders().sellers;
        _creation("hidden art holders creation", s, 49500000);
    }
    function test_shopWithHoldersSeedAndLargestCommitment() public {
        BoxSpec memory s = _shop(address(new HostileCollection()), keccak256("10000 item commitment"), 10000, 1000 ether);
        _creation("shop holders starter creation", s, 49500000);
    }
    function test_maximumShopCollectionList() public {
        BoxSpec memory s = _shop(address(new HostileCollection()), keccak256("10000 item commitment"), 10000, 1000 ether);
        ShopConfigV2 memory cfg = abi.decode(s.contentsParams, (ShopConfigV2));
        cfg.collections = new address[](64); cfg.tiers = new uint8[](64);
        for (uint256 i; i < 64; ++i) cfg.collections[i] = address(new HostileCollection());
        s.contentsParams = abi.encode(cfg); s.creatorBuy = s.raise - 1;
        _creation("maximum 64 collection shop creation", s, 49500000);
    }
    function test_maximumCollectionMetadataWithHolders() public {
        BoxSpec memory s = _hiddenSpec(); s.buyers = _holders().buyers; s.sellers = _holders().sellers;
        s.n = 10000; s.tokenName = "12345678901234567890123456789012"; s.tokenSymbol = "12345678901";
        s.collectionName = s.tokenName; s.collectionSymbol = s.tokenSymbol;
        bytes memory description = new bytes(1024);
        for (uint256 i; i < description.length; ++i) description[i] = "x";
        s.description = string(description);
        s.metadataTable = new bytes(24575); s.metadataTable[0] = 0x01;
        s.metadataTable[1] = 0x5f; s.metadataTable[2] = 0xfb;
        for (uint256 i = 3; i < 24574; ++i) s.metadataTable[i] = "x";
        bytes memory svg = new bytes(4096);
        for (uint256 i; i < svg.length; ++i) svg[i] = "x";
        bytes memory link = new bytes(128);
        for (uint256 i; i < link.length; ++i) link[i] = "a";
        bytes memory prefix = bytes("https://");
        for (uint256 i; i < prefix.length; ++i) link[i] = prefix[i];
        bytes32[] memory teasers = new bytes32[](4);
        for (uint256 i; i < 4; ++i) teasers[i] = bytes32(i + 1);
        s.addOns = new AddOn[](8);
        s.addOns[0] = AddOn(1, abi.encode(s.tokenName, s.tokenSymbol, s.description, s.description, string(svg)));
        for (uint256 i = 1; i < 6; ++i) s.addOns[i] = AddOn(3, abi.encode(s.tokenName, uint16(1)));
        s.addOns[6] = AddOn(4, abi.encode(uint16(500), uint8(1)));
        s.addOns[7] = AddOn(6, abi.encode(bytes32(uint256(1)), teasers, string(link)));
        s.creatorBuy = s.raise - 1;
        _creation("maximum metadata holders creation", s, 49500000);
    }
    function test_erc20HolderCreation6Decimals() public { _pricedCreation(6); }
    function test_erc20HolderCreation8Decimals() public { _pricedCreation(8); }
    function test_erc20HolderCreation18Decimals() public { _pricedCreation(18); }
    function _pricedCreation(uint8 decimals) private {
        (BoxSpec memory s,) = _priceSpec(3, 3, decimals);
        s.buyers = _holders().buyers; s.sellers = _holders().sellers; s.creatorBuy = s.raise / 100;
        _creation("ERC20 holders creation", s, 49500000);
    }
    function _creation(string memory label, BoxSpec memory s, uint256 ceiling) private {
        (bytes32 cs, bytes32 hs) = _salts(s);
        uint256 value = s.pricing.token == address(0)
            ? factory.boxQParameters(0, s.raise).bootstrapQ + s.creatorBuy : 0;
        bytes memory data = abi.encodeCall(IBoxFactoryV2.createBox, (s, cs, hs));
        _coldRelease(); _cold();
        vm.prank(CREATOR); uint256 beforeGas = gasleft();
        (bool ok, bytes memory result) = address(factory).call{value: value, gas: ceiling}(data);
        uint256 used = GasBudget.transaction(beforeGas - gasleft(), data);
        if (!ok) assembly ("memory-safe") { revert(add(result, 32), mload(result)) }
        emit log_named_uint(label, used); assertLt(used, ceiling);
        assertEq(registry.boxCount(), 1);
    }
}
