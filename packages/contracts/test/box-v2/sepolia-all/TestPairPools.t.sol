// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {TestPairLiquidity} from "../../../src/test-coins/TestPairLiquidity.sol";
import {TestPoolLiquidity} from "../../../src/test-coins/TestPoolLiquidity.sol";
import {SepoliaTestPairPools} from "../../../script/sepolia-v2/SepoliaTestPairPools.s.sol";
import {TestCoin} from "../../../src/test-coins/TestCoins.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";

contract PairCoin is TestCoin {
    constructor(uint8 decimals_) TestCoin("Pair fixture", "PAIR", decimals_, msg.sender, 1e35) {}
}

contract InexactPairCoin is PairCoin {
    address public taxedRecipient;
    constructor() PairCoin(18) {}
    function tax(address recipient) external { taxedRecipient = recipient; }
    function _update(address from, address to, uint256 amount) internal override {
        if (to == taxedRecipient && amount > 0) {
            super._update(from, address(0), 1);
            --amount;
        }
        super._update(from, to, amount);
    }
}

contract TestPairPoolScriptTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    IPoolManager private pm;
    SepoliaTestPairPools private script;
    PairCoin private eth;
    PairCoin[6] private coins; // LINK, USDC, NVDA, GOLD, PEPE, FROG, as in TestPools.t.sol.

    function setUp() public {
        vm.chainId(31337);
        script = new SepoliaTestPairPools();
        deployCodeTo("PoolManager.sol:PoolManager", abi.encode(address(this)), script.SEPOLIA_MANAGER());
        pm = IPoolManager(script.SEPOLIA_MANAGER());
        eth = new PairCoin(18);
        string[6] memory names = ["TEST_LINK", "TEST_USDC", "TEST_NVDA", "TEST_GOLD", "TEST_PEPE", "TEST_FROG"];
        for (uint256 i; i < 6; ++i) {
            coins[i] = new PairCoin(i == 1 ? 6 : 18);
            vm.setEnv(names[i], vm.toString(address(coins[i])));
        }
        vm.setEnv("CORE_V2_DEPLOYER", vm.toString(address(this)));
        vm.setEnv("CORE_V2_BROADCAST", "false");
        vm.setEnv("TEST_POOL_DEADLINE", vm.toString(block.timestamp + 1 hours));
        vm.setEnv("TEST_POOL_TICK_LOWER", "-887220");
        vm.setEnv("TEST_POOL_TICK_UPPER", "887220");
    }

    function test_AP6_scriptSeedsExactlyFourPoolsAndClearsApprovals() public {
        uint256 before_ = eth.balanceOf(address(this));
        TestPairLiquidity helper = TestPairLiquidity(script.run(address(eth)));
        assertEq(helper.owner(), address(this));
        assertEq(address(helper.manager()), address(pm));
        assertApproxEqAbs(before_ - eth.balanceOf(address(this)), 3200e18, 3200e9);
        uint256[4] memory indices = [uint256(3), 1, 2, 4];
        uint256[4] memory amounts = [uint256(1000e18), 100_000e6, 100_000e18, 200_000_000e18];
        uint256[4] memory roots = [uint256(uint256(1) << 96), (uint256(1) << 96) / 100_000, (uint256(1) << 96) * 10, (uint256(1) << 96) * 1000];
        for (uint256 i; i < 4; ++i) {
            PairCoin coin = coins[indices[i]];
            PoolKey memory k = helper.key(address(eth), address(coin));
            (uint160 price,,,) = pm.getSlot0(k.toId());
            uint256 expected = address(eth) < address(coin) ? roots[i] : (uint256(1) << 192) / roots[i];
            // The inverse of a rounded root can differ by raw Q96 units, so assert in ticks.
            assertApproxEqAbs(int256(TickMath.getTickAtSqrtPrice(price)),
                int256(TickMath.getTickAtSqrtPrice(uint160(expected))), 1);
            assertApproxEqAbs(coin.balanceOf(address(pm)), amounts[i], amounts[i] / 1e9 + 1);
            assertGt(helper.liquidity(address(eth), address(coin)), 0);
            assertEq(coin.allowance(address(this), address(helper)), 0);
            assertEq(coin.allowance(address(helper), address(pm)), 0);
            assertEq(coin.balanceOf(address(helper)), 0);
        }
        assertEq(helper.liquidity(address(eth), address(coins[0])), 0);
        assertEq(helper.liquidity(address(eth), address(coins[5])), 0);
        assertEq(eth.allowance(address(this), address(helper)), 0);
        assertEq(eth.allowance(address(helper), address(pm)), 0);
        assertEq(eth.balanceOf(address(helper)), 0);
    }

    function test_AP7_cleanupRemovesOnlyFourOldPositions() public {
        TestPoolLiquidity old = new TestPoolLiquidity(pm, address(this));
        vm.setEnv("TEST_POOL_HELPER", vm.toString(address(old)));
        vm.deal(address(this), 10 ether);
        uint128[6] memory positions;
        for (uint256 i; i < 6; ++i) {
            uint160 price = uint160(i == 1 ? (uint256(1) << 96) / 100_000 : i == 3 ? (uint256(1) << 96)
                : i >= 4 ? (uint256(1) << 96) * 1000 : (uint256(1) << 96) * 10);
            uint256 amount = i == 1 ? 100e6 : i == 3 ? 1e18 : i >= 4 ? 1_000_000e18 : 100e18;
            coins[i].approve(address(old), amount);
            positions[i] = old.seed{value: 1 ether}(TestPoolLiquidity.Seed(
                address(coins[i]), price, -887220, 887220, 1 ether, amount, block.timestamp
            ));
            coins[i].approve(address(old), 0);
        }
        uint256 before_ = address(this).balance;
        uint256[4] memory minima;
        script.removeUnusedPools(minima, minima);
        assertApproxEqAbs(address(this).balance - before_, 4 ether, 1e9);
        for (uint256 i; i < 6; ++i) {
            (uint128 held,,) = pm.getPositionInfo(old.key(address(coins[i])).toId(),
                address(old), -887220, 887220, bytes32(0));
            assertEq(held, i == 3 || i == 4 ? positions[i] : 0);
            assertEq(coins[i].balanceOf(address(old)), 0);
            assertEq(coins[i].allowance(address(this), address(old)), 0);
            if (i != 3 && i != 4) assertApproxEqAbs(coins[i].balanceOf(address(this)), 1e35, 1);
        }
    }

    function test_AP8_scriptRejectsMainnetAndBadInputs() public {
        vm.chainId(1);
        vm.expectRevert("testnet only"); script.run(address(eth));
        uint256[4] memory minima;
        vm.expectRevert("testnet only"); script.removeUnusedPools(minima, minima);
        vm.chainId(31337);
        vm.expectRevert("decimals"); script.run(address(coins[1]));
        vm.setEnv("TEST_GOLD", vm.toString(address(eth)));
        vm.expectRevert("distinct coins"); script.run(address(eth));
    }

    receive() external payable {}
}

