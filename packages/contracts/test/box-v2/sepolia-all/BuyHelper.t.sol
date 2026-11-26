// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CQ11WDeploymentFixture} from "../m1-64/CQ11WDeployment.t.sol";
import {CoreV2LocalActions} from "../../../script/local/CoreV2LocalActions.sol";
import {BoxCoordinatorV2} from "../../../src/box-v2/BoxCoordinatorV2.sol";
import {BoxTokenV2} from "../../../src/box-v2/BoxTokenV2.sol";
import {IBoxHookV2} from "../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {PriceLimitSwapper} from "../../research/hookgas/HookGasKit.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {FixedPointMathLib} from "solmate/src/utils/FixedPointMathLib.sol";
import {IBoxLaunchRouter} from "../../../src/box/interfaces/IBoxLaunchRouter.sol";
import {BoxLayoutV2} from "../../../src/box-v2/libraries/BoxLayoutV2.sol";
import {LocalUSDC, LocalPriceCoin} from "../../../script/local/LocalQuoteMocks.sol";
import {IListingRegistry, ListingClass} from "../../../src/box-v2/interfaces/IListingRegistry.sol";
import {Af2Vectors} from "./fixtures/Af2Vectors.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {TradeVectors} from "./fixtures/TradeVectors.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";

/// Offline release fixture: actual v2 box, hook and pinned v4 router/manager; no fork or RPC.
contract BuyHelperTest is CQ11WDeploymentFixture, CoreV2LocalActions {
    using StateLibrary for IPoolManager;

    function _tradeBox(bool erc20) internal returns (BoxCoordinatorV2 box, PoolSwapTest swapper) {
        (localFactory,) = _run();
        vm.warp(vm.getBlockTimestamp() + 1 days);
        localActor = address(0xA11CE);
        vm.deal(localActor, 200 ether);
        localSwapper = new PriceLimitSwapper(IPoolManager(manager));
        swapper = new PoolSwapTest(IPoolManager(manager));
        if (erc20) {
            // Stable local address below the v2 coin ceiling; no production deployment.
            address p = address(0x600);
            vm.etch(p, address(new LocalUSDC()).code);
            IListingRegistry listings = IListingRegistry(localFactory.listingRegistry());
            LocalPriceCoin(p).mint(listings.lister(), 10000);
            vm.startPrank(listings.lister());
            LocalPriceCoin(p).approve(address(listings), 10000);
            listings.add(p, ListingClass.STABLE, 1000e6);
            LocalPriceCoin(p).approve(address(listings), 0);
            vm.stopPrank();
        }
        vm.startPrank(localActor);
        box = _createLocal(erc20 ? 6 : 0);
        vm.stopPrank();
    }

    function test_alphaWindowEthVector() public { _windowVector(false); }
    function test_alphaWindowErc20Vector() public { _windowVector(true); }

    function _windowVector(bool erc20) internal {
        (BoxCoordinatorV2 box,) = _tradeBox(erc20);
        vm.warp(box.effectiveOpenAt() + 12);
        uint256 amount = erc20 ? 10e6 : 0.001 ether;
        uint256 value = erc20 ? 0 : amount;
        uint256 deadline = block.timestamp + 120;
        vm.startPrank(localActor);
        if (erc20) {
            (bool approved,) = box.q().call(TradeVectors.approval(box.launchRouter(), false));
            assertTrue(approved);
            assertEq(LocalPriceCoin(box.q()).allowance(localActor, box.launchRouter()), amount);
        }
        uint256 snapshot = vm.snapshotState();
        uint256 quote = IBoxLaunchRouter(box.launchRouter()).buy{value: value, gas: 4_000_000}(amount, 1, localActor, deadline);
        vm.revertToState(snapshot);
        emit log_named_uint("quote", quote);
        emit log_named_uint("raise", box.raise());
        bytes memory data = TradeVectors.windowBuy(erc20, localActor, deadline);
        assertEq(data, abi.encodeCall(IBoxLaunchRouter.buy, (amount, (quote * 9800 + 9999) / 10000, localActor, deadline)));
        uint256 beforeT = BoxTokenV2(box.token()).balanceOf(localActor);
        (bool ok, bytes memory ret) = box.launchRouter().call{value: value, gas: 4_000_000}(data);
        assertTrue(ok, "builder window calldata executes");
        assertEq(BoxTokenV2(box.token()).balanceOf(localActor) - beforeT, abi.decode(ret, (uint256)));
        if (erc20) {
            (bool revoked,) = box.q().call(TradeVectors.approval(box.launchRouter(), true));
            assertTrue(revoked);
            assertEq(LocalPriceCoin(box.q()).allowance(localActor, box.launchRouter()), 0);
        }
        vm.stopPrank();
    }

    function test_alphaBondingBuySellVectors() public {
        (BoxCoordinatorV2 box, PoolSwapTest swapper) = _tradeBox(false);
        vm.warp(box.effectiveOpenAt() + 384);
        _poolVector(box, swapper, true, false);
        _poolVector(box, swapper, false, false);
    }

    function test_alphaGraduatedSellVector() public {
        (BoxCoordinatorV2 box, PoolSwapTest swapper) = _tradeBox(false);
        vm.warp(box.effectiveOpenAt() + 384);
        vm.roll(block.number + 1);
        vm.startPrank(localActor);
        _fillLocal(box);
        box.graduate{gas: 15_000_000}();
        vm.stopPrank();
        _poolVector(box, swapper, false, true);
    }

    function _poolVector(BoxCoordinatorV2 box, PoolSwapTest swapper, bool buy, bool graduated) internal {
        uint256 amount = buy ? 0.001 ether : 1000 ether;
        bytes memory data = _checkedPoolData(box, buy, graduated);
        vm.startPrank(localActor);
        if (!buy) BoxTokenV2(box.token()).approve(address(swapper), amount);
        uint256 beforeT = BoxTokenV2(box.token()).balanceOf(localActor);
        uint256 beforeP = localActor.balance;
        (bool ok, bytes memory ret) = address(swapper).call{value: buy ? amount : 0, gas: 4_000_000}(data);
        assertTrue(ok, "builder pool calldata executes");
        BalanceDelta delta = BalanceDelta.wrap(abi.decode(ret, (int256)));
        (uint256 expectedOutput, uint160 expectedPrice) = TradeVectors.expectedPool(buy, graduated);
        assertApproxEqAbs(uint256(int256(buy ? delta.amount1() : delta.amount0())), expectedOutput, 1);
        (uint160 actualPrice,,,) = IPoolManager(manager).getSlot0(IBoxHookV2(box.hook()).poolId());
        assertEq(actualPrice, expectedPrice);
        if (buy) {
            assertGt(BoxTokenV2(box.token()).balanceOf(localActor), beforeT);
            assertEq(beforeP - localActor.balance, uint256(-int256(delta.amount0())));
        } else {
            assertGt(localActor.balance, beforeP);
            assertEq(beforeT - BoxTokenV2(box.token()).balanceOf(localActor), uint256(-int256(delta.amount1())));
            BoxTokenV2(box.token()).approve(address(swapper), 0);
        }
        vm.stopPrank();
    }

    function _checkedPoolData(BoxCoordinatorV2 box, bool buy, bool graduated) internal returns (bytes memory data) {
        IBoxHookV2 hook = IBoxHookV2(box.hook());
        (uint160 spot,,,) = IPoolManager(manager).getSlot0(hook.poolId());
        emit log_named_uint("spot", spot);
        emit log_named_uint("raise", box.raise());
        uint256 amount = buy ? 0.001 ether : 1000 ether;
        data = TradeVectors.pool(hook.poolKey(), buy, graduated);
        (, uint160 expectedPrice) = TradeVectors.expectedPool(buy, graduated);
        uint256 numerator = uint256(expectedPrice) * expectedPrice * 10000;
        uint256 denominator = buy ? 10200 : 9800;
        uint256 limit = FixedPointMathLib.sqrt(numerator / denominator);
        if (buy && limit * limit * denominator < numerator) ++limit;
        if (!graduated) {
            uint160 end = BoxLayoutV2.curve(box.raise(), false).sqrtPriceEndX96;
            uint160 start = BoxLayoutV2.curve(box.raise(), false).sqrtPriceStartX96;
            if (buy && limit < end) limit = end;
            if (!buy && limit > start) limit = start;
        }
        assertEq(data, abi.encodeCall(PoolSwapTest.swap, (hook.poolKey(), SwapParams(buy, -int256(amount), uint160(limit)), PoolSwapTest.TestSettings(false, false), "")));
    }

    function test_alphaWholeTradeOnePercent() public { _wholeTrade(0, 1); }
    function test_alphaWholeTradeTenPercent() public { _wholeTrade(1, 10); }
    function test_alphaWholeTradeFiftyPercent() public { _wholeTrade(2, 50); }
    function test_alphaWholeTradeSell() public { _wholeTrade(3, 10); }

    function test_alphaPriceMovePartiallyFillsAndRefundsPreparedTrade() public {
        (BoxCoordinatorV2 box, PoolSwapTest swapper) = _tradeBox(false);
        vm.warp(box.effectiveOpenAt() + 384);
        IBoxHookV2 hook = IBoxHookV2(box.hook());
        (bytes memory data, uint256 expected,) = Af2Vectors.get(1, hook.poolKey());
        uint160 limit;
        assembly ("memory-safe") { limit := mload(add(data, 260)) }
        uint256 amount = box.raise() / 10;
        address mover = address(0xB0B);
        vm.deal(mover, amount);
        vm.prank(mover);
        swapper.swap{value: amount}(hook.poolKey(), SwapParams(true, -int256(amount), BoxLayoutV2.curve(box.raise(), false).sqrtPriceEndX96), PoolSwapTest.TestSettings(false, false), "");
        uint256 beforeP = localActor.balance;
        vm.prank(localActor);
        (bool ok, bytes memory ret) = address(swapper).call{value: amount, gas: 4_000_000}(data);
        assertTrue(ok, "prepared trade partially fills after another buyer");
        BalanceDelta delta = BalanceDelta.wrap(abi.decode(ret, (int256)));
        uint256 spent = uint256(-int256(delta.amount0()));
        assertGt(spent, 0);
        assertLt(spent, amount);
        assertLt(uint256(int256(delta.amount1())), expected);
        assertEq(localActor.balance, beforeP - amount + (amount - spent), "unused input refunded");
        assertEq(address(swapper).balance, 0);
        (uint160 price,,,) = IPoolManager(manager).getSlot0(hook.poolId());
        assertEq(price, limit, "stopped at prepared post-trade tolerance");
    }

    function _wholeTrade(uint256 id, uint256 percent) internal {
        (BoxCoordinatorV2 box, PoolSwapTest swapper) = _tradeBox(false);
        vm.warp(box.effectiveOpenAt() + 384);
        if (id == 3) _seedBuy(box, swapper);
        uint256 amount = id == 3 ? 1000 ether : box.raise() * percent / 100;
        IBoxHookV2 hook = IBoxHookV2(box.hook());
        (bytes memory data, uint256 expected, uint160 expectedPrice) = Af2Vectors.get(id, hook.poolKey());
        vm.startPrank(localActor);
        if (id == 3) BoxTokenV2(box.token()).approve(address(swapper), amount);
        uint256 beforeP = localActor.balance;
        uint256 beforeT = BoxTokenV2(box.token()).balanceOf(localActor);
        (bool ok, bytes memory ret) = address(swapper).call{value: id == 3 ? 0 : amount, gas: 4_000_000}(data);
        assertTrue(ok, "planned call executes");
        BalanceDelta delta = BalanceDelta.wrap(abi.decode(ret, (int256)));
        assertEq(uint256(-int256(id == 3 ? delta.amount1() : delta.amount0())), amount, "whole input fills at default tolerance");
        uint256 actual = id == 3 ? localActor.balance - beforeP : BoxTokenV2(box.token()).balanceOf(localActor) - beforeT;
        assertApproxEqAbs(actual, expected, 1, "plan output within one raw unit");
        (uint160 afterPrice,,,) = IPoolManager(manager).getSlot0(hook.poolId());
        assertEq(afterPrice, expectedPrice, "exact simulated post-trade price");
        vm.stopPrank();
    }

    function _seedBuy(BoxCoordinatorV2 box, PoolSwapTest swapper) internal {
        vm.prank(localActor);
        swapper.swap{value: box.raise() / 10}(IBoxHookV2(box.hook()).poolKey(),
            SwapParams(true, -int256(box.raise() / 10), BoxLayoutV2.curve(box.raise(), false).sqrtPriceEndX96),
            PoolSwapTest.TestSettings(false, false), "");
    }

    // Actual v4 storage/results, captured independently of the builder. No network or FFI.
    function test_alphaCapturePoolStates() public {
        (BoxCoordinatorV2 box, PoolSwapTest swapper) = _tradeBox(false);
        vm.warp(box.effectiveOpenAt() + 384);
        for (uint256 id; id < 4; ++id) {
            uint256 snap = vm.snapshotState();
            if (id == 3) _seedBuy(box, swapper);
            _capture(box, swapper, vm.toString(id), id != 3, id == 3 ? 1000 ether : box.raise() * (id == 0 ? 1 : id == 1 ? 10 : 50) / 100, false);
            vm.revertToState(snap);
        }
        _capture(box, swapper, "bondingBuy", true, 0.001 ether, false);
        vm.prank(localActor);
        swapper.swap{value: 0.001 ether}(IBoxHookV2(box.hook()).poolKey(), SwapParams(true, -int256(0.001 ether), BoxLayoutV2.curve(box.raise(), false).sqrtPriceEndX96), PoolSwapTest.TestSettings(false, false), "");
        _capture(box, swapper, "bondingSell", false, 1000 ether, false);
        vm.startPrank(localActor);
        _fillLocal(box);
        vm.roll(block.number + 1);
        box.graduate{gas: 15_000_000}();
        vm.stopPrank();
        _capture(box, swapper, "graduatedSell", false, 1000 ether, true);
    }

    function _capture(BoxCoordinatorV2 box, PoolSwapTest swapper, string memory name, bool buy, uint256 amount, bool graduated) internal {
        IBoxHookV2 hook = IBoxHookV2(box.hook());
        string memory storageJson = _storage(hook, name);
        (uint160 spot,,,) = IPoolManager(manager).getSlot0(hook.poolId());
        vm.serializeString(name, "name", name);
        vm.serializeString(name, "raise", vm.toString(box.raise()));
        vm.serializeString(name, "amount", vm.toString(amount));
        vm.serializeString(name, "spot", vm.toString(spot));
        vm.serializeString(name, "base", vm.toString(keccak256(abi.encode(hook.poolId(), uint256(6)))));
        vm.serializeString(name, "storage", storageJson);
        (uint256 output, uint256 input, uint160 afterPrice) = _quote(box, swapper, buy, amount, graduated);
        vm.serializeString(name, "output", vm.toString(output));
        vm.serializeString(name, "input", vm.toString(input));
        string memory json = vm.serializeString(name, "afterPrice", vm.toString(afterPrice));
        emit log_string(string.concat("AF2 ", json));
    }

    function _storage(IBoxHookV2 hook, string memory name) internal returns (string memory) {
        bytes32 base = keccak256(abi.encode(hook.poolId(), uint256(6)));
        string memory stateKey = string.concat("state-", name);
        vm.serializeString(stateKey, vm.toString(base), vm.toString(uint256(vm.load(manager, base))));
        string memory storageJson = vm.serializeString(stateKey, vm.toString(bytes32(uint256(base) + 3)), vm.toString(uint256(vm.load(manager, bytes32(uint256(base) + 3)))));
        for (int256 word = -58; word <= 57; ++word) {
            bytes32 slot = keccak256(abi.encode(word, uint256(base) + 5));
            uint256 bitmap = uint256(vm.load(manager, slot));
            storageJson = vm.serializeString(stateKey, vm.toString(slot), vm.toString(bitmap));
            for (uint256 bit; bit < 256 && bitmap != 0; ++bit) {
                if (bitmap & (uint256(1) << bit) == 0) continue;
                int256 tick = (word * 256 + int256(bit)) * 60;
                bytes32 tickSlot = keccak256(abi.encode(tick, uint256(base) + 4));
                storageJson = vm.serializeString(stateKey, vm.toString(tickSlot), vm.toString(uint256(vm.load(manager, tickSlot))));
                bitmap &= ~(uint256(1) << bit);
            }
        }
        return storageJson;
    }

    function _quote(BoxCoordinatorV2 box, PoolSwapTest swapper, bool buy, uint256 amount, bool graduated) internal returns (uint256 output, uint256 input, uint160 afterPrice) {
        uint256 snap = vm.snapshotState();
        vm.startPrank(localActor);
        if (!buy) BoxTokenV2(box.token()).approve(address(swapper), amount);
        uint160 limit = graduated ? (buy ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1) : (buy ? BoxLayoutV2.curve(box.raise(), false).sqrtPriceEndX96 : BoxLayoutV2.curve(box.raise(), false).sqrtPriceStartX96);
        BalanceDelta delta = swapper.swap{value: buy ? amount : 0, gas: 4_000_000}(IBoxHookV2(box.hook()).poolKey(), SwapParams(buy, -int256(amount), limit), PoolSwapTest.TestSettings(false, false), "");
        (afterPrice,,,) = IPoolManager(manager).getSlot0(IBoxHookV2(box.hook()).poolId());
        output = uint256(int256(buy ? delta.amount1() : delta.amount0()));
        input = uint256(-int256(buy ? delta.amount0() : delta.amount1()));
        vm.stopPrank();
        vm.revertToState(snap);
    }

    function test_alphaErrorEncodingVectors() public pure {
        address router = address(0x30);
        assertEq(TradeVectors.revertData(0), abi.encodeWithSelector(IBoxHookV2.BuyThroughLaunchRouter.selector, router, uint256(1384)));
        assertEq(TradeVectors.revertData(1), abi.encodeWithSelector(IBoxHookV2.CurveIsClosed.selector, uint256(16)));
        assertEq(TradeVectors.revertData(2), abi.encodeWithSelector(IBoxLaunchRouter.CurveIsClosed.selector));
        assertEq(TradeVectors.revertData(3), abi.encodeWithSelector(IBoxHookV2.TradingNotOpen.selector, uint256(1000)));
        assertEq(TradeVectors.revertData(4), abi.encodeWithSelector(IBoxHookV2.FailurePending.selector, uint256(2000)));
        assertEq(TradeVectors.revertData(5), abi.encodeWithSelector(IBoxHookV2.BelowCurveFloor.selector, uint160(123)));
        assertEq(TradeVectors.revertData(6), abi.encodeWithSelector(IBoxHookV2.UnknownPool.selector));
        assertEq(TradeVectors.revertData(7), abi.encodeWithSelector(IBoxLaunchRouter.NotOpen.selector, uint256(1000)));
        assertEq(TradeVectors.revertData(8), abi.encodeWithSelector(IBoxLaunchRouter.WindowClosed.selector, uint256(1384)));
        assertEq(TradeVectors.revertData(9), abi.encodeWithSelector(IBoxLaunchRouter.Expired.selector, uint256(1120)));
        assertEq(TradeVectors.revertData(10), abi.encodeWithSelector(IBoxLaunchRouter.WrongValue.selector, uint256(0), uint256(100)));
        assertEq(TradeVectors.revertData(11), abi.encodeWithSelector(IBoxLaunchRouter.InsufficientOutput.selector, uint256(1), uint256(2)));
        assertEq(TradeVectors.revertData(12), abi.encodeWithSelector(IBoxLaunchRouter.AmountTooSmall.selector));
        assertEq(TradeVectors.revertData(13), abi.encodeWithSelector(IBoxLaunchRouter.RecipientRefused.selector, address(0x70)));
        assertEq(TradeVectors.revertData(14), abi.encodeWithSelector(bytes4(keccak256("WrappedError(address,bytes4,bytes,bytes)")), address(0x2ae0), bytes4(0x12345678), TradeVectors.revertData(0), hex"deadbeef"));
    }

    function test_alphaActualRouterRevertReasons() public {
        (BoxCoordinatorV2 box,) = _tradeBox(false);
        uint256 open = box.effectiveOpenAt();
        vm.warp(open + 12);
        vm.startPrank(localActor);
        _routerReason(box, 0.001 ether, 1, localActor, block.timestamp - 1, 0.001 ether, 9);
        _routerReason(box, 0.001 ether, 1, box.launchRouter(), block.timestamp + 120, 0.001 ether, 13);
        _routerReason(box, 0, 1, localActor, block.timestamp + 120, 0, 12);
        _routerReason(box, 0.001 ether, 1, localActor, block.timestamp + 120, 0, 10);
        _routerReason(box, 0.001 ether, type(uint256).max, localActor, block.timestamp + 120, 0.001 ether, 11);
        vm.warp(open - 1);
        _routerReason(box, 0.001 ether, 1, localActor, block.timestamp + 120, 0.001 ether, 7);
        vm.warp(open + 384);
        _routerReason(box, 0.001 ether, 1, localActor, block.timestamp + 120, 0.001 ether, 8);
        vm.warp(open + 12);
        IBoxLaunchRouter(box.launchRouter()).buy{value: 100 ether, gas: 4_000_000}(100 ether, 1, localActor, block.timestamp + 120);
        _routerReason(box, 0.001 ether, 1, localActor, block.timestamp + 120, 0.001 ether, 2);
        vm.stopPrank();
    }

    function _routerReason(BoxCoordinatorV2 box, uint256 amount, uint256 minOut, address recipient, uint256 deadline, uint256 value, uint256 id) internal {
        (bool ok, bytes memory ret) = box.launchRouter().call{value: value, gas: 4_000_000}(abi.encodeCall(IBoxLaunchRouter.buy, (amount, minOut, recipient, deadline)));
        assertFalse(ok);
        _reason(ret, id, false);
    }

    function test_alphaActualPoolRevertReasons() public {
        (BoxCoordinatorV2 box, PoolSwapTest swapper) = _tradeBox(false);
        IBoxHookV2 hook = IBoxHookV2(box.hook());
        uint256 open = box.effectiveOpenAt();
        vm.warp(open - 1);
        vm.startPrank(localActor);
        _poolReason(hook, swapper, true, 3);
        vm.warp(open + 12);
        _poolReason(hook, swapper, true, 0);
        vm.warp(open + 384);
        _poolReason(hook, swapper, false, 5);
        vm.warp(open + 31 days);
        _poolReason(hook, swapper, true, 4);
        vm.warp(open + 384);
        _fillLocal(box);
        _poolReason(hook, swapper, true, 1);
        vm.stopPrank();
        PoolKey memory wrong = hook.poolKey();
        wrong.fee = 3000;
        vm.prank(manager);
        (bool ok, bytes memory ret) = address(hook).call(abi.encodeCall(IHooks.beforeSwap, (localActor, wrong, SwapParams(true, -int256(0.001 ether), 1), "")));
        assertFalse(ok);
        _reason(ret, 6, false);
    }

    function _poolReason(IBoxHookV2 hook, PoolSwapTest swapper, bool buy, uint256 id) internal {
        uint160 limit = buy ? uint160(4295128740) : type(uint160).max / 2;
        (bool ok, bytes memory ret) = address(swapper).call{value: buy ? 0.001 ether : 0, gas: 4_000_000}(
            abi.encodeCall(PoolSwapTest.swap, (hook.poolKey(), SwapParams(buy, -int256(uint256(buy ? 0.001 ether : 1e26)), limit), PoolSwapTest.TestSettings(false, false), "")));
        assertFalse(ok);
        _reason(ret, id, true);
    }

    function _reason(bytes memory data, uint256 id, bool wrapped) internal pure {
        if (wrapped) {
            assertEq(bytes4(data), bytes4(keccak256("WrappedError(address,bytes4,bytes,bytes)")));
            bytes memory tail = new bytes(data.length - 4);
            for (uint256 i; i < tail.length; ++i) tail[i] = data[i + 4];
            (,,data,) = abi.decode(tail, (address, bytes4, bytes, bytes));
        }
        assertEq(bytes4(data), bytes4(TradeVectors.revertData(id)), "same reason selector as TypeScript fixture");
    }

    function test_poolBuyStopsAtLimitAndRefundsUnusedEth() public {
        (localFactory,) = _run();
        vm.warp(vm.getBlockTimestamp() + 1 days);
        localActor = address(0xA11CE);
        vm.deal(localActor, 200 ether);
        localSwapper = new PriceLimitSwapper(IPoolManager(manager));
        PoolSwapTest router = new PoolSwapTest(IPoolManager(manager));
        vm.startPrank(localActor);
        BoxCoordinatorV2 box = _createLocal(0);
        vm.warp(box.effectiveOpenAt() + 384);
        vm.roll(block.number + 1);
        _fillLocal(box);
        box.graduate{gas: 15_000_000}();
        vm.stopPrank();
        assertTrue(box.graduated());
        IBoxHookV2 hook = IBoxHookV2(box.hook());
        assertEq(hook.poolKey().fee, 10_000, "rc8 uses a 1% pool fee");

        // 100 bps maximum rise in raw P per raw T: ceil(sqrt(spot^2 * 10000 / 10100)).
        (uint160 spot,,,) = IPoolManager(manager).getSlot0(hook.poolId());
        uint256 numerator = uint256(spot) * spot * 10_000;
        uint256 limit = FixedPointMathLib.sqrt(numerator / 10_100);
        if (limit * limit * 10_100 < numerator) ++limit;
        assertLt(limit, spot);
        assertGe(limit * limit * 10_100, numerator, "rounding must not exceed maximum price");

        address buyer = address(0xB0B);
        uint256 input = 10 ether; // More than needed to reach this nearby limit.
        vm.deal(buyer, input + 1 ether);
        uint256 beforeEth = buyer.balance;
        uint256 beforeT = BoxTokenV2(box.token()).balanceOf(buyer);
        vm.startPrank(buyer);
        BalanceDelta delta = router.swap{value: input}(
            hook.poolKey(), SwapParams(true, -int256(input), uint160(limit)),
            PoolSwapTest.TestSettings(false, false), ""
        );
        vm.stopPrank();
        (uint160 afterPrice,,,) = IPoolManager(manager).getSlot0(hook.poolId());
        uint256 spent = uint256(-int256(delta.amount0()));
        uint256 received = BoxTokenV2(box.token()).balanceOf(buyer) - beforeT;
        assertEq(afterPrice, limit, "swap stops exactly at the price limit");
        assertGt(spent, 0);
        assertLt(spent, input, "partial fill spends less than supplied value");
        assertGt(received, 0);
        assertEq(received, uint256(int256(delta.amount1())), "buyer receives actual T delta");
        assertEq(beforeEth - buyer.balance, spent, "buyer pays only actual pool input including fee");
        assertEq(buyer.balance, beforeEth - input + (input - spent), "unused ETH returned to buyer");
        assertEq(address(router).balance, 0, "router retains no ETH");
        emit log_named_uint("input ceiling", input);
        emit log_named_uint("actual input including fee", spent);
        emit log_named_uint("unused ETH refunded", input - spent);
        emit log_named_uint("delivered T", received);
    }
}
