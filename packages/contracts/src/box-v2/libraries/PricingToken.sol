// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Core v2 M1: a wave-1 library frozen as a stub before wave 1 (wave 0's integrated review, finding M3; file map § 2, §
// 1 rule 8). Its owner, M1-30-a, writes the bodies and may add entries; the first five entries below are called by the
// receiver (M1-40), the module (M1-41) and the royalty booking (M1-44) in wave 1, so a change to one goes through the
// integrator. M1-30-a built the bodies and added `approveExact`, `settle` and `settleToClaims` (change queue 4, FL3)
// and `ShortTransfer` (the router's and the factory's error, one selector).

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IERC20Minimal} from "v4-core/src/interfaces/external/IERC20Minimal.sol";
import {Currency} from "v4-core/src/types/Currency.sol";

/// @title PricingToken (ETH or ERC-20 P)
/// @notice Any listing as P (ADR-0017 § 4): exact-transfer intake and pulls, 6-18 decimals (file map § 5). Amounts are
/// raw units of P; nothing here scales by decimals, so a 6-decimal P moves exactly as an 18-decimal one. ERC-20 calls
/// are return-safe (a token that returns nothing is accepted, one that returns false is refused) and every move is
/// checked by the balance change it made, so a fee on transfer, a rebase inside the call or a re-entering token that
/// moves more is refused with nothing moved (the whole call reverts).
library PricingToken {
    /// @notice Kept from the frozen stub (the shape test names its selector); no built entry reverts with it.
    error NotBuilt();
    /// @notice The balance change was not `expected` (the factory's and the launch router's error, one selector). A
    /// caller bound to another error for a short intake (`IBoxReceiverV2.TransferNotExact(uint256,uint256)`, M1-40's
    /// and M1-44's intake) checks the balance change itself or maps this one; `pullExact` and `sendExact` bubble it.
    error ShortTransfer(address token, uint256 expected, uint256 received);
    /// @notice `pullExact` with P = ETH: native ETH arrives as `msg.value`, never by a pull.
    error NativeNotPulled();
    /// @notice An ERC-20 call that returned false or a malformed return.
    error TokenCallFailed(address token, bytes4 selector);
    /// @notice A balance that cannot be read (no code, a revert, a short return).
    error BalanceUnreadable(address token, address account);
    /// @notice A native ETH send the recipient refused.
    error EthSendFailed(address to, uint256 amount);

    /// @notice True for native ETH (P = address(0)).
    function isNative(address p) internal pure returns (bool) {
        return p == address(0);
    }

    /// @notice P's ERC-6909 claim id in the PoolManager (`Currency`'s id: the address as a number, 0 for ETH).
    function claimId(address p) internal pure returns (uint256) {
        return uint256(uint160(p));
    }

    /// @notice `account`'s balance of P (native: its ETH).
    function balanceOf(address p, address account) internal view returns (uint256 b) {
        if (p == address(0)) return account.balance;
        (bool ok, bytes memory ret) = p.staticcall(abi.encodeCall(IERC20Minimal.balanceOf, (account)));
        if (!ok || ret.length < 32) revert BalanceUnreadable(p, account);
        b = abi.decode(ret, (uint256));
    }

    /// @notice Pulls exactly `amount` of an ERC-20 P from `from` to this contract by `transferFrom`, the balance change
    /// checked (`ShortTransfer`); refuses native ETH (`NativeNotPulled`).
    function pullExact(address p, address from, uint256 amount) internal {
        if (p == address(0)) revert NativeNotPulled();
        uint256 before = balanceOf(p, address(this));
        _call(p, abi.encodeCall(IERC20Minimal.transferFrom, (from, address(this), amount)));
        _checkArrived(p, address(this), before, amount);
    }

    /// @notice Sends exactly `amount` of P to `to`: native ETH by a plain call (the EVM moves the value exactly; a
    /// refusal reverts `EthSendFailed`), an ERC-20 P by `transfer` with `to`'s balance change checked (`ShortTransfer`).
    function sendExact(address p, address to, uint256 amount) internal {
        if (p == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert EthSendFailed(to, amount);
            return;
        }
        uint256 before = balanceOf(p, to);
        _call(p, abi.encodeCall(IERC20Minimal.transfer, (to, amount)));
        _checkArrived(p, to, before, amount);
    }

    /// @notice Sets this contract's allowance of an ERC-20 P for `spender` to exactly `amount`, forced and return-safe:
    /// `approve(amount)`, and where a token refuses to change a non-zero allowance (USDT's rule), `approve(0)` first.
    /// Native ETH needs none (no-op).
    function approveExact(address p, address spender, uint256 amount) internal {
        if (p == address(0)) return;
        bytes memory set = abi.encodeCall(IERC20Minimal.approve, (spender, amount));
        if (_try(p, set)) return;
        _call(p, abi.encodeCall(IERC20Minimal.approve, (spender, 0)));
        _call(p, set);
    }

    /// @notice Inside the caller's own unlock: pays `amount` of P that this contract holds into the PoolManager and
    /// settles it (ETH by value), checking that exactly `amount` was settled (`ShortTransfer`). The caller's credit of
    /// `amount` is then its to mint as claims or to spend in the same unlock.
    function settle(IPoolManager pm, address p, uint256 amount) internal {
        uint256 paid;
        if (p == address(0)) {
            // v1's order (`BoxLaunchRouter.sol:213`): an ERC-20 another step of the same unlock left synced would make
            // a settle with value revert (`NonzeroNativeValue`).
            pm.sync(Currency.wrap(address(0)));
            paid = pm.settle{value: amount}();
        } else {
            pm.sync(Currency.wrap(p));
            _call(p, abi.encodeCall(IERC20Minimal.transfer, (address(pm), amount)));
            paid = pm.settle();
        }
        if (paid != amount) revert ShortTransfer(p, amount, paid);
    }

    /// @notice Inside the caller's own unlock: `settle`, then `amount` of P's claims minted to this contract.
    function settleToClaims(IPoolManager pm, address p, uint256 amount) internal {
        settle(pm, p, amount);
        pm.mint(address(this), claimId(p), amount);
    }

    /// @dev `account`'s balance of P rose by exactly `amount` since `before`.
    function _checkArrived(address p, address account, uint256 before, uint256 amount) private view {
        uint256 afterB = balanceOf(p, account);
        uint256 received = afterB > before ? afterB - before : 0;
        if (received != amount) revert ShortTransfer(p, amount, received);
    }

    /// @dev A return-safe ERC-20 call: a revert bubbles its data; false or a malformed return is `TokenCallFailed`.
    function _call(address p, bytes memory data) private {
        (bool ok, bytes memory ret) = p.call(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        // casting to 'bytes4' keeps the call's selector, its first four bytes
        // forge-lint: disable-next-line(unsafe-typecast)
        if (!_returnedTrue(p, ret)) revert TokenCallFailed(p, bytes4(data));
    }

    /// @dev The same call, its outcome returned instead of reverting.
    function _try(address p, bytes memory data) private returns (bool) {
        (bool ok, bytes memory ret) = p.call(data);
        return ok && _returnedTrue(p, ret);
    }

    /// @dev Nothing returned (from a contract: a token that returns no bool), or a word that is 1.
    function _returnedTrue(address p, bytes memory ret) private view returns (bool) {
        if (ret.length == 0) return p.code.length != 0;
        return ret.length >= 32 && abi.decode(ret, (uint256)) == 1;
    }
}
