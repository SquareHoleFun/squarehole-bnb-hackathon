// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "solmate/src/tokens/ERC20.sol";
import {PoolManager} from "v4-core/src/PoolManager.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "v4-core/src/test/PoolModifyLiquidityTest.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";

contract TestToken is ERC20 {
    constructor() ERC20("Fixture token", "T", 18) { _mint(msg.sender, 100 ether); }
}

/// The actual pinned v4 manager/router, on a synthetic local pool. No fork, RPC, signer or deployed-box claim.
contract PoolMinimumTest is Test {
    PoolSwapTest private router;
    PoolKey private key;
    TestToken private token;

    function setUp() public {
        vm.deal(address(this), 100 ether);
        PoolManager manager = new PoolManager(address(this));
        router = new PoolSwapTest(manager);
        PoolModifyLiquidityTest liquidity = new PoolModifyLiquidityTest(manager);
        token = new TestToken();
        key = PoolKey(Currency.wrap(address(0)), Currency.wrap(address(token)), 10000, 60, IHooks(address(0)));
        manager.initialize(key, uint160(1 << 96));
        token.approve(address(liquidity), 100 ether);
        liquidity.modifyLiquidity{value: 1 ether}(key, ModifyLiquidityParams(-60, 60, 1 ether, bytes32(0)), "");
    }

    function testExactInputPriceLimitCanSucceedBelowRequestedMinimum() public {
        uint256 beforeT = token.balanceOf(address(this));
        BalanceDelta delta = router.swap{value: 1 ether}(
            key, SwapParams(true, -1 ether, TickMath.getSqrtPriceAtTick(-1)),
            PoolSwapTest.TestSettings(false, false), ""
        );
        uint256 received = token.balanceOf(address(this)) - beforeT;
        assertGt(received, 0);
        assertLt(received, 0.1 ether, "price limit is not a total output floor");
        assertEq(int256(delta.amount1()), int256(received));
        assertGt(int256(delta.amount0()), -1 ether, "partial input is refunded");
    }

    function testExactOutputAlsoAllowsPartialFill() public {
        uint256 beforeT = token.balanceOf(address(this));
        router.swap{value: 1 ether}(
            key, SwapParams(true, 0.1 ether, TickMath.getSqrtPriceAtTick(-1)),
            PoolSwapTest.TestSettings(false, false), ""
        );
        uint256 received = token.balanceOf(address(this)) - beforeT;
        assertGt(received, 0);
        assertLt(received, 0.1 ether, "positive amountSpecified does not guarantee that output");
    }

    receive() external payable {}
}
