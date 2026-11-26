// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Per-launch fee collector: burns native T fee receipts and splits realized Q (ADR-0010, ADR-0011).
/// Fee receipts arrive and wait as Uniswap v4 ERC-6909 claims on the PoolManager.
interface IFeeCollector {
    /// @notice An authenticated fee receipt. Q was split immediately; T waits for `burnPendingT`.
    event FeesReceived(
        uint256 indexed receiptId,
        uint256 tAmount,
        uint256 qAmount,
        uint256 protocolQ,
        uint256 holderQ,
        uint256 qRemainder
    );
    /// @notice Native fee T was destroyed (real totalSupply reduction).
    event FeeTBurned(uint256 amount, uint256 totalBurned);
    /// @notice The protocol share of realized Q was sent to the treasury.
    event ProtocolQPaid(address indexed treasury, uint256 amount);
    /// @notice An unsolicited deposit (never a fee event) was moved to the treasury (`claims` = ERC-6909 claims).
    event UnaccountedSwept(address indexed asset, uint256 amount, bool claims);

    function token() external view returns (address);
    function quote() external view returns (address);
    function ledger() external view returns (address);
    function treasury() external view returns (address);
    function feeSource() external view returns (address);
    function poolManager() external view returns (address);

    function receiveFees(uint256 tAmount, uint256 qAmount) external returns (uint256 receiptId);
    function processFees() external returns (uint256 burnedT, uint256 paidQ);
    function burnPendingT() external returns (uint256 burnedT);
    function payProtocolQ() external returns (uint256 paidQ);
    function sweepUnaccounted(address asset) external returns (uint256 amount);
    function sweepUnaccountedClaims(address asset) external returns (uint256 amount);
}
