// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ShopFixture} from "../box-v2/m2-32/ShopFixture.sol";
import {ShopTest} from "../box-v2/m2-32/Shop.t.sol";
import {BoundariesTest} from "../box-v2/m2-32/Boundaries.t.sol";
import {FailureTest} from "../box-v2/m2-32/Failure.t.sol";
import {M244ShopCompatibilityTest} from "../box-v2/m2-44/ShopCompatibility.t.sol";
import {M262ShopGaps} from "../box-v2/m2-62/Gaps.t.sol";
import {ShopAdmissionTest} from "../box-v2/m2-63-fix-shop/Admission.t.sol";
import {CreationShopConfigTest} from "../box-v2/rc6-creation-gas/ShopConfig.t.sol";
import {ShopFloorTest} from "../box-v2/shop-floor/Floor.t.sol";
import {IShopVaultV2, ShopConfigV2} from "../../src/box-v2/interfaces/IShopVaultV2.sol";
import {BnbTestnet} from "../../script/bnb/BnbTestnet.sol";
import {DeployCoreV2BnbShortWait} from "../../script/bnb/DeployCoreV2BnbShortWait.s.sol";

string constant VARIANT = "ShopVaultV2ShortWait.sol:ShopVaultV2ShortWait";

/// @notice SH-300: the ten-minute shop variant. A give opens exactly ten minutes after a collection's listing (never a
/// second earlier); 7, 14 and 30 days still work; every other wait is refused; the release's own shop still refuses
/// ten minutes; the release script refuses every chain but 97.
contract ShopShortWaitTest is ShopFixture {
    uint256 internal start;

    function setUp() public override {
        super.setUp();
        implementation = deployCode(VARIANT, abi.encode(pm, coordinatorImpl));
        config.listDelay = 10 minutes;
        start = block.timestamp;
        _deploy(config);
    }

    function deployConfig(ShopConfigV2 memory cfg) external { _deploy(cfg); }

    function _openNow() private {
        _fund();
        coord.phase(true, false, true);
        vm.prank(address(coord)); shop.openGate();
    }

    function _giveAt(uint256 at, uint256 id, bool opens) private {
        vm.warp(at);
        nfts[0].mint(ALICE, id);
        vm.prank(ALICE);
        if (!opens) vm.expectRevert(IShopVaultV2.InvalidRequest.selector);
        shop.give(address(nfts[0]), id, 0);
    }

    function test_giveOpensTenMinutesAfterListingAndNotASecondEarlier() public {
        _openNow();
        _giveAt(start + 10 minutes - 1, 1, false);
        _giveAt(start + 10 minutes, 2, true);
        assertEq(shop.inside(), 1);
    }

    /// @notice The graduation boundary: ten minutes after creation, a funded, approved give is refused while the box
    /// has not graduated (the shop's gate is shut); after graduation and the gate it pays the tier's price.
    function test_giveAtTenMinutesWaitsForGraduationAndTheGate() public {
        _fund();
        vm.warp(start + 10 minutes);
        nfts[0].mint(ALICE, 21);
        vm.prank(ALICE);
        vm.expectRevert(IShopVaultV2.InvalidRequest.selector);
        shop.give(address(nfts[0]), 21, 0);
        coord.phase(true, false, true);
        vm.prank(address(coord)); shop.openGate();
        uint256 before = token.balanceOf(ALICE);
        vm.prank(ALICE);
        assertEq(shop.give(address(nfts[0]), 21, 0), 10);
        assertEq(token.balanceOf(ALICE), before + 10);
    }

    function test_theThreeLongWaitsStillWork() public {
        uint32[3] memory waits = [uint32(7 days), 14 days, 30 days];
        for (uint256 i; i < 3; ++i) {
            vm.warp(1_000 days * (i + 1));
            config.listDelay = waits[i];
            uint256 listed = block.timestamp;
            _deploy(config);
            _openNow();
            _giveAt(listed + waits[i] - 1, 10 + 2 * i, false);
            _giveAt(listed + waits[i], 11 + 2 * i, true);
        }
    }

    function test_everyOtherWaitIsRefused() public {
        uint32[9] memory others = [uint32(0), 1, 9 minutes, 10 minutes - 1, 10 minutes + 1, 11 minutes, 1 hours, 1 days,
            8 days];
        ShopConfigV2 memory cfg = config;
        for (uint256 i; i < others.length; ++i) {
            cfg.listDelay = others[i];
            vm.expectRevert(IShopVaultV2.InvalidRequest.selector);
            this.deployConfig(cfg);
        }
    }

    /// @notice The release's own shop (src/, unchanged) still refuses ten minutes: only the variant accepts it.
    function test_theReleaseShopStillRefusesTenMinutes() public {
        implementation = deployCode("ShopVaultV2.sol:ShopVaultV2", abi.encode(pm, coordinatorImpl));
        ShopConfigV2 memory cfg = config;
        cfg.listDelay = 10 minutes;
        vm.expectRevert(IShopVaultV2.InvalidRequest.selector);
        this.deployConfig(cfg);
    }

    function test_releaseScriptRefusesEveryChainButBnbTestnet() public {
        DeployCoreV2BnbShortWait release = new DeployCoreV2BnbShortWait();
        uint256[3] memory ids = [uint256(31337), 11_155_111, 56];
        for (uint256 i; i < 3; ++i) {
            vm.chainId(ids[i]);
            vm.expectRevert(abi.encodeWithSelector(BnbTestnet.NotBnbTestnet.selector, ids[i]));
            release.run(address(pm), address(1), address(2), address(3), address(4));
        }
    }
}

// ---- Every existing shop suite on the shop fixture, run again against the variant (with its default 7-day wait):
// the variant behaves as the release's shop wherever the ten-minute wait is not chosen.

contract ShortWaitShopTest is ShopTest {
    function setUp() public override {
        super.setUp(); implementation = deployCode(VARIANT, abi.encode(pm, coordinatorImpl)); _deploy(config);
    }
}

contract ShortWaitBoundariesTest is BoundariesTest {
    function setUp() public override {
        super.setUp(); implementation = deployCode(VARIANT, abi.encode(pm, coordinatorImpl)); _deploy(config);
    }
}

contract ShortWaitFailureTest is FailureTest {
    function setUp() public override {
        super.setUp(); implementation = deployCode(VARIANT, abi.encode(pm, coordinatorImpl)); _deploy(config);
    }
}

contract ShortWaitCompatibilityTest is M244ShopCompatibilityTest {
    function setUp() public override {
        super.setUp(); implementation = deployCode(VARIANT, abi.encode(pm, coordinatorImpl)); _deploy(config);
    }
}

contract ShortWaitGapsTest is M262ShopGaps {
    function setUp() public override {
        super.setUp(); implementation = deployCode(VARIANT, abi.encode(pm, coordinatorImpl)); _deploy(config);
    }
}

contract ShortWaitAdmissionTest is ShopAdmissionTest {
    function setUp() public override {
        super.setUp(); implementation = deployCode(VARIANT, abi.encode(pm, coordinatorImpl)); _deploy(config);
    }
}

contract ShortWaitShopConfigTest is CreationShopConfigTest {
    function setUp() public override {
        super.setUp(); implementation = deployCode(VARIANT, abi.encode(pm, coordinatorImpl)); _deploy(config);
    }
}

contract ShortWaitFloorTest is ShopFloorTest {
    function setUp() public override {
        super.setUp(); implementation = deployCode(VARIANT, abi.encode(pm, coordinatorImpl)); _deploy(config);
    }
}
