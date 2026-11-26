// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IBoxReceiverPayInTV21} from "./interfaces/IBoxReceiverPayInTV21.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IERC20Minimal} from "v4-core/src/interfaces/external/IERC20Minimal.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {TransientStateLibrary} from "v4-core/src/libraries/TransientStateLibrary.sol";
import {IBoxHookV2, TradeBatchV2} from "./interfaces/IBoxHookV2.sol";
import {IBoxReceiverV2, IBoxReceiverItemsV2, FeeBatchV2, ItemFundingV2} from "./interfaces/IBoxReceiverV2.sol";
import {IBoxVaultV2, IBoxVaultItemsV2} from "./interfaces/IBoxVaultV2.sol";
import {IBoxCoordinatorV2} from "./interfaces/IBoxCoordinatorV2.sol";
import {ReleaseConstantsV2 as C} from "./interfaces/ReleaseConstantsV2.sol";
import {RoyaltyDestination} from "../box/interfaces/BoxTypes.sol";
import {BoxReceiverV2Args as A} from "./libraries/BoxReceiverV2Args.sol";
import {ReceiverViews} from "./libraries/ReceiverViews.sol";
import {PricingToken} from "./libraries/PricingToken.sol";
import {ReceiverModuleCallV21} from "./libraries/ReceiverModuleCallV21.sol";
import {ReceiverBooksV21} from "./libraries/ReceiverBooksV21.sol";
import {ReceiverRewardsV21} from "./libraries/ReceiverRewardsV21.sol";
import {RewardAccountingV21 as Rewards} from "./libraries/RewardAccountingV21.sol";
import {ReceiverCodeV21} from "./interfaces/IFeeModulesV21.sol";
import {FeeModuleDirectoryV21} from "./FeeModuleDirectoryV21.sol";
import {BoxReceiverV2Actions} from "./BoxReceiverV2Actions.sol";
import {BoxReceiverV2Extension} from "./BoxReceiverV2Extension.sol";

