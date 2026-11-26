// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {TransientStateLibrary} from "v4-core/src/libraries/TransientStateLibrary.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {V4Router} from "v4-periphery/src/V4Router.sol";

/// @dev Low-level transferFrom that accepts tokens returning nothing (USDT-style) and rejects `false`.
function pullToken(address token, address from, address to, uint256 amount) {
    (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0x23b872dd, from, to, amount));
    require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "transferFrom failed");
}

/// @notice Test-only router that runs an arbitrary list of PoolManager steps inside ONE unlock, with deltas owned
/// by this router: swaps, takes to any recipient, settles paid by any approved payer, "settle all / take all" of the
/// router's open deltas (the Universal Router V4_SWAP pattern), donations and liquidity changes. It is how the
/// integration tests build batched swaps, flash take → swap → settle sequences and foreign liquidity attempts
/// against the real PoolManager. Never deployed outside local tests.
contract StepRouter is IUnlockCallback {
    using TransientStateLibrary for IPoolManager;

    enum Op {
        Swap,
        Take,
        Settle,
        SettleAll,
        TakeAll,
        Donate,
        ModifyLiquidity
    }

    struct Step {
        Op op;
        PoolKey key; // Swap, Donate, ModifyLiquidity
        bool zeroForOne; // Swap
        int256 amount; // Swap: amountSpecified; ModifyLiquidity: liquidityDelta; Take/Settle/Donate0: amount
        address currency; // Take, Settle, SettleAll, TakeAll
        address account; // Take/TakeAll: recipient; Settle/SettleAll: payer (approved this router)
        int24 tickLower; // ModifyLiquidity
        int24 tickUpper; // ModifyLiquidity
        uint256 amount1; // Donate: amount1
    }

    IPoolManager public immutable pm;
    BalanceDelta[] internal _swapDeltas;

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    function run(Step[] calldata steps) external returns (BalanceDelta[] memory deltas) {
        delete _swapDeltas;
        pm.unlock(abi.encode(steps));
        deltas = _swapDeltas;
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "only pm");
        Step[] memory steps = abi.decode(data, (Step[]));
        for (uint256 i; i < steps.length; ++i) {
            _step(steps[i]);
        }
        return "";
    }

    function _step(Step memory s) internal {
        if (s.op == Op.Swap) {
            uint160 limit = s.zeroForOne ? 4295128739 + 1 : 1461446703485210103287273052203988822378723970342 - 1;
            _swapDeltas.push(pm.swap(s.key, SwapParams(s.zeroForOne, s.amount, limit), ""));
        } else if (s.op == Op.Take) {
            pm.take(Currency.wrap(s.currency), s.account, uint256(s.amount));
        } else if (s.op == Op.Settle) {
            _settle(s.currency, s.account, uint256(s.amount));
        } else if (s.op == Op.SettleAll) {
            int256 d = pm.currencyDelta(address(this), Currency.wrap(s.currency));
            if (d < 0) _settle(s.currency, s.account, uint256(-d));
        } else if (s.op == Op.TakeAll) {
            int256 d = pm.currencyDelta(address(this), Currency.wrap(s.currency));
            if (d > 0) pm.take(Currency.wrap(s.currency), s.account, uint256(d));
        } else if (s.op == Op.Donate) {
            pm.donate(s.key, uint256(s.amount), s.amount1, "");
        } else {
            pm.modifyLiquidity(s.key, ModifyLiquidityParams(s.tickLower, s.tickUpper, s.amount, bytes32(0)), "");
        }
    }

    function _settle(address currency, address payer, uint256 amount) internal {
        pm.sync(Currency.wrap(currency));
        pullToken(currency, payer, address(pm), amount);
        pm.settle();
    }
}

/// @notice Test-only router built on Uniswap v4-periphery's V4Router (MIT, pinned), the action engine the Universal
/// Router's V4_SWAP command runs: SWAP_EXACT_IN_SINGLE / SWAP_EXACT_OUT_SINGLE then SETTLE_ALL then TAKE_ALL, i.e.
/// the swap (and its afterSwap fee event) always precedes settle and take. Payment pulls from the caller like the
/// Universal Router's Permit2 path (here a bounded ERC-20 allowance to this router).
contract UniversalRouterLike is V4Router {
    address internal _locker;

    constructor(IPoolManager pm_) V4Router(pm_) {}

    /// @param unlockData abi.encode(bytes actions, bytes[] params), exactly the V4_SWAP input.
    function execute(bytes calldata unlockData) external {
        _locker = msg.sender;
        _executeActions(unlockData);
        _locker = address(0);
    }

    function msgSender() public view override returns (address) {
        return _locker;
    }

    function _pay(Currency token, address payer, uint256 amount) internal override {
        pullToken(Currency.unwrap(token), payer, address(poolManager), amount);
    }
}
