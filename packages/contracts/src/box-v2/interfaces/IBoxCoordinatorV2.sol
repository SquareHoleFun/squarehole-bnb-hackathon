// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IBoxCoordinator} from "../../box/interfaces/IBoxCoordinator.sol";
import {BoxSpec} from "./SpecTypes.sol";
import {QParameters} from "./IListingRegistry.sol";

/// @notice What the coordinator's chunk loader takes after creation (ADR-0017 § 6, F96 R20C): the spec's metadata
/// table (field 21), and the other texts `tokenURI` reads (the hidden SVG, the placeholders' and the edition specials'
/// texts) in the one encoding M1-10's generated library gives them. 0 is never a member (BoxSpecV1.sol:15's rule).
enum ChunkPart {
    None,
    Table,
    Texts
}

/// @notice Why a box failed.
enum FailCause {
    None,
    /// @dev The deadline (the effective open + `deadlineDays`) passed with the curve still open.
    Deadline,
    /// @dev The open gate still held `GATE_CAP_SECONDS` after the spec's open (a chunk or, from M2, the starter set
    /// never arrived).
    ClosedPastCap,
    /// @notice Anyone may close a filled box seven days after fill if it has not graduated; enters the same P claim.
    GraduationTimedOut
}

// The longest the open gate may hold a box after its `openAt` before anyone may fail it: first value 14 days
// (ADR-0017 § 6) [P]. Another value is a change-queue item (tickets § 9), never a new name.
/// @dev Encoders/readers use GATE_CAP_SECONDS as data; no funds move.
uint256 constant GATE_CAP_SECONDS = 14 days;

// The `openAt()` the hook, the launch router and the tickets report while the gate holds: no block reaches it, and it
// fits the 40 bits v1's router packs the open into (`BoxLaunchRouter.sol:86`).
/// @dev Encoders/readers use GATE_CLOSED_OPEN_AT as data; no funds move.
uint256 constant GATE_CLOSED_OPEN_AT = type(uint40).max;

/// @title IBoxOpenGateV2 (ticket M1-00; ADR-0017 § 6)
/// @notice The open as the hook, the launch router and the tickets take it: only from the coordinator. At `initialize`
/// each reads the coordinator's gate: open, it takes `effectiveOpenAt()` (the spec's open); holding, it stores
/// `GATE_CLOSED_OPEN_AT`. When the gate opens later, the coordinator calls `setOpen(t)` on each, once, with t its
/// `effectiveOpenAt()`. The launch window and its tax start at t, and the tickets allow `take()` from t, not from the
/// spec's `openAt` as v1's tickets keep it (`BoxTickets.sol:86`, `:112-115`). The swap path reads nothing new.
interface IBoxOpenGateV2 {
    /// @notice The gated part took its open from the coordinator.
    event OpenSet(uint256 openAt);

    /// @notice A second `setOpen`, or one on a part that took its open at `initialize`.
    error OpenAlreadySet();

    /// @notice The box's coordinator only, once, while this part reports GATE_CLOSED_OPEN_AT; no money moves.
    function setOpen(uint256 openAt) external;
}

