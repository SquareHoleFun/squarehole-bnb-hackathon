// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxSpecV1} from "../BoxSpecV1.sol";

/// @title IBoxFactoryV1 (slice S7; one per chain)
/// @notice Factory version 1: it creates **box 0, the Misfits, and nothing else** (launch pipeline v1 § 3.1, BC-064),
/// from box 0's BoxSpec, once, for the creator fixed at its deployment. Version 2 (S11) is a separate factory beside it
/// (R F72: versions beside versions); it refuses to create until box 0 exists.
///
/// `createBox(spec, hookSalt, executorCode)` with exactly the bootstrap (0.0015 ETH), in one transaction:
/// 1. **Checks, before anything is created:** the caller is the box-0 creator and no box exists; the spec's openAt at
///    most 14 days after this block (`OpenAtTooFar`; F80: the horizon needs the block's time); `BoxSpecV1.validate()`
///    under version 1's context (every text by its string rule, the metadata table's format, the add-ons, the menu, Q
///    and its raise; `InvalidSpec(reason, field)`); the template-0 rules (`NotTemplate0(field)`; since the S7 × S8
///    integration they include the per-item stream, PER_ITEM_STREAM with add-on 2); the value; FIT's executor code
///    against the hash fixed at deployment; the hook salt against the hook's address flags 0x2AE0 (`HookSaltNotMined`).
/// 2. **Creation:** the coordinator clone with CREATE at this factory's nonce 2 (the registry took nonce 1), so its
///    address, and every address it creates by nonce, is fixed at this factory's deployment and independent of the
///    spec (BC-064: openAt, the reveal data and the table can be fixed up to the creation); then the
///    coordinator's `deploy` (metadata table, T, vault, collection, receiver, launch router, FIT's executor, tickets,
///    the per-item stream, the royalty router, then the hook clone at its mined CREATE2 address) and `launch` (the
///    pinned initialise order, the stream last, the curve, the bootstrap buy burned). The hook's address also follows the spec's openAt (a hook argument),
///    so its salt is mined over the final init code (`hookInitCodeHash`).
/// 3. **Re-reads** (MisfitsGenesis's and FitPoolGenesis.verify's checks, adapted to D1/D2 and core v1; `Miswired`):
///    first the code, since a CREATE address says nothing about it (every clone the coordinator created is a clone of
///    the version's implementation, the royalty router the receiving variant; review of the Misfits line), then the
///    wiring and values that bear trust, FIT's executor's and the tickets' (the pinned source) included.
/// 4. **Record:** the registry writes the box (`BoxCreated` with every contract and its code hash, `BoxSpec`).
/// @dev No owner, admin, pause, upgrade, setter or rescue (F23 C2); `createBox` is the only state-changing entry point.
interface IBoxFactoryV1 {
    /// @notice The version's implementations (each deployed once; every one but the royalty router names the coordinator
    /// implementation, whose `factory` is this factory; the per-item stream's also the PoolManager).
    struct Implementations {
        address coordinator;
        address hook;
        address launchRouter;
        address receiver;
        address collection;
        address vault;
        address tickets;
        address royaltyRouter;
        /// The per-item stream (add-on 2, S8; box 0's only).
        address itemStream;
    }

    /// @notice Box 0's addresses, fixed at this factory's deployment (all but the hook's, which follows its mined
    /// salt and the spec's openAt). The royalty router exists only when the spec carries the royalties add-on;
    /// the per-item stream always (template 0 requires it).
    struct Box0Addresses {
        address coordinator;
        address table;
        address token;
        address vault;
        address collection;
        address receiver;
        address launchRouter;
        address executor;
        address tickets;
        /// The per-item stream (add-on 2, S8).
        address itemStream;
        address royaltyRouter;
    }

    // ------------------------------------------------------------------ construction
    error ZeroAddress();
    error NoCode(address account);
    /// @notice The randomness source is not this chain's pinned BoxBackedSource, or the DrandSource it names is not this
    /// chain's pinned DrandSource (address and code hash; BC-101, F143).
    error SourceNotPinned(address source);
    /// @notice An implementation is not wired to this version (`which`: the IMPL_* index of the failing check).
    error ImplementationMiswired(uint256 which);

