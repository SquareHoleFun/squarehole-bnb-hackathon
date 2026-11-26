// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice The ERC-20 subset Square Hole contracts call on T and Q.
/// @dev Calls that move funds go through `SafeERC20Lite`, which also accepts tokens that return no value.
interface IERC20Minimal {
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}