/// @title IBoxCoordinatorV2 (ticket M1-00 freezes it; M1-30, M1-31 and M1-32 build it)
/// @notice One box's launcher, graduation and failure: v1's coordinator (`IBoxCoordinator`, kept whole: copy, never
/// edit, ADR-0017 § 10) with P any listed token (M1-30) and these additions, all built in M1 unless marked:
/// - **Open gate** (ADR-0017 § 6, F96 R20C). The box opens at the spec's `openAt` if every chunk is in by then, else
///   at the block after the last one: `effectiveOpenAt()` = max(`openAt()`, the completing block's time + 1). From M2
///   a box with a starter set also waits for `starterSetLoaded()` from role 19. Until the gate opens, the hook, the
///   router and the tickets report `GATE_CLOSED_OPEN_AT` (`IBoxOpenGateV2`). A token-only box, or one with no table
///   and no texts or starter loader, is open at creation.
/// - **Chunk loader.** Hash rule, per part: the part's bytes are cut into chunks of exactly `CHUNK_MAX()` bytes, the
///   last one 1 to `CHUNK_MAX()`; h_n = bytes32(0) and h_i = keccak256(abi.encodePacked(chunk_i, h_{i+1})). The factory
///   computes h_0 from the spec inside `createBox` and keeps it with the part's length (`chunkRoot`; bytes32(0): no
///   such part). `loadChunk` accepts chunk i with h_{i+1} only if keccak256(abi.encodePacked(data, nextHash)) equals
///   the stored next hash, then stores `nextHash`; the part is complete when that is zero. So each chunk is checked on
///   arrival, anyone may send the right one, a wrong one is refused (`ChunkHashMismatch`), and no order but the
///   spec's can load. Each chunk is kept as data code (0x00 ‖ bytes, as v1's table) at `chunkPointer`.
/// - **Deadline** (box-spec-v2-draft.md field 16): `deadline()` = `effectiveOpenAt()` + `deadlineDays()` days, known at
///   creation whenever the chunks are in before the open.
/// - **Failure** (Amendment 3 C11, amended by F122/F123): the pot lives in the coordinator as P claims.
///   Anyone may fail an unfilled box at its deadline, a held gate after GATE_CAP_SECONDS, or a filled box still
///   ungraduated seven days after hook.closedAt(). Graduation refuses a failed box. Each path is nonReentrant,
///   refuses entry during a foreign PoolManager unlock, and runs atomically in this order:
///   1. Record failure, its time and cause, and emit BoxFailed.
///   2. Call hook.close() directly. It distributes final curve fees before removal, sends the reserve to the
///      coordinator and buyers' fees to the receiver, removes the curve, transfers P claims to the coordinator,
///      burns unsold/held T fail-safe, and sets the hook's failed bit.
///   3. Sweep the launch router fail-safe: any caller's failed-box tax sweep belongs to this coordinator.
///   4. Call vault.enterFailure() directly, freezing its quote and opening the placeholder hand-back window.
///   5. The graduation reserve is split as fees through the receiver (F122). Call receiver.enterFailure() directly
///      after close: drain the final sale counter and book the remaining P using the per-side fee split. Keep,
///      burn, pool share, held P royalties and held items money join the pot; grow/carries join the pot; already owed
///      FIT/platform balances remain owed. Non-P royalties stay in the royalty router for its creator payee
///      in every phase (RC5 C). Price-coin royalties follow the receiver's phase and destination rules.
///   6. Burn the coordinator's pool-share T fail-safe.
///   7. Read the final balances once. H is T held by coordinator/hook/receiver plus their PoolManager T claims.
///      A shop adds its frozen T balance and T claims to H, with K = 0. Excluded shop T can only burn.
///      K is the frozen share-vault escrow surplus (zero with no vault or a reverting surplus view);
///      K' = min(K, T.balanceOf(vault)). Emit EscrowSurplusClipped if clipped, and fix tLeft = supply - H - K'
///      exactly, with no saturation. Emit PotFixed with the current pot and min(hook.deepenTipCap(), pot).
///   8. Pay the closer's tip last as real P in a separate capped unlock. Refusal leaves it in the pot.
///   The sweep, burns and tip are fail-safe with fixed stipends and an EIP-150 gas pre-check; insufficient gas
///   reverts the entire failure. All other steps are direct; any revert undoes the transition for a later retry.
///   RC5-A (founder 2026-10-15): claims have no expiry. Sweep tax fail-safe first, pay floor(pot * t / tLeft)
///   from the live pot, and pay the last holder the whole balance. Pull only caller T, reduce tLeft before payment,
///   and burn fail-safe. A paused P or refusing recipient reverts only that claim. If no coins were outstanding,
///   the initial no-holder remainder belongs to the creator, fixed at failure (the known pot less the paid tip) and
///   claimable with t = 0 forever; RC6 inbox P delivered later is added to it and reopens that claim (creditInbox).
///   Late receiver P joins the pot on collect (no tip); every claim first attempts the inbox sweep and that collect.
///   No live recount: burned, lost or gifted coins stay in tLeft, reduced only by successful claims.
///   Unpresented shares and receipts after the last claim stay where they are forever, with no function to move them.
///   There is no pot sweep to FIT; pre-failure FIT/platform fee debts remain owed, including the D6 fee split.
/// - **The launch's payment** (wave 0's integrated review, M2): `launch()` is v1's, called by the factory once inside
///   `createBox`. In an ETH-priced box `msg.value` is exactly the bootstrap plus the creator buy, as v1's
///   (`BoxCoordinator.sol:199-202`, `WrongValue`). For an ERC-20 P `msg.value` is 0: the factory approves the coordinator
///   for exactly `bootstrapQ` plus the creator buy, and `launch()` pulls that by `transferFrom` with its own balance
///   change checked (`ShortTransfer`, the factory's and the router's error), so P sent to the coordinator's address
///   before creation is never counted; then it approves the launch router for each amount, and the router's
///   `bootstrap()` and `creatorBuy(creator, qIn)` (msg.value 0) pull it with their balance change checked [P].
/// - No owner, admin, pause, upgrade, setter or rescue (F23 C2); every new entry point is open to anyone or to one
///   named role.
interface IBoxCoordinatorV2 is IBoxCoordinator {
    /// @notice One chunk loaded: its part, its index from 0, the data contract holding it, its length, and whether
    /// it completed the part.
    event ChunkLoaded(ChunkPart indexed part, uint256 indexed index, address pointer, uint256 length, bool partDone);
    /// @notice The gate opened: the box's effective open and its deadline. Emitted once, inside `createBox` when the
    /// gate is open at creation, else by the call that completes it.
    event BoxOpenSet(uint256 effectiveOpenAt, uint256 deadline);
    /// @notice The box failed (`fail()` or `failClosed()`), once.
    event BoxFailed(address indexed caller, FailCause cause, uint256 timestamp);
    /// @notice M2: role 19 reported the starter set loaded.
    event StarterSetLoaded(address indexed loader);

