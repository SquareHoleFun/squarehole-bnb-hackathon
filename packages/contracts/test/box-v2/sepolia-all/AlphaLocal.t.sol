// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {LocalTwin} from "../../../script/local/LocalTwin.sol";

contract AlphaLocalTest is Test {
    function test_alphaGuardIsExplicitAndTwinRemainsPinned() public {
        LocalTwin.checkAlpha(31337, "anvil/v1.8.3");
        vm.expectRevert(); this.alpha(11155111, "anvil/v1.8.3");
        vm.expectRevert(); this.alpha(1, "anvil/v1.8.3");
        vm.expectRevert(); this.alpha(31337, "geth");
        vm.expectRevert(); this.twin(31337, "anvil/v1.8.3");
        LocalTwin.check(11155111, "anvil/v1.8.3");
    }
    function alpha(uint256 id, string memory client) external pure { LocalTwin.checkAlpha(id, client); }
    function twin(uint256 id, string memory client) external pure { LocalTwin.check(id, client); }
}

import {CoreV2LocalGenesis} from "../../../script/local/CoreV2LocalGenesis.s.sol";
import {DeployCoreV2Local} from "../../../script/local/DeployCoreV2Local.s.sol";
import {AlphaRehearsalSetup} from "../../../script/local/AlphaRehearsalSetup.s.sol";
import {BoxFactoryV2} from "../../../src/box-v2/BoxFactoryV2.sol";
import {TestETH} from "../../../src/test-coins/TestETH.sol";
import {IListingRegistry} from "../../../src/box-v2/interfaces/IListingRegistry.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {BoxCoordinatorV2} from "../../../src/box-v2/BoxCoordinatorV2.sol";

contract AlphaGenesisHarness is CoreV2LocalGenesis {
    function boot(address owner) external returns (AlphaDependencies memory) { return _bootstrapAlpha(owner); }
}
contract AlphaReleaseHarness is DeployCoreV2Local {
    function deploy(address owner, CoreV2LocalGenesis.AlphaDependencies memory d) external returns (address) {
        return _deployAlpha(owner, d.manager, d.weth, d.drand, d.fit, d.platform);
    }
}
contract AlphaSetupHarness is AlphaRehearsalSetup {
    function assets(address manager, address owner) external returns (Assets memory) { return _assets(manager, owner); }
    function listing(address factory, address teth, address owner) external returns (uint32) { return _listing(factory, teth, owner); }
    function pools(Assets memory a, address owner) external { _pools(a, owner); }
    function admission(address teth, address owner, address admitter, address tester) external {
        _admission(teth, owner, admitter, tester);
    }
    function box(address factory, uint32 listingId, uint32 openAt, address actor) external returns (address) {
        return _box(factory, listingId, openAt, actor);
    }
}

contract AlphaBootstrapTest is Test {
    function test_realAlphaDeploymentAndCreation() public {
        vm.chainId(31337); vm.warp(1_790_000_000); vm.roll(16);
        address owner = address(0xA11FA); address actor = address(0xA11CE);
        vm.deal(owner, 100 ether); vm.deal(actor, 100 ether);
        CoreV2LocalGenesis.AlphaDependencies memory d = new AlphaGenesisHarness().boot(owner);
        assertEq(address(PoolSwapTest(d.poolSwapTest).manager()), d.manager);
        assertTrue(d.poolSwapTest != d.swapper);
        address factory = new AlphaReleaseHarness().deploy(owner, d);
        AlphaSetupHarness setup = new AlphaSetupHarness();
        AlphaRehearsalSetup.Assets memory a = setup.assets(d.manager, owner);
        address server = address(0xAD);
        setup.admission(a.teth, owner, server, actor);
        assertEq(TestETH(a.teth).admitter(), server);
        assertEq(TestETH(a.teth).admitterPerDay(), 1);
        assertTrue(TestETH(a.teth).admitted(actor));
        vm.prank(server); vm.expectRevert(TestETH.AdmitterDailyCapReached.selector);
        TestETH(a.teth).admitOne(address(0xB0B));
        address[] memory admitted = new address[](1); admitted[0] = address(0xB0B);
        vm.prank(owner); TestETH(a.teth).admit(admitted);
        vm.prank(actor); TestETH(a.teth).drip();
        vm.prank(address(0xBAD)); vm.expectRevert(TestETH.NotAdmitted.selector); TestETH(a.teth).drip();
        uint32 id = setup.listing(factory, a.teth, owner);
        assertEq(IListingRegistry(BoxFactoryV2(factory).listingRegistry()).listing(id).raise, 1 ether);
        assertEq(IListingRegistry(BoxFactoryV2(factory).listingRegistry()).listing(0).raise, 0.1 ether);
        setup.pools(a, owner);
        vm.warp(block.timestamp + 1 days);
        address tbox = setup.box(factory, id, uint32(block.timestamp + 60), actor);
        address ebox = setup.box(factory, 0, uint32(block.timestamp + 60), actor);
        assertEq(BoxCoordinatorV2(tbox).q(), a.teth);
        assertEq(BoxCoordinatorV2(ebox).q(), address(0));
    }
}
