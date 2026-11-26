// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Shared enums and structs of the box core v1 interfaces (docs/design/core-v1-interfaces.md). Every enum used on the
// wire or in an event starts with a `None` member at 0, as BoxSpecV1 does for its enums (src/box/BoxSpecV1.sol:11), so
// a zero value is never a valid choice. The two ticket enums keep MisfitsPlaceholders' order (src/v2/
// MisfitsPlaceholders.sol:54-68) because BoxTickets is a copy of it.

/// @notice Which money rules a box follows. Fixed per box at creation (a clone argument); nothing can change it.
enum BoxKind {
    None,
    /// @dev Box 0, the Misfits (F53), like every box's pool since F77: Q-side fees 11/15 to FIT's executor, 2/15 into
    /// its own pool by pair and lock, 2/15 to the platform Safe up to 32 ETH per 30-day epoch, the rest into its pool
    /// too (F62, F64); T-side fees 13/15 burned (or the per-item stream, S8), 2/15 into its pool; its launch tax goes
    /// into its pool after graduation (F77, superseding F68 (1b)). No creator buy, no failure path.
    Box0,
    /// @dev Every other box: 10/15 reward side, 3/15 FIT buy-and-burn, 2/15 into its own pool by pair and lock (F64,
    /// F68 (3), F72 (B)); its launch tax goes into the box (F68 (2a)); it never pays the platform (F64; BC-109).
    Standard
}

/// @notice One box's life as the coordinator reports it (`IBoxCoordinator.phase`). `Failed` exists only for
/// deadline boxes of version 2 (S11); no v1 box reaches it.
enum BoxPhase {
    None,
    /// @dev Before `openAt`: only the bootstrap and the creator buy (inside createBox) have traded.
    Upcoming,
    /// @dev block.timestamp in [openAt, openAt + 384) with the curve open: buys only through the box's launch router (taxed).
    Window,
    /// @dev After the window, the curve open: every route buys and sells at the 1% pool fee alone.
    Bonding,
    /// @dev A swap ended at or beyond P1 (close on fill, D1): every swap reverts until `graduate()`.
    Closed,
    /// @dev `graduate()` ran: the graduated layout (L7) is seeded, the vault gate is open.
    Graduated,
    /// @dev Version 2 only (S11): the deadline passed with the curve open and `fail()` ran.
    Failed
}

// How a payee's share of one fee side is paid (F72 (A)) is part of that side's stream value, not a separate mode
// (review of sh-core-v1, reconciled with main's BoxSpec, F70): Q_STREAM_TO_CREATOR and T_STREAM_TO_CREATOR pay as
// collected (buyers' fees in Q, sellers' fees in T, nothing sold); main's Q_STREAM_CREATOR_IN_T (6) and
// T_STREAM_CREATOR_IN_Q (6) convert by a bounded buy, or a bounded sell after graduation, through the box's swap
// module (S5: the receiver books them for the module since S5.M1, the module converts them from S5.M3 and refuses them
// before); *_HOLDERS_IN_* (7) pay holders (S14), and the receiver still refuses them (`ActionNotBuilt`).

/// @notice Where the receiver books a swap module's proceeds (`IBoxReceiver.moduleProceeds`; swap-module-v1 § 4.1
/// item 3). Each is at most the claims that arrived since the same transaction's `pullForModule`.
enum ModuleProceedsTo {
    None,
    /// @dev Q from a sell for FIT (W4, SELL_FOR_Q): FIT's owed Q (`fitOwed`), paid by `payFit()`.
    FitQ,
    /// @dev Q from a CREATOR_IN_Q sell: the creator payee's owed Q (add-on 5's cap: S5.M3).
    CreatorQ,
    /// @dev T from a CREATOR_IN_T buy: the creator payee's owed T.
    CreatorT
}

/// @notice The royalties add-on's destination (add-on 4; BoxSpecV1 ROYALTY_DESTINATION_*, same values).
enum RoyaltyDestination {
    None,
    /// @dev Into the box's fee handling: split like its Q-side trading fees (default; box 0's only choice, F65).
    FeeHandling,
    /// @dev Through the box's royalty router (which never refuses a payment) to its receiver's `fundCreator()`: credited
    /// to the one creator payee, who pulls it with `claimCreator` (F72 (3); review of sh-core-v1: a payee that refuses
    /// ETH can no longer make royalty-paying sales revert).
    Creator,
    /// @dev All into the box's own pool depth.
    PoolDepth
}

