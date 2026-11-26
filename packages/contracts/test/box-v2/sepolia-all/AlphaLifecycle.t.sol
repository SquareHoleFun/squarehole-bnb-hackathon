// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {AlphaGenesisHarness, AlphaReleaseHarness, AlphaSetupHarness} from "./AlphaLocal.t.sol";
import {CoreV2LocalGenesis} from "../../../script/local/CoreV2LocalGenesis.s.sol";
import {AlphaRehearsalSetup} from "../../../script/local/AlphaRehearsalSetup.s.sol";
import {TestETH} from "../../../src/test-coins/TestETH.sol";
import {BoxCoordinatorV2} from "../../../src/box-v2/BoxCoordinatorV2.sol";
import {IBoxHookV2} from "../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {IBoxLaunchRouter} from "../../../src/box/interfaces/IBoxLaunchRouter.sol";
import {BoxLayoutV2} from "../../../src/box-v2/libraries/BoxLayoutV2.sol";
import {IERC20} from "v4-core/lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {FixedPointMathLib} from "solmate/src/utils/FixedPointMathLib.sol";
import {CustomRevert} from "v4-core/src/libraries/CustomRevert.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {SqrtPriceMath} from "v4-core/src/libraries/SqrtPriceMath.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";

/// Offline controls for the same deploy scripts. These are EVM calls, not an Anvil/TypeScript integration pass.
contract AlphaLifecycleTest is Test {
    using StateLibrary for IPoolManager;
    address private constant W = address(0xA11FA);
    address private constant A = address(0xA11CE);
    address private constant B = address(0xB0B);
    CoreV2LocalGenesis.AlphaDependencies private d;
    BoxCoordinatorV2 private tbox;
    BoxCoordinatorV2 private ebox;
    PoolSwapTest private swapper;
    uint256 private open;

    function setUp() public {
        vm.chainId(31337); vm.warp(1_790_000_000); vm.roll(16);
        vm.deal(W, 100 ether); vm.deal(A, 300 ether); vm.deal(B, 100 ether);
        d = new AlphaGenesisHarness().boot(W);
        address factory = new AlphaReleaseHarness().deploy(W, d);
        AlphaSetupHarness setup = new AlphaSetupHarness();
        AlphaRehearsalSetup.Assets memory a = setup.assets(d.manager, W);
        setup.admission(a.teth, W, address(0xAD), A);
        address[] memory admitted = new address[](1); admitted[0] = B;
        vm.prank(W); TestETH(a.teth).admit(admitted);
        vm.prank(A); TestETH(a.teth).drip();
        vm.prank(B); TestETH(a.teth).drip();
        uint32 id = setup.listing(factory, a.teth, W);
        vm.warp(block.timestamp + 1 days); open = block.timestamp + 120;
        tbox = BoxCoordinatorV2(setup.box(factory, id, uint32(open), A));
        ebox = BoxCoordinatorV2(setup.box(factory, 0, uint32(open), A));
        swapper = PoolSwapTest(d.poolSwapTest);
    }

    function test_windowBondingPartialGraduateAndBothSells() public {
        vm.warp(open + 1);
        _window(ebox); _window(tbox);
        vm.warp(open + 384); vm.roll(block.number + 1);
        _trade("ETH bonding buy", ebox, A, true, 0.01 ether, true);
        _trade("tETH bonding buy", tbox, A, true, 0.1 ether, true);
        _trade("ETH bonding sell", ebox, A, false, 1000 ether, true);
        _trade("tETH bonding sell", tbox, A, false, 1000 ether, true);
        uint160 limit = _limit(ebox, A, true, 0.01 ether);
        _trade("intervening ETH buy", ebox, B, true, 0.01 ether, true);
        uint256 beforeP = A.balance;
        BalanceDelta delta = _swap("partial ETH buy", ebox, A, true, 0.01 ether, limit);
        uint256 spent = uint256(-int256(delta.amount0()));
        assertGt(spent, 0); assertLt(spent, 0.01 ether);
        assertEq(beforeP - A.balance, spent); assertEq(address(swapper).balance, 0);
        (uint160 spot,,,) = IPoolManager(d.manager).getSlot0(IBoxHookV2(ebox.hook()).poolId());
        assertEq(spot, limit);
        emit log_named_uint("partial spent", spent);
        emit log_named_uint("partial refund", 0.01 ether - spent);
        // Reproduce the CLI's traded curve, including the prior sell's revoked allowance.
        assertEq(IERC20(ebox.token()).allowance(A, address(swapper)), 0);
        uint256 oldSize = vm.snapshotState();
        // With allowance fixed alone, the old 100M T sell succeeds: it still does not cross the floor.
        _swap("old 100M sell with approval", ebox, A, false, 100_000_000 ether, TickMath.MAX_SQRT_PRICE - 1);
        vm.revertToState(oldSize);
        _pool("below_curve_floor", false);
        _trade("fill tETH A", tbox, A, true, 0.8 ether, false);
        if (!IBoxHookV2(tbox.hook()).closed()) _trade("fill tETH B", tbox, B, true, 0.5 ether, false);
        assertTrue(IBoxHookV2(tbox.hook()).closed());
        _poolFor(tbox, "curve_closed", true);
        _poolFor(tbox, "curve_closed", false);
        vm.roll(block.number + 1);
        _call("Graduate button", A, address(tbox), abi.encodeCall(tbox.graduate, ()), 0, 15_000_000, true);
        assertTrue(tbox.graduated());
        _trade("graduated tETH sell", tbox, A, false, 1000 ether, true);
        _trade("ETH box sell", ebox, A, false, 1000 ether, true);
    }

    function _window(BoxCoordinatorV2 box) private {
        uint256 amount = box.raise() / 100;
        if (box.q() != address(0)) _approve(box.q(), A, box.launchRouter(), amount);
        uint256 snapshot = vm.snapshotState();
        address router = box.launchRouter();
        uint256 value = box.q() == address(0) ? amount : 0;
        vm.prank(A);
        uint256 quote = IBoxLaunchRouter(router).buy{value: value}(amount, 1, A, block.timestamp + 120);
        vm.revertToState(snapshot);
        uint256 beforeT = IERC20(box.token()).balanceOf(A);
        _call(box.q() == address(0) ? "ETH window buy" : "tETH window buy", A, box.launchRouter(),
            abi.encodeCall(IBoxLaunchRouter.buy, (amount, (quote * 9800 + 9999) / 10000, A, block.timestamp + 120)),
            box.q() == address(0) ? amount : 0, 4_000_000, true);
        assertEq(IERC20(box.token()).balanceOf(A) - beforeT, quote);
        (bool ok, bytes memory ret) = box.launchRouter().staticcall(abi.encodeWithSignature("totalTaxCollected()"));
        assertTrue(ok); assertEq(abi.decode(ret, (uint256)), (amount * 931974 + 999999) / 1000000);
        emit log_named_uint("window tax", abi.decode(ret, (uint256)));
        if (box.q() != address(0)) _approve(box.q(), A, box.launchRouter(), 0);
    }

    // Independently executes an unlimited quote, then the default 2% limit on its ending price. JS is tested separately.
    function _limit(BoxCoordinatorV2 box, address who, bool buy, uint256 amount) private returns (uint160) {
        uint256 snapshot = vm.snapshotState();
        uint160 end = box.graduated() ? (buy ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1)
            : (buy ? BoxLayoutV2.curve(box.raise(), false).sqrtPriceEndX96 : BoxLayoutV2.curve(box.raise(), false).sqrtPriceStartX96);
        address input = buy ? box.q() : box.token();
        vm.startPrank(who);
        if (input != address(0)) IERC20(input).approve(address(swapper), amount);
        swapper.swap{value: buy && box.q() == address(0) ? amount : 0}(IBoxHookV2(box.hook()).poolKey(),
            SwapParams(buy, -int256(amount), end), PoolSwapTest.TestSettings(false, false), "");
        vm.stopPrank();
        (uint160 post,,,) = IPoolManager(d.manager).getSlot0(IBoxHookV2(box.hook()).poolId());
        vm.revertToState(snapshot);
        uint256 numerator = uint256(post) * post * 10000;
        uint256 denominator = buy ? 10200 : 9800;
        uint256 limit = FixedPointMathLib.sqrt(numerator / denominator);
        if (buy && limit * limit * denominator < numerator) ++limit;
        if (buy && limit < end) limit = end;
        if (!buy && limit > end) limit = end;
        return uint160(limit);
    }
    function _trade(string memory name, BoxCoordinatorV2 box, address who, bool buy, uint256 amount, bool full) private {
        BalanceDelta delta = _swap(name, box, who, buy, amount, _limit(box, who, buy, amount));
        uint256 spent = uint256(-int256(buy ? delta.amount0() : delta.amount1()));
        if (full) assertEq(spent, amount);
        else assertLe(spent, amount);
        assertGt(int256(buy ? delta.amount1() : delta.amount0()), 0);
    }
    function _swap(string memory name, BoxCoordinatorV2 box, address who, bool buy, uint256 amount, uint160 limit) private returns (BalanceDelta) {
        address input = buy ? box.q() : box.token();
        if (input != address(0)) _approve(input, who, address(swapper), amount);
        bytes memory ret = _call(name, who, address(swapper), abi.encodeCall(PoolSwapTest.swap,
            (IBoxHookV2(box.hook()).poolKey(), SwapParams(buy, -int256(amount), limit), PoolSwapTest.TestSettings(false, false), bytes(""))),
            buy && box.q() == address(0) ? amount : 0, 4_000_000, true);
        if (input != address(0)) _approve(input, who, address(swapper), 0);
        return BalanceDelta.wrap(abi.decode(ret, (int256)));
    }
    function _approve(address coin, address who, address spender, uint256 amount) private {
        _call(amount == 0 ? "revoke" : "exact approval", who, coin, abi.encodeCall(IERC20.approve, (spender, amount)), 0, 4_000_000, true);
        assertEq(IERC20(coin).allowance(who, spender), amount);
    }
    function _call(string memory name, address who, address to, bytes memory data, uint256 value, uint256 gas, bool success)
        private returns (bytes memory ret)
    {
        vm.roll(block.number + 1);
        vm.prank(who);
        bool ok; uint256 beforeGas = gasleft();
        (ok, ret) = to.call{value: value, gas: gas}(data);
        uint256 used = beforeGas - gasleft();
        assertEq(ok, success, name);
        emit log_string(string.concat("ALPHA_CALL|", name, "|", vm.toString(who), "|", ok ? "success" : "reverted", "|", vm.toString(used), "|", ok ? "0x" : vm.toString(ret)));
    }

    function test_everyPlanRevertFromActualContracts() public {
        vm.warp(open - 1);
        _router("not_open", 0.001 ether, 1, A, block.timestamp + 120, 0.001 ether);
        _pool("trading_not_open", true);
        vm.warp(open + 1);
        _router("expired", 0.001 ether, 1, A, 1, 0.001 ether);
        _router("wrong_value", 0.001 ether, 1, A, block.timestamp + 120, 0);
        _router("insufficient_output", 0.001 ether, type(uint256).max, A, block.timestamp + 120, 0.001 ether);
        _router("amount_too_small", 0, 1, A, block.timestamp + 120, 0);
        _router("recipient_refused", 0.001 ether, 1, ebox.launchRouter(), block.timestamp + 120, 0.001 ether);
        _pool("buy_through_launch_router", true);
        uint256 snapshot = vm.snapshotState();
        address router = ebox.launchRouter();
        vm.prank(A); IBoxLaunchRouter(router).buy{value: 200 ether}(200 ether, 1, A, block.timestamp + 120);
        _router("curve_closed", 0.001 ether, 1, A, block.timestamp + 120, 0.001 ether);
        _pool("curve_closed", true); _pool("curve_closed", false);
        vm.revertToState(snapshot);
        vm.warp(open + 384);
        _router("window_closed", 0.001 ether, 1, A, block.timestamp + 120, 0.001 ether);
        _pool("below_curve_floor", false);
        vm.warp(ebox.deadline() + 1);
        _pool("failure_pending", true);
        PoolKey memory key = IBoxHookV2(ebox.hook()).poolKey(); key.fee = 3000;
        // Manager-only invariant probe; ordinary users cannot forge this caller.
        _call("unknown_pool", d.manager, ebox.hook(), abi.encodeCall(IHooks.beforeSwap,
            (A, key, SwapParams(true, -int256(1), TickMath.MIN_SQRT_PRICE + 1), bytes(""))), 0, 4_000_000, false);
    }
    function _router(string memory name, uint256 amount, uint256 min, address recipient, uint256 deadline, uint256 value) private {
        _call(name, A, ebox.launchRouter(), abi.encodeCall(IBoxLaunchRouter.buy, (amount, min, recipient, deadline)), value, 4_000_000, false);
    }
    function _pool(string memory name, bool buy) private {
        _poolFor(ebox, name, buy);
    }
    function _floorInput(BoxCoordinatorV2 box) private returns (uint256 amount, uint160 floor) {
        (uint160 spot,, uint24 protocol, uint24 lp) = IPoolManager(d.manager).getSlot0(IBoxHookV2(box.hook()).poolId());
        (, int24 upper, uint128 liquidity) = IBoxHookV2(box.hook()).curve();
        floor = TickMath.getSqrtPriceAtTick(upper);
        uint256 protocolSell = protocol >> 12;
        uint256 fee = protocolSell + lp - protocolSell * lp / 1_000_000;
        amount = FullMath.mulDivRoundingUp(SqrtPriceMath.getAmount1Delta(spot, floor, liquidity, true),
            1_000_000, 1_000_000 - fee) + 1 ether;
        emit log_string(string.concat("ALPHA_FLOOR|", vm.toString(spot), "|", vm.toString(floor), "|",
            vm.toString(liquidity), "|", vm.toString(fee), "|", vm.toString(amount)));
    }
    function _poolFor(BoxCoordinatorV2 box, string memory name, bool buy) private {
        uint256 snapshot = vm.snapshotState();
        bool below = keccak256(bytes(name)) == keccak256("below_curve_floor");
        uint256 amount = buy ? 0.001 ether : 1000 ether;
        uint160 floor;
        if (below) (amount, floor) = _floorInput(box);
        address input = buy ? box.q() : box.token();
        if (below && IERC20(input).balanceOf(A) < amount) {
            uint256 shortfall = amount - IERC20(input).balanceOf(A);
            assertGe(IERC20(input).balanceOf(address(box)), shortfall, "reserve funding");
            // Local invariant probe only; restore the coordinator reserve and tester inventory below.
            vm.prank(address(box)); IERC20(input).transfer(A, shortfall);
        }
        if (input != address(0)) {
            assertGe(IERC20(input).balanceOf(A), amount, "funded probe input");
            _approve(input, A, address(swapper), amount);
        } else assertGe(A.balance, amount);
        if (below) {
            // Same funded input settles successfully when capped at the floor; crossing it must fail in afterSwap.
            uint256 boundary = vm.snapshotState();
            _swap("floor-capped sell control", box, A, false, amount, floor);
            (uint160 atFloor,,,) = IPoolManager(d.manager).getSlot0(IBoxHookV2(box.hook()).poolId());
            assertEq(atFloor, floor);
            vm.revertToState(boundary);
        }
        bytes memory ret = _call(name, A, address(swapper), abi.encodeCall(PoolSwapTest.swap, (IBoxHookV2(box.hook()).poolKey(),
            SwapParams(buy, -int256(amount), below ? floor + 1 : buy ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1),
            PoolSwapTest.TestSettings(false, false), bytes(""))), input == address(0) ? amount : 0, 4_000_000, false);
        _assertHookError(box, name, ret, floor);
        if (input != address(0)) {
            assertEq(IERC20(input).allowance(A, address(swapper)), amount, "revert preserves exact approval");
            _approve(input, A, address(swapper), 0);
        }
        vm.revertToState(snapshot);
    }
    function _assertHookError(BoxCoordinatorV2 box, string memory name, bytes memory ret, uint160 floor) private {
        assertEq(bytes4(ret), CustomRevert.WrappedError.selector, "must fail in the hook, not settlement");
        bytes memory body = new bytes(ret.length - 4);
        for (uint256 i; i < body.length; ++i) body[i] = ret[i + 4];
        (address target, bytes4 callback, bytes memory inner, bytes memory details) =
            abi.decode(body, (address, bytes4, bytes, bytes));
        assertEq(target, box.hook());
        assertEq(bytes4(details), Hooks.HookCallFailed.selector);
        if (keccak256(bytes(name)) == keccak256("below_curve_floor")) {
            assertEq(callback, IHooks.afterSwap.selector);
            assertEq(bytes4(inner), IBoxHookV2.BelowCurveFloor.selector);
            uint160 price;
            assembly ("memory-safe") { price := mload(add(inner, 36)) }
            assertGt(price, floor);
        } else assertEq(callback, IHooks.beforeSwap.selector);
        // The JS verifier checks every nested selector/reason against the consumer's real decoder.
        emit log_string(string.concat("ALPHA_WRAPPED|", name, "|", vm.toString(target), "|", vm.toString(floor), "|", vm.toString(ret)));
    }
}
