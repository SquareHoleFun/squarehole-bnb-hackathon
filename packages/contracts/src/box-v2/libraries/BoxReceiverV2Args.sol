// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Factory encodes the one-part receiver clone; all amounts are raw P; no money moves here.
struct ReceiverArgs {
    /// @notice Factory writes immutable wiring/choice or raw P threshold; no money moves.
    address coordinator;
    /// @notice Factory writes immutable wiring/choice or raw P threshold; no money moves.
    address hook;
    /// @notice Factory writes immutable wiring/choice or raw P threshold; no money moves.
    address p;
    /// @notice Factory writes immutable wiring/choice or raw P threshold; no money moves.
    address t;
    /// @notice Factory writes immutable wiring/choice or raw P threshold; no money moves.
    address launchRouter;
    /// @notice Factory writes immutable wiring/choice or raw P threshold; no money moves.
    address registry;
    /// @notice Factory writes immutable wiring/choice or raw P threshold; no money moves.
    address creatorPayee;
    /// @notice Factory writes immutable wiring/choice or raw P threshold; no money moves.
    uint256 boxId;
    /// @notice Factory writes immutable wiring/choice or raw P threshold; no money moves.
    uint128 batchMinQ;
    /// @notice Factory writes immutable wiring/choice or raw P threshold; no money moves.
    uint128 tipMaxQ;
    /// @notice Factory writes immutable wiring/choice or raw P threshold; no money moves.
    uint128 stepMinQ;
    /// @notice Factory writes immutable wiring/choice or raw P threshold; no money moves.
    uint8 buyersChoice;
    /// @notice Factory writes immutable wiring/choice or raw P threshold; no money moves.
    uint8 sellersChoice;
    /// @notice Factory writes immutable wiring/choice or raw P threshold; no money moves.
    uint8 royaltyDestination;
    /// @notice Factory writes immutable wiring/choice or raw P threshold; no money moves.
    address holderLedger;
    /// @notice Factory writes immutable wiring/choice or raw P threshold; no money moves.
    address itemLedger;
}
/// @notice Shared packed layout; Safes and PoolManager are implementation immutables, never clone fields.
library BoxReceiverV2Args {
    /// @notice Internal clone readers: immutable field offset; no money moves.
    uint256 internal constant COORDINATOR = 0;
    /// @notice Internal clone readers: immutable field offset; no money moves.
    uint256 internal constant HOOK = 20;
    /// @notice Internal clone readers: immutable field offset; no money moves.
    uint256 internal constant P = 40;
    /// @notice Internal clone readers: immutable field offset; no money moves.
    uint256 internal constant T = 60;
    /// @notice Internal clone readers: immutable field offset; no money moves.
    uint256 internal constant LAUNCH_ROUTER = 80;
    /// @notice Internal clone readers: immutable field offset; no money moves.
    uint256 internal constant REGISTRY = 100;
    /// @notice Internal clone readers: immutable field offset; no money moves.
    uint256 internal constant CREATOR_PAYEE = 120;
    /// @notice Internal clone readers: immutable field offset; no money moves.
    uint256 internal constant BOX_ID = 140;
    /// @notice Internal clone readers: immutable field offset; no money moves.
    uint256 internal constant BATCH_MIN_Q = 172;
    /// @notice Internal clone readers: immutable field offset; no money moves.
    uint256 internal constant TIP_MAX_Q = 188;
    /// @notice Internal clone readers: immutable field offset; no money moves.
    uint256 internal constant STEP_MIN_Q = 204;
    /// @notice Internal clone readers: immutable field offset; no money moves.
    uint256 internal constant BUYERS_CHOICE = 220;
    /// @notice Internal clone readers: immutable field offset; no money moves.
    uint256 internal constant SELLERS_CHOICE = 221;
    /// @notice Internal clone readers: immutable field offset; no money moves.
    uint256 internal constant ROYALTY_DESTINATION = 222;
    /// @notice Internal clone readers: immutable field offset; no money moves.
    uint256 internal constant HOLDER_LEDGER = 223;
    /// @notice Internal clone readers: immutable field offset; no money moves.
    uint256 internal constant ITEM_LEDGER = 243;
    /// @notice Internal readers: total packed bytes; no money moves.
    uint256 internal constant LENGTH = 263;

    /// @notice Factory/test encoder only; encodes immutable arguments without moving funds.
    /// @dev Internal callers may read encode; no funds move.
    function encode(ReceiverArgs memory a) internal pure returns (bytes memory encoded) {
        encoded = new bytes(LENGTH);
        // One allocation for the unchanged packed prefix. Every write stays inside
        // its 288-byte padded data area; shifts discard unused address/uint128 bits.
        assembly ("memory-safe") {
            let d := add(encoded, 32)
            for { let i := 0 } lt(i, 7) { i := add(i, 1) } {
                mstore(add(d, mul(i, 20)), shl(96, mload(add(a, mul(i, 32)))))
            }
            mstore(add(d, 140), mload(add(a, 224)))
            mstore(add(d, 172), shl(128, mload(add(a, 256))))
            mstore(add(d, 188), shl(128, mload(add(a, 288))))
            mstore(add(d, 204), shl(128, mload(add(a, 320))))
            mstore8(add(d, 220), mload(add(a, 352)))
            mstore8(add(d, 221), mload(add(a, 384)))
            mstore8(add(d, 222), mload(add(a, 416)))
            mstore(add(d, 223), shl(96, mload(add(a, 448))))
            mstore(add(d, 243), shl(96, mload(add(a, 480))))
        }
    }
    /// @notice Receiver internal reader; reads clone code, moves no money.
    function addressAt(uint256 offset) internal view returns (address a) {
        assembly ("memory-safe") { extcodecopy(address(), 0, add(45, offset), 20) a := shr(96, mload(0)) }
    }
    /// @notice Receiver internal reader; reads 1-32 packed bytes, moves no money.
    function uintAt(uint256 offset, uint256 len) internal view returns (uint256 v) {
        assembly ("memory-safe") { extcodecopy(address(), 0, add(45, offset), len) v := shr(sub(256, mul(8, len)), mload(0)) }
    }
}
