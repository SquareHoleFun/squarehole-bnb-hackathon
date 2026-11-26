// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title BoxRolesV2 (ticket M1-00; ADR-0017 § 12)
/// @notice Registry v2's roles: indexes of `BoxRecordV2.contracts` and `codeHashes`, and of the coordinator's
/// `roleAddress`. v1's 0-12 keep their numbers and meanings (`BoxRegistry.sol:20-39`); a role a box does not use is the
/// zero address and a zero code hash (ADR-0017 § 6: only the parts a box uses are deployed). The TypeScript twin is
/// `ROLE_V2` in `packages/chain/src/core/roles.ts`.
library BoxRolesV2 {
    /// @dev Encoders/readers use ROLE_COORDINATOR as data; no funds move.
    uint256 internal constant ROLE_COORDINATOR = 0;
    /// @dev T: from F102 a standard EIP-1167 clone of the release's T implementation (`IBoxTokenV2`).
    /// @dev Encoders/readers use ROLE_TOKEN as data; no funds move.
    uint256 internal constant ROLE_TOKEN = 1;
    /// @dev Encoders/readers use ROLE_HOOK as data; no funds move.
    uint256 internal constant ROLE_HOOK = 2;
    /// @dev The supply-share vault; from M2 a `SHOP` vault and from M3 a `PILE` vault take this role instead.
    /// @dev Encoders/readers use ROLE_VAULT as data; no funds move.
    uint256 internal constant ROLE_VAULT = 3;
    /// @dev Encoders/readers use ROLE_COLLECTION as data; no funds move.
    uint256 internal constant ROLE_COLLECTION = 4;
    /// @dev Encoders/readers use ROLE_RECEIVER as data; no funds move.
    uint256 internal constant ROLE_RECEIVER = 5;
    /// @dev Encoders/readers use ROLE_LAUNCH_ROUTER as data; no funds move.
    uint256 internal constant ROLE_LAUNCH_ROUTER = 6;
    /// @dev Encoders/readers use ROLE_TICKETS as data; no funds move.
    uint256 internal constant ROLE_TICKETS = 7;
    /// @dev Encoders/readers use ROLE_ROYALTY_ROUTER as data; no funds move.
    uint256 internal constant ROLE_ROYALTY_ROUTER = 8;
    /// @dev FIT's buy-and-burn executor (box 0's, named by every box).
    /// @dev Encoders/readers use ROLE_EXECUTOR as data; no funds move.
    uint256 internal constant ROLE_EXECUTOR = 9;
    /// @dev v1's per-item stream (add-on 2, box 0 only); not in format 2, so zero for every v2 box.
    /// @dev Encoders/readers use ROLE_ITEM_STREAM as data; no funds move.
    uint256 internal constant ROLE_ITEM_STREAM = 10;
    /// @dev Reserved after C14; zero in CQ11 records. Fees are P at the receiver.
    /// @dev Encoders/readers use ROLE_SWAP_MODULE as data; no funds move.
    uint256 internal constant ROLE_SWAP_MODULE = 11;
    /// @dev v1's table data contract. A v2 table loads in chunks after creation (ADR-0017 § 6), read through the
    /// coordinator's `chunkPointer`, so this role is zero for a v2 box and `recordOf` stays equal to the creation record.
    /// @dev Encoders/readers use ROLE_METADATA_TABLE as data; no funds move.
    uint256 internal constant ROLE_METADATA_TABLE = 12;
    /// @dev Reserved after C14; zero in CQ11 records.
    /// @dev Encoders/readers use ROLE_SAMPLER as data; no funds move.
    uint256 internal constant ROLE_SAMPLER = 13;
    /// @dev Reserved after C14; no plug-in offered in this release.
    /// @dev Encoders/readers use ROLE_LEG_0 as data; no funds move.
    uint256 internal constant ROLE_LEG_0 = 14;
    /// @dev Encoders/readers use ROLE_LEG_1 as data; no funds move.
    uint256 internal constant ROLE_LEG_1 = 15;
    /// @dev M3's item ledger: the vault's five calls and the item payouts go here; zero until M3.
    /// @dev Encoders/readers use ROLE_ITEM_LEDGER as data; no funds move.
    uint256 internal constant ROLE_ITEM_LEDGER = 16;
    /// @dev M2's holder ledger: the hook's holder notice and the forward booking calls go here; zero until M2.
    /// @dev Encoders/readers use ROLE_HOLDER_LEDGER as data; no funds move.
    uint256 internal constant ROLE_HOLDER_LEDGER = 17;
    /// @dev An add-on 9 (`held-item-earnings`) part, if M2-00 gives it a contract; it may call `earnedIntake`.
    /// @dev Encoders/readers use ROLE_HELD_ITEM_EARNINGS as data; no funds move.
    uint256 internal constant ROLE_HELD_ITEM_EARNINGS = 18;
    /// @dev M2's starter-set loader: the only caller of the coordinator's `starterSetLoaded()`.
    /// @dev Encoders/readers use ROLE_STARTER_SET_LOADER as data; no funds move.
    uint256 internal constant ROLE_STARTER_SET_LOADER = 19;
    /// @dev Reserved for M2 and M3 parts; zero until a milestone's first ticket names them.
    /// @dev Encoders/readers use ROLE_RESERVED_20 as data; no funds move.
    uint256 internal constant ROLE_RESERVED_20 = 20;
    /// @dev Encoders/readers use ROLE_RESERVED_21 as data; no funds move.
    uint256 internal constant ROLE_RESERVED_21 = 21;
    /// @dev Encoders/readers use ROLE_RESERVED_22 as data; no funds move.
    uint256 internal constant ROLE_RESERVED_22 = 22;
    /// @dev Encoders/readers use ROLE_RESERVED_23 as data; no funds move.
    uint256 internal constant ROLE_RESERVED_23 = 23;
    /// @dev Encoders/readers use ROLE_COUNT as data; no funds move.
    uint256 internal constant ROLE_COUNT = 24;
}

