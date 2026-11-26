// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ReferenceModel} from "./ReferenceModel.sol";
import {PoolDriver, HostileToken} from "../kit/BoxV2TestBase.sol";
import {MockBoxHookV2} from "../kit/mocks/MockBox.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, toBeforeSwapDelta} from "v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {IBoxHookV2} from "../../../src/box-v2/interfaces/IBoxHookV2.sol";

/// TEST ONLY: independent plain-hook callback boundary against the real PoolManager.
/// Production integration is covered by cq11-a and rc6.
contract SaleHookBoundary {
    IPoolManager public immutable pm;
    address public immutable receiver;
    uint256 public gross;
    uint256 public saleFeesPending;

    constructor(IPoolManager manager, address r) {
        pm = manager;
        receiver = r;
    }

    function beforeSwap(address, PoolKey calldata, SwapParams calldata, bytes calldata)
        external
        view
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        require(msg.sender == address(pm));
        return (this.beforeSwap.selector, toBeforeSwapDelta(0, 0), 0);
    }

    function afterSwap(address, PoolKey calldata, SwapParams calldata, BalanceDelta delta, bytes calldata)
        external returns (bytes4, int128)
    {
        require(msg.sender == address(pm));
        gross = uint128(delta.amount0());
        return (this.afterSwap.selector, 0);
    }

    function harvest() external returns (uint256, uint256 sellers, uint256) {
        require(msg.sender == receiver);
        sellers = saleFeesPending;
        saleFeesPending = 0;
        return (0, sellers, 0);
    }
}

contract ReferenceSwapDriver is PoolDriver {
    constructor(IPoolManager pm_) PoolDriver(pm_) {}

    function swapOut(PoolKey memory key, uint256 amount, uint160 limit) external returns (BalanceDelta) {
        SwapParams memory params = SwapParams(false, int256(amount), limit);
        return abi.decode(pm.unlock(abi.encode(uint8(2), abi.encode(key, params))), (BalanceDelta));
    }
}

contract SaleReferenceTest is ReferenceModel {
    IPoolManager internal pm;
    ReferenceSwapDriver internal driver;
    SaleHookBoundary internal hook;
    PoolKey internal key;

    function setUp() public {
        pm = IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(address(this))));
        driver = new ReferenceSwapDriver(pm);
        HostileToken a = new HostileToken("A", "A", 18);
        HostileToken b = new HostileToken("B", "B", 18);
        a.mint(address(driver), 1e30);
        b.mint(address(driver), 1e30);
        SaleHookBoundary code = new SaleHookBoundary(pm, address(this));
        vm.etch(address(0x1000C0), address(code).code);
        hook = SaleHookBoundary(address(0x1000C0));
        (address p, address t) = address(a) < address(b) ? (address(a), address(b)) : (address(b), address(a));
        key = PoolKey(Currency.wrap(p), Currency.wrap(t), 10_000, 60, IHooks(address(hook)));
        pm.initialize(key, uint160(1 << 96));
        driver.modify(key, -887220, 887220, 1e18);
    }

    function testFuzz_exactInPaysInputFeeWithoutOutputSurcharge(uint96 seed, bool limited) public {
        uint256 amount = bound(seed, 100, 1e24);
        (uint256 spent, uint256 net) =
            driver.swap(key, false, amount, limited ? TickMath.getSqrtPriceAtTick(1) : TickMath.MAX_SQRT_PRICE - 1);
        assertEq(net, hook.gross());
        assertLe(spent, amount);
        _assertFee(0);
        if (limited && amount > 1e15) assertLt(spent, amount);
    }

    function testFuzz_exactOutHasNoOutputSurcharge(uint64 seed) public {
        uint256 net = bound(seed, 1, 1e15);
        BalanceDelta delta = driver.swapOut(key, net, TickMath.MAX_SQRT_PRICE - 1);
        assertEq(uint128(delta.amount0()), net);
        assertEq(hook.gross(), net);
        assertGt(uint256(-int256(delta.amount1())), net);
        _assertFee(0);
    }

    function test_partialExactOutUsesNormalFill() public {
        BalanceDelta delta = driver.swapOut(key, 1e15, TickMath.getSqrtPriceAtTick(1));
        assertGt(delta.amount0(), 0); assertLt(delta.amount0(), 1e15);
        _assertFee(0);
    }

    function testFuzz_sharedStepMark(uint40 last, uint40 advance) public checkedModel {
        (last, advance) = abi.decode(modelCase("step", abi.encode(last, advance)), (uint40, uint40));
        MockBoxHookV2 boundary = new MockBoxHookV2(new HostileToken("P", "P", 6));
        last = uint40(bound(last, 1, type(uint40).max));
        vm.roll(last);
        boundary.scriptProtocolStep();
        uint256 current = uint256(last) + advance;
        vm.roll(current);
        uint256[] memory input = new uint256[](3);
        input[0] = last;
        input[1] = current;
        input[2] = 1;
        uint256[] memory e = model("step", input);
        if (e[0] == 0) vm.expectRevert(IBoxHookV2.ProtocolStepTaken.selector);
        boundary.scriptProtocolStep();
        assertEq(boundary.lastProtocolBlock(), e[1]);
    }

    function _assertFee(uint256 fee) internal {
        assertEq(pm.balanceOf(address(this), key.currency0.toId()), fee);
        assertEq(hook.saleFeesPending(), fee);
        (, uint256 sellers,) = hook.harvest();
        assertEq(sellers, fee);
        (, sellers,) = hook.harvest();
        assertEq(sellers, 0);
        assertEq(pm.balanceOf(address(this), key.currency0.toId()), fee);
    }
}