    /// @notice An entry point a later milestone builds (M2's starter-set gate entry), refused in M1's release.
    error NOT_OFFERED();
    /// @notice The caller named an unsupported chunk part; refusal reverts all money movement.
    error UnknownPart(ChunkPart part);
    /// @notice The part is complete, or the box has none.
    error PartComplete(ChunkPart part);
    /// @notice keccak256(abi.encodePacked(data, nextHash)) is not the part's stored next hash.
    error ChunkHashMismatch(ChunkPart part, uint256 index, bytes32 expected, bytes32 found);
    /// @notice The caller attempted failure before the deadline; refusal reverts all money movement.
    error DeadlineNotReached(uint256 deadline);
    /// @notice `failClosed()` on a box whose gate is open.
    error GateNotHolding();
    /// @notice The caller attempted gate failure before its cap; refusal reverts all money movement.
    error GateCapNotReached(uint256 failableAt);
    /// @notice The caller repeated failure; refusal reverts all money movement.
    error AlreadyFailed();
    /// @notice Filled curve cannot fail until its seven-day graduation hatch; no money moves on refusal.
    error CurveClosed();
    /// @notice The caller is not the fixed starter-set loader; refusal reverts all money movement.
    error NotStarterSetLoader(address caller);

    /// @notice Anyone after failure, without expiry: sweep the inbox's P and tax, and collect receiver P, each fail-safe,
    /// then pay floor(pot * t / tLeft); the last holder share takes the rest and waits while inbox P remains.
    /// Pulls only caller T. Only the creator claims the initial no-holder remainder with t = 0, plus later inbox intake.
    /// Subsequent money joins the holder pot. Unpresented shares and money after the last holder claim remain locked forever.
    function claim(uint256 t, address to) external returns (uint256 p);
    /// @notice Fixed inbox only, after exact P delivery: add to a no-holder creator remainder, even after a claim.
    /// Live/holder boxes keep their ordinary pot accounting. No funds move and no external calls are made here.
    function creditInbox(uint256 amount) external;
    /// @notice Anyone previews available pot and collectable receiver P; unswept hook/router money is excluded.
    /// Creator and final holder quotes also include readable inbox P, conditional on successful intake at claim.
    /// Partial holder quotes exclude pending inbox P. Unreadable inboxes refuse only the final holder quote.
    function quoteClaim(uint256 t) external view returns (uint256 p);
    /// @notice Anyone reads available holder pot plus collectable failed-receiver P and fixed unclaimed T count.
    /// With no buyers, also previews readable pending inbox P; locked pot remains visible. No funds move or expiry.
    function claimState() external view returns (uint256 pot, uint256 tLeft);
    /// @notice Atomic failure fixes tLeft = supply - held T - min(K, vault balance); tip is real P paid last.
    event PotFixed(uint256 pot, uint256 tLeft, uint256 tip, address indexed closer);
    /// @notice Claim caller T was surrendered and P paid to recipient; amount uses the live pot before this claim.
    event Claimed(address indexed holder, address indexed to, uint256 t, uint256 p);
    /// @notice Failure excludes only the vault balance when K exceeds it; no transfer by this event.
    event EscrowSurplusClipped(uint256 k, uint256 kPrime);
    /// @notice Reject entry from another PoolManager unlock; atomic, no money moves.
    error ForeignUnlock();
    /// @notice Reject zero/excess T or zero recipient, except the creator's no-holder t = 0 claim.
    /// Atomic refusal; no money moves.
    error InvalidClaim();
    /// @notice Refuse claim before failure; no money moves.
    error NotFailed();
    /// @notice Anyone attempting the filled-curve hatch too early; no money moves.
    error GraduationEscapeNotReached(uint256 failableAt);

