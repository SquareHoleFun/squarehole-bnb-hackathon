// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {TransientStateLibrary} from "v4-core/src/libraries/TransientStateLibrary.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {FitTokenBase} from "../../../src/v2/FitTokenBase.sol";
import {settleOwed} from "../../v2/utils/NativeV4Callers.sol";

/// @notice RESEARCH ONLY: FIT's own token code (`FitTokenBase`, the same transfer path and gas as `FitToken`) with a
/// larger one-time issuance, so one fork can seed a curve and a migration for every hook variant side by side.
contract HookGasFit is FitTokenBase {
    constructor(uint256 issuance, address recipient, address vault_) FitTokenBase(issuance, recipient, vault_) {}
}

/// @notice RESEARCH ONLY: a swap through the PoolManager directly with an explicit price limit (the local stand-in for
/// the Universal Router, and the way the suites fill a curve to a chosen point). Native ETH from msg.value (the rest
/// refunded), the token pulled from the caller (approved), outputs taken to the caller.
contract PriceLimitSwapper is IUnlockCallback {
    using TransientStateLibrary for IPoolManager;

    IPoolManager public immutable pm;
    address private _user;

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    /// @param amountSpecified < 0: exact input; > 0: exact output. @param limit 0: the extreme price.
    function swap(PoolKey calldata key, bool zeroForOne, int256 amountSpecified, uint160 limit)
        external
        payable
        returns (BalanceDelta delta)
    {
        _user = msg.sender;
        if (limit == 0) limit = zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1;
        delta = abi.decode(pm.unlock(abi.encode(key, zeroForOne, amountSpecified, limit)), (BalanceDelta));
        _user = address(0);
        uint256 rest = address(this).balance;
        if (rest != 0) {
            (bool ok,) = msg.sender.call{value: rest}("");
            require(ok, "refund");
        }
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "only pm");
        (PoolKey memory key, bool zeroForOne, int256 amountSpecified, uint160 limit) =
            abi.decode(data, (PoolKey, bool, int256, uint160));
        BalanceDelta delta = pm.swap(key, SwapParams(zeroForOne, amountSpecified, limit), "");
        _resolve(key.currency0);
        _resolve(key.currency1);
        return abi.encode(delta);
    }

    function _resolve(Currency c) private {
        int256 d = pm.currencyDelta(address(this), c);
        if (d < 0) settleOwed(pm, c, _user, uint256(-d));
        else if (d > 0) pm.take(c, _user, uint256(d));
    }

    receive() external payable {}
}

/// @notice RESEARCH ONLY: the buy-then-sell round trip of finding (d) in ONE PoolManager unlock (flash accounting: no
/// capital, only the net loss is paid): buy exactly to √P1 (all FIT left on the curve), then sell all of it back. On a
/// hook that migrates inside the completing swap, the sell lands in the freshly seeded pool.
contract RoundTripper is IUnlockCallback {
    using TransientStateLibrary for IPoolManager;

    IPoolManager public immutable pm;

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    /// @return ethPaid the net ETH the round trip cost (paid from msg.value, the rest refunded)
    /// @return fitBought the FIT the buy took and the sell gave back
    function run(PoolKey calldata key, uint160 buyLimit, uint256 maxEthIn)
        external
        payable
        returns (uint256 ethPaid, uint256 fitBought)
    {
        (ethPaid, fitBought) = abi.decode(pm.unlock(abi.encode(key, buyLimit, maxEthIn)), (uint256, uint256));
        uint256 rest = address(this).balance;
        if (rest != 0) {
            (bool ok,) = msg.sender.call{value: rest}("");
            require(ok, "refund");
        }
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "only pm");
        (PoolKey memory key, uint160 buyLimit, uint256 maxEthIn) = abi.decode(data, (PoolKey, uint160, uint256));
        // forge-lint: disable-next-line(unsafe-typecast)
        BalanceDelta b = pm.swap(key, SwapParams(true, -int256(maxEthIn), buyLimit), "");
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 fitBought = uint256(uint128(b.amount1()));
        // forge-lint: disable-next-line(unsafe-typecast)
        pm.swap(key, SwapParams(false, -int256(fitBought), TickMath.MAX_SQRT_PRICE - 1), "");
        int256 eth = pm.currencyDelta(address(this), key.currency0);
        require(pm.currencyDelta(address(this), key.currency1) == 0, "fit left");
        uint256 ethPaid;
        if (eth < 0) {
            ethPaid = uint256(-eth);
            pm.settle{value: ethPaid}();
        } else if (eth > 0) {
            pm.take(key.currency0, address(this), uint256(eth));
        }
        return abi.encode(ethPaid, fitBought);
    }

    receive() external payable {}
}
