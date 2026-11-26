// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {ShopFixture, ShopNFT} from "./ShopFixture.sol";
import {IShopVaultV2, ShopConfigV2} from "../../../src/box-v2/interfaces/IShopVaultV2.sol";
import {IBoxToken} from "../../../src/box/interfaces/IBoxToken.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";
import {ShopVaultV2} from "../../../src/box-v2/ShopVaultV2.sol";

contract BoundariesTest is ShopFixture {
    event Given(address indexed collection, uint256 indexed id, address indexed giver, uint256 amountT);
    event Picked(address indexed collection, uint256 indexed id, address indexed to, uint256 amountT);
    function deployConfig(ShopConfigV2 memory cfg) external { _deploy(cfg); }
    function test_invalidPresetsAndCollectionsRevertInitializationAtomically() public {
        ShopConfigV2 memory cfg = config;
        cfg.pickBps = 15001; vm.expectRevert(); this.deployConfig(cfg); cfg.pickBps = 12500;
        cfg.weeklyBps = 1001; vm.expectRevert(); this.deployConfig(cfg); cfg.weeklyBps = 1000;
        cfg.collectionBps = 251; vm.expectRevert(); this.deployConfig(cfg); cfg.collectionBps = 250;
        cfg.listDelay = 8 days; vm.expectRevert(); this.deployConfig(cfg); cfg.listDelay = 7 days;
        cfg.givePricesT[0] = 0; vm.expectRevert(); this.deployConfig(cfg); cfg.givePricesT[0] = 10;
        cfg.givePricesT[1] = 10; vm.expectRevert(); this.deployConfig(cfg); cfg.givePricesT[1] = 20;
        cfg.givePricesT[3] = type(uint256).max; vm.expectRevert(); this.deployConfig(cfg); cfg.givePricesT[3] = 100;
        cfg.tiers[0] = 4; vm.expectRevert(); this.deployConfig(cfg); cfg.tiers[0] = 0;
        cfg.collections[0] = cfg.collections[1]; vm.expectRevert(); this.deployConfig(cfg);
        cfg.collections[0] = address(0); vm.expectRevert(); this.deployConfig(cfg);
        cfg.collections[0] = address(token); vm.expectRevert(); this.deployConfig(cfg);
        cfg.collections = new address[](65); cfg.tiers = new uint8[](65);
        vm.expectRevert(); this.deployConfig(cfg);
        cfg.collections = new address[](1); vm.expectRevert(); this.deployConfig(cfg);
        assertEq(shop.budgetT(), 0); assertEq(shop.inside(), 0);
    }
    function test_allPresetCombinationsAndEveryTierUseIntegerCeiling() public {
        uint16[4] memory picks = [uint16(12500), 15000, 20000, 30000];
        uint16[3] memory caps = [uint16(100), 250, 500];
        uint32[3] memory delays = [uint32(7 days), 14 days, 30 days];
        config.givePricesT = [uint256(1), 3, 7, 11];
        for (uint256 i; i < 4; ++i) config.tiers[i] = uint8(i);
        for (uint256 p; p < 4; ++p) for (uint256 w; w < 2; ++w) for (uint256 c; c < 3; ++c) {
            config.pickBps = picks[p]; config.weeklyBps = w == 0 ? 500 : 1000;
            config.collectionBps = caps[c]; config.listDelay = delays[c]; _deploy(config); _fund(); _open();
            for (uint256 tier; tier < 4; ++tier) {
                (uint256 giveT, uint256 pickT, uint256 at) = shop.collectionTerms(address(nfts[tier]));
                assertEq(giveT, config.givePricesT[tier]); assertEq(pickT, (giveT * picks[p] + 9999) / 10000);
                assertEq(at, block.timestamp); _give(tier, p * 100 + w * 30 + c * 4 + tier);
            }
        }
    }
    function testFuzz_weeklyAllowanceFloorsAndIndependentCollections(uint256 seed, uint8 preset) public {
        seed = bound(seed, 2, 1e18); preset = uint8(bound(preset, 0, 2));
        config.seedT = seed; config.collectionBps = [uint16(100), 250, 500][preset];
        uint256 allowanceT = seed * config.collectionBps / 10000;
        uint256 price = allowanceT == 0 ? 1 : allowanceT;
        config.givePricesT = [price, price + 1, price + 2, price + 3];
        _deploy(config); _fund(); _open();
        nfts[0].mint(ALICE, 1);
        vm.prank(ALICE); shop.give(address(nfts[0]), 1, price);
        nfts[0].mint(ALICE, 2); vm.prank(ALICE); vm.expectRevert(); shop.give(address(nfts[0]), 2, 0);
        if (seed * config.weeklyBps / 10000 < price * 2) vm.warp(vm.getBlockTimestamp() + 7 days);
        _give(1, 1); assertEq(shop.budgetT(), seed - price * 2);
        assertEq(token.balanceOf(address(shop)), shop.budgetT());
        vm.warp(block.timestamp + 70 days); // no accumulated weekly allowance
        // F132: the next week can spend one price even below the percentage allowance.
        if (seed - price * 2 < price) {
            vm.prank(ALICE); vm.expectRevert(); shop.give(address(nfts[0]), 2, 0);
            assertEq(shop.inside(), 2);
        } else {
            vm.prank(ALICE); shop.give(address(nfts[0]), 2, 0);
            nfts[0].mint(ALICE, 3); vm.prank(ALICE); vm.expectRevert(); shop.give(address(nfts[0]), 3, 0);
            assertEq(shop.inside(), 3);
        }
    }
    function testFuzz_roundTripsConserveTAndRetainSpread(uint8 preset, uint8 loops) public {
        preset = uint8(bound(preset, 0, 3)); loops = uint8(bound(loops, 1, 20));
        config.pickBps = [uint16(12500), 15000, 20000, 30000][preset]; _deploy(config);
        _fund(); _load(1); _load(2); _open(); uint256 original = token.balanceOf(ALICE);
        uint256 price = (uint256(10) * config.pickBps + 9999) / 10000;
        for (uint256 i; i < loops; ++i) {
            vm.prank(ALICE); shop.pick(address(nfts[0]), 2, price, ALICE);
            vm.prank(ALICE); shop.give(address(nfts[0]), 2, 10);
            assertEq(token.balanceOf(ALICE) + shop.budgetT(), original + 10000);
            assertEq(shop.budgetT(), 10000 + (i + 1) * (price - 10));
            assertEq(shop.inside(), 2); assertEq(shop.collectionSize(), 2);
        }
    }
    function test_refusedTokenAndNFTRecipientRollBackThenRetry() public {
        vm.prank(CREATOR); token.approve(address(shop), 9999); vm.expectRevert(); shop.fundSeed();
        assertFalse(shop.seedReady()); assertEq(shop.budgetT(), 0);
        vm.prank(CREATOR); token.approve(address(shop), 10000); _fund(); _load(1); _load(2); _open();
        vm.mockCall(address(token), abi.encodeWithSelector(IBoxToken.transferFrom.selector), abi.encode(true));
        vm.prank(ALICE); vm.expectRevert(); shop.pick(address(nfts[0]), 2, 13, ALICE);
        vm.clearMockedCalls();
        vm.prank(ALICE); vm.expectRevert(); shop.pick(address(nfts[0]), 2, 13, address(token));
        assertEq(shop.budgetT(), 10000); assertEq(shop.inside(), 2);
        vm.expectEmit(true, true, true, true, address(shop)); emit Picked(address(nfts[0]), 2, ALICE, 13);
        vm.prank(ALICE); shop.pick(address(nfts[0]), 2, 13, ALICE);
        vm.mockCall(address(token), abi.encodeWithSelector(IBoxToken.transfer.selector), abi.encode(false));
        vm.prank(ALICE); vm.expectRevert(); shop.give(address(nfts[0]), 2, 0);
        assertEq(nfts[0].ownerOf(2), ALICE); assertEq(shop.budgetT(), 10013);
        vm.clearMockedCalls(); vm.expectEmit(true, true, true, true, address(shop));
        emit Given(address(nfts[0]), 2, ALICE, 10); vm.prank(ALICE); shop.give(address(nfts[0]), 2, 10);
        assertEq(shop.budgetT(), 10003);
    }
    function test_noFeeGiftOrUnauthorizedHelperAndImplementationInert() public {
        _fund();
        (bool ok,) = address(shop).call(abi.encodeWithSignature("fundRoyalty(address,uint256)", address(token), 1));
        assertFalse(ok); vm.deal(address(this), 1); (ok,) = address(shop).call{value: 1}(""); assertFalse(ok);
        vm.expectRevert(); ShopVaultV2(address(shop)).burnLiquid();
        vm.expectRevert(); ShopVaultV2(address(shop)).burnClaims();
        vm.expectRevert(); ShopVaultV2(address(shop)).returnOne(0);
        vm.expectRevert(); ShopVaultV2(address(shop)).unlockCallback("");
        vm.prank(address(pm)); vm.expectRevert(); ShopVaultV2(address(shop)).unlockCallback("");
        vm.expectRevert(); IShopVaultV2(implementation).fundSeed();
        vm.expectRevert(); IShopVaultV2(implementation).initialize();
        assertEq(shop.budgetT(), 10000);
    }
    function test_curatorCannotChangePricesAndAddedEntryWaitsFullDelay() public {
        _fund(); _open(); ShopNFT extra = new ShopNFT();
        vm.prank(ALICE); vm.expectRevert(); shop.addCollection(address(extra), 0);
        vm.prank(CURATOR); shop.addCollection(address(extra), 3);
        (, , uint256 activeAt) = shop.collectionTerms(address(extra));
        extra.mint(ALICE, 1); vm.prank(ALICE); extra.setApprovalForAll(address(shop), true);
        vm.warp(activeAt - 1); vm.prank(ALICE); vm.expectRevert(); shop.give(address(extra), 1, 0);
        vm.warp(activeAt); vm.prank(ALICE); shop.give(address(extra), 1, 100);
        vm.prank(CURATOR); vm.expectRevert(); shop.addCollection(address(extra), 0);
        (uint256 giveT, uint256 pickT,) = shop.collectionTerms(address(extra)); assertEq(giveT, 100); assertEq(pickT, 125);
    }
    function test_returnGasActivationSweepPreservesFailedCustody() public {
        _fund(); _load(1); _fail(); nfts[0].hostile(3, address(0), "");
        uint256[] memory ids = new uint256[](1);
        // Sweep across the NFT_RETURN_GAS + EIP-150 + reserve activation boundary on each EVM.
        for (uint256 gasLimit = 200000; gasLimit <= 1400000; gasLimit += 10000) {
            (bool ok, bytes memory ret) = address(shop).call{gas: gasLimit}(abi.encodeCall(shop.returnStarter, (ids)));
            assertTrue(ok, "optional NFT sink blocked recovery"); assertEq(abi.decode(ret, (uint256)), 0);
            assertEq(shop.inside(), 1); assertEq(shop.failedT(), 10000);
        }
        nfts[0].hostile(0, address(0), ""); assertEq(shop.returnStarter(ids), 1);
    }
}
