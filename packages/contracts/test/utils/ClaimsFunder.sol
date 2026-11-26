// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CommonBase} from "forge-std/Base.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {Currency} from "v4-core/src/types/Currency.sol";

interface IMintable {
    function mint(address to, uint256 amount) external;
}

/// @notice Test-only: turns ERC-20 into Uniswap v4 ERC-6909 claims held by any address, inside its own PoolManager
/// unlock (sync → pay the PoolManager → settle → mint claims). Unit tests of the collector and ledger use it to give
/// the stand-in fee source (`hook` address) the claims the real hook mints from pool fees in `afterSwap`.
/// @dev `payer == address(0)`: the asset is minted straight into the PoolManager (mintable test tokens);
/// otherwise `payer` transfers it (pranked, low-level so no-return tokens work). Mints the claims actually paid
/// (`settle()`'s return), which differs from `amount` only for fee-on-transfer assets.
contract ClaimsFunder is CommonBase, IUnlockCallback {
    IPoolManager public immutable pm;

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    function deposit(address asset, address payer, uint256 amount, address recipient) external returns (uint256) {
        return abi.decode(pm.unlock(abi.encode(asset, payer, amount, recipient)), (uint256));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "only pm");
        (address asset, address payer, uint256 amount, address recipient) =
            abi.decode(data, (address, address, uint256, address));
        pm.sync(Currency.wrap(asset));
        if (payer == address(0)) {
            IMintable(asset).mint(address(pm), amount);
        } else {
            vm.prank(payer);
            (bool ok,) = asset.call(abi.encodeWithSelector(0xa9059cbb, address(pm), amount));
            require(ok, "payer transfer");
        }
        uint256 paid = pm.settle();
        pm.mint(recipient, uint256(uint160(asset)), paid);
        return abi.encode(paid);
    }
}
