// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {ReceiverDeploy} from "../../fee-modules/ReceiverDeploy.sol";

import {CQ11ARealFixture} from "../../cq11-a/RealFixture.sol";
import {CQAAsset, CQATrader} from "../../cq11-a/Fixture.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";

/// @notice Reuse real-part creation, selecting default-profile artifacts explicitly.
abstract contract CustodyFixture is CQ11ARealFixture {
    function setUp() public virtual override {
        vm.warp(1_000_000);
        vm.roll(100);
        pm = IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(address(this))));
        vm.etch(address(0x1000), address(new CQAAsset()).code);
        p = CQAAsset(address(0x1000));
        trader = new CQATrader(pm);
        ci = deployCode("out/BoxCoordinatorV2.sol/BoxCoordinatorV2.json", abi.encode(pm, address(this)));
        ti = deployCode("out/BoxTokenV2.sol/BoxTokenV2.json", abi.encode(ci));
        ri = deployCode(
            "BoxReceiverV2.sol:BoxReceiverV2", ReceiverDeploy.args(pm, ci, address(0xF17), address(0xB17))
        );
        li = deployCode("out/BoxLaunchRouterV2.sol/BoxLaunchRouterV2.json", abi.encode(pm, ci));
        address ext = deployCode("out/BoxHookV2Extension.sol/BoxHookV2Extension.json", abi.encode(pm));
        hi = deployCode("out/BoxHookV2.sol/BoxHookV2.json", abi.encode(pm, ci, ext));
        _make(RAISE);
    }
}
