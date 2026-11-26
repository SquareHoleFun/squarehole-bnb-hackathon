// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {V4Router} from "v4-periphery/src/V4Router.sol";

/// @title ExternalSwapHarness (LOCAL EXTERNAL-TRADING TEST HARNESS; not a Square Hole contract)
/// @notice The external trading venue of the local anvil stack (GOAL item 4, Stage C): Uniswap v4-periphery's
/// V4Router action engine (MIT, pinned), i.e. exactly what the Universal Router's V4_SWAP command runs
/// (SWAP_EXACT_IN_SINGLE / SWAP_EXACT_OUT_SINGLE / multi-hop, then SETTLE_ALL, TAKE_ALL). Square Hole's app never
/// uses it and has no trade form; `scripts/local-e2e.sh` drives it from anvil's default test accounts. The payer is
/// always the caller, paid through a bounded ERC-20 allowance to this harness (the Universal Router uses Permit2), and
/// the output always goes to the caller (TAKE_ALL). Tokens without return values (USDT-style) are accepted.
/// @dev Deployed only on the local chain (31337) by `script/LocalE2E.s.sol`. On Sepolia the external routes are the
/// canonical Universal Router / PoolSwapTest (docs/research/sepolia-infrastructure.md § 4).
contract ExternalSwapHarness is V4Router {
    address internal _locker;

    constructor(IPoolManager poolManager_) V4Router(poolManager_) {}

    /// @param unlockData abi.encode(bytes actions, bytes[] params): exactly the Universal Router's V4_SWAP input.
    function execute(bytes calldata unlockData) external {
        require(_locker == address(0), "harness: reentrant");
        _locker = msg.sender;
        _executeActions(unlockData);
        _locker = address(0);
    }

    function msgSender() public view override returns (address) {
        return _locker;
    }

    /// @dev Pulls from the caller (the only payer this harness accepts); accepts no-return tokens, rejects `false`.
    function _pay(Currency token, address payer, uint256 amount) internal override {
        require(payer == _locker, "harness: payer must be the caller");
        (bool ok, bytes memory ret) =
            Currency.unwrap(token).call(abi.encodeWithSelector(0x23b872dd, payer, address(poolManager), amount));
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "harness: transferFrom failed");
    }
}
