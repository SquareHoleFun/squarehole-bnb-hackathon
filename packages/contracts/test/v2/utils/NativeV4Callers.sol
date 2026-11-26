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

/// @dev `transferFrom` that accepts no return data or `true`.
function pullErc20(address token, address from, address to, uint256 amount) {
    (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0x23b872dd, from, to, amount));
    require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "transferFrom failed");
}

/// @dev Pays whatever this contract owes the PoolManager in `currency`: native ETH from its own balance (msg.value),
/// an ERC-20 pulled from `payer` (who approved this contract).
function settleOwed(IPoolManager pm, Currency currency, address payer, uint256 amount) {
    if (amount == 0) return;
    if (currency.isAddressZero()) {
        pm.settle{value: amount}();
    } else {
        pm.sync(currency);
        pullErc20(Currency.unwrap(currency), payer, address(pm), amount);
        pm.settle();
    }
}

/// @notice TEST-ONLY: swaps "through the PoolManager directly" (its own unlock, no router, no Permit2). Native ETH is
/// paid with msg.value (the unused rest is refunded) and native ETH output is `take`n straight to the user.
contract DirectSwapper is IUnlockCallback {
    using TransientStateLibrary for IPoolManager;

    IPoolManager public immutable pm;
    address private _user;

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    /// @param amountSpecified < 0: exact input; > 0: exact output (v4 convention).
    function swap(PoolKey calldata key, bool zeroForOne, int256 amountSpecified)
        external
        payable
        returns (BalanceDelta delta)
    {
        _user = msg.sender;
        delta = abi.decode(pm.unlock(abi.encode(key, zeroForOne, amountSpecified)), (BalanceDelta));
        _user = address(0);
        uint256 rest = address(this).balance;
        if (rest != 0) {
            (bool ok,) = msg.sender.call{value: rest}("");
            require(ok, "refund");
        }
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "only pm");
        (PoolKey memory key, bool zeroForOne, int256 amountSpecified) = abi.decode(data, (PoolKey, bool, int256));
        uint160 limit = zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1;
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

/// @notice TEST-ONLY: a capital-free arbitrage inside ONE PoolManager unlock (flash accounting): buy FIT with `ethIn`
/// in `buyPool` (exact in), sell all of that FIT in `sellPool` (exact in), keep the ETH difference. Nothing is
/// transferred except the profit, taken to the owner at the end; the ETH input is never paid in, it nets out.
contract FlashArbitrageur is IUnlockCallback {
    using TransientStateLibrary for IPoolManager;

    error NoProfit(int256 ethDelta);

    IPoolManager public immutable pm;
    address public immutable owner;

    constructor(IPoolManager pm_, address owner_) {
        pm = pm_;
        owner = owner_;
    }

    /// @return profit ETH taken to the owner. @return fitMoved FIT bought in `buyPool` and sold in `sellPool`.
    function arb(PoolKey calldata buyPool, PoolKey calldata sellPool, uint256 ethIn)
        external
        returns (uint256 profit, uint256 fitMoved)
    {
        (profit, fitMoved) = abi.decode(pm.unlock(abi.encode(buyPool, sellPool, ethIn)), (uint256, uint256));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "only pm");
        (PoolKey memory buyPool, PoolKey memory sellPool, uint256 ethIn) = abi.decode(data, (PoolKey, PoolKey, uint256));
        // Both pools are ETH (currency0) / FIT (currency1): buying FIT is zeroForOne.
        BalanceDelta d1 = pm.swap(buyPool, SwapParams(true, -int256(ethIn), TickMath.MIN_SQRT_PRICE + 1), "");
        uint256 fitMoved = uint256(uint128(d1.amount1()));
        pm.swap(sellPool, SwapParams(false, -int256(fitMoved), TickMath.MAX_SQRT_PRICE - 1), "");
        int256 eth = pm.currencyDelta(address(this), Currency.wrap(address(0)));
        int256 fitLeft = pm.currencyDelta(address(this), buyPool.currency1);
        require(fitLeft == 0, "fit delta");
        if (eth <= 0) revert NoProfit(eth);
        pm.take(Currency.wrap(address(0)), owner, uint256(eth));
        return abi.encode(uint256(eth), fitMoved);
    }
}

/// @notice TEST-ONLY: moves FIT through the PoolManager as ERC-6909 claims (deposit = settle FIT and mint claims to
/// the caller; withdraw = burn the caller's claims and take FIT). The internal-claims path of MKT-03.
contract ClaimsGateway is IUnlockCallback {
    IPoolManager public immutable pm;

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    function deposit(address token, uint256 amount) external {
        pm.unlock(abi.encode(true, token, msg.sender, amount));
    }

    /// @dev The caller must have made this gateway its ERC-6909 operator (`pm.setOperator`).
    function withdraw(address token, uint256 amount) external {
        pm.unlock(abi.encode(false, token, msg.sender, amount));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "only pm");
        (bool isDeposit, address token, address user, uint256 amount) =
            abi.decode(data, (bool, address, address, uint256));
        uint256 id = uint256(uint160(token));
        if (isDeposit) {
            settleOwed(pm, Currency.wrap(token), user, amount);
            pm.mint(user, id, amount);
        } else {
            pm.burn(user, id, amount);
            pm.take(Currency.wrap(token), user, amount);
        }
        return "";
    }
}

/// @notice TEST-ONLY: adds (or tries to add) liquidity to any pool from its own unlock, paying native ETH from
/// msg.value (rest refunded) and the ERC-20 side from the caller. Used to seed a plain third-party pool locally and
/// to show that foreign liquidity in the hooked pool reverts.
contract NativeLiquidityHelper is IUnlockCallback {
    using TransientStateLibrary for IPoolManager;

    IPoolManager public immutable pm;
    address private _payer;

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    function modify(PoolKey calldata key, int24 tickLower, int24 tickUpper, int256 liquidityDelta)
        external
        payable
        returns (BalanceDelta delta)
    {
        _payer = msg.sender;
        delta = abi.decode(pm.unlock(abi.encode(key, tickLower, tickUpper, liquidityDelta)), (BalanceDelta));
        _payer = address(0);
        uint256 rest = address(this).balance;
        if (rest != 0) {
            (bool ok,) = msg.sender.call{value: rest}("");
            require(ok, "refund");
        }
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "only pm");
        (PoolKey memory key, int24 tickLower, int24 tickUpper, int256 liquidityDelta) =
            abi.decode(data, (PoolKey, int24, int24, int256));
        (BalanceDelta delta,) =
            pm.modifyLiquidity(key, ModifyLiquidityParams(tickLower, tickUpper, liquidityDelta, bytes32(0)), "");
        for (uint256 i; i < 2; ++i) {
            Currency c = i == 0 ? key.currency0 : key.currency1;
            int256 d = pm.currencyDelta(address(this), c);
            if (d < 0) settleOwed(pm, c, _payer, uint256(-d));
            else if (d > 0) pm.take(c, _payer, uint256(d));
        }
        return abi.encode(delta);
    }

    receive() external payable {}
}
