// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {DeploySepoliaV2TestSet} from "../../../script/sepolia-v2/DeploySepoliaV2TestSet.s.sol";
import {SepoliaTestPools} from "../../../script/sepolia-v2/SepoliaTestPools.s.sol";
import {TestPoolLiquidity} from "../../../src/test-coins/TestPoolLiquidity.sol";
import {TestCoin} from "../../../src/test-coins/TestCoins.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {BoxSwapBoundsV2} from "../../../src/box-v2/libraries/BoxSwapBoundsV2.sol";
import {PriceLimitSwapper} from "../../research/hookgas/HookGasKit.sol";
import {AlchemistRouteDriver} from "../alchemist/Routes.t.sol";
import {AlchemistHopV21} from "../../../src/box-v2/modules/AlchemistRouteV21.sol";
import {PoolDriver} from "../kit/BoxV2TestBase.sol";

contract TestPoolsTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    IPoolManager private pm;
    TestPoolLiquidity private helper;
    SepoliaTestPools private planner;
    address[6] private coins;

    function setUp() public {
        vm.chainId(31337);
        vm.setEnv("CORE_V2_DEPLOYER", vm.toString(address(this)));
        vm.setEnv("TEST_COIN_RECIPIENT", vm.toString(address(this)));
        vm.setEnv("CORE_V2_BROADCAST", "false");
        coins = new DeploySepoliaV2TestSet().runTestCoins();
        pm = IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(address(this))));
        helper = new TestPoolLiquidity(pm, address(this));
        planner = new SepoliaTestPools();
        vm.deal(address(this), 100 ether);
    }

    function _seed(uint256 i) private view returns (TestPoolLiquidity.Seed memory s) {
        // Test prices: 100 LINK/USDC/NVDA, 1 Gold, or 1,000,000 PEPE/Frog per ETH.
        uint256 q96 = uint256(1) << 96;
        uint160 price = uint160(i == 1 ? q96 / 100_000 : i == 3 ? q96 : i >= 4 ? q96 * 1000 : q96 * 10);
        s = TestPoolLiquidity.Seed(coins[i], price, -887220, 887220, 1 ether,
            i == 1 ? 100e6 : i == 3 ? 1e18 : i >= 4 ? 1_000_000e18 : 100e18, block.timestamp + 1 hours);
    }

    function _execute(TestPoolLiquidity.Seed memory s) private returns (uint128 liquidity) {
        SepoliaTestPools.UnsignedCall[3] memory calls = planner.plan(address(helper), s);
        assertEq(calls[0].to, s.coin);
        assertEq(calls[0].value, 0);
        assertEq(calls[0].data, abi.encodeWithSignature("approve(address,uint256)", address(helper), s.amount1Max));
        assertEq(calls[1].to, address(helper));
        assertEq(calls[1].value, s.amount0Max);
        assertEq(calls[1].data, abi.encodeCall(helper.seed, (s)));
        assertEq(calls[2].data, abi.encodeWithSignature("approve(address,uint256)", address(helper), 0));
        assertEq(calls[2].value, 0);
        for (uint256 j; j < 3; ++j) {
            (bool ok, bytes memory result) = calls[j].to.call{value: calls[j].value}(calls[j].data);
            require(ok, "unsigned call failed");
            if (j == 1) liquidity = abi.decode(result, (uint128));
        }
        assertEq(TestCoin(s.coin).allowance(address(this), address(helper)), 0);
        assertEq(address(helper).balance, 0);
    }

    function test_TA30_createAndSwapBothDirectionsInEveryPool() public {
        PriceLimitSwapper swapper = new PriceLimitSwapper(pm);
        for (uint256 i; i < 6; ++i) {
            TestPoolLiquidity.Seed memory s = _seed(i);
            uint128 liquidity = _execute(s);
            PoolKey memory key = helper.key(s.coin);
            assertEq(Currency.unwrap(key.currency0), address(0));
            assertEq(key.fee, 3000);
            assertEq(key.tickSpacing, 60);
            assertEq(address(key.hooks), address(0));
            assertEq(pm.getLiquidity(key.toId()), liquidity);
            uint256 before_ = TestCoin(s.coin).balanceOf(address(this));
            swapper.swap{value: 0.001 ether}(key, true, -int256(0.001 ether),
                BoxSwapBoundsV2.roomLimit(true, s.sqrtPriceX96, 49));
            uint256 bought = TestCoin(s.coin).balanceOf(address(this)) - before_;
            assertGt(bought, 0);
            (uint160 nowPrice,,,) = pm.getSlot0(key.toId());
            TestCoin(s.coin).approve(address(swapper), bought);
            swapper.swap(key, false, -int256(bought), BoxSwapBoundsV2.roomLimit(false, nowPrice, 49));
            assertEq(TestCoin(s.coin).balanceOf(address(this)), before_);
        }
    }

    function test_TA30_wideLiquidityRefundAndFounderRemoval() public {
        TestPoolLiquidity.Seed memory s = _seed(0);
        s.sqrtPriceX96 = uint160(1 << 96);
        s.tickLower = -600; s.tickUpper = 600;
        s.amount0Max = 2 ether; s.amount1Max = 1 ether; // Coin-limited; unused native budget must be refunded.
        uint256 before_ = TestCoin(s.coin).balanceOf(address(this));
        uint256 ethBefore = address(this).balance;
        uint128 liquidity = _execute(s);
        assertLe(before_ - TestCoin(s.coin).balanceOf(address(this)), s.amount1Max);
        assertLt(ethBefore - address(this).balance, s.amount0Max);
        assertGt(ethBefore - address(this).balance, 0.99 ether);
        vm.expectRevert(); helper.remove(s, liquidity, 3 ether, 0);
        assertEq(pm.getLiquidity(helper.key(s.coin).toId()), liquidity);
        helper.remove(s, liquidity, 0.99 ether, 0.99 ether);
        assertApproxEqAbs(TestCoin(s.coin).balanceOf(address(this)), before_, 2);
        assertApproxEqAbs(address(this).balance, ethBefore, 2);
        assertEq(pm.getLiquidity(helper.key(s.coin).toId()), 0);
    }

    function test_TA30_envEntryReturnsUnsignedCallsAndHelperDeployment() public {
        TestPoolLiquidity.Seed memory s = _seed(1);
        vm.setEnv("TEST_POOL_HELPER", vm.toString(address(helper)));
        vm.setEnv("TEST_POOL_COIN", vm.toString(s.coin));
        vm.setEnv("TEST_POOL_SQRT_PRICE_X96", vm.toString(uint256(s.sqrtPriceX96)));
        vm.setEnv("TEST_POOL_ETH_MAX", vm.toString(s.amount0Max));
        vm.setEnv("TEST_POOL_COIN_MAX", vm.toString(s.amount1Max));
        vm.setEnv("TEST_POOL_DEADLINE", vm.toString(s.deadline));
        vm.setEnv("TEST_POOL_TICK_LOWER", "-887220");
        vm.setEnv("TEST_POOL_TICK_UPPER", "887220");
        uint256 held = TestCoin(s.coin).balanceOf(address(this));
        SepoliaTestPools.UnsignedCall[3] memory calls = planner.run();
        assertEq(keccak256(abi.encode(calls)), keccak256(abi.encode(planner.plan(address(helper), s))));
        assertEq(TestCoin(s.coin).balanceOf(address(this)), held);
        assertEq(TestCoin(s.coin).allowance(address(this), address(helper)), 0);
        (uint160 price,,,) = pm.getSlot0(helper.key(s.coin).toId());
        assertEq(price, 0);
        vm.setEnv("TEST_POOL_SQRT_PRICE_X96", vm.toString(uint256(type(uint160).max) + 1));
        vm.expectRevert(); planner.run();
        vm.setEnv("TEST_POOL_SQRT_PRICE_X96", vm.toString(uint256(s.sqrtPriceX96)));
        vm.setEnv("TEST_POOL_TICK_LOWER", "-16777216");
        vm.expectRevert(); planner.run();
        // A local code copy exercises the script's pinned Sepolia destination without a fork or RPC.
        vm.etch(planner.SEPOLIA_MANAGER(), address(pm).code);
        TestPoolLiquidity deployed = TestPoolLiquidity(planner.deployHelper());
        assertEq(deployed.owner(), address(this));
        assertEq(address(deployed.manager()), planner.SEPOLIA_MANAGER());
        vm.chainId(1);
        vm.expectRevert(); planner.plan(address(helper), s);
        vm.expectRevert(); planner.deployHelper();
    }

    function test_TA30_limitsAndAtomicRollback() public {
        TestPoolLiquidity.Seed memory s = _seed(0);
        vm.prank(address(0xBAD)); vm.expectRevert(); helper.seed(s);
        vm.expectRevert(); helper.unlockCallback("");
        s.deadline = block.timestamp - 1;
        vm.expectRevert(); planner.plan(address(helper), s);
        s = _seed(0); s.tickLower = -59;
        vm.expectRevert(); planner.plan(address(helper), s);
        s = _seed(0); s.sqrtPriceX96 = TickMath.MIN_SQRT_PRICE;
        vm.expectRevert(); planner.plan(address(helper), s);
        s = _seed(0); s.tickLower = -60; s.tickUpper = 60; s.sqrtPriceX96 = TickMath.getSqrtPriceAtTick(40);
        vm.expectRevert(); planner.plan(address(helper), s); // aligned range but less than 49 ticks of room
        s = _seed(0); s.amount0Max = 0;
        vm.expectRevert(); planner.plan(address(helper), s);
        s = _seed(0);
        // No allowance: initialization must roll back together with the failed liquidity payment.
        vm.expectRevert(); helper.seed{value: s.amount0Max}(s);
        (uint160 price,,,) = pm.getSlot0(helper.key(s.coin).toId());
        assertEq(price, 0);
        _execute(s);
        TestCoin(s.coin).approve(address(helper), s.amount1Max);
        vm.expectRevert(); helper.seed{value: s.amount0Max}(s); // no silent adoption of an existing price
        vm.prank(address(0xBAD)); vm.expectRevert(); helper.remove(s, 1, 0, 0);
    }

    function test_TA30_alchemistTwoHopsWithin49TicksAndOversizeRollsBack() public {
        _execute(_seed(4)); _execute(_seed(3));
        AlchemistHopV21[] memory hops = new AlchemistHopV21[](2);
        hops[0] = AlchemistHopV21(4, coins[4], address(0), address(pm), 3000, 60);
        hops[1] = AlchemistHopV21(4, address(0), coins[3], address(pm), 3000, 60);
        AlchemistRouteDriver driver = new AlchemistRouteDriver(pm, hops, address(this), 1);
        PoolDriver funding = new PoolDriver(pm);
        TestCoin(coins[4]).transfer(address(funding), 1_000_000e18);
        funding.mintClaims(Currency.wrap(coins[4]), address(driver), 1_000_000e18);
        uint256 beforeGold = TestCoin(coins[3]).balanceOf(address(this));
        uint256 out = driver.execute(1000e18);
        assertGt(out, 0.00098 ether);
        assertEq(TestCoin(coins[3]).balanceOf(address(this)) - beforeGold, out);
        for (uint256 i; i < 2; ++i) {
            (uint160 price,,,) = pm.getSlot0(helper.key(i == 0 ? coins[4] : coins[3]).toId());
            uint160 start = _seed(i == 0 ? 4 : 3).sqrtPriceX96;
            assertGe(price, BoxSwapBoundsV2.roomLimit(true, start, 49));
            assertLe(price, BoxSwapBoundsV2.roomLimit(false, start, 49));
        }
        uint256 claims = pm.balanceOf(address(driver), uint160(coins[4]));
        (uint160 beforePrice,,,) = pm.getSlot0(helper.key(coins[4]).toId());
        vm.expectRevert(); driver.execute(10_000e18);
        assertEq(pm.balanceOf(address(driver), uint160(coins[4])), claims);
        (uint160 afterPrice,,,) = pm.getSlot0(helper.key(coins[4]).toId());
        assertEq(afterPrice, beforePrice);
    }

    receive() external payable {}
}