/// @notice Receiver storage and booking operations. Its fixed callback part has no persistent storage.
abstract contract BoxReceiverV2Base is IBoxReceiverV2, IBoxReceiverItemsV2, IBoxReceiverPayInTV21, IUnlockCallback, BoxReceiverV2Actions {
    using TransientStateLibrary for IPoolManager;
    using Rewards for Rewards.State;

    // Preserve the receiver ABI for PricingToken errors now bubbled from its fixed callback part.
    // Retain the public error shape emitted by the extracted royalty balance check.
    error BalanceUnreadable(address token, address account);
    error EthSendFailed(address to, uint256 amount);
    error ShortTransfer(address token, uint256 expected, uint256 received);
    error TokenCallFailed(address token, bytes4 selector);

    IPoolManager internal immutable _pm;
    address internal immutable _fitSafe;
    address internal immutable _platformSafe;
    /// @notice Anyone reads the fixed coordinator implementation for this release; no money moves.
    address public immutable coordinatorImplementation;
    address internal immutable _implementation;
    // Separately deployed shared release code; no setter or additional persistent slot.
    ReceiverViews internal immutable _views;
    // Fixed callback implementation, shared by every direct clone.
    address internal immutable _extension;
    FeeModuleDirectoryV21 internal immutable _moduleDirectory;
    address private immutable _eatModule;
    address private immutable _holdersTModule;
    address private immutable _itemsTModule;
    address private immutable _pileModule;
    bytes32 private immutable _eatHash;
    bytes32 private immutable _holdersTHash;
    bytes32 private immutable _itemsTHash;
    bytes32 private immutable _pileHash;

    // Every slot is P claims; the final two slots are independent side carries, each less than 15.
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
    uint256[10] internal _p;
    uint256 private _reservedFormerConversion;
    address internal _payee;
    address internal _pendingPayee;
    uint256 internal _burnPending;
    bool internal _initialized;
    bool internal _graduationSettled;
    bool internal _failureSettled;

    // Append-only M2 seams. Plain M1 has no ledger and never writes these slots.
    mapping(uint256 => uint256) internal _holderBatchPaid;
    mapping(uint256 => bool) internal _holderBatchClosed;
    uint256 internal _harvestedBuyers;
    uint256 internal _harvestedSellers;
    uint256 internal _harvestedReserve;
    uint256 internal _lastHolderBatch; // Last allocated buyer source (odd); zero before the first allocation.

    // S2 append-only state. ITEMS remains the sole booked total; sellers held = ITEMS - buyers held.
    address internal _itemVault;
    uint32 internal _itemCount;
    uint16 internal _itemPolicies;
    uint256 internal _itemsBuyersHeld;
    ItemFundingV2[] internal _itemFunding;

    // V2.1 append-only: do not expand _p and shift old persistent slots.
    uint256 internal _eatPendingP;
    uint256 internal _eatenP;
    Rewards.State internal _rewards;
    uint256 internal _pilePendingP;
    uint256 internal _pileMovedP;
    uint256[2] internal _modulePending;
    uint256 private _sourceAllocatedP;
    // RC6 fee path: independent seller cursor. All pre-existing slots retain their offsets.
    uint256 internal _lastSellerBatch;
    // Complete optional PM redemption, including exact balances and the pile's native receive gate.
    uint256 internal constant PILE_MOVE_GAS = 2_800_000;
    uint256 internal constant PILE_MOVE_RESERVE_GAS = 200_000;
    // Complete cold PM unlock, including linked price-token history; measured in eat/Gas.t.sol.
    uint256 internal constant EAT_GAS = 2_800_000;
    // Retained gas for restoration or the first cumulative-total storage write and event on Amsterdam.
    uint256 internal constant EAT_RESERVE_GAS = 200_000;

    // Liquid receiver T needs one history mutation; hook redemption needs two (C.BURN_GAS).
    uint256 internal constant RECEIVER_BURN_GAS = 1_000_000;
    // FINAL-M02 / M2-60: >2x the cold complete ledger-token unlock on both EVMs,
    // including first-holder history and a half-allowance retry through nested calls.
    // Four parts cap the allowance at 10.8M per call.
    // The EIP-150 entry check and exact-receipt/rollback rules apply to the whole batch.
    uint256 internal constant PAYOUT_GAS = 2_700_000;
    // At most four burn/take pairs per creditor call, regardless of accumulated debt.
    uint256 internal constant MAX_PAYOUT_BATCH = 4 * MAX_PAYOUT_PART;
    bytes32 private constant LOCK = keccak256("squarehole.receiver.v2.lock");
    bytes32 private constant UNLOCK_ACTION = keccak256("squarehole.receiver.v2.unlock");

    constructor(
        IPoolManager pm,
        address coordinatorImplementation_,
        address fitSafe,
        address platformSafe,
        ReceiverCodeV21 memory code
    ) {
        if (
            address(pm) == address(0) || fitSafe == address(0) || platformSafe == address(0)
                || coordinatorImplementation_ == address(0)
        ) revert ZeroAddress();
        _pm = pm;
        _fitSafe = fitSafe;
        _platformSafe = platformSafe;
        coordinatorImplementation = coordinatorImplementation_;
        _implementation = address(this);
        require(code.views.code.length != 0 && code.callback.code.length != 0 && code.directory.code.length != 0, "ReceiverMissingCode");
        require(BoxReceiverV2Extension(code.callback).receiverImplementation() == address(this), "ReceiverWrongCallback");
        _views = ReceiverViews(code.views);
        _extension = code.callback;
        _moduleDirectory = FeeModuleDirectoryV21(code.directory);
        _eatModule = code.modules[0]; _eatHash = code.modules[0].codehash;
        _holdersTModule = code.modules[1]; _holdersTHash = code.modules[1].codehash;
        _itemsTModule = code.modules[2]; _itemsTHash = code.modules[2].codehash;
        _pileModule = code.modules[3]; _pileHash = code.modules[3].codehash;
        for (uint32 i; i < 4; ++i) {
            (address module, bytes32 hash,,) = _moduleDirectory.record(i);
            require(module == code.modules[i] && module.code.length != 0 && module.codehash == hash, "ReceiverWrongModule");
        }
        // The implementation can never initialize; each clone starts with its own zeroed storage.
        _initialized = true;
    }

    modifier locked() {
        _enter();
        _;
        bytes32 slot = LOCK;
        assembly ("memory-safe") { tstore(slot, 0) }
    }

    // Share the modifier prologue without changing the transient slot, refusal or reset on successful exit.
    function _enter() private {
        bytes32 slot = LOCK;
        uint256 entered;
        assembly ("memory-safe") { entered := tload(slot) }
        require(entered == 0, "ReceiverReentered");
        assembly ("memory-safe") { tstore(slot, 1) }
    }

    function _ready() internal view {
        require(_initialized, "ReceiverNotInitialized");
        if (_pm.isUnlocked()) revert ForeignUnlock();
    }

    function _prepare() internal {
        _ready();
        _reconcile();
        _graduateIfDue();
    }

    function _coordinator() internal view returns (IBoxCoordinatorV2) {
        return IBoxCoordinatorV2(A.addressAt(A.COORDINATOR));
    }

    /// @dev The coordinator's failed bit, read in one shared place; it is set before this receiver settles a failure.
    function _failed() internal view returns (bool) { return _coordinator().failed(); }

    function _priceCoin() internal view returns (address) {
        return A.addressAt(A.P);
    }

    function _claimBalance() internal view returns (uint256) {
        return _pm.balanceOf(address(this), uint160(_priceCoin()));
    }

    function _routeFailureBooks() internal { ReceiverBooksV21.routeFailure(_books(), _pm); }

    function _books() private pure returns (ReceiverBooksV21.State storage st) {
        assembly ("memory-safe") { st.slot := _p.slot }
    }

    function _bookedP() internal view returns (uint256) { return ReceiverBooksV21.bookedP(_books()); }

    /// @dev Preserve FIT/platform debt even in a deficit (C15.6); clip only the other ledgers to the balance
    /// left behind it. If claims cannot back that debt, unbooked stays zero until refilled; payouts fail safely.
    function _reconcile() internal { ReceiverBooksV21.reconcile(_books(), _pm); }

    function _unbooked() internal view returns (uint256) { return ReceiverBooksV21.unbooked(_books(), _pm); }

    /// @dev Exact voluntary intake uses the receiver's frozen error, including fee-on-transfer refusals.
    function _pullRoyalty(address asset, uint256 amount) internal { ReceiverBooksV21.pullRoyalty(asset, amount); }

    /// @dev Receiver entries alone harvest. Retain all three authenticated returns separately from gifts.
    /// Migration/close/deepen receipts remain readable on the hook even when its old counters reset.
    function _harvestFees() internal returns (uint256, uint256, uint256) { return ReceiverBooksV21.harvestFees(_books()); }

    /// @dev Checked funding seam retained for inheriting harnesses. Production validates the whole bounded
    /// source page once, then uses the same private recording/transfer below without repeating hook reads.
    /// No public funding entry: caller must hold the receiver lock and reconcile first. Never calls the ledger.
    /// All existing debts stay backed; zero closes irrevocably and later receipts cannot refill this batch.
    function _fundHolderBatch(uint256 id, uint256 netP) internal { ReceiverBooksV21.fundHolderBatch(_books(), _pm, id, netP); }

    /// @dev Allocator has already authenticated closure, ordered id and backing. Transfers claims only.


    function _moveClaims(address to, uint256 amount) internal {
        if (amount != 0) require(_pm.transfer(to, uint160(_priceCoin()), amount), "ClaimsTransferFailed");
    }

    function _release(uint256 ledger, address to) internal returns (uint256 amount) {
        amount = _p[ledger];
        _p[ledger] = 0;
        _moveClaims(to, amount);
    }

    function _hasSources() internal view returns (bool) { return ReceiverBooksV21.hasSources(_books()); }

    /// @dev Only receiver entries under the lock. At most two pairs: a lifecycle close plus this harvest.
    /// Receipts are actual claims minted by the immutable hook, post-D6. Retain later receipts' backing
    /// before clipping an earlier shortage; booked debt is never available. No external ledger call.
    function _allocateBatches(address tipTo, FeeBatchV2 memory result) internal returns (FeeBatchV2 memory) { return ReceiverBooksV21.allocateBatches(_books(), _pm, tipTo, result); }

    /// @dev Locked failed receiver entries only; the library keeps the transfer outside this runtime.
    function _toPot() internal returns (uint256) { return ReceiverBooksV21.toPot(_books(), _pm); }

    /// @dev M1 retains side carries. M2/M3 terminal dust exits to depth while live or the holder pot after failure.
    function _split(uint256 amount, bool sellers) internal { ReceiverBooksV21.split(_books(), _pm, amount, sellers); }

    function _bookRoyalty(uint256 amount) internal { ReceiverBooksV21.bookRoyalty(_books(), _pm, amount); }

    function _graduateIfDue() internal { ReceiverBooksV21.graduateIfDue(_books(), _pm); }

    /// @dev Locked allocator only. Failure stays in the held total and never creates an item credit.


    /// @dev Locked graduation/allocator only. Fixed-vault reads and a PM transfer; never calls ledger code.
    /// The receipt and count publish only with the actual transfer. Any refusal rolls back all bookkeeping.

    function _holderClosed(uint256 id) internal view returns (bool) {
        return ReceiverBooksV21.holderClosed(_books(), id);
    }
    function _holderPaid(uint256 id) internal view returns (uint256) {
        return ReceiverBooksV21.holderPaid(_books(), id);
    }

    function _burnRewardClaims() internal returns (uint256 amount) {
        return ReceiverRewardsV21.burn(_rewards, _pm);
    }

    function _checkStipend(uint256 stipend) internal view {
        require(gasleft() >= stipend + stipend / 63 + C.POKE_OVERHEAD_GAS, "ReceiverGasTooLow");
    }

    function _arm(uint256 action) private {
        bytes32 slot = UNLOCK_ACTION;
        assembly ("memory-safe") { tstore(slot, action) }
    }

    function _unlock(uint256 action, address asset, address to, uint256 amount) internal returns (bytes memory result) {
        _arm(action);
        result = _pm.unlock(abi.encode(action, asset, to, amount));
        _arm(0);
    }

    function _tryUnlock(uint256 action, address asset, address to, uint256 amount, uint256 stipend)
        internal
        returns (bool ok)
    {
        _checkStipend(stipend);
        _arm(action);
        try _pm.unlock{gas: stipend}(abi.encode(action, asset, to, amount)) {
            ok = true;
        } catch {}
        _arm(0);
    }

    function _tip(uint256 amount) internal view returns (uint256) {
        uint256 tip = FullMath.mulDiv(amount, C.TIP_BPS, C.BPS);
        uint256 cap = A.uintAt(A.TIP_MAX_Q, 16);
        return tip > cap ? cap : tip;
    }

    function _payTip(address to, uint256 amount) internal returns (uint256) {
        if (amount == 0 || to == address(0) || to == address(this) || to == address(_pm)) return 0;
        return _tryUnlock(TIP, _priceCoin(), to, amount, C.TIP_GAS) ? amount : 0;
    }

    function _payOwed(uint256 ledger, address safe) internal returns (uint256 amount) {
        amount = _payoutBatch(_p[ledger]);
        if (amount == 0) return 0;
        _p[ledger] -= amount;
        // Only this batch is atomic; later calls can redeem the unpaid balance. The
        // existing per-part stipend now has a fixed upper bound of four allowances.
        uint256 parts = (amount - 1) / MAX_PAYOUT_PART + 1;
        if (!_tryUnlock(PAY, _priceCoin(), safe, amount, PAYOUT_GAS * parts)) {
            _p[ledger] += amount;
            return 0;
        }
    }

    /// @dev Internal creditor selection; no external call or movement. Unselected debt stays booked.
    function _payoutBatch(uint256 owed) internal pure returns (uint256) {
        return owed > MAX_PAYOUT_BATCH ? MAX_PAYOUT_BATCH : owed;
    }

    function _burn() internal returns (uint256 amount) {
        amount = _burnPending;
        if (amount == 0) return 0;
        _burnPending = 0;
        if (!_tryUnlock(BURN, A.addressAt(A.T), address(0), amount, RECEIVER_BURN_GAS)) {
            _burnPending = amount;
            return 0;
        }
    }

    function _feeModule(uint8 choice) internal view returns (address module, bytes32 codeHash) {
        if (choice == 6) return (_eatModule, _eatHash);
        if (choice == 7) return (_holdersTModule, _holdersTHash);
        if (choice == 8) return (_itemsTModule, _itemsTHash);
        if (choice == 9) return (_pileModule, _pileHash);
    }

    /// @notice PoolManager only, during this receiver's armed unlock. Settles intake, payouts, a forward, a burn
    /// or its own-pool buy. A foreign unlock cannot select an action or spend a ledger.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(_pm), "ReceiverOnlyPoolManager");
        (uint256 action,,, uint256 amount) = abi.decode(data, (uint256, address, address, uint256));
        bytes32 slot = UNLOCK_ACTION;
        uint256 armed;
        assembly ("memory-safe") {
            armed := tload(slot)
            tstore(slot, 0)
        }
        require(action != 0 && action == armed, "ReceiverUnarmedUnlock");
        if (action == 12 || action == 13) {
            ReceiverModuleCallV21.execute(_pm, action, amount);
            return "";
        }
        address part = _extension;
        uint8 choice = action == EAT_PRICE ? 6 : action == MOVE_PILE ? 9 : action == BUY_REWARDS ? 7 : action == BUY_ITEMS_REWARDS ? 8 : 0;
        if (choice != 0) {
            bytes32 hash;
            (part, hash) = _feeModule(choice);
            if (part.codehash != hash) revert InvalidChoice();
        }
        assembly ("memory-safe") {
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), part, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            if iszero(ok) { revert(0, returndatasize()) }
            return(0, returndatasize())
        }
    }
}
