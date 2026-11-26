// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";
import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";
import {BoxLayoutV2} from "../../../src/box-v2/libraries/BoxLayoutV2.sol";
import {BoxHookV2Args as A} from "../../../src/box-v2/libraries/BoxHookV2Args.sol";
import {IBoxHookV2, ProtocolSkip} from "../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {ERC20} from "solmate/src/tokens/ERC20.sol";

contract CQAAsset is ERC20 {
    bool public refuseBurn;
    constructor() ERC20("Coin", "C", 18) {}
    function mint(address to, uint256 n) external { _mint(to, n); }
    function burn(uint256 n) external { require(!refuseBurn, "burn refused"); _burn(msg.sender, n); }
    function setRefuseBurn(bool b) external { refuseBurn = b; }
}

contract CQACoordinator {
    uint256 public effectiveOpenAt;
    uint256 public deadline;
    bool public gateOpen;
    bool public failed;
    function roleAddress(uint256) external pure returns (address) { return address(0); }
    function setGate(uint256 at, uint256 end) external { effectiveOpenAt = at; deadline = end; gateOpen = at != 0; }
    function setFailed() external { failed = true; }
    function exec(address target, bytes memory data) external returns (bytes memory r) {
        bool ok;
        (ok, r) = target.call(data);
        if (!ok) assembly ("memory-safe") { revert(add(r, 32), mload(r)) }
    }
}

/// Test-only settlement driver; separate instances exercise the router, receiver and unrelated sender.
contract CQATrader {
    receive() external payable {}
    IPoolManager immutable pm;
    constructor(IPoolManager manager) { pm = manager; }
    function trade(PoolKey memory key, bool buy, int256 amount, uint160 limit) external returns (BalanceDelta) {
        return abi.decode(pm.unlock(abi.encode(uint8(0), abi.encode(key, SwapParams(buy, amount, limit)))), (BalanceDelta));
    }
    function gift(address asset, address to, uint256 n) external {
        pm.unlock(abi.encode(uint8(1), abi.encode(asset, to, n)));
    }
    function harvest(IBoxHookV2 h) external returns (uint256, uint256, uint256) { return h.harvest(); }
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm));
        (uint8 action, bytes memory arg) = abi.decode(data, (uint8, bytes));
        if (action == 1) {
            (address asset, address to, uint256 n) = abi.decode(arg, (address, address, uint256));
            pm.sync(Currency.wrap(asset));
            CQAAsset(asset).transfer(address(pm), n);
            pm.settle();
            pm.mint(to, uint256(uint160(asset)), n);
            return "";
        }
        (PoolKey memory key, SwapParams memory p) = abi.decode(arg, (PoolKey, SwapParams));
        BalanceDelta d = pm.swap(key, p, "");
        _settle(key.currency0, d.amount0());
        _settle(key.currency1, d.amount1());
        return abi.encode(d);
    }
    function _settle(Currency c, int128 d) private {
        if (d < 0 && Currency.unwrap(c) == address(0)) {
            pm.settle{value: uint256(-int256(d))}();
        } else if (d < 0) {
            pm.sync(c);
            CQAAsset(Currency.unwrap(c)).transfer(address(pm), uint256(-int256(d)));
            pm.settle();
        } else if (d > 0) pm.take(c, address(this), uint256(int256(d)));
    }
}

abstract contract CQ11AFixture is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    IPoolManager internal pm;
    IBoxHookV2 internal hook;
    CQACoordinator internal coordinator;
    CQATrader internal trader;
    CQATrader internal receiver;
    CQATrader internal router;
    CQAAsset internal p;
    CQAAsset internal t;
    BoxLayoutV2.Curve internal layout;
    uint256 internal constant RAISE = 4_206980085e9;
    uint256 internal opened;
    PoolKey internal key;

    function setUp() public {
        vm.warp(1_000_000);
        vm.roll(100);
        pm = IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(address(this))));
        trader = new CQATrader(pm);
        receiver = new CQATrader(pm);
        router = new CQATrader(pm);
        address pi = address(new CQAAsset());
        address ti = address(new CQAAsset());
        (p, t) = pi < ti ? (CQAAsset(pi), CQAAsset(ti)) : (CQAAsset(ti), CQAAsset(pi));
        _make(RAISE);
    }
    function _make(uint256 r) internal {
        address ci = address(new CQACoordinator());
        coordinator = CQACoordinator(BoxClones.create(BoxClones.initCode(ci, "")));
        opened = block.timestamp + 10;
        coordinator.setGate(opened, opened + 30 days);
        layout = BoxLayoutV2.curve(r, false);
        A.Args memory a;
        a.q = address(p); a.token = address(t); a.sqrtP1 = layout.sqrtPriceEndX96;
        a.sqrtP0 = layout.sqrtPriceStartX96; a.launchRouter = address(router); a.kind = 2;
        a.tickLower = layout.tickLower; a.tickUpper = layout.tickUpper; a.liquidity = layout.liquidity;
        a.raise = r; a.coordinator = address(coordinator); a.receiver = address(receiver);
        a.tipMaxQ = r / 100; a.stepMinQ = r / 100000;
        address ext = deployCode("BoxHookV2Extension.sol:BoxHookV2Extension", abi.encode(pm));
        address impl = deployCode("BoxHookV2.sol:BoxHookV2", abi.encode(pm, ci, ext));
        // Etched hooks need both the required flags and a prefix other than the forbidden 0x91.
        uint160 middle = uint160(uint256(keccak256(abi.encode(r, coordinator)))) & ((uint160(1) << 152) - 1);
        address at = address((uint160(0x55) << 152) | (middle & ~uint160(0x3fff)) | 0x2ae0);
        vm.etch(at, BoxClones.runtime(impl, A.encode(a)));
        hook = IBoxHookV2(at);
        t.mint(address(coordinator), BoxSpecV1.ISSUANCE);
        coordinator.exec(address(t), abi.encodeCall(t.approve, (at, type(uint256).max)));
        coordinator.exec(at, abi.encodeCall(hook.initialize, ()));
        coordinator.exec(at, abi.encodeCall(hook.launch, ()));
        key = hook.poolKey();
        p.mint(address(trader), r * 8);
        p.mint(address(receiver), r);
        p.mint(address(router), r);
    }
    function _open() internal { vm.warp(opened + 384); vm.roll(block.number + 1); }
    function _buy(uint256 n) internal returns (BalanceDelta) {
        return trader.trade(key, true, -int256(n), layout.sqrtPriceEndX96);
    }
    function _fill() internal { _open(); _buy(layout.raise * 2); assertTrue(hook.closed()); }
    function _migrate() internal {
        _fill();
        coordinator.exec(address(hook), abi.encodeCall(hook.migrate, (layout.poolShare)));
    }
    function _claims(address owner) internal view returns (uint256) { return pm.balanceOf(owner, uint256(uint160(address(p)))); }

}
