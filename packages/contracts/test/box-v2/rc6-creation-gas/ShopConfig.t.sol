// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ShopFixture} from "../m2-32/ShopFixture.sol";
import {ShopConfigV2, IShopVaultV2} from "../../../src/box-v2/interfaces/IShopVaultV2.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";

/// RC6-CREATION-GAS: removing creation-time copies must preserve full-width immutable terms and custody.
contract CreationShopConfigTest is ShopFixture {
    function test_fullWidthTermsAndSeedCeilingSurviveFailure() public {
        ShopConfigV2 memory cfg = config;
        uint256 price = uint256(1) << 200;
        cfg.givePricesT = [price + 1, price + 2, price + 3, price + 4];
        cfg.seedT = type(uint256).max;
        for (uint256 i; i < cfg.tiers.length; ++i) cfg.tiers[i] = uint8(i % 4);
        bytes memory encoded = abi.encode(cfg);
        // abi.decode also accepts a displaced tuple head. Preserve that meaning for direct clones,
        // even though the production spec validator requires the canonical encoding.
        bytes memory displaced = new bytes(encoded.length + 32);
        assembly ("memory-safe") {
            mstore(add(displaced, 32), 64)
            mcopy(add(displaced, 96), add(encoded, 64), sub(mload(encoded), 32))
        }
        IShopVaultV2 candidate = IShopVaultV2(BoxClones.create(BoxClones.initCode(implementation,
            abi.encodePacked(address(coord), address(token), LOADER, displaced, bytes1(uint8(8))))));
        coord.wire(CREATOR, address(token), address(candidate), LOADER, address(pm));
        assertEq(candidate.ceilingT(), 0, "uninitialized seed is not exposed");
        vm.prank(address(coord)); candidate.initialize();
        assertEq(candidate.ceilingT(), type(uint256).max, "seed ceiling saturates without narrowing");
        _terms(candidate, cfg);
        coord.phase(false, true, false);
        vm.prank(address(coord)); candidate.enterFailure();
        _terms(candidate, cfg);
        assertEq(candidate.ceilingT(), type(uint256).max);
        assertEq(candidate.budgetT(), 0);
    }

    function testFuzz_seedAndEachTierKeepExactMoneyPaths(uint64 rawPrice) public {
        ShopConfigV2 memory cfg = config;
        uint256 price = bound(uint256(rawPrice), 1, 1e12);
        cfg.givePricesT = [price, price * 2 + 1, price * 3 + 2, price * 4 + 3];
        cfg.seedT = price * 10_000 + 100_000;
        for (uint256 i; i < cfg.tiers.length; ++i) cfg.tiers[i] = uint8(i % 4);
        _deploy(cfg);
        _terms(shop, cfg);
        uint256 beforeCreator = token.balanceOf(CREATOR);
        _fund();
        assertEq(beforeCreator - token.balanceOf(CREATOR), cfg.seedT);
        assertEq(shop.budgetT(), cfg.seedT);
        uint256 funded = vm.snapshotState();
        _open();
        uint256 beforeAlice = token.balanceOf(ALICE);
        uint256 paid;
        for (uint256 i; i < 4; ++i) {
            _give(i, 1);
            paid += cfg.givePricesT[i];
        }
        assertEq(token.balanceOf(ALICE) - beforeAlice, paid);
        assertEq(shop.budgetT(), cfg.seedT - paid);
        vm.prank(ALICE); shop.pick(address(nfts[3]), 1, type(uint256).max, ALICE);
        uint256 pick = (cfg.givePricesT[3] * cfg.pickBps + 9999) / 10000;
        assertEq(shop.budgetT(), cfg.seedT - paid + pick);
        assertEq(token.balanceOf(ALICE), beforeAlice + paid - pick);
        // Failure is possible only before graduation; branch from the funded, unopened shop.
        assertTrue(vm.revertToState(funded));
        _fail();
        assertEq(shop.budgetT(), 0);
        assertEq(shop.failedT(), cfg.seedT);
        _terms(shop, cfg);
    }

    function _terms(IShopVaultV2 candidate, ShopConfigV2 memory cfg) private view {
        for (uint256 i; i < 4; ++i) {
            (uint256 give, uint256 pick, uint256 activeAt) = candidate.collectionTerms(address(nfts[i]));
            uint256 price = cfg.givePricesT[i];
            assertEq(give, price);
            assertEq(pick, (price * cfg.pickBps + 9999) / 10000);
            assertGt(activeAt, 0);
        }
    }
}