/// @notice The vault's actions at its STREAM HOOK points (src/v2/MisfitsVault.sol:342, 374, 607, 656), reported to
/// the vault observer before the count of items inside changes.
enum VaultAction {
    None,
    TicketsOpened,
    TicketsReleased,
    Withdrawn,
    Returned
}

/// @notice What one `deepen()` placed (BoxHook).
enum DepthKind {
    None,
    /// @dev Every box (box 0 since F77): a paired add of both sides at the current price (pair and lock, F72 (B)).
    /// F77 removed box 0's Q-only rung (dynamic-pool-share.md § 1.2, superseded), so Pair is 1. Also the kind of a call
    /// whose conversion brought the T side to MIN_ADD and paired in the same unlock (S5.M5).
    Pair,
    /// @dev S5.M5 (F76, every box since F77): a depth conversion alone. The T side was below MIN_ADD, so the call bought
    /// T with part of the unpaired Q inside the swap bounds (BoxSwapBounds); the T stays as the hook's claims (depth
    /// budget) until the pair reaches MIN_ADD (swap-module-v1 § 8).
    Convert
}

/// @notice Why one `deepen()` added nothing (it never reverts for these; BC-119). The budget stays.
enum DeepenSkip {
    None,
    NotGraduated,
    /// @dev Fewer than 300 blocks since the last add.
    Cooldown,
    /// @dev The price average has no full window yet.
    AverageNotReady,
    /// @dev The average's latest sample is more than 99 ticks from spot.
    AverageNotCaughtUp,
    /// @dev |spot − average| > 99 ticks.
    Deviation,
    /// @dev The Q side is below the minimum add (0.5% of the raise), or the pair's add cap is zero. Since S5.M5 a T side
    /// below it (valued at spot) converts instead (`DepthKind.Convert`).
    BudgetBelowMin,
    /// @dev S5.M5: the conversion the T side needs would run alone below DEPTH_CONVERT_MIN_Q (0.005 ETH), or has no room
    /// left before the band (t_ref − 99 ticks); a conversion expected to pair in the same unlock has no separate
    /// minimum (swap-module-v1 § 8 rule 4). Since the S5 review the minimum is checked on what the swap can spend
    /// before its limit (min(its ceiling, the room)), so a sliver of room is this skip, which starts no cooldown.
    ConvertBelowMin
}

/// @notice The tickets add-on's phase (MisfitsPlaceholders.Phase, src/v2/MisfitsPlaceholders.sol:54-60).
enum TicketPhase {
    BeforeOpen,
    Curve,
    AwaitingWord,
    Drawing,
    Terminal
}

/// @notice One draw ticket's status (MisfitsPlaceholders.DrawStatus, src/v2/MisfitsPlaceholders.sol:62-68).
enum DrawStatus {
    None,
    Requested,
    Settled,
    Opened,
    Cancelled
}

/// @notice An item's committed reveal data (`IBoxCollection.reveal`; MisfitsPlaceholders.Reveal,
/// src/v2/MisfitsPlaceholders.sol:72-79). An empty proof means "open without the reveal", allowed only after the
/// reveal fallback.
struct ItemReveal {
    uint128 traitsPacked;
    bytes32 imageHash;
    bytes32 avatarHash;
    bytes32 modelHash;
    bytes32 salt;
    bytes32[] proof;
}

/// @notice One fee batch as the receiver splits it (raw units of Q and T).
struct FeeBatch {
    /// @dev Q-side fees harvested from the box's positions in this batch, before the reserve and the tip.
    uint256 q;
    /// @dev T-side fees harvested in this batch.
    uint256 t;
    /// @dev Of `q`, the part the hook minted to the coordinator's graduation reserve (D6; zero after graduation).
    uint256 qToReserve;
    /// @dev Of `q`, the caller's tip (D2): min(10% of the batch, the version's cap).
    uint256 tip;
}
