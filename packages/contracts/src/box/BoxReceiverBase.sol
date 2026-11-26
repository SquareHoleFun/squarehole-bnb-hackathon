// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {TransientReentrancyGuard} from "../libraries/TransientReentrancyGuard.sol";
import {BoxCloneReader} from "./BoxCloneReader.sol";

/// @title BoxReceiverBase (slice S5; split in S5.M1, docs/design/swap-module-v1.md § 7)
/// @notice What both halves of every box's receiver share: the storage layout, the clone argument offsets and the
/// bits of the state word. S5.M1's size gate (§ 7: at most 22,500 bytes with S5.M3's cap ledger) split the receiver
/// as the hook is split: `BoxReceiver` (the hot half: batches, splits, payouts, the swap module's hand-off, the views)
/// runs the cold entry points (`initialize`, the payee changes; S11's failure release later) in
/// `BoxReceiverExtension`, a fixed DELEGATECALL target named in its code. Both halves run in the clone's context, so
/// they read the same storage, the same clone arguments and the same transient reentrancy lock.
/// @dev Only this contract declares storage; neither half adds any, so the layout is one.
abstract contract BoxReceiverBase is TransientReentrancyGuard, BoxCloneReader {
    /// @notice v1 routes only native-ETH Q (S12 adds ERC-20 Q).
    error QNotSupported(address q);
    error UnknownKind(uint8 kind);
    error NotInitialised();

    // ------------------------------------------------------------------ clone arguments (201 bytes, BoxReceiver)

    uint256 internal constant _A_KIND = 0;
    uint256 internal constant _A_Q = 1;
    uint256 internal constant _A_TOKEN = 21;
    uint256 internal constant _A_COORDINATOR = 41;
    uint256 internal constant _A_HOOK = 61;
    uint256 internal constant _A_EXECUTOR = 81;
    uint256 internal constant _A_SAFE = 101;
    uint256 internal constant _A_STREAM = 121;
    uint256 internal constant _A_Q_STREAM = 141;
    uint256 internal constant _A_T_STREAM = 142;
    uint256 internal constant _A_ROYALTY = 143;
    uint256 internal constant _A_PAYEE = 144;
    uint256 internal constant _A_MODULE = 164;
    /// @dev S5.M3, add-on 5 (the creator-fee cap; R F74 U2, F75 U9): the most the creator receives per 30-day epoch, in
    /// Q raw units (16 bytes; 0: no cap, and always 0 for box 0), and where the excess goes (1 byte: BoxSpecV1
    /// CAP_EXCESS_BURN or CAP_EXCESS_POOL_DEPTH; 0 without a cap).
    uint256 internal constant _A_CAP = 184;
    uint256 internal constant _A_CAP_EXCESS = 200;

    // ------------------------------------------------------------------ the state word

    // `_s`: initialised (bit 0), settled (bit 1), epoch (bits 8-39), Q carry (40-47), T carry (48-55), the hook's fee
    // notes waiting for the next batch (bits 128-255; S5.M5: `_s` is never zero once initialised, so a note never
    // writes a slot from zero, and `collect` writes `_s` anyway). The epoch field is 32 bits: the platform cap is exact
    // for 2^32 epochs (about 353 million years after graduation); from epoch 2^32 the stored epoch never matches again
    // and every capping call restarts the epoch's count (box 0's own review W1-U4-1, F147: a stated bound, no change).
    uint256 internal constant _B_INIT = 1;
    uint256 internal constant _B_SETTLED = 2;
    uint256 internal constant _O_EPOCH = 8;
    uint256 internal constant _O_QCARRY = 40;
    uint256 internal constant _O_TCARRY = 48;
    uint256 internal constant _O_HOOK_FEES = 128;
    uint256 internal constant _M32 = (1 << 32) - 1;
    uint256 internal constant _M8 = (1 << 8) - 1;

    // ------------------------------------------------------------------ storage

    /// @dev Every ledger, raw units. Q ledgers and T ledgers (except `tBurnPending`, real T) are held as claims.
    struct Ledgers {
        uint128 fitOwed;
        uint128 platformOwed;
        uint128 platformHeld;
        // One epoch counter (with the epoch in `_s` bits 8-39) for the one cap a box can have: box 0's platform cap
        // (F62) or a Standard box's creator-fee cap (add-on 5, S5.M3). Box 0 has no creator, other boxes no platform.
        uint128 keptInEpoch;
        uint128 creatorOwedQ;
        uint128 creatorHeldQ;
        uint128 creatorOwedT;
        uint128 creatorHeldT;
        uint128 fitWaitingT;
        uint128 tBurnPending;
        // The fee notes waiting for the next batch (box 0: FIT's executor's; Standard boxes: the swap module's), each
        // beside the ledger it returns to on a Standard box (S5.M1: REV-16's `moduleBack*`, which the next pull hands
        // over keeping 1 raw unit), so a note never writes a slot from zero once a box has had one return.
        uint128 moduleQPending;
        uint128 moduleBackQ;
        uint128 moduleTPending;
        uint128 moduleBackT;
        uint128 depthHeldQ;
        uint128 depthHeldT;
    }

    /// @dev S5.M1, a Standard box's swap module (swap-module § 4.1-4.2, § 6), raw units, held as claims: its ledgers,
    /// held until the settlement and then handed by `pullForModule`, each keeping 1 raw unit (no slot returns to zero);
    /// FIT's T share, which it sells too, stays `Ledgers.fitWaitingT`, its returned fees `Ledgers.moduleBack*`. And
    /// its fee-note allowance (not claims).
    struct ModuleLedgers {
        /// BUYBACK_BURN_T's Q: the module buys T and burns it (S5.M2).
        uint128 qBurn;
        /// CREATOR_IN_T's Q: the module buys T for the creator (S5.M3).
        uint128 qCreator;
        /// CREATOR_IN_Q's T: the module sells it for the creator (S5.M3).
        uint128 tForCreator;
        /// Σ handed × LP_FEE / 10^6 per side, less the notes booked; stored plus 1 from `initialize` on (S5 review,
        /// BC-138: no step writes these slots from zero).
        uint128 allowanceQ;
        uint128 allowanceT;
    }

    /// @dev Lifetime totals of what each part was credited (not what was paid out), raw units.
    struct Totals {
        uint128 toFit;
        uint128 toPlatform;
        uint128 qToDepth;
        uint128 qToCreator;
        uint128 tToDepth;
        uint128 tToCreator;
        uint128 tBurned;
    }

    uint256 internal _s;
    Ledgers internal _l;
    Totals internal _t;
    address internal _payeeOverride;
    address internal _pendingPayee;
    ModuleLedgers internal _m;
    // F126: retained on settlement so a delayed stream can exclude curve-depth claims from the gross snapshot.
    uint256 internal _streamCurveDepthT;

    // ------------------------------------------------------------------ shared reads

    function _initialised() internal view {
        if (_s & _B_INIT == 0) revert NotInitialised();
    }

    /// @dev The creator payee: the handed-over one, else the clone argument (the spec's `creatorFeeRecipient`).
    function _payee() internal view returns (address) {
        address o = _payeeOverride;
        return o != address(0) ? o : _argAddress(_A_PAYEE);
    }

    function _u128(uint256 x) internal pure returns (uint128) {
        // Raw Q and T amounts are far below 2^128 (T issuance 1e27; Q supplies of listed assets).
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint128(x);
    }
}
