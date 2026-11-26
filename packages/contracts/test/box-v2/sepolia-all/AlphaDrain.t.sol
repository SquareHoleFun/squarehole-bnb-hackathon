// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {AlphaRehearsalSetup} from "../../../script/local/AlphaRehearsalSetup.s.sol";
import {TestETH} from "../../../src/test-coins/TestETH.sol";
import {IERC20} from "v4-core/lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";

contract AlphaDrainSetup is AlphaRehearsalSetup {
    function seed(address manager, address owner) external returns (Assets memory a) {
        a = _assets(manager, owner); _pools(a, owner);
    }
}

/// Exact v4 execution at the recorded depth. This measures attainable extraction, not an optimized upper bound.
contract AlphaDrainTest is Test {
    address private constant OWNER = address(0xA11FA);
    address private constant TESTER = address(0xDDA1);
    AlphaRehearsalSetup.Assets private a;
    PoolSwapTest private swapper;

    function setUp() public {
        vm.chainId(31337); vm.warp(1_790_000_000); vm.deal(OWNER, 100 ether);
        IPoolManager manager = IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(OWNER)));
        swapper = new PoolSwapTest(manager);
        a = new AlphaDrainSetup().seed(address(manager), OWNER);
        assertEq(TestETH(a.teth).DAILY_CAP(), 500 ether);
        assertEq(TestETH(a.teth).DRIP_AMOUNT(), 1 ether);
    }
    function test_oneAdmittedTesterDailyBudget() public { _drain(1 ether, 0.66 ether); }
    function test_aggregateGlobalDailyBudget() public { _drain(500 ether, 1.98 ether); }

    function _drain(uint256 budget, uint256 lowerBound) private {
        vm.prank(OWNER); IERC20(a.teth).transfer(TESTER, budget);
        // Funding models transferred, already-dripped balances; it is not a faucet bypass.
        vm.startPrank(TESTER);
        uint256 gold = _swap(a.teth, a.gold, budget / 2);
        uint256 nativeGold = _swap(a.gold, address(0), gold);
        uint256 pepe = _swap(a.teth, a.pepe, budget / 2);
        uint256 nativePepe = _swap(a.pepe, address(0), pepe);
        vm.stopPrank();
        uint256 got = nativeGold + nativePepe;
        assertEq(TESTER.balance, got);
        assertGt(got, lowerBound); assertLt(got, 2 ether);
        assertEq(IERC20(a.teth).balanceOf(TESTER), 0);
        assertEq(IERC20(a.gold).balanceOf(TESTER), 0);
        assertEq(IERC20(a.pepe).balanceOf(TESTER), 0);
        assertEq(address(swapper).balance, 0);
        emit log_string(string.concat("ALPHA_DRAIN|", vm.toString(budget), "|", vm.toString(got)));
        emit log_named_uint("GOLD route native", nativeGold);
        emit log_named_uint("PEPE route native", nativePepe);
    }
    function _swap(address input, address output, uint256 amount) private returns (uint256 got) {
        bool buy = input < output;
        PoolKey memory key = PoolKey(Currency.wrap(buy ? input : output), Currency.wrap(buy ? output : input), 3000, 60, IHooks(address(0)));
        IERC20(input).approve(address(swapper), amount);
        BalanceDelta delta = swapper.swap{gas: 4_000_000}(key,
            SwapParams(buy, -int256(amount), buy ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1),
            PoolSwapTest.TestSettings(false, false), "");
        assertEq(uint256(-int256(buy ? delta.amount0() : delta.amount1())), amount, "whole input spent");
        got = uint256(int256(buy ? delta.amount1() : delta.amount0()));
        assertEq(IERC20(input).allowance(TESTER, address(swapper)), 0);
        IERC20(input).approve(address(swapper), 0);
    }
}
