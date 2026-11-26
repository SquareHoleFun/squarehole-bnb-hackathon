// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {IBoxReceiverPayInTV21} from "../interfaces/IBoxReceiverPayInTV21.sol";
import {ReceiverPendingV21 as Pending} from "./ReceiverPendingV21.sol";
import {HeldKind, FailRoute} from "../interfaces/FailureTableV2.sol";
import {ReceiverShopV21 as Shop} from "./ReceiverShopV21.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IERC20Minimal} from "v4-core/src/interfaces/external/IERC20Minimal.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {TransientStateLibrary} from "v4-core/src/libraries/TransientStateLibrary.sol";
import {IBoxHookV2, TradeBatchV2} from "../interfaces/IBoxHookV2.sol";
import {IBoxReceiverV2, IBoxReceiverItemsV2, FeeBatchV2, ItemFundingV2} from "../interfaces/IBoxReceiverV2.sol";
import {IBoxVaultV2, IBoxVaultItemsV2} from "../interfaces/IBoxVaultV2.sol";
import {IBoxCoordinatorV2} from "../interfaces/IBoxCoordinatorV2.sol";
import {ReleaseConstantsV2 as C} from "../interfaces/ReleaseConstantsV2.sol";
import {RoyaltyDestination} from "../../box/interfaces/BoxTypes.sol";
import {BoxReceiverV2Args as A} from "../libraries/BoxReceiverV2Args.sol";
import {ReceiverViews} from "../libraries/ReceiverViews.sol";
import {PricingToken} from "../libraries/PricingToken.sol";
import {RewardAccountingV21 as Rewards} from "../libraries/RewardAccountingV21.sol";


