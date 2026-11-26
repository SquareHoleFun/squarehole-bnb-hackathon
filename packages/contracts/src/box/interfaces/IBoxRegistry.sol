// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title IBoxRegistry (slice S7; one per factory version, created by that factory)
/// @notice The append-only record of every box one factory created (launch pipeline v1 § 1.6 and § 3.9; box-factory
/// § 1.6; BC-012, BC-100). Written only by its factory, once per box, never edited or deleted; no owner, admin, pause,
/// upgrade, setter or rescue (F23 C2).
///
/// - **Per box on chain:** the coordinator (every other address of the box follows from its wiring getters), the
///   creation block, the template id, the spec hash and the record hash: keccak256 of the ABI-encoded `BoxRecord` as
///   it stood at creation, every contract with its code hash (EXTCODEHASH) included. `recordOf` rebuilds the record from
///   the chain at any later time; it hashes to `recordHash` for as long as no box contract's code changed (none can:
///   no SELFDESTRUCT, no proxy admin, EIP-6780).
/// - **Events** (the indexer's one source per version, S10a; no traces needed when a Safe or an ERC-4337 account
///   created the box): `BoxCreated` with the whole record, and `BoxSpec` with the ABI-encoded BoxSpec, whose keccak256
///   the registry checks against the coordinator's `specHash()` before it writes anything.
interface IBoxRegistry {
    /// @notice One box as the indexer, the site and the instance checks read it.
    /// @dev `contracts` and `codeHashes` are indexed by the ROLE_* constants; an absent role is zero in both.
    struct BoxRecord {
        uint256 boxId;
        /// The factory's template id (BC-013): the version, the box type, layout, Q class, both stream actions, the
        /// add-ons that change wiring, and the code hashes of the version's implementations and of the box's module.
        bytes32 templateId;
        /// keccak256(abi.encode(BoxSpec)): the coordinator's `specHash()` argument.
        bytes32 specHash;
        /// Who called createBox (the coordinator's `creator()` argument).
        address creator;
        /// Q (address(0): native ETH).
        address q;
        /// The raise in Q raw units.
        uint256 raise;
        address poolManager;
        /// The Uniswap v4 pool id (keccak256 of the hook's pool key).
        bytes32 poolId;
        /// The creation block (the hook's `deployBlock()`).
        uint256 creationBlock;
        /// The open (Unix seconds; the hook's `openAt()`): the spec's openAt, or the creation block's time + 1 when the
        /// spec said Now (0) or a time the creation reached (F80).
        uint256 openAt;
        /// The chain's pinned drand source the box reads (BC-053, BC-101).
        address randomness;
        address[13] contracts;
        bytes32[13] codeHashes;
    }

    /// @notice A box was created and recorded (`record` as `recordOf(boxId)` returns it in the creation block).
    event BoxCreated(uint256 indexed boxId, bytes32 indexed templateId, bytes32 indexed specHash, BoxRecord record);
    /// @notice The box's whole spec, ABI-encoded (`BoxSpecV1.BoxSpec`); keccak256(encodedSpec) == the record's specHash.
    event BoxSpec(uint256 indexed boxId, bytes encodedSpec);

    error NotFactory(address caller);
    /// @notice The coordinator is recorded already, or names another box id than the next one.
    error AlreadyRecorded(address coordinator);
    error BoxIdMismatch(uint256 expected, uint256 named);
    /// @notice keccak256(encodedSpec) differs from the coordinator's `specHash()`.
    error SpecHashMismatch(bytes32 encoded, bytes32 coordinators);
    error UnknownBox(uint256 boxId);

    /// @notice The factory only, once per box, in the box's creation transaction after its launch: records
    /// `coordinator` as box `boxCount()`, emits `BoxCreated` and `BoxSpec`.
    function record(address coordinator, bytes32 templateId, bytes calldata encodedSpec)
        external
        returns (uint256 boxId);

    /// @notice The factory that writes this registry (fixed at construction).
    function factory() external view returns (address);
    /// @notice Boxes recorded so far; ids run from 0 (box 0, the Misfits) to boxCount() - 1.
    function boxCount() external view returns (uint256);
    /// @notice A recorded box's coordinator (reverts `UnknownBox` beyond the count).
    function coordinatorOf(uint256 boxId) external view returns (address);
    /// @notice Whether `coordinator` is a box this registry recorded, and its id.
    function boxIdOf(address coordinator) external view returns (bool recorded, uint256 boxId);
    /// @notice What the registry stores for a box.
    function entry(uint256 boxId)
        external
        view
        returns (address coordinator, uint256 creationBlock, bytes32 templateId, bytes32 specHash, bytes32 recordHash);
    /// @notice The box's record rebuilt from the chain now (the coordinator's, hook's, collection's and receiver's
    /// wiring getters and EXTCODEHASH); keccak256(abi.encode(recordOf(id))) == the stored record hash.
    function recordOf(uint256 boxId) external view returns (BoxRecord memory);
}