    // ------------------------------------------------------------------ open gate and chunks

    /// @notice Anyone: loads the next chunk of `part` (see the hash rule above); no money moves.
    /// Completes the gate when this is the last missing piece: `setOpen` on the hook, the router and the tickets, then `BoxOpenSet`.
    function loadChunk(ChunkPart part, bytes calldata data, bytes32 nextHash)
        external
        returns (uint256 index, bool partDone);
    /// @notice M2: role 19 only, once, when the spec's starter set is in, checked against its set hash by the loader
    /// (F86 J). No-loader boxes refuse (`NOT_OFFERED`). Completion cannot reopen a failed box; no funds move.
    function starterSetLoaded() external;

    // ------------------------------------------------------------------ failure

    /// @notice Anyone: atomically close an unfilled expired box, or a filled ungraduated box after seven days
    /// since hook.closedAt(). Calls close, splits the reserve as fees, routes P to claims and pays a capped tip last.
    function fail() external;
    /// @notice Anyone, once, from `openAt()` + `GATE_CAP_SECONDS` while the gate still holds; the same path and tip.
    function failClosed() external;

    // ------------------------------------------------------------------ views

    /// @notice The spec's open (Unix seconds), or the creation block's time + 1 when the spec said Now or a time
    /// already reached (F80). Fixed at creation; the registry records it.
    /// @dev Anyone may read openAt; no funds move.
    function openAt() external view returns (uint256);
    /// @notice Whether every chunk is in and, from M2, the starter set.
    /// @dev Anyone may read gateOpen; no funds move.
    function gateOpen() external view returns (bool);
    /// @notice The open the hook, router and tickets use; 0 while the gate holds.
    /// @dev Anyone may read effectiveOpenAt; no funds move.
    function effectiveOpenAt() external view returns (uint256);
    /// @notice `effectiveOpenAt()` + `deadlineDays()` days; 0 while the gate holds.
    /// @dev Anyone may read deadline; no funds move.
    function deadline() external view returns (uint256);
    /// @notice 30, 60, 90 or 180 (field 16).
    /// @dev Anyone may read deadlineDays; no funds move.
    function deadlineDays() external view returns (uint256);
    /// @notice `GATE_CAP_SECONDS`.
    /// @dev Anyone may read GATE_CAP; no funds move.
    function GATE_CAP() external view returns (uint256);
    /// @notice The chunk size of the hash rule: the spec library's `CHUNK_MAX`, which M1-60 sets.
    /// @dev Anyone may read CHUNK_MAX; no funds move.
    function CHUNK_MAX() external view returns (uint256);
    /// @notice What the factory kept for `part`: h_0 and the part's length in bytes (both 0: no such part).
    /// @dev Anyone may read chunkRoot; no funds move.
    function chunkRoot(ChunkPart part) external view returns (bytes32 root, uint256 length);
    /// @notice The hash the next chunk must meet (0: complete), chunks loaded, chunks in all.
    /// @dev Anyone may read chunkState; no funds move.
    function chunkState(ChunkPart part) external view returns (bytes32 nextHash, uint256 loaded, uint256 total);
    /// @notice The data contract of a loaded chunk (0x00 ‖ bytes); the collection reads its table and texts here.
    /// @dev Anyone may read chunkPointer; no funds move.
    function chunkPointer(ChunkPart part, uint256 index) external view returns (address);
    /// @notice Whether a wired role 19 still owes completion; false on plain M1 boxes. No funds move.
    /// @dev Anyone may read starterSetPending; no funds move.
    function starterSetPending() external view returns (bool);
    /// @notice Role 19, or address(0).
    /// @dev Anyone may read starterSetLoader; no funds move.
    function starterSetLoader() external view returns (address);
    /// @dev Anyone may read failed; no funds move.
    function failed() external view returns (bool);
    /// @dev Anyone may read failedAt; no funds move.
    function failedAt() external view returns (uint256);
    /// @dev Anyone may read failCause; no funds move.
    function failCause() external view returns (FailCause);
    /// @notice Anyone reads the permanent pricing row id snapshotted at creation; no funds move.
    function pricingListingId() external view returns (uint32);
    /// @notice Registry v2 of this release.
    /// @dev Anyone may read registry; no funds move.
    function registry() external view returns (address);
    /// @notice The release's listing registry.
    /// @dev Anyone may read listingRegistry; no funds move.
    function listingRegistry() external view returns (address);
    /// @notice The box's part at a `BoxRolesV2` role (address(0) when unused); the registry builds its record here.
    /// @dev Anyone may read roleAddress; no funds move.
    function roleAddress(uint256 role) external view returns (address);
}

