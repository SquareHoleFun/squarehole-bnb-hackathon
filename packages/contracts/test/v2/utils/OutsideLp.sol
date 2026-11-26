// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {TransientStateLibrary} from "v4-core/src/libraries/TransientStateLibrary.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {settleOwed} from "./NativeV4Callers.sol";

/// @notice TEST-ONLY: an outside liquidity provider talking to the PoolManager directly (the position owner is this
/// contract; the salt tells positions apart). Pays native ETH from msg.value (the rest refunded) and the token from
/// the caller, and takes every positive delta (principal and fees) to the caller. `jit` runs add, a buy and a second
/// step (remove, or a 1-wei add to collect) in ONE unlock: the same-block JIT bundles of LIQ-05.
contract OutsideLp is IUnlockCallback {
    using TransientStateLibrary for IPoolManager;

    IPoolManager public immutable pm;
    address private _payer;

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    /// @notice One `modifyLiquidity` (add > 0, remove < 0, fee poke = 0) in its own unlock.
    function modify(PoolKey calldata key, int24 lower, int24 upper, int256 delta, bytes32 salt)
        external
        payable
        returns (BalanceDelta callerDelta, BalanceDelta fees)
    {
        _payer = msg.sender;
        (callerDelta, fees) = abi.decode(
            pm.unlock(abi.encode(uint8(0), key, lower, upper, delta, salt, uint256(0), int256(0))),
            (BalanceDelta, BalanceDelta)
        );
        _refund();
    }

    /// @notice Add `delta`, buy with `buyEth`, then `second` (a negative delta: remove; positive: a further add) on the
    /// same position, all in one unlock.
    function jit(
        PoolKey calldata key,
        int24 lower,
        int24 upper,
        int256 delta,
        bytes32 salt,
        uint256 buyEth,
        int256 second
    ) external payable {
        _payer = msg.sender;
        pm.unlock(abi.encode(uint8(1), key, lower, upper, delta, salt, buyEth, second));
        _refund();
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "only pm");
        (
            uint8 kind,
            PoolKey memory key,
            int24 lower,
            int24 upper,
            int256 delta,
            bytes32 salt,
            uint256 buyEth,
            int256 second
        ) = abi.decode(data, (uint8, PoolKey, int24, int24, int256, bytes32, uint256, int256));
        (BalanceDelta callerDelta, BalanceDelta fees) =
            pm.modifyLiquidity(key, ModifyLiquidityParams(lower, upper, delta, salt), "");
        if (kind == 1) {
            // casting to 'int256' is safe for test amounts
            // forge-lint: disable-next-line(unsafe-typecast)
            pm.swap(key, SwapParams(true, -int256(buyEth), TickMath.MIN_SQRT_PRICE + 1), "");
            pm.modifyLiquidity(key, ModifyLiquidityParams(lower, upper, second, salt), "");
        }
        _resolve(key.currency0);
        _resolve(key.currency1);
        return abi.encode(callerDelta, fees);
    }

    function _resolve(Currency c) private {
        int256 d = pm.currencyDelta(address(this), c);
        if (d < 0) settleOwed(pm, c, _payer, uint256(-d));
        else if (d > 0) pm.take(c, _payer, uint256(d));
    }

    function _refund() private {
        _payer = address(0);
        uint256 rest = address(this).balance;
        if (rest != 0) {
            (bool ok,) = msg.sender.call{value: rest}("");
            require(ok, "refund");
        }
    }

    receive() external payable {}
}