/// @title IBoxRegistryV2 (ticket M1-00 freezes it; M1-32 builds it)
/// @notice The append-only record of every box factory v2 created, as v1's (`IBoxRegistry.sol`): written only by its
/// factory, once per box, never edited; no owner, admin, pause, upgrade, setter or rescue (F23 C2). Changes from v1:
/// - **24 roles** (`BoxRolesV2`), so the record carries `address[24]` and `bytes32[24]`.
/// - **The spec as calldata** (ADR-0017 § 6): `createBox` takes the whole spec, and this registry emits it in
///   `BoxSpec` as v1's does; the chain keeps only its hash (`specHash`), and the table and `tokenURI` texts load after
///   creation through the coordinator's chunk loader. Reserved roles remain zero.
/// - **A fixed directory of earlier registries** (ADR-0017 § 10), set at deployment, for reading other boxes: box
///   tokens admitted manually by the lister. Index 0 is
///   this registry; index i ≥ 1 is `directory()[i - 1]`, v1's registry included, so FIT is box 0 at v1's index. An
///   earlier core never sees a later one.
/// - `coordinatorOf` and `boxIdOf` keep v1's names and shapes, so the listing registry reads v1's and v2's registries
///   alike (ADR-0017 § 3).
interface IBoxRegistryV2 {
    /// @notice One box as the indexer, the site and the instance checks read it. Every field is fixed at creation:
    /// `openAt` is the coordinator's `openAt()` (the spec's open, or the creation time + 1 for Now), never the
    /// effective open, which the coordinator emits later (`BoxOpenSet`).
    struct BoxRecordV2 {
        /// @dev Encoders/readers use boxId as data; no funds move.
        uint256 boxId;
        /// @notice Readers get the factory's template id over version, type, offered parts and code hashes; no funds move.
        bytes32 templateId;
        /// keccak256(abi.encode(spec)) of format 2's `BoxSpec` (box-spec-v2-draft.md § 2).
        /// @dev Encoders/readers use specHash as data; no funds move.
        bytes32 specHash;
        /// @dev Encoders/readers use creator as data; no funds move.
        address creator;
        /// The pricing listing the box was created on (field 10; listing id 0 = native ETH).
        /// @dev Encoders/readers use pricingListingId as data; no funds move.
        uint32 pricingListingId;
        /// The pricing token P (address(0): native ETH).
        /// @dev Encoders/readers use q as data; no funds move.
        address q;
        /// The raise in P's raw units.
        /// @dev Encoders/readers use raise as data; no funds move.
        uint256 raise;
        /// @dev Encoders/readers use poolManager as data; no funds move.
        address poolManager;
        /// @dev Encoders/readers use poolId as data; no funds move.
        bytes32 poolId;
        /// @dev Encoders/readers use creationBlock as data; no funds move.
        uint256 creationBlock;
        /// @dev Encoders/readers use openAt as data; no funds move.
        uint256 openAt;
        /// @dev Encoders/readers use randomness as data; no funds move.
        address randomness;
        address[24] contracts;
        bytes32[24] codeHashes;
    }