/// @title IBoxFactoryV2 (CQ11-D builds the frozen creation shape)
/// @notice Anyone creates a box from a valid format 2 menu spec, atomically:
/// 1. Read the permanent manual listing and require spec.raise to equal its current raise; snapshot it in the
///    box's arguments and record. Later updateRaise affects only future boxes. Validate the offered menu,
///    FULL_RANGE graduation and the open time (at most 14 days ahead). Refuse unsupported choices and add-ons.
/// 2. Create the coordinator with CREATE2 salt keccak256(abi.encode(caller, specHash, coordinatorSalt)); its first
///    CREATE (nonce 1) makes T. Require P < T < tokenAddressLimit(P); mine the hook for flags 0x2AE0 and construct
///    its fixed-fee key with fee 10_000. Create only the parts offered by the spec, with fixed release code.
/// 3. Require exactly bootstrap plus creator buy in native P, or pull that exact ERC-20 P from the caller with
///    msg.value zero and balance-delta checks. Pass it to coordinator.launch(), which funds the launch router.
/// 4. Keep the spec hash and chunk roots/lengths; verify each part's wiring and record the immutable box and raise.
///    The registry emits the encoded spec. The receiver fixes FIT_SAFE and PLATFORM_SAFE; deployment verifies
///    both Safes. Every royalty box names a creator payee for non-P in-kind exits.
/// All transfers revert with creation on failure. No owner, admin, pause, upgrade or rescue.
interface IBoxFactoryV2 {
    /// @notice `validate()` refused the spec: format 2's reason and field ids (box-spec-v2-draft.md § 7).
    error InvalidSpec(uint16 reason, uint16 field);
    /// @notice T at or above the midpoint between P and the top of the address space (ADR-0017 § 4).
    error T_TOO_HIGH(address token, address limit);
    /// @notice T at or below P, so P would not be currency0 (the hook refuses it too, `BoxHook.sol:122`).
    error TokenNotAboveQ(address token, address q);
    /// @notice The creator named an open more than 14 days ahead; refusal reverts all money movement.
    error OpenAtTooFar(uint256 openAt, uint256 latest);
    /// @notice The caller sent the wrong native value; refusal reverts all money movement.
    error WrongValue(uint256 sent, uint256 required);
    /// @notice The caller payment did not increase the recipient balance by the required amount; refusal reverts all money movement.
    error ShortTransfer(address token, uint256 expected, uint256 received);
    /// @notice The creator supplied a hook salt with wrong address flags; refusal reverts all money movement.
    error HookSaltNotMined(address hook);
    /// @notice The factory reread a part inconsistent with the creation plan; refusal reverts all money movement.
    error Miswired(uint256 check);

