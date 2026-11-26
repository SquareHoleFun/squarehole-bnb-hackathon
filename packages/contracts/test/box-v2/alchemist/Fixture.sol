// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {M363Base} from "../m3-63-fix-create/Fixture.sol";
import {HostileToken} from "../kit/HostileToken.sol";
import {BoxSpec} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {Branch} from "../../../src/box-v2/interfaces/RecipeTypes.sol";
import {ListingClass} from "../../../src/box-v2/interfaces/IListingRegistry.sol";
import {IFeeModulesV21} from "../../../src/box-v2/interfaces/IFeeModulesV21.sol";
import {FeeModuleDirectoryV21} from "../../../src/box-v2/FeeModuleDirectoryV21.sol";
import {AlchemistHop, AlchemistView} from "./Admission.t.sol";
import {AlchemistV2Pool, AlchemistV3Pool} from "./Pools.sol";

/// Shared Alchemist world: production release, real inbox and local v3 -> v2 arithmetic pools.
abstract contract AlchemistFixture is M363Base {
    address internal constant MODULE_DEPLOYER = address(0xD14);
    /// G1-INT: the fixture's dust size, far above this route's raw rounding (16 units convert) and far below its clips.
    uint256 internal constant DUST = 1e6;
    // This harness is the platform keeper; the action is deployed by a separate account.
    address internal keeper = address(this);
    HostileToken internal p;
    HostileToken internal w;
    HostileToken internal gold;
    AlchemistV2Pool internal v2;
    AlchemistV3Pool internal v3;
    address internal module;
    IFeeModulesV21 internal fees;

    function _alchemistSpec(uint256 inputCap, bool buyersModule, bool sellersModule)
        internal
        returns (BoxSpec memory s)
    {
        (s, p) = _priceSpec(buyersModule ? 1 : 2, 2, 18);
        w = new HostileToken("Wrapped ether", "WETH", 18);
        gold = new HostileToken("Gold", "PAXG", 18);
        gold.mint(address(this), 10000);
        gold.approve(address(listings), 10000);
        listings.add(address(gold), ListingClass.OTHER, 1 ether);
        v3 = new AlchemistV3Pool(address(p), address(w));
        v2 = new AlchemistV2Pool(address(w), address(gold));
        p.mint(address(v3), 1e24);
        w.mint(address(v3), 1e24);
        w.mint(address(v2), 1e24);
        gold.mint(address(v2), 1e24);
        v2.sync();
        AlchemistHop[] memory route = new AlchemistHop[](2);
        route[0] = AlchemistHop(3, address(p), address(w), address(v3), 3000, 60);
        route[1] = AlchemistHop(2, address(w), address(gold), address(v2), 3000, 0);
        vm.startPrank(MODULE_DEPLOYER);
        uint256 dust = inputCap < DUST ? inputCap : DUST;
        module = deployCode(
            "AlchemistFeeModuleV21.sol:AlchemistFeeModuleV21",
            abi.encode(pm, release.implementations[5], release.implementations[0], route, inputCap, dust, keeper)
        );
        vm.stopPrank();
        (,, address directory) = IFeeModulesV21(release.implementations[5]).receiverCode();
        uint32 id = FeeModuleDirectoryV21(directory).register(module);
        (,, uint64 readyAt,) = FeeModuleDirectoryV21(directory).record(id);
        vm.warp(readyAt);
        s.boxType = 5;
        s.contentsParams = abi.encode(address(gold), uint256(0), uint16(500));
        if (buyersModule) s.buyers.a = Branch(1, 9, "", abi.encode(id));
        if (sellersModule) s.sellers.a = Branch(1, 9, "", abi.encode(id));
        s.creatorFeeRecipient = address(0);
    }

    function _noResidue() internal view {
        address executor = AlchemistView(module).executor();
        assertEq(p.balanceOf(module), 0);
        assertEq(p.balanceOf(executor), 0);
        assertEq(w.balanceOf(executor), 0);
        assertEq(gold.balanceOf(executor), 0);
        assertEq(pm.balanceOf(module, uint160(address(p))), 0);
        assertEq(pm.balanceOf(executor, uint160(address(p))), 0);
    }
}