/// @notice Fixed core booking code. Identical slot layout and five-choice accounting; never directory-selectable.
library ReceiverBooksV21 {
    // RC7: measured cold on both EVMs, including two paid buyer tips, within the keeper's fork-aware floor (5M before Amsterdam, 8M on it).
    uint256 internal constant SUB_UNIT_PASSES = 5;
    using Rewards for Rewards.State;
    struct State {
    uint256[10]  _p;
    uint256 _reservedFormerConversion;
    address  _payee;
    address  _pendingPayee;
    uint256  _burnPending;
    bool  _initialized;
    bool  _graduationSettled;
    bool  _failureSettled;

    // Append-only M2 seams. Plain M1 has no ledger and never writes these slots.
    mapping(uint256 => uint256)  _holderBatchPaid;
    mapping(uint256 => bool)  _holderBatchClosed;
    uint256  _harvestedBuyers;
    uint256  _harvestedSellers;
    uint256  _harvestedReserve;
    uint256  _lastHolderBatch; // Last allocated buyer source (odd), not a consecutive all-source frontier.

    // S2 append-only state. ITEMS remains the sole booked total; sellers held = ITEMS - buyers held.
    address  _itemVault;
    uint32  _itemCount;
    uint16  _itemPolicies;
    uint256  _itemsBuyersHeld;
    ItemFundingV2[]  _itemFunding;

    // V2.1 append-only: do not expand _p and shift old persistent slots.
    uint256  _eatPendingP;
    uint256  _eatenP;
    Rewards.State  _rewards;
    uint256  _pilePendingP;
    uint256  _pileMovedP;
    uint256[2] _modulePending;
    // Cumulative source P already allocated; the hook owns the total accrued journal.
    uint256 _sourceAllocatedP;
    uint256 _lastSellerBatch;
    }
    uint256 internal constant FIT = 0;
    uint256 internal constant PLATFORM = 1;
    uint256 internal constant POOL = 2;
    uint256 internal constant GROW = 3;
    uint256 internal constant CREATOR = 4;
    uint256 internal constant BUY_BACK = 5;
    uint256 internal constant ITEMS = 6;
    uint256 internal constant ROYALTY = 7;
    uint256 internal constant BUYERS_CARRY = 8;
    uint256 internal constant SELLERS_CARRY = 9;
    /// @notice Receiver/readers through the fixed core link; reads booked P only, no funds move.
    function bookedP(State storage st) internal view returns (uint256 total) {
        // Immutable choices are the only writers of these additive P ledgers. Avoid cold
        // reads of impossible debts, particularly during every old-menu box's creation.
        uint256 choices = A.uintAt(A.BUYERS_CHOICE, 2);
        uint256 buyers = choices >> 8;
        uint256 sellers = choices & 255;
        uint256 selected = (uint256(1) << buyers) | (uint256(1) << sellers);
        if (selected & (1 << 6) != 0) total += st._eatPendingP;
        if (selected & (1 << 7) != 0) total += st._rewards.pending[0];
        if (buyers == 8) total += st._rewards.pending[1];
        if (sellers == 8) total += st._rewards.pending[2];
        if (selected & (1 << 9) != 0) total += st._pilePendingP;
        if (selected & ((1 << 10) | (1 << 11)) != 0) total += st._modulePending[0] + st._modulePending[1];
        // These three core ledgers also have immutable writers: Grow, Burn (including
        // an Items-in-P inside burn), and held Items-in-P. Royalties use the same split.
        total += st._p[FIT] + st._p[PLATFORM] + st._p[POOL]
            + st._p[ROYALTY] + st._p[BUYERS_CARRY] + st._p[SELLERS_CARRY];
        if (selected & ((1 << 3) | (1 << 4) | (1 << 7)) != 0) total += st._p[GROW];
        if (selected & ((1 << 2) | (1 << 5)) != 0) total += st._p[BUY_BACK];
        if (selected & (1 << 5) != 0) total += st._p[ITEMS];
        if (selected & (1 << 1) != 0 || A.uintAt(A.ROYALTY_DESTINATION, 1) == uint256(RoyaltyDestination.Creator)) total += st._p[CREATOR];
    }

    /// @notice Locked receiver only through the fixed core link; pulls an exact voluntary royalty.
    function pullRoyalty(address asset, uint256 amount) public {
        uint256 beforeBalance = PricingToken.balanceOf(asset, address(this));
        (bool ok, bytes memory result) =
            asset.call(abi.encodeCall(IERC20Minimal.transferFrom, (msg.sender, address(this), amount)));
        if (!ok) {
            assembly ("memory-safe") { revert(add(result, 32), mload(result)) }
        }
        require(
            result.length == 0 || (result.length >= 32 && abi.decode(result, (uint256)) == 1), "ReceiverTransferRefused"
        );
        uint256 afterBalance = PricingToken.balanceOf(asset, address(this));
        uint256 received = afterBalance > beforeBalance ? afterBalance - beforeBalance : 0;
        if (received != amount) revert IBoxReceiverV2.TransferNotExact(amount, received);
    }

    /// @notice Locked receiver only through its fixed link; harvests the authenticated hook and records source totals.
    function harvestFees(State storage st) public returns (uint256 buyers, uint256 sellers, uint256 reserve) {
        (buyers, sellers, reserve) = IBoxHookV2(A.addressAt(A.HOOK)).harvest();
        if (A.addressAt(A.HOLDER_LEDGER) != address(0) || st._itemPolicies != 0) {
            st._harvestedBuyers += buyers;
            st._harvestedSellers += sellers;
            st._harvestedReserve += reserve;
        }
    }

    struct Clip { uint256 other; uint256 available; uint256 cumulative; uint256 kept; uint256 itemsBefore; }
    /// @notice Locked receiver only through its fixed link; clips non-Safe debt to actual P backing.
    function reconcile(State storage st, IPoolManager pm) public {
        Clip memory x;
        uint256 booked = bookedP(st);
        uint256 balance = pm.balanceOf(address(this), uint160(A.addressAt(A.P)));
        if (booked <= balance) return;
        emit IBoxReceiverV2.BookingClipped(A.addressAt(A.P), booked, balance);
        uint256 owed = st._p[FIT] + st._p[PLATFORM];
        x.other = booked - owed;
        if (x.other == 0) return;
        x.available = balance > owed ? balance - owed : 0;
        x.itemsBefore = st._p[ITEMS];
        for (uint256 i = POOL; i < 10; ++i) {
            x.cumulative += st._p[i];
            // Cumulative rounding conserves every x.available unit without increasing any ledger.
            uint256 next = FullMath.mulDiv(x.cumulative, x.available, x.other);
            st._p[i] = next - x.kept;
            x.kept = next;
        }
        x.cumulative += st._eatPendingP;
        uint256 nextEat = FullMath.mulDiv(x.cumulative, x.available, x.other);
        st._eatPendingP = nextEat - x.kept;
        x.kept = nextEat;
        for (uint256 i; i < 3; ++i) {
            uint256 before_ = st._rewards.pending[i];
            x.cumulative += before_;
            uint256 next = FullMath.mulDiv(x.cumulative, x.available, x.other);
            st._rewards.pending[i] = next - x.kept;
            if (i == 0) st._rewards.consume(before_ - st._rewards.pending[i], 0);
            x.kept = next;
        }
        x.cumulative += st._pilePendingP;
        uint256 nextPile = FullMath.mulDiv(x.cumulative, x.available, x.other);
        st._pilePendingP = nextPile - x.kept;
        x.kept = nextPile;
        for (uint256 i; i < 2; ++i) {
            uint256 beforeShop = st._modulePending[i];
            x.cumulative += beforeShop;
            uint256 next = FullMath.mulDiv(x.cumulative, x.available, x.other);
            st._modulePending[i] = next - x.kept;
            if (A.uintAt(i == 1 ? A.SELLERS_CHOICE : A.BUYERS_CHOICE, 1) == 11) Shop.consume(beforeShop - st._modulePending[i], 0);
            x.kept = next;
        }
        if (x.itemsBefore != 0) st._itemsBuyersHeld = FullMath.mulDiv(st._itemsBuyersHeld, st._p[ITEMS], x.itemsBefore);
    }

    /// @notice Receiver/readers through the fixed link; reads surplus without moving funds.
    function unbooked(State storage st, IPoolManager pm) public view returns (uint256) {
        uint256 balance = pm.balanceOf(address(this), uint160(A.addressAt(A.P)));
        uint256 total = bookedP(st);
        return balance > total ? balance - total : 0;
    }

    /// @notice Locked receiver only through its fixed link; closes one authenticated trade batch and funds its ledger.
    function fundHolderBatch(State storage st, IPoolManager pm, uint256 id, uint256 netP) public {
        address ledger = A.addressAt(A.HOLDER_LEDGER);
        if (ledger == address(0) || id == 0 || st._holderBatchClosed[id]) revert IBoxReceiverV2.InvalidHolderBatch(id);
        TradeBatchV2 memory batch = IBoxHookV2(A.addressAt(A.HOOK)).tradeBatch(id);
        if (!batch.closed || netP > batch.netP || netP > unbooked(st, pm)) revert IBoxReceiverV2.InvalidHolderBatch(id);
        _recordHolderBatch(st, pm, id, netP);
    }

    function _recordHolderBatch(State storage st, IPoolManager pm, uint256 id, uint256 netP) private {
        if (_holderT(st, pm, id)) {
            if (netP != 0) st._rewards.fund(id, netP);
            st._holderBatchClosed[id] = true;
            return;
        }
        st._holderBatchClosed[id] = true;
        if (id % 2 == 0 && A.uintAt(A.SELLERS_CHOICE, 1) == 11) {
            (bool closed,) = Shop.funding(id);
            if (!closed) return;
        }
        st._holderBatchPaid[id] = netP;
        _moveClaims(st, pm, A.addressAt(A.HOLDER_LEDGER), netP);
        emit IBoxReceiverV2.HolderBatchFunded(id, netP);
    }

    function _moveClaims(State storage st, IPoolManager pm, address to, uint256 amount) private {
        if (amount != 0) require(pm.transfer(to, uint160(A.addressAt(A.P)), amount), "ClaimsTransferFailed");
    }

    function _release(State storage st, IPoolManager pm, uint256 ledger, address to) private returns (uint256 amount) {
        amount = st._p[ledger];
        st._p[ledger] = 0;
        _moveClaims(st, pm, to, amount);
    }

    /// @notice Receiver through its fixed link; reads whether the frozen source journal is required.
    function hasSources(State storage st) public view returns (bool) {
        uint256 choices = A.uintAt(A.BUYERS_CHOICE, 2);
        return st._itemPolicies != 0 || choices >> 8 == 4 || choices & 255 == 4 || choices >> 8 == 7 || choices & 255 == 7 || choices & 255 == 11;
    }

    struct Allocation { uint256 remaining; uint256 available; }
    /// @notice Locked receiver only; two quota places plus bounded sub-unit passes per side, sharing one tip allowance.
    function allocateBatches(State storage st, IPoolManager pm, address tipTo, FeeBatchV2 memory result) public returns (FeeBatchV2 memory) {
        Allocation memory x;
        x.available = unbooked(st, pm);
        uint256 total = IBoxHookV2(A.addressAt(A.HOOK)).tradeBatchTotalP();
        x.remaining = total - st._sourceAllocatedP;
        uint256 surplus = x.available > x.remaining ? x.available - x.remaining : 0;
        x.available -= surplus;
        _allocateSide(st, pm, tipTo, false, x, result);
        _allocateSide(st, pm, tipTo, true, x, result);
        // Failure is terminal: later collects route unbooked P directly to the pot.
        // Persist final funding below, but do not spend the failure envelope on dead cursor/journal writes.
        if (!st._failureSettled) st._sourceAllocatedP = total - x.remaining;
        // Unfinished and unvisited sources retain their backing, including partial seller conversions.
        result.buyersP += surplus;
        split(st, pm, surplus, false);
        return result;
    }

    function _allocateSide(State storage st, IPoolManager pm, address tipTo, bool sellers,
        Allocation memory x, FeeBatchV2 memory result) private
    {
        uint256 last = sellers ? st._lastSellerBatch : st._lastHolderBatch;
        uint256 id = last == 0 && !sellers ? 1 : last + 2;
        uint256 passes;
        for (uint256 quota; quota < 2;) {
            TradeBatchV2 memory source = IBoxHookV2(A.addressAt(A.HOOK)).tradeBatch(id);
            if (!source.closed) break;
            // Passes still execute the complete accounting step; only their quota charge differs.
            // Failure keeps rc6's two-source envelope and never persists cursors.
            if (!st._failureSettled && source.netP < 15 && passes < SUB_UNIT_PASSES) ++passes;
            else ++quota;
            // remaining is the SUM of all unallocated source P, never an id range.
            // Reserve every other source first (including older unfinished sellers).
            // The current source receives min(its P, max(available - others, 0)).
            // Deduct its full entitlement even if clipped; later receipts cannot refill it.
            x.remaining -= source.netP;
            uint256 backed = x.available > x.remaining ? x.available - x.remaining : 0;
            if (backed > source.netP) backed = source.netP;
            x.available -= backed;
            uint256 tip;
            if (!sellers && tipTo != address(0) && backed >= A.uintAt(A.BATCH_MIN_Q, 16)) {
                tip = _tip(backed);
                uint256 room = A.uintAt(A.TIP_MAX_Q, 16) - result.tip;
                if (tip > room) tip = room;
                // Provisional source debt stays reserved while P code runs in its isolated capped unlock.
                // Every receiver mutation is locked; a refused tip remains this source's money.
                st._p[BUYERS_CARRY] = backed - tip;
                tip = _payTip(pm, tipTo, tip);
                st._p[BUYERS_CARRY] = 0;
            }
            backed -= tip;
            result.tip += tip;
            if (sellers) result.sellersP += backed; else result.buyersP += backed;
            _splitSource(st, pm, backed, sellers, id);
            last = id;
            id += 2;
        }
        if (!st._failureSettled) {
            if (sellers) st._lastSellerBatch = last; else st._lastHolderBatch = last;
        }
    }

    /// @notice Locked receiver only through its fixed link; applies the fixed 2:1:2:10 split to backed P.
    function split(State storage st, IPoolManager pm, uint256 amount, bool sellers) public { _splitSource(st, pm, amount, sellers, 0); }

    function _splitSource(State storage st, IPoolManager pm, uint256 amount, bool sellers, uint256 id) private {
        uint256 carry = sellers ? SELLERS_CARRY : BUYERS_CARRY;
        bool sourced = hasSources(st);
        uint256 total = amount + (sourced ? 0 : st._p[carry]);
        uint256 unit = total / 15;
        uint256 dust = total % 15;
        if (!sourced) st._p[carry] = dust;
        else if (dust != 0) {
            if (st._failureSettled) _moveClaims(st, pm, A.addressAt(A.COORDINATOR), dust);
            else _moveClaims(st, pm, A.addressAt(A.HOOK), dust);
        }
        st._p[FIT] += 2 * unit;
        st._p[PLATFORM] += unit;
        st._p[POOL] += 2 * unit;
        uint256 choice = A.uintAt(sellers ? A.SELLERS_CHOICE : A.BUYERS_CHOICE, 1);
        uint256 funding;
        // Non-trade holder-choice money joins depth, never a holder batch. Items use every backed source.
        if ((choice == 4 || choice == 7) && id != 0) funding = 10 * unit;
        else if (choice == 6) st._eatPendingP += 10 * unit;
        else if (choice == 11) {
            // Shop is sellers-only, hence always an authenticated trade source. No donation becomes holder units.
            if (st._failureSettled || Shop.wanted()) { st._modulePending[1] += 10 * unit; if (unit != 0) Shop.fund(id, 10 * unit); }
            else funding = 10 * unit;
        }
        else if (choice == 10 && unit != 0) {
            if (st._modulePending[sellers ? 1 : 0] == 0) Pending.startWait(sellers);
            st._modulePending[sellers ? 1 : 0] += 10 * unit;
        }
        else if (choice == 9) st._pilePendingP += 10 * unit;
        else if (choice == 8) {
            if (st._graduationSettled && uint8(st._itemPolicies >> (sellers ? 8 : 0)) == 3)
                _fundItems(st, pm, 10 * unit, sellers, id, id == 0 ? 2 : 1);
            else st._rewards.pending[sellers ? 2 : 1] += 10 * unit;
        }
        else if (choice == 5) _bookItems(st, pm, 10 * unit, sellers, id);
        else st._p[choice == 1 ? CREATOR : choice == 2 ? BUY_BACK : GROW] += 10 * unit;
        if (id != 0 && A.addressAt(A.HOLDER_LEDGER) != address(0)) _recordHolderBatch(st, pm, id, funding);
        if (st._graduationSettled) _releaseDepth(st, pm);
    }

    function _releaseDepth(State storage st, IPoolManager pm) private {
        address h = A.addressAt(A.HOOK);
        _release(st, pm, POOL, h);
        _release(st, pm, GROW, h);
    }

    /// @notice Locked receiver only through its fixed link; books an exact royalty receipt using the immutable destination.
    function bookRoyalty(State storage st, IPoolManager pm, uint256 amount) public {
        split(st, pm, amount, false);
    }

    /// @notice Locked receiver only through its fixed link; releases held core debts after coordinator graduation.
    function graduateIfDue(State storage st, IPoolManager pm) public {
        if (st._graduationSettled) {
            if (uint8(st._itemPolicies) == 3 || st._itemPolicies >> 8 == 3) _emptyDepthRewards(st, pm);
            return;
        }
        if (st._failureSettled || IBoxCoordinatorV2(A.addressAt(A.COORDINATOR)).failed() || !IBoxCoordinatorV2(A.addressAt(A.COORDINATOR)).graduated()) return;
        st._graduationSettled = true;
        // A5: a module side with P waiting restarts its seven days here, so a raise's wait cannot open the fallback
        // before the trigger can convert. No external call; an empty side starts on its next positive receipt.
        uint256 choices = A.uintAt(A.BUYERS_CHOICE, 2);
        if (choices >> 8 == 10 && st._modulePending[0] != 0) Pending.startWait(false);
        if (choices & 255 == 10 && st._modulePending[1] != 0) Pending.startWait(true);
        _releaseDepth(st, pm);
        // Both source-3 records precede royalty/live funding, including zero releases.
        uint256 held = st._p[ITEMS];
        st._p[ITEMS] = 0;
        if (uint8(st._itemPolicies) != 0) _fundItems(st, pm, st._itemsBuyersHeld, false, 0, 3);
        if (st._itemPolicies >> 8 != 0) _fundItems(st, pm, held - st._itemsBuyersHeld, true, 0, 3);
        st._itemsBuyersHeld = 0;
        uint256 amount = st._p[ROYALTY];
        st._p[ROYALTY] = 0;
        bookRoyalty(st, pm, amount);
        if (uint8(st._itemPolicies) == 3 || st._itemPolicies >> 8 == 3) _releaseDepth(st, pm);
    }

    // Outside-only T purchase budgets have no beneficiary when all items return. Reuse the pool's
    // claims bucket and Grow's release, including below-step-minimum tails; no swap or tip is needed.
    function _emptyDepthRewards(State storage st, IPoolManager pm) private {
        for (uint256 i = 1; i <= 2; ++i) {
            if (uint8(st._itemPolicies >> (i == 2 ? 8 : 0)) != 3 || st._rewards.pending[i] == 0) continue;
            if (IBoxVaultV2(st._itemVault).inside() != st._itemCount) return;
            uint256 amount = st._rewards.pending[i];
            st._rewards.pending[i] = 0;
            st._p[POOL] += amount;
            emit IBoxReceiverPayInTV21.ItemsDepthFunded(uint8(i), 4, amount, amount, 0);
        }
        _releaseDepth(st, pm);
    }

    function _bookItems(State storage st, IPoolManager pm, uint256 amount, bool sellers, uint256 id) private {
        if (amount == 0) return;
        if (!st._graduationSettled) {
            st._p[ITEMS] += amount;
            if (!sellers) st._itemsBuyersHeld += amount;
        } else _fundItems(st, pm, amount, sellers, id, id == 0 ? 2 : 1);
    }

    function _fundItems(State storage st, IPoolManager pm, uint256 amount, bool sellers, uint256 id, uint8 source) private returns (uint256 paid, uint256 retained) {
        uint256 inside = IBoxVaultV2(st._itemVault).inside();
        uint256 hidden = IBoxVaultV2(st._itemVault).hiddenCount();
        if (inside > st._itemCount || hidden > inside) revert IBoxReceiverV2.InvalidChoice();
        uint8 policy = uint8(st._itemPolicies >> (sellers ? 8 : 0));
        bool depthT = policy == 3 && A.uintAt(sellers ? A.SELLERS_CHOICE : A.BUYERS_CHOICE, 1) == 8;
        if (depthT && source == 3) {
            amount = st._rewards.pending[sellers ? 2 : 1];
            st._rewards.pending[sellers ? 2 : 1] = 0;
        }
        if (policy >= 2) retained = source == 3 ? amount : inside * (amount / st._itemCount);
        if (depthT && inside == st._itemCount) retained = amount;
        paid = amount - retained;
        st._p[policy == 3 ? POOL : BUY_BACK] += retained;
        if (depthT) {
            st._rewards.pending[sellers ? 2 : 1] += paid;
            emit IBoxReceiverPayInTV21.ItemsDepthFunded(sellers ? 2 : 1, source, amount, retained, paid);
            // Live T funding is recorded only when T is actually bought. Graduation still supplies
            // the mandatory zero-T source-3 marker before the first lifecycle/purchase receipt.
            if (source == 3) _recordItems(st, pm, ItemFundingV2(0, 0, 0, 0, uint32(inside), uint32(hidden), sellers ? 2 : 1, 3));
            return (paid, retained);
        }
        _moveClaims(st, pm, A.addressAt(A.ITEM_LEDGER), paid);
        _recordItems(st, pm, ItemFundingV2(id, 0, amount, paid, uint32(inside), uint32(hidden), sellers ? 2 : 1, source));
    }

    function _recordItems(State storage st, IPoolManager pm, ItemFundingV2 memory f) private {
        f.lifecycleCursor = IBoxVaultItemsV2(st._itemVault).itemLifecycleCount();
        st._itemFunding.push(f);
        emit IBoxReceiverItemsV2.ItemFunded(st._itemFunding.length, f.batchId, f.side, f.source, f.choiceP, f.ledgerP);
    }

    function _holderT(State storage st, IPoolManager pm, uint256 id) private view returns (bool) {
        return A.uintAt(id % 2 == 1 ? A.BUYERS_CHOICE : A.SELLERS_CHOICE, 1) == 7;
    }

    function _tip(uint256 amount) private view returns (uint256) {
        uint256 tip = FullMath.mulDiv(amount, C.TIP_BPS, C.BPS);
        uint256 cap = A.uintAt(A.TIP_MAX_Q, 16);
        return tip > cap ? cap : tip;
    }
    function _payTip(IPoolManager pm, address to, uint256 amount) private returns (uint256) {
        if (amount == 0 || to == address(0) || to == address(this) || to == address(pm)) return 0;
        uint256 stipend = C.TIP_GAS;
        require(gasleft() >= stipend + stipend / 63 + C.POKE_OVERHEAD_GAS, "ReceiverGasTooLow");
        bytes32 slot = keccak256("squarehole.receiver.v2.unlock");
        assembly ("memory-safe") { tstore(slot, 6) }
        bool ok;
        try pm.unlock{gas: stipend}(abi.encode(uint256(6), A.addressAt(A.P), to, amount)) { ok = true; } catch {}
        assembly ("memory-safe") { tstore(slot, 0) }
        return ok ? amount : 0;
    }
    /// @notice Locked failing receiver only, after final harvest and split. No token or module code runs here.
    /// @notice Locked failed receiver only through its fixed link; follows the frozen failure table, never module code.
    function routeFailure(State storage st, IPoolManager pm) external {
        for (uint256 i; i < 3; ++i) {
            uint256 pending = st._rewards.pending[i];
            st._rewards.pending[i] = 0;
            if (i == 0) st._rewards.consume(pending, 0);
            _pendingToPot(st, pm, pending, i == 0 ? HeldKind.HOLDERS_T_PENDING : HeldKind.ITEMS_T_PENDING);
        }
        for (uint256 i; i < 2; ++i) {
            uint256 amount = st._modulePending[i]; st._modulePending[i] = 0;
            bool shop = A.uintAt(i == 1 ? A.SELLERS_CHOICE : A.BUYERS_CHOICE, 1) == 11;
            if (shop) Shop.consume(amount, 0);
            _pendingToPot(st, pm, amount, shop ? HeldKind.SHOP_FEES_PENDING : HeldKind.MODULE_PENDING);
        }
        uint256 pendingPile = st._pilePendingP;
        st._pilePendingP = 0;
        _pendingToPot(st, pm, pendingPile, HeldKind.PILE_FEES_PENDING);
        uint256 pendingEat = st._eatPendingP;
        st._eatPendingP = 0;
        _pendingToPot(st, pm, pendingEat, HeldKind.EAT_PRICE_COIN);
        _routePot(st, pm, POOL, HeldKind.POOL_SHARE);
        _routePot(st, pm, CREATOR, HeldKind.CREATOR_BRANCH);
        _routePot(st, pm, BUY_BACK, HeldKind.BURN_BRANCH);
        _routePot(st, pm, ROYALTY, HeldKind.ROYALTIES);
        _routePot(st, pm, ITEMS, HeldKind.ITEMS_CREDITS);
        st._itemsBuyersHeld = 0;
        _routePot(st, pm, GROW, HeldKind.DEPTH_BRANCH);
        _routePot(st, pm, BUYERS_CARRY, HeldKind.SIDE_CARRY);
        _routePot(st, pm, SELLERS_CARRY, HeldKind.SIDE_CARRY);
    }
    /// @notice Locked failed receiver only through its fixed link: transfer all unbooked P claims to its coordinator.
    /// Existing FIT/platform debts remain backed. No tip, external token call or claim deadline.
    function toPot(State storage st, IPoolManager pm) public returns (uint256 amount) {
        amount = unbooked(st, pm);
        _moveClaims(st, pm, A.addressAt(A.COORDINATOR), amount);
    }
    function _pendingToPot(State storage st, IPoolManager pm, uint256 amount, HeldKind kind) private {
        _moveClaims(st, pm, A.addressAt(A.COORDINATOR), amount);
        if (amount != 0) emit IBoxReceiverV2.FailureRouted(kind, FailRoute.CLOSING_POOL, A.addressAt(A.P), amount);
    }
    function _routePot(State storage st, IPoolManager pm, uint256 ledger, HeldKind kind) private {
        uint256 amount = _release(st, pm, ledger, A.addressAt(A.COORDINATOR));
        if (amount != 0) emit IBoxReceiverV2.FailureRouted(kind, FailRoute.CLOSING_POOL, A.addressAt(A.P), amount);
    }
    /// @notice Anyone through the receiver reads the unchanged source batch's paid amount; no money moves.
    /// @notice Anyone through the receiver view; reads irreversible funded P or T tranche accounting.
    function holderClosed(State storage st, uint256 id) external view returns (bool) {
        if (!st._holderBatchClosed[id]) return false;
        if (id % 2 != 0 || A.uintAt(A.SELLERS_CHOICE, 1) != 11) return true;
        (bool closed,) = Shop.funding(id);
        return closed;
    }
    /// @notice Anyone through the receiver reads funded P or T; no custody moves.
    function holderPaid(State storage st, uint256 id) external view returns (uint256) {
        if (id % 2 == 0 && A.uintAt(A.SELLERS_CHOICE, 1) == 11) {
            (, uint256 amount) = Shop.funding(id);
            return st._holderBatchPaid[id] + amount;
        }
        if (A.uintAt(id % 2 == 1 ? A.BUYERS_CHOICE : A.SELLERS_CHOICE, 1) != 7) return st._holderBatchPaid[id];
        (, uint256 amount) = st._rewards.funding(id);
        return amount;
    }
}
