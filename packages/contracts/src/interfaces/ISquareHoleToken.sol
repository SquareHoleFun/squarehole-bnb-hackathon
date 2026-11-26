// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice The T functions the fee collector, ledger, hook and launcher rely on. Implemented by both launch
/// templates: `SquareHoleToken` (DN404 collection) and `SquareHoleFungibleToken` (plain ERC-20).
interface ISquareHoleToken {
    function feeCollector() external view returns (address);
    function rewardLedger() external view returns (address);
    function initialHolder() external view returns (address);
    function initialSupply() external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);

    /// @notice Destroys `amount` of the fee collector's own T. Callable only by the fee collector.
    function burnFeeInventory(uint256 amount) external;
}