    // ------------------------------------------------------------------ createBox refusals
    error NotBox0Creator(address caller);
    /// @notice Version 1 creates box 0 once.
    error Box0Exists();
    /// @notice `BoxSpecV1.validate()` under version 1's context refused the spec (its reason and field ids).
    error InvalidSpec(uint16 reason, uint16 field);
    /// @notice A version-1-valid spec that is not template 0 (the field id of the first rule it breaks).
    error NotTemplate0(uint16 field);
    /// @notice The spec's openAt is after `latest`, this block's time + BoxSpecV1.MAX_OPEN_AHEAD_SECONDS (14 days; F80).
    error OpenAtTooFar(uint256 openAt, uint256 latest);
    error WrongValue(uint256 sent, uint256 required);
    /// @notice `executorCode` is not the creation code whose hash this factory fixed at deployment.
    error ExecutorCodeMismatch(bytes32 codeHash);
    /// @notice The salt does not put the hook at an address with exactly the flags 0x2AE0 and without the 0x91 prefix.
    error HookSaltNotMined(address hook);
    /// @notice A re-read after the launch failed (`check`: the MW_* id).
    error Miswired(uint256 check);

    /// @notice Creates box 0 from `spec` (see the contract notes). Send exactly `BoxSpecV1.BOOTSTRAP_ETH`.
    /// @param hookSalt mined over `hookInitCodeHash(spec.openAt)` with deployer `box0Addresses().coordinator`
    /// @param executorCode `type(FitBuybackExecutor).creationCode` (its hash is `executorInitCodeHash()`); passed in
    /// rather than held here, so this factory stays within EIP-170
    function createBox(BoxSpecV1.BoxSpec memory spec, bytes32 hookSalt, bytes calldata executorCode)
        external
        payable
        returns (uint256 boxId, address coordinator, address hook);

    /// @notice The revert data `createBox` would give for `spec` and `caller` at this moment for the checks of step 1
    /// that read only the spec, the caller, the registry and the block's time (empty: accepted); the value, the
    /// executor code and the salt are checked separately.
    function refusal(BoxSpecV1.BoxSpec memory spec, address caller) external view returns (bytes memory);
    /// @notice The template id `createBox` records for `spec` (BC-013).
    function templateIdOf(BoxSpecV1.BoxSpec memory spec) external view returns (bytes32);
    /// @notice Box 0's addresses (see `Box0Addresses`).
    function box0Addresses() external view returns (Box0Addresses memory);
    /// @notice keccak256 of box 0's hook init code for `openAt` (the salt miner's input; deployer: box 0's
    /// coordinator).
    function hookInitCodeHash(uint32 openAt) external view returns (bytes32);
    /// @notice The hook's address for `openAt` and `hookSalt`.
    function predictHook(uint32 openAt, bytes32 hookSalt) external view returns (address);

    function VERSION() external view returns (uint16);
    function registry() external view returns (address);
    function poolManager() external view returns (address);
    function randomness() external view returns (address);
    function weth() external view returns (address);
    /// @notice The platform Safe: box 0's receiver pays the platform's capped 2/15 to it (F62, F64, F77), and box 0's
    /// spec must name it as its marketplaceOwner (F44).
    function platformSafe() external view returns (address);
    /// @notice The only address that may call `createBox` (our deployer; BC-064).
    function box0Creator() external view returns (address);
    /// @notice keccak256 of FIT's executor's creation code (no constructor arguments).
    function executorInitCodeHash() external view returns (bytes32);
    /// @notice keccak256 of the version's code: every implementation's and extension's code hash and T's creation code.
    function versionCodeHash() external view returns (bytes32);
    function implementations() external view returns (Implementations memory);
    function hookExtension() external view returns (address);
    function receiverExtension() external view returns (address);
}
