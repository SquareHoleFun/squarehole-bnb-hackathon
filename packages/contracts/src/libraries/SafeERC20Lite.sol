// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Minimal checked ERC-20 calls. Reverts when the target has no code, the call reverts, or it
/// returns anything other than nothing or ABI-encoded `true`.
/// @dev Written for Square Hole; no third-party code.
library SafeERC20Lite {
    error TokenCallFailed(address token, bytes4 selector);

    function safeTransfer(address token, address to, uint256 amount) internal {
        _call(token, abi.encodeWithSelector(0xa9059cbb, to, amount)); // transfer(address,uint256)
    }

    function safeApprove(address token, address spender, uint256 amount) internal {
        _call(token, abi.encodeWithSelector(0x095ea7b3, spender, amount)); // approve(address,uint256)
    }

    function _call(address token, bytes memory data) private {
        // casting to 'bytes4' is safe because every caller passes abi.encodeWithSelector output (≥ 4 bytes)
        // forge-lint: disable-next-line(unsafe-typecast)
        bytes4 selector = bytes4(data);
        if (token.code.length == 0) revert TokenCallFailed(token, selector);
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok) revert TokenCallFailed(token, selector);
        if (ret.length != 0) {
            if (ret.length != 32) revert TokenCallFailed(token, selector);
            uint256 word = abi.decode(ret, (uint256));
            if (word != 1) revert TokenCallFailed(token, selector);
        }
    }
}