contract TestPairPoolsTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    IPoolManager private pm;
    TestPairLiquidity private helper;
    PoolSwapTest private swapper;
    uint256 private constant Q96 = 1 << 96;

    function setUp() public {
        vm.chainId(31337);
        pm = IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(address(this))));
        helper = new TestPairLiquidity(pm, address(this));
        swapper = new PoolSwapTest(pm);
    }

    // Force both address orders independently of CREATE nonces and token decimals.
    function _coins(uint8 decimals_, bool ethFirst) private returns (PairCoin eth, PairCoin coin) {
        PairCoin a = new PairCoin(18);
        PairCoin b = new PairCoin(decimals_);
        eth = PairCoin(ethFirst ? address(0x1000) : address(0x2000));
        coin = PairCoin(ethFirst ? address(0x2000) : address(0x1000));
        vm.etch(address(eth), address(a).code);
        vm.etch(address(coin), address(b).code);
        deal(address(eth), address(this), 1e35);
        deal(address(coin), address(this), 1e35);
    }

    function _seed(PairCoin a, PairCoin b, uint256 amountA, uint256 amountB) private returns (uint128) {
        a.approve(address(helper), amountA);
        b.approve(address(helper), amountB);
        uint128 liquidity = helper.seed(TestPairLiquidity.Seed(
            address(a), address(b), amountA, amountB, block.timestamp + 1 hours
        ));
        _empty(a, b);
        return liquidity;
    }

    function _empty(PairCoin a, PairCoin b) private view {
        assertEq(a.balanceOf(address(helper)), 0);
        assertEq(b.balanceOf(address(helper)), 0);
        assertEq(a.allowance(address(this), address(helper)), 0);
        assertEq(b.allowance(address(this), address(helper)), 0);
        assertEq(a.allowance(address(helper), address(pm)), 0);
        assertEq(b.allowance(address(helper), address(pm)), 0);
        assertEq(a.allowance(address(helper), address(this)), 0);
        assertEq(b.allowance(address(helper), address(this)), 0);
        assertEq(address(helper).balance, 0);
    }

    function _roundTrip(uint8 decimals_, bool ethFirst, uint256 ethAmount, uint256 coinAmount, uint160 expected)
        private
    {
        (PairCoin eth, PairCoin coin) = _coins(decimals_, ethFirst);
        uint256 beforeEth = eth.balanceOf(address(this));
        uint256 beforeCoin = coin.balanceOf(address(this));
        _checkPool(eth, coin, _seed(eth, coin, ethAmount, coinAmount), expected);
        uint256 paidEth = beforeEth - eth.balanceOf(address(this));
        uint256 paidCoin = beforeCoin - coin.balanceOf(address(this));
        assertEq(eth.balanceOf(address(pm)), paidEth);
        assertEq(coin.balanceOf(address(pm)), paidCoin);
        assertLe(paidEth, ethAmount);
        assertLe(paidCoin, coinAmount);
        // Full-range endpoints and integer liquidity leave less than one part in a billion unspent.
        assertApproxEqAbs(paidEth, ethAmount, ethAmount / 1e9 + 1);
        assertApproxEqAbs(paidCoin, coinAmount, coinAmount / 1e9 + 1);
        helper.remove(address(coin), address(eth), 0, 0, block.timestamp);
        assertEq(helper.liquidity(address(eth), address(coin)), 0);
        assertApproxEqAbs(eth.balanceOf(address(this)), beforeEth, 1);
        assertApproxEqAbs(coin.balanceOf(address(this)), beforeCoin, 1);
        _empty(eth, coin);
    }

    function _checkPool(PairCoin eth, PairCoin coin, uint128 liquidity, uint160 expected) private view {
        PoolKey memory k = helper.key(address(eth), address(coin));
        assertEq(Currency.unwrap(k.currency0), address(0x1000));
        assertEq(Currency.unwrap(k.currency1), address(0x2000));
        assertEq(k.fee, 3000);
        assertEq(k.tickSpacing, 60);
        assertEq(address(k.hooks), address(0));
        (uint160 price, int24 tick,,) = pm.getSlot0(k.toId());
        assertApproxEqAbs(int256(tick), int256(TickMath.getTickAtSqrtPrice(expected)), 1);
        assertApproxEqAbs(uint256(price), uint256(expected), 1);
        assertEq(pm.getLiquidity(k.toId()), liquidity);
        assertEq(pm.getLiquidity(k.toId()), helper.liquidity(address(coin), address(eth)));
    }

    function test_AP1_goldBothOrders() public {
        _roundTrip(18, true, 1000e18, 1000e18, uint160(Q96));
        _reset();
        _roundTrip(18, false, 1000e18, 1000e18, uint160(Q96));
    }

    function test_AP1_usdcBothOrders() public {
        _roundTrip(6, true, 1000e18, 100_000e6, uint160(Q96 / 100_000));
        _reset();
        _roundTrip(6, false, 1000e18, 100_000e6, uint160(Q96 * 100_000));
    }

    function test_AP1_nvdaBothOrders() public {
        _roundTrip(18, true, 1000e18, 100_000e18, uint160(Q96 * 10));
        _reset();
        _roundTrip(18, false, 1000e18, 100_000e18, uint160(Q96 / 10));
    }

    function test_AP1_pepeBothOrders() public {
        _roundTrip(18, true, 200e18, 200_000_000e18, uint160(Q96 * 1000));
        _reset();
        _roundTrip(18, false, 200e18, 200_000_000e18, uint160(Q96 / 1000));
    }

    function _reset() private {
        pm = IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(address(this))));
        helper = new TestPairLiquidity(pm, address(this));
        swapper = new PoolSwapTest(pm);
    }

    function testFuzz_AP2_swapsBothDirections(uint8 variant, bool ethFirst) public {
        variant = uint8(bound(variant, 0, 3));
        (PairCoin eth, PairCoin coin) = _coins(variant == 1 ? 6 : 18, ethFirst);
        uint256 amountEth = variant == 3 ? 200e18 : 1000e18;
        uint256 amountCoin = variant == 0 ? 1000e18 : variant == 1 ? 100_000e6
            : variant == 2 ? 100_000e18 : 200_000_000e18;
        uint256 originalEth = eth.balanceOf(address(this));
        uint256 originalCoin = coin.balanceOf(address(this));
        _seed(eth, coin, amountEth, amountCoin);
        PoolKey memory k = helper.key(address(eth), address(coin));
        _swaps(k, (ethFirst ? amountEth : amountCoin) / 1000);
        _empty(eth, coin);
        helper.remove(address(eth), address(coin), 0, 0, block.timestamp);
        _empty(eth, coin);
        // Trading fees are returned with the position; only pool rounding dust remains.
        assertApproxEqAbs(eth.balanceOf(address(this)), originalEth, 3);
        assertApproxEqAbs(coin.balanceOf(address(this)), originalCoin, 3);
    }

    function _swaps(PoolKey memory k, uint256 amount0) private {
        PairCoin coin0 = PairCoin(Currency.unwrap(k.currency0));
        PairCoin coin1 = PairCoin(Currency.unwrap(k.currency1));
        (uint160 start,,,) = pm.getSlot0(k.toId());
        uint256 before0 = coin0.balanceOf(address(this));
        uint256 before1 = coin1.balanceOf(address(this));
        coin0.approve(address(swapper), amount0);
        BalanceDelta delta = swapper.swap(k, SwapParams(true, -int256(amount0), TickMath.MIN_SQRT_PRICE + 1),
            PoolSwapTest.TestSettings(false, false), "");
        assertEq(int256(delta.amount0()), -int256(amount0));
        assertGt(delta.amount1(), 0);
        assertEq(coin0.balanceOf(address(this)), before0 - amount0);
        uint256 bought = coin1.balanceOf(address(this)) - before1;
        assertEq(bought, uint128(delta.amount1()));
        (uint160 down,,,) = pm.getSlot0(k.toId());
        assertLt(down, start);
        _empty(coin0, coin1);
        coin1.approve(address(swapper), bought);
        delta = swapper.swap(k, SwapParams(false, -int256(bought), TickMath.MAX_SQRT_PRICE - 1),
            PoolSwapTest.TestSettings(false, false), "");
        assertEq(int256(delta.amount1()), -int256(bought));
        assertGt(delta.amount0(), 0);
        (uint160 up,,,) = pm.getSlot0(k.toId());
        assertGt(up, down);
        assertEq(coin1.balanceOf(address(this)), before1);
        assertEq(coin0.allowance(address(this), address(swapper)), 0);
        assertEq(coin1.allowance(address(this), address(swapper)), 0);
    }

    function test_AP3_ownerOnlyAndCallbackGuard() public {
        (PairCoin a, PairCoin b) = _coins(18, true);
        TestPairLiquidity.Seed memory s = TestPairLiquidity.Seed(address(a), address(b), 1e18, 1e18, block.timestamp);
        vm.prank(address(0xBAD)); vm.expectRevert("owner"); helper.seed(s);
        _seed(a, b, 1e18, 1e18);
        uint128 before_ = helper.liquidity(address(a), address(b));
        vm.prank(address(0xBAD)); vm.expectRevert("owner");
        helper.remove(address(a), address(b), 0, 0, block.timestamp);
        vm.expectRevert("callback"); helper.unlockCallback("");
        vm.prank(address(pm)); vm.expectRevert("callback"); helper.unlockCallback("");
        assertEq(helper.liquidity(address(a), address(b)), before_);
        _empty(a, b);
        helper.remove(address(a), address(b), 0, 0, block.timestamp);
        _empty(a, b);
    }

    function test_AP4_existingPoolTopUpAndRefund() public {
        (PairCoin a, PairCoin b) = _coins(6, true);
        PoolKey memory k = helper.key(address(a), address(b));
        pm.initialize(k, uint160(Q96 / 100_000));
        uint128 first = _seed(a, b, 1000e18, 100_000e6);
        uint256 beforeA = a.balanceOf(address(this));
        uint128 second = _seed(b, a, 100_000e6, 1000e18);
        assertEq(helper.liquidity(address(a), address(b)), first + second);
        assertGt(a.balanceOf(address(this)), beforeA - 1000e18);
        helper.remove(address(a), address(b), 0, 0, block.timestamp);
        _empty(a, b);
    }

    function test_AP4_topUpCollectsFeesWithoutLeavingCoins() public {
        (PairCoin a, PairCoin b) = _coins(18, true);
        _seed(a, b, 1000e18, 1000e18);
        PoolKey memory k = helper.key(address(a), address(b));
        _swaps(k, 1e18);
        uint256 beforeA = a.balanceOf(address(this));
        uint256 beforeB = b.balanceOf(address(this));
        // The tiny addition costs less than the fees earned; both deltas can credit the owner.
        _seed(a, b, a.balanceOf(address(pm)) / 1e12, b.balanceOf(address(pm)) / 1e12);
        assertGt(a.balanceOf(address(this)), beforeA);
        assertGt(b.balanceOf(address(this)), beforeB);
        helper.remove(address(a), address(b), 0, 0, block.timestamp);
        _empty(a, b);
        assertApproxEqAbs(a.balanceOf(address(this)), 1e35, 3);
        assertApproxEqAbs(b.balanceOf(address(this)), 1e35, 3);
    }

    function test_AP5_revertsRestoreFundsAndPool() public {
        (PairCoin a, PairCoin b) = _coins(18, true);
        TestPairLiquidity.Seed memory s = TestPairLiquidity.Seed(address(a), address(b), 1e18, 1e18, block.timestamp);
        a.approve(address(helper), 1e18);
        b.approve(address(helper), 1e18 - 1);
        vm.expectRevert("exact approval"); helper.seed(s);
        assertEq(a.balanceOf(address(helper)), 0);
        (uint160 price,,,) = pm.getSlot0(helper.key(address(a), address(b)).toId());
        assertEq(price, 0);
        assertEq(a.allowance(address(this), address(helper)), 1e18);
        b.approve(address(helper), type(uint256).max);
        vm.expectRevert("exact approval"); helper.seed(s);
        a.approve(address(helper), 0); b.approve(address(helper), 0);
        _empty(a, b);
        _seed(a, b, 1e18, 1e18);
        vm.expectRevert("withdrawal minimum"); helper.remove(address(a), address(b), 2e18, 0, block.timestamp);
        assertGt(helper.liquidity(address(a), address(b)), 0);
        vm.warp(block.timestamp + 1);
        vm.expectRevert("deadline"); helper.seed(s);
        vm.expectRevert("deadline"); helper.remove(address(a), address(b), 0, 0, block.timestamp - 1);
        _empty(a, b);
        helper.remove(address(a), address(b), 0, 0, block.timestamp);
        vm.expectRevert("no liquidity"); helper.remove(address(a), address(b), 0, 0, block.timestamp);
        _empty(a, b);
    }

    function testFuzz_AP1_nonSquareRatios(uint256 amount0, uint256 amount1) public {
        amount0 = bound(amount0, 1e6, 1e24);
        amount1 = bound(amount1, 1e6, 1e24);
        (PairCoin a, PairCoin b) = _coins(18, true);
        _seed(a, b, amount0, amount1);
        (, int24 tick,,) = pm.getSlot0(helper.key(address(a), address(b)).toId());
        uint256 lo = TickMath.getSqrtPriceAtTick(tick);
        uint256 hi = TickMath.getSqrtPriceAtTick(tick + 1);
        // Independent rational comparison against the enclosing tick prices; these bounds keep squares in uint256.
        assertLe(FullMath.mulDiv(lo * lo, amount0, uint256(1) << 192), amount1);
        assertGe(FullMath.mulDivRoundingUp(hi * hi, amount0, uint256(1) << 192), amount1);
        helper.remove(address(a), address(b), 0, 0, block.timestamp);
        _empty(a, b);
        assertApproxEqAbs(a.balanceOf(address(this)), 1e35, 1);
        assertApproxEqAbs(b.balanceOf(address(this)), 1e35, 1);
    }

    function test_AP1_largeRatioUsesWidePrice() public {
        (PairCoin a, PairCoin b) = _coins(18, true);
        _seed(a, b, 1e6, 1e30);
        (, int24 tick,,) = pm.getSlot0(helper.key(address(a), address(b)).toId());
        assertApproxEqAbs(int256(tick), int256(TickMath.getTickAtSqrtPrice(uint160(Q96 * 1e12))), 1);
        helper.remove(address(a), address(b), 0, 0, block.timestamp);
        _empty(a, b);
        _reset();
        _seed(a, b, 1e30, 1e6);
        (, tick,,) = pm.getSlot0(helper.key(address(a), address(b)).toId());
        assertApproxEqAbs(int256(tick), int256(TickMath.getTickAtSqrtPrice(uint160(Q96 / 1e12))), 1);
        helper.remove(address(a), address(b), 0, 0, block.timestamp);
        _empty(a, b);
    }

    function test_AP5_wrongExistingPriceAndInvalidInputs() public {
        (PairCoin a, PairCoin b) = _coins(18, true);
        TestPairLiquidity.Seed memory s = TestPairLiquidity.Seed(address(a), address(b), 1e18, 1e18, block.timestamp);
        PoolKey memory k = helper.key(address(a), address(b));
        pm.initialize(k, uint160(Q96 * 2));
        vm.expectRevert("pool price"); helper.seed(s);
        assertEq(helper.liquidity(address(a), address(b)), 0);
        _empty(a, b);
        s.amountA = 0;
        vm.expectRevert("budgets"); helper.seed(s);
        s.amountA = uint256(type(int256).max);
        vm.expectRevert("budgets"); helper.seed(s);
        s.amountA = 1e18; s.coinB = s.coinA;
        vm.expectRevert("coins"); helper.seed(s);
        s.coinB = address(0);
        vm.expectRevert("coin code"); helper.seed(s);
        vm.expectRevert("manager and owner"); new TestPairLiquidity(pm, address(0));
        vm.expectRevert("manager and owner"); new TestPairLiquidity(IPoolManager(address(0)), address(this));
        vm.chainId(1);
        vm.expectRevert("testnet only"); new TestPairLiquidity(pm, address(this));
        vm.chainId(11_155_111);
        vm.expectRevert("Sepolia manager"); new TestPairLiquidity(pm, address(this));
    }

    function test_AP5_inexactPullOrSettlementRollsBack() public {
        PairCoin a = new PairCoin(18);
        InexactPairCoin b = new InexactPairCoin();
        TestPairLiquidity.Seed memory s = TestPairLiquidity.Seed(address(a), address(b), 1e18, 1e18, block.timestamp);
        a.approve(address(helper), 1e18); b.approve(address(helper), 1e18);
        b.tax(address(helper));
        vm.expectRevert("inexact coin"); helper.seed(s);
        b.tax(address(pm));
        vm.expectRevert("inexact coin"); helper.seed(s);
        (uint160 price,,,) = pm.getSlot0(helper.key(address(a), address(b)).toId());
        assertEq(price, 0);
        assertEq(a.balanceOf(address(this)), 1e35);
        assertEq(b.balanceOf(address(this)), 1e35);
        assertEq(a.balanceOf(address(pm)), 0);
        assertEq(b.balanceOf(address(pm)), 0);
        a.approve(address(helper), 0); b.approve(address(helper), 0);
        _empty(a, b);
    }
}
