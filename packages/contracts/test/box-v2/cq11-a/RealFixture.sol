// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {ReceiverDeploy} from "../fee-modules/ReceiverDeploy.sol";

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";
import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";
import {BoxCoordinatorV2} from "../../../src/box-v2/BoxCoordinatorV2.sol";
import {BoxTokenV2} from "../../../src/box-v2/BoxTokenV2.sol";
import {BoxTokenV2Args} from "../../../src/box-v2/interfaces/IBoxTokenV2.sol";
import {BoxReceiverV2} from "../../../src/box-v2/BoxReceiverV2.sol";
import {BoxLaunchRouterV2} from "../../../src/box-v2/BoxLaunchRouterV2.sol";
import {CoordinatorV2Config, BoxCoordinatorV2Args} from "../../../src/box-v2/libraries/BoxCoordinatorV2Args.sol";
import {ReceiverArgs, BoxReceiverV2Args} from "../../../src/box-v2/libraries/BoxReceiverV2Args.sol";
import {BoxLaunchRouterV2Args} from "../../../src/box-v2/libraries/BoxLaunchRouterV2Args.sol";
import {BoxRolesV2} from "../../../src/box-v2/interfaces/IBoxRegistryV2.sol";
import {BoxHookV2Args as A} from "../../../src/box-v2/libraries/BoxHookV2Args.sol";
import {BoxLayoutV2} from "../../../src/box-v2/libraries/BoxLayoutV2.sol";
import {IBoxHookV2} from "../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {FeeBatchV2} from "../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {CQAAsset, CQATrader} from "./Fixture.sol";

