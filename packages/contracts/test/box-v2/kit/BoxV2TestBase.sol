// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IERC20Minimal} from "v4-core/src/interfaces/external/IERC20Minimal.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {SwapParams, ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {HostileToken} from "./HostileToken.sol";
import {MockBox, MockBoxHookV2} from "./mocks/MockBox.sol";
import {MockBoxReceiverV2} from "./mocks/MockBoxReceiverV2.sol";
import {MockListingRegistry} from "./mocks/MockListingRegistry.sol";

contract PoolDriver is IUnlockCallback {
    IPoolManager public immutable pm;

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    receive() external payable {}

    function modify(PoolKey memory key, int24 lower, int24 upper, int256 liquidity) external {
        pm.unlock(abi.encode(uint8(1), abi.encode(key, lower, upper, liquidity)));
    }

    /// @return inA the input paid; outA the output taken.
    function swap(PoolKey memory key, bool zeroForOne, uint256 amountIn, uint160 limit)
        external
        returns (uint256 inA, uint256 outA)
    {
        if (amountIn == 0) return (0, 0);
        // forge-lint: disable-next-line(unsafe-typecast)
        SwapParams memory p = SwapParams(zeroForOne, -int256(amountIn), limit);
        BalanceDelta d = abi.decode(pm.unlock(abi.encode(uint8(2), abi.encode(key, p))), (BalanceDelta));
        (int128 a0, int128 a1) = (d.amount0(), d.amount1());
        // forge-lint: disable-start(unsafe-typecast)
        if (zeroForOne) (inA, outA) = (uint256(uint128(-a0)), uint256(uint128(a1)));
        else (inA, outA) = (uint256(uint128(-a1)), uint256(uint128(a0)));
        // forge-lint: disable-end(unsafe-typecast)
    }

    /// Mints `amount` of `c`'s ERC-6909 claims to `to`, paying it from this driver's ETH or tokens (the kit's claims
    /// faucet: deposits and intakes move claims, never tokens).
    function mintClaims(Currency c, address to, uint256 amount) external {
        pm.unlock(abi.encode(uint8(3), abi.encode(c, to, amount)));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "only pm");
        (uint8 action, bytes memory args) = abi.decode(data, (uint8, bytes));
        if (action == 3) {
            (Currency c, address to, uint256 amount) = abi.decode(args, (Currency, address, uint256));
            pm.mint(to, c.toId(), amount);
            // forge-lint: disable-next-line(unsafe-typecast)
            _settle(c, -int128(int256(amount)));
            return "";
        }
        PoolKey memory key;
        BalanceDelta delta;
        if (action == 1) {
            int24 lo;
            int24 hi;
            int256 liq;
            (key, lo, hi, liq) = abi.decode(args, (PoolKey, int24, int24, int256));
            (delta,) = pm.modifyLiquidity(key, ModifyLiquidityParams(lo, hi, liq, 0), "");
        } else {
            SwapParams memory p;
            (key, p) = abi.decode(args, (PoolKey, SwapParams));
            delta = pm.swap(key, p, "");
        }
        _settle(key.currency0, delta.amount0());
        _settle(key.currency1, delta.amount1());
        return abi.encode(delta);
    }

    function _settle(Currency c, int128 amount) private {
        // forge-lint: disable-start(unsafe-typecast)
        if (amount > 0) {
            pm.take(c, address(this), uint256(uint128(amount)));
        } else if (amount < 0) {
            uint256 owed = uint256(uint128(-amount));
            if (c.isAddressZero()) {
                pm.settle{value: owed}();
            } else {
                pm.sync(c);
                require(IERC20Minimal(Currency.unwrap(c)).transfer(address(pm), owed), "transfer");
                pm.settle();
            }
        }
        // forge-lint: disable-end(unsafe-typecast)
    }
}

/// @notice Minimal CQ11 kit; no route/converter/closing-range dependencies. M1-03 extends this in lane 2.
abstract contract BoxV2TestBase is Test {
    HostileToken internal p;
    HostileToken internal t;
    MockBoxHookV2 internal hook;
    MockBox internal box;
    MockBoxReceiverV2 internal receiver;
    MockListingRegistry internal listings;
    address internal alice=address(101);
    address internal fitSafe=address(102);
    function setUp() public virtual {
        p=new HostileToken("Price","P",18);
        t=new HostileToken("Box","T",18);
        hook=new MockBoxHookV2(p);
        box=new MockBox(p,t,hook,fitSafe);
        receiver=new MockBoxReceiverV2(hook,fitSafe,address(103),address(104));
        hook.wire(address(box),address(receiver));
        listings=new MockListingRegistry();
    }
}