    /// @notice Anyone funds bootstrap and creator buy in P and creates a box from `spec` (see the contract notes). Returns its id in registry v2.
    /// @param coordinatorSalt mined first so T lands above P and below `tokenAddressLimit(P)` (two hashes a try)
    /// @param hookSalt mined after, over the final hook init code, for the hook's address flags
    function createBox(BoxSpec calldata spec, bytes32 coordinatorSalt, bytes32 hookSalt)
        external
        payable
        returns (uint256 boxId, address coordinator, address hook);

    /// @notice Anyone predicts coordinator/T and the hook init-code hash for the current listing raise; no funds move.
    /// A raise update can change the hash; the factory rechecks the spec's raise at creation.
    function predictBox(address creator, BoxSpec calldata spec, bytes32 coordinatorSalt)
        external
        view
        returns (address coordinator, address token, bytes32 hookInitCodeHash);
    /// @notice The hook's address for these inputs.
    /// @dev Anyone may read predictHook; no funds move.
    function predictHook(address creator, BoxSpec calldata spec, bytes32 coordinatorSalt, bytes32 hookSalt)
        external
        view
        returns (address);
    /// @notice q + (2^160 − q) / 2 in integer arithmetic (q = address(0) for ETH): T must be below it.
    /// @dev Anyone may read tokenAddressLimit; no funds move.
    function tokenAddressLimit(address q) external pure returns (address limit);
    /// @notice The revert data `createBox` would give now for the checks that read only the spec, the caller, the
    /// release's listings and the block (empty: accepted).
    /// @dev Anyone may read refusal; no funds move.
    function refusal(BoxSpec calldata spec, address caller) external view returns (bytes memory);
    /// @notice Anyone reads the template id over the offered parts and their code hashes; no funds move.
    function templateIdOf(BoxSpec calldata spec) external view returns (bytes32);
    /// @notice Anyone reads the P amounts derived from the supplied creation raise and permanent pricing row;
    /// bootstrap, batch, tip and step amounts scale with that raise. No price reads or money movement.
    /// @dev Anyone may read boxQParameters; no funds move.
    function boxQParameters(uint32 pricingListingId, uint256 raise) external view returns (QParameters memory);

    /// @notice 2.
    /// @dev Anyone may read VERSION; no funds move.
    function VERSION() external view returns (uint16);
    /// @dev Anyone may read registry; no funds move.
    function registry() external view returns (address);
    /// @dev Anyone may read listingRegistry; no funds move.
    function listingRegistry() external view returns (address);
    /// @dev Anyone may read poolManager; no funds move.
    function poolManager() external view returns (address);
    /// @dev Anyone may read weth; no funds move.
    function weth() external view returns (address);
    /// @dev Anyone may read randomness; no funds move.
    function randomness() external view returns (address);
    /// @notice keccak256 of the version's code: every implementation's and extension's code hash, T's implementation
    /// included (F102: T is a clone, so no T creation code is kept or hashed; change queue 1).
    /// @dev Anyone may read versionCodeHash; no funds move.
    function versionCodeHash() external view returns (bytes32);
    /// @notice The version's implementation for a `BoxRolesV2` role: `ROLE_TOKEN` gives T's implementation, which every
    /// box's T clones (F102); address(0) for an unused or reserved role. No funds move.
    /// @dev Anyone may read implementation; no funds move.
    function implementation(uint256 role) external view returns (address);
}

/// @notice S5 declared factory companion; M3-32 implements it without changing existing IBoxFactoryV2 consumers.
/// @dev The coordinator caches this predicate once for its own role 3, after parts creation and before starter-gate
/// initialization; no setter. Check the complete standard-clone prefix against the release-pinned pile implementation
/// and exactly 112 argument bytes. Factory readbacks still authenticate full code/args against the validated spec.
/// This selects only the PILE failure exclusion: liquid/claims T joins H, Kprime is zero. Never infer it from
/// missing selectors, item counts or the loader; zero-seed piles have no loader. No seed-asset call during failure.
/// No shop exclusion or new funding/rescue path is introduced. Only recorded non-T seed returns to its creator;
/// Q4 keeps the disclosed no-rescue rule for failed surplus/unrelated assets pending release ratification.
interface IBoxFactoryPileV2 {
    /// @notice Anyone checks the release's exact pile-clone prefix/argument length; no funds move.
    /// @dev Returns false for zero, the implementation itself, shops, share vaults and other proxy layouts.
    function isPileVault(address candidate) external view returns (bool);
}
