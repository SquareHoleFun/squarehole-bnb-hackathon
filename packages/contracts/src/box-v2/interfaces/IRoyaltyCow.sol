// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice CoW Protocol GPv2Order.Data ABI, including the EIP-712 string-field hashes.
struct CowOrder {
    address sellToken;
    address buyToken;
    address receiver;
    uint256 sellAmount;
    uint256 buyAmount;
    uint32 validTo;
    bytes32 appData;
    uint256 feeAmount;
    bytes32 kind;
    bool partiallyFillable;
    bytes32 sellTokenBalance;
    bytes32 buyTokenBalance;
}
struct ConditionalOrderParams { address handler; bytes32 salt; bytes staticInput; }
/// @notice composable-cow's PayloadStruct: its ERC-1271 signature for a non-Safe owner is abi.encode(order, payload).
/// The inbox accepts only empty proof/offchainInput and its own orderParams(coin): a canonical 736-byte encoding.
struct CowSignaturePayload { bytes32[] proof; ConditionalOrderParams params; bytes offchainInput; }
struct RoyaltyCowConfig { address composableCow; address settlement; uint256 minimumLot; }

interface IComposableCow {
    /// @notice The owner registers one conditional order; the inbox calls it once per coin, without dispatch.
    function create(ConditionalOrderParams calldata params, bool dispatch) external;
    /// @notice Anyone reads the order the handler generates now, with its ERC-1271 signature payload.
    function getTradeableOrderWithSignature(address owner, ConditionalOrderParams calldata params,
        bytes calldata offchainInput, bytes32[] calldata proof) external view returns (CowOrder memory, bytes memory);
}
interface ICowSettlement {
    /// @notice The settlement's EIP-712 domain, read on chain for every signature check.
    function domainSeparator() external view returns (bytes32);
    /// @notice The only contract that pulls sold coins, so the only spender the inbox approves.
    function vaultRelayer() external view returns (address);
}
/// @notice Wire-compatible with composable-cow's IConditionalOrderGenerator.
interface IConditionalOrder {
    /// @notice Reverts unless `hash` is the digest of the order the handler would generate now.
    function verify(address owner, address sender, bytes32 hash, bytes32 domainSeparator, bytes32 context,
        bytes calldata staticInput, bytes calldata offchainInput, CowOrder calldata order) external view;
}
interface IConditionalOrderGenerator is IConditionalOrder {
    /// @notice The order due now, or PollTryAtEpoch when nothing is due before the next full hour.
    function getTradeableOrder(address owner, address sender, bytes32 context, bytes calldata staticInput,
        bytes calldata offchainInput) external view returns (CowOrder memory);
}
interface IRoyaltyCowOwner {
    /// @notice The release's handler this owner accepts; the handler refuses any other owner.
    function cowHandler() external view returns (address);
    /// @notice The owner's one canonical order for this coin now; reverts when no whole lot is approved.
    function cowOrder(address coin) external view returns (CowOrder memory);
}

library RoyaltyCowHash {
    bytes32 internal constant TYPE_HASH = keccak256("Order(address sellToken,address buyToken,address receiver,uint256 sellAmount,uint256 buyAmount,uint32 validTo,bytes32 appData,uint256 feeAmount,string kind,bool partiallyFillable,string sellTokenBalance,string buyTokenBalance)");
    /// @notice GPv2's EIP-712 digest of `order` under the settlement's domain.
    function digest(CowOrder memory order, bytes32 domain) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(hex"1901", domain, keccak256(abi.encode(TYPE_HASH, order))));
    }
}
