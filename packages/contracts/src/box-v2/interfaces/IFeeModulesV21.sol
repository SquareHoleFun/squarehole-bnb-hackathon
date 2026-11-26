// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Release deployer supplies separately deployed, shared code. No per-box module is created.
struct ReceiverCodeV21 {
    address views;
    address callback;
    address directory;
    address[4] modules;
}

/// @notice Additive receiver release proofs; anyone reads them without moving funds.
interface IFeeModulesV21 {
    /// @notice The receiver ran one side's fee module for `amount` raw P; emitted only after the module call succeeded.
    event ModuleExecuted(bool indexed sellers, address indexed module, uint256 amount);
    /// @notice Anyone reads the immutable implementation identity.
    function implementation() external view returns (address);
    /// @notice Anyone reads the fixed core callback and arithmetic helper.
    function receiverCode() external view returns (address views, address callback, address directory);
    /// @notice Anyone reads the immutable module snapshot selected for a side.
    function sideModule(bool sellers) external view returns (address module, bytes32 codeHash);
    /// @notice Anyone reads the backed P waiting for a fee module or the core sellers ShopT choice; no money moves.
    function modulePendingP(bool sellers) external view returns (uint256);
    /// @notice Execute a graduated side: Alchemist's fixed trigger only until seven days without conversion.
    /// Anyone executes Alchemist after that wait, other fixed modules, or core sellers ShopT purchase/refund.
    /// ShopT returns resolved P (spent plus holder refunds); refusal preserves pending P for retry.
    function executeModule(bool sellers) external returns (uint256);
    /// @notice Anyone reads the creation snapshot of a choice's shared action. Core choices return zero.
    function feeModule(uint8 choice) external view returns (address module, bytes32 codeHash);
    /// @notice Factory/readers verify active admissions for new boxes only. Existing execution never calls this.
    function verifyModules(uint8 buyers, uint8 sellers, uint32 buyersId, uint32 sellersId) external view;
}

/// @notice General future-action boundary. The receiver transfers only the chosen budget as P claims.
/// CALL isolates all receiver storage, approvals and other funds. Routing and output destinations belong to the action.
interface IFeeActionV21 {
    /// @notice Anyone reads the CALL action interface version; factory accepts version 1 only.
    function feeActionVersion() external pure returns (uint256);
    /// @notice Funded receiver only; consumes exactly amount P claims during its PoolManager unlock.
    /// Implementations must leave no new P claims behind; failure rolls the entire funding frame back.
    function execute(address manager, address priceCoin, uint256 amount) external;
}