/// Real coordinator, receiver, router, T and hook clones, deployed and launched through the coordinator.
/// Only the freely mintable price coin and the user's swap settlement driver are test doubles.
abstract contract CQ11ARealFixture is Test {
    using StateLibrary for IPoolManager;
    IPoolManager internal pm;
    BoxCoordinatorV2 internal box;
    BoxReceiverV2 internal receiver;
    BoxLaunchRouterV2 internal router;
    BoxTokenV2 internal t;
    CQAAsset internal p;
    IBoxHookV2 internal hook;
    CQATrader internal trader;
    BoxLayoutV2.Curve internal layout;
    PoolKey internal key;
    uint256 internal constant RAISE = 4_206980085e9;
    uint256 internal constant LARGE = 340282366920938463376658674914100925496;
    uint256 internal creatorBuy;
    bool internal holdGate;
    uint8 internal choice = 1;
    address internal ci;
    address internal ti;
    address internal ri;
    address internal li;
    address internal hi;

    function setUp() public virtual {
        vm.warp(1_000_000); vm.roll(100);
        pm = IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(address(this))));
        vm.etch(address(0x1000), address(new CQAAsset()).code);
        p = CQAAsset(address(0x1000));
        trader = new CQATrader(pm);
        ci = deployCode("BoxCoordinatorV2.sol:BoxCoordinatorV2", abi.encode(pm, address(this)));
        ti = deployCode("BoxTokenV2.sol:BoxTokenV2", abi.encode(ci));
        ri = deployCode("BoxReceiverV2.sol:BoxReceiverV2", ReceiverDeploy.args(pm, ci, address(0xF17), address(0xB17)));
        li = deployCode("BoxLaunchRouterV2.sol:BoxLaunchRouterV2", abi.encode(pm, ci));
        address ext = deployCode("BoxHookV2Extension.sol:BoxHookV2Extension", abi.encode(pm));
        hi = deployCode("BoxHookV2.sol:BoxHookV2", abi.encode(pm, ci, ext));
        _make(RAISE);
    }

    function _make(uint256 raise) internal {
        bytes memory nonces = new bytes(24);
        nonces[BoxRolesV2.ROLE_TOKEN] = bytes1(uint8(1));
        nonces[BoxRolesV2.ROLE_RECEIVER] = bytes1(uint8(2));
        nonces[BoxRolesV2.ROLE_LAUNCH_ROUTER] = bytes1(uint8(3));
        CoordinatorV2Config memory c;
        c.p = address(p); c.raise = raise; c.bootstrapQ = raise / 10000;
        c.creator = address(this); c.creatorBuy = creatorBuy; c.deadlineDays = 30; c.nonces = bytes24(nonces);
        box = BoxCoordinatorV2(BoxClones.create(BoxClones.initCode(ci, BoxCoordinatorV2Args.encode(c))));
        t = BoxTokenV2(vm.computeCreateAddress(address(box), 1));
        receiver = BoxReceiverV2(vm.computeCreateAddress(address(box), 2));
        router = BoxLaunchRouterV2(payable(vm.computeCreateAddress(address(box), 3)));
        layout = BoxLayoutV2.curve(raise, false);
        A.Args memory a;
        a.q = address(p); a.token = address(t); a.sqrtP1 = layout.sqrtPriceEndX96;
        a.sqrtP0 = layout.sqrtPriceStartX96; a.launchRouter = address(router); a.kind = 2;
        a.tickLower = layout.tickLower; a.tickUpper = layout.tickUpper; a.liquidity = layout.liquidity;
        a.raise = raise; a.coordinator = address(box); a.receiver = address(receiver);
        a.tipMaxQ = raise / 100; a.stepMinQ = raise / 100000;
        bytes memory hookCode = BoxClones.initCode(hi, A.encode(a));
        bytes32 hash = keccak256(hookCode);
        uint256 salt;
        address at;
        while (true) {
            at = address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(box), bytes32(salt), hash)))));
            if (uint160(at) & 0x3fff == 0x2ae0 && uint160(at) >> 152 != BoxSpecV1.HOOK_FORBIDDEN_ADDRESS_PREFIX) break;
            ++salt;
        }
        hook = IBoxHookV2(at);
        bytes[] memory codes = new bytes[](3);
        codes[0] = BoxClones.initCode(ti, BoxTokenV2Args.encode(address(box), address(0), address(0), BoxSpecV1.ISSUANCE, "Test", "T"));
        codes[1] = _receiverCode(raise);
        codes[2] = BoxClones.initCode(li, BoxLaunchRouterV2Args.encode(address(p), address(t), at, address(box), layout.sqrtPriceEndX96, c.bootstrapQ));
        bytes32 root = holdGate ? keccak256(abi.encodePacked(hex"00", bytes32(0))) : bytes32(0);
        box.deploy(codes, hookCode, bytes32(salt), 1, [bytes32(0), root], [uint256(0), holdGate ? uint256(1) : 0]);
        if (address(p) == address(0)) vm.deal(address(this), raise + creatorBuy);
        else { p.mint(address(this), raise + creatorBuy); p.approve(address(box), type(uint256).max); }
        box.launch{value: address(p) == address(0) ? c.bootstrapQ + c.creatorBuy : 0}();
        key = hook.poolKey();
        if (address(p) == address(0)) vm.deal(address(trader), raise * 32);
        else p.mint(address(trader), raise * 32);
    }

    function _receiverCode(uint256 raise) private view returns (bytes memory) {
        ReceiverArgs memory a;
        a.coordinator = address(box); a.hook = address(hook); a.p = address(p); a.t = address(t);
        a.launchRouter = address(router); a.registry = address(this); a.creatorPayee = address(this);
        a.boxId = 1; a.batchMinQ = 1; a.tipMaxQ = uint128(raise / 100); a.stepMinQ = uint128(raise / 100000);
        a.buyersChoice = choice; a.sellersChoice = choice;
        return BoxClones.initCode(ri, BoxReceiverV2Args.encode(a));
    }
    function _open() internal { vm.warp(box.effectiveOpenAt() + 384); vm.roll(block.number + 1); }
    function _buy(uint256 amount) internal returns (BalanceDelta) {
        return trader.trade(key, true, -int256(amount), layout.sqrtPriceEndX96);
    }
    function _fill() internal {
        _open();
        for (uint256 i; i < 5 && !hook.closed(); ++i) _buy(layout.raise / 4);
        assertTrue(hook.closed());
    }
    function _graduate() internal { _fill(); box.graduate(); assertTrue(box.graduated()); }
    function _claims(address who) internal view returns (uint256) { return pm.balanceOf(who, uint256(uint160(address(p)))); }
}