    /// @notice A box was created and recorded (`record` as `recordOf(boxId)` returns it in the creation block).
    event BoxCreated(uint256 indexed boxId, bytes32 indexed templateId, bytes32 indexed specHash, BoxRecordV2 record);
    /// @notice The spec emitted by `createBox`: format 2's `BoxSpec`, ABI-encoded; keccak256(encodedSpec) == specHash.
    /// The description, the link, the table and the `tokenURI` texts are kept only here and in the chunks.
    event BoxSpec(uint256 indexed boxId, bytes encodedSpec);

    /// @notice The caller is not the registry factory ; refusal reverts all money movement.
    error NotFactory(address caller);
    /// @notice The factory tried to record a coordinator twice ; refusal reverts all money movement.
    error AlreadyRecorded(address coordinator);
    /// @notice The factory supplied a coordinator with a different id ; refusal reverts all money movement.
    error BoxIdMismatch(uint256 expected, uint256 named);
    /// @notice The factory spec hash differs from the coordinator commitment ; refusal reverts all money movement.
    error SpecHashMismatch(bytes32 encoded, bytes32 coordinators);
    /// @notice The caller requested an unrecorded box ; refusal reverts all money movement.
    error UnknownBox(uint256 boxId);
    /// @notice The caller requested an out-of-range role ; refusal reverts all money movement.
    error UnknownRole(uint256 role);
    /// @notice Neither this registry (0) nor an entry of the fixed directory.
    error UnknownRegistry(uint8 registryIndex);

    /// @notice The factory only, once per box, inside `createBox`: records `coordinator` as box `boxCount()`, emits
    /// Moves no funds. Emits `BoxCreated` and `BoxSpec`. Refuses a spec whose hash differs from the coordinator's `specHash()`.
    function record(address coordinator, bytes32 templateId, bytes calldata encodedSpec)
        external
        returns (uint256 boxId);

    /// @notice Factory v2 (fixed at construction).
    /// @dev Anyone may read factory; no funds move.
    function factory() external view returns (address);
    /// @notice 2: core v2, the box protocol's version 2 (box-spec-v2-draft.md § 1).
    /// @dev Anyone may read VERSION; no funds move.
    function VERSION() external view returns (uint16);
    /// @notice 24 (`BoxRolesV2.ROLE_COUNT`).
    /// @dev Anyone may read ROLE_COUNT; no funds move.
    function ROLE_COUNT() external view returns (uint256);
    /// @notice Boxes recorded so far; ids run from 0 to boxCount() - 1.
    /// @dev Anyone may read boxCount; no funds move.
    function boxCount() external view returns (uint256);
    /// @notice A recorded box's coordinator (reverts `UnknownBox` beyond the count). Same shape as v1's.
    /// @dev Anyone may read coordinatorOf; no funds move.
    function coordinatorOf(uint256 boxId) external view returns (address);
    /// @notice Whether `coordinator` is a box this registry recorded, and its id. Same shape as v1's.
    /// @dev Anyone may read boxIdOf; no funds move.
    function boxIdOf(address coordinator) external view returns (bool recorded, uint256 boxId);
    /// @notice What the registry stores for a box.
    /// @dev Anyone may read entry; no funds move.
    function entry(uint256 boxId)
        external
        view
        returns (address coordinator, uint256 creationBlock, bytes32 templateId, bytes32 specHash, bytes32 recordHash);
    /// @notice The box's record rebuilt from the chain now; keccak256(abi.encode(recordOf(id))) == the stored hash.
    /// @dev Anyone may read recordOf; no funds move.
    function recordOf(uint256 boxId) external view returns (BoxRecordV2 memory);
    /// @notice One role's address for a box (zero when the box does not use it); `UnknownRole` from 24 on.
    /// @dev Anyone may read roleOf; no funds move.
    function roleOf(uint256 boxId, uint256 role) external view returns (address);
    /// @notice The earlier registries this release reads, in index order from 1, fixed at deployment.
    /// @dev Anyone may read directory; no funds move.
    function directory() external view returns (address[] memory);
    /// @notice 0: this registry; i ≥ 1: `directory()[i - 1]`; otherwise `UnknownRegistry`.
    /// @dev Anyone may read registryAt; no funds move.
    function registryAt(uint8 registryIndex) external view returns (address);
}
