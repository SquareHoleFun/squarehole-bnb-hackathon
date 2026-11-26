// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";
import {BoxTokenV2} from "../../../src/box-v2/BoxTokenV2.sol";
import {BoxTokenV2Args} from "../../../src/box-v2/interfaces/IBoxTokenV2.sol";
import {IBoxCoordinator} from "../../../src/box/interfaces/IBoxCoordinator.sol";
import {IBoxCoordinatorV2, FailCause} from "../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";
import {CoordinatorV2Config, BoxCoordinatorV2Args} from "../../../src/box-v2/libraries/BoxCoordinatorV2Args.sol";
import {BoxRolesV2} from "../../../src/box-v2/interfaces/IBoxRegistryV2.sol";
import {PricingToken} from "../../../src/box-v2/libraries/PricingToken.sol";
import {HostileToken} from "../kit/HostileToken.sol";
import {CoordinatorHarness, FailureHook, FailureReceiver, FailureRouter, FailureVault} from "./FailureShells.sol";

abstract contract FailureTestBase is Test {
    IPoolManager internal pm;
    CoordinatorHarness internal box;
    CoordinatorHarness internal implementation;
    BoxTokenV2 internal t;
    FailureHook internal hook;
    FailureReceiver internal receiver;
    FailureRouter internal router;
    FailureVault internal vault;
    HostileToken internal priceToken;
    address internal p;
    address internal constant CREATOR = address(0xC0FFEE);
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    uint256 internal constant SUPPLY = 1e36;
    bytes internal foreignCall;
    bytes internal foreignResult;
    bool internal foreignOk;

    receive() external payable {}

    function setUp() public virtual {
        vm.warp(1_000_000);
        pm = IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(address(this))));
        priceToken = new HostileToken("Price", "P", 6);
        _box(address(priceToken), true, true);
    }

    function _box(address p_, bool withVault, bool gate) internal {
        p = p_;
        implementation = new CoordinatorHarness(pm);
        bytes memory nonces = new bytes(24);
        nonces[BoxRolesV2.ROLE_TOKEN] = bytes1(uint8(1));
        nonces[BoxRolesV2.ROLE_RECEIVER] = bytes1(uint8(2));
        nonces[BoxRolesV2.ROLE_LAUNCH_ROUTER] = bytes1(uint8(3));
        if (withVault) nonces[BoxRolesV2.ROLE_VAULT] = bytes1(uint8(4));
        CoordinatorV2Config memory c;
        c.p = p;
        c.creator = CREATOR;
        c.raise = 1e18;
        c.deadlineDays = 30;
        c.nonces = bytes24(nonces);
        box = CoordinatorHarness(
            BoxClones.create(BoxClones.initCode(address(implementation), BoxCoordinatorV2Args.encode(c)))
        );
        address ta = vm.computeCreateAddress(address(box), 1);
        address ra = vm.computeCreateAddress(address(box), 2);
        address la = vm.computeCreateAddress(address(box), 3);
        address va = withVault ? vm.computeCreateAddress(address(box), 4) : address(0);
        t = BoxTokenV2(ta);
        vm.etch(
            ta,
            BoxClones.runtime(
                address(new BoxTokenV2(address(implementation))),
                BoxTokenV2Args.encode(address(box), va, address(0), SUPPLY, "Test T", "T")
            )
        );
        hook = new FailureHook(pm, address(box), ra, ta, p);
        receiver = FailureReceiver(ra);
        vm.etch(ra, address(new FailureReceiver(pm, address(box), address(hook), p)).code);
        receiver.configure(1, 0);
        router = FailureRouter(payable(la));
        vm.etch(la, address(new FailureRouter(pm, address(box), p)).code);
        vault = FailureVault(va);
        if (withVault) vm.etch(va, address(new FailureVault()).code);
        box.seed(address(hook), block.timestamp, gate);
        vm.prank(address(box));
        t.initialize();
        vm.prank(address(box));
        t.approve(address(hook), type(uint256).max);
    }

    function _give(address to, uint256 amount) internal {
        vm.prank(address(box));
        t.transfer(to, amount);
        vm.prank(to);
        t.approve(address(box), type(uint256).max);
    }

    function _fund(address asset, address to, uint256 amount) internal {
        if (amount == 0) return;
        if (asset == address(0)) vm.deal(address(this), address(this).balance + amount);
        else HostileToken(asset).mint(address(this), amount);
        pm.unlock(abi.encode(asset, to, amount));
    }

    function _fundT(address to, uint256 amount) internal {
        _give(address(this), amount);
        pm.unlock(abi.encode(address(t), to, amount));
    }

    function _tax(uint256 amount) internal {
        if (p == address(0)) vm.deal(address(router), amount);
        else HostileToken(p).mint(address(router), amount);
    }

    function _expire() internal {
        vm.warp(box.deadline());
    }

    function _fail(uint256 pot, uint256 coins) internal {
        _give(ALICE, coins);
        _fund(p, address(hook), pot);
        _expire();
        box.fail();
    }

    function _pot() internal view returns (uint256 pot) {
        (pot,) = box.claimState();
    }

    function _left() internal view returns (uint256 left) {
        (, left) = box.claimState();
    }

    function _claim(address who, uint256 amount, address to) internal returns (uint256) {
        vm.prank(who);
        return box.claim(amount, to);
    }

    function _balance(address who) internal view returns (uint256) {
        return PricingToken.balanceOf(p, who);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm));
        if (data.length == 0) {
            (foreignOk, foreignResult) = address(box).call(foreignCall);
            return "";
        }
        (address asset, address to, uint256 amount) = abi.decode(data, (address, address, uint256));
        PricingToken.settle(pm, asset, amount);
        pm.mint(to, uint256(uint160(asset)), amount);
        return "";
    }
}
