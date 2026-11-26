// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {CQ11ARealFixture} from "../cq11-a/RealFixture.sol";
import {CQAAsset} from "../cq11-a/Fixture.sol";
import {BoxCoordinatorV2} from "../../../src/box-v2/BoxCoordinatorV2.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";
import {CoordinatorV2Config, BoxCoordinatorV2Args} from "../../../src/box-v2/libraries/BoxCoordinatorV2Args.sol";

contract M130aPrice is CQAAsset {
    address public blocked;
    bool public paused;
    address public target;
    bytes public data;
    function configure(address b, bool stop) external { blocked = b; paused = stop; }
    function arm(address to, bytes calldata payload) external { target = to; data = payload; }
    function _check(address from, address to) private {
        require(!paused && from != blocked && to != blocked, "price refused");
        if (target != address(0)) {
            (bool ok,) = target.call(data);
            require(ok, "reentry refused");
        }
    }
    function transfer(address to, uint256 amount) public override returns (bool) {
        _check(msg.sender, to); return super.transfer(to, amount);
    }
    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        _check(from, to); return super.transferFrom(from, to, amount);
    }
}

/// Rebuilt against the real CQ11 coordinator, receiver, hook, T and launch router.
abstract contract M130aBase is CQ11ARealFixture {
    receive() external payable {}
    function _window() internal { vm.warp(box.effectiveOpenAt()); vm.roll(block.number + 1); p.approve(address(router), type(uint256).max); }
    function _taxBuy(uint256 amount) internal returns (uint256) { return router.buy(amount, 0, address(this), block.timestamp); }
    function _hostile() internal returns (M130aPrice coin) {
        vm.etch(address(p), address(new M130aPrice()).code); coin = M130aPrice(address(p));
    }
    function _undeployed(bytes24 nonces) internal returns (BoxCoordinatorV2 fresh) {
        CoordinatorV2Config memory c;
        c.p = address(p); c.raise = RAISE; c.creator = address(this); c.deadlineDays = 30; c.nonces = nonces;
        fresh = BoxCoordinatorV2(BoxClones.create(BoxClones.initCode(ci, BoxCoordinatorV2Args.encode(c))));
    }
}
