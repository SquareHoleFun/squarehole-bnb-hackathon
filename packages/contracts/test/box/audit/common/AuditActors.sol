// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {TransientStateLibrary} from "v4-core/src/libraries/TransientStateLibrary.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";

/// @title AuditActor
/// @notice TEST ONLY (SH-AUDIT-B0 R0-A). One account with code for every audit role that needs some: the contract
/// drawer (`EthMode.Accept`), the recipient whose `receive` reverts (`Refuse`), the recipient whose `receive` uses all
/// the gas it is given (`BurnAllGas`), and the delegate an EIP-7702 EOA points at (`Accept`). The mode is immutable, so
/// an accepting actor's `receive` reads no storage (it costs less than a 2,300-gas stipend, as a plain account would).
/// Every actor takes ERC-721 safe transfers (so a test isolates the ETH behaviour) and acts through `exec`, which only
/// its owner (the world that deployed it) or the account itself (an EIP-7702 EOA calling itself) may use. A test that
/// only needs the actor as `msg.sender` uses `vm.prank(address(actor))` instead.
contract AuditActor {
    enum EthMode {
        Accept,
        Refuse,
        BurnAllGas
    }

    EthMode public immutable ethMode;
    address public immutable owner;

    error NotOwner(address caller);
    error EthRefused(uint256 value);
    error UnknownCall(bytes4 selector);

    constructor(address owner_, EthMode mode_) {
        owner = owner_;
        ethMode = mode_;
    }

    /// @notice Any call as this account, `value` from its own balance; reverts with the callee's revert data.
    function exec(address target, uint256 value, bytes calldata data) external payable returns (bytes memory ret) {
        if (msg.sender != owner && msg.sender != address(this)) revert NotOwner(msg.sender);
        bool ok;
        (ok, ret) = target.call{value: value}(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    receive() external payable {
        _onEth();
    }

    /// @dev ETH sent with calldata follows the same mode; any other unknown call reverts, so a callee that expects an
    /// answer never reads an empty one as success.
    fallback() external payable {
        _onEth();
        if (msg.value == 0) revert UnknownCall(msg.sig);
    }

    function _onEth() private view {
        EthMode m = ethMode;
        if (m == EthMode.Refuse) revert EthRefused(msg.value);
        if (m == EthMode.BurnAllGas) {
            // Never returns: every unit of gas forwarded to this frame is used (out of gas).
            assembly ("memory-safe") {
                for {} 1 {} {}
            }
        }
    }
}

/// @title AuditRouterSwapper
/// @notice TEST ONLY (SH-AUDIT-B0 R0-A). The local stand-in for the Universal Router (which needs a fork): a router-like
/// caller that runs any list of swaps in one `PoolManager.unlock`, with any parameters (exact input with
/// `amountSpecified < 0`, exact output with `> 0`, any `sqrtPriceLimitX96`, either direction, hook data passed
/// through), as the Universal Router's v4 plan does. The hook sees this contract as the swap's `sender`. Settlement:
/// native ETH owed is paid from this contract's balance (`msg.value`; the rest is refunded to `msg.sender` at the end,
/// as the router's SWEEP), an ERC-20 owed is pulled from `msg.sender` (who approved this contract), and every positive
/// delta is taken to `recipient`. Nothing stays here between calls, and nothing is written to storage but the payer
/// and the recipient while a call runs, so its gas is the router's own plus the PoolManager's.
contract AuditRouterSwapper is IUnlockCallback {
    using TransientStateLibrary for IPoolManager;

    struct Call {
        PoolKey key;
        SwapParams params;
        bytes hookData;
    }

    IPoolManager public immutable pm;
    address private _payer;
    address private _recipient;

    error OnlyPoolManager(address caller);
    error PullFailed(address token, address from, uint256 amount);
    error RefundFailed(address to, uint256 amount);

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    /// @notice Every swap of `calls` in one unlock, in order; settles each currency touched once at the end.
    function swap(Call[] memory calls, address recipient) public payable returns (BalanceDelta[] memory deltas) {
        _payer = msg.sender;
        _recipient = recipient;
        deltas = abi.decode(pm.unlock(abi.encode(calls)), (BalanceDelta[]));
        _payer = address(0);
        _recipient = address(0);
        uint256 rest = address(this).balance;
        if (rest != 0) {
            (bool ok,) = msg.sender.call{value: rest}("");
            if (!ok) revert RefundFailed(msg.sender, rest);
        }
    }

    /// @notice One swap with any parameters, outputs to `recipient`.
    function swapOne(PoolKey memory key, SwapParams memory params, bytes memory hookData, address recipient)
        external
        payable
        returns (BalanceDelta delta)
    {
        Call[] memory calls = new Call[](1);
        calls[0] = Call({key: key, params: params, hookData: hookData});
        delta = swap(calls, recipient)[0];
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(pm)) revert OnlyPoolManager(msg.sender);
        Call[] memory calls = abi.decode(data, (Call[]));
        BalanceDelta[] memory deltas = new BalanceDelta[](calls.length);
        for (uint256 i; i < calls.length; ++i) {
            deltas[i] = pm.swap(calls[i].key, calls[i].params, calls[i].hookData);
        }
        for (uint256 i; i < calls.length; ++i) {
            _resolve(calls[i].key.currency0);
            _resolve(calls[i].key.currency1);
        }
        return abi.encode(deltas);
    }

    function _resolve(Currency c) private {
        int256 d = pm.currencyDelta(address(this), c);
        if (d < 0) {
            // casting to 'uint256' is safe because d < 0 here (a delta is an int128)
            // forge-lint: disable-next-line(unsafe-typecast)
            uint256 owed = uint256(-d);
            if (c.isAddressZero()) {
                pm.settle{value: owed}();
            } else {
                pm.sync(c);
                address token = Currency.unwrap(c);
                (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0x23b872dd, _payer, address(pm), owed));
                if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert PullFailed(token, _payer, owed);
                pm.settle();
            }
        } else if (d > 0) {
            // casting to 'uint256' is safe because d > 0 here
            // forge-lint: disable-next-line(unsafe-typecast)
            pm.take(c, _recipient, uint256(d));
        }
    }

    receive() external payable {}
}
